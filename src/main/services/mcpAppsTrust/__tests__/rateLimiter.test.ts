import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetRateLimiterForTests, checkLimit, recordHit, type RateLimitScope } from '../rateLimiter';
import { TRUST_POLICIES } from '../trustPolicies';

const baseScope: RateLimitScope = {
  sourcePackageId: 'GoogleWorkspace-joshua-example-com',
  sessionId: 'session-1',
  conversationId: 'conversation-1',
  iframeInstanceId: 'iframe-1',
};

function fill(scope: RateLimitScope, count: number): void {
  for (let index = 0; index < count; index += 1) {
    recordHit(scope, 'ui/updateModelContext');
  }
}

describe('mcpAppsTrust rateLimiter', () => {
  beforeEach(() => {
    _resetRateLimiterForTests();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-10T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('enforces per-iframe limits', () => {
    fill(baseScope, TRUST_POLICIES['ui/updateModelContext'].rateLimit.iframe);

    expect(checkLimit(baseScope, 'ui/updateModelContext')).toMatchObject({
      ok: false,
      tier: 'iframe',
    });
    expect(checkLimit({ ...baseScope, iframeInstanceId: 'iframe-2' }, 'ui/updateModelContext')).toEqual({ ok: true });
  });

  it('enforces per-conversation limits across iframes', () => {
    const limit = TRUST_POLICIES['ui/updateModelContext'].rateLimit.conversation;
    for (let index = 0; index < limit; index += 1) {
      recordHit({ ...baseScope, iframeInstanceId: `iframe-${index}` }, 'ui/updateModelContext');
    }

    expect(checkLimit({ ...baseScope, iframeInstanceId: 'iframe-new' }, 'ui/updateModelContext')).toMatchObject({
      ok: false,
      tier: 'conversation',
    });
    expect(checkLimit({ ...baseScope, conversationId: 'conversation-2' }, 'ui/updateModelContext')).toEqual({ ok: true });
  });

  it('enforces per-session limits across conversations', () => {
    const limit = TRUST_POLICIES['ui/updateModelContext'].rateLimit.session;
    for (let index = 0; index < limit; index += 1) {
      recordHit({
        ...baseScope,
        conversationId: `conversation-${index}`,
        iframeInstanceId: `iframe-${index}`,
      }, 'ui/updateModelContext');
    }

    expect(checkLimit({
      ...baseScope,
      conversationId: 'conversation-new',
      iframeInstanceId: 'iframe-new',
    }, 'ui/updateModelContext')).toMatchObject({
      ok: false,
      tier: 'session',
    });
    expect(checkLimit({ ...baseScope, sessionId: 'session-2' }, 'ui/updateModelContext')).toEqual({ ok: true });
  });

  it('enforces aggregate any-method limits', () => {
    const aggregateLimit = TRUST_POLICIES['ui/initialize'].rateLimit.aggregate ?? 0;
    for (let index = 0; index < aggregateLimit; index += 1) {
      recordHit(baseScope, 'ui/resize');
    }

    expect(checkLimit(baseScope, 'ui/initialize')).toMatchObject({
      ok: false,
      tier: 'aggregate',
    });
  });

  it('keeps aggregate limits at conversation scope across iframe reloads', () => {
    const aggregateLimit = TRUST_POLICIES['ui/initialize'].rateLimit.aggregate ?? 0;
    for (let index = 0; index < aggregateLimit; index += 1) {
      recordHit({ ...baseScope, iframeInstanceId: `iframe-reload-${index}` }, 'ui/resize');
    }

    expect(checkLimit({ ...baseScope, iframeInstanceId: 'fresh-iframe' }, 'ui/initialize')).toMatchObject({
      ok: false,
      tier: 'aggregate',
    });
    expect(checkLimit({ ...baseScope, conversationId: 'conversation-2' }, 'ui/initialize')).toEqual({ ok: true });
  });

  it('resets counters after the policy window elapses', () => {
    fill(baseScope, TRUST_POLICIES['ui/updateModelContext'].rateLimit.iframe);
    expect(checkLimit(baseScope, 'ui/updateModelContext')).toMatchObject({ ok: false });

    vi.advanceTimersByTime(TRUST_POLICIES['ui/updateModelContext'].windowMs + 1);

    expect(checkLimit(baseScope, 'ui/updateModelContext')).toEqual({ ok: true });
  });
});
