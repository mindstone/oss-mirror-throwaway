/**
 * useConversationAnnotations
 *
 * Manages pending annotations on AI replies within a conversation.
 * Annotations are stored by text content (not DOM positions), scoped to
 * a session in the agent-session store, and exist until sent as a
 * follow-up message.
 *
 * Formatting and ID generation are delegated to the shared
 * `@rebel/shared/annotationUtils` primitives so the conversation and
 * document annotation systems stay in lockstep — see the planning doc
 * at `docs/plans/260417_centralize_annotations_and_fix_document_send_clear.md`.
 */

import { useCallback, useMemo } from 'react';
import {
  buildAnnotationDisplayMessageSafe,
  buildAnnotationMessageSafe,
  generateAnnotationId,
} from '@rebel/shared';
import type { ConversationAnnotation } from '@shared/types/agent';
import { useSessionStore } from '../store';

export type { ConversationAnnotation } from '@shared/types/agent';

const EMPTY_CONVERSATION_ANNOTATIONS: ConversationAnnotation[] = [];

export interface UseConversationAnnotationsResult {
  annotations: ConversationAnnotation[];
  hasAnnotations: boolean;
  annotationCount: number;
  annotationsByMessage: Map<string, ConversationAnnotation[]>;
  addAnnotation: (messageId: string, text: string, comment: string, startOffset: number, endOffset: number) => string;
  updateAnnotation: (id: string, comment: string) => void;
  removeAnnotation: (id: string) => void;
  clearAnnotations: () => void;
  formatAnnotationsMessage: () => string;
  formatDisplayMessage: () => string;
  getAnnotationAtPosition: (messageId: string, text: string, offset: number) => ConversationAnnotation | null;
}

// `sessionId` is required so pending conversation annotations are explicitly
// keyed by session in Zustand; this preserves the hook's public return shape
// while allowing annotations to survive hook remounts and session switches.
export function useConversationAnnotations(sessionId: string): UseConversationAnnotationsResult {
  const annotations = useSessionStore(
    (state) => state.annotationsBySessionId[sessionId] ?? EMPTY_CONVERSATION_ANNOTATIONS,
  );
  const setAnnotationsForSession = useSessionStore(
    (state) => state.setAnnotationsForSession,
  );

  const getCurrentAnnotations = useCallback(() => {
    return useSessionStore.getState().getAnnotationsForSession(sessionId);
  }, [sessionId]);

  const addAnnotation = useCallback((messageId: string, text: string, comment: string, startOffset: number, endOffset: number): string => {
    const id = generateAnnotationId();
    const annotation: ConversationAnnotation = {
      id,
      messageId,
      text,
      comment,
      createdAt: Date.now(),
      startOffset,
      endOffset,
    };
    const next = [...getCurrentAnnotations(), annotation];
    setAnnotationsForSession(sessionId, next);
    return id;
  }, [getCurrentAnnotations, sessionId, setAnnotationsForSession]);

  const updateAnnotation = useCallback((id: string, comment: string) => {
    const next = getCurrentAnnotations().map((ann) =>
      ann.id === id ? { ...ann, comment } : ann
    );
    setAnnotationsForSession(sessionId, next);
  }, [getCurrentAnnotations, sessionId, setAnnotationsForSession]);

  const removeAnnotation = useCallback((id: string) => {
    const next = getCurrentAnnotations().filter((ann) => ann.id !== id);
    setAnnotationsForSession(sessionId, next);
  }, [getCurrentAnnotations, sessionId, setAnnotationsForSession]);

  const clearAnnotations = useCallback(() => {
    setAnnotationsForSession(sessionId, []);
  }, [sessionId, setAnnotationsForSession]);

  const annotationsByMessage = useMemo(() => {
    const map = new Map<string, ConversationAnnotation[]>();
    for (const ann of annotations) {
      const existing = map.get(ann.messageId) || [];
      existing.push(ann);
      map.set(ann.messageId, existing);
    }
    return map;
  }, [annotations]);

  // Fail-loud: throws `AnnotationFormatExhaustionError` when every
  // fence-nonce retry collides. The empty-input "nothing to send"
  // contract is still honoured, but we no longer use empty-string as
  // a silent-failure fallback — silent failure would mask the bug and
  // drop the user's annotations. The AnnotationOrchestrator callsite
  // wraps this call in try/catch, emits an error log, shows a toast,
  // and aborts the send. See FIX 2 in the planning doc.
  const formatAnnotationsMessage = useCallback((): string => {
    return buildAnnotationMessageSafe(annotations);
  }, [annotations]);

  const formatDisplayMessage = useCallback((): string => {
    return buildAnnotationDisplayMessageSafe(annotations);
  }, [annotations]);

  const getAnnotationAtPosition = useCallback(
    (messageId: string, fullText: string, offset: number): ConversationAnnotation | null => {
      const messageAnnotations = annotationsByMessage.get(messageId);
      if (!messageAnnotations) return null;

      // Two-phase hit testing to handle stale offsets (message text may have changed during streaming)
      // Phase 1: Try offset-based matching with text verification
      for (const ann of messageAnnotations) {
        if (offset >= ann.startOffset && offset < ann.endOffset) {
          // Verify the text at stored offsets matches the annotation text
          const textAtOffset = fullText.slice(ann.startOffset, ann.endOffset).trim();
          if (textAtOffset === ann.text) {
            return ann;
          }
        }
      }

      // Phase 2: Fall back to text-based search if offsets are stale
      // Find annotations whose text contains the click position
      for (const ann of messageAnnotations) {
        const foundIndex = fullText.indexOf(ann.text);
        if (foundIndex !== -1) {
          const foundEnd = foundIndex + ann.text.length;
          if (offset >= foundIndex && offset < foundEnd) {
            return ann;
          }
        }
      }

      return null;
    },
    [annotationsByMessage]
  );

  return {
    annotations,
    hasAnnotations: annotations.length > 0,
    annotationCount: annotations.length,
    annotationsByMessage,
    addAnnotation,
    updateAnnotation,
    removeAnnotation,
    clearAnnotations,
    formatAnnotationsMessage,
    formatDisplayMessage,
    getAnnotationAtPosition,
  };
}
