/**
 * Source-order + import-purity guard for the NODE_PATH shim.
 *
 * Regression context (docs/plans/260623_fsevents-interception-regression/PLAN.md):
 * chokidar is BUNDLED into the main asar while `fsevents` is externalized.
 * chokidar's `fsevents-handler.js` runs an eager `require('fsevents')` during
 * the rollup module-hoist phase. The `initNodePath` shim prepends
 * `app.asar.unpacked/node_modules` to NODE_PATH so that hoisted require can
 * resolve the unpacked native `fsevents`. If a future import is inserted ahead
 * of `./startup/initNodePath` and transitively pulls chokidar, the hoisted
 * `require('fsevents')` fires with `NODE_PATH=undefined`, throws
 * `Cannot find module 'fsevents'`, and chokidar permanently memoizes
 * `fsevents=undefined` → falls off the native backend (degraded / CPU-heavy
 * `fs.watchFile` polling on macOS) AND disarms the quit-time fsevents leak
 * guard (it then tracks 0 native instances → SIGABRT / quit-deadlock returns).
 * That regression is telemetry-blind and CI does not run the packaged
 * boot-smoke gate, so this cheap source-parse test is the prevention net.
 *
 * Two invariants pinned here:
 *   1. The first three side-effect imports of `src/main/bootstrap.ts` are
 *      exactly `./startup/applyThreadpoolSize`, `./startup/installGracefulFs`,
 *      `./startup/initNodePath` in that order, and NO import statement sits
 *      between `installGracefulFs` and `initNodePath`.
 *   2. `src/main/startup/initNodePath.ts` has NO static `import` statements
 *      (it must use only call-time `require` of node builtins) — so it can
 *      never transitively pull chokidar into the hoist phase ahead of itself.
 *
 * See docs/plans/260623_fsevents-interception-regression/PLAN.md (Stage 3) and
 * docs/plans/260611_fsevents-shutdown-crash/PLAN.md.
 */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const BOOTSTRAP_PATH = path.join(REPO_ROOT, 'src', 'main', 'bootstrap.ts');
const INIT_NODE_PATH_PATH = path.join(REPO_ROOT, 'src', 'main', 'startup', 'initNodePath.ts');

// The exact, ordered head of bootstrap.ts's side-effect import block. These
// three MUST be first and in this order — applyThreadpoolSize (libuv pool
// buffer before any async op), installGracefulFs (first fs touch), then
// initNodePath (NODE_PATH shim ahead of any chokidar import). See header.
const REQUIRED_HEAD_IMPORTS = [
  './startup/applyThreadpoolSize',
  './startup/installGracefulFs',
  './startup/initNodePath',
] as const;

describe('initNodePath bootstrap source-order guard', () => {
  it('keeps initNodePath as the third import, right after installGracefulFs with nothing between', () => {
    const source = fs.readFileSync(BOOTSTRAP_PATH, 'utf8');
    const imports = findImportSpecifiers(source);

    expect(imports.length, 'no import statements found in bootstrap.ts').toBeGreaterThanOrEqual(3);

    // The first three imports must be exactly the required head, in order.
    expect(imports.slice(0, 3)).toEqual([...REQUIRED_HEAD_IMPORTS]);

    // Defensive restatement: nothing sits between installGracefulFs and
    // initNodePath (adjacency). A future import inserted between them would
    // run its module body — and any chokidar pull — before the shim. The
    // slice check above already enforces this, but assert the gap explicitly
    // so a failure message points at the exact regression vector.
    const gracefulFsIdx = imports.indexOf('./startup/installGracefulFs');
    const initNodePathIdx = imports.indexOf('./startup/initNodePath');
    expect(gracefulFsIdx, 'installGracefulFs import not found in bootstrap.ts').toBeGreaterThanOrEqual(0);
    expect(initNodePathIdx, 'initNodePath import not found in bootstrap.ts').toBeGreaterThanOrEqual(0);
    expect(
      initNodePathIdx,
      'an import was inserted between installGracefulFs and initNodePath — the NODE_PATH shim must run before any chokidar pull (see header)',
    ).toBe(gracefulFsIdx + 1);
  });

  it('has no static import statements in initNodePath.ts (call-time require only)', () => {
    const source = fs.readFileSync(INIT_NODE_PATH_PATH, 'utf8');
    const imports = findImportSpecifiers(source);
    expect(
      imports,
      `initNodePath.ts must use only call-time require() of node builtins, never static imports (found: ${imports.join(', ')}); a static import could transitively pull chokidar into the hoist phase ahead of the shim`,
    ).toEqual([]);
  });
});

/**
 * Return the module specifiers of every top-level `import` statement in source
 * order, skipping line/block comments. Matches both side-effect imports
 * (`import './x'`) and named/default/namespace imports (`import X from './x'`,
 * `import type { Y } from './x'`).
 *
 * Comment-aware so the long header comment blocks (which mention `import`
 * inside prose) don't produce false matches.
 */
function findImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  let i = 0;
  const len = source.length;

  while (i < len) {
    const ch = source[i] ?? '';

    // Line comment.
    if (ch === '/' && source[i + 1] === '/') {
      const eol = source.indexOf('\n', i);
      i = eol === -1 ? len : eol + 1;
      continue;
    }

    // Block comment.
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? len : end + 2;
      continue;
    }

    // Try to match an import statement at the start of a line (after
    // whitespace). Only consider `import` when it begins a token at the
    // current position to avoid matching `import` inside identifiers/strings.
    if (
      source.startsWith('import', i)
      && (i === 0 || /\s/.test(source[i - 1] ?? ''))
      && !/[A-Za-z0-9_$]/.test(source[i + 'import'.length] ?? '')
    ) {
      const rest = source.substring(i);
      const sideEffect = /^import\s+['"]([^'"]+)['"]/.exec(rest);
      if (sideEffect?.[1]) {
        specifiers.push(sideEffect[1]);
        i += sideEffect[0].length;
        continue;
      }
      const named = /^import\s+(?:type\s+)?[^'"]*?\s+from\s+['"]([^'"]+)['"]/.exec(rest);
      if (named?.[1]) {
        specifiers.push(named[1]);
        i += named[0].length;
        continue;
      }
    }

    i += 1;
  }

  return specifiers;
}
