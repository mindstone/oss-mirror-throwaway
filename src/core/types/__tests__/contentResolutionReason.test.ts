import { describe, expect, it } from 'vitest';
import {
  KNOWN_CONTENT_RESOLUTION_REASONS,
  contentResolutionReasonSchema,
  normalizeContentResolutionReason,
} from '../contentResolutionReason';

describe('contentResolutionReason', () => {
  it('exposes the full known-literal set', () => {
    expect(new Set(KNOWN_CONTENT_RESOLUTION_REASONS)).toEqual(
      new Set([
        'ok',
        'pending-upload',
        'missing',
        'fetch-failed',
        'truncated-for-budget',
        'unknown',
      ]),
    );
  });

  it('normalizes unknown values to unknown', () => {
    expect(normalizeContentResolutionReason('ok')).toBe('ok');
    expect(normalizeContentResolutionReason('missing')).toBe('missing');
    expect(normalizeContentResolutionReason('future-reason-42')).toBe('unknown');
    expect(normalizeContentResolutionReason(42)).toBe('unknown');
  });

  it('Zod schema accepts known and unknown string values', () => {
    expect(contentResolutionReasonSchema.parse('missing')).toBe('missing');
    expect(contentResolutionReasonSchema.parse('future-reason')).toBe('future-reason');
    expect(() => contentResolutionReasonSchema.parse(42)).toThrow();
  });
});
