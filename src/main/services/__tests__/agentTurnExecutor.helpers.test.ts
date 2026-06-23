import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { buildSettings } from '@core/__tests__/builders';
import { AUTO_ABORT_MS } from '../watchdogTracker';
import {
  appendCompletedToolThisTurn,
  applyWatchdogJudgeResult,
  buildSpaceInfosFromSettings,
  derivePerConversationModelOverride,
  extractSemanticContextFiles,
  formatSuggestedSkillsContext,
  resolveActiveProfileForTurn,
  resolveWatchdogJudgeCeiling,
  resolveWatchdogMessageTimeoutMs,
  shouldAbortForAutomationHardCeiling,
  shouldApplyWatchdogJudgeResolution,
  shouldEmitWatchdogEscalationSideEffects,
  shouldFireWatchdogJudge,
  formatWatchdogJudgeAbortMessage,
  AUTOMATION_HARD_CEILING_MS,
} from '../agentTurnExecutor';

// ---------------------------------------------------------------------------
// buildSpaceInfosFromSettings
// ---------------------------------------------------------------------------
describe('buildSpaceInfosFromSettings', () => {
  it('maps spaces into SpaceInfo records with correct absolutePath', () => {
    const settings = buildSettings({
      coreDirectory: '/home/user/workspace',
      spaces: [
        {
          name: 'Chief-of-Staff',
          path: 'Chief-of-Staff',
          type: 'chief-of-staff',
          isSymlink: false,
          hasReadme: true,
          createdAt: Date.now(),
          sharing: 'private',
        },
        {
          name: 'Marketing',
          path: 'work/Acme/Marketing',
          type: 'company',
          isSymlink: false,
          hasReadme: false,
          createdAt: Date.now(),
          sharing: 'company-wide',
        },
      ],
    });

    const result = buildSpaceInfosFromSettings(settings);

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      name: 'Chief-of-Staff',
      path: 'Chief-of-Staff',
      type: 'chief-of-staff',
      isSymlink: false,
      hasReadme: true,
      sharing: 'private',
    });
    expect(result[0].absolutePath).toBe(path.join('/home/user/workspace', 'Chief-of-Staff'));

    expect(result[1]).toMatchObject({
      name: 'Marketing',
      path: 'work/Acme/Marketing',
      type: 'company',
      isSymlink: false,
      hasReadme: false,
      sharing: 'company-wide',
    });
    expect(result[1].absolutePath).toBe(path.join('/home/user/workspace', 'work/Acme/Marketing'));
  });

  it('returns empty array when no workspace spaces exist', () => {
    const settings = buildSettings({ coreDirectory: '/home/user/workspace', spaces: [] });
    expect(buildSpaceInfosFromSettings(settings)).toEqual([]);
  });

  it('returns empty array when spaces is undefined', () => {
    const settings = buildSettings({ coreDirectory: '/home/user/workspace', spaces: undefined });
    expect(buildSpaceInfosFromSettings(settings)).toEqual([]);
  });

  it('handles spaces with sourcePath (symlinks)', () => {
    const settings = buildSettings({
      coreDirectory: '/home/user/workspace',
      spaces: [
        {
          name: 'Shared Drive',
          path: 'work/SharedDrive',
          type: 'company',
          isSymlink: true,
          sourcePath: '/Volumes/GoogleDrive/SharedDrive',
          hasReadme: true,
          createdAt: Date.now(),
          sharing: 'restricted',
        },
      ],
    });

    const result = buildSpaceInfosFromSettings(settings);

    expect(result).toHaveLength(1);
    expect(result[0].isSymlink).toBe(true);
    expect(result[0].type).toBe('company');
    expect(result[0].sharing).toBe('restricted');
  });
});

// ---------------------------------------------------------------------------
// extractSemanticContextFiles
// ---------------------------------------------------------------------------
describe('extractSemanticContextFiles', () => {
  it('returns empty array for undefined input', () => {
    expect(extractSemanticContextFiles(undefined)).toEqual([]);
  });

  it('returns empty array for empty array input', () => {
    expect(extractSemanticContextFiles([])).toEqual([]);
  });

  it('preserves file order and scores', () => {
    const input = [
      { relativePath: 'docs/guide.md', score: 0.92 },
      { relativePath: 'src/utils.ts', score: 0.85 },
      { relativePath: 'README.md', score: 0.78 },
    ];

    const result = extractSemanticContextFiles(input);

    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ relativePath: 'docs/guide.md', score: 0.92 });
    expect(result[1]).toEqual({ relativePath: 'src/utils.ts', score: 0.85 });
    expect(result[2]).toEqual({ relativePath: 'README.md', score: 0.78 });
  });
});

// ---------------------------------------------------------------------------
// formatSuggestedSkillsContext
// ---------------------------------------------------------------------------
describe('formatSuggestedSkillsContext', () => {
  it('returns undefined for empty input', () => {
    expect(formatSuggestedSkillsContext([])).toBeUndefined();
  });

  it('renders numbered markdown with match percentages and descriptions', () => {
    const skills = [
      {
        relativePath: 'skills/email-triage/SKILL.md',
        skillName: 'Email Triage',
        description: 'Helps sort and prioritize incoming emails.',
        score: 0.91,
      },
      {
        relativePath: 'skills/meeting-prep/SKILL.md',
        skillName: 'Meeting Prep',
        description: 'Prepares agendas and background research for meetings.',
        score: 0.83,
      },
    ];

    const result = formatSuggestedSkillsContext(skills);

    expect(result).toBeDefined();
    expect(result).toContain('<suggested-skills>');
    expect(result).toContain('</suggested-skills>');
    expect(result).toContain('## Potentially Relevant Skills');

    // Check numbered entries
    expect(result).toContain('1. **Email Triage** (91% match)');
    expect(result).toContain('Path: `skills/email-triage/SKILL.md`');
    expect(result).toContain('Helps sort and prioritize incoming emails.');

    expect(result).toContain('2. **Meeting Prep** (83% match)');
    expect(result).toContain('Path: `skills/meeting-prep/SKILL.md`');
    expect(result).toContain('Prepares agendas and background research for meetings.');
  });
});

// ---------------------------------------------------------------------------
// Stage 4 watchdog judge helpers
// ---------------------------------------------------------------------------
describe('watchdog judge helpers', () => {
  it('resolveWatchdogJudgeCeiling clears extension once no active tool/subagent remains (F7)', () => {
    const resolved = resolveWatchdogJudgeCeiling({
      state: {
        extendedCeilingMs: 3_600_000,
        priorExtensionCount: 1,
        consecutiveFailOpenCount: 0,
        boundToolUseId: 'toolu_1',
        boundToolName: 'mcp.web.search',
        boundHasActiveSubagent: false,
      },
      baseCeilingMs: AUTO_ABORT_MS,
      activeToolUseId: undefined,
      activeToolName: undefined,
      hasActiveSubagent: false,
    });

    expect(resolved.extensionApplies).toBe(false);
    expect(resolved.effectiveCeilingMs).toBe(AUTO_ABORT_MS);
    expect(resolved.state.extendedCeilingMs).toBeUndefined();
    expect(resolved.state.boundToolUseId).toBeUndefined();
    expect(resolved.state.boundToolName).toBeUndefined();
  });

  it('resolveWatchdogJudgeCeiling clears extension when bound tool is replaced by a new tool (F7)', () => {
    // Tool A finished and Tool B started. The judge granted the extension for
    // Tool A; it must NOT silently carry over to Tool B.
    const resolved = resolveWatchdogJudgeCeiling({
      state: {
        extendedCeilingMs: 3_600_000,
        priorExtensionCount: 1,
        consecutiveFailOpenCount: 0,
        boundToolUseId: 'toolu_A',
        boundToolName: 'DeepResearchPaper',
        boundHasActiveSubagent: false,
      },
      baseCeilingMs: AUTO_ABORT_MS,
      activeToolUseId: 'toolu_B',
      activeToolName: 'Bash',
      hasActiveSubagent: false,
    });

    expect(resolved.extensionApplies).toBe(false);
    expect(resolved.effectiveCeilingMs).toBe(AUTO_ABORT_MS);
    expect(resolved.state.extendedCeilingMs).toBeUndefined();
    expect(resolved.state.boundToolUseId).toBeUndefined();
  });

  it('resolveWatchdogJudgeCeiling preserves extension when bound tool is still active (F7)', () => {
    const resolved = resolveWatchdogJudgeCeiling({
      state: {
        extendedCeilingMs: 3_600_000,
        priorExtensionCount: 1,
        consecutiveFailOpenCount: 0,
        boundToolUseId: 'toolu_A',
        boundToolName: 'DeepResearchPaper',
        boundHasActiveSubagent: false,
      },
      baseCeilingMs: AUTO_ABORT_MS,
      activeToolUseId: 'toolu_A',
      activeToolName: 'DeepResearchPaper',
      hasActiveSubagent: false,
    });

    expect(resolved.extensionApplies).toBe(true);
    expect(resolved.effectiveCeilingMs).toBe(3_600_000);
    expect(resolved.state.extendedCeilingMs).toBe(3_600_000);
    expect(resolved.state.boundToolUseId).toBe('toolu_A');
  });

  it('shouldFireWatchdogJudge fires only in the pre-ceiling window and only when judge is idle', () => {
    expect(shouldFireWatchdogJudge({
      baseCeilingMs: AUTO_ABORT_MS,
      effectiveCeilingMs: 30 * 60_000,
      silentMs: 25 * 60_000,
      judgeInFlight: false,
    })).toBe(true);

    expect(shouldFireWatchdogJudge({
      baseCeilingMs: AUTO_ABORT_MS,
      effectiveCeilingMs: 30 * 60_000,
      silentMs: 24 * 60_000 + 59_000,
      judgeInFlight: false,
    })).toBe(false);

    expect(shouldFireWatchdogJudge({
      baseCeilingMs: AUTO_ABORT_MS,
      effectiveCeilingMs: 30 * 60_000,
      silentMs: 29 * 60_000,
      judgeInFlight: true,
    })).toBe(false);
  });

  it('applyWatchdogJudgeResult records extension state and diagnostics for extend', () => {
    const applied = applyWatchdogJudgeResult({
      state: {
        extendedCeilingMs: undefined,
        priorExtensionCount: 0,
        consecutiveFailOpenCount: 1,
        boundToolUseId: undefined,
        boundToolName: undefined,
        boundHasActiveSubagent: false,
      },
      judgeResult: { kind: 'extend', additionalMs: 900_000, reason: 'long upload' },
      extensionBaseMs: 1_200_000,
      elapsedMs: 1_800_000,
      silentMs: 1_200_000,
      toolName: 'mcp.drive.upload',
      boundToolUseId: 'toolu_upload',
      boundHasActiveSubagent: false,
    });

    expect(applied.killReason).toBeUndefined();
    expect(applied.state.extendedCeilingMs).toBe(2_100_000);
    expect(applied.state.priorExtensionCount).toBe(1);
    expect(applied.state.consecutiveFailOpenCount).toBe(0);
    expect(applied.decisionDiagnostic).toMatchObject({
      decision: 'extended',
      additionalMs: 900_000,
      priorExtensionCount: 1,
      elapsedMs: 1_800_000,
      silentMs: 1_200_000,
      toolName: 'mcp.drive.upload',
    });
  });

  it('applyWatchdogJudgeResult kills on explicit kill or third consecutive fail-open', () => {
    const explicitKill = applyWatchdogJudgeResult({
      state: {
        extendedCeilingMs: undefined,
        priorExtensionCount: 1,
        consecutiveFailOpenCount: 0,
        boundToolUseId: undefined,
        boundToolName: undefined,
        boundHasActiveSubagent: false,
      },
      judgeResult: { kind: 'kill', reason: 'tool appears wedged' },
      extensionBaseMs: 1_200_000,
      elapsedMs: 1_800_000,
      silentMs: 1_200_000,
      toolName: 'mcp.web.search',
      boundToolUseId: 'toolu_1',
      boundHasActiveSubagent: false,
    });
    expect(explicitKill.killReason).toBe('judge_killed');

    // F11: 2nd consecutive fail-open extends with diagnostic, does NOT kill.
    const secondFailOpen = applyWatchdogJudgeResult({
      state: {
        extendedCeilingMs: 1_900_000,
        priorExtensionCount: 1,
        consecutiveFailOpenCount: 1,
        boundToolUseId: 'toolu_1',
        boundToolName: 'mcp.web.search',
        boundHasActiveSubagent: false,
      },
      judgeResult: {
        kind: 'failed_extended',
        additionalMs: 600_000,
        cause: 'timeout',
        errorMessage: 'judge timeout',
      },
      extensionBaseMs: 1_300_000,
      elapsedMs: 1_950_000,
      silentMs: 1_300_000,
      toolName: 'mcp.web.search',
      boundToolUseId: 'toolu_1',
      boundHasActiveSubagent: false,
    });
    expect(secondFailOpen.killReason).toBeUndefined();
    expect(secondFailOpen.decisionDiagnostic?.decision).toBe('failed_extended');
    expect(secondFailOpen.decisionDiagnostic?.cause).toBe('timeout');
    expect(secondFailOpen.decisionDiagnostic?.errorMessage).toBe('judge timeout');
    expect(secondFailOpen.state.consecutiveFailOpenCount).toBe(2);

    // F11: 3rd consecutive fail-open hits the cap and triggers kill.
    const thirdFailOpen = applyWatchdogJudgeResult({
      state: {
        extendedCeilingMs: 1_900_000,
        priorExtensionCount: 1,
        consecutiveFailOpenCount: 2,
        boundToolUseId: 'toolu_1',
        boundToolName: 'mcp.web.search',
        boundHasActiveSubagent: false,
      },
      judgeResult: {
        kind: 'failed_extended',
        additionalMs: 600_000,
        cause: 'timeout',
        errorMessage: 'judge timeout',
      },
      extensionBaseMs: 1_400_000,
      elapsedMs: 2_050_000,
      silentMs: 1_400_000,
      toolName: 'mcp.web.search',
      boundToolUseId: 'toolu_1',
      boundHasActiveSubagent: false,
    });
    expect(thirdFailOpen.killReason).toBe('consecutive_fail_open_cap');
    expect(thirdFailOpen.decisionDiagnostic?.decision).toBe('failed_extended');
    expect(thirdFailOpen.decisionDiagnostic?.errorMessage).toBe('judge timeout');
    expect(thirdFailOpen.state.consecutiveFailOpenCount).toBe(3);
  });

  it('applyWatchdogJudgeResult resets consecutiveFailOpenCount on successful extend or kill', () => {
    const extendAfterFails = applyWatchdogJudgeResult({
      state: {
        extendedCeilingMs: 1_900_000,
        priorExtensionCount: 1,
        consecutiveFailOpenCount: 2,
        boundToolUseId: 'toolu_1',
        boundToolName: 'mcp.web.search',
        boundHasActiveSubagent: false,
      },
      judgeResult: { kind: 'extend', additionalMs: 900_000, reason: 'tool appears active' },
      extensionBaseMs: 1_400_000,
      elapsedMs: 2_000_000,
      silentMs: 1_400_000,
      toolName: 'mcp.web.search',
      boundToolUseId: 'toolu_1',
      boundHasActiveSubagent: false,
    });
    expect(extendAfterFails.state.consecutiveFailOpenCount).toBe(0);

    const killAfterFails = applyWatchdogJudgeResult({
      state: {
        extendedCeilingMs: 1_900_000,
        priorExtensionCount: 1,
        consecutiveFailOpenCount: 2,
        boundToolUseId: 'toolu_1',
        boundToolName: 'mcp.web.search',
        boundHasActiveSubagent: false,
      },
      judgeResult: { kind: 'kill', reason: 'tool wedged' },
      extensionBaseMs: 1_400_000,
      elapsedMs: 2_000_000,
      silentMs: 1_400_000,
      toolName: 'mcp.web.search',
      boundToolUseId: 'toolu_1',
      boundHasActiveSubagent: false,
    });
    expect(killAfterFails.state.consecutiveFailOpenCount).toBe(0);
  });

  it('shouldApplyWatchdogJudgeResolution gates on both signal and turn completion', () => {
    const liveSignal = new AbortController().signal;
    expect(shouldApplyWatchdogJudgeResolution(liveSignal)).toBe(true);
    expect(shouldApplyWatchdogJudgeResolution(liveSignal, false)).toBe(true);
    expect(shouldApplyWatchdogJudgeResolution(liveSignal, true)).toBe(false);

    const aborted = new AbortController();
    aborted.abort();
    expect(shouldApplyWatchdogJudgeResolution(aborted.signal)).toBe(false);
    expect(shouldApplyWatchdogJudgeResolution(aborted.signal, false)).toBe(false);
  });

  it('enforces automation hard ceiling and helper pass-throughs', () => {
    expect(
      shouldAbortForAutomationHardCeiling(AUTOMATION_HARD_CEILING_MS, AUTOMATION_HARD_CEILING_MS),
    ).toBe(true);
    expect(
      shouldAbortForAutomationHardCeiling(AUTOMATION_HARD_CEILING_MS, AUTOMATION_HARD_CEILING_MS - 60_000),
    ).toBe(false);
    expect(shouldAbortForAutomationHardCeiling(null, 10 * 60_000_000)).toBe(false);

    expect(resolveWatchdogMessageTimeoutMs(undefined)).toBe(AUTO_ABORT_MS);
    expect(resolveWatchdogMessageTimeoutMs(1_234_567)).toBe(1_234_567);

    expect(shouldEmitWatchdogEscalationSideEffects(true)).toBe(true);
    expect(shouldEmitWatchdogEscalationSideEffects(false)).toBe(false);

    const controller = new AbortController();
    expect(shouldApplyWatchdogJudgeResolution(controller.signal)).toBe(true);
    controller.abort();
    expect(shouldApplyWatchdogJudgeResolution(controller.signal)).toBe(false);
  });

  it('appendCompletedToolThisTurn enforces a bounded history', () => {
    const entries = [
      { name: 'a', success: true, durationMs: 10 },
      { name: 'b', success: true, durationMs: 20 },
    ];
    appendCompletedToolThisTurn(entries, { name: 'c', success: false, durationMs: 30 }, 2);
    expect(entries).toEqual([
      { name: 'b', success: true, durationMs: 20 },
      { name: 'c', success: false, durationMs: 30 },
    ]);
  });

  describe('formatWatchdogJudgeAbortMessage', () => {
    it('returns consecutive cap copy regardless of elapsed time', () => {
      expect(formatWatchdogJudgeAbortMessage('consecutive_fail_open_cap', 1000, false)).toBe(
        "Couldn't reach the time check after several attempts. Stopping this turn — you can try sending the message again."
      );
    });

    it('returns repeat tool-cancel cap copy regardless of elapsed time', () => {
      expect(formatWatchdogJudgeAbortMessage('tool_cancelled_cap', 1000, false)).toBe(
        'This tool kept getting stuck, so this turn was stopped automatically. Try sending the message again.'
      );
    });

    it('returns non-responsive tool-cancel copy regardless of elapsed time', () => {
      expect(formatWatchdogJudgeAbortMessage('tool_cancel_unresponsive', 1000, false)).toBe(
        "This tool couldn't be stopped cleanly, so this turn was stopped automatically. Try sending the message again."
      );
    });

    it('reuses the cap copy for the A15 tool_repeated_timeout reason (subagent timeout cap)', () => {
      expect(formatWatchdogJudgeAbortMessage('tool_repeated_timeout', 1000, false)).toBe(
        'This tool kept getting stuck, so this turn was stopped automatically. Try sending the message again.'
      );
    });

    it('returns automation hard cap copy when isAutomationHardCap is true', () => {
      expect(
        formatWatchdogJudgeAbortMessage('watchdog', AUTOMATION_HARD_CEILING_MS, true)
      ).toBe('Automation turn reached its 90-minute limit and was stopped.');
    });

    it('does NOT return automation copy for an interactive turn that happens to elapse 90+ minutes', () => {
      // Regression: previously `elapsedMs >= AUTOMATION_HARD_CEILING_MS` alone
      // could mis-flag long interactive turns as automation kills.
      expect(
        formatWatchdogJudgeAbortMessage('judge_killed', AUTOMATION_HARD_CEILING_MS, false)
      ).toBe(
        'This turn went silent for over 90 minutes and was stopped automatically. Try sending the message again.'
      );
    });

    it('returns judge killed copy with elapsed-since-turn-start minutes', () => {
      expect(formatWatchdogJudgeAbortMessage('judge_killed', 45 * 60_000, false)).toBe(
        'This turn went silent for over 45 minutes and was stopped automatically. Try sending the message again.'
      );
    });

    it('returns default fallback copy for plain watchdog reason', () => {
      expect(formatWatchdogJudgeAbortMessage('watchdog', 30 * 60_000, false)).toBe(
        'This turn was unresponsive for 30 minutes and was stopped automatically. You can try sending your message again.'
      );
    });
  });
});

// ---------------------------------------------------------------------------
// derivePerConversationModelOverride
// ---------------------------------------------------------------------------
describe('derivePerConversationModelOverride', () => {
  const defaultProfile = { id: 'default-profile' };

  it('returns false when turnOptions is undefined (no overrides at all)', () => {
    expect(derivePerConversationModelOverride(undefined, defaultProfile)).toBe(false);
  });

  it('returns false when turnOptions is empty', () => {
    expect(derivePerConversationModelOverride({}, defaultProfile)).toBe(false);
  });

  it('returns false when modelOverride is an empty string (treated as no override)', () => {
    expect(derivePerConversationModelOverride({ modelOverride: '' }, defaultProfile)).toBe(false);
  });

  it('returns false when modelOverride is whitespace-only', () => {
    expect(derivePerConversationModelOverride({ modelOverride: '   ' }, defaultProfile)).toBe(false);
  });

  it('returns true when modelOverride is a non-empty trimmed string', () => {
    expect(derivePerConversationModelOverride({ modelOverride: 'gpt-4' }, defaultProfile)).toBe(true);
  });

  it('returns false when workingProfileOverrideId equals the default working profile id (idempotent set)', () => {
    expect(
      derivePerConversationModelOverride(
        { workingProfileOverrideId: 'default-profile' },
        defaultProfile,
      ),
    ).toBe(false);
  });

  it('returns true when workingProfileOverrideId differs from the default working profile id', () => {
    expect(
      derivePerConversationModelOverride(
        { workingProfileOverrideId: 'other-profile' },
        defaultProfile,
      ),
    ).toBe(true);
  });

  it('returns true when workingProfileOverrideId is set but configuredWorkingProfile is null', () => {
    expect(
      derivePerConversationModelOverride(
        { workingProfileOverrideId: 'some-profile' },
        null,
      ),
    ).toBe(true);
  });

  it('returns true when workingProfileOverrideId is set but configuredWorkingProfile is undefined', () => {
    expect(
      derivePerConversationModelOverride(
        { workingProfileOverrideId: 'some-profile' },
        undefined,
      ),
    ).toBe(true);
  });

  it('returns true when modelOverride is set even if workingProfileOverrideId matches the default', () => {
    expect(
      derivePerConversationModelOverride(
        { modelOverride: 'gpt-4', workingProfileOverrideId: 'default-profile' },
        defaultProfile,
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolveActiveProfileForTurn
// ---------------------------------------------------------------------------
describe('resolveActiveProfileForTurn', () => {
  const configuredProfile = {
    id: 'configured-profile',
    name: 'Configured profile',
    providerType: 'openai' as const,
    serverUrl: 'https://api.openai.com/v1',
    model: 'gpt-5.2',
    createdAt: 1,
  };

  it('suppresses configured working profile when fallback retry clears the profile override', () => {
    const baseSettings = buildSettings();
    const settings = buildSettings({
      claude: { ...baseSettings.models, workingProfileId: configuredProfile.id },
      localModel: {
        ...baseSettings.localModel,
        activeProfileId: null,
        profiles: [configuredProfile],
      },
    });

    expect(
      resolveActiveProfileForTurn(null, settings, { modelOverride: 'gpt-5.5', workingProfileOverrideId: '' }),
    ).toBeNull();
  });

  it('uses the configured working profile when it has not been explicitly suppressed', () => {
    const baseSettings = buildSettings();
    const settings = buildSettings({
      claude: { ...baseSettings.models, workingProfileId: configuredProfile.id },
      localModel: {
        ...baseSettings.localModel,
        activeProfileId: null,
        profiles: [configuredProfile],
      },
    });

    expect(resolveActiveProfileForTurn(null, settings, undefined)?.id).toBe(configuredProfile.id);
  });
});
