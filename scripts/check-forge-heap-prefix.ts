#!/usr/bin/env npx tsx
/**
 * CI Validation: electron-forge package/make scripts must launch the Forge
 * parent process with an 8 GB Node heap.
 *
 * Why this guard exists
 * ---------------------
 * Postmortem `260519_electron_forge_postpackage_heap_cap`: `npm run package`
 * OOM-ed in Forge's `postPackage` hook because the heap bump was applied
 * *inside* `forge.config.cjs` (after Forge's own V8 process had already
 * started) rather than on the parent process at launch. Setting
 * `NODE_OPTIONS` from config is too late for the process that runs the hook.
 * The fix put `NODE_OPTIONS=--max-old-space-size=8192` on every `electron-forge
 * package|make` npm script, but nothing prevents the next such script (or an
 * edit dropping the prefix) from regressing the same class.
 *
 * What it enforces
 * ----------------
 * Every package.json script whose command invokes `electron-forge package` or
 * `electron-forge make` must, BEFORE the `electron-forge` token on the same
 * command, either:
 *   - assign `NODE_OPTIONS` to a value containing `--max-old-space-size=N` with
 *     N >= MIN_HEAP_MB (via `cross-env NODE_OPTIONS=...` or a shell
 *     `NODE_OPTIONS=...` assignment), OR
 *   - route Forge through an approved heap wrapper (APPROVED_WRAPPERS).
 *
 * `electron-forge start` (the dev path) is intentionally NOT covered — dev does
 * not run the memory-heavy package/make hooks.
 *
 * Run: npx tsx scripts/check-forge-heap-prefix.ts
 * Wired into: npm run validate:fast (validate:forge-heap-prefix)
 */

import * as fs from 'fs';
import * as path from 'path';

/** Minimum acceptable --max-old-space-size in MB (the canonical 8 GB bump). */
export const MIN_HEAP_MB = 8192;

/**
 * Approved alternative to an inline NODE_OPTIONS prefix: a wrapper script that
 * owns parent-process heap ownership itself (e.g. the electron-vite heap-bump
 * helper). Token-substring match against the command. Keep tiny + explicit.
 */
export const APPROVED_WRAPPERS: readonly string[] = [
  'scripts/run-electron-forge-with-heap-bump.ts',
];

export interface ForgeHeapViolation {
  readonly script: string;
  readonly command: string;
  readonly reason: string;
}

/** Matches `electron-forge package` / `electron-forge make` (NOT `start`). */
const FORGE_PACKAGE_OR_MAKE = /\belectron-forge\s+(package|make)\b/;

/**
 * Extract a --max-old-space-size value (MB) from a NODE_OPTIONS assignment that
 * appears in `segment`, or null if absent. Handles both `NODE_OPTIONS=...` and
 * `cross-env NODE_OPTIONS=...` (cross-env just passes the assignment through).
 * The value may be quoted or unquoted and may contain other flags.
 */
export function extractHeapMb(segment: string): number | null {
  // Find NODE_OPTIONS=<value> where <value> runs to the next whitespace that is
  // not inside quotes. We keep it simple: capture up to the next unquoted space.
  // The leading boundary (start-of-string or whitespace) ensures we match the
  // exact env var, not a suffix like OLD_NODE_OPTIONS=... (false negative).
  const assignMatch = segment.match(/(?:^|\s)NODE_OPTIONS\s*=\s*("([^"]*)"|'([^']*)'|(\S+))/);
  if (!assignMatch) return null;
  const value = assignMatch[2] ?? assignMatch[3] ?? assignMatch[4] ?? '';
  const heapMatch = value.match(/--max-old-space-size=(\d+)/);
  if (!heapMatch) return null;
  return Number.parseInt(heapMatch[1], 10);
}

/**
 * Evaluate a single package.json script command. Returns a violation reason if
 * it invokes `electron-forge package|make` without an adequate heap guard on
 * the Forge parent, else null.
 *
 * The heap prefix / wrapper must appear BEFORE the electron-forge token in the
 * SAME `&&`-joined segment that runs Forge (so a heap bump on an earlier,
 * unrelated `&&` step does not count). npm-script chains (`npm run X && ...`)
 * are evaluated per-segment; a `npm run prebuild` segment is irrelevant.
 */
export function evaluateScriptCommand(command: string): string | null {
  // Split on shell sequencing/pipe operators so a heap bump on a different
  // command in the chain (incl. the left side of a pipe) does not satisfy the
  // Forge segment. Single `|` is included: `... echo x | electron-forge make`
  // must not borrow the heap prefix from the piped-from command.
  const segments = command.split(/&&|\|\||;|\|/);
  for (const segment of segments) {
    const forgeMatch = FORGE_PACKAGE_OR_MAKE.exec(segment);
    if (!forgeMatch) continue;

    // Only consider the portion of the segment BEFORE the electron-forge token —
    // the prefix must be set on the parent at launch, not after.
    const beforeForge = segment.slice(0, forgeMatch.index);

    if (APPROVED_WRAPPERS.some((w) => segment.includes(w))) {
      // A wrapper that owns Forge launch is acceptable even without an inline
      // NODE_OPTIONS prefix (the wrapper sets the heap itself).
      continue;
    }

    const heapMb = extractHeapMb(beforeForge);
    if (heapMb === null) {
      return `invokes "electron-forge ${forgeMatch[1]}" without a NODE_OPTIONS=--max-old-space-size prefix before the electron-forge token`;
    }
    if (heapMb < MIN_HEAP_MB) {
      return `invokes "electron-forge ${forgeMatch[1]}" with --max-old-space-size=${heapMb} (below the required ${MIN_HEAP_MB} MB Forge-parent heap)`;
    }
  }
  return null;
}

/** Scan a package.json `scripts` map and collect violations. */
export function findForgeHeapViolations(
  scripts: Readonly<Record<string, string>>,
): ForgeHeapViolation[] {
  const violations: ForgeHeapViolation[] = [];
  for (const [scriptName, command] of Object.entries(scripts)) {
    const reason = evaluateScriptCommand(command);
    if (reason) {
      violations.push({ script: scriptName, command, reason });
    }
  }
  return violations;
}

function main(): void {
  const root = path.resolve(__dirname, '..');
  const pkgPath = path.join(root, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
    scripts?: Record<string, string>;
  };
  const scripts = pkg.scripts ?? {};

  const violations = findForgeHeapViolations(scripts);
  if (violations.length === 0) {
    console.log(
      `✅ check-forge-heap-prefix: all electron-forge package/make scripts launch the Forge parent with a >= ${MIN_HEAP_MB} MB heap.`,
    );
    return;
  }

  console.error(
    `\n❌ check-forge-heap-prefix: ${violations.length} electron-forge package/make script(s) lack the required Forge-parent heap bump.\n` +
      `\n   Postmortem 260519_electron_forge_postpackage_heap_cap: the Forge postPackage hook OOMs unless\n` +
      `   NODE_OPTIONS=--max-old-space-size=${MIN_HEAP_MB} is set on the Forge PARENT process at launch (setting it\n` +
      `   inside forge.config.cjs is too late). Prefix the script with\n` +
      `   "cross-env NODE_OPTIONS=--max-old-space-size=${MIN_HEAP_MB}" before the electron-forge token, or route\n` +
      `   Forge through an approved wrapper (${APPROVED_WRAPPERS.join(', ')}).\n`,
  );
  for (const v of violations) {
    console.error(`   - script "${v.script}": ${v.reason}\n     command: ${v.command}`);
  }
  console.error('');
  process.exit(1);
}

// Only run when invoked directly (not when imported by tests).
const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(__filename);
if (invokedDirectly) {
  main();
}
