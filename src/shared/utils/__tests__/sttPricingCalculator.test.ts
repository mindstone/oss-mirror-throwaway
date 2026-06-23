import { describe, it, expect } from 'vitest';
import { calculateSttCost } from '../sttPricingCalculator';

describe('calculateSttCost', () => {
  it('calculates cost for gpt-4o-mini-transcribe', () => {
    // 60 seconds at $0.003/min = $0.003
    expect(calculateSttCost('gpt-4o-mini-transcribe', 60_000)).toBeCloseTo(0.003, 6);
  });

  it('calculates cost for gpt-4o-transcribe', () => {
    // 60 seconds at $0.006/min = $0.006
    expect(calculateSttCost('gpt-4o-transcribe', 60_000)).toBeCloseTo(0.006, 6);
  });

  it('calculates cost for whisper-1', () => {
    // 60 seconds at $0.006/min = $0.006
    expect(calculateSttCost('whisper-1', 60_000)).toBeCloseTo(0.006, 6);
  });

  it('strips date suffix for lookup', () => {
    expect(calculateSttCost('gpt-4o-mini-transcribe-2025-12-15', 60_000)).toBeCloseTo(0.003, 6);
    expect(calculateSttCost('gpt-4o-transcribe-2025-09-03', 60_000)).toBeCloseTo(0.006, 6);
  });

  it('returns null for unknown models', () => {
    expect(calculateSttCost('scribe_v2', 60_000)).toBeNull();
    expect(calculateSttCost('local-parakeet', 60_000)).toBeNull();
    expect(calculateSttCost('unknown-model', 60_000)).toBeNull();
  });

  it('returns null for invalid duration', () => {
    expect(calculateSttCost('whisper-1', undefined)).toBeNull();
    expect(calculateSttCost('whisper-1', 0)).toBeNull();
    expect(calculateSttCost('whisper-1', -1000)).toBeNull();
    expect(calculateSttCost('whisper-1', NaN)).toBeNull();
    expect(calculateSttCost('whisper-1', Infinity)).toBeNull();
  });

  it('returns null for undefined model', () => {
    expect(calculateSttCost(undefined, 60_000)).toBeNull();
  });

  it('scales linearly with duration', () => {
    const cost30s = calculateSttCost('whisper-1', 30_000)!;
    const cost60s = calculateSttCost('whisper-1', 60_000)!;
    expect(cost60s).toBeCloseTo(cost30s * 2, 10);
  });
});
