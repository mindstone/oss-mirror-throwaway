---
description: "The markdown URL-scheme guard trust boundary — the single shared policy every react-markdown surface routes through, the twin-guard and new-surface rules, and the CI gate that keeps them aligned"
last_updated: "2026-06-13"
---

# Markdown URL-scheme guard (the XSS trust boundary)

LLM- and user-authored markdown is **untrusted input**. A `<a href="javascript:...">` or
`<img src="data:text/html,...">` that reaches the Electron renderer can execute — `will-navigate`
does **not** intercept `javascript:` URLs (verified 2026-04-23). Every markdown surface that renders
anchors or images is therefore a trust boundary, and the failure mode is **drift**: a new or forked
renderer silently skips the scheme guard that its siblings have. This doc is the standing rule set that
prevents that, and the map of where the enforcement lives.

> **Origin / threat model:** `docs-private/postmortems/260423_r1_xss_desktop_exploit_postmortem.md`
> (anchor `javascript:` exploit) and `docs-private/postmortems/260422_collapsible_section_data_image_url_drop_postmortem.md`
> (collapsed `data:image` divergence). The unification effort that built the SSOT + gate:
> `docs/plans/260607_markdown-url-guard-unification/PLAN.md`.

## Single source of truth

All scheme-safety decisions route through one shared policy, reachable from every surface via `@rebel/shared`:

- **`packages/shared/src/utils/urlSchemePolicy.ts`**
  - `classifyMarkdownUrl(url, context?)` — discriminated-union classifier (the SSOT). Categories:
    `empty`/`relative`/`hash`/`windows-drive`/`http`/`https`/`default-safe-scheme`/`library`/`workspace`/
    `rebel`/`file`/`data-image`/`protocol-relative`/`blocked-dangerous`/`unknown-scheme`.
  - `findBlockedUrlScheme(url)` — denylist verdict (`javascript:`/`blob:`/`file:`), **derived** from the
    classifier. Used by `img` and `a` render guards.
  - `createGuardedUrlTransform(fallback, preserveSchemes?)` — the react-markdown `urlTransform` that
    preserves blocked schemes long enough for the render guards to fire (log + neutralise), then delegates
    the long tail to react-markdown's `defaultUrlTransform` (allowlist → **default-deny** posture preserved).
  - `redactUrlForLogging(url)` — strips query strings before logging a blocked scheme.

**Posture: default-deny.** The safe-scheme allowlist is react-markdown's `defaultUrlTransform`, not the
3-scheme denylist. Do not flip the residual/unknown tail to default-allow (see 260607 amendment A1).

## The two standing rules

### 1. Twin-guard rule (every scheme-bearing tag is guarded)

Any consumer of `createGuardedUrlTransform` / any `react-markdown` wrapper **must install matching scheme
guards for ALL scheme-bearing tag renderers** — at minimum `img` AND `a`. The `urlTransform` deliberately
**preserves** blocked schemes so the per-tag render guard can catch them; if a wrapper installs the transform
but guards only `img` (or only `a`), the unguarded tag renders the dangerous scheme. A new scheme-bearing tag
(e.g. a future `source`/`track`) added to a wrapper's `components` map needs the same guard.

The guard shape per tag: call `findBlockedUrlScheme(href|src)` (or `classifyMarkdownUrl`), and on a blocked
scheme **log** a structured `console.warn('[Renderer] <Wrapper> <tag> blocked (dangerous scheme)', {...})`
and **neutralise** (anchor → omit `href` so it's inert; image → `<img hidden>` placeholder).

### 2. New-surface / parity rule

When you add a new markdown rendering surface, or a new `urlTransform` helper:

- Route scheme-safety through the shared SSOT (above). **Never** hand-roll a local `javascript:`/`blob:`/
  `file:` predicate — the CI gate bans named local predicates (`isBlockedSchemeLink`, etc.) and inline
  dangerous-scheme regexes.
- Add the wrapper to the ledger in `scripts/check-no-cross-file-guarded-transform-reexports.ts`
  (`MARKDOWN_WRAPPER_POLICY_FILES`), or — if it is genuinely a different trust boundary — to
  `OUT_OF_SCOPE_MARKDOWN_RENDERERS` with a `why_out_of_scope` and a **`revisit_if`** trigger.
- If one `<ReactMarkdown>` block in a module **deliberately** diverges from its siblings on guard
  installation (e.g. an intentionally inert lightweight phase render), the divergence must be either
  inherently inert (children-only anchor, no `href`, no `img`) **or** carry an inline
  `// PARITY-EXEMPT: <reason>` comment. Silent divergence fails CI.

## Where it's enforced (CI)

- **`scripts/check-no-cross-file-guarded-transform-reexports.ts`** (wired into `validate:fast` as
  `validate:no-guarded-transform-reexports`). The single markdown-surface ledger. It:
  - asserts every eslint-allowed `react-markdown` wrapper routes scheme-safety through the shared policy
    (per-wrapper required symbols + snippets);
  - asserts every `<ReactMarkdown>` block is **guarded-or-inert**, and that deliberate cross-sibling
    divergences carry a `// PARITY-EXEMPT:` marker;
  - bans local dangerous-scheme predicates and cross-file re-exports of `createGuardedUrlTransform`.
- **ESLint** `no-restricted-imports` keeps `react-markdown` imports out of non-wrapper files (the allow-list
  in `eslint.config.mjs`), so a bespoke unguarded pipeline has nowhere to live.

This is a **source-text tripwire / residual floor**, not a true by-construction guarantee — a Level-2
`SafeAnchor`/`SafeImg` chokepoint that makes an unguarded anchor *unrepresentable* was consciously deferred
(MessageMarkdown's anchor renderer is too routing-rich today). The gate is the mechanical backstop.

## The covered surfaces (today)

| Wrapper | File | Notes |
|---|---|---|
| SafeMarkdown | `src/renderer/components/SafeMarkdown.tsx` | Closed API (no `components` prop). Desktop reader. |
| MessageMarkdown | `src/renderer/components/MessageMarkdown.tsx` | Desktop chat; rich nav routing; main + collapsed (`CollapsibleSection`) + two lightweight phase renders. |
| WhatsNewDialog | `src/renderer/components/WhatsNewDialog.tsx` | Release notes (trusted-today, guarded anyway). |
| SafeWebMarkdown | `web-companion/src/components/SafeWebMarkdown.tsx` | Web companion (separate workspace). |

Out of scope (different library / trust boundary), see `OUT_OF_SCOPE_MARKDOWN_RENDERERS`: the mobile
`react-native-markdown-display` surfaces and `MediaEmbed` (http(s)-only).

## See also

- `docs/project/SAFETY_SYSTEM_OVERVIEW.md` — the broader safety system this boundary sits inside.
- `docs/project/CODING_PRINCIPLES.md` § Security and privacy.
- `docs/plans/260607_markdown-url-guard-unification/PLAN.md` — the unification design + amendments.
- `docs-private/postmortems/260423_r1_xss_desktop_exploit_postmortem.md`,
  `…/260422_collapsible_section_data_image_url_drop_postmortem.md`,
  `…/260416_messagemarkdown_rules_of_hooks_crash_postmortem.md` — the incidents.
