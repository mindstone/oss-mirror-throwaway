import { z } from 'zod';
import { GoogleDriveLinkSchema, SpaceConfigSchema } from './library';
import { ThinkingEffortSchema } from './common';
import { InboundAuthorPolicySchema } from '@rebel/shared';
import type {
  ActiveProvider,
  AppSettings as ManualAppSettings,
  ModelSettings as ManualModelSettings,
  ClaudeSettings as ManualClaudeSettings,
  MeetingBotSettings as ManualMeetingBotSettings,
} from '@shared/types/settings';

/** Meeting join mode schema */
export const MeetingJoinModeSchema = z.enum(['ask', 'prompt', 'auto', 'never']);

/** Rebel avatar ID schema - must match RebelAvatarId in types.ts */
export const RebelAvatarIdSchema = z.enum(['dash', 'glitch', 'rogue', 'scout', 'spark']);

/** Meeting bot settings schema */
const _MeetingBotSettingsSchemaInternal = z.object({
  enabled: z.boolean().optional(),
  rebelAvatar: RebelAvatarIdSchema.optional(),
  firefliesApiKey: z.string().optional(),
  fathomApiKey: z.string().optional(),
  recallApiKey: z.string().optional(),
  oneOnOneSpaceId: z.string().optional(),
  groupMeetingSpaceId: z.string().optional(),
  joinMode: MeetingJoinModeSchema.optional(),
  promptMinutesBefore: z.number().optional(),
  localRecordingConsentAcknowledged: z.boolean().optional(),
  localRecordingDisabled: z.boolean().optional(),
  localRecordingTriggerListening: z.boolean().optional(),
  plaud: z
    .object({
      enabled: z.boolean().optional(),
      userEmail: z.string().optional(),
      userId: z.string().optional(),
      autoSyncIntervalMinutes: z.number().optional(),
    })
    .optional(),
});
/**
 * IMPORTANT: This schema is primarily used to define runtime validation shape.
 * IPC typing should come from the shared manual settings interfaces.
 */
export const MeetingBotSettingsSchema = _MeetingBotSettingsSchemaInternal as unknown as z.ZodType<ManualMeetingBotSettings>;

/** Voice profile schema - saved custom OpenAI-compatible STT/TTS profile */
export const VoiceProfileSchema = z.object({
  id: z.string(),
  name: z.string(),
  sttBaseUrl: z.string(),
  sttModel: z.string(),
  ttsBaseUrl: z.string().optional(),
  ttsModel: z.string().optional(),
  ttsVoice: z.string().optional(),
  apiKey: z.string().optional(),
  createdAt: z.number(),
});
export type VoiceProfile = z.infer<typeof VoiceProfileSchema>;

/** Voice settings schema */
export const VoiceSettingsSchema = z.object({
  provider: z.enum(['openai-whisper', 'elevenlabs-scribe', 'local-parakeet', 'local-moonshine', 'custom-openai']),
  openaiApiKey: z.string().nullable(),
  elevenlabsApiKey: z.string().nullable(),
  model: z.string(),
  ttsVoice: z.string().nullable(),
  activationHotkey: z.string().nullable(),
  activationHotkeyVoiceMode: z.boolean(),
  inlineVoiceHotkey: z.string().nullable().optional(),
  autoSpeak: z.boolean().optional(),
  transcriptionVocabulary: z.array(z.string()).optional(),
  voiceInputLanguage: z.string().optional(),
  customProfiles: z.array(VoiceProfileSchema).optional(),
  activeCustomProfileId: z.string().nullable().optional(),
});

/** Claude settings schema */
const _ModelSettingsSchemaInternal = z.object({
  apiKey: z.string().nullable(),
  model: z.string(),
  permissionMode: z.enum(['bypassPermissions', 'plan']),
  executablePath: z.string().nullable(),
  planMode: z.boolean(),
  thinkingModel: z.string().optional(),
  thinkingProfileId: z.string().optional(),
  workingProfileId: z.string().optional(),
  thinkingFallback: z.string().optional(),
  workingFallback: z.string().optional(),
  extendedContext: z.boolean(),
  learnedContextWindowEnabled: z.boolean().optional(),
  longContextFallbackModel: z.string().min(1).optional(),
  longContextFallbackProfileId: z.string().min(1).optional(),
  thinkingEffort: ThinkingEffortSchema,
  // F2 (260604 cutover follow-up): complete the schema over every ModelSettings field so a
  // future settings `.parse()` through it can't silently STRIP a field (now that `models` is the
  // canonical namespace). Inert today — nothing currently parses settings through this schema —
  // but the exhaustiveness guard below makes the schema-vs-type drift impossible by construction.
  // authMethod/oauthToken kept `.optional()` (looser than the in-memory type's required-ness):
  // the runtime schema must tolerate real/old persisted blobs that omit them rather than reject —
  // the goal here is to PRESERVE (not strip) these fields when present, not to enforce presence.
  authMethod: z.enum(['api-key', 'oauth-token']).optional(),
  oauthToken: z.string().nullable().optional(),
  oauthRefreshToken: z.string().nullable().optional(),
  oauthTokenExpiresAt: z.number().nullable().optional(),
  modelEfforts: z.record(z.string(), ThinkingEffortSchema).optional(),
  oauthProfile: z.object({
    displayName: z.string().optional(),
    email: z.string().optional(),
    tier: z.string().optional(),
  }).optional(),
  oauthMigratedAt: z.string().optional(),
  usageData: z.object({
    fiveHour: z.object({ utilization: z.number(), resetsAt: z.string() }),
    sevenDay: z.object({ utilization: z.number(), resetsAt: z.string() }),
    sevenDaySonnet: z.object({ utilization: z.number(), resetsAt: z.string() }),
    extraUsage: z.object({
      isEnabled: z.boolean(),
      monthlyLimit: z.number(),
      usedCredits: z.number(),
      utilization: z.number(),
    }).optional(),
    fetchedAt: z.number(),
  }).optional(),
});

// Compile-time exhaustiveness guard (F2). `satisfies`-style proof that the Zod schema's shape
// covers every `ModelSettings` (=`ManualModelSettings`) key. If a new ModelSettings field is added
// without adding it here, this line fails to compile naming the missing key(s) — so the runtime
// settings schema can never silently fall out of sync with the canonical type.
type ModelSettingsSchemaCoverageGap = Exclude<keyof ManualModelSettings, keyof typeof _ModelSettingsSchemaInternal.shape>;
const modelSettingsSchemaCoverageCheck: ModelSettingsSchemaCoverageGap extends never ? true : ModelSettingsSchemaCoverageGap = true;
void modelSettingsSchemaCoverageCheck;

/**
 * IMPORTANT: This schema is primarily used to define runtime validation shape.
 * IPC typing should come from the shared manual settings interfaces.
 */
export const ModelSettingsSchema = _ModelSettingsSchemaInternal as unknown as z.ZodType<ManualModelSettings>;
/** @deprecated Use ModelSettingsSchema. */
export const ClaudeSettingsSchema = _ModelSettingsSchemaInternal as unknown as z.ZodType<ManualClaudeSettings>;

/** Diagnostics settings schema */
export const DiagnosticsSettingsSchema = z.object({
  debugBreadcrumbsUntil: z.number().nullable(),
  forceDirectMcp: z.boolean().optional().default(false),
  developerMode: z.boolean().optional().default(false),
});

/**
 * OSS-build telemetry creds + master toggle. Top-level on AppSettings (so
 * `stripLocalSettings` removes it before cloud sync). LOCAL_ONLY. See
 * {@link TelemetrySettings} in @shared/types/settings.
 */
export const TelemetrySettingsSchema = z.object({
  enabled: z.boolean(),
  sentryDsn: z.string().optional(),
  rudderWriteKey: z.string().optional(),
  rudderDataPlaneUrl: z.string().optional(),
});

/** NPS survey state schema */
export const NpsSurveyStateSchema = z.object({
  firstEligibleAt: z.number().nullable(),
  lastShownAt: z.number().nullable(),
  lastDismissedAt: z.number().nullable(),
  lastCompletedAt: z.number().nullable(),
  lastScore: z.number().nullable(),
  lastFeedback: z.string().nullable(),
  snoozeUntil: z.number().nullable(),
  showCount: z.number(),
  completedCount: z.number(),
  neverShowAgain: z.boolean(),
});

/** Personalized use case schema */
export const PersonalizedUseCaseSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  prompt: z.string(),
  icon: z.string().optional(),
  generatedAt: z.number(),
});
export type PersonalizedUseCase = z.infer<typeof PersonalizedUseCaseSchema>;

/** Tool safety level schema */
export const ToolSafetyLevelSchema = z.enum(['permissive', 'balanced', 'cautious']);

/** Trusted tool schema - tools the user has marked as always trusted */
export const TrustedToolSchema = z.object({
  toolId: z.string(),
  displayName: z.string().optional(),
  serverHint: z.string().optional(),
  addedAt: z.number(),
});

export const FirstRunActionsPassSchema = z.object({
  status: z.enum(['pending', 'running', 'completed', 'failed']),
  activationId: z.string(),
  startedAt: z.number().optional(),
  completedAt: z.number().optional(),
  itemsCreated: z.number().int().nonnegative().optional(),
  createdItemIds: z.array(z.string()).optional(),
  sourceResults: z.array(z.object({
    source: z.enum(['calendar', 'inbox', 'connectors', 'onboarding']),
    status: z.enum(['not_available', 'checked', 'failed']),
    itemsCreated: z.number().int().nonnegative().optional(),
    error: z.string().optional(),
  })).optional(),
  error: z.string().optional(),
}).optional();

/** Custom provider schema - user-defined provider (gateway, proxy, etc.) */
export const CustomProviderSchema = z.object({
  id: z.string(),
  name: z.string(),
  serverUrl: z.string(),
  apiKey: z.string().optional(),
  createdAt: z.number(),
});

/** Model profile schema - a saved configuration for a model provider */
export const ModelProfileSchema = z.object({
  id: z.string(),
  name: z.string(),
  authSource: z.literal('codex-subscription').optional(),
  routeSurface: z.enum(['subscription', 'api-key', 'pool', 'local']).optional(),
  presetKey: z.string().optional(),
  providerType: z.enum(['anthropic', 'openai', 'google', 'together', 'cerebras', 'openrouter', 'other', 'local']).optional(),
  serverUrl: z.string(),
  model: z.string().optional(),
  apiKey: z.string().optional(),
  contextWindow: z.number().optional(),
  contextWindowSource: z.enum(['user', 'auto']).optional(),
  contextWindowOverflowCount: z.number().optional(),
  contextWindowLearnedAt: z.number().optional(),
  lastLearnedContextWindow: z.number().optional(),
  maxOutputTokens: z.number().optional(),
  outputTokensSource: z.enum(['user', 'auto']).optional(),
  outputTokensOverflowCount: z.number().optional(),
  outputTokensLearnedAt: z.number().optional(),
  lastLearnedOutputTokens: z.number().optional(),
  costTier: z.enum(['economy', 'mid-tier', 'premium']).optional(),
  createdAt: z.number(),
  customProviderId: z.string().optional(),
  councilEnabled: z.boolean().optional(),
  routingEligible: z.boolean().optional(),
  enabled: z.boolean().optional(),
  reasoningEffort: ThinkingEffortSchema.optional(),
  // `reasoningDisabled` (manual "Off" thinking) was removed 2026-06-18 — suppression is
  // now driven solely by `thinkingCompatibility`. Schema is `.passthrough()`, so any
  // legacy `reasoningDisabled` on stored/synced profiles survives until `normalizeSettings`
  // migrates it to `thinkingCompatibility:'incompatible'`. See CUSTOM_GATEWAY_COMPATIBILITY.md.
  companyManaged: z.boolean().optional(),
  chatCompatibility: z.enum(['unknown', 'compatible', 'incompatible']).optional(),
  chatCompatibilityCheckedAt: z.string().optional(),
  jsonCompatibility: z.enum(['unknown', 'compatible', 'incompatible']).optional(),
  jsonCompatibilityCheckedAt: z.string().optional(),
  thinkingCompatibility: z.enum(['unknown', 'compatible', 'incompatible']).optional(),
  thinkingCompatibilityCheckedAt: z.string().optional(),
  toolUseCompatibility: z.enum(['unknown', 'compatible', 'incompatible']).optional(),
  toolUseCompatibilityCheckedAt: z.string().optional(),
  modelNotes: z.string().optional(),
  strengths: z.string().optional(), // Deprecated, migrate to modelNotes
  weaknesses: z.string().optional(), // Deprecated, migrate to modelNotes
  // user = wizard add-custom path; connection = catalog/subscription materialisation; auto = system-managed profiles like Codex.
  profileSource: z.enum(['user', 'connection', 'auto']).optional(),
}).passthrough();
export type ModelProfile = z.infer<typeof ModelProfileSchema>;

/** Local model settings schema - supports multiple profiles */
export const LocalModelSettingsSchema = z.object({
  profiles: z.array(ModelProfileSchema),
  activeProfileId: z.string().nullable(),
  learnedLimitsMigratedAt: z.number().optional(),
  registryStampMigratedAt: z.number().optional(),
  learnedContextWindowPoisonResetAt: z.number().optional(),
});
export type LocalModelSettings = z.infer<typeof LocalModelSettingsSchema>;

/**
 * Per-special-task model overrides (safety / memory / auxiliary) — a legacy,
 * special-purpose namespace, NOT the user-facing Working/Thinking/Background
 * role tiers (those are `ModelRoleTier` in shared/types/agent.ts). Renamed from
 * `ModelRoles`/`ModelRolesSchema` to kill that name collision; the persisted
 * field stays `modelRoles` (see below) for back-compat — zero migration.
 */
export const SpecialTaskModelOverridesSchema = z.object({
  safety: z.string().optional(),
  memory: z.string().optional(),
  auxiliary: z.string().optional(),
});
export type SpecialTaskModelOverrides = z.infer<typeof SpecialTaskModelOverridesSchema>;

/** Space safety override schema - per-space memory safety configuration (Tier 3) */
export const SpaceSafetyOverrideSchema = z.object({
  spacePath: z.string(),
  spaceName: z.string(),
  level: ToolSafetyLevelSchema,
  addedAt: z.number(),
  migratedFrom: z.literal('memoryTrust').optional(),
});
export type SpaceSafetyOverride = z.infer<typeof SpaceSafetyOverrideSchema>;

/** Per-sharing-level memory safety configuration (Tier 2) */
export const MemorySafetyBySharingSchema = z.object({
  restricted: ToolSafetyLevelSchema.optional(),
  'company-wide': ToolSafetyLevelSchema.optional(),
  public: ToolSafetyLevelSchema.optional(),
});
export type MemorySafetyBySharing = z.infer<typeof MemorySafetyBySharingSchema>;

/** Experimental settings schema - must match ExperimentalSettings in types/settings.ts */
export const ExperimentalSettingsSchema = z.object({
  unifiedConnectionsPanel: z.boolean().optional(),
  routerEnabled: z.boolean().optional(),
  mcpAppsEnabled: z.boolean().optional(),
  unifiedApproval: z.boolean().optional(),
  onboardingRevealTourEnabled: z.boolean().optional(),
  localInferenceEnabled: z.boolean().optional(),
  adaptiveRoutingEnabled: z.boolean().optional(),
  multiProviderRoutingEnabled: z.boolean().optional(),
  // Admit healthy cloud-symlinked spaces to walk/watch/index (260619 Stage 6b/7).
  // Default OFF; desktop-only / local-only (see cloudSettingsPolicy).
  cloudSymlinkIndexing: z.boolean().optional(),
  focusEnabled: z.boolean().optional(),
  compactEnabled: z.boolean().optional(),
  slackCloudWebhookEnabled: z.boolean().optional(),
  slackInboundThreadHistory: z.boolean().optional().default(true),
  slackDesktopThreadContinuity: z.boolean().optional().default(true),
  agentInstanceId: z.string().optional(),
  inboundAuthorPolicy: InboundAuthorPolicySchema.optional(),
  inboundAuthorPolicyBackup: z.unknown().optional(),
  inboundAuthorPolicyBypassActive: z.boolean().optional(),
  cloudSlackWorkspace: z.object({
    teamId: z.string(),
    teamName: z.string(),
    status: z.enum(['connected', 'needs_reconnect', 'disconnecting', 'disconnected']),
    peerInstanceCount: z.number().int().nonnegative().optional(),
    occurredAt: z.number().optional(),
    lastSeenAt: z.number().optional(),
    lastError: z.object({
      code: z.string(),
      message: z.string(),
      occurredAt: z.number(),
    }).optional(),
  }).optional(),
}).optional();

/** Shared provider API keys schema */
export const ProviderKeysSchema = z.object({
  openai: z.string().nullable().optional(),
  google: z.string().nullable().optional(),
  together: z.string().nullable().optional(),
  cerebras: z.string().nullable().optional(),
}).optional();

/**
 * Active LLM provider enum — mirrors the `ActiveProvider` union in
 * @shared/types/settings. The `satisfies` proof below keeps this Zod enum locked
 * to that type so a new provider can't be added to the union without updating it.
 */
export const ActiveProviderSchema = z.enum(['anthropic', 'openrouter', 'codex', 'mindstone']);
// Compile-time proof that the enum members exactly equal the ActiveProvider union.
// If the union and the enum drift apart in either direction, this fails to compile.
type ActiveProviderEnumCoverage = ActiveProvider extends z.infer<typeof ActiveProviderSchema>
  ? z.infer<typeof ActiveProviderSchema> extends ActiveProvider
    ? true
    : never
  : never;
const activeProviderEnumCoverageCheck: ActiveProviderEnumCoverage = true;
void activeProviderEnumCoverageCheck;

/** Application settings schema */
const _AppSettingsSchemaInternal = z.object({
  coreDirectory: z.string().nullable(),
  mcpConfigFile: z.string().nullable(),
  onboardingCompleted: z.boolean(),
  userEmail: z.string().nullable(),
  userFirstName: z.string().nullable().optional(),
  onboardingFirstCompletedAt: z.number().nullable(),
  firstRunActionsPass: FirstRunActionsPassSchema,
  nps: NpsSurveyStateSchema.optional(),
  voice: VoiceSettingsSchema,
  providerKeys: ProviderKeysSchema,
  customProviders: z.array(CustomProviderSchema).optional(),
  claude: ClaudeSettingsSchema.optional(),
  models: ModelSettingsSchema,
  modelsNamespaceSchemaVersion: z.number().optional(),
  settingsMigrationDegraded: z.object({
    reason: z.string(),
    timestamp: z.number(),
  }).optional(),
  diagnostics: DiagnosticsSettingsSchema,
  telemetry: TelemetrySettingsSchema.optional(),
  companyName: z.string().nullable().optional(),
  spaces: z.array(SpaceConfigSchema).optional(),
  googleDriveLinks: z.array(GoogleDriveLinkSchema).optional(),
  googleDriveInstalled: z.boolean().optional(),
  personalizedUseCases: z.array(PersonalizedUseCaseSchema).optional(),
  theme: z.enum(['light', 'dark', 'system']).optional(),
  accentColor: z.enum(['purple', 'blue', 'indigo', 'teal', 'rose', 'orange', 'amber', 'slate']).optional(),
  fontScale: z.enum(['small', 'default', 'large']).optional(),
  uiDensity: z.enum(['compact', 'comfortable', 'spacious']).optional(),
  conversationWidth: z.enum(['narrow', 'medium', 'wide']).optional(),
  toolSafetyLevel: ToolSafetyLevelSchema.optional(),
  /** @deprecated Use memorySafetyPrivate + memorySafetyShared instead */
  memorySafetyLevel: ToolSafetyLevelSchema.optional(),
  /** Memory safety for private spaces (Tier 1). Default: 'permissive' for new users */
  memorySafetyPrivate: ToolSafetyLevelSchema.optional(),
  /** Memory safety for shared spaces (Tier 1). Default: 'balanced' */
  memorySafetyShared: ToolSafetyLevelSchema.optional(),
  /** Per-sharing-level overrides (Tier 2) */
  memorySafetyBySharing: MemorySafetyBySharingSchema.optional(),
  /** Per-space overrides (Tier 3) - DEPRECATED, use spaceSafetyLevels instead */
  spaceSafetyOverrides: z.array(SpaceSafetyOverrideSchema).optional(),
  /** Simplified per-space memory safety levels (replaces 3-tier system) */
  spaceSafetyLevels: z.record(z.string(), ToolSafetyLevelSchema).optional(),
  /**
   * Stage 2 of docs/plans/260525_cross_turn_awareness_layer1_layer2.md —
   * when true, the agent turn pipeline injects a `<prior_turns>` header so
   * follow-up turns know what prior turns already did. Default false until
   * eval-green; flipped on in a separate post-Stage-5 commit.
   */
  enablePriorTurnsHeader: z.boolean().optional(),
  userSafetyInstructions: z.string().optional(),
  trustedTools: z.array(TrustedToolSchema).optional(),
  trustedPreviewDomains: z.array(z.string()).optional(),
  localModel: LocalModelSettingsSchema.optional(),
  modelRoles: SpecialTaskModelOverridesSchema.optional(), // persisted key unchanged (back-compat); type renamed from ModelRoles
  behindTheScenesModel: z.string().optional(),
  // Opt-out marker so the managed-provider reconcile doesn't re-activate
  // Mindstone after the user deliberately switches away. See AppSettings type.
  managedProviderDeactivated: z.boolean().optional(),
  // Phase-2 multi-provider list (ordered, highest-priority first). ADDITIVE +
  // optional: absent ⇒ today's single-active behaviour. Consumed by routing ONLY
  // when experimental.multiProviderRoutingEnabled is on (Stage 3). The Stage 6
  // settings UI (BackupConnectionsSection) writes this via `writeProviderList()` for
  // flag-enabled users. Read via `getEnabledProviders(settings)`.
  // See AppSettings.enabledProviders and
  // docs/plans/260618_multiprovider-foundation/PLAN.md (Stage 2/3/6).
  enabledProviders: z.array(ActiveProviderSchema).optional(),
  backgroundFallback: z.string().optional(),
  localInferenceCloudFallback: z.string().optional(),
  behindTheScenesOverrides: z.record(
    z.enum(['safety', 'memory', 'coaching', 'meetings', 'improvement', 'hero-choice', 'search', 'foraging']),
    z.string()
  ).optional(),
  heroChoiceRunMode: z.enum(['ask', 'automatic', 'off']).optional(),
  dailySparkMode: z.enum(['on', 'subtle', 'off']).optional(),
  /** Efficiency Mode master toggle — see docs/plans/260524_performance_mode.md */
  efficiencyMode: z.enum(['on', 'off']).optional(),
  /** Pre-Efficiency-Mode snapshot for restore on disable */
  efficiencyModeBaseline: z
    .object({
      dailySparkMode: z.enum(['on', 'subtle', 'off']).optional(),
      heroChoiceRunMode: z.enum(['ask', 'automatic', 'off']).optional(),
      timeSavedEstimationEnabled: z.boolean().optional(),
      personaQuipsEnabled: z.boolean().optional(),
      cpuEmbeddingIdleDisposalEnabled: z.boolean().optional(),
    })
    .optional(),
  /** Whether dynamic LLM-generated persona quips run during long turns. Default true. */
  personaQuipsEnabled: z.boolean().optional(),
  /** Whether the CPU embedding worker is disposed after idle to reclaim RAM. */
  cpuEmbeddingIdleDisposalEnabled: z.boolean().optional(),
  memoryUpdateEnabled: z.boolean().optional(),
  spacesActivityFocus: z.string().optional(),
  /** Timestamp until which the goals header should be hidden (1-week snooze) */
  goalsDismissedUntil: z.number().optional(),
  indexingEnabled: z.boolean().optional(),
  gpuEmbeddingEnabled: z.boolean().optional(),
  exposeProviderKeysInShell: z.boolean().optional(),
  showDirectMcpSetupUi: z.boolean().optional(),
  enforceSoftwareEngineerEvidence: z.boolean().optional(),
  chatIntentRulePersistence: z.boolean().optional(),
  safetyEvalMemoization: z.boolean().optional(),
  safetyEvalSessionIntent: z.boolean().optional(),
  safetyEvalBlockConsensus: z.boolean().optional(),
  safetyEvalUserIntentFence: z.boolean().optional(),
  experimental: ExperimentalSettingsSchema,
  cloudUpdateChannel: z.enum(['stable', 'beta']).optional(),
  meetingBot: MeetingBotSettingsSchema.optional(),
  /** Whether the meeting notetaker feature is unlocked for this user */
  meetingBotUnlocked: z.boolean().optional(),
  /** One-shot bootstrap flag for the pre-260420 Codex stale-Claude repair migration */
  codexStaleClaudeRepaired: z.boolean().optional(),
  /** Schema version for one-shot Codex provider repair migrations */
  codexRepairSchemaVersion: z.number().optional(),
  /** Epoch milliseconds when the Codex provider repair last changed settings */
  codexProviderRepairedAt: z.number().optional(),
  /** Schema version for one-shot OpenRouter active-provider heal migration */
  openRouterProviderHealVersion: z.number().optional(),
  /** Schema version for the one-shot Codex active-provider boot heal (FOX-3494) */
  codexProviderHealVersion: z.number().optional(),
  /** Schema version for one-shot OpenRouter legacy profileSource backfill migration */
  openRouterProfileSourceMigrationVersion: z.number().int().min(0).optional(),
  /** Schema version for one-shot BTS auto-profile reroute migration */
  btsAutoProfileRerouteSchemaVersion: z.number().int().min(0).optional(),
  /** Whether the Mindstone Managed cloud provider is visible for this user */
  managedCloudEnabled: z.boolean().optional(),
  /** IDs of announcements the user has permanently dismissed (via "Don't show again") */
  dismissedAnnouncements: z.record(z.string(), z.boolean()).optional(),
  /** Normalized sourcePaths of shared drive spaces the user has manually removed */
  dismissedSharedDriveSpaces: z.array(z.string()).optional(),
  /** Bundled plugin IDs already considered for first-launch seeding */
  seededBundledPluginIds: z.array(z.string()).optional(),
  /** Space paths the user has dismissed from Focus goals view */
  dismissedFocusGoalSpaces: z.array(z.string()).optional(),
  /** Absolute paths of files pinned/favorited in the Library */
  favoriteFilePaths: z.array(z.string()).optional(),
  /** Per-category auto-done preference for inbox CTA execution */
  autoDoneByCategory: z.record(z.string(), z.boolean()).optional(),
  /** Desktop notification preferences */
  notifications: z.object({
    enabled: z.boolean().optional(),
    automationComplete: z.boolean().optional(),
    conversationComplete: z.boolean().optional(),
    roleComplete: z.boolean().optional(),
  }).optional(),
  /** In-app survey state keyed by survey ID */
  surveys: z.record(z.string(), z.object({
    showCount: z.number(),
    dismissCount: z.number(),
    completed: z.boolean(),
    snoozeUntil: z.number().nullable(),
    lastShownAt: z.number().nullable(),
    completedAt: z.number().nullable(),
  })).optional(),
  actionsFirstVisitedAt: z.number().nullable().optional(),
});
/**
 * NOTE:
 * - `src/shared/types/settings.ts` is the source of truth for AppSettings typing.
 * - This Zod schema intentionally validates a runtime subset and may lag behind optional fields.
 * - The cast exists for IPC bridge type inference only; runtime validation behavior is unchanged.
 */
export const AppSettingsSchema = _AppSettingsSchemaInternal as unknown as z.ZodType<ManualAppSettings>;

/**
 * Top-level-PARTIAL variant of {@link AppSettingsSchema}, for the `settings:update`
 * IPC REQUEST. The desktop handler shallow-merges the incoming payload over the
 * current persisted settings (`{ ...previous, ...incoming }`), so callers may send
 * either a full settings document OR a bare partial (e.g. `{ cloudInstance }` from
 * the cloud-provisioning flow). The full-schema request was a lie: it `.parse()`-
 * rejected legitimate bare partials at the dev/test contract-parse seam.
 *
 * `.partial()` is built on the underlying `z.ZodObject` (`_AppSettingsSchemaInternal`)
 * — NOT on the `z.ZodType<ManualAppSettings>` cast above, which lacks `.partial()`.
 * It is SHALLOW: only top-level keys become optional, which matches the handler's
 * shallow top-level merge (nested objects like `voice`/`models`/`cloudInstance` are
 * still sent whole). It strictly WIDENS what validates — every full document that
 * passed `AppSettingsSchema` still passes here; bare partials now also pass.
 *
 * The RESPONSE stays full `AppSettingsSchema` (the handler always returns the
 * complete merged+normalized settings).
 * See docs/plans/260622_mobile-setup-investigation.
 */
export const AppSettingsPartialSchema =
  _AppSettingsSchemaInternal.partial() as unknown as z.ZodType<Partial<ManualAppSettings>>;

export type { AppSettings, ModelSettings, ClaudeSettings, MeetingBotSettings } from '@shared/types/settings';

/**
 * API key validation request/response schemas
 */
export const ApiKeyValidationRequestSchema = z.object({
  apiKey: z.string().min(1, 'API key is required'),
  organizationId: z.string().min(1).optional().nullable(),
  modelId: z.string().min(1).optional().nullable(),
  /** When true, makes a minimal API call to verify credits are available (costs ~$0.000004) */
  deepValidate: z.boolean().optional(),
});
export type ApiKeyValidationRequest = z.infer<typeof ApiKeyValidationRequestSchema>;

export const ApiKeyValidationResultSchema = z.object({
  ok: z.boolean(),
  status: z.number().nullable(),
  code: z.string().nullable(),
  reason: z.enum(['ok', 'invalid', 'forbidden', 'rate_limited', 'quota_exceeded', 'unreachable', 'unknown']),
  message: z.string(),
  modelAccessible: z.boolean().nullable().optional(),
});
export type ApiKeyValidationResult = z.infer<typeof ApiKeyValidationResultSchema>;
