import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '@core/logger';
import {
  getRecentFailures,
  recordContentResolutionFailure,
  resetContentResolutionFailuresForTests,
} from '../contentResolutionFailureRecorder';

const addBreadcrumb = vi.fn();
 
vi.mock('@core/errorReporter', () => ({
  getErrorReporter: () => ({
    addBreadcrumb,
  }),
}));

function createMockLog(): Logger {
  return { warn: vi.fn() } as unknown as Logger;
}

describe('contentResolutionFailureRecorder', () => {
  beforeEach(() => {
    addBreadcrumb.mockReset();
    resetContentResolutionFailuresForTests();
  });

  it('emits a structured warn breadcrumb with hashed identifiers', () => {
    const log = createMockLog();
    recordContentResolutionFailure({
      sessionId: 'sess-1234',
      contentId: 'c'.repeat(32),
      reason: 'missing',
      details: { provider: 'desktop' },
      log,
    });

    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'desktop',
        reason: 'missing',
        sessionIdHash: expect.any(String),
        contentIdHash: expect.any(String),
      }),
      'content-resolution-failure',
    );
    expect(addBreadcrumb).toHaveBeenCalledWith(expect.objectContaining({
      category: 'content-resolution',
      message: 'content-resolution-failure',
    }));
  });

  it('ring buffer is capped to the most recent 100 entries', () => {
    const log = createMockLog();
    for (let i = 0; i < 110; i += 1) {
      recordContentResolutionFailure({
        sessionId: 'sess-cap',
        contentId: `cid-${i}`,
        reason: 'fetch-failed',
        details: { index: i },
        log,
      });
    }
    const failures = getRecentFailures();
    expect(failures).toHaveLength(100);
    expect(failures[0]?.details).toEqual({ index: 10 });
    expect(failures[99]?.details).toEqual({ index: 109 });
  });

  it('records hashed ids instead of raw ids', () => {
    const log = createMockLog();
    recordContentResolutionFailure({ sessionId: 'A-raw-id', contentId: 'content-raw-id', reason: 'missing', log });
    const failure = getRecentFailures()[0];
    expect(failure?.sessionIdHash).toBeDefined();
    expect(failure?.contentIdHash).toBeDefined();
    expect(failure?.sessionIdHash).not.toContain('A-raw-id');
    expect(failure?.contentIdHash).not.toContain('content-raw-id');
  });

  it('preserves open-union unknown reason strings', () => {
    const log = createMockLog();
    recordContentResolutionFailure({
      sessionId: 'sess-f',
      contentId: 'cid',
      reason: 'future-reason-99',
      log,
    });
    expect(getRecentFailures()[0]?.reason).toBe('future-reason-99');
  });
});
