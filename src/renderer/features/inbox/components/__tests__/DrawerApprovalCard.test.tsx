// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushAsync } from '@renderer/test-utils';
import type { PendingApprovalItem } from '../../hooks/usePendingApprovals';
import type { StagedFileItem } from '../../hooks/useStagedFiles';
import { DrawerApprovalCard, type DrawerApprovalCardProps } from '../DrawerApprovalCard';
import {
  canRedirectItem,
  getAllCaughtUpAutoCloseDelay,
  isSourceSessionAvailable,
  mergeGroupsWithRedirectShadows,
} from '../NotificationDrawer';
import { tracking } from '@renderer/src/tracking';
import { _resetForTests as resetTally } from '../../hooks/useApprovalInteractionTally';
import * as memoryWhyTextModule from '@renderer/features/automations/utils/getMemoryWhyText';
import sharingBadgeStyles from '@renderer/components/approval/primitives/SharingBadge.module.css';

const { usePrincipleOptionsMock, desktopApprovalTransportMock } = vi.hoisted(() => ({
  usePrincipleOptionsMock: vi.fn(),
  desktopApprovalTransportMock: {
    safetyPrompt: {
      generateOptions: vi.fn(),
      generateDenyOptions: vi.fn(),
    },
  },
}));

 
vi.mock('@rebel/cloud-client', () => ({
  buildMemoryBlockedAction: vi.fn(() => ({ toolName: 'memory_write', toolInput: {}, blockReason: 'blocked' })),
  usePrincipleOptions: usePrincipleOptionsMock,
}));

 
vi.mock('@renderer/transport/useDesktopApprovalTransport', () => ({
  useDesktopApprovalTransport: () => desktopApprovalTransportMock,
}));

 
vi.mock('../BrowserToolApprovalDetails', () => ({
  BrowserToolApprovalDetails: () => null,
}));

 
vi.mock('@renderer/components/ui', async () => {
  const ReactModule = await vi.importActual<typeof import('react')>('react');
  return {
    Button: ReactModule.forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement>>(
      function MockButton(props, ref) {
        return <button ref={ref} {...props} />;
      },
    ),
    Tooltip: ({
      children,
      content,
    }: {
      children: React.ReactElement<
        React.HTMLAttributes<HTMLElement> & { 'data-tooltip-content'?: string }
      >;
      content: React.ReactNode;
    }) => ReactModule.cloneElement(children, { 'data-tooltip-content': String(content) }),
    FileLocationBadge: ({
      className,
      location,
    }: {
      className?: string;
      location: { fileName?: string; spaceName?: string };
    }) => (
      <span className={className} data-testid="mock-file-location-badge">
        {location.spaceName ?? 'Space'} / {location.fileName ?? 'file.md'}
      </span>
    ),
    Textarea: ReactModule.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
      function MockTextarea(props, ref) {
        const { onChange, onInput, ...rest } = props;
        return (
          <textarea
            ref={ref}
            {...rest}
            onChange={onChange}
            onInput={(event) => {
              onInput?.(event);
              onChange?.(event as unknown as React.ChangeEvent<HTMLTextAreaElement>);
            }}
          />
        );
      },
    ),
  };
});

function buildApproval(overrides: Partial<PendingApprovalItem> = {}): PendingApprovalItem {
  return {
    id: 'tool:approval-1',
    type: 'tool',
    title: 'Session A',
    description: 'Rebel wants to run a tool',
    timestamp: Date.UTC(2026, 3, 18),
    sessionId: 'session-a',
    toolApproval: {
      toolUseID: 'tool-use-1',
      turnId: 'turn-1',
      toolName: 'browser_navigate',
      input: {},
    },
    ...overrides,
  };
}

function buildSafetyApproval(): PendingApprovalItem {
  return buildApproval({
    toolApproval: {
      toolUseID: 'tool-use-1',
      turnId: 'turn-1',
      toolName: 'browser_navigate',
      input: {},
      reason: 'Safety Rules blocked: sensitive target',
      blockedBy: 'safety_prompt',
    },
  });
}

function buildStagedToolApproval(overrides: Partial<PendingApprovalItem> = {}): PendingApprovalItem {
  return buildApproval({
    id: 'staged-tool:approval-1',
    type: 'staged-tool',
    description: 'Rebel wants to run a staged tool',
    riskLevel: 'high',
    stagedToolCall: {
      id: 'staged-call-1',
      displayName: 'MCP action',
      mcpPayload: {
        packageId: 'pkg-1',
        toolId: 'tool-1',
        args: {},
      },
      riskLevel: 'high',
    },
    ...overrides,
  });
}

function buildMemoryApproval(overrides: Partial<PendingApprovalItem> = {}): PendingApprovalItem {
  return buildApproval({
    id: 'memory:approval-1',
    type: 'memory',
    description: 'Rebel wants to save a memory',
    sessionId: 'session-memory',
    memoryApproval: {
      toolUseId: 'memory-tool-1',
      originalSessionId: 'session-memory',
      filePath: '/memory/test.md',
      spaceName: 'TestSpace',
      summary: 'summary',
      content: 'content',
    },
    ...overrides,
  });
}

function buildStagedFile(overrides: Partial<StagedFileItem> = {}): StagedFileItem {
  return {
    id: 'staged-file-1',
    realPath: '/tmp/report.md',
    spaceName: 'Team Space',
    spacePath: '/spaces/team',
    sessionId: 'session-staged-file',
    baseHash: 'new-file',
    summary: 'Summary of staged file content',
    stagedAt: Date.UTC(2026, 3, 18),
    sensitivity: 'high',
    fileName: 'report.md',
    sessionTitle: 'Session A',
    ...overrides,
  };
}

function getRiskIndicator(): HTMLSpanElement | null {
  return document.body.querySelector('.drawer-card .drawer-card__risk-indicator') as HTMLSpanElement | null;
}

function expectRiskIndicator(variantClass: string, ariaLabel: string, tooltip: string): void {
  const indicator = getRiskIndicator();
  expect(indicator).not.toBeNull();
  expect(indicator?.className).toContain('drawer-card__risk-indicator');
  expect(indicator?.className).toContain(variantClass);
  expect(indicator?.getAttribute('aria-label')).toBe(ariaLabel);
  expect(indicator?.getAttribute('data-tooltip-content')).toBe(tooltip);
}

function expectNoRiskIndicator(): void {
  expect(getRiskIndicator()).toBeNull();
}

function getSharingBadge(): HTMLSpanElement | null {
  return document.body.querySelector(`.drawer-card .${sharingBadgeStyles.badge}`) as HTMLSpanElement | null;
}

function expectSharingBadge(variantClass: string, label: string): void {
  const badge = getSharingBadge();
  expect(badge).not.toBeNull();
  expect(badge?.className).toContain(sharingBadgeStyles.badge);
  expect(badge?.className).toContain(variantClass);
  expect(badge?.textContent).toContain(label);
}

function expectCardBadge(label: string): void {
  const badge = Array.from(document.body.querySelectorAll('.drawer-card__badge')).find((candidate) =>
    candidate.textContent?.includes(label),
  );
  expect(badge).toBeTruthy();
}

function getPreviewText(): HTMLParagraphElement | null {
  return document.body.querySelector('.drawer-card__preview-text') as HTMLParagraphElement | null;
}

function getPreviewWithheld(): HTMLParagraphElement | null {
  return document.body.querySelector('.drawer-card__preview-withheld') as HTMLParagraphElement | null;
}

function mockScrollHeight(element: Element, value: number): void {
  Object.defineProperty(element, 'scrollHeight', { configurable: true, value });
}

function mockClientHeight(element: Element, value: number): void {
  Object.defineProperty(element, 'clientHeight', { configurable: true, value });
}

function findButtonByText(text: string): HTMLButtonElement {
  const button = Array.from(document.body.querySelectorAll('button')).find((candidate) =>
    candidate.textContent?.includes(text),
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Could not find button with text "${text}"`);
  }
  return button;
}

function queryButtonByText(text: string): HTMLButtonElement | undefined {
  return Array.from(document.body.querySelectorAll('button')).find((candidate): candidate is HTMLButtonElement =>
    candidate instanceof HTMLButtonElement && Boolean(candidate.textContent?.includes(text)),
  );
}

type RenderedCard = {
  rerender: (nextProps: DrawerApprovalCardProps) => Promise<void>;
  cleanup: () => void;
};

async function renderCard(initialProps: DrawerApprovalCardProps): Promise<RenderedCard> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  const rerender = async (nextProps: DrawerApprovalCardProps) => {
    await act(async () => {
      root.render(<DrawerApprovalCard {...nextProps} />);
    });
    await flushAsync();
  };

  await rerender(initialProps);

  return {
    rerender,
    cleanup: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

describe('DrawerApprovalCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    usePrincipleOptionsMock.mockImplementation(() => ({
      generationState: 'idle',
      generationError: null,
      startGeneration: vi.fn(),
      options: [],
      selectedOption: null,
      selectOption: vi.fn(),
      otherText: '',
      setOtherText: vi.fn(),
      applyState: 'idle',
      applyError: null,
      goBack: vi.fn(),
      retryGeneration: vi.fn(),
      retryApply: vi.fn(),
      confirmSelection: vi.fn(),
      confirmTrustedTool: vi.fn(),
      cancelTrustedTool: vi.fn(),
      resolveOnce: vi.fn(),
    }));
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  describe('risk indicator rendering', () => {
    it('renders a subtle high risk indicator next to the timestamp for tool approvals with a high riskLevel', async () => {
      const rendered = await renderCard({
        approval: buildApproval({ riskLevel: 'high' }),
      });

      expectRiskIndicator(
        'drawer-card__risk-indicator--high',
        'Higher-risk approval',
        'Rebel is asking because this action could affect files, accounts, or shared work.',
      );

      rendered.cleanup();
    });

    it('does not render a risk indicator for tool approvals with an undefined riskLevel', async () => {
      const rendered = await renderCard({
        approval: buildApproval({ riskLevel: undefined }),
      });

      expectNoRiskIndicator();

      rendered.cleanup();
    });

    it('does not render a risk indicator for routine memory approvals', async () => {
      const rendered = await renderCard({
        approval: buildMemoryApproval(),
      });

      expectNoRiskIndicator();

      rendered.cleanup();
    });

    it('does not render a risk indicator for routine staged-file approvals', async () => {
      const rendered = await renderCard({
        stagedFile: buildStagedFile(),
      });

      expectNoRiskIndicator();

      rendered.cleanup();
    });

    it('renders a subtle high risk indicator next to the timestamp for safety-flagged staged-file approvals', async () => {
      const rendered = await renderCard({
        stagedFile: buildStagedFile({ blockedBy: 'safety_prompt' }),
      });

      expectRiskIndicator(
        'drawer-card__risk-indicator--high',
        'Higher-risk approval',
        'Rebel is asking because this action could affect files, accounts, or shared work.',
      );

      rendered.cleanup();
    });
  });

  describe('sharing badge rendering', () => {
    it('renders a restricted sharing badge for memory approvals with restricted sharing', async () => {
      const baseApproval = buildMemoryApproval();
      const rendered = await renderCard({
        approval: {
          ...baseApproval,
          memoryApproval: {
            ...baseApproval.memoryApproval!,
            sharing: 'restricted',
          },
        },
      });

      expect(document.body.querySelector('[data-testid="mock-file-location-badge"]')?.textContent).toContain('TestSpace');
      expectSharingBadge(sharingBadgeStyles.shared, 'Restricted');

      rendered.cleanup();
    });

    it('renders an unclear sharing badge for memory approvals with undefined sharing', async () => {
      const baseApproval = buildMemoryApproval();
      const rendered = await renderCard({
        approval: {
          ...baseApproval,
          memoryApproval: {
            ...baseApproval.memoryApproval!,
            sharing: undefined,
          },
        },
      });

      expectSharingBadge(sharingBadgeStyles.unclear, 'Unclear');

      rendered.cleanup();
    });

    it('renders an unclear sharing badge for memory approvals with empty-string sharing', async () => {
      const baseApproval = buildMemoryApproval();
      const rendered = await renderCard({
        approval: {
          ...baseApproval,
          memoryApproval: {
            ...baseApproval.memoryApproval!,
            // @ts-expect-error intentional off-spec value: exercises narrowSharing fallback for empty string
            sharing: '',
          },
        },
      });

      expectSharingBadge(sharingBadgeStyles.unclear, 'Unclear');

      rendered.cleanup();
    });

    it('renders an unclear sharing badge for memory approvals with off-spec sharing', async () => {
      const baseApproval = buildMemoryApproval();
      const rendered = await renderCard({
        approval: {
          ...baseApproval,
          memoryApproval: {
            ...baseApproval.memoryApproval!,
            // @ts-expect-error intentional off-spec value: exercises narrowSharing fallback for unknown-enum string
            sharing: 'weirdstring',
          },
        },
      });

      expectSharingBadge(sharingBadgeStyles.unclear, 'Unclear');

      rendered.cleanup();
    });

    it('renders a company-wide sharing badge for staged-file approvals', async () => {
      const rendered = await renderCard({
        stagedFile: buildStagedFile({ sharing: 'company-wide' }),
      });

      expectCardBadge('New file in Team Space');
      expectSharingBadge(sharingBadgeStyles.shared, 'Company-wide');

      rendered.cleanup();
    });

    it('renders an unclear sharing badge for staged-file approvals with undefined sharing', async () => {
      const rendered = await renderCard({
        stagedFile: buildStagedFile({ sharing: undefined }),
      });

      expectSharingBadge(sharingBadgeStyles.unclear, 'Unclear');

      rendered.cleanup();
    });
  });

  describe('safety block classification', () => {
    it('classifies typed tool safety approvals without relying on a reason prefix', async () => {
      const rendered = await renderCard({
        approval: buildApproval({
          toolApproval: {
            toolUseID: 'tool-use-typed',
            turnId: 'turn-typed',
            toolName: 'browser_navigate',
            input: {},
            reason: 'Sensitive target',
            blockedBy: 'safety_prompt',
          },
        }),
      });

      expect(queryButtonByText('Allow and remember…')).toBeTruthy();
      expect(queryButtonByText('Don’t allow…')).toBeTruthy();

      rendered.cleanup();
    });

    it('classifies legacy-shaped tool safety approvals after blockedBy backfill', async () => {
      const rendered = await renderCard({
        approval: buildSafetyApproval(),
      });

      expect(queryButtonByText('Allow and remember…')).toBeTruthy();
      expect(queryButtonByText('Don’t allow…')).toBeTruthy();

      rendered.cleanup();
    });

    it('renders tool eval_error approvals as paused concrete actions', async () => {
      const rendered = await renderCard({
        approval: buildApproval({
          toolApproval: {
            toolUseID: 'tool-use-1',
            turnId: 'turn-1',
            toolName: 'Edit',
            input: { file_path: '/workspace/notes.md' },
            reason: 'API rate limit active — deferring safety evaluation',
            blockedBy: 'eval_error',
          },
        }),
      });

      expect(document.body.textContent).toContain('Decide whether to continue');
      expect(document.body.textContent).toContain("Rebel paused before editing notes.md. The safety check did not finish, so nothing has run. It won't keep trying in the background because that could run later without you noticing.");
      expect(queryButtonByText('Cancel this')).toBeTruthy();
      expect(queryButtonByText('Do it once')).toBeTruthy();
      expect(document.body.textContent).not.toContain('API rate limit active');

      rendered.cleanup();
    });

    it('renders staged-tool eval_error approvals as paused runnable actions', async () => {
      const rendered = await renderCard({
        approval: buildStagedToolApproval({
          toolApproval: undefined,
          stagedToolCall: {
            id: 'staged-call-1',
            displayName: 'Send Slack message',
            mcpPayload: {
              packageId: 'slack',
              toolId: 'slack_send_message',
              args: {},
            },
            riskLevel: 'high',
            reason: 'API rate limit active — deferring safety evaluation',
            blockedBy: 'eval_error',
          },
        }),
      });

      expect(document.body.textContent).toContain('Decide whether to continue');
      expect(document.body.textContent).toContain("Rebel paused before running Send Slack message. The safety check did not finish, so nothing has run. It won't keep trying in the background because that could run later without you noticing.");
      expect(queryButtonByText('Cancel this')).toBeTruthy();
      expect(queryButtonByText('Do it once')).toBeTruthy();
      expect(document.body.textContent).not.toContain('API rate limit active');

      rendered.cleanup();
    });

    it('renders memory eval_error approvals as paused saves', async () => {
      const rendered = await renderCard({
        approval: buildMemoryApproval({
          memoryApproval: {
            ...buildMemoryApproval().memoryApproval!,
            filePath: '/memory/research-notes.md',
            spaceName: 'Research',
            blockedBy: 'eval_error',
          },
        }),
      });

      expect(document.body.textContent).toContain('Decide whether to continue');
      expect(document.body.textContent).toContain("Rebel paused before saving Research Notes to Research. The safety check did not finish, so nothing has run. It won't keep trying in the background because that could run later without you noticing.");
      expect(queryButtonByText('Cancel this')).toBeTruthy();
      expect(queryButtonByText('Do it once')).toBeTruthy();

      rendered.cleanup();
    });

    it('classifies staged files blocked by eval_error as paused actions (direct save, no scope options)', async () => {
      usePrincipleOptionsMock.mockReturnValue({ options: [], isLoading: false });
      const rendered = await renderCard({
        stagedFile: buildStagedFile({ blockedBy: 'eval_error' }),
      });

      // eval_error rows are recovery decisions. They do not offer rule-update
      // actions because the evaluator was temporarily unavailable, not because
      // a principled safety rule fired.
      expect(document.body.textContent).toContain('Decide whether to continue');
      expect(document.body.textContent).toContain('Rebel paused before');
      expect(document.body.textContent).toContain('nothing has run');
      expect(queryButtonByText('Do it once')).toBeTruthy();
      expect(queryButtonByText('Cancel this')).toBeTruthy();
      // Verify scope options are NOT shown for eval_error
      const scopeAllow = Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent === 'Allow\u2026');
      expect(scopeAllow).toBeFalsy();

      rendered.cleanup();
    });

    it('does not classify staged files blocked by structural_policy as safety blocks', async () => {
      const rendered = await renderCard({
        stagedFile: buildStagedFile({ blockedBy: 'structural_policy' }),
      });

      const buttons = Array.from(document.body.querySelectorAll('button'));
      const allowButton = buttons.find((b) => b.textContent === 'Allow');
      expect(allowButton).toBeTruthy();
      const scopeAllow = buttons.find((b) => b.textContent === 'Allow\u2026');
      expect(scopeAllow).toBeFalsy();

      rendered.cleanup();
    });

    it('distinguishes Slack DM setup from Slack DM sending approvals', async () => {
      const rendered = await renderCard({
        approval: buildStagedToolApproval({
          stagedToolCall: {
            id: 'staged-slack-dm',
            displayName: 'Send Slack message',
            mcpPayload: {
              packageId: 'slack',
              toolId: 'open_slack_dm',
              args: { user_id: 'U123' },
            },
            riskLevel: 'high',
            blockedBy: 'safety_prompt',
          },
        }),
      });

      expect(document.body.textContent).toContain('Approve sending Slack message');
      expect(document.body.textContent).not.toContain('Rebel needs your choice');

      rendered.cleanup();

      const sendRendered = await renderCard({
        approval: buildStagedToolApproval({
          stagedToolCall: {
            id: 'staged-slack-send-dm',
            displayName: 'Send Slack message',
            mcpPayload: {
              packageId: 'slack',
              toolId: 'post_slack_message',
              args: { channel: 'D123', text: 'Hi Liam' },
            },
            riskLevel: 'high',
            blockedBy: 'safety_prompt',
          },
        }),
      });

      expect(document.body.textContent).toContain('Approve sending Slack message');

      sendRendered.cleanup();
    });

    it('resolves Slack user IDs in DM approval title and body copy', async () => {
      Object.defineProperty(window, 'slackApi', {
        configurable: true,
        value: {
          resolveUser: vi.fn().mockResolvedValue({
            success: true,
            user: {
              id: 'U123',
              displayName: 'Team Member',
            },
          }),
        },
      });

      const rendered = await renderCard({
        approval: buildStagedToolApproval({
          description: 'Rebel would like to open a direct message to user U123 in Slack.',
          stagedToolCall: {
            id: 'staged-slack-dm',
            displayName: 'Send Slack message',
            mcpPayload: {
              packageId: 'Slack-mindstone',
              toolId: 'open_slack_dm',
              args: { user: 'U123' },
            },
            riskLevel: 'high',
            reason: 'Safety Rules blocked: Slack direct messages require approval unless your current Safety Rules explicitly allow Slack DMs.',
            blockedBy: 'safety_prompt',
          },
        }),
      });

      await flushAsync();

      expect(document.body.textContent).toContain('Approve sending Slack message to Team Member');
      expect(document.body.textContent).toContain('Rebel wants to send a Slack message to Team Member. Please confirm before it contacts them.');
      expect(document.body.textContent).not.toContain('U123');

      const principleArgsWithRecipient = usePrincipleOptionsMock.mock.calls
        .map((call) => call[0])
        .find((args) => args.blockedAction?.toolInput?.user_display_name === 'Team Member');
      expect(principleArgsWithRecipient).toBeTruthy();

      rendered.cleanup();
      Reflect.deleteProperty(window, 'slackApi');
    });

    it('does not expose raw Slack user IDs when the user lookup is unavailable', async () => {
      Reflect.deleteProperty(window, 'slackApi');

      const rendered = await renderCard({
        approval: buildStagedToolApproval({
          description: 'Rebel would like to open a direct message to user U123 in Slack.',
          stagedToolCall: {
            id: 'staged-slack-dm-unresolved',
            displayName: 'Send Slack message',
            mcpPayload: {
              packageId: 'Slack-mindstone',
              toolId: 'open_slack_dm',
              args: { user: 'U123' },
            },
            riskLevel: 'high',
            reason: 'Safety Rules blocked: Slack direct messages require approval unless your current Safety Rules explicitly allow Slack DMs.',
            blockedBy: 'safety_prompt',
          },
        }),
      });

      await flushAsync();

      expect(document.body.textContent).toContain('Approve sending Slack message');
      expect(document.body.textContent).toContain('Rebel wants to send a Slack message to this Slack user. Please confirm before it contacts them.');
      expect(document.body.textContent).not.toContain('U123');
      expect(document.body.textContent).not.toContain('unknown Slack user');

      rendered.cleanup();
    });

    it('replaces raw Slack user IDs in remembered-choice option labels', async () => {
      usePrincipleOptionsMock.mockImplementation(() => ({
        generationState: 'loaded',
        generationError: null,
        startGeneration: vi.fn(),
        options: [
          { scope: 'trusted_tool', label: 'Can always send Slack messages' },
          { scope: 'broad', label: 'Allow sending messages to internal colleagues' },
          { scope: 'specific', label: 'Allow opening direct messages with U123 only' },
        ],
        selectedOption: null,
        selectOption: vi.fn(),
        otherText: '',
        setOtherText: vi.fn(),
        applyState: 'idle',
        applyError: null,
        goBack: vi.fn(),
        retryGeneration: vi.fn(),
        retryApply: vi.fn(),
        confirmSelection: vi.fn(),
        confirmTrustedTool: vi.fn(),
        cancelTrustedTool: vi.fn(),
        resolveOnce: vi.fn(),
      }));
      Object.defineProperty(window, 'slackApi', {
        configurable: true,
        value: {
          resolveUser: vi.fn().mockResolvedValue({
            success: true,
            user: {
              id: 'U123',
              displayName: 'Team Member',
            },
          }),
        },
      });

      const rendered = await renderCard({
        approval: buildStagedToolApproval({
          stagedToolCall: {
            id: 'staged-slack-dm-options',
            displayName: 'Send Slack message',
            mcpPayload: {
              packageId: 'Slack-mindstone',
              toolId: 'open_slack_dm',
              args: { user: 'U123' },
            },
            riskLevel: 'high',
            reason: 'Safety Rules blocked: Slack direct messages require approval unless your current Safety Rules explicitly allow Slack DMs.',
            blockedBy: 'safety_prompt',
          },
        }),
      });

      await flushAsync();
      await act(async () => {
        findButtonByText('Allow and remember…').click();
      });

      expect(document.body.textContent).toContain('Allow sending Slack messages to Team Member only');
      expect(document.body.textContent).not.toContain('opening direct messages');
      expect(document.body.textContent).not.toContain('U123');
      desktopApprovalTransportMock.safetyPrompt.generateOptions.mockResolvedValueOnce({
        options: [
          { scope: 'specific', label: 'Allow opening direct messages with U123 only' },
        ],
      });
      const allowPrincipleArgs = [...usePrincipleOptionsMock.mock.calls]
        .reverse()
        .map((call) => call[0])
        .find((args) => !args.direction);
      expect(allowPrincipleArgs).toBeTruthy();
      const generated = await allowPrincipleArgs!.transport.safetyPrompt.generateOptions({
        toolName: 'open_slack_dm',
        toolInput: {},
        blockReason: 'blocked',
      });
      expect(generated.options[0].label).toBe('Allow sending Slack messages to Team Member only');

      rendered.cleanup();
      Reflect.deleteProperty(window, 'slackApi');
    });

    it('does not rewrite Slack channel posts as direct messages to a user', async () => {
      const rendered = await renderCard({
        approval: buildStagedToolApproval({
          stagedToolCall: {
            id: 'staged-slack-channel-message',
            displayName: 'Send Slack message',
            mcpPayload: {
              packageId: 'Slack-mindstone',
              toolId: 'post_slack_message',
              args: { channel: 'C123', text: 'Hi team' },
            },
            riskLevel: 'high',
            reason: 'Safety Rules blocked: Slack messages require approval.',
            blockedBy: 'safety_prompt',
          },
        }),
      });

      expect(document.body.textContent).toContain('Approve this Slack message');
      expect(document.body.textContent).not.toContain('this Slack user');
      expect(document.body.textContent).not.toContain('Please confirm before it contacts them');

      rendered.cleanup();
    });

    it('uses a message action icon for message approvals', async () => {
      const rendered = await renderCard({
        approval: buildStagedToolApproval({
          stagedToolCall: {
            id: 'staged-slack-message',
            displayName: 'Send Slack message',
            mcpPayload: {
              packageId: 'slack',
              toolId: 'slack_send_message',
              args: {
                channel_name: '#general',
                text: 'Hi Liam, I am testing approvals.',
              },
            },
            riskLevel: 'high',
            reason: 'Safety Rules blocked: Slack messages require approval.',
            blockedBy: 'safety_prompt',
          },
        }),
      });

      expect(document.body.querySelector('[data-testid="drawer-card-message-preview"]')).toBeNull();
      expect(document.body.querySelector('.drawer-card__type-icon')?.getAttribute('data-action-kind')).toBe('message');

      rendered.cleanup();
    });

    it('uses an email action icon for email approvals', async () => {
      const rendered = await renderCard({
        approval: buildApproval({
          description: 'Rebel wants to send an email',
          toolApproval: {
            toolUseID: 'tool-email-1',
            turnId: 'turn-email-1',
            toolName: 'mcp__super-mcp-router__use_tool',
            input: {
              package_id: 'gmail',
              tool_id: 'send_email',
              args: {
                to: 'liam@example.com',
                subject: 'Approval test',
                body: 'Hi Liam,\n\nThis is the email Rebel wants to send.',
              },
            },
            reason: 'Safety Rules blocked: Email sends require approval.',
            blockedBy: 'safety_prompt',
          },
        }),
      });

      expect(document.body.querySelector('[data-testid="drawer-card-email-preview"]')).toBeNull();
      expect(document.body.querySelector('.drawer-card__type-icon')?.getAttribute('data-action-kind')).toBe('email');

      rendered.cleanup();
    });

    it('uses the file row as a preview affordance for staged files', async () => {
      const onNavigate = vi.fn();
      const rendered = await renderCard({
        stagedFile: buildStagedFile({ sessionId: '' }),
        onNavigate,
      });

      const fileRow = document.body.querySelector('[data-testid="drawer-card-file-row"]');
      expect(fileRow).toBeInstanceOf(HTMLButtonElement);
      expect(document.body.querySelector('[data-testid="drawer-card-navigate"]')).toBeNull();
      expect(document.body.textContent).not.toContain('Preview file');
      expect(fileRow?.querySelector('.drawer-card__file-preview-affordance')).not.toBeNull();

      await act(async () => {
        (fileRow as HTMLButtonElement).click();
      });

      expect(onNavigate).toHaveBeenCalledTimes(1);

      rendered.cleanup();
    });

    it('hides staged-file summaries that only contain frontmatter separators', async () => {
      const rendered = await renderCard({
        stagedFile: buildStagedFile({ summary: '-\n--\n---\n----' }),
      });

      expect(document.body.textContent).not.toContain('---');
      expect(document.body.textContent).toContain('report.md');

      rendered.cleanup();
    });
  });

  describe('content preview', () => {
    it('renders a collapsed preview for memory approvals with contentPreview text', async () => {
      const baseApproval = buildMemoryApproval();
      const rendered = await renderCard({
        approval: {
          ...baseApproval,
          memoryApproval: {
            ...baseApproval.memoryApproval!,
            contentPreview: 'short text',
          },
        },
      });

      const preview = getPreviewText();
      expect(preview).not.toBeNull();
      expect(preview?.textContent).toBe('short text');
      expect(preview?.className).not.toContain('drawer-card__preview-text--expanded');

      rendered.cleanup();
    });

    it('expands the preview when clicked', async () => {
      const baseApproval = buildMemoryApproval();
      const rendered = await renderCard({
        approval: {
          ...baseApproval,
          memoryApproval: {
            ...baseApproval.memoryApproval!,
            contentPreview: 'short text',
          },
        },
      });

      await act(async () => {
        getPreviewText()?.click();
      });

      expect(getPreviewText()?.className).toContain('drawer-card__preview-text--expanded');

      rendered.cleanup();
    });

    it('expands the preview when Enter is pressed', async () => {
      const baseApproval = buildMemoryApproval();
      const rendered = await renderCard({
        approval: {
          ...baseApproval,
          memoryApproval: {
            ...baseApproval.memoryApproval!,
            contentPreview: 'short text',
          },
        },
      });

      const preview = getPreviewText();
      expect(preview).not.toBeNull();

      await act(async () => {
        preview?.focus();
        preview?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      });

      expect(getPreviewText()?.className).toContain('drawer-card__preview-text--expanded');

      rendered.cleanup();
    });

    it('expands the preview when Space is pressed', async () => {
      const baseApproval = buildMemoryApproval();
      const rendered = await renderCard({
        approval: {
          ...baseApproval,
          memoryApproval: {
            ...baseApproval.memoryApproval!,
            contentPreview: 'short text',
          },
        },
      });

      const preview = getPreviewText();
      expect(preview).not.toBeNull();

      await act(async () => {
        preview?.focus();
        preview?.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
      });

      expect(getPreviewText()?.className).toContain('drawer-card__preview-text--expanded');

      rendered.cleanup();
    });

    it('renders the preview as a 200-character slice with an ellipsis for long content', async () => {
      const baseApproval = buildMemoryApproval();
      const longPreview = 'A'.repeat(300);
      const rerenderPreview = 'B'.repeat(300);
      const rendered = await renderCard({
        approval: {
          ...baseApproval,
          memoryApproval: {
            ...baseApproval.memoryApproval!,
            contentPreview: longPreview,
          },
        },
      });

      const preview = getPreviewText();
      expect(preview).not.toBeNull();
      expect(preview?.textContent).toBe(`${'A'.repeat(200)}…`);

      if (preview) {
        mockClientHeight(preview, 16);
        mockScrollHeight(preview, 48);
      }

      await rendered.rerender({
        approval: {
          ...baseApproval,
          memoryApproval: {
            ...baseApproval.memoryApproval!,
            contentPreview: rerenderPreview,
          },
        },
      });

      expect(getPreviewText()?.textContent).toBe(`${'B'.repeat(200)}…`);
      expect(getPreviewText()?.getAttribute('title')).toBe('Expand preview');

      rendered.cleanup();
    });

    it('renders the withheld copy when credentials caused the preview to be withheld', async () => {
      const baseApproval = buildMemoryApproval();
      const rendered = await renderCard({
        approval: {
          ...baseApproval,
          memoryApproval: {
            ...baseApproval.memoryApproval!,
            contentPreview: undefined,
            sensitivityReason: 'credential_token',
          },
        },
      });

      expect(getPreviewWithheld()?.textContent).toBe('Preview withheld — may contain sensitive content');
      expect(getPreviewText()).toBeNull();

      rendered.cleanup();
    });

    it('renders the withheld copy when non-inspectable bash caused the preview to be withheld', async () => {
      const baseApproval = buildMemoryApproval();
      const rendered = await renderCard({
        approval: {
          ...baseApproval,
          memoryApproval: {
            ...baseApproval.memoryApproval!,
            contentPreview: undefined,
            sensitivityReason: 'non_inspectable_bash',
          },
        },
      });

      expect(getPreviewWithheld()?.textContent).toBe('Preview withheld — may contain sensitive content');
      expect(getPreviewText()).toBeNull();

      rendered.cleanup();
    });

    it('renders nothing for structural_policy without a sensitivityReason', async () => {
      const baseApproval = buildMemoryApproval();
      const rendered = await renderCard({
        approval: {
          ...baseApproval,
          memoryApproval: {
            ...baseApproval.memoryApproval!,
            contentPreview: undefined,
            blockedBy: 'structural_policy',
            sensitivityReason: undefined,
          },
        },
      });

      expect(getPreviewText()).toBeNull();
      expect(getPreviewWithheld()).toBeNull();

      rendered.cleanup();
    });

    it('renders nothing for legacy memory approvals without preview or sensitivity metadata', async () => {
      const baseApproval = buildMemoryApproval();
      const rendered = await renderCard({
        approval: {
          ...baseApproval,
          memoryApproval: {
            ...baseApproval.memoryApproval!,
            contentPreview: undefined,
            blockedBy: undefined,
            sensitivityReason: undefined,
          },
        },
      });

      expect(getPreviewText()).toBeNull();
      expect(getPreviewWithheld()).toBeNull();

      rendered.cleanup();
    });

    it('renders nothing for empty-string previews', async () => {
      const baseApproval = buildMemoryApproval();
      const rendered = await renderCard({
        approval: {
          ...baseApproval,
          memoryApproval: {
            ...baseApproval.memoryApproval!,
            contentPreview: '',
          },
        },
      });

      expect(getPreviewText()).toBeNull();
      expect(getPreviewWithheld()).toBeNull();

      rendered.cleanup();
    });

    it('renders HTML-like preview text as escaped literal text', async () => {
      const baseApproval = buildMemoryApproval();
      const rendered = await renderCard({
        approval: {
          ...baseApproval,
          memoryApproval: {
            ...baseApproval.memoryApproval!,
            contentPreview: '<script>alert(1)</script>',
          },
        },
      });

      expect(getPreviewText()?.textContent).toBe('<script>alert(1)</script>');
      expect(document.body.querySelector('.drawer-card__preview-text script')).toBeNull();

      rendered.cleanup();
    });

    it('rerenders from preview text to withheld copy when sensitivity metadata arrives later', async () => {
      const baseApproval = buildMemoryApproval();
      const rendered = await renderCard({
        approval: {
          ...baseApproval,
          memoryApproval: {
            ...baseApproval.memoryApproval!,
            contentPreview: 'hello',
          },
        },
      });

      expect(getPreviewText()?.textContent).toBe('hello');
      expect(getPreviewWithheld()).toBeNull();

      await rendered.rerender({
        approval: {
          ...baseApproval,
          memoryApproval: {
            ...baseApproval.memoryApproval!,
            contentPreview: undefined,
            sensitivityReason: 'credential_token',
          },
        },
      });

      expect(getPreviewText()).toBeNull();
      expect(getPreviewWithheld()?.textContent).toBe('Preview withheld — may contain sensitive content');

      rendered.cleanup();
    });

    it('does not warn when an expanded preview is unmounted', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const baseApproval = buildMemoryApproval();
      const rendered = await renderCard({
        approval: {
          ...baseApproval,
          memoryApproval: {
            ...baseApproval.memoryApproval!,
            contentPreview: 'short text',
          },
        },
      });

      await act(async () => {
        getPreviewText()?.click();
      });

      rendered.cleanup();
      await flushAsync();

      expect(consoleErrorSpy).not.toHaveBeenCalledWith(
        expect.stringContaining("Can't perform a React state update on an unmounted component"),
      );

      consoleErrorSpy.mockRestore();
    });
  });

  it('renders the Change request button when onRedirectWithInstruction is provided', async () => {
    const rendered = await renderCard({
      approval: buildApproval(),
      onRedirectWithInstruction: vi.fn().mockResolvedValue({ ok: true, sessionId: 'session-a' }),
    });

    expect(document.body.querySelector('[data-testid="drawer-card-redirect"]')).not.toBeNull();
    expect(document.body.textContent).toContain('Change request');

    rendered.cleanup();
  });

  it('does not render the Change request button when onRedirectWithInstruction is absent', async () => {
    const rendered = await renderCard({ approval: buildApproval() });

    expect(document.body.querySelector('[data-testid="drawer-card-redirect"]')).toBeNull();

    rendered.cleanup();
  });

  it('reveals the redirect editor and hides action buttons when Change request is clicked', async () => {
    const rendered = await renderCard({
      approval: buildApproval(),
      onRedirectWithInstruction: vi.fn().mockResolvedValue({ ok: true, sessionId: 'session-a' }),
    });

    await act(async () => {
      findButtonByText('Change request').click();
    });

    expect(document.body.querySelector('[data-testid="drawer-card-redirect-editor"]')).not.toBeNull();
    expect(document.body.querySelector('[data-testid="drawer-card-redirect"]')).toBeNull();

    rendered.cleanup();
  });

  it('keeps Send update disabled for empty or whitespace-only redirect input', async () => {
    const rendered = await renderCard({
      approval: buildApproval(),
      onRedirectWithInstruction: vi.fn().mockResolvedValue({ ok: true, sessionId: 'session-a' }),
    });

    await act(async () => {
      findButtonByText('Change request').click();
    });

    const submitButton = document.body.querySelector('[data-testid="drawer-card-redirect-submit"]');
    const textarea = document.body.querySelector('[data-testid="drawer-card-redirect-input"]');
    expect(submitButton).toBeInstanceOf(HTMLButtonElement);
    expect(textarea).toBeInstanceOf(HTMLTextAreaElement);

    await act(async () => {
      (textarea as HTMLTextAreaElement).value = '   ';
      textarea?.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect((submitButton as HTMLButtonElement).disabled).toBe(true);

    rendered.cleanup();
  });

  it('submits trimmed redirect text through onRedirectWithInstruction', async () => {
    const onRedirect = vi.fn().mockResolvedValue({ ok: true, sessionId: 'session-a' });
    const rendered = await renderCard({
      approval: buildApproval(),
      onRedirectWithInstruction: onRedirect,
    });

    await act(async () => {
      findButtonByText('Change request').click();
    });

    const textarea = document.body.querySelector('[data-testid="drawer-card-redirect-input"]');
    const submitButton = document.body.querySelector('[data-testid="drawer-card-redirect-submit"]');

    await act(async () => {
      (textarea as HTMLTextAreaElement).value = '  do this instead  ';
      textarea?.dispatchEvent(new Event('input', { bubbles: true }));
      textarea?.dispatchEvent(new Event('change', { bubbles: true }));
    });

    await act(async () => {
      expect((submitButton as HTMLButtonElement).disabled).toBe(false);
      (submitButton as HTMLButtonElement).click();
      await flushAsync();
    });

    expect(onRedirect).toHaveBeenCalledTimes(1);
    expect(onRedirect).toHaveBeenCalledWith('do this instead');

    rendered.cleanup();
  });

  it('renders sent outcome state without duplicating the drawer header conversation action', async () => {
    const onNavigateToConversation = vi.fn();
    const rendered = await renderCard({
      approval: buildApproval(),
      redirectOutcome: { status: 'sent', sessionId: 'session-a', at: Date.now() },
      onNavigateToConversation,
    });

    expect(document.body.querySelector('[data-testid="drawer-card-redirect-sent"]')).not.toBeNull();
    expect(document.body.textContent).toContain('Added to conversation');
    expect(document.body.querySelector('[data-testid="drawer-card-view-conversation"]')).toBeNull();
    expect(document.body.textContent).not.toContain('View conversation');
    expect(onNavigateToConversation).not.toHaveBeenCalled();

    rendered.cleanup();
  });

  it('renders error outcome state with Retry action', async () => {
    const rendered = await renderCard({
      approval: buildApproval(),
      redirectOutcome: {
        status: 'error',
        sessionId: 'session-a',
        at: Date.now(),
        instruction: 'retry me',
        error: 'network',
      },
      onRedirectWithInstruction: vi.fn().mockResolvedValue({ ok: true, sessionId: 'session-a' }),
    });

    expect(document.body.querySelector('[data-testid="drawer-card-redirect-error"]')).not.toBeNull();
    expect(document.body.querySelector('[data-testid="drawer-card-redirect-retry"]')).not.toBeNull();

    rendered.cleanup();
  });

  it('hides the redirect action while safety option panels are open', async () => {
    const renderedAllow = await renderCard({
      approval: buildSafetyApproval(),
      onRedirectWithInstruction: vi.fn().mockResolvedValue({ ok: true, sessionId: 'session-a' }),
    });

    expect(document.body.querySelector('[data-testid="drawer-card-redirect"]')).not.toBeNull();

    await act(async () => {
      findButtonByText('Allow and remember…').click();
    });

    expect(document.body.querySelector('[data-testid="drawer-card-redirect"]')).toBeNull();
    renderedAllow.cleanup();

    const renderedDeny = await renderCard({
      approval: buildSafetyApproval(),
      onRedirectWithInstruction: vi.fn().mockResolvedValue({ ok: true, sessionId: 'session-a' }),
    });

    await act(async () => {
      findButtonByText('Don’t allow…').click();
    });

    expect(document.body.querySelector('[data-testid="drawer-card-redirect"]')).toBeNull();

    renderedDeny.cleanup();
  });

  it('cancels redirect editing and restores the action row', async () => {
    const rendered = await renderCard({
      approval: buildApproval(),
      onRedirectWithInstruction: vi.fn().mockResolvedValue({ ok: true, sessionId: 'session-a' }),
    });

    await act(async () => {
      findButtonByText('Change request').click();
    });

    const textarea = document.body.querySelector('[data-testid="drawer-card-redirect-input"]');
    await act(async () => {
      (textarea as HTMLTextAreaElement).value = 'draft instruction';
      textarea?.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await act(async () => {
      findButtonByText('Cancel').click();
    });

    expect(document.body.querySelector('[data-testid="drawer-card-redirect-input"]')).toBeNull();
    expect(document.body.querySelector('[data-testid="drawer-card-redirect"]')).not.toBeNull();

    rendered.cleanup();
  });

  it('renders redirect success state even when approval and stagedFile are absent', async () => {
    const rendered = await renderCard({
      redirectOutcome: { status: 'sent', sessionId: 'session-a', at: Date.now() },
    });

    expect(document.body.textContent).toContain('Added to conversation');

    rendered.cleanup();
  });

  it('submits the redirect draft when Enter is pressed without shift', async () => {
    const onRedirect = vi.fn().mockResolvedValue({ ok: true, sessionId: 'session-a' });
    const rendered = await renderCard({
      approval: buildApproval(),
      onRedirectWithInstruction: onRedirect,
    });

    await act(async () => {
      findButtonByText('Change request').click();
    });

    const textarea = document.body.querySelector(
      '[data-testid="drawer-card-redirect-input"]',
    ) as HTMLTextAreaElement;

    await act(async () => {
      textarea.value = 'redirect via enter';
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      textarea.dispatchEvent(new Event('change', { bubbles: true }));
    });

    await act(async () => {
      textarea.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      );
      await flushAsync();
    });

    expect(onRedirect).toHaveBeenCalledTimes(1);
    expect(onRedirect).toHaveBeenCalledWith('redirect via enter');

    rendered.cleanup();
  });

  it('does not submit when Shift+Enter is pressed (allows newline)', async () => {
    const onRedirect = vi.fn().mockResolvedValue({ ok: true, sessionId: 'session-a' });
    const rendered = await renderCard({
      approval: buildApproval(),
      onRedirectWithInstruction: onRedirect,
    });

    await act(async () => {
      findButtonByText('Change request').click();
    });

    const textarea = document.body.querySelector(
      '[data-testid="drawer-card-redirect-input"]',
    ) as HTMLTextAreaElement;

    await act(async () => {
      textarea.value = 'draft with shift enter';
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      textarea.dispatchEvent(new Event('change', { bubbles: true }));
    });

    await act(async () => {
      textarea.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      await flushAsync();
    });

    expect(onRedirect).not.toHaveBeenCalled();
    expect(document.body.querySelector('[data-testid="drawer-card-redirect-editor"]')).not.toBeNull();

    rendered.cleanup();
  });

  it('cancels editing and restores the action row when Escape is pressed', async () => {
    const rendered = await renderCard({
      approval: buildApproval(),
      onRedirectWithInstruction: vi.fn().mockResolvedValue({ ok: true, sessionId: 'session-a' }),
    });

    await act(async () => {
      findButtonByText('Change request').click();
    });

    const textarea = document.body.querySelector(
      '[data-testid="drawer-card-redirect-input"]',
    ) as HTMLTextAreaElement;

    await act(async () => {
      textarea.value = 'draft that should be discarded';
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await act(async () => {
      textarea.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
    });

    expect(document.body.querySelector('[data-testid="drawer-card-redirect-editor"]')).toBeNull();
    expect(document.body.querySelector('[data-testid="drawer-card-redirect"]')).not.toBeNull();

    rendered.cleanup();
  });

  it('stops Escape propagation so it does not reach document listeners (prevents drawer from closing)', async () => {
    // NotificationDrawer has `document.addEventListener("keydown", ...)` that
    // closes the whole drawer on Escape. Escape inside the redirect editor
    // must cancel the editor only — not propagate up to document. Verifies
    // the fix flagged during Phase 7 cross-changeset review.
    const rendered = await renderCard({
      approval: buildApproval(),
      onRedirectWithInstruction: vi.fn().mockResolvedValue({ ok: true, sessionId: 'session-a' }),
    });

    await act(async () => {
      findButtonByText('Change request').click();
    });

    const textarea = document.body.querySelector(
      '[data-testid="drawer-card-redirect-input"]',
    ) as HTMLTextAreaElement;

    const documentEscapeSpy = vi.fn();
    document.addEventListener('keydown', documentEscapeSpy);

    try {
      await act(async () => {
        textarea.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
        );
      });

      expect(documentEscapeSpy).not.toHaveBeenCalled();
      expect(document.body.querySelector('[data-testid="drawer-card-redirect-editor"]')).toBeNull();
    } finally {
      document.removeEventListener('keydown', documentEscapeSpy);
    }

    rendered.cleanup();
  });

  it('calls onRedirectWithInstruction with the stored instruction when Retry is clicked', async () => {
    const onRedirect = vi.fn().mockResolvedValue({ ok: true, sessionId: 'session-a' });
    const rendered = await renderCard({
      approval: buildApproval(),
      onRedirectWithInstruction: onRedirect,
      redirectOutcome: {
        status: 'error',
        sessionId: 'session-a',
        at: Date.now(),
        instruction: 'please try again',
        error: 'network-error',
      },
    });

    const retryButton = document.body.querySelector(
      '[data-testid="drawer-card-redirect-retry"]',
    ) as HTMLButtonElement;

    await act(async () => {
      retryButton.click();
      await flushAsync();
    });

    expect(onRedirect).toHaveBeenCalledTimes(1);
    expect(onRedirect).toHaveBeenCalledWith('please try again');

    rendered.cleanup();
  });

  it('clears redirect error state when Dismiss is clicked', async () => {
    const onDismissRedirectError = vi.fn();
    const rendered = await renderCard({
      approval: buildApproval(),
      redirectOutcome: {
        status: 'error',
        sessionId: 'session-a',
        at: Date.now(),
        instruction: 'please retry',
        error: 'network',
      },
      onDismissRedirectError,
    });

    const dismissButton = document.body.querySelector(
      '[data-testid="drawer-card-redirect-dismiss"]',
    ) as HTMLButtonElement;
    expect(dismissButton).toBeInstanceOf(HTMLButtonElement);

    await act(async () => {
      dismissButton.click();
    });

    expect(onDismissRedirectError).toHaveBeenCalledTimes(1);

    rendered.cleanup();
  });

  it('keeps retained redirect items merged in groups until shadow entries are cleared', () => {
    const retainedApproval = buildApproval({ id: 'tool:retained', sessionId: 'session-retained', timestamp: 100 });
    const retainedItem: Parameters<typeof canRedirectItem>[0]['item'] = {
      kind: 'approval',
      id: retainedApproval.id,
      timestamp: retainedApproval.timestamp,
      sessionId: retainedApproval.sessionId,
      groupTitle: retainedApproval.title,
      approval: retainedApproval,
    };

    const redirectShadows = new Map([
      [
        retainedItem.id,
        {
          item: retainedItem,
          entry: { status: 'sent', sessionId: 'session-retained', at: Date.now() } as const,
        },
      ],
    ]);

    const mergedWithShadow = mergeGroupsWithRedirectShadows([], redirectShadows);
    expect(mergedWithShadow).toHaveLength(1);
    expect(mergedWithShadow[0].items).toHaveLength(1);
    expect(mergedWithShadow[0].items[0].id).toBe(retainedItem.id);

    redirectShadows.delete(retainedItem.id);
    const mergedAfterClear = mergeGroupsWithRedirectShadows([], redirectShadows);
    expect(mergedAfterClear).toHaveLength(0);
  });

  it('applies canRedirect session gating for missing, deleted, active, and automation sessions', () => {
    const activeItem: Parameters<typeof canRedirectItem>[0]['item'] = {
      kind: 'approval',
      id: 'tool:active',
      timestamp: 1,
      sessionId: 'session-active',
      groupTitle: 'Active session',
      approval: buildApproval({ id: 'tool:active', sessionId: 'session-active' }),
    };

    const missingSessionItem: Parameters<typeof canRedirectItem>[0]['item'] = {
      ...activeItem,
      id: 'tool:missing',
      sessionId: null,
      approval: buildApproval({ id: 'tool:missing', sessionId: null }),
    };

    const automationItem: Parameters<typeof canRedirectItem>[0]['item'] = {
      ...activeItem,
      id: 'tool:auto',
      sessionId: 'automation-123',
      approval: buildApproval({ id: 'tool:auto', sessionId: 'automation-123' }),
    };
    const automationInsightItem: Parameters<typeof canRedirectItem>[0]['item'] = {
      ...activeItem,
      id: 'tool:auto-insight',
      sessionId: 'automation-insight-123',
      approval: buildApproval({ id: 'tool:auto-insight', sessionId: 'automation-insight-123' }),
    };

    expect(canRedirectItem({
      item: missingSessionItem,
      hasSendMessageHandler: true,
      sessionSummaries: [],
    })).toBe(false);

    expect(canRedirectItem({
      item: activeItem,
      hasSendMessageHandler: true,
      sessionSummaries: [{ id: 'session-active', deletedAt: Date.now() }],
    })).toBe(false);

    expect(canRedirectItem({
      item: activeItem,
      hasSendMessageHandler: true,
      sessionSummaries: [{ id: 'session-active', deletedAt: null }],
    })).toBe(true);

    expect(canRedirectItem({
      item: automationItem,
      hasSendMessageHandler: true,
      sessionSummaries: [],
    })).toBe(true);
    expect(canRedirectItem({
      item: automationInsightItem,
      hasSendMessageHandler: true,
      sessionSummaries: [],
    })).toBe(true);

    expect(canRedirectItem({
      item: activeItem,
      hasSendMessageHandler: true,
      sessionSummaries: [],
    })).toBe(false);
  });

  it('treats deleted and missing normal sessions as unavailable notification sources', () => {
    expect(isSourceSessionAvailable({
      sessionId: null,
      sessionSummaries: [],
    })).toBe(true);

    expect(isSourceSessionAvailable({
      sessionId: 'session-active',
      sessionSummaries: [{ id: 'session-active', deletedAt: null }],
    })).toBe(true);

    expect(isSourceSessionAvailable({
      sessionId: 'session-deleted',
      sessionSummaries: [{ id: 'session-deleted', deletedAt: Date.now() }],
    })).toBe(false);

    expect(isSourceSessionAvailable({
      sessionId: 'session-missing',
      sessionSummaries: [],
    })).toBe(false);

    expect(isSourceSessionAvailable({
      sessionId: 'automation-123',
      sessionSummaries: [],
    })).toBe(true);
  });

  it('uses automation-specific allow-once copy for automation-insight safety blocks', async () => {
    const safetyApproval = buildSafetyApproval();
    const rendered = await renderCard({
      approval: {
        ...safetyApproval,
        sessionId: 'automation-insight-123',
      },
    });

    await act(async () => {
      findButtonByText('Allow and remember…').click();
    });

    expect(findButtonByText('Allow this run only')).toBeTruthy();
    rendered.cleanup();
  });

  describe('analytics', () => {
    beforeEach(() => {
      resetTally();
    });

    it('fires Approval Card Viewed exactly once per approvalId even across remounts', async () => {
      const spy = vi.spyOn(tracking.approvals, 'cardViewed');
      spy.mockClear();

      const first = await renderCard({
        approvalId: 'tool:approval-1',
        approval: buildApproval(),
      });
      first.cleanup();

      // Remount with the same approvalId — simulates drawer group
      // collapse/expand. Should NOT fire a second cardViewed event.
      const second = await renderCard({
        approvalId: 'tool:approval-1',
        approval: buildApproval(),
      });
      second.cleanup();

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({
          approvalType: 'tool',
          hasContentPreview: false,
          hasWithheldPreview: false,
          hasWhyFacets: false,
        }),
      );

      spy.mockRestore();
    });

    it('does not fire Approval Card Viewed when approvalId is omitted', async () => {
      const spy = vi.spyOn(tracking.approvals, 'cardViewed');
      spy.mockClear();

      const rendered = await renderCard({ approval: buildApproval() });
      expect(spy).not.toHaveBeenCalled();

      rendered.cleanup();
      spy.mockRestore();
    });

    it('renders approval reasons inline instead of hiding them behind a Why toggle', async () => {
      const whyTextSpy = vi
        .spyOn(memoryWhyTextModule, 'getMemoryWhyText')
        .mockReturnValue('This save may be visible to the broader team.');
      const memoryApproval: PendingApprovalItem = {
        id: 'memory:approval-why-dedupe',
        type: 'memory',
        title: 'Memory approval',
        description: 'Rebel wants to save a memory',
        timestamp: Date.UTC(2026, 3, 18),
        sessionId: 'session-m',
        memoryApproval: {
          toolUseId: 'tu-1',
          originalSessionId: 'session-m',
          filePath: '/memory/test.md',
          spaceName: 'TestSpace',
          summary: 'summary',
          content: 'content',
          sharing: 'company-wide',
          sensitivityReason: 'contains a credential that may leak to the broader team',
        },
      };

      const rendered = await renderCard({
        approvalId: 'memory:approval-why-dedupe',
        approval: memoryApproval,
      });

      expect(document.body.textContent).toContain('This save may be visible to the broader team.');
      expect(document.body.querySelector('[data-testid="drawer-card-why-toggle"]')).toBeNull();

      rendered.cleanup();
      whyTextSpy.mockRestore();
    });

    it('classifies memory approvals blocked by eval_error as not thin (safetyReasonText counts as visible explanation)', async () => {
      const spy = vi.spyOn(tracking.approvals, 'cardViewed');
      spy.mockClear();

      const memoryEvalError: PendingApprovalItem = {
        id: 'memory:eval-error-1',
        type: 'memory',
        title: 'Blocked memory write',
        description: 'Rebel wants to save a memory',
        timestamp: Date.UTC(2026, 3, 18),
        sessionId: 'session-e',
        memoryApproval: {
          toolUseId: 'tu-e',
          originalSessionId: 'session-e',
          filePath: '/memory/e.md',
          spaceName: 'SomeSpace',
          summary: '',
          content: 'content',
          blockedBy: 'eval_error',
        },
      };

      const rendered = await renderCard({
        approvalId: 'memory:eval-error-1',
        approval: memoryEvalError,
      });

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({
          approvalType: 'memory',
          thinFacets: false,
        }),
      );

      rendered.cleanup();
      spy.mockRestore();
    });

    it('tracks withheld memory approvals as informative even when the why text is short', async () => {
      const spy = vi.spyOn(tracking.approvals, 'cardViewed');
      const whyTextSpy = vi.spyOn(memoryWhyTextModule, 'getMemoryWhyText').mockReturnValue('sensitive');
      spy.mockClear();

      const rendered = await renderCard({
        approvalId: 'memory:approval-withheld-analytics',
        approval: buildMemoryApproval({
          id: 'memory:approval-withheld-analytics',
          memoryApproval: {
            ...buildMemoryApproval().memoryApproval!,
            summary: '',
            contentPreview: undefined,
            sensitivityReason: 'credential_token',
          },
        }),
      });

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({
          approvalType: 'memory',
          hasContentPreview: false,
          hasWithheldPreview: true,
          thinFacets: false,
        }),
      );

      rendered.cleanup();
      whyTextSpy.mockRestore();
      spy.mockRestore();
    });

    it('does not render a duplicate post-redirect View conversation link inside the card', async () => {
      const spy = vi.spyOn(tracking.approvals, 'viewConversationClicked');
      spy.mockClear();
      const onNavigateToConversation = vi.fn();

      const rendered = await renderCard({
        approvalId: 'tool:approval-post-redirect',
        approval: buildApproval({ id: 'tool:approval-post-redirect' }),
        onNavigateToConversation,
        redirectOutcome: { status: 'sent', sessionId: 'session-new', at: Date.now() },
      });

      expect(document.body.querySelector('[data-testid="drawer-card-view-conversation"]')).toBeNull();
      expect(document.body.textContent).not.toContain('View conversation');
      expect(onNavigateToConversation).not.toHaveBeenCalled();
      expect(spy).not.toHaveBeenCalled();

      rendered.cleanup();
      spy.mockRestore();
    });
  });

  it('returns a faster auto-close delay when the drawer just became empty', () => {
    expect(getAllCaughtUpAutoCloseDelay({
      totalCount: 0,
      approvalsLoading: false,
      skillNotificationsLoading: false,
      previousTotalCount: 1,
    })).toBe(250);
  });

  it('keeps the standard empty-state delay when the drawer opens empty', () => {
    expect(getAllCaughtUpAutoCloseDelay({
      totalCount: 0,
      approvalsLoading: false,
      skillNotificationsLoading: false,
      previousTotalCount: 0,
    })).toBe(1000);

    expect(getAllCaughtUpAutoCloseDelay({
      totalCount: 0,
      approvalsLoading: false,
      skillNotificationsLoading: false,
      previousTotalCount: null,
    })).toBe(1000);
  });

  it('does not auto-close while the drawer is still loading or has items', () => {
    expect(getAllCaughtUpAutoCloseDelay({
      totalCount: 2,
      approvalsLoading: false,
      skillNotificationsLoading: false,
      previousTotalCount: 3,
    })).toBeNull();

    expect(getAllCaughtUpAutoCloseDelay({
      totalCount: 0,
      approvalsLoading: true,
      skillNotificationsLoading: false,
      previousTotalCount: 2,
    })).toBeNull();

    expect(getAllCaughtUpAutoCloseDelay({
      totalCount: 0,
      approvalsLoading: false,
      skillNotificationsLoading: true,
      previousTotalCount: 2,
    })).toBeNull();
  });

  describe('approval message clarity baselines (composition)', () => {
    it('renders raw filename for non-source-capture staged files (BASELINE: F1/F2)', async () => {
      // BASELINE: F1/F2 — slug-only filename appears as raw text in the card.
      // After fix, should render humanised description.
      usePrincipleOptionsMock.mockReturnValue({ principleOptions: [], isLoading: false });

      const approval = buildApproval({
        id: 'staged-file:baseline-f12',
        type: 'staged-tool' as PendingApprovalItem['type'],
        description: '',
        sessionId: 'session-baseline',
      });
      const stagedFile = buildStagedFile({
        fileName: 'Team Member-Team Member.md',
        baseHash: 'new-file',
        spaceName: 'General',
      });

      const card = await renderCard({
        approval,
        stagedFile,
        onApprove: vi.fn(),
        onDismiss: vi.fn(),
      });

      expect(document.body.textContent).toContain('Team Member');

      card.cleanup();
    });

    it('renders generic safety WHY text for memory approvals (BASELINE: F4)', async () => {
      // BASELINE: F4 — WHY text is generic, doesn't reference matched rule.
      // After fix, should include which safety principle triggered the block.
      usePrincipleOptionsMock.mockReturnValue({ principleOptions: [], isLoading: false });

      const whyTextSpy = vi
        .spyOn(memoryWhyTextModule, 'getMemoryWhyText')
        .mockReturnValue('Your safety rules flagged this — taking a cautious approach.');
      const approval = buildMemoryApproval();

      const card = await renderCard({
        approval,
        onApprove: vi.fn(),
        onDismiss: vi.fn(),
      });

      expect(document.body.textContent).toContain('Your safety rules flagged this');

      card.cleanup();
      whyTextSpy.mockRestore();
    });
  });
});
