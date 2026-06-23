import { describe, it, expect } from 'vitest';
import { parseForagerResult } from '../foragerTypes';

const baseCard = {
  sourceId: 'email:thread_42',
  sourceType: 'email' as const,
  relevanceScore: 0.85,
  quote: 'Henderson proposal pricing moved to Q3.',
  context: 'Email from pricing review thread.',
  metadata: {
    author: 'Alex',
    date: '2026-04-01',
  },
};

const validResult = {
  cards: [baseCard],
  sourcesScanned: 5,
  searchTermsUsed: ['henderson proposal'],
};

describe('parseForagerResult', () => {
  it('returns success data for valid JSON', () => {
    const result = parseForagerResult(JSON.stringify(validResult));

    expect(result).toEqual({ success: true, data: validResult });
  });

  it('strips ```json fences and parses valid JSON', () => {
    const fenced = `\`\`\`json
${JSON.stringify(validResult)}
\`\`\``;

    const result = parseForagerResult(fenced);

    expect(result).toEqual({ success: true, data: validResult });
  });

  it('strips plain ``` fences and parses valid JSON', () => {
    const fenced = `\`\`\`
${JSON.stringify(validResult)}
\`\`\``;

    const result = parseForagerResult(fenced);

    expect(result).toEqual({ success: true, data: validResult });
  });

  it('extracts JSON embedded in surrounding prose and parses', () => {
    const embedded = `Scanned your sources. Here is the result:
\`\`\`json
${JSON.stringify(validResult)}
\`\`\`
Done.`;

    const result = parseForagerResult(embedded);

    expect(result).toEqual({ success: true, data: validResult });
  });

  it('returns failure for invalid JSON', () => {
    const result = parseForagerResult('{"cards":[}');

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.length).toBeGreaterThan(0);
    }
  });

  it('returns failure with zod details when schema validation fails', () => {
    const missingRequiredField = {
      cards: [
        {
          sourceId: 'email:thread_42',
          sourceType: 'email',
          relevanceScore: 0.85,
          context: 'Missing quote should fail schema validation.',
        },
      ],
      sourcesScanned: 1,
      searchTermsUsed: ['henderson'],
    };

    const result = parseForagerResult(JSON.stringify(missingRequiredField));

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('cards.0.quote');
    }
  });

  it('returns success with an empty cards array', () => {
    const emptyCards = {
      cards: [],
      sourcesScanned: 0,
      searchTermsUsed: [],
    };

    const result = parseForagerResult(JSON.stringify(emptyCards));

    expect(result).toEqual({ success: true, data: emptyCards });
  });

  it('returns failure for an empty string', () => {
    const result = parseForagerResult('');

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.length).toBeGreaterThan(0);
    }
  });

  it('fails validation when relevanceScore is out of range', () => {
    const invalidRelevance = {
      ...validResult,
      cards: [{ ...baseCard, relevanceScore: 1.5 }],
    };

    const result = parseForagerResult(JSON.stringify(invalidRelevance));

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('cards.0.relevanceScore');
    }
  });

  it('fails validation when sourcesScanned is negative', () => {
    const negativeSources = {
      ...validResult,
      sourcesScanned: -1,
    };

    const result = parseForagerResult(JSON.stringify(negativeSources));

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('sourcesScanned');
    }
  });

  it('fails validation when sourcesScanned is fractional', () => {
    const fractionalSources = {
      ...validResult,
      sourcesScanned: 2.5,
    };

    const result = parseForagerResult(JSON.stringify(fractionalSources));

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('sourcesScanned');
    }
  });
});
