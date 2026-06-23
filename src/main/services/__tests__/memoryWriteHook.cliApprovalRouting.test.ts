 
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { SyncHookJSONOutput } from '@core/agentRuntimeTypes';
import { createMemoryWriteHook } from '../safety/memoryWriteHook';

const {
  mockApprovalHandler,
  mockRecordSecurityDenial,
  mockAddPendingMemoryApproval,
  mockSendToAllWindows,
} = vi.hoisted(() => ({
  mockApprovalHandler: vi.fn(),
  mockRecordSecurityDenial: vi.fn(),
  mockAddPendingMemoryApproval: vi.fn(),
  mockSendToAllWindows: vi.fn(),
}));

vi.mock('../agentTurnRegistry', () => ({
  agentTurnRegistry: {
    getApprovalHandler: vi.fn((turnId: string) =>
      turnId === 'turn-with-handler' ? mockApprovalHandler : undefined,
    ),
    recordSecurityDenial: mockRecordSecurityDenial,
    recordToolCall: vi.fn(),
    incrementAutomationSafetyBlock: vi.fn(),
  },
}));

vi.mock('@core/platform', () => ({
  getPlatformConfig: vi.fn().mockReturnValue({
    userDataPath: '/tmp/rebel-user-data',
    homePath: '/Users/test',
  }),
}));

vi.mock('@core/broadcastService', () => ({
  getBroadcastService: vi.fn().mockReturnValue({ sendToAllWindows: mockSendToAllWindows, sendToFocusedWindow: vi.fn() }),
}));

vi.mock('@core/services/settingsStore', () => ({
  getSettings: vi.fn().mockReturnValue({ coreDirectory: '/workspace' }),
}));

vi.mock('../spaceService', () => ({
  scanSpaces: vi.fn().mockReturnValue([]),
  readSpaceReadmeFrontmatter: vi.fn(),
  getSpaceDisplayName: vi.fn((_spacePath: string, fallback: string) => fallback),
}));

vi.mock('@core/currentUserProvider', () => ({
  getCurrentUserProvider: () => ({
    getCurrentUser: vi.fn().mockReturnValue({ id: 'user-1' }),
  }),
  setCurrentUserProviderFactory: vi.fn(),
}));

vi.mock('../sharedSkillMutationService', () => ({
  sharedSkillMutationService: {
    getNonAuthorSharedSkillProtectionContext: vi.fn().mockResolvedValue(null),
    prepareManagedToolInput: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock('../safety/pendingApprovalsStore', () => ({
  addPendingMemoryApproval: mockAddPendingMemoryApproval,
  removePendingMemoryApproval: vi.fn(),
  getPendingMemoryApprovals: vi.fn().mockReturnValue([]),
}));

vi.mock('../safety/sessionApprovals', () => ({
  consumeSingleUseApproval: vi.fn().mockReturnValue(false),
  storeSingleUseApproval: vi.fn(),
}));

vi.mock('../safety/cosPendingService', () => ({
  writeToPending: vi.fn(),
  getPendingFileByDestination: vi.fn().mockResolvedValue(null),
  deletePendingFile: vi.fn(),
}));

vi.mock('../memoryHistoryStore', () => ({
  addApprovedMemoryEntry: vi.fn(),
}));

function makeHook(turnId: string) {
  return createMemoryWriteHook({
    turnId,
    sessionId: turnId,
    originalTurnId: turnId,
    originalSessionId: 'cli-session-test',
    coreDirectory: '/workspace',
    privateMode: true,
  });
}

function writeInput() {
  return {
    tool_name: 'Create',
    tool_use_id: 'tool-1',
    tool_input: {
      file_path: '/workspace/notes.txt',
      content: 'Sensitive note',
      __cachedSummary: 'Sensitive note summary',
    },
  };
}

describe('memory write CLI approval routing', () => {
  const previousDisableStagedWrites = process.env.REBEL_DISABLE_STAGED_WRITES;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.REBEL_DISABLE_STAGED_WRITES = '1';
  });

  afterEach(() => {
    if (previousDisableStagedWrites === undefined) {
      delete process.env.REBEL_DISABLE_STAGED_WRITES;
    } else {
      process.env.REBEL_DISABLE_STAGED_WRITES = previousDisableStagedWrites;
    }
  });

  it('routes blocked memory writes through the registered handler and approves in-place', async () => {
    mockApprovalHandler.mockResolvedValue({ approved: true });
    const hook = makeHook('turn-with-handler');

    const result = await hook(writeInput(), 'tool-1', {
      signal: new AbortController().signal,
    }) as SyncHookJSONOutput;

    expect(mockApprovalHandler).toHaveBeenCalledWith(
      {
        kind: 'memory_write',
        target: '/workspace/notes.txt',
        summary: 'Sensitive note summary',
      },
      expect.any(AbortSignal),
    );
    expect(result).toEqual({});
    expect(mockAddPendingMemoryApproval).not.toHaveBeenCalled();
    expect(mockRecordSecurityDenial).not.toHaveBeenCalled();
    expect(mockSendToAllWindows).not.toHaveBeenCalledWith(
      'memory:write-approval-request',
      expect.anything(),
    );
  });

  it('denies and ends the turn when the registered handler declines', async () => {
    mockApprovalHandler.mockResolvedValue({ approved: false, reason: 'declined' });
    const hook = makeHook('turn-with-handler');

    const result = await hook(writeInput(), 'tool-1', {
      signal: new AbortController().signal,
    }) as SyncHookJSONOutput;

    expect(result.continue).toBe(false);
    expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(result.hookSpecificOutput?.permissionDecisionReason).toBe('declined');
    expect(mockAddPendingMemoryApproval).not.toHaveBeenCalled();
  });

  it('fails closed (deny) when the registered handler throws', async () => {
    mockApprovalHandler.mockRejectedValue(new Error('handler crashed'));
    const hook = makeHook('turn-with-handler');

    const result = await hook(writeInput(), 'tool-1', {
      signal: new AbortController().signal,
    }) as SyncHookJSONOutput;

    expect(result.continue).toBe(false);
    expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(String(result.hookSpecificOutput?.permissionDecisionReason)).toContain('handler crashed');
    expect(mockRecordSecurityDenial).toHaveBeenCalledWith(
      'turn-with-handler',
      'memory_write',
      expect.stringContaining('approval_handler_error'),
    );
    expect(mockAddPendingMemoryApproval).not.toHaveBeenCalled();
    expect(mockSendToAllWindows).not.toHaveBeenCalledWith(
      'memory:write-approval-request',
      expect.anything(),
    );
  });

  it('approves in-place without staging pending approval or broadcasting (one-turn invariant)', async () => {
    mockApprovalHandler.mockResolvedValue({ approved: true });
    const hook = makeHook('turn-with-handler');

    const result = await hook(writeInput(), 'tool-1', {
      signal: new AbortController().signal,
    }) as SyncHookJSONOutput;

    expect(result).toEqual({});
    expect(mockAddPendingMemoryApproval).not.toHaveBeenCalled();
    const broadcastChannels = mockSendToAllWindows.mock.calls.map((call) => call[0]);
    expect(broadcastChannels).not.toContain('memory:write-approval-request');
  });

  it('falls through to the existing approval request path when no handler is registered', async () => {
    const hook = makeHook('turn-without-handler');

    const result = await hook(writeInput(), 'tool-1', {
      signal: new AbortController().signal,
    }) as SyncHookJSONOutput;

    expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(mockAddPendingMemoryApproval).toHaveBeenCalledTimes(1);
    expect(mockSendToAllWindows).toHaveBeenCalledWith(
      'memory:write-approval-request',
      expect.objectContaining({ toolUseId: 'tool-1' }),
    );
  });
});
