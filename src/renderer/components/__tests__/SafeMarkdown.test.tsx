// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderToString } from 'react-dom/server';
import { createElement } from 'react';
import { SafeMarkdown } from '../SafeMarkdown';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SafeMarkdown', () => {
  describe('code fence protection', () => {
    it('does not render # inside a code fence as a heading', () => {
      const md = '```\n# Not a heading\n## Also not\n```';
      const html = renderToString(createElement(SafeMarkdown, { children: md }));
      expect(html).not.toMatch(/<h1/);
      expect(html).not.toMatch(/<h2/);
      expect(html).toContain('# Not a heading');
    });

    it('renders # outside a code fence as a heading', () => {
      const md = '# Real heading\n\nSome text';
      const html = renderToString(createElement(SafeMarkdown, { children: md }));
      expect(html).toMatch(/<h1/);
      expect(html).toContain('Real heading');
    });

    it('preserves inline code content literally', () => {
      const md = 'Use `# not a heading` in your file';
      const html = renderToString(createElement(SafeMarkdown, { children: md }));
      expect(html).not.toMatch(/<h1/);
      expect(html).toContain('# not a heading');
    });
  });

  describe('GFM support', () => {
    it('renders GFM tables inside a scrollable wrapper', () => {
      const md = '| Col A | Col B |\n|-------|-------|\n| 1 | 2 |';
      const html = renderToString(createElement(SafeMarkdown, { children: md }));
      expect(html).toContain('markdown-table-wrapper');
      expect(html).toContain('<table');
    });

    it('renders strikethrough with GFM', () => {
      const md = '~~deleted~~';
      const html = renderToString(createElement(SafeMarkdown, { children: md }));
      expect(html).toContain('<del');
    });
  });

  describe('className prop', () => {
    it('uses markdown-body as default wrapper class', () => {
      const html = renderToString(createElement(SafeMarkdown, { children: 'hello' }));
      expect(html).toContain('markdown-body');
    });

    it('uses custom className when provided', () => {
      const html = renderToString(
        createElement(SafeMarkdown, { className: 'atlas-markdown-content', children: 'hello' })
      );
      expect(html).toContain('atlas-markdown-content');
      expect(html).not.toContain('markdown-body');
    });
  });

  describe('breaks prop (soft break → <br>)', () => {
    // A Slack/email-style draft: section header + bullets joined by single
    // newlines (CommonMark soft breaks). Mirrors the real "Greg - Look Ahead"
    // document draft from rebel://conversation/350457e1-... that surfaced the bug.
    const SLACK_DRAFT = [
      '*This week / today:*',
      '• Main focus is getting Rebel into a better public shape.',
      '• Also keeping an eye on reliability and cost plumbing.',
    ].join('\n');

    it('default (breaks off): single newlines collapse — no <br> (chat unchanged)', () => {
      const html = renderToString(createElement(SafeMarkdown, { children: SLACK_DRAFT }));
      expect(html).not.toMatch(/<br\s*\/?>/);
    });

    it('breaks on: single newlines render as <br> (document-preview fix)', () => {
      const html = renderToString(
        createElement(SafeMarkdown, { children: SLACK_DRAFT, breaks: true }),
      );
      const breakCount = (html.match(/<br\s*\/?>/g) ?? []).length;
      // Header → bullet 1 → bullet 2 = two soft breaks within the paragraph.
      expect(breakCount).toBe(2);
      expect(html).toContain('Main focus');
      expect(html).toContain('cost plumbing');
    });

    it('breaks on: paragraph (double-newline) structure still works', () => {
      const html = renderToString(
        createElement(SafeMarkdown, { children: 'Para one.\n\nPara two.', breaks: true }),
      );
      expect((html.match(/<p>/g) ?? []).length).toBe(2);
      expect(html).not.toMatch(/<br\s*\/?>/);
    });
  });

  describe('edge cases', () => {
    it('handles empty string', () => {
      const html = renderToString(createElement(SafeMarkdown, { children: '' }));
      expect(html).toContain('markdown-body');
    });

    it('handles nested code fences in markdown', () => {
      const md = '````\n```python\nprint("hello")\n```\n````';
      const html = renderToString(createElement(SafeMarkdown, { children: md }));
      expect(html).not.toMatch(/<h[1-6]/);
      expect(html).toContain('print');
    });
  });
});

describe('SafeMarkdown I10 migration', () => {
  const render = (md: string) => renderToString(createElement(SafeMarkdown, { children: md }));

  it('T-D1.1 renders image paths with spaces (encoded) instead of silently dropping', () => {
    const html = render('![alt](my image.png)');
    // Must contain an <img> element (no silent drop) with the space encoded.
    expect(html).toMatch(/<img[^>]*src="my%20image\.png"/);
    expect(html).toMatch(/<img[^>]*alt="alt"/);
  });

  it('T-D1.2 blocks javascript: via the guard (hidden placeholder + warning)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const html = render('![xss](javascript:alert(1))');
    // Guard fires: hidden placeholder rendered, no javascript: leaks into DOM.
    expect(html.toLowerCase()).not.toContain('javascript:');
    expect(html).toMatch(/<img[^>]*hidden/);
    expect(warnSpy).toHaveBeenCalledWith(
      '[Renderer] SafeMarkdown img blocked (dangerous scheme)',
      expect.objectContaining({ scheme: 'javascript:' }),
    );
  });

  it('T-D1.3 blocks blob: via the guard (hidden placeholder + warning)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const html = render('![xss](blob:http://example.com/abc)');
    expect(html.toLowerCase()).not.toContain('blob:');
    expect(html).toMatch(/<img[^>]*hidden/);
    expect(warnSpy).toHaveBeenCalledWith(
      '[Renderer] SafeMarkdown img blocked (dangerous scheme)',
      expect.objectContaining({ scheme: 'blob:' }),
    );
  });

  it('T-D1.4 blocks file: via the guard (hidden placeholder + warning)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const html = render('![xss](file:///etc/passwd)');
    expect(html.toLowerCase()).not.toContain('file:');
    expect(html).toMatch(/<img[^>]*hidden/);
    expect(warnSpy).toHaveBeenCalledWith(
      '[Renderer] SafeMarkdown img blocked (dangerous scheme)',
      expect.objectContaining({ scheme: 'file:' }),
    );
  });

  it('T-D1.5 allows https images unchanged', () => {
    const html = render('![alt](https://example.com/ok.png)');
    expect(html).toMatch(/<img[^>]*src="https:\/\/example\.com\/ok\.png"/);
    // Not hidden.
    expect(html).not.toMatch(/<img[^>]*hidden/);
  });

  it('T-D1.6 preserves table wrapper behavior', () => {
    const html = render('| Col A | Col B |\n|-------|-------|\n| 1 | 2 |');
    expect(html).toContain('markdown-table-wrapper');
    expect(html).toContain('<table');
  });

  it('T-D1.7 still renders plain text', () => {
    const html = render('plain text still renders');
    expect(html).toContain('plain text still renders');
  });

  // ------------------------------------------------------------------
  // R1 — XSS anchor-guard regression tests (SafeMarkdown)
  // ------------------------------------------------------------------
  //
  // Shipped 2026-04-23. Fix in SafeMarkdown.tsx mirrors the existing img
  // guard and renders blocked anchors WITHOUT any href (inert) rather than
  // relying on the navigation-layer will-navigate check, which does NOT
  // intercept `javascript:` URLs.
  //
  // Full context: docs/plans/260423_r1_xss_deferred_finding.md (runtime PoC
  // in §12) and docs/plans/260423_r1_xss_fix_implementation.md.
  describe('R1 — XSS anchor guard (SafeMarkdown)', () => {
    it('R1 regression: [click](javascript:...) renders inert anchor + warn', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const md = "[click me](javascript:document.title='PWNED')";
      const html = render(md);
      expect(html).not.toMatch(/href="javascript:/i);
      expect(html).not.toMatch(/<a[^>]*href=/i);
      expect(html).toContain('click me');
      expect(warnSpy).toHaveBeenCalledWith(
        '[Renderer] SafeMarkdown a blocked (dangerous scheme)',
        expect.objectContaining({ scheme: 'javascript:' }),
      );
    });

    it('R1 regression: [read](blob:...) renders inert anchor + warn', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const md = '[read](blob:http://x.com/y)';
      const html = render(md);
      expect(html).not.toMatch(/href="blob:/i);
      expect(html).not.toMatch(/<a[^>]*href=/i);
      expect(html).toContain('read');
      expect(warnSpy).toHaveBeenCalledWith(
        '[Renderer] SafeMarkdown a blocked (dangerous scheme)',
        expect.objectContaining({ scheme: 'blob:' }),
      );
    });

    it('R1 regression: [read](file:...) renders inert anchor + warn', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const md = '[read](file:///etc/passwd)';
      const html = render(md);
      expect(html).not.toMatch(/href="file:/i);
      expect(html).not.toMatch(/<a[^>]*href=/i);
      expect(html).toContain('read');
      expect(warnSpy).toHaveBeenCalledWith(
        '[Renderer] SafeMarkdown a blocked (dangerous scheme)',
        expect.objectContaining({ scheme: 'file:' }),
      );
    });

    it('R1 regression: [ok](https://example.com) keeps href unchanged', () => {
      const html = render('[ok](https://example.com)');
      expect(html).toMatch(/<a[^>]*href="https:\/\/example\.com"/);
      expect(html).toContain('ok');
    });

    it('R1 regression: case+whitespace variant is normalized, blocked, and logged', () => {
      // Note: leading-space destinations are rewritten to %20... by
      // encodeSpacesInMarkdownLinks before the guard runs, so we use a
      // trailing-space variant to exercise findBlockedUrlScheme() with a
      // non-normalized (mixed-case) scheme.
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const html = render('[x](JAVASCRIPT:alert(1) )');
      expect(html).not.toMatch(/href="javascript:/i);
      expect(html).not.toMatch(/<a[^>]*href=/i);
      expect(html).toContain('x');
      expect(warnSpy).toHaveBeenCalledWith(
        '[Renderer] SafeMarkdown a blocked (dangerous scheme)',
        expect.objectContaining({ scheme: 'javascript:' }),
      );
    });

    it('R1 regression: [jump](#section) remains unchanged and does not warn', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const html = render('[jump](#section)');
      expect(html).toMatch(/<a[^>]*href="#section"/);
      expect(html).toContain('jump');
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('R1 regression: URL-encoded javascript scheme is blanked (no anchor href)', () => {
      // %6a = 'j'. defaultUrlTransform does not decode before allowlist check,
      // so "%6aavascript:" is not in the safeProtocol list → blanked.
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const html = render('[x](%6aavascript:alert(1))');
      expect(html.toLowerCase()).not.toContain('javascript:');
      // href attribute must NOT be set to the dangerous value — react-markdown
      // blanks it, so the anchor either has no href or href="".
      expect(html).not.toMatch(/<a[^>]*href="[^"]*avascript/i);
      // Guard does not fire for this variant because the transform already
      // neutralized the scheme before our guard saw it.
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('R1 regression: CRLF-broken javascript scheme does not render as anchor', () => {
      // remark-commonmark's link destination parsing rejects newlines, so
      // `[x](java\nscript:alert(1))` does not parse as a link — it remains
      // plain text. We assert NO anchor element of any kind is rendered.
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const html = render('[x](java\nscript:alert(1))');
      expect(html.toLowerCase()).not.toContain('javascript:');
      expect(html).not.toMatch(/<a\b/i);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('R1 regression: title attribute is preserved on allowed links', () => {
      const html = render('[ok](https://example.com "tooltip")');
      expect(html).toMatch(/<a[^>]*href="https:\/\/example\.com"/);
      expect(html).toMatch(/title="tooltip"/);
    });
  });
});
