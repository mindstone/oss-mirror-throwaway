/**
 * User Engagement Heartbeat Service
 *
 * Tracks genuine user engagement for analytics accuracy.
 * Sends periodic heartbeat events ONLY when user is actively engaged with Rebel.
 *
 * Design priorities (per investor metric requirements):
 * 1. NO FALSE POSITIVES - never overstate engagement
 * 2. False negatives acceptable - underreporting is conservative
 *
 * Heartbeat fires only when ALL conditions are true:
 * - Window is visible (not minimized/hidden)
 * - User had TRUSTED input in Rebel within the idle threshold
 *   (renderer only sends pings for event.isTrusted DOM events)
 * - Activity occurred after last suspend/lock (no sleep time counted)
 *
 * NOTE: We do NOT require window focus at heartbeat time. The renderer-side
 * activity ping already proves the user was interacting with Rebel when
 * the event fired. DOM events (keydown, pointerdown, scroll) only fire in
 * the Electron renderer when the user interacts with that specific window.
 *
 * Excludes:
 * - Background automations (scheduled tasks don't trigger DOM events)
 * - Synthetic/programmatic events (filtered by event.isTrusted in renderer)
 * - System sleep/suspend periods
 */

import { BrowserWindow, ipcMain, powerMonitor } from 'electron';
import { trackMainEvent, getOrGenerateAnonymousId } from '../analytics';
import { createScopedLogger } from '@core/logger';
import { createPausableInterval } from './visibilityAwareScheduler';

const log = createScopedLogger({ component: 'user-engagement' });

// Configuration
const IDLE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes - user considered idle after this
const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes - heartbeat frequency

// State
let lastRendererActivity = 0; // Initialized to 0 - no heartbeat until real interaction
let lastSuspendTime = 0; // Track when system suspended
let heartbeatTimer: (() => void) | null = null;
let isInitialized = false;

/**
 * Check if we should send a heartbeat.
 * Conservative: all conditions must be true.
 */
function shouldSendHeartbeat(): boolean {
  // Find the main window (should be visible for heartbeat to count)
  // eslint-disable-next-line no-restricted-syntax -- window-scan-send-allowlisted: engagement visibility probe only, no webContents.send target; migrate later only if main-window getter becomes available here.
  const windows = BrowserWindow.getAllWindows();
  const mainWindow = windows.find(w => w.isVisible());

  // No visible window = app is minimized/hidden, don't count as engagement
  if (!mainWindow) {
    return false;
  }

  // NOTE: We do NOT check isFocused() here. The lastRendererActivity timestamp
  // was set by a trusted DOM event in the renderer, which only fires when the
  // user actually interacts with the Electron window. Focus at heartbeat time
  // is irrelevant - the interaction already happened.

  // Must have had recent user input IN REBEL (proven by renderer activity ping)
  const idleMs = Date.now() - lastRendererActivity;
  if (idleMs > IDLE_THRESHOLD_MS) {
    return false;
  }

  // Must have activity AFTER last suspend (prevents counting sleep time)
  if (lastRendererActivity <= lastSuspendTime) {
    return false;
  }

  return true;
}

/**
 * Send the engagement heartbeat event.
 */
function sendHeartbeat(): void {
  const idleSeconds = Math.floor((Date.now() - lastRendererActivity) / 1000);

  trackMainEvent({
    anonymousId: getOrGenerateAnonymousId(),
    event: 'User Engagement Heartbeat',
    properties: {
      idle_seconds: idleSeconds,
      source: 'user_input', // Explicitly NOT automation
      heartbeat_interval_minutes: HEARTBEAT_INTERVAL_MS / 60000,
    },
  });

  log.debug({ idleSeconds }, 'Engagement heartbeat sent');
}

/**
 * Handle activity ping from renderer.
 * Only called on genuine user input (keydown, pointerdown, scroll, voice).
 */
function handleActivityPing(event: Electron.IpcMainEvent): void {
  // Verify the ping comes from a real window (defense against rogue webContents)
  const webContents = event.sender;
  const browserWindow = BrowserWindow.fromWebContents(webContents);

  if (!browserWindow) {
    log.warn('Activity ping from unknown webContents - ignoring');
    return;
  }

  lastRendererActivity = Date.now();
}

/**
 * Start the heartbeat timer.
 */
function startHeartbeatTimer(): void {
  if (heartbeatTimer) {
    return; // Already running
  }

  heartbeatTimer = createPausableInterval(() => {
    if (shouldSendHeartbeat()) {
      sendHeartbeat();
    }
  }, HEARTBEAT_INTERVAL_MS, { pauseOnBlur: true, catchUpPriority: 5 });

  log.info(
    { intervalMinutes: HEARTBEAT_INTERVAL_MS / 60000, idleThresholdMinutes: IDLE_THRESHOLD_MS / 60000 },
    'User engagement heartbeat tracking started'
  );
}

/**
 * Stop the heartbeat timer (for cleanup).
 */
function stopHeartbeatTimer(): void {
  if (heartbeatTimer) {
    heartbeatTimer();
    heartbeatTimer = null;
    log.info('User engagement heartbeat tracking stopped');
  }
}

/**
 * Initialize the user engagement tracking service.
 * Should be called once during app startup after window is created.
 */
export function initUserEngagementService(): void {
  if (isInitialized) {
    log.warn('User engagement service already initialized');
    return;
  }

  // Listen for activity pings from renderer
  ipcMain.on('user:activity-ping', handleActivityPing);

  // Invalidate activity on system suspend (don't count sleep time as engagement)
  powerMonitor.on('suspend', () => {
    lastSuspendTime = Date.now();
    log.debug('System suspend - activity invalidated until new input');
  });

  // Also invalidate on lock screen (user walked away)
  powerMonitor.on('lock-screen', () => {
    lastSuspendTime = Date.now();
    log.debug('Screen locked - activity invalidated until new input');
  });

  // Start the heartbeat timer
  startHeartbeatTimer();

  isInitialized = true;
  log.info('User engagement service initialized');
}

/**
 * Cleanup the service (for app shutdown).
 */
export function shutdownUserEngagementService(): void {
  stopHeartbeatTimer();
  ipcMain.removeAllListeners('user:activity-ping');
  isInitialized = false;
  log.info('User engagement service shut down');
}
