/**
 * Composer snapshot cache — module-level two-layer cache for the keystroke hot path.
 *
 * Stage 1.5 of `docs/plans/260501_composer_tiptap_atmention_bugfix.md` — C1
 * 90%-push amendment, two-layer split for caret correctness. See
 * `composerSnapshotTypes.ts` for the rationale.
 *
 * Layer A is a `WeakMap<ProseMirrorNode, ComposerLayerASnapshot>` keyed on
 * `editor.state.doc` identity. Selection-only transactions reuse the same doc
 * reference, so the cache hit rate on the keystroke path approaches 100%
 * outside of the keystroke that mutated the doc itself. The WeakMap is
 * GC-bound — old doc nodes are reclaimed automatically as ProseMirror produces
 * new ones, so no manual eviction or subscription/effect/cleanup is required.
 *
 * Layer B (`getCaretMarkdownIndex`) is computed per-call from
 * `editor.state.selection.from` against the cached markdown — `pmPosToMarkdownIndex`
 * over the cached `docJson`, no full re-serialise.
 *
 * Both `getCurrentPromptMarkdown(editor)` (the non-hook wrapper used by
 * `TipTapPromptEditor`'s commandInputRef shim and tests) and the
 * `usePromptEditorSnapshot(editor)` React hook share THIS module-level cache —
 * the cache must NOT be component-state because multiple readers per
 * transaction (the imperative handle, the textarea-shim getters, the
 * `onUpdate` and `onSelectionUpdate` handlers, the parent debounced flush)
 * would otherwise each pay the serialise cost.
 */

import type { Editor } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { ComposerWireMarkdown } from './composerMarkdown';
import { pmPosToMarkdownIndex } from './promptDoc';
import type { ComposerLayerASnapshot, ComposerSnapshot } from './composerSnapshotTypes';

/**
 * Layer A storage. Encapsulated at module scope so it is shared across all
 * readers (production component, hook consumers, tests). Not exported — every
 * read goes through `getLayerASnapshot()` so we can change the storage shape
 * later without breaking call sites.
 */
const layerACache = new WeakMap<ProseMirrorNode, ComposerLayerASnapshot>();

/**
 * Layer A — doc-derived snapshot, cached on `editor.state.doc` identity.
 *
 * On cache hit (selection-only transactions, no doc mutation), returns the
 * same `{ docJson, markdown }` reference — empirically validated by the
 * integration spike (`integration-spike.spike.test.ts`) and pinned by the
 * Stage 1.5 contract test rows.
 *
 * On cache miss (first call after a doc-mutating transaction, or first call
 * after editor mount), computes a fresh entry by walking the doc via
 * `editor.getJSON()` and `editor.getMarkdown()` — both are doc-derived O(n)
 * walks, so we do them at most ONCE per doc identity.
 */
export function getLayerASnapshot(editor: Editor): ComposerLayerASnapshot {
  const doc = editor.state.doc;
  const cached = layerACache.get(doc);
  if (cached) return cached;
  const docJson = editor.getJSON();
  // Stage 8 of `docs/plans/260501_composer_tiptap_atmention_bugfix.md` —
  // sole audited entry point for `editor.getMarkdown()` in the composer
  // feature. The `getCurrentPromptMarkdown(editor)` wrapper in
  // `TipTapPromptEditor.tsx` routes here and brands the result as
  // `ComposerWireMarkdown`. The composer-scoped `no-restricted-syntax`
  // lint guard forbids direct `.getMarkdown()` calls anywhere else;
  // this per-line disable is the only sanctioned bypass.
  // eslint-disable-next-line no-restricted-syntax -- audited wrapper for editor.getMarkdown() and sanctioned ComposerWireMarkdown brand site; see plan 260501_composer_tiptap_atmention_bugfix.md Stage 8 + investigation 260505_composer_nbsp_recurrence.md Stage 5
  const markdown = editor.getMarkdown() as ComposerWireMarkdown;
  const fresh: ComposerLayerASnapshot = { docJson, markdown };
  layerACache.set(doc, fresh);
  return fresh;
}

/**
 * Layer B — caret index in the markdown string at call time.
 *
 * Reads `editor.state.selection.from` (cheap; just a number) and walks the
 * cached `docJson` from Layer A via `pmPosToMarkdownIndex`. NEVER cached on
 * doc identity — selection changes don't bump the doc reference, so a
 * doc-keyed cache would return stale caret indices.
 */
export function getCaretMarkdownIndex(editor: Editor): number {
  const layerA = getLayerASnapshot(editor);
  return pmPosToMarkdownIndex(layerA.docJson, editor.state.selection.from);
}

/**
 * Convenience: full snapshot combining Layer A (cached) + Layer B (per-call).
 */
export function getComposerSnapshot(editor: Editor): ComposerSnapshot {
  const layerA = getLayerASnapshot(editor);
  return {
    ...layerA,
    caretMarkdownIndex: pmPosToMarkdownIndex(layerA.docJson, editor.state.selection.from),
  };
}
