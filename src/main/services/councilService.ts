/**
 * Council Mode Service
 *
 * Builds council-only agent definitions and proxy route table for council mode.
 * When council mode is active, each council-enabled ModelProfile is
 * registered as a subagent using the 'working' alias (resolves to the user's
 * configured working-tier Claude model via resolveModelAlias()), with the actual
 * target model name carried as structured `routedModel` metadata on the agent
 * definition. The routing target is transported to the proxy via headers.
 *
 * This approach:
 * - Removes the 3-member cap (all agents reuse one Claude alias, no alias slot limit)
 * - Eliminates ANTHROPIC_DEFAULT_*_MODEL env var hijacking
 * - Removes the plan mode conflict (no shared env vars)
 * - Supports different server URLs per council member
 *
 * NOTE: The old Claude Agent SDK validated model values via a Zod enum.
 * Rebel Core (which replaced the SDK) uses a TypeScript literal union on
 * RebelCoreAgentDefinition.model but has no runtime Zod validation.
 * The model alias is effectively irrelevant for route-table agents because
 * agentTool.ts uses routingMode === 'council' | 'ad-hoc' (set by queryOptionsBuilder)
 * to force proxy forwarding and overrides the client model to a stable Claude
 * alias. Routing metadata is carried structurally (`routedModel`) and
 * routingMode distinguishes council/ad-hoc route scope for plan headers.
 *
 * See: docs/plans/finished/260209_fix_council_mode_system_prompt_routing.md
 */

import type { AgentDefinition, AgentMcpServerSpec } from '@core/agentRuntimeTypes';
import type { ModelProfile, ModelProviderType, AppSettings } from '@shared/types';
import type { ModelRouteTable } from './localModelProxyServer';
import { getCouncilProfiles, type CouncilProfile } from '@shared/utils/councilProfiles';
import {
  getFunctionalCouncilProfiles,
  getFunctionalRoutingProfiles,
  type ProfileConnectivity,
} from '@shared/utils/connectivityHelpers';
import {
  DEFAULT_MODEL,
  ENV_THINKING_MODEL,
  ENV_EXECUTION_MODEL,
  normalizeModel,
  applyExtendedContextSuffix,
  type ModelConfig,
} from '@shared/utils/modelNormalization';
import { PROVIDER_OPTIONS, getKnownContextWindowForProfile } from '@shared/data/modelProviderPresets';
import { resolveProfileCostTier } from '@shared/utils/pricingCalculator';
import { createScopedLogger } from '@core/logger';
import { getCurrentModel } from '@core/rebelCore/settingsAccessors';
import { getDefaultModelForProvider } from '@shared/utils/getDefaultModelForProvider';
import { assemblePersonaPrompt } from '@core/services/personaPromptAssembly';
import { buildSubagentMemberContext } from './agentContextHelpers';

const log = createScopedLogger({ service: 'councilService' });

/** Tracks models already warned about missing pricing — warn once per process, not per turn. */
const _warnedUnpricedModels = new Set<string>();

export interface CouncilConfig {
  /** Agent definitions to register with the agent query */
  agents: Record<string, AgentDefinition>;
  /** Route table for the multi-route proxy */
  routeTable: ModelRouteTable;
  /** System prompt augmentation instructing the lead agent to use council */
  systemPromptSuffix: string;
  /**
   * The lead agent's model — a full model name (never the plan-mode alias).
   * Normally a Claude model, but it MAY be a non-Claude model for non-Anthropic
   * providers (see `buildCouncilConfig`'s own fallback, which returns
   * `getDefaultModelForProvider(settings,'thinking')` for non-Anthropic
   * providers) or for a non-Claude thinking profile (REBEL-655: the env-derived
   * lead in `resolveCouncilLeadModel` now reflects the user's real thinking
   * model instead of a synthetic Claude sentinel). Do NOT assume Claude here.
   */
  leadModel: string;
}

const ROUTED_SUBAGENT_MODEL_ALIAS = 'working';

export function resolveCouncilLeadModel(modelConfig: ModelConfig, settings: AppSettings): string {
  if (modelConfig.model.startsWith('claude-')) {
    return modelConfig.model;
  }

  const envLeadModel = modelConfig.envOverrides?.[ENV_THINKING_MODEL]
    ?? modelConfig.envOverrides?.[ENV_EXECUTION_MODEL];
  if (envLeadModel) {
    return envLeadModel;
  }

  if (settings.activeProvider === 'anthropic') {
    // eslint-disable-next-line rebel-provider-defaults/no-default-model-literal -- gated on activeProvider === 'anthropic' three lines above; the council lead model is intrinsically Claude in this branch. See docs/plans/260514_openrouter_sonnet_bypass_remediation.md.
    const userModel = normalizeModel(getCurrentModel(settings) ?? DEFAULT_MODEL);
    // eslint-disable-next-line rebel-provider-defaults/no-default-model-literal -- same Anthropic-only branch; non-Claude user model on an Anthropic auth still resolves to a Claude lead. See docs/plans/260514_openrouter_sonnet_bypass_remediation.md.
    const claudeLeadModel = userModel.startsWith('claude-') ? userModel : DEFAULT_MODEL;
    return applyExtendedContextSuffix(claudeLeadModel, true);
  }

  return getDefaultModelForProvider(settings, 'thinking');
}

export { getCouncilProfiles };

/**
 * Get profiles eligible for pre-registration as AI-invocable subagents.
 * Gated on Smart-picking membership (`routingEligible`), not council membership.
 * `councilEnabled` is intentionally narrower — it only controls participation in
 * `//council` parallel fan-out. Smart-picking is the "approved model pool" used
 * both for per-step model selection and for sub-agent delegation in normal turns.
 *
 * See docs/plans/260331_council_ai_invocable_tool.md — Intent & Design Rationale.
 */
export function getPreRegistrableProfiles(
  settings: AppSettings,
  connectivity?: ProfileConnectivity,
): ModelProfile[] {
  return getFunctionalRoutingProfiles(settings, connectivity);
}

/**
 * Build an advisory <council_guidance> system prompt section.
 * Tells the AI about available council members and when to dispatch them all in parallel.
 *
 * This is the advisory counterpart to buildCouncilSystemPrompt():
 * - Advisory (this): AI decides when council is appropriate — used when //council is NOT active
 * - Mandatory (buildCouncilSystemPrompt): forced parallel fan-out — used when //council IS active
 *
 * The two are mutually exclusive per turn. See docs/plans/260331_council_ai_invocable_tool.md.
 */
export function buildCouncilGuidancePrompt(
  agents: Record<string, AgentDefinition>,
  councilProfiles: ModelProfile[],
): string {
  if (councilProfiles.length === 0) return '';

  const councilModelNames = new Set(councilProfiles.map(p => p.model));
  const memberLines: string[] = [];

  for (const [agentName, agentDef] of Object.entries(agents)) {
    const routeModel = typeof agentDef.routedModel === 'string' ? agentDef.routedModel.trim() : '';
    if (routeModel && councilModelNames.has(routeModel)) {
      memberLines.push(`- ${agentName}`);
    }
  }

  if (memberLines.length === 0) return '';

  return [
    '',
    '<council_guidance>',
    'You have a council of alternative AI models available as subagents:',
    ...memberLines,
    '',
    'When a task would significantly benefit from diverse perspectives — complex analysis,',
    'critical decisions, fact verification, or when cross-checking matters — dispatch ALL',
    'council members in parallel via simultaneous Task tool calls, then synthesize their responses.',
    '',
    'Do NOT use for simple queries, routine tasks, or when speed matters more than thoroughness.',
    'After all respond, synthesize: highlight agreements, note disagreements, present a unified answer.',
    'Do not reveal the council mechanism to the user.',
    '</council_guidance>',
  ].join('\n');
}

// =============================================================================
// Available Models Prompt (Turn-Time Injection)
// =============================================================================

/** Map providerType to human-readable label for prompt display. */
function getProviderDisplayLabel(providerType?: ModelProviderType): string {
  const match = PROVIDER_OPTIONS.find(o => o.value === providerType);
  return match?.label ?? 'Other';
}

/** Sanitize profile name for safe prompt injection (strip angle brackets, pipes, quotes, control chars). */
function sanitizeForPrompt(text: string): string {
  return text.replace(/[<>|"]/g, '').replace(/[\x00-\x1f]/g, '').trim();
}

/**
 * Build an <available_models> prompt section describing pre-registered model profiles.
 * Provides metadata (provider family, cost tier, context window) to help orchestrating
 * workflows (Showrunner, etc.) make intelligent model assignment decisions.
 *
 * See docs/plans/260331_always_register_model_profiles.md — Intent & Design Rationale.
 */
export function buildAvailableModelsPrompt(
  agents: Record<string, AgentDefinition>,
  registeredProfiles: ModelProfile[],
): string {
  if (registeredProfiles.length === 0) return '';

  // Build per-profile metadata lines
  const lines: string[] = [];
  for (const profile of registeredProfiles) {
    if (!profile.model) continue;

    // Find the matching agent name for this profile's model
    const agentEntry = Object.entries(agents).find(([, def]) => {
      const routeModel = typeof def.routedModel === 'string' ? def.routedModel.trim() : '';
      return routeModel.length > 0 && routeModel === profile.model;
    });
    if (!agentEntry) continue;
    const [agentName] = agentEntry;

    // Provider family display name
    const providerLabel = getProviderDisplayLabel(profile.providerType);

    // Resolved cost tier (profile override → catalog → local heuristic → null)
    const costTier = resolveProfileCostTier(profile);
    if (!costTier && !_warnedUnpricedModels.has(profile.model)) {
      _warnedUnpricedModels.add(profile.model);
      log.warn(
        { modelName: profile.model, profileId: profile.id, profileName: profile.name },
        'Council model has no pricing in MODEL_CATALOG — cost tier unavailable for routing decisions',
      );
    }

    // Context window (only show if notably large: 500K+)
    const ctxWindow = getKnownContextWindowForProfile(profile);
    const ctxLabel = ctxWindow && ctxWindow >= 500_000
      ? `${Math.round(ctxWindow / 1_000_000 * 10) / 10}M context`
      : null;

    // Build one-line metadata: Name | Provider | cost-tier | context | subagent_type
    const parts = [
      `**${sanitizeForPrompt(profile.name)}**`,
      providerLabel,
      ...(costTier ? [costTier] : []),
      ...(ctxLabel ? [ctxLabel] : []),
    ];
    lines.push(`- ${parts.join(' | ')} | subagent_type: "${agentName}"`);
  }

  if (lines.length === 0) return '';

  return [
    '',
    '<available_models>',
    'Non-Anthropic models available as subagents (dispatch via Task tool):',
    ...lines,
    'Match model capability to the role: use economy models for mechanical gathering and extraction, stronger models for reasoning and review, and when in doubt favour intelligence over minor cost savings.',
    'Claude models (Opus, Sonnet, Haiku) are always available natively.',
    '</available_models>',
  ].join('\n');
}

/**
 * Build the full council configuration for a turn.
 * Returns null if no council members are configured (after validation).
 *
 * Validation performed:
 * - Skips profiles whose model name duplicates an already-registered model (first wins)
 * - Generates unique agent names using profile.id to avoid slug collisions
 */
export function buildCouncilConfig(
  settings: AppSettings,
  baseSystemPrompt: string,
  leadModelOverride?: string,
  mcpServerSpecs?: AgentMcpServerSpec[],
  connectivity?: ProfileConnectivity,
): CouncilConfig | null {
  const councilProfiles = getFunctionalCouncilProfiles(settings, connectivity);
  if (councilProfiles.length === 0) {
    log.info('No council-enabled profiles found');
    return null;
  }

  // Resolve the lead model with provider awareness (bypasses env var alias resolution).
  // When plan mode is active, modelConfig.model is the planner alias — we can't use that.
  // Anthropic: prefer the user's configured Claude model, else DEFAULT_MODEL.
  // Other providers: defer to getDefaultModelForProvider so non-Anthropic providers
  // don't get silently downgraded to a hardcoded Claude default.
  const leadModel =
    leadModelOverride ??
    (settings.activeProvider === 'anthropic'
      ? (() => {
          // eslint-disable-next-line rebel-provider-defaults/no-default-model-literal -- gated on activeProvider === 'anthropic' on the preceding line; lead model is intrinsically Claude in this IIFE. See docs/plans/260514_openrouter_sonnet_bypass_remediation.md.
          const userModel = normalizeModel(getCurrentModel(settings) ?? DEFAULT_MODEL);
          // eslint-disable-next-line rebel-provider-defaults/no-default-model-literal -- same Anthropic-only IIFE; non-Claude user model still resolves to a Claude lead. See docs/plans/260514_openrouter_sonnet_bypass_remediation.md.
          return userModel.startsWith('claude-') ? userModel : DEFAULT_MODEL;
        })()
      : getDefaultModelForProvider(settings, 'thinking'));

  // Build context for council members: full system prompt minus excluded sections.
  // This gives council agents access to spaces, tools, user identity, memory, etc.
  const councilContext = buildSubagentMemberContext(baseSystemPrompt);

  const agents: Record<string, AgentDefinition> = {};
  const routes = new Map<string, ModelProfile>();
  const usedAgentNames = new Set<string>();

  const memberDescriptions: string[] = [];

  for (const profile of councilProfiles) {
    // profile.model is guaranteed non-empty by getCouncilProfiles filter
    const modelName = profile.model;
    if (!modelName) continue;

    // Reject duplicate model names — first profile wins, subsequent are skipped
    if (routes.has(modelName)) {
      log.warn(
        { modelName, profileId: profile.id, profileName: profile.name },
        'Skipping council member: duplicate model name already registered',
      );
      continue;
    }

    // Build a unique agent name using profile.id to avoid slug collisions.
    // Two profiles named "GPT-5" and "GPT 5" would both slugify to "council-gpt-5"
    // without the id suffix. The human-readable slug is kept for log readability.
    const slug = profile.name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    let agentName = `council-${slug}`;
    if (usedAgentNames.has(agentName)) {
      agentName = `council-${slug}-${profile.id.slice(0, 8)}`;
    }
    usedAgentNames.add(agentName);

    // Use 'working' alias to keep SDK-compatible sub-agent definitions while
    // routing is handled by structured routed-model metadata + proxy headers.
    agents[agentName] = {
      description: `Council member running on ${profile.name} (${modelName}). An independent investigator that brings a different perspective.`,
      prompt: assemblePersonaPrompt({
        callerContext: councilContext,
        persona: `You are a council member providing an independent perspective using ${profile.name}.`,
        voiceFraming: [
          'Investigate the user\'s request thoroughly using all available tools.',
          'Focus on being thorough, accurate, and bringing unique insights.',
          'Return a comprehensive response with your findings, reasoning, and conclusions.',
        ],
      }),
      model: ROUTED_SUBAGENT_MODEL_ALIAS,
      routedModel: modelName,
      mcpServers: mcpServerSpecs,
    };

    routes.set(modelName, profile);
    memberDescriptions.push(`- subagent_type: "${agentName}" — ${profile.name} (${modelName})`);

    log.info({ agentName, modelName, profileId: profile.id }, 'Registered council member');
  }

  // All profiles may have been skipped due to validation
  if (memberDescriptions.length === 0) {
    log.warn('All council profiles were skipped during validation (duplicates)');
    return null;
  }

  const systemPromptSuffix = buildCouncilSystemPrompt(memberDescriptions);

  return {
    agents,
    routeTable: { routes },
    systemPromptSuffix,
    leadModel,
  };
}

function buildCouncilSystemPrompt(memberDescriptions: string[]): string {
  const agentTypes = memberDescriptions.map(d => {
    const match = d.match(/subagent_type: "([^"]+)"/);
    return match ? match[1] : '';
  }).filter(Boolean);

  return [
    '',
    '<council_mode>',
    'COUNCIL MODE IS ACTIVE. THIS IS A MANDATORY OVERRIDE — YOU MUST FOLLOW THESE INSTRUCTIONS.',
    '',
    'The following council member subagents are registered and available:',
    ...memberDescriptions,
    '',
    'MANDATORY PROCEDURE (no exceptions, regardless of query complexity):',
    '1. Your VERY FIRST action MUST be to launch ALL council member subagents in PARALLEL.',
    `   You MUST make ${agentTypes.length} simultaneous Task tool calls with these exact subagent_type values:`,
    ...agentTypes.map(t => `   - subagent_type: "${t}"`),
    '   For each, set the prompt to the user\'s full request verbatim.',
    '2. Do NOT answer the user\'s question yourself. Do NOT call any other tool before launching all subagents.',
    '3. After ALL subagents return their results, SYNTHESIZE the findings:',
    '   - Highlight where subagents agree (high confidence).',
    '   - Note any disagreements and pick the strongest reasoning.',
    '   - Present a unified, comprehensive answer.',
    '4. If any subagent fails or times out, proceed with available results and note which were unavailable.',
    '5. Do NOT reveal the internal council mechanism to the user. Present the final answer as your own.',
    '',
    'CRITICAL: The user explicitly activated council mode. They WANT multiple model perspectives.',
    'Skipping subagent dispatch — even for simple queries — violates the user\'s explicit intent.',
    '</council_mode>',
  ].join('\n');
}
