/**
 * Branded wire-format type for the composer's markdown surface.
 *
 * The brand encodes the invariant "this string went through the override-enabled
 * serialisation path AND the corrupted-draft sanitiser" (see Stage 1 of
 * `docs/plans/260501_composer_tiptap_atmention_bugfix.md`). Sanctioned
 * producers of the brand are:
 *   - `getCurrentPromptMarkdown(editor)` (wrapper around `editor.getMarkdown()`)
 *   - `docToMarkdown(doc)` (the local serialiser used by tests + `markdownToDoc`'s
 *     round-trip pair)
 *   - `toComposerWireMarkdown(input)` (this module — the single sanctioned path
 *     for minting the brand from arbitrary external strings; routes through
 *     `sanitiseCorruptedDraftText`).
 *
 * Consumers that take untrusted strings (drafts, edit-rerun bodies) must mint
 * the brand via `toComposerWireMarkdown` at the ingress boundary so the
 * two-context sanitisation invariant is enforced once, structurally, instead
 * of at every internal callsite. Direct casts (`x as ComposerWireMarkdown`)
 * are forbidden outside the sanctioned producers — see the
 * `composerBrandCastGuardSelectors` rule in `eslint.config.mjs`.
 *
 * S1 from the planning doc.
 */

import { sanitiseCorruptedDraftText } from './draftSanitisation';

export type ComposerWireMarkdown = string & { readonly __brand: 'ComposerWireMarkdown' };

/**
 * Mint a `ComposerWireMarkdown` value from an arbitrary string by routing
 * through the canonical NBSP-family sanitiser (`sanitiseCorruptedDraftText`).
 *
 * This is the ONLY sanctioned way to brand an external string as composer
 * wire markdown. External ingress paths — legacy localStorage draft restore,
 * persisted-session draft rehydrate, the imperative `composerRef.setText`
 * family, and App-level `composerRef.current?.setText(...)` callers — must
 * route through this constructor so corrupted `&nbsp;`-bearing inputs are
 * cleaned at the boundary, never inside the keystroke hot path.
 *
 * The implementation is pure and idempotent: applying twice yields the same
 * result as applying once (`sanitiseCorruptedDraftText` is idempotent and
 * this function adds no behaviour beyond the cast).
 *
 * Allowlisted by the `composerBrandCastGuardSelectors` ESLint rule via
 * a per-file override; do NOT add other cast sites.
 */
export function toComposerWireMarkdown(input: string): ComposerWireMarkdown {
  // eslint-disable-next-line no-restricted-syntax -- sanctioned brand constructor; the cast site is intentional and centralised here.
  return sanitiseCorruptedDraftText(input) as ComposerWireMarkdown;
}
