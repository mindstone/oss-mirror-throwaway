/**
 * Misc Domain IPC Handlers
 *
 * Handles analytics, Sentry, conversation title generation, Klavis status,
 * onboarding, user profile, runtime config, and update manifest fetching.
 *
 * NOTE: The 'check-for-updates' handler is registered by the auto-updater
 * setup in index.ts, not here.
 */

import type { HandlerInvokeEvent } from '@core/handlerRegistry';
import { getPlatformConfig } from '@core/platform';
import axios from 'axios';
import path from 'node:path';
import fs from 'node:fs/promises';
import { logger } from '@core/logger';
import { registerHandler } from './utils/registerHandler';
import { truncateChangelogToBudget } from './utils/truncateChangelog';
import { getAnalyticsStatus } from '../analytics';
import {
  getTimeSavedAggregates,
  calculateWeeklyTrend,
  getTimeSavedBySession,
  hasSeenFirstEstimate,
  markFirstEstimateSeen,
  getNextUnacknowledgedMilestone,
  acknowledgeMilestone,
  getTrackingSince,
  getTodayMinutes,
  getCurrentWeekDailyTotals,
  shouldShowFirstBigWin,
  shouldShowFirstWeek,
  markFirstBigWinShown,
  markFirstWeekShown,
  shouldShowFirstHighImpact,
  markFirstHighImpactShown,
  getWeekTopSessions,
  getDayTopSessions
} from '../services/timeSavedStore';
import {
  getStreakData,
  getBadges,
  getCurrentTier,
  getTierEvidence,
  markBadgeNotified,
  getNextUnnotifiedBadge,
  getEvidenceCounts,
  getOnboardingJourney,
  markJourneyDayComplete,
  startOnboardingJourney,
  resetOnboardingJourney,
  getCounters,
  shouldShowGraduation,
  markGraduationShown
} from '../services/achievementsStore';
import { getTierProgress } from '../services/achievementsEvaluator';
import { captureMainException, captureMainMessage } from '../sentry';
import { generateConversationTitle } from '../services/conversationTitleService';

import { getToolAuthUrl, verifyToolAuth, type AuthToolType } from '../services/toolAuthService';
import { authenticateMcpServer, checkMcpServerHealth, invokeStdioAuthenticateTool } from '../services/mcpService';
import { generateDynamicQuips, type QuipGenerationRequest } from '../services/quipGeneratorService';
import { sessionCoachingScheduler } from '../services/sessionCoachingScheduler';
import { checkPythonRuntime } from '../services/pythonRuntimeService';
import { captureActiveDisplay } from '../services/screenshotService';
import type { AppSettings, ConversationTitleRequestPayload } from '@shared/types';
import type { RendererAnalyticsHealth } from '@shared/ipc/schemas/misc';
import { UpdateManifestSchema } from '@shared/ipc/contracts';
import { getBuildChannel } from '@main/utils/buildChannel';

// =============================================================================
// Renderer Analytics Health Cache
// =============================================================================

/** Cached renderer analytics health state, pushed from renderer via IPC. */
let cachedRendererHealth: RendererAnalyticsHealth | null = null;

/**
 * Get the most recently reported renderer analytics health state.
 * Returns null if the renderer has not yet pushed its health.
 */
export function getCachedRendererHealth(): RendererAnalyticsHealth | null {
  return cachedRendererHealth;
}

function getUpdateManifestUrl(): string {
  // Use centralized channel detection utility (uses executable path basename internally)
  const isBetaApp = getBuildChannel() === 'beta';
  const releasesPath = isBetaApp ? 'releases-beta' : 'releases';
  return `https://storage.googleapis.com/mindstone-rebel/${releasesPath}/latest.json`;
}

export interface MiscHandlerDeps {
  getSettings: () => AppSettings;
  ensureNormalizedSettings: () => void;
  loadRuntimeConfig: () => {
    appVersion: string;
    platform: string;
    isPackaged: boolean;
    userData: string;
    logsPath: string;
  };
}

export function registerMiscHandlers(deps: MiscHandlerDeps): void {
  const { getSettings, ensureNormalizedSettings, loadRuntimeConfig } = deps;

  // NOTE: 'check-for-updates' is registered by the auto-updater setup in index.ts

  registerHandler('analytics:status', (_event: HandlerInvokeEvent) => {
    return getAnalyticsStatus();
  });

  registerHandler('analytics:renderer-health', (_event: HandlerInvokeEvent, payload: RendererAnalyticsHealth) => {
    cachedRendererHealth = payload;
    return { received: true };
  });

  registerHandler('time-saved:aggregates', (_event: HandlerInvokeEvent) => {
    return {
      aggregates: getTimeSavedAggregates(),
      trend: calculateWeeklyTrend(),
      trackingSince: getTrackingSince()
    };
  });

  registerHandler('time-saved:by-session', (_event: HandlerInvokeEvent) => {
    return getTimeSavedBySession();
  });

  registerHandler('time-saved:has-seen-first', (_event: HandlerInvokeEvent) => {
    return hasSeenFirstEstimate();
  });

  registerHandler('time-saved:mark-first-seen', (_event: HandlerInvokeEvent) => {
    markFirstEstimateSeen();
  });

  registerHandler('time-saved:next-milestone', (_event: HandlerInvokeEvent) => {
    return getNextUnacknowledgedMilestone();
  });

  registerHandler('time-saved:acknowledge-milestone', (_event: HandlerInvokeEvent, minutes: number) => {
    acknowledgeMilestone(minutes);
  });

  registerHandler('time-saved:today-minutes', (_event: HandlerInvokeEvent) => {
    return getTodayMinutes();
  });

  registerHandler('time-saved:week-daily-totals', (_event: HandlerInvokeEvent) => {
    return getCurrentWeekDailyTotals();
  });

  registerHandler('time-saved:should-show-first-big-win', (_event: HandlerInvokeEvent) => {
    return shouldShowFirstBigWin();
  });

  registerHandler('time-saved:should-show-first-week', (_event: HandlerInvokeEvent) => {
    return shouldShowFirstWeek();
  });

  registerHandler('time-saved:mark-first-big-win-shown', (_event: HandlerInvokeEvent) => {
    markFirstBigWinShown();
  });

  registerHandler('time-saved:mark-first-week-shown', (_event: HandlerInvokeEvent) => {
    markFirstWeekShown();
  });

  registerHandler('time-saved:should-show-first-high-impact', (_event: HandlerInvokeEvent) => {
    return shouldShowFirstHighImpact();
  });

  registerHandler('time-saved:mark-first-high-impact-shown', (_event: HandlerInvokeEvent) => {
    markFirstHighImpactShown();
  });

  registerHandler('time-saved:week-top-sessions', (_event: HandlerInvokeEvent) => {
    return getWeekTopSessions();
  });

  registerHandler('time-saved:day-top-sessions', (_event: HandlerInvokeEvent, date: string) => {
    return getDayTopSessions(date);
  });

  registerHandler('runtime-config:get', async (_event: HandlerInvokeEvent) => {
    return loadRuntimeConfig();
  });

  registerHandler(
    'sentry:capture-exception',
    (
      _event: HandlerInvokeEvent,
      payload: { message?: string; name?: string; stack?: string; context?: Record<string, unknown> } | null
    ) => {
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

  registerHandler(
    'sentry:capture-message',
    (
      _event: HandlerInvokeEvent,
      // 'info' deliberately absent from the level union — raw info-level captures
      // are forbidden (Stage 5 of docs/plans/260610_improve-sentry-noise/PLAN.md);
      // the wire contract (src/shared/ipc/channels/misc.ts) is narrowed in lockstep.
      payload: { message?: string; level?: 'warning' | 'error' | 'fatal'; context?: Record<string, unknown> } | null
    ) => {
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

  registerHandler(
    'conversation:generate-title',
    async (_event: HandlerInvokeEvent, payload: ConversationTitleRequestPayload) => {
      if (!payload || typeof payload.sessionId !== 'string') {
        throw new Error('Session ID is required for conversation renaming.');
      }
      if (!Array.isArray(payload.transcript) || payload.transcript.length === 0) {
        throw new Error('Transcript is required for conversation renaming.');
      }

      ensureNormalizedSettings();
      const settings = getSettings();
      // generateConversationTitle returns null gracefully on errors/missing API key
      const title = await generateConversationTitle(settings, payload.transcript);
      return { title };
    }
  );

  registerHandler('onboarding:get-tool-auth-url', async (_event: HandlerInvokeEvent, request: { tool: AuthToolType; serverName?: string; companyName?: string }) => {
    try {
      ensureNormalizedSettings();
      const settings = getSettings();
      const { tool, serverName, companyName } = request;
      logger.info({ tool, serverName, companyName }, 'onboarding:get-tool-auth-url invoked (deprecated - Klavis removed)');
      return await getToolAuthUrl(settings, tool, serverName, companyName);
    } catch (error) {
      logger.error({ err: error, request }, 'Failed to get tool auth URL');
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  });

  registerHandler('onboarding:verify-tool-auth', async (_event: HandlerInvokeEvent, request: { tool: AuthToolType; serverName?: string; companyName?: string }) => {
    try {
      ensureNormalizedSettings();
      const settings = getSettings();
      const { tool, serverName, companyName } = request;
      logger.info({ tool, serverName, companyName }, 'onboarding:verify-tool-auth invoked (deprecated - Klavis removed)');
      return await verifyToolAuth(settings, tool, serverName, companyName);
    } catch (error) {
      logger.error({ err: error, request }, 'Failed to verify tool auth');
      return { success: false, isAuthenticated: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  });

  // NOTE: 'check-for-updates' handler is registered by the auto-updater setup
  // in index.ts, not here. See the auto-update configuration section.

  registerHandler('misc:fetch-update-manifest', async (_event: HandlerInvokeEvent) => {
    try {
      const manifestUrl = getUpdateManifestUrl();
      logger.info({ url: manifestUrl }, 'Fetching update manifest from GCS');
      const response = await axios.get(manifestUrl, {
        timeout: 10000,
        headers: {
          'Cache-Control': 'no-cache',
        },
      });

      const parseResult = UpdateManifestSchema.safeParse(response.data);
      if (!parseResult.success) {
        logger.warn({ error: parseResult.error }, 'Invalid manifest format from GCS');
        return {
          success: false,
          error: 'Invalid manifest format',
        };
      }

      logger.info({ version: parseResult.data.version }, 'Successfully fetched update manifest');
      return {
        success: true,
        manifest: parseResult.data,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error({ err: error }, 'Failed to fetch update manifest');
      return {
        success: false,
        error: message,
      };
    }
  });

  registerHandler('misc:mcp-authenticate', async (_event: HandlerInvokeEvent, request: { serverId: string; force?: boolean }) => {
    try {
      logger.info({ serverId: request.serverId, force: request.force }, 'Triggering MCP server authentication');
      return await authenticateMcpServer(request.serverId, { force: request.force });
    } catch (error) {
      logger.error({ err: error, serverId: request.serverId }, 'Failed to authenticate MCP server');
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  });

  registerHandler('misc:mcp-invoke-stdio-auth', async (_event: HandlerInvokeEvent, request: { serverId: string; toolName: string; email?: string }) => {
    try {
      logger.info({ serverId: request.serverId, toolName: request.toolName, hasEmail: !!request.email }, 'Invoking stdio MCP authenticate tool');
      const result = await invokeStdioAuthenticateTool(request.serverId, request.toolName, { email: request.email });
      // Carry the structured setup guidance (not-configured branch) through to the renderer;
      // agentInstruction is intentionally dropped (not part of this channel's response schema).
      return {
        success: result.success,
        ...(result.authUrl ? { authUrl: result.authUrl } : {}),
        ...(result.error ? { error: result.error } : {}),
        ...(result.setupGuidance ? { setupGuidance: result.setupGuidance } : {}),
      };
    } catch (error) {
      logger.error({ err: error, serverId: request.serverId, toolName: request.toolName }, 'Failed to invoke stdio authenticate tool');
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  });

  registerHandler('misc:mcp-check-health', async (_event: HandlerInvokeEvent, request: { serverId: string }) => {
    try {
      return await checkMcpServerHealth(request.serverId);
    } catch (error) {
      logger.warn({ err: error, serverId: request.serverId }, 'Failed to check MCP server health');
      return { health: 'unknown' as const };
    }
  });

  registerHandler('quips:generate', async (_event: HandlerInvokeEvent, request: QuipGenerationRequest) => {
    try {
      ensureNormalizedSettings();
      const settings = getSettings();
      // Pass the Efficiency Mode abort signal so an off → on transition aborts
      // any in-flight quip LLM call before it can write to the cost ledger.
      const { getEfficiencyModeAbortSignal } = await import('../services/efficiencyModeSignal');
      return await generateDynamicQuips(request, settings, getEfficiencyModeAbortSignal());
    } catch (error) {
      logger.error({ err: error, turnId: request.turnId }, 'Failed to generate quips');
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  });

  registerHandler('misc:get-changelog', async (_event: HandlerInvokeEvent) => {
    try {
      ensureNormalizedSettings();
      const settings = getSettings();
      const coreDirectory = settings.coreDirectory;
      
      if (!coreDirectory) {
        return { success: false, error: 'No workspace configured' };
      }
      
      const changelogPath = path.join(coreDirectory, 'rebel-system', 'help-for-humans', 'changelog.md');
      const rawContent = await fs.readFile(changelogPath, 'utf8');
      const content = truncateChangelogToBudget(rawContent);
      return { success: true, content };
    } catch (error) {
      logger.warn({ err: error }, 'Failed to read changelog');
      return { success: false, error: error instanceof Error ? error.message : 'Changelog not found' };
    }
  });

  registerHandler('misc:get-coaching-sessions', (_event: HandlerInvokeEvent) => {
    const pendingCoaching = sessionCoachingScheduler.getAllPendingCoaching();
    logger.info({ count: pendingCoaching.length, sessionIds: pendingCoaching.map(c => c.sessionId) }, 'Fetching coaching sessions');
    return { sessionIds: pendingCoaching.map((c) => c.sessionId) };
  });

  registerHandler('misc:get-coaching-for-session', (_event: HandlerInvokeEvent, { sessionId }: { sessionId: string }) => {
    const evaluation = sessionCoachingScheduler.getCoachingForSession(sessionId);
    return { evaluation };
  });

  registerHandler('misc:update-coaching-state', (_event: HandlerInvokeEvent, { sessionId, state, dismissalReason }: { sessionId: string; state: string; dismissalReason?: string }) => {
    sessionCoachingScheduler.updateCoachingState(sessionId, state as 'pending' | 'shown' | 'acted' | 'dismissed', dismissalReason as 'not_relevant' | 'too_obvious' | 'not_useful' | 'other' | undefined);
    logger.info({ sessionId, state }, 'Coaching state updated');
    return { success: true };
  });

  registerHandler('misc:get-suggested-skills', (_event: HandlerInvokeEvent) => {
    const suggestions = sessionCoachingScheduler.getAllSuggestedSkills();
    return { suggestions };
  });

  registerHandler('misc:check-python-runtime', async (_event: HandlerInvokeEvent, request?: { forceRefresh?: boolean }) => {
    return checkPythonRuntime(request?.forceRefresh ?? false);
  });

  registerHandler('misc:get-executable-path', (_event: HandlerInvokeEvent) => {
    const isPackaged = getPlatformConfig().isPackaged;
    // In packaged app, process.execPath points to the actual executable
    // In development, it points to Electron, which won't work for MCP clients
    return {
      path: isPackaged ? process.execPath : null,
      isPackaged,
    };
  });

  registerHandler('misc:capture-screenshot', async (_event: HandlerInvokeEvent) => {
    return captureActiveDisplay();
  });

  // ==========================================================================
  // Achievements Handlers (Phase 1 Gamification)
  // ==========================================================================

  registerHandler('achievements:get-streak', (_event: HandlerInvokeEvent) => {
    return getStreakData();
  });

  registerHandler('achievements:get-badges', (_event: HandlerInvokeEvent) => {
    return getBadges();
  });

  registerHandler('achievements:get-tier', (_event: HandlerInvokeEvent) => {
    return getCurrentTier();
  });

  registerHandler('achievements:get-tier-evidence', (_event: HandlerInvokeEvent) => {
    return getTierEvidence();
  });

  registerHandler('achievements:get-next-badge', (_event: HandlerInvokeEvent) => {
    return getNextUnnotifiedBadge();
  });

  registerHandler('achievements:mark-badge-notified', (_event: HandlerInvokeEvent, badgeId: string) => {
    markBadgeNotified(badgeId);
    return { success: true };
  });

  registerHandler('achievements:get-evidence-counts', (_event: HandlerInvokeEvent) => {
    return getEvidenceCounts();
  });

  registerHandler('achievements:get-journey', (_event: HandlerInvokeEvent) => {
    return getOnboardingJourney();
  });

  registerHandler('achievements:start-journey', (_event: HandlerInvokeEvent) => {
    startOnboardingJourney();
    return { success: true };
  });

  registerHandler('achievements:reset-journey', (_event: HandlerInvokeEvent) => {
    resetOnboardingJourney();
    return { success: true };
  });

  registerHandler('achievements:complete-journey-day', (_event: HandlerInvokeEvent, day: number) => {
    const completed = markJourneyDayComplete(day);
    return { success: completed, day };
  });

  registerHandler('achievements:get-counters', (_event: HandlerInvokeEvent) => {
    return getCounters();
  });

  registerHandler('achievements:should-show-graduation', (_event: HandlerInvokeEvent) => {
    return shouldShowGraduation();
  });

  registerHandler('achievements:mark-graduation-shown', (_event: HandlerInvokeEvent) => {
    markGraduationShown();
  });

  registerHandler('achievements:get-tier-progress', (_event: HandlerInvokeEvent) => {
    return getTierProgress();
  });
}

