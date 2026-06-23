import { describe, expect, it } from 'vitest';
import { sessionsChannels } from '../sessions';

describe('sessions/content read IPC contracts', () => {
  it('accepts valid content read request payloads', () => {
    const parsed = sessionsChannels['content:read'].request.parse({
      sessionId: 'sess-1',
      contentId: 'cid-1',
    });
    expect(parsed).toEqual({ sessionId: 'sess-1', contentId: 'cid-1' });
  });

  it('accepts ok and failure response payloads', () => {
    const ok = sessionsChannels['content:read'].response.parse({
      reason: 'ok',
      bytesBase64: 'aGVsbG8=',
      mimeType: 'text/plain',
    });
    expect(ok.reason).toBe('ok');

    const missing = sessionsChannels['content:read'].response.parse({
      reason: 'missing',
    });
    expect(missing.reason).toBe('missing');
  });

  it('rejects invalid failure reasons', () => {
    expect(() =>
      sessionsChannels['content:read'].response.parse({
        reason: 'permission-denied',
      }),
    ).toThrow();
  });
});
