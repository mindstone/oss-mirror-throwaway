/**
 * Electron entrypoint that keeps desktop-only wiring in one place so core
 * business logic remains portable across desktop, cloud, and mobile surfaces.
 *
 * @see ../../docs/project/REBEL_CORE.md — runtime architecture and boundaries
 * @see ../../docs/project/ARCHITECTURE_AGENT_TURN_EXECUTION.md — turn lifecycle
 * @see ../../docs/project/ARCHITECTURE_OVERVIEW.md — cross-process system map
 */
import { app, BrowserWindow, dialog, ipcMain, shell, globalShortcut, nativeImage, powerMonitor, protocol, Menu, utilityProcess, session } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import { Readable } from 'node:stream';
import { createRequire } from 'node:module';
import { createScopedLogger, logger, cleanupSessionLogs, SESSION_LOG_DEFAULTS } from '@core/logger';
import {
  buildConnectorConfigLogPayload,
  describeMissingOAuthCredentials,
  getConnectorConfigState,
} from '@core/services/oauthConnectorSetup';
import { fireAndForget } from '@shared/utils/fireAndForget';
// Imported at top (not mid-file) because withSingleSyncRetryOnEmfile is used in
// the setStoreFactory wiring near the top of this module.
import { isTooManyOpenFilesError, withSingleSyncRetryOnEmfile } from '@core/utils/emfileRetry';

// =============================================================================
// STARTUP HANDLERS
// =============================================================================
// NOTE: Early startup gating (userData/test isolation, Squirrel events,
// single-instance lock) runs in src/main/bootstrap.ts.
import './startup/ensureAppIdentity';
import './startup/ensureTestUserData';
import { runKlavisMigration } from './startup/klavisMigration';
import { runCostLedgerAuthMigration } from './startup/costLedgerAuthMigration';
import {
  createDeepLinkHandler,
  DEEP_LINK_PROTOCOL,
  NAV_DEEP_LINK_PROTOCOL,
} from './startup/deepLinkHandler';
import { createMainWindowFactory } from './startup/mainWindowFactory';
import { cloudConnectionReconciler } from './services/cloud/cloudConnectionReconcilerSingleton';
import {
  forceRefreshCodexAccessToken,
  getCodexAccessToken,
  getCodexAccountId,
  isCodexConnected,
} from '@core/services/codexAuthCore';
import { DEFAULT_CODEX_AUTH_PROVIDER } from '@core/services/defaultCodexAuthProvider';
import { codexTokenEvents, type CodexTokens } from '@core/services/codexTokenStorage';
import { cleanupExpiredCache as cleanupExpiredAttachmentCache } from './services/attachmentCacheService';
import { getRebelMediaMimeType, parseRebelMediaRange, buildRebelMediaResponseInit } from './services/rebelMediaProtocol';
import { cleanupTempAttachments } from '@core/services/attachmentTempService';
import { cleanupPreviewTempFiles } from './ipc/mcpAppsHandlers';
import { cleanupOldTranscripts } from '@core/services/transcriptService';
import { removeLegacyFiles } from '@core/services/cloudDataHygieneService';
import { pruneStaleApprovals } from '@main/services/safety/pendingApprovalsStore';

import Store from 'electron-store';
import {
  getWorkingModelProfile,
  type AgentEvent,
  type AppSettings,
  type AgentSession,
  type RendererLogPayload,
  type InboxState,
} from '@shared/types';
import { allChannels } from '@shared/ipc/contracts';
import { normalizeSettings } from '@shared/utils/settingsUtils';
import { getSettings, getDiagnosticsSnapshot, updateSettings, settingsStore, ensureNormalizedSettings, getSettingsNormalizationStats, getSettingsNormalizationWindowedStats, migrateOnboardingTimestampIfNeeded, migrateLocalModelProfilesIfNeeded, migrateCloudInstanceFieldsIfNeeded, backfillCloudInstanceProviderIdIfNeeded, migrateOAuthTimestampIfNeeded, detectMeetingBotUsageFromHistory, runCodexProviderHealAtBoot } from './settingsStore';
import { setSettingsStoreAdapter } from '@core/services/settingsStore';
import { setStoreFactory } from '@core/storeFactory';
import { setSchedulerFactory } from '@core/scheduler';
import { setSecureTokenStoreFactory } from '@core/secureTokenStore';
import { setWorkspaceFileSystemFactory } from '@core/workspaceFileSystem';
import { setProcessSpawnerFactory } from '@core/processSpawner';
import { setPushNotificationSinkFactory } from '@core/pushNotificationSink';
import { setPowerSaveBlockerFactory } from '@core/powerSaveBlocker';
import { setPreTurnWorkerFactory } from '@core/preTurnWorker';
import { setCurrentUserProviderFactory } from '@core/currentUserProvider';
import { setEmbeddingGeneratorFactory } from '@core/embeddingGenerator';
import { setDockBadgeFactory } from '@core/dockBadge';
import { setDesktopNotificationSinkFactory } from '@core/desktopNotificationSink';
import { handleRebelAssetProtocol } from './services/rebelAssetProtocol';
import { getRebelHtmlCsp } from './services/rebelHtmlCsp';
import { getHtmlPreviewTrustService } from '@core/services/htmlPreviewTrustService';
import { setCodexAuthProvider, getCodexAuthProvider } from '@core/codexAuth';
import { hasManagedOpenRouterKey } from './services/openRouterTokenStorage';
import { getRebelAuthProvider, setRebelAuthProvider } from '@core/rebelAuth';
import { setMeetingBotBackendConfigProvider } from '@core/services/meetingBotBackendConfig';
import { setOAuthCredentialsProvider } from '@core/services/oauthCredentials';
import { setTokenSyncCoordinator } from '@core/setTokenSyncCoordinator';
import { setTokenSyncTransport } from '@core/setTokenSyncTransport';
import { setCrossProcessLease } from '@core/setCrossProcessLease';
import { setOAuthToolResolver } from '@core/setOAuthToolResolver';
import { TokenSyncCoordinator } from '@core/services/tokenSync/TokenSyncCoordinator';
import type { KeyValueStore } from '@core/store';
import { migrateLearnedLimitsIfNeeded } from '@core/rebelCore/learnedLimitsMigration';
import { resolveProviderBasePath } from '@shared/authRelayConfig';
import { ElectronSecureTokenStore } from './services/secureTokenStore/electronSecureTokenStore';
import { ElectronWorkspaceFileSystem } from './services/workspaceFileSystem/electronWorkspaceFileSystem';
import { workspaceStartupRecoveryDescriptor } from './services/workspace/workspaceStartupRecovery';
import { MainProcessSpawner } from './services/mcp/mcpSubprocessAdapter';
import { NoOpPushNotificationSink } from './services/pushNotificationSink/noOpPushNotificationSink';
import { ElectronScheduler } from './services/scheduler/electronScheduler';
import { ElectronPowerSaveBlocker } from './services/powerSaveBlocker/electronPowerSaveBlocker';
import { ElectronPreTurnWorker } from './services/preTurnWorker/electronPreTurnWorker';
import { ElectronEmbeddingGenerator } from './services/embedding/electronEmbeddingGenerator';
import { ElectronDockBadge } from './services/dockBadge/electronDockBadge';
import { ElectronDesktopNotificationSink } from './services/desktopNotification/electronDesktopNotificationSink';
import { setNotificationWindowTarget } from './services/desktopNotification/notificationClickIntent';
import { DesktopOAuthToolResolver } from './services/oauthToolResolverImpl';
import { DesktopFileLockLease } from './services/crossProcessLeaseImpl';
import { DesktopTokenSyncTransport } from './services/cloud/tokenSyncTransportImpl';
import {
  LIVE_AUTH_PROVIDER,
  LIVE_CURRENT_USER_PROVIDER_FACTORY,
  LIVE_MEETING_BOT_BACKEND_CONFIG_PROVIDER,
  LIVE_OAUTH_CREDENTIALS_PROVIDER,
  PRIVATE_MINDSTONE_BOOTSTRAP_BUNDLE_MARKER,
  PRIVATE_MINDSTONE_BOOTSTRAP_MODE,
  registerPrivateMindstoneHandlers,
  registerPrivateMindstoneHealthCheck,
} from '@private/mindstone/bootstrap';
import { setAuthHealthCheck } from './services/health/authHealthCheckRegistry';

// Wire the Electron-backed settings store into the core adapter so @core
// modules can access settings without depending on electron-store.
//
// `updateSettingsAtomic` runs the read+write synchronously (Node single-thread)
// so two callers can safely race their functional updaters; whichever commits
// last sees the prior caller's diff via `getSettings()`. When `options.sync`
// is set, the resulting settings doc is also pushed to the user's cloud
// instance via `cloudRouter.forward('settings:update', ...)` — fire-and-forget;
// failures are logged but do NOT bubble to the caller (the local write
// already succeeded).
//
// See docs/plans/260503_unify_learned_limits_into_profiles.md — Auto-Create
// Policy → Storage boundary (Findings Q, R).
setSettingsStoreAdapter({
  getSettings,
  updateSettings,
  updateSettingsAtomic: (updater, options) => {
    const current = getSettings();
    const partial = updater(current);
    if (Object.keys(partial).length === 0) return;
    updateSettings(partial);

    if (options?.sync) {
      import('./services/cloud/cloudRouter').then(({ cloudRouter }) => {
        cloudRouter.forward('settings:update', [getSettings()])
          .then((result) => {
            if (
              result &&
              typeof result === 'object' &&
              'error' in result &&
              (result as { error?: unknown }).error
            ) {
              logger.warn(
                { error: (result as { error: unknown }).error, channel: 'settings:update' },
                'updateSettingsAtomic: cloud forward returned error result; local write succeeded',
              );
            }
          })
          .catch((err: unknown) => {
            logger.warn(
              { err, channel: 'settings:update' },
              'updateSettingsAtomic: cloud sync threw; local write succeeded',
            );
          });
      }).catch((err: unknown) => {
        logger.warn({ err }, 'updateSettingsAtomic: cloudRouter import failed; local write succeeded');
      });
    }
  },
  onSettingsChange: (callback) => {
    if (settingsStore.onDidAnyChange) {
      return settingsStore.onDidAnyChange((newSettings) => {
        if (newSettings) callback(newSettings);
      });
    }
    return () => {};
  }
});

// Wire the StoreFactory so @core modules can create stores without electron-store.
// Centralizes the ESM/CJS interop guard that many individual stores duplicate.
const ElectronStoreConstructor: typeof Store = typeof Store === 'function' ? Store : (Store as unknown as { default: typeof Store }).default;
setStoreFactory(<T extends Record<string, unknown>>(opts: { name: string; defaults?: T; [k: string]: unknown }) => {
  // electron-store/conf reads the backing JSON file SYNCHRONOUSLY in its
  // constructor (conf `get store()` → fs.readFileSync) — a path graceful-fs does
  // NOT cover. Under FD pressure this is the dominant EMFILE source (it backs all
  // ~68 createStore() consumers: analytics, session-coaching, codex tokens,
  // meeting-bot, …). One sync retry absorbs a transient EMFILE between attempts.
  // (The post-construction gateStoreWrites proxy already covers reads/writes; this
  // closes the construction-read gap.) REBEL-1C8/5CZ/5D1 class.
  const s = withSingleSyncRetryOnEmfile(() =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ESM/CJS boundary: StoreFactory opts shape doesn't exactly match electron-store Options<T>
    new ElectronStoreConstructor<T>(opts as any),
  );
  return s as unknown as KeyValueStore<T>;
});
setSchedulerFactory(() => new ElectronScheduler());
setSecureTokenStoreFactory(() => new ElectronSecureTokenStore());
setWorkspaceFileSystemFactory(() => new ElectronWorkspaceFileSystem());
setProcessSpawnerFactory(() => new MainProcessSpawner());
setPushNotificationSinkFactory(() => new NoOpPushNotificationSink());
setPowerSaveBlockerFactory(() => new ElectronPowerSaveBlocker());
setPreTurnWorkerFactory(() => new ElectronPreTurnWorker());
setCurrentUserProviderFactory(LIVE_CURRENT_USER_PROVIDER_FACTORY);
setEmbeddingGeneratorFactory(() => new ElectronEmbeddingGenerator());
setDockBadgeFactory(() => new ElectronDockBadge());
setDesktopNotificationSinkFactory(() => new ElectronDesktopNotificationSink());

setCodexAuthProvider(DEFAULT_CODEX_AUTH_PROVIDER);
logger.info(
  {
    mode: PRIVATE_MINDSTONE_BOOTSTRAP_MODE,
    kind: 'config-source-of-truth',
    marker: PRIVATE_MINDSTONE_BOOTSTRAP_BUNDLE_MARKER,
  },
  'private-mindstone bootstrap mode',
);
setRebelAuthProvider(LIVE_AUTH_PROVIDER);
// Inject the OAuth client-credentials fallback. Commercial builds register real creds
// (via @private/mindstone); OSS registers the empty stub (broken-by-default). Env vars
// still take precedence in the resolver. Registered here at module-init — before
// app.whenReady() and before any (lazy) connector resolution — so no consumer can race it.
setOAuthCredentialsProvider(LIVE_OAUTH_CREDENTIALS_PROVIDER);
setMeetingBotBackendConfigProvider(LIVE_MEETING_BOT_BACKEND_CONFIG_PROVIDER);
// OSS-only: emit one structured, secret-free startup line enumerating which OAuth connectors
// have client credentials configured vs broken-by-default, plus a pointer to the setup guide.
// Helps source/CLI operators self-diagnose and makes bug reports actionable. Commercial builds
// must NOT log this — gate on the same OSS signal `useIsOssBuild` reads (AuthConfigPresence.
// isOssBuild), which OSS_NULL_AUTH_PROVIDER reports synchronously at module-init. Booleans/status
// strings only — no credential values — and emitted exactly once here (not per connect attempt).
if (LIVE_AUTH_PROVIDER.getCachedAuthConfig()?.isOssBuild === true) {
  logger.info(
    buildConnectorConfigLogPayload(getConnectorConfigState()),
    'OSS build: OAuth connector credential status (set <PROVIDER>_CLIENT_ID/SECRET to enable; see setup guide)',
  );
}
registerPrivateMindstoneHealthCheck({
  registerAuthHealthCheck: setAuthHealthCheck,
});
const stage1CrossProcessLease = new DesktopFileLockLease();
const stage1OAuthToolResolver = new DesktopOAuthToolResolver();
const stage2TokenSyncTransport = new DesktopTokenSyncTransport({
  getCloudConnection: () => {
    const cloudInstance = getSettings().cloudInstance;
    if (!cloudInstance?.cloudUrl || !cloudInstance?.cloudToken) return null;
    return {
      cloudUrl: cloudInstance.cloudUrl,
      cloudToken: cloudInstance.cloudToken,
    };
  },
});
const TOKEN_SYNC_PROVIDER_TO_RELAY_PROVIDER = {
  google: 'google-workspace',
  slack: 'slack',
  hubspot: 'hubspot',
  microsoft: 'microsoft',
} as const;
const stage2TokenSyncCoordinator = new TokenSyncCoordinator({
  surface: 'desktop',
  transport: stage2TokenSyncTransport,
  lease: stage1CrossProcessLease,
  logger: createScopedLogger({ service: 'token-sync-coordinator' }),
  tokenRootResolver: (provider) => {
    const relayProvider =
      TOKEN_SYNC_PROVIDER_TO_RELAY_PROVIDER[
        provider as keyof typeof TOKEN_SYNC_PROVIDER_TO_RELAY_PROVIDER
      ];
    if (!relayProvider) return '';
    return resolveProviderBasePath(relayProvider, getDataPath(), '');
  },
});

setTokenSyncCoordinator(stage2TokenSyncCoordinator);
setTokenSyncTransport(stage2TokenSyncTransport);
setCrossProcessLease(stage1CrossProcessLease);
setOAuthToolResolver(stage1OAuthToolResolver);

// Desktop → cloud Codex token sync. After any local token mutation (login,
// refresh, logout), push the latest state to the user's cloud instance so
// ChatGPT Pro works for mobile / web sessions too. Fire-and-forget: the
// cloudRouter is lazy-loaded to avoid pulling `ws` into the critical startup
// path, and failures are swallowed (logged) so a cloud outage never breaks
// desktop auth. Initial reconnect/syncNow also re-push current state.
codexTokenEvents.on('changed', (tokens: CodexTokens | null) => {
  import('./services/cloud/cloudRouter').then(({ cloudRouter }) => {
    cloudRouter.pushCodexTokens(tokens, { source: 'mutation' }).catch(() => {
      // Already logged inside pushCodexTokens; swallow to keep auth flow clean.
    });
  }).catch(() => {
    // Cloud router unavailable (e.g. very early startup). Reconnect hook
    // will re-push current state when cloud mode is ready.
  });
});

import {
  type VersionedData,
  type MigrationFn
} from './utils/storeMigration';
import {
  AGENT_SESSION_HISTORY_VERSION,
} from './constants';
import {
  registerLocalTranscriber,
  setCodexVoiceConfig,
  setLocalTranscriber,
} from '@core/services/audioService';
import {
  resolveMcpConfigPath,
  reconfigureSuperMcpWithCacheRefreshDetached,
} from './services/mcpService';
import type { OperatorRegistry } from '@core/services/operatorRegistry';
import * as operatorRegistry from '@core/services/operatorRegistry';
import { resolveMeetingCoachPrompt } from './services/meetingCoachPromptResolver';
import { registerHubSpotApiAuthOrchestrator } from './services/hubspotAuthOrchestrator';
import { registerGoogleWorkspaceApiAuthOrchestrator } from './services/googleWorkspaceAuthOrchestrator';
import { registerMicrosoftApiAuthOrchestrator } from './services/microsoftAuthOrchestrator';
import { registerSlackApiAuthOrchestrator } from './services/slackAuthOrchestrator';
import { resolveConnectorCatalogForMain } from './services/connectorCatalogResolver';
import { identifyUserFromAuthState } from './services/userProfileService';
import {
  ensureRouterConfigFile,
  cleanupStaleInstancesArray,
  backfillCatalogIds,
  repairBundledMcpScriptPaths,
  reconcileBundledMcpScriptPaths,
  reconcileNpxPackageVersions,
  reconcileHttpUrls,
  upsertMcpServerEntry,
  removeMcpServerEntry,
} from './services/mcpConfigManager';
import { superMcpHttpManager, setTestIsolation } from './services/superMcpHttpManager';
import { localSttModelManager } from './services/localSttModelManager';

import { workspaceWatcherService } from './services/workspaceWatcherService';
import { libraryBroadcaster } from './services/libraryBroadcaster';
import { startPluginWatcherSubscriber } from './services/pluginWatcherSubscriber';
import { agentTurnRegistry } from './services/agentTurnRegistry';
import { dispatchAgentEvent } from './services/agentEventDispatcher';
import { initTurnCheckpointManager } from '@core/services/turnCheckpointService';
import type { EventWindow } from '@core/types';

import { executeAgentTurn } from './services/agentTurnExecutor';
import { derivePolicy } from '@core/services/turnPolicy';
import { runRecoveryPipeline } from '@core/services/recovery/recoveryPipeline';
import type { AgentLoopOptions } from '@core/services/recovery/recoveryAdapter';
import type { RecoveryContext, RecoveryPhase } from '@core/services/recovery/recoveryStateMachine';
import { createDesktopRecoveryAdapter } from './services/recovery/desktopRecoveryAdapter';
import { getIncrementalSessionStore, INDEX_VERSION } from './services/incrementalSessionStore';
import type { SessionsSyncUpsertOutcome } from './services/incrementalSessionStore';
import { checkAndUpdateVersionMarker } from './services/versionMarker';
import { startPerfDiagnostic, type PerfDiagnosticHandle } from './services/perfDiagnosticService';
import { wireSuperMcpTelemetry } from './services/superMcpTelemetryAdapter';
import { cacheRendererPerfSummary } from './services/rendererPerfMonitorService';
import { cacheRendererSnapshot } from './services/ramTelemetryService';
import {
  startEventLoopLagMonitor,
  type EventLoopLagMonitor,
} from '@core/services/eventLoopLagService';
import {
  markSessionTurnsAsCompleted,
  onInboxStateChange
} from './services/inboxStore';
import { applyInterruptedTurnCorrection } from '@core/services/sessionTurnRecovery';
import { onUserTasksStateChange } from './services/userTasksStore';
import {
  migrateLegacyWrapperSettingsIfNeeded,
  migrateRebelTaskQueueToInbox,
  migrateToRebelInternal,
  migrateRebelInternalToSplit,
  migrateRebelSearchToRebelSearchAndConversations,
  migrateBundledConnectorsToNpx,
  pruneStaleHubSpotRefreshEnv,
  repairBridgeStatePathLiterals,
  configureBundledMcpManager,
  setConnectorCatalogPathOverride,
} from './services/bundledMcpManager';
import { backfillCatalogEnvForExistingServers } from './services/catalogEnvBackfillMigration';
import { migrateStaleGitHubTokens } from './services/githubAuthService';
import { initCliRuntime, parseCliFlagsBeforeRuntime, runCli } from './cli';
import { createHeadlessRuntime } from '@core/services/headlessRuntime';

import { isPlaudConnected } from './services/plaud';
import { initializePlaudSyncService, startPeriodicSync as startPlaudPeriodicSync } from './services/plaud';

import { initCoreServices } from './services/coreStartup';
import { AutomationScheduler } from './services/automationScheduler';
import { InboundTriggerService } from './services/inboundTriggers/inboundTriggerService';
import { SlackMentionAdapter } from './services/inboundTriggers/slackMentionAdapter';
import { ElectronSlackPollGate } from './services/inboundTriggers/electronSlackPollGate';
import type { InboundTriggerSafetyHook } from './services/inboundTriggers/types';
import { createExternalConversationService, type ExternalConversationService } from '@core/services/externalConversation/externalConversationService';
import { SlackThreadAdapter, type SlackWorkspaceStoreLike } from '@core/services/externalConversation/adapters/slackThreadAdapter';
import { conversationScopeResolver } from '@core/services/externalConversation/conversationScopeResolver';
import { setAutomationStoreGetter } from './services/safety/automationContextLookup';
import { onTranscriptSaved, onTranscriptDistributionReady, type TranscriptSavedEvent, type TranscriptDistributionReadyEvent } from './services/meetingBot/transcriptEventBus';
import { CommunityHighlightsService } from './services/communityHighlightsService';
import { generatePersonalizedUseCases, initializeUseCaseGeneratorService, initializeUseCaseLibrary } from './services/useCaseGeneratorService';
import { syncSystemSettingsIfNeeded, createLibrarySymlink, createAgentsMdSymlink, createClaudeMdSymlink } from './services/systemSettingsSync';
import { ensureChiefOfStaffSpace, migrateAllLegacyAgentsMd, cleanupMemoryTrustFromAllSpaces, resolveViaSpaceName, getScanSpacesCounters, getScanSpacesWindowedCounters, invalidateSpaceScanCache, clearAllSpaceScanCaches } from './services/spaceService';
import { startWatching as startFileWatching, registerAtlasWorkspaceCallback, getIndexerStats } from './services/fileWatcherService';
import { preloadIndexMetadata, removeFileFromIndex as removeFileFromLanceDbIndex, removeFilesFromIndex as removeFilesFromLanceDbIndex } from './services/fileIndexService';
// Removal Coordinator (Stage 4a) wiring — the real store removers injected at startup.
import {
  configureIndexRemovalCoordinator,
  configureIndexRemovalReprobeHook,
} from './services/indexRemovalCoordinator';
import { removeSource as removeSourceFromIndex, isSourcePath as isSourceMetadataPath } from './services/sourceMetadataStore';
import { removeEntity as removeEntityFromIndex } from './services/entityMetadataStore';
import { setAtlasWorkspace } from './services/atlasService';
import { startupScheduler } from './services/startupScheduler';
import { reportUncleanShutdownIfNeeded } from './services/crashRecoveryService';
import { scheduleUserDataBackupOnStartup } from '@core/services/userDataBackupService';
import { preloadEmbeddingModel, getEmbeddingLifecycleStats } from './services/embeddingService';
import { initBatteryScheduler, createPausableInterval } from './services/visibilityAwareScheduler';
import {
  initializeConversationIndex,
  backfillConversationEmbeddings,
  reconcileEmbeddings,
  deduplicateConversationIndex,
  migrateSearchText,
  closeConversationIndex,
  onSessionsSaved
} from './services/conversationIndexService';
import { validateAndRecoverIndices, type IndexHealthReport } from './services/indexHealthService';

import { createMemoryWriteHook, createMcpDenyHook } from './services/safety';
import { migrateLegacyStagedFiles } from './services/safety/cosPendingService';
import {
  resolveActiveWorkingSingleModelAuxiliaryTurnOverrides,
  resolveAuxiliaryTurnModelOverrides,
} from '@shared/utils/auxiliaryTurnConfig';
import { resolveMemoryBtsTurnOverride } from '@shared/utils/memoryBtsTurnOverride';
import {
  addMemoryHistoryEntries,
  backfillFromSessions,
  isBackfillCompleted,
  getMemoryHistoryEntry,
  removeMemoryHistoryEntry
} from './services/memoryHistoryStore';
import {
  initializeTimeSavedService,
} from './services/timeSavedService';
import { sessionCoachingScheduler, extractSkillsUsed } from './services/sessionCoachingScheduler';
import { initializeHeroChoiceScheduler, shutdownHeroChoiceScheduler } from './services/heroChoiceScheduler';
import { initializeDailySparkScheduler, shutdownDailySparkScheduler } from './services/dailySparkScheduler';
import { getPastCandidates as getHeroChoicePastCandidates } from '@core/services/heroChoiceStore';
import { getFormatFeedback as getDailySparkFormatFeedback } from '@core/services/dailySparkStore';
import { getAllUseCases as getHeroChoiceUseCases } from './services/useCaseLibraryStore';
import { getCachedMeetings as getHeroChoiceMeetings } from './services/meetingCacheStore';
import { isSkillUsageBackfillCompleted, backfillSkillUsageFromSessions } from './services/skillUsageStore';
import { refreshVideoRecommendations } from '@core/services/communityVideoRecsService';
import { fetchCommunityVideos } from '@core/services/communityVideoRecsApiClient';
import { getWeekTopSessions } from '@core/services/timeSavedStore';
import { getFrequentTools } from '@core/services/toolUsageStore';
import { getFrequentSkills } from '@core/services/skillUsageStore';
import { getAllUseCases as getVideoRecsUseCases } from './services/useCaseLibraryStore';

import {
  isDemoModeActive,
  cleanupOrphanedDemoDirs,
  cleanupMarkedDemoDirs
} from './services/demoModeService';
import { isRebelTestMode, isE2eTestMode, getSuperMcpDir, isHeadlessCli } from './utils/testIsolation';

// Wire test isolation into the core superMcpHttpManager so it can redirect
// Super-MCP data directories during E2E tests without importing electron deps.
setTestIsolation({ isE2eTestMode, getSuperMcpDir });

// Cloud mode services
import { cloudRouter } from './services/cloud/cloudRouter';
import { cloudTokenRelay } from './services/cloud/cloudTokenRelay';
// SUNSET: Remove after 2026-10-01 (NSIS migration complete)
import { scheduleSquirrelCleanup } from './services/squirrelCleanupService';
import {
  setupNodeEnvironment,
  setupGitEnvironment,
  getUsername
} from './utils/systemUtils';
import { broadcastToAllWindows } from './utils/broadcastHelpers';
import {
  maybeSurfaceFdExhaustionWarning,
  broadcastDiagnosticsUpdate,
  disableExpiredDebugBreadcrumbs,
  scheduleDiagnosticsExpiry,
  isDiagnosticsBroadcastPending,
} from './diagnostics/mainDiagnostics';
import {
  getOrGenerateAnonymousId,
  trackMainEvent,
  identifyMainUser,
  analyticsClientAvailable,
  initAnalytics,
  setAnalyticsContextProvider
} from './analytics';
import { buildDesktopAnalyticsContext } from '@shared/trackingTypes';
import { initializeHealthContextUpdater, startSuperMcpWithRetries } from './services/systemHealthService';
import { initializeToolIndex, refreshToolIndex } from './services/toolIndexService';
import { mainTracking } from './tracking';
import { captureMainException, captureMainMessage, initMainSentry, setSentryUser, isMainSentryEnabled } from './sentry';
import {
  shouldCaptureProcessGone,
  shouldCaptureChildProcessGoneThrottled,
  toTelemetrySafeUrl,
} from './utils/processGoneCapture';
import { safeLog } from './safeLog';
import type { Breadcrumb, CaptureContext } from '@sentry/core';
import { loadRuntimeConfig, getRuntimeConfigForRenderer } from './runtimeConfig';
import { getTelemetryConfigForRenderer } from './telemetryConfig';
import {
  registerLibraryHandlers,
  registerSettingsHandlers,
  registerAppHandlers,
  registerEmergencyHandlers,
  registerExportHandlers,
  registerMigrationHandlers,
  registerVoiceHandlers,
  registerAgentHandlers,
  registerAgentErrorHandlers,
  registerPermissionsHandlers,
  registerSessionsHandlers,
  registerTasksHandlers,
  registerAutomationsHandlers,
  registerDemoHandlers,
  registerDashboardHandlers,
  bumpAtlasNeighborhoodGeneration,
  registerSearchHandlers,
  registerSystemHandlers,
  registerMiscHandlers,
  registerMemoryHandlers,
  registerScratchpadHandlers,
  registerGoogleWorkspaceHandlers,
  cleanupLegacyGoogleWorkspaceEntry,
  registerSlackHandlers,
  registerGitHubHandlers,
  registerCodexHandlers,
  registerSubscriptionHandlers,
  registerIdentityHandlers,
  registerOpenRouterHandlers,
  registerHubSpotHandlers,
  registerSalesforceHandlers,
  registerMicrosoftHandlers,
  cleanupLegacyMicrosoftEntries,
  registerZendeskHandlers,
  registerDiscourseHandlers,
  registerUsageHandlers,
  registerCommunityHandlers,
  registerSafetyHandlers,
  registerSafetyPromptHandlers,
  registerSafetyActivityLogHandlers,
  registerSkillsHandlers,
  registerOperatorsHandlers,
  registerFeedbackHandlers,
  registerDiagnosticsHandlers,
  registerHtmlPreviewTrustHandlers,
  registerPluginHandlers,
  registerFileConversationHandlers,
  registerUserTasksHandlers,
  registerTodoistHandlers,
  registerMeetingBotHandlers,
  registerUseCaseLibraryHandlers,
  registerCalendarHandlers,
  registerSpaceMaintenanceHandlers,
  registerErrorRecoveryHandlers,
  registerLocalSttHandlers,
  registerLocalInferenceHandlers,
  registerPhysicalRecordingHandlers,
  registerQuickCaptureHandlers,
  registerQuickCaptureQuitHandler,
  registerPlaudHandlers,
  registerMcpAppsHandlers,
  registerVersionHandlers,
  registerCloudHandlers,
  registerInboundTriggerHandlers,
  registerBugReportHandlers,
  registerSystemImprovementHandlers,
  registerHeroChoiceHandlers,
  registerDailySparkHandlers,
  registerCommunityEventsHandlers,
  registerCommunityVideoRecsHandlers,
  bootstrapVideoRecommendations,
  registerFocusHandlers,
  registerFoldersHandlers,
  registerContributionHandlers,
  registerAppBridgeHandlers,
  registerOfficeSidecarHandlers,
} from './ipc';
import { createMeetingBotService, getActiveBotState } from './services/meetingBot/meetingBotService';
import { getPendingTranscripts } from './services/meetingBot/pendingTranscriptsStore';
import { initializeDesktopSdk, setMeetingNotificationWindowTarget, shutdownDesktopSdk, startCalendarPreviewTimer } from './services/meetingBot/desktopSdkService';
import { registerQuitHandler as registerLocalRecordingQuitHandler, resumePendingLocalUploads } from './services/meetingBot/localRecordingService';
import { getActiveMeetingForCoaching } from './services/meetingBot/activeMeetingSession';
import { registerCloudProvisioningQuitHandler } from './services/cloudProvisioningQuitGuard';
import { initializePhysicalRecording } from './services/physicalRecording';
import { startExternalProviderPolling, stopExternalProviderPolling } from './services/meetingBot/externalProviders';
import { initializeMeetingAnalysisService } from './services/meetingBot/meetingAnalysisService';
import { cleanupOldEntries } from './services/physicalRecording/pendingPhysicalRecordingsStore';
import { initializeBotQAService, getTranscriptBuffer, queueExternalContribution, isKnowledgeAccessEnabled, checkAndExpireStalePending } from './services/meetingBot/botQAService';
import { getConversationState, initializeConversationStateService } from './services/meetingBot/conversationStateService';
import { initializeLiveCoachService, updateLiveCoachMeetingContext, startProactiveTimer, reportContributionOutcome, handleHighSignalUtterance } from './services/liveCoachService';
import { initializeCalendarSyncService, syncCalendarCache } from './services/calendarSyncService';
import { startDirectCalendarSync } from './services/calendarSyncScheduler';
import { resolveOAuthCredentials, googleCredentialSource } from './services/oauthCredentials';
import { startGoogleAuth } from './services/googleWorkspaceAuthService';
import { generateInstanceId, buildGoogleWorkspaceInstancePayload, type GoogleWorkspaceInstanceConfig } from './services/bundledMcpManager';

const _moduleRequire = createRequire(import.meta.url);
const MAIN_DIR = path.dirname(fileURLToPath(import.meta.url));
const _StoreConstructor: typeof Store = typeof Store === 'function' ? Store : (Store as unknown as { default: typeof Store }).default;

// Wire atlas↔fileWatcher callback to break circular dependency.
registerAtlasWorkspaceCallback((workspacePath) => {
  setAtlasWorkspace(workspacePath);
  bumpAtlasNeighborhoodGeneration();
});

// Wire the Removal Coordinator (Stage 4a) — the one door through which an index
// entry is removed from all three stores. Done at module scope (before any watcher
// activity) so a removal never hits the inert no-op default (which would silently
// under-delete). The coordinator stays unit-testable via its injection seam; this
// is the desktop wiring (cloud/headless leave the no-op default, where there is no
// file watcher anyway).
configureIndexRemovalCoordinator({
  removeSource: removeSourceFromIndex,
  isSourcePath: isSourceMetadataPath,
  removeEntity: removeEntityFromIndex,
  removeFileFromIndex: removeFileFromLanceDbIndex,
  removeFilesFromIndex: removeFilesFromLanceDbIndex,
});

// Enable remote debugging if REMOTE_DEBUGGING_PORT is set
// This must be called before app.on('ready') to take effect
// Used by MCP testing tools to interact with the app via CDP
if (process.env.REMOTE_DEBUGGING_PORT) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.REMOTE_DEBUGGING_PORT);
  app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
}

// Prevent Chromium from throttling hidden windows (GPU worker)
// Required for reliable WebGPU initialization on Windows (Electron #44880)
// Only needed on Windows - macOS/Linux WebGPU works without these flags,
// and disabling throttling causes WindowServer memory accumulation on macOS
// See: docs/research/260126_WEBGPU_WINDOWS_DECISION_TREE.md
if (process.platform === 'win32') {
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-background-timer-throttling');
}

// Workaround for historical stream-close race conditions with parallel agent turns
// Increases stream timeout from 60s to 5min to prevent "Stream closed" errors
// when running multiple agent sessions concurrently with MCP servers
process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT = '300000';

// Register rebel-media:// as a privileged scheme for video streaming
// Must be called synchronously before app.on('ready')
// These privileges make the scheme work like https:// for media loading
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'rebel-media',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true
    }
  },
  // Register rebel-tutorial:// for serving HTML tutorials from rebel-system/help-for-humans/
  // Needs supportFetchAPI for Chromium to load content in iframes via protocol.handle()
  {
    scheme: 'rebel-tutorial',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true
    }
  },
  // Register rebel-html:// for previewing workspace HTML files in sandboxed iframes
  // Separate from rebel-tutorial to maintain security boundary (tutorials are trusted, workspace files are not)
  {
    scheme: 'rebel-html',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true
    }
  },
  // Register rebel-preview:// for serving agent-built app previews from registered folders
  // Token-rooted URLs (rebel-preview:///<previewId>/<path>) prevent general file serving
  {
    scheme: 'rebel-preview',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true
    }
  },
  // Register rebel-asset:// for serving session-scoped image assets (Stage 3 architecture)
  {
    scheme: 'rebel-asset',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      // NO corsEnabled - matches rebel-preview; CORS not needed for <img>
      // NO stream - these are images, not video
    }
  }
]);

// =============================================================================
// Auto-Update Services
// =============================================================================
import {
  initAutoUpdater,
  peekWatchdogTelemetry,
  consumeWatchdogTelemetry,
  silentAutoHealStuckInstall,
} from './services/autoUpdateService';
import { initLinuxUpdater } from './services/linuxUpdateService';
import { getUpdateInstallMarker, clearUpdateInstallMarker } from './services/updateInstallMarker';
import { getAutoUpdateState, updateAutoUpdateStateChecked } from './services/autoUpdateStateStore';
import {
  handleInstallMarkerStartupReconciliation,
  shouldClearStaleStuckInstall,
} from './services/installCompletionReconciliation';

// Initialize Sentry + analytics BEFORE the install-completion reconciliation
// so `silentAutoHealStuckInstall` can emit `'Auto-Update Silent Auto-Heal
// Triggered'` and (60s later) `'Auto-Update Recovery Stranded'` against a
// live analytics client. Without this, both events fire when
// `analyticsClient === null` and are silently dropped — the same class of
// silent failure the install-completion contract (commit `f9adb3848`) was
// originally meant to fix (planning doc `260428_install_completion_contract.md`
// critique C9 anticipated this; the rearchitecture in REBEL-53B replaced the
// queue mechanism with direct emits, so init order is now load-bearing).
//
// Both `initMainSentry()` and `initAnalytics()` are safe to run here:
//   - `setStoreFactory()` (line ~55) is the only ordering prerequisite for
//     `initAnalytics()` and is wired far earlier.
//   - `initMainSentry()` has no auto-update dependency and benefits from
//     earlier coverage of any startup-time errors.
initMainSentry();
initAnalytics();

// REBEL-53B migration (one-time at startup): clear regression artifacts
// left by `f9adb3848`. Before reconciliation runs, drop any stale
// `stuckInstall` record with `targetVersion === '(unknown)'` (the marker
// of the false-positive class), provided the user has clearly moved on
// (no current marker AND not on the from-version anymore). Also drop
// `pendingStuckInstallEvents` entries with the same tell — analytics for
// them is misleading. Failures are best-effort.
//
// See docs-private/investigations/260429_rebel_53b_stuck_install_false_positive.md.
try {
  const preState = getAutoUpdateState();
  const currentVersion = app.getVersion();
  const hasMarker = getUpdateInstallMarker() != null;
  const shouldClearStale = shouldClearStaleStuckInstall({
    state: preState,
    currentVersion,
    hasMarker,
  });

  const taintedQueue = (preState.pendingStuckInstallEvents ?? []).filter(
    (ev) => ev.targetVersion === '(unknown)',
  );

  if (shouldClearStale || taintedQueue.length > 0) {
    const partial: Record<string, unknown> = {};
    if (shouldClearStale) {
      partial.stuckInstall = null;
    }
    if (taintedQueue.length > 0) {
      partial.pendingStuckInstallEvents = (preState.pendingStuckInstallEvents ?? []).filter(
        (ev) => ev.targetVersion !== '(unknown)',
      );
    }
    const result = updateAutoUpdateStateChecked(partial);
    if (result.ok) {
      logger.info(
        {
          clearedStale: shouldClearStale,
          droppedQueueEntries: taintedQueue.length,
          currentVersion,
        },
        '[UPDATE] Cleared stale (unknown)-targetVersion stuckInstall (REBEL-53B regression self-heal)',
      );
    } else {
      logger.warn(
        { err: result.error },
        '[UPDATE] REBEL-53B migration write failed (best-effort, will retry next launch)',
      );
    }
  }
} catch (err) {
  logger.warn({ err }, '[UPDATE] REBEL-53B migration threw (non-fatal)');
}

// Detect stuck updates at startup (BEFORE initAutoUpdater so the silent
// auto-heal can interleave with the normal update lifecycle). The injected
// deps keep the service unit-testable without importing electron.
import { appendDiagnosticEvent } from '@core/services/diagnosticEventsLedger';
const _isHeadlessForReconciliation = isHeadlessCli();
const updateMarkerStatus = handleInstallMarkerStartupReconciliation({
  currentVersion: app.getVersion(),
  platform: process.platform as 'darwin' | 'win32' | 'linux',
  isHeadless: _isHeadlessForReconciliation,
  getMarker: getUpdateInstallMarker,
  clearMarker: clearUpdateInstallMarker,
  getState: getAutoUpdateState,
  setStateChecked: updateAutoUpdateStateChecked,
  getWatchdogTelemetry: peekWatchdogTelemetry,
  consumeWatchdogTelemetry,
  triggerSilentAutoHeal: (updateKey: string) => {
    // Fire-and-forget. silentAutoHealStuckInstall logs failures internally.
    void silentAutoHealStuckInstall(updateKey).catch((err) => {
      logger.warn({ err, updateKey }, '[UPDATE] silentAutoHealStuckInstall promise rejected');
    });
  },
  emitDiagnosticEvent: (transition) => {
    appendDiagnosticEvent({
      kind: 'auto_update_state_change',
      data: {
        transition,
        platform: process.platform as 'darwin' | 'win32' | 'linux',
      },
    });
  },
  logger,
});
if (updateMarkerStatus === 'applied') {
  logger.info(
    { currentVersion: app.getVersion() },
    '[UPDATE] Update successfully applied since last launch',
  );
}

// Detect duplicate / translocated app bundles, which silently break Squirrel.Mac
// auto-update (the "update won't install / I'm stuck on an old version" pattern).
// Warn-only: logs + Sentry + a persisted diagnostic + a one-time native dialog;
// never deletes/moves bundles or changes the update flow. Invoked inside
// whenReady AFTER the relocation offer (below) so the two never race a dialog.
import {
  runAppInstallIntegrityCheck,
  presentDuplicateBundleWarningIfNeeded,
} from './services/appInstallIntegrityService';
// Root-cause prevention: offer to move into /Applications when launched from
// elsewhere (translocation / DMG / Downloads), which is what makes Squirrel.Mac
// updates fail. Awaited at the top of whenReady (a successful move relaunches).
import { maybeOfferMoveToApplications } from './services/appRelocationService';

initAutoUpdater();
initLinuxUpdater();

// initMainSentry() + initAnalytics() are now called BEFORE the
// install-completion reconciliation block above so the silent auto-heal
// path can emit analytics events successfully.

// Wire core boundary interfaces now that platform modules are initialized.
import { setErrorReporter } from '@core/errorReporter';
import { setFeedbackReporter } from '@core/feedbackReporter';
import { setTracker } from '@core/tracking';
import { setBroadcastService, getBroadcastService } from '@core/broadcastService';
import { getHandlerRegistry, setHandlerRegistry, type HandlerInvokeContext } from '@core/handlerRegistry';
import { setSafetyEvaluationService } from '@core/safetyEvaluationService';
import { setBuiltinPluginService } from '@core/rebelCore/pluginServiceProvider';
import type { PluginService, PluginSummary } from '@core/rebelCore/types';
import { runSafetyPromptMigration, applyReadOnlyAccessPatch, applyDestructiveWordingPatch } from '@core/safetyPromptMigration';
import { loadPersistedPluginEntries, deleteSinglePlugin } from './services/pluginFilePersistence';
import { invalidatePermissionCache, getIsKnownPluginCounters, clearPluginIdentityCache } from './ipc/plugins/shared';
import { getScanSpacePluginsCounters, getScanSpacePluginsWindowedCounters } from './services/pluginSpaceService';
import { clearPluginStorage, backupPluginData } from '@core/services/pluginStorageStore';
import { removeActivatedPluginId, removeDeactivatedPluginId, addDeactivatedPluginId, addPendingReviewPluginId, removePendingReviewPluginId, isPluginActivated } from '@core/services/pluginActivationStore';
import { requestsElevatedPermission } from './ipc/plugins/shared';
import { setPluginDataBackend } from '@core/services/pluginDataBackend';
import { PluginDataFileBackend } from './services/pluginDataFileBackend';
import { setCloudLivenessProbe } from '@core/services/cloudLivenessProbe';
import {
  CloudLivenessProbeService,
  computeCloudIndexingCoverage,
  deriveCloudPrewarmTargets,
} from './services/cloudLivenessProbeService';
import { setWorkspaceFsExecutor } from '@core/services/boundedWorkspaceFs';
import { CloudFsExecutorService } from './services/cloudFsExecutorService';
import { configureCloudSpaceContainment } from '@core/services/cloudSpaceContainment';
import { setCloudSymlinkIndexingEnabled, isCloudSymlinkIndexingEnabled } from '@core/services/cloudSymlinkIndexing';
import {
  createCloudPeriodicRewalkScheduler,
  CLOUD_PERIODIC_REWALK_INTERVAL_MS,
  type CloudPeriodicRewalkScheduler,
} from './services/cloudPeriodicRewalkService';
import { discoverWorkspaceNow } from './services/fileWatcherService';

/**
 * Stage 7 — after a cloudSymlinkIndexing flag FLIP-ON, how long to wait before a
 * second (deferred) watcher rebuild, so the freshly-fired off-thread probes have
 * settled a verdict (a healthy probe is sub-ms; the prober's 200ms parent timeout
 * bounds a dead mount). This admits a space whose verdict was `unknown` at flip
 * time without waiting for a natural rebuild trigger (a cold `unknown→healthy`
 * settle is intentionally NOT a recovery, so it would not otherwise rebuild).
 */
const CLOUD_FLAG_FLIP_PROBE_SETTLE_MS = 1_500;
/**
 * Delay before the one-shot cloud-indexing COVERAGE check (postmortem #3
 * observability). Comfortably past the 8s cold-start prewarm + a settle window so a
 * `shouldAlert` snapshot means "warm-up finished and the user's cloud Spaces still
 * aren't indexable", not "probes haven't landed yet".
 */
const CLOUD_INDEXING_COVERAGE_CHECK_MS = 30_000;
import { getDataPath } from '@core/utils/dataPaths';
import { createSessionLockManager, defaultIsProcessAlive } from '@core/utils/sessionFileLock';
import { upsertSessionsWithLocks, upsertSessionsWithLocksSync } from '@core/services/lockedSessionPersistence';
import { ElectronHandlerRegistry } from './ipc/utils/ElectronHandlerRegistry';
import { startLatencyFlushInterval, stopLatencyTracker } from './ipc/utils/ipcLatencyTracker';
import { markStartup, logWaterfall } from './services/startupWaterfallService';
import { initRendererProfiler, stopRendererProfiler } from './services/rendererProfilerService';
import { initRendererHeapSnapshotService } from './services/rendererHeapSnapshotService';
import { generateBestEffort } from './services/perfSummaryService';
import { createBtsSafetyEvalService } from './services/safety/btsSafetyEvalService';
import { createConflictCapabilityService } from '@core/services/safety/conflictCapabilityService';
import { createIpcDedupService } from '@core/services/safety/ipcDedupService';
import { requestPluginCompileAndRegister } from './services/pluginCompileBridge';
import type { PluginManifestIpc, PluginPermissionIpc } from '@shared/ipc/schemas/plugins';
import {
  assertHandlerPresence,
  getHandlerPresenceMode,
  isCiEnvironment,
} from './ipc/handlerPresenceInvariant';
import { AgentSessionSchema } from '@shared/ipc/schemas/agent';
import { observingSafeParse } from '@shared/ipc/schemas/utils/observingSafeParse';
import { z } from 'zod';
import { recordMainBreadcrumb } from './sentry';
import * as SentryElectronMain from '@sentry/electron/main';
import { createDesktopFeedbackReporter } from './sentryFeedbackReporter';
import { getErrorReporter } from '@core/errorReporter';
import { installGracefulFsObservability, tagFsExhaustion } from '@core/utils/gracefulFsObservability';

setErrorReporter({
  captureException: (err, ctx) => captureMainException(err, ctx as unknown as CaptureContext),
  captureMessage: (msg, ctx) => captureMainMessage(msg, ctx),
  addBreadcrumb: (bc) => recordMainBreadcrumb(bc as Breadcrumb),
  captureExceptionWithScope: (error, mutate) => {
    // OSS no-phone-home gate: respect the OSS-aware initialized Sentry state
    // (matching how captureMainException guards internally), so this secondary
    // capture path never egresses in OSS-off. Enterprise is unchanged.
    if (!isMainSentryEnabled()) {
      return;
    }
    SentryElectronMain.withScope((scope) => {
      try { mutate(scope); } catch { /* never fail capture on tag errors */ }
      SentryElectronMain.captureException(error);
    });
  },
});
setFeedbackReporter(createDesktopFeedbackReporter());

// graceful-fs queue observability — drains bootstrap install-failure stash
// and starts the high-frequency queue sampler. The cleanup fn is invoked
// from the existing `app.on('will-quit')` handler at the bottom of this
// file. See docs/plans/260428_graceful_fs_emfile_fix.md Stage 3.
const _stopGracefulFsObservability = installGracefulFsObservability(getErrorReporter(), {
  surface: 'desktop_main',
});
setAnalyticsContextProvider(() => {
  const authConfig = getRebelAuthProvider().getCachedAuthConfig();
  const companyName = settingsStore.store.companyName ?? authConfig?.companyDisplayName ?? null;
  // The non-colliding cross-surface tag (`client_surface: 'desktop'`) and the
  // attribution/licenseTier shape live in the pure `buildDesktopAnalyticsContext`
  // helper so the desktop invariant is unit-testable without the Electron main
  // graph; cloud sets `client_surface: 'cloud'` in cloud-service/src/bootstrap.ts.
  return buildDesktopAnalyticsContext({
    companyName,
    source: settingsStore.store.companyName
      ? 'settings.companyName'
      : (authConfig?.companyDisplayName ? 'authConfig.companyDisplayName' : null),
    licenseTier: authConfig?.licenseTier ?? 'free',
  });
});
setTracker({
  track: (event, props) => trackMainEvent({
    anonymousId: getOrGenerateAnonymousId(),
    event,
    properties: props as Parameters<typeof trackMainEvent>[0]['properties'],
  }),
  identify: (userId, traits) => identifyMainUser({
    anonymousId: getOrGenerateAnonymousId(),
    userId,
    traits: traits as Parameters<typeof identifyMainUser>[0]['traits'],
  }),
  getAnonymousId: () => getOrGenerateAnonymousId(),
  isAvailable: () => analyticsClientAvailable(),
});
setBroadcastService({
  sendToAllWindows: (channel: string, ...args: unknown[]) => {
    // eslint-disable-next-line no-restricted-syntax -- window-scan-send-allowlisted: canonical BroadcastService implementation for genuine all-window emits; do not migrate until service backend changes.
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
        try {
          win.webContents.send(channel, ...args);
        } catch (err) {
          // F-R3-5: Log per-window failures instead of silently swallowing.
          // Render frame can be disposed after long inactivity (OS App Nap).
          // The window/webContents appear alive but the frame is gone.
          logger.debug({ event: 'broadcast.per-window-send-failed', channel, windowId: win.id, error: (err as Error).message }, 'Per-window broadcast send failed');
        }
      }
    }
  },
  sendToFocusedWindow: (channel: string, ...args: unknown[]) => {
    const win = BrowserWindow.getFocusedWindow();
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      try {
        win.webContents.send(channel, ...args);
      } catch {
        // Render frame disposed — see sendToAllWindows comment.
      }
    }
  },
});
setHandlerRegistry(new ElectronHandlerRegistry());

// Wire the diagnostic-events ledger writer/reader. Must run AFTER setStoreFactory
// (which lives further up) so getDataPath() is resolvable. Done before service
// startup so any cooldown/advisory/known-condition events emitted during boot
// are persisted instead of dropped.
import { setDiagnosticEventsLedgerReader, setDiagnosticEventsLedgerWriter, setDiagnosticEventsSurface } from '@core/services/diagnosticEventsLedger';
import { desktopDiagnosticEventsLedgerReader, desktopDiagnosticEventsLedgerWriter } from './services/diagnosticEventsLedgerWriter';
import { startApprovalStuckDiagnosticTick } from './services/safety/pendingApprovalsDiagnosticTick';
setDiagnosticEventsLedgerWriter(desktopDiagnosticEventsLedgerWriter);
setDiagnosticEventsLedgerReader(desktopDiagnosticEventsLedgerReader);
setDiagnosticEventsSurface('desktop');

// Stage 1b.2: periodic approval-queue inspection. Emits approval_stuck on
// each (approvalId, ageBucket) transition so post-incident bundles surface
// "this request has been waiting hours" without polling raw store dumps.
startApprovalStuckDiagnosticTick();

setSafetyEvaluationService(createBtsSafetyEvalService());
const pluginDataBackend = new PluginDataFileBackend();
pluginDataBackend.setScopeResolver(async (pluginId) => {
  // Check manifest for storageScope — try local persisted first, then Space-scanned
  let storageScope: string | undefined;
  let spacePluginPath: string | undefined;

  const persisted = await loadPersistedPluginEntries();
  const entry = persisted.find((e) => e.manifest.id === pluginId);
  if (entry) {
    const persistedManifest = entry.manifest as typeof entry.manifest & { storageScope?: string };
    storageScope = persistedManifest.storageScope;
  }

  // Also check Space-scanned plugins (the plugin may only exist in a Space)
  const { scanSpacePlugins } = await import('./services/pluginSpaceService');
  const { plugins: spacePlugins } = await scanSpacePlugins();
  const spacePlugin = spacePlugins.find((p) => p.pluginId === pluginId);
  if (spacePlugin) {
    spacePluginPath = spacePlugin.spacePath;
    // Space manifest takes precedence for storageScope (it's the canonical source)
    const spaceManifest = spacePlugin.manifest as typeof spacePlugin.manifest & { storageScope?: string };
    if (spaceManifest.storageScope) {
      storageScope = spaceManifest.storageScope;
    }
  }

  if (storageScope === 'shared') {
    if (spacePluginPath) {
      return { scope: 'shared', dataDir: path.join(spacePluginPath, 'plugins', pluginId) };
    }
    // Plugin claims shared but isn't in a Space — fail-closed (don't silently route to local)
    logger.warn({ pluginId }, 'Plugin declares storageScope: shared but is not in a Space — rejecting');
    throw new Error(`Plugin "${pluginId}" declares storageScope: shared but is not in a Space`);
  }

  return { scope: 'local', dataDir: path.join(getDataPath(), 'plugin-data', pluginId) };
});
setPluginDataBackend(pluginDataBackend);

// Wire the desktop cloud-liveness prober (Stage 2, 260619_cloud-symlink-indexing).
// Gated on utilityProcess availability (mirrors preTurnWorkerService): on
// cloud/headless there's no FUSE mount, so the Stage-1 `unknown` no-op default
// stays installed → callers exclude + retain (correct, nothing to probe). The
// service spawns its child LAZILY on first probeHealth, so this registration is
// inert until Stage 4+ actually probes. STILL UNWIRED from descent/purge.
//
// Stage 3: retain the concrete instance so `app.on('will-quit')` can call its
// `dispose()` (the makeTotal wrapper installed by setCloudLivenessProbe does NOT
// expose dispose — we must hold the real instance), and so cold-start prewarm can
// populate the verdict cache within one launch (DA-2).
let cloudLivenessProbeService: CloudLivenessProbeService | null = null;
// SYNTHESIS S4.3: periodic re-walk scheduler (260619_cloud-symlink-indexing).
// Constructed below alongside the prober (desktop only), started after boot beside
// cold-start prewarm, disposed in will-quit. Inert with the admission flag off (the
// tick re-reads `isEnabled()` first). Retained at module scope so start()/dispose()
// can reach the instance constructed inside the `if (utilityProcess)` block.
let cloudPeriodicRewalkScheduler: CloudPeriodicRewalkScheduler | null = null;
// SYNTHESIS S2: the bounded workspace-fs boundary's CLOUD-lane executor — a small
// killable child-process fs pool. Retained so will-quit can dispose it. Wired only
// when utilityProcess is available (desktop); cloud/mobile keep the fail-closed no-op
// default (every cloud op → reconnecting). Inert until the boundary routes a cloud
// path through it (S3 migrates consumers).
let cloudFsExecutorService: CloudFsExecutorService | null = null;
if (utilityProcess) {
  cloudFsExecutorService = new CloudFsExecutorService();
  setWorkspaceFsExecutor(cloudFsExecutorService);

  cloudLivenessProbeService = new CloudLivenessProbeService();
  setCloudLivenessProbe(cloudLivenessProbeService);
  // Stage 4c (R5): wire the unlink-storm / stale-healthy re-probe hook to the
  // concrete probe's `invalidateVerdict` (the makeTotal wrapper from
  // setCloudLivenessProbe doesn't expose it). When the coordinator freezes cloud
  // removals on a storm, this forces a fresh off-thread verdict before the next
  // removal can purge. Capture the instance in a const so the closure doesn't
  // depend on the mutable module-level let.
  const probeForReprobe = cloudLivenessProbeService;
  configureIndexRemovalReprobeHook((verdictKey) => probeForReprobe.invalidateVerdict(verdictKey));

  // S4.2 (260619_cloud-symlink-indexing): the legacy prober recovery/degrade
  // watcher-rebuild consumer (createCloudWatcherRebuildScheduler + onRecovery/
  // onDegraded + restartCurrent) is RETIRED. Cloud is never live-watched anymore
  // (the live-watch admission override is gone — DROP-3), so there is no admitted
  // cloud subtree to retract on a degrade, and recovery re-indexing is now driven by
  // the periodic re-walk scheduler below (probe all targets each tick; re-walk when
  // any is healthy). The unlink-storm reprobe hook above (invalidateVerdict) stays.

  // SYNTHESIS S4.3 (260619_cloud-symlink-indexing) — the periodic re-walk scheduler.
  // Runs ALONGSIDE the legacy prober machinery above during the S4.3→S4.2 window
  // (R3: S4.3 is purely additive; S4.2 then atomically deletes the legacy backoff +
  // recovery path). Each tick (flag-gated, R6): probe ALL known cloud targets for
  // SETTLED verdicts (R1), and if any is healthy, drive ONE coalesced forced re-walk
  // (R2: discoverWorkspaceNow — a non-clearing discovery pass that bypasses the
  // startup skip heuristic, NOT reindexWorkspace(false) which would commonly skip
  // discovery). Target enumeration reuses the readlink-only, FS-free
  // deriveCloudPrewarmTargets (R4); it reads CURRENT settings each tick so a flag
  // flip / space change is picked up without restarting the timer.
  cloudPeriodicRewalkScheduler = createCloudPeriodicRewalkScheduler({
    isEnabled: isCloudSymlinkIndexingEnabled,
    getCloudTargets: () => {
      const coreDirectory = settingsStore.store.coreDirectory;
      // No workspace root configured ⇒ no cloud targets (and never touch the FS).
      if (!coreDirectory) return [];
      return deriveCloudPrewarmTargets(coreDirectory, settingsStore.store.spaces);
    },
    probeHealth: (target) => probeForReprobe.probeHealth(target),
    rewalk: () => discoverWorkspaceNow(),
    intervalMs: CLOUD_PERIODIC_REWALK_INTERVAL_MS,
  });
} else {
  logger.info('Cloud liveness prober not wired: utilityProcess unavailable (keeping no-op default)');
}

const toolCreatedPluginSummaries = new Map<string, PluginSummary>();
const lastRegisteredSources = new Map<string, string>();

/**
 * Persist a plugin's files to every Space that currently holds it, falling back
 * to Chief-of-Staff for net-new plugins.
 *
 * Why: `createOrUpdate` historically wrote ONLY to Chief-of-Staff. After a
 * plugin is copied/moved to a Space (e.g. General), an update would land in CoS
 * and silently miss the live Space file the runtime actually loads — the
 * functional bug behind the plugin-overhaul work. We resolve the plugin's
 * current location(s) via `scanSpacePlugins` and write to all of them so the
 * same plugin id never splits between a fresh CoS copy and a stale Space copy.
 *
 * Failure policy (deliberately conservative pending a tested decision): the
 * in-memory compile+register has already succeeded by the time this runs, so a
 * disk-write failure is logged per-location rather than thrown. Promoting this
 * to a hard tool-call failure is tracked as a follow-up (it interacts with the
 * already-registered in-memory state and the bridge's 500 path).
 *
 * See docs/plans/260527_plugin_agent_experience_overhaul.md — Stage 1B.
 */
async function writePluginToCurrentLocations(
  finalManifest: Record<string, unknown>,
  source: string,
): Promise<void> {
  const { scanSpacePlugins, writePluginToSpace, getChiefOfStaffPath } = await import(
    './services/pluginSpaceService'
  );
  const pluginId = String(finalManifest.id);

  let targetSpacePaths: string[] = [];
  try {
    const { plugins } = await scanSpacePlugins();
    targetSpacePaths = [
      ...new Set(plugins.filter((p) => p.pluginId === pluginId).map((p) => p.spacePath)),
    ];
  } catch (err) {
    logger.warn(
      { pluginId, err },
      'Failed to scan Spaces for current plugin locations — falling back to Chief-of-Staff',
    );
  }

  // Net-new plugin (not yet in any Space) → create in Chief-of-Staff.
  if (targetSpacePaths.length === 0) {
    const chiefPath = await getChiefOfStaffPath();
    if (chiefPath) {
      targetSpacePaths = [chiefPath];
    }
  }

  for (const spacePath of targetSpacePaths) {
    try {
      const writeResult = await writePluginToSpace(finalManifest, source, spacePath);
      if (!writeResult.ok) {
        logger.warn(
          { pluginId, spacePath, error: writeResult.error },
          'Failed to persist plugin to a current location',
        );
      }
    } catch (err) {
      logger.warn({ pluginId, spacePath, err }, 'Failed to persist plugin to a current location');
    }
  }
}

const pluginService: PluginService = {
  createOrUpdate: async (manifest, source) => {
    // Preserve existing manifest fields (e.g., forkedFrom, permissions, externalDomains) when updating a plugin.
    // For permissions/externalDomains the `undefined` vs `[]` distinction is security-critical:
    //   - `undefined` on the incoming manifest means "not specified, preserve existing"
    //   - any array (including `[]`) means "explicitly set to this value"
    let existingForkedFrom: string | undefined;
    let existingPermissions: string[] | undefined;
    let existingExternalDomains: string[] | undefined;
    let existingRole: 'hero' | 'utility' | undefined;
    let foundInPersistedEntries = false;
    for (const p of await loadPersistedPluginEntries()) {
      const persistedManifest = p.manifest as typeof p.manifest & {
        forkedFrom?: string;
        permissions?: string[];
        externalDomains?: string[];
        role?: 'hero' | 'utility';
      };
      if (persistedManifest.id === manifest.id) {
        foundInPersistedEntries = true;
        if (persistedManifest.forkedFrom) existingForkedFrom = persistedManifest.forkedFrom;
        if (persistedManifest.permissions !== undefined) existingPermissions = persistedManifest.permissions;
        if (persistedManifest.externalDomains !== undefined) existingExternalDomains = persistedManifest.externalDomains;
        if (persistedManifest.role !== undefined) existingRole = persistedManifest.role;
        break;
      }
    }
    const manifestWithExtras = manifest as typeof manifest & {
      forkedFrom?: string;
      role?: 'hero' | 'utility';
    };

    // Resolve permissions/externalDomains/role using the same preserve-on-undefined pattern as forkedFrom.
    const resolvedPermissions = manifest.permissions !== undefined
      ? manifest.permissions
      : existingPermissions;
    const resolvedExternalDomains = manifest.externalDomains !== undefined
      ? manifest.externalDomains
      : existingExternalDomains;
    const resolvedRole = manifestWithExtras.role !== undefined
      ? manifestWithExtras.role
      : existingRole;

    const finalManifest = {
      id: manifest.id,
      name: manifest.name,
      ...(manifest.description ? { description: manifest.description } : {}),
      ...(manifest.documentation ? { documentation: manifest.documentation } : {}),
      ...(manifestWithExtras.forkedFrom || existingForkedFrom
        ? { forkedFrom: manifestWithExtras.forkedFrom || existingForkedFrom }
        : {}),
      version: manifest.version ?? '0.1.0',
      entryPoint: 'index.tsx',
      maturity: 'labs' as const,
      role: resolvedRole ?? 'utility' as const,
      ...(manifest.createdBy ? { createdBy: manifest.createdBy } : {}),
      ...(manifest.changelog ? { changelog: manifest.changelog } : {}),
      ...(manifest.contributors ? { contributors: manifest.contributors } : {}),
      // Cast from string[] → PluginPermissionIpc[]: the renderer Zod schema
      // (PluginManifestIpcSchema) validates enum membership at the IPC boundary,
      // so any invalid permission string fails fast there rather than silently.
      ...(resolvedPermissions !== undefined && { permissions: resolvedPermissions as PluginPermissionIpc[] }),
      ...(resolvedExternalDomains !== undefined && { externalDomains: resolvedExternalDomains }),
    };

    // Observable logging when plugin has non-default (non-empty) permissions declared.
    if (finalManifest.permissions && finalManifest.permissions.length > 0) {
      logger.info(
        {
          pluginId: finalManifest.id,
          permissions: finalManifest.permissions,
          externalDomains: finalManifest.externalDomains,
        },
        'plugin created/updated with declared permissions',
      );
    }

    // Stage 3A — gate elevated-permission tool-created plugins behind explicit
    // user security review. A brand-new plugin that requests anything beyond the
    // standard read set (external-fetch, conversations:write/transcript,
    // skills:write, automations:create, inbox:write) must be approved by the user
    // before it goes live — this stops a prompt-injected agent from silently
    // shipping an exfiltrating plugin that auto-runs on the user's machine.
    //
    // Read-only plugins keep auto-registering (no added friction). We gate ONLY
    // brand-new plugins: an update to a plugin the user already trusts (persisted,
    // tool-created-live this session, or store-activated) is NOT gated, so we
    // never surprise-disable a running plugin. (Permission escalation on an
    // existing plugin is a separately-tracked follow-up — it needs last-approved-
    // permission tracking; the Stage 1C LLM safety prompt still sees the call.)
    //
    // Approval happens through the existing PluginSecurityDialog via the
    // Settings → Plugins enable flow: we persist the plugin to disk so it appears
    // as an inactive catalog entry, and mark it deactivated so Chief-of-Staff
    // auto-activation cannot bypass the gate. See plan 260527 — Stage 3A.
    const isExistingPlugin =
      foundInPersistedEntries ||
      toolCreatedPluginSummaries.has(manifest.id) ||
      isPluginActivated(manifest.id);
    if (requestsElevatedPermission(resolvedPermissions) && !isExistingPlugin) {
      logger.info(
        { pluginId: manifest.id, permissions: resolvedPermissions },
        'Plugin requests elevated permissions and is new — staging for user security review instead of auto-activating',
      );
      try {
        await writePluginToCurrentLocations(finalManifest, source);
      } catch (err) {
        logger.warn({ pluginId: manifest.id, err }, 'Failed to persist plugin pending security review');
        return { ok: false, errors: [{ type: 'runtime', message: 'Failed to save the plugin for review.' }] };
      }
      // Mark deactivated so neither Chief-of-Staff auto-activation nor a stale
      // activation record registers it live before the user reviews it. Also
      // flag pending-review so the catalog row shows a "Needs review" affordance
      // (distinct from a user-disabled plugin). Both are cleared when the user
      // enables it via the security dialog (addActivatedPluginId clears them).
      addDeactivatedPluginId(manifest.id);
      addPendingReviewPluginId(manifest.id);
      return { ok: true, pendingSecurityReview: true };
    }

    // Backup plugin data before update (failure must not block the update)
    try {
      await backupPluginData(manifest.id);
    } catch (err) {
      logger.warn({ pluginId: manifest.id, err }, 'Failed to backup plugin data before update');
    }

    const result = await requestPluginCompileAndRegister({
      manifest: finalManifest,
      source,
    });

    if (result.ok) {
      toolCreatedPluginSummaries.set(manifest.id, {
        id: manifest.id,
        name: manifest.name,
        ...(manifest.description ? { description: manifest.description } : {}),
      });
      lastRegisteredSources.set(manifest.id, source);

      // Persist to every Space the plugin currently lives in (falling back to
      // Chief-of-Staff for net-new plugins). Writing only to CoS would leave a
      // Space-resident plugin's live file stale on update. See plan 260527 — Stage 1B.
      await writePluginToCurrentLocations(finalManifest, source);
    }

    return result;
  },

  list: async () => {
    const summaries = new Map<string, PluginSummary>();

    // Local file-persisted plugins (fallback/cache)
    for (const plugin of await loadPersistedPluginEntries()) {
      if (plugin.manifest.id.startsWith('__')) {
        continue;
      }
      summaries.set(plugin.manifest.id, {
        id: plugin.manifest.id,
        name: plugin.manifest.name,
        ...(plugin.manifest.description ? { description: plugin.manifest.description } : {}),
      });
    }

    // Space-discovered plugins
    try {
      const { scanSpacePlugins } = await import('./services/pluginSpaceService');
      const { plugins } = await scanSpacePlugins();
      for (const plugin of plugins) {
        if (!plugin.pluginId.startsWith('__')) {
          summaries.set(plugin.pluginId, {
            id: plugin.pluginId,
            name: plugin.manifest.name,
            ...(plugin.manifest.description ? { description: plugin.manifest.description } : {}),
          });
        }
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to scan Space plugins for list');
    }

    for (const [id, summary] of toolCreatedPluginSummaries) {
      summaries.set(id, summary);
    }

    return Array.from(summaries.values()).sort((a, b) => a.name.localeCompare(b.name));
  },

  getSource: async (id: string) => {
    // Check local file persistence first (fast path)
    for (const plugin of await loadPersistedPluginEntries()) {
      if (plugin.manifest.id === id) {
        return {
          ok: true as const,
          source: plugin.source,
          manifest: {
            id: plugin.manifest.id,
            name: plugin.manifest.name,
            ...(plugin.manifest.description ? { description: plugin.manifest.description } : {}),
          },
          ...(plugin.manifest.documentation ? { documentation: plugin.manifest.documentation } : {}),
          ...(plugin.manifest.version ? { version: plugin.manifest.version } : {}),
          ...(plugin.manifest.changelog ? { changelog: plugin.manifest.changelog } : {}),
        };
      }
    }

    // Fall back to Space-scanned plugins
    try {
      const { scanSpacePlugins } = await import('./services/pluginSpaceService');
      const { plugins } = await scanSpacePlugins();
      const spacePlugin = plugins.find((p) => p.pluginId === id);
      if (spacePlugin) {
        return {
          ok: true as const,
          source: spacePlugin.source,
          manifest: {
            id: spacePlugin.pluginId,
            name: spacePlugin.manifest.name,
            ...(spacePlugin.manifest.description ? { description: spacePlugin.manifest.description } : {}),
          },
          ...(spacePlugin.manifest.documentation ? { documentation: spacePlugin.manifest.documentation } : {}),
          ...(spacePlugin.manifest.version ? { version: spacePlugin.manifest.version } : {}),
          ...(spacePlugin.manifest.changelog ? { changelog: spacePlugin.manifest.changelog } : {}),
        };
      }
    } catch (err) {
      logger.warn({ pluginId: id, err }, 'Failed to scan Space plugins for getSource');
    }

    return { ok: false as const, error: `Plugin "${id}" not found` };
  },

  delete: async (id: string) => {
    const foundInStore = (await loadPersistedPluginEntries()).some(p => p.manifest.id === id);
    const foundInMemory = toolCreatedPluginSummaries.has(id);

    // Also check Space-scanned plugins
    let foundInSpace = false;
    try {
      const { scanSpacePlugins } = await import('./services/pluginSpaceService');
      const { plugins } = await scanSpacePlugins();
      foundInSpace = plugins.some((p) => p.pluginId === id);
    } catch {
      // Space scan failed — proceed with store/memory check
    }

    if (!foundInStore && !foundInMemory && !foundInSpace) {
      return { ok: false as const, error: `Plugin "${id}" not found` };
    }

    toolCreatedPluginSummaries.delete(id);
    lastRegisteredSources.delete(id);

    // Clean up plugin storage data and activation records BEFORE deleting files.
    // This must happen first because clearPluginStorage (via IPC) calls isKnownPlugin()
    // which rejects unknown plugins. Once files are deleted, the plugin becomes unknown.
    try {
      await clearPluginStorage(id);
    } catch (err) {
      logger.warn({ pluginId: id, err }, 'Failed to clear plugin storage during delete');
    }
    try {
      removeActivatedPluginId(id);
      removeDeactivatedPluginId(id);
      removePendingReviewPluginId(id);
    } catch (err) {
      logger.warn({ pluginId: id, err }, 'Failed to clear plugin activation records during delete');
    }

    // Delete from Chief-of-Staff folder if present
    try {
      const { getChiefOfStaffPath, deletePluginFromSpace } = await import('./services/pluginSpaceService');
      const chiefPath = await getChiefOfStaffPath();
      if (chiefPath) {
        await deletePluginFromSpace(id, chiefPath);
      }
    } catch (err) {
      logger.warn({ pluginId: id, err }, 'Failed to delete plugin from Chief-of-Staff');
    }

    // Clean up persisted plugin file
    try {
      await deleteSinglePlugin(id);
      invalidatePermissionCache();
    } catch (err) {
      logger.warn({ pluginId: id, err }, 'Failed to clean up persisted plugin file');
    }

    broadcastToAllWindows('plugins:unregister', id);
    return { ok: true as const };
  },

  open: async (id: string, params?: Record<string, string>) => {
    let diskManifest: PluginManifestIpc | undefined;
    let diskSource: string | undefined;
    for (const plugin of await loadPersistedPluginEntries()) {
      if (plugin.manifest.id === id) {
        diskManifest = plugin.manifest;
        diskSource = plugin.source;
        break;
      }
    }

    if (diskManifest && diskSource !== undefined) {
      const lastSource = lastRegisteredSources.get(id);

      if (lastSource !== diskSource) {
        let reRegistered = false;
        try {
          const result = await requestPluginCompileAndRegister({
            manifest: diskManifest,
            source: diskSource,
          });

          if (result.ok) {
            lastRegisteredSources.set(id, diskSource);
            invalidatePermissionCache();
            reRegistered = true;
            logger.info({ pluginId: id }, 'plugin re-registered from disk on open (source changed)');
          } else {
            logger.warn(
              { pluginId: id, errors: result.errors, warnings: result.warnings },
              'failed to re-register plugin from disk on open, navigating to cached version',
            );
          }
        } catch (err) {
          logger.warn(
            { pluginId: id, err },
            'failed to re-register plugin from disk on open, navigating to cached version',
          );
        }

        // If re-registration failed AND this was a first-open (no cached version), report failure
        if (!reRegistered && lastSource === undefined && !toolCreatedPluginSummaries.has(id)) {
          return { ok: false as const, error: `Plugin "${id}" failed to compile from disk` };
        }
      }

      broadcastToAllWindows('plugins:navigate', { pluginId: id, params });
      return { ok: true as const };
    }

    if (toolCreatedPluginSummaries.has(id)) {
      broadcastToAllWindows('plugins:navigate', { pluginId: id, params });
      return { ok: true as const };
    }

    // Also check Space-scanned plugins for existence (short-circuit: only scan if needed)
    let foundInSpace = false;
    try {
      const { scanSpacePlugins } = await import('./services/pluginSpaceService');
      const { plugins } = await scanSpacePlugins();
      foundInSpace = plugins.some((p) => p.pluginId === id);
    } catch {
      // Space scan failed — proceed to not found
    }

    if (!foundInSpace) {
      return { ok: false as const, error: `Plugin "${id}" not found` };
    }
    broadcastToAllWindows('plugins:navigate', { pluginId: id, params });
    return { ok: true as const };
  },
};

setBuiltinPluginService(pluginService);

// Safe Mode: Skip Super-MCP startup entirely for troubleshooting
// Can be triggered via --safe-mode CLI flag or via renderer action
import {
  initializeSafeModeContext,
  getSafeModeContext,
  categorizeError,
  type SafeModeErrorCategory,
} from './services/safeModeContext';

let isSafeModeEnabled = process.argv.includes('--safe-mode');

const isSafeMode = (): boolean => isSafeModeEnabled;

const broadcastSafeModeState = (): void => {
  broadcastToAllWindows('safe-mode:state', getSafeModeContext());
};

let mainWindow: BrowserWindow | null = null;
let ensureMainWindowPromise: Promise<BrowserWindow | null> | null = null;
let catalogOverrideStartupBanner: string | null = null;

// Track app ready time for startup duration analytics
let appReadyTime: number | null = null;

/**
 * Get the path to the index health worker file.
 * In packaged app, it's in app.asar.unpacked/workers/
 * In development, it's in out/main/workers/
 */
function getIndexHealthWorkerPath(): string {
  if (app.isPackaged) {
    return path.join(
      app.getAppPath().replace('app.asar', 'app.asar.unpacked'),
      'workers',
      'indexHealthWorker.js'
    );
  }
  // Development: worker is built to out/main/workers/ by scripts/build-worker.mjs
  const possiblePaths = [
    path.join(__dirname, 'workers', 'indexHealthWorker.js'),
    path.join(app.getAppPath(), 'out', 'main', 'workers', 'indexHealthWorker.js'),
    path.join(process.cwd(), 'out', 'main', 'workers', 'indexHealthWorker.js')
  ];

  for (const workerPath of possiblePaths) {
    if (fsSync.existsSync(workerPath)) {
      return workerPath;
    }
  }

  // Fallback to __dirname path - will fail at runtime but with a clear error
  return path.join(__dirname, 'workers', 'indexHealthWorker.js');
}

/**
 * Run index health check in a separate utilityProcess with a kill timeout.
 * 
 * This solves the problem where Promise.race() doesn't work with LanceDB
 * because native FFI calls block the Node.js event loop, preventing the
 * setTimeout callback from firing.
 * 
 * By running in a separate process, we can kill() it when the timeout fires.
 * 
 * @param settings - App settings for workspace config and indexing state
 * @param timeoutMs - Maximum time to wait before killing the worker
 * @returns The health report, or null if timed out or worker crashed
 */
async function runIndexHealthCheckWithTimeout(
  settings: AppSettings,
  timeoutMs: number
): Promise<IndexHealthReport | null> {
  return new Promise((resolve) => {
    const workerPath = getIndexHealthWorkerPath();
    
    // Check if worker exists before trying to spawn
    if (!fsSync.existsSync(workerPath)) {
      logger.warn({ workerPath }, 'Index health worker not found, falling back to main process');
      // Fallback to main process validation (existing behavior)
      validateAndRecoverIndices(settings)
        .then(resolve)
        .catch((err) => {
          logger.warn({ err }, 'Fallback index health check failed');
          resolve(null);
        });
      return;
    }

    let worker: ReturnType<typeof utilityProcess.fork> | null = null;
    let timeoutHandle: NodeJS.Timeout | null = null;
    let resolved = false;

    const cleanup = () => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
    };

    const resolveOnce = (result: IndexHealthReport | null) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve(result);
    };

    try {
      worker = utilityProcess.fork(workerPath, [], {
        serviceName: 'Index Health Worker',
        stdio: 'pipe', // Use pipe to prevent FD inheritance issues
      });

      // Drain stdout/stderr to prevent pipe buffer blocking
      worker.stdout?.on('data', (data: Buffer) => {
        logger.debug({ source: 'index-health-worker-stdout' }, data.toString().trim());
      });
      worker.stderr?.on('data', (data: Buffer) => {
        logger.warn({ source: 'index-health-worker-stderr' }, data.toString().trim());
      });

      // Set up timeout that kills the worker
      timeoutHandle = setTimeout(() => {
        if (!resolved) {
          logger.warn({ timeoutMs }, 'Index health check worker timed out, killing');
          try {
            worker?.kill();
          } catch { /* ignore kill errors */ }
          resolveOnce(null);
        }
      }, timeoutMs);

      // Handle worker messages
      worker.on('message', (msg: { type: string; report?: IndexHealthReport; error?: string }) => {
        if (msg.type === 'result' && msg.report) {
          resolveOnce(msg.report);
        } else if (msg.type === 'error') {
          logger.warn({ error: msg.error }, 'Index health check worker error');
          resolveOnce(null);
        }
        // Kill worker after receiving response
        try {
          worker?.kill();
        } catch { /* ignore */ }
      });

      // Handle worker exit
      worker.on('exit', (code) => {
        if (!resolved) {
          logger.warn({ exitCode: code }, 'Index health check worker exited unexpectedly');
          resolveOnce(null);
        }
      });

      // Send validation request to worker
      const workerSettings = {
        userDataPath: app.getPath('userData'),
        coreDirectory: settings.coreDirectory,
        indexingEnabled: settings.indexingEnabled,
        unpackedNodeModules: app.isPackaged
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- process.resourcesPath is guaranteed when app.isPackaged is true (Electron API contract)
          ? path.join(process.resourcesPath!, 'app.asar.unpacked', 'node_modules')
          : undefined,
      };
      worker.postMessage({ type: 'validate', settings: workerSettings });
    } catch (err) {
      logger.warn({ err }, 'Failed to spawn index health check worker, falling back to main process');
      cleanup();
      // Fallback to main process validation
      validateAndRecoverIndices(settings)
        .then(resolve)
        .catch((fallbackErr) => {
          logger.warn({ err: fallbackErr }, 'Fallback index health check failed');
          resolve(null);
        });
    }
  });
}

// Buffered navigation URL for cold start (dispatched when renderer is ready).
// Owned by index.ts; written by the deep-link handler via the injected
// setPendingNavigationUrl, read+cleared by createWindow's did-finish-load flush.
let pendingNavigationUrl: string | null = null;

// Deep-link cluster extracted to ./startup/deepLinkHandler (Stage 2 of the
// index.ts refactor — docs/plans/260623_refactor-index-startup-extract/PLAN.md).
// index.ts keeps owning `mainWindow` and `pendingNavigationUrl` (the only two
// index.ts-local accessors the handler needs); the handler imports its service
// deps directly. The `app.on(...)` registrations + whenReady protocol setup
// stay here (invariants #4/#6) and call into this instance.
const { handleDeepLink } = createDeepLinkHandler({
  getMainWindow: () => mainWindow,
  setPendingNavigationUrl: (url) => {
    pendingNavigationUrl = url;
  },
});

// Handle second-instance event for single-instance lock (Windows/Linux)
// Also handles deep link URLs passed as command line arguments
if (!isHeadlessCli()) {
  app.on('second-instance', (_event, argv) => {
    // On Windows/Linux, deep link URL is passed as the last argument
    const deepLinkUrl = argv.find((arg) =>
      arg.startsWith(`${DEEP_LINK_PROTOCOL}://`) || arg.startsWith(`${NAV_DEEP_LINK_PROTOCOL}://`)
    );
    if (deepLinkUrl) {
      handleDeepLink(deepLinkUrl);
    } else if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

// Handle open-url event for deep links (macOS)
app.on('open-url', (event, url) => {
  event.preventDefault();
  handleDeepLink(url);
});

import {
  applyVoiceActivationHotkey,
  getPendingVoiceActivationHotkey,
  setPendingVoiceActivationHotkey,
  unregisterVoiceActivationHotkey
} from './services/voiceHotkeyService';
import {
  initGracefulShutdown,
  gracefulShutdown,
  setAppBridgeManagerForShutdown,
  setAppBridgeStreamCoordinatorForShutdown,
} from './services/gracefulShutdown';
import {
  immediateExitWithFseventsSweep,
  registerWillQuitFseventsSweepBackstop,
} from './services/finalExit';
import { getOfficeSidecarManager, setOfficeSidecarManagerForShutdown } from './services/officeSidecarManager';
import { ShutdownError } from './services/shutdownState';

// Initialize graceful shutdown handler
initGracefulShutdown();

let automationScheduler: AutomationScheduler | null = null;
let communityHighlightsService: CommunityHighlightsService | null = null;
let meetingBotService: ReturnType<typeof createMeetingBotService> | null = null;
let inboundTriggerService: InboundTriggerService | null = null;
let desktopSlackExternalConversationService: ExternalConversationService | null = null;
let perfDiagnosticHandle: PerfDiagnosticHandle | null = null;
let eventLoopLagMonitor: EventLoopLagMonitor | null = null;
let superMcpTelemetryDisposer: (() => void) | null = null;

// Super-MCP startup state - set during MCP config setup, used after window creation
// for non-blocking background startup
let superMcpConfigPath: string | null = null;
let superMcpSkipForFirstRun = false;

const broadcastInboxState = (state: InboxState): void => {
  broadcastToAllWindows('inbox:state', state);
};

onInboxStateChange((state) => {
  broadcastInboxState(state);
});

const broadcastUserTasksState = (state: import('@shared/types').UserTasksState): void => {
  broadcastToAllWindows('user-tasks:state', state);
};
onUserTasksStateChange((state) => {
  broadcastUserTasksState(state);
});

// finalizeTurnLogger moved to services/agentTurnExecutor.ts

process.on('uncaughtException', (error) => {
  captureMainException(error);
  // REBEL-5RT: wrap logger.fatal — pino's thread-stream can throw "the worker
  // has exited" once the worker thread dies (typical during late-shutdown).
  // A raw throw here re-enters the uncaughtException path and produced 80k+
  // cascading Sentry events while hiding the original error.
  safeLog(logger, 'fatal', { err: error }, 'Uncaught exception');
});

process.on('unhandledRejection', (reason: unknown) => {
  // REBEL-HP: Filter shutdown errors - these are expected rejections from services
  // disposing pending work during graceful shutdown, not actual bugs
  if (reason instanceof ShutdownError) {
    logger.debug({ err: reason }, 'Shutdown rejection (not reported to Sentry)');
    return;
  }
  captureMainException(reason instanceof Error ? reason : new Error(String(reason)));
  if (reason instanceof Error) {
    safeLog(logger, 'fatal', { err: reason }, 'Unhandled promise rejection');
  } else {
    safeLog(logger, 'fatal', { reason }, 'Unhandled promise rejection');
  }
});

// Listener leak detection: Log warnings when EventEmitter max listeners exceeded
// This helps diagnose memory leaks from accumulating event listeners (common in Electron apps)
process.on('warning', (warning) => {
  if (warning.name === 'MaxListenersExceededWarning') {
    logger.warn(
      {
        name: warning.name,
        message: warning.message,
        stack: warning.stack,
      },
      '[diagnostics] MaxListenersExceededWarning - potential listener leak detected'
    );
  }
});

// Settings store is imported from ./settingsStore to ensure single source of truth
// DO NOT create a duplicate settingsStore here - it causes race conditions and data loss

interface AgentSessionHistoryStore extends VersionedData {
  version: number;
  sessions: AgentSession[];
}

const _createDefaultSessionHistoryState = (): AgentSessionHistoryStore => ({
  version: AGENT_SESSION_HISTORY_VERSION,
  sessions: []
});

const _SESSION_HISTORY_MIGRATIONS: Record<number, MigrationFn<AgentSessionHistoryStore>> = {
  // Migration from v1 to v2: Add resolvedAt field
  1: (data) => ({
    ...data,
    version: 2,
    sessions: data.sessions.map((session) => ({
      ...session,
      resolvedAt: (session as unknown as Record<string, unknown>).resolvedAt ?? null
    })) as unknown as AgentSession[]
  }),
  // Migration from v2 to v3: Add starredAt field for favorites feature
  2: (data) => ({
    ...data,
    version: 3,
    sessions: data.sessions.map((session) => ({
      ...session,
      starredAt: null
    }))
  }),
  // Migration from v3 to v4: Add deletedAt field for trash feature
  3: (data) => ({
    ...data,
    version: 4,
    sessions: data.sessions.map((session) => ({
      ...session,
      // Preserve existing deletedAt if present (from prerelease builds), otherwise null
      deletedAt: (session as { deletedAt?: number | null }).deletedAt ?? null
    }))
  })
};

// NOTE: This electron-store instance is no longer used for session storage.
// Sessions are now stored in the incremental session store (file-per-session).
// Keeping the type definitions above for reference during transition period.
// TODO: Remove after confirming incremental store works correctly in production.
// const agentSessionHistoryStore = new StoreConstructor<AgentSessionHistoryStore>({
//   name: 'agent-session-history',
//   defaults: createDefaultSessionHistoryState()
// });

async function runDesktopRecoveryAgentTurn(params: {
  win: EventWindow | null;
  turnId: string;
  prompt: string;
  phase: RecoveryPhase;
  enableRecovery: boolean;
  onEvent?: (event: AgentEvent) => void;
  agentLoopOptions: AgentLoopOptions;
}): Promise<void> {
  const adapter = createDesktopRecoveryAdapter({
    win: params.win,
    executeAgentTurn,
    getSettings,
    onEvent: params.onEvent,
  });
  const abortSignal =
    params.agentLoopOptions.existingAbortController?.signal
    ?? agentTurnRegistry.getActiveTurnController(params.turnId)?.signal
    ?? new AbortController().signal;
  const ctx: RecoveryContext = {
    phase: params.phase,
    depth: 0,
    attempt: 0,
    longContextFallbackAttempted: false,
    skeletonAttempted: false,
    isRecoveryModelAttempt: false,
    enableRecovery: params.enableRecovery,
    sessionId: params.agentLoopOptions.sessionId,
    turnId: params.turnId,
    originalSessionId: params.agentLoopOptions.sessionId,
    originalPrompt: params.prompt,
    abortSignal,
  };

  await runRecoveryPipeline({
    phase: params.phase,
    prompt: params.prompt,
    agentLoopOptions: params.agentLoopOptions,
    enableRecovery: params.enableRecovery,
    ctx,
    adapter,
    abortSignal,
  });
}

const runAutomationAgentTurn = async (
  turnId: string,
  prompt: string,
  options: {
    sessionId: string;
    onEvent: (event: AgentEvent) => void;
    modelOverride?: string;
    thinkingModelOverride?: string;
    finishLine?: string;
  }
): Promise<void> => {
  const policy = derivePolicy('automation');
  await runDesktopRecoveryAgentTurn({
    win: null,
    turnId,
    prompt,
    phase: 'pre_activity',
    enableRecovery: true,
    onEvent: options.onEvent,
    agentLoopOptions: {
      sessionId: options.sessionId,
      resetConversation: true,
      modelOverride: options.modelOverride,
      thinkingModelOverride: options.thinkingModelOverride,
      sessionType: 'automation',
      policy,
      ...(options.finishLine ? { finishLine: options.finishLine } : {}),
    },
  });
};

// Extracted to its own module for reuse by the shared headless runtime.
// Imported for local use and re-exported so existing DI consumers still work.
import {
  configureCliSessionPersistence,
  configureHeadlessTurnExecutor,
  runHeadlessTurn,
} from './services/headlessTurnRunner';
export { runHeadlessTurn };
configureHeadlessTurnExecutor(executeAgentTurn);

const runMemoryUpdateAgentTurn = async (
  turnId: string,
  prompt: string,
  options: { sessionId: string; originalTurnId: string; originalSessionId: string; privateMode?: boolean; onEvent: (event: AgentEvent) => void }
): Promise<void> => {
  // Memory updates should fail fast rather than retry - context overflow
  // during memory update likely indicates a systemic issue
  const settings = getSettings();
  // Memory safety now uses 3-tier resolution from settings (private/shared defaults + overrides)
  const coreDirectory = settings.coreDirectory ?? '';

  const memoryTurnOverride = resolveMemoryBtsTurnOverride(settings);
  const memoryAuxiliaryOverrides = resolveAuxiliaryTurnModelOverrides(memoryTurnOverride.auxiliaryTurnConfig);
  if (memoryTurnOverride.source === 'profile-decode-fallback') {
    logger.warn(
      { memoryBts: memoryTurnOverride.memoryBts, fallback: memoryTurnOverride.modelOverride },
      'Profile-based BTS override could not be decoded for memory update turns, using fallback',
    );
  }
  logger.info(
    {
      modelOverride: memoryTurnOverride.modelOverride,
      workingProfileOverrideId: memoryTurnOverride.workingProfileOverrideId,
      source: memoryTurnOverride.source,
    },
    'Memory update turn model pinned',
  );
  const policy = derivePolicy('automation');

  // Create memory write hook for intercepting file writes
  const memoryWriteHook = coreDirectory ? createMemoryWriteHook({
    turnId,
    sessionId: options.sessionId,
    originalTurnId: options.originalTurnId,
    originalSessionId: options.originalSessionId,
    coreDirectory,
    privateMode: options.privateMode,
  }) : undefined;
  
  // Memory updates bypass tool safety since they use memory write hook instead
  // MCP tools are included for prompt cache alignment but blocked by mcpDenyHook
  await runDesktopRecoveryAgentTurn({
    win: null,
    turnId,
    prompt,
    phase: 'pre_activity',
    enableRecovery: false,
    onEvent: options.onEvent,
    agentLoopOptions: {
      sessionId: options.sessionId,
      resetConversation: true,
      bypassToolSafety: true,
      memoryWriteHook,
      mcpDenyHook: createMcpDenyHook(),
      modelOverride: memoryAuxiliaryOverrides.modelOverride,
      // Memory-update turns are single-model (no planning leg): suppress the
      // thinking model so the turn never inherits a Claude thinking model and
      // spins a planning leg the active provider can't serve (FOX-3481).
      thinkingModelOverride: memoryAuxiliaryOverrides.thinkingModelOverride,
      // Thread workingProfileOverrideId UNCONDITIONALLY: '' must reach the executor
      // to SUPPRESS the active working profile so a plain-model BTS turn executes on
      // the configured BTS model (a conditional spread would drop the '' sentinel and
      // silently inherit the active working profile) — FOX-3481 Stage 2.
      workingProfileOverrideId: memoryAuxiliaryOverrides.workingProfileOverrideId,
      sessionType: 'automation',
      policy,
    },
  });
};

const getSessionTitleById = (sessionId: string): string | undefined => {
  if (!sessionId || sessionId === 'unknown') return undefined;
  try {
    // User-facing title lookups should use the default filtered view.
    const sessions = getIncrementalSessionStore().listSessions();
    const summary = sessions.find(s => s.id === sessionId);
    return summary?.title ?? undefined;
  } catch (error) {
    logger.warn({ err: error, sessionId }, 'Failed to lookup session title for memory history');
    return undefined;
  }
};

const broadcastMemoryUpdateStatus = (status: import('@shared/types').BroadcastMemoryUpdateStatus): void => {
  broadcastToAllWindows('memory:update-status', status);

  // Persist successful memory updates to history store
  if (status.status === 'success' && status.entityUpdates && status.entityUpdates.length > 0) {
    const sessionId = status.originalSessionId
      || agentTurnRegistry.getRendererSession(status.originalTurnId)
      || 'unknown';
    const sessionTitle = getSessionTitleById(sessionId);
    const workspacePath = getSettings().coreDirectory ?? undefined;
    void addMemoryHistoryEntries(status, sessionId, sessionTitle, workspacePath).catch((error) => {
      logger.warn({ err: error, sessionId }, 'Failed to persist memory history entries');
    });
  }
};

const broadcastTimeSavedStatus = (status: import('@shared/types').BroadcastTimeSavedStatus): void => {
  // not-cloud-pushed: time-saved:status — deliberately NOT in CLOUD_PUSH_ALLOWLIST (cloudEventChannel.ts).
  // Unlike memory:update-status, the time-saved service is desktop-only — it is
  // initialized via initializeTimeSavedService() here in the main process but NOT in
  // cloud-service/src/bootstrap.ts, so triggerTimeSavedEstimation() hits its deps-null
  // guard and no-ops on a cloud-executed turn (timeSavedService.ts). A cloud turn
  // therefore never produces a time-saved:status broadcast, so an allowlist entry would
  // be dead config implying a capability that doesn't exist. Revisit (allowlist + merge
  // policy for timeSavedStatusByTurn, mirroring memory) only if/when the service is wired
  // on the cloud surface. See docs/plans/260619_cloud-sync-field-followup/PLAN.md.
  broadcastToAllWindows('time-saved:status', status);
};

const broadcastCoachingReflection = (sessionId: string, evaluation: import('@shared/types').SessionCoachingEvaluation): void => {
  broadcastToAllWindows('coaching:reflection', { sessionId, evaluation });
};

// Idempotent eager-start for the Office sidecar. Safe to invoke from multiple
// triggers (did-finish-load, post-coreStartup) — guards on manager presence,
// running state, and in-flight attempts so it never double-spawns. Emits
// structured logs at each decision point so silent skips are visible.
let officeSidecarEagerStartInFlight = false;
const tryEagerStartOfficeSidecar = (trigger: string): void => {
  const officeSidecarManager = getOfficeSidecarManager();
  const officeSidecarConfigPath = superMcpConfigPath ?? resolveMcpConfigPath(settingsStore.store);
  const hasManager = officeSidecarManager !== null;
  const hasConfigPath = officeSidecarConfigPath !== null;
  const isRunning = officeSidecarManager !== null ? officeSidecarManager.isRunning() : false;
  logger.info(
    { trigger, hasManager, hasConfigPath, isRunning, inFlight: officeSidecarEagerStartInFlight },
    'Office sidecar eager-start hook fired',
  );
  if (!officeSidecarManager || !officeSidecarConfigPath || isRunning || officeSidecarEagerStartInFlight) {
    return;
  }
  officeSidecarEagerStartInFlight = true;
  void import('@core/services/mcpConfigManager')
    .then(({ isServerEnabled }) => isServerEnabled(officeSidecarConfigPath, 'RebelOffice'))
    .then((enabled) => {
      logger.info({ trigger, enabled }, 'Office sidecar isServerEnabled result');
      if (!enabled) {
        return;
      }
      return officeSidecarManager.start();
    })
    .catch((err: unknown) => {
      logger.warn({ trigger, err }, 'Office sidecar eager-start failed');
    })
    .finally(() => {
      officeSidecarEagerStartInFlight = false;
    });
};

const broadcastSkillImprovementComplete = (data: { skillName: string; skillPath: string; scoreAfter: number; bandAfter: string; lastSessionId?: string }): void => {
  broadcastToAllWindows('library:skill-improvement-complete', data);
};

const broadcastCommunityShareEligible = (sessionId: string, eligibility: import('@shared/types').CommunityShareEligibility): void => {
  broadcastToAllWindows('community:share-eligible', { sessionId, eligibility });
};

// Use case generator agent turn wrapper with context overflow recovery
const runUseCaseAgentTurn = async (
  turnId: string,
  prompt: string,
  options: { sessionId: string; onEvent: (event: AgentEvent) => void }
): Promise<void> => {
  const auxiliaryOverrides = resolveActiveWorkingSingleModelAuxiliaryTurnOverrides(getSettings());

  await runDesktopRecoveryAgentTurn({
    win: null,
    turnId,
    prompt,
    phase: 'pre_activity',
    enableRecovery: true,
    onEvent: options.onEvent,
    agentLoopOptions: {
      sessionId: options.sessionId,
      resetConversation: true,
      modelOverride: auxiliaryOverrides.modelOverride,
      thinkingModelOverride: auxiliaryOverrides.thinkingModelOverride,
      workingProfileOverrideId: auxiliaryOverrides.workingProfileOverrideId,
      // Background use-case generation (synthesises the user's data, not a
      // user-initiated conversation turn) — exclude from the Chief-of-Staff
      // admission gate (260622 Stage 3). See turnAdmission.admit.
      nonInteractiveTurn: true,
    },
  });
};

const initializeUseCaseGeneratorDeps = (): void => {
  initializeUseCaseGeneratorService({
    executeAgentTurn: runUseCaseAgentTurn,
    getActiveTurnController: (turnId: string) => agentTurnRegistry.getActiveTurnController(turnId),
    getSettings
  });
};

const initializeTimeSavedDeps = (): void => {
  initializeTimeSavedService({
    getSettings,
    broadcastTimeSavedStatus,
    broadcastCommunityShareEligible
  });
};

const broadcastErrorRecoveryState = (state: import('./services/errorRecoveryService').ErrorRecoveryState): void => {
  broadcastToAllWindows('error-recovery:state', state);
};

const initializeSessionCoachingScheduler = (): void => {
  sessionCoachingScheduler.initialize({
    getSettings,
    // Coaching only analyzes user-visible conversation history.
    listSessionSummaries: () => getIncrementalSessionStore().listSessions(),
    getSessionAsync: (id: string) => getIncrementalSessionStore().getSession(id),
    broadcastCoachingReflection,
    broadcastSkillImprovementComplete,
    getWorkspacePath: () => getSettings().coreDirectory ?? null
  });
};

const initHeroChoiceScheduler = (): void => {
  initializeHeroChoiceScheduler({
    getSettings,
    broadcastHeroChoiceUpdated: () => broadcastToAllWindows('hero-choice:updated', {}),
    listSessionSummaries: () => {
      // Hero-choice suggestions are based on user-visible sessions only.
      const summaries = getIncrementalSessionStore().listSessions();
      return summaries.map(s => ({
        id: s.id,
        title: s.title ?? undefined,
        createdAt: s.createdAt,
        resolvedAt: s.resolvedAt ?? undefined,
      }));
    },
    loadSession: async (id) => {
      const session = await getIncrementalSessionStore().getSession(id);
      if (!session) return null;
      return {
        id: session.id,
        title: session.title,
        createdAt: session.createdAt,
        messages: session.messages
          .filter(m => m.role === 'user' || m.role === 'assistant')
          .map(m => ({ role: m.role as 'user' | 'assistant', text: m.text })),
      };
    },
    getPersonalGoals: async () => {
      const settings = getSettings();
      const coreDir = settings.coreDirectory;
      if (!coreDir) return null;
      try {
        const fs = await import('node:fs/promises');
        const path = await import('node:path');
        const fm = (await import('front-matter')).default;
        const pathsToTry = [
          path.join(coreDir, 'Chief-of-Staff', 'README.md'),
          path.join(coreDir, 'chief-of-staff', 'README.md'),
        ];
        let content: string | null = null;
        for (const p of pathsToTry) {
          try { content = await fs.readFile(p, 'utf-8'); break; } catch { /* try next */ }
        }
        if (!content) return null;
        const parsed = fm<Record<string, unknown>>(content);
        const attrs = parsed.attributes as Record<string, unknown>;
        const goalsObj = attrs.personal_goals as Record<string, unknown> | undefined;
        const thisQuarterRaw = goalsObj?.this_quarter;
        if (!Array.isArray(thisQuarterRaw) || thisQuarterRaw.length === 0) return null;
        const thisQuarter = thisQuarterRaw
          .filter((item): item is Record<string, unknown> =>
            item != null && typeof item === 'object' && typeof (item as Record<string, unknown>).goal === 'string',
          )
          .map(item => ({
            goal: (item.goal as string).trim(),
            why: typeof item.why === 'string' ? item.why.trim() : undefined,
          }));
        return thisQuarter.length > 0 ? { thisQuarter, status: 'current' } : null;
      } catch {
        return null;
      }
    },
    getSkillSummaries: async () => {
      const workspacePath = getSettings().coreDirectory;
      if (!workspacePath) return [];
      try {
        const { scanSkills } = await import('./services/skillsService');
        const result = await scanSkills(workspacePath);
        return result.groups.flatMap(group =>
          Object.values(group.categories).flat().map(skill => ({
            name: skill.name,
            description: skill.frontmatter?.description ?? '',
          })),
        ).filter(s => s.description);
      } catch {
        return [];
      }
    },
    getUseCases: () => {
      try {
        return getHeroChoiceUseCases().map(uc => ({
          title: uc.title,
          description: uc.description,
          prompt: uc.prompt,
          usageCount: uc.usageCount,
          qualityRating: uc.qualityRating,
        }));
      } catch {
        return [];
      }
    },
    getUpcomingEvents: () => {
      // Calendar data is managed via the meeting cache store (synced from Google/Microsoft).
      try {
        const cache = getHeroChoiceMeetings();
        if (!cache?.meetings) return [];
        const now = Date.now();
        const in24h = now + 24 * 60 * 60 * 1000;
        return cache.meetings
          .filter(m => {
            const start = new Date(m.startTime).getTime();
            return start >= now && start < in24h;
          })
          .map(m => ({
            title: m.title,
            startTime: new Date(m.startTime).getTime(),
            endTime: m.endTime ? new Date(m.endTime).getTime() : undefined,
            attendees: m.participants,
          }));
      } catch {
        return [];
      }
    },
    getPastCandidates: () => getHeroChoicePastCandidates(),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
};

const broadcastDailySparkUpdated = (): void => {
  broadcastToAllWindows('daily-spark:updated', {});
};

const initDailySparkScheduler = (): void => {
  initializeDailySparkScheduler({
    getSettings,
    broadcastDailySparkUpdated,
    getFormatFeedback: () => getDailySparkFormatFeedback(),
    listSessionSummaries: () => {
      const summaries = getIncrementalSessionStore().listSessions();
      return summaries.map((s) => ({
        id: s.id,
        title: s.title ?? undefined,
        createdAt: s.createdAt,
        resolvedAt: s.resolvedAt ?? undefined,
      }));
    },
    loadSession: async (id) => {
      const session = await getIncrementalSessionStore().getSession(id);
      if (!session) return null;
      return {
        id: session.id,
        title: session.title,
        createdAt: session.createdAt,
        messages: session.messages
          .filter((m) => m.role === 'user' || m.role === 'assistant')
          .map((m) => ({ role: m.role as 'user' | 'assistant', text: m.text })),
      };
    },
    getPersonalGoals: async () => {
      const settings = getSettings();
      const coreDir = settings.coreDirectory;
      if (!coreDir) return null;
      try {
        const fs = await import('node:fs/promises');
        const path = await import('node:path');
        const fm = (await import('front-matter')).default;
        const pathsToTry = [
          path.join(coreDir, 'Chief-of-Staff', 'README.md'),
          path.join(coreDir, 'chief-of-staff', 'README.md'),
        ];
        let content: string | null = null;
        for (const p of pathsToTry) {
          try { content = await fs.readFile(p, 'utf-8'); break; } catch { /* try next */ }
        }
        if (!content) return null;
        const parsed = fm<Record<string, unknown>>(content);
        const attrs = parsed.attributes as Record<string, unknown>;
        const goalsObj = attrs.personal_goals as Record<string, unknown> | undefined;
        const thisQuarterRaw = goalsObj?.this_quarter;
        if (!Array.isArray(thisQuarterRaw) || thisQuarterRaw.length === 0) return null;
        const thisQuarter = thisQuarterRaw
          .filter((item): item is Record<string, unknown> =>
            item != null && typeof item === 'object' && typeof (item as Record<string, unknown>).goal === 'string',
          )
          .map((item) => ({
            goal: (item.goal as string).trim(),
            why: typeof item.why === 'string' ? item.why.trim() : undefined,
          }));
        return thisQuarter.length > 0 ? { thisQuarter, status: 'current' } : null;
      } catch {
        return null;
      }
    },
    getSkillSummaries: async () => {
      const workspacePath = getSettings().coreDirectory;
      if (!workspacePath) return [];
      try {
        const { scanSkills } = await import('./services/skillsService');
        const result = await scanSkills(workspacePath);
        return result.groups.flatMap((group) =>
          Object.values(group.categories).flat().map((skill) => ({
            name: skill.name,
            description: skill.frontmatter?.description ?? '',
          })),
        ).filter((s) => s.description);
      } catch {
        return [];
      }
    },
    getUseCases: () => {
      try {
        return getHeroChoiceUseCases().map((uc) => ({
          title: uc.title,
          description: uc.description,
          prompt: uc.prompt,
          usageCount: uc.usageCount,
          qualityRating: uc.qualityRating,
        }));
      } catch {
        return [];
      }
    },
    getUpcomingEvents: () => {
      try {
        const cache = getHeroChoiceMeetings();
        if (!cache?.meetings) return [];
        const now = Date.now();
        const in24h = now + 24 * 60 * 60 * 1000;
        return cache.meetings
          .filter((m) => {
            const start = new Date(m.startTime).getTime();
            return start >= now && start < in24h;
          })
          .map((m) => ({
            title: m.title,
            startTime: new Date(m.startTime).getTime(),
            endTime: m.endTime ? new Date(m.endTime).getTime() : undefined,
            attendees: m.participants,
          }));
      } catch {
        return [];
      }
    },
    getPastCandidates: () => getHeroChoicePastCandidates(),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
};

const getAutomationScheduler = (): AutomationScheduler => {
  if (automationScheduler) {
    return automationScheduler;
  }
  logger.info('Creating automation scheduler instance');
  automationScheduler = new AutomationScheduler({
    getCoreDirectory: () => getSettings().coreDirectory,
    executeAgentTurn: runAutomationAgentTurn,
    notifyRenderer: (state) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('automation:state', state);
      }
    },
    getSettings,
    updateSettings: (updater) => {
      const current = settingsStore.store;
      const updated = normalizeSettings(updater(current));
      settingsStore.store = updated;
    },
    generateUseCases: generatePersonalizedUseCases,
    refreshCommunityHighlights: () => getCommunityHighlightsService().refresh(),
    refreshVideoRecs: async () => {
      const { callBehindTheScenesWithAuth } = await import('./services/behindTheScenesClient');
      const settings = getSettings();
      return refreshVideoRecommendations({
        fetchVideos: fetchCommunityVideos,
        getSkillNames: () => getFrequentSkills().map((s) => s.skillName),
        getToolNames: () => getFrequentTools().map((t) => t.toolName),
        getTaskTypes: (limit) => getWeekTopSessions(limit).map((s) => s.taskType),
        getUseCaseTitles: () => getVideoRecsUseCases().map((uc) => uc.title),
        callBts: async (params) => {
          const response = await callBehindTheScenesWithAuth(
            settings,
            {
              messages: [{ role: 'user', content: params.userMessage }],
              system: params.systemPrompt,
              ...(params.jsonSchema
                ? { outputFormat: { type: 'json_schema' as const, schema: params.jsonSchema as Record<string, unknown> } }
                : {}),
            },
            { category: 'video-recs' },
          );
          const textBlock = response.content.find((b) => b.type === 'text');
          return { content: textBlock?.text ?? '' };
        },
      });
    },
    syncCalendarCache,
    runSpaceMaintenance: async (coreDir, settings) => {
      const { runDailyMaintenanceFromMain } = await import('./services/spaceMaintenanceAdapter');
      return runDailyMaintenanceFromMain(coreDir, settings);
    },
    runChiefOfStaffHygiene: async (coreDir, settings) => {
      const { runChiefOfStaffHygieneCheck } = await import('@core/services/chiefOfStaffHygieneRunnerService');
      return runChiefOfStaffHygieneCheck(coreDir, settings);
    },
  });
  if (!isRebelTestMode()) {
    automationScheduler.initialize();
  } else {
    logger.info('[rebel-test] Automation scheduler created but not started (timers disabled)');
  }
  // Wire up access rules lookup so safety hooks can query automation definitions
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- automationScheduler is assigned on the line above; the closure captures the module-level var which TypeScript can't narrow
  setAutomationStoreGetter(() => automationScheduler!.getState());
  // Wire the cloud→desktop automation delta bridge so cloud-executed runs
  // surface in the desktop UI. See docs-private/investigations/260515_cloud_automation_bugs.md § BUG 1+11.
  import('./services/cloud/cloudAutomationDeltaBridge').then(({ setAutomationSchedulerForCloudDelta }) => {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- automationScheduler is assigned above
    setAutomationSchedulerForCloudDelta(() => automationScheduler!);
  }).catch((err) => {
    logger.warn({ err }, 'Failed to wire cloud automation delta bridge');
  });
  logger.info('Automation scheduler ready');
  return automationScheduler;
};

const broadcastCommunityHighlightsState = (state: import('@shared/types').CommunityHighlightsState): void => {
  broadcastToAllWindows('community:state', state);
};

function getCommunityHighlightsService(): CommunityHighlightsService {
  if (communityHighlightsService) {
    return communityHighlightsService;
  }
  logger.info('Creating community highlights service instance');
  communityHighlightsService = new CommunityHighlightsService({
    notifyRenderer: broadcastCommunityHighlightsState
  });
  logger.info('Community highlights service ready');
  return communityHighlightsService;
}

const getMeetingBotService = (): ReturnType<typeof createMeetingBotService> | null => {
  // Return existing instance first (prevents null-deref if setting flips mid-session)
  if (meetingBotService) {
    return meetingBotService;
  }
  // Don't create new instance if feature is locked
  if (getSettings().meetingBotUnlocked !== true) {
    logger.debug('Meeting bot service not available (feature not unlocked)');
    return null;
  }
  logger.info('Creating meeting bot service instance');
  meetingBotService = createMeetingBotService();
  // Initialize meeting analysis service BEFORE polling (startup retry needs deps)
  initializeMeetingAnalysisService({
    runHeadlessTurn,
    getSettings,
  });
  // Initialize bot Q&A service (uses headless agent for knowledge base queries)
  initializeBotQAService({
    runHeadlessTurn,
    getConversationState,
    onProactiveOutcome: reportContributionOutcome,
    onHighSignalUtterance: handleHighSignalUtterance,
  });
  initializeConversationStateService({
    getTranscriptBuffer,
    getActiveBotState: getActiveMeetingForCoaching,
  });
  // Initialize live coach service (proactive coaching during meetings)
  initializeLiveCoachService({
    executeAgentTurn,
    runHeadlessTurn,
    queueContribution: (botId, text, metadata) => queueExternalContribution(botId, text, metadata),
    getTranscriptBuffer,
    getConversationState,
    getWindow: () => mainWindow,
    getActiveBotState: getActiveMeetingForCoaching,
    isKnowledgeAccessEnabled,
    checkStalePending: checkAndExpireStalePending,
  });
  // Start proactive analysis timer for live coaching
  startProactiveTimer();
  // Initialize Plaud sync service (physical recording import)
  initializePlaudSyncService({
    getSyncIntervalMinutes: () => getSettings().meetingBot?.plaud?.autoSyncIntervalMinutes ?? 15,
  });
  // Bootstrap community video recommendations if store is empty (non-blocking).
  // Delayed 45s so data is ready before user opens the Spark — avoids jank.
  startupScheduler.schedule('video-recs-bootstrap', 45_000, async () => {
    try {
      await bootstrapVideoRecommendations();
    } catch (err) {
      logger.warn({ err }, 'Video recs startup bootstrap failed (non-fatal)');
    }
  });
  // Start Plaud periodic sync if connected (with startup health check)
  // Delayed 60s to avoid competing with critical startup tasks
  startupScheduler.schedule('plaud-sync', 60_000, async () => {
    try {
      const connected = await isPlaudConnected();
      if (connected) {
        await startPlaudPeriodicSync();
      }
    } catch (err) {
      logger.warn({ err }, 'Plaud sync startup failed (non-fatal)');
    }
  });
  meetingBotService.startPolling();
  // Also start external provider polling for Fireflies/Fathom imports
  startExternalProviderPolling();
  logger.info('Meeting bot service ready');
  return meetingBotService;
};

const runInboundTriggerAgentTurn = async (
  turnId: string,
  prompt: string,
  options: { sessionId: string; onEvent: (event: AgentEvent) => void; inboundSafetyHook?: InboundTriggerSafetyHook }
): Promise<void> => {
  agentTurnRegistry.setEventListener(turnId, options.onEvent);
  try {
    const policy = derivePolicy('automation');
    await runDesktopRecoveryAgentTurn({
      win: null,
      turnId,
      prompt,
      phase: 'pre_activity',
      enableRecovery: true,
      onEvent: options.onEvent,
      agentLoopOptions: {
        sessionId: options.sessionId,
        resetConversation: true,
        sessionType: 'automation',
        policy,
        inboundSafetyHook: options.inboundSafetyHook as ((...args: unknown[]) => Promise<unknown>) | undefined,
      },
    });
  } finally {
    agentTurnRegistry.deleteEventListener(turnId);
  }
};

const createDesktopSlackWorkspaceStore = (): SlackWorkspaceStoreLike => ({
  get() {
    const settingsWorkspace = getSettings().experimental?.cloudSlackWorkspace;
    const workspace = settingsWorkspace
      ? {
        teamId: settingsWorkspace.teamId,
        teamName: settingsWorkspace.teamName,
      }
      : null;
    // Desktop polling can be multi-workspace; this lightweight store is only
    // used by SlackThreadAdapter formatting/pending-delivery paths. Stage 5c
    // routes inbound text through ExternalConversationService while retaining
    // the per-event bot token in the polling adapter for acknowledgments.
    if (!workspace) return null;
    return {
      ...workspace,
      botUserId: '',
      botToken: '',
      installedAt: 0,
      status: settingsWorkspace?.status ?? 'connected',
    };
  },
  set() {
    // Desktop Slack OAuth remains owned by slackAuthService.
  },
  updateStatus() {
    // Desktop Slack OAuth remains owned by slackAuthService.
  },
  updateLastSeen() {
    // Desktop Slack OAuth remains owned by slackAuthService.
  },
  clear() {
    // Desktop Slack OAuth remains owned by slackAuthService.
  },
});

const getDesktopSlackExternalConversationService = (): ExternalConversationService => {
  if (desktopSlackExternalConversationService) {
    return desktopSlackExternalConversationService;
  }

  const slackThreadAdapter = new SlackThreadAdapter({
    workspaceStore: createDesktopSlackWorkspaceStore(),
    broadcast: getBroadcastService(),
  });
  const adapters = new Map<string, SlackThreadAdapter>();
  adapters.set(slackThreadAdapter.kind, slackThreadAdapter);
  const store = getIncrementalSessionStore();

  desktopSlackExternalConversationService = createExternalConversationService({
    broadcast: getBroadcastService(),
    errorReporter: getErrorReporter(),
    agentTurnRegistry,
    conversationScopeResolver,
    sessionStore: {
      getSession: (id: string) => store.getSession(id),
      updateSession: (id, mutator) => store.updateSession(id, mutator),
    },
    adapters,
  });
  return desktopSlackExternalConversationService;
};

const getInboundTriggerService = (): InboundTriggerService => {
  if (inboundTriggerService) {
    return inboundTriggerService;
  }
  logger.info('Creating inbound trigger service instance');
  inboundTriggerService = new InboundTriggerService({
    executeAgentTurn: runInboundTriggerAgentTurn,
    getSettings,
    createSession: async (session) => {
      const agentSession: AgentSession = {
        id: session.id,
        title: session.title,
        createdAt: session.createdAt,
        updatedAt: session.createdAt,
        messages: [],
        eventsByTurn: {},
        activeTurnId: null,
        isBusy: false,
        lastError: null,
        resolvedAt: null,
        origin: 'inbound-trigger',
      };
      await getIncrementalSessionStore().upsertSession(agentSession);
    },
    updateSession: async (session) => {
      await getIncrementalSessionStore().upsertSession(session);
    },
    broadcastToRenderer: broadcastToAllWindows,
    externalConversationService: getDesktopSlackExternalConversationService(),
    conversationScopeResolver,
  });
  const observedSlackCloudStates = new Set<string>();
  const isSlackCloudReachableForPolling = (): boolean => {
    const state = getSettings().cloudInstance?.lastKnownStatus;
    if (state === 'running' || state === 'warm') {
      return true;
    }
    const stateKey = state ?? 'undefined';
    if (!observedSlackCloudStates.has(stateKey)) {
      observedSlackCloudStates.add(stateKey);
      logger.info({ state: state ?? null }, 'slack_poll_gate_cloud_unknown_state');
    }
    return false;
  };
  inboundTriggerService.registerAdapter(new SlackMentionAdapter({
    slackPollGate: new ElectronSlackPollGate(
      getSettings,
      isSlackCloudReachableForPolling,
    ),
    markPolledNow: (sourceId, timestamp) => {
      inboundTriggerService?.markSourcePolledNow('slack-mention', sourceId, timestamp);
    },
  }));
  inboundTriggerService.initialize();
  logger.info('Inbound trigger service ready');
  return inboundTriggerService;
};

const loadAgentSessions = (): AgentSession[] => {
  try {
    // Check version marker before loading sessions — if a newer version wrote userData,
    // enter read-only mode to prevent cross-version data loss
    const { isOlderVersion } = checkAndUpdateVersionMarker(INDEX_VERSION);
    const store = getIncrementalSessionStore();
    if (isOlderVersion) {
      store.setReadOnlyMode(true);
    }

    // Load from incremental session store (handles migration from legacy format)
    const sessions = store.loadSync();
    
    const now = Date.now();
    
    // Process all sessions, marking invalid ones as corrupted
    const processedSessions = sessions
      .map((session, index): AgentSession => {
        const isValid =
          session &&
          typeof session === 'object' &&
          typeof session.id === 'string' &&
          typeof session.title === 'string' &&
          Array.isArray(session.messages);

        if (!isValid) {
          // Create safe placeholder for corrupted session
          const fallbackId = (session as { id?: string })?.id ?? `corrupted-${index}-${now}`;
          logger.warn(
            { sessionId: fallbackId, index },
            'Found corrupted session, marking as unselectable'
          );
          return {
            id: fallbackId,
            title: '⚠️ Corrupted Session',
            createdAt: (session as { createdAt?: number })?.createdAt ?? now,
            updatedAt: (session as { updatedAt?: number })?.updatedAt ?? now,
            messages: [],
            eventsByTurn: {},
            activeTurnId: null,
            isBusy: false,
            lastError: null,
                resolvedAt: typeof (session as { resolvedAt?: number })?.resolvedAt === 'number' 
              ? (session as { resolvedAt: number }).resolvedAt 
              : null,
            isCorrupted: true
          };
        }

        // Apply interrupted-turn correction and normalize
        const corrected = session.activeTurnId
          ? applyInterruptedTurnCorrection(session, session.activeTurnId)
          : markSessionTurnsAsCompleted(session);
        // Normalize resolvedAt for backward compatibility
        const normalized: AgentSession = {
          ...corrected,
          resolvedAt: typeof corrected.resolvedAt === 'number' ? corrected.resolvedAt : null
        };
        return normalized;
      });

    const validCount = processedSessions.filter((s) => !s.isCorrupted).length;
    const corruptedCount = processedSessions.filter((s) => s.isCorrupted).length;

    logger.info(
      {
        sessionCount: processedSessions.length,
        validCount,
        corruptedCount,
      },
      'Loaded agent sessions from disk'
    );

    return processedSessions;
  } catch (error) {
    logger.error({ err: error }, 'Failed to load agent sessions, returning empty array');
    return [];
  }
};

/**
 * Prepare sessions for persistence by filtering and sanitizing.
 * imageContent is preserved so images render when revisiting conversations.
 */
const prepareSessionsForSave = (sessions: AgentSession[]): AgentSession[] => {
  return sessions.filter((session): session is AgentSession => {
    // Skip corrupted sessions - don't persist them
    if (session.isCorrupted) {
      return false;
    }
    return (
      session &&
      typeof session === 'object' &&
      typeof session.id === 'string' &&
      typeof session.title === 'string' &&
      Array.isArray(session.messages)
    );
  });
};

const guiSessionLockManager = createSessionLockManager({
  locksDirectory: path.join(getDataPath(), 'sessions-locks'),
  isProcessAlive: defaultIsProcessAlive,
  now: Date.now,
});

/**
 * Save agent sessions asynchronously (non-blocking).
 * This is the hot path called from sessions:save IPC handler.
 */
const saveAgentSessions = async (
  sessions: AgentSession[],
): Promise<SessionsSyncUpsertOutcome> => {
  try {
    const sessionsToSave = prepareSessionsForSave(sessions);
    const outcome = await upsertSessionsWithLocks({
      sessions: sessionsToSave,
      store: getIncrementalSessionStore(),
      lockManager: guiSessionLockManager,
      ownerKind: 'desktop',
    });

    logger.debug(
      { sessionCount: sessionsToSave.length },
      'Saved agent sessions to disk (locked incremental)'
    );
    // Trigger cloud sync AFTER disk write completes, so the outbox drain
    // reads current data from disk (not stale pre-write state).
    // Stage 3: ONLY for sessions that actually persisted — hard-delete
    // tombstoned ids are dropped at the store and must not fire cloud hooks.
    const sessionsForCloud =
      outcome.outcome === 'persisted'
        ? (() => {
            const persistedIds = new Set(outcome.persistedSessionIds);
            return sessionsToSave.filter((session) => persistedIds.has(session.id));
          })()
        : [];
    if (sessionsForCloud.length > 0) {
      cloudRouter.onLocalSessionsSaved(sessionsForCloud);
    }
    return outcome;
  } catch (error) {
    logger.error({ err: error }, 'Failed to save agent sessions');
    throw error;
  }
};

/**
 * Save agent sessions synchronously (blocking).
 * Only use for beforeunload when process is about to exit.
 * Uses upsertSessionsSync to merge into existing index (preserves other sessions).
 */
const describeNonPersistedSyncOutcome = (outcome: SessionsSyncUpsertOutcome): string => {
  if (outcome.outcome === 'dropped') return outcome.reason;
  return outcome.outcome;
};

const saveAgentSessionsSync = (sessions: AgentSession[]): { success: boolean; error?: string } => {
  try {
    const sessionsToSave = prepareSessionsForSave(sessions);
    const sessionIds = sessionsToSave.map((session) => session.id);

    const result = upsertSessionsWithLocksSync({
      sessions: sessionsToSave,
      store: getIncrementalSessionStore(),
      lockManager: guiSessionLockManager,
      ownerKind: 'desktop',
    });

    if (result.mode === 'deferred') {
      logger.info(
        { sessionCount: sessionsToSave.length, sessionIds },
        'Deferred quit-save behind in-flight async writer',
      );
      return { success: true };
    }

    const { outcome } = result;
    if (outcome.outcome !== 'persisted' && outcome.outcome !== 'noop-empty-batch') {
      const reason = describeNonPersistedSyncOutcome(outcome);
      logger.warn(
        { sessionCount: sessionsToSave.length, sessionIds, outcome },
        'Sync session save did not persist',
      );
      return { success: false, error: reason };
    }

    logger.debug(
      { sessionCount: sessionsToSave.length, sessionIds },
      'Saved agent sessions to disk (sync incremental)'
    );
    return { success: true };
  } catch (error) {
    logger.error({ err: error }, 'Failed to save agent sessions (sync)');
    throw error;
  }
};

// ensureNormalizedSettings is now imported from ./settingsStore (single source of truth).
// Previously defined inline here with reference equality (normalized !== current) which
// caused unnecessary writes. The settingsStore version uses deep equality.

// Migrations must run BEFORE normalization to avoid losing old field values
settingsStore.store = migrateOnboardingTimestampIfNeeded(settingsStore.store);
settingsStore.store = migrateLocalModelProfilesIfNeeded(settingsStore.store);
settingsStore.store = migrateCloudInstanceFieldsIfNeeded(settingsStore.store);
settingsStore.store = backfillCloudInstanceProviderIdIfNeeded(settingsStore.store);
settingsStore.store = migrateOAuthTimestampIfNeeded(settingsStore.store);
// Detect meeting bot usage from history BEFORE normalization so meetingBotUnlocked
// is set for history-only users before initCoreServices gates MCP registration.
detectMeetingBotUsageFromHistory();
// FOX-3494: rescue users whose `activeProvider` drifted off 'codex' to an
// unusable provider while valid Codex tokens remain (the reported stuck state).
// POST-bootstrap (not an import-time settingsStore migration) because it reads
// live Codex token state + managed-key storage, which need setStoreFactory()/
// secure-token wiring (above). One-shot/version-gated for boot; the reconnect +
// cloud-token triggers heal every time. See docs/plans/260616_chatgpt-reconnect-auth-bug/PLAN.md.
try {
  runCodexProviderHealAtBoot({
    codexConnected: getCodexAuthProvider().isConnected(),
    hasManagedKey: hasManagedOpenRouterKey(),
  });
} catch (error) {
  logger.warn({ err: error }, 'Codex provider heal at boot failed (non-fatal)');
}
ensureNormalizedSettings();
// Stage 2: fold the legacy `rebel-core-learned-model-limits` store onto
// profiles, and disambiguate registry-stamped legacy `contextWindow` values.
// Idempotent (each part is gated on its own timestamp inside `localModel`).
// Synchronous static import: migration must complete BEFORE any agent
// turn or IPC handler can fire (the renderer or cloud router could
// otherwise race the legacy-store read). Failures are logged and the
// next boot retries.
// See docs/plans/260503_unify_learned_limits_into_profiles.md.
try {
  migrateLearnedLimitsIfNeeded();
} catch (err) {
  logger.warn({ err }, 'learnedLimitsMigration failed during boot; will retry on next boot');
}
// Queue voice hotkey for registration when app is ready
applyVoiceActivationHotkey(settingsStore.store.voice.activationHotkey ?? null);

// Diagnostics cluster extracted to ./diagnostics/mainDiagnostics (Stage 1,
// 260607_decompose-main-index). Behaviour-preserving; state + self-rescheduling
// timer live there now.
disableExpiredDebugBreadcrumbs();

const ANONYMOUS_ID = getOrGenerateAnonymousId();

const APP_VERSION = (() => {
  try {
    return app.getVersion();
  } catch {
    return 'dev';
  }
})();

const APP_NAME = app.getName();

// Track App Launch immediately
trackMainEvent({
  anonymousId: ANONYMOUS_ID,
  event: 'Application Launch Started',
  properties: { version: APP_VERSION }
});

// synchronizeKnowledgeWorkerAgent moved to services/agentTurnExecutor.ts

// createWindow extracted to ./startup/mainWindowFactory.ts (Stage 3 of the
// index.ts startup refactor — see docs/plans/260623_refactor-index-startup-extract/PLAN.md).
// Behaviour-preserving: index.ts keeps `mainWindow` (Option B seam) as the single
// source of truth and injects accessors. The function is referenced ONLY via the
// `createWindowForEnsure = createWindow` assignment after IPC handlers register
// (invariants #1/#2) — there is no literal createWindow() call in this file.
const createWindow = createMainWindowFactory({
  setMainWindow: (win) => { mainWindow = win; },
  getMainWindow: () => mainWindow,
  // Raw nullable read — NO lazy creation (matches the original in-body
  // `const scheduler = automationScheduler;`); the lazy `getAutomationScheduler()`
  // creator elsewhere is deliberately NOT used here.
  getAutomationScheduler: () => automationScheduler,
  getAppReadyTime: () => appReadyTime,
  getCatalogOverrideBanner: () => catalogOverrideStartupBanner,
  clearCatalogOverrideBanner: () => { catalogOverrideStartupBanner = null; },
  getPendingNavigationUrl: () => pendingNavigationUrl,
  clearPendingNavigationUrl: () => { pendingNavigationUrl = null; },
  tryEagerStartOfficeSidecar,
  mainDir: MAIN_DIR,
  anonymousId: ANONYMOUS_ID,
  appVersion: APP_VERSION,
  appName: APP_NAME,
});

const getWindowForEvent = (sender: HandlerInvokeContext['sender']) => {
  if (!sender) return mainWindow;
  return BrowserWindow.fromWebContents(sender as Electron.WebContents) ?? mainWindow;
};

// Audio transcription and TTS functions moved to services/audioService.ts
// Agent message handling lives in services/agentMessageHandler.ts
// Agent event dispatch moved to services/agentEventDispatcher.ts














// executeAgentTurn moved to services/agentTurnExecutor.ts

// Gate used by app.on('activate') to wait for IPC handler registration.
// Without this, clicking the dock icon during startup creates a window before
// handlers are registered, causing "No handler registered" errors (REBEL-RE).
let resolveIpcHandlersReady!: () => void;
const ipcHandlersReady = new Promise<void>(r => { resolveIpcHandlersReady = r; });

// Window-creation capability for ensureMainWindow, injected by the startup
// bootstrap immediately before resolveIpcHandlersReady(). ensureMainWindow
// awaits ipcHandlersReady before using it, so by construction it cannot create
// a window before handlers are registered — and the startup-ipc-ordering gate
// stays satisfied because no executable createWindow() call precedes the
// registrations.
let createWindowForEnsure: (() => Promise<unknown>) | null = null;

const getLiveMainWindow = (): BrowserWindow | null => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    return mainWindow;
  }
  return null;
};

const sendSuperMcpReadyToMainWindow = (
  payload:
    | { success: true; port: number; recovered?: true }
    | { success: false; errorCategory: SafeModeErrorCategory },
): void => {
  const win = getLiveMainWindow();
  if (!win) {
    logger.debug({ payload }, 'Skipping Super-MCP ready broadcast; no live main window');
    return;
  }
  win.webContents.send('super-mcp:ready', payload);
};

superMcpHttpManager.onRecoverySuccess((event) => {
  logger.info(
    { port: event.port, attempts: event.attempts, context: event.context },
    'Super-MCP recovery succeeded; notifying renderer tools are available',
  );
  sendSuperMcpReadyToMainWindow({
    success: true,
    port: event.port,
    recovered: true,
  });
});

const ensureMainWindow = async (): Promise<BrowserWindow | null> => {
  const existing = getLiveMainWindow();
  if (existing) {
    return existing;
  }

  if (ensureMainWindowPromise) {
    return ensureMainWindowPromise;
  }

  ensureMainWindowPromise = (async () => {
    // REBEL-5A: app activation can arrive during startup before Electron is ready.
    if (!app.isReady()) {
      return null;
    }

    // REBEL-RE: the renderer can issue IPC immediately after load; don't create
    // a window until handlers are registered.
    await ipcHandlersReady;

    const afterReady = getLiveMainWindow();
    if (afterReady) {
      return afterReady;
    }

    if (!createWindowForEnsure) {
      // Unreachable in practice: ipcHandlersReady resolves only after the
      // bootstrap injects the capability. Fail loud rather than silently.
      createScopedLogger({ service: 'main-window' }).warn(
        'ensureMainWindow invoked before window creation was wired'
      );
      return null;
    }
    await createWindowForEnsure();
    return getLiveMainWindow();
  })().finally(() => {
    ensureMainWindowPromise = null;
  });

  return ensureMainWindowPromise;
};

// Wired at module scope (not inside createWindow) so a notification click that
// arrives before the first window exists already has a real ensure path.
setNotificationWindowTarget({
  getMainWindow: () => mainWindow,
  ensureMainWindow,
});
setMeetingNotificationWindowTarget({
  getMainWindow: () => mainWindow,
  ensureMainWindow,
});

// Use app.whenReady() instead of app.on('ready') to avoid a race condition:
// bootstrap.ts uses `await import('./index')` which is async. If Electron's
// 'ready' event fires during module resolution (before this handler is registered),
// the event is lost and the app hangs. app.whenReady() is idempotent -- it
// resolves immediately if already ready, or waits if not yet ready.
app.whenReady().then(async () => {
  // Deterministic boot-smoke marker: proves main got PAST `await import('./index')` into the
  // whenReady handler (the boot-crash class strikes before this). Stable line consumed by
  // scripts/check-oss-boot-smoke.ts (PAST_INDEX_MARKERS). Gated behind REBEL_BOOT_SMOKE_MARKER
  // (set only by that smoke) so normal production boots stay silent — zero effect outside the
  // smoke. console.error (not log) to satisfy the no-console lint rule; the smoke captures both
  // stdout and stderr. Cheap, one line, no PII.
  if (process.env.REBEL_BOOT_SMOKE_MARKER) {
    console.error('[boot-smoke] whenReady reached');
  }
  // Record app ready time for startup duration tracking
  appReadyTime = Date.now();

  // Root-cause prevention (macOS): if Rebel is running from outside /Applications
  // (translocation / DMG / Downloads), offer to move it there and relaunch — this
  // is the condition that makes Squirrel.Mac updates fail. Runs before the window
  // so a successful move relaunches cleanly without flashing the UI. Best-effort:
  // never throws, declines/failures fall through to normal startup.
  await maybeOfferMoveToApplications();

  // Duplicate-bundle detection + warning, sequenced AFTER the relocation offer so
  // the two never race a dialog at readiness. (If the move happened above, we
  // already relaunched and never reach here.) Fire-and-forget; never blocks startup.
  void runAppInstallIntegrityCheck()
    .then((result) => presentDuplicateBundleWarningIfNeeded(result))
    .catch((err) => {
      logger.warn({ err }, '[UPDATE] app-install integrity check chain rejected (non-fatal)');
    });

  // Guarded last-resort fsevents sweep for quits that bypass the final-exit
  // primitive. Registered here (after app ready) so it runs AFTER bootstrap's
  // early-registered will-quit outbox-drain handler and can observe its
  // event.preventDefault() — sweeping a cancelled quit would dead-watcher a
  // live app. See finalExit.ts + PLAN.md 260611_fsevents-shutdown-crash Stage 2.
  registerWillQuitFseventsSweepBackstop();

  const CHROMIUM_CACHE_MAX_BYTES = 200 * 1024 * 1024;

  // =============================================================================
  // Global Context Menu Handler
  // =============================================================================
  // Register context menu handler globally for ALL webContents (main window, devtools, etc.)
  // This ensures input fields get native Cut/Copy/Paste context menus everywhere.
  // Must be registered early before any windows are created.
  app.on('web-contents-created', (_event, webContents) => {
    webContents.on('context-menu', (_contextEvent, params) => {
      const { editFlags, isEditable, selectionText } = params;

      let template: Electron.MenuItemConstructorOptions[] = [];

      if (isEditable) {
        // Editable input fields get full edit menu
        template = [
          { label: 'Undo', role: 'undo', enabled: editFlags.canUndo },
          { label: 'Redo', role: 'redo', enabled: editFlags.canRedo },
          { type: 'separator' },
          { label: 'Cut', role: 'cut', enabled: editFlags.canCut },
          { label: 'Copy', role: 'copy', enabled: editFlags.canCopy },
          { label: 'Paste', role: 'paste', enabled: editFlags.canPaste },
          { type: 'separator' },
          { label: 'Select All', role: 'selectAll', enabled: editFlags.canSelectAll },
        ];
      } else if (selectionText) {
        // Non-editable text selection - just show Copy
        template = [{ label: 'Copy', role: 'copy', enabled: editFlags.canCopy }];
      } else {
        // Nothing actionable for non-editable, no selection
        return;
      }

      // Add Inspect Element in dev mode
      if (!app.isPackaged) {
        template.push({ type: 'separator' });
        template.push({
          label: 'Inspect Element',
          click: () => webContents.inspectElement(params.x, params.y),
        });
      }

      const menu = Menu.buildFromTemplate(template);
      menu.popup({ window: BrowserWindow.fromWebContents(webContents) ?? undefined });
    });
  });

  // =============================================================================
  // Startup Milestone Logging
  // =============================================================================
  // Track elapsed time from app.on('ready') for debugging startup performance.
  // All milestones logged with consistent [startup] prefix for easy filtering.
  const startupTime = Date.now();
  const logStartup = (milestone: string): void => {
    const elapsedMs = Date.now() - startupTime;
    logger.info({ elapsedMs }, `[startup] ${milestone}`);
    markStartup(milestone);
  };
  
  // Log a prominent startup marker to identify new process instances in logs
  // This helps correlate memory diagnostics across restarts when debugging leaks
  const demoMode = isDemoModeActive();
  logger.info(
    {
      pid: process.pid,
      version: app.getVersion(),
      isPackaged: app.isPackaged,
      platform: process.platform as 'darwin' | 'win32' | 'linux',
      arch: process.arch,
      nodeVersion: process.versions.node,
      electronVersion: process.versions.electron,
      demoMode,
      userData: app.getPath('userData'),
    },
    demoMode ? '🎭 [startup] App process started (DEMO MODE)' : '🚀 [startup] App process started'
  );
  logStartup('app.on(\'ready\')');

  try {
    const defaultSession = session.defaultSession as typeof session.defaultSession & {
      setCacheMaxSize?: (size: number) => void;
    };
    if (!defaultSession) {
      logger.warn(
        { cacheMaxBytes: CHROMIUM_CACHE_MAX_BYTES },
        '[startup] Default session unavailable — skipping Chromium cache cap'
      );
    } else if (typeof defaultSession.setCacheMaxSize !== 'function') {
      logger.warn(
        { cacheMaxBytes: CHROMIUM_CACHE_MAX_BYTES },
        '[startup] Session cache-cap API unavailable — skipping Chromium cache cap'
      );
    } else {
      defaultSession.setCacheMaxSize(CHROMIUM_CACHE_MAX_BYTES);
    }
  } catch (err) {
    logger.warn(
      { err, cacheMaxBytes: CHROMIUM_CACHE_MAX_BYTES },
      '[startup] Failed to set Chromium cache cap (non-fatal)'
    );
  }

  // =============================================================================
  // GPU Diagnostics (Windows Performance)
  // =============================================================================
  // Log GPU info at startup to help diagnose hardware acceleration issues on Windows.
  // Uses app.getGPUInfo('complete') as getGPUFeatureStatus() was deprecated/removed.
  // Run async to avoid blocking startup - diagnostics are for debugging, not critical path.
  app.getGPUInfo('complete')
    .then((gpuInfo) => {
      // Extract key fields for logging (full object can be very large)
      const summary = {
        gpuDevice: (gpuInfo as { gpuDevice?: Array<{ vendorId?: number; deviceId?: number; driverVersion?: string }> }).gpuDevice?.[0],
        auxAttributes: {
          glRenderer: (gpuInfo as { auxAttributes?: { glRenderer?: string } }).auxAttributes?.glRenderer,
          glVendor: (gpuInfo as { auxAttributes?: { glVendor?: string } }).auxAttributes?.glVendor,
        },
      };
      logger.info({ gpuInfo: summary }, '[startup] GPU info collected');
    })
    .catch((err) => {
      logger.warn({ err }, '[startup] Failed to collect GPU info (non-fatal)');
    });

  // =============================================================================
  // Emergency IPC Handlers (CRITICAL: Must be registered FIRST)
  // =============================================================================
  // Register emergency handlers before ANY potentially blocking operations.
  // These use fire-and-forget IPC (ipcMain.on) so they work even when the
  // main process event loop is partially blocked.
  // 
  // This enables the EmergencyStartupRecovery component to trigger safe mode
  // or quit the app even when normal IPC invoke handlers aren't responding.
  registerEmergencyHandlers({
    setSafeModeEnabled: (enabled: boolean) => {
      isSafeModeEnabled = enabled;
    },
  });
  logStartup('Emergency IPC handlers registered');

  // Initialize battery-aware scheduler early, before any services start
  // This must happen before getMeetingBotService() which starts battery-throttled intervals
  // Unlike visibility scheduler, this only needs powerMonitor (available after app ready)
  initBatteryScheduler();
  logStartup('Battery scheduler initialized');

  // Report unclean shutdown from previous session (fire-and-forget, never throws)
  fireAndForget(reportUncleanShutdownIfNeeded(), 'index.reportUncleanShutdownIfNeeded');

  // Pre-warm runtime config cache before renderer can request it via IPC.
  // The runtime-config:sync handler uses readFileSync which would block if cache is cold.
  loadRuntimeConfig();

  // Note: IncrementalSessionStore initializes lazily on first use (loadSync/load)
  // No explicit initialization needed - migration happens during first load

  // Clean up demo directories - first marked ones (immediate), then orphaned ones (7+ days old)
  void cleanupMarkedDemoDirs()
    .then(() => cleanupOrphanedDemoDirs())
    .catch((err) => logger.warn({ err }, 'Demo directory cleanup failed (non-fatal)'));

  // Register custom protocol for serving media files from user's workspace
  // This allows the renderer to securely load files like intro videos
  // Implements explicit byte-range handling for reliable video streaming
  // See: https://github.com/electron/electron/issues/38749
  protocol.handle('rebel-media', async (request) => {
    const url = new URL(request.url);
    // URL shape: `rebel-media://local/<encoded-absolute-path>` — `local` is a
    // sentinel host. Chromium registers `rebel-media` with `standard: true`,
    // which means its URL parser:
    //   (a) rejects empty-authority forms (`rebel-media:///x`) outright with
    //       "Media load rejected by URL safety check" — so we cannot use the
    //       triple-slash shape that rebel-html:// uses for iframe src; and
    //   (b) lowercases any real path segment placed in the host slot and
    //       silently strips it from the pathname — which silently dropped
    //       `Users` from `/Users/...` on macOS and produced 404s for every
    //       workspace media file.
    // The sentinel `local` round-trips safely through Chromium and tells the
    // handler to decode the percent-encoded pathname as the absolute path.
    let filePath: string;
    if (url.host === 'local') {
      // Current format: sentinel host + encoded absolute path in pathname.
      filePath = decodeURIComponent(url.pathname).replace(/^\//, '');
      if (filePath && !path.isAbsolute(filePath)) {
        filePath = `/${filePath}`;
      }
    } else if (url.host === 'resources') {
      // Legacy: bundled app-resource URLs like rebel-media://resources/rebel-intro.mp4
      // (only kept for old session content; current producers don't emit this form).
      const subPath = decodeURIComponent(url.pathname).replace(/^\//, '');
      const resourcesDir = app.isPackaged ? process.resourcesPath : path.resolve(process.cwd(), 'resources');
      filePath = path.join(resourcesDir, subPath);
    } else if (url.host && /^[A-Za-z]$/.test(url.host)) {
      // Legacy: Windows drive letter as hostname (pre URL-encoded format).
      filePath = `${url.host}:${decodeURIComponent(url.pathname)}`;
    } else if (url.host) {
      // Legacy: Unix absolute path whose first segment got promoted into
      // the host slot by Chromium's URL parser. Reconstruct.
      filePath = `/${url.host}${decodeURIComponent(url.pathname)}`;
    } else {
      // Legacy: empty-authority triple-slash form (260523 fix attempt v1).
      // Chromium rejects these at the renderer URL-safety layer, so this
      // branch only fires for non-renderer callers, but kept for safety.
      filePath = decodeURIComponent(url.pathname).replace(/^\//, '');
      if (filePath && !path.isAbsolute(filePath)) {
        filePath = `/${filePath}`;
      }
    }
    
    // Resolve symlinks to get the real path
    let realPath: string;
    try {
      realPath = await fs.realpath(filePath);
    } catch {
      logger.warn({ filePath, url: request.url }, 'rebel-media: File not found');
      return new Response('File not found', { status: 404 });
    }
    
    // Serve file with explicit byte-range support for video streaming.
    // HTML5 video requires proper 206 Partial Content responses for seeking/resume;
    // PDFium range-fetches large PDFs the same way. The contract-bearing parts
    // (extension→MIME map, status/header computation incl. range handling) are
    // extracted into `./services/rebelMediaProtocol` so they're unit-testable
    // without registering an Electron protocol or touching the real filesystem.
    try {
      const stat = await fs.stat(realPath);
      const fileSize = stat.size;
      const ext = path.extname(realPath).toLowerCase();
      const contentType = getRebelMediaMimeType(ext);

      const rangeHeader = request.headers.get('Range');
      logger.debug({ url: request.url, rangeHeader, fileSize, contentType }, 'rebel-media: serving file');

      const rangeResult = parseRebelMediaRange(rangeHeader, fileSize);
      const responseInit = buildRebelMediaResponseInit(rangeResult, fileSize, contentType);

      // Unsatisfiable / malformed range → 416 with no body.
      if (rangeResult.kind === 'unsatisfiable') {
        return new Response(null, responseInit);
      }

      const nodeStream = rangeResult.kind === 'partial'
        ? fsSync.createReadStream(realPath, { start: rangeResult.range.start, end: rangeResult.range.end })
        : fsSync.createReadStream(realPath);
      const webStream = Readable.toWeb(nodeStream) as ReadableStream;

      return new Response(webStream, responseInit);
    } catch (error) {
      logger.error({ err: error, realPath }, 'rebel-media: Failed to serve file');
      return new Response('Failed to read file', { status: 500 });
    }
  });

  // Register custom protocol for serving HTML tutorials from rebel-system/help-for-humans/
  // Used by DocumentPreviewDrawer to render tutorials in a sandboxed iframe
  // Supports: rebel-tutorial://tutorials/file.html, rebel-tutorial://diagrams/file.svg
  protocol.handle('rebel-tutorial', async (request) => {
    const url = new URL(request.url);
    // Build the resource path from host + pathname
    // With standard scheme, rebel-tutorial://tutorials/foo.html parses as host=tutorials, pathname=/foo.html
    // With triple-slash rebel-tutorial:///tutorials/foo.html, host is empty and pathname=/tutorials/foo.html
    // Handle both formats by combining host (if present) with pathname
    let urlPath: string;
    try {
      const hostPart = url.host || '';  // e.g., "tutorials" or empty
      const pathPart = decodeURIComponent(url.pathname).replace(/^\//, '');  // e.g., "foo.html" or "tutorials/foo.html"
      urlPath = hostPart ? `${hostPart}/${pathPart}` : pathPart;
      logger.debug({ requestUrl: request.url, host: hostPart, pathname: url.pathname, urlPath }, 'rebel-tutorial: request');
    } catch {
      logger.warn({ url: request.url }, 'rebel-tutorial: Invalid URL encoding');
      return new Response('Bad request', { status: 400 });
    }
    
    // Determine base directory: bundled rebel-system in packaged app, or local submodule in dev
    const rebelSystemDir = app.isPackaged
      ? path.join(process.resourcesPath, 'rebel-system')
      : path.resolve(process.cwd(), 'rebel-system');
    const helpDir = path.join(rebelSystemDir, 'help-for-humans');
    
    // Resolve the requested file path
    const filePath = path.join(helpDir, urlPath);
    
    // Security: validate path stays within help-for-humans directory (prevent path traversal)
    const realHelpDir = await fs.realpath(helpDir).catch(() => helpDir);
    let realFilePath: string;
    try {
      realFilePath = await fs.realpath(filePath);
    } catch {
      logger.warn({ filePath, url: request.url }, 'rebel-tutorial: File not found');
      return new Response('File not found', { status: 404 });
    }
    
    // Use path.relative to properly detect escape attempts (startsWith can be bypassed by siblings)
    const relativePath = path.relative(realHelpDir, realFilePath);
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
      logger.warn({ filePath, realFilePath, realHelpDir, relativePath }, 'rebel-tutorial: Path traversal attempt blocked');
      return new Response('Access denied', { status: 403 });
    }
    
    // Serve the file with appropriate MIME type and security headers
    try {
      const content = await fs.readFile(realFilePath);
      const ext = path.extname(realFilePath).toLowerCase();
      const mimeTypes: Record<string, string> = {
        '.html': 'text/html',
        '.htm': 'text/html',
        '.js': 'text/javascript',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.css': 'text/css',
        '.mermaid': 'text/plain',
      };
      const contentType = mimeTypes[ext] || 'application/octet-stream';
      
      // Build response headers with strict CSP for HTML files
      const headers: Record<string, string> = {
        'Content-Type': contentType,
        'Content-Length': String(content.length),
        'X-Content-Type-Options': 'nosniff',
      };
      
      // Apply CSP to HTML files - allow local scripts for syntax highlighting but block external resources
      if (ext === '.html' || ext === '.htm') {
        headers['Content-Security-Policy'] = [
          "default-src 'none'",
          "style-src 'unsafe-inline' rebel-tutorial:",  // Allow inline styles and local CSS files
          "img-src rebel-tutorial: data:",  // Allow images from this protocol and data URIs
          "script-src rebel-tutorial:",  // Allow scripts from local protocol only (for highlight.js)
          "connect-src 'none'",  // Block fetch/XHR
          "object-src 'none'",  // Block plugins
          "base-uri 'none'",  // Block <base> tag manipulation
          "worker-src 'none'",  // Block workers
          "frame-src 'none'",  // Block nested frames
          "form-action 'none'",  // Block form submissions
          // Note: frame-ancestors omitted - app origin varies between dev/prod
        ].join('; ');
      }
      
      logger.debug({ url: request.url, contentType, size: content.length }, 'rebel-tutorial: serving file');
      return new Response(content, { status: 200, headers });
    } catch (error) {
      logger.error({ err: error, realFilePath }, 'rebel-tutorial: Failed to serve file');
      return new Response('Failed to read file', { status: 500 });
    }
  });

  // Register custom protocol for serving workspace HTML files for preview
  // Used by DocumentPreviewDrawer to render HTML files in a sandboxed iframe
  // Security: Uses strict CSP, sandboxed iframe, and path traversal prevention
  // URL format: rebel-html:///<workspace-relative-path> (triple slash, path URL-encoded)
  protocol.handle('rebel-html', async (request) => {
    const url = new URL(request.url);
    // URL format: rebel-html:///path/to/file.html (triple slash = no host)
    let urlPath: string;
    try {
      urlPath = decodeURIComponent(url.pathname).replace(/^\//, '');
      logger.debug({ requestUrl: request.url, pathname: url.pathname, urlPath }, 'rebel-html: request');
    } catch {
      logger.warn({ url: request.url }, 'rebel-html: Invalid URL encoding');
      return new Response('Bad request', { status: 400 });
    }
    
    // Get workspace directory from settings
    const settings = getSettings();
    if (!settings.coreDirectory) {
      logger.warn({ url: request.url }, 'rebel-html: No workspace configured');
      return new Response('No workspace configured', { status: 500 });
    }
    
    const workspaceDir = settings.coreDirectory;
    let filePath = path.join(workspaceDir, urlPath);
    
    // Space-name resolution: if the direct path doesn't exist, try interpreting
    // the first segment as a space display name (handles cross-user links).
    // Read-only lane: rebel-html serves files, it must not trigger frontmatter
    // auto-fixes as a side effect of path resolution.
    try {
      await fs.stat(filePath);
    } catch {
      const spaceResolved = await resolveViaSpaceName(urlPath, workspaceDir, { useReadOnlyScan: true });
      if (spaceResolved) {
        filePath = spaceResolved;
      }
    }
    
    // Security: validate path stays within workspace directory or a known space
    // (prevent path traversal). Use realpath to resolve symlinks for comparison.
    const realWorkspaceDir = await fs.realpath(workspaceDir).catch(() => workspaceDir);
    let realFilePath: string;
    try {
      realFilePath = await fs.realpath(filePath);
    } catch {
      logger.warn({ filePath, url: request.url }, 'rebel-html: File not found');
      return new Response('File not found', { status: 404 });
    }
    
    // Use path.relative to properly detect escape attempts.
    // Space-resolved paths may be outside the workspace root (e.g. Google Drive)
    // but resolveViaSpaceName already validated they're inside a known space.
    const relativePath = path.relative(realWorkspaceDir, realFilePath);
    const isSpaceResolved = filePath !== path.join(workspaceDir, urlPath);
    if (!isSpaceResolved && (relativePath.startsWith('..') || path.isAbsolute(relativePath))) {
      logger.warn({ filePath, realFilePath, realWorkspaceDir, relativePath }, 'rebel-html: Path traversal attempt blocked');
      return new Response('Access denied', { status: 403 });
    }
    
    // Serve the file with appropriate MIME type and security headers
    try {
      const content = await fs.readFile(realFilePath);
      const ext = path.extname(realFilePath).toLowerCase();
      const mimeTypes: Record<string, string> = {
        '.html': 'text/html',
        '.htm': 'text/html',
        '.js': 'text/javascript',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.css': 'text/css',
      };
      const contentType = mimeTypes[ext] || 'application/octet-stream';
      
      // Build response headers with strict CSP for HTML files
      const headers: Record<string, string> = {
        'Content-Type': contentType,
        'Content-Length': String(content.length),
        'X-Content-Type-Options': 'nosniff',
      };
      
      // Apply CSP to HTML files. Two-tier model: strict by default, permissive
      // (Trusted) when the user has explicitly opted in for this file via the
      // banner UI in DocumentRenderers.tsx. Trust is keyed by canonical
      // absolute path + content hash, so editing the file invalidates trust.
      // See docs/plans/260525_html_preview_trust_tiers.md.
      if (ext === '.html' || ext === '.htm') {
        let trusted = false;
        try {
          trusted = getHtmlPreviewTrustService().isTrustedForContent(realFilePath, content);
        } catch (err) {
          logger.warn({ err, realFilePath }, 'rebel-html: trust lookup failed; falling back to strict CSP');
        }
        headers['Content-Security-Policy'] = getRebelHtmlCsp({ trusted });
        headers['X-Rebel-Html-Trust'] = trusted ? 'trusted' : 'strict';
      }
      
      logger.debug({ url: request.url, contentType, size: content.length }, 'rebel-html: serving file');
      return new Response(content, { status: 200, headers });
    } catch (error) {
      logger.error({ err: error, realFilePath }, 'rebel-html: Failed to serve file');
      return new Response('Failed to read file', { status: 500 });
    }
  });

  // Register rebel-preview:// for serving agent-built app previews from registered folders
  // URL format: rebel-preview:///<previewId>/<relative-path>
  // Security: previewId is resolved from persisted canvas store entries; path traversal is blocked
  protocol.handle('rebel-preview', async (request) => {
    const url = new URL(request.url);
    let urlPath: string;
    try {
      const pathPart = decodeURIComponent(url.pathname).replace(/^\//, '');
      // Follow rebel-media/rebel-tutorial host parsing patterns for cross-platform URL normalization
      // Triple-slash URL form keeps host empty; double-slash form places previewId in host
      if (url.host && /^[A-Za-z]$/.test(url.host)) {
        // Preserve Windows drive letters if they appear in host due URL parsing quirks
        urlPath = `${url.host}:/${pathPart}`;
      } else {
        urlPath = url.host ? `${url.host}/${pathPart}` : pathPart;
      }
    } catch {
      logger.warn({ url: request.url }, 'rebel-preview: Invalid URL encoding');
      return new Response('Bad request', { status: 400 });
    }

    const firstSlashIndex = urlPath.indexOf('/');
    if (firstSlashIndex <= 0 || firstSlashIndex >= urlPath.length - 1) {
      logger.warn({ url: request.url, urlPath }, 'rebel-preview: Invalid URL format');
      return new Response('Bad request', { status: 400 });
    }

    const previewId = urlPath.slice(0, firstSlashIndex);
    const relativePath = urlPath.slice(firstSlashIndex + 1);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(previewId)) {
      logger.warn({ url: request.url, previewId }, 'rebel-preview: Invalid preview ID');
      return new Response('Bad request', { status: 400 });
    }

    logger.debug({ requestUrl: request.url, pathname: url.pathname, host: url.host, previewId, relativePath }, 'rebel-preview: request');

    const canvasStorePath = path.join(app.getPath('userData'), 'mcp', 'rebel-canvas-store.json');
    let folderRoot = '';
    try {
      const rawStore = await fs.readFile(canvasStorePath, 'utf-8');
      const storeEntries = JSON.parse(rawStore) as unknown;

      if (!Array.isArray(storeEntries)) {
        logger.warn({ canvasStorePath }, 'rebel-preview: Invalid canvas store format');
        return new Response('Preview store unavailable', { status: 500 });
      }

      const previewEntry = storeEntries.find((entry): entry is [string, { _type?: unknown; folderPath?: unknown }] => {
        if (!Array.isArray(entry) || entry.length !== 2) {
          return false;
        }
        const [key, value] = entry;
        return key === previewId && typeof value === 'object' && value !== null && (value as { _type?: unknown })._type === 'preview';
      });

      if (!previewEntry) {
        logger.warn({ previewId }, 'rebel-preview: Preview entry not found');
        return new Response('Preview not found', { status: 404 });
      }

      const [, previewValue] = previewEntry;
      if (typeof previewValue.folderPath !== 'string' || previewValue.folderPath.length === 0) {
        logger.warn({ previewId, previewValue }, 'rebel-preview: Invalid preview folder path');
        return new Response('Preview not found', { status: 404 });
      }

      folderRoot = previewValue.folderPath;
    } catch (error) {
      logger.error({ err: error, canvasStorePath, previewId }, 'rebel-preview: Failed to read preview store');
      return new Response('Preview store unavailable', { status: 500 });
    }

    const filePath = path.join(folderRoot, relativePath);

    const realFolderRoot = await fs.realpath(folderRoot).catch(() => folderRoot);
    let realFilePath: string;
    try {
      realFilePath = await fs.realpath(filePath);
    } catch {
      logger.warn({ previewId, filePath, url: request.url }, 'rebel-preview: File not found');
      return new Response('File not found', { status: 404 });
    }

    const resolvedRelativePath = path.relative(realFolderRoot, realFilePath);
    if (resolvedRelativePath.startsWith('..') || path.isAbsolute(resolvedRelativePath)) {
      logger.warn(
        { previewId, filePath, realFilePath, realFolderRoot, resolvedRelativePath },
        'rebel-preview: Path traversal attempt blocked'
      );
      return new Response('Access denied', { status: 403 });
    }

    try {
      const content = await fs.readFile(realFilePath);
      const ext = path.extname(realFilePath).toLowerCase();
      const mimeTypes: Record<string, string> = {
        '.html': 'text/html',
        '.htm': 'text/html',
        '.js': 'text/javascript',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.css': 'text/css',
        '.json': 'application/json',
        '.woff': 'font/woff',
        '.woff2': 'font/woff2',
        '.ttf': 'font/ttf',
        '.mp3': 'audio/mpeg',
        '.mp4': 'video/mp4',
        '.webm': 'video/webm',
      };
      const contentType = mimeTypes[ext] || 'application/octet-stream';

      const headers: Record<string, string> = {
        'Content-Type': contentType,
        'Content-Length': String(content.length),
        'X-Content-Type-Options': 'nosniff',
      };

      if (ext === '.html' || ext === '.htm') {
        headers['Content-Security-Policy'] = [
          "default-src 'none'",
          "script-src 'unsafe-inline' rebel-preview:",
          "style-src 'unsafe-inline' rebel-preview:",
          "img-src rebel-preview: data: blob:",
          "font-src rebel-preview: data:",
          "media-src rebel-preview: blob:",
          "connect-src 'none'",
          "form-action 'none'",
          "object-src 'none'",
          "base-uri 'none'",
          "worker-src 'none'",
          "frame-src 'none'",
        ].join('; ');
      }

      logger.debug({ url: request.url, previewId, contentType, size: content.length }, 'rebel-preview: serving file');
      return new Response(content, { status: 200, headers });
    } catch (error) {
      logger.error({ err: error, previewId, realFilePath }, 'rebel-preview: Failed to serve file');
      return new Response('Failed to read file', { status: 500 });
    }
  });

  // Register rebel-asset:// for serving session-scoped image assets
  protocol.handle('rebel-asset', handleRebelAssetProtocol);

  const userDataPath = app.getPath('userData');
  logger.info({ userDataPath }, 'Resolved app userData path');

  // Register deep link protocol handler for OAuth callbacks (mindstone://)
  // Skip in rebel-test mode to avoid stealing protocol from daily driver
  if (!isHeadlessCli() && !isRebelTestMode()) {
    // On Windows in dev mode, need to pass extra args for protocol to work
    // See: https://www.electronjs.org/docs/latest/tutorial/launch-app-from-url-in-another-app
    let protocolRegistered: boolean;
    let navProtocolRegistered: boolean;
    if (process.platform === 'win32' && process.defaultApp && process.argv.length >= 2) {
      const devArgs = [path.resolve(process.argv[1])];
      protocolRegistered = app.setAsDefaultProtocolClient(DEEP_LINK_PROTOCOL, process.execPath, devArgs);
      navProtocolRegistered = app.setAsDefaultProtocolClient(NAV_DEEP_LINK_PROTOCOL, process.execPath, devArgs);
    } else {
      protocolRegistered = app.setAsDefaultProtocolClient(DEEP_LINK_PROTOCOL);
      navProtocolRegistered = app.setAsDefaultProtocolClient(NAV_DEEP_LINK_PROTOCOL);
    }
    logger.info({ protocol: DEEP_LINK_PROTOCOL, registered: protocolRegistered }, 'Registered deep link protocol');
    logger.info({ protocol: NAV_DEEP_LINK_PROTOCOL, registered: navProtocolRegistered }, 'Registered navigation protocol');
    
    // Handle cold start deep links - URL is in process.argv on all platforms
    const deepLinkArg = process.argv.find((arg) =>
      arg.startsWith(`${DEEP_LINK_PROTOCOL}://`) || arg.startsWith(`${NAV_DEEP_LINK_PROTOCOL}://`)
    );
    if (deepLinkArg) {
      // Delay handling to ensure app is fully ready
      setTimeout(() => handleDeepLink(deepLinkArg), 100);
    }
  }

  if (!isHeadlessCli() && process.platform === 'darwin' && !app.isPackaged && app.dock) {
    // Prefer a PNG during development (more reliable for setIcon), fall back to .icns
    const candidatePaths = [
      path.join(process.cwd(), 'build', 'app-icon-source.png'),
      path.join(process.cwd(), 'build', 'icon.icns')
    ];
    let devIconSet = false;
    for (const candidate of candidatePaths) {
      try {
        await fs.access(candidate);
        const image = nativeImage.createFromPath(candidate);
        if (!image.isEmpty()) {
          app.dock.setIcon(image);
          logger.info({ devIconPath: candidate }, 'Set dev dock icon for development run');
          devIconSet = true;
          break;
        }
      } catch {
        // try next candidate
      }
    }
    if (!devIconSet) {
      logger.warn({ candidates: candidatePaths }, 'Failed to set dev dock icon - no valid icon found');
    }
  }

  settingsStore.store = await migrateLegacyWrapperSettingsIfNeeded(settingsStore.store);

  // Run Klavis cleanup migration (removes legacy Klavis config files and server entries
  // for the long tail of users still upgrading from a pre-Klavis-removal build).
  // Idempotent and safe to run on every startup; never throws.
  await runKlavisMigration();

  // One-time: retroactively tag historical cost ledger entries with auth method
  // so subscription savings show correctly for pre-fix data.
  // Awaited (not fire-and-forget) to prevent write races with the append-based ledger.
  try {
    await runCostLedgerAuthMigration(getSettings(), isCodexConnected);
  } catch (err) {
    logger.warn({ err }, 'Cost ledger auth migration failed (non-fatal)');
  }

  // Clean up expired attachment cache files (7-day expiry for network reconnect resume)
  cleanupExpiredAttachmentCache().catch((err) => {
    logger.warn({ err }, 'Failed to cleanup expired attachment cache');
  });

  // External copy-only vault for irreplaceable userData config/auth/user-state.
  // Fire-and-forget: startup must not depend on backup success.
  scheduleUserDataBackupOnStartup({ userDataPath });

  // Clean up temp attachment files (24-hour expiry for clipboard-pasted file persistence)
  cleanupTempAttachments().catch((err) => {
    logger.warn({ err }, 'Failed to cleanup temp attachments');
  });

  // Clean up old canvas preview temp files (24-hour expiry)
  cleanupPreviewTempFiles().catch((err) => {
    logger.warn({ err }, 'Failed to cleanup preview temp files');
  });

  // Clean up old transcript JSONL files (14-day TTL, fire-and-forget)
  cleanupOldTranscripts().catch(() => {});

  // One-shot legacy-file hygiene: the pre-incremental-store
  // `agent-session-history.json` and its `.backup.json` sidecar (often 60+ MB)
  // linger in userData long after the incremental store has taken over. The
  // cloud surface already sweeps these unconditionally; on desktop we keep a
  // 30-day recovery window so freshly migrated users still have their safety
  // net. Fire-and-forget; failure here is non-fatal.
  const LEGACY_FILE_MIN_AGE_MS = 30 * 24 * 60 * 60 * 1000;
  removeLegacyFiles(userDataPath, { minAgeMs: LEGACY_FILE_MIN_AGE_MS })
    .then((result) => {
      if (result.removed.length > 0) {
        logger.info(
          { removed: result.removed, bytesFreed: result.bytesFreed },
          'Removed stale legacy session history files'
        );
      }
      if (result.errors.length > 0) {
        logger.warn({ errors: result.errors }, 'Errors while pruning legacy session history files');
      }
    })
    .catch((err: unknown) => {
      logger.warn({ err }, 'Failed to run desktop legacy session-history hygiene');
    });

  // One-shot stale-approval hygiene: entries older than 30 days are almost
  // certainly abandoned (the user moved on / restarted Rebel without acting
  // on them). 30 days is well past anything the approval_stuck diagnostic
  // already surfaces at the 5/15/60/240-minute buckets.
  try {
    const STALE_APPROVAL_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
    const pruneResult = pruneStaleApprovals(STALE_APPROVAL_MAX_AGE_MS);
    if (pruneResult.removedTool > 0 || pruneResult.removedMemory > 0) {
      const oldestDays = pruneResult.oldestRemovedAgeMs !== null
        ? Math.round(pruneResult.oldestRemovedAgeMs / (24 * 60 * 60 * 1000))
        : null;
      logger.info(
        {
          removedTool: pruneResult.removedTool,
          removedMemory: pruneResult.removedMemory,
          oldestRemovedDays: oldestDays,
          maxAgeDays: 30,
        },
        'Pruned stale pending approvals at startup'
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to prune stale pending approvals at startup');
  }

  // Initialize health context updater for Sentry (runs quick health check on each error capture)
  initializeHealthContextUpdater();

  // Initialize Safe Mode context (loads from temp file if --safe-mode flag present, cleans up orphans otherwise)
  await initializeSafeModeContext(isSafeModeEnabled);
  if (isSafeModeEnabled) {
    const context = getSafeModeContext();
    logger.info({ context }, '[startup] Safe Mode initialized with context');
  }

  logStartup('migrations complete');

  // =============================================================================
  // Workspace Recovery / Missing Workspace Detection
  // =============================================================================
  // Check for interrupted workspace rename (crash recovery) and missing workspace.
  // Must run BEFORE window creation to avoid showing UI with invalid workspace.

  // Check for interrupted workspace rename (crash recovery)
  // workspaceRenameInProgress is a transient recovery flag not in the AppSettings schema
  const storeData = settingsStore.store as Record<string, unknown>;
  const renameInProgress = storeData.workspaceRenameInProgress as
    | { oldPath: string; newPath: string; startedAt: number }
    | undefined;
  // Helper to clear the transient recovery flag (not in AppSettings schema)
  const clearRenameFlag = (): void => {
    settingsStore.delete('workspaceRenameInProgress' as keyof typeof settingsStore.store);
  };

  if (renameInProgress) {
    const { oldPath, newPath } = renameInProgress;
    logger.info({ oldPath, newPath }, 'Detected workspaceRenameInProgress flag - checking recovery');

    try {
      const newPathExists = await fs.access(newPath).then(() => true).catch(() => false);
      const oldPathExists = await fs.access(oldPath).then(() => true).catch(() => false);

      if (newPathExists) {
        // Rename succeeded but app crashed before clearing flag
        logger.info({ newPath }, 'Workspace rename succeeded (newPath exists) - updating settings');
        settingsStore.set('coreDirectory', newPath);
        // Stage 4: purge the plugin-identity cache for every workspace key so
        // the new coreDirectory does not serve stale plugin-ID sets.
        clearPluginIdentityCache('coreDirectory-switch');
        clearAllSpaceScanCaches('coreDirectory-switch');
        clearRenameFlag();
      } else if (oldPathExists) {
        // Rename failed - oldPath still exists
        logger.info({ oldPath }, 'Workspace rename failed (oldPath exists) - clearing flag');
        clearRenameFlag();
      } else {
        // Neither exists - fall through to missing workspace dialog
        logger.warn({ oldPath, newPath }, 'Neither old nor new workspace path exists - clearing flag');
        clearRenameFlag();
      }
    } catch (err) {
      logger.error({ err, oldPath, newPath }, 'Error during workspace rename recovery');
      clearRenameFlag();
    }
  }

  // Check for missing workspace (coreDirectory set but doesn't exist)
  const configuredWorkspace = settingsStore.store.coreDirectory;
  if (configuredWorkspace) {
    // Distinguish "folder missing" (ENOENT) from "access denied" (EACCES/EPERM)
    // so we can show the right guidance — especially for Windows Controlled Folder Access.
    let workspaceExists = false;
    let accessErrCode: string | undefined;
    try {
      await fs.access(configuredWorkspace);
      workspaceExists = true;
    } catch (accessErr) {
      accessErrCode = (accessErr as NodeJS.ErrnoException).code;
    }

    if (!workspaceExists) {
      // Single source of denied/missing classification + dialog copy.
      const recovery = workspaceStartupRecoveryDescriptor(accessErrCode, configuredWorkspace);
      logger.warn({ coreDirectory: configuredWorkspace, accessDenied: recovery.state.status === 'denied' }, 'Configured workspace not accessible');

      if (isHeadlessCli()) {
        // Headless CLI mode - exit with error, no blocking dialog
        logger.error(
          { coreDirectory: configuredWorkspace },
          'Workspace not found - cannot run in headless CLI mode'
        );
        console.error(`Error: Workspace not found at ${configuredWorkspace}`);
        process.exitCode = 1;
        // Point of no return: exit via the final-exit primitive so any leaked
        // fsevents instances are swept (harmless pre-watcher: empty sweep).
        await immediateExitWithFseventsSweep('headless-cli-workspace-missing', 1);
        return;
      }

      // Show different dialogs for "missing" vs "access denied"
      const { title: dialogTitle, message: dialogMessage, detail: dialogDetail } = recovery;

      const { response } = await dialog.showMessageBox({
        type: 'warning',
        title: dialogTitle,
        message: dialogMessage,
        detail: dialogDetail,
        buttons: ['Create New...', 'Locate Existing...'],
        defaultId: 1,
        cancelId: -1, // No cancel button
      });

      if (response === 0) {
        // "Create New..." - clear coreDirectory, onboarding will trigger
        logger.info('User chose to create new workspace');
        settingsStore.set('coreDirectory', null);
        clearPluginIdentityCache('coreDirectory-switch');
        clearAllSpaceScanCaches('coreDirectory-switch');
        settingsStore.set('onboardingCompleted', false);
      } else if (response === 1) {
        // "Locate Existing..." - open folder picker
        const result = await dialog.showOpenDialog({
          title: 'Select Workspace Folder',
          properties: ['openDirectory'],
          buttonLabel: 'Select Workspace',
        });

        if (result.canceled || result.filePaths.length === 0) {
          // User cancelled - create new workspace instead
          logger.info('User cancelled folder selection, triggering onboarding');
          settingsStore.set('coreDirectory', null);
          clearPluginIdentityCache('coreDirectory-switch');
          clearAllSpaceScanCaches('coreDirectory-switch');
          settingsStore.set('onboardingCompleted', false);
        } else {
          const selectedPath = result.filePaths[0];

          // Validate it looks like a workspace (has Chief-of-Staff folder or spaces)
          // Check both cases for case-sensitive filesystems (Linux)
          const hasChiefOfStaff = await fs
            .access(path.join(selectedPath, 'Chief-of-Staff'))
            .then(() => true)
            .catch(() => fs.access(path.join(selectedPath, 'chief-of-staff')).then(() => true).catch(() => false));
          const hasSpacesStructure = await fs
            .readdir(selectedPath)
            .then((entries) => entries.some((e) => !e.startsWith('.') && !e.startsWith('_')))
            .catch(() => false);

          if (hasChiefOfStaff || hasSpacesStructure) {
            logger.info({ selectedPath }, 'User located existing workspace');
            settingsStore.set('coreDirectory', selectedPath);
            clearPluginIdentityCache('coreDirectory-switch');
            clearAllSpaceScanCaches('coreDirectory-switch');
          } else {
            // Doesn't look like a workspace - show warning and let them try again or create new
            const { response: confirmResponse } = await dialog.showMessageBox({
              type: 'question',
              title: 'Not a Valid Workspace',
              message: 'This folder doesn\'t appear to be a Rebel workspace',
              detail: 'A workspace typically contains a Chief-of-Staff folder or space folders. Would you like to create a new workspace here instead?',
              buttons: ['Yes, Create Here', 'No, Try Again'],
              defaultId: 0,
            });

            if (confirmResponse === 0) {
              // Create new workspace at selected location
              logger.info({ selectedPath }, 'User chose to create new workspace at selected location');
              settingsStore.set('coreDirectory', selectedPath);
              clearPluginIdentityCache('coreDirectory-switch');
              clearAllSpaceScanCaches('coreDirectory-switch');
              // Don't reset onboardingCompleted - the location is set
            } else {
              // Try again - recurse by restarting app
              logger.info('User wants to try again - restarting');
              app.relaunch();
              app.quit();
              return;
            }
          }
        }
      }
    }
  }

  // Session log cleanup (fire-and-forget) - runs after settings are normalized
  const sessionRetentionDays = getSettings().sessionLogRetentionDays ?? SESSION_LOG_DEFAULTS.retentionDays;
  logger.info({ retentionDays: sessionRetentionDays }, '[startup] Initiating session log cleanup');
  void cleanupSessionLogs({ retentionDays: sessionRetentionDays }).catch((err) => {
    logger.warn({ err }, '[startup] Session log cleanup failed');
  });

  // Periodic session log cleanup (every 6 hours, pauses when app is hidden/blurred, catches up on resume)
  createPausableInterval(
    () => {
      const retentionDays = getSettings().sessionLogRetentionDays ?? SESSION_LOG_DEFAULTS.retentionDays;
      void cleanupSessionLogs({ retentionDays }).catch((err) => {
        logger.warn({ err }, '[periodic] Session log cleanup failed');
      });
    },
    6 * 60 * 60 * 1000,
    { pauseOnBlur: true, catchUpPriority: 9 }
  );

  // Migrate RebelTaskQueue to RebelInbox in MCP config if needed
  const mcpConfigPath = resolveMcpConfigPath(settingsStore.store);
  if (mcpConfigPath) {
    try {
      const migrated = await migrateRebelTaskQueueToInbox(mcpConfigPath);
      if (migrated) {
        logger.info({ configPath: mcpConfigPath }, 'Migrated RebelTaskQueue to RebelInbox in MCP config');
      }
    } catch (error) {
      logger.warn({ err: error, configPath: mcpConfigPath }, 'Failed to migrate RebelTaskQueue to RebelInbox');
    }
  }

  // Re-queue voice hotkey in case settings changed during startup
  // Note: applyVoiceActivationHotkey is non-fatal - it returns a result instead of throwing.
  // See Sentry REBEL-JY for history on why this must not crash.
  const hotkeyResult = applyVoiceActivationHotkey(settingsStore.store.voice.activationHotkey ?? null);
  if (!hotkeyResult.success) {
    logger.warn({ error: hotkeyResult.error }, 'Voice activation hotkey registration failed during startup (non-fatal)');
  }

  logger.info(
    { streamTimeout: process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT },
    'MCP stream timeout workaround active for parallel agent turns'
  );

  // Setup Node.js environment early for user-configured MCP servers that may use npx
  // This adds the bundled node-bundle/bin to PATH in production builds
  try {
    await setupNodeEnvironment();
  } catch (err) {
    logger.warn({ err }, 'Node environment setup failed (MCP servers using npx may not work)');
  }

  // Setup Git environment with bundled dugite-native distribution
  // Sets LOCAL_GIT_DIRECTORY and on Windows also CLAUDE_CODE_GIT_BASH_PATH
  try {
    await setupGitEnvironment();
  } catch (err) {
    logger.warn({ err }, 'Git environment setup failed (git operations may not work)');
  }

  // Start Super-MCP HTTP server
  // For users who haven't completed onboarding, defer Super-MCP startup to avoid
  // Windows Firewall prompts before they see the first screen. Super-MCP will be
  // started when the user completes onboarding or when Klavis is configured.
  //
  // mcpConfigFile points to super-mcp-router.json which can contain:
  // - Direct mcpServers entries (bundled servers like RebelInbox)
  // - configPaths for external config aggregation (Klavis, user configs, etc.)
  {
    const settings = settingsStore.store;
    const isFirstRun = !settings.onboardingCompleted;
    
    // Use resolveMcpConfigPath to get the user's configured path
    let resolvedPath = resolveMcpConfigPath(settings);
    const _wasBootstrapped = !resolvedPath;  // Track if we're creating a new config
    
    if (!resolvedPath) {
      // No config exists - create router in userData
      const configDir = path.join(app.getPath('userData'), 'mcp');
      const routerPath = path.join(configDir, 'super-mcp-router.json');
      try {
        await ensureRouterConfigFile(routerPath);
        resolvedPath = routerPath;
        settingsStore.store = normalizeSettings({
          ...settings,
          mcpConfigFile: routerPath
        });
        logger.info(
          { configPath: routerPath },
          'Created Super-MCP router config - tools available when user configures them'
        );
      } catch (configError) {
        logger.error(
          { err: configError, configPath: routerPath },
          'Failed to create Super-MCP router config - Super-MCP will not start'
        );
        resolvedPath = '';
      }
    } else {
      logger.debug({ configPath: resolvedPath }, 'Using existing MCP config');
    }
    
    // v2 multi-account cleanup: remove stale `instances` array if present
    // (v2 architecture uses mcpServers as single source of truth)
    // Only applies to configs in userData - external configs are never modified
    if (resolvedPath) {
      const userDataPath = app.getPath('userData');
      const didCleanup = await cleanupStaleInstancesArray(resolvedPath, userDataPath);
      if (didCleanup) {
        logger.info({ configPath: resolvedPath }, 'Cleaned up stale instances array from router config');
      }
      
      // Backfill catalogId for existing bundled MCP servers (migration for account disambiguation feature)
      // This enables catalog matching for instance-named servers like "GoogleWorkspace-greg-work-com"
      try {
        const { updated } = await backfillCatalogIds(resolvedPath, userDataPath);
        if (updated > 0) {
          logger.info({ count: updated, configPath: resolvedPath }, 'Backfilled catalogId for bundled MCP servers');
        }
      } catch (err) {
        // Non-fatal: migration will be retried on next startup
        logger.warn({ err, configPath: resolvedPath }, 'Failed to backfill catalogId for MCP servers');
      }

      // Repair bundled MCP connector paths after Squirrel app update
      // On Windows Squirrel updates, the app install folder changes (e.g., app-0.2.35 → app-0.3.8)
      // This rewrites stale absolute paths in bundled connectors to point to current resourcesPath
      try {
        const { repaired } = await repairBundledMcpScriptPaths(
          resolvedPath,
          userDataPath,
          app.isPackaged,
          process.resourcesPath
        );
        if (repaired > 0) {
          logger.info({ count: repaired, configPath: resolvedPath }, 'Repaired bundled MCP connector paths after app update');
        }
      } catch (err) {
        // Non-fatal: servers will fail to spawn but won't crash the app
        logger.warn({ err, configPath: resolvedPath }, 'Failed to repair bundled MCP connector paths');
      }

      // Reconcile bundled MCP script paths that may have become stale
      // Handles: paths that no longer exist on disk, or legacy build/index.js format
      // More conservative than repairBundledMcpScriptPaths - only updates when path is actually broken
      try {
        const { reconciled } = await reconcileBundledMcpScriptPaths(
          resolvedPath,
          userDataPath,
          app.isPackaged,
          process.resourcesPath
        );
        if (reconciled > 0) {
          logger.info({ count: reconciled, configPath: resolvedPath }, 'Reconciled stale bundled MCP script paths');
        }
      } catch (err) {
        // Non-fatal: servers will fail to spawn but won't crash the app
        logger.warn({ err, configPath: resolvedPath }, 'Failed to reconcile bundled MCP script paths');
      }

      // Reconcile npx package versions against the connector catalog.
      // When we ship a new version of an npx-based connector (e.g., xero-mcp-server),
      // users with the old version pinned in their config won't get the update because
      // npx caches the old package. This updates the version specifier at startup.
      try {
        const { updated } = await reconcileNpxPackageVersions(resolvedPath, userDataPath);
        if (updated > 0) {
          logger.info({ count: updated, configPath: resolvedPath }, 'Reconciled npx package versions from connector catalog');
        }
      } catch (err) {
        // Non-fatal: old versions will still work, just won't get fixes
        logger.warn({ err, configPath: resolvedPath }, 'Failed to reconcile npx package versions');
      }

      // Reconcile HTTP URLs against the connector catalog.
      // When a vendor deprecates an endpoint (e.g., Webflow's unstable /beta/mcp →
      // stable /mcp per Sentry REBEL-17G), users with the old URL stored in their
      // config would keep hitting the broken endpoint. This updates the URL at
      // startup so existing users don't have to remove and re-add connectors.
      // Same-origin guard prevents cross-domain redirects via catalog update.
      try {
        const { updated } = await reconcileHttpUrls(resolvedPath, userDataPath);
        if (updated > 0) {
          logger.info({ count: updated, configPath: resolvedPath }, 'Reconciled HTTP URLs from connector catalog');
        }
      } catch (err) {
        // Non-fatal: users can manually re-add the connector if needed
        logger.warn({ err, configPath: resolvedPath }, 'Failed to reconcile HTTP URLs');
      }
    }
    
    if (resolvedPath) {
      try {
        const catalogResolution = await resolveConnectorCatalogForMain();
        const overridePath = catalogResolution.source === 'override'
          ? catalogResolution.overridePath ?? null
          : null;
        setConnectorCatalogPathOverride(overridePath);
        catalogOverrideStartupBanner = catalogResolution.startupBanner ?? null;

        if (catalogResolution.source === 'override') {
          logger.warn(
            { overridePath: catalogResolution.overridePath },
            'Catalog override activated for startup connector resolution',
          );
        } else if (catalogResolution.rejectedReason) {
          logger.error(
            { reason: catalogResolution.rejectedReason, overridePath: catalogResolution.overridePath },
            'Catalog override rejected; using bundled connector catalog',
          );
        }
      } catch (catalogResolutionError) {
        setConnectorCatalogPathOverride(null);
        catalogOverrideStartupBanner = null;
        logger.error(
          { err: catalogResolutionError },
          'Failed to resolve connector catalog override at startup; using bundled catalog',
        );
      }

      // Migration chain: legacy servers → RebelInternal → split MCPs
      // This handles users upgrading from any version:
      // - Pre-Jan-16: Had RebelInbox, RebelWorkspace, etc. → migrateToRebelInternal handles
      // - Jan 16 - Jan 26: Had RebelInternal → migrateRebelInternalToSplit handles
      // - Post-Jan-26: Already has split MCPs → both migrations no-op
      try {
        const legacyResult = await migrateToRebelInternal(resolvedPath);
        if (legacyResult.removed.length > 0 || legacyResult.migratedTools > 0) {
          logger.info(
            { removed: legacyResult.removed, migratedTools: legacyResult.migratedTools },
            'Migrated legacy internal servers to RebelInternal'
          );
        }
      } catch (err) {
        logger.warn({ err }, 'Failed to migrate legacy internal servers');
      }

      // Now migrate from RebelInternal to split MCPs
      try {
        const migrationResult = await migrateRebelInternalToSplit(resolvedPath);
        if (migrationResult.removedRebelInternal || migrationResult.migratedTools > 0) {
          logger.info(
            { removedRebelInternal: migrationResult.removedRebelInternal, migratedTools: migrationResult.migratedTools },
            'Migrated RebelInternal to split MCPs'
          );
        }
      } catch (migrationError) {
        // Non-fatal: legacy entries will be overwritten anyway
        logger.warn({ err: migrationError }, 'Failed to migrate RebelInternal to split MCPs');
      }

      // Migrate RebelSearch to RebelSearchAndConversations (Feb 2026 rename)
      try {
        const searchMigrationResult = await migrateRebelSearchToRebelSearchAndConversations(resolvedPath);
        if (searchMigrationResult.removedRebelSearch || searchMigrationResult.migratedTools > 0 || searchMigrationResult.updatedDisabledServers) {
          logger.info(
            {
              removedRebelSearch: searchMigrationResult.removedRebelSearch,
              migratedTools: searchMigrationResult.migratedTools,
              updatedDisabledServers: searchMigrationResult.updatedDisabledServers
            },
            'Migrated RebelSearch to RebelSearchAndConversations'
          );
        }
      } catch (searchMigrationError) {
        // Non-fatal: the new server will be registered anyway
        logger.warn({ err: searchMigrationError }, 'Failed to migrate RebelSearch to RebelSearchAndConversations');
      }

      // Desktop-specific legacy cleanup (must run before MCP registration)
      // Clean up legacy generic "GoogleWorkspace" entry if instance entries exist.
      // The v2 architecture (Dec 2025) uses instance-based "GoogleWorkspace-{email}" entries.
      try {
        await cleanupLegacyGoogleWorkspaceEntry(resolvedPath);
      } catch {
        // Non-fatal: cleanup will be retried on next startup or during auth flow
      }

      // Clean up legacy static Microsoft entries (e.g., "Microsoft365Mail") if instance entries exist.
      // The multi-instance architecture (Mar 2026) uses "Microsoft365Mail-{email-slug}" entries.
      try {
        await cleanupLegacyMicrosoftEntries(resolvedPath);
      } catch {
        // Non-fatal: cleanup will be retried on next startup or during auth flow
      }

      // Clean up legacy RebelImage entry (renamed to OpenAIImageGeneration in v1.2.0)
      try {
        await removeMcpServerEntry(resolvedPath, 'RebelImage');
        logger.debug('Removed legacy RebelImage entry (renamed to OpenAIImageGeneration)');
      } catch {
        // Entry may not exist - expected on clean installs or already-migrated users
      }

      if (isHeadlessCli()) {
        configureBundledMcpManager({
          userDataDir: app.getPath('userData'),
          resourcesDir: app.isPackaged ? process.resourcesPath : path.resolve(process.cwd(), 'resources'),
          isPackaged: app.isPackaged,
        });

        try {
          const { configureManagedMcpInstallService } = await import(
            './services/managedMcpInstallServiceInstance'
          );
          configureManagedMcpInstallService(app.getPath('userData'));
        } catch (managedInstallInitError) {
          logger.warn(
            { err: managedInstallInitError },
            'Headless CLI failed to configure managed MCP install service (non-fatal; legacy npx path still works)',
          );
        }

        try {
          const { upgradeRebelOssEntriesToManaged, scanForDevPrePublishSentinels } = await import(
            './services/managedMcpAutoUpgrade'
          );
          const upgradeResult = await upgradeRebelOssEntriesToManaged(resolvedPath);
          if (
            upgradeResult.upgraded.length > 0 ||
            upgradeResult.reinstalled.length > 0 ||
            upgradeResult.failed.length > 0 ||
            upgradeResult.scopeMigrations.length > 0
          ) {
            logger.info(
              {
                upgradedCount: upgradeResult.upgraded.length,
                reinstalledCount: upgradeResult.reinstalled.length,
                skippedCount: upgradeResult.skipped.length,
                failedCount: upgradeResult.failed.length,
                scopeMigrationCount: upgradeResult.scopeMigrations.length,
              },
              'Headless CLI managed MCP auto-upgrade completed',
            );
          }
          await scanForDevPrePublishSentinels();
        } catch (upgradeError) {
          logger.warn(
            { err: upgradeError },
            'Headless CLI managed MCP auto-upgrade failed (non-fatal)',
          );
        }

        superMcpConfigPath = resolvedPath;
      } else {
      // ── Core service initialization (shared with cloud-service) ──
      // Other migrations (RebelInternal split, search rename, etc.) run BEFORE this call
      // because they rename/restructure MCP entries that initCoreServices re-registers.
      // initCoreServices handles: bundled MCP manager config, embedded credentials,
      // settings normalization, platform prompt cache, inbox bridge, and MCP registration.
      const coreStartupResult = await initCoreServices({
        userDataDir: app.getPath('userData'),
        resourcesDir: app.isPackaged ? process.resourcesPath : path.resolve(process.cwd(), 'resources'),
        isPackaged: app.isPackaged,
        routerConfigPath: resolvedPath,
        getSettings,
        getAutomationScheduler,
        getMeetingBotService,
        memoryUpdateDeps: {
          executeAgentTurn: runMemoryUpdateAgentTurn,
          getSettings,
          broadcastMemoryUpdateStatus,
        },
        errorRecoveryDeps: {
          executeAgentTurn: async (
            turnId: string,
            prompt: string,
            options: {
              sessionId: string;
              onEvent: (event: AgentEvent) => void;
              bypassToolSafety?: boolean;
              readOnlyHook?: NonNullable<Parameters<typeof executeAgentTurn>[3]>['memoryWriteHook'];
            },
          ) => {
            const auxiliaryOverrides = resolveActiveWorkingSingleModelAuxiliaryTurnOverrides(getSettings());
            agentTurnRegistry.setEventListener(turnId, options.onEvent);
            try {
              await executeAgentTurn(null, turnId, prompt, {
                sessionId: options.sessionId,
                resetConversation: true,
                bypassToolSafety: options.bypassToolSafety,
                memoryWriteHook: options.readOnlyHook,
                modelOverride: auxiliaryOverrides.modelOverride,
                thinkingModelOverride: auxiliaryOverrides.thinkingModelOverride,
                workingProfileOverrideId: auxiliaryOverrides.workingProfileOverrideId,
                // System-driven error-recovery auxiliary turn (read-only hook,
                // not user-initiated) — exclude from the Chief-of-Staff admission
                // gate (260622 Stage 3). See turnAdmission.admit.
                nonInteractiveTurn: true,
              });
            } finally {
              agentTurnRegistry.deleteEventListener(turnId);
            }
          },
          getSettings,
          notifyRenderer: broadcastErrorRecoveryState,
        },
      });

      if (coreStartupResult.errors.length > 0) {
        logger.warn(
          { errors: coreStartupResult.errors.map(e => ({ service: e.service, msg: e.error.message })) },
          'Core startup completed with non-fatal errors'
        );
      }

      // Configure the managed MCP install singleton so migration gates and any
      // connect-time callers share a single service instance. Cleanup of stale
      // temp directories from crashed/killed installs runs in the background —
      // it must not block startup but a crashed install that leaves a `.tmp-*`
      // dir forever would silently waste disk.
      try {
        const { configureManagedMcpInstallService } = await import(
          './services/managedMcpInstallServiceInstance'
        );
        const managedInstallService = configureManagedMcpInstallService(
          app.getPath('userData'),
        );
        void managedInstallService
          .cleanupStaleTempDirs()
          .then(({ removed, errors }) => {
            if (removed.length > 0 || errors.length > 0) {
              logger.info(
                { removedCount: removed.length, errorCount: errors.length },
                'Managed MCP install stale temp cleanup completed',
              );
            }
          })
          .catch((cleanupError: unknown) => {
            logger.warn({ err: cleanupError }, 'Managed MCP install stale temp cleanup failed');
          });
      } catch (managedInstallInitError) {
        logger.warn(
          { err: managedInstallInitError },
          'Failed to configure managed MCP install service (non-fatal; legacy npx path still works)',
        );
      }

      // Register the App Bridge manager with the graceful-shutdown runner
      // so it tears down the loopback server, WS sockets, and state file
      // before Super-MCP / Electron exit. Skipped (manager === null) when
      // coreStartup didn't construct one (cloud surface) — gracefulShutdown
      // handles that case with a null-safe call.
      setAppBridgeManagerForShutdown(coreStartupResult.appBridgeManager);
      setAppBridgeStreamCoordinatorForShutdown(
        coreStartupResult.conversationStreamCoordinator,
      );
      setOfficeSidecarManagerForShutdown(coreStartupResult.officeSidecarManager);

      // Migrate bundled connectors from local node command to npx (rebel-oss packages).
      // Must run AFTER initCoreServices because resolveConnectorCatalogPath() requires
      // configureBundledMcpManager() to have been called first.
      try {
        await repairBridgeStatePathLiterals(resolvedPath);
      } catch (bridgeStateRepairError) {
        logger.warn(
          { err: bridgeStateRepairError, configPath: resolvedPath },
          'Failed to repair stranded MCP bridge-state path literals',
        );
      }

      try {
        const npxMigration = await migrateBundledConnectorsToNpx(
          resolvedPath,
          getSettings().providerKeys,
        );
        if (npxMigration.migrated.length > 0) {
          logger.info(
            { migrated: npxMigration.migrated, skipped: npxMigration.skipped },
            'Migrated bundled connectors to npx',
          );
        }
      } catch (npxMigrationError) {
        // Non-fatal: user can reconnect manually
        logger.warn({ err: npxMigrationError }, 'Failed to migrate bundled connectors to npx');
      }

      try {
        const pruneResult = await pruneStaleHubSpotRefreshEnv(resolvedPath);
        if (pruneResult.pruned.length > 0) {
          logger.info(
            { pruned: pruneResult.pruned },
            'Pruned stale HubSpot refresh-disable env keys from router config',
          );
        }
      } catch (pruneError) {
        logger.warn({ err: pruneError }, 'Failed to prune stale HubSpot refresh env (non-fatal)');
      }

      try {
        const backfillResult = await backfillCatalogEnvForExistingServers(resolvedPath);
        if (backfillResult.repaired.length > 0) {
          logger.info(
            { repaired: backfillResult.repaired, skipped: backfillResult.skipped, errored: backfillResult.errored },
            'Backfilled catalog static env on existing MCP entries',
          );
        }
      } catch (backfillError) {
        logger.warn({ err: backfillError }, 'Failed to backfill catalog static env (non-fatal)');
      }

      // Sweep published contributions: swap local dev builds for catalog (npx) versions.
      // Runs after npx migration so catalog entries are already in their final form.
      try {
        const { sweepPublishedContributions } = await import('./services/contributionSwapService');
        const swapResults = await sweepPublishedContributions(resolvedPath);
        const swapped = swapResults.filter((r) => r.swapped);
        if (swapped.length > 0) {
          logger.info({ swappedCount: swapped.length }, 'Swapped published contributions to catalog versions');
        }
      } catch (swapError) {
        logger.warn({ err: swapError }, 'Failed to sweep published contributions (non-fatal)');
      }

      // Managed MCP auto-upgrade: upgrade npx-shaped rebel-oss entries to
      // managed installs before Office eager-start runs. Failures leave the
      // existing npx entry intact so the connector still works (just slower).
      // See `docs/plans/260416_managed_mcp_install_replace_npx.md` §Stage 2.
      await (async () => {
        try {
          const { upgradeRebelOssEntriesToManaged, scanForDevPrePublishSentinels } = await import(
            './services/managedMcpAutoUpgrade'
          );
          const upgradeResult = await upgradeRebelOssEntriesToManaged(resolvedPath);
          if (
            upgradeResult.upgraded.length > 0 ||
            upgradeResult.reinstalled.length > 0 ||
            upgradeResult.failed.length > 0 ||
            upgradeResult.scopeMigrations.length > 0
          ) {
            logger.info(
              {
                upgradedCount: upgradeResult.upgraded.length,
                reinstalledCount: upgradeResult.reinstalled.length,
                skippedCount: upgradeResult.skipped.length,
                failedCount: upgradeResult.failed.length,
                scopeMigrationCount: upgradeResult.scopeMigrations.length,
              },
              'Managed MCP auto-upgrade startup sweep completed',
            );
          }
          // Dev pre-publish build banner: see docs/project/MCP_DEV_LOCAL_OVERRIDE.md.
          // Non-fatal, dev-only signal that a locally packed tarball is shadowing the
          // published package. Safety net for the runbook's mandatory uninstall step.
          await scanForDevPrePublishSentinels();
        } catch (upgradeError) {
          logger.warn(
            { err: upgradeError },
            'Managed MCP auto-upgrade startup sweep failed (non-fatal)',
          );
        }
      })();

      // Stage 6 of `docs/plans/260416_agent_reported_state_hardening.md`:
      // unblock stuck `testing` contributions whose connector IS present on
      // disk AND registered in the MCP config. Re-seeds the promotion
      // signal set and routes through the same composition predicate as
      // all other paths — no special-casing. Idempotent; safe to run on
      // every boot.
      try {
        const { runContributionStartupSweep } = await import('./services/contributionStartupSweep');
        const sweepResult = await runContributionStartupSweep();
        if (sweepResult.promoted > 0) {
          logger.info(
            {
              promoted: sweepResult.promoted,
              inspected: sweepResult.inspected,
              promotedIds: sweepResult.promotedIds,
            },
            'Startup sweep promoted stuck contributions',
          );
        }
      } catch (sweepError) {
        logger.warn({ err: sweepError }, 'Contribution startup sweep failed (non-fatal)');
      }

      // Store config path for non-blocking startup after window creation
      // Skip Super-MCP startup for first-run users to avoid Windows Firewall
      // prompts before they see onboarding. Super-MCP will start when Klavis is configured.
      superMcpConfigPath = resolvedPath;
      superMcpSkipForFirstRun = isFirstRun;
      
      if (isFirstRun) {
        logger.info('Deferring Super-MCP startup for first-run user - will start after onboarding');
      }
      }
    }
  }

  logStartup('MCP config ready');

  // Secondary trigger for the Office sidecar eager-start. In dev/HMR the
  // `.once('did-finish-load')` hook can miss the initial load; this ensures
  // we always attempt to eager-start once the MCP config path is known.
  // The helper is idempotent and guarded, so double-invocation is safe.
  tryEagerStartOfficeSidecar('post-coreStartup');

  // Start local model proxy server if a profile is active
  // This must run after settings are loaded but before any agent turns
  {
    const settings = settingsStore.store;
    const activeProfile = getWorkingModelProfile(settings);
    if (activeProfile) {
      const { proxyManager } = await import('./services/localModelProxyServer');
      try {
        // For local profiles: start Ollama and preload model into VRAM before starting proxy
        if (activeProfile.providerType === 'local') {
          const { ensureOllamaForLocalProfile } = await import('./ipc/settingsHandlers');
          await ensureOllamaForLocalProfile(activeProfile);
        }
        await proxyManager.setBaseProfile(activeProfile);
        const proxyUrl = proxyManager.getUrl();
        logger.info({ proxyUrl, profileName: activeProfile.name }, 'Local model proxy server started on app ready');
      } catch (error) {
        logger.error({ err: error }, 'Failed to start local model proxy server on app ready');
      }
    }
  }

  // Start tutorial player server for YouTube embed workaround
  // YouTube iframes require valid HTTP Referer headers which file:// protocol cannot provide
  // This lightweight localhost server serves a wrapper page that can send proper headers
  {
    const { startTutorialPlayerServer } = await import('./services/tutorialPlayerServer');
    try {
      const port = await startTutorialPlayerServer();
      logger.info({ port }, 'Tutorial player server started on app ready');
    } catch (error) {
      logger.error({ err: error }, 'Failed to start tutorial player server on app ready');
    }
  }

  ipcMain.on('runtime-config:sync', (event) => {
    event.returnValue = getRuntimeConfigForRenderer();
  });

  ipcMain.handle('runtime-config:get', async () => {
    return getRuntimeConfigForRenderer();
  });

  // OSS no-phone-home bridge (B6.a): expose the user's LOCAL_ONLY
  // settings.telemetry creds so the OSS renderer reads USER creds, never
  // runtimeConfig/env. Returns null in enterprise builds (renderer keeps its
  // env path) — see getTelemetryConfigForRenderer.
  ipcMain.on('telemetry-config:sync', (event) => {
    event.returnValue = getTelemetryConfigForRenderer();
  });
  ipcMain.handle(
    'sentry:capture-exception',
    (_event, payload: { message?: string; name?: string; stack?: string; context?: Record<string, unknown> } | null) => {
      if (!payload || typeof payload !== 'object') {
        return { eventId: captureMainException(new Error('Unknown renderer exception')) };
      }
      const { message, name, stack, context } = payload;
      const error = new Error(message && message.trim() ? message : 'Renderer exception');
      if (name && name.trim()) {
        error.name = name.trim();
      }
      if (stack && stack.trim()) {
        error.stack = stack.trim();
      }
      const eventId = captureMainException(error, context ? { extra: context } : undefined);
      return { eventId }; 
    }
  );

  ipcMain.handle(
    'sentry:capture-message',
    // 'info' deliberately absent from the level union — raw info-level captures
    // are forbidden (Stage 5 of docs/plans/260610_improve-sentry-noise/PLAN.md);
    // the wire contract (src/shared/ipc/channels/misc.ts) is narrowed in lockstep.
    (_event, payload: { message?: string; level?: 'warning' | 'error' | 'fatal'; context?: Record<string, unknown> } | null) => {
      if (!payload || typeof payload !== 'object' || typeof payload.message !== 'string') {
        return { eventId: null };
      }
      const trimmed = payload.message.trim();
      if (!trimmed) {
        return { eventId: null };
      }
      // Wire `level` is optional; an absent level must NOT fall through to
      // Sentry's silent 'info' default (invisible to the raw-level guards) —
      // default to 'warning'. Both renderer senders send 'warning' today.
      // (Previously the level was also dropped whenever `context` was absent.)
      const eventId = captureMainMessage(trimmed, {
        level: payload.level ?? 'warning',
        ...(payload.context ? { extra: payload.context } : {}),
      });
      return { eventId };
    }
  );

  // E2E test cleanup API — only registered when running in E2E test mode
  if (process.env.REBEL_E2E_TEST_MODE === '1') {
    ipcMain.handle('e2e:clear-pending-approvals', async () => {
      const { clearAllPendingApprovals, clearAllPendingMemoryApprovals, clearAllPendingWriteApprovals } = await import('./services/safety');
      clearAllPendingApprovals();
      clearAllPendingMemoryApprovals();
      clearAllPendingWriteApprovals();
      return { success: true };
    });

    ipcMain.handle('e2e:clear-all-sessions', async () => {
      // Stage 3: intent ('user-delete') + factory-reset ledger clear —
      // including on the partial-failure early-return path — live in the
      // testable core helper. See clearAllSessionsForE2eReset().
      const { clearAllSessionsForE2eReset } = await import('@core/services/e2eSessionReset');
      return clearAllSessionsForE2eReset(getIncrementalSessionStore());
    });

    ipcMain.handle('e2e:inject-tool-approval', async (_event, request: import('./services/safety').PersistedToolApprovalRequest) => {
      const { addPendingApproval } = await import('./services/safety');
      addPendingApproval(request);
      broadcastToAllWindows('tool-safety:approval-request', request);
      return { success: true };
    });

    ipcMain.handle('e2e:inject-memory-approval', async (_event, request: Record<string, unknown>) => {
      const { addPendingMemoryApproval } = await import('./services/safety');
      // Normalize broadcast-shaped payloads (nested destination) to flat persisted shape.
      // Tests send the same shape as real-time broadcasts (destination.path, destination.spaceName),
      // but the store and hydration path expect flat fields (filePath, spaceName).
      const dest = request.destination as Record<string, unknown> | undefined;
      const persisted = {
        toolUseId: request.toolUseId as string,
        originalTurnId: (request.originalTurnId as string) ?? '',
        originalSessionId: (request.originalSessionId as string) ?? '',
        turnId: (request.turnId as string) ?? '',
        sessionId: (request.sessionId as string) ?? '',
        filePath: (dest?.path as string) ?? (request.filePath as string) ?? '',
        spaceName: (dest?.spaceName as string) ?? (request.spaceName as string) ?? '',
        summary: (request.summary as string) ?? '',
        content: (request.content as string) ?? (request.contentPreview as string) ?? '',
        timestamp: (request.timestamp as number) ?? Date.now(),
        sensitivityReason: request.sensitivityReason as string | undefined,
        hasSpaceOverride: request.hasSpaceOverride as boolean | undefined,
        privateMode: request.privateMode as boolean | undefined,
        spacePath: (dest?.spacePath as string) ?? (request.spacePath as string | undefined),
        sharing: (dest?.sharing ?? request.sharing) as 'private' | 'restricted' | 'company-wide' | 'public' | undefined,
        contentPreview: request.contentPreview as string | undefined,
        approvalKind: request.approvalKind as 'memory_write' | 'shared_skill_checkpoint' | undefined,
        staged: request.staged as boolean | undefined,
        isNewFile: (dest?.isNew as boolean | undefined) ?? (request.isNewFile as boolean | undefined),
      };
      addPendingMemoryApproval(persisted);
      // Broadcast the original request shape (renderer subscription normalizes it)
      broadcastToAllWindows('memory:write-approval-request', request);
      return { success: true };
    });

    ipcMain.handle('e2e:seed-hero-choice', async (_event, result: import('@core/heroChoiceTypes').HeroChoiceResult) => {
      const { addHeroChoiceEntry } = await import('@core/services/heroChoiceStore');
      addHeroChoiceEntry(result);
      broadcastToAllWindows('hero-choice:updated', {});
      return { success: true };
    });

    ipcMain.handle('e2e:seed-coaching', async (_event, evaluation: import('@shared/types').SessionCoachingEvaluation) => {
      sessionCoachingScheduler.seedEvaluationForTesting(evaluation);
      return { success: true };
    });

    ipcMain.handle(
      'e2e:seed-staged-call',
      async (
        _event,
        input: Partial<import('./services/safety/stagedToolCallsService').StageToolCallInput> = {},
      ) => {
        const { stageToolCall } = await import('./services/safety/stagedToolCallsService');

        const stagedResult = stageToolCall({
          sessionId: input.sessionId ?? 'e2e-session',
          turnId: input.turnId ?? '',
          mcpPayload: input.mcpPayload ?? {
            packageId: 'e2e-pkg',
            toolId: 'send_email',
            args: {},
          },
          displayName: input.displayName ?? 'Send email',
          toolCategory: input.toolCategory ?? 'side-effect',
          riskLevel: input.riskLevel ?? 'high',
          reason: input.reason ?? 'Seeded staged tool call for E2E testing',
          allowPermanentTrust: input.allowPermanentTrust ?? false,
          blockedBy: input.blockedBy ?? 'eval_error',
          coalesceKey: input.coalesceKey,
          automationId: input.automationId,
          automationName: input.automationName,
        });
        const stagedCall = stagedResult.call;

        broadcastToAllWindows('tool-safety:staged-call', {
          id: stagedCall.id,
          sessionId: stagedCall.sessionId,
          displayName: stagedCall.displayName,
          packageId: stagedCall.mcpPayload.packageId,
          toolId: stagedCall.mcpPayload.toolId,
          riskLevel: stagedCall.riskLevel,
          reason: stagedCall.reason,
          timestamp: stagedCall.timestamp,
          allowPermanentTrust: stagedCall.allowPermanentTrust,
          blockedBy: stagedCall.blockedBy,
          automationId: stagedCall.automationId,
          automationName: stagedCall.automationName,
        });

        return { success: true, id: stagedCall.id };
      },
    );

    ipcMain.handle(
      'e2e:seed-staged-file',
      async (_event, input: Partial<import('./services/safety/cosPendingService').WriteToPendingOptions> = {}) => {
        const { writeToPending } = await import('./services/safety/cosPendingService');

        const stagedFile = await writeToPending({
          destinationPath: input.destinationPath ?? 'Chief-of-Staff/notes/e2e-seeded.md',
          content: input.content ?? '# E2E Seeded Pending File\n\nSeeded in REBEL_E2E_TEST_MODE.\n',
          sessionId: input.sessionId ?? 'e2e-session',
          summary: input.summary ?? 'Seeded staged file for E2E testing',
          spaceName: input.spaceName ?? 'Chief-of-Staff',
          blockedBy: input.blockedBy ?? 'eval_error',
          baseHash: input.baseHash,
          sharing: input.sharing,
          transcriptMeta: input.transcriptMeta,
          approvalKind: input.approvalKind,
          authorLabel: input.authorLabel,
          toolUseId: input.toolUseId,
          coalesceKey: input.coalesceKey,
        });

        if (!stagedFile) {
          return { success: false, id: null, reason: 'no-workspace' };
        }

        broadcastToAllWindows('memory:staged-files-changed', {});
        return { success: true, id: stagedFile.id };
      },
    );

    // REBEL-62A Stage 3: seed a synthetic conflict-copy cleanup plan so the
    // available-cleanup toast can be driven + a confirm exercises the REAL
    // reload+move path. Writes identical parent/conflict file pairs on disk,
    // a detect manifest under userData keyed by runId, then broadcasts.
    ipcMain.handle(
      'e2e:seed-conflict-cleanup-plan',
      async (
        _event,
        input: {
          runId?: string;
          spaceName?: string;
          spaceRootAbsPath: string;
          quarantineCount?: number;
          needsReviewCount?: number;
          sample?: string[];
        },
      ) => {
        const nodeFs = await import('node:fs/promises');
        const nodePath = await import('node:path');
        const nodeCrypto = await import('node:crypto');
        const { CONFLICT_CLEANUP_RUNS_DIRNAME } = await import(
          '@core/services/spaceMaintenanceService'
        );

        const runId = input.runId ?? `e2e-cleanup-${Date.now()}`;
        const spaceName = input.spaceName ?? 'E2E-Space';
        const spaceRoot = input.spaceRootAbsPath;
        const quarantineCount = Math.max(0, input.quarantineCount ?? 3);
        const needsReviewCount = Math.max(0, input.needsReviewCount ?? 0);

        if (!spaceRoot) {
          return {
            success: false,
            runId,
            spaceRootAbsPath: spaceRoot ?? '',
            quarantineCount: 0,
            needsReviewCount: 0,
            sample: [],
            reason: 'missing spaceRootAbsPath',
          };
        }

        const sha256 = (buf: Buffer): string =>
          nodeCrypto.createHash('sha256').update(buf).digest('hex');

        // Build `quarantineCount` identical parent→conflict pairs on disk.
        // Each conflict is byte-identical to its immediate parent so the real
        // planner (and the execute rehash-guard) treat them as quarantine.
        const conflictRelPaths: string[] = [];
        const rows: Array<Record<string, unknown>> = [];
        try {
          await nodeFs.mkdir(spaceRoot, { recursive: true });
          for (let i = 0; i < quarantineCount; i++) {
            const baseRel = `notes/e2e-doc-${i}.md`;
            const conflictRel = `notes/e2e-doc-${i} (1).md`;
            const content = Buffer.from(`# E2E seeded duplicate ${i}\n\nIdentical body.\n`, 'utf8');
            const baseAbs = nodePath.join(spaceRoot, baseRel);
            const conflictAbs = nodePath.join(spaceRoot, conflictRel);
            await nodeFs.mkdir(nodePath.dirname(baseAbs), { recursive: true });
            await nodeFs.writeFile(baseAbs, content);
            await nodeFs.writeFile(conflictAbs, content);
            const hash = sha256(content);
            conflictRelPaths.push(conflictRel);
            rows.push({
              runId,
              timestamp: Date.now(),
              relPath: conflictRel,
              immediateParent: baseRel,
              label: 'numbered-copy',
              provider: 'unknown',
              hash,
              action: 'quarantine',
              reason: 'identical-to-immediate-parent',
            });
          }
          for (let j = 0; j < needsReviewCount; j++) {
            rows.push({
              runId,
              timestamp: Date.now(),
              relPath: `notes/e2e-review-${j} (1).md`,
              immediateParent: `notes/e2e-review-${j}.md`,
              label: 'copy-of',
              provider: 'unknown',
              hash: null,
              action: 'review',
              reason: 'differing-from-parent',
            });
          }

          // Write the manifest under userData so executeConflictCopyCleanupFromMain
          // (which resolves manifestDir from app.getPath('userData')) reloads it.
          const userDataDir = app.getPath('userData');
          const manifestPath = nodePath.join(
            userDataDir,
            CONFLICT_CLEANUP_RUNS_DIRNAME,
            `${runId}.jsonl`,
          );
          await nodeFs.mkdir(nodePath.dirname(manifestPath), { recursive: true });
          await nodeFs.writeFile(
            manifestPath,
            rows.map((r) => JSON.stringify(r)).join('\n') + '\n',
            'utf8',
          );
        } catch (err) {
          return {
            success: false,
            runId,
            spaceRootAbsPath: spaceRoot,
            quarantineCount: 0,
            needsReviewCount: 0,
            sample: [],
            reason: err instanceof Error ? err.message : String(err),
          };
        }

        const sample = input.sample ?? conflictRelPaths.slice(0, 3);
        broadcastToAllWindows('conflict-cleanup:available', {
          runId,
          spaceRootAbsPath: spaceRoot,
          spaceName,
          quarantineCount,
          needsReviewCount,
          sample,
        });

        return {
          success: true,
          runId,
          spaceRootAbsPath: spaceRoot,
          quarantineCount,
          needsReviewCount,
          sample,
        };
      },
    );

    // GATING packaged interception assertion (PLAN.md 260611_fsevents-shutdown-crash
    // Stage 3a): test-mode-only diagnostic backing the boot-smoke's proof that the
    // fsevents leak-guard's module-cache interception works inside the PACKAGED
    // artifact (the one mechanic unprovable from source — asar/NODE_PATH could yield
    // a second fsevents copy the wrapper never sees). Read-only; registered ONLY
    // under REBEL_E2E_TEST_MODE, so there is no production surface.
    //
    // The `ready` observer lives here (not in workspaceWatcherService — that service
    // is deliberately untouched by this plan): this block runs earlier in the same
    // whenReady handler than the boot-time workspaceWatcherService.start() call
    // below, so the persistent listener cannot miss the boot start's ready event.
    let e2eWorkspaceWatcherReadyObserved = false;
    workspaceWatcherService.on('ready', () => {
      e2eWorkspaceWatcherReadyObserved = true;
    });
    ipcMain.handle('e2e:fsevents-leak-guard-diagnostics', async () => {
      const { getFseventsLeakGuardDiagnostics } = await import('./services/fseventsLeakGuard');
      return {
        platform: process.platform,
        guard: getFseventsLeakGuardDiagnostics(),
        watcher: {
          isWatching: workspaceWatcherService.isWatching(),
          currentDirectory: workspaceWatcherService.getCurrentDirectory(),
          readyObserved: e2eWorkspaceWatcherReadyObserved,
        },
      };
    });

    // Leak-injection hook (final review DA F1): starts ONE raw native fsevents
    // instance via the guard's patched module object and deliberately never
    // stops it — reproducing the chokidar-pool leak so the packaged stress can
    // verify the sweep's force-stop leg end-to-end (expect sweptCount=1 at
    // quit, 0 SIGABRT). Registered ONLY under REBEL_E2E_TEST_MODE; watches an
    // app-owned temp dir, never user data.
    ipcMain.handle('e2e:fsevents-inject-leak', async () => {
      const { injectLeakedFseventsInstanceForTests } = await import('./services/fseventsLeakGuard');
      const nodeFs = await import('node:fs/promises');
      const nodeOs = await import('node:os');
      const watchDir = await nodeFs.mkdtemp(path.join(nodeOs.tmpdir(), 'rebel-e2e-fsevents-leak-'));
      return {
        platform: process.platform,
        watchDir,
        ...injectLeakedFseventsInstanceForTests(watchDir),
      };
    });
  }

  if (isHeadlessCli()) {
    const cliFlags = parseCliFlagsBeforeRuntime();
    const routerConfigPath =
      superMcpConfigPath ?? path.join(getDataPath(), 'mcp', 'super-mcp-router.json');
    const cliSessionLockManager = createSessionLockManager({
      locksDirectory: path.join(getDataPath(), 'sessions-locks'),
      isProcessAlive: defaultIsProcessAlive,
      now: Date.now,
    });
    configureCliSessionPersistence({
      getSessionStore: getIncrementalSessionStore,
      lockManager: cliSessionLockManager,
      ownerKind: 'cli',
      onSessionsSaved,
      onSessionsSavedLocally: (sessions) => cloudRouter.onLocalSessionsSaved(sessions),
    });

    let exitCode = 0;
    let runtime: Awaited<ReturnType<typeof createHeadlessRuntime>> | null = null;
    try {
      if (!cliFlags.noMcp && !isSafeMode()) {
        configureBundledMcpManager({
          userDataDir: app.getPath('userData'),
          resourcesDir: app.isPackaged ? process.resourcesPath : path.resolve(process.cwd(), 'resources'),
          isPackaged: app.isPackaged,
        });

        try {
          const { configureManagedMcpInstallService } = await import(
            './services/managedMcpInstallServiceInstance'
          );
          configureManagedMcpInstallService(app.getPath('userData'));
        } catch (managedInstallInitError) {
          logger.warn(
            { err: managedInstallInitError },
            'Headless CLI failed to configure managed MCP install service (non-fatal; legacy npx path still works)',
          );
        }

        try {
          const { upgradeRebelOssEntriesToManaged, scanForDevPrePublishSentinels } = await import(
            './services/managedMcpAutoUpgrade'
          );
          const upgradeResult = await upgradeRebelOssEntriesToManaged(routerConfigPath);
          if (
            upgradeResult.upgraded.length > 0 ||
            upgradeResult.reinstalled.length > 0 ||
            upgradeResult.failed.length > 0 ||
            upgradeResult.scopeMigrations.length > 0
          ) {
            logger.info(
              {
                upgradedCount: upgradeResult.upgraded.length,
                reinstalledCount: upgradeResult.reinstalled.length,
                skippedCount: upgradeResult.skipped.length,
                failedCount: upgradeResult.failed.length,
                scopeMigrationCount: upgradeResult.scopeMigrations.length,
              },
              'Headless CLI managed MCP auto-upgrade completed',
            );
          }
          await scanForDevPrePublishSentinels();
        } catch (upgradeError) {
          logger.warn(
            { err: upgradeError },
            'Headless CLI managed MCP auto-upgrade failed (non-fatal)',
          );
        }
      }

      runtime = await createHeadlessRuntime({
        userDataDir: app.getPath('userData'),
        resourcesDir: app.isPackaged ? process.resourcesPath : path.resolve(process.cwd(), 'resources'),
        isPackaged: app.isPackaged,
        routerConfigPath,
        getSettings,
        updateSettings,
        loadAgentSessions: () => getIncrementalSessionStore().loadSync(),
        executeAgentTurn,
        preOAuthCallHook: async () => {
          await DEFAULT_CODEX_AUTH_PROVIDER.getAccessToken();
        },
        memoryUpdateDeps: {
          executeAgentTurn: runMemoryUpdateAgentTurn,
          getSettings,
          broadcastMemoryUpdateStatus,
        },
        errorRecoveryDeps: {
          executeAgentTurn: async (
            turnId: string,
            prompt: string,
            options: {
              sessionId: string;
              onEvent: (event: AgentEvent) => void;
              bypassToolSafety?: boolean;
              readOnlyHook?: NonNullable<Parameters<typeof executeAgentTurn>[3]>['memoryWriteHook'];
            },
          ) => {
            const auxiliaryOverrides = resolveActiveWorkingSingleModelAuxiliaryTurnOverrides(getSettings());
            agentTurnRegistry.setEventListener(turnId, options.onEvent);
            try {
              await executeAgentTurn(null, turnId, prompt, {
                sessionId: options.sessionId,
                resetConversation: true,
                bypassToolSafety: options.bypassToolSafety,
                memoryWriteHook: options.readOnlyHook,
                modelOverride: auxiliaryOverrides.modelOverride,
                thinkingModelOverride: auxiliaryOverrides.thinkingModelOverride,
                workingProfileOverrideId: auxiliaryOverrides.workingProfileOverrideId,
                // System-driven error-recovery auxiliary turn (read-only hook,
                // not user-initiated) — exclude from the Chief-of-Staff admission
                // gate (260622 Stage 3). See turnAdmission.admit.
                nonInteractiveTurn: true,
              });
            } finally {
              agentTurnRegistry.deleteEventListener(turnId);
            }
          },
          getSettings,
          notifyRenderer: broadcastErrorRecoveryState,
        },
        afterCoreStartup: async () => {
          if (cliFlags.noMcp || isSafeMode()) return;
          try {
            const { upgradeRebelOssEntriesToManaged, scanForDevPrePublishSentinels } = await import(
              './services/managedMcpAutoUpgrade'
            );
            const upgradeResult = await upgradeRebelOssEntriesToManaged(routerConfigPath);
            if (
              upgradeResult.upgraded.length > 0 ||
              upgradeResult.reinstalled.length > 0 ||
              upgradeResult.failed.length > 0 ||
              upgradeResult.scopeMigrations.length > 0
            ) {
              logger.info(
                {
                  upgradedCount: upgradeResult.upgraded.length,
                  reinstalledCount: upgradeResult.reinstalled.length,
                  skippedCount: upgradeResult.skipped.length,
                  failedCount: upgradeResult.failed.length,
                  scopeMigrationCount: upgradeResult.scopeMigrations.length,
                },
                'Headless CLI managed MCP auto-upgrade completed after core startup',
              );
            }
            await scanForDevPrePublishSentinels();
          } catch (upgradeError) {
            logger.warn(
              { err: upgradeError },
              'Headless CLI post-core managed MCP auto-upgrade failed (non-fatal)',
            );
          }
        },
        skipMcp: cliFlags.noMcp || isSafeMode() || !superMcpConfigPath,
      });

      initCliRuntime({
        runtime,
        appVersion: app.getVersion(),
        getSessionStore: getIncrementalSessionStore,
        lockManager: cliSessionLockManager,
        onSessionsSaved,
        onSessionsSavedLocally: (sessions) => cloudRouter.onLocalSessionsSaved(sessions),
      });

      exitCode = await runCli();
    } catch (error) {
      logger.error({ err: error }, 'Headless CLI run failed');
      exitCode = 1;
    }

    process.exitCode = exitCode;
    if (runtime) {
      try {
        await runtime.cleanup();
      } catch (cleanupError) {
        logger.warn({ err: cleanupError }, 'Headless runtime cleanup failed');
      }
    }
    await gracefulShutdown();
    // Point of no return after graceful shutdown: sweep leaked fsevents
    // instances, then exit (quit-time SIGABRT fix — see finalExit.ts).
    await immediateExitWithFseventsSweep('headless-cli-complete', exitCode);
    return;
  }

  const scheduler = getAutomationScheduler();

  // Run Safety Prompt migration (idempotent — no-ops if already complete).
  // Must run after setSafetyEvaluationService() and automation scheduler init.
  // Uses getLegacyAccessRules() which captures pre-v17 snapshot before migration
  // strips accessRules from definitions.
  const legacyRules = scheduler.getLegacyAccessRules();
  runSafetyPromptMigration({
    userSafetyInstructions: getSettings().userSafetyInstructions,
    toolSafetyLevel: getSettings().toolSafetyLevel,
    automationAccessRules: legacyRules
      .filter((d) => d.accessRules?.trim())
      .map((d) => ({
        automationName: d.name,
        automationDescription: d.description,
        accessRules: d.accessRules ?? '', // guaranteed non-empty by .filter() above
        accessRulesStatus: d.accessRulesStatus,
      })),
  }).then(() => {
    // Post-migration patch: add read-only data access principle to existing prompts.
    // Must run after migration completes (needs migrationComplete flag to be true).
    // Idempotent — no-ops if already applied.
    applyReadOnlyAccessPatch();
    applyDestructiveWordingPatch();
  }).catch((err) => {
    logger.error({ err }, 'Safety Prompt migration failed');
  });

  // ---------------------------------------------------------------------------
  // Performance Diagnostic (always-on, blur/minimize-throttled)
  // ---------------------------------------------------------------------------
  // Periodic memory + CPU + GPU-lifecycle + renderer-lifetime diagnostics.
  // Extracted into `perfDiagnosticService` per Stage 1 of
  // `docs/plans/260423_secondary_process_cpu_observability.md`.
  //
  // Cadence: 5 min foreground, 120 s blurred / minimized (previously paused on
  // blur AND minimize — that 22-min silence gap is now closed).
  //
  // Look for "Memory diagnostic" in logs when investigating beach balls or
  // OOM crashes. Look for "MEMORY LEAK" warnings when tracking down sustained
  // memory growth.
  //
  // Stage 2 (260423): `eventLoopLagMonitor` is started before the diagnostic
  // so main-process event-loop lag (p50/p95/p99/max/min/mean in ms) is
  // included under `eventLoopDelay` on every `Memory diagnostic` emission.
  // The previous dev-only `setImmediate`-based monitor was removed as part
  // of this stage — it was threshold-warn-only and did not surface in logs.
  // ---------------------------------------------------------------------------
  eventLoopLagMonitor = startEventLoopLagMonitor({ logger });
  // Stage 4a (260423): wire the super-mcp telemetry adapter so lifecycle
  // events from the core-safe `superMcpHttpManager.subprocessEvents` flow
  // into `ramTelemetryService`'s named-PID registry. Safe to wire now —
  // the adapter subscribes to the already-constructed singleton manager
  // and registers any currently-running PID immediately.
  superMcpTelemetryDisposer = wireSuperMcpTelemetry();
  perfDiagnosticHandle = startPerfDiagnostic({
    logger,
    getEventLoopLag: () => eventLoopLagMonitor?.sample() ?? null,
    getSuperMcpLifecycle: () => superMcpHttpManager.getSubprocessInfo(),
    getAutomationSchedulerStats: () => {
      const automationState = scheduler.getState();
      return {
        runCount: automationState.runs.length,
        sizeKB: Math.round(JSON.stringify(automationState).length / 1024),
      };
    },
    getSettingsNormalizationStats,
    getSettingsNormalizationWindowedStats,
    getIsKnownPluginCounters,
    getScanSpacePluginsCounters,
    getScanSpacePluginsWindowedCounters,
    getScanSpacesCounters,
    getScanSpacesWindowedCounters,
    getEmbeddingLifecycleStats,
    getIndexerStats,
    getTombstoneStats: () => cloudRouter.getTombstoneStats(),
  });

  
  // ---------------------------------------------------------------------------
  // CPU Profiler (dev:perf only — REBEL_PERF_MODE=1)
  // ---------------------------------------------------------------------------
  // Captures V8 CPU profiles during idle (0 active turns) to diagnose
  // background CPU usage. Writes .cpuprofile + .summary.json to userData.
  // See docs/project/APP_PERFORMANCE_AND_MEMORY.md
  if (!app.isPackaged && process.env.REBEL_PERF_MODE === '1') {
    startLatencyFlushInterval();
    import('./services/cpuProfilerService').then(({ initCpuProfiler }) => {
      initCpuProfiler(() => agentTurnRegistry.getActiveTurnCount());
    }).catch(err => {
      logger.warn({ err }, 'Failed to initialize CPU profiler');
    });
    import('./services/memoryProfilerService').then(({ initMemoryProfiler }) => {
      initMemoryProfiler(
        () => agentTurnRegistry.getActiveTurnCount(),
        // Diagnostics path: include internal sessions for full process metrics.
        () => getIncrementalSessionStore().listSessions({ includeInternal: true }).length,
      );
    }).catch(err => {
      logger.warn({ err }, 'Failed to initialize memory profiler');
    });
  }

  // NB (260423, Stage 2): the former dev-only `setImmediate`-based event
  // loop monitor that lived here has been superseded by
  // `eventLoopLagMonitor` (via `startEventLoopLagMonitor`) wired into the
  // always-on `perfDiagnosticService` above. The new monitor uses
  // `perf_hooks.monitorEventLoopDelay` (native histogram, <1% overhead) and
  // emits p50/p95/p99/max/min/mean on every `Memory diagnostic` line in
  // both foreground and background.

  // Memory update + error recovery are now initialized via initCoreServices above
  initializeTimeSavedDeps();
  if (!isRebelTestMode()) {
    // Deferred to 180s (was 90s) and concurrency lowered to 2 (was 3) to ease
    // file-descriptor pressure during the boot window. This always-on repair
    // scans the whole session corpus opening one file per turn; under fd
    // pressure a transient EMFILE on the SYNCHRONOUS index.json read used to be
    // misclassified as corruption → .bak recovery / rebuild (REBEL-1C8 class,
    // 260617 crash). The sync reads are now EMFILE-retried + transient-aware in
    // incrementalSessionStore; pushing this task further past the
    // boot/sessions:list contention window and yielding between batches reduces
    // the contention at the source. (Still always-on — not disabled.)
    startupScheduler.schedule('time-saved-repair', 180_000, async () => {
      try {
        const { runTimeSavedBackfill, scanTimeSavedBackfillCandidates } = await import('@core/services/timeSavedBackfillService');
        const cutoffMs = Date.parse('2026-04-14T00:00:00.000Z');
        const maxBatches = 12;
        const maxTurnsPerBatch = 50;
        const concurrency = 2;
        // Brief yield between batches so freed file descriptors and the
        // graceful-fs queue can drain before the next batch reopens session
        // files (further reduces boot-window fd contention).
        const interBatchYieldMs = 250;
        const scan = await scanTimeSavedBackfillCandidates({ cutoffMs });
        let candidateOffset = 0;
        let totalAttempted = 0;
        let totalPersisted = 0;
        let totalMinutes = 0;

        for (let batch = 1; batch <= maxBatches; batch += 1) {
          const remainingCandidates = scan.candidates.slice(candidateOffset);
          const summary = await runTimeSavedBackfill({
            cutoffMs,
            maxTurns: maxTurnsPerBatch,
            concurrency,
            preScannedCandidates: remainingCandidates,
          });
          candidateOffset += summary.attempted;
          totalAttempted += summary.attempted;
          totalPersisted += summary.persistedCount;
          totalMinutes += summary.persistedMinutesTotal;

          logger.info(
            {
              batch,
              candidatesFound: summary.candidatesFound,
              attempted: summary.attempted,
              persisted: summary.persistedCount,
              persistedMinutes: summary.persistedMinutesTotal,
              outcomeCounts: summary.outcomeCounts,
            },
            'Time-saved repair batch completed',
          );

          if (summary.candidatesFound === 0 || summary.attempted === 0) break;
          if (summary.persistedCount === 0) {
            logger.info(
              { batch, candidatesFound: summary.candidatesFound, outcomeCounts: summary.outcomeCounts },
              'Time-saved repair paused after no-progress batch',
            );
            break;
          }
          // Yield between batches so freed fds / the graceful-fs queue can drain
          // before the next batch reopens session files (eases fd contention).
          if (batch < maxBatches) {
            await new Promise<void>((resolve) => setTimeout(resolve, interBatchYieldMs));
          }
        }

        logger.info(
          { totalAttempted, totalPersisted, totalMinutes },
          'Time-saved repair run complete',
        );
      } catch (err) {
        logger.warn({ err }, 'Time-saved repair run failed');
      }
    });
  }
  if (!isRebelTestMode()) {
    initializeSessionCoachingScheduler();
    initHeroChoiceScheduler();
    initDailySparkScheduler();
    initializeUseCaseGeneratorDeps();
  } else {
    logger.info('[rebel-test] Session coaching, hero choice, daily spark, and use case generator disabled');
  }

  // Migrate existing use cases from settings to the library (one-time, non-blocking)
  const existingUseCases = getSettings().personalizedUseCases ?? [];
  if (existingUseCases.length > 0) {
    initializeUseCaseLibrary(existingUseCases).catch((err) => {
      logger.warn({ err }, 'Use case library migration failed');
    });
  }

  // Gate all meeting-related services behind meetingBotUnlocked
  // (detectMeetingBotUsageFromHistory already ran during early startup migrations)
  if (getSettings().meetingBotUnlocked === true) {
    // Initialize Desktop SDK for meeting detection (async, non-blocking)
    // Delayed 45s to avoid competing with critical startup tasks
    startupScheduler.schedule(
      'desktop-sdk',
      45_000,
      () =>
        initializeDesktopSdk()
          .then(() => undefined)
          .catch((err) => {
            logger.warn({ err }, 'Desktop SDK initialization failed (meeting detection disabled)');
          }),
    );

    // Initialize physical recording service for Limitless Pendant auto-connect (async, non-blocking)
    initializePhysicalRecording().catch((err) => {
      logger.warn({ err }, 'Physical recording initialization failed');
    });

    // Register quit handlers (crash protection)
    registerLocalRecordingQuitHandler();
    registerQuickCaptureQuitHandler();

    // Resume any pending local uploads that were interrupted (e.g., app restart during upload)
    resumePendingLocalUploads().catch((err) => {
      logger.warn({ err }, 'Failed to resume pending local uploads');
    });

    // Initialize meeting bot service early to start polling for unsaved transcripts
    getMeetingBotService();

    // Cleanup old physical recording entries (no longer used for retry - automation handles catch-up)
    cleanupOldEntries();

    // Wire up transcript event bus to automation scheduler
    // This enables event-triggered automations (e.g., "run when meeting transcript is ready")
    onTranscriptSaved((event: TranscriptSavedEvent) => {
      // Skip automation trigger for already-existing transcripts (deduplication)
      // This prevents duplicate inbox items when the same recording is processed multiple times
      if (event.alreadyExists) {
        logger.info(
          { sourceSystem: event.sourceSystem, sourceUid: event.sourceUid, filePath: event.filePath },
          'Transcript already exists, skipping automation trigger'
        );
        return;
      }

      // Determine the specific event type based on source system
      // 'recall' and 'desktop_sdk' are first-party (Rebel Notetaker), others are external
      const isFirstParty = event.sourceSystem === 'recall' || event.sourceSystem === 'desktop_sdk';
      const eventType = isFirstParty ? 'transcript-ready:rebel' : 'transcript-ready:external';

      // Trigger only the specific event type - scheduler's matching logic will also
      // fire automations configured for generic 'transcript-ready' (via prefix matching)
      // Pass full event context so the automation prompt has all available metadata
      fireAndForget(
        scheduler.triggerByEvent(eventType, {
          sourceSystem: event.sourceSystem,
          sourceUid: event.sourceUid,
          filePath: event.filePath,
          spacePath: event.spacePath,
          meetingTitle: event.meetingTitle,
          startTime: event.startTime,
          participants: event.participants,
          duration: event.duration,
          meetingUrl: event.meetingUrl,
          calendarEventId: event.calendarEventId,
        }),
        'index.onTranscriptSaved.triggerByEvent',
      );

      // Log physical recording events for debugging (analysis is handled by the automation above)
      const isPhysicalRecording = event.sourceSystem === 'limitless' || event.sourceSystem === 'plaud';
      if (isPhysicalRecording) {
        logger.info(
          { sourceSystem: event.sourceSystem, sourceUid: event.sourceUid, filePath: event.filePath, alreadyExists: event.alreadyExists, meetingTitle: event.meetingTitle },
          'Received physical recording transcript event (analysis via automation)'
        );
      }
    });

    // Wire up transcript distribution-ready event to automation scheduler
    // Fires after async upgrade (Recall) or immediately (all other sources)
    onTranscriptDistributionReady((event: TranscriptDistributionReadyEvent) => {
      fireAndForget(
        scheduler.triggerByEvent('transcript-distribution-ready', {
          filePath: event.filePath,
          sourceSystem: event.sourceSystem,
          sourceUid: event.sourceUid,
        }),
        'index.onTranscriptDistributionReady.triggerByEvent',
      );
    });

    // Non-null getter for services inside the gated block (meetingBotUnlocked is true here)
    const getMeetingBotServiceChecked = getMeetingBotService as () => ReturnType<typeof createMeetingBotService>;

    // Initialize auto-schedule service with access to meeting bot service
    // (enables auto-scheduling bots after calendar sync when joinMode === 'auto')
    fireAndForget(
      import('./services/meetingBot/autoScheduleService').then(({ initializeAutoScheduleService }) => {
        initializeAutoScheduleService(getMeetingBotServiceChecked);
      }),
      'index.initializeAutoScheduleService',
    );

    // Initialize Desktop SDK auto-send with access to meeting bot service
    // (enables auto-sending bots when meetings are detected in real-time and joinMode === 'auto')
    fireAndForget(
      import('./services/meetingBot/desktopSdkService').then(({ initializeDesktopSdkAutoSend }) => {
        initializeDesktopSdkAutoSend(getMeetingBotServiceChecked);
      }),
      'index.initializeDesktopSdkAutoSend',
    );

    // Initialize meeting history store (tracks calendar meetings and their transcript outcomes)
    // Must be after calendar sync service so it can subscribe to cache updates
    fireAndForget(
      import('./services/meetingHistoryStore').then(({ initializeMeetingHistoryStore }) => {
        initializeMeetingHistoryStore();
      }),
      'index.initializeMeetingHistoryStore',
    );
  } else {
    logger.info('Meeting bot services skipped (feature not unlocked)');
  }

  // Cloud provisioning quit guard — registered outside meeting bot gate
  // so all users get protection during cloud setup/switching
  registerCloudProvisioningQuitHandler();

  // Calendar sync runs independently of meeting bot — Homepage/Spark depend on it
  initializeCalendarSyncService({
    runHeadlessTurn,
    getSettings,
  });
  {
    const calSettings = getSettings();
    // Reconcile calendar sync automation state with settings (fixes stale persisted state)
    scheduler.setCalendarSyncAutomationEnabled(!!calSettings.calendar?.useOtherCalendarProvider);
    if (!calSettings.calendar?.useOtherCalendarProvider) {
      startupScheduler.schedule('calendar-sync', 30_000, () =>
        startDirectCalendarSync().catch((err) => {
          logger.warn({ err }, 'Direct calendar sync startup failed (non-fatal)');
        })
      );
    } else {
      logger.info('Using LLM-based calendar sync (other calendar providers enabled)');
    }
  }

  // Initialize inbound trigger service (polls for external events like Slack @-mentions)
  if (!isRebelTestMode()) {
    try {
      getInboundTriggerService();
    } catch (err) {
      logger.error({ err }, 'Failed to initialize inbound trigger service — feature disabled');
    }
  } else {
    logger.info('[rebel-test] Inbound trigger service disabled');
  }

  powerMonitor.on('suspend', () => {
    logger.info('System suspend detected - pausing automation scheduler');
    scheduler.enterLowPowerMode('system-suspend');
  });

  powerMonitor.on('resume', () => {
    logger.info('System resume detected - resuming automation scheduler');

    scheduler.exitLowPowerMode('system-resume', (automationId, execute) => {
      startupScheduler.queueAutomationCatchUp(automationId, execute);
    });

    // Super-MCP recovery: check health after brief stabilization delay and restart if dead
    // The delay allows the system to fully wake (network, etc.) before checking
    setTimeout(() => {
      fireAndForget(superMcpHttpManager.ensureRunningAfterResume(), 'index.onResume.superMcpEnsureRunning');
    }, 500);

    // Meeting bot recovery: force poll to refresh stale bot status
    setTimeout(() => {
      try {
        getMeetingBotService()?.forceStatusCheck();
      } catch {
        // Service may not be initialized yet
      }
    }, 2000); // 2s delay for network stabilization
  });

  // NOTE: Battery state (on-battery/on-ac) is now managed by visibilityAwareScheduler.ts
  // via initBatteryScheduler(). Services use createBatteryThrottledInterval() for power-aware polling.

  // ---------------------------------------------------------------------------
  // User Engagement Heartbeat Tracking
  // ---------------------------------------------------------------------------
  // Initialize engagement tracking service for accurate analytics.
  // Sends periodic heartbeats ONLY when user is actively engaged with Rebel.
  // See docs in src/main/services/userEngagementService.ts
  fireAndForget(
    import('./services/userEngagementService').then(({ initUserEngagementService }) => {
      initUserEngagementService();
    }),
    'index.initUserEngagementService',
  );

  // ---------------------------------------------------------------------------
  // Daily Cost Reporting (Analytics)
  // ---------------------------------------------------------------------------
  // Report aggregated costs from local ledger to RudderStack/PostHog.
  // Fire-and-forget: runs once at startup, reports any unreported days.
  // See docs/plans/finished/260131_daily_cost_summary_analytics.md
  import('./services/dailyCostReportingService')
    .then(({ reportUnreportedCosts }) => {
      reportUnreportedCosts().catch((err) => {
        logger.warn({ err }, 'Daily cost reporting failed');
      });
    })
    .catch((err) => {
      logger.warn({ err }, 'Failed to load daily cost reporting service');
    });

  // ---------------------------------------------------------------------------
  // Daily Time Saved Reporting (Analytics)
  // ---------------------------------------------------------------------------
  // Report aggregated time-saved estimates to RudderStack/PostHog.
  // Fire-and-forget: runs once at startup, reports any unreported days.
  // See docs/project/TIME_SAVED.md
  import('./services/dailyTimeSavedReportingService')
    .then(({ reportUnreportedTimeSaved }) => {
      reportUnreportedTimeSaved().catch((err) => {
        logger.warn({ err }, 'Daily time-saved reporting failed');
      });
    })
    .catch((err) => {
      logger.warn({ err }, 'Failed to load daily time-saved reporting service');
    });

  // ---------------------------------------------------------------------------
  // Migrate Legacy Staged Files to CoS Pending
  // ---------------------------------------------------------------------------
  // Migrate any files from the legacy Electron userData staging system to the
  // new Chief-of-Staff pending folder. This must run BEFORE IPC handlers are
  // registered so that the UI sees the migrated files in the correct location.
  // The migration is idempotent: if already done, it no-ops quickly.
  try {
    const migrationResult = await migrateLegacyStagedFiles();
    if (migrationResult.migrated > 0 || migrationResult.failed > 0) {
      logger.info(
        { migrated: migrationResult.migrated, failed: migrationResult.failed, skipped: migrationResult.skipped },
        '[startup] Legacy staged files migration completed'
      );
    }
  } catch (err) {
    // Non-fatal: if migration fails, legacy files remain in place and can be
    // migrated on next startup. Log and continue to ensure app launches.
    logger.warn({ err }, '[startup] Legacy staged files migration failed (non-fatal)');
  }
  logStartup('legacy staging migration');

  // ---------------------------------------------------------------------------
  // Initialize cloud router (must happen BEFORE IPC handler registration)
  // registerHandler() checks cloudRouter.shouldRouteToCloud() on every call,
  // so the router must be ready before any handlers are registered.
  // ---------------------------------------------------------------------------
  cloudRouter.init({ getSettings });

  // Stage 2 refinement-5 (260501 memory-update routing plan): prime the cloud
  // outbox's currentCloudUrl BEFORE cleanupLeakedSessions runs. Without this,
  // durable enqueues during cleanup persist entries with no _cloudUrl provenance;
  // a crash before cloudRouter.updateConnection() then causes those entries to be
  // cleared as "legacy unknown instance" on next load — leaving local file gone
  // AND outbox empty, which lets cloud resurrect the session.
  // Priming makes the durable enqueue+disk-write a complete crash-safe operation.
  {
    const cloudInstanceForPriming = getSettings().cloudInstance;
    if (cloudInstanceForPriming?.mode === 'cloud' && cloudInstanceForPriming.cloudUrl) {
      const { cloudOutbox } = await import('./services/cloud/cloudOutbox');
      cloudOutbox.onConnectionChanged(cloudInstanceForPriming.cloudUrl);
    }
  }

  // Stage 2 refinement (260501 memory-update routing plan): run one-shot startup
  // cleanup before cloud pull begins. This preserves deletion ordering and
  // forwards each cleanup deletion through cloudRouter with explicit source metadata.
  try {
    await getIncrementalSessionStore().cleanupLeakedSessions({
      onSessionDeletedLocally: (sessionId, metadata) =>
        cloudRouter.onLocalSessionDeleted(sessionId, { source: metadata.source }),
    });
  } catch (err) {
    logger.warn({ err }, 'Startup leaked-session cleanup failed');
  }

  const cloudInstance = getSettings().cloudInstance;
  if (cloudInstance?.mode === 'cloud' && cloudInstance.cloudUrl && cloudInstance.cloudToken) {
    cloudRouter.updateConnection(cloudInstance.cloudUrl, cloudInstance.cloudToken).catch((err) => {
      logger.warn({ err }, 'Failed to connect cloud router on startup');
    });
    cloudTokenRelay.start(cloudInstance.cloudUrl, cloudInstance.cloudToken);
    logger.info({ cloudUrl: cloudInstance.cloudUrl }, 'Cloud mode active, connecting to cloud service');

    // Fire-and-forget health check to update lastKnownStatus on startup.
    fireAndForget(
      cloudConnectionReconciler.reconcile({
        writer: 'startup-health',
        cloudUrl: cloudInstance.cloudUrl,
      }),
      'index.startup.cloudConnectionReconcile',
    );

    // If a prior `cloud:migrate` never completed (app quit, crash, power loss
    // mid-extract), reconcile the cloud side so the next migration starts
    // from a clean slate. Fire-and-forget; failures are logged but not fatal.
    // See planning doc Stage 6 (orphan cleanup + reconcile).
    if (cloudInstance.migrationInFlight) {
      const reconcileUrl = cloudInstance.cloudUrl;
      const reconcileToken = cloudInstance.cloudToken;
      (async () => {
        try {
          const { CloudServiceClient } = await import('./services/cloud/cloudServiceClient');
          const client = new CloudServiceClient(reconcileUrl, reconcileToken);
          const res = await client.post('/api/data/reconcile', { target: 'workspace' });
          const state =
            res && typeof res === 'object' && 'state' in res
              ? (res as { state: string }).state
              : 'unknown';
          logger.info({ state }, 'Startup migration reconcile completed');
        } catch (err) {
          logger.warn({ err }, 'Startup migration reconcile failed');
        } finally {
          // Always clear the flag — otherwise we'd re-reconcile on every
          // subsequent launch even after the cloud side is clean.
          const latest = getSettings().cloudInstance;
          if (latest) {
            updateSettings({
              cloudInstance: { ...latest, migrationInFlight: false },
            });
          }
        }
      })().catch((err) => {
        logger.warn({ err }, 'Unexpected error during startup reconcile');
      });
    }
  }
  logStartup('cloud router initialized');

  // ---------------------------------------------------------------------------
  // Register modular IPC handlers BEFORE window creation to avoid race condition
  // where renderer calls IPC before handlers are registered (REBEL-35)
  // ---------------------------------------------------------------------------
  // Stage 1: workspace + settings
  registerLibraryHandlers({
    getSettings,
    getSettingsStore: () => settingsStore,
  });

  registerSettingsHandlers({
    getSettings,
    getSettingsStore: () => settingsStore,
    ensureNormalizedSettings,
    applyVoiceActivationHotkey,
    getPendingVoiceActivationHotkey,
    setPendingVoiceActivationHotkey,
    broadcastDiagnosticsUpdate,
    scheduleDiagnosticsExpiry,
    getWindowForEvent,
    getScheduler: getAutomationScheduler,
  });

  registerAgentErrorHandlers({
    getSettings,
    // 260622 Stage 4: the `recreate-chief-of-staff` recovery action re-provisions
    // the Chief-of-Staff README from the starter template. Mirrors the
    // onboarding/repair provisioning sequence (symlinks + ensureChiefOfStaffSpace
    // with settings.spaces reconciliation) used at coreDirectory set-up
    // (index.ts ~7846 / settingsHandlers.ts).
    recreateChiefOfStaff: async () => {
      const coreDirectory = getSettings().coreDirectory;
      if (!coreDirectory) {
        throw new Error('No workspace folder is set, so Rebel can’t recreate your Chief-of-Staff instructions.');
      }
      await createLibrarySymlink(coreDirectory);
      await createAgentsMdSymlink(coreDirectory);
      await createClaudeMdSymlink(coreDirectory);
      const username = getUsername();
      const variables = username ? { USERNAME: username } : undefined;
      await ensureChiefOfStaffSpace(coreDirectory, variables, {
        getSpaces: () => getSettings().spaces,
        updateSpaces: (spaces) => updateSettings({ spaces }),
      });
    },
  });

  // Stage 2: remaining domain handlers
  registerAppHandlers({
    getSettings,
    isSafeMode,
    setSafeModeEnabled: (enabled: boolean) => {
      isSafeModeEnabled = enabled;
      broadcastSafeModeState();
    },
  });

  registerExportHandlers({
    getWindowForEvent,
  });

  registerMigrationHandlers({
    getSettings,
    getWindowForEvent,
  });

  registerVoiceHandlers({
    getSettings,
    getWindowForEvent,
  });

  const meetingCoachOperatorRegistry: OperatorRegistry = {
    listAvailable: operatorRegistry.listAvailable,
    listAvailableWithDiagnostics: operatorRegistry.listAvailableWithDiagnostics,
    getById: operatorRegistry.getById,
    invalidate: operatorRegistry.invalidateOperatorRegistry,
  };

  // Meeting companion context callbacks — shared by agent IPC handlers and live coach service
  const getMeetingCompanionContextForSession = async (sessionId: string) => {
    const activeBotState = getActiveBotState();
    if (!activeBotState?.botId) {
      return null;
    }
    const session = await getIncrementalSessionStore().getSession(sessionId);
    if (!session?.meetingCompanion) {
      return null;
    }
    const isLinkedCompanion = activeBotState.companionSessionId === sessionId;
    let isMatchingCompanion = false;
    if (!isLinkedCompanion) {
      const pendingTranscripts = getPendingTranscripts();
      const activePending = pendingTranscripts.find(t => t.botId === activeBotState.botId);
      if (activePending?.meetingUrl && session.meetingCompanion.meetingUrl === activePending.meetingUrl) {
        isMatchingCompanion = true;
      }
      if (session.meetingCompanion.botId === activeBotState.botId) {
        isMatchingCompanion = true;
      }
    }
    if (!isLinkedCompanion && !isMatchingCompanion) {
      return null;
    }
    const currentCoachPath = (isLinkedCompanion && activeBotState.coachSkillPath)
      ? activeBotState.coachSkillPath
      : (session.meetingCompanion.coach?.skillPath ?? null);
    const lastInjectedCoachPath = session.meetingCompanion.lastInjectedCoachPath;
    const isFirstTurn = lastInjectedCoachPath === undefined || lastInjectedCoachPath === null;
    const coachChanged = !isFirstTurn && currentCoachPath !== lastInjectedCoachPath;
    const needsCoachContent = (isFirstTurn || coachChanged) && currentCoachPath;
    let coachSkillContent: string | undefined;
    if (needsCoachContent) {
      const canUseCachedPrompt = isLinkedCompanion &&
        activeBotState.coachSkillPath === currentCoachPath &&
        typeof activeBotState.coachPrompt === 'string' &&
        activeBotState.coachPrompt.trim().length > 0;
      if (canUseCachedPrompt) {
        coachSkillContent = activeBotState.coachPrompt;
      } else {
        try {
          const resolvedPrompt = resolveMeetingCoachPrompt(currentCoachPath, meetingCoachOperatorRegistry);
          coachSkillContent = resolvedPrompt.prompt;
          if (isLinkedCompanion && activeBotState.coachSkillPath === currentCoachPath) {
            activeBotState.coachPrompt = resolvedPrompt.prompt;
            activeBotState.coachContentHash = resolvedPrompt.contentHash;
            activeBotState.coachPromptSource = resolvedPrompt.source;
            activeBotState.coachProactiveIntervalMinutes = resolvedPrompt.proactiveIntervalMinutes;
          }
        } catch (error) {
          logger.warn({ currentCoachPath, error }, 'Failed to resolve coach prompt');
        }
      }
    }
    return {
      currentCoachPath,
      lastInjectedCoachPath,
      coachSkillContent,
    };
  };
  const setLastInjectedCoachPathForSession = (sessionId: string, coachPath: string | null) => {
    const store = getIncrementalSessionStore();
    store.getSession(sessionId).then((session) => {
      if (session?.meetingCompanion) {
        session.meetingCompanion.lastInjectedCoachPath = coachPath;
        store.upsertSession(session).catch((error) => {
          logger.warn({ sessionId, error }, 'Failed to save lastInjectedCoachPath');
        });
        logger.debug({ sessionId, coachPath }, 'Updated lastInjectedCoachPath');
      }
    }).catch((error) => {
      logger.warn({ sessionId, error }, 'Failed to load session for lastInjectedCoachPath update');
    });
  };

  // ===== FOCUS CONTEXT INJECTION =====
  // Returns assembled Focus context (calendar + goals) for the first turn of focus-origin sessions.
  // Detection uses the origin hint from the turn request (sent by useFocusConversation).
  const getFocusContextForSession = async (sessionId: string, origin?: string): Promise<string | null> => {
    if (origin !== 'focus') return null;

    try {
      // Check if this is the first turn by loading the session
      const sessions = loadAgentSessions?.() ?? [];
      const session = sessions.find(s => s.id === sessionId);
      // Only inject on first turn (no existing messages or only user's first message)
      if (session && session.messages && session.messages.length > 1) {
        return null;
      }

      const { getCachedMeetings } = await import('./services/meetingCacheStore');
      const { resolveAllSpaceGoals } = await import('./services/focusGoalsResolver');
      const { assembleFocusContextForInjectionV2 } = await import('@core/services/focusContextAssembler');

      const cache = getCachedMeetings();
      const meetings = cache?.meetings ?? [];
      const spaceGoals = await resolveAllSpaceGoals();
      const userTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

      return assembleFocusContextForInjectionV2(meetings, spaceGoals, new Date(), userTimeZone);
    } catch (error) {
      logger.warn({ sessionId, err: error }, 'Failed to assemble Focus context for injection');
      return null;
    }
  };

  // Wire live coach service with meeting companion context (fixes coaching turns losing transcript)
  updateLiveCoachMeetingContext(getMeetingCompanionContextForSession, setLastInjectedCoachPathForSession);

  registerAgentHandlers({
    getWindowForEvent,
    executeAgentTurn,
    executeAgentTurnWithRecovery: (win, turnId, prompt, options) =>
      runDesktopRecoveryAgentTurn({
        win,
        turnId,
        prompt,
        phase: 'post_activity',
        enableRecovery: true,
        agentLoopOptions: options,
      }),
    dispatchAgentEvent,
    getActiveTurnController: (turnId: string) => agentTurnRegistry.getActiveTurnController(turnId),
    getTurnCloseCallback: (turnId: string) => agentTurnRegistry.getTurnCloseCallback(turnId),
    deleteRendererSessionByTurn: (turnId: string) => agentTurnRegistry.deleteRendererSession(turnId),
    cancelExistingTurnForSession: (sessionId: string) => agentTurnRegistry.cancelExistingTurnForSession(sessionId),
    getActiveTurnForSession: (sessionId: string) => agentTurnRegistry.getActiveTurnForSession(sessionId),
    getSettings,
    loadAgentSessions,
    getMeetingCompanionContext: getMeetingCompanionContextForSession,
    setLastInjectedCoachPath: setLastInjectedCoachPathForSession,
    getFocusContext: getFocusContextForSession,
  });

  registerPermissionsHandlers({
    getSettings,
  });

  registerSessionsHandlers({
    loadAgentSessions,
    saveAgentSessions,
    upsertAgentSession: (session) => upsertSessionsWithLocks({
      sessions: [session],
      store: getIncrementalSessionStore(),
      lockManager: guiSessionLockManager,
      ownerKind: 'desktop',
    }),
    sessionLockManager: guiSessionLockManager,
    sessionLockOwnerKind: 'desktop',
    onSessionsSavedLocally: (sessions) => cloudRouter.onLocalSessionsSaved(sessions),
    onSessionDeletedLocally: (id) => cloudRouter.onLocalSessionDeleted(id),
  });

  // Main-process turn checkpointing: writes accumulated events + messages
  // directly to the session file every 15s and at turn end, independent of
  // the renderer's requestIdleCallback save path. Eliminates the renderer as
  // a single point of failure for turn data persistence.
  // See docs/plans/260426_main_process_turn_checkpointing.md
  initTurnCheckpointManager({
    store: getIncrementalSessionStore(),
    lockManager: guiSessionLockManager,
    ownerKind: 'desktop',
    getAccumulator: (turnId) => agentTurnRegistry.peekAccumulator(turnId),
    onCheckpointComplete: (session, reason) => {
      if (reason === 'terminal') {
        cloudRouter.onLocalSessionsSaved([session]);
      }
    },
  });

  // Synchronous session save for beforeunload handler.
  // The async invoke-based save doesn't complete before window closes in dev mode
  // (especially with HMR), causing session loss. This sync handler ensures data
  // is written to disk before the process terminates.
  ipcMain.on('sessions:save-sync', (event, sessions: AgentSession[]) => {
    try {
      // Observability-only AgentSession validation at the IPC boundary
      // (260523 sweep Stage 7, Behavioral Safety F1). Shutdown-time path
      // — kept observe-mode to avoid blocking session persistence on a
      // schema mismatch during quit. See sessionsHandlers.ts for the
      // upgrade-path rationale.
      // observe-mode only: schema mismatch during quit must not block persistence.
      void observingSafeParse({
        schema: z.array(AgentSessionSchema),
        payload: sessions,
        channel: 'sessions:save-sync',
        log: logger,
      });

      event.returnValue = saveAgentSessionsSync(sessions);
    } catch (error) {
      logger.error({ err: error }, 'Sync session save failed');
      event.returnValue = { success: false, error: String(error) };
    }
  });

  registerTasksHandlers({});

  registerAutomationsHandlers({
    getScheduler: getAutomationScheduler,
  });

  registerDemoHandlers({
    getActiveTurnCount: () => agentTurnRegistry.getActiveTurnCount(),
    abortAllTurns: () => agentTurnRegistry.abortAllTurns(),
    broadcastDemoModeChange: (active) => {
      // eslint-disable-next-line no-restricted-syntax -- window-scan-send-allowlisted: demo mode is a genuine all-window state broadcast; migrate later to BroadcastService for consistency.
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) {
          window.webContents.send('demo:mode-changed', { active });
        }
      }
    },
  });

  registerDashboardHandlers({
    getSettings,
  });

  registerSearchHandlers();

  registerSystemHandlers({
    getSettings,
    // Diagnostics bundle should include internal sessions for complete context.
    listSessionSummaries: () => getIncrementalSessionStore().listSessions({ includeInternal: true }),
  });

  registerMiscHandlers({
    getSettings,
    ensureNormalizedSettings,
    loadRuntimeConfig: () =>
      getRuntimeConfigForRenderer() as ReturnType<Parameters<typeof registerMiscHandlers>[0]['loadRuntimeConfig']>,
  });

  registerPrivateMindstoneHandlers(getHandlerRegistry());
  registerGoogleWorkspaceHandlers();
  registerSlackHandlers();
  registerGitHubHandlers();
  // Migrate under-scoped GitHub tokens left over from the pre-260423 OAuth
  // flow that requested zero scopes. Awaited deliberately — if we don't wait,
  // Super-MCP (spawned later at `startSuperMcpWithRetries`) can race us and
  // load the stale tokens into its in-memory OAuth cache before we unlink the
  // files. Failures are swallowed (logged only) so migration never blocks
  // startup. Disk I/O is trivial (one readFile + two unlinks in the worst
  // case). See docs-private/investigations/260423_github_mcp_partial_auth_empty_scopes.md.
  try {
    await migrateStaleGitHubTokens();
  } catch (err) {
    createScopedLogger({ service: 'github-auth' }).warn(
      { err },
      'migrateStaleGitHubTokens failed',
    );
  }
  registerCodexHandlers({
    getScheduler: getAutomationScheduler,
  });
  registerSubscriptionHandlers();
  registerIdentityHandlers();
  registerOpenRouterHandlers();
  const { registerBtsProxyProviders } = await import('@core/services/behindTheScenesClient');
  // Wire OpenRouter proxy access into BTS (core → main bridge).
  // Providers are async: the proxy may have auto-stopped (3s idle timer) between turns,
  // so BTS tasks restart it on demand via ensureRunningForBts().
  const { proxyManager: btsProxyManager } = await import('./services/localModelProxyServer');
  registerBtsProxyProviders({
    url: async () => {
      if (!btsProxyManager.isRunning()) {
        await btsProxyManager.ensureRunningForBts();
      }
      return btsProxyManager.getUrl();
    },
    auth: () => btsProxyManager.getAuthToken(),
  });
  // BTS structured-output bypass toast: the core path now broadcasts directly via
  // getBroadcastService(). Both desktop and cloud (mobile) get the notice for free.
  // See src/core/services/behindTheScenesClient.ts → notifyStructuredOutputFallbackBypass.
  registerHubSpotApiAuthOrchestrator();
  registerGoogleWorkspaceApiAuthOrchestrator();
  registerMicrosoftApiAuthOrchestrator();
  registerSlackApiAuthOrchestrator();
  registerHubSpotHandlers();
  registerSalesforceHandlers();
  registerMicrosoftHandlers();
  registerZendeskHandlers();
  registerDiscourseHandlers();
  registerUsageHandlers({
    // Usage insights are user-facing and intentionally exclude internal sessions.
    listSessionSummaries: () => getIncrementalSessionStore().listSessions(),
  });
  registerSafetyHandlers({ getScheduler: getAutomationScheduler });
  registerSafetyPromptHandlers();
  registerSafetyActivityLogHandlers({
    syncCloud: () => cloudRouter.syncSafetyActivityLogFromCloud(),
  });
  registerSkillsHandlers();
  registerOperatorsHandlers();
  registerFeedbackHandlers();
  registerDiagnosticsHandlers();
  registerHtmlPreviewTrustHandlers();
  registerPluginHandlers({ getScheduler: getAutomationScheduler });
  registerBugReportHandlers();
  registerFileConversationHandlers();
  registerUserTasksHandlers();
  registerTodoistHandlers();
  registerMeetingBotHandlers({
    getMeetingBotService,
  });
  registerUseCaseLibraryHandlers();
  registerCalendarHandlers({
    getSettings,
    triggerCalendarSync: async () => {
      await syncCalendarCache();
    },
  });
  registerSpaceMaintenanceHandlers({ getSettings });
  registerErrorRecoveryHandlers();
  registerLocalSttHandlers(() => mainWindow);
  registerLocalInferenceHandlers();

  // Register local STT providers for desktop (lazy imports to avoid loading native binaries eagerly)
  setLocalTranscriber(async (buffer, mimeType) => {
    const { transcribeWithLocalModel } = await import('./services/localSttService');
    return transcribeWithLocalModel(buffer, mimeType);
  });

  registerLocalTranscriber('local-moonshine', async (buffer, mimeType) => {
    const { transcribeWithMoonshine } = await import('./services/moonshineTranscriber');
    return transcribeWithMoonshine(buffer, mimeType);
  });

  // Register Codex voice fallback (uses ChatGPT subscription for STT when no API key)
  const CODEX_VOICE_TRANSCRIBE_URL = 'https://chatgpt.com/backend-api/transcribe';
  setCodexVoiceConfig({
    transcribeEndpointUrl: CODEX_VOICE_TRANSCRIBE_URL,
    isConnected: isCodexConnected,
    getAccessToken: getCodexAccessToken,
    getAccountId: getCodexAccountId,
    forceRefreshToken: forceRefreshCodexAccessToken,
  });

  registerPhysicalRecordingHandlers();
  registerQuickCaptureHandlers();
  registerPlaudHandlers();
  registerMcpAppsHandlers();
  registerVersionHandlers();
  registerInboundTriggerHandlers({
    getInboundTriggerService,
  });
  registerSystemImprovementHandlers();
  registerHeroChoiceHandlers();
  registerDailySparkHandlers();
  registerCommunityEventsHandlers();
  registerCommunityVideoRecsHandlers();
  registerFocusHandlers();
  registerFoldersHandlers();
  registerContributionHandlers();
  registerAppBridgeHandlers();
  registerOfficeSidecarHandlers();

  registerCommunityHandlers({
    getCommunityHighlightsService,
    getSettings,
    getSession: (id) => getIncrementalSessionStore().getSession(id),
  });

  // Stage B (260417_approval_consolidation_closeout): instantiate a single
  // per-process ConflictCapabilityService. The secret lives in closure and
  // is never persisted or logged — a process restart invalidates every
  // outstanding token, which is fine because the UI remints on next action.
  const conflictCapabilityService = createConflictCapabilityService();

  // Stage C (260417_approval_consolidation_closeout): per-process IPC
  // dedup cache for the 4 staging channels. Closes the double-fire gap
  // when cloud-client's fetchWithRetry re-dispatches a lost-response
  // retry. In-memory only — restart clears the cache, which is safe.
  const ipcDedupService = createIpcDedupService();

  registerMemoryHandlers({
    getWorkspacePath: () => getSettings().coreDirectory ?? undefined,
    sessionLockManager: guiSessionLockManager,
    sessionLockOwnerKind: 'desktop',
    triggerForgetMemory: async (entryId: string) => {
      const entry = getMemoryHistoryEntry(entryId);
      if (!entry) {
        return { success: false, error: 'Entry not found' };
      }

      // For now, just remove from history
      // TODO: In Phase 3, launch background agent to edit the file
      const removed = removeMemoryHistoryEntry(entryId);
      return { success: removed };
    },
    conflictCapabilityService,
    ipcDedupService,
  });

  registerScratchpadHandlers({
    getSettings,
  });

  // Cloud management handlers (provision, destroy, status, wake, migrate)
  registerCloudHandlers({
    getSettings,
    updateSettings: (patch) => {
      const current = settingsStore.store;
      settingsStore.store = normalizeSettings({ ...current, ...patch });
    },
    loadAgentSessions,
  });

  // Hand ensureMainWindow its window-creation capability only now that all
  // handlers are registered (see createWindowForEnsure declaration).
  createWindowForEnsure = createWindow;
  resolveIpcHandlersReady();
  assertHandlerPresence({
    allChannels,
    registry: getHandlerRegistry(),
    mode: getHandlerPresenceMode({
      isPackaged: app.isPackaged,
      ci: isCiEnvironment(),
    }),
  });
  logStartup('IPC handlers registered');

  // Cloud socket shim removed — was legacy Sprites VM architecture (REBEL_CLOUD_MODE=1).
  // The headless cloud service on Fly Machines replaces it entirely.
  logStartup('cloud socket shim initialized');

  // Update cloud router when cloudInstance settings change
  settingsStore.onDidAnyChange?.((newSettings: AppSettings | undefined) => {
    if (!newSettings) return;
    const ci = newSettings.cloudInstance;
    if (ci?.mode === 'cloud' && ci.cloudUrl && ci.cloudToken) {
      cloudRouter.updateConnection(ci.cloudUrl, ci.cloudToken).catch((err) => {
        logger.warn({ err }, 'Failed to update cloud router connection');
      });
      cloudTokenRelay.start(ci.cloudUrl, ci.cloudToken);
    } else {
      cloudRouter.disconnect();
      fireAndForget(cloudTokenRelay.stop(), 'index.onSettingsChange.cloudTokenRelayStop');
    }

  });

  // Backfill memory history from existing sessions (one-time on first run)
  if (!isBackfillCompleted()) {
    const sessions = loadAgentSessions();
    const backfilledCount = backfillFromSessions(sessions);
    if (backfilledCount > 0) {
      logger.info({ backfilledCount }, 'Backfilled memory history from existing sessions');
    }
  }

  // Backfill skill usage from historical sessions (one-time)
  if (!isSkillUsageBackfillCompleted()) {
    const sessions = loadAgentSessions();
    const extractSkillsUsedForBackfill: Parameters<typeof backfillSkillUsageFromSessions>[1] = (session) =>
      extractSkillsUsed(session as AgentSession);
    const backfilledCount = backfillSkillUsageFromSessions(sessions, extractSkillsUsedForBackfill);
    if (backfilledCount > 0) {
      logger.info({ backfilledCount }, 'Backfilled skill usage from historical sessions');
    }
  }

  // Subscribe to auth state changes BEFORE initializing so we catch restore.
  // The unsubscribe function is intentionally not stored - this listener lives for app lifetime.
  getRebelAuthProvider().onAuthStateChange((state) => {
    identifyUserFromAuthState(state, (email) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('user:email-identified', { email });
      }
    });
  });

  // Initialize authentication state before creating window
  // The listener above will catch the restored auth state broadcast
  await getRebelAuthProvider().initializeAuth();
  logStartup('auth initialized');

  // Set up post-login callback to chain Google Workspace OAuth after Google sign-in
  // This pre-authorizes Gmail/Calendar/Drive so they're ready in onboarding step 4
  getRebelAuthProvider().setPostLoginCallback(async (provider, user) => {
    if (provider !== 'google') {
      logger.debug({ provider }, 'Skipping Google Workspace OAuth for non-Google login');
      return;
    }

    logger.info({ email: user.email }, 'Chaining Google Workspace OAuth after Google sign-in');

    const oauthCredentials = resolveOAuthCredentials(googleCredentialSource);
    if (!oauthCredentials) {
      // Background post-login chaining path (not a user-initiated start-auth IPC entrypoint, returns
      // void) — it tolerates null today and stays non-throwing. We still source the env var names
      // from the structured descriptor so this warn can't drift from the canonical Google guidance.
      const guidance = describeMissingOAuthCredentials('google');
      logger.warn(
        { envVars: guidance.envVars },
        'Google OAuth credentials not configured, skipping Workspace auth',
      );
      return;
    }

    try {
      // This opens another OAuth consent screen for Gmail/Calendar/Drive scopes
      const workspaceEmail = await startGoogleAuth(oauthCredentials.clientId, oauthCredentials.clientSecret);
      logger.info({ workspaceEmail }, 'Google Workspace OAuth completed successfully');
      
      // Create MCP instance so getAccounts() will find this account
      // This mirrors the logic in googleWorkspaceHandlers.ts
      const instanceId = generateInstanceId('GoogleWorkspace', workspaceEmail);
      const sharedDir = path.join(app.getPath('userData'), 'google-workspace-mcp');
      const instanceDir = path.join(sharedDir, instanceId);
      
      // Copy credentials from shared staging dir to instance-specific dir
      const sanitizedEmail = workspaceEmail.replace(/[^a-zA-Z0-9]/g, '-');
      const instanceCredentialsDir = path.join(instanceDir, 'credentials');
      await fs.mkdir(instanceCredentialsDir, { recursive: true });
      
      const sharedTokenPath = path.join(sharedDir, 'credentials', `${sanitizedEmail}.token.json`);
      const instanceTokenPath = path.join(instanceCredentialsDir, `${sanitizedEmail}.token.json`);
      
      try {
        await fs.copyFile(sharedTokenPath, instanceTokenPath);
      } catch (copyErr) {
        logger.warn({ err: copyErr, workspaceEmail }, 'Token file not found in shared dir after OAuth');
        throw new Error('Failed to copy token to instance directory');
      }
      
      // Create single-account accounts.json for this instance
      const instanceAccountsPath = path.join(instanceDir, 'accounts.json');
      await fs.writeFile(instanceAccountsPath, JSON.stringify({
        accounts: [{ email: workspaceEmail, category: 'personal', description: 'Connected via Rebel' }]
      }, null, 2));
      
      // Build and upsert MCP server entry
      const instanceConfig: GoogleWorkspaceInstanceConfig = {
        instanceId,
        email: workspaceEmail,
        description: `${workspaceEmail} - Calendar, Drive, Gmail, Contacts`,
        clientId: oauthCredentials.clientId,
        clientSecret: oauthCredentials.clientSecret,
        accountsPath: path.join(instanceDir, 'accounts.json'),
        credentialsPath: path.join(instanceDir, 'credentials'),
      };
      
      const configPath = resolveMcpConfigPath(getSettings());
      if (configPath) {
        const payload = buildGoogleWorkspaceInstancePayload(instanceConfig);
        await upsertMcpServerEntry(configPath, payload);
        logger.info({ instanceId, workspaceEmail }, 'Created Google Workspace MCP instance');
        
        // Hot-reload Super-MCP to pick up the new instance. Detached by
        // construction: the restart defers (up to 30 min) while agent turns
        // are active; awaiting it here hung the post-login chained-OAuth
        // connect flow (same class as the 260610 disconnect hang).
        reconfigureSuperMcpWithCacheRefreshDetached(configPath, {
          context: 'chained-oauth-connect',
          onError: (reconfigErr) => {
            logger.warn({ err: reconfigErr }, 'Failed to hot-reload Super-MCP (restart may be needed)');
          },
        });
      }
    } catch (error) {
      // Don't fail - user can still connect Gmail/Calendar later in onboarding
      logger.warn({ err: error }, 'Google Workspace OAuth failed (user can retry in onboarding)');
    }
  });

  logStartup('ensureMainWindow() call');
  await ensureMainWindow();
  if (!app.isPackaged && process.env.REBEL_PERF_MODE === '1') {
    initRendererProfiler(() => mainWindow);
    initRendererHeapSnapshotService(() => mainWindow);
  }
  logStartup('window created');
  // Log consolidated startup waterfall after window creation (dev:perf only)
  if (process.env.REBEL_PERF_MODE === '1') {
    setTimeout(() => { logWaterfall(); }, 10_000);
  }

  // SUNSET: Remove after 2026-10-01 (NSIS migration complete)
  // Schedule Squirrel cleanup 60s after window ready (non-blocking, fire-and-forget)
  scheduleSquirrelCleanup();

  // Start calendar preview timer AFTER window exists (shows upcoming meetings in title bar)
  // This runs independently of Desktop SDK - works even if SDK fails
  startCalendarPreviewTimer();

  // =============================================================================
  // FOX-2966: Background Local STT Model Download for First-Time Users
  // =============================================================================
  // Start downloading the local STT model (parakeet) in the background so it's
  // ready by the time the user reaches the voice setup step in onboarding.
  // Non-blocking fire-and-forget — errors are logged but never affect startup.
  if ((process.platform === 'darwin' || process.platform === 'win32') && !isRebelTestMode() && !isE2eTestMode()) {
    // FOX-3081: One-time migration for pre-fix installs — move Parakeet V3
    // model files from the legacy userData path to the FluidAudio-compatible
    // path so the bundled CLI can find them. No-op if already migrated.
    try {
      localSttModelManager.migrateLegacyModelPaths();
    } catch (err) {
      logger.warn({ err }, '[startup] Failed to migrate legacy STT model paths');
    }

    // Clean up any stale staging directories from crashed downloads (all users, all launches)
    try {
      localSttModelManager.cleanupStaleStaging();
    } catch (err) {
      logger.warn({ err }, '[startup] Failed to clean stale STT staging directory');
    }

    // Clean up stale Ollama runtime staging directory from crashed downloads
    try {
      const { ollamaRuntimeManager } = await import('./services/ollamaRuntimeManager');
      ollamaRuntimeManager.cleanupStaleStaging();
    } catch (err) {
      logger.warn({ err }, '[startup] Failed to clean stale Ollama staging directory');
    }

    const currentSettings = getSettings();
    const voiceProvider = currentSettings.voice?.provider;
    const isFirstTimeUser = !currentSettings.onboardingFirstCompletedAt && !currentSettings.onboardingCompleted;
    if (voiceProvider === 'local-parakeet' && isFirstTimeUser) {
      fireAndForget((async () => {
        try {
          const status = await localSttModelManager.getStatus();
          if (!status.installed && !status.downloading) {
            logger.info('[startup] Starting background local STT model download for onboarding');
            await localSttModelManager.startDownload(mainWindow);
          }
        } catch (err) {
          logger.warn({ err }, '[startup] Failed to start background local STT model download');
        }
      })(), 'index.startup.localSttModelDownload');
    }
  }

  // =============================================================================
  // Non-blocking Super-MCP Startup
  // =============================================================================
  // Start Super-MCP HTTP server in the background AFTER window creation.
  // This ensures the user sees the app immediately while tools initialize.
  // Success/failure is communicated via IPC push events for renderer handling.
  // Skip entirely in Safe Mode to allow troubleshooting.
  if (isSafeMode()) {
    logger.info('Safe Mode: Skipping Super-MCP startup for troubleshooting');
  } else if (superMcpConfigPath && !superMcpSkipForFirstRun) {
    logger.info(
      { mode: 'http', configPath: superMcpConfigPath },
      'Starting Super-MCP in HTTP mode (non-blocking)'
    );
    logStartup('Super-MCP startup initiated');

    // Fire-and-forget with completion handler
    void startSuperMcpWithRetries(superMcpConfigPath, { logContext: 'app-ready' })
      .then((result) => {
        if (result.success) {
          logStartup('Super-MCP ready');
          logger.info(
            { 
              port: result.port, 
              state: superMcpHttpManager.getState(),
              attempts: result.attempts
            },
            'Super-MCP HTTP server ready - concurrent agent turns will not conflict'
          );
          // Notify renderer of successful startup
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('super-mcp:startup-succeeded', {
              port: result.port ?? 0,
              attempts: result.attempts,
              skippedServers: result.skippedServers,
            });
            // Emit canonical ready event (tools are available)
            mainWindow.webContents.send('super-mcp:ready', {
              success: true,
              port: result.port ?? 0,
            });
          }

          // Tool index refresh after Super-MCP starts
          // Deferred on Windows to avoid GPU/LanceDB contention during startup
          // (Windows embedding performance issues cause 70+ second refreshes during startup)
          if (process.platform === 'win32') {
            startupScheduler.schedule('tool-index-refresh', 120_000, async () => {
              try {
                await initializeToolIndex();
                const toolResult = await refreshToolIndex();
                if (toolResult.success) {
                  logger.info({ toolCount: toolResult.total }, 'Tool index refreshed (deferred startup)');
                } else {
                  logger.warn({ toolResult }, 'Tool index refresh returned failure');
                }
              } catch (err) {
                logger.warn({ err }, 'Tool index refresh failed');
                // Report LanceDB failures on Windows to Sentry (likely missing VC++ Redistributable)
                captureMainException(err instanceof Error ? err : new Error(String(err)), {
                  tags: { area: 'lancedb', index: 'tool' },
                  extra: { context: 'LanceDB initialization failed on Windows - may indicate missing VC++ Redistributable' },
                });
              }
            });
          } else {
            // Non-Windows: refresh immediately (existing behavior - macOS GPU works well)
            initializeToolIndex()
              .then(() => refreshToolIndex())
              .then(toolResult => {
                if (toolResult.success) {
                  logger.info({ toolCount: toolResult.total }, 'Tool index refreshed after Super-MCP startup');
                } else {
                  logger.warn({ toolResult }, 'Tool index refresh returned failure - tools may not be indexed');
                }
              })
              .catch(err => {
                logger.warn({ err }, 'Failed to refresh tool index after Super-MCP startup');
              });
          }
        } else {
          const errorCategory: SafeModeErrorCategory = result.failureCategory ?? 'unknown';
          
          logger.error(
            { 
              error: result.error, 
              errorCategory,
              attempts: result.attempts
            },
            'Failed to start Super-MCP HTTP server after all retry attempts - tools will not be available until app restart'
          );
          // Notify renderer of startup failure with sanitized payload (no raw error message)
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('super-mcp:startup-failed', {
              failureCategory: errorCategory,
              attempts: result.attempts
            });
            // Emit canonical ready event (graceful degradation - no tools but app usable)
            mainWindow.webContents.send('super-mcp:ready', {
              success: false,
              errorCategory,
            });
          }
        }
      })
      .catch((err) => {
        // Handle unexpected errors in the startup promise chain
        const sentryEventId = captureMainException(err, {
          tags: { area: 'startup', component: 'super-mcp', startup_context: 'app-ready' }
        });
        const errorCategory: SafeModeErrorCategory = categorizeError(err);
        
        logger.error({ err, errorCategory, sentryEventId }, 'Unexpected error during Super-MCP startup');
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('super-mcp:startup-failed', {
            failureCategory: errorCategory,
            attempts: 0
          });
          // Emit canonical ready event (graceful degradation - no tools but app usable)
          mainWindow.webContents.send('super-mcp:ready', {
            success: false,
            errorCategory,
          });
        }
      });
  }

  // =============================================================================
  // Application Menu
  // =============================================================================
  // Sets up the native application menu with standard OS roles.
  // This enables keyboard shortcuts like Ctrl+Cmd+F (fullscreen) on macOS and
  // standard Edit menu operations (copy/paste/etc.) across all platforms.
  const isMac = process.platform === 'darwin';
  const menuTemplate: Electron.MenuItemConstructorOptions[] = [
    // macOS app menu (required for standard behavior)
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              {
                label: 'Settings…',
                accelerator: 'Cmd+,',
                click: () => {
                  // eslint-disable-next-line no-restricted-syntax -- window-scan-send-allowlisted: focused-window menu fallback, not notification/action targeting; migrate later to injected menu target helper.
                  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
                  if (win && !win.isDestroyed()) {
                    win.webContents.send('menu:open-settings');
                  }
                },
              },
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const },
            ],
          },
        ]
      : []),
    // Edit menu - enables copy/paste/undo in text fields
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        ...(isMac
          ? [
              { role: 'pasteAndMatchStyle' as const },
              { role: 'delete' as const },
              { role: 'selectAll' as const },
            ]
          : [{ role: 'delete' as const }, { type: 'separator' as const }, { role: 'selectAll' as const }]),
        { type: 'separator' as const },
        {
          label: 'Find',
          accelerator: 'CmdOrCtrl+F',
          click: () => {
            // eslint-disable-next-line no-restricted-syntax -- window-scan-send-allowlisted: focused-window menu fallback, not notification/action targeting; migrate later to injected menu target helper.
            const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
            if (win && !win.isDestroyed()) {
              win.webContents.send('menu:find');
            }
          },
        },
        {
          label: 'Find Next',
          accelerator: 'CmdOrCtrl+G',
          click: () => {
            // eslint-disable-next-line no-restricted-syntax -- window-scan-send-allowlisted: focused-window menu fallback, not notification/action targeting; migrate later to injected menu target helper.
            const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
            if (win && !win.isDestroyed()) {
              win.webContents.send('menu:find-next');
            }
          },
        },
        {
          label: 'Find Previous',
          accelerator: 'CmdOrCtrl+Shift+G',
          click: () => {
            // eslint-disable-next-line no-restricted-syntax -- window-scan-send-allowlisted: focused-window menu fallback, not notification/action targeting; migrate later to injected menu target helper.
            const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
            if (win && !win.isDestroyed()) {
              win.webContents.send('menu:find-previous');
            }
          },
        },
      ],
    },
    // View menu - fullscreen toggle and dev tools
    // Note: On macOS, the OS may also inject its own "Enter Full Screen" item into View menus.
    // We include our explicit togglefullscreen anyway to ensure the shortcut works reliably.
    {
      label: 'View',
      submenu: [
        { role: 'togglefullscreen' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        ...(app.isPackaged
          ? []
          : [
              { type: 'separator' as const },
              { role: 'reload' as const },
              { role: 'forceReload' as const },
              { role: 'toggleDevTools' as const },
            ]),
      ],
    },
    // Window menu
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac
          ? [{ type: 'separator' as const }, { role: 'front' as const }, { type: 'separator' as const }, { role: 'window' as const }]
          : [{ role: 'close' as const }]),
      ],
    },
    // Help menu - aligned with in-app Help menu (question mark icon)
    {
      role: 'help',
      submenu: [
        {
          label: 'Ask Rebel for Help',
          click: () => {
            // eslint-disable-next-line no-restricted-syntax -- window-scan-send-allowlisted: focused-window menu fallback, not notification/action targeting; migrate later to injected menu target helper.
            const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
            if (win && !win.isDestroyed()) {
              win.webContents.send('menu:ask-rebel-help');
            }
          },
        },
        {
          label: 'Ask the Community…',
          click: () => {
            shell.openExternal('https://rebels.mindstone.com/').catch((err) => {
              logger.warn({ err }, 'Failed to open community URL');
            });
          },
        },
        {
          label: 'Watch Tutorials…',
          click: () => {
            // eslint-disable-next-line no-restricted-syntax -- window-scan-send-allowlisted: focused-window menu fallback, not notification/action targeting; migrate later to injected menu target helper.
            const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
            if (win && !win.isDestroyed()) {
              win.webContents.send('menu:watch-tutorials');
            }
          },
        },
        { type: 'separator' as const },
        {
          label: 'Keyboard Shortcuts…',
          accelerator: 'CmdOrCtrl+/',
          click: () => {
            // eslint-disable-next-line no-restricted-syntax -- window-scan-send-allowlisted: focused-window menu fallback, not notification/action targeting; migrate later to injected menu target helper.
            const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
            if (win && !win.isDestroyed()) {
              win.webContents.send('menu:show-shortcuts');
            }
          },
        },
        {
          label: 'Send Feedback…',
          click: () => {
            // eslint-disable-next-line no-restricted-syntax -- window-scan-send-allowlisted: focused-window menu fallback, not notification/action targeting; migrate later to injected menu target helper.
            const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
            if (win && !win.isDestroyed()) {
              win.webContents.send('menu:report-bug');
            }
          },
        },
        { type: 'separator' as const },
        {
          label: 'Check for Updates…',
          click: () => {
            // eslint-disable-next-line no-restricted-syntax -- window-scan-send-allowlisted: focused-window menu fallback, not notification/action targeting; migrate later to injected menu target helper.
            const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
            if (win && !win.isDestroyed()) {
              win.webContents.send('menu:check-for-updates');
            }
          },
        },
        {
          label: 'Download Diagnostics…',
          click: () => {
            // eslint-disable-next-line no-restricted-syntax -- window-scan-send-allowlisted: focused-window menu fallback, not notification/action targeting; migrate later to injected menu target helper.
            const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
            if (win && !win.isDestroyed()) {
              win.webContents.send('menu:download-diagnostics');
            }
          },
        },
        // Only show "Start Demo Mode" when NOT already in demo mode
        ...(isDemoModeActive() ? [] : [
          { type: 'separator' as const },
          {
            label: 'Start Demo Mode…',
            click: () => {
              // eslint-disable-next-line no-restricted-syntax -- window-scan-send-allowlisted: focused-window menu fallback, not notification/action targeting; migrate later to injected menu target helper.
              const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
              if (win && !win.isDestroyed()) {
                win.webContents.send('menu:start-demo-mode');
              }
            },
          },
        ]),
      ],
    },
  ];
  const menu = Menu.buildFromTemplate(menuTemplate);
  Menu.setApplicationMenu(menu);

  // Track user identity with current settings
  mainTracking.identifyUser(settingsStore.store);
  // Set Sentry user for error attribution
  setSentryUser({ id: ANONYMOUS_ID, email: settingsStore.store.userEmail });
  
  // Re-apply voice hotkey after menu setup (non-fatal if it fails)
  const postMenuHotkeyResult = applyVoiceActivationHotkey(settingsStore.store.voice.activationHotkey ?? null);
  if (!postMenuHotkeyResult.success) {
    logger.warn({ error: postMenuHotkeyResult.error }, 'Voice activation hotkey registration failed during startup');
  }

  // Start workspace file watcher if directory is configured (always enabled for UI auto-refresh)
  if (settingsStore.store.coreDirectory) {
    // Consolidated watcher + broadcaster
    workspaceWatcherService.start(settingsStore.store.coreDirectory);
    libraryBroadcaster.start();
    startPluginWatcherSubscriber(() => mainWindow);

    // Stage 4b (260619_cloud-symlink-indexing) — build the cached, readlink-only
    // cloud-space containment map (R6) so the Removal Coordinator (R1) and the
    // search-path purge (R2) can answer "is this entry under a cloud space, and is
    // that space healthy?" as a PURE STRING PREFIX MATCH — never touching the
    // (possibly-dead) mount. FS-free candidate enumeration (settings `spaces`) +
    // readlink-only target keying (same first-cloud-hop minter the prewarm uses, so
    // verdicts are read back under a byte-identical key). Configured at watcher
    // start and re-configured whenever the spaces config changes (invalidation
    // hook). On cloud/headless / no cloud spaces the map stays empty → every path
    // classifies `'local'` → unchanged behaviour.
    configureCloudSpaceContainment(settingsStore.store.coreDirectory, settingsStore.store.spaces);

    // Mirror the admission flag into the core module-singleton that the descent
    // decision points read. S5: the default is now ON (`?? true`) — a healthy
    // cloud-symlink space is indexed/searched by default; an explicit
    // `experimental.cloudSymlinkIndexing === false` remains the kill-switch. Safe to
    // default on because every flag-ON fs path is now bounded (S1-S5: the boundary,
    // the periodic re-walk, and the bounded file-tool roots). Re-mirrored on every
    // settings change.
    setCloudSymlinkIndexingEnabled(settingsStore.store.experimental?.cloudSymlinkIndexing ?? true);

    // Stage 4b refinement F3 — track which cloud targets have already been
    // prewarmed (seeded with the startup snapshot below) so the settings-change
    // hook can prewarm ONLY targets new since the last snapshot, not re-probe every
    // existing space on every unrelated settings change.
    const prewarmedCloudTargets = new Set<string>();

    // Stage 7 (GPT review should-4) — track the admission flag's last value so a
    // genuine kill-switch FLIP (the flag is the planned remote kill-switch) rebuilds
    // the watcher. Without this, flipping OFF would NOT retract an already-admitted
    // chokidar subtree and flipping ON would NOT admit until some other restart.
    let lastCloudSymlinkIndexingEnabled = isCloudSymlinkIndexingEnabled();
    // The pending flip-ON deferred rebuild timer (cancelled if the flag flips again
    // within the settle window, so a rapid ON→OFF can't leave a stale rebuild armed).
    let cloudFlagFlipSettleTimer: ReturnType<typeof setTimeout> | null = null;

    // Invalidation hook (R6): rebuild the map when the spaces config / workspace
    // root changes (e.g. a space added, removed, or re-pointed). The rebuild is
    // cheap (readlink-only on local link inodes) and idempotent, so re-running it
    // on any settings change is safe. Registered once.
    if (settingsStore.onDidAnyChange) {
      settingsStore.onDidAnyChange((newSettings) => {
        if (!newSettings) return;
        configureCloudSpaceContainment(newSettings.coreDirectory, newSettings.spaces);
        // Keep the admission flag mirror in sync with settings (S5: default ON; an
        // explicit `false` is the kill-switch — see the bootstrap mirror above).
        setCloudSymlinkIndexingEnabled(newSettings.experimental?.cloudSymlinkIndexing ?? true);
        // On a genuine flag FLIP, drive a re-walk so a freshly-enabled space's content
        // (re)joins the index (S4.2 — was a watcher rebuild; cloud is no longer live-
        // watched). Gated to an actual change so unrelated settings writes don't churn.
        const nowEnabled = isCloudSymlinkIndexingEnabled();
        if (nowEnabled !== lastCloudSymlinkIndexingEnabled) {
          lastCloudSymlinkIndexingEnabled = nowEnabled;
          // Cancel any still-pending flip-ON deferred rebuild from a prior flip: a
          // rapid ON→OFF (or ON→OFF→ON) within the settle window must not leave a
          // stale rebuild armed that fires against an out-of-date intent (GPT review
          // — harmless churn, eliminated here).
          if (cloudFlagFlipSettleTimer) {
            clearTimeout(cloudFlagFlipSettleTimer);
            cloudFlagFlipSettleTimer = null;
          }
          const doRebuild = (phase: string): void => {
            // S4.2 (260619_cloud-symlink-indexing): the flag flip no longer restarts
            // the chokidar watcher. Cloud is ALWAYS excluded from the live watch now
            // (the admission override is gone — DROP-3), so there is nothing to
            // re-classify. The flip effect that matters is the re-walk/reindex, which
            // routes through the SAME single-flighted periodic re-walk scheduler (so a
            // flip during an in-flight tick re-walk coalesces to one trailing pass).
            // `triggerRewalk` is R6-gated on the flag: flip-ON re-walks to (re)admit
            // healthy cloud content; flip-OFF is a clean no-op (nothing to retract —
            // DROP-3). The scheduler is null on cloud/headless (no utilityProcess), so
            // this is a no-op there (those surfaces have no live chokidar watcher).
            logger.info({ enabled: nowEnabled, phase }, 'cloudSymlinkIndexing flag flipped — re-walking to (re)admit cloud spaces');
            cloudPeriodicRewalkScheduler?.triggerRewalk(`flag-flip:${phase}`);
          };
          if (nowEnabled) {
            // FLIP ON (GPT recheck should-4): admission only admits a space whose
            // cached verdict is `healthy`. If verdicts are `unknown`/expired at flip
            // time, an immediate rebuild would exclude the space and it would stay
            // dark — and a later `unknown→healthy` settle is NOT a recovery (no
            // rebuild fires). So PROBE all cloud targets first (off-thread), then
            // schedule ONE deferred rebuild after the probes have had time to settle
            // a fresh verdict — so a healthy space is admitted on flip-on even from a
            // cold `unknown`. (Spaces already healthy from cold-start prewarm admit on
            // the immediate rebuild too.)
            if (cloudLivenessProbeService && newSettings.coreDirectory) {
              const targets = deriveCloudPrewarmTargets(newSettings.coreDirectory, newSettings.spaces);
              for (const t of targets) prewarmedCloudTargets.add(t);
              // `prewarm` fire-and-forgets a fresh off-thread probe per target →
              // populates the verdict cache (healthy/degraded) within ~one probe.
              cloudLivenessProbeService.prewarm(targets);
            }
            doRebuild('flip-on-immediate'); // admit any already-healthy spaces now
            // …then again once the fresh probes likely settled (healthy probe is
            // sub-ms; the 200ms parent timeout bounds a dead mount) so a cold
            // `unknown→healthy` space is admitted without waiting for a natural trigger.
            cloudFlagFlipSettleTimer = setTimeout(() => {
              cloudFlagFlipSettleTimer = null;
              doRebuild('flip-on-after-probe');
            }, CLOUD_FLAG_FLIP_PROBE_SETTLE_MS);
            cloudFlagFlipSettleTimer.unref?.();
          } else {
            // FLIP OFF (kill-switch): a no-op re-walk trigger (R6 — triggerRewalk
            // short-circuits with the flag off). Cloud is already excluded from the
            // live watch (DROP-3), so there is nothing to retract; the call is kept
            // for symmetry + traceability logging.
            doRebuild('flip-off');
          }
        }
        // F3: a freshly-added/repointed healthy cloud space would otherwise sit at
        // `unknown` (conservatively retained, but dark for search) until some other
        // producer probes it. Rebuilding containment alone does NOT populate a
        // verdict. So prewarm any cloud target NOT seen before — readlink-only
        // derivation (FS-free enumeration, never into the mount), fire-and-forget.
        if (cloudLivenessProbeService && newSettings.coreDirectory) {
          const targets = deriveCloudPrewarmTargets(newSettings.coreDirectory, newSettings.spaces);
          const fresh = targets.filter((t) => !prewarmedCloudTargets.has(t));
          if (fresh.length > 0) {
            for (const t of fresh) prewarmedCloudTargets.add(t);
            cloudLivenessProbeService.prewarm(fresh);
          }
        }
      });
    }

    // Stage 3 (260619_cloud-symlink-indexing) — cold-start prewarm (DA-2). Probe
    // every cloud-symlinked space off-thread shortly after boot so a healthy
    // Drive's verdict is populated WITHIN this launch (otherwise the cold-start
    // `unknown` verdict would keep it dark until next launch). Derivation is
    // FS-FREE for the candidate enumeration (settings `spaces`, not a `readdir` of
    // `coreDirectory` — which can itself be a cloud-classified FUSE mount whose
    // readdir would block the main thread, Stage-3 refinement F2) + readlink-only
    // for target resolution (stops at the first cloud hop, never `readlinkSync`s
    // into the mount, F1). Probing is fire-and-forget through the child process.
    // Scheduled (not inline) so it never delays boot. Inert unless the prober is
    // wired (utilityProcess available) and there ARE cloud spaces.
    if (cloudLivenessProbeService) {
      const probeService = cloudLivenessProbeService;
      const prewarmRoot = settingsStore.store.coreDirectory;
      const prewarmSpaces = settingsStore.store.spaces;
      startupScheduler.schedule('cloud-liveness-prewarm', 8_000, async () => {
        const targets = deriveCloudPrewarmTargets(prewarmRoot, prewarmSpaces);
        // F3: record the startup set so the settings-change hook treats these as
        // already-prewarmed and only probes targets new since this snapshot.
        for (const t of targets) prewarmedCloudTargets.add(t);
        probeService.prewarm(targets);
      });

      // Postmortem #3 — discovered-vs-admitted observability. ONE-SHOT, well after the
      // prewarm has had time to settle: if the user HAS cloud Spaces (or we derived
      // probe targets) but NONE are healthy/admissible, the original "empty cloud
      // Spaces" failure is recurring — and it was silent for 3 days last time because
      // the only signal was an unwatched debug log. Emit a structured log always, and
      // a queryable/alertable Sentry warning on the alert condition. Readlink-safe
      // (zero-I/O under a cloud root; safe local readlinks otherwise — never a readlink
      // under a dead cloud root); one-shot ⇒ no alert fatigue. Re-reads CURRENT settings
      // at fire time (the snapshot above is stale by 30s if the workspace changed).
      startupScheduler.schedule('cloud-indexing-coverage-check', CLOUD_INDEXING_COVERAGE_CHECK_MS, async () => {
        const coreDirectory = settingsStore.store.coreDirectory;
        if (!coreDirectory) return; // no workspace ⇒ nothing to cover
        const snapshot = computeCloudIndexingCoverage(
          coreDirectory,
          settingsStore.store.spaces,
          (target) => probeService.getCachedVerdict(target),
        );
        if (snapshot.shouldAlert) {
          logger.warn(
            { ...snapshot },
            'Cloud Spaces discovered but none admitted/indexed after warm-up (discovered≫admitted)',
          );
          getErrorReporter().captureMessage(
            'Cloud Spaces discovered but none admitted after warm-up',
            {
              level: 'warning',
              tags: { condition: 'cloud_spaces_none_admitted' },
              extra: { ...snapshot },
            },
          );
        } else {
          logger.debug({ ...snapshot }, 'Cloud-indexing coverage check (healthy)');
        }
      });

      // SYNTHESIS S4.3 — start the periodic re-walk tick (the `.unref()`'d timer is
      // inert with the admission flag off; the tick re-reads `isEnabled()` first).
      cloudPeriodicRewalkScheduler?.start();
    }
  }

  // Run index health check before initializing embedding worker or index services.
  // This detects and recovers corrupted indices/models at startup (they will rebuild lazily).
  // Must complete before syncSystemSettingsIfNeeded and initializeConversationIndex to avoid race conditions.
  // Uses a timeout to avoid blocking startup indefinitely on LanceDB hangs.
  // Windows needs longer timeout due to slower filesystem and antivirus scanning.
  // IMPORTANT: We run this in a separate utilityProcess so we can kill it on timeout.
  // Promise.race() alone doesn't work because LanceDB native FFI calls block the event loop.
  const INDEX_HEALTH_TIMEOUT_MS = process.platform === 'win32' ? 20000 : 10000;
  try {
    const report = await runIndexHealthCheckWithTimeout(getSettings(), INDEX_HEALTH_TIMEOUT_MS);
    if (report === null) {
      logger.warn({ timeoutMs: INDEX_HEALTH_TIMEOUT_MS }, 'Index health check timed out, continuing startup');
    } else if (report.recovered) {
      logger.warn(
        { recoveredCount: report.items.length, items: report.items.map(i => i.type) },
        'Index health check: recovered corrupted indices at startup'
      );
      // Report recovered items to Sentry for observability (mirrors indexHealthService.reportToSentry)
      for (const item of report.items) {
        const errorType = item.errorType ?? 'unknown';
        const message = errorType === 'native_module_missing'
          ? 'Index health: native module unavailable'
          : errorType === 'data_corruption'
            ? 'Index health: corruption auto-recovered'
            : 'Index health: validation failed';
        const level = errorType === 'data_corruption' ? 'warning' : 'error';
        captureMainMessage(message, {
          level,
          tags: {
            area: 'startup',
            component: 'index-health',
            error_category: errorType,
            platform: process.platform as 'darwin' | 'win32' | 'linux',
            arch: process.arch,
          },
          fingerprint: ['index-health', item.type, errorType],
          extra: {
            corruptionType: item.type,
            errorMessage: item.error,
            recovered: true,
            isPackaged: app.isPackaged,
          },
        });
      }
    } else {
      logger.debug('Index health check: all indices healthy');
    }
  } catch (err) {
    logger.warn({ err }, 'Index health check failed, continuing startup');
  }

  // Sync system settings from GitHub if a new version is available,
  // then ensure workspace symlink exists. This runs in background and doesn't block app startup.
  syncSystemSettingsIfNeeded()
    .finally(() => {
      // Create symlinks after sync (whether it succeeded, failed, or wasn't needed)
      // This ensures existing workspaces get the symlinks even if settings were already synced
      const settings = getSettings();
      const coreDirectory = settings.coreDirectory;
      if (coreDirectory) {
        createLibrarySymlink(coreDirectory)
          .then(() => createAgentsMdSymlink(coreDirectory))
          .then(() => createClaudeMdSymlink(coreDirectory))
          .then(() => {
            // Auto-populate USERNAME for Chief-of-Staff template
            const username = getUsername();
            const variables = username ? { USERNAME: username } : undefined;
            return ensureChiefOfStaffSpace(coreDirectory, variables, {
              // FOX-3072: keep settings.spaces in sync with any frontmatter repair
              // so checkSpaceSharingConfig stays green without another scan cycle.
              getSpaces: () => getSettings().spaces,
              updateSpaces: (spaces) => updateSettings({ spaces }),
            });
          })
          .then(async () => {
            // Migrate legacy AGENTS.md files to README.md (best-effort, non-blocking, silent)
            // No toast notification - users don't need to know about internal file organization
            await migrateAllLegacyAgentsMd(coreDirectory);
            // Migration may have rewritten README frontmatter for multiple spaces;
            // clear the read-only scan cache for the current workspace so any
            // downstream readers see the migrated state rather than a stale scan.
            invalidateSpaceScanCache(coreDirectory, 'migrateAllLegacyAgentsMd:startup');
          })
          .then(async () => {
            // Stage 2 of memory safety simplification: Clean up memoryTrust from README.md files
            // Only run if spaceSafetyLevels is populated (indicates migration has occurred)
            // This is fire-and-forget, non-blocking, and idempotent
            const currentSettings = getSettings();
            const hasSpaceSafetyLevels = currentSettings.spaceSafetyLevels && 
              Object.keys(currentSettings.spaceSafetyLevels).length > 0;
            if (hasSpaceSafetyLevels && currentSettings.spaces && currentSettings.spaces.length > 0) {
              await cleanupMemoryTrustFromAllSpaces(coreDirectory, currentSettings.spaces);
            }
          })
          .then(async () => {
            // Semantic file indexing auto-starts by default (opt-out via settings.indexingEnabled === false)
            // Delayed 120s to avoid competing with user interactions at startup
            if (settings.indexingEnabled !== false) {
              // Pre-load index metadata immediately so the Library shows accurate
              // status ("19k files", timestamp) instead of "Not started" / "Never"
              // while waiting for the full index to open after the 120s delay.
              preloadIndexMetadata(coreDirectory).catch((err) => {
                logger.debug({ err }, 'Index metadata pre-load skipped');
              });
              startupScheduler.schedule('semantic-indexing', 120_000, async () => {
                logger.info({ coreDirectory }, 'Starting semantic indexing (default: enabled)');
                // Preload embedding model (GPU or CPU) before starting file watcher
                await preloadEmbeddingModel(settings);
                startFileWatching(coreDirectory).catch((err) => {
                  logger.warn({ err }, 'Failed to start file watching for semantic indexing');
                });
              });
            } else {
              logger.debug({ coreDirectory }, 'Semantic indexing disabled in settings, skipping auto-start');
            }
            
          })
          .catch((error) => {
            logger.warn({ err: error }, 'Failed to create workspace symlinks/spaces or start file indexing on startup');
            // Report LanceDB failures on Windows to Sentry (likely missing VC++ Redistributable)
            if (process.platform === 'win32') {
              captureMainException(error, {
                tags: { area: 'lancedb', index: 'file' },
                extra: { context: 'LanceDB initialization failed on Windows - may indicate missing VC++ Redistributable' },
              });
            }
          });
      } else {
        logger.info('No workspace configured at startup, semantic file indexing will start when workspace is set');
      }
    })
    .catch((error) => {
      logger.error({ err: error }, 'System settings sync failed during startup');
    });

  // Initialize conversation semantic index (independent of workspace/file indexing)
  // This is app-global, not per-workspace
  // Pass isAppIdle callback so the idle optimization scheduler only runs optimize
  // when no agent turns are active (avoids LanceDB FFI blocking the event loop during turns)
  initializeConversationIndex({ isAppIdle: () => agentTurnRegistry.getActiveTurnCount() === 0 })
    .then(async () => {
      // Indexing reconciliation needs a complete ID set, including internal sessions.
      const summaries = getIncrementalSessionStore().listSessions({ includeInternal: true });
      const validSessionIds = new Set(summaries.filter(s => !s.deletedAt).map(s => s.id));
      
      // Startup reconciliation - remove orphan embeddings
      await reconcileEmbeddings(validSessionIds);
      
      // Recurring dedup — catches duplicates from race conditions, interrupted migrations, etc.
      // Fast-path skips the full scan when row count equals unique session count.
      await deduplicateConversationIndex();

      // Migration v2: backfill search_text for existing conversation embeddings.
      // Runs after dedup to avoid wasting I/O on duplicate rows.
      await migrateSearchText();
      
      // Deferred backfill to avoid contention with file indexing
      // Delayed 180s (3 min) to run after semantic indexing settles
      // Uses summary-driven approach internally (no bulk session loading)
      startupScheduler.schedule('conversation-embedding-backfill', 180_000, () =>
        backfillConversationEmbeddings({ batchSize: 10, delayMs: 200 })
          .then((count) => {
            if (count > 0) {
              logger.info({ embeddedCount: count }, 'Conversation embedding backfill completed');
            }
          })
          .catch((err) => {
            logger.warn({ err }, 'Conversation embedding backfill failed');
          })
      );
    })
    .catch((err) => {
      logger.warn({ err }, 'Failed to initialize conversation index');
      // Report LanceDB failures on Windows to Sentry (likely missing VC++ Redistributable)
      if (process.platform === 'win32') {
        captureMainException(err, {
          tags: { area: 'lancedb', index: 'conversation' },
          extra: { context: 'LanceDB initialization failed on Windows - may indicate missing VC++ Redistributable' },
        });
      }
    });

  // Use staggered catch-up instead of immediate execution
  // This queues missed automations to run sequentially with 30s gaps, starting after 60s
  if (!isRebelTestMode()) {
    scheduler.handleAppLaunchStaggered((automationId, execute) => {
      startupScheduler.queueAutomationCatchUp(automationId, execute);
    });
  }
  scheduleDiagnosticsExpiry();
  if (isDiagnosticsBroadcastPending()) {
    broadcastDiagnosticsUpdate();
  }

  // ---------------------------------------------------------------------------
  // One-way event handlers (ipcMain.on) - not part of invoke/handle pattern
  // ---------------------------------------------------------------------------

  // Find-in-page: native Chromium text search via webContents.findInPage()
  const findInPageListeners = new WeakSet<Electron.WebContents>();

  const ensureFindInPageListener = (webContents: Electron.WebContents) => {
    if (findInPageListeners.has(webContents)) return;
    findInPageListeners.add(webContents);
    webContents.on('found-in-page', (_event, result) => {
      if (!webContents.isDestroyed()) {
        webContents.send('find-in-page:result', {
          activeMatchOrdinal: result.activeMatchOrdinal,
          matches: result.matches,
        });
      }
    });
  };

  // STARTUP_LATE_REGISTRATION_OK: One-way find-in-page command runs only after user input and is not consumed during preload or initial startup.
  ipcMain.on('find-in-page:search', (event, params: { text: string; forward: boolean; findNext: boolean }) => {
    if (!params.text) return;
    ensureFindInPageListener(event.sender);
    event.sender.findInPage(params.text, {
      forward: params.forward,
      findNext: params.findNext,
    });
  });

  // STARTUP_LATE_REGISTRATION_OK: One-way find-in-page stop command is user-triggered post-load and does not participate in startup request/response IPC.
  ipcMain.on('find-in-page:stop', (event) => {
    event.sender.stopFindInPage('clearSelection');
  });

  // Renderer logging relay
  // STARTUP_LATE_REGISTRATION_OK: One-way renderer log relay is fire-and-forget telemetry and does not block preload or first-paint startup flows.
  ipcMain.on('log:event', (_event, payload: RendererLogPayload) => {
    try {
      if (!payload || typeof payload !== 'object') {
        return;
      }

      const {
        level,
        message,
        breadcrumbs,
        context,
        error,
        source,
        turnId,
        sessionId,
        timestamp
      } = payload;

      const diagnostics = getDiagnosticsSnapshot();
      const diagnosticsActive = Boolean(diagnostics.debugBreadcrumbsUntil && diagnostics.debugBreadcrumbsUntil > Date.now());
      const isVerboseLevel = level === 'debug' || level === 'trace';
      if (isVerboseLevel && !diagnosticsActive) {
        return;
      }

      const scoped = createScopedLogger({
        channel: 'renderer-ipc',
        source: source ?? 'renderer',
        turnId: turnId ?? undefined,
        sessionId: sessionId ?? undefined
      });

      const logContext: Record<string, unknown> = {
        ...context,
        breadcrumbs,
        timestamp: timestamp ?? Date.now()
      };

      if (error) {
        logContext.err = error;
      }

      switch (level) {
        case 'trace':
          scoped.trace(logContext, message);
          break;
        case 'debug':
          scoped.debug(logContext, message);
          break;
        case 'info':
          scoped.info(logContext, message);
          break;
        case 'warn':
          scoped.warn(logContext, message);
          break;
        case 'error':
          scoped.error(logContext, message);
          break;
        case 'fatal':
          scoped.fatal(logContext, message);
          break;
        default:
          scoped.info(logContext, message ?? 'Renderer log event');
          break;
      }

      // Stage 3: additionally cache renderer perf summaries for inclusion in
      // the periodic perf diagnostic payload. Purely additive — the log line
      // above still flows to pino/structured logs.
      if (
        context &&
        typeof context === 'object' &&
        (context as Record<string, unknown>)['profilerChannel'] === 'perf-summary'
      ) {
        try {
          cacheRendererPerfSummary(context as Record<string, unknown>);
        } catch (err) {
          // Defensive: cache ingestion must never take down the log relay.
          scoped.warn({ err }, 'rendererPerfMonitor: cacheRendererPerfSummary threw');
        }
      }

      if (message === 'Renderer memory diagnostic' && context && typeof context === 'object') {
        try {
          const memoryContext = context as Record<string, unknown>;
          const heapUsedMB = typeof memoryContext.heapUsedMB === 'number' && Number.isFinite(memoryContext.heapUsedMB)
            ? memoryContext.heapUsedMB
            : null;
          const heapTotalMB = typeof memoryContext.heapTotalMB === 'number' && Number.isFinite(memoryContext.heapTotalMB)
            ? memoryContext.heapTotalMB
            : null;
          const loadedSessions = typeof memoryContext.loadedSessionCount === 'number' && Number.isFinite(memoryContext.loadedSessionCount)
            ? Math.max(0, Math.trunc(memoryContext.loadedSessionCount))
            : 0;
          const loadedMessages = typeof memoryContext.loadedMessageCount === 'number' && Number.isFinite(memoryContext.loadedMessageCount)
            ? Math.max(0, Math.trunc(memoryContext.loadedMessageCount))
            : 0;

          cacheRendererSnapshot({
            timestamp: typeof timestamp === 'number' && Number.isFinite(timestamp) ? timestamp : Date.now(),
            heapUsedMB,
            heapTotalMB,
            loadedSessions,
            loadedMessages,
          });
        } catch (err) {
          scoped.debug({ err }, 'ramTelemetry: cacheRendererSnapshot threw');
        }
      }
    } catch (error) {
      if (isTooManyOpenFilesError(error)) {
        tagFsExhaustion(error, 'log_event_handler');
        maybeSurfaceFdExhaustionWarning();
        return;
      }
      logger.warn({ err: error }, 'log:event handler failed');
      return;
    }
  });

  // Handle Identity Sync from Renderer (Login)
  // STARTUP_LATE_REGISTRATION_OK: One-way analytics identify event occurs after login actions and is never required during initial renderer startup.
  ipcMain.on('analytics:identify', (_event, { userId, traits }) => {
    const anonymousId = getOrGenerateAnonymousId();
    const persistedEmail = settingsStore.store.userEmail ?? null;
    const resolvedUserId = persistedEmail ?? userId ?? null;
    const mergedTraits = {
      ...(traits ?? {}),
      ...(persistedEmail ? { email: persistedEmail } : {})
    };

    identifyMainUser({
      anonymousId,
      ...(resolvedUserId ? { userId: resolvedUserId } : {}),
      traits: mergedTraits
    });
  });
}).catch((err) => {
  console.error('[index] Fatal error in app.whenReady handler:', err);
  process.exit(1);
});

app.on('render-process-gone', (_event, webContents, details) => {
  // REBEL-5RT FU-4: wrap logger.error — same cascade risk shape as the
  // uncaughtException handler above. Renderer-crash logging fires precisely
  // when the app is unhealthy; the pino transport may itself be in a degraded
  // state. safeLog falls back to console.error rather than re-throw.
  safeLog(
    logger,
    'error',
    {
      reason: details?.reason,
      exitCode: details?.exitCode,
      url: webContents?.getURL?.()
    },
    'Renderer process terminated'
  );
  // Surface renderer crashes to Sentry (was pino-only → invisible to the fleet).
  // Skip the benign clean-exit teardown. Sync capture so the event egresses
  // immediately even if health checks are slow/blocked (self-concealing-failure
  // resilience); the enlarged log buffer rides along. See FINDINGS.md C1.
  if (shouldCaptureProcessGone(details?.reason)) {
    // Static message; `reason` is a low-cardinality enum tag for faceting/filtering
    // (not interpolated into the message — rebel-sentry/no-dynamic-capture-message).
    captureMainException(new Error('Renderer process gone'), {
      tags: { area: 'renderer', component: 'crash', reason: details?.reason ?? 'unknown' },
      extra: {
        reason: details?.reason,
        exitCode: details?.exitCode,
        url: toTelemetrySafeUrl(webContents?.getURL?.())
      }
    });
  }
});

app.on('child-process-gone', (_event, details) => {
  const isGpuProcess = details?.type === 'GPU';
  // REBEL-5RT FU-4: same defence as render-process-gone above.
  safeLog(
    logger,
    'error',
    {
      type: details?.type,
      reason: details?.reason,
      exitCode: details?.exitCode
    },
    isGpuProcess ? 'GPU process crashed' : 'Child process terminated'
  );
  // Surface GPU/utility crashes to Sentry (was pino-only). A crash-looping GPU
  // process could storm, so throttle per (type+reason) on top of skipping
  // clean-exit. This is the signal behind the "alert on render-process-gone
  // exitCode:11" follow-up (FINDINGS.md C1 / REBEL-5RT family).
  if (
    shouldCaptureProcessGone(details?.reason) &&
    shouldCaptureChildProcessGoneThrottled(`${details?.type ?? 'unknown'}:${details?.reason ?? 'unknown'}`)
  ) {
    // Static message; processType/reason are low-cardinality enum tags for
    // faceting (not interpolated — rebel-sentry/no-dynamic-capture-message).
    captureMainException(new Error('Child process gone'), {
      tags: {
        area: 'process',
        component: 'crash',
        processType: details?.type ?? 'unknown',
        reason: details?.reason ?? 'unknown'
      },
      extra: {
        type: details?.type,
        reason: details?.reason,
        exitCode: details?.exitCode
      }
    });
  }
});

app.on('will-quit', () => {
  if (!app.isPackaged && process.env.REBEL_PERF_MODE === '1') {
    fireAndForget(generateBestEffort(), 'index.willQuit.generateBestEffort');
  }
  // Stop graceful-fs queue sampler (releases the unref'd setInterval).
  try { _stopGracefulFsObservability(); } catch { /* swallow on shutdown */ }
  stopLatencyTracker();
  stopRendererProfiler();
  unregisterVoiceActivationHotkey();
  globalShortcut.unregisterAll();
  shutdownDesktopSdk();
  stopExternalProviderPolling();
  inboundTriggerService?.dispose();
  perfDiagnosticHandle?.dispose();
  perfDiagnosticHandle = null;
  // Stage 3 (260619_cloud-symlink-indexing): tear down the cloud-liveness prober
  // child process + all backoff re-probe timers so we don't orphan a child or
  // leak timers on quit. Calls the CONCRETE instance's dispose (the makeTotal
  // wrapper from setCloudLivenessProbe doesn't expose it).
  cloudLivenessProbeService?.dispose();
  cloudLivenessProbeService = null;
  // SYNTHESIS S4.3: stop the periodic re-walk timer (idempotent; prevents a trailing
  // tick/re-walk from firing against a torn-down service).
  cloudPeriodicRewalkScheduler?.dispose();
  cloudPeriodicRewalkScheduler = null;
  cloudFsExecutorService?.dispose();
  cloudFsExecutorService = null;
  // Stage 1 (260424 follow-up): release pidusage's internal long-running
  // child-process bookkeeping (Windows) / in-memory state (POSIX). Dynamic
  // import so test / headless contexts that never sampled a subprocess
  // don't eagerly pull the module. Non-fatal on failure — shutdown path.
  import('pidusage').then(({ default: pidusage }) => {
    try {
      pidusage.clear();
    } catch (err) {
      logger.debug({ err }, 'perfDiagnostic: pidusage.clear() threw on shutdown');
    }
  }).catch((err) => {
    logger.debug({ err }, 'perfDiagnostic: failed to import pidusage on shutdown');
  });
  eventLoopLagMonitor?.dispose();
  eventLoopLagMonitor = null;
  superMcpTelemetryDisposer?.();
  superMcpTelemetryDisposer = null;
  startupScheduler.shutdown(); // Cancel pending startup tasks
  shutdownHeroChoiceScheduler();
  shutdownDailySparkScheduler();
  // Stop Office sidecar child process (belt-and-suspenders; also stopped in gracefulShutdown)
  import('./services/officeSidecarManager').then(({ stopOfficeSidecar }) => {
    fireAndForget(stopOfficeSidecar(), 'index.willQuit.stopOfficeSidecar');
  }).catch(() => {});
  // Release any held power save blockers
  import('./services/powerSaveBlockerService').then(({ dispose }) => dispose()).catch(() => {});
  closeConversationIndex().catch(() => {
    // Ignore errors during shutdown cleanup
  });
  // Shutdown meeting history store (unsubscribe from event buses)
  import('./services/meetingHistoryStore').then(({ shutdownMeetingHistoryStore }) => {
    shutdownMeetingHistoryStore();
  }).catch(() => {
    // Ignore errors during shutdown cleanup
  });
  // Flush cloud metadata stores (debounced writes may be pending)
  import('./services/cloud/cloudContinuityMetadata').then(({ flushContinuityMetadata }) => {
    fireAndForget(flushContinuityMetadata(), 'index.willQuit.flushContinuityMetadata');
  }).catch(() => {});
  import('./services/cloud/cloudSyncMetadata').then(({ flushCloudSyncMetadata }) => {
    flushCloudSyncMetadata();
  }).catch(() => {});
  import('./services/cloud/cloudOutbox').then(({ cloudOutbox }) => {
    cloudOutbox.flush();
  }).catch(() => {});
  import('./services/cloud/cloudWorkspaceSync').then(({ cloudWorkspaceSync }) => {
    cloudWorkspaceSync.flush();
  }).catch(() => {});
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  fireAndForget((async () => {
    await ensureMainWindow();
  })(), 'main.appActivate');
});

export { settingsStore as appSettingsStore, ensureNormalizedSettings as ensureAppSettingsNormalized };
