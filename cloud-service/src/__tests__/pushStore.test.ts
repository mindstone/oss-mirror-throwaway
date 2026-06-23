import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('pushStore data root', () => {
  const originalUserData = process.env.REBEL_USER_DATA;
  let tempUserData: string;

  beforeEach(() => {
    vi.resetModules();
    tempUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'rebel-push-store-'));
    process.env.REBEL_USER_DATA = tempUserData;
  });

  afterEach(() => {
    if (originalUserData === undefined) delete process.env.REBEL_USER_DATA;
    else process.env.REBEL_USER_DATA = originalUserData;
    fs.rmSync(tempUserData, { recursive: true, force: true });
  });

  it('persists push tokens under REBEL_USER_DATA', async () => {
    const { registerToken, getTokens } = await import('../pushStore');

    registerToken('device-token', 'ios');

    const tokenFile = path.join(tempUserData, 'push-tokens.json');
    expect(fs.existsSync(tokenFile)).toBe(true);
    expect(JSON.parse(fs.readFileSync(tokenFile, 'utf8'))).toEqual({
      tokens: [expect.objectContaining({ deviceToken: 'device-token', platform: 'ios' })],
    });
    expect(getTokens()).toEqual([
      expect.objectContaining({ deviceToken: 'device-token', platform: 'ios' }),
    ]);
  });
});
