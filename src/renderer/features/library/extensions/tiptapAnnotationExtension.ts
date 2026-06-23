/**
 * TipTap/ProseMirror extension for inline text annotations.
 *
 * Provides position-tracked highlighting that survives document edits.
 * This is the TipTap equivalent of the CodeMirror annotationExtension.ts.
 *
 * Annotations are UI state (stored in plugin state, not document content)
 * and are NOT undoable via ProseMirror's history.
 */

import { Extension } from '@tiptap/core';
import { Plugin, PluginKey, Transaction } from '@tiptap/pm/state';
import type { EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet, EditorView } from '@tiptap/pm/view';
import { generateAnnotationId, type BaseAnnotation } from '@rebel/shared';

// ============================================================================
// Types
// ============================================================================

export interface Annotation extends BaseAnnotation {
  from: number;
  to: number;
}

export interface AnnotationRange {
  from: number;
  to: number;
}

// ============================================================================
// Plugin Key
// ============================================================================

export const annotationPluginKey = new PluginKey<AnnotationPluginState>('tiptap-annotations');

// ============================================================================
// Plugin State
// ============================================================================

interface AnnotationPluginState {
  annotations: Map<string, Annotation>;
  decorations: DecorationSet;
}

// ============================================================================
// Meta Types for Transaction Effects
// ============================================================================

// We use transaction metadata instead of StateEffects (which are CodeMirror-specific)
export type AnnotationMeta =
  | { type: 'add'; annotation: Annotation }
  | { type: 'remove'; id: string }
  | { type: 'update'; id: string; comment: string }
  | { type: 'clear' }
  | { type: 'clearIds'; ids: string[] }
  | { type: 'load'; annotations: Annotation[] };

// ============================================================================
// Errors
// ============================================================================

/**
 * Kept for backwards-compatible caller type guards. Annotation dispatch now
 * treats unmounted editors as a no-op because delayed clean-up after unmount is
 * expected and should not create noisy Sentry events.
 */
export class EditorUnmountedError extends Error {
  constructor(message = 'Editor has been unmounted; annotation dispatch aborted.') {
    super(message);
    this.name = 'EditorUnmountedError';
  }
}

/**
 * Returns false if the given `EditorView` is no longer attached to a live
 * editor. Uses the same twin signal —
 * `view.isDestroyed` and a `view.dom` property probe — that
 * `useTipTapAnnotations.getEditorView` relies on for its pre-mount
 * proxy safety check.
 */
function isEditorAlive(view: EditorView): boolean {
  // `isDestroyed` is set to true once `view.destroy()` runs.
  if ((view as { isDestroyed?: boolean }).isDestroyed === true) {
    return false;
  }
  try {
    // TipTap v3's pre-mount proxy throws on property access; a destroyed
    // view also has a nulled-out `dom` in some code paths. Either signal
    // means "do not dispatch".
    return Boolean(view.dom);
  } catch {
    return false;
  }
}

// ============================================================================
// Decoration
// ============================================================================

const HIGHLIGHT_CLASS = 'tiptap-annotation-highlight';

function createAnnotationDecoration(from: number, to: number, id: string): Decoration {
  return Decoration.inline(from, to, {
    class: HIGHLIGHT_CLASS,
    'data-annotation-id': id,
    style: 'background-color: rgba(99, 102, 241, 0.25); border-bottom: 2px solid #6366f1;',
  });
}

// ============================================================================
// Position Mapping
// ============================================================================

/**
 * Maps an annotation's range through document changes.
 * Returns undefined if the range becomes invalid (empty or inverted).
 */
function mapAnnotationRange(
  annotation: Annotation,
  mapping: Transaction['mapping']
): AnnotationRange | undefined {
  // Use assoc=1 for 'from' (stick to right side of insertions)
  // Use assoc=-1 for 'to' (stick to left side of insertions)
  const from = mapping.map(annotation.from, 1);
  const to = mapping.map(annotation.to, -1);

  // If range collapsed or inverted, annotation is invalid
  return from < to ? { from, to } : undefined;
}

// ============================================================================
// Build Decorations
// ============================================================================

function buildDecorations(
  annotations: Map<string, Annotation>,
  doc: { nodeSize: number }
): DecorationSet {
  const decorations: Decoration[] = [];

  for (const ann of annotations.values()) {
    // Validate positions are within document bounds
    // ProseMirror docs have nodeSize, valid positions are 0 to nodeSize - 2
    const maxPos = doc.nodeSize - 2;
    if (ann.from >= 0 && ann.to <= maxPos && ann.from < ann.to) {
      decorations.push(createAnnotationDecoration(ann.from, ann.to, ann.id));
    }
  }

  // DecorationSet.create requires sorted decorations
  decorations.sort((a, b) => a.from - b.from || a.to - b.to);

  return DecorationSet.create(doc as Parameters<typeof DecorationSet.create>[0], decorations);
}

// ============================================================================
// Plugin
// ============================================================================

function createAnnotationPlugin(options?: {
  onAnnotationClick?: (annotation: Annotation, coords: { left: number; top: number; bottom: number }) => void;
}): Plugin<AnnotationPluginState> {
  return new Plugin<AnnotationPluginState>({
    key: annotationPluginKey,

    state: {
      init(): AnnotationPluginState {
        return {
          annotations: new Map(),
          decorations: DecorationSet.empty,
        };
      },

      apply(tr, state, _oldState, newState): AnnotationPluginState {
        let { annotations, decorations } = state;
        let changed = false;

        // First, map existing positions through document changes
        if (tr.docChanged) {
          const newAnnotations = new Map<string, Annotation>();

          for (const [id, ann] of annotations) {
            const mapped = mapAnnotationRange(ann, tr.mapping);
            if (mapped) {
              newAnnotations.set(id, { ...ann, ...mapped });
            }
            // If mapped is undefined, the annotation's range became invalid - remove it
          }

          if (newAnnotations.size !== annotations.size) {
            changed = true;
          } else {
            // Check if any positions changed
            for (const [id, ann] of newAnnotations) {
              const old = annotations.get(id);
              if (!old || old.from !== ann.from || old.to !== ann.to) {
                changed = true;
                break;
              }
            }
          }

          annotations = newAnnotations;
          // Map decorations through changes
          decorations = decorations.map(tr.mapping, tr.doc);
        }

        // Process annotation metadata (our effects)
        const meta = tr.getMeta(annotationPluginKey) as AnnotationMeta | undefined;

        if (meta) {
          switch (meta.type) {
            case 'add': {
              const ann = meta.annotation;
              const maxPos = newState.doc.nodeSize - 2;
              if (ann.from >= 0 && ann.to <= maxPos && ann.from < ann.to) {
                annotations = new Map(annotations);
                annotations.set(ann.id, ann);
                changed = true;
              }
              break;
            }
            case 'remove': {
              if (annotations.has(meta.id)) {
                annotations = new Map(annotations);
                annotations.delete(meta.id);
                changed = true;
              }
              break;
            }
            case 'update': {
              const existing = annotations.get(meta.id);
              if (existing) {
                annotations = new Map(annotations);
                annotations.set(meta.id, {
                  ...existing,
                  comment: meta.comment,
                });
                changed = true;
              }
              break;
            }
            case 'clear': {
              if (annotations.size > 0) {
                annotations = new Map();
                changed = true;
              }
              break;
            }
            case 'clearIds': {
              // Scoped clear: delete only the annotations whose ids are in
              // the provided list. Used by "Send to Rebel" to clear exactly
              // the staged annotations (snapshot at Send time) and leave
              // post-staging annotations intact. IDs that no longer exist
              // are silently ignored — stale snapshots after user-initiated
              // removal are a valid input.
              if (meta.ids.length > 0 && annotations.size > 0) {
                let mutated: Map<string, Annotation> | null = null;
                for (const id of meta.ids) {
                  if (annotations.has(id)) {
                    if (!mutated) {
                      mutated = new Map(annotations);
                    }
                    mutated.delete(id);
                  }
                }
                if (mutated) {
                  annotations = mutated;
                  changed = true;
                }
              }
              break;
            }
            case 'load': {
              // Clear and load new annotations
              annotations = new Map();
              const maxPos = newState.doc.nodeSize - 2;
              for (const ann of meta.annotations) {
                if (ann.from >= 0 && ann.to <= maxPos && ann.from < ann.to) {
                  annotations.set(ann.id, ann);
                }
              }
              changed = true;
              break;
            }
          }
        }

        // Rebuild decorations if annotations changed
        if (changed) {
          decorations = buildDecorations(annotations, newState.doc);
        }

        return changed ? { annotations, decorations } : state;
      },
    },

    props: {
      decorations(state) {
        const pluginState = annotationPluginKey.getState(state);
        return pluginState?.decorations ?? DecorationSet.empty;
      },

      handleClick(view, pos, event) {
        if (!options?.onAnnotationClick) return false;

        const pluginState = annotationPluginKey.getState(view.state);
        if (!pluginState) return false;

        // Check if click is within any annotation
        for (const ann of pluginState.annotations.values()) {
          if (pos >= ann.from && pos <= ann.to) {
            const coords = view.coordsAtPos(ann.from);
            options.onAnnotationClick(ann, {
              left: coords.left,
              top: coords.top,
              bottom: coords.bottom,
            });
            // Prevent selection change
            event.preventDefault();
            return true;
          }
        }

        return false;
      },
    },
  });
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Gets all annotations from the editor state.
 */
export function getAnnotations(state: EditorState): Annotation[] {
  const pluginState = annotationPluginKey.getState(state);
  return pluginState ? Array.from(pluginState.annotations.values()) : [];
}

/**
 * Checks if any annotations exist.
 */
export function hasAnnotations(state: EditorState): boolean {
  const pluginState = annotationPluginKey.getState(state);
  return pluginState ? pluginState.annotations.size > 0 : false;
}

/**
 * Dispatches an annotation add transaction.
 * Returns the generated annotation ID.
 *
 * ID generation is delegated to `generateAnnotationId` in
 * `@rebel/shared` so the two annotation systems share a single source
 * of truth for the opaque identifier format.
 */
export function dispatchAddAnnotation(
  view: EditorView,
  annotation: Omit<Annotation, 'id' | 'createdAt'>
): string {
  const id = generateAnnotationId();
  const fullAnnotation: Annotation = {
    ...annotation,
    id,
    createdAt: Date.now(),
  };

  if (!isEditorAlive(view)) return id;

  const tr = view.state.tr.setMeta(annotationPluginKey, {
    type: 'add',
    annotation: fullAnnotation,
  } as AnnotationMeta);

  view.dispatch(tr);
  return id;
}

/**
 * Dispatches an annotation remove transaction.
 */
export function dispatchRemoveAnnotation(view: EditorView, id: string): void {
  if (!isEditorAlive(view)) return;

  const tr = view.state.tr.setMeta(annotationPluginKey, {
    type: 'remove',
    id,
  } as AnnotationMeta);

  view.dispatch(tr);
}

/**
 * Dispatches an annotation comment update transaction.
 */
export function dispatchUpdateComment(view: EditorView, id: string, comment: string): void {
  if (!isEditorAlive(view)) return;

  const tr = view.state.tr.setMeta(annotationPluginKey, {
    type: 'update',
    id,
    comment,
  } as AnnotationMeta);

  view.dispatch(tr);
}

/**
 * Dispatches a clear all annotations transaction.
 * No-ops if the editor has already unmounted.
 */
export function dispatchClearAnnotations(view: EditorView): void {
  if (!isEditorAlive(view)) return;

  const tr = view.state.tr.setMeta(annotationPluginKey, {
    type: 'clear',
  } as AnnotationMeta);

  view.dispatch(tr);
}

/**
 * Dispatches a scoped clear transaction that removes only the
 * annotations whose ids are in {@link ids}. The empty-array case is a
 * no-op — callers snapshotting staged annotations at "Send to Rebel"
 * may legitimately end up with an empty list (e.g. user removed every
 * staged annotation before dispatch) and we do not want to fall
 * through to the unscoped `clear` variant that would wipe
 * post-staging annotations too.
 * No-ops if the editor has already unmounted.
 */
export function dispatchClearStagedAnnotations(view: EditorView, ids: string[]): void {
  if (!isEditorAlive(view)) return;

  if (ids.length === 0) {
    // No-op: explicit snapshot of "nothing to clear".
    return;
  }

  const tr = view.state.tr.setMeta(annotationPluginKey, {
    type: 'clearIds',
    ids,
  } as AnnotationMeta);

  view.dispatch(tr);
}

/**
 * Dispatches a load annotations transaction.
 */
export function dispatchLoadAnnotations(view: EditorView, annotations: Annotation[]): void {
  if (!isEditorAlive(view)) return;

  const tr = view.state.tr.setMeta(annotationPluginKey, {
    type: 'load',
    annotations,
  } as AnnotationMeta);

  view.dispatch(tr);
}

// ============================================================================
// ProseMirror-aware text search (for annotation position recovery)
// ============================================================================

/**
 * Finds the ProseMirror positions of a text snippet within a ProseMirror document.
 *
 * Unlike raw-string `indexOf`, this returns native PM positions that account for
 * node boundaries, so recovered annotations highlight the correct text.
 *
 * When `hintOffset` is provided and the text appears more than once in the
 * document, the occurrence whose PM `from` position is closest to the hint is
 * returned.  This disambiguates annotations on duplicate passages.
 */
export function findTextInDoc(
  doc: Parameters<typeof DecorationSet.create>[0],
  searchText: string,
  hintOffset?: number,
): { from: number; to: number } | null {
  // Build a flat text string and a parallel array mapping each character
  // index back to its ProseMirror position.
  // Inserts a space between text runs that are separated by block boundaries
  // to match ProseMirror's textBetween(from, to, ' ') behavior.
  const pmPositions: number[] = [];
  const chars: string[] = [];
  let lastTextEnd = -1;

  doc.descendants((node: { isText: boolean; text?: string | null }, pos: number) => {
    if (node.isText && node.text) {
      if (lastTextEnd >= 0 && pos > lastTextEnd) {
        chars.push(' ');
        pmPositions.push(lastTextEnd);
      }
      for (let i = 0; i < node.text.length; i++) {
        chars.push(node.text[i]);
        pmPositions.push(pos + i);
      }
      lastTextEnd = pos + node.text.length;
    }
    return true;
  });

  const flatText = chars.join('');

  // --- Exact match (collect all occurrences when hint is present) ----------
  const exactMatches: { from: number; to: number }[] = [];
  let searchFrom = 0;
  while (true) {
    const idx = flatText.indexOf(searchText, searchFrom);
    if (idx === -1 || idx + searchText.length > pmPositions.length) break;
    exactMatches.push({
      from: pmPositions[idx],
      to: pmPositions[idx + searchText.length - 1] + 1,
    });
    if (hintOffset == null) break; // no hint — first match is fine
    searchFrom = idx + 1;
  }

  if (exactMatches.length > 0) {
    if (hintOffset == null || exactMatches.length === 1) return exactMatches[0];
    return closestMatch(exactMatches, hintOffset);
  }

  // --- Normalized match (collapse whitespace) ------------------------------
  const normSearch = searchText.replace(/\s+/g, ' ').trim();
  if (!normSearch) return null;

  const normToFlat: number[] = [];
  let normText = '';
  let prevWasSpace = false;
  for (let i = 0; i < flatText.length; i++) {
    const ch = flatText[i];
    if (/\s/.test(ch)) {
      if (!prevWasSpace && normText.length > 0) {
        normText += ' ';
        normToFlat.push(i);
      }
      prevWasSpace = true;
    } else {
      normText += ch;
      normToFlat.push(i);
      prevWasSpace = false;
    }
  }

  const normMatches: { from: number; to: number }[] = [];
  let normFrom = 0;
  while (true) {
    const normIdx = normText.indexOf(normSearch, normFrom);
    if (normIdx === -1) break;
    const endIdx = normIdx + normSearch.length - 1;
    if (endIdx >= normToFlat.length) break;
    const flatStart = normToFlat[normIdx];
    const flatEnd = normToFlat[endIdx];
    if (flatStart < pmPositions.length && flatEnd < pmPositions.length) {
      normMatches.push({
        from: pmPositions[flatStart],
        to: pmPositions[flatEnd] + 1,
      });
    }
    if (hintOffset == null) break;
    normFrom = normIdx + 1;
  }

  if (normMatches.length > 0) {
    if (hintOffset == null || normMatches.length === 1) return normMatches[0];
    return closestMatch(normMatches, hintOffset);
  }

  return null;
}

function closestMatch(
  matches: { from: number; to: number }[],
  hint: number,
): { from: number; to: number } {
  let best = matches[0];
  let bestDist = Math.abs(best.from - hint);
  for (let i = 1; i < matches.length; i++) {
    const dist = Math.abs(matches[i].from - hint);
    if (dist < bestDist) { best = matches[i]; bestDist = dist; }
  }
  return best;
}

/**
 * Find ALL case-insensitive occurrences of `searchText` within `doc`, returning
 * native ProseMirror `{from, to}` positions for each match.
 *
 * Used by the document find bar (Cmd/Ctrl+F) so highlights land on the correct
 * rendered text rather than at raw markdown source offsets — markdown source
 * contains syntax characters (`#`, `**`, `[]()`, list bullets), YAML
 * frontmatter, and the persisted `<!-- rebel-annotations -->` block, none of
 * which appear in the rendered ProseMirror document. Naively passing source
 * offsets through to `editor.commands.setTextSelection` highlights wildly
 * unrelated strings (Sentry REBEL-5CK).
 *
 * Overlapping matches are returned in document order (search advances by one
 * character after each hit, matching the previous textarea-based behavior).
 */
export function findAllTextMatchesInDoc(
  doc: Parameters<typeof DecorationSet.create>[0],
  searchText: string,
): { from: number; to: number }[] {
  if (!searchText) return [];

  // Build a flat text string and parallel array mapping each character
  // index back to its ProseMirror position. Mirrors `findTextInDoc`'s
  // construction so positions stay consistent across the two helpers.
  const pmPositions: number[] = [];
  const chars: string[] = [];
  let lastTextEnd = -1;

  doc.descendants((node: { isText: boolean; text?: string | null }, pos: number) => {
    if (node.isText && node.text) {
      if (lastTextEnd >= 0 && pos > lastTextEnd) {
        chars.push(' ');
        pmPositions.push(lastTextEnd);
      }
      for (let i = 0; i < node.text.length; i++) {
        chars.push(node.text[i]);
        pmPositions.push(pos + i);
      }
      lastTextEnd = pos + node.text.length;
    }
    return true;
  });

  const flatLower = chars.join('').toLowerCase();
  const needle = searchText.toLowerCase();

  const matches: { from: number; to: number }[] = [];
  let from = 0;
  while (true) {
    const idx = flatLower.indexOf(needle, from);
    if (idx === -1) break;
    if (idx + needle.length > pmPositions.length) break;
    matches.push({
      from: pmPositions[idx],
      to: pmPositions[idx + needle.length - 1] + 1,
    });
    from = idx + 1;
  }
  return matches;
}

// ============================================================================
// TipTap Extension
// ============================================================================

export interface TipTapAnnotationOptions {
  /** Callback when user clicks on an annotated range */
  onAnnotationClick?: (
    annotation: Annotation,
    coords: { left: number; top: number; bottom: number }
  ) => void;
}

/**
 * TipTap extension that provides annotation functionality.
 * 
 * Usage:
 * ```ts
 * const editor = useEditor({
 *   extensions: [
 *     StarterKit,
 *     TipTapAnnotationExtension.configure({
 *       onAnnotationClick: (ann, coords) => { ... },
 *     }),
 *   ],
 * });
 * ```
 */
export const TipTapAnnotationExtension = Extension.create<TipTapAnnotationOptions>({
  name: 'annotations',

  addOptions() {
    return {
      onAnnotationClick: undefined,
    };
  },

  addProseMirrorPlugins() {
    return [
      createAnnotationPlugin({
        onAnnotationClick: this.options.onAnnotationClick,
      }),
    ];
  },
});

// Re-export the Annotation type for external use
export type { Annotation as TipTapAnnotation };
