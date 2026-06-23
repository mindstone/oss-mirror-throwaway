import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SAFETY_EVAL_PROCESS_BOOT_ID } from '@core/safetyEvalProcessIdentity';

const {
  mockConnect,
  mockCallTool,
  mockClose,
  mockTerminateSession,
  mockGetState,
  storeState,
  readOnlyFlag,
} = vi.hoisted(() => ({
  mockConnect: vi.fn(),
  mockCallTool: vi.fn(),
  mockClose: vi.fn(),
  mockTerminateSession: vi.fn(),
  mockGetState: vi.fn(),
  readOnlyFlag: { value: false },
  storeState: {
    version: 1,
    stagedCalls: [] as Array<Record<string, unknown>>,
  },
}));

vi.mock('@core/storeFactory', () => ({
  createStore: vi.fn(() => ({
    get: (key: string, fallback: unknown) => (
      key in storeState ? (storeState as Record<string, unknown>)[key] : fallback
    ),
    set: (key: string, value: unknown) => {
      (storeState as Record<string, unknown>)[key] = value;
    },
  })),
}));

vi.mock('@core/userDataWriteGate', () => ({
  isUserDataReadOnly: () => readOnlyFlag.value,
}));

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    connect = mockConnect;
    callTool = mockCallTool;
    close = mockClose;
    constructor() {
      // no-op
    }
  },
}));

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class {
    terminateSession = mockTerminateSession;
    constructor(_url: URL) {
      // no-op
    }
  },
}));

vi.mock('../../superMcpHttpManager', () => ({
  superMcpHttpManager: {
    getState: () => mockGetState(),
  },
}));

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import {
  clearAllStagedCalls,
  executeStagedCall,
  getStagedCall,
  getStagedCalls,
  removeStagedCall,
  stageToolCall,
  type StageToolCallInput,
} from '../stagedToolCallsService';

type StageToolCallTestInput =
  Omit<StageToolCallInput, 'blockedBy'>
  & Partial<Pick<StageToolCallInput, 'blockedBy'>>;

function stageToolCallForTest(input: StageToolCallTestInput) {
  return stageToolCall({ blockedBy: 'safety_prompt', ...input });
}

describe('stagedToolCallsService executeStagedCall', () => {
  beforeEach(() => {
    mockConnect.mockReset();
    mockCallTool.mockReset();
    mockClose.mockReset();
    mockTerminateSession.mockReset();
    mockGetState.mockReset();

    mockConnect.mockResolvedValue(undefined);
    mockClose.mockResolvedValue(undefined);
    mockTerminateSession.mockResolvedValue(undefined);
    mockGetState.mockReturnValue({ isRunning: true, url: 'http://127.0.0.1:3100/mcp' });

    storeState.version = 1;
    storeState.stagedCalls = [];
    readOnlyFlag.value = false;
    clearAllStagedCalls();
  });

  it('keeps staged calls actionable in memory when userData is read-only', async () => {
    readOnlyFlag.value = true;

    const staged = stageToolCallForTest({
      sessionId: 'read-only-session',
      turnId: 'turn-read-only',
      mcpPayload: {
        packageId: 'Slack-mindstone',
        toolId: 'Slack-mindstone__open_slack_dm',
        args: { user: 'U064N49HQE7' },
      },
      displayName: 'Open slack dm',
      toolCategory: 'side-effect',
      riskLevel: 'high',
    }).call;

    expect(storeState.stagedCalls).toEqual([]);
    expect(getStagedCall(staged.id)?.status).toBe('pending');
    expect(getStagedCalls('read-only-session')).toHaveLength(1);

    mockCallTool.mockResolvedValueOnce({
      isError: false,
      content: [{ type: 'text', text: 'DM opened.' }],
    });

    const outcome = await executeStagedCall(staged.id);

    expect(outcome.status).toBe('executed');
    expect(outcome.result.success).toBe(true);
    expect(getStagedCall(staged.id)?.status).toBe('executed');
    expect(storeState.stagedCalls).toEqual([]);
  });

  it('suppresses removed store-backed calls in memory when userData is read-only', () => {
    storeState.stagedCalls = [
      {
        id: 'persisted-read-only-call',
        sessionId: 'read-only-session',
        turnId: 'turn-read-only',
        timestamp: Date.now(),
        expiresAt: Date.now() + 86_400_000,
        status: 'pending',
        mcpPayload: {
          packageId: 'Slack-mindstone',
          toolId: 'Slack-mindstone__open_slack_dm',
          args: { user: 'U064N49HQE7' },
        },
        displayName: 'Open slack dm',
        toolCategory: 'side-effect',
        riskLevel: 'high',
      },
    ];
    readOnlyFlag.value = true;

    expect(getStagedCalls('read-only-session')).toHaveLength(1);

    removeStagedCall('persisted-read-only-call');

    expect(storeState.stagedCalls).toHaveLength(1);
    expect(getStagedCall('persisted-read-only-call')).toBeUndefined();
    expect(getStagedCalls('read-only-session')).toEqual([]);
  });

  it('marks staged execution as failed when use_tool returns isError=true and preserves all text blocks', async () => {
    mockCallTool.mockResolvedValueOnce({
      isError: true,
      content: [
        { type: 'text', text: 'First failure detail.' },
        { type: 'text', text: 'Second failure detail.' },
      ],
    });

    const staged = stageToolCallForTest({
      sessionId: 'session-1',
      turnId: 'turn-1',
      mcpPayload: {
        packageId: 'pkg1',
        toolId: 'tool1',
        args: { query: 'abc' },
      },
      displayName: 'Pkg1 Tool1',
      toolCategory: 'read-only',
      riskLevel: 'low',
    }).call;

    const outcome = await executeStagedCall(staged.id);

    expect(outcome.status).toBe('failed');
    expect(outcome.result.success).toBe(false);
    expect(outcome.result.error).toContain('[pkg1/tool1]');
    expect(outcome.result.error).toContain('First failure detail.');
    expect(outcome.result.error).toContain('Second failure detail.');

    expect(mockCallTool).toHaveBeenCalledWith(
      {
        name: 'use_tool',
        arguments: {
          package_id: 'pkg1',
          tool_id: 'tool1',
          args: { query: 'abc' },
        },
      },
      undefined,
      { timeout: 60000 },
    );

    const persisted = getStagedCall(staged.id);
    expect(persisted?.status).toBe('failed');
    expect(persisted?.result?.success).toBe(false);
    expect(persisted?.result?.error).toContain('Second failure detail.');
  });

  it('uses failure fallback text when use_tool returns isError=true with no text blocks', async () => {
    mockCallTool.mockResolvedValueOnce({
      isError: true,
      content: [],
    });

    const staged = stageToolCallForTest({
      sessionId: 'session-2',
      turnId: 'turn-2',
      mcpPayload: {
        packageId: 'pkg2',
        toolId: 'tool2',
        args: { query: 'xyz' },
      },
      displayName: 'Pkg2 Tool2',
      toolCategory: 'read-only',
      riskLevel: 'low',
    }).call;

    const outcome = await executeStagedCall(staged.id);

    expect(outcome.status).toBe('failed');
    expect(outcome.result.success).toBe(false);
    expect(outcome.result.error).toContain('[pkg2/tool2]');
    expect(outcome.result.error).toContain('Tool execution failed');
    expect(outcome.result.error).not.toContain('Tool executed successfully');

    const persisted = getStagedCall(staged.id);
    expect(persisted?.status).toBe('failed');
    expect(persisted?.result?.success).toBe(false);
    expect(persisted?.result?.error).toContain('Tool execution failed');
    expect(persisted?.result?.error).not.toContain('Tool executed successfully');
  });

  it('extracts readable text from non-Error object failures instead of leaking raw JSON', async () => {
    mockCallTool.mockRejectedValueOnce({
      code: 'VALIDATION_ERROR',
      error: {
        message: 'The tool input was invalid.',
      },
    });

    const staged = stageToolCallForTest({
      sessionId: 'session-3',
      turnId: 'turn-3',
      mcpPayload: {
        packageId: 'pkg3',
        toolId: 'tool3',
        args: { query: 'invalid' },
      },
      displayName: 'Pkg3 Tool3',
      toolCategory: 'read-only',
      riskLevel: 'low',
    }).call;

    const outcome = await executeStagedCall(staged.id);

    expect(outcome.status).toBe('failed');
    expect(outcome.result.success).toBe(false);
    expect(outcome.result.error).toContain('[pkg3/tool3]');
    expect(outcome.result.error).toContain('The tool input was invalid.');
    expect(outcome.result.error).not.toContain('{"');
    expect(outcome.result.error).not.toContain('VALIDATION_ERROR');
  });

  it('uses a friendly fallback for non-Error object failures without a message', async () => {
    mockCallTool.mockRejectedValueOnce({
      code: 'UNKNOWN_FAILURE',
      metadata: {
        requestId: 'req-123',
      },
    });

    const staged = stageToolCallForTest({
      sessionId: 'session-4',
      turnId: 'turn-4',
      mcpPayload: {
        packageId: 'pkg4',
        toolId: 'tool4',
        args: { query: 'abc' },
      },
      displayName: 'Pkg4 Tool4',
      toolCategory: 'read-only',
      riskLevel: 'low',
    }).call;

    const outcome = await executeStagedCall(staged.id);

    expect(outcome.status).toBe('failed');
    expect(outcome.result.success).toBe(false);
    expect(outcome.result.error).toContain('[pkg4/tool4]');
    expect(outcome.result.error).toContain('The approved action failed.');
    expect(outcome.result.error).not.toContain('{"');
    expect(outcome.result.error).not.toContain('UNKNOWN_FAILURE');
    expect(outcome.result.error).not.toContain('req-123');
  });

  it('coalesces by coalesceKey using first-wins semantics without replacing payload', () => {
    const first = stageToolCallForTest({
      sessionId: 'session-coalesce',
      turnId: 'turn-first',
      mcpPayload: {
        packageId: 'linear',
        toolId: 'create_issue',
        args: { title: 'Create me' },
      },
      displayName: 'Linear → create_issue',
      toolCategory: 'side-effect',
      riskLevel: 'high',
      coalesceKey: 'safety-eval-cooldown-gen-1',
    });

    const second = stageToolCallForTest({
      sessionId: 'session-coalesce',
      turnId: 'turn-second',
      mcpPayload: {
        packageId: 'linear',
        toolId: 'delete_issue',
        args: { issueId: 'FOX-1' },
      },
      displayName: 'Linear → delete_issue',
      toolCategory: 'side-effect',
      riskLevel: 'high',
      coalesceKey: 'safety-eval-cooldown-gen-1',
    });

    expect(first.coalesced).toBe(false);
    expect(second.coalesced).toBe(true);
    expect(second.call.id).toBe(first.call.id);
    expect(second.call.mcpPayload).toEqual({
      packageId: 'linear',
      toolId: 'create_issue',
      args: { title: 'Create me' },
    });
    expect(getStagedCall(first.call.id)?.mcpPayload).toEqual(first.call.mcpPayload);
    expect(storeState.stagedCalls).toHaveLength(1);
  });

  it('does not coalesce staged calls that belong to different cooldown generation keys', () => {
    const first = stageToolCallForTest({
      sessionId: 'session-cross-window',
      turnId: 'turn-window-a',
      mcpPayload: {
        packageId: 'linear',
        toolId: 'create_issue',
        args: { title: 'Window A' },
      },
      displayName: 'Linear → create_issue',
      toolCategory: 'side-effect',
      riskLevel: 'high',
      coalesceKey: 'safety-eval-cooldown-gen-10',
    });

    const second = stageToolCallForTest({
      sessionId: 'session-cross-window',
      turnId: 'turn-window-b',
      mcpPayload: {
        packageId: 'linear',
        toolId: 'delete_issue',
        args: { issueId: 'FOX-10' },
      },
      displayName: 'Linear → delete_issue',
      toolCategory: 'side-effect',
      riskLevel: 'high',
      coalesceKey: 'safety-eval-cooldown-gen-11',
    });

    expect(first.coalesced).toBe(false);
    expect(second.coalesced).toBe(false);
    expect(second.call.id).not.toBe(first.call.id);
    expect(storeState.stagedCalls).toHaveLength(2);
  });

  it('does not fall back to args-based replacement when input has an unmatched coalesceKey', () => {
    const first = stageToolCallForTest({
      sessionId: 'session-coalesce-unmatched',
      turnId: 'turn-without-coalesce',
      mcpPayload: {
        packageId: 'linear',
        toolId: 'create_issue',
        args: { title: 'Same args' },
      },
      displayName: 'Linear → create_issue',
      toolCategory: 'side-effect',
      riskLevel: 'high',
      reason: 'Original non-coalesced card',
    });

    const second = stageToolCallForTest({
      sessionId: 'session-coalesce-unmatched',
      turnId: 'turn-with-coalesce',
      mcpPayload: {
        packageId: 'linear',
        toolId: 'create_issue',
        args: { title: 'Same args' },
      },
      displayName: 'Linear → create_issue',
      toolCategory: 'side-effect',
      riskLevel: 'high',
      reason: 'Rate-limited coalesced card',
      blockedBy: 'eval_error',
      coalesceKey: 'safety-eval-cooldown-current-gen-1',
    });

    expect(first.coalesced).toBe(false);
    expect(second.coalesced).toBe(false);
    expect(second.call.id).not.toBe(first.call.id);
    expect(getStagedCall(first.call.id)?.reason).toBe('Original non-coalesced card');
    expect(getStagedCall(second.call.id)?.coalesceKey).toBe('safety-eval-cooldown-current-gen-1');
    expect(storeState.stagedCalls).toHaveLength(2);
  });

  it('does not coalesce post-restart calls into persisted prior-process cooldown keys', () => {
    const oldProcessKey = 'safety-eval-cooldown-OLD_BOOT_ID-gen-1';
    const currentProcessKey = `safety-eval-cooldown-${SAFETY_EVAL_PROCESS_BOOT_ID}-gen-1`;

    const oldProcessCall = stageToolCallForTest({
      sessionId: 'session-cross-process',
      turnId: 'turn-old-process',
      mcpPayload: {
        packageId: 'linear',
        toolId: 'create_issue',
        args: { title: 'Same args across restart' },
      },
      displayName: 'Linear → create_issue',
      toolCategory: 'side-effect',
      riskLevel: 'high',
      reason: 'Old process pending card',
      coalesceKey: oldProcessKey,
    });

    const currentProcessCall = stageToolCallForTest({
      sessionId: 'session-cross-process',
      turnId: 'turn-current-process',
      mcpPayload: {
        packageId: 'linear',
        toolId: 'create_issue',
        args: { title: 'Same args across restart' },
      },
      displayName: 'Linear → create_issue',
      toolCategory: 'side-effect',
      riskLevel: 'high',
      reason: 'Current process pending card',
      coalesceKey: currentProcessKey,
    });

    expect(currentProcessKey).not.toBe(oldProcessKey);
    expect(oldProcessCall.coalesced).toBe(false);
    expect(currentProcessCall.coalesced).toBe(false);
    expect(currentProcessCall.call.id).not.toBe(oldProcessCall.call.id);
    expect(getStagedCall(oldProcessCall.call.id)?.reason).toBe('Old process pending card');
    expect(getStagedCall(currentProcessCall.call.id)?.reason).toBe('Current process pending card');
    expect(storeState.stagedCalls).toHaveLength(2);
  });

  it('backfills safety_prompt for legacy persisted staged calls with the safety prefix', () => {
    storeState.stagedCalls = [
      {
        id: 'legacy-staged-safety',
        sessionId: 'session-legacy',
        turnId: 'turn-legacy',
        timestamp: Date.now(),
        expiresAt: Date.now() + 86_400_000,
        status: 'pending',
        mcpPayload: {
          packageId: 'slack',
          toolId: 'post_slack_message',
          args: { channel: 'C123', text: 'hello' },
        },
        displayName: 'Send Slack message',
        toolCategory: 'side-effect',
        riskLevel: 'high',
        reason: 'Safety Rules blocked: outbound messages require review',
      },
    ];

    expect(getStagedCall('legacy-staged-safety')).toEqual(
      expect.objectContaining({ blockedBy: 'safety_prompt' }),
    );
    expect(storeState.stagedCalls[0]).not.toHaveProperty('blockedBy');
  });

  it('does not backfill non-safety reasons for legacy persisted staged calls', () => {
    storeState.stagedCalls = [
      {
        id: 'legacy-staged-generic',
        sessionId: 'session-legacy',
        turnId: 'turn-legacy',
        timestamp: Date.now(),
        expiresAt: Date.now() + 86_400_000,
        status: 'pending',
        mcpPayload: {
          packageId: 'slack',
          toolId: 'post_slack_message',
          args: { channel: 'C123', text: 'hello' },
        },
        displayName: 'Send Slack message',
        toolCategory: 'side-effect',
        riskLevel: 'high',
        reason: 'Some other reason',
      },
    ];

    const stagedCall = getStagedCall('legacy-staged-generic');
    expect(stagedCall).toEqual(
      expect.objectContaining({ id: 'legacy-staged-generic' }),
    );
    expect(stagedCall?.blockedBy).toBeUndefined();
    expect(storeState.stagedCalls[0]).not.toHaveProperty('blockedBy');
  });

  it('does not overwrite existing eval_error blockedBy on prefixed persisted staged calls', () => {
    storeState.stagedCalls = [
      {
        id: 'legacy-staged-eval',
        sessionId: 'session-legacy',
        turnId: 'turn-legacy',
        timestamp: Date.now(),
        expiresAt: Date.now() + 86_400_000,
        status: 'pending',
        mcpPayload: {
          packageId: 'slack',
          toolId: 'post_slack_message',
          args: { channel: 'C123', text: 'hello' },
        },
        displayName: 'Send Slack message',
        toolCategory: 'side-effect',
        riskLevel: 'high',
        reason: 'Safety Rules blocked: outbound messages require review',
        blockedBy: 'eval_error',
      },
    ];

    expect(getStagedCall('legacy-staged-eval')).toEqual(
      expect.objectContaining({ blockedBy: 'eval_error' }),
    );
  });
});
