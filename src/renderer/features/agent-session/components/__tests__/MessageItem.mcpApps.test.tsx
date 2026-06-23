// @vitest-environment happy-dom
 

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentTurnMessage, McpAppUiMeta } from '@shared/types';
import type { MessageItemProps } from '../MessageItem';
import type { TurnStepContext } from '../../utils/turnStepContext';
import type { StepToolSummary } from '../../utils/toolChips';
import { formatMcpAppSendMessageText } from '@shared/utils/mcpAppSendMessageAttribution';

const conversationFeedbackPromptSpy = vi.hoisted(() => vi.fn());

vi.mock('@rebel/shared', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  computeTaskDisplayProps: vi.fn(() => null),
}));

vi.mock('@renderer/features/settings', () => ({
  useSettingsSafe: () => ({
    settings: {
      theme: 'dark',
      experimental: { mcpAppsEnabled: true },
      trustedPreviewDomains: [],
      localModel: { profiles: [] },
    },
  }),
}));

vi.mock('@renderer/components/MessageMarkdown', () => ({
  MessageMarkdown: ({ content }: { content: string }) => <div data-testid="message-markdown">{content}</div>,
}));

vi.mock('../ContextualProgressCard', () => ({ ContextualProgressCard: () => null }));
vi.mock('../InsightsPill', () => ({ InsightsPill: () => null }));
vi.mock('../MemoryUpdateIndicator', () => ({ MemoryUpdateIndicator: () => null }));
vi.mock('../TeamKnowledgeIndicator', () => ({ TeamKnowledgeIndicator: () => null }));
vi.mock('../TimeSavedSummary', () => ({ TimeSavedSummary: () => null }));
vi.mock('../ConversationFeedbackPrompt', () => ({
  ConversationFeedbackPrompt: (props: unknown) => {
    conversationFeedbackPromptSpy(props);
    return null;
  },
}));
vi.mock('@renderer/components/ToolResultImage', () => ({
  ToolResultImage: () => null,
  ToolResultImages: () => null,
}));
vi.mock('../ImageGrid', () => ({
  ImageGrid: () => null,
}));

import { MessageItem } from '../MessageItem';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const uiMeta: McpAppUiMeta = {
  resourceUri: 'ui://google-workspace/compose-email',
  sourcePackageId: 'GoogleWorkspace-joshua-example-com',
  presentation: 'primary',
  viewSummary: 'Email draft to alice@example.com about the Q2 plan.',
  viewRoleLabel: 'Editable email draft',
  structuredFallback: {
    kind: 'email-draft',
    payload: {
      to: ['alice@example.com', 'bob@example.com'],
      cc: ['charlie@example.com'],
      subject: 'Project update — Q2 plan',
      body: "Hi team — here's the draft for review.",
    },
  },
};

const inlineUiMeta: McpAppUiMeta = {
  resourceUri: 'ui://google-workspace/search-results',
  sourcePackageId: 'GoogleWorkspace-joshua-example-com',
  presentation: 'inline',
  viewSummary: 'Search results ready.',
  viewRoleLabel: 'Search results',
};

function makeTool(overrides: Partial<StepToolSummary> = {}): StepToolSummary {
  return {
    label: 'Compose email',
    detail: 'draft created',
    icon: '✉️',
    tone: 'default',
    toolName: 'compose_workspace_email',
    toolUseId: 'tool-1',
    mcpAppUiMeta: uiMeta,
    toolResult: { structuredContent: { ok: true } },
    ...overrides,
  };
}

function makeTurnStepContextFromTools(tools: StepToolSummary[]): TurnStepContext {
  return {
    assistantSteps: [],
    fileOperationsByStep: new Map(),
    flattenedFileOperations: [],
    toolSummariesByStep: new Map([[1, tools]]),
    technicalEvents: [],
    technicalEventsByStep: new Map(),
    pendingTodos: [],
    missionContext: null,
    taskProgress: [],
    turnTaskDelta: null,
    modelByStep: new Map(),
  } as unknown as TurnStepContext;
}

function makeTurnStepContext(meta: McpAppUiMeta = uiMeta): TurnStepContext {
  return makeTurnStepContextFromTools([makeTool({ mcpAppUiMeta: meta })]);
}

const message: AgentTurnMessage = {
  id: 'msg-1',
  turnId: 'turn-1',
  role: 'assistant',
  text: 'Here is the full assistant prose that should stay copyable and recoverable.',
  createdAt: Date.now(),
};

function makeProps(overrides: Partial<MessageItemProps> = {}): MessageItemProps {
  return {
    message,
    boundaryAfterThis: undefined,
    messageCount: 1,
    sessionIdForFeedback: 'session-1',
    resolvedTurnId: 'turn-1',
    turnEvents: [],
    turnStepContext: makeTurnStepContext(),
    subAgentTimeline: undefined,
    activeStepByTurn: {},
    memoryStatusByTurn: {},
    timeSavedStatusByTurn: {},
    activitySummaryByTurn: {},
    visibleTurnId: 'turn-1',
    focusedTurnId: null,
    processingTurnId: null,
    editingMessageId: null,
    isBusy: false,
    isStopping: false,
    onFocusTurn: vi.fn(),
    onBeginEditMessage: vi.fn(),
    onSelectInlineStep: vi.fn(),
    onOpenFile: vi.fn(),
    onCopyToClipboard: vi.fn(),
    ...overrides,
  };
}

function renderMessageItem(props: MessageItemProps): { container: HTMLElement; root: Root; unmount: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<MessageItem {...props} />);
  });
  return {
    container,
    root,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

async function flushPromises(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function expectRecoveryNoticeStructure(container: HTMLElement): void {
  const notice = container.querySelector('[data-testid="mcp-app-recovery-notice"]');
  expect(notice).toBeTruthy();
  expect(notice?.getAttribute('role')).toBe('status');
  expect(container.textContent).toContain('The view failed to load.');
  expect(container.textContent).toContain('The useful details are still here.');
  expect(container.textContent).toContain('Email draft to alice@example.com about the Q2 plan.');
  expect(container.textContent).toContain('To: alice@example.com, bob@example.com');
  expect(container.textContent).toContain('Subject: Project update — Q2 plan');
  expect(container.querySelector('[data-testid="mcp-app-retry-button"]')).toBeTruthy();
  expect(container.querySelector('[data-testid="mcp-app-copy-fallback-button"]')?.textContent).toContain('Copy draft');

  const disclosure = Array.from(container.querySelectorAll('button'))
    .find((button) => button.textContent === "Show Rebel's note" || button.textContent === "Hide Rebel's note");
  expect(disclosure).toBeTruthy();
  expect(disclosure?.getAttribute('aria-expanded')).toBeDefined();
  const controlledRegionId = disclosure?.getAttribute('aria-controls');
  expect(controlledRegionId).toBeTruthy();
  expect(document.getElementById(controlledRegionId ?? '')?.textContent).toContain('Here is the full assistant prose');
}

describe('MessageItem MCP App primary fallback consumers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.className = 'dark';
    const OriginalURL = URL;
    vi.stubGlobal('URL', class extends OriginalURL {
      static createObjectURL = vi.fn(() => 'data:text/html,<html><body>Draft view</body></html>');
      static revokeObjectURL = vi.fn();
    });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(async () => undefined) },
    });
    (window as unknown as {
      mcpAppsApi: {
        readResource: ReturnType<typeof vi.fn>;
        grantPermission: ReturnType<typeof vi.fn>;
      };
      appApi: { openPath: ReturnType<typeof vi.fn> };
    }).mcpAppsApi = {
      readResource: vi.fn(async () => ({
        success: true,
        contents: [{ text: '<html><body>Draft view</body></html>' }],
      })),
      grantPermission: vi.fn(async () => ({ success: true })),
    };
    (window as unknown as { appApi: { openPath: ReturnType<typeof vi.fn> } }).appApi = {
      openPath: vi.fn(),
    };
    (window as unknown as { api: { logEvent: ReturnType<typeof vi.fn> } }).api = {
      logEvent: vi.fn(),
    };
  });

  it('Scenario 1: renders one primary view without work disclosure', async () => {
    const rendered = renderMessageItem(makeProps());
    await flushPromises();

    expect(rendered.container.querySelector('[data-testid="mcp-app-primary-view"]')).toBeTruthy();
    expect(rendered.container.querySelector('[data-testid="message-work-disclosure"]')).toBeNull();
    expect(rendered.container.querySelector('[data-testid="primary-view-source-strip"]')?.textContent)
      .toContain('From Google Workspace');

    rendered.unmount();
  });

  it('passes conversation feedback anchor props to ConversationFeedbackPrompt when enabled', async () => {
    const rendered = renderMessageItem(makeProps({
      showConversationFeedback: true,
      conversationFeedbackAnchor: {
        anchorMessageId: 'msg-1',
        anchorTurnId: 'turn-1',
        anchorMessageIndex: 0,
      },
    }));
    await flushPromises();

    expect(conversationFeedbackPromptSpy).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      anchorMessageId: 'msg-1',
      anchorTurnId: 'turn-1',
      anchorMessageIndex: 0,
    }));

    rendered.unmount();
  });

  it('keeps result message utility controls in the footer without a visible Summary header label', async () => {
    const createdAt = Date.now();
    const resultEvent = {
      type: 'result',
      timestamp: createdAt + 1000,
      model: 'claude-3-5-sonnet-latest',
      usage: {
        inputTokens: 120,
        outputTokens: 34,
      },
    } as AgentEvent;
    const rendered = renderMessageItem(makeProps({
      message: {
        ...message,
        role: 'result',
        text: 'Final answer',
        createdAt,
      },
      turnEvents: [resultEvent],
      turnStepContext: undefined,
      showConversationFeedback: true,
    }));
    await flushPromises();

    const header = rendered.container.querySelector('header');
    const footer = rendered.container.querySelector('footer[aria-label="Message actions and response feedback"]');
    expect(header?.textContent).not.toContain('Summary');
    expect(header?.querySelector('time')).toBeNull();
    expect(footer).toBeTruthy();
    expect(footer?.querySelector('[aria-label="View turn usage details"]')).toBeTruthy();
    expect(footer?.querySelector('[data-testid="message-copy-button"]')).toBeTruthy();
    expect(footer?.querySelector('time')).toBeTruthy();
    expect(conversationFeedbackPromptSpy).toHaveBeenCalledWith(expect.objectContaining({
      className: expect.any(String),
    }));

    rendered.unmount();
  });

  it('renders the source strip above McpAppView for primary views', async () => {
    const rendered = renderMessageItem(makeProps());
    await flushPromises();

    const strip = rendered.container.querySelector('[data-testid="primary-view-source-strip"]');
    const iframe = rendered.container.querySelector('iframe');
    expect(strip).toBeTruthy();
    expect(iframe).toBeTruthy();
    if (!strip || !iframe) throw new Error('Expected strip and iframe');
    expect(Boolean(strip.compareDocumentPosition(iframe) & Node.DOCUMENT_POSITION_FOLLOWING))
      .toBe(true);

    rendered.unmount();
  });

  it('surfaces MCP App trust rejection notices in the message', async () => {
    const rendered = renderMessageItem(makeProps());
    await flushPromises();

    act(() => {
      window.dispatchEvent(new CustomEvent('mcp-app:trust-rejection', {
        detail: {
          toolUseId: 'tool-1',
          sessionId: 'session-1',
          conversationId: 'session-1',
          sourcePackageId: uiMeta.sourcePackageId,
          rejection: {
            jsonRpcCode: -32603,
            reason: 'permission_denied',
            safeMessage: 'View tried to provide context to the assistant. Grant in Settings to enable.',
          },
        },
      }));
    });

    expect(rendered.container.querySelector('[data-testid="mcp-app-trust-rejection-notice"]')).toBeTruthy();
    expect(rendered.container.textContent).toContain('View tried to provide context to the assistant. Grant in Settings to enable.');
    const grantButton = rendered.container.querySelector('[data-testid="mcp-app-grant-context-button"]');
    expect(grantButton).toBeTruthy();
    await act(async () => {
      grantButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(window.mcpAppsApi.grantPermission).toHaveBeenCalledWith({
      sourcePackageId: uiMeta.sourcePackageId,
      conversationId: 'session-1',
      method: 'ui/updateModelContext',
    });
    expect(rendered.container.textContent).toContain('Context sharing granted. The view can retry now.');

    act(() => {
      window.dispatchEvent(new CustomEvent('mcp-app:trust-rejection', {
        detail: {
          toolUseId: 'tool-1',
          sessionId: 'session-1',
          rejection: {
            jsonRpcCode: -32029,
            reason: 'rate_limited',
            safeMessage: 'View is sending too much context. It will retry shortly.',
          },
        },
      }));
    });

    expect(rendered.container.textContent).toContain('View is sending too much context. It will retry shortly.');

    rendered.unmount();
  });

  it('grants sendMessage permission from the trust rejection notice', async () => {
    const rendered = renderMessageItem(makeProps());
    await flushPromises();

    act(() => {
      window.dispatchEvent(new CustomEvent('mcp-app:trust-rejection', {
        detail: {
          toolUseId: 'tool-1',
          sessionId: 'session-1',
          conversationId: 'session-1',
          sourcePackageId: uiMeta.sourcePackageId,
          method: 'ui/sendMessage',
          rejection: {
            jsonRpcCode: -32603,
            reason: 'permission_denied',
            safeMessage: 'View tried to send a message on your behalf. Grant in Settings to enable.',
          },
        },
      }));
    });

    expect(rendered.container.textContent).toContain('View tried to send a message on your behalf. Grant in Settings to enable.');
    const grantButton = rendered.container.querySelector('[data-testid="mcp-app-grant-context-button"]');
    await act(async () => {
      grantButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(window.mcpAppsApi.grantPermission).toHaveBeenCalledWith({
      sourcePackageId: uiMeta.sourcePackageId,
      conversationId: 'session-1',
      method: 'ui/sendMessage',
    });
    expect(rendered.container.textContent).toContain('Message sending granted. The view can retry now.');

    rendered.unmount();
  });

  it('grants tools/call permission for the rejected tool from the trust rejection notice', async () => {
    const rendered = renderMessageItem(makeProps());
    await flushPromises();

    act(() => {
      window.dispatchEvent(new CustomEvent('mcp-app:trust-rejection', {
        detail: {
          toolUseId: 'tool-1',
          sessionId: 'session-1',
          conversationId: 'session-1',
          sourcePackageId: uiMeta.sourcePackageId,
          method: 'tools/call',
          toolName: 'send_workspace_email',
          rejection: {
            jsonRpcCode: -32603,
            reason: 'tool_not_allowed',
            safeMessage: "View tried to use a tool that isn't allowed. Grant access in Settings.",
          },
        },
      }));
    });

    expect(rendered.container.textContent).toContain("View tried to use a tool that isn't allowed. Grant access in Settings.");
    const grantButton = rendered.container.querySelector('[data-testid="mcp-app-grant-context-button"]');
    await act(async () => {
      grantButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(window.mcpAppsApi.grantPermission).toHaveBeenCalledWith({
      sourcePackageId: uiMeta.sourcePackageId,
      conversationId: 'session-1',
      method: 'tools/call',
      toolName: 'send_workspace_email',
    });
    expect(rendered.container.textContent).toContain('Tool access granted. The view can retry now.');

    rendered.unmount();
  });

  it('renders app-attributed user messages differently and without edit affordance', async () => {
    const onBeginEditMessage = vi.fn();
    const attributedMessage: AgentTurnMessage = {
      id: 'msg-app-1',
      turnId: 'turn-app-1',
      role: 'user',
      text: formatMcpAppSendMessageText({
        sourcePackageFamily: 'Google Workspace',
        timestamp: '2026-05-10T00:00:00.000Z',
        content: 'Use this edited draft.',
      }),
      displayText: 'Use this edited draft.',
      createdAt: Date.now(),
    };

    const rendered = renderMessageItem(makeProps({
      message: attributedMessage,
      turnStepContext: makeTurnStepContextFromTools([]),
      turnEvents: [{ type: 'status', message: 'Queued', timestamp: Date.now() }],
      onBeginEditMessage,
    }));
    await flushPromises();

    expect(rendered.container.querySelector('[data-testid="mcp-app-attributed-user-message"]')).toBeTruthy();
    expect(rendered.container.textContent).toContain('from Google Workspace');
    expect(rendered.container.querySelector('[data-testid="message-edit-button"]')).toBeNull();
    expect(rendered.container.querySelector('article')?.getAttribute('role')).toBeNull();

    rendered.unmount();
  });

  it('shows a cleaned indicator for sanitized app-attributed messages', async () => {
    const attributedMessage: AgentTurnMessage = {
      id: 'msg-app-cleaned',
      turnId: 'turn-app-cleaned',
      role: 'user',
      text: formatMcpAppSendMessageText({
        sourcePackageFamily: 'Google Workspace',
        timestamp: '2026-05-10T00:00:00.000Z',
        content: 'Use this edited draft. (cleaned for safety)',
      }),
      displayText: 'Use this edited draft. (cleaned for safety)',
      createdAt: Date.now(),
    };

    const rendered = renderMessageItem(makeProps({
      message: attributedMessage,
      turnStepContext: makeTurnStepContextFromTools([]),
      turnEvents: [{ type: 'status', message: 'Queued', timestamp: Date.now() }],
    }));
    await flushPromises();

    expect(rendered.container.querySelector('[data-testid="mcp-app-attributed-user-message"]')?.textContent)
      .toContain('Use this edited draft.');
    expect(rendered.container.querySelector('[data-testid="mcp-app-attributed-user-message"]')?.textContent)
      .toContain('cleaned');

    rendered.unmount();
  });

  it.each([
    ['invalid_params', 'View sent invalid context (too long, malformed, or missing fields).'],
    ['unknown_method', "View tried something Rebel doesn't know how to do."],
    ['tool_not_allowed', "View couldn't share context with the assistant."],
  ] as const)('surfaces specific trust notice copy for %s', async (reason, expectedCopy) => {
    const rendered = renderMessageItem(makeProps());
    await flushPromises();

    act(() => {
      window.dispatchEvent(new CustomEvent('mcp-app:trust-rejection', {
        detail: {
          toolUseId: 'tool-1',
          sessionId: 'session-1',
          rejection: {
            jsonRpcCode: -32602,
            reason,
            safeMessage: expectedCopy,
          },
        },
      }));
    });

    expect(rendered.container.textContent).toContain(expectedCopy);
    rendered.unmount();
  });

  it.each([
    ['permission_denied', "View tried to use a tool that isn't allowed. Grant access in Settings."],
    ['tool_not_allowed', "View tried to use a tool that isn't allowed. Grant access in Settings."],
    ['rate_limited', 'View is calling tools too quickly.'],
  ] as const)('surfaces tools/call trust notice copy for %s', async (reason, expectedCopy) => {
    const rendered = renderMessageItem(makeProps());
    await flushPromises();

    act(() => {
      window.dispatchEvent(new CustomEvent('mcp-app:trust-rejection', {
        detail: {
          toolUseId: 'tool-1',
          sessionId: 'session-1',
          method: 'tools/call',
          toolName: 'send_workspace_email',
          rejection: {
            jsonRpcCode: -32603,
            reason,
            safeMessage: expectedCopy,
          },
        },
      }));
    });

    expect(rendered.container.textContent).toContain(expectedCopy);
    rendered.unmount();
  });

  it('Scenario 2: renders primary first with inline tools in a collapsed work disclosure', async () => {
    const rendered = renderMessageItem(makeProps({
      turnStepContext: makeTurnStepContextFromTools([
        makeTool(),
        makeTool({
          label: 'Inline research',
          detail: 'Read the quarterly plan',
          icon: '📄',
          toolName: 'custom_lookup',
          toolUseId: 'tool-inline',
          mcpAppUiMeta: undefined,
        }),
      ]),
    }));
    await flushPromises();

    const primary = rendered.container.querySelector('[data-testid="mcp-app-primary-view"]');
    const disclosure = rendered.container.querySelector('[data-testid="message-work-disclosure"]');
    expect(primary).toBeTruthy();
    expect(disclosure).toBeTruthy();

    const button = disclosure?.querySelector('button');
    expect(button?.getAttribute('aria-expanded')).toBe('false');
    // Stage 1 (260618 show-more-activity) made the collapsed label the
    // deterministic activity recap, so a single inline tool reads "1 tool"
    // rather than the legacy "Show details" fallback (which only appears when
    // the recap produces no label at all). No AI summary is set here, so the
    // count-line is shown (Stage 3 prefers the summary only when present).
    expect(button?.textContent).toContain('1 tool');
    expect(disclosure?.querySelector('[id]')?.hasAttribute('hidden')).toBe(true);
    act(() => button?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(button?.getAttribute('aria-expanded')).toBe('true');
    expect(disclosure?.querySelector('[id]')?.hasAttribute('hidden')).toBe(false);
    expect(rendered.container.textContent).toContain('Inline research');

    rendered.unmount();
  });

  it.each([
    ['pending', 'pending'],
    ['running', 'running'],
    ['failed', 'error'],
    ['unknown future status', 'future_status'],
  ] as const)('Scenario 2 auto-open: opens work disclosure when an inline tool is %s', async (_label, status) => {
    const rendered = renderMessageItem(makeProps({
      turnStepContext: makeTurnStepContextFromTools([
        makeTool(),
        makeTool({
          label: 'Inline research',
          detail: 'Could not read the file',
          icon: '📄',
          toolName: 'custom_lookup',
          toolUseId: 'tool-inline',
          status: status as unknown as StepToolSummary['status'],
          mcpAppUiMeta: undefined,
        }),
      ]),
    }));
    await flushPromises();

    const disclosure = rendered.container.querySelector('[data-testid="message-work-disclosure"]');
    const button = disclosure?.querySelector('button');
    expect(button?.getAttribute('aria-expanded')).toBe('true');
    expect(rendered.container.textContent).toContain('Inline research');

    rendered.unmount();
  });

  it('Scenario 2 auto-open: opens mixed success plus pending work, but stays closed when all inline work succeeded', async () => {
    const mixed = renderMessageItem(makeProps({
      turnStepContext: makeTurnStepContextFromTools([
        makeTool(),
        makeTool({
          label: 'Successful lookup',
          icon: '📄',
          tone: 'files',
          toolName: 'lookup',
          toolUseId: 'tool-success',
          status: 'success',
          mcpAppUiMeta: undefined,
        }),
        makeTool({
          label: 'Pending lookup',
          icon: '📄',
          tone: 'files',
          toolName: 'lookup',
          toolUseId: 'tool-pending',
          status: 'pending',
          mcpAppUiMeta: undefined,
        }),
      ]),
    }));
    await flushPromises();
    expect(mixed.container.querySelector('[data-testid="message-work-disclosure"] button')?.getAttribute('aria-expanded'))
      .toBe('true');
    mixed.unmount();

    const allSuccess = renderMessageItem(makeProps({
      turnStepContext: makeTurnStepContextFromTools([
        makeTool(),
        makeTool({
          label: 'Successful lookup',
          icon: '📄',
          tone: 'files',
          toolName: 'lookup',
          toolUseId: 'tool-success',
          status: 'success',
          mcpAppUiMeta: undefined,
        }),
      ]),
    }));
    await flushPromises();
    expect(allSuccess.container.querySelector('[data-testid="message-work-disclosure"] button')?.getAttribute('aria-expanded'))
      .toBe('false');
    allSuccess.unmount();
  });

  it('Scenario 3: demotes additional primary views and emits a structured warning', async () => {
    const secondPrimary: McpAppUiMeta = {
      ...uiMeta,
      resourceUri: 'ui://google-workspace/compose-email-secondary',
      viewSummary: 'Second email draft ready.',
      viewRoleLabel: 'Secondary email draft',
    };
    const rendered = renderMessageItem(makeProps({
      turnStepContext: makeTurnStepContextFromTools([
        makeTool({ toolUseId: 'tool-lead' }),
        makeTool({
          toolUseId: 'tool-demoted',
          label: 'Compose follow-up',
          mcpAppUiMeta: secondPrimary,
        }),
      ]),
    }));
    await flushPromises();

    expect(rendered.container.querySelector('[data-testid="mcp-app-primary-view"]')).toBeTruthy();
    expect(rendered.container.querySelectorAll('[data-testid="additional-view-row"]')).toHaveLength(1);
    expect((window as unknown as { api: { logEvent: ReturnType<typeof vi.fn> } }).api.logEvent)
      .toHaveBeenCalledWith(expect.objectContaining({
        level: 'warn',
        message: 'Multiple primary views in single turn — first emitted wins; others demoted',
        context: expect.objectContaining({
          toolUseIds: ['tool-lead', 'tool-demoted'],
          selectedLeadToolUseId: 'tool-lead',
          demotedToolUseIds: ['tool-demoted'],
          resourceUris: {
            lead: 'ui://google-workspace/compose-email',
            demoted: ['ui://google-workspace/compose-email-secondary'],
          },
        }),
      }));

    rendered.unmount();
  });

  it('Scenario 3 determinism: keeps the first-emitted primary as lead even when it appears after a faster completion', async () => {
    const fasterSecondPrimary: McpAppUiMeta = {
      ...uiMeta,
      resourceUri: 'ui://google-workspace/faster-secondary',
      viewSummary: 'Second-emitted primary completed first.',
      viewRoleLabel: 'Second emitted view',
    };
    const slowerFirstPrimary: McpAppUiMeta = {
      ...uiMeta,
      resourceUri: 'ui://google-workspace/slower-lead',
      viewSummary: 'First-emitted primary completed later.',
      viewRoleLabel: 'First emitted view',
    };

    const rendered = renderMessageItem(makeProps({
      turnStepContext: makeTurnStepContextFromTools([
        makeTool({
          toolUseId: 'tool-b',
          emissionIndex: 1,
          emissionTimestamp: 20,
          mcpAppUiMeta: fasterSecondPrimary,
        }),
        makeTool({
          toolUseId: 'tool-a',
          emissionIndex: 0,
          emissionTimestamp: 10,
          mcpAppUiMeta: slowerFirstPrimary,
        }),
      ]),
    }));
    await flushPromises();

    expect(rendered.container.querySelector('[data-testid="mcp-app-primary-view"]')?.textContent)
      .toContain('First emitted view');
    expect(rendered.container.querySelector('[data-testid="additional-view-row"]')?.textContent)
      .toContain('Second emitted view');

    rendered.unmount();
  });

  it('Scenario 3 expand: opens the demoted primary view in place', async () => {
    const secondPrimary: McpAppUiMeta = {
      ...uiMeta,
      resourceUri: 'ui://google-workspace/compose-email-secondary',
      viewSummary: 'Second email draft ready.',
      viewRoleLabel: 'Secondary email draft',
    };
    const rendered = renderMessageItem(makeProps({
      turnStepContext: makeTurnStepContextFromTools([
        makeTool({ toolUseId: 'tool-lead' }),
        makeTool({
          toolUseId: 'tool-demoted',
          label: 'Compose follow-up',
          mcpAppUiMeta: secondPrimary,
        }),
      ]),
    }));
    await flushPromises();

    const row = rendered.container.querySelector('[data-testid="additional-view-row"]');
    act(() => row?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await flushPromises();

    expect(row?.getAttribute('aria-expanded')).toBe('true');
    const controlledRegionId = row?.getAttribute('aria-controls');
    expect(controlledRegionId).toBeTruthy();
    expect(rendered.container.querySelector('[data-testid="additional-view-expanded"]')).toBeTruthy();
    expect(rendered.container.querySelector('[data-testid="additional-view-expanded"]')?.id)
      .toBe(controlledRegionId);
    expect(rendered.container.querySelector('[data-testid="additional-view-expanded"]')?.textContent)
      .toContain('Secondary email draft');

    rendered.unmount();
  });

  it('Scenario 4: preserves inline-only MCP App rendering without work disclosure', async () => {
    const rendered = renderMessageItem(makeProps({
      turnStepContext: makeTurnStepContext(inlineUiMeta),
    }));
    await flushPromises();

    expect(rendered.container.querySelector('[data-testid="message-work-disclosure"]')).toBeNull();
    expect(rendered.container.querySelector('iframe')).toBeTruthy();
    expect(rendered.container.querySelector('[data-testid="mcp-app-primary-view"]')).toBeNull();
    expect(rendered.container.querySelector('[data-testid="primary-view-source-strip"]')).toBeNull();

    rendered.unmount();
  });

  it('renders short prose as a compact caption above a primary view', async () => {
    const rendered = renderMessageItem(makeProps({
      message: { ...message, text: 'Drafted the email for review.' },
    }));
    await flushPromises();

    const caption = rendered.container.querySelector('[data-testid="mcp-app-primary-caption"]');
    expect(caption?.textContent).toContain('Drafted the email for review.');
    expect(caption?.textContent).not.toContain('Draft ready. Tweak before sending.');
    expect(caption?.textContent).not.toContain("Show Rebel's note");

    rendered.unmount();
  });

  it('renders long prose with a Show Rebel’s note disclosure', async () => {
    const longProse = [
      'Drafted the email for review.',
      'I also checked the source notes, reconciled the names, and kept the tone deliberately calm because apparently emails work better when they do not read like a hostage note.',
      'The draft is ready below.',
    ].join(' ');
    const rendered = renderMessageItem(makeProps({
      message: { ...message, text: longProse },
    }));
    await flushPromises();

    const caption = rendered.container.querySelector('[data-testid="mcp-app-primary-caption"]');
    expect(caption?.textContent).toContain('Drafted the email for review.');
    const button = Array.from(rendered.container.querySelectorAll('button'))
      .find((candidate) => candidate.textContent === "Show Rebel's note");
    expect(button).toBeTruthy();
    expect(button?.getAttribute('aria-expanded')).toBe('false');

    act(() => button?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(button?.getAttribute('aria-expanded')).toBe('true');
    expect(caption?.textContent).toContain('hostage note');

    rendered.unmount();
  });

  it.each([
    ['keeps p.m. abbreviations inside a single sentence', 'Sent at 3:45 p.m. with delivery receipt.', 'Sent at 3:45 p.m. with delivery receipt.', false],
    ['keeps title abbreviations with the first sentence', 'Mr. Smith approved it. Next we can send it.', 'Mr. Smith approved it.', true],
    ['keeps numbered list prefixes inside the sentence', '1. Do this thing first.', '1. Do this thing first.', false],
    ['keeps markdown prefixes inside the sentence', '**Note:** here is the thing.', '**Note:** here is the thing.', false],
    ['ignores periods inside markdown bold markers', '**Note.** here is the thing.', '**Note.** here is the thing.', false],
  ] as const)('sentence detection: %s', async (_label, prose, expectedCompact, shouldShowDisclosure) => {
    const rendered = renderMessageItem(makeProps({
      message: { ...message, text: prose },
    }));
    await flushPromises();

    const caption = rendered.container.querySelector('[data-testid="mcp-app-primary-caption"]');
    expect(caption?.querySelector('p')?.textContent).toBe(expectedCompact);
    const disclosure = Array.from(rendered.container.querySelectorAll('button'))
      .find((candidate) => candidate.textContent === "Show Rebel's note");
    expect(Boolean(disclosure)).toBe(shouldShowDisclosure);

    rendered.unmount();
  });

  it('does not truncate long prose without a sentence boundary', async () => {
    const noPeriodLongProse = Array.from({ length: 32 }, () => 'carefully preserved prose').join(' ');
    expect(noPeriodLongProse.length).toBeGreaterThan(240);

    const rendered = renderMessageItem(makeProps({
      message: { ...message, text: noPeriodLongProse },
    }));
    await flushPromises();

    const caption = rendered.container.querySelector('[data-testid="mcp-app-primary-caption"]');
    expect(caption?.querySelector('p')?.textContent).toBe(noPeriodLongProse);
    expect(Array.from(rendered.container.querySelectorAll('button'))
      .some((candidate) => candidate.textContent === "Show Rebel's note")).toBe(false);

    rendered.unmount();
  });

  it('renders the structured caption default when assistant prose is empty', async () => {
    const rendered = renderMessageItem(makeProps({
      message: { ...message, text: '' },
    }));
    await flushPromises();

    expect(rendered.container.querySelector('[data-testid="mcp-app-primary-view"]')).toBeTruthy();
    expect(rendered.container.querySelector('[data-testid="mcp-app-primary-caption"]')?.textContent)
      .toContain('Draft ready. Tweak before sending.');

    rendered.unmount();
  });

  it('keeps inline work disclosure available when a primary view fails', async () => {
    (window as unknown as { mcpAppsApi: { readResource: ReturnType<typeof vi.fn> } }).mcpAppsApi.readResource
      .mockRejectedValueOnce(new Error('resource fetch failed'));
    const rendered = renderMessageItem(makeProps({
      turnStepContext: makeTurnStepContextFromTools([
        makeTool(),
        makeTool({
          label: 'Inline research',
          detail: 'Read the quarterly plan',
          icon: '📄',
          toolName: 'custom_lookup',
          toolUseId: 'tool-inline',
          mcpAppUiMeta: undefined,
        }),
      ]),
    }));
    await flushPromises();

    expectRecoveryNoticeStructure(rendered.container);
    const strip = rendered.container.querySelector('[data-testid="primary-view-source-strip"]');
    const notice = rendered.container.querySelector('[data-testid="mcp-app-recovery-notice"]');
    expect(strip).toBeTruthy();
    expect(notice).toBeTruthy();
    if (!strip || !notice) throw new Error('Expected strip and recovery notice');
    expect(Boolean(strip.compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING))
      .toBe(true);
    expect(strip.querySelector('button')?.getAttribute('aria-label'))
      .toContain('This view failed to load. Rebel is showing a summary instead.');
    expect(rendered.container.querySelector('[data-testid="message-work-disclosure"]')).toBeTruthy();

    rendered.unmount();
  });

  it('adds primary view screen-reader labels and a composed iframe title', async () => {
    const rendered = renderMessageItem(makeProps());
    await flushPromises();

    const region = rendered.container.querySelector('[data-testid="mcp-app-primary-view"]');
    expect(region).toBeTruthy();
    expect(region?.hasAttribute('aria-label')).toBe(false);
    const describedBy = region?.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    const descriptionText = (describedBy ?? '')
      .split(/\s+/u)
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ');
    expect(descriptionText)
      .toContain('Email draft to alice@example.com about the Q2 plan.');
    expect(descriptionText).not.toContain('Editable email draft');
    expect(descriptionText).not.toContain('From Google Workspace');
    expect(descriptionText).not.toContain('Safe view');
    expect(rendered.container.querySelector('[data-testid="primary-view-source-strip"]')?.textContent)
      .toContain('Editable email draft');
    expect(rendered.container.querySelector('[data-testid="primary-view-source-strip"]')?.textContent)
      .toContain('From Google Workspace');
    expect(rendered.container.querySelector('iframe')?.getAttribute('title'))
      .toBe('Editable email draft from Google Workspace');

    rendered.unmount();
  });

  it('renders a Notice recovery surface with prose, summary, fallback text, retry, and copy action', async () => {
    (window as unknown as { mcpAppsApi: { readResource: ReturnType<typeof vi.fn> } }).mcpAppsApi.readResource
      .mockRejectedValueOnce(new Error('resource fetch failed'));
    const onCopyToClipboard = vi.fn();
    const rendered = renderMessageItem(makeProps({ onCopyToClipboard }));
    await flushPromises();

    expectRecoveryNoticeStructure(rendered.container);

    const disclosure = Array.from(rendered.container.querySelectorAll('button'))
      .find((button) => button.textContent === "Show Rebel's note");
    expect(disclosure).toBeTruthy();
    act(() => disclosure?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(rendered.container.textContent).toContain('Here is the full assistant prose');

    const copyButton = rendered.container.querySelector('[data-testid="mcp-app-copy-fallback-button"]');
    act(() => copyButton?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await flushPromises();
    expect(onCopyToClipboard).toHaveBeenCalledWith(expect.stringContaining('To: alice@example.com, bob@example.com'));

    const retryButton = rendered.container.querySelector('[data-testid="mcp-app-retry-button"]');
    act(() => retryButton?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await flushPromises();
    expect((window as unknown as { mcpAppsApi: { readResource: ReturnType<typeof vi.fn> } }).mcpAppsApi.readResource)
      .toHaveBeenCalledTimes(2);

    rendered.unmount();
  });

  it('hides the host copy affordance for primary views until sendMessage delegation is first-class', async () => {
    const onCopyToClipboard = vi.fn();
    const rendered = renderMessageItem(makeProps({ onCopyToClipboard }));
    await flushPromises();

    expect(rendered.container.querySelector('[data-testid="message-copy-button"]')).toBeNull();
    expect(onCopyToClipboard).not.toHaveBeenCalled();

    rendered.unmount();
  });

  it('reports clipboard write rejection without triggering copy success', async () => {
    const onCopyToClipboard = vi.fn();
    const showToast = vi.fn();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(async () => { throw new Error('clipboard denied'); }) },
    });
    const rendered = renderMessageItem(makeProps({
      onCopyToClipboard,
      showToast,
      turnStepContext: makeTurnStepContextFromTools([]),
    }));
    await flushPromises();

    const copyButton = rendered.container.querySelector('[data-testid="message-copy-button"]');
    act(() => copyButton?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await flushPromises();

    expect(onCopyToClipboard).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith({ title: 'Couldn’t copy to clipboard' });
    expect(warnSpy).toHaveBeenCalledWith('Clipboard write failed', expect.any(Error));

    warnSpy.mockRestore();
    rendered.unmount();
  });

  it('renders recovery Notice when the iframe error handler fires', async () => {
    const rendered = renderMessageItem(makeProps());
    await flushPromises();

    const iframe = rendered.container.querySelector('iframe');
    expect(iframe).toBeTruthy();
    act(() => iframe?.dispatchEvent(new Event('error', { bubbles: true })));
    await flushPromises();

    expectRecoveryNoticeStructure(rendered.container);
    rendered.unmount();
  });

  it('renders recovery Notice when the iframe reports rebel-preview-error', async () => {
    const rendered = renderMessageItem(makeProps());
    await flushPromises();

    const iframe = rendered.container.querySelector('iframe');
    expect(iframe?.contentWindow).toBeTruthy();
    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        origin: 'null',
        source: iframe?.contentWindow ?? null,
        data: { type: 'rebel-preview-error', errors: ['runtime exploded'] },
      }));
    });

    expectRecoveryNoticeStructure(rendered.container);
    rendered.unmount();
  });

  it('renders recovery Notice when the iframe emits a CSP violation', async () => {
    const rendered = renderMessageItem(makeProps());
    await flushPromises();

    const iframe = rendered.container.querySelector('iframe');
    expect(iframe?.contentWindow).toBeTruthy();
    act(() => iframe?.dispatchEvent(new Event('load')));
    act(() => iframe?.contentWindow?.dispatchEvent(new Event('securitypolicyviolation')));

    expectRecoveryNoticeStructure(rendered.container);
    rendered.unmount();
  });

  it('renders recovery Notice when a loaded iframe never reports ready content', async () => {
    vi.useFakeTimers();
    const rendered = renderMessageItem(makeProps());
    await flushPromises();

    const iframe = rendered.container.querySelector('iframe');
    expect(iframe).toBeTruthy();
    act(() => iframe?.dispatchEvent(new Event('load')));
    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expectRecoveryNoticeStructure(rendered.container);

    vi.useRealTimers();
    rendered.unmount();
  });
});
