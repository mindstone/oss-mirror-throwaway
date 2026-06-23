/**
 * Meeting Bot Service
 *
 * Orchestrates meeting bot operations:
 * - Sending bots to meetings (via centralized Recall.ai backend)
 * - Tracking pending transcripts
 * - Fetching completed transcripts
 * - Background polling for status updates
 *
 * Uses Cloudflare Workers backend for centralized Recall.ai account management.
 */

import crypto from 'node:crypto';
import fsSync from 'node:fs';
import { BrowserWindow } from 'electron';
import { createScopedLogger } from '@core/logger';
import { notifyDistributionReady } from '@core/meetingSource/saveMeetingSource';
import type { OperatorRegistry } from '@core/services/operatorRegistry';
import * as operatorRegistry from '@core/services/operatorRegistry';
import { getSettings, updateSettings } from '@core/services/settingsStore';
import { getRebelAuthProvider } from '@core/rebelAuth';
import type { RebelAvatarId } from '@shared/types';
import type { PendingTranscript } from '@shared/ipc/channels/meetingBot';
import { fireAndForget } from '@shared/utils/fireAndForget';
import { mapWithConcurrencyLimit } from '@core/utils/concurrencyLimit';
import {
  getPendingTranscripts,
  getPendingTranscript,
  addPendingTranscript,
  updatePendingTranscriptStatus,
  removePendingTranscript,
  cleanupExpiredTranscripts,
  getTranscriptsNeedingCheck,
  getTranscriptsNeedingSave,
  getTranscriptsNeedingAnalysis,
  getTranscriptsNeedingAsyncUpgrade,
  getTimedOutAsyncUpgrades,
  markTranscriptSaved,
  markTranscriptStaged,
  incrementSaveAttempts,
  incrementConsecutiveErrors,
  resetConsecutiveErrors,
  updateLastRetryAt,
  updateTranscriptQuality,
  updateAsyncUpgradeStatus,
  scheduleAnalysis,
  setNextRetryTime,
  ensureRetryWindowStarted,
  markExhaustedTranscriptsAsFailed,
  resetTransientFailedTranscripts,
  updateRelayBotId,
  updateRecordingStartTime,
  updatePendingTranscriptCoachSelection,
  updatePendingTranscriptPresenceMode,
  updatePendingTranscriptConversationState,
} from './pendingTranscriptsStore';
import {
  saveTranscript,
  cleanTranscriptText,
  upgradeTranscriptQuality,
  upgradeExistingLiveTranscript,
  readLiveTranscriptFrontmatter,
  parseLiveTranscriptSegments,
  type ChatMessage,
  type TranscriptData,
  type TranscriptStorageResult,
  type TranscriptQuality,
} from './transcriptStorage';
import { triggerMeetingAnalysis } from './meetingAnalysisService';
import { emitTranscriptDistributionReady } from './transcriptEventBus';
import { generateBackendAuthHeader } from './backendAuth';
import {
  MeetingBotBackendConfigError,
  meetingBotBackendConfigMissingLogContext,
  resolveMeetingBotBackendConfig,
} from '@core/services/meetingBotBackendConfig';
import { broadcastCollaboratorStateIfPresent, setCollaboratorInfo, broadcastCollaboratorFromPendingTranscript } from './desktopSdkService';
import {
  registerActiveBotStateProvider,
  getCurrentMeeting,
  isLocalRecordingCapturing,
} from './meetingBotRuntimeRegistry';
import { urlsMatchSameMeeting, extractMeetingId, isWithinDedupWindow } from './urlUtils';
import {
  connectToRelay,
  disconnectFromRelay,
  getRelayClient,
  type RelayClientCallbacks,
} from './relayClient';
import {
  startBotQA,
  stopBotQA,
  processTranscriptSegment,
  clearProactivePending,
  rehydrateTranscriptBuffer,
  startLocalTranscriptBuffer,
  fetchChatMessagesFromBackend,
} from './botQAService';
import { announceJoin, announceLeaveAndWait } from './botVoiceService';
import { resetBotCoachState, setCoachStartTime } from '../liveCoachService';
import { resolveMeetingCoachPrompt } from '../meetingCoachPromptResolver';
import { startStateTracking, stopStateTracking } from './conversationStateService';

const log = createScopedLogger({ service: 'meeting-bot' });

/** In-flight save operations to prevent duplicate concurrent saves */
const savesInProgress = new Set<string>();

/**
 * In-flight bot dispatch operations, keyed by normalized meeting ID.
 * Uses Promise coalescing pattern: concurrent sendBot() calls for the same meeting
 * will await the same Promise instead of creating duplicate bots.
 * 
 * This prevents the race condition where multiple calendar syncs or rapid user clicks
 * dispatch multiple bots before addPendingTranscript() completes.
 */
const dispatchesInFlight = new Map<string, Promise<SendBotResult>>();

/** Result type for sendBot operations (used by dispatch coalescing) */
interface SendBotResult {
  success: boolean;
  botId?: string;
  error?: string;
  isOwner?: boolean;
  ownerName?: string;
  canOverride?: boolean;
}

/**
 * Generate a random client secret for a bot.
 * This secret is stored locally and sent with transcript requests to ensure
 * only the client that created the bot can retrieve its transcript.
 */
function generateClientSecret(): string {
  return crypto.randomBytes(32).toString('base64');
}

/** Polling interval for transcript status checks (5 minutes) */
const POLL_INTERVAL_MS = 5 * 60 * 1000;

/** Faster polling interval for scheduled bots near their start time (30 seconds).
 *  Ensures cloud-side activation catches the scheduled→in_meeting transition
 *  promptly when the Desktop SDK fails to detect the meeting window. */
const IMMINENT_BOT_POLL_INTERVAL_MS = 30 * 1000;

/** How far ahead of a scheduled bot's start time to begin fast polling (10 minutes) */
const IMMINENT_BOT_LOOKAHEAD_MS = 10 * 60 * 1000;

/** Initial delay before first poll (30 seconds) */
const INITIAL_POLL_DELAY_MS = 30 * 1000;

/** Fast polling interval for active bots (3 seconds) */
const FAST_POLL_INTERVAL_MS = 3 * 1000;

/** Slow polling interval during recording (30 seconds) */
const RECORDING_POLL_INTERVAL_MS = 30 * 1000;

/** Waiting room timeout threshold (2 minutes) */
const WAITING_ROOM_TIMEOUT_MS = 2 * 60 * 1000;

/** Joining timeout threshold (4 minutes) - fallback if we never receive status updates */
const JOINING_TIMEOUT_MS = 4 * 60 * 1000;

/** Threshold for considering live captions stale (no new segments received) */
const CAPTION_STALE_THRESHOLD_MS = 30_000;

const TERMINAL_FATAL_SUBCODES = new Set([
  'meeting_password_incorrect',
  'meeting_ended',
  'meeting_not_found',
  'recording_permission_denied',
]);

export function isTerminalFatalSubCode(subCode: string | undefined): boolean {
  if (!subCode) {
    return false;
  }
  return TERMINAL_FATAL_SUBCODES.has(subCode);
}

// =============================================================================
// Quips System (Rebel Voice)
// =============================================================================

const DISPATCHING_QUIPS = [
  'On my way. Save me a seat.',
  'Your stand-in has been summoned.',
  'Running to the meeting. Virtually.',
  'Dispatching your proxy...',
];

const JOINING_QUIPS = [
  'In the waiting room. Fashionably early.',
  'Knocking politely...',
  'Seeking admission.',
  'At the door. Looking professional.',
];

const RECORDING_QUIPS = [
  'Taking notes',
  'Listening intently',
  'Capturing the discourse',
  'Documenting everything',
];

function pickRandomQuip(quips: string[]): string {
  return quips[Math.floor(Math.random() * quips.length)];
}

/**
 * Map Recall API error codes to user-friendly messages.
 */
export function mapRecallErrorToUserMessage(
  recallStatus?: number,
  recallErrorCode?: string,
  recallSubCode?: string,
): string {
  // Check sub_code first, then fall back to code (Recall may use either field)
  const effectiveSubCode = recallSubCode || recallErrorCode;

  if (effectiveSubCode === 'teams_blacklisted_tenant') {
    return "This Teams organization doesn't allow recording bots. Ask the organizer to check their Teams admin settings.";
  }
  if (effectiveSubCode === 'meeting_requires_sign_in') {
    return "This meeting requires sign-in access. Rebel can't join meetings with sign-in requirements yet.";
  }
  if (effectiveSubCode === 'meeting_not_accessible') {
    return 'Meeting access settings are blocking the recording bot. The organizer may need to adjust their settings.';
  }
  if (effectiveSubCode === 'google_meet_bot_blocked') {
    return 'Google blocked the recording bot. The meeting host may need to adjust their settings.';
  }
  if (effectiveSubCode === 'google_meet_knocking_disabled') {
    return 'The meeting host has disabled knocking. Ask them to let Rebel in manually.';
  }

  // HTTP status code messages
  if (recallStatus === 507) {
    return 'Recording service is temporarily busy. Try again in a moment.';
  }
  if (recallStatus === 402) {
    return 'Recording service billing issue. Please contact support.';
  }
  if (recallStatus === 429) {
    return 'Too many recording requests. Please wait a moment and try again.';
  }
  if (recallStatus === 401) {
    return 'Recording service authentication failed. Please contact support.';
  }

  if (effectiveSubCode === 'meeting_password_incorrect') {
    return 'The meeting requires a passcode or hasn\'t admitted Rebel from the waiting room.';
  }
  if (effectiveSubCode === 'meeting_ended') {
    return 'The meeting had already ended when Rebel tried to join.';
  }
  if (effectiveSubCode === 'meeting_not_found') {
    return 'The meeting link appears to be invalid or has expired.';
  }
  if (effectiveSubCode === 'recording_permission_denied') {
    return 'The meeting host denied recording permission.';
  }

  return 'Failed to start recording. Please try again.';
}

/**
 * Resolve the bot owner's first name from settings, falling back to auth profile.
 * Returns 'User' only if both sources are empty -- this indicates a configuration
 * problem that the userProfileComplete health check will flag.
 */
function resolveOwnerName(): string {
  const settings = getSettings();
  const fromSettings = settings?.userFirstName?.trim();
  if (fromSettings) return fromSettings;

  const authUser = getRebelAuthProvider().getAuthState().user;
  const fromAuth = authUser?.name?.split(/\s+/)[0]?.trim();
  if (fromAuth) {
    // Auto-populate settings so the user doesn't hit this path again
    updateSettings({ userFirstName: fromAuth });
    log.info({ resolvedName: fromAuth, source: 'auth' }, 'Auto-populated userFirstName from auth profile');
    return fromAuth;
  }

  log.warn('Could not resolve owner name from settings or auth — voice triggers will not work');
  return 'User';
}

// =============================================================================
// Active Bot Tracking (for UI state)
// =============================================================================

export type BotUiState = 
  | 'detected'
  | 'dispatching'
  | 'joining'
  | 'recording'
  | 'waiting_too_long'
  | 'rejected';

export type PresenceMode = 'silent' | 'coach' | 'participant';

export interface ActiveBotState {
  botId: string;
  meetingUrl: string;
  meetingTitle: string;
  uiState: BotUiState;
  quip: string;
  recallStatus?: string;
  /** When bot entered `joining` state - for overall timeout detection */
  joiningStartTime?: number;
  /** When bot entered waiting room - for waiting room specific timeout */
  waitingRoomStartTime?: number;
  recordingStartTime?: number;
  /** Client secret for authenticated status polling (multi-user dedup support) */
  clientSecret?: string;
  /** Session token for relay authentication (Tier 2 features) */
  sessionToken?: string;
  /** WebSocket relay URL for this bot */
  relayUrl?: string;
  /** Whether avatar is connected to relay */
  avatarConnected?: boolean;
  /** Whether join announcement has been spoken this session (prevents re-announcing on reconnect) */
  hasAnnounced?: boolean;
  /** Live coach companion session ID (if coach is active) */
  companionSessionId?: string;
  /** Selected coach skill path (if coach is active) */
  coachSkillPath?: string;
  /** Resolved coaching prompt cached at coach selection time. */
  coachPrompt?: string;
  /** Hash of the cached coaching prompt for cache invalidation. */
  coachContentHash?: string;
  /** Source of the resolved coaching prompt (operator frontmatter vs file body). */
  coachPromptSource?: 'operator-frontmatter' | 'file-body';
  /** Optional per-coach proactive interval override from operator frontmatter. */
  coachProactiveIntervalMinutes?: number;
  /** Last observed mtime for coachSkillPath when coachPrompt was resolved. */
  coachPromptLastModifiedMs?: number;
  /** User-selected active participation mode */
  presenceMode?: PresenceMode;
  /** Timestamp of most recent caption segment received from relay */
  lastCaptionReceivedAt?: number;
  /** Whether at least one caption segment has been received this session */
  hasReceivedCaption?: boolean;
  /** Timestamp when bot entered `in_call_not_recording` state — for stuck-state diagnostics */
  inCallNotRecordingEnteredAt?: number;
  /** Whether the stuck-state warning has already been logged (prevents log spam) */
  inCallNotRecordingWarned?: boolean;
  /** Whether conversation state was already persisted during a permanent relay disconnect cleanup */
  conversationStatePersistedAtDisconnect?: boolean;
}

let activeBotState: ActiveBotState | null = null;
let fastPollInterval: ReturnType<typeof setInterval> | null = null;
let captionStaleTimer: ReturnType<typeof setTimeout> | null = null;
let imminentBotPollInterval: ReturnType<typeof setInterval> | null = null;
let isCheckingPendingTranscripts = false;

const meetingCoachOperatorRegistry: OperatorRegistry = {
  listAvailable: operatorRegistry.listAvailable,
  listAvailableWithDiagnostics: operatorRegistry.listAvailableWithDiagnostics,
  getById: operatorRegistry.getById,
  invalidate: operatorRegistry.invalidateOperatorRegistry,
};

function clearCachedCoachPrompt(state: ActiveBotState): void {
  state.coachPrompt = undefined;
  state.coachContentHash = undefined;
  state.coachPromptSource = undefined;
  state.coachProactiveIntervalMinutes = undefined;
  state.coachPromptLastModifiedMs = undefined;
}

interface ResolvedCoachPromptCache {
  coachPrompt: string;
  coachContentHash: string;
  coachPromptSource: 'operator-frontmatter' | 'file-body';
  coachProactiveIntervalMinutes?: number;
  coachPromptLastModifiedMs?: number;
}

const LEGACY_COACH_SKILL_PATH_PATTERN = /^(.*)rebel-system[\\/]skills[\\/]coaching[\\/]([^\\/]+)[\\/]SKILL\.md$/u;

function maybeRemapLegacyCoachSkillPath(coachSkillPath: string): string {
  const legacyMatch = coachSkillPath.match(LEGACY_COACH_SKILL_PATH_PATTERN);
  if (!legacyMatch) {
    return coachSkillPath;
  }

  const [, prefix, coachSlug] = legacyMatch;
  const separator = coachSkillPath.includes('\\') ? '\\' : '/';
  const remappedPath = `${prefix}rebel-system${separator}operators${separator}${coachSlug}${separator}OPERATOR.md`;
  if (!fsSync.existsSync(remappedPath)) {
    return coachSkillPath;
  }

  log.info(
    {
      oldPath: coachSkillPath,
      newPath: remappedPath,
    },
    'operators:coach_path_remapped',
  );
  return remappedPath;
}

function resolveCoachPromptCache(coachSkillPath: string): ResolvedCoachPromptCache {
  const resolvedPrompt = resolveMeetingCoachPrompt(coachSkillPath, meetingCoachOperatorRegistry);
  const resolvedCache: ResolvedCoachPromptCache = {
    coachPrompt: resolvedPrompt.prompt,
    coachContentHash: resolvedPrompt.contentHash,
    coachPromptSource: resolvedPrompt.source,
    coachProactiveIntervalMinutes: resolvedPrompt.proactiveIntervalMinutes,
  };

  try {
    const stat = fsSync.statSync(coachSkillPath);
    resolvedCache.coachPromptLastModifiedMs = stat.mtimeMs;
  } catch (error) {
    resolvedCache.coachPromptLastModifiedMs = undefined;
    log.warn({ coachSkillPath, error }, 'Failed to stat coach prompt after resolution');
  }

  return resolvedCache;
}

function applyResolvedCoachPromptCache(state: ActiveBotState, resolvedCache: ResolvedCoachPromptCache): void {
  state.coachPrompt = resolvedCache.coachPrompt;
  state.coachContentHash = resolvedCache.coachContentHash;
  state.coachPromptSource = resolvedCache.coachPromptSource;
  state.coachProactiveIntervalMinutes = resolvedCache.coachProactiveIntervalMinutes;
  state.coachPromptLastModifiedMs = resolvedCache.coachPromptLastModifiedMs;
}

function cacheResolvedCoachPrompt(state: ActiveBotState): void {
  if (!state.coachSkillPath) {
    clearCachedCoachPrompt(state);
    return;
  }

  try {
    const resolvedCache = resolveCoachPromptCache(state.coachSkillPath);
    applyResolvedCoachPromptCache(state, resolvedCache);
  } catch (error) {
    clearCachedCoachPrompt(state);
    log.warn({ botId: state.botId, coachSkillPath: state.coachSkillPath, error }, 'Failed to resolve coach prompt at selection time');
    return;
  }
}

/** Active collaborator bot ID — prevents repeated restore/reconnect in catch-all polling */
let activeCollaboratorBotId: string | null = null;

import type { MeetingBotService } from './meetingBotTypes';
export type { MeetingBotService };

/** Polling interval handle */
let pollInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Get user ID for HMAC identification.
 */
function getUserId(): string | null {
  const authState = getRebelAuthProvider().getAuthState();
  return authState?.user?.id ?? null;
}

/**
 * Make an authenticated request to the backend.
 * @param path - API path (e.g., '/api/bot')
 * @param options - Fetch options
 * @param clientSecret - Optional client secret for bot-specific operations
 */
async function backendFetch(
  path: string,
  options: RequestInit = {},
  clientSecret?: string
): Promise<Response> {
  const userId = getUserId();
  if (!userId) {
    throw new Error('User not authenticated');
  }

  const config = resolveMeetingBotBackendConfig();
  if (!config.configured) {
    log.error(
      meetingBotBackendConfigMissingLogContext(config.missing),
      'Meeting bot backend config missing; refusing backend request',
    );
    throw new MeetingBotBackendConfigError(config.missing);
  }

  const authHeader = generateBackendAuthHeader(userId);
  if (!authHeader) {
    throw new MeetingBotBackendConfigError(['authKey']);
  }

  const headers = new Headers(options.headers);
  headers.set('X-Mindstone-Auth', authHeader);
  headers.set('Content-Type', 'application/json');
  if (clientSecret) {
    headers.set('X-Client-Secret', clientSecret);
  }

  return fetch(`${config.url}${path}`, {
    ...options,
    headers,
  });
}

/**
 * Notify renderer that a transcript is ready.
 */
function notifyTranscriptReady(botId: string, meetingTitle: string): void {
  // eslint-disable-next-line no-restricted-syntax -- window-scan-send-allowlisted: transcript-ready is a genuine all-window meeting-bot broadcast; migrate later to BroadcastService.
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send('meeting-bot:transcript-ready', {
        botId,
        meetingTitle,
        timestamp: Date.now(),
      });
    }
  }
}

/**
 * Map Recall status codes to our status enum.
 */
export function mapRecallStatus(recallStatus: string): PendingTranscript['status'] {
  switch (recallStatus) {
    case 'ready':
    case 'joining_call':
    case 'in_waiting_room':
      return 'scheduled';
    case 'in_call_not_recording':
    case 'in_call_recording':
      return 'in_meeting';
    case 'call_ended':
    case 'processing':
      return 'processing';
    case 'done':
    case 'analysis_done':
      return 'ready';
    case 'fatal':
    case 'analysis_failed':
    case 'media_expired':
    case 'recording_permission_denied':
      return 'failed';
    default:
      log.warn({ recallStatus }, 'Unmapped Recall status code — defaulting to scheduled for dedup safety');
      return 'scheduled';
  }
}

/**
 * Map Recall status to UI state for the title bar indicator.
 * Includes timeout checks for both waiting room and overall joining duration.
 */
export function mapRecallStatusToUiState(
  recallStatus: string, 
  joiningStartTime?: number,
  waitingRoomStartTime?: number
): BotUiState {
  // First check overall joining timeout (fallback if API fails)
  // This catches cases where Recall API returns errors and we never get status updates
  // Only apply timeout for joining-like states - don't override recording/terminal states
  const NON_JOINING_STATUSES = ['in_call_not_recording', 'in_call_recording', 'done', 'call_ended', 'fatal', 'analysis_failed', 'processing'];
  if (joiningStartTime && Date.now() - joiningStartTime > JOINING_TIMEOUT_MS) {
    if (!NON_JOINING_STATUSES.includes(recallStatus)) {
      log.debug({ recallStatus, joiningStartTime }, 'Joining timeout triggered');
      return 'waiting_too_long';
    }
    log.debug({ recallStatus }, 'Joining timeout bypassed - bot in non-joining state');
  }

  switch (recallStatus) {
    case 'ready':
    case 'joining_call':
      return 'joining';
    case 'in_waiting_room': {
      // Check if we've been waiting too long in the waiting room
      if (waitingRoomStartTime && Date.now() - waitingRoomStartTime > WAITING_ROOM_TIMEOUT_MS) {
        return 'waiting_too_long';
      }
      return 'joining';
    }
    case 'in_call_not_recording':
    case 'in_call_recording':
      return 'recording';
    case 'fatal':
    case 'analysis_failed':
      return 'rejected';
    default:
      return 'joining';
  }
}

/** Compute whether live captions are actively flowing for the current bot. */
export function computeCaptionsActive(state: ActiveBotState): boolean | undefined {
  if (state.uiState !== 'recording') return undefined;
  if (state.avatarConnected === false) return undefined; // No relay = no live captions
  if (!state.lastCaptionReceivedAt || !state.hasReceivedCaption) return undefined;
  const elapsed = Date.now() - state.lastCaptionReceivedAt;
  return elapsed <= CAPTION_STALE_THRESHOLD_MS;
}

/**
 * Broadcast active bot status to all renderer windows.
 */
function broadcastBotStatus(meeting: { id: string; title: string; url: string } | null): void {
  // eslint-disable-next-line no-restricted-syntax -- window-scan-send-allowlisted: cloud bot status is a genuine all-window meeting-bot broadcast; migrate later to BroadcastService.
  const windows = BrowserWindow.getAllWindows();
  
  if (!activeBotState) {
    // No active bot - let Desktop SDK handle the 'detected' state
    return;
  }

  const otherRecordingBots = getPendingTranscripts().filter(
    t => t.status === 'in_meeting' && t.botId !== activeBotState?.botId
  );

  const payload = {
    state: activeBotState.uiState,
    source: 'cloud_bot' as const, // For precedence handling in renderer
    meeting: meeting ? {
      id: meeting.id,
      title: meeting.title,
      startTime: new Date().toISOString(),
      meetingUrl: meeting.url,
    } : {
      id: activeBotState.botId,
      title: activeBotState.meetingTitle,
      startTime: new Date().toISOString(),
      meetingUrl: activeBotState.meetingUrl,
    },
    botId: activeBotState.botId,
    quip: activeBotState.quip,
    waitingRoomStartTime: activeBotState.waitingRoomStartTime,
    recordingDuration: activeBotState.recordingStartTime
      ? Math.floor((Date.now() - activeBotState.recordingStartTime) / 1000)
      : undefined,
    avatarConnected: activeBotState.avatarConnected,
    captionsActive: computeCaptionsActive(activeBotState),
    presenceMode: activeBotState.presenceMode ?? (activeBotState.coachSkillPath ? 'coach' : 'silent'),
    otherActiveBotsCount: otherRecordingBots.length,
    timestamp: Date.now(),
  };

  log.debug({ uiState: activeBotState.uiState, botId: activeBotState.botId }, 'Broadcasting bot status');

  for (const window of windows) {
    if (!window.isDestroyed()) {
      window.webContents.send('meeting-bot:status', payload);
    }
  }
}

/**
 * Broadcast bot completion to all renderer windows.
 * 
 * Always sends a passive 'no_meetings' from cloud_bot source first to clear any
 * active cloud_bot states (like 'rejected'). This ensures the renderer's precedence
 * rules allow the clear signal through (same source can clear its own active state).
 * 
 * If Desktop SDK still sees a meeting, we send a second broadcast with 'detected'
 * to allow fallback options.
 */
function broadcastBotCompletion(): void {
  // eslint-disable-next-line no-restricted-syntax -- window-scan-send-allowlisted: cloud bot completion is a genuine all-window meeting-bot broadcast; migrate later to BroadcastService.
  const windows = BrowserWindow.getAllWindows();
  
  // First, always send a clear signal from cloud_bot to reset active states.
  // This is necessary because the renderer's precedence rules only allow same-source
  // passive states to override active states. Without this, a 'rejected' state from
  // cloud_bot would block a 'detected' state from the lower-precedence desktop_sdk.
  const clearPayload = {
    state: 'no_meetings' as const,
    source: 'cloud_bot' as const,
    timestamp: Date.now(),
  };

  log.debug('Broadcasting cloud_bot clear signal');
  for (const window of windows) {
    if (!window.isDestroyed()) {
      window.webContents.send('meeting-bot:status', clearPayload);
    }
  }

  // Then, if Desktop SDK still sees a meeting, check if there's a collaborator bot
  // that should be shown instead of the generic "detected" state
  const currentMeeting = getCurrentMeeting?.();
  if (currentMeeting) {
    // Try to broadcast collaborator state first - this handles the case where
    // user stopped their own bot but a colleague's bot is still recording
    if (broadcastCollaboratorStateIfPresent()) {
      log.debug('Restored collaborator_recording state after bot completion');
      return;
    }
    
    // No collaborator, broadcast regular detected state
    const detectedPayload = {
      state: 'detected' as const,
      source: 'desktop_sdk' as const,
      meeting: {
        id: currentMeeting.windowId,
        title: currentMeeting.title || 'Meeting',
        meetingUrl: currentMeeting.url,
        startTime: new Date().toISOString(),
      },
      timestamp: Date.now(),
    };

    log.debug({ hasActiveMeeting: true }, 'Broadcasting desktop_sdk detected state');
    for (const window of windows) {
      if (!window.isDestroyed()) {
        window.webContents.send('meeting-bot:status', detectedPayload);
      }
    }
  }
}

/**
 * Check if joining has timed out and broadcast updated status.
 * Called when API fails but we still need to check for timeout.
 */
function checkJoiningTimeoutAndBroadcast(): void {
  if (!activeBotState) return;

  // Check if we've been in joining/dispatching state too long (4 minutes)
  // This covers both: bot stuck dispatching (API never responds) and bot stuck joining
  const isJoiningLikeState = activeBotState.uiState === 'joining' || activeBotState.uiState === 'dispatching';
  if (
    isJoiningLikeState &&
    activeBotState.joiningStartTime &&
    Date.now() - activeBotState.joiningStartTime > JOINING_TIMEOUT_MS
  ) {
    log.warn({ 
      botId: activeBotState.botId, 
      uiState: activeBotState.uiState,
      joiningStartTime: activeBotState.joiningStartTime,
      elapsedMs: Date.now() - activeBotState.joiningStartTime
    }, 'Bot joining timed out - no status updates received');
    
    activeBotState.uiState = 'waiting_too_long';
    activeBotState.quip = ''; // Clear joining quip so renderer uses error-state fallback
  }

  broadcastBotStatus(null);
}

/**
 * Handle terminal bot statuses and clear state.
 * Returns true if terminal status was handled.
 */
function handleTerminalBotStatus(
  data: { status: string; sub_code?: string },
  pollingBotId: string,
): boolean {
  if (data.status !== 'done' && data.status !== 'call_ended') {
    return false;
  }

  const didRecord = !!activeBotState?.recordingStartTime;

  if (didRecord) {
    log.info({ botId: pollingBotId }, 'Bot completed successfully, broadcasting completion');
    notifyTranscriptReady(pollingBotId, activeBotState?.meetingTitle ?? 'Meeting');
    broadcastBotCompletion();
  } else {
    // Bot ended but never recorded - clear UI state cleanly
    // (e.g., stale poll after app restart saw done for a bot that recorded in previous session)
    log.warn({
      botId: pollingBotId,
      previousState: activeBotState?.uiState,
      recallStatus: data.status,
      subCode: data.sub_code,
      lastKnownRecallStatus: activeBotState?.recallStatus,
    }, 'Bot ended without recording - broadcasting completion to clear UI');
    broadcastBotCompletion();
  }

  clearActiveBotState();
  return true;
}

/**
 * Track state transitions driven by Recall status updates.
 */
function updateBotStateTransitions(
  data: { status: string },
  previousRecallStatus: string | undefined,
): void {
  if (!activeBotState) {
    return;
  }

  // Track when bot enters waiting room
  if (data.status === 'in_waiting_room' && previousRecallStatus !== 'in_waiting_room') {
    activeBotState.waitingRoomStartTime = Date.now();
    log.info({ botId: activeBotState.botId }, 'Bot entered waiting room');
  }

  // Track when bot enters call but is not yet recording
  if (data.status === 'in_call_not_recording' && previousRecallStatus !== 'in_call_not_recording') {
    activeBotState.joiningStartTime = undefined; // Clear joining timer — bot is in the meeting
    activeBotState.inCallNotRecordingEnteredAt = Date.now(); // Track for stuck-state warning
    activeBotState.quip = pickRandomQuip(RECORDING_QUIPS);
    startStateTracking(activeBotState.botId);
    log.info({ botId: activeBotState.botId }, 'Bot in call (not yet recording) — treating as active');
  }

  // Warn once if stuck in in_call_not_recording for >2 minutes (diagnostic, not a state change)
  if (data.status === 'in_call_not_recording' && activeBotState.inCallNotRecordingEnteredAt && !activeBotState.inCallNotRecordingWarned) {
    const stuckMs = Date.now() - activeBotState.inCallNotRecordingEnteredAt;
    if (stuckMs > 2 * 60 * 1000 && !activeBotState.recordingStartTime) {
      activeBotState.inCallNotRecordingWarned = true;
      log.warn({ botId: activeBotState.botId, stuckMs }, 'Bot stuck in in_call_not_recording without recording starting');
    }
  }

  // Track when recording starts
  // Guard: only set if not already set (prevents overwrite after restart recovery)
  if (data.status === 'in_call_recording' && previousRecallStatus !== 'in_call_recording') {
    if (!activeBotState.recordingStartTime) {
      activeBotState.recordingStartTime = Date.now();
      // Persist to store for restart recovery
      updateRecordingStartTime(activeBotState.botId, activeBotState.recordingStartTime);
    }
    startStateTracking(activeBotState.botId);
    // Reset caption state for fresh tracking (prevents stale state if bot restarts)
    activeBotState.hasReceivedCaption = false;
    activeBotState.lastCaptionReceivedAt = undefined;
    activeBotState.joiningStartTime = undefined; // Clear joining timer - bot successfully joined
    activeBotState.quip = pickRandomQuip(RECORDING_QUIPS);
    log.info({ botId: activeBotState.botId }, 'Bot started recording');
  }
}

/**
 * Handle fatal/analysis_failed statuses with relay cross-check.
 */
/**
 * Returns true if the fatal status was handled (caller should skip normal UI remap).
 * Returns false if this is not a fatal status or if we want normal remap to proceed.
 */
function handleFatalBotStatus(data: { status: string; sub_code?: string }): boolean {
  if (!activeBotState) {
    return false;
  }

  if (data.status !== 'fatal' && data.status !== 'analysis_failed') {
    return false;
  }

  const relayClient = getRelayClient(activeBotState.botId);
  const relayAlive = relayClient?.connected ?? false;
  const terminalFatalSubCode = isTerminalFatalSubCode(data.sub_code);

  if (relayAlive && data.status === 'fatal') {
    if (!terminalFatalSubCode) {
      // Relay is connected and healthy — the bot is likely still in the meeting.
      // Recall API may have returned a spurious fatal (e.g. transient status race).
      // Don't override UI to rejected; keep current state and log the discrepancy.
      log.warn({
        botId: activeBotState.botId,
        status: data.status,
        subCode: data.sub_code,
        relayConnected: true,
        currentUiState: activeBotState.uiState,
      }, 'Recall reported fatal but relay is still connected and sub-code is not terminal — ignoring status, bot likely still in meeting');
      return true; // Skip UI remap — keep current state
    }

    log.warn({
      botId: activeBotState.botId,
      status: data.status,
      subCode: data.sub_code,
      relayConnected: true,
      currentUiState: activeBotState.uiState,
    }, 'Recall reported terminal fatal sub-code while relay is still connected — treating as rejected');
  }

  activeBotState.quip = terminalFatalSubCode
    ? mapRecallErrorToUserMessage(undefined, undefined, data.sub_code)
    : ''; // Clear joining quip so renderer uses error-state fallback

  log.warn({ botId: activeBotState.botId, status: data.status, subCode: data.sub_code, relayConnected: relayAlive }, 'Bot failed');
  activeBotState.uiState = 'rejected';

  if (terminalFatalSubCode) {
    broadcastBotStatus(null);
    stopFastPolling();
    fireAndForget(stopBotQA(activeBotState.botId), 'meetingBot.meetingBotService.line873');
    disconnectFromRelay(activeBotState.botId);
  }

  return true; // Handled — UI already set to rejected, skip normal remap
}

/**
 * Poll the active bot's status and update UI.
 */
async function pollActiveBotStatus(): Promise<void> {
  if (!activeBotState) {
    stopFastPolling();
    return;
  }

  // Capture botId at start - after async operations, verify we're still polling the same bot
  // This prevents race conditions when user swaps between meetings (multi-bot support)
  const pollingBotId = activeBotState.botId;
  const pollContext = {
    botId: pollingBotId,
    currentUiState: activeBotState.uiState,
    hasClientSecret: !!activeBotState.clientSecret,
  };

  try {
    // Use clientSecret header for authenticated status polling (required for multi-user dedup)
    const response = await backendFetch(
      `/api/bot/status?botId=${pollingBotId}`,
      {},
      activeBotState.clientSecret
    );

    // ORDER CONSTRAINT: Bot-swap guard must run after each await
    // Guard: bot may have been swapped during the await (multi-bot support)
    if (!activeBotState || activeBotState.botId !== pollingBotId) {
      log.debug({ pollingBotId, currentBotId: activeBotState?.botId }, 'Bot swapped during poll, discarding response');
      return;
    }
    
    if (!response.ok) {
      // 404 means bot doesn't exist on backend - treat as terminal state immediately
      // This happens when: bot expired, was deleted, or never created properly
      // Note: 400 means "missing clientSecret" NOT "bot not found" - don't treat as terminal
      if (response.status === 404) {
        log.warn({ botId: activeBotState.botId, status: response.status }, 'Bot not found (404) - treating as rejected');
        activeBotState.quip = ''; // Clear joining quip so renderer uses error-state fallback
        activeBotState.uiState = 'rejected';
        stopFastPolling(); // Stop polling - no point retrying a non-existent bot
        broadcastBotStatus(null);
        return;
      }
      
      // Other errors (400 missing auth, 500, network) - keep trying with timeout fallback
      log.warn({ botId: activeBotState.botId, status: response.status }, 'Failed to get active bot status');
      checkJoiningTimeoutAndBroadcast();
      return;
    }

    const data = await response.json() as { success: boolean; status?: string; sub_code?: string };

    // ORDER CONSTRAINT: Bot-swap guard must run after each await
    // Guard again after second await (multi-bot support)
    if (!activeBotState || activeBotState.botId !== pollingBotId) {
      log.debug({ pollingBotId, currentBotId: activeBotState?.botId }, 'Bot swapped during JSON parse, discarding response');
      return;
    }
    
    // Log the poll result for debugging
    log.debug({
      ...pollContext,
      recallStatus: data.status,
      subCode: data.sub_code,
      success: data.success,
    }, 'pollActiveBotStatus: received response');
    
    if (!data.success || !data.status) {
      // Still check for joining timeout even if response has no usable status
      checkJoiningTimeoutAndBroadcast();
      return;
    }

    // After the guard above, status is guaranteed to be a string
    const statusData = { status: data.status, sub_code: data.sub_code };

    const previousState = activeBotState.uiState;
    const previousRecallStatus = activeBotState.recallStatus;

    // ORDER CONSTRAINT: Terminal states must be checked before UI state remap
    if (handleTerminalBotStatus(statusData, pollingBotId)) {
      return;
    }

    updateBotStateTransitions(statusData, previousRecallStatus);

    // ORDER CONSTRAINT: Fatal check must run BEFORE UI state remap so relay-connected
    // spurious fatals don't get mapped to 'rejected' by mapRecallStatusToUiState
    const fatalHandled = handleFatalBotStatus(statusData);

    // Update state
    activeBotState.recallStatus = statusData.status;

    if (!fatalHandled) {
      const newUiState = mapRecallStatusToUiState(
        statusData.status, 
        activeBotState.joiningStartTime,
        activeBotState.waitingRoomStartTime
      );

      // Handle state transitions with new quips
      if (newUiState !== previousState) {
        activeBotState.uiState = newUiState;
        
        // Track when we first enter joining state (for overall timeout)
        if (newUiState === 'joining' && previousState === 'dispatching') {
          activeBotState.joiningStartTime = Date.now();
          activeBotState.quip = pickRandomQuip(JOINING_QUIPS);
          log.info({ botId: activeBotState.botId }, 'Bot started joining');
        }
        
        log.info({ botId: activeBotState.botId, from: previousState, to: newUiState }, 'Bot UI state changed');
      }
    }

    // Broadcast updated status
    broadcastBotStatus(null);

    // Adjust polling speed based on state
    adjustPollingSpeed();
  } catch (error) {
    log.warn({ botId: activeBotState?.botId, error }, 'Failed to poll active bot status');
    // Still check for joining timeout even on network errors
    checkJoiningTimeoutAndBroadcast();
  }
}

/**
 * Start fast polling for active bot status.
 */
function startFastPolling(): void {
  if (fastPollInterval) {
    return;
  }
  
  log.info('Starting fast bot status polling');
  fastPollInterval = setInterval(() => {
    fireAndForget(pollActiveBotStatus(), 'meetingBot.meetingBotService.line1019');
  }, FAST_POLL_INTERVAL_MS);
}

/**
 * Stop fast polling.
 */
function stopFastPolling(): void {
  if (fastPollInterval) {
    clearInterval(fastPollInterval);
    fastPollInterval = null;
    log.info('Stopped fast bot status polling');
  }
}

/**
 * Adjust polling speed based on current bot state.
 */
function adjustPollingSpeed(): void {
  if (!activeBotState) {
    stopFastPolling();
    return;
  }

  // Use slower polling during recording
  if (activeBotState.uiState === 'recording' && fastPollInterval) {
    stopFastPolling();
    log.info('Switching to slow polling during recording');
    fastPollInterval = setInterval(() => {
      fireAndForget(pollActiveBotStatus(), 'meetingBot.meetingBotService.line1048');
    }, RECORDING_POLL_INTERVAL_MS);
  }
}

/**
 * Clear active bot state (on completion or error).
 */
function clearActiveBotState(): void {
  // Stop Q&A service and disconnect from relay if connected
  if (activeBotState?.botId) {
    if (!activeBotState.conversationStatePersistedAtDisconnect) {
      const finalConversationState = stopStateTracking(activeBotState.botId);
      updatePendingTranscriptConversationState(
        activeBotState.botId,
        finalConversationState ? JSON.stringify(finalConversationState) : null
      );
    }
    fireAndForget(stopBotQA(activeBotState.botId), 'meetingBot.meetingBotService.line1066');
    disconnectFromRelay(activeBotState.botId);
    // Clear live coach state for this bot (prevents memory leak from Maps growing per meeting)
    resetBotCoachState(activeBotState.botId);
  }
  if (captionStaleTimer) {
    clearTimeout(captionStaleTimer);
    captionStaleTimer = null;
  }
  activeBotState = null;
  stopFastPolling();
}

/**
 * Get the current active bot state (for re-send functionality).
 */
export function getActiveBotState(): ActiveBotState | null {
  return activeBotState;
}

// Register at module load so sibling services (botQAService, localRecordingService,
// autoScheduleService, activeMeetingSession) can read via meetingBotRuntimeRegistry
// without static imports back to this module (breaks several cycles in the cluster).
registerActiveBotStateProvider(getActiveBotState);

/**
 * Get the currently active collaborator bot ID, if any.
 */
export function getActiveCollaboratorBotId(): string | null {
  return activeCollaboratorBotId;
}

/**
 * Clean up collaborator-specific state for a bot.
 * Called when: meeting ends, forceJoin transitions to owner, app shutdown.
 */
export function cleanupCollaboratorState(botId: string): void {
  if (activeCollaboratorBotId === botId) {
    activeCollaboratorBotId = null;
  }
  disconnectFromRelay(botId);
  fireAndForget(stopBotQA(botId), 'meetingBot.meetingBotService.line1107');
  // Note: collaboratorInfo in desktopSdkService is cleared by meeting lifecycle events

  // Broadcast cloud_bot clear to remove sticky collaborator_recording from renderer.
  // The collaborator state was broadcast with source: 'cloud_bot', so only a same-source
  // passive clear can override it in the renderer precedence rules.
  const clearPayload = {
    state: 'no_meetings' as const,
    source: 'cloud_bot' as const,
    timestamp: Date.now(),
  };
  // eslint-disable-next-line no-restricted-syntax -- window-scan-send-allowlisted: collaborator cleanup clear is a genuine all-window meeting-bot broadcast; migrate later to BroadcastService.
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send('meeting-bot:status', clearPayload);
    }
  }

  log.info({ botId }, 'Cleaned up collaborator state');
}

/**
 * Set the live coach for the active bot.
 * Called when user selects a coach in the UI.
 */
export function setActiveBotCoach(params: {
  coachSkillPath: string;
  companionSessionId: string;
} | null): boolean {
  if (!activeBotState) {
    if (params === null) {
      return true; // Nothing to clear — already gone
    }
    log.warn('Cannot set coach - no active bot');
    return false;
  }

  let didUpdatePresenceMode = false;
  
  if (params === null) {
    const wasParticipant = activeBotState.presenceMode === 'participant';
    activeBotState.coachSkillPath = undefined;
    activeBotState.companionSessionId = undefined;
    clearCachedCoachPrompt(activeBotState);
    activeBotState.presenceMode = 'silent';
    didUpdatePresenceMode = true;
    // Clear any pending proactive contributions when leaving participant mode
    if (wasParticipant) {
      clearProactivePending(activeBotState.botId);
    }
    // Persist to pending transcript store for restart recovery
    updatePendingTranscriptCoachSelection(activeBotState.botId, null);
    updatePendingTranscriptPresenceMode(activeBotState.botId, 'silent');
    log.info({ botId: activeBotState.botId }, 'Cleared live coach selection');
  } else {
    // Defensive validation: ensure required strings are non-empty
    const trimmedSkillPath = params.coachSkillPath?.trim();
    const trimmedSessionId = params.companionSessionId?.trim();
    if (!trimmedSkillPath || !trimmedSessionId) {
      log.warn({
        coachSkillPath: params.coachSkillPath,
        companionSessionId: params.companionSessionId,
        trimmedSkillPath,
        trimmedSessionId,
      }, 'Invalid coach params - coachSkillPath and companionSessionId must be non-empty strings');
      return false;
    }

    let resolvedCache: ResolvedCoachPromptCache;
    try {
      resolvedCache = resolveCoachPromptCache(trimmedSkillPath);
    } catch (error) {
      log.warn(
        { botId: activeBotState.botId, coachSkillPath: trimmedSkillPath, error },
        'operators:meeting_coach_selection_failed',
      );
      return false;
    }

    activeBotState.coachSkillPath = trimmedSkillPath;
    activeBotState.companionSessionId = trimmedSessionId;
    applyResolvedCoachPromptCache(activeBotState, resolvedCache);
    // Persist to pending transcript store for restart recovery
    updatePendingTranscriptCoachSelection(activeBotState.botId, {
      coachSkillPath: trimmedSkillPath,
      companionSessionId: trimmedSessionId,
    });
    if (!activeBotState.presenceMode) {
      activeBotState.presenceMode = 'coach';
      didUpdatePresenceMode = true;
      updatePendingTranscriptPresenceMode(activeBotState.botId, 'coach');
    }
    // Record coach start time for countdown calculation (imported from liveCoachService)
    setCoachStartTime(activeBotState.botId);
    log.info({ 
      botId: activeBotState.botId, 
      coachSkillPath: trimmedSkillPath,
      companionSessionId: trimmedSessionId,
    }, 'Set live coach for active bot');
  }

  if (didUpdatePresenceMode) {
    broadcastBotStatus(null);
  }
  
  return true;
}

/**
 * Set active participation presence mode for the active bot.
 */
export function setPresenceMode(mode: PresenceMode): boolean {
  if (!activeBotState) {
    log.warn({ mode }, 'Cannot set presence mode - no active bot');
    return false;
  }

  if (mode === 'participant' && !activeBotState.coachSkillPath) {
    log.warn({ botId: activeBotState.botId, mode }, 'Cannot set participant mode without an active coach');
    return false;
  }

  const previousMode = activeBotState.presenceMode;
  activeBotState.presenceMode = mode;
  updatePendingTranscriptPresenceMode(activeBotState.botId, mode);

  // Clear proactive pending response when leaving participant mode
  if (previousMode === 'participant' && mode !== 'participant') {
    clearProactivePending(activeBotState.botId);
  }

  broadcastBotStatus(null);

  log.info({ botId: activeBotState.botId, mode, previousMode }, 'Updated presence mode for active bot');
  return true;
}

interface RelayCallbackLogMessages {
  connected: string;
  disconnected: string;
  avatarConnected: string;
  avatarDisconnected: string;
  error: string;
}

const DEFAULT_RELAY_CALLBACK_LOG_MESSAGES: RelayCallbackLogMessages = {
  connected: 'Connected to relay',
  disconnected: 'Disconnected from relay',
  avatarConnected: 'Avatar connected to relay',
  avatarDisconnected: 'Avatar disconnected from relay',
  error: 'Relay error',
};

const RECONNECT_RELAY_CALLBACK_LOG_MESSAGES: RelayCallbackLogMessages = {
  connected: 'Relay reconnected after restart',
  disconnected: 'Relay disconnected',
  avatarConnected: 'Avatar reconnected after restart',
  avatarDisconnected: 'Avatar disconnected',
  error: 'Relay error after reconnection',
};

function createRelayCallbacks(
  botId: string,
  ownerName: string,
  logMessages: RelayCallbackLogMessages = DEFAULT_RELAY_CALLBACK_LOG_MESSAGES,
): RelayClientCallbacks {
  return {
    onConnected: (id, peers) => {
      log.info({ botId: id, connectedPeers: peers }, logMessages.connected);
    },
    onDisconnected: (reason, code, willReconnect) => {
      log.info({ botId, reason, code, willReconnect }, logMessages.disconnected);
      const isActiveRelayBot = activeBotState?.botId === botId;
      if (isActiveRelayBot && activeBotState) {
        activeBotState.avatarConnected = false;
        broadcastBotStatus(null);
      }
      if (!willReconnect) {
        if (isActiveRelayBot && activeBotState) {
          let didPersistConversationState = false;

          try {
            const finalConversationState = stopStateTracking(botId);
            if (finalConversationState) {
              updatePendingTranscriptConversationState(
                botId,
                JSON.stringify(finalConversationState)
              );
            }
            didPersistConversationState = true;
          } catch (error) {
            log.warn({ botId, error }, 'Failed to persist conversation state after permanent relay disconnect');
          }

          try {
            resetBotCoachState(botId);
          } catch (error) {
            log.warn({ botId, error }, 'Failed to reset coach state after permanent relay disconnect');
          }

          try {
            if (didPersistConversationState) {
              activeBotState.conversationStatePersistedAtDisconnect = true;
            }
          } catch (error) {
            log.warn({ botId, error }, 'Failed to set conversation-state disconnect persistence flag');
          }

          log.info({ botId }, 'Cleaned up coaching/tracking state after permanent relay disconnect');
        }

        try {
          fireAndForget(stopBotQA(botId), 'meetingBot.meetingBotService.line1318');
        } catch (error) {
          log.warn({ botId, error }, 'Failed to stop bot Q&A after permanent relay disconnect');
        }
      }
    },
    onAvatarConnected: () => {
      fireAndForget((async () => {
      log.info({ botId, activeBotId: activeBotState?.botId, match: activeBotState?.botId === botId }, logMessages.avatarConnected);
      if (activeBotState?.botId === botId) {
        activeBotState.avatarConnected = true;
        broadcastBotStatus(null);

        // Guard: only announce once per bot session (prevents re-announcing on WebSocket reconnect)
        if (activeBotState?.hasAnnounced) {
          log.debug({ botId }, 'Skipping announcement - already announced this session');
          return;
        }

        // Set flag BEFORE awaiting to prevent race condition with rapid reconnects
        activeBotState.hasAnnounced = true;

        // Speak join announcement now that avatar is ready
        try {
          log.info({ botId, ownerName }, 'Speaking join announcement');
          await announceJoin(botId, ownerName);
          log.info({ botId }, 'Join announcement completed');
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          const errStack = err instanceof Error ? err.stack : undefined;
          log.warn({ botId, error: errMsg, stack: errStack }, 'Failed to announce join');
        }
      } else {
        log.warn({ botId, activeBotId: activeBotState?.botId }, 'Skipping join announcement - bot ID mismatch');
      }
      })(), 'meetingBot.avatarConnected');
    },
    onAvatarDisconnected: () => {
      log.info({ botId }, logMessages.avatarDisconnected);
      if (activeBotState?.botId === botId) {
        activeBotState.avatarConnected = false;
        broadcastBotStatus(null);
      }
    },
    onTranscript: (segments) => {
      log.debug({ botId, segmentCount: (segments as unknown[]).length }, 'Received transcript from avatar');
      // Update caption activity tracking
      if (activeBotState?.botId === botId) {
        const wasActive = computeCaptionsActive(activeBotState) === true;
        activeBotState.lastCaptionReceivedAt = Date.now();
        activeBotState.hasReceivedCaption = true;
        // Broadcast immediately on caption start/resume so UI shows green without waiting for poll
        if (!wasActive && activeBotState.uiState === 'recording') {
          broadcastBotStatus(null);
        }
        // Reset stale timer — will trigger broadcast if no new captions arrive
        if (captionStaleTimer) clearTimeout(captionStaleTimer);
        captionStaleTimer = setTimeout(() => {
          if (activeBotState?.botId === botId && activeBotState.uiState === 'recording') {
            broadcastBotStatus(null);
          }
        }, CAPTION_STALE_THRESHOLD_MS + 1000);
      }
      // Process transcript for voice triggers and accumulation
      for (const segment of segments as Array<{ speaker?: string; text?: string; isFinal?: boolean }>) {
        log.debug({ botId, speaker: segment.speaker, text: segment.text, isFinal: segment.isFinal }, 'Processing transcript segment');
        if (segment.speaker && segment.text) {
          processTranscriptSegment(botId, segment.speaker, segment.text, segment.isFinal ?? true);
        }
      }
    },
    onTranscriptBuffer: (segments) => {
      // Buffer replay from DO: desktop connected mid-meeting, replaying buffered segments.
      // Convert to LiveTranscriptSegment format and populate Q&A buffers without side effects.
      const typed = segments as Array<{ speaker?: string; text?: string; timestamp?: number; isFinal?: boolean }>;
      const liveSegments = typed
        .filter((s): s is { speaker: string; text: string; timestamp: number; isFinal?: boolean } =>
          !!s.speaker && !!s.text && typeof s.timestamp === 'number'
        )
        .map(s => ({
          speaker: s.speaker,
          text: s.text,
          timestamp: s.timestamp,
          wordCount: s.text.split(/\s+/).filter(Boolean).length,
        }));

      if (liveSegments.length === 0) {
        log.debug({ botId }, 'Transcript buffer empty or invalid, skipping replay');
        return;
      }

      log.info({ botId, segmentCount: liveSegments.length }, 'Replaying transcript buffer from DO');
      // rehydrateTranscriptBuffer populates transcriptBuffer + persistenceBuffer
      // WITHOUT triggering Q&A, voice stops, or coaching logic
      rehydrateTranscriptBuffer(botId, liveSegments, '');
    },
    onError: (error) => {
      log.warn({ botId, error }, logMessages.error);
    },
  };
}

/**
 * Create relay callbacks for collaborator (viewer) connections.
 * Receives transcript segments but does NOT control avatar or announce.
 */
function createCollaboratorRelayCallbacks(botId: string): RelayClientCallbacks {
  return {
    onConnected: (id, peers) => {
      log.info({ botId: id, connectedPeers: peers }, 'Collaborator connected to relay as viewer');
    },
    onDisconnected: (reason, code, willReconnect) => {
      log.info({ botId, reason, code, willReconnect }, 'Collaborator relay disconnected');
      if (!willReconnect) {
        fireAndForget(stopBotQA(botId), 'meetingBot.meetingBotService.line1432');
      }
    },
    onAvatarConnected: () => {
      // Collaborators don't announce join or control avatar
      log.debug({ botId }, 'Collaborator: avatar connected (no action)');
    },
    onAvatarDisconnected: () => {
      log.debug({ botId }, 'Collaborator: avatar disconnected (no action)');
    },
    onTranscript: (segments) => {
      // Process through buffer-only Q&A (no triggers, no voice detection)
      for (const segment of segments as Array<{ speaker?: string; text?: string; isFinal?: boolean }>) {
        if (segment.speaker && segment.text) {
          processTranscriptSegment(botId, segment.speaker, segment.text, segment.isFinal ?? true);
        }
      }
    },
    onTranscriptBuffer: (segments) => {
      const typed = segments as Array<{ speaker?: string; text?: string; timestamp?: number; isFinal?: boolean }>;
      const liveSegments = typed
        .filter((s): s is { speaker: string; text: string; timestamp: number; isFinal?: boolean } =>
          !!s.speaker && !!s.text && typeof s.timestamp === 'number'
        )
        .map(s => ({
          speaker: s.speaker,
          text: s.text,
          timestamp: s.timestamp,
          wordCount: s.text.split(/\s+/).filter(Boolean).length,
        }));
      if (liveSegments.length > 0) {
        rehydrateTranscriptBuffer(botId, liveSegments, '');
      }
    },
    onError: (error) => {
      log.warn({ botId, error }, 'Collaborator relay error');
    },
  };
}

/**
 * Attempt to reconnect relay WebSocket after app restart.
 * Fetches fresh credentials from worker and re-establishes connection.
 * Fire-and-forget - failures are logged but don't affect core functionality.
 */
async function reconnectRelayForBot(botId: string, clientSecret: string, expectedRelayBotId?: string): Promise<void> {
  try {
    log.info({ botId, expectedRelayBotId }, 'Attempting relay reconnection after restart');
    
    // Fetch fresh relay credentials from worker
    const response = await backendFetch(
      `/api/bot/status?botId=${botId}&includeRelay=true`,
      {},
      clientSecret
    );
    
    if (!response.ok) {
      log.warn({ botId, status: response.status }, 'Failed to fetch relay credentials for reconnection');
      return;
    }
    
    const data = await response.json() as { 
      success: boolean;
      relayUrl?: string;
      relayBotId?: string;
      sessionToken?: string;
      isOwner?: boolean;
    };
    
    if (!data.relayUrl || !data.sessionToken) {
      log.warn({ botId, hasRelayUrl: !!data.relayUrl, hasToken: !!data.sessionToken }, 'Worker did not return relay credentials');
      return;
    }
    
    // Validate returned relayBotId matches expected (prevents connecting to wrong relay in multi-bot scenarios)
    const returnedRelayBotId = data.relayBotId || data.relayUrl.match(/\/relay\/([^/]+)$/)?.[1];
    if (expectedRelayBotId && returnedRelayBotId && returnedRelayBotId !== expectedRelayBotId) {
      log.warn({ botId, expected: expectedRelayBotId, returned: returnedRelayBotId }, 'Relay credentials mismatch - aborting reconnection');
      return;
    }
    
    // Guard: verify bot is still active (may have completed during fetch)
    if (!activeBotState || activeBotState.botId !== botId) {
      log.debug({ botId, activeBotId: activeBotState?.botId }, 'Bot no longer active, skipping relay reconnection');
      return;
    }
    
    // Update activeBotState with credentials
    activeBotState.sessionToken = data.sessionToken;
    activeBotState.relayUrl = data.relayUrl;
    
    // Get settings for Q&A service
    const settings = getSettings();
    const ownerName = resolveOwnerName();
    const triggerPhrase = settings?.meetingBot?.triggerPhrase ?? null;
    const respondViaVoice = settings?.meetingBot?.respondViaVoice ?? true;
    
    // Start Q&A service (only if we're the owner)
    if (data.isOwner !== false) {
      try {
        startBotQA(botId, ownerName, triggerPhrase, respondViaVoice);
        log.info({ botId }, 'Q&A service restarted after relay reconnection');

        // Rehydrate transcript buffer from the live transcript file on disk
        const pending = getPendingTranscript(botId);
        if (pending?.liveTranscriptPath) {
          const parsed = await parseLiveTranscriptSegments(pending.liveTranscriptPath);
          if (parsed.success && parsed.segments.length > 0) {
            rehydrateTranscriptBuffer(botId, parsed.segments, pending.liveTranscriptPath);
          }
        }
      } catch (qaError) {
        log.warn({ botId, error: qaError }, 'Failed to restart Q&A service');
      }
    }
    
    // Final guard before connecting (race condition mitigation)
    if (!activeBotState || activeBotState.botId !== botId) {
      log.debug({ botId }, 'Bot completed during Q&A setup, aborting relay connection');
      return;
    }
    
    // Connect to relay (wrapped to handle errors and clean up state)
    try {
      connectToRelay(
        botId,
        data.sessionToken,
        data.relayUrl,
        createRelayCallbacks(botId, ownerName, RECONNECT_RELAY_CALLBACK_LOG_MESSAGES),
      );
      log.info({ botId, relayUrl: data.relayUrl }, 'Relay reconnection initiated');

      // Persist relayBotId for future restart recovery (self-healing for bots missing it)
      if (returnedRelayBotId) {
        updateRelayBotId(botId, returnedRelayBotId);
      }
    } catch (connectError) {
      log.warn({ botId, error: connectError }, 'Failed to establish relay connection');
      // Clear credentials on failure to avoid inconsistent state
      if (activeBotState?.botId === botId) {
        activeBotState.sessionToken = undefined;
        activeBotState.relayUrl = undefined;
      }
    }
  } catch (error) {
    log.warn({ botId, error }, 'Failed to reconnect relay after restart');
  }
}

/**
 * Reconnect relay for collaborator after app restart.
 * Like reconnectRelayForBot but: no activeBotState, buffer-only Q&A, viewer callbacks.
 */
async function reconnectRelayForCollaborator(botId: string, clientSecret: string, expectedRelayBotId?: string): Promise<void> {
  try {
    log.info({ botId, expectedRelayBotId }, 'Attempting collaborator relay reconnection after restart');
    
    const response = await backendFetch(
      `/api/bot/status?botId=${botId}&includeRelay=true`,
      {},
      clientSecret
    );
    
    if (!response.ok) {
      log.warn({ botId, status: response.status }, 'Failed to fetch relay credentials for collaborator reconnection');
      return;
    }
    
    const data = await response.json() as { 
      success: boolean;
      relayUrl?: string;
      relayBotId?: string;
      sessionToken?: string;
      isOwner?: boolean;
    };
    
    if (!data.relayUrl || !data.sessionToken) {
      log.warn({ botId }, 'Worker did not return relay credentials for collaborator');
      return;
    }
    
    // Guard: if we're actually the owner now (ownership transferred), skip collaborator path
    if (data.isOwner !== false) {
      log.info({ botId }, 'Ownership changed — skipping collaborator relay reconnection');
      return;
    }
    
    // Guard: verify bot is still a collaborator (may have been cleaned up)
    if (activeCollaboratorBotId !== botId) {
      log.debug({ botId, activeCollaboratorBotId }, 'Collaborator no longer active, skipping relay');
      return;
    }
    
    const ownerName = resolveOwnerName();
    startLocalTranscriptBuffer(botId, ownerName, { outputMode: 'silent' });
    
    connectToRelay(
      botId,
      data.sessionToken,
      data.relayUrl,
      createCollaboratorRelayCallbacks(botId),
    );
    
    log.info({ botId, relayUrl: data.relayUrl }, 'Collaborator relay reconnection initiated');
  } catch (error) {
    log.warn({ botId, error }, 'Failed to reconnect collaborator relay');
  }
}

/** Max consecutive 400 errors before removing a stale transcript */
const MAX_CONSECUTIVE_ERRORS = 3;

/**
 * Status priority for survivor selection: higher = more valuable to keep.
 * in_meeting (actively recording) > processing (post-call) > scheduled (waiting).
 */
const STATUS_PRIORITY: Record<string, number> = {
  in_meeting: 3,
  processing: 2,
  scheduled: 1,
};

/**
 * Check whether a bot has evidence of real meeting activity (recording,
 * saved transcript, live transcript). These should never be cancelled —
 * they are legitimate post-call bots, not duplicates from the scheduling bug.
 */
function hasRealActivity(t: PendingTranscript): boolean {
  return !!(t.savedPath || t.stagedForReview || t.recordingId || t.liveTranscriptPath || t.recordingStartTimeMs);
}

/**
 * Detect and cancel duplicate bots for the same meeting on startup.
 *
 * Groups scheduled/in_meeting/processing bots by meeting URL + time window.
 * For each group with >1 bot, keeps the best candidate (preferring active
 * or recording bots) and cancels the rest on Recall (best-effort), then
 * removes them from the local store.
 *
 * Bots with real activity evidence (savedPath, recordingId, liveTranscriptPath)
 * are never cancelled — they are legitimate, not duplicates.
 *
 * This handles the case where a dedup bug created multiple Recall bots for
 * the same meeting — without cleanup they would ALL join the call.
 */
export async function cleanupDuplicateBots(): Promise<number> {
  const transcripts = getPendingTranscripts();
  const activeBots = transcripts.filter(
    t => t.status === 'scheduled' || t.status === 'in_meeting' || t.status === 'processing'
  );

  if (activeBots.length <= 1) return 0;

  // Group bots that refer to the same meeting (URL match + time window)
  const groups: PendingTranscript[][] = [];
  const assigned = new Set<string>();

  for (const bot of activeBots) {
    if (assigned.has(bot.botId)) continue;

    const group = [bot];
    assigned.add(bot.botId);

    for (const other of activeBots) {
      if (assigned.has(other.botId)) continue;
      if (
        urlsMatchSameMeeting(bot.meetingUrl, other.meetingUrl) &&
        isWithinDedupWindow(bot.scheduledAt, other.scheduledAt)
      ) {
        group.push(other);
        assigned.add(other.botId);
      }
    }

    if (group.length > 1) {
      groups.push(group);
    }
  }

  if (groups.length === 0) return 0;

  // Determine the currently active bot so we never cancel it
  const activeBotId = activeBotState?.botId;

  let cancelledCount = 0;

  for (const group of groups) {
    // Sort: highest-priority status first, then newest createdAt as tiebreaker.
    // This ensures an in_meeting bot is kept over a scheduled duplicate.
    group.sort((a, b) => {
      const statusDiff = (STATUS_PRIORITY[b.status] ?? 0) - (STATUS_PRIORITY[a.status] ?? 0);
      if (statusDiff !== 0) return statusDiff;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
    const [keep, ...duplicates] = group;

    log.info({
      keepBotId: keep.botId,
      keepStatus: keep.status,
      meetingUrl: keep.meetingUrl,
      meetingTitle: keep.meetingTitle,
      duplicateCount: duplicates.length,
      duplicateBotIds: duplicates.map(d => d.botId),
    }, 'Startup dedup: cancelling duplicate bots for same meeting');

    for (const dup of duplicates) {
      // Never cancel the currently active bot (UI would go stale)
      if (dup.botId === activeBotId) {
        log.info({ botId: dup.botId }, 'Startup dedup: skipping active bot');
        continue;
      }

      // Never cancel bots with evidence of real meeting activity
      if (hasRealActivity(dup)) {
        log.info({ botId: dup.botId, status: dup.status }, 'Startup dedup: skipping bot with real activity');
        continue;
      }

      // Best-effort cancel on Recall — don't let failures block cleanup
      try {
        const response = await backendFetch('/api/bot/cancel', {
          method: 'POST',
          body: JSON.stringify({
            botId: dup.botId,
            clientSecret: dup.clientSecret,
          }),
        });
        if (response.ok || response.status === 404) {
          log.info({ botId: dup.botId }, 'Startup dedup: cancelled duplicate bot on backend');
        } else {
          log.warn({ botId: dup.botId, status: response.status }, 'Startup dedup: backend cancel returned non-ok (removing locally anyway)');
        }
      } catch (err) {
        log.warn({ botId: dup.botId, error: err }, 'Startup dedup: failed to cancel on backend (removing locally anyway)');
      }

      // Always remove locally — even if backend cancel fails, having the duplicate
      // in the local store would just cause it to be re-activated on meeting detection
      removePendingTranscript(dup.botId);
      cancelledCount++;
    }
  }

  log.info({ cancelledCount }, 'Startup dedup cleanup complete');
  return cancelledCount;
}

/**
 * Check pending transcripts and update their status.
 */
async function checkPendingTranscripts(service: MeetingBotService): Promise<void> {
  if (isCheckingPendingTranscripts) return;
  isCheckingPendingTranscripts = true;

  try {
    await checkPendingTranscriptsInner(service);
  } finally {
    isCheckingPendingTranscripts = false;
    // Always manage imminent-bot polling, even after early returns or errors
    manageImminentBotPolling(service);
  }
}

async function pollTranscriptStatuses(
  service: MeetingBotService,
  transcripts: PendingTranscript[],
): Promise<{ abortCycle: boolean }> {
  log.info({
    count: transcripts.length,
    transcripts: transcripts.map(t => ({
      botId: t.botId,
      status: t.status,
      hasClientSecret: !!t.clientSecret,
      consecutiveErrors: t.consecutiveErrors ?? 0,
    })),
  }, 'Background polling: checking pending transcripts');

  for (const transcript of transcripts) {
    try {
      // Use clientSecret header for authenticated status polling (required for multi-user dedup)
      const response = await backendFetch(
        `/api/bot/status?botId=${transcript.botId}`,
        {},
        transcript.clientSecret
      );

      if (!response.ok) {
        // Handle 401/402 - global authentication/billing issue with Recall API
        // This affects ALL bots, not just this one - don't mark individual bots as failed
        if (response.status === 401 || response.status === 402) {
          log.error(
            { status: response.status },
            'Recall API authentication/billing issue detected - skipping all transcript checks this cycle'
          );
          // Return early - no point checking other bots, they'll all fail the same way
          return { abortCycle: true };
        }

        // Handle 403 - bot deleted/expired on Recall side
        // Now visible after worker fix to pass through actual status codes
        if (response.status === 403) {
          const errorCount = incrementConsecutiveErrors(transcript.botId);
          if (errorCount >= MAX_CONSECUTIVE_ERRORS) {
            log.info(
              { botId: transcript.botId, errorCount, status: transcript.status },
              'Marking bot as failed after consecutive 403 errors (expired on Recall side)'
            );
            // Mark as failed with reason instead of removing (preserves forensic info)
            updatePendingTranscriptStatus(transcript.botId, 'failed', 'Bot expired on Recall (403)');
            continue;
          }
          log.warn(
            { botId: transcript.botId, status: response.status, errorCount },
            'Bot returned 403 - likely expired/deleted on Recall side'
          );
          continue;
        }

        // Handle 404 - bot not found on worker
        // Note: 400 means "missing clientSecret" NOT "bot not found" - don't fail on 400
        if (response.status === 404) {
          const errorCount = incrementConsecutiveErrors(transcript.botId);
          if (errorCount >= MAX_CONSECUTIVE_ERRORS) {
            log.info(
              { botId: transcript.botId, errorCount, status: transcript.status },
              'Marking bot as failed after consecutive 404 errors (not found)'
            );
            // Mark as failed instead of removing (preserves forensic info)
            updatePendingTranscriptStatus(transcript.botId, 'failed', 'Bot not found (404)');
            continue;
          }
          log.warn(
            { botId: transcript.botId, status: response.status, errorCount },
            'Bot returned 404 - may be expired'
          );
          continue;
        }

        // Other errors (500, 429, etc.) - log but don't increment error count
        // These are likely transient and will be retried
        log.warn({ botId: transcript.botId, status: response.status }, 'Failed to get bot status (transient)');
        continue;
      }

      // Successful response - reset error count
      resetConsecutiveErrors(transcript.botId);

      const data = await response.json() as { success: boolean; status?: string; sub_code?: string };

      if (data.success && data.status) {
        const newStatus = mapRecallStatus(data.status);

        // Cross-check relay before trusting a fatal status from Recall.
        // If the relay is still connected, the bot is likely in the meeting
        // and Recall's status is spurious — skip the downgrade.
        if (newStatus === 'failed') {
          const relayClient = getRelayClient(transcript.botId);
          const terminalFatalSubCode = isTerminalFatalSubCode(data.sub_code);
          if (relayClient?.connected && !terminalFatalSubCode) {
            log.warn({
              botId: transcript.botId,
              recallStatus: data.status,
              subCode: data.sub_code,
              currentStatus: transcript.status,
              relayConnected: true,
            }, 'Background poller: Recall reported fatal but relay is connected and sub-code is not terminal — skipping status downgrade');
            continue;
          }
          if (terminalFatalSubCode) {
            log.warn({
              botId: transcript.botId,
              recallStatus: data.status,
              subCode: data.sub_code,
              currentStatus: transcript.status,
              relayConnected: relayClient?.connected ?? false,
            }, 'Background poller: terminal fatal sub-code detected — applying status downgrade');
          }
        }

        if (newStatus !== transcript.status) {
          const previousStatus = transcript.status;
          updatePendingTranscriptStatus(transcript.botId, newStatus);
          log.info({ botId: transcript.botId, oldStatus: previousStatus, newStatus }, 'Transcript status updated');

          // Cloud-side activation: when a pre-scheduled bot transitions to
          // in_meeting and no bot is currently active, activate it for
          // real-time features (relay, live transcript, coach, companion UI).
          // This ensures real-time features work even when the Desktop SDK
          // fails to detect the meeting window (e.g. Teams on macOS).
          // activatePreScheduledBot() is idempotent — safe if Desktop SDK
          // also fires and activates the same bot.
          if (previousStatus === 'scheduled' && newStatus === 'in_meeting' && !activeBotState && !transcript.isCollaborator) {
            log.info(
              { botId: transcript.botId, meetingTitle: transcript.meetingTitle },
              'Cloud-side activation: scheduled bot joined meeting, activating for real-time features'
            );
            service.activatePreScheduledBot(transcript.botId);
          }

          // Clean up collaborator relay when meeting ends
          if (transcript.isCollaborator === true && previousStatus === 'in_meeting' && newStatus !== 'in_meeting') {
            cleanupCollaboratorState(transcript.botId);
            log.info({ botId: transcript.botId, newStatus }, 'Collaborator meeting ended — cleaned up relay and buffer');
          }

          if (newStatus === 'ready') {
            notifyTranscriptReady(transcript.botId, transcript.meetingTitle ?? 'Meeting');
            // Automatically process and save the transcript
            fireAndForget(service.processAndSaveTranscript(transcript.botId).then(result => {
              if (result.success) {
                log.info({ botId: transcript.botId, filePath: result.filePath }, 'Transcript auto-saved');
              } else {
                log.warn({ botId: transcript.botId, error: result.error }, 'Failed to auto-save transcript');
              }
            }), 'meetingBot.meetingBotService.line1940');
          }
        }
      }
    } catch (error) {
      log.warn({ botId: transcript.botId, error }, 'Failed to check transcript status');
    }
  }

  return { abortCycle: false };
}

/** Max transcript saves to run in parallel during a retry fan-out. */
const MAX_TRANSCRIPT_RETRY_CONCURRENCY = 3;

/**
 * Bucket a retry outcome into a small, stable set of classes for the per-batch
 * summary log. `transient_network` covers the DNS-starvation / "fetch failed"
 * symptom (backoff enforced, attempt NOT burned); `terminal` covers permanent
 * failures (403/404 — the bot expired/was deleted on Recall); everything else
 * non-success falls in `other`. Classified from the publicly-typed `error`
 * string (the `permanent`/`global` flags are implementation-internal, not on the
 * MeetingBotService interface result).
 */
function classifyRetryOutcome(result: { success: boolean; error?: string }):
  'success' | 'transient_network' | 'terminal' | 'other' {
  if (result.success) return 'success';
  const err = (result.error ?? '').toLowerCase();
  if (err.includes('403') || err.includes('404') || err.includes('no longer accessible') || err.includes('not found')) {
    return 'terminal';
  }
  if (err.includes('fetch failed') || err.includes('network') || err.includes('econn') || err.includes('etimedout') || err.includes('enotfound')) {
    return 'transient_network';
  }
  return 'other';
}

function retryUnsavedTranscripts(service: MeetingBotService): void {
  const unsavedTranscripts = getTranscriptsNeedingSave();
  if (unsavedTranscripts.length === 0) {
    return;
  }
  // One-line per-batch summary (Bug B observability): how many transcripts were
  // queued and the concurrency cap that bounds the fan-out. The cap is the storm
  // guard — surfacing it makes a runaway retry batch obvious at 2am.
  log.info(
    { queued: unsavedTranscripts.length, concurrencyCap: MAX_TRANSCRIPT_RETRY_CONCURRENCY },
    'Retry batch started for unsaved transcripts'
  );
  // Bound the fan-out (was unbounded parallel fire-and-forget per transcript,
  // an amplifier under DNS starvation). Still fire-and-forget overall.
  const outcomes = { success: 0, transient_network: 0, terminal: 0, other: 0, unexpected_error: 0 };
  fireAndForget(
    mapWithConcurrencyLimit(unsavedTranscripts, MAX_TRANSCRIPT_RETRY_CONCURRENCY, async (transcript) => {
      try {
        log.info({ botId: transcript.botId, attempts: transcript.saveAttempts }, 'Retrying unsaved transcript');
        const result = await service.processAndSaveTranscript(transcript.botId);
        outcomes[classifyRetryOutcome(result)] += 1;
        if (result.success) {
          // Path-presence boolean only (no raw workspace path in logs), matching
          // the terminal-failed audit posture.
          log.info({ botId: transcript.botId, hasFilePath: Boolean(result.filePath) }, 'Transcript saved on retry');
        } else {
          log.warn({ botId: transcript.botId, error: result.error, attempts: transcript.saveAttempts }, 'Retry save failed');
        }
      } catch (err) {
        // processAndSaveTranscript is designed to resolve (not throw) on failure;
        // guard anyway so one unexpected throw can't reject the whole batch and
        // suppress the summary below.
        outcomes.unexpected_error += 1;
        log.error({ botId: transcript.botId, err }, 'Unexpected error retrying transcript');
      }
    }).finally(() => {
      // Outcome-by-class summary — `.finally` so the tally is logged even if the
      // limiter itself rejects.
      log.info(
        { queued: unsavedTranscripts.length, ...outcomes },
        'Retry batch finished'
      );
    }),
    'meetingBot.meetingBotService.line1962',
  );
}

function triggerScheduledAnalysis(): void {
  const needingAnalysis = getTranscriptsNeedingAnalysis();
  if (needingAnalysis.length > 0) {
    log.info({ count: needingAnalysis.length }, 'Triggering scheduled transcript analysis');
    for (const transcript of needingAnalysis) {
      if (!transcript.savedPath) {
        continue;
      }

      void triggerMeetingAnalysis(
        transcript.botId,
        transcript.savedPath,
        undefined,
        { conversationState: transcript.conversationState },
      ).catch((err) => {
        log.warn({ botId: transcript.botId, error: err }, 'Scheduled analysis trigger failed');
      });
    }
  }
}

function catchAllActivation(service: MeetingBotService): void {
  // Catch-all activation: if no bot is currently active but one is in_meeting,
  // activate it. This handles two cases the transition check misses:
  // 1. App started while bot was already in_meeting (no scheduled->in_meeting transition)
  // 2. Previous active bot completed while another bot is still in_meeting (handoff)
  // Collaborator bots are excluded — they must not be activated as owner bots.
  if (!activeBotState) {
    const inMeetingBots = getPendingTranscripts().filter(t => t.status === 'in_meeting' && !t.isCollaborator);
    if (inMeetingBots.length === 1) {
      log.info(
        { botId: inMeetingBots[0].botId, meetingTitle: inMeetingBots[0].meetingTitle },
        'Catch-all activation: bot in_meeting with no active bot, activating'
      );
      service.activatePreScheduledBot(inMeetingBots[0].botId);
    }
  }
}

function markExhaustedTranscripts(): void {
  // Mark any transcripts that have exhausted retries as failed (for forensics)
  const exhaustedCount = markExhaustedTranscriptsAsFailed();
  if (exhaustedCount > 0) {
    log.info({ count: exhaustedCount }, 'Marked exhausted transcripts as failed');
  }
}

function logTranscriptStoreHealth(): void {
  // Log transcript store health for observability
  const allTranscripts = getPendingTranscripts();
  if (allTranscripts.length > 0) {
    const stats = {
      total: allTranscripts.length,
      pending: allTranscripts.filter(t => ['scheduled', 'in_meeting', 'processing'].includes(t.status)).length,
      ready: allTranscripts.filter(t => t.status === 'ready' && !t.savedPath).length,
      saved: allTranscripts.filter(t => !!t.savedPath).length,
      failed: allTranscripts.filter(t => t.status === 'failed').length,
      withErrors: allTranscripts.filter(t => (t.consecutiveErrors ?? 0) > 0).length,
    };
    log.info(stats, 'Transcript store health');
  }
}

async function checkPendingTranscriptsInner(service: MeetingBotService): Promise<void> {
  const transcripts = getTranscriptsNeedingCheck();

  if (transcripts.length > 0) {
    const { abortCycle } = await pollTranscriptStatuses(service, transcripts);
    // ORDER CONSTRAINT: 401/402 auth failures must abort this cycle before housekeeping phases
    if (abortCycle) {
      return;
    }
  }

  cleanupExpiredTranscripts();
  retryUnsavedTranscripts(service);
  await checkAsyncUpgrades();
  triggerScheduledAnalysis();
  catchAllActivation(service);
  markExhaustedTranscripts();
  logTranscriptStoreHealth();
}

/**
 * Lightweight status-only poll for scheduled bots near their start time.
 * Only checks bot statuses and triggers cloud-side activation — skips
 * housekeeping (save retries, async upgrades, analysis, health logging)
 * to keep the 30-second imminent polling cycle cheap.
 */
async function pollImminentBotStatuses(service: MeetingBotService): Promise<void> {
  const transcripts = getTranscriptsNeedingCheck().filter(t => t.status === 'scheduled');
  if (transcripts.length === 0) return;

  for (const transcript of transcripts) {
    try {
      const response = await backendFetch(
        `/api/bot/status?botId=${transcript.botId}`,
        {},
        transcript.clientSecret
      );
      if (!response.ok) continue;

      resetConsecutiveErrors(transcript.botId);
      const data = await response.json() as { success: boolean; status?: string };
      if (!data.success || !data.status) continue;

      const newStatus = mapRecallStatus(data.status);
      if (newStatus !== transcript.status) {
        const previousStatus = transcript.status;
        updatePendingTranscriptStatus(transcript.botId, newStatus);
        log.info({ botId: transcript.botId, oldStatus: previousStatus, newStatus }, 'Imminent bot status updated');

        if (previousStatus === 'scheduled' && newStatus === 'in_meeting' && !activeBotState && !transcript.isCollaborator) {
          log.info(
            { botId: transcript.botId, meetingTitle: transcript.meetingTitle },
            'Cloud-side activation: scheduled bot joined meeting, activating for real-time features'
          );
          service.activatePreScheduledBot(transcript.botId);
        }
      }
    } catch (error) {
      log.warn({ botId: transcript.botId, error }, 'Failed to check imminent bot status');
    }
  }
}

/**
 * Check if any scheduled bots are near their start time and need faster polling.
 * When a scheduled bot is within IMMINENT_BOT_LOOKAHEAD_MS of its start time,
 * starts a faster polling cycle to catch the scheduled->in_meeting transition
 * promptly for cloud-side activation.
 */
function manageImminentBotPolling(service: MeetingBotService): void {
  const transcripts = getPendingTranscripts();
  const now = Date.now();

  const hasImminentBot = transcripts.some(t => {
    if (t.status !== 'scheduled') return false;
    const scheduledMs = new Date(t.scheduledAt).getTime();
    if (isNaN(scheduledMs)) return false;
    return scheduledMs - now <= IMMINENT_BOT_LOOKAHEAD_MS && scheduledMs + POLL_INTERVAL_MS > now;
  });

  if (hasImminentBot && !imminentBotPollInterval && !activeBotState) {
    log.info('Starting imminent-bot fast polling (scheduled bot near start time)');
    imminentBotPollInterval = setInterval(() => {
      if (activeBotState) {
        stopImminentBotPolling();
        return;
      }
      fireAndForget(pollImminentBotStatuses(service), 'meetingBot.meetingBotService.line2122');
    }, IMMINENT_BOT_POLL_INTERVAL_MS);
  } else if (!hasImminentBot && imminentBotPollInterval) {
    stopImminentBotPolling();
  }
}

function stopImminentBotPolling(): void {
  if (imminentBotPollInterval) {
    clearInterval(imminentBotPollInterval);
    imminentBotPollInterval = null;
    log.debug('Stopped imminent-bot fast polling');
  }
}

function notifyRecallDistributionReady(filePath: string, sourceUid: string): void {
  notifyDistributionReady(
    {
      filePath,
      sourceSystem: 'recall',
      sourceUid,
    },
    {
      emitTranscriptDistributionReady,
      logger: log,
    },
  );
}

/**
 * Check for async transcript upgrades and apply them.
 * Polls for transcripts that were saved with captions and may have async upgrade available.
 * Also handles timeout cleanup for transcripts stuck in processing too long.
 */
async function checkAsyncUpgrades(): Promise<void> {
  // First, clean up any timed-out transcripts (before checking for work to do)
  const timedOut = getTimedOutAsyncUpgrades();
  for (const transcript of timedOut) {
    updateAsyncUpgradeStatus(transcript.botId, 'timed_out');
    log.warn(
      { botId: transcript.botId, asyncUpgradeStartedAt: transcript.asyncUpgradeStartedAt },
      'Async upgrade timed out after 3 hours - captions transcript still available'
    );

    // Distribute with best available quality even on timeout.
    if (transcript.savedPath) {
      notifyRecallDistributionReady(transcript.savedPath, transcript.botId);
    }
  }

  const transcripts = getTranscriptsNeedingAsyncUpgrade();

  if (transcripts.length === 0) {
    return;
  }

  log.debug({ count: transcripts.length }, 'Checking for async transcript upgrades');

  for (const transcript of transcripts) {
    if (!transcript.savedPath || !transcript.clientSecret) {
      continue;
    }

    try {
      // Fetch transcript to check if async upgrade is available
      const response = await backendFetch(
        `/api/transcript?botId=${transcript.botId}`,
        {},
        transcript.clientSecret
      );
      
      if (!response.ok) {
        log.warn({ botId: transcript.botId, status: response.status }, 'Failed to check async upgrade');
        continue;
      }

      const data = await response.json() as {
        success: boolean;
        transcript?: string;
        transcriptQuality?: TranscriptQuality;
        asyncUpgradeAvailable?: boolean;
        error?: string;
      };

      if (!data.success) {
        log.warn({ botId: transcript.botId, error: data.error }, 'Async upgrade check failed');
        continue;
      }

      // Check if we got the async transcript
      if (data.transcriptQuality === 'recallai_async' && data.transcript) {
        log.info({ botId: transcript.botId }, 'Async transcript available, upgrading file');

        // Attempt LLM cleanup of async transcript before writing upgraded markdown.
        let transcriptToSave = data.transcript;
        let extraFrontmatter: Record<string, unknown> | undefined;
        const cleaned = await cleanTranscriptText(data.transcript, { botId: transcript.botId });
        if (cleaned) {
          transcriptToSave = cleaned;
          extraFrontmatter = { transcript_cleanup: true };
          log.info({ botId: transcript.botId }, 'Transcript cleaned via LLM before upgrade');
        }

        // Upgrade the file with the new transcript
        const upgradeResult = await upgradeTranscriptQuality(
          transcript.savedPath,
          transcriptToSave,
          'recallai_async',
          extraFrontmatter
        );

        if (upgradeResult.success) {
          // Mark as complete
          updateTranscriptQuality(transcript.botId, 'recallai_async');
          updateAsyncUpgradeStatus(transcript.botId, 'complete');
          log.info({ botId: transcript.botId, filePath: transcript.savedPath }, 'Transcript upgraded to async quality');

          // Transcript is now at final quality — trigger distribution to spaces.
          notifyRecallDistributionReady(transcript.savedPath, transcript.botId);
        } else {
          log.warn({ botId: transcript.botId, error: upgradeResult.error }, 'Failed to upgrade transcript file');
          updateAsyncUpgradeStatus(transcript.botId, 'failed');

          // Distribute with best available quality even on upgrade failure.
          notifyRecallDistributionReady(transcript.savedPath, transcript.botId);
        }
      } else if (data.asyncUpgradeAvailable) {
        // Async is ready but we got captions - try again next poll (server returns best available)
        updateAsyncUpgradeStatus(transcript.botId, 'ready');
        log.debug({ botId: transcript.botId }, 'Async upgrade ready but not returned yet');
      } else {
        // Still processing
        updateAsyncUpgradeStatus(transcript.botId, 'processing');
        log.debug({ botId: transcript.botId }, 'Async transcription still processing');
      }
    } catch (error) {
      log.warn({ botId: transcript.botId, error }, 'Failed to check async transcript upgrade');
    }
  }
}

/**
 * Create the meeting bot service.
 */
/**
 * Internal implementation of sendBot with actual dispatch logic.
 * Extracted as a standalone function to support the coalescing wrapper pattern.
 */
const RETRY_DELAY_MS = 30_000;

async function doSendBot(params: Parameters<MeetingBotService['sendBot']>[0], retryCount = 0): Promise<SendBotResult> {
  const { meetingUrl, meetingTitle, avatarId, scheduledFor, calendarEventId, calendarSource, forceJoin } = params;

      // Mutual exclusion: don't send bot while local recording is capturing
      // (Upload states don't block - only active audio capture)
      if (isLocalRecordingCapturing()) {
        log.warn('Cannot send bot: local recording is capturing');
        return { success: false, error: 'Local recording is active. Stop it first to send a cloud bot.' };
      }

      // Deduplication: check if bot already scheduled for this meeting
      // Uses URL matching to handle variations in meeting URLs
      const pendingTranscripts = getPendingTranscripts();
      const activeBots = pendingTranscripts.filter(
        t => t.status === 'scheduled' || t.status === 'in_meeting'
      );
      
      // Log dedup check context
      log.info({
        requestUrl: meetingUrl,
        requestTitle: meetingTitle,
        scheduledFor,
        pendingCount: pendingTranscripts.length,
        activeCount: activeBots.length,
        activeBots: activeBots.map(t => ({
          botId: t.botId,
          url: t.meetingUrl,
          status: t.status,
          scheduledAt: t.scheduledAt,
        })),
      }, 'sendBot: checking for existing bot');
      
      const existingBot = activeBots.find(
        t => urlsMatchSameMeeting(t.meetingUrl, meetingUrl)
      );
      if (existingBot && !forceJoin) {
        log.info({
          existingBotId: existingBot.botId,
          existingUrl: existingBot.meetingUrl,
          requestUrl: meetingUrl,
          existingStatus: existingBot.status,
        }, 'Dedup: bot already exists for this meeting, returning existing');
        // Return existing bot instead of creating duplicate
        return { success: true, botId: existingBot.botId };
      }
      
      log.info({ meetingUrl, forceJoin }, 'Dedup: no existing bot found (or forceJoin), will create new');

      // Get user ID for backend identification
      const userId = getUserId();
      if (!userId) {
        log.warn('Cannot send bot: user not authenticated');
        return { success: false, error: 'Not authenticated' };
      }

      // Get settings for avatar selection
      const settings = getSettings();
      const meetingBotSettings = settings.meetingBot ?? {};
      const selectedAvatar = (avatarId as RebelAvatarId) ?? meetingBotSettings.rebelAvatar ?? 'spark';

      // Generate per-bot client secret for secure transcript retrieval
      const clientSecret = generateClientSecret();

      // Get user's display name for personalized bot name
      const authState = getRebelAuthProvider().getAuthState();
      const userName = authState?.user?.name;

      log.info(
        { meetingUrl, meetingTitle, avatar: selectedAvatar, scheduledFor },
        'Sending meeting bot'
      );

      // Skip UI tracking for scheduled (future) bots - they don't need real-time updates
      // until they actually start joining. This allows auto-scheduling multiple bots
      // without overwriting activeBotState for each one.
      const isScheduledBot = !!scheduledFor;

      if (!isScheduledBot) {
        // Clean up stale bot state if it was for a DIFFERENT meeting (e.g., bot stuck
        // in waiting_too_long for Meeting A while we dispatch for Meeting B).
        // Without this, the old bot's relay/Q&A/coach services leak and the renderer
        // can miss the companion creation window for the new meeting.
        if (activeBotState && activeBotState.meetingUrl !== meetingUrl) {
          log.info({
            staleBotId: activeBotState.botId,
            staleMeetingUrl: activeBotState.meetingUrl,
            staleUiState: activeBotState.uiState,
            newMeetingUrl: meetingUrl,
          }, 'Clearing stale bot state before dispatching new bot for different meeting');
          clearActiveBotState();
          broadcastBotCompletion();
        }

        // Set up active bot state for UI tracking (dispatching state)
        const dispatchingQuip = pickRandomQuip(DISPATCHING_QUIPS);
        activeBotState = {
          botId: '', // Will be set after creation
          meetingUrl,
          meetingTitle: meetingTitle ?? 'Meeting',
          uiState: 'dispatching',
          quip: dispatchingQuip,
          // Start timeout clock immediately - covers case where polling fails from start
          // and bot gets stuck in 'dispatching' state
          joiningStartTime: Date.now(),
          clientSecret, // Store for authenticated status polling
        };

        // Broadcast dispatching state immediately
        broadcastBotStatus(null);
      }

      try {
        // Get trigger phrase for custom bot name
        const triggerPhrase = meetingBotSettings.triggerPhrase ?? null;
        
        // Include cloud service URL so the worker can trigger cloud fallback
        // analysis when the desktop is absent at meeting end
        const cloudServiceUrl = settings.cloudInstance?.cloudUrl || undefined;

        const response = await backendFetch('/api/bot', {
          method: 'POST',
          body: JSON.stringify({
            meetingUrl,
            meetingTitle,
            scheduledFor,
            avatarId: selectedAvatar,  // Worker builds avatar webpage URL
            clientSecret,
            userName,
            triggerPhrase,  // Custom Q&A trigger (becomes bot display name)
            forceJoin,      // Override dedup and send own bot anyway
            cloudServiceUrl,  // Cloud fallback: worker triggers analysis if desktop absent
          }),
        });

        // Log the raw response for debugging
        const responseText = await response.text();
        let data: { 
          success: boolean; 
          botId?: string; 
          sessionToken?: string;  // JWT for relay auth
          relayUrl?: string;      // WebSocket URL for relay
          isOwner?: boolean;      // Whether this user owns the bot (dedup)
          ownerName?: string;     // Owner name if not owner
          canOverride?: boolean;  // Whether user can override and send their own bot
          error?: string; 
          details?: unknown;
          recallStatus?: number;
          recallErrorCode?: string;
          recallSubCode?: string;
          retryable?: boolean;
        };
        try {
          data = JSON.parse(responseText);
        } catch {
          log.error(
            { 
              httpStatus: response.status,
              responseBody: responseText.slice(0, 1000),
              meetingUrl,
              meetingTitle,
              scheduledFor,
            },
            'Failed to parse bot creation response as JSON'
          );
          if (!isScheduledBot) {
            clearActiveBotState();
          }
          return { success: false, error: `Invalid response: ${responseText.slice(0, 200)}` };
        }

        // Log the backend response to debug dedup issues
        log.info({
          meetingUrl,
          botId: data.botId,
          isOwner: data.isOwner,
          ownerName: data.ownerName,
          canOverride: data.canOverride,
          success: data.success,
        }, 'Backend bot creation response');

        // Check for HTTP-level errors
        if (!response.ok) {
          const userMessage = mapRecallErrorToUserMessage(
            data.recallStatus,
            data.recallErrorCode,
            data.recallSubCode,
          );
          log.error(
            {
              httpStatus: response.status,
              error: data.error,
              recallStatus: data.recallStatus,
              recallErrorCode: data.recallErrorCode,
              recallSubCode: data.recallSubCode,
              meetingUrl,
            },
            'Recall API error when creating bot'
          );
          // Auto-retry once for retryable errors (507 pool busy, 429 rate limited)
          if (data.retryable && retryCount < 1) {
            log.info(
              { recallStatus: data.recallStatus, retryCount, delayMs: RETRY_DELAY_MS },
              'Retryable Recall error — scheduling retry'
            );
            await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
            return doSendBot(params, retryCount + 1);
          }

          if (!isScheduledBot) {
            clearActiveBotState();
          }
          return { success: false, error: userMessage };
        }

        if (!data.success || !data.botId) {
          log.error(
            {
              httpStatus: response.status,
              error: data.error,
              details: data.details,
              success: data.success,
              hasBotId: !!data.botId,
              responseBody: responseText.slice(0, 1000),
              meetingUrl,
              meetingTitle,
              scheduledFor,
            },
            'Bot creation returned success=false or missing botId'
          );
          // Clear active state on failure (only if we set it)
          if (!isScheduledBot) {
            clearActiveBotState();
          }
          return { success: false, error: data.error ?? 'Failed to create bot' };
        }

        // If another user's bot is already in the meeting, track it for transcript retrieval
        // but don't create activeBotState (owner-only features like relay, coach won't apply)
        if (data.isOwner === false) {
          log.info({
            botId: data.botId,
            ownerName: data.ownerName,
            meetingUrl,
          }, 'Another user bot already in meeting - tracking as collaborator for transcript');
          
          // Clear the dispatching state we set earlier and broadcast to update UI.
          // IMPORTANT: Use broadcastBotCompletion() instead of broadcastBotStatus(null)
          // because broadcastBotStatus early-returns when activeBotState is null.
          // broadcastBotCompletion sends a 'no_meetings' from cloud_bot source first
          // (to clear the stale 'dispatching' state in the renderer), then checks
          // if there's a collaborator state that should be shown.
          if (!isScheduledBot) {
            clearActiveBotState();
            broadcastBotCompletion();
          }
          
          // Track for transcript retrieval - collaborators get transcript too
          // Backend now accepts our clientSecret (added to secretHashes on dedup)
          // Note: No coachSkillPath, companionSessionId - these are owner-only
          addPendingTranscript({
            botId: data.botId,
            meetingUrl,
            meetingTitle,
            scheduledAt: new Date().toISOString(),
            status: 'in_meeting',
            clientSecret,
            calendarEventId,
            calendarSource,
            isCollaborator: true,
            ownerName: data.ownerName,
            relayBotId: data.relayUrl?.match(/\/relay\/([^/]+)$/)?.[1],
          });
          
          // Mark this collaborator as active for coaching/IPC fallback paths
          activeCollaboratorBotId = data.botId;
          
          log.info({
            botId: data.botId,
            ownerName: data.ownerName,
            meetingUrl,
          }, 'Collaborator transcript tracking initiated');

          // Connect to relay as viewer for live transcript (if credentials available)
          if (data.sessionToken && data.relayUrl) {
            const ownerName = resolveOwnerName();
            // Start buffer-only transcript accumulation (no Q&A, no triggers)
            startLocalTranscriptBuffer(data.botId, ownerName, { outputMode: 'silent' });
            
            connectToRelay(
              data.botId,
              data.sessionToken,
              data.relayUrl,
              createCollaboratorRelayCallbacks(data.botId),
            );
            log.info({ botId: data.botId, relayUrl: data.relayUrl }, 'Connected to relay as viewer for collaborator transcript');
          }
          
          return { 
            success: true, 
            botId: data.botId,
            isOwner: false,
            ownerName: data.ownerName,
            canOverride: data.canOverride ?? false,
          };
        }

        // Update active bot state with bot ID and relay info (only for immediate bots)
        if (!isScheduledBot && activeBotState) {
          activeBotState.botId = data.botId;
          activeBotState.sessionToken = data.sessionToken;
          activeBotState.relayUrl = data.relayUrl;
        }

        // Clean up existing collaborator state if this is a forceJoin override
        if (forceJoin) {
          const collaboratorTranscripts = getPendingTranscripts().filter(
            t => t.isCollaborator === true && urlsMatchSameMeeting(t.meetingUrl, meetingUrl) && t.botId !== data.botId
          );
          for (const collab of collaboratorTranscripts) {
            cleanupCollaboratorState(collab.botId);
            removePendingTranscript(collab.botId);
            log.info({ collaboratorBotId: collab.botId, newOwnerBotId: data.botId }, 'Cleaned up collaborator on forceJoin');
          }
        }

        // Add to pending transcripts for tracking (includes clientSecret for secure retrieval)
        addPendingTranscript({
          botId: data.botId,
          meetingUrl,
          meetingTitle,
          scheduledAt: scheduledFor ?? new Date().toISOString(),
          status: scheduledFor ? 'scheduled' : 'in_meeting',
          clientSecret,
          calendarEventId,
          calendarSource,
        });

        // Persist relayBotId immediately for restart recovery
        // Extract relayBotId from relayUrl (e.g., wss://host/relay/abc123 -> abc123)
        if (data.relayUrl) {
          const relayBotIdMatch = data.relayUrl.match(/\/relay\/([^/]+)$/);
          if (relayBotIdMatch) {
            updateRelayBotId(data.botId, relayBotIdMatch[1]);
          }
        }

        // Start fast polling for status updates (only for immediate bots)
        // Scheduled bots will be picked up by the regular polling cycle
        if (!isScheduledBot) {
          startFastPolling();
          // Do an immediate poll to get initial status
          fireAndForget(pollActiveBotStatus(), 'meetingBot.meetingBotService.line2623');
          
          // Connect to relay for Tier 2 features (if we got relay info and are the owner)
          const shouldConnectRelay = data.isOwner ?? true;
          if (data.sessionToken && data.relayUrl && shouldConnectRelay) {
            log.info({ 
              botId: data.botId, 
              relayUrl: data.relayUrl,
              hasToken: !!data.sessionToken,
            }, 'Connecting to relay for Tier 2 features');
            
            // Get owner name for announcements (needs to be outside try block for closure access)
            const settings = getSettings();
            const ownerName = resolveOwnerName();
            
            // Start Q&A service for this bot
            try {
              log.info({ botId: data.botId }, 'Preparing to start Q&A service');
              log.info({ botId: data.botId, hasSettings: !!settings }, 'Got settings for Q&A');
              const triggerPhrase = settings?.meetingBot?.triggerPhrase ?? null;
              const respondViaVoice = settings?.meetingBot?.respondViaVoice ?? true;
              log.info({ botId: data.botId, ownerName, triggerPhrase, respondViaVoice }, 'Starting Q&A service');
              startBotQA(data.botId, ownerName, triggerPhrase, respondViaVoice);
              log.info({ botId: data.botId }, 'Q&A service started successfully');
            } catch (qaError) {
              const errMsg = qaError instanceof Error ? qaError.message : String(qaError);
              const errStack = qaError instanceof Error ? qaError.stack : undefined;
              log.error({ botId: data.botId, error: errMsg, stack: errStack }, 'Failed to start Q&A service');
            }
            
            log.info({ botId: data.botId, relayUrl: data.relayUrl }, 'Calling connectToRelay');
            connectToRelay(
              data.botId,
              data.sessionToken,
              data.relayUrl,
              createRelayCallbacks(data.botId, ownerName),
            );
          }
        }

        log.info({ 
          botId: data.botId, 
          meetingUrl, 
          isScheduledBot,
          hasRelay: !!data.relayUrl,
        }, 'Meeting bot sent successfully');
        
        return { success: true, botId: data.botId };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        log.error({ error, meetingUrl }, 'Failed to send meeting bot');
        // Clear active state on failure (only if we set it)
        if (!isScheduledBot) {
          clearActiveBotState();
        }
        return { success: false, error: message };
      }
}

/**
 * Create the meeting bot service.
 */
export function createMeetingBotService(): MeetingBotService {
  const service: MeetingBotService = {
    async sendBot(params) {
      const { meetingUrl, forceJoin } = params;

      // =======================================================================
      // DISPATCH COALESCING: Prevent duplicate bots from race conditions
      // =======================================================================
      // Extract normalized meeting ID for coalescing key (e.g., 'zoom:123456789')
      // This MUST happen synchronously BEFORE any async operations to prevent races
      const meetingId = extractMeetingId(meetingUrl);
      const coalesceKey = meetingId ?? meetingUrl; // Fall back to raw URL if extraction fails
      
      // Check for in-flight dispatch to the same meeting (synchronous check)
      const existingDispatch = dispatchesInFlight.get(coalesceKey);
      if (existingDispatch && !forceJoin) {
        log.info({ meetingUrl, coalesceKey }, 'Coalescing with in-flight dispatch');
        return existingDispatch;
      }

      // Create the dispatch promise and store it BEFORE any async work
      // This ensures subsequent calls see the in-flight promise immediately
      const dispatchPromise = doSendBot(params);
      
      // Only track non-forceJoin dispatches (forceJoin intentionally bypasses dedup)
      if (!forceJoin) {
        dispatchesInFlight.set(coalesceKey, dispatchPromise);
      }

      try {
        return await dispatchPromise;
      } finally {
        // Clean up the in-flight tracking on ANY exit path (success, error, exception)
        if (!forceJoin) {
          dispatchesInFlight.delete(coalesceKey);
        }
      }
    },

    getPendingTranscripts() {
      return getPendingTranscripts();
    },

    async getTranscript(botId) {
      const pending = getPendingTranscript(botId);

      if (!pending) {
        return { success: false, error: 'Transcript not found in local store' };
      }

      log.info({ botId }, 'Fetching transcript from backend');

      try {
        // Use clientSecret header for secure retrieval
        const response = await backendFetch(
          `/api/transcript?botId=${botId}`,
          {},
          pending.clientSecret
        );
        const data = await response.json() as {
          success: boolean;
          transcript?: string;
          participants?: string[];
          duration?: number;
          error?: string;
        };

        if (!data.success) {
          return { success: false, error: data.error ?? 'Failed to fetch transcript' };
        }

        // Mark as ready if we successfully got the transcript
        if (pending.status !== 'ready') {
          updatePendingTranscriptStatus(botId, 'ready');
        }

        return {
          success: true,
          transcript: data.transcript,
          participants: data.participants,
          duration: data.duration,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        log.error({ error, botId }, 'Failed to fetch transcript');
        return { success: false, error: message };
      }
    },

    async cancelBot(botId) {
      const pending = getPendingTranscript(botId);

      if (!pending) {
        // Bot not found in pending store - still broadcast clear state in case
        // the UI is showing a stale rejected/error state that needs dismissing
        log.info({ botId }, 'cancelBot: bot not found in pending store, broadcasting clear state');
        broadcastBotCompletion();
        return { success: true };
      }

      log.info({
        botId,
        status: pending.status,
        meetingUrl: pending.meetingUrl,
        hasClientSecret: !!pending.clientSecret,
        isActiveBot: activeBotState?.botId === botId,
        activeUiState: activeBotState?.botId === botId ? activeBotState.uiState : undefined,
      }, 'cancelBot: attempting to cancel');

      // Helper to clear local state and broadcast
      const clearLocalState = () => {
        removePendingTranscript(botId);
        if (activeBotState?.botId === botId) {
          clearActiveBotState();
        }
        broadcastBotCompletion();
      };

      try {
        // Speak goodbye announcement and wait for it to finish
        // This ensures the bot says "That's a wrap" before leaving
        try {
          await announceLeaveAndWait(botId);
        } catch (announceErr) {
          log.warn({ botId, error: announceErr }, 'Failed to announce leave, continuing with cancel');
        }
        
        // Try backend FIRST, then clear local state on success
        const response = await backendFetch('/api/bot/cancel', {
          method: 'POST',
          body: JSON.stringify({
            botId,
            clientSecret: pending.clientSecret,
          }),
        });

        // 404 means bot doesn't exist on backend - safe to clear local state
        if (response.status === 404) {
          log.info({ botId }, 'Bot not found on backend (404), clearing local state');
          clearLocalState();
          return { success: true };
        }

        // Parse response for other status codes
        const data = await response.json() as { success: boolean; error?: string };

        // Success - safe to clear local state
        if (response.ok && data.success) {
          log.info({ botId }, 'Bot cancelled successfully');
          clearLocalState();
          return { success: true };
        }

        // Backend rejected the cancel request - DON'T clear local state
        // Recording may still be active
        const isRecoverable = response.status >= 500;
        log.warn(
          { botId, status: response.status, error: data.error, recoverable: isRecoverable },
          'Backend cancel failed - recording may still be active'
        );
        return {
          success: false,
          error: data.error ?? 'Could not stop recording - it may still be active',
          recoverable: isRecoverable,
        };
      } catch (error) {
        // Network error - DON'T clear local state
        // Recording may still be active
        const _message = error instanceof Error ? error.message : 'Unknown error';
        log.error({ error, botId }, 'Network error during cancel - recording may still be active');
        return {
          success: false,
          error: 'Network error - recording may still be active',
          recoverable: true,
        };
      }
    },

    dismissStatus() {
      log.info('Dismissing meeting status UI');
      // Clear active bot state if any
      if (activeBotState) {
        clearActiveBotState();
      }
      // Broadcast completion to clear the UI
      broadcastBotCompletion();
    },

    removePending(botId) {
      const removed = removePendingTranscript(botId);
      return { success: removed };
    },

    async processAndSaveTranscript(botId) {
      const pending = getPendingTranscript(botId);
      
      if (!pending) {
        return { success: false, error: 'Transcript not found in local store' };
      }

      // Skip if already saved
      if (pending.savedPath) {
        log.debug({ botId, savedPath: pending.savedPath }, 'Transcript already saved, skipping');
        return { success: true, filePath: pending.savedPath };
      }

      // Skip if staged for sensitivity review (no real savedPath — awaiting user approval)
      if (pending.stagedForReview) {
        log.debug({ botId }, 'Transcript staged for sensitivity review, skipping save');
        return { success: true };
      }

      // Prevent duplicate concurrent saves
      if (savesInProgress.has(botId)) {
        log.debug({ botId }, 'Save already in progress, skipping');
        return { success: false, error: 'Save already in progress' };
      }

      savesInProgress.add(botId);
      // Track retry timestamp for infinite loop prevention
      updateLastRetryAt(botId);
      log.info({ botId, meetingTitle: pending.meetingTitle }, 'Processing and saving transcript');

      try {
        // Fetch transcript from backend (use clientSecret header for secure retrieval)
        const response = await backendFetch(
          `/api/transcript?botId=${botId}`,
          {},
          pending.clientSecret
        );
        
        if (!response.ok) {
          // Handle 401/402 - global authentication/billing issue (don't burn attempts)
          if (response.status === 401 || response.status === 402) {
            log.error({ botId, status: response.status }, 'Recall API auth/billing issue during transcript fetch - not counting as attempt');
            // Don't increment attempts or set backoff - this is a global issue, not per-bot
            return { success: false, error: `Auth/billing issue (${response.status})`, global: true };
          }

          // Handle 403 - bot expired/deleted on Recall side (permanent failure)
          if (response.status === 403) {
            log.warn({ botId, status: response.status }, 'Bot expired on Recall side (403) - marking as permanently failed');
            updatePendingTranscriptStatus(botId, 'failed', 'Bot expired on Recall side (403)');
            return { success: false, error: 'Bot no longer accessible (403)', permanent: true };
          }
          
          const errorText = await response.text();
          // Set backoff time BEFORE incrementing attempts (so index matches attempt number)
          setNextRetryTime(botId);
          const attempts = incrementSaveAttempts(botId);
          log.warn({ botId, attempts, status: response.status, errorText }, 'Transcript fetch HTTP error - will retry with backoff');
          return { success: false, error: `HTTP ${response.status}: ${errorText}` };
        }
        
        const data = await response.json() as {
          success: boolean;
          transcript?: string;
          participants?: string[];
          duration?: number;
          startTime?: string;
          error?: string;
          recordingId?: string;
          transcriptQuality?: TranscriptQuality;
          asyncUpgradeAvailable?: boolean;
        };

        if (!data.success || !data.transcript) {
          // Set backoff time BEFORE incrementing attempts (so index matches attempt number)
          setNextRetryTime(botId);
          const attempts = incrementSaveAttempts(botId);
          log.warn({ botId, attempts, error: data.error, hasTranscript: !!data.transcript, data: JSON.stringify(data).slice(0, 500) }, 'Transcript fetch failed - will retry with backoff');
          return { success: false, error: data.error ?? 'Failed to fetch transcript' };
        }

        const participants = data.participants ?? [];
        const duration = data.duration ?? 0;
        const startTime = data.startTime ?? pending.scheduledAt ?? new Date().toISOString();
        const transcriptQuality = data.transcriptQuality ?? 'captions';
        const recordingId = data.recordingId;
        const asyncUpgradeAvailable = data.asyncUpgradeAvailable ?? false;
        let decisions: string[] | undefined;
        let openQuestions: string[] | undefined;

        // Extract decisions and open questions from persisted conversation state
        if (pending.conversationState) {
          try {
            const state = JSON.parse(pending.conversationState) as {
              recentDecisions?: unknown;
              openQuestions?: unknown;
            };
            if (Array.isArray(state.recentDecisions) && state.recentDecisions.length > 0) {
              const parsedDecisions = state.recentDecisions.filter(
                (item): item is string => typeof item === 'string' && item.trim().length > 0,
              );
              if (parsedDecisions.length > 0) {
                decisions = parsedDecisions;
              }
            }
            if (Array.isArray(state.openQuestions) && state.openQuestions.length > 0) {
              const parsedOpenQuestions = state.openQuestions.filter(
                (item): item is string => typeof item === 'string' && item.trim().length > 0,
              );
              if (parsedOpenQuestions.length > 0) {
                openQuestions = parsedOpenQuestions;
              }
            }
          } catch {
            // Ignore malformed state
          }
        }

        // Build transcript data (no embedded summary - analysis happens via inbox)
        const transcriptData: TranscriptData = {
          botId,
          meetingTitle: pending.meetingTitle ?? 'Meeting',
          meetingUrl: pending.meetingUrl,
          participants,
          duration,
          startTime,
          rawTranscript: data.transcript,
          decisions,
          openQuestions,
          recordingId,
          transcriptQuality,
          calendarEventId: pending.calendarEventId,
          calendarSource: pending.calendarSource,
        };

        // Fetch chat messages for the final transcript
        let chatMessages: ChatMessage[] = [];
        try {
          const rawMessages = await fetchChatMessagesFromBackend(botId);
          chatMessages = rawMessages.map(m => ({
            sender: m.sender,
            text: m.text,
            timestamp: m.timestamp,
          }));
        } catch (error) {
          log.warn({ botId, error }, 'Failed to fetch chat messages for final transcript — proceeding without');
        }

        // Add chat to transcript data
        transcriptData.chatMessages = chatMessages.length > 0 ? chatMessages : undefined;

        // Check if we have a live transcript to upgrade (instead of creating new file)
        let saveResult: TranscriptStorageResult;
        
        if (pending.liveTranscriptPath) {
          // Live transcript exists - try to upgrade it
          log.info({ botId, liveTranscriptPath: pending.liveTranscriptPath }, 'Found live transcript, attempting upgrade');
          
          // Check if file exists and is still a live transcript
          const fmResult = await readLiveTranscriptFrontmatter(pending.liveTranscriptPath);
          
          if (fmResult.success && fmResult.frontmatter?.live) {
            // File exists and is still live - upgrade it
            const upgradeResult = await upgradeExistingLiveTranscript(pending.liveTranscriptPath, transcriptData);
            
            if (upgradeResult.success) {
              log.info({ botId, filePath: pending.liveTranscriptPath, staged: upgradeResult.staged }, 'Successfully upgraded live transcript');
              saveResult = { success: true, filePath: upgradeResult.staged ? undefined : pending.liveTranscriptPath, staged: upgradeResult.staged };
            } else if (upgradeResult.skippedEmpty) {
              // Recall returned empty data - keep captions, retry later
              log.warn({ botId }, 'Recall returned empty transcript, keeping captions for now');
              setNextRetryTime(botId);
              incrementSaveAttempts(botId);
              return { success: false, error: 'Recall returned empty transcript (captions preserved)' };
            } else if (upgradeResult.alreadyUpgraded) {
              // Already upgraded - treat as success
              log.debug({ botId }, 'Live transcript already upgraded');
              saveResult = { success: true, filePath: pending.liveTranscriptPath, alreadyExists: true };
            } else {
              // Other error - fall through to normal save
              log.warn({ botId, error: upgradeResult.error }, 'Failed to upgrade live transcript, falling back to normal save');
              saveResult = await saveTranscript(transcriptData);
            }
          } else if (fmResult.success && !fmResult.frontmatter?.live) {
            // File exists but already upgraded - use it
            log.debug({ botId }, 'Live transcript already upgraded (live flag false)');
            saveResult = { success: true, filePath: pending.liveTranscriptPath, alreadyExists: true };
          } else {
            // File doesn't exist or can't be read - normal save
            log.warn({ botId, error: fmResult.error }, 'Could not read live transcript, falling back to normal save');
            saveResult = await saveTranscript(transcriptData);
          }
        } else {
          // No live transcript - normal save flow
          saveResult = await saveTranscript(transcriptData);
        }

        if (!saveResult.success || (!saveResult.filePath && !saveResult.staged)) {
          const attempts = incrementSaveAttempts(botId);
          log.warn({ botId, attempts, error: saveResult.error }, 'Transcript save failed, attempt counted');
          return { success: false, error: saveResult.error ?? 'Save returned no file path' };
        }

        // Staged transcripts: mark as staged (prevent retries). Event deferral is now kernel-owned.
        if (saveResult.staged) {
          markTranscriptStaged(botId);
          log.info({ botId }, 'Transcript staged for review, event deferred until approval');
        } else {
          const filePath = saveResult.filePath;
          if (!filePath) return { success: false, error: 'Save succeeded but filePath missing' };

          // Mark as saved so we don't retry
          markTranscriptSaved(botId, filePath);
        }

        // Track quality and async upgrade status
        updateTranscriptQuality(
          botId,
          transcriptQuality as import('@shared/ipc/channels/meetingBot').TranscriptQuality,
          recordingId,
        );
        
        // Set up async upgrade tracking if upgrade will be available
        if (transcriptQuality === 'captions') {
          // Captions saved - async upgrade is either available now or pending
          updateAsyncUpgradeStatus(botId, asyncUpgradeAvailable ? 'ready' : 'pending');
          log.info({ botId, asyncUpgradeAvailable }, 'Captions transcript saved, async upgrade status set');
        } else {
          // Already have async quality - mark as complete
          updateAsyncUpgradeStatus(botId, 'complete');
        }

        // Schedule analysis for 10 minutes from now to allow async transcript upgrade
        // The polling loop will trigger analysis when scheduledAnalysisAt has passed
        scheduleAnalysis(botId);

        log.info(
          { botId, filePath: saveResult.filePath, spacePath: saveResult.spacePath, transcriptQuality },
          'Transcript processed and saved successfully'
        );

        return {
          success: true,
          filePath: saveResult.filePath,
          spacePath: saveResult.spacePath,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const stack = error instanceof Error ? error.stack : undefined;
        // "not authenticated" is the ONLY true no-backoff transient: auth
        // initializes a beat after boot, so a backoff would needlessly stall the
        // first legitimate save. Everything else — including network errors
        // ("fetch failed", which a DNS-starvation outage produces on EVERY poll)
        // — must ENFORCE backoff. Previously `fetch failed` skipped backoff AND
        // attempt-counting, so a failing transcript was re-fetched on every 5-min
        // poll AND from startup recovery with no spacing → a parallel retry storm
        // that piled more I/O onto the already-saturated libuv pool (the Bug A
        // amplifier). We deliberately do NOT increment saveAttempts here: a real
        // multi-hour outage must not burn through MAX_SAVE_ATTEMPTS (6) and
        // prematurely mark a recoverable transcript `failed`. The 24h
        // retry-duration window (anchored to first failure) is the exhaustion
        // gate instead; backoff alone is enough to kill the storm.
        const isAuthNotReady = message.toLowerCase().includes('not authenticated');
        if (isAuthNotReady) {
          log.warn({ errorMessage: message, botId }, 'Auth not ready during transcript save, will retry without backoff or counting attempt');
        } else {
          // Anchor the retry-duration window to this first failure (no-op if
          // already set) so a chronically-failing transcript can actually exhaust
          // to `failed` at MAX_RETRY_HOURS instead of retrying forever.
          ensureRetryWindowStarted(botId);
          setNextRetryTime(botId);
          log.warn({ errorMessage: message, errorStack: stack, botId }, 'Error during transcript save, scheduling backoff (attempt not counted; 24h window is the cap)');
        }
        return { success: false, error: message };
      } finally {
        savesInProgress.delete(botId);
      }
    },

    startPolling() {
      if (pollInterval) {
        log.debug('Polling already started');
        return;
      }

      log.info('Starting transcript polling');

      // Reset transient-failed transcripts for retry on startup
      const resetCount = resetTransientFailedTranscripts();
      if (resetCount > 0) {
        log.info({ count: resetCount }, 'Reset failed transcripts for retry on startup');
      }

      // Clean up stale bots from previous sessions (e.g., bots that expired while app was closed)
      const allTranscripts = getPendingTranscripts();
      const staleBots = allTranscripts.filter(t => (t.consecutiveErrors ?? 0) >= 5);
      if (staleBots.length > 0) {
        log.info({ count: staleBots.length }, 'Cleaning up stale bots on startup');
        for (const t of staleBots) {
          log.info(
            { botId: t.botId, consecutiveErrors: t.consecutiveErrors, status: t.status },
            'Marking stale bot as failed on startup'
          );
          updatePendingTranscriptStatus(t.botId, 'failed', 'Stale bot cleanup (>5 consecutive errors)');
        }
      }

      // Cancel duplicate bots from previous session (dedup bug recovery)
      // Fire-and-forget — cancels on Recall + removes locally, logs results
      fireAndForget(cleanupDuplicateBots(), 'meetingBot.meetingBotService.line3171');

      // Immediately check for unsaved transcripts from previous session.
      // Skip if auth isn't ready yet: processAndSaveTranscript needs getUserId() and would
      // otherwise thrash with "User not authenticated" transient errors at startup (auth
      // initializes a beat after polling starts). The regular poll cycle re-attempts once
      // authenticated; transcripts stay 'ready' (the retry-duration window is now
      // anchored to first failure and preserved across restarts), so deferring
      // here does not lose the recovery.
      const unsaved = getTranscriptsNeedingSave();
      if (unsaved.length > 0) {
        if (!getUserId()) {
          log.info({ count: unsaved.length }, 'Deferring startup transcript recovery until authenticated (poll cycle will retry)');
        } else {
          log.info({ count: unsaved.length }, 'Found unsaved transcripts from previous session');
          // Bound the startup recovery fan-out (was unbounded parallel) so it
          // can't saturate the libuv pool on a backlog. Overall fire-and-forget.
          // Startup recovery was part of the original storm surface, so it gets the
          // same outcome-by-class summary as the poll-cycle retry batch.
          const startupOutcomes = { success: 0, transient_network: 0, terminal: 0, other: 0, unexpected_error: 0 };
          fireAndForget(
            mapWithConcurrencyLimit(unsaved, MAX_TRANSCRIPT_RETRY_CONCURRENCY, async (transcript) => {
              try {
                const result = await service.processAndSaveTranscript(transcript.botId);
                startupOutcomes[classifyRetryOutcome(result)] += 1;
              } catch (err) {
                startupOutcomes.unexpected_error += 1;
                log.error({ botId: transcript.botId, err }, 'Unexpected error in startup transcript recovery');
              }
            }).finally(() => {
              log.info({ queued: unsaved.length, ...startupOutcomes }, 'Startup transcript recovery finished');
            }),
            'meetingBot.meetingBotService.line3186',
          );
        }
      }

      // Check for transcripts needing analysis (saved but analysis crashed/incomplete)
      const needingAnalysis = getTranscriptsNeedingAnalysis();
      if (needingAnalysis.length > 0) {
        log.info({ count: needingAnalysis.length }, 'Found transcripts needing analysis from previous session');
        for (const transcript of needingAnalysis) {
          if (transcript.savedPath) {
            // Service handles marking triggered/completed internally
            void triggerMeetingAnalysis(
              transcript.botId,
              transcript.savedPath,
              undefined,
              { conversationState: transcript.conversationState },
            ).catch((err) => {
              log.warn({ botId: transcript.botId, error: err }, 'Startup analysis trigger failed');
            });
          }
        }
      }

      // Startup activation: if any own bot is already in_meeting and no activeBotState,
      // activate it immediately. This covers the case where the app restarts while a
      // bot is recording — the scheduled->in_meeting transition already happened before
      // this process started, so the polling transition check will never fire.
      // Collaborator bots are filtered out — they get separate restoration below.
      if (!activeBotState) {
        const inMeetingBots = allTranscripts.filter(t => t.status === 'in_meeting' && !t.isCollaborator);
        if (inMeetingBots.length === 1) {
          log.info(
            { botId: inMeetingBots[0].botId, meetingTitle: inMeetingBots[0].meetingTitle },
            'Startup activation: bot already in_meeting, activating for real-time features'
          );
          service.activatePreScheduledBot(inMeetingBots[0].botId);
        } else if (inMeetingBots.length > 1) {
          log.warn(
            { count: inMeetingBots.length, botIds: inMeetingBots.map(t => t.botId) },
            'Startup activation: multiple bots in_meeting, skipping auto-activate (ambiguous)'
          );
        }
      }

      // Restore collaborator state for any collaborator in_meeting bots
      const collaboratorBots = allTranscripts.filter(t => t.status === 'in_meeting' && t.isCollaborator === true);
      if (collaboratorBots.length > 0) {
        // Restore the first collaborator (typically only one per meeting)
        const collab = collaboratorBots[0];
        log.info({ botId: collab.botId, meetingTitle: collab.meetingTitle }, 'Startup: restoring collaborator state');
        service.activatePreScheduledBot(collab.botId); // Will hit the isCollaborator guard
      }

      // Initial check after delay
      setTimeout(() => {
        fireAndForget(checkPendingTranscripts(service), 'meetingBot.meetingBotService.line3242');
      }, INITIAL_POLL_DELAY_MS);

      // Regular polling
      pollInterval = setInterval(() => {
        fireAndForget(checkPendingTranscripts(service), 'meetingBot.meetingBotService.line3247');
      }, POLL_INTERVAL_MS);
    },

    stopPolling() {
      if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
        log.info('Stopped transcript polling');
      }
      stopImminentBotPolling();
    },

    activatePreScheduledBot(botId: string): boolean {
      // Find the pending transcript first — needed for collaborator check
      const pending = getPendingTranscript(botId);
      if (!pending) {
        log.warn({ botId }, 'Cannot activate pre-scheduled bot: not found in pending transcripts');
        return false;
      }

      // Collaborator bots must NOT be activated as owner bots
      if (pending.isCollaborator === true) {
        // Idempotency: don't re-restore if already tracking this collaborator
        if (activeCollaboratorBotId === botId) {
          log.debug({ botId }, 'Collaborator bot already active, skipping restore');
          return true;
        }

        log.info(
          { botId, meetingUrl: pending.meetingUrl, meetingTitle: pending.meetingTitle },
          'Activating collaborator bot — restoring collaborator state (not owner)'
        );

        activeCollaboratorBotId = botId;

        // Restore collaborator info in desktopSdkService for UI state
        setCollaboratorInfo({
          meetingUrl: pending.meetingUrl,
          botId: pending.botId,
          ownerName: pending.ownerName,
        });

        // Broadcast directly from pending transcript — don't rely on broadcastCollaboratorStateIfPresent()
        // because currentMeeting may be null on cold restart
        broadcastCollaboratorFromPendingTranscript({
          botId: pending.botId,
          meetingUrl: pending.meetingUrl,
          meetingTitle: pending.meetingTitle,
          ownerName: pending.ownerName,
        });

        // Reconnect relay for live transcript (fire-and-forget)
        if (pending.clientSecret) {
          fireAndForget(reconnectRelayForCollaborator(pending.botId, pending.clientSecret, pending.relayBotId), 'meetingBot.meetingBotService.line3301');
        }

        return true; // Activation handled (differently from owner)
      }

      // If already tracking this exact bot, no-op
      if (activeBotState && activeBotState.botId === botId) {
        log.debug({ botId }, 'Bot already active, skipping activation');
        return true;
      }

      // Only activate if bot is in activatable state
      if (pending.status !== 'scheduled' && pending.status !== 'in_meeting') {
        log.debug(
          { botId, status: pending.status },
          'Cannot activate pre-scheduled bot: not in activatable state'
        );
        return false;
      }

      // Log if swapping from another bot (multi-bot support)
      if (activeBotState && activeBotState.botId !== botId) {
        log.info(
          { previousBotId: activeBotState.botId, newBotId: botId },
          'Swapping active bot UI tracking to different meeting'
        );
        // Reset polling to ensure correct cadence for new bot
        stopFastPolling();
      }

      // Check if we have persisted recording start time (restart recovery case)
      const hasPersistedRecordingTime = !!pending.recordingStartTimeMs;
      
      // Determine initial UI state based on persisted data
      // If we have a recording start time, bot was already recording before restart
      const uiState: BotUiState = hasPersistedRecordingTime ? 'recording' : 'joining';
      const quip = hasPersistedRecordingTime 
        ? pickRandomQuip(RECORDING_QUIPS) 
        : pickRandomQuip(JOINING_QUIPS);
      const restoredCoachSkillPath = pending.coachSkillPath
        ? maybeRemapLegacyCoachSkillPath(pending.coachSkillPath)
        : undefined;

      // Hydrate activeBotState
      activeBotState = {
        botId: pending.botId,
        meetingUrl: pending.meetingUrl,
        meetingTitle: pending.meetingTitle ?? 'Meeting',
        uiState,
        quip,
        // Only set joiningStartTime if not already recording (prevents 4-min timeout for recovered bots)
        joiningStartTime: hasPersistedRecordingTime ? undefined : Date.now(),
        // Restore recording start time from persisted data for accurate duration display
        recordingStartTime: pending.recordingStartTimeMs,
        clientSecret: pending.clientSecret,
        // Restore coach selection from persisted data for restart recovery
        coachSkillPath: restoredCoachSkillPath,
        companionSessionId: pending.companionSessionId,
        presenceMode: pending.presenceMode ?? (restoredCoachSkillPath ? 'coach' : 'silent'),
        // Bot already announced itself when it first joined — don't re-announce on restart reconnect
        hasAnnounced: true,
      };

      if (activeBotState.coachSkillPath) {
        cacheResolvedCoachPrompt(activeBotState);
      }

      // Start real-time tracking (restarts if we stopped it above)
      startFastPolling();
      
      // Trigger immediate poll to get actual status from Recall
      fireAndForget(pollActiveBotStatus(), 'meetingBot.meetingBotService.line3373');
      
      // Broadcast status to renderer
      broadcastBotStatus(null);

      log.info(
        { 
          botId, 
          meetingUrl: pending.meetingUrl, 
          uiState,
          hasPersistedRecordingTime,
          recordingStartTime: pending.recordingStartTimeMs,
        },
        'Activated pre-scheduled bot for detected meeting'
      );

      // Restore live coach timer baseline if coach was active before restart
      if (restoredCoachSkillPath && pending.companionSessionId) {
        setCoachStartTime(pending.botId);
        log.info(
          { botId, coachSkillPath: restoredCoachSkillPath, companionSessionId: pending.companionSessionId },
          'Restored coach timer baseline on bot activation recovery'
        );
      }

      // Attempt relay reconnection for Tier 2 features (fire-and-forget)
      if (pending.clientSecret) {
        fireAndForget(reconnectRelayForBot(pending.botId, pending.clientSecret, pending.relayBotId), 'meetingBot.meetingBotService.line3400');
      }

      return true;
    },

    forceStatusCheck() {
      if (activeBotState) {
        log.info({ botId: activeBotState.botId }, 'Forcing immediate status check (system resume)');
        fireAndForget(pollActiveBotStatus(), 'meetingBot.meetingBotService.line3409');
      }
      // Also trigger pending transcript check
      fireAndForget(checkPendingTranscripts(service), 'meetingBot.meetingBotService.line3412');
    },
  };

  return service;
}
