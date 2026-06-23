/**
 * Unit tests for the raw-`ipcRenderer.invoke` ratchet guard.
 *
 * Proves the kill-by-construction guard (260609 IPC contract harness follow-up):
 *   - the current tree                          -> count == baseline (passes, exit 0)
 *   - a fixture with an EXTRA raw invoke         -> count > baseline (guard fails)
 *   - a typed-bridge file (ipcBridge*.ts)        -> NOT counted (sanctioned)
 *   - raw invoke in a `//` / block comment       -> NOT counted (comment-stripped)
 *
 * @see scripts/check-no-raw-ipc-invoke.ts
 * @see docs/plans/260609_ipc-inprocess-contract-harness/subagent_reports/260609_213705_raw-invoke-callsite-risk.md
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  RAW_IPC_INVOKE_BASELINE,
  countRawInvokesInSource,
  isCountedPreloadFile,
  scanRawIpcInvokes,
} from '../check-no-raw-ipc-invoke';

describe('countRawInvokesInSource', () => {
  it('counts a raw ipcRenderer.invoke call site', () => {
    const src = `export const api = { foo: () => ipcRenderer.invoke('chan:foo', payload) };`;
    expect(countRawInvokesInSource(src, 'src/preload/index.ts').count).toBe(1);
  });

  it('counts a no-arg invoke site too', () => {
    const src = `const x = () => ipcRenderer.invoke('chan:ping');`;
    expect(countRawInvokesInSource(src, 'src/preload/index.ts').count).toBe(1);
  });

  it('counts two invokes on one line as 2', () => {
    const src = `a(() => ipcRenderer.invoke('a')); b(() => ipcRenderer.invoke('b'));`;
    expect(countRawInvokesInSource(src, 'src/preload/index.ts').count).toBe(2);
  });

  it('tolerates whitespace around the member access and call', () => {
    const src = `ipcRenderer . invoke ( 'chan:spaced', x )`;
    expect(countRawInvokesInSource(src, 'src/preload/index.ts').count).toBe(1);
  });

  it('does NOT count a raw invoke inside a line comment', () => {
    const src = `// legacy: ipcRenderer.invoke('chan:old')`;
    expect(countRawInvokesInSource(src, 'src/preload/index.ts').count).toBe(0);
  });

  it('does NOT count a raw invoke inside a block comment', () => {
    const src = ['/*', `ipcRenderer.invoke('chan:doc', x)`, '*/'].join('\n');
    expect(countRawInvokesInSource(src, 'src/preload/index.ts').count).toBe(0);
  });

  it('does NOT count a typed-bridge invoke method that is not on ipcRenderer', () => {
    const src = `const r = domainApi.invoke('chan:typed', payload);`;
    expect(countRawInvokesInSource(src, 'src/preload/index.ts').count).toBe(0);
  });
});

describe('isCountedPreloadFile', () => {
  it('counts ordinary preload prod source', () => {
    expect(isCountedPreloadFile('src/preload/index.ts')).toBe(true);
  });

  it('does NOT count the sanctioned typed-bridge files', () => {
    expect(isCountedPreloadFile('src/preload/ipcBridge.ts')).toBe(false);
    expect(isCountedPreloadFile('src/preload/ipcBridgeBuilder.ts')).toBe(false);
  });

  it('does NOT count test files', () => {
    expect(isCountedPreloadFile('src/preload/__tests__/foo.test.ts')).toBe(false);
    expect(isCountedPreloadFile('src/preload/index.test.ts')).toBe(false);
  });
});

describe('scanRawIpcInvokes — current tree', () => {
  it('matches the baseline exactly (guard passes on the real tree)', () => {
    const result = scanRawIpcInvokes();
    expect(result.count).toBe(RAW_IPC_INVOKE_BASELINE);
    expect(result.exceeded).toBe(false);
  });
});

describe('scanRawIpcInvokes — fixture trees', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'raw-ipc-guard-'));
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeRepo(name: string, files: Record<string, string>): { repoRoot: string; scanRoot: string } {
    const repoRoot = path.join(tmpDir, name);
    const preloadDir = path.join(repoRoot, 'src', 'preload');
    fs.mkdirSync(preloadDir, { recursive: true });
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(preloadDir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content, 'utf8');
    }
    return { repoRoot, scanRoot: preloadDir };
  }

  it('fails when an EXTRA raw invoke is added beyond baseline', () => {
    const { repoRoot, scanRoot } = makeRepo('over', {
      'index.ts': [
        `export const api = {`,
        `  a: () => ipcRenderer.invoke('chan:a', x),`,
        `  b: () => ipcRenderer.invoke('chan:b', y),`,
        `};`,
      ].join('\n'),
    });
    // Baseline of 1 — the fixture has 2, so it EXCEEDS.
    const result = scanRawIpcInvokes({ repoRoot, scanRoot, baseline: 1 });
    expect(result.count).toBe(2);
    expect(result.exceeded).toBe(true);
  });

  it('passes when the count equals baseline', () => {
    const { repoRoot, scanRoot } = makeRepo('equal', {
      'index.ts': `export const api = { a: () => ipcRenderer.invoke('chan:a', x) };`,
    });
    const result = scanRawIpcInvokes({ repoRoot, scanRoot, baseline: 1 });
    expect(result.count).toBe(1);
    expect(result.exceeded).toBe(false);
  });

  it('does NOT count invokes inside the sanctioned typed-bridge files', () => {
    const { repoRoot, scanRoot } = makeRepo('bridge', {
      'index.ts': `export const api = { a: () => ipcRenderer.invoke('chan:a', x) };`,
      'ipcBridge.ts': `forward(() => ipcRenderer.invoke(channel, req));`,
      'ipcBridgeBuilder.ts': [
        `build(() => ipcRenderer.invoke(channel, req));`,
        `build(() => ipcRenderer.invoke(channel2, req2));`,
      ].join('\n'),
    });
    const result = scanRawIpcInvokes({ repoRoot, scanRoot, baseline: 1 });
    // Only the index.ts site counts; the 3 bridge sites are excluded.
    expect(result.count).toBe(1);
    expect(result.exceeded).toBe(false);
  });
});
