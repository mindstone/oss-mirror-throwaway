import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  configure,
  clearConfig,
  isConfigured,
  getSessions,
  getSession,
  getSessionFull,
  catchUpSession,
  catchUpContinuity,
  getTombstones,
  updateSession,
  deleteSession,
  getSettings,
  listSlackRecentSenders,
  removeSlackRecentSender,
  clearSlackRecentSenders,
  stopTurn,
  checkHealth,
  getContinuityMap,
  getSelfDiagnostics,
  readWorkspaceFile,
  CloudClientError,
  SessionTombstonedError,
  isTransientError,
  isNetworkError,
  createEventSocket,
  createAgentTurnSocket,
  uploadAsset,
  transcribe,
  textToSpeech,
  onUnauthorized,
  fetchWithRetry,
} from '../cloudClient';

const TEST_URL = 'https://test.example.com';
const TEST_TOKEN = 'test-token';

describe('cloudClient', () => {
  beforeEach(() => {
    clearConfig();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    clearConfig();
  });

  describe('configure / isConfigured / clearConfig', () => {
    it('starts unconfigured', () => {
      expect(isConfigured()).toBe(false);
    });

    it('becomes configured after configure()', () => {
      configure({ cloudUrl: TEST_URL, token: TEST_TOKEN });
      expect(isConfigured()).toBe(true);
    });

    it('strips trailing slashes from cloudUrl', async () => {
      configure({ cloudUrl: 'https://example.com///', token: TEST_TOKEN });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true, status: 200, json: () => Promise.resolve({ status: 'ok' }),
      });
      vi.stubGlobal('fetch', mockFetch);

      await checkHealth();
      expect(mockFetch).toHaveBeenCalledWith(
        'https://example.com/api/health',
        expect.any(Object),
      );
    });

    it('clears configuration', () => {
      configure({ cloudUrl: TEST_URL, token: TEST_TOKEN });
      clearConfig();
      expect(isConfigured()).toBe(false);
    });
  });

  describe('uploadAsset', () => {
    it('rejects non-https production cloud URLs', async () => {
      configure({ cloudUrl: 'http://example.com', token: TEST_TOKEN });
      const mockFetch = vi.fn();
      vi.stubGlobal('fetch', mockFetch);

      await expect(
        uploadAsset('session-1', 'asset-1', Buffer.from('bytes'), 'image/png'),
      ).rejects.toMatchObject({
        code: 'cloud-url-not-https',
      });
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('request (via public API functions)', () => {
    it('throws if not configured', async () => {
      await expect(getSessions()).rejects.toThrow('Cloud client not configured');
    });

    it('sends Authorization header', async () => {
      configure({ cloudUrl: TEST_URL, token: TEST_TOKEN });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true, status: 200, json: () => Promise.resolve([]),
      });
      vi.stubGlobal('fetch', mockFetch);

      await getSessions();
      expect(mockFetch).toHaveBeenCalledWith(
        `${TEST_URL}/api/sessions?summaries=true`,
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: `Bearer ${TEST_TOKEN}`,
          }),
        }),
      );
    });

    it('sends X-Rebel-Client-Id header when configured', async () => {
      configure({ cloudUrl: TEST_URL, token: TEST_TOKEN, clientId: 'device-123' });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true, status: 200, json: () => Promise.resolve([]),
      });
      vi.stubGlobal('fetch', mockFetch);

      await getSessions();
      expect(mockFetch).toHaveBeenCalledWith(
        `${TEST_URL}/api/sessions?summaries=true`,
        expect.objectContaining({
          headers: expect.objectContaining({
            'X-Rebel-Client-Id': 'device-123',
          }),
        }),
      );
    });

    it('retries on 503 with backoff', async () => {
      configure({ cloudUrl: TEST_URL, token: TEST_TOKEN });
      const mockFetch = vi.fn()
        .mockResolvedValueOnce({ ok: false, status: 503, text: () => Promise.resolve('waking up') })
        .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve([]) });
      vi.stubGlobal('fetch', mockFetch);

      const result = await getSessions();
      expect(result).toEqual({ sessions: [], totalCount: 0 });
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('throws CloudClientError on non-retryable HTTP errors', async () => {
      configure({ cloudUrl: TEST_URL, token: TEST_TOKEN });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false, status: 500, text: () => Promise.resolve('Internal Server Error'),
      });
      vi.stubGlobal('fetch', mockFetch);

      await expect(getSessions()).rejects.toThrow(CloudClientError);
    });
  });

  describe('getSessions', () => {
    it('calls GET /api/sessions?summaries=true and wraps array response', async () => {
      configure({ cloudUrl: TEST_URL, token: TEST_TOKEN });
      const sessions = [{ id: 's1', title: 'Test' }];
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true, status: 200, json: () => Promise.resolve(sessions),
      }));

      const result = await getSessions();
      expect(result).toEqual({ sessions, totalCount: 1 });
    });

    it('passes through { sessions, totalCount } response from server', async () => {
      configure({ cloudUrl: TEST_URL, token: TEST_TOKEN });
      const payload = { sessions: [{ id: 's1' }], totalCount: 5 };
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true, status: 200, json: () => Promise.resolve(payload),
      }));

      const result = await getSessions();
      expect(result).toEqual(payload);
    });

    it('appends activeOnly=true when option is set', async () => {
      configure({ cloudUrl: TEST_URL, token: TEST_TOKEN });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true, status: 200, json: () => Promise.resolve([]),
      });
      vi.stubGlobal('fetch', mockFetch);

      await getSessions({ activeOnly: true });
      expect(mockFetch).toHaveBeenCalledWith(
        `${TEST_URL}/api/sessions?summaries=true&activeOnly=true`,
        expect.any(Object),
      );
    });

    it('does not append activeOnly when not set', async () => {
      configure({ cloudUrl: TEST_URL, token: TEST_TOKEN });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true, status: 200, json: () => Promise.resolve([]),
      });
      vi.stubGlobal('fetch', mockFetch);

      await getSessions();
      expect(mockFetch).toHaveBeenCalledWith(
        `${TEST_URL}/api/sessions?summaries=true`,
        expect.any(Object),
      );
    });
  });

  describe('slack recent senders APIs', () => {
    it('listSlackRecentSenders calls GET /api/slack/recent-senders and returns typed rows', async () => {
      configure({ cloudUrl: TEST_URL, token: TEST_TOKEN });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          senders: [
            {
              principalKey: 'slack:T1:human:U123',
              kind: 'human',
              authorId: 'u123',
              normalizedAuthorId: 'U123',
              displayName: 'Ada',
              handle: 'ada',
              teamId: 'T1',
              lastSeenAt: 1700000000000,
              attemptCount: 3,
              channelIds: ['D1'],
              lastChannelType: 'im',
            },
          ],
        }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await listSlackRecentSenders();

      expect(result).toEqual([
        {
          principalKey: 'slack:T1:human:U123',
          kind: 'human',
          authorId: 'u123',
          normalizedAuthorId: 'U123',
          displayName: 'Ada',
          handle: 'ada',
          teamId: 'T1',
          lastSeenAt: 1700000000000,
          attemptCount: 3,
          channelIds: ['D1'],
          lastChannelType: 'im',
        },
      ]);
      expect(mockFetch).toHaveBeenCalledWith(
        `${TEST_URL}/api/slack/recent-senders`,
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            Authorization: `Bearer ${TEST_TOKEN}`,
          }),
        }),
      );
    });

    it('removeSlackRecentSender calls DELETE /api/slack/recent-senders with principalKey body', async () => {
      configure({ cloudUrl: TEST_URL, token: TEST_TOKEN });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ ok: true }),
      });
      vi.stubGlobal('fetch', mockFetch);

      await removeSlackRecentSender('slack:T1:human:U_DELETE');

      expect(mockFetch).toHaveBeenCalledWith(
        `${TEST_URL}/api/slack/recent-senders`,
        expect.objectContaining({
          method: 'DELETE',
          body: JSON.stringify({ principalKey: 'slack:T1:human:U_DELETE' }),
        }),
      );
    });

    it('clearSlackRecentSenders calls POST /api/slack/recent-senders/clear-all and returns cleared count', async () => {
      configure({ cloudUrl: TEST_URL, token: TEST_TOKEN });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ ok: true, cleared: 4 }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await clearSlackRecentSenders();

      expect(result).toEqual({ cleared: 4 });
      expect(mockFetch).toHaveBeenCalledWith(
        `${TEST_URL}/api/slack/recent-senders/clear-all`,
        expect.objectContaining({
          method: 'POST',
        }),
      );
    });
  });

  describe('getTombstones', () => {
    it('calls GET /api/sessions/tombstones without query when since is omitted', async () => {
      configure({ cloudUrl: TEST_URL, token: TEST_TOKEN });
      const tombstones = [{ sessionId: 's1', deletedAt: 123, deletedBy: 'mobile', ttlExpiresAt: 456 }];
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ tombstones, serverNow: 789 }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await getTombstones();

      expect(result).toEqual({ tombstones, serverNow: 789 });
      expect(mockFetch).toHaveBeenCalledWith(
        `${TEST_URL}/api/sessions/tombstones`,
        expect.any(Object),
      );
    });

    it('appends since query param when provided', async () => {
      configure({ cloudUrl: TEST_URL, token: TEST_TOKEN });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ tombstones: [], serverNow: 123 }),
      });
      vi.stubGlobal('fetch', mockFetch);

      await getTombstones(98765);

      expect(mockFetch).toHaveBeenCalledWith(
        `${TEST_URL}/api/sessions/tombstones?since=98765`,
        expect.any(Object),
      );
    });
  });

  describe('getContinuityMap', () => {
    it('calls GET /api/continuity/state', async () => {
      configure({ cloudUrl: TEST_URL, token: TEST_TOKEN });
      const stateMap = { 's1': { state: 'cloud_active' }, 's2': { state: 'local_only' } };
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true, status: 200, json: () => Promise.resolve(stateMap),
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await getContinuityMap();
      expect(result).toEqual(stateMap);
      expect(mockFetch).toHaveBeenCalledWith(
        `${TEST_URL}/api/continuity/state`,
        expect.any(Object),
      );
    });

    it('returns null when server returns null', async () => {
      configure({ cloudUrl: TEST_URL, token: TEST_TOKEN });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true, status: 200, json: () => Promise.resolve(null),
      }));

      const result = await getContinuityMap();
      expect(result).toBeNull();
    });
  });

  describe('getSelfDiagnostics', () => {
    it('calls GET /api/diagnostics/self', async () => {
      configure({ cloudUrl: TEST_URL, token: TEST_TOKEN });
      const payload = { manifest: { source: 'cloud' } };
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(payload),
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await getSelfDiagnostics();
      expect(result).toEqual(payload);
      expect(mockFetch).toHaveBeenCalledWith(
        `${TEST_URL}/api/diagnostics/self`,
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            Authorization: `Bearer ${TEST_TOKEN}`,
            'X-Rebel-Surface': 'mobile',
          }),
        }),
      );
    });

    it('serializes diagnostic section includes for self diagnostics', async () => {
      configure({ cloudUrl: TEST_URL, token: TEST_TOKEN });
      const payload = { manifest: { source: 'cloud' } };
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(payload),
      });
      vi.stubGlobal('fetch', mockFetch);

      await getSelfDiagnostics({
        include: {
          provider_reachability: true,
          health_timing: true,
          recent_logs: false,
        },
      });

      expect(mockFetch).toHaveBeenCalledWith(
        `${TEST_URL}/api/diagnostics/self?include=provider_reachability%2Chealth_timing`,
        expect.any(Object),
      );
    });
  });

  describe('getSession', () => {
    it('calls GET /api/sessions/:id', async () => {
      configure({ cloudUrl: TEST_URL, token: TEST_TOKEN });
      const session = { id: 's1', messages: [] };
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true, status: 200, json: () => Promise.resolve(session),
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await getSession('s1');
      expect(result).toEqual(session);
      expect(mockFetch).toHaveBeenCalledWith(
        `${TEST_URL}/api/sessions/s1?lean=true&toolEvents=true`,
        expect.any(Object),
      );
    });

    it('tolerates REST session payloads that include pending conversation annotations', async () => {
      configure({ cloudUrl: TEST_URL, token: TEST_TOKEN });
      const session = {
        id: 's1',
        messages: [],
        annotations: [{
          id: 'ann-1',
          messageId: 'msg-1',
          text: 'selected text',
          comment: 'private comment',
          createdAt: 1_700_000_000_000,
          startOffset: 0,
          endOffset: 13,
        }],
      };
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(session),
      });
      vi.stubGlobal('fetch', mockFetch);

      await expect(getSession('s1')).resolves.toEqual(session);
    });

    it('URL-encodes special characters in session id', async () => {
      configure({ cloudUrl: TEST_URL, token: TEST_TOKEN });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true, status: 200, json: () => Promise.resolve({}),
      });
      vi.stubGlobal('fetch', mockFetch);

      await getSession('id/with/slashes');
      expect(mockFetch).toHaveBeenCalledWith(
        `${TEST_URL}/api/sessions/id%2Fwith%2Fslashes?lean=true&toolEvents=true`,
        expect.any(Object),
      );
    });
  });

  describe('catch-up APIs', () => {
    it('catchUpSession paginates until hasMore is exhausted', async () => {
      configure({ cloudUrl: TEST_URL, token: TEST_TOKEN });
      const mockFetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () => Promise.resolve({
            events: [
              { type: 'status', message: 's6', timestamp: 60, seq: 6, turnId: 'turn-1' },
              { type: 'status', message: 's7', timestamp: 70, seq: 7, turnId: 'turn-1' },
            ],
            serverSeq: 9,
            hasMore: true,
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () => Promise.resolve({
            events: [
              { type: 'status', message: 's8', timestamp: 80, seq: 8, turnId: 'turn-1' },
              { type: 'status', message: 's9', timestamp: 90, seq: 9, turnId: 'turn-1' },
            ],
            serverSeq: 9,
            hasMore: false,
          }),
        });
      vi.stubGlobal('fetch', mockFetch);

      const result = await catchUpSession('session-1', 5);
      expect(result.serverSeq).toBe(9);
      expect(result.hasMore).toBe(false);
      expect(result.events.map((event) => event.seq)).toEqual([6, 7, 8, 9]);
      expect(mockFetch.mock.calls[0][0]).toBe(`${TEST_URL}/api/sessions/session-1/events?sinceSeq=5&limit=500`);
      expect(mockFetch.mock.calls[1][0]).toBe(`${TEST_URL}/api/sessions/session-1/events?sinceSeq=7&limit=500`);
    });

    it('catchUpSession throws SessionTombstonedError for tombstoned sessions', async () => {
      configure({ cloudUrl: TEST_URL, token: TEST_TOKEN });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 410,
        text: () => Promise.resolve(JSON.stringify({
          error: 'session-tombstoned',
          tombstone: {
            sessionId: 'session-1',
            deletedAt: 1_700_000_000_000,
            deletedBy: 'mobile',
            ttlExpiresAt: 1_700_000_100_000,
          },
        })),
      });
      vi.stubGlobal('fetch', mockFetch);

      await expect(catchUpSession('session-1', 5)).rejects.toEqual(expect.objectContaining({
        name: 'SessionTombstonedError',
        tombstone: expect.objectContaining({
          sessionId: 'session-1',
          deletedAt: 1_700_000_000_000,
          deletedBy: 'mobile',
        }),
      } satisfies Partial<SessionTombstonedError>));
    });

    it('catchUpSession preserves legacy 404s as CloudClientError when no tombstone payload is present', async () => {
      configure({ cloudUrl: TEST_URL, token: TEST_TOKEN });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        text: () => Promise.resolve('Not Found'),
      });
      vi.stubGlobal('fetch', mockFetch);

      await expect(catchUpSession('session-1', 5)).rejects.toEqual(expect.objectContaining({
        name: 'CloudClientError',
        statusCode: 404,
      } satisfies Partial<CloudClientError>));
    });

    it('catchUpContinuity consumes continuationToken pages and merges events by session', async () => {
      configure({ cloudUrl: TEST_URL, token: TEST_TOKEN });
      const mockFetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () => Promise.resolve({
            sessions: {
              'session-a': {
                events: [{ type: 'status', message: 'a2', timestamp: 20, seq: 2, turnId: 'turn-a' }],
                maxSeq: 3,
              },
              'session-b': {
                events: [{ type: 'status', message: 'b2', timestamp: 20, seq: 2, turnId: 'turn-b' }],
                maxSeq: 4,
              },
            },
            serverNow: 100,
            continuationToken: 'token-1',
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () => Promise.resolve({
            sessions: {
              'session-a': {
                events: [{ type: 'status', message: 'a3', timestamp: 30, seq: 3, turnId: 'turn-a' }],
                maxSeq: 3,
              },
              'session-b': {
                events: [
                  { type: 'status', message: 'b3', timestamp: 30, seq: 3, turnId: 'turn-b' },
                  { type: 'status', message: 'b4', timestamp: 40, seq: 4, turnId: 'turn-b' },
                ],
                maxSeq: 4,
              },
            },
            serverNow: 200,
          }),
        });
      vi.stubGlobal('fetch', mockFetch);

      const result = await catchUpContinuity({
        sinceSeq: { 'session-a': 1, 'session-b': 1 },
        sessionIds: ['session-a', 'session-b'],
      });

      expect(result.serverNow).toBe(200);
      expect(result.continuationToken).toBeUndefined();
      expect(result.sessions['session-a']).toEqual({
        events: [
          { type: 'status', message: 'a2', timestamp: 20, seq: 2, turnId: 'turn-a' },
          { type: 'status', message: 'a3', timestamp: 30, seq: 3, turnId: 'turn-a' },
        ],
        maxSeq: 3,
      });
      expect(result.sessions['session-b']).toEqual({
        events: [
          { type: 'status', message: 'b2', timestamp: 20, seq: 2, turnId: 'turn-b' },
          { type: 'status', message: 'b3', timestamp: 30, seq: 3, turnId: 'turn-b' },
          { type: 'status', message: 'b4', timestamp: 40, seq: 4, turnId: 'turn-b' },
        ],
        maxSeq: 4,
      });

      const firstUrl = new URL(mockFetch.mock.calls[0][0] as string);
      expect(firstUrl.pathname).toBe('/api/continuity/catch-up');
      expect(firstUrl.searchParams.get('sessionIds')).toBe('session-a,session-b');
      expect(firstUrl.searchParams.get('sinceSeq')).toBe(JSON.stringify({ 'session-a': 1, 'session-b': 1 }));

      const secondUrl = new URL(mockFetch.mock.calls[1][0] as string);
      expect(secondUrl.pathname).toBe('/api/continuity/catch-up');
      expect(secondUrl.searchParams.get('continuationToken')).toBe('token-1');
    });
  });

  describe('getSettings', () => {
    it('calls GET /api/settings', async () => {
      configure({ cloudUrl: TEST_URL, token: TEST_TOKEN });
      const settings = { claude: { apiKey: '***' } };
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true, status: 200, json: () => Promise.resolve(settings),
      }));

      const result = await getSettings();
      expect(result).toEqual(settings);
    });
  });

  describe('stopTurn', () => {
    it('calls POST /api/agent/stop', async () => {
      configure({ cloudUrl: TEST_URL, token: TEST_TOKEN });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true, status: 200, json: () => Promise.resolve({}),
      });
      vi.stubGlobal('fetch', mockFetch);

      await stopTurn('turn-123');
      expect(mockFetch).toHaveBeenCalledWith(
        `${TEST_URL}/api/agent/stop`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ turnId: 'turn-123' }),
        }),
      );
    });
  });

  describe('readWorkspaceFile', () => {
    it('calls POST /api/library/read with path', async () => {
      configure({ cloudUrl: TEST_URL, token: TEST_TOKEN });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true, status: 200, json: () => Promise.resolve({ content: '# Hello' }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await readWorkspaceFile('notes/readme.md');
      expect(result).toEqual({ content: '# Hello' });
      expect(mockFetch).toHaveBeenCalledWith(
        `${TEST_URL}/api/library/read`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ path: 'notes/readme.md' }),
        }),
      );
    });

    it('throws if not configured', async () => {
      await expect(readWorkspaceFile('test.md')).rejects.toThrow('Cloud client not configured');
    });

    it('throws CloudClientError on HTTP error', async () => {
      configure({ cloudUrl: TEST_URL, token: TEST_TOKEN });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false, status: 404, text: () => Promise.resolve('Not Found'),
      });
      vi.stubGlobal('fetch', mockFetch);

      await expect(readWorkspaceFile('nonexistent.md')).rejects.toThrow(CloudClientError);
    });
  });

  describe('checkHealth', () => {
    it('does not require auth header', async () => {
      configure({ cloudUrl: TEST_URL, token: TEST_TOKEN });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true, status: 200, json: () => Promise.resolve({ status: 'ok' }),
      });
      vi.stubGlobal('fetch', mockFetch);

      await checkHealth();
      const callArgs = mockFetch.mock.calls[0];
      expect(callArgs[1]?.headers).toBeUndefined();
    });

    it('throws if not configured', async () => {
      await expect(checkHealth()).rejects.toThrow('Cloud client not configured');
    });

    it('throws on non-ok non-transient response', async () => {
      configure({ cloudUrl: TEST_URL, token: TEST_TOKEN });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false, status: 500,
      }));

      await expect(checkHealth()).rejects.toThrow('Health check failed');
    });

    it('retries on transient HTTP error (502)', async () => {
      configure({ cloudUrl: TEST_URL, token: TEST_TOKEN });
      const mockFetch = vi.fn()
        .mockResolvedValueOnce({ ok: false, status: 502 })
        .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ status: 'ok', version: '1.0' }) });
      vi.stubGlobal('fetch', mockFetch);

      const result = await checkHealth();
      expect(result).toEqual({ status: 'ok', version: '1.0' });
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('createEventSocket', () => {
    it('throws if not configured', () => {
      expect(() => createEventSocket(() => {})).toThrow('Cloud client not configured');
    });

    it('constructs WS URL with query-param auth', () => {
      configure({ cloudUrl: TEST_URL, token: TEST_TOKEN });
      const instances: { url: string }[] = [];
      vi.stubGlobal('WebSocket', class MockWS {
        url: string;
        onmessage: ((ev: { data: string }) => void) | null = null;
        onerror: (() => void) | null = null;
        onclose: (() => void) | null = null;
        readyState = 1;
        constructor(url: string) { this.url = url; instances.push({ url }); }
        close() {}
      });

      createEventSocket(() => {});
      expect(instances[0].url).toBe('wss://test.example.com/api/events?token=test-token');
    });
  });

  describe('createAgentTurnSocket', () => {
    it('throws if not configured', () => {
      expect(() => createAgentTurnSocket({ sessionId: 's1', prompt: 'hi' }, () => {}))
        .toThrow('Cloud client not configured');
    });

    it('constructs WS URL and sends request on open', () => {
      configure({ cloudUrl: TEST_URL, token: TEST_TOKEN });
      let sentData: string | null = null;
      let onOpenCb: (() => void) | null = null;
      vi.stubGlobal('WebSocket', class MockWS {
        url: string;
        onopen: (() => void) | null = null;
        onmessage: ((ev: { data: string }) => void) | null = null;
        onerror: ((ev: unknown) => void) | null = null;
        onclose: ((ev: unknown) => void) | null = null;
        readyState = 1;
        constructor(url: string) {
          this.url = url;
          setTimeout(() => { onOpenCb = this.onopen; this.onopen?.(); }, 0);
        }
        send(data: string) { sentData = data; }
        close() {}
      });

      createAgentTurnSocket({ sessionId: 's1', prompt: 'hello' }, () => {});

      return new Promise<void>((resolve) => setTimeout(() => {
        expect(sentData).toBe(JSON.stringify({ sessionId: 's1', prompt: 'hello' }));
        resolve();
      }, 10));
    });
  });

  describe('isTransientError', () => {
    it('returns true for 408', () => expect(isTransientError(408)).toBe(true));
    it('returns true for 429', () => expect(isTransientError(429)).toBe(true));
    it('returns true for 502', () => expect(isTransientError(502)).toBe(true));
    it('returns true for 503', () => expect(isTransientError(503)).toBe(true));
    it('returns true for 504', () => expect(isTransientError(504)).toBe(true));
    it('returns false for 400', () => expect(isTransientError(400)).toBe(false));
    it('returns false for 401', () => expect(isTransientError(401)).toBe(false));
    it('returns false for 404', () => expect(isTransientError(404)).toBe(false));
    it('returns false for 500', () => expect(isTransientError(500)).toBe(false));
  });

  describe('isNetworkError', () => {
    it('returns true for AbortError', () => {
      const err = new DOMException('The operation was aborted', 'AbortError');
      expect(isNetworkError(err)).toBe(true);
    });

    it('returns true for TypeError("Failed to fetch")', () => {
      expect(isNetworkError(new TypeError('Failed to fetch'))).toBe(true);
    });

    it('returns true for TypeError("Network request failed")', () => {
      expect(isNetworkError(new TypeError('Network request failed'))).toBe(true);
    });

    it('returns false for TypeError("Cannot read properties of undefined")', () => {
      expect(isNetworkError(new TypeError('Cannot read properties of undefined'))).toBe(false);
    });

    it('returns false for generic Error', () => {
      expect(isNetworkError(new Error('something went wrong'))).toBe(false);
    });

    it('returns false for null/undefined', () => {
      expect(isNetworkError(null)).toBe(false);
      expect(isNetworkError(undefined)).toBe(false);
    });
  });

  describe('request fail-fast on non-transient errors', () => {
    it('fails fast on 400 (no retry, 1 fetch call)', async () => {
      configure({ cloudUrl: TEST_URL, token: TEST_TOKEN });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false, status: 400, text: () => Promise.resolve('Bad Request'),
      });
      vi.stubGlobal('fetch', mockFetch);

      await expect(getSessions()).rejects.toThrow(CloudClientError);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('fails fast on 404 (no retry, 1 fetch call)', async () => {
      configure({ cloudUrl: TEST_URL, token: TEST_TOKEN });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false, status: 404, text: () => Promise.resolve('Not Found'),
      });
      vi.stubGlobal('fetch', mockFetch);

      await expect(getSession('nonexistent')).rejects.toThrow(CloudClientError);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('fails fast on 500 (no retry, 1 fetch call)', async () => {
      configure({ cloudUrl: TEST_URL, token: TEST_TOKEN });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false, status: 500, text: () => Promise.resolve('Internal Server Error'),
      });
      vi.stubGlobal('fetch', mockFetch);

      await expect(getSessions()).rejects.toThrow(CloudClientError);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('request retry on transient errors', () => {
    it('retries on 502 (2 fetch calls)', async () => {
      configure({ cloudUrl: TEST_URL, token: TEST_TOKEN });
      const mockFetch = vi.fn()
        .mockResolvedValueOnce({ ok: false, status: 502, text: () => Promise.resolve('Bad Gateway') })
        .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve([]) });
      vi.stubGlobal('fetch', mockFetch);

      const result = await getSessions();
      expect(result).toEqual({ sessions: [], totalCount: 0 });
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('retries on 504 (2 fetch calls)', async () => {
      configure({ cloudUrl: TEST_URL, token: TEST_TOKEN });
      const mockFetch = vi.fn()
        .mockResolvedValueOnce({ ok: false, status: 504, text: () => Promise.resolve('Gateway Timeout') })
        .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve([]) });
      vi.stubGlobal('fetch', mockFetch);

      const result = await getSessions();
      expect(result).toEqual({ sessions: [], totalCount: 0 });
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('checkHealth retry', () => {
    it('retries on network error', async () => {
      configure({ cloudUrl: TEST_URL, token: TEST_TOKEN });
      const mockFetch = vi.fn()
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ status: 'ok', version: '1.0' }) });
      vi.stubGlobal('fetch', mockFetch);

      const result = await checkHealth();
      expect(result).toEqual({ status: 'ok', version: '1.0' });
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('getSessionFull', () => {
    it('calls GET /api/sessions/:id without lean param', async () => {
      configure({ cloudUrl: TEST_URL, token: TEST_TOKEN });
      const session = { id: 's1', messages: [], toolEvents: [] };
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true, status: 200, json: () => Promise.resolve(session),
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await getSessionFull('s1');
      expect(result).toEqual(session);
      expect(mockFetch).toHaveBeenCalledWith(
        `${TEST_URL}/api/sessions/s1`,
        expect.any(Object),
      );
    });
  });

  describe('updateSession', () => {
    it('does GET-then-PUT when metadata patch capability is absent', async () => {
      configure({ cloudUrl: TEST_URL, token: TEST_TOKEN });
      const fullSession = { id: 's1', title: 'Original', messages: [] };
      const mockFetch = vi.fn()
        .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ status: 'ok', version: 'test', capabilities: [] }) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve(fullSession) })
        .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({}) });
      vi.stubGlobal('fetch', mockFetch);

      await updateSession('s1', { title: 'Updated' });

      expect(mockFetch).toHaveBeenCalledTimes(3);
      // First call: capability probe
      expect(mockFetch.mock.calls[0][0]).toBe(`${TEST_URL}/api/health`);
      expect(mockFetch.mock.calls[0][1].method).toBeUndefined();
      // Second call: GET full session
      expect(mockFetch.mock.calls[1][0]).toBe(`${TEST_URL}/api/sessions/s1`);
      expect(mockFetch.mock.calls[1][1].method).toBe('GET');
      // Third call: PUT merged session
      expect(mockFetch.mock.calls[2][0]).toBe(`${TEST_URL}/api/sessions/s1`);
      expect(mockFetch.mock.calls[2][1].method).toBe('PUT');
      const putBody = JSON.parse(mockFetch.mock.calls[2][1].body);
      expect(putBody).toEqual({ id: 's1', title: 'Updated', messages: [] });
    });
  });

  describe('deleteSession', () => {
    it('calls DELETE /api/sessions/:id and returns the server tombstone', async () => {
      configure({ cloudUrl: TEST_URL, token: TEST_TOKEN });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          success: true,
          tombstone: {
            sessionId: 's1',
            deletedAt: 1_700_000_000_000,
            deletedBy: 'mobile',
            ttlExpiresAt: 1_700_000_100_000,
          },
        }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await deleteSession('s1');

      expect(mockFetch).toHaveBeenCalledWith(
        `${TEST_URL}/api/sessions/s1`,
        expect.objectContaining({ method: 'DELETE' }),
      );
      expect(result).toEqual({
        success: true,
        tombstone: {
          sessionId: 's1',
          deletedAt: 1_700_000_000_000,
          deletedBy: 'mobile',
          ttlExpiresAt: 1_700_000_100_000,
        },
      });
    });

    it('forwards X-Rebel-Surface when provided', async () => {
      configure({ cloudUrl: TEST_URL, token: TEST_TOKEN });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true, status: 200, json: () => Promise.resolve({}),
      });
      vi.stubGlobal('fetch', mockFetch);

      await deleteSession('s1', 'mobile');

      expect(mockFetch).toHaveBeenCalledWith(
        `${TEST_URL}/api/sessions/s1`,
        expect.objectContaining({
          method: 'DELETE',
          headers: expect.objectContaining({
            'X-Rebel-Surface': 'mobile',
          }),
        }),
      );
    });
  });

  describe('transcribe', () => {
    it('throws if not configured', async () => {
      const blob = new Blob(['audio'], { type: 'audio/mp4' });
      await expect(transcribe(blob)).rejects.toThrow('Cloud client not configured');
    });

    it('sends audio blob to transcription endpoint', async () => {
      configure({ cloudUrl: TEST_URL, token: TEST_TOKEN });
      const blob = new Blob(['audio data'], { type: 'audio/mp4' });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true, status: 200, json: () => Promise.resolve({ transcript: 'Hello world' }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await transcribe(blob, 'session-1');
      expect(result).toBe('Hello world');
      expect(mockFetch).toHaveBeenCalledWith(
        `${TEST_URL}/api/voice/transcribe?sessionId=session-1`,
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: `Bearer ${TEST_TOKEN}`,
            'Content-Type': 'audio/mp4',
          }),
        }),
      );
    });

    it('retries on 503', async () => {
      configure({ cloudUrl: TEST_URL, token: TEST_TOKEN });
      const blob = new Blob(['audio'], { type: 'audio/mp4' });
      const mockFetch = vi.fn()
        .mockResolvedValueOnce({ ok: false, status: 503, text: () => Promise.resolve('Service Unavailable') })
        .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ transcript: 'test' }) });
      vi.stubGlobal('fetch', mockFetch);

      const result = await transcribe(blob);
      expect(result).toBe('test');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('retries on network error', async () => {
      configure({ cloudUrl: TEST_URL, token: TEST_TOKEN });
      const blob = new Blob(['audio'], { type: 'audio/mp4' });
      const mockFetch = vi.fn()
        .mockRejectedValueOnce(new TypeError('Network request failed'))
        .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ transcript: 'recovered' }) });
      vi.stubGlobal('fetch', mockFetch);

      const result = await transcribe(blob);
      expect(result).toBe('recovered');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('does NOT retry on 401 and calls on401Callback', async () => {
      configure({ cloudUrl: TEST_URL, token: TEST_TOKEN });
      const callback = vi.fn();
      onUnauthorized(callback);

      const blob = new Blob(['audio'], { type: 'audio/mp4' });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false, status: 401, text: () => Promise.resolve('Unauthorized'),
      });
      vi.stubGlobal('fetch', mockFetch);

      await expect(transcribe(blob)).rejects.toThrow('Unauthorized');
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledTimes(1);
    });

    it('does NOT retry on 400', async () => {
      configure({ cloudUrl: TEST_URL, token: TEST_TOKEN });
      const blob = new Blob(['audio'], { type: 'audio/mp4' });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false, status: 400, text: () => Promise.resolve('Bad Request'),
      });
      vi.stubGlobal('fetch', mockFetch);

      await expect(transcribe(blob)).rejects.toThrow(CloudClientError);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('exhausts all retries on persistent transient error', async () => {
      configure({ cloudUrl: TEST_URL, token: TEST_TOKEN });
      const blob = new Blob(['audio'], { type: 'audio/mp4' });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false, status: 502, text: () => Promise.resolve('Bad Gateway'),
      });
      vi.stubGlobal('fetch', mockFetch);

      await expect(transcribe(blob)).rejects.toThrow(CloudClientError);
      expect(mockFetch).toHaveBeenCalledTimes(3); // initial + 2 retries
    });
  });

  describe('textToSpeech', () => {
    it('throws if not configured', async () => {
      await expect(textToSpeech('hello')).rejects.toThrow('Cloud client not configured');
    });

    it('sends text and returns audio base64', async () => {
      configure({ cloudUrl: TEST_URL, token: TEST_TOKEN });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true, status: 200, json: () => Promise.resolve({ audioBase64: 'base64data' }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await textToSpeech('Hello world');
      expect(result).toBe('base64data');
      expect(mockFetch).toHaveBeenCalledWith(
        `${TEST_URL}/api/voice/tts`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ text: 'Hello world' }),
        }),
      );
    });

    it('retries on 502', async () => {
      configure({ cloudUrl: TEST_URL, token: TEST_TOKEN });
      const mockFetch = vi.fn()
        .mockResolvedValueOnce({ ok: false, status: 502, text: () => Promise.resolve('Bad Gateway') })
        .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ audioBase64: 'data' }) });
      vi.stubGlobal('fetch', mockFetch);

      const result = await textToSpeech('test');
      expect(result).toBe('data');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('retries on network error', async () => {
      configure({ cloudUrl: TEST_URL, token: TEST_TOKEN });
      const mockFetch = vi.fn()
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ audioBase64: 'recovered' }) });
      vi.stubGlobal('fetch', mockFetch);

      const result = await textToSpeech('test');
      expect(result).toBe('recovered');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('does NOT retry on 401 and calls on401Callback', async () => {
      configure({ cloudUrl: TEST_URL, token: TEST_TOKEN });
      const callback = vi.fn();
      onUnauthorized(callback);

      const mockFetch = vi.fn().mockResolvedValue({
        ok: false, status: 401, text: () => Promise.resolve('Unauthorized'),
      });
      vi.stubGlobal('fetch', mockFetch);

      await expect(textToSpeech('test')).rejects.toThrow('Unauthorized');
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledTimes(1);
    });

    it('does NOT retry on 400', async () => {
      configure({ cloudUrl: TEST_URL, token: TEST_TOKEN });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false, status: 400, text: () => Promise.resolve('Bad Request'),
      });
      vi.stubGlobal('fetch', mockFetch);

      await expect(textToSpeech('test')).rejects.toThrow(CloudClientError);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('does not retry when external abort signal is triggered', async () => {
      configure({ cloudUrl: TEST_URL, token: TEST_TOKEN });
      const abortController = new AbortController();
      abortController.abort();

      const mockFetch = vi.fn().mockRejectedValue(
        new DOMException('The operation was aborted', 'AbortError'),
      );
      vi.stubGlobal('fetch', mockFetch);

      await expect(textToSpeech('test', abortController.signal)).rejects.toThrow();
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('exhausts all retries on persistent transient error', async () => {
      configure({ cloudUrl: TEST_URL, token: TEST_TOKEN });
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false, status: 504, text: () => Promise.resolve('Gateway Timeout'),
      });
      vi.stubGlobal('fetch', mockFetch);

      await expect(textToSpeech('test')).rejects.toThrow(CloudClientError);
      expect(mockFetch).toHaveBeenCalledTimes(3); // initial + 2 retries
    });
  });

  describe('fetchWithRetry', () => {
    it('logs http_retry_attempt telemetry on transient retries', async () => {
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
      const mockFetch = vi.fn()
        .mockResolvedValueOnce({ ok: false, status: 503, text: () => Promise.resolve('') })
        .mockResolvedValueOnce({ ok: true, status: 200 });

      await fetchWithRetry(
        (signal) => mockFetch(signal),
        { timeoutMs: 5000, maxRetries: 1, backoffMs: 100, urlPath: '/api/sessions' },
      );

      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('http_retry_attempt'));
      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('"urlPath":"/api/sessions"'));
      infoSpy.mockRestore();
    });

    it('uses custom random function for jitter', async () => {
      const randomFn = vi.fn().mockReturnValue(0.5);
      const mockFetch = vi.fn()
        .mockResolvedValueOnce({ ok: false, status: 503, text: () => Promise.resolve('') })
        .mockResolvedValueOnce({ ok: true, status: 200 });

      await fetchWithRetry(
        (signal) => mockFetch(signal),
        { timeoutMs: 5000, maxRetries: 1, backoffMs: 100, random: randomFn },
      );

      expect(randomFn).toHaveBeenCalled();
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('returns response on success with no retries needed', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

      const res = await fetchWithRetry(
        (signal) => mockFetch(signal),
        { timeoutMs: 5000, maxRetries: 2, backoffMs: 100 },
      );

      expect(res.ok).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('throws immediately on 401 without retrying', async () => {
      const on401 = vi.fn();
      const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 401 });

      await expect(
        fetchWithRetry(
          (signal) => mockFetch(signal),
          { timeoutMs: 5000, maxRetries: 2, backoffMs: 100, on401 },
        ),
      ).rejects.toThrow('Unauthorized');

      expect(on401).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('does not retry when maxRetries is 0', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false, status: 503, text: () => Promise.resolve(''),
      });

      await expect(
        fetchWithRetry(
          (signal) => mockFetch(signal),
          { timeoutMs: 5000, maxRetries: 0, backoffMs: 100 },
        ),
      ).rejects.toThrow(CloudClientError);

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });
});
