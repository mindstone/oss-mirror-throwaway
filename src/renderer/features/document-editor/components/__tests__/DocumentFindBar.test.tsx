// @vitest-environment happy-dom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the match finder so the test doesn't need a real ProseMirror document:
// the bug under test (REBEL-5WF) is about whether the component scrolls to a
// match, not about how matches are located.
const mockMatches: { from: number; to: number }[] = [];
vi.mock('@renderer/features/library/extensions/tiptapAnnotationExtension', () => ({
  findAllTextMatchesInDoc: () => mockMatches.slice(),
}));

import { DocumentFindBar } from '../DocumentFindBar';
import type { TipTapMarkdownEditorRef } from '@renderer/features/library/components/TipTapMarkdownEditor';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Mounted = {
  container: HTMLDivElement;
  root: Root;
  unmount: () => void;
};

function mount(ui: React.ReactElement): Mounted {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(ui);
  });
  return {
    container,
    root,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

/** Build a minimal editor ref whose imperative methods we can spy on. */
function makeEditorRef() {
  const scrollToAnnotation = vi.fn();
  const setFindHighlights = vi.fn();
  const clearFindHighlights = vi.fn();
  const editorInstance = { isDestroyed: false, state: { doc: {} } };
  const value: Partial<TipTapMarkdownEditorRef> = {
    scrollToAnnotation,
    setFindHighlights,
    clearFindHighlights,
    getEditor: () => editorInstance as never,
    focus: vi.fn(),
  };
  const ref: React.RefObject<TipTapMarkdownEditorRef | null> = {
    current: value as TipTapMarkdownEditorRef,
  };
  return { ref, scrollToAnnotation, setFindHighlights };
}

function typeQuery(container: HTMLDivElement, query: string) {
  const input = container.querySelector('input') as HTMLInputElement;
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )!.set!;
    setter.call(input, query);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  return input;
}

describe('DocumentFindBar — scroll-to-match (REBEL-5WF)', () => {
  let mounted: Mounted | null = null;

  beforeEach(() => {
    mockMatches.length = 0;
  });

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    vi.clearAllMocks();
  });

  it('scrolls to the FIRST match as soon as a markdown query returns matches', () => {
    mockMatches.push({ from: 10, to: 15 }, { from: 40, to: 45 }, { from: 90, to: 95 });
    const { ref, scrollToAnnotation, setFindHighlights } = makeEditorRef();
    const textareaRef: React.RefObject<HTMLTextAreaElement | null> = { current: null };

    mounted = mount(
      <DocumentFindBar
        content={'some long markdown content'}
        isMarkdownFile
        editorRef={ref}
        textareaRef={textareaRef}
        onClose={() => {}}
      />,
    );

    typeQuery(mounted.container, 'foo');

    // Visual highlight is applied to match 0 ...
    expect(setFindHighlights).toHaveBeenCalledWith(mockMatches, 0);
    // ... AND (the fix) the viewport is scrolled to the first match's range,
    // so the user sees "1 of N" land on screen rather than the first DOWN
    // click appearing to skip to match 2.
    expect(scrollToAnnotation).toHaveBeenCalledWith(10, 15);
  });

  it('does not scroll when a markdown query returns no matches', () => {
    // mockMatches stays empty
    const { ref, scrollToAnnotation } = makeEditorRef();
    const textareaRef: React.RefObject<HTMLTextAreaElement | null> = { current: null };

    mounted = mount(
      <DocumentFindBar
        content={'content'}
        isMarkdownFile
        editorRef={ref}
        textareaRef={textareaRef}
        onClose={() => {}}
      />,
    );

    typeQuery(mounted.container, 'nope');

    expect(scrollToAnnotation).not.toHaveBeenCalled();
  });

  it('scrolls the active match into view when navigating with the DOWN button', () => {
    mockMatches.push({ from: 10, to: 15 }, { from: 40, to: 45 }, { from: 90, to: 95 });
    const { ref, scrollToAnnotation } = makeEditorRef();
    const textareaRef: React.RefObject<HTMLTextAreaElement | null> = { current: null };

    mounted = mount(
      <DocumentFindBar
        content={'content'}
        isMarkdownFile
        editorRef={ref}
        textareaRef={textareaRef}
        onClose={() => {}}
      />,
    );

    typeQuery(mounted.container, 'foo');
    scrollToAnnotation.mockClear();

    // The DOWN (next) button is the second nav button.
    const buttons = mounted.container.querySelectorAll('button');
    const downButton = buttons[1] as HTMLButtonElement;
    act(() => {
      downButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // DOWN from index 0 → index 1 → match at {40,45}.
    expect(scrollToAnnotation).toHaveBeenCalledWith(40, 45);
  });
});

describe('DocumentFindBar — non-navigable surface (REBEL-5WF F2)', () => {
  let mounted: Mounted | null = null;

  beforeEach(() => {
    mockMatches.length = 0;
  });

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    vi.clearAllMocks();
  });

  /**
   * Non-markdown file in read-only preview mode: `isMarkdownFile` is false and
   * `textareaRef.current` is null (no textarea rendered). The find bar should
   * show a match count (so the user knows hits exist) but the up/down nav
   * arrows must be visibly disabled — not silently no-op — so the user isn't
   * misled into thinking navigation is working.
   */
  it('disables nav arrows for non-markdown preview mode (no textarea)', () => {
    const editorRef: React.RefObject<null> = { current: null };
    const textareaRef: React.RefObject<HTMLTextAreaElement | null> = { current: null };

    mounted = mount(
      <DocumentFindBar
        content={'hello world hello'}
        isMarkdownFile={false}
        editorRef={editorRef as React.RefObject<import('@renderer/features/library/components/TipTapMarkdownEditor').TipTapMarkdownEditorRef | null>}
        textareaRef={textareaRef}
        onClose={() => {}}
      />,
    );

    typeQuery(mounted.container, 'hello');

    // The component should have found matches via the plain-text search path
    // (count shows something > 0) even though navigation can't work.
    const countEl = mounted.container.querySelector('span');
    // Count should read "1 of 2" — not "No matches".
    expect(countEl?.textContent).toMatch(/\d+ of \d+/);

    // Both nav buttons must be disabled — not just inactive.
    const buttons = mounted.container.querySelectorAll('button');
    const upButton = buttons[0] as HTMLButtonElement;
    const downButton = buttons[1] as HTMLButtonElement;
    expect(upButton.disabled).toBe(true);
    expect(downButton.disabled).toBe(true);
  });

  it('keeps nav arrows enabled for non-markdown textarea editing mode', () => {
    const editorRef: React.RefObject<null> = { current: null };
    const textarea = document.createElement('textarea');
    const textareaRef: React.RefObject<HTMLTextAreaElement | null> = { current: textarea };

    mounted = mount(
      <DocumentFindBar
        content={'hello world hello'}
        isMarkdownFile={false}
        editorRef={editorRef as React.RefObject<import('@renderer/features/library/components/TipTapMarkdownEditor').TipTapMarkdownEditorRef | null>}
        textareaRef={textareaRef}
        onClose={() => {}}
      />,
    );

    typeQuery(mounted.container, 'hello');

    const buttons = mounted.container.querySelectorAll('button');
    const upButton = buttons[0] as HTMLButtonElement;
    const downButton = buttons[1] as HTMLButtonElement;
    // A mounted textarea means navigation CAN work — arrows must stay enabled.
    expect(upButton.disabled).toBe(false);
    expect(downButton.disabled).toBe(false);
  });
});
