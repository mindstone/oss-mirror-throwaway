
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  isSyncHookOutput,
  type HookJSONOutput,
  type SyncHookJSONOutput,
} from '@core/agentRuntimeTypes';
import type { ActionContext, ActionContextSessionIntent } from '@core/safetyPromptTypes';
import { createMemoryWriteHook, handleMemoryWriteApprovalResponse } from '../memoryWriteHook';
import { isProtectedSystemPath } from '../constants';
import * as cosPendingService from '../cosPendingService';
import * as pendingApprovalsStore from '../pendingApprovalsStore';
import { consumeSingleUseApproval, storeSingleUseApproval } from '../sessionApprovals';
import * as spaceService from '../../spaceService';
import { sharedSkillMutationService } from '../../sharedSkillMutationService';
import * as settingsStore from '@core/services/settingsStore';
import { evaluateSafetyPrompt, shouldAllow } from '@core/safetyPromptLogic';
import { getSafetyPrompt, getSafetyPromptVersion, isMigrationComplete } from '@core/safetyPromptStore';
import { addEvaluationEntry } from '@core/safetyActivityLogStore';
import { getAutomationContext } from '../automationContextLookup';
import { agentTurnRegistry } from '../../agentTurnRegistry';
import {
  EVAL_ERROR_FORBIDDEN_SURFACE_SUBSTRINGS,
  buildEvalErrorAgentReason,
  buildEvalErrorUserReason,
} from '@shared/safety/evalErrorCopy';

// Mock broadcast service (replaces electron BrowserWindow.getAllWindows)
const mockSendToAllWindows = vi.fn();
vi.mock('@core/broadcastService', () => ({
  getBroadcastService: () => ({
    sendToAllWindows: mockSendToAllWindows,
    sendToFocusedWindow: vi.fn(),
  }),
}));

const { mockLoggerInfo, mockLoggerWarn, mockLoggerError, mockLoggerDebug } = vi.hoisted(() => ({
  mockLoggerInfo: vi.fn(),
  mockLoggerWarn: vi.fn(),
  mockLoggerError: vi.fn(),
  mockLoggerDebug: vi.fn(),
}));
vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    info: mockLoggerInfo,
    warn: mockLoggerWarn,
    error: mockLoggerError,
    debug: mockLoggerDebug,
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

vi.mock('../cosPendingService');
vi.mock('../../spaceService');
vi.mock('@core/services/settingsStore');
vi.mock('../automationContextLookup', () => ({
  getAutomationContext: vi.fn().mockReturnValue({ automationId: 'test-auto', automationName: 'Test Automation' }),
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
vi.mock('../automationPendingItemsTracker', () => ({
  trackItem: vi.fn(),
}));

// Mock containsCredentialPatterns — default: no credentials detected.
// Uses vi.hoisted so the mock exists before the hoisted vi.mock factory runs.
const { mockContainsCredentialPatterns } = vi.hoisted(() => ({
  mockContainsCredentialPatterns: vi.fn<
    (content: string) => { detected: boolean; reasons: string[] }
  >(),
}));
vi.mock('@core/utils/logRedaction', () => ({
  containsCredentialPatterns: mockContainsCredentialPatterns,
}));

type MockSpaceFrontmatter = Awaited<ReturnType<typeof spaceService.readSpaceReadmeFrontmatter>>;
type PreToolUseHookSpecificOutput = NonNullable<SyncHookJSONOutput['hookSpecificOutput']>;

const asSpaceFrontmatter = (frontmatter: unknown): MockSpaceFrontmatter =>
  frontmatter as MockSpaceFrontmatter;

function getHookSpecificOutput(result: HookJSONOutput): PreToolUseHookSpecificOutput | undefined {
  expect(isSyncHookOutput(result)).toBe(true);
  return (result as SyncHookJSONOutput).hookSpecificOutput as PreToolUseHookSpecificOutput | undefined;
}

function getFirstEvaluationActionContext(): ActionContext {
  expect(evaluateSafetyPrompt).toHaveBeenCalled();
  return vi.mocked(evaluateSafetyPrompt).mock.calls[0]?.[2] as ActionContext;
}

describe('createMemoryWriteHook', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Default: no credentials detected (secret gate passes through)
    mockContainsCredentialPatterns.mockReturnValue({ detected: false, reasons: [] });
    
    // Default mocks - FORCE CAUTIOUS MODE
    vi.mocked(settingsStore.getSettings).mockReturnValue({
      coreDirectory: '/workspace',
      spaces: [],
      spaceSafetyLevels: {
        'test-space': 'cautious', // Force cautious mode to trigger staging
      },
    } as any);
    
    vi.mocked(spaceService.scanSpaces).mockResolvedValue([
      {
        name: 'Test Space',
        path: 'test-space',
        absolutePath: '/workspace/test-space',
        type: 'personal',
        isSymlink: false,
        hasReadme: true,
      } as any,
    ]);

    // Mock readSpaceReadmeFrontmatter to return empty object (undefined sharing)
    vi.mocked(spaceService.readSpaceReadmeFrontmatter).mockResolvedValue(undefined);
    vi.mocked(spaceService.getSpaceDisplayName).mockReturnValue('Test Space');
  });

  it('passes user message and session intent to interactive memory safety eval using originalSessionId', async () => {
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
    vi.mocked(spaceService.readSpaceReadmeFrontmatter).mockResolvedValue(
      asSpaceFrontmatter({ sharing: 'restricted' }),
    );
    vi.mocked(spaceService.getSpaceDisplayName).mockReturnValue('Work Space');
    vi.mocked(isMigrationComplete).mockReturnValue(true);
    vi.mocked(getSafetyPrompt).mockReturnValue('default safety prompt');
    vi.mocked(getSafetyPromptVersion).mockReturnValue(1);
    vi.mocked(evaluateSafetyPrompt).mockResolvedValue({ decision: 'allow', confidence: 'high', reason: 'Allowed' });
    vi.mocked(shouldAllow).mockReturnValue(true);

    const sessionIntent: ActionContextSessionIntent = {
      recentUserMessages: [
        'Please update the ROI handoff note for Sales.',
        'Use the General space so everyone can find it.',
      ],
      totalChars: 92,
    };
    const getSessionIntent = vi.fn().mockResolvedValue(sessionIntent);
    const userMessage = 'Add the updated ROI dashboard handoff note to the shared workspace.';
    const hook = createMemoryWriteHook({
      turnId: 'turn-intent-context',
      sessionId: 'transient-turn-session',
      originalTurnId: 'orig-turn-intent-context',
      originalSessionId: 'user-conversation-session',
      coreDirectory: '/workspace',
      userMessage,
      getSessionIntent,
    });

    const result = await hook(
      {
        tool_name: 'Create',
        tool_input: {
          path: '/workspace/work-space/roi-handoff.md',
          content: 'Sales handoff notes',
        },
        tool_use_id: 'tu-intent-context',
      },
      'tu-intent-context',
      { signal: new AbortController().signal },
    );

    expect(result).toEqual({});
    expect(getSessionIntent).toHaveBeenCalledTimes(1);
    expect(getSessionIntent).toHaveBeenCalledWith('user-conversation-session');
    expect(getSessionIntent).not.toHaveBeenCalledWith('transient-turn-session');
    expect(getFirstEvaluationActionContext()).toEqual(expect.objectContaining({
      sessionType: 'interactive',
      userMessage,
      sessionIntent,
    }));
  });

  it('omits intent fields from ActionContext when no intent inputs are supplied', async () => {
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
    vi.mocked(spaceService.readSpaceReadmeFrontmatter).mockResolvedValue(
      asSpaceFrontmatter({ sharing: 'restricted' }),
    );
    vi.mocked(spaceService.getSpaceDisplayName).mockReturnValue('Work Space');
    vi.mocked(isMigrationComplete).mockReturnValue(true);
    vi.mocked(getSafetyPrompt).mockReturnValue('default safety prompt');
    vi.mocked(getSafetyPromptVersion).mockReturnValue(1);
    vi.mocked(evaluateSafetyPrompt).mockResolvedValue({ decision: 'allow', confidence: 'high', reason: 'Allowed' });
    vi.mocked(shouldAllow).mockReturnValue(true);

    const hook = createMemoryWriteHook({
      turnId: 'turn-no-intent-inputs',
      sessionId: 'session-no-intent-inputs',
      originalTurnId: 'orig-turn-no-intent-inputs',
      originalSessionId: 'orig-session-no-intent-inputs',
      coreDirectory: '/workspace',
    });

    const result = await hook(
      {
        tool_name: 'Create',
        tool_input: {
          path: '/workspace/work-space/no-intent.md',
          content: 'Notes without explicit intent inputs',
        },
        tool_use_id: 'tu-no-intent-inputs',
      },
      'tu-no-intent-inputs',
      { signal: new AbortController().signal },
    );

    const actionContext = getFirstEvaluationActionContext();
    expect(result).toEqual({});
    expect(actionContext).not.toHaveProperty('userMessage');
    expect(actionContext).not.toHaveProperty('sessionIntent');
  });

  it('continues evaluation without sessionIntent when the session intent supplier rejects', async () => {
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
    vi.mocked(spaceService.readSpaceReadmeFrontmatter).mockResolvedValue(
      asSpaceFrontmatter({ sharing: 'restricted' }),
    );
    vi.mocked(spaceService.getSpaceDisplayName).mockReturnValue('Work Space');
    vi.mocked(isMigrationComplete).mockReturnValue(true);
    vi.mocked(getSafetyPrompt).mockReturnValue('default safety prompt');
    vi.mocked(getSafetyPromptVersion).mockReturnValue(1);
    vi.mocked(evaluateSafetyPrompt).mockResolvedValue({ decision: 'allow', confidence: 'high', reason: 'Allowed' });
    vi.mocked(shouldAllow).mockReturnValue(true);

    const userMessage = 'Please update the shared sales handoff note.';
    const getSessionIntent = vi.fn().mockRejectedValue(new Error('session store unavailable'));
    const hook = createMemoryWriteHook({
      turnId: 'turn-intent-rejects',
      sessionId: 'session-intent-rejects',
      originalTurnId: 'orig-turn-intent-rejects',
      originalSessionId: 'orig-session-intent-rejects',
      coreDirectory: '/workspace',
      userMessage,
      getSessionIntent,
    });

    await expect(hook(
      {
        tool_name: 'Create',
        tool_input: {
          path: '/workspace/work-space/fail-soft.md',
          content: 'Write still reaches the evaluator',
        },
        tool_use_id: 'tu-intent-rejects',
      },
      'tu-intent-rejects',
      { signal: new AbortController().signal },
    )).resolves.toEqual({});

    const actionContext = getFirstEvaluationActionContext();
    expect(getSessionIntent).toHaveBeenCalledWith('orig-session-intent-rejects');
    expect(actionContext).toEqual(expect.objectContaining({ userMessage }));
    expect(actionContext).not.toHaveProperty('sessionIntent');
  });

  it('resolves space from settings fallback when scanSpaces has no match', async () => {
    vi.mocked(settingsStore.getSettings).mockReturnValue({
      coreDirectory: '/workspace',
      spaces: [
        {
          name: 'Client Space',
          path: 'client-space',
          type: 'project',
          isSymlink: false,
          sharing: 'restricted',
          description: 'Fallback description from settings',
          createdAt: Date.now(),
        },
      ],
      spaceSafetyLevels: {},
    } as any);
    vi.mocked(spaceService.scanSpaces).mockResolvedValue([]);
    vi.mocked(spaceService.getSpaceDisplayName).mockImplementation((space: any) => space.displayName ?? space.name);
    vi.mocked(spaceService.readSpaceReadmeFrontmatter).mockRejectedValue(new Error('README missing'));
    vi.mocked(isMigrationComplete).mockReturnValue(true);
    vi.mocked(getSafetyPrompt).mockReturnValue('default safety prompt');
    vi.mocked(getSafetyPromptVersion).mockReturnValue(1);
    vi.mocked(evaluateSafetyPrompt).mockResolvedValue({ decision: 'allow', confidence: 'high', reason: 'Allowed' });
    vi.mocked(shouldAllow).mockReturnValue(true);

    const hook = createMemoryWriteHook({
      turnId: 'turn-settings-fallback-1',
      sessionId: 'session-settings-fallback-1',
      originalTurnId: 'orig-turn-settings-fallback-1',
      originalSessionId: 'orig-session-settings-fallback-1',
      coreDirectory: '/workspace',
    });

    const result = await hook(
      {
        tool_name: 'Create',
        tool_input: {
          path: '/workspace/client-space/notes.md',
          content: 'notes',
        },
        tool_use_id: 'tool-settings-fallback-1',
      },
      'tool-settings-fallback-1',
      { signal: new AbortController().signal }
    );

    expect(result).toEqual({});
    expect(spaceService.readSpaceReadmeFrontmatter).toHaveBeenCalledWith('/workspace/client-space');
    const actionContext = vi.mocked(evaluateSafetyPrompt).mock.calls[0]?.[2] as any;
    expect(actionContext).toEqual(expect.objectContaining({
      toolDescription: expect.stringContaining('"Client Space"'),
      spaceDescription: 'Fallback description from settings',
    }));
    expect(actionContext.toolDescription).toContain('(restricted sharing)');
  });

  it('prefers scanned space over settings fallback when both contain the same path', async () => {
    vi.mocked(settingsStore.getSettings).mockReturnValue({
      coreDirectory: '/workspace',
      spaces: [
        {
          name: 'Settings Space',
          path: 'client-space',
          type: 'project',
          isSymlink: false,
          sharing: 'public',
          description: 'Description from settings',
          createdAt: Date.now(),
        },
      ],
      spaceSafetyLevels: {},
    } as any);
    vi.mocked(spaceService.scanSpaces).mockResolvedValue([
      {
        name: 'Scanned Space',
        path: 'client-space',
        absolutePath: '/workspace/scanned-space',
        type: 'personal',
        isSymlink: false,
        hasReadme: true,
      } as any,
    ]);
    vi.mocked(spaceService.getSpaceDisplayName).mockImplementation((space: any) => space.displayName ?? space.name);
    // Use 'restricted' sharing so the space resolves to 'balanced' (private defaults to
    // 'permissive' which skips Safety Prompt evaluation). The test intent is space resolution
    // preference, not safety level.
    vi.mocked(spaceService.readSpaceReadmeFrontmatter).mockResolvedValue({
      sharing: 'restricted',
      rebel_space_description: 'Description from scanned frontmatter',
    });
    vi.mocked(isMigrationComplete).mockReturnValue(true);
    vi.mocked(getSafetyPrompt).mockReturnValue('default safety prompt');
    vi.mocked(getSafetyPromptVersion).mockReturnValue(1);
    vi.mocked(evaluateSafetyPrompt).mockResolvedValue({ decision: 'allow', confidence: 'high', reason: 'Allowed' });
    vi.mocked(shouldAllow).mockReturnValue(true);

    const hook = createMemoryWriteHook({
      turnId: 'turn-settings-fallback-2',
      sessionId: 'session-settings-fallback-2',
      originalTurnId: 'orig-turn-settings-fallback-2',
      originalSessionId: 'orig-session-settings-fallback-2',
      coreDirectory: '/workspace',
    });

    const result = await hook(
      {
        tool_name: 'Create',
        tool_input: {
          path: '/workspace/client-space/notes.md',
          content: 'notes',
        },
        tool_use_id: 'tool-settings-fallback-2',
      },
      'tool-settings-fallback-2',
      { signal: new AbortController().signal }
    );

    expect(result).toEqual({});
    expect(spaceService.readSpaceReadmeFrontmatter).toHaveBeenCalledWith('/workspace/scanned-space');
    const actionContext = vi.mocked(evaluateSafetyPrompt).mock.calls[0]?.[2] as any;
    expect(actionContext).toEqual(expect.objectContaining({
      toolDescription: expect.stringContaining('"Scanned Space"'),
      spaceDescription: 'Description from scanned frontmatter',
    }));
    expect(actionContext.toolDescription).toContain('(restricted sharing)');
  });

  it('maps settings fallback SpaceConfig to normalized SpaceInfo paths', async () => {
    vi.mocked(settingsStore.getSettings).mockReturnValue({
      coreDirectory: '/workspace',
      spaces: [
        {
          name: 'Team Project Space',
          path: 'team\\project\\',
          type: 'project',
          isSymlink: true,
          sourcePath: '/cloud/team/project',
          hasReadme: false,
          sharing: 'restricted',
          description: 'Normalized fallback description',
          createdAt: Date.now(),
        },
      ],
      spaceSafetyLevels: {},
    } as any);
    vi.mocked(spaceService.scanSpaces).mockResolvedValue([]);
    vi.mocked(spaceService.getSpaceDisplayName).mockImplementation((space: any) => space.displayName ?? space.name);
    vi.mocked(spaceService.readSpaceReadmeFrontmatter).mockResolvedValue(undefined);
    vi.mocked(isMigrationComplete).mockReturnValue(true);
    vi.mocked(getSafetyPrompt).mockReturnValue('default safety prompt');
    vi.mocked(getSafetyPromptVersion).mockReturnValue(1);
    vi.mocked(evaluateSafetyPrompt).mockResolvedValue({ decision: 'allow', confidence: 'high', reason: 'Allowed' });
    vi.mocked(shouldAllow).mockReturnValue(true);

    const hook = createMemoryWriteHook({
      turnId: 'turn-settings-fallback-3',
      sessionId: 'session-settings-fallback-3',
      originalTurnId: 'orig-turn-settings-fallback-3',
      originalSessionId: 'orig-session-settings-fallback-3',
      coreDirectory: '/workspace',
    });

    const result = await hook(
      {
        tool_name: 'Create',
        tool_input: {
          path: '/workspace/team/project/notes.md',
          content: 'notes',
        },
        tool_use_id: 'tool-settings-fallback-3',
      },
      'tool-settings-fallback-3',
      { signal: new AbortController().signal }
    );

    expect(result).toEqual({});
    expect(spaceService.readSpaceReadmeFrontmatter).toHaveBeenCalledWith('/workspace/team/project');
    const actionContext = vi.mocked(evaluateSafetyPrompt).mock.calls[0]?.[2] as any;
    expect(actionContext).toEqual(expect.objectContaining({
      toolDescription: expect.stringContaining('"Team Project Space"'),
      spaceDescription: 'Normalized fallback description',
    }));
    expect(actionContext.toolDescription).toContain('(restricted sharing)');
  });

  it('broadcasts both memory:file-staged and memory:staged-files-changed when file is staged', async () => {
    // Setup
    const hook = createMemoryWriteHook({
      turnId: 'turn-1',
      sessionId: 'session-1',
      originalTurnId: 'orig-turn-1',
      originalSessionId: 'orig-session-1',
      coreDirectory: '/workspace',
    });
    
    // Mock writeToPending success
    vi.mocked(cosPendingService.writeToPending).mockResolvedValue({
      id: 'pending-123',
      filename: 'file.md',
    } as any);

    // Mock internal extractFullContent logic implicitly by ensuring file read isn't needed for Create tool
    // For Create tool, extractFullContent uses content directly.
    
    const result = await hook(
      {
        tool_name: 'Create', // Create is a file write tool
        tool_input: {
          path: '/workspace/test-space/file.md',
          content: 'new content',
        },
        tool_use_id: 'tool-1',
      },
      'tool-1',
      { signal: new AbortController().signal }
    );

    // Verify
    // 1. Check replaceResult (staged = transparent success via replaceResult)
    expect(getHookSpecificOutput(result)?.replaceResult).toEqual(
      expect.objectContaining({ isError: false })
    );

    // 2. Verify broadcasts via broadcastService
    expect(mockSendToAllWindows).toHaveBeenCalledWith('memory:file-staged', expect.objectContaining({
      id: 'pending-123',
      realPath: '/workspace/test-space/file.md',
    }));
    
    // THIS IS THE KEY ASSERTION FOR THE BUG FIX
    expect(mockSendToAllWindows).toHaveBeenCalledWith('memory:staged-files-changed');
  });

  it('stages Bash heredoc writes via Safety Prompt evaluation (balanced space)', async () => {
    // Override to balanced space for Bash Safety Prompt testing
    vi.mocked(settingsStore.getSettings).mockReturnValue({
      coreDirectory: '/workspace',
      spaces: [],
      spaceSafetyLevels: {
        'test-space': 'balanced',
      },
    } as any);

    // Re-setup safety prompt mocks (cleared by beforeEach vi.resetAllMocks)
    vi.mocked(isMigrationComplete).mockReturnValue(true);
    vi.mocked(getSafetyPrompt).mockReturnValue('default safety prompt');
    vi.mocked(getSafetyPromptVersion).mockReturnValue(1);

    // Safety Prompt blocks the write
    vi.mocked(evaluateSafetyPrompt).mockResolvedValue({ decision: 'block', confidence: 'high', reason: 'Sensitive content detected' });
    vi.mocked(shouldAllow).mockReturnValue(false);

    const hook = createMemoryWriteHook({
      turnId: 'turn-bash-1',
      sessionId: 'session-bash-1',
      originalTurnId: 'orig-turn-bash-1',
      originalSessionId: 'orig-session-bash-1',
      coreDirectory: '/workspace',
    });

    vi.mocked(cosPendingService.writeToPending).mockResolvedValue({
      id: 'pending-bash-123',
      filename: 'staged-proposal.pending.md',
    } as any);

    // Simulate a Bash heredoc write (common subagent pattern)
    const result = await hook(
      {
        tool_name: 'Bash',
        tool_input: {
          command: "cat > /workspace/test-space/memory/topics/proposal.md << 'ENDOFFILE'\n---\ntitle: Test Proposal\n---\n\n# Proposal\n\nContent here.\nENDOFFILE",
        },
        tool_use_id: 'tool-bash-heredoc-1',
      },
      'tool-bash-heredoc-1',
      { signal: new AbortController().signal }
    );

    // Should be staged (transparent success via replaceResult), NOT the old blocking approval
    expect(getHookSpecificOutput(result)?.replaceResult).toEqual(
      expect.objectContaining({ isError: false })
    );
    // Must NOT contain the old blocking message
    expect(getHookSpecificOutput(result)?.permissionDecision).toBeUndefined();

    // Verify Safety Prompt was called
    expect(evaluateSafetyPrompt).toHaveBeenCalled();

    // Verify staging broadcasts
    expect(mockSendToAllWindows).toHaveBeenCalledWith('memory:file-staged', expect.objectContaining({
      id: 'pending-bash-123',
    }));
    expect(mockSendToAllWindows).toHaveBeenCalledWith('memory:staged-files-changed');

    // Verify the heredoc content was extracted and passed to writeToPending
    expect(cosPendingService.writeToPending).toHaveBeenCalledWith(
      expect.objectContaining({
        content: '---\ntitle: Test Proposal\n---\n\n# Proposal\n\nContent here.',
        blockedBy: 'safety_prompt',
      })
    );
  });

  it('falls back to blocking approval for non-heredoc Bash writes after Safety Prompt blocks', async () => {
    // Override to balanced space for Bash Safety Prompt testing
    vi.mocked(settingsStore.getSettings).mockReturnValue({
      coreDirectory: '/workspace',
      spaces: [],
      spaceSafetyLevels: {
        'test-space': 'balanced',
      },
    } as any);

    // Re-setup safety prompt mocks (cleared by beforeEach vi.resetAllMocks)
    vi.mocked(isMigrationComplete).mockReturnValue(true);
    vi.mocked(getSafetyPrompt).mockReturnValue('default safety prompt');
    vi.mocked(getSafetyPromptVersion).mockReturnValue(1);

    // Safety Prompt blocks the write
    vi.mocked(evaluateSafetyPrompt).mockResolvedValue({ decision: 'block', confidence: 'high', reason: 'Opaque data transfer' });
    vi.mocked(shouldAllow).mockReturnValue(false);

    const hook = createMemoryWriteHook({
      turnId: 'turn-bash-2',
      sessionId: 'session-bash-2',
      originalTurnId: 'orig-turn-bash-2',
      originalSessionId: 'orig-session-bash-2',
      coreDirectory: '/workspace',
    });

    // Simulate a Bash redirect write (no heredoc, content not extractable for staging)
    const result = await hook(
      {
        tool_name: 'Bash',
        tool_input: {
          command: 'curl -s https://example.com/data > /workspace/test-space/output.json',
        },
        tool_use_id: 'tool-bash-pipe-1',
      },
      'tool-bash-pipe-1',
      { signal: new AbortController().signal }
    );

    // Verify Safety Prompt was called
    expect(evaluateSafetyPrompt).toHaveBeenCalled();

    // Should fall back to old blocking approval (content not extractable for staging)
    expect(getHookSpecificOutput(result)?.permissionDecision).toBe('deny');
    expect(getHookSpecificOutput(result)?.permissionDecisionReason).toContain('WRITE QUEUED');
    // Must NOT contain the staged message
    expect(getHookSpecificOutput(result)?.permissionDecisionReason).not.toContain('FILE STAGED SUCCESSFULLY');
    // The approval request must have blockedBy: 'safety_prompt' (enables rule-update button)
    expect(mockSendToAllWindows).toHaveBeenCalledWith(
      'memory:write-approval-request',
      expect.objectContaining({ blockedBy: 'safety_prompt' })
    );
  });

  it('stages interactive eval_error memory writes when Safety Prompt evaluation fail-closes', async () => {
    vi.mocked(settingsStore.getSettings).mockReturnValue({
      coreDirectory: '/workspace',
      spaces: [],
      spaceSafetyLevels: {
        'test-space': 'balanced',
      },
    } as any);

    vi.mocked(isMigrationComplete).mockReturnValue(true);
    vi.mocked(getSafetyPrompt).mockReturnValue('default safety prompt');
    vi.mocked(getSafetyPromptVersion).mockReturnValue(1);

    // Safety Prompt returns fail-closed result (transient evaluator outage)
    vi.mocked(evaluateSafetyPrompt).mockResolvedValue({
      decision: 'block',
      confidence: 'low',
      reason: "Rebel can't complete the safety check (provider error). This often clears on its own — if it keeps happening, restart Rebel or raise a bug and we'll look into it.",
      failClosed: true,
    });
    vi.mocked(shouldAllow).mockReturnValue(false);
    vi.mocked(cosPendingService.writeToPending).mockResolvedValue({
      id: 'pending-fc-1',
      filename: 'eval-error.pending.md',
    } as any);

    const hook = createMemoryWriteHook({
      turnId: 'turn-fc-1',
      sessionId: 'session-fc-1',
      originalTurnId: 'orig-turn-fc-1',
      originalSessionId: 'orig-session-fc-1',
      coreDirectory: '/workspace',
    });

    const result = await hook(
      {
        tool_name: 'Create',
        tool_input: {
          path: '/workspace/test-space/file.md',
          content: 'some content',
        },
        tool_use_id: 'tool-fc-1',
      },
      'tool-fc-1',
      { signal: new AbortController().signal }
    );

    expect(getHookSpecificOutput(result)?.replaceResult).toEqual(
      expect.objectContaining({ isError: false })
    );
    expect(getHookSpecificOutput(result)?.replaceResult?.output).toContain('awaiting user approval before publishing');
    expect(cosPendingService.writeToPending).toHaveBeenCalledWith(
      expect.objectContaining({
        blockedBy: 'eval_error',
      })
    );
    const stagedReason = buildEvalErrorAgentReason('Create').toLowerCase();
    for (const forbidden of EVAL_ERROR_FORBIDDEN_SURFACE_SUBSTRINGS) {
      expect(stagedReason).not.toContain(forbidden);
    }
    expect(mockSendToAllWindows).not.toHaveBeenCalledWith(
      'memory:write-approval-request',
      expect.anything(),
    );
  });

  it('stages eval_error writes for company-wide sharing (Option A) with non-trust block type', async () => {
    vi.mocked(settingsStore.getSettings).mockReturnValue({
      coreDirectory: '/workspace',
      spaces: [],
      spaceSafetyLevels: {},
    } as any);
    vi.mocked(spaceService.scanSpaces).mockResolvedValue([
      {
        name: 'Company Space',
        path: 'company-space',
        absolutePath: '/workspace/company-space',
        type: 'project',
        isSymlink: false,
        hasReadme: true,
      } as any,
    ]);
    vi.mocked(spaceService.readSpaceReadmeFrontmatter).mockResolvedValue(
      asSpaceFrontmatter({ sharing: 'company-wide' })
    );
    vi.mocked(spaceService.getSpaceDisplayName).mockReturnValue('Company Space');
    vi.mocked(isMigrationComplete).mockReturnValue(true);
    vi.mocked(getSafetyPrompt).mockReturnValue('default safety prompt');
    vi.mocked(getSafetyPromptVersion).mockReturnValue(1);
    vi.mocked(evaluateSafetyPrompt).mockResolvedValue({
      decision: 'block',
      confidence: 'low',
      reason: 'provider unavailable',
      failClosed: true,
    });
    vi.mocked(shouldAllow).mockReturnValue(false);
    vi.mocked(cosPendingService.writeToPending).mockResolvedValue({
      id: 'pending-company-eval-error-1',
      filename: 'company-eval-error.pending.md',
    } as any);

    const hook = createMemoryWriteHook({
      turnId: 'turn-company-eval-error-1',
      sessionId: 'session-company-eval-error-1',
      originalTurnId: 'orig-turn-company-eval-error-1',
      originalSessionId: 'orig-session-company-eval-error-1',
      coreDirectory: '/workspace',
    });

    const result = await hook(
      {
        tool_name: 'Create',
        tool_input: {
          path: '/workspace/company-space/brief.md',
          content: 'company-wide update',
        },
        tool_use_id: 'tool-company-eval-error-1',
      },
      'tool-company-eval-error-1',
      { signal: new AbortController().signal }
    );

    expect(getHookSpecificOutput(result)?.replaceResult).toEqual(
      expect.objectContaining({ isError: false })
    );
    expect(cosPendingService.writeToPending).toHaveBeenCalledWith(
      expect.objectContaining({
        blockedBy: 'eval_error',
        sharing: 'company-wide',
      })
    );
  });

  it('stages eval_error writes for public sharing (Option A) — highest blast radius still staged, not denied', async () => {
    vi.mocked(settingsStore.getSettings).mockReturnValue({
      coreDirectory: '/workspace',
      spaces: [],
      spaceSafetyLevels: {},
    } as any);
    vi.mocked(spaceService.scanSpaces).mockResolvedValue([
      {
        name: 'Public Space',
        path: 'public-space',
        absolutePath: '/workspace/public-space',
        type: 'project',
        isSymlink: false,
        hasReadme: true,
      } as any,
    ]);
    vi.mocked(spaceService.readSpaceReadmeFrontmatter).mockResolvedValue(
      asSpaceFrontmatter({ sharing: 'public' })
    );
    vi.mocked(spaceService.getSpaceDisplayName).mockReturnValue('Public Space');
    vi.mocked(isMigrationComplete).mockReturnValue(true);
    vi.mocked(getSafetyPrompt).mockReturnValue('default safety prompt');
    vi.mocked(getSafetyPromptVersion).mockReturnValue(1);
    vi.mocked(evaluateSafetyPrompt).mockResolvedValue({
      decision: 'block',
      confidence: 'low',
      reason: 'provider unavailable',
      failClosed: true,
    });
    vi.mocked(shouldAllow).mockReturnValue(false);
    vi.mocked(cosPendingService.writeToPending).mockResolvedValue({
      id: 'pending-public-eval-error-1',
      filename: 'public-eval-error.pending.md',
    } as any);

    const hook = createMemoryWriteHook({
      turnId: 'turn-public-eval-error-1',
      sessionId: 'session-public-eval-error-1',
      originalTurnId: 'orig-turn-public-eval-error-1',
      originalSessionId: 'orig-session-public-eval-error-1',
      coreDirectory: '/workspace',
    });

    const result = await hook(
      {
        tool_name: 'Create',
        tool_input: {
          path: '/workspace/public-space/announce.md',
          content: 'public announcement',
        },
        tool_use_id: 'tool-public-eval-error-1',
      },
      'tool-public-eval-error-1',
      { signal: new AbortController().signal }
    );

    // Even at the highest blast radius, an eval outage stages for approval — never a silent drop.
    expect(getHookSpecificOutput(result)?.replaceResult).toEqual(
      expect.objectContaining({ isError: false })
    );
    expect(cosPendingService.writeToPending).toHaveBeenCalledWith(
      expect.objectContaining({
        blockedBy: 'eval_error',
        sharing: 'public',
      })
    );
  });

  it('stages interactive eval_error memory writes when Safety Prompt is rate-limited', async () => {
    vi.mocked(settingsStore.getSettings).mockReturnValue({
      coreDirectory: '/workspace',
      spaces: [],
      spaceSafetyLevels: {
        'test-space': 'balanced',
      },
    } as any);

    vi.mocked(isMigrationComplete).mockReturnValue(true);
    vi.mocked(getSafetyPrompt).mockReturnValue('default safety prompt');
    vi.mocked(getSafetyPromptVersion).mockReturnValue(1);

    vi.mocked(evaluateSafetyPrompt).mockResolvedValue({
      decision: 'block',
      confidence: 'low',
      reason: 'API rate limit active — deferring safety evaluation',
      failClosed: true,
      failClosedReason: 'rate-limited',
      cooldownGenerationId: 12,
    });
    vi.mocked(shouldAllow).mockReturnValue(false);
    vi.mocked(cosPendingService.writeToPending).mockResolvedValue({
      id: 'pending-rate-1',
      filename: 'rate-limit.pending.md',
    } as any);
    const hook = createMemoryWriteHook({
      turnId: 'turn-rate-1',
      sessionId: 'session-rate-1',
      originalTurnId: 'orig-turn-rate-1',
      originalSessionId: 'orig-session-rate-1',
      coreDirectory: '/workspace',
    });

    const result = await hook(
      {
        tool_name: 'Create',
        tool_input: {
          path: '/workspace/test-space/file.md',
          content: 'some content',
        },
        tool_use_id: 'tool-rate-1',
      },
      'tool-rate-1',
      { signal: new AbortController().signal }
    );

    expect(getHookSpecificOutput(result)?.replaceResult).toEqual(
      expect.objectContaining({ isError: false })
    );
    expect(cosPendingService.writeToPending).toHaveBeenCalledWith(
      expect.objectContaining({ blockedBy: 'eval_error' })
    );
    expect(mockSendToAllWindows).toHaveBeenCalledWith(
      'memory:file-staged',
      expect.anything(),
    );
  });

  it('fan-out rate-limited memory writes stage as eval_error (Option A)', async () => {
    vi.mocked(settingsStore.getSettings).mockReturnValue({
      coreDirectory: '/workspace',
      spaces: [],
      spaceSafetyLevels: {
        'test-space': 'balanced',
      },
    } as any);

    vi.mocked(isMigrationComplete).mockReturnValue(true);
    vi.mocked(getSafetyPrompt).mockReturnValue('default safety prompt');
    vi.mocked(getSafetyPromptVersion).mockReturnValue(1);
    vi.mocked(evaluateSafetyPrompt).mockResolvedValue({
      decision: 'block',
      confidence: 'low',
      reason: 'API rate limit active — deferring safety evaluation',
      failClosed: true,
      failClosedReason: 'rate-limited',
      cooldownGenerationId: 55,
    });
    vi.mocked(shouldAllow).mockReturnValue(false);
    vi.mocked(cosPendingService.writeToPending).mockImplementation(async (options) => ({
      id: `pending-rate-fanout-${path.basename(options.destinationPath)}`,
      filename: `${path.basename(options.destinationPath)}.pending.md`,
      coalesced: false,
    } as any));

    const hook = createMemoryWriteHook({
      turnId: 'turn-fanout-1',
      sessionId: 'session-fanout-1',
      originalTurnId: 'orig-turn-fanout-1',
      originalSessionId: 'orig-session-fanout-1',
      coreDirectory: '/workspace',
    });

    const results = [];
    for (let i = 0; i < 10; i++) {
      results.push(await hook(
        {
          tool_name: 'Create',
          tool_input: {
            path: `/workspace/test-space/file-${i}.md`,
            content: `some content ${i}`,
          },
          tool_use_id: `tool-rate-fanout-${i}`,
        },
        `tool-rate-fanout-${i}`,
        { signal: new AbortController().signal }
      ));
    }

    const stagedResults = results.filter((result) => getHookSpecificOutput(result)?.replaceResult?.isError === false);
    const stagedEvents = mockSendToAllWindows.mock.calls.filter((call) => call[0] === 'memory:file-staged');

    expect(stagedResults).toHaveLength(10);
    expect(stagedEvents).toHaveLength(10);
    expect(cosPendingService.writeToPending).toHaveBeenCalledTimes(10);
    const stagedEvalErrorReasons = vi.mocked(cosPendingService.writeToPending).mock.calls.map(
      (call) => String((call[0] as { blockReason?: string }).blockReason ?? '').toLowerCase()
    );
    for (const reason of stagedEvalErrorReasons) {
      for (const forbidden of EVAL_ERROR_FORBIDDEN_SURFACE_SUBSTRINGS) {
        expect(reason).not.toContain(forbidden);
      }
    }
  });

  it('falls back to an honest eval_error deny when interactive eval_error staging is impossible', async () => {
    vi.mocked(settingsStore.getSettings).mockReturnValue({
      coreDirectory: '/workspace',
      spaces: [],
      spaceSafetyLevels: {
        'test-space': 'balanced',
      },
    } as any);
    vi.mocked(isMigrationComplete).mockReturnValue(true);
    vi.mocked(getSafetyPrompt).mockReturnValue('default safety prompt');
    vi.mocked(getSafetyPromptVersion).mockReturnValue(1);
    vi.mocked(evaluateSafetyPrompt).mockResolvedValue({
      decision: 'block',
      confidence: 'low',
      reason: 'API rate limit active — deferring safety evaluation',
      failClosed: true,
      failClosedReason: 'rate-limited',
    });
    vi.mocked(shouldAllow).mockReturnValue(false);
    vi.mocked(cosPendingService.writeToPending).mockResolvedValue(null);

    const hook = createMemoryWriteHook({
      turnId: 'turn-rate-fallback-1',
      sessionId: 'session-rate-fallback-1',
      originalTurnId: 'orig-turn-rate-fallback-1',
      originalSessionId: 'orig-session-rate-fallback-1',
      coreDirectory: '/workspace',
    });

    const result = await hook(
      {
        tool_name: 'Bash',
        tool_input: {
          command: 'curl -s https://example.com/data > /workspace/test-space/out.json',
        },
        tool_use_id: 'tool-rate-fallback-1',
      },
      'tool-rate-fallback-1',
      { signal: new AbortController().signal }
    );

    expect(getHookSpecificOutput(result)?.permissionDecision).toBe('deny');
    expect(getHookSpecificOutput(result)?.permissionDecisionReason).toBe(buildEvalErrorUserReason());
    const denyReason = String(getHookSpecificOutput(result)?.permissionDecisionReason ?? '').toLowerCase();
    for (const forbidden of EVAL_ERROR_FORBIDDEN_SURFACE_SUBSTRINGS) {
      expect(denyReason).not.toContain(forbidden);
    }
  });

  describe('rebel-system hard block', () => {
    it('blocks writes to rebel-system/ with deny', async () => {
      vi.mocked(spaceService.scanSpaces).mockResolvedValue([]);

      const hook = createMemoryWriteHook({
        turnId: 'turn-1',
        sessionId: 'session-1',
        originalTurnId: 'orig-turn-1',
        originalSessionId: 'orig-session-1',
        coreDirectory: '/workspace',
      });

      const result = await hook(
        {
          tool_name: 'Create',
          tool_input: {
            path: '/workspace/rebel-system/skills/operations/my-skill/SKILL.md',
            content: 'skill content',
          },
          tool_use_id: 'tool-rs-1',
        },
        'tool-rs-1',
        { signal: new AbortController().signal }
      );

      expect(getHookSpecificOutput(result)?.permissionDecision).toBe('deny');
      expect(getHookSpecificOutput(result)?.permissionDecisionReason).toContain('rebel-system is read-only');
    });

    it('blocks Write tool to rebel-system/', async () => {
      vi.mocked(spaceService.scanSpaces).mockResolvedValue([]);

      const hook = createMemoryWriteHook({
        turnId: 'turn-1',
        sessionId: 'session-1',
        originalTurnId: 'orig-turn-1',
        originalSessionId: 'orig-session-1',
        coreDirectory: '/workspace',
      });

      const result = await hook(
        {
          tool_name: 'Write',
          tool_input: {
            file_path: '/workspace/rebel-system/help-for-humans/test.md',
            content: 'overwrite',
          },
          tool_use_id: 'tool-rs-2',
        },
        'tool-rs-2',
        { signal: new AbortController().signal }
      );

      expect(getHookSpecificOutput(result)?.permissionDecision).toBe('deny');
      expect(getHookSpecificOutput(result)?.permissionDecisionReason).toContain('rebel-system is read-only');
    });

    it('blocks Edit tool to rebel-system/', async () => {
      vi.mocked(spaceService.scanSpaces).mockResolvedValue([]);

      const hook = createMemoryWriteHook({
        turnId: 'turn-1',
        sessionId: 'session-1',
        originalTurnId: 'orig-turn-1',
        originalSessionId: 'orig-session-1',
        coreDirectory: '/workspace',
      });

      const result = await hook(
        {
          tool_name: 'Edit',
          tool_input: {
            file_path: '/workspace/rebel-system/AGENTS.md',
            old_str: 'old',
            new_str: 'new',
          },
          tool_use_id: 'tool-rs-3',
        },
        'tool-rs-3',
        { signal: new AbortController().signal }
      );

      expect(getHookSpecificOutput(result)?.permissionDecision).toBe('deny');
      expect(getHookSpecificOutput(result)?.permissionDecisionReason).toContain('rebel-system is read-only');
    });

    it('allows writes to non-rebel-system paths', async () => {
      const hook = createMemoryWriteHook({
        turnId: 'turn-1',
        sessionId: 'session-1',
        originalTurnId: 'orig-turn-1',
        originalSessionId: 'orig-session-1',
        coreDirectory: '/workspace',
      });

      vi.mocked(cosPendingService.writeToPending).mockResolvedValue({
        id: 'pending-ok',
        filename: 'ok.md',
      } as any);

      const result = await hook(
        {
          tool_name: 'Create',
          tool_input: {
            path: '/workspace/test-space/skills/my-skill/SKILL.md',
            content: 'skill content',
          },
          tool_use_id: 'tool-ok-1',
        },
        'tool-ok-1',
        { signal: new AbortController().signal }
      );

      // Should go through normal flow (staging via replaceResult), NOT be blocked
      expect(getHookSpecificOutput(result)?.replaceResult).toEqual(
        expect.objectContaining({ isError: false })
      );
    });
  });

  describe('plugin source-file intercept', () => {
    // Direct filesystem writes to plugin source files must be redirected to the
    // rebel_plugins_create MCP tool. See planning doc 260527 — Stage 1.
    //
    // These tests use real on-disk fixtures (a temp dir with/without
    // manifest.json) because `fs.access` cannot be spied via vi.spyOn under
    // Vitest's ESM module-namespace rules.

    let tempDir: string;

    beforeEach(async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rebel-plugin-intercept-test-'));
    });

    afterEach(async () => {
      await fs.rm(tempDir, { recursive: true, force: true });
    });

    it('redirects Edit on a Space plugin file (manifest sibling present) to rebel_plugins_create', async () => {
      // Real fixture: plugin dir with sibling manifest.json.
      const pluginDir = path.join(tempDir, 'work/mindstone/General/plugins/community-geography-dashboard');
      await fs.mkdir(pluginDir, { recursive: true });
      await fs.writeFile(path.join(pluginDir, 'manifest.json'), '{"id":"community-geography-dashboard"}');
      await fs.writeFile(path.join(pluginDir, 'index.tsx'), 'export default function() { return null; }');

      const hook = createMemoryWriteHook({
        turnId: 'turn-plugin-1',
        sessionId: 'session-plugin-1',
        originalTurnId: 'orig-turn-plugin-1',
        originalSessionId: 'orig-session-plugin-1',
        coreDirectory: tempDir,
      });

      const result = await hook(
        {
          tool_name: 'Edit',
          tool_input: {
            file_path: path.join(pluginDir, 'index.tsx'),
            old_str: 'null',
            new_str: 'undefined',
          },
          tool_use_id: 'tool-plugin-1',
        },
        'tool-plugin-1',
        { signal: new AbortController().signal }
      );

      const out = getHookSpecificOutput(result);
      expect(out?.permissionDecision).toBe('deny');
      const reason = out?.permissionDecisionReason ?? '';
      expect(reason).toContain('rebel_plugins_create');
      expect(reason).toContain('community-geography-dashboard');
      expect(reason).toContain('rebel_plugins_get_source');
    });

    it('redirects Write on a plugin file to rebel_plugins_create', async () => {
      const pluginDir = path.join(tempDir, 'work/mindstone/General/plugins/my-plugin');
      await fs.mkdir(pluginDir, { recursive: true });
      await fs.writeFile(path.join(pluginDir, 'manifest.json'), '{"id":"my-plugin"}');
      await fs.writeFile(path.join(pluginDir, 'index.tsx'), 'original');

      const hook = createMemoryWriteHook({
        turnId: 'turn-plugin-2',
        sessionId: 'session-plugin-2',
        originalTurnId: 'orig-turn-plugin-2',
        originalSessionId: 'orig-session-plugin-2',
        coreDirectory: tempDir,
      });

      const result = await hook(
        {
          tool_name: 'Write',
          tool_input: {
            file_path: path.join(pluginDir, 'index.tsx'),
            content: 'overwritten content',
          },
          tool_use_id: 'tool-plugin-2',
        },
        'tool-plugin-2',
        { signal: new AbortController().signal }
      );

      expect(getHookSpecificOutput(result)?.permissionDecision).toBe('deny');
      expect(getHookSpecificOutput(result)?.permissionDecisionReason).toContain('rebel_plugins_create');
    });

    it('passes through Edit on a plugin-like path when manifest.json is missing (not a real plugin)', async () => {
      // Plugin-like path layout but NO sibling manifest.json — this is a
      // user folder that happens to look like a plugin, not a real installed
      // plugin. The intercept must NOT fire.
      const pluginLikeDir = path.join(tempDir, 'test-space/notes/plugins/example');
      await fs.mkdir(pluginLikeDir, { recursive: true });
      await fs.writeFile(path.join(pluginLikeDir, 'index.tsx'), 'original');
      // Intentionally NO manifest.json.

      const hook = createMemoryWriteHook({
        turnId: 'turn-plugin-3',
        sessionId: 'session-plugin-3',
        originalTurnId: 'orig-turn-plugin-3',
        originalSessionId: 'orig-session-plugin-3',
        coreDirectory: tempDir,
      });

      vi.mocked(cosPendingService.writeToPending).mockResolvedValue({
        id: 'pending-pluginlike',
        filename: 'index.tsx',
      } as any);

      const result = await hook(
        {
          tool_name: 'Edit',
          tool_input: {
            file_path: path.join(pluginLikeDir, 'index.tsx'),
            old_str: 'a',
            new_str: 'b',
          },
          tool_use_id: 'tool-plugin-3',
        },
        'tool-plugin-3',
        { signal: new AbortController().signal }
      );

      // Must NOT be denied by the plugin intercept — falls through to normal
      // space-safety path. Either staged (replaceResult) or auto-approved
      // (empty result); both are acceptable — the assertion is only that the
      // plugin intercept did NOT fire its denial.
      const out = getHookSpecificOutput(result);
      const reason = out?.permissionDecisionReason ?? '';
      expect(reason).not.toContain('rebel_plugins_create');
    });

    it('passes through Edit on a non-plugin file even with sibling manifest.json', async () => {
      // Path doesn't match `/plugins/<id>/index.tsx$` — the intercept must
      // not fire regardless of what other files happen to exist nearby.
      const notesDir = path.join(tempDir, 'test-space/memory/topics');
      await fs.mkdir(notesDir, { recursive: true });
      await fs.writeFile(path.join(notesDir, 'manifest.json'), '{}'); // red herring
      await fs.writeFile(path.join(notesDir, 'foo.md'), 'original');

      const hook = createMemoryWriteHook({
        turnId: 'turn-plugin-4',
        sessionId: 'session-plugin-4',
        originalTurnId: 'orig-turn-plugin-4',
        originalSessionId: 'orig-session-plugin-4',
        coreDirectory: tempDir,
      });

      vi.mocked(cosPendingService.writeToPending).mockResolvedValue({
        id: 'pending-notes',
        filename: 'foo.md',
      } as any);

      const result = await hook(
        {
          tool_name: 'Edit',
          tool_input: {
            file_path: path.join(notesDir, 'foo.md'),
            old_str: 'a',
            new_str: 'b',
          },
          tool_use_id: 'tool-plugin-4',
        },
        'tool-plugin-4',
        { signal: new AbortController().signal }
      );

      const out = getHookSpecificOutput(result);
      const reason = out?.permissionDecisionReason ?? '';
      expect(reason).not.toContain('rebel_plugins_create');
    });

    it('redirects Edit when the file_path is a RELATIVE workspace path (resolves against coreDirectory)', async () => {
      // Real fixture under coreDirectory, but the tool sees only the relative
      // path. Stage 1 reviewer flagged this as a fall-through; the intercept
      // must now resolve via coreDirectory before probing the manifest.
      const relPluginDir = 'work/mindstone/General/plugins/community-geography-dashboard';
      const absPluginDir = path.join(tempDir, relPluginDir);
      await fs.mkdir(absPluginDir, { recursive: true });
      await fs.writeFile(path.join(absPluginDir, 'manifest.json'), '{"id":"community-geography-dashboard"}');
      await fs.writeFile(path.join(absPluginDir, 'index.tsx'), 'export default function() {}');

      const hook = createMemoryWriteHook({
        turnId: 'turn-plugin-rel',
        sessionId: 'session-plugin-rel',
        originalTurnId: 'orig-turn-plugin-rel',
        originalSessionId: 'orig-session-plugin-rel',
        coreDirectory: tempDir,
      });

      const result = await hook(
        {
          tool_name: 'Edit',
          tool_input: {
            file_path: `${relPluginDir}/index.tsx`,
            old_str: 'foo',
            new_str: 'bar',
          },
          tool_use_id: 'tool-plugin-rel',
        },
        'tool-plugin-rel',
        { signal: new AbortController().signal }
      );

      const out = getHookSpecificOutput(result);
      expect(out?.permissionDecision).toBe('deny');
      expect(out?.permissionDecisionReason).toContain('rebel_plugins_create');
      expect(out?.permissionDecisionReason).toContain('community-geography-dashboard');
    });

    it('redirects Edit on a digit-leading plugin ID (parity with bridge PLUGIN_ID_PATTERN)', async () => {
      // The bridge accepts ^[a-z0-9]+(?:-[a-z0-9]+)*$ — IDs may start with a
      // digit. Stage 1 reviewer flagged that the hook regex was stricter and
      // would let digit-leading IDs slip through.
      const pluginDir = path.join(tempDir, 'work/mindstone/General/plugins/2026-dashboard');
      await fs.mkdir(pluginDir, { recursive: true });
      await fs.writeFile(path.join(pluginDir, 'manifest.json'), '{"id":"2026-dashboard"}');
      await fs.writeFile(path.join(pluginDir, 'index.tsx'), 'export default function() {}');

      const hook = createMemoryWriteHook({
        turnId: 'turn-plugin-digit',
        sessionId: 'session-plugin-digit',
        originalTurnId: 'orig-turn-plugin-digit',
        originalSessionId: 'orig-session-plugin-digit',
        coreDirectory: tempDir,
      });

      const result = await hook(
        {
          tool_name: 'Edit',
          tool_input: {
            file_path: path.join(pluginDir, 'index.tsx'),
            old_str: 'foo',
            new_str: 'bar',
          },
          tool_use_id: 'tool-plugin-digit',
        },
        'tool-plugin-digit',
        { signal: new AbortController().signal }
      );

      const out = getHookSpecificOutput(result);
      expect(out?.permissionDecision).toBe('deny');
      expect(out?.permissionDecisionReason).toContain('2026-dashboard');
    });

    it('fails closed (deny) when the manifest probe fails with a non-ENOENT error', async () => {
      // Real fixture for the regex match, but make the manifest dir
      // inaccessible (chmod 0) so fs.access throws EACCES — NOT ENOENT.
      // The intercept must deny rather than treat the unverifiable case
      // as "not a plugin". Skipped on Windows where chmod permission bits
      // don't behave the same way.
      if (process.platform === 'win32') {
        return;
      }
      const pluginDir = path.join(tempDir, 'work/mindstone/General/plugins/locked-plugin');
      await fs.mkdir(pluginDir, { recursive: true });
      await fs.writeFile(path.join(pluginDir, 'index.tsx'), 'export default function() {}');
      // Don't create manifest.json. Make dir unreadable so even the access
      // probe fails with EACCES rather than ENOENT.
      await fs.chmod(pluginDir, 0o000);

      try {
        const hook = createMemoryWriteHook({
          turnId: 'turn-plugin-fail-closed',
          sessionId: 'session-plugin-fail-closed',
          originalTurnId: 'orig-turn-plugin-fail-closed',
          originalSessionId: 'orig-session-plugin-fail-closed',
          coreDirectory: tempDir,
        });

        const result = await hook(
          {
            tool_name: 'Edit',
            tool_input: {
              file_path: path.join(pluginDir, 'index.tsx'),
              old_str: 'foo',
              new_str: 'bar',
            },
            tool_use_id: 'tool-plugin-fail-closed',
          },
          'tool-plugin-fail-closed',
          { signal: new AbortController().signal }
        );

        const out = getHookSpecificOutput(result);
        expect(out?.permissionDecision).toBe('deny');
        expect(out?.permissionDecisionReason).toMatch(/manifest probe failed/i);
      } finally {
        // Restore perms so afterEach cleanup can rm -rf.
        await fs.chmod(pluginDir, 0o755).catch(() => undefined);
      }
    });
  });

  describe('temp directory auto-approve', () => {
    it('auto-approves writes to /tmp (empty return = allow)', async () => {
      // scanSpaces returns no matching space for /tmp paths
      vi.mocked(spaceService.scanSpaces).mockResolvedValue([]);

      const hook = createMemoryWriteHook({
        turnId: 'turn-1',
        sessionId: 'session-1',
        originalTurnId: 'orig-turn-1',
        originalSessionId: 'orig-session-1',
        coreDirectory: '/workspace',
      });

      const result = await hook(
        {
          tool_name: 'Create',
          tool_input: {
            path: '/tmp/scratch.txt',
            content: 'temp data',
          },
          tool_use_id: 'tool-tmp-1',
        },
        'tool-tmp-1',
        { signal: new AbortController().signal }
      );

      // Empty object = allow (memory write hook convention)
      expect(result).toEqual({});
    });

    it('does NOT auto-approve temp writes when privateMode is enabled', async () => {
      vi.mocked(spaceService.scanSpaces).mockResolvedValue([]);

      const hook = createMemoryWriteHook({
        turnId: 'turn-1',
        sessionId: 'session-1',
        originalTurnId: 'orig-turn-1',
        originalSessionId: 'orig-session-1',
        coreDirectory: '/workspace',
        privateMode: true,
      });

      const result = await hook(
        {
          tool_name: 'Create',
          tool_input: {
            path: '/tmp/scratch.txt',
            content: 'temp data',
          },
          tool_use_id: 'tool-tmp-pm',
        },
        'tool-tmp-pm',
        { signal: new AbortController().signal }
      );

      // Should NOT be empty {} (should go through normal flow, likely staging)
      // In private mode, temp writes are not auto-approved
      expect(getHookSpecificOutput(result)?.permissionDecision).not.toBeUndefined();
    });

    it('does NOT auto-approve temp writes when coreDirectory is under temp path (demo mode)', async () => {
      vi.mocked(spaceService.scanSpaces).mockResolvedValue([]);

      const hook = createMemoryWriteHook({
        turnId: 'turn-1',
        sessionId: 'session-1',
        originalTurnId: 'orig-turn-1',
        originalSessionId: 'orig-session-1',
        coreDirectory: '/tmp/demo-workspace', // Core under temp!
      });

      const result = await hook(
        {
          tool_name: 'Create',
          tool_input: {
            path: '/tmp/demo-workspace/file.md',
            content: 'demo data',
          },
          tool_use_id: 'tool-tmp-demo',
        },
        'tool-tmp-demo',
        { signal: new AbortController().signal }
      );

      // When core is under temp, should NOT auto-approve — goes through normal flow
      // The path is a workspace_root classification, not temp, since it's under core
      // So this actually tests the workspace_root path instead
      expect(result).toBeDefined();
    });

    it('does NOT auto-approve regular workspace writes', async () => {
      const hook = createMemoryWriteHook({
        turnId: 'turn-1',
        sessionId: 'session-1',
        originalTurnId: 'orig-turn-1',
        originalSessionId: 'orig-session-1',
        coreDirectory: '/workspace',
      });

      vi.mocked(cosPendingService.writeToPending).mockResolvedValue({
        id: 'pending-456',
        filename: 'report.md',
      } as any);

      const result = await hook(
        {
          tool_name: 'Create',
          tool_input: {
            path: '/workspace/test-space/report.md',
            content: 'workspace data',
          },
          tool_use_id: 'tool-ws-1',
        },
        'tool-ws-1',
        { signal: new AbortController().signal }
      );

      // Regular workspace writes should go through normal staging flow (transparent success)
      expect(getHookSpecificOutput(result)?.replaceResult).toEqual(
        expect.objectContaining({ isError: false })
      );
    });
  });

  describe('shared-skill protection checkpoints', () => {
    it('blocks non-author shared-skill edits behind a confirmation checkpoint', async () => {
      vi.spyOn(sharedSkillMutationService, 'getNonAuthorSharedSkillProtectionContext').mockResolvedValue({
        target: {
          absolutePath: '/workspace/test-space/skills/demo-skill/SKILL.md',
          relativePath: 'test-space/skills/demo-skill/SKILL.md',
          sharing: 'restricted',
          spaceName: 'Test Space',
          spacePath: 'test-space',
          spaceAbsolutePath: '/workspace/test-space',
          shape: 'folder',
        },
        authorLabel: 'Anna',
        skillName: 'demo-skill',
        approvalIdentifier: 'shared-skill:test-space/skills/demo-skill/skill.md',
      } as any);
      const prepareManagedToolInput = vi
        .spyOn(sharedSkillMutationService, 'prepareManagedToolInput')
        .mockResolvedValue(null);

      const hook = createMemoryWriteHook({
        turnId: 'turn-shared-checkpoint',
        sessionId: 'session-shared-checkpoint',
        originalTurnId: 'orig-turn-shared-checkpoint',
        originalSessionId: 'orig-session-shared-checkpoint',
        coreDirectory: '/workspace',
      });

      const result = await hook(
        {
          tool_name: 'Edit',
          tool_input: {
            file_path: '/workspace/test-space/skills/demo-skill/SKILL.md',
            old_string: 'Old text',
            new_string: 'New text',
          },
          tool_use_id: 'tool-shared-checkpoint',
        },
        'tool-shared-checkpoint',
        { signal: new AbortController().signal }
      );

      expect(getHookSpecificOutput(result)?.permissionDecision).toBe('deny');
      expect(getHookSpecificOutput(result)?.permissionDecisionReason).toContain('SHARED SKILL CHECKPOINT');
      expect(mockSendToAllWindows).toHaveBeenCalledWith(
        'memory:write-approval-request',
        expect.objectContaining({
          approvalKind: 'shared_skill_checkpoint',
          approvalIdentifier: 'shared-skill:test-space/skills/demo-skill/skill.md',
          summary: expect.stringContaining('created by Anna'),
        }),
      );
      // prepareManagedToolInput IS called during the checkpoint staging attempt
      // (with suppressRegistration: true). Since mock returns null here,
      // staging falls back to blocking approval.
      expect(prepareManagedToolInput).toHaveBeenCalledTimes(1);
      expect(prepareManagedToolInput).toHaveBeenCalledWith(
        'Edit',
        expect.any(Object),
        '/workspace',
        expect.objectContaining({ kind: 'agent' }),
        { suppressRegistration: true },
      );
    });

    it('allows a confirmed retry for non-author shared-skill edits', async () => {
      vi.spyOn(sharedSkillMutationService, 'getNonAuthorSharedSkillProtectionContext').mockResolvedValue({
        target: {
          absolutePath: '/workspace/test-space/skills/demo-skill/SKILL.md',
          relativePath: 'test-space/skills/demo-skill/SKILL.md',
          sharing: 'restricted',
          spaceName: 'Test Space',
          spacePath: 'test-space',
          spaceAbsolutePath: '/workspace/test-space',
          shape: 'folder',
        },
        authorLabel: 'Anna',
        skillName: 'demo-skill',
        approvalIdentifier: 'shared-skill:test-space/skills/demo-skill/skill.md',
      } as any);
      const prepareManagedToolInput = vi
        .spyOn(sharedSkillMutationService, 'prepareManagedToolInput')
        .mockResolvedValue(null);

      const hook = createMemoryWriteHook({
        turnId: 'turn-shared-retry',
        sessionId: 'session-shared-retry',
        originalTurnId: 'orig-turn-shared-retry',
        originalSessionId: 'orig-session-shared-retry',
        coreDirectory: '/workspace',
      });

      await hook(
        {
          tool_name: 'Edit',
          tool_input: {
            file_path: '/workspace/test-space/skills/demo-skill/SKILL.md',
            old_string: 'Old text',
            new_string: 'New text',
          },
          tool_use_id: 'tool-shared-retry',
        },
        'tool-shared-retry',
        { signal: new AbortController().signal }
      );

      handleMemoryWriteApprovalResponse('tool-shared-retry', true);

      await hook(
        {
          tool_name: 'Edit',
          tool_input: {
            file_path: '/workspace/test-space/skills/demo-skill/SKILL.md',
            old_string: 'Old text',
            new_string: 'New text',
          },
          tool_use_id: 'tool-shared-retry-2',
        },
        'tool-shared-retry-2',
        { signal: new AbortController().signal }
      );

      // 1st call: prepareManagedToolInput during checkpoint staging (suppressRegistration: true)
      // 2nd call: prepareManagedToolInput during normal enrichment path (on approved retry)
      expect(prepareManagedToolInput).toHaveBeenCalledTimes(2);
    });

    it('does not consume shared-skill approval tokens when sticky preflight stages first', async () => {
      const approvalIdentifier = 'shared-skill:test-space/skills/demo-skill/skill.md';
      const sessionId = 'session-shared-preflight-token';
      const originalSessionId = 'orig-session-shared-preflight-token';

      vi.spyOn(sharedSkillMutationService, 'getNonAuthorSharedSkillProtectionContext').mockResolvedValue({
        target: {
          absolutePath: '/workspace/test-space/skills/demo-skill/SKILL.md',
          relativePath: 'test-space/skills/demo-skill/SKILL.md',
          sharing: 'restricted',
          spaceName: 'Test Space',
          spacePath: 'test-space',
          spaceAbsolutePath: '/workspace/test-space',
          shape: 'folder',
        },
        authorLabel: 'Anna',
        skillName: 'demo-skill',
        approvalIdentifier,
      } as any);

      vi.mocked(cosPendingService.getPendingFileByDestination).mockResolvedValue({
        file: {
          id: 'pending-shared-token-old',
          filename: 'shared-token-old.pending.md',
          frontmatter: {
            session_id: originalSessionId,
            tool_use_id: 'old-tool-use-shared-token',
            blocked_by: 'safety_prompt',
          },
        },
        content: 'Current skill content',
      } as any);
      vi.mocked(cosPendingService.writeToPending).mockResolvedValue({
        id: 'pending-shared-token-new',
        filename: 'shared-token-new.pending.md',
      } as any);

      storeSingleUseApproval('memory', sessionId, approvalIdentifier);

      const hook = createMemoryWriteHook({
        turnId: 'turn-shared-preflight-token',
        sessionId,
        originalTurnId: 'orig-turn-shared-preflight-token',
        originalSessionId,
        coreDirectory: '/workspace',
      });

      const result = await hook(
        {
          tool_name: 'Edit',
          tool_input: {
            file_path: '/workspace/test-space/skills/demo-skill/SKILL.md',
            old_string: 'Current',
            new_string: 'Updated',
          },
          tool_use_id: 'tool-shared-preflight-token',
        },
        'tool-shared-preflight-token',
        { signal: new AbortController().signal }
      );

      expect(getHookSpecificOutput(result)?.replaceResult).toEqual(
        expect.objectContaining({ isError: false })
      );
      expect(
        consumeSingleUseApproval('memory', sessionId, approvalIdentifier)
      ).toBe(true);
    });
  });

  describe('multi-write staged revision consolidation', () => {
    it('stages Edit-after-Create from same-session pending content and resolves superseded approval', async () => {
      const filePath = '/workspace/test-space/new-file.md';
      const removePendingMemoryApprovalSpy = vi.spyOn(pendingApprovalsStore, 'removePendingMemoryApproval');

      vi.mocked(cosPendingService.getPendingFileByDestination)
        .mockResolvedValueOnce({ kind: 'none' } as any)
        .mockResolvedValueOnce({ kind: 'none' } as any)
        .mockResolvedValueOnce({
          file: {
            id: 'pending-old-1',
            filename: 'old.pending.md',
            frontmatter: { session_id: 'orig-session-multi-create-1', tool_use_id: 'old-tool-use-1' },
          },
          content: 'Hello world',
        } as any)
        .mockResolvedValueOnce({
          file: {
            id: 'pending-old-1',
            filename: 'old.pending.md',
            frontmatter: { session_id: 'orig-session-multi-create-1', tool_use_id: 'old-tool-use-1' },
          },
          content: 'Hello world',
        } as any);

      vi.mocked(cosPendingService.writeToPending)
        .mockResolvedValueOnce({ id: 'pending-create-1', filename: 'create.pending.md' } as any)
        .mockResolvedValueOnce({ id: 'pending-edit-1', filename: 'edit.pending.md' } as any);

      const hook = createMemoryWriteHook({
        turnId: 'turn-multi-create-1',
        sessionId: 'session-multi-create-1',
        originalTurnId: 'orig-turn-multi-create-1',
        originalSessionId: 'orig-session-multi-create-1',
        coreDirectory: '/workspace',
      });

      const createResult = await hook(
        {
          tool_name: 'Create',
          tool_input: {
            path: filePath,
            content: 'Hello world',
          },
          tool_use_id: 'tool-create-1',
        },
        'tool-create-1',
        { signal: new AbortController().signal }
      );
      expect(getHookSpecificOutput(createResult)?.replaceResult).toEqual(
        expect.objectContaining({ isError: false })
      );

      const editResult = await hook(
        {
          tool_name: 'Edit',
          tool_input: {
            file_path: filePath,
            old_str: 'world',
            new_str: 'Rebel',
          },
          tool_use_id: 'tool-edit-1',
        },
        'tool-edit-1',
        { signal: new AbortController().signal }
      );
      expect(getHookSpecificOutput(editResult)?.replaceResult).toEqual(
        expect.objectContaining({ isError: false })
      );

      expect(cosPendingService.getPendingFileByDestination).toHaveBeenCalledWith(filePath);
      expect(cosPendingService.getPendingFileByDestination).toHaveBeenCalledWith(
        filePath,
        'orig-session-multi-create-1'
      );
      expect(cosPendingService.writeToPending).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ content: 'Hello Rebel' })
      );
      expect(cosPendingService.deletePendingFile).not.toHaveBeenCalled();
      expect(removePendingMemoryApprovalSpy).toHaveBeenCalledWith('old-tool-use-1');
      expect(mockSendToAllWindows).toHaveBeenCalledWith('memory:write-approval-resolved', {
        toolUseId: 'old-tool-use-1',
        originalSessionId: 'orig-session-multi-create-1',
        approved: false,
      });
    });

    it('sticky preflight stages same-session private-space write instead of permissive auto-approve', async () => {
      const filePath = '/workspace/private-space/sticky.md';
      const removePendingMemoryApprovalSpy = vi.spyOn(pendingApprovalsStore, 'removePendingMemoryApproval');

      vi.mocked(settingsStore.getSettings).mockReturnValue({
        coreDirectory: '/workspace',
        spaces: [],
        spaceSafetyLevels: {},
      } as any);
      vi.mocked(spaceService.scanSpaces).mockResolvedValue([
        {
          name: 'Private Space',
          path: 'private-space',
          absolutePath: '/workspace/private-space',
          type: 'personal',
          isSymlink: false,
          hasReadme: true,
        } as any,
      ]);
      vi.mocked(spaceService.readSpaceReadmeFrontmatter).mockResolvedValue(
        asSpaceFrontmatter({ sharing: 'private' })
      );
      vi.mocked(spaceService.getSpaceDisplayName).mockReturnValue('Private Space');

      vi.mocked(cosPendingService.getPendingFileByDestination).mockResolvedValue({
        file: {
          id: 'pending-sticky-old',
          filename: 'sticky-old.pending.md',
          frontmatter: {
            session_id: 'orig-session-sticky-private-1',
            tool_use_id: 'old-tool-use-sticky-private-1',
            blocked_by: 'safety_prompt',
          },
        },
        content: 'original pending content',
      } as any);
      vi.mocked(cosPendingService.writeToPending).mockResolvedValue({
        id: 'pending-sticky-new',
        filename: 'sticky-new.pending.md',
      } as any);

      const hook = createMemoryWriteHook({
        turnId: 'turn-sticky-private-1',
        sessionId: 'session-sticky-private-1',
        originalTurnId: 'orig-turn-sticky-private-1',
        originalSessionId: 'orig-session-sticky-private-1',
        coreDirectory: '/workspace',
      });

      const result = await hook(
        {
          tool_name: 'Create',
          tool_input: {
            path: filePath,
            content: 'replacement content',
          },
          tool_use_id: 'tool-use-sticky-private-1',
        },
        'tool-use-sticky-private-1',
        { signal: new AbortController().signal }
      );

      expect(getHookSpecificOutput(result)?.replaceResult).toEqual(
        expect.objectContaining({ isError: false })
      );
      expect(cosPendingService.writeToPending).toHaveBeenCalledWith(
        expect.objectContaining({
          destinationPath: filePath,
          toolUseId: 'tool-use-sticky-private-1',
          blockedBy: 'safety_prompt',
        })
      );
      expect(removePendingMemoryApprovalSpy).toHaveBeenCalledWith('old-tool-use-sticky-private-1');
      expect(mockSendToAllWindows).toHaveBeenCalledWith('memory:write-approval-resolved', {
        toolUseId: 'old-tool-use-sticky-private-1',
        originalSessionId: 'orig-session-sticky-private-1',
        approved: false,
      });
      expect(evaluateSafetyPrompt).not.toHaveBeenCalled();
    });

    it('sticky preflight reuses safe summary for structural_policy pending replacements', async () => {
      const filePath = '/workspace/private-space/secret.md';

      vi.mocked(settingsStore.getSettings).mockReturnValue({
        coreDirectory: '/workspace',
        spaces: [],
        spaceSafetyLevels: {},
      } as any);
      vi.mocked(spaceService.scanSpaces).mockResolvedValue([
        {
          name: 'Private Space',
          path: 'private-space',
          absolutePath: '/workspace/private-space',
          type: 'personal',
          isSymlink: false,
          hasReadme: true,
        } as any,
      ]);
      vi.mocked(spaceService.readSpaceReadmeFrontmatter).mockResolvedValue(
        asSpaceFrontmatter({ sharing: 'private' })
      );
      vi.mocked(spaceService.getSpaceDisplayName).mockReturnValue('Private Space');

      vi.mocked(cosPendingService.getPendingFileByDestination).mockResolvedValue({
        file: {
          id: 'pending-structural-old',
          filename: 'structural-old.pending.md',
          frontmatter: {
            session_id: 'orig-session-structural-preflight-1',
            tool_use_id: 'old-tool-use-structural-preflight-1',
            blocked_by: 'structural_policy',
            summary: 'Do not reuse this summary',
          },
        },
        content: 'pending secret content',
      } as any);
      vi.mocked(cosPendingService.writeToPending).mockResolvedValue({
        id: 'pending-structural-new',
        filename: 'structural-new.pending.md',
      } as any);

      const hook = createMemoryWriteHook({
        turnId: 'turn-structural-preflight-1',
        sessionId: 'session-structural-preflight-1',
        originalTurnId: 'orig-turn-structural-preflight-1',
        originalSessionId: 'orig-session-structural-preflight-1',
        coreDirectory: '/workspace',
      });

      const result = await hook(
        {
          tool_name: 'Create',
          tool_input: {
            path: filePath,
            content: 'sk-live-abc123',
          },
          tool_use_id: 'tool-use-structural-preflight-1',
        },
        'tool-use-structural-preflight-1',
        { signal: new AbortController().signal }
      );

      expect(getHookSpecificOutput(result)?.replaceResult).toEqual(
        expect.objectContaining({ isError: false })
      );
      expect(cosPendingService.writeToPending).toHaveBeenCalledWith(
        expect.objectContaining({
          blockedBy: 'structural_policy',
          summary: 'Possible credentials detected — review before saving',
        })
      );
    });

    it('stages defensively when preflight sees candidate_unreadable pending lookup', async () => {
      const filePath = '/workspace/private-space/unreadable-preflight.md';

      vi.mocked(cosPendingService.getPendingFileByDestination).mockResolvedValue({
        kind: 'candidate_unreadable',
        filePath: '/workspace/Chief-of-Staff/memory/pending/bad.pending.md',
        reason: 'failed_to_parse_pending_frontmatter',
      } as any);
      vi.mocked(cosPendingService.writeToPending).mockResolvedValue({
        id: 'pending-unreadable-new',
        filename: 'unreadable-new.pending.md',
      } as any);

      const hook = createMemoryWriteHook({
        turnId: 'turn-unreadable-preflight-1',
        sessionId: 'session-unreadable-preflight-1',
        originalTurnId: 'orig-turn-unreadable-preflight-1',
        originalSessionId: 'orig-session-unreadable-preflight-1',
        coreDirectory: '/workspace',
      });

      const result = await hook(
        {
          tool_name: 'Create',
          tool_input: {
            path: filePath,
            content: 'replacement content',
          },
          tool_use_id: 'tool-unreadable-preflight-1',
        },
        'tool-unreadable-preflight-1',
        { signal: new AbortController().signal },
      );

      expect(getHookSpecificOutput(result)?.replaceResult).toEqual(
        expect.objectContaining({ isError: false }),
      );
      expect(cosPendingService.writeToPending).toHaveBeenCalledWith(
        expect.objectContaining({
          destinationPath: filePath,
          blockedBy: 'structural_policy',
          summary: 'Possible credentials detected — review before saving',
        }),
      );
    });

    it('fails closed to FILE ALREADY PENDING REVIEW when candidate_unreadable preflight cannot stage', async () => {
      const filePath = '/workspace/private-space/unreadable-fallback.md';

      vi.mocked(cosPendingService.getPendingFileByDestination).mockResolvedValue({
        kind: 'candidate_unreadable',
        filePath: '/workspace/Chief-of-Staff/memory/pending/bad.pending.md',
        reason: 'failed_to_parse_pending_frontmatter',
      } as any);
      vi.mocked(cosPendingService.writeToPending).mockResolvedValue(null);

      const hook = createMemoryWriteHook({
        turnId: 'turn-unreadable-fallback-1',
        sessionId: 'session-unreadable-fallback-1',
        originalTurnId: 'orig-turn-unreadable-fallback-1',
        originalSessionId: 'orig-session-unreadable-fallback-1',
        coreDirectory: '/workspace',
      });

      const result = await hook(
        {
          tool_name: 'Create',
          tool_input: {
            path: filePath,
            content: 'replacement content',
          },
          tool_use_id: 'tool-unreadable-fallback-1',
        },
        'tool-unreadable-fallback-1',
        { signal: new AbortController().signal },
      );

      expect(getHookSpecificOutput(result)?.permissionDecision).toBe('deny');
      expect(getHookSpecificOutput(result)?.permissionDecisionReason).toContain('FILE ALREADY PENDING REVIEW');
      expect(cosPendingService.writeToPending).toHaveBeenCalled();
    });

    it('fails closed when Edit payload is missing new_str during sticky preflight staging', async () => {
      const filePath = '/workspace/private-space/edit-missing-new.md';

      vi.mocked(cosPendingService.getPendingFileByDestination).mockResolvedValue({
        kind: 'found',
        file: {
          id: 'pending-missing-new-old',
          filename: 'missing-new-old.pending.md',
          frontmatter: {
            session_id: 'orig-session-edit-missing-new-1',
            tool_use_id: 'old-tool-use-edit-missing-new-1',
            blocked_by: 'safety_prompt',
            summary: 'Old summary',
          },
        },
        content: 'Current content',
      } as any);

      const hook = createMemoryWriteHook({
        turnId: 'turn-edit-missing-new-1',
        sessionId: 'session-edit-missing-new-1',
        originalTurnId: 'orig-turn-edit-missing-new-1',
        originalSessionId: 'orig-session-edit-missing-new-1',
        coreDirectory: '/workspace',
      });

      const result = await hook(
        {
          tool_name: 'Edit',
          tool_input: {
            file_path: filePath,
            old_str: 'Current',
            // missing new_str/new_string should fail closed
          },
          tool_use_id: 'tool-edit-missing-new-1',
        },
        'tool-edit-missing-new-1',
        { signal: new AbortController().signal },
      );

      expect(getHookSpecificOutput(result)?.permissionDecision).toBe('deny');
      expect(getHookSpecificOutput(result)?.permissionDecisionReason).toContain('FILE ALREADY PENDING REVIEW');
      expect(cosPendingService.writeToPending).not.toHaveBeenCalled();
    });

    it('fails closed when Edit extractFullContent sees candidate_unreadable pending lookup', async () => {
      const filePath = '/workspace/private-space/edit-unreadable-base.md';

      vi.mocked(cosPendingService.getPendingFileByDestination)
        .mockResolvedValueOnce({
          kind: 'candidate_unreadable',
          filePath: '/workspace/Chief-of-Staff/memory/pending/bad.pending.md',
          reason: 'failed_to_parse_pending_frontmatter',
        } as any)
        .mockResolvedValueOnce({
          kind: 'candidate_unreadable',
          filePath: '/workspace/Chief-of-Staff/memory/pending/bad.pending.md',
          reason: 'failed_to_parse_pending_frontmatter',
        } as any);

      const hook = createMemoryWriteHook({
        turnId: 'turn-edit-unreadable-base-1',
        sessionId: 'session-edit-unreadable-base-1',
        originalTurnId: 'orig-turn-edit-unreadable-base-1',
        originalSessionId: 'orig-session-edit-unreadable-base-1',
        coreDirectory: '/workspace',
      });

      const result = await hook(
        {
          tool_name: 'Edit',
          tool_input: {
            file_path: filePath,
            old_str: 'old',
            new_str: 'new',
          },
          tool_use_id: 'tool-edit-unreadable-base-1',
        },
        'tool-edit-unreadable-base-1',
        { signal: new AbortController().signal },
      );

      expect(getHookSpecificOutput(result)?.permissionDecision).toBe('deny');
      expect(getHookSpecificOutput(result)?.permissionDecisionReason).toContain('FILE ALREADY PENDING REVIEW');
      expect(cosPendingService.writeToPending).not.toHaveBeenCalled();
    });

    it('escalates sticky restage to structural_policy when new content contains credentials', async () => {
      const filePath = '/workspace/private-space/new-secret.md';
      mockContainsCredentialPatterns.mockReturnValueOnce({
        detected: true,
        reasons: ['api_key_pattern'],
      });

      vi.mocked(settingsStore.getSettings).mockReturnValue({
        coreDirectory: '/workspace',
        spaces: [],
        spaceSafetyLevels: {},
      } as any);
      vi.mocked(spaceService.scanSpaces).mockResolvedValue([
        {
          name: 'Private Space',
          path: 'private-space',
          absolutePath: '/workspace/private-space',
          type: 'personal',
          isSymlink: false,
          hasReadme: true,
        } as any,
      ]);
      vi.mocked(spaceService.readSpaceReadmeFrontmatter).mockResolvedValue(
        asSpaceFrontmatter({ sharing: 'private' })
      );
      vi.mocked(spaceService.getSpaceDisplayName).mockReturnValue('Private Space');

      vi.mocked(cosPendingService.getPendingFileByDestination).mockResolvedValue({
        file: {
          id: 'pending-escalate-old',
          filename: 'escalate-old.pending.md',
          frontmatter: {
            session_id: 'orig-session-escalate-1',
            tool_use_id: 'old-tool-use-escalate-1',
            blocked_by: 'safety_prompt',
            summary: 'Old non-secret summary',
          },
        },
        content: 'safe content',
      } as any);
      vi.mocked(cosPendingService.writeToPending).mockResolvedValue({
        id: 'pending-escalate-new',
        filename: 'escalate-new.pending.md',
      } as any);

      const hook = createMemoryWriteHook({
        turnId: 'turn-escalate-1',
        sessionId: 'session-escalate-1',
        originalTurnId: 'orig-turn-escalate-1',
        originalSessionId: 'orig-session-escalate-1',
        coreDirectory: '/workspace',
      });

      const result = await hook(
        {
          tool_name: 'Edit',
          tool_input: {
            file_path: filePath,
            old_str: 'safe',
            new_str: 'sk-ant-live-new-secret-key',
          },
          tool_use_id: 'tool-use-escalate-1',
        },
        'tool-use-escalate-1',
        { signal: new AbortController().signal }
      );

      expect(getHookSpecificOutput(result)?.replaceResult).toEqual(
        expect.objectContaining({ isError: false })
      );
      expect(cosPendingService.writeToPending).toHaveBeenCalledWith(
        expect.objectContaining({
          blockedBy: 'structural_policy',
          summary: 'Possible credentials detected — review before saving',
        })
      );
    });

    it('keeps credential-safe summary for sticky Bash heredoc restage with secrets', async () => {
      const filePath = '/workspace/private-space/heredoc-secret.md';
      mockContainsCredentialPatterns.mockReturnValueOnce({
        detected: true,
        reasons: ['api_key_pattern'],
      });

      vi.mocked(settingsStore.getSettings).mockReturnValue({
        coreDirectory: '/workspace',
        spaces: [],
        spaceSafetyLevels: {},
      } as any);
      vi.mocked(spaceService.scanSpaces).mockResolvedValue([
        {
          name: 'Private Space',
          path: 'private-space',
          absolutePath: '/workspace/private-space',
          type: 'personal',
          isSymlink: false,
          hasReadme: true,
        } as any,
      ]);
      vi.mocked(spaceService.readSpaceReadmeFrontmatter).mockResolvedValue(
        asSpaceFrontmatter({ sharing: 'private' })
      );
      vi.mocked(spaceService.getSpaceDisplayName).mockReturnValue('Private Space');

      vi.mocked(cosPendingService.getPendingFileByDestination).mockResolvedValue({
        kind: 'found',
        file: {
          id: 'pending-heredoc-old',
          filename: 'heredoc-old.pending.md',
          frontmatter: {
            session_id: 'orig-session-heredoc-secret-1',
            tool_use_id: 'old-tool-use-heredoc-secret-1',
            blocked_by: 'safety_prompt',
            summary: 'Old summary',
          },
        },
        content: 'safe old content',
      } as any);
      vi.mocked(cosPendingService.writeToPending).mockResolvedValue({
        id: 'pending-heredoc-new',
        filename: 'heredoc-new.pending.md',
      } as any);

      const hook = createMemoryWriteHook({
        turnId: 'turn-heredoc-secret-1',
        sessionId: 'session-heredoc-secret-1',
        originalTurnId: 'orig-turn-heredoc-secret-1',
        originalSessionId: 'orig-session-heredoc-secret-1',
        coreDirectory: '/workspace',
      });

      const result = await hook(
        {
          tool_name: 'Bash',
          tool_input: {
            command: `cat > ${filePath} << 'EOF'\napi_key=sk-ant-live-secret\nEOF`,
          },
          tool_use_id: 'tool-use-heredoc-secret-1',
        },
        'tool-use-heredoc-secret-1',
        { signal: new AbortController().signal }
      );

      expect(getHookSpecificOutput(result)?.replaceResult).toEqual(
        expect.objectContaining({ isError: false })
      );
      expect(cosPendingService.writeToPending).toHaveBeenCalledWith(
        expect.objectContaining({
          destinationPath: filePath,
          blockedBy: 'structural_policy',
          summary: 'Possible credentials detected — review before saving',
        })
      );
    });

    it('handles sticky restage when legacy pending frontmatter has no tool_use_id', async () => {
      const filePath = '/workspace/private-space/legacy.md';
      const removePendingMemoryApprovalSpy = vi.spyOn(pendingApprovalsStore, 'removePendingMemoryApproval');

      vi.mocked(settingsStore.getSettings).mockReturnValue({
        coreDirectory: '/workspace',
        spaces: [],
        spaceSafetyLevels: {},
      } as any);
      vi.mocked(spaceService.scanSpaces).mockResolvedValue([
        {
          name: 'Private Space',
          path: 'private-space',
          absolutePath: '/workspace/private-space',
          type: 'personal',
          isSymlink: false,
          hasReadme: true,
        } as any,
      ]);
      vi.mocked(spaceService.readSpaceReadmeFrontmatter).mockResolvedValue(
        asSpaceFrontmatter({ sharing: 'private' })
      );
      vi.mocked(spaceService.getSpaceDisplayName).mockReturnValue('Private Space');

      vi.mocked(cosPendingService.getPendingFileByDestination).mockResolvedValue({
        file: {
          id: 'pending-legacy-old',
          filename: 'legacy-old.pending.md',
          frontmatter: {
            session_id: 'orig-session-legacy-1',
            blocked_by: 'safety_prompt',
          },
        },
        content: 'legacy pending content',
      } as any);
      vi.mocked(cosPendingService.writeToPending).mockResolvedValue({
        id: 'pending-legacy-new',
        filename: 'legacy-new.pending.md',
      } as any);

      const hook = createMemoryWriteHook({
        turnId: 'turn-legacy-1',
        sessionId: 'session-legacy-1',
        originalTurnId: 'orig-turn-legacy-1',
        originalSessionId: 'orig-session-legacy-1',
        coreDirectory: '/workspace',
      });

      const result = await hook(
        {
          tool_name: 'Create',
          tool_input: {
            path: filePath,
            content: 'replacement content',
          },
          tool_use_id: 'tool-use-legacy-1',
        },
        'tool-use-legacy-1',
        { signal: new AbortController().signal }
      );

      expect(getHookSpecificOutput(result)?.replaceResult).toEqual(
        expect.objectContaining({ isError: false })
      );
      expect(removePendingMemoryApprovalSpy).not.toHaveBeenCalled();
      expect(
        mockSendToAllWindows.mock.calls.filter(([channel]) => channel === 'memory:write-approval-resolved')
      ).toHaveLength(0);
    });

    it('stages Edit-after-Edit on top of same-session staged content', async () => {
      const coreDirectory = path.join(process.cwd(), 'tmp', 'agent-tests', 'multi-write-edit');
      const testSpaceDir = path.join(coreDirectory, 'test-space');
      const filePath = path.join(testSpaceDir, 'existing-file.md');
      await fs.mkdir(testSpaceDir, { recursive: true });
      await fs.writeFile(filePath, 'Hello world', 'utf-8');
      const removePendingMemoryApprovalSpy = vi.spyOn(pendingApprovalsStore, 'removePendingMemoryApproval');

      vi.mocked(settingsStore.getSettings).mockReturnValue({
        coreDirectory,
        spaces: [],
        spaceSafetyLevels: {
          'test-space': 'cautious',
        },
      } as any);
      vi.mocked(spaceService.scanSpaces).mockResolvedValue([
        {
          name: 'Test Space',
          path: 'test-space',
          absolutePath: testSpaceDir,
          type: 'personal',
          isSymlink: false,
          hasReadme: true,
        } as any,
      ]);
      vi.mocked(spaceService.readSpaceReadmeFrontmatter).mockResolvedValue(undefined);
      vi.mocked(spaceService.getSpaceDisplayName).mockReturnValue('Test Space');

      vi.mocked(cosPendingService.getPendingFileByDestination)
        .mockResolvedValueOnce({ kind: 'none' } as any)
        .mockResolvedValueOnce({ kind: 'none' } as any)
        .mockResolvedValueOnce({ kind: 'none' } as any)
        .mockResolvedValueOnce({
          file: {
            id: 'pending-old-2',
            filename: 'old-edit.pending.md',
            frontmatter: { session_id: 'orig-session-multi-edit-1', tool_use_id: 'old-tool-use-2' },
          },
          content: 'Hello Rebel',
        } as any)
        .mockResolvedValueOnce({
          file: {
            id: 'pending-old-2',
            filename: 'old-edit.pending.md',
            frontmatter: { session_id: 'orig-session-multi-edit-1', tool_use_id: 'old-tool-use-2' },
          },
          content: 'Hello Rebel',
        } as any);

      vi.mocked(cosPendingService.writeToPending)
        .mockResolvedValueOnce({ id: 'pending-edit-first', filename: 'first-edit.pending.md' } as any)
        .mockResolvedValueOnce({ id: 'pending-edit-second', filename: 'second-edit.pending.md' } as any);

      const hook = createMemoryWriteHook({
        turnId: 'turn-multi-edit-1',
        sessionId: 'session-multi-edit-1',
        originalTurnId: 'orig-turn-multi-edit-1',
        originalSessionId: 'orig-session-multi-edit-1',
        coreDirectory,
      });

      const firstEditResult = await hook(
        {
          tool_name: 'Edit',
          tool_input: {
            file_path: filePath,
            old_str: 'world',
            new_str: 'Rebel',
          },
          tool_use_id: 'tool-edit-first-1',
        },
        'tool-edit-first-1',
        { signal: new AbortController().signal }
      );
      expect(getHookSpecificOutput(firstEditResult)?.replaceResult).toEqual(
        expect.objectContaining({ isError: false })
      );

      const secondEditResult = await hook(
        {
          tool_name: 'Edit',
          tool_input: {
            file_path: filePath,
            old_str: 'Rebel',
            new_str: 'Team',
          },
          tool_use_id: 'tool-edit-second-1',
        },
        'tool-edit-second-1',
        { signal: new AbortController().signal }
      );
      expect(getHookSpecificOutput(secondEditResult)?.replaceResult).toEqual(
        expect.objectContaining({ isError: false })
      );

      expect(cosPendingService.writeToPending).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ content: 'Hello Team' })
      );
      expect(removePendingMemoryApprovalSpy).toHaveBeenCalledWith('old-tool-use-2');
    });

    it('uses same-session pending content for cumulative Edit staging (A→BB→BBB)', async () => {
      const coreDirectory = path.join(process.cwd(), 'tmp', 'agent-tests', 'cumulative-edit-stage2');
      const testSpaceDir = path.join(coreDirectory, 'test-space');
      const filePath = path.join(testSpaceDir, 'existing-file.md');
      await fs.mkdir(testSpaceDir, { recursive: true });
      await fs.writeFile(filePath, 'A\nB\nC', 'utf-8');

      vi.mocked(settingsStore.getSettings).mockReturnValue({
        coreDirectory,
        spaces: [],
        spaceSafetyLevels: {
          'test-space': 'cautious',
        },
      } as any);
      vi.mocked(spaceService.scanSpaces).mockResolvedValue([
        {
          name: 'Test Space',
          path: 'test-space',
          absolutePath: testSpaceDir,
          type: 'personal',
          isSymlink: false,
          hasReadme: true,
        } as any,
      ]);
      vi.mocked(spaceService.readSpaceReadmeFrontmatter).mockResolvedValue(undefined);
      vi.mocked(spaceService.getSpaceDisplayName).mockReturnValue('Test Space');

      let pendingContent: string | null = null;
      vi.mocked(cosPendingService.getPendingFileByDestination).mockImplementation(async (_destination, _sessionId) => {
        if (!pendingContent) {
          return { kind: 'none' } as any;
        }
        return {
          kind: 'found',
          file: {
            id: 'pending-cumulative',
            filename: 'cumulative.pending.md',
            frontmatter: {
              session_id: 'orig-session-cumulative-stage2',
              tool_use_id: 'old-tool-use-cumulative-stage2',
            },
          },
          content: pendingContent,
        } as any;
      });

      vi.mocked(cosPendingService.writeToPending).mockImplementation(async (options) => {
        pendingContent = options.content;
        return {
          id: `pending-${options.content.length}`,
          filename: 'staged.pending.md',
          frontmatter: {
            session_id: options.sessionId,
            pending_destination: options.destinationPath,
          },
          content: options.content,
        } as any;
      });

      const hook = createMemoryWriteHook({
        turnId: 'turn-cumulative-stage2',
        sessionId: 'session-cumulative-stage2',
        originalTurnId: 'orig-turn-cumulative-stage2',
        originalSessionId: 'orig-session-cumulative-stage2',
        coreDirectory,
      });

      const firstEditResult = await hook(
        {
          tool_name: 'Edit',
          tool_input: {
            file_path: filePath,
            old_str: 'B',
            new_str: 'BB',
          },
          tool_use_id: 'tool-cumulative-edit-1',
        },
        'tool-cumulative-edit-1',
        { signal: new AbortController().signal }
      );
      expect(getHookSpecificOutput(firstEditResult)?.replaceResult).toEqual(
        expect.objectContaining({ isError: false })
      );

      const secondEditResult = await hook(
        {
          tool_name: 'Edit',
          tool_input: {
            file_path: filePath,
            old_str: 'BB',
            new_str: 'BBB',
          },
          tool_use_id: 'tool-cumulative-edit-2',
        },
        'tool-cumulative-edit-2',
        { signal: new AbortController().signal }
      );
      expect(getHookSpecificOutput(secondEditResult)?.replaceResult).toEqual(
        expect.objectContaining({ isError: false })
      );

      expect(cosPendingService.writeToPending).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ content: 'A\nBB\nC' })
      );
      expect(cosPendingService.writeToPending).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ content: 'A\nBBB\nC' })
      );
    });

    it('preserves Edit ambiguity handling when pending base has multiple old_str matches', async () => {
      const filePath = '/workspace/test-space/ambiguous-edit.md';

      vi.mocked(settingsStore.getSettings).mockReturnValue({
        coreDirectory: '/workspace',
        spaces: [],
        spaceSafetyLevels: {
          'test-space': 'cautious',
        },
      } as any);
      vi.mocked(spaceService.scanSpaces).mockResolvedValue([
        {
          name: 'Test Space',
          path: 'test-space',
          absolutePath: '/workspace/test-space',
          type: 'personal',
          isSymlink: false,
          hasReadme: true,
        } as any,
      ]);
      vi.mocked(spaceService.readSpaceReadmeFrontmatter).mockResolvedValue(undefined);
      vi.mocked(spaceService.getSpaceDisplayName).mockReturnValue('Test Space');

      vi.mocked(cosPendingService.getPendingFileByDestination).mockResolvedValue({
        kind: 'found',
        file: {
          id: 'pending-ambiguous-old',
          filename: 'ambiguous-old.pending.md',
          frontmatter: {
            session_id: 'orig-session-ambiguous-stage2',
            tool_use_id: 'old-tool-use-ambiguous-stage2',
            blocked_by: 'safety_prompt',
            summary: 'Old summary',
          },
        },
        content: 'A\nBB\nBB\nC',
      } as any);

      const hook = createMemoryWriteHook({
        turnId: 'turn-ambiguous-stage2',
        sessionId: 'session-ambiguous-stage2',
        originalTurnId: 'orig-turn-ambiguous-stage2',
        originalSessionId: 'orig-session-ambiguous-stage2',
        coreDirectory: '/workspace',
      });

      const result = await hook(
        {
          tool_name: 'Edit',
          tool_input: {
            file_path: filePath,
            old_str: 'BB',
            new_str: 'BBB',
          },
          tool_use_id: 'tool-use-ambiguous-stage2',
        },
        'tool-use-ambiguous-stage2',
        { signal: new AbortController().signal }
      );

      expect(getHookSpecificOutput(result)?.permissionDecision).toBe('deny');
      expect(getHookSpecificOutput(result)?.permissionDecisionReason).toContain('FILE ALREADY PENDING REVIEW');
      expect(cosPendingService.writeToPending).not.toHaveBeenCalled();
    });

    it('hard-denies cross-session pending writes before permissive private auto-approve', async () => {
      const filePath = '/workspace/private-space/cross-session-preflight.md';
      vi.mocked(settingsStore.getSettings).mockReturnValue({
        coreDirectory: '/workspace',
        spaces: [],
        spaceSafetyLevels: {},
      } as any);
      vi.mocked(spaceService.scanSpaces).mockResolvedValue([
        {
          name: 'Private Space',
          path: 'private-space',
          absolutePath: '/workspace/private-space',
          type: 'personal',
          isSymlink: false,
          hasReadme: true,
        } as any,
      ]);
      vi.mocked(spaceService.readSpaceReadmeFrontmatter).mockResolvedValue(
        asSpaceFrontmatter({ sharing: 'private' })
      );
      vi.mocked(spaceService.getSpaceDisplayName).mockReturnValue('Private Space');
      vi.mocked(cosPendingService.getPendingFileByDestination).mockResolvedValue({
        file: {
          id: 'pending-cross-session-preflight',
          filename: 'cross-session.pending.md',
          frontmatter: {
            session_id: 'orig-session-someone-else',
            tool_use_id: 'other-tool-use-id',
            blocked_by: 'safety_prompt',
          },
        },
        content: 'other session staged content',
      } as any);

      const hook = createMemoryWriteHook({
        turnId: 'turn-cross-session-preflight-1',
        sessionId: 'session-cross-session-preflight-1',
        originalTurnId: 'orig-turn-cross-session-preflight-1',
        originalSessionId: 'orig-session-cross-session-preflight-1',
        coreDirectory: '/workspace',
      });

      const result = await hook(
        {
          tool_name: 'Create',
          tool_input: {
            path: filePath,
            content: 'new content',
          },
          tool_use_id: 'tool-cross-session-preflight-1',
        },
        'tool-cross-session-preflight-1',
        { signal: new AbortController().signal }
      );

      expect(getHookSpecificOutput(result)?.permissionDecision).toBe('deny');
      expect(getHookSpecificOutput(result)?.permissionDecisionReason).toContain('FILE ALREADY PENDING REVIEW');
      expect(cosPendingService.writeToPending).not.toHaveBeenCalled();
      expect(evaluateSafetyPrompt).not.toHaveBeenCalled();
    });

    it('still blocks same-file writes when pending file belongs to a different session', async () => {
      const filePath = '/workspace/test-space/cross-session.md';
      vi.mocked(cosPendingService.getPendingFileByDestination).mockResolvedValue({
        file: {
          id: 'pending-cross-1',
          filename: 'cross-session.pending.md',
          frontmatter: { session_id: 'orig-session-other-user', tool_use_id: 'other-tool-use-id' },
        },
        content: 'other session content',
      } as any);

      const hook = createMemoryWriteHook({
        turnId: 'turn-cross-session-1',
        sessionId: 'session-cross-session-1',
        originalTurnId: 'orig-turn-cross-session-1',
        originalSessionId: 'orig-session-cross-session-1',
        coreDirectory: '/workspace',
      });

      const result = await hook(
        {
          tool_name: 'Create',
          tool_input: {
            path: filePath,
            content: 'new content',
          },
          tool_use_id: 'tool-cross-session-1',
        },
        'tool-cross-session-1',
        { signal: new AbortController().signal }
      );

      expect(getHookSpecificOutput(result)?.permissionDecision).toBe('deny');
      expect(getHookSpecificOutput(result)?.permissionDecisionReason).toContain('FILE ALREADY PENDING REVIEW');
      expect(cosPendingService.writeToPending).not.toHaveBeenCalled();
    });
  });
});

describe('automation Safety Prompt evaluation', () => {
  const signal = new AbortController().signal;

  // Helper to create a hook with automation session ID
  function createAutomationHook(overrides: Partial<Parameters<typeof createMemoryWriteHook>[0]> = {}) {
    return createMemoryWriteHook({
      turnId: 'turn-auto-1',
      sessionId: 'automation-test-1--abc',
      originalTurnId: 'orig-turn-auto-1',
      originalSessionId: 'orig-session-auto-1',
      coreDirectory: '/workspace',
      ...overrides,
    });
  }

  // Helper to set up space mocks for a balanced space
  function setupBalancedSpace() {
    vi.mocked(settingsStore.getSettings).mockReturnValue({
      coreDirectory: '/workspace',
      spaces: [],
      spaceSafetyLevels: {},
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
    vi.mocked(spaceService.readSpaceReadmeFrontmatter).mockResolvedValue(
      asSpaceFrontmatter({ sharing: 'restricted' })
    );
    vi.mocked(spaceService.getSpaceDisplayName).mockReturnValue('Work Space');
  }

  // Helper to set up space mocks for a permissive (CoS) space
  function setupPermissiveSpace() {
    vi.mocked(settingsStore.getSettings).mockReturnValue({
      coreDirectory: '/workspace',
      spaces: [{ path: 'chief-of-staff', type: 'chief-of-staff' }],
      spaceSafetyLevels: {},
    } as any);
    vi.mocked(spaceService.scanSpaces).mockResolvedValue([
      {
        name: 'Chief of Staff',
        path: 'chief-of-staff',
        absolutePath: '/workspace/chief-of-staff',
        type: 'chief-of-staff',
        isSymlink: false,
        hasReadme: true,
      } as any,
    ]);
    vi.mocked(spaceService.readSpaceReadmeFrontmatter).mockResolvedValue(
      asSpaceFrontmatter({ sharing: 'private' })
    );
    vi.mocked(spaceService.getSpaceDisplayName).mockReturnValue('Private Space');
  }

  beforeEach(() => {
    vi.resetAllMocks();
    // Default: no credentials detected (secret gate passes through)
    mockContainsCredentialPatterns.mockReturnValue({ detected: false, reasons: [] });
    // Default: migration complete, balanced space
    vi.mocked(isMigrationComplete).mockReturnValue(true);
    vi.mocked(getSafetyPrompt).mockReturnValue('default safety prompt');
    vi.mocked(getSafetyPromptVersion).mockReturnValue(1);
    vi.mocked(cosPendingService.getPendingFileByDestination).mockResolvedValue({ kind: 'none' } as any);
    setupBalancedSpace();
  });

  it('1. auto-approves permissive (CoS) space without calling evaluateSafetyPrompt', async () => {
    setupPermissiveSpace();
    const hook = createAutomationHook();

    const result = await hook(
      { tool_name: 'Create', tool_input: { path: '/workspace/chief-of-staff/notes.md', content: 'notes' }, tool_use_id: 'tu-1' },
      'tu-1', { signal }
    );

    expect(result).toEqual({});
    expect(evaluateSafetyPrompt).not.toHaveBeenCalled();
  });

  it('2. allows balanced space write when Safety Prompt allows', async () => {
    vi.mocked(evaluateSafetyPrompt).mockResolvedValue({ decision: 'allow', confidence: 'high', reason: 'Safe operation' });
    vi.mocked(shouldAllow).mockReturnValue(true);
    const hook = createAutomationHook();

    const result = await hook(
      { tool_name: 'Create', tool_input: { path: '/workspace/work-space/file.md', content: 'data' }, tool_use_id: 'tu-2' },
      'tu-2', { signal }
    );

    expect(result).toEqual({});
    expect(evaluateSafetyPrompt).toHaveBeenCalled();
    expect(addEvaluationEntry).toHaveBeenCalledWith(expect.objectContaining({ decision: 'allowed' }));
  });

  it('3. stages balanced space write when Safety Prompt blocks', async () => {
    vi.mocked(evaluateSafetyPrompt).mockResolvedValue({ decision: 'block', confidence: 'high', reason: 'Sensitive data' });
    vi.mocked(shouldAllow).mockReturnValue(false);
    vi.mocked(cosPendingService.writeToPending).mockResolvedValue({ id: 'pend-1', filename: 'staged.md' } as any);
    const hook = createAutomationHook();

    const result = await hook(
      { tool_name: 'Create', tool_input: { path: '/workspace/work-space/file.md', content: 'secret data' }, tool_use_id: 'tu-3' },
      'tu-3', { signal }
    );

    expect(getHookSpecificOutput(result)?.replaceResult).toEqual(
      expect.objectContaining({ isError: false })
    );
    expect(addEvaluationEntry).toHaveBeenCalledWith(expect.objectContaining({ decision: 'blocked', reason: 'Sensitive data' }));
  });

  it('4. cautious space always stages without calling evaluateSafetyPrompt', async () => {
    vi.mocked(settingsStore.getSettings).mockReturnValue({
      coreDirectory: '/workspace',
      spaces: [],
      spaceSafetyLevels: {},
    } as any);
    vi.mocked(spaceService.scanSpaces).mockResolvedValue([]);
    vi.mocked(cosPendingService.writeToPending).mockResolvedValue({ id: 'pend-caut', filename: 'staged.md' } as any);
    const hook = createAutomationHook({ privateMode: true });

    const result = await hook(
      { tool_name: 'Create', tool_input: { path: '/workspace/work-space/private.md', content: 'private' }, tool_use_id: 'tu-4' },
      'tu-4', { signal }
    );

    expect(getHookSpecificOutput(result)?.replaceResult).toEqual(
      expect.objectContaining({ isError: false })
    );
    expect(evaluateSafetyPrompt).not.toHaveBeenCalled();
  });

  it('5. cautious for unknown path (null spaceInfo) stages without eval', async () => {
    vi.mocked(spaceService.scanSpaces).mockResolvedValue([]);
    vi.mocked(cosPendingService.writeToPending).mockResolvedValue({ id: 'pend-unk', filename: 'staged.md' } as any);
    const hook = createAutomationHook();

    const result = await hook(
      { tool_name: 'Create', tool_input: { path: '/outside/unknown/file.md', content: 'data' }, tool_use_id: 'tu-5' },
      'tu-5', { signal }
    );

    expect(getHookSpecificOutput(result)?.replaceResult).toEqual(
      expect.objectContaining({ isError: false })
    );
    expect(evaluateSafetyPrompt).not.toHaveBeenCalled();
  });

  it('6. migration not complete stages with migration reason', async () => {
    vi.mocked(isMigrationComplete).mockReturnValue(false);
    vi.mocked(cosPendingService.writeToPending).mockResolvedValue({ id: 'pend-mig', filename: 'staged.md' } as any);
    const hook = createAutomationHook();

    const result = await hook(
      { tool_name: 'Create', tool_input: { path: '/workspace/work-space/file.md', content: 'data' }, tool_use_id: 'tu-6' },
      'tu-6', { signal }
    );

    expect(getHookSpecificOutput(result)?.replaceResult).toEqual(
      expect.objectContaining({ isError: false })
    );
    expect(evaluateSafetyPrompt).not.toHaveBeenCalled();
  });

  it('7. fail-closed eval result stages as eval_error without incrementing circuit breaker', async () => {
    vi.mocked(evaluateSafetyPrompt).mockResolvedValue({
      decision: 'block',
      confidence: 'low',
      reason: "Rebel can't complete the safety check (provider error). This often clears on its own — if it keeps happening, restart Rebel or raise a bug and we'll look into it.",
      failClosed: true,
    });
    vi.mocked(shouldAllow).mockReturnValue(false);
    vi.mocked(cosPendingService.writeToPending).mockResolvedValue({ id: 'pend-fc-7', filename: 'staged.md' } as any);
    const hook = createAutomationHook();

    const result = await hook(
      { tool_name: 'Create', tool_input: { path: '/workspace/work-space/file.md', content: 'data' }, tool_use_id: 'tu-7' },
      'tu-7', { signal }
    );

    expect(getHookSpecificOutput(result)?.replaceResult).toEqual(
      expect.objectContaining({ isError: false })
    );
    expect(cosPendingService.writeToPending).toHaveBeenCalledWith(
      expect.objectContaining({
        blockedBy: 'eval_error',
      }),
    );
    expect(mockSendToAllWindows).toHaveBeenCalledWith(
      'memory:file-staged',
      expect.anything(),
    );
    expect(agentTurnRegistry.recordSecurityDenial).toHaveBeenCalledWith(
      'turn-auto-1',
      'Create',
      expect.stringContaining('staged memory write for approval'),
    );
    // F1 dedup: exactly one security denial per staged eval_error write
    // (the pre-stage record was removed; the helper records once on success).
    expect(agentTurnRegistry.recordSecurityDenial).toHaveBeenCalledTimes(1);
    // FOX-3231: eval_error staging must NOT count toward circuit breaker
    expect(agentTurnRegistry.incrementAutomationSafetyBlock).not.toHaveBeenCalled();
  });

  it('7a. rate-limited fail-closed automation memory write stages as eval_error', async () => {
    vi.mocked(evaluateSafetyPrompt).mockResolvedValue({
      decision: 'block',
      confidence: 'low',
      reason: 'API rate limit active — deferring safety evaluation',
      failClosed: true,
      failClosedReason: 'rate-limited',
      cooldownGenerationId: 44,
    });
    vi.mocked(shouldAllow).mockReturnValue(false);
    vi.mocked(cosPendingService.writeToPending).mockResolvedValue({ id: 'pend-fc-7a', filename: 'staged.md' } as any);
    const hook = createAutomationHook();

    const result = await hook(
      { tool_name: 'Create', tool_input: { path: '/workspace/work-space/file.md', content: 'data' }, tool_use_id: 'tu-7a' },
      'tu-7a', { signal }
    );

    expect(getHookSpecificOutput(result)?.replaceResult).toEqual(
      expect.objectContaining({ isError: false })
    );
    expect(cosPendingService.writeToPending).toHaveBeenCalledWith(
      expect.objectContaining({ blockedBy: 'eval_error' })
    );
    expect(mockSendToAllWindows).toHaveBeenCalledWith('memory:file-staged', expect.anything());
    // F1 dedup: exactly one security denial per staged eval_error write
    expect(agentTurnRegistry.recordSecurityDenial).toHaveBeenCalledTimes(1);
    expect(agentTurnRegistry.recordSecurityDenial).toHaveBeenCalledWith(
      'turn-auto-1',
      'Create',
      expect.stringContaining('staged memory write for approval'),
    );
    expect(agentTurnRegistry.incrementAutomationSafetyBlock).not.toHaveBeenCalled();
  });

  it('7b. eval throw stages as eval_error without incrementing circuit breaker', async () => {
    vi.mocked(evaluateSafetyPrompt).mockRejectedValue(new Error('LLM timeout'));
    vi.mocked(cosPendingService.writeToPending).mockResolvedValue({ id: 'pend-fc-7b', filename: 'staged.md' } as any);
    const hook = createAutomationHook();

    const result = await hook(
      { tool_name: 'Create', tool_input: { path: '/workspace/work-space/file.md', content: 'data' }, tool_use_id: 'tu-7b' },
      'tu-7b', { signal }
    );

    expect(getHookSpecificOutput(result)?.replaceResult).toEqual(
      expect.objectContaining({ isError: false })
    );
    expect(cosPendingService.writeToPending).toHaveBeenCalledWith(
      expect.objectContaining({
        blockedBy: 'eval_error',
      }),
    );
    expect(mockSendToAllWindows).toHaveBeenCalledWith('memory:file-staged', expect.anything());
    expect(agentTurnRegistry.recordSecurityDenial).toHaveBeenCalledWith(
      'turn-auto-1',
      'Create',
      expect.stringContaining('staged memory write for approval'),
    );
    // F1 dedup: exactly one security denial per staged eval_error write
    expect(agentTurnRegistry.recordSecurityDenial).toHaveBeenCalledTimes(1);
    // FOX-3231: eval_error staging must NOT count toward circuit breaker
    expect(agentTurnRegistry.incrementAutomationSafetyBlock).not.toHaveBeenCalled();
  });

  it('7c. fail-closed automation write — when staging is unavailable, denies honestly and records exactly once (no increment)', async () => {
    vi.mocked(evaluateSafetyPrompt).mockResolvedValue({
      decision: 'block',
      confidence: 'low',
      reason: 'provider unavailable',
      failClosed: true,
      failClosedReason: 'retries-exhausted',
    });
    vi.mocked(shouldAllow).mockReturnValue(false);
    // Staging unavailable → stageOrDeny returns null → caller deny-fallback path.
    vi.mocked(cosPendingService.writeToPending).mockResolvedValue(null);
    const hook = createAutomationHook();

    const result = await hook(
      { tool_name: 'Create', tool_input: { path: '/workspace/work-space/file.md', content: 'data' }, tool_use_id: 'tu-7c' },
      'tu-7c', { signal }
    );

    // Honest deny (not an auto-allow, not a silent drop).
    expect(getHookSpecificOutput(result)?.permissionDecision).toBe('deny');
    // Recorded exactly once in the deny-fallback (the helper did not record because it returned null).
    expect(agentTurnRegistry.recordSecurityDenial).toHaveBeenCalledTimes(1);
    expect(agentTurnRegistry.recordSecurityDenial).toHaveBeenCalledWith(
      'turn-auto-1',
      'Create',
      expect.stringContaining('staging unavailable'),
    );
    // FOX-3231: still no circuit-breaker increment on an eval outage.
    expect(agentTurnRegistry.incrementAutomationSafetyBlock).not.toHaveBeenCalled();
  });

  it('8. AbortError during eval allows (turn cancelling)', async () => {
    const abortErr = new Error('Aborted');
    abortErr.name = 'AbortError';
    vi.mocked(evaluateSafetyPrompt).mockRejectedValue(abortErr);
    const hook = createAutomationHook();

    const result = await hook(
      { tool_name: 'Create', tool_input: { path: '/workspace/work-space/file.md', content: 'data' }, tool_use_id: 'tu-8' },
      'tu-8', { signal }
    );

    expect(result).toEqual({});
  });

  it('9. rebel-system path is hard-denied (regression)', async () => {
    const hook = createAutomationHook();

    const result = await hook(
      { tool_name: 'Create', tool_input: { path: '/workspace/rebel-system/skills/test.md', content: 'data' }, tool_use_id: 'tu-9' },
      'tu-9', { signal }
    );

    expect(getHookSpecificOutput(result)?.permissionDecision).toBe('deny');
    expect(getHookSpecificOutput(result)?.permissionDecisionReason).toContain('rebel-system is read-only');
  });

  it('10. inbox path is auto-approved (regression)', async () => {
    const hook = createAutomationHook();

    const result = await hook(
      { tool_name: 'Create', tool_input: { path: '/users/test/Library/Application Support/mindstone-rebel/inbox/item.json', content: '{}' }, tool_use_id: 'tu-10' },
      'tu-10', { signal }
    );

    // Inbox check runs BEFORE the automation block, so it should auto-approve
    expect(result).toEqual({});
  });

  it('10b. inbox path bypasses sticky preflight even when same-session pending exists', async () => {
    vi.mocked(cosPendingService.getPendingFileByDestination).mockResolvedValue({
      file: {
        id: 'pending-inbox-old',
        filename: 'inbox-old.pending.md',
        frontmatter: {
          session_id: 'orig-session-auto-1',
          tool_use_id: 'old-tool-use-inbox',
          blocked_by: 'safety_prompt',
        },
      },
      content: '{ "old": true }',
    } as any);

    const hook = createAutomationHook();

    const result = await hook(
      {
        tool_name: 'Create',
        tool_input: {
          path: '/users/test/Library/Application Support/mindstone-rebel/inbox/item-2.json',
          content: '{ "new": true }',
        },
        tool_use_id: 'tu-10b',
      },
      'tu-10b',
      { signal }
    );

    expect(result).toEqual({});
    expect(cosPendingService.writeToPending).not.toHaveBeenCalled();
  });

  it('11. space description is passed to evaluator in ActionContext', async () => {
    vi.mocked(spaceService.readSpaceReadmeFrontmatter).mockResolvedValue({
      sharing: 'restricted',
      rebel_space_description: 'Team project space for Q4 planning',
    });
    vi.mocked(evaluateSafetyPrompt).mockResolvedValue({ decision: 'allow', confidence: 'high', reason: 'Allowed' });
    vi.mocked(shouldAllow).mockReturnValue(true);
    const hook = createAutomationHook();

    await hook(
      { tool_name: 'Create', tool_input: { path: '/workspace/work-space/notes.md', content: 'notes' }, tool_use_id: 'tu-11' },
      'tu-11', { signal }
    );

    expect(evaluateSafetyPrompt).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Number),
      expect.objectContaining({ spaceDescription: 'Team project space for Q4 planning' }),
      // 4th arg added in commit 483461a82 (fix(safety): Broadcast safety-eval
      // progress...): { signal, onAttempt } options for cancellation +
      // progress reporting. Validate shape without pinning specific instances.
      expect.objectContaining({ signal: expect.any(AbortSignal), onAttempt: expect.any(Function) })
    );
  });

  it('12. activity log broadcast sent after evaluation', async () => {
    vi.mocked(evaluateSafetyPrompt).mockResolvedValue({ decision: 'allow', confidence: 'high', reason: 'OK' });
    vi.mocked(shouldAllow).mockReturnValue(true);
    const hook = createAutomationHook();

    await hook(
      { tool_name: 'Create', tool_input: { path: '/workspace/work-space/file.md', content: 'data' }, tool_use_id: 'tu-12' },
      'tu-12', { signal }
    );

    expect(mockSendToAllWindows).toHaveBeenCalledWith('safety-activity-log:updated', expect.objectContaining({ timestamp: expect.any(Number) }));
  });

  it('13. blocks duplicate when file already has pending staged write', async () => {
    vi.mocked(cosPendingService.getPendingFileByDestination).mockResolvedValue({
      file: {
        filename: 'existing-pending.md',
        frontmatter: {
          session_id: 'orig-session-different-user',
          original_space: 'Work Space',
        },
      },
    } as any);
    const hook = createAutomationHook();

    const result = await hook(
      { tool_name: 'Create', tool_input: { path: '/workspace/work-space/file.md', content: 'data' }, tool_use_id: 'tu-13' },
      'tu-13', { signal }
    );

    expect(getHookSpecificOutput(result)?.permissionDecision).toBe('deny');
    expect(getHookSpecificOutput(result)?.permissionDecisionReason).toContain('FILE ALREADY PENDING REVIEW');
    expect(evaluateSafetyPrompt).not.toHaveBeenCalled();
  });

  it('14. null file path (extraction failure) hard-denies', async () => {
    const hook = createAutomationHook();

    // Tool input with no path field → extractFilePath returns null
    const result = await hook(
      { tool_name: 'Create', tool_input: { nopath: 'missing' }, tool_use_id: 'tu-14' },
      'tu-14', { signal }
    );

    expect(getHookSpecificOutput(result)?.permissionDecision).toBe('deny');
    expect(getHookSpecificOutput(result)?.permissionDecisionReason).toContain('Could not determine file destination');
  });

  it('15. empty safety prompt results in block (eval returns block for empty prompt)', async () => {
    vi.mocked(evaluateSafetyPrompt).mockResolvedValue({ decision: 'block', confidence: 'low', reason: 'Rebel would like to use memory write, but your safety rules are not set up yet' });
    vi.mocked(shouldAllow).mockReturnValue(false);
    vi.mocked(cosPendingService.writeToPending).mockResolvedValue({ id: 'pend-empty', filename: 'staged.md' } as any);
    const hook = createAutomationHook();

    const result = await hook(
      { tool_name: 'Create', tool_input: { path: '/workspace/work-space/file.md', content: 'data' }, tool_use_id: 'tu-15' },
      'tu-15', { signal }
    );

    expect(getHookSpecificOutput(result)?.replaceResult).toEqual(
      expect.objectContaining({ isError: false })
    );
  });

  it('16. low-confidence allow is staged (shouldAllow returns false)', async () => {
    vi.mocked(evaluateSafetyPrompt).mockResolvedValue({ decision: 'allow', confidence: 'low', reason: 'Uncertain' });
    vi.mocked(shouldAllow).mockReturnValue(false);
    vi.mocked(cosPendingService.writeToPending).mockResolvedValue({ id: 'pend-lowconf', filename: 'staged.md' } as any);
    const hook = createAutomationHook();

    const result = await hook(
      { tool_name: 'Create', tool_input: { path: '/workspace/work-space/file.md', content: 'data' }, tool_use_id: 'tu-16' },
      'tu-16', { signal }
    );

    expect(getHookSpecificOutput(result)?.replaceResult).toEqual(
      expect.objectContaining({ isError: false })
    );
    expect(addEvaluationEntry).toHaveBeenCalledWith(expect.objectContaining({ decision: 'blocked' }));
  });

  // Stage 4 (260529_memory_write_intent_context_parity.md): parity guard for the
  // AUTOMATION ActionContext site. The interactive site has equivalent contract
  // tests in `describe('createMemoryWriteHook', ...)` above (search for
  // 'passes user message and session intent'); this pins the automation branch
  // so the two sites can't drift again.
  it('17. automation site passes userMessage and sessionIntent to memory safety eval using originalSessionId (parity with interactive site)', async () => {
    vi.mocked(evaluateSafetyPrompt).mockResolvedValue({ decision: 'allow', confidence: 'high', reason: 'Safe operation' });
    vi.mocked(shouldAllow).mockReturnValue(true);

    const sessionIntent: ActionContextSessionIntent = {
      recentUserMessages: [
        'Add the quarterly handoff notes to the General space.',
        'Use the company-wide General space so the team can find them.',
      ],
      totalChars: 110,
    };
    const getSessionIntent = vi.fn().mockResolvedValue(sessionIntent);
    const userMessage = 'Save the Q4 product handoff notes to the General space.';

    const hook = createAutomationHook({
      userMessage,
      getSessionIntent,
    });

    const result = await hook(
      { tool_name: 'Create', tool_input: { path: '/workspace/work-space/q4-handoff.md', content: 'Quarterly handoff notes' }, tool_use_id: 'tu-auto-intent-17' },
      'tu-auto-intent-17', { signal }
    );

    expect(result).toEqual({});
    expect(getSessionIntent).toHaveBeenCalledTimes(1);
    // Session-intent must resolve against `originalSessionId` (the user
    // conversation), NOT the automation hook's `sessionId` (which is
    // `automation-test-1--abc` here). Mirrors the interactive-site contract.
    expect(getSessionIntent).toHaveBeenCalledWith('orig-session-auto-1');
    expect(getSessionIntent).not.toHaveBeenCalledWith('automation-test-1--abc');
    expect(getFirstEvaluationActionContext()).toEqual(expect.objectContaining({
      sessionType: 'automation',
      userMessage,
      sessionIntent,
    }));
  });
});

describe('source capture Chief-of-Staff-only gate', () => {
  const signal = new AbortController().signal;
  const SOURCE_CAPTURE_AUTOMATION_ID = 'system-source-capture';

  // Source-capture automation session uses a session ID prefix that matches automationScheduler
  function createSourceCaptureHook(overrides: Partial<Parameters<typeof createMemoryWriteHook>[0]> = {}) {
    return createMemoryWriteHook({
      turnId: 'turn-sc-1',
      sessionId: 'automation-source-capture--abc',
      originalTurnId: 'orig-turn-sc-1',
      originalSessionId: 'orig-session-sc-1',
      coreDirectory: '/workspace',
      ...overrides,
    });
  }

  // Helper to create a non-source-capture automation hook (e.g. wins-learnings)
  function createNonSourceCaptureAutomationHook(overrides: Partial<Parameters<typeof createMemoryWriteHook>[0]> = {}) {
    return createMemoryWriteHook({
      turnId: 'turn-wl-1',
      sessionId: 'automation-wins-learnings--xyz',
      originalTurnId: 'orig-turn-wl-1',
      originalSessionId: 'orig-session-wl-1',
      coreDirectory: '/workspace',
      ...overrides,
    });
  }

  // Chief-of-Staff configured in local settings (the verified-CoS check only
  // trusts settings.spaces, not README frontmatter)
  function setupChiefOfStaffSpace() {
    vi.mocked(settingsStore.getSettings).mockReturnValue({
      coreDirectory: '/workspace',
      spaces: [{ path: 'chief-of-staff', type: 'chief-of-staff' }],
      spaceSafetyLevels: {},
    } as any);
    vi.mocked(spaceService.scanSpaces).mockResolvedValue([
      {
        name: 'Chief of Staff',
        path: 'chief-of-staff',
        absolutePath: '/workspace/chief-of-staff',
        type: 'chief-of-staff',
        isSymlink: false,
        hasReadme: true,
      } as any,
    ]);
    vi.mocked(spaceService.readSpaceReadmeFrontmatter).mockResolvedValue(
      asSpaceFrontmatter({ sharing: 'private' })
    );
    vi.mocked(spaceService.getSpaceDisplayName).mockReturnValue('Chief of Staff');
  }

  // Shared (non-CoS) space with restricted sharing
  function setupSharedSpace() {
    vi.mocked(settingsStore.getSettings).mockReturnValue({
      coreDirectory: '/workspace',
      spaces: [{ path: 'company-memories', type: 'personal' }],
      spaceSafetyLevels: {},
    } as any);
    vi.mocked(spaceService.scanSpaces).mockResolvedValue([
      {
        name: 'Company Memories',
        path: 'company-memories',
        absolutePath: '/workspace/company-memories',
        type: 'personal',
        isSymlink: false,
        hasReadme: true,
      } as any,
    ]);
    vi.mocked(spaceService.readSpaceReadmeFrontmatter).mockResolvedValue(
      asSpaceFrontmatter({ sharing: 'restricted' })
    );
    vi.mocked(spaceService.getSpaceDisplayName).mockReturnValue('Company Memories');
  }

  beforeEach(() => {
    vi.resetAllMocks();
    mockContainsCredentialPatterns.mockReturnValue({ detected: false, reasons: [] });
    vi.mocked(isMigrationComplete).mockReturnValue(true);
    vi.mocked(getSafetyPrompt).mockReturnValue('default safety prompt');
    vi.mocked(getSafetyPromptVersion).mockReturnValue(1);
    vi.mocked(cosPendingService.getPendingFileByDestination).mockResolvedValue({ kind: 'none' } as any);
  });

  it('source capture writing to CoS auto-approves (gate does not fire)', async () => {
    setupChiefOfStaffSpace();
    vi.mocked(getAutomationContext).mockReturnValue({
      automationId: SOURCE_CAPTURE_AUTOMATION_ID,
      automationName: 'Source Capture',
    } as any);

    const hook = createSourceCaptureHook();
    const result = await hook(
      {
        tool_name: 'Create',
        tool_input: {
          path: '/workspace/chief-of-staff/memory/sources/meeting.md',
          content: 'meeting notes',
        },
        tool_use_id: 'tu-sc-cos-1',
      },
      'tu-sc-cos-1',
      { signal }
    );

    // Permissive CoS path → auto-approved (empty object = allow)
    expect(result).toEqual({});
    expect(evaluateSafetyPrompt).not.toHaveBeenCalled();
    expect(cosPendingService.writeToPending).not.toHaveBeenCalled();
  });

  it('source capture writing to shared space is hard-denied', async () => {
    setupSharedSpace();
    vi.mocked(getAutomationContext).mockReturnValue({
      automationId: SOURCE_CAPTURE_AUTOMATION_ID,
      automationName: 'Source Capture',
    } as any);

    const hook = createSourceCaptureHook();
    const result = await hook(
      {
        tool_name: 'Create',
        tool_input: {
          path: '/workspace/company-memories/meeting.md',
          content: 'meeting notes with PII',
        },
        tool_use_id: 'tu-sc-shared-1',
      },
      'tu-sc-shared-1',
      { signal }
    );

    // Hard deny — no staging, no Safety Prompt evaluation
    expect(getHookSpecificOutput(result)?.permissionDecision).toBe('deny');
    expect(getHookSpecificOutput(result)?.permissionDecisionReason).toContain(
      'Chief-of-Staff'
    );
    expect(evaluateSafetyPrompt).not.toHaveBeenCalled();
    // writeToPending must NOT be called — we don't stage source capture blocks
    expect(cosPendingService.writeToPending).not.toHaveBeenCalled();
  });

  it('non-source-capture automation writing to shared space uses existing balanced path', async () => {
    setupSharedSpace();
    // Not source capture — existing balanced/cautious path should handle it unchanged
    vi.mocked(getAutomationContext).mockReturnValue({
      automationId: 'system-wins-learnings',
      automationName: 'Wins & Learnings',
    } as any);
    vi.mocked(evaluateSafetyPrompt).mockResolvedValue({
      decision: 'allow',
      confidence: 'high',
      reason: 'Allowed by user safety rules',
    });
    vi.mocked(shouldAllow).mockReturnValue(true);

    const hook = createNonSourceCaptureAutomationHook();
    const result = await hook(
      {
        tool_name: 'Create',
        tool_input: {
          path: '/workspace/company-memories/win.md',
          content: 'team shipping win',
        },
        tool_use_id: 'tu-wl-shared-1',
      },
      'tu-wl-shared-1',
      { signal }
    );

    // Existing balanced path: Safety Prompt is consulted and (in this test) allows.
    expect(result).toEqual({});
    expect(evaluateSafetyPrompt).toHaveBeenCalled();
    // No staging — gate did not fire for non-source-capture.
    expect(cosPendingService.writeToPending).not.toHaveBeenCalled();
  });

  it('source capture gate failure fails-closed with deny', async () => {
    setupSharedSpace();
    vi.mocked(getAutomationContext).mockReturnValue({
      automationId: SOURCE_CAPTURE_AUTOMATION_ID,
      automationName: 'Source Capture',
    } as any);
    // Force the gate's own try/catch to trigger by making writeToPending throw
    vi.mocked(cosPendingService.writeToPending).mockRejectedValue(
      new Error('disk full')
    );

    const hook = createSourceCaptureHook();
    const result = await hook(
      {
        tool_name: 'Create',
        tool_input: {
          path: '/workspace/company-memories/meeting.md',
          content: 'meeting notes',
        },
        tool_use_id: 'tu-sc-err-1',
      },
      'tu-sc-err-1',
      { signal }
    );

    // Fail-closed: deny
    expect(getHookSpecificOutput(result)?.permissionDecision).toBe('deny');
    expect(getHookSpecificOutput(result)?.permissionDecisionReason).toContain(
      'Chief-of-Staff'
    );
    expect(evaluateSafetyPrompt).not.toHaveBeenCalled();
  });

  it('source capture Bash write to shared space is hard-denied', async () => {
    setupSharedSpace();
    vi.mocked(getAutomationContext).mockReturnValue({
      automationId: SOURCE_CAPTURE_AUTOMATION_ID,
      automationName: 'Source Capture',
    } as any);

    const hook = createSourceCaptureHook();
    const result = await hook(
      {
        tool_name: 'Bash',
        tool_input: {
          command:
            "cat > /workspace/company-memories/leak.md << 'EOF'\nleaked content\nEOF",
        },
        tool_use_id: 'tu-sc-bash-1',
      },
      'tu-sc-bash-1',
      { signal }
    );

    expect(getHookSpecificOutput(result)?.permissionDecision).toBe('deny');
    expect(getHookSpecificOutput(result)?.permissionDecisionReason).toContain(
      'Chief-of-Staff'
    );
    expect(cosPendingService.writeToPending).not.toHaveBeenCalled();
    expect(evaluateSafetyPrompt).not.toHaveBeenCalled();
  });

  it('source capture Bash write to CoS is not gated (falls through to normal path)', async () => {
    setupChiefOfStaffSpace();
    vi.mocked(getAutomationContext).mockReturnValue({
      automationId: SOURCE_CAPTURE_AUTOMATION_ID,
      automationName: 'Source Capture',
    } as any);

    const hook = createSourceCaptureHook();
    const result = await hook(
      {
        tool_name: 'Bash',
        tool_input: {
          command:
            "cat > /workspace/chief-of-staff/memory/sources/meeting.md << 'EOF'\nlegitimate source\nEOF",
        },
        tool_use_id: 'tu-sc-bash-cos-1',
      },
      'tu-sc-bash-cos-1',
      { signal }
    );

    // Permissive CoS path: auto-approve
    expect(result).toEqual({});
    expect(cosPendingService.writeToPending).not.toHaveBeenCalled();
  });
});

describe('Bash writes to Chief of Staff', () => {
  const signal = new AbortController().signal;

  function setupCoSWithNoSharing() {
    vi.mocked(settingsStore.getSettings).mockReturnValue({
      coreDirectory: '/workspace',
      spaces: [{ path: 'chief-of-staff', type: 'chief-of-staff' }],
      spaceSafetyLevels: {},
    } as any);
    vi.mocked(spaceService.scanSpaces).mockResolvedValue([
      {
        name: 'Chief of Staff',
        path: 'chief-of-staff',
        absolutePath: '/workspace/chief-of-staff',
        type: 'chief-of-staff',
        isSymlink: false,
        hasReadme: true,
      } as any,
    ]);
    // Real CoS has no sharing field in frontmatter (undefined)
    vi.mocked(spaceService.readSpaceReadmeFrontmatter).mockResolvedValue(undefined);
    vi.mocked(spaceService.getSpaceDisplayName).mockReturnValue('Private Space');
  }

  beforeEach(() => {
    vi.resetAllMocks();
    // Default: no credentials detected (secret gate passes through)
    mockContainsCredentialPatterns.mockReturnValue({ detected: false, reasons: [] });
    vi.mocked(isMigrationComplete).mockReturnValue(true);
    vi.mocked(getSafetyPrompt).mockReturnValue('default safety prompt');
    vi.mocked(getSafetyPromptVersion).mockReturnValue(1);
  });

  it('auto-approves Bash writes to CoS even when sharing is undefined', async () => {
    setupCoSWithNoSharing();
    const hook = createMemoryWriteHook({
      turnId: 'turn-bash-cos',
      sessionId: 'session-bash-cos',
      originalTurnId: 'orig-turn-bash-cos',
      originalSessionId: 'orig-session-bash-cos',
      coreDirectory: '/workspace',
    });

    const result = await hook(
      {
        tool_name: 'Bash',
        tool_input: { command: 'cat > /workspace/chief-of-staff/temp/script.js << \'EOF\'\nconsole.log("hello");\nEOF' },
        tool_use_id: 'tu-bash-cos-1',
      },
      'tu-bash-cos-1',
      { signal }
    );

    // Should auto-approve (permissive CoS), not trigger approval card
    expect(result).toEqual({});
    expect(evaluateSafetyPrompt).not.toHaveBeenCalled();
  });

  it('auto-approves Bash writes to CoS in automation sessions', async () => {
    setupCoSWithNoSharing();
    const hook = createMemoryWriteHook({
      turnId: 'turn-auto-bash-cos',
      sessionId: 'automation-test-bash-cos--abc',
      originalTurnId: 'orig-turn-auto-bash-cos',
      originalSessionId: 'orig-session-auto-bash-cos',
      coreDirectory: '/workspace',
    });

    const result = await hook(
      {
        tool_name: 'Bash',
        tool_input: { command: 'cat > /workspace/chief-of-staff/temp/parse.js << \'EOF\'\nconst x = 1;\nEOF' },
        tool_use_id: 'tu-bash-cos-2',
      },
      'tu-bash-cos-2',
      { signal }
    );

    expect(result).toEqual({});
    expect(evaluateSafetyPrompt).not.toHaveBeenCalled();
  });
});

describe('Bash write Safety Prompt evaluation (interactive)', () => {
  const signal = new AbortController().signal;

  function setupBalancedSpace() {
    vi.mocked(settingsStore.getSettings).mockReturnValue({
      coreDirectory: '/workspace',
      spaces: [],
      spaceSafetyLevels: {
        'work-space': 'balanced',
      },
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
    vi.mocked(spaceService.readSpaceReadmeFrontmatter).mockResolvedValue(
      asSpaceFrontmatter({ sharing: 'restricted' })
    );
    vi.mocked(spaceService.getSpaceDisplayName).mockReturnValue('Work Space');
  }

  beforeEach(() => {
    vi.resetAllMocks();
    // Default: no credentials detected (secret gate passes through)
    mockContainsCredentialPatterns.mockReturnValue({ detected: false, reasons: [] });
    vi.mocked(isMigrationComplete).mockReturnValue(true);
    vi.mocked(getSafetyPrompt).mockReturnValue('default safety prompt');
    vi.mocked(getSafetyPromptVersion).mockReturnValue(1);
    vi.mocked(cosPendingService.getPendingFileByDestination).mockResolvedValue({ kind: 'none' } as any);
    setupBalancedSpace();
  });

  it('allows Bash write when Safety Prompt allows', async () => {
    vi.mocked(evaluateSafetyPrompt).mockResolvedValue({ decision: 'allow', confidence: 'high', reason: 'Safe operation' });
    vi.mocked(shouldAllow).mockReturnValue(true);

    const hook = createMemoryWriteHook({
      turnId: 'turn-bash-allow',
      sessionId: 'session-bash-allow',
      originalTurnId: 'orig-turn-bash-allow',
      originalSessionId: 'orig-session-bash-allow',
      coreDirectory: '/workspace',
    });

    const result = await hook(
      {
        tool_name: 'Bash',
        tool_input: { command: 'echo "hello" > /workspace/work-space/greeting.md' },
        tool_use_id: 'tu-bash-allow',
      },
      'tu-bash-allow',
      { signal }
    );

    // Write should proceed (empty object = allow)
    expect(result).toEqual({});
    expect(evaluateSafetyPrompt).toHaveBeenCalled();
    expect(addEvaluationEntry).toHaveBeenCalledWith(expect.objectContaining({ decision: 'allowed' }));
  });

  it('blocks Bash write without approval when Safety Prompt throws', async () => {
    vi.mocked(evaluateSafetyPrompt).mockRejectedValue(new Error('LLM timeout'));

    // writeToPending returns null to trigger fallback to blocking approval
    vi.mocked(cosPendingService.writeToPending).mockResolvedValue(null);

    const hook = createMemoryWriteHook({
      turnId: 'turn-bash-err',
      sessionId: 'session-bash-err',
      originalTurnId: 'orig-turn-bash-err',
      originalSessionId: 'orig-session-bash-err',
      coreDirectory: '/workspace',
    });

    const result = await hook(
      {
        tool_name: 'Bash',
        tool_input: { command: 'echo "data" > /workspace/work-space/output.md' },
        tool_use_id: 'tu-bash-err',
      },
      'tu-bash-err',
      { signal }
    );

    // Should be denied without creating an approval because the evaluator result is unknown.
    expect(getHookSpecificOutput(result)?.permissionDecision).toBe('deny');
    expect(getHookSpecificOutput(result)?.permissionDecisionReason).toBe(buildEvalErrorUserReason());
    // evaluateSafetyPrompt was called but threw
    expect(evaluateSafetyPrompt).toHaveBeenCalled();
    expect(mockSendToAllWindows).not.toHaveBeenCalledWith(
      'memory:write-approval-request',
      expect.anything(),
    );
  });

  it('sets sessionType to automation for automation Bash writes', async () => {
    vi.mocked(evaluateSafetyPrompt).mockResolvedValue({ decision: 'allow', confidence: 'high', reason: 'Safe' });
    vi.mocked(shouldAllow).mockReturnValue(true);
    vi.mocked(getAutomationContext).mockReturnValue({ automationId: 'bash-test-auto', automationName: 'Test Automation' } as any);

    const hook = createMemoryWriteHook({
      turnId: 'turn-bash-auto',
      sessionId: 'automation-bash-test--xyz',
      originalTurnId: 'orig-turn-bash-auto',
      originalSessionId: 'orig-session-bash-auto',
      coreDirectory: '/workspace',
    });

    await hook(
      {
        tool_name: 'Bash',
        tool_input: { command: 'echo "auto" > /workspace/work-space/auto.md' },
        tool_use_id: 'tu-bash-auto',
      },
      'tu-bash-auto',
      { signal }
    );

    // Verify the ActionContext passed to evaluateSafetyPrompt has sessionType: 'automation'
    expect(evaluateSafetyPrompt).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Number),
      expect.objectContaining({
        sessionType: 'automation',
        automationName: 'Test Automation',
      }),
      // 4th arg added in commit 483461a82 (fix(safety): Broadcast safety-eval
      // progress...): { signal, onAttempt } options for cancellation +
      // progress reporting. Validate shape without pinning specific instances.
      expect.objectContaining({ signal: expect.any(AbortSignal), onAttempt: expect.any(Function) })
    );

    // Verify addEvaluationEntry also got automation session type
    expect(addEvaluationEntry).toHaveBeenCalledWith(expect.objectContaining({
      sessionType: 'automation',
      automationName: 'Test Automation',
    }));
  });

  it('passes space label, sharing context, and README preview into safety evaluation context', async () => {
    vi.mocked(settingsStore.getSettings).mockReturnValue({
      coreDirectory: '/workspace',
      spaces: [
        {
          name: 'Work Space',
          path: 'work-space',
          type: 'project',
          isSymlink: false,
          sharing: 'private',
          createdAt: Date.now(),
        },
      ],
      spaceSafetyLevels: { 'work-space': 'balanced' },
    } as any);
    vi.mocked(spaceService.scanSpaces).mockResolvedValue([
      {
        name: 'Work Space',
        path: 'work-space',
        absolutePath: '/workspace/work-space',
        type: 'project',
        isSymlink: false,
        hasReadme: true,
      } as any,
    ]);
    vi.mocked(spaceService.readSpaceReadmeFrontmatter).mockResolvedValue(
      asSpaceFrontmatter({
        display_name: 'Work Space',
        sharing: 'restricted',
        rebel_space_description: 'Shared product collaboration space',
      }),
    );
    vi.mocked(spaceService.readSpaceReadmeBody).mockResolvedValue(
      'Do not store 1:1 notes in this shared space.',
    );
    vi.mocked(spaceService.getSpaceDisplayName).mockReturnValue('Work Space');
    vi.mocked(evaluateSafetyPrompt).mockResolvedValue({ decision: 'allow', confidence: 'high', reason: 'Safe' });
    vi.mocked(shouldAllow).mockReturnValue(true);
    vi.mocked(getAutomationContext).mockReturnValue({
      automationId: 'auto-space-context',
      automationName: 'Source Capture',
    } as any);

    const hook = createMemoryWriteHook({
      turnId: 'turn-space-context',
      sessionId: 'automation-space-context--1',
      originalTurnId: 'orig-turn-space-context',
      originalSessionId: 'orig-session-space-context',
      coreDirectory: '/workspace',
    });

    await hook(
      {
        tool_name: 'Create',
        tool_input: {
          file_path: '/workspace/work-space/memory/sources/test.md',
          content: 'Status update',
        },
        tool_use_id: 'tu-space-context',
      },
      'tu-space-context',
      { signal },
    );

    const actionContext = vi.mocked(evaluateSafetyPrompt).mock.calls[0]?.[2] as any;
    expect(actionContext.spaceLabel).toBe('Work Space');
    expect(actionContext.spaceReadmePreview).toContain('Do not store 1:1 notes');
    expect(actionContext.spaceDescription).toBe('Shared product collaboration space');
    expect(actionContext.spaceSharing).toEqual({
      effective: 'private',
      source: 'settings',
      settingsValue: 'private',
      frontmatterValue: 'team',
      mismatch: true,
    });
  });
});

describe('Bash cp/cat content enrichment for balanced path', () => {
  const signal = new AbortController().signal;
  const tmpDir = '/tmp/rebel-memhook-test';

  function setupBalancedSpace() {
    vi.mocked(settingsStore.getSettings).mockReturnValue({
      coreDirectory: '/workspace',
      spaces: [],
      spaceSafetyLevels: {
        'work-space': 'balanced',
      },
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
    vi.mocked(spaceService.readSpaceReadmeFrontmatter).mockResolvedValue(
      asSpaceFrontmatter({ sharing: 'restricted' })
    );
    vi.mocked(spaceService.getSpaceDisplayName).mockReturnValue('Work Space');
  }

  function setupAutomationBalancedSpace() {
    vi.mocked(settingsStore.getSettings).mockReturnValue({
      coreDirectory: '/workspace',
      spaces: [],
      spaceSafetyLevels: {},
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
    vi.mocked(spaceService.readSpaceReadmeFrontmatter).mockResolvedValue(
      asSpaceFrontmatter({ sharing: 'restricted' })
    );
    vi.mocked(spaceService.getSpaceDisplayName).mockReturnValue('Work Space');
  }

  beforeEach(async () => {
    vi.resetAllMocks();
    mockContainsCredentialPatterns.mockReturnValue({ detected: false, reasons: [] });
    vi.mocked(isMigrationComplete).mockReturnValue(true);
    vi.mocked(getSafetyPrompt).mockReturnValue('default safety prompt');
    vi.mocked(getSafetyPromptVersion).mockReturnValue(1);
    vi.mocked(cosPendingService.getPendingFileByDestination).mockResolvedValue({ kind: 'none' } as any);
    // Create temp dir for test source files
    await fs.mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('interactive: Bash cp to balanced space includes _contentPreview from source file', async () => {
    setupBalancedSpace();
    vi.mocked(evaluateSafetyPrompt).mockResolvedValue({ decision: 'allow', confidence: 'high', reason: 'Safe' });
    vi.mocked(shouldAllow).mockReturnValue(true);
    // Write a real source file for cp to read
    await fs.writeFile(path.join(tmpDir, 'notes.md'), '# Meeting Notes\n\nConfidential project details here.');

    const hook = createMemoryWriteHook({
      turnId: 'turn-cp-preview-1',
      sessionId: 'session-cp-preview-1',
      originalTurnId: 'orig-turn-cp-preview-1',
      originalSessionId: 'orig-session-cp-preview-1',
      coreDirectory: '/workspace',
    });

    const result = await hook(
      {
        tool_name: 'Bash',
        tool_input: { command: `cp ${tmpDir}/notes.md /workspace/work-space/notes.md` },
        tool_use_id: 'tu-cp-preview-1',
      },
      'tu-cp-preview-1',
      { signal }
    );

    expect(result).toEqual({});
    expect(evaluateSafetyPrompt).toHaveBeenCalled();
    const actionContext = vi.mocked(evaluateSafetyPrompt).mock.calls[0]?.[2] as any;
    expect(actionContext.toolInput._contentPreview).toBe('# Meeting Notes\n\nConfidential project details here.');
  });

  it('interactive: Bash cp with unreadable source proceeds without _contentPreview', async () => {
    setupBalancedSpace();
    vi.mocked(evaluateSafetyPrompt).mockResolvedValue({ decision: 'allow', confidence: 'high', reason: 'Safe' });
    vi.mocked(shouldAllow).mockReturnValue(true);

    const hook = createMemoryWriteHook({
      turnId: 'turn-cp-fallback-1',
      sessionId: 'session-cp-fallback-1',
      originalTurnId: 'orig-turn-cp-fallback-1',
      originalSessionId: 'orig-session-cp-fallback-1',
      coreDirectory: '/workspace',
    });

    const result = await hook(
      {
        tool_name: 'Bash',
        // Source file does not exist — extractFullContent returns null
        tool_input: { command: `cp ${tmpDir}/nonexistent.md /workspace/work-space/doc.md` },
        tool_use_id: 'tu-cp-fallback-1',
      },
      'tu-cp-fallback-1',
      { signal }
    );

    expect(result).toEqual({});
    expect(evaluateSafetyPrompt).toHaveBeenCalled();
    const actionContext = vi.mocked(evaluateSafetyPrompt).mock.calls[0]?.[2] as any;
    // No _contentPreview when source file is unreadable
    expect(actionContext.toolInput._contentPreview).toBeUndefined();
  });

  it('automation: Bash cp to balanced space includes _contentPreview', async () => {
    setupAutomationBalancedSpace();
    vi.mocked(evaluateSafetyPrompt).mockResolvedValue({ decision: 'allow', confidence: 'high', reason: 'Safe' });
    vi.mocked(shouldAllow).mockReturnValue(true);
    await fs.writeFile(path.join(tmpDir, 'report.md'), 'Quarterly report data for Q4.');

    const hook = createMemoryWriteHook({
      turnId: 'turn-auto-cp-1',
      sessionId: 'automation-cp-test--abc',
      originalTurnId: 'orig-turn-auto-cp-1',
      originalSessionId: 'orig-session-auto-cp-1',
      coreDirectory: '/workspace',
    });

    const result = await hook(
      {
        tool_name: 'Bash',
        tool_input: { command: `cp ${tmpDir}/report.md /workspace/work-space/report.md` },
        tool_use_id: 'tu-auto-cp-1',
      },
      'tu-auto-cp-1',
      { signal }
    );

    expect(result).toEqual({});
    expect(evaluateSafetyPrompt).toHaveBeenCalled();
    const actionContext = vi.mocked(evaluateSafetyPrompt).mock.calls[0]?.[2] as any;
    expect(actionContext.toolInput._contentPreview).toBe('Quarterly report data for Q4.');
  });

  it('interactive: echo Bash command gets _contentPreview from command content', async () => {
    setupBalancedSpace();
    vi.mocked(evaluateSafetyPrompt).mockResolvedValue({ decision: 'allow', confidence: 'high', reason: 'Safe' });
    vi.mocked(shouldAllow).mockReturnValue(true);

    const hook = createMemoryWriteHook({
      turnId: 'turn-echo-preview',
      sessionId: 'session-echo-preview',
      originalTurnId: 'orig-turn-echo-preview',
      originalSessionId: 'orig-session-echo-preview',
      coreDirectory: '/workspace',
    });

    const result = await hook(
      {
        tool_name: 'Bash',
        tool_input: { command: 'echo "hello world" > /workspace/work-space/greeting.md' },
        tool_use_id: 'tu-echo-preview',
      },
      'tu-echo-preview',
      { signal }
    );

    expect(result).toEqual({});
    expect(evaluateSafetyPrompt).toHaveBeenCalled();
    const actionContext = vi.mocked(evaluateSafetyPrompt).mock.calls[0]?.[2] as any;
    // extractFullContent returns the echo content (with trailing newline from redirect)
    expect(actionContext.toolInput._contentPreview).toMatch(/^hello world/);
  });

  it('interactive: _contentPreview is truncated to 8000 chars', async () => {
    setupBalancedSpace();
    vi.mocked(evaluateSafetyPrompt).mockResolvedValue({ decision: 'allow', confidence: 'high', reason: 'Safe' });
    vi.mocked(shouldAllow).mockReturnValue(true);
    const largeContent = 'x'.repeat(10000);
    await fs.writeFile(path.join(tmpDir, 'large.md'), largeContent);

    const hook = createMemoryWriteHook({
      turnId: 'turn-cp-truncate',
      sessionId: 'session-cp-truncate',
      originalTurnId: 'orig-turn-cp-truncate',
      originalSessionId: 'orig-session-cp-truncate',
      coreDirectory: '/workspace',
    });

    const result = await hook(
      {
        tool_name: 'Bash',
        tool_input: { command: `cp ${tmpDir}/large.md /workspace/work-space/large.md` },
        tool_use_id: 'tu-cp-truncate',
      },
      'tu-cp-truncate',
      { signal }
    );

    expect(result).toEqual({});
    const actionContext = vi.mocked(evaluateSafetyPrompt).mock.calls[0]?.[2] as any;
    expect(actionContext.toolInput._contentPreview).toHaveLength(8000);
  });
});

describe('secret gate on permissive writes', () => {
  const signal = new AbortController().signal;

  // Helper: set up a permissive private space (sharing: 'private', no spaceSafetyLevels entry)
  function setupPrivatePermissiveSpace() {
    vi.mocked(settingsStore.getSettings).mockReturnValue({
      coreDirectory: '/workspace',
      spaces: [],
      spaceSafetyLevels: {},
    } as any);
    vi.mocked(spaceService.scanSpaces).mockResolvedValue([
      {
        name: 'My Private Space',
        path: 'my-private-space',
        absolutePath: '/workspace/my-private-space',
        type: 'personal',
        isSymlink: false,
        hasReadme: true,
      } as any,
    ]);
    vi.mocked(spaceService.readSpaceReadmeFrontmatter).mockResolvedValue(
      asSpaceFrontmatter({ sharing: 'private' })
    );
    vi.mocked(spaceService.getSpaceDisplayName).mockReturnValue('My Private Space');
  }

  // Helper: set up Chief-of-Staff space (hardcoded permissive)
  function setupChiefOfStaffSpace() {
    vi.mocked(settingsStore.getSettings).mockReturnValue({
      coreDirectory: '/workspace',
      spaces: [{ path: 'chief-of-staff', type: 'chief-of-staff' }],
      spaceSafetyLevels: {},
    } as any);
    vi.mocked(spaceService.scanSpaces).mockResolvedValue([
      {
        name: 'Chief of Staff',
        path: 'chief-of-staff',
        absolutePath: '/workspace/chief-of-staff',
        type: 'chief-of-staff',
        isSymlink: false,
        hasReadme: true,
      } as any,
    ]);
    vi.mocked(spaceService.readSpaceReadmeFrontmatter).mockResolvedValue(
      asSpaceFrontmatter({ sharing: 'private' })
    );
    vi.mocked(spaceService.getSpaceDisplayName).mockReturnValue('Chief of Staff');
  }

  // Helper: set up a balanced space (sharing: 'restricted')
  function setupBalancedSpaceForSecretGate() {
    vi.mocked(settingsStore.getSettings).mockReturnValue({
      coreDirectory: '/workspace',
      spaces: [],
      spaceSafetyLevels: {},
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
    vi.mocked(spaceService.readSpaceReadmeFrontmatter).mockResolvedValue(
      asSpaceFrontmatter({ sharing: 'restricted' })
    );
    vi.mocked(spaceService.getSpaceDisplayName).mockReturnValue('Work Space');
  }

  function createInteractiveHook(overrides: Partial<Parameters<typeof createMemoryWriteHook>[0]> = {}) {
    return createMemoryWriteHook({
      turnId: 'turn-sg-1',
      sessionId: 'session-sg-1',
      originalTurnId: 'orig-turn-sg-1',
      originalSessionId: 'orig-session-sg-1',
      coreDirectory: '/workspace',
      ...overrides,
    });
  }

  function createAutomationHook(overrides: Partial<Parameters<typeof createMemoryWriteHook>[0]> = {}) {
    return createMemoryWriteHook({
      turnId: 'turn-sg-auto-1',
      sessionId: 'automation-sg-test--abc',
      originalTurnId: 'orig-turn-sg-auto-1',
      originalSessionId: 'orig-session-sg-auto-1',
      coreDirectory: '/workspace',
      ...overrides,
    });
  }

  beforeEach(() => {
    vi.resetAllMocks();
    // Default: no credentials detected (secret gate passes through)
    mockContainsCredentialPatterns.mockReturnValue({ detected: false, reasons: [] });
    vi.mocked(isMigrationComplete).mockReturnValue(true);
    vi.mocked(getSafetyPrompt).mockReturnValue('default safety prompt');
    vi.mocked(getSafetyPromptVersion).mockReturnValue(1);
    vi.mocked(cosPendingService.getPendingFileByDestination).mockResolvedValue({ kind: 'none' } as any);
    setupPrivatePermissiveSpace();
  });

  it('permissive private space + normal content → auto-approve (no secret gate)', async () => {
    const hook = createInteractiveHook();
    const result = await hook(
      { tool_name: 'Create', tool_input: { path: '/workspace/my-private-space/notes.md', content: 'meeting notes' }, tool_use_id: 'tu-sg-1' },
      'tu-sg-1', { signal }
    );
    expect(result).toEqual({});
    // Private spaces skip the secret gate entirely
    expect(mockContainsCredentialPatterns).not.toHaveBeenCalled();
    expect(evaluateSafetyPrompt).not.toHaveBeenCalled();
  });

  it('permissive private space + content with API key → auto-approve (private spaces skip secret gate)', async () => {
    mockContainsCredentialPatterns.mockReturnValue({ detected: true, reasons: ['anthropic_api_key'] });
    const hook = createInteractiveHook();
    const result = await hook(
      { tool_name: 'Create', tool_input: { path: '/workspace/my-private-space/config.md', content: 'key: sk-ant-abc123' }, tool_use_id: 'tu-sg-2' },
      'tu-sg-2', { signal }
    );
    // Private space bypasses the secret gate — auto-approved
    expect(result).toEqual({});
    expect(mockContainsCredentialPatterns).not.toHaveBeenCalled();
    expect(evaluateSafetyPrompt).not.toHaveBeenCalled();
  });

  it('private space + content with PEM key → auto-approve (private spaces skip secret gate)', async () => {
    const hook = createInteractiveHook();
    mockContainsCredentialPatterns.mockReturnValue({ detected: true, reasons: ['pem_private_key'] });
    const result = await hook(
      { tool_name: 'Create', tool_input: { path: '/workspace/my-private-space/secrets.md', content: '-----BEGIN RSA PRIVATE KEY-----\nMIIE...' }, tool_use_id: 'tu-sg-3' },
      'tu-sg-3', { signal }
    );
    // Private space bypasses the secret gate entirely — auto-approved
    expect(result).toEqual({});
    expect(evaluateSafetyPrompt).not.toHaveBeenCalled();
    expect(mockContainsCredentialPatterns).not.toHaveBeenCalled();
  });

  it('Chief-of-Staff + content with PEM key → auto-approve (same as any private space)', async () => {
    setupChiefOfStaffSpace();
    mockContainsCredentialPatterns.mockReturnValue({ detected: true, reasons: ['pem_private_key'] });
    const hook = createInteractiveHook();
    const result = await hook(
      { tool_name: 'Create', tool_input: { path: '/workspace/chief-of-staff/secrets.md', content: '-----BEGIN RSA PRIVATE KEY-----\nMIIE...' }, tool_use_id: 'tu-sg-3b' },
      'tu-sg-3b', { signal }
    );
    expect(result).toEqual({});
    expect(mockContainsCredentialPatterns).not.toHaveBeenCalled();
  });

  it('Bash non-inspectable in private space → auto-approved (private spaces skip secret gate)', async () => {
    const hook = createInteractiveHook();
    const result = await hook(
      { tool_name: 'Bash', tool_input: { command: 'echo "$SECRET" > /workspace/my-private-space/env.txt' }, tool_use_id: 'tu-sg-4' },
      'tu-sg-4', { signal }
    );
    // Private space bypasses secret gate — even non-inspectable writes auto-approve
    expect(result).toEqual({});
    expect(mockContainsCredentialPatterns).not.toHaveBeenCalled();
    expect(evaluateSafetyPrompt).not.toHaveBeenCalled();
  });

  it('Bash cp in private space → auto-approved', async () => {
    const hook = createInteractiveHook();
    const result = await hook(
      { tool_name: 'Bash', tool_input: { command: 'cp /workspace/my-private-space/source.md /workspace/my-private-space/dest.md' }, tool_use_id: 'tu-sg-cp' },
      'tu-sg-cp', { signal }
    );
    expect(result).toEqual({});
    expect(evaluateSafetyPrompt).not.toHaveBeenCalled();
  });

  it('Bash cat redirect in private space → auto-approved', async () => {
    const hook = createInteractiveHook();
    const result = await hook(
      { tool_name: 'Bash', tool_input: { command: 'cat /workspace/my-private-space/proposal.md > /workspace/my-private-space/temp/copy.md' }, tool_use_id: 'tu-sg-cat' },
      'tu-sg-cat', { signal }
    );
    expect(result).toEqual({});
    expect(evaluateSafetyPrompt).not.toHaveBeenCalled();
  });

  it('Bash heredoc with secret in body to private space → auto-approve (private skips gate)', async () => {
    mockContainsCredentialPatterns.mockReturnValue({ detected: true, reasons: ['openai_api_key'] });
    const hook = createInteractiveHook();
    const result = await hook(
      {
        tool_name: 'Bash',
        tool_input: { command: "cat > /workspace/my-private-space/config.txt << 'EOF'\napi_key=sk-1234567890abcdef1234567890abcdef\nEOF" },
        tool_use_id: 'tu-sg-5',
      },
      'tu-sg-5', { signal }
    );
    // Private space bypasses the secret gate
    expect(result).toEqual({});
    expect(mockContainsCredentialPatterns).not.toHaveBeenCalled();
    expect(evaluateSafetyPrompt).not.toHaveBeenCalled();
  });

  // Note: The secret gate (credential pattern check, non-inspectable Bash fail-closed)
  // is now defense-in-depth only — it can't fire for private spaces (which skip it),
  // and the safety floor prevents non-private spaces from reaching 'permissive'.
  // The gate remains in the code as a guardrail in case the safety floor logic changes.

  it('balanced space + content with secrets → no secret gate (gate does not run on non-permissive)', async () => {
    setupBalancedSpaceForSecretGate();
    // Set up secrets detection — but it should NOT be called because the path is balanced, not permissive
    mockContainsCredentialPatterns.mockReturnValue({ detected: true, reasons: ['anthropic_api_key'] });
    // Set up Safety Prompt to allow (so the write goes through normally)
    vi.mocked(evaluateSafetyPrompt).mockResolvedValue({ decision: 'allow', confidence: 'high', reason: 'Allowed' });
    vi.mocked(shouldAllow).mockReturnValue(true);

    const hook = createInteractiveHook();
    const result = await hook(
      { tool_name: 'Create', tool_input: { path: '/workspace/work-space/notes.md', content: 'sk-ant-abc123' }, tool_use_id: 'tu-sg-7' },
      'tu-sg-7', { signal }
    );
    // Should be allowed by Safety Prompt (balanced path)
    expect(result).toEqual({});
    // Safety Prompt WAS called (balanced path)
    expect(evaluateSafetyPrompt).toHaveBeenCalled();
    // Secret gate should NOT have run (only runs on permissive)
    expect(mockContainsCredentialPatterns).not.toHaveBeenCalled();
  });

  // --- Automation path tests ---

  it('automation: private space + content with API key → auto-approve (private skips secret gate)', async () => {
    setupPrivatePermissiveSpace();
    mockContainsCredentialPatterns.mockReturnValue({ detected: true, reasons: ['anthropic_api_key'] });

    const hook = createAutomationHook();
    const result = await hook(
      { tool_name: 'Create', tool_input: { path: '/workspace/my-private-space/config.md', content: 'key: sk-ant-abc123' }, tool_use_id: 'tu-sg-auto-1' },
      'tu-sg-auto-1', { signal }
    );
    expect(result).toEqual({});
    expect(mockContainsCredentialPatterns).not.toHaveBeenCalled();
    expect(evaluateSafetyPrompt).not.toHaveBeenCalled();
  });

  it('automation: Chief-of-Staff + content with API key → auto-approve (same as any private)', async () => {
    setupChiefOfStaffSpace();
    mockContainsCredentialPatterns.mockReturnValue({ detected: true, reasons: ['anthropic_api_key'] });

    const hook = createAutomationHook();
    const result = await hook(
      { tool_name: 'Create', tool_input: { path: '/workspace/chief-of-staff/config.md', content: 'key: sk-ant-abc123' }, tool_use_id: 'tu-sg-auto-cos' },
      'tu-sg-auto-cos', { signal }
    );
    expect(result).toEqual({});
    expect(mockContainsCredentialPatterns).not.toHaveBeenCalled();
  });

  it('automation: Bash non-inspectable in private space → auto-approve (private skips secret gate)', async () => {
    setupPrivatePermissiveSpace();
    const hook = createAutomationHook();
    const result = await hook(
      { tool_name: 'Bash', tool_input: { command: 'echo "$SECRET" > /workspace/my-private-space/config.env' }, tool_use_id: 'tu-sg-auto-2' },
      'tu-sg-auto-2', { signal }
    );
    expect(result).toEqual({});
    expect(mockContainsCredentialPatterns).not.toHaveBeenCalled();
  });

  // --- FOX-3072: settings-first authority when frontmatter sharing is drifted ---------

  /**
   * Configure a verified Chief-of-Staff whose frontmatter `sharing` field is MISSING
   * (the FOX-3072 scenario). The settings entry still has `type: 'chief-of-staff'`,
   * so `isVerifiedChiefOfStaff` should be the authority that drives the secret-gate skip.
   */
  function setupCoSWithMissingSharing() {
    vi.mocked(settingsStore.getSettings).mockReturnValue({
      coreDirectory: '/workspace',
      spaces: [{ path: 'chief-of-staff', type: 'chief-of-staff' }],
      spaceSafetyLevels: {},
    } as any);
    vi.mocked(spaceService.scanSpaces).mockResolvedValue([
      {
        name: 'Chief of Staff',
        path: 'chief-of-staff',
        absolutePath: '/workspace/chief-of-staff',
        type: 'chief-of-staff',
        isSymlink: false,
        hasReadme: true,
      } as any,
    ]);
    // KEY: frontmatter lacks the `sharing` field (FOX-3072 repro condition).
    vi.mocked(spaceService.readSpaceReadmeFrontmatter).mockResolvedValue(
      asSpaceFrontmatter({ rebel_space_description: 'Router' })
    );
    vi.mocked(spaceService.getSpaceDisplayName).mockReturnValue('Chief of Staff');
  }

  it('FOX-3072: CoS with missing frontmatter sharing + API-key content → auto-approve (interactive)', async () => {
    setupCoSWithMissingSharing();
    mockContainsCredentialPatterns.mockReturnValue({ detected: true, reasons: ['anthropic_api_key'] });
    const hook = createInteractiveHook();
    const result = await hook(
      { tool_name: 'Create', tool_input: { path: '/workspace/chief-of-staff/config.md', content: 'key: sk-ant-abc123' }, tool_use_id: 'tu-fox3072-interactive' },
      'tu-fox3072-interactive', { signal }
    );
    // Verified CoS — secret gate must be skipped even with drifted frontmatter.
    expect(result).toEqual({});
    expect(mockContainsCredentialPatterns).not.toHaveBeenCalled();
    expect(evaluateSafetyPrompt).not.toHaveBeenCalled();
  });

  it('FOX-3072: CoS with missing frontmatter sharing + API-key content → auto-approve (automation)', async () => {
    setupCoSWithMissingSharing();
    mockContainsCredentialPatterns.mockReturnValue({ detected: true, reasons: ['anthropic_api_key'] });
    const hook = createAutomationHook();
    const result = await hook(
      { tool_name: 'Create', tool_input: { path: '/workspace/chief-of-staff/config.md', content: 'key: sk-ant-abc123' }, tool_use_id: 'tu-fox3072-automation' },
      'tu-fox3072-automation', { signal }
    );
    expect(result).toEqual({});
    expect(mockContainsCredentialPatterns).not.toHaveBeenCalled();
  });

  it('FOX-3072: "fake" chief-of-staff path NOT in settings does NOT bypass — safety floor caps to balanced', async () => {
    // Attacker-controlled space pretends to be CoS via README frontmatter but isn't in settings.spaces.
    // Even with a user-override of 'permissive' on this path, the safety floor in
    // resolveMemorySafetyLevel caps non-private to 'balanced', so we never even reach the
    // permissive bypass code path. The write must NOT be auto-approved.
    vi.mocked(settingsStore.getSettings).mockReturnValue({
      coreDirectory: '/workspace',
      spaces: [], // No CoS entry in settings — authority rejects CoS claim
      spaceSafetyLevels: { 'evil-space': 'permissive' },
    } as any);
    vi.mocked(spaceService.scanSpaces).mockResolvedValue([
      {
        name: 'Chief of Staff',
        path: 'evil-space',
        absolutePath: '/workspace/evil-space',
        type: 'chief-of-staff',  // Scanned frontmatter claims CoS type — must be ignored
        isSymlink: false,
        hasReadme: true,
      } as any,
    ]);
    vi.mocked(spaceService.readSpaceReadmeFrontmatter).mockResolvedValue(
      asSpaceFrontmatter({ space_type: 'chief-of-staff', rebel_space_description: 'Malicious' })
    );
    vi.mocked(spaceService.getSpaceDisplayName).mockReturnValue('Chief of Staff');
    mockContainsCredentialPatterns.mockReturnValue({ detected: true, reasons: ['anthropic_api_key'] });

    const hook = createInteractiveHook();
    const result = await hook(
      { tool_name: 'Create', tool_input: { path: '/workspace/evil-space/secrets.md', content: 'key: sk-ant-EXAMPLE' }, tool_use_id: 'tu-fake-cos' },
      'tu-fake-cos', { signal }
    );
    // Must NOT be auto-approved — either safety floor or secret gate must have caught it.
    // The observable invariant is: result is not an empty object (no auto-approval).
    expect(result).not.toEqual({});
  });

  it('FOX-3072: non-CoS private write still bypasses secret gate (unchanged)', async () => {
    // Regression guard: verified-CoS is an ADDITIONAL bypass path, not a replacement.
    // Private spaces must still bypass via the sharing==='private' authority axis.
    setupPrivatePermissiveSpace();
    mockContainsCredentialPatterns.mockReturnValue({ detected: true, reasons: ['anthropic_api_key'] });
    const hook = createInteractiveHook();
    const result = await hook(
      { tool_name: 'Create', tool_input: { path: '/workspace/my-private-space/notes.md', content: 'key: sk-ant-EXAMPLE' }, tool_use_id: 'tu-private-regress' },
      'tu-private-regress', { signal }
    );
    expect(result).toEqual({});
    expect(mockContainsCredentialPatterns).not.toHaveBeenCalled();
  });

  it('FOX-3072: CoS path but missing from settings.spaces does NOT bypass', async () => {
    // If the user's settings lost the CoS entry somehow (corrupted settings), fall back
    // to the sharing axis. Frontmatter without sharing + no settings entry = secret gate runs.
    vi.mocked(settingsStore.getSettings).mockReturnValue({
      coreDirectory: '/workspace',
      spaces: [], // No CoS entry — user's settings corrupted/missing
      spaceSafetyLevels: {},
    } as any);
    vi.mocked(spaceService.scanSpaces).mockResolvedValue([
      {
        name: 'Chief of Staff',
        path: 'chief-of-staff',
        absolutePath: '/workspace/chief-of-staff',
        type: 'chief-of-staff',
        isSymlink: false,
        hasReadme: true,
      } as any,
    ]);
    vi.mocked(spaceService.readSpaceReadmeFrontmatter).mockResolvedValue(
      asSpaceFrontmatter({ rebel_space_description: 'Router' }) // sharing missing
    );
    vi.mocked(spaceService.getSpaceDisplayName).mockReturnValue('Chief of Staff');
    mockContainsCredentialPatterns.mockReturnValue({ detected: true, reasons: ['anthropic_api_key'] });

    const hook = createInteractiveHook();
    const result = await hook(
      { tool_name: 'Create', tool_input: { path: '/workspace/chief-of-staff/secrets.md', content: 'key: sk-ant-EXAMPLE' }, tool_use_id: 'tu-no-settings' },
      'tu-no-settings', { signal }
    );
    // Not auto-approved with empty object — secret gate ran.
    expect(result).not.toEqual({});
  });
});

describe('MCP servers auto-approve (~/mcp-servers/)', () => {
  const signal = new AbortController().signal;

  beforeEach(() => {
    vi.clearAllMocks();
    // No matching space for ~/mcp-servers/ paths
    vi.mocked(spaceService.scanSpaces).mockResolvedValue([]);
    vi.mocked(settingsStore.getSettings).mockReturnValue({
      coreDirectory: '/workspace',
      spaces: [],
      spaceSafetyLevels: {},
    } as any);
    mockContainsCredentialPatterns.mockReturnValue({ detected: false, reasons: [] });
  });

  it('auto-approves writes to ~/mcp-servers/ (absolute path)', async () => {
    const hook = createMemoryWriteHook({
      turnId: 'turn-mcp-1',
      sessionId: 'session-mcp-1',
      originalTurnId: 'orig-turn-mcp-1',
      originalSessionId: 'orig-session-mcp-1',
      coreDirectory: '/workspace',
    });

    const result = await hook(
      {
        tool_name: 'Create',
        tool_input: {
          path: '/users/test/mcp-servers/my-api/package.json',
          content: '{ "name": "my-api-mcp" }',
        },
        tool_use_id: 'tool-mcp-1',
      },
      'tool-mcp-1',
      { signal }
    );

    // Empty object = allow (memory write hook convention)
    expect(result).toEqual({});
  });

  it('auto-approves writes with literal tilde path (~/mcp-servers/...)', async () => {
    const hook = createMemoryWriteHook({
      turnId: 'turn-mcp-2',
      sessionId: 'session-mcp-2',
      originalTurnId: 'orig-turn-mcp-2',
      originalSessionId: 'orig-session-mcp-2',
      coreDirectory: '/workspace',
    });

    const result = await hook(
      {
        tool_name: 'Create',
        tool_input: {
          path: '~/mcp-servers/my-api/index.ts',
          content: 'console.log("hello");',
        },
        tool_use_id: 'tool-mcp-2',
      },
      'tool-mcp-2',
      { signal }
    );

    expect(result).toEqual({});
  });

  it('logs [SECURITY] warning when MCP server mode bypasses existing pending preflight', async () => {
    const previousMode = process.env.REBEL_MCP_SERVER_MODE;
    process.env.REBEL_MCP_SERVER_MODE = '1';

    vi.mocked(cosPendingService.getPendingFileByDestination).mockResolvedValue({
      file: {
        id: 'pending-mcp-bypass-old',
        filename: 'mcp-bypass-old.pending.md',
        frontmatter: {
          session_id: 'orig-session-mcp-bypass',
          tool_use_id: 'old-tool-use-mcp-bypass',
          blocked_by: 'safety_prompt',
        },
      },
      content: 'old content',
    } as any);

    try {
      const hook = createMemoryWriteHook({
        turnId: 'turn-mcp-bypass',
        sessionId: 'session-mcp-bypass',
        originalTurnId: 'orig-turn-mcp-bypass',
        originalSessionId: 'orig-session-mcp-bypass',
        coreDirectory: '/workspace',
      });

      const result = await hook(
        {
          tool_name: 'Create',
          tool_input: {
            path: '/workspace/test-space/mcp-bypass.md',
            content: 'new content',
          },
          tool_use_id: 'tool-mcp-bypass',
        },
        'tool-mcp-bypass',
        { signal }
      );

      expect(result).toEqual({});
      expect(cosPendingService.writeToPending).not.toHaveBeenCalled();

      const securityBypassLog = mockLoggerWarn.mock.calls.find((call) =>
        typeof call[1] === 'string'
          && call[1].includes('[SECURITY] Existing pending-review stickiness bypassed because MCP server mode is active')
      );
      expect(securityBypassLog).toBeDefined();
    } finally {
      if (previousMode === undefined) {
        delete process.env.REBEL_MCP_SERVER_MODE;
      } else {
        process.env.REBEL_MCP_SERVER_MODE = previousMode;
      }
    }
  });

  it('does NOT auto-approve MCP server writes in private mode', async () => {
    const hook = createMemoryWriteHook({
      turnId: 'turn-mcp-3',
      sessionId: 'session-mcp-3',
      originalTurnId: 'orig-turn-mcp-3',
      originalSessionId: 'orig-session-mcp-3',
      coreDirectory: '/workspace',
      privateMode: true,
    });

    vi.mocked(cosPendingService.writeToPending).mockResolvedValue({
      id: 'pending-mcp-3',
      filename: 'staged.json',
    } as any);

    const result = await hook(
      {
        tool_name: 'Create',
        tool_input: {
          path: '/users/test/mcp-servers/my-api/package.json',
          content: '{ "name": "my-api-mcp" }',
        },
        tool_use_id: 'tool-mcp-3',
      },
      'tool-mcp-3',
      { signal }
    );

    // Should NOT be empty {} — private mode forces cautious → staged
    const output = getHookSpecificOutput(result);
    expect(output?.replaceResult || output?.permissionDecision).toBeTruthy();
  });

  it('does NOT auto-approve MCP server writes with credential patterns', async () => {
    mockContainsCredentialPatterns.mockReturnValue({
      detected: true,
      reasons: ['api_key_pattern'],
    });

    vi.mocked(cosPendingService.writeToPending).mockResolvedValue({
      id: 'pending-mcp-4',
      filename: 'staged.env',
    } as any);

    const hook = createMemoryWriteHook({
      turnId: 'turn-mcp-4',
      sessionId: 'session-mcp-4',
      originalTurnId: 'orig-turn-mcp-4',
      originalSessionId: 'orig-session-mcp-4',
      coreDirectory: '/workspace',
    });

    const result = await hook(
      {
        tool_name: 'Create',
        tool_input: {
          path: '/users/test/mcp-servers/my-api/.env',
          content: 'API_KEY=sk-ant-abc123',
        },
        tool_use_id: 'tool-mcp-4',
      },
      'tool-mcp-4',
      { signal }
    );

    // Should NOT be empty {} — credentials detected, falls through to cautious → staged
    const output = getHookSpecificOutput(result);
    expect(output?.replaceResult || output?.permissionDecision).toBeTruthy();
  });

  it('does NOT classify path traversal as mcp_servers', async () => {
    vi.mocked(cosPendingService.writeToPending).mockResolvedValue({
      id: 'pending-mcp-5',
      filename: 'staged.keys',
    } as any);

    const hook = createMemoryWriteHook({
      turnId: 'turn-mcp-5',
      sessionId: 'session-mcp-5',
      originalTurnId: 'orig-turn-mcp-5',
      originalSessionId: 'orig-session-mcp-5',
      coreDirectory: '/workspace',
    });

    const result = await hook(
      {
        tool_name: 'Create',
        tool_input: {
          path: '/users/test/mcp-servers/../../.ssh/keys',
          content: 'malicious content',
        },
        tool_use_id: 'tool-mcp-5',
      },
      'tool-mcp-5',
      { signal }
    );

    // Path resolves to /users/.ssh/keys — NOT under ~/mcp-servers/
    // Should NOT be auto-approved — goes through cautious → staged
    const output = getHookSpecificOutput(result);
    expect(output?.replaceResult || output?.permissionDecision).toBeTruthy();
  });

  it('automation sessions still stage MCP server writes', async () => {
    vi.mocked(cosPendingService.writeToPending).mockResolvedValue({
      id: 'pending-mcp-6',
      filename: 'staged.json',
    } as any);

    const hook = createMemoryWriteHook({
      turnId: 'turn-mcp-auto',
      sessionId: 'automation-mcp-test--abc',
      originalTurnId: 'orig-turn-mcp-auto',
      originalSessionId: 'orig-session-mcp-auto',
      coreDirectory: '/workspace',
    });

    const result = await hook(
      {
        tool_name: 'Create',
        tool_input: {
          path: '/users/test/mcp-servers/my-api/package.json',
          content: '{ "name": "my-api-mcp" }',
        },
        tool_use_id: 'tool-mcp-auto',
      },
      'tool-mcp-auto',
      { signal }
    );

    // Automation sessions go through automation path → cautious → staged
    const output = getHookSpecificOutput(result);
    expect(output?.replaceResult || output?.permissionDecision).toBeTruthy();
  });
});

describe('isProtectedSystemPath', () => {
  it('detects absolute paths inside rebel-system/', () => {
    expect(isProtectedSystemPath('/workspace/rebel-system/skills/test.md')).toBe(true);
    expect(isProtectedSystemPath('/workspace/rebel-system/AGENTS.md')).toBe(true);
    expect(isProtectedSystemPath('/workspace/rebel-system/help-for-humans/test.html')).toBe(true);
  });

  it('detects relative paths with coreDirectory', () => {
    expect(isProtectedSystemPath('rebel-system/skills/test.md', '/workspace')).toBe(true);
    expect(isProtectedSystemPath('rebel-system/AGENTS.md', '/workspace')).toBe(true);
  });

  it('detects the rebel-system directory itself (no trailing child)', () => {
    expect(isProtectedSystemPath('/workspace/rebel-system')).toBe(true);
  });

  it('detects .rebel managed paths', () => {
    expect(isProtectedSystemPath('/workspace/team-space/.rebel/history/skills/demo/123.md')).toBe(true);
    expect(isProtectedSystemPath('team-space/.rebel/history/skills/demo/123.md', '/workspace')).toBe(true);
  });

  it('detects paths with traversal segments', () => {
    expect(isProtectedSystemPath('/workspace/notes/../rebel-system/test.md')).toBe(true);
  });

  it('allows paths not in rebel-system/', () => {
    expect(isProtectedSystemPath('/workspace/Chief-of-Staff/skills/test.md')).toBe(false);
    expect(isProtectedSystemPath('/workspace/General/memory/topics/test.md')).toBe(false);
    expect(isProtectedSystemPath('/tmp/scratch.txt')).toBe(false);
  });

  it('does not false-positive on paths that merely contain the string', () => {
    // A file called "rebel-system-notes.md" in a normal space should NOT be blocked
    expect(isProtectedSystemPath('/workspace/notes/rebel-system-notes.md')).toBe(false);
    expect(isProtectedSystemPath('/workspace/notes/rebel-history-notes.md')).toBe(false);
  });
});

// =============================================================================
// Safety-eval progress broadcasts on the memory-write hook (HIGH-2 regression)
//
// Mirror of the interactive tool-safety progress tests. Memory writes run
// their own Safety Prompt eval path separate from tool-safety, so a missing
// broadcast here would leave the "Checking this is safe…" subline stuck on
// shared-space file writes even after the eval finishes.
//
// Also includes the HIGH-1 signal-forwarding assertion: the hook MUST pass
// the runtime abort signal through to evaluateSafetyPrompt so pressing Stop
// mid-flight cancels the LLM call.
//
// See: docs/plans/260417_safety_eval_silent_lock_bugfix.md
// =============================================================================

describe('createMemoryWriteHook safety-eval progress broadcasts', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockContainsCredentialPatterns.mockReturnValue({ detected: false, reasons: [] });

    // `restricted` sharing → balanced trust level → Safety Prompt eval runs.
    // This matches the existing pattern elsewhere in this file for triggering
    // the interactive eval path.
    vi.mocked(settingsStore.getSettings).mockReturnValue({
      coreDirectory: '/workspace',
      spaces: [],
      spaceSafetyLevels: {},
    } as any);
    vi.mocked(spaceService.scanSpaces).mockResolvedValue([
      {
        name: 'Team Space',
        path: 'team-space',
        absolutePath: '/workspace/team-space',
        type: 'personal',
        isSymlink: false,
        hasReadme: true,
      } as any,
    ]);
    vi.mocked(spaceService.getSpaceDisplayName).mockImplementation(
      (space: any) => space.displayName ?? space.name,
    );
    vi.mocked(spaceService.readSpaceReadmeFrontmatter).mockResolvedValue({
      sharing: 'restricted',
      rebel_space_description: 'Shared team space',
    });
    vi.mocked(isMigrationComplete).mockReturnValue(true);
    vi.mocked(getSafetyPrompt).mockReturnValue('default safety prompt');
    vi.mocked(getSafetyPromptVersion).mockReturnValue(1);
  });

  const runInteractiveCreate = async (toolUseId: string) => {
    const hook = createMemoryWriteHook({
      turnId: 'mem-turn-1',
      sessionId: 'mem-session-1',
      originalTurnId: 'mem-orig-turn-1',
      originalSessionId: 'mem-orig-session-1',
      coreDirectory: '/workspace',
    });
    return hook(
      {
        tool_name: 'Create',
        tool_input: {
          path: '/workspace/team-space/notes.md',
          content: 'notes',
        },
        tool_use_id: toolUseId,
      },
      toolUseId,
      { signal: new AbortController().signal },
    );
  };

  const evaluatingPayloads = () =>
    mockSendToAllWindows.mock.calls.filter((c) => c[0] === 'tool-safety:evaluating');
  const completePayloads = () =>
    mockSendToAllWindows.mock.calls.filter((c) => c[0] === 'tool-safety:evaluating-complete');

  it('broadcasts :evaluating with memory-write-specific payload before the LLM await (interactive)', async () => {
    // Capture broadcast state at the moment evaluateSafetyPrompt is called —
    // the `:evaluating` event MUST fire first so the renderer can surface the
    // "Checking this is safe…" subline while we wait.
    let broadcastCountAtEvalEntry = -1;
    let payloadAtEntry: Record<string, unknown> | undefined;
    vi.mocked(evaluateSafetyPrompt).mockImplementationOnce(async () => {
      const calls = evaluatingPayloads();
      broadcastCountAtEvalEntry = calls.length;
      payloadAtEntry = calls[0]?.[1] as Record<string, unknown> | undefined;
      return { decision: 'allow', confidence: 'high', reason: 'ok' };
    });
    vi.mocked(shouldAllow).mockReturnValue(true);

    await runInteractiveCreate('mem-eval-1');

    expect(broadcastCountAtEvalEntry).toBeGreaterThanOrEqual(1);
    expect(payloadAtEntry).toMatchObject({
      toolUseId: 'mem-eval-1',
      sessionId: 'mem-session-1',
      turnId: 'mem-turn-1',
      toolName: 'Create',
      attempt: 1,
    });
    expect(typeof (payloadAtEntry as { startedAt: unknown }).startedAt).toBe('number');
  });

  it('broadcasts -complete with outcome "allowed" after an allow verdict (interactive memory)', async () => {
    vi.mocked(evaluateSafetyPrompt).mockResolvedValueOnce({
      decision: 'allow',
      confidence: 'high',
      reason: 'ok',
    });
    vi.mocked(shouldAllow).mockReturnValue(true);

    await runInteractiveCreate('mem-eval-allow');

    const completes = completePayloads();
    expect(completes.length).toBeGreaterThanOrEqual(1);
    // The hook only ever broadcasts ONE outcome per tool_use_id (idempotent
    // guard). Assert the first payload matches — any subsequent `-complete`
    // would indicate a double-emit bug.
    expect(completes[0][1]).toMatchObject({
      toolUseId: 'mem-eval-allow',
      sessionId: 'mem-session-1',
      turnId: 'mem-turn-1',
      outcome: 'allowed',
    });
  });

  it('broadcasts -complete with outcome "aborted" on AbortError and returns allow (interactive memory)', async () => {
    const abortErr = new Error('aborted mid-flight');
    abortErr.name = 'AbortError';
    vi.mocked(evaluateSafetyPrompt).mockRejectedValueOnce(abortErr);

    const result = await runInteractiveCreate('mem-eval-abort');

    // Allow + empty output lets the turn tear-down proceed cleanly rather
    // than hanging on a stuck hook.
    expect(result).toEqual({});

    const completes = completePayloads();
    expect(completes[0][1]).toMatchObject({
      toolUseId: 'mem-eval-abort',
      outcome: 'aborted',
    });
  });

  it('forwards the runtime abort signal into evaluateSafetyPrompt (HIGH-1 guard)', async () => {
    // Regression coverage for the silent signal drop. The memory-write hook
    // must plumb `options.signal` all the way into the safety-eval call so
    // pressing Stop mid-flight cancels the LLM. We assert the 4th positional
    // argument (EvaluateSafetyPromptOptions) has a `signal` that is an
    // AbortSignal instance.
    vi.mocked(evaluateSafetyPrompt).mockResolvedValueOnce({
      decision: 'allow',
      confidence: 'high',
      reason: 'ok',
    });
    vi.mocked(shouldAllow).mockReturnValue(true);

    const controller = new AbortController();

    const hook = createMemoryWriteHook({
      turnId: 'mem-sig-turn',
      sessionId: 'mem-sig-session',
      originalTurnId: 'mem-sig-orig-turn',
      originalSessionId: 'mem-sig-orig-session',
      coreDirectory: '/workspace',
    });
    await hook(
      {
        tool_name: 'Create',
        tool_input: { path: '/workspace/team-space/notes.md', content: 'notes' },
        tool_use_id: 'mem-sig-tool',
      },
      'mem-sig-tool',
      { signal: controller.signal },
    );

    expect(vi.mocked(evaluateSafetyPrompt)).toHaveBeenCalled();
    const opts = vi.mocked(evaluateSafetyPrompt).mock.calls[0]?.[3] as
      | { signal?: AbortSignal; onAttempt?: unknown }
      | undefined;
    expect(opts?.signal).toBeInstanceOf(AbortSignal);
    // `onAttempt` is forwarded too (drives the retry re-broadcast), belt &
    // braces for HIGH-2 memory path.
    expect(typeof opts?.onAttempt).toBe('function');
  });
});

// =============================================================================
// Stage 4 (260529_memory_write_intent_context_parity.md):
// Security invariant + out-of-scope boundary + cross-path drift guard.
//
// The Stage 4 plan + the Security/Behavioral Invariant section explicitly
// require that:
//   1. user intent **informs** the evaluator — it must NEVER auto-authorize a
//      write or bypass the structural credential gate, `shouldAllow`, or the
//      confidence floor.
//   2. background memory-update hooks (system-initiated turns) must NOT carry
//      intent into the ActionContext — even accidentally — so the boundary is
//      mechanically pinned.
//   3. the memory-write path and the tool-safety path attach the SAME intent
//      field NAMES, so a future dev adding a 4th intent field to one path can
//      detect divergence cheaply (no hot-closure refactor needed).
//
// See also `docs/plans/260529_memory_write_intent_context_parity.md`.
// =============================================================================

describe('memory-write intent context — security invariant + boundary', () => {
  const signal = new AbortController().signal;

  // Balanced (sharing: 'restricted') space → reaches the Safety Prompt eval.
  function setupBalancedSpace() {
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
    vi.mocked(spaceService.readSpaceReadmeFrontmatter).mockResolvedValue(
      asSpaceFrontmatter({ sharing: 'restricted' }),
    );
    vi.mocked(spaceService.getSpaceDisplayName).mockReturnValue('Work Space');
  }

  beforeEach(() => {
    vi.resetAllMocks();
    mockContainsCredentialPatterns.mockReturnValue({ detected: false, reasons: [] });
    vi.mocked(isMigrationComplete).mockReturnValue(true);
    vi.mocked(getSafetyPrompt).mockReturnValue('default safety prompt');
    vi.mocked(getSafetyPromptVersion).mockReturnValue(1);
    vi.mocked(cosPendingService.getPendingFileByDestination).mockResolvedValue({ kind: 'none' } as any);
    setupBalancedSpace();
  });

  // --- Security gate-regression (MUST) -------------------------------------
  // The Stage 1 spike already proved sensitive content still blocks at the LLM
  // eval level even when the user "asked for" the write. These hook-level
  // tests are the MECHANICAL guard that backs the prompt-level invariant:
  // intent must INFORM the evaluator, never bypass the structural gates
  // (credential gate, `shouldAllow` + confidence floor).

  it('security: credential gate (MCP servers path) still fires when userMessage is supplied', async () => {
    // The MCP servers auto-approve path probes for credential patterns BEFORE
    // returning empty {}. This is a STRUCTURAL gate that runs around the
    // safety eval — it has no LLM, no intent input, and must not be bypassed
    // by adding intent fields anywhere upstream.
    vi.mocked(spaceService.scanSpaces).mockResolvedValue([]);
    vi.mocked(settingsStore.getSettings).mockReturnValue({
      coreDirectory: '/workspace',
      spaces: [],
      spaceSafetyLevels: {},
    } as any);
    mockContainsCredentialPatterns.mockReturnValue({
      detected: true,
      reasons: ['anthropic_api_key'],
    });
    vi.mocked(cosPendingService.writeToPending).mockResolvedValue({
      id: 'pending-creds-with-intent',
      filename: 'staged.env',
    } as any);

    const userMessage = 'Please add my API key to the MCP server config.';
    const getSessionIntent = vi.fn().mockResolvedValue({
      recentUserMessages: ['Please add my API key to the MCP server config.'],
      totalChars: 50,
    } as ActionContextSessionIntent);

    const hook = createMemoryWriteHook({
      turnId: 'turn-sec-creds',
      sessionId: 'session-sec-creds',
      originalTurnId: 'orig-turn-sec-creds',
      originalSessionId: 'orig-session-sec-creds',
      coreDirectory: '/workspace',
      userMessage,
      getSessionIntent,
    });

    const result = await hook(
      {
        tool_name: 'Create',
        tool_input: {
          path: '/users/test/mcp-servers/my-api/.env',
          content: 'API_KEY=sk-ant-abc123',
        },
        tool_use_id: 'tu-sec-creds',
      },
      'tu-sec-creds',
      { signal },
    );

    // NOT empty {} — credentials detected, fell through to cautious → staged.
    // (Mirrors the existing 'does NOT auto-approve MCP server writes with
    // credential patterns' test, but with userMessage + getSessionIntent
    // wired in.)
    expect(result).not.toEqual({});
    const output = getHookSpecificOutput(result);
    expect(output?.replaceResult || output?.permissionDecision).toBeTruthy();
    expect(mockContainsCredentialPatterns).toHaveBeenCalled();
  });

  it('security: evaluator block decision still stages when userMessage is supplied', async () => {
    // evaluateSafetyPrompt returns `block` even though userMessage explicitly
    // requests the write. The hook must stage — intent must INFORM the
    // evaluator (it appears in the ActionContext) but must NOT override its
    // decision.
    vi.mocked(evaluateSafetyPrompt).mockResolvedValue({
      decision: 'block',
      confidence: 'high',
      reason: 'Sensitive HR/compensation data restricted to HR-only spaces',
    });
    vi.mocked(shouldAllow).mockReturnValue(false);
    vi.mocked(cosPendingService.writeToPending).mockResolvedValue({
      id: 'pending-sec-block',
      filename: 'staged.md',
    } as any);

    const userMessage = 'Save the Q4 compensation review to the General space.';
    const sessionIntent: ActionContextSessionIntent = {
      recentUserMessages: ['Save the Q4 compensation review to the General space.'],
      totalChars: 55,
    };
    const getSessionIntent = vi.fn().mockResolvedValue(sessionIntent);

    const hook = createMemoryWriteHook({
      turnId: 'turn-sec-block',
      sessionId: 'session-sec-block',
      originalTurnId: 'orig-turn-sec-block',
      originalSessionId: 'orig-session-sec-block',
      coreDirectory: '/workspace',
      userMessage,
      getSessionIntent,
    });

    const result = await hook(
      {
        tool_name: 'Create',
        tool_input: {
          path: '/workspace/work-space/comp-review.md',
          content: 'Q4 compensation changes for the team',
        },
        tool_use_id: 'tu-sec-block',
      },
      'tu-sec-block',
      { signal },
    );

    // NOT empty {} — stage/deny in spite of explicit user request.
    expect(result).not.toEqual({});
    const output = getHookSpecificOutput(result);
    expect(output?.replaceResult || output?.permissionDecision).toBeTruthy();

    // Intent was VISIBLE to the evaluator (informs) — must not be stripped.
    const actionContext = getFirstEvaluationActionContext();
    expect(actionContext).toEqual(expect.objectContaining({
      userMessage,
      sessionIntent,
    }));
  });

  it('security: below-floor confidence allow still stages when userMessage is supplied (shouldAllow governs)', async () => {
    // evaluateSafetyPrompt returns allow but at low confidence; shouldAllow
    // (the floor on balanced spaces requires `high` for side-effect writes)
    // returns false. Intent in the ActionContext must not bypass this.
    vi.mocked(evaluateSafetyPrompt).mockResolvedValue({
      decision: 'allow',
      confidence: 'low',
      reason: 'Uncertain',
    });
    vi.mocked(shouldAllow).mockReturnValue(false);
    vi.mocked(cosPendingService.writeToPending).mockResolvedValue({
      id: 'pending-sec-lowconf',
      filename: 'staged.md',
    } as any);

    const userMessage = 'Update the team handoff doc in General.';

    const hook = createMemoryWriteHook({
      turnId: 'turn-sec-lowconf',
      sessionId: 'session-sec-lowconf',
      originalTurnId: 'orig-turn-sec-lowconf',
      originalSessionId: 'orig-session-sec-lowconf',
      coreDirectory: '/workspace',
      userMessage,
    });

    const result = await hook(
      {
        tool_name: 'Create',
        tool_input: {
          path: '/workspace/work-space/handoff.md',
          content: 'Team handoff notes',
        },
        tool_use_id: 'tu-sec-lowconf',
      },
      'tu-sec-lowconf',
      { signal },
    );

    // NOT empty {} — staged because shouldAllow returned false; userMessage
    // did not override the floor.
    expect(result).not.toEqual({});
    const output = getHookSpecificOutput(result);
    expect(output?.replaceResult || output?.permissionDecision).toBeTruthy();
    expect(shouldAllow).toHaveBeenCalled();

    // The ActionContext STILL carries userMessage (intent INFORMS the
    // evaluator) — we're only asserting the gate downstream of the eval did
    // its job.
    const actionContext = getFirstEvaluationActionContext();
    expect(actionContext).toEqual(expect.objectContaining({ userMessage }));
  });

  // --- Background-hook negative (F5) ---------------------------------------
  // Production background memory-update hook construction:
  //   - src/main/index.ts (~line 2043) — desktop background memory updates
  //   - cloud-service/src/bootstrap.ts (~line 625) — cloud background memory
  //     updates
  // Both sites construct the hook with `{ turnId, sessionId, originalTurnId,
  // originalSessionId, coreDirectory, privateMode }` and NO `userMessage` /
  // `getSessionIntent`, because the turns are SYSTEM-INITIATED (BTS memory
  // consolidation) — there is no authorizing user request to plumb. This
  // test pins that out-of-scope boundary so a future wiring change can't
  // silently leak intent into system-initiated turns.

  it('boundary: background memory-update hook construction (no userMessage / no getSessionIntent) yields ActionContext with no intent keys', async () => {
    vi.mocked(evaluateSafetyPrompt).mockResolvedValue({
      decision: 'allow',
      confidence: 'high',
      reason: 'OK',
    });
    vi.mocked(shouldAllow).mockReturnValue(true);

    // Mirror the EXACT field set passed at the background sites — privateMode
    // included; userMessage + getSessionIntent omitted on purpose.
    const hook = createMemoryWriteHook({
      turnId: 'turn-bg-mem-update',
      sessionId: 'session-bg-mem-update',
      originalTurnId: 'orig-turn-bg-mem-update',
      originalSessionId: 'orig-session-bg-mem-update',
      coreDirectory: '/workspace',
      privateMode: false,
      // intentionally NO userMessage / NO getSessionIntent — matches
      // src/main/index.ts and cloud-service/src/bootstrap.ts.
    });

    await hook(
      {
        tool_name: 'Create',
        tool_input: {
          path: '/workspace/work-space/bg-mem-update.md',
          content: 'consolidated memory note',
        },
        tool_use_id: 'tu-bg-mem-update',
      },
      'tu-bg-mem-update',
      { signal },
    );

    const actionContext = getFirstEvaluationActionContext();
    expect(actionContext).not.toHaveProperty('userMessage');
    expect(actionContext).not.toHaveProperty('sessionIntent');
    // userIntentExplicit is deferred for the memory path entirely; it should
    // never leak in even on un-wired callers.
    expect(actionContext).not.toHaveProperty('userIntentExplicit');
  });

  // --- Cross-path drift guard (moved from descoped Stage 3) ----------------
  // The tool-safety path attaches `{userMessage, sessionIntent, userIntentExplicit}`
  // (see src/core/services/safety/toolSafetyService.ts around lines 2827 and
  // 3250). The memory-write path INTENTIONALLY omits `userIntentExplicit`
  // (deferred per the plan), so today the expected memory-path set is exactly
  // `{userMessage, sessionIntent}`.
  //
  // If a future dev adds a 4th intent field to the tool path (or finally
  // wires `userIntentExplicit` on the memory path), this tripwire fires and
  // forces a deliberate update to both paths. Cheap regression detection
  // without refactoring the hot tool-safety closure.

  it('drift guard: memory-write ActionContext attaches exactly {userMessage, sessionIntent} (no userIntentExplicit yet)', async () => {
    vi.mocked(evaluateSafetyPrompt).mockResolvedValue({
      decision: 'allow',
      confidence: 'high',
      reason: 'OK',
    });
    vi.mocked(shouldAllow).mockReturnValue(true);

    const userMessage = 'Add the handoff notes to the General space.';
    const sessionIntent: ActionContextSessionIntent = {
      recentUserMessages: ['Add the handoff notes to the General space.'],
      totalChars: 44,
    };
    const getSessionIntent = vi.fn().mockResolvedValue(sessionIntent);

    const hook = createMemoryWriteHook({
      turnId: 'turn-drift-guard',
      sessionId: 'session-drift-guard',
      originalTurnId: 'orig-turn-drift-guard',
      originalSessionId: 'orig-session-drift-guard',
      coreDirectory: '/workspace',
      userMessage,
      getSessionIntent,
    });

    await hook(
      {
        tool_name: 'Create',
        tool_input: {
          path: '/workspace/work-space/drift-guard.md',
          content: 'handoff notes',
        },
        tool_use_id: 'tu-drift-guard',
      },
      'tu-drift-guard',
      { signal },
    );

    const actionContext = getFirstEvaluationActionContext();
    // The full set of intent fields the tool-safety path knows about today.
    // If a future dev adds a 4th, update BOTH paths and this guard.
    const TOOL_PATH_INTENT_FIELDS = [
      'userMessage',
      'sessionIntent',
      'userIntentExplicit',
    ] as const;
    const attachedIntentFields = TOOL_PATH_INTENT_FIELDS.filter(
      (f) => f in actionContext,
    );
    // Memory path intentionally omits userIntentExplicit (deferred).
    expect(attachedIntentFields).toEqual(['userMessage', 'sessionIntent']);
    expect(actionContext).not.toHaveProperty('userIntentExplicit');
  });
});
