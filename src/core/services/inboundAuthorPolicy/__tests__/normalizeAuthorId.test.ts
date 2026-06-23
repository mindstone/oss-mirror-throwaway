import { describe, expect, it } from 'vitest';
import { normalizeAuthorId } from '../normalizeAuthorId';

describe('normalizeAuthorId', () => {
  it('normalizes Slack IDs with trailing whitespace', () => {
    expect(normalizeAuthorId('slack', 'U123abc   ')).toBe('U123ABC');
  });

  it('normalizes Slack lowercase IDs to uppercase', () => {
    expect(normalizeAuthorId('slack', 'u999zzz')).toBe('U999ZZZ');
  });

  it('normalizes mixed-case Slack IDs to uppercase', () => {
    expect(normalizeAuthorId('slack', 'uAbC123xYz')).toBe('UABC123XYZ');
  });

  it('strips bidi control characters before Slack normalization', () => {
    expect(normalizeAuthorId('slack', '\u202Eu123abc')).toBe('U123ABC');
  });

  it('strips zero-width characters before Slack normalization', () => {
    expect(normalizeAuthorId('slack', 'U12\u200B3abc')).toBe('U123ABC');
  });

  it('strips ASCII control characters before Slack normalization', () => {
    expect(normalizeAuthorId('slack', '\u0007u123abc')).toBe('U123ABC');
  });

  it('applies sanitizer to non-Slack connector stubs before trim-only normalization', () => {
    expect(normalizeAuthorId('teams', '\u202A user-1 \u200B')).toBe('user-1');
    expect(normalizeAuthorId('whatsapp', '\u2068+15551234567\u2069')).toBe('+15551234567');
    expect(normalizeAuthorId('email', '\u200Bperson@example.com\u202E')).toBe('person@example.com');
  });
});
