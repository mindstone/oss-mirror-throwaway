import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('electronStoreShim permissions', () => {
  const originalUserData = process.env.REBEL_USER_DATA;
  let userDataDir = '';

  beforeEach(() => {
    vi.resetModules();
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebel-cloud-store-perms-'));
    process.env.REBEL_USER_DATA = userDataDir;
  });

  afterEach(() => {
    vi.resetModules();
    if (originalUserData === undefined) {
      delete process.env.REBEL_USER_DATA;
    } else {
      process.env.REBEL_USER_DATA = originalUserData;
    }
  });

  it.skipIf(process.platform === 'win32')('persists with 0600 file mode and 0700 parent directory mode', async () => {
    const { Store } = await import('../electronStoreShim');
    const store = new Store<{ encryptedFlyApiToken?: string }>({
      name: 'fly-tokens',
      defaults: {},
    });

    store.set('encryptedFlyApiToken', 'token');

    const filePath = path.join(userDataDir, 'fly-tokens.json');
    const fileMode = fs.statSync(filePath).mode & 0o777;
    const parentMode = fs.statSync(path.dirname(filePath)).mode & 0o777;

    expect(fileMode).toBe(0o600);
    expect(parentMode).toBe(0o700);
  });
});
