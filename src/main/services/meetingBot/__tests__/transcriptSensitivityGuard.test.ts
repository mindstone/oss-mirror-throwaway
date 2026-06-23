import { describe, it, expect, vi, beforeEach } from 'vitest';
import { evaluateTranscriptForSharedSpace } from '../transcriptSensitivityGuard';

// Mock dependencies
vi.mock('../../safety/memoryWriteHook', () => ({
  normalizeSharing: vi.fn((sharing: string | undefined) => {
    if (sharing === 'team') return 'restricted';
    if (sharing === 'private' || sharing === 'restricted' || sharing === 'company-wide' || sharing === 'public') {
      return sharing;
    }
    return undefined;
  }),
  isVerifiedChiefOfStaff: vi.fn(() => false),
  resolveMemorySafetyLevel: vi.fn(() => ({ level: 'balanced', hasSpaceOverride: false })),
  summarizeContent: vi.fn(() => 'Meeting transcript summary'),
}));

vi.mock('@core/safetyPromptLogic', () => ({
  evaluateSafetyPrompt: vi.fn(() => ({ decision: 'allow', confidence: 'high', reason: 'Allowed by safety rules' })),
  shouldAllow: vi.fn(() => true),
}));

vi.mock('@core/safetyPromptStore', () => ({
  getSafetyPrompt: vi.fn(() => '# Safety Principles\n\n## Memory\n- Allow writes to personal spaces.'),
  getSafetyPromptVersion: vi.fn(() => 1),
  isMigrationComplete: vi.fn(() => true),
}));

vi.mock('@core/services/settingsStore', () => ({
  setSettingsStoreAdapter: vi.fn(),
  getSettings: vi.fn(() => ({
    coreDirectory: '/workspace',
    spaceSafetyLevels: {},
    spaces: [],
    claude: {},
  })),
}));

vi.mock('../../../utils/authEnvUtils', () => ({
  hasValidAuth: vi.fn(() => true),
}));

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
  },
}));

// Import mocked modules for assertion access
import {
  normalizeSharing,
  isVerifiedChiefOfStaff,
  resolveMemorySafetyLevel,
  summarizeContent,
} from '../../safety/memoryWriteHook';
import { evaluateSafetyPrompt, shouldAllow } from '@core/safetyPromptLogic';
import { isMigrationComplete } from '@core/safetyPromptStore';
import { hasValidAuth } from '../../../utils/authEnvUtils';

const mockedNormalizeSharing = vi.mocked(normalizeSharing);
const mockedIsVerifiedChiefOfStaff = vi.mocked(isVerifiedChiefOfStaff);
const mockedResolveMemorySafetyLevel = vi.mocked(resolveMemorySafetyLevel);
const mockedEvaluateSafetyPrompt = vi.mocked(evaluateSafetyPrompt);
const mockedShouldAllow = vi.mocked(shouldAllow);
const mockedIsMigrationComplete = vi.mocked(isMigrationComplete);
const mockedSummarizeContent = vi.mocked(summarizeContent);
const mockedHasValidAuth = vi.mocked(hasValidAuth);

const TRANSCRIPT = 'Meeting transcript content for testing purposes.';
const CORE_DIR = '/workspace';

function makeTargetSpace(overrides: Partial<{
  spacePath: string;
  absolutePath: string;
  sharing: string;
  spaceName: string;
  description: string;
}> = {}) {
  return {
    spacePath: overrides.spacePath ?? 'work/Mindstone/General',
    absolutePath: overrides.absolutePath ?? '/workspace/work/Mindstone/General',
    sharing: overrides.sharing ?? 'restricted',
    spaceName: overrides.spaceName ?? 'Mindstone General',
    description: overrides.description ?? 'Team workspace',
  };
}

describe('evaluateTranscriptForSharedSpace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-establish defaults after clearAllMocks
    mockedNormalizeSharing.mockImplementation((sharing: string | undefined) => {
      if (sharing === 'team') return 'restricted';
      if (sharing === 'private' || sharing === 'restricted' || sharing === 'company-wide' || sharing === 'public') {
        return sharing;
      }
      return undefined;
    });
    mockedIsVerifiedChiefOfStaff.mockReturnValue(false);
    mockedResolveMemorySafetyLevel.mockReturnValue({ level: 'balanced', hasSpaceOverride: false });
    mockedEvaluateSafetyPrompt.mockResolvedValue({ decision: 'allow', confidence: 'high', reason: 'Allowed by safety rules' });
    mockedShouldAllow.mockReturnValue(true);
    mockedIsMigrationComplete.mockReturnValue(true);
    mockedSummarizeContent.mockResolvedValue('Meeting transcript summary');
    mockedHasValidAuth.mockReturnValue(true);
  });

  it('allows save to private space', async () => {
    const target = makeTargetSpace({ sharing: 'private' });
    const result = await evaluateTranscriptForSharedSpace(TRANSCRIPT, target, CORE_DIR);

    expect(result.decision).toBe('allow');
    expect(mockedResolveMemorySafetyLevel).not.toHaveBeenCalled();
    expect(mockedEvaluateSafetyPrompt).not.toHaveBeenCalled();
  });

  it('allows save to verified Chief-of-Staff space', async () => {
    mockedIsVerifiedChiefOfStaff.mockReturnValue(true);
    const target = makeTargetSpace({ sharing: 'restricted' });
    const result = await evaluateTranscriptForSharedSpace(TRANSCRIPT, target, CORE_DIR);

    expect(result.decision).toBe('allow');
    expect(mockedIsVerifiedChiefOfStaff).toHaveBeenCalled();
    expect(mockedEvaluateSafetyPrompt).not.toHaveBeenCalled();
  });

  it('allows save when safety level is permissive', async () => {
    mockedResolveMemorySafetyLevel.mockReturnValue({ level: 'permissive', hasSpaceOverride: false });
    const target = makeTargetSpace();
    const result = await evaluateTranscriptForSharedSpace(TRANSCRIPT, target, CORE_DIR);

    expect(result.decision).toBe('allow');
    expect(mockedEvaluateSafetyPrompt).not.toHaveBeenCalled();
  });

  it('allows save when balanced and safety prompt allows', async () => {
    mockedEvaluateSafetyPrompt.mockResolvedValue({ decision: 'allow', confidence: 'high', reason: 'Standard content' });
    mockedShouldAllow.mockReturnValue(true);
    const target = makeTargetSpace();
    const result = await evaluateTranscriptForSharedSpace(TRANSCRIPT, target, CORE_DIR);

    expect(result.decision).toBe('allow');
    expect(mockedEvaluateSafetyPrompt).toHaveBeenCalled();
    // Verify ActionContext uses memory_create for correct side-effect classification
    const callArgs = mockedEvaluateSafetyPrompt.mock.calls[0];
    expect(callArgs[2]).toMatchObject({
      toolName: 'memory_create',
      sessionType: 'automation',
      toolInput: expect.objectContaining({
        spaceName: 'Mindstone General',
        sharing: 'restricted',
      }),
    });
    // summarizeContent should NOT be called on the happy path
    expect(mockedSummarizeContent).not.toHaveBeenCalled();
  });

  it('stages when balanced and safety prompt blocks', async () => {
    mockedEvaluateSafetyPrompt.mockResolvedValue({
      decision: 'block',
      confidence: 'high',
      reason: 'Contains sensitive HR information',
    });
    mockedShouldAllow.mockReturnValue(false);
    const target = makeTargetSpace();
    const result = await evaluateTranscriptForSharedSpace(TRANSCRIPT, target, CORE_DIR);

    expect(result.decision).toBe('stage');
    expect(result.reason).toBe('Contains sensitive HR information');
    expect(result.summary).toBe('Meeting transcript summary');
    expect(mockedSummarizeContent).toHaveBeenCalledWith(TRANSCRIPT);
  });

  it('stages when balanced and evaluation throws', async () => {
    mockedEvaluateSafetyPrompt.mockRejectedValue(new Error('LLM timeout'));
    const target = makeTargetSpace();
    const result = await evaluateTranscriptForSharedSpace(TRANSCRIPT, target, CORE_DIR);

    expect(result.decision).toBe('stage');
    expect(result.reason).toBe('Safety evaluation failed');
    expect(result.summary).toBe('Meeting transcript summary');
  });

  it('stages when safety migration is incomplete', async () => {
    mockedIsMigrationComplete.mockReturnValue(false);
    const target = makeTargetSpace();
    const result = await evaluateTranscriptForSharedSpace(TRANSCRIPT, target, CORE_DIR);

    expect(result.decision).toBe('stage');
    expect(result.reason).toBe('Safety system initializing');
    expect(result.summary).toBe('Meeting transcript summary');
    // Should not attempt safety eval when migration incomplete
    expect(mockedEvaluateSafetyPrompt).not.toHaveBeenCalled();
  });

  it('stages when cautious mode', async () => {
    mockedResolveMemorySafetyLevel.mockReturnValue({ level: 'cautious', hasSpaceOverride: false });
    const target = makeTargetSpace();
    const result = await evaluateTranscriptForSharedSpace(TRANSCRIPT, target, CORE_DIR);

    expect(result.decision).toBe('stage');
    expect(result.reason).toBe('Cautious mode requires approval for all transcript saves to shared spaces');
    expect(result.summary).toBe('Meeting transcript summary');
    expect(mockedSummarizeContent).toHaveBeenCalledWith(TRANSCRIPT);
    // Should not call safety prompt evaluation in cautious mode
    expect(mockedEvaluateSafetyPrompt).not.toHaveBeenCalled();
  });

  it('stages when no auth available', async () => {
    mockedHasValidAuth.mockReturnValue(false);
    const target = makeTargetSpace();
    const result = await evaluateTranscriptForSharedSpace(TRANSCRIPT, target, CORE_DIR);

    expect(result.decision).toBe('stage');
    expect(result.reason).toBe('No auth available for sensitivity evaluation');
    expect(mockedEvaluateSafetyPrompt).not.toHaveBeenCalled();
    expect(mockedSummarizeContent).not.toHaveBeenCalled();
  });

  it('uses spacePath as fallback when spaceName is undefined', async () => {
    const target = {
      spacePath: 'work/Mindstone/General',
      absolutePath: '/workspace/work/Mindstone/General',
      sharing: 'restricted' as const,
      // spaceName intentionally omitted
      description: 'Team workspace',
    };
    await evaluateTranscriptForSharedSpace(TRANSCRIPT, target, CORE_DIR);

    const callArgs = mockedEvaluateSafetyPrompt.mock.calls[0];
    expect(callArgs[2]).toMatchObject({
      toolInput: expect.objectContaining({
        spaceName: 'work/Mindstone/General', // Falls back to spacePath
      }),
    });
  });

  // Regression: sharing defaulting to 'private' when frontmatter omits sharing field.
  // Before fix, determineTargetSpace() returned sharing: undefined → bypassed
  // the private-space fast-path → fell to LLM eval → staged → event never fired.
  // Callers now always provide sharing via `?? 'private'` default.
  it('allows save when sharing defaults to private (regression for undefined sharing bug)', async () => {
    const target = makeTargetSpace({ sharing: 'private', spacePath: 'Chief-of-Staff' });
    const result = await evaluateTranscriptForSharedSpace(TRANSCRIPT, target, CORE_DIR);

    expect(result.decision).toBe('allow');
    expect(mockedNormalizeSharing).toHaveBeenCalledWith('private');
    expect(mockedResolveMemorySafetyLevel).not.toHaveBeenCalled();
    expect(mockedEvaluateSafetyPrompt).not.toHaveBeenCalled();
  });
});
