// ---------------------------------------------------------------------------
// SafeMarkdown — closed-API security boundary (desktop)
// ---------------------------------------------------------------------------
// Public API: { children, className? } only. There is intentionally NO
// `components` prop — desktop callers cannot override the security-critical
// `a` / `img` renderers. This is the structural counterpart to the closed
// `SafeWebMarkdown` API. If a future caller needs anchor click dispatch,
// add an `onAnchorClick` prop following the SafeWebMarkdown pattern — do
// NOT reopen `components`.
//
// See `docs/plans/260427_r1_stage2b_factory_refactor.md` for the design
// rationale and `docs-private/postmortems/260423_r1_xss_desktop_exploit_postmortem.md`
// for the threat model.
//
// ESLINT-ALLOW-LIST NOTE: This file is on the allow-list in eslint.config.mjs
// for @typescript-eslint/no-restricted-imports (react-markdown). If you
// rename this file, update the allow-list there.
// ---------------------------------------------------------------------------
import { memo, useMemo } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import {
  preprocessMarkdownForRender,
  findBlockedUrlScheme,
  redactUrlForLogging,
  createGuardedUrlTransform,
} from '@rebel/shared';

// Preserve blocked schemes long enough for the img guard below to fire and
// log; all other URLs still go through react-markdown's default allowlist.
// See createGuardedUrlTransform doc for rationale.
const guardedUrlTransform = createGuardedUrlTransform(defaultUrlTransform);

interface SafeMarkdownProps {
  children: string;
  className?: string;
  /**
   * Render single newlines as visible line breaks (soft break → `<br>`, via
   * `remark-breaks`). Off by default so chat keeps CommonMark behaviour. Opt in
   * for authored-document surfaces (e.g. the document-draft preview) where the
   * source uses single newlines as intentional breaks (Slack/email-style drafts).
   * This is purely a remark-parse setting — it does NOT reopen the closed
   * `components`/URL security surface above.
   */
  breaks?: boolean;
}

export const SafeMarkdown = memo(({ children, className = 'markdown-body', breaks = false }: SafeMarkdownProps) => {
  const { source, remarkPlugins } = useMemo(
    () =>
      preprocessMarkdownForRender(children, breaks ? { additionalPlugins: [remarkBreaks] } : undefined),
    [children, breaks],
  );

  return (
    <div className={className}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        urlTransform={guardedUrlTransform}
        components={{
          table: ({ children }) => (
            <div className="markdown-table-wrapper">
              <table>{children}</table>
            </div>
          ),
          a: ({ href, title, children }) => {
            // Security boundary — do not remove. LLM-emitted markdown can produce
            // `<a href="javascript:...">` which executes on click in the Electron
            // renderer (will-navigate does NOT intercept; verified 2026-04-23).
            // See docs/plans/260423_r1_xss_deferred_finding.md §12.
            const blockedScheme = findBlockedUrlScheme(href);
            if (blockedScheme) {
              console.warn('[Renderer] SafeMarkdown a blocked (dangerous scheme)', {
                scheme: blockedScheme,
                href: redactUrlForLogging(href),
              });
              // Omit href entirely so the neutralized link is inert (no scroll,
              // no navigation) rather than misleadingly clickable.
              return <a>{children}</a>;
            }
            return <a href={href} title={title}>{children}</a>;
          },
          img: ({ src, alt }) => {
            // Defence-in-depth: react-markdown's default urlTransform already blanks
            // dangerous schemes; this guard fires only if that default is bypassed.
            const blockedScheme = findBlockedUrlScheme(src);
            if (blockedScheme) {
              console.warn('[Renderer] SafeMarkdown img blocked (dangerous scheme)', {
                scheme: blockedScheme,
                src: redactUrlForLogging(src),
              });
              return <img hidden alt={alt || 'Blocked image'} />;
            }
            return <img src={src} alt={alt} style={{ maxWidth: '100%', borderRadius: '8px' }} />;
          },
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
});

SafeMarkdown.displayName = 'SafeMarkdown';
