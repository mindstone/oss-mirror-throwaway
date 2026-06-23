// @vitest-environment happy-dom
import React from 'react';
import * as ReactDOMClient from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmitLogPayload } from '@renderer/contexts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ---------------------------------------------------------------------------
// Module mocks — must be declared before importing DocumentFooter.
// ---------------------------------------------------------------------------

 
vi.mock('@renderer/features/library/components/SendToRebelDialog', () => ({
  SendToRebelDialog: (_: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
  }) => null,
}));

 
vi.mock('@renderer/components/ui', () => ({
  Button: React.forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement>>(
    function MockButton({ children, ...rest }, ref) {
      return React.createElement('button', { ...rest, ref }, children);
    },
  ),
  Tooltip: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
}));

const { act: reactAct } = require('react') as typeof import('react');

import { DocumentFooter } from '../DocumentFooter';

type FooterProps = React.ComponentProps<typeof DocumentFooter>;

type FooterMocks = {
  onClearAnnotations: ReturnType<typeof vi.fn>;
  flushAnnotationWriteNow: ReturnType<typeof vi.fn>;
  showToast: ReturnType<typeof vi.fn>;
  emitLog: ReturnType<typeof vi.fn>;
};

type RenderedFooter = {
  container: HTMLElement;
  mocks: FooterMocks;
  unmount: () => void;
};

function renderFooterWithFlushFailure(error: Error): RenderedFooter {
  const mocks: FooterMocks = {
    onClearAnnotations: vi.fn(),
    flushAnnotationWriteNow: vi.fn(async () => {
      throw error;
    }),
    showToast: vi.fn(),
    emitLog: vi.fn(),
  };
  const editorRef: FooterProps['editorRef'] = {
    current: {
      focus: vi.fn(),
      scrollToAnnotation: vi.fn(),
    },
  };

  const props: FooterProps = {
    content: 'Document content',
    documentPath: 'workspace/notes.md',
    fileName: 'notes.md',
    isMarkdownFile: true,
    isEditing: false,
    statusText: 'Saved',
    justSaved: false,
    hasAnnotations: true,
    annotationList: [
      {
        id: 'ann-1',
        from: 0,
        to: 5,
        text: 'quote',
        comment: 'comment',
      },
    ],
    onRemoveAnnotation: vi.fn() as unknown as FooterProps['onRemoveAnnotation'],
    onClearAnnotations: mocks.onClearAnnotations as unknown as FooterProps['onClearAnnotations'],
    formatAnnotationMessage: vi.fn((documentPath: string) => `[annotations for ${documentPath}]`),
    flushAnnotationWriteNow: mocks.flushAnnotationWriteNow as unknown as FooterProps['flushAnnotationWriteNow'],
    editorRef,
    onSendAnnotations: undefined,
    currentSessionId: 'session-1',
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
    mocks,
    unmount() {
      reactAct(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

function renderFooterWithClearFailure(error: Error, options: { includeEmitLog?: boolean } = {}): RenderedFooter {
  const includeEmitLog = options.includeEmitLog ?? true;
  const mocks: FooterMocks = {
    onClearAnnotations: vi.fn(() => {
      throw error;
    }),
    flushAnnotationWriteNow: vi.fn(),
    showToast: vi.fn(),
    emitLog: vi.fn(),
  };
  const editorRef: FooterProps['editorRef'] = {
    current: {
      focus: vi.fn(),
      scrollToAnnotation: vi.fn(),
    },
  };

  const props: FooterProps = {
    content: 'Document content',
    documentPath: '/Users/test/workspace/secret.md',
    fileName: 'secret.md',
    isMarkdownFile: true,
    isEditing: false,
    statusText: 'Saved',
    justSaved: false,
    hasAnnotations: true,
    annotationList: [
      {
        id: 'ann-1',
        from: 0,
        to: 5,
        text: 'quote',
        comment: 'comment',
      },
    ],
    onRemoveAnnotation: vi.fn() as unknown as FooterProps['onRemoveAnnotation'],
    onClearAnnotations: mocks.onClearAnnotations as unknown as FooterProps['onClearAnnotations'],
    formatAnnotationMessage: vi.fn((documentPath: string) => `[annotations for ${documentPath}]`),
    flushAnnotationWriteNow: mocks.flushAnnotationWriteNow as unknown as FooterProps['flushAnnotationWriteNow'],
    editorRef,
    onSendAnnotations: undefined,
    currentSessionId: 'session-1',
    currentSessionTitle: 'Current chat',
    showToast: mocks.showToast as unknown as FooterProps['showToast'],
    emitLog: includeEmitLog ? mocks.emitLog as unknown as FooterProps['emitLog'] : undefined,
  };

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = ReactDOMClient.createRoot(container);

  reactAct(() => {
    root.render(React.createElement(DocumentFooter, props));
  });

  return {
    container,
    mocks,
    unmount() {
      reactAct(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

function captureOnCommit(view: RenderedFooter): () => void | Promise<void> {
  let captured: (() => void | Promise<void>) | null = null;
  const handler = (event: Event) => {
    const custom = event as CustomEvent<{ onCommit?: () => void | Promise<void> }>;
    captured = custom.detail.onCommit ?? null;
  };
  window.addEventListener('library:send-annotations', handler);

  try {
    reactAct(() => {
      const button = Array.from(view.container.querySelectorAll('button')).find((candidate) =>
        candidate.textContent?.includes('Send to Rebel'),
      );
      if (!(button instanceof HTMLButtonElement)) {
        throw new Error('Send to Rebel button not found');
      }
      button.click();
    });
  } finally {
    window.removeEventListener('library:send-annotations', handler);
  }

  if (!captured) {
    throw new Error('onCommit was not captured');
  }
  return captured;
}

describe('DocumentFooter privacy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('T32: flushAnnotationWriteNow rejection logs classifier fields without leaking path-bearing error details', async () => {
    const pathBearingError = Object.assign(
      new Error("EACCES: permission denied, open '/Users/test/workspace/secret.md'"),
      {
        code: 'EACCES',
        path: '/Users/test/workspace/secret.md',
      },
    );
    const view = renderFooterWithFlushFailure(pathBearingError);
    const onCommit = captureOnCommit(view);

    await reactAct(async () => {
      await onCommit();
    });

    expect(view.mocks.flushAnnotationWriteNow).toHaveBeenCalledTimes(1);
    const logEntry = view.mocks.emitLog.mock.calls.find(
      ([entry]) => (entry as EmitLogPayload).message === 'Failed to flush annotation write on dispatch',
    )?.[0] as EmitLogPayload | undefined;

    expect(logEntry).toBeDefined();
    expect(logEntry).toEqual(
      expect.objectContaining({
        level: 'error',
        message: 'Failed to flush annotation write on dispatch',
        context: expect.objectContaining({
          annotationCount: 1,
          errorClassifier: {
            errorName: 'Error',
            errorKind: 'fs',
            errorCode: 'EACCES',
          },
        }),
      }),
    );
    expect(logEntry!.context).not.toHaveProperty('documentPath');
    expect(logEntry!.context).not.toHaveProperty('error');

    const serialized = JSON.stringify(view.mocks.emitLog.mock.calls);
    expect(serialized).not.toContain('/Users/test/workspace');
    expect(serialized).not.toContain('secret.md');
    expect(serialized).not.toContain('permission denied');

    view.unmount();
  });

  it('T36: annotation clear failures classify errors without leaking document paths to emitLog or console fallback', async () => {
    const pathBearingError = Object.assign(
      new Error("EACCES: permission denied, open '/Users/test/workspace/secret.md'"),
      {
        code: 'EACCES',
        path: '/Users/test/workspace/secret.md',
      },
    );
    const view = renderFooterWithClearFailure(pathBearingError);
    const onCommit = captureOnCommit(view);

    await reactAct(async () => {
      await onCommit();
    });

    const logEntry = view.mocks.emitLog.mock.calls.find(
      ([entry]) => (entry as EmitLogPayload).message === 'Unexpected error clearing annotations on dispatch',
    )?.[0] as EmitLogPayload | undefined;

    expect(logEntry).toBeDefined();
    expect(logEntry).toEqual(
      expect.objectContaining({
        level: 'error',
        message: 'Unexpected error clearing annotations on dispatch',
        context: expect.objectContaining({
          annotationCount: 1,
          errorClassifier: {
            errorName: 'Error',
            errorKind: 'fs',
            errorCode: 'EACCES',
          },
        }),
      }),
    );
    for (const [entry] of view.mocks.emitLog.mock.calls) {
      const payload = entry as EmitLogPayload;
      expect(payload).not.toHaveProperty('documentPath');
      expect(payload).not.toHaveProperty('error');
      expect(payload.context ?? {}).not.toHaveProperty('documentPath');
      expect(payload.context ?? {}).not.toHaveProperty('error');
    }
    const serializedEmitLog = JSON.stringify(view.mocks.emitLog.mock.calls);
    expect(serializedEmitLog).not.toContain('/Users/test/workspace');
    expect(serializedEmitLog).not.toContain('secret.md');
    expect(serializedEmitLog).not.toContain('permission denied');
    view.unmount();

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const consolePathBearingError = Object.assign(
      new Error("EACCES: permission denied, open '/Users/test/workspace/secret.md'"),
      {
        code: 'EACCES',
        path: '/Users/test/workspace/secret.md',
      },
    );
    const consoleView = renderFooterWithClearFailure(consolePathBearingError, { includeEmitLog: false });
    const consoleOnCommit = captureOnCommit(consoleView);

    await reactAct(async () => {
      await consoleOnCommit();
    });

    const consoleMetadata = consoleError.mock.calls.find(
      ([message]) => message === '[DocumentFooter] Unexpected error clearing annotations on dispatch',
    )?.[1] as Record<string, unknown> | undefined;

    expect(consoleMetadata).toEqual(
      expect.objectContaining({
        annotationCount: 1,
        errorClassifier: {
          errorName: 'Error',
          errorKind: 'fs',
          errorCode: 'EACCES',
        },
      }),
    );
    expect(consoleMetadata).not.toHaveProperty('documentPath');
    expect(consoleMetadata).not.toHaveProperty('error');
    const serializedConsole = JSON.stringify(consoleError.mock.calls);
    expect(serializedConsole).not.toContain('/Users/test/workspace');
    expect(serializedConsole).not.toContain('secret.md');
    expect(serializedConsole).not.toContain('permission denied');

    consoleError.mockRestore();
    consoleView.unmount();
  });
});
