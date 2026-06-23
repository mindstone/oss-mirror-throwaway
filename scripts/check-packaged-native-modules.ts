#!/usr/bin/env npx tsx
/**
 * Packaged `*.node` allowlist inventory (PLAN.md docs/plans/260611_fsevents-shutdown-crash,
 * Stage 3c — RS F6c).
 *
 * Why this exists (and why it stays after the Electron 42 upgrade): every native Node
 * addon that uses ThreadSafeFunctions (TSFNs) is exposed to a quit-time hang in its
 * N-API finalizer when state it holds is torn down at `FreeEnvironment → RunCleanup`.
 * This is NOT fixed by the Electron >= 41 (Node >= 24.14) TSFN lifetime fix (#55877):
 * the 260613 spike measured that on Node 24 the old fsevents SIGABRT
 * (nodejs/node#55706) becomes an indefinite quit DEADLOCK at the same site
 * (`fse_instance_destroy → napi_release_threadsafe_function → __psynch_mutexwait`) —
 * telemetry-blind, not a crash (SPIKE_FINDINGS_REPORT §3). The fsevents instance of
 * this class is neutralised by the leak-guard sweep (src/main/services/fseventsLeakGuard.ts
 * + finalExit.ts), which is therefore PERMANENT — but the hazard class stays open for
 * every OTHER packaged native module, on every Electron line.
 *
 * So: this script scans every packaged Resources tree for `*.node` files and compares the
 * owning packages against a committed allowlist. A NEW unlisted native module is RED —
 * not because it is necessarily broken, but because adding a native module means accepting
 * a new member of the TSFN-teardown hazard class, and that must be a deliberate decision
 * (verify its shutdown path, then extend the allowlist with evidence). See:
 *   - docs/plans/260611_fsevents-shutdown-crash/PLAN.md (root cause)
 *   - docs/project/AUTO_UPDATE.md (fsevents sweep / Electron 42 section: crash→deadlock on Node 24)
 *   - docs-private/postmortems/260610_macos_update_quit_fsevents_sigabrt_postmortem.md
 *
 * Skip semantics: with no packaged build present (no Resources/resources trees under the
 * base path) the script SKIPS with exit 0 locally — it is wired into the packaged-check
 * flow (`preflight:desktop-packaged-boot` packages first, so it always has a tree there).
 * BUT in a CI context (GITHUB_ACTIONS / CI env) the package step always runs before this
 * check, so "no tree found" is a real failure (a misconfigured layout or a tree-finder
 * miss), NOT a benign local skip — it FAILS loudly there. This closes the spike's
 * misleading-green hole, where the Windows leg SKIPped without checking and the workflow
 * surfaced a false "passed" (ci_run_27377676963_attempt1.log:4487).
 *
 * Usage: npx tsx scripts/check-packaged-native-modules.ts [basePath=out]
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Allowlisted owners of packaged `*.node` files. Key = package name, or a `*`-suffixed
 * prefix for platform-suffixed package families (e.g. `@lancedb/lancedb-darwin-arm64`,
 * `-win32-x64-msvc`, ...). Value = evidence: why this native is expected in the package.
 * Discovered from a real darwin-arm64 `out/` tree (2026-06-11) + forge.config.cjs.
 *
 * Adding an entry = accepting a new TSFN-teardown hazard-class member (fatal on every
 * Electron line: SIGABRT <=40 / quit-deadlock >=41)
 * (see module header). Verify the module's shutdown/teardown path first.
 */
export interface AllowedNativeEntry {
  /** Why this native is expected in the package (the deliberate-acceptance record). */
  evidence: string;
  /**
   * When present, files attributed to this owner must ALSO sit at one of these exact
   * Resources-relative paths — a copy of the package ANYWHERE else is RED (stage-3
   * review F1). Used for fsevents: the safe/handled instance is not "any fsevents
   * anywhere", it is the single app-watcher copy resolved through the bootstrap-patched
   * module cache (app.asar.unpacked + NODE_PATH shim). A second packaged fsevents copy
   * (e.g. nested under Resources/mcp/* or Resources/super-mcp/*) would be loaded OUTSIDE
   * the wrapper's module cache — untracked instances, sweep blind — exactly the
   * second-copy class this guard must keep visible.
   */
  allowedPaths?: readonly string[];
}

export const ALLOWED_NATIVE_PACKAGES: ReadonlyMap<string, AllowedNativeEntry> = new Map([
  [
    'fsevents',
    {
      evidence:
        'chokidar@3 darwin watcher backend (forge step 5f copies it to app.asar.unpacked) — THE quit-time ' +
        'SIGABRT subject; tracked + swept by fseventsLeakGuard/finalExit (PLAN 260611_fsevents-shutdown-crash)',
      // Path-pinned (reviewer F1): ONLY the wrapper-patched app-watcher copy is allowed.
      allowedPaths: ['app.asar.unpacked/node_modules/fsevents/fsevents.node'],
    },
  ],
  [
    '@lancedb/lancedb-*',
    {
      evidence:
        'LanceDB vector-store binding (platform-suffixed package per target) — known open TSFN-class exposure ' +
        '(Worker::JoinThread shutdown SIGABRT, docs/plans/partway/260115_fix-lancedb-shutdown-crash.md)',
    },
  ],
  ['@img/sharp-*', { evidence: 'sharp image processing (platform-suffixed libvips binding)' }],
  [
    '@stoprocent/bluetooth-hci-socket',
    { evidence: 'BLE HCI socket for device features; ships multi-platform prebuilds inside the one package' },
  ],
  [
    '@stoprocent/noble',
    { evidence: 'BLE central library; ships multi-platform prebuilds inside the one package' },
  ],
  ['onnxruntime-node', { evidence: 'ONNX Runtime binding (local inference: embeddings/audio)' }],
  [
    'cpu-features',
    { evidence: 'ssh2 optional crypto acceleration — bundled replit-ssh MCP server tree (Resources/mcp)' },
  ],
  ['ssh2', { evidence: 'sshcrypto.node — bundled replit-ssh MCP server tree (Resources/mcp)' }],
  [
    'keytar',
    { evidence: 'OS-keychain credential storage — bundled super-mcp runtime tree (Resources/super-mcp)' },
  ],
  [
    'sherpa-onnx-win-x64',
    {
      evidence:
        'sherpa-onnx win32-x64 native library (the actual sherpa-onnx.node binary) — forge step 5d copies ' +
        'it to app.asar.unpacked/node_modules on win32 ONLY (forge.config.cjs:1521-1528). This is the entry ' +
        'that owns a real .node file on the Windows tree; sherpa-onnx-node (the JS loader, copied alongside) ' +
        'has no .node of its own. Unmatched (informational) on macOS/Linux trees, which legitimately lack it.',
    },
  ],
]);

// --- Pure core (unit-tested) ------------------------------------------------------------

/**
 * Owning package of a packaged file path (posix-relative within a Resources tree):
 * the name after the LAST `node_modules/` segment (scoped names = two segments).
 * Files outside any node_modules are returned as `(non-package) <path>` — they can only
 * pass via an exact allowlist entry, so a stray loose `.node` file is loud by default.
 */
export function owningPackageOf(relativePosixPath: string): string {
  const marker = 'node_modules/';
  const idx = relativePosixPath.lastIndexOf(marker);
  if (idx === -1) {
    return `(non-package) ${relativePosixPath}`;
  }
  const rest = relativePosixPath.slice(idx + marker.length);
  const segments = rest.split('/');
  if (segments[0]?.startsWith('@') && segments.length >= 2) {
    return `${segments[0]}/${segments[1]}`;
  }
  return segments[0] ?? rest;
}

/** Allowlist pattern matching the owner name (exact, or `*`-suffixed prefix), or null. */
export function findAllowlistPattern(
  owner: string,
  allowlist: ReadonlyMap<string, AllowedNativeEntry> = ALLOWED_NATIVE_PACKAGES,
): string | null {
  if (allowlist.has(owner)) {
    return owner;
  }
  for (const pattern of allowlist.keys()) {
    if (pattern.endsWith('*') && owner.startsWith(pattern.slice(0, -1))) {
      return pattern;
    }
  }
  return null;
}

/**
 * Is this specific packaged file allowlisted? Name match alone is not sufficient for
 * path-pinned entries (fsevents): the file must also sit at an allowed path.
 */
export function isAllowlisted(
  owner: string,
  relativePosixPath?: string,
  allowlist: ReadonlyMap<string, AllowedNativeEntry> = ALLOWED_NATIVE_PACKAGES,
): boolean {
  const pattern = findAllowlistPattern(owner, allowlist);
  if (pattern === null) {
    return false;
  }
  const entry = allowlist.get(pattern);
  if (entry?.allowedPaths && relativePosixPath !== undefined) {
    return entry.allowedPaths.includes(relativePosixPath);
  }
  return true;
}

export interface NativeInventoryResult {
  /**
   * Violation key → the packaged .node files attributed to it (relative posix paths).
   * Keys are either an unlisted owner name, or `<owner> (copy outside its pinned path)`
   * for path-pinned owners found at an unexpected location (the fsevents second-copy class).
   */
  unlisted: Map<string, string[]>;
  /** Allowlist patterns that matched nothing in this tree (informational only — a darwin tree legitimately lacks win32 natives and vice versa). */
  unusedAllowlistPatterns: string[];
  scannedNativeFileCount: number;
}

export function checkNativeInventory(
  relativePosixPaths: readonly string[],
  allowlist: ReadonlyMap<string, AllowedNativeEntry> = ALLOWED_NATIVE_PACKAGES,
): NativeInventoryResult {
  const unlisted = new Map<string, string[]>();
  const matchedPatterns = new Set<string>();
  const addViolation = (key: string, file: string): void => {
    const existing = unlisted.get(key) ?? [];
    existing.push(file);
    unlisted.set(key, existing);
  };
  for (const file of relativePosixPaths) {
    const owner = owningPackageOf(file);
    const pattern = findAllowlistPattern(owner, allowlist);
    if (pattern === null) {
      addViolation(owner, file);
      continue;
    }
    const entry = allowlist.get(pattern);
    if (entry?.allowedPaths && !entry.allowedPaths.includes(file)) {
      // Name matches a path-pinned entry but the file is somewhere else — the
      // second-copy class (see AllowedNativeEntry.allowedPaths). Deliberately NOT
      // counted as a pattern match: the pinned copy may legitimately be absent
      // while a rogue copy exists.
      addViolation(`${owner} (copy outside its pinned path)`, file);
      continue;
    }
    matchedPatterns.add(pattern);
  }
  return {
    unlisted,
    unusedAllowlistPatterns: [...allowlist.keys()].filter((p) => !matchedPatterns.has(p)),
    scannedNativeFileCount: relativePosixPaths.length,
  };
}

// --- Filesystem scan (mirrors check-packaged-super-mcp-bundle.ts) ------------------------

function isDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Is this path segment a "Resources" tree, case-insensitively? macOS packages
 * capitalize it (`<App>.app/Contents/Resources`) but Windows packaged apps use
 * lowercase `resources` under `out/<App>-win32-x64/resources` (release.yml win32
 * package step; forge.config.cjs Windows copy steps). The original capital-only
 * match SKIPped the entire Windows tree, so the Windows native inventory never
 * ran (spike CI evidence: ci_run_27377676963_attempt1.log:4487). Matching both
 * casings is what lets the Windows leg actually inventory + validate its natives.
 */
function isResourcesBasename(candidate: string): boolean {
  return path.basename(candidate).toLowerCase() === 'resources';
}

export function discoverResourcesDirs(basePath: string): string[] {
  const resolvedBase = path.resolve(basePath);
  const candidates = new Set<string>();

  for (const candidate of [
    resolvedBase,
    path.join(resolvedBase, 'Resources'),
    path.join(resolvedBase, 'resources'),
    path.join(resolvedBase, 'Contents', 'Resources'),
  ]) {
    if (isResourcesBasename(candidate) && isDirectory(candidate)) {
      candidates.add(candidate);
    }
  }

  const pending: Array<{ dir: string; depth: number }> = [{ dir: resolvedBase, depth: 0 }];
  while (pending.length > 0) {
    const current = pending.shift();
    if (!current || current.depth > 4 || !isDirectory(current.dir)) {
      continue;
    }
    if (isResourcesBasename(current.dir)) {
      candidates.add(current.dir);
      continue;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      pending.push({ dir: path.join(current.dir, entry.name), depth: current.depth + 1 });
    }
  }

  return [...candidates].sort();
}

export function collectNativeFiles(resourcesDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.isFile() && entry.name.endsWith('.node')) {
        out.push(path.relative(resourcesDir, abs).split(path.sep).join('/'));
      }
    }
  };
  walk(resourcesDir);
  return out.sort();
}

// --- CLI ---------------------------------------------------------------------------------

/**
 * Are we running inside CI? In CI the package step always precedes this check, so a
 * "no packaged tree found" result is a real failure (layout drift / tree-finder miss),
 * not a benign local skip. GitHub Actions sets both `CI` and `GITHUB_ACTIONS`.
 */
export function isCiContext(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.GITHUB_ACTIONS === 'true' || env.CI === 'true';
}

function main(argv: readonly string[]): number {
  const basePath = argv[0] ?? path.resolve(process.cwd(), 'out');
  const resourcesDirs = discoverResourcesDirs(basePath);

  if (resourcesDirs.length === 0) {
    if (isCiContext()) {
      // The package step always runs before this check in CI, so an empty result
      // means the tree finder did not locate the packaged app (or it was not built)
      // — exactly the misleading-green hole the Windows leg fell into. FAIL loudly.
      process.stderr.write(
        `[check-packaged-native-modules] FAIL: no packaged Resources/resources trees under ` +
          `${path.resolve(basePath)} in a CI context — the package step should have produced one. ` +
          'This is the misleading-green case (spike ci_run_27377676963_attempt1.log:4487): the native ' +
          'inventory cannot validate a tree it cannot find. Check the package step output and the ' +
          'packaged layout (macOS: <App>.app/Contents/Resources; Windows: <App>-win32-x64/resources).\n',
      );
      return 1;
    }
    process.stdout.write(
      `[check-packaged-native-modules] SKIP: no packaged Resources/resources trees under ${path.resolve(basePath)} — ` +
        'run `npm run package` first (the preflight:desktop-packaged-boot flow packages before checking; ' +
        'Stage 4 packaged runs validate this live).\n',
    );
    return 0;
  }

  let totalScanned = 0;
  const allUnlisted = new Map<string, string[]>();
  const matchedSomewhere = new Set<string>();
  for (const resourcesDir of resourcesDirs) {
    const files = collectNativeFiles(resourcesDir);
    const result = checkNativeInventory(files);
    totalScanned += result.scannedNativeFileCount;
    for (const [owner, ownerFiles] of result.unlisted) {
      const existing = allUnlisted.get(owner) ?? [];
      existing.push(...ownerFiles.map((f) => `${path.relative(process.cwd(), resourcesDir)}/${f}`));
      allUnlisted.set(owner, existing);
    }
    for (const pattern of ALLOWED_NATIVE_PACKAGES.keys()) {
      if (!result.unusedAllowlistPatterns.includes(pattern)) {
        matchedSomewhere.add(pattern);
      }
    }
  }

  if (allUnlisted.size > 0) {
    process.stderr.write('[check-packaged-native-modules] FAIL: unlisted native module(s) in the packaged app.\n\n');
    for (const [owner, files] of allUnlisted) {
      process.stderr.write(`  ${owner}:\n${files.map((f) => `    - ${f}`).join('\n')}\n`);
    }
    process.stderr.write(
      '\nWhy this is RED: EVERY native addon using ThreadSafeFunctions is exposed to a quit-time hang when\n' +
        'a TSFN it still holds is torn down at FreeEnvironment (nodejs/node#55706). The Electron >= 41\n' +
        '(Node >= 24.14) TSFN fix does NOT remove this: it converts the old SIGABRT into an indefinite quit\n' +
        'DEADLOCK at the same finalizer site (telemetry-blind hung quit — SPIKE_FINDINGS_REPORT §3), which\n' +
        'is why the fsevents leak sweep is permanent. Shipping a NEW native module is a deliberate\n' +
        'acceptance of that hazard: verify its shutdown/teardown path (does it hold TSFNs past your\n' +
        'cleanup? does it stop cleanly before app.exit?), then add it to ALLOWED_NATIVE_PACKAGES in\n' +
        'scripts/check-packaged-native-modules.ts with the evidence.\n' +
        'A "(copy outside its pinned path)" violation is worse than a new module: the package is known,\n' +
        'but THIS copy resolves outside the leak-guard wrapper\'s patched module cache (fsevents is pinned\n' +
        'to app.asar.unpacked/node_modules/fsevents/fsevents.node) — its instances would be untracked and\n' +
        'the quit sweep blind to them. Remove the extra copy; do not allowlist it.\n' +
        'Context: docs/plans/260611_fsevents-shutdown-crash/PLAN.md;\n' +
        'docs-private/postmortems/260610_macos_update_quit_fsevents_sigabrt_postmortem.md\n',
    );
    return 1;
  }

  const unused = [...ALLOWED_NATIVE_PACKAGES.keys()].filter((p) => !matchedSomewhere.has(p));
  process.stdout.write(
    `[check-packaged-native-modules] OK: ${totalScanned} packaged .node file(s) across ` +
      `${resourcesDirs.length} Resources tree(s); all owners allowlisted.` +
      (unused.length > 0
        ? ` (info: allowlist patterns unmatched on this platform's tree: ${unused.join(', ')})`
        : '') +
      '\n',
  );
  return 0;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  process.exit(main(process.argv.slice(2)));
}
