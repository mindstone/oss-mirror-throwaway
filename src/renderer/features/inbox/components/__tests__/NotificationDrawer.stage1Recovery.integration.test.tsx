// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotificationDrawer } from '../NotificationDrawer';

vi.mock('@renderer/hooks/useAppNavigation', () => ({
  useAppNavigationSafe: () => ({ navigate: vi.fn() }),
}));

vi.mock('@renderer/features/agent-session/store/sessionStore', async () => {
  const actual = await vi.importActual<typeof import('@renderer/features/agent-session/store/sessionStore')>(
    '@renderer/features/agent-session/store/sessionStore',
  );
  const emptyState = {
    sessionSummaries: [
      { id: 'session-1', deletedAt: null },
      { id: 'session-live', deletedAt: null },
      { id: 'session-staged', deletedAt: null },
      { id: 'session-msg', deletedAt: null },
    ],
    currentSessionId: null,
    currentSessionTitle: '',
    currentSessionOrigin: undefined,
    eventsByTurnVersion: 0,
    loadedSessions: new Map(),
    pendingQuestionEventsBySessionId: {},
    dismissedQuestionBatchIdsBySessionId: {},
  };
  return {
    ...actual,
    useSessionStore: (selector: (state: typeof emptyState) => unknown) => selector(emptyState),
    getSessionStoreState: () => ({
      ...emptyState,
      setFocusedTurnId: vi.fn(),
    }),
    getCurrentSessionEvents: () => ({}),
  };
});

vi.mock('@renderer/components/ui', async () => {
  const actual = await vi.importActual<typeof import('@renderer/components/ui')>('@renderer/components/ui');
  return {
    ...actual,
    useToast: () => ({ showToast: vi.fn() }),
  };
});

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type MemoryApprovalRequestListener = (payload: Record<string, unknown>) => void;
type GenericListener = (...args: unknown[]) => void;

interface TestHarnessApis {
  emitMemoryApprovalRequest: (payload: Record<string, unknown>) => Promise<void>;
  getPendingApprovalsMock: ReturnType<typeof vi.fn>;
  getStagedContentMock: ReturnType<typeof vi.fn>;
  pendingMemoryApprovals: Array<Record<string, unknown>>;
  pendingToolApprovals: Array<Record<string, unknown>>;
  stagedFiles: Array<Record<string, unknown>>;
}

function installWindowApis(): TestHarnessApis {
  const onMemoryWriteApprovalRequestListeners: MemoryApprovalRequestListener[] = [];
  const onToolSafetyApprovalRequestListeners: GenericListener[] = [];
  const onMemoryWriteApprovalResolvedListeners: GenericListener[] = [];
  const onToolSafetyApprovalResolvedListeners: GenericListener[] = [];
  const onStagedToolCallListeners: GenericListener[] = [];
  const onStagedToolCallUpdatedListeners: GenericListener[] = [];
  const onStagedFilesChangedListeners: GenericListener[] = [];
  const onSkillChangeNotificationsChangedListeners: GenericListener[] = [];

  let pendingMemoryApprovals: Array<Record<string, unknown>> = [];
  let pendingToolApprovals: Array<Record<string, unknown>> = [];
  let stagedFiles: Array<Record<string, unknown>> = [];

  const getPendingApprovalsMock = vi.fn(async () => pendingMemoryApprovals);
  const getStagedContentMock = vi.fn(async () => 'staged live content');

  Object.defineProperty(window, 'memoryApi', {
    configurable: true,
    value: {
      getPendingApprovals: getPendingApprovalsMock,
    },
  });

  Object.defineProperty(window, 'safetyApi', {
    configurable: true,
    value: {
      pending: vi.fn(async () => pendingToolApprovals),
      stagedGetAll: vi.fn(async () => []),
    },
  });

  Object.defineProperty(window, 'sessionsApi', {
    configurable: true,
    value: {
      list: vi.fn(async () => []),
    },
  });
  Object.defineProperty(window, 'libraryApi', {
    configurable: true,
    value: {
      listSkillChangeNotifications: vi.fn(async () => []),
      dismissSkillChangeNotification: vi.fn(async () => ({ success: true })),
    },
  });

  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      onMemoryWriteApprovalRequest: (listener: MemoryApprovalRequestListener) => {
        onMemoryWriteApprovalRequestListeners.push(listener);
        return () => {
          const idx = onMemoryWriteApprovalRequestListeners.indexOf(listener);
          if (idx >= 0) onMemoryWriteApprovalRequestListeners.splice(idx, 1);
        };
      },
      onToolSafetyApprovalRequest: (listener: GenericListener) => {
        onToolSafetyApprovalRequestListeners.push(listener);
        return () => {
          const idx = onToolSafetyApprovalRequestListeners.indexOf(listener);
          if (idx >= 0) onToolSafetyApprovalRequestListeners.splice(idx, 1);
        };
      },
      onMemoryWriteApprovalResolved: (listener: GenericListener) => {
        onMemoryWriteApprovalResolvedListeners.push(listener);
        return () => {
          const idx = onMemoryWriteApprovalResolvedListeners.indexOf(listener);
          if (idx >= 0) onMemoryWriteApprovalResolvedListeners.splice(idx, 1);
        };
      },
      onToolSafetyApprovalResolved: (listener: GenericListener) => {
        onToolSafetyApprovalResolvedListeners.push(listener);
        return () => {
          const idx = onToolSafetyApprovalResolvedListeners.indexOf(listener);
          if (idx >= 0) onToolSafetyApprovalResolvedListeners.splice(idx, 1);
        };
      },
      onStagedToolCall: (listener: GenericListener) => {
        onStagedToolCallListeners.push(listener);
        return () => {
          const idx = onStagedToolCallListeners.indexOf(listener);
          if (idx >= 0) onStagedToolCallListeners.splice(idx, 1);
        };
      },
      onStagedToolCallUpdated: (listener: GenericListener) => {
        onStagedToolCallUpdatedListeners.push(listener);
        return () => {
          const idx = onStagedToolCallUpdatedListeners.indexOf(listener);
          if (idx >= 0) onStagedToolCallUpdatedListeners.splice(idx, 1);
        };
      },
      onStagedFilesChanged: (listener: GenericListener) => {
        onStagedFilesChangedListeners.push(listener);
        return () => {
          const idx = onStagedFilesChangedListeners.indexOf(listener);
          if (idx >= 0) onStagedFilesChangedListeners.splice(idx, 1);
        };
      },
      onSkillChangeNotificationsChanged: (listener: GenericListener) => {
        onSkillChangeNotificationsChangedListeners.push(listener);
        return () => {
          const idx = onSkillChangeNotificationsChangedListeners.indexOf(listener);
          if (idx >= 0) onSkillChangeNotificationsChangedListeners.splice(idx, 1);
        };
      },
      getStagedFiles: vi.fn(async () => ({ files: stagedFiles })),
      getStagedContent: getStagedContentMock,
      readWorkspaceFile: vi.fn(async () => ({ content: '' })),
      publishStagedFile: vi.fn(async () => ({ status: 'success' })),
      discardStagedFile: vi.fn(async () => ({ status: 'success' })),
      keepStagedFilePrivate: vi.fn(async () => ({ status: 'success' })),
      resolveStagedConflict: vi.fn(async () => ({ status: 'success' })),
      stagedFilePublishAll: vi.fn(async () => ({ published: 0, conflicts: 0, errors: 0 })),
      discardAllStagedFiles: vi.fn(async () => ({ success: true })),
    },
  });

  return {
    emitMemoryApprovalRequest: async (payload) => {
      await act(async () => {
        for (const listener of onMemoryWriteApprovalRequestListeners) {
          listener(payload);
        }
      });
    },
    getPendingApprovalsMock,
    getStagedContentMock,
    get pendingMemoryApprovals() {
      return pendingMemoryApprovals;
    },
    set pendingMemoryApprovals(value: Array<Record<string, unknown>>) {
      pendingMemoryApprovals = value;
    },
    get pendingToolApprovals() {
      return pendingToolApprovals;
    },
    set pendingToolApprovals(value: Array<Record<string, unknown>>) {
      pendingToolApprovals = value;
    },
    get stagedFiles() {
      return stagedFiles;
    },
    set stagedFiles(value: Array<Record<string, unknown>>) {
      stagedFiles = value;
    },
  } as TestHarnessApis;
}

async function flushAsync(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function renderDrawer(): Promise<{ cleanup: () => void }> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);

  await act(async () => {
    root.render(<NotificationDrawer onClose={vi.fn()} />);
  });
  await flushAsync();
  await flushAsync();

  await act(async () => {
    const groupToggles = Array.from(
      document.body.querySelectorAll('.notification-drawer__group-toggle'),
    ) as HTMLButtonElement[];
    for (const toggle of groupToggles) {
      if (toggle.getAttribute('aria-expanded') !== 'true') {
        toggle.click();
      }
    }
  });

  return {
    cleanup: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

async function clickPreviewControl(): Promise<void> {
  const previewControl = document.body.querySelector('[data-testid="drawer-card-preview-badge"]')
    ?? document.body.querySelector('[data-testid="drawer-card-file-row"]');
  if (!(previewControl instanceof HTMLButtonElement)) {
    throw new Error('Missing preview control');
  }
  await act(async () => {
    previewControl.click();
  });
  await flushAsync();
}

describe('NotificationDrawer Stage 1 reveal recovery integration', () => {
  let apis: ReturnType<typeof installWindowApis>;

  beforeEach(() => {
    vi.clearAllMocks();
    apis = installWindowApis();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('reveals persisted withheld memory content via ActionPreviewDialog', async () => {
    apis.pendingMemoryApprovals = [{
      toolUseId: 'mem-withheld-1',
      originalTurnId: 'turn-1',
      originalSessionId: 'session-1',
      turnId: 'turn-1',
      sessionId: 'session-1',
      filePath: '/memory/chief/260529_1430_meeting_summary.md',
      spaceName: 'Chief',
      summary: 'Captured summary',
      content: 'Recovered persisted secret',
      timestamp: Date.now(),
      sensitivityReason: 'Detected credentials',
      isNewFile: true,
    }];

    const rendered = await renderDrawer();
    await clickPreviewControl();

    const dialog = document.body.querySelector('[data-testid="action-preview-dialog"]');
    const revealed = document.body.querySelector('[data-testid="action-preview-revealed-content"]');
    expect(dialog).not.toBeNull();
    expect(revealed?.textContent).toContain('Recovered persisted secret');
    expect(dialog?.textContent).not.toContain('Content hidden for privacy');

    rendered.cleanup();
  });

  it('recovers broadcast-first memory content locally and keeps broadcast payload content-free', async () => {
    const broadcastPayload = {
      toolUseId: 'mem-broadcast-1',
      originalSessionId: 'session-live',
      summary: 'Captured summary',
      timestamp: Date.now(),
      sensitivityReason: 'Detected credentials',
      destination: {
        path: '/memory/chief/260530_0900_live_capture.md',
        spaceName: 'Chief',
        spacePath: '/memory/chief/260530_0900_live_capture.md',
        sharing: 'private',
        isNew: true,
      },
    } as const;
    expect('content' in broadcastPayload).toBe(false);

    apis.pendingMemoryApprovals = [{
      toolUseId: 'mem-broadcast-1',
      originalTurnId: 'turn-live',
      originalSessionId: 'session-live',
      turnId: 'turn-live',
      sessionId: 'session-live',
      filePath: '/memory/chief/260530_0900_live_capture.md',
      spaceName: 'Chief',
      summary: 'Captured summary',
      content: 'Recovered after broadcast',
      timestamp: Date.now(),
      sensitivityReason: 'Detected credentials',
      isNewFile: true,
    }];

    const rendered = await renderDrawer();
    await apis.emitMemoryApprovalRequest(broadcastPayload as unknown as Record<string, unknown>);
    await flushAsync();

    await clickPreviewControl();

    const revealed = document.body.querySelector('[data-testid="action-preview-revealed-content"]');
    expect(revealed?.textContent).toContain('Recovered after broadcast');
    expect(apis.getPendingApprovalsMock).toHaveBeenCalled();

    rendered.cleanup();
  });

  it('fails closed when only filePath is available for recovery identity', async () => {
    const rendered = await renderDrawer();
    await apis.emitMemoryApprovalRequest({
      toolUseId: 'mem-filepath-only',
      originalSessionId: '',
      summary: 'Captured summary',
      timestamp: Date.now(),
      sensitivityReason: 'Detected credentials',
      destination: {
        path: '/memory/chief/260531_1200_shared_path.md',
        spaceName: 'Chief',
        spacePath: '/memory/chief/260531_1200_shared_path.md',
        sharing: 'private',
        isNew: true,
      },
    });
    await flushAsync();

    // Persisted-store row appears later with the same file path + toolUseId but no
    // originalSessionId/approvalIdentifier. Recovery must fail closed rather than
    // using filePath as the second key.
    apis.pendingMemoryApprovals = [{
      toolUseId: 'mem-filepath-only',
      originalTurnId: 'turn-filepath-only',
      originalSessionId: '',
      turnId: 'turn-filepath-only',
      sessionId: '',
      filePath: '/memory/chief/260531_1200_shared_path.md',
      spaceName: 'Chief',
      summary: 'Captured summary',
      content: 'should-not-be-revealed-via-filepath-only',
      timestamp: Date.now(),
      sensitivityReason: 'Detected credentials',
      isNewFile: true,
    }];

    const callsBeforeReview = apis.getPendingApprovalsMock.mock.calls.length;
    await clickPreviewControl();

    const recoveryError = document.body.querySelector('[data-testid="action-preview-recovery-error"]');
    expect(recoveryError?.textContent).toContain('Could not recover memory approval content');
    expect(document.body.querySelector('[data-testid="action-preview-recovery-retry-button"]')).not.toBeNull();
    expect(document.body.textContent).not.toContain('should-not-be-revealed-via-filepath-only');
    expect(apis.getPendingApprovalsMock.mock.calls.length).toBe(callsBeforeReview);

    rendered.cleanup();
  });

  it('shows recovery error + Retry when no persisted approval matches the selected identity', async () => {
    apis.pendingMemoryApprovals = [{
      toolUseId: 'mem-missing-identity',
      originalTurnId: 'turn-live',
      originalSessionId: 'session-live',
      turnId: 'turn-live',
      sessionId: 'session-live',
      filePath: '/memory/chief/260530_0930_live_capture.md',
      spaceName: 'Chief',
      summary: 'Captured summary',
      content: '',
      timestamp: Date.now(),
      sensitivityReason: 'Detected credentials',
      isNewFile: true,
    }];

    const rendered = await renderDrawer();

    // Simulate a stale/local recovery miss after the card is already rendered:
    // the recovery callback must return null and show an explicit retryable error.
    apis.pendingMemoryApprovals = [{
      toolUseId: 'mem-missing-identity',
      originalTurnId: 'turn-other',
      originalSessionId: 'different-session',
      turnId: 'turn-other',
      sessionId: 'different-session',
      filePath: '/memory/chief/260530_0930_live_capture.md',
      spaceName: 'Chief',
      summary: 'Wrong identity',
      content: 'wrong persisted secret',
      timestamp: Date.now(),
      sensitivityReason: 'Detected credentials',
      isNewFile: true,
    }];

    await clickPreviewControl();

    const recoveryError = document.body.querySelector('[data-testid="action-preview-recovery-error"]');
    expect(recoveryError?.textContent).toContain('Could not recover memory approval content');
    expect(document.body.querySelector('[data-testid="action-preview-recovery-retry-button"]')).not.toBeNull();
    expect(document.body.textContent).not.toContain('wrong persisted secret');
    expect(document.body.textContent).not.toContain('(No content)');

    rendered.cleanup();
  });

  it('shows recovery error + Retry when multiple persisted approvals match the identity', async () => {
    apis.pendingMemoryApprovals = [
      {
        toolUseId: 'mem-duplicate-identity',
        originalTurnId: 'turn-1',
        originalSessionId: 'session-1',
        turnId: 'turn-1',
        sessionId: 'session-1',
        filePath: '/memory/chief/260531_1100_duplicate_capture.md',
        spaceName: 'Chief',
        summary: 'Captured summary',
        content: '',
        timestamp: Date.now(),
        sensitivityReason: 'Detected credentials',
        isNewFile: true,
      },
      {
        toolUseId: 'mem-duplicate-identity',
        originalTurnId: 'turn-1',
        originalSessionId: 'session-1',
        turnId: 'turn-1',
        sessionId: 'session-1',
        filePath: '/memory/chief/260531_1100_duplicate_capture.md',
        spaceName: 'Chief',
        summary: 'Duplicate summary',
        content: 'ambiguous persisted secret',
        timestamp: Date.now(),
        sensitivityReason: 'Detected credentials',
        isNewFile: true,
      },
    ];

    const rendered = await renderDrawer();
    await clickPreviewControl();

    const recoveryError = document.body.querySelector('[data-testid="action-preview-recovery-error"]');
    expect(recoveryError?.textContent).toContain('Could not recover memory approval content');
    expect(document.body.querySelector('[data-testid="action-preview-recovery-retry-button"]')).not.toBeNull();
    expect(document.body.textContent).not.toContain('ambiguous persisted secret');
    expect(document.body.textContent).not.toContain('(No content)');

    rendered.cleanup();
  });

  it('keeps staged-file review live-read behavior for source-capture approvals', async () => {
    apis.stagedFiles = [{
      id: 'staged-live-1',
      realPath: '/memory/chief/260531_1000_capture.md',
      spaceName: 'Chief',
      spacePath: '/memory/chief/260531_1000_capture.md',
      sessionId: 'session-staged',
      baseHash: 'new-file',
      summary: 'Captured source notes',
      stagedAt: Date.now(),
      sensitivity: 'high',
      sharing: 'private',
      hasConflict: false,
    }];
    apis.getStagedContentMock.mockResolvedValue('staged live content');

    const rendered = await renderDrawer();
    await clickPreviewControl();
    await flushAsync();
    await flushAsync();

    const revealed = document.body.querySelector('[data-testid="action-preview-revealed-content"]');
    if (revealed) {
      expect(revealed.textContent).toContain('staged live content');
    }
    expect(apis.getStagedContentMock).toHaveBeenCalledWith('staged-live-1');

    rendered.cleanup();
  });

  it('keeps tool/message review rendering unchanged', async () => {
    apis.pendingToolApprovals = [{
      toolUseID: 'tool-msg-1',
      turnId: 'turn-msg-1',
      sessionId: 'session-msg',
      toolName: 'post_slack_message',
      input: {
        args: {
          channel: '#ops',
          text: 'Ship update',
        },
      },
      reason: 'Safety Rules blocked: outbound message requires review.',
      timestamp: Date.now(),
      packageName: 'slack',
    }];

    const rendered = await renderDrawer();
    await clickPreviewControl();

    expect(document.body.querySelector('[data-testid="action-preview-dialog"]')).not.toBeNull();
    expect(document.body.querySelector('[data-testid="message-preview"]')).not.toBeNull();

    rendered.cleanup();
  });
});
