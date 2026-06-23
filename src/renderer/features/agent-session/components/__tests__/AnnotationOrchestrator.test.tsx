// @vitest-environment happy-dom
import React, { act, createRef, type MutableRefObject } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppProvider, type AppContextValue, type ToastMessage } from '@renderer/contexts';
import type { ComposerHandle } from '@renderer/features/composer/ComposerWithState';
import type { ConversationAnnotation } from '@shared/types/agent';
import { useSessionStore } from '../../store';
import { AnnotationOrchestrator } from '../AnnotationOrchestrator';

 
vi.mock('../../hooks/useAnnotationHighlights', () => ({
  useAnnotationHighlights: () => ({ positions: [] }),
}));

 
vi.mock('../AnnotationBar', () => ({
  AnnotationBar: () => null,
}));

 
vi.mock('../AnnotationIcons', () => ({
  AnnotationIcons: () => null,
}));

 
vi.mock('../TextSelectionMenu', () => ({
  TextSelectionMenuLayer: () => null,
}));

 
vi.mock('@renderer/features/library/components/AnnotationPopover', () => ({
  AnnotationPopover: () => null,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type HandleUserMessageOptions = {
  displayText?: string;
  onCommit?: () => void | Promise<void>;
};

type RenderResult = {
  root: Root;
  container: HTMLDivElement;
  sendAnnotationsRef: MutableRefObject<(() => void) | null>;
  handleUserMessage: ReturnType<typeof vi.fn>;
  clearComposerAfterSend: ReturnType<typeof vi.fn>;
  showToast: ReturnType<typeof vi.fn>;
  emitLog: ReturnType<typeof vi.fn>;
};

const createAnnotation = (
  overrides: Partial<ConversationAnnotation> = {},
): ConversationAnnotation => ({
  id: 'ann-1',
  messageId: 'msg-1',
  text: 'selected text',
  comment: 'remember this',
  createdAt: 1703851200000,
  startOffset: 0,
  endOffset: 13,
  ...overrides,
});

const flushPromises = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

function renderOrchestrator({
  handleUserMessage = vi.fn(async (...args: unknown[]) => {
    const options = args[3] as HandleUserMessageOptions | undefined;
    await options?.onCommit?.();
  }),
  composerText = '',
  showToast = vi.fn(),
  emitLog = vi.fn(),
}: {
  handleUserMessage?: ReturnType<typeof vi.fn>;
  composerText?: string;
  showToast?: ReturnType<typeof vi.fn>;
  emitLog?: ReturnType<typeof vi.fn>;
} = {}): RenderResult {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const sendAnnotationsRef: MutableRefObject<(() => void) | null> = { current: null };
  const clearComposerAfterSend = vi.fn();
  const composerRef = createRef<ComposerHandle>();
  composerRef.current = {
    getText: () => composerText,
    getAttachments: () => [],
  } as unknown as ComposerHandle;
  const appContextValue: AppContextValue = {
    emitLog: emitLog as unknown as AppContextValue['emitLog'],
    showToast: showToast as unknown as AppContextValue['showToast'],
    recordBreadcrumb: vi.fn(),
    settings: null,
  };

  act(() => {
    root.render(
      <AppProvider value={appContextValue}>
        <AnnotationOrchestrator
          currentSessionId="session-1"
          agentSessionLogRef={{ current: { getScrollElement: () => null } } as never}
          handleUserMessage={handleUserMessage as unknown as (...args: unknown[]) => Promise<void>}
          composerRef={composerRef}
          clearComposerAfterSend={clearComposerAfterSend}
          isBusy={false}
          showToast={showToast as (message: ToastMessage) => void}
          onAnnotationActiveChange={vi.fn()}
          onAnnotationCountChange={vi.fn()}
          sendAnnotationsRef={sendAnnotationsRef}
          prepareMentionAttachments={vi.fn().mockResolvedValue([])}
          prepareConversationAttachments={vi.fn().mockResolvedValue([])}
          onReply={vi.fn()}
          onReplyInNewChat={vi.fn()}
          onGenericAddComment={vi.fn()}
          onMenuOpenChange={vi.fn()}
        />
      </AppProvider>,
    );
  });

  return {
    root,
    container,
    sendAnnotationsRef,
    handleUserMessage,
    clearComposerAfterSend,
    showToast,
    emitLog,
  };
}

describe('AnnotationOrchestrator annotation send commit behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSessionStore.setState({ annotationsBySessionId: {} });
  });

  afterEach(() => {
    document.body.innerHTML = '';
    useSessionStore.setState({ annotationsBySessionId: {} });
  });

  it('clears annotations after submit invokes the onCommit callback', async () => {
    useSessionStore
      .getState()
      .setAnnotationsForSession('session-1', [createAnnotation()]);
    const rendered = renderOrchestrator();

    await act(async () => {
      await rendered.sendAnnotationsRef.current?.();
      await flushPromises();
    });

    const options = rendered.handleUserMessage.mock.calls[0]?.[3] as
      | HandleUserMessageOptions
      | undefined;
    expect(options?.displayText).toContain('remember this');
    expect(typeof options?.onCommit).toBe('function');
    expect(
      'session-1' in useSessionStore.getState().annotationsBySessionId,
    ).toBe(false);
    expect(rendered.clearComposerAfterSend).toHaveBeenCalledTimes(1);

    act(() => rendered.root.unmount());
    rendered.container.remove();
  });

  it('preserves annotations and surfaces failure when submit rejects before commit', async () => {
    const annotation = createAnnotation();
    useSessionStore
      .getState()
      .setAnnotationsForSession('session-1', [annotation]);
    const rendered = renderOrchestrator({
      handleUserMessage: vi.fn().mockRejectedValue(new Error('send failed')),
    });

    await act(async () => {
      await rendered.sendAnnotationsRef.current?.();
      await flushPromises();
    });

    expect(useSessionStore.getState().annotationsBySessionId['session-1']).toEqual([
      annotation,
    ]);
    expect(rendered.clearComposerAfterSend).toHaveBeenCalledTimes(1);
    expect(rendered.emitLog).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'error',
        message: 'Conversation annotation send failed before commit',
        context: expect.objectContaining({
          sessionId: 'session-1',
          error: 'send failed',
        }),
      }),
    );
    expect(rendered.showToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Couldn't send comments — they're still here",
      }),
    );

    act(() => rendered.root.unmount());
    rendered.container.remove();
  });

  it('preserves annotations when submit resolves without a commit firing', async () => {
    const annotation = createAnnotation();
    useSessionStore
      .getState()
      .setAnnotationsForSession('session-1', [annotation]);
    const rendered = renderOrchestrator({
      handleUserMessage: vi.fn().mockResolvedValue(undefined),
    });

    await act(async () => {
      await rendered.sendAnnotationsRef.current?.();
      await flushPromises();
    });

    expect(useSessionStore.getState().annotationsBySessionId['session-1']).toEqual([
      annotation,
    ]);
    expect(rendered.clearComposerAfterSend).toHaveBeenCalledTimes(1);
    expect(rendered.showToast).not.toHaveBeenCalled();

    act(() => rendered.root.unmount());
    rendered.container.remove();
  });
});
