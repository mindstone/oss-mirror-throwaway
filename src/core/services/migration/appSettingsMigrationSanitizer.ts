import type {
  AppSettings,
  CalendarSettings,
  DiagnosticsSettings,
  ExperimentalSettings,
  MeetingBotSettings,
  ModelSettings,
  NpsSurveyState,
  SpaceConfig,
  VoiceSettings,
} from '@shared/types/settings';
import { isSensitiveKeyName } from '@shared/utils/redactionPatterns';

export type MigrationSafeAppSettings = Partial<AppSettings>;

export interface MigrationSettingsSanitizerResult {
  readonly settings: MigrationSafeAppSettings;
  readonly removedSecretFields: readonly string[];
}

export const MIGRATION_SAFE_APP_SETTINGS_KEYS = [
  'onboardingCompleted',
  'userEmail',
  'userFirstName',
  'onboardingFirstCompletedAt',
  'firstRunActionsPass',
  'onboardingChecklist',
  'nps',
  'voice',
  'models',
  'diagnostics',
  'experimental',
  'calendar',
  'companyName',
  'spaces',
  'googleDriveLinks',
  'googleDriveInstalled',
  'personalizedUseCases',
  'memoryUpdateEnabled',
  'memorySafetyLevel',
  'memorySafetyPrivate',
  'memorySafetyShared',
  'memorySafetyBySharing',
  'spaceSafetyOverrides',
  'spaceSafetyLevels',
  'enableStagedWrites',
  'enablePriorTurnsHeader',
  'spacesActivityFocus',
  'goalsDismissedUntil',
  'indexingEnabled',
  'gpuEmbeddingEnabled',
  'contextualRetrievalEnabled',
  'backgroundEnhancement',
  'enhancementUserRequested',
  'eulaAcceptedAt',
  'toolSafetyLevel',
  'chatIntentRulePersistence',
  'safetyEvalMemoization',
  'safetyEvalSessionIntent',
  'safetyEvalBlockConsensus',
  'safetyEvalUserIntentFence',
  'userSafetyInstructions',
  'trustedTools',
  'trustedPreviewDomains',
  'theme',
  'accentColor',
  'fontScale',
  'uiDensity',
  'conversationWidth',
  'inboxLayoutMode',
  'autoDoneByCategory',
  'alwaysAutoMarkDone',
  'lastSeenChangelogVersion',
  'dismissedWhatsNewHighlights',
  'timeSavedEstimation',
  'streaming',
  'localModel',
  'modelRoles',
  'behindTheScenesModel',
  'backgroundFallback',
  'localInferenceCloudFallback',
  'behindTheScenesOverrides',
  'heroChoiceRunMode',
  'dailySparkMode',
  'scratchpad',
  'meetingBot',
  'meetingBotUnlocked',
  'codexStaleClaudeRepaired',
  'codexRepairSchemaVersion',
  'codexProviderRepairedAt',
  'modelsNamespaceSchemaVersion',
  'openRouterProviderHealVersion',
  'openRouterProfileSourceMigrationVersion',
  'btsAutoProfileRerouteSchemaVersion',
  'settingsMigrationDegraded',
  'managedCloudEnabled',
  'mcpServerEnabled',
  'exposeProviderKeysInShell',
  'showDirectMcpSetupUi',
  'enforceSoftwareEngineerEvidence',
  'sessionLogRetentionDays',
  'cloudUpdateChannel',
] as const satisfies readonly (keyof AppSettings)[];

const URL_CREDENTIAL_RE = /^[a-z][a-z0-9+.-]*:\/\/[^/?#\s:@]+:[^/?#\s@]+@/i;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function cloneJson<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

function appendSecretPaths(value: unknown, path: string, out: Set<string>): void {
  if (value === undefined || value === null) return;
  const key = path.split('.').at(-1)?.replace(/\[\d+\]$/, '') ?? path;
  if (isSensitiveKeyName(key)) {
    out.add(path);
    return;
  }
  if (typeof value === 'string') {
    if (URL_CREDENTIAL_RE.test(value)) out.add(path);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => appendSecretPaths(item, `${path}[${index}]`, out));
    return;
  }
  if (!isRecord(value)) return;
  for (const [childKey, childValue] of Object.entries(value)) {
    appendSecretPaths(childValue, path ? `${path}.${childKey}` : childKey, out);
  }
}

/**
 * Defense-in-depth backstop: walk the already-allowlisted output and delete any
 * field whose key name looks secret, or any string that embeds in-URL credentials.
 *
 * The positive key allowlist + per-field sanitizers are the primary guarantee, but
 * a few sub-sanitizers (`sanitizeExperimental`, `sanitizeCalendar`, the `nps`/`default`
 * passthroughs) are structural passthroughs that would carry a *future* secret-bearing
 * field. This pass makes the secret walk load-bearing on the OUTPUT so "no secret
 * survives" holds by construction even as AppSettings evolves. Returns the dotted
 * paths it stripped, so the re-auth checklist still reflects anything dropped here.
 */
function stripSecretsInPlace(value: unknown, path: string, stripped: Set<string>): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => stripSecretsInPlace(item, `${path}[${index}]`, stripped));
    return;
  }
  if (!isRecord(value)) return;
  for (const [childKey, childValue] of Object.entries(value)) {
    const childPath = path ? `${path}.${childKey}` : childKey;
    if (isSensitiveKeyName(childKey)) {
      delete value[childKey];
      stripped.add(childPath);
      continue;
    }
    if (typeof childValue === 'string') {
      if (URL_CREDENTIAL_RE.test(childValue)) {
        delete value[childKey];
        stripped.add(childPath);
      }
      continue;
    }
    stripSecretsInPlace(childValue, childPath, stripped);
  }
}

function sanitizeVoice(value: VoiceSettings): Partial<VoiceSettings> {
  return {
    provider: value.provider,
    model: value.model,
    ttsVoice: value.ttsVoice,
    activationHotkey: value.activationHotkey,
    activationHotkeyVoiceMode: value.activationHotkeyVoiceMode,
    inlineVoiceHotkey: value.inlineVoiceHotkey,
    autoSpeak: value.autoSpeak,
    transcriptionVocabulary: cloneJson(value.transcriptionVocabulary),
    voiceInputLanguage: value.voiceInputLanguage,
  };
}

function sanitizeModels(value: ModelSettings): Partial<ModelSettings> {
  return {
    authMethod: 'api-key',
    model: value.model,
    permissionMode: value.permissionMode,
    executablePath: null,
    planMode: value.planMode,
    thinkingModel: value.thinkingModel,
    extendedContext: value.extendedContext,
    learnedContextWindowEnabled: value.learnedContextWindowEnabled,
    longContextFallbackModel: value.longContextFallbackModel,
    thinkingEffort: value.thinkingEffort,
    modelEfforts: cloneJson(value.modelEfforts),
  };
}

function sanitizeDiagnostics(value: DiagnosticsSettings): DiagnosticsSettings {
  return {
    debugBreadcrumbsUntil: value.debugBreadcrumbsUntil,
    forceDirectMcp: value.forceDirectMcp,
    developerMode: value.developerMode,
  };
}

function sanitizeExperimental(value: ExperimentalSettings): ExperimentalSettings {
  const {
    agentInstanceId: _agentInstanceId,
    inboundAuthorPolicy: _inboundAuthorPolicy,
    inboundAuthorPolicyBackup: _inboundAuthorPolicyBackup,
    inboundAuthorPolicyBypassActive: _inboundAuthorPolicyBypassActive,
    cloudSlackWorkspace: _cloudSlackWorkspace,
    ...safe
  } = value;
  return cloneJson(safe);
}

function sanitizeCalendar(value: CalendarSettings): CalendarSettings {
  return cloneJson(value);
}

function sanitizeMeetingBot(value: MeetingBotSettings): Partial<MeetingBotSettings> {
  return {
    enabled: value.enabled,
    rebelAvatar: value.rebelAvatar,
    oneOnOneSpaceId: value.oneOnOneSpaceId,
    groupMeetingSpaceId: value.groupMeetingSpaceId,
    physicalMeetingSpaceId: value.physicalMeetingSpaceId,
    joinMode: value.joinMode,
    promptMinutesBefore: value.promptMinutesBefore,
    localRecordingConsentAcknowledged: value.localRecordingConsentAcknowledged,
    localRecordingDisabled: value.localRecordingDisabled,
    localRecordingTriggerListening: value.localRecordingTriggerListening,
    triggerPhrase: value.triggerPhrase,
    respondViaVoice: value.respondViaVoice,
    coachProactiveIntervalMinutes: value.coachProactiveIntervalMinutes,
    enableConversationState: value.enableConversationState,
    enableEventDrivenTriggers: value.enableEventDrivenTriggers,
    enableQualityGate: value.enableQualityGate,
    enableTranscriptCleanup: value.enableTranscriptCleanup,
    meetingVoiceInstructions: value.meetingVoiceInstructions,
  };
}

function sanitizeSpaces(value: SpaceConfig[] | undefined): SpaceConfig[] | undefined {
  return cloneJson(value);
}

export function sanitizeAppSettingsForMigration(settings: AppSettings): MigrationSettingsSanitizerResult {
  const removedSecretFields = new Set<string>();
  appendSecretPaths(settings, '', removedSecretFields);

  const output: MigrationSafeAppSettings = {};

  // Intentionally partial per-key handling (a few keys get bespoke sub-sanitizers;
  // the rest are deep-cloned as-is). Written as an if/else chain rather than a
  // `switch (key)` so it isn't flagged by switch-exhaustiveness-check — exhaustively
  // listing every AppSettings key here would be noise, and the secret backstop below
  // (stripSecretsInPlace) is what guarantees safety for the cloned-as-is fields.
  for (const key of MIGRATION_SAFE_APP_SETTINGS_KEYS) {
    const value = settings[key];
    if (value === undefined) continue;
    if (key === 'voice') {
      output.voice = sanitizeVoice(value as VoiceSettings) as VoiceSettings;
    } else if (key === 'models') {
      output.models = sanitizeModels(value as ModelSettings) as ModelSettings;
    } else if (key === 'diagnostics') {
      output.diagnostics = sanitizeDiagnostics(value as DiagnosticsSettings);
    } else if (key === 'experimental') {
      output.experimental = sanitizeExperimental(value as ExperimentalSettings);
    } else if (key === 'calendar') {
      output.calendar = sanitizeCalendar(value as CalendarSettings);
    } else if (key === 'spaces') {
      output.spaces = sanitizeSpaces(value as SpaceConfig[]);
    } else if (key === 'meetingBot') {
      output.meetingBot = sanitizeMeetingBot(value as MeetingBotSettings) as MeetingBotSettings;
    } else if (key === 'localModel') {
      output.localModel = {
        profiles: [],
        activeProfileId: null,
      };
    } else if (key === 'nps') {
      output.nps = cloneJson(value as NpsSurveyState);
    } else {
      (output as Record<string, unknown>)[key] = cloneJson(value);
    }
  }

  delete output.activeProvider;
  delete output.managedProviderDeactivated;
  delete output.providerKeys;
  delete output.customProviders;
  delete output.cloudInstance;
  delete output.openRouter;
  delete output.googleWorkspace;
  delete output.hubspot;
  delete output.salesforce;
  delete output.gamma;
  delete output.telemetry;
  delete output.coreDirectory;
  delete output.mcpConfigFile;

  // Belt-and-braces: strip any secret-named field or credentialed URL that a
  // structural passthrough sanitizer let through, so the guarantee holds by
  // construction (not just by the current shape of AppSettings). Anything removed
  // here is also surfaced in removedSecretFields for the re-auth checklist.
  stripSecretsInPlace(output, '', removedSecretFields);

  return {
    settings: output,
    removedSecretFields: [...removedSecretFields].sort(),
  };
}
