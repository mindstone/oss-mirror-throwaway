import { describe, expect, it } from 'vitest';

import type { SafetyEvalResult } from '@core/safetyPromptTypes';
import type { SessionKind } from '@shared/sessionKind';

import {
  classifyFailClosed,
  resolveFailClosedDisposition,
  type FailClosedDisposition,
} from '../failClosedPolicy';

const baseResult: SafetyEvalResult = {
  decision: 'allow',
  reason: 'test',
  confidence: 'high',
};

describe('classifyFailClosed', () => {
  it('returns null for allow when failClosed is not true', () => {
    expect(classifyFailClosed(baseResult)).toBeNull();
  });

  it('returns policy for block when failClosed is not true', () => {
    const result: SafetyEvalResult = {
      ...baseResult,
      decision: 'block',
    };
    expect(classifyFailClosed(result)).toBe('policy');
  });

  it('returns rate-limited for failClosed rate-limited results', () => {
    const result: SafetyEvalResult = {
      ...baseResult,
      decision: 'block',
      failClosed: true,
      failClosedReason: 'rate-limited',
    };
    expect(classifyFailClosed(result)).toBe('rate-limited');
  });

  it.each([
    'queue-timeout',
    'parse-failure',
    'retries-exhausted',
  ] as const)('returns infra for failClosed reason %s', reason => {
    const result: SafetyEvalResult = {
      ...baseResult,
      decision: 'block',
      failClosed: true,
      failClosedReason: reason,
    };
    expect(classifyFailClosed(result)).toBe('infra');
  });

  it('returns infra for failClosed when reason is absent', () => {
    const result: SafetyEvalResult = {
      ...baseResult,
      decision: 'block',
      failClosed: true,
    };
    expect(classifyFailClosed(result)).toBe('infra');
  });
});

describe('resolveFailClosedDisposition', () => {
  const expectedByKind: Record<
    SessionKind,
    {
      withApprovalHandler: FailClosedDisposition;
      withoutApprovalHandler: FailClosedDisposition;
    }
  > = {
    conversation: {
      withApprovalHandler: 'ask_remote',
      withoutApprovalHandler: 'ask_local',
    },
    'meeting-companion': {
      withApprovalHandler: 'stage_for_later',
      withoutApprovalHandler: 'stage_for_later',
    },
    automation: {
      withApprovalHandler: 'stage_for_later',
      withoutApprovalHandler: 'stage_for_later',
    },
    'automation-insight': {
      withApprovalHandler: 'stage_for_later',
      withoutApprovalHandler: 'stage_for_later',
    },
    'meeting-analysis': {
      withApprovalHandler: 'stage_for_later',
      withoutApprovalHandler: 'stage_for_later',
    },
    'use-case-discovery': {
      withApprovalHandler: 'stage_for_later',
      withoutApprovalHandler: 'stage_for_later',
    },
    'cli-chat': {
      withApprovalHandler: 'ask_remote',
      withoutApprovalHandler: 'stage_for_later',
    },
    'memory-update': {
      withApprovalHandler: 'stage_for_later',
      withoutApprovalHandler: 'stage_for_later',
    },
    'meeting-qa': {
      withApprovalHandler: 'stage_for_later',
      withoutApprovalHandler: 'stage_for_later',
    },
    'error-eval': {
      withApprovalHandler: 'stage_for_later',
      withoutApprovalHandler: 'stage_for_later',
    },
    'calendar-sync': {
      withApprovalHandler: 'stage_for_later',
      withoutApprovalHandler: 'stage_for_later',
    },
  };

  const cases = (Object.entries(expectedByKind) as Array<
    [
      SessionKind,
      {
        withApprovalHandler: FailClosedDisposition;
        withoutApprovalHandler: FailClosedDisposition;
      },
    ]
  >).flatMap(([sessionKind, expected]) => [
    {
      sessionKind,
      hasApprovalHandler: true,
      expected: expected.withApprovalHandler,
    },
    {
      sessionKind,
      hasApprovalHandler: false,
      expected: expected.withoutApprovalHandler,
    },
  ]);

  it.each(cases)(
    'returns $expected for sessionKind=$sessionKind hasApprovalHandler=$hasApprovalHandler',
    ({ sessionKind, hasApprovalHandler, expected }) => {
      expect(resolveFailClosedDisposition({ sessionKind, hasApprovalHandler })).toBe(expected);
    },
  );

  it('prioritizes stage_for_later kinds even when approval handler exists', () => {
    expect(
      resolveFailClosedDisposition({
        sessionKind: 'automation',
        hasApprovalHandler: true,
      }),
    ).toBe('stage_for_later');
    expect(
      resolveFailClosedDisposition({
        sessionKind: 'meeting-companion',
        hasApprovalHandler: true,
      }),
    ).toBe('stage_for_later');
  });
});
