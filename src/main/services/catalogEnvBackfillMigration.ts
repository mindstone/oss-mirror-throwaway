import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { writeFile } from 'atomically';
import { createScopedLogger } from '@core/logger';
import { atomicCredentialWrite } from '@core/utils/atomicCredentialWrite';
import {
  lookupCatalogEntry,
  resolveConnectorCatalogPath,
  resolveEnvPlaceholders,
  resolveSandboxAncestor,
  type SandboxAncestorResolution,
} from './bundledMcpManager';
import {
  DEFAULT_ONLY_SANDBOX_ENV_KEYS,
  DEFAULT_ONLY_SANDBOX_ENV_PAIRED_KEYS,
  DEFAULT_ONLY_SANDBOX_ENV_PRIMARY_KEY,
} from './mcpSandboxEnvKeys';

const log = createScopedLogger({ service: 'catalogEnvBackfillMigration' });

export interface CatalogEnvBackfillRepair {
  serverName: string;
  catalogId: string;
  addedEnvKeys: string[];
  addedHeaderKeys: string[];
  /**
   * Subset of `addedEnvKeys` that came from the default-only sandbox env
   * pass (e.g. `RUNWAY_ALLOWED_ROOT`). Resolved from catalog placeholders
   * via the same machinery as the spawn path. Only present when at least
   * one such key was injected.
   */
  addedSandboxEnvKeys?: string[];
  /**
   * dcaStatus from {@link resolveSandboxAncestor} captured for the run that
   * injected sandbox env keys on this entry. Only present when sandbox keys
   * were added; gives operators the same observability the desktop-build
   * surface gets via `mcp.spawn.trusted-roots-resolved`.
   */
  sandboxResolutionStatus?: SandboxAncestorResolution['dcaStatus'];
  /**
   * fallbackReason from {@link resolveSandboxAncestor}, when the resolution
   * fell back (empty trust roots, root-collapse, helper-threw). Mirrors the
   * structured field emitted on the desktop-build surface.
   */
  sandboxResolutionFallbackReason?: string;
  /**
   * Subset of default-only sandbox env keys that were stripped from the
   * existing entry because their concrete values were unreachable on this
   * surface (`realpathSync.native` threw). The same keys are then re-added
   * by the default-only sandbox env pass via `addedSandboxEnvKeys`. Only
   * present when {@link BackfillCatalogEnvOptions.scrubStaleDefaultOnlyEnvKeys}
   * is enabled and at least one stale value was detected.
   */
  scrubbedSandboxEnvKeys?: string[];
}

export interface CatalogEnvBackfillResult {
  repaired: CatalogEnvBackfillRepair[];
  skipped: number;
  errored: number;
}

export interface BackfillCatalogEnvOptions {
  /**
   * Detect-and-scrub stale concrete values for keys in
   * {@link DEFAULT_ONLY_SANDBOX_ENV_KEYS} before the default-only sandbox
   * env pass runs. A value is "stale" iff it is non-blank, non-placeholder,
   * AND `realpathSync.native(value)` throws — typically a desktop path
   * (`/Users/...`) baked in by an earlier desktop→cloud migration that no
   * longer exists on the cloud machine. After scrubbing, the existing
   * default-only sandbox env pass re-adds the keys with surface-coherent
   * resolved values (cloud's `dataPath`-rooted DCA, in practice).
   *
   * Off by default. Desktop callers leave it off so legitimate user
   * overrides for paths that simply don't exist yet (e.g. typos) aren't
   * silently rewritten. Cloud callers turn it on at boot to repair
   * already-migrated configs that still carry desktop paths
   * (`docs/plans/260520_runway_sandbox_central_trusted_roots.md` § SF-7).
   */
  scrubStaleDefaultOnlyEnvKeys?: boolean;
}

type CatalogStaticConfigEntry = Record<string, unknown> & {
  mcpConfig?: {
    env?: unknown;
    headers?: unknown;
  };
};

type RouterConfig = Record<string, unknown> & {
  mcpServers?: unknown;
};

const filterPlaceholderFreeStringRecord = (value: unknown): Record<string, string> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const filtered: Record<string, string> = {};
  for (const [key, entryValue] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entryValue === 'string' && !entryValue.includes('{{')) {
      filtered[key] = entryValue;
    }
  }
  return filtered;
};

const filterSandboxPlaceholderEnv = (value: unknown): Record<string, string> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const filtered: Record<string, string> = {};
  for (const [key, entryValue] of Object.entries(value as Record<string, unknown>)) {
    if (
      DEFAULT_ONLY_SANDBOX_ENV_KEYS.has(key) &&
      typeof entryValue === 'string' &&
      entryValue.includes('{{')
    ) {
      filtered[key] = entryValue;
    }
  }
  return filtered;
};

const readJson = async (filePath: string): Promise<unknown> => {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    log.warn({ err, filePath }, 'Failed to read MCP config for catalog static env backfill');
    return null;
  }
};

const loadConnectorCatalog = async (): Promise<CatalogStaticConfigEntry[]> => {
  const catalogPath = resolveConnectorCatalogPath();
  const raw = await fs.readFile(catalogPath, 'utf8');
  const parsed = JSON.parse(raw) as { connectors?: unknown };
  return Array.isArray(parsed.connectors)
    ? parsed.connectors as CatalogStaticConfigEntry[]
    : [];
};

const writeJsonWithBackup = async (configPath: string, data: unknown): Promise<string | null> => {
  const backupPath = `${configPath}.${Date.now()}.bak`;
  try {
    await fs.copyFile(configPath, backupPath);
    if (process.platform !== 'win32') {
      await fs.chmod(backupPath, 0o600);
    }
  } catch (err) {
    log.warn({ err, configPath, backupPath }, 'Failed to create MCP config backup before catalog static env backfill');
    throw err;
  }

  await fs.mkdir(path.dirname(configPath), { recursive: true });
  if (path.basename(configPath) === 'super-mcp-router.json') {
    await atomicCredentialWrite(configPath, JSON.stringify(data, null, 2), { mode: 0o600 });
    return backupPath;
  }
  await writeFile(configPath, JSON.stringify(data, null, 2), 'utf8');
  return backupPath;
};

const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
};

const isExistingValid = (rec: Record<string, unknown> | null, key: string): boolean => {
  if (!rec) return false;
  if (!Object.prototype.hasOwnProperty.call(rec, key)) return false;
  return typeof rec[key] === 'string';
};

const mergeMissingStaticKeys = (
  entry: Record<string, unknown>,
  field: 'env' | 'headers',
  catalogValues: Record<string, string>,
): string[] => {
  const addedKeys: string[] = [];
  const existingRecord = asRecord(entry[field]);

  for (const key of Object.keys(catalogValues)) {
    if (!isExistingValid(existingRecord, key)) {
      addedKeys.push(key);
    }
  }

  if (addedKeys.length === 0) {
    return addedKeys;
  }

  entry[field] = { ...(existingRecord ?? {}) };
  for (const key of addedKeys) {
    (entry[field] as Record<string, unknown>)[key] = catalogValues[key];
  }
  return addedKeys;
};

/**
 * Detect default-only sandbox env values that don't realpath on this surface.
 *
 * Uses paired-key semantics: only the primary key
 * ({@link DEFAULT_ONLY_SANDBOX_ENV_PRIMARY_KEY}) gets a realpath probe.
 * "Stale" iff the primary value is a non-blank, non-placeholder string AND
 * `realpathSync.native` throws (any error code: ENOENT, EACCES, ENOTDIR,
 * etc.). When the primary is stale, paired keys
 * ({@link DEFAULT_ONLY_SANDBOX_ENV_PAIRED_KEYS}) are scrubbed alongside so
 * the default-only sandbox env pass re-resolves the whole set coherently.
 *
 * The bug pattern this catches: a desktop→cloud migration that ran before
 * SF-7 baked `/Users/<desktop_user>/...` into a Linux cloud config.
 *
 * Why paired keys aren't probed independently: paired values like
 * `RUNWAY_DOWNLOAD_ROOT = <ancestor>/runway-mcp` reference subdirectories
 * the runtime creates lazily on first use. Probing them with realpath
 * would mark the freshly-resolved value as stale on the next boot,
 * triggering a scrub→re-add loop forever.
 *
 * Caller is expected to delete the returned keys from `entry.env` so the
 * subsequent default-only sandbox env pass re-injects them with
 * surface-coherent resolved paths.
 */
const detectStaleSandboxEnvKeys = (
  entryEnv: Record<string, unknown> | null,
): string[] => {
  if (!entryEnv) return [];
  const primaryValue = entryEnv[DEFAULT_ONLY_SANDBOX_ENV_PRIMARY_KEY];
  if (typeof primaryValue !== 'string') return [];
  const trimmedPrimary = primaryValue.trim();
  if (trimmedPrimary.length === 0) return [];
  if (trimmedPrimary.includes('{{')) return [];
  try {
    fsSync.realpathSync.native(trimmedPrimary);
    return [];
  } catch {
    // Primary is stale; fall through to scrub primary + concrete paired keys.
  }
  const stale: string[] = [DEFAULT_ONLY_SANDBOX_ENV_PRIMARY_KEY];
  for (const key of DEFAULT_ONLY_SANDBOX_ENV_PAIRED_KEYS) {
    const value = entryEnv[key];
    if (typeof value !== 'string') continue;
    const trimmedPaired = value.trim();
    if (trimmedPaired.length === 0) continue;
    if (trimmedPaired.includes('{{')) continue;
    stale.push(key);
  }
  return stale;
};

export const backfillCatalogEnvForExistingServers = async (
  configPath: string,
  options: BackfillCatalogEnvOptions = {},
): Promise<CatalogEnvBackfillResult> => {
  const result: CatalogEnvBackfillResult = { repaired: [], skipped: 0, errored: 0 };

  const parsed = await readJson(configPath);
  if (!parsed || typeof parsed !== 'object') {
    return result;
  }

  const config = parsed as RouterConfig;
  const servers = asRecord(config.mcpServers);
  if (!servers) {
    return result;
  }

  let catalog: CatalogStaticConfigEntry[];
  try {
    catalog = await loadConnectorCatalog();
  } catch (err) {
    log.warn({ err }, 'Failed to load connector catalog for catalog static env backfill');
    result.errored += 1;
    return result;
  }

  let changed = false;
  let cachedSandboxResolution: SandboxAncestorResolution | null = null;
  const getSandboxResolution = (): SandboxAncestorResolution => {
    if (!cachedSandboxResolution) {
      cachedSandboxResolution = resolveSandboxAncestor();
    }
    return cachedSandboxResolution;
  };

  for (const [serverName, serverRaw] of Object.entries(servers)) {
    const server = asRecord(serverRaw);
    if (!server) {
      result.skipped += 1;
      continue;
    }

    try {
      const catalogId = server.catalogId;
      if (typeof catalogId !== 'string' || catalogId.length === 0) {
        result.skipped += 1;
        continue;
      }

      const catalogEntry = lookupCatalogEntry(catalogId, catalog) as CatalogStaticConfigEntry | undefined;
      if (!catalogEntry) {
        log.warn({ serverName, catalogId }, 'Catalog entry missing during catalog static env backfill');
        result.skipped += 1;
        continue;
      }

      const catalogEnv = filterPlaceholderFreeStringRecord(catalogEntry.mcpConfig?.env);
      const catalogHeaders = filterPlaceholderFreeStringRecord(catalogEntry.mcpConfig?.headers);
      const addedStaticEnvKeys = mergeMissingStaticKeys(server, 'env', catalogEnv);
      const addedHeaderKeys = mergeMissingStaticKeys(server, 'headers', catalogHeaders);

      // Pre-pass (cloud only): scrub stale default-only sandbox env values
      // so the default-only sandbox pass below re-injects them with
      // surface-coherent resolved paths. See `scrubStaleDefaultOnlyEnvKeys`
      // on {@link BackfillCatalogEnvOptions}.
      let scrubbedSandboxEnvKeys: string[] = [];
      if (options.scrubStaleDefaultOnlyEnvKeys) {
        const sandboxCatalogPlaceholders = filterSandboxPlaceholderEnv(catalogEntry.mcpConfig?.env);
        if (Object.keys(sandboxCatalogPlaceholders).length > 0) {
          const existingEnv = asRecord(server.env);
          const stale = detectStaleSandboxEnvKeys(existingEnv);
          if (stale.length > 0 && existingEnv) {
            const next = { ...existingEnv };
            for (const key of stale) {
              delete next[key];
            }
            server.env = next;
            scrubbedSandboxEnvKeys = stale;
          }
        }
      }

      // Second pass: default-only sandbox env keys ***** RUNWAY_ALLOWED_ROOT).
      // These are placeholder-bearing in the catalog, so the placeholder-free
      // pass above filtered them out. Resolve them via the same machinery the
      // spawn path uses, then inject only when missing — preserving any user
      // override (`mergeMissingStaticKeys` keeps ANY existing string value,
      // including whitespace-only, consistent with `isExistingValid`).
      const sandboxCatalogEnv = filterSandboxPlaceholderEnv(catalogEntry.mcpConfig?.env);
      let addedSandboxEnvKeys: string[] = [];
      let sandboxResolution: SandboxAncestorResolution | null = null;
      if (Object.keys(sandboxCatalogEnv).length > 0) {
        sandboxResolution = getSandboxResolution();
        // configDir/baseDir are unused for keys in DEFAULT_ONLY_SANDBOX_ENV_KEYS:
        // their catalog values reference only {{ALLOWED_ROOTS_ANCESTOR}} and
        // {{ALLOWED_ROOTS_ANCESTOR_DOWNLOADS}}. Pass empty strings so any
        // unexpected sibling placeholder collapses to a leftover `{{...}}`
        // marker that the post-filter below rejects.
        const resolvedSandboxEnv = resolveEnvPlaceholders(
          sandboxCatalogEnv,
          '',
          '',
          sandboxResolution.ancestor ? { ancestor: sandboxResolution.ancestor } : {},
        );
        const usableSandboxEnv: Record<string, string> = {};
        for (const [key, value] of Object.entries(resolvedSandboxEnv)) {
          if (typeof value === 'string' && value.length > 0 && !value.includes('{{')) {
            usableSandboxEnv[key] = value;
          }
        }
        addedSandboxEnvKeys = mergeMissingStaticKeys(server, 'env', usableSandboxEnv);
      }

      const addedEnvKeys = [...addedStaticEnvKeys, ...addedSandboxEnvKeys];

      if (
        addedEnvKeys.length === 0
        && addedHeaderKeys.length === 0
        && scrubbedSandboxEnvKeys.length === 0
      ) {
        continue;
      }

      changed = true;
      const repair: CatalogEnvBackfillRepair = {
        serverName,
        catalogId,
        addedEnvKeys,
        addedHeaderKeys,
      };
      if (addedSandboxEnvKeys.length > 0 && sandboxResolution) {
        repair.addedSandboxEnvKeys = addedSandboxEnvKeys;
        repair.sandboxResolutionStatus = sandboxResolution.dcaStatus;
        if (sandboxResolution.fallbackReason) {
          repair.sandboxResolutionFallbackReason = sandboxResolution.fallbackReason;
        }
      }
      if (scrubbedSandboxEnvKeys.length > 0) {
        repair.scrubbedSandboxEnvKeys = scrubbedSandboxEnvKeys;
      }
      result.repaired.push(repair);
      log.info(repair, 'Backfilled catalog static env on existing MCP entry');
    } catch (err) {
      result.errored += 1;
      log.warn({ err, serverName }, 'Failed to backfill catalog static env on MCP entry');
    }
  }

  if (changed) {
    await writeJsonWithBackup(configPath, config);
  }

  return result;
};
