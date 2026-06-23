import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Stage 2 (260611_calendar-followups): typed SyncIssue construction at the
// direct-sync writer chokepoint. Unlike directCalendarSync.refreshFailure.test.ts
// this harness uses the REAL meetingCacheStore (only @core/storeFactory is
// in-memory), so assertions run against the actual persisted cache object —
// the email/slug-leak kill is pinned at the persistence boundary:
// JSON.stringify(persisted cache) must contain no raw email and no
// connector-instance slug, for W2-W5-shaped failures ([GPT-F1/DA/RS-F1]).
// ---------------------------------------------------------------------------

type StorePayload = Record<string, unknown>;

const storeStateByName: Record<string, StorePayload> = {};
const fileContents = new Map<string, string>();
let googleAccountSlugs: string[] = [];

const readFileMock = vi.fn();
const writeFileMock = vi.fn();
const readdirMock = vi.fn();
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

function seedMicrosoftAccount(email: string): void {
  fileContents.set(
    '/mock-data/microsoft-mcp/accounts.json',
    JSON.stringify({ accounts: [{ email }] }),
  );
}

/** The whole persisted store payload, stringified — the leak assertion surface. */
function persistedCacheJson(): string {
  return JSON.stringify(storeStateByName['meeting-cache'] ?? {});
}

function persistedCache(): Record<string, unknown> {
  return (storeStateByName['meeting-cache']?.cache ?? {}) as Record<string, unknown>;
}

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
  recordGoogleOAuthRefreshFailure: vi.fn(),
}));

type DirectCalendarSyncModule = typeof import('../directCalendarSync');
type RefreshFailureStoreModule = typeof import('../oauthRefreshFailureStore');

let directCalendarSync: DirectCalendarSyncModule;
let refreshFailureStore: RefreshFailureStoreModule;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-06-11T10:00:00.000Z'));
  vi.restoreAllMocks();

  for (const key of Object.keys(storeStateByName)) {
    delete storeStateByName[key];
  }
  fileContents.clear();
  googleAccountSlugs = [];
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

  // 260617_calendar-cache-transient-debounce: these tests trigger a SINGLE
  // failed sync and assert the issues persist (leak-kill / transient-copy
  // contracts). The new debounce withholds failure-class issues until the 2nd
  // consecutive failure, which would make those assertions VACUOUS — pre-arm
  // the streak to the surface threshold so the single failed sync persists.
  // (The debounce itself is covered in meetingCacheStore / calendarSyncFailureStreak tests.)
  const failureStreak = await import('@core/services/calendarSyncFailureStreak');
  failureStreak.resetCalendarSyncFailureStreakForTesting(failureStreak.FAILURE_SURFACE_THRESHOLD);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

const GOOGLE_SLUG = 'GoogleWorkspace-teammember-mindstone-com';
const GOOGLE_EMAIL = '[Mindstone-email]';
const BODY_EMAIL = 'attendee-leak@example.com';
const MICROSOFT_EMAIL = '[Mindstone-email]';

describe('directCalendarSync persisted sync issues contain no email/slug (red-first leak kill)', () => {
  it('W2-shaped Google per-calendar failure: persisted cache JSON contains no account email, no API-body email, no connector-instance slug', async () => {
    seedGoogleAccount(GOOGLE_SLUG, GOOGLE_EMAIL, Date.now() + 60 * 60 * 1000);

    // Events API blows up with an error body that itself embeds an email and a slug.
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => `calendar for ${BODY_EMAIL} not reachable via ${GOOGLE_SLUG}`,
    } as Response);

    await directCalendarSync.performDirectCalendarSync();

    const persisted = persistedCacheJson();
    expect(persisted).not.toContain(GOOGLE_EMAIL);
    expect(persisted).not.toContain(BODY_EMAIL);
    expect(persisted).not.toContain(GOOGLE_SLUG);

    // Green pins: typed source of truth + derived display-safe legacy string.
    const cache = persistedCache();
    const issues = cache.syncIssues as Array<Record<string, unknown>>;
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      kind: 'calendar_fetch_failed',
      provider: 'google',
      connector: 'GoogleWorkspace',
    });
    expect(cache.syncWarnings).toEqual(['GoogleWorkspace: a calendar could not be fetched during sync']);
  });

  it('W4/W5-shaped Microsoft failure: persisted cache JSON contains no account email', async () => {
    seedMicrosoftAccount(MICROSOFT_EMAIL);

    const { fetchMicrosoftGraph } = await import('../microsoftGraphFetch');
    vi.mocked(fetchMicrosoftGraph).mockRejectedValue(
      new Error(`Graph error while fetching calendar for ${MICROSOFT_EMAIL}`),
    );

    await directCalendarSync.performDirectCalendarSync();

    const persisted = persistedCacheJson();
    expect(persisted).not.toContain(MICROSOFT_EMAIL);
  });

  it('W1-shaped transient auth warning: persisted cache JSON contains no slug (email-domain accountRef allowed)', async () => {
    const slug = 'GoogleWorkspace-flaky-mindstone-com';
    const now = Date.now();
    seedGoogleAccount(slug, '[Mindstone-email]', now - 60_000);
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    refreshFailureStore.recordFailure(slug, 'invalid_grant', now, { provider: 'google' });

    // Token refresh fails transiently (network error shape).
    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ error: 'invalid_grant' }),
    } as Response);

    await directCalendarSync.performDirectCalendarSync();

    const persisted = persistedCacheJson();
    expect(persisted).not.toContain(slug);
    expect(persisted).not.toContain('[Mindstone-email]');
    // Invariant 1 (carried forward): the transient class still reaches the
    // persisted set — recognisable copy survives, identifiers do not.
    expect(persisted).toContain('token refresh is temporarily unavailable');
  });

  it('rewritten W2-W5 logger lines carry no email/slug (Sentry breadcrumb channel) [Claude-F1/RS]', async () => {
    seedGoogleAccount(GOOGLE_SLUG, GOOGLE_EMAIL, Date.now() + 60 * 60 * 1000);
    seedMicrosoftAccount(MICROSOFT_EMAIL);

    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => `calendar for ${BODY_EMAIL} not reachable via ${GOOGLE_SLUG}`,
    } as Response);
    const { fetchMicrosoftGraph } = await import('../microsoftGraphFetch');
    vi.mocked(fetchMicrosoftGraph).mockRejectedValue(
      new Error(`Graph error while fetching calendar for ${MICROSOFT_EMAIL}`),
    );

    await directCalendarSync.performDirectCalendarSync();

    const allLogLines = JSON.stringify([
      ...loggerMock.warn.mock.calls,
      ...loggerMock.error.mock.calls,
    ]);
    expect(allLogLines).not.toContain(GOOGLE_EMAIL);
    expect(allLogLines).not.toContain(BODY_EMAIL);
    expect(allLogLines).not.toContain(MICROSOFT_EMAIL);
    expect(allLogLines).not.toContain(GOOGLE_SLUG);
  });

  it('all-success run still overwrites both representations with [] (invariant 3)', async () => {
    seedGoogleAccount('GoogleWorkspace-fine-mindstone-com', '[Mindstone-email]', Date.now() + 60 * 60 * 1000);

    (global.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ items: [] }),
    } as Response);

    // Seed a stale warning set from a previous failing run.
    storeStateByName['meeting-cache'] = {
      version: 1,
      cache: {
        meetings: [],
        populatedAt: Date.now() - 60_000,
        syncWarnings: ['GoogleWorkspace: stale warning'],
        syncIssues: [{ kind: 'account_sync_failed', provider: 'google', connector: 'GoogleWorkspace' }],
      },
    };

    await directCalendarSync.performDirectCalendarSync();

    const cache = persistedCache();
    expect(cache.syncWarnings).toEqual([]);
    expect(cache.syncIssues).toEqual([]);
  });
});
