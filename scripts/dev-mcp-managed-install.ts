#!/usr/bin/env tsx
/**
 * scripts/dev-mcp-managed-install.ts
 *
 * Pre-publish local smoke test for `@mindstone/mcp-server-*` connectors.
 * Builds + packs a candidate from the in-repo `mcp-servers` submodule (or the
 * legacy sibling layout when the submodule is not initialized), then
 * pre-populates the same managed-install slot Rebel uses after a successful
 * `npm install <pkg>@<ver>`. The dev app's auto-upgrade sees a valid slot,
 * skips reinstall, and spawns the candidate via the same `node <path>` code
 * path it will use after the package is published.
 *
 * Reuses production install machinery via the public seam
 * `ManagedMcpInstallService.install({ source: { localTarball } })`. All
 * fidelity properties (npm flags, npmrc neutralization, atomic rename,
 * .install-meta.json shape) are preserved by construction.
 *
 * See docs/project/MCP_DEV_LOCAL_OVERRIDE.md for the runbook.
 * See docs/plans/260521_pre-publish-local-mcp-test/PLAN.md for design.
 *
 * Usage:
 *   npx tsx scripts/dev-mcp-managed-install.ts install <connector-id> [--source <path>]
 *   npx tsx scripts/dev-mcp-managed-install.ts uninstall <connector-id>
 *   npx tsx scripts/dev-mcp-managed-install.ts list
 *
 * Defaults:
 *   <source> = $MCP_SERVERS_REPO, else <repo>/mcp-servers (submodule) or
 *   <repo>/../mcp-servers (legacy sibling), then /connectors/<connector-id>
 *
 * Invariants (enforced or printed):
 *   - Stop dev Rebel BEFORE running `install` (we preflight; refuse if running).
 *   - Always run `uninstall` after the smoke passes, before `npm publish`.
 *     The sentinel + startup banner is a safety net, NOT a substitute.
 *   - REBEL_CATALOG_OVERRIDE must be set on every dev relaunch — reverts on its
 *     own otherwise via `reconcileNpxPackageVersions`.
 *   - Workflow validates DESKTOP ONLY. Cloud parity remains validated by Phase F
 *     step 30 post-publish smoke.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { defaultCapabilities, setPlatformConfig } from '../src/core/platform';
import {
  DEV_PRE_PUBLISH_SENTINEL_FILENAME,
  createManagedMcpInstallService,
  resolveManagedInstallsRoot,
  type DevPrePublishSentinel,
} from '../src/main/services/managedMcpInstallService';
import {
  ALLOWED_NPX_PACKAGE_RE,
  CatalogSchema,
} from '../src/shared/connectorCatalogSchema';

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, '..');
const CATALOG_PATH = path.join(REPO_ROOT, 'resources', 'connector-catalog.json');

/**
 * Compute the same userData directory Electron sets via
 * `app.setPath('userData', path.join(app.getPath('appData'), 'mindstone-rebel'))`
 * — see src/main/startup/ensureAppIdentity.ts.
 *
 * Mirrors Electron's `app.getPath('appData')` per-platform default:
 *   - darwin:  ~/Library/Application Support
 *   - win32:   %APPDATA% (CSIDL_APPDATA)
 *   - linux:   $XDG_CONFIG_HOME (fallback ~/.config)
 *
 * Single source of truth: keep in sync with ensureAppIdentity.ts.
 */
function resolveUserDataPath(): string {
  const home = os.homedir();
  let appData: string;
  if (process.platform === 'darwin') {
    appData = path.join(home, 'Library', 'Application Support');
  } else if (process.platform === 'win32') {
    appData = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
  } else {
    appData = process.env.XDG_CONFIG_HOME ?? path.join(home, '.config');
  }
  return path.join(appData, 'mindstone-rebel');
}

function resolveConnectorSourcePath(connectorId: string, overridePath?: string): string {
  if (overridePath) {
    return path.resolve(overridePath);
  }
  // Prefer the in-repo submodule when initialized (Track A of the OSS release
  // automation plan adds mcp-servers as a submodule at <repo>/mcp-servers).
  // The connectors/ content marker (same convention as the publish scripts and
  // the equivalence gate) distinguishes an initialized submodule from the empty
  // directory git leaves for an uninitialized one — an empty dir must not
  // shadow a valid sibling checkout. Fall back to the legacy sibling layout
  // for engineers who keep mcp-servers on disk outside the rebel checkout.
  const submodulePath = path.join(REPO_ROOT, 'mcp-servers');
  const siblingPath = path.join(REPO_ROOT, '..', 'mcp-servers');
  const defaultRoot = existsSync(path.join(submodulePath, 'connectors')) ? submodulePath : siblingPath;
  const mcpServersRoot = process.env.MCP_SERVERS_REPO ?? defaultRoot;
  return path.resolve(mcpServersRoot, 'connectors', connectorId);
}

// ---------------------------------------------------------------------------
// Catalog access — uses Stage 0 shared schema, no Electron imports
// ---------------------------------------------------------------------------

interface PackagedConnector {
  catalogId: string;
  packageSpec: string;
}

/**
 * Narrow read of resources/connector-catalog.json. Intentionally skips the
 * strict Zod schema in @shared/connectorCatalogSchema: that schema validates
 * overrides supplied by users (where strictness matters for security), but
 * the bundled catalog uses values the schema doesn't yet enumerate (e.g.
 * `maturity: 'preview' | 'deprecated'`). The script only needs id +
 * mcpConfig.command + mcpConfig.args[1]; reading those directly avoids
 * coupling the wrapper to schema evolution.
 */
async function readPackagedConnectors(): Promise<PackagedConnector[]> {
  const raw = await fs.readFile(CATALOG_PATH, 'utf8');
  const parsed = JSON.parse(raw) as {
    connectors?: Array<{
      id?: unknown;
      mcpConfig?: { command?: unknown; args?: unknown };
    }>;
  };
  const out: PackagedConnector[] = [];
  for (const c of parsed.connectors ?? []) {
    if (typeof c.id !== 'string') continue;
    const args = c.mcpConfig?.args;
    if (c.mcpConfig?.command !== 'npx' || !Array.isArray(args)) continue;
    // npx args shape: ["-y", "@mindstone/mcp-server-<name>@<version>", ...]
    const yesIdx = args.findIndex((a) => a === '-y' || a === '--yes');
    if (yesIdx === -1 || yesIdx + 1 >= args.length) continue;
    const spec = args[yesIdx + 1];
    if (typeof spec !== 'string') continue;
    if (!spec.startsWith('@mindstone/mcp-server-') && !spec.startsWith('@mindstone-engineering/mcp-server-')) {
      continue;
    }
    out.push({ catalogId: c.id, packageSpec: spec });
  }
  return out;
}

function findConnectorByShorthand(
  available: PackagedConnector[],
  shorthand: string,
): PackagedConnector | null {
  // Accept either the full catalogId ("bundled-hubspot") or the short connector
  // segment that publish-mcp-to-registry.sh uses ("hubspot" — matches the
  // mcp-servers/connectors/<id>/ folder name).
  const exact = available.find((c) => c.catalogId === shorthand);
  if (exact) return exact;
  const suffixMatches = available.filter((c) => {
    const pkgName = c.packageSpec.split('@').slice(0, -1).join('@');
    const tail = pkgName.split('/').pop() ?? '';
    const trimmed = tail.replace(/^mcp-server-/, '');
    return trimmed === shorthand || c.catalogId === `bundled-${shorthand}`;
  });
  if (suffixMatches.length === 1) return suffixMatches[0];
  if (suffixMatches.length > 1) {
    throw new Error(
      `Ambiguous connector shorthand "${shorthand}" — matches: ${suffixMatches.map((c) => c.catalogId).join(', ')}`,
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Preflight checks
// ---------------------------------------------------------------------------

function preflightDevAppNotRunning(): void {
  // Best-effort: check for an Electron process with this repo's path on the
  // command line. macOS + Linux only; Windows users get a warning instead.
  // Refusing on false positives is worse than a missed positive — print and
  // continue if anything weird happens.
  if (process.platform === 'win32') {
    console.warn(
      '  ! Windows: cannot reliably detect a running dev Rebel. STOP dev manually before continuing.',
    );
    return;
  }
  try {
    const out = execFileSync('pgrep', ['-fl', 'electron.*rebel-app'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (out.trim()) {
      throw new Error(
        `Dev Rebel appears to be running:\n${out
          .split('\n')
          .filter(Boolean)
          .map((l) => `      ${l}`)
          .join('\n')}\n    Stop it (Cmd+Q or Ctrl+C the npm run dev shell) and re-run this command.\n    Running the wrapper while dev is up races with the in-flight auto-upgrade scan.`,
      );
    }
  } catch (err) {
    // pgrep exits 1 when no matches — that's the success case.
    if ((err as { status?: number }).status === 1) return;
    if (err instanceof Error && err.message.startsWith('Dev Rebel appears')) throw err;
    // Otherwise pgrep is unavailable; warn but continue.
    console.warn('  ! Could not run pgrep to detect dev Rebel; continuing. Confirm dev is stopped.');
  }
}

async function preflightSourcePath(sourcePath: string): Promise<void> {
  if (!existsSync(sourcePath)) {
    throw new Error(
      `Source path does not exist: ${sourcePath}\n    Set MCP_SERVERS_REPO=<path> or pass --source <path>.\n    Default: <repo>/mcp-servers/connectors/<connector-id> (submodule), else <repo>/../mcp-servers/connectors/<connector-id>`,
    );
  }
  const pkgJsonPath = path.join(sourcePath, 'package.json');
  if (!existsSync(pkgJsonPath)) {
    throw new Error(`Source path has no package.json: ${pkgJsonPath}`);
  }
}

// ---------------------------------------------------------------------------
// Build + pack the candidate from the source tree
// ---------------------------------------------------------------------------

interface BuildAndPackResult {
  tarballPath: string;
  packageName: string;
  packageVersion: string;
}

async function buildAndPack(sourcePath: string): Promise<BuildAndPackResult> {
  const pkgJsonPath = path.join(sourcePath, 'package.json');
  const pkgJson = JSON.parse(await fs.readFile(pkgJsonPath, 'utf8')) as {
    name?: string;
    version?: string;
    scripts?: Record<string, string>;
  };
  if (!pkgJson.name || !pkgJson.version) {
    throw new Error(`Source package.json missing name/version: ${pkgJsonPath}`);
  }

  console.log(`  • Source:  ${sourcePath}`);
  console.log(`  • Package: ${pkgJson.name}@${pkgJson.version}`);

  const npmCi = spawnSync('npm', ['ci', '--ignore-scripts'], {
    cwd: sourcePath,
    stdio: 'inherit',
  });
  if (npmCi.status !== 0) {
    throw new Error(`\`npm ci\` failed in ${sourcePath} (exit ${npmCi.status ?? 'null'})`);
  }

  if (pkgJson.scripts?.build) {
    const npmBuild = spawnSync('npm', ['run', 'build'], {
      cwd: sourcePath,
      stdio: 'inherit',
    });
    if (npmBuild.status !== 0) {
      throw new Error(`\`npm run build\` failed in ${sourcePath} (exit ${npmBuild.status ?? 'null'})`);
    }
  } else {
    console.log('  • No build script — skipping');
  }

  // Pack into a dedicated temp dir so we don't pollute the source tree and
  // can deterministically find the tarball afterward.
  const packDir = mkdtempSync(path.join(os.tmpdir(), 'dev-mcp-pack-'));
  const npmPack = spawnSync(
    'npm',
    ['pack', '--ignore-scripts', '--pack-destination', packDir, sourcePath],
    {
      stdio: 'inherit',
    },
  );
  if (npmPack.status !== 0) {
    throw new Error(`\`npm pack\` failed (exit ${npmPack.status ?? 'null'})`);
  }

  const entries = readdirSync(packDir).filter((f) => f.endsWith('.tgz'));
  if (entries.length !== 1) {
    throw new Error(`Expected exactly one .tgz in ${packDir}, found: ${entries.join(', ')}`);
  }
  const tarballPath = path.join(packDir, entries[0]);
  return { tarballPath, packageName: pkgJson.name, packageVersion: pkgJson.version };
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

function bootstrapPlatformConfig(): void {
  const userDataPath = resolveUserDataPath();
  setPlatformConfig({
    userDataPath,
    appPath: REPO_ROOT,
    tempPath: os.tmpdir(),
    logsPath: path.join(userDataPath, 'logs'),
    homePath: os.homedir(),
    documentsPath: path.join(os.homedir(), 'Documents'),
    desktopPath: path.join(os.homedir(), 'Desktop'),
    appDataPath: userDataPath,
    version: '0.0.0-dev-mcp-managed-install',
    isPackaged: false,
    platform: process.platform,
    totalMemoryBytes: os.totalmem(),
    arch: process.arch,
    surface: 'desktop',
    isOss: false,
    capabilities: defaultCapabilities('desktop'),
  });
}

async function cmdInstall(shorthand: string, sourceOverride?: string): Promise<void> {
  console.log(`==> install ${shorthand}`);
  preflightDevAppNotRunning();

  const available = await readPackagedConnectors();
  const connector = findConnectorByShorthand(available, shorthand);
  if (!connector) {
    console.error(`ERROR: connector "${shorthand}" not found in catalog as a rebel-oss npx entry.`);
    console.error('Available rebel-oss connectors:');
    for (const c of available) {
      const shortName = c.packageSpec.split('@')[1]?.split('/').pop()?.replace('mcp-server-', '');
      console.error(`  - ${c.catalogId} (${shortName})`);
    }
    process.exitCode = 2;
    return;
  }

  const sourcePath = resolveConnectorSourcePath(
    connector.catalogId.replace(/^bundled-/, ''),
    sourceOverride,
  );
  await preflightSourcePath(sourcePath);

  bootstrapPlatformConfig();

  const { tarballPath, packageName, packageVersion } = await buildAndPack(sourcePath);

  const candidateSpec = `${packageName}@${packageVersion}`;
  console.log(`  • Tarball: ${tarballPath}`);
  console.log(`  • Catalog: ${connector.catalogId} (currently pinned to ${connector.packageSpec})`);

  const userDataPath = resolveUserDataPath();
  const service = createManagedMcpInstallService({
    userDataPath,
    // Skip bundled-npm resolution: dev developers have npm on PATH and we want
    // their environment, not the app-resources copy.
    npmPath: 'npm',
    // Skip seed lookup entirely — wrapper-installed slots NEVER consult seeds.
    seedTarballLookup: () => null,
  });

  console.log('  • Installing into managed-installs slot...');
  const metadata = await service.install({
    packageSpec: candidateSpec,
    source: { localTarball: tarballPath },
    force: true,
  });

  console.log('');
  console.log('==> OK');
  console.log(`  Slot:     ${metadata.installRoot}`);
  console.log(`  Entry:    ${metadata.entryPath}`);
  console.log(`  Sentinel: ${path.join(metadata.installRoot, DEV_PRE_PUBLISH_SENTINEL_FILENAME)}`);

  if (candidateSpec !== connector.packageSpec) {
    console.log('');
    console.log('  Catalog override needed: catalog pins ' + connector.packageSpec);
    console.log(`  but you packed ${candidateSpec}. Auto-generating a CatalogSchema-valid override...`);

    const { catalog: overrideCatalog, report } = await buildSanitizedFullOverride(
      connector.catalogId,
      candidateSpec,
    );
    const overridePath = resolveOverrideOutputPath(userDataPath, connector.catalogId);
    await fs.mkdir(path.dirname(overridePath), { recursive: true });
    await fs.writeFile(overridePath, JSON.stringify(overrideCatalog, null, 2), 'utf8');

    const keptCount = (overrideCatalog as { connectors: unknown[] }).connectors.length;
    console.log('');
    console.log(`  Override written: ${overridePath}`);
    console.log(`    • ${keptCount} connectors kept`);
    console.log(`    • ${report.droppedConnectors.length} dropped (would fail validateCommandArgs)`);
    console.log(`    • ${report.strippedFields.length} field-level sanitations (annotations/maturity/etc.)`);

    if (report.droppedConnectors.length > 0) {
      const sample = report.droppedConnectors.slice(0, 8).map((d) => d.id).join(', ');
      const more = report.droppedConnectors.length > 8 ? `, +${report.droppedConnectors.length - 8} more` : '';
      console.log(`    • Dropped (hidden during this test session): ${sample}${more}`);
      console.log('      These are non-OSS or commands the resolver doesn\'t accept in overrides yet.');
      console.log('      See ALLOWED_NPX_PACKAGE_RE in src/shared/connectorCatalogSchema.ts.');
    }

    console.log('');
    console.log('  Launch dev:');
    console.log(`    REBEL_CATALOG_OVERRIDE='${overridePath}' npm run dev`);
    console.log('');
    console.log('  ⚠  Must be set on EVERY dev relaunch — reconcileNpxPackageVersions reverts otherwise.');
    console.log('     Add to your shell config for the duration of the smoke session if you prefer.');
  } else {
    console.log('');
    console.log('  No catalog override needed (candidate version matches the pinned catalog version).');
    console.log('  Just relaunch dev — the auto-upgrade scan will find your slot and skip reinstall.');
  }

  console.log('');
  console.log('  When done smoke-testing, run:');
  console.log(`    npx tsx scripts/dev-mcp-managed-install.ts uninstall ${shorthand}`);
}

interface SanitizeReport {
  droppedConnectors: Array<{ id: string; reason: string }>;
  strippedFields: Array<{ path: string; reason: string }>;
}

/**
 * Predicate matching `connectorCatalogResolver.validateCommandArgs` for the
 * runtime-startup whitelist. We keep this purposely tight: the resolver runs
 * the strict version on the override, so any connector this predicate rejects
 * would cause Catalog override rejection at dev launch.
 *
 * Rules:
 *  - No `mcpConfig.command` → keep (direct OAuth/HTTP connectors)
 *  - `command === 'npx'` AND args = ["-y", <whitelisted-pkg@x.y.z>] → keep
 *  - `command === 'node'` → DROP (wrapper can't synthesize the absolute path
 *    under app-resources/managed-mcps required by the resolver)
 *  - Anything else → DROP
 */
function passesValidatorWhitelist(connector: { mcpConfig?: { command?: unknown; args?: unknown } }): {
  ok: boolean;
  reason?: string;
} {
  const cmd = connector.mcpConfig?.command;
  const args = connector.mcpConfig?.args;
  if (cmd === undefined || cmd === null) return { ok: true };
  if (cmd === 'npx') {
    if (!Array.isArray(args) || args.length !== 2 || args[0] !== '-y') {
      return { ok: false, reason: `npx args wrong shape: ${JSON.stringify(args)}` };
    }
    if (typeof args[1] !== 'string' || !ALLOWED_NPX_PACKAGE_RE.test(args[1])) {
      return {
        ok: false,
        reason: `npx package not in ALLOWED_NPX_PACKAGE_RE whitelist: ${String(args[1])}`,
      };
    }
    return { ok: true };
  }
  return { ok: false, reason: `command "${String(cmd)}" not allowed in overrides` };
}

/**
 * Iteratively strip schema-rejected keys and coerce known-incompatible enum
 * values until `CatalogSchema.parse` succeeds. The bundled catalog uses fields
 * the override schema doesn't enumerate (e.g. `annotations` on tools,
 * `maturity: 'preview'/'deprecated'`), so a naive copy-and-swap fails strict
 * validation. This sanitizer is bounded by the iteration limit and reports
 * every mutation it made, for observability.
 *
 * @internal — exported for unit tests
 */
function sanitizeForCatalogSchema(catalog: unknown, report: SanitizeReport): unknown {
  const MAX_ITERATIONS = 50;
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const r = CatalogSchema.safeParse(catalog);
    if (r.success) return r.data;

    let changed = false;
    for (const iss of r.error.issues) {
      if (iss.code === 'unrecognized_keys') {
        // For unrecognized_keys, iss.path points to the OBJECT with the bad
        // keys (NOT to a child property), so we don't slice. The `keys` array
        // names the extras to delete.
        const target = pathLookup(catalog, iss.path);
        if (!target || typeof target !== 'object') continue;
        for (const k of (iss as { keys?: string[] }).keys ?? []) {
          if (!Object.prototype.hasOwnProperty.call(target, k)) continue;
          delete (target as Record<string, unknown>)[k];
          report.strippedFields.push({
            path: `${iss.path.join('.')}.${k}`,
            reason: 'key not in strict CatalogSchema',
          });
          changed = true;
        }
        continue;
      }

      // Leaf-value issues (enum mismatch, wrong type, etc.) — path ends at
      // the offending property, so the parent is one level up.
      const parent = pathLookup(catalog, iss.path.slice(0, -1));
      if (!parent || typeof parent !== 'object') continue;
      const key = iss.path[iss.path.length - 1];
      if (key === undefined) continue;
      if (!Object.prototype.hasOwnProperty.call(parent, key as string)) {
        // The schema is complaining about a MISSING required field; we
        // can't synthesize one. Skip — convergence will fail below.
        continue;
      }

      if (key === 'maturity') {
        // The schema only enumerates ['beta','stable']; bundled uses
        // 'preview' and 'deprecated' too. Coerce both to 'beta' (the more
        // conservative end of the spectrum) so the override still loads.
        (parent as Record<string, unknown>)[key as string] = 'beta';
        report.strippedFields.push({
          path: iss.path.join('.'),
          reason: `coerced unknown maturity to 'beta'`,
        });
        changed = true;
      } else {
        // Strip any other schema-incompatible field rather than letting the
        // whole override be rejected. Safe because the override only needs
        // the connector shape the resolver uses at runtime; stripped
        // metadata fields don't affect spawning.
        delete (parent as Record<string, unknown>)[key as string];
        report.strippedFields.push({
          path: iss.path.join('.'),
          reason: `field rejected by CatalogSchema: ${iss.message}`,
        });
        changed = true;
      }
    }

    if (!changed) {
      // Defensive: schema rejected the catalog but we couldn't mutate
      // anything (e.g. an issue we didn't know how to handle). Fail loudly
      // so a future schema change doesn't silently neuter the wrapper.
      throw new Error(
        `Sanitizer could not converge on a CatalogSchema-valid override.\n` +
          `Remaining issues:\n${r.error.issues
            .slice(0, 5)
            .map((iss) => `  ${iss.path.join('.')}: ${iss.message}`)
            .join('\n')}`,
      );
    }
  }
  throw new Error(`Sanitizer exceeded ${MAX_ITERATIONS} iterations — likely an infinite loop in the strip logic.`);
}

function pathLookup(root: unknown, segments: ReadonlyArray<PropertyKey>): unknown {
  return segments.reduce<unknown>(
    (acc, seg) => (acc == null || typeof acc !== 'object' ? acc : (acc as Record<PropertyKey, unknown>)[seg]),
    root,
  );
}

/**
 * Build a CatalogSchema-valid override JSON that:
 *  1. Copies the bundled catalog
 *  2. Drops connectors that would fail `validateCommandArgs` (the silent-
 *     rejection class that ate us in pre-publish smoke testing — see
 *     docs-private/postmortems / MCP_DEV_LOCAL_OVERRIDE.md § Whitelist drift).
 *  3. Swaps the target connector's `mcpConfig.args` to the candidate spec.
 *  4. Sanitizes the result against CatalogSchema (strips
 *     `annotations`, coerces `maturity: preview/deprecated`, etc.).
 *
 * Returns both the catalog object and a report describing what was filtered
 * or stripped — surfaced in the install command's stdout so the engineer
 * understands which connectors will disappear from the UI during the smoke.
 *
 * @internal — exported for unit tests
 */
async function buildSanitizedFullOverride(
  targetConnectorId: string,
  candidateSpec: string,
): Promise<{ catalog: unknown; report: SanitizeReport }> {
  const raw = await fs.readFile(CATALOG_PATH, 'utf8');
  const catalog = JSON.parse(raw) as {
    version?: unknown;
    connectors?: Array<Record<string, unknown>>;
  };
  if (!Array.isArray(catalog.connectors)) {
    throw new Error(`Catalog has no connectors array: ${CATALOG_PATH}`);
  }

  const report: SanitizeReport = { droppedConnectors: [], strippedFields: [] };

  // Filter to whitelist-passing connectors.
  const kept: Array<Record<string, unknown>> = [];
  for (const c of catalog.connectors) {
    const verdict = passesValidatorWhitelist(c as { mcpConfig?: { command?: unknown; args?: unknown } });
    if (verdict.ok) {
      kept.push(c);
    } else {
      report.droppedConnectors.push({
        id: typeof c.id === 'string' ? c.id : '<unknown>',
        reason: verdict.reason ?? 'unknown',
      });
    }
  }
  catalog.connectors = kept;

  // Swap the target connector's spec. Must happen AFTER filtering so we
  // fail loudly if filtering accidentally dropped our target.
  const target = catalog.connectors.find((c) => c.id === targetConnectorId);
  if (!target) {
    throw new Error(
      `After filter, target connector "${targetConnectorId}" not present in override. ` +
        `Either it failed validateCommandArgs (check ALLOWED_NPX_PACKAGE_RE) or its id is wrong.`,
    );
  }
  target.mcpConfig = { command: 'npx', args: ['-y', candidateSpec] };

  // Now sanitize to satisfy strict CatalogSchema (annotations, maturity, etc.).
  const sanitized = sanitizeForCatalogSchema(catalog, report);

  return { catalog: sanitized, report };
}

/**
 * Where the wrapper writes the auto-generated override file. Persistent + per-
 * connector so the engineer can stash `export REBEL_CATALOG_OVERRIDE=...` in
 * their shell config for the duration of a smoke session.
 */
function resolveOverrideOutputPath(userDataPath: string, connectorId: string): string {
  return path.join(userDataPath, 'mcp', 'dev-overrides', `${connectorId}.json`);
}

async function cmdUninstall(shorthand: string): Promise<void> {
  console.log(`==> uninstall ${shorthand}`);
  const available = await readPackagedConnectors();
  const connector = findConnectorByShorthand(available, shorthand);
  if (!connector) {
    console.error(`ERROR: connector "${shorthand}" not found in catalog.`);
    process.exitCode = 2;
    return;
  }

  bootstrapPlatformConfig();
  const userDataPath = resolveUserDataPath();
  const managedRoot = resolveManagedInstallsRoot(userDataPath);
  const slots = await listSlots(managedRoot, connector.packageSpec.split('@').slice(0, -1).join('@'));
  if (slots.length === 0) {
    console.log(`  No installed slots for ${connector.packageSpec.split('@').slice(0, -1).join('@')}.`);
    return;
  }

  const service = createManagedMcpInstallService({
    userDataPath,
    npmPath: 'npm',
    seedTarballLookup: () => null,
  });

  for (const slot of slots) {
    console.log(`  • Removing slot: ${slot}`);
    await service.uninstall(path.basename(slot).startsWith('@')
      ? `${path.basename(path.dirname(slot))}/${path.basename(slot)}`
      : path.basename(slot));
  }

  // Remove the auto-generated override file. Idempotent: a missing file is
  // expected if the engineer never needed an override (version match).
  const overridePath = resolveOverrideOutputPath(userDataPath, connector.catalogId);
  try {
    await fs.unlink(overridePath);
    console.log(`  • Removed override: ${overridePath}`);
    console.log('    Remember to unset REBEL_CATALOG_OVERRIDE in any shell that exported it.');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  console.log('==> OK');
}

async function listSlots(managedRoot: string, packageName: string): Promise<string[]> {
  // packageName like "@mindstone/mcp-server-hubspot" — find <root>/<scope>/<name>@*
  if (!existsSync(managedRoot)) return [];
  const slots: string[] = [];
  if (packageName.startsWith('@')) {
    const [scope, name] = packageName.split('/');
    const scopeDir = path.join(managedRoot, scope);
    if (!existsSync(scopeDir)) return [];
    for (const entry of await fs.readdir(scopeDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(`${name}@`)) slots.push(path.join(scopeDir, entry.name));
    }
  } else {
    for (const entry of await fs.readdir(managedRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(`${packageName}@`)) slots.push(path.join(managedRoot, entry.name));
    }
  }
  return slots;
}

async function cmdList(): Promise<void> {
  console.log('==> list');
  bootstrapPlatformConfig();
  const userDataPath = resolveUserDataPath();
  const managedRoot = resolveManagedInstallsRoot(userDataPath);

  if (!existsSync(managedRoot)) {
    console.log(`  No managed-installs root: ${managedRoot}`);
    return;
  }

  const allSlots: Array<{
    packageSpec: string;
    slotPath: string;
    installedAt: string;
    devSentinel: DevPrePublishSentinel | null;
  }> = [];

  const visitSlot = async (slotPath: string, packageSpec: string): Promise<void> => {
    const metaPath = path.join(slotPath, '.install-meta.json');
    let installedAt = '<unknown>';
    try {
      const meta = JSON.parse(await fs.readFile(metaPath, 'utf8')) as { installedAt?: string };
      installedAt = meta.installedAt ?? installedAt;
    } catch {
      // skip
    }
    let devSentinel: DevPrePublishSentinel | null = null;
    try {
      const raw = await fs.readFile(path.join(slotPath, DEV_PRE_PUBLISH_SENTINEL_FILENAME), 'utf8');
      devSentinel = JSON.parse(raw) as DevPrePublishSentinel;
    } catch {
      // not a dev install — fine
    }
    allSlots.push({ packageSpec, slotPath, installedAt, devSentinel });
  };

  for (const entry of await fs.readdir(managedRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    if (entry.name.startsWith('@')) {
      for (const sub of await fs.readdir(path.join(managedRoot, entry.name), { withFileTypes: true })) {
        if (!sub.isDirectory() || sub.name.startsWith('.')) continue;
        await visitSlot(path.join(managedRoot, entry.name, sub.name), `${entry.name}/${sub.name}`);
      }
    } else {
      await visitSlot(path.join(managedRoot, entry.name), entry.name);
    }
  }

  if (allSlots.length === 0) {
    console.log('  No managed installs.');
    return;
  }

  for (const slot of allSlots) {
    const marker = slot.devSentinel ? ' [DEV BUILD — run uninstall before relying on this!]' : '';
    console.log(`  ${slot.packageSpec}${marker}`);
    console.log(`    installed: ${slot.installedAt}`);
    console.log(`    slot:      ${slot.slotPath}`);
    if (slot.devSentinel) {
      console.log(`    tarball:   ${slot.devSentinel.tarballPath}`);
    }
  }
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const [, , subcommand, ...rest] = process.argv;
  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    console.log(
      [
        'Usage:',
        '  npx tsx scripts/dev-mcp-managed-install.ts install <connector> [--source <path>]',
        '  npx tsx scripts/dev-mcp-managed-install.ts uninstall <connector>',
        '  npx tsx scripts/dev-mcp-managed-install.ts list',
        '',
        'See docs/project/MCP_DEV_LOCAL_OVERRIDE.md for the runbook.',
      ].join('\n'),
    );
    process.exitCode = subcommand ? 0 : 2;
    return;
  }

  switch (subcommand) {
    case 'install': {
      const connector = rest[0];
      if (!connector || connector.startsWith('-')) {
        console.error('ERROR: install requires <connector> as the first arg');
        process.exitCode = 2;
        return;
      }
      const sourceIdx = rest.indexOf('--source');
      const source = sourceIdx >= 0 ? rest[sourceIdx + 1] : undefined;
      await cmdInstall(connector, source);
      return;
    }
    case 'uninstall': {
      const connector = rest[0];
      if (!connector) {
        console.error('ERROR: uninstall requires <connector> as the first arg');
        process.exitCode = 2;
        return;
      }
      await cmdUninstall(connector);
      return;
    }
    case 'list':
      await cmdList();
      return;
    default:
      console.error(`ERROR: unknown subcommand "${subcommand}"`);
      process.exitCode = 2;
  }
}

// Re-exported for unit tests (the CLI shell doesn't import any of these into a
// real Electron context, so this is safe).
export const _internalsForTests = {
  buildSanitizedFullOverride,
  findConnectorByShorthand,
  passesValidatorWhitelist,
  readPackagedConnectors,
  resolveConnectorSourcePath,
  resolveOverrideOutputPath,
  resolveUserDataPath,
  sanitizeForCatalogSchema,
};

if (require.main === module) {
  main().catch((err) => {
    console.error('ERROR:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
