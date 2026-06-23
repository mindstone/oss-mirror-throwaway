#!/usr/bin/env npx tsx
/**
 * CI guard: no `will-quit` listener in src/main/** may call `preventDefault`
 * except bootstrap.ts's outbox-drain handler.
 *
 * Why: the fsevents leak-sweep backstop (src/main/services/finalExit.ts,
 * 260611 quit-SIGABRT fix) is a late-registered `will-quit` listener that
 * no-ops when `event.defaultPrevented` is true — a prevented will-quit is a
 * CANCELLED quit and sweeping it would silently dead-watcher a live app.
 * That protection only covers preventDefaulters that run BEFORE the backstop.
 * A future will-quit listener registered after app-ready (lazily-loaded
 * service, dialog-confirm pattern copied from the before-quit guards) would
 * run AFTER the backstop: the backstop sweeps, the later listener cancels the
 * quit, and the app lives on with dead watchers + one-way quit mode — the
 * worst failure shape in the plan's Failure Mode Matrix. Registration order
 * is not expressible in types, so this guard forbids the pattern statically
 * (RS stage-2 review F2; the runtime nextTick-deferral alternative was
 * explicitly rejected — Electron's emit/drain ordering there is not
 * guaranteed by anything we control).
 *
 * Quit-cancellation belongs on `before-quit` (which suppresses will-quit
 * entirely and therefore can never produce the swept-then-cancelled state) —
 * see cloudProvisioningQuitGuard.ts for the sanctioned pattern.
 *
 * Mirrors the sibling `scripts/check-*-chokepoint.ts` guards: file-scoped,
 * raw-text, low-FP, allowlist-with-evidence + stale-entry detection.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = process.cwd();
const SCAN_ROOT = path.join('src', 'main');

/**
 * Files allowed to preventDefault inside a will-quit listener. Every entry
 * carries its evidence; the guard reds on stale entries.
 */
export const ALLOWLISTED_WILL_QUIT_PREVENTERS: ReadonlyMap<string, string> = new Map([
  [
    'src/main/bootstrap.ts',
    'the upload-outbox drain handler: registered at bootstrap module-eval time, which is provably ' +
      'BEFORE the finalExit backstop (registered in whenReady) — the backstop observes its ' +
      'preventDefault via event.defaultPrevented and correctly skips the sweep',
  ],
]);

/** Registration forms that attach a will-quit listener. */
const WILL_QUIT_REGISTRATION_PATTERN =
  /\b(?:on|once|addListener|prependListener|prependOnceListener|onElectronAppEvent)\s*\(\s*['"`]will-quit['"`]/g;

export interface WillQuitPreventDefaultViolation {
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
 * Extract the CODE-ONLY text of the registration call starting at the given
 * match index: walks from the call's opening `(` to its balanced closing `)`,
 * skipping string literals (incl. template literals) and comments — both for
 * paren balancing AND for the returned text, so a `preventDefault` mention in
 * a comment or log string can never false-positive. If the call never
 * balances, returns everything to EOF (fail-closed toward inspecting MORE
 * text, never less).
 */
export function extractRegistrationCallSpan(source: string, matchIndex: number): string {
  const openParen = source.indexOf('(', matchIndex);
  if (openParen === -1) {
    return source.slice(matchIndex);
  }

  let depth = 0;
  let i = openParen;
  type Mode = 'code' | 'line-comment' | 'block-comment' | 'single' | 'double' | 'template';
  let mode: Mode = 'code';
  let codeOnly = source.slice(matchIndex, openParen);

  while (i < source.length) {
    const ch = source[i]!;
    const next = source[i + 1];

    switch (mode) {
      case 'code':
        if (ch === '/' && next === '/') {
          mode = 'line-comment';
          i += 1;
        } else if (ch === '/' && next === '*') {
          mode = 'block-comment';
          i += 1;
        } else if (ch === "'") {
          mode = 'single';
        } else if (ch === '"') {
          mode = 'double';
        } else if (ch === '`') {
          mode = 'template';
        } else if (ch === '(') {
          codeOnly += ch;
          depth += 1;
        } else if (ch === ')') {
          codeOnly += ch;
          depth -= 1;
          if (depth === 0) {
            return codeOnly;
          }
        } else {
          codeOnly += ch;
        }
        break;
      case 'line-comment':
        if (ch === '\n') {
          mode = 'code';
          codeOnly += ch;
        }
        break;
      case 'block-comment':
        if (ch === '*' && next === '/') {
          mode = 'code';
          i += 1;
        }
        break;
      case 'single':
        if (ch === '\\') i += 1;
        else if (ch === "'") mode = 'code';
        break;
      case 'double':
        if (ch === '\\') i += 1;
        else if (ch === '"') mode = 'code';
        break;
      case 'template':
        if (ch === '\\') i += 1;
        else if (ch === '`') mode = 'code';
        // ${…} interpolations: treated as opaque text — for a guard this is
        // the conservative simplification; an interpolation's parens can only
        // widen the span (never truncate it), see fail-closed note above.
        break;
    }
    i += 1;
  }

  return codeOnly;
}

function isTestPath(relativePosixPath: string): boolean {
  return (
    relativePosixPath.includes('/__tests__/') ||
    relativePosixPath.endsWith('.test.ts') ||
    relativePosixPath.endsWith('.test.tsx')
  );
}

export function checkWillQuitPreventDefaultChokepoint(
  files: readonly ScannedFile[],
): WillQuitPreventDefaultViolation[] {
  const violations: WillQuitPreventDefaultViolation[] = [];
  const seenAllowlisted = new Set<string>();

  for (const file of files) {
    const displayPath = toPosix(file.relativePath);
    if (isTestPath(displayPath)) {
      continue;
    }

    WILL_QUIT_REGISTRATION_PATTERN.lastIndex = 0;
    for (
      let match = WILL_QUIT_REGISTRATION_PATTERN.exec(file.source);
      match !== null;
      match = WILL_QUIT_REGISTRATION_PATTERN.exec(file.source)
    ) {
      const span = extractRegistrationCallSpan(file.source, match.index);
      if (!/\bpreventDefault\b/.test(span)) {
        continue;
      }
      if (ALLOWLISTED_WILL_QUIT_PREVENTERS.has(displayPath)) {
        seenAllowlisted.add(displayPath);
        continue;
      }
      violations.push({
        relativePath: displayPath,
        message:
          `${displayPath} calls preventDefault inside a will-quit listener. The fsevents leak-sweep ` +
          'backstop (src/main/services/finalExit.ts) only honours cancellations from listeners that ' +
          'run BEFORE it — a later preventDefault leaves a live app with force-stopped watchers. ' +
          'Cancel quits from a before-quit handler instead (it suppresses will-quit entirely; see ' +
          'cloudProvisioningQuitGuard.ts), or add an allowlist entry in ' +
          'scripts/check-will-quit-preventdefault-chokepoint.ts with evidence that the listener ' +
          'provably registers before the backstop.',
      });
    }
  }

  for (const allowlisted of ALLOWLISTED_WILL_QUIT_PREVENTERS.keys()) {
    const scanned = files.some((file) => toPosix(file.relativePath) === allowlisted);
    if (scanned && !seenAllowlisted.has(allowlisted)) {
      violations.push({
        relativePath: allowlisted,
        message:
          `${allowlisted} is allowlisted but no longer contains a preventDefault-ing will-quit ` +
          'listener — remove the stale entry from scripts/check-will-quit-preventdefault-chokepoint.ts.',
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
  console.error(`\n✗ check-will-quit-preventdefault-chokepoint: ${message}\n`);
  process.exit(1);
}

export function main(): void {
  const scanRootAbs = path.join(REPO_ROOT, SCAN_ROOT);
  if (!fs.existsSync(scanRootAbs)) {
    fail(`scan root not found at ${SCAN_ROOT} — run from the repo root.`);
  }

  const absFiles: string[] = [];
  collectTsFiles(scanRootAbs, absFiles);
  const files: ScannedFile[] = absFiles.map((absPath) => ({
    relativePath: path.relative(REPO_ROOT, absPath),
    source: fs.readFileSync(absPath, 'utf8'),
  }));

  const violations = checkWillQuitPreventDefaultChokepoint(files);
  if (violations.length > 0) {
    fail(
      `${violations.length} will-quit preventDefault violation(s):\n` +
        violations.map((violation) => `- ${violation.message}`).join('\n'),
    );
  }

  console.log(
    `✓ check-will-quit-preventdefault-chokepoint: ${files.length} src/main files scanned; only the ` +
      'allowlisted bootstrap drain handler cancels will-quit.',
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
