import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ModelError } from '../modelErrors';

const {
  recordContextOverflowOnProfileMock,
  recordOutputCapOnProfileMock,
} = vi.hoisted(() => ({
  recordContextOverflowOnProfileMock: vi.fn(),
  recordOutputCapOnProfileMock: vi.fn(),
}));

vi.mock('../learnedProfileWriter', () => ({
  recordContextOverflowOnProfile: recordContextOverflowOnProfileMock,
  recordOutputCapOnProfile: recordOutputCapOnProfileMock,
}));

import {
  dispatchLearnedLimitsFromError,
  safeDispatchLearnedLimitsFromError,
} from '../dispatchLearnedLimitsFromError';

describe('dispatchLearnedLimitsFromError', () => {
  const baseCtx = {
    turnId: 'turn-1',
    model: 'claude-sonnet-4-6',
    profileId: 'p1',
  } as const;

  beforeEach(() => {
    vi.clearAllMocks();
    recordOutputCapOnProfileMock.mockReturnValue({
      ok: true,
      observedCap: 8192,
      profileId: 'p1',
    });
  });

  it('routes context-overflow details to recordContextOverflowOnProfile', () => {
    const err = new ModelError('context_overflow', 'too many tokens', 400, 'Anthropic', {
      details: { contextOverflow: { lastKnownInputTokens: 120_000 } },
    });

    const result = dispatchLearnedLimitsFromError(err, baseCtx);

    expect(recordContextOverflowOnProfileMock).toHaveBeenCalledWith({
      model: 'claude-sonnet-4-6',
      profileId: 'p1',
      lastKnownInputTokens: 120_000,
    });
    expect(recordOutputCapOnProfileMock).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it('routes output-cap details to recordOutputCapOnProfile and returns WriteResult', () => {
    const err = new ModelError('invalid_request', 'max_tokens too large', 400, 'Anthropic', {
      details: { outputCap: 8192 },
    });

    const result = dispatchLearnedLimitsFromError(err, baseCtx);

    expect(recordOutputCapOnProfileMock).toHaveBeenCalledWith({
      model: 'claude-sonnet-4-6',
      profileId: 'p1',
      observedCap: 8192,
    });
    expect(recordContextOverflowOnProfileMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: true,
      observedCap: 8192,
      profileId: 'p1',
    });
  });

  it('returns null and no-ops when neither detail is present', () => {
    const err = new ModelError('invalid_request', 'invalid request', 400, 'Anthropic');

    const result = dispatchLearnedLimitsFromError(err, baseCtx);

    expect(recordContextOverflowOnProfileMock).not.toHaveBeenCalled();
    expect(recordOutputCapOnProfileMock).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it('passes through persistence-failed WriteResult from output-cap writer', () => {
    recordOutputCapOnProfileMock.mockReturnValue({
      ok: false,
      reason: 'persistence-failed',
    });
    const err = new ModelError('invalid_request', 'max_tokens too large', 400, 'Anthropic', {
      details: { outputCap: 4096 },
    });

    const result = dispatchLearnedLimitsFromError(err, baseCtx);

    expect(result).toEqual({
      ok: false,
      reason: 'persistence-failed',
    });
  });

  it('prioritizes context-overflow when both contextOverflow and outputCap are present', () => {
    const err = new ModelError('invalid_request', 'mixed details', 400, 'Anthropic', {
      details: { contextOverflow: { lastKnownInputTokens: 200_000 }, outputCap: 8_192 },
    });

    const result = dispatchLearnedLimitsFromError(err, baseCtx);

    expect(recordContextOverflowOnProfileMock).toHaveBeenCalledWith({
      model: 'claude-sonnet-4-6',
      profileId: 'p1',
      lastKnownInputTokens: 200_000,
    });
    expect(recordOutputCapOnProfileMock).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it('no-ops when outputCap detail is malformed string data', () => {
    const err = new ModelError('invalid_request', 'max_tokens too large', 400, 'Anthropic', {
      details: { outputCap: '8192' as unknown as number },
    });

    const result = dispatchLearnedLimitsFromError(err, baseCtx);

    expect(recordContextOverflowOnProfileMock).not.toHaveBeenCalled();
    expect(recordOutputCapOnProfileMock).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it('safeDispatch returns null and logs warn when dispatcher throws, preserving original error flow', () => {
    const dispatchFailure = new Error('writer boom');
    recordOutputCapOnProfileMock.mockImplementation(() => {
      throw dispatchFailure;
    });
    const warn = vi.fn();
    const err = new ModelError('invalid_request', 'max_tokens too large', 400, 'Anthropic', {
      details: { outputCap: 8_192 },
    });

    let caught: unknown;
    try {
      const result = safeDispatchLearnedLimitsFromError(err, baseCtx, { warn });
      expect(result).toBeNull();
      throw err;
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(err);
    expect(recordOutputCapOnProfileMock).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      { error: dispatchFailure },
      'dispatchLearnedLimitsFromError threw — preserving original error',
    );
  });
});
