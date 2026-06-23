import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextContentUpdatedAt } from '../sessionTimestamps';

describe('nextContentUpdatedAt', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns Date.now() when previousUpdatedAt is undefined', () => {
    vi.spyOn(Date, 'now').mockReturnValue(10_000);
    expect(nextContentUpdatedAt(undefined)).toBe(10_000);
  });

  it('returns Date.now() when now is greater than previousUpdatedAt', () => {
    vi.spyOn(Date, 'now').mockReturnValue(20_000);
    expect(nextContentUpdatedAt(19_999)).toBe(20_000);
  });

  it('returns previousUpdatedAt + 1 when clock skew makes now <= previousUpdatedAt', () => {
    vi.spyOn(Date, 'now').mockReturnValue(30_000);
    expect(nextContentUpdatedAt(30_000)).toBe(30_001);
    expect(nextContentUpdatedAt(30_100)).toBe(30_101);
  });
});
