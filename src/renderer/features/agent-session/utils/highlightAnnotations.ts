/**
 * Highlight Annotations Utilities
 *
 * Uses the CSS Custom Highlight API to visually highlight annotated text
 * in rendered AI replies without mutating the DOM.
 */

import type { ConversationAnnotation } from '../hooks/useConversationAnnotations';

const HIGHLIGHT_NAME = 'conversation-annotations';

interface TextNodePosition {
  node: Text;
  start: number;
  end: number;
}

/**
 * Collects all text nodes within an element with their cumulative positions.
 */
function collectTextNodes(element: HTMLElement): TextNodePosition[] {
  const positions: TextNodePosition[] = [];
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);

  let cumulativeOffset = 0;
  let node: Text | null;

  while ((node = walker.nextNode() as Text | null)) {
    const length = node.textContent?.length ?? 0;
    if (length > 0) {
      positions.push({
        node,
        start: cumulativeOffset,
        end: cumulativeOffset + length,
      });
      cumulativeOffset += length;
    }
  }

  return positions;
}

/**
 * Finds a text string within an element and returns a Range spanning it.
 * Returns null if text is not found.
 */
export function findTextInElement(
  element: HTMLElement,
  searchText: string
): Range | null {
  const textNodes = collectTextNodes(element);
  if (textNodes.length === 0) return null;

  const fullText = textNodes.map((p) => p.node.textContent).join('');
  const searchIndex = fullText.indexOf(searchText);

  if (searchIndex === -1) return null;

  const searchEnd = searchIndex + searchText.length;

  let startNode: Text | null = null;
  let startOffset = 0;
  let endNode: Text | null = null;
  let endOffset = 0;

  for (const pos of textNodes) {
    if (startNode === null && pos.end > searchIndex) {
      startNode = pos.node;
      startOffset = searchIndex - pos.start;
    }
    if (pos.end >= searchEnd) {
      endNode = pos.node;
      endOffset = searchEnd - pos.start;
      break;
    }
  }

  if (!startNode || !endNode) return null;

  try {
    const range = document.createRange();
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
    return range;
  } catch {
    return null;
  }
}

/**
 * Creates a Range from character offsets within an element's text content.
 * Uses exact offsets for precise positioning (no substring search).
 */
export function findRangeByOffsets(
  element: HTMLElement,
  startOffset: number,
  endOffset: number
): Range | null {
  const textNodes = collectTextNodes(element);
  if (textNodes.length === 0) return null;

  let startNode: Text | null = null;
  let startNodeOffset = 0;
  let endNode: Text | null = null;
  let endNodeOffset = 0;

  for (const pos of textNodes) {
    // Find start node
    if (startNode === null && pos.end > startOffset) {
      startNode = pos.node;
      startNodeOffset = startOffset - pos.start;
    }
    // Find end node
    if (pos.end >= endOffset) {
      endNode = pos.node;
      endNodeOffset = endOffset - pos.start;
      break;
    }
  }

  if (!startNode || !endNode) return null;

  try {
    const range = document.createRange();
    range.setStart(startNode, startNodeOffset);
    range.setEnd(endNode, endNodeOffset);
    return range;
  } catch {
    return null;
  }
}

interface AnnotationRect {
  annotationId: string;
  rect: DOMRect;
}

/**
 * Applies CSS Custom Highlight API highlights for all annotations.
 * Returns the bounding rects of each annotation for positioning icons.
 *
 * Uses a two-phase approach for resilience:
 * 1. Try offset-based matching (fast, precise) and verify text matches
 * 2. Fall back to text-based search if offsets are stale (e.g., message text changed during streaming)
 *
 * Note: If offsets are stale and the annotated text appears multiple times in the message,
 * the first occurrence will be highlighted (limitation of text-based fallback).
 */
export function applyAnnotationHighlights(
  annotations: ConversationAnnotation[],
  getMessageElement: (messageId: string) => HTMLElement | null
): AnnotationRect[] {
  clearAnnotationHighlights();

  if (annotations.length === 0) return [];

  const ranges: Range[] = [];
  const rects: AnnotationRect[] = [];

  for (const ann of annotations) {
    const element = getMessageElement(ann.messageId);
    if (!element) continue;

    let range: Range | null = null;

    // Try offset-based matching first (fast path)
    const offsetRange = findRangeByOffsets(element, ann.startOffset, ann.endOffset);
    if (offsetRange) {
      // Verify the range text matches the annotation text
      // Note: Use trim() because annotation text is trimmed at capture time (TextSelectionMenu.tsx)
      const rangeText = offsetRange.toString().trim();
      if (rangeText === ann.text) {
        range = offsetRange;
      }
    }

    // Fall back to text-based search if offset matching failed or text didn't match
    // This handles cases where message content changed (streaming, tool execution, result merging)
    if (!range && ann.text) {
      range = findTextInElement(element, ann.text);
    }

    if (range) {
      ranges.push(range);
      // Get the bounding rect of the range (use last rect for multi-line)
      const rangeRects = range.getClientRects();
      if (rangeRects.length > 0) {
        rects.push({
          annotationId: ann.id,
          rect: rangeRects[rangeRects.length - 1], // Last rect (end of selection)
        });
      }
    }
  }

  if (ranges.length === 0) return [];

  try {
    const highlight = new Highlight(...ranges);
    CSS.highlights.set(HIGHLIGHT_NAME, highlight);
  } catch (error) {
    console.warn('Failed to apply annotation highlights:', error);
  }

  return rects;
}

/**
 * Clears all annotation highlights.
 */
export function clearAnnotationHighlights(): void {
  try {
    CSS.highlights.delete(HIGHLIGHT_NAME);
  } catch {
    // Ignore if highlights don't exist
  }
}
