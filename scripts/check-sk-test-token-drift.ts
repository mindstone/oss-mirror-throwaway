#!/usr/bin/env npx tsx
/**
 * Repo-wide `sk-*` test-token drift check (260419 prepush postmortem D1).
 *
 * **Why this exists:** The 260419 follow-up roadmap (`C3(b)`) called for
 * sweeping the codebase of `sk-*`-prefixed fake tokens that imitate real
 * provider key shapes (`sk-ant-…`, `sk-proj-…`, `sk-or-…`). Those shapes
 * trigger Droid-Shield false positives during agent sessions, wasting
 * tool-calls and reviewer attention. The Stage-2 manual sweep landed in
 * `17555c3b9`, but a manual sweep is one-shot — without a guardrail the
 * convention silently drifts as new tests get added.
 *
 * **What this does:** Scans **test surfaces only** — every file under any
 * `__tests__/` directory, every file under `evals/fixtures/`, and every
 * file matching the `*.{test,spec}.{ts,tsx,js,jsx}` filename pattern at
 * any path — for the regex `(?:^|[^a-zA-Z0-9])sk-[a-zA-Z0-9_-]+`. Every
 * hit is classified as either ALLOWED (the file/directory is in the
 * allowlist) or DRIFT (it isn't). Exits 0 iff every hit is ALLOWED.
 *
 * **Scope rationale (Stage 5 Phase 6 narrowing):** The original Stage-5
 * draft scanned 7 broad project roots (`src/`, `evals/`, `scripts/`,
 * `cloud-service/`, `cloud-client/`, `packages/`, `mobile/`). That scope
 * forced production redaction code, UI placeholder text, and eval shared
 * libs into the allowlist purely because they were scanned — none of them
 * were the drift class the check was designed to catch. Narrowing to test
 * surfaces (any `__tests__/` directory + `evals/fixtures/` + any
 * `*.{test,spec}.{ts,tsx,js,jsx}` filename) focuses the guardrail on the
 * thing it actually prevents (drift in newly added tests/fixtures)
 * without taxing production code. The filename branch was added
 * 2026-05-02 as follow-up #7 closure to cover co-located test files at
 * non-canonical paths (e.g. `resources/mcp/<server>/test-mcp.test.ts`,
 * `tests/e2e/<name>.spec.ts`).
 *
 * **What's allowed:** See `scripts/sk-test-token-allowlist.ts` for the
 * source-of-truth list. The shape: prefix-shape contract tests, eval
 * fixture directories whose JSON files carry realistic-shape provider
 * credentials by design, and the drift-check's own test fixtures.
 *
 * **Allowlist coverage:** Every entry in the allowlist must match at least
 * one real source file. Orphan entries (allowlist drift in the other
 * direction — pointing at a deleted/renamed file) are also a regression
 * worth catching, so this check fails closed on them too.
 *
 * **Extension allowlist:** We only read text-shaped extensions
 * (`.ts`, `.tsx`, `.js`, `.jsx`, `.json`, `.md`, `.txt`, `.html`, `.css`).
 * Reading PNGs / SQLite blobs / fonts as UTF-8 risked false-positive hits
 * from coincidental byte sequences and was a Phase-5 reviewer + tester
 * finding. Skip everything else.
 *
 * Pattern reference: see `scripts/check-husky-pre-push-fast-tier.ts` and
 * `scripts/check-integration-test-provider-gates.ts` for the canonical
 * `validate:fast` smoke-check shape this script follows.
 *
 * Run via: `npx tsx scripts/check-sk-test-token-drift.ts`
 * Wired into `npm run validate:fast`.
 *
 * @see scripts/sk-test-token-allowlist.ts (allowlist source-of-truth)
 * @see docs-private/postmortems/260419_prepush_live_api_integration_test_404_postmortem.md
 * @see docs/plans/260419_prepush_followups_roadmap.md (D1)
 * @see docs/project/TESTING_AUTOMATION_OVERVIEW.md (A6 sk-* test-token convention)
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readFileToleratingVanished } from './lib/safeScanRead';
import { SK_TEST_TOKEN_ALLOWLIST, type AllowlistEntry } from './sk-test-token-allowlist';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Top-level scan roots. Every project surface that ships test code or
 * eval fixtures. We walk each root and only retain files whose
 * repo-relative path matches a test-surface predicate (`isTestSurfacePath`).
 */
const SCAN_ROOTS: readonly string[] = [
  'src',
  'evals',
  'scripts',
  'cloud-service',
  'cloud-client',
  'packages',
  'mobile',
  'tests', // Playwright E2E (`tests/e2e/*.spec.ts`) — added 2026-05-02 with the
           // `*.{test,spec}.{ts,tsx,js,jsx}` filename predicate branch so co-located
           // E2E spec files are scanned alongside Vitest unit tests.
];

/**
 * Directories to skip during recursive walk. Avoids traversing build
 * artifacts, vendor code, and other generated trees.
 */
const SKIP_DIR_NAMES: ReadonlySet<string> = new Set([
  'node_modules',
  'dist',
  'out',
  'release',
  'build',
  '.electron-vite',
  '.next',
  '.cache',
  'coverage',
]);

/**
 * Allowed file extensions. Anything not in this set is skipped — we read
 * source as UTF-8, and binary blobs (`.png`, `.sqlite`, `.woff2`, `.pdf`,
 * `.ico`, etc.) can carry token-shaped byte sequences that produce false
 * positives. Stage 5 Phase-6 finding (Gemini + tester proof-fixture).
 *
 * Comparison is on `path.extname(file).toLowerCase()`.
 */
const ALLOWED_EXTENSIONS: ReadonlySet<string> = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.json',
  '.md',
  '.txt',
  '.html',
  '.css',
]);

/**
 * Detection regex for `sk-…` literal hits. The leading `[^a-zA-Z0-9]`
 * boundary ensures we don't match identifiers like `risk-ant-…` or
 * `desk-…`. The body matches alphanumerics, hyphens, and underscores —
 * the same character set OpenAI / Anthropic actually use.
 *
 * Exported for unit tests.
 */
export const SK_TOKEN_REGEX = /(?:^|[^a-zA-Z0-9])sk-[a-zA-Z0-9_-]+/g;

export type SkHit = {
  /** Repo-relative POSIX-style path. */
  readonly file: string;
  readonly line: number;
  /** The matched literal (without the leading boundary char). */
  readonly literal: string;
  /** Allowlist entry that covered this hit, or null if DRIFT. */
  readonly matchedEntry: AllowlistEntry | null;
};

export interface DriftCheckResult {
  readonly drift: readonly SkHit[];
  readonly allowedHits: readonly SkHit[];
  readonly orphanedAllowlistEntries: readonly AllowlistEntry[];
  /**
   * Count of test-surface files discovered/attempted by the scan
   * (`files.length`). This is the number of eligible files the scan tried
   * to read — it is NOT reduced by `vanishedDuringScan`.
   */
  readonly filesScanned: number;
  /**
   * Subset of `filesScanned` that were listed by the directory walk but had
   * vanished (deleted) by the time we tried to read them — a concurrent
   * deletion / TOCTOU. These are skipped (a vanished file cannot be committed
   * drift); under the canonical standalone run this is expected to be 0.
   */
  readonly vanishedDuringScan: number;
}

/**
 * True iff `relPath` (POSIX-style, repo-relative) is a test surface — i.e.
 * lives under a `__tests__/` directory at any depth, OR under
 * `evals/fixtures/`, OR has a `*.{test,spec}.{ts,tsx,js,jsx}` filename
 * suffix at any path. Anything else (production code, UI placeholders,
 * eval runners, scripts) is out of scope for this guardrail by design.
 *
 * The filename-suffix branch was added 2026-05-02 as follow-up #7
 * closure: closes the "convention-coupling risk" DA flagged — co-located
 * test files at non-canonical paths (e.g. `resources/mcp/<server>/test-mcp.test.ts`,
 * `tests/e2e/foo.spec.ts`) are now scanned without requiring a
 * `__tests__/` directory. Both `*.test.*` and `*.spec.*` are covered
 * because `TESTING_AUTOMATION_OVERVIEW.md` explicitly lists both as
 * supported Vitest auto-discovery suffixes.
 *
 * Exported for unit tests.
 */
export function isTestSurfacePath(relPath: string): boolean {
  if (relPath.includes('/__tests__/')) return true;
  if (relPath.startsWith('__tests__/')) return true;
  if (relPath.startsWith('evals/fixtures/')) return true;
  // Filename-suffix branch: any *.{test,spec}.{ts,tsx,js,jsx} at any path.
  if (/\.(test|spec)\.(ts|tsx|js|jsx)$/i.test(relPath)) return true;
  return false;
}

/**
 * Reject paths that try to escape the repo root or use absolute paths.
 * Defense-in-depth — paths come from `path.relative(rootDir, abs)` which
 * shouldn't produce these, but a future caller passing untrusted relPath
 * shouldn't be able to bypass the allowlist via path tricks.
 */
function isSafeRelPath(relPath: string): boolean {
  if (relPath.length === 0) return false;
  if (relPath.startsWith('/')) return false;
  if (relPath.includes('..')) return false;
  return true;
}

/**
 * True iff `relPath` (POSIX-style, repo-relative) matches the allowlist
 * entry. Match semantics:
 *
 *   - `file` entries match by **exact equality** only. No `endsWith`
 *     fallback: a file at `src/x/foo.ts` must NOT be admitted by an
 *     allowlist entry for `foo.ts`.
 *   - `directory` entries match by **prefix** (`relPath.startsWith(dir + '/')`).
 *     No `.includes('/' + dir)` fallback: a path of
 *     `src/x/evals/fixtures/safety-prompt/leak.ts` must NOT be admitted
 *     by an allowlist entry for `evals/fixtures/safety-prompt/`.
 *
 * Stage 5 Phase-6 finding (Gemini + tester proof-fixture). The previous
 * `endsWith` / `.includes` matchers were bypassable: a malicious
 * (or accidental) nested path could land tokens in a non-allowlisted
 * directory by mimicking an allowlisted suffix.
 */
function entryMatches(relPath: string, entry: AllowlistEntry): boolean {
  if (!isSafeRelPath(relPath)) return false;
  // Normalize entry.path: strip trailing slash, reject unsafe shapes.
  const norm = entry.path.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!isSafeRelPath(norm)) return false;
  if (entry.type === 'file') {
    return relPath === norm;
  }
  // directory: prefix match with trailing slash.
  return relPath.startsWith(norm + '/');
}

/** Return the allowlist entry that covers `relPath`, if any. */
function findMatchingEntry(
  relPath: string,
  allowlist: readonly AllowlistEntry[],
): AllowlistEntry | null {
  for (const entry of allowlist) {
    if (entryMatches(relPath, entry)) return entry;
  }
  return null;
}

/**
 * Recursively walk the configured scan roots and yield every regular file
 * path whose repo-relative path is a test surface (`isTestSurfacePath`)
 * AND whose extension is in `ALLOWED_EXTENSIONS`. Skips known
 * build/vendor directories and dotfiles.
 */
function listScanFiles(rootDir: string): string[] {
  const results: string[] = [];
  for (const project of SCAN_ROOTS) {
    const projectRoot = path.join(rootDir, project);
    if (!fs.existsSync(projectRoot)) continue;
    const stack: string[] = [projectRoot];
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) continue;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        if (SKIP_DIR_NAMES.has(entry.name)) continue;
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
          continue;
        }
        if (!entry.isFile()) continue;
        const ext = path.extname(entry.name).toLowerCase();
        if (!ALLOWED_EXTENSIONS.has(ext)) continue;
        const rel = toPosix(path.relative(rootDir, full));
        if (!isTestSurfacePath(rel)) continue;
        results.push(full);
      }
    }
  }
  return results;
}

/** Convert any platform path to POSIX style for cross-platform allowlist matching. */
function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/**
 * Filter out files that are .gitignore'd. Test fixtures generated locally
 * (e.g. `src/core/rebelCore/__tests__/sessionReplay/fixtures/`, gitignored
 * personal-data exports) must not be scanned — they're not committed,
 * not part of the project's test surface, and can carry realistic-shape
 * tokens by design.
 *
 * Uses `git check-ignore --stdin` for a single batched subprocess call
 * (one git invocation regardless of file count). Fail-open: if git is
 * unavailable or the call errors, we keep all files (the original
 * pre-2026-05-02 behavior). The drift check itself still fails closed
 * on any non-allowlisted hit, so fail-open here can't silently hide
 * drift in committed files.
 */
function filterGitignored(absolutePaths: string[], rootDir: string): string[] {
  if (absolutePaths.length === 0) return absolutePaths;
  const stdin = absolutePaths.join('\n') + '\n';
  // git-exec-allow: gitignore filter needs stdin and status semantics for batch check
  const res = spawnSync('git', ['check-ignore', '--stdin'], {
    cwd: rootDir,
    input: stdin,
    encoding: 'utf8',
  });
  // git check-ignore exits 0 when ignored paths are found, 1 when none are
  // ignored, and >1 on real errors. Treat >1 as fail-open.
  if (res.status === null || res.status > 1) {
    return absolutePaths;
  }
  const ignored = new Set(
    (res.stdout ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
  );
  if (ignored.size === 0) return absolutePaths;
  return absolutePaths.filter((p) => !ignored.has(p));
}

/** Pure source-string check (exported for unit tests). */
export function scanSourceForSkTokens(
  source: string,
  relPath: string,
  allowlist: readonly AllowlistEntry[],
): SkHit[] {
  const hits: SkHit[] = [];
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Reset lastIndex on the cached regex by constructing a fresh one
    // per line — avoids state leaking between calls.
    const re = new RegExp(SK_TOKEN_REGEX.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      const matched = m[0];
      // Strip the leading boundary character (if any) so the literal
      // we report starts at `sk-`.
      const literal = matched.startsWith('sk-') ? matched : matched.slice(1);
      hits.push({
        file: relPath,
        line: i + 1,
        literal,
        matchedEntry: findMatchingEntry(relPath, allowlist),
      });
    }
  }
  return hits;
}

/** Pure entry-point — exported for unit tests. */
export function runSkTokenDriftCheck(
  rootDir: string,
  allowlist: readonly AllowlistEntry[] = SK_TEST_TOKEN_ALLOWLIST,
): DriftCheckResult {
  const files = filterGitignored(listScanFiles(rootDir), rootDir);
  const drift: SkHit[] = [];
  const allowedHits: SkHit[] = [];
  const matchedEntryPaths = new Set<string>();
  let vanishedDuringScan = 0;

  for (const abs of files) {
    // ENOENT-vs-other discriminator lives in the canonical helper
    // (scripts/lib/safeScanRead.ts): a file that vanished mid-scan (concurrent
    // deletion / TOCTOU) returns null and is skipped + counted; a
    // present-but-unreadable file rethrows so we wrap it fail-closed below.
    let source: string | null;
    try {
      source = readFileToleratingVanished(abs);
    } catch (err) {
      // Present but unreadable (EACCES, EPERM, binary-decode issues, …): stay
      // fail-closed and surface the file path explicitly so the user can fix
      // the encoding/permissions or extend ALLOWED_EXTENSIONS / SKIP_DIR_NAMES.
      const rel = toPosix(path.relative(rootDir, abs));
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `sk-* drift check failed to read ${rel}: ${message}. ` +
          `If the file is binary or otherwise unreadable, narrow ALLOWED_EXTENSIONS ` +
          `or extend SKIP_DIR_NAMES in scripts/check-sk-test-token-drift.ts.`,
      );
    }
    if (source === null) {
      // Vanished between listing and read — cannot be committed drift.
      vanishedDuringScan += 1;
      continue;
    }
    if (!source.includes('sk-')) {
      // Cheap pre-filter: skip the regex pass if the file doesn't even
      // contain `sk-` as a substring.
      continue;
    }
    const rel = toPosix(path.relative(rootDir, abs));
    const fileHits = scanSourceForSkTokens(source, rel, allowlist);
    for (const hit of fileHits) {
      if (hit.matchedEntry) {
        allowedHits.push(hit);
        matchedEntryPaths.add(hit.matchedEntry.path);
      } else {
        drift.push(hit);
      }
    }
  }

  // Detect orphan allowlist entries (entries that matched zero files).
  // These are allowlist drift in the other direction: a renamed/deleted
  // file leaves a stale entry that hides nothing real and creates noise.
  const orphanedAllowlistEntries: AllowlistEntry[] = allowlist.filter(
    (e) => !matchedEntryPaths.has(e.path),
  );

  // `filesScanned` counts files discovered/attempted; `vanishedDuringScan`
  // is the subset skipped because they disappeared between listing and read.
  return {
    drift,
    allowedHits,
    orphanedAllowlistEntries,
    filesScanned: files.length,
    vanishedDuringScan,
  };
}

function main(): void {
  console.log('🔍 sk-* test-token drift check (260419 D1)');
  console.log('==========================================\n');

  const result = runSkTokenDriftCheck(ROOT);

  // `filesScanned` is the count of discovered/attempted test-surface files;
  // `vanishedDuringScan` is the subset that disappeared mid-scan (skipped).
  console.log(
    `Scanned ${result.filesScanned} test-surface file(s); found ` +
      `${result.allowedHits.length} allowed hit(s) and ${result.drift.length} drift hit(s).`,
  );

  if (result.vanishedDuringScan > 0) {
    // Informational only — does NOT affect the exit code. A vanished file
    // cannot be committed drift, so skipping it is correct; we surface the
    // count so the skip is observable rather than silent.
    console.log(
      `ℹ️  ${result.vanishedDuringScan} file(s) vanished mid-scan (concurrent deletion); skipped — not drift.`,
    );
  }

  if (result.orphanedAllowlistEntries.length > 0) {
    console.error('');
    console.error(
      `❌ ${result.orphanedAllowlistEntries.length} orphaned allowlist entry/entries (no matching source file):`,
    );
    for (const e of result.orphanedAllowlistEntries) {
      console.error(`   ${e.type}: ${e.path}  — ${e.rationale}`);
    }
    console.error('');
    console.error('   An entry was added but the file/directory it points at is missing.');
    console.error('   Either restore the source path or remove the stale allowlist entry.');
  }

  if (result.drift.length > 0) {
    console.error('');
    console.error(`❌ ${result.drift.length} sk-* token drift hit(s):`);
    for (const hit of result.drift) {
      console.error(`   ${hit.file}:${hit.line}  literal: ${hit.literal}`);
    }
    console.error('');
    console.error(
      '   Replace each literal with a neutral token (e.g. `fake-...`, `synth-...`),',
    );
    console.error(
      '   OR add a justified entry to scripts/sk-test-token-allowlist.ts if the',
    );
    console.error(
      '   sk- prefix is genuinely the contract under test (e.g. redaction tests,',
    );
    console.error(
      '   prefix-validation tests, eval fixtures with realistic credentials).',
    );
    console.error('');
    console.error(
      '   See: docs-private/postmortems/260419_prepush_live_api_integration_test_404_postmortem.md',
    );
  }

  if (result.drift.length > 0 || result.orphanedAllowlistEntries.length > 0) {
    process.exit(1);
  }

  console.log('PASS — every sk-* literal lands in the documented allowlist.');
  process.exit(0);
}

const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main();
}
