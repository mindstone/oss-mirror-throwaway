import type { ChatMessage, ContentBlock, SystemPrompt, ToolDefinition, TokenUsage } from './modelTypes';
import type { HookCallback } from '@core/agentRuntimeTypes';
import type { AppSettings, ImageContentBlock, ImageRef } from '@shared/types';
import type { CodexAuthProvider } from '@core/codexAuth';
import type { AppNavigationDestination, AppNavigationService } from '@core/appNavigationService';
import type { ScreenshotCaptureService } from '@core/screenshotCaptureService';
import type { ModelClient, RetryInfo } from './modelClient';
import type { RebelCoreThinkingConfig } from './modelLimits';
import type { CodexConnectivity } from './providerRouteDecision';
import type { RoutingModelId } from '@shared/utils/modelChoiceCodec';
import type { RebelCoreTaskStore, RebelCoreTaskStoreInternal } from './taskState';
import type { PlanningStep } from './planningMode';
import type { RuntimeActivityEvent } from './runtimeActivity';
import type { TaskRoutingMetadata } from '@shared/routing/taskRoutingMetadata';
import type { ProfileConnectivity } from '@shared/utils/connectivityHelpers';

// Re-exported from modelTypes for backward compatibility — canonical definitions live there now.
export type { TokenUsage } from './modelTypes';
export { ZERO_TOKEN_USAGE, addUsage, getEffectiveInputTokens } from './modelTypes';

// Re-export from modelLimits for backward compatibility
export type { RebelCoreThinkingConfig } from './modelLimits';

export interface RebelCoreConfig {
  client: ModelClient;
  model: RoutingModelId;
  systemPrompt: SystemPrompt;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  maxTokens?: number;
  /** Max API round-trips. Omit for no limit (matches standard agent loop behaviour). */
  maxTurns?: number;
  signal?: AbortSignal;
  thinking?: RebelCoreThinkingConfig;
  /** Anthropic API effort level for output_config. Maps from ThinkingEffort. */
  effort?: 'low' | 'medium' | 'high' | 'max';
  onRetry?: (params: RetryInfo) => void;
  /** Diagnostic callback fired for every raw SDK stream event. Passed through to StreamParams.onStreamActivity. */
  onStreamActivity?: (event: RuntimeActivityEvent) => void;
  /** Optional per-tool dispatch hook used by the turn watchdog to cancel a single active tool. */
  onToolDispatch?: (toolUseId: string, controller: AbortController) => void;
  /** Optional per-tool settle hook used to clear watchdog cancellation bookkeeping. */
  onToolSettle?: (toolUseId: string) => void;
  suppressLoopComplete?: boolean;
  /** Optional hook called between turns, after tool results are pushed. Can mutate messages. */
  betweenTurns?: (messages: ChatMessage[], lastUsage: TokenUsage) => void | Promise<void>;
  /**
   * Optional hook fired once per agent-loop iteration, after tool results
   * settle and `betweenTurns` has run. Used by the rebelCoreQuery wrapper to
   * flush `routing:tasks:` so task badges surface as soon as MissionSet /
   * TaskCreate / TaskUpdate land — without waiting for the loop to finish.
   * Errors are swallowed with a warning to keep iteration boundaries safe.
   */
  onIterationEnd?: () => void | Promise<void>;
  /** Resolved context window for budget tracking. Undefined = no tracking. */
  contextWindow?: number;
  /** Session context for producer-side image asset materialization (Stage 4). */
  sessionId?: string;
  /** Turn context for producer-side image asset materialization (Stage 4). */
  turnId?: string;
  /**
   * Optional sequence allocator for tool_use:result image asset IDs.
   * Falls back to an internal counter when omitted.
   */
  nextToolResultEventSeq?: () => number;
  /** Surface override for image ref upload status stamping. */
  imageAssetSurface?: 'desktop' | 'cloud';
  /**
   * Callback to record a learned limit from context overflow evidence.
   * Stage 2: also receives the active model + profile id so the writer can
   * stamp the learned ceiling onto the right profile (or auto-create a stub
   * when no matching profile exists).
   */
  onContextOverflow?: (info: {
    model: string;
    profileId: string | null;
    lastKnownInputTokens: number;
  }) => void;
}

export type RebelCoreEvent =
  | { type: 'assistant:text'; text: string }
  | { type: 'assistant:thinking'; thinking: string }
  | { type: 'status'; message: string }
  | { type: 'assistant:message'; content: ContentBlock[] }
  | { type: 'tool_use:start'; toolUseId: string; toolName: string; input: unknown }
  | {
    type: 'tool_use:result';
    toolUseId: string;
    output: string;
    isError: boolean;
    outputChars?: number;
    imageContent?: ImageContentBlock[];
    imageRef?: (ImageRef | null)[];
    /**
     * Refs for opaque-content blocks offloaded to the session-scoped ContentStore
     * (text output > {@link CONTENT_REF_THRESHOLD_BYTES}). Producers fall back to
     * inline output on materialization failure; an empty/undefined value here
     * means "no offload happened" rather than "offload failed silently".
     * See docs/plans/260518_cloud_sync_reconciliation_hardening.md § Stage B1a.
     */
    contentRef?: Array<import('@shared/types/agent').ContentRef | null>;
    /** Opaque Super-MCP outer `_meta` passthrough. See docs/project/SUPER_MCP_PASSTHROUGH_CONTRACT.md. */
    meta?: Record<string, unknown>;
    /** Opaque Super-MCP outer structuredContent passthrough. See docs/project/SUPER_MCP_PASSTHROUGH_CONTRACT.md. */
    structuredContent?: unknown;
  }
  | { type: 'turn:complete'; usage: TokenUsage; stopReason: string; model?: string; contextManagementEdits?: number; contextUtilization?: number }
  | { type: 'turn:error'; error: Error }
  | { type: 'loop:complete'; totalUsage: TokenUsage }
  | { type: 'warning'; category: 'mcp'; message: string }
  | { type: 'recovery:compaction'; message: string }
  | { type: 'recovery:fallback'; message: string; fallbackModel: string }
  | {
    type: 'recovery:skeleton';
    message: string;
    droppedToolResultCount: number;
    droppedToolUseCount: number;
    droppedThinkingCount: number;
    droppedImageCount: number;
    userTextPreserved: boolean;
  }
  | { type: 'context:warning'; utilization: number; message: string };

export interface ToolExecutionResult {
  output: string;
  isError: boolean;
  /** Original tool output size before any model-facing materialisation/truncation. */
  outputChars?: number;
  /**
   * True when the tool already produced a bounded preview of its output (e.g.
   * Bash materialises >20K-char output to a file and returns a ~2 KB preview).
   * The Stage 1 universal output cap in `executeToolUse` skips re-capping such
   * results so it never wraps a preview-of-a-preview. This is a structured
   * signal — do NOT regex-sniff the output prose to detect materialisation.
   * See docs/plans/260529_guard-large-tool-outputs/PLAN.md § Stage 1.
   */
  materialized?: boolean;
  /**
   * Image content blocks from tool results.
   * These blocks are forwarded to both the UI tool event and model-facing tool_result content
   * (provider translators map to provider-specific wire shapes).
   * See docs/project/UI_CHIEF_DESIGNER_VISUAL_VERIFICATION.md for why this is required in-app.
   * See docs/project/ARCHITECTURE_AGENT_TURN_EXECUTION.md and
   * docs/plans/260429_chief_designer_visual_verification_loop.md (Stage 2.5).
   */
  imageContent?: ImageContentBlock[];
  imageRef?: (ImageRef | null)[];
  /** Opaque Super-MCP outer `_meta` passthrough. See docs/project/SUPER_MCP_PASSTHROUGH_CONTRACT.md. */
  meta?: Record<string, unknown>;
  /** Opaque Super-MCP outer structuredContent passthrough. See docs/project/SUPER_MCP_PASSTHROUGH_CONTRACT.md. */
  structuredContent?: unknown;
}

export type ExecuteToolFn = (
  toolName: string,
  input: unknown,
  toolUseId: string,
  signal: AbortSignal,
) => Promise<ToolExecutionResult>;

export type EventHandler = (event: RebelCoreEvent) => void;

export interface RebelCoreHookMatcher {
  matcher?: string;
  hooks: HookCallback[];
  timeout?: number;
}

export interface RebelCoreHooks {
  PreToolUse?: RebelCoreHookMatcher[];
  PostToolUse?: RebelCoreHookMatcher[];
  Stop?: RebelCoreHookMatcher[];
  SubagentStart?: RebelCoreHookMatcher[];
  SubagentStop?: RebelCoreHookMatcher[];
}

export interface HookExecutionContext {
  signal?: AbortSignal;
  sessionId?: string;
  transcriptPath?: string;
  cwd?: string;
  permissionMode?: string;
  stopHookActive?: boolean;
}

export type BuiltinToolName =
  | 'Read'
  | 'Write'
  | 'Edit'
  | 'Bash'
  | 'suggest_connector_setup'
  | 'AskUserQuestion'
  | 'TaskCreate'
  | 'TaskList'
  | 'TaskGet'
  | 'TaskUpdate'
  | 'MissionSet'
  | 'GetMissionContext'
  | 'GetPreviousTasks'
  | 'SummarizeResult'
  | 'TodoWrite'
  | 'TodoRead'
  | 'UpdateModelProfileNotes'
  | 'WebFetch'
  | 'WebSearch'
  | 'SearchFiles'
  | 'Glob'
  | 'LS'
  | 'rebel_operator__consult'
  | 'rebel_meetings_live_transcript'
  | 'rebel_navigate_app'
  | 'rebel_get_app_screenshot'
  | 'inspect_prior_turns'
  | 'get_tool_call';

export interface PluginToolResult {
  ok: boolean;
  errors?: Array<{
    type: string;
    message: string;
    line?: number;
    column?: number;
    snippet?: string;
  }>;
  warnings?: Array<{
    message: string;
    type: string;
  }>;
  previousCrashes?: Array<{
    name: string;
    message: string;
    stack?: string;
    componentStack?: string;
    timestamp: number;
  }>;
  /**
   * Set when a tool-created plugin requested elevated permissions and is not yet
   * active: the plugin was persisted but NOT activated/registered live. The user
   * must approve it via the security review (Settings → Plugins) before it runs.
   * The agent should surface this and must NOT call rebel_plugins_open until the
   * user enables it. See docs/plans/260527_plugin_agent_experience_overhaul.md — Stage 3A.
   */
  pendingSecurityReview?: boolean;
}

export interface PluginChangelogEntry {
  version: string;
  date: string;
  author: string;
  summary: string;
}

export interface PluginSummary {
  id: string;
  name: string;
  description?: string;
}

export interface PluginService {
  createOrUpdate(
    manifest: {
      id: string;
      name: string;
      description?: string;
      documentation?: string;
      version?: string;
      changelog?: PluginChangelogEntry[];
      contributors?: string[];
      createdBy?: string;
      permissions?: string[];
      externalDomains?: string[];
      /**
       * Discovery role within a Space. 'hero' marks the plugin as marquee in the
       * Library Plugins lens (sorted first, Hero badge). 'utility' (default) is the
       * standard role. Discovery/sort signal only — does NOT change render placement.
       * See docs/plans/260521_plugin_publishing_org_distribution.md (Stage A0).
       */
      role?: 'hero' | 'utility';
    },
    source: string,
  ): Promise<PluginToolResult>;
  list(): Promise<PluginSummary[]>;
  getSource(id: string): Promise<
    { ok: true; source: string; manifest: PluginSummary; documentation?: string; version?: string; changelog?: PluginChangelogEntry[] }
    | { ok: false; error: string }
  >;
  delete(id: string): Promise<{ ok: true } | { ok: false; error: string }>;
  open(id: string, params?: Record<string, string>): Promise<{ ok: true } | { ok: false; error: string }>;
}

export interface BuiltinToolContext {
  /**
   * Session identifier for transcript-reading builtin tools (Stage 3 of
   * cross-turn awareness — see `priorTurnsTools.ts`). Required-in-production:
   * the main agent (`rebelCoreQuery.ts`) and sub-agent (`agentTool.ts`)
   * tool-context builders MUST populate this from the active turn's session
   * id. The `inspect_prior_turns` and `get_tool_call` builtins return a
   * visible error (per D-CLEAN-8) when this is empty/undefined, so the
   * runtime safety net catches any path that fails to populate it. Marked
   * optional only to keep historical synthetic test contexts that don't
   * exercise these tools compiling without a churn-of-the-century type ripple.
   */
  sessionId?: string;
  /**
   * Current turn id. See `sessionId`. Used by `inspect_prior_turns` and
   * `get_tool_call` to filter the in-flight turn out of their inspection
   * surface. Tools return a visible error when empty/undefined.
   */
  currentTurnId?: string;
  /**
   * Execution surface capability for built-in tools that need local workspace files.
   * Desktop can read/write user Spaces; cloud must fail closed for desktop-only tools.
   */
  surfaceCapability?: 'desktop' | 'cloud';
  /**
   * True when the user explicitly requested council-style fan-out this turn.
   * Stage 1 defaults this to false; later Operator consult telemetry threads the real signal.
   */
  wasExplicitCouncilIntent?: boolean;
  /** Returns the live execution route for the current step (model the plan is running).
   *  Accessor (not a copied value) so it reflects mid-turn adaptive model switches.
   *  Used by built-in tools (e.g. operator consult) that should run on the step's model. */
  getExecutionRoute?: () => {
    model: string;
    profileId?: string | null;
    effort?: string;
    codexConnectivity: CodexConnectivity;
  };
  cwd?: string;
  /**
   * User home directory. When set, enables the `~/mcp-servers/<project>/`
   * write-sandbox exception used by the build-custom-mcp-server skill.
   * See `src/core/rebelCore/toolPathResolver.ts` for the full policy.
   */
  homePath?: string;
  /** App user-data directory — enables dynamic Bash-guard matching for MCP config paths. */
  userDataPath?: string;
  /**
   * Additional directories that are trusted symlink targets.
   * Populated from Space sourcePaths — when a Space is a symlink to an
   * external folder (e.g. Google Drive), the symlink target is lexically
   * inside the workspace but physically outside it. Without this list,
   * `verifyNoSymlinkEscape` rejects reads/writes through those symlinks.
   */
  allowedSymlinkTargets?: string[];
  signal?: AbortSignal;
  defaultTimeoutMs?: number;
  maxOutputChars?: number;
  taskStore?: RebelCoreTaskStore;
  pluginService?: PluginService;
  taskStoreInternal?: RebelCoreTaskStoreInternal;
  agentNamespace?: string;
  depth?: number;
  /** Narrow MCP tool execution capability for built-in tools. Null when MCP is unavailable. */
  executeMcpTool?: ((name: string, input: unknown) => Promise<ToolExecutionResult>) | null;
  /** Desktop-only capability. See UI_CHIEF_DESIGNER_VISUAL_VERIFICATION for boundary rationale and cloud/mobile no-op semantics. */
  captureRebelWindow?: ScreenshotCaptureService['captureRebelWindow'];
  /** Desktop-only internal app navigation capability for safe visual-review surfaces. */
  navigateApp?: AppNavigationService['navigateApp'];
  /** Per-turn provenance for in-app visual verification captures. */
  visualVerificationNavigation?: VisualVerificationNavigation;
  /** Shared mutable per-turn provenance so parent and sub-agent contexts cannot drift. */
  visualVerificationNavigationState?: VisualVerificationNavigationState;
  /** Notify the platform that a file was written (e.g. for UI cache invalidation). */
  onFileChanged?: (filePath: string) => void;
  /** Per-turn rate limit counter map, keyed by tool name. Shared between parent and subagent via context propagation. */
  rateLimitState?: Map<string, number>;
  /** Optional context for producer-side image ref materialization in built-in tools. */
  imageAssetContext?: {
    sessionId: string;
    turnId: string;
    nextToolResultEventSeq: () => number;
    surface: 'desktop' | 'cloud';
  };
}

/**
 * Sub-agent definition matching the Anthropic Agent API's agent definition shape.
 * Passed from agentTurnExecutor's options.agents to the Agent tool.
 */
export interface RebelCoreAgentDefinition {
  description: string;
  prompt: string;
  tools?: string[];
  model?: 'thinking' | 'working' | 'fast' | 'inherit'
    /** @deprecated Use 'thinking' */ | 'opus'
    /** @deprecated Use 'working' */ | 'sonnet'
    /** @deprecated Use 'fast' */ | 'haiku';
  maxTurns?: number;
  lightweight?: boolean;
  btsCategory?: string;
  maxDurationMs?: number;
  /**
   * Routing mode for sub-agent execution.
   * - 'council' / 'ad-hoc': agent runs through the local model proxy route table.
   *   The proxy receives the route target via `x-routed-model` header.
   * - 'subagent': explicit normal sub-agent routing.
   * - undefined (default): standard ProviderRouter.forSubagent routing.
   */
  routingMode?: 'council' | 'ad-hoc' | 'subagent';
  /**
   * Structured route target model for route-table-backed subagents.
   * This value is the source of truth for route-table transport.
   */
  routedModel?: string | null;
}

/**
 * Context needed by the Agent tool to spawn sub-agent loops.
 * Injected by rebelCoreQuery into the tool executor.
 */
export interface AgentToolContext {
  agents: Record<string, RebelCoreAgentDefinition>;
  client: ModelClient;
  /** App settings — used by sub-agent alias resolution to pick provider-aware models */
  settings: AppSettings;
  parentModel: RoutingModelId;
  /** Parent's resolved maxTokens — sub-agents inherit this */
  parentMaxTokens?: number;
  /** Parent's resolved effort — sub-agents inherit this */
  parentEffort?: 'low' | 'medium' | 'high' | 'max';
  /** Adaptive routing decisions from the plan. Sub-agents may use step-level overrides. */
  planRouting?: import('./planningMode').RoutingDecision;
  /** Parsed plan steps containing planner-assigned sub-agent routing overrides. */
  planSteps?: PlanningStep[];
  /** Per-turn consumed sub-agent assignment keys (`stepIdx:subAgentIdx`) to avoid double-matching. */
  consumedAssignments?: Set<string>;
  /** Proxy config from parent turn — only forwarded when sub-agent model is proxy-compatible */
  proxyConfig?: { baseURL?: string; defaultHeaders?: Record<string, string> } | null;
  /** Turn ID used to materialize provider-route headers for council/ad-hoc sub-agents. */
  turnId?: string;
  /** Codex connectivity snapshot from the parent turn, if known. */
  codexConnectivity: CodexConnectivity;
  /**
   * General connection-liveness snapshot from the parent turn. Used to apply the
   * routing-pool connectivity gate when resolving a planner-ASSIGNED sub-agent
   * model (`resolveAssignedSubAgentProfile`), so a dead-connection profile is
   * rejected the same way the parent execution routing path rejects it. Undefined
   * means "no connectivity info" → the connectivity gate is skipped (permissive),
   * matching pre-Stage-3 behaviour.
   */
  connectivity?: ProfileConnectivity;
  /** Codex auth provider for plan materialization when the caller can supply one. */
  codexAuthProvider?: CodexAuthProvider | null;
  depth?: number;
  agentNamespace?: string;
  taskStoreInternal?: RebelCoreTaskStoreInternal;
  cwd?: string;
  /**
   * User home directory — propagated from parent so sub-agents inherit the
   * `~/mcp-servers/<project>/` write-sandbox exception used by the
   * build-custom-mcp-server skill. See `toolPathResolver.ts`.
   * The skill delegates most coding work to Software Engineer sub-agents
   * (Phase 4.3+), so without this propagation the exception effectively
   * only works for the main-turn scaffold phase.
   */
  homePath?: string;
  /** App user-data directory — propagated so sub-agents inherit MCP config path protection in Bash guard. */
  userDataPath?: string;
  /** Trusted Space symlink targets — propagated so sub-agents inherit the same zone list. */
  allowedSymlinkTargets?: string[];
  signal?: AbortSignal;
  hooks?: RebelCoreHooks;
  hookContext?: HookExecutionContext;
  /** Shared MCP session from the parent turn */
  mcpSession?: { executeTool: (name: string, input: unknown, toolUseId?: string, signal?: AbortSignal) => Promise<ToolExecutionResult> } | null;
  /** All MCP tool definitions available to parent */
  mcpToolDefs?: ToolDefinition[];
  /** Desktop-only capability. Populated from getScreenshotCaptureService() at the populator. Undefined on cloud/mobile. */
  captureRebelWindow?: ScreenshotCaptureService['captureRebelWindow'];
  /** Desktop-only internal app navigation capability. Undefined on cloud/mobile. */
  navigateApp?: AppNavigationService['navigateApp'];
  /** Per-turn provenance for in-app visual verification captures. */
  visualVerificationNavigation?: BuiltinToolContext['visualVerificationNavigation'];
  /** Shared mutable per-turn provenance so parent and sub-agent contexts cannot drift. */
  visualVerificationNavigationState?: BuiltinToolContext['visualVerificationNavigationState'];
  /** Callback to forward sub-agent tool/status events to the parent's AgentMessage stream */
  onSubAgentEvent?: (event: RebelCoreEvent, parentToolUseId: string) => void;
  /** Callback to merge sub-agent usage upon completion */
  onSubAgentComplete?: (usageByModel: Map<string, TokenUsage>) => void;
  /**
   * Record per-task model routing metadata for the renderer's per-task model
   * badges (MissionProgressCard). Used by the Agent tool to attribute the
   * delegation tracking task to the sub-agent's resolved model and context
   * mode. Re-emitted to the renderer via routing:tasks: status events.
   */
  onTaskRoutingMetadataUpdate?: (
    taskId: string,
    info: TaskRoutingMetadata & { isSubAgent: true },
  ) => void;
  /** Notify the platform that a file was written (e.g. for UI cache invalidation). Propagated to sub-agents. */
  onFileChanged?: (filePath: string) => void;
  /** Built-in tool names suppressed by capability resolution. Propagated to sub-agents so they inherit the same suppression. */
  suppressedBuiltins?: BuiltinToolName[];
  /** Per-turn rate limit counter map, keyed by tool name. Shared between parent and subagents via context propagation. */
  rateLimitState?: Map<string, number>;
  /** Codex OAuth mode — forwarded to createClientForModel for sub-agent client creation */
  codexMode?: import('./codexModeTypes').CodexModeConfig;
  /** Transcript session ID for JSONL logging. Propagated to sub-agents. */
  transcriptSessionId?: string;
  /** Transcript turn ID for JSONL logging. Propagated to sub-agents. */
  transcriptTurnId?: string;
  /** Shared mutable sequence counter for monotonic ordering across parent + sub-agents. */
  transcriptSeqCounter?: { next(): number };
  /** Shared sequence allocator for producer-side image ref materialization across parent + sub-agents. */
  nextToolResultEventSeq?: () => number;
  /** Surface used when stamping uploadStatus on image refs. */
  imageAssetSurface?: 'desktop' | 'cloud';
  /** Surface capability propagated so sub-agents inherit the same built-in-tool gating. */
  surfaceCapability?: BuiltinToolContext['surfaceCapability'];
  /** Explicit council intent propagated for consult telemetry. */
  wasExplicitCouncilIntent?: BuiltinToolContext['wasExplicitCouncilIntent'];
}

export interface VisualVerificationNavigation {
  destination: AppNavigationDestination;
  expectedSurface: string;
  settingsTab?: string;
  settingsSection?: string;
}

export interface VisualVerificationNavigationState {
  current?: VisualVerificationNavigation;
}

/**
 * Discriminator for MCP-layer errors. Used to route to dedicated handlers
 * and to tag Sentry events. All fields on `McpErrorInfo` below are best-effort
 * — consumers must tolerate `errorKind: undefined`.
 *
 * - `transport_not_connected`: SDK threw `Error('Not connected')` because
 *   `_transport` was null. Reachable when a parallel call survives the
 *   transport's close, or when the SDK's reconnection path failed silently.
 * - `transport_connection_closed`: SDK threw a `ConnectionClosed` McpError —
 *   the normal post-close rejection for in-flight calls after `client.close()`.
 *   This is OUR link to super-mcp being severed, not a downstream connector death.
 * - `downstream_transport_closed`: super-mcp wrapped a DOWNSTREAM connector's
 *   death in a structured error with code `-33007` (DOWNSTREAM_ERROR). The
 *   connector child (e.g. Brave Search) died/closed its transport; super-mcp's
 *   link to us is fine. The message often contains "Connection closed" /
 *   "MCP error -32000", which would otherwise be mis-bucketed as our own
 *   `transport_connection_closed` — so we check the structured `-33007` code
 *   FIRST. Keeps Sentry able to separate connector deaths from link severance.
 * - `session_not_found`: super-mcp reported the session id is unknown
 *   (`Mcp-Session-Id` header validation failed). Handled by `ensureReconnected`.
 * - `mcp_error`: protocol-level error returned by an MCP server (typed
 *   `McpError` with a JSON-RPC code).
 * - `unknown`: anything else (network, parse, abort).
 */
export type McpErrorKind =
  | 'transport_not_connected'
  | 'transport_connection_closed'
  | 'downstream_transport_closed'
  | 'session_not_found'
  | 'mcp_error'
  | 'unknown';

/**
 * Snapshot captured at the moment the MCP client's transport raises an error
 * event (typically a mid-stream SSE severance). Recorded per-session and
 * attached to subsequent `McpErrorInfo` payloads so we can answer "how long
 * before this tool failure did the transport sever, and how?" from logs alone.
 */
export interface TransportSeveranceSnapshot {
  atMs: number;
  reason: string;
  errName?: string;
  /** Whether this severance triggered the `FATAL_PRE_RESPONSE_PREFIX` fail-closed path. */
  forcedClose: boolean;
  sessionGenerationAtSeverance: number;
  connectionAgeMsAtSeverance: number;
}

export interface McpErrorInfo {
  operation: 'execute_tool' | 'list_tools';
  toolName?: string;
  code?: number;
  message: string;
  rawError: unknown;
  data?: unknown;
  /** Discriminated category for routing/tagging. Best-effort. */
  errorKind?: McpErrorKind;
  /** Anthropic `tool_use_id` from the in-flight tool call. Present only on execute_tool. */
  toolUseId?: string;
  /**
   * Session generation captured at the call-site (before await). Distinct from
   * `sessionGeneration`: if a reconnect ran between call dispatch and error
   * surfacing, these will differ — a useful signal for diagnosing races.
   */
  callGeneration?: number;
  /** Current session generation at error-report time. */
  sessionGeneration?: number;
  /** `Mcp-Session-Id` header value from the streamable-HTTP transport. */
  mcpSessionId?: string;
  /**
   * Local per-tool request signal abort state at error-report time.
   * True means this MCP request was locally cancelled (user/turn/watchdog).
   */
  requestSignalAborted?: boolean;
  /** ms since the most recent successful (re)connect. */
  connectionAgeMs?: number;
  /**
   * Most recent transport severance recorded by `client.onerror`, if any.
   * When present alongside `errorKind === 'transport_not_connected'`, the
   * relationship between `connectionAgeMs` and `atMs` tells us whether the
   * call was made through an already-dead transport or whether the transport
   * died mid-call.
   */
  lastTransportSeverance?: TransportSeveranceSnapshot;
}

export type OnMcpErrorCallback = (info: McpErrorInfo) => void;
