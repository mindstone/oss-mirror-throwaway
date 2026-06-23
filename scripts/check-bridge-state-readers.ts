#!/usr/bin/env npx tsx
/**
 * Bridge-state env-var contract gate.
 *
 * Enforces the cross-process contract for the Rebel MCP host bridge state path.
 * The host (`bundledMcpManager.bridgeStateEnv()`) emits a fixed set of env-var
 * keys onto every MCP child spawn. The bundled child scripts under
 * `resources/mcp/rebel-*` and `resources/mcp-generated/{slack,microsoft-*}/`
 * each read one or more of those keys to locate the bridge state file (port +
 * token). If a child reads a key the host no longer emits, the read returns
 * undefined, the bridge call silently no-ops, and super-mcp surfaces -33004
 * PACKAGE_UNAVAILABLE — see
 * docs-private/postmortems/260506_mcp_bridge_state_env_var_rename_incomplete_postmortem.md.
 *
 * This script:
 *   1. Parses `bridgeStateEnv()` in `src/main/services/bundledMcpManager.ts`
 *      to discover the writer's emitted key set.
 *   2. Scans every bundled child script for `process.env.<KEY>` reads where
 *      KEY ends in `_BRIDGE_STATE` (excluding the unrelated app-bridge key).
 *   3. Fails if any reader key is not in the writer set.
 *   4. Fails if any rebel-* split MCP server.cjs reads no bridge-state key at
 *      all (these MCPs all need bridge access by construction).
 *
 * The check is intentionally asymmetric (writer ⊇ readers): writers may emit
 * extra keys without breaking anything, but a reader requesting a key the
 * writer doesn't emit always silently breaks.
 *
 * Catalog-driven pass (260613, rec 4fc05fd4f5e916d4):
 *   In addition to the rebel-* split-MCP pass, this script statically parses
 *   `BUNDLED_MCP_CATALOG` in `bundledMcpManager.ts` for every entry with
 *   `needsBridgeState: true` and asserts the per-entry cross-process contract.
 *   Each entry's `scriptResolver` is a runtime function and the resolved
 *   `resources/mcp-generated/**` output is gitignored / absent on fresh
 *   checkouts, so the script maps each bridge-needing catalog entry to its
 *   *source* dir via an explicit `CATALOG_BRIDGE_READER_SOURCES` table:
 *     - `readsBridgeState: true`  → the source dir must read only host-emitted
 *       keys (and at least one).
 *     - `readsBridgeState: false` → the host over-emits and the child ignores
 *       the keys (benign, writer⊇reader). The source dir must read NONE — this
 *       documents the contradiction (e.g. IBKR) and catches a future flip where
 *       the source starts reading a bridge key while the table still says it
 *       doesn't.
 *   Fail-closed: a `needsBridgeState: true` catalog entry with no table mapping
 *   fails the check, forcing maintainer attention when a new bridge-needing
 *   entry is added. See rec source postmortem 260506.
 *
 * Run via: npx tsx scripts/check-bridge-state-readers.ts
 * Part of validate:fast pipeline.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, dirname, relative } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = join(__dirname, '..');
const managerPath = join(repoRoot, 'src', 'main', 'services', 'bundledMcpManager.ts');
const mcpRoot = join(repoRoot, 'resources', 'mcp');
const generatedRoot = join(repoRoot, 'resources', 'mcp-generated');

/**
 * Keys the contract treats as "bridge-state" pointers. Anything ending in
 * `_BRIDGE_STATE` qualifies, except for `REBEL_APP_BRIDGE_STATE`, which
 * points at a different bridge (the paired browser extension's
 * router-internal token file) and is owned by the AppBridge catalog entry's
 * `configPathEnvVars` rather than `bridgeStateEnv()`.
 */
const APP_BRIDGE_STATE_KEY = 'REBEL_APP_BRIDGE_STATE';
// Match both dot access (`process.env.FOO_BRIDGE_STATE`) and bracket access
// (`process.env['FOO_BRIDGE_STATE']` / `process.env["FOO_BRIDGE_STATE"]`) so a
// reader can't silently slip past the gate by switching access style.
const BRIDGE_STATE_KEY_RE =
  /process\.env(?:\.([A-Z][A-Z0-9_]*_BRIDGE_STATE)\b|\[\s*['"]([A-Z][A-Z0-9_]*_BRIDGE_STATE)['"]\s*\])/g;

/**
 * Rebel-internal split MCPs. Each must read at least one writer-emitted
 * bridge-state key. If you add a new split rebel-* MCP, add it here.
 */
const REBEL_SPLIT_MCPS = [
  'rebel-inbox',
  'rebel-meetings',
  'rebel-search-and-conversations',
  'rebel-automations',
  'rebel-spaces',
  'rebel-settings',
  'rebel-mcp-connectors',
  'rebel-plugins',
  'rebel-diagnostics',
] as const;

/**
 * Explicit source-dir mapping for `BUNDLED_MCP_CATALOG` entries flagged
 * `needsBridgeState: true`. Keyed by the catalog object key (the property name
 * in `BUNDLED_MCP_CATALOG`, e.g. `IBKR`). Every such entry MUST appear here
 * (fail-closed) — adding a new bridge-needing catalog entry forces a maintainer
 * to declare where its child reads (or doesn't read) the bridge-state keys.
 *
 *   - `sourceDir`        : repo-relative dir to scan for `process.env.*_BRIDGE_STATE`
 *                          reads. Use SOURCE (resources/mcp/<name>/src), never the
 *                          gitignored generated `resources/mcp-generated/**` output.
 *   - `readsBridgeState` : whether the child actually consumes the bridge keys.
 *                          `false` = host over-emits, child ignores (benign).
 */
interface CatalogBridgeReaderSource {
  sourceDir: string;
  readsBridgeState: boolean;
}
const CATALOG_BRIDGE_READER_SOURCES: Record<string, CatalogBridgeReaderSource> = {
  // IBKR is flagged needsBridgeState: true so the host emits the bridge keys
  // on its spawn, but the IBKR connector source reads only IBKR_HOST/PORT/
  // CLIENT_ID/MODE — it does NOT use the bridge. This is benign over-emission
  // (writer⊇reader is safe). Recorded here so the contradiction is visible, and
  // so a future change that makes the source read a bridge key (without the host
  // emitting it) is caught.
  IBKR: { sourceDir: 'resources/mcp/ibkr/src', readsBridgeState: false },
};



function discoverWriterKeys(): Set<string> {
  const src = readFileSync(managerPath, 'utf8');
  const helperMatch = src.match(
    /const\s+bridgeStateEnv\s*=\s*\(\)[^{]*\{[\s\S]*?return\s*\{([\s\S]*?)\};/
  );
  if (!helperMatch) {
    console.error(
      `❌ Could not locate bridgeStateEnv() helper in ${relative(repoRoot, managerPath)}.`
    );
    console.error(
      '   The check script parses this helper to learn the writer-side key set;'
    );
    console.error(
      '   if you renamed/restructured it, update this script too.'
    );
    process.exit(1);
  }

  const body = helperMatch[1];
  const keys = new Set<string>();
  for (const m of body.matchAll(/^\s*([A-Z][A-Z0-9_]*_BRIDGE_STATE)\s*:/gm)) {
    keys.add(m[1]);
  }
  if (keys.size === 0) {
    console.error(
      `❌ bridgeStateEnv() body parsed but no *_BRIDGE_STATE keys found.`
    );
    console.error(`   Body was:\n${body}`);
    process.exit(1);
  }
  return keys;
}

interface ReaderHit {
  file: string;
  key: string;
}

function findScriptFiles(root: string, allowedExt: string[]): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === '__tests__' || name === 'dist') continue;
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) stack.push(full);
      else if (allowedExt.some((ext) => name.endsWith(ext))) out.push(full);
    }
  }
  return out;
}

function findReaders(root: string, allowedExt: string[]): ReaderHit[] {
  if (!existsSync(root)) return [];
  const hits: ReaderHit[] = [];
  for (const file of findScriptFiles(root, allowedExt)) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(BRIDGE_STATE_KEY_RE)) {
      const key = m[1] ?? m[2];
      if (!key || key === APP_BRIDGE_STATE_KEY) continue;
      hits.push({ file, key });
    }
  }
  return hits;
}

function checkExpectedConsumer(
  hits: ReaderHit[],
  consumerDir: string,
  writerKeys: Set<string>
): string | null {
  const matching = hits.filter((h) => h.file.includes(`/${consumerDir}/`));
  if (matching.length === 0) return `${consumerDir}: reads no bridge-state key`;
  const readsKnown = matching.some((h) => writerKeys.has(h.key));
  if (!readsKnown) {
    const observed = Array.from(new Set(matching.map((h) => h.key))).join(', ');
    return `${consumerDir}: reads only unknown key(s) [${observed}]`;
  }
  return null;
}

/**
 * Statically discover `BUNDLED_MCP_CATALOG` keys whose entry sets
 * `needsBridgeState: true`. Parses the catalog object literal in
 * bundledMcpManager.ts; each entry is a `Key: { ... }` block and we look for a
 * `needsBridgeState: true` line inside the block before the next top-level key.
 *
 * Brace-counting is overkill here — entries are flat one-level objects in the
 * literal — so we split on top-level entry boundaries by matching the
 * `  <Key>: {` openers at the catalog's indentation.
 */
function discoverBridgeNeedingCatalogKeys(): string[] {
  const src = readFileSync(managerPath, 'utf8');
  const catalogMatch = src.match(
    /const\s+BUNDLED_MCP_CATALOG\s*:\s*Record<[^>]*>\s*=\s*\{([\s\S]*?)\n\};/
  );
  if (!catalogMatch) {
    console.error(
      `❌ Could not locate BUNDLED_MCP_CATALOG object literal in ${relative(repoRoot, managerPath)}.`
    );
    console.error(
      '   The catalog-driven bridge-state pass parses this literal; if you renamed/'
    );
    console.error('   restructured it, update scripts/check-bridge-state-readers.ts too.');
    process.exit(1);
  }
  const body = catalogMatch[1];
  // Entry openers are at two-space indentation: `  IBKR: {`
  const entryOpener = /^ {2}([A-Za-z][A-Za-z0-9_]*)\s*:\s*\{/gm;
  const openers: { key: string; index: number }[] = [];
  for (const m of body.matchAll(entryOpener)) {
    openers.push({ key: m[1], index: m.index ?? 0 });
  }
  const keys: string[] = [];
  for (let i = 0; i < openers.length; i++) {
    const start = openers[i].index;
    const end = i + 1 < openers.length ? openers[i + 1].index : body.length;
    const slice = body.slice(start, end);
    if (/\n\s*needsBridgeState\s*:\s*true\b/.test(slice)) {
      keys.push(openers[i].key);
    }
  }
  return keys;
}

/**
 * For each `needsBridgeState: true` catalog entry, assert its declared
 * source-dir contract via CATALOG_BRIDGE_READER_SOURCES. Returns violation
 * strings (empty = pass).
 */
function checkCatalogBridgeEntries(writerKeys: Set<string>): string[] {
  const violations: string[] = [];
  const bridgeKeys = discoverBridgeNeedingCatalogKeys();

  for (const catalogKey of bridgeKeys) {
    const mapping = CATALOG_BRIDGE_READER_SOURCES[catalogKey];
    if (!mapping) {
      violations.push(
        `${catalogKey}: BUNDLED_MCP_CATALOG entry sets needsBridgeState: true but has no ` +
          `CATALOG_BRIDGE_READER_SOURCES mapping in scripts/check-bridge-state-readers.ts. ` +
          `Add { sourceDir, readsBridgeState } so the per-entry bridge-state contract is asserted.`
      );
      continue;
    }

    const absDir = join(repoRoot, mapping.sourceDir);
    if (!existsSync(absDir)) {
      violations.push(
        `${catalogKey}: CATALOG_BRIDGE_READER_SOURCES sourceDir "${mapping.sourceDir}" does not exist. ` +
          `Point it at the connector's source (not gitignored generated output).`
      );
      continue;
    }

    const hits = findReaders(absDir, ['.ts', '.cjs', '.mjs', '.js']);
    const readKeys = Array.from(new Set(hits.map((h) => h.key)));

    if (mapping.readsBridgeState) {
      if (readKeys.length === 0) {
        violations.push(
          `${catalogKey}: declared readsBridgeState: true but source dir "${mapping.sourceDir}" ` +
            `reads no *_BRIDGE_STATE key. Either it should read a host-emitted key, or the table ` +
            `entry should be readsBridgeState: false.`
        );
        continue;
      }
      const unknown = readKeys.filter((k) => !writerKeys.has(k));
      if (unknown.length > 0) {
        violations.push(
          `${catalogKey}: source dir "${mapping.sourceDir}" reads *_BRIDGE_STATE key(s) ` +
            `[${unknown.join(', ')}] that the host does NOT emit. Host emits: ` +
            `[${Array.from(writerKeys).join(', ')}]. This is the 260506 silent-break shape.`
        );
      }
    } else {
      // readsBridgeState: false — the child must read NONE. If it now reads a
      // key, the table is stale and we may have a real writer⊆reader gap.
      if (readKeys.length > 0) {
        violations.push(
          `${catalogKey}: declared readsBridgeState: false but source dir "${mapping.sourceDir}" ` +
            `now reads *_BRIDGE_STATE key(s) [${readKeys.join(', ')}]. Update the table entry to ` +
            `readsBridgeState: true (and ensure every read key is host-emitted).`
        );
      }
    }
  }

  return violations;
}

function main(): void {
  console.log('🔌 MCP Bridge-State Env-Var Contract Check');
  console.log('==========================================\n');

  if (!existsSync(managerPath)) {
    console.error(`❌ Cannot find ${relative(repoRoot, managerPath)}`);
    process.exit(1);
  }

  const writerKeys = discoverWriterKeys();
  console.log(`Writer (bundledMcpManager.bridgeStateEnv) emits:`);
  for (const k of writerKeys) console.log(`  - ${k}`);
  console.log('');

  const handwrittenHits = findReaders(mcpRoot, ['server.cjs', 'server.mjs', '.ts']);
  const generatedHits = findReaders(generatedRoot, ['server.cjs']);
  const allHits = [...handwrittenHits, ...generatedHits];

  const unknownReaders = allHits.filter((h) => !writerKeys.has(h.key));
  const splitMissing = REBEL_SPLIT_MCPS
    .map((dir) =>
      checkExpectedConsumer(handwrittenHits, dir, writerKeys)
    )
    .filter((s): s is string => s !== null);

  const readerCount = new Set(allHits.map((h) => h.file)).size;
  const keyCount = new Set(allHits.map((h) => h.key)).size;

  let hasError = false;

  if (unknownReaders.length > 0) {
    hasError = true;
    console.error(
      `❌ ${unknownReaders.length} reader(s) read a *_BRIDGE_STATE key the host does NOT emit:\n`
    );
    for (const { file, key } of unknownReaders) {
      console.error(`   ${relative(repoRoot, file)} -> process.env.${key}`);
    }
    console.error(
      `\n   Fix options:\n` +
      `   1. If you renamed the writer key: add the old name back to bridgeStateEnv()\n` +
      `      in src/main/services/bundledMcpManager.ts, OR update every listed reader\n` +
      `      to read the new name first (with the old name as fallback during transition).\n` +
      `   2. If the reader's key was a typo: fix the typo.\n` +
      `   3. See docs-private/postmortems/260506_mcp_bridge_state_env_var_rename_incomplete_postmortem.md\n` +
      `      for the May-2026 incident this gate prevents from recurring.\n`
    );
  }

  if (splitMissing.length > 0) {
    hasError = true;
    console.error(
      `❌ ${splitMissing.length} rebel-* split MCP(s) do not read any host-emitted bridge-state key:\n`
    );
    for (const msg of splitMissing) console.error(`   ${msg}`);
    console.error(
      `\n   Every rebel-* split MCP needs bridge access (writer always emits it for them).\n` +
      `   Add a 'process.env.<KEY>' read to its server.cjs, where <KEY> is in the writer set above.\n`
    );
  }

  // Catalog-driven pass: every needsBridgeState: true BUNDLED_MCP_CATALOG entry.
  const catalogViolations = checkCatalogBridgeEntries(writerKeys);
  const catalogEntryCount = discoverBridgeNeedingCatalogKeys().length;
  if (catalogViolations.length > 0) {
    hasError = true;
    console.error(
      `❌ ${catalogViolations.length} BUNDLED_MCP_CATALOG bridge-state contract violation(s):\n`
    );
    for (const msg of catalogViolations) console.error(`   ${msg}`);
    console.error(
      `\n   See docs-private/postmortems/260506_mcp_bridge_state_env_var_rename_incomplete_postmortem.md\n`
    );
  }

  if (hasError) {
    process.exit(1);
  }

  console.log(
    `✅ ${readerCount} reader file(s) across ${keyCount} key(s) — every read key is host-emitted.\n` +
    `   Rebel-* split MCPs verified: ${REBEL_SPLIT_MCPS.length}\n` +
    `   needsBridgeState catalog entries verified: ${catalogEntryCount}\n`
  );
}

main();
