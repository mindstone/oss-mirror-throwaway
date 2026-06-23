/**
 * Tool Safety Service — LLM-based evaluation of tool safety using Claude Haiku.
 * Integrates with Rebel Core's PreToolUse hook pipeline.
 *
 * NON-BLOCKING Architecture (deny + retry):
 * 1. PreToolUse hook fires for every tool call
 * 2. Haiku evaluates risk with user context
 * 3. Decision matrix maps risk to allow/deny/ask
 * 4. If 'ask': DENY immediately, send notification to UI
 * 5. User sees denial card, can click "Allow & Retry"
 * 6. On approval: store for session, renderer sends continuation message
 * 7. Agent retries tool, now pre-approved, executes successfully
 *
 * This design avoids timeout issues in the tool permission flow and handles
 * parallel sub-agents gracefully (all denied, all show in UI).
 *
 * @see docs/project/SAFETY_SYSTEM_OVERVIEW.md — safety architecture map
 * @see docs/project/TOOL_SAFETY.md — tool-risk policy and UX contract
 * @see docs/project/ARCHITECTURE_AGENT_TURN_EXECUTION.md — PreToolUse hook context
 */

import { runProbe } from '@main/services/processProbe';
import type {
  HookCallback,
  HookJSONOutput,
  CanUseTool,
  PermissionResult,
  PermissionUpdate,
} from '@core/agentRuntimeTypes';
import type { EventWindow } from '@core/types';
import type { AppSettings, ModelProfile, ToolSafetyLevel, TrustedTool } from '@shared/types';
import { type SystemSkillsSettings } from '@shared/systemSkills';
import { bareToolId, type BareToolId } from '@shared/utils/trustedToolNormalization';
import { isProfileReferencedInSettings } from '@shared/utils/cleanupOrphanedProfileReferences';
import { isProfileReference, profileReferenceId } from '@core/rebelCore/providerRouteDecision';
import { createScopedLogger, type TurnSessionLogger } from '@core/logger';
import { getRebelAuthProvider } from '@core/rebelAuth';
import { agentTurnRegistry } from '@core/services/agentTurnRegistry';
import {
  type RiskLevel,
  type RiskAssessment,
  addPendingApproval,
  removePendingApproval,
  getPendingApprovals,
  clearPendingApprovalsForSession,
  clearPendingMemoryApprovalsForSession,
  // Single-use approvals for "Allow once" behavior
  storeSingleUseApproval,
  consumeSingleUseApproval,
  clearSessionSingleUseApprovals,
} from '@main/services/safety';
import {
  checkPythonRuntime,
  MACOS_CLT_SHIM_BINARY_NAMES,
  macosCommandResolvesToCltShim,
} from '@main/services/pythonRuntimeService';
import { getIncrementalSessionStore } from '@core/services/incrementalSessionStore';
import {
  stageToolCall,
  buildToolDisplayName,
  clearSessionStagedCalls,
  getPendingStagedCalls,
  type StageToolCallInput,
} from '@main/services/safety/stagedToolCallsService';
import {
  isDeterministicallyReadOnly,
  isBlockedTool,
  isConsentRequiredTool,
  requiresSafetyPromptPolicyCheck,
  normalizeToSnakeCase,
} from '@core/services/safety/toolVerbs';
import {
  FILE_WRITE_TOOLS,
  EVALUATION_ERROR_PREFIX,
  CIRCUIT_BREAKER_DENIAL_PREFIX,
} from '@core/services/safety/constants';
import {
  buildSettingsSpaceCandidates,
  extractDominantBashTargetPath,
  extractBashWriteTargets,
  isPrivateOrChiefOfStaffSpace,
  normalizeSharingClass,
  normalizeSafetyPath,
  resolveSettingsSpaceForPath,
  type SettingsSpaceCandidate,
} from '@core/services/safety/bashTargetSpace';
import { resolveAlias } from '@core/services/toolAliasCache';
import { getToolDescription } from '@core/services/toolDescriptionCache';
import { INTERNAL_MCP_SERVER_NAMES } from '@main/services/bundledMcpManager';
import { CLAUDE_TIERS } from '@shared/data/qualityTiers';
import { isAlwaysOnThinkingCatalogModel } from '@shared/data/modelCatalog';
import { trackItem } from '@main/services/safety/automationPendingItemsTracker';
import { evaluateSafetyPrompt, shouldAllow, clearCache as clearSafetyPromptCache } from '@core/safetyPromptLogic';
import { applyChatIntentRulePersistence } from '@core/services/safety/chatIntentRulePersistence';
import {
  clearSession as clearSessionToolDecisionCache,
  getCachedAllow as getCachedSafetyAllow,
  invalidateByToolFamily as invalidateSafetyCacheByToolFamily,
  recordAllow as recordSafetyAllow,
} from '@core/services/safety/sessionToolDecisionCache';
import { buildNormalizedToolKey, canonicalArgsJSON, getToolFamily } from '@core/services/safety/toolNormalizationKeys';
import {
  extractUserIntent,
  type UserIntentExtractionResult,
  type UserIntentExtractorCache,
} from '@core/services/safety/userIntentExtractor';
import {
  TOOL_SAFETY_EVALUATING_CHANNEL,
  TOOL_SAFETY_EVALUATING_COMPLETE_CHANNEL,
  type ToolSafetyEvaluatingPayload,
  type ToolSafetyEvaluatingCompletePayload,
} from '@shared/ipc/channels/safety';
import { SAFETY_PROMPT_RULE_PERSISTED_CHANNEL } from '@shared/ipc/channels/safetyPrompt';
import { getSafetyPrompt, getSafetyPromptVersion, isMigrationComplete } from '@core/safetyPromptStore';
import type {
  ActionContext,
  ActionContextSessionIntent,
  ActionContextSpaceSharing,
  ActionContextUserIntentExplicit,
  SafetyEvalResult,
} from '@core/safetyPromptTypes';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';
import { getAutomationContext } from '@main/services/safety/automationContextLookup';
import { readSpaceReadmeBody, readSpaceReadmeFrontmatter } from '@main/services/spaceService';
import { addEvaluationEntry } from '@core/safetyActivityLogStore';
import { getBroadcastService } from '@core/broadcastService';
import { broadcastTypedPayload } from '@shared/ipc/broadcasts';
import { sanitizeToolInputForApproval } from '@main/services/safety/sanitizeApprovalInput';
import {
  getCohabitedTrustApprovalOverride,
  getInboundAutoApproveDecision,
  type ToolApprovalContext,
} from '@core/services/safety/connectorApprovalGates';
import {
  BROWSER_FILL_FORM_TOOL,
  BROWSER_CLICK_TOOL,
  backfillToolBlockSource,
  fnvHashBase36,
  preprocessBrowserToolInputForLlm,
  ToolBlockSourceSchema,
  type ToolBlockSource,
} from '@rebel/shared';
import { classifySessionKind } from '@shared/sessionKind';
import { classifyFailClosed, resolveFailClosedDisposition } from '@core/services/safety/failClosedPolicy';
import { classifyBlockedPathDisposition } from '@core/services/safety/blockedPathRouter';
import { buildEvalErrorAgentReason, buildEvalErrorUserReason } from '@shared/safety/evalErrorCopy';
import { assertNever } from '@shared/utils/assertNever';

const logger = createScopedLogger({ service: 'toolSafetyService' });

const CHAT_INTENT_BANNED_TRIGGER_PATTERNS: ReadonlyArray<RegExp> = [
  /\brm\s+-rf\b/i,
  /\bdelete everything\b/i,
  /\ballow everything\b/i,
  /\bblock everything\b/i,
  /\bstop checking\b/i,
  /\bdisable (?:all )?(?:safety|checks)\b/i,
];

const INTERNAL_MCP_SERVER_NAMES_SET = new Set<string>(INTERNAL_MCP_SERVER_NAMES);

type CliToolApprovalRoutingResult = {
  approved: boolean;
  output: HookJSONOutput;
};

function containsBannedChatIntentTrigger(triggerPhrase: string): boolean {
  return CHAT_INTENT_BANNED_TRIGGER_PATTERNS.some((pattern) => pattern.test(triggerPhrase));
}

function logChatIntentPersistenceSkipped(
  log: Pick<TurnSessionLogger, 'info'>,
  data: {
    reason:
      | 'feature_flag_off'
      | 'broad_scope_pending_picker_ui'
      | 'adversarial_trigger_phrase';
    confidence: 'high' | 'medium' | 'low';
    scopeHint: 'trusted_tool' | 'broad' | 'specific';
    toolName: string;
    effectiveToolId: string;
    triggerPhraseLength: number;
  },
): void {
  log.info(
    {
      event: 'chat_intent_rule_persistence_skipped',
      source: 'chat-intent',
      ...data,
    },
    'Chat intent rule persistence skipped',
  );
}

function maybePersistChatIntentRule({
  settings,
  evalResult,
  actionContext,
  toolName,
  effectiveToolId,
  log,
}: {
  settings: AppSettings;
  evalResult: SafetyEvalResult;
  actionContext: ActionContext;
  toolName: string;
  effectiveToolId: string;
  log: Pick<TurnSessionLogger, 'info' | 'warn'>;
}): void {
  const intentSignal = evalResult.persistenceIntent;
  if (intentSignal?.detected !== true) {
    return;
  }

  const triggerPhraseLength = intentSignal.triggerPhrase.length;
  if (settings.chatIntentRulePersistence === false) {
    logChatIntentPersistenceSkipped(log, {
      reason: 'feature_flag_off',
      confidence: intentSignal.confidence,
      scopeHint: intentSignal.scopeHint,
      toolName,
      effectiveToolId,
      triggerPhraseLength,
    });
    return;
  }

  if (containsBannedChatIntentTrigger(intentSignal.triggerPhrase)) {
    logChatIntentPersistenceSkipped(log, {
      reason: 'adversarial_trigger_phrase',
      confidence: intentSignal.confidence,
      scopeHint: intentSignal.scopeHint,
      toolName,
      effectiveToolId,
      triggerPhraseLength,
    });
    return;
  }

  if (intentSignal.confidence !== 'high' || intentSignal.scopeHint !== 'specific') {
    logChatIntentPersistenceSkipped(log, {
      reason: 'broad_scope_pending_picker_ui',
      confidence: intentSignal.confidence,
      scopeHint: intentSignal.scopeHint,
      toolName,
      effectiveToolId,
      triggerPhraseLength,
    });
    return;
  }

  void applyChatIntentRulePersistence({
    blockedAction: {
      ...actionContext,
      blockReason: evalResult.reason,
    },
    intentSignal,
    userMessage: actionContext.userMessage ?? '',
    persistMode: 'auto',
  })
    .then((result) => {
      if (result.status !== 'applied') {
        return;
      }
      getBroadcastService().sendToAllWindows(SAFETY_PROMPT_RULE_PERSISTED_CHANNEL, {
        version: result.version,
        lastUpdatedAt: result.lastUpdatedAt,
        source: result.source,
        summary: result.update.summary,
        proposedPrinciple: result.update.proposedPrinciple,
      });
    })
    .catch((error) => {
      log.warn(
        {
          event: 'chat_intent_rule_persistence_error',
          source: 'chat-intent',
          err: error,
          toolName,
          effectiveToolId,
          confidence: intentSignal.confidence,
          scopeHint: intentSignal.scopeHint,
        },
        'Chat intent rule persistence failed after allow',
      );
    });
}

/**
 * Headless (CLI / cloud) approval routing.
 *
 * When the active turn registers a non-UI approval handler (e.g. CLI mode, cloud
 * service that surfaces approvals to the mobile client), we short-circuit the
 * normal staging-UI flow and ask the handler directly. Returns `null` when no
 * handler is registered (caller falls back to the staging-UI flow).
 *
 * Failure of the handler is fail-closed: returns a deny output. This keeps the
 * promise-based handler error path from accidentally allowing a tool.
 */
async function routeToolSafetyApprovalHandler(params: {
  turnId: string | undefined;
  toolName: string;
  toolInput: unknown;
  reason: string;
  signal: AbortSignal;
  log: Pick<TurnSessionLogger, 'info' | 'warn'>;
}): Promise<CliToolApprovalRoutingResult | null> {
  const { turnId, toolName, toolInput, reason, signal, log } = params;
  if (!turnId) return null;
  const approvalHandler = typeof agentTurnRegistry.getApprovalHandler === 'function'
    ? agentTurnRegistry.getApprovalHandler(turnId)
    : undefined;
  if (!approvalHandler) return null;

  let decision: { approved: boolean; reason?: string };
  try {
    decision = await approvalHandler(
      { kind: 'tool_safety', toolName, toolInput, reason },
      signal,
    );
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.warn({ turnId, toolName, err: errMsg }, 'Tool safety approval handler threw; failing closed (deny)');
    agentTurnRegistry.recordSecurityDenial(turnId, toolName, `approval_handler_error: ${errMsg}`);
    return {
      approved: false,
      output: {
        continue: false,
        hookSpecificOutput: {
          hookEventName: 'PreToolUse' as const,
          permissionDecision: 'deny' as const,
          permissionDecisionReason: `Approval handler error: ${errMsg}`,
        },
      },
    };
  }
  if (decision.approved) {
    log.info({ turnId, toolName }, 'Tool safety approved in-place by headless approval handler');
    return {
      approved: true,
      output: {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse' as const,
          permissionDecision: 'allow' as const,
          permissionDecisionReason: 'Approved by headless approval handler',
        },
      },
    };
  }

  const denyReason = decision.reason ?? 'denied';
  log.info({ turnId, toolName, reason: denyReason }, 'Tool safety denied by headless approval handler');
  agentTurnRegistry.recordSecurityDenial(turnId, toolName, denyReason);
  return {
    approved: false,
    output: {
      continue: false,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse' as const,
        permissionDecision: 'deny' as const,
        permissionDecisionReason: denyReason,
      },
    },
  };
}

// =============================================================================
// Tool-Specific Types and Storage
// =============================================================================

// Metadata for pending approval requests: toolUseID -> { sessionId, toolIdentifier }
// toolIdentifier is the effective identifier (inner tool_id for use_tool, otherwise tool_name)
// Used to store session approval when user clicks "Allow & Retry"
const pendingApprovalMetadata = new Map<string, { sessionId: string; toolIdentifier: string }>();

/**
 * Get full metadata for a pending tool approval (sessionId + effective tool identifier).
 * Checks in-memory metadata first, falls back to persisted store.
 * Used by agentHandlers to clear parallel approvals when "Allow for conversation" is clicked.
 */
export function getPendingToolApprovalMetadata(toolUseID: string): { sessionId: string; toolIdentifier: string } | undefined {
  // Try in-memory metadata first
  const metadata = pendingApprovalMetadata.get(toolUseID);
  if (metadata) {
    return metadata;
  }
  // Fall back to persisted store (e.g., after app restart)
  const persisted = getPendingApprovals().find((p) => p.toolUseID === toolUseID);
  if (persisted?.sessionId) {
    const effectiveToolId = persisted.effectiveToolId || getEffectiveToolIdentifier(persisted.toolName, persisted.input);
    return {
      sessionId: persisted.sessionId,
      toolIdentifier: effectiveToolId,
    };
  }
  return undefined;
}

/**
 * Clear in-memory metadata for multiple tool approvals.
 */
export function clearPendingApprovalMetadata(toolUseIDs: string[]): void {
  for (const toolUseID of toolUseIDs) {
    pendingApprovalMetadata.delete(toolUseID);
  }
}

// Tracks turns that have a tool waiting for approval.
// Tracks turns that have been hard-blocked (e.g. by Safety Prompt for automations).
// Tool safety approvals no longer use this — they are non-blocking.
const turnsWithPendingApproval = new Set<string>();

/**
 * Residual fallback denial emitted when the Safety evaluator could not decide
 * and we have no ask/stage path for this tool/session combination (for example
 * non-MCP tools in no-human sessions).
 * Interactive/automation MCP eval-error flows now route to ASK/STAGE with
 * `blockedBy: 'eval_error'`; this string is only for the no-human deny branch.
 *
 * See: docs-private/investigations/260416_stale_pending_approvals_when_conversation_moves_on.md
 */
function buildFailClosedDenyReason(toolName: string): string {
  return `SAFETY EVALUATOR TEMPORARILY UNAVAILABLE

"${toolName}" was NOT executed because the safety check could not complete. No approval has been requested from the user — there is nothing in the Notifications drawer for them to act on.

Do NOT tell the user you are waiting for their approval and do NOT retry this tool in this turn.

If the user explicitly asked for this action, briefly let them know the safety check could not finish and that you can rerun the safety check if they ask you to continue. Otherwise, continue with anything else you can do.`;
}

/**
 * Safety-eval progress broadcast helper. Keeps the fire sites terse and
 * guarantees a matching `-complete` is always broadcast on every exit (success,
 * block, abort, error) even if the eval body throws.
 *
 * The renderer clears its per-toolUseId in-flight map on either `-complete` or
 * `stage: 'end'`, so missing a `-complete` would leak a stale subline until
 * the tool result arrives. Callers should always use `try / finally` around
 * the eval await and broadcast the correct outcome.
 */
function broadcastSafetyEvaluating(payload: ToolSafetyEvaluatingPayload): void {
  try {
    getBroadcastService().sendToAllWindows(TOOL_SAFETY_EVALUATING_CHANNEL, payload);
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err), toolUseId: payload.toolUseId }, 'Failed to broadcast tool-safety:evaluating');
  }
}

function broadcastSafetyEvaluatingComplete(payload: ToolSafetyEvaluatingCompletePayload): void {
  try {
    getBroadcastService().sendToAllWindows(TOOL_SAFETY_EVALUATING_COMPLETE_CHANNEL, payload);
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err), toolUseId: payload.toolUseId }, 'Failed to broadcast tool-safety:evaluating-complete');
  }
}

function getRouterToolInput(toolName: string, toolInput: unknown): Record<string, unknown> | null {
  if (
    toolName !== 'mcp__super-mcp-router__use_tool'
    && toolName !== 'use_tool'
  ) {
    return null;
  }
  if (!toolInput || typeof toolInput !== 'object') {
    return null;
  }
  return toolInput as Record<string, unknown>;
}

/**
 * Get the effective tool identifier for approval storage.
 * For MCP router use_tool calls, returns the inner tool_id.
 * For other tools, returns the tool name.
 * @internal Exported for testing
 */
export function getEffectiveToolIdentifier(toolName: string, toolInput: unknown): BareToolId {
  const input = getRouterToolInput(toolName, toolInput);

  if (input) {
    const innerToolId = input.tool_id as string | undefined;
    if (innerToolId) {
      // Resolve alias to canonical name via pre-populated cache.
      // If cache is empty or no alias exists, returns innerToolId unchanged (graceful fallback).
      const packageId = input.package_id as string | undefined;
      if (packageId) {
        return resolveAlias(packageId, innerToolId) as BareToolId;
      }
      return innerToolId as BareToolId;
    }
  }
  return toolName as BareToolId;
}

/**
 * Get the conversation title for a session.
 * Returns undefined if session not found or on error.
 */
function getSessionTitle(sessionId: string | undefined): string | undefined {
  if (!sessionId || sessionId === 'unknown') return undefined;
  try {
    // Approval UX only needs user-visible sessions.
    const sessions = getIncrementalSessionStore().listSessions();
    const summary = sessions.find(s => s.id === sessionId);
    return summary?.title ?? undefined;
  } catch (error) {
    logger.warn({ err: error, sessionId }, 'Failed to lookup session title for tool approval');
    return undefined;
  }
}

/**
 * Extract package name from tool input for router calls.
 * Formats package_id nicely (e.g., "Gmail", "LinearApi" → "Linear Api").
 */
function extractPackageName(toolName: string, toolInput: unknown): string | undefined {
  const input = getRouterToolInput(toolName, toolInput);
  if (!input) return undefined;
  const packageId = input.package_id as string | undefined;
  
  if (!packageId) return undefined;
  
  // Add spaces before capital letters for camelCase (e.g., "LinearApi" → "Linear Api")
  return packageId.replace(/([a-z])([A-Z])/g, '$1 $2');
}

/**
 * Extract MCP execution payload from tool input.
 * For router use_tool calls, extracts package_id, tool_id, and args.
 * Returns null for non-router tools (they can't be staged via direct MCP execution).
 */
function extractMcpPayload(toolName: string, toolInput: unknown): StageToolCallInput['mcpPayload'] | null {
  const input = getRouterToolInput(toolName, toolInput);
  if (!input) return null;
  const packageId = input.package_id as string | undefined;
  const toolId = input.tool_id as string | undefined;
  const args = input.args as Record<string, unknown> | undefined;
  
  if (!packageId || !toolId) return null;
  
  // Resolve alias to canonical name so staged call storage, approval keying,
  // and display all use the canonical tool name consistently.
  const canonicalToolId = resolveAlias(packageId, toolId);
  
  return {
    packageId,
    toolId: canonicalToolId,
    args: args ?? {},
  };
}

function getRouterPackageId(toolName: string, toolInput: unknown): string | undefined {
  const input = getRouterToolInput(toolName, toolInput);
  return typeof input?.package_id === 'string' ? input.package_id : undefined;
}

function getRouterArgs(toolName: string, toolInput: unknown): Record<string, unknown> {
  const input = getRouterToolInput(toolName, toolInput);
  const args = input?.args;
  return args && typeof args === 'object' ? args as Record<string, unknown> : {};
}

/** Result of the RebelSettings cost-escalation check. */
export interface RebelSettingsCostEscalation {
  /** Premium (always-on-thinking) model ids the requested change would activate. */
  premiumModels: string[];
  /** User-facing reason surfaced on the approval card. */
  reason: string;
}

/**
 * Settings slice the cost-escalation gate resolves profile references against.
 *
 * IMPORTANT — callers inside the safety hook must pass LIVE settings (the
 * same `getSettings()` store the bridge in inboxBridgeStateMachine.ts
 * validates and writes against), not the hook's turn-start snapshot: a
 * same-turn `edit_model_profile` can re-point an existing profile at a
 * premium model, and a snapshot would let the subsequent role assignment
 * resolve the stale non-premium profile while the bridge writes the edited
 * premium one (GPT stage-13 review F2 race). See `ToolSafetyHookOptions.getLiveSettings`.
 */
export type RebelSettingsCostGateSettings = Pick<
  AppSettings,
  | 'localModel'
  | 'models'
  | 'behindTheScenesModel'
  | 'backgroundFallback'
  | 'behindTheScenesOverrides'
  | 'localInferenceCloudFallback'
>;

/**
 * Cost-escalation gate for agent-invokable RebelSettings model tools.
 *
 * Rebel-internal MCP tools are normally auto-allowed (they manage app-internal
 * state), but the RebelSettings model tools write the user's global model
 * settings, and can move a model role onto a premium always-on-thinking model
 * (catalog `thinkingAlwaysOn`, e.g. Claude Fable 5 at ~2x Opus price). That is
 * a spend decision, not app-internal state — it must go through explicit user
 * approval rather than the internal auto-allow bypass.
 *
 * Gated tools — every agent-invokable route that can change which model a
 * role resolves to (the bridge routes in inboxBridgeStateMachine.ts are the
 * write surface of record):
 * - `set_quality_tier`: tier ids resolve to models through `CLAUDE_TIERS`.
 * - `set_model_roles`: bare ids and `profile:<id>` refs for all three roles.
 * - `activate_model_profile`: assigns a profile to working/thinking — the
 *   same spend decision as a profile ref via set_model_roles (GPT stage-13
 *   review F2). `profileId: null` DEACTIVATES (reverts to Claude) → never an
 *   escalation. Disabled profiles still escalate (the bridge may 400 them,
 *   but approval-before-no-op beats auto-allow racing a same-turn enable).
 * - `edit_model_profile`: editing a ROLE-ASSIGNED profile's `model` re-prices
 *   that role in place — role pointers survive edits, so no later gated call
 *   would fire. Edits to unassigned profiles keep auto-allow (activation is
 *   where the spend decision lands, and that is gated).
 * - `add_model_profile`: the bridge UPSERTS BY NAME — re-adding the name of a
 *   role-assigned profile rewrites its model in place, the same silent
 *   re-pricing as edit. Fresh names / unassigned upserts keep auto-allow.
 *
 * Deliberately catalog-driven: premium-ness comes from the catalog
 * `thinkingAlwaysOn` flag via the alias-complete
 * `isAlwaysOnThinkingCatalogModel()`, NOT from hardcoded 'frontier'/'fable'
 * strings, so the next premium model is covered by construction.
 *
 * `profile:<id>` references are dereferenced against `settings` (which MUST
 * be live — see `RebelSettingsCostGateSettings`). Unknown profile ids change
 * nothing (the bridge 400s them), so they keep today's auto-allow, mirroring
 * the unknown-tier-id rule.
 *
 * Scope is escalation-only: every other invocation (existing non-premium
 * tiers, non-premium role/profile changes, unknown tier ids — which the
 * bridge rejects without changing anything) keeps today's auto-allow behavior.
 * See docs/plans/260611_fable-5-support/PLAN.md Stage 11 (GPT review F1),
 * Stage 13 (GPT stage-12 review F1/F2), Stage 14 (GPT stage-13 review F2),
 * and Stage 15 (GPT stage-14 review F1/F2 — role-assignment predicate derived
 * from the shared profile-reference enumeration).
 *
 * @internal Exported for testing.
 */
export function getRebelSettingsCostEscalation(
  packageId: string | undefined,
  effectiveToolId: string,
  args: Record<string, unknown>,
  settings?: RebelSettingsCostGateSettings,
): RebelSettingsCostEscalation | null {
  if (packageId !== 'RebelSettings') return null;

  const profiles: readonly ModelProfile[] | undefined = settings?.localModel?.profiles;

  // Does `profileId` currently feed any model role? DERIVED from the shared
  // profile-reference enumeration (`PROFILE_REFERENCE_FIELDS` in
  // cleanupOrphanedProfileReferences.ts — the SSOT for every settings field
  // that can hold a profile reference) plus the two runtime role surfaces the
  // helper layers on top (legacy active-profile fallback, per-task BTS
  // overrides). A hand-rolled list here drifted twice (GPT stage-14 review
  // F1/F2: longContextFallbackProfileId, localInferenceCloudFallback) — any
  // future field added to the enumeration is covered here automatically, and
  // the drift-lock test in toolSafetyService.test.ts locks the two together.
  // Editing a profile referenced from ANY of these re-prices a role without a
  // further gated call.
  const isRoleAssignedProfile = (profileId: string): boolean =>
    !!settings && isProfileReferencedInSettings(settings, profileId);

  let candidateModels: string[];
  if (effectiveToolId.includes('rebel_settings_set_quality_tier')) {
    const tierId = typeof args.tier === 'string' ? args.tier : undefined;
    const tier = tierId ? CLAUDE_TIERS.find((t) => t.id === tierId) : undefined;
    // Unknown tier ids change nothing (the bridge 400s them), so they keep
    // today's auto-allow rather than broadening the approval surface.
    if (!tier) return null;
    candidateModels = [tier.workingModel, tier.thinkingModel].filter(
      (m): m is string => typeof m === 'string',
    );
  } else if (effectiveToolId.includes('rebel_settings_set_model_roles')) {
    candidateModels = (['working', 'thinking', 'background'] as const)
      .map((role) => args[role])
      .filter((m): m is string => typeof m === 'string');
  } else if (effectiveToolId.includes('rebel_settings_activate_model_profile')) {
    const profileId =
      typeof args.profileId === 'string' && args.profileId.trim() ? args.profileId : undefined;
    // null/absent profileId deactivates the role (reverts to Claude) — a cost
    // DECREASE, never an escalation.
    if (!profileId) return null;
    candidateModels = [`profile:${profileId}`];
  } else if (effectiveToolId.includes('rebel_settings_edit_model_profile')) {
    const profileId = typeof args.profileId === 'string' ? args.profileId : undefined;
    const newModel = typeof args.model === 'string' && args.model.trim() ? args.model.trim() : undefined;
    // Only gate edits that set a model on a profile some role currently
    // resolves through; everything else (rename, apiKey, clearing the model,
    // unassigned profiles) keeps auto-allow.
    if (!profileId || !newModel || !isRoleAssignedProfile(profileId)) return null;
    candidateModels = [newModel];
  } else if (effectiveToolId.includes('rebel_settings_add_model_profile')) {
    const name = typeof args.name === 'string' ? args.name.trim() : undefined;
    const newModel = typeof args.model === 'string' && args.model.trim() ? args.model.trim() : undefined;
    if (!name || !newModel) return null;
    // The bridge upserts by name: only an upsert onto a role-assigned
    // existing profile changes what a role resolves to. New profiles are
    // inert until a (gated) activation/role assignment.
    const existing = profiles?.find((p) => p.name === name);
    if (!existing || !isRoleAssignedProfile(existing.id)) return null;
    candidateModels = [newModel];
  } else {
    return null;
  }

  // Dereference `profile:<id>` role values to the wrapped model id. Unknown
  // profile ids resolve to undefined → not premium → auto-allow (the bridge
  // 400s them without changing settings, same as unknown tier ids).
  const resolveCandidateModel = (value: string): string | undefined => {
    if (!isProfileReference(value)) return value;
    const profileId = profileReferenceId(value) ?? '';
    return profiles?.find((p) => p.id === profileId)?.model?.trim() || undefined;
  };

  const premiumModels = Array.from(
    new Set(
      candidateModels
        .map(resolveCandidateModel)
        .filter((m): m is string => m !== undefined && isAlwaysOnThinkingCatalogModel(m)),
    ),
  );
  if (premiumModels.length === 0) return null;

  return {
    premiumModels,
    reason: `This changes your AI model to ${premiumModels.join(', ')} — a premium model that costs significantly more than the standard tiers. Changes that raise your costs need your explicit approval.`,
  };
}

function buildToolApprovalContext(
  toolName: string,
  effectiveToolId: string,
  packageId: string | undefined,
  toolInput: unknown,
): ToolApprovalContext {
  return {
    toolName,
    effectiveToolId,
    packageId,
    routerPackageId: getRouterPackageId(toolName, toolInput),
    routerArgs: getRouterArgs(toolName, toolInput),
  };
}

interface StageEvalErrorMcpParams {
  mcpPayload: StageToolCallInput['mcpPayload'];
  toolInput: unknown;
  toolName: string;
  effectiveToolId: string;
  sessionId: string | undefined;
  turnId: string | undefined;
  toolUseId: string;
  sessionKind: ReturnType<typeof classifySessionKind>;
  disposition: ReturnType<typeof resolveFailClosedDisposition>;
  source: 'fail_closed' | 'throw';
  failClosedReason?: SafetyEvalResult['failClosedReason'];
  failClosedCategory?: 'infra' | 'rate-limited';
  memoizationKey?: string | null;
  automationId?: string;
  automationName?: string;
  emitStagedComplete: () => void;
  log: Pick<TurnSessionLogger, 'info'>;
}

function stageEvalErrorMcp(params: StageEvalErrorMcpParams): HookJSONOutput {
  const {
    mcpPayload,
    toolInput,
    toolName,
    effectiveToolId,
    sessionId,
    turnId,
    toolUseId,
    sessionKind,
    disposition,
    source,
    failClosedReason,
    failClosedCategory,
    memoizationKey,
    automationId,
    automationName,
    emitStagedComplete,
    log,
  } = params;
  const displayName = buildToolDisplayName(mcpPayload.packageId, mcpPayload.toolId, mcpPayload.args);
  const stagedReason = buildEvalErrorUserReason();
  const stagedAgentReason = buildEvalErrorAgentReason(displayName);
  const stagingBlockedBy = 'eval_error' as const;
  const stagingAllowPermanentTrust = false;
  const stagingSessionId = sessionId ?? 'unknown';
  const stagingTurnId = turnId ?? '';
  const argsAwareFallbackKey = fnvHashBase36(canonicalArgsJSON({
    packageId: mcpPayload.packageId,
    toolId: mcpPayload.toolId,
    args: mcpPayload.args,
  }));
  const coalesceKey = `eval_error:${effectiveToolId}:${memoizationKey ?? argsAwareFallbackKey}`;

  const stagingResult = stageToolCall({
    sessionId: stagingSessionId,
    turnId: stagingTurnId,
    mcpPayload,
    displayName,
    toolCategory: 'side-effect',
    riskLevel: 'high',
    reason: stagedReason,
    allowPermanentTrust: stagingAllowPermanentTrust,
    blockedBy: stagingBlockedBy,
    coalesceKey,
    automationId,
    automationName,
  });
  const stagedCall = stagingResult.call;

  broadcastTypedPayload(getBroadcastService(), 'tool-safety:staged-call', {
    id: stagedCall.id,
    sessionId: stagingSessionId,
    displayName,
    packageId: mcpPayload.packageId,
    toolId: mcpPayload.toolId,
    riskLevel: 'high',
    reason: stagedReason,
    timestamp: stagedCall.timestamp,
    allowPermanentTrust: stagingAllowPermanentTrust,
    blockedBy: stagingBlockedBy,
    automationId,
    automationName,
  });

  if (automationId) {
    trackItem(automationId, stagedCall.id, 'staged-tool', {
      toolName: mcpPayload.toolId,
      inputSummary: JSON.stringify(mcpPayload.args).slice(0, 200),
    });
  }
  if (automationId && turnId) {
    // Automation scheduler status/retry wiring keys off security denials.
    // Record an honest eval-error denial (no circuit-breaker prefix).
    agentTurnRegistry.recordSecurityDenial(turnId, effectiveToolId, stagedAgentReason);
  }

  log.info(
    {
      event: 'tool_safety_eval_error_staged',
      source,
      toolName,
      effectiveToolId,
      packageId: mcpPayload.packageId,
      toolId: mcpPayload.toolId,
      sessionId,
      turnId,
      failClosedReason,
      failClosedCategory,
      sessionKind,
      disposition,
      toolUseId,
      stagedCallId: stagedCall.id,
      coalesced: stagingResult.coalesced,
      coalesceKey,
    },
    'Safety evaluator unavailable for MCP tool - staged with eval_error',
  );

  const { _rebel_staged: _, _rebel_staged_message: _unused, ...sanitizedInput } = toolInput as Record<string, unknown>;
  emitStagedComplete();
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse' as const,
      permissionDecision: 'allow' as const,
      updatedInput: {
        ...sanitizedInput,
        _rebel_staged: true,
        _rebel_staged_message: stagedAgentReason,
      },
    },
  };
}

// =============================================================================
// Metadata Skip List (Prefix Matching - LLM handles the rest)
// =============================================================================

/**
 * Skip list for obvious metadata/discovery operations.
 * These are clearly read-only, so we skip the LLM call to save cost.
 * 
 * For everything else, the LLM evaluates and the PROMPT handles the logic of
 * distinguishing actions (side effects) from metadata (read-only).
 * 
 * This approach:
 * - Uses simple string contains/startsWith (no complex regex)
 * - Scales automatically to new integrations
 * - Lets the LLM handle nuance and edge cases
 * - Prompt is the source of truth for classification logic
 */

// Top-level tool names that are always metadata or planning (exact match)
// These tools have no external side effects and should never be flagged
const SKIP_TOOL_NAMES = new Set([
  // Super-MCP router metadata tools (read-only discovery/diagnostics, no side effects)
  'mcp__super-mcp-router__list_tool_packages',
  'mcp__super-mcp-router__list_tools',
  'mcp__super-mcp-router__search_tools',
  'mcp__super-mcp-router__health_check_all',
  'mcp__super-mcp-router__health_check',
  'mcp__super-mcp-router__get_help',
  'mcp__super-mcp-router__get_tool_details',
  // Rebel-internal settings tools that must bypass safety prompt loops
  'rebel_safety_prompt_get',
  'rebel_safety_prompt_update',
  // Planning/delegation tools - no direct side effects, only orchestration
  // The LLM was incorrectly flagging these as HIGH risk when task content mentioned
  // action words like "phone call" - but creating a task is not executing an action.
  // 'Task' and 'Agent' are subagent launchers — actual side effects are evaluated inside the subagent.
  'Task',
  'Agent',
  'TaskCreate',
  'TaskList',
  'TaskGet',
  'TaskUpdate',
  'TodoWrite',  // Legacy, kept for backwards compatibility
  'TodoRead',   // Legacy, kept for backwards compatibility
  // UI signal tool — surfaces the OSS connector setup card without side effects.
  'suggest_connector_setup',
  // User-facing question tool — no side effects, just presents a question to the user.
  // The LLM was incorrectly flagging this as HIGH risk when question content mentioned
  // action words like "automation" or "schedule" — but asking a question is not executing an action.
  'AskUserQuestion',
  // Subagent orchestration tools — internal task store only, no external side effects.
  // SummarizeResult writes findings to in-memory shared task store for parent agent.
  // MissionSet/GetMissionContext/GetPreviousTasks manage mission context and task history.
  'SummarizeResult',
  'MissionSet',
  'GetMissionContext',
  'GetPreviousTasks',
  // Read-only built-in tools - these are always low risk (file reading, search, listing)
  // Added per turn timing analysis: these were consuming unnecessary LLM evaluations
  'Read',
  'Grep',
  'Glob',
  'LS',
  'TaskOutput',
  // Read-only built-in tools — SearchFiles is deterministically safe
  'SearchFiles',
  // In-app Rebel screenshot capture uses an explicit get_* verb and has no external side effects.
  'rebel_get_app_screenshot',
  // Internal app-surface navigation only changes the local Rebel view for visual verification.
  'rebel_navigate_app',
  // Cross-turn awareness inspection tools — deterministic transcript reads, no
  // external side effects. They cannot exfiltrate data (read-only over the
  // current session's own transcript) and cannot mutate state. See
  // docs/plans/260525_cross_turn_awareness_layer1_layer2.md (D9, D11).
  'inspect_prior_turns',
  'get_tool_call',
  // NOTE: WebSearch and WebFetch are intentionally NOT skipped here.
  // They go through LLM evaluation to catch data exfiltration attempts
  // (e.g., encoding secrets in search queries or fetching attacker-controlled URLs).
  // WebFetch is NOT in AUTOMATION_SAFE due to exfiltration risk.
  // The safety prompt guides Haiku to rate normal searches as LOW risk.
]);

// Read-only built-in tools that are safe to auto-allow in automations without
// Safety Prompt evaluation. These are intentionally NOT in SKIP_TOOL_NAMES
// (interactive sessions still get LLM exfiltration checking), but for
// automations the Safety Prompt doesn't need to evaluate read-only queries.
const AUTOMATION_SAFE_BUILTIN_TOOLS = new Set(['WebSearch']);

// Sensitive substrings - tools containing these should NEVER be auto-skipped
// These indicate tools that handle credentials, secrets, or sensitive data
// Must be checked BEFORE verb-based auto-skip to prevent data exfiltration
const SENSITIVE_SUBSTRINGS = [
  'token', 'secret', 'password', 'credential', 'key', 'auth', 'bearer',
  'apikey', 'api_key', 'private_key', 'refresh_token', 'access_token',
  'cookie', 'session', 'otp', 'client_secret'
];

/**
 * Router packages whose read/discovery tools are always treated as
 * metadata-safe when they are deterministically read-only.
 *
 * This is positive evidence (known-safe package family), not a wildcard for
 * arbitrary packages.
 */
const TRUSTED_METADATA_PACKAGES = new Set([
  'super-mcp-router',
  'rebelmcpconnectors',
  'rebelmcpnotifications',
  'rebelsettings',
  'rebelspaces',
  'rebelmeetings',
  'rebelautocontinue',
  'rebelappbridge',
]);

const EXTERNAL_CRUD_VERB_PATTERNS = ['send', 'post', 'create', 'delete', 'update'].map(
  (verb) => new RegExp(`(?:^|_)${verb}(?:_|$)`),
);

function hasExternalCrudVerb(toolId: string): boolean {
  const normalized = normalizeToSnakeCase(toolId);
  return EXTERNAL_CRUD_VERB_PATTERNS.some((pattern) => pattern.test(normalized));
}

function hasTrustedMetadataPackage(packageId: string): boolean {
  return TRUSTED_METADATA_PACKAGES.has(packageId.toLowerCase());
}

// =============================================================================
// Bash Command Safety Heuristics
// =============================================================================

// Read-only shell commands that cannot modify state when used standalone
// These are ONLY safe when they appear as the first command without dangerous operators
// IMPORTANT: Only include commands that are ALWAYS read-only regardless of flags
const BASH_READONLY_COMMANDS = new Set([
  // File/directory inspection (truly read-only)
  'ls', 'cat', 'head', 'tail', 'less', 'more', 'file', 'stat', 'wc',
  'locate', 'which', 'whereis', 'type', 'readlink',
  // Text processing (read-only, no in-place edit capability)
  // NOTE: sed, awk removed - they have -i flags for in-place editing
  // NOTE: find, fd, sort, rg/ripgrep are handled by CONDITIONALLY_SAFE_COMMANDS
  'grep', 'egrep', 'fgrep', 'cut', 'tr',
  'diff', 'comm', 'join', 'paste', 'fold', 'fmt', 'column',
  // Text output (always read-only — writes to stdout only, no file output flags)
  'uniq',
  // System info
  'pwd', 'whoami', 'id', 'groups', 'hostname', 'uname', 'date', 'cal',
  'uptime', 'w', 'who', 'last', 'df', 'du', 'free', 'top', 'ps', 'pgrep',
  // Environment
  'env', 'printenv', 'echo', 'printf',
  // Network inspection (read-only)
  'ping', 'traceroute', 'host', 'dig', 'nslookup', 'netstat', 'ss', 'ifconfig', 'ip',
  // Archive inspection ONLY (list contents, not extract)
  // NOTE: tar, unzip, gzip, gunzip removed - they can extract/modify files
  'zipinfo', 'zcat',
  // Other safe commands
  'man', 'help', 'true', 'false', 'test', '[', 'basename', 'dirname', 'realpath',
]);

// Dangerous patterns that should ALWAYS trigger LLM evaluation
// Even if the command starts with a safe verb, these patterns are risky
// NOTE: Simple pipes (|) are handled separately — safe read-only pipe chains are
// allowed, but pipes to unsafe commands are blocked.
// PIPE_PATTERN is extracted so the pipe-specific branch can identify it by reference.
const PIPE_PATTERN = /\|/;

// Router-side parity: identify inner tool IDs that wrap a Bash/shell command surface
// so the same per-command safety check can run before falling through to LLM eval.
// Kept narrow on purpose; the skip is positive-evidence-only (requires
// isBashCommandSafeToSkip to also return true), so a slightly broader match here
// only opens the deterministic-safe surface, never new attack surface.
const BASH_LIKE_INNER_TOOL_ID_PATTERN = /(?:^|[_.\-:/])(?:bash|sh|shell|run_command|run_shell|execute_command|execute_shell|terminal)(?:$|[_.\-:/])/i;

const BASH_SENSITIVE_PATH_PATTERNS = [
  /(?:^|[\s<>=])\/+(?:private\/+etc|etc)(?:\/+|\b)/i,
  /(?:^|[\s<>=])\/+var\/+/i,
  /(?:^|[\s<>=])\/+System\/+/i,
  /(?:^|[\s<>=])\/+Library\/+/i,
  // Dotfiles (home directory config files)
  /(?:^|[\s<>=])(?:~|\$HOME|\$\{HOME\})\/+\.[^/\s]/,
];

const BASH_DANGEROUS_PATTERNS = [
  // File modification/deletion
  /\brm\b/, /\brmdir\b/, /\bmv\b/, /\bcp\b/,
  // Output redirection (can overwrite files)
  // NOTE: 2>/dev/null is stripped before pattern checks, so it won't match here
  />/, />>/, 
  // Command chaining (subsequent commands could be dangerous)
  /;/, /&&/, /\|\|/,
  // Newlines act like semicolons in shell - can chain dangerous commands
  /\n/,
  // Pipes (output could go to dangerous commands — safe read-only pipe chains
  // are handled separately via PIPE_PATTERN detection below)
  PIPE_PATTERN,
  // Subshells and command substitution
  /\$\(/, /`/,
  // Process substitution (can execute arbitrary commands)
  /<\(/, />\(/,
  // Shell code execution built-ins
  /\beval\b/, /\bsource\b/, /^\s*\.\s/,
  // Privilege escalation
  /\bsudo\b/, /\bsu\b/, /\bdoas\b/,
  // Permission changes
  /\bchmod\b/, /\bchown\b/, /\bchgrp\b/,
  // Network operations that send data
  /\bcurl\b/, /\bwget\b/, /\bscp\b/, /\brsync\b/, /\bsftp\b/, /\bftp\b/,
  // Process control
  /\bkill\b/, /\bkillall\b/, /\bpkill\b/,
  // System modification
  /\bmkdir\b/, /\btouch\b/, /\bln\b/, /\bmount\b/, /\bumount\b/,
  // Dangerous utilities
  /\bdd\b/, /\bmkfs\b/, /\bfdisk\b/, /\bparted\b/,
  // Package managers
  /\bapt\b/, /\bapt-get\b/, /\byum\b/, /\bdnf\b/, /\bbrew\b/, /\bnpm\b/, /\bpip\b/,
  // Editors (interactive, could modify)
  /\bvi\b/, /\bvim\b/, /\bnano\b/, /\bemacs\b/,
  // Tools with dangerous flags that were removed from the always-safe list
  // NOTE: find, fd, sort, rg/ripgrep, sed, and tar are handled by CONDITIONALLY_SAFE_COMMANDS.
  //       gzip, gunzip, and unzip are handled by SAFE_FLAG_REQUIRED_COMMANDS (default
  //       invocation IS destructive; we only allow explicit listing/test/stdout modes).
  // awk-family tools (awk/gawk/mawk/nawk) stay unconditional because script bodies can hide
  // destructive primitives (system(...), print > "...", getline ... | "...") that this shell-
  // layer scanner cannot see after stripQuotedStringContent blanks quoted content.
  // Do NOT harmonize these with sed — the asymmetry is deliberate.
  /\bawk\b/, /\bgawk\b/, /\bmawk\b/, /\bnawk\b/,
  // xargs can execute arbitrary commands
  /\bxargs\b/,
  // tee writes to files
  /\btee\b/,
  // Sensitive paths as arguments (not as command location)
  // We check for paths that appear after whitespace or at the start, to avoid blocking
  // commands located in /usr/bin/, /bin/, etc.
  // Match: space/tab followed by sensitive path, OR sensitive path as entire arg
  ...BASH_SENSITIVE_PATH_PATTERNS,
];

const BASH_SENSITIVE_PATH_PATTERN_SET = new Set<RegExp>(BASH_SENSITIVE_PATH_PATTERNS);

/**
 * Commands that are safe UNLESS they contain specific dangerous flags.
 * Each entry maps a command name to an array of regex patterns for flags
 * that make the command dangerous. If none of the dangerous flag patterns
 * match the full command string, the command is considered read-only.
 *
 * This avoids blanket-blocking commands like `find` that are overwhelmingly
 * used for read-only listing, while still catching genuinely dangerous
 * invocations like `find -delete` or `find -exec rm`.
 */
const CONDITIONALLY_SAFE_COMMANDS: Record<string, RegExp[]> = {
  // find: dangerous with -delete, -exec, -execdir, -ok, -okdir, -fprint variants
  'find': [
    /\s-delete\b/,
    /\s-exec\b/, /\s-execdir\b/,
    /\s-ok\b/, /\s-okdir\b/,
    /\s-fprint\b/, /\s-fls\b/, /\s-fprintf\b/, /\s-fprint0\b/,
  ],
  // fd (fd-find): safe unless using -x/--exec or -X/--exec-batch
  'fd': [/\s-x\b/, /\s--exec\b/, /\s-X\b/, /\s--exec-batch\b/],
  // sort: dangerous with -o (output to file). Pattern uses [^\s] after -o to catch
  // both separated (`-o file`) and concatenated (`-ofile`) POSIX forms.
  'sort': [/\s-o(?:\s|[^\s-])/, /\s--output\b/],
  // rg/ripgrep: --pre flag executes an external preprocessor command
  'rg': [/\s--pre\b/, /\s--pre-glob\b/],
  'ripgrep': [/\s--pre\b/, /\s--pre-glob\b/],
  // Stage 1 + Phase-4 review: docs/plans/260527_bash_safety_sed_readonly.md
  // sed is dangerous for in-place edits (`-i` standalone or anywhere inside a
  // short-flag cluster — `-Ei`, `-ni`, `-nri`, `-ibak`, `-i.bak`, `-i ''`,
  // `--in-place`, `--in-place=.bak`).
  // Script `w` writes (line, numeric, standalone, negation forms), quoted-flag
  // evasion (`'-i'`, `"-i"`, `$'-i'`), and shell-escape evasion (`\-i`) are
  // addressed by `containsSedWriteDirective` / `containsQuoteWrappedSedFlag` /
  // `containsShellEscapedSedFlag` below.
  'sed': [
    /(?:^|\s)-[A-Za-z]*i(?:[A-Za-z]*\b|\.[^\s]+)/,
    /\s--in-place\b/,
  ],
};

/**
 * Commands where the DEFAULT invocation is destructive (writes/replaces files),
 * or where the safe modes are easier to enumerate than the dangerous ones.
 * Allow only when at least one `safe` pattern matches AND none of the `deny`
 * patterns match.
 *
 * Used in addition to BASH_READONLY_COMMANDS / CONDITIONALLY_SAFE_COMMANDS — a
 * base verb listed here must satisfy both halves of its spec to be considered
 * read-only.
 *
 * Stage 3 + Phase 4 review: docs/plans/260527_bash_safety_sed_readonly.md.
 */
type SafeFlagSpec = { safe: ReadonlyArray<RegExp>; deny: ReadonlyArray<RegExp> };

const SAFE_FLAG_REQUIRED_COMMANDS: Record<string, SafeFlagSpec> = {
  // gzip default: compresses input file, replaces with .gz, removes original.
  // Safe modes: -l/--list (list contents), -t/--test (integrity check),
  // -L/--license (print license info — pure stdout).
  // Pattern matches the safe letter anywhere inside a `-…` flag cluster
  // (e.g. `-lv` clusters l + v; the `l` is what makes it safe).
  'gzip': {
    safe: [/(?:^|\s)-[A-Za-z]*[ltL]/, /\s--list\b/, /\s--test\b/, /\s--license\b/],
    deny: [],
  },
  // gunzip default: decompresses, replaces .gz with uncompressed file.
  // Safe modes: -l (list), -t (test), -L (license).
  'gunzip': {
    safe: [/(?:^|\s)-[A-Za-z]*[ltL]/, /\s--list\b/, /\s--test\b/, /\s--license\b/],
    deny: [],
  },
  // unzip default: extracts to current directory.
  // Safe modes: -l (list), -v (verbose list), -t (test), -p (pipe to stdout
  // without extracting), -Z (zipinfo mode — pure listing).
  // Deny: -T sets the timestamp on the archive itself (mtime change on the
  // user's .zip file). Marginal but classed as a write side-effect.
  'unzip': {
    safe: [/(?:^|\s)-[A-Za-z]*[lvtpZ]/, /\s--list\b/, /\s--test\b/],
    deny: [/(?:^|\s)-[A-Za-z]*T/],
  },
  // tar (Phase-4 review): switched to safe-flag-required model so the gate
  // doesn't depend on flag ordering or first-arg-only matching. Safe only if a
  // listing flag is explicitly present, and the deny list still fires when any
  // destructive or command-execution hook appears anywhere in the segment.
  // GNU tar's `--checkpoint-action=exec=…`, `-I/--use-compress-program`,
  // `--rmt-command`, and `--to-command` can execute arbitrary commands during
  // even an otherwise-listing operation, so they must always force LLM eval.
  // The dashless legacy form (`tar tf`, `tar xvf`) is detected by a separate
  // pattern that requires the first arg to be a pure-letter cluster.
  'tar': {
    safe: [/(?:^|\s)-[A-Za-z]*t[A-Za-z]*/, /\s--list\b/, /\btar\s+(?=[A-Za-z]+\b)[A-Za-z]*t[A-Za-z]*/],
    deny: [
      /(?:^|\s)-[A-Za-z]*[xcruA]/,
      /\btar\s+(?=[A-Za-z]+\b)[A-Za-z]*[xcruA][A-Za-z]*/,
      /\s--extract\b/, /\s--create\b/, /\s--append\b/, /\s--update\b/,
      /\s--delete\b/, /\s--concatenate\b/, /\s--catenate\b/,
      /\s--checkpoint-action\b/, /\s--use-compress-program\b/,
      /\s--rmt-command\b/, /\s--to-command\b/,
      /(?:^|\s)-I\b/,
      /\bTAR_OPTIONS=/,
    ],
  },
};

/**
 * Extract the base command verb from a shell command segment,
 * skipping common prefixes (env, time, etc.) and env variable assignments.
 * Returns the lowercase base command name (path-stripped).
 */
function extractBaseCommand(segment: string): string {
  const words = segment.trim().split(/\s+/);
  const prefixes = ['env', 'time', 'nice', 'nohup', 'timeout'];
  let wordIndex = 0;
  while (wordIndex < words.length && prefixes.includes(words[wordIndex])) {
    wordIndex++;
  }
  while (wordIndex < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[wordIndex])) {
    wordIndex++;
  }
  const commandVerb = wordIndex < words.length ? words[wordIndex] : words[0];
  const baseCommand = commandVerb.split('/').pop() || commandVerb;
  return baseCommand.toLowerCase();
}

/**
 * Replace the *content* of single-quoted and double-quoted strings with spaces,
 * preserving the quote characters themselves and the overall string length.
 *
 * This is the prerequisite step for any quote-aware shell metacharacter check.
 * Without it, regex literals like `'A|B|C'` or `'rm -rf'` look identical to real
 * shell operators / dangerous verbs when scanned with `/\|/` or `/\brm\b/`.
 *
 * - Single quotes in bash are literal: every byte until the closing `'` is data.
 *   No escapes are honoured. We replace every interior byte with a single space.
 * - Double quotes honour `\` escapes for `\\`, `\"`, `\$`, `\` and newline. For our
 *   purposes we only need to consume both bytes of a `\<char>` pair so quote
 *   tracking does not desync. The escaped pair is also replaced with two spaces.
 * - Backslash in NORMAL state escapes the next byte (e.g. `\|` is an escaped pipe
 *   that should not count as a real shell pipe). Both bytes become spaces.
 *
 * Returns `null` if the string has unbalanced quoting — callers should treat
 * that as a parse failure and fail closed.
 */
function stripQuotedStringContent(input: string): string | null {
  const out: string[] = [];
  let state: 'normal' | 'single' | 'double' = 'normal';
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (state === 'normal') {
      if (ch === "'") {
        out.push("'");
        state = 'single';
        i += 1;
        continue;
      }
      if (ch === '"') {
        out.push('"');
        state = 'double';
        i += 1;
        continue;
      }
      if (ch === '\\' && i + 1 < input.length) {
        out.push(' ', ' ');
        i += 2;
        continue;
      }
      out.push(ch);
      i += 1;
      continue;
    }
    if (state === 'single') {
      if (ch === "'") {
        out.push("'");
        state = 'normal';
        i += 1;
        continue;
      }
      out.push(' ');
      i += 1;
      continue;
    }
    if (ch === '\\' && i + 1 < input.length) {
      out.push(' ', ' ');
      i += 2;
      continue;
    }
    if (ch === '"') {
      out.push('"');
      state = 'normal';
      i += 1;
      continue;
    }
    out.push(' ');
    i += 1;
  }
  if (state !== 'normal') {
    return null;
  }
  return out.join('');
}

// Stage 2 + Phase-4 review: docs/plans/260527_bash_safety_sed_readonly.md
// `sed` script-`w` directive detector. The script body is single- or double-quoted,
// so `stripQuotedStringContent` blanks it before the per-segment flag scan runs —
// any `w outfile` write directive inside the quoted script would otherwise sail
// through the deterministic gate. We scan the *raw* (unstripped) segment for any
// quoted region matching the directive shape.
//
// Caught forms:
//   sed '/pattern/w outfile' input         (line-write after /regex/ address)
//   sed '/pattern/!w outfile' input        (negated-address line-write)
//   sed 's/x/y/w outfile' input            (substitution-write)
//   sed 's/x/y/gw outfile' input           (substitution-write with flags)
//   sed '1w outfile' input                 (numeric-address line-write)
//   sed '1,5w outfile' input               (range-address line-write)
//   sed -e 'w outfile' input               (standalone w command)
//
// Residual (rare; the LLM evaluator catches these one layer down):
//   sed s/x/y/w\ outfile input             (UNQUOTED script — full-segment scan
//                                           too false-positive-prone on paths
//                                           containing `/w<space>`)
//   sed -f - file <<EOF\ns/x/y/w out\nEOF  (heredoc script body — no quoted
//                                           region; pre-existing limitation)
const SED_SCRIPT_WRITE_DIRECTIVE_PATTERNS: ReadonlyArray<RegExp> = [
  // /regex/[flags][!] w outfile or s<delim>...<delim>...<delim>[flags]w outfile
  // (any non-alnum sed delimiter — sed accepts /, #, |, _, , : and more; we
  // cover a conservative explicit set). Phase-4c tightened this to drop the
  // inner `\s*` between flags and `w` because that was matching `s/x/ w y/`
  // where ` w ` lives inside the replacement; sed requires `w` to be adjacent
  // to the flag chars (with optional `!` negation marker).
  /[/#|_,:][gimsxIM0-9]*!?w\s+\S/,
  // numeric / range / $ line-address w outfile. Anchor class limited to
  // `;{'"` (no `\s`) so a literal ` 1w ` inside a replacement (`s/x/ 1w y/`)
  // does not fire — sed addresses appear at script start, after `;`, after
  // `{`, or directly after the script-opening quote, never after a bare space.
  /(?:^|[;{'"])(?:\d+|\$)(?:,(?:\d+|\$))?\s*!?\s*w\s+\S/,
  // standalone w command at script start. Same anchor as above for the same
  // FP reason on `s/x/ w out/`.
  /(?:^|[;{'"])!?\s*w\s+\S/,
];

function containsSedWriteDirective(rawSegment: string): boolean {
  if (!/\bsed\b/.test(rawSegment)) return false;
  const quotedRegions = rawSegment.match(/'[^']*'|"[^"]*"/g);
  if (!quotedRegions) return false;
  return quotedRegions.some((region) =>
    SED_SCRIPT_WRITE_DIRECTIVE_PATTERNS.some((p) => p.test(region)),
  );
}

// Phase-4c review: GNU sed's `e` flag/command shells out to execute arbitrary
// commands — `sed 's/.*/echo hi/e' file` executes the substituted text, and
// `sed 'e id' file` runs `id` for each input line. This is a trivial RCE that
// must NOT skip LLM eval. Pattern shape mirrors the `w` directive detector:
// substitution `e` flag after a delimiter, plus standalone `e` command after a
// script-start anchor. The first pattern requires `e\b` so a literal `e` inside
// a replacement (e.g. `s/foo/end/`) doesn't fire — flags appear AFTER the
// terminating delimiter, not inside the replacement.
const SED_SCRIPT_EXEC_DIRECTIVE_PATTERNS: ReadonlyArray<RegExp> = [
  // Substitution e flag: <delim>[flags]e<word-boundary>
  /[/#|_,:][gimsxIM0-9]*e\b/,
  // Standalone e command with explicit argument: e <cmd> or addressed
  /(?:^|[;{'"])(?:\d+(?:,(?:\d+|\$))?|\$)?\s*e\s+\S/,
];

function containsSedExecDirective(rawSegment: string): boolean {
  if (!/\bsed\b/.test(rawSegment)) return false;
  const quotedRegions = rawSegment.match(/'[^']*'|"[^"]*"/g);
  if (!quotedRegions) return false;
  return quotedRegions.some((region) =>
    SED_SCRIPT_EXEC_DIRECTIVE_PATTERNS.some((p) => p.test(region)),
  );
}

// Stage 2 + Phase-4 review: standalone-quoted-flag evasion. `sed '-i' '...'`
// looks identical to `sed s/foo/bar/ '...'` once `stripQuotedStringContent`
// blanks the quoted bytes, so the existing `-i`-cluster flag scan misses it.
// We match the very specific shape of a quoted argument whose entire content is
// the dangerous flag — this avoids false positives on benign script bodies that
// happen to mention `-i` (e.g. `sed 's/-i//' file`, where the `-i` is inside a
// longer quoted region). Also covers ANSI-C `$'...'` and dollar-double `$"..."`
// quoting forms that bash unwraps before passing to sed.
const QUOTE_WRAPPED_SED_DANGEROUS_FLAG_PATTERNS: ReadonlyArray<RegExp> = [
  // Standalone or clustered -i with optional .<suffix>, inside single, double,
  // or $'…'/$"…" quotes. Catches '-i', '-Ei', '-ibak', '-Ei.bak', etc.
  // The cluster + suffix combination (e.g. '-Ei.bak') was flagged by Phase-4
  // re-review as a real evasion path.
  /(?:^|\s)\$?'-[A-Za-z]*i(?:[A-Za-z]*|\.[^'\s]+)'(?=\s|$)/,
  /(?:^|\s)\$?"-[A-Za-z]*i(?:[A-Za-z]*|\.[^"\s]+)"(?=\s|$)/,
  // --in-place long form (with optional =suffix), quoted.
  /(?:^|\s)\$?'--in-place(?:=[^'\s]*)?'(?=\s|$)/,
  /(?:^|\s)\$?"--in-place(?:=[^"\s]*)?"(?=\s|$)/,
];

function containsQuoteWrappedSedFlag(rawSegment: string): boolean {
  if (!/\bsed\b/.test(rawSegment)) return false;
  return QUOTE_WRAPPED_SED_DANGEROUS_FLAG_PATTERNS.some((p) => p.test(rawSegment));
}

// Phase-4 review + re-review: shell-escape evasion. `sed \-i 's/x/y/' file` is
// parsed by bash as `sed -i ...` (backslash escapes the dash, but the resulting
// argument bytes are still `-i`). `stripQuotedStringContent` collapses the `\-`
// pair to two blanks, which would otherwise bypass the in-place flag scan.
// Matched against the RAW (pre-strip) segment. Covers clustered short forms
// (e.g. `\-Ei`, `\-ibak`) symmetrically with the unescaped clustered patterns.
const SHELL_ESCAPED_SED_DANGEROUS_FLAG_PATTERNS: ReadonlyArray<RegExp> = [
  /(?:^|\s)\\-[A-Za-z]*i(?:[A-Za-z]*(?=\s|$)|\.[^\s]+)/,
  /(?:^|\s)\\--in-place\b/,
];

function containsShellEscapedSedFlag(rawSegment: string): boolean {
  if (!/\bsed\b/.test(rawSegment)) return false;
  return SHELL_ESCAPED_SED_DANGEROUS_FLAG_PATTERNS.some((p) => p.test(rawSegment));
}

function decodeAnsiCQuotedChar(input: string, start: number): { value: string; next: number } | null {
  const ch = input[start];
  if (ch === undefined) return null;
  const standardEscapes: Record<string, string> = {
    a: '\u0007',
    b: '\b',
    e: '\u001B',
    E: '\u001B',
    f: '\f',
    n: '\n',
    r: '\r',
    t: '\t',
    v: '\v',
    '\\': '\\',
    "'": "'",
    '"': '"',
    '?': '?',
  };
  if (Object.hasOwn(standardEscapes, ch)) {
    return { value: standardEscapes[ch], next: start + 1 };
  }
  if (ch === 'x') {
    const match = input.slice(start + 1).match(/^[0-9A-Fa-f]{1,2}/);
    if (!match) return null;
    const value = codePointToString(parseInt(match[0], 16));
    if (value === null) return null;
    return { value, next: start + 1 + match[0].length };
  }
  if (ch === 'u') {
    const hex = input.slice(start + 1, start + 5);
    if (!/^[0-9A-Fa-f]{4}$/.test(hex)) return null;
    const value = codePointToString(parseInt(hex, 16));
    if (value === null) return null;
    return { value, next: start + 5 };
  }
  if (ch === 'U') {
    const hex = input.slice(start + 1, start + 9);
    if (!/^[0-9A-Fa-f]{8}$/.test(hex)) return null;
    const value = codePointToString(parseInt(hex, 16));
    if (value === null) return null;
    return { value, next: start + 9 };
  }
  if (/[0-7]/.test(ch)) {
    const match = input.slice(start).match(/^[0-7]{1,3}/);
    if (!match) return null;
    const value = codePointToString(parseInt(match[0], 8));
    if (value === null) return null;
    return { value, next: start + match[0].length };
  }
  return { value: ch, next: start + 1 };
}

function codePointToString(codePoint: number): string | null {
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10FFFF) return null;
  return String.fromCodePoint(codePoint);
}

// Phase-4 re-review + Phase-4c: a quote-removing variant of
// stripQuotedStringContent that drops surrounding `'` / `"` / `$'…'` / `$"…"`
// characters but KEEPS the bytes between them. Used for command-specific deny
// scans where the dangerous flag may have been quoted by an adversary
// (e.g. `tar -tf x.tar "--checkpoint-action=exec=id"` or the ANSI-C variant
// `tar -tf x.tar $'--checkpoint-action=exec=id'`).
// ANSI-C `$'…'` content is decoded before scanning so escaped dashes cannot hide
// flags like `$'\x2di'` or `$'\x2d\x2dpre=cat'`.
// Backslash-newline pairs are elided (bash line-continuation semantics) so the
// dangerous token gets reassembled before deny scanning. Other backslash
// escapes in normal / double-quote state are unwrapped so the resulting string
// contains the same bytes bash would pass to the underlying tool.
// Returns null on unbalanced quoting (callers should treat as fail-closed).
function stripQuoteCharsOnly(input: string): string | null {
  const out: string[] = [];
  let state: 'normal' | 'single' | 'double' | 'ansiSingle' = 'normal';
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (state === 'normal') {
      // ANSI-C ($'…') and dollar-double ($"…") quoting: bash strips the $
      // prefix along with the surrounding quotes, so the dequote does the same.
      if (ch === '$' && i + 1 < input.length && (input[i + 1] === "'" || input[i + 1] === '"')) {
        state = input[i + 1] === "'" ? 'ansiSingle' : 'double';
        i += 2;
        continue;
      }
      if (ch === "'") { state = 'single'; i += 1; continue; }
      if (ch === '"') { state = 'double'; i += 1; continue; }
      if (ch === '\\' && i + 1 < input.length) {
        // Backslash-newline = line continuation: bash drops the pair entirely.
        if (input[i + 1] === '\n') { i += 2; continue; }
        out.push(input[i + 1]); i += 2; continue;
      }
      out.push(ch); i += 1; continue;
    }
    if (state === 'single') {
      if (ch === "'") { state = 'normal'; i += 1; continue; }
      out.push(ch); i += 1; continue;
    }
    if (state === 'ansiSingle') {
      if (ch === "'") { state = 'normal'; i += 1; continue; }
      if (ch === '\\') {
        const decoded = decodeAnsiCQuotedChar(input, i + 1);
        if (decoded === null) return null;
        out.push(decoded.value);
        i = decoded.next;
        continue;
      }
      out.push(ch); i += 1; continue;
    }
    if (ch === '\\' && i + 1 < input.length) {
      if (input[i + 1] === '\n') { i += 2; continue; }
      out.push(input[i + 1]); i += 2; continue;
    }
    if (ch === '"') { state = 'normal'; i += 1; continue; }
    out.push(ch); i += 1;
  }
  if (state !== 'normal') return null;
  return out.join('');
}

const BRACE_EXPANSION_PASS_CAP = 8;
const BRACE_EXPANSION_VARIANT_CAP = 32;
// One outer expression plus up to two nested brace-expression levels.
const BRACE_EXPANSION_NESTING_CAP = 3;

type BraceExpansionExpression = {
  open: number;
  close: number;
  alternatives: string[];
};

function skipSingleQuoted(input: string, start: number): number {
  const close = input.indexOf("'", start + 1);
  return close === -1 ? input.length : close + 1;
}

function skipDoubleQuoted(input: string, start: number): number {
  let i = start + 1;
  while (i < input.length) {
    if (input[i] === '\\' && i + 1 < input.length) {
      i += 2;
      continue;
    }
    if (input[i] === '"') return i + 1;
    i += 1;
  }
  return input.length;
}

function skipBracedParameterExpansion(input: string, start: number): number {
  let depth = 1;
  let i = start + 2;
  while (i < input.length) {
    if (input[i] === '\\' && i + 1 < input.length) {
      i += 2;
      continue;
    }
    if (input[i] === '{') {
      depth += 1;
      i += 1;
      continue;
    }
    if (input[i] === '}') {
      depth -= 1;
      i += 1;
      if (depth === 0) return i;
      continue;
    }
    i += 1;
  }
  return input.length;
}

function findMatchingBrace(input: string, open: number): { close: number; maxDepth: number } | null {
  let depth = 1;
  let maxDepth = 1;
  let i = open + 1;
  while (i < input.length) {
    const ch = input[i];
    if (ch === '\\' && i + 1 < input.length) {
      i += 2;
      continue;
    }
    if (ch === "'") {
      i = skipSingleQuoted(input, i);
      continue;
    }
    if (ch === '"') {
      i = skipDoubleQuoted(input, i);
      continue;
    }
    if (ch === '$' && input[i + 1] === '{') {
      i = skipBracedParameterExpansion(input, i);
      continue;
    }
    if (ch === '{') {
      depth += 1;
      maxDepth = Math.max(maxDepth, depth);
      i += 1;
      continue;
    }
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return { close: i, maxDepth };
      i += 1;
      continue;
    }
    i += 1;
  }
  return null;
}

function splitTopLevelBraceAlternatives(body: string): string[] | null {
  const alternatives: string[] = [];
  let depth = 0;
  let start = 0;
  let sawComma = false;
  let i = 0;
  while (i < body.length) {
    const ch = body[i];
    if (ch === '\\' && i + 1 < body.length) {
      i += 2;
      continue;
    }
    if (ch === "'") {
      i = skipSingleQuoted(body, i);
      continue;
    }
    if (ch === '"') {
      i = skipDoubleQuoted(body, i);
      continue;
    }
    if (ch === '$' && body[i + 1] === '{') {
      i = skipBracedParameterExpansion(body, i);
      continue;
    }
    if (ch === '{') {
      depth += 1;
      i += 1;
      continue;
    }
    if (ch === '}') {
      depth -= 1;
      i += 1;
      continue;
    }
    if (ch === ',' && depth === 0) {
      alternatives.push(body.slice(start, i));
      start = i + 1;
      sawComma = true;
    }
    i += 1;
  }
  if (!sawComma) return null;
  alternatives.push(body.slice(start));
  return alternatives;
}

function hasTopLevelBraceRangeOperator(body: string): boolean {
  let depth = 0;
  let i = 0;
  while (i < body.length - 1) {
    const ch = body[i];
    if (ch === '\\' && i + 1 < body.length) {
      i += 2;
      continue;
    }
    if (ch === "'") {
      i = skipSingleQuoted(body, i);
      continue;
    }
    if (ch === '"') {
      i = skipDoubleQuoted(body, i);
      continue;
    }
    if (ch === '$' && body[i + 1] === '{') {
      i = skipBracedParameterExpansion(body, i);
      continue;
    }
    if (ch === '{') {
      depth += 1;
      i += 1;
      continue;
    }
    if (ch === '}') {
      depth -= 1;
      i += 1;
      continue;
    }
    if (ch === '.' && body[i + 1] === '.' && depth === 0) return true;
    i += 1;
  }
  return false;
}

function expandSimpleBraceRange(body: string): string[] | null {
  const numeric = body.match(/^(-?\d+)\.\.(-?\d+)$/);
  if (numeric) {
    const start = Number(numeric[1]);
    const end = Number(numeric[2]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null;
    const step = start <= end ? 1 : -1;
    const count = Math.abs(end - start) + 1;
    if (count > BRACE_EXPANSION_VARIANT_CAP) return null;
    return Array.from({ length: count }, (_, index) => String(start + index * step));
  }

  const chars = body.match(/^([A-Za-z])\.\.([A-Za-z])$/);
  if (!chars) return null;
  const start = chars[1].charCodeAt(0);
  const end = chars[2].charCodeAt(0);
  const step = start <= end ? 1 : -1;
  const count = Math.abs(end - start) + 1;
  if (count > BRACE_EXPANSION_VARIANT_CAP) return null;
  return Array.from({ length: count }, (_, index) => String.fromCharCode(start + index * step));
}

function parseBraceExpansionAlternatives(
  body: string,
  maxDepth: number,
): { kind: 'expand'; alternatives: string[] } | { kind: 'literal' } | { kind: 'unsupported' } {
  if (maxDepth > BRACE_EXPANSION_NESTING_CAP) return { kind: 'unsupported' };

  const listAlternatives = splitTopLevelBraceAlternatives(body);
  if (listAlternatives !== null) {
    return { kind: 'expand', alternatives: listAlternatives };
  }

  if (!hasTopLevelBraceRangeOperator(body)) {
    return { kind: 'literal' };
  }

  const rangeAlternatives = expandSimpleBraceRange(body);
  if (rangeAlternatives === null) return { kind: 'unsupported' };
  return { kind: 'expand', alternatives: rangeAlternatives };
}

function hasPotentialUnclosedBraceExpansion(input: string, open: number): boolean {
  return input.slice(open + 1).includes(',') || input.slice(open + 1).includes('..');
}

function findFirstBraceExpansion(input: string): BraceExpansionExpression | null | undefined {
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === '\\' && i + 1 < input.length) {
      i += 2;
      continue;
    }
    if (ch === "'") {
      i = skipSingleQuoted(input, i);
      continue;
    }
    if (ch === '"') {
      i = skipDoubleQuoted(input, i);
      continue;
    }
    if (ch === '$' && input[i + 1] === '{') {
      i = skipBracedParameterExpansion(input, i);
      continue;
    }
    if (ch !== '{') {
      i += 1;
      continue;
    }

    const match = findMatchingBrace(input, i);
    if (match === null) return hasPotentialUnclosedBraceExpansion(input, i) ? null : undefined;

    const body = input.slice(i + 1, match.close);
    const parsed = parseBraceExpansionAlternatives(body, match.maxDepth);
    if (parsed.kind === 'unsupported') return null;
    if (parsed.kind === 'expand') {
      return { open: i, close: match.close, alternatives: parsed.alternatives };
    }

    i += 1;
  }
  return undefined;
}

function expandSimpleBraceLists(input: string): string | null {
  if (!input.includes('{')) return input;
  let variants = [input];
  for (let pass = 0; pass < BRACE_EXPANSION_PASS_CAP; pass += 1) {
    const nextVariants: string[] = [];
    let expandedAny = false;
    for (const variant of variants) {
      const expression = findFirstBraceExpansion(variant);
      if (expression === null) return null;
      if (expression === undefined) {
        nextVariants.push(variant);
        continue;
      }
      const prefix = variant.slice(0, expression.open);
      const suffix = variant.slice(expression.close + 1);
      for (const part of expression.alternatives) {
        nextVariants.push(`${prefix}${part}${suffix}`);
        if (nextVariants.length > BRACE_EXPANSION_VARIANT_CAP) return null;
      }
      expandedAny = true;
    }
    variants = nextVariants;
    if (!expandedAny) break;
  }
  for (const variant of variants) {
    if (findFirstBraceExpansion(variant) !== undefined) return null;
  }
  return variants.join(' ');
}

function collapseBashPathSlashes(input: string): string {
  return input.replace(/\/{2,}/g, '/');
}

function addNormalizedScanViews(views: Set<string>, input: string): void {
  views.add(input);
  views.add(collapseBashPathSlashes(input));
}

function addParameterExpansionBodyScanViews(views: Set<string>, input: string): void {
  addNormalizedScanViews(views, input);
  addNormalizedScanViews(views, ` ${input}`);
}

const PARAMETER_EXPANSION_RECOMPOSED_WORD_LENGTH_CAP = 256;

type ParameterExpansionScanArtifacts = {
  operatorBodies: string[];
  recomposedWords: string[];
};

function findParameterExpansionClose(input: string, open: number): number | null {
  let depth = 1;
  let i = open + 2;
  while (i < input.length) {
    const ch = input[i];
    if (ch === '\\' && i + 1 < input.length) {
      i += 2;
      continue;
    }
    if (ch === "'") {
      i = skipSingleQuoted(input, i);
      continue;
    }
    if (ch === '"') {
      i = skipDoubleQuoted(input, i);
      continue;
    }
    if (ch === '$' && input[i + 1] === '{') {
      depth += 1;
      i += 2;
      continue;
    }
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
      i += 1;
      continue;
    }
    i += 1;
  }
  return null;
}

function findParameterExpansionDefaultOperatorBodyStart(body: string): number | null {
  let depth = 0;
  let i = 0;
  while (i < body.length) {
    const ch = body[i];
    if (ch === '\\' && i + 1 < body.length) {
      i += 2;
      continue;
    }
    if (ch === "'") {
      i = skipSingleQuoted(body, i);
      continue;
    }
    if (ch === '"') {
      i = skipDoubleQuoted(body, i);
      continue;
    }
    if (ch === '$' && body[i + 1] === '{') {
      depth += 1;
      i += 2;
      continue;
    }
    if (ch === '}' && depth > 0) {
      depth -= 1;
      i += 1;
      continue;
    }
    if (depth === 0 && i > 0) {
      if (ch === ':' && ['-', '=', '?', '+'].includes(body[i + 1] ?? '')) {
        return i + 2;
      }
      if (['-', '=', '?', '+'].includes(ch)) {
        return i + 1;
      }
    }
    i += 1;
  }
  return null;
}

function findParameterNameEnd(body: string): number | null {
  const named = body.match(/^[A-Za-z_][A-Za-z0-9_]*/);
  if (named) return named[0].length;

  const positional = body.match(/^[0-9]+/);
  if (positional) return positional[0].length;

  // Keep indirection (`${!VAR}`) out of scope; it is dynamic/env-dependent.
  if (body.startsWith('!')) return null;

  return /^[#?*@$_-]/.test(body) ? 1 : null;
}

function findTopLevelSlash(input: string, start: number): number | null | undefined {
  let i = start;
  while (i < input.length) {
    const ch = input[i];
    if (ch === '\\' && i + 1 < input.length) {
      i += 2;
      continue;
    }
    if (ch === "'") {
      i = skipSingleQuoted(input, i);
      continue;
    }
    if (ch === '"') {
      i = skipDoubleQuoted(input, i);
      continue;
    }
    if (ch === '$' && input[i + 1] === '{') {
      const close = findParameterExpansionClose(input, i);
      if (close === null) return null;
      i = close + 1;
      continue;
    }
    if (ch === '/') return i;
    i += 1;
  }
  return undefined;
}

function extractParameterPatternSubstitutionReplacement(body: string): string | null | undefined {
  const parameterNameEnd = findParameterNameEnd(body);
  if (parameterNameEnd === null || body[parameterNameEnd] !== '/') return undefined;

  const patternStart = body[parameterNameEnd + 1] === '/' ? parameterNameEnd + 2 : parameterNameEnd + 1;
  const replacementDelimiter = findTopLevelSlash(body, patternStart);
  if (replacementDelimiter === null) return null;
  if (replacementDelimiter === undefined) return '';

  return body.slice(replacementDelimiter + 1);
}

function extractParameterExpansionOperatorBody(body: string): string | null | undefined {
  const defaultOperatorBodyStart = findParameterExpansionDefaultOperatorBodyStart(body);
  if (defaultOperatorBodyStart !== null) {
    return body.slice(defaultOperatorBodyStart);
  }

  return extractParameterPatternSubstitutionReplacement(body);
}

function appendCappedShellWordFragment(
  word: { value: string; tooLong: boolean },
  fragment: string,
): void {
  if (word.tooLong) return;
  const nextLength = word.value.length + fragment.length;
  if (nextLength > PARAMETER_EXPANSION_RECOMPOSED_WORD_LENGTH_CAP) {
    word.tooLong = true;
    return;
  }
  word.value += fragment;
}

function extractParameterExpansionScanArtifacts(input: string): ParameterExpansionScanArtifacts | null {
  const artifacts: ParameterExpansionScanArtifacts = {
    operatorBodies: [],
    recomposedWords: [],
  };

  const scan = (segment: string): boolean => {
    let state: 'normal' | 'single' | 'double' = 'normal';
    const word = { value: '', tooLong: false };
    let wordHasOperatorExpansion = false;

    const flushWord = (): boolean => {
      if (wordHasOperatorExpansion) {
        if (word.tooLong) return false;
        artifacts.recomposedWords.push(word.value);
      }
      word.value = '';
      word.tooLong = false;
      wordHasOperatorExpansion = false;
      return true;
    };

    let i = 0;
    while (i < segment.length) {
      const ch = segment[i];
      if (state === 'single') {
        if (ch === "'") {
          state = 'normal';
        } else {
          appendCappedShellWordFragment(word, ch);
        }
        i += 1;
        continue;
      }
      if (state === 'double') {
        if (ch === '\\' && i + 1 < segment.length) {
          appendCappedShellWordFragment(word, segment[i + 1]);
          i += 2;
          continue;
        }
        if (ch === '"') {
          state = 'normal';
          i += 1;
          continue;
        }
      } else {
        if (ch === "'") {
          state = 'single';
          i += 1;
          continue;
        }
        if (ch === '"') {
          state = 'double';
          i += 1;
          continue;
        }
        if (ch === '\\' && i + 1 < segment.length) {
          if (segment[i + 1] !== '\n') {
            appendCappedShellWordFragment(word, segment[i + 1]);
          }
          i += 2;
          continue;
        }
        if (/\s/.test(ch)) {
          if (!flushWord()) return false;
          i += 1;
          continue;
        }
      }

      if (ch === '$' && segment[i + 1] === '{') {
        const close = findParameterExpansionClose(segment, i);
        if (close === null) return false;
        const body = segment.slice(i + 2, close);
        const operatorBody = extractParameterExpansionOperatorBody(body);
        if (operatorBody === null) return false;
        if (operatorBody !== undefined) {
          artifacts.operatorBodies.push(operatorBody);
          appendCappedShellWordFragment(word, operatorBody);
          wordHasOperatorExpansion = true;
          if (!scan(operatorBody)) return false;
        } else if (!scan(body)) {
          return false;
        } else {
          appendCappedShellWordFragment(word, segment.slice(i, close + 1));
        }
        i = close + 1;
        continue;
      }
      appendCappedShellWordFragment(word, ch);
      i += 1;
    }
    return state === 'normal' && flushWord();
  };

  return scan(input) ? artifacts : null;
}

function addParameterExpansionArtifactScanViews(views: Set<string>, artifact: string): boolean {
  const strippedArtifact = stripQuotedStringContent(artifact);
  if (strippedArtifact === null) return false;
  addParameterExpansionBodyScanViews(views, strippedArtifact);
  const artifactBraceExpanded = expandSimpleBraceLists(strippedArtifact);
  if (artifactBraceExpanded === null) return false;
  addParameterExpansionBodyScanViews(views, artifactBraceExpanded);

  const dequotedArtifact = stripQuoteCharsOnly(artifact);
  if (dequotedArtifact === null) return false;
  addParameterExpansionBodyScanViews(views, dequotedArtifact);
  const rawArtifactBraceExpanded = expandSimpleBraceLists(artifact);
  if (rawArtifactBraceExpanded === null) return false;
  const dequotedArtifactBraceExpanded = stripQuoteCharsOnly(rawArtifactBraceExpanded);
  if (dequotedArtifactBraceExpanded === null) return false;
  addParameterExpansionBodyScanViews(views, dequotedArtifactBraceExpanded);
  return true;
}

function buildCommandDenyScanViews(strippedSegment: string, rawSegment?: string): string[] | null {
  const views = new Set<string>();
  addNormalizedScanViews(views, strippedSegment);
  const braceExpanded = expandSimpleBraceLists(strippedSegment);
  if (braceExpanded === null) return null;
  addNormalizedScanViews(views, braceExpanded);
  if (rawSegment !== undefined) {
    const dequoted = stripQuoteCharsOnly(rawSegment);
    if (dequoted === null) return null;
    addNormalizedScanViews(views, dequoted);
    const rawBraceExpanded = expandSimpleBraceLists(rawSegment);
    if (rawBraceExpanded === null) return null;
    const dequotedBraceExpanded = stripQuoteCharsOnly(rawBraceExpanded);
    if (dequotedBraceExpanded === null) return null;
    addNormalizedScanViews(views, dequotedBraceExpanded);
  }
  const parameterExpansionArtifacts = extractParameterExpansionScanArtifacts(rawSegment ?? strippedSegment);
  if (parameterExpansionArtifacts === null) return null;
  for (const artifact of [
    ...parameterExpansionArtifacts.operatorBodies,
    ...parameterExpansionArtifacts.recomposedWords,
  ]) {
    if (!addParameterExpansionArtifactScanViews(views, artifact)) return null;
  }
  return [...views];
}

function buildDangerousPatternScanViews(strippedSegment: string, rawSegment?: string): {
  shellViews: string[];
  argumentViews: string[];
} | null {
  const shellViews = new Set<string>();
  addNormalizedScanViews(shellViews, strippedSegment);

  const strippedBraceExpanded = expandSimpleBraceLists(strippedSegment);
  if (strippedBraceExpanded === null) return null;
  addNormalizedScanViews(shellViews, strippedBraceExpanded);

  const argumentViews = new Set<string>(shellViews);
  if (rawSegment !== undefined) {
    const dequoted = stripQuoteCharsOnly(rawSegment);
    if (dequoted === null) return null;
    addNormalizedScanViews(argumentViews, dequoted);

    const rawBraceExpanded = expandSimpleBraceLists(rawSegment);
    if (rawBraceExpanded === null) return null;
    const dequotedBraceExpanded = stripQuoteCharsOnly(rawBraceExpanded);
    if (dequotedBraceExpanded === null) return null;
    addNormalizedScanViews(argumentViews, dequotedBraceExpanded);
  }

  const parameterExpansionArtifacts = extractParameterExpansionScanArtifacts(rawSegment ?? strippedSegment);
  if (parameterExpansionArtifacts === null) return null;
  for (const artifact of [
    ...parameterExpansionArtifacts.operatorBodies,
    ...parameterExpansionArtifacts.recomposedWords,
  ]) {
    if (!addParameterExpansionArtifactScanViews(shellViews, artifact)) return null;
    if (!addParameterExpansionArtifactScanViews(argumentViews, artifact)) return null;
  }

  return {
    shellViews: [...shellViews],
    argumentViews: [...argumentViews],
  };
}

function getDangerousPatternScanViews(
  pattern: RegExp,
  scanViews: { shellViews: string[]; argumentViews: string[] },
): string[] {
  return BASH_SENSITIVE_PATH_PATTERN_SET.has(pattern) ? scanViews.argumentViews : scanViews.shellViews;
}

/**
 * Check if a single command segment (no pipes/chains) is a safe read-only command.
 * Checks for dangerous patterns OTHER than pipes, then validates the base command.
 *
 * The `segment` argument is expected to have already been passed through
 * `stripQuotedStringContent` — dangerous-pattern checks rely on shell metacharacters
 * appearing only where they have shell meaning, not as literals inside quotes.
 *
 * `rawSegment` (optional) is the original, unstripped form of the same segment. It
 * exists so `sed`-specific belt-and-braces checks (script `w` directive, standalone
 * quoted `-i` evasion) can inspect content the standard quote-stripping pass blanks.
 * When `rawSegment` is omitted, those checks are skipped — that's safe for callers
 * that don't have the raw form, because the existing `\s-i\b` / `\s--in-place\b`
 * patterns still catch the common in-place forms.
 */
function isSegmentSafeReadOnly(segment: string, rawSegment?: string): boolean {
  const trimmed = segment.trim();
  if (!trimmed) return false;

  // Check for dangerous patterns EXCEPT pipes (pipes are handled by the caller)
  const dangerousPatternScanViews = buildDangerousPatternScanViews(trimmed, rawSegment);
  if (dangerousPatternScanViews === null) return false;
  for (const pattern of BASH_DANGEROUS_PATTERNS) {
    if (pattern === PIPE_PATTERN) continue;
    if (getDangerousPatternScanViews(pattern, dangerousPatternScanViews).some((view) => pattern.test(view))) {
      return false;
    }
  }

  const lowerBase = extractBaseCommand(trimmed);

  if (BASH_READONLY_COMMANDS.has(lowerBase)) {
    return true;
  }

  if (Object.hasOwn(CONDITIONALLY_SAFE_COMMANDS, lowerBase)) {
    const dangerousFlags = CONDITIONALLY_SAFE_COMMANDS[lowerBase];
    const denyScanViews = buildCommandDenyScanViews(trimmed, rawSegment);
    if (denyScanViews === null) return false;
    if (denyScanViews.some((view) => dangerousFlags.some((pattern) => pattern.test(view)))) {
      return false;
    }
    if (lowerBase === 'sed' && rawSegment !== undefined) {
      if (containsSedWriteDirective(rawSegment)) return false;
      if (containsSedExecDirective(rawSegment)) return false;
      if (containsQuoteWrappedSedFlag(rawSegment)) return false;
      if (containsShellEscapedSedFlag(rawSegment)) return false;
    }
    return true;
  }

  if (Object.hasOwn(SAFE_FLAG_REQUIRED_COMMANDS, lowerBase)) {
    const spec = SAFE_FLAG_REQUIRED_COMMANDS[lowerBase];
    const denyScanViews = buildCommandDenyScanViews(trimmed, rawSegment);
    if (denyScanViews === null) return false;
    if (denyScanViews.some((view) => spec.deny.some((pattern) => pattern.test(view)))) return false;
    // Phase-4 re-review: catch quoted dangerous flags (e.g.
    // `tar -tf x.tar "--checkpoint-action=exec=id"`) that stripQuotedStringContent
    // blanks before the per-segment scan. buildCommandDenyScanViews also covers
    // ANSI-C decoded and simple brace-expanded forms.
    return denyScanViews.some((view) => spec.safe.some((pattern) => pattern.test(view)));
  }

  return false;
}

function isReadOnlyLocalScriptHeredoc(command: string): boolean {
  const heredocMatch = command.match(/^\s*(python3?|node)\b[\s\S]*?<<[-~]?\s*['"]?([A-Za-z0-9_]+)['"]?\s*\n([\s\S]*?)\n\2\b/m);
  if (!heredocMatch) {
    return false;
  }

  const scriptBody = heredocMatch[3] ?? '';
  const lowerScript = scriptBody.toLowerCase();
  if (lowerScript.trim().length === 0) {
    return false;
  }

  const dangerousScriptPatterns: ReadonlyArray<RegExp> = [
    // Network and outbound calls
    /\brequests\./i,
    /\burllib\b/i,
    /\burllib\.request\.urlretrieve\b/i,
    /\brequests\.(post|put|patch|delete)\b/i,
    /\bhttpx\b/i,
    /\baxios\b/i,
    /\bfetch\s*\(/i,
    /\bsocket\b/i,
    /\bhttp\b/i,
    // Shell/process execution
    /\bsubprocess\b/i,
    /\bsubprocess\.(run|call|check_call|check_output|popen|getoutput|getstatusoutput)\b/i,
    /\bos\.system\b/i,
    /\bos\.(remove|unlink|rmdir|rename|replace)\b/i,
    /\bshutil\.(rmtree|move|copy|copy2|copyfile|copytree)\b/i,
    /\bchild_process\b/i,
    /\bexec\s*\(/i,
    /\bspawn\s*\(/i,
    // File writes/destructive operations
    /open\s*\([^)]*,\s*['"][^'"]*[wax+][^'"]*['"]/i,
    /\bopen\([\s\S]*?,\s*['"][wxa]/i,
    /\.write_text\b/i,
    /\.write_bytes\b/i,
    /\bwritefile\b/i,
    /\bappendfile\b/i,
    /\bfs\.(write(?:file|filesync)?|append(?:file|filesync)?|unlink(?:sync)?|rename(?:sync)?|copyfile(?:sync)?|cp(?:sync)?|rm(?:sync)?|rmdir(?:sync)?)\b/i,
    /\bcreatewritestream\b/i,
    /\bunlink\b/i,
    /\brmdir\b/i,
    /\brm\s*\(/i,
    /\brename\s*\(/i,
    /\bmkdir\s*\(/i,
  ];

  if (dangerousScriptPatterns.some((pattern) => pattern.test(scriptBody))) {
    return false;
  }

  const readSignals: ReadonlyArray<RegExp> = [
    /\bread_text\s*\(/i,
    /\bread_bytes\s*\(/i,
    /\bopen\s*\(/i,
    /\breadfile(?:sync)?\s*\(/i,
    /\breadlines?\s*\(/i,
    /\bjson\.load/i,
    /\bjson\.loads/i,
    /\bprint\s*\(/i,
    /\bconsole\.log\s*\(/i,
  ];

  const hasReadSignal = readSignals.some((pattern) => pattern.test(scriptBody));
  if (!hasReadSignal) {
    return false;
  }

  return true;
}

/**
 * Check if a Bash command is safe to skip LLM evaluation.
 * 
 * CONSERVATIVE approach: Only skip if ALL of the following are true:
 * 1. The command does NOT contain any BASH_DANGEROUS_PATTERNS
 * 2. The first word (command) is in BASH_READONLY_COMMANDS (always safe), OR
 *    is in CONDITIONALLY_SAFE_COMMANDS with none of its dangerous flags present
 * 
 * PIPE CHAIN exception: If the only dangerous pattern is a pipe (`|`),
 * the command is split on pipes and each segment is checked independently.
 * If every segment is a known read-only command with no other dangerous
 * patterns, the entire pipe chain is safe (e.g., `cat file | head -5`).
 * 
 * When in doubt, we DO NOT skip (safer to evaluate with LLM).
 * 
 * @param command - The bash command string to evaluate
 * @returns true if safe to skip LLM evaluation, false otherwise
 * @internal Exported for testing
 */
export function isBashCommandSafeToSkip(command: string): boolean {
  if (!command || typeof command !== 'string') {
    return false;
  }

  const trimmed = command.trim();
  if (!trimmed) {
    return false;
  }

  // Strip benign stderr discards (2>/dev/null) before pattern checks
  // so the redirect patterns don't flag them as dangerous file redirects
  const sanitized = trimmed.replace(/\s*2>\s*\/dev\/null/g, '');

  // Positive-evidence carve-out: local script heredocs that only read/process
  // local data and print to stdout. Heredoc detection has to look at the raw
  // command (interior quoting is part of the heredoc body, not shell syntax).
  if (isReadOnlyLocalScriptHeredoc(sanitized)) {
    return true;
  }

  // Bash elides backslash-newline before parsing, so flags can be split across
  // physical lines (`-de\` + newline + `lete`). This pre-skip gate only handles
  // simple commands; force LLM eval when line continuation is present.
  if (/\\\r?\n/.test(sanitized)) {
    return false;
  }

  // Quote-aware pattern scanning: blank out the *contents* of single- and
  // double-quoted strings before running shell-metacharacter and dangerous-verb
  // regexes. Without this, regex alternation inside `rg 'A|B|C'` or a literal
  // `'rm -rf'` argument falsely trips the deterministic gate.
  // Fail closed on malformed (unbalanced) quoting.
  const stripped = stripQuotedStringContent(sanitized);
  if (stripped === null) {
    return false;
  }

  const dangerousPatternScanViews = buildDangerousPatternScanViews(stripped, sanitized);
  if (dangerousPatternScanViews === null) {
    return false;
  }

  // Check for dangerous patterns FIRST (before checking the command verb)
  // This catches cases like "ls; rm -rf /" where the first command is safe.
  let hasPipe = false;
  let hasOtherDangerous = false;
  for (const pattern of BASH_DANGEROUS_PATTERNS) {
    const patternScanViews = getDangerousPatternScanViews(pattern, dangerousPatternScanViews);
    if (patternScanViews.some((view) => pattern.test(view))) {
      if (pattern === PIPE_PATTERN) {
        hasPipe = true;
      } else {
        hasOtherDangerous = true;
      }
    }
  }

  // If there are dangerous patterns OTHER than pipes, must evaluate with LLM
  if (hasOtherDangerous) {
    return false;
  }

  // PIPE CHAIN: If the only dangerous pattern is a pipe, check if every
  // segment in the pipeline is a safe read-only command.
  // e.g., `cat file | head -5 | grep pattern` is safe,
  //       `cat file | curl -X POST` is not.
  // Segments are sliced from the *stripped* string so per-segment dangerous
  // checks remain quote-aware too. We also slice an aligned raw view from
  // `sanitized` (stripQuotedStringContent preserves length, so character offsets
  // line up byte-for-byte) and pass it through to `isSegmentSafeReadOnly` for
  // sed-specific belt-and-braces checks (Stage 2).
  if (hasPipe) {
    const pipeRegex = /\s*\|\s*/g;
    type Segment = { stripped: string; raw: string };
    const segments: Segment[] = [];
    let cursor = 0;
    let match: RegExpExecArray | null;
    while ((match = pipeRegex.exec(stripped)) !== null) {
      segments.push({
        stripped: stripped.slice(cursor, match.index),
        raw: sanitized.slice(cursor, match.index),
      });
      cursor = match.index + match[0].length;
    }
    segments.push({
      stripped: stripped.slice(cursor),
      raw: sanitized.slice(cursor),
    });
    return segments.length > 0 && segments.every((s) => isSegmentSafeReadOnly(s.stripped, s.raw));
  }

  // No dangerous patterns at all — check the command against the safe lists.
  // Base-command extraction reads the first word, which is outside any quoting
  // by construction, so the stripped string preserves it correctly.
  const lowerBaseCommand = extractBaseCommand(stripped);

  if (BASH_READONLY_COMMANDS.has(lowerBaseCommand)) {
    return true;
  }

  if (Object.hasOwn(CONDITIONALLY_SAFE_COMMANDS, lowerBaseCommand)) {
    const dangerousFlags = CONDITIONALLY_SAFE_COMMANDS[lowerBaseCommand];
    const denyScanViews = buildCommandDenyScanViews(stripped, sanitized);
    if (denyScanViews === null) return false;
    if (denyScanViews.some((view) => dangerousFlags.some((pattern) => pattern.test(view)))) {
      return false;
    }
    // Stage 2 belt-and-braces: see isSegmentSafeReadOnly + the Stage-2 helpers.
    if (lowerBaseCommand === 'sed') {
      if (containsSedWriteDirective(sanitized)) return false;
      if (containsSedExecDirective(sanitized)) return false;
      if (containsQuoteWrappedSedFlag(sanitized)) return false;
      if (containsShellEscapedSedFlag(sanitized)) return false;
    }
    return true;
  }

  if (Object.hasOwn(SAFE_FLAG_REQUIRED_COMMANDS, lowerBaseCommand)) {
    const spec = SAFE_FLAG_REQUIRED_COMMANDS[lowerBaseCommand];
    const denyScanViews = buildCommandDenyScanViews(stripped, sanitized);
    if (denyScanViews === null) return false;
    if (denyScanViews.some((view) => spec.deny.some((pattern) => pattern.test(view)))) return false;
    // Phase-4 re-review: see isSegmentSafeReadOnly. Same fix here for the
    // no-pipe top-level path so quoted, ANSI-C encoded, and simple brace-expanded
    // dangerous flags are caught.
    return denyScanViews.some((view) => spec.safe.some((pattern) => pattern.test(view)));
  }

  return false;
}

// NOTE: METADATA_VERBS (previously used for includes()-based auto-skip) was removed.
// All verb-based skip logic now uses isDeterministicallyReadOnly() from toolVerbs.ts,
// which checks BOTH read-only verbs AND rejects tools containing side-effect verbs.
// This prevents composite names like "read_and_delete_files" from bypassing safety.

/**
 * Check if a tool should skip LLM evaluation (deterministic metadata/read-only).
 *
 * Security posture:
 * - Positive-evidence only: only skip when we have clear deterministic evidence
 *   the operation is read-only.
 * - Fail closed on ambiguity: malformed/missing router package context means
 *   "do not skip" (fall through to evaluator).
 * - Sensitive substrings always force evaluation.
 *
 * @internal Exported for testing
 */
export function shouldSkipEvaluation(toolName: string, toolInput: unknown): boolean {
  // Get the effective tool identifier for accurate detection
  // For MCP router use_tool calls, this returns the inner tool_id
  const effectiveId = getEffectiveToolIdentifier(toolName, toolInput).toLowerCase();
  const routerInput = getRouterToolInput(toolName, toolInput);
  
  // SECURITY: Never skip tools that may handle sensitive data
  // This check MUST come before verb-based auto-skip to prevent data exfiltration
  // e.g., get_api_keys, read_secrets, fetch_credentials should always be evaluated
  if (SENSITIVE_SUBSTRINGS.some(s => effectiveId.includes(s))) {
    return false;
  }
  
  // Check exact match for known metadata tool names
  if (SKIP_TOOL_NAMES.has(toolName)) {
    return true;
  }

  // For Bash commands, check if the command is safe to skip
  // This uses conservative heuristics - only skips simple read-only commands
  if (toolName === 'Bash' && toolInput && typeof toolInput === 'object') {
    const input = toolInput as Record<string, unknown>;
    const command = input.command as string | undefined;
    if (command && isBashCommandSafeToSkip(command)) {
      return true;
    }
  }

  // MCP router calls need package-level positive evidence.
  // Missing package metadata alone is not enough to skip unless the tool id
  // itself provides positive deterministic read-only evidence.
  if (routerInput) {
    const packageId = typeof routerInput.package_id === 'string'
      ? routerInput.package_id.trim().toLowerCase()
      : '';

    // Defensive parity with direct `Bash`: if a router exposes a shell-like inner
    // tool with a `command` string, apply the same conservative read-only check.
    // No catalog tool exposes this surface today, but adding the positive-evidence
    // skip here keeps the two paths consistent if a connector later adds one.
    const routerArgs = routerInput.args && typeof routerInput.args === 'object'
      ? (routerInput.args as Record<string, unknown>)
      : null;
    if (
      routerArgs
      && typeof routerArgs.command === 'string'
      && BASH_LIKE_INNER_TOOL_ID_PATTERN.test(effectiveId)
      && isBashCommandSafeToSkip(routerArgs.command)
    ) {
      return true;
    }

    if (!effectiveId || !isDeterministicallyReadOnly(effectiveId)) {
      return false;
    }

    if (hasExternalCrudVerb(effectiveId)) {
      return false;
    }

    if (packageId && hasTrustedMetadataPackage(packageId)) {
      return true;
    }

    // Positive evidence path for non-allowlisted packages:
    // deterministically read-only tool id without external CRUD verbs.
    return true;
  }

  return false;
}

function extractPathFromToolInput(toolInput: unknown): string | null {
  if (!toolInput || typeof toolInput !== 'object') return null;
  const input = toolInput as Record<string, unknown>;
  const candidates = [
    input.file_path,
    input.path,
    input.filePath,
    input.target_path,
    input.targetPath,
    input.destination,
    input.output_path,
    input.outputPath,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      const normalizedCandidate = normalizeSafetyPath(candidate.trim());
      if (normalizedCandidate.length > 0) {
        return normalizedCandidate;
      }
    }
  }

  return null;
}

type DeterministicAutomationAllowDecision = {
  gateId: 'read_only' | 'bash_private_write_targets' | 'private_file_write';
  reason: string;
  targetSpace?: {
    type: SettingsSpaceCandidate['type'];
    name: string;
  };
  writeTargetCount?: number;
  hasSymlinkTarget?: boolean;
};

function getDeterministicAutomationAllowDecision(params: {
  toolName: string;
  effectiveToolId: string;
  packageId: string | undefined;
  toolInput: unknown;
  spaceCandidates: readonly SettingsSpaceCandidate[];
  workspacePath: string | undefined;
}): DeterministicAutomationAllowDecision | null {
  const {
    toolName,
    effectiveToolId,
    packageId,
    toolInput,
    spaceCandidates,
    workspacePath,
  } = params;

  if (isConsentRequiredTool(effectiveToolId, packageId)) {
    return null;
  }
  if (requiresSafetyPromptPolicyCheck(effectiveToolId, packageId)) {
    return null;
  }
  if (SENSITIVE_SUBSTRINGS.some((s) => effectiveToolId.toLowerCase().includes(s))) {
    return null;
  }

  const isRouterCall = getRouterToolInput(toolName, toolInput) !== null;
  if (isRouterCall && hasExternalCrudVerb(effectiveToolId)) {
    return null;
  }

  if (!isRouterCall && !isBlockedTool(toolName) && !isBlockedTool(effectiveToolId) && isDeterministicallyReadOnly(effectiveToolId)) {
    return {
      gateId: 'read_only',
      reason: 'Deterministic read-only action in automation session',
    };
  }

  if (toolName === 'Bash' && toolInput && typeof toolInput === 'object') {
    const command = (toolInput as Record<string, unknown>).command;
    const writeTargets = typeof command === 'string' ? extractBashWriteTargets(command) : null;
    if (writeTargets && writeTargets.length > 0 && workspacePath && spaceCandidates.length > 0) {
      const resolvedSpaces = writeTargets
        .map((targetPath) => resolveSettingsSpaceForPath(targetPath, spaceCandidates, workspacePath))
        .filter((space): space is SettingsSpaceCandidate => Boolean(space));
      const allPrivateOrChief = resolvedSpaces.length === writeTargets.length
        && resolvedSpaces.every((space) => isPrivateOrChiefOfStaffSpace(space));

      if (allPrivateOrChief) {
        const primaryTargetSpace = resolvedSpaces[0];
        return {
          gateId: 'bash_private_write_targets',
          reason: 'Bash write targets resolve only to private or Chief-of-Staff spaces',
          targetSpace: primaryTargetSpace
            ? {
              type: primaryTargetSpace.type,
              name: primaryTargetSpace.name,
            }
            : undefined,
          writeTargetCount: writeTargets.length,
          hasSymlinkTarget: resolvedSpaces.some((space) => space.isSymlink === true),
        };
      }
    }
  }

  const isFileWriteTool = (FILE_WRITE_TOOLS as readonly string[]).includes(toolName);
  if (isFileWriteTool && workspacePath && spaceCandidates.length > 0) {
    const filePath = extractPathFromToolInput(toolInput);
    if (filePath) {
      const resolvedSpace = resolveSettingsSpaceForPath(filePath, spaceCandidates, workspacePath);
      if (resolvedSpace && isPrivateOrChiefOfStaffSpace(resolvedSpace)) {
        return {
          gateId: 'private_file_write',
          reason: 'File write target resolves to private or Chief-of-Staff space',
          targetSpace: {
            type: resolvedSpace.type,
            name: resolvedSpace.name,
          },
          hasSymlinkTarget: resolvedSpace.isSymlink === true,
        };
      }
    }
  }

  return null;
}

type ToolActionSpaceContext = {
  spaceLabel?: string;
  spaceDescription?: string;
  spaceReadmePreview?: string;
  spaceSharing?: ActionContextSpaceSharing;
};

function normalizeSharingMaybe(value: string | undefined): ActionContextSpaceSharing['effective'] | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return undefined;
  }
  return normalizeSharingClass(value);
}

function buildSpaceSharingContext(
  settingsSharing: string | undefined,
  frontmatterSharing: string | undefined,
): ActionContextSpaceSharing {
  const settingsValue = normalizeSharingMaybe(settingsSharing);
  const frontmatterValue = normalizeSharingMaybe(frontmatterSharing);
  const mismatch = Boolean(settingsValue && frontmatterValue && settingsValue !== frontmatterValue);

  if (settingsValue) {
    return {
      effective: settingsValue,
      source: 'settings',
      settingsValue,
      frontmatterValue,
      mismatch,
    };
  }

  if (frontmatterValue) {
    return {
      effective: frontmatterValue,
      source: 'frontmatter',
      settingsValue,
      frontmatterValue,
      mismatch,
    };
  }

  return {
    effective: 'unknown',
    source: 'default',
    settingsValue,
    frontmatterValue,
    mismatch,
  };
}

function extractSpacePathFromRouterArgs(toolName: string, toolInput: unknown): string | null {
  const routerInput = getRouterToolInput(toolName, toolInput);
  if (!routerInput || !routerInput.args || typeof routerInput.args !== 'object') {
    return null;
  }
  return extractPathFromToolInput(routerInput.args);
}

function extractActionSpacePathCandidate(
  toolName: string,
  toolInput: unknown,
  workspacePath: string | undefined,
): string | null {
  if (toolName === 'Bash') {
    const command = toolInput && typeof toolInput === 'object'
      ? (toolInput as Record<string, unknown>).command
      : undefined;
    return extractDominantBashTargetPath(
      typeof command === 'string' ? command : undefined,
      workspacePath,
    ) ?? null;
  }

  const directPath = extractPathFromToolInput(toolInput);
  if (directPath) return directPath;

  const routerPath = extractSpacePathFromRouterArgs(toolName, toolInput);
  if (routerPath) return routerPath;

  return null;
}

function buildActionSpaceContextCacheKey(
  toolName: string,
  toolInput: unknown,
  workspacePath: string | undefined,
): string {
  const candidatePath = extractActionSpacePathCandidate(toolName, toolInput, workspacePath) ?? '';
  const commandPreview = toolName === 'Bash' && toolInput && typeof toolInput === 'object'
    ? String((toolInput as Record<string, unknown>).command ?? '').slice(0, 2000)
    : '';
  return `${toolName}|${candidatePath}|${commandPreview}`;
}

async function resolveActionSpaceContext(params: {
  toolName: string;
  toolInput: unknown;
  workspacePath: string | undefined;
  spaceCandidates: readonly SettingsSpaceCandidate[];
}): Promise<ToolActionSpaceContext | null> {
  const { toolName, toolInput, workspacePath, spaceCandidates } = params;
  if (!workspacePath || spaceCandidates.length === 0) {
    return null;
  }

  const candidatePath = extractActionSpacePathCandidate(toolName, toolInput, workspacePath);
  if (!candidatePath) {
    return null;
  }

  const matchedSpace = resolveSettingsSpaceForPath(candidatePath, spaceCandidates, workspacePath);
  if (!matchedSpace) {
    return null;
  }

  const [frontmatter, readmeBody] = await Promise.all([
    readSpaceReadmeFrontmatter(matchedSpace.absolutePath).catch(() => undefined),
    readSpaceReadmeBody(matchedSpace.absolutePath).catch(() => null),
  ]);

  const displayName = typeof frontmatter?.display_name === 'string' && frontmatter.display_name.trim().length > 0
    ? frontmatter.display_name.trim()
    : matchedSpace.name;
  const description = typeof frontmatter?.rebel_space_description === 'string' && frontmatter.rebel_space_description.trim().length > 0
    ? frontmatter.rebel_space_description.trim()
    : matchedSpace.description;

  return {
    spaceLabel: displayName,
    spaceDescription: description,
    spaceReadmePreview: typeof readmeBody === 'string' && readmeBody.trim().length > 0 ? readmeBody : undefined,
    spaceSharing: buildSpaceSharingContext(matchedSpace.sharing, frontmatter?.sharing),
  };
}

// =============================================================================
// Windows Python Guard (Stage 2 of Windows Python Store Alias Fix)
// =============================================================================

/**
 * Extract command header - the part before any heredoc/herestring markers.
 * This prevents false positives from Python appearing in heredoc bodies.
 */
function extractCommandHeader(command: string): string {
  // Find first heredoc/herestring marker (<<, <<-, <<<)
  const heredocIndex = command.search(/<<[-~]?(?:<|\s*['"]?\w)/);
  if (heredocIndex === -1) {
    // No heredoc - only check first line
    const firstNewline = command.indexOf('\n');
    return firstNewline === -1 ? command : command.substring(0, firstNewline);
  }
  return command.substring(0, heredocIndex);
}

/**
 * Detect Python/pip invocation in command header.
 * Returns the executable token if found, null otherwise.
 *
 * Recognised forms (anchored at the header start or immediately after a chain
 * operator `&&`/`||`/`;` — never after a pipe `|` and never mid-token):
 *   - bare:        `python3 …`, `python …`, `pip3 …`, `pip …`, `py …`
 *   - absolute:    `/usr/bin/python3 …`, `/usr/bin/python …` (the macOS shim)
 *   - env wrapper: `env python3 …`, `/usr/bin/env python3 …`
 *   - env-assign:  `FOO=bar python3 …` (one or more `VAR=val ` prefixes)
 *
 * Versioned names like `python3.11` are intentionally NOT matched — they are
 * real interpreters, not Apple's `/usr/bin/python3` xcode-select shim. The
 * `(?:\s|$)` boundary after the executable enforces this.
 *
 * Shared by `windowsPythonGuard` and `macosCltShimGuard`; the returned token is
 * fed to each platform's resolver, so an absolute `/usr/bin/python3` token is
 * returned verbatim and the macOS resolver treats it as the shim directly.
 */
export function detectPythonInHeader(header: string): string | null {
  // Core executable alternation. The absolute `/usr/bin/python3?` comes first so
  // it wins over the bare alternative when present.
  const exe = '(\\/usr\\/bin\\/python3?|python3?|pip3?|py)';
  // Optional leading env-var assignments: `FOO=bar BAZ=qux ` before the command.
  const envAssign = '(?:[A-Za-z_][A-Za-z0-9_]*=\\S*\\s+)*';
  // Optional `env`/`/usr/bin/env` wrapper before the python token.
  const envWrap = '(?:(?:\\/usr\\/bin\\/)?env\\s+)?';
  const prefix = `${envAssign}${envWrap}`;
  const tail = '(?:\\.exe)?(?:\\s|$)';

  // Pattern 1: header start (after any env-assignments / env wrapper).
  const startMatch = header.match(new RegExp(`^${prefix}${exe}${tail}`, 'i'));
  if (startMatch) return startMatch[1];

  // Pattern 2: after &&, ||, ; (chaining — NOT | which is a pipe).
  const chainMatch = header.match(
    new RegExp(`(?:&&|\\|\\||;)\\s*${prefix}${exe}${tail}`, 'i'),
  );
  if (chainMatch) return chainMatch[1];

  return null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sortedAlternation(values: readonly string[]): string {
  return [...values]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join('|');
}

const MACOS_CLT_SHIM_DETECTOR_ENV_ASSIGN = '(?:[A-Za-z_][A-Za-z0-9_]*=\\S*\\s+)*';
const MACOS_CLT_SHIM_DETECTOR_ENV_WRAP = '(?:(?:\\/usr\\/bin\\/)?env\\s+)?';
const MACOS_CLT_SHIM_DETECTOR_PREFIX = `${MACOS_CLT_SHIM_DETECTOR_ENV_ASSIGN}${MACOS_CLT_SHIM_DETECTOR_ENV_WRAP}`;
const MACOS_CLT_SHIM_DETECTOR_TAIL = '(?:\\s|$)';
const MACOS_CLT_SHIM_DETECTOR_EXE = (() => {
  const names = sortedAlternation(MACOS_CLT_SHIM_BINARY_NAMES);
  const absoluteNames = sortedAlternation(
    MACOS_CLT_SHIM_BINARY_NAMES.map((name) => `/usr/bin/${name}`),
  );
  return `(${absoluteNames}|${names})`;
})();
const MACOS_CLT_SHIM_HEADER_START_RE = new RegExp(
  `^${MACOS_CLT_SHIM_DETECTOR_PREFIX}${MACOS_CLT_SHIM_DETECTOR_EXE}${MACOS_CLT_SHIM_DETECTOR_TAIL}`,
  'i',
);
const MACOS_CLT_SHIM_HEADER_CHAIN_RE = new RegExp(
  `(?:&&|\\|\\||;)\\s*${MACOS_CLT_SHIM_DETECTOR_PREFIX}${MACOS_CLT_SHIM_DETECTOR_EXE}${MACOS_CLT_SHIM_DETECTOR_TAIL}`,
  'i',
);

/**
 * Detect macOS CLT-shimmed executable invocations in the same Bash command
 * header positions covered by `detectPythonInHeader`: header start or after
 * `&&`/`||`/`;`, optionally preceded by env assignments and `env`.
 */
export function detectMacosCltShimCommandInHeader(header: string): string | null {
  const startMatch = header.match(MACOS_CLT_SHIM_HEADER_START_RE);
  if (startMatch) return startMatch[1];

  const chainMatch = header.match(MACOS_CLT_SHIM_HEADER_CHAIN_RE);
  if (chainMatch) return chainMatch[1];

  return null;
}

/** Result from resolving a command via where.exe */
type WhereResolutionResult =
  | { kind: 'safe_path'; path: string }
  | { kind: 'alias_only' }
  | { kind: 'not_found' }
  | { kind: 'error' };

/**
 * Resolve a command to a non-WindowsApps path using where.exe.
 * Returns structured result to distinguish between:
 * - safe_path: Found a non-WindowsApps path
 * - alias_only: Only WindowsApps paths found (would trigger Store)
 * - not_found: Command not in PATH at all
 * - error: where.exe failed or timed out
 */
async function resolveWindowsCommand(cmd: string): Promise<WhereResolutionResult> {
  try {
    const whereExe = 'C:\\Windows\\System32\\where.exe';
    const result = await runProbe(whereExe, [cmd], {
      timeout: 2000,
    });

    // Exit code 1 means "not found"
    if (result.exitCode !== 0) {
      return { kind: 'not_found' };
    }

    const paths = result.stdout.split(/\r?\n/).filter(Boolean);
    if (paths.length === 0) {
      return { kind: 'not_found' };
    }

    let foundAlias = false;

    // Find first non-WindowsApps path
    for (const p of paths) {
      const normalized = p.toLowerCase().replace(/\//g, '\\');
      if (normalized.includes('microsoft\\windowsapps')) {
        foundAlias = true;
      } else {
        return { kind: 'safe_path', path: p.trim() };
      }
    }

    // If we get here, all paths were WindowsApps aliases
    return foundAlias ? { kind: 'alias_only' } : { kind: 'not_found' };
  } catch {
    return { kind: 'error' };
  }
}

/**
 * Extract Bash command from tool call, handling both direct Bash and router-wrapped calls.
 */
function extractCommandFromToolCall(toolName: string, toolInput: unknown): string | null {
  // Direct Bash tool
  if (toolName === 'Bash') {
    return (toolInput as { command?: string })?.command ?? null;
  }

  // Router-wrapped Bash
  const input = getRouterToolInput(toolName, toolInput) as
    | { tool_id?: string; args?: { command?: string }; params?: { command?: string } }
    | null;
  if (input) {
    if (input.tool_id === 'Bash' || input.tool_id?.endsWith('__Bash')) {
      return input.args?.command ?? input.params?.command ?? null;
    }
  }

  return null;
}

/**
 * Windows-only guard to prevent Python commands from triggering Microsoft Store.
 * Returns a deny response if the command would resolve to a WindowsApps alias.
 * Returns null to allow the command to proceed.
 */
export async function windowsPythonGuard(
  toolName: string,
  toolInput: unknown,
  log: ReturnType<typeof createScopedLogger>
): Promise<HookJSONOutput | null> {
  // Only on Windows
  if (process.platform !== 'win32') return null;

  const command = extractCommandFromToolCall(toolName, toolInput);
  if (!command) return null;

  // Extract header only (before heredocs/newlines)
  const header = extractCommandHeader(command);

  // Check for Python in header
  const pythonExe = detectPythonInHeader(header);
  if (!pythonExe) return null; // No Python invocation detected

  // py.exe is always safe - it finds real Python
  if (pythonExe.toLowerCase() === 'py') {
    log.debug({ pythonExe }, 'Windows Python guard: py.exe is safe');
    return null;
  }

  // Check if safe Python is available
  const pythonStatus = await checkPythonRuntime();

  if (!pythonStatus.pythonAvailable) {
    log.info({ pythonExe, windowsAliasesBlocked: pythonStatus.windowsAliasesBlocked },
      'Windows Python guard: blocking - no safe Python available');

    const reason = pythonStatus.windowsAliasesBlocked
      ? 'only Windows Store aliases found (blocked)'
      : 'Python not installed';

    return {
      continue: false,
      stopReason: `Python command blocked: ${reason}`,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse' as const,
        permissionDecision: 'deny' as const,
        permissionDecisionReason: `BLOCKED: "${pythonExe}" - ${reason}

This prevents the Microsoft Store from opening unexpectedly.

To use Python on Windows:
1. Install Python from https://python.org (recommended)
2. Use "py -3" instead of "python3" in commands
3. Or disable App Execution Aliases: Windows Settings > Apps > Advanced app settings > App execution aliases

After installing Python, restart the app to detect it.`
      }
    };
  }

  // Python is available - but verify this specific command won't hit the alias
  const resolution = await resolveWindowsCommand(pythonExe);

  switch (resolution.kind) {
    case 'safe_path':
      // Command resolves to a non-WindowsApps path - allow
      log.debug({ pythonExe, safePath: resolution.path }, 'Windows Python guard: allowing - safe path found');
      return null;

    case 'alias_only':
      // Command would hit WindowsApps alias - block
      log.info({ pythonExe }, 'Windows Python guard: blocking - command resolves to WindowsApps');
      return {
        continue: false,
        stopReason: 'Python command blocked: resolves to Windows Store alias',
        hookSpecificOutput: {
          hookEventName: 'PreToolUse' as const,
          permissionDecision: 'deny' as const,
          permissionDecisionReason: `BLOCKED: "${pythonExe}" resolves to Windows Store alias

Even though Python is installed elsewhere, this command would open Microsoft Store.

To fix this:
1. Use "py -3" instead of "${pythonExe}" in commands (recommended)
2. Or use the full path to your Python installation
3. Or disable App Execution Aliases: Windows Settings > Apps > Advanced app settings`
        }
      };

    case 'not_found':
    case 'error':
      // Command not found or error - let it fail naturally with a clear error
      // Don't block, as this isn't a Store alias issue
      log.debug({ pythonExe, resolution: resolution.kind }, 'Windows Python guard: allowing - command not found (will fail naturally)');
      return null;
  }
}

/**
 * macOS-only guard to prevent the agent's Bash tool from exec'ing Apple's
 * xcode-select CLT shims (`/usr/bin/git`, `/usr/bin/python3`, etc.).
 *
 * On a Mac without Command Line Developer Tools, exec'ing those shims pops the OS
 * "install command line developer tools" modal — the user experiences this as
 * Rebel "randomly asking to install developer tools". This guard resolves the FIRST
 * PATH hit (over the SPAWN's PATH, i.e. `process.env.PATH`, which is what
 * `runBashTool` uses) without exec'ing the binary, and denies the call when
 * that hit is the shim and CLT is missing.
 *
 * Sibling of `windowsPythonGuard` (deliberately NOT a shared dispatcher).
 * Returns a deny response, or null to allow the command to proceed.
 */
export async function macosCltShimGuard(
  toolName: string,
  toolInput: unknown,
  log: ReturnType<typeof createScopedLogger>
): Promise<HookJSONOutput | null> {
  // Only on macOS
  if (process.platform !== 'darwin') return null;

  const command = extractCommandFromToolCall(toolName, toolInput);
  if (!command) return null;

  // Extract header only (before heredocs/newlines)
  const header = extractCommandHeader(command);

  const shimExe = detectMacosCltShimCommandInHeader(header);
  if (!shimExe) return null; // No CLT-shimmed invocation detected

  // Resolve over the SPAWN's PATH (process.env.PATH), NOT shellPath() and NOT
  // checkPythonRuntime().pythonAvailable — gating on "any python exists" would
  // false-allow when /usr/bin precedes Homebrew in process.env.PATH and the
  // shell still hits the shim first.
  const resolution = await macosCommandResolvesToCltShim(
    shimExe,
    process.env.PATH ?? ''
  );

  if (resolution === 'shim_blocked') {
    log.info(
      { shimExe },
      'macOS CLT shim guard: blocking - command resolves to xcode-select shim and CLT is missing'
    );
    // Plain per-tool deny: NO `continue` and NO `stopReason`. `continue:false` is
    // the stop-shaped response and `stopReason` would SHADOW our rich message in
    // getPreToolDenyReason (hookPipeline.ts) — the agent would only see a terse
    // line instead of the don't-retry/install guidance. Omitting both lets the
    // turn continue so the agent can pivot, with our message as the agent-facing
    // reason (mirrors the admin-disabled per-tool deny shape).
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse' as const,
        permissionDecision: 'deny' as const,
        permissionDecisionReason: buildMacosCltShimDenyReason(shimExe),
      },
    };
  }

  // 'safe' | 'not_found' | 'not_applicable' → allow. A real Python (Homebrew/uv)
  // runs normally; a not-found command fails naturally with a clear shell error.
  log.debug(
    { shimExe, resolution },
    'macOS CLT shim guard: allowing'
  );
  return null;
}

export const macosPythonGuard = macosCltShimGuard;

function buildMacosCltShimDenyReason(shimExe: string): string {
  const executableName = shimExe.split('/').pop() ?? shimExe;
  if (
    executableName === 'python' ||
    executableName === 'python3' ||
    executableName === 'pip' ||
    executableName === 'pip3'
  ) {
    return `This Mac has no usable Python installed — only Apple's placeholder "${shimExe}", which would pop a system dialog asking to install developer tools. Running it won't work, so please don't retry the same command.

Instead, either:
- accomplish this task without Python, or
- let the user know they can install Python from https://python.org or via Homebrew (\`brew install python\`), then try again.`;
  }

  return `This Mac does not have Xcode Command Line Tools installed. Running "${shimExe}" would pop a system dialog asking to install developer tools, so please do not retry the same command.

If the user's goal needs "${executableName}", let them know they can install Command Line Tools with \`xcode-select --install\`, then try again.`;
}

// =============================================================================
// Automation Safety Prompt — Staging Helper
// =============================================================================

/**
 * Handle a Safety Prompt block for an automation session by staging instead of hard-denying.
 *
 * For MCP tools (via super-mcp-router): stages the tool call for later execution and
 * returns an "allow" response with `_rebel_staged` flag so the agent continues.
 *
 * For non-MCP tools (Bash, TextEditor): stores approval metadata and returns a
 * deny-without-`continue:false` response so the agent continues past the block.
 *
 * FILE_WRITE_TOOLS are delegated to the memoryWriteHook (returns empty `{}`).
 *
 * @returns HookJSONOutput to return from the hook, or null if staging couldn't be done
 *          (caller should fall back to the original hard-deny path).
 */
function handleAutomationSafetyPromptBlock(params: {
  tool_name: string;
  tool_input: unknown;
  tool_use_id: string;
  effectiveToolId: string;
  sessionId: string;
  turnId: string | undefined;
  blockReason: string;
  /**
   * True when the safety evaluator failed closed for this tool call.
   * MCP tools now route through `stageEvalErrorMcp` before this helper, so this
   * flag is only expected on the residual no-stage/no-human fallback branch.
   */
  failClosed?: boolean;
  /** Diagnostic: why the evaluator failed closed (FOX-3231). */
  failClosedReason?: string;
  win: EventWindow | null | undefined;
  log: Pick<TurnSessionLogger, 'info' | 'warn' | 'debug' | 'error'>;
}): HookJSONOutput | null {
  const {
    tool_name: toolName, tool_input: toolInput, tool_use_id: toolUseId, effectiveToolId,
    sessionId, turnId,
    blockReason, failClosed, failClosedReason, win: _win, log: hookLog,
  } = params;

  // Resolve automation identity from session for display and tracking
  const automationCtx = getAutomationContext(sessionId);
  const automationId = automationCtx?.automationId ?? sessionId;
  const automationName = automationCtx?.automationName ?? 'Unknown automation';

  // FILE WRITE TOOLS: Delegate to memoryWriteHook for staging via CoS pending.
  // The memoryWriteHook handles automation-specific staging in its own safety check.
  const isFileWriteTool = FILE_WRITE_TOOLS.includes(toolName as typeof FILE_WRITE_TOOLS[number]);
  if (isFileWriteTool) {
    hookLog.info({ toolName, effectiveToolId, sessionId },
      'Safety Rules blocked file write — delegating to memory write hook for staging');
    return {};
  }

  // Record the denial and tool call for tracking + circuit breaker.
  if (turnId) {
    agentTurnRegistry.recordSecurityDenial(turnId, effectiveToolId, `Safety Rules blocked: ${blockReason}`);
    agentTurnRegistry.recordToolCall(turnId, toolName, toolInput as Record<string, unknown>);
  }
  // FOX-3231: Don't count fail-closed denials toward the circuit breaker.
  // These are transient evaluator outages (concurrency starvation), not
  // genuine safety blocks. Counting them poisons the circuit breaker
  // threshold and kills entire automation sessions.
  if (!failClosed) {
    agentTurnRegistry.incrementAutomationSafetyBlock(sessionId);
  }

  // Path A: non-fail-closed MCP policy blocks stage via stagedToolCallsService.
  // Eval-error MCP staging is handled earlier in `stageEvalErrorMcp`.
  const mcpPayload = extractMcpPayload(toolName, toolInput);
  if (mcpPayload && !failClosed) {
    hookLog.info(
      { toolName, effectiveToolId, sessionId, automationId, packageId: mcpPayload.packageId, toolId: mcpPayload.toolId },
      'Safety Rules blocked MCP tool — staging for approval'
    );

    const displayName = buildToolDisplayName(mcpPayload.packageId, mcpPayload.toolId, mcpPayload.args);
    const stagedResult = stageToolCall({
      sessionId,
      turnId: turnId || '',
      mcpPayload,
      displayName,
      toolCategory: 'side-effect',
      riskLevel: 'high',
      reason: `Safety Rules blocked: ${blockReason}`,
      blockedBy: 'safety_prompt',
      automationId,
      automationName,
    });
    const stagedCall = stagedResult.call;

    // Broadcast to all renderer windows (not win-specific — automations have no BrowserWindow)
    broadcastTypedPayload(getBroadcastService(), 'tool-safety:staged-call', {
      id: stagedCall.id,
      sessionId,
      displayName,
      packageId: mcpPayload.packageId,
      toolId: mcpPayload.toolId,
      riskLevel: 'high',
      reason: `Safety Rules blocked: ${blockReason}`,
      timestamp: stagedCall.timestamp,
      allowPermanentTrust: false,
      blockedBy: 'safety_prompt',
      automationId,
      automationName,
    });

    // Track in automation pending items tracker
    trackItem(automationId, stagedCall.id, 'staged-tool', {
      toolName: mcpPayload.toolId,
      inputSummary: JSON.stringify(mcpPayload.args).slice(0, 200),
    });

    // Return ALLOW with _rebel_staged flag — agent sees "TOOL QUEUED" and continues
    const stagedMessage = `TOOL QUEUED — WAITING FOR USER APPROVAL

"${displayName}" has been queued for user approval. It has NOT been executed yet.

Reason: Safety Rules blocked: ${blockReason}

Do NOT retry this tool or try to work around it — it is already queued and the user will be asked to approve it.
If there are other things you can do in the meantime, go ahead.
If you respond to the user before approval, say only that you are waiting for their approval. Do NOT say the action failed, could not send, or could not run.`;

    const { _rebel_staged: _, _rebel_staged_message: _unused, ...sanitizedInput } = toolInput as Record<string, unknown>;
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse' as const,
        permissionDecision: 'allow' as const,
        updatedInput: {
          ...sanitizedInput,
          _rebel_staged: true,
          _rebel_staged_message: stagedMessage,
        },
      },
    };
  }

  // Path B: deny without continue:false (agent continues).
  // Handles non-MCP tools and MCP tools that were fail-closed.
  hookLog.info(
    { toolName, effectiveToolId, sessionId, automationId, hasMcpPayload: Boolean(mcpPayload), failClosed: Boolean(failClosed) },
    'Safety Rules blocked tool — denying without stopping turn'
  );

  if (failClosed) {
    // Residual no-stage/no-human fallback: deny so the agent pivots, but do not
    // create a pending-approval record that would imply actionable user approval.
    hookLog.info(
      { turnId, sessionId, toolName, reason: 'eval-unavailable', failClosedReason },
      'Skipping pending-approval persistence for fail-closed denial (automation)',
    );
    // No durable approval exists in fail-closed mode, so do not create a
    // pending tracker item that would wait for user resolution.
  } else {
    // Store metadata for "Allow & Retry" handling
    pendingApprovalMetadata.set(toolUseId, { sessionId, toolIdentifier: effectiveToolId });

    // Build and persist approval request (strip large base64 values — runtime retains full input for retry)
    const conversationTitle = getSessionTitle(sessionId);
    const packageName = extractPackageName(toolName, toolInput);
    const approvalRequest = {
      toolUseID: toolUseId,
      turnId: turnId || '',
      sessionId,
      toolName: toolName,
      input: sanitizeToolInputForApproval(toolInput as Record<string, unknown>),
      reason: `Safety Rules blocked: ${blockReason}`,
      timestamp: Date.now(),
      riskLevel: 'high' as const,
      conversationTitle,
      packageName,
      allowPermanentTrust: false,
      effectiveToolId,
      blockedBy: 'safety_prompt' as const,
    };
    addPendingApproval(approvalRequest);

    // Track in automation pending items tracker
    trackItem(automationId, toolUseId, 'deny-retry', {
      toolName: toolName,
      inputSummary: JSON.stringify(toolInput ?? {}).slice(0, 200),
    });

    // Broadcast to all renderer windows (not win-specific — automations have no BrowserWindow)
    if (turnId) {
      broadcastTypedPayload(getBroadcastService(), 'tool-safety:approval-request', approvalRequest);
    }
  }

  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse' as const,
      permissionDecision: 'deny' as const,
      permissionDecisionReason: failClosed
        ? buildFailClosedDenyReason(toolName)
        : `TOOL QUEUED — PENDING USER REVIEW

"${toolName}" has been queued for user review. It has NOT been executed yet.

Reason: Safety Rules blocked: ${blockReason}

Do NOT retry this tool or try to work around it — the user will be asked to approve it.
If there are other things you can do in the meantime, go ahead.
If you respond to the user before approval, say only that you are waiting for their approval. Do NOT say the action failed, could not send, or could not run.
When the user approves, you will receive a message and can retry the tool then.`,
    },
  };
}

// =============================================================================
// PreToolUse Hook
// =============================================================================

/**
 * Create a PreToolUse hook callback for tool safety evaluation.
 *
 * The userMessage is captured in closure when this function is called,
 * making it available for all tool evaluations within the same turn.
 *
 * Since we run in bypassPermissions mode, the runtime ignores 'ask' decisions.
 * So when approval is needed, we block inside the hook and wait for user input.
 */
export interface ToolSafetyHookOptions {
  /**
   * Lazy supplier of recent session-level user intent (Stage 2 / P0.7).
   * Invoked AFTER the same-tool memoization short-circuit so cache hits
   * skip the I/O entirely. Within a single turn, the result is memoized
   * per `turnId` to avoid duplicate session-store reads.
   *
   * Suppliers must never throw — they return `null` on any failure.
   */
  getSessionIntent?: (
    sessionId: string | undefined,
  ) => Promise<ActionContextSessionIntent | null>;

  /**
   * Live settings supplier for the RebelSettings cost-escalation gate
   * (GPT stage-13 review F2 race). The hook closure's `settings` is a
   * turn-start snapshot, but the settings bridge validates and writes
   * against the LIVE `getSettings()` store — a same-turn profile edit
   * (e.g. `edit_model_profile` re-pointing a profile at Fable) followed by
   * a role assignment would otherwise be resolved against the stale
   * snapshot and auto-allowed while the bridge writes the premium profile.
   * Production wiring (agentTurnExecute.ts) supplies the same
   * `@core/services/settingsStore` `getSettings` the bridge imports. When
   * absent (legacy callers/tests), the gate falls back to the snapshot.
   */
  getLiveSettings?: () => AppSettings;
}

export function createToolSafetyHook(
  userMessage: string,
  settings: AppSettings,
  securityLevel: ToolSafetyLevel,
  userSafetyInstructions?: string,
  trustedTools?: TrustedTool[],
  turnLogger?: TurnSessionLogger,
  win?: EventWindow | null,
  turnId?: string,
  sessionId?: string,
  systemSkills?: SystemSkillsSettings | null,
  safetyModel?: string,
  privateMode?: boolean,
  options?: ToolSafetyHookOptions,
): HookCallback {
  const log = turnLogger ?? logger;
  log.info({ securityLevel, privateMode, userMessageLength: userMessage.length }, 'Creating tool safety hook');
  const workspacePath = settings.coreDirectory ?? undefined;
  const settingsSpaceCandidates = buildSettingsSpaceCandidates(settings.spaces, workspacePath);
  const actionSpaceContextCache = new Map<string, Promise<ToolActionSpaceContext | null>>();

  // Cost gate settings — LIVE store when wired (the same source the settings
  // bridge validates/writes against), turn-start snapshot otherwise. Resolved
  // per tool call, never cached: same-turn profile edits must be visible to
  // the next call's premium check (GPT stage-13 review F2 race).
  const getCostGateSettings = (): RebelSettingsCostGateSettings => {
    if (!options?.getLiveSettings) return settings;
    try {
      return options.getLiveSettings();
    } catch (err) {
      log.warn(
        {
          event: 'safety.cost_gate_live_settings_error',
          err: err instanceof Error ? err.message : String(err),
        },
        'Live settings supplier threw — cost gate falling back to turn-start snapshot',
      );
      return settings;
    }
  };

  // Stage 2 (P0.7) — within-turn memoization of session-intent reads. Multiple
  // tool calls in one turn share a single session-store fetch.
  const sessionIntentCache = new Map<string, Promise<ActionContextSessionIntent | null>>();
  const sessionIntentEnabled = settings.safetyEvalSessionIntent !== false;
  const sessionIntentSupplier = options?.getSessionIntent;
  const resolveSessionIntent = (
    sid: string | undefined,
  ): Promise<ActionContextSessionIntent | null> => {
    if (!sessionIntentEnabled || !sessionIntentSupplier) return Promise.resolve(null);
    const key = `${turnId ?? '_'}::${sid ?? '_'}`;
    const existing = sessionIntentCache.get(key);
    if (existing) return existing;
    const pending = (async () => {
      try {
        return await sessionIntentSupplier(sid);
      } catch (err) {
        log.warn(
          {
            event: 'safety.session_intent_provider_error',
            err: err instanceof Error ? err.message : String(err),
            sessionId: sid,
          },
          'Session intent supplier threw — proceeding without',
        );
        ignoreBestEffortCleanup(err, {
          operation: 'safety.session_intent.supplier',
          reason: 'Session intent supplier failed; safety eval continues without sessionIntent.',
          severity: 'warn',
        });
        return null;
      }
    })();
    sessionIntentCache.set(key, pending);
    return pending;
  };

  // Stage 3 (P0.5) — closure-scoped cache for user-intent classifier. Keyed
  // internally on sha256(userMessage|toolFamily) so identical (message, family)
  // pairs share one LLM round-trip per turn.
  const userIntentCache: UserIntentExtractorCache = new Map();
  const userIntentEnabled = settings.safetyEvalUserIntentFence !== false;
  const resolveUserIntent = (
    effectiveToolId: string,
    toolName: string,
    packageId: string | undefined,
    sid: string | undefined,
    abortSignal: AbortSignal | undefined,
  ): Promise<UserIntentExtractionResult | null> => {
    if (!userIntentEnabled) return Promise.resolve(null);
    if (!userMessage || userMessage.trim().length === 0) return Promise.resolve(null);
    return extractUserIntent({
      userMessage,
      toolId: effectiveToolId,
      toolFamily: getToolFamily({ toolName, effectiveToolId, packageId }),
      sessionId: sid,
      cache: userIntentCache,
      signal: abortSignal,
    }).catch((err) => {
      log.warn(
        {
          event: 'safety.user_intent_classifier_error',
          phase: 'wrapper',
          err: err instanceof Error ? err.message : String(err),
          sessionId: sid,
        },
        'User-intent extractor wrapper rejected — proceeding without fence',
      );
      ignoreBestEffortCleanup(err, {
        operation: 'safety.user_intent.extractor',
        reason: 'User-intent extractor failed; safety eval continues without userIntentExplicit.',
        severity: 'warn',
      });
      return null;
    });
  };

  const buildUserIntentExplicit = (
    result: UserIntentExtractionResult | null,
  ): ActionContextUserIntentExplicit | undefined => {
    if (!result) return undefined;
    if (result.signal !== 'imperative' && result.signal !== 'confirmation') return undefined;
    if (result.triggerPhrase.trim().length === 0) return undefined;
    return { signal: result.signal, triggerPhrase: result.triggerPhrase };
  };

  const getActionSpaceContext = (
    toolName: string,
    toolInput: unknown,
  ): Promise<ToolActionSpaceContext | null> => {
    const cacheKey = buildActionSpaceContextCacheKey(toolName, toolInput, workspacePath);
    const existing = actionSpaceContextCache.get(cacheKey);
    if (existing) {
      return existing;
    }
    const pending = resolveActionSpaceContext({
      toolName,
      toolInput,
      workspacePath,
      spaceCandidates: settingsSpaceCandidates,
    }).catch((err) => {
      log.warn(
        { err: err instanceof Error ? err.message : String(err), toolName },
        'Failed to resolve tool safety space context',
      );
      return null;
    });
    actionSpaceContextCache.set(cacheKey, pending);
    return pending;
  };

  return async (input, _toolUseID, options): Promise<HookJSONOutput> => {
    log.info({ inputKeys: Object.keys(input as object) }, 'Tool safety hook invoked');
    // Type guard for PreToolUse input
    if (!('tool_name' in input) || !('tool_input' in input)) {
      log.info({ input }, 'Hook input missing tool_name/tool_input, skipping');
      return {};
    }

    const { tool_name: toolName, tool_input: toolInput, tool_use_id: toolUseId } = input as { 
      tool_name: string; 
      tool_input: unknown;
      tool_use_id: string;
    };
    // Forward the runtime-provided abort signal through to the safety eval so
    // that pressing Stop mid-evaluation cancels the in-flight LLM call within
    // ms instead of waiting for the next retry boundary. Previously the signal
    // was captured and discarded (`const { signal: _signal } = options;`)
    // which made turn-abort invisible to the evaluator.
    const { signal: evalSignal } = options;

    // Use effective identifier (inner tool_id for use_tool)
    const effectiveToolId = getEffectiveToolIdentifier(toolName, toolInput);
    const routerInput = getRouterToolInput(toolName, toolInput);
    const packageId = routerInput?.package_id as string | undefined;
    const sessionKind = sessionId ? classifySessionKind(sessionId) : null;
    const isAutomationSession = sessionKind === 'automation' || sessionKind === 'automation-insight';
    const automationContext = isAutomationSession && sessionId
      ? getAutomationContext(sessionId)
      : undefined;
    const automationIdForEvalError = isAutomationSession && sessionId
      ? (automationContext?.automationId ?? sessionId)
      : undefined;
    const automationNameForEvalError = isAutomationSession
      ? (automationContext?.automationName ?? 'Unknown automation')
      : undefined;

    // REBEL-INTERNAL MCP TOOLS: Always allow tools from Rebel's own bundled
    // MCP servers. These are the app's internal tools (inbox, meetings, settings,
    // etc.) — they manage app-internal state and should never require approval.
    if (routerInput) {
      if (packageId && INTERNAL_MCP_SERVER_NAMES_SET.has(packageId)) {
        // RebelAppBridge has three tool classes:
        //   (1) rebel_browser_* — browser-relay tools that mutate user pages → LLM safety eval
        //   (2) lower-level trust/install tools with local side effects → LLM safety eval + explicit approval
        //   (3) every other rebel_bridge_* host tool — procedural / read-only → auto-allow
        // This package therefore needs a narrower predicate than the generic
        // "all internal MCP tools auto-allow" path.
        const isRebelAppBridgeTrustSensitive =
          packageId === 'RebelAppBridge' &&
          typeof effectiveToolId === 'string' &&
          (effectiveToolId.includes('rebel_browser_') ||
            effectiveToolId.includes('rebel_bridge_approve_pending') ||
            effectiveToolId.includes('rebel_bridge_extract_extension') ||
            effectiveToolId.includes('rebel_bridge_reveal_extension_folder') ||
            effectiveToolId.includes('rebel_bridge_open_extensions_page') ||
            effectiveToolId.includes('rebel_bridge_reset_install'));

        // RebelPlugins mutating tools write/compile/execute plugin code (which
        // runs in the renderer process) and can publish it to shared Spaces.
        // They must NOT be wholesale auto-allowed like the read-only internal
        // tools — route them through the LLM safety prompt so plugin writes are
        // at least visible to the safety system. Read-only tools (list,
        // get_source, open) stay auto-allowed. The richer, plugin-specific gate
        // is the PluginSecurityDialog (see plan 260527 — Tier 3).
        const isRebelPluginsTrustSensitive =
          packageId === 'RebelPlugins' &&
          typeof effectiveToolId === 'string' &&
          (effectiveToolId.includes('rebel_plugins_create') ||
            effectiveToolId.includes('rebel_plugins_delete') ||
            effectiveToolId.includes('rebel_plugins_fork') ||
            effectiveToolId.includes('rebel_plugins_archive') ||
            effectiveToolId.includes('rebel_plugins_restore') ||
            effectiveToolId.includes('rebel_plugins_copy_to_space') ||
            effectiveToolId.includes('rebel_plugins_move_to_space'));

        // RebelSettings model tools are auto-allowed like the other internal
        // tools, EXCEPT when the requested change escalates a model role onto
        // a premium always-on-thinking model (2x-cost class, e.g. Fable 5).
        // Cost escalation is a spend decision the user must approve — route it
        // through the normal approval/safety path. All other invocations
        // (existing tiers, non-premium role changes) keep the auto-allow.
        const rebelSettingsCostEscalation = getRebelSettingsCostEscalation(
          packageId,
          effectiveToolId,
          getRouterArgs(toolName, toolInput),
          getCostGateSettings(),
        );
        if (rebelSettingsCostEscalation) {
          log.info(
            { toolName, effectiveToolId, packageId, premiumModels: rebelSettingsCostEscalation.premiumModels },
            'RebelSettings cost-escalation tool — bypass withheld, routing through approval/safety path',
          );
        }

        if (!isRebelAppBridgeTrustSensitive && !isRebelPluginsTrustSensitive && !rebelSettingsCostEscalation) {
          log.info({ toolName, effectiveToolId, packageId }, 'Rebel-internal MCP tool - always allowed');
          if (turnId && isAutomationSession) agentTurnRegistry.recordToolCall(turnId, toolName, toolInput as Record<string, unknown>);
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse' as const,
              permissionDecision: 'allow' as const,
              permissionDecisionReason: 'Rebel-internal MCP tool - always safe',
            },
          };
        }
      }
    }

    // ADMIN-DISABLED TOOLS: Deterministically block tools disabled by the org admin.
    // This MUST run before LLM evaluation and approval flow — admin-disabled tools
    // are hard-blocked, never surfaced for approval, and cannot be overridden by the user.
    //
    // effectiveToolId may be namespaced (e.g., "GoogleWorkspace-liam-com__send_workspace_email")
    // while admin-disabled lists use short names (e.g., "send_workspace_email").
    // We match against both the full ID and the short name (after stripping the package prefix).
    {
      let adminBlockReason: string | undefined;
      try {
        // Use the registered boundary instead of dynamically importing the desktop impl; failures are observable and fail open only after logging.
        const authConfig = getRebelAuthProvider().getCachedAuthConfig();
        if (authConfig === null) {
          // Common pre-init / cloud-sentinel / first-fetch-in-flight path. Amendment A1.1 (Phase 6
          // fix per Behavioral-Safety F1): the silent-catch replacement only logged on `throw`;
          // the `null` short-circuit was still silently fail-open. Log explicitly here so admin
          // policy bypasses are observable. Behaviour preserved (fail open) — observability added.
          log.warn({ toolName, effectiveToolId }, 'Auth config unavailable (provider uninitialized, cloud sentinel, or first fetch in-flight); admin-disabled tool check skipped — failing open');
        } else {
          const disabledMap = authConfig.disabledConnectorTools;
          if (disabledMap && Object.keys(disabledMap).length > 0) {
            // Extract the short tool name by stripping the package prefix (everything before __)
            const shortToolName = effectiveToolId.includes('__')
              ? effectiveToolId.split('__').slice(1).join('__')
              : effectiveToolId;
            for (const [, entry] of Object.entries(disabledMap)) {
              if (entry.disabledTools.includes(effectiveToolId) || entry.disabledTools.includes(shortToolName)) {
                adminBlockReason = `BLOCKED BY ADMIN: "${shortToolName}" has been disabled by your organization's administrator. This is NOT a safety policy block — it is an admin-level restriction that cannot be overridden. Do not retry this tool. Inform the user that their organization's administrator has disabled this tool and suggest they contact their admin if they need access.`;
                break;
              }
            }
          }
        }
      } catch (err) {
        log.warn({ err, toolName, effectiveToolId }, 'Failed to resolve auth config for admin-disabled tool check; allowing tool safety flow to continue');
      }
      if (adminBlockReason) {
        log.info({ toolName, effectiveToolId }, 'Admin-disabled tool — hard block (no approval)');
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse' as const,
            permissionDecision: 'deny' as const,
            permissionDecisionReason: adminBlockReason,
          },
        };
      }
    }

    // AGENT FRAMEWORK TOOLS: Always allow tools that are part of the agent execution
    // framework (subagent orchestration, progress tracking, read-only file ops).
    // These have zero external side effects and blocking them breaks agent functionality.
    // This check MUST run before Safety Prompt evaluation — it gates external actions,
    // not the agent's own execution infrastructure.
    if (SKIP_TOOL_NAMES.has(toolName)) {
      log.info({ toolName, effectiveToolId }, 'Agent framework tool - bypassing safety evaluation');
      if (turnId && isAutomationSession) agentTurnRegistry.recordToolCall(turnId, toolName, toolInput as Record<string, unknown>);
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse' as const,
          permissionDecision: 'allow' as const,
          permissionDecisionReason: 'Agent framework tool - always safe',
        },
      };
    }

    // CIRCUIT BREAKER: Abort automation if too many tools have been staged/denied.
    // This prevents runaway automations from burning tokens on repeated Safety Prompt blocks.
    if (isAutomationSession && sessionId) {
      const MAX_AUTOMATION_SAFETY_BLOCKS = 10;
      const blockCount = agentTurnRegistry.getAutomationSafetyBlockCount(sessionId);
      if (blockCount >= MAX_AUTOMATION_SAFETY_BLOCKS) {
        log.warn({ sessionId, blockCount, toolName }, 'Automation circuit breaker triggered — too many safety blocks');
        if (turnId) {
          agentTurnRegistry.recordSecurityDenial(turnId, effectiveToolId, `${CIRCUIT_BREAKER_DENIAL_PREFIX} too many safety blocks`);
        }
        return {
          continue: false,
          stopReason: 'Automation circuit breaker: too many tools blocked',
          hookSpecificOutput: {
            hookEventName: 'PreToolUse' as const,
            permissionDecision: 'deny' as const,
            permissionDecisionReason: 'This automation has been stopped because too many tool calls required approval. Please review the automation\'s safety rules.',
          },
        };
      }
    }

    // WINDOWS PYTHON GUARD: Must run first to prevent Microsoft Store from opening.
    // This check is cheap (uses cached pythonRuntimeService) and critical for Windows UX.
    const pythonGuardResult = await windowsPythonGuard(toolName, toolInput, log);
    if (pythonGuardResult) {
      return pythonGuardResult;
    }

    // MACOS CLT SHIM GUARD: Prevent the agent's Bash tool from exec'ing Apple's
    // xcode-select shims (/usr/bin/git, /usr/bin/python3, etc.), which pop the
    // OS "install developer tools" dialog on a CLT-missing Mac.
    const macGuard = await macosCltShimGuard(toolName, toolInput, log);
    if (macGuard) {
      return macGuard;
    }

    // Note: multi-tool blocking was removed. When a tool needs approval, the turn
    // continues — the agent is told the specific tool was blocked and can keep working
    // on other tasks. Sibling/subsequent tool calls are evaluated independently.

    // MCP server mode: auto-approve all tools
    // User has opted in by enabling MCP server mode, and there's no UI for approval prompts
    if (process.env.REBEL_MCP_SERVER_MODE === '1') {
      log.warn(
        {
          event: 'SECURITY_BYPASS',
          reason: 'MCP_SERVER_MODE',
          toolName,
          effectiveToolId,
          timestamp: new Date().toISOString(),
        },
        '[AUDIT] Tool safety bypassed - MCP server mode active'
      );
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          permissionDecisionReason: 'MCP server mode - user opted in, auto-approving',
        },
      };
    }

    // Check if this tool is in the user's trusted tools list (persistent).
    // Skip in privateMode - user wants approval for every action.
    // Consent-required tools (e.g., calendar mutations) always need per-use
    // approval even if trusted — the user must confirm each occurrence.
    // Sensitive communication tools must still evaluate the current Safety
    // Rules so deleting a saved rule takes effect even if a stale exact-tool
    // trust entry remains.
    if (!privateMode && trustedTools?.some(t => bareToolId(t.toolId) === effectiveToolId)) {
      if (isConsentRequiredTool(effectiveToolId, packageId)) {
        log.info({ toolName, effectiveToolId }, 'Consent-required tool in trusted list — requiring per-use approval (FOX-2922)');
      } else if (requiresSafetyPromptPolicyCheck(effectiveToolId, packageId)) {
        log.info({ toolName, effectiveToolId, packageId }, 'Policy-sensitive communication tool in trusted list — evaluating current Safety Rules');
      } else if (
        isBlockedTool(effectiveToolId) ||
        SENSITIVE_SUBSTRINGS.some((s) => effectiveToolId.toLowerCase().includes(s)) ||
        !isDeterministicallyReadOnly(effectiveToolId)
      ) {
        log.info({ toolName, effectiveToolId, packageId }, 'Trusted tool needs Safety Rules evaluation');
      } else {
        log.info({ toolName, effectiveToolId }, 'Tool in trusted list - auto-allowing');
        if (turnId && isAutomationSession) agentTurnRegistry.recordToolCall(turnId, toolName, toolInput as Record<string, unknown>);
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
            permissionDecisionReason: 'User has marked this tool as always trusted',
          },
        };
      }
    }
    if (privateMode && trustedTools?.some(t => bareToolId(t.toolId) === effectiveToolId)) {
      log.info({ toolName, effectiveToolId }, 'Tool in trusted list but privateMode enabled - requiring approval');
    }

    // Check if this tool has a single-use approval (consume it)
    if (sessionId && consumeSingleUseApproval('tool', sessionId, effectiveToolId)) {
      log.info({ toolName, effectiveToolId, sessionId }, 'Consumed single-use approval');
      if (turnId && isAutomationSession) agentTurnRegistry.recordToolCall(turnId, toolName, toolInput as Record<string, unknown>);
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          permissionDecisionReason: 'One-time approval consumed',
        },
      };
    }

    // DETERMINISTIC SAFETY BYPASSES: These checks must run BEFORE the cross-turn
    // blocking guard. Read-only and metadata tools are always safe and should never
    // be blocked by stale pending approval state (FOX-3063 / REBEL-1BY).

    // Skip evaluation for known safe metadata/discovery operations (exact match)
    const skipEvaluation = shouldSkipEvaluation(toolName, toolInput);
    // Log the actual input keys for debugging when it's use_tool
    const inputForLog = routerInput
      ? { tool_id: routerInput.tool_id, package_id: routerInput.package_id }
      : { keys: Object.keys(toolInput || {}) };
    log.debug({ toolName, skipEvaluation, input: inputForLog }, 'Skip evaluation check');
    
    if (skipEvaluation) {
      log.info({ toolName, effectiveToolId }, 'Skipping evaluation - known metadata operation');
      if (turnId && isAutomationSession) agentTurnRegistry.recordToolCall(turnId, toolName, toolInput as Record<string, unknown>);
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          permissionDecisionReason: 'Metadata/discovery operation - always safe',
        },
      };
    }

    // Pre-evaluation gate: deterministically read-only *non-router* tools skip
    // LLM evaluation entirely. Router calls have stricter package-context checks
    // in shouldSkipEvaluation() and fail closed on malformed package metadata.
    const isRouterCall = getRouterToolInput(toolName, toolInput) !== null;
    if (!isRouterCall && !isBlockedTool(toolName) && !isBlockedTool(effectiveToolId)) {
      const hasSensitiveSubstring = SENSITIVE_SUBSTRINGS.some(s => effectiveToolId.toLowerCase().includes(s));
      if (!hasSensitiveSubstring && isDeterministicallyReadOnly(effectiveToolId)) {
        log.info({ toolName, effectiveToolId }, 'Deterministically read-only - skipping LLM evaluation');
        if (turnId && isAutomationSession) agentTurnRegistry.recordToolCall(turnId, toolName, toolInput as Record<string, unknown>);
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
            permissionDecisionReason: 'Read-only operation - always safe',
          },
        };
      }
    }

    // Deterministic automation allow-gate (positive evidence only).
    // Applies to automation sessions only; ambiguity falls through to LLM eval.
    if (isAutomationSession) {
      const deterministicAllow = getDeterministicAutomationAllowDecision({
        toolName,
        effectiveToolId,
        packageId,
        toolInput,
        spaceCandidates: settingsSpaceCandidates,
        workspacePath,
      });
      if (deterministicAllow) {
        if (deterministicAllow.hasSymlinkTarget) {
          log.warn(
            {
              event: 'safety.deterministic_allow_symlink_path',
              gateId: deterministicAllow.gateId,
              toolName,
              effectiveToolId,
              automationName: automationContext?.automationName,
              targetSpace: deterministicAllow.targetSpace,
            },
            'Deterministic allow resolved via symlinked space path; add fs.realpath verification follow-up',
          );
        }

        log.info(
          {
            event: 'safety.deterministic_allow',
            gateId: deterministicAllow.gateId,
            toolName,
            effectiveToolId,
            sessionId,
            automationName: automationContext?.automationName,
            targetSpace: deterministicAllow.targetSpace,
            writeTargetCount: deterministicAllow.writeTargetCount,
          },
          'Deterministic safety gate allowed automation action',
        );
        if (turnId) agentTurnRegistry.recordToolCall(turnId, toolName, toolInput as Record<string, unknown>);
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
            permissionDecisionReason: deterministicAllow.reason,
          },
        };
      }
    }

    // CROSS-TURN BLOCKING: Check if there's a PENDING approval for this tool in this session.
    // This prevents race conditions where one turn requests approval, but another concurrent
    // turn auto-allows because the session approval isn't stored yet.
    // We check the persisted pending approvals store which is shared across all turns.
    // Note: This runs AFTER deterministic safety bypasses so read-only tools are never
    // blocked by stale pending approval state.
    if (sessionId) {
      const pendingForThisTool = getPendingApprovals().find(
        (p) => p.sessionId === sessionId && 
               (p.toolName === toolName || getEffectiveToolIdentifier(p.toolName, p.input) === effectiveToolId)
      );
      if (pendingForThisTool) {
        log.info(
          { toolName, effectiveToolId, sessionId, pendingTurnId: pendingForThisTool.turnId },
          'Tool has pending approval in another turn - blocking'
        );
        return {
          continue: false,
          stopReason: 'Waiting for user approval on this tool in another turn',
          hookSpecificOutput: {
            hookEventName: 'PreToolUse' as const,
            permissionDecision: 'deny' as const,
            permissionDecisionReason: 'This tool is waiting for user approval in another turn. Please respond to the approval request first.',
          },
        };
      }
    }

    // SAFETY PROMPT EVALUATION: For automation sessions, evaluate against the
    // user's Safety Prompt. Interactive sessions use Safety Prompt too (below).
    if (isAutomationSession && sessionId) {
      if (AUTOMATION_SAFE_BUILTIN_TOOLS.has(toolName)) {
        log.info({ toolName, sessionId }, 'Read-only built-in tool — bypassing Safety Prompt for automation');
        if (turnId) agentTurnRegistry.recordToolCall(turnId, toolName, toolInput as Record<string, unknown>);
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse' as const,
            permissionDecision: 'allow' as const,
            permissionDecisionReason: 'Read-only built-in tool (automation safe)',
          },
        };
      }

      // ALREADY-STAGED GUARD: If this tool already has a pending staged call in
      // this session, skip LLM re-evaluation and return the "queued" response.
      // This prevents the agent from burning safety-eval tokens on repeated
      // retries of a tool that's already awaiting user approval.
      const mcpPayloadForGuard = extractMcpPayload(toolName, toolInput);
      if (mcpPayloadForGuard) {
        const alreadyStaged = getPendingStagedCalls(sessionId).find(
          (c) => c.mcpPayload.packageId === mcpPayloadForGuard.packageId &&
                 c.mcpPayload.toolId === mcpPayloadForGuard.toolId &&
                 c.blockedBy !== 'eval_error'
        );
        if (alreadyStaged) {
          log.info(
            { toolName, effectiveToolId, sessionId, stagedId: alreadyStaged.id },
            'Tool already has pending staged approval — skipping re-evaluation'
          );
          if (turnId) agentTurnRegistry.recordToolCall(turnId, toolName, toolInput as Record<string, unknown>);
          const displayName = alreadyStaged.displayName;
          // Sanitize model-injected _rebel_staged* flags before spreading
          const { _rebel_staged: _, _rebel_staged_message: _unused, ...sanitizedInput } = toolInput as Record<string, unknown>;
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse' as const,
              permissionDecision: 'allow' as const,
              permissionDecisionReason: `Already queued for approval (staged ID: ${alreadyStaged.id})`,
              updatedInput: {
                ...sanitizedInput,
                _rebel_staged: true,
                _rebel_staged_id: alreadyStaged.id,
                _rebel_staged_message: `\n\n"${displayName}" is already queued for user approval. It has NOT been executed yet.\n\nDo NOT retry this tool — it is already queued and the user will be asked to approve it.\nIf there are other things you can do in the meantime, go ahead.\nIf you respond to the user before approval, say only that you are waiting for their approval. Do NOT say the action failed, could not send, or could not run.`,
              },
            },
          };
        }
      }

      // Migration gate: fail-closed if migration hasn't completed yet
      if (!isMigrationComplete()) {
        log.warn({ toolName, sessionId }, 'Safety Prompt migration not complete — blocking');
        return {
          continue: false,
          hookSpecificOutput: {
            hookEventName: 'PreToolUse' as const,
            permissionDecision: 'deny' as const,
            permissionDecisionReason: 'Safety system initializing — please try again shortly.',
          },
        };
      }

      const safetyPrompt = getSafetyPrompt();
      const promptVersion = getSafetyPromptVersion();
      const automationSpaceContext = await getActionSpaceContext(toolName, toolInput);
      const [automationSessionIntent, automationUserIntent] = await Promise.all([
        resolveSessionIntent(sessionId),
        resolveUserIntent(effectiveToolId, toolName, packageId, sessionId, evalSignal),
      ]);
      const automationUserIntentExplicit = buildUserIntentExplicit(automationUserIntent);
      const actionContext: ActionContext = {
        toolName: effectiveToolId,
        toolInput:
          effectiveToolId === BROWSER_FILL_FORM_TOOL || effectiveToolId === BROWSER_CLICK_TOOL
            ? preprocessBrowserToolInputForLlm(effectiveToolId, toolInput)
            : (toolInput as Record<string, unknown>) ?? {},
        toolDescription: getToolDescription(effectiveToolId),
        sessionType: 'automation',
        automationName: automationContext?.automationName,
        spaceDescription: automationSpaceContext?.spaceDescription,
        spaceReadmePreview: automationSpaceContext?.spaceReadmePreview,
        spaceLabel: automationSpaceContext?.spaceLabel,
        spaceSharing: automationSpaceContext?.spaceSharing,
        userMessage,
        sessionIntent: automationSessionIntent ?? undefined,
        userIntentExplicit: automationUserIntentExplicit,
      };
      if (automationSessionIntent) {
        log.info(
          {
            event: 'safety.session_intent_injected',
            sessionId,
            toolId: effectiveToolId,
            messageCount: automationSessionIntent.recentUserMessages.length,
            totalChars: automationSessionIntent.totalChars,
          },
          'Session intent attached to automation safety eval',
        );
      }

      // Safety-eval progress: emit `:evaluating` before the await and `-complete`
      // on every exit. Automation sessions rarely have a chat window watching,
      // but cloud clients attached to the session do, and the renderer uses
      // these to lift the chat lock if/when an automation session is surfaced.
      const automationEvalStartedAt = Date.now();
      let automationEvalOutcomeBroadcast = false;
      const emitAutomationComplete = (outcome: ToolSafetyEvaluatingCompletePayload['outcome']) => {
        if (automationEvalOutcomeBroadcast) return;
        automationEvalOutcomeBroadcast = true;
        broadcastSafetyEvaluatingComplete({
          toolUseId,
          sessionId,
          turnId: turnId ?? '',
          outcome,
        });
      };
      broadcastSafetyEvaluating({
        toolUseId,
        sessionId,
        turnId: turnId ?? '',
        toolName: effectiveToolId,
        attempt: 1,
        startedAt: automationEvalStartedAt,
      });

      try {
        const evalResult = await evaluateSafetyPrompt(safetyPrompt, promptVersion, actionContext, {
          signal: evalSignal,
          onAttempt: (attempt) => {
            if (attempt <= 1) return;
            broadcastSafetyEvaluating({
              toolUseId,
              sessionId,
              turnId: turnId ?? '',
              toolName: effectiveToolId,
              attempt,
              startedAt: automationEvalStartedAt,
            });
          },
        });
        let allowed = shouldAllow(evalResult, effectiveToolId);
        const automationApprovalCtx = buildToolApprovalContext(toolName, effectiveToolId, packageId, toolInput);
        const trustApprovalOverride = allowed
          ? getCohabitedTrustApprovalOverride(automationApprovalCtx, safetyPrompt)
          : undefined;
        if (trustApprovalOverride) {
          log.info(
            { toolName, effectiveToolId, packageId, gateId: trustApprovalOverride.gateId, decision: evalResult.decision, confidence: evalResult.confidence },
            'Cohabited-trust gate — tool action requires explicit Safety Rules permission, forcing approval',
          );
          allowed = false;
        }

        // Consent-required tools (e.g., calendar mutations) ALWAYS need explicit
        // user approval, even in automations. See FOX-2922.
        if (allowed && isConsentRequiredTool(effectiveToolId, packageId)) {
          log.info(
            { toolName, effectiveToolId, packageId, decision: evalResult.decision, confidence: evalResult.confidence },
            'Consent-required tool (automation) — overriding auto-allow, forcing user approval'
          );
          allowed = false;
        }

        // Cost-escalation settings changes (moving a model role onto a premium
        // always-on model) ALWAYS need explicit user approval, even if the
        // evaluator allows them — mirrors the consent-required override.
        const costEscalationOverride = allowed
          ? getRebelSettingsCostEscalation(packageId, effectiveToolId, getRouterArgs(toolName, toolInput), getCostGateSettings())
          : null;
        if (costEscalationOverride) {
          log.info(
            { toolName, effectiveToolId, packageId, premiumModels: costEscalationOverride.premiumModels, decision: evalResult.decision, confidence: evalResult.confidence },
            'Cost-escalation settings tool (automation) — overriding auto-allow, forcing user approval'
          );
          allowed = false;
        }

        // Activity log: record the safety evaluation result
        addEvaluationEntry({
          toolDisplayName: effectiveToolId,
          toolId: effectiveToolId,
          actionSummary: effectiveToolId,
          decision: allowed ? 'allowed' : 'blocked',
          reason: trustApprovalOverride?.reason ?? costEscalationOverride?.reason ?? evalResult.reason ?? '',
          sessionType: 'automation',
          automationName: automationContext?.automationName,
          flagged: false,
        });
        getBroadcastService().sendToAllWindows('safety-activity-log:updated', { timestamp: Date.now() });

        if (allowed) {
          const isFileWriteTool = FILE_WRITE_TOOLS.includes(toolName as typeof FILE_WRITE_TOOLS[number]);
          if (isFileWriteTool) {
            log.info(
              { toolName, effectiveToolId, decision: evalResult.decision, confidence: evalResult.confidence },
              'Safety Prompt: allowed file write — delegating to memory write hook'
            );
            // Memory-write hook will emit its own evaluating broadcasts for the
            // second stage; close this one out as "allowed" to clear the subline.
            emitAutomationComplete('allowed');
            return {};
          }

          log.info(
            { toolName, effectiveToolId, decision: evalResult.decision, confidence: evalResult.confidence },
            'Safety Prompt: allowed'
          );
          if (turnId) agentTurnRegistry.recordToolCall(turnId, toolName, toolInput as Record<string, unknown>);
          emitAutomationComplete('allowed');
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse' as const,
              permissionDecision: 'allow' as const,
              permissionDecisionReason: `Safety Prompt: ${evalResult.reason}`,
            },
          };
        }

        // Block — stage for approval
        log.info(
          { toolName, effectiveToolId, decision: evalResult.decision, confidence: evalResult.confidence, reason: evalResult.reason },
          'Safety Prompt: blocked'
        );

        // File writes must always flow through memoryWriteHook, even in
        // headless/CLI turns. That hook owns write-specific staging, approval,
        // and fail-closed handling; the generic approval handler is for tools
        // without a dedicated write-safety path.
        const isFileWriteTool = FILE_WRITE_TOOLS.includes(toolName as typeof FILE_WRITE_TOOLS[number]);
        const mcpPayload = extractMcpPayload(toolName, toolInput);
        const cliApprovalResult = !isFileWriteTool && !evalResult.failClosed
          ? await routeToolSafetyApprovalHandler({
            turnId,
            toolName,
            toolInput,
            reason: costEscalationOverride?.reason ?? (evalResult.reason || 'Blocked by Safety Rules'),
            signal: evalSignal,
            log,
          })
          : null;
        const blockedPathDisposition = classifyBlockedPathDisposition({
          isFileWriteTool,
          isFailClosed: evalResult.failClosed === true,
          hasGenericApprovalResult: cliApprovalResult !== null,
          // Automation uses this helper for both MCP staging and non-MCP
          // queued approvals; the helper retains its own hard-deny fallback.
          canUseStagingPath: true,
        });

        const hardDenyAutomation = (): HookJSONOutput => {
          // Hard-deny fallback if staging couldn't be done. Today this is
          // effectively unreachable: `handleAutomationSafetyPromptBlock`
          // always returns a non-null HookJSONOutput (its `| null` return is
          // vestigial), so the automation `mcpStaging`/`failClosed` cases never
          // actually fall through here. It is kept as the contract-level deny
          // fallback — if that helper ever starts returning null, this is the
          // path that prevents a blocked automation tool from silently slipping
          // through. Mirrors the original ladder's hard-deny tail exactly.
          if (turnId) {
            agentTurnRegistry.recordSecurityDenial(turnId, effectiveToolId, `Safety Rules blocked: ${evalResult.reason}`);
            turnsWithPendingApproval.add(turnId);
          }
          emitAutomationComplete('blocked');
          return {
            continue: false,
            hookSpecificOutput: {
              hookEventName: 'PreToolUse' as const,
              permissionDecision: 'deny' as const,
              permissionDecisionReason: `Safety Rules blocked: ${evalResult.reason}`,
            },
          };
        };

        switch (blockedPathDisposition) {
          case 'fileWrite':
            log.info(
              { toolName, effectiveToolId, sessionId, failClosed: evalResult.failClosed, failClosedReason: evalResult.failClosedReason },
              'Safety Rules blocked file write — delegating to memory write hook for staging',
            );
            emitAutomationComplete(evalResult.failClosed ? 'error' : 'blocked');
            return {};

          case 'failClosed': {
            const failClosedSessionKind = classifySessionKind(sessionId);
            const hasApprovalHandler = Boolean(
              turnId && typeof agentTurnRegistry.getApprovalHandler === 'function'
                ? agentTurnRegistry.getApprovalHandler(turnId)
                : undefined,
            );
            const disposition = resolveFailClosedDisposition({
              sessionKind: failClosedSessionKind,
              hasApprovalHandler,
            });
            const category = classifyFailClosed(evalResult);
            const resolvedCategory = category === 'rate-limited' ? 'rate-limited' : 'infra';
            if (mcpPayload && disposition === 'stage_for_later') {
              return stageEvalErrorMcp({
                mcpPayload,
                toolInput,
                toolName,
                effectiveToolId,
                sessionId,
                turnId,
                toolUseId,
                sessionKind: failClosedSessionKind,
                disposition,
                source: 'fail_closed',
                failClosedReason: evalResult.failClosedReason,
                failClosedCategory: resolvedCategory,
                emitStagedComplete: () => emitAutomationComplete('staged'),
                automationId: automationIdForEvalError,
                automationName: automationNameForEvalError,
                log,
              });
            }

            const failClosedResult = handleAutomationSafetyPromptBlock({
              tool_name: toolName,
              tool_input: toolInput,
              tool_use_id: toolUseId,
              effectiveToolId,
              sessionId,
              turnId,
              blockReason: trustApprovalOverride?.reason ?? costEscalationOverride?.reason ?? evalResult.reason,
              failClosed: evalResult.failClosed,
              failClosedReason: evalResult.failClosedReason,
              win,
              log,
            });
            if (failClosedResult) {
              emitAutomationComplete('error');
              return failClosedResult;
            }
            return hardDenyAutomation();
          }

          case 'genericApproval':
            if (!cliApprovalResult) {
              throw new Error('Blocked path router selected genericApproval without an approval result');
            }
            emitAutomationComplete(cliApprovalResult.approved ? 'allowed' : 'blocked');
            return cliApprovalResult.output;

          case 'mcpStaging': {
            const stagingResult = handleAutomationSafetyPromptBlock({
              tool_name: toolName, tool_input: toolInput, tool_use_id: toolUseId, effectiveToolId,
              sessionId, turnId,
              blockReason: trustApprovalOverride?.reason ?? costEscalationOverride?.reason ?? evalResult.reason,
              failClosed: evalResult.failClosed,
              failClosedReason: evalResult.failClosedReason,
              win, log,
            });
            if (stagingResult) {
              emitAutomationComplete('staged');
              return stagingResult;
            }
            return hardDenyAutomation();
          }

          case 'hardDeny':
            return hardDenyAutomation();

          default:
            return assertNever(blockedPathDisposition, 'BlockedPathDisposition (automation)');
        }
      } catch (err) {
        // On abort, allow — the turn is being cancelled anyway
        if (err instanceof Error && err.name === 'AbortError') {
          log.debug({ toolName }, 'Safety Prompt evaluation aborted — allowing (turn is being cancelled)');
          emitAutomationComplete('aborted');
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse' as const,
              permissionDecision: 'allow' as const,
              permissionDecisionReason: 'Turn aborted - evaluation skipped',
            },
          };
        }
        const throwSessionKind = classifySessionKind(sessionId);
        const hasApprovalHandler = Boolean(
          turnId && typeof agentTurnRegistry.getApprovalHandler === 'function'
            ? agentTurnRegistry.getApprovalHandler(turnId)
            : undefined,
        );
        const disposition = resolveFailClosedDisposition({
          sessionKind: throwSessionKind,
          hasApprovalHandler,
        });
        const mcpPayload = extractMcpPayload(toolName, toolInput);
        if (mcpPayload && disposition === 'stage_for_later') {
          return stageEvalErrorMcp({
            mcpPayload,
            toolInput,
            toolName,
            effectiveToolId,
            sessionId,
            turnId,
            toolUseId,
            sessionKind: throwSessionKind,
            disposition,
            source: 'throw',
            failClosedCategory: 'infra',
            emitStagedComplete: () => emitAutomationComplete('staged'),
            automationId: automationIdForEvalError,
            automationName: automationNameForEvalError,
            log,
          });
        }

        // Fail-closed: treat evaluation errors as blocks for automations.
        // FOX-3231: Don't count these toward the circuit breaker — they're
        // transient evaluator failures, not genuine safety blocks.
        log.warn({ toolName, err }, 'Safety Prompt evaluation failed — fail-closed');
        if (turnId) {
          agentTurnRegistry.recordSecurityDenial(turnId, effectiveToolId, `${EVALUATION_ERROR_PREFIX}Safety Prompt evaluation error`);
        }
        emitAutomationComplete('error');
        return {
          continue: false,
          hookSpecificOutput: {
            hookEventName: 'PreToolUse' as const,
            permissionDecision: 'deny' as const,
            permissionDecisionReason: buildFailClosedDenyReason(toolName),
          },
        };
      }
    }

    // INBOUND TRIGGER: Connector reply tools auto-approve before Safety Prompt
    // eval to avoid unnecessary LLM calls. The user opted into the @-mention
    // (or equivalent) by configuring the inbound trigger; there's no renderer
    // to surface an approval card here. Specific tool ids live in
    // `connectorApprovalGates`.
    const inboundAutoApprove = sessionId?.startsWith('inbound-')
      ? getInboundAutoApproveDecision(effectiveToolId)
      : undefined;
    if (inboundAutoApprove) {
      log.info(
        { toolName, effectiveToolId, sessionId, gateId: inboundAutoApprove.gateId },
        'Inbound trigger — connector reply auto-approved',
      );
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse' as const,
          permissionDecision: 'allow' as const,
          permissionDecisionReason: `Inbound trigger — ${inboundAutoApprove.reason}`,
        },
      };
    }

    // INTERACTIVE SESSIONS: Evaluate against the user's Safety Prompt.
    // Migration gate: fail-closed if migration hasn't completed yet.
    if (!isMigrationComplete()) {
      log.warn({ toolName, sessionId }, 'Safety Prompt migration not complete — blocking (interactive)');
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse' as const,
          permissionDecision: 'deny' as const,
          permissionDecisionReason: 'Safety system initializing — please try again shortly.',
        },
      };
    }

    // ALREADY-STAGED GUARD (interactive): Same as automation path above.
    // Without this, the agent retries a blocked MCP tool on each new turn,
    // the LLM re-evaluates and re-blocks it every time, and the user gets
    // stuck in an infinite approval loop. See automation path for the
    // equivalent guard.
    if (sessionId) {
      const mcpPayloadForInteractiveGuard = extractMcpPayload(toolName, toolInput);
      if (mcpPayloadForInteractiveGuard) {
        const alreadyStaged = getPendingStagedCalls(sessionId).find(
          (c) => c.mcpPayload.packageId === mcpPayloadForInteractiveGuard.packageId &&
                 c.mcpPayload.toolId === mcpPayloadForInteractiveGuard.toolId &&
                 c.blockedBy !== 'eval_error'
        );
        if (alreadyStaged) {
          log.info(
            { toolName, effectiveToolId, sessionId, stagedId: alreadyStaged.id },
            'Interactive tool already has pending staged approval — skipping re-evaluation'
          );
          if (turnId) agentTurnRegistry.recordToolCall(turnId, toolName, toolInput as Record<string, unknown>);
          const displayName = alreadyStaged.displayName;
          const { _rebel_staged: _, _rebel_staged_message: _unused, ...sanitizedInput } = toolInput as Record<string, unknown>;
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse' as const,
              permissionDecision: 'allow' as const,
              permissionDecisionReason: `Already queued for approval (staged ID: ${alreadyStaged.id})`,
              updatedInput: {
                ...sanitizedInput,
                _rebel_staged: true,
                _rebel_staged_id: alreadyStaged.id,
                _rebel_staged_message: `\n\n"${displayName}" is already queued for user approval. It has NOT been executed yet.\n\nDo NOT retry this tool — it is already queued and the user will be asked to approve it.\nIf there are other things you can do in the meantime, go ahead.\nIf you respond to the user before approval, say only that you are waiting for their approval. Do NOT say the action failed, could not send, or could not run.`,
              },
            },
          };
        }
      }
    }

    log.info(
      { toolName, effectiveToolId },
      'Evaluating interactive tool safety via Safety Prompt'
    );

    // Safety-eval progress (interactive path) — THIS is the primary surface the
    // user sees. Broadcasts `tool-safety:evaluating` before the await and a
    // matching `-complete` on every exit so the chat lock never looks silent.
    const interactiveEvalStartedAt = Date.now();
    const interactiveSessionId = sessionId ?? '';
    let interactiveEvalOutcomeBroadcast = false;
    const emitInteractiveComplete = (outcome: ToolSafetyEvaluatingCompletePayload['outcome']) => {
      if (interactiveEvalOutcomeBroadcast) return;
      interactiveEvalOutcomeBroadcast = true;
      broadcastSafetyEvaluatingComplete({
        toolUseId,
        sessionId: interactiveSessionId,
        turnId: turnId ?? '',
        outcome,
      });
    };
    broadcastSafetyEvaluating({
      toolUseId,
      sessionId: interactiveSessionId,
      turnId: turnId ?? '',
      toolName: effectiveToolId,
      attempt: 1,
      startedAt: interactiveEvalStartedAt,
    });

    // Stage 1 (P0.4 / Lever E) — same-tool session memoization key. Computed
    // before the eval so a cache hit short-circuits the LLM call entirely.
    // See docs/plans/260526_safety_eval_context_completeness.md.
    const safetyEvalMemoizationEnabled = settings.safetyEvalMemoization !== false;
    const memoizationKey = safetyEvalMemoizationEnabled
      ? buildNormalizedToolKey({ toolName, effectiveToolId, packageId, toolInput })
      : null;

    const stageInteractiveEvalErrorMcp = (
      mcpPayload: StageToolCallInput['mcpPayload'],
      params: {
        sessionKind: ReturnType<typeof classifySessionKind>;
        disposition: ReturnType<typeof resolveFailClosedDisposition>;
        failClosedReason?: SafetyEvalResult['failClosedReason'];
        failClosedCategory: 'infra' | 'rate-limited';
        source: 'fail_closed' | 'throw';
      },
    ): HookJSONOutput => {
      return stageEvalErrorMcp({
        mcpPayload,
        toolInput,
        toolName,
        effectiveToolId,
        sessionId,
        turnId,
        toolUseId,
        sessionKind: params.sessionKind,
        disposition: params.disposition,
        source: params.source,
        failClosedReason: params.failClosedReason,
        failClosedCategory: params.failClosedCategory,
        memoizationKey,
        emitStagedComplete: () => emitInteractiveComplete('staged'),
        log,
      });
    };

    const addInteractiveNonMcpApprovalRequest = (params: {
      reason: string;
      blockedBy: ToolBlockSource;
      allowPermanentTrust: boolean;
      riskLevel: RiskLevel;
    }): void => {
      const { reason, blockedBy, allowPermanentTrust, riskLevel } = params;
      pendingApprovalMetadata.set(toolUseId, { sessionId: sessionId || '', toolIdentifier: effectiveToolId });

      const conversationTitle = getSessionTitle(sessionId);
      const packageName = extractPackageName(toolName, toolInput);
      const approvalRequest = {
        toolUseID: toolUseId,
        turnId: turnId || '',
        sessionId,
        toolName: toolName,
        input: sanitizeToolInputForApproval(toolInput as Record<string, unknown>),
        reason,
        timestamp: Date.now(),
        riskLevel,
        conversationTitle,
        packageName,
        allowPermanentTrust,
        effectiveToolId,
        blockedBy,
      };
      addPendingApproval(approvalRequest);

      if (turnId) {
        broadcastTypedPayload(getBroadcastService(), 'tool-safety:approval-request', approvalRequest);
      }
    };

    const buildNonMcpQueuedAgentReason = (params: {
      reason: string;
      blockedBy: ToolBlockSource;
    }): string => {
      if (params.blockedBy === 'eval_error') {
        return buildEvalErrorAgentReason(toolName);
      }

      return `TOOL QUEUED — PENDING USER REVIEW

"${toolName}" has been queued for user review. It has NOT been executed yet.

Reason: ${params.reason}

Do NOT retry this tool or try to work around it — the user will be asked to approve it.
If there are other things you can do in the meantime, go ahead.
If you respond to the user before approval, say only that you are waiting for their approval. Do NOT say the action failed, could not send, or could not run.
When you need the result of this tool, you must STOP and tell the user you're waiting for their approval. The approval can only take effect on your next turn — once approved, the user will send you a message and you can retry the tool then.`;
    };

    const handleInteractiveEvalErrorRouting = async (params: {
      source: 'fail_closed' | 'throw';
      mcpPayload: StageToolCallInput['mcpPayload'] | null;
      failClosedReason?: SafetyEvalResult['failClosedReason'];
      failClosedCategory: 'infra' | 'rate-limited';
    }): Promise<HookJSONOutput> => {
      const { source, mcpPayload, failClosedReason, failClosedCategory } = params;
      const evalErrorUserReason = buildEvalErrorUserReason();
      const sessionKind = classifySessionKind(sessionId ?? '');
      const hasApprovalHandler = Boolean(
        turnId && typeof agentTurnRegistry.getApprovalHandler === 'function'
          ? agentTurnRegistry.getApprovalHandler(turnId)
          : undefined,
      );
      const disposition = resolveFailClosedDisposition({
        sessionKind,
        hasApprovalHandler,
      });

      if (mcpPayload && (disposition === 'ask_local' || disposition === 'stage_for_later')) {
        return stageInteractiveEvalErrorMcp(mcpPayload, {
          sessionKind,
          disposition,
          failClosedReason,
          failClosedCategory,
          source,
        });
      }

      if (disposition === 'ask_remote') {
        log.info(
          {
            event: 'tool_safety_eval_error_remote_handler',
            toolName,
            effectiveToolId,
            toolUseId,
            sessionId,
            turnId,
            failClosedReason,
            failClosedCategory,
            sessionKind,
            disposition,
            source,
            hasMcpPayload: Boolean(mcpPayload),
          },
          'Safety evaluator unavailable for interactive tool - routing to approval handler',
        );

        const cliApprovalResult = await routeToolSafetyApprovalHandler({
          turnId,
          toolName,
          toolInput,
          reason: evalErrorUserReason,
          signal: evalSignal,
          log,
        });
        if (cliApprovalResult) {
          emitInteractiveComplete(cliApprovalResult.approved ? 'allowed' : 'blocked');
          return cliApprovalResult.output;
        }
        // TOCTOU residual (FOX-3477): no remote approver was wired for this turn
        // (routeToolSafetyApprovalHandler returned null). Previously control fell through to the
        // terminal silent hard-deny below. When an MCP payload exists we instead STAGE it as an
        // approval card — identical to the ask_local / stage_for_later MCP path above. Staging is
        // strictly safer than the silent deny: it returns permissionDecision 'allow' with
        // _rebel_staged: true, and super-mcp short-circuits _rebel_staged WITHOUT executing the
        // underlying tool, so the write does NOT run until the user approves the staged card.
        // Non-MCP / no-payload ask_remote-null cases still hard-deny below, unchanged.
        if (mcpPayload) {
          return stageInteractiveEvalErrorMcp(mcpPayload, {
            sessionKind,
            disposition,
            failClosedReason,
            failClosedCategory,
            source,
          });
        }
      }

      if (disposition === 'ask_local') {
        addInteractiveNonMcpApprovalRequest({
          reason: evalErrorUserReason,
          blockedBy: 'eval_error',
          allowPermanentTrust: false,
          riskLevel: 'high',
        });
        if (turnId) {
          agentTurnRegistry.recordSecurityDenial(
            turnId,
            effectiveToolId,
            evalErrorUserReason,
          );
        }
        emitInteractiveComplete('blocked');
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse' as const,
            permissionDecision: 'deny' as const,
            permissionDecisionReason: buildNonMcpQueuedAgentReason({
              reason: evalErrorUserReason,
              blockedBy: 'eval_error',
            }),
          },
        };
      }

      const isRateLimited = failClosedCategory === 'rate-limited';
      log.warn(
        { toolName, effectiveToolId, toolUseId, sessionId, turnId, failClosedReason, disposition, source },
        isRateLimited
          ? 'Safety evaluator rate-limited after cooldown wait — transient deny without drawer approval'
          : 'Safety evaluator unavailable after retries — transient deny without drawer approval',
      );
      if (turnId) {
        agentTurnRegistry.recordSecurityDenial(
          turnId,
          effectiveToolId,
          isRateLimited
            ? 'Safety evaluator rate-limited — transient deny without approval'
            : 'Safety evaluator unavailable — transient deny without approval',
        );
      }
      emitInteractiveComplete('error');
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse' as const,
          permissionDecision: 'deny' as const,
          permissionDecisionReason: buildFailClosedDenyReason(toolName),
        },
      };
    };

    try {
      const safetyPrompt = getSafetyPrompt();
      const promptVersion = getSafetyPromptVersion();

      // Phase 4 / Fix 5: resolve user intent BEFORE the memoization cache
      // lookup so that a `negation` classification can invalidate stale allows
      // for this tool family. Otherwise a cache hit would short-circuit the
      // eval and the user's revocation would be silently ignored. The
      // classifier is per-turn-cached on (userMessage, toolFamily) so the
      // cost is one LLM call per pair per turn, not per tool call.
      const interactiveUserIntent = await resolveUserIntent(
        effectiveToolId,
        toolName,
        packageId,
        sessionId,
        evalSignal,
      );
      if (
        interactiveUserIntent?.signal === 'negation' &&
        sessionId
      ) {
        const negatedFamily = getToolFamily({ toolName, effectiveToolId, packageId });
        invalidateSafetyCacheByToolFamily(sessionId, negatedFamily);
      }

      if (sessionId && memoizationKey) {
        const cached = getCachedSafetyAllow({
          sessionId,
          normalizedKey: memoizationKey,
          currentPromptVersion: promptVersion,
        });
        if (cached) {
          const ageMs = Date.now() - cached.storedAtMs;
          log.info(
            {
              event: 'safety.session_decision_cache_hit',
              sessionId,
              toolId: effectiveToolId,
              normalizedKey: memoizationKey,
              priorReason: cached.reason,
              ageMs,
            },
            'Memoized allow — skipping LLM eval',
          );
          addEvaluationEntry({
            toolDisplayName: effectiveToolId,
            toolId: effectiveToolId,
            actionSummary: effectiveToolId,
            decision: 'allowed',
            reason: `Memoized: ${cached.reason}`,
            sessionType: 'interactive',
            flagged: false,
          });
          getBroadcastService().sendToAllWindows('safety-activity-log:updated', { timestamp: Date.now() });
          emitInteractiveComplete('allowed');
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse' as const,
              permissionDecision: 'allow' as const,
              permissionDecisionReason: `Memoized: ${cached.reason}`,
            },
          };
        }
      }

      const interactiveSpaceContext = await getActionSpaceContext(toolName, toolInput);
      const interactiveSessionIntent = await resolveSessionIntent(sessionId);
      const interactiveUserIntentExplicit = buildUserIntentExplicit(interactiveUserIntent);
      const actionContext: ActionContext = {
        toolName: effectiveToolId,
        toolInput:
          effectiveToolId === BROWSER_FILL_FORM_TOOL || effectiveToolId === BROWSER_CLICK_TOOL
            ? preprocessBrowserToolInputForLlm(effectiveToolId, toolInput)
            : (toolInput as Record<string, unknown>) ?? {},
        toolDescription: getToolDescription(effectiveToolId),
        sessionType: 'interactive',
        spaceDescription: interactiveSpaceContext?.spaceDescription,
        spaceReadmePreview: interactiveSpaceContext?.spaceReadmePreview,
        spaceLabel: interactiveSpaceContext?.spaceLabel,
        spaceSharing: interactiveSpaceContext?.spaceSharing,
        userMessage,
        sessionIntent: interactiveSessionIntent ?? undefined,
        userIntentExplicit: interactiveUserIntentExplicit,
      };
      if (interactiveSessionIntent) {
        log.info(
          {
            event: 'safety.session_intent_injected',
            sessionId,
            toolId: effectiveToolId,
            messageCount: interactiveSessionIntent.recentUserMessages.length,
            totalChars: interactiveSessionIntent.totalChars,
          },
          'Session intent attached to interactive safety eval',
        );
      }

      const evalResult = await evaluateSafetyPrompt(safetyPrompt, promptVersion, actionContext, {
        signal: evalSignal,
        onAttempt: (attempt) => {
          if (attempt <= 1) return;
          broadcastSafetyEvaluating({
            toolUseId,
            sessionId: interactiveSessionId,
            turnId: turnId ?? '',
            toolName: effectiveToolId,
            attempt,
            startedAt: interactiveEvalStartedAt,
          });
        },
      });
      let allowed = shouldAllow(evalResult, effectiveToolId);
      const interactiveApprovalCtx = buildToolApprovalContext(toolName, effectiveToolId, packageId, toolInput);
      const trustApprovalOverride = allowed
        ? getCohabitedTrustApprovalOverride(interactiveApprovalCtx, safetyPrompt)
        : undefined;
      if (trustApprovalOverride) {
        log.info(
          { toolName, effectiveToolId, packageId, gateId: trustApprovalOverride.gateId, decision: evalResult.decision, confidence: evalResult.confidence },
          'Cohabited-trust gate — tool action requires explicit Safety Rules permission, forcing user approval',
        );
        allowed = false;
      }

      // Consent-required tools (e.g., calendar mutations) ALWAYS need explicit
      // user approval via the staging UI, regardless of evaluator confidence.
      // See FOX-2874, FOX-2878, FOX-2922.
      if (allowed && isConsentRequiredTool(effectiveToolId, packageId)) {
        log.info(
          { toolName, effectiveToolId, packageId, decision: evalResult.decision, confidence: evalResult.confidence },
          'Consent-required tool — overriding auto-allow, forcing user approval'
        );
        allowed = false;
      }

      // Cost-escalation settings changes (moving a model role onto a premium
      // always-on model) ALWAYS need explicit user approval, even if the
      // evaluator allows them — mirrors the consent-required override.
      const costEscalationOverride = allowed
        ? getRebelSettingsCostEscalation(packageId, effectiveToolId, getRouterArgs(toolName, toolInput), getCostGateSettings())
        : null;
      if (costEscalationOverride) {
        log.info(
          { toolName, effectiveToolId, packageId, premiumModels: costEscalationOverride.premiumModels, decision: evalResult.decision, confidence: evalResult.confidence },
          'Cost-escalation settings tool — overriding auto-allow, forcing user approval'
        );
        allowed = false;
      }

      addEvaluationEntry({
        toolDisplayName: effectiveToolId,
        toolId: effectiveToolId,
        actionSummary: effectiveToolId,
        decision: allowed ? 'allowed' : 'blocked',
        reason: trustApprovalOverride?.reason ?? costEscalationOverride?.reason ?? evalResult.reason ?? '',
        sessionType: 'interactive',
        flagged: false,
      });
      getBroadcastService().sendToAllWindows('safety-activity-log:updated', { timestamp: Date.now() });

      if (allowed) {
        // Stage 1 (P0.4 / Lever E) — record the allow for session memoization.
        // recordSafetyAllow internally guards on decision === 'allow' && !failClosed.
        if (sessionId && memoizationKey) {
          recordSafetyAllow({
            sessionId,
            normalizedKey: memoizationKey,
            result: evalResult,
            promptVersion,
            toolFamily: getToolFamily({ toolName, effectiveToolId, packageId }),
          });
        }

        maybePersistChatIntentRule({
          settings,
          evalResult,
          actionContext,
          toolName,
          effectiveToolId,
          log,
        });

        const isFileWriteTool = FILE_WRITE_TOOLS.includes(toolName as typeof FILE_WRITE_TOOLS[number]);
        if (isFileWriteTool) {
          log.info(
            { toolName, effectiveToolId, decision: evalResult.decision, confidence: evalResult.confidence },
            'Safety Prompt (interactive): allowed file write — delegating to memory write hook'
          );
          // Memory-write hook runs its own eval stage with its own progress
          // broadcasts; release the tool-safety subline with 'allowed' outcome.
          emitInteractiveComplete('allowed');
          return {};
        }

        log.info(
          { toolName, effectiveToolId, decision: evalResult.decision, confidence: evalResult.confidence },
          'Safety Prompt (interactive): allowed'
        );
        emitInteractiveComplete('allowed');
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse' as const,
            permissionDecision: 'allow' as const,
            permissionDecisionReason: `Safety Rules: ${evalResult.reason}`,
          },
        };
      }

      // Blocked: synthetic assessment for downstream staging/deny-then-retry paths
      log.info(
        { toolName, effectiveToolId, decision: evalResult.decision, confidence: evalResult.confidence, reason: evalResult.reason },
        'Safety Prompt (interactive): blocked'
      );
      const blockReason = trustApprovalOverride?.reason ?? costEscalationOverride?.reason ?? evalResult.reason ?? 'Blocked by Safety Rules';
      const assessment: RiskAssessment = {
        risk: 'high' as RiskLevel,
        reason: `Safety Rules blocked: ${blockReason}`,
        allowPermanentTrust: false,
      };

      // Blocked tool: three paths — MCP staging, file write delegation, deny-then-retry
      {
        // Try to extract MCP payload for staging — any MCP tool that needs approval
        // gets staged, regardless of whether its name looks like a side-effect verb.
        // The safety evaluator already decided "ask", so the tool clearly needs approval.
        const mcpPayload = extractMcpPayload(toolName, toolInput);
        const canStage = mcpPayload !== null;

        // FILE WRITE TOOLS: always delegate to memoryWriteHook for the dedicated
        // write/staging path. memoryWriteHook owns its own safety evaluation and
        // fail-closed recovery copy; hard-denying here would bypass that path.
        const isFileWriteTool = FILE_WRITE_TOOLS.includes(toolName as typeof FILE_WRITE_TOOLS[number]);
        const cliApprovalResult = !isFileWriteTool && !evalResult.failClosed
          ? await routeToolSafetyApprovalHandler({
            turnId,
            toolName,
            toolInput,
            reason: assessment.reason,
            signal: evalSignal,
            log,
          })
          : null;
        const blockedPathDisposition = classifyBlockedPathDisposition({
          isFileWriteTool,
          isFailClosed: evalResult.failClosed === true,
          hasGenericApprovalResult: cliApprovalResult !== null,
          canUseStagingPath: Boolean(mcpPayload && sessionId && turnId),
        });

        const denyInteractiveNonMcp = (): HookJSONOutput => {
          // === DENY PATH: Non-MCP tools ===
          // Non-MCP tools can't be staged (no external MCP client to replay them),
          // so we deny but keep the turn alive. Principled blocks still create an
          // approval card. Eval-error handling is routed above: ask_local creates
          // an eval_error card, ask_remote delegates to the approval handler, and
          // only the no-human fallback denies without a drawer approval.
          log.info({ toolName, effectiveToolId, toolUseId, canStage, failClosed: evalResult.failClosed }, 'Tool requires approval - denying (non-blocking)');

          {
            addInteractiveNonMcpApprovalRequest({
              reason: assessment.reason,
              blockedBy: 'safety_prompt',
              allowPermanentTrust: assessment.allowPermanentTrust ?? false,
              riskLevel: assessment.risk,
            });
          }

          // Record the denial for automations/headless reporting (always — independent of persistence)
          if (turnId) {
            agentTurnRegistry.recordSecurityDenial(
              turnId,
              effectiveToolId,
              assessment.reason
            );
          }

          // Non-blocking denial: the agent is told the tool was blocked but can keep
          // working on other tasks. The user approves in the UI when convenient, then
          // clicks "Allow & Retry" to start a new turn that re-executes the tool.
          // We intentionally omit `continue: false` so the turn doesn't stop.
          const approvalResponse: HookJSONOutput = {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse' as const,
              permissionDecision: 'deny' as const,
              permissionDecisionReason: buildNonMcpQueuedAgentReason({
                reason: assessment.reason,
                blockedBy: 'safety_prompt',
              }),
            },
          };
          log.info({ toolName, effectiveToolId }, 'Returning approval-required response (deny without continue:false, non-blocking)');

          // Record denied tool calls for automation sessions.
          // This must happen BEFORE the early return so denied tools are tracked.
          // FOX-3231: Don't count fail-closed denials toward the circuit breaker.
          if (turnId && isAutomationSession && sessionId) {
            agentTurnRegistry.recordToolCall(turnId, toolName, toolInput as Record<string, unknown>);
            if (!evalResult.failClosed) {
              agentTurnRegistry.incrementAutomationSafetyBlock(sessionId);
            }
          }

          emitInteractiveComplete('blocked');
          return approvalResponse;
        };

        switch (blockedPathDisposition) {
          case 'fileWrite':
            log.info(
              {
                toolName,
                effectiveToolId,
                toolUseId,
                failClosed: evalResult.failClosed,
                failClosedReason: evalResult.failClosedReason,
              },
              'File write tool needs approval - delegating to memory write hook for staging');
            // Downstream memory-write hook re-evaluates with its own progress
            // broadcasts; release this subline now. Use 'blocked' because the
            // tool-safety layer itself decided "block" before delegation. Use
            // 'error' for fail-closed so the UI reflects evaluator unavailability.
            emitInteractiveComplete(evalResult.failClosed ? 'error' : 'blocked');
            return {};

          case 'failClosed': {
            const category = classifyFailClosed(evalResult);
            const resolvedCategory = category === 'rate-limited' ? 'rate-limited' : 'infra';
            return handleInteractiveEvalErrorRouting({
              source: 'fail_closed',
              mcpPayload,
              failClosedReason: evalResult.failClosedReason,
              failClosedCategory: resolvedCategory,
            });
          }

          case 'genericApproval':
            if (!cliApprovalResult) {
              throw new Error('Blocked path router selected genericApproval without an approval result');
            }
            emitInteractiveComplete(cliApprovalResult.approved ? 'allowed' : 'blocked');
            return cliApprovalResult.output;

          case 'mcpStaging': {
            if (!mcpPayload || !sessionId || !turnId) {
              return denyInteractiveNonMcp();
            }
            // === STAGING PATH: Stage the tool call for later execution ===
            log.info({ toolName, effectiveToolId, toolUseId, packageId: mcpPayload.packageId, toolId: mcpPayload.toolId },
              'Tool requires approval - staging for later execution');

            const displayName = buildToolDisplayName(mcpPayload.packageId, mcpPayload.toolId, mcpPayload.args);

            const stagingAllowPermanentTrust = assessment.allowPermanentTrust ?? false;
            const stagingBlockedBy = 'safety_prompt' as const;

            const stagingResult = stageToolCall({
              sessionId,
              turnId,
              mcpPayload,
              displayName,
              toolCategory: 'side-effect',
              riskLevel: assessment.risk,
              reason: assessment.reason,
              allowPermanentTrust: stagingAllowPermanentTrust,
              blockedBy: stagingBlockedBy,
            });
            const stagedCall = stagingResult.call;

            // Broadcast to all renderer windows (not win-specific — automations have no BrowserWindow)
            broadcastTypedPayload(getBroadcastService(), 'tool-safety:staged-call', {
              id: stagedCall.id,
              sessionId,
              displayName,
              packageId: mcpPayload.packageId,
              toolId: mcpPayload.toolId,
              riskLevel: assessment.risk,
              reason: assessment.reason,
              timestamp: stagedCall.timestamp,
              allowPermanentTrust: stagingAllowPermanentTrust,
              blockedBy: stagingBlockedBy,
            });

            // Return ALLOW with updatedInput that short-circuits the MCP call.
            // We use 'allow' instead of 'deny' to prevent the runtime from cascading
            // "Sibling tool call errored" to parallel tool calls in the same message.
            // The _rebel_staged flag tells super-mcp-router to return immediately with the
            // staging message instead of actually executing the tool.
            // See: super-mcp/src/handlers/useTool.ts — _rebel_staged guard.
            //
            // Both staging and deny paths are non-blocking — the agent keeps working
            // while the user reviews queued actions at their convenience.
            const stagedMessage = `TOOL QUEUED — WAITING FOR USER APPROVAL

"${displayName}" has been queued for user approval. It has NOT been executed yet.

Reason: ${assessment.reason}

Do NOT retry this tool or try to work around it — it is already queued and the user will be asked to approve it.
If there are other things you can do in the meantime, go ahead.
If you respond to the user before approval, say only that you are waiting for their approval. Do NOT say the action failed, could not send, or could not run.
When you need the result of this tool, you must STOP and tell the user you're waiting for their approval. The approval can only take effect on your next turn — once approved, the user will send you a message and you can retry the tool then.`;

            // Sanitize model input before spreading — strip any _rebel_staged flags
            // the model may have injected to prevent them from surviving into the output.
            const { _rebel_staged: _, _rebel_staged_message: _unused, ...sanitizedInput } = toolInput as Record<string, unknown>;
            emitInteractiveComplete('staged');
            return {
              hookSpecificOutput: {
                hookEventName: 'PreToolUse' as const,
                permissionDecision: 'allow' as const,
                updatedInput: {
                  ...sanitizedInput,
                  _rebel_staged: true,
                  _rebel_staged_message: stagedMessage,
                },
              },
            };
          }

          case 'hardDeny':
            return denyInteractiveNonMcp();

          default:
            return assertNever(blockedPathDisposition, 'BlockedPathDisposition (interactive)');
        }
      }
    } catch (error) {
      // On abort, return allow - the turn is being cancelled anyway.
      // Re-throwing AbortError causes runtime "Tool permission stream closed" errors
      // because the runtime's internal cleanup races with hook error propagation.
      if (error instanceof Error && error.name === 'AbortError') {
        log.debug({ toolName }, 'Tool safety evaluation aborted - allowing (turn is being cancelled)');
        emitInteractiveComplete('aborted');
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
            permissionDecisionReason: 'Turn aborted - evaluation skipped',
          },
        };
      }

      // On other errors, default to denying (safer than allowing)
      // Exception: file-write tools delegate to memoryWriteHook for staging
      const isFileWrite = FILE_WRITE_TOOLS.includes(toolName as typeof FILE_WRITE_TOOLS[number]);
      if (isFileWrite) {
        log.warn({ toolName, error }, 'Tool safety evaluation failed for file write - delegating to memory write hook');
        emitInteractiveComplete('error');
        return {};
      }

      return handleInteractiveEvalErrorRouting({
        source: 'throw',
        mcpPayload: extractMcpPayload(toolName, toolInput),
        failClosedCategory: 'infra',
      });
    } finally {
      // Belt-and-braces: if we ever escape the try without matching a branch
      // above (e.g. future refactor), guarantee the subline clears. The guard
      // inside emitInteractiveComplete ensures we never double-broadcast.
      emitInteractiveComplete('error');
    }
  };
}
// =============================================================================
// canUseTool Callback (DEPRECATED)
// =============================================================================

/**
 * Create the canUseTool callback for custom approval UI.
 * 
 * NOTE: This function is NOT called in bypassPermissions mode (the app's default).
 * The runtime only calls canUseTool when it needs to prompt for permission, but in
 * bypassPermissions mode, it skips all permission prompts.
 * 
 * Tool approval is now handled by blocking inside the PreToolUse hook with
 * waitForApproval(). This callback is kept for potential future use if we
 * switch to a different permission mode.
 * 
 * @deprecated Use blocking in PreToolUse hook instead
 */
export function createCanUseTool(_win: EventWindow | null, _turnId: string): CanUseTool {
  return async (
    toolName: string,
    _input: Record<string, unknown>,
    options: {
      signal: AbortSignal;
      suggestions?: PermissionUpdate[];
      blockedPath?: string;
      decisionReason?: string;
      toolUseID: string;
      agentID?: string;
    }
  ): Promise<PermissionResult> => {
    // This should not be called in bypassPermissions mode
    // If it is called, log a warning and deny by default
    logger.warn(
      { toolName, toolUseID: options.toolUseID },
      'canUseTool called unexpectedly - this should not happen in bypassPermissions mode'
    );
    return {
      behavior: 'deny',
      message: 'Unexpected canUseTool call - approval handled via PreToolUse hook',
    };
  };
}

/**
 * Register approval metadata from a cloud-originated approval request.
 * Called by cloudEventChannel when it receives a tool-safety:approval-request
 * from the cloud service, so that handleApprovalResponse can find the metadata
 * when the user clicks approve locally.
 */
export function registerCloudApprovalMetadata(approval: Record<string, unknown>): void {
  const toolUseID = approval.toolUseID as string;

  // Skip if already registered — prevents log spam from repeated WS reconnects
  // and renderer polling tool-safety:pending via hydrateLocalMetadata.
  if (pendingApprovalMetadata.has(toolUseID)) return;

  // SECURITY (Stage 4b): keep inbound cloud approvals fail-closed by default.
  // If a cloud peer can inject failClosed approvals into desktop's trusted
  // approval drawer, an unscreened action can be rendered as approvable.
  //
  // Any future synchronous inbound-cloud eval_error ASK must be separately
  // security-reviewed and MUST satisfy all of these requirements:
  // 1) Gate on BOTH blockedBy === 'eval_error' and authenticated peer provenance.
  // 2) Persist blockedBy into approvalRequest so renderer trust gates can apply.
  // 3) Suppress permanent trust for eval_error approvals.
  // 4) Keep regression coverage proving failClosed approvals without eval_error
  //    are still dropped at this ingress boundary.
  if (approval.failClosed === true) {
    const sessionId = (approval.sessionId as string) || '';
    const toolName = (approval.toolName as string) || '';
    logger.info(
      { toolUseID, sessionId, toolName, reason: 'eval-unavailable' },
      'Skipping cloud approval registration for fail-closed evaluation',
    );
    return;
  }

  const sessionId = (approval.sessionId as string) || '';
  const toolName = (approval.toolName as string) || '';
  const input = sanitizeToolInputForApproval((approval.input as Record<string, unknown>) || {});
  const effectiveToolId =
    (typeof approval.effectiveToolId === 'string' && approval.effectiveToolId) ||
    getEffectiveToolIdentifier(toolName, input);
  const parsedBlockedBy = ToolBlockSourceSchema.safeParse(approval.blockedBy);

  pendingApprovalMetadata.set(toolUseID, { sessionId, toolIdentifier: effectiveToolId });

  const approvalRequest = {
    toolUseID,
    turnId: (approval.turnId as string) || '',
    sessionId,
    toolName,
    input,
    reason: (approval.reason as string) || '',
    timestamp: (approval.timestamp as number) || Date.now(),
    riskLevel: approval.riskLevel as string,
    conversationTitle: approval.conversationTitle as string,
    packageName: approval.packageName as string,
    allowPermanentTrust: (approval.allowPermanentTrust as boolean) ?? false,
    effectiveToolId,
    blockedBy: backfillToolBlockSource(
      parsedBlockedBy.success ? parsedBlockedBy.data : undefined,
      approval.reason as string | undefined,
    ),
  };

  addPendingApproval(approvalRequest);

  logger.info({ toolUseID, sessionId, toolIdentifier: effectiveToolId },
    'Registered cloud approval metadata locally');
}

/**
 * Handle approval response from renderer.
 * Called via IPC when user clicks "Allow & Retry" or dismisses.
 * 
 * Non-blocking design: This stores the approval for future tool calls.
 * The retry is triggered by a continuation message from the renderer.
 */
export function handleApprovalResponse(
  toolUseID: string,
  approved: boolean,
  _input: Record<string, unknown>,
  _suggestions?: PermissionUpdate[]
): void {
  // Try in-memory metadata first (available if approval happened in same session)
  let metadata = pendingApprovalMetadata.get(toolUseID);
  
  // If not in memory (e.g., after app restart), look up from persisted store
  if (!metadata) {
    const persisted = getPendingApprovals().find((p) => p.toolUseID === toolUseID);
    if (persisted && persisted.sessionId) {
      const effectiveToolId = persisted.effectiveToolId || getEffectiveToolIdentifier(persisted.toolName, persisted.input);
      metadata = {
        sessionId: persisted.sessionId,
        toolIdentifier: effectiveToolId,
      };
      logger.debug({ toolUseID, sessionId: persisted.sessionId, toolIdentifier: effectiveToolId },
        'Recovered metadata from persisted store (app was restarted)');
    }
  }
  
  if (approved && metadata?.sessionId) {
    // Store single-use approval - consumed on next check, not persisted for session
    // This ensures "Allow once" only allows exactly one retry.
    // expectExecution: the renderer sends a "please retry" continuation after
    // this approval — opt into the approval-execution guard so an ignored
    // continuation is force-retried once then surfaced (FOX-2771 Stage 2).
    storeSingleUseApproval('tool', metadata.sessionId, metadata.toolIdentifier, { expectExecution: true });
    logger.info({ toolUseID, toolIdentifier: metadata.toolIdentifier },
      'Stored single-use approval for one-time retry');
  } else {
    logger.info({ toolUseID, approved, hasMetadata: !!metadata }, 'User dismissed or denied - no approval stored');
  }

  // Clean up in-memory metadata and persisted store
  pendingApprovalMetadata.delete(toolUseID);
  removePendingApproval(toolUseID);
}

/**
 * Clean up turn-specific state when a turn ends.
 *
 * Clears the per-turn multi-tool blocking flag (`turnsWithPendingApproval`),
 * which is runtime-only state. Persisted tool approvals are intentionally
 * preserved past turn-end so the user can still act on them — the renderer
 * keeps showing the approval card and the user's approve/deny still routes
 * through the normal `removePendingApproval` path.
 *
 * Persisted approvals (and their in-memory metadata) are cleared by:
 *   - explicit user approve/deny (`handleApprovalResponse`)
 *   - session reset/delete (`cleanupSessionPendingApprovals`, called from
 *     `sessionsHandlers.ts` and `turnAdmission.ts`)
 *
 * History: a previous fix (commit 33d8cf3c0, see
 * `docs-private/investigations/260416_stale_pending_approvals_when_conversation_moves_on.md`)
 * cleared persisted approvals here to fix stale-approval drift, but that
 * caused REBEL-534 — approvals disappeared before users could act, and
 * "continue" couldn't resurface them. See:
 * `docs-private/investigations/260506_tool_approval_empty_and_resubmit_broken.md`.
 */
export function cleanupPendingApprovals(turnId: string): void {
  const hadPendingApproval = turnsWithPendingApproval.delete(turnId);

  logger.debug(
    {
      turnId,
      hadPendingApproval,
    },
    'Cleaned up turn-local approval state (persisted approvals preserved for user action)',
  );
}

/**
 * Clean up all pending tool approvals (persisted + in-memory metadata) for a session.
 * Called on session delete/reset to prevent stale approval accumulation.
 */
export function cleanupSessionPendingApprovals(sessionId: string): void {
  // Collect toolUseIDs that belong to this session so we can clear metadata
  const approvals = getPendingApprovals().filter((a) => a.sessionId === sessionId);
  if (approvals.length > 0) {
    clearPendingApprovalMetadata(approvals.map((a) => a.toolUseID));
  }
  clearPendingApprovalsForSession(sessionId);
}

/**
 * Clear all approvals for a session (call when session is deleted).
 * Clears pending tool approvals (persisted + metadata), single-use approvals,
 * pending memory approvals, staged calls, and Safety Prompt evaluation cache.
 */
export function clearSessionApprovals(sessionId: string): void {
  cleanupSessionPendingApprovals(sessionId);
  clearPendingMemoryApprovalsForSession(sessionId);
  clearSessionSingleUseApprovals(sessionId);
  clearSessionStagedCalls(sessionId);
  clearSafetyPromptCache();
  clearSessionToolDecisionCache(sessionId);
}
