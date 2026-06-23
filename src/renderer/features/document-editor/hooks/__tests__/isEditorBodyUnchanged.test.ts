import { describe, expect, it } from 'vitest';
import { isEditorBodyUnchanged } from '../useDocumentFileIO';

const BASE_BODY = '# Proposal\n\nHello team.';
const ALT_BODY = '# Proposal\n\nHello everyone.';

const ANNOTATION_A = '<!-- rebel-annotations [{"id":"a","text":"Hello","comment":"Tone tweak","createdAt":1}] -->';
const ANNOTATION_B = '<!-- rebel-annotations [{"id":"b","text":"team","comment":"Audience note","createdAt":2}] -->';

function withAnnotations(body: string, annotationComment: string): string {
  return `${body}\n\n${annotationComment}`;
}

describe('isEditorBodyUnchanged', () => {
  it('returns true for same body with different annotation blocks', () => {
    expect(
      isEditorBodyUnchanged(withAnnotations(BASE_BODY, ANNOTATION_A), withAnnotations(BASE_BODY, ANNOTATION_B)),
    ).toBe(true);
  });

  it("returns true when one side has annotations and the other doesn't", () => {
    expect(
      isEditorBodyUnchanged(withAnnotations(BASE_BODY, ANNOTATION_A), BASE_BODY),
    ).toBe(true);
  });

  it('returns false for different body text with the same annotation block', () => {
    expect(
      isEditorBodyUnchanged(withAnnotations(BASE_BODY, ANNOTATION_A), withAnnotations(ALT_BODY, ANNOTATION_A)),
    ).toBe(false);
  });

  it('returns true for identical body and identical annotation block', () => {
    expect(
      isEditorBodyUnchanged(withAnnotations(BASE_BODY, ANNOTATION_A), withAnnotations(BASE_BODY, ANNOTATION_A)),
    ).toBe(true);
  });

  it('treats annotation-only content as unchanged relative to empty content', () => {
    expect(isEditorBodyUnchanged(ANNOTATION_A, '')).toBe(true);
    expect(isEditorBodyUnchanged(`\n${ANNOTATION_A}\n`, '   ')).toBe(true);
  });

  it('does not strip HTML comments that are not rebel-annotations blocks', () => {
    const lookalikeComment = '<!-- rebel-annotation [{"id":"x"}] -->';
    expect(
      isEditorBodyUnchanged(`${BASE_BODY}\n\n${lookalikeComment}`, BASE_BODY),
    ).toBe(false);
  });
});
