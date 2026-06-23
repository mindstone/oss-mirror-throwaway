// @vitest-environment happy-dom
 
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { createRef } from 'react';
import type { AgentComposerProps } from '../AgentComposer';
import type { ComposerHandle, ComposerWithStateProps } from '../ComposerWithState';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ReactDOMClient = require('react-dom/client');
const { act: reactAct } = require('react');

const mocks = vi.hoisted(() => ({
  latestAgentComposerProps: null as unknown,
  sessionStoreState: {
    draftsBySessionId: {} as Record<string, { text: string; updatedAt: number }>,
    setDraftForSession: vi.fn(),
  },
  clearDraft: vi.fn(),
  clearAttachments: vi.fn(),
  scheduler: {
    schedule: vi.fn(),
    cancel: vi.fn(),
    flushDeferred: vi.fn(),
  },
}));

vi.mock('@renderer/features/agent-session/store', () => ({
  getSessionStoreState: () => mocks.sessionStoreState,
}));

vi.mock('../AgentComposer', () => ({
  AgentComposer: (props: unknown) => {
    mocks.latestAgentComposerProps = props;
    return React.createElement('div', { 'data-testid': 'mock-agent-composer' });
  },
}));

vi.mock('../hooks/useFileAttachments', () => ({
  useFileAttachments: () => ({
    attachments: [],
    addFromClipboard: vi.fn().mockResolvedValue(undefined),
    addFromFileList: vi.fn().mockResolvedValue(undefined),
    addImageAttachment: vi.fn().mockReturnValue(false),
    removeAttachment: vi.fn(),
    clearAttachments: mocks.clearAttachments,
    canAddMore: true,
    isDragging: false,
    handleDragEnter: vi.fn(),
    handleDragLeave: vi.fn(),
    handleDragOver: vi.fn(),
    handleDrop: vi.fn(),
  }),
}));

vi.mock('../hooks/useMentionAutocomplete', () => ({
  useMentionAutocomplete: () => ({
    mentionState: {
      active: false,
      query: '',
      results: [],
      selectedIndex: 0,
      triggerIndex: null,
    },
    updateMentionContext: vi.fn(),
    insertMentionResult: vi.fn(),
    navigateMentionUp: vi.fn(),
    navigateMentionDown: vi.fn(),
    selectCurrentMention: vi.fn(),
    clearMentionState: vi.fn(),
    setSelectedIndex: vi.fn(),
    setManualFilter: vi.fn(),
  }),
  findMentionTrigger: () => null,
  isCaretOnMentionChip: () => false,
}));

vi.mock('../hooks/useDraftPersistence', () => ({
  useDraftPersistence: () => ({
    clearDraft: mocks.clearDraft,
  }),
}));

vi.mock('../featureFlags', () => ({
  isComposerFlagEnabled: () => false,
}));

vi.mock('../utils/mentionContextScheduler', () => ({
  createMentionContextScheduler: () => mocks.scheduler,
}));

import { ComposerWithState } from '../ComposerWithState';

function buildProps(overrides: Partial<ComposerWithStateProps> = {}): ComposerWithStateProps {
  return {
    sessionId: 'session-1',
    isEditing: false,
    isBusy: false,
    isStopping: false,
    isTextPending: false,
    isPreparingMentionContext: false,
    processingTurnId: null,
    hasWorkspace: false,
    hasConversations: false,
    mentionResultsForQuery: () => [],
    ensureLibraryIndex: vi.fn(),
    getRelativeLibraryPath: (path) => path,
    resolveMentionedFiles: () => [],
    onSubmit: vi.fn(),
    onStopActiveTurn: vi.fn(),
    onKeyDown: vi.fn(),
    showToast: vi.fn(),
    isTranscribing: false,
    isTranscribeProcessing: false,
    onToggleTranscription: vi.fn(),
    coreDirectory: null,
    libraryIndex: null,
    libraryIndexLoading: false,
    libraryIndexError: null,
    refreshLibraryIndex: vi.fn().mockResolvedValue(undefined),
    agentSessionsCount: 0,
    ...overrides,
  };
}

function renderComposer(
  props: ComposerWithStateProps,
  ref: React.RefObject<ComposerHandle | null>,
): { unmount: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = ReactDOMClient.createRoot(container);

  reactAct(() => {
    root.render(React.createElement(ComposerWithState, { ...props, ref }));
  });

  return {
    unmount: () => {
      reactAct(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

describe('ComposerWithState.flushDraft', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.latestAgentComposerProps = null;
    mocks.sessionStoreState.draftsBySessionId = {};
    mocks.sessionStoreState.setDraftForSession.mockReset();
    mocks.clearDraft.mockReset();
    mocks.clearAttachments.mockReset();
    mocks.scheduler.schedule.mockReset();
    mocks.scheduler.cancel.mockReset();
    mocks.scheduler.flushDeferred.mockReset();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('flushes the pending debounced draft write immediately and stays idempotent', () => {
    const composerRef = createRef<ComposerHandle>();
    const { unmount } = renderComposer(buildProps(), composerRef);
    const agentComposerProps = mocks.latestAgentComposerProps as AgentComposerProps | null;

    expect(agentComposerProps).not.toBeNull();
    if (!agentComposerProps) {
      throw new Error('Expected AgentComposer props to be captured');
    }

    reactAct(() => {
      agentComposerProps.onChangeValue?.('draft typed quickly', 'draft typed quickly'.length);
    });

    expect(mocks.sessionStoreState.setDraftForSession).not.toHaveBeenCalled();

    reactAct(() => {
      composerRef.current?.flushDraft();
    });

    expect(mocks.sessionStoreState.setDraftForSession).toHaveBeenCalledTimes(1);
    expect(mocks.sessionStoreState.setDraftForSession).toHaveBeenLastCalledWith(
      'session-1',
      'draft typed quickly',
    );

    reactAct(() => {
      composerRef.current?.flushDraft();
      vi.advanceTimersByTime(1000);
    });

    expect(mocks.sessionStoreState.setDraftForSession).toHaveBeenCalledTimes(1);

    unmount();
    expect(() => composerRef.current?.flushDraft()).not.toThrow();
  });
});
