/**
 * Desktop SDK Service
 *
 * Integrates with Recall.ai Desktop SDK for automatic meeting detection.
 * Detects when user joins Zoom, Meet, or Teams meetings and enables recording.
 */

import * as fs from 'node:fs';
import { BrowserWindow, Notification } from 'electron';
import { createScopedLogger } from '@core/logger';
import { getSettings } from '@core/services/settingsStore';
import { getCachedMeetings, hasRealPrepPath } from '@main/services/meetingCacheStore';
import { getPendingTranscripts, updatePendingTranscriptCalendarInfo } from './pendingTranscriptsStore';
import { fireAndForget } from '@shared/utils/fireAndForget';
import type { MeetingBotService, DetectedMeeting, MeetingStatusUpdate } from './meetingBotTypes';
import {
  registerCurrentMeetingProvider,
  stopLocalRecording,
  getLocalRecordingStatus,
} from './meetingBotRuntimeRegistry';
import { urlsMatchSameMeeting, isWithinDedupWindow } from './urlUtils';
import { isRebelTestMode } from '../../utils/testIsolation';
import { isRecorderInstalled } from './recorderInstallation';

const log = createScopedLogger({ service: 'desktop-sdk' });

interface MeetingNotificationWindowTarget {
  getMainWindow: () => BrowserWindow | null;
  ensureMainWindow: () => Promise<BrowserWindow | null>;
}

let meetingNotificationWindowTarget: MeetingNotificationWindowTarget = {
  getMainWindow: () => {
    log.warn('Meeting notification window target used before wiring');
    return null;
  },
  ensureMainWindow: async () => {
    log.warn('Meeting notification window ensure used before wiring');
    return null;
  },
};

export function setMeetingNotificationWindowTarget(target: MeetingNotificationWindowTarget): void {
  meetingNotificationWindowTarget = target;
}

function getLiveMeetingNotificationMainWindow(): BrowserWindow | null {
  const win = meetingNotificationWindowTarget.getMainWindow();
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) {
    return null;
  }
  return win;
}

async function ensureMeetingNotificationMainWindow(): Promise<BrowserWindow | null> {
  const win = await meetingNotificationWindowTarget.ensureMainWindow();
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) {
    return null;
  }
  return win;
}

function focusAndSendMeetingNotificationClick(
  win: BrowserWindow,
  payload: { meetingUrl: string; meetingTitle: string },
): void {
  if (win.isDestroyed() || win.webContents.isDestroyed()) {
    return;
  }
  if (!win.isVisible()) {
    win.show();
  }
  if (win.isMinimized()) {
    win.restore();
  }
  win.focus();
  win.webContents.send('meeting-notification:clicked', payload);
}

function dispatchMeetingNotificationClick(payload: { meetingUrl: string; meetingTitle: string }): void {
  fireAndForget((async () => {
    const win = getLiveMeetingNotificationMainWindow() ?? await ensureMeetingNotificationMainWindow();
    if (!win) {
      log.warn({ meetingUrl: redactMeetingUrl(payload.meetingUrl) }, 'Meeting notification clicked but no main window was available');
      return;
    }

    if (win.webContents.isLoadingMainFrame()) {
      win.webContents.once('did-finish-load', () => {
        focusAndSendMeetingNotificationClick(win, payload);
      });
      return;
    }

    focusAndSendMeetingNotificationClick(win, payload);
  })(), 'desktopSdk.meetingNotificationClick');
}

// The SDK module - loaded dynamically
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- @recallai/desktop-sdk is loaded via dynamic require and has no exported TS types
let RecallAiSdk: any = null;

/** Recall API URL for us-west-2 region */
const RECALL_API_URL = 'https://us-west-2.recall.ai';

/** Generic meeting titles too vague for reliable title-based bot matching.
 *  Mirrors GENERIC_TITLES in transcriptStorage.ts. */
const GENERIC_MEETING_TITLES = [
  'meeting', 'untitled', 'zoom meeting', 'google meet', 'teams meeting',
  'call', 'chat', 'untitled meeting', 'new meeting', 'scheduled meeting',
];

export type { MeetingState, DetectedMeeting, MeetingStatusUpdate } from './meetingBotTypes';

// Current state
let currentMeeting: DetectedMeeting | null = null;
let recordingStartTime: number | null = null;
let recordingInterval: NodeJS.Timeout | null = null;
let calendarPreviewInterval: NodeJS.Timeout | null = null;
let isInitialized = false;

// Dependency injection for meeting bot service (set via initializeDesktopSdkAutoSend)
let getMeetingBotServiceFn: (() => MeetingBotService) | null = null;

// Idempotency guard: track meeting URLs we've already auto-sent bots for
// Cleared when meeting closes
let autoSentMeetingUrl: string | null = null;

// Track skipped meeting URLs - cleared when meeting closes
let skippedMeetingUrl: string | null = null;

// Track collaborator bot info - when another user's bot is already in the meeting
let collaboratorInfo: {
  meetingUrl: string;
  botId: string;
  ownerName?: string;
} | null = null;

// Track Full Disk Access permission status (macOS only, required for Teams URL extraction)
let fullDiskAccessGranted: boolean | null = null;

/**
 * Probe macOS Full Disk Access by testing read access to the TCC database.
 * This file is always present and requires FDA to read.
 * Used as fallback when the Recall SDK doesn't fire a permission-status event
 * (which happens when FDA is already granted at startup).
 */
function probeFullDiskAccess(): boolean {
  if (process.platform !== 'darwin') return true;
  try {
    fs.accessSync('/Library/Application Support/com.apple.TCC/TCC.db', fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if Full Disk Access is currently granted, using SDK-reported status
 * with filesystem probe as fallback.
 */
function isFullDiskAccessGranted(): boolean {
  if (fullDiskAccessGranted !== null) return fullDiskAccessGranted;
  const probed = probeFullDiskAccess();
  if (probed) {
    fullDiskAccessGranted = true;
    log.info('FDA probe detected Full Disk Access is granted (SDK event not fired)');
  }
  return probed;
}

// Debounced auto-send timer - allows meeting-updated to correct stale URLs before dispatch
// The timer is keyed to a specific windowId to prevent cross-meeting dispatch
let autoSendTimer: NodeJS.Timeout | null = null;
let autoSendTimerWindowId: string | null = null;

/** Delay before auto-sending bot after meeting-detected (ms) - allows URL correction via meeting-updated */
const AUTO_SEND_DELAY_MS = 1500;

/** Check interval for calendar preview (5 minutes) */
const CALENDAR_PREVIEW_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Look up prepPath from calendar cache by matching meeting title.
 * Uses fuzzy matching since Desktop SDK title may differ slightly.
 */
function findPrepPathForMeeting(meetingTitle: string): string | undefined {
  const cache = getCachedMeetings();
  if (!cache?.meetings) return undefined;
  
  const normalizedTitle = meetingTitle.toLowerCase().trim();
  
  // Try exact match first
  const exactMatch = cache.meetings.find(
    m => m.title.toLowerCase().trim() === normalizedTitle && hasRealPrepPath(m.prepPath)
  );
  if (exactMatch?.prepPath) return exactMatch.prepPath;
  
  // Try partial match (title contains or is contained by)
  const partialMatch = cache.meetings.find(
    m => (normalizedTitle.includes(m.title.toLowerCase().trim()) ||
          m.title.toLowerCase().trim().includes(normalizedTitle)) && hasRealPrepPath(m.prepPath)
  );
  return partialMatch?.prepPath;
}

/**
 * Enrich meeting info from calendar cache by matching URL and time.
 * Returns the calendar event title if found (more accurate than Zoom window title).
 */
function enrichMeetingFromCalendar(meetingUrl: string): { title?: string; calendarEventId?: string; calendarSource?: string } | undefined {
  const cache = getCachedMeetings();
  if (!cache?.meetings || !meetingUrl) return undefined;
  
  const now = new Date();
  const nowMs = now.getTime();
  
  // Find matching calendar events by URL and time window
  const matchingEvents = cache.meetings
    .filter(m => {
      if (!m.meetingUrl) return false;
      if (!urlsMatchSameMeeting(meetingUrl, m.meetingUrl)) return false;
      // Check if meeting is happening now or soon (within dedup window)
      return isWithinDedupWindow(now.toISOString(), m.startTime);
    })
    // Sort by closest start time to prefer the most relevant match
    .sort((a, b) => {
      const aDiff = Math.abs(new Date(a.startTime).getTime() - nowMs);
      const bDiff = Math.abs(new Date(b.startTime).getTime() - nowMs);
      return aDiff - bDiff;
    });
  
  const match = matchingEvents[0];
  if (match) {
    return {
      title: match.title,
      calendarEventId: match.calendarEventId,
      calendarSource: match.calendarSource,
    };
  }
  return undefined;
}

/**
 * Show a desktop notification for meeting detection.
 * Only shown when joinMode is not 'auto' (i.e., user needs to manually trigger Send Rebel).
 */
export function showMeetingDetectedNotification(meeting: DetectedMeeting): void {
  // Don't show notification if meeting URL is not available yet
  // (URL may arrive later via meeting-updated event)
  if (!meeting.url) {
    log.debug('Skipping meeting notification - no URL available yet');
    return;
  }

  const settings = getSettings();

  // Don't show if meeting bot is disabled
  if (settings.meetingBot?.enabled === false) {
    log.debug('Skipping meeting notification - meeting bot disabled');
    return;
  }

  const joinMode = settings.meetingBot?.joinMode ?? 'prompt';

  // Only show notification when joinMode is 'ask' or 'prompt'
  if (joinMode === 'auto' || joinMode === 'never') {
    log.debug({ joinMode }, 'Skipping meeting notification - auto-join or never mode');
    return;
  }

  // Don't show if external provider is handling meetings
  const hasExternalProvider = settings.meetingBot?.firefliesApiKey || settings.meetingBot?.fathomApiKey;
  if (hasExternalProvider) {
    log.debug('Skipping meeting notification - external provider configured');
    return;
  }

  if (isRebelTestMode()) {
    log.debug('Meeting notification suppressed in rebel-test mode');
    return;
  }

  if (!Notification.isSupported()) {
    log.debug('Notifications not supported on this platform');
    return;
  }

  const title = 'Meeting detected';
  const body = meeting.title || 'Join with Rebel to take notes';

  const notification = new Notification({ title, body });

  notification.on('click', () => {
    try {
      dispatchMeetingNotificationClick({
        meetingUrl: meeting.url,
        meetingTitle: meeting.title,
      });

      log.debug({ meetingUrl: redactMeetingUrl(meeting.url) }, 'Meeting notification clicked');
    } catch (err) {
      log.debug({ err, meetingUrl: redactMeetingUrl(meeting.url) }, 'Error handling meeting notification click');
    }
  });

  notification.show();
  log.info({ meetingTitle: meeting.title }, 'Meeting detection notification shown');
}

/**
 * Initialize auto-send capability for Desktop SDK.
 * Called once from main/index.ts after the meeting bot service is created.
 */
export function initializeDesktopSdkAutoSend(getMeetingBotService: () => MeetingBotService): void {
  getMeetingBotServiceFn = getMeetingBotService;
  log.info('Desktop SDK auto-send initialized');
}

/**
 * Attempt to auto-send a bot when joinMode is 'auto'.
 * Handles all gating: enabled check, external provider check, URL check, idempotency.
 * Returns true if bot was sent, false otherwise.
 */
async function maybeAutoSendBot(meeting: DetectedMeeting): Promise<boolean> {
  // Must have a URL to send bot
  if (!meeting.url) {
    log.info({ platform: meeting.platform, windowId: meeting.windowId }, 'Auto-send skipped: no meeting URL');

    // Proactive guidance: if this is Teams on macOS and FDA is not granted,
    // tell the user exactly why and how to fix it
    if (meeting.platform === 'teams' && process.platform === 'darwin' && !isFullDiskAccessGranted()) {
      broadcastHealthWarning(
        'I can see your Teams meeting but need Full Disk Access to read the link. Open System Settings to grant it.',
        'fda_required',
      );
    } else {
      broadcastHealthWarning(
        'Meeting detected but the link isn\u2019t available yet. Try joining from your calendar so I can pick it up.',
        'url_unavailable',
      );
    }
    return false;
  }

  // Check idempotency - don't send twice for same meeting
  if (autoSentMeetingUrl === meeting.url) {
    log.debug({ meetingUrl: redactMeetingUrl(meeting.url) }, 'Auto-send skipped: already sent for this meeting');
    return false;
  }

  const settings = getSettings();

  // Must have meeting bot enabled
  if (settings.meetingBot?.enabled === false) {
    log.debug('Auto-send skipped: meeting bot disabled');
    return false;
  }

  // Must be in auto mode
  const joinMode = settings.meetingBot?.joinMode ?? 'prompt';
  if (joinMode !== 'auto') {
    log.debug({ joinMode }, 'Auto-send skipped: joinMode is not "auto"');
    return false;
  }

  // Don't auto-send if external provider is configured (they handle transcripts)
  const hasExternalProvider = settings.meetingBot?.firefliesApiKey || settings.meetingBot?.fathomApiKey;
  if (hasExternalProvider) {
    log.debug('Auto-send skipped: external provider configured');
    return false;
  }

  // Need the meeting bot service
  if (!getMeetingBotServiceFn) {
    log.warn('Auto-send skipped: meeting bot service not initialized');
    return false;
  }

  try {
    const meetingBotService = getMeetingBotServiceFn();
    
    // Bug 2 fix: Look up calendar event to get proper title and linkage
    // This ensures auto-joined bots are linked to the calendar entry
    const calendarCache = getCachedMeetings();
    let calendarEventId: string | undefined;
    let calendarSource: string | undefined;
    let meetingTitle = meeting.title;
    let effectiveMeetingUrl = meeting.url;
    
    if (calendarCache?.meetings) {
      // Find matching calendar events by URL and time window
      const now = new Date();
      const nowMs = now.getTime();
      const matchingEvents = calendarCache.meetings
        .filter(m => {
          if (!m.meetingUrl) return false;
          if (!urlsMatchSameMeeting(meeting.url, m.meetingUrl)) return false;
          // Check if meeting is happening now or soon (within dedup window)
          return isWithinDedupWindow(now.toISOString(), m.startTime);
        })
        // Reviewer fix: Sort by closest start time to prefer the most relevant match
        .sort((a, b) => {
          const aDiff = Math.abs(new Date(a.startTime).getTime() - nowMs);
          const bDiff = Math.abs(new Date(b.startTime).getTime() - nowMs);
          return aDiff - bDiff;
        });
      
      const matchingEvent = matchingEvents[0];
      if (matchingEvent) {
        calendarEventId = matchingEvent.calendarEventId;
        calendarSource = matchingEvent.calendarSource;
        // Prefer calendar title over Desktop SDK title (usually more accurate)
        if (matchingEvent.title) {
          meetingTitle = matchingEvent.title;
        }
        // Prefer calendar URL over Desktop SDK URL — the calendar URL typically
        // contains the passcode (?pwd=) which the Zoom window URL strips out.
        // Without this, Recall gets meeting_password_incorrect for password-protected meetings.
        if (matchingEvent.meetingUrl) {
          effectiveMeetingUrl = matchingEvent.meetingUrl;
        }
        log.info({ 
          meetingUrl: redactMeetingUrl(meeting.url),
          calendarMeetingUrl: redactMeetingUrl(matchingEvent.meetingUrl ?? ''),
          usingCalendarUrl: effectiveMeetingUrl !== meeting.url,
          calendarEventId, 
          calendarSource,
          calendarTitle: matchingEvent.title,
        }, 'Found matching calendar event for auto-send');
      }
    }
    
    log.info({ meetingUrl: redactMeetingUrl(effectiveMeetingUrl), title: meetingTitle }, 'Auto-sending bot for detected meeting');

    const result = await meetingBotService.sendBot({
      meetingUrl: effectiveMeetingUrl,
      meetingTitle,
      calendarEventId,
      calendarSource,
    });

    if (result.success) {
      // Check if this is a dedup scenario (another user's bot already in meeting)
      if (result.isOwner === false) {
        log.info({ 
          meetingUrl: redactMeetingUrl(meeting.url), 
          botId: result.botId,
          ownerName: result.ownerName,
        }, 'Auto-send found another user\'s bot already in meeting');
        
        // Track collaborator info so UI can show "collaborator_recording" state
        collaboratorInfo = {
          meetingUrl: meeting.url,
          botId: result.botId ?? '',
          ownerName: result.ownerName,
        };
        
        // Mark as "sent" for idempotency - prevents repeated auto-send attempts
        // when meeting-updated events occur. Without this, each update would
        // re-attempt sendBot and hit the dedup check again.
        autoSentMeetingUrl = meeting.url;
        
        // Broadcast the collaborator state to all windows
        broadcastCollaboratorState(meeting);
        
        return false;
      }
      
      // NOTE: We intentionally DON'T clear collaboratorInfo here.
      // If user stops their bot later, we want to restore the collaborator state
      // since the collaborator's bot may still be recording.
      
      // Mark as sent for idempotency
      autoSentMeetingUrl = meeting.url;
      
      // Ensure bot is activated for UI tracking. This handles the case where
      // meeting-detected didn't activate the bot (e.g., URL not yet available)
      // and doSendBot returned a dedup hit without hydrating activeBotState.
      // activatePreScheduledBot is idempotent — no-ops if bot is already active.
      if (result.botId && getMeetingBotServiceFn) {
        getMeetingBotServiceFn().activatePreScheduledBot(result.botId);
      }
      
      log.info({ meetingUrl: redactMeetingUrl(meeting.url), botId: result.botId }, 'Auto-send successful');
      return true;
    } else {
      log.warn({ meetingUrl: redactMeetingUrl(meeting.url), error: result.error }, 'Auto-send failed');
      return false;
    }
  } catch (err) {
    log.error({ err, meetingUrl: redactMeetingUrl(meeting.url) }, 'Auto-send threw an error');
    return false;
  }
}

/**
 * Cancel any pending auto-send timer.
 * Should be called when meeting closes, new meeting detected, or URL changes significantly.
 */
function cancelAutoSendTimer(): void {
  if (autoSendTimer) {
    clearTimeout(autoSendTimer);
    autoSendTimer = null;
    log.debug({ previousWindowId: autoSendTimerWindowId }, 'Cancelled pending auto-send timer');
  }
  autoSendTimerWindowId = null;
}

/**
 * Schedule auto-send with a delay to allow meeting-updated events to correct stale URLs.
 * The timer is guarded by windowId - if the meeting changes before timer fires, dispatch is skipped.
 */
function scheduleAutoSend(meeting: DetectedMeeting): void {
  // Cancel any existing timer (from previous meeting or re-detection)
  cancelAutoSendTimer();
  
  const targetWindowId = meeting.windowId;
  autoSendTimerWindowId = targetWindowId;
  
  log.debug({ 
    windowId: targetWindowId, 
    delayMs: AUTO_SEND_DELAY_MS,
    meetingUrl: redactMeetingUrl(meeting.url),
  }, 'Scheduling debounced auto-send');
  
  autoSendTimer = setTimeout(() => {
    fireAndForget((async () => {
    autoSendTimer = null;
    autoSendTimerWindowId = null;
    
    // Guard: verify meeting is still active and matches the expected windowId
    if (!currentMeeting || currentMeeting.windowId !== targetWindowId) {
      log.info({ 
        targetWindowId, 
        currentWindowId: currentMeeting?.windowId ?? 'null',
      }, 'Auto-send timer fired but meeting changed - skipping dispatch');
      return;
    }
    
    // Use current meeting data (may have been updated by meeting-updated event)
    const autoSent = await maybeAutoSendBot(currentMeeting);
    if (!autoSent) {
      showMeetingDetectedNotification(currentMeeting);
    }
    })(), 'desktopSdk.autoSendTimer');
  }, AUTO_SEND_DELAY_MS);
}

/**
 * Redact sensitive parts of a meeting URL for logging.
 * Removes password parameters and other sensitive query strings.
 */
function redactMeetingUrl(url: string | undefined): string {
  if (!url) return '[no-url]';
  try {
    const parsed = new URL(url);
    // Redact Zoom password parameter
    if (parsed.searchParams.has('pwd')) {
      parsed.searchParams.set('pwd', '[REDACTED]');
    }
    // Redact any token parameters
    if (parsed.searchParams.has('token')) {
      parsed.searchParams.set('token', '[REDACTED]');
    }
    return parsed.toString();
  } catch {
    return '[invalid-url]';
  }
}

/**
 * Clear previous meeting state when switching meetings.
 * Called when meeting-detected fires while currentMeeting already exists
 * AND the new meeting is different (different windowId).
 * This handles implicit meeting switches where meeting-closed was not received.
 */
function clearPreviousMeetingState(previousMeeting: DetectedMeeting, newWindowId: string): void {
  log.info({
    previousWindowId: previousMeeting.windowId,
    previousUrl: redactMeetingUrl(previousMeeting.url),
    newWindowId,
  }, 'Implicit meeting switch detected - clearing previous meeting state');
  
  // Cancel any pending auto-send for the previous meeting
  cancelAutoSendTimer();
  
  // Clear idempotency guards
  autoSentMeetingUrl = null;
  skippedMeetingUrl = null;
  collaboratorInfo = null;
  
  // Stop recording timer if active
  stopRecordingTimer();
}

/**
 * Broadcast collaborator recording state when another user's bot is already in the meeting.
 */
function broadcastCollaboratorState(meeting: DetectedMeeting): void {
  // eslint-disable-next-line no-restricted-syntax -- window-scan-send-allowlisted: collaborator state is a genuine all-window meeting-bot broadcast; migrate later to BroadcastService.
  const windows = BrowserWindow.getAllWindows();
  const prepPath = findPrepPathForMeeting(meeting.title);
  
  log.info({ 
    meetingUrl: meeting.url,
    ownerName: collaboratorInfo?.ownerName,
    windowCount: windows.length,
  }, 'Broadcasting collaborator_recording state');
  
  for (const window of windows) {
    if (window.isDestroyed() || window.webContents.isDestroyed()) {
      continue;
    }
    const payload = {
      state: 'collaborator_recording',
      source: 'desktop_sdk' as const,
      meeting: {
        id: meeting.windowId,
        title: meeting.title || 'Meeting',
        startTime: new Date().toISOString(),
        meetingUrl: meeting.url || '',
        prepPath,
      },
      botId: collaboratorInfo?.botId,
      collaborator: collaboratorInfo ? {
        ownerName: collaboratorInfo.ownerName,
        botId: collaboratorInfo.botId,
      } : undefined,
      timestamp: Date.now(),
    };
    log.debug({ windowId: window.id, payload }, 'Sending collaborator status to window');
    try {
      window.webContents.send('meeting-bot:status', payload);
    } catch {
      // Window may be tearing down during HMR - skip silently
    }
  }
}

/**
 * Broadcast meeting status to all windows.
 */
function broadcastStatus(status: MeetingStatusUpdate): void {
  // If meeting is skipped, don't broadcast detected/recording states - fall back to preview/idle
  if (status.meeting?.url && isMeetingSkipped(status.meeting.url)) {
    log.debug({ meetingUrl: status.meeting.url }, 'Skipping broadcast for skipped meeting');
    checkCalendarPreviewAndBroadcast();
    return;
  }
  
  // eslint-disable-next-line no-restricted-syntax -- window-scan-send-allowlisted: desktop SDK status is a genuine all-window meeting-bot broadcast; migrate later to BroadcastService.
  const windows = BrowserWindow.getAllWindows();
  
  // Check if collaborator bot is present for this meeting
  const hasCollaborator = Boolean(
    status.meeting?.url &&
      collaboratorInfo &&
      urlsMatchSameMeeting(collaboratorInfo.meetingUrl, status.meeting.url)
  );
  const matchedCollaborator = hasCollaborator ? collaboratorInfo : null;
  
  // Check if external provider is configured
  let mappedState: string;
  if (status.state === 'idle') {
    mappedState = 'no_meetings';
  } else if (hasCollaborator && status.state === 'detected') {
    // Collaborator state takes precedence over detected
    mappedState = 'collaborator_recording';
  } else if (status.state === 'detected') {
    const settings = getSettings();
    const hasExternalProvider = settings.meetingBot?.firefliesApiKey || settings.meetingBot?.fathomApiKey;
    mappedState = hasExternalProvider ? 'detected_external_provider' : 'detected';
  } else {
    mappedState = status.state; // 'recording'
  }
  
  log.info({ 
    originalState: status.state, 
    mappedState, 
    windowCount: windows.length,
    hasMeeting: !!status.meeting,
    meetingTitle: status.meeting?.title
  }, 'Broadcasting meeting status to windows');
  
  for (const window of windows) {
    if (window.isDestroyed() || window.webContents.isDestroyed()) {
      continue;
    }
    // Look up prepPath from calendar cache
    const prepPath = status.meeting?.title ? findPrepPathForMeeting(status.meeting.title) : undefined;
    
    const payload = {
      state: mappedState,
      source: 'desktop_sdk' as const, // For precedence handling in renderer
      meeting: status.meeting ? {
        id: status.meeting.windowId,
        title: status.meeting.title || 'Meeting',
        startTime: new Date().toISOString(),
        meetingUrl: status.meeting.url || '',
        prepPath,
      } : undefined,
      botId: matchedCollaborator?.botId ?? status.meeting?.windowId,
      recordingDuration: status.recordingDuration,
      timestamp: status.timestamp,
      collaborator: matchedCollaborator ? {
        ownerName: matchedCollaborator.ownerName,
        botId: matchedCollaborator.botId,
      } : undefined,
    };
    log.debug({ windowId: window.id, payload }, 'Sending meeting-bot:status to window');
    try {
      window.webContents.send('meeting-bot:status', payload);
    } catch {
      // Window may be tearing down during HMR - skip silently
    }
  }
}

/**
 * Retroactively enrich pending transcripts with calendar data.
 * Called when calendar cache updates. Fills in missing calendarEventId and title
 * for bots that were sent before the calendar cache was populated (e.g. first launch).
 */
function retroactivelyEnrichPendingTranscripts(): void {
  if (!getMeetingBotServiceFn) return;

  const cache = getCachedMeetings();
  if (!cache?.meetings?.length) return;

  const pending = getPendingTranscripts();

  for (const transcript of pending) {
    // Skip if already has calendar linkage or no meeting URL
    if (transcript.calendarEventId || !transcript.meetingUrl) continue;
    // Only enrich active transcripts (not saved/failed)
    if (transcript.savedPath || transcript.status === 'failed') continue;

    const calendarInfo = enrichMeetingFromCalendar(transcript.meetingUrl);
    if (calendarInfo?.calendarEventId) {
      log.info({
        botId: transcript.botId,
        calendarEventId: calendarInfo.calendarEventId,
        calendarTitle: calendarInfo.title,
      }, 'Retroactively enriched pending transcript with calendar data');

      updatePendingTranscriptCalendarInfo(transcript.botId, {
        calendarEventId: calendarInfo.calendarEventId,
        calendarSource: calendarInfo.calendarSource,
        meetingTitle: calendarInfo.title,
      });
    }
  }
}

/**
 * Check calendar cache for upcoming meetings and broadcast preview state.
 * Only broadcasts if no active meeting is detected by Desktop SDK.
 */
function checkCalendarPreviewAndBroadcast(): void {
  // Try to enrich pending transcripts that were sent without calendar linkage
  retroactivelyEnrichPendingTranscripts();
  // Don't show preview if Desktop SDK has detected a meeting (unless skipped)
  if (currentMeeting && !isMeetingSkipped(currentMeeting.url)) {
    log.debug('Skipping calendar preview - Desktop SDK has active meeting');
    return;
  }

  const cache = getCachedMeetings();
  if (!cache?.meetings?.length) {
    log.debug('No cached meetings for preview');
    broadcastIdleOrPreview(null);
    return;
  }

  log.debug({ 
    totalMeetings: cache.meetings.length,
    meetingsWithUrl: cache.meetings.filter(m => m.meetingUrl).length
  }, 'Checking calendar cache for preview');

  const now = Date.now();
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const todayMs = today.getTime();
  const tomorrowMs = todayMs + 24 * 60 * 60 * 1000;

  // Find next meeting that:
  // 1. Is today (same day)
  // 2. Hasn't ended yet
  // Note: meetingUrl is optional - UI handles meetings without URLs gracefully
  const upcomingMeeting = cache.meetings
    .filter(m => {
      const startMs = typeof m.startTime === 'string' ? new Date(m.startTime).getTime() : m.startTime;
      const endMs = typeof m.endTime === 'string' ? new Date(m.endTime).getTime() : m.endTime;
      // Must be today
      if (startMs < todayMs || startMs >= tomorrowMs) return false;
      // Must not have ended
      if (now >= endMs) return false;
      return true;
    })
    .sort((a, b) => {
      const aStart = typeof a.startTime === 'string' ? new Date(a.startTime).getTime() : a.startTime;
      const bStart = typeof b.startTime === 'string' ? new Date(b.startTime).getTime() : b.startTime;
      return aStart - bStart;
    })[0];

  if (upcomingMeeting) {
    log.info({ 
      meetingId: upcomingMeeting.id, 
      title: upcomingMeeting.title,
      meetingUrl: upcomingMeeting.meetingUrl,
      hasPrepPath: !!upcomingMeeting.prepPath
    }, 'Broadcasting calendar preview for upcoming meeting');
    broadcastIdleOrPreview(upcomingMeeting);
  } else {
    // Log why no meeting was found
    const meetingsWithUrls = cache.meetings.filter(m => !!m.meetingUrl);
    log.info({ 
      totalMeetings: cache.meetings.length,
      meetingsWithUrls: meetingsWithUrls.length,
      sampleMeetings: cache.meetings.slice(0, 3).map(m => ({
        title: m.title,
        hasUrl: !!m.meetingUrl,
        startTime: m.startTime
      }))
    }, 'No upcoming meetings with URLs for preview');
    broadcastIdleOrPreview(null);
  }
}

/**
 * Check if a meeting URL has been pre-scheduled (bot already dispatched to Recall).
 * Returns the botId if found, undefined otherwise.
 * Uses URL matching to handle variations in meeting URLs.
 */
function getPreScheduledBotId(meetingUrl: string | undefined): string | undefined {
  if (!meetingUrl) return undefined;
  
  const pending = getPendingTranscripts();
  const scheduledBots = pending.filter(t => t.status === 'scheduled');
  
  // Log the search context for debugging dedup issues
  if (scheduledBots.length > 0) {
    log.debug({
      searchUrl: meetingUrl,
      scheduledCount: scheduledBots.length,
      scheduledBots: scheduledBots.map(t => ({
        botId: t.botId,
        url: t.meetingUrl,
        status: t.status,
        scheduledAt: t.scheduledAt,
      })),
    }, 'Searching for pre-scheduled bot');
  }
  
  const scheduled = scheduledBots.find(
    t => urlsMatchSameMeeting(t.meetingUrl, meetingUrl)
  );
  
  if (scheduled) {
    log.info({ 
      meetingUrl, 
      botId: scheduled.botId,
      botUrl: scheduled.meetingUrl,
      scheduledAt: scheduled.scheduledAt,
    }, 'Found pre-scheduled bot for meeting');
  } else if (scheduledBots.length > 0) {
    log.debug({ meetingUrl, scheduledCount: scheduledBots.length }, 'No matching pre-scheduled bot found');
  }
  
  return scheduled?.botId;
}

/**
 * Broadcast either preview (if meeting provided) or idle state.
 */
function broadcastIdleOrPreview(meeting: NonNullable<ReturnType<typeof getCachedMeetings>>['meetings'][0] | null): void {
  // eslint-disable-next-line no-restricted-syntax -- window-scan-send-allowlisted: calendar preview/idle is a genuine all-window meeting-bot broadcast; migrate later to BroadcastService.
  const windows = BrowserWindow.getAllWindows();
  
  for (const window of windows) {
    if (window.isDestroyed() || window.webContents.isDestroyed()) {
      continue;
    }
    let payload;
    if (meeting) {
      // Check if this meeting has been pre-scheduled
      const preScheduledBotId = getPreScheduledBotId(meeting.meetingUrl);
      
      payload = {
        state: 'preview',
        source: 'desktop_sdk',
        meeting: {
          id: meeting.id,
          title: meeting.title,
          startTime: meeting.startTime,
          meetingUrl: meeting.meetingUrl || '',
          prepPath: meeting.prepPath,
          isPreScheduled: !!preScheduledBotId,
        },
        botId: preScheduledBotId,
        timestamp: Date.now(),
      };
    } else {
      payload = {
        state: 'no_meetings',
        source: 'desktop_sdk',
        timestamp: Date.now(),
      };
    }
    try {
      window.webContents.send('meeting-bot:status', payload);
    } catch {
      // Window may be tearing down during HMR - skip silently
    }
  }
}

/**
 * Start periodic calendar preview checks.
 * Can be called independently of Desktop SDK initialization.
 */
export function startCalendarPreviewTimer(): void {
  // Prevent multiple timers
  if (calendarPreviewInterval) {
    log.debug('Calendar preview timer already running');
    return;
  }
  // Check immediately
  checkCalendarPreviewAndBroadcast();
  
  // Then check every 5 minutes
  calendarPreviewInterval = setInterval(() => {
    checkCalendarPreviewAndBroadcast();
  }, CALENDAR_PREVIEW_INTERVAL_MS);
}

/**
 * Stop the calendar preview timer.
 */
function stopCalendarPreviewTimer(): void {
  if (calendarPreviewInterval) {
    clearInterval(calendarPreviewInterval);
    calendarPreviewInterval = null;
  }
}

/**
 * Start the recording duration timer.
 */
function startRecordingTimer(): void {
  recordingStartTime = Date.now();
  recordingInterval = setInterval(() => {
    if (recordingStartTime && currentMeeting) {
      const duration = Math.floor((Date.now() - recordingStartTime) / 1000);
      broadcastStatus({
        state: 'recording',
        meeting: currentMeeting,
        recordingDuration: duration,
        timestamp: Date.now(),
      });
    }
  }, 1000);
}

/**
 * Stop the recording duration timer.
 */
function stopRecordingTimer(): void {
  if (recordingInterval) {
    clearInterval(recordingInterval);
    recordingInterval = null;
  }
  recordingStartTime = null;
}

/**
 * Initialize the Desktop SDK.
 * Should be called once at app startup.
 */
export async function initializeDesktopSdk(): Promise<boolean> {
  if (isInitialized) {
    log.debug('Desktop SDK already initialized');
    return true;
  }

  if (!isRecorderInstalled()) {
    log.info('Recall Desktop SDK package is not installed; skipping Desktop SDK initialization');
    return false;
  }

  try {
    // Use require like the working meeting-note-recorder implementation
    // The SDK is a CommonJS module that exports RecallAiSdk as default
     
    RecallAiSdk = require('@recallai/desktop-sdk').default;
    
    log.info({ apiUrl: RECALL_API_URL }, 'Initializing Recall Desktop SDK');
    log.info({ 
      methods: Object.keys(RecallAiSdk),
      hasInit: typeof RecallAiSdk.init === 'function',
      hasAddEventListener: typeof RecallAiSdk.addEventListener === 'function'
    }, 'SDK module loaded');

    // ============================================================================
    // CRITICAL: Event listeners MUST be set up BEFORE SDK init
    // ============================================================================
    // The Recall.ai SDK starts firing events immediately during init().
    // If addEventListener is called AFTER init, early events (especially meeting-detected)
    // will be dropped/lost because there's no event buffering in the SDK.
    // ============================================================================
    log.info('Setting up SDK event listeners BEFORE init to catch all events');
    setupEventListeners();
    log.info('All SDK event listeners configured BEFORE init');

    // Note: The SDK accepts both apiUrl and api_url
    // CRITICAL: init() returns a Promise - must await it!
    log.info('Calling RecallAiSdk.init()...');
    try {
      await RecallAiSdk.init({
        apiUrl: RECALL_API_URL,
        api_url: RECALL_API_URL,
      });
      log.info('Desktop SDK init() completed successfully');
    } catch (initError) {
      const msg = initError instanceof Error ? initError.message : String(initError);
      const stack = initError instanceof Error ? initError.stack : undefined;
      log.error({ initErrorMessage: msg, initErrorStack: stack }, 'SDK init() threw an error');
      throw initError;
    }

    // Request permissions on MacOS (must be after init completes)
    if (process.platform === 'darwin') {
      log.info('Requesting MacOS permissions for Desktop SDK');
      await RecallAiSdk.requestPermission('accessibility');
      await RecallAiSdk.requestPermission('microphone');

      // Screen Recording is only needed for LOCAL recording (capturing the
      // meeting window's audio/video on this machine). Cloud-bot meeting
      // detection and joining don't need it. Requesting it eagerly at startup
      // pops the macOS "record this computer's screen and audio" prompt while
      // the user is doing something unrelated, which reads as unprompted and
      // alarming. Defer it to the first actual local-recording start via
      // requestScreenCapturePermission(), so users who never record locally
      // (auto-join off / cloud bots) are never prompted, and those who do see
      // the prompt in context. Mirrors the on-demand FDA-for-Teams deferral
      // below.
      //
      // Full Disk Access is only needed for Teams URL extraction (reading the
      // TCC database). Zoom / Google Meet / Slack don't need it. Request FDA
      // on-demand via requestTeamsUrlPermission() the first time the user has
      // a Teams meeting we can't read a URL for, so users who never use Teams
      // aren't nagged for it on launch and Teams users see the prompt with
      // contextual explanation. The renderer surfaces the request via the
      // 'fda_required' health-warning broadcast in maybeAutoSendBot().
      log.info('MacOS permissions requested (screen capture + FDA deferred to on-demand)');

      // The SDK may not fire a permission-status event when FDA is already granted.
      // Probe the filesystem to detect the actual status.
      if (fullDiskAccessGranted === null) {
        fullDiskAccessGranted = probeFullDiskAccess();
        log.info({ fullDiskAccessGranted }, 'FDA status after init (probed — SDK event not fired)');
      }
    }

    isInitialized = true;
    log.info('Desktop SDK initialized successfully - listening for meetings');
    
    // Start calendar preview timer - broadcasts preview or idle based on calendar
    startCalendarPreviewTimer();

    return true;
  } catch (error) {
    // Log the error with more detail - some SDK errors don't serialize well
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;
    log.error({ 
      errorMessage, 
      errorStack,
      errorType: error?.constructor?.name,
      errorKeys: error ? Object.keys(error) : []
    }, 'Failed to initialize Desktop SDK (feature disabled)');

    broadcastHealthWarning('Meeting detection could not start. You can still record meetings manually.', 'sdk_init_failed');

    return false;
  }
}

/**
 * Broadcast meeting bot health warning to renderer.
 * Used when Desktop SDK fails to initialize or encounters non-recoverable errors.
 *
 * @param warning - Human-readable message
 * @param type - Category so the renderer can show context-specific UI
 * @param resolved - If true, indicates the issue was fixed (for celebration)
 */
function broadcastHealthWarning(
  warning: string,
  type: 'fda_required' | 'url_unavailable' | 'sdk_init_failed' | 'fda_granted' = 'sdk_init_failed',
  resolved = false,
): void {
  // eslint-disable-next-line no-restricted-syntax -- window-scan-send-allowlisted: meeting-bot health warning is a genuine all-window broadcast; migrate later to BroadcastService.
  const windows = BrowserWindow.getAllWindows();
  for (const window of windows) {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      try {
        window.webContents.send('meeting-bot:health-warning', {
          warning,
          type,
          resolved,
          timestamp: Date.now(),
        });
      } catch {
        // Window may be tearing down
      }
    }
  }
}

/**
 * Set up event listeners for the Desktop SDK.
 */
function setupEventListeners(): void {
  if (!RecallAiSdk) return;

  log.info('Setting up Desktop SDK event listeners');

  // Meeting detected
  RecallAiSdk.addEventListener('meeting-detected', async (evt: { window: { id: string; title?: string; url?: string; platform?: string } }) => {
    // Log with previous state for debugging meeting switch scenarios
    // URLs are redacted to avoid logging sensitive password/token parameters
    log.info({ 
      windowId: evt.window.id, 
      title: evt.window.title, 
      platform: evt.window.platform, 
      url: redactMeetingUrl(evt.window.url),
      hadPreviousMeeting: !!currentMeeting,
      previousWindowId: currentMeeting?.windowId,
      previousUrl: redactMeetingUrl(currentMeeting?.url),
    }, 'Meeting detected!');
    
    // Handle implicit meeting switch: if currentMeeting exists with a DIFFERENT windowId,
    // clear previous state. This handles cases where meeting-closed was not received.
    // We only clear on windowId change to avoid resetting state if SDK fires duplicate
    // meeting-detected events for the same meeting.
    if (currentMeeting && currentMeeting.windowId !== evt.window.id) {
      clearPreviousMeetingState(currentMeeting, evt.window.id);
    }
    
    // Start with SDK-provided title, then try to enrich from calendar
    let meetingTitle = evt.window.title || 'Meeting';
    const meetingUrl = evt.window.url || '';
    
    // Enrich meeting info from calendar - calendar titles are more accurate than Zoom window titles
    if (meetingUrl) {
      const calendarInfo = enrichMeetingFromCalendar(meetingUrl);
      if (calendarInfo?.title) {
        log.info({
          sdkTitle: evt.window.title,
          calendarTitle: calendarInfo.title,
          calendarEventId: calendarInfo.calendarEventId,
        }, 'Enriched meeting title from calendar');
        meetingTitle = calendarInfo.title;
      }
    }
    
    currentMeeting = {
      windowId: evt.window.id,
      title: meetingTitle,
      url: meetingUrl,
      platform: evt.window.platform || 'unknown',
    };

    // Check for pre-scheduled bot BEFORE broadcasting 'detected'
    // If found, activate it for real-time tracking instead of showing 'detected' state
    if (getMeetingBotServiceFn) {
      const pending = getPendingTranscripts();
      const now = new Date().toISOString();
      const nowMs = Date.now();
      // Match 'scheduled' (joining) or 'in_meeting' (already joined but not tracked)
      // Also check time window to avoid activating old bots for recurring meetings
      const candidates = pending.filter(
        t => (t.status === 'scheduled' || t.status === 'in_meeting')
      );
      
      // Log dedup search context
      log.info({
        detectedUrl: currentMeeting.url || '[no-url]',
        detectedTitle: currentMeeting.title,
        candidateCount: candidates.length,
        candidates: candidates.map(t => ({
          botId: t.botId,
          url: redactMeetingUrl(t.meetingUrl),
          title: t.meetingTitle,
          status: t.status,
          scheduledAt: t.scheduledAt,
          inWindow: isWithinDedupWindow(t.scheduledAt, now),
        })),
      }, 'meeting-detected: searching for pre-scheduled bot');
      
      let existingBot: typeof candidates[0] | undefined;
      
      if (currentMeeting.url) {
        const currentMeetingUrl = currentMeeting.url;
        // Primary: match by URL (most reliable)
        // URL matching is sufficient for scheduled/in_meeting bots — the time window
        // was preventing activation for bots scheduled >2h before the meeting.
        // Previous-occurrence bots are excluded by the status filter (they transition
        // to processing/ready/done/failed).
        existingBot = candidates.find(
          t => urlsMatchSameMeeting(t.meetingUrl, currentMeetingUrl)
        );
      }
      
      // Fallback: when URL is unavailable (e.g., Teams without Full Disk Access),
      // match by title + time window. This ensures pre-scheduled/active bots are
      // activated even when the Desktop SDK can't extract the meeting URL.
      // Skip for generic/empty titles to avoid false positives.
      const normalizedDetectedTitle = currentMeeting.title?.toLowerCase().trim() ?? '';
      const isGeneric = !normalizedDetectedTitle || GENERIC_MEETING_TITLES.includes(normalizedDetectedTitle);
      if (!existingBot && !currentMeeting.url && !isGeneric) {
        // Sort candidates by scheduledAt closest to now to prefer the most relevant match
        const sortedCandidates = [...candidates].sort((a, b) => {
          const aDiff = Math.abs(new Date(a.scheduledAt).getTime() - nowMs);
          const bDiff = Math.abs(new Date(b.scheduledAt).getTime() - nowMs);
          return aDiff - bDiff;
        });
        existingBot = sortedCandidates.find(t => {
          if (!t.meetingTitle) return false;
          const normalizedBotTitle = t.meetingTitle.toLowerCase().trim();
          if (!normalizedBotTitle || GENERIC_MEETING_TITLES.includes(normalizedBotTitle)) return false;
          const titlesMatch = normalizedDetectedTitle === normalizedBotTitle ||
            normalizedDetectedTitle.includes(normalizedBotTitle) ||
            normalizedBotTitle.includes(normalizedDetectedTitle);
          return titlesMatch &&
            (t.status === 'in_meeting' || isWithinDedupWindow(t.scheduledAt, now));
        });
        if (existingBot) {
          log.info({
            botId: existingBot.botId,
            botTitle: existingBot.meetingTitle,
            detectedTitle: currentMeeting.title,
          }, 'Matched pre-scheduled bot by title (no URL available)');
        }
      }

      // Last resort: when URL is unavailable AND title is generic (e.g., "Meeting" on Teams),
      // match if there's exactly ONE in_meeting candidate. If only one bot is actively in a
      // meeting right now, it's almost certainly the one the user is in.
      if (!existingBot && !currentMeeting.url) {
        const inMeetingCandidates = candidates.filter(t => t.status === 'in_meeting');
        if (inMeetingCandidates.length === 1) {
          existingBot = inMeetingCandidates[0];
          log.info({
            botId: existingBot.botId,
            botTitle: existingBot.meetingTitle,
            detectedTitle: currentMeeting.title,
          }, 'Matched bot by single in_meeting candidate (no URL, generic title)');
        }
      }
      
      if (existingBot) {
        const activated = getMeetingBotServiceFn().activatePreScheduledBot(existingBot.botId);
        if (activated) {
          log.info({
            botId: existingBot.botId,
            botUrl: redactMeetingUrl(existingBot.meetingUrl),
            detectedUrl: currentMeeting.url || '[no-url]',
            botStatus: existingBot.status,
            matchedBy: currentMeeting.url ? 'url' : (isGeneric ? 'single_in_meeting' : 'title'),
          }, 'Activated pre-scheduled bot for detected meeting');
          return; // Skip broadcasting 'detected' and auto-send - bot service broadcasts status
        }
      } else {
        log.info({ detectedUrl: currentMeeting.url || '[no-url]', candidateCount: candidates.length }, 'No matching pre-scheduled bot found');
      }
    }

    broadcastStatus({
      state: 'detected',
      meeting: currentMeeting,
      timestamp: Date.now(),
    });

    // Schedule debounced auto-send to allow meeting-updated events to correct stale URLs
    // This fixes the bug where SDK fires meeting-detected with stale URL during rapid meeting switches
    scheduleAutoSend(currentMeeting);
  });

  // Meeting updated (title/URL become known or corrected)
  RecallAiSdk.addEventListener('meeting-updated', async (evt: { window: { id: string; title?: string; url?: string; platform?: string } }) => {
    // URLs are redacted to avoid logging sensitive password/token parameters
    log.info({ 
      windowId: evt.window.id, 
      title: evt.window.title, 
      url: redactMeetingUrl(evt.window.url),
      currentUrl: redactMeetingUrl(currentMeeting?.url),
    }, 'Meeting updated');
    
    if (currentMeeting && currentMeeting.windowId === evt.window.id) {
      const previousUrl = currentMeeting.url;
      const hadNoUrl = !previousUrl;
      const newUrl = evt.window.url || '';
      
      // Detect if URL changed to a DIFFERENT meeting (not just URL variant)
      // This catches the case where meeting-detected had a stale URL
      const urlChangedToDifferentMeeting = previousUrl && newUrl && 
        !urlsMatchSameMeeting(previousUrl, newUrl);
      
      if (urlChangedToDifferentMeeting) {
        log.info({
          previousUrl: redactMeetingUrl(previousUrl),
          newUrl: redactMeetingUrl(newUrl),
          windowId: evt.window.id,
        }, 'URL changed to different meeting - clearing previous state and rescheduling auto-send');
        
        // Cancel pending auto-send FIRST to prevent race conditions
        cancelAutoSendTimer();
        
        // Then clear idempotency guards since this is effectively a new meeting
        autoSentMeetingUrl = null;
        skippedMeetingUrl = null;
        collaboratorInfo = null;
      }
      
      // Update current meeting state
      currentMeeting.url = newUrl || currentMeeting.url;
      
      // Try to enrich title from calendar if URL just became available or changed
      let newTitle = evt.window.title || currentMeeting.title;
      if ((hadNoUrl || urlChangedToDifferentMeeting) && currentMeeting.url) {
        const calendarInfo = enrichMeetingFromCalendar(currentMeeting.url);
        if (calendarInfo?.title) {
          log.info({
            sdkTitle: evt.window.title,
            calendarTitle: calendarInfo.title,
          }, 'Enriched meeting title from calendar on update');
          newTitle = calendarInfo.title;
        }
      }
      currentMeeting.title = newTitle;
      
      broadcastStatus({
        state: recordingStartTime ? 'recording' : 'detected',
        meeting: currentMeeting,
        recordingDuration: recordingStartTime ? Math.floor((Date.now() - recordingStartTime) / 1000) : undefined,
        timestamp: Date.now(),
      });

      // If URL just became available OR changed to a different meeting, check for pre-scheduled bot
      if ((hadNoUrl || urlChangedToDifferentMeeting) && currentMeeting.url) {
        const currentMeetingUrl = currentMeeting.url;
        // Check for pre-scheduled bot before trying to auto-send
        if (getMeetingBotServiceFn) {
          const pending = getPendingTranscripts();
          // Find matching bot by URL — time window not needed for URL-based matching
          const existingBot = pending.find(
            t => urlsMatchSameMeeting(t.meetingUrl, currentMeetingUrl) &&
                 (t.status === 'scheduled' || t.status === 'in_meeting')
          );
          if (existingBot) {
            const activated = getMeetingBotServiceFn().activatePreScheduledBot(existingBot.botId);
            if (activated) {
              log.info(
                { botId: existingBot.botId, meetingUrl: currentMeeting.url, botStatus: existingBot.status },
                'Activated pre-scheduled bot after URL became available/corrected'
              );
              return; // Skip auto-send - bot service handles status
            }
          }
        }
        
        // If URL changed to different meeting, reschedule auto-send with corrected URL
        // The debounce timer will use the updated currentMeeting.url
        if (urlChangedToDifferentMeeting) {
          scheduleAutoSend(currentMeeting);
        } else if (hadNoUrl) {
          // URL just became available - schedule auto-send
          scheduleAutoSend(currentMeeting);
        }
      } else if (!currentMeeting.url && getMeetingBotServiceFn) {
        // URL still unavailable (e.g., Teams without FDA). Try single-candidate
        // in_meeting match — the bot may have joined since meeting-detected fired.
        const pending = getPendingTranscripts();
        const inMeetingBots = pending.filter(t => t.status === 'in_meeting');
        if (inMeetingBots.length === 1) {
          const activated = getMeetingBotServiceFn().activatePreScheduledBot(inMeetingBots[0].botId);
          if (activated) {
            log.info(
              { botId: inMeetingBots[0].botId, detectedTitle: currentMeeting.title },
              'Activated bot by single in_meeting candidate on meeting-updated (no URL)'
            );
            return;
          }
        }
      }
    }
  });

  // Meeting closed
  RecallAiSdk.addEventListener('meeting-closed', async (evt: { window: { id: string } }) => {
    log.info({ windowId: evt.window.id }, 'Meeting closed');
    
    if (currentMeeting && currentMeeting.windowId === evt.window.id) {
      stopRecordingTimer();
      // Cancel any pending auto-send for this meeting
      cancelAutoSendTimer();
      currentMeeting = null;
      // Clear idempotency guards so next meeting can auto-send/show UI
      autoSentMeetingUrl = null;
      skippedMeetingUrl = null;
      collaboratorInfo = null;
      
      // Auto-stop local recording if active
      const localStatus = getLocalRecordingStatus();
      if (localStatus.isRecording) {
        log.info('Auto-stopping local recording after meeting closed');
        fireAndForget(stopLocalRecording(), 'meetingBot.desktopSdkService.line1336');
      }
      
      // Check calendar for upcoming meetings to preview, or show idle
      checkCalendarPreviewAndBroadcast();
    }
  });

  // Recording started
  RecallAiSdk.addEventListener('recording-started', async (evt: { window: { id: string } }) => {
    log.info({ windowId: evt.window.id }, 'Recording started');
    startRecordingTimer();
  });

  // Recording ended
  RecallAiSdk.addEventListener('recording-ended', async (evt: { window: { id: string } }) => {
    log.info({ windowId: evt.window.id }, 'Recording ended');
    stopRecordingTimer();
    
    if (currentMeeting) {
      broadcastStatus({
        state: 'detected',
        meeting: currentMeeting,
        timestamp: Date.now(),
      });
    }
  });

  // Permission status - track FDA for Teams URL extraction
  RecallAiSdk.addEventListener('permission-status', async (evt: { permission: string; status: string }) => {
    log.info({ permission: evt.permission, status: evt.status }, 'Permission status changed');
    
    // Track Full Disk Access status for Teams URL extraction
    if (evt.permission === 'full-disk-access') {
      const wasGranted = fullDiskAccessGranted;
      fullDiskAccessGranted = evt.status === 'granted';
      
      if (fullDiskAccessGranted && !wasGranted) {
        log.info('Full Disk Access granted - Teams URL extraction now available');
        broadcastHealthWarning(
          'Full Disk Access granted \u2014 Teams meeting links are now readable.',
          'fda_granted',
          true,
        );
      } else if (!fullDiskAccessGranted && wasGranted) {
        log.warn('Full Disk Access revoked - Teams URL extraction may fail');
      }
    }
  });

  // Permissions granted
  RecallAiSdk.addEventListener('permissions-granted', async () => {
    log.info('All permissions granted for Desktop SDK');
  });

  // Errors
  RecallAiSdk.addEventListener('error', async (evt: { type: string; message: string }) => {
    log.error({ type: evt.type, message: evt.message }, 'Desktop SDK error');
  });

  // Real-time events (transcripts, participant events)
  RecallAiSdk.addEventListener('realtime-event', async (evt: { type: string; data: unknown }) => {
    log.debug({ type: evt.type }, 'Real-time event received');
    // TODO: Handle transcript events for live transcription display
  });

  log.info('Desktop SDK event listeners registered');
}

/**
 * Start recording the current meeting.
 */
export async function startRecording(uploadToken: string): Promise<{ success: boolean; error?: string }> {
  if (!RecallAiSdk || !currentMeeting) {
    return { success: false, error: 'No meeting detected' };
  }

  try {
    log.info({ windowId: currentMeeting.windowId }, 'Starting recording');
    
    await RecallAiSdk.startRecording({
      windowId: currentMeeting.windowId,
      uploadToken,
    });

    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    log.error({ error }, 'Failed to start recording');
    return { success: false, error: message };
  }
}

/**
 * Stop recording the current meeting.
 */
export async function stopRecording(): Promise<{ success: boolean; error?: string }> {
  if (!RecallAiSdk || !currentMeeting) {
    return { success: false, error: 'No active recording' };
  }

  try {
    log.info({ windowId: currentMeeting.windowId }, 'Stopping recording');
    
    await RecallAiSdk.stopRecording({
      windowId: currentMeeting.windowId,
    });

    stopRecordingTimer();
    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    log.error({ error }, 'Failed to stop recording');
    return { success: false, error: message };
  }
}

/**
 * Get the current meeting state.
 */
export function getCurrentMeeting(): DetectedMeeting | null {
  return currentMeeting;
}

// Register the current-meeting accessor so sibling services (notably
// localRecordingService) can read it via meetingBotRuntimeRegistry without
// a static import on this module (avoids the desktopSdk ↔ localRecording cycle).
registerCurrentMeetingProvider(getCurrentMeeting);

/** Full meeting status payload for renderer initialization */
export interface MeetingStatusPayload {
  state: string;
  source?: 'desktop_sdk' | 'cloud_bot' | 'local_recording';
  meeting?: {
    id: string;
    title: string;
    startTime: string;
    meetingUrl: string;
    prepPath?: string;
    /** True if bot has been pre-scheduled for this meeting */
    isPreScheduled?: boolean;
  };
  botId?: string;
  quip?: string;
  recordingDuration?: number;
  /** Collaborator info when another user's bot is already in the meeting */
  collaborator?: {
    ownerName?: string;
    botId: string;
  };
}

/**
 * Get the current meeting status for renderer initialization.
 * Returns the full status payload including source for precedence handling.
 * This is the single source of truth - renderer should rely on this + IPC broadcasts.
 */
export function getCurrentMeetingStatus(): MeetingStatusPayload {
  log.debug({ 
    hasCurrentMeeting: !!currentMeeting,
    isRecording: !!recordingStartTime,
    isSkipped: currentMeeting ? isMeetingSkipped(currentMeeting.url) : false,
  }, 'getCurrentMeetingStatus called');

  // If Desktop SDK has detected a meeting (and not skipped), return that
  if (currentMeeting && !isMeetingSkipped(currentMeeting.url)) {
    const settings = getSettings();
    const hasExternalProvider = settings.meetingBot?.firefliesApiKey || settings.meetingBot?.fathomApiKey;
    const prepPath = findPrepPathForMeeting(currentMeeting.title);
    
    // Check if another user's bot is already in this meeting
    const hasCollaborator = Boolean(
      collaboratorInfo &&
        urlsMatchSameMeeting(collaboratorInfo.meetingUrl, currentMeeting.url)
    );
    const matchedCollaborator = hasCollaborator ? collaboratorInfo : null;
    
    // Determine state: collaborator > recording > detected
    let state: string;
    if (hasCollaborator) {
      state = 'collaborator_recording';
    } else if (recordingStartTime) {
      state = 'recording';
    } else {
      state = hasExternalProvider ? 'detected_external_provider' : 'detected';
    }
    
    // Check if actively recording
    const isRecording = !!recordingStartTime;
    const recordingDuration = isRecording && recordingStartTime 
      ? Math.floor((Date.now() - recordingStartTime) / 1000) 
      : undefined;

    const result: MeetingStatusPayload = {
      state,
      source: 'desktop_sdk',
      meeting: {
        id: currentMeeting.windowId,
        title: currentMeeting.title,
        startTime: new Date().toISOString(),
        meetingUrl: currentMeeting.url,
        prepPath,
      },
      botId: matchedCollaborator?.botId ?? currentMeeting.windowId,
      recordingDuration,
      collaborator: matchedCollaborator ? {
        ownerName: matchedCollaborator.ownerName,
        botId: matchedCollaborator.botId,
      } : undefined,
    };

    log.debug({ state: result.state, meetingTitle: currentMeeting.title }, 'Returning detected meeting status');
    return result;
  }

  // Check calendar cache for preview
  const cache = getCachedMeetings();
  if (!cache?.meetings?.length) {
    log.debug('No meetings in cache, returning no_meetings');
    return { state: 'no_meetings', source: 'desktop_sdk' };
  }

  const now = Date.now();
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const todayMs = today.getTime();
  const tomorrowMs = todayMs + 24 * 60 * 60 * 1000;

  const upcomingMeeting = cache.meetings
    .filter(m => {
      if (!m.meetingUrl) return false;
      const startMs = typeof m.startTime === 'string' ? new Date(m.startTime).getTime() : m.startTime;
      const endMs = typeof m.endTime === 'string' ? new Date(m.endTime).getTime() : m.endTime;
      if (startMs < todayMs || startMs >= tomorrowMs) return false;
      if (now >= endMs) return false;
      return true;
    })
    .sort((a, b) => {
      const aStart = typeof a.startTime === 'string' ? new Date(a.startTime).getTime() : a.startTime;
      const bStart = typeof b.startTime === 'string' ? new Date(b.startTime).getTime() : b.startTime;
      return aStart - bStart;
    })[0];

  if (upcomingMeeting) {
    const preScheduledBotId = getPreScheduledBotId(upcomingMeeting.meetingUrl);
    log.debug({ meetingTitle: upcomingMeeting.title, isPreScheduled: !!preScheduledBotId }, 'Returning preview meeting status');
    return {
      state: 'preview',
      source: 'desktop_sdk',
      meeting: {
        id: upcomingMeeting.id,
        title: upcomingMeeting.title,
        startTime: typeof upcomingMeeting.startTime === 'string' 
          ? upcomingMeeting.startTime 
          : new Date(upcomingMeeting.startTime).toISOString(),
        meetingUrl: upcomingMeeting.meetingUrl || '',
        prepPath: upcomingMeeting.prepPath,
        isPreScheduled: !!preScheduledBotId,
      },
      botId: preScheduledBotId,
    };
  }

  log.debug('No upcoming meetings with URLs, returning no_meetings');
  return { state: 'no_meetings', source: 'desktop_sdk' };
}

/**
 * Check if the SDK is initialized.
 */
export function isDesktopSdkInitialized(): boolean {
  return isInitialized;
}

/**
 * Shutdown the Desktop SDK.
 */
export function shutdownDesktopSdk(): void {
  if (RecallAiSdk && isInitialized) {
    try {
      RecallAiSdk.shutdown();
      log.info('Desktop SDK shut down');
    } catch (error) {
      log.warn({ error }, 'Error shutting down Desktop SDK');
    }
  }
  stopRecordingTimer();
  stopCalendarPreviewTimer();
  cancelAutoSendTimer();
  currentMeeting = null;
  collaboratorInfo = null;
  isInitialized = false;
}

/**
 * Skip the currently detected meeting.
 * Hides the detection UI until the meeting closes or a new meeting is detected.
 */
export function skipCurrentMeeting(meetingUrl: string): void {
  log.info({ meetingUrl }, 'User skipped meeting');
  skippedMeetingUrl = meetingUrl;
  // Broadcast idle/preview to hide the detection UI
  checkCalendarPreviewAndBroadcast();
}

/**
 * Check if a meeting URL has been skipped.
 */
export function isMeetingSkipped(meetingUrl: string): boolean {
  return skippedMeetingUrl === meetingUrl;
}

/**
 * Set collaborator info directly.
 * Used by meetingBotService to restore collaborator state on cold restart
 * (when the Desktop SDK hasn't detected a meeting yet).
 */
export function setCollaboratorInfo(info: { meetingUrl: string; botId: string; ownerName?: string } | null): void {
  collaboratorInfo = info;
}

/**
 * Broadcast collaborator state directly from pending transcript data.
 * Unlike broadcastCollaboratorStateIfPresent(), this does NOT require currentMeeting
 * to be set — essential for cold restart where Desktop SDK hasn't detected the meeting yet.
 */
export function broadcastCollaboratorFromPendingTranscript(pending: {
  botId: string;
  meetingUrl: string;
  meetingTitle?: string;
  ownerName?: string;
}): void {
  // eslint-disable-next-line no-restricted-syntax -- window-scan-send-allowlisted: collaborator state from pending transcript is a genuine all-window meeting-bot broadcast; migrate later to BroadcastService.
  const windows = BrowserWindow.getAllWindows();
  for (const window of windows) {
    if (window.isDestroyed() || window.webContents.isDestroyed()) continue;
    try {
      window.webContents.send('meeting-bot:status', {
        state: 'collaborator_recording',
        source: 'cloud_bot' as const,
        meeting: {
          id: pending.botId,
          title: pending.meetingTitle ?? 'Meeting',
          startTime: new Date().toISOString(),
          meetingUrl: pending.meetingUrl,
        },
        botId: pending.botId,
        collaborator: {
          ownerName: pending.ownerName,
          botId: pending.botId,
        },
        timestamp: Date.now(),
      });
    } catch {
      // Window may be tearing down during HMR - skip silently
    }
  }
}

/**
 * Broadcast collaborator state to all windows.
 * Called by meetingBotService when user's bot is stopped but collaborator's bot may still be active.
 */
export function broadcastCollaboratorStateIfPresent(): boolean {
  if (!collaboratorInfo || !currentMeeting) {
    return false;
  }
  
  // Don't restore collaborator state if user skipped this meeting
  if (isMeetingSkipped(currentMeeting.url)) {
    return false;
  }
  
  // Check if collaborator info is for the current meeting
  if (!urlsMatchSameMeeting(collaboratorInfo.meetingUrl, currentMeeting.url)) {
    return false;
  }
  
  broadcastCollaboratorState(currentMeeting);
  return true;
}

/**
 * Get Full Disk Access permission status for Teams URL extraction.
 * On macOS, Full Disk Access is required for the Desktop SDK to extract Teams meeting URLs.
 * On Windows, this is not required.
 */
export function getTeamsUrlPermissionStatus(): {
  required: boolean;
  granted: boolean;
  platform: string;
} {
  const platform = process.platform;
  
  // Only required on macOS
  if (platform !== 'darwin') {
    return { required: false, granted: true, platform };
  }
  
  return {
    required: true,
    granted: isFullDiskAccessGranted(),
    platform,
  };
}

/**
 * Request Full Disk Access permission for Teams URL extraction.
 * On macOS, this opens System Settings to the Full Disk Access pane.
 * Returns immediately - user must manually grant permission.
 */
export async function requestTeamsUrlPermission(): Promise<{
  success: boolean;
  alreadyGranted: boolean;
}> {
  const platform = process.platform;
  
  // Not needed on Windows
  if (platform !== 'darwin') {
    return { success: true, alreadyGranted: true };
  }
  
  // If already granted, nothing to do
  if (fullDiskAccessGranted === true) {
    return { success: true, alreadyGranted: true };
  }
  
  // Request via SDK - this will prompt the user or open System Settings
  if (RecallAiSdk) {
    try {
      log.info('Requesting Full Disk Access permission for Teams URL extraction');
      await RecallAiSdk.requestPermission('full-disk-access');
      // Note: The permission status will be updated via the 'permission-status' event
      return { success: true, alreadyGranted: false };
    } catch (error) {
      log.error({ error }, 'Failed to request Full Disk Access permission');
      return { success: false, alreadyGranted: false };
    }
  }
  
  // SDK not initialized - try opening System Settings directly
  try {
    const { shell } = await import('electron');
    await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles');
    log.info('Opened System Settings to Full Disk Access pane');
    return { success: true, alreadyGranted: false };
  } catch (error) {
    log.error({ error }, 'Failed to open System Settings for Full Disk Access');
    return { success: false, alreadyGranted: false };
  }
}

// NOTE: Screen Recording permission is requested on-demand from the first actual
// local-recording start, not here at SDK init — see
// localRecordingService.requestScreenCapturePermission(). It lives there because
// local recording uses that module's own loaded SDK instance; requesting it here
// would prompt users who only ever use cloud bots (which don't need it).
