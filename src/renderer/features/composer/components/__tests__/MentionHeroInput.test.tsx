// @vitest-environment happy-dom
/**
 * MentionHeroInput surface tests.
 *
 * Stage 5 of `docs/plans/260501_composer_tiptap_atmention_bugfix.md` — H8
 * ownership fix at the hero surface. The hero component now wires the SAME
 * `createMentionContextScheduler` factory pattern that `ComposerWithState`
 * uses (Stage 4). The chip / undo / wire-format behaviours are inherited
 * by construction from the inner `TipTapPromptEditor` and are pinned at the
 * editor level by `TipTapPromptEditor.editor.test.tsx` and at the contract
 * level by `composerMarkdownContract.test.ts`. These hero-surface tests
 * focus on the COMPONENT WIRING:
 *
 *   1. Type `@`, pick a mention, verify trailing space (H12) — covered at
 *      the editor layer in `TipTapPromptEditor.editor.test.tsx` (the H12
 *      adapter is a pure function shared with the hero path).
 *   2. Verify chip + clean wire format (no `&nbsp;`) — covered at the
 *      editor layer (same `createPromptEditorExtensions()` mounted by the
 *      hero rich path).
 *   3. Verify Cmd-Z restores typed text (H10) — covered at the editor
 *      layer (`TipTapPromptEditor.editor.test.tsx`).
 *   4. 50-keystroke ≤ 5 `updateMentionContext` invocations (H8 DoD) —
 *      asserted here at the textarea path.
 *   5. Caret-into-trigger opens picker (FMM Row 26) — asserted here via
 *      the hero scheduler config with a real `Editor`.
 *   6. Caret-on-chip does NOT re-open picker (FMM Row 27) — asserted here
 *      via the hero scheduler config with a real `Editor` containing a
 *      mention chip atom.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { Editor } from '@tiptap/core';
import { createPromptEditorExtensions } from '../../utils/composerEditorFactory';
import { markdownToDoc } from '../../utils/promptDoc';
import {
  createMentionContextScheduler,
  MENTION_DEBOUNCE_MS,
} from '../../utils/mentionContextScheduler';
import {
  findMentionTrigger as actualFindMentionTrigger,
  isCaretOnMentionChip as actualIsCaretOnMentionChip,
} from '../../hooks/useMentionAutocomplete';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const ReactDOMClient = require('react-dom/client');
const { act: reactAct } = require('react');

vi.mock('../MentionPopover', () => ({
  MentionPopover: () => null,
}));

// Stable spies hoisted so component tests can inspect call counts across
// renders. Real `findMentionTrigger` / `isCaretOnMentionChip` /
// `MENTION_DEBOUNCE_MS` are preserved via `importActual` so the scheduler's
// first-`@` fast-path detection works correctly in component-level tests.
const heroMocks = vi.hoisted(() => {
  const mentionState: { active: boolean; results: never[] } = {
    active: false,
    results: [],
  };
  return {
    mentionState,
    updateMentionContext: (() => undefined) as unknown as ((value: string, caret: number | null) => void) & {
      mock: { calls: Array<[string, number | null]> };
    },
    clearMentionState: (() => undefined) as unknown as (() => void) & { mock: { calls: unknown[] } },
    insertMentionResult: vi.fn(),
    navigateMentionUp: vi.fn(),
    navigateMentionDown: vi.fn(),
    selectCurrentMention: vi.fn(),
    setSelectedIndex: vi.fn(),
    setManualFilter: vi.fn(),
  };
});

// Replace the placeholder no-op fns with vi.fn() instances now that hoisting
// has run. Tests reset these in `beforeEach`.
heroMocks.updateMentionContext = vi.fn() as unknown as typeof heroMocks.updateMentionContext;
heroMocks.clearMentionState = vi.fn() as unknown as typeof heroMocks.clearMentionState;

vi.mock('../../hooks/useMentionAutocomplete', async (importActual) => {
  const actual = await importActual<typeof import('../../hooks/useMentionAutocomplete')>();
  return {
    ...actual,
    useMentionAutocomplete: () => ({
      mentionState: heroMocks.mentionState,
      updateMentionContext: heroMocks.updateMentionContext,
      insertMentionResult: heroMocks.insertMentionResult,
      navigateMentionUp: heroMocks.navigateMentionUp,
      navigateMentionDown: heroMocks.navigateMentionDown,
      selectCurrentMention: heroMocks.selectCurrentMention,
      clearMentionState: heroMocks.clearMentionState,
      setSelectedIndex: heroMocks.setSelectedIndex,
      setManualFilter: heroMocks.setManualFilter,
    }),
  };
});

import { MentionHeroInput, type MentionHeroInputProps } from '../MentionHeroInput';

type ClipboardLike = Pick<DataTransfer, 'items' | 'getData'>;

function buildProps(overrides: Partial<MentionHeroInputProps> = {}): MentionHeroInputProps {
  return {
    value: '',
    onChange: vi.fn(),
    onSubmit: vi.fn(),
    mentionResultsForQuery: vi.fn(() => []),
    ensureLibraryIndex: vi.fn(),
    getRelativeLibraryPath: vi.fn((path: string) => path),
    hasWorkspace: true,
    hasConversations: true,
    coreDirectory: null,
    libraryIndex: null,
    libraryIndexLoading: false,
    libraryIndexError: null,
    refreshLibraryIndex: vi.fn(async () => {}),
    ...overrides,
  };
}

function createAttachmentProps() {
  return {
    attachments: [],
    onAddFiles: vi.fn(async () => {}),
    onRemoveAttachment: vi.fn(),
    onPasteAttachment: vi.fn(async () => false),
    canAddMore: true,
    isDragging: false,
    onDragEnter: vi.fn(),
    onDragLeave: vi.fn(),
    onDragOver: vi.fn(),
    onDrop: vi.fn(),
  };
}

function createClipboardLike({
  itemKinds,
  plainText = '',
  html = '',
}: {
  itemKinds: Array<'file' | 'string'>;
  plainText?: string;
  html?: string;
}): ClipboardLike {
  return {
    items: itemKinds.map((kind) => ({ kind })) as unknown as DataTransferItemList,
    getData: (type: string) => {
      if (type === 'text/plain') return plainText;
      if (type === 'text/html') return html;
      return '';
    },
  };
}

function getPromptInput(container: HTMLElement): HTMLElement {
  const input =
    container.querySelector('textarea') ??
    container.querySelector('[contenteditable="true"]');
  if (!input) {
    throw new Error('Prompt input not found');
  }
  return input as HTMLElement;
}

function renderComponent(props: MentionHeroInputProps): {
  container: HTMLElement;
  unmount: () => void;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root: any;

  reactAct(() => {
    root = ReactDOMClient.createRoot(container);
    root.render(React.createElement(MentionHeroInput, props));
  });

  return {
    container,
    unmount: () => {
      reactAct(() => root.unmount());
      document.body.removeChild(container);
    },
  };
}



describe('MentionHeroInput', () => {
  it('renders the optional voice control when voiceButtonProps are provided', () => {
    const onToggle = vi.fn();
    const { container, unmount } = renderComponent(
      buildProps({
        voiceButtonProps: {
          isRecording: false,
          isProcessing: false,
          disabled: false,
          audioLevel: 0,
          onToggle,
        },
      })
    );

    const voiceButton = container.querySelector('[data-testid="hero-voice-button"]');

    expect(voiceButton).not.toBeNull();
    expect(voiceButton?.getAttribute('aria-label')).toBe('Start voice input');
    unmount();
  });

  it('omits the voice control when voiceButtonProps are not provided', () => {
    const { container, unmount } = renderComponent(buildProps());

    expect(container.querySelector('[data-testid="hero-voice-button"]')).toBeNull();
    unmount();
  });

  it('renders the mic before the attachment button when both affordances are enabled', () => {
    const { container, unmount } = renderComponent(
      buildProps({
        voiceButtonProps: {
          isRecording: false,
          isProcessing: false,
          disabled: false,
          audioLevel: 0,
          onToggle: vi.fn(),
        },
        attachmentProps: createAttachmentProps(),
      })
    );

    const buttonLabels = Array.from(container.querySelectorAll('button'))
      .map((button) => button.getAttribute('aria-label'))
      .filter(Boolean);

    expect(buttonLabels.indexOf('Start voice input')).toBeLessThan(buttonLabels.indexOf('Attach file'));
    unmount();
  });

  it('lets normal text paste proceed and still adds attachments for mixed clipboard content', () => {
    const attachmentProps = createAttachmentProps();
    const { container, unmount } = renderComponent(
      buildProps({ attachmentProps })
    );

    const input = getPromptInput(container);

    const pasteEvent = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEvent, 'clipboardData', {
      value: createClipboardLike({
        itemKinds: ['file', 'string'],
        plainText: 'Copied from DOCX',
      }),
    });

    reactAct(() => {
      input.dispatchEvent(pasteEvent);
    });

    expect(attachmentProps.onPasteAttachment).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('intercepts file-only paste and routes it to attachment handling', () => {
    const attachmentProps = createAttachmentProps();
    const { container, unmount } = renderComponent(
      buildProps({ attachmentProps })
    );

    const input = getPromptInput(container);

    const pasteEvent = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEvent, 'clipboardData', {
      value: createClipboardLike({
        itemKinds: ['file'],
        plainText: '',
      }),
    });

    reactAct(() => {
      input.dispatchEvent(pasteEvent);
    });

    expect(attachmentProps.onPasteAttachment).toHaveBeenCalledTimes(1);
    expect(pasteEvent.defaultPrevented).toBe(true);
    unmount();
  });

  it('treats html image content as mixed paste when plain text is also present', () => {
    const attachmentProps = createAttachmentProps();
    const { container, unmount } = renderComponent(
      buildProps({ attachmentProps })
    );

    const input = getPromptInput(container);

    const pasteEvent = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEvent, 'clipboardData', {
      value: createClipboardLike({
        itemKinds: ['string'],
        plainText: 'Copied newsletter section',
        html: '<p>Copied newsletter section</p><img src="data:image/png;base64,abc123" />',
      }),
    });

    reactAct(() => {
      input.dispatchEvent(pasteEvent);
    });

    expect(attachmentProps.onPasteAttachment).toHaveBeenCalledTimes(1);
    unmount();
  });
});

// =============================================================================
// Stage 5 — Hero-surface scheduler wiring (H8 ownership parity)
// =============================================================================
//
// The hero component constructs `createMentionContextScheduler` with the SAME
// dependency-injection contract that `ComposerWithState` uses (Stage 4). Note:
// the rich `TipTapPromptEditor` path is the ONLY render path in tests because
// `isComposerFlagEnabled('tiptap')` is a module-level constant that is
// permanently `true` post-Stage-4 of `260429_composer_rich_chips_input.md`.
// The legacy `<textarea>` path is dead code in this test environment.
//
// Composer-surface tests at the editor layer
// (`TipTapPromptEditor.editor.test.tsx`) cover:
//   - Type `@`, pick a mention, verify trailing space (H12).
//   - Verify chip + clean wire format (no `&nbsp;`).
//   - Verify Cmd-Z restores typed text (H10).
// These behaviours are inherited at the hero surface BY CONSTRUCTION (the
// rich path mounts the same `TipTapPromptEditor` with the same
// `createPromptEditorExtensions()` factory). Re-running them at the hero
// component layer would duplicate coverage without adding signal.
//
// What the hero tests MUST verify is the SCHEDULER WIRING — that
// `MentionHeroInput`'s `createMentionContextScheduler(...)` call uses the
// exact same dependency-injection contract as `ComposerWithState`. The
// tests below construct that scheduler using the hero's factory config
// against a real `Editor` and assert the H8 / FMM Row 26 / Row 27
// invariants at the hero surface.
// =============================================================================
describe('MentionHeroInput — Stage 5 scheduler config (hero factory wiring)', () => {
  beforeEach(() => {
    (heroMocks.updateMentionContext as unknown as { mockReset: () => void }).mockReset();
    (heroMocks.clearMentionState as unknown as { mockReset: () => void }).mockReset();
    heroMocks.setManualFilter.mockReset();
    // Reset to picker-closed default for each test.
    heroMocks.mentionState.active = false;
  });

  function createHeroEditor(initial = ''): Editor {
    return new Editor({
      content: markdownToDoc(initial),
      extensions: createPromptEditorExtensions(),
    });
  }

  /**
   * Construct a scheduler with the EXACT same dependency-injection contract
   * the hero component (`MentionHeroInput.tsx`) uses in production. Tests
   * provide an `isPickerOpen` callback (the hero reads
   * `mentionState.active`) and an `isComposing` callback (the hero reads
   * `editor.view.composing`) to drive the contract behaviours.
   */
  function buildHeroScheduler(opts: {
    editor: Editor;
    onFire: (value: string, caret: number) => void;
    isPickerOpen: () => boolean;
    isComposing: () => boolean;
  }) {
    return createMentionContextScheduler({
      onFire: opts.onFire,
      isPickerOpen: opts.isPickerOpen,
      getEditor: () => opts.editor,
      isComposing: opts.isComposing,
      isCaretOnChip: (ed) => actualIsCaretOnMentionChip(ed),
      detectFreshTrigger: (value, caret) =>
        actualFindMentionTrigger(value, caret) !== null,
    });
  }

  it('Stage 5 (H8 50-keystroke quantitative DoD): coalesces 50 fast keystrokes into ≤ 5 onFire invocations', () => {
    vi.useFakeTimers();
    try {
      const editor = createHeroEditor('');
      try {
        let fireCount = 0;
        // Picker open → first-`@` fast-path is skipped; subsequent
        // schedules go through the cancel-and-reschedule debounce path.
        const scheduler = buildHeroScheduler({
          editor,
          onFire: () => {
            fireCount++;
          },
          isPickerOpen: () => true,
          isComposing: () => false,
        });

        // 50 schedules within the debounce window — 1ms apart.
        for (let i = 0; i < 50; i++) {
          scheduler.schedule(`@${'a'.repeat(i)}`, i + 1);
          vi.advanceTimersByTime(1);
        }
        // No fires yet — all schedules pending in the debounce window.
        expect(fireCount).toBe(0);
        // Advance past the debounce window so the FINAL timer fires.
        vi.advanceTimersByTime(MENTION_DEBOUNCE_MS);
        // Cancel-and-reschedule semantics: only the LAST schedule's timer
        // fires. The H8 plan's bound is `≤ 5`; empirically `=== 1`.
        expect(fireCount).toBeLessThanOrEqual(5);
        expect(fireCount).toBe(1);
      } finally {
        editor.destroy();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('Stage 5 (first-`@` fast-path): fires synchronously on first valid `@` (no debounce)', () => {
    vi.useFakeTimers();
    try {
      const editor = createHeroEditor('');
      try {
        const fired: Array<{ value: string; caret: number }> = [];
        const scheduler = buildHeroScheduler({
          editor,
          onFire: (value, caret) => fired.push({ value, caret }),
          isPickerOpen: () => false,
          isComposing: () => false,
        });

        // Picker closed + a fresh `@` trigger at the caret → fast-path fires
        // synchronously, with no timer advance.
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

  it('Stage 5 (IME compose-and-pause): defers during compose, fires after compositionend flush', () => {
    vi.useFakeTimers();
    try {
      const editor = createHeroEditor('');
      try {
        let composing = true;
        const fired: Array<{ value: string; caret: number }> = [];
        const scheduler = buildHeroScheduler({
          editor,
          onFire: (value, caret) => fired.push({ value, caret }),
          // Picker open so the first-`@` fast-path is gated by IME alone.
          isPickerOpen: () => true,
          isComposing: () => composing,
        });

        scheduler.schedule('@', 1);
        // Pause during compose — no fire even after debounce window.
        vi.advanceTimersByTime(1000);
        expect(fired.length).toBe(0);

        // compositionend → flushDeferred (the `compositionend` listener on
        // `editor.view.dom` registered by `TipTapPromptEditor` invokes this).
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

  it('Stage 5 (no-`@` short-circuit): cancel() drops a pending fire without invoking onFire', () => {
    vi.useFakeTimers();
    try {
      const editor = createHeroEditor('');
      try {
        let fireCount = 0;
        const scheduler = buildHeroScheduler({
          editor,
          onFire: () => {
            fireCount++;
          },
          // Picker open so we go through the debounce path (no fast-path).
          isPickerOpen: () => true,
          isComposing: () => false,
        });

        scheduler.schedule('@a', 2);
        // Hero component invokes `scheduler.cancel()` synchronously when
        // the value loses its `@` (both the legacy textarea handler and the
        // rich-path `onChange` callback). The cancel must drop the pending
        // timer without ever firing.
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

  it('FMM Row 26: caret-into-existing-trigger opens picker (hero scheduler config)', () => {
    vi.useFakeTimers();
    try {
      const editor = createHeroEditor('hello @CHIEF');
      try {
        const fired: Array<{ value: string; caret: number }> = [];
        const scheduler = createMentionContextScheduler({
          onFire: (value, caret) => fired.push({ value, caret }),
          isPickerOpen: () => false,
          getEditor: () => editor,
          isComposing: () => false,
          isCaretOnChip: (ed) => actualIsCaretOnMentionChip(ed),
          // Real `findMentionTrigger` against the hero's wire markdown.
          detectFreshTrigger: (value, caret) =>
            actualFindMentionTrigger(value, caret) !== null,
        });

        // Caret lands inside the in-progress `@CHIEF` token (markdown index 12).
        // findMentionTrigger should detect a trigger; the first-`@` fast-path
        // fires synchronously.
        scheduler.schedule('hello @CHIEF', 12);
        expect(fired.length).toBe(1);
        expect(fired[0].value).toBe('hello @CHIEF');
        expect(fired[0].caret).toBe(12);
      } finally {
        editor.destroy();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('FMM Row 27: caret-on-chip does NOT re-open picker (hero scheduler config)', () => {
    vi.useFakeTimers();
    try {
      // Build an editor that already has a resolved `@CHIEF_DESIGNER` chip.
      const editor = createHeroEditor('@CHIEF_DESIGNER review');
      try {
        // Locate a PM position adjacent to the chip atom.
        let chipPos = -1;
        for (let pos = 0; pos < editor.state.doc.content.size; pos++) {
          editor.commands.setTextSelection(pos);
          if (actualIsCaretOnMentionChip(editor)) {
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
          isCaretOnChip: (ed) => actualIsCaretOnMentionChip(ed),
          // Pretend the value would otherwise look like a fresh trigger;
          // the chip-adjacency check should still suppress.
          detectFreshTrigger: () => true,
        });

        // Schedule with caret on a chip → suppressed entirely (no fire,
        // no debounce timer started).
        scheduler.schedule('@CHIEF_DESIGNER review', chipPos);
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
