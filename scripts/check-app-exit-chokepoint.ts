#!/usr/bin/env npx tsx
/**
 * CI guard: every hard process exit in the main process must go through the
 * final-exit primitive `immediateExitWithFseventsSweep()` in
 * `src/main/services/finalExit.ts`.
 *
 * Why: on Electron 39 (Node 22.x) a leaked fsevents native instance at env
 * teardown SIGABRTs in the fsevents finalizer (quit-time crash dialog class —
 * docs/plans/260611_fsevents-shutdown-crash/PLAN.md). `app.exit()` runs that
 * teardown AND emits no lifecycle events, so a bare `app.exit(` call site is
 * an unswept exit that no will-quit listener can cover. The primitive sweeps
 * leaked instances immediately before exiting; this guard makes "every exit
 * is swept" hold by construction instead of by audit (the two prior per-path
 * fixes — cc8e149e9, fa8f756b7 — were both escaped by an unaudited path).
 *
 * Allowlisted files are classified pre-watcher exits: they run from bootstrap
 * BEFORE `installFseventsLeakGuard()` and before any chokidar consumer loads,
 * so zero fsevents instances can exist when they fire. Each entry carries its
 * evidence; the guard also reds on STALE allowlist entries (file no longer
 * contains `app.exit(`) so the list cannot rot.
 *
 * `process.exit(` sites are deliberately NOT covered: plain-Node process.exit
 * skips handle teardown (spike `generated/spike_exit_latency.md` variant F),
 * so it cannot reach the fsevents finalizer.
 *
 * Mirrors the sibling `scripts/check-*-chokepoint.ts` guards: file-scoped,
 * raw-text, low-FP.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = process.cwd();
const SCAN_ROOT = path.join('src', 'main');

/** The only module allowed to call `app.exit()` — the final-exit primitive. */
export const PRIMITIVE_MODULE = 'src/main/services/finalExit.ts';

/**
 * Classified bare `app.exit(` sites. Every entry must carry the evidence for
 * why an unswept exit is safe there. Adding to this list requires the same
 * justification: the file must be unreachable after any fsevents instance can
 * have started.
 */
export const ALLOWLISTED_BARE_EXIT_FILES: ReadonlyMap<string, string> = new Map([
  [
    'src/main/startup/singleInstanceLock.ts',
    'pre-watcher: runs at bootstrap module scope (bootstrap.ts acquireSingleInstanceLock()) BEFORE ' +
      'installFseventsLeakGuard() and before index.ts (the only chokidar-consumer importer) loads — ' +
      'zero fsevents instances can exist when these lock-contention exits fire',
  ],
  [
    'src/main/startup/ensureArchitectureMatch.ts',
    'pre-watcher: Rosetta-mismatch exit runs at bootstrap module scope before the leak guard installs ' +
      'and before any watcher service is importable — zero fsevents instances can exist',
  ],
]);

// Catches `app.exit(`, `electron.app.exit(`, `electron?.app.exit(`,
// `app?.exit(`, `App.exit(` — anything that ends in an (optionally-chained)
// `.exit(` off an `app`/`App` receiver.
const APP_EXIT_PATTERN = /\b[aA]pp\s*\??\.\s*exit\s*\(/;

export interface AppExitChokepointViolation {
  readonly relativePath: string;
  readonly message: string;
}

export interface ScannedFile {
  readonly relativePath: string;
  readonly source: string;
}

function toPosix(relativePath: string): string {
  return relativePath.split(path.sep).join('/');
}

/**
 * Light comment stripper so doc comments mentioning `app.exit(` don't trip
 * the guard. Line-based: tracks block comments across lines, drops `//` tails.
 * Deliberately naive about string literals (a `//` inside a string truncates
 * the rest of that line) — acceptable for a raw-text guard; it can only ever
 * under-report on the same line as a URL-bearing string, never false-red.
 */
export function stripComments(source: string): string {
  const out: string[] = [];
  let inBlockComment = false;
  for (const line of source.split('\n')) {
    let rest = line;
    let kept = '';
    while (rest.length > 0) {
      if (inBlockComment) {
        const end = rest.indexOf('*/');
        if (end === -1) {
          rest = '';
        } else {
          rest = rest.slice(end + 2);
          inBlockComment = false;
        }
        continue;
      }
      const lineComment = rest.indexOf('//');
      const blockComment = rest.indexOf('/*');
      if (lineComment !== -1 && (blockComment === -1 || lineComment < blockComment)) {
        kept += rest.slice(0, lineComment);
        rest = '';
        continue;
      }
      if (blockComment !== -1) {
        kept += rest.slice(0, blockComment);
        rest = rest.slice(blockComment + 2);
        inBlockComment = true;
        continue;
      }
      kept += rest;
      rest = '';
    }
    out.push(kept);
  }
  return out.join('\n');
}

function isTestPath(relativePosixPath: string): boolean {
  return (
    relativePosixPath.includes('/__tests__/') ||
    relativePosixPath.endsWith('.test.ts') ||
    relativePosixPath.endsWith('.test.tsx')
  );
}

export function checkAppExitChokepoint(files: readonly ScannedFile[]): AppExitChokepointViolation[] {
  const violations: AppExitChokepointViolation[] = [];
  const seenAllowlisted = new Set<string>();

  for (const file of files) {
    const displayPath = toPosix(file.relativePath);
    if (isTestPath(displayPath)) {
      continue;
    }
    const hasAppExit = APP_EXIT_PATTERN.test(stripComments(file.source));
    if (!hasAppExit) {
      continue;
    }
    if (displayPath === PRIMITIVE_MODULE) {
      continue;
    }
    if (ALLOWLISTED_BARE_EXIT_FILES.has(displayPath)) {
      seenAllowlisted.add(displayPath);
      continue;
    }
    violations.push({
      relativePath: displayPath,
      message:
        `${displayPath} calls app.exit() directly. Point-of-no-return exits must go through ` +
        `immediateExitWithFseventsSweep() (${PRIMITIVE_MODULE}) so leaked fsevents instances are ` +
        'swept before env teardown (quit-time SIGABRT class). If this site provably runs before ' +
        'any watcher can start, add it to the allowlist in scripts/check-app-exit-chokepoint.ts ' +
        'with the evidence.',
    });
  }

  // Stale-allowlist detection: an entry whose file no longer bare-calls
  // app.exit() must be removed so the allowlist stays an honest inventory.
  for (const allowlisted of ALLOWLISTED_BARE_EXIT_FILES.keys()) {
    const scanned = files.some((file) => toPosix(file.relativePath) === allowlisted);
    if (scanned && !seenAllowlisted.has(allowlisted)) {
      violations.push({
        relativePath: allowlisted,
        message:
          `${allowlisted} is allowlisted but no longer contains a bare app.exit( call — remove the ` +
          'stale entry from scripts/check-app-exit-chokepoint.ts.',
      });
    }
  }

  return violations;
}

function collectTsFiles(absDir: string, out: string[]): void {
  for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
    const absPath = path.join(absDir, entry.name);
    if (entry.isDirectory()) {
      collectTsFiles(absPath, out);
      continue;
    }
    if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
      out.push(absPath);
    }
  }
}

function fail(message: string): never {
  console.error(`\n✗ check-app-exit-chokepoint: ${message}\n`);
  process.exit(1);
}

export function main(): void {
  const scanRootAbs = path.join(REPO_ROOT, SCAN_ROOT);
  if (!fs.existsSync(scanRootAbs)) {
    fail(`scan root not found at ${SCAN_ROOT} — run from the repo root.`);
  }
  if (!fs.existsSync(path.join(REPO_ROOT, PRIMITIVE_MODULE))) {
    fail(`final-exit primitive not found at ${PRIMITIVE_MODULE} — update this guard if it moved.`);
  }

  const absFiles: string[] = [];
  collectTsFiles(scanRootAbs, absFiles);
  const files: ScannedFile[] = absFiles.map((absPath) => ({
    relativePath: path.relative(REPO_ROOT, absPath),
    source: fs.readFileSync(absPath, 'utf8'),
  }));

  const violations = checkAppExitChokepoint(files);
  if (violations.length > 0) {
    fail(
      `${violations.length} app.exit chokepoint violation(s):\n` +
        violations.map((violation) => `- ${violation.message}`).join('\n'),
    );
  }

  console.log(
    `✓ check-app-exit-chokepoint: ${files.length} src/main files scanned; all app.exit() calls go ` +
      'through the final-exit primitive or the classified pre-watcher allowlist.',
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
