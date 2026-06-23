import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileLocation } from '@rebel/shared';
import { createMemoryWriteHook } from '../memoryWriteHook';

const {
  mockSendToAllWindows,
  mockWarn,
  mockAddPendingMemoryApproval,
  resolveFileLocationMock,
} = vi.hoisted(() => ({
  mockSendToAllWindows: vi.fn(),
  mockWarn: vi.fn(),
  mockAddPendingMemoryApproval: vi.fn(),
  resolveFileLocationMock: vi.fn(),
}));

const MockFileLocationResolverError = vi.hoisted(
  () =>
    class FileLocationResolverError extends Error {
      readonly code: string;
      readonly inputPath: string;

      constructor(code: string, inputPath: string, message: string) {
        super(message);
        this.name = 'FileLocationResolverError';
        this.code = code;
        this.inputPath = inputPath;
      }
    },
);

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: mockWarn,
    error: vi.fn(),
  }),
}));

vi.mock('@core/broadcastService', () => ({
  getBroadcastService: () => ({
    sendToAllWindows: mockSendToAllWindows,
    sendToFocusedWindow: vi.fn(),
  }),
}));

vi.mock('@core/platform', () => ({
  getPlatformConfig: () => ({
    userDataPath: '/users/test/Library/Application Support/mindstone-rebel',
    homePath: '/users/test',
  }),
}));

vi.mock('@core/safetyPromptLogic', () => ({
  evaluateSafetyPrompt: vi.fn(),
  shouldAllow: vi.fn(),
}));

vi.mock('@core/safetyPromptStore', () => ({
  getSafetyPrompt: vi.fn().mockReturnValue('default safety prompt'),
  getSafetyPromptVersion: vi.fn().mockReturnValue(1),
  isMigrationComplete: vi.fn().mockReturnValue(true),
}));

vi.mock('@core/safetyActivityLogStore', () => ({
  addEvaluationEntry: vi.fn(),
}));

vi.mock('@core/services/fileLocation', () => ({
  resolveFileLocation: (...args: unknown[]) => resolveFileLocationMock(...args),
  FileLocationResolverError: MockFileLocationResolverError,
}));

const cosPendingMock = vi.hoisted(() => ({
  writeToPending: vi.fn(),
  getPendingFileByDestination: vi.fn(),
  deletePendingFile: vi.fn(),
}));
vi.mock('../cosPendingService', () => cosPendingMock);

const spaceServiceMock = vi.hoisted(() => ({
  scanSpaces: vi.fn(),
  readSpaceReadmeFrontmatter: vi.fn(),
  getSpaceDisplayName: vi.fn(),
}));
vi.mock('../../spaceService', () => spaceServiceMock);

const settingsStoreMock = vi.hoisted(() => ({
  getSettings: vi.fn(),
}));
vi.mock('@core/services/settingsStore', () => settingsStoreMock);

vi.mock('../pendingApprovalsStore', () => ({
  addPendingMemoryApproval: (...args: unknown[]) => mockAddPendingMemoryApproval(...args),
  removePendingMemoryApproval: vi.fn(),
  getPendingMemoryApprovals: vi.fn().mockReturnValue([]),
}));

vi.mock('../sessionApprovals', () => ({
  storeSingleUseApproval: vi.fn(),
  consumeSingleUseApproval: vi.fn().mockReturnValue(false),
}));

vi.mock('../../memoryHistoryStore', () => ({
  addApprovedMemoryEntry: vi.fn(),
}));

vi.mock('../../agentTurnRegistry', () => ({
  agentTurnRegistry: {
    recordSecurityDenial: vi.fn(),
    recordToolCall: vi.fn(),
    incrementAutomationSafetyBlock: vi.fn(),
    getAutomationSafetyBlockCount: vi.fn().mockReturnValue(0),
    getTurnPrompt: vi.fn(),
  },
}));

vi.mock('../automationContextLookup', () => ({
  getAutomationContext: vi.fn().mockReturnValue(null),
}));

vi.mock('../automationPendingItemsTracker', () => ({
  trackItem: vi.fn(),
}));

vi.mock('@core/currentUserProvider', () => ({
  getCurrentUserProvider: () => ({
    getCurrentUser: vi.fn().mockReturnValue({
    id: 'user-1',
    name: 'User One',
    email: 'user@example.com',
    image: null,
  }),
  }),
  setCurrentUserProviderFactory: vi.fn(),
}));

vi.mock('../../sharedSkillMutationService', () => ({
  sharedSkillMutationService: {
    getNonAuthorSharedSkillProtectionContext: vi.fn().mockResolvedValue(null),
    prepareManagedToolInput: vi.fn().mockResolvedValue(null),
    classifySharedSkillPath: vi.fn().mockResolvedValue(null),
    writeManagedSkillFile: vi.fn(),
  },
}));

vi.mock('../../behindTheScenesClient', () => ({
  callBehindTheScenesWithAuth: vi.fn().mockResolvedValue({
    data: {
      content: [
        { type: 'text', text: 'Memory update summary' },
      ],
    },
  }),
}));

const containsCredentialPatternsMock = vi.hoisted(() => vi.fn());
vi.mock('@core/utils/logRedaction', () => ({
  containsCredentialPatterns: (...args: unknown[]) => containsCredentialPatternsMock(...args),
}));

const IN_SPACE_LOCATION: FileLocation = {
  kind: 'in-space',
  spaceName: 'Test Space',
  spaceWorkspacePath: 'test-space',
  spaceRelativePath: 'notes.md',
  workspaceRelativePath: 'test-space/notes.md',
  fileName: 'notes.md',
  absolutePath: '/workspace/test-space/notes.md',
};

function buildHook() {
  return createMemoryWriteHook({
    turnId: 'turn-approval-1',
    sessionId: 'session-approval-1',
    originalTurnId: 'orig-turn-approval-1',
    originalSessionId: 'orig-session-approval-1',
    coreDirectory: '/workspace',
  });
}

async function runBlockingApproval(hook = buildHook()): Promise<void> {
  await hook(
    {
      tool_name: 'Create',
      tool_input: {
        path: '/workspace/test-space/notes.md',
        content: 'draft content',
      },
      tool_use_id: 'tool-approval-1',
    },
    'tool-approval-1',
    { signal: new AbortController().signal },
  );
}

describe('memoryWriteHook broadcastApprovalRequest file-location integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    settingsStoreMock.getSettings.mockReturnValue({
      coreDirectory: '/workspace',
      spaces: [],
      spaceSafetyLevels: {
        'test-space': 'cautious',
      },
    });

    spaceServiceMock.scanSpaces.mockResolvedValue([
      {
        name: 'Test Space',
        path: 'test-space',
        absolutePath: '/workspace/test-space',
        type: 'personal',
        isSymlink: false,
        hasReadme: true,
      },
    ]);
    spaceServiceMock.readSpaceReadmeFrontmatter.mockResolvedValue({
      sharing: 'restricted',
      rebel_space_description: 'Test space',
    });
    spaceServiceMock.getSpaceDisplayName.mockReturnValue('Test Space');

    cosPendingMock.getPendingFileByDestination.mockResolvedValue(null);
    cosPendingMock.writeToPending.mockResolvedValue(null);

    containsCredentialPatternsMock.mockReturnValue({ detected: false, reasons: [] });
    resolveFileLocationMock.mockResolvedValue(IN_SPACE_LOCATION);
  });

  it('broadcasts request.destination.location on memory:write-approval-request events', async () => {
    await runBlockingApproval();

    const approvalEvents = mockSendToAllWindows.mock.calls.filter(
      ([channel]) => channel === 'memory:write-approval-request',
    );
    expect(approvalEvents).toHaveLength(1);
    expect(approvalEvents[0]?.[1]).toMatchObject({
      destination: {
        spacePath: 'test-space/notes.md',
        location: {
          kind: 'in-space',
          workspaceRelativePath: 'test-space/notes.md',
          fileName: 'notes.md',
        },
      },
    });
  });

  it('persists location on addPendingMemoryApproval payloads', async () => {
    await runBlockingApproval();

    expect(mockAddPendingMemoryApproval).toHaveBeenCalledTimes(1);
    expect(mockAddPendingMemoryApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: '/workspace/test-space/notes.md',
        spacePath: 'test-space/notes.md',
        location: expect.objectContaining({
          kind: 'in-space',
          workspaceRelativePath: 'test-space/notes.md',
        }),
      }),
    );
  });

  it('fails open when FileLocationResolverError is thrown (broadcast without location + dedup warn)', async () => {
    resolveFileLocationMock.mockRejectedValue(
      new MockFileLocationResolverError(
        'invalid-input',
        '/workspace/test-space/notes.md',
        'bad input',
      ),
    );

    const hook = buildHook();
    await runBlockingApproval(hook);
    await runBlockingApproval(hook);

    const approvalEvents = mockSendToAllWindows.mock.calls.filter(
      ([channel]) => channel === 'memory:write-approval-request',
    );
    expect(approvalEvents).toHaveLength(2);
    expect(approvalEvents[0]?.[1]).toMatchObject({
      destination: {
        path: '/workspace/test-space/notes.md',
      },
    });
    expect((approvalEvents[0]?.[1] as { destination?: { location?: FileLocation } }).destination?.location).toBeUndefined();
    expect((approvalEvents[1]?.[1] as { destination?: { location?: FileLocation } }).destination?.location).toBeUndefined();

    const resolverWarnings = mockWarn.mock.calls.filter(
      ([, message]) => message === 'FileLocation resolution failed; broadcasting memory approval request without location',
    );
    expect(resolverWarnings).toHaveLength(1);
  });
});
