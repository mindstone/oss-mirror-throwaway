/**
 * Schema Gate Hooks (two modes: telemetry-only + enforcing)
 *
 * Tracks whether the model has successfully read a tool's schema
 * (`get_tool_details`) before calling `use_tool`. Split across two hooks that
 * share module-level state (register both with the SAME sessionId):
 * - {@link createSchemaGateHook} — PreToolUse: enforces / warns on `use_tool`.
 * - {@link createSchemaGatePostHook} — PostToolUse: records a tool as hydrated
 *   ONLY when its `get_tool_details` call SUCCEEDED (`!isError`). Attempting the
 *   call is not enough (F3) — an errored `get_tool_details` never saw a schema.
 *
 * Modes (ENFORCING by DEFAULT as of 2026-06-19; controlled via env):
 * - Enforcing (DEFAULT — on unless explicitly disabled): when `use_tool(tool_id=X)`
 *   is called without a prior successful `get_tool_details(X)` this session (and
 *   not a dry_run), the call is DENIED with a corrective message telling the model
 *   to call `get_tool_details({ tool_ids: ['X'] })` first. That call returns X's
 *   full schema + description, making the real typed schema salient at call time
 *   so the model can self-correct in one hop (the root-cause fix). For a model
 *   that already hydrates first (as the tool descriptions instruct), the gate is
 *   a no-op — it only fires on a genuinely-unhydrated `use_tool`.
 *
 *   Loop-guard: a given (session, tool_id) is denied at most
 *   {@link MAX_DENIES_PER_TOOL} times. On the next unhydrated call the gate
 *   allows it through (fail-observable, never fail-closed) so a stuck model
 *   isn't hard-blocked — Stage 0 auto-repair + the -33003 repair-ticket are
 *   the backstops.
 * - Telemetry-only (REBEL_ENFORCE_SCHEMA_GATE=0): logs the unhydrated-use warning
 *   but does NOT block — the rollback-with-observability opt-out.
 *
 * Kill-switch: REBEL_SKIP_SCHEMA_GATE=1 disables the hook entirely (no telemetry,
 * no enforcement). It's a process-env switch: on cloud, set it + restart; on a
 * packaged desktop build there's no remote toggle, so rollback there is a forward
 * release (or launching with the env set) — NOT an atomic fleet-wide switch.
 */
import { createScopedLogger } from '@core/logger';
import type { HookCallback, HookJSONOutput } from '@core/agentRuntimeTypes';

const log = createScopedLogger({ service: 'schemaGate' });

const USE_TOOL_NAME = 'mcp__super-mcp-router__use_tool';
const GET_DETAILS_NAME = 'mcp__super-mcp-router__get_tool_details';
const LIST_TOOLS_NAME = 'mcp__super-mcp-router__list_tools';

/**
 * Max number of times the enforcing gate will deny a given (session, tool_id)
 * before allowing the unhydrated call through. Prevents a stuck model from
 * being hard-blocked into a non-convergent loop.
 */
const MAX_DENIES_PER_TOOL = 2;

/** Session ID → Set of hydrated tool IDs (model has called get_tool_details for these). */
const hydratedTools = new Map<string, Set<string>>();

/** Session ID → (tool ID → number of times the enforcing gate has denied it). */
const denyCounts = new Map<string, Map<string, number>>();

/**
 * Canonical hydration key. Super-MCP asks models to hydrate with NAMESPACED ids
 * (`get_tool_details({ tool_ids: ['Gmail__send_email'] })`) but to execute with a
 * separate `package_id` + a BARE `tool_id` (`use_tool({ package_id: 'Gmail',
 * tool_id: 'send_email', ... })`). To compare the two sides we normalise to the
 * namespaced form: `${package_id}__${tool_id}` when a package_id is present and the
 * tool_id isn't already namespaced; otherwise the tool_id as-is. (Cross-family GPT
 * review, Stage 1 — without this the gate false-denies the normal flow.)
 */
function canonicalHydrationKey(packageId: string | undefined, toolId: string): string {
  if (toolId.includes('__') || !packageId) return toolId;
  return `${packageId}__${toolId}`;
}

function buildDenyReason(hydrationKey: string): string {
  return (
    `Before calling use_tool for '${hydrationKey}', call get_tool_details({ tool_ids: ['${hydrationKey}'] }) ` +
    `to load its exact argument schema (field names, types, required). ` +
    `Then retry use_tool with args that match.`
  );
}

/**
 * Whether the gate ENFORCES (denies unhydrated use_tool) vs telemetry-only.
 * Enforcing is the DEFAULT (2026-06-19); opt out with REBEL_ENFORCE_SCHEMA_GATE=0
 * (keeps telemetry). The full kill-switch REBEL_SKIP_SCHEMA_GATE=1 is checked
 * earlier and short-circuits the hook before this is ever consulted.
 */
function isEnforcingSchemaGate(): boolean {
  return process.env.REBEL_ENFORCE_SCHEMA_GATE !== '0';
}

/**
 * Creates the PreToolUse hook that ENFORCES the gate on `use_tool`. (Hydration
 * recording lives in {@link createSchemaGatePostHook}.)
 *
 * Enforcing by default: it denies an unhydrated `use_tool` with a corrective
 * message (subject to the per-tool deny budget). In telemetry-only mode
 * (REBEL_ENFORCE_SCHEMA_GATE=0) it logs the warning but never blocks.
 */
export function createSchemaGateHook(sessionId: string): HookCallback {
  return async (hookInput, _toolUseId, _options): Promise<HookJSONOutput> => {
    // Env var bypass — disables the hook entirely (no telemetry, no enforcement)
    if (process.env.REBEL_SKIP_SCHEMA_GATE === '1') return {};

    // Only handle PreToolUse events
    if (hookInput.hook_event_name !== 'PreToolUse') return {};

    const toolName = hookInput.tool_name;
    const input = hookInput.tool_input as Record<string, unknown> | undefined;

    // Allow list_tools through unconditionally
    if (toolName === LIST_TOOLS_NAME) return {};

    // get_tool_details: hydration is recorded on SUCCESS by the PostToolUse hook
    // (createSchemaGatePostHook), NOT here at attempt-time. A get_tool_details
    // call that errors must not mark its tool IDs hydrated (F3). Pass through.
    if (toolName === GET_DETAILS_NAME) return {};

    // Handle use_tool calls
    if (toolName === USE_TOOL_NAME && input) {
      const toolId = typeof input.tool_id === 'string' ? input.tool_id : '';

      if (!toolId) return {};
      if (input.dry_run === true) return {};

      // Normalise to the namespaced hydration key so a correct
      // get_tool_details(['Gmail__send_email']) → use_tool({package_id:'Gmail',
      // tool_id:'send_email'}) is recognised as hydrated (Stage 1 review fix).
      const packageId = typeof input.package_id === 'string' ? input.package_id : undefined;
      const hydrationKey = canonicalHydrationKey(packageId, toolId);

      const set = hydratedTools.get(sessionId);
      const isHydrated = !!set && set.has(hydrationKey);

      if (!isHydrated) {
        // Telemetry: always logged regardless of mode.
        log.warn({ sessionId, toolId, hydrationKey }, 'use_tool called without prior get_tool_details');

        // Enforcing (default-on): deny (up to the per-tool budget), else allow through.
        if (isEnforcingSchemaGate()) {
          let sessionDenies = denyCounts.get(sessionId);
          if (!sessionDenies) {
            sessionDenies = new Map();
            denyCounts.set(sessionId, sessionDenies);
          }
          const priorDenies = sessionDenies.get(hydrationKey) ?? 0;

          if (priorDenies >= MAX_DENIES_PER_TOOL) {
            log.warn(
              { sessionId, hydrationKey, priorDenies },
              'schema-gate deny budget exhausted; allowing through',
            );
            return {};
          }

          sessionDenies.set(hydrationKey, priorDenies + 1);
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse' as const,
              permissionDecision: 'deny' as const,
              permissionDecisionReason: buildDenyReason(hydrationKey),
            },
          };
        }
      }
    }

    // All other tools pass through unconditionally
    return {};
  };
}

/**
 * Extract the tool IDs a `get_tool_details` call requested. Handles three forms:
 * a native array, a single string id, AND a stringified JSON array
 * (`'["Gmail__send_email"]'`) — Super-MCP's Stage-0 auto-repair coerces that last
 * form so the call SUCCEEDS, so we must parse it here too; otherwise we'd record
 * the literal `["..."]` string as the hydration key and still deny the real
 * `use_tool` (F1, cross-family review).
 */
function extractRequestedToolIds(input: Record<string, unknown> | undefined): string[] {
  const rawIds = input?.tool_ids;
  if (Array.isArray(rawIds)) {
    return (rawIds as unknown[]).filter((id): id is string => typeof id === 'string');
  }
  if (typeof rawIds === 'string') {
    const trimmed = rawIds.trim();
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          return parsed.filter((id): id is string => typeof id === 'string');
        }
      } catch {
        // Not valid JSON — fall through and treat the whole string as one id.
      }
    }
    return [rawIds];
  }
  return [];
}

/**
 * Creates a PostToolUse hook that records `get_tool_details` hydration — but ONLY
 * when the call SUCCEEDED (`!tool_response.isError`). This is the F3 success-based
 * hydration: a `get_tool_details` that errored (tool not found, transport/exception)
 * must NOT mark its tool IDs as "the model has seen the schema", or the enforcing
 * gate would wave through a `use_tool` that never actually got the schema.
 *
 * Shares the module-level hydration state with the PreToolUse enforcer
 * ({@link createSchemaGateHook}) — pass the SAME sessionId to both, and register
 * this one in the runtime's PostToolUse hooks.
 */
export function createSchemaGatePostHook(sessionId: string): HookCallback {
  return async (hookInput, _toolUseId, _options): Promise<HookJSONOutput> => {
    // Env var bypass — disables the hook entirely (parity with the Pre hook)
    if (process.env.REBEL_SKIP_SCHEMA_GATE === '1') return {};

    if (hookInput.hook_event_name !== 'PostToolUse') return {};
    if (hookInput.tool_name !== GET_DETAILS_NAME) return {};

    // `tool_response` is the ToolExecutionResult ({ output, isError, ... }). Only a
    // successful call hydrates; a failed call (isError) or a missing response leaves
    // the tool UN-hydrated so the gate still enforces on the subsequent use_tool.
    const response = hookInput.tool_response as { isError?: unknown } | undefined;
    if (!response || response.isError === true) {
      log.debug({ sessionId }, 'get_tool_details did not succeed; not recording hydration');
      return {};
    }

    const toolIds = extractRequestedToolIds(hookInput.tool_input as Record<string, unknown> | undefined);
    if (toolIds.length > 0) {
      let set = hydratedTools.get(sessionId);
      if (!set) {
        set = new Set();
        hydratedTools.set(sessionId, set);
      }
      for (const id of toolIds) {
        set.add(id);
      }
      log.debug({ sessionId, toolIds }, 'Recorded hydrated tool IDs (get_tool_details succeeded)');
    }
    return {};
  };
}

/** Remove tracking for a session (cleanup on session reset/end). */
export function clearSchemaGateSession(sessionId: string): void {
  hydratedTools.delete(sessionId);
  denyCounts.delete(sessionId);
}
