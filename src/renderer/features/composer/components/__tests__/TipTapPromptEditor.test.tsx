// @vitest-environment happy-dom
/**
 * Editor-level contract tests for the TipTap prompt editor.
 *
 * Originally authored for Stage 1 of `docs/plans/260429_composer_rich_chips_input.md`.
 * Stage 2 of `docs/plans/260501_composer_tiptap_atmention_bugfix.md` rewrites
 * this file to construct the test `Editor` via
 * **`createPromptEditorExtensions()`** (the production single-source-of-truth
 * factory) — eliminating the prior drift between this file's hand-rolled
 * extension list and `composerMarkdownContract.test.ts`'s `trailingNode: false`
 * (90%-push critique H6). Assertions go through the exported
 * `getCurrentPromptMarkdown` wrapper for the same reason.
 *
 * The React node-view rendering (chip → ComposerContextChip) is covered by
 * Storybook visual review; the full type-select-send flow stays gated until
 * the rich editor feature flag is flipped for E2E.
 *
 * The contract these tests lock:
 *   - Plain markdown round-trips through the editor unchanged.
 *   - A doc with a hydrated mention node serialises back to the canonical
 *     token via `tokenForMention`.
 *   - `insertMention` command writes the right node + attrs into the doc.
 */

import { describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import { createPromptEditorExtensions } from '../../utils/composerEditorFactory';
import { markdownIndexToPmPos, markdownToDoc } from '../../utils/promptDoc';
import { getCurrentPromptMarkdown } from '../TipTapPromptEditor';

function createPromptEditor(initial = ''): Editor {
  return new Editor({
    content: markdownToDoc(initial),
    extensions: createPromptEditorExtensions(),
  });
}

describe('TipTapPromptEditor (headless, production extensions)', () => {
  it('round-trips plain markdown via getCurrentPromptMarkdown', () => {
    const editor = createPromptEditor('hello world');
    try {
      expect(getCurrentPromptMarkdown(editor)).toBe('hello world');
    } finally {
      editor.destroy();
    }
  });

  it('preserves blank lines without inserting entity text or extra spacing', () => {
    const editor = createPromptEditor('hello\n\nworld');
    try {
      expect(getCurrentPromptMarkdown(editor)).toBe('hello\n\nworld');
      expect(getCurrentPromptMarkdown(editor)).not.toContain('&nbsp;');
      expect(getCurrentPromptMarkdown(editor)).not.toContain('&nsp;');
      expect(getCurrentPromptMarkdown(editor)).not.toContain('\u00a0');
    } finally {
      editor.destroy();
    }
  });

  it('hydrates a mention node and serialises back to the canonical token', () => {
    const editor = createPromptEditor('@CHIEF_DESIGNER review this UI');
    try {
      // The mention node lives inside the first paragraph as an inline atom.
      const json = editor.getJSON();
      const inlines = (json.content?.[0]?.content ?? []) as Array<{
        type?: string;
        attrs?: Record<string, unknown>;
      }>;
      const mention = inlines.find((node) => node.type === 'mention');
      expect(mention).toBeDefined();
      expect(mention?.attrs).toMatchObject({ kind: 'command', command: 'CHIEF_DESIGNER' });

      expect(getCurrentPromptMarkdown(editor)).toBe('@CHIEF_DESIGNER review this UI');
    } finally {
      editor.destroy();
    }
  });

  it('inserts a command-kind chip via the insertMention command', () => {
    const editor = createPromptEditor('');
    try {
      editor.commands.insertMention({
        kind: 'command',
        label: '@CHIEF_DESIGNER',
        command: 'CHIEF_DESIGNER',
      });
      expect(getCurrentPromptMarkdown(editor)).toBe('@CHIEF_DESIGNER ');
    } finally {
      editor.destroy();
    }
  });

  it('replaces the typed trigger range when inserting a command-kind chip', () => {
    const editor = createPromptEditor('ask @CHIEF_DESIGNER');
    try {
      editor.commands.setTextSelection(editor.state.doc.content.size);
      const range = {
        from: 'ask '.length,
        to: 'ask @CHIEF_DESIGNER'.length,
      };
      const from = markdownIndexToPmPos(editor.getJSON(), range.from);
      const to = markdownIndexToPmPos(editor.getJSON(), range.to);
      editor
        .chain()
        .focus()
        .insertContentAt(
          { from, to },
          {
            type: 'mention',
            attrs: {
              kind: 'command',
              label: '@CHIEF_DESIGNER',
              command: 'CHIEF_DESIGNER',
            },
          },
        )
        .run();
      expect(getCurrentPromptMarkdown(editor)).toBe('ask @CHIEF_DESIGNER ');
    } finally {
      editor.destroy();
    }
  });

  it('the editor handle replaces the typed trigger range when inserting a command-kind chip', () => {
    const editor = createPromptEditor('ask @CHIEF_DESIGNER');
    try {
      const range = {
        from: 'ask '.length,
        to: 'ask @CHIEF_DESIGNER'.length,
      };
      const from = markdownIndexToPmPos(editor.getJSON(), range.from);
      const to = markdownIndexToPmPos(editor.getJSON(), range.to);
      editor
        .chain()
        .focus()
        .insertContentAt(
          { from, to },
          {
            type: 'mention',
            attrs: {
              kind: 'command',
              label: '@CHIEF_DESIGNER',
              command: 'CHIEF_DESIGNER',
            },
          },
        )
        .run();
      const md = getCurrentPromptMarkdown(editor);
      expect(md).toBe('ask @CHIEF_DESIGNER ');
      expect(md).not.toContain('@CHIEF_DESIGNER@CHIEF_DESIGNER');
    } finally {
      editor.destroy();
    }
  });

  it('preserves multiple chips and surrounding text on round-trip', () => {
    const editor = createPromptEditor('hi @CHIEF_DESIGNER look at @designContext now');
    try {
      expect(getCurrentPromptMarkdown(editor)).toBe(
        'hi @CHIEF_DESIGNER look at @designContext now',
      );
    } finally {
      editor.destroy();
    }
  });

  it('round-trips file, conversation, and model chips through getCurrentPromptMarkdown', () => {
    const prompt =
      'see @`docs/brief.md` and @[Friday Pulse](rebel://conversation/abc-123) with @model:`Working Brain`';
    const editor = createPromptEditor(prompt);
    try {
      expect(getCurrentPromptMarkdown(editor)).toBe(prompt);
      const json = editor.getJSON();
      const inlines = (json.content?.[0]?.content ?? []) as Array<{
        type?: string;
        attrs?: Record<string, unknown>;
      }>;
      const mentions = inlines.filter((node) => node.type === 'mention');
      expect(mentions.map((node) => node.attrs?.kind)).toEqual(['file', 'conversation', 'model']);
    } finally {
      editor.destroy();
    }
  });
});
