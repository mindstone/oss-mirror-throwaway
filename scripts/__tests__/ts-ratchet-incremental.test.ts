import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tsBuildInfoPathFor, type ProjectConfig } from '../check-typescript-errors';

/**
 * Lever B (docs/plans/260618_git-safe-sync-speedup): incremental tsc cache for
 * validate:ts-ratchet. These tests pin (a) the defensive cache KEYING and (b)
 * the load-bearing safety property that a WARM cache can never hide a type error
 * introduced into a changed file — the whole reason caching is safe in a gate.
 */

const NODE: ProjectConfig = { name: 'node', tsconfig: 'tsconfig.node.json', baseline: 0 };
const RENDERER: ProjectConfig = { name: 'renderer', tsconfig: 'tsconfig.renderer.json', baseline: 0 };

function withEnv(overrides: Record<string, string | undefined>, fn: () => void): void {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(overrides)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe('tsBuildInfoPathFor — defensive keying & opt-outs', () => {
  it('returns null when TS_RATCHET_NO_CACHE is set (cold fallback)', () => {
    withEnv({ TS_RATCHET_NO_CACHE: '1', CI: undefined, GITHUB_ACTIONS: undefined }, () => {
      expect(tsBuildInfoPathFor(NODE)).toBeNull();
    });
  });

  it('returns null in CI (CI runs cold; it is the authoritative backstop)', () => {
    withEnv({ TS_RATCHET_NO_CACHE: undefined, CI: '1', GITHUB_ACTIONS: undefined }, () => {
      expect(tsBuildInfoPathFor(NODE)).toBeNull();
    });
    withEnv({ TS_RATCHET_NO_CACHE: undefined, CI: undefined, GITHUB_ACTIONS: 'true' }, () => {
      expect(tsBuildInfoPathFor(NODE)).toBeNull();
    });
  });

  it('distinct projects get distinct, name-tagged cache files (no collision)', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tsratchet-key-'));
    try {
      withEnv({ TS_RATCHET_NO_CACHE: undefined, CI: undefined, GITHUB_ACTIONS: undefined }, () => {
        const a = tsBuildInfoPathFor(NODE, repoRoot);
        const b = tsBuildInfoPathFor(RENDERER, repoRoot);
        expect(a).not.toBeNull();
        expect(b).not.toBeNull();
        expect(a).not.toBe(b);
        expect(path.basename(a as string)).toMatch(/^node-[0-9a-f]{16}\.tsbuildinfo$/);
        expect(path.basename(b as string)).toMatch(/^renderer-[0-9a-f]{16}\.tsbuildinfo$/);
        expect(a as string).toContain(path.join('.local', 'ts-ratchet'));
      });
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('a different lockfile content changes the cache key (forces cold rebuild)', () => {
    const root1 = fs.mkdtempSync(path.join(os.tmpdir(), 'tsratchet-lock1-'));
    const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'tsratchet-lock2-'));
    try {
      fs.writeFileSync(path.join(root1, 'package-lock.json'), '{"v":1}');
      fs.writeFileSync(path.join(root2, 'package-lock.json'), '{"v":2}');
      withEnv({ TS_RATCHET_NO_CACHE: undefined, CI: undefined, GITHUB_ACTIONS: undefined }, () => {
        const a = path.basename(tsBuildInfoPathFor(NODE, root1) as string);
        const b = path.basename(tsBuildInfoPathFor(NODE, root2) as string);
        expect(a).not.toBe(b); // lockfile delta -> different key
      });
    } finally {
      fs.rmSync(root1, { recursive: true, force: true });
      fs.rmSync(root2, { recursive: true, force: true });
    }
  });
});

describe('incremental tsc cannot hide a type error in a changed file (the safety invariant)', () => {
  let tmp: string | null = null;
  afterEach(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    tmp = null;
  });

  it('catches an error introduced AFTER the cache was warmed clean', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tsratchet-makeorbreak-'));
    const tsconfig = path.join(tmp, 'tsconfig.json');
    const src = path.join(tmp, 'a.ts');
    const buildInfo = path.join(tmp, 'cache.tsbuildinfo');
    fs.writeFileSync(
      tsconfig,
      JSON.stringify({
        compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
        files: ['a.ts'],
      }),
    );
    fs.writeFileSync(src, 'export const x: number = 1;\n');

    const runTsc = (): { code: number; out: string } => {
      try {
        const out = execFileSync(
          'npx',
          ['tsc', '-p', tsconfig, '--noEmit', '--incremental', '--tsBuildInfoFile', buildInfo, '--pretty', 'false'],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
        );
        return { code: 0, out };
      } catch (err) {
        const e = err as { status?: number; stdout?: string; stderr?: string };
        return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
      }
    };

    // 1. clean run warms the cache
    const clean = runTsc();
    expect(clean.code).toBe(0);
    expect(fs.existsSync(buildInfo)).toBe(true);

    // 2. introduce a type error into the (now-changed) file
    fs.writeFileSync(src, 'export const x: number = "not a number";\n');

    // 3. WARM run (cache present) must STILL catch it
    const broken = runTsc();
    expect(broken.code).not.toBe(0);
    expect(broken.out).toMatch(/error TS2322/);
  }, 30_000);
});
