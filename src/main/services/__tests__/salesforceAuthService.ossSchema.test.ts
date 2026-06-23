/**
 * Regression tests locking the on-disk shape of Salesforce auth artifacts to
 * the schema that the OSS package
 * (`@mindstone-engineering/mcp-server-salesforce` v0.1.x) expects to read.
 *
 * Background — the host writes accounts.json + token files; the spawned MCP
 * child reads them via `loadAccounts()` / `loadToken(account.id)`. Any drift
 * in:
 *   - account field names (camelCase vs snake_case)
 *   - presence of `id`
 *   - filename sanitization regex
 * causes `getActiveToken()` to fail with `NO_CREDENTIALS` and
 * `salesforce_list_connected_accounts` to report every account as `expired`,
 * even when fresh tokens are on disk. We hit this in the wild on
 * 2026-04-30 — see Round 5 in
 * `docs/plans/260430_salesforce_oauth_browser_never_opens_settings.md`.
 *
 * These tests use real temp directories (NOT mocks) so we verify byte-for-byte
 * compatibility with what `dist/auth.js` from the OSS package will read.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Mock electron BEFORE importing the service, point userData at a temp dir
// we'll set up in beforeEach. We mutate this variable from inside the test;
// the mock reads it lazily.
let mockUserDataDir = '';
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((name: string) => {
      if (name === 'userData') return mockUserDataDir;
      return '/mock';
    }),
  },
  shell: { openExternal: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('../oauthPrimitives', () => ({
  generateCsrfState: vi.fn().mockReturnValue('mock-csrf-state'),
  fetchWithTimeoutBestEffort: vi.fn().mockResolvedValue({ ok: true }),
  bringAppToForeground: vi.fn(),
}));

vi.mock('@core/services/settingsStore', () => ({
  setSettingsStoreAdapter: vi.fn(),
  getSettings: vi.fn().mockReturnValue({}),
}));

import { getSalesforceAccounts, removeSalesforceAccount, handleSalesforceOAuthCallback, startSalesforceAuth, cancelSalesforceAuth } from '../salesforceAuthService';
import { shell } from 'electron';

const SAMPLE_USERNAME = '[external-email]';
const SAMPLE_INSTANCE = 'https://orgfarm-336facfbd4-dev-ed.develop.my.salesforce.com';

/**
 * The OSS package's sanitizeFilename regex — kept here verbatim so a future
 * code change in the host or OSS package immediately fails this test if the
 * two diverge. Must stay in sync with
 * `node_modules/@mindstone-engineering/mcp-server-salesforce/dist/auth.js`.
 */
function ossSanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '-');
}

function configDir(): string {
  return path.join(mockUserDataDir, 'mcp', 'salesforce');
}
function accountsPath(): string {
  return path.join(configDir(), 'accounts.json');
}
function credentialsDir(): string {
  return path.join(configDir(), 'credentials');
}

async function readJson<T>(filePath: string): Promise<T> {
  const raw = await fsp.readFile(filePath, 'utf-8');
  return JSON.parse(raw) as T;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, JSON.stringify(value, null, 2));
}

describe('salesforceAuthService — OSS schema compatibility', () => {
  beforeEach(async () => {
    mockUserDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sf-oss-schema-'));
  });

  afterEach(async () => {
    if (mockUserDataDir) {
      await fsp.rm(mockUserDataDir, { recursive: true, force: true });
      mockUserDataDir = '';
    }
  });

  describe('migrate-on-load (loadAccounts)', () => {
    it('upgrades a legacy entry (camelCase, no id) to OSS shape on next read', async () => {
      // Seed the file in the legacy shape that pre-2026-04-30 builds wrote
      await writeJson(accountsPath(), {
        accounts: [
          {
            username: SAMPLE_USERNAME,
            instanceUrl: SAMPLE_INSTANCE,
            organizationId: '00Dg50000094kTiEAI',
          },
        ],
      });
      // Trigger loadAccounts → migrate → save
      await getSalesforceAccounts();

      const after = await readJson<{ accounts: Array<Record<string, unknown>> }>(
        accountsPath()
      );
      expect(after.accounts).toHaveLength(1);
      const acc = after.accounts[0];
      // OSS-required fields all present
      expect(acc.id).toBe(ossSanitizeFilename(SAMPLE_USERNAME));
      expect(acc.username).toBe(SAMPLE_USERNAME);
      expect(acc.instance_url).toBe(SAMPLE_INSTANCE);
      expect(acc.is_sandbox).toBe(false);
      expect(typeof acc.connected_at).toBe('string');
      // Legacy camelCase field is gone
      expect(acc.instanceUrl).toBeUndefined();
      // organizationId migrated to organization_id (OSS naming)
      expect(acc.organization_id).toBe('00Dg50000094kTiEAI');
    });

    it('renames a legacy-named token file to the OSS-compatible filename', async () => {
      // Legacy host stripped dots: `harry-3-65e95be9a4c4-agentforce-com.token.json`
      const legacyName = SAMPLE_USERNAME.replace(/[^a-zA-Z0-9]/g, '-');
      const legacyTokenPath = path.join(credentialsDir(), `${legacyName}.token.json`);
      await writeJson(legacyTokenPath, {
        access_token: 'legacy-access',
        refresh_token: 'legacy-refresh',
        instance_url: SAMPLE_INSTANCE,
        expires_at: Date.now() + 3_600_000,
      });
      await writeJson(accountsPath(), {
        accounts: [
          { username: SAMPLE_USERNAME, instanceUrl: SAMPLE_INSTANCE },
        ],
      });

      await getSalesforceAccounts();

      // New OSS-compatible filename (keeps dots) should now exist
      const newPath = path.join(
        credentialsDir(),
        `${ossSanitizeFilename(SAMPLE_USERNAME)}.token.json`
      );
      await expect(fsp.access(newPath)).resolves.toBeUndefined();
      // Legacy file should have been moved away
      await expect(fsp.access(legacyTokenPath)).rejects.toThrow();
    });

    it('reports active status when host-written token + account match OSS reader expectations', async () => {
      // Simulate the post-fix state: token file at OSS-sanitized path, accounts.json
      // already in OSS shape, expires_at in the future.
      const accountId = ossSanitizeFilename(SAMPLE_USERNAME);
      await writeJson(accountsPath(), {
        accounts: [
          {
            id: accountId,
            username: SAMPLE_USERNAME,
            instance_url: SAMPLE_INSTANCE,
            is_sandbox: false,
            connected_at: new Date().toISOString(),
          },
        ],
      });
      await writeJson(path.join(credentialsDir(), `${accountId}.token.json`), {
        access_token: 'fresh-access',
        refresh_token: 'fresh-refresh',
        instance_url: SAMPLE_INSTANCE,
        expires_at: Date.now() + 2 * 60 * 60 * 1000,
        issued_at: String(Date.now()),
      });

      const accounts = await getSalesforceAccounts();
      expect(accounts).toHaveLength(1);
      expect(accounts[0]).toEqual({
        username: SAMPLE_USERNAME,
        instanceUrl: SAMPLE_INSTANCE,
        status: 'active',
      });
    });

    it('does NOT churn on already-canonical accounts.json (idempotent)', async () => {
      const accountId = ossSanitizeFilename(SAMPLE_USERNAME);
      const canonical = {
        accounts: [
          {
            id: accountId,
            username: SAMPLE_USERNAME,
            instance_url: SAMPLE_INSTANCE,
            is_sandbox: false,
            connected_at: '2026-04-30T12:00:00.000Z',
            organization_id: '00Dg50000094kTiEAI',
          },
        ],
      };
      await writeJson(accountsPath(), canonical);
      const before = await fsp.readFile(accountsPath(), 'utf-8');

      await getSalesforceAccounts();

      const after = await fsp.readFile(accountsPath(), 'utf-8');
      expect(after).toBe(before);
    });
  });

  describe('OAuth completion — account ordering for OSS getActiveToken()', () => {
    /**
     * Stub fetch so the OAuth callback can complete without hitting Salesforce.
     * Returns a fake token + identity payload.
     */
    function stubFetchForOAuth(username: string, instanceUrl: string): () => void {
      const originalFetch = globalThis.fetch;
      const stub = vi.fn(async (input: string | URL | Request) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('/services/oauth2/token')) {
          return {
            ok: true,
            json: async () => ({
              access_token: 'access-' + username,
              refresh_token: 'refresh-' + username,
              instance_url: instanceUrl,
              id: 'https://login.salesforce.com/id/00Dxx/005xx',
              issued_at: String(Date.now()),
              signature: 'sig',
            }),
          } as Response;
        }
        if (url.includes('/id/')) {
          return {
            ok: true,
            json: async () => ({ username, organization_id: '00Dxx0000001gPLEAY' }),
          } as Response;
        }
        return { ok: false, status: 404, text: async () => 'unexpected' } as Response;
      });
      globalThis.fetch = stub as unknown as typeof fetch;
      return () => {
        globalThis.fetch = originalFetch;
      };
    }

    async function completeOAuth(username: string, instanceUrl: string): Promise<void> {
      cancelSalesforceAuth();
      const restoreFetch = stubFetchForOAuth(username, instanceUrl);
      try {
        const authPromise = startSalesforceAuth('cid', 'csecret');
        // Pluck the state token out of the OAuth URL so the callback signature matches
        const calls = (shell.openExternal as ReturnType<typeof vi.fn>).mock.calls;
        const oauthUrl = calls[calls.length - 1][0] as string;
        const state = new URL(oauthUrl).searchParams.get('state') ?? 'mock-csrf-state';
        // Drive the deep-link callback
        const callbackUrl = `mindstone://salesforce/callback?code=fakecode&state=${encodeURIComponent(state)}`;
        await handleSalesforceOAuthCallback(callbackUrl);
        await authPromise;
      } finally {
        restoreFetch();
      }
    }

    it('places the just-connected account at index 0 (so OSS getActiveToken picks it)', async () => {
      // Pre-seed an older account at index 0
      const stale = '[external-email]';
      const staleId = ossSanitizeFilename(stale);
      await writeJson(accountsPath(), {
        accounts: [
          {
            id: staleId,
            username: stale,
            instance_url: 'https://stale.example.salesforce.com',
            is_sandbox: false,
            connected_at: '2026-03-09T09:37:00.000Z',
          },
        ],
      });
      // Also drop a stale token so loadAccounts doesn't trigger token-rename migration
      await writeJson(path.join(credentialsDir(), `${staleId}.token.json`), {
        access_token: 'stale',
        instance_url: 'https://stale.example.salesforce.com',
        expires_at: 0, // long expired
      });

      // Now complete a fresh OAuth for the new username
      await completeOAuth(SAMPLE_USERNAME, SAMPLE_INSTANCE);

      const after = await readJson<{ accounts: Array<Record<string, unknown>> }>(accountsPath());
      expect(after.accounts).toHaveLength(2);
      // Just-connected account MUST be first — OSS getActiveToken() picks accounts[0]
      expect(after.accounts[0].username).toBe(SAMPLE_USERNAME);
      expect(after.accounts[0].id).toBe(ossSanitizeFilename(SAMPLE_USERNAME));
      expect(after.accounts[1].username).toBe(stale);
    });

    it('moves a re-connected existing account back to index 0 (no duplicate entries)', async () => {
      const staleId = ossSanitizeFilename(SAMPLE_USERNAME);
      // Same username already at position 1
      await writeJson(accountsPath(), {
        accounts: [
          {
            id: 'other-account',
            username: '[external-email]',
            instance_url: 'https://other.salesforce.com',
            is_sandbox: false,
            connected_at: '2026-03-01T00:00:00.000Z',
          },
          {
            id: staleId,
            username: SAMPLE_USERNAME,
            instance_url: SAMPLE_INSTANCE,
            is_sandbox: false,
            connected_at: '2026-03-15T00:00:00.000Z',
          },
        ],
      });

      await completeOAuth(SAMPLE_USERNAME, SAMPLE_INSTANCE);

      const after = await readJson<{ accounts: Array<Record<string, unknown>> }>(accountsPath());
      // Still only two entries (not duplicated) AND the re-connected one is at the front
      expect(after.accounts).toHaveLength(2);
      expect(after.accounts[0].username).toBe(SAMPLE_USERNAME);
      expect(after.accounts[1].username).toBe('[external-email]');
      // connected_at refreshed for the re-connected account
      expect(typeof after.accounts[0].connected_at).toBe('string');
      expect((after.accounts[0].connected_at as string) > '2026-04-01').toBe(true);
    });
  });

  describe('removeSalesforceAccount', () => {
    it('deletes the OSS-named token file even when accounts.json still in legacy shape', async () => {
      // Seed legacy accounts + a legacy-named token
      const legacyName = SAMPLE_USERNAME.replace(/[^a-zA-Z0-9]/g, '-');
      const accountId = ossSanitizeFilename(SAMPLE_USERNAME);
      await writeJson(path.join(credentialsDir(), `${legacyName}.token.json`), {
        access_token: 'a',
        instance_url: SAMPLE_INSTANCE,
      });
      await writeJson(accountsPath(), {
        accounts: [{ username: SAMPLE_USERNAME, instanceUrl: SAMPLE_INSTANCE }],
      });

      // First load triggers migration (legacy → OSS-named token file)
      await removeSalesforceAccount(SAMPLE_USERNAME);

      // Both legacy and OSS-named files should be gone
      await expect(fsp.access(path.join(credentialsDir(), `${legacyName}.token.json`))).rejects.toThrow();
      await expect(fsp.access(path.join(credentialsDir(), `${accountId}.token.json`))).rejects.toThrow();

      // Account removed from accounts.json
      const after = await readJson<{ accounts: unknown[] }>(accountsPath());
      expect(after.accounts).toHaveLength(0);
    });
  });
});
