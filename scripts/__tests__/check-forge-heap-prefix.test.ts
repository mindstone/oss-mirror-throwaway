import { describe, expect, it } from 'vitest';
import {
  MIN_HEAP_MB,
  evaluateScriptCommand,
  extractHeapMb,
  findForgeHeapViolations,
} from '../check-forge-heap-prefix';

describe('extractHeapMb', () => {
  it('reads an unquoted NODE_OPTIONS=--max-old-space-size value', () => {
    expect(extractHeapMb('NODE_OPTIONS=--max-old-space-size=8192 electron-forge make')).toBe(8192);
  });
  it('reads a cross-env-prefixed assignment', () => {
    expect(extractHeapMb('cross-env NODE_OPTIONS=--max-old-space-size=16384')).toBe(16384);
  });
  it('reads a double-quoted value with multiple flags', () => {
    expect(extractHeapMb('NODE_OPTIONS="--no-warnings --max-old-space-size=8192"')).toBe(8192);
  });
  it('returns null when NODE_OPTIONS lacks a heap flag', () => {
    expect(extractHeapMb('NODE_OPTIONS=--inspect electron-forge make')).toBeNull();
  });
  it('returns null when there is no NODE_OPTIONS assignment', () => {
    expect(extractHeapMb('electron-forge make')).toBeNull();
  });
  it('does NOT match a suffix env var like OLD_NODE_OPTIONS', () => {
    expect(extractHeapMb('OLD_NODE_OPTIONS=--max-old-space-size=8192')).toBeNull();
  });
});

describe('evaluateScriptCommand', () => {
  it('passes a compliant package script with the canonical heap prefix', () => {
    expect(
      evaluateScriptCommand(
        'npm run clean:out && npm run prebuild && cross-env NODE_OPTIONS=--max-old-space-size=8192 electron-forge package',
      ),
    ).toBeNull();
  });

  it('passes a compliant make script', () => {
    expect(
      evaluateScriptCommand('cross-env NODE_OPTIONS=--max-old-space-size=8192 electron-forge make'),
    ).toBeNull();
  });

  it('passes a heap value above the floor', () => {
    expect(
      evaluateScriptCommand('cross-env NODE_OPTIONS=--max-old-space-size=16384 electron-forge make'),
    ).toBeNull();
  });

  it('FAILS a package invocation with no heap prefix', () => {
    const reason = evaluateScriptCommand('electron-forge package');
    expect(reason).toMatch(/without a NODE_OPTIONS/);
  });

  it('FAILS a make invocation with no heap prefix', () => {
    const reason = evaluateScriptCommand('npm run prebuild && electron-forge make');
    expect(reason).toMatch(/without a NODE_OPTIONS/);
  });

  it('FAILS a heap value below the floor', () => {
    const reason = evaluateScriptCommand(
      'cross-env NODE_OPTIONS=--max-old-space-size=4096 electron-forge package',
    );
    expect(reason).toMatch(new RegExp(`below the required ${MIN_HEAP_MB}`));
  });

  it('FAILS when the heap bump is on a different && segment, not the Forge segment', () => {
    const reason = evaluateScriptCommand(
      'cross-env NODE_OPTIONS=--max-old-space-size=8192 node scripts/prebuild.js && electron-forge make',
    );
    expect(reason).toMatch(/without a NODE_OPTIONS/);
  });

  it('FAILS when NODE_OPTIONS appears AFTER the electron-forge token', () => {
    // Pathological but defends the "before the parent launch" invariant.
    const reason = evaluateScriptCommand(
      'electron-forge package NODE_OPTIONS=--max-old-space-size=8192',
    );
    expect(reason).toMatch(/without a NODE_OPTIONS/);
  });

  it('FAILS when the heap bump is on the piped-from side of a single pipe', () => {
    const reason = evaluateScriptCommand(
      'cross-env NODE_OPTIONS=--max-old-space-size=8192 echo x | electron-forge make',
    );
    expect(reason).toMatch(/without a NODE_OPTIONS/);
  });

  it('FAILS when only a suffix env var (OLD_NODE_OPTIONS) carries the heap flag', () => {
    const reason = evaluateScriptCommand(
      'OLD_NODE_OPTIONS=--max-old-space-size=8192 electron-forge make',
    );
    expect(reason).toMatch(/without a NODE_OPTIONS/);
  });

  it('ignores electron-forge start (dev path, not covered)', () => {
    expect(
      evaluateScriptCommand('node scripts/run-dev-with-cdp-default.mjs electron-forge start'),
    ).toBeNull();
  });

  it('ignores commands that do not invoke electron-forge at all', () => {
    expect(evaluateScriptCommand('npm run build:worker && node scripts/fix-esm-interop.mjs')).toBeNull();
  });

  it('accepts an approved wrapper without an inline heap prefix', () => {
    expect(
      evaluateScriptCommand('npx tsx scripts/run-electron-forge-with-heap-bump.ts make'),
    ).toBeNull();
  });

  it('handles the real build:windows:nsis shape (prefix + package + chained nsis step)', () => {
    expect(
      evaluateScriptCommand(
        'npm run prebuild && cross-env NODE_OPTIONS=--max-old-space-size=8192 electron-forge package --platform win32 --arch x64 && node scripts/build-windows-nsis.mjs',
      ),
    ).toBeNull();
  });
});

describe('findForgeHeapViolations', () => {
  it('reports every offending script with its name', () => {
    const violations = findForgeHeapViolations({
      build: 'cross-env NODE_OPTIONS=--max-old-space-size=8192 electron-forge make',
      'bad:package': 'electron-forge package',
      'bad:make': 'cross-env NODE_OPTIONS=--max-old-space-size=2048 electron-forge make',
      dev: 'electron-forge start',
      lint: 'eslint src/',
    });
    const names = violations.map((v) => v.script).sort();
    expect(names).toEqual(['bad:make', 'bad:package']);
  });

  it('returns no violations for an all-compliant script map', () => {
    expect(
      findForgeHeapViolations({
        build: 'cross-env NODE_OPTIONS=--max-old-space-size=8192 electron-forge make',
        package: 'cross-env NODE_OPTIONS=--max-old-space-size=8192 electron-forge package',
        dev: 'electron-forge start',
      }),
    ).toEqual([]);
  });
});
