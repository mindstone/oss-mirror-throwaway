import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  safetyChannels,
  STAGED_CALL_NOT_FOUND_ERROR,
  StagedCallResultSchema,
} from '@shared/ipc/channels/safety';
import { registerSafetyHandlers } from '../safetyHandlers';
import type { StagedToolCall } from '../../services/safety/stagedToolCallsService';

const { registeredHandlers } = vi.hoisted(() => ({
  registeredHandlers: new Map<string, (event: unknown, request: unknown) => unknown>(),
}));

const { stagedCallMocks } = vi.hoisted(() => ({
  stagedCallMocks: {
    getStagedCalls: vi.fn(),
    getPendingStagedCalls: vi.fn(),
    executeStagedCall: vi.fn(),
    executeStagedBatch: vi.fn(),
    rejectStagedCall: vi.fn(),
    clearSessionStagedCalls: vi.fn(),
    cleanupExpiredStagedCalls: vi.fn(),
    STAGED_CALL_NOT_FOUND_ERROR: 'Staged call not found',
  },
}));

const { broadcastMocks } = vi.hoisted(() => ({
  broadcastMocks: {
    service: { sendToAllWindows: vi.fn(), sendToFocusedWindow: vi.fn() },
    broadcastTypedPayload: vi.fn(),
  },
}));

const { automationTrackerMocks } = vi.hoisted(() => ({
  automationTrackerMocks: {
    resolveItem: vi.fn(),
    rebuildFromStores: vi.fn(),
  },
}));

const { loggerMocks } = vi.hoisted(() => ({
  loggerMocks: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../utils/registerHandler', () => ({
  registerHandler: vi.fn((channel: string, handler: (event: unknown, request: unknown) => unknown) => {
    registeredHandlers.set(channel, handler);
  }),
}));

vi.mock('@core/logger', () => ({
  createScopedLogger: vi.fn(() => loggerMocks),
}));

vi.mock('@core/broadcastService', async () => {
  const { createBroadcastServiceMock } = await import('@shared/__tests__/testModuleMocks');
  return createBroadcastServiceMock({ getBroadcastService: () => broadcastMocks.service });
});

vi.mock('@shared/ipc/broadcasts', () => ({
  broadcastTypedPayload: broadcastMocks.broadcastTypedPayload,
}));

vi.mock('../../services/safety', () => ({
  getPendingApprovals: vi.fn(() => []),
}));

vi.mock('../../services/safety/stagedToolCallsService', () => stagedCallMocks);

vi.mock('../../services/safety/sanitizeApprovalInput', () => ({
  sanitizeStagedToolCallForApproval: vi.fn((call: unknown) => call),
}));

vi.mock('../../services/safety/automationPendingItemsTracker', () => automationTrackerMocks);

function makePendingStagedCall(overrides: Partial<StagedToolCall> = {}): StagedToolCall {
  return {
    id: 'staged-call-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    timestamp: 1_000,
    expiresAt: 2_000,
    status: 'pending',
    mcpPayload: {
      packageId: 'pkg-1',
      toolId: 'tool-1',
      args: { query: 'status' },
    },
    displayName: 'Check status',
    toolCategory: 'side-effect',
    automationId: 'automation-1',
    automationName: 'Morning check',
    ...overrides,
  };
}

function registerAndGetStagedExecuteHandler(): (event: unknown, request: { id: string }) => Promise<unknown> {
  registerSafetyHandlers({});
  const handler = registeredHandlers.get('tool-safety:staged-execute');
  expect(handler).toBeDefined();
  return handler as (event: unknown, request: { id: string }) => Promise<unknown>;
}

// SCOPE (would-have-caught audit, 2026-06-06): this is a FORWARD-LOOKING
// handler-shape contract (StagedCallResult envelope + fail-closed
// STAGED_CALL_NOT_FOUND + terminal broadcast). It does NOT cover the historical
// staged-approval postmortem cluster (260412/260330/260505/260506) — those bugs
// were at the verdict/routing/metadata layers, guarded by the Stage-10
// toolSafetyService.verdictRouting integration test, not by this handler-shape pin.
describe('tool-safety:staged-execute IPC behavioral contract', () => {
  beforeEach(() => {
    registeredHandlers.clear();
    vi.clearAllMocks();
    vi.stubGlobal('setInterval', vi.fn());
    stagedCallMocks.getStagedCalls.mockReturnValue([]);
    stagedCallMocks.getPendingStagedCalls.mockReturnValue([]);
    stagedCallMocks.cleanupExpiredStagedCalls.mockReturnValue(0);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('executes a pending staged call, returns the result schema, broadcasts the terminal update, and resolves automation items', async () => {
    const stagedCall = makePendingStagedCall();
    const result = { success: true, content: 'done', executedAt: 1_717_171_717 };
    stagedCallMocks.getStagedCalls.mockReturnValue([stagedCall]);
    stagedCallMocks.executeStagedCall.mockResolvedValue({ status: 'executed', result });
    const handler = registerAndGetStagedExecuteHandler();

    const response = await handler({}, { id: stagedCall.id });

    expect(StagedCallResultSchema.parse(response)).toEqual(result);
    expect(stagedCallMocks.executeStagedCall).toHaveBeenCalledWith(stagedCall.id);
    expect(broadcastMocks.broadcastTypedPayload).toHaveBeenCalledWith(
      broadcastMocks.service,
      'tool-safety:staged-call-updated',
      {
        id: stagedCall.id,
        sessionId: stagedCall.sessionId,
        status: 'executed',
        result,
      },
    );
    expect(automationTrackerMocks.resolveItem).toHaveBeenCalledWith(
      stagedCall.automationId,
      stagedCall.id,
      'approved',
    );
  });

  it('returns the shared fail-closed not-found error shape when no staged call exists', async () => {
    stagedCallMocks.getStagedCalls.mockReturnValue([]);
    const handler = registerAndGetStagedExecuteHandler();

    const response = await handler({}, { id: 'missing-staged-call' });

    const parsed = safetyChannels['tool-safety:staged-execute'].response.parse(response);
    expect(parsed).toEqual({
      success: false,
      error: STAGED_CALL_NOT_FOUND_ERROR,
      executedAt: expect.any(Number),
    });
    expect(stagedCallMocks.executeStagedCall).not.toHaveBeenCalled();
    expect(broadcastMocks.broadcastTypedPayload).not.toHaveBeenCalled();
    expect(automationTrackerMocks.resolveItem).not.toHaveBeenCalled();
  });
});
