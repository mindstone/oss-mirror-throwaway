import { describe, it, expect } from 'vitest';
import { preprocessMarkdownForRender, findBlockedUrlScheme } from '@rebel/shared';

describe('SafeWebMarkdown dependencies smoke', () => {
  it('preprocessMarkdownForRender is importable and returns {source, remarkPlugins}', () => {
    const result = preprocessMarkdownForRender('hello [link](my file.pdf)');
    expect(typeof result.source).toBe('string');
    expect(Array.isArray(result.remarkPlugins)).toBe(true);
    expect(result.remarkPlugins.length).toBeGreaterThan(0);
    // Space encoding applied.
    expect(result.source).toContain('my%20file.pdf');
  });

  it('findBlockedUrlScheme detects the 3 known dangerous schemes', () => {
    expect(findBlockedUrlScheme('javascript:alert(1)')).toBe('javascript:');
    expect(findBlockedUrlScheme('blob:http://x.com/y')).toBe('blob:');
    expect(findBlockedUrlScheme('file:///etc/passwd')).toBe('file:');
    expect(findBlockedUrlScheme('https://example.com/ok.png')).toBeNull();
  });
});
