import { ALL_STORE_VERSIONS } from '@core/constants';

export type MigrationClassificationVerdict =
  | 'copy'
  | 'exclude-derived'
  | 'exclude-keychain'
  | 'exclude-cloud'
  | 'exclude-transient'
  | 'special';

export interface MigrationClassificationEntry {
  readonly id: string;
  readonly verdict: MigrationClassificationVerdict;
  readonly versionKeys?: readonly (keyof typeof ALL_STORE_VERSIONS)[];
  readonly storeNames?: readonly string[];
  readonly relPaths?: readonly string[];
  readonly rationale: string;
}

export const MIGRATION_CLASSIFICATION_VERDICTS = [
  'copy',
  'exclude-derived',
  'exclude-keychain',
  'exclude-cloud',
  'exclude-transient',
  'special',
] as const satisfies readonly MigrationClassificationVerdict[];

export const MIGRATION_CLASSIFICATIONS = [
  {
    id: 'app-settings-sanitized',
    verdict: 'special',
    storeNames: ['app-settings'],
    relPaths: ['app-settings.json'],
    rationale: 'Field-level positive allowlist; credentials, cloud identity, and machine paths are stripped or repaired.',
  },
  {
    id: 'super-mcp-router',
    verdict: 'special',
    relPaths: ['mcp/super-mcp-router.json'],
    rationale: 'Router config contains local paths/env wiring and is regenerated on the target machine.',
  },
  {
    id: 'conversation-sessions',
    verdict: 'copy',
    versionKeys: ['AGENT_SESSION_HISTORY_VERSION', 'INDEX_VERSION', 'FOLDER_STORE_VERSION'],
    relPaths: ['sessions'],
    rationale: 'Primary user conversation history, session index, folders, and per-session asset directories.',
  },
  {
    id: 'legacy-agent-sessions',
    verdict: 'copy',
    relPaths: ['agent-sessions'],
    rationale: 'Legacy session files may still be migrated by the session store on first boot.',
  },
  {
    id: 'inbox',
    verdict: 'copy',
    versionKeys: ['INBOX_STORE_VERSION'],
    storeNames: ['inbox', 'inbox-index'],
    relPaths: ['inbox.json', 'inbox-index.json', 'inbox'],
    rationale: 'User-visible inbox/action state.',
  },
  {
    id: 'automations',
    verdict: 'copy',
    versionKeys: ['AUTOMATION_STORE_VERSION'],
    storeNames: ['automations'],
    relPaths: ['automations.json'],
    rationale: 'User-authored automation definitions and run history.',
  },
  {
    id: 'user-memory-and-usage-state',
    verdict: 'copy',
    versionKeys: [
      'MEMORY_HISTORY_STORE_VERSION',
      'TOOL_USAGE_STORE_VERSION',
      'SKILL_USAGE_STORE_VERSION',
      'USE_CASE_LIBRARY_STORE_VERSION',
      'SYSTEM_IMPROVEMENT_STORE_VERSION',
      'HERO_CHOICE_STORE_VERSION',
      'DAILY_SPARK_STORE_VERSION',
      'GOALS_STORE_VERSION',
      'COMMUNITY_EVENTS_STORE_VERSION',
      'COMMUNITY_VIDEO_RECS_STORE_VERSION',
      'HTML_PREVIEW_TRUST_STORE_VERSION',
      'SYNTHESIS_STORE_VERSION',
      'FILE_CONVERSATION_STORE_VERSION',
      'INBOUND_TRIGGER_STORE_VERSION',
      'COMMUNITY_SHARE_STORE_VERSION',
      'USER_TASKS_STORE_VERSION',
      'SOURCE_METADATA_STORE_VERSION',
      'ENTITY_METADATA_STORE_VERSION',
      'MEETING_CACHE_STORE_VERSION',
      'TIME_SAVED_VERSION',
      'ACHIEVEMENTS_VERSION',
      'MEETING_HISTORY_VERSION',
      'SAFETY_PROMPT_STORE_VERSION',
      'SAFETY_ACTIVITY_LOG_STORE_VERSION',
      'CONVERSATION_FEEDBACK_VERSION',
    ],
    storeNames: [
      'memory-history',
      'tool-usage',
      'skill-usage',
      'use-case-library',
      'system-improvement',
      'hero-choice',
      'daily-spark',
      'focus-goals',
      'community-events',
      'community-video-recs',
      'mcp-apps-trust',
      'spaces-synthesis',
      'file-conversation',
      'inbound-triggers',
      'community-share',
      'user-tasks',
      'source-metadata',
      'entity-metadata',
      'meeting-cache',
      'time-saved',
      'achievements',
      'meeting-history',
      'safety-prompt',
      'safety-activity-log',
      'conversation-feedback',
    ],
    relPaths: [
      'memory-history.json',
      'tool-usage.json',
      'skill-usage.json',
      'use-case-library.json',
      'system-improvement.json',
      'hero-choice.json',
      'daily-spark.json',
      'focus-goals.json',
      'community-events.json',
      'community-video-recs.json',
      'mcp-apps-trust.json',
      'spaces-synthesis.json',
      'file-conversation.json',
      'inbound-triggers.json',
      'community-share.json',
      'user-tasks.json',
      'source-metadata.json',
      'entity-metadata.json',
      'meeting-cache.json',
      'time-saved.json',
      'achievements.json',
      'meeting-history.json',
      'safety-prompt.json',
      'safety-activity-log.json',
      'conversation-feedback.json',
    ],
    rationale: 'Durable user preferences, metadata, feedback, community/share state, and local trust decisions.',
  },
  {
    id: 'meeting-pending-state',
    verdict: 'exclude-transient',
    versionKeys: [
      'PENDING_PHYSICAL_RECORDINGS_VERSION',
      'PENDING_LOCAL_UPLOADS_VERSION',
      'PENDING_TRANSCRIPTS_VERSION',
      'IMPORT_TRACKING_VERSION',
    ],
    storeNames: [
      'physical-recording-pending',
      'meeting-bot-local-uploads',
      'meeting-bot-pending',
      'meeting-bot-imports',
    ],
    relPaths: [
      'physical-recording-pending.json',
      'meeting-bot-local-uploads.json',
      'meeting-bot-pending.json',
      'meeting-bot-imports.json',
    ],
    rationale: 'In-flight local capture/import queues are machine/session transient.',
  },
  {
    id: 'approval-and-staging-state',
    verdict: 'exclude-transient',
    versionKeys: ['PENDING_APPROVALS_VERSION', 'STAGED_TOOL_CALLS_VERSION', 'PENDING_WORKSPACE_WRITES_VERSION'],
    storeNames: ['pending-tool-approvals', 'staged-tool-calls'],
    relPaths: ['pending-tool-approvals.json', 'staged-tool-calls.json'],
    rationale: 'Pending approvals and staged tool calls must not replay on a replacement machine.',
  },
  {
    id: 'provider-token-stores',
    verdict: 'exclude-keychain',
    versionKeys: [
      'FLY_TOKENS_VERSION',
      'CODEX_TOKEN_STORE_VERSION',
      'CLAUDE_MAX_TOKEN_STORE_VERSION',
      'OPENROUTER_TOKEN_STORE_VERSION',
      'OAUTH_REFRESH_FAILURE_STORE_VERSION',
    ],
    storeNames: ['fly-tokens', 'codex-oauth-tokens', 'openrouter-oauth-tokens', 'oauth-refresh-failures'],
    relPaths: [
      'auth-tokens.json',
      'fly-tokens.json',
      'codex-oauth-tokens.json',
      'claude-max-oauth-tokens.json',
      'openrouter-oauth-tokens.json',
      'oauth-refresh-failures.json',
    ],
    rationale: 'Token/keychain material is not portable and must be re-authenticated.',
  },
  {
    id: 'connector-token-and-mcp-state',
    verdict: 'exclude-keychain',
    relPaths: [
      'mcp',
      'google-workspace-mcp',
      'mcp/slack',
      'slack-mcp',
      'microsoft-mcp',
      'system-settings',
    ],
    rationale: 'Connector auth/config state can contain tokens and machine-local process wiring.',
  },
  {
    id: 'connector-contribution-drafts',
    verdict: 'exclude-keychain',
    versionKeys: ['CONTRIBUTION_STORE_VERSION'],
    storeNames: ['connector-contributions'],
    relPaths: ['connector-contributions.json'],
    rationale: 'OSS connector contribution drafts may embed connector env/secrets (A3 deny-list); re-create on the new machine.',
  },
  {
    id: 'plugin-state',
    verdict: 'exclude-keychain',
    versionKeys: ['PLUGIN_STORE_VERSION', 'PLUGIN_STORAGE_STORE_VERSION', 'PLUGIN_ACTIVATION_STORE_VERSION'],
    storeNames: ['plugin-storage', 'plugin-activation'],
    relPaths: ['plugin-storage.json', 'plugin-activation.json', 'plugin-data'],
    rationale: 'Plugin state is excluded in v1 because plugin data may contain credentials and setup is re-run.',
  },
  {
    id: 'cloud-device-and-continuity-state',
    verdict: 'exclude-cloud',
    storeNames: ['cloud-service-client-id', 'session-tombstones', 'drive-aware-sync-notice', 'analytics-storage'],
    relPaths: [
      'cloud-service-client-id.json',
      'session-tombstones.json',
      'drive-aware-sync-notice.json',
      'analytics-storage.json',
      'sessions/continuity-v2-cleanup-done',
      'cloud-outbox',
      'cloud-continuity-metadata.json',
      'cloud-session-sync-metadata.json',
    ],
    rationale: 'Per-device cloud identity, continuity, analytics anonymousId, and outbox state are regenerated/repaired.',
  },
  {
    id: 'derived-runtime-caches',
    verdict: 'exclude-derived',
    versionKeys: ['MODELS_NAMESPACE_STORE_VERSION', 'MODEL_ROUTING_CONFIG_STORE_VERSION', 'LEARNED_MODEL_LIMITS_STORE_VERSION'],
    storeNames: [
      'rebel-core-learned-model-limits',
      'drive-revision-hashes',
      'community-highlights',
      'daily-cost-reporting-state',
      'daily-time-saved-reporting-state',
    ],
    relPaths: [
      'models',
      'indices',
      'Cache',
      'Code Cache',
      'GPUCache',
      'DawnWebGPUCache',
      'DawnGraphiteCache',
      'Crashpad',
      'Local Storage',
      'Session Storage',
      'blob_storage',
      'rebel-core-learned-model-limits.json',
      'drive-revision-hashes.json',
      'community-highlights.json',
      'daily-cost-reporting-state.json',
      'daily-time-saved-reporting-state.json',
      'cost-ledger.jsonl',
    ],
    rationale: 'Caches, indexes, derived model metadata, and reporting ledgers are rebuilt or intentionally not migrated.',
  },
  {
    id: 'transient-runtime-state',
    verdict: 'exclude-transient',
    versionKeys: ['COOLDOWN_STORE_VERSION', 'DESKTOP_LKG_CACHE_STORE_VERSION'],
    storeNames: [
      'api-cooldowns',
      'desktop-lkg-cache',
      'version-check',
      'conflict-copy-cleanup-migration',
      'drive-history-migration',
      'auto-update-state',
      'clean-exit-flag',
      'update-health',
      'update-install-marker',
      'crash-recovery-cooldown',
      'session-coaching',
      'slackThreadAdapter',
    ],
    relPaths: [
      'api-cooldowns.json',
      'desktop-lkg-cache.json',
      'version-check.json',
      'conflict-copy-cleanup-migration.json',
      'drive-history-migration.json',
      'auto-update-state.json',
      'clean-exit-flag.json',
      'update-health.json',
      'update-install-marker.json',
      'crash-recovery-cooldown.json',
      'session-coaching.json',
      'slackThreadAdapter.json',
      'logs',
      'traces',
      'backups',
      'pre-cloud-backup',
      'rebel-system-backup',
      'sessions-deleted',
    ],
    rationale: 'Cooldowns, crash/update state, diagnostics, deleted-session tombstones, and live coaching state are per-install transient.',
  },
  {
    id: 'removed-store-tombstones',
    verdict: 'exclude-derived',
    versionKeys: [
      'OPERATOR_GROUNDING_STORE_VERSION',
      'SKILL_RATINGS_VERSION',
      'AUTONOMOUS_OPERATOR_STORE_TOMBSTONE_VERSION',
      'USER_QUESTION_STORE_VERSION',
    ],
    rationale: 'Registry tombstones for deleted stores have no current payload to migrate.',
  },
] as const satisfies readonly MigrationClassificationEntry[];

function buildIndex<K extends 'versionKeys' | 'storeNames' | 'relPaths'>(
  field: K,
): Map<string, MigrationClassificationEntry> {
  const index = new Map<string, MigrationClassificationEntry>();
  for (const entry of MIGRATION_CLASSIFICATIONS as readonly MigrationClassificationEntry[]) {
    for (const value of entry[field] ?? []) {
      if (index.has(value as string)) {
        throw new Error(`Duplicate migration classification for ${field}:${String(value)}`);
      }
      index.set(value as string, entry);
    }
  }
  return index;
}

export const MIGRATION_CLASSIFICATION_BY_VERSION_KEY = buildIndex('versionKeys') as ReadonlyMap<
  keyof typeof ALL_STORE_VERSIONS,
  MigrationClassificationEntry
>;

export const MIGRATION_CLASSIFICATION_BY_STORE_NAME = buildIndex('storeNames') as ReadonlyMap<
  string,
  MigrationClassificationEntry
>;

// Validation-only pass: throws at module load if two classification entries
// claim the same relPath (which would give one payload conflicting verdicts).
// The resulting map has no consumers — only buildIndex's duplicate check is
// load-bearing here, mirroring the version-key/store-name indices above.
buildIndex('relPaths');
