/**
 * Tests for `findAllTextMatchesInDoc`.
 *
 * Repro guard for Sentry REBEL-5CK: the document find bar must locate
 * matches in the rendered ProseMirror document, not in the raw markdown
 * source. Markdown syntax characters (`#`, `**`, `[]()`, list bullets),
 * YAML frontmatter, and the persisted `<!-- rebel-annotations -->` block
 * never appear in the rendered doc, so position coordinates are different
 * from raw-source character offsets.
 *
 * We exercise the helper against a real ProseMirror document constructed
 * from `schema-basic` so position math is verified end-to-end against the
 * actual PM tree (open/close tokens at block boundaries) rather than a
 * hand-rolled mock.
 */

import { describe, it, expect } from 'vitest';
import { schema } from '@tiptap/pm/schema-basic';
import type { Node as PMNode } from '@tiptap/pm/model';
import { findAllTextMatchesInDoc } from '../tiptapAnnotationExtension';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a doc with N paragraphs from the given text strings. */
function makeDoc(...paragraphs: string[]): PMNode {
  return schema.node(
    'doc',
    null,
    paragraphs.map((p) =>
      schema.node('paragraph', null, p.length > 0 ? [schema.text(p)] : []),
    ),
  );
}

/** Build a doc with a heading + body paragraph. */
function makeHeadingDoc(heading: string, body: string): PMNode {
  return schema.node('doc', null, [
    schema.node('heading', { level: 1 }, [schema.text(heading)]),
    schema.node('paragraph', null, [schema.text(body)]),
  ]);
}

/** Read text at a PM range — what the editor would actually highlight. */
function textAt(doc: PMNode, range: { from: number; to: number }): string {
  return doc.textBetween(range.from, range.to, ' ');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('findAllTextMatchesInDoc', () => {
  it('returns empty array for empty query', () => {
    const doc = makeDoc('Hello world');
    expect(findAllTextMatchesInDoc(doc, '')).toEqual([]);
  });

  it('returns empty array when query has no occurrences', () => {
    const doc = makeDoc('Hello world');
    expect(findAllTextMatchesInDoc(doc, 'xyz')).toEqual([]);
  });

  it('finds a single match and returns PM positions that highlight the right text', () => {
    const doc = makeDoc('The quick brown fox');
    const matches = findAllTextMatchesInDoc(doc, 'brown');
    expect(matches).toHaveLength(1);
    expect(textAt(doc, matches[0])).toBe('brown');
  });

  it('finds all occurrences of a repeated word in document order', () => {
    const doc = makeDoc('apple banana apple cherry apple');
    const matches = findAllTextMatchesInDoc(doc, 'apple');
    expect(matches).toHaveLength(3);
    matches.forEach((m) => {
      expect(textAt(doc, m)).toBe('apple');
    });
    expect(matches[0].from).toBeLessThan(matches[1].from);
    expect(matches[1].from).toBeLessThan(matches[2].from);
  });

  it('matches case-insensitively', () => {
    const doc = makeDoc('Apple APPLE apple aPPle');
    const matches = findAllTextMatchesInDoc(doc, 'apple');
    expect(matches).toHaveLength(4);
    matches.forEach((m) => {
      expect(textAt(doc, m).toLowerCase()).toBe('apple');
    });
  });

  it('returns overlapping matches (advances by one character)', () => {
    const doc = makeDoc('aaaa');
    const matches = findAllTextMatchesInDoc(doc, 'aa');
    expect(matches).toHaveLength(3);
  });

  it('finds matches that cross block boundaries via the inserted-space token', () => {
    const doc = makeDoc('The quick', 'brown fox');
    const matches = findAllTextMatchesInDoc(doc, 'quick brown');
    expect(matches).toHaveLength(1);
    // PM positions span two blocks; textBetween with separator ' ' must
    // round-trip the matched substring.
    expect(textAt(doc, matches[0])).toBe('quick brown');
  });

  it('locates text inside a heading using PM positions, not source offsets', () => {
    // In the rendered doc, the heading text "Project" sits at PM position 1
    // (the doc opens at 0, heading opens at 0 → 1 is the first text
    // position). Raw markdown for the same content would be "# Project\n\n..."
    // — searching by source offset would land off-by-2 due to the "# ".
    const doc = makeHeadingDoc('Project Plan', 'Project status update');
    const matches = findAllTextMatchesInDoc(doc, 'Project');
    expect(matches).toHaveLength(2);
    matches.forEach((m) => expect(textAt(doc, m)).toBe('Project'));
    // First match is inside the heading (lower PM position), second is in
    // the body paragraph.
    expect(matches[0].from).toBeLessThan(matches[1].from);
    // Crucially, the heading match's `from` is NOT 2 (the raw-source
    // offset of "Project" inside "# Project Plan") — it's 1.
    expect(matches[0].from).toBe(1);
  });

  it('empty document yields no matches', () => {
    const doc = makeDoc('');
    expect(findAllTextMatchesInDoc(doc, 'anything')).toEqual([]);
  });

  it('preserves position math for adjacent matches', () => {
    const doc = makeDoc('abcabc');
    const matches = findAllTextMatchesInDoc(doc, 'abc');
    expect(matches).toHaveLength(2);
    expect(matches[0].to).toBe(matches[1].from);
    expect(textAt(doc, matches[0])).toBe('abc');
    expect(textAt(doc, matches[1])).toBe('abc');
  });

  it('matches text ending at the final character of the doc', () => {
    const doc = makeDoc('Hello world');
    const matches = findAllTextMatchesInDoc(doc, 'world');
    expect(matches).toHaveLength(1);
    expect(textAt(doc, matches[0])).toBe('world');
  });

  it('matches a query equal to the whole single-paragraph doc text', () => {
    const doc = makeDoc('Hello');
    const matches = findAllTextMatchesInDoc(doc, 'Hello');
    expect(matches).toHaveLength(1);
    expect(textAt(doc, matches[0])).toBe('Hello');
  });

  it('matches across multiple consecutive block boundaries', () => {
    const doc = makeDoc('alpha', 'beta', 'gamma');
    const matches = findAllTextMatchesInDoc(doc, 'alpha beta gamma');
    expect(matches).toHaveLength(1);
    expect(textAt(doc, matches[0])).toBe('alpha beta gamma');
  });
});
