/**
 * triageIssue gate ordering — particularly the new noise-pattern pre-filter
 * that prevents the autopilot from burning bug-fixer slots on documented
 * Chromium / macOS / errno crashes whose Sentry level is fatal/crash.
 */

import { describe, expect, it } from 'vitest';

import type { PolledIssue } from '../poller.ts';
import { triageIssue } from '../poller.ts';

function makeIssue(overrides: Partial<PolledIssue> = {}): PolledIssue {
  return {
    sentryId: 'SENTRY-T',
    sentryUrl: 'https://sentry.io/issues/SENTRY-T',
    title: 'Ordinary error',
    errorType: 'exception',
    isUserReported: false,
    occurrences: 1,
    users: 1,
    level: 'error',
    firstSeen: '2026-05-22T00:00:00Z',
    lastSeen: '2026-05-22T00:00:00Z',
    ...overrides,
  };
}

describe('triageIssue', () => {
  it('always dispatches user-reported issues even if they match a noise pattern', () => {
    expect(
      triageIssue(
        makeIssue({
          isUserReported: true,
          title: 'logging::LogMessage::HandleFatal',
        }),
      ),
    ).toBe('dispatch');
  });

  it('always dispatches feedback issues', () => {
    expect(triageIssue(makeIssue({ errorType: 'feedback' }))).toBe('dispatch');
  });

  it('skips a fatal Chromium native crash via the noise pre-filter (was previously dispatched)', () => {
    expect(
      triageIssue(
        makeIssue({
          title: 'partition_alloc::internal::OnNoMemoryInternal()',
          level: 'fatal',
          errorType: 'crash',
        }),
      ),
    ).toBe('skip');
  });

  it('skips a fatal macOS system crash via the noise pre-filter', () => {
    expect(
      triageIssue(
        makeIssue({
          title: '-[NSApplication _crashOnException:]',
          level: 'fatal',
          errorType: 'crash',
        }),
      ),
    ).toBe('skip');
  });

  it('skips a network-failure errno even at high volume (still noise)', () => {
    expect(
      triageIssue(
        makeIssue({
          title: 'getaddrinfo ENOTFOUND example.com',
          occurrences: 50,
          users: 12,
        }),
      ),
    ).toBe('skip');
  });

  it('still dispatches genuine fatal/crash issues that do not match noise patterns', () => {
    expect(
      triageIssue(
        makeIssue({
          title: 'TypeError: cannot read property of undefined',
          level: 'fatal',
          errorType: 'crash',
        }),
      ),
    ).toBe('dispatch');
  });

  it('dispatches a high-volume non-noise issue (>5 occurrences AND >1 user)', () => {
    expect(triageIssue(makeIssue({ occurrences: 10, users: 5 }))).toBe('dispatch');
  });

  it('skips low-impact non-noise issues (legacy skip path)', () => {
    expect(triageIssue(makeIssue({ occurrences: 3, users: 1 }))).toBe('skip');
  });
});
