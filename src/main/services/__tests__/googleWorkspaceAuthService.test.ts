import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => process.env.__GOOGLE_TEST_USER_DATA__ ?? os.tmpdir()),
  },
  shell: { openExternal: vi.fn() },
}));

import { _testOnly } from '../googleWorkspaceAuthService';

describe('googleWorkspaceAuthService — loadAccounts error handling (MEDIUM fix)', () => {
  let tmpDir: string;
  let configDir: string;
  let accountsPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'google-ws-auth-test-'));
    process.env.__GOOGLE_TEST_USER_DATA__ = tmpDir;
    configDir = path.join(tmpDir, 'google-workspace-mcp');
    accountsPath = path.join(configDir, 'accounts.json');
    await fs.mkdir(configDir, { recursive: true });
  });

  afterEach(async () => {
    delete process.env.__GOOGLE_TEST_USER_DATA__;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns empty accounts when accounts.json does not exist (ENOENT)', async () => {
    const result = await _testOnly.loadAccounts();
    expect(result.accounts).toEqual([]);
  });

  it('throws on JSON parse failure (does not silently treat malformed file as empty)', async () => {
    await fs.writeFile(accountsPath, 'this is not json{[}', 'utf-8');
    await expect(_testOnly.loadAccounts()).rejects.toThrow();
  });

  it('throws on EACCES permission errors (does not silently drop existing accounts)', async () => {
    await fs.writeFile(
      accountsPath,
      JSON.stringify({
        accounts: [
          { email: '[Mindstone-email]', category: 'work', description: 'test' },
        ],
      }),
      'utf-8',
    );
    await fs.chmod(accountsPath, 0o000);
    try {
      await expect(_testOnly.loadAccounts()).rejects.toMatchObject({
        code: expect.stringMatching(/^EACCES|EPERM$/),
      });
    } finally {
      await fs.chmod(accountsPath, 0o600);
    }
  });
});

describe('googleWorkspaceAuthService — slug collision guard (HIGH fix)', () => {
  it('detects slug collision in projected accounts list (assertNoInstanceIdCollisions)', () => {
    expect(() =>
      _testOnly.assertNoInstanceIdCollisions([
        { email: '[Mindstone-email]', category: 'work', description: '' },
        { email: '[Mindstone-email]', category: 'work', description: '' },
      ]),
    ).toThrow(/collision/i);
  });

  it('passes for distinct emails with no collision', () => {
    expect(() =>
      _testOnly.assertNoInstanceIdCollisions([
        { email: 'a@example.com', category: 'work', description: '' },
        { email: 'b@example.com', category: 'work', description: '' },
        { email: 'c@example.com', category: 'work', description: '' },
      ]),
    ).not.toThrow();
  });

  it('passes for empty accounts list', () => {
    expect(() => _testOnly.assertNoInstanceIdCollisions([])).not.toThrow();
  });

  it('ignores accounts with blank emails (skipped by guard)', () => {
    expect(() =>
      _testOnly.assertNoInstanceIdCollisions([
        { email: '', category: 'work', description: '' },
        { email: '  ', category: 'work', description: '' },
        { email: 'real@example.com', category: 'work', description: '' },
      ]),
    ).not.toThrow();
  });
});
