/**
 * Contract tests for DirectRecallTransport (BYOK).
 *
 * Asserts the direct-to-Recall round-trips reproduce what the worker does for
 * the SDK upload path (`meeting-bot-worker/src/index.ts`):
 *  - create   → POST /api/v1/sdk_upload/ with `Authorization: Token <key>`,
 *               returns upload_token + persists the real Recall id as recallUploadId
 *  - status   → two-hop GET /sdk_upload/{id}/ → GET /recording/{id}/ deriving
 *               transcriptReady from media_shortcuts.transcript
 *  - transcript → GET /sdk_upload/{id}/ → GET /recording/{id}/ → download artifact
 *               → segment→"Speaker: text" formatter shape
 *  - routing  → getRecallTransport returns DirectRecallTransport when a key is set
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

import {
  DirectRecallTransport,
  WorkerRecallTransport,
  getRecallTransport,
} from '../recallTransport';
import type { AppSettings } from '@shared/types/settings';

const KEY = 'rk_live_abc';
const REST_BASE = 'https://us-west-2.recall.ai/api/v1';

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

function callArgs(n = 0): { url: string; init: RequestInit; headers: Headers } {
  const [url, init] = fetchSpy.mock.calls[n] as [string, RequestInit | undefined];
  return { url, init: init ?? {}, headers: new Headers(init?.headers) };
}

describe('DirectRecallTransport — create upload session', () => {
  it('POSTs to Recall /sdk_upload/ with Token auth and returns upload_token + recallUploadId', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ id: 'rec_up_1', upload_token: 'tok_1' }));

    const transport = new DirectRecallTransport(KEY);
    const result = await transport.createUploadSession({
      meetingTitle: 'Standup',
      // clientSecret intentionally omitted — Direct ignores it
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const { url, init, headers } = callArgs();
    expect(url).toBe(`${REST_BASE}/sdk_upload/`);
    expect(init.method).toBe('POST');
    expect(headers.get('Authorization')).toBe(`Token ${KEY}`);
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({
      metadata: { meeting_title: 'Standup' },
    });

    expect(result).toEqual({
      ok: true,
      status: 200,
      data: { uploadId: 'rec_up_1', upload_token: 'tok_1', recallUploadId: 'rec_up_1' },
    });
  });

  it('returns ok:false with status + errorText when Recall rejects the create', async () => {
    fetchSpy.mockResolvedValue(jsonResponse('bad key', { ok: false, status: 401 }));

    const transport = new DirectRecallTransport(KEY);
    const result = await transport.createUploadSession({ meetingTitle: 'x' });

    expect(result).toEqual({ ok: false, status: 401, errorText: 'bad key' });
  });
});

describe('DirectRecallTransport — get upload status (two-hop)', () => {
  it('reads sdk_upload then recording.media_shortcuts.transcript → transcriptReady', async () => {
    fetchSpy
      .mockResolvedValueOnce(
        jsonResponse({ id: 'rec_up_1', status: { code: 'complete' }, recording_id: 'rec_1' }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          media_shortcuts: {
            transcript: { status: { code: 'done' }, data: { download_url: 'https://dl/x' } },
          },
        }),
      );

    const transport = new DirectRecallTransport(KEY);
    const result = await transport.getUploadStatus({ uploadId: 'rec_up_1', recallUploadId: 'rec_up_1' });

    expect(callArgs(0).url).toBe(`${REST_BASE}/sdk_upload/rec_up_1/`);
    expect(callArgs(0).headers.get('Authorization')).toBe(`Token ${KEY}`);
    expect(callArgs(1).url).toBe(`${REST_BASE}/recording/rec_1/`);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toMatchObject({
        success: true,
        status: 'complete',
        transcriptReady: true,
        transcriptFailed: false,
        recordingId: 'rec_1',
      });
    }
  });

  it('does not make the recording hop while the upload is still uploading', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ id: 'rec_up_1', status: { code: 'uploading' } }));

    const transport = new DirectRecallTransport(KEY);
    const result = await transport.getUploadStatus({ uploadId: 'rec_up_1' });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.transcriptReady).toBe(false);
      expect(result.data.status).toBe('uploading');
    }
  });

  it('marks transcriptFailed when the upload status is failed', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ id: 'rec_up_1', status: { code: 'failed', sub_code: 'audio_error' } }),
    );

    const transport = new DirectRecallTransport(KEY);
    const result = await transport.getUploadStatus({ uploadId: 'rec_up_1' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.transcriptFailed).toBe(true);
      expect(result.data.asyncError).toBe('audio_error');
    }
  });

  it('returns ok:false when the sdk_upload fetch fails', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse('nope', { ok: false, status: 404 }));

    const transport = new DirectRecallTransport(KEY);
    const result = await transport.getUploadStatus({ uploadId: 'rec_up_1' });

    expect(result).toEqual({ ok: false, status: 404 });
  });

  it('falls back to uploadId when recallUploadId is not supplied', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ id: 'rec_up_9', status: { code: 'uploading' } }));

    const transport = new DirectRecallTransport(KEY);
    await transport.getUploadStatus({ uploadId: 'rec_up_9' });

    expect(callArgs(0).url).toBe(`${REST_BASE}/sdk_upload/rec_up_9/`);
  });
});

describe('DirectRecallTransport — get upload transcript (+ formatter shape)', () => {
  it('downloads the artifact and formats segments into the consumed shape', async () => {
    const segments = [
      {
        participant: { name: 'Alice' },
        words: [
          { text: 'hello', end_timestamp: { relative: 1.4 } },
          { text: 'there', end_timestamp: { relative: 2.0 } },
        ],
      },
      {
        participant: { name: 'Bob' },
        words: [{ text: 'hi', end_timestamp: { relative: 3.6 } }],
      },
    ];

    fetchSpy
      .mockResolvedValueOnce(
        jsonResponse({
          id: 'rec_up_1',
          status: { code: 'complete' },
          recording_id: 'rec_1',
          metadata: { meeting_title: 'Standup' },
          created_at: '2026-06-06T00:00:00.000Z',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          media_shortcuts: { transcript: { status: { code: 'done' }, data: { download_url: 'https://dl/x' } } },
        }),
      )
      .mockResolvedValueOnce(jsonResponse(segments));

    const transport = new DirectRecallTransport(KEY);
    const result = await transport.getUploadTranscript({ uploadId: 'rec_up_1', recallUploadId: 'rec_up_1' });

    expect(callArgs(2).url).toBe('https://dl/x'); // signed artifact, no auth header needed

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({
        success: true,
        transcript: 'Alice: hello there\nBob: hi',
        participants: ['Alice', 'Bob'],
        duration: 4, // Math.round(3.6)
        meetingTitle: 'Standup',
        startTime: '2026-06-06T00:00:00.000Z',
      });
    }
  });

  it('returns a not-ready (success:false) payload while the transcript is still pending', async () => {
    fetchSpy
      .mockResolvedValueOnce(
        jsonResponse({ id: 'rec_up_1', status: { code: 'complete' }, recording_id: 'rec_1' }),
      )
      .mockResolvedValueOnce(jsonResponse({ media_shortcuts: { transcript: { status: { code: 'processing' } } } }));

    const transport = new DirectRecallTransport(KEY);
    const result = await transport.getUploadTranscript({ uploadId: 'rec_up_1' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.success).toBe(false);
      expect(result.data.transcript).toBe('');
    }
  });

  it('returns a not-ready payload when the upload is not yet complete', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ id: 'rec_up_1', status: { code: 'uploading' } }));

    const transport = new DirectRecallTransport(KEY);
    const result = await transport.getUploadTranscript({ uploadId: 'rec_up_1' });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.success).toBe(false);
    }
  });

  it('returns ok:false with status when the recording fetch fails', async () => {
    fetchSpy
      .mockResolvedValueOnce(
        jsonResponse({ id: 'rec_up_1', status: { code: 'complete' }, recording_id: 'rec_1' }),
      )
      .mockResolvedValueOnce(jsonResponse('gone', { ok: false, status: 404 }));

    const transport = new DirectRecallTransport(KEY);
    const result = await transport.getUploadTranscript({ uploadId: 'rec_up_1' });

    expect(result).toEqual({ ok: false, status: 404, errorText: 'gone' });
  });
});

describe('getRecallTransport routing', () => {
  it('returns DirectRecallTransport when a non-empty recallApiKey is set', () => {
    const settings = { meetingBot: { recallApiKey: KEY } } as unknown as AppSettings;
    expect(getRecallTransport(settings, () => 'u1')).toBeInstanceOf(DirectRecallTransport);
  });

  it('trims the key and routes Worker when it is whitespace-only', () => {
    const settings = { meetingBot: { recallApiKey: '   ' } } as unknown as AppSettings;
    expect(getRecallTransport(settings, () => 'u1')).toBeInstanceOf(WorkerRecallTransport);
  });
});
