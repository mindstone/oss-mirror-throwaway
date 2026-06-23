import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverElectronImports, buildAutoStubs } from '../lib/discoverElectronImports.mjs';

describe('discoverElectronImports', () => {
  let tmpDir;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'electron-stub-test-'));
    const mainDir = path.join(tmpDir, 'src/main/services');
    fs.mkdirSync(mainDir, { recursive: true });

    fs.writeFileSync(path.join(mainDir, 'foo.ts'), `
import { powerSaveBlocker, clipboard } from 'electron';
export function foo() { return powerSaveBlocker.start('prevent-app-suspension'); }
`);

    fs.writeFileSync(path.join(mainDir, 'bar.ts'), `
import { app as electronApp, type BrowserWindow } from 'electron';
export const version = electronApp.getVersion();
`);

    fs.writeFileSync(path.join(mainDir, 'noelectron.ts'), `
import { something } from 'not-electron';
`);

    // __tests__ directories should be skipped
    const testDir = path.join(mainDir, '__tests__');
    fs.mkdirSync(testDir, { recursive: true });
    fs.writeFileSync(path.join(testDir, 'test.ts'), `
import { dialog } from 'electron';
`);
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('discovers named electron imports from source files', () => {
    const result = discoverElectronImports({
      projectRoot: tmpDir,
      scanDirs: [path.join(tmpDir, 'src/main')],
    });

    expect(result.has('powerSaveBlocker')).toBe(true);
    expect(result.has('clipboard')).toBe(true);
    expect(result.has('electronApp')).toBe(true); // aliased: app as electronApp
    expect(result.has('something')).toBe(false); // from 'not-electron'
  });

  it('skips type-only imports', () => {
    const result = discoverElectronImports({
      projectRoot: tmpDir,
      scanDirs: [path.join(tmpDir, 'src/main')],
    });

    expect(result.has('BrowserWindow')).toBe(false); // type BrowserWindow
  });

  it('skips __tests__ directories', () => {
    const result = discoverElectronImports({
      projectRoot: tmpDir,
      scanDirs: [path.join(tmpDir, 'src/main')],
    });

    expect(result.has('dialog')).toBe(false);
  });

  it('returns empty set for nonexistent directory', () => {
    const result = discoverElectronImports({
      projectRoot: tmpDir,
      scanDirs: [path.join(tmpDir, 'does-not-exist')],
    });

    expect(result.size).toBe(0);
  });
});

describe('buildAutoStubs', () => {
  it('generates stubs only for names not in the specialized set', () => {
    const specialized = new Set(['app', 'BrowserWindow']);
    const discovered = new Set(['app', 'BrowserWindow', 'powerSaveBlocker', 'clipboard']);

    const { autoStubs, allNames } = buildAutoStubs({ specialized, discovered });

    expect(autoStubs).toEqual([
      'const powerSaveBlocker = noopProxy;',
      'const clipboard = noopProxy;',
    ]);
    expect(allNames).toContain('app');
    expect(allNames).toContain('powerSaveBlocker');
    expect(allNames).toEqual([...allNames].sort());
  });

  it('returns empty autoStubs when all discovered names are specialized', () => {
    const specialized = new Set(['app']);
    const discovered = new Set(['app']);

    const { autoStubs } = buildAutoStubs({ specialized, discovered });

    expect(autoStubs).toEqual([]);
  });

  it('generates throwing stubs in throw mode', () => {
    const specialized = new Set(['app']);
    const discovered = new Set(['app', 'globalShortcut']);

    const { autoStubs } = buildAutoStubs({ specialized, discovered, mode: 'throw' });

    expect(autoStubs).toHaveLength(1);
    expect(autoStubs[0]).toContain('globalShortcut');
    expect(autoStubs[0]).toContain('throw new Error');
    expect(autoStubs[0]).toContain('not available in cloud mode');
  });

  it('generates noop stubs by default (mode omitted)', () => {
    const specialized = new Set(['app']);
    const discovered = new Set(['app', 'clipboard']);

    const { autoStubs } = buildAutoStubs({ specialized, discovered });

    expect(autoStubs).toHaveLength(1);
    expect(autoStubs[0]).toBe('const clipboard = noopProxy;');
  });
});
