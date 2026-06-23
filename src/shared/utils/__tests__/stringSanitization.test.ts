import { describe, it, expect } from 'vitest';
import { sanitizeSurrogates } from '../stringSanitization';

describe('sanitizeSurrogates', () => {
  it('should preserve normal ASCII text', () => {
    const input = 'Hello, World!';
    expect(sanitizeSurrogates(input)).toBe(input);
  });

  it('should preserve valid emoji (surrogate pairs)', () => {
    const input = 'Hello 🧠 World';
    expect(sanitizeSurrogates(input)).toBe(input);
  });

  it('should preserve multiple valid emoji', () => {
    const input = '🎉 Party 🎊 Time 🥳';
    expect(sanitizeSurrogates(input)).toBe(input);
  });

  it('should replace unpaired high surrogate', () => {
    // High surrogate (U+D83E) without following low surrogate
    const input = 'test\uD83E end';
    expect(sanitizeSurrogates(input)).toBe('test\uFFFD end');
  });

  it('should replace unpaired low surrogate', () => {
    // Low surrogate (U+DDE0) without preceding high surrogate
    const input = 'test\uDDE0 end';
    expect(sanitizeSurrogates(input)).toBe('test\uFFFD end');
  });

  it('should replace high surrogate at end of string', () => {
    const input = 'test\uD83E';
    expect(sanitizeSurrogates(input)).toBe('test\uFFFD');
  });

  it('should replace low surrogate at start of string', () => {
    const input = '\uDDE0test';
    expect(sanitizeSurrogates(input)).toBe('\uFFFDtest');
  });

  it('should handle string with valid emoji followed by broken surrogate', () => {
    const input = '🧠 brain \uD83E broken';
    expect(sanitizeSurrogates(input)).toBe('🧠 brain \uFFFD broken');
  });

  it('should handle empty string', () => {
    expect(sanitizeSurrogates('')).toBe('');
  });

  it('should handle string with only valid surrogates', () => {
    const input = '🧠🎉🥳';
    expect(sanitizeSurrogates(input)).toBe(input);
  });

  it('should simulate the slice problem that causes API errors', () => {
    // Simulate what happens when 'test🧠end'.slice(0, 5) cuts the emoji
    const fullString = 'test🧠end';
    // In JS, '🧠'.length === 2, so fullString.length === 9
    // slice(0, 5) gives 'test' + high surrogate only
    const sliced = fullString.slice(0, 5);
    expect(sliced.length).toBe(5);
    expect(sliced.charCodeAt(4)).toBe(0xd83e); // High surrogate

    // Sanitize should replace the unpaired surrogate
    const sanitized = sanitizeSurrogates(sliced);
    expect(sanitized).toBe('test\uFFFD');

    // The sanitized string should produce valid JSON (can be parsed back)
    const json = JSON.stringify(sanitized);
    const parsed = JSON.parse(json);
    expect(parsed).toBe('test\uFFFD');
  });
});
