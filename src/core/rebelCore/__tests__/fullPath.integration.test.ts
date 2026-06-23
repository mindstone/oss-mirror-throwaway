/**
 * Full-Path Integration Tests
 *
 * Live-API integration test exercising the model-alias→canonical resolution
 * path through `queryWithRuntime` → Rebel Core → Anthropic's native API.
 * Uses the actual app-settings.json from the user's machine.
 *
 * Skipped automatically when `isDirectAnthropicConfig(settings) &&
 * hasDirectAuth(settings)` is false — i.e. when the user routes through
 * OpenRouter/Codex or has no Anthropic credentials. This suite validates
 * the native Anthropic SDK path only; provider-aware live integration
 * coverage belongs in a separate file.
 *
 * Catches the model-alias→404 class (e.g. `'planner'` was sent verbatim
 * pre-fix). Does NOT exhaustively cover every auth/config mismatch — see
 * the eligibility gate at the top of the file.
 *
 * Canonical accessor contract (260507):
 * Model / thinkingModel / permissionMode reads MUST go through the
 * `@core/rebelCore/settingsAccessors` accessors (`getCurrentModel`,
 * `getThinkingModel`, `getPermissionMode`) — NOT `mockSettings.models.*`
 * directly. After the 260603/260604 namespace migration, `claude.*` is a
 * legacy mirror that can drift indefinitely from canonical `models.*`,
 * which is what production reads. Reading `claude.*` here pipes a stale
 * proxy-dialect model string into the direct-Anthropic path and trips
 * the line-538 defense-in-depth — a test bug, not a production bug.
 *
 * The `canRun` gate likewise composes a canonical model-shape check
 * (`isNativeAnthropicModel(getCurrentModel(realSettings))`) so the suite
 * skips cleanly when canonical settings are also drift, rather than
 * silently masking the misalignment by gating on the legacy field.
 *
 * Investigation: docs-private/investigations/260507_fullpath_integration_proxy_dialect_routing_failure.md
 * Postmortem: docs-private/postmortems/260419_prepush_live_api_integration_test_404_postmortem.md
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { configurePromptFileService, _resetForTesting } from '@core/services/promptFileService';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { AgentMessage } from '@core/agentRuntimeTypes';
import type { TurnParams } from '../turnParams';
import type { AppSettings } from '@shared/types';
import {
  resolveModelConfig,
  stripExtendedContextFromConfig,
  downgradeThinkingModelConfig,
  modelSupportsExtendedContext,
  planModeTargetFromThinkingModel,
} from '@shared/utils/modelNormalization';
import { setSettingsStoreAdapter } from '@core/services/settingsStore';
import {
  getApiKeyForDirectUse,
  getAuthEnvVars,
  isDirectAnthropicConfig,
} from '@core/utils/authEnvUtils';
import {
  getCurrentModel,
  getThinkingModel,
  getPermissionMode,
} from '../settingsAccessors';
import { isNativeAnthropicModel } from '../providerRouteDecision';
import { rebelCoreQuery } from '../rebelCoreQuery';
/* eslint-disable no-console -- integration test diagnostic output */

function loadRealSettings(): AppSettings | null {
  try {
    const settingsPath = path.join(
      os.homedir(),
      'Library',
      'Application Support',
      'mindstone-rebel',
      'app-settings.json',
    );
    return JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Centralised canonical-accessor reads for the suite. Wrapping the accessor
 * calls here keeps every test on the canonical `models.*` read path that
 * production uses and makes it harder to reintroduce `mockSettings.models.*`
 * accesses later (per the 260507 Fix Design Checkpoint guidance).
 */
function getCanonicalModelView(settings: AppSettings) {
  return {
    workingModel: getCurrentModel(settings),
    thinkingModel: getThinkingModel(settings),
    permissionMode: getPermissionMode(settings),
  };
}

function canRunFullPathIntegration(settings: AppSettings | null): boolean {
  if (!settings) return false;
  const workingModel = getCurrentModel(settings);
  const thinkingModel = getThinkingModel(settings);
  return !!getApiKeyForDirectUse(settings)
    && isDirectAnthropicConfig(settings)
    && !!workingModel
    && isNativeAnthropicModel(workingModel)
    // Plan-mode tests use the thinking model. If it's set, it must
    // also be native-Anthropic shape; otherwise plan-mode tests would
    // misroute. Empty/undefined thinkingModel is fine — single-model
    // mode bypasses the plan-mode plumbing entirely.
    && (!thinkingModel || isNativeAnthropicModel(thinkingModel));
}

const realSettings = loadRealSettings();
const hasApiKey = realSettings ? !!getApiKeyForDirectUse(realSettings) : false;
const isDirectAnthropic = realSettings ? isDirectAnthropicConfig(realSettings) : false;
const canonicalModel = realSettings ? getCurrentModel(realSettings) : undefined;
const canonicalThinkingModel = realSettings ? getThinkingModel(realSettings) : undefined;
const isNativeModel = canonicalModel ? isNativeAnthropicModel(canonicalModel) : false;
const isNativeThinkingModel =
  !canonicalThinkingModel || isNativeAnthropicModel(canonicalThinkingModel);
const canRun = canRunFullPathIntegration(realSettings);

if (realSettings && hasApiKey && !isDirectAnthropic) {
  console.log(
    'Skipping fullPath.integration.test: settings route via proxy provider (OpenRouter/Codex); this suite is direct-Anthropic only.',
  );
}

if (realSettings && hasApiKey && isDirectAnthropic && !isNativeModel) {
  console.log(
    `Skipping fullPath.integration.test: canonical working model "${canonicalModel ?? '<unset>'}" is not a native-Anthropic shape; ` +
      'this suite only exercises the direct-Anthropic SDK path. ' +
      'See docs-private/investigations/260507_fullpath_integration_proxy_dialect_routing_failure.md for context.',
  );
}

if (realSettings && hasApiKey && isDirectAnthropic && isNativeModel && !isNativeThinkingModel) {
  console.log(
    `Skipping fullPath.integration.test: canonical thinking model "${canonicalThinkingModel ?? '<unset>'}" is not a native-Anthropic shape ` +
      `(working model "${canonicalModel ?? '<unset>'}" is fine). Plan-mode tests would misroute; ` +
      'see docs-private/investigations/260507_fullpath_integration_proxy_dialect_routing_failure.md for context.',
  );
}

// This suite validates the native Anthropic SDK path only.
// Provider-aware live integration coverage belongs in a separate file.
describe('Full-Path Integration eligibility gate', () => {
  it('skips direct-Anthropic auth/provider settings when the canonical working model is proxy-dialect', () => {
    const settings = {
      coreDirectory: null,
      mcpConfigFile: null,
      onboardingCompleted: true,
      userEmail: null,
      onboardingFirstCompletedAt: null,
      voice: { enabled: false },
      diagnostics: { debugBreadcrumbsUntil: null },
      activeProvider: 'anthropic',
      models: {
        apiKey: 'fake-ant-test',
        oauthToken: null,
        authMethod: 'api-key',
        model: 'openai/gpt-5.4',
        permissionMode: 'bypassPermissions',
        executablePath: null,
        planMode: false,
        extendedContext: false,
        thinkingEffort: 'high',
      },
    } as unknown as AppSettings;

    expect(isDirectAnthropicConfig(settings)).toBe(true);
    expect(getApiKeyForDirectUse(settings)).toBe('fake-ant-test');
    expect(getCurrentModel(settings)).toBe('openai/gpt-5.4');
    expect(isNativeAnthropicModel(getCurrentModel(settings)!)).toBe(false);
    expect(canRunFullPathIntegration(settings)).toBe(false);

    const nativeSettings = {
      ...settings,
      models: {
        ...settings.models,
        model: 'claude-sonnet-4-6',
      },
    } as AppSettings;
    expect(canRunFullPathIntegration(nativeSettings)).toBe(true);
  });

  it('skips when working model is native-Anthropic but thinking model is proxy-dialect', () => {
    const settings = {
      coreDirectory: null,
      mcpConfigFile: null,
      onboardingCompleted: true,
      userEmail: null,
      onboardingFirstCompletedAt: null,
      voice: { enabled: false },
      diagnostics: { debugBreadcrumbsUntil: null },
      activeProvider: 'anthropic',
      models: {
        apiKey: 'fake-ant-test',
        oauthToken: null,
        authMethod: 'api-key',
        model: 'claude-sonnet-4-6',
        thinkingModel: 'openai/gpt-5.4',
        permissionMode: 'bypassPermissions',
        executablePath: null,
        planMode: false,
        extendedContext: false,
        thinkingEffort: 'high',
      },
    } as unknown as AppSettings;

    expect(isDirectAnthropicConfig(settings)).toBe(true);
    expect(getApiKeyForDirectUse(settings)).toBe('fake-ant-test');
    expect(getCurrentModel(settings)).toBe('claude-sonnet-4-6');
    expect(getThinkingModel(settings)).toBe('openai/gpt-5.4');
    expect(isNativeAnthropicModel(getCurrentModel(settings)!)).toBe(true);
    expect(isNativeAnthropicModel(getThinkingModel(settings)!)).toBe(false);
    expect(canRunFullPathIntegration(settings)).toBe(false);

    // Clearing thinking model to native (or empty) re-enables the suite.
    const cleanedSettings = {
      ...settings,
      models: {
        ...settings.models,
        thinkingModel: 'claude-opus-4-7',
      },
    } as AppSettings;
    expect(canRunFullPathIntegration(cleanedSettings)).toBe(true);
  });
});

describe.skipIf(!canRun)('Full-Path Integration (real settings)', () => {
  let mockSettings: AppSettings;

  beforeAll(() => {
    _resetForTesting();
    configurePromptFileService(path.resolve(__dirname, '../../../..', 'rebel-system', 'prompts'));
    mockSettings = { ...realSettings! };

    setSettingsStoreAdapter({
      getSettings: () => mockSettings,
      updateSettings: () => {},
      updateSettingsAtomic: () => {},
    });
  });

  afterAll(() => {
    _resetForTesting();
    // Reset to avoid polluting other tests
    setSettingsStoreAdapter({
      getSettings: () => ({ models: { apiKey: null, oauthToken: null, authMethod: 'api-key', model: 'claude-sonnet-4-6', permissionMode: 'bypassPermissions', executablePath: null, planMode: false } } as any),
      updateSettings: () => {},
      updateSettingsAtomic: () => {},
    });
  });

  /**
   * Build query options that mirror what agentTurnExecutor.buildQueryOptions() produces.
   * This is the critical path — if this doesn't match production, we miss bugs.
   */
  function buildRealisticTurnParams(modelConfig: ReturnType<typeof resolveModelConfig>, prompt: string): TurnParams {
    const authEnv = getAuthEnvVars(mockSettings);
    return {
      model: modelConfig.model,
      cwd: os.tmpdir(),
      systemPrompt: 'You are a helpful assistant. Reply in one short sentence.',
      prompt,
      permissionMode: getPermissionMode(mockSettings) ?? 'bypassPermissions',
      env: {
        ...process.env,
        ...modelConfig.envOverrides,
        ...authEnv,
      } as Record<string, string>,
    };
  }

  async function collectMessages(gen: AsyncGenerator<AgentMessage>): Promise<AgentMessage[]> {
    const messages: AgentMessage[] = [];
    for await (const msg of gen) {
      messages.push(msg);
    }
    return messages;
  }

  it('should work with the user\'s actual model config (single model mode)', async () => {
    const workingModel = getCanonicalModelView(mockSettings).workingModel || 'claude-sonnet-4-6';
    const modelConfig = resolveModelConfig(
      workingModel,
      null, // no thinking model = single model mode
      false,
    );

    const params = buildRealisticTurnParams(modelConfig, 'What is 1+1? Reply with just the number.');

    const messages = await collectMessages(
      rebelCoreQuery(
        params,
        { settings: mockSettings, cwd: os.tmpdir() },
      ),
    );

    const init = messages.find((m) => m.type === 'system');
    expect(init).toBeDefined();

    const result = messages.find((m) => m.type === 'result');
    expect(result).toBeDefined();
    expect((result as any).is_error).toBe(false);
  }, 30_000);

  it('should work with plan mode (thinking + working models)', async () => {
    const canonical = getCanonicalModelView(mockSettings);
    const thinkingModel = canonical.thinkingModel || 'claude-opus-4-7';
    const workingModel = canonical.workingModel || 'claude-sonnet-4-6';

    // Only test if thinking model is different (plan mode)
    if (thinkingModel === workingModel) {
      console.log('Skipping planner alias test: thinking model same as working model');
      return;
    }

    const modelConfig = resolveModelConfig(workingModel, planModeTargetFromThinkingModel(thinkingModel, workingModel), false);
    expect(modelConfig.model).toBe('planner');
    expect(modelConfig.envOverrides?.EXECUTION_MODEL).toBe(workingModel);

    // Use a prompt that requires tool use so the planner won't use the direct-answer escape hatch
    const params = buildRealisticTurnParams(modelConfig, 'Run the bash command "echo hello" and tell me what it outputs.');

    const messages = await collectMessages(
      rebelCoreQuery(
        params,
        { settings: mockSettings, cwd: os.tmpdir() },
      ),
    );

    const result = messages.find((m) => m.type === 'result');
    expect(result).toBeDefined();
    expect((result as any).is_error).toBe(false);
    // Planning model always runs in plan mode
    expect((result as any).modelUsage[thinkingModel]).toBeDefined();
    // Working model runs unless the planner used the direct-answer escape hatch
    // (unlikely for tool-requiring prompts, but handle gracefully)
    const workingUsage = (result as any).modelUsage[workingModel];
    if (!workingUsage) {
      console.log('Note: planner used direct-answer escape hatch — working model was not invoked');
    }
  }, 30_000);

  it('should work with extended context [1m] suffix', async () => {
    // [1m] only applies to models that declare supportsExtendedContext (currently
    // claude-opus-4-6 / claude-sonnet-4-6). Skip this test when the current user's
    // model isn't one of those — otherwise the assertion is a false negative caused
    // by the user's settings, not a real code regression.
    const { workingModel } = getCanonicalModelView(mockSettings);
    if (!workingModel || !modelSupportsExtendedContext(workingModel)) {
      console.log(
        `Skipping [1m] test: ${workingModel ?? '<unset>'} does not support extended context`,
      );
      return;
    }

    const modelConfig = resolveModelConfig(
      workingModel,
      null,
      true, // extended context ON
    );

    // Model should have [1m] suffix
    expect(modelConfig.model).toMatch(/\[1m\]$/i);

    const params = buildRealisticTurnParams(modelConfig, 'What is 3+3? Reply with just the number.');

    const messages = await collectMessages(
      rebelCoreQuery(
        params,
        { settings: mockSettings, cwd: os.tmpdir() },
      ),
    );

    const result = messages.find((m) => m.type === 'result');
    expect(result).toBeDefined();
    expect((result as any).is_error).toBe(false);
  }, 30_000);

  it('should work with planner alias + extended context', async () => {
    const canonical = getCanonicalModelView(mockSettings);
    const thinkingModel = canonical.thinkingModel || 'claude-opus-4-7';
    const workingModel = canonical.workingModel || 'claude-sonnet-4-6';

    if (thinkingModel === workingModel) {
      console.log('Skipping planner alias+1m test: thinking model same as working model');
      return;
    }

    const modelConfig = resolveModelConfig(workingModel, planModeTargetFromThinkingModel(thinkingModel, workingModel), true);
    expect(modelConfig.model).toBe('planner');
    expect(modelConfig.envOverrides?.PLANNING_MODEL).toMatch(/\[1m\]$/i);

    const params = buildRealisticTurnParams(modelConfig, 'What is 4+4? Reply with just the number.');

    const messages = await collectMessages(
      rebelCoreQuery(
        params,
        { settings: mockSettings, cwd: os.tmpdir() },
      ),
    );

    const result = messages.find((m) => m.type === 'result');
    expect(result).toBeDefined();
    expect((result as any).is_error).toBe(false);
  }, 30_000);

  it('should work after stripExtendedContextFromConfig', async () => {
    const canonical = getCanonicalModelView(mockSettings);
    const thinkingModel = canonical.thinkingModel || 'claude-opus-4-7';
    const workingModel = canonical.workingModel || 'claude-sonnet-4-6';
    const modelConfig = resolveModelConfig(workingModel, planModeTargetFromThinkingModel(thinkingModel, workingModel), true);
    const stripped = stripExtendedContextFromConfig(modelConfig);

    const params = buildRealisticTurnParams(stripped, 'What is 5+5? Reply with just the number.');

    const messages = await collectMessages(
      rebelCoreQuery(
        params,
        { settings: mockSettings, cwd: os.tmpdir() },
      ),
    );

    const result = messages.find((m) => m.type === 'result');
    expect(result).toBeDefined();
    expect((result as any).is_error).toBe(false);
  }, 60_000);

  it('should work after downgradeThinkingModelConfig', async () => {
    const modelConfig = resolveModelConfig('claude-sonnet-4-6', planModeTargetFromThinkingModel('claude-opus-4-7', 'claude-sonnet-4-6'), false);
    const downgraded = downgradeThinkingModelConfig(modelConfig);

    const params = buildRealisticTurnParams(downgraded, 'What is 6+6? Reply with just the number.');

    const messages = await collectMessages(
      rebelCoreQuery(
        params,
        { settings: mockSettings, cwd: os.tmpdir() },
      ),
    );

    const result = messages.find((m) => m.type === 'result');
    expect(result).toBeDefined();
    expect((result as any).is_error).toBe(false);
  }, 30_000);

  it('should produce AgentMessage shapes the handler expects', async () => {
    const workingModel = getCanonicalModelView(mockSettings).workingModel || 'claude-sonnet-4-6';
    const modelConfig = resolveModelConfig(workingModel, null, false);
    const params = buildRealisticTurnParams(modelConfig, 'Say "test" and nothing else.');

    const messages = await collectMessages(
      rebelCoreQuery(
        params,
        { settings: mockSettings, cwd: os.tmpdir() },
      ),
    );

    // Verify init message shape
    const init = messages.find((m) => m.type === 'system') as any;
    expect(init.subtype).toBe('init');
    // session_id deliberately omitted (no server-side session to resume)
    expect(init.model).toBeTruthy();
    // Model should NOT be 'planner' or contain [1m] — should be resolved
    expect(init.model).not.toBe('planner');
    expect(init.model).not.toMatch(/\[1m\]/);

    // Verify result message shape
    const result = messages.find((m) => m.type === 'result') as any;
    expect(result.subtype).toBe('success');
    expect(typeof result.total_cost_usd).toBe('number');
    expect(result.usage).toBeDefined();
    expect(typeof result.usage.input_tokens).toBe('number');
    expect(typeof result.usage.output_tokens).toBe('number');
    // session_id present on result messages (for cost tracking, not resume)
    expect(result.session_id).toBeTruthy();
  }, 30_000);
});
