// @vitest-environment happy-dom
/**
 * Unit tests for the DocumentFooter onCommit closure error paths (Stage 5).
 *
 * Covers matrix row 10 plus two natural extensions (generic error from the
 * clear call, flushAnnotationWriteNow rejection) from the planning doc's
 * "Failure-mode matrix". Happy-path behaviour (clear succeeds, flush
 * succeeds) is covered by `documentAnnotationRouting.test.ts`.
 *
 * Strategy: render `DocumentFooter` with the direct-send path (no dialog),
 * click Send to capture the onCommit payload via the `library:send-annotations`
 * CustomEvent, then drive the closure with a failing `onClearAnnotations` or
 * failing `flushAnnotationWriteNow` mock. Assert the fail-loud observability
 * contract from Stage 3 / REV 2:
 *   - Structured log entry with the correct level + message + safe context
 *     (errorClassifier instead of raw error messages or document paths).
 *   - User-facing toast with the correct title.
 *   - Closure completes cleanly (no throw propagates to the caller — the
 *     queue's `invokeOnCommitSafely` relies on the onCommit being safe).
 */

import React from 'react';
import * as ReactDOMClient from 'react-dom/client';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { SendTarget } from '@renderer/features/library/components/SendToRebelDialog';
import { EditorUnmountedError } from '@renderer/features/library/extensions/tiptapAnnotationExtension';

// Enable React's act() environment to silence the "not configured" warning.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ---------------------------------------------------------------------------
// Module mocks — must be declared before importing DocumentFooter.
// ---------------------------------------------------------------------------

// The dialog is never opened in this file (we use the direct-send path),
// but it's still referenced at module eval time. Stub it with a render-null
// body so importing DocumentFooter doesn't need the real dialog's IPC deps.
 
vi.mock('@renderer/features/library/components/SendToRebelDialog', () => ({
  SendToRebelDialog: (_: {
    open: boolean;
    onSend: (target: SendTarget, sessionId?: string) => void;
    onOpenChange: (open: boolean) => void;
  }) => null,
}));

// Pass-through Tooltip / plain-button shim — matches the routing test's
// rationale: avoid @floating-ui/react quirks in happy-dom.
 
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
// Imports after mocks
// ---------------------------------------------------------------------------

const { act: reactAct } = require('react') as typeof import('react');

import { DocumentFooter } from '../components/DocumentFooter';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type FooterProps = React.ComponentProps<typeof DocumentFooter>;

interface FooterMocks {
  onClearAnnotations: ReturnType<typeof vi.fn>;
  flushAnnotationWriteNow: ReturnType<typeof vi.fn>;
  formatAnnotationMessage: ReturnType<typeof vi.fn>;
  showToast: ReturnType<typeof vi.fn>;
  emitLog: ReturnType<typeof vi.fn>;
}

interface RenderResult {
  container: HTMLElement;
  root: ReactDOMClient.Root;
  mocks: FooterMocks;
  unmount: () => void;
}

function makeAnnotations(ids: string[]) {
  return ids.map((id, index) => ({
    id,
    from: index * 10,
    to: index * 10 + 5,
    text: `text-${id}`,
    comment: `comment-${id}`,
  }));
}

function renderFooter(options: {
  documentPath: string;
  ids: string[];
  onClearAnnotationsImpl?: (ids?: string[]) => void;
  flushAnnotationWriteNowImpl?: () => Promise<void>;
}): RenderResult {
  const mocks: FooterMocks = {
    onClearAnnotations: vi.fn(options.onClearAnnotationsImpl ?? (() => undefined)),
    flushAnnotationWriteNow: vi.fn(
      options.flushAnnotationWriteNowImpl ?? (async () => undefined),
    ),
    formatAnnotationMessage: vi.fn((p: string) => `[annotations for ${p}]`),
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

  // Cast vi.fn() mocks to the concrete prop function types — TS can't
  // narrow `Mock<...>` to the exact function signature, so we widen via
  // `unknown` at the prop boundary. Runtime shape matches.
  const props: FooterProps = {
    content: 'Some markdown content.',
    documentPath: options.documentPath,
    fileName: options.documentPath.split('/').pop() ?? 'file.md',
    isMarkdownFile: true,
    isEditing: false,
    statusText: 'Saved',
    justSaved: false,
    hasAnnotations: options.ids.length > 0,
    annotationList: makeAnnotations(options.ids),
    onRemoveAnnotation: vi.fn() as unknown as FooterProps['onRemoveAnnotation'],
    onClearAnnotations: mocks.onClearAnnotations as unknown as FooterProps['onClearAnnotations'],
    formatAnnotationMessage: mocks.formatAnnotationMessage as unknown as FooterProps['formatAnnotationMessage'],
    flushAnnotationWriteNow: mocks.flushAnnotationWriteNow as unknown as FooterProps['flushAnnotationWriteNow'],
    editorRef,
    // NOTE: onSendAnnotations omitted → DocumentFooter uses the direct-send
    // path (CustomEvent dispatch) which is what we want to capture.
    onSendAnnotations: undefined,
    currentSessionId: 'current-session',
    currentSessionTitle: 'Current chat',
    showToast: mocks.showToast as unknown as FooterProps['showToast'],
    emitLog: mocks.emitLog as unknown as FooterProps['emitLog'],
  };

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = ReactDOMClient.createRoot(container);

  reactAct(() => {
    root.render(React.createElement(DocumentFooter, props));
  });

  return {
    container,
    root,
    mocks,
    unmount() {
      reactAct(() => {
        root.unmount();
      });
      container.remove();
    },
  };
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
 * Click Send, capture the `library:send-annotations` event detail, and
 * return the stashed onCommit closure for direct invocation in the
 * test body.
 */
function capturedOnCommit(view: RenderResult): () => void | Promise<void> {
  let captured: (() => void | Promise<void>) | null = null;
  const handler = (e: Event) => {
    const custom = e as CustomEvent<{ onCommit?: () => void | Promise<void> }>;
    captured = custom.detail.onCommit ?? null;
  };
  window.addEventListener('library:send-annotations', handler);

  try {
    reactAct(() => {
      findSendButton(view.container).click();
    });
  } finally {
    window.removeEventListener('library:send-annotations', handler);
  }

  if (!captured) {
    throw new Error(
      'onCommit was not captured — did the send path abort before dispatch?',
    );
  }
  return captured;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DocumentFooter — onCommit closure error paths (Stage 5)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  // -------------------------------------------------------------------------
  // Row 10 — editor unmounted → EditorUnmountedError from clear
  // -------------------------------------------------------------------------

  it('row 10: EditorUnmountedError → warn log + "reopen the file" toast + no throw', async () => {
    const view = renderFooter({
      documentPath: 'workspace/notes.md',
      ids: ['ann-1', 'ann-2', 'ann-3'],
      onClearAnnotationsImpl: () => {
        throw new EditorUnmountedError();
      },
    });

    const onCommit = capturedOnCommit(view);

    // Invoking the closure must NOT throw — it must catch the
    // EditorUnmountedError, log + toast, then return cleanly.
    await expect(
      (async () => {
        await reactAct(async () => {
          await onCommit();
        });
      })(),
    ).resolves.toBeUndefined();

    // onClearAnnotations was invoked (throwing) — snapshot must be the
    // Send-time ids.
    expect(view.mocks.onClearAnnotations).toHaveBeenCalledTimes(1);
    expect(view.mocks.onClearAnnotations).toHaveBeenCalledWith([
      'ann-1',
      'ann-2',
      'ann-3',
    ]);

    // Warn-level structured log with the right shape.
    expect(view.mocks.emitLog).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'warn',
        message: 'Failed to clear annotations on dispatch — editor unmounted',
        context: expect.objectContaining({
          annotationCount: 3,
          reason: 'editor-unmounted',
          errorClassifier: {
            errorName: 'CustomError',
            errorKind: 'unknown',
          },
        }),
      }),
    );
    const logEntry = view.mocks.emitLog.mock.calls[0]?.[0] as { context: Record<string, unknown> } | undefined;
    expect(logEntry).toBeDefined();
    expect(logEntry!.context).not.toHaveProperty('documentPath');
    expect(logEntry!.context).not.toHaveProperty('error');

    // Exactly one warn log + exactly zero error logs.
    const errorLogs = view.mocks.emitLog.mock.calls.filter(
      ([entry]) => (entry as { level: string }).level === 'error',
    );
    expect(errorLogs).toHaveLength(0);

    // User-facing toast.
    expect(view.mocks.showToast).toHaveBeenCalledWith({
      title: "Comments couldn't be cleared — reopen the file",
    });

    // Editor is dead → the closure skips flushAnnotationWriteNow.
    expect(view.mocks.flushAnnotationWriteNow).not.toHaveBeenCalled();

    view.unmount();
  });

  // -------------------------------------------------------------------------
  // Row 10b — generic error from clear
  // -------------------------------------------------------------------------

  it('row 10b: generic Error → error log + "please reload the file" toast + no throw', async () => {
    const view = renderFooter({
      documentPath: 'workspace/notes.md',
      ids: ['ann-1', 'ann-2'],
      onClearAnnotationsImpl: () => {
        throw new Error('something else');
      },
    });

    const onCommit = capturedOnCommit(view);

    await expect(
      (async () => {
        await reactAct(async () => {
          await onCommit();
        });
      })(),
    ).resolves.toBeUndefined();

    expect(view.mocks.onClearAnnotations).toHaveBeenCalledTimes(1);

    // Error-level structured log with the safe classifier captured in context.
    expect(view.mocks.emitLog).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'error',
        message: 'Unexpected error clearing annotations on dispatch',
        context: expect.objectContaining({
          annotationCount: 2,
          errorClassifier: {
            errorName: 'Error',
            errorKind: 'unknown',
          },
        }),
      }),
    );
    const logEntry = view.mocks.emitLog.mock.calls[0]?.[0] as { context: Record<string, unknown> } | undefined;
    expect(logEntry).toBeDefined();
    expect(logEntry!.context).not.toHaveProperty('documentPath');
    expect(logEntry!.context).not.toHaveProperty('error');

    // No warn log for this path.
    const warnLogs = view.mocks.emitLog.mock.calls.filter(
      ([entry]) => (entry as { level: string }).level === 'warn',
    );
    expect(warnLogs).toHaveLength(0);

    expect(view.mocks.showToast).toHaveBeenCalledWith({
      title: "Comments couldn't be cleared — please reload the file",
    });

    // Generic error also short-circuits the flush.
    expect(view.mocks.flushAnnotationWriteNow).not.toHaveBeenCalled();

    view.unmount();
  });

  // -------------------------------------------------------------------------
  // Row 10c — flushAnnotationWriteNow rejects after successful clear
  // -------------------------------------------------------------------------

  it('row 10c: flushAnnotationWriteNow rejection → error log + "please reload the file" toast + no throw', async () => {
    const view = renderFooter({
      documentPath: 'workspace/notes.md',
      ids: ['ann-1', 'ann-2'],
      // onClearAnnotations succeeds.
      onClearAnnotationsImpl: () => undefined,
      // flushAnnotationWriteNow rejects.
      flushAnnotationWriteNowImpl: async () => {
        const err = new Error('disk full') as NodeJS.ErrnoException;
        err.code = 'ENOSPC';
        throw err;
      },
    });

    const onCommit = capturedOnCommit(view);

    await expect(
      (async () => {
        await reactAct(async () => {
          await onCommit();
        });
      })(),
    ).resolves.toBeUndefined();

    // Clear ran cleanly.
    expect(view.mocks.onClearAnnotations).toHaveBeenCalledTimes(1);
    expect(view.mocks.flushAnnotationWriteNow).toHaveBeenCalledTimes(1);

    // Error log from the flush failure.
    expect(view.mocks.emitLog).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'error',
        message: 'Failed to flush annotation write on dispatch',
        context: expect.objectContaining({
          annotationCount: 2,
          errorClassifier: {
            errorName: 'Error',
            errorKind: 'fs',
            errorCode: 'ENOSPC',
          },
        }),
      }),
    );
    const logEntry = view.mocks.emitLog.mock.calls.find(
      ([entry]) => (entry as { message?: string }).message === 'Failed to flush annotation write on dispatch',
    )?.[0] as { context: Record<string, unknown> } | undefined;
    expect(logEntry).toBeDefined();
    expect(logEntry!.context).not.toHaveProperty('documentPath');
    expect(logEntry!.context).not.toHaveProperty('error');

    // Distinct toast copy for the flush path.
    expect(view.mocks.showToast).toHaveBeenCalledWith({
      title: "Couldn't save cleared comments to disk — please reload the file",
    });

    view.unmount();
  });

  // -------------------------------------------------------------------------
  // Sanity: documentPath is not included in failure logs
  // -------------------------------------------------------------------------

  it('omits documentPath from clear-failure logs even when the path contains control characters', async () => {
    const adversarial = 'workspace/evil\nfile\u0000.md';

    const view = renderFooter({
      documentPath: adversarial,
      ids: ['ann-1'],
      onClearAnnotationsImpl: () => {
        throw new Error('bang');
      },
    });

    const onCommit = capturedOnCommit(view);
    await reactAct(async () => {
      await onCommit();
    });

    const logEntry = view.mocks.emitLog.mock.calls.find(
      ([entry]) => (entry as { level: string }).level === 'error',
    )?.[0] as { context: Record<string, unknown> } | undefined;

    expect(logEntry).toBeDefined();
    expect(logEntry!.context).not.toHaveProperty('documentPath');
    expect(logEntry!.context).not.toHaveProperty('error');
    expect(JSON.stringify(view.mocks.emitLog.mock.calls)).not.toContain('workspace/evil');

    view.unmount();
  });
});
