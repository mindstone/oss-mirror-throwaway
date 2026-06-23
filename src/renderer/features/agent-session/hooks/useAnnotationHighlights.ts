/**
 * useAnnotationHighlights
 *
 * Manages the CSS Custom Highlight API lifecycle for conversation annotations.
 * Re-applies highlights after React renders and on scroll (for virtualized lists).
 * Returns positioned rects for rendering comment icons.
 */

import { useEffect, useCallback, useRef, useState } from 'react';
import type { ConversationAnnotation } from './useConversationAnnotations';
import {
  applyAnnotationHighlights,
  clearAnnotationHighlights,
} from '../utils/highlightAnnotations';

export interface AnnotationPosition {
  annotationId: string;
  rect: DOMRect;
}

interface UseAnnotationHighlightsOptions {
  annotations: ConversationAnnotation[];
  getMessageElement: (messageId: string) => HTMLElement | null;
  scrollContainerRef: React.RefObject<HTMLElement | null>;
  enabled?: boolean;
}

interface UseAnnotationHighlightsResult {
  positions: AnnotationPosition[];
}

export function useAnnotationHighlights({
  annotations,
  getMessageElement,
  scrollContainerRef,
  enabled = true,
}: UseAnnotationHighlightsOptions): UseAnnotationHighlightsResult {
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const applyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [positions, setPositions] = useState<AnnotationPosition[]>([]);

  const applyHighlights = useCallback(() => {
    if (!enabled || annotations.length === 0) {
      clearAnnotationHighlights();
      setPositions([]);
      return;
    }
    const rects = applyAnnotationHighlights(annotations, getMessageElement);
    setPositions(rects);
  }, [annotations, getMessageElement, enabled]);

  // Apply highlights after render with a small delay to ensure DOM is ready
  useEffect(() => {
    // Clear any pending timer
    if (applyTimerRef.current) {
      clearTimeout(applyTimerRef.current);
    }

    // Use RAF + small timeout to ensure DOM is fully updated
    const frameId = requestAnimationFrame(() => {
      applyTimerRef.current = setTimeout(() => {
        applyHighlights();
      }, 50);
    });

    return () => {
      cancelAnimationFrame(frameId);
      if (applyTimerRef.current) {
        clearTimeout(applyTimerRef.current);
      }
    };
  }, [applyHighlights]);

  // Re-apply highlights on scroll (debounced) for virtualized list
  // Icons now use position: absolute inside scroll container, so they scroll naturally
  useEffect(() => {
    const scrollContainer = scrollContainerRef.current;
    if (!scrollContainer || annotations.length === 0) return;

    const handleScroll = () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
      // Debounce re-application for when virtualized list re-renders elements
      debounceTimerRef.current = setTimeout(() => {
        applyHighlights();
      }, 150);
    };

    scrollContainer.addEventListener('scroll', handleScroll, { passive: true });

    return () => {
      scrollContainer.removeEventListener('scroll', handleScroll);
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, [scrollContainerRef, annotations.length, applyHighlights]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      clearAnnotationHighlights();
    };
  }, []);

  return { positions };
}
