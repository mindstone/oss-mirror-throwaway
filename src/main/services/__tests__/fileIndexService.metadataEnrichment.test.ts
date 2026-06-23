import { describe, it, expect, vi, beforeAll } from 'vitest';

vi.mock('@core/platform', () => ({
  getPlatformConfig: () => ({ isPackaged: false, userDataPath: '/tmp/test', version: '0.0.0' }),
}));
vi.mock('@core/lazyElectron', () => ({
  onElectronAppEvent: vi.fn(),
}));
vi.mock('./embeddingService', () => ({
  generateEmbedding: vi.fn(),
  generateEmbeddings: vi.fn(),
  generateQueryEmbedding: vi.fn(),
  getEmbeddingDimensions: vi.fn(() => 384),
}));
vi.mock('./sourceMetadataStore', () => ({
  isSourcePath: vi.fn(() => false),
  indexSource: vi.fn(),
}));
vi.mock('./entityMetadataStore', () => ({
  isEntityFile: vi.fn(() => false),
  indexEntity: vi.fn(),
  removeEntity: vi.fn(),
}));
vi.mock('../utils/systemUtils', () => ({
  tryConvertToWorkspacePath: vi.fn(() => null),
}));
vi.mock('../utils/emfileRetry', () => ({
  isTooManyOpenFilesError: vi.fn(() => false),
}));
vi.mock('../utils/enfileState', () => ({
  isEnfileActive: vi.fn(() => false),
  markEnfileDetected: vi.fn((_error?: unknown) => ({ isFirstDetection: false })),
}));

describe('fileIndexService metadata enrichment', () => {
  let extractDocumentTitle: (content: string) => string;
  let extractDocumentFrontmatter: (content: string) => { title: string; description: string; tags: string[] };
  let buildEmbeddingText: (title: string, relativePath: string, chunkContent: string, description?: string, tags?: string[]) => string;

  beforeAll(async () => {
    const mod = await import('../fileIndexService');
    extractDocumentTitle = mod.extractDocumentTitle;
    extractDocumentFrontmatter = mod.extractDocumentFrontmatter;
    buildEmbeddingText = mod.buildEmbeddingText;
  });

  describe('extractDocumentTitle', () => {
    it('extracts title from frontmatter', () => {
      const content = '---\ntitle: My Document\n---\nSome content here';
      expect(extractDocumentTitle(content)).toBe('My Document');
    });

    it('falls back to name when title is absent', () => {
      const content = '---\nname: Fallback Name\n---\nContent';
      expect(extractDocumentTitle(content)).toBe('Fallback Name');
    });

    it('prefers title over name', () => {
      const content = '---\ntitle: Primary\nname: Secondary\n---\nContent';
      expect(extractDocumentTitle(content)).toBe('Primary');
    });

    it('returns empty string for no frontmatter', () => {
      expect(extractDocumentTitle('Just plain text')).toBe('');
      expect(extractDocumentTitle('# Heading\nSome markdown')).toBe('');
    });

    it('returns empty string for empty content', () => {
      expect(extractDocumentTitle('')).toBe('');
    });

    it('returns empty string when title is null', () => {
      const content = '---\ntitle: null\n---\nContent';
      // YAML null parses to JS null, which is not a string
      expect(extractDocumentTitle(content)).toBe('');
    });

    it('returns empty string when title is a number', () => {
      const content = '---\ntitle: 123\n---\nContent';
      expect(extractDocumentTitle(content)).toBe('');
    });

    it('returns empty string when title is an array', () => {
      const content = '---\ntitle:\n  - item1\n  - item2\n---\nContent';
      expect(extractDocumentTitle(content)).toBe('');
    });

    it('returns empty string when title is a boolean', () => {
      const content = '---\ntitle: true\n---\nContent';
      expect(extractDocumentTitle(content)).toBe('');
    });

    it('truncates long titles to 200 chars', () => {
      const longTitle = 'A'.repeat(300);
      const content = `---\ntitle: "${longTitle}"\n---\nContent`;
      const result = extractDocumentTitle(content);
      expect(result.length).toBe(200);
    });

    it('trims whitespace from titles', () => {
      const content = '---\ntitle: "  Spaced Title  "\n---\nContent';
      expect(extractDocumentTitle(content)).toBe('Spaced Title');
    });

    it('handles malformed YAML gracefully', () => {
      const content = '---\ntitle: [unclosed\n---\nContent';
      expect(extractDocumentTitle(content)).toBe('');
    });

    it('handles frontmatter with no title or name', () => {
      const content = '---\nauthor: Someone\ndate: 2026-01-01\n---\nContent';
      expect(extractDocumentTitle(content)).toBe('');
    });

    it('handles binary-looking content', () => {
      const content = '\x00\x01\x02\x03\xFF\xFE';
      expect(extractDocumentTitle(content)).toBe('');
    });
  });

  describe('buildEmbeddingText', () => {
    it('prepends title and path to chunk content', () => {
      const result = buildEmbeddingText('My Doc', 'folder/file.md', 'chunk text');
      expect(result).toBe('Title: My Doc\nPath: folder/file.md\n\nchunk text');
    });

    it('omits title line when title is empty', () => {
      const result = buildEmbeddingText('', 'folder/file.md', 'chunk text');
      expect(result).toBe('Path: folder/file.md\n\nchunk text');
    });

    it('omits path line when path is empty', () => {
      const result = buildEmbeddingText('My Doc', '', 'chunk text');
      expect(result).toBe('Title: My Doc\n\nchunk text');
    });

    it('returns raw chunk when both title and path are empty', () => {
      const result = buildEmbeddingText('', '', 'chunk text');
      expect(result).toBe('chunk text');
    });

    it('keeps prefix short (under ~40 tokens for typical inputs)', () => {
      const result = buildEmbeddingText('Meeting Notes', 'work/meetings/2026-03-12.md', '');
      const prefix = result.split('\n\n')[0];
      // Rough token estimate: ~1 token per 4 chars for English
      const estimatedTokens = Math.ceil(prefix.length / 4);
      expect(estimatedTokens).toBeLessThan(40);
    });

    it('handles special characters in title and path', () => {
      const result = buildEmbeddingText(
        'Title with "quotes" & <brackets>',
        'path/with spaces/file (copy).md',
        'content'
      );
      expect(result).toContain('Title: Title with "quotes" & <brackets>');
      expect(result).toContain('Path: path/with spaces/file (copy).md');
      expect(result).toContain('content');
    });

    it('includes description when provided', () => {
      const result = buildEmbeddingText('Title', 'path/file.md', 'chunk', 'A description of the file');
      expect(result).toBe('Title: Title\nDescription: A description of the file\nPath: path/file.md\n\nchunk');
    });

    it('includes tags when provided', () => {
      const result = buildEmbeddingText('Title', 'path/file.md', 'chunk', undefined, ['tag1', 'tag2']);
      expect(result).toBe('Title: Title\nPath: path/file.md\nTags: tag1, tag2\n\nchunk');
    });

    it('includes both description and tags', () => {
      const result = buildEmbeddingText('Title', 'path/file.md', 'chunk', 'Desc', ['a', 'b']);
      expect(result).toContain('Description: Desc');
      expect(result).toContain('Tags: a, b');
    });

    it('omits description and tags when undefined', () => {
      const result = buildEmbeddingText('Title', 'path/file.md', 'chunk');
      expect(result).not.toContain('Description');
      expect(result).not.toContain('Tags');
    });

    it('omits description when empty string', () => {
      const result = buildEmbeddingText('Title', 'path/file.md', 'chunk', '');
      expect(result).not.toContain('Description');
    });

    it('omits tags when empty array', () => {
      const result = buildEmbeddingText('Title', 'path/file.md', 'chunk', undefined, []);
      expect(result).not.toContain('Tags');
    });
  });

  describe('extractDocumentFrontmatter', () => {
    it('extracts title, description, and tags', () => {
      const content = '---\ntitle: My Doc\ndescription: A test document\ntags:\n  - tag1\n  - tag2\n---\nContent';
      const result = extractDocumentFrontmatter(content);
      expect(result.title).toBe('My Doc');
      expect(result.description).toBe('A test document');
      expect(result.tags).toEqual(['tag1', 'tag2']);
    });

    it('returns empty defaults for no frontmatter', () => {
      const result = extractDocumentFrontmatter('Just plain text');
      expect(result.title).toBe('');
      expect(result.description).toBe('');
      expect(result.tags).toEqual([]);
    });

    it('handles missing description and tags', () => {
      const content = '---\ntitle: Only Title\n---\nContent';
      const result = extractDocumentFrontmatter(content);
      expect(result.title).toBe('Only Title');
      expect(result.description).toBe('');
      expect(result.tags).toEqual([]);
    });

    it('ignores non-string description values', () => {
      const content = '---\ndescription: 123\n---\nContent';
      expect(extractDocumentFrontmatter(content).description).toBe('');
    });

    it('ignores null description', () => {
      const content = '---\ndescription: null\n---\nContent';
      expect(extractDocumentFrontmatter(content).description).toBe('');
    });

    it('trims whitespace from description', () => {
      const content = '---\ndescription: "  spaced  "\n---\nContent';
      expect(extractDocumentFrontmatter(content).description).toBe('spaced');
    });

    it('ignores empty string description', () => {
      const content = '---\ndescription: ""\n---\nContent';
      expect(extractDocumentFrontmatter(content).description).toBe('');
    });

    it('filters non-string tags', () => {
      const content = '---\ntags:\n  - valid\n  - 123\n  - true\n---\nContent';
      expect(extractDocumentFrontmatter(content).tags).toEqual(['valid']);
    });

    it('caps tags at 10', () => {
      const tagLines = Array.from({ length: 15 }, (_, i) => `  - tag${i}`).join('\n');
      const content = `---\ntags:\n${tagLines}\n---\nContent`;
      expect(extractDocumentFrontmatter(content).tags).toHaveLength(10);
    });

    it('handles malformed YAML gracefully', () => {
      const content = '---\ntitle: [unclosed\n---\nContent';
      const result = extractDocumentFrontmatter(content);
      expect(result.title).toBe('');
      expect(result.description).toBe('');
      expect(result.tags).toEqual([]);
    });

    it('backward compat: extractDocumentTitle still works', () => {
      const content = '---\ntitle: Test\ndescription: Desc\n---\nContent';
      expect(extractDocumentTitle(content)).toBe('Test');
    });
  });
});
