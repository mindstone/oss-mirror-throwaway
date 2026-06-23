#!/usr/bin/env node
// Update git submodules that are declared in `.gitmodules`, skipping (non-fatally)
// any that aren't.
//
// Why this exists: the OSS public mirror ships a `.gitmodules` with only a SUBSET
// of the canonical submodules. `mcp-servers` is path-deleted from the mirror — it
// is published as its own standalone public repo, not a submodule of the app
// mirror (see mirror/substitutions.yaml + mirror/patches/.gitmodules.patch). A bare
// `git submodule update --init mcp-servers` exits 1 when the path is absent from
// `.gitmodules`, which aborted `predev`'s `&&` chain and broke `npm run dev` on a
// fresh OSS clone. This guard updates each named submodule only if it is declared,
// so the same `predev` works on both surfaces:
//   - canonical:   all three declared -> all three updated (no behaviour change)
//   - OSS mirror:  mcp-servers absent  -> skipped non-fatally; the rest still update
//
// A submodule that IS declared but fails to update is still a HARD error (non-zero
// exit) — we only skip submodules genuinely absent from `.gitmodules`. Never let
// this silently mask a real update failure on canonical.
//
// Usage: node scripts/update-submodule-if-declared.mjs [--init] <name> [<name>...]
//   --init   pass through to `git submodule update --init` (initialize if needed)

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const TAG = '[update-submodule-if-declared]';
// Resolve the checkout root from this script's own location so it works regardless
// of cwd and correctly targets a worktree when invoked from within one.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GITMODULES = join(REPO_ROOT, '.gitmodules');

const args = process.argv.slice(2);
const init = args.includes('--init');
const names = args.filter((a) => a !== '--init');

if (names.length === 0) {
  console.error(`${TAG} no submodule names provided. Usage: update-submodule-if-declared.mjs [--init] <name>...`);
  process.exit(1);
}

// Build the set of submodules declared in .gitmodules. We accept a match on either
// the submodule NAME (the `submodule.<name>` config key) or its checkout PATH — for
// our submodules these are identical, but matching both keeps the guard robust.
function declaredSubmodules() {
  // git-exec-allow: plain .mjs run by node in predev cannot import the TS git-exec helper; one bounded line per submodule, well under the default cap
  const result = spawnSync(
    'git',
    ['config', '--file', GITMODULES, '--get-regexp', '^submodule\\..*\\.path$'],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  if (result.error) {
    // git itself couldn't be spawned. Treating this as "nothing declared" would
    // silently skip EVERY submodule (including declared ones on canonical) — that's a
    // silent failure, so fail loud instead.
    console.error(`${TAG} could not run git to read .gitmodules: ${result.error.message}`);
    process.exit(1);
  }
  // `git config --get-regexp` exits 1 when there are no matching entries OR .gitmodules
  // is absent — both legitimately mean "nothing declared".
  if (result.status === 1) return new Set();
  // Any other non-zero (e.g. 128 for a malformed/unreadable .gitmodules) is a real error:
  // fail loud rather than silently skip every submodule.
  if (result.status !== 0) {
    console.error(`${TAG} reading .gitmodules failed (git exited ${result.status}): ${(result.stderr || '').trim()}`);
    process.exit(result.status);
  }
  if (!result.stdout) return new Set();
  const declared = new Set();
  for (const line of result.stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Each line: "submodule.<name>.path <path>"
    const [key, ...rest] = trimmed.split(/\s+/);
    const path = rest.join(' ');
    const nameMatch = /^submodule\.(.+)\.path$/.exec(key);
    if (nameMatch) declared.add(nameMatch[1]);
    if (path) declared.add(path);
  }
  return declared;
}

const declared = declaredSubmodules();

for (const name of names) {
  if (!declared.has(name)) {
    console.log(`${TAG} '${name}' is not declared in .gitmodules — skipping (expected on the OSS mirror).`);
    continue;
  }
  const updateArgs = ['submodule', 'update'];
  if (init) updateArgs.push('--init');
  updateArgs.push('--', name);
  console.log(`${TAG} git ${updateArgs.join(' ')}`);
  // git-exec-allow: stdio inherit streams to the terminal with no captured output, so there is no buffer to overflow; plain .mjs run by node in predev
  const result = spawnSync('git', updateArgs, { cwd: REPO_ROOT, stdio: 'inherit' });
  if (result.error) {
    console.error(`${TAG} failed to spawn git for '${name}': ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    // Declared submodule failed to update — this is a real error, fail loud.
    console.error(`${TAG} \`git submodule update\` for '${name}' exited with code ${result.status}.`);
    process.exit(result.status ?? 1);
  }
}
