import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  appDataPath: '/tmp/rebel-app-data',
  bootstrapMode: 'real' as 'real' | 'stub',
  getPath: vi.fn((name: string): string => {
    if (name === 'appData') return '/tmp/rebel-app-data';
    throw new Error(`Unexpected app path lookup: ${name}`);
  }),
  setPath: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    getPath: mocks.getPath,
    setPath: mocks.setPath,
  },
}));

vi.mock('@private/mindstone/mode', () => ({
  get PRIVATE_MINDSTONE_BOOTSTRAP_MODE() {
    return mocks.bootstrapMode;
  },
}));

async function importEnsureAppIdentity(mode: 'real' | 'stub'): Promise<void> {
  mocks.bootstrapMode = mode;
  vi.resetModules();
  await import('../ensureAppIdentity');
}

describe('ensureAppIdentity', () => {
  beforeEach(() => {
    mocks.bootstrapMode = 'real';
    mocks.getPath.mockClear();
    mocks.setPath.mockClear();
  });

  it('keeps enterprise userData on mindstone-rebel', async () => {
    await importEnsureAppIdentity('real');

    expect(mocks.getPath).toHaveBeenCalledWith('appData');
    expect(mocks.setPath).toHaveBeenCalledWith(
      'userData',
      path.join(mocks.appDataPath, 'mindstone-rebel'),
    );
  });

  it('uses isolated OSS userData when the private bootstrap mode is stub', async () => {
    await importEnsureAppIdentity('stub');

    expect(mocks.getPath).toHaveBeenCalledWith('appData');
    expect(mocks.setPath).toHaveBeenCalledWith(
      'userData',
      path.join(mocks.appDataPath, 'mindstone-rebel-oss'),
    );
  });
});
