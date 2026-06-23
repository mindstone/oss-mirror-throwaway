import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

 

type StorePayload = Record<string, unknown>;

const storeStateByName: Record<string, StorePayload> = {};
const fileContents = new Map<string, string>();
let googleAccountSlugs: string[] = [];

const readFileMock = vi.fn();
const writeFileMock = vi.fn();
const readdirMock = vi.fn();
const setCachedMeetingsMock = vi.fn();
const recordGoogleOAuthRefreshFailureMock = vi.fn();
const getSettingsMock = vi.fn((): Record<string, unknown> => ({
  coreDirectory: '/mock-core',
  calendar: {
    selectedCalendars: {},
  },
}));

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

function ensureStore(name: string, defaults?: StorePayload): StorePayload {
  if (!storeStateByName[name]) {
    storeStateByName[name] = defaults ? deepClone(defaults) : {};
  }
  return storeStateByName[name];
}

function makeEnoent(path: string): NodeJS.ErrnoException {
  const error = new Error(`ENOENT: no such file or directory, open '${path}'`) as NodeJS.ErrnoException;
  error.code = 'ENOENT';
  return error;
}

function getTokenPath(slug: string, email: string): string {
  const tokenFileName = email.replace(/@/g, '-').replace(/\./g, '-') + '.token.json';
  return `/mock-data/google-workspace-mcp/${slug}/credentials/${tokenFileName}`;
}

function seedGoogleAccount(slug: string, email: string, expiryDate: number): void {
  if (!googleAccountSlugs.includes(slug)) {
    googleAccountSlugs.push(slug);
  }

  const basePath = `/mock-data/google-workspace-mcp/${slug}`;
  fileContents.set(
    `${basePath}/accounts.json`,
    JSON.stringify({ accounts: [{ email }] }),
  );
  fileContents.set(
    getTokenPath(slug, email),
    JSON.stringify({
      access_token: `access-token-${slug}`,
      refresh_token: `refresh-token-${slug}`,
      expiry_date: expiryDate,
      token_type: 'Bearer',
      scope: 'calendar.readonly',
    }),
  );
}

// Shared logger instance so tests can assert on emitted log lines (Stage 2
// sweep tripwire privacy: counts/providers only, never slugs).
const loggerMock = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('@core/logger', () => ({
  createScopedLogger: () => loggerMock,
  logger: loggerMock,
}));

vi.mock('@core/storeFactory', () => ({
  createStore: vi.fn((opts: { name: string; defaults: StorePayload }) => {
    const name = opts.name;
    ensureStore(name, opts.defaults);

    return {
      get: (key: string) => ensureStore(name)[key],
      set: (key: string, value: unknown) => { ensureStore(name)[key] = value; },
      has: (key: string) => Object.prototype.hasOwnProperty.call(ensureStore(name), key),
      delete: (key: string) => { delete ensureStore(name)[key]; },
      clear: () => { storeStateByName[name] = {}; },
      get store() {
        return ensureStore(name);
      },
      set store(value: StorePayload) {
        storeStateByName[name] = value;
      },
      path: `/tmp/${name}.json`,
    };
  }),
}));

vi.mock('@core/utils/dataPaths', () => ({
  getDataPath: () => '/mock-data',
}));

vi.mock('@core/services/settingsStore', () => ({
  getSettings: () => getSettingsMock(),
}));

vi.mock('node:fs/promises', () => ({
  default: {
    readFile: (...args: unknown[]) => readFileMock(...args),
    writeFile: (...args: unknown[]) => writeFileMock(...args),
    readdir: (...args: unknown[]) => readdirMock(...args),
    chmod: vi.fn(async () => undefined),
  },
  readFile: (...args: unknown[]) => readFileMock(...args),
  writeFile: (...args: unknown[]) => writeFileMock(...args),
  readdir: (...args: unknown[]) => readdirMock(...args),
  chmod: vi.fn(async () => undefined),
}));

vi.mock('@core/utils/atomicCredentialWrite', () => ({
  atomicCredentialWrite: vi.fn(async (filePath: string, data: string) => {
    fileContents.set(normalizePath(filePath), data);
  }),
}));

vi.mock('../meetingCacheStore', async (importOriginal) => {
  // Keep the real exports (renderSyncIssue/makeSyncIssue — pure functions);
  // only the store-writing chokepoint is intercepted.
  const actual = await importOriginal<typeof import('../meetingCacheStore')>();
  return {
    ...actual,
    setCachedMeetings: (...args: unknown[]) => setCachedMeetingsMock(...args),
    reapplySkipState: (meetings: unknown) => meetings,
  };
});

vi.mock('../meetingPrepReconciler', () => ({
  attachPrepPathsFromDisk: async (meetings: unknown) => meetings,
}));

vi.mock('../microsoftGraphFetch', () => ({
  fetchMicrosoftGraph: vi.fn(),
}));

vi.mock('../oauthRefreshTelemetry', () => ({
  classifyGoogleEmailDomain: (email: string) => (
    email.endsWith('@gmail.com') || email.endsWith('@googlemail.com')
      ? 'consumer'
      : 'workspace'
  ),
  parseGoogleErrorCode: (bodyText: string) => {
    try {
      const parsed = JSON.parse(bodyText) as { error?: string };
      return typeof parsed.error === 'string' ? parsed.error : 'unknown';
    } catch {
      return 'unknown';
    }
  },
  recordGoogleOAuthRefreshFailure: (...args: unknown[]) => recordGoogleOAuthRefreshFailureMock(...args),
}));

type DirectCalendarSyncModule = typeof import('../directCalendarSync');
type RefreshFailureStoreModule = typeof import('../oauthRefreshFailureStore');

let directCalendarSync: DirectCalendarSyncModule;
let refreshFailureStore: RefreshFailureStoreModule;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-05-01T10:00:00.000Z'));
  vi.restoreAllMocks();

  for (const key of Object.keys(storeStateByName)) {
    delete storeStateByName[key];
  }
  fileContents.clear();
  googleAccountSlugs = [];
  setCachedMeetingsMock.mockReset();
  recordGoogleOAuthRefreshFailureMock.mockReset();
  getSettingsMock.mockReset();
  getSettingsMock.mockImplementation(() => ({
    coreDirectory: '/mock-core',
    calendar: {
      selectedCalendars: {},
    },
  }));

  readFileMock.mockReset();
  writeFileMock.mockReset();
  readdirMock.mockReset();
  loggerMock.debug.mockReset();
  loggerMock.info.mockReset();
  loggerMock.warn.mockReset();
  loggerMock.error.mockReset();

  readFileMock.mockImplementation(async (filePath: string) => {
    const normalizedPath = normalizePath(filePath);
    const value = fileContents.get(normalizedPath);
    if (value === undefined) {
      throw makeEnoent(normalizedPath);
    }
    return value;
  });

  writeFileMock.mockImplementation(async (filePath: string, value: string | Buffer) => {
    const normalizedPath = normalizePath(filePath);
    fileContents.set(normalizedPath, typeof value === 'string' ? value : value.toString('utf-8'));
  });

  readdirMock.mockImplementation(async (directoryPath: string) => {
    const normalizedPath = normalizePath(directoryPath);
    if (normalizedPath !== '/mock-data/google-workspace-mcp') {
      throw makeEnoent(normalizedPath);
    }
    return googleAccountSlugs.map((name) => ({
      name,
      isDirectory: () => true,
    }));
  });

  vi.stubEnv('GOOGLE_CLIENT_ID', 'test-client-id');
  vi.stubEnv('GOOGLE_CLIENT_SECRET', 'test-client-secret');
  global.fetch = vi.fn() as unknown as typeof fetch;

  vi.resetModules();
  directCalendarSync = await import('../directCalendarSync');
  refreshFailureStore = await import('../oauthRefreshFailureStore');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('directCalendarSync Stage 1 refresh-failure containment', () => {
  it('returns discriminated no_account result when no Google account exists', async () => {
    const result = await directCalendarSync.getGoogleAccessToken('GoogleWorkspace-missing');

    expect(result).toEqual({
      ok: false,
      reason: 'no_account',
      slug: 'GoogleWorkspace-missing',
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('short-circuits reauth_required and surfaces actionable direct-sync warnings', async () => {
    const slug = 'GoogleWorkspace-teammember-mindstone-com';
    const email = '[Mindstone-email]';
    const now = Date.now();
    seedGoogleAccount(slug, email, now - 60_000);

    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    refreshFailureStore.recordFailure(slug, 'invalid_grant', now, { provider: 'google' });
    refreshFailureStore.recordFailure(slug, 'invalid_grant', now + 1000, { provider: 'google' });
    refreshFailureStore.recordFailure(slug, 'invalid_grant', now + 2000, { provider: 'google' });

    const listResult = await directCalendarSync.listGoogleCalendars(slug);
    expect(listResult).toEqual({
      ok: false,
      reason: 'reauth_required',
      needsReconnect: true,
    });
    expect(global.fetch).not.toHaveBeenCalled();

    const discovered = await directCalendarSync.discoverAllCalendarAccounts();
    expect(discovered).toEqual([
      {
        calendarSource: `google:${email}`,
        provider: 'google',
        email,
        accountSlug: slug,
        needsReconnect: true,
      },
    ]);

    const syncResult = await directCalendarSync.performDirectCalendarSync();
    expect(syncResult.errors).toHaveLength(1);
    expect(syncResult.errors[0]).toContain('needs to reconnect');
    expect(syncResult.errors[0]).toContain(slug);
    // Stage 4 [GPT-F1]: the reauth skip is operational-only — it must NOT be
    // persisted as a cache syncWarning (oauthRefreshHealth owns that surface).
    expect(syncResult.reauthRequiredAccounts).toBe(1);
    expect(setCachedMeetingsMock).toHaveBeenCalledWith([], undefined, 'direct-sync');
  });

  it('clears refresh-failure state after a successful refresh', async () => {
    const slug = 'GoogleWorkspace-alex-mindstone-com';
    const email = '[Mindstone-email]';
    const now = Date.now();
    seedGoogleAccount(slug, email, now - 60_000);

    refreshFailureStore.recordFailure(slug, 'invalid_grant', now, { provider: 'google' });
    const initialState = refreshFailureStore.getStateForSlug(slug);
    expect(initialState).not.toBeNull();
    if (!initialState) {
      throw new Error('Expected initial failure state');
    }
    vi.setSystemTime(new Date(initialState.nextRetryAt + 1));

    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: 'fresh-access-token',
        expires_in: 3600,
      }),
    } as Response);

    const auth = await directCalendarSync.getGoogleAccessToken(slug);
    expect(auth).toEqual({
      ok: true,
      token: 'fresh-access-token',
      email,
    });
    expect(refreshFailureStore.getStateForSlug(slug)).toBeNull();
  });

  it('handles 5 invalid_grant ticks with backoff progression, reauth trip, short-circuit, and Sentry throttling', async () => {
    const slug = 'GoogleWorkspace-loop-mindstone-com';
    const email = '[Mindstone-email]';
    const baseNow = Date.now();
    seedGoogleAccount(slug, email, baseNow - 60_000);

    vi.spyOn(Math, 'random').mockReturnValue(0.5); // deterministic, no jitter delta

    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ error: 'invalid_grant' }),
    }));

    // Tick 1: network call, first failure -> 5m backoff
    const first = await directCalendarSync.getGoogleAccessToken(slug);
    const firstState = refreshFailureStore.getStateForSlug(slug);
    expect(first).toEqual({
      ok: false,
      reason: 'transient',
      slug,
      emailDomain: 'mindstone.com',
    });
    expect(firstState?.consecutiveFailures).toBe(1);
    expect(firstState?.nextRetryAt).toBe(baseNow + 5 * 60 * 1000);
    expect(global.fetch).toHaveBeenCalledTimes(1);

    if (!firstState) {
      throw new Error('Expected first failure state');
    }

    // Tick 2: after first window, second failure -> 15m backoff
    vi.setSystemTime(new Date(firstState.nextRetryAt + 1));
    const second = await directCalendarSync.getGoogleAccessToken(slug);
    const secondState = refreshFailureStore.getStateForSlug(slug);
    expect(second).toEqual({
      ok: false,
      reason: 'transient',
      slug,
      emailDomain: 'mindstone.com',
    });
    expect(secondState?.consecutiveFailures).toBe(2);
    expect(secondState?.nextRetryAt).toBe((firstState.nextRetryAt + 1) + 15 * 60 * 1000);
    expect(global.fetch).toHaveBeenCalledTimes(2);

    if (!secondState) {
      throw new Error('Expected second failure state');
    }

    // Tick 3: after second window, third invalid_grant trips reauth -> 1h backoff
    vi.setSystemTime(new Date(secondState.nextRetryAt + 1));
    const third = await directCalendarSync.getGoogleAccessToken(slug);
    const thirdState = refreshFailureStore.getStateForSlug(slug);
    expect(third).toEqual({
      ok: false,
      reason: 'reauth_required',
      slug,
      emailDomain: 'mindstone.com',
    });
    expect(thirdState?.consecutiveFailures).toBe(3);
    expect(thirdState?.needsReconnect).toBe(true);
    expect(thirdState?.nextRetryAt).toBe((secondState.nextRetryAt + 1) + 60 * 60 * 1000);
    expect(global.fetch).toHaveBeenCalledTimes(3);

    if (!thirdState) {
      throw new Error('Expected third failure state');
    }

    // Tick 4 + 5: short-circuit in reauth_required state (no network)
    vi.setSystemTime(new Date(thirdState.lastFailureAt + 60_000));
    const fourth = await directCalendarSync.getGoogleAccessToken(slug);
    expect(fourth).toEqual({
      ok: false,
      reason: 'reauth_required',
      slug,
      emailDomain: 'mindstone.com',
    });
    expect(global.fetch).toHaveBeenCalledTimes(3);

    vi.setSystemTime(new Date(thirdState.lastFailureAt + 120_000));
    const fifth = await directCalendarSync.getGoogleAccessToken(slug);
    expect(fifth).toEqual({
      ok: false,
      reason: 'reauth_required',
      slug,
      emailDomain: 'mindstone.com',
    });
    expect(global.fetch).toHaveBeenCalledTimes(3);

    expect(recordGoogleOAuthRefreshFailureMock.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(recordGoogleOAuthRefreshFailureMock.mock.calls.length).toBeLessThan(5);
  });
});

// ---------------------------------------------------------------------------
// Stage 2 (260611_calendar-cache-attention): orphan-latch sweep.
// A persisted needs-reconnect latch whose account no longer has an MCP config
// entry (the user-actionable universe, [RS-F3]) must be reconciled away by the
// sync loop — Greg's-machine fixture: account disconnected pre-fix, latch
// survived because disconnect never called clearForSlug.
// ---------------------------------------------------------------------------

describe('directCalendarSync Stage 2 orphan-latch sweep', () => {
  const MCP_CONFIG_PATH = '/mock-data/mcp-config.json';

  function useSettingsWithMcpConfig(): void {
    getSettingsMock.mockImplementation(() => ({
      coreDirectory: '/mock-core',
      calendar: { selectedCalendars: {} },
      mcpConfigFile: MCP_CONFIG_PATH,
    }));
  }

  function seedMcpConfig(serverNames: string[]): void {
    const mcpServers: Record<string, unknown> = {};
    for (const name of serverNames) {
      mcpServers[name] = { command: 'node', args: ['gw.js'] };
    }
    fileContents.set(MCP_CONFIG_PATH, JSON.stringify({ mcpServers }));
  }

  function seedLatch(slug: string, now = Date.now()): void {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    refreshFailureStore.recordFailure(slug, 'invalid_grant', now, { provider: 'google' });
    refreshFailureStore.recordFailure(slug, 'invalid_grant', now + 1000, { provider: 'google' });
    refreshFailureStore.recordFailure(slug, 'invalid_grant', now + 2000, { provider: 'google' });
    expect(refreshFailureStore.getStateForSlug(slug)?.needsReconnect).toBe(true);
  }

  it('sweeps a latched slug with no MCP config entry, keeps config-backed slugs even without a dir (Greg-machine replica + RS-F3 ghost protection)', async () => {
    useSettingsWithMcpConfig();
    // Config knows only the kept account; neither account has an instance dir
    // (kept = RS-F3 ghost-dir-less case: config entry alone protects it).
    seedMcpConfig(['GoogleWorkspace-kept-account', 'SomeOtherServer']);
    seedLatch('GoogleWorkspace-gone-account');
    seedLatch('GoogleWorkspace-kept-account', Date.now() + 10_000);

    await directCalendarSync.performDirectCalendarSync();

    expect(refreshFailureStore.getStateForSlug('GoogleWorkspace-gone-account')).toBeNull();
    expect(refreshFailureStore.getStateForSlug('GoogleWorkspace-kept-account')?.needsReconnect).toBe(true);
  });

  it('emits a count/provider-only tripwire warn when the sweep removes entries (never slugs) [DA-F1]', async () => {
    useSettingsWithMcpConfig();
    seedMcpConfig([]);
    seedLatch('GoogleWorkspace-gone-account');

    await directCalendarSync.performDirectCalendarSync();

    const sweepWarns = loggerMock.warn.mock.calls.filter(
      ([, msg]) => typeof msg === 'string' && msg.toLowerCase().includes('orphan'),
    );
    expect(sweepWarns).toHaveLength(1);
    const serialized = JSON.stringify(sweepWarns[0]);
    expect(serialized).toContain('GoogleWorkspace');
    expect(serialized).not.toContain('GoogleWorkspace-gone-account');
    expect(serialized).not.toContain('gone-account');
  });

  it('does not warn when there is nothing to sweep', async () => {
    useSettingsWithMcpConfig();
    seedMcpConfig(['GoogleWorkspace-kept-account']);
    seedLatch('GoogleWorkspace-kept-account');

    await directCalendarSync.performDirectCalendarSync();

    const sweepWarns = loggerMock.warn.mock.calls.filter(
      ([, msg]) => typeof msg === 'string' && msg.toLowerCase().includes('orphan'),
    );
    expect(sweepWarns).toHaveLength(0);
    expect(refreshFailureStore.getStateForSlug('GoogleWorkspace-kept-account')).not.toBeNull();
  });

  it('skips the sweep entirely when discovery fails with a non-ENOENT error (EMFILE) [RS-F1]', async () => {
    useSettingsWithMcpConfig();
    seedMcpConfig([]);
    seedLatch('GoogleWorkspace-gone-account');

    readdirMock.mockImplementation(async () => {
      const error = new Error('EMFILE: too many open files') as NodeJS.ErrnoException;
      error.code = 'EMFILE';
      throw error;
    });

    const result = await directCalendarSync.performDirectCalendarSync();

    // Sync still completes (no Google accounts to fetch), but no blind wipe.
    expect(result.googleAccounts).toBe(0);
    expect(refreshFailureStore.getStateForSlug('GoogleWorkspace-gone-account')?.needsReconnect).toBe(true);
  });

  it('treats ENOENT discovery (no accounts dir) as legitimately-zero accounts and still sweeps [RS-F1]', async () => {
    useSettingsWithMcpConfig();
    seedMcpConfig([]);
    seedLatch('GoogleWorkspace-gone-account');

    readdirMock.mockImplementation(async (directoryPath: string) => {
      throw makeEnoent(normalizePath(directoryPath));
    });

    await directCalendarSync.performDirectCalendarSync();

    expect(refreshFailureStore.getStateForSlug('GoogleWorkspace-gone-account')).toBeNull();
  });

  it('skips the sweep when the MCP config file is unreadable (parse error → keep-set unknown)', async () => {
    useSettingsWithMcpConfig();
    fileContents.set(MCP_CONFIG_PATH, 'not-json{{{');
    seedLatch('GoogleWorkspace-gone-account');

    await directCalendarSync.performDirectCalendarSync();

    expect(refreshFailureStore.getStateForSlug('GoogleWorkspace-gone-account')?.needsReconnect).toBe(true);
  });

  it('sweeps when the MCP config file itself is missing (legitimately zero entries)', async () => {
    useSettingsWithMcpConfig();
    // No fileContents entry for MCP_CONFIG_PATH → readFile throws ENOENT.
    seedLatch('GoogleWorkspace-gone-account');

    await directCalendarSync.performDirectCalendarSync();

    expect(refreshFailureStore.getStateForSlug('GoogleWorkspace-gone-account')).toBeNull();
  });

  it('skips the sweep when no MCP config path is configured (fail closed)', async () => {
    // Default settings: no mcpConfigFile.
    seedLatch('GoogleWorkspace-gone-account');

    await directCalendarSync.performDirectCalendarSync();

    expect(refreshFailureStore.getStateForSlug('GoogleWorkspace-gone-account')?.needsReconnect).toBe(true);
  });

  it('removes the latch for a ghost credential dir (dir still discovered, MCP config entry gone) [RS-F3 end-to-end]', async () => {
    // Interleaving the sweep was built for: disconnect removed the config
    // entry but the best-effort instance-dir rm -rf failed, so discovery
    // still finds the dir. Config (the user-actionable universe) defines the
    // keep-set, so the latch must still be swept.
    const slug = 'GoogleWorkspace-ghost-account';
    const email = '[Mindstone-email]';
    useSettingsWithMcpConfig();
    seedMcpConfig(['SomeOtherServer']); // no GW entries — ghost has no panel row
    seedGoogleAccount(slug, email, Date.now() + 60 * 60 * 1000); // valid token, dir present
    seedLatch(slug);

    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ items: [] }),
    } as Response);

    const result = await directCalendarSync.performDirectCalendarSync();

    // Dir WAS discovered (the fetch loop ran for it) …
    expect(result.googleAccounts).toBe(1);
    // … but the config-keyed sweep removed the latch anyway.
    expect(refreshFailureStore.getStateForSlug(slug)).toBeNull();
  });

  it('damps the tripwire warn while consecutive cycles remove an identical count, re-warns on change or after a clean cycle', async () => {
    useSettingsWithMcpConfig();
    seedMcpConfig([]);

    const orphanWarns = () => loggerMock.warn.mock.calls.filter(
      ([, msg]) => typeof msg === 'string' && msg.toLowerCase().includes('orphan'),
    );

    // Cycle 1: removes 1 → warns.
    seedLatch('GoogleWorkspace-ghost-account');
    await directCalendarSync.performDirectCalendarSync();
    expect(orphanWarns()).toHaveLength(1);

    // Cycle 2: persistent ghost re-latched, identical removal → damped.
    seedLatch('GoogleWorkspace-ghost-account');
    await directCalendarSync.performDirectCalendarSync();
    expect(orphanWarns()).toHaveLength(1);

    // Cycle 3: removed-count changes (2 ghosts) → warns again.
    seedLatch('GoogleWorkspace-ghost-a');
    seedLatch('GoogleWorkspace-ghost-b');
    await directCalendarSync.performDirectCalendarSync();
    expect(orphanWarns()).toHaveLength(2);

    // Cycle 4: clean cycle (nothing removed) resets the damping …
    await directCalendarSync.performDirectCalendarSync();
    expect(orphanWarns()).toHaveLength(2);

    // Cycle 5: … so a fresh episode with a previously-seen count warns again.
    seedLatch('GoogleWorkspace-ghost-account');
    await directCalendarSync.performDirectCalendarSync();
    expect(orphanWarns()).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Stage 4 (260611_calendar-cache-attention): persisted-vs-operational split
// [GPT-F1]. `reauth_required` auth failures must STOP flowing into the
// persisted cache warnings (`setCachedMeetings` → syncWarnings →
// calendarCacheHealth) — `oauthRefreshHealth` is the ONE needs-reconnect
// channel — while REMAINING visible operationally (DirectSyncResult + log
// counts). Transient-backoff warnings and thrown per-account sync errors KEEP
// flowing into the persisted set (plan invariant list).
// ---------------------------------------------------------------------------

describe('directCalendarSync Stage 4 persisted-vs-operational warning split [GPT-F1]', () => {
  function seedLatchedAccount(slug: string, email: string): void {
    const now = Date.now();
    seedGoogleAccount(slug, email, now - 60_000); // expiring token → auth path consulted
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    refreshFailureStore.recordFailure(slug, 'invalid_grant', now, { provider: 'google' });
    refreshFailureStore.recordFailure(slug, 'invalid_grant', now + 1000, { provider: 'google' });
    refreshFailureStore.recordFailure(slug, 'invalid_grant', now + 2000, { provider: 'google' });
    expect(refreshFailureStore.getStateForSlug(slug)?.needsReconnect).toBe(true);
  }

  it('(a) reauth_required produces NO persisted syncWarning but IS counted operationally', async () => {
    const slug = 'GoogleWorkspace-latched-mindstone-com';
    seedLatchedAccount(slug, '[Mindstone-email]');

    const result = await directCalendarSync.performDirectCalendarSync();

    // Operational visibility: the skipped account stays in the result.
    expect(result.reauthRequiredAccounts).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('needs to reconnect');

    // Persisted channel: NO reauth warning reaches the cache (undefined → []).
    expect(setCachedMeetingsMock).toHaveBeenCalledTimes(1);
    expect(setCachedMeetingsMock).toHaveBeenCalledWith([], undefined, 'direct-sync');

    // Operational log carries the skip as a COUNT (never slugs).
    const completeLogs = loggerMock.info.mock.calls.filter(
      ([, msg]) => msg === 'Direct calendar sync complete',
    );
    expect(completeLogs).toHaveLength(1);
    expect(completeLogs[0][0]).toMatchObject({ reauthSkippedAccounts: 1 });
    expect(JSON.stringify(completeLogs[0][0])).not.toContain(slug);
  });

  it('(b) transient auth warning still persists — now as a typed auth_transient issue (Stage 2, 260611_calendar-followups)', async () => {
    const slug = 'GoogleWorkspace-flaky-mindstone-com';
    const now = Date.now();
    seedGoogleAccount(slug, '[Mindstone-email]', now - 60_000);
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    refreshFailureStore.recordFailure(slug, 'invalid_grant', now, { provider: 'google' }); // streak 1 → transient backoff

    const result = await directCalendarSync.performDirectCalendarSync();

    expect(result.reauthRequiredAccounts).toBe(0);
    expect(setCachedMeetingsMock).toHaveBeenCalledWith(
      [],
      [{
        kind: 'auth_transient',
        provider: 'google',
        connector: 'GoogleWorkspace',
        accountRef: 'mindstone.com', // email DOMAIN only — never address/slug
      }],
      'direct-sync',
    );
    expect(result.errors).toEqual([
      expect.stringContaining('token refresh is temporarily unavailable'),
    ]);
  });

  it('(c) thrown Google and Microsoft sync errors still persist into syncWarnings', async () => {
    const slug = 'GoogleWorkspace-healthy-mindstone-com';
    seedGoogleAccount(slug, '[Mindstone-email]', Date.now() + 60 * 60 * 1000);
    fileContents.set(
      '/mock-data/microsoft-mcp/accounts.json',
      JSON.stringify({ accounts: [{ email: '[Mindstone-email]' }] }),
    );

    // Google calendar events API blows up …
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'internal error',
    } as Response);
    // … and so does Microsoft Graph.
    const { fetchMicrosoftGraph } = await import('../microsoftGraphFetch');
    vi.mocked(fetchMicrosoftGraph).mockRejectedValue(new Error('Graph exploded'));

    const result = await directCalendarSync.performDirectCalendarSync();

    expect(setCachedMeetingsMock).toHaveBeenCalledWith(
      [],
      expect.arrayContaining([
        expect.objectContaining({ kind: 'calendar_fetch_failed', provider: 'google', connector: 'GoogleWorkspace' }),
        expect.objectContaining({ kind: 'calendar_fetch_failed', provider: 'microsoft', connector: 'Microsoft365Calendar' }),
      ]),
      'direct-sync',
    );
    expect(result.reauthRequiredAccounts).toBe(0);
    expect(result.errors).toHaveLength(2);
  });

  it('(d) all-success sync passes undefined warnings (store overwrites syncWarnings with [])', async () => {
    const slug = 'GoogleWorkspace-fine-mindstone-com';
    seedGoogleAccount(slug, '[Mindstone-email]', Date.now() + 60 * 60 * 1000);

    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ items: [] }),
    } as Response);

    const result = await directCalendarSync.performDirectCalendarSync();

    expect(result.errors).toEqual([]);
    expect(result.reauthRequiredAccounts).toBe(0);
    // setCachedMeetings(meetings, undefined, …) → the store writes syncWarnings: []
    // (recovery path unchanged — pinned in core meetingCacheStore behavior).
    expect(setCachedMeetingsMock).toHaveBeenCalledWith([], undefined, 'direct-sync');
  });

  it('a mixed run persists ONLY the non-reauth warnings while counting the reauth skip', async () => {
    seedLatchedAccount('GoogleWorkspace-latched-mindstone-com', '[Mindstone-email]');

    const flakySlug = 'GoogleWorkspace-flaky-mindstone-com';
    const now = Date.now();
    seedGoogleAccount(flakySlug, '[Mindstone-email]', now - 60_000);
    refreshFailureStore.recordFailure(flakySlug, 'invalid_grant', now, { provider: 'google' });

    const result = await directCalendarSync.performDirectCalendarSync();

    const [, persistedIssues] = setCachedMeetingsMock.mock.calls[0] as [unknown, Array<Record<string, unknown>> | undefined, string];
    expect(persistedIssues).toHaveLength(1);
    // The transient class persists as a typed issue; the reauth class never
    // reaches the persisted set in either representation.
    expect(persistedIssues?.[0]).toMatchObject({ kind: 'auth_transient' });

    expect(result.reauthRequiredAccounts).toBe(1);
    expect(result.errors).toHaveLength(2); // operational superset: transient + reauth skip
  });
});
