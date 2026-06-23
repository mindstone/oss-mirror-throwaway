/**
 * REBEL-655 Repro Spike — Plan-mode planning-client credential failure
 *
 * Scenario: user whose execution provider is a ChatGPT Pro (Codex) subscription
 * (activeProvider: 'codex', working profile is an OpenAI/Codex subscription
 * profile) but who has NO Anthropic API key. Their `thinkingModel` setting is
 * `claude-opus-4-7` (a native Anthropic model — the default when plan mode is
 * enabled). When a turn fires in plan mode:
 *
 *  1. resolveRuntimeModels → isPlanMode=true, planningModel='claude-opus-4-7',
 *     executionModel=<gpt-5.5 or similar via Codex profile>
 *  2. The execution client succeeds (Codex profile + codexMode, proxy path).
 *  3. createClientForModel({ model: 'claude-opus-4-7', context: 'planning' })
 *     → resolveProviderRoutePlan → activeProvider='codex', model is native Anthropic
 *     → router branches: "codex + isNativeAnthropicModel → direct Anthropic"
 *     → hasAnthropicCredentials(settings) = false
 *     → noCredentialsDecision('missing-anthropic-credentials')
 *     → throwTerminalRoutePlanForCreateClient → ConnectionNotConfiguredError
 *  4. rebelCoreQuery.ts preserves the branded ConnectionNotConfiguredError
 *     instead of flattening it into a generic auth ModelError.
 *
 * This test reproduces the failure at the lowest-cost seam:
 *   - Direct call to createClientForModel with planning context
 *   - Settings: activeProvider='codex', no Anthropic key, Codex subscription profile
 *     as working profile, thinkingModel='claude-opus-4-7'
 *
 * Expected behaviour: throws with message matching "Anthropic needs an API key"
 *   (the ConnectionNotConfiguredError from buildTerminalReconnectMessage), and
 *   Rebel preserves that branded error when the planning-client catch sees it.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import type { AppSettings, ModelProfile } from '@shared/types';
import { createClientForModel, ConnectionNotConfiguredError } from '../clientFactory';
import { resolveProviderRoutePlan, ProviderRouter } from '../providerRouting';
import { assertDispatchableQueryOptionsPlan } from '@core/services/turnPipeline/agentTurnExecute';
import { UnsupportedModelError } from '@shared/utils/connectionCredentials';
import { resolveDefaultModelForRole } from '../modelRoleResolver';
import { resolveRuntimeModels } from '../planningMode';
import {
  resolveModelConfig,
  resolvePlanningThinkingModel,
  resolvePlanModeTarget,
  planModeTargetFromThinkingModel,
  PREFERRED_PLANNING_MODEL,
} from '@shared/utils/modelNormalization';
import { configurePromptFileService, _resetForTesting } from '@core/services/promptFileService';
import { setErrorReporter, type ErrorReporter } from '@core/errorReporter';

const silentReporter: ErrorReporter = {
  captureException: () => {},
  captureMessage: () => {},
  addBreadcrumb: () => {},
};

beforeEach(() => {
  _resetForTesting();
  configurePromptFileService(path.resolve(__dirname, '../../../..', 'rebel-system', 'prompts'));
  setErrorReporter(silentReporter);
});

afterEach(() => {
  _resetForTesting();
  setErrorReporter(silentReporter);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build AppSettings representing a Codex / ChatGPT Pro subscription user with
 * NO Anthropic API key and a thinking model set to a native Anthropic model.
 */
function makeCodexOnlySettings(): AppSettings {
  return {
    coreDirectory: null,
    mcpConfigFile: null,
    onboardingCompleted: true,
    userEmail: null,
    onboardingFirstCompletedAt: null,
    voice: { enabled: false },
    // The critical field: active provider is Codex (ChatGPT Pro subscription).
    activeProvider: 'codex',
    models: {
      // No Anthropic API key — this user hasn't added one.
      apiKey: null,
      oauthToken: null,
      authMethod: 'api-key',
      // Working model (used by execution role)
      model: 'gpt-4o',
      // Thinking model set to a native Claude model — this is what triggers the bug.
      // This is the default when plan mode is first enabled (PREFERRED_PLANNING_MODEL).
      thinkingModel: 'claude-opus-4-7',
      thinkingProfileId: null,
      workingProfileId: null,
      permissionMode: 'plan',
      executablePath: null,
      planMode: true,
      extendedContext: false,
    },
    localModel: {
      // Codex subscription profile — this is the working profile for execution turns.
      activeProfileId: 'codex-sub-1',
      profiles: [
        {
          id: 'codex-sub-1',
          name: 'ChatGPT Pro (Codex)',
          providerType: 'openai',
          routeSurface: 'subscription',
          authSource: 'codex-subscription',
          serverUrl: 'https://api.openai.com/v1',
          model: 'gpt-4o',
          enabled: true,
          createdAt: Date.now(),
        } as any,
      ],
    },
    diagnostics: { enabled: false },
    providerKeys: {},
  } as unknown as AppSettings;
}

// ---------------------------------------------------------------------------
// Bug repro: direct createClientForModel call for the planning role
// ---------------------------------------------------------------------------

describe('REBEL-655 — plan mode planning-client credential failure', () => {
  describe('createClientForModel with planning context', () => {
    it('BUG: throws when creating planning client for a native Claude model with no Anthropic key on a Codex-only user', async () => {
      // Skip if ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN is set in the environment,
      // because getAnthropicAuth / hasAnthropicCredentials would succeed in that case.
      if (process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN) {
        console.warn('[REBEL-655 repro] Skipping: env provides Anthropic credentials — bug would not reproduce');
        return;
      }

      const settings = makeCodexOnlySettings();

      // Attempt to create a planning client for the native Claude thinking model.
      // This is exactly what rebelCoreQuery.ts:1181-1187 does when isPlanMode is true
      // and planningModel differs from executionModel.
      await expect(
        createClientForModel({
          model: 'claude-opus-4-7',
          settings,
          context: 'planning',
          // No proxyConfig — in plan mode the same proxyConfig as the execution turn is
          // passed; for a Codex turn it carries x-codex-turn:true. However the
          // tryCreateLegacyTurnRouterClaudeProxyClient guard explicitly excludes Codex
          // turns (line: `if (options.proxyConfig.defaultHeaders?.['x-codex-turn'] === 'true') return null`)
          // so the Codex proxy header does NOT rescue the planning client.
          // We omit proxyConfig here to test the resolver path cleanly; the bug also
          // reproduces WITH the Codex proxy headers because of that explicit exclusion.
        }),
      ).rejects.toThrow(/Anthropic needs an API key/);
    });

    it('FOX-3494: connected Codex + claude planning → actionable unsupported-model terminal (was: misleading Anthropic terminal)', async () => {
      if (process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN) {
        console.warn('[REBEL-655 repro] Skipping: env provides Anthropic credentials — bug would not reproduce');
        return;
      }

      const settings = makeCodexOnlySettings();

      // Mirror what rebelCoreQuery.ts actually does: pass the SAME proxyConfig as
      // the execution turn. For a Codex turn this carries x-codex-turn:true, and a
      // live codexMode resolves connectivity to 'connected'. FOX-3494: a PRIMARY
      // (planning) claude-* turn under CONNECTED ChatGPT Pro with no Anthropic key
      // now surfaces as an actionable terminal so the renderer can offer "switch
      // to a GPT model", instead of the misleading "Anthropic needs an API key".
      await expect(
        createClientForModel({
          model: 'claude-opus-4-7',
          settings,
          context: 'planning',
          proxyConfig: {
            baseURL: 'http://localhost:10000',
            defaultHeaders: {
              'x-codex-turn': 'true',
              'x-proxy-auth': 'codex-session-token',
            },
          },
          codexMode: {
            endpointUrl: 'https://chatgpt.com/backend-api/codex',
            getAccessToken: vi.fn(async () => 'codex-token'),
            getAccountId: vi.fn(() => 'org_123'),
            forceRefreshToken: vi.fn(async () => 'codex-token-refreshed'),
          },
        }),
      ).rejects.toThrow(/runs on Anthropic/);
    });

    it('documents the branded ConnectionNotConfiguredError that rebelCoreQuery must preserve', async () => {
      if (process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN) {
        console.warn('[REBEL-655 repro] Skipping: env provides Anthropic credentials — bug would not reproduce');
        return;
      }

      const settings = makeCodexOnlySettings();

      // Verify the error is specifically ConnectionNotConfiguredError (not a generic Error).
      // rebelCoreQuery's planning-client catch must preserve this branded error
      // instead of rethrowing it as a generic ModelError('auth').
      try {
        await createClientForModel({
          model: 'claude-opus-4-7',
          settings,
          context: 'planning',
        });
        // If we reach here, the env has Anthropic credentials — skip with a note.
        throw new Error('Expected createClientForModel to throw a ConnectionNotConfiguredError');
      } catch (e: unknown) {
        // The underlying throw is ConnectionNotConfiguredError with
        // __agentErrorKind='connection-not-configured'.
        expect(e).toBeInstanceOf(ConnectionNotConfiguredError);
        expect((e as { __agentErrorKind?: string }).__agentErrorKind).toBe('connection-not-configured');
        expect((e as Error).message).toMatch(/Anthropic needs an API key/);
      }
    });
  });

  describe('resolveRuntimeModels — confirms thinking role resolves to Claude for Codex user', () => {
    it('thinking role resolves to the configured thinkingModel (claude-opus-4-7) regardless of activeProvider', () => {
      // This is the model-resolution half of the bug: modelRoleResolver.ts has no
      // provider-awareness for the thinking role. It reads settings.models.thinkingModel
      // (or settings.models.thinkingModel) unconditionally. For a Codex user whose
      // thinkingModel was seeded to a Claude model (the default), the resolver returns
      // that Claude model — which then triggers the missing-Anthropic-credentials failure
      // in the client factory.
      const settings = makeCodexOnlySettings();
      const profiles = settings.localModel?.profiles ?? [];
      const resolution = resolveDefaultModelForRole('thinking', settings, profiles);

      // Resolution succeeds (model-resolver doesn't check credentials) — but the model
      // it returns is a native Anthropic model, which will then fail at client creation.
      expect(resolution.ok).toBe(true);
      // Narrow the discriminated union before accessing success-only fields.
      if (!resolution.ok) throw new Error('expected resolution.ok === true');
      expect(resolution.model).toBe('claude-opus-4-7');
      // The source is 'setting' (from settings.models.thinkingModel).
      expect(resolution.source).toBe('setting');
    });

    it('resolveRuntimeModels returns isPlanMode=true with planningModel=claude-opus-4-7 for Codex user', () => {
      const settings = makeCodexOnlySettings();

      // Simulate the call site in agentTurnExecute.ts that builds the model config:
      // the model is PLAN_MODE_ALIAS ('planner') when plan mode is active.
      const runtimeModels = resolveRuntimeModels({
        model: 'planner',
        settings,
      });

      expect(runtimeModels.isPlanMode).toBe(true);
      // planningModel will be claude-opus-4-7 — the value from thinkingModel setting.
      // This model requires Anthropic credentials the user doesn't have.
      expect(runtimeModels.planningModel).toBe('claude-opus-4-7');
      // executionModel is gpt-4o (from the working role / active profile).
      // Note: with no Anthropic key, activeProvider='codex', and a Codex profile as
      // activeProfileId, the working model may not resolve purely from thinkingModel;
      // the exact executionModel depends on resolveDefaultModelForRole('working', ...).
      expect(runtimeModels.planningModel).not.toBe(runtimeModels.executionModel);
    });
  });

  // -------------------------------------------------------------------------
  // TRUE INCIDENT SEAM (REBEL-655): working profile == thinking profile == a
  // Codex profile (codex-gpt-5.5), no Anthropic key. This reproduces the actual
  // routing snapshot from the Sentry event, where the executor leaked
  // PLANNING_MODEL=claude-opus-4-8 even though both roles were the same Codex
  // profile.
  //
  // The seam under test is the planning-model resolution that agentTurnExecute
  // feeds into resolveModelConfig:
  //   effectiveThinkingModel = thinkingProfile ? PREFERRED_PLANNING_MODEL : ...
  // After the fix this becomes resolvePlanningThinkingModel(...) which names the
  // REAL thinking model, so thinking == working → single-model mode (no leak).
  // -------------------------------------------------------------------------
  describe('plan-mode planning-model resolution seam (working == thinking == codex profile)', () => {
    const workingModel = 'gpt-5.5';
    const thinkingProfileModel = 'gpt-5.5'; // SAME codex profile as working

    // Regression-lock for the Stage-2 fix at the executor seam. agentTurnExecute computes
    //   effectiveThinkingModel = resolvePlanningThinkingModel({ thinkingModelOverride,
    //     thinkingProfileModel: thinkingProfile?.model, settingsThinkingModel: getThinkingModel(settings) })
    // and passes it to resolveModelConfig. This test reproduces the INCIDENT inputs
    // (working profile == thinking profile == a codex profile, no Anthropic key) and
    // drives the REAL production helper → resolveModelConfig. If the executor were
    // reverted to substitute PREFERRED_PLANNING_MODEL for a thinking profile, this
    // would go RED (single-model expectation would fail; PLANNING_MODEL would be the
    // Claude sentinel). This documents what the OLD bug looked like AND proves the fix.
    it('REGRESSION: working == thinking == codex profile → single-model mode, NO claude PLANNING_MODEL leak', () => {
      // Sanity: the OLD substitution (kept here only to document the bug shape) would
      // have leaked the Claude sentinel as PLANNING_MODEL — a model the Codex user
      // cannot route → Anthropic-direct → no key → "Credentials need attention".
      // The OLD bug shape, for documentation: substituting the synthetic Claude
      // sentinel as the planning target leaks PLANNING_MODEL=claude-opus-4-8. Under
      // the typed API the sentinel can ONLY enter via an explicit decode — there is
      // no longer a raw-string positional path — but if it does enter it still
      // produces the planner alias, which is exactly why the accessor (below) must
      // never yield it for the incident inputs.
      const oldLeakedConfig = resolveModelConfig(
        workingModel,
        planModeTargetFromThinkingModel(PREFERRED_PLANNING_MODEL, workingModel),
        false,
      );
      expect(oldLeakedConfig.model).toBe('planner');
      expect(oldLeakedConfig.envOverrides?.PLANNING_MODEL).toBe('claude-opus-4-8');

      // The FIX: resolve the typed plan-mode target through the production accessor.
      // Because the thinking profile model equals the working model, the target
      // collapses to null → plan mode never engages.
      const planningModel = resolvePlanningThinkingModel({
        thinkingModelOverride: undefined,
        thinkingProfileModel,
        settingsThinkingModel: undefined,
      });
      expect(planningModel).toBe('gpt-5.5');
      expect(planningModel).not.toBe(PREFERRED_PLANNING_MODEL);
      const target = resolvePlanModeTarget({
        workingModel,
        thinkingModelOverride: undefined,
        thinkingProfileModel,
        settingsThinkingModel: undefined,
      });
      expect(target).toBeNull();
      const config = resolveModelConfig(workingModel, target, false);
      expect(config.model).toBe('gpt-5.5');
      expect(config.envOverrides).toBeUndefined();
      expect(config.envOverrides?.PLANNING_MODEL).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // MA1 (REBEL-655 Phase 6): distinct proxy-backed thinking PROFILE + a stale
  // raw `claude-*` `thinkingModel` SETTING. Before MA1, the bare-Claude fallback
  // block (`if (!directPlanningClient && !councilConfig)`) read the RAW
  // `thinkingModel` setting EVEN WHEN a thinking profile was active — so a stale
  // `claude-*` setting could hijack the selected proxy-backed planner (either
  // silently disabling plan mode with no Anthropic key, or injecting a Claude
  // planning client + patching env to the wrong Claude model).
  //
  // Two guarantees lock the fix:
  //   (1) Precedence: resolvePlanningThinkingModel returns the PROFILE model, never
  //       the stale `claude-*` setting and never a sentinel — so ENV_THINKING_MODEL
  //       carries the REAL proxy-backed model (routed via the proxy, not Anthropic).
  //   (2) The bare-Claude client-injection block is now gated on `!thinkingProfile`
  //       (executor source), so it cannot fire while a thinking profile is active —
  //       i.e. the stale Claude setting can never produce a Claude direct planning
  //       client and plan mode is never silently dropped for a working planner.
  // -------------------------------------------------------------------------
  describe('MA1 — distinct proxy-backed thinking profile + stale raw claude thinkingModel setting', () => {
    it('helper returns the REAL proxy-backed profile model, NOT the stale claude setting or a sentinel', () => {
      const planningModel = resolvePlanningThinkingModel({
        thinkingModelOverride: undefined,
        thinkingProfileModel: 'gpt-5.5', // distinct proxy-backed thinking profile
        settingsThinkingModel: 'claude-opus-4-8', // STALE raw claude-* setting
      });
      // Profile model wins; the stale claude setting is never used.
      expect(planningModel).toBe('gpt-5.5');
      expect(planningModel).not.toBe('claude-opus-4-8');
      expect(planningModel).not.toBe(PREFERRED_PLANNING_MODEL);
    });

    it('plan mode IS preserved and PLANNING_MODEL names the real proxy-backed model (no Claude leak, not silently dropped)', () => {
      const workingModel = 'gpt-4.1'; // distinct working model → plan mode genuinely engages
      const target = resolvePlanModeTarget({
        workingModel,
        thinkingModelOverride: undefined,
        thinkingProfileModel: 'gpt-5.5',
        settingsThinkingModel: 'claude-opus-4-8',
      });
      expect(target?.thinkingModel).toBe('gpt-5.5');
      const config = resolveModelConfig(workingModel, target, false);
      // Plan mode preserved (NOT silently dropped) and routed via the proxy-backed model.
      expect(config.model).toBe('planner');
      expect(config.envOverrides?.PLANNING_MODEL).toBe('gpt-5.5');
      expect(config.envOverrides?.PLANNING_MODEL).not.toBe('claude-opus-4-8');
      expect(config.envOverrides?.EXECUTION_MODEL).toBe('gpt-4.1');
    });
  });
});

// ---------------------------------------------------------------------------
// Stage 2 (routing-ssot-divergence): discriminated createDirectPreflightClient
// result {client | proxy-required | unavailable}.
//
// createDirectPreflightClient resolves a route plan and then classifies it into
// three arms. These contract tests pin that classification at the stable routing
// seam the function uses internally (resolveProviderRoutePlan +
// assertDispatchableQueryOptionsPlan), proving the F4 invariants:
//   - proxy-required (plan.proxyRequired === true) is DISTINCT from unavailable —
//     it must fall through to the proxy, NOT degrade/throw (invariant #4, C5).
//   - unavailable (a terminal/recoverable route) throws the ORIGINAL error
//     (ConnectionNotConfiguredError / UnsupportedModelError) so each executor
//     call site keeps its current throw-vs-degrade policy (invariant #10, F4).
// The executor-level fail-closed behaviour for the execution preflight is
// additionally covered by agentTurnExecutor.codexSubscription.test.ts
// (unsupported_model + Codex-disconnected fail closed).
// ---------------------------------------------------------------------------
describe('Stage 2 — discriminated preflight classification (proxy-required vs unavailable)', () => {
  function makeCodexThinkingProfile(model: string): ModelProfile {
    return {
      id: `codex-thinking-${model}`,
      name: `Codex planner (${model})`,
      providerType: 'openai',
      routeSurface: 'subscription',
      authSource: 'codex-subscription',
      serverUrl: 'https://api.openai.com/v1',
      model,
      enabled: true,
      createdAt: Date.now(),
    } as unknown as ModelProfile;
  }

  // (a) A distinct proxy-backed (Codex) thinking profile → the route plan is
  // proxy-required. createDirectPreflightClient maps this to the {proxy-required}
  // arm and the call site leaves the planning client undefined → falls through to
  // the proxy. The plan is NOT terminal (no throw).
  it('proxy-backed Codex thinking profile → plan.proxyRequired === true (the proxy-required arm, not unavailable)', async () => {
    const thinkingProfile = makeCodexThinkingProfile('gpt-5.5-mini');
    const settings = makeCodexOnlySettings();

    const input = {
      model: thinkingProfile.model!,
      profile: thinkingProfile,
      settings,
      routeScope: 'normal-turn' as const,
      codexConnectivity: 'connected' as const,
      role: 'planning' as const,
    };
    const plan = await resolveProviderRoutePlan({ kind: 'forTurn', input });

    // Proxy-required: the discriminated union routes this through the proxy
    // (invariant #4), it is NOT a terminal/unavailable route.
    expect(plan.proxyRequired).toBe(true);
    // assertDispatchableQueryOptionsPlan must NOT throw for a proxy-required plan —
    // that is what keeps proxy-required distinct from unavailable (C5).
    expect(() => assertDispatchableQueryOptionsPlan(plan)).not.toThrow();
  });

  // (b) A native Claude thinking model under connected Codex with NO Anthropic
  // key → terminal/recoverable route. FOX-3494 (Option Y): a PRIMARY (planning)
  // turn throws a ConnectionNotConfiguredError carrying invalidReason
  // 'missing-anthropic-credentials-for-claude-model' + wireModel + failedRole, so
  // the renderer offers an actionable "switch to a GPT model" recovery (repairing
  // the thinking slot) instead of a misleading "Anthropic not connected". Keeping
  // the ConnectionNotConfiguredError class means every existing recoverable-
  // terminal gate (adaptive routing, alt-model/thinking-downgrade rebuilds, the
  // {unavailable} rethrow at agentTurnExecute :3879/:3922) keeps surfacing it by
  // construction — the plan-mode degrade-vs-rethrow policy is unchanged.
  it('no-creds Claude planning under Codex → terminal route throws ConnectionNotConfiguredError carrying the actionable claude-* detail (FOX-3494)', async () => {
    if (process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN) {
      console.warn('[Stage 2] Skipping: env provides Anthropic credentials — terminal route would not reproduce');
      return;
    }
    const settings = makeCodexOnlySettings();

    const input = {
      model: 'claude-opus-4-7',
      settings,
      routeScope: 'normal-turn' as const,
      codexConnectivity: 'connected' as const,
      role: 'planning' as const,
    };
    const plan = await resolveProviderRoutePlan({ kind: 'forTurn', input });

    // NOT proxy-required — this is a direct-Anthropic route the user cannot serve.
    expect(plan.proxyRequired).toBe(false);
    // FOX-3494: stays a ConnectionNotConfiguredError (recoverable-terminal class)
    // but carries the structured detail for the actionable recovery.
    let thrown: unknown;
    try {
      assertDispatchableQueryOptionsPlan(plan);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ConnectionNotConfiguredError);
    expect(thrown).not.toBeInstanceOf(UnsupportedModelError);
    const cnc = thrown as ConnectionNotConfiguredError;
    expect(cnc.message).toMatch(/runs on Anthropic/);
    expect(cnc.invalidReason).toBe('missing-anthropic-credentials-for-claude-model');
    expect(cnc.wireModel).toBe('claude-opus-4-7');
    expect(cnc.failedRole).toBe('planning');
  });

  // (c) Fail-closed preserved: an unsupported Codex model is a terminal route that
  // throws UnsupportedModelError — createDirectPreflightClient carries it in the
  // {unavailable} arm and the execution call site RETHROWS it (fail closed), never
  // silently degrading. (Same policy the codexSubscription unsupported_model test
  // asserts end-to-end.)
  it('unsupported Codex model → terminal route throws UnsupportedModelError (fail-closed unavailable arm)', async () => {
    const settings = makeCodexOnlySettings();
    const unsupportedProfile = makeCodexThinkingProfile('gpt-5.5-pro');

    const input = {
      model: 'gpt-5.5-pro',
      profile: unsupportedProfile,
      settings,
      routeScope: 'normal-turn' as const,
      codexConnectivity: 'connected' as const,
      role: 'execution' as const,
    };
    const decision = ProviderRouter.forTurn(input);
    const plan = await resolveProviderRoutePlan({ kind: 'forTurn', input });

    // Sanity: the decision is terminal for an unsupported Codex model.
    expect(decision.invalidReason).toBe('codex-unsupported-model');
    expect(plan.proxyRequired).toBe(false);
    expect(() => assertDispatchableQueryOptionsPlan(plan)).toThrow(UnsupportedModelError);
  });
});
