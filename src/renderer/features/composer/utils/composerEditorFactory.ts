/**
 * Composer wire-format extensions — single source of truth.
 *
 * Returns the canonical TipTap extensions array used by **production**
 * (`TipTapPromptEditor.tsx`'s `useEditor`) AND **all tests** (contract test,
 * editor-level tests, fixture round-trips). Eliminates the "tests configure a
 * different extension list than production" drift that allowed `967f0b058` to
 * ship the @-mention `&nbsp;` regression.
 *
 * Architecture: Path 1b+ — override `@tiptap/markdown`'s node-level renderers
 * for `Document`, `Paragraph`, and `HardBreak` so the wire format is symmetric
 * with `markdownToDoc`/`docToMarkdown`'s round-trip pair, AND disable leaky
 * StarterKit defaults (`link`, `underline`, plus `bold`/`italic`/`strike`/
 * `code`/`heading`/`bulletList`/`orderedList`/`listItem`/`codeBlock`/
 * `blockquote`/`horizontalRule`/`trailingNode`) so the composer's tiny schema
 * (paragraph + text + hardBreak + mention) cannot grow accidentally via paste
 * or IME flows.
 *
 * Wire format produced:
 *   - Between paragraphs: single `\n`
 *     (`PromptDocument.renderMarkdown` overrides upstream `'\n\n'` separator).
 *   - Empty paragraph: empty string
 *     (`PromptParagraph.renderMarkdown` overrides upstream
 *     `EMPTY_PARAGRAPH_MARKDOWN = '&nbsp;'` constant).
 *   - HardBreak inside a paragraph: single `\n`
 *     (`PromptHardBreak.renderMarkdown` overrides upstream `'  \n'`).
 *   - Mention atom: `tokenForMention(attrs)` (unchanged — bit-stable for
 *     backend mention-extraction regexes; defined in `MentionNode.tsx`).
 *
 * Keyboard contract for newlines (locked 2026-05-11 second amendment):
 *   - `Shift+Enter` and `Mod+Enter` split the current paragraph instead of
 *     inserting a `hardBreak` atom (see `PromptParagraphBreakKeymap` below).
 *     This makes each visual line its own ProseMirror textblock, so the
 *     macOS Cocoa `Ctrl-A` / `Ctrl-E` shortcuts (mapped by TipTap's keymap
 *     extension to `selectTextblockStart()` / `selectTextblockEnd()`) move
 *     the caret to the start/end of the current line, not the whole
 *     message. It also makes the markdown round-trip lossless for
 *     keyboard-produced docs, since `markdownToDoc("foo\n") === paragraph,
 *     paragraph` matches what the editor now actually holds.
 *   - `PromptHardBreak` stays in the schema and keeps its `renderMarkdown`
 *     override so any HardBreak that appears via paste, imperative
 *     transactions (`editor.commands.setHardBreak()`), legacy persisted
 *     drafts, or external sources still serialises to `\n`. Its default
 *     keyboard shortcuts (`Shift-Enter` / `Mod-Enter` → `setHardBreak`) are
 *     stripped so keyboard input never produces HardBreak nodes.
 *   - See `docs/plans/260511_shift_enter_cursor_jump_fix.md` (second
 *     amendment) for the full rationale and the Ctrl-A/Ctrl-E navigation
 *     evidence that prompted the change.
 *
 * Empirical validation: the integration spike at
 * `src/renderer/features/composer/__tests__/integration-spike.spike.test.ts`
 * (12/12 in 42ms) and the contract test at
 * `src/renderer/features/composer/__tests__/composerMarkdownContract.test.ts`
 * pin this wire format.
 *
 * Upstream version pinning rationale: `@tiptap/markdown` is pinned to
 * `~3.21.0` (tilde, patch updates only) in `package.json`. Minor bumps
 * require explicit re-validation against the contract test before merging.
 * The override channel (`Document.extend({ renderMarkdown })`,
 * `Paragraph.extend({ renderMarkdown })`, `HardBreak.extend({ renderMarkdown })`)
 * is read by `MarkdownManager.registerExtension` via `getExtensionField` — an
 * internal helper, not a public API. A 3.22 / 4.x refactor could change this
 * lookup; the contract test's exhaustive shape coverage detects any observable
 * wire-format change immediately. JSON does not accept comments, hence this
 * rationale lives here.
 *
 * See `docs/plans/260501_composer_tiptap_atmention_bugfix.md` for the full
 * architectural decision record (Path 1b+ vs Path 2 vs Path 3) and the
 * upgrade protocol.
 */

import { Extension, type AnyExtension } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { Document } from '@tiptap/extension-document';
import { Paragraph } from '@tiptap/extension-paragraph';
import { HardBreak } from '@tiptap/extension-hard-break';
import { MentionNode } from '../components/MentionNode';

/**
 * Override `Document.renderMarkdown` so the doc serialiser emits a single `\n`
 * between paragraphs (instead of upstream `\n\n`). This matches
 * `markdownToDoc`'s `prompt.split('\n')` round-trip pair.
 */
export const PromptDocument = Document.extend({
  renderMarkdown: (node, h) => {
    if (!node.content) return '';
    return h.renderChildren(node.content, '\n');
  },
});

/**
 * Override `Paragraph.renderMarkdown` so empty paragraphs serialise to empty
 * string (instead of upstream `EMPTY_PARAGRAPH_MARKDOWN = '&nbsp;'`). This is
 * the root cause of the @-mention `&nbsp;` regression: every keystroke triggered
 * a re-serialise, and the empty-paragraph sentinel grew on each iteration.
 */
export const PromptParagraph = Paragraph.extend({
  renderMarkdown: (node, h) => {
    if (!node) return '';
    const content = Array.isArray(node.content) ? node.content : [];
    if (content.length === 0) return '';
    return h.renderChildren(content);
  },
});

/**
 * Override `HardBreak.renderMarkdown` so a soft line break serialises to a
 * single `\n` (instead of upstream `'  \n'` — markdown hard-break with two
 * trailing spaces).
 *
 * Keyboard contract (2026-05-11 second amendment): the default
 * `Shift-Enter` / `Mod-Enter` shortcuts that map to `setHardBreak` are
 * stripped here. `PromptParagraphBreakKeymap` (below) rebinds those keys to
 * paragraph-split so keyboard input never produces a `hardBreak` atom.
 *
 * Why keep `PromptHardBreak` in the schema at all: HardBreak nodes can still
 * appear via (a) paste from external sources, (b) imperative
 * `editor.commands.setHardBreak()` calls (the H10 spike exercises this
 * path), (c) legacy persisted drafts predating the keymap change, and
 * (d) future schema extensions. Keeping the renderer override means any
 * such HardBreak still emits the canonical wire `\n`. Round-trip remains
 * wire-equivalent but lossy at node identity for those non-keyboard paths
 * (a HardBreak-bearing doc rehydrates as a paragraph-split doc) — the
 * doc-identity rehydrate guard in `TipTapPromptEditor.tsx` ensures this
 * lossy shape never triggers a self-feedback `setContent` (planning doc
 * `260511_shift_enter_cursor_jump_fix.md`).
 */
export const PromptHardBreak = HardBreak.extend({
  renderMarkdown: () => '\n',
  addKeyboardShortcuts() {
    return {};
  },
});

/**
 * Rebinds `Shift+Enter` (and `Mod+Enter`) to split the current paragraph
 * instead of inserting a `hardBreak` atom. This makes every visual line in
 * the composer its own ProseMirror textblock, which is what TipTap's
 * macOS-keymap `Ctrl-A` / `Ctrl-E` bindings
 * (`selectTextblockStart` / `selectTextblockEnd`) treat as "the current
 * line". Without this, a `<p>` containing `<br>` is one textblock and the
 * line-navigation shortcuts span the whole message — the regression that
 * surfaced after the first cursor-jump fix shipped.
 *
 * Priority `1000` so this wins over any future lower-priority keymap that
 * tries to claim the same combos. `view.composing` short-circuits during
 * IME composition so the platform's own composition flow is not disrupted.
 *
 * The fallback chain mirrors TipTap's built-in `handleEnter` exactly
 * (`newlineInCode` → `createParagraphNear` → `liftEmptyBlock` →
 * `splitBlock`); we just call it under `Shift+Enter` / `Mod+Enter` rather
 * than bare `Enter` (the parent `ComposerWithState.handleKeyDown` still
 * intercepts bare `Enter` as submit, so this fallback path is the relevant one
 * only when the parent does not consume the event).
 *
 * See `composerEditorFactory.ts` file-level comment and
 * `docs/plans/260511_shift_enter_cursor_jump_fix.md` (second amendment) for
 * the full rationale.
 */
export const PromptParagraphBreakKeymap = Extension.create({
  name: 'promptParagraphBreakKeymap',
  priority: 1000,
  addKeyboardShortcuts() {
    const splitPromptParagraph = () => {
      if (this.editor.view.composing) return false;
      return this.editor.commands.first(({ commands }) => [
        () => commands.newlineInCode(),
        () => commands.createParagraphNear(),
        () => commands.liftEmptyBlock(),
        () => commands.splitBlock({ keepMarks: true }),
      ]);
    };
    return {
      'Shift-Enter': splitPromptParagraph,
      'Mod-Enter': splitPromptParagraph,
    };
  },
});

/**
 * Build the canonical extensions array. Production and tests both consume
 * this; the contract test asserts schema-rejection invariants (no `link`,
 * `underline`, `bold`, `italic`, `strike`, `code` marks) so the disable list
 * cannot drift silently across upgrades.
 */
export function createPromptEditorExtensions(): AnyExtension[] {
  return [
    StarterKit.configure({
      // Replaced by overrides below.
      document: false,
      paragraph: false,
      hardBreak: false,
      // Disable leaky StarterKit defaults so the composer schema stays tiny.
      // Schema-rejection assertions in `composerMarkdownContract.test.ts`
      // catch any future StarterKit upgrade that re-enables these.
      heading: false,
      bulletList: false,
      orderedList: false,
      listItem: false,
      codeBlock: false,
      blockquote: false,
      code: false,
      bold: false,
      italic: false,
      strike: false,
      horizontalRule: false,
      // Cast required because StarterKit's option type is conservative.
      link: false as never,
      underline: false as never,
      trailingNode: false as never,
    }),
    Markdown,
    PromptDocument,
    PromptParagraph,
    PromptHardBreak,
    PromptParagraphBreakKeymap,
    MentionNode,
  ];
}
