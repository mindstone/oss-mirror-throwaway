import { describe, expect, it } from 'vitest';
import { FINISH_LINE_MAX_LENGTH, normalizeFinishLine } from '../finishLine';

describe('normalizeFinishLine', () => {
  it('returns undefined for non-string inputs', () => {
    expect(normalizeFinishLine(undefined)).toBeUndefined();
    expect(normalizeFinishLine(null)).toBeUndefined();
    expect(normalizeFinishLine(42)).toBeUndefined();
    expect(normalizeFinishLine(true)).toBeUndefined();
    expect(normalizeFinishLine({})).toBeUndefined();
    expect(normalizeFinishLine([])).toBeUndefined();
  });

  it('returns undefined for empty strings', () => {
    expect(normalizeFinishLine('')).toBeUndefined();
  });

  it('returns undefined for whitespace-only strings', () => {
    expect(normalizeFinishLine('   ')).toBeUndefined();
    expect(normalizeFinishLine('\n\t  \r')).toBeUndefined();
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeFinishLine('  ready to send  ')).toBe('ready to send');
    expect(normalizeFinishLine('\nready to send\n')).toBe('ready to send');
  });

  it('preserves valid non-empty strings', () => {
    expect(normalizeFinishLine('The brief is ready to send.')).toBe('The brief is ready to send.');
  });

  it('caps strings at FINISH_LINE_MAX_LENGTH characters', () => {
    const long = 'a'.repeat(FINISH_LINE_MAX_LENGTH + 50);
    const result = normalizeFinishLine(long);
    expect(result).toHaveLength(FINISH_LINE_MAX_LENGTH);
    expect(result).toBe('a'.repeat(FINISH_LINE_MAX_LENGTH));
  });

  it('preserves strings at exactly the cap length', () => {
    const exactly = 'b'.repeat(FINISH_LINE_MAX_LENGTH);
    expect(normalizeFinishLine(exactly)).toBe(exactly);
  });

  it('trims before applying the length cap', () => {
    const padded = `  ${'c'.repeat(FINISH_LINE_MAX_LENGTH)}  `;
    const result = normalizeFinishLine(padded);
    expect(result).toHaveLength(FINISH_LINE_MAX_LENGTH);
    expect(result).toBe('c'.repeat(FINISH_LINE_MAX_LENGTH));
  });
});
