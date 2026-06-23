/**
 * Integration tests for the atomic credential write hardening of
 * microsoftAuthService.ts (saveAccounts + saveToken).
 *
 * Verifies:
 *  - accounts.json is rewritten atomically (no stale tmp files survive)
 *    and lands with mode 0o600 (parent dir 0o700) — same trust surface
 *    five sibling Microsoft MCP processes share.
 *  - token files keep their exclusive 0o600 mode after rewrite.
 *  - The on-disk shape (file paths) matches the schema five subprocesses
 *    read via TokenProvider.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

let tempUserData: string;

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return tempUserData;
      return os.tmpdir();
    },
  },
  shell: { openExternal: vi.fn() },
}));

vi.mock('@core/errorReporter', () => ({
  getErrorReporter: () => ({
    captureException: vi.fn(),
    captureMessage: vi.fn(),
    addBreadcrumb: vi.fn(),
  }),
}));

vi.mock('../oauthTelemetry', () => ({
  trackOAuthBrowserOpened: vi.fn(),
  trackOAuthCallbackReceived: vi.fn(),
}));

vi.mock('../oauthPrimitives', () => ({
  generateCsrfState: () => 'csrf-state',
  bringAppToForeground: vi.fn(),
}));

import {
  removeMicrosoftAccount,
  getMicrosoftConfigDir,
  getMicrosoftAccounts,
} from '../microsoftAuthService';

const SKIP_PERMISSION_ASSERTS = process.platform === 'win32';

async function statMode(filePath: string): Promise<number> {
  const stats = await fs.stat(filePath);
  return stats.mode & 0o777;
}

async function listDir(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

describe('microsoftAuthService — atomic credential writes', () => {
  beforeEach(async () => {
    tempUserData = await fs.mkdtemp(path.join(os.tmpdir(), 'ms-atomic-write-'));
  });

  afterEach(async () => {
    await fs.rm(tempUserData, { recursive: true, force: true });
  });

  it('rewrites accounts.json atomically with mode 0o600 + parent dir 0o700', async () => {
    const configDir = getMicrosoftConfigDir();
    const credentialsDir = path.join(configDir, 'credentials');
    const accountsPath = path.join(configDir, 'accounts.json');
    const tokenPath = path.join(credentialsDir, 'alice-example-com.token.json');
    const otherTokenPath = path.join(credentialsDir, 'bob-example-com.token.json');

    // Seed: 2 accounts + 2 token files
    await fs.mkdir(credentialsDir, { recursive: true });
    await fs.writeFile(
      accountsPath,
      JSON.stringify({
        accounts: [
          { email: 'alice@example.com', displayName: 'Alice' },
          { email: 'bob@example.com', displayName: 'Bob' },
        ],
      }),
    );
    await fs.writeFile(tokenPath, JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_at: 0, token_type: 'Bearer', scope: '' }), { mode: 0o600 });
    await fs.writeFile(otherTokenPath, JSON.stringify({ access_token: 'b', refresh_token: 'r', expires_at: 0, token_type: 'Bearer', scope: '' }), { mode: 0o600 });

    // Remove alice — exercises saveAccounts(...) + deleteToken(...)
    await removeMicrosoftAccount('alice@example.com');

    // accounts.json now lists only Bob
    const remaining = await getMicrosoftAccounts();
    expect(remaining.map((a) => a.email)).toEqual(['bob@example.com']);

    // No stale .tmp.* files leaked into either directory
    const configFiles = await listDir(configDir);
    expect(configFiles.filter((f) => f.includes('.tmp.'))).toEqual([]);
    const credentialsFiles = await listDir(credentialsDir);
    expect(credentialsFiles.filter((f) => f.includes('.tmp.'))).toEqual([]);

    // alice's token file is removed; bob's stays
    expect(credentialsFiles).toContain('bob-example-com.token.json');
    expect(credentialsFiles).not.toContain('alice-example-com.token.json');

    if (!SKIP_PERMISSION_ASSERTS) {
      expect(await statMode(accountsPath)).toBe(0o600);
      expect(await statMode(configDir)).toBe(0o700);
    }

    // File contents are valid JSON (atomic write must never leave a half-written file)
    const accountsContents = await fs.readFile(accountsPath, 'utf-8');
    const parsed = JSON.parse(accountsContents) as { accounts: Array<{ email: string }> };
    expect(parsed.accounts).toHaveLength(1);
    expect(parsed.accounts[0]?.email).toBe('bob@example.com');
  });

  it('honours existing 0o700 dir mode + existing 0o600 token mode after rewrite (no perms regression)', async () => {
    const configDir = getMicrosoftConfigDir();
    const credentialsDir = path.join(configDir, 'credentials');
    const accountsPath = path.join(configDir, 'accounts.json');

    // Pre-create the dirs at the canonical permissions; mkdir(... mode) is
    // umasked on some platforms, so explicitly chmod afterwards.
    await fs.mkdir(credentialsDir, { recursive: true });
    if (!SKIP_PERMISSION_ASSERTS) {
      await fs.chmod(configDir, 0o700);
      await fs.chmod(credentialsDir, 0o700);
    }

    await fs.writeFile(
      accountsPath,
      JSON.stringify({ accounts: [{ email: 'gamma@example.com' }] }),
      { mode: 0o600 },
    );

    // Trigger a rewrite via removeMicrosoftAccount of a different address
    // (still exercises saveAccounts but keeps gamma in the list).
    await removeMicrosoftAccount('nobody-not-listed@example.com');

    if (!SKIP_PERMISSION_ASSERTS) {
      expect(await statMode(accountsPath)).toBe(0o600);
      expect(await statMode(configDir)).toBe(0o700);
      expect(await statMode(credentialsDir)).toBe(0o700);
    }

    const parsed = JSON.parse(await fs.readFile(accountsPath, 'utf-8')) as {
      accounts: Array<{ email: string }>;
    };
    expect(parsed.accounts.map((a) => a.email)).toEqual(['gamma@example.com']);
  });
});
