// @vitest-environment happy-dom
/**
 * Unit tests for the `toComposerWireMarkdown` constructor — the single
 * sanctioned path for branding arbitrary strings as `ComposerWireMarkdown`.
 *
 * The brand encodes the invariant that a string has been through the canonical
 * NBSP-family sanitiser. These tests assert:
 *   - identity for non-corrupted inputs (no transformation when nothing to
 *     sanitise);
 *   - idempotency (applying twice equals applying once);
 *   - coverage of every NBSP-family variant the editor can encounter
 *     (matching `sanitiseCorruptedDraftText`'s contract).
 *
 * See `docs-private/investigations/260505_composer_nbsp_recurrence.md` Stage 1.
 */

import { describe, expect, it } from 'vitest';
import { toComposerWireMarkdown } from '../composerMarkdown';

describe('toComposerWireMarkdown', () => {
  it('returns non-corrupted strings unchanged', () => {
    const cases = [
      '',
      'hello world',
      'plain\nmulti\nline',
      'first\n\nsecond',
      '@CHIEF_DESIGNER review the brief',
      'mix @`docs/brief.md` and @[Friday Pulse](rebel://conversation/abc-123)',
      '   leading + trailing spaces   ',
    ];
    for (const input of cases) {
      expect(toComposerWireMarkdown(input)).toBe(input);
    }
  });

  it('strips sentinel-context NBSP variants (sole content of an empty line)', () => {
    expect(toComposerWireMarkdown('first\n&nbsp;\nsecond')).toBe('first\n\nsecond');
    expect(toComposerWireMarkdown('first\n\u00a0\nsecond')).toBe('first\n\nsecond');
    expect(toComposerWireMarkdown('first\n&NBSP;\nsecond')).toBe('first\n\nsecond');
    expect(toComposerWireMarkdown('first\n&#160;\nsecond')).toBe('first\n\nsecond');
    expect(toComposerWireMarkdown('first\n&#xA0;\nsecond')).toBe('first\n\nsecond');
    expect(toComposerWireMarkdown('first\n&amp;nbsp;\nsecond')).toBe('first\n\nsecond');
  });

  it('replaces inline NBSP variants with a single regular space (preserves word boundaries)', () => {
    expect(toComposerWireMarkdown('hello&nbsp;world')).toBe('hello world');
    expect(toComposerWireMarkdown('hello\u00a0world')).toBe('hello world');
    expect(toComposerWireMarkdown('hello&NBSP;world')).toBe('hello world');
    expect(toComposerWireMarkdown('hello&#160;world')).toBe('hello world');
    expect(toComposerWireMarkdown('hello&#xA0;world')).toBe('hello world');
    expect(toComposerWireMarkdown('hello&amp;nbsp;world')).toBe('hello world');
  });

  it('handles the user-screenshot fingerprint shape (stacked sentinel paragraphs + inline run)', () => {
    const corrupted = 'hello&nbsp;world\n\n&nbsp;\n\n&nbsp;\n\nfoo&nbsp;bar';
    expect(toComposerWireMarkdown(corrupted)).toBe('hello world\n\n\n\n\n\nfoo bar');
    expect(toComposerWireMarkdown(corrupted)).not.toContain('&nbsp;');
    expect(toComposerWireMarkdown(corrupted)).not.toContain('\u00a0');
  });

  it('is idempotent: toWire(toWire(x)) === toWire(x)', () => {
    const inputs = [
      '',
      'plain',
      'hello&nbsp;world',
      'a\n&nbsp;\nb',
      '@CHIEF_DESIGNER\nmid\u00a0space\n\n&NBSP;\n\nfoo',
      'mixed&amp;nbsp;and&#160;and\u00a0and&NBSP;',
    ];
    for (const input of inputs) {
      const once = toComposerWireMarkdown(input);
      const twice = toComposerWireMarkdown(once);
      expect(twice).toBe(once);
    }
  });

  it('preserves the brand at the type level (string at runtime)', () => {
    // The brand is a compile-time invariant; at runtime it is just a string.
    // The function is callable in a string position; consumers downstream
    // type-check against `ComposerWireMarkdown`.
    const branded = toComposerWireMarkdown('hello world');
    // Runtime string equality holds.
    expect(typeof branded).toBe('string');
    expect(branded).toBe('hello world');
  });
});
