import { describe, expect, it } from 'vitest';
import { enrichToolSearchQuery, extractUrls, getDomainSearchHint, sanitizeUrlsForEmbedding } from '../urlDetectionService';

describe('urlDetectionService', () => {
  describe('extractUrls', () => {
    it('returns empty array when no URLs are present', () => {
      expect(extractUrls('No links here, just text.')).toEqual([]);
    });

    it('extracts a single HTTPS URL', () => {
      const urls = extractUrls('Please check https://example.com/doc for details.');
      expect(urls).toHaveLength(1);
      expect(urls[0]).toMatchObject({
        url: 'https://example.com/doc',
        domain: 'example.com',
        fullMatch: 'https://example.com/doc',
      });
    });

    it('extracts multiple HTTP/HTTPS URLs', () => {
      const urls = extractUrls('See http://one.example.com and https://two.example.com/path');
      expect(urls).toHaveLength(2);
      expect(urls.map((url) => url.url)).toEqual([
        'http://one.example.com',
        'https://two.example.com/path',
      ]);
      expect(urls.map((url) => url.domain)).toEqual(['one.example.com', 'two.example.com']);
    });

    it('extracts URL from markdown links', () => {
      const urls = extractUrls(
        'Read [Project Doc](https://docs.google.com/document/d/abc123/edit) before the meeting.'
      );
      expect(urls).toHaveLength(1);
      expect(urls[0]).toMatchObject({
        url: 'https://docs.google.com/document/d/abc123/edit',
        domain: 'docs.google.com',
      });
      expect(urls[0]?.fullMatch).toBe(
        '[Project Doc](https://docs.google.com/document/d/abc123/edit)'
      );
    });

    it('preserves query params and fragments', () => {
      const urls = extractUrls('Use https://example.com/path?foo=bar#section-2 for context.');
      expect(urls).toHaveLength(1);
      expect(urls[0]?.url).toBe('https://example.com/path?foo=bar#section-2');
    });

    it('extracts file:// URLs for local files', () => {
      const urls = extractUrls('Open file:///Users/you/Documents/notes.txt and summarize it.');
      expect(urls).toHaveLength(1);
      expect(urls[0]).toMatchObject({
        url: 'file:///Users/you/Documents/notes.txt',
        domain: 'file',
      });
    });

    it('ignores malformed URLs', () => {
      const urls = extractUrls('Bad links: https:// and http:// and https://)');
      expect(urls).toEqual([]);
    });

    it('ignores mailto/tel/javascript schemes', () => {
      const urls = extractUrls(
        'Contact me at mailto:test@example.com, call tel:+15551234567, or javascript:alert(1).'
      );
      expect(urls).toEqual([]);
    });

    it('deduplicates identical URLs', () => {
      const urls = extractUrls(
        'https://example.com/repeat and again https://example.com/repeat and [same](https://example.com/repeat)'
      );
      expect(urls).toHaveLength(1);
      expect(urls[0]?.url).toBe('https://example.com/repeat');
    });

    it('trims trailing punctuation around URLs', () => {
      const urls = extractUrls(
        'Read (https://example.com/doc). Then check https://example.com/sheet, and https://example.com/end!'
      );
      expect(urls.map((url) => url.url)).toEqual([
        'https://example.com/doc',
        'https://example.com/sheet',
        'https://example.com/end',
      ]);
    });

    it('keeps balanced parentheses that are part of a URL path', () => {
      const urls = extractUrls('Reference https://en.wikipedia.org/wiki/Function_(mathematics).');
      expect(urls).toHaveLength(1);
      expect(urls[0]?.url).toBe('https://en.wikipedia.org/wiki/Function_(mathematics)');
    });
  });

  describe('enrichToolSearchQuery', () => {
    it('returns empty string when no URLs are provided', () => {
      expect(enrichToolSearchQuery([])).toBe('');
    });

    it('maps known domains to human-readable tool hints', () => {
      const query = enrichToolSearchQuery([
        { url: 'https://docs.google.com/document/d/abc', domain: 'docs.google.com', fullMatch: '' },
        { url: 'https://notion.so/page/123', domain: 'notion.so', fullMatch: '' },
        { url: 'https://linear.app/team/issue/ABC-1', domain: 'linear.app', fullMatch: '' },
        { url: 'https://acme.slack.com/archives/C123', domain: 'acme.slack.com', fullMatch: '' },
      ]);
      expect(query).toBe(
        'Google Docs document reader, Notion page reader, Linear issue tracker, Slack message reader'
      );
    });

    it('returns the domain for unknown services', () => {
      const query = enrichToolSearchQuery([
        { url: 'https://unknown.example.com/page', domain: 'unknown.example.com', fullMatch: '' },
      ]);
      expect(query).toBe('unknown.example.com');
    });

    it('deduplicates repeated domains/hints while preserving first-seen order', () => {
      const query = enrichToolSearchQuery([
        { url: 'https://docs.google.com/document/d/abc', domain: 'docs.google.com', fullMatch: '' },
        { url: 'https://docs.google.com/spreadsheets/d/xyz', domain: 'docs.google.com', fullMatch: '' },
        { url: 'https://custom.example.com/path', domain: 'custom.example.com', fullMatch: '' },
        { url: 'https://team.slack.com/archives/C123', domain: 'team.slack.com', fullMatch: '' },
      ]);
      expect(query).toBe(
        'Google Docs document reader, custom.example.com, Slack message reader'
      );
    });
  });

  describe('getDomainSearchHint', () => {
    it('maps new service domains correctly', () => {
      expect(getDomainSearchHint('github.com')).toBe('GitHub repository');
      expect(getDomainSearchHint('figma.com')).toBe('Figma design file');
      expect(getDomainSearchHint('www.figma.com')).toBe('Figma design file');
      expect(getDomainSearchHint('acme.atlassian.net')).toBe('Atlassian (Jira/Confluence)');
      expect(getDomainSearchHint('myorg.salesforce.com')).toBe('Salesforce record');
      expect(getDomainSearchHint('team-workspace.notion.site')).toBe('Notion page reader');
    });

    it('falls back to raw domain for unknown services', () => {
      expect(getDomainSearchHint('example.com')).toBe('example.com');
    });
  });

  describe('sanitizeUrlsForEmbedding', () => {
    it('returns text unchanged when no URLs are present', () => {
      const text = 'Summarize the Q3 strategy discussion notes';
      expect(sanitizeUrlsForEmbedding(text)).toBe(text);
    });

    it('strips a single URL and adds service hint', () => {
      const text = 'Read https://notion.so/acme/Q3-Strategy-54f0c9 and summarize it';
      const result = sanitizeUrlsForEmbedding(text);
      expect(result).not.toContain('https://notion.so');
      expect(result).toContain('Notion page reader');
      expect(result).toContain('summarize it');
    });

    it('strips multiple URLs from different services and adds deduplicated hints', () => {
      const text = 'Compare https://docs.google.com/document/d/abc with https://notion.so/page/123 and https://linear.app/team/ABC-1';
      const result = sanitizeUrlsForEmbedding(text);
      expect(result).not.toContain('https://docs.google.com');
      expect(result).not.toContain('https://notion.so');
      expect(result).not.toContain('https://linear.app');
      expect(result).toContain('Google Docs document reader');
      expect(result).toContain('Notion page reader');
      expect(result).toContain('Linear issue tracker');
      expect(result).toContain('Compare');
    });

    it('does not repeat hints for duplicate service URLs', () => {
      const text = 'Merge https://notion.so/page/first and https://notion.so/page/second into one doc';
      const result = sanitizeUrlsForEmbedding(text);
      // Hint should appear exactly once
      const hintCount = (result.match(/Notion page reader/g) || []).length;
      expect(hintCount).toBe(1);
      expect(result).toContain('Merge');
      expect(result).toContain('into one doc');
    });

    it('falls back to domain name for unknown services', () => {
      const text = 'Check https://internal.acme.corp/report/q3 for details';
      const result = sanitizeUrlsForEmbedding(text);
      expect(result).not.toContain('https://internal.acme.corp');
      expect(result).toContain('internal.acme.corp');
      expect(result).toContain('for details');
    });

    it('preserves natural language around URLs', () => {
      const text = 'Please read https://notion.so/page/123 carefully and prepare a summary for the board meeting';
      const result = sanitizeUrlsForEmbedding(text);
      expect(result).toContain('Please read');
      expect(result).toContain('carefully and prepare a summary for the board meeting');
      expect(result).toContain('Notion page reader');
    });

    it('handles markdown link syntax', () => {
      const text = 'Review [Q3 Strategy](https://notion.so/acme/Q3-Strategy) before the meeting';
      const result = sanitizeUrlsForEmbedding(text);
      expect(result).not.toContain('https://notion.so');
      expect(result).not.toContain('[Q3 Strategy]');
      expect(result).toContain('Notion page reader');
      expect(result).toContain('before the meeting');
    });

    it('handles the CEO failure scenario (4 URLs diluting embedding)', () => {
      const text = 'Read file:///Users/you/fox-2545-preview.html and compare with https://docs.google.com/document/d/abc and https://docs.google.com/document/d/xyz. Then check https://notion.so/acme/Q3-Competitive-Strategy-54f0c9 for the latest competitive analysis.';
      const result = sanitizeUrlsForEmbedding(text);
      // All URLs stripped
      expect(result).not.toContain('https://docs.google.com');
      expect(result).not.toContain('https://notion.so');
      expect(result).not.toContain('file:///');
      // Service hints present (deduplicated)
      expect(result).toContain('Google Docs document reader');
      expect(result).toContain('Notion page reader');
      // Natural language preserved
      expect(result).toContain('compare with');
      expect(result).toContain('competitive analysis');
      // No excessive whitespace
      expect(result).not.toMatch(/\s{2,}/);
    });

    it('adds hints for newly supported services', () => {
      const text = 'Check https://github.com/org/repo/pull/42 and https://www.figma.com/file/abc and https://acme.atlassian.net/browse/PROJ-1 and https://myorg.salesforce.com/001/record';
      const result = sanitizeUrlsForEmbedding(text);
      expect(result).toContain('GitHub repository');
      expect(result).toContain('Figma design file');
      expect(result).toContain('Atlassian (Jira/Confluence)');
      expect(result).toContain('Salesforce record');
    });
  });
});
