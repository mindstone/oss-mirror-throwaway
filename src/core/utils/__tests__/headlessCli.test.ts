import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { isHeadlessCli } from '../headlessCli';

describe('isHeadlessCli (core SSOT)', () => {
  const originalEnv = process.env;
  const originalArgv = process.argv;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.REBEL_HEADLESS_CLI;
    process.argv = originalArgv.filter((a) => a !== '--headless-cli');
  });

  afterEach(() => {
    process.env = originalEnv;
    process.argv = originalArgv;
  });

  it('returns false with neither env nor argv', () => {
    expect(isHeadlessCli()).toBe(false);
  });

  it('returns true when REBEL_HEADLESS_CLI=1 (standalone rebel binary path)', () => {
    process.env.REBEL_HEADLESS_CLI = '1';
    expect(isHeadlessCli()).toBe(true);
  });

  it('returns false when REBEL_HEADLESS_CLI is set but not exactly "1"', () => {
    process.env.REBEL_HEADLESS_CLI = 'true';
    expect(isHeadlessCli()).toBe(false);
  });

  it('returns true for the bare --headless-cli flag in argv (.app CLI invocation)', () => {
    process.argv = [...process.argv, '--headless-cli'];
    expect(isHeadlessCli()).toBe(true);
  });

  it('returns false for the --headless-cli=value form (the single intended delta from retiring the switch belt)', () => {
    // The exact-match argv check misses `--headless-cli=value`, and there is
    // deliberately no `app.commandLine.hasSwitch` fallback. This is harmless: no
    // launch path uses the `=value` form, and the actual CLI entry branch
    // (src/main/index.ts) is itself env+argv only — so this form would never have
    // entered CLI mode anyway.
    process.argv = [...process.argv, '--headless-cli=1'];
    expect(isHeadlessCli()).toBe(false);
  });
});
