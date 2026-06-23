import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearConfig,
  configure,
} from '../cloudClient';
import {
  deleteSlackWorkspace,
  getSlackWorkspace,
  SlackAuthError,
  SlackNetworkError,
  SlackResponseValidationError,
  SlackTransientError,
  startByokSlackOAuth,
  startSlackOAuth,
} from '../slack';

const TEST_URL = 'https://cloud.example.test';
const TEST_TOKEN = 'token-123';

function response(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe('Slack cloud client wrappers', () => {
  beforeEach(() => {
    clearConfig();
    configure({ cloudUrl: TEST_URL, token: TEST_TOKEN });
    vi.restoreAllMocks();
  });

  afterEach(() => {
    clearConfig();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('returns validated responses for successful Slack routes', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(200, { authUrl: 'https://slack.com/oauth/v2/authorize?state=s1', state: 's1' }))
      .mockResolvedValueOnce(response(200, { teamId: 'T1', teamName: 'Acme', status: 'connected', lastSeenAt: '2026-05-03T12:00:00.000Z' }))
      .mockResolvedValueOnce(response(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(startSlackOAuth()).resolves.toEqual({
      authUrl: 'https://slack.com/oauth/v2/authorize?state=s1',
      state: 's1',
    });
    await expect(getSlackWorkspace()).resolves.toEqual({
      teamId: 'T1',
      teamName: 'Acme',
      status: 'connected',
      lastSeenAt: '2026-05-03T12:00:00.000Z',
    });
    await expect(deleteSlackWorkspace()).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledWith(
      `${TEST_URL}/api/integrations/slack/oauth/start/managed`,
      expect.objectContaining({ method: 'POST' }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      `${TEST_URL}/api/integrations/slack/workspace`,
      expect.objectContaining({ method: 'GET' }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      `${TEST_URL}/api/integrations/slack/workspace`,
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('throws SlackResponseValidationError when a response violates the schema', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(200, { teamId: 'T1', status: 'connected' })));

    await expect(getSlackWorkspace()).rejects.toBeInstanceOf(SlackResponseValidationError);
  });

  it('throws SlackResponseValidationError when OAuth start omits the route state', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(200, { authUrl: 'https://slack.com/oauth/v2/authorize?state=s1' })));

    await expect(startSlackOAuth()).rejects.toBeInstanceOf(SlackResponseValidationError);
  });

  it('starts BYOK Slack OAuth with validated credentials', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(200, {
      authUrl: 'https://slack.com/oauth/v2/authorize?state=byok1',
      state: 'byok1',
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(startByokSlackOAuth({
      clientId: ' 123.456 ',
      clientSecret: ' client-secret ',
      signingSecret: ' signing-secret ',
    })).resolves.toEqual({
      authUrl: 'https://slack.com/oauth/v2/authorize?state=byok1',
      state: 'byok1',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      `${TEST_URL}/api/integrations/slack/oauth/start/byok`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          clientId: '123.456',
          clientSecret: 'client-secret',
          signingSecret: 'signing-secret',
        }),
      }),
    );
  });

  it('rejects invalid BYOK credentials before sending a request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(startByokSlackOAuth({
      clientId: ' ',
      clientSecret: 'client-secret',
      signingSecret: 'signing-secret',
    })).rejects.toBeInstanceOf(SlackResponseValidationError);
    await expect(startByokSlackOAuth({
      clientId: '123.456',
      clientSecret: '\t',
      signingSecret: 'signing-secret',
    })).rejects.toBeInstanceOf(SlackResponseValidationError);
    await expect(startByokSlackOAuth({
      clientId: '123.456',
      clientSecret: 'client-secret',
      signingSecret: '\n',
    })).rejects.toBeInstanceOf(SlackResponseValidationError);
    await expect(startByokSlackOAuth({
      clientId: 'not-valid',
      clientSecret: 'client-secret',
      signingSecret: 'signing-secret',
    })).rejects.toBeInstanceOf(SlackResponseValidationError);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps network failures to SlackNetworkError', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    const promise = expect(getSlackWorkspace()).rejects.toBeInstanceOf(SlackNetworkError);
    await vi.advanceTimersByTimeAsync(5_000);

    await promise;
  });

  it('maps 401 responses to SlackAuthError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(401, { error: { code: 'UNAUTHORIZED', message: 'Nope' } })));

    await expect(startSlackOAuth()).rejects.toBeInstanceOf(SlackAuthError);
  });

  it('maps 403 responses to SlackAuthError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(403, { error: { code: 'FORBIDDEN', message: 'Nope' } })));

    await expect(startSlackOAuth()).rejects.toBeInstanceOf(SlackAuthError);
  });

  it('maps BYOK 400 responses to SlackAuthError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(400, { error: { code: 'INVALID_BODY', message: 'Missing fields' } })));

    await expect(startByokSlackOAuth({
      clientId: '123.456',
      clientSecret: 'client-secret',
      signingSecret: 'signing-secret',
    })).rejects.toBeInstanceOf(SlackAuthError);
  });

  it('maps field-specific BYOK 400 responses to SlackAuthError.field', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(400, {
      error: 'INVALID_FIELD',
      field: 'clientId',
      message: 'Client ID looks like 12345.67890',
    })));

    await expect(startByokSlackOAuth({
      clientId: '123.456',
      clientSecret: 'client-secret',
      signingSecret: 'signing-secret',
    })).rejects.toMatchObject({
      field: 'clientId',
      message: 'Client ID looks like 12345.67890',
    });
  });

  it.each([429, 500, 503])('maps %s responses to SlackTransientError', async (statusCode) => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(statusCode, { error: { code: 'TEMPORARY', message: 'Try later' } })));

    const promise = expect(getSlackWorkspace()).rejects.toBeInstanceOf(SlackTransientError);
    await vi.advanceTimersByTimeAsync(5_000);

    await promise;
  });

  it('passes an external AbortSignal to fetch', async () => {
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    const fetchMock = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      observedSignal = init.signal as AbortSignal;
      controller.abort();
      return Promise.resolve(response(200, null));
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(getSlackWorkspace(controller.signal)).resolves.toBeNull();

    expect(fetchMock).toHaveBeenCalledWith(`${TEST_URL}/api/integrations/slack/workspace`, expect.objectContaining({ method: 'GET' }));
    expect(observedSignal?.aborted).toBe(true);
  });

  it('passes BYOK AbortSignal to fetch', async () => {
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    const fetchMock = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      observedSignal = init.signal as AbortSignal;
      controller.abort();
      return Promise.resolve(response(200, {
        authUrl: 'https://slack.com/oauth/v2/authorize?state=byok-abort',
        state: 'byok-abort',
      }));
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(startByokSlackOAuth({
      clientId: '123.456',
      clientSecret: 'client-secret',
      signingSecret: 'signing-secret',
    }, { signal: controller.signal })).resolves.toEqual({
      authUrl: 'https://slack.com/oauth/v2/authorize?state=byok-abort',
      state: 'byok-abort',
    });

    expect(fetchMock).toHaveBeenCalledWith(`${TEST_URL}/api/integrations/slack/oauth/start/byok`, expect.objectContaining({ method: 'POST' }));
    expect(observedSignal?.aborted).toBe(true);
  });
});
