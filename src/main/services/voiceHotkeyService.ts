/**
 * Voice Activation Hotkey Service
 *
 * Manages global keyboard shortcut registration for voice activation.
 * Handles registration, unregistration, and window focusing.
 *
 * Features:
 * - Registers global shortcut that works when app is not focused
 * - Gracefully handles delayed registration (before app is ready)
 * - Falls back to any available window if main window is unavailable
 */

import { app, BrowserWindow, globalShortcut } from 'electron';
import { logger } from '@core/logger';
import { captureActiveDisplay } from './screenshotService';
import { isRebelTestMode } from '../utils/testIsolation';

const VOICE_ACTIVATION_EVENT = 'voice:activation-hotkey-fired';

/** Payload sent to renderer with optional screenshot data */
export interface VoiceActivationPayload {
  screenshot: {
    base64Data: string;
    width: number;
    height: number;
    sizeBytes: number;
  } | null;
  screenshotError?: 'screen-permission' | 'capture-failed';
}

let registeredHotkey: string | null = null;
let pendingHotkey: string | null = null;
let lastRegistrationError: string | null = null;
let getMainWindow: () => BrowserWindow | null = () => null;

/**
 * Set the main window getter function.
 * Must be called before the hotkey can focus the correct window.
 */
export function setMainWindowGetter(getter: () => BrowserWindow | null): void {
  getMainWindow = getter;
}

/**
 * Get the primary window for hotkey activation.
 * Falls back to any available window if main window is not set.
 */
function getPrimaryWindow(): BrowserWindow | null {
  const mainWin = getMainWindow();
  if (mainWin && !mainWin.isDestroyed()) {
    return mainWin;
  }
  // eslint-disable-next-line no-restricted-syntax -- window-scan-send-allowlisted: legacy target-picking fallback for voice hotkey; migrate later to ensure-main-window capability.
  const alive = BrowserWindow.getAllWindows().find((win) => !win.isDestroyed());
  return alive ?? null;
}

/**
 * Focus the window and return it for hotkey activation.
 */
function focusWindowForHotkey(): BrowserWindow | null {
  const target = getPrimaryWindow();
  if (!target) {
    logger.warn('Voice activation hotkey fired with no available window');
    return null;
  }
  if (!target.isVisible()) {
    target.show();
  }
  if (target.isMinimized()) {
    target.restore();
  }
  target.focus();
  return target;
}

/**
 * Emit voice activation hotkey event to the renderer.
 * Captures screenshot BEFORE focusing window to capture what user was looking at.
 * 
 * This function is designed to be **non-fatal** - it catches all errors internally
 * to prevent unhandled rejections from crashing the app when the hotkey is pressed.
 */
async function emitVoiceActivationHotkeyAsync(): Promise<void> {
  // Capture screenshot BEFORE focusing window
  let payload: VoiceActivationPayload = { screenshot: null };

  try {
    const result = await captureActiveDisplay();
    if (result.screenshot) {
      payload = { screenshot: result.screenshot };
    } else {
      payload = { screenshot: null, screenshotError: result.error };
    }
  } catch (error) {
    logger.warn({ err: error }, 'Screenshot capture threw unexpected error');
    payload = { screenshot: null, screenshotError: 'capture-failed' };
  }

  // Now focus window and send event
  const target = focusWindowForHotkey();
  if (!target) {
    return;
  }
  
  // Guard against destroyed webContents (can happen during app shutdown)
  if (target.webContents.isDestroyed()) {
    logger.debug('Voice activation hotkey fired but webContents is destroyed');
    return;
  }
  
  target.webContents.send(VOICE_ACTIVATION_EVENT, payload);
}

/**
 * Non-async wrapper for globalShortcut.register() callback.
 * Ensures any errors in the async handler become logged warnings, not unhandled rejections.
 */
function emitVoiceActivationHotkey(): void {
  emitVoiceActivationHotkeyAsync().catch((error) => {
    logger.warn({ err: error }, 'Voice activation hotkey handler failed unexpectedly');
  });
}

/**
 * Unregister the current voice activation hotkey.
 */
export function unregisterVoiceActivationHotkey(): void {
  if (registeredHotkey) {
    globalShortcut.unregister(registeredHotkey);
    registeredHotkey = null;
  }
}

/** Result of hotkey registration attempt */
export interface HotkeyRegistrationResult {
  success: boolean;
  /** The registered hotkey accelerator, or null if registration failed/disabled */
  registeredAccelerator: string | null;
  /** Error message if registration failed */
  error?: string;
}

/**
 * Apply (register) a voice activation hotkey.
 * If app is not ready, the registration will be deferred.
 * 
 * This function is designed to be **non-fatal** - it will never throw.
 * On failure, it returns a result indicating the error and disables the hotkey.
 * 
 * @param accelerator - The keyboard shortcut (e.g., "CommandOrControl+Shift+Space")
 * @returns Result indicating success/failure of registration
 */
export function applyVoiceActivationHotkey(accelerator: string | null | undefined): HotkeyRegistrationResult {
  if (isRebelTestMode()) {
    logger.info('[VOICE-HOTKEY] Skipping global shortcut registration in rebel-test mode');
    return { success: true, registeredAccelerator: null };
  }

  const sanitized = typeof accelerator === 'string' && accelerator.trim().length > 0 ? accelerator.trim() : null;
  pendingHotkey = sanitized;
  lastRegistrationError = null;

  if (!app.isReady()) {
    // Deferred registration - will be applied when app is ready
    return { success: true, registeredAccelerator: null };
  }

  // Unregister any existing hotkey first (non-throwing)
  try {
    unregisterVoiceActivationHotkey();
  } catch (unregisterError) {
    logger.warn({ err: unregisterError }, 'Failed to unregister previous hotkey, continuing with registration');
  }

  if (!sanitized) {
    pendingHotkey = null;
    return { success: true, registeredAccelerator: null };
  }

  try {
    const success = globalShortcut.register(sanitized, emitVoiceActivationHotkey);
    if (!success) {
      const errorMsg = `Unable to register global shortcut "${sanitized}". It may already be in use by another application.`;
      lastRegistrationError = errorMsg;
      logger.warn({ accelerator: sanitized }, 'Failed to register voice activation hotkey - shortcut may be in use by another application');
      return { success: false, registeredAccelerator: null, error: errorMsg };
    }
    registeredHotkey = sanitized;
    pendingHotkey = null;
    logger.info({ accelerator: sanitized }, 'Registered voice activation hotkey');
    return { success: true, registeredAccelerator: sanitized };
  } catch (error) {
    registeredHotkey = null;
    const reason = error instanceof Error ? error.message : String(error);
    const errorMsg = `Unable to register global shortcut "${sanitized}". It may already be in use by another application.${reason ? ` (${reason})` : ''}`;
    lastRegistrationError = errorMsg;
    logger.warn({ err: error, accelerator: sanitized }, 'Failed to register voice activation hotkey');
    return { success: false, registeredAccelerator: null, error: errorMsg };
  }
}

/**
 * Get the pending hotkey that was set before app was ready.
 */
export function getPendingVoiceActivationHotkey(): string | null {
  return pendingHotkey;
}

/**
 * Set the pending hotkey manually (used when registration fails).
 */
export function setPendingVoiceActivationHotkey(hotkey: string | null): void {
  pendingHotkey = hotkey;
}

/**
 * Clear the pending hotkey.
 */
export function clearPendingVoiceActivationHotkey(): void {
  pendingHotkey = null;
}

/**
 * Get the last registration error, if any.
 * Useful for diagnostics and user notification.
 */
export function getLastHotkeyRegistrationError(): string | null {
  return lastRegistrationError;
}

/**
 * Get the currently registered hotkey, if any.
 */
export function getRegisteredHotkey(): string | null {
  return registeredHotkey;
}
