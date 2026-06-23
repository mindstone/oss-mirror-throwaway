import { describe, expect, it } from 'vitest';
import { matchesPlainText, normalizeSearchQuery } from '../matchesPlainText';

describe('normalizeSearchQuery', () => {
  it('trims and lowercases input', () => {
    expect(normalizeSearchQuery('  ChatGPT  ')).toBe('chatgpt');
  });
});

describe('matchesPlainText', () => {
  it('matches case-insensitively', () => {
    const query = normalizeSearchQuery('CHATGPT');
    expect(matchesPlainText('notes/chatgpt.png', query)).toBe(true);
  });

  it('treats empty query as match-all', () => {
    expect(matchesPlainText('anything', normalizeSearchQuery('   '))).toBe(true);
    expect(matchesPlainText(undefined, normalizeSearchQuery(''))).toBe(true);
  });

  it('returns false for empty haystack when query is non-empty', () => {
    expect(matchesPlainText('', normalizeSearchQuery('chatgpt'))).toBe(false);
  });

  it('does not throw for undefined haystack', () => {
    const query = normalizeSearchQuery('chatgpt');
    expect(() => matchesPlainText(undefined, query)).not.toThrow();
    expect(matchesPlainText(undefined, query)).toBe(false);
  });

  it('does not throw for null haystack', () => {
    const query = normalizeSearchQuery('chatgpt');
    expect(() => matchesPlainText(null, query)).not.toThrow();
    expect(matchesPlainText(null, query)).toBe(false);
  });

  it('handles unicode haystacks', () => {
    const query = normalizeSearchQuery('café');
    expect(matchesPlainText('CAFÉ-notes.md', query)).toBe(true);
  });
});
