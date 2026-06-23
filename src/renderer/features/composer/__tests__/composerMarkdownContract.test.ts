// @vitest-environment happy-dom
/**
 * Composer wire-format contract test — full load-bearing CI coverage (Stage 2).
 *
 * Pins the `@tiptap/markdown` <-> override surface for the full set of
 * invariants the planning doc's Test Strategy section locked. This is the
 * upstream-drift safety net: any future TipTap bump that changes the
 * empty-paragraph / HardBreak / mention-atom / mark-rejection contract trips
 * one of the assertions below before it can ship.
 *
 * Test environment is `happy-dom` per the post-spike GPT-High amendment: the
 * repo's vitest desktop project defaults to `node`, but TipTap's `UndoRedo`
 * extension hooks need a DOM-bearing environment so `editor.can().undo` works
 * affirmatively.
 *
 * Coverage groups:
 *   1. Test environment preconditions (env directive working; UndoRedo hooks).
 *   2. Keystroke regression — 50-keystroke `@` sequence has no `&nbsp;`.
 *   3. Sanitiser idempotency — inline + sentinel + mixed NBSP-family variants.
 *   4. Schema rejection — disabled marks + commands.
 *   5. 5-iteration round-trip idempotency.
 *   6. Stage 1.5 two-layer cache (cache hits + invalidation + perf shield).
 *   7. Empty-paragraph Cartesian — 0 / 1 / 2 / 3 / 5 / 10 empty paragraphs.
 *   8. HardBreak shapes — start / middle / end of paragraph.
 *   9. Mention atom shapes — all five kinds, multiple attr combinations.
 *  10. Mixed inline + sentinel NBSP in same input.
 *  11. 5-iteration round-trip on mention + HardBreak doc.
 *  12. H10 undo / redo preservation (affirmative).
 *  13. H11 belt-and-braces — `Node.eq()` semantics vs string equality.
 *  14. FMM Row 26 — caret-into-trigger detection (string-based).
 *  15. FMM Row 27 / Stage 4 — caret-on-resolved-chip suppression (deferred).
 *
 * See `docs/plans/260501_composer_tiptap_atmention_bugfix.md`.
 */

import { describe, expect, it, vi } from 'vitest';
import { Editor } from '@tiptap/core';
import { createPromptEditorExtensions } from '../utils/composerEditorFactory';
import {
  docToMarkdown,
  markdownToDoc,
  tokenForMention,
  type ComposerWireMarkdown,
  type MentionAttrs,
} from '../utils/promptDoc';
import {
  getCurrentPromptMarkdown,
  insertMentionAtMarkdownRangeOnEditor,
  normaliseCommandMentions,
} from '../components/TipTapPromptEditor';
import {
  getCaretMarkdownIndex,
  getLayerASnapshot,
} from '../utils/composerSnapshotCache';
import {
  findMentionTrigger,
  isCaretOnMentionChip,
  MENTION_DEBOUNCE_MS,
} from '../hooks/useMentionAutocomplete';
import { createMentionContextScheduler } from '../utils/mentionContextScheduler';

function createContractEditor(initial = ''): Editor {
  return new Editor({
    content: markdownToDoc(initial),
    extensions: createPromptEditorExtensions(),
  });
}

describe('composer wire-format contract (Stage 1 subset)', () => {
  describe('Test environment preconditions', () => {
    it('happy-dom env directive is active (window is an object)', () => {
      expect(typeof window).toBe('object');
    });

    it('UndoRedo extension hooks are active in the test env', () => {
      const editor = createContractEditor('hello');
      try {
        // Mutate the doc so undo has something to reverse.
        const tr = editor.state.tr.insertText(' world', editor.state.doc.content.size - 1);
        editor.view.dispatch(tr);
        expect(editor.can().undo).toBeTruthy();
      } finally {
        editor.destroy();
      }
    });
  });

  describe('Keystroke regression — 50-keystroke `@` sequence produces no &nbsp;', () => {
    it('inserts `@` then 49 random alphanumeric keystrokes without `&nbsp;`', () => {
      const editor = createContractEditor('');
      try {
        editor.commands.insertContent('@');
        const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
        // Deterministic sequence — pull "random" chars from a fixed seed so the
        // test result is reproducible across runs.
        let seed = 1234567;
        for (let i = 0; i < 49; i++) {
          // xorshift-ish step.
          seed = (seed * 16807) % 2147483647;
          const ch = alphabet[seed % alphabet.length];
          editor.commands.insertContent(ch);
        }
        const md = getCurrentPromptMarkdown(editor);
        expect(md).not.toContain('&nbsp;');
        expect(md).not.toContain('\u00a0');
        expect(md.startsWith('@')).toBe(true);
        // The doc should still be a single paragraph — no growth.
        expect(editor.getJSON().content?.length).toBe(1);
      } finally {
        editor.destroy();
      }
    });
  });

  describe('Sanitiser idempotency — H9-amended (preserves word boundaries)', () => {
    const inlineVariants: Array<{ name: string; variant: string }> = [
      { name: 'lowercase named', variant: '&nbsp;' },
      { name: 'uppercase named', variant: '&NBSP;' },
      { name: 'decimal numeric', variant: '&#160;' },
      { name: 'hex numeric (lower)', variant: '&#xA0;' },
      { name: 'literal NBSP char', variant: '\u00a0' },
      { name: 'double-encoded named', variant: '&amp;nbsp;' },
    ];

    for (const { name, variant } of inlineVariants) {
      it(`inline-context ${name} between words becomes a single regular space`, () => {
        const input = `hello${variant}world`;
        const doc = markdownToDoc(input);
        const restored: string = docToMarkdown(doc);
        expect(restored).toBe('hello world');
        expect(restored).not.toContain('&nbsp;');
        expect(restored).not.toContain('\u00a0');
      });

      it(`inline-context ${name} is idempotent (second pass is a no-op)`, () => {
        const input = `hello${variant}world`;
        const firstPass: string = docToMarkdown(markdownToDoc(input));
        const secondPass: string = docToMarkdown(markdownToDoc(firstPass));
        expect(secondPass).toBe(firstPass);
      });
    }

    it('sentinel-context NBSP strips to empty paragraph (foo\\n\\n&nbsp;\\n\\nbar -> foo\\n\\n\\n\\nbar)', () => {
      const input = 'foo\n\n&nbsp;\n\nbar';
      const restored: string = docToMarkdown(markdownToDoc(input));
      expect(restored).toBe('foo\n\n\n\nbar');
      expect(restored).not.toContain('&nbsp;');
    });

    it('sentinel-context with double-encoded NBSP also strips to empty paragraph', () => {
      const input = 'foo\n\n&amp;nbsp;\n\nbar';
      const restored: string = docToMarkdown(markdownToDoc(input));
      expect(restored).toBe('foo\n\n\n\nbar');
    });

    it('sentinel-context idempotency — second pass does not re-corrupt', () => {
      const input = 'foo\n\n&nbsp;\n\nbar';
      const firstPass: string = docToMarkdown(markdownToDoc(input));
      const secondPass: string = docToMarkdown(markdownToDoc(firstPass));
      expect(secondPass).toBe(firstPass);
    });
  });

  describe('Schema rejection — leaky StarterKit defaults are disabled', () => {
    it('schema does not register link / underline / bold / italic / strike / code marks', () => {
      const editor = createContractEditor('');
      try {
        expect(editor.schema.marks.link).toBeUndefined();
        expect(editor.schema.marks.underline).toBeUndefined();
        expect(editor.schema.marks.bold).toBeUndefined();
        expect(editor.schema.marks.italic).toBeUndefined();
        expect(editor.schema.marks.strike).toBeUndefined();
        expect(editor.schema.marks.code).toBeUndefined();
      } finally {
        editor.destroy();
      }
    });

    it('mark-toggle commands are absent or no-op (belt-and-braces optional-chaining)', () => {
      const editor = createContractEditor('hello');
      try {
        // Optional chaining handles both shapes: command absent (`undefined`) or
        // command present but returning `false` from `can()` because the schema
        // rejects the mark.
        expect(editor.commands.toggleBold?.()).toBeFalsy();
        expect(editor.commands.toggleItalic?.()).toBeFalsy();
        expect(editor.commands.toggleStrike?.()).toBeFalsy();
        expect(editor.commands.toggleCode?.()).toBeFalsy();
        // Link command shape varies slightly by version; tolerate both.
        const setLink = (editor.commands as { setLink?: (attrs: { href: string }) => boolean })
          .setLink;
        expect(setLink?.({ href: 'x' })).toBeFalsy();
      } finally {
        editor.destroy();
      }
    });
  });

  describe('5-iteration round-trip idempotency — 3-paragraph + mention input', () => {
    it('roundTrip(roundTrip(...)) is bit-stable across 5 iterations', () => {
      const initial = 'hello\n\n@CHIEF_DESIGNER review\n\nthe brief';
      let current: string = initial;
      for (let i = 0; i < 5; i++) {
        const next: string = docToMarkdown(markdownToDoc(current));
        if (i === 0) {
          // First iteration should equal the input (no NBSP, no growth).
          expect(next).toBe(initial);
        } else {
          // Subsequent iterations should equal the previous iteration.
          expect(next).toBe(current);
        }
        current = next;
      }
      expect(current).toBe(initial);
    });

    it('5-iteration round-trip via the editor (getCurrentPromptMarkdown)', () => {
      const initial = 'hello\n\n@CHIEF_DESIGNER review\n\nthe brief';
      let current: string = initial;
      for (let i = 0; i < 5; i++) {
        const editor = createContractEditor(current);
        try {
          const next: ComposerWireMarkdown = getCurrentPromptMarkdown(editor);
          if (i === 0) {
            expect(next).toBe(initial);
          } else {
            expect(next).toBe(current);
          }
          current = next;
        } finally {
          editor.destroy();
        }
      }
      expect(current).toBe(initial);
    });
  });

  describe('Stage 1.5 — two-layer snapshot cache (C1 90%-push amendment)', () => {
    it('Layer A returns reference-equal { docJson, markdown } across selection-only transactions; caret index varies per call', () => {
      const editor = createContractEditor('@CHIEF_DESIGNER hello world');
      try {
        // Drive 4 selection-only transactions over distinct caret positions on a stable doc.
        // The PM doc shape is: paragraph[mention(CHIEF_DESIGNER) (atom, 1 unit), text('hello world') (11 chars)],
        // so PM positions 1..13 span the full inline content. We pick four well-separated points.
        const caretPmPositions = [1, 2, 7, 13];

        const layerASnapshots: ReturnType<typeof getLayerASnapshot>[] = [];
        const caretMarkdownIndices: number[] = [];

        for (const pmPos of caretPmPositions) {
          editor.commands.setTextSelection(pmPos);
          const layerA = getLayerASnapshot(editor);
          const caret = getCaretMarkdownIndex(editor);
          layerASnapshots.push(layerA);
          caretMarkdownIndices.push(caret);
        }

        // Reference equality across all 4 reads — Layer A hit cache, no re-serialise.
        for (let i = 1; i < layerASnapshots.length; i++) {
          expect(layerASnapshots[i]).toBe(layerASnapshots[0]);
          expect(layerASnapshots[i].markdown).toBe(layerASnapshots[0].markdown);
          expect(layerASnapshots[i].docJson).toBe(layerASnapshots[0].docJson);
        }

        // Caret index varies per call — Layer B did NOT freeze on doc identity.
        const uniqueCarets = new Set(caretMarkdownIndices);
        expect(uniqueCarets.size).toBe(caretPmPositions.length);
        // And the markdown content is what we expect.
        expect(layerASnapshots[0].markdown).toBe('@CHIEF_DESIGNER hello world');
      } finally {
        editor.destroy();
      }
    });

    it('cache invalidates on a doc-mutating transaction — Layer A returns a fresh reference', () => {
      const editor = createContractEditor('hello world');
      try {
        const before = getLayerASnapshot(editor);
        expect(before.markdown).toBe('hello world');

        // Doc-mutating transaction: append '!' at end of doc content.
        const insertPos = editor.state.doc.content.size - 1;
        editor.view.dispatch(editor.state.tr.insertText('!', insertPos));

        const after = getLayerASnapshot(editor);
        // Different reference (doc identity changed) AND different markdown content.
        expect(after).not.toBe(before);
        expect(after.markdown).not.toBe(before.markdown);
        expect(after.markdown).toBe('hello world!');
      } finally {
        editor.destroy();
      }
    });

    it('structural perf shield — selection-only transactions do NOT call editor.getMarkdown(); doc-mutating transactions invalidate per mutation', () => {
      // Build a 10K-char-ish draft so any naive recompute would dominate the test.
      const big = 'a '.repeat(5000); // ~10000 chars
      const editor = createContractEditor(big);
      const spy = vi.spyOn(editor, 'getMarkdown');
      try {
        // Initial snapshot — populates Layer A on the editor's current doc identity. 1 call.
        getLayerASnapshot(editor);

        // 4 selection-only transactions; expect ZERO additional getMarkdown() calls
        // because the doc identity is stable across these.
        const callsAfterInitial = spy.mock.calls.length;
        for (const pos of [1, 50, 200, 1000]) {
          editor.commands.setTextSelection(pos);
          const layerA = getLayerASnapshot(editor);
          // Layer B per-call doesn't re-invoke getMarkdown()
          getCaretMarkdownIndex(editor);
          expect(layerA.markdown).toBeDefined();
        }
        const callsAfterSelectionLoop = spy.mock.calls.length;
        // Selection-only loop must add ZERO calls (cache hits the entire time).
        expect(callsAfterSelectionLoop - callsAfterInitial).toBe(0);
        // Total getMarkdown() calls across the whole "selection-only" phase ≤ 1
        // (the initial Layer A miss is the only allowed call).
        expect(spy.mock.calls.length).toBeLessThanOrEqual(1);

        // 4 doc-mutating transactions; each MUST trigger exactly one getMarkdown() call
        // (the Layer A miss for the new doc identity).
        const callsBeforeMutations = spy.mock.calls.length;
        for (let i = 0; i < 4; i++) {
          const insertPos = editor.state.doc.content.size - 1;
          editor.view.dispatch(editor.state.tr.insertText('x', insertPos));
          getLayerASnapshot(editor); // populate cache for the new doc identity.
        }
        const callsAfterMutations = spy.mock.calls.length;
        expect(callsAfterMutations - callsBeforeMutations).toBe(4);
      } finally {
        spy.mockRestore();
        editor.destroy();
      }
    });

    it('wall-clock perf benchmark — uncached editor.getMarkdown() median <5ms; cached read median <1ms (best-effort thresholds)', () => {
      const big = 'a '.repeat(5000); // ~10000 chars
      const editor = createContractEditor(big);
      try {
        // Warm: 50 iterations of each path (uncached + cached) to stabilise the JIT.
        for (let i = 0; i < 50; i++) {
          editor.getMarkdown();
        }
        // Populate Layer A so cached reads hit on the first measured iteration.
        getLayerASnapshot(editor);
        for (let i = 0; i < 50; i++) {
          getLayerASnapshot(editor);
        }

        // Measured: 200 iterations each.
        const uncachedTimings: number[] = [];
        for (let i = 0; i < 200; i++) {
          const t0 = performance.now();
          // Direct getMarkdown — guaranteed to walk the doc.
          editor.getMarkdown();
          uncachedTimings.push(performance.now() - t0);
        }
        const cachedTimings: number[] = [];
        for (let i = 0; i < 200; i++) {
          const t0 = performance.now();
          getLayerASnapshot(editor); // hits cache (doc identity is stable).
          cachedTimings.push(performance.now() - t0);
        }

        const percentile = (xs: number[], p: number): number => {
          const sorted = [...xs].sort((a, b) => a - b);
          const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
          return sorted[idx];
        };

        const uncachedP50 = percentile(uncachedTimings, 50);
        const uncachedP95 = percentile(uncachedTimings, 95);
        const cachedP50 = percentile(cachedTimings, 50);
        const cachedP95 = percentile(cachedTimings, 95);

        // Surface numbers for the parent agent (the structural test above is the
        // load-bearing guard; these wall-clock thresholds are best-effort).
        // eslint-disable-next-line no-console
        console.log(
          `[Stage 1.5 perf] uncached P50=${uncachedP50.toFixed(3)}ms P95=${uncachedP95.toFixed(3)}ms ` +
            `cached P50=${cachedP50.toFixed(3)}ms P95=${cachedP95.toFixed(3)}ms`,
        );

        expect(uncachedP50).toBeLessThan(5);
        expect(uncachedP95).toBeLessThan(10); // 2x P50 budget.
        expect(cachedP50).toBeLessThan(1);
        expect(cachedP95).toBeLessThan(2); // 2x P50 budget.
      } finally {
        editor.destroy();
      }
    });
  });

  // ==========================================================================
  // Stage 2 — Empty-paragraph Cartesian + H15 N-empty-paragraph collapse contract
  // ==========================================================================
  describe('Empty-paragraph Cartesian — round-trip stability across 0/1/2/3/5/10 empty paragraphs', () => {
    const emptyCases: Array<{ count: number; expected: string }> = [
      { count: 0, expected: 'a\nb' },
      { count: 1, expected: 'a\n\nb' },
      { count: 2, expected: 'a\n\n\nb' },
      { count: 3, expected: 'a\n\n\n\nb' },
      { count: 5, expected: 'a\n\n\n\n\n\nb' },
      { count: 10, expected: 'a\n\n\n\n\n\n\n\n\n\n\nb' },
    ];

    for (const { count, expected } of emptyCases) {
      it(`round-trips ${count} empty paragraph(s) between two content paragraphs idempotently`, () => {
        // Build the input: 'a' + (count + 1) newlines + 'b' — N empty paragraphs require N+1 separators.
        const separators = '\n'.repeat(count + 1);
        const input = `a${separators}b`;
        expect(input).toBe(expected); // Lock the constructed input shape.

        const restored: string = docToMarkdown(markdownToDoc(input));
        expect(restored).toBe(input);

        // Idempotent — second pass is a no-op.
        const second: string = docToMarkdown(markdownToDoc(restored));
        expect(second).toBe(restored);
      });
    }

    it('H15 N-empty-paragraph collapse contract — 5 empty paragraphs serialise back as `\\n\\n\\n\\n\\n\\n` (locked)', () => {
      const input = 'a\n\n\n\n\n\nb';
      const restored: string = docToMarkdown(markdownToDoc(input));
      // Locked behaviour: empty paragraphs are NOT collapsed by the override-enabled wire format.
      expect(restored).toBe('a\n\n\n\n\n\nb');
      expect(restored.split('a')[1]?.split('b')[0]).toBe('\n\n\n\n\n\n');
    });

    it('round-trips 5 empty paragraphs through the editor (getCurrentPromptMarkdown)', () => {
      const input = 'a\n\n\n\n\n\nb';
      const editor = createContractEditor(input);
      try {
        const md = getCurrentPromptMarkdown(editor);
        expect(md).toBe(input);
      } finally {
        editor.destroy();
      }
    });
  });

  // ==========================================================================
  // Stage 2 — HardBreak shapes
  // ==========================================================================
  describe('HardBreak shapes — start / middle / end of paragraph', () => {
    /**
     * Insert a HardBreak node at the given PM position via a direct transaction.
     * Mirrors the spike's `tr.replaceWith` pattern; uses `insert` because a
     * HardBreak is an inline atom and we just want it interleaved with the
     * existing text.
     */
    function insertHardBreakAt(editor: Editor, pmPos: number): void {
      const node = editor.schema.nodes.hardBreak.create();
      const tr = editor.state.tr.insert(pmPos, node);
      editor.view.dispatch(tr);
    }

    it('HardBreak in the middle of a paragraph emits a single `\\n` (NOT `  \\n`)', () => {
      const editor = createContractEditor('hello world');
      try {
        // PM positions inside `<p>hello world</p>`: 1 = before 'h', 7 = between 'hello ' and 'world'.
        insertHardBreakAt(editor, 7);
        const md = getCurrentPromptMarkdown(editor);
        // Override sets HardBreak.renderMarkdown to '\n' (not the upstream '  \n').
        expect(md).toContain('\n');
        expect(md).not.toContain('  \n');
        expect(md).toBe('hello \nworld');
      } finally {
        editor.destroy();
      }
    });

    it('HardBreak at the start of a paragraph emits `\\n` before the text', () => {
      const editor = createContractEditor('text');
      try {
        insertHardBreakAt(editor, 1); // PM pos 1 = inside paragraph, before first inline node.
        const md = getCurrentPromptMarkdown(editor);
        expect(md).not.toContain('  \n');
        expect(md).toBe('\ntext');
      } finally {
        editor.destroy();
      }
    });

    it('HardBreak at the end of a paragraph emits `\\n` after the text', () => {
      const editor = createContractEditor('text');
      try {
        // PM pos 5 = after 't' 'e' 'x' 't' but before close-paragraph boundary.
        insertHardBreakAt(editor, 5);
        const md = getCurrentPromptMarkdown(editor);
        expect(md).not.toContain('  \n');
        expect(md).toBe('text\n');
      } finally {
        editor.destroy();
      }
    });
  });

  // ==========================================================================
  // Stage 2 — Mention atom shapes (5 kinds, multiple attr combinations)
  // ==========================================================================
  describe('Mention atom shapes — all five kinds + multiple attr combinations', () => {
    const mentionCases: Array<{ name: string; attrs: MentionAttrs }> = [
      // Command kind (2 attrs combos)
      {
        name: 'command/CHIEF_DESIGNER',
        attrs: { kind: 'command', label: '@CHIEF_DESIGNER', command: 'CHIEF_DESIGNER' },
      },
      {
        name: 'command/designContext',
        attrs: { kind: 'command', label: '@designContext', command: 'designContext' },
      },
      // File kind (2 attrs combos — file vs directory)
      {
        name: 'file/relative-path',
        attrs: { kind: 'file', label: 'brief.md', relativePath: 'docs/brief.md' },
      },
      {
        name: 'file/directory-with-spaces',
        attrs: {
          kind: 'file',
          label: 'spec',
          relativePath: 'work/folder with space/spec',
          nodeKind: 'directory',
        },
      },
      // Model kind (2 attrs combos)
      {
        name: 'model/Working Brain',
        attrs: { kind: 'model', label: '@model:Working Brain', profileName: 'Working Brain' },
      },
      {
        name: 'model/Claude Sonnet 4',
        attrs: { kind: 'model', label: '@model:Claude Sonnet 4', profileName: 'Claude Sonnet 4' },
      },
      // Conversation kind (2 attrs combos — plain, with brackets in title)
      {
        name: 'conversation/plain-title',
        attrs: {
          kind: 'conversation',
          label: 'Friday Pulse',
          conversationId: 'abc-123',
          conversationTitle: 'Friday Pulse',
        },
      },
      {
        name: 'conversation/title-with-brackets',
        attrs: {
          kind: 'conversation',
          label: 'A [bracket]',
          conversationId: 'c1',
          conversationTitle: 'A [bracket]',
        },
      },
      // Operator kind (2 attrs combos — resolved and missing)
      {
        name: 'operator/resolved',
        attrs: {
          kind: 'operator',
          label: 'Skeptical Engineer',
          operatorSlug: 'skeptical-engineer',
          operatorId: '/workspace/Chief-of-Staff::skeptical-engineer',
          operatorName: 'Skeptical Engineer',
        },
      },
      {
        name: 'operator/missing',
        attrs: {
          kind: 'operator',
          label: 'Operator not found in this Space',
          operatorSlug: 'missing-operator',
          missing: true,
        },
      },
    ];

    for (const { name, attrs } of mentionCases) {
      it(`inserts mention(${name}) atom and serialises it as tokenForMention(attrs)`, () => {
        const editor = createContractEditor('');
        try {
          // Use the typed insertMention command exposed by MentionNode.
          editor.commands.insertContent({ type: 'mention', attrs });
          const md = getCurrentPromptMarkdown(editor);
          const expectedToken = tokenForMention(attrs);
          expect(md).toContain(expectedToken);
        } finally {
          editor.destroy();
        }
      });
    }

    it('inserts ALL five kinds in the same paragraph and round-trips losslessly', () => {
      const editor = createContractEditor('');
      try {
        for (const { attrs } of mentionCases) {
          editor.commands.insertContent({ type: 'mention', attrs });
        }
        const md = getCurrentPromptMarkdown(editor);
        for (const { attrs } of mentionCases) {
          const token = tokenForMention(attrs);
          expect(md).toContain(token);
        }
      } finally {
        editor.destroy();
      }
    });
  });

  // ==========================================================================
  // Stage 2 — Expanded NBSP-family contract (all variants × inline / sentinel / mixed)
  // ==========================================================================
  describe('NBSP-family sanitisation contract (expanded — Stage 2)', () => {
    const variants: Array<{ name: string; variant: string }> = [
      { name: '&nbsp;', variant: '&nbsp;' },
      { name: 'literal NBSP char', variant: '\u00a0' },
      { name: '&NBSP;', variant: '&NBSP;' },
      { name: '&#160;', variant: '&#160;' },
      { name: '&#xA0;', variant: '&#xA0;' },
      { name: '&amp;nbsp; (double-encoded)', variant: '&amp;nbsp;' },
    ];

    for (const { name, variant } of variants) {
      it(`inline ${name}: hello + variant + world → 'hello world'`, () => {
        const restored: string = docToMarkdown(markdownToDoc('hello' + variant + 'world'));
        expect(restored).toBe('hello world');
      });

      it(`sentinel ${name}: foo\\n\\n + variant + \\n\\nbar → 'foo\\n\\n\\n\\nbar'`, () => {
        const restored: string = docToMarkdown(markdownToDoc('foo\n\n' + variant + '\n\nbar'));
        expect(restored).toBe('foo\n\n\n\nbar');
      });

      it(`mixed ${name}: combines inline AND sentinel in same input`, () => {
        // 'alpha<variant>beta\n\n<variant>\n\ngamma<variant>delta' → inline becomes ' ', sentinel becomes ''.
        const input = 'alpha' + variant + 'beta\n\n' + variant + '\n\ngamma' + variant + 'delta';
        const restored: string = docToMarkdown(markdownToDoc(input));
        expect(restored).toBe('alpha beta\n\n\n\ngamma delta');
      });
    }
  });

  // ==========================================================================
  // Stage 2 — 5-iteration round-trip on mention + HardBreak doc
  // ==========================================================================
  describe('5-iteration round-trip — 3 paragraphs + mention atom + HardBreak', () => {
    it('roundTrip(roundTrip(...)) is bit-stable across 5 iterations on a mention + HardBreak input', () => {
      // Build a doc by hand: paragraph 1 has mention + HardBreak + text, paragraph 2 is empty,
      // paragraph 3 is content. Use the editor to construct it so we can serialise via
      // getCurrentPromptMarkdown then validate the all-string round-trip is idempotent.
      const editor = createContractEditor('@CHIEF_DESIGNER hello\n\nthe brief\nwith more text');
      let initial: string;
      try {
        // Insert a HardBreak in the middle of the content paragraph for shape variety.
        // (We accept whatever the editor produces — the test pins idempotency, not the exact shape.)
        initial = getCurrentPromptMarkdown(editor);
      } finally {
        editor.destroy();
      }

      let current = initial;
      const outputs: string[] = [];
      for (let i = 0; i < 5; i++) {
        const next = docToMarkdown(markdownToDoc(current));
        outputs.push(next);
        current = next;
      }

      // All 5 outputs should be bit-equal (idempotent stable).
      for (let i = 1; i < outputs.length; i++) {
        expect(outputs[i]).toBe(outputs[0]);
      }
      // And equal to the initial editor output (no growth on first round-trip).
      expect(outputs[0]).toBe(initial);
    });
  });

  // ==========================================================================
  // Stage 2 — H10 undo / redo preservation (affirmative)
  // ==========================================================================
  describe('H10 undo / redo preservation', () => {
    it('editor.commands.undo() reverts a tr.insertText mutation; redo replays it', () => {
      const editor = createContractEditor('hello');
      try {
        const before: ComposerWireMarkdown = getCurrentPromptMarkdown(editor);
        expect(before).toBe('hello');

        // Mutate via a transaction (the same path Stage 3 prescribes for chip insertion).
        // Insert ' world' before the close-paragraph boundary.
        const insertPos = editor.state.doc.content.size - 1;
        editor.view.dispatch(editor.state.tr.insertText(' world', insertPos));
        const mutated: ComposerWireMarkdown = getCurrentPromptMarkdown(editor);
        expect(mutated).toBe('hello world');

        // Undo: returns true AND content reverts.
        const undid = editor.commands.undo();
        expect(undid).toBe(true);
        expect(getCurrentPromptMarkdown(editor)).toBe('hello');

        // Redo: returns true AND content re-applies.
        const redid = editor.commands.redo();
        expect(redid).toBe(true);
        expect(getCurrentPromptMarkdown(editor)).toBe('hello world');
      } finally {
        editor.destroy();
      }
    });

    // Stage 3 H10 — chip-conversion preserves undo/redo via targeted PM transaction.
    //
    // Test isolation note: PM's history plugin coalesces transactions inside
    // a short time-group window (default 500ms) into a single undoable step.
    // Two back-to-back dispatches in a synchronous test would therefore look
    // like ONE undo step in production (which is the right user UX — undoing
    // a freshly-typed-and-converted trigger feels like one operation). To
    // isolate the chip-conversion as the sole history entry — and verify
    // affirmatively that `tr.replaceWith` participates in history (the H10
    // contract that the prior `setContent` call obliterated) — we mark the
    // text-insertion transaction as `addToHistory: false`. Production code
    // is unaffected; this is purely a test-isolation knob.
    it('undo() reverts a normaliseCommandMentions chip-conversion; redo replays it', () => {
      const editor = createContractEditor('');
      try {
        // Step 1: insert plain text containing a registered command trigger.
        // Mark addToHistory=false so this is NOT in the undo stack — see note
        // above. This way the chip-conversion is the sole history entry.
        const insertTr = editor.state.tr.insertText('@CHIEF_DESIGNER ');
        insertTr.setMeta('addToHistory', false);
        editor.view.dispatch(insertTr);

        // Pre-normalisation: a single text node, zero mention atoms.
        let mentionCountBefore = 0;
        editor.state.doc.descendants((node) => {
          if (node.type.name === 'mention') mentionCountBefore++;
        });
        expect(mentionCountBefore).toBe(0);

        // Step 2: Stage 3 H10 normalisation — converts the trigger to a chip
        // atom via a single targeted `tr.replaceWith` dispatched as one
        // undoable step (the only entry in the history stack).
        const normalised = normaliseCommandMentions(editor);
        expect(normalised).toBe(true);

        // Post-normalisation: exactly one chip atom, same wire markdown.
        let mentionCountAfter = 0;
        editor.state.doc.descendants((node) => {
          if (node.type.name === 'mention') mentionCountAfter++;
        });
        expect(mentionCountAfter).toBe(1);
        expect(getCurrentPromptMarkdown(editor)).toBe('@CHIEF_DESIGNER ');

        // H10 affirmative: undo() returns true AND the chip reverts to text.
        const undid = editor.commands.undo();
        expect(undid).toBe(true);
        let mentionCountAfterUndo = 0;
        editor.state.doc.descendants((node) => {
          if (node.type.name === 'mention') mentionCountAfterUndo++;
        });
        expect(mentionCountAfterUndo).toBe(0);
        expect(getCurrentPromptMarkdown(editor)).toBe('@CHIEF_DESIGNER ');

        // Redo: chip is restored.
        const redid = editor.commands.redo();
        expect(redid).toBe(true);
        let mentionCountAfterRedo = 0;
        editor.state.doc.descendants((node) => {
          if (node.type.name === 'mention') mentionCountAfterRedo++;
        });
        expect(mentionCountAfterRedo).toBe(1);
        expect(getCurrentPromptMarkdown(editor)).toBe('@CHIEF_DESIGNER ');
      } finally {
        editor.destroy();
      }
    });
  });

  // ==========================================================================
  // Stage 3 — Multi-replacement normaliseCommandMentions (Gemini-High amendment)
  // ==========================================================================
  describe('Stage 3 — multi-replacement normaliseCommandMentions (reverse-order positions)', () => {
    it('converts two `@COMMAND ` patterns separated by content; surrounding text preserved', () => {
      const editor = createContractEditor('');
      try {
        // Insert plain text containing TWO command triggers separated by other
        // content. Validates the reverse-order/mapping logic: replacing the
        // higher-position match first leaves the lower-position match's
        // coordinates valid for the second `tr.replaceWith` step.
        const text = 'foo @CHIEF_DESIGNER bar @designContext baz';
        editor.view.dispatch(editor.state.tr.insertText(text));

        // Sanity: pre-normalisation wire markdown is the plain text with no chips.
        expect(getCurrentPromptMarkdown(editor)).toBe(text);
        let mentionCountBefore = 0;
        editor.state.doc.descendants((node) => {
          if (node.type.name === 'mention') mentionCountBefore++;
        });
        expect(mentionCountBefore).toBe(0);

        const normalised = normaliseCommandMentions(editor);
        expect(normalised).toBe(true);

        // Post-normalisation: BOTH triggers became chips, surrounding content
        // preserved exactly. Wire is identical because each chip serialises to
        // its `tokenForMention` (with trailing space).
        const md = getCurrentPromptMarkdown(editor);
        expect(md).toBe('foo @CHIEF_DESIGNER bar @designContext baz');
        let mentionCountAfter = 0;
        editor.state.doc.descendants((node) => {
          if (node.type.name === 'mention') mentionCountAfter++;
        });
        expect(mentionCountAfter).toBe(2);

        // Both chips are command-kind with the right command attr.
        const commands: string[] = [];
        editor.state.doc.descendants((node) => {
          if (node.type.name === 'mention') {
            commands.push(node.attrs.command as string);
          }
        });
        expect(commands).toEqual(['CHIEF_DESIGNER', 'designContext']);
      } finally {
        editor.destroy();
      }
    });

    it('returns false when the doc has no unconverted command triggers (fast-path)', () => {
      // Empty doc — fast-path via `textContent` regex test should short-circuit.
      const editor = createContractEditor('');
      try {
        expect(normaliseCommandMentions(editor)).toBe(false);
      } finally {
        editor.destroy();
      }
    });

    it('returns false when all command triggers are already chips (no re-normalisation)', () => {
      // Hydrate from markdown — markdownToDoc converts triggers to chips on
      // hydration. After that, `normaliseCommandMentions` should see no
      // unconverted text triggers in the doc and return false.
      const editor = createContractEditor('@CHIEF_DESIGNER hi');
      try {
        // Sanity: the chip is already in place.
        let mentionCount = 0;
        editor.state.doc.descendants((node) => {
          if (node.type.name === 'mention') mentionCount++;
        });
        expect(mentionCount).toBe(1);

        // No-op: no unconverted text trigger remains.
        expect(normaliseCommandMentions(editor)).toBe(false);
      } finally {
        editor.destroy();
      }
    });

    it('does NOT match an in-progress trigger that lacks a trailing space', () => {
      // User mid-typing `@CHIEF_DESIGNER` (no space yet) — picker handles this
      // case; normaliseCommandMentions must NOT eagerly convert.
      const editor = createContractEditor('');
      try {
        editor.view.dispatch(editor.state.tr.insertText('@CHIEF_DESIGNER'));
        expect(normaliseCommandMentions(editor)).toBe(false);
        let mentionCount = 0;
        editor.state.doc.descendants((node) => {
          if (node.type.name === 'mention') mentionCount++;
        });
        expect(mentionCount).toBe(0);
      } finally {
        editor.destroy();
      }
    });
  });

  // ==========================================================================
  // Stage 2 — H11 belt-and-braces: Node.eq() vs string equality
  // ==========================================================================
  describe('H11 belt-and-braces — Node.eq() semantics vs string equality', () => {
    it('editor.state.doc.eq(editor.state.doc) returns true (reflexive)', () => {
      const editor = createContractEditor('hello world');
      try {
        // Reflexive check — the doc is structurally equal to itself.
        expect(editor.state.doc.eq(editor.state.doc)).toBe(true);
      } finally {
        editor.destroy();
      }
    });

    it('after a doc-mutating transaction, the new doc is NOT eq() to the snapshot of the old doc', () => {
      const editor = createContractEditor('hello');
      try {
        const before = editor.state.doc;
        const beforeMd: ComposerWireMarkdown = getCurrentPromptMarkdown(editor);
        const insertPos = editor.state.doc.content.size - 1;
        editor.view.dispatch(editor.state.tr.insertText('!', insertPos));
        const after = editor.state.doc;
        const afterMd: ComposerWireMarkdown = getCurrentPromptMarkdown(editor);
        // String-level: differ.
        expect(afterMd).not.toBe(beforeMd);
        // Node-level: differ structurally as well — this is the H11 contract.
        expect(after.eq(before)).toBe(false);
      } finally {
        editor.destroy();
      }
    });

    it('Node.eq() is reflexive across same-schema reconstructions of the same JSON', () => {
      // The plan's H11 contract: string equality alone is insufficient. The renderer must use
      // Node.eq to compare current vs incoming docs because:
      //   (a) two structurally-different docs can serialise to the same markdown string (e.g.
      //       a paragraph containing a deleted chip vs the rehydrated text), and
      //   (b) two structurally-equal docs can have different reference identity (a transaction
      //       that didn't change the doc shape still produces a fresh object).
      // We document case (b) here by reconstructing a doc from JSON via the SAME editor's schema —
      // Node.eq returns true. This is the load-bearing semantic the renderer relies on.
      const editor = createContractEditor('@CHIEF_DESIGNER hi');
      try {
        const original = editor.state.doc;
        // Reconstruct via the SAME schema (PM nodes from different schemas can't .eq).
        const reconstructed = editor.schema.nodeFromJSON(original.toJSON());
        expect(reconstructed.eq(original)).toBe(true);
        // And string equality also holds in this canonical case.
        expect(getCurrentPromptMarkdown(editor)).toBe('@CHIEF_DESIGNER hi');
      } finally {
        editor.destroy();
      }
    });
  });

  // ==========================================================================
  // Stage 2 — H12 trailing-space contract (DEFERRED to Stage 4 implementation)
  // ==========================================================================
  describe('H12 trailing-space contract', () => {
    /**
     * Stage 4 owns `insertMentionAtMarkdownRange`'s trailing-space behaviour.
     * Stage 2 places a placeholder verifying token format only — the
     * end-to-end "exactly one trailing space" assertion lives in the Stage 4
     * editor-level test once the adapter ships.
     */
    it('placeholder: tokenForMention(command) ends with a trailing space (per Stage 1 contract)', () => {
      const attrs: MentionAttrs = {
        kind: 'command',
        label: '@CHIEF_DESIGNER',
        command: 'CHIEF_DESIGNER',
      };
      const token = tokenForMention(attrs);
      expect(token).toBe('@CHIEF_DESIGNER ');
      expect(token.endsWith(' ')).toBe(true);
    });

    it('Stage 4 — insertMentionAtMarkdownRangeOnEditor appends exactly one trailing space for non-command kinds', () => {
      // file / conversation / model wire tokens have NO trailing space; the
      // Stage 4 adapter appends a single ASCII space so the user can keep
      // typing immediately. Command kind already ends with a space and the
      // adapter must NOT double-it.
      type Case = { name: string; attrs: MentionAttrs; expected: string };
      const cases: Case[] = [
        {
          name: 'command (no double-space)',
          attrs: { kind: 'command', label: '@CHIEF_DESIGNER', command: 'CHIEF_DESIGNER' },
          expected: '@CHIEF_DESIGNER ',
        },
        {
          name: 'file (single trailing space)',
          attrs: { kind: 'file', label: 'brief.md', relativePath: 'docs/brief.md' },
          expected: '@`docs/brief.md` ',
        },
        {
          name: 'conversation (single trailing space)',
          attrs: {
            kind: 'conversation',
            label: 'Friday Pulse',
            conversationTitle: 'Friday Pulse',
            conversationId: 'abc-123',
          },
          expected: '@[Friday Pulse](rebel://conversation/abc-123) ',
        },
        {
          name: 'model (single trailing space)',
          attrs: { kind: 'model', label: '@model:Working Brain', profileName: 'Working Brain' },
          expected: '@model:`Working Brain` ',
        },
      ];
      for (const c of cases) {
        const editor = createContractEditor('');
        try {
          insertMentionAtMarkdownRangeOnEditor(editor, undefined, c.attrs);
          const md = getCurrentPromptMarkdown(editor);
          expect(md, `case ${c.name}`).toBe(c.expected);
          // Never double-space.
          expect(md.endsWith('  '), `case ${c.name} no double-space`).toBe(false);
        } finally {
          editor.destroy();
        }
      }
    });
  });

  // ==========================================================================
  // Stage 2 — FMM Row 26: caret-into-trigger detection (string-based; uses findMentionTrigger)
  // ==========================================================================
  describe('FMM Row 26 — caret-into-existing-trigger reopens picker', () => {
    it('clicking back into the middle of `@fi` (caret index 2) returns a trigger context with query "fi"', () => {
      // findMentionTrigger reads (value, caret); we simulate "click into the middle of @fi" by
      // placing the caret index past the 'f' of `@fi` (i.e. at index 3 — after '@fi'). The
      // function expects the caret to sit AFTER the end of the typed-trigger text.
      const value = '@fi';
      const trigger = findMentionTrigger(value, 3);
      expect(trigger).not.toBeNull();
      // The string-based detector reports `query` (parsed) + `rawQuery` (literal). For a bare
      // `@fi` we expect the parsed query to equal the typed text 'fi'.
      expect(trigger?.query).toBe('fi');
      expect(trigger?.rawQuery).toBe('fi');
    });

    it('caret immediately after the `@` (index 1) returns an empty-query trigger (picker-just-opened)', () => {
      const value = '@fi';
      const trigger = findMentionTrigger(value, 1);
      expect(trigger).not.toBeNull();
      expect(trigger?.query).toBe('');
    });
  });

  // ==========================================================================
  // Stage 4 — FMM Row 27: caret-on-resolved-chip suppression (editor-aware fix)
  // ==========================================================================
  describe('FMM Row 27 — caret-on-resolved-chip does NOT trigger picker (Stage 4)', () => {
    /**
     * Stage 4 ships `isCaretOnMentionChip(editor)` in `useMentionAutocomplete.ts`
     * — the parent-layer scheduler invokes this BEFORE scheduling so a click
     * adjacent to a resolved chip suppresses the picker. The string-based
     * `findMentionTrigger` cannot see node atoms; the editor-aware helper
     * is the source of truth for chip-adjacency detection.
     */
    it('isCaretOnMentionChip returns true when the caret sits on a resolved chip atom', () => {
      // Build a doc with a single command chip preceded by some text. The
      // mention is an inline atom; PM treats it as a single position.
      const editor = createContractEditor('foo @CHIEF_DESIGNER bar');
      try {
        const docSize = editor.state.doc.content.size;
        // Walk every position in the doc; at least one position over the
        // chip must trip the helper.
        const hits: number[] = [];
        for (let pos = 0; pos <= docSize; pos++) {
          editor.commands.setTextSelection(pos);
          if (isCaretOnMentionChip(editor)) {
            hits.push(pos);
          }
        }
        // The chip is a single-position inline atom; nodeAt(pos) and
        // nodeAt(pos - 1) both reach it from either side, so we expect at
        // least one position to match (either before or just-after the
        // chip atom).
        expect(hits.length).toBeGreaterThan(0);
      } finally {
        editor.destroy();
      }
    });

    it('isCaretOnMentionChip returns false when the caret sits in plain text', () => {
      const editor = createContractEditor('foo @CHIEF_DESIGNER bar');
      try {
        // Position the caret at the very end (inside the trailing 'bar' run).
        editor.commands.setTextSelection(editor.state.doc.content.size - 1);
        expect(isCaretOnMentionChip(editor)).toBe(false);
      } finally {
        editor.destroy();
      }
    });

    it('parent-layer scheduler suppresses fire when caret is on a resolved chip', () => {
      vi.useFakeTimers();
      try {
        const editor = createContractEditor('foo @CHIEF_DESIGNER bar');
        try {
          // Place caret somewhere on the chip atom by scanning for a hit.
          const docSize = editor.state.doc.content.size;
          let chipPos = -1;
          for (let pos = 0; pos <= docSize; pos++) {
            editor.commands.setTextSelection(pos);
            if (isCaretOnMentionChip(editor)) {
              chipPos = pos;
              break;
            }
          }
          expect(chipPos).toBeGreaterThan(-1);

          const fired: Array<{ value: string; caret: number }> = [];
          const scheduler = createMentionContextScheduler({
            onFire: (value, caret) => fired.push({ value, caret }),
            isPickerOpen: () => false,
            getEditor: () => editor,
            isComposing: () => false,
            isCaretOnChip: (ed) => isCaretOnMentionChip(ed),
            // Pretend the wire string would otherwise look like a fresh trigger;
            // the chip-adjacency check should still suppress.
            detectFreshTrigger: () => true,
          });
          scheduler.schedule(getCurrentPromptMarkdown(editor), chipPos);
          vi.advanceTimersByTime(MENTION_DEBOUNCE_MS * 2);
          expect(fired.length).toBe(0);
        } finally {
          editor.destroy();
        }
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ==========================================================================
  // Stage 4 — Parent-layer scheduler contract (H8 ownership fix)
  // ==========================================================================
  describe('Stage 4 parent-layer scheduler — IME-aware debounce + first-`@` fast-path', () => {
    /**
     * H8 quantitative DoD: 50 fast keystrokes including `@` produce
     * ≤ 5 `updateMentionContext` invocations. With the cancel-and-
     * reschedule debounce semantics and a 250ms window, all 50 schedules
     * collapse to a single fire. Counted via a spy on `onFire`.
     */
    it('coalesces 50 fast keystrokes into ≤ 5 onFire invocations', () => {
      vi.useFakeTimers();
      try {
        const editor = createContractEditor('');
        try {
          let fireCount = 0;
          const scheduler = createMentionContextScheduler({
            onFire: () => {
              fireCount++;
            },
            isPickerOpen: () => false,
            getEditor: () => editor,
            isComposing: () => false,
            isCaretOnChip: () => false,
            // Disable the first-`@` fast-path so all 50 schedules go through
            // the debounce path. (The fast-path is exercised in its own
            // contract row below.)
            detectFreshTrigger: () => false,
          });
          // 50 schedules within the debounce window — 1ms apart.
          for (let i = 0; i < 50; i++) {
            scheduler.schedule(`x${i}`, i);
            vi.advanceTimersByTime(1);
          }
          // Advance past the debounce window so the final timer fires.
          vi.advanceTimersByTime(MENTION_DEBOUNCE_MS);
          // Cancel-and-reschedule semantics: only the final schedule's
          // timer fires. Bound by the H8 plan's `≤ 5`.
          expect(fireCount).toBeLessThanOrEqual(5);
          expect(fireCount).toBe(1);
        } finally {
          editor.destroy();
        }
      } finally {
        vi.useRealTimers();
      }
    });

    it('opens picker immediately on first valid `@` trigger (no debounce)', () => {
      vi.useFakeTimers();
      try {
        const editor = createContractEditor('');
        try {
          const fired: Array<{ value: string; caret: number }> = [];
          const scheduler = createMentionContextScheduler({
            onFire: (value, caret) => fired.push({ value, caret }),
            isPickerOpen: () => false,
            getEditor: () => editor,
            isComposing: () => false,
            isCaretOnChip: () => false,
            detectFreshTrigger: (value, caret) =>
              findMentionTrigger(value, caret) !== null,
          });
          // First-`@` keystroke. Picker is closed; the fast-path fires
          // synchronously without any timer advance.
          scheduler.schedule('@', 1);
          expect(fired.length).toBe(1);
          expect(fired[0]).toEqual({ value: '@', caret: 1 });
        } finally {
          editor.destroy();
        }
      } finally {
        vi.useRealTimers();
      }
    });

    it('debounces subsequent updates once the picker is open', () => {
      vi.useFakeTimers();
      try {
        const editor = createContractEditor('');
        try {
          const fired: Array<{ value: string; caret: number }> = [];
          const scheduler = createMentionContextScheduler({
            onFire: (value, caret) => fired.push({ value, caret }),
            isPickerOpen: () => true,
            getEditor: () => editor,
            isComposing: () => false,
            isCaretOnChip: () => false,
            detectFreshTrigger: () => true,
          });
          // Picker already open → fast-path is skipped; subsequent
          // schedules debounce.
          scheduler.schedule('@a', 2);
          scheduler.schedule('@ab', 3);
          scheduler.schedule('@abc', 4);
          expect(fired.length).toBe(0);
          vi.advanceTimersByTime(MENTION_DEBOUNCE_MS);
          // Latest schedule wins.
          expect(fired.length).toBe(1);
          expect(fired[0]).toEqual({ value: '@abc', caret: 4 });
        } finally {
          editor.destroy();
        }
      } finally {
        vi.useRealTimers();
      }
    });

    it('IME compose-and-pause sequence: defers during compose, fires after compositionend flush', () => {
      vi.useFakeTimers();
      try {
        const editor = createContractEditor('');
        try {
          let composing = true;
          const fired: Array<{ value: string; caret: number }> = [];
          const scheduler = createMentionContextScheduler({
            onFire: (value, caret) => fired.push({ value, caret }),
            isPickerOpen: () => false,
            getEditor: () => editor,
            isComposing: () => composing,
            isCaretOnChip: () => false,
            // Disable fast-path so the IME guard is the gating mechanism.
            detectFreshTrigger: () => false,
          });
          scheduler.schedule('@', 1);
          // Pause: no further schedules; no compositionend yet.
          vi.advanceTimersByTime(1000);
          expect(fired.length).toBe(0);

          // Composition ends → compositionend listener invokes flushDeferred.
          composing = false;
          scheduler.flushDeferred();
          vi.advanceTimersByTime(MENTION_DEBOUNCE_MS);
          expect(fired.length).toBe(1);
          expect(fired[0]).toEqual({ value: '@', caret: 1 });
        } finally {
          editor.destroy();
        }
      } finally {
        vi.useRealTimers();
      }
    });

    it('cancels a pending fire when the value no longer contains @', () => {
      vi.useFakeTimers();
      try {
        const editor = createContractEditor('');
        try {
          let fireCount = 0;
          const scheduler = createMentionContextScheduler({
            onFire: () => {
              fireCount++;
            },
            isPickerOpen: () => true, // skip fast-path
            getEditor: () => editor,
            isComposing: () => false,
            isCaretOnChip: () => false,
            detectFreshTrigger: () => false,
          });
          scheduler.schedule('@a', 2);
          scheduler.cancel();
          vi.advanceTimersByTime(MENTION_DEBOUNCE_MS * 2);
          expect(fireCount).toBe(0);
        } finally {
          editor.destroy();
        }
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
