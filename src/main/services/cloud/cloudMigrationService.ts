/**
 * Cloud Migration Service
 *
 * Handles syncing local data to the cloud service when a user enables cloud mode.
 * Migrates settings, MCP config, workspace, app data, and sessions.
 *
 * Phases (canonical sub-ranges live in `@shared/cloudMigrationPhases`):
 *   1. Settings    (0–5%)    — Strip local-only fields, PATCH to cloud
 *   2. MCP Config  (5–10%)   — Upload MCP router config + OAuth tokens
 *   3. Workspace   (10–22%)  — Stream tar.gz of workspace to cloud
 *   4. Extract     (22–30%)  — Cloud-side untar progress (NDJSON)
 *   5. App Data    (30–45%)  — Stream tar.gz of userData to cloud
 *   6. Sessions    (45–95%)  — Upload each session individually
 *   7. Complete    (95–100%)
 */

import { randomUUID } from 'node:crypto';
import { createScopedLogger } from '@core/logger';
import { CloudServiceClient } from './cloudServiceClient';
import { getDataPath } from '../../utils/dataPaths';
import type { AppSettings, AgentSession } from '@shared/types';
import type { FolderStoreData } from '@shared/ipc/schemas/folders';
import { getFolderStore } from '@core/services/folderStore';
import { stripLocalSettings } from '@shared/cloudSettingsPolicy';
import { isSafeRelativePath } from '@shared/authRelayConfig';
import { WORKSPACE_SKIP_DIRS, APP_DATA_SKIP } from '@core/services/cloud/migrationSkipLists';
import { scrubAppSettingsSecretsForBackup } from '@core/utils/appSettingsSecretScrub';
import { stripConversationAnnotations } from './cloudRouterHelpers';
// MigrationStep is canonically declared in @shared/cloudMigrationTypes; re-exported
// below so existing callers (cloudHandlers.ts, tests) don't need to change their imports.
import type { MigrationStep } from '@shared/cloudMigrationTypes';
import { MIGRATION_PHASE_RANGES, mapToPhaseRange } from '@shared/cloudMigrationPhases';

export type { MigrationStep };

const log = createScopedLogger({ service: 'cloudMigration' });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MigrationOptions {
  cloudUrl: string;
  cloudToken: string;
  /** Provide settings directly — avoids coupling to global singleton. */
  getSettings: () => AppSettings;
  /** Provide sessions directly — avoids coupling to global singleton. */
  loadSessions: () => AgentSession[];
  /**
   * Provide folder state directly — avoids coupling to the FolderStore
   * singleton so tests can stub it (mirrors `loadSessions`). The folders
   * upload step itself is wired in Stage 4; this is just the injection point.
   * Defaults to `getFolderStore().load()` when omitted.
   */
  loadFolders?: () => FolderStoreData;
  onProgress?: (step: MigrationStep) => void;
}

export interface MigrationResult {
  settingsMigrated: boolean;
  mcpConfigMigrated: boolean;
  workspaceFilesMigrated: number;
  appDataMigrated: boolean;
  sessionsMigrated: number;
  /**
   * True when the conversation-folders document was PUT to the cloud folders
   * carrier (`/api/sessions/folders`). False if the upload failed or was
   * skipped — a folders failure never aborts the session migration (F8).
   */
  foldersMigrated: boolean;
  errors: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Workspace coreDirectory on the cloud service. */
const CLOUD_CORE_DIRECTORY = '/data/workspace';

/** Backup directory name (already in APP_DATA_SKIP). */
const BACKUP_DIR = 'pre-cloud-backup';

/**
 * Upper bound on the workspace pre-walk. If we can't finish stat-summing the
 * tree inside this budget, we degrade to an "Estimating..." bar rather than
 * blocking the upload indefinitely. Matches the "no regression" contract in
 * the planning doc.
 */
const WORKSPACE_WALK_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Concurrency mutex
// ---------------------------------------------------------------------------

/**
 * Module-level mutex so two overlapping `cloud:migrate` calls can't stomp on
 * each other's settings/sessions/streams. The handler surfaces
 * `MigrationInProgressError` with the `MIGRATION_IN_PROGRESS` code when a
 * second call comes in mid-flight.
 */
let migrationInFlight = false;

/** Thrown when a second migration is attempted while one is already running. */
export class MigrationInProgressError extends Error {
  code: string;
  constructor() {
    super('A cloud migration is already in progress');
    this.name = 'MigrationInProgressError';
    this.code = 'MIGRATION_IN_PROGRESS';
  }
}

/**
 * For tests + diagnostics — true while a migration is running.
 */
export function isMigrationInFlight(): boolean {
  return migrationInFlight;
}

// ---------------------------------------------------------------------------
// Pre-Cloud Backup
// ---------------------------------------------------------------------------

/**
 * Create a snapshot of local data before migrating to cloud.
 * Copies settings and sessions so user can recover if post-migration state diverges.
 *
 * Max one backup at a time (overwrites previous). This is a safety net, not version history.
 */
export async function createPreCloudBackup(): Promise<{ sessionCount: number } | null> {
  const fs = await import('node:fs/promises');
  const fsSync = await import('node:fs');
  const path = await import('node:path');

  const userDataPath = getDataPath();
  const backupDir = path.join(userDataPath, BACKUP_DIR);
  const settingsSource = path.join(userDataPath, 'app-settings.json');
  const sessionsSource = path.join(userDataPath, 'sessions');

  try {
    await fs.rm(backupDir, { recursive: true, force: true });
    await fs.mkdir(backupDir, { recursive: true });

    // Copy settings
    if (fsSync.existsSync(settingsSource)) {
      try {
        const rawSettings = await fs.readFile(settingsSource, 'utf8');
        const settingsBackup = scrubAppSettingsSecretsForBackup(JSON.parse(rawSettings) as unknown);
        await fs.writeFile(
          path.join(backupDir, 'app-settings.json'),
          JSON.stringify(settingsBackup, null, 2),
          { encoding: 'utf8', mode: 0o600 },
        );
      } catch (settingsBackupError) {
        log.warn(
          { err: settingsBackupError },
          'Skipped app settings in pre-cloud backup because the file could not be scrubbed',
        );
      }
    }

    // Copy sessions directory
    let sessionCount = 0;
    if (fsSync.existsSync(sessionsSource)) {
      const backupSessionsDir = path.join(backupDir, 'sessions');
      await fs.mkdir(backupSessionsDir, { recursive: true });
      const files = await fs.readdir(sessionsSource);
      for (const file of files) {
        if (file.endsWith('.json')) {
          await fs.copyFile(
            path.join(sessionsSource, file),
            path.join(backupSessionsDir, file),
          );
          sessionCount++;
        }
      }
    }

    // Write timestamp
    await fs.writeFile(
      path.join(backupDir, 'created-at.txt'),
      new Date().toISOString(),
      'utf8',
    );

    log.info({ sessionCount, backupDir }, 'Pre-cloud backup created');
    return { sessionCount };
  } catch (err) {
    log.error({ err }, 'Failed to create pre-cloud backup');
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Emit a progress event. Always decorates the step with `runId` so downstream
 * consumers (ThroughputEstimator, support diagnostics) can tie events to a
 * single migration run without relying on temporal heuristics.
 */
function reportProgress(
  options: MigrationOptions,
  runId: string,
  step: MigrationStep,
): void {
  const stepWithRunId: MigrationStep = { ...step, runId: step.runId ?? runId };
  log.info(
    {
      phase: stepWithRunId.phase,
      progress: stepWithRunId.progress,
      current: stepWithRunId.current,
      total: stepWithRunId.total,
      runId: stepWithRunId.runId,
      live: stepWithRunId.live,
    },
    stepWithRunId.message,
  );
  options.onProgress?.(stepWithRunId);
}

/**
 * Prepare settings for the cloud instance.
 *
 * - Strips local-only fields (cloudInstance, coreDirectory, mcpConfigFile).
 * - Sets `coreDirectory` to the cloud workspace path.
 */
/**
 * Resolve the folder-state loader for a migration run. Uses the injected
 * `loadFolders` when provided (tests), else defaults to the real
 * `getFolderStore().load()` singleton.
 *
 * NOTE: This only resolves the loader — the actual folders upload step is
 * wired in Stage 4. Exported so the Stage-4 upload site and tests share one
 * default.
 */
export function resolveLoadFolders(
  options: Pick<MigrationOptions, 'loadFolders'>,
): () => FolderStoreData {
  if (options.loadFolders) return options.loadFolders;
  return () => getFolderStore().load();
}

export function prepareCloudSettings(settings: AppSettings): Record<string, unknown> {
  const cleaned = stripLocalSettings(settings as Record<string, unknown>);

  // Replace coreDirectory with the cloud workspace path
  cleaned['coreDirectory'] = CLOUD_CORE_DIRECTORY;

  return cleaned;
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

/**
 * Migrate local settings, workspace, app data, and sessions to the cloud service.
 *
 * Resilient: individual phase failures are logged and tracked in
 * `result.errors` but do NOT abort the overall migration.
 */
export async function migrateToCloud(options: MigrationOptions): Promise<MigrationResult> {
  // Concurrency mutex — reject overlapping migrations cleanly rather than
  // stomping on each other's settings/streams. The handler maps this to the
  // MIGRATION_IN_PROGRESS IPC error.
  if (migrationInFlight) {
    throw new MigrationInProgressError();
  }
  migrationInFlight = true;

  // One UUID per run — decorates every emitted MigrationStep so the renderer
  // can key per-run caches (ThroughputEstimator) on it without accidentally
  // sharing samples across retries.
  const runId = randomUUID();

  const { cloudUrl, cloudToken, getSettings, loadSessions } = options;

  // Snapshot local settings NOW — before any cloud interaction.
  // Once cloud mode is fully active, getSettings() may return cloud-merged
  // values with different paths (e.g., coreDirectory = '/data/workspace').
  // The migration must use the local paths to find files to upload.
  const localSettings = getSettings();
  const localCoreDirectory = localSettings.coreDirectory;
  const localMcpConfigFile = localSettings.mcpConfigFile;

  log.info(
    { cloudUrl, localCoreDirectory, localMcpConfigFile, runId },
    'Starting cloud migration',
  );

  // Safety net: snapshot local data before any cloud interaction
  const backup = await createPreCloudBackup();
  if (backup) {
    log.info({ sessionCount: backup.sessionCount }, 'Pre-cloud backup created before migration');
  }

  const client = new CloudServiceClient(cloudUrl, cloudToken);
  const result: MigrationResult = {
    settingsMigrated: false,
    mcpConfigMigrated: false,
    workspaceFilesMigrated: 0,
    appDataMigrated: false,
    sessionsMigrated: 0,
    foldersMigrated: false,
    errors: [],
  };

  // Progress allocation (canonical source: @shared/cloudMigrationPhases):
  //   Settings:   0–5%
  //   MCP Config: 5–10%
  //   Workspace:  10–22%
  //   Extract:    22–30%
  //   App Data:   30–45%
  //   Sessions:   45–95%
  //   Complete:   95–100%

  try {
    // ---- Phase 1: Settings (0–10%) ----------------------------------------

    reportProgress(options, runId, {
      phase: 'settings',
      message: 'Migrating settings and API keys...',
      progress: 0,
    });

    try {
      const settings = getSettings();
      const cloudSettings = prepareCloudSettings(settings);

      await client.patch('/api/settings', cloudSettings);
      result.settingsMigrated = true;

      reportProgress(options, runId, {
        phase: 'settings',
        message: 'Settings migrated (including API keys)',
        progress: 5,
      });
    } catch (err) {
      const message = `Settings migration failed: ${err instanceof Error ? err.message : String(err)}`;
      log.error({ err }, message);
      result.errors.push(message);

      reportProgress(options, runId, {
        phase: 'settings',
        message: 'Settings migration failed, continuing...',
        progress: 5,
      });
    }

    // ---- Phase 2: MCP Config (5–10%) --------------------------------------

    reportProgress(options, runId, {
      phase: 'mcp-config',
      message: 'Migrating MCP server configuration...',
      progress: 5,
    });

    try {
      let phaseHadError = false;
      let serverCount = 0;
      let authRelayCount = 0;
      let hasConfig = false;

      try {
        const mcpPayload = await readAndMergeMcpConfig(localSettings);
        if (mcpPayload) {
          await client.put('/api/mcp/config', mcpPayload);
          result.mcpConfigMigrated = true;
          hasConfig = true;
          serverCount = Object.keys(mcpPayload.config?.mcpServers ?? {}).length;
          log.info({ serverCount, tokenCount: mcpPayload.oauthTokens?.length ?? 0 }, 'MCP config migrated');
        }
      } catch (err) {
        phaseHadError = true;
        const message = `MCP config migration failed: ${err instanceof Error ? err.message : String(err)}`;
        log.error({ err }, message);
        result.errors.push(message);
      }

      try {
        const authRelayFiles = await collectAuthRelayFiles();
        for (const payload of authRelayFiles) {
          try {
            await client.post('/api/auth/relay', payload);
            authRelayCount += 1;
          } catch (err) {
            phaseHadError = true;
            const message = `Auth file relay failed (${payload.provider}): ${err instanceof Error ? err.message : String(err)}`;
            log.warn({ err, provider: payload.provider, relativePath: payload.relativePath }, message);
            result.errors.push(message);
          }
        }
        if (authRelayCount > 0) {
          log.info({ authRelayCount }, 'Auth relay files migrated');
        }
      } catch (err) {
        phaseHadError = true;
        const message = `Auth relay scan failed: ${err instanceof Error ? err.message : String(err)}`;
        log.error({ err }, message);
        result.errors.push(message);
      }

      if (phaseHadError) {
        reportProgress(options, runId, {
          phase: 'mcp-config',
          message: 'MCP config migration encountered errors, continuing...',
          progress: 10,
        });
      } else if (hasConfig) {
        const authSummary = authRelayCount > 0
          ? `, ${authRelayCount} auth file${authRelayCount === 1 ? '' : 's'}`
          : '';
        reportProgress(options, runId, {
          phase: 'mcp-config',
          message: `MCP config migrated (${serverCount} server${serverCount === 1 ? '' : 's'}${authSummary})`,
          progress: 10,
        });
      } else if (authRelayCount > 0) {
        reportProgress(options, runId, {
          phase: 'mcp-config',
          message: `No MCP config found, synced ${authRelayCount} auth file${authRelayCount === 1 ? '' : 's'}`,
          progress: 10,
        });
      } else {
        reportProgress(options, runId, {
          phase: 'mcp-config',
          message: 'No MCP config found, skipping',
          progress: 10,
        });
      }
    } catch (err) {
      const message = `MCP config migration failed: ${err instanceof Error ? err.message : String(err)}`;
      log.error({ err }, message);
      result.errors.push(message);
      reportProgress(options, runId, {
        phase: 'mcp-config',
        message: 'MCP config migration failed, continuing...',
        progress: 10,
      });
    }

    // ---- Phase 3: Workspace Files (10–30%) --------------------------------

    reportProgress(options, runId, {
      phase: 'workspace',
      message: 'Migrating workspace files...',
      progress: 10,
    });

    try {
      const coreDir = localCoreDirectory;
      if (coreDir) {
        const fileCount = await uploadWorkspaceFiles(client, coreDir, options, {
          // Honest workspace progress — map uncompressed bytes sent into the
          // workspace sub-range (10–22%). When `bytesTotal` is unknown (walk
          // timed out or produced zero sum), we emit a single degraded event
          // at the top of the range with `live: false` so the renderer falls
          // back to static copy instead of fabricating a ratio.
          onUploadProgress: (bytesSent, maybeBytesTotal) => {
            if (!maybeBytesTotal) {
              reportProgress(options, runId, {
                phase: 'workspace',
                message: 'Uploading workspace...',
                progress: MIGRATION_PHASE_RANGES.workspace.max,
                live: false,
              });
              return;
            }
            // Clamp the reported `current` to `total`. `bytesTotal` is the
            // sum of uncompressed *file* sizes from the pre-walk; tar adds
            // 512-byte headers per entry plus padding, so the tap sees a
            // slightly larger stream. Reporting `current > total` would
            // break the renderer's `current ≤ total` invariant. Clamping
            // preserves the invariant — the renderer will just show 100%
            // briefly at the end.
            const clampedSent = Math.min(bytesSent, maybeBytesTotal);
            const ratio = clampedSent / maybeBytesTotal;
            const mb = (clampedSent / (1024 * 1024)).toFixed(1);
            const totalMb = (maybeBytesTotal / (1024 * 1024)).toFixed(1);
            reportProgress(options, runId, {
              phase: 'workspace',
              message: `Uploading workspace... ${mb}/${totalMb} MB sent`,
              progress: mapToPhaseRange('workspace', ratio),
              current: clampedSent,
              total: maybeBytesTotal,
              bytesTotal: maybeBytesTotal,
              live: true,
            });
          },
          onExtracting: () => {
            // Handoff at the top of the workspace range — before any NDJSON
            // extract progress has arrived. Stage 6 follow-up events emitted
            // via `onExtractProgress` will advance us through the 22–30 band.
            reportProgress(options, runId, {
              phase: 'extract',
              message: 'Extracting on cloud... this may take a few minutes for large workspaces',
              progress: MIGRATION_PHASE_RANGES.extract.min,
              live: true,
            });
          },
          // Server-side extract progress — NDJSON events from the cloud
          // service. Map `bytesProcessed / bytesTotal` into the dedicated
          // extract sub-range (22–30). `bytesTotal` can be missing if the
          // pre-walk couldn't sum sizes; in that case we still advance the
          // message but keep the bar at the phase floor.
          onExtractProgress: ({ bytesProcessed, bytesTotal }) => {
            if (!bytesTotal || bytesTotal <= 0) {
              reportProgress(options, runId, {
                phase: 'extract',
                message: 'Extracting on cloud...',
                progress: MIGRATION_PHASE_RANGES.extract.min,
                live: true,
              });
              return;
            }
            const clamped = Math.min(bytesProcessed, bytesTotal);
            const ratio = clamped / bytesTotal;
            const mb = (clamped / (1024 * 1024)).toFixed(1);
            const totalMb = (bytesTotal / (1024 * 1024)).toFixed(1);
            reportProgress(options, runId, {
              phase: 'extract',
              message: `Extracting on cloud... ${mb}/${totalMb} MB extracted`,
              progress: mapToPhaseRange('extract', ratio),
              current: clamped,
              total: bytesTotal,
              bytesTotal,
              live: true,
            });
          },
          onUnreadableDirs: () => {
            // Non-fatal notice at the workspace-phase floor. `live: false`
            // tells the renderer this is static copy, not a live upload
            // counter. The upload continues with whatever the walk did
            // manage to enumerate.
            reportProgress(options, runId, {
              phase: 'workspace',
              message: 'Some files were unreadable and skipped',
              progress: MIGRATION_PHASE_RANGES.workspace.min,
              live: false,
            });
          },
        });
        result.workspaceFilesMigrated = fileCount;
        reportProgress(options, runId, {
          phase: 'workspace',
          message: `Workspace migrated (${fileCount} file${fileCount === 1 ? '' : 's'})`,
          progress: 30,
        });
      } else {
        reportProgress(options, runId, {
          phase: 'workspace',
          message: 'No workspace directory configured, skipping',
          progress: 30,
        });
      }
    } catch (err) {
      const message = `Workspace migration failed: ${err instanceof Error ? err.message : String(err)}`;
      log.error({ err }, message);
      result.errors.push(message);
      reportProgress(options, runId, {
        phase: 'workspace',
        message: 'Workspace migration failed, continuing...',
        progress: 30,
      });
    }

    // ---- Phase 5: App Data (30–45%) ----------------------------------------
    // Upload all local data stores (inbox, automations, memory, scratchpad,
    // tasks, etc.) as a tar.gz archive of the userData directory.

    reportProgress(options, runId, {
      phase: 'app-data',
      message: 'Migrating app data (inbox, memory, automations, etc.)...',
      progress: 30,
    });

    try {
      const appDataResult = await uploadAppData(client, options);
      result.appDataMigrated = appDataResult;
      reportProgress(options, runId, {
        phase: 'app-data',
        message: appDataResult ? 'App data migrated' : 'App data migration skipped',
        progress: 50,
      });
    } catch (err) {
      const message = `App data migration failed: ${err instanceof Error ? err.message : String(err)}`;
      log.error({ err }, message);
      result.errors.push(message);
      reportProgress(options, runId, {
        phase: 'app-data',
        message: 'App data migration failed, continuing...',
        progress: 50,
      });
    }

    // ---- Phase 5: Sessions (50–95%) ----------------------------------------

    let sessions: AgentSession[];
    try {
      sessions = loadSessions();
    } catch (err) {
      const message = `Failed to load local sessions: ${err instanceof Error ? err.message : String(err)}`;
      log.error({ err }, message);
      result.errors.push(message);
      sessions = [];
    }

    const totalSessions = sessions.length;

    reportProgress(options, runId, {
      phase: 'sessions',
      message: totalSessions > 0
        ? `Migrating ${totalSessions} session${totalSessions === 1 ? '' : 's'}...`
        : 'No sessions to migrate',
      progress: 50,
      current: 0,
      total: totalSessions,
    });

    for (let i = 0; i < sessions.length; i++) {
      const session = sessions[i];

      try {
        /* direct-session-put -- migration bootstrap */
        await client.put(
          `/api/sessions/${encodeURIComponent(session.id)}`,
          stripConversationAnnotations(session),
        );
        const { markCloudSynced } = await import('./cloudSyncMetadata');
        markCloudSynced(session.id);
        result.sessionsMigrated++;
      } catch (err) {
        const message = `Session "${session.id}" migration failed: ${err instanceof Error ? err.message : String(err)}`;
        log.warn({ err, sessionId: session.id }, message);
        result.errors.push(message);
      }

      // Progress: 50% → 95% proportional to session count
      const sessionProgress = totalSessions > 0
        ? 50 + Math.round(((i + 1) / totalSessions) * 45)
        : 95;

      reportProgress(options, runId, {
        phase: 'sessions',
        message: `Migrated ${i + 1} of ${totalSessions} session${totalSessions === 1 ? '' : 's'}`,
        progress: sessionProgress,
        current: i + 1,
        total: totalSessions,
      });
    }

    // ---- Phase 6: Folders (95%) --------------------------------------------
    // Upload the conversation-folders document AFTER all session PUTs so the
    // membership map references sessions that are already on the cloud (F7).
    // The whole document (folder defs incl. empty folders + membership +
    // version) rides as one PUT to the dedicated carrier — see PLAN.md
    // Carrier Option A. Wrapped in try/catch-continue: a folders failure must
    // never abort the (already-complete) session migration (F8).
    try {
      const folders = resolveLoadFolders(options)();
      /* direct-session-put -- folders carrier (Option A) */
      await client.put('/api/sessions/folders', folders);
      result.foldersMigrated = true;
      log.info(
        {
          folderCount: folders.folders.length,
          membershipCount: Object.keys(folders.membership).length,
        },
        'Folders document migrated to cloud',
      );
    } catch (err) {
      const message = `Folders migration failed: ${err instanceof Error ? err.message : String(err)}`;
      log.warn({ err }, message);
      result.errors.push(message);
    }

    // ---- Phase 5: Complete (95–100%) ----------------------------------------

    reportProgress(options, runId, {
      phase: 'complete',
      message: 'Migration complete',
      progress: 100,
    });

    log.info(
      {
        cloudUrl: options.cloudUrl,
        settingsMigrated: result.settingsMigrated,
        mcpConfigMigrated: result.mcpConfigMigrated,
        workspaceFilesMigrated: result.workspaceFilesMigrated,
        sessionsMigrated: result.sessionsMigrated,
        foldersMigrated: result.foldersMigrated,
        errorCount: result.errors.length,
      },
      'Cloud migration finished',
    );

    return result;
  } finally {
    client.disconnect();
    migrationInFlight = false;
  }
}

// ---------------------------------------------------------------------------
// MCP Config Migration (Stage 2)
// ---------------------------------------------------------------------------

interface McpConfigPayload {
  config: {
    mcpServers: Record<string, unknown>;
    security?: Record<string, unknown>;
    userDisabledToolsByServer?: Record<string, string[]>;
    disabledServers?: string[];
  };
  oauthTokens: Array<{
    packageId: string;
    type: 'tokens' | 'client';
    data: Record<string, unknown>;
  }>;
}

type AuthRelayProvider =
  | 'freshdesk'
  | 'google-workspace'
  | 'slack'
  | 'hubspot'
  | 'salesforce'
  | 'microsoft'
  | 'zendesk';

interface AuthRelayPayload {
  provider: AuthRelayProvider;
  relativePath: string;
  data: Record<string, unknown>;
}

/**
 * Read local MCP config, recursively resolve configPaths, merge into a flat config.
 * Includes all MCP servers (HTTP, SSE, and stdio). The cloud VM has Node/npx
 * so npx-based stdio servers work. Servers with unresolvable local paths will
 * fail gracefully at startup on the cloud side.
 * Also reads OAuth token files for included servers.
 *
 * Returns null if no MCP config is found.
 */
export async function readAndMergeMcpConfig(settings: AppSettings): Promise<McpConfigPayload | null> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const { getSuperMcpOAuthTokensDir } = await import('../../utils/testIsolation');

  const configPath = settings.mcpConfigFile;
  if (!configPath) return null;

  const resolvedPath = path.default.isAbsolute(configPath)
    ? configPath
    : path.default.resolve(settings.coreDirectory ?? process.cwd(), configPath);

  // Recursively resolve and merge configs (same logic as super-mcp registry.ts)
  const merged: McpConfigPayload['config'] = {
    mcpServers: {},
    security: {},
  };

  const visited = new Set<string>();
  const MAX_DEPTH = 20;

  const loadConfig = async (cfgPath: string, depth: number): Promise<void> => {
    const normalized = path.default.resolve(cfgPath);
    if (visited.has(normalized) || depth > MAX_DEPTH) return;
    visited.add(normalized);

    let config: Record<string, unknown>;
    try {
      const raw = await fs.readFile(normalized, 'utf-8');
      config = JSON.parse(raw);
    } catch {
      log.warn({ path: normalized }, 'Failed to read MCP config file, skipping');
      return;
    }

    // Merge mcpServers (all transports — stdio servers work on cloud via npx)
    const servers = config.mcpServers as Record<string, Record<string, unknown>> | undefined;
    if (servers && typeof servers === 'object') {
      for (const [name, entry] of Object.entries(servers)) {
        if (!entry || typeof entry !== 'object') continue;
        merged.mcpServers[name] = entry;
      }
    }

    // Merge security
    if (config.security && typeof config.security === 'object') {
      if (!merged.security) merged.security = {};
      Object.assign(merged.security, config.security);
    }

    // Merge userDisabledToolsByServer
    if (config.userDisabledToolsByServer && typeof config.userDisabledToolsByServer === 'object') {
      if (!merged.userDisabledToolsByServer) merged.userDisabledToolsByServer = {};
      const disabled = config.userDisabledToolsByServer as Record<string, string[]>;
      for (const [serverId, tools] of Object.entries(disabled)) {
        if (Array.isArray(tools)) {
          const existing = merged.userDisabledToolsByServer[serverId] ?? [];
          merged.userDisabledToolsByServer[serverId] = [...new Set([...existing, ...tools])];
        }
      }
    }

    // Merge disabledServers
    if (Array.isArray(config.disabledServers)) {
      if (!merged.disabledServers) merged.disabledServers = [];
      for (const id of config.disabledServers) {
        if (typeof id === 'string' && !merged.disabledServers.includes(id)) {
          merged.disabledServers.push(id);
        }
      }
    }

    // Follow configPaths recursively
    if (Array.isArray(config.configPaths)) {
      const baseDir = path.default.dirname(normalized);
      for (const refPath of config.configPaths) {
        if (typeof refPath === 'string' && refPath.trim()) {
          const resolved = path.default.isAbsolute(refPath)
            ? refPath
            : path.default.resolve(baseDir, refPath);
          await loadConfig(resolved, depth + 1);
        }
      }
    }
  };

  await loadConfig(resolvedPath, 0);

  // If no servers were found, nothing to migrate
  if (Object.keys(merged.mcpServers).length === 0) {
    log.info('No MCP servers found in config');
    return null;
  }

  // Rewrite any managed-install MCP entries back to their catalog npx form.
  // Managed entries store absolute local paths under `<userData>/mcp/managed-installs/`
  // which won't resolve on the cloud container — the cloud already supports
  // npx, so we ship the catalog-pinned npx form instead.
  try {
    const { getManagedInstallsRoot } = await import(
      '../managedMcpInstallServiceInstance'
    );
    const managedInstallsRoot = getManagedInstallsRoot();
    if (managedInstallsRoot) {
      const [{ rewriteManagedMcpEntriesToNpxForCloud, resolveConnectorCatalogPath }] =
        await Promise.all([import('../bundledMcpManager')]);
      try {
        const catalogRaw = JSON.parse(
          await fs.readFile(resolveConnectorCatalogPath(), 'utf-8'),
        ) as { connectors?: Array<Parameters<typeof rewriteManagedMcpEntriesToNpxForCloud>[2][number]> };
        const rewritten = rewriteManagedMcpEntriesToNpxForCloud(
          merged.mcpServers,
          managedInstallsRoot,
          catalogRaw?.connectors ?? [],
        );
        if (rewritten > 0) {
          log.info({ rewritten }, 'Rewrote managed MCP entries to npx for cloud payload');
        }
      } catch (catalogError) {
        // Non-fatal: managed entries will reach cloud unchanged. We surface the
        // warning so the issue is visible rather than silently shipping dead paths.
        log.warn(
          { err: catalogError },
          'Failed to load connector catalog for cloud managed→npx rewrite; managed entries untouched',
        );
      }
    }
  } catch (err) {
    log.warn(
      { err },
      'Failed to resolve managed install singleton for cloud rewrite (skipping)',
    );
  }

  // Strip default-only sandbox env keys (e.g. RUNWAY_ALLOWED_ROOT) from
  // bundled-runway entries before transmission. The desktop-resolved values
  // are absolute paths (`/Users/<user>/...`) that don't exist on the cloud
  // Linux machine; cloud's catalog-env backfill at boot will re-add them
  // with surface-coherent resolved DCA values. Plan: SF-7 / N-2 in
  // docs/plans/260520_runway_sandbox_central_trusted_roots.md.
  try {
    const { DEFAULT_ONLY_SANDBOX_ENV_KEYS } = await import('../mcpSandboxEnvKeys');
    let scrubbedEntryCount = 0;
    const scrubbedKeysByEntry: Record<string, string[]> = {};
    for (const [name, rawEntry] of Object.entries(merged.mcpServers)) {
      if (!rawEntry || typeof rawEntry !== 'object') continue;
      const entry = rawEntry as Record<string, unknown>;
      if (entry.catalogId !== 'bundled-runway') continue;
      const env = entry.env;
      if (!env || typeof env !== 'object' || Array.isArray(env)) continue;
      const envRecord = env as Record<string, unknown>;
      const removed: string[] = [];
      for (const key of DEFAULT_ONLY_SANDBOX_ENV_KEYS) {
        if (Object.prototype.hasOwnProperty.call(envRecord, key)) {
          delete envRecord[key];
          removed.push(key);
        }
      }
      if (removed.length > 0) {
        scrubbedEntryCount += 1;
        scrubbedKeysByEntry[name] = removed;
      }
    }
    if (scrubbedEntryCount > 0) {
      log.info(
        { scrubbedEntryCount, scrubbedKeysByEntry },
        'Stripped default-only sandbox env keys from bundled-runway entries before cloud transmission',
      );
    }
  } catch (err) {
    log.warn(
      { err },
      'Failed to strip sandbox env keys for cloud transmission (non-fatal; cloud backfill will still scrub at boot)',
    );
  }

  // Read OAuth token files for included servers
  const oauthTokens: McpConfigPayload['oauthTokens'] = [];
  const tokenDir = getSuperMcpOAuthTokensDir();

  for (const serverName of Object.keys(merged.mcpServers)) {
    for (const type of ['tokens', 'client'] as const) {
      const fileName = `${serverName}_${type}.json`;
      const tokenPath = path.default.join(tokenDir, fileName);
      try {
        const raw = await fs.readFile(tokenPath, 'utf-8');
        const data = JSON.parse(raw);
        oauthTokens.push({ packageId: serverName, type, data });
      } catch {
        // Token file doesn't exist for this server — that's fine
      }
    }
  }

  log.info(
    {
      serverCount: Object.keys(merged.mcpServers).length,
      tokenFileCount: oauthTokens.length,
      configFilesRead: visited.size,
    },
    'MCP config merged for cloud migration',
  );

  return { config: merged, oauthTokens };
}

async function readAuthRelayFile(
  filePath: string,
  fs: typeof import('node:fs/promises'),
): Promise<Record<string, unknown> | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function buildAuthRelayPayload(
  provider: AuthRelayProvider,
  basePath: string,
  filePath: string,
  fs: typeof import('node:fs/promises'),
  pathMod: typeof import('node:path'),
): Promise<AuthRelayPayload | null> {
  const relativePath = pathMod.relative(basePath, filePath);
  if (!isSafeRelativePath(relativePath)) return null;

  const data = await readAuthRelayFile(filePath, fs);
  if (!data) return null;

  return { provider, relativePath, data };
}

async function safeReadDir(
  dirPath: string,
  fs: typeof import('node:fs/promises'),
): Promise<import('node:fs').Dirent[]> {
  try {
    return await fs.readdir(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function collectAuthRelayFiles(): Promise<AuthRelayPayload[]> {
  const fs = await import('node:fs/promises');
  const pathMod = await import('node:path');

  const userDataPath = getDataPath();
  const results: AuthRelayPayload[] = [];

  // Google Workspace (root + instance-specific directories)
  const googleBase = pathMod.default.join(userDataPath, 'google-workspace-mcp');
  const googleRootAccounts = pathMod.default.join(googleBase, 'accounts.json');
  const googleRootCredentials = pathMod.default.join(googleBase, 'credentials');

  const googleRootAccountPayload = await buildAuthRelayPayload(
    'google-workspace',
    googleBase,
    googleRootAccounts,
    fs,
    pathMod,
  );
  if (googleRootAccountPayload) results.push(googleRootAccountPayload);

  const googleRootTokens = await safeReadDir(googleRootCredentials, fs);
  for (const entry of googleRootTokens) {
    if (!entry.isFile() || !entry.name.endsWith('.token.json')) continue;
    const filePath = pathMod.default.join(googleRootCredentials, entry.name);
    const payload = await buildAuthRelayPayload('google-workspace', googleBase, filePath, fs, pathMod);
    if (payload) results.push(payload);
  }

  const googleInstanceDirs = await safeReadDir(googleBase, fs);
  for (const entry of googleInstanceDirs) {
    if (!entry.isDirectory() || !entry.name.startsWith('GoogleWorkspace-')) continue;
    const instanceDir = pathMod.default.join(googleBase, entry.name);

    const accountsPath = pathMod.default.join(instanceDir, 'accounts.json');
    const accountsPayload = await buildAuthRelayPayload(
      'google-workspace',
      googleBase,
      accountsPath,
      fs,
      pathMod,
    );
    if (accountsPayload) results.push(accountsPayload);

    const credentialsDir = pathMod.default.join(instanceDir, 'credentials');
    const tokenEntries = await safeReadDir(credentialsDir, fs);
    for (const tokenEntry of tokenEntries) {
      if (!tokenEntry.isFile() || !tokenEntry.name.endsWith('.token.json')) continue;
      const tokenPath = pathMod.default.join(credentialsDir, tokenEntry.name);
      const tokenPayload = await buildAuthRelayPayload(
        'google-workspace',
        googleBase,
        tokenPath,
        fs,
        pathMod,
      );
      if (tokenPayload) results.push(tokenPayload);
    }
  }

  // Slack
  const slackBase = pathMod.default.join(userDataPath, 'mcp', 'slack');
  const slackConfigPayload = await buildAuthRelayPayload(
    'slack',
    slackBase,
    pathMod.default.join(slackBase, 'config.json'),
    fs,
    pathMod,
  );
  if (slackConfigPayload) results.push(slackConfigPayload);

  const slackWorkspacesDir = pathMod.default.join(slackBase, 'workspaces');
  const slackWorkspaces = await safeReadDir(slackWorkspacesDir, fs);
  for (const entry of slackWorkspaces) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const payload = await buildAuthRelayPayload(
      'slack',
      slackBase,
      pathMod.default.join(slackWorkspacesDir, entry.name),
      fs,
      pathMod,
    );
    if (payload) results.push(payload);
  }

  // HubSpot
  const hubspotBase = pathMod.default.join(userDataPath, 'mcp', 'hubspot');
  const hubspotAccountsPayload = await buildAuthRelayPayload(
    'hubspot',
    hubspotBase,
    pathMod.default.join(hubspotBase, 'accounts.json'),
    fs,
    pathMod,
  );
  if (hubspotAccountsPayload) results.push(hubspotAccountsPayload);

  const hubspotCredentialsDir = pathMod.default.join(hubspotBase, 'credentials');
  const hubspotTokens = await safeReadDir(hubspotCredentialsDir, fs);
  for (const entry of hubspotTokens) {
    if (!entry.isFile() || !entry.name.endsWith('.token.json')) continue;
    const payload = await buildAuthRelayPayload(
      'hubspot',
      hubspotBase,
      pathMod.default.join(hubspotCredentialsDir, entry.name),
      fs,
      pathMod,
    );
    if (payload) results.push(payload);
  }

  // Salesforce
  const salesforceBase = pathMod.default.join(userDataPath, 'mcp', 'salesforce');
  const salesforceCredentialsDir = pathMod.default.join(salesforceBase, 'credentials');
  const salesforceTokens = await safeReadDir(salesforceCredentialsDir, fs);
  for (const entry of salesforceTokens) {
    if (!entry.isFile() || !entry.name.endsWith('.token.json')) continue;
    const payload = await buildAuthRelayPayload(
      'salesforce',
      salesforceBase,
      pathMod.default.join(salesforceCredentialsDir, entry.name),
      fs,
      pathMod,
    );
    if (payload) results.push(payload);
  }

  // Microsoft 365
  const microsoftBase = pathMod.default.join(userDataPath, 'microsoft-mcp');
  const microsoftAccountsPayload = await buildAuthRelayPayload(
    'microsoft',
    microsoftBase,
    pathMod.default.join(microsoftBase, 'accounts.json'),
    fs,
    pathMod,
  );
  if (microsoftAccountsPayload) results.push(microsoftAccountsPayload);

  const microsoftCredentialsDir = pathMod.default.join(microsoftBase, 'credentials');
  const microsoftTokens = await safeReadDir(microsoftCredentialsDir, fs);
  for (const entry of microsoftTokens) {
    if (!entry.isFile() || !entry.name.endsWith('.token.json')) continue;
    const payload = await buildAuthRelayPayload(
      'microsoft',
      microsoftBase,
      pathMod.default.join(microsoftCredentialsDir, entry.name),
      fs,
      pathMod,
    );
    if (payload) results.push(payload);
  }

  // Zendesk
  const zendeskBase = pathMod.default.join(userDataPath, 'mcp', 'zendesk');
  const zendeskAccountsPayload = await buildAuthRelayPayload(
    'zendesk',
    zendeskBase,
    pathMod.default.join(zendeskBase, 'accounts.json'),
    fs,
    pathMod,
  );
  if (zendeskAccountsPayload) results.push(zendeskAccountsPayload);

  const zendeskCredentialsDir = pathMod.default.join(zendeskBase, 'credentials');
  const zendeskTokens = await safeReadDir(zendeskCredentialsDir, fs);
  for (const entry of zendeskTokens) {
    if (!entry.isFile() || !entry.name.endsWith('.token.json')) continue;
    const payload = await buildAuthRelayPayload(
      'zendesk',
      zendeskBase,
      pathMod.default.join(zendeskCredentialsDir, entry.name),
      fs,
      pathMod,
    );
    if (payload) results.push(payload);
  }

  // Freshdesk
  const freshdeskBase = pathMod.default.join(userDataPath, 'mcp', 'freshdesk');
  const freshdeskAccountsPayload = await buildAuthRelayPayload(
    'freshdesk',
    freshdeskBase,
    pathMod.default.join(freshdeskBase, 'accounts.json'),
    fs,
    pathMod,
  );
  if (freshdeskAccountsPayload) results.push(freshdeskAccountsPayload);

  const freshdeskCredentialsDir = pathMod.default.join(freshdeskBase, 'credentials');
  const freshdeskTokens = await safeReadDir(freshdeskCredentialsDir, fs);
  for (const entry of freshdeskTokens) {
    if (!entry.isFile() || !entry.name.endsWith('.token.json')) continue;
    const payload = await buildAuthRelayPayload(
      'freshdesk',
      freshdeskBase,
      pathMod.default.join(freshdeskCredentialsDir, entry.name),
      fs,
      pathMod,
    );
    if (payload) results.push(payload);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Workspace File Upload (Stage 3)
// ---------------------------------------------------------------------------

/**
 * Archive the entire workspace as a streaming tar.gz and pipe directly to the cloud.
 * Follows symlinks so linked directories (e.g. Google Drive) are included.
 * Uses `strict: false` for broken symlink tolerance.
 *
 * STREAMING: tar.create() → gzip → fetch body. Never buffers in memory.
 *
 * @returns Number of files extracted on cloud
 */
async function uploadWorkspaceFiles(
  client: CloudServiceClient,
  coreDir: string,
  _options: MigrationOptions,
  callbacks: {
    /**
     * Fires per-MB as uncompressed bytes flow from tar into gzip.
     * `bytesTotal` is `undefined` when the pre-walk timed out before we could
     * sum every file's size — the renderer keeps the bar at the phase floor
     * and falls back to "Estimating..." copy.
     */
    onUploadProgress: (bytesSent: number, bytesTotal: number | undefined) => void;
    onExtracting: () => void;
    /**
     * Fires per NDJSON progress event from the cloud service during extract.
     * `bytesTotal` is only populated when we passed `X-Migration-Bytes-Total`
     * (i.e. the pre-walk produced a size sum). Safe to no-op when extract
     * progress is not needed.
     */
    onExtractProgress?: (evt: { bytesProcessed: number; bytesTotal?: number }) => void;
    /**
     * Fires once after the pre-walk when one or more subdirectories under
     * the workspace root were unreadable (EACCES / EPERM / ELOOP / ENOENT
     * race). Caller emits a non-fatal workspace-phase progress step so the
     * partial upload is surfaced to the user instead of silently dropped.
     * See AGENTS.md — silent failure is a bug.
     */
    onUnreadableDirs?: () => void;
  },
): Promise<number> {
  const tar = await import('tar');
  const { createGzip } = await import('node:zlib');
  const { PassThrough } = await import('node:stream');
  const fsPromises = await import('node:fs/promises');
  const pathMod = await import('node:path');

  // Pre-walk the workspace to build an explicit file list plus a byte total.
  // This gives us full control: we resolve symlinks ourselves, skip broken
  // ones cleanly, and pass a known-good list to tar. No `follow: true`
  // needed — tar just packs the files we tell it to, producing a valid archive.
  //
  // While walking we also stat each real file to sum `bytesTotal`. The same
  // stat already happens for symlink resolution, so we reuse its result rather
  // than paying twice (see Stage 5 Improvement I4 in the planning doc).
  const filePaths: string[] = [];
  let brokenSymlinks = 0;
  let missingDuringStat = 0;
  let bytesTotal: number | undefined = 0;
  let walkTimedOut = false;
  // Set to true when at least one subdirectory under `coreDir` was unreadable
  // (permission error, broken mount, symlink loop, or race-condition ENOENT).
  // ENOENT on the root `coreDir` itself is NOT a flag-worthy skip — we treat
  // a missing root as "legitimately empty", matching the footprint scanner.
  let hadUnreadableDir = false;

  const walkStartedAt = Date.now();
  const deadline = walkStartedAt + WORKSPACE_WALK_TIMEOUT_MS;

  // Convert the deadline-based bail into an AbortController so we can plug
  // it into `safeWalkDirectory`, which gives us realpath cycle detection
  // (REBEL-506) on top of the existing timeout/skip semantics.
  const walkAbortController = new AbortController();
  const walkTimer = setTimeout(() => {
    walkTimedOut = true;
    walkAbortController.abort();
  }, Math.max(0, deadline - Date.now()));

  try {
    const { safeWalkDirectory } = await import('@core/utils/safeWalkDirectory');
    await safeWalkDirectory(coreDir, {
      signal: walkAbortController.signal,
      // Migration DELIBERATELY follows symlinks into cloud storage (Google
      // Drive, Dropbox) so linked directories are included in the workspace
      // archive uploaded to cloud. Opt out of the walker's default-on
      // cloud-symlink skip; default-on would silently drop linked Drive folders
      // from the migration archive.
      //
      // OP-LEVEL BOUND (Stage 10): the 30s `walkAbortController` deadline above
      // is the coarse overall cap — a dead/unresponsive cloud mount reached via
      // a workspace symlink can NOT hang the migration forever. safeWalkDirectory
      // checks `signal.aborted` between entries, so a wedged subtree that drips
      // entries aborts cleanly once the deadline fires (`onTruncated` then fires
      // with `'aborted'` ⇒ a visible partial-upload notice, never a silent drop).
      // Stage 5 additionally bounds the walker's OWN cloud `readdir`/`realpath`
      // with the per-path cloud budget, so individual descent syscalls into a
      // cloud dir no longer block unbounded either.
      //
      // ACCEPTED RESIDUAL (honest, coarse-by-design): `AbortSignal` cannot
      // interrupt a single kernel syscall mid-flight. This callback's own
      // `fsPromises.stat(absolutePath)` (byte-total sizing, below) runs outside
      // the walker's budget, so one stat stuck on a dataless cloud-FUSE
      // placeholder could still block past 30s until it settles. We accept that
      // here rather than route every per-file syscall through the off-thread
      // prober: migration runs rarely + user-initiated + off the turn-critical
      // path, and a clean bounded abort with a visible partial-upload outcome is
      // sufficient (the `UV_THREADPOOL_SIZE` floor bounds the blast radius). See
      // Stage 10 in docs/plans/260619_cloud-symlink-indexing/PLAN.md.
      skipCloudSymlinkTargets: false,
      onDirectory: ({ name }) => {
        if (WORKSPACE_SKIP_DIRS.has(name)) return false;
        return true;
      },
      onFile: async ({ absolutePath, name, viaSymlink }) => {
        if (WORKSPACE_SKIP_DIRS.has(name)) return;
        const relativePath = pathMod.default.relative(coreDir, absolutePath);
        filePaths.push(relativePath);
        if (bytesTotal === undefined) return;
        // Sum uncompressed size so the upload has a ratio denominator.
        // ENOENT here means the file was deleted between readdir and stat —
        // skip cleanly. Symlink-to-file: stat() already followed the link
        // so this is the target's size, matching the prior behaviour.
        try {
          const stat = await fsPromises.stat(absolutePath);
          bytesTotal += stat.size;
        } catch (err) {
          if (viaSymlink) {
            brokenSymlinks++;
          } else {
            missingDuringStat++;
          }
          log.debug(
            { path: relativePath, err },
            'File stat failed during workspace walk — skipping byte total',
          );
        }
      },
      onTruncated: ({ reasons, entriesVisited }) => {
        // Only "aborted" should fire here in normal operation (the
        // depth/path/entry caps are defence-in-depth). Either way, surface
        // it: the user gets a partial-upload notice instead of a silent
        // drop. (AGENTS.md — silent failure is a bug.)
        hadUnreadableDir = true;
        log.warn(
          { event: 'workspace.walk.truncated', reasons, entriesVisited },
          'Workspace pre-walk truncated — partial upload',
        );
      },
    });
  } finally {
    clearTimeout(walkTimer);
  }

  if (walkTimedOut) {
    // We can still upload the files we managed to enumerate, but we cannot
    // meaningfully scale the progress bar against a total we never finished
    // measuring. Fall back to the degraded "no ratio" path.
    bytesTotal = undefined;
  }

  log.info(
    {
      fileCount: filePaths.length,
      brokenSymlinks,
      missingDuringStat,
      hadUnreadableDir,
      walkTimedOut,
      walkDurationMs: Date.now() - walkStartedAt,
      bytesTotal,
    },
    'Workspace walk complete',
  );

  // Surface partial-coverage walks to the migration UI. This does NOT abort
  // the migration — a partial upload is better than zero — but the user gets
  // a visible, non-fatal notice instead of a silent drop.
  if (hadUnreadableDir) {
    callbacks.onUnreadableDirs?.();
  }

  if (filePaths.length === 0) {
    log.warn('Workspace walk found no files');
    return 0;
  }

  // Create streaming tar.gz from the pre-walked file list.
  // follow:true is safe now because we've already verified every symlink.
  const tarStream = tar.create(
    {
      cwd: coreDir,
      gzip: false,
      follow: true,
      strict: false,
    },
    filePaths,
  );

  const gzipStream = createGzip({ level: 6 });

  // Pre-gzip counter — reports *uncompressed* bytes flowing out of tar.
  // This is the correct numerator to ratio against `bytesTotal` (which is
  // the sum of uncompressed file sizes measured during the pre-walk). The
  // post-gzip "counter" below is only used to log + trigger the extracting
  // handoff — it is not the progress source.
  let bytesSentUncompressed = 0;
  let lastReportedUncompressedMB = 0;
  const preGzipCounter = new PassThrough();
  preGzipCounter.on('data', (chunk: Buffer) => {
    bytesSentUncompressed += chunk.length;
    const currentMB = Math.floor(bytesSentUncompressed / (1024 * 1024));
    if (currentMB > lastReportedUncompressedMB) {
      lastReportedUncompressedMB = currentMB;
      callbacks.onUploadProgress(bytesSentUncompressed, bytesTotal);
    }
  });

  // Post-gzip counter — diagnostic-only (observe compressed size + trigger
  // the "extracting" handoff). Not used for progress ratio.
  let compressedBytes = 0;
  const postGzipCounter = new PassThrough();
  postGzipCounter.on('data', (chunk: Buffer) => {
    compressedBytes += chunk.length;
  });

  const stream = tarStream.pipe(preGzipCounter).pipe(gzipStream).pipe(postGzipCounter);

  // When all bytes have been piped to the network, switch to "extracting"
  postGzipCounter.on('end', () => {
    log.info(
      {
        bytesSentUncompressed,
        compressedBytes,
        compressedMB: (compressedBytes / (1024 * 1024)).toFixed(1),
      },
      'Workspace archive upload complete, waiting for cloud extraction',
    );
    callbacks.onExtracting();
  });

  // Stream directly to cloud (2-hour timeout for large workspaces). Opt into
  // NDJSON responses only when we actually need extract progress — an older
  // cloud-service without Stage 6 simply returns legacy single-JSON when
  // the Accept header is absent.
  const response = await client.postStream(
    '/api/data/upload-archive?target=workspace',
    stream,
    {
      timeoutMs: 2 * 60 * 60 * 1000,
      bytesTotal,
      onProgress: callbacks.onExtractProgress
        ? (evt) => {
            if (evt.phase !== 'extract') return;
            callbacks.onExtractProgress?.({
              bytesProcessed: evt.bytesProcessed,
              bytesTotal: evt.bytesTotal,
            });
          }
        : undefined,
    },
  );
  log.info(
    { response, bytesSentUncompressed, compressedBytes },
    'Workspace archive streamed to cloud',
  );

  const fileCount = typeof response === 'object' && response !== null && 'fileCount' in response
    ? (response as { fileCount: number }).fileCount
    : 0;

  return fileCount;
}

// ---------------------------------------------------------------------------
// App Data Upload (Stage 4 — all local data stores)
// ---------------------------------------------------------------------------

/**
 * Archive the userData directory as a streaming tar.gz and pipe to cloud.
 * Merges into /data/ on the cloud (does NOT rm -rf — preserves sessions).
 *
 * STREAMING: tar.create() → gzip → fetch body. Never buffers in memory.
 *
 * @returns true if upload succeeded
 */
async function uploadAppData(
  client: CloudServiceClient,
  _options: MigrationOptions,
): Promise<boolean> {
  const tar = await import('tar');
  const { createGzip } = await import('node:zlib');

  const userDataDir = getDataPath();
  log.info({ userDataDir }, 'Archiving app data for cloud migration');

  // Create streaming tar.gz of userData with comprehensive skip list
  const tarStream = tar.create(
    {
      cwd: userDataDir,
      gzip: false,
      follow: false, // no symlinks in userData
      strict: false,
      filter: (entryPath: string) => {
        const parts = entryPath.split('/');
        if (parts.some(p => APP_DATA_SKIP.has(p))) return false;
        const basename = parts[parts.length - 1];
        if (basename.endsWith('.tmp') || basename.endsWith('.crswap')) return false;
        return true;
      },
    },
    ['.'],
  );

  const gzipStream = createGzip({ level: 6 });
  const stream = tarStream.pipe(gzipStream);

  // Stream to cloud (5-minute timeout — app data is much smaller than workspace)
  const response = await client.postStream(
    '/api/data/upload-archive?target=appdata',
    stream,
    5 * 60 * 1000,
  );
  log.info({ response }, 'App data archive streamed to cloud');

  return typeof response === 'object' && response !== null && 'success' in response
    ? Boolean((response as { success: boolean }).success)
    : false;
}
