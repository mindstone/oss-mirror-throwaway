/**
 * Managed MCP Auto-Upgrade
 *
 * Scans the MCP router config and upgrades `npx`-shaped rebel-oss entries to
 * their managed-install equivalent (`command: 'node'` + absolute path to the
 * installed entry file under `<userData>/mcp/managed-installs/`).
 *
 * Runs in the background at startup, after `migrateBundledConnectorsToNpx`.
 *
 * Safety guarantees:
 * - Non-blocking: failures never prevent app startup.
 * - Graceful fallback: if a managed install fails, the entry stays on npx. The
 *   connector still works via the existing runtime, just slower.
 * - Path-based gate: reconciliation is idempotent — managed entries that are
 *   already valid are skipped; managed entries whose entry file went missing
 *   (AV quarantine, manual delete) get reinstalled.
 * - Identity preservation: `catalogId`, `email`, `description`,
 *   `lastConnectedAt`, `workspace`, and user-resolved `env` all carry over.
 * - Uses `upsertMcpServerEntry` (wraps `withConfigMutation` + backup) so the
 *   rewrite is atomic and recoverable.
 *
 * See `docs/plans/260416_managed_mcp_install_replace_npx.md` §Stage 2.
 */

import fs from 'node:fs/promises';
import { createScopedLogger } from '@core/logger';
import {
  readMcpServerDetails,
  upsertMcpServerEntry,
} from '@core/services/mcpConfigManager';
import type { McpServerUpsertPayload } from '@shared/ipc/schemas/mcp';
import path from 'node:path';
import { resolveConnectorCatalogPath } from './bundledMcpManager';
import {
  DEV_PRE_PUBLISH_SENTINEL_FILENAME,
  InstallPathTooLongError,
  isManagedInstallEntry,
  type DevPrePublishSentinel,
} from './managedMcpInstallService';
import { getManagedInstallsRoot, getManagedMcpInstallService } from './managedMcpInstallServiceInstance';

const log = createScopedLogger({ service: 'managedMcpAutoUpgrade' });

const toMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  return String(error);
};

/**
 * FOX-3319 Stage 9 telemetry: track entries whose existing on-disk pinning
 * is on the legacy `@mindstone-engineering/` scope so adoption of the new
 * `@mindstone/` scope can be measured during the soak window before the
 * legacy packages are deprecated. See
 * `docs/plans/260511_npm_scope_migration_mindstone.md` § Stage 9.
 */
const LEGACY_SCOPE_PREFIX = '@mindstone-engineering/';
const NEW_SCOPE_PREFIX = '@mindstone/';

/**
 * Detect whether an existing config entry is pinned to the legacy scope.
 * Looks at the entry's args, covering both npx pin form (the arg string
 * itself starts with the legacy scope) and managed-install path form (an
 * absolute path containing `/@mindstone-engineering/mcp-server-<name>/`).
 * Returns the bare legacy package name (no version) if detected, else null.
 */
const extractLegacyScopePackageName = (entry: Record<string, unknown>): string | null => {
  if (!Array.isArray(entry.args)) return null;
  for (const arg of entry.args) {
    if (typeof arg !== 'string') continue;
    if (arg.startsWith(LEGACY_SCOPE_PREFIX)) {
      const versionAt = arg.indexOf('@', 1);
      return versionAt === -1 ? arg : arg.slice(0, versionAt);
    }
    const pathMatch = arg.match(/[\\/]@mindstone-engineering[\\/](mcp-server-[^\\/]+)/);
    if (pathMatch) return `${LEGACY_SCOPE_PREFIX}${pathMatch[1]}`;
  }
  return null;
};

export interface UpgradeResult {
  upgraded: Array<{ catalogId: string; serverName: string; packageSpec: string }>;
  reinstalled: Array<{ catalogId: string; serverName: string; packageSpec: string; reason: string }>;
  skipped: Array<{ catalogId: string | null; serverName: string; reason: string }>;
  failed: Array<{ catalogId: string | null; serverName: string; error: string }>;
  /**
   * Entries the service refused to keep reinstalling because they tripped the
   * reinstall-loop threshold (AV quarantine ping-pong, etc.) and were reverted
   * to their catalog npx form as a safe fallback.
   */
  quarantined: Array<{
    catalogId: string;
    serverName: string;
    packageSpec: string;
    reinstallCount: number;
  }>;
  /**
   * FOX-3319 Stage 9 telemetry: entries whose existing on-disk pinning was
   * on the legacy `@mindstone-engineering/` scope and got rewritten to a
   * new `@mindstone/` managed install during this pass. Used to monitor
   * adoption during the soak window before the legacy scope is deprecated.
   * Overlaps with `upgraded` / `reinstalled` (the same entry can appear in
   * both) — this list is a scope-migration view, not a separate action.
   */
  scopeMigrations: Array<{
    catalogId: string;
    serverName: string;
    fromPackageName: string;
    toPackageSpec: string;
  }>;
}

interface CatalogEntry {
  id: string;
  name: string;
  provider: string;
  bundledConfig?: { serverName?: string };
  mcpConfig?: {
    transport?: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
  };
}

const readCatalog = async (): Promise<CatalogEntry[]> => {
  const raw = await fs.readFile(resolveConnectorCatalogPath(), 'utf8');
  const parsed = JSON.parse(raw) as { connectors?: CatalogEntry[] };
  return parsed?.connectors ?? [];
};

/**
 * Extract a pinned package spec (name@version) from a catalog entry's npx args.
 * Returns null if the catalog entry is not npx-shaped or the spec is not pinned.
 */
const extractPinnedPackageSpec = (catalogEntry: CatalogEntry): string | null => {
  const cfg = catalogEntry.mcpConfig;
  if (!cfg || cfg.command !== 'npx' || !Array.isArray(cfg.args)) return null;

  // npx args look like ["-y", "<package@version>", ...] or ["--yes", ...]
  const yesIndex = cfg.args.findIndex((a) => a === '-y' || a === '--yes');
  if (yesIndex === -1 || yesIndex + 1 >= cfg.args.length) return null;

  const spec = cfg.args[yesIndex + 1];
  if (typeof spec !== 'string' || !spec) return null;

  // Require pinned version: "@scope/name@x.y.z" → find the last @ beyond position 0
  const lastAt = spec.startsWith('@') ? spec.indexOf('@', 1) : spec.indexOf('@');
  if (lastAt === -1 || lastAt + 1 >= spec.length) return null;

  return spec;
};

/**
 * Build the managed-install replacement payload for a rebel-oss entry.
 *
 * Preserves all identity + user-resolved env from the existing entry. Swaps
 * only `command`/`args` to point at the managed install's entry file.
 *
 * Note: `prepareServerPayload` in `mcpConfigManager.ts` preserves
 * `lastConnectedAt` via duck typing even though the Zod schema for
 * `McpServerUpsertPayload` doesn't formally declare it. We pass it through
 * here (cast to `unknown` then to payload) so identity is preserved across
 * the rewrite.
 */
const buildManagedPayload = (
  serverName: string,
  existingDetails: Awaited<ReturnType<typeof readMcpServerDetails>>,
  catalogEntry: CatalogEntry,
  entryPath: string,
): McpServerUpsertPayload => {
  const payload: Record<string, unknown> = {
    name: serverName,
    transport: catalogEntry.mcpConfig?.transport ?? 'stdio',
    command: 'node',
    args: [entryPath],
    // Preserve user-resolved env from the existing entry. The catalog env uses
    // placeholder tokens; the existing entry already has them resolved for this
    // user's filesystem, which is what we want.
    env: existingDetails.env,
    description: existingDetails.description,
    catalogId: catalogEntry.id,
    email: existingDetails.email,
    workspace: existingDetails.workspace,
    headers: existingDetails.headers,
  };
  if (typeof existingDetails.lastConnectedAt === 'number') {
    payload.lastConnectedAt = existingDetails.lastConnectedAt;
  }
  return payload as McpServerUpsertPayload;
};

/**
 * Build an npx-shaped payload that reverts a broken managed entry back to
 * the catalog's canonical form. Used when `reinstall-invalid-managed` itself
 * fails so the user is left with a working (slow) connector instead of a
 * permanently-broken managed-path entry.
 */
const buildNpxRevertPayload = (
  serverName: string,
  existingDetails: Awaited<ReturnType<typeof readMcpServerDetails>>,
  catalogEntry: CatalogEntry,
): McpServerUpsertPayload | null => {
  const cfg = catalogEntry.mcpConfig;
  if (!cfg || cfg.command !== 'npx' || !Array.isArray(cfg.args)) return null;

  const payload: Record<string, unknown> = {
    name: serverName,
    transport: cfg.transport ?? 'stdio',
    command: cfg.command,
    args: [...cfg.args],
    // Preserve user-resolved env so credentials/paths survive the revert.
    env: existingDetails.env,
    description: existingDetails.description,
    catalogId: catalogEntry.id,
    email: existingDetails.email,
    workspace: existingDetails.workspace,
    headers: existingDetails.headers,
  };
  if (typeof existingDetails.lastConnectedAt === 'number') {
    payload.lastConnectedAt = existingDetails.lastConnectedAt;
  }
  return payload as McpServerUpsertPayload;
};

/**
 * Result of {@link scanForDevPrePublishSentinels}. One entry per slot with
 * an active `.dev-pre-publish-build.json` marker.
 */
export interface DevPrePublishSentinelHit {
  packageSpec: string;
  installRoot: string;
  installedAt: string;
  tarballPath: string;
  ageMs: number;
}

/**
 * Scan the managed-installs root for `.dev-pre-publish-build.json` sentinels
 * left by `scripts/dev-mcp-managed-install.ts` and log a WARN banner per slot.
 *
 * Mitigates the silent-drift failure mode: after a pre-publish smoke test, if
 * the engineer forgets to run `uninstall`, the slot still has the locally
 * built tarball with valid `.install-meta.json`. Auto-upgrade sees the
 * metadata as valid and the engineer keeps shipping fixes against a phantom
 * repro for hours/days. The banner makes this loud at every startup.
 *
 * Non-throwing: failures are logged and swallowed so a busted sentinel never
 * blocks startup.
 *
 * @returns the list of sentinels found (for testing / observability).
 */
export const scanForDevPrePublishSentinels = async (): Promise<DevPrePublishSentinelHit[]> => {
  const managedInstallsRoot = getManagedInstallsRoot();
  if (!managedInstallsRoot) return [];

  const hits: DevPrePublishSentinelHit[] = [];
  const now = Date.now();

  // Top-level entries are `<scope>` directories (for scoped packages) or
  // `<packageSpec>` slot dirs (for unscoped). Scoped packages are nested
  // one level deeper as `<scope>/<name>@<version>/`.
  const visitSlot = async (slotPath: string, packageSpec: string): Promise<void> => {
    const sentinelPath = path.join(slotPath, DEV_PRE_PUBLISH_SENTINEL_FILENAME);
    let raw: string;
    try {
      raw = await fs.readFile(sentinelPath, 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        log.warn(
          { err, sentinelPath },
          'Failed to read dev-pre-publish sentinel (continuing)',
        );
      }
      return;
    }
    let parsed: DevPrePublishSentinel;
    try {
      parsed = JSON.parse(raw) as DevPrePublishSentinel;
    } catch (err) {
      log.warn({ err, sentinelPath }, 'Dev-pre-publish sentinel is malformed JSON');
      return;
    }
    const installedAtMs = Date.parse(parsed.installedAt);
    const ageMs = Number.isFinite(installedAtMs) ? now - installedAtMs : 0;
    hits.push({
      packageSpec,
      installRoot: slotPath,
      installedAt: parsed.installedAt,
      tarballPath: parsed.tarballPath,
      ageMs,
    });
  };

  let topLevel: import('node:fs').Dirent[];
  try {
    topLevel = await fs.readdir(managedInstallsRoot, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      log.warn({ err, managedInstallsRoot }, 'Failed to scan managed-installs root for dev sentinels');
    }
    return hits;
  }

  for (const entry of topLevel) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;

    if (entry.name.startsWith('@')) {
      const scopeDir = path.join(managedInstallsRoot, entry.name);
      let scoped: import('node:fs').Dirent[];
      try {
        scoped = await fs.readdir(scopeDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const slot of scoped) {
        if (!slot.isDirectory() || slot.name.startsWith('.')) continue;
        const packageSpec = `${entry.name}/${slot.name}`;
        await visitSlot(path.join(scopeDir, slot.name), packageSpec);
      }
    } else {
      await visitSlot(path.join(managedInstallsRoot, entry.name), entry.name);
    }
  }

  for (const hit of hits) {
    const ageHours = Math.round(hit.ageMs / 3_600_000);
    log.warn(
      {
        packageSpec: hit.packageSpec,
        installRoot: hit.installRoot,
        installedAt: hit.installedAt,
        tarballPath: hit.tarballPath,
        ageMs: hit.ageMs,
      },
      `Dev pre-publish build active for ${hit.packageSpec} (installed ${ageHours}h ago from ${hit.tarballPath}). This slot is NOT the published npm package — run \`npx tsx scripts/dev-mcp-managed-install.ts uninstall <connector>\` before relying on it for production debugging.`,
    );
  }

  return hits;
};

/**
 * Upgrade all npx-shaped rebel-oss entries in `configPath` to managed installs.
 *
 * Also reinstalls any existing managed entries whose on-disk state is invalid
 * (e.g., entry file missing from AV quarantine or manual cleanup).
 *
 * Returns a structured summary. Does not throw; failures are collected in
 * `result.failed` so the caller can log without derailing startup.
 */
export const upgradeRebelOssEntriesToManaged = async (
  configPath: string,
): Promise<UpgradeResult> => {
  const result: UpgradeResult = {
    upgraded: [],
    reinstalled: [],
    skipped: [],
    failed: [],
    quarantined: [],
    scopeMigrations: [],
  };

  /**
   * Revert a server entry to its catalog npx form. Returns true if the rewrite
   * actually happened. Used when (a) reinstall-invalid-managed fails and the
   * entry is pointing at a dead managed path, (b) the reinstall loop is
   * quarantined, or (c) the install blows the Windows MAX_PATH budget.
   */
  const revertToNpx = async (
    serverName: string,
    catalogId: string,
    catalogEntry: CatalogEntry,
  ): Promise<boolean> => {
    try {
      const existing = await readMcpServerDetails(configPath, serverName);
      if (existing.catalogId !== catalogId) return false;
      const payload = buildNpxRevertPayload(serverName, existing, catalogEntry);
      if (!payload) return false;
      await upsertMcpServerEntry(configPath, payload);
      return true;
    } catch (revertError) {
      log.error(
        { catalogId, serverName, err: revertError },
        'Failed to revert managed entry back to npx form',
      );
      return false;
    }
  };

  const managedService = getManagedMcpInstallService();
  const managedInstallsRoot = getManagedInstallsRoot();

  if (!managedService || !managedInstallsRoot) {
    result.skipped.push({
      catalogId: null,
      serverName: '(all)',
      reason: 'managed-install-service-not-configured',
    });
    return result;
  }

  let catalog: CatalogEntry[];
  try {
    catalog = await readCatalog();
  } catch (error) {
    log.warn({ err: error }, 'Auto-upgrade skipped: failed to read connector catalog');
    result.skipped.push({
      catalogId: null,
      serverName: '(all)',
      reason: 'catalog-read-failed',
    });
    return result;
  }

  // Build a catalogId → entry lookup for rebel-oss connectors with pinned npx specs.
  const rebelOssByCatalogId = new Map<string, { entry: CatalogEntry; packageSpec: string }>();
  for (const entry of catalog) {
    if (entry.provider !== 'rebel-oss') continue;
    const spec = extractPinnedPackageSpec(entry);
    if (!spec) continue;
    rebelOssByCatalogId.set(entry.id, { entry, packageSpec: spec });
  }

  if (rebelOssByCatalogId.size === 0) {
    return result;
  }

  // Read the config to enumerate candidate entries. We use raw JSON here (not
  // readMcpServerDetails) because we want a full view of the mcpServers map in
  // one pass; individual writes go through upsertMcpServerEntry which locks.
  let configRaw: string;
  try {
    configRaw = await fs.readFile(configPath, 'utf8');
  } catch (error) {
    log.debug({ err: error, configPath }, 'Auto-upgrade: config not readable, skipping');
    return result;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(configRaw) as Record<string, unknown>;
  } catch (error) {
    log.warn({ err: error, configPath }, 'Auto-upgrade: config parse failed, skipping');
    return result;
  }

  const servers = parsed.mcpServers;
  if (!servers || typeof servers !== 'object') return result;

  // Snapshot candidates first so we're not iterating a live map while
  // upsertMcpServerEntry mutates the backing file.
  const candidates: Array<{
    serverName: string;
    entry: Record<string, unknown>;
    mode: 'upgrade-from-npx' | 'reinstall-invalid-managed';
    catalogId: string;
    packageSpec: string;
    legacyScopePackageName: string | null;
  }> = [];

  for (const [serverName, rawEntry] of Object.entries(servers as Record<string, unknown>)) {
    if (!rawEntry || typeof rawEntry !== 'object') continue;
    const entry = rawEntry as Record<string, unknown>;

    const catalogId = typeof entry.catalogId === 'string' ? entry.catalogId : null;
    if (!catalogId) continue;

    const catalogForm = rebelOssByCatalogId.get(catalogId);
    if (!catalogForm) continue;

    const { packageSpec } = catalogForm;
    const legacyScopePackageName = extractLegacyScopePackageName(entry);
    if (legacyScopePackageName && packageSpec.startsWith(NEW_SCOPE_PREFIX)) {
      log.info(
        {
          catalogId,
          serverName,
          fromPackageName: legacyScopePackageName,
          toPackageSpec: packageSpec,
          stage: 'FOX-3319',
        },
        'FOX-3319 legacy-scope entry detected; scope migration pending this pass',
      );
    }

    if (entry.command === 'npx') {
      candidates.push({
        serverName,
        entry,
        mode: 'upgrade-from-npx',
        catalogId,
        packageSpec,
        legacyScopePackageName,
      });
      continue;
    }

    if (isManagedInstallEntry(entry, managedInstallsRoot)) {
      // Verify the on-disk state is still valid. If not, reinstall.
      const metadata = await managedService.getMetadata(packageSpec);
      if (!metadata) {
        candidates.push({
          serverName,
          entry,
          mode: 'reinstall-invalid-managed',
          catalogId,
          packageSpec,
          legacyScopePackageName,
        });
      }
      // else: already valid, nothing to do.
      continue;
    }

    // Other shapes (legacy bundled node paths) are handled by
    // migrateBundledConnectorsToNpx, not by this service.
  }

  if (candidates.length === 0) return result;

  log.info(
    { candidateCount: candidates.length, configPath },
    'Managed MCP auto-upgrade running',
  );

  for (const candidate of candidates) {
    const { serverName, mode, catalogId, packageSpec } = candidate;
    const catalogForm = rebelOssByCatalogId.get(catalogId);
    if (!catalogForm) continue;

    try {
      // Quarantine gate: if a prior reinstall loop tripped the threshold, do
      // not attempt another install. Revert to npx so the user gets a working
      // (slow) connector and log for observability.
      if (mode === 'reinstall-invalid-managed') {
        const history = await managedService.getReinstallHistory(packageSpec);
        if (history?.quarantined) {
          const reverted = await revertToNpx(serverName, catalogId, catalogForm.entry);
          log.warn(
            { catalogId, serverName, packageSpec, reinstallCount: history.reinstallCount, reverted },
            'Skipping reinstall: spec is quarantined after repeated failures; using npx fallback',
          );
          result.quarantined.push({
            catalogId,
            serverName,
            packageSpec,
            reinstallCount: history.reinstallCount,
          });
          continue;
        }
        // About to force-install a previously-invalid managed entry. Record
        // the attempt so we can detect ping-pong on subsequent startups.
        await managedService.recordReinstallAttempt(packageSpec);
      }

      // Idempotent install: returns existing metadata if already installed
      // and valid, otherwise performs a real install.
      const metadata = await managedService.install({
        packageSpec,
        force: mode === 'reinstall-invalid-managed',
      });

      // Success: clear any prior reinstall history so a future transient
      // invalidation gets a full fresh quarantine budget.
      if (mode === 'reinstall-invalid-managed') {
        await managedService.clearReinstallHistory(packageSpec);
      }

      // Re-read the latest details from disk right before rewriting so we
      // preserve any fields that were updated concurrently (e.g.,
      // lastConnectedAt from an intervening connection attempt).
      let existing;
      try {
        existing = await readMcpServerDetails(configPath, serverName);
      } catch (readError) {
        result.skipped.push({
          catalogId,
          serverName,
          reason: `config-entry-missing: ${toMessage(readError)}`,
        });
        continue;
      }

      // Make sure the entry on disk still matches our snapshot by catalogId;
      // if the user reconnected to a different connector under this name
      // while we were installing, skip to avoid stomping.
      if (existing.catalogId !== catalogId) {
        result.skipped.push({
          catalogId,
          serverName,
          reason: `catalogId-drift:${String(existing.catalogId ?? 'none')}`,
        });
        continue;
      }

      const payload = buildManagedPayload(
        serverName,
        existing,
        catalogForm.entry,
        metadata.entryPath,
      );

      await upsertMcpServerEntry(configPath, payload);

      const bucket = mode === 'upgrade-from-npx' ? result.upgraded : result.reinstalled;
      bucket.push({
        catalogId,
        serverName,
        packageSpec,
        ...(mode === 'reinstall-invalid-managed' ? { reason: 'invalid-managed-state' } : {}),
      } as UpgradeResult['reinstalled'][number]);

      if (candidate.legacyScopePackageName && packageSpec.startsWith(NEW_SCOPE_PREFIX)) {
        result.scopeMigrations.push({
          catalogId,
          serverName,
          fromPackageName: candidate.legacyScopePackageName,
          toPackageSpec: packageSpec,
        });
        log.info(
          {
            catalogId,
            serverName,
            fromPackageName: candidate.legacyScopePackageName,
            toPackageSpec: packageSpec,
            stage: 'FOX-3319',
          },
          'FOX-3319 scope migration applied: rewrote legacy @mindstone-engineering/ entry to @mindstone/',
        );
      }

      log.info(
        {
          catalogId,
          serverName,
          packageSpec,
          entryPath: metadata.entryPath,
          mode,
        },
        'Managed MCP auto-upgrade applied',
      );
    } catch (error) {
      const message = toMessage(error);

      // Path-too-long on Windows: revert to npx for BOTH modes. For
      // upgrade-from-npx the entry was already npx so this is a no-op rewrite;
      // for reinstall-invalid-managed, reverting restores a working connector.
      if (error instanceof InstallPathTooLongError) {
        const reverted = await revertToNpx(serverName, catalogId, catalogForm.entry);
        log.warn(
          { catalogId, serverName, packageSpec, reverted, err: error },
          'Managed install path exceeds Windows MAX_PATH budget; using npx instead',
        );
        result.failed.push({
          catalogId,
          serverName,
          error: reverted ? `${message} (reverted to npx)` : message,
        });
        continue;
      }

      // Reinstall-invalid-managed failure: entry currently points at a dead
      // managed path, connector is broken. Revert to catalog npx form so the
      // user has a working (slower) connector instead of a permanently-broken
      // one. Upgrade-from-npx failures are benign: npx stays intact.
      if (mode === 'reinstall-invalid-managed') {
        const reverted = await revertToNpx(serverName, catalogId, catalogForm.entry);
        if (reverted) {
          log.warn(
            { catalogId, serverName, packageSpec, err: error },
            'Reinstall of invalid managed entry failed; reverted to npx fallback',
          );
          result.failed.push({
            catalogId,
            serverName,
            error: `${message} (reverted to npx)`,
          });
          continue;
        }
        log.error(
          { catalogId, serverName, packageSpec, err: error },
          'Reinstall failed AND npx revert failed; managed entry remains broken',
        );
      }

      log.warn(
        { catalogId, serverName, packageSpec, err: error },
        'Managed MCP auto-upgrade failed; leaving existing entry intact',
      );
      result.failed.push({ catalogId, serverName, error: message });
    }
  }

  log.info(
    {
      upgradedCount: result.upgraded.length,
      reinstalledCount: result.reinstalled.length,
      skippedCount: result.skipped.length,
      failedCount: result.failed.length,
      quarantinedCount: result.quarantined.length,
      scopeMigrationCount: result.scopeMigrations.length,
    },
    'Managed MCP auto-upgrade completed',
  );

  return result;
};
