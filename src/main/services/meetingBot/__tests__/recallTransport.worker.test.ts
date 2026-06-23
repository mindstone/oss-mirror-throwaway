/**
 * Contract tests for WorkerRecallTransport.
 *
 * Stage 1 is a behaviour-preserving refactor: these tests assert that the
 * transport reproduces — byte-for-byte — the request shapes the former
 * `backendFetch` round-trips in `localRecordingService.ts` produced:
 *  - route, method, body for create
 *  - route + `X-Client-Secret` header for status & transcript
 *  - the HMAC `X-Mindstone-Auth` header on every call
 *  - `Content-Type: application/json` on every call
 *  - the success/failure result shapes the callers branch on
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Deterministic auth header so we can assert it is forwarded unchanged.
vi.mock('../backendAuth', () => ({
  generateBackendAuthHeader: vi.fn((userId: string) => `auth-for-${userId}`),
}));

vi.mock('@core/services/meetingBotBackendConfig', async () => {
  const actual = await vi.importActual<typeof import('@core/services/meetingBotBackendConfig')>(
    '@core/services/meetingBotBackendConfig',
  );
  return {
    ...actual,
    resolveMeetingBotBackendConfig: vi.fn(() => ({
      configured: true,
      url: 'https://backend.example',
      authKey: 'test-key',
    })),
  };
});

import { WorkerRecallTransport, getRecallTransport } from '../recallTransport';
import { generateBackendAuthHeader } from '../backendAuth';
import type { AppSettings } from '@shared/types/settings';

const USER_ID = 'user-123';
const TEST_BACKEND_URL = 'https://backend.example';

/** Build a Response-like stub that records what was returned. */
function jsonResponse(body: unknown, init?: { ok?: boolean; status?: number }): Response {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response;
}

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchSpy = vi.fn();
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

/** Read the captured (url, RequestInit) of the Nth fetch call. */
function callArgs(n = 0): { url: string; init: RequestInit; headers: Headers } {
  const [url, init] = fetchSpy.mock.calls[n] as [string, RequestInit];
  return { url, init, headers: new Headers(init.headers) };
}

describe('WorkerRecallTransport — create upload session', () => {
  it('POSTs to /api/upload-session with the meetingTitle+clientSecret body and auth headers', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({ uploadId: 'up_1', upload_token: 'tok_1' }),
    );

    const transport = new WorkerRecallTransport(() => USER_ID);
    const result = await transport.createUploadSession({
      meetingTitle: 'Standup',
      clientSecret: 'secret-abc',
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const { url, init, headers } = callArgs();
    expect(url).toBe(`${TEST_BACKEND_URL}/api/upload-session`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      meetingTitle: 'Standup',
      clientSecret: 'secret-abc',
    });
    expect(headers.get('X-Mindstone-Auth')).toBe(`auth-for-${USER_ID}`);
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(generateBackendAuthHeader).toHaveBeenCalledWith(USER_ID);

    expect(result).toEqual({
      ok: true,
      status: 200,
      data: { uploadId: 'up_1', upload_token: 'tok_1' },
    });
  });

  it('returns ok:false with status + errorText when the backend rejects', async () => {
    fetchSpy.mockResolvedValue(jsonResponse('nope', { ok: false, status: 500 }));

    const transport = new WorkerRecallTransport(() => USER_ID);
    const result = await transport.createUploadSession({
      meetingTitle: 'Standup',
      clientSecret: 'secret-abc',
    });

    expect(result).toEqual({ ok: false, status: 500, errorText: 'nope' });
  });

  it('throws when there is no authenticated user (preserves backendFetch contract)', async () => {
    const transport = new WorkerRecallTransport(() => null);
    await expect(
      transport.createUploadSession({ meetingTitle: 'x', clientSecret: 'y' }),
    ).rejects.toThrow('User not authenticated');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('WorkerRecallTransport — get upload status', () => {
  it('GETs /api/upload-session/status with the uploadId query and X-Client-Secret header', async () => {
    const statusBody = {
      success: true,
      status: 'complete',
      transcriptReady: true,
      recordingId: 'rec_1',
    };
    fetchSpy.mockResolvedValue(jsonResponse(statusBody));

    const transport = new WorkerRecallTransport(() => USER_ID);
    const result = await transport.getUploadStatus({
      uploadId: 'up_1',
      clientSecret: 'secret-abc',
    });

    const { url, init, headers } = callArgs();
    expect(url).toBe(`${TEST_BACKEND_URL}/api/upload-session/status?uploadId=up_1`);
    expect(init.method).toBeUndefined(); // GET (no explicit method, as before)
    expect(headers.get('X-Client-Secret')).toBe('secret-abc');
    expect(headers.get('X-Mindstone-Auth')).toBe(`auth-for-${USER_ID}`);
    expect(headers.get('Content-Type')).toBe('application/json');

    expect(result).toEqual({ ok: true, status: 200, data: statusBody });
  });

  it('returns ok:false with status when the status call fails', async () => {
    fetchSpy.mockResolvedValue(jsonResponse('err', { ok: false, status: 404 }));

    const transport = new WorkerRecallTransport(() => USER_ID);
    const result = await transport.getUploadStatus({
      uploadId: 'up_1',
      clientSecret: 'secret-abc',
    });

    expect(result).toEqual({ ok: false, status: 404 });
  });
});

describe('WorkerRecallTransport — get upload transcript', () => {
  it('GETs /api/upload-session/transcript with the uploadId query and X-Client-Secret header', async () => {
    const transcriptBody = {
      success: true,
      transcript: 'Alice: hello\nBob: hi',
      participants: ['Alice', 'Bob'],
      duration: 42,
      meetingTitle: 'Standup',
      startTime: '2026-06-06T00:00:00.000Z',
    };
    fetchSpy.mockResolvedValue(jsonResponse(transcriptBody));

    const transport = new WorkerRecallTransport(() => USER_ID);
    const result = await transport.getUploadTranscript({
      uploadId: 'up_1',
      clientSecret: 'secret-abc',
    });

    const { url, headers } = callArgs();
    expect(url).toBe(`${TEST_BACKEND_URL}/api/upload-session/transcript?uploadId=up_1`);
    expect(headers.get('X-Client-Secret')).toBe('secret-abc');
    expect(headers.get('X-Mindstone-Auth')).toBe(`auth-for-${USER_ID}`);
    expect(headers.get('Content-Type')).toBe('application/json');

    expect(result).toEqual({ ok: true, status: 200, data: transcriptBody });
  });

  it('returns ok:false with status + errorText on failure (callers branch on 403/404)', async () => {
    fetchSpy.mockResolvedValue(jsonResponse('forbidden', { ok: false, status: 403 }));

    const transport = new WorkerRecallTransport(() => USER_ID);
    const result = await transport.getUploadTranscript({
      uploadId: 'up_1',
      clientSecret: 'secret-abc',
    });

    expect(result).toEqual({ ok: false, status: 403, errorText: 'forbidden' });
  });
});

describe('getRecallTransport factory', () => {
  it('returns a WorkerRecallTransport when no recallApiKey is set (enterprise/managed)', () => {
    const settings = {} as AppSettings;
    expect(getRecallTransport(settings, () => USER_ID)).toBeInstanceOf(WorkerRecallTransport);
  });

  it('returns a WorkerRecallTransport when recallApiKey is empty or whitespace', () => {
    const empty = { meetingBot: { recallApiKey: '' } } as unknown as AppSettings;
    const blank = { meetingBot: { recallApiKey: '   ' } } as unknown as AppSettings;
    expect(getRecallTransport(empty, () => USER_ID)).toBeInstanceOf(WorkerRecallTransport);
    expect(getRecallTransport(blank, () => USER_ID)).toBeInstanceOf(WorkerRecallTransport);
  });
});
