// ---------------------------------------------------------------------------
// SafeWebMarkdown — closed-API security boundary
// ---------------------------------------------------------------------------
// CLOSED-API CONTRACT (R1 Stage 2b, 2026-04-27):
// - `components` prop is `Omit<Components, 'a' | 'img'>` — callers CANNOT
//   override the security-critical anchor or image renderers.
// - At runtime the wrapper's safe `a` / `img` are spread AFTER caller
//   `components`, so `as unknown as Components` casts at the call site are
//   ALSO neutralised by property-order semantics (defense-in-depth).
// - `preserveSchemes` is a literal tuple `readonly ['rebel://']` AND
//   runtime-validated against `ALLOWED_PRESERVE_SCHEMES`. Casts to a wider
//   type are neutralised by the runtime allowlist.
// - Anchor click dispatch is exposed via `onAnchorClick`, which fires ONLY
//   on the safe branch (after the guard passes). Blocked-scheme anchors
//   fail closed: no caller hook fires, no caller component is invoked.
// - `anchorTarget` opt-in prop controls `target` / `rel` on the safe-branch
//   anchor (defaults to `_self`; pass `_blank` for new-tab UX).
//
// See `docs/plans/260427_r1_stage2b_factory_refactor.md` for the design
// rationale and `docs-private/postmortems/260423_r1_xss_desktop_exploit_postmortem.md`
// for the threat model that motivated the closure.
//
// ESLINT-ALLOW-LIST NOTE: This file is on the allow-list in eslint.config.mjs
// for @typescript-eslint/no-restricted-imports (react-markdown). If you
// rename this file, update the allow-list there.
// ---------------------------------------------------------------------------
import { memo, useMemo, type MouseEvent } from 'react';
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
import {
  preprocessMarkdownForRender,
  findBlockedUrlScheme,
  redactUrlForLogging,
  createGuardedUrlTransform,
} from '@rebel/shared';

// Default (no preserveSchemes): preserve blocked schemes long enough for the
// img guard below to fire and log; all other URLs go through react-markdown's
// default allowlist. See createGuardedUrlTransform doc for rationale.
const defaultGuardedUrlTransform = createGuardedUrlTransform(defaultUrlTransform);

/**
 * Runtime allowlist for the `preserveSchemes` prop.
 *
 * The TypeScript type `readonly ['rebel://']` rejects other values at compile
 * time, but a future caller could (intentionally or accidentally) cast past
 * the type via `as unknown as readonly ['rebel://']` or `as any`. This
 * runtime allowlist is the defense-in-depth fallback: anything not in this
 * tuple is dropped before reaching `createGuardedUrlTransform`, with a
 * structured log so the misuse is observable.
 *
 * Adding a scheme here MUST be accompanied by widening the
 * `SafeWebMarkdownProps.preserveSchemes` type below — keep them in sync.
 */
const ALLOWED_PRESERVE_SCHEMES = ['rebel://'] as const;

/**
 * Component overrides for non-security-critical renderers.
 *
 * Why this type and not just `Omit<Components, 'a' | 'img'>`?
 * Structural typing means an `Omit<>` type allows variables of the wider
 * type (e.g. `const x: Components = ...; <SafeWebMarkdown components={x} />`)
 * to pass through silently — TypeScript only catches the "excess" property
 * case on object literals. Adding `a?: never; img?: never` forces the
 * incompatibility at the property level: a `Components` variable, which
 * has `a: ComponentType`, fails to assign to `a?: never` because a
 * function is not `never`. This makes BOTH object-literal AND variable
 * misuse trip the type checker.
 */
type SafeWebMarkdownComponents = Omit<Components, 'a' | 'img'> & {
  a?: never;
  img?: never;
};

interface SafeWebMarkdownProps {
  children: string;
  /**
   * Component overrides for non-security-critical renderers. The `a` and `img`
   * renderers are NOT overridable (closed-API contract). Use `onAnchorClick`
   * for click dispatch; the wrapper handles `<a>` / `<img>` rendering.
   */
  components?: SafeWebMarkdownComponents;
  /**
   * Optional scheme prefixes to preserve past the default urlTransform so
   * downstream anchor click handlers can route them. Currently locked to
   * `['rebel://']` at the type level AND at runtime (allowlist). To add a
   * new scheme: widen both `ALLOWED_PRESERVE_SCHEMES` and this type.
   */
  preserveSchemes?: readonly ['rebel://'];
  /**
   * Fires only on safe-branch anchor click — never on blocked-scheme anchors
   * (fail-closed). Use this instead of `components.a` to wire click
   * dispatch (e.g. routing `rebel://` schemes); the wrapper renders the
   * underlying `<a>` element.
   */
  onAnchorClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
  /**
   * Optional target attribute on safe-branch anchors. When `'_blank'`, the
   * anchor renders with `target="_blank" rel="noopener noreferrer"`. When
   * `'_self'` (default) or omitted, no target/rel is set. The two SharedX
   * screens default to `_self` (preserves current behavior); ConversationScreen
   * passes `_blank` (matches the previous `components.a` override behavior).
   */
  anchorTarget?: '_blank' | '_self';
}

export const SafeWebMarkdown = memo(
  ({
    children,
    components,
    preserveSchemes,
    onAnchorClick,
    anchorTarget = '_self',
  }: SafeWebMarkdownProps) => {
    const { source, remarkPlugins } = useMemo(
      () => preprocessMarkdownForRender(children),
      [children],
    );

    // Runtime allowlist filter. Even if a caller bypasses the literal-tuple
    // type via `as unknown as readonly ['rebel://']`, anything not in
    // ALLOWED_PRESERVE_SCHEMES is dropped here (with an observable warn).
    // The literal-tuple type guarantees at compile time that this array, if
    // present, has exactly one element ('rebel://'); the runtime loop is
    // defense-in-depth against `as unknown as ...` casts that smuggle a
    // wider array through.
    const filteredPreserveSchemes = useMemo(() => {
      if (!preserveSchemes) return undefined;
      // Treat as a wider type at runtime so we can iterate safely even if a
      // cast-bypass smuggled through entries other than 'rebel://'.
      const incoming = preserveSchemes as unknown as readonly string[];
      const allowed: string[] = [];
      for (const scheme of incoming) {
        if ((ALLOWED_PRESERVE_SCHEMES as readonly string[]).includes(scheme)) {
          allowed.push(scheme);
        } else {
          console.warn(
            '[web-companion] SafeWebMarkdown dropping preserveSchemes entry not in allowlist',
            { scheme: redactUrlForLogging(scheme) },
          );
        }
      }
      return allowed.length > 0 ? allowed : undefined;
    }, [preserveSchemes]);

    // Stabilise the urlTransform per-preserveSchemes identity so react-markdown
    // doesn't treat it as a new transform on every render.
    const urlTransform = useMemo(() => {
      if (!filteredPreserveSchemes) return defaultGuardedUrlTransform;
      return createGuardedUrlTransform(defaultUrlTransform, filteredPreserveSchemes);
    }, [filteredPreserveSchemes]);

    // Defense-in-depth runtime override: spread caller `components` FIRST,
    // then assign safe `a` / `img`. This way, even if a caller bypasses the
    // `Omit<Components, 'a' | 'img'>` constraint via an `as unknown as
    // Components` cast, our renderers win via property-order semantics.
    const mergedComponents = useMemo<Components>(
      () => ({
        ...(components as Components | undefined),
        a: ({ href, title, children: anchorChildren }) => {
          const blockedScheme = findBlockedUrlScheme(href);
          if (blockedScheme) {
            console.warn(
              '[web-companion] SafeWebMarkdown a blocked (dangerous scheme)',
              {
                scheme: blockedScheme,
                href: redactUrlForLogging(href),
              },
            );
            // Omit href entirely so the neutralized link is inert (no scroll,
            // no navigation). Fail-closed — no caller hook fires.
            return <a>{anchorChildren}</a>;
          }
          // Safe branch: render the anchor + (optionally) wire click dispatch
          // and target/rel.
          const targetProps =
            anchorTarget === '_blank'
              ? ({ target: '_blank', rel: 'noopener noreferrer' } as const)
              : {};
          return (
            <a href={href} title={title} {...targetProps} onClick={onAnchorClick}>
              {anchorChildren}
            </a>
          );
        },
        img: ({ src, alt }) => {
          const blockedScheme = findBlockedUrlScheme(src);
          if (blockedScheme) {
            console.warn(
              '[web-companion] SafeWebMarkdown img blocked (dangerous scheme)',
              {
                scheme: blockedScheme,
                src: redactUrlForLogging(src),
              },
            );
            return <img hidden alt={alt || 'Blocked image'} />;
          }
          return <img src={src} alt={alt} />;
        },
      }),
      [components, onAnchorClick, anchorTarget],
    );

    return (
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        urlTransform={urlTransform}
        components={mergedComponents}
      >
        {source}
      </ReactMarkdown>
    );
  },
);

SafeWebMarkdown.displayName = 'SafeWebMarkdown';
