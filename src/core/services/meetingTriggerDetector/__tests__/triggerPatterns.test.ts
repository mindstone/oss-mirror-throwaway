import { describe, it, expect } from 'vitest';

import {
  escapeRegex,
  levenshteinDistance,
  getFuzzyThreshold,
  getTriggerPatterns,
  matchesTrigger,
  getStopTriggerPatterns,
  matchesStopTrigger,
  getDiscardTriggerPatterns,
  matchesDiscardTrigger,
  fuzzyMatchTrigger,
  fuzzyMatchStopTrigger,
} from '../triggerPatterns';

describe('escapeRegex', () => {
  it.each([
    ['?', '\\?'],
    ['*', '\\*'],
    ['[', '\\['],
    [']', '\\]'],
    ['(', '\\('],
    [')', '\\)'],
    ['+', '\\+'],
    ['^', '\\^'],
    ['$', '\\$'],
    ['.', '\\.'],
    ['{', '\\{'],
    ['}', '\\}'],
    ['|', '\\|'],
    ['\\', '\\\\'],
  ])('escapes %s', (input, expected) => {
    expect(escapeRegex(input)).toBe(expected);
  });

  it('escapes multiple specials in one phrase', () => {
    expect(escapeRegex('what?*[stuff]')).toBe('what\\?\\*\\[stuff\\]');
  });

  it('leaves regular text untouched', () => {
    expect(escapeRegex('Spark')).toBe('Spark');
  });
});

describe('levenshteinDistance', () => {
  it('returns 0 for identical strings', () => {
    expect(levenshteinDistance('spark', 'spark')).toBe(0);
  });

  it('returns 1 for single substitution', () => {
    expect(levenshteinDistance('spark', 'sparc')).toBe(1);
    expect(levenshteinDistance('spark', 'mark')).toBe(2);
  });

  it('handles empty strings', () => {
    expect(levenshteinDistance('', 'spark')).toBe(5);
    expect(levenshteinDistance('spark', '')).toBe(5);
  });
});

describe('getFuzzyThreshold', () => {
  it('returns tight threshold for short trigger words', () => {
    expect(getFuzzyThreshold('bot')).toBe(1);
    expect(getFuzzyThreshold('spar')).toBe(1);
  });

  it('returns medium threshold for medium-length triggers', () => {
    expect(getFuzzyThreshold('spark')).toBe(2);
    expect(getFuzzyThreshold('rebel1')).toBe(2);
  });

  it('returns loose threshold for long triggers', () => {
    expect(getFuzzyThreshold('sparkling')).toBe(3);
  });
});

describe('getTriggerPatterns / matchesTrigger', () => {
  it('matches "Hey Spark" with custom phrase', () => {
    expect(matchesTrigger('Hey Spark, summarise', 'Alice', 'Spark')).toBe(true);
  });

  it('matches "Hi Spark" with custom phrase', () => {
    expect(matchesTrigger('Hi Spark, what?', 'Alice', 'Spark')).toBe(true);
  });

  it('requires greeting prefix - does not match bare "Spark"', () => {
    expect(matchesTrigger('So, Spark is actually fast', 'Alice', 'Spark')).toBe(false);
  });

  it('matches "Hey Alice\'s Rebel" against default trigger', () => {
    expect(matchesTrigger("Hey Alice's Rebel, summarise", 'Alice Smith', null)).toBe(true);
  });

  it('does not match wrong owner against default trigger', () => {
    expect(matchesTrigger("Hey Bob's Rebel, summarise", 'Alice', null)).toBe(false);
  });

  it('regex-escape invariant: trigger phrases with ? do not blow up regex compilation', () => {
    expect(() => getTriggerPatterns('Alice', 'Spark?')).not.toThrow();
    expect(matchesTrigger('Hey Spark?, do thing', 'Alice', 'Spark?')).toBe(true);
  });

  it('regex-escape invariant: trigger phrases with [ and ] do not throw at compile-time', () => {
    // Note: a trailing `]` is a non-word character, so the regex's trailing `\b`
    // assertion can't satisfy the word/non-word boundary requirement. The exact
    // match falls through to the fuzzy path. The invariant we guard here is
    // "regex construction does not throw"; matching behaviour for bracket-ending
    // triggers is intentionally out of scope.
    expect(() => getTriggerPatterns('Alice', 'My[Bot]')).not.toThrow();
  });

  it('regex-escape invariant: trigger phrases with backslash', () => {
    expect(() => getTriggerPatterns('Alice', 'A\\B')).not.toThrow();
    expect(matchesTrigger('Hey A\\B, hi', 'Alice', 'A\\B')).toBe(true);
  });

  it('regex-escape invariant: trigger phrases with * and +', () => {
    expect(() => getTriggerPatterns('Alice', 'Spark*+')).not.toThrow();
    expect(matchesTrigger('Hey Spark*+, please', 'Alice', 'Spark*+')).toBe(true);
  });

  it('regex-escape invariant: trigger phrases with .', () => {
    // The dot must be escaped in the exact pattern. Note that the fuzzy
    // fallback may still match transcripts where the dot was elided
    // (e.g. "SparkXAI" vs "Spark.AI" — distance 1, within threshold 3),
    // but the exact-match path must compile cleanly and match the literal.
    expect(() => getTriggerPatterns('Alice', 'Spark.AI')).not.toThrow();
    expect(matchesTrigger('Hey Spark.AI, hi', 'Alice', 'Spark.AI')).toBe(true);
    const exactPatterns = getTriggerPatterns('Alice', 'Spark.AI');
    expect(exactPatterns.some(p => p.test('Hey SparkXAI, hi'))).toBe(false);
  });
});

describe('fuzzyMatchTrigger', () => {
  it('matches "Hey Mark" against "Spark" (1-letter substitution)', () => {
    expect(fuzzyMatchTrigger('Hey Mark, what?', 'Spark')).toBe('mark');
  });

  it('matches garbled-greeting "A spark go ahead"', () => {
    expect(fuzzyMatchTrigger('A spark go ahead, sure.', 'Spark')).toBe('spark');
  });

  it('does not match phrases too far from trigger', () => {
    expect(fuzzyMatchTrigger('Hey Tribunal, what?', 'Spark')).toBe(null);
  });

  it('returns null when triggerPhrase is null (default trigger)', () => {
    expect(fuzzyMatchTrigger('Hey Mark, what?', null)).toBe(null);
  });
});

describe('matchesStopTrigger', () => {
  it('matches "Stop Spark"', () => {
    expect(matchesStopTrigger('Stop Spark', 'Alice', 'Spark')).toBe(true);
  });

  it('matches "Spark, stop" (reverse order, Bug 7 fix)', () => {
    expect(matchesStopTrigger('Spark, stop.', 'Alice', 'Spark')).toBe(true);
  });

  it('matches "Cancel Spark"', () => {
    expect(matchesStopTrigger('Cancel Spark', 'Alice', 'Spark')).toBe(true);
  });

  it('does not match plain "stop"', () => {
    expect(matchesStopTrigger('Just stop please', 'Alice', 'Spark')).toBe(false);
  });

  it('fuzzy stop: "Stop Mark" with trigger "Spark"', () => {
    expect(fuzzyMatchStopTrigger('Stop Mark.', 'Spark')).toBe(true);
  });

  it('matches "Alice\'s Rebel, stop" against default trigger', () => {
    expect(matchesStopTrigger("Alice's Rebel, stop.", 'Alice', null)).toBe(true);
  });
});

describe('matchesDiscardTrigger', () => {
  it('matches "Spark, never mind"', () => {
    expect(matchesDiscardTrigger('Spark, never mind.', 'Alice', 'Spark')).toBe(true);
  });

  it('matches "Hey Spark, discard"', () => {
    expect(matchesDiscardTrigger('Hey Spark, discard that', 'Alice', 'Spark')).toBe(true);
  });

  it('matches "Never mind Spark"', () => {
    expect(matchesDiscardTrigger('Never mind Spark', 'Alice', 'Spark')).toBe(true);
  });

  it('matches "Alice\'s Rebel, never mind" against default trigger', () => {
    expect(matchesDiscardTrigger("Alice's Rebel, never mind.", 'Alice', null)).toBe(true);
  });

  it('does NOT include "cancel" (reserved for stop trigger)', () => {
    expect(matchesDiscardTrigger('Cancel Spark', 'Alice', 'Spark')).toBe(false);
  });
});

describe('getDiscardTriggerPatterns', () => {
  it('respects escaped trigger phrase', () => {
    expect(() => getDiscardTriggerPatterns('Alice', 'Spark?*')).not.toThrow();
    expect(matchesDiscardTrigger('Spark?*, never mind', 'Alice', 'Spark?*')).toBe(true);
  });
});

describe('getStopTriggerPatterns', () => {
  it('respects escaped trigger phrase', () => {
    expect(() => getStopTriggerPatterns('Alice', 'Spark.AI')).not.toThrow();
    expect(matchesStopTrigger('Stop Spark.AI', 'Alice', 'Spark.AI')).toBe(true);
  });
});
