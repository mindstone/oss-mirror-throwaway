/**
 * Composer snapshot types — two-layer split (Stage 1.5, post-spike GPT-High amendment).
 *
 * The keystroke hot path serialises markdown via `editor.getMarkdown()` and walks
 * the doc again via `editor.getJSON()` for caret-index translation; both are O(n)
 * over the doc. Naively caching `{ docJson, markdown, caretMarkdownIndex }` keyed
 * on `editor.state.doc` identity would return STALE caret indices on
 * selection-only transactions (the doc reference is stable, but `selection.from`
 * changes) — a caret-correctness footgun the 90%-push critique flagged (C1).
 *
 * The fix is the explicit two-layer split:
 *
 *   - Layer A (`ComposerLayerASnapshot`) — doc-derived. Stable across
 *     selection-only transactions. Invalidated only when `editor.state.doc`
 *     identity changes (i.e. doc-mutating transactions).
 *
 *   - Layer B (caret-derived) — computed per-call from
 *     `editor.state.selection.from` against the cached `markdown`. Cheap because
 *     the markdown is already in hand from Layer A.
 *
 * `ComposerSnapshot` is the convenience union of both.
 *
 * See `docs/plans/260501_composer_tiptap_atmention_bugfix.md`, Stage 1.5.
 */

import type { JSONContent } from '@tiptap/core';
import type { ComposerWireMarkdown } from './composerMarkdown';

export interface ComposerLayerASnapshot {
  /** doc-derived: stable across selection-only transactions, invalidated on doc mutation. */
  docJson: JSONContent;
  markdown: ComposerWireMarkdown;
}

export interface ComposerSnapshot extends ComposerLayerASnapshot {
  /** Layer B: caret index in the markdown string at call time. */
  caretMarkdownIndex: number;
}
