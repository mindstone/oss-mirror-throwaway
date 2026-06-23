/* eslint-disable no-console -- preload script: no structured logger in preload context */
import { contextBridge, ipcRenderer, webUtils } from 'electron';

// =============================================================================
// Sentry IPC Bridge Setup (inline implementation)
// =============================================================================
// Inline Sentry IPC bridge setup - replaces @sentry/electron/preload require()
//
// Why inline instead of require('@sentry/electron/preload')?
// The SDK's preload module is CJS with module-level side-effects that don't execute
// correctly when require()'d from a Vite-bundled ESM preload script. The require()
// "succeeds" (no error thrown) but window.__SENTRY_IPC__ is never set, causing the
// renderer SDK to fall back to fetch('sentry-ipc://...') which fails because that
// protocol isn't registered (we use IPCMode.Classic, not Protocol).
//
// Based on @sentry/electron@4.x IPC contract - see node_modules/@sentry/electron/common/ipc.d.ts
// Types for window.__SENTRY_IPC__ are provided by @sentry/electron/common/ipc.d.ts
// =============================================================================

const SENTRY_IPC_NAMESPACE = 'sentry-ipc';

function setupSentryIpc(): void {
  try {
    // Check if already initialized (idempotency, matches SDK behavior)
    if (window.__SENTRY_IPC__?.[SENTRY_IPC_NAMESPACE]) {
      return; // Already set up
    }

    // IPCInterface from @sentry/electron - methods match the SDK's expected contract
    const ipcObject = {
      sendRendererStart: () => ipcRenderer.send(`${SENTRY_IPC_NAMESPACE}.start`),
      sendScope: (scopeJson: string) => ipcRenderer.send(`${SENTRY_IPC_NAMESPACE}.scope`, scopeJson),
      sendEnvelope: (envelope: Uint8Array | string) => ipcRenderer.send(`${SENTRY_IPC_NAMESPACE}.envelope`, envelope),
      sendStatus: (status: unknown) => ipcRenderer.send(`${SENTRY_IPC_NAMESPACE}.status`, status),
      sendStructuredLog: (log: unknown) => ipcRenderer.send(`${SENTRY_IPC_NAMESPACE}.structured-log`, log),
      sendMetric: (metric: unknown) => ipcRenderer.send(`${SENTRY_IPC_NAMESPACE}.metric`, metric),
    };

    // Set on window (preload world)
    // Type assertion needed because we use `unknown` for some params instead of SDK's specific types
    window.__SENTRY_IPC__ = window.__SENTRY_IPC__ || {};
    (window.__SENTRY_IPC__ as Record<string, typeof ipcObject>)[SENTRY_IPC_NAMESPACE] = ipcObject;

    // Expose to renderer world via contextBridge
    if (contextBridge) {
      try {
        contextBridge.exposeInMainWorld('__SENTRY_IPC__', window.__SENTRY_IPC__);
      } catch {
        // contextIsolation disabled or already exposed - this is fine
      }
    }
  } catch (error) {
    console.error('[Preload] Sentry IPC setup failed - renderer crash reporting disabled:', error);
  }
}

setupSentryIpc();

type IntentTabContextPayload = { tabId?: number; windowId?: number; url?: string; title?: string };
type IntentDocumentContextPayload = { host?: string; url?: string; title?: string };

function readOptionalStringField(
  record: Record<string, unknown>,
  key: string,
  maxLength: number,
): string | undefined | null {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > maxLength) return null;
  return value;
}

function readOptionalNonnegativeIntegerField(
  record: Record<string, unknown>,
  key: string,
): number | undefined | null {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return null;
  return value;
}

function validateIntentTabContext(value: unknown): IntentTabContextPayload | undefined | null {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const tabId = readOptionalNonnegativeIntegerField(record, 'tabId');
  const windowId = readOptionalNonnegativeIntegerField(record, 'windowId');
  const url = readOptionalStringField(record, 'url', 2048);
  const title = readOptionalStringField(record, 'title', 1024);
  if (tabId === null || windowId === null || url === null || title === null) return null;
  return {
    ...(typeof tabId === 'number' ? { tabId } : {}),
    ...(typeof windowId === 'number' ? { windowId } : {}),
    ...(url ? { url } : {}),
    ...(title ? { title } : {}),
  };
}

function validateIntentDocumentContext(value: unknown): IntentDocumentContextPayload | undefined | null {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const host = readOptionalStringField(record, 'host', 64);
  const url = readOptionalStringField(record, 'url', 2048);
  const title = readOptionalStringField(record, 'title', 1024);
  if (host === null || url === null || title === null) return null;
  return {
    ...(host ? { host } : {}),
    ...(url ? { url } : {}),
    ...(title ? { title } : {}),
  };
}

import type {
  IpcRequestOf,
  IpcResponseOf,
  LibraryListFilesResponse,
} from '@shared/ipc/contracts';
import type {
  AgentTurnEvent,
  AgentTurnRequest,
  AppSettings,
  AgentSession,
  RendererLogPayload,
  VoiceTranscriptionPayload,
  DiagnosticsSettings,
  McpConfigSummary,
  McpServerUpsertPayload,
  McpConfigMutationResult,
  McpRouterPathPatchPayload,
  McpServerConfigDetails,
  ConversationTitleRequestPayload,
  ConversationTitleResponsePayload,
  InboxState,
  InboxExecutionMode,
  AutomationStoreState,
  AutomationDefinition,
  AutomationDefinitionInput,
  AutomationRun,
  AnalyticsStatusPayload,
  MemoryUpdateStatus,
  TimeSavedStatus,
  TimeSavedAggregates,
  WeeklyTrend,
  TopSessionInfo,
  SessionCoachingEvaluation,
  CommunityHighlightsState,
  UserTasksState,
  SafeModeErrorCategory,
} from '@shared/types';
import type { CloudMigrationProgress } from '@shared/cloudMigrationTypes';
import type { AgentRoutePlanResolvedEvent } from '@shared/agentEvents';
import {
  AGENT_ROUTE_PLAN_RESOLVED_CHANNEL,
} from '@shared/ipc/broadcasts';
import type { McpAppPermissionChangedPayload } from '@shared/ipc/channels/mcpApps';
import {
  MEETING_TRIGGER_DETECTED_CHANNEL,
  MeetingTriggerDetectedPayloadSchema,
  type MeetingTriggerDetectedPayload,
} from '@shared/ipc/channels/meetingTrigger';
import {
  SLACK_WORKSPACE_CHANGED_CHANNEL,
  SlackWorkspaceChangedSchema,
} from '@shared/ipc/channels/slack';
import {
  coerceSubscriptionCallbackPayload,
  type SubscriptionCallbackPayload,
} from '@shared/ipc/channels/subscription';
import type { LibraryChangedSource } from '@shared/ipc/channels/library';
import type { RevealPathResult } from '@shared/ipc/channels/app';
import type {
  BlockSource,
  FileLocation,
  MemoryWriteApprovalRequestBroadcast,
  MemoryWriteApprovalResolvedBroadcast,
  ToolSafetyApprovalRequestBroadcast,
  ToolSafetyApprovalResolvedBroadcast,
  ToolSafetyStagedCallBroadcast,
  ToolSafetyStagedCallUpdatedBroadcast,
} from '@rebel/shared';

// =============================================================================
// Generated IPC Bridge
// =============================================================================
// Domain-specific APIs generated from src/shared/ipc/contracts.ts
// New code should prefer these over the legacy flat `api` object below.
import {
  libraryApi,
  settingsApi,
  appApi,
  exportApi,
  migrationApi,
  voiceApi,
  agentApi,
  agentErrorApi,
  errorApi,
  permissionsApi,
  sessionsApi,
  inboxApi,
  automationsApi,
  demoApi,
  dashboardApi,
  cloudApi as _generatedCloudApi,
  cloudContinuityApi,
  searchApi,
  systemHealthApi,
  miscApi,
  authApi,
  memoryApi,
  scratchpadApi,
  googleWorkspaceApi,
  githubApi,
  codexApi,
  subscriptionApi,
  identityApi,
  openRouterApi,
  slackApi,
  hubspotApi,
  discourseApi,
  microsoftApi,
  usageApi,
  safetyApi,
  safetyPromptApi,
  safetyActivityLogApi,
  skillsApi,
  operatorsApi,
  feedbackApi,
  pluginsApi as generatedPluginsApi,
  bugReportApi as generatedBugReportApi,
  fileConversationApi,
  userTasksApi,
  todoistApi,
  useCaseLibraryApi,
  calendarApi,
  errorRecoveryApi,
  meetingBotApi,
  timeSavedApi,
  localSttApi,
  localInferenceApi,
  physicalRecordingApi,
  quickCaptureApi,
  plaudApi,
  mcpAppsApi,
  versionApi,
  inboundTriggersApi,
  systemImprovementApi,
  heroChoiceApi,
  dailySparkApi,
  communityEventsApi,
  communityVideoRecsApi,
  skillHistoryApi,
  focusApi,
  foldersApi,
  contributionApi as generatedContributionApi,
  appBridgeApi,
  officeSidecarApi as generatedOfficeSidecarApi,
  diagnosticsApi,
  htmlPreviewTrustApi,
  achievementsApi,
  salesforceApi,
  spaceMaintenanceApi,
} from './ipcBridge';
import { createSafetyPromptSubscriptions } from './safetyPromptSubscriptionFactory';
import { createConnectorStatusSubscriptions } from './connectorStatusSubscriptionFactory';


// =============================================================================
// Extended Cloud API (generated + migration progress push)
// =============================================================================

export interface ProvisioningProgress {
  phase: 'validating' | 'creating-app' | 'setting-secrets' | 'creating-volume' | 'creating-machine' | 'waiting' | 'health-check' | 'complete' | 'failed';
  message: string;
  progress: number;
  failedStep?: number;
}

// `CloudMigrationProgress` is the canonical shared type — re-exported here so
// consumers that `import type { CloudMigrationProgress } from '@preload'` keep
// compiling. See src/shared/cloudMigrationTypes.ts.
export type { CloudMigrationProgress };

const cloudApi = {
  ..._generatedCloudApi,
  getVmTier: () => _generatedCloudApi.getVmTier(),
  changeVmTier: (payload: Parameters<typeof _generatedCloudApi.changeVmTier>[0]) =>
    _generatedCloudApi.changeVmTier(payload),
  onMigrationProgress: (callback: (step: CloudMigrationProgress) => void) => {
    const listener = (_: Electron.IpcRendererEvent, step: CloudMigrationProgress) => callback(step);
    ipcRenderer.on('cloud:migration-progress', listener);
    return () => void ipcRenderer.removeListener('cloud:migration-progress', listener);
  },
  onSessionsSynced: (callback: (data: { upserted: string[]; deleted: string[] }) => void) => {
    const listener = (_: Electron.IpcRendererEvent, data: { upserted: string[]; deleted: string[] }) => callback(data);
    ipcRenderer.on('cloud:sessions-synced', listener);
    return () => void ipcRenderer.removeListener('cloud:sessions-synced', listener);
  },
  // A1: folders restored from cloud on first-connect pull — the renderer
  // re-loads its Zustand folder store so the sidebar reflects the restore
  // without a restart. Mirrors onSessionsSynced.
  onFoldersRestored: (callback: (data: { folderCount: number; membershipCount: number }) => void) => {
    const listener = (_: Electron.IpcRendererEvent, data: { folderCount: number; membershipCount: number }) => callback(data);
    ipcRenderer.on('cloud:folders-restored', listener);
    return () => void ipcRenderer.removeListener('cloud:folders-restored', listener);
  },
  onOutboxChanged: (callback: (status: { pending: number; failed: number }) => void) => {
    const listener = (_: Electron.IpcRendererEvent, status: { pending: number; failed: number }) => callback(status);
    ipcRenderer.on('cloud:outbox-changed', listener);
    return () => void ipcRenderer.removeListener('cloud:outbox-changed', listener);
  },
  onContinuityChanged: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('cloud:continuity-changed', listener);
    return () => void ipcRenderer.removeListener('cloud:continuity-changed', listener);
  },
  onProvisioningProgress: (callback: (step: ProvisioningProgress) => void) => {
    const listener = (_: Electron.IpcRendererEvent, step: ProvisioningProgress) => callback(step);
    ipcRenderer.on('cloud:provisioning-progress', listener);
    return () => void ipcRenderer.removeListener('cloud:provisioning-progress', listener);
  },
  onWorkspaceConflicts: (callback: (data: { paths: string[] }) => void) => {
    const listener = (_: Electron.IpcRendererEvent, data: { paths: string[] }) => callback(data);
    ipcRenderer.on('cloud:workspace-conflicts', listener);
    return () => void ipcRenderer.removeListener('cloud:workspace-conflicts', listener);
  },
  // Pending cloud updates (newer cloud-only versions of OS-synced files) changed.
  // Mirrors onWorkspaceConflicts but a distinct, calmer signal — REBEL-696 Stage 5.
  onWorkspacePendingUpdates: (callback: (data: { paths: string[] }) => void) => {
    const listener = (_: Electron.IpcRendererEvent, data: { paths: string[] }) => callback(data);
    ipcRenderer.on('cloud:workspace-pending-updates', listener);
    return () => void ipcRenderer.removeListener('cloud:workspace-pending-updates', listener);
  },
  onSessionConflict: (callback: (data: {
    sessionId: string;
    conflictType: 'stale-metadata' | 'concurrent-edit';
    fields?: string[];
    detectedAt: number;
  }) => void) => {
    const listener = (
      _: Electron.IpcRendererEvent,
      data: {
        sessionId: string;
        conflictType: 'stale-metadata' | 'concurrent-edit';
        fields?: string[];
        detectedAt: number;
      },
    ) => callback(data);
    ipcRenderer.on('cloud:session-conflict', listener);
    return () => void ipcRenderer.removeListener('cloud:session-conflict', listener);
  },
  onCloudUpdateStatus: (callback: (data: { status: string; message: string; timestamp: number }) => void) => {
    const listener = (_: Electron.IpcRendererEvent, data: { status: string; message: string; timestamp: number }) => callback(data);
    ipcRenderer.on('cloud:update-status', listener);
    return () => void ipcRenderer.removeListener('cloud:update-status', listener);
  },
  onPressureState: (callback: (data: {
    state: 'ok' | 'warning' | 'critical' | 'unknown';
    timestamp: number;
    recentPressureEvents?: Array<{
      state: 'ok' | 'warning' | 'critical' | 'unknown';
      at: number;
      oom: boolean;
      recentRestart: boolean;
    }>;
  }) => void) => {
    type PressurePayload = Parameters<typeof callback>[0];
    const listener = (_: Electron.IpcRendererEvent, data: PressurePayload) => callback(data);
    ipcRenderer.on('cloud:pressure-state', listener);
    return () => void ipcRenderer.removeListener('cloud:pressure-state', listener);
  },
};

type PluginCompileAndRegisterRequest = IpcRequestOf<'plugins:compile-and-register'>;
type PluginCompileAndRegisterResponse = IpcResponseOf<'plugins:compile-and-register'>;
type PluginCompileAndRegisterHandler = (
  request: PluginCompileAndRegisterRequest,
) => Promise<PluginCompileAndRegisterResponse> | PluginCompileAndRegisterResponse;

// Eagerly register the compile-and-register listener so messages arriving before
// the React handler is ready are buffered instead of lost (cold-start race fix).
let pluginCompileHandler: PluginCompileAndRegisterHandler | null = null;
const COMPILE_BUFFER_TTL_MS = 25_000; // slightly under main-side 30s timeout
const COMPILE_BUFFER_MAX = 8;
const pendingCompileRequests: Array<{
  request: PluginCompileAndRegisterRequest;
  port: MessagePort;
  queuedAt: number;
}> = [];

function dispatchCompileRequest(
  handler: PluginCompileAndRegisterHandler,
  request: PluginCompileAndRegisterRequest,
  port: MessagePort,
): void {
  Promise.resolve(handler(request))
    .then((response) => {
      port.postMessage(response);
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      const response: PluginCompileAndRegisterResponse = {
        ok: false,
        errors: [{ type: 'runtime', message }],
      };
      port.postMessage(response);
    });
}

ipcRenderer.on(
  'plugins:compile-and-register',
  (event: Electron.IpcRendererEvent & { ports?: MessagePort[] }, request: PluginCompileAndRegisterRequest) => {
    const port = event.ports?.[0];
    if (!port) {
      return;
    }

    if (pluginCompileHandler) {
      dispatchCompileRequest(pluginCompileHandler, request, port);
    } else {
      // Drop oldest if buffer is full
      if (pendingCompileRequests.length >= COMPILE_BUFFER_MAX) {
        pendingCompileRequests.shift();
      }
      pendingCompileRequests.push({ request, port, queuedAt: Date.now() });
    }
  },
);

const pluginsApi = {
  ...generatedPluginsApi,
  onPluginUnregister: (callback: (pluginId: string) => void) => {
    const listener = (_: Electron.IpcRendererEvent, pluginId: string) => callback(pluginId);
    ipcRenderer.on('plugins:unregister', listener);
    return () => void ipcRenderer.removeListener('plugins:unregister', listener);
  },
  onPluginNavigate: (callback: (pluginId: string, params?: Record<string, string>) => void) => {
    const listener = (_: Electron.IpcRendererEvent, payload: unknown) => {
      // Support both old format (string pluginId) and new format ({ pluginId, params })
      if (typeof payload === 'string') {
        callback(payload);
      } else if (payload && typeof payload === 'object' && 'pluginId' in payload) {
        const p = payload as { pluginId: string; params?: Record<string, string> };
        callback(p.pluginId, p.params);
      }
    };
    ipcRenderer.on('plugins:navigate', listener);
    return () => void ipcRenderer.removeListener('plugins:navigate', listener);
  },
  onSpacePluginsChanged: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('plugins:space-changed', listener);
    return () => void ipcRenderer.removeListener('plugins:space-changed', listener);
  },
  onCompileAndRegisterRequest: (handler: PluginCompileAndRegisterHandler) => {
    pluginCompileHandler = handler;

    // Drain buffered requests, skipping any that are older than the TTL
    // (main side will have already timed out and returned an error)
    const now = Date.now();
    let pending = pendingCompileRequests.shift();
    while (pending) {
      if (now - pending.queuedAt < COMPILE_BUFFER_TTL_MS) {
        dispatchCompileRequest(handler, pending.request, pending.port);
      }
      pending = pendingCompileRequests.shift();
    }

    return () => {
      pluginCompileHandler = null;
    };
  },
};

// =============================================================================
// Extended Bug Report API (generated + status broadcast listener)
// =============================================================================

// Keep in sync with BugReportStatusPayload in src/main/ipc/bugReportHandlers.ts
// (channel is not in the typed broadcast registry). Status vocabulary:
// 'queued' | 'delivered' | 'delivery-unavailable' | 'failed'. `reason` and
// `reportText` are present only for 'delivery-unavailable' (reportText backs the
// renderer's Copy-report toast action).
type BugReportStatusPayload = { status: string; reason?: string; reportText?: string };

const bugReportApi = {
  ...generatedBugReportApi,
  onBugReportStatus: (callback: (data: BugReportStatusPayload) => void) => {
    const listener = (_: Electron.IpcRendererEvent, data: BugReportStatusPayload) => callback(data);
    ipcRenderer.on('bug-report:status', listener);
    return () => void ipcRenderer.removeListener('bug-report:status', listener);
  },
};

const contributionApi = {
  ...generatedContributionApi,
  submitUnified: generatedContributionApi.submitUnified,
  /**
   * @deprecated Use submitUnified({ contributionId }) instead.
   */
  submitFromStore: (
    request: Parameters<typeof generatedContributionApi.submitFromStore>[0],
  ) => generatedContributionApi.submitFromStore(request),
};

// =============================================================================
// E2E (test-only) preload surface
// =============================================================================

export type RebelE2EReadinessPhase = 'booting' | 'login' | 'onboarding' | 'main' | 'safe-mode';

export type RebelE2EReadinessSnapshot = {
  phase: RebelE2EReadinessPhase;
  blockingReason?: string;

  appReady: boolean;
  toolsReady: boolean;
  onboardingCompleted: boolean;
  safeModeEnabled: boolean;
  startupRecoveryDialogVisible: boolean;

  /**
   * Test-mode-only: a Super-MCP startup failure occurred that, in real-user mode, WOULD
   * have shown the startup-recovery dialog — but the dialog is suppressed under e2e mode
   * (see SafeModeOrchestrator). Lets the packaged boot-smoke detect a degraded real-user
   * boot that the suppressed `startupRecoveryDialogVisible` flag would otherwise hide.
   * Sticky once true (setReadiness merges; App.tsx never resets it). Inert for real users
   * (no window.e2eApi).
   */
  superMcpStartupFailed?: boolean;

  updatedAt: number;
};

export type RebelE2EApi = {
  isEnabled: true;
  getReadiness: () => RebelE2EReadinessSnapshot;
  setReadiness: (patch: Partial<RebelE2EReadinessSnapshot>) => void;
  /** Return the active working-model identifier from the composer surface. */
  getActiveModelId: () => string | null;
  /** Return the number of queued text/voice messages in the queue tray. */
  getQueuedMessageCount: () => number;
  /** Return the current composer draft text. */
  getCurrentDraft: () => string | null;
  clearPendingApprovals: () => Promise<{ success: boolean }>;
  clearAllSessions: () => Promise<void>;
  injectToolApproval: (request: Record<string, unknown>) => Promise<{ success: boolean }>;
  injectMemoryApproval: (request: Record<string, unknown>) => Promise<{ success: boolean }>;
  seedStagedCall: (input: Record<string, unknown>) => Promise<{ success: boolean; id: string }>;
  seedStagedFile: (input: Record<string, unknown>) => Promise<{ success: boolean; id: string | null; reason?: string }>;
  seedHeroChoice: (result: Record<string, unknown>) => Promise<{ success: boolean }>;
  seedCoaching: (evaluation: Record<string, unknown>) => Promise<{ success: boolean }>;
  /**
   * REBEL-62A Stage 3: seed a synthetic conflict-copy cleanup plan so the
   * available-cleanup toast can be driven in the packaged app. Writes real
   * identical parent/conflict file pairs under `spaceRootAbsPath`, writes a
   * detect manifest keyed by `runId` under userData, then broadcasts
   * `conflict-cleanup:available`. A subsequent confirm exercises the real
   * reload + move path. Returns the actual counts written + a sample.
   */
  seedConflictCleanupPlan: (input: {
    runId?: string;
    spaceName?: string;
    spaceRootAbsPath: string;
    quarantineCount?: number;
    needsReviewCount?: number;
    sample?: string[];
  }) => Promise<{
    success: boolean;
    runId: string;
    spaceRootAbsPath: string;
    quarantineCount: number;
    needsReviewCount: number;
    sample: string[];
    reason?: string;
  }>;
  injectAgentEvent: (data: { turnId: string; event: Record<string, unknown>; sessionId?: string }) => void;
  /**
   * Stage 3a of docs/plans/260611_fsevents-shutdown-crash: read-only main-process
   * diagnostic for the fsevents leak guard + workspace-watcher state. Backs the
   * GATING packaged interception assertion in scripts/check-packaged-app-boot-smoke.ts
   * (darwin: watcher ready ⇒ liveNativeInstanceCount > 0). Test-mode-only — the
   * main-side handler is registered only under REBEL_E2E_TEST_MODE.
   */
  getFseventsLeakGuardDiagnostics: () => Promise<{
    platform: string;
    guard: { installState: string | null; quitMode: boolean; liveNativeInstanceCount: number };
    watcher: { isWatching: boolean; currentDirectory: string | null; readyObserved: boolean };
  }>;
  /**
   * Final-review DA F1 (leak-injection stress evidence): starts ONE raw native
   * fsevents instance (app-owned temp dir) and deliberately never stops it —
   * the chokidar-pool leak shape — so the packaged stress can verify the
   * point-of-no-return sweep force-stops it (sweptCount=1, no SIGABRT).
   * Test-mode-only — main-side handler registered only under REBEL_E2E_TEST_MODE.
   */
  injectFseventsLeak: () => Promise<{
    platform: string;
    watchDir: string;
    injected: boolean;
    reason?: string;
    liveNativeInstanceCount: number;
  }>;
};

const e2eTestModeArg = process.argv.includes('--e2e-test-mode');
const testUserDataDirArg = process.argv.find((arg) => arg.startsWith('--e2e-test-user-data-dir='));
const testUserDataDir = testUserDataDirArg ? testUserDataDirArg.split('=')[1] : '';
const isE2EApiEnabled = e2eTestModeArg && testUserDataDir.trim().length > 0;

// Diagnostic logging for E2E mode detection (helps debug Windows CI issues)
console.log('[Preload] E2E mode check:', {
  e2eTestModeArg,
  testUserDataDir: testUserDataDir ? '[SET]' : '[NOT SET]',
  isE2EApiEnabled,
});

if (isE2EApiEnabled) {
  let readiness: RebelE2EReadinessSnapshot = {
    phase: 'booting',
    appReady: false,
    toolsReady: false,
    onboardingCompleted: false,
    safeModeEnabled: false,
    startupRecoveryDialogVisible: false,
    superMcpStartupFailed: false,
    updatedAt: Date.now(),
  };

  const e2eApi: RebelE2EApi = {
    isEnabled: true,
    getReadiness: () => readiness,
    setReadiness: (patch) => {
      const { updatedAt: _ignoredUpdatedAt, ...rest } = patch;
      readiness = {
        ...readiness,
        ...rest,
        updatedAt: Date.now(),
      };
    },
    getActiveModelId: () => {
      // Preferred path if a dedicated attribute exists.
      const modelSelector = document.querySelector('[data-testid="model-selector"]');
      const activeModelAttr = modelSelector?.getAttribute('data-active-model');
      if (activeModelAttr && activeModelAttr.trim().length > 0) {
        return activeModelAttr;
      }

      // Current implementation uses the hidden/visible advanced selector for working model.
      const workingModelSelect = document.querySelector<HTMLSelectElement>('#conv-working-model');
      const workingModelId = workingModelSelect?.value?.trim();
      return workingModelId && workingModelId.length > 0 ? workingModelId : null;
    },
    getQueuedMessageCount: () => {
      const queueItems = document.querySelectorAll('[data-testid^="queued-message-item-"]');
      return queueItems.length;
    },
    getCurrentDraft: () => {
      const composer = document.querySelector<HTMLTextAreaElement>('[data-testid="composer-input"]');
      return composer ? composer.value : null;
    },
    clearPendingApprovals: () => ipcRenderer.invoke('e2e:clear-pending-approvals'),
    clearAllSessions: async () => {
      const result = await ipcRenderer.invoke('e2e:clear-all-sessions') as
        | { success: true; deletedCount: number; deletedIds?: string[] }
        | { success: false; deletedCount?: number; error?: { message?: string } };
      if (!result?.success) {
        throw new Error(result?.error?.message ?? 'Failed to clear E2E sessions');
      }
      // Carry the disk-deleted ids so the renderer can tombstone the full set,
      // not just currently-visible summaries — prevents a stale async save /
      // disk reconciliation from resurrecting a just-deleted session.
      window.dispatchEvent(
        new CustomEvent('rebel-e2e:clear-all-sessions', {
          detail: { deletedIds: result.deletedIds ?? [] },
        }),
      );
    },
    injectToolApproval: (request: Record<string, unknown>) => ipcRenderer.invoke('e2e:inject-tool-approval', request),
    injectMemoryApproval: (request: Record<string, unknown>) => ipcRenderer.invoke('e2e:inject-memory-approval', request),
    seedStagedCall: (input: Record<string, unknown>) => ipcRenderer.invoke('e2e:seed-staged-call', input),
    seedStagedFile: (input: Record<string, unknown>) => ipcRenderer.invoke('e2e:seed-staged-file', input),
    seedHeroChoice: (result: Record<string, unknown>) => ipcRenderer.invoke('e2e:seed-hero-choice', result),
    seedCoaching: (evaluation: Record<string, unknown>) => ipcRenderer.invoke('e2e:seed-coaching', evaluation),
    seedConflictCleanupPlan: (input: Parameters<RebelE2EApi['seedConflictCleanupPlan']>[0]) =>
      ipcRenderer.invoke('e2e:seed-conflict-cleanup-plan', input),
    injectAgentEvent: (data: { turnId: string; event: Record<string, unknown>; sessionId?: string }) => {
      ipcRenderer.emit('agent:event', {} as Electron.IpcRendererEvent, data);
    },
    getFseventsLeakGuardDiagnostics: () => ipcRenderer.invoke('e2e:fsevents-leak-guard-diagnostics'),
    injectFseventsLeak: () => ipcRenderer.invoke('e2e:fsevents-inject-leak'),
  };

  contextBridge.exposeInMainWorld('e2eApi', e2eApi);
}

// =============================================================================
// Dev-only event injection helper (for testing UI features from the console)
// =============================================================================
if (process.env.NODE_ENV === 'development') {
  contextBridge.exposeInMainWorld('__rebelDev', {
    injectAgentEvent: (data: { turnId: string; event: Record<string, unknown>; sessionId?: string }) => {
      ipcRenderer.emit('agent:event', {} as Electron.IpcRendererEvent, data);
    },
  });
}

// =============================================================================
// Rebel Test Mode — Auto Guest Mode
// =============================================================================
// When --rebel-test-mode is passed, auto-activate guest mode so the test instance
// boots to a usable state without login. Uses sessionStorage + event dispatch
// (same mechanism as CDP-based guest mode injection in /test-ui).

const isRebelTestModePreload = process.argv.includes('--rebel-test-mode');

if (isRebelTestModePreload) {
  window.addEventListener('DOMContentLoaded', () => {
    sessionStorage.setItem('guestMode', 'true');
    window.dispatchEvent(new Event('guestModeChange'));
    console.log('[rebel-test] Guest mode auto-activated via preload');
  });
}

// =============================================================================
// Emergency Recovery API
// =============================================================================
// Fire-and-forget API for emergency startup recovery when normal IPC may be hung.
// Uses ipcRenderer.send() instead of invoke() to avoid waiting for a response.
// This is used by EmergencyStartupRecovery when settings fail to load.

const emergencyApi = {
  /**
   * Request safe mode restart without waiting for response.
   * Uses fire-and-forget IPC - the main process will handle the restart.
   * Returns immediately; caller should show "restarting..." UI.
   */
  requestSafeModeRestart: () => {
    ipcRenderer.send('app:emergency-safe-mode-request');
  },
  
  /**
   * Request app quit without waiting for response.
   * Fallback when safe mode restart doesn't work.
   */
  requestQuit: () => {
    ipcRenderer.send('app:emergency-quit-request');
  },

  /**
   * Request app relaunch without waiting for response.
   * Used by error boundary when API mismatch requires a full restart.
   */
  requestRelaunch: () => {
    ipcRenderer.send('app:emergency-relaunch-request');
  },
};

contextBridge.exposeInMainWorld('emergencyApi', emergencyApi);

export type EmergencyApi = typeof emergencyApi;

// =============================================================================
// Legacy API Surface
// =============================================================================
// This flat API object is preserved for backward compatibility.
// It uses the same underlying IPC channels as the domain-specific APIs.
// TODO (Stage 2+): Migrate renderer code to use workspaceApi/settingsApi directly

const api = {
  getSettings: () => ipcRenderer.invoke('settings:get') as Promise<AppSettings>,
  updateSettings: (settings: AppSettings) => ipcRenderer.invoke('settings:update', settings) as Promise<AppSettings>,
  getDefaultWorkspacePath: () => ipcRenderer.invoke('settings:get-default-workspace') as Promise<string>,
  chooseDirectory: () => ipcRenderer.invoke('settings:choose-directory') as Promise<string | null>,
  chooseFile: (filters?: Electron.FileFilter[]) =>
    ipcRenderer.invoke('settings:choose-file', filters) as Promise<string | null>,
  chooseExecutable: () => ipcRenderer.invoke('settings:choose-executable') as Promise<string | null>,
  getMcpSummary: (params?: { settings?: AppSettings; skipMetadata?: boolean }) =>
    ipcRenderer.invoke('settings:mcp-summary', params ?? null) as Promise<McpConfigSummary>,
  ensureManagedMcpConfig: () => ipcRenderer.invoke('settings:mcp-ensure-managed') as Promise<{ configPath: string }>,

  getMcpServerDetails: (serverName: string) =>
    ipcRenderer.invoke('settings:mcp-get-server', serverName) as Promise<McpServerConfigDetails>,
  /** Adds all 7 split Rebel MCPs (RebelInbox, RebelMeetings, etc.). Name kept for compatibility. */
  addRebelInternalServer: () =>
    ipcRenderer.invoke('settings:mcp-add-rebel-server') as Promise<McpConfigMutationResult>,
  /** @deprecated Use addRebelInternalServer (adds all 7 split Rebel MCPs) */
  addRebelInboxServer: () =>
    ipcRenderer.invoke('settings:mcp-add-rebel-server') as Promise<McpConfigMutationResult>,
  /** @deprecated Use addRebelInternalServer (adds all 7 split Rebel MCPs) */
  addRebelTaskQueueServer: () =>
    ipcRenderer.invoke('settings:mcp-add-rebel-server') as Promise<McpConfigMutationResult>,
  upsertMcpServer: (payload: McpServerUpsertPayload) =>
    ipcRenderer.invoke('settings:mcp-upsert-server', payload) as Promise<McpConfigMutationResult>,
  removeMcpServer: (serverName: string) =>
    ipcRenderer.invoke('settings:mcp-remove-server', serverName) as Promise<McpConfigMutationResult>,
  patchMcpRouterPath: (payload: McpRouterPathPatchPayload) =>
    ipcRenderer.invoke('settings:mcp-router-path', payload) as Promise<McpConfigMutationResult>,
  loadAgentSessions: () => ipcRenderer.invoke('sessions:load') as Promise<AgentSession[]>,
  saveAgentSessions: (sessions: AgentSession[]) => ipcRenderer.invoke('sessions:save', sessions) as Promise<{ success: boolean }>,
  // Synchronous save for beforeunload - async invoke doesn't complete before window closes in dev mode
  saveAgentSessionsSync: (sessions: AgentSession[]) => ipcRenderer.sendSync('sessions:save-sync', sessions) as { success: boolean; error?: string },
  // Inbox methods (new naming)
  loadInbox: () => ipcRenderer.invoke('inbox:load') as Promise<InboxState>,
  deleteInboxItem: (itemId: string) => ipcRenderer.invoke('inbox:delete', itemId) as Promise<InboxState>,
  recordInboxExecution: (payload: { itemId: string; sessionId: string; mode: InboxExecutionMode; executedAt?: number }) =>
    ipcRenderer.invoke('inbox:record-execution', payload) as Promise<InboxState>,
  onInboxUpdate: (callback: (state: InboxState) => void) => {
    const listener = (_: Electron.IpcRendererEvent, state: InboxState) => callback(state);
    ipcRenderer.on('inbox:state', listener);
    return () => void ipcRenderer.removeListener('inbox:state', listener);
  },
  // User Tasks (Scratchpad tasks panel)
  onUserTasksUpdate: (callback: (state: UserTasksState) => void) => {
    const listener = (_: Electron.IpcRendererEvent, state: UserTasksState) => callback(state);
    ipcRenderer.on('user-tasks:state', listener);
    return () => void ipcRenderer.removeListener('user-tasks:state', listener);
  },
  // Legacy inbox methods (deprecated, use inbox methods above)
  loadTaskQueue: () => ipcRenderer.invoke('inbox:load') as Promise<InboxState>,
  deleteTask: (itemId: string) => ipcRenderer.invoke('inbox:delete', itemId) as Promise<InboxState>,
  recordTaskExecution: (payload: { taskId: string; sessionId: string; mode: InboxExecutionMode; executedAt?: number }) =>
    ipcRenderer.invoke('inbox:record-execution', { ...payload, itemId: payload.taskId }) as Promise<InboxState>,
  onTaskQueueUpdate: (callback: (state: InboxState) => void) => {
    const listener = (_: Electron.IpcRendererEvent, state: InboxState) => callback(state);
    ipcRenderer.on('inbox:state', listener);
    return () => void ipcRenderer.removeListener('inbox:state', listener);
  },
  loadAutomations: () => ipcRenderer.invoke('automations:state') as Promise<AutomationStoreState>,
  upsertAutomation: (payload: AutomationDefinitionInput) =>
    ipcRenderer.invoke('automations:upsert', payload) as Promise<AutomationDefinition>,
  deleteAutomation: (automationId: string) =>
    ipcRenderer.invoke('automations:delete', automationId) as Promise<AutomationStoreState>,
  runAutomationNow: (automationId: string) => ipcRenderer.invoke('automations:run-now', automationId) as Promise<AutomationRun | null>,
  setSessionTypeFilter: (filter: 'all' | 'conversations' | 'automations') =>
    ipcRenderer.invoke('automations:set-session-type-filter', filter) as Promise<AutomationStoreState>,
  onAutomationState: (callback: (state: AutomationStoreState) => void) => {
    const listener = (_: Electron.IpcRendererEvent, state: AutomationStoreState) => callback(state);
    ipcRenderer.on('automation:state', listener);
    return () => void ipcRenderer.removeListener('automation:state', listener);
  },
  onMemoryUpdateStatus: (callback: (status: MemoryUpdateStatus) => void) => {
    const listener = (_: Electron.IpcRendererEvent, status: MemoryUpdateStatus) => callback(status);
    ipcRenderer.on('memory:update-status', listener);
    return () => void ipcRenderer.removeListener('memory:update-status', listener);
  },
  memoryUpdate: {
    applyStatusToSession: (
      payload: Parameters<typeof memoryApi.applyStatusToSession>[0],
    ): ReturnType<typeof memoryApi.applyStatusToSession> =>
      memoryApi.applyStatusToSession(payload),
  },
  // Memory write approval with destination (Phase 2)
  sendMemoryWriteApprovalResponse: (request: { toolUseId: string; approved: boolean }) =>
    ipcRenderer.invoke('memory:write-approval-response', request) as Promise<{
      success: boolean;
      sessionId?: string;
      filePath?: string;
      spaceName?: string;
      content?: string;
      error?: string;
    }>,
  onMemoryWriteApprovalRequest: (callback: (data: MemoryWriteApprovalRequestBroadcast) => void) => {
    const listener = (_: Electron.IpcRendererEvent, data: MemoryWriteApprovalRequestBroadcast) => callback(data);
    ipcRenderer.on('memory:write-approval-request', listener);
    return () => void ipcRenderer.removeListener('memory:write-approval-request', listener);
  },
  // Memory write approval resolved (for real-time sync across surfaces)
  onMemoryWriteApprovalResolved: (callback: (data: MemoryWriteApprovalResolvedBroadcast) => void) => {
    const listener = (_: Electron.IpcRendererEvent, data: MemoryWriteApprovalResolvedBroadcast) => callback(data);
    ipcRenderer.on('memory:write-approval-resolved', listener);
    return () => void ipcRenderer.removeListener('memory:write-approval-resolved', listener);
  },
  // Memory staging notifications (files staged, approved, or discarded)
  onStagedFilesChanged: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('memory:staged-files-changed', listener);
    return () => void ipcRenderer.removeListener('memory:staged-files-changed', listener);
  },
  // Memory staging API
  getStagedFiles: () =>
    ipcRenderer.invoke('memory:staging-get-all') as Promise<{ files: Array<{
      id: string;
      realPath: string;
      spaceName: string;
      spacePath: string;
      location?: FileLocation;
      sessionId: string;
      baseHash: string;
      summary: string;
      stagedAt: number;
      sensitivity: 'high';
      sharing?: string;
      blockedBy?: BlockSource;
      hasConflict?: boolean;
      // F3-1-residual: pass through the additional canonical schema fields so
      // the shared `deriveUnifiedApprovals` mapper can perform destination-
      // and toolUseId-based dedup / cascade on desktop. Keep optional to
      // preserve backwards compatibility with any earlier serialized payload.
      approvalKind?: 'memory_write' | 'shared_skill_checkpoint';
      authorLabel?: string;
      toolUseId?: string;
      pendingDestination?: string;
    }> }>,
  getStagedContent: (id: string) =>
    ipcRenderer.invoke('memory:staging-get-content', { id }) as Promise<string | null>,
  /**
   * Stage C (260417_approval_consolidation_closeout): optional
   * `clientDedupKey` (UUID) threads through to the server-side IPC
   * dedup cache. Desktop doesn't use a retry loop today, so the dedup
   * key mostly guards against UI double-dispatch (double-click, remounted
   * handler re-fire, etc.). Caller should generate one UUID per
   * user-triggered action, never per retry.
   */
  publishStagedFile: (id: string, clientDedupKey?: string) =>
    ipcRenderer.invoke('memory:staging-publish', { id, clientDedupKey }) as Promise<{
      status: 'success' | 'conflict' | 'not-found' | 'error' | 'already-resolved';
      error?: string;
      conflict?: { baseContent: string | null; realContent: string; stagedContent: string };
    }>,
  discardStagedFile: (id: string, clientDedupKey?: string) =>
    ipcRenderer.invoke('memory:staging-discard', { id, clientDedupKey }) as Promise<{
      status: 'success' | 'not-found' | 'error';
      error?: string;
    }>,
  keepStagedFilePrivate: (id: string, clientDedupKey?: string) =>
    ipcRenderer.invoke('memory:staging-keep-private', { id, clientDedupKey }) as Promise<{
      status: 'success' | 'not-found' | 'error' | 'already-resolved';
      error?: string;
      destinationPath?: string;
    }>,
  publishAllStagedFiles: () =>
    ipcRenderer.invoke('memory:staging-publish-all') as Promise<{
      published: string[];
      conflicts: string[];
      errors: string[];
    }>,
  discardAllStagedFiles: () =>
    ipcRenderer.invoke('memory:staging-discard-all') as Promise<{ success: boolean }>,
  /**
   * Mint a short-lived capability token authorizing resolution of the
   * given staged-file conflict. Stage B (260417_approval_consolidation_closeout):
   * {@link publishWithConflictResolution} now requires the minted token.
   */
  mintConflictCapability: (stagedFileId: string) =>
    ipcRenderer.invoke('memory:staging-mint-conflict-capability', { stagedFileId }) as Promise<
      | { success: true; token: string; expiresAt: number }
      | {
          success: false;
          error:
            | 'UNKNOWN_STAGED_FILE'
            | 'INVALID_INPUT'
            | 'SERVICE_UNAVAILABLE'
            | 'READ_ONLY';
        }
    >,
  publishWithConflictResolution: (
    id: string,
    resolution: 'keep-staged' | 'keep-real',
    capabilityToken: string,
    clientDedupKey?: string,
  ) =>
    ipcRenderer.invoke('memory:staging-resolve-conflict', {
      id,
      resolution,
      capabilityToken,
      clientDedupKey,
    }) as Promise<{
      status: 'success' | 'not-found' | 'error' | 'already-resolved';
      error?: string;
    }>,
  onTimeSavedStatus: (callback: (status: TimeSavedStatus) => void) => {
    const listener = (_: Electron.IpcRendererEvent, status: TimeSavedStatus) => callback(status);
    ipcRenderer.on('time-saved:status', listener);
    return () => void ipcRenderer.removeListener('time-saved:status', listener);
  },
  timeSaved: {
    applyStatusToSession: (
      payload: Parameters<typeof memoryApi.applyTimeSavedStatusToSession>[0],
    ): ReturnType<typeof memoryApi.applyTimeSavedStatusToSession> =>
      memoryApi.applyTimeSavedStatusToSession(payload),
  },
  onCoachingReflection: (callback: (data: { sessionId: string; evaluation: SessionCoachingEvaluation }) => void) => {
    const listener = (_: Electron.IpcRendererEvent, data: { sessionId: string; evaluation: SessionCoachingEvaluation }) => callback(data);
    ipcRenderer.on('coaching:reflection', listener);
    return () => void ipcRenderer.removeListener('coaching:reflection', listener);
  },
  onSystemImprovementSuggestion: (callback: (suggestion: Record<string, unknown>) => void) => {
    const listener = (_: Electron.IpcRendererEvent, suggestion: Record<string, unknown>) => callback(suggestion);
    ipcRenderer.on('system-improvement:suggestion-available', listener);
    return () => void ipcRenderer.removeListener('system-improvement:suggestion-available', listener);
  },
  onSkillImprovementComplete: (callback: (data: { skillName: string; skillPath: string; scoreAfter: number; bandAfter: string; lastSessionId?: string }) => void) => {
    const listener = (_: Electron.IpcRendererEvent, data: { skillName: string; skillPath: string; scoreAfter: number; bandAfter: string; lastSessionId?: string }) => callback(data);
    ipcRenderer.on('library:skill-improvement-complete', listener);
    return () => void ipcRenderer.removeListener('library:skill-improvement-complete', listener);
  },
  onHeroChoiceUpdated: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('hero-choice:updated', listener);
    return () => void ipcRenderer.removeListener('hero-choice:updated', listener);
  },
  onDailySparkUpdated: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('daily-spark:updated', listener);
    return () => void ipcRenderer.removeListener('daily-spark:updated', listener);
  },
  onMcpPermissionChanged: (callback: (payload: McpAppPermissionChangedPayload) => void) => {
    const listener = (_: Electron.IpcRendererEvent, payload: McpAppPermissionChangedPayload) => callback(payload);
    ipcRenderer.on('mcp:permission-changed', listener);
    return () => void ipcRenderer.removeListener('mcp:permission-changed', listener);
  },
  getTimeSavedAggregates: () =>
    ipcRenderer.invoke('time-saved:aggregates') as Promise<{ aggregates: TimeSavedAggregates; trend: WeeklyTrend; trackingSince: number | null }>,
  getTimeSavedBySession: () =>
    ipcRenderer.invoke('time-saved:by-session') as Promise<Record<string, number>>,
  getCoachingSessions: () =>
    ipcRenderer.invoke('misc:get-coaching-sessions') as Promise<{ sessionIds: string[] }>,
  getCoachingForSession: (sessionId: string) =>
    ipcRenderer.invoke('misc:get-coaching-for-session', { sessionId }) as Promise<{ evaluation: unknown }>,
  updateCoachingState: (sessionId: string, state: string, dismissalReason?: string) =>
    ipcRenderer.invoke('misc:update-coaching-state', { sessionId, state, dismissalReason }) as Promise<{ success: boolean }>,
  hasSeenFirstTimeSaved: () =>
    ipcRenderer.invoke('time-saved:has-seen-first') as Promise<boolean>,
  markFirstTimeSavedSeen: () =>
    ipcRenderer.invoke('time-saved:mark-first-seen') as Promise<void>,
  getNextTimeSavedMilestone: () =>
    ipcRenderer.invoke('time-saved:next-milestone') as Promise<number | null>,
  acknowledgeTimeSavedMilestone: (minutes: number) =>
    ipcRenderer.invoke('time-saved:acknowledge-milestone', minutes) as Promise<void>,
  getTodayMinutes: () =>
    ipcRenderer.invoke('time-saved:today-minutes') as Promise<number>,
  getWeekDailyTotals: () =>
    ipcRenderer.invoke('time-saved:week-daily-totals') as Promise<Record<string, number>>,
  shouldShowFirstBigWin: () =>
    ipcRenderer.invoke('time-saved:should-show-first-big-win') as Promise<boolean>,
  shouldShowFirstWeek: () =>
    ipcRenderer.invoke('time-saved:should-show-first-week') as Promise<boolean>,
  markFirstBigWinShown: () =>
    ipcRenderer.invoke('time-saved:mark-first-big-win-shown') as Promise<void>,
  markFirstWeekShown: () =>
    ipcRenderer.invoke('time-saved:mark-first-week-shown') as Promise<void>,
  shouldShowFirstHighImpact: () =>
    ipcRenderer.invoke('time-saved:should-show-first-high-impact') as Promise<boolean>,
  markFirstHighImpactShown: () =>
    ipcRenderer.invoke('time-saved:mark-first-high-impact-shown') as Promise<void>,
  getWeekTopSessions: () =>
    ipcRenderer.invoke('time-saved:week-top-sessions') as Promise<TopSessionInfo[]>,
  getTopSessionsForDay: (date: string) =>
    ipcRenderer.invoke('time-saved:day-top-sessions', date) as Promise<TopSessionInfo[]>,
  generateConversationTitle: (payload: ConversationTitleRequestPayload) =>
    ipcRenderer.invoke('conversation:generate-title', payload) as Promise<ConversationTitleResponsePayload>,
  getAnalyticsStatus: () =>
    ipcRenderer.invoke('analytics:status') as Promise<AnalyticsStatusPayload>,
  // Community highlights
  getCommunityHighlights: () =>
    ipcRenderer.invoke('community:get-highlights') as Promise<CommunityHighlightsState>,
  refreshCommunityHighlights: () =>
    ipcRenderer.invoke('community:refresh-highlights') as Promise<{ success: boolean; error?: string }>,
  onCommunityHighlights: (callback: (state: CommunityHighlightsState) => void) => {
    const listener = (_: Electron.IpcRendererEvent, state: CommunityHighlightsState) => callback(state);
    ipcRenderer.on('community:state', listener);
    return () => void ipcRenderer.removeListener('community:state', listener);
  },
  // Community share
  getShareEligibility: (sessionId: string) =>
    ipcRenderer.invoke('community:get-share-eligibility', { sessionId }) as Promise<{ eligibility: unknown }>,
  composeSharePost: (sessionId: string) =>
    ipcRenderer.invoke('community:compose-share-post', { sessionId }) as Promise<{ preview: unknown; error?: string; errorKind?: string }>,
  openDiscourseShare: (sessionId: string) =>
    ipcRenderer.invoke('community:open-discourse-share', { sessionId }) as Promise<{ success: boolean; error?: string }>,
  dismissShare: (sessionId: string) =>
    ipcRenderer.invoke('community:dismiss-share', { sessionId }) as Promise<void>,
  optOutSharing: () =>
    ipcRenderer.invoke('community:opt-out-sharing') as Promise<void>,
  onCommunityShareEligible: (callback: (data: { sessionId: string; eligibility: unknown }) => void) => {
    const listener = (_: Electron.IpcRendererEvent, data: { sessionId: string; eligibility: unknown }) => callback(data);
    ipcRenderer.on('community:share-eligible', listener);
    return () => void ipcRenderer.removeListener('community:share-eligible', listener);
  },
  // Meeting bot status
  onMeetingBotStatus: (callback: (status: { state: string; source?: 'desktop_sdk' | 'cloud_bot' | 'local_recording' | 'physical_recording'; meeting?: { id: string; title: string; startTime: string; meetingUrl: string; participants?: string[] }; botId?: string; recordingDuration?: number; quip?: string; timestamp: number }) => void) => {
    const listener = (_: Electron.IpcRendererEvent, status: { state: string; source?: 'desktop_sdk' | 'cloud_bot' | 'local_recording' | 'physical_recording'; meeting?: { id: string; title: string; startTime: string; meetingUrl: string; participants?: string[] }; botId?: string; recordingDuration?: number; quip?: string; timestamp: number }) => callback(status);
    ipcRenderer.on('meeting-bot:status', listener);
    return () => void ipcRenderer.removeListener('meeting-bot:status', listener);
  },
  onMeetingTriggerDetected: (callback: (payload: MeetingTriggerDetectedPayload) => void) => {
    const listener = (_: Electron.IpcRendererEvent, payload: unknown) => {
      const parsed = MeetingTriggerDetectedPayloadSchema.safeParse(payload);
      if (!parsed.success) {
        console.warn('[Preload] Ignoring invalid meeting:trigger-detected payload', parsed.error.flatten());
        return;
      }
      callback(parsed.data);
    };
    ipcRenderer.on(MEETING_TRIGGER_DETECTED_CHANNEL, listener);
    return () => void ipcRenderer.removeListener(MEETING_TRIGGER_DETECTED_CHANNEL, listener);
  },
  // Meeting bot health warnings (e.g. SDK init failure, FDA required)
  onMeetingBotHealthWarning: (callback: (data: { warning: string; type?: string; resolved?: boolean; timestamp: number }) => void) => {
    const listener = (_: Electron.IpcRendererEvent, data: { warning: string; type?: string; resolved?: boolean; timestamp: number }) => callback(data);
    ipcRenderer.on('meeting-bot:health-warning', listener);
    return () => void ipcRenderer.removeListener('meeting-bot:health-warning', listener);
  },
  // Physical recording analysis events
  onPhysicalRecordingAnalysisComplete: (callback: (data: { title: string; filePath: string }) => void) => {
    const listener = (_: Electron.IpcRendererEvent, data: { title: string; filePath: string }) => callback(data);
    ipcRenderer.on('physical-recording:analysis-complete', listener);
    return () => void ipcRenderer.removeListener('physical-recording:analysis-complete', listener);
  },
  onPhysicalRecordingAnalysisFailed: (callback: (data: { title: string; error?: string }) => void) => {
    const listener = (_: Electron.IpcRendererEvent, data: { title: string; error?: string }) => callback(data);
    ipcRenderer.on('physical-recording:analysis-failed', listener);
    return () => void ipcRenderer.removeListener('physical-recording:analysis-failed', listener);
  },
  // Meeting bot methods
  sendMeetingBot: (payload: { meetingUrl: string; meetingTitle?: string; avatarId?: string; scheduledFor?: string; forceJoin?: boolean }) =>
    ipcRenderer.invoke('meeting-bot:send', payload) as Promise<{ success: boolean; botId?: string; error?: string; isOwner?: boolean; canOverride?: boolean; ownerName?: string }>,
  cancelMeetingBot: (botId: string) =>
    ipcRenderer.invoke('meeting-bot:cancel', { botId }) as Promise<{ success: boolean; error?: string; recoverable?: boolean }>,
  dismissMeetingStatus: () =>
    ipcRenderer.invoke('meeting-bot:dismiss-status') as Promise<{ success: boolean }>,
  skipMeeting: (meetingUrl: string) =>
    ipcRenderer.invoke('meeting-bot:skip-meeting', { meetingUrl }) as Promise<{ success: boolean }>,
  // Meeting bot Desktop SDK methods (kept for future local recording support)
  startMeetingRecording: (uploadToken: string) =>
    ipcRenderer.invoke('meeting-bot:start-recording', { uploadToken }) as Promise<{ success: boolean; error?: string }>,
  stopMeetingRecording: () =>
    ipcRenderer.invoke('meeting-bot:stop-recording') as Promise<{ success: boolean; error?: string }>,
  getCurrentMeeting: () =>
    ipcRenderer.invoke('meeting-bot:get-current-meeting') as Promise<{ windowId: string; title: string; url: string; platform: string } | null>,
  getCurrentMeetingStatus: () =>
    ipcRenderer.invoke('meeting-bot:get-current-status') as Promise<{
      state: string;
      source?: 'desktop_sdk' | 'cloud_bot' | 'local_recording' | 'physical_recording';
      meeting?: { id: string; title: string; startTime: string; meetingUrl: string; prepPath?: string };
      botId?: string;
      quip?: string;
      recordingDuration?: number;
    }>,
  isMeetingSdkReady: () =>
    ipcRenderer.invoke('meeting-bot:is-sdk-ready') as Promise<boolean>,
  transcribeAudio: (payload: VoiceTranscriptionPayload) =>
    ipcRenderer.invoke('voice:transcribe', payload) as Promise<string>,
  textToSpeech: (text: string) => ipcRenderer.invoke('voice:text-to-speech', text) as Promise<ArrayBuffer>,
  textToSpeechWithTimestamps: (text: string) => ipcRenderer.invoke('voice:text-to-speech-with-timestamps', text) as Promise<{
    audio: ArrayBuffer;
    alignment: {
      characters: string[];
      characterStartTimesSeconds: number[];
      characterEndTimesSeconds: number[];
    };
  }>,
  onTtsChunk: (callback: (chunk: ArrayBuffer) => void) => {
    const listener = (_: Electron.IpcRendererEvent, chunk: ArrayBuffer) => callback(chunk);
    ipcRenderer.on('voice:tts-chunk', listener);
    return () => void ipcRenderer.removeListener('voice:tts-chunk', listener);
  },
  onVoiceActivationHotkey: (callback: (payload?: {
    screenshot: { base64Data: string; width: number; height: number; sizeBytes: number } | null;
    screenshotError?: 'screen-permission' | 'capture-failed';
  }) => void) => {
    const listener = (_: Electron.IpcRendererEvent, payload?: {
      screenshot: { base64Data: string; width: number; height: number; sizeBytes: number } | null;
      screenshotError?: 'screen-permission' | 'capture-failed';
    }) => callback(payload);
    ipcRenderer.on('voice:activation-hotkey-fired', listener);
    return () => void ipcRenderer.removeListener('voice:activation-hotkey-fired', listener);
  },
  startAgentTurn: (request: AgentTurnRequest) => ipcRenderer.invoke('agent:turn', request) as Promise<{ turnId: string }>,
  stopTurn: (turnId: string) => ipcRenderer.invoke('agent:stop-turn', turnId) as Promise<{ success: boolean; reason?: string }>,
  generateSummary: (request: { messages: Array<{ role: 'user' | 'assistant' | 'result'; text: string }>; largeToolNames?: string[] }) =>
    ipcRenderer.invoke('agent:generate-summary', request) as Promise<{ summary: string | null; error?: string }>,
  sendToolSafetyResponse: (request: { toolUseID: string; approved: boolean; input: Record<string, unknown> }) =>
    ipcRenderer.invoke('agent:tool-safety-response', request) as Promise<{ success: boolean }>,
  onToolSafetyApprovalRequest: (callback: (data: ToolSafetyApprovalRequestBroadcast) => void) => {
    const listener = (_: Electron.IpcRendererEvent, data: ToolSafetyApprovalRequestBroadcast) => callback(data);
    ipcRenderer.on('tool-safety:approval-request', listener);
    return () => void ipcRenderer.removeListener('tool-safety:approval-request', listener);
  },
  // Tool safety approval resolved (for real-time sync across surfaces)
  onToolSafetyApprovalResolved: (callback: (data: ToolSafetyApprovalResolvedBroadcast) => void) => {
    const listener = (_: Electron.IpcRendererEvent, data: ToolSafetyApprovalResolvedBroadcast) => callback(data);
    ipcRenderer.on('tool-safety:approval-resolved', listener);
    return () => void ipcRenderer.removeListener('tool-safety:approval-resolved', listener);
  },
  // Staged tool call notifications (staging pattern)
  onStagedToolCall: (callback: (data: ToolSafetyStagedCallBroadcast) => void) => {
    const listener = (_: Electron.IpcRendererEvent, data: ToolSafetyStagedCallBroadcast) => callback(data);
    ipcRenderer.on('tool-safety:staged-call', listener);
    return () => void ipcRenderer.removeListener('tool-safety:staged-call', listener);
  },
  // Cooldown status broadcasts (event-driven toast for rate-limit cooldown enter/exit).
  // Channel: 'cooldown:status-changed' — global app state (no sessionId).
  onCooldownStatusChanged: (callback: (data: {
    scope: 'api' | 'safety-eval' | 'safety-eval-degraded';
    state: 'entered' | 'exited';
    untilMs?: number;
    durationMs?: number;
    /** Cause of the cooldown — populated on safety-eval-degraded scope only. */
    reasonKind?: 'billing' | 'rate_limit' | 'auth' | 'model_unavailable' | 'other';
    /** Absolute epoch-ms reset time — populated on safety-eval-degraded / billing when provider returned one. */
    resetAtMs?: number;
  }) => void) => {
    const listener = (_: Electron.IpcRendererEvent, data: {
      scope: 'api' | 'safety-eval' | 'safety-eval-degraded';
      state: 'entered' | 'exited';
      untilMs?: number;
      durationMs?: number;
      reasonKind?: 'billing' | 'rate_limit' | 'auth' | 'model_unavailable' | 'other';
      resetAtMs?: number;
    }) => callback(data);
    ipcRenderer.on('cooldown:status-changed', listener);
    return () => void ipcRenderer.removeListener('cooldown:status-changed', listener);
  },
  // Staged tool call status updates
  onStagedToolCallUpdated: (callback: (data: ToolSafetyStagedCallUpdatedBroadcast) => void) => {
    const listener = (_: Electron.IpcRendererEvent, data: ToolSafetyStagedCallUpdatedBroadcast) => callback(data);
    ipcRenderer.on('tool-safety:staged-call-updated', listener);
    return () => void ipcRenderer.removeListener('tool-safety:staged-call-updated', listener);
  },
  // Safety-eval progress: lightweight broadcast so the renderer can render a
  // "Checking this is safe…" subline on the matching running-tool row while the
  // Safety Prompt evaluator is in flight. Paired with onSafetyEvaluatingComplete.
  onSafetyEvaluating: (callback: (data: {
    toolUseId: string;
    sessionId: string;
    turnId: string;
    toolName: string;
    attempt: number;
    startedAt: number;
  }) => void) => {
    const listener = (_: Electron.IpcRendererEvent, data: {
      toolUseId: string;
      sessionId: string;
      turnId: string;
      toolName: string;
      attempt: number;
      startedAt: number;
    }) => callback(data);
    ipcRenderer.on('tool-safety:evaluating', listener);
    return () => void ipcRenderer.removeListener('tool-safety:evaluating', listener);
  },
  onSafetyEvaluatingComplete: (callback: (data: {
    toolUseId: string;
    sessionId: string;
    turnId: string;
    outcome: 'allowed' | 'blocked' | 'staged' | 'aborted' | 'error';
  }) => void) => {
    const listener = (_: Electron.IpcRendererEvent, data: {
      toolUseId: string;
      sessionId: string;
      turnId: string;
      outcome: 'allowed' | 'blocked' | 'staged' | 'aborted' | 'error';
    }) => callback(data);
    ipcRenderer.on('tool-safety:evaluating-complete', listener);
    return () => void ipcRenderer.removeListener('tool-safety:evaluating-complete', listener);
  },
  listWorkspaceFiles: (options?: { includeHidden?: boolean }) =>
    ipcRenderer.invoke('library:list-files', options) as Promise<LibraryListFilesResponse>,
  readWorkspaceFile: (targetPath: string) =>
    ipcRenderer.invoke('library:read-file', targetPath) as Promise<{ path: string; content: string; updatedAt?: number }>,
  readFileAsBase64: (targetPath: string) =>
    ipcRenderer.invoke('library:read-file-base64', targetPath) as Promise<string>,
  writeWorkspaceFile: (payload: { path: string; content: string; baseContentHash?: string }) =>
    ipcRenderer.invoke('library:write-file', payload) as Promise<
      | { result: 'ok'; path: string; updatedAt?: number; currentHash?: string }
      | { result: 'conflict'; path: string; currentHash: string }
      | { result: 'failed'; errorCode: string }
    >,
  createWorkspaceFile: (payload: { parentPath?: string; fileName: string }) =>
    ipcRenderer.invoke('library:create-file', payload) as Promise<{ path: string; name: string }>,
  createWorkspaceFolder: (payload: { parentPath?: string; folderName: string }) =>
    ipcRenderer.invoke('library:create-folder', payload) as Promise<{ path: string; name: string }>,
  renameWorkspaceItem: (payload: { itemPath: string; newName: string }) =>
    ipcRenderer.invoke('library:rename-item', payload) as Promise<{ path: string; name?: string }>,
  moveWorkspaceItem: (payload: { itemPath: string; targetDirectoryPath: string }) =>
    ipcRenderer.invoke('library:move-item', payload) as Promise<{ path: string; moved?: boolean }>,
  deleteWorkspaceItem: (payload: { itemPath: string }) =>
    ipcRenderer.invoke('library:delete-item', payload) as Promise<{ success: boolean }>,
  onLibraryChanged: (callback: (data: {
    timestamp: number;
    affectsTree: boolean;
    writerKind?: 'editor' | 'agent' | 'file-watcher' | 'cloud-sync';
    changedPath?: string;
    source: LibraryChangedSource;
  }) => void) => {
    const listener = (_: Electron.IpcRendererEvent, data: {
      timestamp: number;
      affectsTree: boolean;
      writerKind?: 'editor' | 'agent' | 'file-watcher' | 'cloud-sync';
      changedPath?: string;
      source: LibraryChangedSource;
    }) => callback(data);
    ipcRenderer.on('library:changed', listener);
    return () => void ipcRenderer.removeListener('library:changed', listener);
  },
  onFileNeighborsProgress: (callback: (data: { filled: number; total: number }) => void) => {
    const listener = (_: Electron.IpcRendererEvent, data: { filled: number; total: number }) => callback(data);
    ipcRenderer.on('file_neighbors:progress', listener);
    return () => void ipcRenderer.removeListener('file_neighbors:progress', listener);
  },
  onFileNeighborsComplete: (callback: (data: {
    filled: number;
    total: number;
    failed?: number;
    aborted?: boolean;
  }) => void) => {
    const listener = (_: Electron.IpcRendererEvent, data: {
      filled: number;
      total: number;
      failed?: number;
      aborted?: boolean;
    }) => callback(data);
    ipcRenderer.on('file_neighbors:complete', listener);
    return () => void ipcRenderer.removeListener('file_neighbors:complete', listener);
  },
  openPath: (targetPath: string) => ipcRenderer.invoke('app:open-path', targetPath) as Promise<void>,
  revealPath: (targetPath: string) => ipcRenderer.invoke('app:reveal-path', targetPath) as Promise<RevealPathResult>,
  openUrl: (url: string) => ipcRenderer.invoke('app:open-url', url) as Promise<void>,
  exportToPdf: (payload: { html: string; fileName: string }) =>
    ipcRenderer.invoke('export:to-pdf', payload) as Promise<{ success: boolean; filePath?: string; error?: string; cancelled?: boolean }>,
  saveFile: (payload: { data: ArrayBuffer; fileName: string; filters: { name: string; extensions: string[] }[]; title?: string }) =>
    ipcRenderer.invoke('export:save-file', payload) as Promise<{ success: boolean; filePath?: string; error?: string; cancelled?: boolean }>,
  logEvent: (payload: RendererLogPayload) => ipcRenderer.send('log:event', payload),
  captureException: (payload: { message?: string; name?: string; stack?: string; context?: Record<string, unknown> }) =>
    ipcRenderer.invoke('sentry:capture-exception', payload) as Promise<{ eventId: string | undefined }>,
  // 'info' deliberately absent from the level union — raw info-level captures
  // are forbidden (Stage 5 of docs/plans/260610_improve-sentry-noise/PLAN.md).
  captureMessage: (payload: { message: string; level?: 'warning' | 'error' | 'fatal'; context?: Record<string, unknown> }) =>
    ipcRenderer.invoke('sentry:capture-message', payload) as Promise<{ eventId: string | undefined | null }>,
  onAgentEvent: (callback: (event: AgentTurnEvent) => void) => {
    const listener = (_: Electron.IpcRendererEvent, data: AgentTurnEvent) => callback(data);
    ipcRenderer.on('agent:event', listener);
    return () => void ipcRenderer.removeListener('agent:event', listener);
  },
  onAgentRoutePlanResolved: (callback: (event: AgentRoutePlanResolvedEvent) => void) => {
    const listener = (_: Electron.IpcRendererEvent, data: AgentRoutePlanResolvedEvent) =>
      callback(data);
    ipcRenderer.on(AGENT_ROUTE_PLAN_RESOLVED_CHANNEL, listener);
    return () => void ipcRenderer.removeListener(AGENT_ROUTE_PLAN_RESOLVED_CHANNEL, listener);
  },
  onSessionTitleGenerated: (callback: (data: { sessionId: string; title: string; autoTitleGeneratedAt?: number; autoTitleTurnCount?: number }) => void) => {
    const listener = (_: Electron.IpcRendererEvent, data: { sessionId: string; title: string; autoTitleGeneratedAt?: number; autoTitleTurnCount?: number }) => callback(data);
    ipcRenderer.on('session:title-generated', listener);
    return () => void ipcRenderer.removeListener('session:title-generated', listener);
  },
  // Live swap-in for the per-turn AI activity summary (260618 show-more-activity).
  // Mirrors onSessionTitleGenerated: a one-way main→renderer broadcast (no
  // request/response IPC contract). The renderer applies it to the store so the
  // collapsed work-disclosure label repaints from the count-line to the sentence.
  onSessionActivitySummaryGenerated: (callback: (data: { sessionId: string; turnId: string; summary: string }) => void) => {
    const listener = (_: Electron.IpcRendererEvent, data: { sessionId: string; turnId: string; summary: string }) => callback(data);
    ipcRenderer.on('session:activity-summary-generated', listener);
    return () => void ipcRenderer.removeListener('session:activity-summary-generated', listener);
  },
  onDiagnosticsUpdate: (callback: (diagnostics: DiagnosticsSettings) => void) => {
    const listener = (_: Electron.IpcRendererEvent, data: DiagnosticsSettings) => callback(data);
    ipcRenderer.on('diagnostics:update', listener);
    return () => void ipcRenderer.removeListener('diagnostics:update', listener);
  },
  // Permission management APIs
  getMicrophonePermissionStatus: () => 
    ipcRenderer.invoke('permissions:get-microphone-status') as Promise<'not-determined' | 'granted' | 'denied' | 'restricted'>,
  requestMicrophonePermission: () => 
    ipcRenderer.invoke('permissions:request-microphone') as Promise<{ granted: boolean; error?: string }>,
  checkFileAccess: (workspacePath?: string) =>
    ipcRenderer.invoke('permissions:check-file-access', workspacePath) as Promise<{ hasAccess: boolean; reason?: string; errorCode?: string; errorMessage?: string; devMode?: boolean }>,
  openSystemPreferences: (type: 'microphone' | 'files' | 'screen-recording') => 
    ipcRenderer.invoke('permissions:open-system-preferences', type) as Promise<{ success: boolean; reason?: string; error?: string }>,
  // Demo mode
  enterDemoMode: () =>
    ipcRenderer.invoke('demo:enter') as Promise<{ success: boolean; error?: string }>,
  exitDemoMode: () =>
    ipcRenderer.invoke('demo:exit') as Promise<{ success: boolean; error?: string }>,
  getDemoModeStatus: () =>
    ipcRenderer.invoke('demo:status') as Promise<{ active: boolean; hasActiveTurns: boolean }>,
  onDemoModeChange: (callback: (data: { active: boolean }) => void) => {
    const listener = (_: Electron.IpcRendererEvent, data: { active: boolean }) => callback(data);
    ipcRenderer.on('demo:mode-changed', listener);
    return () => void ipcRenderer.removeListener('demo:mode-changed', listener);
  },
  onSettingsExternalUpdate: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('settings:external-update', listener);
    return () => void ipcRenderer.removeListener('settings:external-update', listener);
  },
  // User profile
  onUserEmailIdentified: (callback: (data: { email: string }) => void) => {
    const listener = (_: Electron.IpcRendererEvent, data: { email: string }) => callback(data);
    ipcRenderer.on('user:email-identified', listener);
    return () => void ipcRenderer.removeListener('user:email-identified', listener);
  },
  // Update notifications
  onUpdateDownloaded: (
    callback: (data: {
      updateKey: string;
      version: string;
      downloadUrl?: string;
      recoveryAttempts?: number;
    }) => void,
  ) => {
    const listener = (
      _: Electron.IpcRendererEvent,
      data: { updateKey: string; version: string; downloadUrl?: string; recoveryAttempts?: number },
    ) => callback(data);
    ipcRenderer.on('update:downloaded', listener);
    return () => void ipcRenderer.removeListener('update:downloaded', listener);
  },
  onUpdateError: (callback: (data: {
    code: string;
    category?: 'network' | 'signature' | 'permission' | 'lock' | 'disk' | 'parse' | 'ssl' | 'unknown';
    message: string;
    retryable?: boolean;
  }) => void) => {
    const listener = (
      _: Electron.IpcRendererEvent,
      data: {
        code: string;
        category?: 'network' | 'signature' | 'permission' | 'lock' | 'disk' | 'parse' | 'ssl' | 'unknown';
        message: string;
        retryable?: boolean;
      },
    ) => callback(data);
    ipcRenderer.on('update:error', listener);
    return () => void ipcRenderer.removeListener('update:error', listener);
  },
  onUpdateInstallFailed: (callback: (data: { updateKey?: string; error?: string }) => void) => {
    const listener = (_: Electron.IpcRendererEvent, data: { updateKey?: string; error?: string }) => callback(data);
    ipcRenderer.on('update:install-failed', listener);
    return () => void ipcRenderer.removeListener('update:install-failed', listener);
  },
  // Desktop notification click nudge handling (with buffering to handle race conditions).
  // Payload lives in the main-process consume channel; this event is only a wake-up.
  onNotificationClicked: (() => {
    let bufferedEvent = false;
    let subscriber: (() => void) | null = null;
    
    // Register listener immediately at module load to capture early clicks
    ipcRenderer.on('notification:clicked', () => {
      if (subscriber) {
        subscriber();
      } else {
        // Buffer until subscriber registers
        bufferedEvent = true;
      }
    });
    
    return (callback: () => void) => {
      subscriber = callback;
      // Flush buffered event if any
      if (bufferedEvent) {
        callback();
        bufferedEvent = false;
      }
      return () => {
        subscriber = null;
      };
    };
  })(),
  onSkillChangeNotificationsChanged: (callback: (data: { timestamp: number }) => void) => {
    const listener = (_: Electron.IpcRendererEvent, data: { timestamp: number }) => callback(data);
    ipcRenderer.on('skill-notifications:changed', listener);
    return () => void ipcRenderer.removeListener('skill-notifications:changed', listener);
  },
  // MCP-initiated conversation start (with buffering for early events)
  onConversationStartRequested: (() => {
    type StartPayload = {
      sessionId: string;
      text: string;
      sendMessage: boolean;
      switchToConversation: boolean;
      origin?: AgentSession['origin'];
      systemPromptPrefix?: string;
      externalContext?: AgentSession['externalContext'];
      replayMetadata?: { replayed: boolean; ageMs?: number; replayedAt?: number };
    };
    const MAX_BUFFERED_EVENTS = 50;
    const bufferedEvents: StartPayload[] = [];
    let subscriber: ((data: StartPayload) => void) | null = null;

    const validateAndNormalize = (data: unknown): StartPayload | null => {
      if (!data || typeof data !== 'object') return null;
      const d = data as Record<string, unknown>;
      if (typeof d.sessionId !== 'string' || typeof d.text !== 'string') return null;
      const origin =
        d.origin === 'manual' ||
        // eslint-disable-next-line no-restricted-syntax -- origin-classification-justified: preload payload enum validation accepts the literal origin value; it is not session classification.
        d.origin === 'automation' ||
        d.origin === 'mcp-tool' ||
        d.origin === 'inbound-trigger' ||
        d.origin === 'plugin' ||
        d.origin === 'focus' ||
        d.origin === 'browser-extension' ||
        d.origin === 'operator-personalisation'
          ? d.origin
          : undefined;
      const systemPromptPrefix = typeof d.systemPromptPrefix === 'string' && d.systemPromptPrefix.length > 0
        ? d.systemPromptPrefix
        : undefined;
      // Light shape check; full validation is deferred to the renderer-side
      // store. We accept a `kind` discriminator + `identity`/`metadata` objects.
      let externalContext: AgentSession['externalContext'] | undefined;
      const ec = d.externalContext;
      if (ec && typeof ec === 'object') {
        const ecObj = ec as Record<string, unknown>;
        if (typeof ecObj.kind === 'string' && typeof ecObj.identity === 'object' && ecObj.identity !== null) {
          externalContext = ec as AgentSession['externalContext'];
        }
      }
      let replayMetadata: { replayed: boolean; ageMs?: number; replayedAt?: number } | undefined;
      const rm = d.replayMetadata;
      if (rm && typeof rm === 'object') {
        const rmObj = rm as Record<string, unknown>;
        if (typeof rmObj.replayed === 'boolean') {
          replayMetadata = {
            replayed: rmObj.replayed,
            ...(typeof rmObj.ageMs === 'number' ? { ageMs: rmObj.ageMs } : {}),
            ...(typeof rmObj.replayedAt === 'number' ? { replayedAt: rmObj.replayedAt } : {}),
          };
        }
      }
      return {
        sessionId: d.sessionId,
        text: d.text,
        sendMessage: typeof d.sendMessage === 'boolean' ? d.sendMessage : true,
        switchToConversation: typeof d.switchToConversation === 'boolean' ? d.switchToConversation : false,
        ...(origin ? { origin } : {}),
        ...(systemPromptPrefix ? { systemPromptPrefix } : {}),
        ...(externalContext ? { externalContext } : {}),
        ...(replayMetadata ? { replayMetadata } : {}),
      };
    };

    ipcRenderer.on('conversations:start-requested', (_: Electron.IpcRendererEvent, data: unknown) => {
      const validated = validateAndNormalize(data);
      if (!validated) return;
      if (subscriber) {
        subscriber(validated);
      } else {
        if (bufferedEvents.length >= MAX_BUFFERED_EVENTS) {
          console.warn('[preload] Conversation start event buffer full, dropping oldest');
          bufferedEvents.shift();
        }
        bufferedEvents.push(validated);
      }
    });

    return (callback: (data: StartPayload) => void) => {
      subscriber = callback;
      for (const evt of bufferedEvents) {
        callback(evt);
      }
      bufferedEvents.length = 0;
      return () => {
        subscriber = null;
      };
    };
  })(),
  // External-delivery failure (e.g. Slack-thread retries exhausted, workspace
  // disconnected). Source channel: `external-delivery:failed` from
  // slackThreadAdapter.scheduleRetry / cancelByTeamId. Defensive validation
  // mirrors `onConversationStartRequested`. Malformed payloads are dropped
  // silently (with a console.warn) — never surfaced to the renderer.
  onExternalDeliveryFailed: (() => {
    type FailedPayload = {
      deliveryId: string;
      conversationId: string;
      teamId: string;
      reason: string;
      permanent?: boolean;
    };

    const validateAndNormalize = (data: unknown): FailedPayload | null => {
      if (!data || typeof data !== 'object') return null;
      const d = data as Record<string, unknown>;
      if (typeof d.deliveryId !== 'string' || d.deliveryId.length === 0) return null;
      if (typeof d.conversationId !== 'string' || d.conversationId.length === 0) return null;
      if (typeof d.teamId !== 'string' || d.teamId.length === 0) return null;
      if (typeof d.reason !== 'string' || d.reason.length === 0) return null;
      const out: FailedPayload = {
        deliveryId: d.deliveryId,
        conversationId: d.conversationId,
        teamId: d.teamId,
        reason: d.reason,
      };
      if (typeof d.permanent === 'boolean') out.permanent = d.permanent;
      return out;
    };

    const subscribers = new Set<(data: FailedPayload) => void>();

    ipcRenderer.on('external-delivery:failed', (_: Electron.IpcRendererEvent, data: unknown) => {
      const validated = validateAndNormalize(data);
      if (!validated) {
        console.warn('[preload] external-delivery:failed dropped malformed payload');
        return;
      }
      for (const subscriber of subscribers) {
        try {
          subscriber(validated);
        } catch (err) {
          console.warn('[preload] external-delivery:failed subscriber threw', err);
        }
      }
    });

    return (callback: (data: FailedPayload) => void) => {
      subscribers.add(callback);
      return () => {
        subscribers.delete(callback);
      };
    };
  })(),
  onConversationSendRequested: (() => {
    type SendPayload = {
      sessionId: string;
      text: string;
      sendMessage: boolean;
      switchToConversation: boolean;
      displayText?: string;
    };
    const MAX_BUFFERED_EVENTS = 50;
    const bufferedEvents: SendPayload[] = [];
    let subscriber: ((data: SendPayload) => void) | null = null;

    const validateAndNormalize = (data: unknown): SendPayload | null => {
      if (!data || typeof data !== 'object') return null;
      const d = data as Record<string, unknown>;
      if (typeof d.sessionId !== 'string' || typeof d.text !== 'string') return null;
      return {
        sessionId: d.sessionId,
        text: d.text,
        sendMessage: typeof d.sendMessage === 'boolean' ? d.sendMessage : true,
        switchToConversation: typeof d.switchToConversation === 'boolean' ? d.switchToConversation : false,
        ...(typeof d.displayText === 'string' ? { displayText: d.displayText } : {}),
      };
    };

    ipcRenderer.on('conversations:send-requested', (_: Electron.IpcRendererEvent, data: unknown) => {
      const validated = validateAndNormalize(data);
      if (!validated) return;
      if (subscriber) {
        subscriber(validated);
      } else {
        if (bufferedEvents.length >= MAX_BUFFERED_EVENTS) {
          console.warn('[preload] Conversation send event buffer full, dropping oldest');
          bufferedEvents.shift();
        }
        bufferedEvents.push(validated);
      }
    });

    return (callback: (data: SendPayload) => void) => {
      subscriber = callback;
      for (const evt of bufferedEvents) {
        callback(evt);
      }
      bufferedEvents.length = 0;
      return () => {
        subscriber = null;
      };
    };
  })(),
  // Stage 7 — browser-extension intent broadcasts.
  // All three subscribers use the same buffer-on-early-event idiom as
  // onConversationStartRequested so a fast intent landing before the
  // renderer mounts the chip doesn't get dropped.
  onIntentExternalContextArrived: (() => {
    type Payload = {
      sessionId: string;
      appId: string;
      intent: 'summarise' | 'ask' | 'save_to_notes' | 'chat';
      initialText: string;
      externalContext: unknown;
      tabContext?: { tabId?: number; windowId?: number; url?: string; title?: string };
      documentContext?: { host?: string; url?: string; title?: string };
      focus: boolean;
      receivedAt: number;
    };
    const MAX_BUFFERED_EVENTS = 50;
    const bufferedEvents: Payload[] = [];
    let subscriber: ((data: Payload) => void) | null = null;
    const validate = (data: unknown): Payload | null => {
      if (!data || typeof data !== 'object') return null;
      const d = data as Record<string, unknown>;
      if (typeof d.sessionId !== 'string' || d.sessionId.length === 0) return null;
      if (typeof d.appId !== 'string' || d.appId.length === 0) return null;
      if (d.intent !== 'summarise' && d.intent !== 'ask' && d.intent !== 'save_to_notes' && d.intent !== 'chat') return null;
      if (typeof d.initialText !== 'string' || d.initialText.length === 0) return null;
      if (d.externalContext === undefined) return null;
      const tabContext = validateIntentTabContext(d.tabContext);
      const documentContext = validateIntentDocumentContext(d.documentContext);
      if (tabContext === null || documentContext === null) return null;
      return {
        sessionId: d.sessionId,
        appId: d.appId,
        intent: d.intent,
        initialText: d.initialText,
        externalContext: d.externalContext,
        ...(tabContext ? { tabContext } : {}),
        ...(documentContext ? { documentContext } : {}),
        focus: typeof d.focus === 'boolean' ? d.focus : true,
        receivedAt: typeof d.receivedAt === 'number' ? d.receivedAt : Date.now(),
      };
    };
    ipcRenderer.on('intent:external-context-arrived', (_: Electron.IpcRendererEvent, data: unknown) => {
      const v = validate(data);
      if (!v) return;
      if (subscriber) {
        subscriber(v);
      } else {
        if (bufferedEvents.length >= MAX_BUFFERED_EVENTS) {
          console.warn('[preload] intent:external-context-arrived buffer full, dropping oldest');
          bufferedEvents.shift();
        }
        bufferedEvents.push(v);
      }
    });
    return (callback: (data: Payload) => void) => {
      subscriber = callback;
      for (const evt of bufferedEvents) callback(evt);
      bufferedEvents.length = 0;
      return () => {
        subscriber = null;
      };
    };
  })(),
  onIntentBufferedMessage: (() => {
    type Payload = {
      sessionId: string;
      appId: string;
      messageId: string;
      text: string;
      externalContext?: unknown;
      tabContext?: { tabId?: number; windowId?: number; url?: string; title?: string };
      documentContext?: { host?: string; url?: string; title?: string };
      receivedAt: number;
      queueSize: number;
    };
    const MAX_BUFFERED_EVENTS = 50;
    const bufferedEvents: Payload[] = [];
    let subscriber: ((data: Payload) => void) | null = null;
    const validate = (data: unknown): Payload | null => {
      if (!data || typeof data !== 'object') return null;
      const d = data as Record<string, unknown>;
      if (typeof d.sessionId !== 'string' || d.sessionId.length === 0) return null;
      if (typeof d.appId !== 'string' || d.appId.length === 0) return null;
      if (typeof d.messageId !== 'string' || d.messageId.length === 0) return null;
      if (typeof d.text !== 'string' || d.text.length === 0) return null;
      if (typeof d.queueSize !== 'number' || d.queueSize <= 0) return null;
      const tabContext = validateIntentTabContext(d.tabContext);
      const documentContext = validateIntentDocumentContext(d.documentContext);
      if (tabContext === null || documentContext === null) return null;
      return {
        sessionId: d.sessionId,
        appId: d.appId,
        messageId: d.messageId,
        text: d.text,
        ...(d.externalContext !== undefined ? { externalContext: d.externalContext } : {}),
        ...(tabContext ? { tabContext } : {}),
        ...(documentContext ? { documentContext } : {}),
        receivedAt: typeof d.receivedAt === 'number' ? d.receivedAt : Date.now(),
        queueSize: d.queueSize,
      };
    };
    ipcRenderer.on('intent:buffered-message', (_: Electron.IpcRendererEvent, data: unknown) => {
      const v = validate(data);
      if (!v) return;
      if (subscriber) {
        subscriber(v);
      } else {
        if (bufferedEvents.length >= MAX_BUFFERED_EVENTS) {
          console.warn('[preload] intent:buffered-message buffer full, dropping oldest');
          bufferedEvents.shift();
        }
        bufferedEvents.push(v);
      }
    });
    return (callback: (data: Payload) => void) => {
      subscriber = callback;
      for (const evt of bufferedEvents) callback(evt);
      bufferedEvents.length = 0;
      return () => {
        subscriber = null;
      };
    };
  })(),
  onIntentBufferDrained: (() => {
    type Payload = {
      sessionId: string;
      flushedIds: string[];
      remaining: number;
      drainedAt: number;
    };
    const MAX_BUFFERED_EVENTS = 50;
    const bufferedEvents: Payload[] = [];
    let subscriber: ((data: Payload) => void) | null = null;
    const validate = (data: unknown): Payload | null => {
      if (!data || typeof data !== 'object') return null;
      const d = data as Record<string, unknown>;
      if (typeof d.sessionId !== 'string' || d.sessionId.length === 0) return null;
      if (!Array.isArray(d.flushedIds)) return null;
      if (typeof d.remaining !== 'number' || d.remaining < 0) return null;
      return {
        sessionId: d.sessionId,
        flushedIds: d.flushedIds.filter((x): x is string => typeof x === 'string'),
        remaining: d.remaining,
        drainedAt: typeof d.drainedAt === 'number' ? d.drainedAt : Date.now(),
      };
    };
    ipcRenderer.on('intent:buffer-drained', (_: Electron.IpcRendererEvent, data: unknown) => {
      const v = validate(data);
      if (!v) return;
      if (subscriber) {
        subscriber(v);
      } else {
        if (bufferedEvents.length >= MAX_BUFFERED_EVENTS) {
          console.warn('[preload] intent:buffer-drained buffer full, dropping oldest');
          bufferedEvents.shift();
        }
        bufferedEvents.push(v);
      }
    });
    return (callback: (data: Payload) => void) => {
      subscriber = callback;
      for (const evt of bufferedEvents) callback(evt);
      bufferedEvents.length = 0;
      return () => {
        subscriber = null;
      };
    };
  })(),
  onMeetingNotificationClicked: (() => {
    let bufferedEvent: { meetingUrl: string; meetingTitle: string } | null = null;
    let subscriber: ((data: { meetingUrl: string; meetingTitle: string }) => void) | null = null;

    ipcRenderer.on('meeting-notification:clicked', (_: Electron.IpcRendererEvent, data: { meetingUrl: string; meetingTitle: string }) => {
      if (subscriber) {
        subscriber(data);
      } else {
        bufferedEvent = data;
      }
    });

    return (callback: (data: { meetingUrl: string; meetingTitle: string }) => void) => {
      subscriber = callback;
      if (bufferedEvent) {
        callback(bufferedEvent);
        bufferedEvent = null;
      }
      return () => {
        subscriber = null;
      };
    };
  })(),
  updateInstallNow: () =>
    ipcRenderer.invoke('update:install-now') as Promise<{ success: boolean; error?: string }>,
  updateAcknowledgeToast: () =>
    ipcRenderer.invoke('update:acknowledge-toast') as Promise<{ acknowledged: boolean }>,
  // Super-MCP notifications (sanitized payload - no raw error messages)
  onSuperMcpStartupFailed: (callback: (data: { 
    failureCategory: SafeModeErrorCategory;
    attempts: number;
  }) => void) => {
    const listener = (_: Electron.IpcRendererEvent, data: { failureCategory: string; attempts: number }) =>
      callback(data as Parameters<typeof callback>[0]);
    ipcRenderer.on('super-mcp:startup-failed', listener);
    return () => void ipcRenderer.removeListener('super-mcp:startup-failed', listener);
  },
  onSuperMcpStartupSucceeded: (callback: (data: { port: number; attempts: number; skippedServers?: Array<{ id: string; reason: string }> }) => void) => {
    const listener = (_: Electron.IpcRendererEvent, data: { port: number; attempts: number; skippedServers?: Array<{ id: string; reason: string }> }) => callback(data);
    ipcRenderer.on('super-mcp:startup-succeeded', listener);
    return () => void ipcRenderer.removeListener('super-mcp:startup-succeeded', listener);
  },
  onSuperMcpReady: (
    callback: (
      data:
        | { success: true; port: number; recovered?: true }
        | { success: false; errorCategory?: SafeModeErrorCategory }
    ) => void,
  ) => {
    const listener = (_: Electron.IpcRendererEvent, data: unknown) => {
      if (typeof data !== 'object' || data === null || typeof (data as { success?: unknown }).success !== 'boolean') {
        return;
      }
      const payload = data as { success: boolean; port?: unknown; recovered?: unknown; errorCategory?: unknown };
      if (payload.success) {
        if (typeof payload.port !== 'number') {
          return;
        }
        const readyPayload: { success: true; port: number; recovered?: true } = {
          success: true,
          port: payload.port,
        };
        if (payload.recovered === true) {
          readyPayload.recovered = true;
        }
        callback(readyPayload);
        return;
      }
      const unavailablePayload: { success: false; errorCategory?: SafeModeErrorCategory } = {
        success: false,
      };
      if (typeof payload.errorCategory === 'string') {
        unavailablePayload.errorCategory = payload.errorCategory as SafeModeErrorCategory;
      }
      callback(unavailablePayload);
    };
    ipcRenderer.on('super-mcp:ready', listener);
    return () => void ipcRenderer.removeListener('super-mcp:ready', listener);
  },
  onSuperMcpRestartDeferred: (callback: (data: { context: string; activeTurns: number; deferredAt: number }) => void) => {
    const listener = (_: Electron.IpcRendererEvent, data: unknown) => {
      if (
        typeof data !== 'object' ||
        data === null ||
        typeof (data as { context?: unknown }).context !== 'string' ||
        typeof (data as { activeTurns?: unknown }).activeTurns !== 'number' ||
        typeof (data as { deferredAt?: unknown }).deferredAt !== 'number'
      ) {
        return;
      }
      callback({
        context: (data as { context: string }).context,
        activeTurns: (data as { activeTurns: number }).activeTurns,
        deferredAt: (data as { deferredAt: number }).deferredAt,
      });
    };
    ipcRenderer.on('super-mcp:restart-deferred', listener);
    return () => void ipcRenderer.removeListener('super-mcp:restart-deferred', listener);
  },
  onCatalogOverrideWarning: (() => {
    type Payload = { message: string };
    let bufferedEvent: Payload | null = null;
    let subscriber: ((data: Payload) => void) | null = null;
    ipcRenderer.on('catalog:override-warning', (_: Electron.IpcRendererEvent, data: unknown) => {
      const payload = typeof data === 'object' && data !== null && typeof (data as { message?: unknown }).message === 'string'
        ? { message: (data as { message: string }).message }
        : { message: 'Catalog override rejected: invalid payload' };
      if (subscriber) {
        subscriber(payload);
      } else {
        bufferedEvent = payload;
      }
    });
    return (callback: (data: Payload) => void) => {
      subscriber = callback;
      if (bufferedEvent) {
        callback(bufferedEvent);
        bufferedEvent = null;
      }
      return () => {
        subscriber = null;
      };
    };
  })(),
  // Spaces migration notification (legacy AGENTS.md → README.md)
  onSpacesMigrationComplete: (callback: (data: { 
    migrated: number; 
    backedUp: number; 
    failed: number;
    migratedPaths: string[];
    backedUpPaths: string[];
    failedPaths: Array<{ path: string; error: string }>;
  }) => void) => {
    const listener = (_: Electron.IpcRendererEvent, data: Parameters<typeof callback>[0]) => callback(data);
    ipcRenderer.on('spaces:migration-complete', listener);
    return () => void ipcRenderer.removeListener('spaces:migration-complete', listener);
  },

  // Shared drive health warnings (drive app not running or files online-only)
  onSharedDriveHealthWarning: (callback: (results: Array<{
    provider: string;
    appStatus: 'running' | 'not_running' | 'unknown';
    offlineStatus: 'available' | 'online-only' | 'unknown';
    spacePaths: string[];
  }>) => void) => {
    const listener = (_: Electron.IpcRendererEvent, results: Parameters<typeof callback>[0]) => callback(results);
    ipcRenderer.on('shared-drive:health-warning', listener);
    return () => void ipcRenderer.removeListener('shared-drive:health-warning', listener);
  },

  // REBEL-62A one-off conflict-copy cleanup (Stage 3). Main detects backlog
  // duplicates on startup and, for affected users only, broadcasts a summary
  // for the available-cleanup toast. Returns an unsubscribe.
  onConflictCleanupAvailable: (callback: (info: {
    runId: string;
    spaceRootAbsPath: string;
    spaceName: string;
    quarantineCount: number;
    needsReviewCount: number;
    sample: string[];
  }) => void) => {
    const listener = (_: Electron.IpcRendererEvent, info: Parameters<typeof callback>[0]) => callback(info);
    ipcRenderer.on('conflict-cleanup:available', listener);
    return () => void ipcRenderer.removeListener('conflict-cleanup:available', listener);
  },

  onDriveAwareSyncDeferred: (callback: (payload: {
    workspaceFingerprint: string;
    timestamp: number;
    relPath?: string;
    cycle?: number;
    ageMs?: number;
  }) => void) => {
    const listener = (_: Electron.IpcRendererEvent, payload: Parameters<typeof callback>[0]) => callback(payload);
    ipcRenderer.on('cloud:drive-aware-sync-deferred', listener);
    return () => void ipcRenderer.removeListener('cloud:drive-aware-sync-deferred', listener);
  },

  // Inbound trigger session created (e.g., Slack @-mention detected)
  onInboundTriggerSessionCreated: (callback: (session: AgentSession) => void) => {
    const listener = (_: Electron.IpcRendererEvent, session: AgentSession) => callback(session);
    ipcRenderer.on('inbound-triggers:session-created', listener);
    return () => void ipcRenderer.removeListener('inbound-triggers:session-created', listener);
  },
  // Safe mode state change notifications (with full context)
  onSafeModeStateChange: (callback: (data: {
    isEnabled: boolean;
    reason?: 'cli' | 'timeout' | 'failure' | 'user';
    triggeredAt?: string;
    sentryEventId?: string;
    errorCategory?: SafeModeErrorCategory;
  }) => void) => {
    const listener = (_: Electron.IpcRendererEvent, data: Parameters<typeof callback>[0]) => callback(data);
    ipcRenderer.on('safe-mode:state', listener);
    return () => void ipcRenderer.removeListener('safe-mode:state', listener);
  },
  // Auth state change notifications
  onAuthStateChange: (callback: (data: { isAuthenticated: boolean; user: { id: string; name: string; email: string; image: string | null } | null; isLoading: boolean }) => void) => {
    const listener = (_: Electron.IpcRendererEvent, data: { isAuthenticated: boolean; user: { id: string; name: string; email: string; image: string | null } | null; isLoading: boolean }) => callback(data);
    ipcRenderer.on('auth:state-changed', listener);
    return () => void ipcRenderer.removeListener('auth:state-changed', listener);
  },
  // Auth login error notifications (timeout, callback errors)
  onAuthLoginError: (callback: (data: { message: string }) => void) => {
    const listener = (_: Electron.IpcRendererEvent, data: { message: string }) => callback(data);
    ipcRenderer.on('auth:login-error', listener);
    return () => void ipcRenderer.removeListener('auth:login-error', listener);
  },
  // Auth config received (after login, main process applies server config)
  onAuthConfigReceived: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('auth:config-received', listener);
    return () => void ipcRenderer.removeListener('auth:config-received', listener);
  },
  // Subscription deep-link callback (Stripe checkout return).
  // Validate the payload against the shared schema so a producer/consumer drift
  // on `expectedTier` can't silently mis-shape the callback. On a schema miss we
  // fall through to the existing behaviour, preserving the `status` string when
  // present (so a future payload variant never silently drops the callback —
  // the renderer treats a missing expectedTier as a plain refresh).
  onSubscriptionCallback: (
    callback: (data: SubscriptionCallbackPayload) => void,
  ) => {
    const listener = (_: Electron.IpcRendererEvent, data: unknown) => {
      const payload = coerceSubscriptionCallbackPayload(data);
      if (payload) callback(payload);
    };
    ipcRenderer.on('subscription:callback', listener);
    return () => void ipcRenderer.removeListener('subscription:callback', listener);
  },
  // Dashboard notifications
  onUseCasesReady: (callback: (data: { count: number; userFirstName?: string }) => void) => {
    const listener = (_: Electron.IpcRendererEvent, data: { count: number; userFirstName?: string }) => callback(data);
    ipcRenderer.on('dashboard:use-cases-ready', listener);
    return () => void ipcRenderer.removeListener('dashboard:use-cases-ready', listener);
  },
  // Menu commands (from native application menu)
  onMenuOpenSettings: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('menu:open-settings', listener);
    return () => void ipcRenderer.removeListener('menu:open-settings', listener);
  },
  onMenuCheckForUpdates: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('menu:check-for-updates', listener);
    return () => void ipcRenderer.removeListener('menu:check-for-updates', listener);
  },
  onMenuAskRebelHelp: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('menu:ask-rebel-help', listener);
    return () => void ipcRenderer.removeListener('menu:ask-rebel-help', listener);
  },
  onMenuShowShortcuts: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('menu:show-shortcuts', listener);
    return () => void ipcRenderer.removeListener('menu:show-shortcuts', listener);
  },
  onMenuDownloadDiagnostics: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('menu:download-diagnostics', listener);
    return () => void ipcRenderer.removeListener('menu:download-diagnostics', listener);
  },
  onMenuWatchTutorials: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('menu:watch-tutorials', listener);
    return () => void ipcRenderer.removeListener('menu:watch-tutorials', listener);
  },
  onMenuReportBug: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('menu:report-bug', listener);
    return () => void ipcRenderer.removeListener('menu:report-bug', listener);
  },
  onMenuStartDemoMode: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('menu:start-demo-mode', listener);
    return () => void ipcRenderer.removeListener('menu:start-demo-mode', listener);
  },
  // Find menu commands (Edit > Find / Find Next / Find Previous)
  onMenuFind: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('menu:find', listener);
    return () => void ipcRenderer.removeListener('menu:find', listener);
  },
  onMenuFindNext: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('menu:find-next', listener);
    return () => void ipcRenderer.removeListener('menu:find-next', listener);
  },
  onMenuFindPrevious: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('menu:find-previous', listener);
    return () => void ipcRenderer.removeListener('menu:find-previous', listener);
  },
  // Find-in-page IPC (renderer ↔ main for native Chromium text search)
  findInPage: (text: string, options: { forward: boolean; findNext: boolean }) => {
    ipcRenderer.send('find-in-page:search', { text, ...options });
  },
  stopFindInPage: () => {
    ipcRenderer.send('find-in-page:stop');
  },
  onFindInPageResult: (callback: (data: { activeMatchOrdinal: number; matches: number }) => void) => {
    const listener = (_: Electron.IpcRendererEvent, data: { activeMatchOrdinal: number; matches: number }) => callback(data);
    ipcRenderer.on('find-in-page:result', listener);
    return () => void ipcRenderer.removeListener('find-in-page:result', listener);
  },
  // Error recovery state change notifications
  onErrorRecoveryState: (callback: (data: {
    evaluationId: string | null;
    status: 'idle' | 'evaluating' | 'can_help' | 'cannot_help' | 'evaluation_failed';
    errorCategory: SafeModeErrorCategory | null;
    evaluation: {
      status: 'idle' | 'evaluating' | 'can_help' | 'cannot_help' | 'evaluation_failed';
      canHelp: boolean;
      confidence: 'high' | 'medium' | 'low';
      summary: string;
      suggestedAction?: string;
      contextForConversation: {
        filesExamined: string[];
        relevantExcerpts: Record<string, string>;
        healthCheckSummary?: string;
        diagnosticInfo?: string;
      };
      evaluationDurationMs?: number;
      error?: string;
    } | null;
    startedAt: number | null;
    quipIndex: number;
  }) => void) => {
    const listener = (_: Electron.IpcRendererEvent, data: Parameters<typeof callback>[0]) => callback(data);
    ipcRenderer.on('error-recovery:state', listener);
    return () => void ipcRenderer.removeListener('error-recovery:state', listener);
  },

  // Local STT model download progress (includes modelId for multi-model support)
  onLocalSttModelProgress: (callback: (data: {
    modelId?: string;
    progress: number;
    downloadedBytes: number;
    totalBytes: number;
    status: 'downloading' | 'extracting' | 'complete' | 'error' | 'cancelled';
    error?: string;
  }) => void) => {
    const listener = (_: Electron.IpcRendererEvent, data: Parameters<typeof callback>[0]) => callback(data);
    ipcRenderer.on('local-stt:model-download-progress', listener);
    return () => void ipcRenderer.removeListener('local-stt:model-download-progress', listener);
  },

  // Local inference download progress (runtime + model)
  onLocalInferenceProgress: (callback: (data: {
    type: 'runtime' | 'model';
    progress: number;
    status: string;
    error?: string;
  }) => void) => {
    const listener = (_: Electron.IpcRendererEvent, data: Parameters<typeof callback>[0]) => callback(data);
    ipcRenderer.on('local-inference:download-progress', listener);
    return () => void ipcRenderer.removeListener('local-inference:download-progress', listener);
  },

  // Local inference status changes
  onLocalInferenceStatusChanged: (callback: (data: {
    status: string;
    strategy: string | null;
  }) => void) => {
    const listener = (_: Electron.IpcRendererEvent, data: Parameters<typeof callback>[0]) => callback(data);
    ipcRenderer.on('local-inference:status-changed', listener);
    return () => void ipcRenderer.removeListener('local-inference:status-changed', listener);
  },

  // Achievements / Gamification (Phase 1)
  getStreakData: () =>
    ipcRenderer.invoke('achievements:get-streak') as Promise<{
      current: number;
      longest: number;
      lastActiveDate: string;
      freezesUsedThisWeek: number;
      weekStartDate: string;
    }>,
  getBadges: () =>
    ipcRenderer.invoke('achievements:get-badges') as Promise<Record<string, { unlockedAt: number; notified: boolean }>>,
  getCurrentTier: () =>
    ipcRenderer.invoke('achievements:get-tier') as Promise<{ tier: string; unlockedAt: number }>,
  getTierEvidence: () =>
    ipcRenderer.invoke('achievements:get-tier-evidence') as Promise<{
      tier: string;
      unlockedAt: number;
      evidence: Array<{
        signal: string;
        timestamp: number;
        sessionId?: string;
        metadata?: Record<string, unknown>;
      }>;
    }>,
  getNextUnnotifiedBadge: () =>
    ipcRenderer.invoke('achievements:get-next-badge') as Promise<string | null>,
  markBadgeNotified: (badgeId: string) =>
    ipcRenderer.invoke('achievements:mark-badge-notified', badgeId) as Promise<{ success: boolean }>,
  getEvidenceCounts: () =>
    ipcRenderer.invoke('achievements:get-evidence-counts') as Promise<Record<string, number>>,
  onStreakMilestone: (callback: (milestone: number) => void) => {
    const listener = (_: Electron.IpcRendererEvent, milestone: number) => callback(milestone);
    ipcRenderer.on('achievements:streak-milestone', listener);
    return () => void ipcRenderer.removeListener('achievements:streak-milestone', listener);
  },
  onStreakUpdated: (callback: (data: { current: number; longest: number; lastActiveDate: string }) => void) => {
    const listener = (_: Electron.IpcRendererEvent, data: { current: number; longest: number; lastActiveDate: string }) => callback(data);
    ipcRenderer.on('achievements:streak-updated', listener);
    return () => void ipcRenderer.removeListener('achievements:streak-updated', listener);
  },
  
  // Onboarding journey
  getOnboardingJourney: () =>
    ipcRenderer.invoke('achievements:get-journey') as Promise<{ completedDays: number[]; journeyStartedAt?: number }>,
  startOnboardingJourney: () =>
    ipcRenderer.invoke('achievements:start-journey') as Promise<{ success: boolean }>,
  resetOnboardingJourney: () =>
    ipcRenderer.invoke('achievements:reset-journey') as Promise<{ success: boolean }>,
  completeJourneyDay: (day: number) =>
    ipcRenderer.invoke('achievements:complete-journey-day', day) as Promise<{ success: boolean; day: number }>,
  getCounters: () =>
    ipcRenderer.invoke('achievements:get-counters') as Promise<{
      totalSessions: number;
      voiceSessions: number;
      weekendSessions: number;
      totalTimeSavedMinutes: number;
    }>,
  
  // Badge unlock listener
  onBadgeUnlocked: (callback: (badgeId: string) => void) => {
    const listener = (_: Electron.IpcRendererEvent, badgeId: string) => callback(badgeId);
    ipcRenderer.on('achievements:badge-unlocked', listener);
    return () => void ipcRenderer.removeListener('achievements:badge-unlocked', listener);
  },

  // Tier unlock listener
  onTierUnlocked: (callback: (tier: string) => void) => {
    const listener = (_: Electron.IpcRendererEvent, tier: string) => callback(tier);
    ipcRenderer.on('achievements:tier-unlocked', listener);
    return () => void ipcRenderer.removeListener('achievements:tier-unlocked', listener);
  },
  
  // Journey day completion listener
  onJourneyDayCompleted: (callback: (day: number) => void) => {
    const listener = (_: Electron.IpcRendererEvent, day: number) => callback(day);
    ipcRenderer.on('achievements:journey-day-completed', listener);
    return () => void ipcRenderer.removeListener('achievements:journey-day-completed', listener);
  },

  // System resource warnings (ENFILE exhaustion, etc.)
  onSystemResourceWarning: (callback: (data: { type: 'enfile'; message: string }) => void) => {
    const listener = (_: Electron.IpcRendererEvent, data: { type: 'enfile'; message: string }) => callback(data);
    ipcRenderer.on('system:resource-warning', listener);
    return () => void ipcRenderer.removeListener('system:resource-warning', listener);
  },

  // Graduation modal
  shouldShowGraduation: () =>
    ipcRenderer.invoke('achievements:should-show-graduation') as Promise<boolean>,
  markGraduationShown: () =>
    ipcRenderer.invoke('achievements:mark-graduation-shown') as Promise<void>,

  // Tier progress for next tier gap analysis
  getTierProgress: () =>
    ipcRenderer.invoke('achievements:get-tier-progress') as Promise<{
      currentTier: string;
      nextTier: string | null;
      requiredSignals: string[];
      earnedSignals: string[];
      signalsNeeded: number;
      minCount: number;
    } | null>,

  // Navigation deep link (rebel://space/... opened from OS)
  onNavigateDeepLink: (callback: (url: string) => void) => {
    const listener = (_: Electron.IpcRendererEvent, url: string) => callback(url);
    ipcRenderer.on('app:navigate-deep-link', listener);
    return () => void ipcRenderer.removeListener('app:navigate-deep-link', listener);
  },
};
const captureCompatStack = (): string[] | undefined => {
  const stack = new Error().stack;
  if (!stack) return undefined;
  return stack
    .split('\n')
    .slice(2, 8)
    .map((line) => line.trim());
};

const logLegacyApiUsage = (methodName: string): void => {
  const payload: RendererLogPayload = {
    level: 'debug',
    message: `[ipc-compat] window.api.${methodName}`,
    source: 'preload',
    timestamp: Date.now(),
    context: {
      surface: 'window.api',
      method: methodName,
      stack: captureCompatStack(),
    },
  };

  ipcRenderer.send('log:event', payload);
};

const withCompatLogging = <T extends Record<string, unknown>>(target: T): T => {
  const entries = Object.entries(target).map(([key, value]) => {
    if (typeof value !== 'function') {
      return [key, value];
    }

    const fn = value as (...args: unknown[]) => unknown;
    const wrapped = (...args: unknown[]) => {
      logLegacyApiUsage(key);
      return fn(...args);
    };

    return [key, wrapped];
  });

  return Object.fromEntries(entries) as T;
};

const legacyApi = withCompatLogging(api);

contextBridge.exposeInMainWorld('api', legacyApi);

// =============================================================================
// Domain-specific APIs
// =============================================================================
// These provide the same functionality as the flat api object but with better
// organization and type safety. New code should prefer these.
contextBridge.exposeInMainWorld('libraryApi', libraryApi);
contextBridge.exposeInMainWorld('workspaceApi', libraryApi); // Legacy alias for backwards compatibility
contextBridge.exposeInMainWorld('settingsApi', settingsApi);
contextBridge.exposeInMainWorld('appApi', appApi);
contextBridge.exposeInMainWorld('exportApi', exportApi);
contextBridge.exposeInMainWorld('migrationApi', migrationApi);
contextBridge.exposeInMainWorld('voiceApi', voiceApi);
contextBridge.exposeInMainWorld('agentApi', agentApi);
contextBridge.exposeInMainWorld('agentErrorApi', agentErrorApi);
contextBridge.exposeInMainWorld('errorApi', errorApi);
contextBridge.exposeInMainWorld('permissionsApi', permissionsApi);
contextBridge.exposeInMainWorld('sessionsApi', sessionsApi);
contextBridge.exposeInMainWorld('inboxApi', inboxApi);
contextBridge.exposeInMainWorld('tasksApi', inboxApi); // Legacy alias
contextBridge.exposeInMainWorld('automationsApi', automationsApi);
contextBridge.exposeInMainWorld('demoApi', demoApi);
contextBridge.exposeInMainWorld('dashboardApi', dashboardApi);
contextBridge.exposeInMainWorld('searchApi', searchApi);
contextBridge.exposeInMainWorld('systemHealthApi', systemHealthApi);
contextBridge.exposeInMainWorld('cloudApi', cloudApi);
contextBridge.exposeInMainWorld('cloudContinuityApi', cloudContinuityApi);
contextBridge.exposeInMainWorld('miscApi', miscApi);
contextBridge.exposeInMainWorld('authApi', authApi);
contextBridge.exposeInMainWorld('memoryApi', memoryApi);
contextBridge.exposeInMainWorld('scratchpadApi', scratchpadApi);
contextBridge.exposeInMainWorld('googleWorkspaceApi', googleWorkspaceApi);
contextBridge.exposeInMainWorld('githubApi', githubApi);
contextBridge.exposeInMainWorld('codexApi', codexApi);
contextBridge.exposeInMainWorld('subscriptionApi', subscriptionApi);
contextBridge.exposeInMainWorld('identityApi', identityApi);
contextBridge.exposeInMainWorld('openRouterApi', openRouterApi);
contextBridge.exposeInMainWorld('slackApi', slackApi);
contextBridge.exposeInMainWorld('hubspotApi', hubspotApi);
contextBridge.exposeInMainWorld('discourseApi', discourseApi);
contextBridge.exposeInMainWorld('microsoftApi', microsoftApi);
contextBridge.exposeInMainWorld('usageApi', usageApi);
contextBridge.exposeInMainWorld('safetyApi', safetyApi);
contextBridge.exposeInMainWorld('safetyPromptApi', safetyPromptApi);
// F-R3-9: Extracted to testable factory — see safetyPromptSubscriptionFactory.ts.
contextBridge.exposeInMainWorld(
  'safetyPromptSubscriptions',
  createSafetyPromptSubscriptions(ipcRenderer),
);
contextBridge.exposeInMainWorld('safetyActivityLogApi', safetyActivityLogApi);
contextBridge.exposeInMainWorld('safetyActivityLogSubscriptions', {
  onSafetyActivityLogUpdated: (callback: (data: { timestamp: number }) => void) => {
    const listener = (_: Electron.IpcRendererEvent, data: { timestamp: number }) => callback(data);
    ipcRenderer.on('safety-activity-log:updated', listener);
    return () => void ipcRenderer.removeListener('safety-activity-log:updated', listener);
  },
});
contextBridge.exposeInMainWorld('btsSubscriptions', {
  onStructuredOutputBypassed: (
    callback: (data: {
      profileId: string;
      profileName: string;
      fellBackTo: string;
      caller: string | null;
    }) => void,
  ) => {
    const listener = (
      _: Electron.IpcRendererEvent,
      data: {
        profileId: string;
        profileName: string;
        fellBackTo: string;
        caller: string | null;
      },
    ) => callback(data);
    ipcRenderer.on('bts:structured-output-bypassed', listener);
    return () => void ipcRenderer.removeListener('bts:structured-output-bypassed', listener);
  },
});
contextBridge.exposeInMainWorld('skillsApi', skillsApi);
contextBridge.exposeInMainWorld('skillHistoryApi', skillHistoryApi);
contextBridge.exposeInMainWorld('operatorsApi', operatorsApi);
contextBridge.exposeInMainWorld('feedbackApi', feedbackApi);
contextBridge.exposeInMainWorld('pluginsApi', pluginsApi);
contextBridge.exposeInMainWorld('bugReportApi', bugReportApi);
contextBridge.exposeInMainWorld('fileConversationApi', fileConversationApi);
contextBridge.exposeInMainWorld('userTasksApi', userTasksApi);
contextBridge.exposeInMainWorld('todoistApi', todoistApi);
contextBridge.exposeInMainWorld('useCaseLibraryApi', useCaseLibraryApi);
contextBridge.exposeInMainWorld('calendarApi', calendarApi);
contextBridge.exposeInMainWorld('errorRecoveryApi', errorRecoveryApi);
contextBridge.exposeInMainWorld('meetingBotApi', meetingBotApi);
contextBridge.exposeInMainWorld('timeSavedApi', timeSavedApi);
contextBridge.exposeInMainWorld('localSttApi', localSttApi);
contextBridge.exposeInMainWorld('localInferenceApi', localInferenceApi);
contextBridge.exposeInMainWorld('physicalRecordingApi', physicalRecordingApi);
contextBridge.exposeInMainWorld('quickCaptureApi', quickCaptureApi);
contextBridge.exposeInMainWorld('plaudApi', plaudApi);
contextBridge.exposeInMainWorld('mcpAppsApi', mcpAppsApi);
contextBridge.exposeInMainWorld('versionApi', versionApi);
contextBridge.exposeInMainWorld('inboundTriggersApi', inboundTriggersApi);
contextBridge.exposeInMainWorld('systemImprovementApi', systemImprovementApi);
contextBridge.exposeInMainWorld('heroChoiceApi', heroChoiceApi);
contextBridge.exposeInMainWorld('dailySparkApi', dailySparkApi);
contextBridge.exposeInMainWorld('communityEventsApi', communityEventsApi);
contextBridge.exposeInMainWorld('communityVideoRecsApi', communityVideoRecsApi);
contextBridge.exposeInMainWorld('focusApi', focusApi);
contextBridge.exposeInMainWorld('foldersApi', foldersApi);
contextBridge.exposeInMainWorld('contributionApi', contributionApi);
contextBridge.exposeInMainWorld('appBridgeApi', appBridgeApi);
contextBridge.exposeInMainWorld('diagnosticsApi', diagnosticsApi);
contextBridge.exposeInMainWorld('htmlPreviewTrustApi', htmlPreviewTrustApi);
contextBridge.exposeInMainWorld('achievementsApi', achievementsApi);
contextBridge.exposeInMainWorld('salesforceApi', salesforceApi);
contextBridge.exposeInMainWorld('spaceMaintenanceApi', spaceMaintenanceApi);
const officeSidecarApi = {
  getStatus: () => generatedOfficeSidecarApi.status(),
  retryStart: () => generatedOfficeSidecarApi.retryStart(),
};
contextBridge.exposeInMainWorld('officeSidecarApi', officeSidecarApi);

// App Bridge broadcast subscriptions (separate from invoke/sync channels).
// Main broadcasts on `app-bridge:pending-approval-updated` whenever the
// pending-TOFU map changes so the settings UI can refresh.
//
// `onConnectorStatusChanged` is extracted via `createConnectorStatusSubscriptions`
// so the channel + payload validation is unit-testable without an
// Electron runtime (see `260422_renderer_driven_connector_status` plan).
const appBridgeSubscriptions = {
  onPendingApprovalUpdated: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('app-bridge:pending-approval-updated', listener);
    return () => void ipcRenderer.removeListener('app-bridge:pending-approval-updated', listener);
  },
  onSlackWorkspaceChanged: (callback: (payload: ReturnType<typeof SlackWorkspaceChangedSchema.parse>) => void) => {
    const listener = (_: Electron.IpcRendererEvent, payload: unknown) => {
      const parsed = SlackWorkspaceChangedSchema.safeParse(payload);
      if (!parsed.success) {
        console.warn('slack:workspace-changed payload failed validation', { issues: parsed.error.issues });
        return;
      }
      callback(parsed.data);
    };
    ipcRenderer.on(SLACK_WORKSPACE_CHANGED_CHANNEL, listener);
    return () => void ipcRenderer.removeListener(SLACK_WORKSPACE_CHANGED_CHANNEL, listener);
  },
  ...createConnectorStatusSubscriptions(ipcRenderer),
};
contextBridge.exposeInMainWorld('appBridgeSubscriptions', appBridgeSubscriptions);

// =============================================================================
// User Engagement API (fire-and-forget)
// =============================================================================
// Simple API for renderer to report user activity for engagement tracking.
// Uses ipcRenderer.send() (no response) to minimize overhead.
const userEngagementApi = {
  pingActivity: () => ipcRenderer.send('user:activity-ping'),
};
contextBridge.exposeInMainWorld('userEngagementApi', userEngagementApi);

export type UserEngagementApi = typeof userEngagementApi;
export type AppBridgeSubscriptions = typeof appBridgeSubscriptions;
export type OfficeSidecarApi = typeof officeSidecarApi;
export type ApiBridge = typeof legacyApi;
export type PluginsApi = typeof pluginsApi;
export type BugReportApi = typeof bugReportApi;
export type ContributionApi = typeof contributionApi;
export type {
  LibraryApi,
  SettingsApi,
  AppApi,
  ExportApi,
  MigrationApi,
  VoiceApi,
  AgentApi,
  ErrorApi,
  PermissionsApi,
  SessionsApi,
  InboxApi,
  AutomationsApi,
  DemoApi,
  DashboardApi,
  SearchApi,
  SystemHealthApi,
  MiscApi,
  AuthApi,
  MemoryApi,
  ScratchpadApi,
  GoogleWorkspaceApi,
  HubspotApi,
  UsageApi,
  SafetyApi,
  SafetyPromptApi,
  SafetyActivityLogApi,
  SkillsApi,
  FeedbackApi,
  FileConversationApi,
  UserTasksApi,
  TodoistApi,
  CalendarApi,
  ErrorRecoveryApi,
  MeetingBotApi,
  TimeSavedApi,
  PhysicalRecordingApi,
  VersionApi,
  InboundTriggersApi,
  UseCaseLibraryApi,
  HeroChoiceApi,
  CommunityEventsApi,
  SkillHistoryApi,
  FoldersApi,
  DiagnosticsApi,
} from './ipcBridge';

const fileApi = {
  getFileSourcePath: (file: File): string => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },
};

contextBridge.exposeInMainWorld('fileApi', fileApi);
export type FileApi = typeof fileApi;

// Extract the ID passed from Main
const anonymousIdArg = process.argv.find((arg) => arg.startsWith('--anonymous-id='));
const anonymousId = anonymousIdArg ? anonymousIdArg.split('=')[1] : null;
const appVersionArg = process.argv.find((arg) => arg.startsWith('--app-version='));
const appVersion = appVersionArg ? appVersionArg.split('=')[1] : null;
const appNameArg = process.argv.find((arg) => arg.startsWith('--app-name='));
const appName = appNameArg ? appNameArg.split('=')[1] : null;
const buildChannelArg = process.argv.find((arg) => arg.startsWith('--build-channel='));
const buildChannel = buildChannelArg ? buildChannelArg.split('=')[1] as 'stable' | 'beta' | 'dev' : null;
const disableAnalyticsArg = process.argv.find((arg) => arg.startsWith('--disable-analytics='));
const analyticsDisabled = disableAnalyticsArg ? disableAnalyticsArg.split('=')[1] === 'true' : false;
// Runtime Sentry kill-switch from main (set when SENTRY_ENABLED is explicitly
// false-ish at runtime, e.g. CI packaged-app launches). Renderer Sentry
// enablement is otherwise build-inlined, so this is the only runtime bridge.
const sentryDisabled = process.argv.includes('--rebel-sentry-disabled');

let runtimeConfig: unknown = null;

try {
  runtimeConfig = ipcRenderer.sendSync('runtime-config:sync') ?? null;
} catch (error) {
  console.error('Failed to load runtime config', error);
  runtimeConfig = null;
}

// OSS no-phone-home bridge (B6.a): the user's LOCAL_ONLY settings.telemetry
// creds, populated by main ONLY in an OSS build (null in enterprise). The OSS
// renderer reads telemetry creds EXCLUSIVELY from here — never from
// runtimeConfig/env. Read synchronously here so it is available before the
// renderer inits telemetry (renderer/main.tsx, before React).
let telemetryConfig: unknown = null;
try {
  telemetryConfig = ipcRenderer.sendSync('telemetry-config:sync') ?? null;
} catch (error) {
  console.error('Failed to load telemetry config', error);
  telemetryConfig = null;
}

const reloadRuntimeConfig = async (): Promise<unknown> => {
  try {
    const latest = await ipcRenderer.invoke('runtime-config:get');
    runtimeConfig = latest ?? null;
    return runtimeConfig;
  } catch (error) {
    console.error('Failed to reload runtime config', error);
    return runtimeConfig;
  }
};

// Expose to renderer
const electronEnv = {
  anonymousId,
  appVersion,
  appName,
  buildChannel,
  analyticsDisabled,
  sentryDisabled,
  userEmail: null as string | null, // Email now pushed via IPC for privacy
  platform: process.platform,
  arch: process.arch,
  get runtimeConfig() {
    return runtimeConfig;
  },
  get telemetryConfig() {
    return telemetryConfig;
  },
  reloadRuntimeConfig,
  syncAnalyticsIdentity: (data: { userId: string; traits: Record<string, unknown> }) =>
    ipcRenderer.send('analytics:identify', data)
};

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electronEnv', electronEnv);
  } catch (error) {
    console.error(error);
  }
} else {
  // @ts-ignore
  window.electronEnv = electronEnv;
}

const relayUnhandledError = (message: string, detail: Partial<RendererLogPayload>) => {
  const payload: RendererLogPayload = {
    level: 'error',
    message,
    source: 'preload',
    timestamp: Date.now(),
    ...detail
  };

  ipcRenderer.send('log:event', payload);
};

window.addEventListener('error', (event) => {
  const error = event.error instanceof Error ? event.error : undefined;
  relayUnhandledError('Unhandled renderer error', {
    error: error
      ? {
          name: error.name,
          message: error.message,
          stack: error.stack
        }
      : { message: event.message },
    context: {
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno
    }
  });
});

window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason;
  if (reason instanceof Error) {
    relayUnhandledError('Unhandled promise rejection', {
      error: {
        name: reason.name,
        message: reason.message,
        stack: reason.stack
      }
    });
  } else {
    relayUnhandledError('Unhandled promise rejection', {
      context: {
        reason
      },
      error: {
        message: typeof reason === 'string' ? reason : JSON.stringify(reason)
      }
    });
  }
});
