/**
 * Core Startup — shared "brain" initialization for desktop and cloud-service.
 *
 * Centralises ALL critical-path services that both platforms need:
 * MCP server registration, inbox bridge, embedded credentials, settings
 * normalization, platform prompt cache, memory updates, and error recovery.
 *
 * @see docs/plans/finished/260221_centralise_core_startup.md
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import type { AppSettings, McpServerUpsertPayload } from '@shared/types';
import { getErrorReporter } from '@core/errorReporter';
import { createScopedLogger } from '@core/logger';
import { getPlatformConfig } from '@core/platform';
import {
  APP_BRIDGE_SERVER_NAME,
  buildAppBridgePayload,
  configureBundledMcpManager,
  buildSplitRebelInboxPayload,
  buildSplitRebelMeetingsPayload,
  buildSplitRebelSearchAndConversationsPayload,
  buildSplitRebelAutomationsPayload,
  buildSplitRebelSpacesPayload,
  buildSplitRebelSettingsPayload,
  buildSplitRebelMcpConnectorsPayload,
  buildSplitRebelPluginsPayload,
  buildRebelDiagnosticsPayload,
  buildRebelCanvasPayload,
  buildDiscoursePayload,
  writeRebelBridgeState,
} from './bundledMcpManager';
import { discoverBundledOAuthMcps } from './bundledMcpCloudRegistration';
import {
  startBundledInboxBridge,
  setAutomationSchedulerGetter,
  setMeetingBotServiceGetter,
} from './bundledInboxBridge';
import { warmPlatformPromptCache } from './mcpService';
import { configurePromptFileService, warmAllPrompts } from '@core/services/promptFileService';
import { getSystemSettingsPath } from './systemSettingsSync';
import { ensureRouterConfigFile, upsertMcpServerEntry, upsertMcpServersBatch, removeMcpServerEntry, getMcpServerEntry } from './mcpConfigManager';
import { ensureNormalizedSettings } from '../settingsStore';
import { initializeMemoryUpdateService, type MemoryUpdateDeps } from './memoryUpdateService';
import { initializeErrorRecoveryService, type ErrorRecoveryServiceDeps } from './errorRecoveryService';
import { markStartup } from './startupWaterfallService';
import type { AutomationScheduler } from './automationScheduler';
import type { MeetingBotService } from './meetingBot/meetingBotService';
import {
  createAppBridgeManager,
  type AppBridgeManager,
  type AppBridgeRuntimeState,
} from './appBridgeManager';
import { createAppBridgeIntentService } from './appBridgeIntentService';
import { getAppBridgeInstallerService } from './appBridgeInstallerService';
import { getBroadcastService } from '@core/broadcastService';
import { agentTurnRegistry } from '@core/services/agentTurnRegistry';
import {
  createConversationStreamCoordinator,
  type ConversationStreamCoordinator,
} from '@core/appBridge/server/conversationStreamCoordinator';
import {
  createOfficeSidecarManager,
  type OfficeSidecarManager,
} from './officeSidecarManager';
import { runStartupCleanup } from '@core/services/spaceMaintenanceService';
import {
  createDesktopMaintenanceDeps,
  createDesktopMaintenanceJournal,
  runDriveHistoryMigrationFromMain,
  scheduleConflictCopyCleanupDetection,
} from './spaceMaintenanceAdapter';


const log = createScopedLogger({ service: 'coreStartup' });

// ---------------------------------------------------------------------------
// MCP Registration Status — module-level tracking for diagnostics
// ---------------------------------------------------------------------------

export interface McpRegistrationStatus {
  lifecycle: 'not_started' | 'in_progress' | 'completed' | 'failed';
  registered: string[];
  gated: Array<{ id: string; code: string }>;
  failed: Array<{ id: string; code: string }>;
  capturedAt: string;
}

let mcpRegistrationStatus: McpRegistrationStatus = {
  lifecycle: 'not_started',
  registered: [],
  gated: [],
  failed: [],
  capturedAt: '',
};

/** Returns a deep copy of the current MCP registration status (safe to mutate). */
export function getMcpRegistrationStatus(): McpRegistrationStatus {
  return {
    ...mcpRegistrationStatus,
    registered: [...mcpRegistrationStatus.registered],
    gated: mcpRegistrationStatus.gated.map(g => ({ ...g })),
    failed: mcpRegistrationStatus.failed.map(f => ({ ...f })),
  };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CoreStartupDeps {
  /** Path to the user data directory (e.g. app.getPath('userData') or /data). */
  userDataDir: string;
  /** Path to the resources directory (bundled MCP scripts, rebel-system, etc.). */
  resourcesDir: string;
  /** Whether the app is running from a packaged build. */
  isPackaged: boolean;
  /** Path to the super-mcp-router.json file. */
  routerConfigPath: string;

  /** Returns current app settings (used for conditional MCP registration). */
  getSettings: () => AppSettings;

  /** Optional getter for the automation scheduler (for inbox bridge wiring). */
  getAutomationScheduler?: () => AutomationScheduler;
  /** Optional getter for the meeting bot service (for inbox bridge wiring). */
  getMeetingBotService?: () => MeetingBotService | null;

  /**
   * Memory update deps. If provided, initializeMemoryUpdateService is called.
   * The caller provides the executeAgentTurn wrapper because it's platform-specific
   * (desktop wires agentTurnRegistry + memoryWriteHook, cloud wires a simpler version).
   */
  memoryUpdateDeps?: MemoryUpdateDeps;

  /**
   * Error recovery deps. If provided, initializeErrorRecoveryService is called.
   * Same rationale: the executeAgentTurn wrapper differs per platform.
   */
  errorRecoveryDeps?: ErrorRecoveryServiceDeps;
}

export interface CoreStartupResult {
  /** Bridge connection details, or null if startup failed. */
  bridgeState: { port: number; token: string } | null;
  /** Number of MCP servers registered in the router config. */
  registeredMcpCount: number;
  /** Non-fatal errors encountered during startup. */
  errors: Array<{ service: string; error: Error }>;
  /**
   * App Bridge lifecycle manager. Always returned on desktop — may be in
   * a "skipped" state when the kill switch is set or
   * `capabilities.appBridgeServer === false`.
   * `null` when we're on cloud and never constructed one.
   * Hosts should register `manager.stop` with their graceful-shutdown
   * runner (desktop: `gracefulShutdown`, cloud: its own teardown path).
   */
  appBridgeManager: AppBridgeManager | null;
  /**
   * Runtime state of the App Bridge at end of startup, or `null` when the
   * bridge did not start (cloud host, kill switch, surface mismatch, or
   * factory failure — the failure is recorded in `errors` either way).
   */
  appBridgeState: AppBridgeRuntimeState | null;
  /**
   * Office sidecar lifecycle manager. Constructed during startup so the
   * desktop host can trigger eager-start later from `createWindow()` without
   * re-deriving its dependencies.
   */
  officeSidecarManager: OfficeSidecarManager | null;
  /**
   * Embedded-chat SSE fan-out coordinator. Constructed alongside the App
   * Bridge on desktop so the intent service's `streamConversation`
   * handler has somewhere to attach writers. `null` when the bridge
   * didn't start (cloud surface, kill switch, factory failure).
   * Hosts should wire `coordinator.closeAll()` into their graceful
   * shutdown runner — see `gracefulShutdown.setAppBridgeStreamCoordinator`.
   */
  conversationStreamCoordinator: ConversationStreamCoordinator | null;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Initialise the shared "agent brain" services.
 *
 * Call order:
 *  1. configureBundledMcpManager (fatal)
 *  2. ensureNormalizedSettings
 *  3. warmPlatformPromptCache (non-fatal)
 *  4. CLAUDE_CODE_STREAM_CLOSE_TIMEOUT env var
 *  5. ensureRouterConfigFile
 *  6. Wire inbox bridge getters
 *  7. startBundledInboxBridge + writeRebelBridgeState (non-fatal)
 *  8. Build + register MCP payloads (non-fatal)
 */
export async function initCoreServices(deps: CoreStartupDeps): Promise<CoreStartupResult> {
  const errors: CoreStartupResult['errors'] = [];
  let bridgeState: CoreStartupResult['bridgeState'] = null;
  let registeredMcpCount = 0;
  let appBridgeManager: AppBridgeManager | null = null;
  let appBridgeState: AppBridgeRuntimeState | null = null;
  let officeSidecarManager: OfficeSidecarManager | null = null;
  let conversationStreamCoordinator: ConversationStreamCoordinator | null = null;

  // Reset MCP registration status for this startup attempt
  mcpRegistrationStatus = {
    lifecycle: 'in_progress',
    registered: [],
    gated: [],
    failed: [],
    capturedAt: '',
  };

  markStartup('coreStartup start');

  // ── 1. Configure bundled MCP manager (fatal — everything else depends on this) ──
  configureBundledMcpManager({
    userDataDir: deps.userDataDir,
    resourcesDir: deps.resourcesDir,
    isPackaged: deps.isPackaged,
  });
  log.info('Bundled MCP manager configured');
  markStartup('bundled MCP manager configured');

  // ── 2. Normalize settings ──
  ensureNormalizedSettings();
  markStartup('settings normalized');

  // ── 3. Warm platform prompt cache (non-fatal) ──
  try {
    await warmPlatformPromptCache();
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    log.warn({ err: error }, 'Failed to warm platform prompt cache (will use fallback)');
    errors.push({ service: 'warmPlatformPromptCache', error });
  }
  markStartup('platform prompt cache warmed');

  // ── 4b. Configure and warm externalized prompt files ──
  // TODO(spun out): PROMPT_REGISTRY is now populated (~35 entries, including
  // `critical: true` safety prompts — see promptFileService.ts PROMPT_REGISTRY),
  // so the deferred decision below is now applicable but still unaddressed:
  // critical-prompt failures from warmAllPrompts() should trigger Safe Mode on
  // desktop / readiness failure on cloud, not be silently downgraded to a warning.
  // This warm path stays non-fatal until that product/ops decision lands (spans
  // both desktop + cloud; tracked as its own follow-up — see REBEL-63K PLAN
  // Discovered Improvements: "Cloud boot-time critical-prompt validation").
  try {
    const promptsPath = path.join(getSystemSettingsPath(), 'prompts');
    configurePromptFileService(promptsPath);
    await warmAllPrompts();
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    log.warn({ err: error }, 'Failed to warm prompt file cache');
    errors.push({ service: 'warmPromptFileCache', error });
  }
  markStartup('prompt file cache warmed');

  // ── 5. Stream timeout env var (prevents "Stream closed" errors with parallel turns) ──
  if (!process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT) {
    process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT = '600000';
  }

  // ── 6. Ensure router config file exists (non-fatal — idempotent, may already exist) ──
  try {
    await ensureRouterConfigFile(deps.routerConfigPath);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    log.error({ err: error }, 'Failed to ensure router config file');
    errors.push({ service: 'ensureRouterConfigFile', error });
  }
  markStartup('router config ensured');

  // ── 7. Wire inbox bridge getters ──
  if (deps.getAutomationScheduler) {
    setAutomationSchedulerGetter(deps.getAutomationScheduler);
  }
  if (deps.getMeetingBotService) {
    setMeetingBotServiceGetter(deps.getMeetingBotService as () => MeetingBotService);
  }

  // ── 8. Start bundled inbox bridge (non-fatal) ──
  try {
    const bridge = await startBundledInboxBridge();
    bridgeState = bridge;

    // Write bridge state so MCP servers can discover the port/token (separate try/catch)
    try {
      await writeRebelBridgeState(bridge);
    } catch (writeErr) {
      const error = writeErr instanceof Error ? writeErr : new Error(String(writeErr));
      log.error({ err: error }, 'Failed to write bridge state (bridge is running but MCP servers may not find it)');
      errors.push({ service: 'writeRebelBridgeState', error });
    }
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    log.error({ err: error }, 'Failed to start bundled inbox bridge');
    errors.push({ service: 'startBundledInboxBridge', error });
  }
  markStartup('bundled inbox bridge ready');

  // ── 9. Build and register MCP payloads (non-fatal) ──
  try {
    const mcpPayloads: McpServerUpsertPayload[] = [];

    // 9a. Unconditional: split Rebel MCPs + diagnostics (meetings gated behind meetingBotUnlocked)
    const unconditionalPayloads = [
      buildSplitRebelInboxPayload(),
      buildSplitRebelSearchAndConversationsPayload(),
      buildSplitRebelAutomationsPayload(),
      buildSplitRebelSpacesPayload(),
      buildSplitRebelSettingsPayload(),
      buildSplitRebelMcpConnectorsPayload(),
      buildSplitRebelPluginsPayload(),
      buildRebelDiagnosticsPayload(),
      buildRebelCanvasPayload(),
    ];
    mcpPayloads.push(...unconditionalPayloads);
    for (const payload of unconditionalPayloads) {
      mcpRegistrationStatus.registered.push(payload.name);
    }

    // 9a-meetings: Only register meeting MCP tools when feature is unlocked
    const settings = deps.getSettings();
    if (settings.meetingBotUnlocked === true) {
      mcpPayloads.push(buildSplitRebelMeetingsPayload());
      mcpRegistrationStatus.registered.push('RebelMeetings');
      log.info({ component: 'mcp-registration', name: 'RebelMeetings', status: 'registered' }, 'Meeting MCP tools registered');
    } else {
      mcpRegistrationStatus.gated.push({ id: 'RebelMeetings', code: 'feature_gate_meetingBotUnlocked' });
      log.info({ component: 'mcp-registration', name: 'RebelMeetings', status: 'gated', code: 'feature_gate_meetingBotUnlocked' }, 'Meeting MCP tools skipped (feature not unlocked)');
      // Remove stale RebelMeetings entry from a previous session where feature was enabled
      try {
        await removeMcpServerEntry(deps.routerConfigPath, 'RebelMeetings');
      } catch (err) {
        log.warn({ err }, 'Failed to remove stale RebelMeetings MCP entry (non-fatal)');
      }
    }

    // 9b. Conditional: Discourse (only if the generated script exists on disk)
    const base = deps.isPackaged ? deps.resourcesDir : path.resolve(deps.resourcesDir);
    const discourseScript = path.join(base, 'mcp-generated', 'discourse', 'server.cjs');
    if (existsSync(discourseScript)) {
      mcpPayloads.push(buildDiscoursePayload());
      mcpRegistrationStatus.registered.push('Discourse');
    } else {
      log.debug({ path: discourseScript }, 'Discourse MCP script not found — skipping');
    }

    // 9d. Single batch write
    const { count } = await upsertMcpServersBatch(deps.routerConfigPath, mcpPayloads);
    registeredMcpCount = count;
    mcpRegistrationStatus.lifecycle = 'completed';
    mcpRegistrationStatus.capturedAt = new Date().toISOString();
    log.info({ count }, 'MCP servers batch registered');
    markStartup('MCP servers batch registered');
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    mcpRegistrationStatus.lifecycle = 'failed';
    mcpRegistrationStatus.failed.push({ id: 'batch', code: 'upsert_batch_failed' });
    mcpRegistrationStatus.capturedAt = new Date().toISOString();
    log.warn({ err: error }, 'Failed to batch register MCP servers');
    errors.push({ service: 'upsertMcpServersBatch', error });
  }

  // ── 9e. Discover and register bundled OAuth MCPs from credentials on disk (non-fatal) ──
  // On cloud: picks up Google, Slack, HubSpot, Salesforce, Microsoft, Zendesk
  //   from auth relay directories (/data/google-workspace-mcp/, /data/mcp/slack/, etc.)
  // On desktop: harmless no-op (OAuth MCPs already registered via auth handlers)
  try {
    const oauthPayloads = await discoverBundledOAuthMcps(deps.userDataDir);
    if (oauthPayloads.length > 0) {
      const { count } = await upsertMcpServersBatch(deps.routerConfigPath, oauthPayloads);
      registeredMcpCount += count;
      log.info({ count }, 'Bundled OAuth MCPs registered from disk credentials');
    }
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    log.warn({ err: error }, 'Failed to register bundled OAuth MCPs from disk');
    errors.push({ service: 'discoverBundledOAuthMcps', error });
  }
  markStartup('bundled OAuth MCPs registered');

  // ── 9f. Rebel App Bridge (always-on, D19 kill-switch + R34 surface gate) ──
  //
  // The manager starts the loopback HTTP/WS server that the browser
  // extension pairs with. It's a no-op on non-desktop surfaces and when
  // `REBEL_DISABLE_APP_BRIDGE=1` is set, which keeps this harmless on
  // cloud/mobile and leaves an emergency off-switch for desktop.
  //
  // We also refresh the RebelAppBridge MCP payload *if the catalog entry
  // is already present in the router config* — i.e. the user has
  // previously enabled it via `settings:mcp-add-bundled-server`. This
  // keeps the env paths/command in sync after an app update. We never
  // auto-insert the entry: users opt in through the browser-extension
  // onboarding flow in a later stage.
  try {
    const installerService = getAppBridgeInstallerService();
    // Stage 2 (embedded chat) — owns the live SSE writer registry and
    // fans turn events out to connected extension side panels. Lives
    // one level below the intent service so the intent service can
    // attach writers and the app bridge can close-on-revoke without
    // routing through the intent service.
    conversationStreamCoordinator = createConversationStreamCoordinator({
      registry: agentTurnRegistry,
    });
    // Stage 7 — build the intent service that handles `/intent/*` calls
    // from the browser extension. The service itself is surface-agnostic
    // (it only touches broadcastService + the agent-turn registry) but
    // only makes sense on the desktop surface where the bridge is alive.
    const intentService = createAppBridgeIntentService({
      broadcast: getBroadcastService(),
      errorReporter: getErrorReporter(),
      streamCoordinator: conversationStreamCoordinator,
    });
    appBridgeManager = createAppBridgeManager({
      platformConfig: getPlatformConfig(),
      errorReporter: getErrorReporter(),
      previewMode: true,
      broadcastService: getBroadcastService(),
      installerService,
      streamCoordinator: conversationStreamCoordinator,
      intentHandlers: {
        createConversation: (req) => intentService.createConversation(req),
        injectMessage: (conversationId, req) =>
          intentService.injectMessage(conversationId, req),
        getConversationState: (conversationId) =>
          intentService.getState(conversationId),
        getMessages: (conversationId) =>
          intentService.getMessages(conversationId),
        streamConversation: (conversationId, req, res, hashedToken) =>
          intentService.streamConversation(conversationId, req, res, hashedToken),
        focusConversation: (conversationId) =>
          intentService.focusConversation(conversationId),
      },
    });
    appBridgeState = await appBridgeManager.start();
    if (appBridgeManager.listPairedClients().length > 0) {
      try {
        const detectedBrowsers = await installerService.detectBrowsers();
        await installerService.registerNmhManifests({
          detectedBrowsers,
          allowedExtensionIds: [...appBridgeManager.listPairedExtensionIds()],
        });
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        log.warn({ err: error }, 'Failed to re-register latent NMH manifests on startup');
      }
    }

    // Refresh the MCP registration if (and only if) the user has already
    // opted in. getMcpServerEntry returns null when the entry is absent.
    const existingAppBridgeEntry = await getMcpServerEntry(
      deps.routerConfigPath,
      APP_BRIDGE_SERVER_NAME,
    );
    if (existingAppBridgeEntry) {
      await upsertMcpServerEntry(deps.routerConfigPath, buildAppBridgePayload());
      log.info({ name: APP_BRIDGE_SERVER_NAME }, 'RebelAppBridge MCP registration refreshed');
    } else {
      log.debug(
        { name: APP_BRIDGE_SERVER_NAME },
        'RebelAppBridge MCP not registered — catalog entry not enabled by user',
      );
    }
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    log.error({ err: error }, 'Failed to start App Bridge');
    errors.push({ service: 'appBridgeManager', error });
  }
  markStartup('app bridge started');

  // ── 9g. Office sidecar (construct only — eager-start is deferred to createWindow) ──
  //
  // Intent Marker: As of 260502_unified_external_conversation_architecture (Stage 5),
  // the Office sidecar conversation lifecycle no longer uses a private path. It is
  // fully adapter-driven via ExternalConversationService + OfficeDocumentAdapter,
  // routed through the desktop App Bridge wrapper. The sidecar itself remains on
  // its original transport (HTTPS:52100) per R21 invariants.
  // See docs/plans/260502_unified_external_conversation_architecture.md §13 Stage 3 notes.
  try {
    officeSidecarManager = createOfficeSidecarManager({
      platformConfig: getPlatformConfig(),
      errorReporter: getErrorReporter(),
    });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    log.error({ err: error }, 'Failed to construct Office sidecar manager');
    errors.push({ service: 'officeSidecarManager', error });
  }

  // ── 10. Initialize memory update service (non-fatal) ──
  if (deps.memoryUpdateDeps) {
    try {
      initializeMemoryUpdateService(deps.memoryUpdateDeps);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      log.error({ err: error }, 'Failed to initialize memory update service');
      errors.push({ service: 'memoryUpdateService', error });
    }
  }

  // ── 11. Initialize error recovery service (non-fatal) ──
  if (deps.errorRecoveryDeps) {
    try {
      initializeErrorRecoveryService(deps.errorRecoveryDeps);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      log.error({ err: error }, 'Failed to initialize error recovery service');
      errors.push({ service: 'errorRecoveryService', error });
    }
  }

  // Hard timeout for filesystem operations that touch user workspace paths.
  // Cloud-storage FUSE mounts (Google Drive File Stream, OneDrive) can block
  // indefinitely on readdir/stat when the mount is unresponsive. The internal
  // time budget in runStartupCleanup only checks between async operations, but
  // a single hung I/O call never yields for the check. This outer timeout
  // ensures startup is never blocked by unresponsive cloud storage.
  const STARTUP_FS_HARD_TIMEOUT_MS = 5_000;
  const withStartupTimeout = <T>(promise: Promise<T>, label: string): Promise<T | 'timeout'> =>
    Promise.race([
      promise,
      new Promise<'timeout'>((resolve) =>
        setTimeout(() => {
          log.warn({ timeoutMs: STARTUP_FS_HARD_TIMEOUT_MS }, `${label} timed out (likely unresponsive cloud storage mount) — skipping`);
          resolve('timeout');
        }, STARTUP_FS_HARD_TIMEOUT_MS),
      ),
    ]);
  const startupFsSignal = AbortSignal.timeout(STARTUP_FS_HARD_TIMEOUT_MS);

  // ── 12. Space maintenance startup cleanup (desktop-only, non-fatal) ──
  // Quick pass that quarantines byte-identical `.conflict-cloud` files via
  // OS trash and advances the sync-stability journal for orphans. Time-
  // budgeted to `DEFAULT_STARTUP_TIME_BUDGET_MS` (2s) — anything remaining
  // defers to the daily automation (Stage 2). Surface-gated because
  // cloudWorkspaceSync runs from the desktop and two concurrent cleanup
  // passes on a shared-filesystem cloud-service deployment could race.
  // See docs/plans/260411_shared_space_maintenance.md (Stage 1).
  try {
    const platform = getPlatformConfig();
    if (!platform.capabilities.localFilesystemAccess) {
      log.debug({ surface: platform.surface }, 'space-maintenance: startup cleanup skipped on non-desktop surface');
    } else {
      const settings = deps.getSettings();
      if (!settings.coreDirectory) {
        log.debug('space-maintenance: startup cleanup skipped — no coreDirectory configured');
      } else {
        const maintenanceJournal = createDesktopMaintenanceJournal(deps.userDataDir);
        const maintenanceDeps = createDesktopMaintenanceDeps();
        const cleanupResult = await withStartupTimeout(
          runStartupCleanup(
            settings.coreDirectory,
            settings,
            maintenanceJournal,
            maintenanceDeps,
            { signal: startupFsSignal },
          ),
          'space-maintenance: startup cleanup',
        );
        if (cleanupResult !== 'timeout' && cleanupResult.errors.length > 0) {
          log.warn(
            { errors: cleanupResult.errors.slice(0, 5) },
            'space-maintenance: startup cleanup completed with errors',
          );
        }
      }
    }
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    log.warn({ err: error }, 'space-maintenance: startup cleanup threw unexpectedly');
    errors.push({ service: 'spaceMaintenanceStartupCleanup', error });
  }
  markStartup('space maintenance startup cleanup complete');

  // ── 13. Drive history migration (desktop-only, non-fatal) ──
  // One-shot cleanup of deprecated `<space>/.rebel/history` directories now
  // that skill history is sourced from Google Drive revisions.
  try {
    const platform = getPlatformConfig();
    if (!platform.capabilities.localFilesystemAccess) {
      log.debug({ surface: platform.surface }, 'drive-history migration skipped on non-desktop surface');
    } else {
      const settings = deps.getSettings();
      if (!settings.coreDirectory) {
        log.debug('drive-history migration skipped — no coreDirectory configured');
      } else {
        const migrationResult = await withStartupTimeout(
          runDriveHistoryMigrationFromMain(
            settings.coreDirectory,
            { signal: startupFsSignal },
          ),
          'drive-history migration',
        );
        if (migrationResult !== 'timeout' && migrationResult.errors.length > 0) {
          log.warn(
            { errors: migrationResult.errors.slice(0, 5) },
            'drive-history migration completed with errors',
          );
        }
      }
    }
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    log.warn({ err: error }, 'drive-history migration threw unexpectedly');
    errors.push({ service: 'driveHistoryMigration', error });
  }
  markStartup('drive history migration complete');

  // ── 14. Conflict-copy cleanup detection (desktop-only, non-fatal, BACKGROUND) ──
  // One-off REBEL-62A backlog cleanup (Drive/Dropbox conflict-copy fan-out).
  // The detect scan is UNCAPPED and can walk 1,300+ files, so unlike steps
  // 12/13 it is NOT awaited and NOT raced under the 5s `withStartupTimeout` —
  // it is `void`-dispatched to the background (mirrors `runSharedDriveHealthChecks`).
  // Strictly read-only: it builds a plan + a manifest and, when the first
  // affected space is found AND not yet surfaced, broadcasts the available
  // toast. The ONLY destructive move happens later via the explicit-confirm
  // `space-maintenance:cleanup-execute` IPC. See PLAN.md Safety Contract §1/§11.
  try {
    const platform = getPlatformConfig();
    if (!platform.capabilities.localFilesystemAccess) {
      log.debug({ surface: platform.surface }, 'conflict-copy cleanup detection skipped on non-desktop surface');
    } else {
      const settings = deps.getSettings();
      if (!settings.coreDirectory) {
        log.debug('conflict-copy cleanup detection skipped — no coreDirectory configured');
      } else {
        const coreDirectory = settings.coreDirectory;
        // NOT awaited and NOT inside withStartupTimeout — uncapped bg scan.
        void scheduleConflictCopyCleanupDetection(coreDirectory).catch((err) => {
          log.warn({ err }, 'conflict-copy cleanup detection threw (non-fatal)');
        });
      }
    }
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    log.warn({ err: error }, 'conflict-copy cleanup detection scheduling threw unexpectedly');
    errors.push({ service: 'conflictCopyCleanupDetection', error });
  }
  markStartup('conflict-copy cleanup detection scheduled');

  markStartup('coreStartup complete');

  if (errors.length > 0) {
    log.warn({ errorCount: errors.length }, 'Core startup completed with non-fatal errors');
  } else {
    log.info('Core startup completed successfully');
  }

  return {
    bridgeState,
    registeredMcpCount,
    errors,
    appBridgeManager,
    appBridgeState,
    officeSidecarManager,
    conversationStreamCoordinator,
  };
}
