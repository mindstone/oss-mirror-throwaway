import { buildVoiceTranscriptionUrl } from '../voiceTranscriptionUrl';

describe('buildVoiceTranscriptionUrl', () => {
  it('includes sessionId and positive finite durationMs', () => {
    expect(buildVoiceTranscriptionUrl('https://cloud.test/', {
      sessionId: 'session-1',
      durationMs: 1234.56,
    })).toBe('https://cloud.test/api/voice/transcribe?sessionId=session-1&durationMs=1235');
  });

  it('omits missing sessionId and invalid durationMs', () => {
    expect(buildVoiceTranscriptionUrl('https://cloud.test', {
      sessionId: null,
      durationMs: Number.NaN,
    })).toBe('https://cloud.test/api/voice/transcribe');
  });
});
