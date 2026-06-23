// @vitest-environment happy-dom
/**
 * Integration tests for document-annotation Send-to-Rebel routing (Stage 5).
 *
 * Covers matrix rows 1-9, 11, and 13 from the "Failure-mode matrix" in the
 * planning doc. Rows 10 (editor-unmount), 12 (processMessage rejection), and
 * 14 (fence-collision exhaustion) live in sibling test files — see
 * `documentAnnotationClearCallback.test.ts`, `useMessageQueue.test.ts`, and
 * `annotationUtils.test.ts` respectively.
 *
 * Strategy: render `DocumentFooter` with minimal fakes for its external
 * collaborators (editor ref, onClearAnnotations, onSendAnnotations, etc.)
 * and drive it end-to-end. `SendToRebelDialog` is swapped for a tiny stub
 * so dialog-routed paths can choose a target without async IPC plumbing.
 * `Tooltip` is replaced with a pass-through to avoid `@floating-ui/react`
 * quirks in happy-dom. Every test is hermetic — no cross-test state.
 *
 * The tests deliberately DO NOT exercise App.tsx's draft/onCommit stashing
 * (that's one layer up). They assert DocumentFooter's boundary contract:
 *   - The right outgoing payload shape (message, target, onCommit) on Send.
 *   - The onCommit closure captures a SNAPSHOT of staged ids at Send time.
 *   - Firing the onCommit clears exactly the staged ids and flushes the
 *     debounced writer immediately.
 *   - NOT firing the onCommit leaves annotations intact (matrix rows 5, 6,
 *     7, 11 — different upstream scenarios, same footer-level invariant).
 */

import React from 'react';
import * as ReactDOMClient from 'react-dom/client';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { SendTarget } from '@renderer/features/library/components/SendToRebelDialog';
import { AnnotationFormatExhaustionError } from '@rebel/shared';

// Enable React's act() environment so we don't get "not configured to
// support act(...)" warnings from react-dom. Must be set BEFORE any React
// rendering happens (module-eval time is fine — Vitest evaluates top-level
// imports before `beforeEach`).
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ---------------------------------------------------------------------------
// Module mocks — these must be declared BEFORE importing DocumentFooter so
// the mocks are in place when the component module is first evaluated.
// ---------------------------------------------------------------------------

// Stub `SendToRebelDialog` with a minimal stand-in. The real dialog fetches
// file-conversation history via IPC and has its own radio-group selection
// state; for the Stage 5 wiring tests we only need a way to call the `onSend`
// prop with a chosen target. Each button corresponds to one dialog branch.
 
vi.mock('@renderer/features/library/components/SendToRebelDialog', () => ({
  SendToRebelDialog: (props: {
    open: boolean;
    onSend: (target: SendTarget, sessionId?: string) => void;
    onOpenChange: (open: boolean) => void;
  }) => {
    if (!props.open) return null;
    return React.createElement(
      'div',
      { 'data-testid': 'send-dialog' },
      React.createElement(
        'button',
        {
          'data-testid': 'dialog-send-new',
          onClick: () => {
            props.onSend('new');
            props.onOpenChange(false);
          },
        },
        'Send to new',
      ),
      React.createElement(
        'button',
        {
          'data-testid': 'dialog-send-file-conversation',
          onClick: () => {
            props.onSend('file-conversation', 'sess-abc');
            props.onOpenChange(false);
          },
        },
        "Send to file's conversation",
      ),
      React.createElement(
        'button',
        {
          'data-testid': 'dialog-send-last-active',
          onClick: () => {
            props.onSend('last-active', 'sess-last');
            props.onOpenChange(false);
          },
        },
        'Send to last-active',
      ),
      React.createElement(
        'button',
        {
          'data-testid': 'dialog-cancel',
          onClick: () => {
            props.onOpenChange(false);
          },
        },
        'Cancel',
      ),
    );
  },
}));

// Pass-through `Tooltip`, plain `<button>` shim for `Button`. The real
// components rely on `@floating-ui/react` which tends to misbehave in
// happy-dom; nothing in these tests depends on their positioning.
 
vi.mock('@renderer/components/ui', () => ({
  Button: React.forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement>>(
    function MockButton({ children, ...rest }, ref) {
      return React.createElement('button', { ...rest, ref }, children);
    },
  ),
  Tooltip: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
}));

// ---------------------------------------------------------------------------
// Re-import AFTER mocks are set up
// ---------------------------------------------------------------------------

// Using dynamic require() to ensure mocks above apply during evaluation.
// Matches the pattern in `src/renderer/test-utils/hookTestHarness.ts`.
const { act: reactAct } = require('react') as typeof import('react');

import { DocumentFooter } from '../components/DocumentFooter';

// ---------------------------------------------------------------------------
// Harness helpers
// ---------------------------------------------------------------------------

interface AnnotationItem {
  id: string;
  from: number;
  to: number;
  text: string;
  comment: string;
}

type FooterProps = React.ComponentProps<typeof DocumentFooter>;

interface FooterMocks {
  onClearAnnotations: ReturnType<typeof vi.fn>;
  flushAnnotationWriteNow: ReturnType<typeof vi.fn>;
  onSendAnnotations?: ReturnType<typeof vi.fn>;
  formatAnnotationMessage: ReturnType<typeof vi.fn>;
  onRemoveAnnotation: ReturnType<typeof vi.fn>;
  showToast: ReturnType<typeof vi.fn>;
  emitLog: ReturnType<typeof vi.fn>;
}

interface RenderResult {
  container: HTMLElement;
  root: ReactDOMClient.Root;
  mocks: FooterMocks;
  props: FooterProps;
  unmount: () => void;
  rerender: (nextProps: Partial<FooterProps>) => void;
}

function makeAnnotations(ids: string[]): AnnotationItem[] {
  return ids.map((id, index) => ({
    id,
    from: index * 10,
    to: index * 10 + 5,
    text: `text-${id}`,
    comment: `comment-${id}`,
  }));
}

function buildDefaultProps(options: {
  annotationList: AnnotationItem[];
  withDialog: boolean;
  documentPath?: string;
  flushAnnotationWriteNowImpl?: () => Promise<void>;
  onClearAnnotationsImpl?: (ids?: string[]) => void;
}): { props: FooterProps; mocks: FooterMocks } {
  const mocks: FooterMocks = {
    onClearAnnotations: vi.fn(options.onClearAnnotationsImpl ?? (() => undefined)),
    flushAnnotationWriteNow: vi.fn(
      options.flushAnnotationWriteNowImpl ?? (async () => undefined),
    ),
    onSendAnnotations: options.withDialog ? vi.fn() : undefined,
    formatAnnotationMessage: vi.fn(
      (filePath: string) => `[annotations for ${filePath}]`,
    ),
    onRemoveAnnotation: vi.fn(),
    showToast: vi.fn(),
    emitLog: vi.fn(),
  };

  const editorRef: React.RefObject<{
    focus: () => void;
    scrollToAnnotation: (from: number, to: number) => void;
  } | null> = {
    current: {
      focus: vi.fn(),
      scrollToAnnotation: vi.fn(),
    },
  };

  // Widen the mock types where DocumentFooter's props declare concrete
  // function shapes — `vi.fn()` yields a `Mock<...>` which TS can't narrow
  // back to the exact signature without a cast. Runtime behaviour matches.
  const props: FooterProps = {
    content: 'Some markdown content.',
    documentPath: options.documentPath ?? 'workspace/notes.md',
    fileName: 'notes.md',
    isMarkdownFile: true,
    isEditing: false,
    statusText: 'Saved',
    justSaved: false,
    hasAnnotations: options.annotationList.length > 0,
    annotationList: options.annotationList,
    onRemoveAnnotation: mocks.onRemoveAnnotation as unknown as FooterProps['onRemoveAnnotation'],
    onClearAnnotations: mocks.onClearAnnotations as unknown as FooterProps['onClearAnnotations'],
    formatAnnotationMessage: mocks.formatAnnotationMessage as unknown as FooterProps['formatAnnotationMessage'],
    flushAnnotationWriteNow: mocks.flushAnnotationWriteNow as unknown as FooterProps['flushAnnotationWriteNow'],
    editorRef,
    onSendAnnotations: mocks.onSendAnnotations as unknown as FooterProps['onSendAnnotations'],
    currentSessionId: 'current-session',
    currentSessionTitle: 'Current chat',
    showToast: mocks.showToast as unknown as FooterProps['showToast'],
    emitLog: mocks.emitLog as unknown as FooterProps['emitLog'],
  };

  return { props, mocks };
}

function renderFooter(
  options: Parameters<typeof buildDefaultProps>[0],
): RenderResult {
  const { props, mocks } = buildDefaultProps(options);

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = ReactDOMClient.createRoot(container);

  reactAct(() => {
    root.render(React.createElement(DocumentFooter, props));
  });

  let currentProps = props;

  return {
    container,
    root,
    mocks,
    props,
    rerender(next: Partial<FooterProps>) {
      currentProps = { ...currentProps, ...next };
      reactAct(() => {
        root.render(React.createElement(DocumentFooter, currentProps));
      });
    },
    unmount() {
      reactAct(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

function findByTestId(container: HTMLElement, testId: string): HTMLElement {
  const el = container.querySelector(`[data-testid="${testId}"]`);
  if (!(el instanceof HTMLElement)) {
    throw new Error(`Could not find element with data-testid="${testId}"`);
  }
  return el;
}

function findSendButton(container: HTMLElement): HTMLButtonElement {
  const buttons = Array.from(container.querySelectorAll('button'));
  const btn = buttons.find((b) => b.textContent?.includes('Send to Rebel'));
  if (!(btn instanceof HTMLButtonElement)) {
    throw new Error('Send to Rebel button not found');
  }
  return btn;
}

/**
 * Click a button inside a React `act` batch so effects flush.
 */
function clickButton(el: HTMLElement): void {
  reactAct(() => {
    el.click();
  });
}

interface CapturedEventDetail {
  message: string;
  documentPath?: string;
  documentTitle?: string;
  onCommit?: () => void | Promise<void>;
}

/**
 * Install a one-shot listener for `library:send-annotations` and return a
 * helper that extracts the captured detail (or throws if nothing fired).
 */
function captureLibrarySendAnnotationEvent(): {
  getDetail: () => CapturedEventDetail;
  cleanup: () => void;
  wasFired: () => boolean;
} {
  let captured: CapturedEventDetail | null = null;
  const handler = (e: Event) => {
    const custom = e as CustomEvent<CapturedEventDetail>;
    captured = custom.detail;
  };
  window.addEventListener('library:send-annotations', handler);
  return {
    getDetail: () => {
      if (!captured) throw new Error('library:send-annotations never fired');
      return captured;
    },
    wasFired: () => captured !== null,
    cleanup: () => {
      window.removeEventListener('library:send-annotations', handler);
    },
  };
}

/**
 * Convenience: fire an onCommit closure and wait for any returned promise.
 */
async function fireOnCommit(
  onCommit: (() => void | Promise<void>) | undefined,
): Promise<void> {
  if (!onCommit) {
    throw new Error('expected onCommit to be captured');
  }
  await reactAct(async () => {
    await onCommit();
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DocumentFooter — annotation send/commit routing (Stage 5)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  // -------------------------------------------------------------------------
  // Matrix row 1 — direct send, current session, no dialog
  // -------------------------------------------------------------------------

  it('row 1: direct send (no dialog) dispatches event with onCommit that clears staged ids and flushes on fire', async () => {
    const capture = captureLibrarySendAnnotationEvent();
    const view = renderFooter({
      annotationList: makeAnnotations(['ann-1', 'ann-2']),
      withDialog: false,
    });

    clickButton(findSendButton(view.container));

    // Verify event payload.
    expect(capture.wasFired()).toBe(true);
    const detail = capture.getDetail();
    expect(detail.message).toBe('[annotations for workspace/notes.md]');
    expect(detail.documentPath).toBe('workspace/notes.md');
    expect(detail.documentTitle).toBe('notes.md');
    expect(typeof detail.onCommit).toBe('function');

    // Stash has not fired yet — no clear should have happened.
    expect(view.mocks.onClearAnnotations).not.toHaveBeenCalled();
    expect(view.mocks.flushAnnotationWriteNow).not.toHaveBeenCalled();

    // Fire the onCommit closure to simulate the message dispatching.
    await fireOnCommit(detail.onCommit);

    expect(view.mocks.onClearAnnotations).toHaveBeenCalledTimes(1);
    expect(view.mocks.onClearAnnotations).toHaveBeenCalledWith(['ann-1', 'ann-2']);
    expect(view.mocks.flushAnnotationWriteNow).toHaveBeenCalledTimes(1);

    // Per Stage 3 contract the direct-send path also shows a toast.
    expect(view.mocks.showToast).toHaveBeenCalledWith({ title: 'Comments sent to Rebel' });

    capture.cleanup();
    view.unmount();
  });

  // -------------------------------------------------------------------------
  // Matrix row 2 — dialog → "new conversation"
  // -------------------------------------------------------------------------

  it('row 2: dialog → "new" routes through onSendAnnotations with onCommit that clears on fire', async () => {
    const view = renderFooter({
      annotationList: makeAnnotations(['ann-1', 'ann-2']),
      withDialog: true,
    });

    clickButton(findSendButton(view.container));
    // Dialog should now be open in the mocked stub.
    findByTestId(view.container, 'send-dialog');
    clickButton(findByTestId(view.container, 'dialog-send-new'));

    expect(view.mocks.onSendAnnotations).toHaveBeenCalledTimes(1);
    const call = view.mocks.onSendAnnotations!.mock.calls[0];
    expect(call[0]).toBe('[annotations for workspace/notes.md]');
    expect(call[1]).toMatchObject({ target: 'new', sessionId: undefined });
    expect(typeof call[2]).toBe('function');

    // No clear yet — the onCommit hasn't been invoked.
    expect(view.mocks.onClearAnnotations).not.toHaveBeenCalled();
    expect(view.mocks.flushAnnotationWriteNow).not.toHaveBeenCalled();

    await fireOnCommit(call[2] as () => Promise<void>);
    expect(view.mocks.onClearAnnotations).toHaveBeenCalledWith(['ann-1', 'ann-2']);
    expect(view.mocks.flushAnnotationWriteNow).toHaveBeenCalledTimes(1);

    view.unmount();
  });

  // -------------------------------------------------------------------------
  // Matrix row 3 — dialog → "file-conversation" (existing session)
  // -------------------------------------------------------------------------

  it('row 3: dialog → "file-conversation" forwards sessionId through onSendAnnotations', async () => {
    const view = renderFooter({
      annotationList: makeAnnotations(['ann-1', 'ann-2']),
      withDialog: true,
    });

    clickButton(findSendButton(view.container));
    clickButton(findByTestId(view.container, 'dialog-send-file-conversation'));

    expect(view.mocks.onSendAnnotations).toHaveBeenCalledTimes(1);
    const call = view.mocks.onSendAnnotations!.mock.calls[0];
    expect(call[0]).toBe('[annotations for workspace/notes.md]');
    expect(call[1]).toMatchObject({ target: 'file-conversation', sessionId: 'sess-abc' });
    expect(typeof call[2]).toBe('function');

    await fireOnCommit(call[2] as () => Promise<void>);
    expect(view.mocks.onClearAnnotations).toHaveBeenCalledWith(['ann-1', 'ann-2']);

    view.unmount();
  });

  // -------------------------------------------------------------------------
  // Matrix row 4 — dialog → "last-active"
  // -------------------------------------------------------------------------

  it('row 4: dialog → "last-active" threads the chosen target through onSendAnnotations', async () => {
    const view = renderFooter({
      annotationList: makeAnnotations(['ann-1', 'ann-2']),
      withDialog: true,
    });

    clickButton(findSendButton(view.container));
    clickButton(findByTestId(view.container, 'dialog-send-last-active'));

    expect(view.mocks.onSendAnnotations).toHaveBeenCalledTimes(1);
    const call = view.mocks.onSendAnnotations!.mock.calls[0];
    expect(call[1]).toMatchObject({ target: 'last-active', sessionId: 'sess-last' });
    // App.tsx is responsible for resolving `resolvedTargetId`. At the footer
    // layer we just verify that the target is threaded through verbatim.
    expect(typeof call[2]).toBe('function');

    view.unmount();
  });

  // -------------------------------------------------------------------------
  // Matrix row 5 — user clears composer, doesn't send (footer invariant)
  // -------------------------------------------------------------------------

  it('row 5: onCommit captured but never invoked → annotations untouched', async () => {
    const view = renderFooter({
      annotationList: makeAnnotations(['ann-1', 'ann-2']),
      withDialog: true,
    });

    clickButton(findSendButton(view.container));
    clickButton(findByTestId(view.container, 'dialog-send-new'));

    expect(view.mocks.onSendAnnotations).toHaveBeenCalledTimes(1);
    const call = view.mocks.onSendAnnotations!.mock.calls[0];
    expect(typeof call[2]).toBe('function');

    // Simulate: App.tsx detected an empty-draft transition and dropped the
    // stash (REV 2 FIX A) — OR the user simply never pressed Enter. Either
    // way the onCommit is not invoked. Footer must leave annotations alone.
    expect(view.mocks.onClearAnnotations).not.toHaveBeenCalled();
    expect(view.mocks.flushAnnotationWriteNow).not.toHaveBeenCalled();

    view.unmount();
  });

  // -------------------------------------------------------------------------
  // Matrix row 6 — user sends on a different session instead
  // -------------------------------------------------------------------------

  it('row 6: a separate DocumentFooter cannot clear another instance\'s staged ids', async () => {
    // File A
    const viewA = renderFooter({
      annotationList: makeAnnotations(['a1', 'a2']),
      withDialog: true,
      documentPath: 'file-a.md',
    });

    clickButton(findSendButton(viewA.container));
    clickButton(findByTestId(viewA.container, 'dialog-send-new'));
    const callA = viewA.mocks.onSendAnnotations!.mock.calls[0];
    const onCommitA = callA[2] as () => Promise<void>;

    // File B — separate footer instance, separate onClearAnnotations mock.
    const viewB = renderFooter({
      annotationList: makeAnnotations(['b1', 'b2']),
      withDialog: true,
      documentPath: 'file-b.md',
    });

    clickButton(findSendButton(viewB.container));
    clickButton(findByTestId(viewB.container, 'dialog-send-new'));
    const callB = viewB.mocks.onSendAnnotations!.mock.calls[0];

    // Simulate: user effectively "sends on B" by firing B's onCommit only;
    // A's onCommit is never invoked (e.g. its stashed entry in App.tsx was
    // never drained because A's session never submitted).
    await fireOnCommit(callB[2] as () => Promise<void>);

    // B cleared its own ids.
    expect(viewB.mocks.onClearAnnotations).toHaveBeenCalledWith(['b1', 'b2']);
    // A's mock is untouched — the two closures are independent.
    expect(viewA.mocks.onClearAnnotations).not.toHaveBeenCalled();

    // Sanity: A's onCommit, if fired, would clear only A's ids.
    await fireOnCommit(onCommitA);
    expect(viewA.mocks.onClearAnnotations).toHaveBeenCalledWith(['a1', 'a2']);
    // B's mock still only saw B's ids.
    expect(viewB.mocks.onClearAnnotations.mock.calls).toEqual([[['b1', 'b2']]]);

    viewA.unmount();
    viewB.unmount();
  });

  // -------------------------------------------------------------------------
  // Matrix row 7 — user discards draft via dialog (cancel)
  // -------------------------------------------------------------------------

  it('row 7: dialog cancel does not fire onSendAnnotations or onClearAnnotations', () => {
    const view = renderFooter({
      annotationList: makeAnnotations(['ann-1', 'ann-2']),
      withDialog: true,
    });

    clickButton(findSendButton(view.container));
    clickButton(findByTestId(view.container, 'dialog-cancel'));

    expect(view.mocks.onSendAnnotations).not.toHaveBeenCalled();
    expect(view.mocks.onClearAnnotations).not.toHaveBeenCalled();
    expect(view.mocks.flushAnnotationWriteNow).not.toHaveBeenCalled();

    view.unmount();
  });

  // -------------------------------------------------------------------------
  // Matrix row 8 — double-send same file, same session
  // -------------------------------------------------------------------------

  it('row 8: double-send builds two onCommit closures; firing both is idempotent-safe', async () => {
    const view = renderFooter({
      annotationList: makeAnnotations(['ann-1', 'ann-2']),
      withDialog: true,
    });

    // First Send.
    clickButton(findSendButton(view.container));
    clickButton(findByTestId(view.container, 'dialog-send-new'));
    const onCommit1 = view.mocks.onSendAnnotations!.mock.calls[0][2] as () => Promise<void>;

    // Second Send (same staged ids, same session).
    clickButton(findSendButton(view.container));
    clickButton(findByTestId(view.container, 'dialog-send-new'));
    const onCommit2 = view.mocks.onSendAnnotations!.mock.calls[1][2] as () => Promise<void>;

    expect(onCommit1).not.toBe(onCommit2);

    // Fire both sequentially. The plan's "double-send is safe" contract
    // relies on the PM extension `clearIds` reducer silently skipping ids
    // that no longer exist (verified separately by the extension tests);
    // here we just assert the closures don't throw and each invokes its
    // expected side-effects.
    await fireOnCommit(onCommit1);
    await fireOnCommit(onCommit2);

    expect(view.mocks.onClearAnnotations).toHaveBeenCalledTimes(2);
    expect(view.mocks.onClearAnnotations.mock.calls).toEqual([
      [['ann-1', 'ann-2']],
      [['ann-1', 'ann-2']],
    ]);
    expect(view.mocks.flushAnnotationWriteNow).toHaveBeenCalledTimes(2);

    view.unmount();
  });

  // -------------------------------------------------------------------------
  // Matrix row 9 — two files, same session (distinct staged ids per file)
  // -------------------------------------------------------------------------

  it('row 9: two separate files each build onCommit closures that clear only their own staged ids', async () => {
    const viewA = renderFooter({
      annotationList: makeAnnotations(['a1', 'a2']),
      withDialog: true,
      documentPath: 'file-a.md',
    });
    const viewB = renderFooter({
      annotationList: makeAnnotations(['b1', 'b2']),
      withDialog: true,
      documentPath: 'file-b.md',
    });

    clickButton(findSendButton(viewA.container));
    clickButton(findByTestId(viewA.container, 'dialog-send-new'));
    const onCommitA = viewA.mocks.onSendAnnotations!.mock.calls[0][2] as () => Promise<void>;

    clickButton(findSendButton(viewB.container));
    clickButton(findByTestId(viewB.container, 'dialog-send-new'));
    const onCommitB = viewB.mocks.onSendAnnotations!.mock.calls[0][2] as () => Promise<void>;

    await fireOnCommit(onCommitA);
    await fireOnCommit(onCommitB);

    expect(viewA.mocks.onClearAnnotations).toHaveBeenCalledTimes(1);
    expect(viewA.mocks.onClearAnnotations).toHaveBeenCalledWith(['a1', 'a2']);
    expect(viewB.mocks.onClearAnnotations).toHaveBeenCalledTimes(1);
    expect(viewB.mocks.onClearAnnotations).toHaveBeenCalledWith(['b1', 'b2']);

    // No cross-file leak.
    expect(viewA.mocks.onClearAnnotations.mock.calls.flat().flat()).not.toContain('b1');
    expect(viewB.mocks.onClearAnnotations.mock.calls.flat().flat()).not.toContain('a1');

    viewA.unmount();
    viewB.unmount();
  });

  // -------------------------------------------------------------------------
  // Matrix row 11 — queue-cancel after Send
  // -------------------------------------------------------------------------

  it('row 11: queue-cancel (removeFromQueue) → onCommit never fires → annotations intact', async () => {
    const view = renderFooter({
      annotationList: makeAnnotations(['ann-1', 'ann-2']),
      withDialog: true,
    });

    clickButton(findSendButton(view.container));
    clickButton(findByTestId(view.container, 'dialog-send-new'));
    const call = view.mocks.onSendAnnotations!.mock.calls[0];
    expect(typeof call[2]).toBe('function');

    // Simulate `removeFromQueue(id)` in `useMessageQueue` — the QueuedMessage
    // is dropped, its `onCommit` never runs. Footer-level invariant: as long
    // as the closure is not invoked, no clear happens.
    expect(view.mocks.onClearAnnotations).not.toHaveBeenCalled();
    expect(view.mocks.flushAnnotationWriteNow).not.toHaveBeenCalled();

    // For completeness, GC the closure reference and confirm nothing else
    // sneaks in — React render path already settled above. No-op assert.
    void call[2];
    expect(view.mocks.onClearAnnotations).not.toHaveBeenCalled();

    view.unmount();
  });

  // -------------------------------------------------------------------------
  // Matrix row 13 — post-staging annotation added
  // -------------------------------------------------------------------------

  it('row 13: annotation added after Send is NOT cleared by the earlier onCommit snapshot', async () => {
    const view = renderFooter({
      annotationList: makeAnnotations(['ann-1', 'ann-2']),
      withDialog: true,
    });

    clickButton(findSendButton(view.container));
    clickButton(findByTestId(view.container, 'dialog-send-new'));
    const onCommit = view.mocks.onSendAnnotations!.mock.calls[0][2] as () => Promise<void>;

    // After Send click, user adds a new annotation (ann-3). The stashed
    // snapshot should NOT know about it — closure captured [ann-1, ann-2].
    view.rerender({
      annotationList: makeAnnotations(['ann-1', 'ann-2', 'ann-3']),
      hasAnnotations: true,
    });

    await fireOnCommit(onCommit);

    expect(view.mocks.onClearAnnotations).toHaveBeenCalledTimes(1);
    expect(view.mocks.onClearAnnotations).toHaveBeenCalledWith(['ann-1', 'ann-2']);
    // ann-3 is NOT in the argument list — it survives the clear.
    expect(view.mocks.onClearAnnotations.mock.calls[0][0]).not.toContain('ann-3');

    view.unmount();
  });

  // -------------------------------------------------------------------------
  // Auxiliary assertion: annotation-format exhaustion aborts send
  // (supports Stage 4 contract — referenced in plan note for row 14 coverage)
  // -------------------------------------------------------------------------

  it('aborts send on AnnotationFormatExhaustionError; onSendAnnotations is not called', async () => {
    const view = renderFooter({
      annotationList: makeAnnotations(['ann-1', 'ann-2']),
      withDialog: true,
    });

    // Swap the formatter into a throwing one BEFORE the Send click.
    // The constructor takes the retry-attempts count; value doesn't matter
    // for this assertion — we only care that the error is surfaced.
    view.mocks.formatAnnotationMessage.mockImplementation(() => {
      throw new AnnotationFormatExhaustionError(3);
    });

    clickButton(findSendButton(view.container));
    clickButton(findByTestId(view.container, 'dialog-send-new'));

    // Formatter threw → send aborted.
    expect(view.mocks.onSendAnnotations).not.toHaveBeenCalled();
    // Fail-loud: a user-facing toast and an error-level log are required.
    expect(view.mocks.showToast).toHaveBeenCalledWith({
      title: "Couldn't format comments — try simplifying the text",
    });
    expect(view.mocks.emitLog).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'error',
        context: expect.objectContaining({ reason: 'fence-collision-exhausted' }),
      }),
    );

    view.unmount();
  });
});
