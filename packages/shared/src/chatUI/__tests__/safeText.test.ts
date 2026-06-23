import { describe, expect, it } from 'vitest';
import { escapeHtml, normalizeText } from '../safeText';

describe('chatUI safeText', () => {
  it('normalizes nullish values to empty strings', () => {
    expect(normalizeText(undefined)).toBe('');
    expect(normalizeText(null)).toBe('');
    expect(normalizeText('hello')).toBe('hello');
  });

  it('escapes unsafe HTML characters without stripping plain text content', () => {
    expect(
      escapeHtml(`<script>alert("x")</script> & "quoted" 'single'`),
    ).toBe(
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &quot;quoted&quot; &#39;single&#39;',
    );
  });

  it('preserves line breaks for DOM callers that render escaped HTML into pre-wrap containers', () => {
    expect(escapeHtml('line 1\nline <2>')).toBe('line 1\nline &lt;2&gt;');
  });
});
