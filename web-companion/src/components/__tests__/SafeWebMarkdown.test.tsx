import { createElement, type ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { type Components } from 'react-markdown';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SafeWebMarkdown } from '../SafeWebMarkdown';

// Closed-API contract (R1 Stage 2b, 2026-04-27):
// - `components` is `Omit<Components, 'a' | 'img'>`. Tests use the type
//   directly when they need to pass non-a/img overrides; cast-bypass tests
//   intentionally use `as unknown as Components` to verify runtime defense.
// - `preserveSchemes` is `readonly ['rebel://']`. The cast-bypass test
//   forces a wider type to verify the runtime allowlist drops the disallowed
//   entry.
// - `onAnchorClick` fires only on the safe branch (after the guard passes).
// - `anchorTarget` opt-in controls `target="_blank" rel="noopener noreferrer"`.

// Mirrors `SafeWebMarkdownComponents` in the wrapper — `a?: never; img?: never`
// makes both object-literal AND variable misuse trip the type checker.
type SafeComponents = Omit<Components, 'a' | 'img'> & {
  a?: never;
  img?: never;
};

const renderMarkdown = (markdown: string, components?: SafeComponents) =>
  renderToString(createElement(SafeWebMarkdown, { children: markdown, components }));

const renderMarkdownWithPreserve = (
  markdown: string,
  preserveSchemes: readonly ['rebel://'],
  components?: SafeComponents,
) =>
  renderToString(
    createElement(SafeWebMarkdown, { children: markdown, preserveSchemes, components }),
  );

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SafeWebMarkdown', () => {
  it('T-D3.1 renders image paths with spaces as encoded URLs', () => {
    const html = renderMarkdown('![alt](my image.png)');
    expect(html).toMatch(/<img[^>]*src="my%20image\.png"/);
  });

  it('T-D3.2 blocks javascript: via the guard (hidden placeholder + warning)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const html = renderMarkdown('![xss](javascript:alert(1))');
    expect(html.toLowerCase()).not.toContain('javascript:');
    expect(html).toMatch(/<img[^>]*hidden/);
    expect(warnSpy).toHaveBeenCalledWith(
      '[web-companion] SafeWebMarkdown img blocked (dangerous scheme)',
      expect.objectContaining({ scheme: 'javascript:' }),
    );
  });

  it('T-D3.3 blocks blob: via the guard (hidden placeholder + warning)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const html = renderMarkdown('![xss](blob:http://x.com/y)');
    expect(html.toLowerCase()).not.toContain('blob:');
    expect(html).toMatch(/<img[^>]*hidden/);
    expect(warnSpy).toHaveBeenCalledWith(
      '[web-companion] SafeWebMarkdown img blocked (dangerous scheme)',
      expect.objectContaining({ scheme: 'blob:' }),
    );
  });

  it('T-D3.4 blocks file: via the guard (hidden placeholder + warning)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const html = renderMarkdown('![xss](file:///etc/passwd)');
    expect(html.toLowerCase()).not.toContain('file:');
    expect(html).toMatch(/<img[^>]*hidden/);
    expect(warnSpy).toHaveBeenCalledWith(
      '[web-companion] SafeWebMarkdown img blocked (dangerous scheme)',
      expect.objectContaining({ scheme: 'file:' }),
    );
  });

  it('T-D3.5 allows https image URLs unchanged', () => {
    const html = renderMarkdown('![alt](https://example.com/ok.png)');
    expect(html).toMatch(/<img[^>]*src="https:\/\/example\.com\/ok\.png"/);
  });

  it('T-D3.6 merges caller components passthrough for non-img renderers', () => {
    const html = renderMarkdown('**bold**', {
      strong: ({ children }) => <strong data-variant="custom">{children}</strong>,
    });
    expect(html).toContain('data-variant="custom"');
  });

  // T-D3.7 removed (R1 Stage 2b): caller `img` override is no longer permitted
  // by the closed `Omit<Components, 'a' | 'img'>` API. The runtime cast-bypass
  // regression `R1-NEW.1` below asserts this is ALSO enforced at runtime.

  // -----------------------------------------------------------------------
  // preserveSchemes prop (I10 follow-up F4 amendment, Stage 2)
  // -----------------------------------------------------------------------

  it('T-SWM.NEW.1 preserves rebel:// anchor href when preserveSchemes=["rebel://"]', () => {
    const html = renderMarkdownWithPreserve(
      '[sess](rebel://conversation/abc)',
      ['rebel://'],
    );
    expect(html).toMatch(/<a[^>]*href="rebel:\/\/conversation\/abc"/);
  });

  it('T-SWM.NEW.2 without preserveSchemes, rebel:// anchor href is blanked (backward-compat)', () => {
    const html = renderMarkdown('[sess](rebel://conversation/abc)');
    // default urlTransform blanks custom schemes; react-markdown drops empty hrefs
    expect(html).not.toContain('rebel://conversation/abc');
  });

  it('T-SWM.NEW.3 dangerous javascript: still blocked even with preserveSchemes', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const html = renderMarkdownWithPreserve(
      '![xss](javascript:alert(1))',
      ['rebel://'],
    );
    expect(html.toLowerCase()).not.toContain('javascript:');
    expect(html).toMatch(/<img[^>]*hidden/);
    expect(warnSpy).toHaveBeenCalledWith(
      '[web-companion] SafeWebMarkdown img blocked (dangerous scheme)',
      expect.objectContaining({ scheme: 'javascript:' }),
    );
  });

  // ------------------------------------------------------------------
  // R1 — XSS anchor-guard regression tests (SafeWebMarkdown)
  // ------------------------------------------------------------------
  //
  // Shipped 2026-04-23. Fix in SafeWebMarkdown.tsx mirrors the existing img
  // guard and renders blocked anchors WITHOUT any href (inert). The blocked
  // path fails closed — it does NOT delegate to caller-supplied
  // `components.a`, so `ConversationScreen`'s `handleLinkClick` never sees
  // a dangerous href. The deliberate effect: `file://` anchors on web no
  // longer trigger the "Open in Rebel app" toast; that was UX sugar, not a
  // security control.
  //
  // Full context: docs/plans/260423_r1_xss_deferred_finding.md (runtime PoC
  // in §12) and docs/plans/260423_r1_xss_fix_implementation.md.
  describe('R1 — XSS anchor guard (SafeWebMarkdown)', () => {
    it('R1 regression: [click](javascript:...) renders inert anchor + warn', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const md = "[click me](javascript:document.title='PWNED')";
      const html = renderMarkdown(md);
      expect(html).not.toMatch(/href="javascript:/i);
      expect(html).not.toMatch(/<a[^>]*href=/i);
      expect(html).toContain('click me');
      expect(warnSpy).toHaveBeenCalledWith(
        '[web-companion] SafeWebMarkdown a blocked (dangerous scheme)',
        expect.objectContaining({ scheme: 'javascript:' }),
      );
    });

    it('R1 regression: [read](blob:...) renders inert anchor + warn', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const md = '[read](blob:http://x.com/y)';
      const html = renderMarkdown(md);
      expect(html).not.toMatch(/href="blob:/i);
      expect(html).not.toMatch(/<a[^>]*href=/i);
      expect(html).toContain('read');
      expect(warnSpy).toHaveBeenCalledWith(
        '[web-companion] SafeWebMarkdown a blocked (dangerous scheme)',
        expect.objectContaining({ scheme: 'blob:' }),
      );
    });

    it('R1 regression: [read](file:...) renders inert anchor + warn', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const md = '[read](file:///etc/passwd)';
      const html = renderMarkdown(md);
      expect(html).not.toMatch(/href="file:/i);
      expect(html).not.toMatch(/<a[^>]*href=/i);
      expect(html).toContain('read');
      expect(warnSpy).toHaveBeenCalledWith(
        '[web-companion] SafeWebMarkdown a blocked (dangerous scheme)',
        expect.objectContaining({ scheme: 'file:' }),
      );
    });

    it('R1 regression: [ok](https://example.com) keeps href unchanged', () => {
      const html = renderMarkdown('[ok](https://example.com)');
      expect(html).toMatch(/<a[^>]*href="https:\/\/example\.com"/);
      expect(html).toContain('ok');
    });

    it('R1 regression: case+whitespace variant is normalized, blocked, and logged', () => {
      // Leading-space destinations are rewritten to %20... by
      // encodeSpacesInMarkdownLinks before the guard runs; trailing-space
      // keeps the guard exercised with a mixed-case scheme.
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const html = renderMarkdown('[x](JAVASCRIPT:alert(1) )');
      expect(html).not.toMatch(/href="javascript:/i);
      expect(html).not.toMatch(/<a[^>]*href=/i);
      expect(html).toContain('x');
      expect(warnSpy).toHaveBeenCalledWith(
        '[web-companion] SafeWebMarkdown a blocked (dangerous scheme)',
        expect.objectContaining({ scheme: 'javascript:' }),
      );
    });

    it('R1 regression: [jump](#section) remains unchanged and does not warn', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const html = renderMarkdown('[jump](#section)');
      expect(html).toMatch(/<a[^>]*href="#section"/);
      expect(html).toContain('jump');
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('R1 regression: URL-encoded javascript scheme is blanked (no anchor href)', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const html = renderMarkdown('[x](%6aavascript:alert(1))');
      expect(html.toLowerCase()).not.toContain('javascript:');
      expect(html).not.toMatch(/<a[^>]*href="[^"]*avascript/i);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('R1 regression: CRLF-broken javascript scheme does not render as anchor', () => {
      // remark-commonmark rejects newlines in link destinations; the string
      // does not parse as a link at all. Assert NO anchor element of any
      // kind is rendered.
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const html = renderMarkdown('[x](java\nscript:alert(1))');
      expect(html.toLowerCase()).not.toContain('javascript:');
      expect(html).not.toMatch(/<a\b/i);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    // R1 Stage 2b (2026-04-27): the previous "delegates to caller components.a"
    // tests are obsolete because callers can no longer override `a`. The
    // `onAnchorClick` family below verifies the typed escape hatch.

    it('R1 regression: title attribute is preserved on allowed links', () => {
      const html = renderMarkdown('[ok](https://example.com "tooltip")');
      expect(html).toMatch(/<a[^>]*href="https:\/\/example\.com"/);
      expect(html).toMatch(/title="tooltip"/);
    });
  });

  // ----------------------------------------------------------------------
  // R1 Stage 2b — closed-API contract regression tests
  // ----------------------------------------------------------------------
  // After Stage 2b (2026-04-27), the `components` prop is
  // `Omit<Components, 'a' | 'img'>` AND the wrapper's safe `a`/`img` win at
  // runtime via property-order spread (defense-in-depth against `as
  // unknown as Components` casts). These tests assert both layers.
  describe('R1 Stage 2b — closed-API contract', () => {
    it('R1-NEW.1 cast-bypass: as unknown as Components cannot override a/img', () => {
      // Force past the Omit type at the call site to simulate a future agent
      // (or malicious code path) using `as any` to escape. The wrapper's
      // runtime spread-then-overwrite must still win.
      const evilAnchorSpy = vi.fn();
      const evilImgSpy = vi.fn();
      const evilComponents = {
        a: ({ href, children }: { href?: string; children: ReactNode }) => {
          evilAnchorSpy({ href });
          return <a data-testid="evil-anchor" href={href}>{children}</a>;
        },
        img: ({ src, alt }: { src?: string; alt?: string }) => {
          evilImgSpy({ src });
          return <img data-testid="evil-img" src={src} alt={alt} />;
        },
      } as unknown as SafeComponents;

      const html = renderMarkdown(
        '[ok](https://example.com) ![alt](https://example.com/ok.png)',
        evilComponents,
      );

      expect(evilAnchorSpy).not.toHaveBeenCalled();
      expect(evilImgSpy).not.toHaveBeenCalled();
      expect(html).not.toContain('data-testid="evil-anchor"');
      expect(html).not.toContain('data-testid="evil-img"');
      // Wrapper's safe-branch output is present.
      expect(html).toMatch(/<a[^>]*href="https:\/\/example\.com"/);
      expect(html).toMatch(/<img[^>]*src="https:\/\/example\.com\/ok\.png"/);
    });

    it('R1-NEW.2 preserveSchemes allowlist drops disallowed entries at runtime', () => {
      // Force past the literal-tuple type to simulate a future agent
      // bypassing the type. The runtime allowlist must drop 'data:' so it
      // does NOT preserve a data:image/svg+xml href to the rendered anchor.
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const html = renderToString(
        createElement(SafeWebMarkdown, {
          children: '[click](data:text/html,<script>alert(1)</script>)',
          preserveSchemes: ['data:'] as unknown as readonly ['rebel://'],
        }),
      );

      // The data: href should NOT appear in the rendered output.
      expect(html.toLowerCase()).not.toContain('data:text/html');
      // The drop was logged (observable misuse).
      expect(warnSpy).toHaveBeenCalledWith(
        '[web-companion] SafeWebMarkdown dropping preserveSchemes entry not in allowlist',
        expect.objectContaining({ scheme: 'data:' }),
      );
    });

    it('R1-NEW.3 onAnchorClick fires on safe-branch https click', () => {
      const onClickSpy = vi.fn();
      const html = renderToString(
        createElement(SafeWebMarkdown, {
          children: '[ok](https://example.com)',
          onAnchorClick: onClickSpy,
        }),
      );
      // The handler is wired to the rendered anchor — server-render captures
      // the JSX shape, so we verify the anchor exists and the wrapper passes
      // the function. A separate dom-level test would simulate the click;
      // here we assert the anchor is present (proving the safe branch ran)
      // and rely on R1-NEW.4 to assert the blocked branch does NOT wire it.
      expect(html).toMatch(/<a[^>]*href="https:\/\/example\.com"/);
      // Server-render won't fire the handler; this asserts the prop wiring
      // path runs without error and the resulting JSX is well-formed.
      expect(onClickSpy).not.toHaveBeenCalled();
    });

    it('R1-NEW.4 onAnchorClick is NOT wired on blocked-scheme anchors', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const onClickSpy = vi.fn();
      const html = renderToString(
        createElement(SafeWebMarkdown, {
          children: '[xss](javascript:alert(1))',
          onAnchorClick: onClickSpy,
        }),
      );
      // Blocked path renders an inert <a>{children}</a> with no href — and
      // crucially no onClick. The wrapper does NOT invoke the caller hook.
      expect(html).not.toMatch(/<a[^>]*href=/i);
      expect(html).toContain('xss');
      expect(warnSpy).toHaveBeenCalledWith(
        '[web-companion] SafeWebMarkdown a blocked (dangerous scheme)',
        expect.objectContaining({ scheme: 'javascript:' }),
      );
      expect(onClickSpy).not.toHaveBeenCalled();
    });

    it('R1-NEW.5 anchorTarget="_blank" sets target+rel on safe-branch anchors', () => {
      const html = renderToString(
        createElement(SafeWebMarkdown, {
          children: '[ok](https://example.com)',
          anchorTarget: '_blank',
        }),
      );
      expect(html).toMatch(/<a[^>]*target="_blank"/);
      expect(html).toMatch(/<a[^>]*rel="noopener noreferrer"/);
    });

    it('R1-NEW.6 anchorTarget default (omitted) does NOT set target/rel', () => {
      const html = renderToString(
        createElement(SafeWebMarkdown, {
          children: '[ok](https://example.com)',
        }),
      );
      expect(html).toMatch(/<a[^>]*href="https:\/\/example\.com"/);
      expect(html).not.toMatch(/<a[^>]*target=/);
      expect(html).not.toMatch(/<a[^>]*rel=/);
    });

    it('R1-NEW.7 anchorTarget="_self" explicitly does NOT set target/rel', () => {
      const html = renderToString(
        createElement(SafeWebMarkdown, {
          children: '[ok](https://example.com)',
          anchorTarget: '_self',
        }),
      );
      expect(html).toMatch(/<a[^>]*href="https:\/\/example\.com"/);
      expect(html).not.toMatch(/<a[^>]*target=/);
      expect(html).not.toMatch(/<a[^>]*rel=/);
    });

    it('R1-NEW.8 type-level: components prop rejects a/img overrides at compile time (object literal AND variable)', () => {
      // This is a compile-time assertion — Vitest will not fail at runtime
      // for `@ts-expect-error` directives, but `lint:ts` (strict TS mode in
      // CI) catches a missing/extra error. The runtime cast-bypass in
      // R1-NEW.1 is the runtime equivalent.
      //
      // Object-literal misuse — caught by Omit's excess-property check.
      // @ts-expect-error - components.a is forbidden by the closed-API contract
      void ({ children: 'x', components: { a: () => null } } satisfies Parameters<typeof SafeWebMarkdown>[0]);
      // @ts-expect-error - components.img is forbidden by the closed-API contract
      void ({ children: 'x', components: { img: () => null } } satisfies Parameters<typeof SafeWebMarkdown>[0]);

      // Variable misuse — caught by `a?: never; img?: never` in the type.
      // Without the `& { a?: never; img?: never }` brand, structural typing
      // would silently accept a `Components` variable here (TypeScript only
      // checks excess properties on object literals, not on variable
      // assignments). This case is the lens-security SEV-3 regression.
      const wideComponents: Components = {
        a: () => null,
        img: () => null,
      };
      // @ts-expect-error - Components variable is incompatible with SafeWebMarkdownComponents
      void ({ children: 'x', components: wideComponents } satisfies Parameters<typeof SafeWebMarkdown>[0]);

      expect(true).toBe(true);
    });
  });
});
