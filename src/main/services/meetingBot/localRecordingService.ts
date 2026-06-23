/**
 * Local Recording Service
 *
 * Handles local meeting recording as a fallback when cloud bots fail.
 * Uses the Recall Desktop SDK for audio capture and real-time transcription.
 *
 * Key features:
 * - Platform detection (Apple Silicon Mac + Windows only)
 * - Permission checking and requesting
 * - Local recording start/stop
 * - Real-time transcript streaming
 * - Upload and transcript retrieval after recording
 */

import crypto from 'node:crypto';
import { BrowserWindow, systemPreferences, dialog, shell, app } from 'electron';
import { createScopedLogger } from '@core/logger';
import { getSettings } from '@core/services/settingsStore';
import { getRebelAuthProvider } from '@core/rebelAuth';
import { isUpdateQuit } from '../gracefulShutdown';
import type { MeetingStatusSource } from '@shared/ipc/channels/meetingBot';
import { fireAndForget } from '@shared/utils/fireAndForget';
import { getRecallTransport, type RecallTransport } from './recallTransport';
import { saveTranscript, type TranscriptData } from './transcriptStorage';
import { isRecorderInstalled } from './recorderInstallation';

import {
  addPendingLocalUpload,
  getPendingLocalUploads,
  getPendingLocalUploadsNeedingPoll,
  updatePendingLocalUploadStatus,
  removePendingLocalUpload,
  cleanupExpiredUploads,
  type PendingLocalUploadTransport,
} from './pendingLocalUploadsStore';
import { isPhysicalRecordingActive } from '../physicalRecording/physicalRecordingService';
import { isQuickCaptureActive } from '@main/ipc/quickCaptureState';
import {
  registerIsLocalRecordingCapturingProvider,
  registerLocalRecordingStatusProvider,
  registerStopLocalRecordingHandler,
  getActiveBotState,
  getCurrentMeeting,
} from './meetingBotRuntimeRegistry';
import { startLocalTranscriptBuffer, stopBotQA, processTranscriptSegment } from './botQAService';
import { startStateTracking, stopStateTracking } from './conversationStateService';
import { resetBotCoachState, setCoachStartTime } from '../liveCoachService';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';

const log = createScopedLogger({ service: 'local-recording' });

// SDK module - loaded dynamically
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- @recallai/desktop-sdk is loaded via dynamic require and has no exported TS types
let RecallAiSdk: any = null;

/** Local recording state */
interface LocalRecordingState {
  /** TRUE only while audio is being captured (microphone active) */
  isCapturing: boolean;
  /** TRUE during upload/processing after recording stops */
  isUploading: boolean;
  uploadId?: string;
  clientSecret?: string;
  /** Transport that owns this recording (persisted so resume routes by tag). */
  transport?: PendingLocalUploadTransport;
  /** Recall's native upload id — set on the `'direct'` path for status/transcript polls. */
  recallUploadId?: string;
  meetingTitle?: string;
  meetingUrl?: string;
  windowId?: string;
  startTime?: Date;
  quip?: string; // Fixed quip for duration of recording to prevent flickering
  /** Synthetic bot ID for transcript buffer and coaching services: `local-${uploadId}` */
  syntheticBotId?: string;
  // Coaching state
  coachSkillPath?: string;
  companionSessionId?: string;
  presenceMode?: 'silent' | 'coach' | 'participant';
}

let recordingState: LocalRecordingState = { isCapturing: false, isUploading: false };
let recordingDurationInterval: NodeJS.Timeout | null = null;

/**
 * Tracks whether an ACTIVE `local_recording`-source status (e.g. `recording_local`)
 * is currently live in the renderer. The renderer's precedence rules (see
 * MeetingStatusContext.shouldOverrideStatus) reject a lower-precedence `desktop_sdk`
 * status while an active `local_recording` status is showing — so before the first
 * low-precedence background status (upload/processing/done) we must emit a SAME-SOURCE
 * passive clear (`no_meetings`/`local_recording`) to release the active state. Without
 * this, `recording_local` (and its infinite mic-pulse animation) stays stuck forever
 * after the recording stops (FOX-3438).
 */
let activeLocalStatusBroadcast = false;

/** Quips for local recording status */
const LOCAL_RECORDING_QUIPS = [
  'Recording locally.',
  'Taking notes from here.',
  'Capturing this for you.',
  'Listening in.',
  'On it.',
];

function pickRandomQuip(): string {
  return LOCAL_RECORDING_QUIPS[Math.floor(Math.random() * LOCAL_RECORDING_QUIPS.length)];
}

/**
 * Check if local recording is supported on this platform.
 * Note: Messages are platform-agnostic per repo guidelines.
 */
export function isLocalRecordingSupported(): { supported: boolean; reason?: string } {
  if (!isRecorderInstalled()) {
    return {
      supported: false,
      reason: 'Recording components are not available on this system.',
    };
  }

  if (process.platform === 'win32') {
    return { supported: true };
  }
  if (process.platform === 'darwin') {
    if (process.arch === 'arm64') {
      return { supported: true };
    }
    return {
      supported: false,
      reason: 'Local recording requires a newer computer architecture.',
    };
  }
  if (process.platform === 'linux') {
    return {
      supported: false,
      reason: 'Local recording is not available on this operating system.',
    };
  }
  return {
    supported: false,
    reason: 'Local recording is not supported on this platform.',
  };
}

/**
 * Check if local recording is enabled (not disabled via kill switch).
 */
export function isLocalRecordingEnabled(): boolean {
  const settings = getSettings();
  return settings.meetingBot?.localRecordingDisabled !== true;
}

/**
 * Check permissions needed for local recording.
 */
export async function checkPermissions(): Promise<{
  microphone: boolean;
  screenCapture: boolean;
  accessibility: boolean;
  allGranted: boolean;
}> {
  if (process.platform !== 'darwin') {
    // Windows doesn't require explicit permission checks in the same way
    return {
      microphone: true,
      screenCapture: true,
      accessibility: true,
      allGranted: true,
    };
  }

  const microphone = systemPreferences.getMediaAccessStatus('microphone') === 'granted';
  const screenCapture = systemPreferences.getMediaAccessStatus('screen') === 'granted';
  const accessibility = systemPreferences.isTrustedAccessibilityClient(false);

  return {
    microphone,
    screenCapture,
    accessibility,
    allGranted: microphone && screenCapture && accessibility,
  };
}

/**
 * Request permissions for local recording (macOS only).
 * Opens System Settings for permissions that can't be requested programmatically.
 */
export async function requestPermissions(): Promise<{
  success: boolean;
  permissions: {
    microphone: boolean;
    screenCapture: boolean;
    accessibility: boolean;
  };
}> {
  if (process.platform !== 'darwin') {
    return {
      success: true,
      permissions: { microphone: true, screenCapture: true, accessibility: true },
    };
  }

  // Request microphone (can be requested programmatically)
  const micStatus = systemPreferences.getMediaAccessStatus('microphone');
  if (micStatus === 'not-determined') {
    await systemPreferences.askForMediaAccess('microphone');
  } else if (micStatus === 'denied') {
    void shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone').catch((err) => {
      log.error({ err }, 'Failed to open System Settings: Microphone');
    });
  }

  // Screen capture. This is the path the renderer actually calls before starting
  // a recording, so it's where the deferred, in-context request belongs. Ask the
  // SDK first (it pops the native macOS prompt in place — far better UX than a
  // context-switch to System Settings); fall back to opening System Settings if
  // it's already been denied (the SDK won't re-show a denied prompt).
  const screenStatus = systemPreferences.getMediaAccessStatus('screen');
  if (screenStatus !== 'granted') {
    // Load the SDK if needed so we can request the permission in context. If the
    // recorder isn't installed the require throws — fall through to the System
    // Settings fallback rather than breaking the whole permission request.
    if (!RecallAiSdk) {
      try {
        RecallAiSdk = require('@recallai/desktop-sdk').default;
        setupTranscriptListener();
      } catch (err) {
        log.warn({ err }, 'Recall SDK unavailable for in-context screen-capture request; using System Settings fallback');
      }
    }
    await requestScreenCapturePermission();
    if (systemPreferences.getMediaAccessStatus('screen') !== 'granted') {
      void shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture').catch((err) => {
        log.error({ err }, 'Failed to open System Settings: Screen Capture');
      });
    }
  }

  // Accessibility requires System Settings
  if (!systemPreferences.isTrustedAccessibilityClient(false)) {
    void shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility').catch((err) => {
      log.error({ err }, 'Failed to open System Settings: Accessibility');
    });
  }

  // Re-check permissions
  const permissions = await checkPermissions();
  return {
    success: permissions.allGranted,
    permissions,
  };
}

/**
 * Request Screen Recording permission via the Recall SDK, on-demand.
 *
 * Deferred to the first actual local-recording start rather than requested
 * eagerly at SDK init, so users who never record locally aren't hit with the
 * alarming macOS "record this computer's screen and audio" dialog out of
 * context. Mirrors the on-demand FDA-for-Teams deferral in desktopSdkService.
 *
 * Best-effort: failures are logged and swallowed so a permission hiccup never
 * blocks the recording attempt — startLocalRecording re-checks the actual grant
 * status (via checkPermissions) and surfaces a clear error if it's still missing.
 *
 * Idempotent: if Screen Recording is already granted we skip the SDK call
 * entirely (no redundant native dialog).
 *
 * The SDK instance is injectable for tests; production callers pass nothing and
 * it falls back to the module-level instance the caller has already loaded.
 */
export async function requestScreenCapturePermission(
  sdk: { requestPermission: (p: string) => Promise<unknown> } | null = RecallAiSdk,
): Promise<void> {
  if (process.platform !== 'darwin') return;
  if (systemPreferences.getMediaAccessStatus('screen') === 'granted') {
    return; // already granted — nothing to prompt for
  }
  if (!sdk) {
    log.warn('Cannot request screen-capture permission: Recall SDK not loaded');
    return;
  }
  try {
    log.info('Requesting Screen Recording permission for local recording (on-demand)');
    await sdk.requestPermission('screen-capture');
  } catch (error) {
    log.error({ error }, 'Failed to request Screen Recording permission');
  }
}

/**
 * Get user ID for backend auth.
 */
function getUserId(): string | null {
  const authState = getRebelAuthProvider().getAuthState();
  return authState?.user?.id ?? null;
}

/**
 * Generate a random client secret for secure transcript retrieval.
 */
function generateClientSecret(): string {
  return crypto.randomBytes(32).toString('base64');
}

/**
 * Broadcast local recording status to renderer.
 * Uses 'local_recording' source (highest precedence) for active recording states.
 */
function broadcastStatus(state: string, quip?: string): void {
  // eslint-disable-next-line no-restricted-syntax -- window-scan-send-allowlisted: local recording status is a genuine all-window meeting-bot broadcast; migrate later to BroadcastService.
  const windows = BrowserWindow.getAllWindows();
  const duration = recordingState.startTime
    ? Math.floor((Date.now() - recordingState.startTime.getTime()) / 1000)
    : undefined;

  const payload = {
    state,
    source: 'local_recording' as MeetingStatusSource,
    meeting: recordingState.meetingTitle
      ? {
          id: recordingState.uploadId || recordingState.windowId || 'local',
          title: recordingState.meetingTitle,
          startTime: recordingState.startTime?.toISOString() || new Date().toISOString(),
          meetingUrl: recordingState.meetingUrl || '',
        }
      : undefined,
    uploadId: recordingState.uploadId,
    recordingDuration: duration,
    presenceMode: recordingState.presenceMode,
    quip: quip || pickRandomQuip(),
    timestamp: Date.now(),
  };

  activeLocalStatusBroadcast = true;

  for (const window of windows) {
    if (!window.isDestroyed()) {
      window.webContents.send('meeting-bot:status', payload);
    }
  }
}

/**
 * Emit a SAME-SOURCE passive clear (`no_meetings`/`local_recording`) to release any
 * active `local_recording` status the renderer is currently showing. Mirrors the
 * cloud-bot completion pattern (meetingBotService.broadcastBotCompletion): the renderer
 * only lets a same-source passive state override an active state, so this clear must
 * precede the first lower-precedence `desktop_sdk` background status. See FOX-3438.
 */
function broadcastLocalRecordingClear(): void {
  // eslint-disable-next-line no-restricted-syntax -- window-scan-send-allowlisted: local recording clear is a genuine all-window meeting-bot broadcast; migrate later to BroadcastService.
  const windows = BrowserWindow.getAllWindows();
  const payload = {
    state: 'no_meetings' as const,
    source: 'local_recording' as MeetingStatusSource,
    timestamp: Date.now(),
  };
  for (const window of windows) {
    if (!window.isDestroyed()) {
      window.webContents.send('meeting-bot:status', payload);
    }
  }
}

/**
 * Broadcast background upload status to renderer.
 * Uses 'desktop_sdk' source (lowest precedence) so new meeting detection can override.
 * This prevents upload states from blocking user interaction with the next meeting.
 */
function broadcastBackgroundStatus(state: string, quip?: string): void {
  // If an active local_recording status is still showing, clear it first with a
  // same-source passive event — otherwise the renderer's precedence rules reject this
  // lower-precedence desktop_sdk status and the recording state stays stuck (FOX-3438).
  if (activeLocalStatusBroadcast) {
    activeLocalStatusBroadcast = false;
    broadcastLocalRecordingClear();
  }

  // eslint-disable-next-line no-restricted-syntax -- window-scan-send-allowlisted: local recording background status is a genuine all-window meeting-bot broadcast; migrate later to BroadcastService.
  const windows = BrowserWindow.getAllWindows();

  const payload = {
    state,
    source: 'desktop_sdk' as MeetingStatusSource, // Low precedence - won't block new meetings
    meeting: recordingState.meetingTitle
      ? {
          id: recordingState.uploadId || recordingState.windowId || 'local',
          title: recordingState.meetingTitle,
          startTime: recordingState.startTime?.toISOString() || new Date().toISOString(),
          meetingUrl: recordingState.meetingUrl || '',
        }
      : undefined,
    uploadId: recordingState.uploadId,
    quip: quip || 'Processing...',
    timestamp: Date.now(),
  };

  for (const window of windows) {
    if (!window.isDestroyed()) {
      window.webContents.send('meeting-bot:status', payload);
    }
  }
}

/**
 * Surface a recoverable "re-enter your Recall key" state for a pending DIRECT
 * (BYOK) upload that cannot resume because the Recall API key is now absent.
 *
 * Reuses the `meeting-bot:health-warning` channel (same channel as
 * `sdk_init_failed`) so the renderer shows it through the existing health-warning
 * UX rather than a silent failure. Crucially this does NOT touch the persisted
 * record — the upload stays pending and resumes intact once the key is restored,
 * so the transcript is never lost.
 */
function broadcastRecallKeyRequired(meetingTitle?: string): void {
  const detail = meetingTitle ? ` for "${meetingTitle}"` : '';
  const warning =
    `A local recording${detail} is waiting to finish saving, but your Recall API key is missing or no longer works. ` +
    `Re-enter your Recall API key in Settings to finish saving this transcript.`;
  // eslint-disable-next-line no-restricted-syntax -- window-scan-send-allowlisted: Recall key health warning is a genuine all-window meeting-bot broadcast; migrate later to BroadcastService.
  const windows = BrowserWindow.getAllWindows();
  for (const window of windows) {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      try {
        window.webContents.send('meeting-bot:health-warning', {
          warning,
          type: 'sdk_init_failed',
          resolved: false,
          timestamp: Date.now(),
        });
      } catch (error) {
        ignoreBestEffortCleanup(error, {
          operation: 'broadcastRecallKeyRequired',
          reason: 'window tearing down during health-warning broadcast',
        });
      }
    }
  }
}

type RecallTransportResolution =
  | { ok: true; transport: RecallTransport }
  | { ok: false; reason: 'recall_key_required' };

function resolveRecallTransportForUpload(params: {
  uploadId: string;
  transport?: PendingLocalUploadTransport;
  meetingTitle?: string;
}): RecallTransportResolution {
  const settings = getSettings();

  if (params.transport === 'direct' && !settings.meetingBot?.recallApiKey?.trim()) {
    log.warn(
      { uploadId: params.uploadId, meetingTitle: params.meetingTitle },
      'Direct upload cannot continue: Recall API key is missing — surfacing recoverable state (no worker fallback)'
    );
    broadcastRecallKeyRequired(params.meetingTitle);
    return { ok: false, reason: 'recall_key_required' };
  }

  return { ok: true, transport: getRecallTransport(settings, getUserId) };
}

function isRecoverableDirectKeyStatus(transport: PendingLocalUploadTransport | undefined, status: number): boolean {
  return transport === 'direct' && (status === 403 || status === 404);
}

/**
 * Broadcast real-time transcript chunk to renderer.
 */
function broadcastTranscriptChunk(text: string, speaker: string, isFinal: boolean): void {
  // eslint-disable-next-line no-restricted-syntax -- window-scan-send-allowlisted: live transcript chunk is a genuine all-window meeting-bot broadcast; migrate later to BroadcastService.
  const windows = BrowserWindow.getAllWindows();
  const payload = {
    uploadId: recordingState.uploadId,
    text,
    speaker,
    isFinal,
    timestamp: Date.now(),
  };

  for (const window of windows) {
    if (!window.isDestroyed()) {
      window.webContents.send('meeting-bot:transcript-chunk', payload);
    }
  }
}

/**
 * Set up real-time transcript event listener.
 */
function setupTranscriptListener(): void {
  if (!RecallAiSdk) return;

  RecallAiSdk.addEventListener('realtime-event', (event: {
    event?: string;
    data?: {
      data?: {
        words?: Array<{ text: string }>;
        participant?: { name?: string; id?: string };
      };
    };
  }) => {
    if (event.event === 'transcript.data' || event.event === 'transcript.partial_data') {
      const words = event.data?.data?.words;
      if (words && Array.isArray(words) && words.length > 0) {
        const text = words.map(w => w.text).join(' ');
        const speaker = event.data?.data?.participant?.name || 'Unknown Speaker';
        const isFinal = event.event === 'transcript.data';

        log.debug({ text: text.substring(0, 50), speaker, isFinal }, 'Transcript chunk received');
        broadcastTranscriptChunk(text, speaker, isFinal);

        // Feed final transcript segments into the transcript buffer for coaching services
        if (isFinal && recordingState.isCapturing && recordingState.syntheticBotId) {
          processTranscriptSegment(recordingState.syntheticBotId, speaker, text, isFinal);
        }
      }
    }
  });

  log.info('Real-time transcript listener set up');
}

/**
 * Start local recording for the current meeting.
 */
export async function startLocalRecording(params: {
  meetingTitle?: string;
  windowId?: string;
}): Promise<{ success: boolean; uploadId?: string; error?: string }> {
  const { meetingTitle, windowId } = params;

  // Check platform support
  const platformCheck = isLocalRecordingSupported();
  if (!platformCheck.supported) {
    return { success: false, error: platformCheck.reason };
  }

  // Check if feature is enabled
  if (!isLocalRecordingEnabled()) {
    return { success: false, error: 'Local recording is disabled' };
  }

  // Load the SDK (if not already) so we can request Screen Recording in context.
  if (!RecallAiSdk) {
    RecallAiSdk = require('@recallai/desktop-sdk').default;
    setupTranscriptListener();
  }

  // Request Screen Recording permission on-demand, now that the user has
  // actually started a local recording. We deliberately do NOT request this at
  // SDK init — that popped the macOS "record this computer's screen and audio"
  // dialog ~unprompted at startup. checkPermissions() below re-reads the real
  // grant status and surfaces a clear error if it's still missing, so this
  // request is best-effort (a hiccup here must not block the attempt).
  await requestScreenCapturePermission();

  // Check permissions
  const permissions = await checkPermissions();
  if (!permissions.allGranted) {
    return { success: false, error: 'Missing required permissions' };
  }

  // Check if already capturing audio
  if (recordingState.isCapturing) {
    return { success: false, error: 'Already recording' };
  }

  // Mutual exclusion: don't start local recording while a cloud bot is ACTUALLY recording
  // Check the real-time UI state, not just pending transcript status - a bot stuck in
  // 'waiting_too_long' or 'rejected' state is NOT recording and shouldn't block Plan B
  const activeBotUiState = getActiveBotState();
  const isCloudBotActuallyRecording = activeBotUiState?.uiState === 'recording';
  
  if (isCloudBotActuallyRecording) {
    log.warn(
      { botId: activeBotUiState.botId, uiState: activeBotUiState.uiState },
      'Cannot start local recording: cloud bot is actively recording'
    );
    return { success: false, error: 'Cloud bot is recording. Cancel it first to record locally.' };
  }

  // Mutual exclusion: don't start local recording while physical recording is capturing
  if (isPhysicalRecordingActive()) {
    log.warn('Cannot start local recording: physical recording is active');
    return { success: false, error: 'Physical recording is active. Stop it first to record locally.' };
  }

  // Mutual exclusion: don't start local recording while quick capture is active
  if (isQuickCaptureActive()) {
    log.warn('Cannot start local recording: quick capture is active');
    return { success: false, error: 'Quick capture is active. Stop it first to record locally.' };
  }

  try {
    // SDK is already loaded above (before the permission request/check).
    const effectiveWindowId = windowId || 'default';

    // Prepare desktop audio FIRST before creating upload session.
    // If this fails, we fail early without leaking an upload session.
    try {
      log.info({ windowId: effectiveWindowId }, 'Preparing desktop audio recording');
      const audioDevice = await RecallAiSdk.prepareDesktopAudioRecording();
      log.info({ audioDevice }, 'Desktop audio prepared successfully');
    } catch (audioError) {
      const audioErrorMsg = audioError instanceof Error ? audioError.message : 'Unknown error';
      log.error({ error: audioErrorMsg }, 'Failed to prepare desktop audio recording');
      return {
        success: false,
        error: 'Could not access audio. Check that microphone and screen capture permissions are granted in System Settings.',
      };
    }

    // Generate client secret for secure transcript retrieval
    const clientSecret = generateClientSecret();

    // Get upload token (only after audio prep succeeds). Routed via the transport
    // factory: a user-supplied Recall key → direct-to-Recall, else the Worker.
    const settingsForTransport = getSettings();
    const transportTag: PendingLocalUploadTransport =
      settingsForTransport.meetingBot?.recallApiKey?.trim() ? 'direct' : 'worker';
    log.info({ meetingTitle, transport: transportTag }, 'Requesting upload session');
    const transport = getRecallTransport(settingsForTransport, getUserId);
    const createResult = await transport.createUploadSession({
      meetingTitle: meetingTitle || 'Meeting',
      clientSecret,
    });

    if (!createResult.ok) {
      log.error({ status: createResult.status, error: createResult.errorText }, 'Failed to create upload session');
      return { success: false, error: 'Failed to create upload session' };
    }

    const uploadData = createResult.data;
    const uploadToken = uploadData.upload_token || uploadData.uploadUrl;
    
    if (!uploadToken) {
      log.error({ uploadData }, 'Worker did not return upload_token');
      return { success: false, error: 'Invalid upload session response' };
    }
    
    log.info({ uploadId: uploadData.uploadId, hasToken: !!uploadToken }, 'Upload session created');

    // Start recording via SDK - uses uploadToken
    await RecallAiSdk.startRecording({
      windowId: effectiveWindowId,
      uploadToken: uploadToken,
    });

    // Pick a fixed quip for the duration of this recording (prevents UI flickering)
    const recordingQuip = pickRandomQuip();

    // Capture meeting URL from Desktop SDK's detected meeting (if available)
    const detectedMeeting = getCurrentMeeting();
    const meetingUrl = detectedMeeting?.url || '';

    // Update state - store the effective windowId to ensure stopRecording works
    recordingState = {
      isCapturing: true,
      isUploading: false,
      uploadId: uploadData.uploadId,
      clientSecret,
      transport: transportTag,
      recallUploadId: uploadData.recallUploadId,
      meetingTitle: meetingTitle || 'Meeting',
      meetingUrl,
      windowId: effectiveWindowId,
      startTime: new Date(),
      quip: recordingQuip,
      syntheticBotId: `local-${uploadData.uploadId}`,
    };

    // Start transcript buffer for coaching/live coach services
    const syntheticBotId = `local-${uploadData.uploadId}`;
    const settings = getSettings();
    const ownerName = settings.userFirstName?.trim() || 'User';
    const triggerPhrase = settings.meetingBot?.triggerPhrase ?? null;
    const hasExplicitTriggerPhrase = typeof triggerPhrase === 'string' && triggerPhrase.trim().length > 0;
    const localRecordingTriggerListening = settings.meetingBot?.localRecordingTriggerListening ?? hasExplicitTriggerPhrase;
    const outputMode = localRecordingTriggerListening
      ? 'companion-only-question-listening'
      : 'silent';

    startLocalTranscriptBuffer(syntheticBotId, ownerName, {
      outputMode,
      triggerPhrase,
      triggerSessionId: uploadData.uploadId,
    });
    startStateTracking(syntheticBotId);

    // Start duration broadcast interval - use fixed quip to prevent flickering
    recordingDurationInterval = setInterval(() => {
      if (recordingState.isCapturing) {
        broadcastStatus('recording_local', recordingState.quip);
      }
    }, 1000);

    // Broadcast initial status
    broadcastStatus('recording_local', recordingQuip);

    log.info({
      uploadId: uploadData.uploadId,
      meetingTitle,
      syntheticBotId: recordingState.syntheticBotId,
      outputMode,
      localRecordingTriggerListening,
      hasExplicitTriggerPhrase,
    }, 'Local recording started');
    return { success: true, uploadId: uploadData.uploadId };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    log.error({ error: message }, 'Failed to start local recording');
    // Reset SDK on error to allow retry
    RecallAiSdk = null;
    return { success: false, error: message };
  }
}

/**
 * Stop local recording and begin upload.
 */
export async function stopLocalRecording(): Promise<{ success: boolean; error?: string }> {
  if (!recordingState.isCapturing) {
    // Idempotent: if already stopped but upload in progress, return success
    // This handles race condition where meeting close auto-stops, then UI calls stop
    if (recordingState.isUploading) {
      log.debug({ uploadId: recordingState.uploadId }, 'Stop called but already uploading - returning success');
      return { success: true };
    }
    return { success: false, error: 'Not recording' };
  }

  try {
    // Stop duration interval
    if (recordingDurationInterval) {
      clearInterval(recordingDurationInterval);
      recordingDurationInterval = null;
    }

    // Transition from capturing to uploading
    // This allows new meeting detection to override (upload uses low-precedence source)
    recordingState.isCapturing = false;
    recordingState.isUploading = true;

    // Clear coaching state on stop
    recordingState.coachSkillPath = undefined;
    recordingState.companionSessionId = undefined;
    recordingState.presenceMode = undefined;

    // Clean up transcript buffer, conversation state tracking, and coach state
    if (recordingState.syntheticBotId) {
      fireAndForget(stopBotQA(recordingState.syntheticBotId), 'meetingBot.localRecordingService.line617');
      stopStateTracking(recordingState.syntheticBotId);
      resetBotCoachState(recordingState.syntheticBotId);
    }

    // Update status to uploading - uses low precedence so new meetings can override
    broadcastBackgroundStatus('uploading_local', 'Uploading recording...');

    // Stop recording via SDK
    if (RecallAiSdk && recordingState.windowId) {
      await RecallAiSdk.stopRecording({ windowId: recordingState.windowId });
      
      // Explicitly trigger upload - SDK doesn't auto-upload
      log.info({ windowId: recordingState.windowId }, 'Triggering SDK upload');
      await RecallAiSdk.uploadRecording({ windowId: recordingState.windowId });
    }

    log.info({ uploadId: recordingState.uploadId }, 'Local recording stopped, upload started');

    // Persist upload state for restart recovery. Tag the owning transport so
    // resume routes by the PERSISTED transport, not the current key state — a
    // 'direct' upload must never silently fall back to the worker on restart.
    if (recordingState.uploadId && recordingState.clientSecret) {
      addPendingLocalUpload({
        uploadId: recordingState.uploadId,
        clientSecret: recordingState.clientSecret,
        meetingTitle: recordingState.meetingTitle || 'Meeting',
        transport: recordingState.transport ?? 'worker',
        recallUploadId: recordingState.recallUploadId,
      });
    }

    // Start polling for upload completion
    fireAndForget(pollUploadCompletion(), 'meetingBot.localRecordingService.line646');

    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    log.error({ 
      error: message, 
      uploadId: recordingState.uploadId,
      windowId: recordingState.windowId,
      meetingTitle: recordingState.meetingTitle,
    }, 'Failed to stop local recording');

    // Reset state on error - show failure state with low precedence
    recordingState = { isCapturing: false, isUploading: false };
    broadcastBackgroundStatus('upload_failed', 'Recording failed to save');

    return { success: false, error: message };
  }
}

/** Polling constants for upload completion — shared between normal flow and restart recovery */
const UPLOAD_POLL_MAX_ATTEMPTS = 360;   // 360 × 30s = 3 hours
const UPLOAD_POLL_INTERVAL_MS = 30_000; // 30 seconds

/**
 * Format elapsed time for upload progress display.
 */
function formatElapsedTime(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}m ${secs}s`;
}

/**
 * Poll upload status and update local transcript processing state.
 */
async function pollUploadStatus(params: {
  uploadId: string;
  clientSecret: string;
  recallUploadId?: string;
  transport?: PendingLocalUploadTransport;
  meetingTitle?: string;
  statusPrefix: string;
  clearInMemoryState?: () => void;
}): Promise<void> {
  const { uploadId, clientSecret, recallUploadId, transport: transportTag, meetingTitle, statusPrefix, clearInMemoryState } = params;
  const startTime = Date.now();
  let attempts = 0;

  const poll = async (): Promise<void> => {
    const elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);
    const elapsedStr = formatElapsedTime(elapsedSeconds);

    try {
      const transportResolution = resolveRecallTransportForUpload({ uploadId, transport: transportTag, meetingTitle });
      if (!transportResolution.ok) {
        // Recoverable: waiting for the user to re-enter their Recall key. Don't count
        // this cycle against the attempt budget — only real status calls consume attempts.
        broadcastBackgroundStatus('uploading_local', `Waiting for Recall API key... (${elapsedStr})`);
        setTimeout(() => void poll(), UPLOAD_POLL_INTERVAL_MS);
        return;
      }

      attempts++;
      const statusResult = await transportResolution.transport.getUploadStatus({ uploadId, clientSecret, recallUploadId });

      if (!statusResult.ok) {
        if (isRecoverableDirectKeyStatus(transportTag, statusResult.status)) {
          log.warn(
            { uploadId, status: statusResult.status, attempt: attempts },
            'Direct upload status poll paused in recoverable state'
          );
          broadcastRecallKeyRequired(meetingTitle);
          broadcastBackgroundStatus('uploading_local', `Waiting for Recall API key... (${elapsedStr})`);
          setTimeout(() => void poll(), UPLOAD_POLL_INTERVAL_MS);
          return;
        }

        log.warn({ uploadId, status: statusResult.status, attempt: attempts }, 'Failed to get upload status');
        if (attempts < UPLOAD_POLL_MAX_ATTEMPTS) {
          broadcastBackgroundStatus('uploading_local', `${statusPrefix}... (${elapsedStr})`);
          setTimeout(() => void poll(), UPLOAD_POLL_INTERVAL_MS);
        } else {
          log.warn({ uploadId }, 'Upload polling timeout after repeated failures');
          clearInMemoryState?.();
          updatePendingLocalUploadStatus(uploadId, 'failed', 'Upload timed out');
          broadcastBackgroundStatus('upload_failed', 'Upload timed out');
        }
        return;
      }

      const data = statusResult.data;

      log.debug({ uploadId, attempt: attempts, data }, 'Upload status poll response');

      if (data.transcriptReady) {
        log.info({ uploadId, recordingId: data.recordingId, transcriptId: data.transcriptId }, 'Upload complete, transcript ready');
        broadcastBackgroundStatus('processing_local', 'Processing transcript...');
        
        // Update persisted state
        updatePendingLocalUploadStatus(uploadId, 'transcribing');

        clearInMemoryState?.();

        // Process and save transcript directly in main process
        const result = await processAndSaveLocalRecording({
          uploadId,
          clientSecret,
          recallUploadId,
          transport: transportTag,
          meetingTitle,
        });
        
        // Remove from persistence on success, mark failed on error
        if (result.success) {
          removePendingLocalUpload(uploadId);
        } else if (result.recoverable) {
          log.warn({ uploadId, error: result.error }, 'Transcript processing paused in recoverable state');
          broadcastBackgroundStatus('processing_local', 'Waiting for Recall API key...');
          setTimeout(() => void poll(), UPLOAD_POLL_INTERVAL_MS);
        } else {
          updatePendingLocalUploadStatus(uploadId, 'failed', result.error);
        }
      } else if (data.transcriptFailed || data.status === 'failed') {
        // Handle both upload failure and transcription failure
        const errorMsg = data.asyncError || 'Upload failed';
        log.error({ uploadId, asyncError: data.asyncError }, 'Upload or transcription failed');
        clearInMemoryState?.();
        updatePendingLocalUploadStatus(uploadId, 'failed', errorMsg);
        broadcastBackgroundStatus('upload_failed', errorMsg);
      } else {
        // Still uploading/processing - show progress with elapsed time
        if (attempts < UPLOAD_POLL_MAX_ATTEMPTS) {
          broadcastBackgroundStatus('uploading_local', `${statusPrefix}... (${elapsedStr})`);
          setTimeout(() => void poll(), UPLOAD_POLL_INTERVAL_MS);
        } else {
          log.warn({ uploadId }, 'Upload polling timeout');
          clearInMemoryState?.();
          updatePendingLocalUploadStatus(uploadId, 'failed', 'Upload timed out');
          broadcastBackgroundStatus('upload_failed', 'Upload timed out');
        }
      }
    } catch (error) {
      log.warn({ uploadId, error, attempt: attempts }, 'Error polling upload status');
      if (attempts < UPLOAD_POLL_MAX_ATTEMPTS) {
        broadcastBackgroundStatus('uploading_local', `${statusPrefix}... (${elapsedStr})`);
        setTimeout(() => void poll(), UPLOAD_POLL_INTERVAL_MS);
      } else {
        log.warn({ uploadId }, 'Upload polling timeout after repeated errors');
        clearInMemoryState?.();
        updatePendingLocalUploadStatus(uploadId, 'failed', 'Upload timed out after errors');
        broadcastBackgroundStatus('upload_failed', 'Upload timed out');
      }
    }
  };

  fireAndForget(poll(), 'meetingBot.localRecordingService.line789');
}

/**
 * Poll for upload completion and update status.
 */
async function pollUploadCompletion(): Promise<void> {
  const uploadId = recordingState.uploadId;
  const clientSecret = recordingState.clientSecret;

  if (!uploadId || !clientSecret) {
    log.warn('No upload ID or client secret for polling');
    recordingState = { isCapturing: false, isUploading: false };
    return;
  }

  await pollUploadStatus({
    uploadId,
    clientSecret,
    recallUploadId: recordingState.recallUploadId,
    transport: recordingState.transport ?? 'worker',
    meetingTitle: recordingState.meetingTitle,
    statusPrefix: 'Uploading',
    clearInMemoryState: () => {
      recordingState = { isCapturing: false, isUploading: false };
    },
  });
}

/**
 * Poll a pending local upload for transcript completion (restart recovery path).
 * Works from persisted state rather than in-memory recordingState.
 * Uses the same polling interval and timeout as the normal flow (pollUploadCompletion).
 */
async function pollPendingUpload(params: {
  uploadId: string;
  clientSecret: string;
  recallUploadId?: string;
  transport?: PendingLocalUploadTransport;
  meetingTitle?: string;
}): Promise<void> {
  await pollUploadStatus({
    ...params,
    statusPrefix: 'Processing',
  });
}

/**
 * Get current local recording status.
 */
export function getLocalRecordingStatus(): {
  isRecording: boolean;
  isCapturing: boolean;
  isUploading: boolean;
  uploadId?: string;
  meetingTitle?: string;
  meetingUrl?: string;
  startTime?: string;
  syntheticBotId?: string;
  coachSkillPath?: string;
  companionSessionId?: string;
  presenceMode?: 'silent' | 'coach' | 'participant';
} {
  return {
    // isRecording = true if either capturing or uploading (for backward compatibility)
    isRecording: recordingState.isCapturing || recordingState.isUploading,
    isCapturing: recordingState.isCapturing,
    isUploading: recordingState.isUploading,
    uploadId: recordingState.uploadId,
    meetingTitle: recordingState.meetingTitle,
    meetingUrl: recordingState.meetingUrl,
    startTime: recordingState.startTime?.toISOString(),
    syntheticBotId: recordingState.syntheticBotId,
    coachSkillPath: recordingState.coachSkillPath,
    companionSessionId: recordingState.companionSessionId,
    presenceMode: recordingState.presenceMode,
  };
}

/**
 * Check if local recording is currently capturing audio.
 * Use this for mutual exclusion checks - only block during capture, not upload.
 */
export function isLocalRecordingCapturing(): boolean {
  return recordingState.isCapturing;
}

// Register accessors at module load so sibling services (desktopSdkService,
// meetingBotService, activeMeetingSession) can read via meetingBotRuntimeRegistry
// without importing back into this module (breaks several cycles in the cluster).
registerIsLocalRecordingCapturingProvider(isLocalRecordingCapturing);
registerLocalRecordingStatusProvider(getLocalRecordingStatus);
registerStopLocalRecordingHandler(stopLocalRecording);

/**
 * Handle app quit while recording is active.
 * Returns true if quit should proceed, false if it should be cancelled.
 */
export async function handleAppQuitDuringRecording(): Promise<boolean> {
  if (!recordingState.isCapturing) {
    return true; // Not capturing audio, safe to quit (uploading can continue in background)
  }

  const result = await dialog.showMessageBox({
    type: 'warning',
    title: 'Recording in Progress',
    message: 'A local recording is still active.',
    detail: 'Quitting now will lose the recording. Stop and save first?',
    buttons: ['Stop Recording & Quit', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
  });

  if (result.response === 0) {
    // User chose to stop and quit
    await stopLocalRecording();
    return true;
  }

  // User cancelled
  return false;
}

/**
 * Fetch and return transcript for a completed local recording upload.
 * Returns the transcript data in the same format as cloud bot transcripts.
 */
export async function fetchLocalRecordingTranscript(params: {
  uploadId: string;
  clientSecret: string;
  recallUploadId?: string;
}): Promise<{
  success: boolean;
  transcript?: string;
  participants?: string[];
  duration?: number;
  meetingTitle?: string;
  startTime?: string;
  error?: string;
}> {
  const { uploadId, clientSecret, recallUploadId } = params;

  try {
    // Route by the upload's PERSISTED transport tag (not current settings) so a
    // direct upload can never silently fall back to the worker on a missing/changed
    // key — same safe-resolution invariant as the resume/poll paths.
    const record = getPendingLocalUploads().find((u) => u.uploadId === uploadId);
    const effectiveRecallUploadId = recallUploadId ?? record?.recallUploadId;
    const transportResolution = resolveRecallTransportForUpload({
      uploadId,
      transport: record?.transport,
      meetingTitle: record?.meetingTitle,
    });
    if (!transportResolution.ok) {
      return { success: false, error: 'Recall API key required to fetch this transcript' };
    }
    const transcriptResult = await transportResolution.transport.getUploadTranscript({ uploadId, clientSecret, recallUploadId: effectiveRecallUploadId });

    if (!transcriptResult.ok) {
      log.error({ uploadId, status: transcriptResult.status, error: transcriptResult.errorText }, 'Failed to fetch local recording transcript');
      return { success: false, error: `Failed to fetch transcript: ${transcriptResult.status}` };
    }

    const data = transcriptResult.data;

    if (!data.success) {
      return { success: false, error: 'Transcript not ready' };
    }

    log.info({ uploadId, participants: data.participants?.length, duration: data.duration }, 'Local recording transcript fetched');

    // Clear the processing state and broadcast done (low precedence)
    broadcastBackgroundStatus('done', 'Transcript saved');

    return {
      success: true,
      transcript: data.transcript,
      participants: data.participants,
      duration: data.duration,
      meetingTitle: data.meetingTitle,
      startTime: data.startTime,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    log.error({ uploadId, error: message }, 'Error fetching local recording transcript');
    return { success: false, error: message };
  }
}

/**
 * Transcript fetch retry configuration.
 *
 * Recall's status endpoint sometimes reports "complete" before the transcript
 * text is actually queryable. To handle this race condition we retry with
 * exponential backoff for up to 24 hours rather than giving up after ~38 s.
 *
 *  Attempt   Delay        Cumulative
 *  1          5 s            5 s
 *  2         10 s           15 s
 *  3         20 s           35 s
 *  4         40 s          ~1 min
 *  5         80 s          ~2 min
 *  6        160 s          ~5 min
 *  7        300 s (cap)   ~10 min
 *  8+       300 s (cap)   ...continues to 24 h
 */
const TRANSCRIPT_FETCH_INITIAL_DELAY_MS = 5_000;
const TRANSCRIPT_FETCH_MAX_DELAY_MS = 5 * 60 * 1_000; // 5 minutes
const TRANSCRIPT_FETCH_MAX_DURATION_MS = 24 * 60 * 60 * 1_000; // 24 hours
const TRANSCRIPT_FETCH_BACKOFF_FACTOR = 2;

/**
 * Helper to sleep for a given duration with optional jitter.
 */
function sleep(ms: number, jitterMs = 0): Promise<void> {
  const delay = ms + Math.floor(Math.random() * jitterMs);
  return new Promise(resolve => setTimeout(resolve, delay));
}

/**
 * Compute the next retry delay using exponential backoff.
 */
function getTranscriptRetryDelay(attempt: number): number {
  const delay = TRANSCRIPT_FETCH_INITIAL_DELAY_MS * Math.pow(TRANSCRIPT_FETCH_BACKOFF_FACTOR, attempt);
  return Math.min(delay, TRANSCRIPT_FETCH_MAX_DELAY_MS);
}

/**
 * Process and save a local recording transcript.
 * Fetches the transcript from the Worker, saves to appropriate space, and emits events.
 * Includes retry logic for the Recall API race condition where status=complete but transcript not yet available.
 */
export async function processAndSaveLocalRecording(params: {
  uploadId: string;
  clientSecret: string;
  recallUploadId?: string;
  transport?: PendingLocalUploadTransport;
  meetingTitle?: string;
}): Promise<{ success: boolean; filePath?: string; error?: string; recoverable?: boolean }> {
  const { uploadId, clientSecret, recallUploadId, transport: transportTag, meetingTitle } = params;

  log.info({ uploadId, meetingTitle }, 'Processing and saving local recording transcript');

  let lastError: string | undefined;
  let data: {
    success: boolean;
    transcript: string;
    participants: string[];
    duration: number;
    meetingTitle: string;
    startTime: string;
    error?: string;
  } | undefined;

  // Retry loop with exponential backoff (up to 24 h) to handle the Recall API
  // race condition where the status endpoint reports "complete" before the
  // transcript text is actually queryable.
  const startedAt = Date.now();
  let attempt = 0;

  while (Date.now() - startedAt < TRANSCRIPT_FETCH_MAX_DURATION_MS) {
    if (attempt > 0) {
      const delay = getTranscriptRetryDelay(attempt - 1);
      const elapsedMin = Math.round((Date.now() - startedAt) / 60_000);
      log.info({ uploadId, attempt, delayMs: delay, elapsedMin }, 'Waiting before transcript fetch retry');
      broadcastBackgroundStatus('processing_local', `Waiting for transcript... (${elapsedMin}m)`);
      await sleep(delay, Math.min(delay * 0.2, 5_000)); // jitter up to 20% of delay, max 5 s
    }
    attempt++;

    try {
      const transportResolution = resolveRecallTransportForUpload({ uploadId, transport: transportTag, meetingTitle });
      if (!transportResolution.ok) {
        return { success: false, error: 'Recall API key required', recoverable: true };
      }

      const transcriptResult = await transportResolution.transport.getUploadTranscript({ uploadId, clientSecret, recallUploadId });

      if (!transcriptResult.ok) {
        lastError = `HTTP ${transcriptResult.status}: ${transcriptResult.errorText}`;

        if (isRecoverableDirectKeyStatus(transportTag, transcriptResult.status)) {
          log.warn(
            { uploadId, status: transcriptResult.status, error: transcriptResult.errorText },
            'Direct upload transcript fetch paused in recoverable state'
          );
          broadcastRecallKeyRequired(meetingTitle);
          return { success: false, error: 'Recall API key required', recoverable: true };
        }

        // Terminal errors - don't retry
        if (transcriptResult.status === 403 || transcriptResult.status === 404) {
          log.error({ uploadId, status: transcriptResult.status, error: transcriptResult.errorText }, 'Terminal error fetching transcript - not retrying');
          break;
        }

        log.warn({ uploadId, status: transcriptResult.status, attempt }, 'Failed to fetch transcript, will retry');
        continue;
      }

      data = transcriptResult.data;

      if (data?.success && data.transcript) {
        const totalSeconds = Math.round((Date.now() - startedAt) / 1_000);
        log.info({ uploadId, attempt, totalSeconds }, 'Transcript fetch successful');
        break; // Success!
      }

      // Transcript not ready yet - this is the race condition we're handling
      lastError = data?.error || 'Transcript not ready or empty';
      log.info({ uploadId, attempt, error: lastError }, 'Transcript not ready yet, will retry');

    } catch (error) {
      lastError = error instanceof Error ? error.message : 'Unknown error';
      log.warn({ uploadId, attempt, error: lastError }, 'Error fetching transcript, will retry');
    }
  }

  // Check if we got the transcript
  if (!data?.success || !data.transcript) {
    const totalMin = Math.round((Date.now() - startedAt) / 60_000);
    log.error({ uploadId, lastError, attempts: attempt, totalMin }, 'Failed to fetch transcript after all retries');
    broadcastBackgroundStatus('upload_failed', 'Transcript not ready');
    return { success: false, error: lastError || 'Transcript not ready after retries' };
  }

  // Build transcript data for saving
  const transcriptData: TranscriptData = {
    botId: `local-${uploadId}`, // Prefix to distinguish from cloud bot IDs
    meetingTitle: data.meetingTitle || meetingTitle || 'Local Recording',
    meetingUrl: '', // Local recordings don't have a meeting URL
    participants: data.participants || [],
    duration: data.duration || 0,
    startTime: data.startTime || new Date().toISOString(),
    rawTranscript: data.transcript,
    transcriptQuality: 'desktop_sdk',
    sourceSystem: 'desktop_sdk', // Distinguish from cloud bot transcripts
  };

  // Save to appropriate space
  const saveResult = await saveTranscript(transcriptData);

  if (!saveResult.success || (!saveResult.filePath && !saveResult.staged)) {
    log.error({ uploadId, error: saveResult.error }, 'Failed to save local recording transcript');
    broadcastBackgroundStatus('upload_failed', 'Failed to save transcript');
    return { success: false, error: saveResult.error ?? 'Save returned no file path' };
  }

  log.info({ uploadId, filePath: saveResult.filePath, staged: saveResult.staged }, 'Local recording transcript saved');

  // saveTranscript() now owns emit/defer behaviour via the meeting-source kernel.
  if (saveResult.staged) {
    log.info({ uploadId }, 'Transcript staged for review, event deferred until approval');
  }

  // Broadcast success with low precedence (doesn't block new meeting)
  broadcastBackgroundStatus('done', saveResult.staged ? 'Transcript staged for review' : 'Transcript saved');

  return { success: true, filePath: saveResult.filePath };
}

/**
 * Resume polling for any pending local uploads that were interrupted (e.g., app restart).
 * Should be called during app startup.
 *
 * Checks the backend status endpoint first for each upload:
 * - Transcript ready → process immediately
 * - Still processing → start background polling (same interval/timeout as normal flow)
 * - Failed → mark as failed
 * - Status check fails → start background polling (will retry)
 */
export async function resumePendingLocalUploads(): Promise<void> {
  // Clean up expired uploads first
  cleanupExpiredUploads();
  
  const pendingUploads = getPendingLocalUploadsNeedingPoll();
  if (pendingUploads.length === 0) {
    log.debug('No pending local uploads to resume');
    return;
  }
  
  log.info({ count: pendingUploads.length }, 'Resuming pending local uploads');

  for (const upload of pendingUploads) {
    log.info({ uploadId: upload.uploadId, meetingTitle: upload.meetingTitle, status: upload.status, transport: upload.transport }, 'Resuming upload');

    // SAFE RESUME: route by the PERSISTED transport tag, never by the current key
    // state. A 'direct' (BYOK) upload whose Recall key is now absent must NOT fall
    // back to the worker (the worker has no record of it → silent transcript loss).
    // Surface a recoverable state instead and leave the record in place so it
    // resumes once the user re-enters their key.
    if (upload.transport === 'direct') {
      const directKey = getSettings().meetingBot?.recallApiKey?.trim();
      if (!directKey) {
        log.warn(
          { uploadId: upload.uploadId, meetingTitle: upload.meetingTitle },
          'Direct upload cannot resume: Recall API key is missing — surfacing recoverable state (no worker fallback)'
        );
        broadcastRecallKeyRequired(upload.meetingTitle);
        // Do NOT poll, do NOT mark failed, do NOT remove — the record stays pending
        // so it resumes intact after the key is re-entered.
        continue;
      }
    }

    // Check status first — only process immediately if transcript is already ready,
    // otherwise start background polling (same as normal flow)
    try {
      const transport = getRecallTransport(getSettings(), getUserId);
      const statusResult = await transport.getUploadStatus({
        uploadId: upload.uploadId,
        clientSecret: upload.clientSecret,
        recallUploadId: upload.recallUploadId,
      });

      if (!statusResult.ok) {
        // Can't determine status — start background polling (will retry)
        log.warn(
          { uploadId: upload.uploadId, status: statusResult.status },
          'Status check failed on restart, starting background polling'
        );
        fireAndForget(pollPendingUpload({
          uploadId: upload.uploadId,
          clientSecret: upload.clientSecret,
          recallUploadId: upload.recallUploadId,
          transport: upload.transport,
          meetingTitle: upload.meetingTitle,
        }), 'meetingBot.localRecordingService.line1181');
        continue;
      }

      const data = statusResult.data;

      if (data.transcriptReady) {
        // Transcript is ready — process immediately
        log.info({ uploadId: upload.uploadId }, 'Transcript ready on restart, processing immediately');
        try {
          const result = await processAndSaveLocalRecording({
            uploadId: upload.uploadId,
            clientSecret: upload.clientSecret,
            recallUploadId: upload.recallUploadId,
            transport: upload.transport,
            meetingTitle: upload.meetingTitle,
          });

          if (result.success) {
            log.info({ uploadId: upload.uploadId }, 'Resumed upload completed successfully');
            removePendingLocalUpload(upload.uploadId);
          } else if (result.recoverable) {
            log.warn({ uploadId: upload.uploadId, error: result.error }, 'Resumed upload paused in recoverable state');
            setTimeout(
              () => void pollPendingUpload({
                uploadId: upload.uploadId,
                clientSecret: upload.clientSecret,
                recallUploadId: upload.recallUploadId,
                transport: upload.transport,
                meetingTitle: upload.meetingTitle,
              }),
              UPLOAD_POLL_INTERVAL_MS,
            );
          } else {
            log.warn({ uploadId: upload.uploadId, error: result.error }, 'Resumed upload processing failed');
            updatePendingLocalUploadStatus(upload.uploadId, 'failed', result.error);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          log.error({ uploadId: upload.uploadId, error: message }, 'Error processing resumed upload');
          updatePendingLocalUploadStatus(upload.uploadId, 'failed', message);
        }
      } else if (data.transcriptFailed || data.status === 'failed') {
        // Permanent failure — mark as failed
        const errorMsg = data.asyncError || 'Transcription failed';
        log.error({ uploadId: upload.uploadId, asyncError: data.asyncError }, 'Upload failed (detected on restart)');
        updatePendingLocalUploadStatus(upload.uploadId, 'failed', errorMsg);
      } else {
        // Still processing — start background polling (same as normal flow)
        log.info(
          { uploadId: upload.uploadId, status: data.status },
          'Upload still processing on restart, starting background polling'
        );
        fireAndForget(pollPendingUpload({
          uploadId: upload.uploadId,
          clientSecret: upload.clientSecret,
          recallUploadId: upload.recallUploadId,
          transport: upload.transport,
          meetingTitle: upload.meetingTitle,
        }), 'meetingBot.localRecordingService.line1230');
      }
    } catch (error) {
      // Network error on status check — start background polling (will retry)
      const message = error instanceof Error ? error.message : 'Unknown error';
      log.warn(
        { uploadId: upload.uploadId, error: message },
        'Error checking upload status on restart, starting background polling'
      );
      fireAndForget(pollPendingUpload({
        uploadId: upload.uploadId,
        clientSecret: upload.clientSecret,
        recallUploadId: upload.recallUploadId,
        transport: upload.transport,
        meetingTitle: upload.meetingTitle,
      }), 'meetingBot.localRecordingService.line1243');
    }
  }
}

// =============================================================================
// Coaching state accessors
// =============================================================================

/**
 * Get local recording coaching state, or null if not actively capturing.
 */
export function getLocalRecordingCoachState(): {
  coachSkillPath?: string;
  companionSessionId?: string;
  presenceMode?: 'silent' | 'coach' | 'participant';
} | null {
  if (!recordingState.isCapturing) return null;
  return {
    coachSkillPath: recordingState.coachSkillPath,
    companionSessionId: recordingState.companionSessionId,
    presenceMode: recordingState.presenceMode,
  };
}

/**
 * Set or clear the coach for local recording.
 * Setting a coach also sets presenceMode to 'coach'; clearing sets it to 'silent'.
 */
export function setLocalRecordingCoach(
  params: { coachSkillPath: string; companionSessionId: string } | null
): void {
  if (!recordingState.isCapturing) {
    log.warn('Cannot set coach: no local recording in progress');
    return;
  }
  if (params) {
    recordingState.coachSkillPath = params.coachSkillPath;
    recordingState.companionSessionId = params.companionSessionId;
    recordingState.presenceMode = 'coach';
    if (recordingState.syntheticBotId) {
      setCoachStartTime(recordingState.syntheticBotId);
    }
    log.info({ coachSkillPath: params.coachSkillPath, companionSessionId: params.companionSessionId }, 'Local recording coach set');
  } else {
    recordingState.coachSkillPath = undefined;
    recordingState.companionSessionId = undefined;
    recordingState.presenceMode = 'silent';
    log.info('Local recording coach cleared');
  }
}

/**
 * Set the presence mode for local recording.
 * Rejects 'participant' mode because local recording has no relay/avatar.
 * Requires coachSkillPath to be set for 'coach' mode.
 */
export function setLocalRecordingPresenceMode(mode: 'silent' | 'coach' | 'participant'): void {
  if (!recordingState.isCapturing) {
    log.warn('Cannot set presence mode: no local recording in progress');
    return;
  }
  if (mode === 'participant') {
    throw new Error('Participant mode is not available for local recording (no relay/avatar)');
  }
  if (mode === 'coach' && !recordingState.coachSkillPath) {
    throw new Error('Cannot set coach mode without an active coach skill');
  }
  recordingState.presenceMode = mode;
  log.info({ presenceMode: mode }, 'Local recording presence mode updated');
}

/** Guard flag to prevent re-entry during quit dialog */
let quitDialogActive = false;

/**
 * Register the before-quit handler for crash protection.
 * Warns user when either capturing audio OR uploading a recording.
 * 
 * NOTE: During update-driven quits (isUpdateQuit() returns true), we auto-stop
 * recording without showing a dialog to avoid blocking the update installer.
 */
export function registerQuitHandler(): void {
  app.on('before-quit', (event) => {
    fireAndForget((async () => {
    // Skip dialog during update-driven quits - auto-stop recording and allow quit
    if (isUpdateQuit()) {
      if (recordingState.isCapturing) {
        log.info('Update quit detected - auto-stopping local recording without dialog');
        await stopLocalRecording();
      }
      // For uploads, let them continue - the state is persisted and will resume on restart
      return;
    }

    // Warn on capturing (will lose recording) or uploading (may lose transcript)
    if ((recordingState.isCapturing || recordingState.isUploading) && !quitDialogActive) {
      event.preventDefault();
      quitDialogActive = true;
      try {
        if (recordingState.isCapturing) {
          // Active recording - show warning and offer to stop
          const shouldQuit = await handleAppQuitDuringRecording();
          if (shouldQuit) {
            app.quit();
          }
        } else if (recordingState.isUploading) {
          // Upload in progress - show warning that it will be resumed on restart
          const result = await dialog.showMessageBox({
            type: 'info',
            title: 'Upload in Progress',
            message: 'A recording is being processed.',
            detail: 'The upload will automatically resume when you reopen the app.',
            buttons: ['Quit Anyway', 'Cancel'],
            defaultId: 0,
            cancelId: 1,
          });
          
          if (result.response === 0) {
            app.quit();
          }
        }
      } finally {
        quitDialogActive = false;
      }
    }
    })(), 'localRecording.beforeQuit');
  });

  log.info('Quit handler registered for local recording protection');
}
