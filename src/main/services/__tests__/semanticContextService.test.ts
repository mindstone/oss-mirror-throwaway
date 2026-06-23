/**
 * Unit tests for semantic context service pure functions.
 * 
 * Note: We can't directly import from semanticContextService due to transitive
 * dependencies on Electron (settingsStore). Instead, we test the logic inline
 * by duplicating the pure function implementations for testing purposes.
 * 
 * The actual implementation is in semanticContextService.ts - these tests
 * verify the algorithmic correctness of the keyword detection logic.
 */
import { describe, it, expect } from 'vitest';

// Duplicated from semanticContextService.ts for testing without Electron dependencies
const SEARCH_KEYWORDS = ['@files'] as const;

interface ParsedSearchKeywords {
  hasExplicitSearch: boolean;
  sanitizedPrompt: string;
  matchedKeyword?: string;
}

function parseSearchKeywords(prompt: string): ParsedSearchKeywords {
  const trimmedPrompt = prompt.trim();
  
  for (const keyword of SEARCH_KEYWORDS) {
    const pattern = new RegExp(
      `(^|\\s)(${keyword.replace('@', '@')})(?=$|[\\s,.:;!?\\n\\r])`,
      'i'
    );
    
    const match = trimmedPrompt.match(pattern);
    if (match) {
      const sanitizedPrompt = trimmedPrompt
        .replace(pattern, '$1')
        .trim()
        .replace(/^[,.:;!?\s]+/, '') // Strip leading punctuation
        .replace(/\s+/g, ' '); // Normalize multiple spaces
      
      return {
        hasExplicitSearch: true,
        sanitizedPrompt,
        matchedKeyword: keyword,
      };
    }
  }
  
  return {
    hasExplicitSearch: false,
    sanitizedPrompt: trimmedPrompt,
  };
}

// Duplicated threshold constants for testing
const RELEVANCE_THRESHOLDS = {
  default: 0.50,
  explicitSearch: 0.30,
  actionIntent: 0.35,
} as const;

// Duplicated from semanticContextService.ts for testing
const ACTION_VERBS = /^(update|edit|modify|change|fix|add|create|remove|delete|refactor|implement|build|write|move|rename|replace|improve|optimize)/i;

function detectActionIntent(query: string): boolean {
  const trimmed = query.trim();
  
  // Check if starts with action verb
  if (ACTION_VERBS.test(trimmed)) return true;
  
  // Check for imperative patterns like "can you update...", "please fix..."
  const imperativePattern = /^(can you|could you|please|help me|I need to|I want to)\s+(\w+)/i;
  const match = trimmed.match(imperativePattern);
  if (match && ACTION_VERBS.test(match[2])) return true;
  
  return false;
}

// --- Utility functions imported from semanticContextService.ts ---
// These are exported for testing and duplicated in preTurnWorker.ts.
import { extractQueryTerms, extractFocusedSnippet, extractMultipleSnippets } from '../semanticContextService';

// Duplicated formatContextForPrompt + helpers for testing without Electron dependencies.
// Keep in sync with semanticContextService.ts and preTurnWorker.ts.

const SNIPPET_FRAGMENT_LEN = 100;

interface SemanticSearchResult {
  path: string;
  relativePath: string;
  snippet: string;
  score: number;
  extension: string;
  chunkIndex?: number;
}

function generateRelevanceReason(
  relativePath: string,
  snippet: string,
  queryTerms: string[],
): string {
  if (queryTerms.length === 0) return '';
  const reasons: string[] = [];
  const lowerPath = relativePath.toLowerCase();
  const pathTerms = lowerPath.split(/[/\-_.]/).filter(t => t.length > 2);
  const pathMatches = queryTerms.filter(qt => pathTerms.some(pt => pt.includes(qt) || qt.includes(pt)));
  if (pathMatches.length > 0) {
    reasons.push(`path contains "${pathMatches.slice(0, 3).join('", "')}"`);
  }
  const lowerSnippet = snippet.toLowerCase();
  const snippetMatches = queryTerms
    .filter(qt => !pathMatches.includes(qt) && lowerSnippet.includes(qt))
    .slice(0, 4);
  if (snippetMatches.length > 0) {
    reasons.push(`content mentions "${snippetMatches.join('", "')}"`);
  }
  return reasons.length > 0 ? reasons.join('; ') : '';
}

function formatContextForPrompt(results: SemanticSearchResult[], hints?: SemanticSearchResult[], userQuery?: string): string {
  if (results.length === 0 && (!hints || hints.length === 0)) {
    return '';
  }

  const queryTerms = userQuery ? extractQueryTerms(userQuery) : [];

  const sections = results.map((result, index) => {
    const snippets = extractMultipleSnippets(result.snippet, queryTerms);

    const reason = generateRelevanceReason(result.relativePath, result.snippet, queryTerms);
    const reasonLine = reason ? `**Why:** ${reason}\n` : '';

    const isPartial = result.snippet.length > SNIPPET_FRAGMENT_LEN * 2;
    const previewLabel = snippets.length > 1
      ? `**Snippets** (${snippets.length} excerpts from a longer file):`
      : (isPartial ? '**Preview** (short excerpt):' : '**Preview:**');

    const quotedSnippets = snippets
      .map(s => `> ${s.replace(/\n/g, '\n> ')}`)
      .join('\n>\n');

    return `### [${index + 1}] ${result.relativePath} (${(result.score * 100).toFixed(0)}% match)\n${reasonLine}${previewLabel}\n${quotedSnippets}\n\u2192 **Read this file** for full content`;
  });

  let hintSection = '';
  if (hints && hints.length > 0) {
    const hintLines = hints.map(h => `- \`${h.relativePath}\``);
    hintSection = `\n\n**Other possibly relevant files** (use Read tool if needed):\n${hintLines.join('\n')}`;
  }

  const preamble = `The following files from your Library may be relevant to this request. These are short previews — **Read the full files** before using their content in your response.
When referencing information, cite the source (e.g., "According to [1]..." or "see [2]").
If a file comes from a shared team space (e.g., under work/), mention the space or team context when referencing it.`;

  return `${preamble}\n\n${sections.join('\n\n')}${hintSection}`;
}

// --- extractQueryTerms tests ---

describe('extractQueryTerms', () => {
  it('extracts meaningful terms and removes stopwords', () => {
    const terms = extractQueryTerms('Draft a follow-up email about the Meridian deal');
    expect(terms).toContain('draft');
    expect(terms).toContain('follow-up');
    expect(terms).toContain('email');
    expect(terms).toContain('meridian');
    expect(terms).toContain('deal');
    expect(terms).not.toContain('the');
    expect(terms).not.toContain('a');
  });

  it('removes short terms (<=2 chars)', () => {
    const terms = extractQueryTerms('go to the UI');
    expect(terms).not.toContain('go');
    expect(terms).not.toContain('to');
  });

  it('handles empty query', () => {
    expect(extractQueryTerms('')).toEqual([]);
  });

  it('handles query with only stopwords', () => {
    expect(extractQueryTerms('the and or but')).toEqual([]);
  });
});

// --- extractFocusedSnippet tests ---

describe('extractFocusedSnippet', () => {
  it('returns full chunk when shorter than maxLen', () => {
    const chunk = 'Short chunk content';
    const { text, charOffset } = extractFocusedSnippet(chunk, ['short']);
    expect(text).toBe(chunk);
    expect(charOffset).toBe(0);
  });

  it('finds best window around query terms', () => {
    const chunk = 'A'.repeat(500) + ' SSO requirement for HIPAA compliance ' + 'B'.repeat(500);
    const { text } = extractFocusedSnippet(chunk, ['sso', 'hipaa'], 100);
    expect(text).toContain('SSO');
    expect(text).toContain('HIPAA');
  });

  it('falls back to chunk start when no term overlap', () => {
    const chunk = 'The beginning of a long chunk about unrelated topics. ' + 'x'.repeat(500);
    const { text, charOffset } = extractFocusedSnippet(chunk, ['nonexistent'], 100);
    expect(charOffset).toBe(0);
    expect(text.length).toBeLessThanOrEqual(100);
  });

  it('handles empty queryTerms', () => {
    const chunk = 'Some content here. ' + 'x'.repeat(500);
    const result = extractFocusedSnippet(chunk, [], 100);
    expect(result.charOffset).toBe(0);
  });
});

// --- extractMultipleSnippets tests ---

describe('extractMultipleSnippets', () => {
  it('returns full content for short text', () => {
    const snippets = extractMultipleSnippets('Short content', ['short']);
    expect(snippets).toHaveLength(1);
    expect(snippets[0]).toBe('Short content');
  });

  it('returns multiple fragments for long content with query terms', () => {
    const content = 'The SSO requirement is critical. ' + 'x'.repeat(300) +
      ' HIPAA compliance needs review. ' + 'x'.repeat(300) +
      ' Lisa Park confirmed the timeline.';
    const snippets = extractMultipleSnippets(content, ['sso', 'hipaa', 'lisa']);
    expect(snippets.length).toBeGreaterThan(1);
    expect(snippets.length).toBeLessThanOrEqual(3);
  });

  it('returns fragments from chunk starts when no term overlap', () => {
    const content = 'First section about unrelated topics. ' + 'x'.repeat(300) +
      ' Second section about different things.';
    const snippets = extractMultipleSnippets(content, ['nonexistent']);
    expect(snippets.length).toBeGreaterThanOrEqual(1);
  });

  it('handles multi-chunk content', () => {
    const content = 'Chunk one about sales.\n\n[...]\n\nChunk two about pricing.';
    const snippets = extractMultipleSnippets(content, ['sales', 'pricing']);
    expect(snippets.length).toBeGreaterThanOrEqual(1);
  });

  it('returns fragments in document order', () => {
    const content = 'AAA first section. ' + 'x'.repeat(300) + ' BBB second section. ' + 'x'.repeat(300) + ' CCC third section.';
    const snippets = extractMultipleSnippets(content, ['aaa', 'bbb', 'ccc']);
    if (snippets.length >= 2) {
      // Each fragment should contain its respective term in order
      const firstWithA = snippets.findIndex(s => s.toLowerCase().includes('aaa'));
      const firstWithB = snippets.findIndex(s => s.toLowerCase().includes('bbb'));
      if (firstWithA !== -1 && firstWithB !== -1) {
        expect(firstWithA).toBeLessThan(firstWithB);
      }
    }
  });
});

// --- generateRelevanceReason tests ---

describe('generateRelevanceReason', () => {
  it('detects path/filename overlap with query', () => {
    const reason = generateRelevanceReason(
      'Chief-of-Staff/memory/topics/companies/Meridian-Health.md',
      'Some content about the company',
      ['meridian', 'health'],
    );
    expect(reason).toContain('path contains');
    expect(reason).toContain('meridian');
  });

  it('detects snippet term overlap beyond path matches', () => {
    const reason = generateRelevanceReason(
      'some/generic/path.md',
      'Meeting with Lisa about SSO and HIPAA compliance requirements',
      ['lisa', 'sso', 'hipaa'],
    );
    expect(reason).toContain('content mentions');
    expect(reason).toContain('lisa');
  });

  it('returns empty string for empty queryTerms', () => {
    expect(generateRelevanceReason('path.md', 'content', [])).toBe('');
  });

  it('combines path and content matches', () => {
    const reason = generateRelevanceReason(
      'sales/meridian-deal.md',
      'Discussed pricing and SSO requirements',
      ['meridian', 'pricing', 'sso'],
    );
    expect(reason).toContain('path contains');
    expect(reason).toContain('content mentions');
  });
});

// --- formatContextForPrompt tests ---

describe('formatContextForPrompt', () => {
  const makeResult = (overrides: Partial<SemanticSearchResult> = {}): SemanticSearchResult => ({
    path: '/workspace/src/config.ts',
    relativePath: 'src/config.ts',
    snippet: 'const config = { port: 3000 };',
    score: 0.75,
    extension: '.ts',
    chunkIndex: 0,
    ...overrides,
  });

  it('returns empty string for empty results and no hints', () => {
    expect(formatContextForPrompt([])).toBe('');
    expect(formatContextForPrompt([], [])).toBe('');
  });

  it('includes preamble with Read instruction', () => {
    const result = formatContextForPrompt([makeResult()]);
    expect(result).toContain('Read the full files');
    expect(result).toContain('cite the source');
  });

  it('shows focused preview with Read CTA', () => {
    const result = formatContextForPrompt([makeResult()]);
    expect(result).toContain('Read this file');
    expect(result).toContain('75% match');
  });

  it('shows "Snippets" label for long content with multiple fragments', () => {
    const snippet = 'The SSO requirement is critical. ' + 'x'.repeat(300) +
      ' HIPAA compliance needs review. ' + 'x'.repeat(300) +
      ' Lisa Park confirmed the timeline.';
    const result = formatContextForPrompt(
      [makeResult({ snippet })],
      undefined,
      'SSO HIPAA Lisa',
    );
    expect(result).toContain('**Snippets**');
    expect(result).toContain('excerpts from a longer file');
  });

  it('shows "Preview:" label for short snippets', () => {
    const result = formatContextForPrompt([makeResult({ snippet: 'short' })]);
    expect(result).toContain('**Preview:**');
    expect(result).not.toContain('Snippets');
  });

  it('includes "Why" line when query terms match', () => {
    const result = formatContextForPrompt(
      [makeResult({ relativePath: 'meridian/health.md', snippet: 'SSO requirements for the deal' })],
      undefined,
      'Meridian SSO deal',
    );
    expect(result).toContain('**Why:**');
    expect(result).toContain('meridian');
  });

  it('renders hints as filename-only list', () => {
    const hints = [
      makeResult({ relativePath: 'src/utils.ts' }),
      makeResult({ relativePath: 'src/helpers.ts' }),
    ];
    const result = formatContextForPrompt([], hints);
    expect(result).toContain('Other possibly relevant files');
    expect(result).toContain('`src/utils.ts`');
  });

  it('handles multi-chunk content gracefully', () => {
    const multiChunkSnippet = 'First chunk about sales strategy.\n\n[...]\n\nSecond chunk about pricing model.';
    const result = formatContextForPrompt(
      [makeResult({ snippet: multiChunkSnippet })],
      undefined,
      'sales pricing',
    );
    expect(result).toContain('Read this file');
  });

  it('uses blockquote format for preview', () => {
    const result = formatContextForPrompt([makeResult()]);
    expect(result).toContain('> const config');
  });
});

describe('parseSearchKeywords', () => {
  describe('valid keyword detection', () => {
    it('detects @files at start of message', () => {
      const result = parseSearchKeywords('@files find the config file');
      expect(result.hasExplicitSearch).toBe(true);
      expect(result.matchedKeyword).toBe('@files');
      expect(result.sanitizedPrompt).toBe('find the config file');
    });

    it('detects keyword mid-sentence with whitespace boundary', () => {
      const result = parseSearchKeywords('please @files for the config');
      expect(result.hasExplicitSearch).toBe(true);
      expect(result.matchedKeyword).toBe('@files');
      expect(result.sanitizedPrompt).toBe('please for the config');
    });

    it('detects keyword with trailing comma', () => {
      const result = parseSearchKeywords('@files, what about the roadmap?');
      expect(result.hasExplicitSearch).toBe(true);
      expect(result.sanitizedPrompt).toBe('what about the roadmap?');
    });

    it('detects keyword with trailing period', () => {
      const result = parseSearchKeywords('Search @files. Find pricing.');
      expect(result.hasExplicitSearch).toBe(true);
    });

    it('is case-insensitive', () => {
      expect(parseSearchKeywords('@FILES find stuff').hasExplicitSearch).toBe(true);
      expect(parseSearchKeywords('@Files search').hasExplicitSearch).toBe(true);
    });

    it('detects keyword with newline after it', () => {
      const result = parseSearchKeywords('@files\nFind the document');
      expect(result.hasExplicitSearch).toBe(true);
    });
  });

  describe('false positive prevention', () => {
    it('does not match @files-extended', () => {
      const result = parseSearchKeywords('use @files-extended mode');
      expect(result.hasExplicitSearch).toBe(false);
    });

    it('does not match @fileable', () => {
      const result = parseSearchKeywords('check the @fileable folder');
      expect(result.hasExplicitSearch).toBe(false);
    });

    it('does not match old keywords like @semantic-search', () => {
      const result = parseSearchKeywords('@semantic-search find the config');
      expect(result.hasExplicitSearch).toBe(false);
    });

    it('does not match old keywords like @all', () => {
      const result = parseSearchKeywords('@all search everything');
      expect(result.hasExplicitSearch).toBe(false);
    });

    it('does not match old keywords like @workspace', () => {
      const result = parseSearchKeywords('@workspace look for Q4');
      expect(result.hasExplicitSearch).toBe(false);
    });
  });

  describe('sanitized prompt', () => {
    it('normalizes multiple spaces after keyword removal', () => {
      const result = parseSearchKeywords('@files   find   the   file');
      expect(result.sanitizedPrompt).toBe('find the file');
    });

    it('trims whitespace', () => {
      const result = parseSearchKeywords('  @files find stuff  ');
      expect(result.sanitizedPrompt).toBe('find stuff');
    });

    it('handles keyword-only message', () => {
      const result = parseSearchKeywords('@files');
      expect(result.hasExplicitSearch).toBe(true);
      expect(result.sanitizedPrompt).toBe('');
    });
  });

  describe('no keyword', () => {
    it('returns original prompt when no keyword present', () => {
      const result = parseSearchKeywords('just a normal question');
      expect(result.hasExplicitSearch).toBe(false);
      expect(result.sanitizedPrompt).toBe('just a normal question');
    });

    it('handles empty string', () => {
      const result = parseSearchKeywords('');
      expect(result.hasExplicitSearch).toBe(false);
      expect(result.sanitizedPrompt).toBe('');
    });
  });
});

describe('RELEVANCE_THRESHOLDS', () => {
  it('exports threshold constants', () => {
    expect(RELEVANCE_THRESHOLDS.default).toBe(0.50);
    expect(RELEVANCE_THRESHOLDS.explicitSearch).toBe(0.30);
    expect(RELEVANCE_THRESHOLDS.actionIntent).toBe(0.35);
  });

  it('has explicitSearch lower than default for wider net', () => {
    expect(RELEVANCE_THRESHOLDS.explicitSearch).toBeLessThan(RELEVANCE_THRESHOLDS.default);
  });

  it('has actionIntent lower than default for action queries', () => {
    expect(RELEVANCE_THRESHOLDS.actionIntent).toBeLessThan(RELEVANCE_THRESHOLDS.default);
  });
});

describe('detectActionIntent', () => {
  describe('direct action verbs', () => {
    it('detects update at start', () => {
      expect(detectActionIntent('update the pricing page')).toBe(true);
    });

    it('detects fix at start', () => {
      expect(detectActionIntent('fix the bug in the login form')).toBe(true);
    });

    it('detects create at start', () => {
      expect(detectActionIntent('create a new component for the dashboard')).toBe(true);
    });

    it('detects refactor at start', () => {
      expect(detectActionIntent('refactor the authentication service')).toBe(true);
    });

    it('detects implement at start', () => {
      expect(detectActionIntent('implement dark mode toggle')).toBe(true);
    });

    it('is case-insensitive', () => {
      expect(detectActionIntent('UPDATE the config')).toBe(true);
      expect(detectActionIntent('Fix the issue')).toBe(true);
    });
  });

  describe('imperative patterns', () => {
    it('detects "can you update"', () => {
      expect(detectActionIntent('can you update the settings page?')).toBe(true);
    });

    it('detects "could you fix"', () => {
      expect(detectActionIntent('could you fix this error?')).toBe(true);
    });

    it('detects "please create"', () => {
      expect(detectActionIntent('please create a new test file')).toBe(true);
    });

    it('detects "help me implement"', () => {
      expect(detectActionIntent('help me implement caching')).toBe(true);
    });

    it('detects "I need to add"', () => {
      expect(detectActionIntent('I need to add validation')).toBe(true);
    });

    it('detects "I want to remove"', () => {
      expect(detectActionIntent('I want to remove this feature')).toBe(true);
    });
  });

  describe('non-action queries (should return false)', () => {
    it('does not match information queries', () => {
      expect(detectActionIntent('what is the pricing page?')).toBe(false);
    });

    it('does not match "where" questions', () => {
      expect(detectActionIntent('where is the config file?')).toBe(false);
    });

    it('does not match "how" questions', () => {
      expect(detectActionIntent('how does the auth system work?')).toBe(false);
    });

    it('does not match action verbs mid-sentence', () => {
      expect(detectActionIntent('I was thinking about how to update this')).toBe(false);
    });

    it('does not match "can you explain"', () => {
      expect(detectActionIntent('can you explain the architecture?')).toBe(false);
    });

    it('does not match "please tell me"', () => {
      expect(detectActionIntent('please tell me about the codebase')).toBe(false);
    });

    it('handles empty string', () => {
      expect(detectActionIntent('')).toBe(false);
    });

    it('handles whitespace-only string', () => {
      expect(detectActionIntent('   ')).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('handles leading whitespace', () => {
      expect(detectActionIntent('  update the pricing')).toBe(true);
    });

    it('handles trailing whitespace', () => {
      expect(detectActionIntent('update the pricing  ')).toBe(true);
    });
  });
});
