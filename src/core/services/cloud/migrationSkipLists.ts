/**
 * Cloud Migration Skip Lists
 *
 * Single source of truth for the filesystem entries excluded from cloud
 * migration. Previously declared inline in
 * `src/main/services/cloud/cloudMigrationService.ts`; hoisted here so the
 * footprint measurement utility (`cloudMigrationFootprint.ts`) and the
 * uploader use the *same* skip set. Drift between "what we measure" and
 * "what we upload" would lead to the sizing recommendation under- or
 * over-counting the actual archive.
 *
 * See planning doc:
 *   docs/plans/260419_cloud_setup_adaptive_sizing_and_honest_progress.md
 *   (Stage 1 — Shared Utilities; Review-Driven Amendments → Stage 1)
 */

/**
 * Directories / files to skip during the workspace (`coreDirectory`) archive.
 * These are caches, vendor dirs, and platform noise that should never end up
 * on the cloud volume.
 *
 * TODO: Export `REBEL_SYSTEM_SKIP_DIRS` from the `rebel-system/` submodule so
 * it contributes to this union automatically. See planning doc
 * "Review-Driven Amendments → Stage 1 amendments → rebel-system skip
 * contribution". Deferred here to avoid submodule coordination in this stage.
 */
export const WORKSPACE_SKIP_DIRS: ReadonlySet<string> = new Set([
  '.git',
  'node_modules',
  '.DS_Store',
  '__pycache__',
  '.venv',
  'venv',
]);

/**
 * Directories and files to skip when archiving the userData directory.
 *
 * These are either:
 *   - Already migrated in earlier phases (settings, mcp, sessions)
 *   - Electron/Chrome runtime caches (not needed on cloud)
 *   - Temporary/transient data
 *   - Local-only config that must not go to cloud
 */
export const APP_DATA_SKIP: ReadonlySet<string> = new Set([
  // Electron/Chrome runtime caches
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnWebGPUCache',
  'DawnGraphiteCache',
  'Crashpad',
  'Local Storage',
  'Session Storage',
  // Transient data
  'logs',
  'traces',
  'models',
  'indices',
  'backups',
  'blob_storage',
  // Already migrated in earlier phases
  'sessions', // migrated individually in Phase 5
  'mcp',      // migrated in Phase 2
  // Chrome state files
  'Cookies',
  'Cookies-journal',
  'Network Persistent State',
  'Preferences',
  'TransportSecurity',
  'DIPS',
  'DevToolsActivePort',
  // Local config that must not go to cloud
  'app-settings.json',
  // Encrypted token stores — contain Electron safeStorage-encrypted data that
  // cannot be decrypted on cloud (no safeStorage available). Including these in
  // the archive overwrites correctly-synced tokens (pushed via dedicated REST
  // endpoints) with undecryptable binary, causing loadCodexTokens() to fail
  // with "Unexpected token 'v'" (the v10/v11 safeStorage header).
  // See: docs/plans/260428_safety_eval_unavailable_codex_token_corruption.md
  'codex-oauth-tokens.json',
  'auth-tokens.json',
  'openrouter-oauth-tokens.json',
  'fly-tokens.json',
  // Backup directories
  'pre-cloud-backup',
  'rebel-system-backup',
  'rebel-system',
  'system-settings',
]);
