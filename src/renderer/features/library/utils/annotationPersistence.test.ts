/**
 * annotationPersistence.test.ts
 *
 * TDD tests for FOX-2622: Library annotations don't follow text position after save/reload.
 *
 * These tests reproduce the exact bug: annotations are serialized with only text content,
 * so after text edits + save/reload, positions are recovered incorrectly when:
 * - The annotated text appears multiple times in the document
 * - Text was inserted/deleted before the annotation (shifting its position)
 * - The annotated text was partially edited
 *
 * The fix extends StoredAnnotation with prefix/suffix context and multi-signal recovery.
 */

import { describe, it, expect } from 'vitest';
import {
  parseAnnotationsFromDocument,
  recoverAnnotationPositions,
  serializeAnnotations,
  stripAnnotationComment,
  findTextPosition,
  toStoredAnnotations,
  updateDocumentWithAnnotations,
  type StoredAnnotation,
} from './annotationPersistence';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Simulate a full save/reload cycle: serialize annotations into the doc, then recover them. */
function _roundTrip(
  documentContent: string,
  annotations: StoredAnnotation[]
): { content: string; recovered: ReturnType<typeof recoverAnnotationPositions> } {
  const withAnnotations = updateDocumentWithAnnotations(documentContent, annotations);
  const parsed = parseAnnotationsFromDocument(withAnnotations);
  const recovered = recoverAnnotationPositions(withAnnotations, parsed);
  return { content: withAnnotations, recovered };
}

// ===========================================================================
// BUG REPRODUCTION: These tests reproduce the exact issues from FOX-2622
// They should FAIL with the current implementation, then PASS after the fix.
// ===========================================================================

describe('FOX-2622: Annotations should follow text position after save/reload', () => {
  describe('Bug: duplicate text disambiguation (confirms bug)', () => {
    it('should recover the SECOND occurrence when annotation was on the second "important" in the doc', () => {
      // Setup: document with duplicate text
      const content = [
        'This is an important point about the project.',
        '',
        'Another paragraph with different content.',
        '',
        'This is an important point about the deadline.',
      ].join('\n');

      // The annotation is on the SECOND "important" (in the deadline sentence)
      const annotationText = 'important';
      const secondOccurrenceFrom = content.lastIndexOf(annotationText);

      // Store annotation with context about the second occurrence
      const stored: StoredAnnotation[] = [{
        id: 'ann-1',
        text: annotationText,
        comment: 'This deadline is critical',
        createdAt: Date.now(),
        // With the fix, we'd have prefix/suffix to disambiguate.
        // Without it, findTextPosition returns the FIRST occurrence.
        prefix: 'This is an ',
        suffix: ' point about the deadline.',
        from: secondOccurrenceFrom,
        to: secondOccurrenceFrom + annotationText.length,
      }];

      const recovered = recoverAnnotationPositions(content, stored);

      expect(recovered).toHaveLength(1);
      expect(recovered[0].recovered).toBe(true);
      // The critical assertion: should find the SECOND occurrence, not the first
      expect(recovered[0].from).toBe(secondOccurrenceFrom);
      expect(recovered[0].to).toBe(secondOccurrenceFrom + annotationText.length);
    });
  });

  describe('Bug: text inserted before annotation shifts position (confirms bug)', () => {
    it('should recover correct position after text is inserted before the annotation', () => {
      // BEFORE edit: annotation on "quarterly results"
      const originalContent = 'The company reported strong quarterly results this year.';
      const annotationText = 'quarterly results';
      const originalFrom = originalContent.indexOf(annotationText);

      // Save annotation with context from original content
      const stored: StoredAnnotation[] = [{
        id: 'ann-1',
        text: annotationText,
        comment: 'Need to verify these numbers',
        createdAt: Date.now(),
        prefix: 'reported strong ',
        suffix: ' this year.',
        from: originalFrom,
        to: originalFrom + annotationText.length,
      }];

      // AFTER edit: user inserted "According to the CEO, " at the start
      const editedContent = 'According to the CEO, the company reported strong quarterly results this year.';
      const expectedNewFrom = editedContent.indexOf(annotationText);

      const recovered = recoverAnnotationPositions(editedContent, stored);

      expect(recovered).toHaveLength(1);
      expect(recovered[0].recovered).toBe(true);
      // The annotation should have shifted to the new position
      expect(recovered[0].from).toBe(expectedNewFrom);
      expect(recovered[0].to).toBe(expectedNewFrom + annotationText.length);
    });
  });

  describe('Bug: text deleted before annotation shifts position (confirms bug)', () => {
    it('should recover correct position after text is deleted before the annotation', () => {
      // BEFORE edit
      const originalContent = 'Introduction paragraph.\n\nThe key finding is that revenue grew by 15%.';
      const annotationText = 'revenue grew by 15%';
      const originalFrom = originalContent.indexOf(annotationText);

      const stored: StoredAnnotation[] = [{
        id: 'ann-1',
        text: annotationText,
        comment: 'Impressive growth',
        createdAt: Date.now(),
        prefix: 'finding is that ',
        suffix: '.',
        from: originalFrom,
        to: originalFrom + annotationText.length,
      }];

      // AFTER edit: "Introduction paragraph.\n\n" was deleted
      const editedContent = 'The key finding is that revenue grew by 15%.';
      const expectedNewFrom = editedContent.indexOf(annotationText);

      const recovered = recoverAnnotationPositions(editedContent, stored);

      expect(recovered).toHaveLength(1);
      expect(recovered[0].recovered).toBe(true);
      expect(recovered[0].from).toBe(expectedNewFrom);
      expect(recovered[0].to).toBe(expectedNewFrom + annotationText.length);
    });
  });

  describe('Full round-trip: save, edit, reload', () => {
    it('should survive a full save/edit/reload cycle with text insertions', () => {
      // Step 1: Original document with annotation
      const originalContent = 'First paragraph.\n\nSecond paragraph with key insight here.\n\nThird paragraph.';
      const annotationText = 'key insight';
      const from = originalContent.indexOf(annotationText);

      // Simulate what toStoredAnnotations should produce with content
      const stored: StoredAnnotation[] = [{
        id: 'ann-1',
        text: annotationText,
        comment: 'Expand on this',
        createdAt: Date.now(),
        prefix: 'paragraph with ',
        suffix: ' here.',
        from,
        to: from + annotationText.length,
      }];

      // Step 2: Save to document
      const savedDoc = updateDocumentWithAnnotations(originalContent, stored);

      // Step 3: User edits the document (adds a paragraph before the annotation)
      const editedDoc = savedDoc.replace(
        'First paragraph.',
        'First paragraph.\n\nNew inserted paragraph with extra context.'
      );

      // Step 4: Reload — parse and recover
      const parsed = parseAnnotationsFromDocument(editedDoc);
      const cleanEdited = stripAnnotationComment(editedDoc);
      const recovered = recoverAnnotationPositions(cleanEdited, parsed);

      const expectedFrom = cleanEdited.indexOf(annotationText);

      expect(recovered).toHaveLength(1);
      expect(recovered[0].recovered).toBe(true);
      expect(recovered[0].from).toBe(expectedFrom);
      expect(recovered[0].to).toBe(expectedFrom + annotationText.length);
      // Verify the recovered text is correct
      expect(cleanEdited.slice(recovered[0].from, recovered[0].to)).toBe(annotationText);
    });
  });
});

// ===========================================================================
// EXISTING BEHAVIOR: These tests should PASS with current implementation
// (baseline — ensures we don't regress existing functionality)
// ===========================================================================

describe('Existing annotation persistence (baseline)', () => {
  describe('parseAnnotationsFromDocument', () => {
    it('parses annotations from HTML comment block', () => {
      const content = 'Hello world\n\n<!-- rebel-annotations\n[{"id":"a1","text":"world","comment":"nice","createdAt":1}]\n-->';
      const result = parseAnnotationsFromDocument(content);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ id: 'a1', text: 'world', comment: 'nice' });
    });

    it('returns empty array when no annotations', () => {
      expect(parseAnnotationsFromDocument('Just some text')).toEqual([]);
    });

    it('handles malformed JSON gracefully', () => {
      const content = '<!-- rebel-annotations\n{bad json}\n-->';
      expect(parseAnnotationsFromDocument(content)).toEqual([]);
    });

    it('preserves new optional fields (prefix, suffix, from, to) when present', () => {
      const stored = [{
        id: 'a1', text: 'hello', comment: 'test', createdAt: 1,
        prefix: 'say ', suffix: ' world', from: 4, to: 9,
      }];
      const content = `doc\n\n<!-- rebel-annotations\n${JSON.stringify(stored)}\n-->`;
      const parsed = parseAnnotationsFromDocument(content);
      expect(parsed[0].prefix).toBe('say ');
      expect(parsed[0].suffix).toBe(' world');
      expect(parsed[0].from).toBe(4);
      expect(parsed[0].to).toBe(9);
    });

    it('handles old format annotations (no prefix/suffix) gracefully', () => {
      const stored = [{ id: 'a1', text: 'hello', comment: 'test', createdAt: 1 }];
      const content = `doc\n\n<!-- rebel-annotations\n${JSON.stringify(stored)}\n-->`;
      const parsed = parseAnnotationsFromDocument(content);
      expect(parsed[0].prefix).toBeUndefined();
      expect(parsed[0].suffix).toBeUndefined();
    });
  });

  describe('serializeAnnotations', () => {
    it('escapes --> in text and comment fields', () => {
      const annotations: StoredAnnotation[] = [{
        id: 'a1', text: 'has --> arrow', comment: 'also --> here', createdAt: 1,
      }];
      const result = serializeAnnotations(annotations);
      // Strip the closing HTML comment tag before checking — it legitimately contains -->
      const jsonBody = result.replace(/\n-->$/, '');
      expect(jsonBody).not.toContain('-->');
      // JSON.stringify doubles the backslash, so the serialized JSON contains --\\u003e
      expect(result).toContain('--\\\\u003e');
    });

    it('escapes --> in prefix and suffix fields', () => {
      const annotations: StoredAnnotation[] = [{
        id: 'a1', text: 'hello', comment: 'test', createdAt: 1,
        prefix: 'before --> text', suffix: 'after --> text',
      }];
      const result = serializeAnnotations(annotations);
      // Should not have unescaped --> (other than the closing comment tag)
      const withoutClosingTag = result.replace(/\n-->$/, '');
      expect(withoutClosingTag).not.toContain('-->');
    });

    it('returns empty string for no annotations', () => {
      expect(serializeAnnotations([])).toBe('');
    });
  });

  describe('stripAnnotationComment', () => {
    it('removes the annotation comment block', () => {
      const content = 'Hello\n\n<!-- rebel-annotations\n[]\n-->';
      expect(stripAnnotationComment(content)).toBe('Hello');
    });

    it('leaves content unchanged when no comment block', () => {
      expect(stripAnnotationComment('Hello world')).toBe('Hello world');
    });
  });

  describe('findTextPosition (existing fuzzy matching)', () => {
    it('finds exact text match', () => {
      const result = findTextPosition('Hello beautiful world', 'beautiful');
      expect(result).toEqual({ from: 6, to: 15 });
    });

    it('returns null when text not found', () => {
      expect(findTextPosition('Hello world', 'missing')).toBeNull();
    });

    it('handles whitespace normalization', () => {
      const result = findTextPosition('Hello   beautiful   world', 'beautiful');
      expect(result).not.toBeNull();
      expect(result!.from).toBeGreaterThanOrEqual(0);
    });
  });

  describe('recoverAnnotationPositions', () => {
    it('recovers simple annotation by text match', () => {
      const content = 'The quick brown fox jumps over the lazy dog.';
      const stored: StoredAnnotation[] = [{
        id: 'a1', text: 'brown fox', comment: 'nice animal', createdAt: 1,
      }];
      const recovered = recoverAnnotationPositions(content, stored);
      expect(recovered).toHaveLength(1);
      expect(recovered[0].recovered).toBe(true);
      expect(content.slice(recovered[0].from, recovered[0].to)).toBe('brown fox');
    });

    it('marks orphaned annotations when text not found', () => {
      const content = 'Completely different content.';
      const stored: StoredAnnotation[] = [{
        id: 'a1', text: 'nonexistent text', comment: 'gone', createdAt: 1,
      }];
      const recovered = recoverAnnotationPositions(content, stored);
      expect(recovered[0].recovered).toBe(false);
      expect(recovered[0].from).toBe(-1);
    });

    it('backward compat: old annotations without prefix/suffix recover via text search', () => {
      const content = 'This is a unique phrase in the document.';
      const stored: StoredAnnotation[] = [{
        id: 'a1', text: 'unique phrase', comment: 'comment', createdAt: 1,
        // No prefix, suffix, from, to — old format
      }];
      const recovered = recoverAnnotationPositions(content, stored);
      expect(recovered[0].recovered).toBe(true);
      expect(content.slice(recovered[0].from, recovered[0].to)).toBe('unique phrase');
    });
  });

  describe('toStoredAnnotations', () => {
    it('converts runtime annotations to storage format', () => {
      const annotations = [{
        id: 'a1', from: 10, text: 'hello', comment: 'test', createdAt: 123,
      }];
      const result = toStoredAnnotations(annotations);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('a1');
      expect(result[0].text).toBe('hello');
    });
  });
});

// ===========================================================================
// CONTEXT-AWARE ANCHORING: Tests for the new prefix/suffix functionality
// These should FAIL until the fix is implemented.
// ===========================================================================

describe('Context-aware anchoring (new functionality)', () => {
  describe('findTextPosition with context', () => {
    it('uses offset hint as fast path when text matches at stored position', () => {
      const content = 'The word important appears in this important document about important things.';
      // Offset hint points to the second "important"
      const secondFrom = content.indexOf('important', content.indexOf('important') + 1);

      const result = findTextPosition(content, 'important', {
        hintFrom: secondFrom,
        hintTo: secondFrom + 'important'.length,
      });

      expect(result).not.toBeNull();
      expect(result!.from).toBe(secondFrom);
    });

    it('falls through offset hint when text changed at that position', () => {
      const content = 'The word significant appears here. And important too.';
      // Hint points to where "important" USED to be (now "significant")
      const result = findTextPosition(content, 'important', {
        hintFrom: 9,
        hintTo: 20,
      });

      expect(result).not.toBeNull();
      // Should find "important" at its actual position, not the stale hint
      expect(content.slice(result!.from, result!.to)).toBe('important');
    });

    it('uses prefix+suffix to disambiguate duplicate text', () => {
      const content = 'The cat sat on the mat. The cat sat on the hat.';
      // We want the second "cat sat"
      const secondFrom = content.lastIndexOf('cat sat');

      const result = findTextPosition(content, 'cat sat', {
        prefix: '. The ',
        suffix: ' on the hat.',
      });

      expect(result).not.toBeNull();
      expect(result!.from).toBe(secondFrom);
    });

    it('uses prefix+suffix when text shifted due to insertions', () => {
      // After editing: a paragraph was inserted before the target
      const content = 'New first paragraph.\n\nThe key finding is that revenue grew by 15%.';
      const expectedFrom = content.indexOf('revenue grew');

      const result = findTextPosition(content, 'revenue grew', {
        prefix: 'is that ',
        suffix: ' by 15%.',
        hintFrom: 10, // Stale hint from before the insertion
        hintTo: 22,
      });

      expect(result).not.toBeNull();
      expect(result!.from).toBe(expectedFrom);
    });

    it('falls back to fuzzy search when no context provided (backward compat)', () => {
      const content = 'Hello beautiful world';
      const result = findTextPosition(content, 'beautiful');
      expect(result).toEqual({ from: 6, to: 15 });
    });
  });

  describe('recoverAnnotationPositions with context fields', () => {
    it('uses prefix/suffix to recover correct position for duplicate text', () => {
      const content = 'Item A is good. Item B is good. Item C is great.';
      const secondGoodFrom = content.indexOf('good', content.indexOf('good') + 1);

      const stored: StoredAnnotation[] = [{
        id: 'ann-1',
        text: 'good',
        comment: 'Is it though?',
        createdAt: Date.now(),
        prefix: 'B is ',
        suffix: '. Item C',
        from: secondGoodFrom,
        to: secondGoodFrom + 4,
      }];

      const recovered = recoverAnnotationPositions(content, stored);
      expect(recovered[0].recovered).toBe(true);
      expect(recovered[0].from).toBe(secondGoodFrom);
      expect(content.slice(recovered[0].from, recovered[0].to)).toBe('good');
    });

    it('recovers multiple annotations with shifted positions', () => {
      const content = 'Added intro.\n\nFirst point here. Second point there.';
      const firstFrom = content.indexOf('First point');
      const secondFrom = content.indexOf('Second point');

      const stored: StoredAnnotation[] = [
        {
          id: 'ann-1', text: 'First point', comment: 'expand', createdAt: 1,
          prefix: 'intro.\n\n', suffix: ' here.',
          from: 0, to: 11, // Stale offsets from before "Added intro.\n\n" was added
        },
        {
          id: 'ann-2', text: 'Second point', comment: 'clarify', createdAt: 2,
          prefix: ' here. ', suffix: ' there.',
          from: 18, to: 30, // Stale offsets
        },
      ];

      const recovered = recoverAnnotationPositions(content, stored);

      expect(recovered[0].recovered).toBe(true);
      expect(recovered[0].from).toBe(firstFrom);
      expect(content.slice(recovered[0].from, recovered[0].to)).toBe('First point');

      expect(recovered[1].recovered).toBe(true);
      expect(recovered[1].from).toBe(secondFrom);
      expect(content.slice(recovered[1].from, recovered[1].to)).toBe('Second point');
    });
  });

  describe('toStoredAnnotations with canonical content', () => {
    it('includes prefix/suffix/from/to when canonical content is provided', () => {
      const content = 'The quick brown fox jumps over the lazy dog.';
      const annotations = [{
        id: 'a1', from: 10, to: 19, text: 'brown fox', comment: 'nice', createdAt: 1,
      }];

      const stored = toStoredAnnotations(annotations, content);

      expect(stored[0].prefix).toBeDefined();
      expect(stored[0].suffix).toBeDefined();
      expect(stored[0].from).toBeDefined();
      expect(stored[0].to).toBeDefined();
      // Prefix should be text before "brown fox"
      expect(stored[0].prefix).toContain('quick');
      // Suffix should be text after "brown fox"
      expect(stored[0].suffix).toContain('jumps');
    });

    it('omits prefix/suffix when no content provided (backward compat)', () => {
      const annotations = [{
        id: 'a1', from: 10, to: 19, text: 'brown fox', comment: 'nice', createdAt: 1,
      }];

      const stored = toStoredAnnotations(annotations);

      expect(stored[0].prefix).toBeUndefined();
      expect(stored[0].suffix).toBeUndefined();
    });

    it('handles annotation at document start (empty prefix)', () => {
      const content = 'brown fox jumps over the lazy dog.';
      const annotations = [{
        id: 'a1', from: 0, to: 9, text: 'brown fox', comment: 'nice', createdAt: 1,
      }];

      const stored = toStoredAnnotations(annotations, content);

      expect(stored[0].prefix).toBe('');
      expect(stored[0].suffix).toBeDefined();
      expect(stored[0].suffix).toContain('jumps');
    });

    it('handles annotation at document end (empty suffix)', () => {
      const content = 'The quick brown fox';
      const annotations = [{
        id: 'a1', from: 10, to: 19, text: 'brown fox', comment: 'nice', createdAt: 1,
      }];

      const stored = toStoredAnnotations(annotations, content);

      expect(stored[0].suffix).toBe('');
      expect(stored[0].prefix).toBeDefined();
      expect(stored[0].prefix).toContain('quick');
    });
  });

  describe('serialize/parse round-trip preserves context fields', () => {
    it('prefix/suffix survive serialization and deserialization', () => {
      const stored: StoredAnnotation[] = [{
        id: 'a1', text: 'hello', comment: 'test', createdAt: 1,
        prefix: 'before text ', suffix: ' after text',
        from: 13, to: 18,
      }];

      const serialized = serializeAnnotations(stored);
      const content = `doc content\n\n${serialized}`;
      const parsed = parseAnnotationsFromDocument(content);

      expect(parsed[0].prefix).toBe('before text ');
      expect(parsed[0].suffix).toBe(' after text');
      expect(parsed[0].from).toBe(13);
      expect(parsed[0].to).toBe(18);
    });

    it('prefix/suffix with --> are escaped and unescaped correctly', () => {
      const stored: StoredAnnotation[] = [{
        id: 'a1', text: 'hello', comment: 'test', createdAt: 1,
        prefix: 'code: a --> b ', suffix: ' then c --> d',
      }];

      const serialized = serializeAnnotations(stored);
      // The serialized form should not break the HTML comment
      expect(serialized).toContain('<!-- rebel-annotations');
      expect(serialized).toMatch(/-->$/); // ends with -->

      const content = `doc\n\n${serialized}`;
      const parsed = parseAnnotationsFromDocument(content);

      expect(parsed[0].prefix).toBe('code: a --> b ');
      expect(parsed[0].suffix).toBe(' then c --> d');
    });
  });
});
