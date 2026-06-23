#!/usr/bin/env npx tsx
/**
 * Guard: better-sqlite3 must stay a dev-only, non-`src/`-imported dependency.
 *
 * The Windows release build deliberately does NOT compile better-sqlite3 (its native build is
 * skipped-by-construction — the Windows install jobs run on Node 22 where a prebuild resolves,
 * and forge rebuilds no native modules). That is only SAFE because better-sqlite3 is never loaded
 * by the packaged app: it is a devDependency, used only by a handful of tooling scripts, with zero
 * importers under `src/`. If someone later moves it into runtime `dependencies` or imports it from
 * `src/`, the packaged Windows app would ship without a loadable binary and crash at runtime — a
 * silent, late-surfacing failure. This guard makes that regression fail fast at validate time.
 *
 * Run: npx tsx scripts/check-better-sqlite3-not-runtime.ts
 * Wired into: npm run validate:fast
 *
 * @see docs/plans/260614_ci-release-robustness/PLAN.md (Stage 2, finding F4)
 * @see .github/workflows/release.yml (WINDOWS_BUILD_NODE_VERSION)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { gitCapture } from './lib/git-exec';

const PKG = 'better-sqlite3';
const repoRoot = path.resolve(__dirname, '..');

function fail(msg: string): never {
  console.error(`✗ [check-better-sqlite3-not-runtime] ${msg}`);
  process.exit(1);
}

// 1. Must NOT be in runtime `dependencies` (devDependencies is fine).
const pkgJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
if (pkgJson.dependencies && PKG in pkgJson.dependencies) {
  fail(
    `${PKG} is in "dependencies" — it must stay in "devDependencies" only. The Windows release build ` +
      `skips its native compile (no Node-20 prebuild; node-gyp maxBuffer crash), which is only safe ` +
      `while nothing in the packaged app loads it. Move it back to devDependencies, or if the app now ` +
      `genuinely needs it at runtime, revisit the release.yml Windows install strategy first.`,
  );
}

// 2. Must have ZERO importers under src/. Use git grep (fast, respects tracked files), routed
// through the gitCapture chokepoint (repo-wide maxBuffer policy + the git-exec guard).
// Catch every runtime form: `require('better-sqlite3')`, `import ... from 'better-sqlite3'`,
// bare `import 'better-sqlite3'`, dynamic `import('better-sqlite3')`, and `createRequire(...)('...')`.
let matched = '';
try {
  matched = gitCapture(
    ['grep', '-l', '-E', `(require|import)\\s*\\(?\\s*['"]better-sqlite3['"]|from\\s+['"]better-sqlite3['"]`, '--', 'src/'],
    { cwd: repoRoot },
  ).trim();
} catch (err) {
  // `git grep` exits 1 when there are no matches — the expected, healthy case. gitCapture
  // (execFileSync) throws on non-zero exit, so treat status 1 as "no importers" and anything
  // else as a real failure.
  const status = (err as { status?: number }).status;
  if (status === 1) matched = '';
  else fail(`git grep failed: ${err instanceof Error ? err.message : String(err)}`);
}
if (matched) {
  const files = matched.split('\n').join('\n  - ');
  fail(
    `${PKG} is imported from src/ (packaged-app surface):\n  - ${files}\n` +
      `The Windows release build does not compile better-sqlite3, so the packaged app would crash ` +
      `loading it. Remove the src/ import, or revisit the release.yml Windows install strategy first.`,
  );
}

console.log(`✓ [check-better-sqlite3-not-runtime] ${PKG} is devDep-only with no src/ importers.`);
