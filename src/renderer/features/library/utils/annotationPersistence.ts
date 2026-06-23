/**
 * Annotation Persistence Utilities
 *
 * Stores annotations as a trailing HTML comment in the markdown document.
 * Format: <!-- rebel-annotations [...] -->
 *
 * This makes annotations portable - they travel with the document and
 * can be recovered even if the file is edited in another system.
 *
 * The stored shape extends `BaseAnnotation` from `@rebel/shared` so the
 * `id`/`text`/`comment`/`createdAt` contract stays aligned with the
 * conversation- and document-annotation systems — see the planning doc
 * at `docs/plans/260417_centralize_annotations_and_fix_document_send_clear.md`.
 */

import type { BaseAnnotation } from '@rebel/shared';

export interface StoredAnnotation extends BaseAnnotation {
  // Content-aware anchoring (W3C TextQuoteSelector pattern)
  prefix?: string;   // ~30 chars before annotated text
  suffix?: string;   // ~30 chars after annotated text
  from?: number;     // last known start offset in markdown string (hint)
  to?: number;       // last known end offset in markdown string (hint)
  /** @deprecated Use `from` instead. Kept for backward compat with existing stored annotations. */
  textOffset?: number;
}

export interface RecoveredAnnotation extends StoredAnnotation {
  from: number;
  to: number;
  recovered: boolean; // true if position was fuzzy-matched, false if orphaned
}

const ANNOTATION_COMMENT_START = '<!-- rebel-annotations';
const ANNOTATION_COMMENT_END = '-->';
const ANNOTATION_REGEX = /<!-- rebel-annotations\s*([\s\S]*?)\s*-->/;

// Escape sequence for --> to prevent breaking the HTML comment
const ESCAPE_SEQUENCE = '--\\u003e';
const UNESCAPE_REGEX = /--\\u003e/g;

/**
 * Escape --> in a string to prevent breaking HTML comments.
 * Uses a JSON-compatible escape sequence.
 */
function escapeHtmlCommentClose(str: string): string {
  return str.replace(/-->/g, ESCAPE_SEQUENCE);
}

/**
 * Unescape the --> escape sequence.
 */
function unescapeHtmlCommentClose(str: string): string {
  return str.replace(UNESCAPE_REGEX, '-->');
}

const CONTEXT_LENGTH = 30;

/**
 * Compute prefix/suffix context for an annotation by finding it in the content.
 * Uses text search with ProseMirror position as proximity hint (NOT as direct index).
 * Returns markdown string positions and context, or undefined if text not found.
 */
export function computeAnnotationContext(
  canonicalContent: string,
  annotationText: string,
  proseMirrorFrom: number
): { prefix: string; suffix: string; from: number; to: number } | undefined {
  if (!annotationText) return undefined;

  // Find ALL occurrences of annotationText in content
  const candidates: Array<{ from: number; to: number }> = [];
  let searchStart = 0;
  while (true) {
    const idx = canonicalContent.indexOf(annotationText, searchStart);
    if (idx === -1) break;
    candidates.push({ from: idx, to: idx + annotationText.length });
    searchStart = idx + 1;
  }

  if (candidates.length === 0) return undefined;

  // Pick the candidate closest to the ProseMirror position hint
  let best = candidates[0];
  let bestDist = Math.abs(best.from - proseMirrorFrom);
  for (let i = 1; i < candidates.length; i++) {
    const dist = Math.abs(candidates[i].from - proseMirrorFrom);
    if (dist < bestDist) {
      best = candidates[i];
      bestDist = dist;
    }
  }

  // Extract prefix (~30 chars before, clamped to word boundary or newline)
  const prefixStart = Math.max(0, best.from - CONTEXT_LENGTH);
  let prefix = canonicalContent.slice(prefixStart, best.from);
  // Trim to word boundary (last space or newline) if we're not at document start
  if (prefixStart > 0) {
    const boundaryIdx = Math.max(prefix.lastIndexOf(' '), prefix.lastIndexOf('\n'));
    if (boundaryIdx > 0) {
      prefix = prefix.slice(boundaryIdx + 1);
    }
  }

  // Extract suffix (~30 chars after, clamped to word boundary or newline)
  const suffixEnd = Math.min(canonicalContent.length, best.to + CONTEXT_LENGTH);
  let suffix = canonicalContent.slice(best.to, suffixEnd);
  // Trim to word boundary (first space or newline) if we're not at document end
  if (suffixEnd < canonicalContent.length) {
    const spaceIdx = suffix.indexOf(' ');
    const newlineIdx = suffix.indexOf('\n');
    const boundaryIdx = spaceIdx === -1 ? newlineIdx : newlineIdx === -1 ? spaceIdx : Math.min(spaceIdx, newlineIdx);
    if (boundaryIdx > 0) {
      suffix = suffix.slice(0, boundaryIdx);
    }
  }

  return { prefix, suffix, from: best.from, to: best.to };
}

/**
 * Parse annotations from document content.
 * Returns the stored annotations (without positions).
 * Handles unescaping of --> sequences that were escaped during serialization.
 */
export function parseAnnotationsFromDocument(content: string): StoredAnnotation[] {
  const match = content.match(ANNOTATION_REGEX);
  if (!match) {
    return [];
  }

  try {
    const json = match[1].trim();
    if (!json) return [];
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (a): a is StoredAnnotation =>
          typeof a === 'object' &&
          typeof a.id === 'string' &&
          typeof a.text === 'string' &&
          typeof a.comment === 'string'
      )
      .map((a) => ({
        ...a,
        // Unescape --> sequences that were escaped during serialization
        text: unescapeHtmlCommentClose(a.text),
        comment: unescapeHtmlCommentClose(a.comment),
        ...(typeof a.prefix === 'string' ? { prefix: unescapeHtmlCommentClose(a.prefix) } : {}),
        ...(typeof a.suffix === 'string' ? { suffix: unescapeHtmlCommentClose(a.suffix) } : {}),
      }));
  } catch {
    return [];
  }
}

/**
 * Remove the annotation comment block from document content.
 */
export function stripAnnotationComment(content: string): string {
  return content.replace(ANNOTATION_REGEX, '').trimEnd();
}

/**
 * Serialize annotations to the HTML comment format.
 * Escapes --> sequences in text and comments to prevent breaking the HTML comment block.
 */
export function serializeAnnotations(annotations: StoredAnnotation[]): string {
  if (annotations.length === 0) {
    return '';
  }
  // Escape --> in text, comment, prefix, and suffix fields to prevent breaking the HTML comment
  const safeAnnotations = annotations.map((a) => ({
    ...a,
    text: escapeHtmlCommentClose(a.text),
    comment: escapeHtmlCommentClose(a.comment),
    ...(a.prefix != null ? { prefix: escapeHtmlCommentClose(a.prefix) } : {}),
    ...(a.suffix != null ? { suffix: escapeHtmlCommentClose(a.suffix) } : {}),
  }));
  const json = JSON.stringify(safeAnnotations, null, 2);
  return `${ANNOTATION_COMMENT_START}\n${json}\n${ANNOTATION_COMMENT_END}`;
}

/**
 * Update document content with new annotations.
 * Replaces existing comment block or appends new one.
 */
export function updateDocumentWithAnnotations(
  content: string,
  annotations: StoredAnnotation[]
): string {
  const stripped = stripAnnotationComment(content);
  
  if (annotations.length === 0) {
    return stripped;
  }

  const comment = serializeAnnotations(annotations);
  return `${stripped}\n\n${comment}`;
}

/**
 * Find the position of a text snippet in the document using multi-signal matching.
 * When context is provided, uses offset hints and prefix/suffix scoring to disambiguate.
 * Falls back to fuzzy matching (exact → normalized → prefix) for backward compatibility.
 * Returns { from, to } or null if not found.
 */
export function findTextPosition(
  content: string,
  searchText: string,
  context?: { prefix?: string; suffix?: string; hintFrom?: number; hintTo?: number }
): { from: number; to: number } | null {
  if (!searchText) return null;

  // Fast path: offset hint check
  if (context?.hintFrom != null && context?.hintTo != null) {
    const slice = content.slice(context.hintFrom, context.hintTo);
    if (slice === searchText) {
      return { from: context.hintFrom, to: context.hintTo };
    }
  }

  // Context-aware matching: find all occurrences and score by prefix/suffix similarity
  if (context?.prefix != null || context?.suffix != null) {
    const candidates: Array<{ from: number; to: number; score: number }> = [];
    let searchStart = 0;
    while (true) {
      const idx = content.indexOf(searchText, searchStart);
      if (idx === -1) break;

      let score = 0;
      const candidateFrom = idx;
      const candidateTo = idx + searchText.length;

      // Score prefix match
      if (context.prefix) {
        const actualPrefix = content.slice(Math.max(0, candidateFrom - context.prefix.length), candidateFrom);
        if (actualPrefix.endsWith(context.prefix)) {
          score += 3; // Full prefix match
        } else if (context.prefix.length >= 10 && actualPrefix.includes(context.prefix.slice(-10))) {
          score += 1; // Partial prefix match
        }
      }

      // Score suffix match
      if (context.suffix) {
        const actualSuffix = content.slice(candidateTo, candidateTo + context.suffix.length);
        if (actualSuffix.startsWith(context.suffix)) {
          score += 3; // Full suffix match
        } else if (context.suffix.length >= 10 && actualSuffix.includes(context.suffix.slice(0, 10))) {
          score += 1; // Partial suffix match
        }
      }

      // Proximity bonus (closer to hint = better)
      if (context.hintFrom != null) {
        const distance = Math.abs(candidateFrom - context.hintFrom);
        if (distance === 0) score += 2;
        else if (distance < 50) score += 1;
      }

      candidates.push({ from: candidateFrom, to: candidateTo, score });
      searchStart = idx + 1;
    }

    if (candidates.length > 0) {
      // Sort by score descending, then by proximity to hint
      candidates.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        const aDist = context.hintFrom != null ? Math.abs(a.from - context.hintFrom) : 0;
        const bDist = context.hintFrom != null ? Math.abs(b.from - context.hintFrom) : 0;
        return aDist - bDist;
      });

      // Return best candidate if it has a meaningful score
      if (candidates[0].score > 0) {
        return { from: candidates[0].from, to: candidates[0].to };
      }
    }
  }

  // First, try exact match
  const exactIndex = content.indexOf(searchText);
  if (exactIndex !== -1) {
    return { from: exactIndex, to: exactIndex + searchText.length };
  }

  // Try normalized match (collapse whitespace)
  const normalizedSearch = searchText.replace(/\s+/g, ' ').trim();
  const normalizedContent = content.replace(/\s+/g, ' ');
  
  // Build a mapping from normalized positions back to original positions
  const positionMap: number[] = [];
  let normalizedPos = 0;
  for (let i = 0; i < content.length; i++) {
    if (content[i].match(/\s/)) {
      // Skip consecutive whitespace in original
      if (i === 0 || !content[i - 1].match(/\s/)) {
        positionMap[normalizedPos] = i;
        normalizedPos++;
      }
    } else {
      positionMap[normalizedPos] = i;
      normalizedPos++;
    }
  }

  const normalizedIndex = normalizedContent.indexOf(normalizedSearch);
  if (normalizedIndex !== -1) {
    const fromOriginal = positionMap[normalizedIndex] ?? normalizedIndex;
    // Find the end by searching for the original text starting near the found position
    const searchStart = Math.max(0, fromOriginal - 10);
    const searchEnd = Math.min(content.length, fromOriginal + searchText.length + 50);
    const region = content.slice(searchStart, searchEnd);
    
    // Look for a substring that matches when normalized
    for (let len = searchText.length - 5; len <= searchText.length + 20; len++) {
      for (let start = 0; start < region.length - len; start++) {
        const candidate = region.slice(start, start + len);
        if (candidate.replace(/\s+/g, ' ').trim() === normalizedSearch) {
          return {
            from: searchStart + start,
            to: searchStart + start + len,
          };
        }
      }
    }
    
    // Fallback: use the normalized position with original text length
    return {
      from: fromOriginal,
      to: Math.min(content.length, fromOriginal + searchText.length),
    };
  }

  // Try prefix match (for partially edited text)
  const prefixLength = Math.min(30, Math.floor(searchText.length / 2));
  if (prefixLength >= 10) {
    const prefix = searchText.slice(0, prefixLength);
    const prefixIndex = content.indexOf(prefix);
    if (prefixIndex !== -1) {
      // Found prefix, try to find a reasonable end
      const suffix = searchText.slice(-prefixLength);
      const suffixSearchStart = prefixIndex + prefix.length;
      const suffixSearchEnd = Math.min(content.length, suffixSearchStart + searchText.length * 2);
      const suffixIndex = content.indexOf(suffix, suffixSearchStart);
      
      if (suffixIndex !== -1 && suffixIndex < suffixSearchEnd) {
        return {
          from: prefixIndex,
          to: suffixIndex + suffix.length,
        };
      }
    }
  }

  return null;
}

/**
 * Recover annotations from stored format by finding their positions in the document.
 * Returns annotations with positions, marking orphaned ones.
 */
export function recoverAnnotationPositions(
  content: string,
  stored: StoredAnnotation[]
): RecoveredAnnotation[] {
  // Strip the annotation comment before searching
  const cleanContent = stripAnnotationComment(content);
  
  return stored.map((annotation) => {
    const position = findTextPosition(cleanContent, annotation.text, {
      prefix: annotation.prefix,
      suffix: annotation.suffix,
      hintFrom: annotation.from ?? annotation.textOffset,
      hintTo: annotation.to,
    });
    
    if (position) {
      return {
        ...annotation,
        from: position.from,
        to: position.to,
        recovered: true,
      };
    }
    
    // Orphaned annotation - couldn't find text
    return {
      ...annotation,
      from: -1,
      to: -1,
      recovered: false,
    };
  });
}

/**
 * Convert runtime annotations to storage format.
 * When canonicalContent is provided, computes prefix/suffix context for content-aware anchoring.
 */
export function toStoredAnnotations(
  annotations: Array<{ id: string; from?: number; to?: number; text: string; comment: string; createdAt: number }>,
  canonicalContent?: string
): StoredAnnotation[] {
  return annotations.map(({ id, from, text, comment, createdAt }) => {
    if (canonicalContent) {
      const ctx = computeAnnotationContext(canonicalContent, text, from ?? 0);
      if (ctx) {
        return {
          id,
          text,
          comment,
          createdAt,
          prefix: ctx.prefix,
          suffix: ctx.suffix,
          from: ctx.from,
          to: ctx.to,
          // Preserve textOffset for backward compat with loading paths that read it
          ...(from != null && from >= 0 ? { textOffset: from } : {}),
        };
      }
    }
    // Fallback: no content provided or text not found — use legacy format
    return {
      id,
      text,
      comment,
      createdAt,
      ...(from != null && from >= 0 ? { textOffset: from } : {}),
    };
  });
}
