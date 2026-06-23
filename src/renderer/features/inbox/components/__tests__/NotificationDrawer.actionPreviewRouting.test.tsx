// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PendingApprovalItem } from '../../hooks/usePendingApprovals';
import type { StagedFileItem } from '../../hooks/useStagedFiles';
import { NotificationDrawer } from '../NotificationDrawer';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const {
  pendingApprovalsState,
  stagedFilesState,
  stagedGetAllMock,
  approveToolApprovalMock,
  dismissApprovalMock,
  saveApprovalMock,
  executeStagedApprovalMock,
  publishStagedFileMock,
  keepPrivateMock,
  discardStagedFileMock,
  showToastMock,
  navigateMock,
} = vi.hoisted(() => ({
  pendingApprovalsState: [] as PendingApprovalItem[],
  stagedFilesState: [] as StagedFileItem[],
  stagedGetAllMock: vi.fn(),
  approveToolApprovalMock: vi.fn().mockResolvedValue({ ok: true }),
  dismissApprovalMock: vi.fn().mockResolvedValue(true),
  saveApprovalMock: vi.fn().mockResolvedValue(undefined),
  executeStagedApprovalMock: vi.fn().mockResolvedValue({ ok: true }),
  publishStagedFileMock: vi.fn().mockResolvedValue({ success: true }),
  keepPrivateMock: vi.fn().mockResolvedValue({ success: true }),
  discardStagedFileMock: vi.fn().mockResolvedValue({ success: true }),
  showToastMock: vi.fn(),
  navigateMock: vi.fn(),
}));

vi.mock('../../hooks/usePendingApprovals', () => ({
  usePendingApprovals: () => ({
    approvals: pendingApprovalsState,
    isLoading: false,
    dismissApproval: dismissApprovalMock,
    saveApproval: saveApprovalMock,
    approveToolApproval: approveToolApprovalMock,
    executeStagedApproval: executeStagedApprovalMock,
    batchApproveToolApprovals: vi.fn().mockResolvedValue({
      succeeded: 0,
      failed: 0,
      failures: [],
    }),
  }),
  approvalOutcomeMessage: () => 'Failed',
  approvalOutcomeDescription: () => undefined,
  approvalOutcomeVariant: () => 'error',
}));

vi.mock('../../hooks/useStagedFiles', () => ({
  useStagedFiles: () => ({
    files: stagedFilesState,
    publish: publishStagedFileMock,
    discard: discardStagedFileMock,
    keepPrivate: keepPrivateMock,
  }),
}));

vi.mock('../../hooks/useSkillChangeNotifications', () => ({
  useSkillChangeNotifications: () => ({
    notifications: [],
    dismissNotification: vi.fn().mockResolvedValue(true),
    isLoading: false,
  }),
}));

vi.mock('../../hooks/usePendingQuestionWaiting', () => ({
  usePendingQuestionWaitingItems: () => [],
}));

vi.mock('@renderer/hooks/useAppNavigation', () => ({
  useAppNavigationSafe: () => ({ navigate: navigateMock }),
}));

vi.mock('@renderer/features/agent-session/store/sessionStore', () => ({
  useSessionStore: (selector: (state: { sessionSummaries: Array<{ id: string; deletedAt?: number | null }> }) => unknown) => {
    const sessionIds = new Set<string>();
    for (const approval of pendingApprovalsState) {
      if (approval.sessionId) sessionIds.add(approval.sessionId);
    }
    for (const file of stagedFilesState) {
      if (file.sessionId) sessionIds.add(file.sessionId);
    }
    return selector({
      sessionSummaries: Array.from(sessionIds).map((id) => ({ id, deletedAt: null })),
    });
  },
  getSessionStoreState: () => ({
    sessionSummaries: Array.from(new Set([
      ...pendingApprovalsState.map((approval) => approval.sessionId).filter(Boolean) as string[],
      ...stagedFilesState.map((file) => file.sessionId).filter(Boolean) as string[],
    ])).map((id) => ({ id, deletedAt: null })),
    currentSessionId: null,
    setFocusedTurnId: vi.fn(),
  }),
}));

vi.mock('@renderer/components/ui', async () => {
  const actual = await vi.importActual<typeof import('@renderer/components/ui')>('@renderer/components/ui');
  return {
    ...actual,
    useToast: () => ({ showToast: showToastMock }),
  };
});

vi.mock('../DrawerApprovalCard', () => ({
  DrawerApprovalCard: ({
    approvalId,
    onOpenActionPreview,
    pendingDialogIntent,
  }: {
    approvalId?: string;
    onOpenActionPreview?: (
      item?: PendingApprovalItem | StagedFileItem,
      options?: { resolvedRecipientLabel?: string; resolvedChannelName?: string },
    ) => void;
    pendingDialogIntent?: 'allow-and-remember' | 'deny-and-remember' | 'change-request';
  }) => {
    const reviewOptions = approvalId?.includes('slack-dm-resolved')
      ? { resolvedRecipientLabel: 'Avery Stone' }
      : undefined;
    return (
      <div data-testid={`drawer-card-shell-${approvalId ?? 'unknown'}`}>
        <span data-testid={`drawer-card-intent-${approvalId ?? 'unknown'}`}>
          {pendingDialogIntent ?? 'none'}
        </span>
        <button
          type="button"
          data-testid={`drawer-card-review-${approvalId ?? 'unknown'}`}
          onClick={() => onOpenActionPreview?.(undefined, reviewOptions)}
        >
          Review
        </button>
      </div>
    );
  },
}));

vi.mock('@renderer/components/approval/actionPreview/ActionPreview.module.css', () => ({
  default: {
    root: 'root',
    header: 'header',
    effectIconTile: 'effectIconTile',
    headerCopy: 'headerCopy',
    title: 'title',
    description: 'description',
    blastRadiusStrip: 'blastRadiusStrip',
    stripGroup: 'stripGroup',
    stripLabel: 'stripLabel',
    chipRow: 'chipRow',
    audienceSharingBadge: 'audienceSharingBadge',
    blastRadiusChip: 'blastRadiusChip',
    resolvingNote: 'resolvingNote',
    bodyRegion: 'bodyRegion',
    statusState: 'statusState',
    spinner: 'spinner',
    whySection: 'whySection',
    sectionTitle: 'sectionTitle',
    whyCopy: 'whyCopy',
    reversibilityCopy: 'reversibilityCopy',
    riskChipRow: 'riskChipRow',
    receiptsSection: 'receiptsSection',
    genericPreview: 'genericPreview',
    rows: 'rows',
    row: 'row',
    rowKey: 'rowKey',
    rowValue: 'rowValue',
    emptyRows: 'emptyRows',
    withheldCopy: 'withheldCopy',
    messagePreview: 'messagePreview',
    messageChannel: 'messageChannel',
    messageBody: 'messageBody',
    messageBodyHeader: 'messageBodyHeader',
    messageBodyText: 'messageBodyText',
    dataCapturePreview: 'dataCapturePreview',
    dataCaptureMeta: 'dataCaptureMeta',
    dataCaptureSummary: 'dataCaptureSummary',
    dataCaptureSummaryLabel: 'dataCaptureSummaryLabel',
    dataCaptureSummaryText: 'dataCaptureSummaryText',
    dataCaptureExcerpts: 'dataCaptureExcerpts',
    dataCaptureExcerptsToggle: 'dataCaptureExcerptsToggle',
    dataCaptureExcerptList: 'dataCaptureExcerptList',
    dataCaptureExcerpt: 'dataCaptureExcerpt',
    dataCaptureWithheld: 'dataCaptureWithheld',
    dataCaptureStateBadge: 'dataCaptureStateBadge',
  },
}));

vi.mock('@renderer/components/approval/actionPreview/ActionPreviewDialog.module.css', () => ({
  default: {
    dialogContent: 'dialogContent',
    dialogHeader: 'dialogHeader',
    dialogBody: 'dialogBody',
    dialogFooter: 'dialogFooter',
    footerSpacer: 'footerSpacer',
  },
}));

vi.mock('@renderer/components/approval/primitives/SharingBadge.module.css', () => ({
  default: {
    badge: 'badge',
    private: 'private',
    shared: 'shared',
    public: 'public',
    unclear: 'unclear',
  },
}));

vi.mock('../DrawerQuestionWaitingCard', () => ({
  DrawerQuestionWaitingCard: () => null,
}));

vi.mock('../DrawerSkillNotificationCard', () => ({
  DrawerSkillNotificationCard: () => null,
}));

vi.mock('../MCPNotificationCard', () => ({
  MCPNotificationCard: () => null,
}));

vi.mock('../MemoryPreviewDialog', () => ({
  MemoryPreviewDialog: () => <div data-testid="memory-preview-dialog" />,
}));

vi.mock('../StagedFilePreviewDialog', () => ({
  StagedFilePreviewDialog: ({ file }: { file?: StagedFileItem | null }) =>
    file ? <div data-testid="staged-file-preview-dialog" /> : null,
}));

function buildToolApproval(overrides: Partial<PendingApprovalItem> = {}): PendingApprovalItem {
  return {
    id: 'tool:1',
    type: 'tool',
    title: 'Session',
    description: 'Tool approval',
    timestamp: Date.UTC(2026, 4, 29),
    sessionId: 'session-1',
    toolApproval: {
      toolUseID: 'tool-use-1',
      turnId: 'turn-1',
      toolName: 'browser_navigate',
      input: {
        args: {
          url: 'https://example.com',
        },
      },
    },
    ...overrides,
  };
}

function buildMemoryApproval(overrides: Partial<PendingApprovalItem> = {}): PendingApprovalItem {
  return {
    id: 'memory:1',
    type: 'memory',
    title: 'Session',
    description: 'Memory approval',
    timestamp: Date.UTC(2026, 4, 29),
    sessionId: 'session-memory',
    memoryApproval: {
      toolUseId: 'memory-tool',
      originalSessionId: 'session-memory',
      filePath: '/memory/chief/260529_1430_meeting_summary.md',
      spaceName: 'Chief',
      summary: 'Capture summary',
      content: 'Captured content',
      isNewFile: true,
      approvalKind: 'memory_write',
    },
    ...overrides,
  };
}

function buildStagedFile(overrides: Partial<StagedFileItem> = {}): StagedFileItem {
  return {
    id: 'staged-file-1',
    realPath: '/memory/chief/260529_1430_meeting_summary.md',
    spaceName: 'Chief',
    spacePath: '/memory/chief',
    sessionId: 'session-file',
    baseHash: 'new-file',
    summary: 'Captured summary',
    stagedAt: Date.UTC(2026, 4, 29),
    sensitivity: 'high',
    fileName: '260529_1430_meeting_summary.md',
    sessionTitle: 'Session',
    ...overrides,
  };
}

async function renderDrawer(
  props: Partial<React.ComponentProps<typeof NotificationDrawer>> = {},
): Promise<{ cleanup: () => void }> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);

  await act(async () => {
    root.render(<NotificationDrawer onClose={vi.fn()} {...props} />);
  });
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

async function clickReviewButton(id: string): Promise<void> {
  const button = document.body.querySelector(`[data-testid="${id}"]`);
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Missing review button: ${id}`);
  }
  await act(async () => {
    button.click();
  });
}

describe('NotificationDrawer Action Preview routing', () => {
  beforeEach(() => {
    pendingApprovalsState.splice(0, pendingApprovalsState.length);
    stagedFilesState.splice(0, stagedFilesState.length);
    stagedGetAllMock.mockReset();
    approveToolApprovalMock.mockClear();
    dismissApprovalMock.mockClear();
    saveApprovalMock.mockClear();
    executeStagedApprovalMock.mockClear();
    publishStagedFileMock.mockClear();
    keepPrivateMock.mockClear();
    discardStagedFileMock.mockClear();
    showToastMock.mockClear();
    navigateMock.mockClear();

    Object.defineProperty(window, 'safetyApi', {
      configurable: true,
      value: {
        stagedGetAll: stagedGetAllMock,
      },
    });
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        getStagedContent: vi.fn().mockResolvedValue('staged-content'),
        readWorkspaceFile: vi.fn().mockResolvedValue({ content: '' }),
      },
    });
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('hydrates staged-tool args and opens message action preview', async () => {
    pendingApprovalsState.push({
      ...buildToolApproval(),
      id: 'staged-tool:1',
      type: 'staged-tool',
      stagedToolCall: {
        id: 'staged-call-1',
        displayName: 'Send Slack message',
        mcpPayload: {
          packageId: 'slack',
          toolId: 'post_slack_message',
          args: {},
        },
        reason: 'Safety Rules blocked: review outbound message.',
      },
    });
    stagedGetAllMock.mockResolvedValue([
      {
        id: 'staged-call-1',
        status: 'pending',
        displayName: 'Send Slack message',
        mcpPayload: {
          packageId: 'slack',
          toolId: 'post_slack_message',
          args: { channel: '#ops', text: 'Ship update' },
        },
      },
    ]);

    const rendered = await renderDrawer();
    await clickReviewButton('drawer-card-review-staged-tool:1');

    expect(stagedGetAllMock).toHaveBeenCalledTimes(1);
    expect(document.body.querySelector('[data-testid="action-preview-dialog"]')).not.toBeNull();
    expect(document.body.querySelector('[data-testid="message-preview"]')).not.toBeNull();

    rendered.cleanup();
  });

  it('shows no-longer-waiting state when staged-tool hydration row is missing', async () => {
    pendingApprovalsState.push({
      ...buildToolApproval(),
      id: 'staged-tool:missing',
      type: 'staged-tool',
      stagedToolCall: {
        id: 'staged-call-missing',
        displayName: 'Send Slack message',
        mcpPayload: {
          packageId: 'slack',
          toolId: 'post_slack_message',
          args: {},
        },
      },
    });
    stagedGetAllMock.mockResolvedValue([]);

    const rendered = await renderDrawer();
    await clickReviewButton('drawer-card-review-staged-tool:missing');

    expect(document.body.querySelector('[data-testid="action-preview-no-longer-waiting"]')).not.toBeNull();
    expect(document.body.querySelector('[data-testid="action-preview-allow-button"]')).toBeNull();

    rendered.cleanup();
  });

  it('routes net-new source-capture memory approvals to ActionPreview dialog', async () => {
    pendingApprovalsState.push(buildMemoryApproval());

    const rendered = await renderDrawer();
    await clickReviewButton('drawer-card-review-memory:1');

    expect(document.body.querySelector('[data-testid="action-preview-dialog"]')).not.toBeNull();
    expect(document.body.querySelector('[data-testid="action-preview-revealed-content"]')).not.toBeNull();
    expect(document.body.querySelector('[data-testid="memory-preview-dialog"]')).toBeNull();

    rendered.cleanup();
  });

  it('routes net-new source-capture staged files to ActionPreview dialog', async () => {
    stagedFilesState.push(buildStagedFile({
      id: 'staged-file-net-new',
      baseHash: 'new-file',
      hasConflict: false,
      fileName: '260529_1430_meeting_summary.md',
      realPath: '/memory/chief/260529_1430_meeting_summary.md',
    }));

    const rendered = await renderDrawer();
    await clickReviewButton('drawer-card-review-staged-file:staged-file-net-new');

    expect(document.body.querySelector('[data-testid="action-preview-dialog"]')).not.toBeNull();
    expect(document.body.querySelector('[data-testid="action-preview-revealed-content"]')).not.toBeNull();
    expect(document.body.querySelector('[data-testid="staged-file-preview-dialog"]')).toBeNull();

    rendered.cleanup();
  });

  it('routes modified memory approvals to the existing memory diff dialog', async () => {
    pendingApprovalsState.push(buildMemoryApproval({
      id: 'memory:modified',
      memoryApproval: {
        ...buildMemoryApproval().memoryApproval!,
        isNewFile: false,
      },
    }));

    const rendered = await renderDrawer();
    await clickReviewButton('drawer-card-review-memory:modified');

    expect(document.body.querySelector('[data-testid="memory-preview-dialog"]')).not.toBeNull();
    expect(document.body.querySelector('[data-testid="action-preview-dialog"]')).toBeNull();

    rendered.cleanup();
  });

  it('routes conflicted staged files to the existing staged-file diff dialog', async () => {
    stagedFilesState.push(buildStagedFile({
      id: 'staged-file-conflict',
      baseHash: 'existing-file',
      hasConflict: true,
    }));

    const rendered = await renderDrawer();
    await clickReviewButton('drawer-card-review-staged-file:staged-file-conflict');

    expect(document.body.querySelector('[data-testid="staged-file-preview-dialog"]')).not.toBeNull();
    expect(document.body.querySelector('[data-testid="action-preview-dialog"]')).toBeNull();

    rendered.cleanup();
  });

  it('routes modified source-capture staged files to the existing staged-file diff dialog', async () => {
    stagedFilesState.push(buildStagedFile({
      id: 'staged-file-modified',
      baseHash: 'existing-file',
      hasConflict: false,
      fileName: '260529_1430_meeting_summary.md',
      realPath: '/memory/chief/260529_1430_meeting_summary.md',
      summary: 'Updated captured summary',
    }));

    const rendered = await renderDrawer();
    await clickReviewButton('drawer-card-review-staged-file:staged-file-modified');

    expect(document.body.querySelector('[data-testid="staged-file-preview-dialog"]')).not.toBeNull();
    expect(document.body.querySelector('[data-testid="action-preview-dialog"]')).toBeNull();

    rendered.cleanup();
  });

  it('uses the same approval handler when allowing from the action preview dialog', async () => {
    vi.useFakeTimers();
    pendingApprovalsState.push(buildToolApproval());

    const rendered = await renderDrawer();
    await clickReviewButton('drawer-card-review-tool:1');

    await act(async () => {
      (document.body.querySelector('[data-testid="action-preview-allow-button"]') as HTMLButtonElement).click();
      vi.advanceTimersByTime(900);
    });

    expect(approveToolApprovalMock).toHaveBeenCalledTimes(1);
    expect(approveToolApprovalMock).toHaveBeenCalledWith(expect.objectContaining({ id: 'tool:1' }));

    rendered.cleanup();
    vi.useRealTimers();
  });

  it('uses the same dismiss handler when discarding from the action preview dialog', async () => {
    pendingApprovalsState.push(buildToolApproval({ id: 'tool:discard' }));

    const rendered = await renderDrawer();
    await clickReviewButton('drawer-card-review-tool:discard');

    await act(async () => {
      (document.body.querySelector('[data-testid="action-preview-discard-button"]') as HTMLButtonElement).click();
    });

    expect(dismissApprovalMock).toHaveBeenCalledTimes(1);
    expect(dismissApprovalMock).toHaveBeenCalledWith(expect.objectContaining({ id: 'tool:discard' }));

    rendered.cleanup();
  });

  it('keeps Allow disabled while preview content is loading', async () => {
    const getStagedContent = vi.fn().mockImplementation(() => new Promise<string>(() => undefined));
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        getStagedContent,
        readWorkspaceFile: vi.fn().mockResolvedValue({ content: '' }),
      },
    });

    stagedFilesState.push(buildStagedFile({
      id: 'loading-source',
      baseHash: 'new-file',
      hasConflict: false,
    }));

    const rendered = await renderDrawer();
    await clickReviewButton('drawer-card-review-staged-file:loading-source');

    const allowButton = document.body.querySelector('[data-testid="action-preview-allow-button"]') as HTMLButtonElement | null;
    expect(document.body.querySelector('[data-testid="action-preview-loading"]')).not.toBeNull();
    expect(allowButton?.disabled).toBe(true);

    rendered.cleanup();
  });

  it('keeps Allow disabled when preview content fails to load', async () => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        getStagedContent: vi.fn().mockRejectedValue(new Error('staged read failed')),
        readWorkspaceFile: vi.fn().mockResolvedValue({ content: '' }),
      },
    });

    stagedFilesState.push(buildStagedFile({
      id: 'error-source',
      baseHash: 'new-file',
      hasConflict: false,
    }));

    const rendered = await renderDrawer();
    await clickReviewButton('drawer-card-review-staged-file:error-source');
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const allowButton = document.body.querySelector('[data-testid="action-preview-allow-button"]') as HTMLButtonElement | null;
    expect(document.body.querySelector('[data-testid="action-preview-error"]')).not.toBeNull();
    expect(allowButton?.disabled).toBe(true);

    rendered.cleanup();
  });

  it('shows Allow and remember for safety blocks and routes back to card flow', async () => {
    pendingApprovalsState.push(buildToolApproval({
      id: 'tool:safety',
      riskLevel: 'high',
      toolApproval: {
        toolUseID: 'tool-use-safety',
        turnId: 'turn-safety',
        toolName: 'post_slack_message',
        input: {
          args: {
            channel: '#ops',
            text: 'Needs review',
          },
        },
        reason: 'Safety Rules blocked: outbound message requires confirmation.',
        blockedBy: 'safety_prompt',
      },
    }));

    const rendered = await renderDrawer({
      onSendMessageToSession: vi.fn(async () => undefined),
    });
    await clickReviewButton('drawer-card-review-tool:safety');

    const allowAndRememberButton = document.body.querySelector('[data-testid="action-preview-allow-and-remember-button"]');
    const allowOnceButton = document.body.querySelector('[data-testid="action-preview-allow-button"]');
    const changeRequestButton = document.body.querySelector('[data-testid="action-preview-change-request-button"]');
    const dontAllowButton = document.body.querySelector('[data-testid="action-preview-discard-button"]');
    expect(allowAndRememberButton).not.toBeNull();
    expect(changeRequestButton).not.toBeNull();
    expect(dontAllowButton?.textContent).toBe('Don’t allow');
    expect(allowOnceButton).toBeNull();

    await act(async () => {
      (allowAndRememberButton as HTMLButtonElement).click();
    });

    expect(document.body.querySelector('[data-testid="action-preview-dialog"]')).toBeNull();
    expect(document.body.querySelector('[data-testid="drawer-card-intent-tool:safety"]')?.textContent).toBe('allow-and-remember');

    rendered.cleanup();
  });

  it('routes safety preview Don’t allow back to the card deny-options flow', async () => {
    pendingApprovalsState.push(buildToolApproval({
      id: 'tool:safety-deny',
      riskLevel: 'high',
      toolApproval: {
        toolUseID: 'tool-use-safety-deny',
        turnId: 'turn-safety-deny',
        toolName: 'post_slack_message',
        input: {
          args: {
            channel: '#ops',
            text: 'Needs review',
          },
        },
        reason: 'Safety Rules blocked: outbound message requires confirmation.',
        blockedBy: 'safety_prompt',
      },
    }));

    const rendered = await renderDrawer();
    await clickReviewButton('drawer-card-review-tool:safety-deny');

    const dontAllowButton = document.body.querySelector('[data-testid="action-preview-discard-button"]');
    await act(async () => {
      (dontAllowButton as HTMLButtonElement).click();
    });

    expect(document.body.querySelector('[data-testid="action-preview-dialog"]')).toBeNull();
    expect(document.body.querySelector('[data-testid="drawer-card-intent-tool:safety-deny"]')?.textContent).toBe('deny-and-remember');
    expect(dismissApprovalMock).not.toHaveBeenCalled();

    rendered.cleanup();
  });

  it('routes safety preview Change request back to the card redirect editor', async () => {
    pendingApprovalsState.push(buildToolApproval({
      id: 'tool:safety-change',
      riskLevel: 'high',
      toolApproval: {
        toolUseID: 'tool-use-safety-change',
        turnId: 'turn-safety-change',
        toolName: 'post_slack_message',
        input: {
          args: {
            channel: '#ops',
            text: 'Needs review',
          },
        },
        reason: 'Safety Rules blocked: outbound message requires confirmation.',
        blockedBy: 'safety_prompt',
      },
    }));

    const rendered = await renderDrawer({
      onSendMessageToSession: vi.fn(async () => undefined),
    });
    await clickReviewButton('drawer-card-review-tool:safety-change');

    const changeRequestButton = document.body.querySelector('[data-testid="action-preview-change-request-button"]');
    expect(changeRequestButton).not.toBeNull();
    await act(async () => {
      (changeRequestButton as HTMLButtonElement).click();
    });

    expect(document.body.querySelector('[data-testid="action-preview-dialog"]')).toBeNull();
    expect(document.body.querySelector('[data-testid="drawer-card-intent-tool:safety-change"]')?.textContent).toBe('change-request');

    rendered.cleanup();
  });

  it('opens the Slack headline review path with inline destination metadata and no raw JSON on primary surface', async () => {
    pendingApprovalsState.push(buildToolApproval({
      id: 'tool:slack-headline',
      riskLevel: 'medium',
      toolApproval: {
        toolUseID: 'tool-use-slack-headline',
        turnId: 'turn-slack-headline',
        toolName: 'post_slack_message',
        input: {
          package_id: 'slack',
          args: {
            channel: '#channel',
            blocks: [
              {
                type: 'section',
                text: { type: 'mrkdwn', text: '*Launch* update ready to share.' },
              },
            ],
          },
        },
        reason: 'Safety Rules blocked: outbound message requires confirmation.',
      },
    }));

    const rendered = await renderDrawer();
    await clickReviewButton('drawer-card-review-tool:slack-headline');

    const dialog = document.body.querySelector('[data-testid="action-preview-dialog"]');
    const primaryBody = document.body.querySelector('[data-testid="action-preview-body-message"]');
    expect(dialog).not.toBeNull();
    expect(document.body.querySelector('[data-testid="message-preview"]')).not.toBeNull();
    expect(primaryBody?.textContent).toContain('*Launch* update ready to share.');
    // Decision-first rebuild: destination/audience live as one inline metadata
    // line on the message preview (no separate blast-radius pill strip).
    expect(document.body.querySelector('[data-testid="message-preview-destination"]')).not.toBeNull();
    expect(dialog?.textContent).not.toContain('Afterwards');
    expect(dialog?.textContent).not.toContain('Can edit after posting');
    expect(primaryBody?.textContent).not.toContain('"type":"section"');

    rendered.cleanup();
  });

  it('shows resolved Slack DM recipient as a private-message destination', async () => {
    pendingApprovalsState.push(buildToolApproval({
      id: 'tool:slack-dm-resolved',
      riskLevel: 'high',
      toolApproval: {
        toolUseID: 'tool-use-slack-dm-resolved',
        turnId: 'turn-slack-dm-resolved',
        toolName: 'post_slack_message',
        input: {
          package_id: 'slack',
          args: {
            user: 'U222333',
            text: 'Quick update for your review.',
          },
        },
        reason: 'Safety Rules blocked: Slack direct messages require approval unless your current Safety Rules explicitly allow Slack DMs.',
      },
    }));

    const rendered = await renderDrawer();
    await clickReviewButton('drawer-card-review-tool:slack-dm-resolved');

    const destination = document.body.querySelector('[data-testid="message-preview-destination"]');
    const audience = document.body.querySelector('[data-testid="message-preview-audience"]');
    expect(destination?.textContent).toContain('Private message to');
    expect(destination?.textContent).toContain('Avery Stone');
    expect(audience).toBeNull();

    const link = document.body.querySelector('[data-testid="action-preview-safety-rules-link"]') as HTMLButtonElement | null;
    expect(link).not.toBeNull();
    const dialog = document.body.querySelector('[data-testid="action-preview-dialog"]');
    expect(dialog?.textContent).toContain('Because Slack direct messages require approval unless your current Safety Rules explicitly allow Slack DMs.');
    await act(async () => {
      link?.click();
    });
    expect(navigateMock).toHaveBeenCalledWith({ type: 'settings', tab: 'safety', section: 'safetyRules' });

    rendered.cleanup();
  });
});
