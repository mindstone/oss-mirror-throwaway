import { generateMobileSessionId } from '../sessionId';

describe('generateMobileSessionId', () => {
  it('returns a session ID in the expected format', () => {
    const sessionId = generateMobileSessionId();

    expect(sessionId).toMatch(/^mobile-\d+-[a-z0-9]+$/);
  });

  it('returns a unique ID on each call', () => {
    const first = generateMobileSessionId();
    const second = generateMobileSessionId();
    const third = generateMobileSessionId();

    expect(new Set([first, second, third]).size).toBe(3);
  });
});
