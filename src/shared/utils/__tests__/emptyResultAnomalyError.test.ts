import { describe, expect, it } from 'vitest';
import {
  EmptyResultAnomalyError,
  isEmptyResultAnomalyError,
} from '../emptyResultAnomalyError';

describe('EmptyResultAnomalyError', () => {
  it('preserves the empty_result_anomaly message prefix for legacy substring matching', () => {
    const err = new EmptyResultAnomalyError({
      lastTurnOutputTokens: 0,
      loopTotalOutputTokens: 200,
      model: 'claude-opus-4-7',
      stopReason: 'end_turn',
    });

    expect(err.message).toContain('empty_result_anomaly');
    expect(err.message).toContain('claude-opus-4-7');
  });

  it('uses last_turn_output_tokens in the message when present', () => {
    const err = new EmptyResultAnomalyError({
      lastTurnOutputTokens: 50,
      loopTotalOutputTokens: 200,
      model: 'claude-opus-4-7',
      stopReason: 'end_turn',
    });

    // Uses last_turn_output_tokens (50), not loop-total (200)
    expect(err.message).toContain('50 output tokens');
  });

  it('falls back to loop-total tokens when last_turn_output_tokens is undefined', () => {
    const err = new EmptyResultAnomalyError({
      lastTurnOutputTokens: undefined,
      loopTotalOutputTokens: 200,
      model: 'claude-opus-4-7',
      stopReason: 'end_turn',
    });

    expect(err.message).toContain('200 output tokens');
  });

  it('exposes typed diagnostic fields for downstream Sentry capture', () => {
    const err = new EmptyResultAnomalyError({
      lastTurnOutputTokens: 0,
      loopTotalOutputTokens: 150,
      model: 'claude-opus-4-7',
      stopReason: 'end_turn',
    });

    expect(err.lastTurnOutputTokens).toBe(0);
    expect(err.loopTotalOutputTokens).toBe(150);
    expect(err.model).toBe('claude-opus-4-7');
    expect(err.stopReason).toBe('end_turn');
  });

  it('is recognized by isEmptyResultAnomalyError type guard', () => {
    const err = new EmptyResultAnomalyError({
      lastTurnOutputTokens: 50,
      loopTotalOutputTokens: 50,
      model: 'claude-opus-4-7',
      stopReason: 'end_turn',
    });

    expect(isEmptyResultAnomalyError(err)).toBe(true);
    expect(isEmptyResultAnomalyError(new Error('not this one'))).toBe(false);
    expect(isEmptyResultAnomalyError(null)).toBe(false);
    expect(isEmptyResultAnomalyError(undefined)).toBe(false);
    expect(isEmptyResultAnomalyError('string error')).toBe(false);
  });

  it('has the correct error name for Sentry fingerprinting', () => {
    const err = new EmptyResultAnomalyError({
      lastTurnOutputTokens: 0,
      loopTotalOutputTokens: 100,
      model: 'unknown',
      stopReason: null,
    });

    expect(err.name).toBe('EmptyResultAnomalyError');
  });
});
