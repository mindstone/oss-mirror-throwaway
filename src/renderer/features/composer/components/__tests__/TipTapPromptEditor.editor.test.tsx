// @vitest-environment happy-dom
/**
 * Editor-level tests for the TipTap prompt editor — Stage 2 (NEW).
 *
 * Covers the 14 named test cases from the planning doc's Test Strategy section
 * (`docs/plans/260501_composer_tiptap_atmention_bugfix.md`), each driven by a
 * **real** TipTap `Editor` instance constructed via `createPromptEditorExtensions()`
 * — the same single-source-of-truth factory that production
 * (`TipTapPromptEditor.tsx`'s `useEditor`) consumes. This eliminates the prior
 * test-vs-production extension drift that allowed `967f0b058` to ship the
 * @-mention `&nbsp;` regression.
 *
 * All assertions go through the production wrapper `getCurrentPromptMarkdown`
 * (or the local `docToMarkdown` round-trip pair where the assertion is at the
 * pure-function layer) so the test file mirrors the production wire-format
 * read path.
 *
 * Test environment is `happy-dom` per the post-spike GPT-High amendment: TipTap
 * commands like `undo()` / `setHardBreak()` need a DOM-bearing environment.
 *
 * Stage 4 (2026-05-01): the IME compose-and-pause and H12 trailing-space-per-
 * kind contract test rows previously marked `it.skip` are now active and
 * green; they exercise the parent-layer `createMentionContextScheduler` and
 * `insertMentionAtMarkdownRangeOnEditor` helpers respectively.
 *
 * See the planning doc's "Test Strategy" section for the named test list.
 */

import { describe, expect, it, vi } from 'vitest';
import { Editor } from '@tiptap/core';
import { createPromptEditorExtensions } from '../../utils/composerEditorFactory';
import {
  docToMarkdown,
  markdownToDoc,
  type ComposerWireMarkdown,
} from '../../utils/promptDoc';
import { toComposerWireMarkdown } from '../../utils/composerMarkdown';
import {
  getCurrentPromptMarkdown,
  insertMentionAtMarkdownRangeOnEditor,
} from '../TipTapPromptEditor';
import { findMentionTrigger } from '../../hooks/useMentionAutocomplete';
import { getCaretMarkdownIndex } from '../../utils/composerSnapshotCache';
import {
  createMentionContextScheduler,
  MENTION_DEBOUNCE_MS,
} from '../../utils/mentionContextScheduler';

function createEditor(initial = ''): Editor {
  return new Editor({
    content: markdownToDoc(initial),
    extensions: createPromptEditorExtensions(),
  });
}

/**
 * Insert a HardBreak inline atom at the given PM position via a direct
 * transaction. Used by case #6.
 */
function insertHardBreakAt(editor: Editor, pmPos: number): void {
  const node = editor.schema.nodes.hardBreak.create();
  const tr = editor.state.tr.insert(pmPos, node);
  editor.view.dispatch(tr);
}

describe('TipTapPromptEditor (real Editor + production extensions)', () => {
  // -----------------------------------------------------------------------
  // 1. plain text round-trips through the editor
  // -----------------------------------------------------------------------
  it('plain text round-trips through the editor', () => {
    const editor = createEditor('hello world');
    try {
      const md: ComposerWireMarkdown = getCurrentPromptMarkdown(editor);
      expect(md).toBe('hello world');
      expect(md).not.toContain('&nbsp;');
    } finally {
      editor.destroy();
    }
  });

  // -----------------------------------------------------------------------
  // 2. multi-paragraph text round-trips through the editor
  // -----------------------------------------------------------------------
  it('multi-paragraph text round-trips through the editor', () => {
    const initial = 'first paragraph\nsecond paragraph\nthird paragraph';
    const editor = createEditor(initial);
    try {
      expect(getCurrentPromptMarkdown(editor)).toBe(initial);
    } finally {
      editor.destroy();
    }
  });

  // -----------------------------------------------------------------------
  // 3. empty paragraph between two non-empty paragraphs round-trips
  // -----------------------------------------------------------------------
  it('empty paragraph between two non-empty paragraphs round-trips', () => {
    const initial = 'first\n\nsecond';
    const editor = createEditor(initial);
    try {
      const md = getCurrentPromptMarkdown(editor);
      expect(md).toBe(initial);
      expect(md).not.toContain('&nbsp;');
    } finally {
      editor.destroy();
    }
  });

  // -----------------------------------------------------------------------
  // 4. two consecutive empty paragraphs round-trip (also: 0 / 1 / 2 cases)
  // -----------------------------------------------------------------------
  it('two consecutive empty paragraphs round-trip (0 / 1 / 2 empty-paragraph cases)', () => {
    const cases = [
      { name: '0 empty', input: 'first\nsecond' },
      { name: '1 empty', input: 'first\n\nsecond' },
      { name: '2 empty', input: 'first\n\n\nsecond' },
    ];
    for (const { name, input } of cases) {
      const editor = createEditor(input);
      try {
        const md = getCurrentPromptMarkdown(editor);
        expect(md, `case ${name}`).toBe(input);
        expect(md).not.toContain('&nbsp;');
      } finally {
        editor.destroy();
      }
    }
  });

  // -----------------------------------------------------------------------
  // 5. @CHIEF_DESIGNER mid-paragraph hydrates as chip and serialises canonically
  // -----------------------------------------------------------------------
  it('@CHIEF_DESIGNER mid-paragraph hydrates as chip and serialises canonically', () => {
    const initial = 'review @CHIEF_DESIGNER for the brief';
    const editor = createEditor(initial);
    try {
      const json = editor.getJSON();
      const inlines = (json.content?.[0]?.content ?? []) as Array<{
        type?: string;
        attrs?: Record<string, unknown>;
      }>;
      const mention = inlines.find((node) => node.type === 'mention');
      expect(mention).toBeDefined();
      expect(mention?.attrs).toMatchObject({ kind: 'command', command: 'CHIEF_DESIGNER' });
      // The mention chip serialises back via tokenForMention(attrs).
      expect(getCurrentPromptMarkdown(editor)).toBe(initial);
    } finally {
      editor.destroy();
    }
  });

  // -----------------------------------------------------------------------
  // 6. @CHIEF_DESIGNER then space then HardBreak (Shift+Enter) round-trips with no &nbsp;
  // -----------------------------------------------------------------------
  it('@CHIEF_DESIGNER then space then HardBreak (Shift+Enter) round-trips with no &nbsp;', () => {
    const editor = createEditor('@CHIEF_DESIGNER hello');
    try {
      // Insert HardBreak between 'hello' and end. PM positions for `<p>[mention] hello</p>`:
      // 1 = before mention atom, 2 = after mention atom (which serialises as the full
      // '@CHIEF_DESIGNER ' token; the atom counts as PM size 1), 3..7 = inside 'hello',
      // 8 = end of inline content. Insert HardBreak at end-of-paragraph (position 7).
      // Use doc.content.size - 1 to land before the close-paragraph boundary.
      insertHardBreakAt(editor, editor.state.doc.content.size - 1);
      const md = getCurrentPromptMarkdown(editor);
      // Override emits HardBreak as '\n' (NOT '  \n').
      expect(md).not.toContain('&nbsp;');
      expect(md).not.toContain('  \n');
      expect(md.startsWith('@CHIEF_DESIGNER hello')).toBe(true);
      expect(md.endsWith('\n')).toBe(true);
    } finally {
      editor.destroy();
    }
  });

  // -----------------------------------------------------------------------
  // 7. typing @ then space (no recognised command) does not corrupt the doc
  // -----------------------------------------------------------------------
  it('typing @ then space (no recognised command) does not corrupt the doc', () => {
    const editor = createEditor('');
    try {
      editor.commands.insertContent('@');
      editor.commands.insertContent(' ');
      const md = getCurrentPromptMarkdown(editor);
      // No registered command was completed; the doc remains plain text.
      expect(md).toBe('@ ');
      expect(md).not.toContain('&nbsp;');
      // Still a single paragraph — no growth from the @ insertion.
      expect(editor.getJSON().content?.length).toBe(1);
    } finally {
      editor.destroy();
    }
  });

  // -----------------------------------------------------------------------
  // 8. typing @ then Backspace deletes the @ cleanly
  // -----------------------------------------------------------------------
  it('typing @ then Backspace deletes the @ cleanly', () => {
    const editor = createEditor('hi');
    try {
      editor.commands.setTextSelection(editor.state.doc.content.size - 1);
      editor.commands.insertContent('@');
      expect(getCurrentPromptMarkdown(editor)).toBe('hi@');
      // Delete the '@' via a transaction (Backspace in PM = delete one char before caret).
      const caret = editor.state.selection.from;
      editor.view.dispatch(editor.state.tr.delete(caret - 1, caret));
      const md = getCurrentPromptMarkdown(editor);
      expect(md).toBe('hi');
      expect(md).not.toContain('@');
      expect(md).not.toContain('&nbsp;');
    } finally {
      editor.destroy();
    }
  });

  // -----------------------------------------------------------------------
  // 9. typing @ in the third paragraph (after two empty paragraphs) opens picker at correct caret
  // -----------------------------------------------------------------------
  it('typing @ in the third paragraph (after two empty paragraphs) opens picker at correct caret', () => {
    // Build a doc with three paragraphs: 'hello' + empty + empty + (start typing here).
    // markdownToDoc('hello\n\n\n') → paragraphs ['hello', '', '', ''].
    const editor = createEditor('hello\n\n\n');
    try {
      // Caret to the very end (last paragraph, an empty one).
      editor.commands.setTextSelection(editor.state.doc.content.size);
      editor.commands.insertContent('@');
      const md = getCurrentPromptMarkdown(editor);
      const caretIdx = getCaretMarkdownIndex(editor);
      // Picker detection runs on the markdown + caret; the trigger is the '@' we just typed.
      const trigger = findMentionTrigger(md, caretIdx);
      expect(trigger).not.toBeNull();
      expect(trigger?.query).toBe('');
      // The @ landed in the fourth paragraph (third empty before becomes third after content).
      expect(md.endsWith('@')).toBe(true);
      expect(md).not.toContain('&nbsp;');
    } finally {
      editor.destroy();
    }
  });

  // -----------------------------------------------------------------------
  // 10. IME composition with @ does not fire updateMentionContext mid-composition (Stage 4)
  // -----------------------------------------------------------------------
  it('Stage 4: IME composition with @ does not fire updateMentionContext mid-composition; fires after compositionend', () => {
    // The parent-layer scheduler defers when `editor.view.composing` is true.
    // Production reads the getter directly; vitest can't easily mock it, so
    // the test injects a controllable `isComposing` flag via the factory's
    // dependency parameter (the same swap the integration spike uses).
    vi.useFakeTimers();
    try {
      const editor = createEditor('');
      try {
        let composing = true;
        const fired: Array<{ value: string; caret: number }> = [];
        const scheduler = createMentionContextScheduler({
          onFire: (value, caret) => fired.push({ value, caret }),
          isPickerOpen: () => false,
          getEditor: () => editor,
          isComposing: () => composing,
          isCaretOnChip: () => false,
          // Disable first-`@` fast-path so the IME guard is the gating mechanism.
          detectFreshTrigger: () => false,
        });

        // User types `@` while IME composition is active. Schedule defers.
        scheduler.schedule('@', 1);
        vi.advanceTimersByTime(1000);
        expect(fired.length).toBe(0);

        // Composition ends → compositionend listener invokes `flushDeferred`.
        composing = false;
        scheduler.flushDeferred();
        vi.advanceTimersByTime(MENTION_DEBOUNCE_MS);
        expect(fired.length).toBe(1);
        expect(fired[0].value).toBe('@');
        expect(fired[0].caret).toBe(1);
      } finally {
        editor.destroy();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  // -----------------------------------------------------------------------
  // 11. pasting 10k characters of mixed text and @ mentions completes in <100ms and round-trips
  // -----------------------------------------------------------------------
  it('pasting 10k characters of mixed text and @ mentions completes in <100ms and round-trips', () => {
    const editor = createEditor('');
    try {
      // ~10k chars: alternate plain text + occasional registered command tokens.
      const block = 'lorem ipsum dolor sit amet, ';
      const segments: string[] = [];
      let total = 0;
      let i = 0;
      while (total < 10_000) {
        if (i % 25 === 0) {
          segments.push('@CHIEF_DESIGNER review the brief.\n');
        } else {
          segments.push(block);
        }
        total += segments[segments.length - 1].length;
        i++;
      }
      const big = segments.join('');

      const t0 = performance.now();
      editor.commands.insertContent(big);
      const after = getCurrentPromptMarkdown(editor);
      const t1 = performance.now();

      expect(after).not.toContain('&nbsp;');
      expect(after).toContain('@CHIEF_DESIGNER ');
      // Round-trip: a second pass through markdownToDoc/docToMarkdown is bit-stable.
      const second = docToMarkdown(markdownToDoc(after));
      expect(second).toBe(after);
      // Soft perf budget — <100ms in CI.
      expect(t1 - t0).toBeLessThan(100);
    } finally {
      editor.destroy();
    }
  });

  // -----------------------------------------------------------------------
  // 12. rehydrating an &nbsp;-corrupted prompt produces a clean doc on next emit
  // -----------------------------------------------------------------------
  it('rehydrating an &nbsp;-corrupted prompt produces a clean doc on next emit', () => {
    // markdownToDoc runs the C1 sanitiser as the first step; the editor's
    // wire-format export should never re-emit `&nbsp;`.
    const corrupted = 'hello&nbsp;world\n\n&nbsp;\n\nfoo&nbsp;bar';
    const editor = createEditor(corrupted);
    try {
      const md = getCurrentPromptMarkdown(editor);
      expect(md).toBe('hello world\n\n\n\nfoo bar');
      expect(md).not.toContain('&nbsp;');
      expect(md).not.toContain('\u00a0');
    } finally {
      editor.destroy();
    }
  });

  // -----------------------------------------------------------------------
  // 13. edit-message rerun: setMarkdown then getCurrentPromptMarkdown returns the input verbatim
  // -----------------------------------------------------------------------
  it('edit-message rerun: setMarkdown then getCurrentPromptMarkdown returns the input verbatim', () => {
    const editor = createEditor('initial draft');
    try {
      // Production flow: handle.setMarkdown() calls editor.commands.setContent(markdownToDoc(...)).
      const rerunBody = 'use @CHIEF_DESIGNER on @`docs/brief.md` and @[Friday Pulse](rebel://conversation/abc-123)';
      editor.commands.setContent(markdownToDoc(rerunBody), { emitUpdate: true });
      const md = getCurrentPromptMarkdown(editor);
      expect(md).toBe(rerunBody);
      expect(md).not.toContain('&nbsp;');
    } finally {
      editor.destroy();
    }
  });

  // -----------------------------------------------------------------------
  // 14. after 50 fast keystrokes containing @, the doc paragraph count remains stable
  // -----------------------------------------------------------------------
  it('after 50 fast keystrokes containing @, the doc paragraph count remains stable', () => {
    const editor = createEditor('');
    try {
      const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789 ';
      let seed = 4242;
      for (let i = 0; i < 50; i++) {
        // Insert '@' at a deterministic interval; otherwise random alphanumeric.
        if (i % 7 === 0) {
          editor.commands.insertContent('@');
        } else {
          seed = (seed * 16807) % 2147483647;
          const ch = alphabet[seed % alphabet.length];
          editor.commands.insertContent(ch);
        }
      }
      const md = getCurrentPromptMarkdown(editor);
      // Paragraph count should remain at 1 — the regression produced runaway empty-paragraph growth.
      expect(editor.getJSON().content?.length).toBe(1);
      expect(md).not.toContain('&nbsp;');
    } finally {
      editor.destroy();
    }
  });

  // -----------------------------------------------------------------------
  // BONUS — H10 undo / redo preservation (parent prompt asks for affirmative
  //         undo/redo proof beyond the spike, runs alongside the 14 named cases).
  // -----------------------------------------------------------------------
  it('H10: undo / redo preserves edits made via tr.insertText (affirmative)', () => {
    const editor = createEditor('hello');
    try {
      const insertPos = editor.state.doc.content.size - 1;
      editor.view.dispatch(editor.state.tr.insertText(' world', insertPos));
      expect(getCurrentPromptMarkdown(editor)).toBe('hello world');

      const undid = editor.commands.undo();
      expect(undid).toBe(true);
      expect(getCurrentPromptMarkdown(editor)).toBe('hello');

      const redid = editor.commands.redo();
      expect(redid).toBe(true);
      expect(getCurrentPromptMarkdown(editor)).toBe('hello world');
    } finally {
      editor.destroy();
    }
  });

  // -----------------------------------------------------------------------
  // BONUS — H12 trailing-space per kind via insertMentionAtMarkdownRange (Stage 4).
  // -----------------------------------------------------------------------
  it('Stage 4 (H12): per-kind trailing-space contract via insertMentionAtMarkdownRangeOnEditor', () => {
    // The H12 fix lives in `insertMentionAtMarkdownRangeOnEditor` (the pure
    // function the imperative handle delegates to). For each non-`command`
    // kind the adapter must append a single ASCII space; for `command` kind
    // the wire token already ends with a space and the adapter must NOT
    // double-it.
    type Attrs = import('../../utils/promptDoc').MentionAttrs;
    type Case = { name: string; attrs: Attrs; expected: string };
    const cases: Case[] = [
      {
        name: 'command — wire form already ends in space; no double-space',
        attrs: { kind: 'command', label: '@CHIEF_DESIGNER', command: 'CHIEF_DESIGNER' },
        expected: '@CHIEF_DESIGNER ',
      },
      {
        name: 'file — wire form has no trailing space; adapter appends one',
        attrs: {
          kind: 'file',
          label: 'brief.md',
          relativePath: 'docs/brief.md',
        },
        expected: '@`docs/brief.md` ',
      },
      {
        name: 'conversation — wire form has no trailing space; adapter appends one',
        attrs: {
          kind: 'conversation',
          label: 'Friday Pulse',
          conversationTitle: 'Friday Pulse',
          conversationId: 'abc-123',
        },
        expected: '@[Friday Pulse](rebel://conversation/abc-123) ',
      },
      {
        name: 'model — wire form has no trailing space; adapter appends one',
        attrs: {
          kind: 'model',
          label: '@model:Working Brain',
          profileName: 'Working Brain',
        },
        expected: '@model:`Working Brain` ',
      },
      {
        name: 'operator — wire form has no trailing space; adapter appends one',
        attrs: {
          kind: 'operator',
          label: 'Skeptical Engineer',
          operatorSlug: 'skeptical-engineer',
          operatorId: '/workspace/Chief-of-Staff::skeptical-engineer',
          operatorName: 'Skeptical Engineer',
        },
        expected: '@operator:skeptical-engineer ',
      },
    ];

    for (const c of cases) {
      const editor = createEditor('');
      try {
        // Insert without a range → at-caret insertion. The H12 contract is
        // about the adapter's whitespace handling, independent of range
        // resolution.
        insertMentionAtMarkdownRangeOnEditor(editor, undefined, c.attrs);
        const md = getCurrentPromptMarkdown(editor);
        expect(md, `case: ${c.name}`).toBe(c.expected);
        // Exactly one trailing space — never two.
        expect(md.endsWith('  '), `case ${c.name} no double-space`).toBe(false);
      } finally {
        editor.destroy();
      }
    }
  });

  // -----------------------------------------------------------------------
  // PROPERTY: 50 random keystroke sequences each containing `@` produce stable
  //           doc paragraph counts (per parent prompt; deterministic seed).
  // -----------------------------------------------------------------------
  it('property: 50 random keystroke sequences containing @ produce a stable single-paragraph doc', () => {
    const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let seed = 9001;
    function nextChar(): string {
      seed = (seed * 16807) % 2147483647;
      return alphabet[seed % alphabet.length];
    }

    for (let trial = 0; trial < 50; trial++) {
      const editor = createEditor('');
      try {
        // Each trial: 30 keystrokes including at least one '@' at a random index.
        const atIndex = Math.floor((seed * 16807) % 30);
        for (let i = 0; i < 30; i++) {
          if (i === atIndex) {
            editor.commands.insertContent('@');
          } else {
            editor.commands.insertContent(nextChar());
          }
        }
        const json = editor.getJSON();
        const md = getCurrentPromptMarkdown(editor);
        // Each trial produces a stable 1-paragraph doc; no `&nbsp;` growth.
        expect(json.content?.length).toBe(1);
        expect(md).not.toContain('&nbsp;');
        // The character count is bounded — at most 30 characters typed; we assert
        // no growth (the regression produced runaway markdown size on each keystroke).
        expect(md.length).toBeLessThanOrEqual(31);
      } finally {
        editor.destroy();
      }
    }
  });

  // -----------------------------------------------------------------------
  // STAGE 6 — external setText ingress branding (toComposerWireMarkdown)
  //
  // These cases lock the Stage 2 brand contract: external strings entering
  // the editor through the imperative `setMarkdown` / `setContent` path
  // must be cleaned at the boundary so no `&nbsp;` reaches the rendered
  // DOM, the editor's emitted markdown, or the caller's tracked state. See
  // docs-private/investigations/260505_composer_nbsp_recurrence.md Stage 6.
  // -----------------------------------------------------------------------
  it('Stage 6: external setMarkdown with corrupted input + immediate read returns sanitised wire form', () => {
    const editor = createEditor('');
    try {
      const corrupted = 'hello&nbsp;world\n\n&nbsp;\n\nfoo';
      const branded = toComposerWireMarkdown(corrupted);
      // The branded value is what `composerRef.setText` would route to the
      // editor's `setMarkdown` (which calls `setContent(markdownToDoc(...))`).
      editor.commands.setContent(markdownToDoc(branded), { emitUpdate: false });
      const md = getCurrentPromptMarkdown(editor);
      // No NBSP variant survives in the editor's wire-format read.
      expect(md).not.toContain('&nbsp;');
      expect(md).not.toContain('\u00a0');
      expect(md).not.toContain('&NBSP;');
      // The branded value itself is already sanitised at the boundary, so
      // the editor's emit equals the brand: editor and parent state stay
      // in lock-step.
      expect(md).toBe(branded);
      // Inline NBSP became a regular space; sentinel-empty paragraphs were
      // stripped to actual empty paragraphs.
      expect(md).toBe('hello world\n\n\n\nfoo');
    } finally {
      editor.destroy();
    }
  });

  it('Stage 6: corrupted external setMarkdown leaves no &nbsp; in rendered DOM', () => {
    const editor = createEditor('');
    try {
      const corrupted = 'hello&nbsp;world\n\n&nbsp;\n\n&nbsp;\n\nfoo&nbsp;bar';
      editor.commands.setContent(markdownToDoc(toComposerWireMarkdown(corrupted)), {
        emitUpdate: false,
      });
      // Editor view DOM read — verifies no escape hatch leaks the literal
      // entity text or the literal NBSP character into rendered output.
      const renderedText = editor.view.dom.textContent ?? '';
      expect(renderedText).not.toContain('&nbsp;');
      expect(renderedText).not.toContain('\u00a0');
      // Wire-format read also clean.
      const md = getCurrentPromptMarkdown(editor);
      expect(md).not.toContain('&nbsp;');
      expect(md).not.toContain('\u00a0');
    } finally {
      editor.destroy();
    }
  });

  it('Stage 6: simulated edit-rerun of a corrupted message + subsequent typing keeps wire format clean', () => {
    // Reproduces the production flow for the App.tsx `composerRef.setText`
    // edit-rerun path: setMarkdown(branded) → user types more → assert no
    // `&nbsp;` reaches the editor's markdown emit at any point.
    const editor = createEditor('');
    try {
      const preFixCorruptedMessage = 'review&nbsp;this\n\n&nbsp;\n\nbody&nbsp;text';
      editor.commands.setContent(
        markdownToDoc(toComposerWireMarkdown(preFixCorruptedMessage)),
        { emitUpdate: false },
      );
      // After the rerun-style external set, type more characters at the end.
      editor.commands.setTextSelection(editor.state.doc.content.size);
      editor.commands.insertContent(' done');
      const md = getCurrentPromptMarkdown(editor);
      expect(md).not.toContain('&nbsp;');
      expect(md).not.toContain('\u00a0');
      // The trailing typed text survived unmodified.
      expect(md.endsWith(' done')).toBe(true);
      // Rendered DOM also clean.
      expect(editor.view.dom.textContent ?? '').not.toContain('&nbsp;');
    } finally {
      editor.destroy();
    }
  });

  // -----------------------------------------------------------------------
  // BUG-FIX REGRESSION — Shift+Enter cursor jump
  //
  // Locks the two halves of the fix in
  // `docs/plans/260511_shift_enter_cursor_jump_fix.md`:
  //   1. The wire format round-trip for a HardBreak is structurally lossy —
  //      `markdownToDoc(emitted)` produces a doc that is NOT `Node.eq()` to
  //      the editor's actual doc. The pre-fix rehydrate effect used
  //      `editor.state.doc.eq(hydratedDoc)` and consequently hit a false
  //      positive on every Shift+Enter, triggering a `setContent` that
  //      reset the selection to end-of-doc.
  //   2. Doc identity (`editor.state.doc === capturedDocRef`) is stable
  //      across the emit → simulated-rehydrate cycle — the invariant the
  //      production fix relies on to short-circuit rehydrate without
  //      paying the lossy `markdownToDoc` cost or running `setContent`.
  // -----------------------------------------------------------------------
  it('Shift+Enter: HardBreak doc and markdownToDoc(emitted) are structurally non-equal (failure-condition lock)', () => {
    const editor = createEditor('foo');
    try {
      // Place caret at end of 'foo' and dispatch a HardBreak insert — the
      // same shape of transaction TipTap's default Shift+Enter handler
      // produces.
      insertHardBreakAt(editor, editor.state.doc.content.size - 1);

      const emitted = getCurrentPromptMarkdown(editor);
      expect(emitted).toBe('foo\n');

      // The editor's actual doc has one paragraph containing 'foo' + a
      // HardBreak atom. `markdownToDoc('foo\n')` splits on '\n' into two
      // paragraphs. Both serialise to the same wire string, but they are
      // structurally non-equal — exactly the false-positive condition the
      // prior `Node.eq` guard hit.
      const hydratedJson = markdownToDoc(emitted);
      const hydratedDoc = editor.schema.nodeFromJSON(hydratedJson);
      expect(editor.state.doc.eq(hydratedDoc)).toBe(false);
    } finally {
      editor.destroy();
    }
  });

  it('Shift+Enter: doc identity is preserved across an emit → unchanged-value cycle (identity-guard lock)', () => {
    const editor = createEditor('foo');
    try {
      insertHardBreakAt(editor, editor.state.doc.content.size - 1);

      // The production `onUpdate` records `state.doc` alongside the emitted
      // markdown. Mirror that capture here.
      const emitted = getCurrentPromptMarkdown(editor);
      const capturedDoc = editor.state.doc;

      // Simulate the rehydrate effect running with the same value we
      // emitted. Production reads `editor.state.doc === lastEmittedDocRef.current`
      // and short-circuits. Without any intervening transaction, the doc
      // reference must still be identical — proving the production check
      // would skip `setContent` and leave the selection untouched.
      expect(editor.state.doc).toBe(capturedDoc);

      // Sanity: the failure-condition guard (structural eq) would have
      // returned false here, demonstrating why the prior guard fired.
      const hydratedJson = markdownToDoc(emitted);
      const hydratedDoc = editor.schema.nodeFromJSON(hydratedJson);
      expect(editor.state.doc.eq(hydratedDoc)).toBe(false);
    } finally {
      editor.destroy();
    }
  });

  // -----------------------------------------------------------------------
  // BUG-FIX REGRESSION — Shift+Enter paragraph-split keybinding (second
  // amendment, 2026-05-11). After the first cursor-jump fix shipped, the
  // user reported that macOS `Ctrl-A` / `Ctrl-E` jumped to the start / end
  // of the whole message instead of the current visual line — symptom of
  // `<br>` inside `<p>` being treated as one textblock by TipTap's
  // macOS-keymap `selectTextblockStart` / `selectTextblockEnd` bindings.
  //
  // Fix: rebind `Shift+Enter` (and `Mod+Enter`) to paragraph-split in
  // `composerEditorFactory.ts` via `PromptParagraphBreakKeymap`. Keep
  // `PromptHardBreak` in the schema (paste / imperative / legacy paths)
  // but strip its default `addKeyboardShortcuts`.
  // -----------------------------------------------------------------------
  it('Shift+Enter splits the current paragraph (not setHardBreak)', () => {
    const editor = createEditor('foo');
    try {
      editor.commands.focus();
      editor.commands.setTextSelection(editor.state.doc.content.size - 1);

      const event = new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      });
      editor.view.dom.dispatchEvent(event);

      const json = editor.getJSON();
      expect(json.content?.length).toBe(2);
      expect(json.content?.[0]?.type).toBe('paragraph');
      expect(json.content?.[1]?.type).toBe('paragraph');

      const hasAnyHardBreak = JSON.stringify(json).includes('"hardBreak"');
      expect(hasAnyHardBreak).toBe(false);

      expect(getCurrentPromptMarkdown(editor)).toBe('foo\n');
    } finally {
      editor.destroy();
    }
  });

  it('Shift+Enter in the middle of text preserves both sides as separate paragraphs', () => {
    const editor = createEditor('foo bar');
    try {
      editor.commands.focus();
      // PM positions inside `<p>foo bar</p>`: 1=before 'f', 4=after "foo"/before ' ', 5=after "foo "/before 'b'.
      editor.commands.setTextSelection(4);

      const event = new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      });
      editor.view.dom.dispatchEvent(event);

      const md = getCurrentPromptMarkdown(editor);
      expect(md).toBe('foo\n bar');
      const json = editor.getJSON();
      expect(json.content?.length).toBe(2);
      expect(JSON.stringify(json)).not.toContain('"hardBreak"');
    } finally {
      editor.destroy();
    }
  });

  it('Shift+Enter after a mention chip keeps the mention serialization stable', () => {
    const editor = createEditor('@CHIEF_DESIGNER hello');
    try {
      // Place caret at end of the doc — after "hello".
      editor.commands.focus();
      editor.commands.setTextSelection(editor.state.doc.content.size - 1);

      const event = new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      });
      editor.view.dom.dispatchEvent(event);

      const md = getCurrentPromptMarkdown(editor);
      // Chip wire format unchanged; new empty paragraph appended.
      expect(md).toBe('@CHIEF_DESIGNER hello\n');
      // The mention atom survived as a node, not as plain text.
      const json = editor.getJSON();
      const inlines = (json.content?.[0]?.content ?? []) as Array<{
        type?: string;
        attrs?: Record<string, unknown>;
      }>;
      const mentionNode = inlines.find((n) => n.type === 'mention');
      expect(mentionNode).toBeDefined();
      expect(mentionNode?.attrs?.command).toBe('CHIEF_DESIGNER');
      // No HardBreak slipped in.
      expect(JSON.stringify(json)).not.toContain('"hardBreak"');
    } finally {
      editor.destroy();
    }
  });

  it('setHardBreak command remains a serialization safety net (imperative path)', () => {
    // Locks the schema-still-includes-HardBreak invariant: even though
    // keyboard input no longer produces HardBreak nodes, the schema
    // still accepts them via paste / imperative commands / legacy drafts,
    // and any such node still serialises to the canonical wire `\n`.
    const editor = createEditor('foo');
    try {
      editor.commands.focus();
      editor.commands.setTextSelection(editor.state.doc.content.size - 1);
      const ran = editor.commands.setHardBreak();
      expect(ran).toBe(true);
      expect(JSON.stringify(editor.getJSON())).toContain('"hardBreak"');
      expect(getCurrentPromptMarkdown(editor)).toBe('foo\n');
    } finally {
      editor.destroy();
    }
  });

  it('Shift+Enter while IME composition is active does not split the paragraph', () => {
    const editor = createEditor('foo');
    try {
      editor.commands.focus();
      editor.commands.setTextSelection(editor.state.doc.content.size - 1);

      // Force `view.composing` to true by dispatching a compositionstart on
      // the editor DOM. ProseMirror reads composition state via the view's
      // internal `composing` flag set on compositionstart and cleared on
      // compositionend.
      editor.view.dom.dispatchEvent(
        new CompositionEvent('compositionstart', { bubbles: true }),
      );

      const event = new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      });
      editor.view.dom.dispatchEvent(event);

      // Either nothing happened (composition guard returned false and no
      // other handler claimed the event) or the doc stayed structurally a
      // single paragraph. The invariant we lock is: NO paragraph split
      // happened while composing.
      const json = editor.getJSON();
      if ((json.content?.length ?? 0) > 1) {
        throw new Error(
          'Shift+Enter during IME composition split the paragraph; the composing guard regressed.',
        );
      }

      // Clean up the composition state so subsequent tests aren't affected
      // by happy-dom's shared document.
      editor.view.dom.dispatchEvent(
        new CompositionEvent('compositionend', { bubbles: true }),
      );
    } finally {
      editor.destroy();
    }
  });

  it('Stage 6: toComposerWireMarkdown is the single sanctioned mint path (round-trip stability)', () => {
    // The brand must be idempotent through a full editor round-trip:
    // toWire(input) → markdownToDoc → docToMarkdown should not re-introduce
    // any NBSP variants, and the final emit should equal the brand.
    const inputs = [
      'hello world',
      'hello&nbsp;world',
      'first\n\n&nbsp;\n\nsecond',
      'mix\u00a0and&NBSP;and&#160;and&#xA0;',
    ];
    for (const raw of inputs) {
      const branded = toComposerWireMarkdown(raw);
      const editor = createEditor('');
      try {
        editor.commands.setContent(markdownToDoc(branded), { emitUpdate: false });
        const md = getCurrentPromptMarkdown(editor);
        expect(md, `input=${JSON.stringify(raw)}`).not.toContain('&nbsp;');
        expect(md, `input=${JSON.stringify(raw)}`).not.toContain('\u00a0');
        expect(md, `input=${JSON.stringify(raw)}`).toBe(branded);
      } finally {
        editor.destroy();
      }
    }
  });
});
