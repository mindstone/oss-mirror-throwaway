// @vitest-environment happy-dom
/**
 * Round-trip contract tests for the markdown prompt ↔ TipTap doc transforms.
 *
 * Stage 1 of `docs/plans/260429_composer_rich_chips_input.md` only tokenises mode-command mentions
 * (e.g. `@CHIEF_DESIGNER `) into chips; the other three mention shapes (`` @`path` ``, conversation
 * links, `` @model:`Profile` ``) remain plain text in the editor until Stage 2 wires them up.
 *
 * The contract these tests lock:
 *   - `docToMarkdown(markdownToDoc(prompt)) === prompt` for every prompt accepted in Stage 1.
 *   - `tokenForMention()` produces the canonical wire format for each mention kind, matching
 *     `useMentionAutocomplete.insertMentionResult()` byte-for-byte.
 */

import { describe, expect, it } from 'vitest';
import {
  docToMarkdown,
  markdownIndexToPmPos,
  markdownToDoc,
  pmPosToMarkdownIndex,
  tokenForMention,
  type MentionAttrs,
} from '../promptDoc';

const ROUND_TRIP_FIXTURES = [
  '',
  'plain text',
  '@CHIEF_DESIGNER ',
  '@CHIEF_DESIGNER review this UI',
  'before @CHIEF_DESIGNER after',
  '@DESIGN_SYSTEM_REVIEWER ',
  '@DESIGN_SYSTEM_REVIEWER pick the right component',
  '@CHIEF_DESIGNER then @DESIGN_SYSTEM_REVIEWER for the tactical answer',
  'first @skills then @files paragraph',
  'multi\nline\nplain text',
  'mention on line 1\n@CHIEF_DESIGNER on line 2',
  'mid @CHIEF_DESIGNER text @designContext continued',
  'attach @`work/Mindstone/General/skills/Product-Design/MindstoneLP-UX-Auditor` please',
  'ask @[Friday Pulse](rebel://conversation/abc-123) about this',
  'use @model:`Working Brain` for the answer',
  'ask @operator:skeptical-engineer to sanity-check this',
  'mix @CHIEF_DESIGNER then @`docs/brief.md` and @[A \\[bracket\\]](rebel://conversation/c1)',
  '   leading spaces stay\n   so do trailing tabs\t',
  // Tokens that look like a command but aren't registered must round-trip unchanged.
  '@unknown_command should stay as text',
];

describe('promptDoc round-trip', () => {
  it.each(ROUND_TRIP_FIXTURES)('preserves prompt %j', (prompt) => {
    const doc = markdownToDoc(prompt);
    const restored = docToMarkdown(doc);
    expect(restored).toBe(prompt);
  });

  it('emits one mention node per command trigger', () => {
    const doc = markdownToDoc('hi @CHIEF_DESIGNER look at @designContext now');
    const paragraph = (doc.content ?? [])[0];
    const mentions = (paragraph?.content ?? []).filter((node) => node.type === 'mention');
    expect(mentions).toHaveLength(2);
    expect(mentions[0]?.attrs).toMatchObject({ kind: 'command', command: 'CHIEF_DESIGNER' });
    expect(mentions[1]?.attrs).toMatchObject({ kind: 'command', command: 'designContext' });
  });

  it('recognises @DESIGN_SYSTEM_REVIEWER as a command mention', () => {
    const doc = markdownToDoc('@CHIEF_DESIGNER then @DESIGN_SYSTEM_REVIEWER for the answer');
    const paragraph = (doc.content ?? [])[0];
    const mentions = (paragraph?.content ?? []).filter((node) => node.type === 'mention');
    expect(mentions).toHaveLength(2);
    expect(mentions[0]?.attrs).toMatchObject({ kind: 'command', command: 'CHIEF_DESIGNER' });
    expect(mentions[1]?.attrs).toMatchObject({ kind: 'command', command: 'DESIGN_SYSTEM_REVIEWER' });
  });

  it('hydrates file, conversation, model, and operator mention tokens', () => {
    const doc = markdownToDoc(
      'see @`docs/brief.md` and @[Friday Pulse](rebel://conversation/abc-123) with @model:`Working Brain` and @operator:skeptical-engineer',
      {
        resolveOperatorMention: (operatorSlug) =>
          operatorSlug === 'skeptical-engineer'
            ? { operatorId: '/space::skeptical-engineer', operatorName: 'Skeptical Engineer' }
            : null,
      },
    );
    const paragraph = (doc.content ?? [])[0];
    const mentions = (paragraph?.content ?? []).filter((node) => node.type === 'mention');
    expect(mentions).toHaveLength(4);
    expect(mentions[0]?.attrs).toMatchObject({
      kind: 'file',
      relativePath: 'docs/brief.md',
      label: 'brief.md',
    });
    expect(mentions[1]?.attrs).toMatchObject({
      kind: 'conversation',
      conversationTitle: 'Friday Pulse',
      conversationId: 'abc-123',
    });
    expect(mentions[2]?.attrs).toMatchObject({
      kind: 'model',
      profileName: 'Working Brain',
    });
    expect(mentions[3]?.attrs).toMatchObject({
      kind: 'operator',
      operatorSlug: 'skeptical-engineer',
      operatorId: '/space::skeptical-engineer',
      operatorName: 'Skeptical Engineer',
      label: 'Skeptical Engineer',
    });
  });

  it('keeps a missing Operator chip visible without leaking operatorId', () => {
    const doc = markdownToDoc('ask @operator:missing-operator please', {
      resolveOperatorMention: () => null,
    });
    const paragraph = (doc.content ?? [])[0];
    const mention = (paragraph?.content ?? []).find((node) => node.type === 'mention');
    expect(mention?.attrs).toMatchObject({
      kind: 'operator',
      operatorSlug: 'missing-operator',
      label: 'Operator not found in this Space',
      missing: true,
    });
    expect(mention?.attrs).not.toHaveProperty('operatorId');
    expect(docToMarkdown(doc)).toBe('ask @operator:missing-operator please');
  });

  it('resolves duplicate Operator slugs through the active-Space registry only', () => {
    const activeSpaceOperators = new Map([
      ['shared-slug', { operatorId: '/workspace/Active::shared-slug', operatorName: 'Active Strategist' }],
    ]);
    const doc = markdownToDoc('ask @operator:shared-slug for the critique', {
      resolveOperatorMention: (operatorSlug) => activeSpaceOperators.get(operatorSlug) ?? null,
    });
    const paragraph = (doc.content ?? [])[0];
    const mention = (paragraph?.content ?? []).find((node) => node.type === 'mention');
    expect(mention?.attrs).toMatchObject({
      kind: 'operator',
      operatorSlug: 'shared-slug',
      operatorId: '/workspace/Active::shared-slug',
      operatorName: 'Active Strategist',
      label: 'Active Strategist',
    });
    expect(mention?.attrs).not.toMatchObject({
      operatorId: '/workspace/Inactive::shared-slug',
      operatorName: 'Inactive Strategist',
    });
    expect(docToMarkdown(doc)).toBe('ask @operator:shared-slug for the critique');
  });

  it('treats unrecognised @-words as plain text', () => {
    const doc = markdownToDoc('@unknown @also_unknown');
    const paragraph = (doc.content ?? [])[0];
    const inlines = paragraph?.content ?? [];
    expect(inlines).toHaveLength(1);
    expect(inlines[0]).toMatchObject({ type: 'text', text: '@unknown @also_unknown' });
  });

  it('hydrates an empty prompt to an empty doc', () => {
    const doc = markdownToDoc('');
    expect(doc).toEqual({ type: 'doc', content: [{ type: 'paragraph' }] });
    expect(docToMarkdown(doc)).toBe('');
  });
});

describe('tokenForMention', () => {
  it('emits the trailing space for command kind', () => {
    const attrs: MentionAttrs = { kind: 'command', label: '@CHIEF_DESIGNER', command: 'CHIEF_DESIGNER' };
    expect(tokenForMention(attrs)).toBe('@CHIEF_DESIGNER ');
  });

  it('wraps file paths in backticks', () => {
    const attrs: MentionAttrs = {
      kind: 'file',
      label: 'foo.md',
      relativePath: 'docs/folder with space/foo.md',
    };
    expect(tokenForMention(attrs)).toBe('@`docs/folder with space/foo.md`');
  });

  it('escapes markdown-significant characters in conversation titles', () => {
    const attrs: MentionAttrs = {
      kind: 'conversation',
      label: 'Friday Pulse [test]',
      conversationId: 'abc-123',
      conversationTitle: 'Friday Pulse [test]',
    };
    expect(tokenForMention(attrs)).toBe('@[Friday Pulse \\[test\\]](rebel://conversation/abc-123)');
  });

  it('sanitises model profile names matching detectModelReferences()', () => {
    const attrs: MentionAttrs = {
      kind: 'model',
      label: 'Working Brain',
      profileName: 'Working Brain *!',
    };
    // The sanitiser strips characters outside [\w\s.-], matching the renderer logic in
    // `useMentionAutocomplete.insertMentionResult` and the backend's `detectModelReferences`.
    expect(tokenForMention(attrs)).toBe('@model:`Working Brain`');
  });

  it('serialises operator mentions to @operator:<slug>', () => {
    const attrs: MentionAttrs = {
      kind: 'operator',
      label: 'Skeptical Engineer',
      operatorSlug: 'skeptical-engineer',
      operatorId: '/space::skeptical-engineer',
      operatorName: 'Skeptical Engineer',
    };
    expect(tokenForMention(attrs)).toBe('@operator:skeptical-engineer');
  });
});

describe('pmPosToMarkdownIndex', () => {
  it('returns 0 at the start of the doc', () => {
    const doc = markdownToDoc('hello');
    expect(pmPosToMarkdownIndex(doc, 1)).toBe(0);
  });

  it('counts a chip as the full token length', () => {
    const doc = markdownToDoc('@CHIEF_DESIGNER hi');
    // PM positions: 0 = before doc, 1 = inside paragraph, 2 = after mention atom.
    // Markdown index 0 = before token, length('@CHIEF_DESIGNER ') = 16 → after the chip in markdown.
    expect(pmPosToMarkdownIndex(doc, 2)).toBe(16);
  });
});

describe('markdownIndexToPmPos', () => {
  it('returns the first paragraph text position for markdown index 0', () => {
    const doc = markdownToDoc('hello');
    expect(markdownIndexToPmPos(doc, 0)).toBe(1);
  });

  it('maps plain text offsets to equivalent ProseMirror positions', () => {
    const doc = markdownToDoc('hello');
    expect(markdownIndexToPmPos(doc, 3)).toBe(4);
  });

  it('maps the end of a command token to after the mention atom', () => {
    const doc = markdownToDoc('@CHIEF_DESIGNER hi');
    expect(markdownIndexToPmPos(doc, '@CHIEF_DESIGNER '.length)).toBe(2);
  });

  it('round-trips text offsets in a mixed command prompt', () => {
    const prompt = 'before @CHIEF_DESIGNER after';
    const doc = markdownToDoc(prompt);
    const afterPromptIndex = prompt.length;
    const pmPos = markdownIndexToPmPos(doc, afterPromptIndex);
    expect(pmPosToMarkdownIndex(doc, pmPos)).toBe(afterPromptIndex);
  });
});

// ---------------------------------------------------------------------------
// Stage 2 — Property-based round-trip tests.
//
// `fast-check` is NOT currently a dependency of this project (verified via
// `Grep '"fast-check"' package.json` at the time of writing). Rather than
// pulling in a new test-only dependency, we run a **deterministic-seeded
// property test** with the same shape: generate ~200 random-but-reproducible
// inputs spanning newlines, NBSP-family entities, and mention tokens; assert
// `docToMarkdown(markdownToDoc(s))` is stable post-sanitisation (i.e. running
// the round-trip a second time is a no-op).
//
// If `fast-check` is added later, swap the body for `fc.assert(fc.property(...))`
// using the same generator — the contract being asserted is identical.
// ---------------------------------------------------------------------------
describe('promptDoc round-trip (Stage 2 — deterministic-seeded property tests)', () => {
  /**
   * Mulberry32 PRNG — deterministic seeded RNG so failing cases are reproducible
   * across CI runs. A future migration to `fast-check` would replace this with
   * `fc.context()`'s seeded arbitraries.
   */
  function mulberry32(seed: number): () => number {
    let s = seed | 0;
    return () => {
      s = (s + 0x6d2b79f5) | 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const NBSP_VARIANTS = ['&nbsp;', '\u00a0', '&NBSP;', '&#160;', '&#xA0;', '&amp;nbsp;'];
  const COMMANDS = ['@CHIEF_DESIGNER ', '@DESIGN_SYSTEM_REVIEWER ', '@designContext ', '@skills '];
  const FILE_TOKENS = ['@`docs/brief.md`', '@`work/foo bar/file.md`'];
  const MODEL_TOKENS = ['@model:`Working Brain`', '@model:`Claude Sonnet 4`'];
  const CONV_TOKENS = ['@[Friday Pulse](rebel://conversation/abc-123)'];
  const ALPHANUM = 'abcdefghijklmnopqrstuvwxyz0123456789';

  /**
   * Generate a deterministic random string up to ~200 chars containing arbitrary
   * mixes of newlines, NBSP variants, mention tokens, and plain text.
   */
  function generateInput(rng: () => number): string {
    const targetLen = Math.floor(rng() * 200);
    let out = '';
    while (out.length < targetLen) {
      const r = rng();
      if (r < 0.1) {
        out += '\n';
      } else if (r < 0.18) {
        out += '\n\n';
      } else if (r < 0.24) {
        out += NBSP_VARIANTS[Math.floor(rng() * NBSP_VARIANTS.length)];
      } else if (r < 0.28) {
        out += COMMANDS[Math.floor(rng() * COMMANDS.length)];
      } else if (r < 0.31) {
        out += FILE_TOKENS[Math.floor(rng() * FILE_TOKENS.length)];
      } else if (r < 0.33) {
        out += MODEL_TOKENS[Math.floor(rng() * MODEL_TOKENS.length)];
      } else if (r < 0.34) {
        out += CONV_TOKENS[Math.floor(rng() * CONV_TOKENS.length)];
      } else if (r < 0.45) {
        out += ' ';
      } else {
        out += ALPHANUM[Math.floor(rng() * ALPHANUM.length)];
      }
    }
    return out;
  }

  it('roundTrip(roundTrip(input)) === roundTrip(input) for 200 deterministic-seeded inputs', () => {
    const rng = mulberry32(0xc0ffee);
    const failures: Array<{ input: string; firstPass: string; secondPass: string }> = [];
    for (let i = 0; i < 200; i++) {
      const input = generateInput(rng);
      const firstPass = docToMarkdown(markdownToDoc(input));
      const secondPass = docToMarkdown(markdownToDoc(firstPass));
      if (firstPass !== secondPass) {
        failures.push({ input, firstPass, secondPass });
      }
    }
    if (failures.length > 0) {
      // Surface the first failing case for fast diagnosis.
      console.error('First non-idempotent case:', JSON.stringify(failures[0], null, 2));
    }
    expect(failures).toEqual([]);
  });

  it('round-trip output never contains `&nbsp;` or `\\u00a0` (sanitiser purges all variants)', () => {
    const rng = mulberry32(0xb00fed);
    for (let i = 0; i < 200; i++) {
      const input = generateInput(rng);
      const out = docToMarkdown(markdownToDoc(input));
      expect(out, `input=${JSON.stringify(input)}`).not.toContain('&nbsp;');
      expect(out, `input=${JSON.stringify(input)}`).not.toContain('\u00a0');
      expect(out, `input=${JSON.stringify(input)}`).not.toContain('&NBSP;');
      expect(out, `input=${JSON.stringify(input)}`).not.toContain('&#160;');
    }
  });

  // TODO(fast-check): When fast-check is added to the project deps, replace the
  // deterministic-seeded loop with:
  //   fc.assert(fc.property(arbitraryComposerPrompt, p => {
  //     const a = docToMarkdown(markdownToDoc(p));
  //     const b = docToMarkdown(markdownToDoc(a));
  //     return a === b;
  //   }), { numRuns: 200 });
  // The generator above (`generateInput`) is a direct stand-in for the
  // arbitrary; both produce 200 cases per run with the same shape coverage.
});
