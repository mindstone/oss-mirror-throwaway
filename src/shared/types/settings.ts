import type { BtsTaskGroup } from '@shared/costCategories';
import type { BareToolId } from './bareToolId';
import type { CloudErrorCategory } from '@core/services/cloud/cloudErrorCategory';
import type { ReconcilerWriter } from '@core/services/cloud/cloudConnectionReconcilerTypes';
import type { InboundAuthorPolicy } from '@rebel/shared';
import type { ThinkingEffort } from './thinkingEffort';

// =============================================================================
// Voice Settings
// =============================================================================

export interface VoiceProfile {
  /** Unique identifier for this profile */
  id: string;
  /** User-friendly profile name */
  name: string;
  /** Base URL for STT endpoint (without path suffix) */
  sttBaseUrl: string;
  /** STT model identifier */
  sttModel: string;
  /** Base URL for TTS endpoint (without path suffix) */
  ttsBaseUrl?: string;
  /** TTS model identifier */
  ttsModel?: string;
  /** TTS voice identifier */
  ttsVoice?: string;
  /** Optional per-profile API key (falls back to shared OpenAI key when absent) */
  apiKey?: string;
  /** When this profile was created (epoch ms) */
  createdAt: number;
}

export interface VoiceSettings {
  provider: 'openai-whisper' | 'elevenlabs-scribe' | 'local-parakeet' | 'local-moonshine' | 'custom-openai';
  openaiApiKey: string | null;
  elevenlabsApiKey: string | null;
  model: string;
  ttsVoice: string | null;
  activationHotkey: string | null;
  activationHotkeyVoiceMode: boolean;
  /** In-app shortcut to toggle voice recording in the current conversation (no new session). */
  inlineVoiceHotkey?: string | null;
  /** Whether agent responses should be spoken aloud. Default: true */
  autoSpeak?: boolean;
  /**
   * Custom vocabulary words/phrases to help transcription accuracy.
   * - OpenAI: formatted as prompt text ("The following terms may appear: ...")
   * - ElevenLabs: passed as keyterms array (max 100 terms, ≤50 chars, ≤5 words each)
   * Examples: proper nouns, technical terms, company names, acronyms.
   */
  transcriptionVocabulary?: string[];
  /**
   * Language code for voice input transcription (ISO 639-1).
   * When set to 'auto' or undefined, the STT provider auto-detects the language.
   * @see VOICE_INPUT_LANGUAGES for valid codes
   */
  voiceInputLanguage?: string;
  /** Saved custom OpenAI-compatible voice profiles */
  customProfiles?: VoiceProfile[];
  /** Active custom profile ID, or null when none selected */
  activeCustomProfileId?: string | null;
}

/**
 * Resolve the active custom voice profile from settings.
 * Returns null when no valid active profile is selected.
 */
export function getActiveVoiceProfile(settings: VoiceSettings | undefined): VoiceProfile | null {
  if (!settings?.activeCustomProfileId || !settings.customProfiles?.length) return null;
  return settings.customProfiles.find(profile => profile.id === settings.activeCustomProfileId) ?? null;
}

/** Known provider key identifiers for shared API keys (auto-derived from ModelProviderType) */
export type ProviderKeyId = Exclude<ModelProviderType, 'anthropic' | 'other' | 'local'>;

/** Shared API keys entered once and reused across voice, image generation, model profiles, and connectors */
export type ProviderKeys = Partial<Record<ProviderKeyId, string | null>>;

export interface GoogleWorkspaceSettings {
  /** Whether Google Workspace MCP is enabled. Default: false (pending Google OAuth verification) */
  enabled?: boolean;
  /** OAuth Client ID from Google Cloud Console */
  clientId?: string;
  /** OAuth Client Secret from Google Cloud Console */
  clientSecret?: string;
}

export interface HubSpotSettings {
  /** Whether HubSpot MCP is enabled (opt-in). Default: false */
  enabled?: boolean;
  /** OAuth Client ID from HubSpot Developer Portal */
  clientId?: string;
  /** OAuth Client Secret from HubSpot Developer Portal */
  clientSecret?: string;
}

export interface SalesforceSettings {
  /** Whether Salesforce MCP is enabled (opt-in). Default: false */
  enabled?: boolean;
  /** OAuth Client ID from Salesforce Connected App */
  clientId?: string;
  /** OAuth Client Secret from Salesforce Connected App */
  clientSecret?: string;
}

export interface GammaSettings {
  /** Whether Gamma MCP is enabled. Default: false */
  enabled?: boolean;
  /** Gamma API key (see setupUrl in connector-catalog.json for URL) */
  apiKey?: string;
}

export interface ExperimentalSettings {
  /** Whether to use the new unified connections panel. Default: false */
  unifiedConnectionsPanel?: boolean;
  // multiModelEnabled was removed — council mode is now available whenever
  // council-enabled profiles exist. See docs/plans/260325_remove_multimodel_feature_flag.md
  /**
   * Whether to use the pre-turn router for intelligent routing.
   * When enabled, each turn goes through a routing LLM call that decides
   * whether to answer directly or use the full agent loop.
   * Default: false (router disabled - adds ~10s latency per first message)
   */
  routerEnabled?: boolean;
  /**
   * Enable MCP Apps UI rendering in tool results.
   * When enabled, tool results with `_meta.ui.resourceUri` will render
   * interactive Views in sandboxed iframes.
   * Default: false (feature in development)
   */
  mcpAppsEnabled?: boolean;
  /**
   * @deprecated Unified approval UI is now always enabled.
   * This setting is retained for backwards compatibility but has no effect.
   * Direct memory approvals always appear in PendingReviewBar.
   */
  unifiedApproval?: boolean;
  /**
   * Whether the onboarding reveal tour (6-step UI walkthrough after coach completes) is enabled.
   * When false/undefined, the tour is skipped and onboarding completes immediately after the coach.
   * Temporarily disabled for investor event (group setting where tooltips aren't appropriate).
   * Default: false (disabled)
   */
  onboardingRevealTourEnabled?: boolean;
  /**
   * Whether local inference via bundled Ollama is enabled.
   * When enabled, the Local Models section appears in Settings, allowing users
   * to download and run open-weight models entirely on-device.
   * Default: false (disabled)
   */
  localInferenceEnabled?: boolean;
  /** Whether planner-driven adaptive model routing is enabled (experimental).
   * When enabled and plan mode is active, the planner selects which model and
   * reasoning effort to use for each step and sub-agent from routing-eligible profiles.
   * Default: false */
  adaptiveRoutingEnabled?: boolean;
  /**
   * Multi-provider routing foundation (Phase 2, experimental). When enabled,
   * the route-decision provider-choice point enumerates the ordered
   * `enabledProviders` list and picks the highest-priority provider whose
   * credentials are present (and, for ChatGPT Pro, whose connection is live)
   * instead of the single `activeProvider`. Behaviour only changes when this
   * flag is true AND a `enabledProviders` list is set that differs from the
   * implicit `[activeProvider]`. The Stage 6 settings UI (BackupConnectionsSection)
   * writes `enabledProviders` via `writeProviderList()` — so the field is live for
   * flag-enabled users. For users without the flag, `enabledProviders` is absent.
   * Both fields DO persist + cloud-sync when written. Inertness (for normal users)
   * rests on the flag gate, not on the field being unwritable.
   * See docs/plans/260618_multiprovider-foundation/PLAN.md (Stages 3+6).
   * Default: false */
  multiProviderRoutingEnabled?: boolean;
  /**
   * Admit HEALTHY cloud-storage–backed spaces (Google Drive / Dropbox / OneDrive
   * / iCloud / Box reached via a workspace symlink) to full walk / watch / index /
   * search (experimental — `260619_cloud-symlink-indexing`, Stage 6b/7).
   *
   * When OFF (the default), cloud symlink targets are EXCLUDED everywhere exactly
   * as today (the RC-1 / libuv-pool-hang–safe behaviour). When ON, the three
   * descent decision points (background indexing, the Library file tree, the
   * chokidar watcher) consult the off-thread cloud-liveness verdict for the
   * space: `healthy` ⇒ ADMIT; `degraded`/`unknown` ⇒ skip + retain last-known
   * index (never a hang, never a purge). Genuinely-absent entries in a
   * completed-healthy space are reconciled via an `absence-authorized` proof; a
   * mount that recovers (degraded→healthy) triggers a throttled re-index.
   *
   * Desktop-only (no FUSE mounts on cloud/mobile) → LOCAL-ONLY (see
   * cloudSettingsPolicy); not synced to cloud/mobile. The DEFAULT staying false
   * is a deliberate rollout control (a separate decision flips it on).
   * Default: false */
  cloudSymlinkIndexing?: boolean;
  /** Enable the Focus strategic planning surface. Default: false */
  focusEnabled?: boolean;
  /**
   * Whether server-side context compaction (compact_20260112) is enabled.
   * When enabled, Anthropic's API will summarise long conversations to reclaim
   * context window space while preserving key information.
   * This is experimental — the API may reject the request if compaction is not
   * yet supported for the active model.
   * Default: false (disabled)
   */
  compactEnabled?: boolean;
  /**
   * Whether the Mindstone relay submit path (Rebel-name and Anonymous
   * attribution modes) is offered in the MCP build share picker.
   *
   * When `true`: the 3-way attribution picker (Rebel name / GitHub /
   * Anonymous) is shown.
   *
   * When `false`: the picker collapses back to the pre-Stage-1 2-option
   * card (GitHub / Skip) and `handleUseRebelName` / `handleAnonymous`
   * short-circuit with a toast if reached by other means.
   *
   * When `undefined`: channel-aware default — off on stable, on on beta
   * (and dev). See `resolveContributionRelayEnabled` in
   * `@shared/utils/contributionRelayFlag`.
   *
   * Refresh is NOT gated — users who previously submitted via relay can
   * still poll for status regardless of flag state.
   *
   * Stage 5a of `docs/plans/260420_oss_mcp_backend_relay.md`.
   */
  enableContributionRelay?: boolean;
  /**
   * Use cloud webhook for Slack instead of desktop polling.
   * Stage 6 unified external conversation architecture.
   */
  slackCloudWebhookEnabled?: boolean;
  /**
   * Pre-fetch recent Slack thread replies before injecting follow-up @mentions.
   * Default: true.
   */
  slackInboundThreadHistory?: boolean;
  /**
   * Route desktop-polled Slack mentions through canonical thread-bound conversations.
   * Default: true.
   */
  slackDesktopThreadContinuity?: boolean;
  /** Stable UUIDv4 for this Rebel instance, used in outbound transport metadata. */
  agentInstanceId?: string;
  /** Transport-agnostic inbound author policy. */
  inboundAuthorPolicy?: InboundAuthorPolicy;
  /** Local-only forensic snapshot of the most recent corrupted inbound policy payload. */
  inboundAuthorPolicyBackup?: unknown;
  /** Cloud-authoritative status of emergency inbound author policy bypass mode. */
  inboundAuthorPolicyBypassActive?: boolean;
  /** Sanitized cloud Slack workspace status mirrored from cloud-service. */
  cloudSlackWorkspace?: {
    teamId: string;
    teamName: string;
    status: 'connected' | 'needs_reconnect' | 'disconnecting' | 'disconnected';
    peerInstanceCount?: number;
    occurredAt?: number;
    lastSeenAt?: number;
    lastError?: {
      code: string;
      message: string;
      occurredAt: number;
    };
  };
}

export interface CalendarSettings {
  /**
   * User has calendars other than Google or Microsoft (e.g., Apple Calendar, Fastmail).
   * When true, uses LLM-based calendar sync automation (more flexible but costs ~$0.15-0.40/run).
   * When false (default), uses free direct MCP tool calls for Google/Microsoft only.
   * Default: false
   */
  useOtherCalendarProvider?: boolean;
  /** @deprecated Never populated. Kept for backward compat with focusAutomationContext fallback. */
  connectedCalendars?: Array<{ source: string }>;
  /**
   * Per-account calendar selection.
   * Key = calendarSource format ('google:<email>' or 'microsoft:<email>').
   * Value = array of selected calendar IDs.
   * When absent for an account → sync primary/default calendar only (backward compatible).
   * Empty array → treated as absent (defensive, same as primary-only).
   */
  selectedCalendars?: Record<string, string[]>;
  /**
   * Meeting IDs to skip prep for (single-meeting skip).
   * Composite IDs in format 'calendarSource:eventId', stable across syncs.
   */
  skippedMeetingIds?: string[];
  /**
   * Meeting titles to skip prep for (recurring skip).
   * Title matching is case-insensitive.
   */
  prepSkippedTitles?: string[];
}

export const DEFAULT_VOICE_ACTIVATION_HOTKEY = 'Ctrl+Alt+Space';
export const DEFAULT_VOICE_ACTIVATION_VOICE_MODE = true;

/**
 * Default transcription vocabulary to help STT accuracy with common Rebel-related terms.
 * These are terms that speech recognition often struggles with.
 */
export const DEFAULT_TRANSCRIPTION_VOCABULARY = [
  'Mindstone',
  'Rebel',
  'Klavis',
  'MCP',
  'Claude',
  'Anthropic',
  'Sonnet',
  'Opus',
  'Haiku',
  'LLM',
];

// Defined in the `./thinkingEffort` leaf module (avoids import cycles);
// re-exported here so existing `from '.../settings'` import sites keep working.
export type { ThinkingEffort };

/**
 * Session type from renderer perspective.
 * - 'manual': User-initiated conversation (interactive UI)
 * - 'automation': Background automation (onboarding discovery, scheduled tasks)
 * 
 * Mapped to executor SessionType in main process:
 * - 'manual' -> 'interactive'
 * - 'automation' -> 'automation'
 */
export type RendererSessionType = 'manual' | 'automation' | 'onboarding-coach';

/**
 * Tool safety level controls how Rebel evaluates and prompts for potentially risky operations.
 * - 'permissive': Only prompt for catastrophic operations (rm -rf /, DROP DATABASE)
 * - 'balanced': Prompt for destructive operations (delete files, git push) - DEFAULT
 * - 'cautious': Prompt for any data modification
 */
export type ToolSafetyLevel = 'permissive' | 'balanced' | 'cautious';

/**
 * Unified safety level type for all safety domains (tools, memory, etc.).
 * Structurally identical to ToolSafetyLevel - this alias exists to provide
 * a domain-agnostic name for use in shared safety infrastructure.
 */
export type SafetyLevel = ToolSafetyLevel;

/**
 * A tool that the user has marked as always trusted.
 * These tools skip safety evaluation entirely.
 */
export interface TrustedTool {
  /** Effective tool ID (inner tool_id for use_tool, otherwise tool name).
   *  Must be a bare (non-compound) identifier — never "packageId/toolId".
   *  @see BareToolId in `@shared/utils/trustedToolNormalization` */
  toolId: BareToolId;
  /** Human-readable display name (e.g., "Send email") */
  displayName?: string;
  /** MCP server hint for display (e.g., "gmail") */
  serverHint?: string;
  /** When this tool was added to the trusted list (epoch ms) */
  addedAt: number;
}

/**
 * A per-space override for memory safety behavior.
 * Part of the 3-tier memory safety configuration hierarchy.
 */
export interface SpaceSafetyOverride {
  /** Workspace-relative path to the space (POSIX-normalized, e.g., "work/Acme/Exec") */
  spacePath: string;
  /** Human-readable space name for display in Settings UI */
  spaceName: string;
  /** The safety level override for this space */
  level: SafetyLevel;
  /** When this override was created (epoch ms) */
  addedAt: number;
  /** If this was auto-migrated from legacy memoryTrust field */
  migratedFrom?: 'memoryTrust';
}

/**
 * Per-sharing-level memory safety configuration (Tier 2).
 * Each value is optional; undefined means "inherit from Tier 1 base defaults".
 */
export interface MemorySafetyBySharing {
  /** Safety level for spaces with sharing: 'restricted' (was 'team') */
  restricted?: SafetyLevel;
  /** Safety level for spaces with sharing: 'company-wide' */
  'company-wide'?: SafetyLevel;
  /** Safety level for spaces with sharing: 'public' */
  public?: SafetyLevel;
}

/** User's preferred color theme. Default: 'dark' */
export type ThemePreference = 'light' | 'dark' | 'system';

/** @note 'grid' = card view (was Eisenhower matrix, now temporal grouping), 'list' = table view */
export type InboxLayoutMode = 'grid' | 'list';

/**
 * Per-category preference for auto-completing inbox items after CTA execution.
 * Key is `InboxItemCategory` from `@shared/types/inbox`.
 * Kept as `Record<string, boolean>` to avoid coupling settings to inbox type imports.
 */
export type AutoDoneByCategory = Partial<Record<string, boolean>>;

/**
 * Authentication method for Claude API.
 * @deprecated 'oauth-token' is deprecated (Anthropic blocked third-party OAuth April 2026).
 * Kept in union for backward compatibility with historical turn data.
 */
export type ClaudeAuthMethod = 'api-key' | 'oauth-token';

/**
 * Active LLM provider for the app.
 * - 'anthropic': Direct Anthropic API key (default)
 * - 'openrouter': OpenRouter OAuth (multi-provider gateway)
 * - 'codex': ChatGPT Pro subscription (OpenAI models only)
 * - 'mindstone': Mindstone-managed subscription
 */
export type ActiveProvider = 'anthropic' | 'openrouter' | 'codex' | 'mindstone';

export type SubscriptionTier = 'dash' | 'rogue';
export type SubscriptionStatus = 'active' | 'past_due' | 'canceled' | 'incomplete' | 'trialing' | 'inactive';

export interface SubscriptionState {
  tier: SubscriptionTier;
  status: SubscriptionStatus;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  pastDueSince: string | null;
  graceEndsAt: string | null;
  routingAvailable: boolean;
}

/**
 * Authentication method for cost attribution.
 * Canonical values: 'api-key' | 'codex-subscription' | 'openrouter' | 'profile-direct' | 'local' | 'oauth-token' | 'unknown'
 * String type for forward compatibility — new values don't require type changes.
 */
export type AuthMethod = string;

export interface ModelSettings {
  apiKey: string | null;
  /** @deprecated OAuth token for Claude Max subscribers. Cleared by migration; kept for backward compat. */
  oauthToken: string | null;
  /** @deprecated OAuth refresh token for Claude Max token renewal. Cleared by migration; kept for backward compat. */
  oauthRefreshToken?: string | null;
  /** @deprecated OAuth token expiry timestamp in ms. Cleared by migration; kept for backward compat. */
  oauthTokenExpiresAt?: number | null;
  /** Which authentication method to use. Default: 'api-key' */
  authMethod: ClaudeAuthMethod;
  model: string;
  permissionMode: 'bypassPermissions' | 'plan';
  executablePath: string | null;
  /** Whether plan mode is active (thinking model differs from working model). Derived from thinkingModel. */
  planMode: boolean;
  /** Claude model for thinking/planning phase. Undefined = same as working model (single-model mode). */
  thinkingModel?: string;
  /** Profile ID for Thinking role. Undefined = use Claude (claude.thinkingModel). */
  thinkingProfileId?: string;
  /** Profile ID for Working role. Undefined = use Claude (claude.model). */
  workingProfileId?: string;
  /** Fallback model for the thinking tier. Encoded as "model:<name>" or "profile:<id>". */
  thinkingFallback?: string;
  /** Fallback model for the working tier. Encoded as "model:<name>" or "profile:<id>". */
  workingFallback?: string;
  /** Legacy persisted flag; normalization now forces maximum Claude context and keeps runtime 200K fallback paths. */
  extendedContext: boolean;
  /**
   * Master kill-switch for the context-window auto-learn writer. Default-off.
   * When false (the default), context-overflow events never persist a learned
   * `contextWindow` sidecar. Even when true, the writer never learns a value for
   * a model whose context window is known to the registry/presets — the heuristic
   * survives only for genuinely-unknown models. See
   * docs/plans/260529_fix-learned-context-window/PLAN.md (Stage 1).
   */
  learnedContextWindowEnabled?: boolean;
  /**
   * Optional fallback model to try once on context overflow before compaction.
   * Used when no `longContextFallbackProfileId` is configured.
   */
  longContextFallbackModel?: string;
  /**
   * Optional fallback profile (local/alt model) to try once on context overflow before compaction.
   * When set, this takes precedence over `longContextFallbackModel`.
   */
  longContextFallbackProfileId?: string;
  /** Thinking/effort level for model responses. Default: 'high' */
  thinkingEffort: ThinkingEffort;
  /**
   * Per-Claude-model thinking effort overrides.
   * Key is the model ID (e.g., 'claude-opus-4-7'), value is the effort level.
   * When set, takes precedence over the global `thinkingEffort` for that model.
   */
  modelEfforts?: Partial<Record<string, ThinkingEffort>>;
  /** @deprecated OAuth user profile from Claude subscription. Cleared by migration; kept for backward compat. */
  oauthProfile?: {
    displayName?: string;
    email?: string;
    tier?: string;
  };
  /** ISO timestamp set once when OAuth→API-key migration fires. Used by the renderer to show a one-time deprecation banner. */
  oauthMigratedAt?: string;
  /** @deprecated Cached Claude subscription usage data. Cleared by migration; kept for backward compat. */
  usageData?: {
    fiveHour: { utilization: number; resetsAt: string };
    sevenDay: { utilization: number; resetsAt: string };
    sevenDaySonnet: { utilization: number; resetsAt: string };
    extraUsage?: {
      isEnabled: boolean;
      monthlyLimit: number;
      usedCredits: number;
      utilization: number;
    };
    fetchedAt: number;
  };
}

/**
 * @deprecated Use ModelSettings.
 * Retained for compatibility while the settings namespace migrates from
 * `claude.*` to `models.*`.
 */
export type ClaudeSettings = ModelSettings;

// =============================================================================
// OpenRouter Settings
// =============================================================================

/** OAuth authentication method for OpenRouter */
export type OpenRouterAuthMethod = 'oauth';

/** OpenRouter integration settings (OAuth PKCE flow, token managed by app) */
export interface OpenRouterSettings {
  /** Whether OpenRouter is enabled as the LLM provider. Default: false */
  enabled: boolean;
  /** OAuth access token (stored in safeStorage on desktop, auth relay on cloud) */
  oauthToken: string | null;
  /** OAuth refresh token for renewal */
  oauthRefreshToken?: string | null;
  /** OAuth token expiry timestamp in ms */
  oauthTokenExpiresAt?: number | null;
  /** Selected OpenRouter model ID (e.g., 'anthropic/claude-sonnet-4.6') */
  selectedModel: string;
  /** User's OpenRouter display name (from account info) */
  userName?: string | null;
  /** User's OpenRouter email (from account info) */
  userEmail?: string | null;
}

/** Default OpenRouter settings */
export const DEFAULT_OPENROUTER_SETTINGS: OpenRouterSettings = {
  enabled: false,
  oauthToken: null,
  selectedModel: 'openai/gpt-5.5',
};

export interface DiagnosticsSettings {
  debugBreadcrumbsUntil: number | null;
  /** Force direct MCP mode instead of Super-MCP router (for debugging). Default: false */
  forceDirectMcp?: boolean;
  /** Show developer-only settings tab. Default: false */
  developerMode?: boolean;
}

export const DEFAULT_DIAGNOSTICS_SETTINGS: DiagnosticsSettings = {
  debugBreadcrumbsUntil: null,
  forceDirectMcp: false,
  developerMode: false,
};

/**
 * User-supplied telemetry credentials for OSS (community) builds.
 *
 * In an OSS build, error reporting (Sentry) and product analytics (RudderStack)
 * are OFF by default and only ever initialise when `enabled === true` AND the
 * relevant user credential is present — read EXCLUSIVELY from this object,
 * never from env / `app-config.json` / `runtimeConfig`. There is no fallback
 * DSN: an OSS build never phones home to Mindstone's telemetry.
 *
 * Enterprise builds (`isOss === false`) ignore this object entirely and keep
 * reading env / app-config exactly as before.
 *
 * LOCAL_ONLY: this object (incl. the three credentials) is stripped before
 * cloud settings sync — see `LOCAL_ONLY_SETTINGS_KEYS_ARRAY` in
 * `@shared/cloudSettingsPolicy`. Introduced by B6.a (Stage 3a,
 * 260607_oss-b6-launch-polish).
 */
export interface TelemetrySettings {
  /** Master opt-in. Default absent/false — telemetry stays off. */
  enabled: boolean;
  /** User's own Sentry DSN. Sentry inits only when present AND `enabled`. */
  sentryDsn?: string;
  /** User's own RudderStack write key. Rudder inits only when present + dataPlaneUrl + `enabled`. */
  rudderWriteKey?: string;
  /** User's own RudderStack data-plane URL. */
  rudderDataPlaneUrl?: string;
}

/**
 * A symlink connection from a Google Shared Drive folder into the workspace.
 * @deprecated Use SpaceConfig instead. This type is kept for migration compatibility.
 */
export interface GoogleDriveLink {
  /** Display name of the Shared Drive */
  driveName: string;
  /** Absolute path to the Google Drive folder on disk */
  sourcePath: string;
  /** Relative path within workspace where symlink is created */
  symlinkPath: string;
  /** Timestamp when link was created */
  createdAt: number;
}

/** Space type determines the template used and how the space is treated in routing */
export type SpaceType = 'chief-of-staff' | 'personal' | 'company' | 'team' | 'project' | 'operator' | 'other';

/** Sharing level determines who can access the space */
export type SpaceSharingLevel = 'private' | 'restricted' | 'company-wide' | 'public';
/** @deprecated Use 'restricted' instead of 'team' */
export type LegacySpaceSharingLevel = 'private' | 'team' | 'company-wide' | 'public';

/** Storage provider for the space source (for symlinked spaces) */
export type SpaceStorageProvider = 'google_drive' | 'onedrive' | 'dropbox' | 'box' | 'icloud' | 'local' | 'other';

/**
 * Configuration for a Rebel space.
 * Replaces GoogleDriveLink with a richer structure supporting multiple space types.
 */
export interface SpaceConfig {
  /** Unique display name for the space */
  name: string;
  /** Relative path within workspace (e.g., 'Chief-of-Staff', 'work/Mindstone/General') */
  path: string;
  /** Type of space - determines template and routing behavior */
  type: SpaceType;
  /** Whether this space is a symlink to an external folder */
  isSymlink: boolean;
  /** Absolute path to the source folder (for symlinked spaces) */
  sourcePath?: string;
  /** Storage provider for symlinked spaces */
  storageProvider?: SpaceStorageProvider;
  /**
   * @deprecated Replaced by README.md `organisation_name` frontmatter (since Stage 2 of the
   * 260511_spaces_organisation_grouping plan). Still reconciled into the SpaceInfo shape for
   * backwards compatibility; the canonical source is the frontmatter. Prefer
   * `space.organisationName` (set by the Stage 1.6 resolver) for new readers.
   */
  companyName?: string;
  /** Sharing level - who can access this space */
  sharing?: SpaceSharingLevel;
  /** Timestamp when space was created */
  createdAt: number;
  /** Whether this space has a README.md file (space configuration) */
  hasReadme?: boolean;
  /** Brief description of the space (from frontmatter) */
  description?: string;
  /**
   * User-local account associations for this space.
   *
   * Undefined means no local decision has been made, so consumers may use
   * legacy README.md `emails` hints. A defined array, including [], is the
   * user's local account-binding decision.
   */
  associatedAccounts?: string[];
  /** Whether the space directory is writable. true = writable, false = read-only, undefined = not yet checked */
  writable?: boolean;
}

// NPS survey defaults and types
export const NPS_INITIAL_DELAY_DAYS = 10;
export const NPS_DISMISS_SNOOZE_DAYS_SHORT = 14;
export const NPS_DISMISS_SNOOZE_DAYS_LONG = 30;
export const NPS_COMPLETION_SNOOZE_DAYS = 180;

export interface NpsSurveyState {
  /** First time the NPS survey becomes eligible to show (epoch ms). */
  firstEligibleAt: number | null;
  /** Last time the NPS dialog was shown (epoch ms). */
  lastShownAt: number | null;
  /** Last time the NPS dialog was explicitly dismissed (epoch ms). */
  lastDismissedAt: number | null;
  /** Last time the NPS was completed/submitted (epoch ms). */
  lastCompletedAt: number | null;
  /** Last submitted score (0-10). */
  lastScore: number | null;
  /** Last submitted free-text feedback, if any. */
  lastFeedback: string | null;
  /** Do not show before this time (epoch ms). */
  snoozeUntil: number | null;
  /** How many times the dialog has been shown. */
  showCount: number;
  /** How many times the survey was completed. */
  completedCount: number;
  /** If true, never show again (explicit user choice if we add a toggle). */
  neverShowAgain: boolean;
}

/**
 * A personalized use case generated during onboarding based on user's connected tools.
 * Displayed on the landing page as clickable suggestions.
 */
export interface PersonalizedUseCase {
  id: string;
  title: string;
  description: string;
  prompt: string;
  /** Icon identifier (emoji or icon name) */
  icon?: string;
  /** When this use case was generated */
  generatedAt: number;
}

/**
 * A user-defined provider (e.g. a gateway, proxy, or self-hosted endpoint).
 * Appears alongside built-in providers (OpenAI, Gemini, etc.) in Settings.
 */
export interface CustomProvider {
  id: string;
  name: string;
  serverUrl: string;
  apiKey?: string;
  createdAt: number;
}

/**
 * A saved model profile configuration.
 * Each profile represents a configured model provider (local or cloud).
 */
/** Known provider types. 'anthropic' is used for virtual Claude profiles; 'local' is bundled Ollama inference. */
export type ModelProviderType = 'anthropic' | 'openai' | 'google' | 'together' | 'cerebras' | 'openrouter' | 'other' | 'local';
export type CostTier = 'economy' | 'mid-tier' | 'premium';
export type RouteSurface = 'subscription' | 'api-key' | 'pool' | 'local';
export type ModelProfileSource = 'user' | 'connection' | 'auto';

export interface ModelProfile {
  /** Unique identifier for this profile */
  id: string;
  /** User-friendly name (e.g., "Together.ai DeepSeek", "Local LM Studio") */
  name: string;
  /** Explicit auth source for profiles that should use subscription routing instead of shared provider keys. */
  authSource?: 'codex-subscription';
  /** Billing/auth route surface for dedup and presentation logic. */
  routeSurface?: RouteSurface;
  /** Optional preset provenance key (e.g., 'local:ds4'). */
  presetKey?: string;
  /** Provider type. Known providers have preset URLs and model lists. Default: 'other' */
  providerType?: ModelProviderType;
  /** Server URL (must support OpenAI-compatible /v1/chat/completions endpoint) */
  serverUrl: string;
  /** Model name (optional). Leave blank for LM Studio. Required for Ollama/vLLM/cloud. */
  model?: string;
  /** API key for cloud providers (RunPod, Together.ai, OpenRouter). Optional for local servers. */
  apiKey?: string;
  /** Known maximum context window in tokens for this profile's target model. Omit when unknown. */
  contextWindow?: number;
  /**
   * Provenance of `contextWindow` when present. 'user' means a manual entry
   * (the wizard, settings UI, or admin tooling) and is never overwritten by the
   * runtime. 'auto' means the runtime learned the value from a context-overflow
   * event; it can be tightened by subsequent overflows and may be reset by the
   * user. Absence is treated as 'user' (legacy behavior).
   *
   * See docs/plans/260503_unify_learned_limits_into_profiles.md — Provenance Scheme.
   */
  contextWindowSource?: 'user' | 'auto';
  /**
   * Number of context-overflow events that have contributed to the runtime-learned
   * value tracked by `lastLearnedContextWindow`. Drives the tightening margin
   * (0.90 -> 0.80 across 5 events). Meaningful whenever a learned value exists —
   * both when `contextWindowSource === 'auto'` (auto value is in `contextWindow`)
   * and when `contextWindowSource === 'user'` (user overrode but learning continues
   * in the sidecar `lastLearnedContextWindow`).
   */
  contextWindowOverflowCount?: number;
  /**
   * Epoch ms when the runtime-learned value tracked by `lastLearnedContextWindow`
   * was last updated. Used for UI display ("Learned 2 days ago") and debugging.
   * Meaningful whenever a learned value exists — both when
   * `contextWindowSource === 'auto'` and when `contextWindowSource === 'user'`
   * (user overrode but learning continues in the sidecar).
   */
  contextWindowLearnedAt?: number;
  /**
   * Sidecar: the most recent runtime-learned context window value, preserved
   * even when the user has overridden `contextWindow`. Powers the wizard's
   * "Use learned value" affordance and the UI's "Learned value: N" display.
   *
   * Invariant: when `contextWindowSource === 'auto'`, this MUST equal `contextWindow`.
   * When `contextWindowSource === 'user'`, this MAY differ — it represents what
   * the runtime would have learned, surfaced for user reference.
   */
  lastLearnedContextWindow?: number;
  /** Known maximum output tokens for this profile's target model. Omit when unknown (auto-resolved from known-model registry). */
  maxOutputTokens?: number;
  /**
   * Provenance of `maxOutputTokens`. 'user' means a manual entry and is never
   * overwritten by runtime auto-learn. 'auto' means the runtime learned the
   * value from provider invalid-request responses that surfaced the cap.
   */
  outputTokensSource?: 'user' | 'auto';
  /** Number of output-cap overflows that contributed to the learned sidecar. */
  outputTokensOverflowCount?: number;
  /** Epoch ms when `lastLearnedOutputTokens` was last updated by runtime learn. */
  outputTokensLearnedAt?: number;
  /**
   * Sidecar: most recent runtime-learned output cap, preserved even when the
   * user overrides `maxOutputTokens`.
   */
  lastLearnedOutputTokens?: number;
  /** Cost tier for routing. Auto-resolved from MODEL_CATALOG when omitted. */
  costTier?: CostTier;
  /** When this profile was created (epoch ms) */
  createdAt: number;
  /** References a user-defined custom provider (for API key resolution and display). */
  customProviderId?: string;
  /** Whether this profile participates as a council member in council mode. Default: false */
  councilEnabled?: boolean;
  /** Whether this profile is available for adaptive model routing. Default: false */
  routingEligible?: boolean;
  /** Whether this profile is available for dispatch (council, ad-hoc, pre-registration). Default: true (undefined treated as enabled). */
  enabled?: boolean;
  /** True for auto-generated profiles from bare model strings. Hidden from profile management UI. */
  isVirtual?: boolean;
  /** Reasoning effort for reasoning models (GPT-5.2, Gemini, Grok). Controls thinking depth. */
  reasoningEffort?: ThinkingEffort;
  /**
   * NOTE: the former manual "Off" thinking level (`reasoningDisabled`) was removed
   * (2026-06-18). Thinking suppression is now driven solely by the auto-detected
   * `thinkingCompatibility` verdict — Rebel does not offer a turn-thinking-off
   * preference. Legacy `reasoningDisabled:true` profiles are migrated to
   * `thinkingCompatibility:'incompatible'` in `normalizeSettings`. See
   * docs/project/CUSTOM_GATEWAY_COMPATIBILITY.md.
   */
  /** Whether this profile was provisioned by company admin (read-only, non-deletable). */
  companyManaged?: boolean;
  /** 'user' = wizard add-custom path; 'connection' = catalog/subscription materialisation; 'auto' = system-managed profiles. Absent legacy profiles are treated as 'user'. */
  profileSource?: ModelProfileSource;
  /** Chat-completions compatibility verdict. Populated by Test button or runtime auto-mark. */
  chatCompatibility?: 'unknown' | 'compatible' | 'incompatible';
  /** ISO timestamp of the last compatibility check (test or runtime). */
  chatCompatibilityCheckedAt?: string;
  /** JSON structured-output compatibility verdict. Populated by Test button or runtime auto-mark. */
  jsonCompatibility?: 'unknown' | 'compatible' | 'incompatible';
  /** ISO timestamp of the last JSON compatibility check. */
  jsonCompatibilityCheckedAt?: string;
  /** Reasoning/thinking support verdict (reasoning_effort parameter). Populated by Test button. */
  thinkingCompatibility?: 'unknown' | 'compatible' | 'incompatible';
  /** ISO timestamp of the last thinking capability check. */
  thinkingCompatibilityCheckedAt?: string;
  /** Tool-use (function calling) compatibility verdict. Populated by Test button. */
  toolUseCompatibility?: 'unknown' | 'compatible' | 'incompatible';
  /** ISO timestamp of the last tool-use capability check. */
  toolUseCompatibilityCheckedAt?: string;
  /** Free-form notes about this model's capabilities, used by the planner for routing decisions. */
  modelNotes?: string;
  /** @deprecated Use modelNotes. Retained for backward compatibility with saved profiles. */
  strengths?: string;
  /** @deprecated Use modelNotes. Retained for backward compatibility with saved profiles. */
  weaknesses?: string;
}



/**
 * Settings for using alternative models instead of Claude.
 * Supports multiple saved profiles with one active at a time.
 */
export interface LocalModelSettings {
  /** Saved model profiles */
  profiles: ModelProfile[];
  /**
   * ID of the currently active profile, or null to use Claude.
   * @deprecated Prefer `claude.workingProfileId`. Kept for backward compat with LocalModelSection
   * and the `normalizeSettings()` migration bridge.
   */
  activeProfileId: string | null;
  /**
   * Epoch ms when the legacy `rebel-core-learned-model-limits` store was migrated
   * onto profiles. Idempotent guard — the migration is a no-op once this is set.
   */
  learnedLimitsMigratedAt?: number;
  /**
   * Epoch ms when the one-time provenance-disambiguation migration ran (clears
   * registry-stamped `contextWindow` values that were indistinguishable from
   * user-set values pre-this-plan). Idempotent guard.
   */
  registryStampMigratedAt?: number;
  /**
   * Epoch ms when the one-time learned-context-window poison-reset migration ran
   * (clears `source:'auto'` learned context-window sidecar values on catalogued
   * models so resolution falls back to the registry; clears only the learned
   * sidecar provenance on `source:'user'` catalogued profiles while preserving
   * the user's actual contextWindow). Idempotent guard — no-op once set.
   * See docs/plans/260529_fix-learned-context-window/PLAN.md — Stage 2.
   */
  learnedContextWindowPoisonResetAt?: number;
}

/** Default local model settings */
export const DEFAULT_LOCAL_MODEL_SETTINGS: LocalModelSettings = {
  profiles: [],
  activeProfileId: null,
};

/**
 * Settings for the scratchpad quick-capture feature.
 */
export interface ScratchpadSettings {
  /** Folders to exclude from the "Recent Files" list (relative to Chief-of-Staff/memory/) */
  excludedFolders?: string[];
}

/** Default scratchpad settings */
export const DEFAULT_SCRATCHPAD_SETTINGS: ScratchpadSettings = {
  excludedFolders: ['meetings'],
};

/** Rebel avatar options for meeting bot */
export type RebelAvatarId = 'dash' | 'glitch' | 'rogue' | 'scout' | 'spark';

/**
 * Settings for the meeting bot feature (Rebel Notetaker).
 * Supports centralized Recall.ai backend and user-configured providers.
 */
/** When Rebel should join meetings */
export type MeetingJoinMode = 'ask' | 'prompt' | 'auto' | 'never';

export interface MeetingBotSettings {
  /** Whether meeting bot feature is enabled. Default: true */
  enabled?: boolean;
  /** Selected Rebel avatar for bot video tile. Default: 'dash' */
  rebelAvatar?: RebelAvatarId;
  /** User's own Fireflies API key (override centralized Recall) */
  firefliesApiKey?: string;
  /** User's own Fathom API key (override centralized Recall) */
  fathomApiKey?: string;
  /** User's own Recall API key (override centralized account) */
  recallApiKey?: string;
  /** Space ID for 1:1 meeting transcript routing */
  oneOnOneSpaceId?: string;
  /** Space ID for group meeting transcript routing */
  groupMeetingSpaceId?: string;
  /** Space ID for physical (in-person) meeting transcript routing */
  physicalMeetingSpaceId?: string;
  /** 
   * When to join meetings. Default: 'prompt'
   * - 'ask': Show join buttons for all upcoming meetings
   * - 'prompt': Show join buttons when meeting is imminent (≤promptMinutesBefore)
   * - 'auto': Auto-schedule bots for all meetings with video links
   * - 'never': Don't join meetings (disable meeting detection UI)
   */
  joinMode?: MeetingJoinMode;
  /** Minutes before meeting to show join prompt. Default: 5 */
  promptMinutesBefore?: number;
  
  // Local recording settings (fallback when bot fails)
  /** User has acknowledged the local recording consent dialog. Default: false */
  localRecordingConsentAcknowledged?: boolean;
  /** Kill switch: disable local recording feature entirely. Default: false */
  localRecordingDisabled?: boolean;
  /**
   * Opt-in trigger listening during local desktop recordings.
   * When enabled, saying "hey [trigger phrase]" submits a companion turn.
   */
  localRecordingTriggerListening?: boolean;
  
  // Physical recording settings (Limitless Pendant)
  /** Limitless Pendant device settings */
  limitless?: {
    /** Last connected device ID for auto-reconnect */
    lastConnectedDeviceId?: string;
    /** Last connected device name for display */
    lastConnectedDeviceName?: string;
    /** Whether to auto-connect on app startup. Default: true */
    autoConnectEnabled?: boolean;
  };

  // Plaud voice recorder settings
  /** Plaud device settings */
  plaud?: {
    /** Whether Plaud sync is enabled. Default: true when connected */
    enabled?: boolean;
    /** Connected user's email for display */
    userEmail?: string;
    /** Connected user's ID */
    userId?: string;
    /** Auto-sync interval in minutes. Default: 15. Set to 0 to disable auto-sync. */
    autoSyncIntervalMinutes?: number;
  };
  
  /**
   * Custom trigger phrase for Q&A in meetings.
   * When set, this becomes the bot's display name and the phrase people use to get its attention.
   * Examples: "Sparky", "Hey Assistant", "Rebel"
   * Default: null (uses "{firstName}'s Rebel" pattern)
   */
  triggerPhrase?: string | null;
  
  /**
   * Whether Rebel responds via voice (TTS) or chat messages.
   * When true, Rebel speaks answers aloud with avatar animations.
   * When false, Rebel writes answers to the meeting chat.
   * Default: true (voice responses)
   */
  respondViaVoice?: boolean;
  
  /**
   * Proactive coaching interval in minutes for live coach feature.
   * How often the coach analyzes the transcript for coaching opportunities.
   * Default: 2 minutes
   */
  coachProactiveIntervalMinutes?: number;

  /** Whether to track structured conversation state during meetings. Default: true */
  enableConversationState?: boolean;
  /** Whether to enable event-driven coaching triggers. Default: true */
  enableEventDrivenTriggers?: boolean;
  /** Whether to enable quality gate for proactive contributions. Default: true */
  enableQualityGate?: boolean;
  /** Whether to enable LLM cleanup for async transcript upgrades. Default: true */
  enableTranscriptCleanup?: boolean;
  /**
   * Custom instructions for how Rebel should speak in meetings.
   * Appended to the base participant voice instructions.
   * Example: "Be concise and direct. Use a warm, professional tone."
   * Default: undefined (uses Rebel's brand voice)
   */
  meetingVoiceInstructions?: string;
}

/** Default meeting bot settings */
export const DEFAULT_MEETING_BOT_SETTINGS: MeetingBotSettings = {
  enabled: true,
  rebelAvatar: 'spark',
  joinMode: 'never',
  promptMinutesBefore: 5,
  respondViaVoice: true,
};

/**
 * Get the effective working model profile from settings.
 * Checks `models.workingProfileId` first, falls back to `localModel.activeProfileId`.
 * Returns null if no profile is active (use Claude).
 */
function readModelField<K extends keyof ModelSettings>(
  settings: Pick<AppSettings, 'models'>,
  key: K,
): ModelSettings[K] | undefined {
  const models = settings.models;
  if (models && Object.prototype.hasOwnProperty.call(models, key)) {
    return models[key];
  }
  return undefined;
}

export function getWorkingModelProfile(
  settings: Pick<AppSettings, 'models' | 'localModel'>
): ModelProfile | null {
  const profiles = settings.localModel?.profiles;
  if (!profiles?.length) return null;
  // Primary: workingProfileId (set by Thinking/Working role dropdowns)
  const workingId = readModelField(settings, 'workingProfileId');
  if (workingId) {
    const profile = profiles.find(p => p.id === workingId);
    if (profile) return profile;
  }
  // Fallback: activeProfileId (legacy, synced by LocalModelSection)
  const activeId = settings.localModel?.activeProfileId;
  if (activeId) {
    return profiles.find(p => p.id === activeId) ?? null;
  }
  return null;
}

/**
 * Step state for the tutorial checklist widget (post-wizard "Getting Started").
 * Step 0 = onboarding coach conversation ("Meet Rebel"), auto-completed on coach finish.
 * Steps 1-4 = guided tutorial steps. Step 5 (skill creation) was archived before implementation.
 * 
 * UI definitions (labels, icons, intro content) are in:
 * `src/renderer/features/onboarding/config/tutorialChecklistConfig.ts`
 * 
 * @see docs/obsolete/tutorial_checklist_step5_skill_creation.md for step 5 history
 * @see docs/project/ONBOARDING_TUTORIAL_CHECKLIST.md for documentation
 */
export type OnboardingChecklistStep = 0 | 1 | 2 | 3 | 4 | 'complete' | 'dismissed';

/** State for the tutorial checklist shown after wizard completion */
export interface OnboardingChecklist {
  step: OnboardingChecklistStep;
  /** Session IDs per step for navigating back to completed steps */
  sessionIds?: Partial<Record<0 | 1 | 2 | 3 | 4, string>>;
  /** Individual step completion tracking (non-sequential) */
  completedSteps?: Partial<Record<0 | 1 | 2 | 3 | 4, boolean>>;
  /** Whether the checklist widget is expanded. Default: true when no steps completed. */
  isExpanded?: boolean;
}

// =============================================================================
// Cloud Instance Configuration
// =============================================================================

/** Cloud instance configuration for running Rebel on a cloud provider */
export interface CloudInstanceConfig {
  mode: 'local' | 'cloud';
  cloudUrl?: string;
  cloudToken?: string;
  lastSyncedAt?: number;
  lastKnownStatus?: 'running' | 'warm' | 'cold' | 'provisioning' | 'error';
  lastError?: string;
  errorCategory?: CloudErrorCategory;
  degradedSince?: number;
  lastWriter?: ReconcilerWriter;
  /** Cloud provider identifier. Defaults to 'fly' when absent (backward compat). */
  providerId?: 'fly' | 'digitalocean' | 'hetzner' | 'mindstone';
  /** Provider-agnostic metadata (DO: dropletId/volumeId/firewallId/hostname, Hetzner: serverId/volumeId/etc.) */
  providerMetadata?: Record<string, string>;
  /** Fly.io provisioning metadata (set by auto-provisioning, absent for manual connect) */
  flyAppName?: string;
  flyMachineId?: string;
  flyVolumeId?: string;
  /** Cached Fly volume size in GB for fast first paint; source of truth is Fly + cloud-service reads. */
  flyVolumeSizeGb?: number;
  /** Cached inside-VM `/data` used bytes from the last storage poll. */
  lastVolumeUsedBytes?: number;
  /** Cached inside-VM `/data` available bytes from the last storage poll. */
  lastVolumeAvailableBytes?: number;
  /** Unix epoch ms for the last storage usage poll. */
  lastVolumeUsageCheckedAt?: number;
  flyRegion?: string;
  /**
   * Selected VM performance tier ID (e.g. 'standard', 'faster', 'heavy-work').
   * Only applicable for Fly BYOK instances. Source of truth is the machine's
   * actual guest config; this field is a settings cache for fast UI rendering.
   */
  vmTierId?: 'standard' | 'faster' | 'heavy-work';
  provisionedAt?: number;
  provisionMode?: 'byok' | 'managed' | 'manual';
  /**
   * Unix epoch ms when the desktop wrote `FLY_API_TOKEN` as a Fly secret on
   * this app, enabling the cloud-side self-update scheduler. Pre-existing
   * instances provisioned before this secret was added need a one-time repair
   * (handled by the desktop scheduler before its first applyCloudUpdate, and
   * available manually via `cloud:repair-fly-token`). Once set, the desktop
   * skips the repair on subsequent runs.
   */
  flyApiTokenSecretRepairedAt?: number;
  /**
   * Unix epoch ms when the desktop backfilled `SENTRY_DSN` as a Fly secret on
   * this app (OSS-scrub repair: pre-existing instances lost cloud Sentry when
   * the hardcoded DSN was removed). Written by the cloud update scheduler;
   * once set, the backfill is skipped on subsequent cycles.
   */
  sentryDsnSecretRepairedAt?: number;
  /**
   * Set to true at the start of `cloud:migrate` and cleared when the handler
   * exits (success or error). If we see this flag set at startup, a prior
   * migration crashed mid-flight — the desktop calls `cloud:reconcile-migration`
   * so the cloud-service can surface and clean up any partial workspace extract.
   * See planning doc Stage 6.
   */
  migrationInFlight?: boolean;
  /**
   * Last observed cloud pressure state, persisted for UI initial-state hydration.
   * Written only by the cloud connection reconciler (single-writer boundary).
   */
  lastPressureState?: 'ok' | 'warning' | 'critical' | 'unknown';
  /** Unix epoch ms when lastPressureState was last written. */
  lastPressureCheckedAt?: number;
  /**
   * Sliding window of raw pressure observations (last 50 events, max 7 days).
   * Consumed by Stage C's tierSuggestionEngine. Not debounced — raw every-poll.
   * CROSS_SURFACE_PARITY_EXEMPT: pressure tracking is local-derived from health
   * probes; mobile reads /api/health directly.
   */
  recentPressureEvents?: Array<{
    state: 'ok' | 'warning' | 'critical' | 'unknown';
    at: number;
    oom: boolean;
    recentRestart: boolean;
  }>;
}

export type FirstRunActionsPassStatus = 'pending' | 'running' | 'completed' | 'failed';

export type FirstRunActionsSourceResult = {
  source: 'calendar' | 'inbox' | 'connectors' | 'onboarding';
  status: 'not_available' | 'checked' | 'failed';
  itemsCreated?: number;
  error?: string;
};

export type FirstRunActionsPassState = {
  status: FirstRunActionsPassStatus;
  /** Stable activation key, usually the onboarding completion timestamp. */
  activationId: string;
  startedAt?: number;
  completedAt?: number;
  itemsCreated?: number;
  createdItemIds?: string[];
  sourceResults?: FirstRunActionsSourceResult[];
  error?: string;
};

export type AppSettings = {
  coreDirectory: string | null;
  mcpConfigFile: string | null;
  onboardingCompleted: boolean;
  userEmail: string | null;
  /** User's first name from auth/onboarding */
  userFirstName?: string | null;
  /** Unix epoch ms when onboarding was first completed. Set once, never overwritten. */
  onboardingFirstCompletedAt: number | null;
  /** One-shot first Home activation pass that seeds up to three high-confidence Actions. */
  firstRunActionsPass?: FirstRunActionsPassState;
  /** Tutorial checklist state ("Getting Started"). Undefined = not yet shown (pre-onboarding). */
  onboardingChecklist?: OnboardingChecklist;
  /** State tracking for NPS survey scheduling and outcomes. */
  nps?: NpsSurveyState;
  voice: VoiceSettings;
  /** Shared API keys for providers (OpenAI, Google) — entered once, reused across features */
  providerKeys?: ProviderKeys;
  /** User-defined providers (gateways, proxies, self-hosted endpoints) */
  customProviders?: CustomProvider[];
  claude?: ClaudeSettings;
  /** Provider-neutral model namespace (migration target for `claude.*`). */
  models: ModelSettings;
  diagnostics: DiagnosticsSettings;
  /**
   * OSS-build telemetry credentials + master toggle. Top-level (NOT nested
   * under `diagnostics`) so `stripLocalSettings` removes it before cloud sync —
   * that strip is top-level-key-only. Absent/disabled by default. See
   * {@link TelemetrySettings}. LOCAL_ONLY.
   */
  telemetry?: TelemetrySettings;
  /** Google Workspace OAuth configuration for Gmail, Calendar, and Drive access */
  googleWorkspace?: GoogleWorkspaceSettings;
  /** HubSpot OAuth configuration for CRM access */
  hubspot?: HubSpotSettings;
  /** Salesforce OAuth configuration for CRM access */
  salesforce?: SalesforceSettings;
  /** Gamma API configuration for presentation generation */
  gamma?: GammaSettings;
  /** OpenRouter OAuth configuration for multi-model access */
  openRouter?: OpenRouterSettings;
  /**
   * Active LLM provider. Derived from openRouter.enabled on migration.
   * - 'anthropic': Direct API key (default)
   * - 'openrouter': OpenRouter OAuth
   * - 'codex': ChatGPT Pro subscription (OpenAI-only models)
   */
  // CROSS_SURFACE_PARITY_EXEMPT: Intentionally cloud-synced: settings:update dual-writes this provider choice; OpenRouter credentials sync in settings and Codex tokens sync via codex:sync-tokens with cloud DEFAULT_CODEX_AUTH_PROVIDER.
  activeProvider?: ActiveProvider;
  /**
   * Ordered list of providers the user has enabled, highest-priority first.
   * This is the Phase-2 multi-provider list (the planned successor to the single
   * `activeProvider`). It is ADDITIVE and OPTIONAL: when absent or empty, behaviour
   * is unchanged — read it via `getEnabledProviders(settings)`, which degenerates
   * to `[activeProvider]` (today's single current provider).
   *
   * CONSUMED BY ROUTING ONLY when `experimental.multiProviderRoutingEnabled` is on
   * (Stage 3): the router then enumerates this list and picks the highest-priority
   * credential-usable provider. With the flag off — the default for everyone — the
   * router still selects the single provider via `selectProviderMode(settings)` from
   * `activeProvider`, so this field is inert. The `activeProvider`↔list write-sync
   * contract is still deferred: NOTHING writes this field yet (no settings UI until
   * Stage 6, no migration), so the list is empty for all users today and flag-on vs
   * flag-off are identical in production. See
   * docs/plans/260618_multiprovider-foundation/PLAN.md (Stage 2/3).
   */
  // CROSS_SURFACE_PARITY_EXEMPT: Intentionally cloud-synced alongside activeProvider: a denylist (stripLocalSettings) governs sync and this top-level field is not local-only, so it rides settings:update like activeProvider. Inert until a writer exists (Stage 6).
  enabledProviders?: ActiveProvider[];
  /**
   * Set `true` when the user explicitly switches AWAY from the managed
   * 'mindstone' provider, and cleared (`false`) when they switch back to it.
   * The `/api/config` reconcile (`extractManagedProviderInfo` in authService)
   * auto-activates Mindstone whenever `activeProvider !== 'mindstone'`; without
   * this flag that reconcile fires on every config fetch and reverts the user's
   * deliberate switch (the "can't leave Mindstone" bug). The reconcile respects
   * this flag so a first-time activation still works (default unset/false) while
   * an explicit opt-out is preserved. Written by `planProviderSwitch`.
   */
  // CROSS_SURFACE_PARITY_EXEMPT: Cloud-synced alongside activeProvider via the settings:update dual-write (stripLocalSettings does not strip it). The managed-provider reconcile that reads this flag (extractManagedProviderInfo) is desktop-main-only — cloud-service registers no Auth handlers and has no managed-key reconcile — so there is no cloud-side reactivation path to keep in parity.
  managedProviderDeactivated?: boolean;
  /** Experimental features (may be unstable) */
  experimental?: ExperimentalSettings;
  /** Calendar sync settings */
  calendar?: CalendarSettings;
  /**
   * @deprecated Replaced by per-space `organisation_name` frontmatter (since Stage 7 of the
   * 260511_spaces_organisation_grouping plan). Still written by onboarding for backwards
   * compatibility with `sharedDriveService` and used as the fallback when no space has
   * `organisation_name` set. Prefer reading organisations via
   * `resolveOrganisationName(spaceFm, spaceConfig)` or `buildSpaceSummaries`'s
   * `env.organisations`. Do NOT add new readers — they'll silently miss the multi-org case.
   */
  companyName?: string | null;
  /**
   * Rebel spaces configuration.
   * Chief-of-Staff is always present; work spaces are added during onboarding/settings.
   */
  spaces?: SpaceConfig[];
  /**
   * Google Drive symlinks created during onboarding.
   * @deprecated Use spaces instead. Kept for migration compatibility.
   */
  googleDriveLinks?: GoogleDriveLink[];
  /** Whether Google Drive has been confirmed as installed by the user */
  googleDriveInstalled?: boolean;
  /** Personalized use cases generated during onboarding */
  personalizedUseCases?: PersonalizedUseCase[];
  /** Whether automatic memory updates are enabled after each turn. Default: true */
  memoryUpdateEnabled?: boolean;
  /**
   * Memory safety level controls when Rebel asks before updating shared memory.
   * @deprecated Use memorySafetyPrivate + memorySafetyShared instead. Kept for migration.
   */
  memorySafetyLevel?: SafetyLevel;
  /**
   * Memory safety for private spaces (Tier 1 base default).
   * - 'permissive': Save automatically without asking (default for new users)
   * - 'balanced': Check before saving sensitive content
   * - 'cautious': Always ask before saving
   */
  memorySafetyPrivate?: SafetyLevel;
  /**
   * Memory safety for shared spaces (Tier 1 base default).
   * - 'permissive': Save automatically without asking
   * - 'balanced': Check before saving sensitive content (default)
   * - 'cautious': Always ask before saving
   */
  memorySafetyShared?: SafetyLevel;
  /**
   * Per-sharing-level memory safety overrides (Tier 2).
   * Each sharing level can have a custom setting that overrides the Tier 1 base defaults.
   */
  memorySafetyBySharing?: MemorySafetyBySharing;
  /**
   * Per-space memory safety overrides (Tier 3).
   * Space-specific overrides that take precedence over Tier 1 and Tier 2 settings.
   * @deprecated Use spaceSafetyLevels instead. Kept for migration compatibility.
   */
  spaceSafetyOverrides?: SpaceSafetyOverride[];

  /**
   * Per-space memory safety levels (new simplified model).
   * Each space has exactly one safety level stored locally. No tiers, no inheritance.
   * Key is workspace-relative path (POSIX-normalized, e.g., "work/Acme/Exec").
   * Chief-of-Staff is always 'permissive' (hardcoded, not stored here).
   */
  spaceSafetyLevels?: Record<string, SafetyLevel>;

  /**
   * Enable staged writes for memory safety (experimental).
   * When enabled, HIGH sensitivity writes are staged instead of blocked.
   * The agent can continue working while the user reviews at their leisure.
   */
  enableStagedWrites?: boolean;

  /**
   * When true, prepends a `<prior_turns>` header to non-initial turn prompts
   * summarising the prior turns' tool I/O so the model doesn't redo work.
   * Off by default until eval-green; flipped on in a separate commit
   * post-Stage 5. Env override: `REBEL_PRIOR_TURNS_HEADER=1`.
   * See `docs/plans/260525_cross_turn_awareness_layer1_layer2.md`.
   */
  enablePriorTurnsHeader?: boolean;

  /** User's focus for Spaces activity synthesis (e.g., "team dynamics and workflow") */
  spacesActivityFocus?: string;

  /** Timestamp until which the goals header should be hidden (1-week snooze) */
  goalsDismissedUntil?: number;

  /** Whether semantic search indexing is enabled. Default: true (opt-out) */
  indexingEnabled?: boolean;
  /** Whether to use GPU acceleration for embedding generation. Default: true (opt-out) */
  gpuEmbeddingEnabled?: boolean;
  /** @deprecated Use backgroundEnhancement instead. Kept for migration. */
  contextualRetrievalEnabled?: boolean;
  /** Whether background enhancement is enabled (uses API credits). Default: true */
  backgroundEnhancement?: boolean;
  /** Whether user has explicitly requested enhancement (persists across restarts for large workspaces) */
  enhancementUserRequested?: boolean;
  /** Unix epoch ms when user accepted the EULA during onboarding. */
  eulaAcceptedAt?: number | null;
  /** @deprecated Migrated to Safety Prompt. Kept for migration compatibility. */
  toolSafetyLevel?: ToolSafetyLevel;
  /** Whether in-chat durable approvals may save Safety Rules automatically. Default: true. */
  chatIntentRulePersistence?: boolean;
  /**
   * Whether the safety evaluator memoizes confident `allow` decisions per session.
   * When enabled, identical (toolId, normalized args) calls within the same session
   * short-circuit the LLM safety eval for 30 minutes. Default: true.
   * @see docs/plans/260526_safety_eval_context_completeness.md (Stage 1)
   */
  safetyEvalMemoization?: boolean;
  /**
   * Whether the safety evaluator receives recent user-message context from the
   * session as a `<session_intent_data>` fence. When enabled, the eval LLM sees
   * the last few user messages (oldest-first, char-bounded) so it can reason
   * about sustained intent across turns. Default: true.
   * @see docs/plans/260526_safety_eval_context_completeness.md (Stage 2, P0.7)
   */
  safetyEvalSessionIntent?: boolean;
  /**
   * Whether uncertain safety-eval blocks (`decision: block`, non-`high`
   * confidence) run a two-sample higher-temperature confirmation pass before
   * finalizing. Overturns to `allow` only when both confirmations allow.
   * Default: true.
   */
  safetyEvalBlockConsensus?: boolean;
  /**
   * Whether a one-shot LLM classifier inspects the user's most-recent message
   * for an unambiguous imperative or confirmation directed at the imminent
   * tool family and surfaces it to the safety eval as a `<user_intent_explicit>`
   * salience fence. Informational only — never overrides safety rules.
   * Default: true.
   * @see docs/plans/260526_safety_eval_context_completeness.md (Stage 3, P0.5)
   */
  safetyEvalUserIntentFence?: boolean;
  /** @deprecated Migrated to Safety Prompt. Kept for migration compatibility. */
  userSafetyInstructions?: string;
  /** Tools the user has marked as always trusted (skip safety evaluation) */
  trustedTools?: TrustedTool[];
  /** Domains the user has approved for loading scripts/styles in HTML previews (e.g., "https://cdn.jsdelivr.net") */
  trustedPreviewDomains?: string[];
  /** User's preferred color theme. Default: 'dark' */
  theme?: ThemePreference;
  /** Accent color for UI highlights. */
  accentColor?: 'purple' | 'blue' | 'indigo' | 'teal' | 'rose' | 'orange' | 'amber' | 'slate';
  /** Global font scale override. */
  fontScale?: 'small' | 'default' | 'large';
  /** Global UI density override. */
  uiDensity?: 'compact' | 'comfortable' | 'spacious';
  /** Preferred conversation content width. */
  conversationWidth?: 'narrow' | 'medium' | 'wide';
  /** User's preferred inbox layout: 'grid' (card view) or 'list' (table view). Default: 'grid' */
  inboxLayoutMode?: InboxLayoutMode;
  /** Per-category auto-done preference: when ON, CTA execution also marks the item completed */
  autoDoneByCategory?: AutoDoneByCategory;
  /** Global override: always auto-mark done after CTA execution regardless of per-item toggle */
  alwaysAutoMarkDone?: boolean;
  /** Last changelog version the user has seen in What's New widget. Null if never viewed. */
  lastSeenChangelogVersion?: string | null;
  /** 
   * Highlight titles that have been clicked/tried in the What's New widget.
   * Keyed by version to allow clearing when a new version is released.
   */
  dismissedWhatsNewHighlights?: Record<string, string[]>;
  /** Configurable paths for system skills (safety guard, memory update, etc.) */
  systemSkills?: import('../systemSkills').SystemSkillsSettings;
  /** Time saved estimation feature settings */
  timeSavedEstimation?: {
    /** Whether the feature is enabled. Default: true */
    enabled?: boolean;
  };
  /** Streaming text display settings */
  streaming?: {
    /** Whether streaming is enabled. Default: true */
    enabled?: boolean;
  };
  /**
   * Local model settings for using a local LLM instead of Claude.
   * @experimental This feature is experimental and may have limitations with tool calling.
   */
  localModel?: LocalModelSettings;
  /**
   * Per-role model configuration for background tasks.
   * @deprecated Use behindTheScenesModel instead. Will be removed in a future version.
   */
  modelRoles?: {
    /** Model for safety evaluation. Default: claude-haiku-4-5 */
    safety?: string;
    /** Model for memory updates. Default: claude-haiku-4-5 */
    memory?: string;
    /** Model for background tasks (quips, time saved, health). Default: claude-haiku-4-5 */
    auxiliary?: string;
  };
  /**
   * Model for all background tasks: safety checks, memory updates, quips, time estimates,
   * health checks, semantic search support, and scratchpad suggestions.
   * 
   * See MODEL_OPTIONS in modelNormalization.ts for available values,
   * or 'profile:<id>' to route through a specific model profile directly.
   */
  behindTheScenesModel?: string;
  /** Fallback model for background tasks. Encoded as "model:<name>" or "profile:<id>". */
  backgroundFallback?: string;
  /** Cloud fallback for local inference on surfaces where local profiles are unavailable. */
  localInferenceCloudFallback?: string;
  /**
   * Per-task model overrides for background tasks.
   * Keys are BtsTaskGroup ('safety' | 'memory' | 'coaching' | 'meetings').
   * Values are model strings (Claude model or 'profile:<id>').
   * Missing/undefined entries fall through to behindTheScenesModel.
   */
  behindTheScenesOverrides?: Partial<Record<BtsTaskGroup, string>>;
  /**
   * Controls when the Hero Choice LLM call runs to generate homepage recommendations.
   * - 'ask': Show a prompt card; user clicks to generate (default — zero background cost)
   * - 'automatic': Run daily on app startup (original proactive behavior)
   * - 'off': Never generate; no prompt card shown
   */
  heroChoiceRunMode?: 'ask' | 'automatic' | 'off';
  /**
   * Controls the Daily Spark card on Home — a weekly-generated, daily-revealed
   * personal note.
   * - 'on': Reveal a spark every day after gates pass (default)
   * - 'subtle': Reveal only on Mondays
   * - 'off': Never show the card or generate batches
   *
   * Desktop-only: stripped before cloud `settings:update` forwarding via
   * `LOCAL_ONLY_SETTINGS_KEYS` in `src/shared/cloudSettingsPolicy.ts`.
   */
  dailySparkMode?: 'on' | 'subtle' | 'off';
  /** Scratchpad quick-capture settings */
  scratchpad?: ScratchpadSettings;
  /** Meeting bot (Rebel Notetaker) settings */
  meetingBot?: MeetingBotSettings;
  /**
   * Whether the meeting notetaker feature is unlocked (visible) for this user.
   * - `undefined`: never evaluated (triggers one-shot migration in normalizeSettings)
   * - `true`: user has used meeting features or explicitly opted in
   * - `false`: new user, feature hidden until they opt in via System > Experimental
   */
  meetingBotUnlocked?: boolean;
  /**
   * @deprecated Legacy one-shot flag for the pre-260420 Codex stale-Claude repair migration.
   * Prefer codexRepairSchemaVersion for current/future repair migrations.
   */
  codexStaleClaudeRepaired?: boolean;
  /** Schema version for one-shot Codex provider repair migrations. */
  codexRepairSchemaVersion?: number;
  /** Epoch milliseconds when the Codex provider repair last changed settings. */
  codexProviderRepairedAt?: number;
  /** Schema version for one-shot models namespace migration (`claude.* -> models.*`). */
  modelsNamespaceSchemaVersion?: number;
  /**
   * Schema version for the one-shot OpenRouter provider-state heal migration.
   * Repairs the broken shape `activeProvider: 'anthropic'` + no Anthropic credentials
   * + `openRouter.oauthToken` present (caused by the pre-260511 OAuth flow defaulting
   * undefined activeProvider to 'anthropic'). Versioned so the migration runs once.
   */
  openRouterProviderHealVersion?: number;
  /**
   * Schema version for the one-shot **boot** Codex provider-state heal (FOX-3494).
   * Rescues users whose `activeProvider` drifted off `'codex'` to an unusable
   * provider while valid Codex tokens remain. Versioned so the BOOT trigger runs
   * once; the reconnect / cloud-token triggers are NOT version-gated (the event
   * itself is the gate). See docs/plans/260616_chatgpt-reconnect-auth-bug/PLAN.md.
   */
  codexProviderHealVersion?: number;
  /** Schema version for the one-shot OpenRouter legacy profileSource backfill migration. */
  openRouterProfileSourceMigrationVersion?: number;
  /**
   * Schema version for the one-shot BTS auto-profile reroute migration. Rewrites
   * `behindTheScenesModel`, `behindTheScenesOverrides[*]`, `models.workingProfileId`,
   * and `models.thinkingProfileId` from auto-profile ids to qualifying connection-managed
   * sibling ids when (a) such a sibling exists with the same `(providerType, routeSurface,
   * model)` key AND (b) the sibling is enabled, has no `jsonCompatibility: 'incompatible'`
   * flag, and is selectable. Otherwise the references are left untouched. See the 260521
   * BTS Haiku-fallback investigation.
   */
  btsAutoProfileRerouteSchemaVersion?: number;
  /**
   * Set when the models-namespace migration detects malformed legacy settings
   * or an unexpected runtime failure. Used to surface degraded state in UI.
   */
  settingsMigrationDegraded?: {
    reason: string;
    timestamp: number;
  };
  /**
   * Whether the Mindstone Managed cloud provider is visible for this user.
   * - `undefined`: never evaluated (triggers one-shot migration in normalizeSettings)
   * - `true`: user has a @example.com email (or will later have a Stripe subscription)
   * - `false`: not eligible for managed cloud
   */
  managedCloudEnabled?: boolean;
  /**
   * Whether to allow external MCP clients (Cursor, Claude Desktop, etc.) to invoke Rebel.
   * When enabled, external tools can run Rebel commands with auto-approved tool access.
   * Default: false (opt-in)
   * @beta
   */
  mcpServerEnabled?: boolean;
  /**
   * When true, configured AI provider API keys (OpenAI, Google, etc.) are exposed as
   * environment variables (e.g. OPENAI_API_KEY) in agent shell sessions.
   * Only affects shells started by Rebel — does not modify your system environment.
   * Default: false (opt-in)
   */
  exposeProviderKeysInShell?: boolean;
  /**
   * When true, shows direct connector Connect/Setup UI in addition to "Set up with Rebel".
   * When false (default), non-internal connectors show only "Set up with Rebel" button.
   * Default: false (advanced users can opt-in)
   */
  showDirectMcpSetupUi?: boolean;
  /**
   * When true, connector contributions must include Software Engineer workflow
   * completion evidence before promotion to `ready_to_submit` is accepted.
   * Default: false (Stage 3 ships gate wiring default-off; Stage 6 migration
   * plan flips the default on).
   */
  enforceSoftwareEngineerEvidence?: boolean;
  /** Max age in days for session logs before cleanup. Default: 14. Valid range: 7-365. */
  sessionLogRetentionDays?: number;
  /** IDs of announcements the user has permanently dismissed (via "Don't show again") */
  dismissedAnnouncements?: Record<string, boolean>;
  /** Tutorial video watch progress */
  tutorialProgress?: TutorialProgress;
  
  // Phase 0 Onboarding: "The First 10 Minutes"
  /** Current day in the 14-day onboarding journey (1-14). Set after coach completes. */
  onboardingDay?: number;
  /** Unix epoch ms when Phase 0 coach conversation completed */
  onboardingCompletedAt?: number;
  /** Session IDs from the parallel onboarding conversations */
  onboardingSessionIds?: {
    coach: string | null;
    memory: string | null;
    useCases: string | null;
    discovery?: string | null;
  };

  // Phase 1: 14-Day Journey
  /** Unix epoch ms when the 14-day journey started (day 1) */
  onboardingJourneyStartedAt?: number;
  /** Unix epoch ms when the 14-day journey was completed (after day 14) */
  onboardingJourneyCompletedAt?: number;

  /** Tracks which first-time in-conversation tooltips have been shown. Once a key
   *  is set to `true`, the corresponding tooltip never appears again. */
  firstTimeTooltips?: Record<string, boolean>;

  /** Absolute paths of files pinned/favorited in the Library. */
  favoriteFilePaths?: string[];

  /** Cloud instance configuration for running Rebel on a Fly Machine */
  cloudInstance?: CloudInstanceConfig;

  /** Cloud update channel. 'stable' uses prod-* tags (from main), 'beta' uses dev-* tags (from dev). Default: 'stable' */
  cloudUpdateChannel?: 'stable' | 'beta';

  /** Normalized sourcePaths of shared drive spaces the user has manually removed.
   *  Prevents auto-reconciliation from re-creating them. */
  dismissedSharedDriveSpaces?: string[];

  /**
   * Plugin IDs already considered for first-launch seeding from `rebel-system/plugins/`.
   * Once an ID is in this array, the seed step on next launch skips it (so user deletions are respected).
   * Optional for back-compat — missing means 'no plugins considered yet'; default behaviour for code reading the field is `[]`.
   */
  seededBundledPluginIds?: string[];

  /** Space paths the user has dismissed from Focus goals view (per-user, local only).
   *  @see docs/plans/260407_focus_goals_redesign.md */
  dismissedFocusGoalSpaces?: string[];

  /** Provider IDs for which the user has dismissed shared drive health warnings.
   *  Prevents recurring toasts for users who deliberately don't run drive apps. */
  dismissedDriveHealthWarnings?: string[];

  /**
   * When true, prevents the system from sleeping while Rebel is running an agent turn.
   * Uses Electron's powerSaveBlocker with 'prevent-app-suspension' mode.
   * Default: false (opt-in)
   */
  preventSleepDuringTurns?: boolean;

  /**
   * Efficiency Mode (cosmetic / delight scope).
   *
   * When 'on', a single coordinated preset writes through to several sub-settings
   * (Daily Spark, Hero Choice, time-saved estimation, persona quips, CPU embedding
   * idle disposal) to reduce decorative GPU/CPU work and proactive-nudge LLM spend.
   * The user's pre-Efficiency values are snapshotted into `efficiencyModeBaseline`
   * so they can be restored when the mode is turned off.
   *
   * Local-only — never synced to cloud. Underlying sub-settings continue to sync
   * (so the user's cloud Rebel becomes equally quiet).
   *
   * See `docs/plans/260524_performance_mode.md`. Helper: `applyEfficiencyMode` in
   * `src/shared/utils/efficiencyMode.ts`.
   */
  efficiencyMode?: 'on' | 'off';

  /**
   * Snapshot of the user's pre-Efficiency-Mode values for the sub-settings that
   * Efficiency Mode writes through to. Present iff `efficiencyMode === 'on'`.
   *
   * Semantics: a missing key in the baseline means "user originally had this
   * setting as undefined; restore to undefined when Efficiency Mode is disabled".
   */
  efficiencyModeBaseline?: {
    dailySparkMode?: 'on' | 'subtle' | 'off';
    heroChoiceRunMode?: 'ask' | 'automatic' | 'off';
    timeSavedEstimationEnabled?: boolean;
    personaQuipsEnabled?: boolean;
    cpuEmbeddingIdleDisposalEnabled?: boolean;
  };

  /**
   * When false, the dynamic LLM-generated persona quip flavour text shown during
   * long-running turns is suppressed (a static rotation is used instead). This is
   * pure delight; turn behaviour is unchanged.
   *
   * Default: undefined ≡ true (quips on).
   */
  personaQuipsEnabled?: boolean;

  /**
   * When true, the CPU embedding worker is disposed after 5 minutes of idle to
   * reclaim ~350-400 MB of resident memory; it re-initialises on the next
   * embed request. Independent of GPU embeddings.
   *
   * The legacy env var `REBEL_CPU_IDLE_DISPOSAL=1` continues to win as an override.
   *
   * Default: undefined ≡ env-var value (transitional). Long-term default is
   * driven by Efficiency Mode (true when on).
   */
  cpuEmbeddingIdleDisposalEnabled?: boolean;

  /** Desktop notification preferences. Master toggle defaults to off; sub-toggles default to on once master is enabled. */
  notifications?: {
    /** Master toggle — must be explicitly true to send desktop notifications. Default: false (off) */
    enabled?: boolean;
    automationComplete?: boolean;
    conversationComplete?: boolean;
    roleComplete?: boolean;
  };

  /**
   * In-app survey state, keyed by survey ID (e.g., 'actions-feedback-v1').
   * Each survey's dismiss/completion/snooze state is tracked independently.
   * See docs/plans/260402_in_app_survey_system.md for design rationale.
   */
  surveys?: Record<string, import('./survey').SurveyState>;

  /** Unix epoch ms when the user first visited the Actions tab. Set once, never overwritten. */
  actionsFirstVisitedAt?: number | null;
}

/** Tutorial video watch progress tracking */
export interface TutorialProgress {
  /** IDs of videos the user has watched to completion */
  watchedVideos: string[];
  /** Unix epoch ms when user last watched a video */
  lastWatchedAt?: number;
}
