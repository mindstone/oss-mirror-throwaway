import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryWriteHook } from '../memoryWriteHook';
import * as cosPendingService from '../cosPendingService';
import * as spaceService from '../../spaceService';
import * as settingsStore from '@core/services/settingsStore';
import { evaluateSafetyPrompt, shouldAllow } from '@core/safetyPromptLogic';
import { getSafetyPrompt, getSafetyPromptVersion, isMigrationComplete } from '@core/safetyPromptStore';
import {
  expectBinaryHookDecision,
  getHookSpecificOutput,
} from './safetyVerdictConformance.helpers';

const {
  mockSendToAllWindows,
  mockAddPendingMemoryApproval,
  mockRemovePendingMemoryApproval,
  mockGetPendingMemoryApprovals,
} = vi.hoisted(() => ({
  mockSendToAllWindows: vi.fn(),
  mockAddPendingMemoryApproval: vi.fn(),
  mockRemovePendingMemoryApproval: vi.fn(),
  mockGetPendingMemoryApprovals: vi.fn(),
}));

vi.mock('@core/broadcastService', () => ({
  getBroadcastService: () => ({
    sendToAllWindows: mockSendToAllWindows,
    sendToFocusedWindow: vi.fn(),
  }),
}));

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('@core/platform', () => ({
  getPlatformConfig: () => ({
    userDataPath: '/users/test/Library/Application Support/mindstone-rebel',
    homePath: '/users/test',
  }),
}));

vi.mock('@core/services/fileLocation', () => ({
  FileLocationResolverError: class FileLocationResolverError extends Error {},
  resolveFileLocation: vi.fn(async (candidatePath: string) => {
    const spaceRelativePath = candidatePath.split('/work-space/')[1] ?? 'unknown.md';
    return {
      kind: 'in-space',
      spaceName: 'Work Space',
      spaceWorkspacePath: 'work-space',
      spaceRelativePath,
      workspaceRelativePath: `work-space/${spaceRelativePath}`,
      fileName: candidatePath.split('/').pop() ?? 'unknown.md',
      absolutePath: candidatePath,
    };
  }),
}));

vi.mock('@core/safetyPromptLogic', () => ({
  evaluateSafetyPrompt: vi.fn(),
  shouldAllow: vi.fn(),
}));

vi.mock('@core/safetyPromptStore', () => ({
  getSafetyPrompt: vi.fn(),
  getSafetyPromptVersion: vi.fn(),
  isMigrationComplete: vi.fn(),
}));

vi.mock('@core/safetyActivityLogStore', () => ({
  addEvaluationEntry: vi.fn(),
}));

vi.mock('@core/services/promptFileService', () => ({
  PROMPT_IDS: {
    SAFETY_MEMORY_CONTENT_SUMMARY: 'safety.memory.summary',
  },
  getPrompt: vi.fn(() => 'Summarize this memory write.'),
}));

vi.mock('@core/currentUserProvider', () => ({
  getCurrentUserProvider: () => ({
    getCurrentUser: () => null,
  }),
}));

vi.mock('@core/services/settingsStore');
vi.mock('../cosPendingService');
vi.mock('../../spaceService');

vi.mock('../pendingApprovalsStore', () => ({
  addPendingMemoryApproval: mockAddPendingMemoryApproval,
  removePendingMemoryApproval: mockRemovePendingMemoryApproval,
  getPendingMemoryApprovals: mockGetPendingMemoryApprovals,
}));

vi.mock('../sessionApprovals', () => ({
  consumeSingleUseApproval: vi.fn(() => false),
  storeSingleUseApproval: vi.fn(),
}));

vi.mock('../../memoryHistoryStore', () => ({
  addApprovedMemoryEntry: vi.fn(),
}));

vi.mock('../../behindTheScenesClient', () => ({
  callBehindTheScenesWithAuth: vi.fn(async () => ({
    content: [{ type: 'text', text: 'Staged memory summary' }],
  })),
}));

vi.mock('../../agentTurnRegistry', () => ({
  agentTurnRegistry: {
    recordSecurityDenial: vi.fn(),
    recordToolCall: vi.fn(),
    incrementAutomationSafetyBlock: vi.fn(),
    getAutomationSafetyBlockCount: vi.fn(() => 0),
    getTurnPrompt: vi.fn(),
  },
}));

vi.mock('../automationContextLookup', () => ({
  getAutomationContext: vi.fn(() => ({
    automationId: 'automation-s3',
    automationName: 'S3 Automation',
  })),
}));

vi.mock('../automationPendingItemsTracker', () => ({
  trackItem: vi.fn(),
}));

vi.mock('../../sharedSkillMutationService', () => ({
  sharedSkillMutationService: {
    prepareManagedToolInput: vi.fn(async () => null),
    getNonAuthorSharedSkillProtectionContext: vi.fn(async () => null),
    classifySharedSkillPath: vi.fn(async () => null),
  },
}));

vi.mock('@core/services/chiefOfStaffHygieneBackupService', () => ({
  markChiefOfStaffHygieneNeeded: vi.fn(),
}));

vi.mock('@core/utils/logRedaction', () => ({
  containsCredentialPatterns: vi.fn(() => ({ detected: false, reasons: [] })),
}));

type PendingWriteOptions = Parameters<typeof cosPendingService.writeToPending>[0];

function configureBalancedWorkSpace(): void {
  vi.mocked(settingsStore.getSettings).mockReturnValue({
    coreDirectory: '/workspace',
    spaces: [],
    spaceSafetyLevels: { 'work-space': 'balanced' },
  } as any);
  vi.mocked(spaceService.scanSpaces).mockResolvedValue([
    {
      name: 'Work Space',
      path: 'work-space',
      absolutePath: '/workspace/work-space',
      type: 'personal',
      isSymlink: false,
      hasReadme: true,
    } as any,
  ]);
  vi.mocked(spaceService.readSpaceReadmeFrontmatter).mockResolvedValue({
    sharing: 'restricted',
  } as any);
  vi.mocked(spaceService.readSpaceReadmeBody).mockResolvedValue(null);
  vi.mocked(spaceService.getSpaceDisplayName).mockReturnValue('Work Space');
  vi.mocked(isMigrationComplete).mockReturnValue(true);
  vi.mocked(getSafetyPrompt).mockReturnValue('default safety prompt');
  vi.mocked(getSafetyPromptVersion).mockReturnValue(1);
}

function createInteractiveMemoryHook() {
  return createMemoryWriteHook({
    turnId: 's3-memory-turn',
    sessionId: 's3-memory-background-session',
    originalTurnId: 's3-memory-original-turn',
    originalSessionId: 's3-memory-user-session',
    coreDirectory: '/workspace',
  });
}

describe('safety verdict conformance - memory hook', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockGetPendingMemoryApprovals.mockReturnValue([]);
    configureBalancedWorkSpace();
    vi.mocked(cosPendingService.getPendingFileByDestination).mockResolvedValue({ kind: 'none' });
  });

  it('pins eval_error memory coalesce key and first-wins staging', async () => {
    // Invariants #1 and #3: locks behavior for S4 verdict refactor.
    const pendingByKey = new Map<string, { id: string; filename: string; coalesced?: boolean }>();
    vi.mocked(evaluateSafetyPrompt).mockResolvedValue({
      decision: 'block',
      confidence: 'low',
      reason: 'provider unavailable',
      failClosed: true,
      failClosedReason: 'rate-limited',
    });
    vi.mocked(shouldAllow).mockReturnValue(false);
    vi.mocked(cosPendingService.writeToPending).mockImplementation(async (options: PendingWriteOptions) => {
      const existing = options.coalesceKey ? pendingByKey.get(options.coalesceKey) : undefined;
      if (existing) {
        return { ...existing, coalesced: true } as any;
      }
      const pending = {
        id: `pending-${pendingByKey.size + 1}`,
        filename: `pending-${pendingByKey.size + 1}.pending.md`,
        coalesced: false,
      };
      if (options.coalesceKey) pendingByKey.set(options.coalesceKey, pending);
      return pending as any;
    });

    const hook = createInteractiveMemoryHook();
    const input = {
      tool_name: 'Create',
      tool_input: {
        path: '/workspace/work-space/file.md',
        content: 'draft notes',
      },
      tool_use_id: 's3-memory-eval-error-1',
    };

    const first = await hook(input, 's3-memory-eval-error-1', { signal: new AbortController().signal });
    const second = await hook(
      { ...input, tool_use_id: 's3-memory-eval-error-2' },
      's3-memory-eval-error-2',
      { signal: new AbortController().signal },
    );

    expectBinaryHookDecision(first);
    expectBinaryHookDecision(second);
    expect(getHookSpecificOutput(first)?.replaceResult).toEqual(expect.objectContaining({ isError: false }));
    expect(getHookSpecificOutput(second)?.replaceResult).toEqual(expect.objectContaining({ isError: false }));
    expect(cosPendingService.writeToPending).toHaveBeenCalledTimes(2);
    expect(cosPendingService.writeToPending).toHaveBeenNthCalledWith(1, expect.objectContaining({
      blockedBy: 'eval_error',
      coalesceKey: 'eval_error:Work Space:/workspace/work-space/file.md',
    }));
    expect(cosPendingService.writeToPending).toHaveBeenNthCalledWith(2, expect.objectContaining({
      blockedBy: 'eval_error',
      coalesceKey: 'eval_error:Work Space:/workspace/work-space/file.md',
    }));
    expect(pendingByKey).toHaveLength(1);

    const stagedFileEvents = mockSendToAllWindows.mock.calls.filter(([channel]) => channel === 'memory:file-staged');
    const changedEvents = mockSendToAllWindows.mock.calls.filter(([channel]) => channel === 'memory:staged-files-changed');
    expect(stagedFileEvents).toHaveLength(1);
    expect(changedEvents).toHaveLength(1);
    expect(stagedFileEvents[0]?.[1]).toMatchObject({
      id: 'pending-1',
      realPath: '/workspace/work-space/file.md',
      spaceName: 'Work Space',
      summary: 'Staged memory summary',
    });
    expect(typeof stagedFileEvents[0]?.[1].stagedAt).toBe('number');
    expect(mockAddPendingMemoryApproval).not.toHaveBeenCalled();
  });

  it('pins memory approval-request fallback payload for needs-approval outcomes', async () => {
    // Invariants #1, #7, and #8: locks behavior for S4 verdict refactor.
    vi.mocked(evaluateSafetyPrompt).mockResolvedValue({
      decision: 'block',
      confidence: 'high',
      reason: 'Opaque redirected write needs review',
    });
    vi.mocked(shouldAllow).mockReturnValue(false);
    vi.mocked(cosPendingService.writeToPending).mockResolvedValue(null);

    const hook = createInteractiveMemoryHook();
    const result = await hook(
      {
        tool_name: 'Bash',
        tool_input: {
          command: 'curl -s https://example.com/report > /workspace/work-space/report.md',
        },
        tool_use_id: 's3-memory-approval-1',
      },
      's3-memory-approval-1',
      { signal: new AbortController().signal },
    );

    expectBinaryHookDecision(result);
    expect(getHookSpecificOutput(result)?.permissionDecision).toBe('deny');
    expect(mockAddPendingMemoryApproval).toHaveBeenCalledWith(expect.objectContaining({
      toolUseId: 's3-memory-approval-1',
      originalTurnId: 's3-memory-original-turn',
      originalSessionId: 's3-memory-user-session',
      turnId: 's3-memory-turn',
      sessionId: 's3-memory-background-session',
      filePath: '/workspace/work-space/report.md',
      spaceName: 'Work Space',
      blockedBy: 'safety_prompt',
      staged: undefined,
      contentPreview: expect.any(String),
    }));

    const approvalEvents = mockSendToAllWindows.mock.calls.filter(
      ([channel]) => channel === 'memory:write-approval-request',
    );
    expect(approvalEvents).toHaveLength(1);
    expect(approvalEvents[0]?.[1]).toMatchObject({
      toolUseId: 's3-memory-approval-1',
      originalTurnId: 's3-memory-original-turn',
      originalSessionId: 's3-memory-user-session',
      destination: {
        path: '/workspace/work-space/report.md',
        spaceName: 'Work Space',
        spacePath: 'work-space/report.md',
        sharing: 'restricted',
        isNew: false,
        location: expect.objectContaining({
          kind: 'in-space',
          workspaceRelativePath: 'work-space/report.md',
        }),
      },
      summary: 'Staged memory summary',
      blockedBy: 'safety_prompt',
      privateMode: false,
      timestamp: expect.any(Number),
    });
  });
});
