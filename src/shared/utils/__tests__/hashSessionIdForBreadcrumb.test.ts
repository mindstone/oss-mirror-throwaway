import { describe, expect, it } from 'vitest';
import { hashSessionIdForBreadcrumb } from '../hashSessionIdForBreadcrumb';

describe('hashSessionIdForBreadcrumb', () => {
  it('returns a stable 8-char hex hash for the same session id', () => {
    const sessionId = 'session-1234';

    const first = hashSessionIdForBreadcrumb(sessionId);
    const second = hashSessionIdForBreadcrumb(sessionId);

    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{8}$/);
  });

  it('produces different hashes for different session ids', () => {
    const a = hashSessionIdForBreadcrumb('session-a');
    const b = hashSessionIdForBreadcrumb('session-b');

    expect(a).not.toBe(b);
  });
});
