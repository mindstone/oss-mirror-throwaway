/**
 * Core application constants — platform-agnostic, imported across the main,
 * renderer, and cloud surfaces. (Renderer access is via the explicit allowlist
 * in tsconfig.renderer.json.)
 */

/**
 * Maximum directory nesting depth the Library file-tree walk descends. Subtrees
 * deeper than this are truncated (and flagged in the build metadata). Raised
 * 12 → 15 (260623) for deep cloud-synced workspaces — Drive/Dropbox placeholder
 * trees and nested project layouts routinely nest past 12. The global node/byte
 * caps below still bound total memory regardless of this depth, so a deeper walk
 * cannot OOM the renderer; it just lets a deeper-but-not-wider tree index fully.
 */
export const MAX_FILE_DEPTH = 15;
/**
 * Maximum children to index per directory.
 * When exceeded, entries are prioritized by: directories first, then by mtime (recent first).
 * Set high enough to handle typical workspace folders without silent data loss.
 * Raised 1000 → 10000 (260623) so large cloud-synced folders (Drive/Dropbox
 * dumps, big media/export directories) index fully instead of silently dropping
 * the lower-priority tail. This is a PER-DIRECTORY cap only; the global
 * MAX_FILE_TREE_NODES / MAX_FILE_TREE_ESTIMATED_BYTES budgets below still bound
 * the WHOLE tree's memory, so raising it cannot OOM the renderer.
 */
export const MAX_CHILDREN_PER_DIRECTORY = 10000;

/**
 * Global node-count ceiling for the Library file tree across the WHOLE
 * recursive walk (NOT per-directory). The producer (`buildFileTree`) reserves a
 * budget slot synchronously at admission, so an unbounded workspace can never
 * yield an unbounded tree and OOM the renderer. At ~100k nodes the renderer's
 * combined derivations (tree + flatten + path map + facets + Fuse index) retain
 * roughly ~126 MB steady-state — far under V8's 4 GB renderer ceiling — per the
 * 260616 OOM diagnosis (docs/plans/260616_stuck-library-renderer-oom/PLAN.md).
 * Actuals are logged on truncation so the cap can be tuned.
 */
export const MAX_FILE_TREE_NODES = 100_000;

/**
 * Global estimated-byte ceiling for the Library file tree (~128 MiB). A
 * complementary hard ceiling to MAX_FILE_TREE_NODES that catches pathological
 * trees with very long names/paths (cloud-sync placeholder paths can be deep)
 * before node count alone would. Per-node estimate ≈ 160 B object overhead +
 * 2 B/char for the UTF-16 `name` and `path` strings (see fileTreeService.ts
 * `estimateNodeBytes`). 128 MiB ≈ ~1M nodes of small paths, so node count is
 * normally the binding cap; the byte budget binds first only on long-path trees.
 */
export const MAX_FILE_TREE_ESTIMATED_BYTES = 128 * 1024 * 1024;

/**
 * Empirical TOTAL retained heap per Library file-tree node in the renderer,
 * measured by the 260616 OOM repro (docs/plans/260616_stuck-library-renderer-oom/PLAN.md,
 * "Phase 2" / Research Notes). This is the *combined* retained set across ALL
 * renderer derivations of a node at the cap — the tree itself + `flattenedFiles`
 * + `filePathMap` + `facetTreeEntries` + the Fuse search index — so it ALREADY
 * folds in the ~3-5× copy multiplier. Do NOT multiply by the copy count again.
 * (Cross-check: the repro put V8's 4 GiB renderer ceiling at ~3.4M nodes
 * steady-state ⇒ 4 GiB / 3.4M ≈ ~1260 B/node.)
 *
 * @internal Tested-only anchor — consumed solely by fileTreeCapBudget.test.ts
 * (no production consumer by design), so the knip production leg flags it; the
 * default leg keeps tracking it. See docs/project/DEAD_CODE_DETECTION_AND_REMOVAL.md.
 */
export const RENDERER_RETAINED_BYTES_PER_NODE = 1260;

/**
 * Heap the Library file tree's retained set may safely occupy in the renderer.
 * V8's renderer heap ceiling is 4 GiB; we reserve 1.5 GiB (~37%) for the tree's
 * retained derivations and leave the remaining ~2.5 GiB as headroom for the
 * rest of the renderer (React tree, other features, transient allocations, GC
 * slack). The 260616 OOM was a crash-loop right at the 4 GiB ceiling, so the
 * budget is deliberately a conservative fraction — not the whole ceiling.
 * Used only by the deterministic cap-budget gate
 * (fileTreeCapBudget.test.ts), which asserts the configured caps stay within it.
 *
 * @internal Tested-only anchor (see above) — no production consumer by design, so
 * the knip production leg flags it; the default leg keeps tracking it.
 */
export const RENDERER_HEAP_SAFE_BUDGET_BYTES = 1.5 * 1024 * 1024 * 1024;

/**
 * Index eviction threshold: once the session index exceeds this, the oldest
 * DONE sessions are evicted (ACTIVE sessions are never evicted). NOT a hard
 * create-cap. Consumed by incrementalSessionStore.evictIfNeeded().
 *
 * 25000 is a deliberate ceiling: the index is whole-file (re-serialized +
 * atomically rewritten on every mutation, parsed synchronously at startup) and
 * whole-list (full summary list shipped to renderer/cloud/mobile). At ~1 KB per
 * index entry that's a ~25 MB index — comfortable headroom without architectural
 * work. Going materially higher (≳50k) needs the index made incremental/
 * paginated first; don't raise this without that work.
 */
export const MAX_PERSISTED_SESSIONS = 25000;
/** Maximum number of draft-only sessions (0 messages + draft text) allowed before cleanup */
export const MAX_DRAFT_ONLY_SESSIONS = 10;
export const AGENT_SESSION_HISTORY_VERSION = 4;
// Note: Session index version is managed locally in incrementalSessionStore.ts (INDEX_VERSION = 9)
export const INBOX_STORE_VERSION = 6;
export const MAX_INBOX_HISTORY_ENTRIES = 100;
/** @deprecated Use INBOX_STORE_VERSION */
export const TASK_QUEUE_STORE_VERSION = INBOX_STORE_VERSION;
/** @deprecated Use MAX_INBOX_HISTORY_ENTRIES */
export const MAX_TASK_HISTORY_ENTRIES = MAX_INBOX_HISTORY_ENTRIES;
export const AUTOMATION_STORE_VERSION = 37;
export const MAX_AUTOMATION_RUN_HISTORY = 200;

/**
 * Age threshold for classifying a numbered-copy conflict (e.g. `File (1).md`)
 * as a "legacy duplicate" — typically a years-old Google Drive import that
 * predates any current maintenance expectation. Conflicts older than this
 * are NEVER sent through the LLM merge pipeline (would trigger a first-run
 * cost spike). Stage 4 of docs/plans/260411_shared_space_maintenance.md.
 *
 * Default: 2 years (730 days). Kept as a constant for now; a future
 * iteration may expose this via settings for power users.
 */
export const LEGACY_DUPLICATE_THRESHOLD_MS = 2 * 365 * 24 * 60 * 60 * 1000;

/**
 * TOMBSTONE — operatorGroundingStore deleted in Phase B (`docs/plans/260526_operators_redesign_stage10_through_15.md`).
 * Kept to preserve epoch monotonicity; do not reuse for a new store version.
 */
export const OPERATOR_GROUNDING_STORE_VERSION = 1;

export const MEMORY_HISTORY_STORE_VERSION = 1;
/**
 * Backstop cap for persisted memory history. Most pruning is age-based (90 days);
 * this ceiling prevents unbounded growth while still preserving deep recall.
 * 5000 entries × ~500 bytes ≈ ~2.5MB on disk, which is safe for electron-store.
 */
export const MAX_MEMORY_HISTORY_ENTRIES = 5000;
export const MEMORY_HISTORY_MAX_AGE_DAYS = 90;

export const TOOL_USAGE_STORE_VERSION = 6;
export const MAX_TRACKED_TOOLS = 200;
export const FREQUENT_TOOLS_LIMIT = 10;
export const TOOL_STALENESS_DAYS = 60;

// Skill usage tracking
export const SKILL_USAGE_STORE_VERSION = 2;
export const MAX_TRACKED_SKILLS = 100;
export const SKILL_STALENESS_DAYS = 30;
export const SKILL_NUDGE_COOLDOWN_DAYS = 7;

// Use case library
export const USE_CASE_LIBRARY_STORE_VERSION = 1;

// System improvement
export const SYSTEM_IMPROVEMENT_STORE_VERSION = 1;

// Hero choice (homepage "For You" recommendations)
export const HERO_CHOICE_STORE_VERSION = 1;

// Daily Spark (homepage weekly-generated personal note)
export const DAILY_SPARK_STORE_VERSION = 1;

// Conversation folders (sidebar organization)
export const FOLDER_STORE_VERSION = 1;

// Focus surface goals
export const GOALS_STORE_VERSION = 1;

// Community events nearby (Spark)
export const COMMUNITY_EVENTS_STORE_VERSION = 1;

// Community video recommendations (Spark)
export const COMMUNITY_VIDEO_RECS_STORE_VERSION = 1;

// Connector contributions (OSS MCP contribution flow)
//
// v2 (260420): additive — added `relayContributionId?: string` field on
// `ConnectorContribution` so we can track Mindstone-relay submissions
// independently from direct GitHub submissions. Migration is a no-op because
// the field is optional and existing records naturally read `undefined`.
// v3 (260424): additive — added optional `summary`, `motivation`, and
// `reviewerNotes` fields so user-authored PR form content persists locally
// before Stage 3 wires it into submit formatting.
// v4 (260426): additive — backfills `linkedSessionIds` (required, length>=1)
// from existing `sessionId` + `followUpSessionIds`, and `canonicalConnectorPath`
// from existing `localServerPath`. Closes failure-matrix #5 (multi-connector
// hijack) by construction. Duplicate-path records are NOT eagerly merged —
// preserved per user trade-off; a future Settings affordance handles them.
// See `src/core/services/contributionStore.ts::CONTRIBUTION_STORE_MIGRATIONS`
// and `docs/plans/260426_foolproof_contribution_flow_stage2.md`.
// v5 (Stage 3.C — 260426): additive no-op. The five new readiness fields
// (`lastBuildDetectedAt`, `lastTestPassedAt`, `lastRegisteredAt`,
// `lastReadyRequestedAt`, `lastBuildFingerprint`) start `undefined`
// and are populated lazily by the `contributionObservationService`
// reducer as observations fire. Per Decision 5 of the Stage 3 plan
// (`docs/plans/260426_foolproof_contribution_flow_stage3.md`), no
// per-record transformation runs — backfilling timestamps would be
// guess-work, and the safest behaviour is to require fresh observation
// evidence post-deploy.
// v6 (Stage 2 SE sensor — 260428): additive no-op. Adds optional
// `turnIndexWindow`, `lastSoftwareEngineerTaskCompletedAt`,
// `lastSoftwareEngineerEvidenceInvalidatedAt`, and
// `lastSoftwareEngineerEvidenceInvalidatedReason` for SE Task completion
// observation attribution and fingerprint-cascade invalidation lifecycle.
export const CONTRIBUTION_STORE_VERSION = 6;
export const PLUGIN_STORE_VERSION = 1;
export const PLUGIN_STORAGE_STORE_VERSION = 2;
export const PLUGIN_ACTIVATION_STORE_VERSION = 1;
export const MODELS_NAMESPACE_STORE_VERSION = 2;

// Per-file trust gate for the rebel-html:// document viewer.
// See src/core/services/htmlPreviewTrustService.ts.
export const HTML_PREVIEW_TRUST_STORE_VERSION = 1;
export const MAX_USE_CASES = 15;
export const USE_CASE_SIMILARITY_THRESHOLD = 0.85;
export const USE_CASE_QUALITY_THRESHOLD = 85;
export const USE_CASE_NEW_BADGE_DAYS = 7;
export const OAUTH_REFRESH_FAILURE_STORE_VERSION = 1;
export const CONVERSATION_FEEDBACK_VERSION = 2;

// ─── Data Schema Epoch ──────────────────────────────────────────────
// Central registry of ALL persistent store version constants.
// DATA_SCHEMA_EPOCH is auto-derived (sum of all versions) — it increases
// monotonically whenever ANY store version is bumped.
//
// Used by version-marker.json to detect when userData was written by a
// newer app version, triggering global read-only mode.
//
// IMPORTANT: When adding a new versioned store or bumping a version,
// update this registry. CI enforces this via scripts/check-store-versions.ts.
//
// If a store is removed, keep a tombstone entry (comment it with TOMBSTONE)
// to prevent the epoch from decreasing.
//
// @see docs/plans/partway/260219_global_store_version_gate.md
export const ALL_STORE_VERSIONS = {
  // Centralized versions (exported above)
  AGENT_SESSION_HISTORY_VERSION,
  INBOX_STORE_VERSION,
  AUTOMATION_STORE_VERSION,
  OPERATOR_GROUNDING_STORE_VERSION,
  MEMORY_HISTORY_STORE_VERSION,
  TOOL_USAGE_STORE_VERSION,
  SKILL_USAGE_STORE_VERSION,
  USE_CASE_LIBRARY_STORE_VERSION,
  SYSTEM_IMPROVEMENT_STORE_VERSION,
  HERO_CHOICE_STORE_VERSION,
  DAILY_SPARK_STORE_VERSION,
  FOLDER_STORE_VERSION,
  GOALS_STORE_VERSION,
  COMMUNITY_EVENTS_STORE_VERSION,
  COMMUNITY_VIDEO_RECS_STORE_VERSION,
  CONTRIBUTION_STORE_VERSION,
  PLUGIN_STORE_VERSION,
  PLUGIN_STORAGE_STORE_VERSION,
  PLUGIN_ACTIVATION_STORE_VERSION,
  MODELS_NAMESPACE_STORE_VERSION,
  HTML_PREVIEW_TRUST_STORE_VERSION,
  // Versions from local store files (canonical values here)
  // Key names MUST match the source constant names for CI validation.
  // Local stores with generic names (STORE_VERSION, CURRENT_STORE_VERSION)
  // are tracked by value but validated manually via CI INFO messages.
  INDEX_VERSION: 9,                              // incrementalSessionStore.ts (exported) — bumped 8→9 to force a rebuild applying migrateResolvedAutomationToDone (260617 resolved-automation doneAt backfill); 7→8 was the pinnedAt → doneAt rename
  SYNTHESIS_STORE_VERSION: 1,                    // spacesSynthesisStore.ts
  FILE_CONVERSATION_STORE_VERSION: 1,            // fileConversationStore.ts
  INBOUND_TRIGGER_STORE_VERSION: 1,              // inboundTriggers/types.ts (exported)
  COMMUNITY_SHARE_STORE_VERSION: 1,              // communityShareStore.ts
  USER_TASKS_STORE_VERSION: 1,                   // userTasksStore.ts
  SOURCE_METADATA_STORE_VERSION: 1,              // sourceMetadataStore.ts
  ENTITY_METADATA_STORE_VERSION: 1,              // entityMetadataStore.ts
  MEETING_CACHE_STORE_VERSION: 1,                // meetingCacheStore.ts
  // Stores using generic local names (STORE_VERSION / CURRENT_STORE_VERSION):
  // Tracked by value here, CI emits INFO for manual verification.
  TIME_SAVED_VERSION: 3,                         // timeSavedStore.ts (CURRENT_STORE_VERSION)
  ACHIEVEMENTS_VERSION: 3,                       // achievementsStore.ts (CURRENT_STORE_VERSION)
  MEETING_HISTORY_VERSION: 1,                    // meetingHistoryStore.ts (STORE_VERSION)
  PENDING_PHYSICAL_RECORDINGS_VERSION: 1,        // pendingPhysicalRecordingsStore.ts (STORE_VERSION)
  PENDING_LOCAL_UPLOADS_VERSION: 1,              // pendingLocalUploadsStore.ts (STORE_VERSION)
  PENDING_TRANSCRIPTS_VERSION: 1,                // pendingTranscriptsStore.ts (STORE_VERSION)
  IMPORT_TRACKING_VERSION: 1,                    // importTrackingStore.ts (STORE_VERSION)
  PENDING_APPROVALS_VERSION: 1,                  // pendingApprovalsStore.ts (STORE_VERSION)
  SAFETY_PROMPT_STORE_VERSION: 1,                // safetyPromptStore.ts
  SAFETY_ACTIVITY_LOG_STORE_VERSION: 1,          // safetyActivityLogStore.ts
  STAGED_TOOL_CALLS_VERSION: 1,                  // stagedToolCallsService.ts (STORE_VERSION)
  CONVERSATION_FEEDBACK_VERSION,                 // conversationFeedbackStore.ts
  LEARNED_MODEL_LIMITS_STORE_VERSION: 1,         // TOMBSTONE — learnedModelLimits.ts; data folded onto ModelProfile in Stage 2 (260503_unify_learned_limits_into_profiles.md). Kept to prevent epoch decrease and to keep the migration's legacy-store reader working on first boot.
  SKILL_RATINGS_VERSION: 1,                      // TOMBSTONE — skillRatingsStore deleted; kept to prevent epoch decrease
  PENDING_WORKSPACE_WRITES_VERSION: 1,           // TOMBSTONE — pendingWorkspaceWritesStore deleted; kept to prevent epoch decrease
  AUTONOMOUS_OPERATOR_STORE_TOMBSTONE_VERSION: 3, // TOMBSTONE — legacy autonomous-Operators store deleted; kept to prevent epoch decrease
  FLY_TOKENS_VERSION: 1,                         // flyTokenStorage.ts (fly-tokens store)
  CODEX_TOKEN_STORE_VERSION: 1,                  // codexTokenStorage.ts (codex-oauth-tokens store)
  CLAUDE_MAX_TOKEN_STORE_VERSION: 1,             // TOMBSTONE — store code deleted April 2026; kept to prevent epoch decrease
  USER_QUESTION_STORE_VERSION: 1,                // TOMBSTONE — pending-user-questions store deleted; kept to prevent epoch decrease
  MODEL_ROUTING_CONFIG_STORE_VERSION: 1,         // TOMBSTONE — dormant trio/modelRoutingConfig feature deleted (260612); never persisted, but kept to hold the epoch sum constant.
  OPENROUTER_TOKEN_STORE_VERSION: 1,             // openRouterTokenStorage.ts (openrouter-oauth-tokens store)
  OAUTH_REFRESH_FAILURE_STORE_VERSION,           // oauthRefreshFailureStore.ts (oauth-refresh-failures store)
  COOLDOWN_STORE_VERSION: 1,                     // cooldownStore.ts (api-cooldowns store)
  DESKTOP_LKG_CACHE_STORE_VERSION: 1,            // desktopLkgCache.ts — Stage D of 260510_cloud_image_rollback_defense_in_depth.md
} as const;

/**
 * Global data schema epoch — sum of all store version constants.
 * Monotonically increases when any store version is bumped.
 * Written to version-marker.json for cross-version data protection.
 */
export const DATA_SCHEMA_EPOCH: number = Object.values(ALL_STORE_VERSIONS).reduce((a, b) => a + b, 0);

export const KNOWLEDGE_WORKER_AGENT_NAME = 'knowledge-worker';
export const KNOWLEDGE_WORKER_AGENT_DESCRIPTION =
  'General-purpose knowledge worker with full access to all parent tools including MCP servers (Super-MCP, web search, file operations, etc.). Applies the shared system prompt instructions for research, analysis, writing, and any tasks requiring remote tool access.';
