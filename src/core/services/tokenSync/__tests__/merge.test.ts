import { describe, expect, it } from 'vitest';
import { mergeDecision } from '../merge';

describe('mergeDecision', () => {
  it('adopts peer when local metadata is missing', () => {
    expect(mergeDecision(null, {
      expiryEpochMs: 2_000,
      mtimeMs: 10,
      surfaceWrote: 'cloud',
    })).toBe('adopt_peer');
  });

  it('adopts peer when peer expiry is strictly newer', () => {
    expect(mergeDecision(
      { expiryEpochMs: 10_000, mtimeMs: 50, surfaceWrote: 'desktop' },
      { expiryEpochMs: 12_500, mtimeMs: 55, surfaceWrote: 'cloud' },
      1_000,
    )).toBe('adopt_peer');
  });

  it('keeps local when local expiry is newer', () => {
    expect(mergeDecision(
      { expiryEpochMs: 20_000, mtimeMs: 40, surfaceWrote: 'desktop' },
      { expiryEpochMs: 18_500, mtimeMs: 60, surfaceWrote: 'cloud' },
      1_000,
    )).toBe('keep_local');
  });

  it('returns tie_cloud_wins inside leniency window', () => {
    expect(mergeDecision(
      { expiryEpochMs: 20_000, mtimeMs: 10, surfaceWrote: 'desktop' },
      { expiryEpochMs: 20_500, mtimeMs: 20, surfaceWrote: 'cloud' },
      1_000,
    )).toBe('tie_cloud_wins');
  });

  it('is replay-idempotent for identical inputs', () => {
    const local = { expiryEpochMs: 15_000, mtimeMs: 10, surfaceWrote: 'desktop' as const };
    const peer = { expiryEpochMs: 15_500, mtimeMs: 20, surfaceWrote: 'cloud' as const };

    const first = mergeDecision(local, peer, 1_000);
    const second = mergeDecision(local, peer, 1_000);
    expect(first).toBe(second);
  });
});
