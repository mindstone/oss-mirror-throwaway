/**
 * TipTap-based prompt editor surface that supports inline removable mention chips anywhere in the
 * prompt. Stage 1 of `docs/plans/260429_composer_rich_chips_input.md` only inserts `command`-kind
 * chips through the suggestion adapter; the other three mention shapes ride alongside as plain
 * text until Stage 2 wires them up.
 *
 * Visual contract: this surface stays opt-in behind `composer.tiptap` until Stage 4 flips the flag.
 * It is rendered inside the same `.inputShell` element that the legacy textarea path uses, so the
 * focus ring, padding, light/dark, and chrome ownership (`standalone` vs `embedded`) are all
 * inherited from `AgentComposer.module.css` without duplication.
 *
 * State contract: the editor owns the ProseMirror doc, but the public API (props +
 * `TipTapPromptEditorHandle`) speaks markdown strings only — every consumer outside the composer
 * (drafts, attachments, evals, queue/edit/send) keeps reading the same prompt-string contract.
 */

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  type CSSProperties,
  type ClipboardEvent as ReactClipboardEvent,
  type RefObject,
} from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import type { Editor } from '@tiptap/core';
import Placeholder from '@tiptap/extension-placeholder';
import { cn } from '@renderer/lib/utils';
import {
  KNOWN_COMMAND_TRIGGERS,
  docToMarkdown,
  markdownIndexToPmPos,
  markdownToDoc,
  pmPosToMarkdownIndex,
  tokenForMention,
  type ComposerWireMarkdown,
  type CommandTrigger,
  type MarkdownToDocOptions,
  type MentionAttrs,
} from '../utils/promptDoc';
import { createPromptEditorExtensions } from '../utils/composerEditorFactory';
import {
  getCaretMarkdownIndex,
  getLayerASnapshot,
} from '../utils/composerSnapshotCache';
import styles from './TipTapPromptEditor.module.css';

export interface TipTapPromptEditorHandle {
  /** Imperatively focus the editor (replaces the textarea's `focus()`). */
  focus: () => void;
  /** Move the caret to the given markdown character offset (best-effort; clamped). */
  setSelectionToMarkdownIndex: (markdownIndex: number) => void;
  /** Returns the current markdown prompt string. Cheap; reads from `editor.storage.markdown`. */
  getMarkdown: () => string;
  /** Replace the entire content with the given markdown string. */
  setMarkdown: (markdown: string) => void;
  /** Insert a mention chip at the current caret, replacing the given markdown range. */
  insertMentionAtMarkdownRange: (
    range: { from: number; to: number } | undefined,
    attrs: MentionAttrs,
  ) => void;
  /** Returns the underlying TipTap editor for advanced cases (avoid where possible). */
  getEditor: () => Editor | null;
}

export interface TipTapPromptEditorProps {
  /** Current prompt string (canonical state owned by the parent). */
  value: string;
  /** Called whenever the prompt string or caret changes. */
  onChange: (value: string, markdownCaretIndex: number) => void;
  /** Placeholder text shown while the editor is empty. */
  placeholder?: string;
  /** Aria label for the input surface. */
  ariaLabel?: string;
  /** data-testid for the editor's contenteditable element. */
  testId?: string;
  /** Optional key handler. Receives a synthetic-event-shaped object for textarea-handler reuse. */
  onKeyDown?: (event: KeyboardEvent) => void;
  /** Notified on focus (used for cache warmup + mention-context refresh). */
  onFocus?: () => void;
  /** Notified on every transaction with the current markdown + caret index. */
  onTransaction?: (value: string, markdownCaretIndex: number) => void;
  /** Hook for parent to intercept paste before TipTap handles it (returns true to consume). */
  onPasteCapture?: (event: ClipboardEvent) => boolean;
  /**
   * Stage 4 of `docs/plans/260501_composer_tiptap_atmention_bugfix.md` —
   * IME guard parity. Invoked when `compositionend` fires on the editor's
   * DOM. The parent's mention-context scheduler uses this to flush its
   * IME-deferred debounce so the picker opens once composition commits,
   * even when no further `onUpdate` is triggered (compose-and-pause).
   */
  onCompositionEnd?: () => void;
  /** Optional CSS class merged with the default. */
  className?: string;
  /** Optional inline style for parent-driven sizing. */
  style?: CSSProperties;
  /** When true, the editor refuses input. */
  disabled?: boolean;
  /** Optional resolver used to label persisted `@operator:<slug>` chips. */
  resolveOperatorMention?: MarkdownToDocOptions['resolveOperatorMention'];
  /**
   * Compatibility bridge for legacy consumers that still expect a textarea-like ref. This is a
   * temporary Stage 1 shim; Stage 4 replaces it with a typed editor handle once the textarea path is
   * deleted.
   */
  commandInputRef?: RefObject<HTMLTextAreaElement | null>;
}

const DEFAULT_PLACEHOLDER = 'Type your command, or click the microphone to speak it';

/**
 * The single audited entry point for reading the composer's wire markdown.
 *
 * Returns the `ComposerWireMarkdown` brand: every consumer downstream knows the
 * string came through the override-enabled `editor.getMarkdown()` path defined
 * by `createPromptEditorExtensions()`. Lint guards (Stage 8) forbid direct
 * `.getMarkdown()` calls on any object inside the composer feature so the
 * wrapper invariant cannot be silently bypassed.
 *
 * Stage 1.5 — routes through the Layer A doc-keyed cache (see
 * `composerSnapshotCache.ts`). Selection-only transactions reuse the same
 * `editor.state.doc` reference, so repeated calls (the imperative handle, the
 * `commandInputRef` shim getters, the `onUpdate` / `onSelectionUpdate`
 * handlers, and parent debounced flushes) all hit the cache instead of paying
 * the O(n) serialise cost on every read.
 *
 * Exported for tests so the contract test imports the same wrapper production
 * uses.
 *
 * NOTE: Stage 8 of the planning doc adds an ESLint `no-restricted-syntax`
 * guard forbidding direct `.getMarkdown()` calls anywhere in the composer
 * feature. The single `editor.getMarkdown()` call inside
 * `getLayerASnapshot()` is the only audited entry point for that primitive;
 * when the rule lands it must be suppressed there with a comment naming this
 * wrapper as the audited consumer.
 */
export function getCurrentPromptMarkdown(editor: Editor): ComposerWireMarkdown {
  return getLayerASnapshot(editor).markdown;
}

/**
 * Pattern matching `@COMMAND ` triggers anywhere in a doc's text content. The
 * trailing space is required so we don't eagerly consume an in-progress
 * trigger (`@CHIEF_DESIGN` mid-typing). Mirrors the regex shape `markdownToDoc`
 * uses; the source-of-truth trigger list is `KNOWN_COMMAND_TRIGGERS` from
 * `promptDoc.ts`.
 */
const COMMAND_TRIGGER_PATTERN = `@(${KNOWN_COMMAND_TRIGGERS.join('|')}) `;
const HAS_COMMAND_TRIGGER_REGEX = new RegExp(COMMAND_TRIGGER_PATTERN);

/**
 * Convert any unconverted `@COMMAND ` text patterns in the editor's doc into
 * `mention` chip atoms — the keystroke-time chip surface for command kind.
 *
 * Stage 3 of `docs/plans/260501_composer_tiptap_atmention_bugfix.md` — H10
 * fix. The previous implementation called `editor.commands.setContent(...)`
 * which obliterated the undo/redo stack on every chip conversion. The
 * fallback path (chosen per the plan over an `InputRule` migration because
 * the picker coexistence is unclear) is a targeted PM transaction:
 *
 * 1. Walk the doc's text nodes (mention atoms are inline atoms with no
 *    `.isText`, so already-converted chips never re-trigger this code).
 * 2. For each `@COMMAND ` match in a text node, record its absolute PM
 *    position range and the mention attrs.
 * 3. Apply replacements in REVERSE document order (highest `from` first) so
 *    earlier positions remain valid as we mutate higher positions first
 *    (per post-spike Gemini-High amendment in the plan — guards multi-mention
 *    paste flows).
 * 4. Dispatch ALL replacements on a SINGLE transaction = single undoable
 *    history step. `editor.commands.undo()` returns true and reverts the
 *    chip back to text; redo replays it.
 *
 * The chip's wire format already includes the trailing space
 * (`tokenForMention({ kind: 'command', ... })` returns `'@CMD '`), so we
 * replace the matched text (including the trigger's own space) with the
 * chip atom alone — no extra space text node.
 *
 * Returns `true` when at least one replacement was dispatched, `false` when
 * the doc had no unconverted command triggers (fast-path via `textContent`
 * regex test).
 *
 * Exported for direct testing in `composerMarkdownContract.test.ts`; the
 * production call site is in `onUpdate` below, guarded by `normalisingRef`
 * so the dispatch's nested onUpdate doesn't recurse.
 */
export function normaliseCommandMentions(editor: Editor): boolean {
  // Fast-path: only do the descendants walk when at least one trigger pattern
  // is present in the doc text. `textContent` excludes mention atoms (no
  // `isText`), so already-resolved chips never trip this guard.
  if (!HAS_COMMAND_TRIGGER_REGEX.test(editor.state.doc.textContent)) return false;

  type CommandReplacement = {
    from: number;
    to: number;
    attrs: Extract<MentionAttrs, { kind: 'command' }>;
  };
  const replacements: CommandReplacement[] = [];

  editor.state.doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    const findRegex = new RegExp(COMMAND_TRIGGER_PATTERN, 'g');
    let match: RegExpExecArray | null;
    while ((match = findRegex.exec(node.text)) !== null) {
      const command = match[1] as CommandTrigger;
      replacements.push({
        from: pos + match.index,
        to: pos + match.index + match[0].length,
        attrs: {
          kind: 'command',
          label: `@${command}`,
          command,
        },
      });
    }
  });

  if (replacements.length === 0) return false;

  // Reverse document order: positions to the LEFT of any prior replacement
  // remain valid because PM only mutates the `[from, to]` range. Applying
  // higher positions first means subsequent (lower-position) replacements
  // see the same coordinate space they were measured in.
  replacements.sort((a, b) => b.from - a.from);

  const tr = editor.state.tr;
  for (const r of replacements) {
    const mentionNode = editor.schema.nodes.mention.create(r.attrs);
    tr.replaceWith(r.from, r.to, mentionNode);
  }
  editor.view.dispatch(tr);
  return true;
}

/**
 * Stage 4 H12 fix — kind-aware trailing-space contract for the rich-input
 * mention chip insertion path (FMM Row 21). Production `insertMentionAtMarkdownRange`
 * (the imperative-handle method exposed by `TipTapPromptEditor`) delegates to
 * this exported pure function so tests can drive the same logic on a raw
 * `Editor` without standing up the React component.
 *
 * Behaviour:
 *  - For `command` kind, `tokenForMention` already ends with a single space;
 *    appending another would produce a double space → no extra space added.
 *  - For `file` / `conversation` / `model` kinds, the wire token has no
 *    trailing space → adapter appends a single ASCII space so the user can
 *    keep typing immediately.
 *
 * The check uses `tokenForMention(attrs)` as the single source of truth; any
 * future kind that adds its own trailing space gets the right behaviour for
 * free.
 *
 * Exported for direct testing in `composerMarkdownContract.test.ts` and
 * `TipTapPromptEditor.editor.test.tsx`.
 */
export function insertMentionAtMarkdownRangeOnEditor(
  editor: Editor,
  range: { from: number; to: number } | undefined,
  attrs: MentionAttrs,
): void {
  const renderedToken = tokenForMention(attrs);
  const trailingSpaceNeeded = !/\s$/.test(renderedToken);
  if (range) {
    const fromPos = markdownIndexToPmPos(editor.getJSON(), range.from);
    const toPos = markdownIndexToPmPos(editor.getJSON(), range.to);
    const chain = editor
      .chain()
      .focus()
      .insertContentAt({ from: fromPos, to: toPos }, { type: 'mention', attrs });
    if (trailingSpaceNeeded) {
      chain.insertContent(' ');
    }
    chain.run();
    return;
  }
  const chain = editor.chain().focus().insertContent({ type: 'mention', attrs });
  if (trailingSpaceNeeded) {
    chain.insertContent(' ');
  }
  chain.run();
}

export const TipTapPromptEditor = forwardRef<TipTapPromptEditorHandle, TipTapPromptEditorProps>(
  function TipTapPromptEditorComponent(
    {
      value,
      onChange,
      placeholder = DEFAULT_PLACEHOLDER,
      ariaLabel,
      testId,
      onKeyDown,
      onFocus,
      onTransaction,
      onPasteCapture,
      onCompositionEnd,
      className,
      style,
      disabled = false,
      resolveOperatorMention,
      commandInputRef,
    },
    ref,
  ) {
    const onChangeRef = useRef(onChange);
    onChangeRef.current = onChange;
    const onTransactionRef = useRef(onTransaction);
    onTransactionRef.current = onTransaction;
    const onKeyDownRef = useRef(onKeyDown);
    onKeyDownRef.current = onKeyDown;
    const onPasteCaptureRef = useRef(onPasteCapture);
    onPasteCaptureRef.current = onPasteCapture;
    const onFocusRef = useRef(onFocus);
    onFocusRef.current = onFocus;
    /**
     * Stage 4 — `compositionend` listener bridge. Reads via ref so the
     * effect that registers the DOM listener does not need to re-run when
     * the parent rewires its callback.
     */
    const onCompositionEndRef = useRef(onCompositionEnd);
    onCompositionEndRef.current = onCompositionEnd;

    /**
     * Stage 3 H10 — re-entry guard. `normaliseCommandMentions` dispatches a PM
     * transaction via `editor.view.dispatch(tr)`, which fires `onUpdate`
     * synchronously. The guard short-circuits the nested call so we don't
     * recursively normalise the freshly-converted chip doc; the outer call
     * handles the post-normalisation emit.
     */
    const normalisingRef = useRef(false);

    /**
     * Track the last markdown the editor emitted to its parent via
     * `onChangeRef.current(...)`. Used by the rehydrate effect to
     * short-circuit when the parent passes our own emit back through the
     * `value` prop.
     *
     * Paired with `lastEmittedDocRef` (the `state.doc` reference at the
     * time of that emit) so the rehydrate effect can use cheap doc-
     * identity equality (`===` on the immutable PM doc) instead of a
     * structural `Node.eq(markdownToDoc(value))` check. The structural
     * check produced a false positive on every Shift+Enter: a paragraph
     * holding a HardBreak (`<p>foo<br></p>`) and the doc that
     * `markdownToDoc("foo\n")` produces (`<p>foo</p><p></p>`) are
     * wire-equivalent (PromptHardBreak override serialises a HardBreak as
     * `'\n'`, matching the paragraph-split separator) but structurally
     * non-equal, so the guard fell through to `setContent(...)` and reset
     * the selection. See `docs/plans/260511_shift_enter_cursor_jump_fix.md`.
     *
     * Second amendment (2026-05-11): keyboard input no longer produces
     * HardBreak nodes — `PromptParagraphBreakKeymap` in
     * `composerEditorFactory.ts` rebinds `Shift+Enter` / `Mod+Enter` to
     * paragraph-split, so the typed-newline case is now wire-and-structure
     * equivalent. The doc-identity invariant still applies to any non-
     * keyboard path that can produce HardBreaks (paste, imperative
     * `setHardBreak`, legacy persisted drafts), and is also strictly
     * cheaper than the structural variant, so the ref pair stays.
     */
    const lastEmittedValueRef = useRef<string | null>(null);
    const lastEmittedDocRef = useRef<Editor['state']['doc'] | null>(null);

    const initialDoc = useMemo(
      () => markdownToDoc(value, { resolveOperatorMention }),
      [], // eslint-disable-line react-hooks/exhaustive-deps -- intentional: omitting value so TipTap receives only the mount-time document; later value sync is handled by the rehydrate effect
    );

    const editor = useEditor({
      content: initialDoc,
      editable: !disabled,
      extensions: [
        // Single source of truth for the composer's TipTap extension list.
        // See `composerEditorFactory.ts` for the wire-format contract and the
        // upstream version-pin rationale.
        ...createPromptEditorExtensions(),
        Placeholder.configure({ placeholder }),
      ],
      editorProps: {
        attributes: {
          class: styles.editor,
          ...(ariaLabel ? { 'aria-label': ariaLabel } : {}),
          ...(testId ? { 'data-testid': testId } : {}),
        },
        handleKeyDown(_view, event) {
          if (onKeyDownRef.current) {
            onKeyDownRef.current(event);
            if (event.defaultPrevented) return true;
          }
          return false;
        },
      },
      onUpdate({ editor: ed }) {
        // Stage 3 H10: re-entry guard — when `normaliseCommandMentions`
        // dispatches its targeted PM transaction, this onUpdate fires
        // synchronously. The outer call handles the final emit; the nested
        // call returns early so we don't recurse the descendants walk over
        // an already-normalised doc.
        if (normalisingRef.current) {
          return;
        }
        // Do not transform the document while an IME composition is active.
        // ProseMirror handles the composition text natively; rehydrating into
        // mention atoms mid-composition can move the caret, corrupt candidate
        // text, or incorrectly open the mention popover. Once composition
        // commits, TipTap emits a normal transaction and this path can
        // safely normalise completed command tokens into chips.
        if (!ed.view.composing) {
          normalisingRef.current = true;
          try {
            normaliseCommandMentions(ed);
          } finally {
            normalisingRef.current = false;
          }
        }

        // Read the post-normalisation snapshot. Layer A invalidates on a
        // doc-mutating transaction (the dispatch above), so this is fresh
        // when normalisation ran, cache-hit otherwise.
        const layerA = getLayerASnapshot(ed);
        const markdown = layerA.markdown;
        const caret = getCaretMarkdownIndex(ed);

        // Track our own emit so the rehydrate effect can short-circuit when
        // the parent passes this exact markdown back via the `value` prop.
        // The paired doc-reference is the post-normalisation `state.doc`;
        // doc-identity equality is the actual invariant the rehydrate
        // short-circuit checks against (see `lastEmittedDocRef` declaration).
        lastEmittedValueRef.current = markdown;
        lastEmittedDocRef.current = ed.state.doc;
        onChangeRef.current?.(markdown, caret);
        if (!ed.view.composing) {
          onTransactionRef.current?.(markdown, caret);
        }
      },
      onSelectionUpdate({ editor: ed }) {
        if (ed.view.composing) return;
        // Stage 1.5: Layer A hits cache on selection-only transactions (doc
        // identity is stable). Layer B recomputes caret index per call.
        const markdown = getLayerASnapshot(ed).markdown;
        const caret = getCaretMarkdownIndex(ed);
        onTransactionRef.current?.(markdown, caret);
      },
      onFocus() {
        onFocusRef.current?.();
      },
    });

    // External `value` updates (e.g. session switch, draft hydration) flow
    // through `setMarkdown` via the imperative handle to avoid clobbering the
    // user's caret. We only rehydrate when the incoming value diverges from
    // the editor's current state — this prevents the editor from competing
    // with itself when `onChange` flushes back to the parent.
    //
    // The short-circuit uses doc-identity (`editor.state.doc === lastEmittedDocRef.current`)
    // rather than a structural `Node.eq(markdownToDoc(value))` check. PM
    // docs are immutable, so any transaction yields a new `state.doc`
    // reference; identity equality is "the editor's doc reference is the
    // one we last emitted from". This avoids two issues with structural
    // equality:
    //
    //   1. False positive on Shift+Enter — markdownToDoc("foo\n") splits
    //      into two paragraphs, but a single paragraph holding a HardBreak
    //      serialises to the same wire `"foo\n"`. Structural `Node.eq`
    //      returned false on every HardBreak insert, triggering a
    //      setContent that reset the selection (cursor jumped to end).
    //   2. Unnecessary parse work — the structural check required hydrating
    //      `value` into a doc before comparing, paying the parse + sanitise
    //      cost on every self-echo render. Identity skips that work
    //      entirely.
    //
    // See `docs/plans/260511_shift_enter_cursor_jump_fix.md` for the full
    // analysis. NBSP-corruption defence (the C1 sanitiser in `markdownToDoc`)
    // still runs on the rehydrate path below — only the matched-emit fast
    // path bypasses it, which is safe because the editor produced that
    // markdown via its own already-sanitised wire format.
    useEffect(() => {
      if (!editor) return;
      // Fast-path: editor hasn't mutated since the last emit, and the parent
      // passed the same value back. No hydration, no setContent, no caret
      // reset.
      if (
        value === lastEmittedValueRef.current &&
        editor.state.doc === lastEmittedDocRef.current
      ) {
        return;
      }
      const hydratedDocJson = markdownToDoc(value, { resolveOperatorMention });
      editor.commands.setContent(hydratedDocJson, { emitUpdate: false });
      // Track the doc we just synced into the editor. The next render with
      // an unchanged `value` will short-circuit cleanly above.
      //
      // For `lastEmittedValueRef`, store the canonical sanitised wire form
      // (what `docToMarkdown` would emit from the freshly-hydrated doc), NOT
      // the raw `value` input. If a caller passed a raw NBSP-bearing string,
      // sanitising-on-hydrate produced a clean doc; tracking the raw input
      // here would leave a hidden split-brain between editor and ref that
      // the next emit could resurface (see Stage 3 of
      // `docs-private/investigations/260505_composer_nbsp_recurrence.md`).
      lastEmittedValueRef.current = docToMarkdown(hydratedDocJson);
      lastEmittedDocRef.current = editor.state.doc;
    }, [editor, resolveOperatorMention, value]);

    useEffect(() => {
      if (!editor) return;
      editor.setEditable(!disabled);
    }, [editor, disabled]);

    /**
     * Stage 4 of `docs/plans/260501_composer_tiptap_atmention_bugfix.md` —
     * IME-guard compositionend bridge. Production reads
     * `editor.view.composing` (a getter on view.input) for IME state in the
     * parent-layer mention-context scheduler. When composition ends WITHOUT
     * a subsequent `onUpdate` (the compose-and-pause sequence: user types
     * `@`, composes a single CJK character, commits, and pauses), the
     * parent's deferred debounce never flushes because no transaction
     * fires. This listener forces the flush so the picker opens shortly
     * after composition completes.
     *
     * The ref pattern (`onCompositionEndRef.current`) keeps the effect's
     * registration stable across parent re-renders that swap the callback
     * identity. Cleanup detaches on editor change / unmount.
     */
    useEffect(() => {
      if (!editor) return undefined;
      const handleCompositionEnd = () => {
        onCompositionEndRef.current?.();
      };
      const dom = editor.view.dom;
      dom.addEventListener('compositionend', handleCompositionEnd);
      return () => {
        dom.removeEventListener('compositionend', handleCompositionEnd);
      };
    }, [editor]);

    useEffect(() => {
      if (!editor || !commandInputRef) return undefined;
      const textareaLike = {
        focus: () => editor.commands.focus(),
        blur: () => editor.view.dom.blur(),
        setSelectionRange: (start: number, end?: number) => {
          const from = markdownIndexToPmPos(editor.getJSON(), start);
          const to = markdownIndexToPmPos(editor.getJSON(), end ?? start);
          editor.commands.focus();
          editor.commands.setTextSelection({ from, to });
        },
        get value() {
          // Stage 1.5: Layer A cached on selection-only transactions; the
          // textarea-shim's value getter is read on every keystroke + IME
          // event by legacy consumers, so cache hits here matter.
          return getLayerASnapshot(editor).markdown;
        },
        get selectionStart() {
          // Stage 1.5: Layer B computed per-call against Layer A's cached
          // docJson; correct on selection-only transactions where doc
          // identity is stable but `selection.from` changes.
          return getCaretMarkdownIndex(editor);
        },
        get selectionEnd() {
          // Layer B variant for selection.to — computed per-call against
          // Layer A's cached docJson (same rationale as `selectionStart`).
          return pmPosToMarkdownIndex(getLayerASnapshot(editor).docJson, editor.state.selection.to);
        },
        get scrollHeight() {
          return editor.view.dom.scrollHeight;
        },
        get clientHeight() {
          return editor.view.dom.clientHeight;
        },
        style: editor.view.dom.style,
      } as unknown as HTMLTextAreaElement;
      (commandInputRef as { current: HTMLTextAreaElement | null }).current = textareaLike;
      return () => {
        (commandInputRef as { current: HTMLTextAreaElement | null }).current = null;
      };
    }, [commandInputRef, editor]);

    useImperativeHandle(
      ref,
      (): TipTapPromptEditorHandle => ({
        focus() {
          editor?.commands.focus();
        },
        setSelectionToMarkdownIndex(markdownIndex) {
          if (!editor) return;
          // Walk the doc to translate markdown index → PM position. Inverse of pmPosToMarkdownIndex.
          // Stage 1 implementation is linear-scan; good enough for typical prompt sizes.
          const docSize = editor.state.doc.content.size;
          const target = Math.max(0, Math.min(markdownIndex, docSize));
          editor.commands.focus();
          editor.commands.setTextSelection(target);
        },
        getMarkdown() {
          return editor ? getCurrentPromptMarkdown(editor) : '';
        },
        setMarkdown(markdown) {
          if (!editor) return;
          const doc = markdownToDoc(markdown);
          editor.commands.setContent(doc, { emitUpdate: true });
        },
        insertMentionAtMarkdownRange(range, attrs) {
          if (!editor) return;
          // Stage 4 — H12 kind-aware trailing-space contract. Delegates to
          // the exported pure function so tests can drive the same logic
          // on a raw `Editor`. See `insertMentionAtMarkdownRangeOnEditor`.
          insertMentionAtMarkdownRangeOnEditor(editor, range, attrs);
        },
        getEditor() {
          return editor ?? null;
        },
      }),
      [editor],
    );

    const handleReactPasteCapture = useCallback((event: ReactClipboardEvent<HTMLDivElement>) => {
      if (!onPasteCaptureRef.current) return;
      const consumed = onPasteCaptureRef.current(event.nativeEvent);
      if (consumed) {
        event.preventDefault();
        event.stopPropagation();
      }
    }, []);

    return (
      <EditorContent
        editor={editor}
        className={cn(styles.editorRoot, className)}
        style={style}
        data-testid={testId ? `${testId}-root` : undefined}
        onPasteCapture={handleReactPasteCapture}
      />
    );
  },
);
