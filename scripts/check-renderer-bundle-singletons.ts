#!/usr/bin/env tsx
/**
 * CI Validation: Renderer bundle singleton check.
 *
 * Stage 4 of `docs/plans/260422_renderer_dedupe_followups.md`.
 *
 * Purpose
 * -------
 * Given a packaged renderer bundle directory, verify that it contains:
 *   - at most N distinct React-family `.version="x.y.z"` objects (default 3)
 *   - at most M distinct `.useState=function` dispatch tables (default 1)
 *
 * This is the only check that directly catches the failure class of
 * `docs-private/postmortems/260422_renderer_null_useState_post_dedupe_postmortem.md`:
 * a partial source-config fix that compiles, passes unit tests, and ships a
 * renderer bundle with duplicate React instances — at runtime the second
 * React sees `null` useState because only the first's dispatcher is installed.
 *
 * Design notes
 * ------------
 * - We count **distinct `(file, identifier)` pairs**, not identifier-only
 *   globally. Two chunks can minify to the same short identifier (`cp`,
 *   `Hi`, `MR`, etc.) yet represent separate React copies; identifier-only
 *   dedupe would undercount. Within a single file, minifiers guarantee
 *   unique identifiers per scope, so same-file same-identifier dedupe is
 *   safe.
 * - The expected React version is read from `<repoRoot>/node_modules/react/package.json`
 *   at runtime — no `--expected-version` CLI flag. Upgrades Just Work.
 * - We only count `.version=` objects whose captured string EXACTLY equals
 *   React's version. Third-party `.version="1.2.3"` assignments won't
 *   false-positive unless they happen to collide exactly with React, which
 *   is vanishingly rare.
 * - Bundle is scanned recursively; bundles are flat today but a future
 *   reshape shouldn't silently escape the check.
 *
 * Usage
 * -----
 *   npx tsx scripts/check-renderer-bundle-singletons.ts \
 *       --bundle-dir <path> \
 *       [--max-version-objects N] [--max-usestate N]
 *
 * Default `--bundle-dir` is `<repoRoot>/.vite/renderer/main_window/assets`
 * (produced by `electron-forge package`). After a packaged build, point at
 * `out/<AppName>-darwin-<arch>/<AppName>.app/Contents/Resources/app.asar.unpacked/.vite/renderer/main_window/assets`
 * if that path exists, otherwise extract `app.asar` with
 * `npx @electron/asar extract <app.asar> <target>` first.
 *
 * Exit codes
 * ----------
 *   0 — bundle meets singleton thresholds, OR no built bundle is present and
 *       enforce mode is off (clean SKIP — see "Skip-when-no-bundle" below)
 *   1 — bundle exceeds thresholds; bundle dir missing/empty WHILE in enforce
 *       mode; or `node_modules/react/package.json` missing (run `npm ci`)
 *
 * Skip-when-no-bundle (warn-first posture)
 * ----------------------------------------
 * The check needs a BUILT renderer bundle (`.vite/renderer/main_window/assets`,
 * produced by `electron-forge package`). In the normal local / pre-commit /
 * `validate:fast` state that directory does not exist, so the check prints an
 * advisory and exits 0 (clean skip) — it must never fail `validate:fast` just
 * because nobody ran `npm run package`. This mirrors the warn-first posture of
 * `scripts/check-test-coverage-delta.ts` /
 * `scripts/check-boundary-contract-coverage.ts`.
 *
 * Its real teeth are in the release pipeline AFTER packaging: run it there with
 * `RENDERER_BUNDLE_SINGLETONS_ENFORCE=1` (or `--enforce`) so a missing/empty
 * bundle is then a hard failure (the bundle MUST exist post-package) and any
 * threshold violation fails the build. Promotion to enforce is a CI-wiring
 * follow-up; an explicit `--bundle-dir` still inspects whatever is passed.
 *
 * Wiring
 * ------
 * - `validate:renderer-bundle-singletons` npm script for discoverability.
 * - Added to `validate:fast` as a skip-safe step (no bundle → exit 0 advisory).
 */

import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Pure helpers (unit-testable)
// ---------------------------------------------------------------------------

export interface BundleScanResult {
  /** Distinct `(file, identifier)` pairs matching React `.version="x.y.z"`. */
  versionPairs: Array<{ file: string; identifier: string }>;
  /** Distinct `(file, identifier)` pairs matching `.useState=function`. */
  useStatePairs: Array<{ file: string; identifier: string }>;
  /** Absolute paths of every `.js` file scanned. */
  scannedFiles: string[];
}

const VERSION_REGEX = /([A-Za-z_$][A-Za-z0-9_$]*)\.version\s*=\s*['"](\d+\.\d+\.\d+)['"]/g;
const USE_STATE_REGEX = /([A-Za-z_$][A-Za-z0-9_$]*)\.useState\s*=\s*function/g;

/**
 * Collect all `.js` (and `.mjs`/`.cjs`) files in a directory recursively.
 * Pure enough: takes the dir path and a read adapter so tests can fake fs.
 */
export function collectJsFiles(
  bundleDir: string,
  readdir: (p: string) => fs.Dirent[] = (p) =>
    fs.readdirSync(p, { withFileTypes: true }),
): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdir(dir)) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (/\.(?:js|mjs|cjs)$/.test(entry.name)) {
        out.push(full);
      }
    }
  };
  walk(bundleDir);
  return out.sort();
}

/**
 * Extract all distinct (file, identifier) pairs from a single file's text
 * matching the provided regex. Same-file same-identifier collapses to one
 * pair (safe: minifiers guarantee unique identifiers per scope within a
 * single file).
 */
export function countDistinctPairs(
  file: string,
  text: string,
  regex: RegExp,
  filter?: (match: RegExpExecArray) => boolean,
): Array<{ file: string; identifier: string }> {
  const seen = new Set<string>();
  const pairs: Array<{ file: string; identifier: string }> = [];
  // Always use a local copy with the /g flag to avoid shared-state hazards.
  const r = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g');
  let m: RegExpExecArray | null;
  while ((m = r.exec(text)) !== null) {
    if (filter && !filter(m)) continue;
    const identifier = m[1]!;
    if (seen.has(identifier)) continue;
    seen.add(identifier);
    pairs.push({ file, identifier });
  }
  return pairs;
}

export interface ScanBundleOptions {
  readFile?: (p: string) => string;
  readdir?: (p: string) => fs.Dirent[];
  exists?: (p: string) => boolean;
}

/**
 * Scan a bundle directory and return all matching pairs. Pure over its
 * injected filesystem adapters.
 */
export function scanBundleDirectory(
  bundleDir: string,
  expectedReactVersion: string,
  options: ScanBundleOptions = {},
): BundleScanResult {
  const {
    readFile = (p: string) => fs.readFileSync(p, 'utf8'),
    readdir = (p: string) => fs.readdirSync(p, { withFileTypes: true }),
    exists = (p: string) => fs.existsSync(p),
  } = options;

  if (!exists(bundleDir)) {
    throw new Error(
      `Renderer bundle directory not found: ${bundleDir}. ` +
        `Run \`npm run package\` (or point --bundle-dir at an existing build).`,
    );
  }

  const scannedFiles = collectJsFiles(bundleDir, readdir);
  if (scannedFiles.length === 0) {
    throw new Error(
      `Renderer bundle directory contains no JS files: ${bundleDir}. ` +
        `This check never soft-passes — if the bundle really is empty, something is wrong upstream.`,
    );
  }
  const versionPairs: Array<{ file: string; identifier: string }> = [];
  const useStatePairs: Array<{ file: string; identifier: string }> = [];

  for (const file of scannedFiles) {
    let text: string;
    try {
      text = readFile(file);
    } catch (err) {
      throw new Error(`Failed to read ${file}: ${(err as Error).message}`);
    }

    versionPairs.push(
      ...countDistinctPairs(file, text, VERSION_REGEX, (m) => m[2] === expectedReactVersion),
    );
    useStatePairs.push(...countDistinctPairs(file, text, USE_STATE_REGEX));
  }

  return { versionPairs, useStatePairs, scannedFiles };
}

/**
 * Read the pinned React version from `<repoRoot>/node_modules/react/package.json`.
 * Throws if the file is missing (suggests `npm ci`).
 */
export function readExpectedReactVersion(
  repoRoot: string,
  readFile: (p: string) => string = (p) => fs.readFileSync(p, 'utf8'),
  exists: (p: string) => boolean = (p) => fs.existsSync(p),
): string {
  const pkgPath = path.join(repoRoot, 'node_modules', 'react', 'package.json');
  if (!exists(pkgPath)) {
    throw new Error(
      `Cannot read React version: ${pkgPath} is missing. Run \`npm ci\` first.`,
    );
  }
  const pkg = JSON.parse(readFile(pkgPath)) as { version?: unknown };
  if (typeof pkg.version !== 'string') {
    throw new Error(`${pkgPath} is missing a string \`version\` field.`);
  }
  return pkg.version;
}

export interface CheckOptions {
  bundleDir: string;
  expectedReactVersion: string;
  maxVersionObjects?: number;
  maxUseStateDispatchers?: number;
  scanOptions?: ScanBundleOptions;
}

export interface CheckOutcome {
  ok: boolean;
  summary: string;
  violations: string[];
  result: BundleScanResult;
}

export function runCheck({
  bundleDir,
  expectedReactVersion,
  maxVersionObjects = 3,
  maxUseStateDispatchers = 1,
  scanOptions,
}: CheckOptions): CheckOutcome {
  const result = scanBundleDirectory(bundleDir, expectedReactVersion, scanOptions);
  const violations: string[] = [];

  if (result.versionPairs.length > maxVersionObjects) {
    violations.push(
      `Found ${result.versionPairs.length} React-family \`.version="${expectedReactVersion}"\` ` +
        `objects in bundle; expected \u2264 ${maxVersionObjects}. Pairs:\n` +
        result.versionPairs.map((p) => `  - ${p.identifier} in ${p.file}`).join('\n'),
    );
  }

  if (result.useStatePairs.length > maxUseStateDispatchers) {
    violations.push(
      `Found ${result.useStatePairs.length} \`.useState=function\` dispatchers ` +
        `in bundle; expected \u2264 ${maxUseStateDispatchers}. Pairs:\n` +
        result.useStatePairs.map((p) => `  - ${p.identifier} in ${p.file}`).join('\n'),
    );
  }

  const summary = `renderer bundle singleton check: ${result.versionPairs.length} version object(s), ${result.useStatePairs.length} useState dispatcher(s) across ${result.scannedFiles.length} file(s) (expected React ${expectedReactVersion}).`;

  return { ok: violations.length === 0, summary, violations, result };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export interface CliArgs {
  bundleDir?: string;
  maxVersionObjects?: number;
  maxUseStateDispatchers?: number;
  helpRequested?: boolean;
  /** Promote the gate from warn/skip to blocking (see ENV_ENFORCE). */
  enforce?: boolean;
}

/** Env var that promotes the gate from warn-first/skip to blocking. */
export const ENV_ENFORCE = 'RENDERER_BUNDLE_SINGLETONS_ENFORCE';

/**
 * Whether enforce mode is active: `--enforce` flag OR the env var set to a
 * truthy ('1'/'true') value. In enforce mode a missing/empty bundle is a HARD
 * failure (the bundle MUST exist post-package); otherwise it's a clean skip.
 */
export function isEnforceMode(
  args: CliArgs,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (args.enforce) return true;
  const v = env[ENV_ENFORCE];
  return v === '1' || v === 'true';
}

export class CliArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliArgError';
  }
}

function requireValue(argv: readonly string[], i: number, flag: string): string {
  const v = argv[i];
  if (v === undefined || v.startsWith('--')) {
    throw new CliArgError(`${flag} requires a value`);
  }
  return v;
}

function parseNonNegativeInt(raw: string, flag: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    throw new CliArgError(
      `${flag} must be a non-negative integer, got ${JSON.stringify(raw)}`,
    );
  }
  return n;
}

/**
 * Parse CLI args strictly. Unknown flags, missing values, and non-integer
 * thresholds throw `CliArgError` so the validator cannot be silently
 * disabled by a typo. This fixes the silent-failure anti-pattern where
 * `--max-usestate nope` would become `NaN` and make `n > NaN` always false.
 */
export function parseCliArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--bundle-dir') {
      args.bundleDir = requireValue(argv, ++i, a);
    } else if (a === '--max-version-objects') {
      args.maxVersionObjects = parseNonNegativeInt(requireValue(argv, ++i, a), a);
    } else if (a === '--max-usestate') {
      args.maxUseStateDispatchers = parseNonNegativeInt(
        requireValue(argv, ++i, a),
        a,
      );
    } else if (a === '--enforce') {
      args.enforce = true;
    } else if (a === '--help' || a === '-h') {
      args.helpRequested = true;
    } else {
      throw new CliArgError(`Unknown flag: ${a}`);
    }
  }
  return args;
}

const USAGE =
  'Usage: check-renderer-bundle-singletons.ts [--bundle-dir <path>] [--max-version-objects N] [--max-usestate N] [--enforce]\n' +
  '  Without --enforce (and RENDERER_BUNDLE_SINGLETONS_ENFORCE unset), a missing/empty\n' +
  '  bundle dir is a clean SKIP (exit 0). With enforce mode on, it is a hard failure.';

/**
 * Does the bundle directory exist and contain at least one JS file?
 * Used to decide skip-vs-run when no `--bundle-dir` forces a specific target.
 */
export function bundleIsPresent(
  bundleDir: string,
  exists: (p: string) => boolean = (p) => fs.existsSync(p),
  readdir: (p: string) => fs.Dirent[] = (p) =>
    fs.readdirSync(p, { withFileTypes: true }),
): boolean {
  if (!exists(bundleDir)) return false;
  try {
    return collectJsFiles(bundleDir, readdir).length > 0;
  } catch {
    return false;
  }
}

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_BUNDLE_DIR = path.join(REPO_ROOT, '.vite', 'renderer', 'main_window', 'assets');

async function main(): Promise<void> {
  let args: CliArgs;
  try {
    args = parseCliArgs(process.argv.slice(2));
  } catch (err) {
     
    console.error(`\u2718 ${(err as Error).message}\n${USAGE}`);
    process.exit(1);
  }
  if (args.helpRequested) {
     
    console.log(USAGE);
    return;
  }
  const bundleDir = args.bundleDir ?? DEFAULT_BUNDLE_DIR;
  const enforce = isEnforceMode(args);

  // Skip-when-no-bundle: in the normal local / pre-commit / validate:fast state
  // there is no packaged renderer bundle. Exit 0 with an advisory unless enforce
  // mode is on (release pipeline, post-package — the bundle MUST exist there).
  if (!bundleIsPresent(bundleDir)) {
    if (enforce) {
       
      console.error(
        `✘ Renderer bundle not found at ${bundleDir} but enforce mode is on. ` +
          'Run `npm run package` first (post-package release context expects a built bundle).',
      );
      process.exit(1);
    }
     
    console.log(
      `⚠ [renderer-bundle-singletons] ADVISORY: no built renderer bundle at ${bundleDir}; skipping. ` +
        'This check has teeth only after `npm run package` (release pipeline, run with ' +
        `${ENV_ENFORCE}=1 / --enforce). Skipping cleanly (exit 0).`,
    );
    return;
  }

  const expectedReactVersion = readExpectedReactVersion(REPO_ROOT);
  const outcome = runCheck({
    bundleDir,
    expectedReactVersion,
    maxVersionObjects: args.maxVersionObjects,
    maxUseStateDispatchers: args.maxUseStateDispatchers,
  });

  if (outcome.ok) {
     
    console.log(`\u2714 ${outcome.summary}`);
    return;
  }
   
  console.error(`\u2718 ${outcome.summary}`);
  for (const v of outcome.violations) {
     
    console.error(v);
  }
  process.exit(1);
}

if (require.main === module) {
  main().catch((err) => {
     
    console.error(`\u2718 Renderer bundle singleton check crashed: ${(err as Error).message}`);
    process.exit(1);
  });
}
