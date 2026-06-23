/**
 * Tests for scripts/update-submodule-if-declared.mjs — the predev guard that makes
 * submodule updates robust to a submodule that is ABSENT from `.gitmodules`.
 *
 * Why this guard exists: the OSS public mirror ships a `.gitmodules` with only a
 * subset of the canonical submodules (`mcp-servers` is path-deleted — it's a
 * standalone public repo, not a submodule of the app mirror). A raw
 * `git submodule update --init mcp-servers` exits 1 when the path is absent from
 * `.gitmodules`, which aborted `predev`'s `&&` chain and broke `npm run dev` on a
 * fresh OSS clone. This is the red→green regression guard for that bug.
 *
 * Regression classes covered:
 *   - OSS case (THE bug): a submodule absent from .gitmodules is skipped, exit 0.
 *   - canonical case: a declared submodule with a real gitlink is updated, exit 0.
 *   - no silent masking: a declared submodule that fails to update exits non-zero.
 *   - no .gitmodules at all: every name skipped, exit 0.
 *   - misuse: no submodule names provided exits non-zero.
 *
 * Spawns the real script against temp git repos (a copy lands in <temp>/scripts/ so
 * the script resolves REPO_ROOT to the temp repo). Local file:// submodules only —
 * no network.
 *
 * @see ../update-submodule-if-declared.mjs
 */
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const HELPER_SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'update-submodule-if-declared.mjs');

function git(args: string[], cwd: string) {
  // protocol.file.allow=always: required for local file:// submodule add on modern git.
  const res = spawnSync('git', ['-c', 'protocol.file.allow=always', ...args], {
    cwd,
    encoding: 'utf8',
  });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${res.stderr || res.stdout}`);
  }
  return res;
}

function initRepo(dir: string) {
  mkdirSync(dir, { recursive: true });
  git(['init', '-q'], dir);
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'Test'], dir);
  git(['config', 'commit.gpgsign', 'false'], dir);
}

/** Run the helper from a temp repo root (a copy is placed at <root>/scripts/). */
function runHelper(root: string, args: string[]) {
  const scriptsDir = join(root, 'scripts');
  mkdirSync(scriptsDir, { recursive: true });
  cpSync(HELPER_SRC, join(scriptsDir, 'update-submodule-if-declared.mjs'));
  return spawnSync('node', [join(scriptsDir, 'update-submodule-if-declared.mjs'), ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

describe('update-submodule-if-declared.mjs', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'update-submodule-test-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('skips a submodule absent from .gitmodules (the OSS-mirror bug) with exit 0', () => {
    const root = join(tmp, 'repo');
    initRepo(root);
    // OSS-shaped .gitmodules: declares rebel-system + super-mcp, NOT mcp-servers.
    writeFileSync(
      join(root, '.gitmodules'),
      '[submodule "rebel-system"]\n\tpath = rebel-system\n\turl = https://example.com/rebel-system.git\n' +
        '[submodule "super-mcp"]\n\tpath = super-mcp\n\turl = https://example.com/super-mcp.git\n',
    );
    const res = runHelper(root, ['--init', 'mcp-servers']);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/not declared in \.gitmodules — skipping/);
  });

  it('updates a declared submodule that has a real gitlink (canonical case) with exit 0', () => {
    // A real local submodule so `git submodule update` genuinely succeeds.
    const subOrigin = join(tmp, 'sub-origin');
    initRepo(subOrigin);
    writeFileSync(join(subOrigin, 'README.md'), 'sub\n');
    git(['add', '.'], subOrigin);
    git(['commit', '-q', '-m', 'init sub'], subOrigin);

    const root = join(tmp, 'repo');
    initRepo(root);
    writeFileSync(join(root, 'README.md'), 'root\n');
    git(['add', '.'], root);
    git(['commit', '-q', '-m', 'init root'], root);
    git(['submodule', 'add', pathToFileURL(subOrigin).href, 'rebel-system'], root);
    git(['commit', '-q', '-m', 'add submodule'], root);
    // De-initialize so `git submodule update` has real work to do.
    git(['submodule', 'deinit', '-f', 'rebel-system'], root);

    const res = runHelper(root, ['--init', 'rebel-system']);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/git submodule update --init -- rebel-system/);
    expect(res.stdout).not.toMatch(/skipping/);
    // The submodule's tracked file is now checked out → update actually ran.
    expect(existsSync(join(root, 'rebel-system', 'README.md'))).toBe(true);
  });

  it('fails loud (non-zero) when a DECLARED submodule cannot be updated — no silent masking', () => {
    const root = join(tmp, 'repo');
    initRepo(root);
    // Declared in .gitmodules but never committed as a gitlink → update fails.
    writeFileSync(
      join(root, '.gitmodules'),
      '[submodule "rebel-system"]\n\tpath = rebel-system\n\turl = https://example.com/rebel-system.git\n',
    );
    const res = runHelper(root, ['rebel-system']);
    expect(res.status).not.toBe(0);
  });

  it('matches a declared submodule by either its section name or its checkout path', () => {
    const root = join(tmp, 'repo');
    initRepo(root);
    // Section name ("weird-name") differs from the checkout path ("vendor/weird-path").
    writeFileSync(
      join(root, '.gitmodules'),
      '[submodule "weird-name"]\n\tpath = vendor/weird-path\n\turl = https://example.com/w.git\n',
    );
    // By name → declared → attempts the update (no gitlink, so it then fails — but it did NOT skip).
    const byName = runHelper(root, ['weird-name']);
    expect(byName.stdout).toMatch(/git submodule update -- weird-name/);
    expect(byName.stdout).not.toMatch(/skipping/);
    // By path → also declared.
    const byPath = runHelper(root, ['vendor/weird-path']);
    expect(byPath.stdout).toMatch(/git submodule update -- vendor\/weird-path/);
    expect(byPath.stdout).not.toMatch(/skipping/);
    // Neither name nor path → not declared → skipped, exit 0.
    const absent = runHelper(root, ['something-else']);
    expect(absent.status).toBe(0);
    expect(absent.stdout).toMatch(/not declared in \.gitmodules — skipping/);
  });

  it('skips every name when .gitmodules is absent, with exit 0', () => {
    const root = join(tmp, 'repo');
    initRepo(root);
    const res = runHelper(root, ['--init', 'rebel-system', 'super-mcp', 'mcp-servers']);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/skipping/);
  });

  it('exits non-zero when no submodule names are provided', () => {
    const root = join(tmp, 'repo');
    initRepo(root);
    const res = runHelper(root, ['--init']);
    expect(res.status).not.toBe(0);
  });
});
