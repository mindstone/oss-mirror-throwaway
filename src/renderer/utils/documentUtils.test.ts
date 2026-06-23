import { describe, it, expect } from 'vitest';
import { decodeHtmlEntitiesInMarkdown } from './documentUtils';

describe('decodeHtmlEntitiesInMarkdown', () => {
  it('returns empty/falsy input unchanged', () => {
    expect(decodeHtmlEntitiesInMarkdown('')).toBe('');
    expect(decodeHtmlEntitiesInMarkdown(null as unknown as string)).toBe(null);
    expect(decodeHtmlEntitiesInMarkdown(undefined as unknown as string)).toBe(undefined);
  });

  it('returns content without entities unchanged', () => {
    const input = 'Hello world\n\nNo entities here.';
    expect(decodeHtmlEntitiesInMarkdown(input)).toBe(input);
  });

  it('decodes &nbsp; to non-breaking space', () => {
    expect(decodeHtmlEntitiesInMarkdown('Hello&nbsp;World')).toBe('Hello\u00a0World');
  });

  it('decodes &nbsp; in markdown table cells', () => {
    const input = '| Header | Header |\n|--------|--------|\n| data   | &nbsp; |';
    const result = decodeHtmlEntitiesInMarkdown(input);
    expect(result).not.toContain('&nbsp;');
    expect(result).toContain('\u00a0');
  });

  it('decodes multiple &nbsp; entities', () => {
    const input = '&nbsp;&nbsp;&nbsp;';
    expect(decodeHtmlEntitiesInMarkdown(input)).toBe('\u00a0\u00a0\u00a0');
  });

  it('decodes common named entities', () => {
    expect(decodeHtmlEntitiesInMarkdown('&amp;')).toBe('&');
    expect(decodeHtmlEntitiesInMarkdown('&lt;')).toBe('<');
    expect(decodeHtmlEntitiesInMarkdown('&gt;')).toBe('>');
    expect(decodeHtmlEntitiesInMarkdown('&quot;')).toBe('"');
    expect(decodeHtmlEntitiesInMarkdown('&#39;')).toBe("'");
  });

  it('decodes numeric decimal entities (&#160;)', () => {
    expect(decodeHtmlEntitiesInMarkdown('&#160;')).toBe('\u00a0');
  });

  it('decodes numeric hex entities (&#xA0;)', () => {
    expect(decodeHtmlEntitiesInMarkdown('&#xA0;')).toBe('\u00a0');
  });

  it('decodes double-encoded &amp;nbsp; to non-breaking space', () => {
    // &amp;nbsp; → first pass decodes &amp; → &nbsp; → second pass decodes → \u00a0
    expect(decodeHtmlEntitiesInMarkdown('&amp;nbsp;')).toBe('\u00a0');
  });

  it('decodes double-encoded &amp;#160; to non-breaking space', () => {
    expect(decodeHtmlEntitiesInMarkdown('&amp;#160;')).toBe('\u00a0');
  });

  it('decodes double-encoded &amp;#xA0; to non-breaking space', () => {
    expect(decodeHtmlEntitiesInMarkdown('&amp;#xA0;')).toBe('\u00a0');
  });

  it('preserves entities inside fenced code blocks', () => {
    const input = '```\n&nbsp; inside code\n```';
    expect(decodeHtmlEntitiesInMarkdown(input)).toBe(input);
  });

  it('preserves entities inside inline code', () => {
    const input = 'Use `&nbsp;` for spacing';
    expect(decodeHtmlEntitiesInMarkdown(input)).toBe(input);
  });

  it('preserves entities inside double-backtick inline code', () => {
    const input = 'Use ``&nbsp;`` for spacing';
    expect(decodeHtmlEntitiesInMarkdown(input)).toBe(input);
  });

  it('decodes entities in text around code blocks', () => {
    const input = 'Before &nbsp; code ```\n&nbsp;\n``` after &nbsp; end';
    const result = decodeHtmlEntitiesInMarkdown(input);
    expect(result).toBe('Before \u00a0 code ```\n&nbsp;\n``` after \u00a0 end');
  });

  it('decodes entities mixed with markdown formatting', () => {
    const input = '**bold &nbsp; text** and *italic &nbsp; text*';
    const result = decodeHtmlEntitiesInMarkdown(input);
    expect(result).toBe('**bold \u00a0 text** and *italic \u00a0 text*');
  });

  it('handles mixed single and double-encoded entities', () => {
    const input = '&nbsp; and &amp;nbsp; together';
    const result = decodeHtmlEntitiesInMarkdown(input);
    expect(result).toBe('\u00a0 and \u00a0 together');
  });
});
