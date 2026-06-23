import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  computeTreeBinding,
  consumeNonceSidecar,
  readNonceSidecar,
  writeNonceSidecar,
  sidecarPath,
} from '../lib/gate-nonce';

/**
 * IO-layer tests for the gate nonce (review F3 — the 18 pure-verifier tests in
 * gate-nonce.test.ts don't exercise computeTreeBinding / clean-tree / consume).
 * Focus: the FAIL-CLOSED behaviour (review F1) — a git failure must surface as
 * a thrown error (→ check-gate-nonce.ts exits 1 → full gate), never as a false
 * "clean / no submodules".
 *
 * GIT-FIXTURE-ENV HAZARD: these shell real git against a temp repo. If GIT_DIR
 * / GIT_WORK_TREE / GIT_INDEX_FILE etc. are set (they are when vitest runs
 * INSIDE the pre-push hook), git would target the REAL repo and could create
 * stray commits / pollute config. We scrub all GIT_* env for the duration and
 * restore after, and pass an explicit scrubbed env to our own setup commands.
 */

const GIT_ENV_KEYS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_COMMON_DIR',
  'GIT_PREFIX',
  'GIT_CONFIG',
  'GIT_CONFIG_COUNT',
];

let savedEnv: Record<string, string | undefined> = {};
let repo: string;

function scrubbedEnv() {
  const env = { ...process.env };
  for (const k of GIT_ENV_KEYS) delete env[k];
  // Isolate from the developer's global/system git config (hooks, templates).
  env.GIT_CONFIG_GLOBAL = '/dev/null';
  env.GIT_CONFIG_SYSTEM = '/dev/null';
  return env;
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', env: scrubbedEnv() }).trim();
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gate-nonce-io-'));
  git(['init', '-q', '-b', 'main'], dir);
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'Test'], dir);
  git(['config', 'commit.gpgsign', 'false'], dir);
  writeFileSync(join(dir, 'a.txt'), 'hello\n');
  git(['add', 'a.txt'], dir);
  git(['commit', '-q', '-m', 'init'], dir);
  return dir;
}

beforeEach(() => {
  // Scrub at the process level so computeTreeBinding's own inherited-env git
  // calls also target the temp repo (cwd), never the real one.
  savedEnv = {};
  for (const k of [...GIT_ENV_KEYS, 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM']) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  repo = makeRepo();
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  if (repo) rmSync(repo, { recursive: true, force: true });
});

describe('computeTreeBinding — happy + clean/dirty', () => {
  it('reports a clean repo with no submodules', () => {
    const b = computeTreeBinding(repo, 1);
    expect(b.head_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(b.tree_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(b.submodule_shas).toEqual({});
    expect(b.working_tree_clean).toBe(true);
    expect(b.upstream_sha).toBeNull(); // no upstream configured
    expect(b.tier_covered).toBe(1);
  });

  it('reports dirty when there is an untracked file', () => {
    writeFileSync(join(repo, 'untracked.txt'), 'x\n');
    expect(computeTreeBinding(repo, 1).working_tree_clean).toBe(false);
  });

  it('reports dirty when a tracked file is modified', () => {
    writeFileSync(join(repo, 'a.txt'), 'changed\n');
    expect(computeTreeBinding(repo, 1).working_tree_clean).toBe(false);
  });
});

describe('computeTreeBinding — FAIL CLOSED (F1)', () => {
  it('throws when run outside a git repo (rather than reporting clean/empty)', () => {
    const notRepo = mkdtempSync(join(tmpdir(), 'gate-nonce-norepo-'));
    try {
      expect(() => computeTreeBinding(notRepo, 1)).toThrow();
    } finally {
      rmSync(notRepo, { recursive: true, force: true });
    }
  });
});

describe('sidecar IO + single-use consume (F2)', () => {
  it('writes, reads back, and consumes a sidecar', () => {
    const binding = computeTreeBinding(repo, 1);
    writeNonceSidecar(repo, { nonce: 'abc', binding, created_at: '2026-06-07T00:00:00.000Z', pid: 1 });
    expect(readNonceSidecar(repo)?.nonce).toBe('abc');
    expect(consumeNonceSidecar(repo)).toBe(true);
    expect(existsSync(sidecarPath(repo))).toBe(false);
    expect(readNonceSidecar(repo)).toBeNull();
  });

  it('consume returns true even when already absent (force)', () => {
    expect(consumeNonceSidecar(repo)).toBe(true);
  });

  it('readNonceSidecar returns null on a corrupt sidecar', () => {
    mkdirSync(dirname(sidecarPath(repo)), { recursive: true });
    writeFileSync(sidecarPath(repo), '{ not json');
    expect(readNonceSidecar(repo)).toBeNull();
  });
});
