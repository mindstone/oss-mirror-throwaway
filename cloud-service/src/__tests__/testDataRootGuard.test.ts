import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { assertTestDataRootSafe, isTestContext } from '../testDataRootGuard';

const ENV_KEYS = [
  'REBEL_E2E_TEST_MODE',
  'REBEL_USER_DATA',
  'NODE_ENV',
  'APPDATA',
] as const;

const originalEnv: Record<(typeof ENV_KEYS)[number], string | undefined> = {} as Record<
  (typeof ENV_KEYS)[number],
  string | undefined
>;

const repoTmp = path.resolve(__dirname, '..', '..', '..', 'tmp');

function expectUnsafe(dataRoot: string | undefined): void {
  expect(() => assertTestDataRootSafe(dataRoot)).toThrow(/Set REBEL_USER_DATA to a temporary directory/);
}

describe('testDataRootGuard', () => {
  beforeEach(() => {
    for (const key of ENV_KEYS) {
      originalEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = originalEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('identifies explicit e2e and node test contexts', () => {
    expect(isTestContext()).toBe(false);

    process.env.REBEL_E2E_TEST_MODE = '1';
    expect(isTestContext()).toBe(true);

    delete process.env.REBEL_E2E_TEST_MODE;
    process.env.NODE_ENV = 'test';
    expect(isTestContext()).toBe(true);
  });

  it('allows temporary data roots in test context', () => {
    process.env.NODE_ENV = 'test';

    expect(() => assertTestDataRootSafe('/tmp/rebel-guard-safe')).not.toThrow();
    expect(() => assertTestDataRootSafe(path.join(os.tmpdir(), 'rebel-guard-safe'))).not.toThrow();
    expect(() => assertTestDataRootSafe(path.join(repoTmp, 'rebel-guard-safe'))).not.toThrow();
  });

  it('rejects unsafe real or production-like data roots in test context', () => {
    process.env.NODE_ENV = 'test';
    const home = os.homedir();

    expectUnsafe(undefined);
    expectUnsafe('');
    expectUnsafe('/data');
    expectUnsafe(path.join(home, 'Library', 'Application Support', 'mindstone-rebel'));
    expectUnsafe(home);
    expectUnsafe(path.join(home, '.super-mcp'));
    expectUnsafe('/Users/x/realproject');
  });

  it('rejects Windows app data roots in test context', () => {
    process.env.NODE_ENV = 'test';
    process.env.APPDATA = path.join(os.tmpdir(), 'rebel-guard-appdata');

    expectUnsafe(path.join(process.env.APPDATA, 'mindstone-rebel'));
  });

  it('is a no-op outside test context for every otherwise unsafe data root', () => {
    process.env.NODE_ENV = 'development';
    const home = os.homedir();
    const unsafeRoots = [
      undefined,
      '',
      '/data',
      path.join(home, 'Library', 'Application Support', 'mindstone-rebel'),
      home,
      path.join(home, '.super-mcp'),
      '/Users/x/realproject',
    ];

    for (const unsafeRoot of unsafeRoots) {
      expect(() => assertTestDataRootSafe(unsafeRoot)).not.toThrow();
    }
  });
});
