// @vitest-environment happy-dom
/// <reference types="vitest/globals" />

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentTurnMessage } from '@shared/types';
import type {
  SessionSurfaceActions,
  SessionSurfaceContentProps,
} from '../SessionSurfaceContent';

vi.mock('@renderer/lib/utils', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}));

vi.mock('@renderer/components/AgentSessionPane.module.css', () => ({
  default: new Proxy({}, { get: (_target, prop) => String(prop) }),
}));

vi.mock('@renderer/components/DevProfiler', () => ({
  DevProfiler: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@renderer/components/ui', () => ({
  Button: ({
    children,
    onClick,
    ...props
  }: {
    children?: React.ReactNode;
    onClick?: React.MouseEventHandler<HTMLButtonElement>;
  } & React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" onClick={onClick} {...props}>
      {children}
    </button>
  ),
}));

const paneProbe = vi.hoisted(() => ({
  nextMountId: 0,
}));
const childProbe = vi.hoisted(() => ({
  conversationActionsMenuProps: [] as Array<Record<string, unknown>>,
  interactionStripProps: [] as Array<Record<string, unknown>>,
}));

vi.mock('../ConversationPane', () => ({
  ConversationPane: React.forwardRef((
    props: {
      currentSessionId: string;
      visibleMessages: Array<Pick<AgentTurnMessage, 'id' | 'text'>>;
    },
    ref: React.ForwardedRef<unknown>,
  ) => {
    const mountIdRef = React.useRef(++paneProbe.nextMountId);
    const previousRenderRef = React.useRef({
      sessionId: props.currentSessionId,
      messages: props.visibleMessages,
    });
    const [retainedRows, setRetainedRows] = React.useState<Array<{
      sessionId: string;
      messageId: string;
      text: string;
    }>>([]);

    React.useImperativeHandle(ref, () => ({
      getScrollElement: () => null,
      scrollToBottom: () => {},
      scrollToBottomUntilStable: async () => ({ reason: 'stable', landedAtBottom: true }),
      scrollToIndex: () => {},
    }));

    React.useEffect(() => {
      const previous = previousRenderRef.current;
      if (previous.sessionId !== props.currentSessionId) {
        setRetainedRows((rows) => [
          ...rows,
          ...previous.messages.map((message) => ({
            sessionId: previous.sessionId,
            messageId: message.id,
            text: message.text ?? '',
          })),
        ]);
      }
      previousRenderRef.current = {
        sessionId: props.currentSessionId,
        messages: props.visibleMessages,
      };
    }, [props.currentSessionId, props.visibleMessages]);

    return (
      <section
        data-testid="conversation-pane"
        data-pane-instance-id={String(mountIdRef.current)}
        data-session-id={props.currentSessionId}
      >
        {retainedRows.map((message) => (
          <article
            key={`retained:${message.sessionId}:${message.messageId}`}
            className="agent-turn-message"
            data-retained="true"
            data-session-id={message.sessionId}
            data-message-id={message.messageId}
          >
            {message.text}
          </article>
        ))}
        {props.visibleMessages.map((message) => (
          <article
            key={message.id}
            className="agent-turn-message"
            data-session-id={props.currentSessionId}
            data-message-id={message.id}
          >
            {message.text}
          </article>
        ))}
      </section>
    );
  }),
}));

vi.mock('../ConversationModelSelector', () => ({ ConversationModelSelector: () => null }));
vi.mock('../ConversationProfileLearnedNote', () => ({ ConversationProfileLearnedNote: () => null }));
vi.mock('../ConversationNav', () => ({ ConversationNav: () => null }));
vi.mock('../ConversationActionsMenu', () => ({
  ConversationActionsMenu: (props: Record<string, unknown>) => {
    childProbe.conversationActionsMenuProps.push(props);
    return null;
  },
}));
vi.mock('../ConversationCategoryIndicator', () => ({ ConversationCategoryIndicator: () => null }));
vi.mock('../MoveToFolderPopover', () => ({ MoveToFolderPopover: () => null }));
vi.mock('../ConversationPane.module.css', () => ({
  default: new Proxy({}, { get: (_target, prop) => String(prop) }),
}));
vi.mock('../ApprovalPointerBar', () => ({ ApprovalPointerBar: () => null }));
vi.mock('../SessionCoachingCard', () => ({ SessionCoachingCard: () => null }));
vi.mock('../AnnotationOrchestrator', () => ({ AnnotationOrchestrator: () => null }));
vi.mock('../PinnedFavoritesTabs', () => ({ PinnedFavoritesTabs: () => null }));
vi.mock('../UserQuestionCard', () => ({ UserQuestionCard: () => null }));
vi.mock('../MCPAuthRequiredCard', () => ({ MCPAuthRequiredCard: () => null }));
vi.mock('../MCPBuildCard', () => ({
  MCPBuildCard: () => null,
  buildMcpBuildQuestionBatch: () => null,
}));
vi.mock('../MinimizedQuestionPill', () => ({ MinimizedQuestionPill: () => null }));
vi.mock('../ContextFilteredIndicator', () => ({ ContextFilteredIndicator: () => null }));
vi.mock('../mcpBuildQuestionRouting', () => ({
  routeMcpBuildAnswer: async () => ({ shouldDismiss: false }),
}));
vi.mock('../mcpBuildQuestionVisibility', () => ({
  computePendingMcpBuildQuestionBatch: () => null,
  computeVisibleMcpBuildQuestionBatch: () => null,
}));
vi.mock('../../diagnostics', () => ({ DiagnosticsPanel: () => null }));
vi.mock('../../hooks/useConnectorSetupSuggestions', () => ({
  buildConnectorSetupQuestionBatch: () => null,
}));
vi.mock('../../hooks/useCommunityShare', () => ({
  useCommunityShare: () => null,
}));
vi.mock('../../hooks/useAuthRequiredSignals', () => ({
  useAuthRequiredSignals: () => ({
    cardByMessageIndex: {},
    pendingFooterCard: null,
    startReconnect: vi.fn(),
    cancelReconnect: vi.fn(),
  }),
}));
vi.mock('../../hooks/useMeetingTriggerHeard', () => ({
  useMeetingTriggerHeard: () => ({ state: 'idle' }),
}));
vi.mock('@renderer/hooks/useOnlineStatus', () => ({
  useOnlineStatus: () => true,
}));
vi.mock('@rebel/cloud-client', () => ({
  meetingEventEmitter: { emit: vi.fn() },
}));
vi.mock('@renderer/components/MeetingCompanionBanner', () => ({
  MeetingCompanionBanner: () => null,
}));
vi.mock('@renderer/features/composer/InteractionStrip', () => ({
  InteractionStrip: (props: Record<string, unknown>) => {
    childProbe.interactionStripProps.push(props);
    return null;
  },
}));
vi.mock('@renderer/features/composer/QueuedMessagesTray', () => ({
  QueuedMessagesTray: () => null,
}));
vi.mock('@renderer/features/app-bridge', () => ({
  BrowserContextChip: () => null,
  ExternalContextIndicator: () => null,
  OfficeContextChip: () => null,
  SlackContextChip: () => null,
}));
vi.mock('@renderer/hooks/useExternalContextQueue', () => ({
  useExternalContextForSession: () => null,
}));
vi.mock('../../hooks/useUserQuestions', () => ({
  useUserQuestions: () => ({
    questionBatches: [],
    submitAnswers: vi.fn(),
    dismissBatch: vi.fn(),
    undoDismiss: vi.fn(),
    dismissedBatchIds: new Set<string>(),
    isSubmitting: false,
    submissionError: null,
  }),
}));
vi.mock('../../hooks/useConversationFiles', () => ({
  useConversationFiles: () => [],
}));
vi.mock('../../hooks/useMemoryUpdateStatus', () => ({
  useMemoryUpdateStatus: () => ({ statusByTurn: {} }),
}));
vi.mock('../../store/sessionConflictStore', () => ({
  useSessionConflictStore: (selector: (state: {
    conflictsBySessionId: Record<string, null>;
    dismissConflict: () => void;
  }) => unknown) => selector({ conflictsBySessionId: {}, dismissConflict: vi.fn() }),
}));
vi.mock('../../store/folderStore', () => ({
  useFolders: () => [],
  useFolderActions: () => ({
    moveSessionToFolder: vi.fn(),
    removeSessionFromFolder: vi.fn(),
    createFolder: vi.fn(),
  }),
  useFolderStore: (selector: (state: { membership: Record<string, string> }) => unknown) =>
    selector({ membership: {} }),
  getFolderStoreState: () => ({ membership: {} }),
}));
vi.mock('../../store', () => ({
  getSessionStoreState: () => ({
    sessionSummaries: [],
    setMeetingCompanionCoach: vi.fn(),
    setShowAllChecks: vi.fn(),
  }),
}));
vi.mock('@renderer/features/flow-panels/FlowPanelsProvider', () => ({
  useFlowPanels: () => ({
    activeSurface: 'sessions',
    setActiveSurface: vi.fn(),
  }),
}));
vi.mock('@shared/utils/connectorSetupSignal', () => ({
  buildConnectorSetupKey: () => 'connector-setup-key',
}));
vi.mock('@shared/utils/formatConnectorDisplayName', () => ({
  formatConnectorDisplayName: (name: string) => name,
}));
vi.mock('@rebel/shared', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  COUNCIL_REVIEW_PROMPT: 'Council review prompt',
}));

import { SessionSurfaceContent } from '../SessionSurfaceContent';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeMessage(sessionId: string, index: number): AgentTurnMessage {
  return {
    id: `${sessionId}-message-${index}`,
    turnId: `${sessionId}-turn-${index}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    text: `${sessionId} message ${index}`,
    createdAt: index,
  };
}

function makeActions(): SessionSurfaceActions {
  return {
    handleNewChat: vi.fn(),
    handleOpenHistorySession: vi.fn(),
    handleTogglePinSession: vi.fn(),
    setSelectedTrashedSessionId: vi.fn(),
    restoreSession: vi.fn(),
    openHistorySession: vi.fn().mockResolvedValue(true),
    navigateToConversation: vi.fn().mockResolvedValue(true),
    handleBeginEditMessage: vi.fn(),
    handleRetryMessage: vi.fn(),
    handleSelectInlineStep: vi.fn(),
    focusTurn: vi.fn(),
    resolveTurnIdForMessage: (message) => message.turnId ?? null,
    handleOpenDocumentInPreview: vi.fn(),
    handleOpenWorkspaceFolder: vi.fn(),
    handleOpenConversationReference: vi.fn(),
    handleNavigateFromChat: vi.fn(),
    handleOpenTutorial: vi.fn(),
    handleCopyToClipboard: vi.fn(),
    handleOpenInLibrary: vi.fn(),
    handleSelectUseCase: vi.fn(),
    startRename: vi.fn(),
    handleSoftDeleteSession: vi.fn(),
    handleFindSimilar: vi.fn(),
    handleToggleStarSession: vi.fn(),
    handleCopyMarkdown: vi.fn(),
    handleExportMarkdown: vi.fn(),
    handleCopyConversationLink: vi.fn(),
    handleShareConversation: vi.fn(),
    handleRevealInSidebar: vi.fn(),
    handleStartDiagnose: vi.fn(),
    handleExportLogs: vi.fn(),
    showToast: vi.fn(),
    submitQueuedMessage: vi.fn().mockResolvedValue(undefined),
    handleSelectionMenuReply: vi.fn(),
    handleSelectionMenuReplyInNewChat: vi.fn(),
    handleGenericAddComment: vi.fn(),
    handleSelectionMenuOpenChange: vi.fn(),
    setIsAnnotationActive: vi.fn(),
    clearComposerAfterSend: vi.fn(),
    prepareMentionAttachments: vi.fn().mockResolvedValue([]),
    prepareConversationAttachments: vi.fn().mockResolvedValue([]),
    handleToggleTranscription: vi.fn(),
    handleStopAndSend: vi.fn(),
    handleToggleAutoSpeak: vi.fn(),
    setPrivateMode: vi.fn(),
    setCouncilMode: vi.fn(),
    requestCouncilReview: vi.fn(),
    handleToggleAutoDone: vi.fn(),
    handleMarkDoneNow: vi.fn(),
    stopActiveTurn: vi.fn(),
    handleShowSettingsSurface: vi.fn(),
    handleNavigateToVoiceSettings: vi.fn(),
    emitLog: vi.fn(),
    approveAndRetry: vi.fn(),
    dismiss: vi.fn(),
    approveAllAndRetry: vi.fn(),
    dismissAll: vi.fn(),
    handleTrustToolAlways: vi.fn(),
    executeStagedTool: vi.fn().mockResolvedValue(undefined),
    rejectStagedTool: vi.fn(),
    executeAllStagedTools: vi.fn().mockResolvedValue(undefined),
    rejectAllStagedTools: vi.fn(),
    publishStagedFile: vi.fn().mockResolvedValue({ success: true }),
    discardStagedFile: vi.fn().mockResolvedValue({ success: true }),
    keepStagedFilePrivate: vi.fn().mockResolvedValue({ success: true }),
    saveMemory: vi.fn(),
    skipMemory: vi.fn(),
    saveAllMemory: vi.fn(),
    skipAllMemory: vi.fn(),
    openNotificationsForSession: vi.fn(),
    sendMessageToSession: vi.fn().mockResolvedValue(undefined),
    removeFromQueue: vi.fn(),
    clearQueueForSession: vi.fn(),
    sendQueuedMessageNow: vi.fn(),
    handleUserMessage: vi.fn(),
    updateCoachingState: vi.fn().mockResolvedValue(undefined),
    setCoachingSessionIds: vi.fn(),
    composeSharePost: vi.fn().mockResolvedValue(null),
    openDiscourseShare: vi.fn().mockResolvedValue(undefined),
    dismissShare: vi.fn().mockResolvedValue(undefined),
    optOutSharing: vi.fn().mockResolvedValue(undefined),
    handleTryWhatsNewFeature: vi.fn(),
  };
}

function makeProps(
  overrides: Partial<SessionSurfaceContentProps> = {},
): SessionSurfaceContentProps {
  const sessionId = overrides.currentSessionId ?? 'session-A';
  const visibleMessages = overrides.visibleMessages ?? [
    makeMessage(sessionId, 1),
    makeMessage(sessionId, 2),
  ];
  const actionsRef: React.RefObject<SessionSurfaceActions> = { current: makeActions() };
  return {
    actionsRef,
    currentSessionId: sessionId,
    currentSessionTitle: sessionId,
    currentSessionStarredAt: null,
    currentSessionDoneAt: null,
    visibleMessages,
    eventsByTurn: {},
    messages: visibleMessages,
    turnSummaries: [],
    visibleTurnId: visibleMessages[0]?.turnId ?? '',
    focusedTurnId: null,
    processingTurnId: null,
    editingMessageId: null,
    turnStepContextByTurn: {},
    subAgentTimelineByTurn: new Map(),
    activeStepByTurn: {},
    compactionBoundaries: undefined,
    isBusy: false,
    isStopping: false,
    isSettling: false,
    isRevealMasked: false,
    isTextMode: false,
    isInsightSurface: false,
    isDiagnosticsSurface: false,
    onToggleDiagnostics: vi.fn(),
    thinkingHeadline: '',
    thinkingElapsedLabel: '',
    isScrolledAway: false,
    newMessageCount: 0,
    isAnswerTopPinned: false,
    onJumpToLatest: vi.fn(),
    selectedTrashedSessionId: null,
    flowHistoryOpen: false,
    mcpBuildCardState: null,
    onMcpBuildCardActions: undefined,
    onMcpBuildClearGithubCheck: undefined,
    enableContributionRelay: true,
    isOssBuild: false,
    connectorSetupFooterCard: null,
    onConnectorSetUp: vi.fn(),
    onConnectorSaveForLater: vi.fn(),
    onConnectorMarkAnswered: vi.fn(),
    chromeMode: 'normal',
    isOnboardingCoachActive: false,
    isDocumentPreviewOpen: false,
    currentSessionMeetingCompanion: null,
    meetingStatus: {
      state: 'no_meetings',
      captionsActive: false,
      presenceMode: 'silent',
    },
    pinnedFavorites: [],
    personalizedUseCases: undefined,
    coreDirectory: null,
    inboundAuthorPolicyMode: 'ownerOnly',
    voiceProviderLabel: undefined,
    sttKeyMissing: false,
    ttsKeyMissing: false,
    localModelMissing: false,
    localModelDownloading: false,
    ttsUnavailable: false,
    modelInfo: undefined,
    onNavigateToModelSettings: vi.fn(),
    composerRef: React.createRef() as SessionSurfaceContentProps['composerRef'],
    composerProps: {} as SessionSurfaceContentProps['composerProps'],
    agentSessionLogRef: React.createRef() as SessionSurfaceContentProps['agentSessionLogRef'],
    isTranscribing: false,
    isTranscribeProcessing: false,
    transcriptionAudioLevel: 0,
    autoSpeak: false,
    privateMode: false,
    councilMode: false,
    councilModeAvailable: false,
    councilModeDisabledTooltip: undefined,
    autoDoneEnabled: false,
    finishLine: null,
    setFinishLine: vi.fn(),
    isEditingFinishLine: false,
    onToggleEditFinishLine: vi.fn(),
    deniedOperations: [],
    stagedToolCalls: [],
    currentSessionStagedFiles: [],
    memoryApprovalRequests: [],
    isExecutingStagedTools: false,
    currentSessionQueue: [],
    sessionCoaching: null,
    ...overrides,
  };
}

function renderSurface(props: SessionSurfaceContentProps): {
  container: HTMLElement;
  root: Root;
  rerender: (nextProps: SessionSurfaceContentProps) => void;
  unmount: () => void;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  act(() => {
    root.render(<SessionSurfaceContent {...props} />);
  });

  return {
    container,
    root,
    rerender: (nextProps) => {
      act(() => {
        root.render(<SessionSurfaceContent {...nextProps} />);
      });
    },
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

describe('SessionSurfaceContent — ConversationPane session remount', () => {
  beforeEach(() => {
    paneProbe.nextMountId = 0;
    childProbe.conversationActionsMenuProps = [];
    childProbe.interactionStripProps = [];
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.clearAllMocks();
  });

  it('remounts the pane on session switch so prior session message DOM is not live-reachable', () => {
    const sessionAMessages = [makeMessage('session-A', 1), makeMessage('session-A', 2)];
    const sessionBMessages = [makeMessage('session-B', 1), makeMessage('session-B', 2)];
    const actionsRef: React.RefObject<SessionSurfaceActions> = { current: makeActions() };
    const agentSessionLogRef = React.createRef() as SessionSurfaceContentProps['agentSessionLogRef'];
    const composerRef = React.createRef() as SessionSurfaceContentProps['composerRef'];
    const initialProps = makeProps({
      actionsRef,
      agentSessionLogRef,
      composerRef,
      currentSessionId: 'session-A',
      currentSessionTitle: 'Session A',
      visibleMessages: sessionAMessages,
      messages: sessionAMessages,
      visibleTurnId: 'session-A-turn-1',
    });
    const nextProps = makeProps({
      ...initialProps,
      currentSessionId: 'session-B',
      currentSessionTitle: 'Session B',
      visibleMessages: sessionBMessages,
      messages: sessionBMessages,
      visibleTurnId: 'session-B-turn-1',
    });
    const { container, rerender, unmount } = renderSurface(initialProps);

    const firstPane = container.querySelector<HTMLElement>('[data-testid="conversation-pane"]');
    const firstSessionMessage = container.querySelector<HTMLElement>(
      'article.agent-turn-message[data-session-id="session-A"]',
    );
    expect(firstPane).toBeTruthy();
    expect(firstSessionMessage).toBeTruthy();
    const firstInstanceId = firstPane?.dataset.paneInstanceId;

    rerender(nextProps);

    const secondPane = container.querySelector<HTMLElement>('[data-testid="conversation-pane"]');
    expect(secondPane).toBeTruthy();
    expect(secondPane).not.toBe(firstPane);
    expect(secondPane?.dataset.paneInstanceId).not.toBe(firstInstanceId);
    expect(secondPane?.dataset.sessionId).toBe('session-B');

    expect(document.body.contains(firstSessionMessage)).toBe(false);
    expect(
      container.querySelector('article.agent-turn-message[data-session-id="session-A"]'),
    ).toBeNull();
    expect(
      container.querySelectorAll('article.agent-turn-message[data-session-id="session-B"]'),
    ).toHaveLength(sessionBMessages.length);

    unmount();
  });

  it('omits current-session lifecycle actions for background sessions', () => {
    const actions = makeActions();
    const props = makeProps({
      actionsRef: { current: actions },
      currentSessionId: 'automation-source-capture--current',
      currentSessionTitle: 'Source Capture',
      autoDoneEnabled: true,
    });

    const { unmount } = renderSurface(props);
    const actionsMenuProps = childProbe.conversationActionsMenuProps.at(-1);
    const interactionStripProps = childProbe.interactionStripProps.at(-1);

    expect(actionsMenuProps?.onTogglePin).toBeUndefined();
    expect(actionsMenuProps?.onToggleStar).toEqual(expect.any(Function));
    expect(interactionStripProps?.onToggleAutoDone).toBeUndefined();
    expect(interactionStripProps?.onMarkDoneNow).toBeUndefined();
    expect(interactionStripProps?.autoDoneEnabled).toBe(false);

    unmount();
  });

  it('keeps current-session lifecycle actions for normal conversations', () => {
    const actions = makeActions();
    const props = makeProps({
      actionsRef: { current: actions },
      currentSessionId: 'conversation-current',
      currentSessionTitle: 'Normal conversation',
      autoDoneEnabled: true,
    });

    const { unmount } = renderSurface(props);
    const actionsMenuProps = childProbe.conversationActionsMenuProps.at(-1);
    const interactionStripProps = childProbe.interactionStripProps.at(-1);

    expect(actionsMenuProps?.onTogglePin).toBe(actions.handleTogglePinSession);
    expect(actionsMenuProps?.onToggleStar).toEqual(expect.any(Function));
    expect(interactionStripProps?.onToggleAutoDone).toBe(actions.handleToggleAutoDone);
    expect(interactionStripProps?.onMarkDoneNow).toBe(actions.handleMarkDoneNow);
    expect(interactionStripProps?.autoDoneEnabled).toBe(true);

    unmount();
  });
});
