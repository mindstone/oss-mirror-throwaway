/**
 * Smoke tests for the graceful-fs boot-time install.
 *
 * Three tests:
 *   1. Subprocess EMFILE injection on callback `fs.open` — proves graceful-fs
 *      patched the fs module and queues+retries EMFILE callbacks.
 *   2. `fs/promises` reality check — documents whether named imports of
 *      `node:fs/promises` get patched (graceful-fs 4.2.11 does NOT patch
 *      promise APIs; this test pins that behaviour so a future runtime
 *      change shows up as a test failure).
 *   3. Source-order guard — asserts the leaf module is the first non-comment
 *      import of `src/main/bootstrap.ts`, so no later refactor accidentally
 *      moves it below an fs-touching import.
 *
 * See docs/plans/260428_graceful_fs_emfile_fix.md Stage 1.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const BOOTSTRAP_PATH = path.join(REPO_ROOT, 'src', 'main', 'bootstrap.ts');
const DESKTOP_INSTALL_LEAF_PATH = path.join(REPO_ROOT, 'src', 'main', 'startup', 'installGracefulFs.ts');

/**
 * Run a script in a fresh Node subprocess so we don't pollute Vitest's fs.
 * Returns stdout/stderr/exit code. Provides the repo's package.json absolute
 * path as `process.argv[2]` so tests can open a known real file (subprocesses
 * launched via `node -e` have `__filename === '[eval]'`).
 */
function runInSubprocess(script: string): { stdout: string; stderr: string; status: number | null } {
  const targetFile = path.join(REPO_ROOT, 'package.json');
  const result = spawnSync(process.execPath, ['-e', script, '--', targetFile], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 30000,
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status,
  };
}

describe('installGracefulFs', () => {
  // ─── Test 1: callback EMFILE retry ───────────────────────────────────────
  it('queues+retries callback fs.open EMFILE errors after gracefulify', () => {
    // Stub fs.open to throw EMFILE on the first 2 callback invocations, then
    // delegate to the real impl. After gracefulify is applied, graceful-fs
    // should detect the EMFILE, queue the call, and retry until success.
    //
    // Note: graceful-fs uses fs.close to drain the queue. We trigger a real
    // fs.close by calling fs.openSync/fs.closeSync to ensure the queue runs.
    const script = `
      const fs = require('node:fs');
      const TARGET = process.argv[1];
      const realOpen = fs.open.bind(fs);
      let callCount = 0;
      // Replace BEFORE gracefulify so graceful-fs wraps our stub.
      fs.open = function patchedOpen(...args) {
        const cb = args[args.length - 1];
        callCount += 1;
        if (callCount <= 2) {
          // Synchronous error delivery via setImmediate matches Node's
          // callback semantics.
          const err = Object.assign(new Error('mock EMFILE'), { code: 'EMFILE' });
          setImmediate(() => cb(err));
          return;
        }
        return realOpen(...args);
      };

      // Apply gracefulify — same call as the leaf module.
      const gfs = require('graceful-fs');
      gfs.gracefulify(fs);

      // Trigger a real fs.close to drain the queue (graceful-fs retries
      // when any close completes). We open + close TARGET using the
      // synchronous APIs (which graceful-fs does not patch) to make sure
      // a close happens.
      const handle = fs.openSync(TARGET, 'r');
      fs.closeSync(handle);

      // Now exercise the patched callback fs.open.
      fs.open(TARGET, 'r', (err, fd) => {
        if (err) {
          process.stderr.write('FAIL: ' + err.code + '\\n');
          process.exit(1);
        }
        if (callCount < 3) {
          process.stderr.write('FAIL: only ' + callCount + ' attempts\\n');
          process.exit(1);
        }
        fs.close(fd, () => {
          process.stdout.write('OK callCount=' + callCount + '\\n');
        });
      });
    `;

    const result = runInSubprocess(script);
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    expect(result.stdout).toMatch(/^OK callCount=3/);
  });

  // ─── Test 2: fs/promises reality check ────────────────────────────────────
  // Documents whether graceful-fs's gracefulify patches the
  // node:fs/promises named-import surface. Per the planning doc Failure Mode
  // Matrix #1 / Assumption A3, graceful-fs 4.2.11 does NOT patch
  // node:fs/promises — only the callback fs APIs. This test pins that
  // observed behaviour so any runtime regression in graceful-fs shows up.
  it('documents fs/promises retry behaviour (the named-import surface)', () => {
    const script = `
      const fs = require('node:fs');
      const fsp = require('node:fs/promises');
      const TARGET = process.argv[1];

      // Stub fs.open to throw EMFILE on every callback invocation.
      // (We expect graceful-fs to patch fs.open, but NOT the promise API.)
      fs.open = function patchedOpen(...args) {
        const cb = args[args.length - 1];
        const err = Object.assign(new Error('mock EMFILE'), { code: 'EMFILE' });
        setImmediate(() => cb(err));
      };

      const gfs = require('graceful-fs');
      gfs.gracefulify(fs);

      // We give the call a 1.5s budget. If graceful-fs DID patch the
      // promise surface, fsp.open would route through the patched
      // fs.open (which we've made fail forever) and time out. If it did
      // NOT, fsp.open uses its own internal path and resolves quickly.
      Promise.race([
        fsp.open(TARGET, 'r').then(h => { return h.close().then(() => 'resolved'); }),
        new Promise(r => setTimeout(() => r('timeout'), 1500)),
      ]).then(outcome => {
        process.stdout.write('OUTCOME=' + outcome + '\\n');
        process.exit(0);
      }).catch(err => {
        process.stdout.write('OUTCOME=rejected:' + (err && err.code) + '\\n');
        process.exit(0);
      });
    `;

    const result = runInSubprocess(script);
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    // Pin the observed outcome: graceful-fs does NOT patch fs/promises, so
    // fsp.open uses its own internal path and resolves successfully here.
    // (If a future graceful-fs upgrade DOES patch fsp, this string changes
    // and the test fails — at which point we'd revisit Stage 1.5's scope.)
    expect(result.stdout.trim()).toBe('OUTCOME=resolved');
  });

  // ─── Test 3: source-order guard ──────────────────────────────────────────
  // The leaf module must be the first import of `src/main/bootstrap.ts` that
  // touches the filesystem. A later refactor that moves it below an fs-touching
  // import would silently regress the EMFILE-retry patch. Cheap, deterministic,
  // run as part of validate:fast via the unit-test suite.
  //
  // EXCEPTION — `./startup/applyThreadpoolSize` is allowed to precede it (and
  // MUST, per docs/plans/260619_turn-hang-bugmode/PLAN.md Stage 4b): it sets
  // `UV_THREADPOOL_SIZE` before the first ASYNC threadpool op (libuv reads the
  // env var once, at first async-pool use). That module does NO fs and NO async
  // pool work itself (only synchronous `os.availableParallelism()` + a
  // `process.env` write), so graceful-fs's "patch before any fs op" invariant is
  // fully preserved — installGracefulFs remains the first FS-touching import.
  //
  // NOTE: Stage 2 will extend this guard to `cloud-service/src/server.ts`
  // (cloud-service banner + leaf module are added there).
  // The only import allowed before installGracefulFs (it does no fs / no async
  // pool work — see the comment block above).
  const ALLOWED_FIRST_IMPORT = './startup/applyThreadpoolSize';

  it('keeps installGracefulFs as the first fs-touching import in src/main/bootstrap.ts', () => {
    const source = fs.readFileSync(BOOTSTRAP_PATH, 'utf8');
    const firstImport = findFirstImport(source);
    expect(firstImport, 'no import statements found in bootstrap.ts').not.toBeNull();
    if (firstImport === './startup/installGracefulFs') {
      return; // graceful-fs is literally first — strongest guarantee.
    }
    // Otherwise the only thing allowed before it is the non-fs threadpool buffer,
    // and installGracefulFs must be the VERY NEXT side-effect import.
    expect(
      firstImport,
      `unexpected import "${firstImport}" before installGracefulFs in bootstrap.ts; only the non-fs threadpool buffer may precede it`,
    ).toBe(ALLOWED_FIRST_IMPORT);
    // Confirm the two leaf imports are adjacent at the top: the threadpool buffer
    // line is immediately followed (ignoring comments/blank lines) by the
    // graceful-fs import. A cheap ordered-substring check is enough given both
    // are fixed `import './startup/...'` side-effect lines.
    const tpIdx = source.indexOf(`import './startup/applyThreadpoolSize'`);
    const gfsIdx = source.indexOf(`import './startup/installGracefulFs'`);
    expect(tpIdx, 'applyThreadpoolSize side-effect import not found').toBeGreaterThanOrEqual(0);
    expect(gfsIdx, 'installGracefulFs side-effect import not found').toBeGreaterThanOrEqual(0);
    expect(gfsIdx, 'installGracefulFs must come after the threadpool buffer').toBeGreaterThan(tpIdx);
  });

  it('routes desktop startup install through @core/startup/installGracefulFs', () => {
    const source = fs.readFileSync(DESKTOP_INSTALL_LEAF_PATH, 'utf8');
    const firstImport = findFirstImport(source);
    expect(firstImport, 'no import statements found in desktop install leaf').not.toBeNull();
    expect(firstImport).toBe('@core/startup/installGracefulFs');
  });
});

/**
 * Find the module specifier of the first `import './x'` (side-effect import)
 * or `import name from './x'` statement that appears outside any
 * line/block comment. Returns null if no import is found.
 */
function findFirstImport(source: string): string | null {
  let i = 0;
  const len = source.length;

  while (i < len) {
    // Skip whitespace.
    while (i < len && /\s/.test(source[i] ?? '')) i += 1;
    if (i >= len) break;

    const two = source.substring(i, i + 2);

    // Line comment.
    if (two === '//') {
      const eol = source.indexOf('\n', i);
      i = eol === -1 ? len : eol + 1;
      continue;
    }

    // Block comment.
    if (two === '/*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? len : end + 2;
      continue;
    }

    // Reached the first non-comment, non-whitespace token.
    const rest = source.substring(i);
    // Match either `import './x';` or `import X from './x';` (and quote variants).
    const sideEffect = /^import\s+['"]([^'"]+)['"]/.exec(rest);
    if (sideEffect) return sideEffect[1] ?? null;
    const named = /^import\s+(?:type\s+)?[^'"]*?\s+from\s+['"]([^'"]+)['"]/.exec(rest);
    if (named) return named[1] ?? null;

    // Some other top-level construct found before any import — bail.
    return null;
  }

  return null;
}
