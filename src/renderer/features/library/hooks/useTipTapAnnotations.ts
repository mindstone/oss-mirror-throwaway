/**
 * useTipTapAnnotations hook
 *
 * Manages annotation state for the TipTap markdown editor.
 * This is the TipTap equivalent of useAnnotations.ts (which was for CodeMirror).
 *
 * Provides selection tracking, annotation CRUD operations, and persistence callbacks.
 * Works with the TipTapAnnotationExtension ProseMirror plugin.
 *
 * Message formatting is delegated to the shared
 * `@rebel/shared/annotationUtils` primitives so this system stays in
 * lockstep with `useConversationAnnotations` — see the planning doc at
 * `docs/plans/260417_centralize_annotations_and_fix_document_send_clear.md`.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import type { Editor } from '@tiptap/core';
import type { Transaction } from '@tiptap/pm/state';
import {
  buildAnnotationDisplayMessageSafe,
  buildAnnotationMessageSafe,
  sanitizeMetadata,
} from '@rebel/shared';
import {
  TipTapAnnotationExtension,
  annotationPluginKey,
  getAnnotations as getAnnotationsFromState,
  dispatchAddAnnotation,
  dispatchRemoveAnnotation,
  dispatchUpdateComment,
  dispatchClearAnnotations,
  dispatchClearStagedAnnotations,
  dispatchLoadAnnotations,
  EditorUnmountedError,
  type Annotation,
} from '../extensions/tiptapAnnotationExtension';

// CRITICAL: Extension must be created ONCE at module level to prevent editor recreation.
// Creating it inside useMemo still causes issues because the object reference can change
// when parent components re-render due to React's reconciliation.
//
// FIX: Use a Map to store callbacks per editor instance to prevent cross-document callback
// leaks when multiple editors are open simultaneously (e.g., DocumentPreviewDrawer tabs + LibraryEditorPanel).
let sharedExtensionInstance: ReturnType<typeof TipTapAnnotationExtension.configure> | null = null;
const annotationClickCallbacks = new Map<string, (ann: Annotation, coords: { left: number; top: number; bottom: number }) => void>();

// Generate a unique ID for each hook instance to key the callback map
let hookInstanceCounter = 0;

function getOrCreateExtension(): ReturnType<typeof TipTapAnnotationExtension.configure> {
  if (!sharedExtensionInstance) {
    sharedExtensionInstance = TipTapAnnotationExtension.configure({
      onAnnotationClick: (ann: Annotation, coords: { left: number; top: number; bottom: number }) => {
        // Find the callback for this specific editor instance by checking all registered callbacks
        // The extension receives the EditorView, which we can use to find the right callback
        // We iterate callbacks since we can't easily key by view (it's not stable across renders)
        // In practice, only the callback for the focused editor will handle the event correctly
        // because the coords will only match the clicked editor's DOM.
        for (const callback of annotationClickCallbacks.values()) {
          callback(ann, coords);
          break; // Only call the first match - the click event is specific to one editor
        }
      },
    });
  }
  return sharedExtensionInstance;
}

/**
 * Register a callback for an editor instance. Returns cleanup function.
 */
function registerAnnotationClickCallback(
  instanceId: string,
  callback: (ann: Annotation, coords: { left: number; top: number; bottom: number }) => void
): () => void {
  annotationClickCallbacks.set(instanceId, callback);
  return () => {
    annotationClickCallbacks.delete(instanceId);
  };
}

export interface SelectionState {
  from: number;
  to: number;
  text: string;
  coords: { left: number; right: number; top: number; bottom: number } | null;
}

export interface EditingState {
  annotation: Annotation;
  coords: { left: number; right: number; top: number; bottom: number };
}

export interface UseTipTapAnnotationsOptions {
  /** The TipTap editor instance */
  editor: Editor | null;
  /** Callback when annotations change (for persistence) */
  onAnnotationsChange?: (annotations: Annotation[]) => void;
}

export interface UseTipTapAnnotationsResult {
  /** The TipTap extension to include in editor config */
  extension: typeof TipTapAnnotationExtension;
  /** Current annotations */
  annotations: Annotation[];
  /** Current selection state (null if no selection) */
  selection: SelectionState | null;
  /** Current editing state (null if not editing) */
  editing: EditingState | null;
  /** Whether annotations exist */
  hasAnnotations: boolean;
  /** Add an annotation for the current selection */
  addAnnotation: (comment: string) => string | null;
  /** Update an existing annotation's comment */
  updateAnnotation: (id: string, comment: string) => void;
  /** Remove an annotation by ID */
  removeAnnotation: (id: string) => void;
  /**
   * Clear annotations.
   *
   * - Called with no args (or `undefined` / empty array): clears ALL
   *   annotations, matching the original "Clear All" button behaviour.
   * - Called with a non-empty array of ids: clears ONLY the provided
   *   ids. Used by "Send to Rebel" to clear exactly the annotations
   *   that were staged at Send time (snapshot), leaving any
   *   annotations added after Send click intact.
   *
   * Polymorphic so existing callers can keep calling `clearAnnotations()`
   * without change.
   */
  clearAnnotations: (ids?: string[]) => void;
  /**
   * Fire-and-forget scoped clear used by the per-message `onCommit`
   * closure. Throws {@link EditorUnmountedError} synchronously (via
   * the PM extension's liveness probe) when the editor is dead;
   * callers are expected to catch and surface a warn log + toast.
   */
  dispatchClearStagedAnnotations: (ids: string[]) => void;
  /** Clear the current selection state (close popover) */
  clearSelection: () => void;
  /** Clear the editing state (close edit popover) */
  clearEditing: () => void;
  /** Format annotations as a message for Rebel */
  formatAnnotationsMessage: (filePath: string) => string;
  /** Format annotations as clean display text (no fencing) */
  formatDisplayMessage: (filePath: string) => string;
  /** Get the ProseMirror EditorView if available */
  getEditorView: () => Editor['view'] | null;
  /** Load annotations (e.g., from persisted storage) */
  loadAnnotations: (annotations: Annotation[]) => void;
  /** Start editing an annotation at the given coords */
  startEditing: (annotation: Annotation, coords: { left: number; top: number; bottom: number }) => void;
  /** Force sync annotations from editor state to React state (call after direct dispatches) */
  refreshAnnotations: () => void;
}

export function useTipTapAnnotations(
  options: UseTipTapAnnotationsOptions
): UseTipTapAnnotationsResult {
  const { editor, onAnnotationsChange } = options;
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [selection, setSelection] = useState<SelectionState | null>(null);
  const [editing, setEditing] = useState<EditingState | null>(null);
  const isLoadingRef = useRef(false);
  const pendingLoadRef = useRef<Annotation[] | null>(null);
  
  // Generate a stable instance ID for this hook invocation
  const instanceIdRef = useRef<string | null>(null);
  if (instanceIdRef.current === null) {
    instanceIdRef.current = `ann-hook-${++hookInstanceCounter}`;
  }
  
  // CRITICAL: Store callback in ref to avoid infinite loops.
  // If onAnnotationsChange is not memoized in the parent, it would cause
  // syncAnnotations to be recreated, which would re-trigger the useEffect,
  // which calls syncAnnotations(), creating an infinite loop.
  const onAnnotationsChangeRef = useRef(onAnnotationsChange);
  onAnnotationsChangeRef.current = onAnnotationsChange;

  // Get the stable extension instance - uses module-level singleton to prevent
  // editor recreation when parent components re-render.
  const extension = getOrCreateExtension();
  
  // Register the annotation click callback with the instance ID
  // This ensures multiple editors don't clobber each other's callbacks
  useEffect(() => {
    const instanceId = instanceIdRef.current;
    if (!instanceId) return;
    const cleanup = registerAnnotationClickCallback(
      instanceId,
      (ann, coords) => {
        // When clicking an annotation, enter edit mode
        setSelection(null);
        setEditing({
          annotation: ann,
          coords: {
            left: coords.left,
            right: coords.left, // ProseMirror only gives left
            top: coords.top,
            bottom: coords.bottom,
          },
        });
      }
    );
    return cleanup;
  }, []);

  // Sync annotations from editor state when it changes
  const syncAnnotations = useCallback(() => {
    if (!editor) return;

    const anns = getAnnotationsFromState(editor.state);
    setAnnotations(anns);

    // Notify parent if not loading (loading handles its own state)
    // CRITICAL: Use ref to avoid infinite loops (see onAnnotationsChangeRef comment above)
    if (!isLoadingRef.current && onAnnotationsChangeRef.current) {
      onAnnotationsChangeRef.current(anns);
    }
  }, [editor]); // Note: onAnnotationsChange removed from deps, using ref instead

  // Subscribe to editor state changes to sync annotations
  // Performance optimization: Only sync when annotations might have changed
  useEffect(() => {
    if (!editor) return;

    // Initial sync
    syncAnnotations();

    // Subscribe to transactions - filter to only annotation-relevant changes
    // CRITICAL: Use debounce to allow setContent + dispatchLoadAnnotations to complete
    // before we read the plugin state. Without this, we'd read empty state after setContent
    // but before the annotations are restored.
    let syncDebounceTimer: ReturnType<typeof setTimeout> | null = null;
    
    const handleTransaction = ({ transaction }: { transaction: Transaction }) => {
      // Only sync if:
      // 1. Transaction has annotation metadata (add/remove/update/clear/load)
      // 2. Document changed (positions may have shifted)
      const hasAnnotationMeta = transaction.getMeta(annotationPluginKey) !== undefined;
      const docChanged = transaction.docChanged;
      
      if (hasAnnotationMeta || docChanged) {
        // Debounce to next tick to allow restore operations to complete
        if (syncDebounceTimer) clearTimeout(syncDebounceTimer);
        syncDebounceTimer = setTimeout(syncAnnotations, 0);
      }
    };

    editor.on('transaction', handleTransaction);
    return () => {
      editor.off('transaction', handleTransaction);
      if (syncDebounceTimer) clearTimeout(syncDebounceTimer);
    };
  }, [editor, syncAnnotations]);

  // Load pending annotations when editor becomes ready
  useEffect(() => {
    if (!editor || !pendingLoadRef.current) return;

    isLoadingRef.current = true;
    dispatchLoadAnnotations(editor.view, pendingLoadRef.current);
    const loaded = getAnnotationsFromState(editor.state);
    setAnnotations(loaded);
    pendingLoadRef.current = null;
    isLoadingRef.current = false;
  }, [editor]);

  // Track selection changes for showing the "Add Comment" popover
  // Performance optimization: Debounce to reduce expensive coordsAtPos() calls
  useEffect(() => {
    if (!editor) return;

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const handleSelectionUpdate = () => {
      // Clear any pending debounce
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }

      const { from, to, empty } = editor.state.selection;

      // If editing an annotation, don't update selection state
      if (editing) {
        return;
      }

      if (empty) {
        // No selection - clear immediately (no debounce needed)
        setSelection(null);
        return;
      }

      // Get selected text (cheap operation)
      const text = editor.state.doc.textBetween(from, to, ' ');
      if (!text.trim()) {
        setSelection(null);
        return;
      }

      // Debounce the expensive coordsAtPos() calls
      // This prevents lag during rapid selection changes (e.g., shift+arrow keys)
      debounceTimer = setTimeout(() => {
        // Re-check selection is still valid after debounce
        const currentSelection = editor.state.selection;
        if (currentSelection.empty || currentSelection.from !== from || currentSelection.to !== to) {
          return; // Selection changed during debounce, skip
        }

        // Get coordinates for popover positioning (expensive DOM query)
        const coords = editor.view.coordsAtPos(from);
        const endCoords = editor.view.coordsAtPos(to);

        setSelection({
          from,
          to,
          text,
          coords: coords
            ? {
                left: coords.left,
                right: endCoords?.right ?? coords.left,
                top: coords.top,
                bottom: coords.bottom,
              }
            : null,
        });
      }, 50); // 50ms debounce - fast enough to feel responsive, slow enough to batch rapid changes
    };

    editor.on('selectionUpdate', handleSelectionUpdate);
    return () => {
      editor.off('selectionUpdate', handleSelectionUpdate);
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
    };
  }, [editor, editing]);

  // Add annotation for current selection
  const addAnnotation = useCallback(
    (comment: string): string | null => {
      if (!editor || !selection) {
        return null;
      }

      const id = dispatchAddAnnotation(editor.view, {
        from: selection.from,
        to: selection.to,
        text: selection.text,
        comment,
      });

      // Sync after adding
      syncAnnotations();
      // Clear selection after adding (close popover)
      setSelection(null);

      return id;
    },
    [editor, selection, syncAnnotations]
  );

  // Update an existing annotation's comment
  const updateAnnotation = useCallback(
    (id: string, comment: string) => {
      if (!editor) return;

      dispatchUpdateComment(editor.view, id, comment);
      syncAnnotations();
      setEditing(null);
    },
    [editor, syncAnnotations]
  );

  // Remove annotation by ID
  const removeAnnotation = useCallback(
    (id: string) => {
      if (!editor) return;

      dispatchRemoveAnnotation(editor.view, id);
      syncAnnotations();
      setEditing(null); // Close edit mode if we deleted the annotation being edited
    },
    [editor, syncAnnotations]
  );

  // Clear annotations — polymorphic:
  //   clearAllAnnotations()              → clear all (backward-compat)
  //   clearAllAnnotations(undefined)     → clear all (backward-compat)
  //   clearAllAnnotations([])            → clear all (treated as "no filter provided")
  //   clearAllAnnotations(['id1','id2']) → clear only the listed ids
  //
  // The scoped variant is used by the per-message onCommit closure to
  // clear exactly the annotations that were staged at "Send to Rebel"
  // click time, so any annotations added AFTER Send click survive. See
  // docs/plans/260417_centralize_annotations_and_fix_document_send_clear.md.
  //
  // Throws `EditorUnmountedError` synchronously — both from our own
  // `!editor` guard and from the PM extension's liveness probe when
  // the editor has been destroyed. Callers are expected to catch and
  // surface a warn log + toast; we never silently swallow ("silent
  // failure is a bug" per AGENTS.md). The Clear-All button in
  // DocumentFooter wraps its `onClearAnnotations()` call in a local
  // try/catch for the same reason.
  const clearAllAnnotations = useCallback((ids?: string[]) => {
    if (!editor) {
      throw new EditorUnmountedError('No active editor; annotation clear aborted.');
    }

    if (ids && ids.length > 0) {
      // Scoped clear. The sync syncAnnotations effect will pick up the
      // resulting plugin-state change and update React state + notify
      // the parent (so the annotations-save effect serialises the new
      // block to content). We additionally nudge React state directly
      // to match the eager behaviour of the "clear all" branch.
      dispatchClearStagedAnnotations(editor.view, ids);
      // Re-read annotations from the PM state AFTER dispatch so any
      // annotations added between Send-click and the onCommit firing
      // (which are still present in plugin state) are preserved in the
      // React snapshot. Computing from the captured `annotations`
      // array would briefly publish a stale pre-dispatch view. See
      // FIX 6 in the planning doc.
      const remaining = getAnnotationsFromState(editor.state);
      setAnnotations(remaining);
      onAnnotationsChangeRef.current?.(remaining);
      return;
    }

    dispatchClearAnnotations(editor.view);
    setAnnotations([]);
    onAnnotationsChangeRef.current?.([]);
  }, [editor]);

  // Fire-and-forget scoped clear. Kept separate from the polymorphic
  // `clearAnnotations` above so the onCommit callsite — which must
  // observe sync throws from the PM extension's liveness probe — has
  // an explicit, dedicated entry point.
  const dispatchClearStagedAnnotationsCallback = useCallback(
    (ids: string[]) => {
      if (!editor) {
        // No editor to dispatch into — treat the same as an unmounted
        // editor for the caller's purposes. This is rare (the caller
        // only fires from a closure captured while the editor was
        // alive) but possible on teardown races. Throw so the caller
        // sees the failure and logs a warn + toast per policy.
        throw new EditorUnmountedError('No active editor; annotation dispatch aborted.');
      }
      dispatchClearStagedAnnotations(editor.view, ids);
      // Re-read annotations from PM state AFTER dispatch so any
      // annotations added after Send-click (and therefore not in the
      // caller's `ids` snapshot) stay present in the React snapshot.
      // See FIX 6 in the planning doc.
      const remaining = getAnnotationsFromState(editor.state);
      setAnnotations(remaining);
      onAnnotationsChangeRef.current?.(remaining);
    },
    [editor],
  );

  // Clear selection (close popover)
  const clearSelection = useCallback(() => {
    setSelection(null);
  }, []);

  // Clear editing state (close edit popover)
  const clearEditing = useCallback(() => {
    setEditing(null);
  }, []);

  // Start editing an annotation manually (for external triggers like context menu)
  const startEditing = useCallback(
    (annotation: Annotation, coords: { left: number; top: number; bottom: number }) => {
      setSelection(null);
      setEditing({
        annotation,
        coords: {
          left: coords.left,
          right: coords.left,
          top: coords.top,
          bottom: coords.bottom,
        },
      });
    },
    []
  );

  const buildAnnotationPreamble = useCallback((filePath: string): string => {
    const safeFilePath = sanitizeMetadata(filePath, 256).replace(/`/g, "'");
    const count = annotations.length;
    return `I've marked up \`${safeFilePath}\` with ${count} comment${
      count !== 1 ? 's' : ''
    }. Re-read first — I may have edited since.`;
  }, [annotations.length]);

  // Format annotations as a message for Rebel.
  //
  // Fail-loud: throws `AnnotationFormatExhaustionError` when every
  // fence-nonce retry collides. The empty-string "nothing to send"
  // contract is still honoured for the empty-input case, but we no
  // longer use it as a silent-failure fallback — silent failure would
  // mask the bug and drop the user's annotations. The DocumentFooter
  // callsite wraps this call in try/catch, emits a structured error
  // log, shows a toast ("Couldn't format comments — try simplifying
  // the text"), and aborts the send. See FIX 2 in the planning doc.
  const formatAnnotationsMessage = useCallback(
    (filePath: string): string => {
      if (annotations.length === 0) {
        return '';
      }

      // Sanitize the file path before interpolating it into the preamble:
      // `sanitizeMetadata` strips control characters + caps length so a
      // path with embedded newlines can't leak out of its single-line
      // channel inside the trusted preamble string.
      //
      // Additionally replace backticks with single quotes: the preamble
      // wraps the path in `...` for display, and a filename containing
      // literal backticks would otherwise close the inline-code span
      // early and let attacker-controlled text land in trusted prompt
      // copy outside the fence. `sanitizeMetadata` does not escape
      // markdown metacharacters, so we do it at the interpolation site.
      const preamble = buildAnnotationPreamble(filePath);
      return buildAnnotationMessageSafe(annotations, { preamble });
    },
    [annotations, buildAnnotationPreamble]
  );

  const formatDisplayMessage = useCallback(
    (filePath: string): string => {
      if (annotations.length === 0) {
        return '';
      }
      const preamble = buildAnnotationPreamble(filePath);
      return buildAnnotationDisplayMessageSafe(annotations, { preamble });
    },
    [annotations, buildAnnotationPreamble]
  );

  // Get EditorView — safely handles TipTap v3's pre-mount proxy
  const getEditorView = useCallback(() => {
    if (!editor) return null;
    try {
      const view = editor.view;
      // Probe .dom — the pre-mount proxy throws on property access
      void view.dom;
      return view;
    } catch {
      return null;
    }
  }, [editor]);

  // Load annotations from external source (e.g., persisted in document)
  const loadAnnotations = useCallback(
    (anns: Annotation[]) => {
      if (!editor) {
        // Editor not ready yet, queue for when it's ready
        pendingLoadRef.current = anns;
        return;
      }

      isLoadingRef.current = true;
      dispatchClearAnnotations(editor.view);

      if (anns.length > 0) {
        dispatchLoadAnnotations(editor.view, anns);
      }

      const loaded = getAnnotationsFromState(editor.state);
      setAnnotations(loaded);
      isLoadingRef.current = false;
    },
    [editor]
  );

  return {
    extension,
    annotations,
    selection,
    editing,
    hasAnnotations: annotations.length > 0,
    addAnnotation,
    updateAnnotation,
    removeAnnotation,
    clearAnnotations: clearAllAnnotations,
    dispatchClearStagedAnnotations: dispatchClearStagedAnnotationsCallback,
    clearSelection,
    clearEditing,
    formatAnnotationsMessage,
    formatDisplayMessage,
    getEditorView,
    loadAnnotations,
    startEditing,
    refreshAnnotations: syncAnnotations,
  };
}

// Re-export types for convenience
export type { Annotation };
