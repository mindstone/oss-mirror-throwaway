import { describe, it, expect } from 'vitest';
import { markdownToHtml } from '../exportUtils';

/**
 * TDD tests for markdownToHtml — the PDF export pipeline.
 *
 * These tests define the expected behavior for converting Markdown to HTML
 * using the unified/remark AST pipeline. Written before the implementation
 * to reproduce the bugs reported in FOX-2582 (progressive list indentation).
 *
 * Helper: parse HTML and assert structural correctness rather than
 * exact string matching, to avoid brittleness from whitespace/attribute order.
 */

function containsTag(html: string, tag: string): boolean {
  return new RegExp(`<${tag}[\\s>]`).test(html) || html.includes(`<${tag}>`);
}

function countOccurrences(html: string, tag: string): number {
  const openPattern = new RegExp(`<${tag}[\\s>]|<${tag}>`, 'g');
  return (html.match(openPattern) || []).length;
}

describe('markdownToHtml', () => {
  describe('unordered lists — the FOX-2582 bug', () => {
    it('renders a flat hyphen list with consistent indentation (no progressive drift)', async () => {
      const md = '- Item 1\n- Item 2\n- Item 3\n- Item 4\n- Item 5';
      const html = await markdownToHtml(md);

      expect(containsTag(html, 'ul')).toBe(true);
      expect(countOccurrences(html, 'li')).toBe(5);
      // Single <ul> wrapping all items — no nesting
      expect(countOccurrences(html, 'ul')).toBe(1);
    });

    it('renders hyphen list items as <li> inside <ul>, not <ol>', async () => {
      const md = '- Alpha\n- Beta\n- Gamma';
      const html = await markdownToHtml(md);

      expect(containsTag(html, 'ul')).toBe(true);
      expect(containsTag(html, 'ol')).toBe(false);
      expect(countOccurrences(html, 'li')).toBe(3);
    });

    it('renders asterisk unordered lists correctly', async () => {
      const md = '* One\n* Two\n* Three';
      const html = await markdownToHtml(md);

      expect(containsTag(html, 'ul')).toBe(true);
      expect(countOccurrences(html, 'li')).toBe(3);
      expect(countOccurrences(html, 'ul')).toBe(1);
    });

    it('renders plus-sign unordered lists correctly', async () => {
      const md = '+ One\n+ Two\n+ Three';
      const html = await markdownToHtml(md);

      expect(containsTag(html, 'ul')).toBe(true);
      expect(countOccurrences(html, 'li')).toBe(3);
      expect(countOccurrences(html, 'ul')).toBe(1);
    });
  });

  describe('ordered lists', () => {
    it('renders numbered lists with <ol> tags', async () => {
      const md = '1. First\n2. Second\n3. Third';
      const html = await markdownToHtml(md);

      expect(containsTag(html, 'ol')).toBe(true);
      expect(containsTag(html, 'ul')).toBe(false);
      expect(countOccurrences(html, 'li')).toBe(3);
    });

    it('renders a long ordered list without structural issues', async () => {
      const items = Array.from({ length: 10 }, (_, i) => `${i + 1}. Item ${i + 1}`);
      const md = items.join('\n');
      const html = await markdownToHtml(md);

      expect(containsTag(html, 'ol')).toBe(true);
      expect(countOccurrences(html, 'li')).toBe(10);
      expect(countOccurrences(html, 'ol')).toBe(1);
    });
  });

  describe('nested lists', () => {
    it('renders a 2-level nested unordered list', async () => {
      const md = '- Parent 1\n  - Child 1\n  - Child 2\n- Parent 2';
      const html = await markdownToHtml(md);

      expect(countOccurrences(html, 'ul')).toBe(2);
      // 4 items total: 2 parents + 2 children
      expect(countOccurrences(html, 'li')).toBe(4);
    });

    it('renders a 3-level deeply nested list', async () => {
      const md = '- Level 1\n  - Level 2\n    - Level 3';
      const html = await markdownToHtml(md);

      expect(countOccurrences(html, 'ul')).toBe(3);
      expect(countOccurrences(html, 'li')).toBe(3);
    });

    it('renders mixed nesting: unordered inside ordered', async () => {
      const md = '1. Ordered parent\n   - Unordered child 1\n   - Unordered child 2\n2. Ordered second';
      const html = await markdownToHtml(md);

      expect(containsTag(html, 'ol')).toBe(true);
      expect(containsTag(html, 'ul')).toBe(true);
    });

    it('renders mixed nesting: ordered inside unordered', async () => {
      const md = '- Unordered parent\n  1. Ordered child 1\n  2. Ordered child 2\n- Unordered second';
      const html = await markdownToHtml(md);

      expect(containsTag(html, 'ul')).toBe(true);
      expect(containsTag(html, 'ol')).toBe(true);
    });
  });

  describe('mixed content around lists', () => {
    it('renders lists surrounded by paragraphs correctly', async () => {
      const md = 'Intro paragraph\n\n- Item 1\n- Item 2\n\nClosing paragraph';
      const html = await markdownToHtml(md);

      expect(containsTag(html, 'p')).toBe(true);
      expect(containsTag(html, 'ul')).toBe(true);
      expect(countOccurrences(html, 'li')).toBe(2);
      expect(countOccurrences(html, 'p')).toBeGreaterThanOrEqual(2);
    });

    it('renders a list after a heading', async () => {
      const md = '# My Heading\n\n- Item A\n- Item B';
      const html = await markdownToHtml(md);

      expect(containsTag(html, 'h1')).toBe(true);
      expect(containsTag(html, 'ul')).toBe(true);
      expect(countOccurrences(html, 'li')).toBe(2);
    });

    it('does not confuse horizontal rules with list hyphens', async () => {
      const md = '- List item\n\n---\n\n- Another list';
      const html = await markdownToHtml(md);

      expect(containsTag(html, 'hr')).toBe(true);
      expect(countOccurrences(html, 'ul')).toBe(2);
    });
  });

  describe('edge cases', () => {
    it('renders a single-item unordered list', async () => {
      const md = '- Only item';
      const html = await markdownToHtml(md);

      expect(containsTag(html, 'ul')).toBe(true);
      expect(countOccurrences(html, 'li')).toBe(1);
    });

    it('renders a single-item ordered list', async () => {
      const md = '1. Only item';
      const html = await markdownToHtml(md);

      expect(containsTag(html, 'ol')).toBe(true);
      expect(countOccurrences(html, 'li')).toBe(1);
    });

    it('renders list items containing inline code', async () => {
      const md = '- Use `npm install`\n- Run `npm test`';
      const html = await markdownToHtml(md);

      expect(containsTag(html, 'ul')).toBe(true);
      expect(containsTag(html, 'code')).toBe(true);
      expect(countOccurrences(html, 'li')).toBe(2);
    });

    it('renders list items containing bold and italic', async () => {
      const md = '- **Bold item**\n- *Italic item*\n- Normal item';
      const html = await markdownToHtml(md);

      expect(containsTag(html, 'strong')).toBe(true);
      expect(containsTag(html, 'em')).toBe(true);
      expect(countOccurrences(html, 'li')).toBe(3);
    });

    it('renders list items containing links', async () => {
      const md = '- [Link text](https://example.com)\n- Plain item';
      const html = await markdownToHtml(md);

      expect(html).toContain('href="https://example.com"');
      expect(countOccurrences(html, 'li')).toBe(2);
    });

    it('does not pass through raw HTML script tags', async () => {
      const md = '- Safe item\n\n<script>alert("xss")</script>\n\n- Another item';
      const html = await markdownToHtml(md);

      expect(html).not.toContain('<script>');
    });

    it('handles empty markdown without throwing', async () => {
      const html = await markdownToHtml('');
      expect(html).toBe('');
    });

    it('handles whitespace-only markdown without throwing', async () => {
      const html = await markdownToHtml('   \n\n   ');
      expect(html).not.toContain('<li>');
    });

    it('wraps loose list items in <p> tags', async () => {
      const md = '- Item 1\n\n- Item 2\n\n- Item 3';
      const html = await markdownToHtml(md);

      expect(html).toMatch(/<li>\s*\n*<p>/);
      expect(countOccurrences(html, 'li')).toBe(3);
    });
  });

  describe('GFM features', () => {
    it('renders tables correctly', async () => {
      const md = '| Col A | Col B |\n|-------|-------|\n| 1     | 2     |';
      const html = await markdownToHtml(md);

      expect(containsTag(html, 'table')).toBe(true);
      expect(containsTag(html, 'th')).toBe(true);
      expect(containsTag(html, 'td')).toBe(true);
    });

    it('renders strikethrough text', async () => {
      const md = '~~deleted text~~';
      const html = await markdownToHtml(md);

      expect(containsTag(html, 'del')).toBe(true);
    });
  });
});
