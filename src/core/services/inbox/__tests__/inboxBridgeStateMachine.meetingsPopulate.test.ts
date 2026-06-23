import http from 'node:http';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

// ---------------------------------------------------------------------------
// Stage 2 (260611_calendar-followups): POST /meetings/populate writer
// chokepoint. Model-authored warning strings are fail-closed-filtered and
// wrapped as typed bridge_reported issues; the persisted cache object must
// contain no raw email and no connector-instance slug even when the model
// echoes them verbatim ([GPT-F1/DA/RS-F1] red-first leak kill).
// Uses the REAL meetingCacheStore over an in-memory @core/storeFactory.
// ---------------------------------------------------------------------------

type StorePayload = Record<string, unknown>;

const storeStateByName: Record<string, StorePayload> = {};

function ensureStore(name: string, defaults?: StorePayload): StorePayload {
  if (!storeStateByName[name]) {
    storeStateByName[name] = defaults ? (JSON.parse(JSON.stringify(defaults)) as StorePayload) : {};
  }
  return storeStateByName[name];
}

const getSettingsMock = vi.hoisted(() => vi.fn());

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

vi.mock('@core/services/settingsStore', () => ({
  getSettings: getSettingsMock,
}));

vi.mock('@main/services/meetingPrepReconciler', () => ({
  attachPrepPathsFromDisk: vi.fn(async (meetings: unknown) => meetings),
}));

import {
  handleBundledInboxBridgeRequest,
  setBundledInboxBridgeToken,
} from '../inboxBridgeStateMachine';

const BRIDGE_TOKEN = 'test-bridge-token';

let server: http.Server;
let baseUrl = '';

async function startBridgeServer(): Promise<void> {
  server = http.createServer((req, res) => {
    void handleBundledInboxBridgeRequest(req, res);
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve());
    server.on('error', reject);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to resolve bridge server address');
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
}

async function stopBridgeServer(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function postMeetingsPopulate(payload: Record<string, unknown>): Promise<{
  status: number;
  body: Record<string, unknown>;
}> {
  const response = await fetch(`${baseUrl}/meetings/populate`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${BRIDGE_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

function persistedCacheJson(): string {
  return JSON.stringify(storeStateByName['meeting-cache'] ?? {});
}

function persistedCache(): Record<string, unknown> {
  return (storeStateByName['meeting-cache']?.cache ?? {}) as Record<string, unknown>;
}

const MODEL_EMAIL = '[Mindstone-email]';
const MODEL_SLUG = 'GoogleWorkspace-teammember-mindstone-com';

const VALID_MEETING = {
  id: 'google:evt-1',
  calendarEventId: 'evt-1',
  calendarSource: 'google:cal',
  title: 'Standup',
  startTime: '2026-06-11T09:00:00.000Z',
  endTime: '2026-06-11T09:30:00.000Z',
  participants: ['Alice'],
};

describe('inboxBridgeStateMachine POST /meetings/populate typed sync issues', () => {
  beforeAll(async () => {
    await startBridgeServer();
  });

  beforeEach(() => {
    setBundledInboxBridgeToken(BRIDGE_TOKEN);
    for (const key of Object.keys(storeStateByName)) {
      delete storeStateByName[key];
    }
    getSettingsMock.mockReturnValue({
      coreDirectory: '/tmp/workspace',
      calendar: {
        useOtherCalendarProvider: true,
      },
    });
  });

  afterEach(() => {
    setBundledInboxBridgeToken(null);
    vi.clearAllMocks();
  });

  afterAll(async () => {
    setBundledInboxBridgeToken(null);
    await stopBridgeServer();
  });

  it('model-echoed emails/slugs never reach the persisted cache object (red-first leak kill)', async () => {
    const response = await postMeetingsPopulate({
      meetings: [VALID_MEETING],
      syncWarnings: [
        `${MODEL_SLUG}: auth error for ${MODEL_EMAIL}`,
        'No calendar sources connected',
      ],
    });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);

    const persisted = persistedCacheJson();
    expect(persisted).not.toContain(MODEL_EMAIL);
    expect(persisted).not.toContain(MODEL_SLUG);
  });

  it('keeps the fail-closed typeof === "string" filter and synthesizes validation_skipped as a typed count', async () => {
    const response = await postMeetingsPopulate({
      meetings: [VALID_MEETING, { id: 'broken' }],
      syncWarnings: ['CalendarMCP: auth error', 42, null, { kind: 'sneaky' }],
    });

    expect(response.status).toBe(200);
    expect(response.body.count).toBe(1);
    expect(response.body.skipped).toBe(1);
    // Response warnings stay string-typed for the model/MCP contract.
    expect(Array.isArray(response.body.warnings)).toBe(true);
    for (const w of response.body.warnings as unknown[]) {
      expect(typeof w).toBe('string');
    }

    const cache = persistedCache();
    const issues = cache.syncIssues as Array<Record<string, unknown>>;
    expect(issues).toHaveLength(2);
    expect(issues[0].kind).toBe('bridge_reported');
    expect(issues[1]).toEqual({ kind: 'validation_skipped', count: 1 });
    // Derived legacy strings are written atomically alongside (no skew window).
    expect(cache.syncWarnings).toHaveLength(2);
    expect((cache.syncWarnings as string[])[1]).toContain('1 meeting(s) skipped');
  });

  it('no warnings at all → both representations persist as []', async () => {
    const response = await postMeetingsPopulate({
      meetings: [VALID_MEETING],
    });

    expect(response.status).toBe(200);
    const cache = persistedCache();
    expect(cache.syncWarnings).toEqual([]);
    expect(cache.syncIssues).toEqual([]);
  });

  it('direct-sync-authoritative guard is untouched: populate is ignored without a cache write', async () => {
    getSettingsMock.mockReturnValue({
      coreDirectory: '/tmp/workspace',
      calendar: {
        useOtherCalendarProvider: false,
      },
    });

    const response = await postMeetingsPopulate({
      meetings: [VALID_MEETING],
      syncWarnings: [`auth error for ${MODEL_EMAIL}`],
    });

    expect(response.status).toBe(200);
    expect(response.body.count).toBe(0);
    expect(storeStateByName['meeting-cache']?.cache ?? null).toBeNull();
  });
});
