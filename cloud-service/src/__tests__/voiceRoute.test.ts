import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PassThrough } from 'node:stream';
import http from 'node:http';

const { transcribeAudioMock, MockVoiceTranscriptionError } = vi.hoisted(() => {
  const mock = vi.fn();

  class VoiceTranscriptionErrorForTest extends Error {
    readonly category: 'temporary' | 'billing' | 'auth' | 'network' | 'provider-error';

    constructor(
      message: string,
      category: 'temporary' | 'billing' | 'auth' | 'network' | 'provider-error',
    ) {
      super(message);
      this.name = 'VoiceTranscriptionError';
      this.category = category;
    }
  }

  return {
    transcribeAudioMock: mock,
    MockVoiceTranscriptionError: VoiceTranscriptionErrorForTest,
  };
});

vi.mock('../../../src/core/services/audioService', () => ({
  transcribeAudio: (...args: unknown[]) => transcribeAudioMock(...args),
  textToSpeechStream: vi.fn(),
  VoiceTranscriptionError: MockVoiceTranscriptionError,
}));

vi.mock('../../../src/core/services/settingsStore', () => ({
  getSettings: () => ({ voice: { provider: 'openai-whisper' } }),
}));

import { handleVoiceTranscribe } from '../routes/voice';

type MockVoiceRes = http.ServerResponse & {
  _status: number;
  _body: string;
  _headers: Record<string, string>;
};

type VoiceErrorCategoryForTest = 'temporary' | 'billing' | 'auth' | 'network' | 'provider-error';

function createMockReq(body: Buffer, url = '/api/voice/transcribe'): http.IncomingMessage {
  const stream = new PassThrough();
  const req = stream as unknown as http.IncomingMessage;
  req.method = 'POST';
  req.url = url;
  req.headers = {
    'content-type': 'audio/mp4',
    host: 'localhost',
  };
  process.nextTick(() => {
    stream.end(body);
  });
  return req;
}

function createMockRes(): MockVoiceRes {
  const res = {
    _status: 0,
    _body: '',
    _headers: {},
    writeHead(status: number, headers?: Record<string, string>) {
      this._status = status;
      this._headers = { ...this._headers, ...(headers ?? {}) };
    },
    end(body: string) {
      this._body = body;
    },
  };
  return res as unknown as MockVoiceRes;
}

describe('handleVoiceTranscribe', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes client duration hint to transcription service', async () => {
    transcribeAudioMock.mockResolvedValueOnce('hello');
    const req = createMockReq(Buffer.from('audio-bytes'), '/api/voice/transcribe?sessionId=s1&durationMs=12345');
    const res = createMockRes();

    await handleVoiceTranscribe(req, res);

    expect(res._status).toBe(200);
    expect(JSON.parse(res._body)).toEqual({ transcript: 'hello' });
    expect(transcribeAudioMock).toHaveBeenCalledWith(expect.objectContaining({
      mimeType: 'audio/mp4',
      durationMs: 12345,
    }));
  });

  it.each([
    ['temporary', 503],
    ['network', 503],
    ['auth', 424],
    ['billing', 424],
    ['provider-error', 503],
  ] satisfies Array<[VoiceErrorCategoryForTest, number]>)(
    'returns structured %s transcription category',
    async (category, expectedStatus) => {
      transcribeAudioMock.mockRejectedValueOnce(
        new MockVoiceTranscriptionError(`Voice failure: ${category}`, category),
      );
      const req = createMockReq(Buffer.from('audio-bytes'));
      const res = createMockRes();

      await handleVoiceTranscribe(req, res);

      expect(res._status).toBe(expectedStatus);
      expect(JSON.parse(res._body)).toEqual({
        error: {
          code: 'TRANSCRIPTION_FAILED',
          message: `Voice failure: ${category}`,
        },
        voiceErrorCategory: category,
      });
    },
  );

  it('returns structured retryable transcription category', async () => {
    transcribeAudioMock.mockRejectedValueOnce(
      new MockVoiceTranscriptionError('Provider is temporarily unavailable.', 'temporary'),
    );
    const req = createMockReq(Buffer.from('audio-bytes'));
    const res = createMockRes();

    await handleVoiceTranscribe(req, res);

    expect(res._status).toBe(503);
    expect(JSON.parse(res._body)).toEqual({
      error: {
        code: 'TRANSCRIPTION_FAILED',
        message: 'Provider is temporarily unavailable.',
      },
      voiceErrorCategory: 'temporary',
    });
  });

  it('returns structured non-retryable transcription category', async () => {
    transcribeAudioMock.mockRejectedValueOnce(
      new MockVoiceTranscriptionError('Your voice provider account has run out of credits.', 'billing'),
    );
    const req = createMockReq(Buffer.from('audio-bytes'));
    const res = createMockRes();

    await handleVoiceTranscribe(req, res);

    expect(res._status).toBe(424);
    expect(JSON.parse(res._body)).toEqual({
      error: {
        code: 'TRANSCRIPTION_FAILED',
        message: 'Your voice provider account has run out of credits.',
      },
      voiceErrorCategory: 'billing',
    });
  });

  it('keeps unexpected route failures as generic 500 transcription failures', async () => {
    transcribeAudioMock.mockRejectedValueOnce(new Error('Unexpected crash'));
    const req = createMockReq(Buffer.from('audio-bytes'));
    const res = createMockRes();

    await handleVoiceTranscribe(req, res);

    expect(res._status).toBe(500);
    expect(JSON.parse(res._body)).toEqual({
      error: {
        code: 'TRANSCRIPTION_FAILED',
        message: 'Unexpected crash',
      },
    });
  });
});
