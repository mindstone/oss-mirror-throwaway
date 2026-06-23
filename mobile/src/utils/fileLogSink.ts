/**
 * File-Based Log Persistence for Mobile
 *
 * Implements log persistence via the cloud-client's PersistCallback interface.
 * Writes structured JSON log lines to rotating files using expo-file-system.
 * All writes are fire-and-forget — never blocks the UI thread.
 *
 * Key features:
 * - Buffered writes (2s flush interval) for UI thread safety
 * - App lifecycle flush (background/inactive → immediate flush)
 * - Date + sequence-based rotation (multiple files per day)
 * - Configurable retention (max files, max size per file)
 */

import * as FileSystem from 'expo-file-system/legacy';
import { AppState, type AppStateStatus } from 'react-native';
import type { LogLevel } from '@rebel/cloud-client';

const LOG_DIR = (FileSystem.documentDirectory || '') + 'logs/';
const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2MB per file
const MAX_FILES = 5;
const BUFFER_FLUSH_INTERVAL_MS = 2000;

const MAX_BUFFER_LINES = 5000;

let _buffer: string[] = [];
let _currentFile = '';
let _currentFileSize = 0;
let _flushTimer: ReturnType<typeof setInterval> | null = null;
let _flushPromise: Promise<void> | null = null;
let _initialized = false;
let _appStateSubscription: ReturnType<typeof AppState.addEventListener> | null = null;

async function ensureLogDir(): Promise<void> {
  const info = await FileSystem.getInfoAsync(LOG_DIR);
  if (!info.exists) await FileSystem.makeDirectoryAsync(LOG_DIR, { intermediates: true });
}

function getLogFileName(): string {
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 19).replace(/:/g, '');
  return `rebel-${date}_${time}.log`;
}

async function rotateIfNeeded(): Promise<void> {
  if (_currentFileSize < MAX_FILE_SIZE) return;

  try {
    const files = await FileSystem.readDirectoryAsync(LOG_DIR);
    const logFiles = files.filter(f => f.startsWith('rebel-') && f.endsWith('.log')).sort();
    while (logFiles.length >= MAX_FILES) {
      const oldest = logFiles.shift();
      if (oldest) await FileSystem.deleteAsync(LOG_DIR + oldest, { idempotent: true });
    }
  } catch { /* ignore rotation errors */ }

  _currentFile = getLogFileName();
  _currentFileSize = 0;
}

async function flushBuffer(): Promise<void> {
  // Serialize concurrent flushes (timer, lifecycle, diagnostics can all trigger)
  if (_flushPromise) {
    await _flushPromise;
    if (_buffer.length === 0) return;
  }
  _flushPromise = flushBufferCore();
  try { await _flushPromise; } finally { _flushPromise = null; }
}

async function flushBufferCore(): Promise<void> {
  if (_buffer.length === 0) return;

  const lines = _buffer.splice(0);
  const content = lines.join('\n') + '\n';

  try {
    if (!_initialized) {
      await ensureLogDir();
      _initialized = true;
    }

    if (!_currentFile) _currentFile = getLogFileName();
    await rotateIfNeeded();

    const filePath = LOG_DIR + _currentFile;
    const contentBytes = content.length;

    let existingSize = 0;
    try {
      const info = await FileSystem.getInfoAsync(filePath);
      if (info.exists && 'size' in info) {
        existingSize = (info as { size: number }).size;
      }
    } catch { /* file doesn't exist yet */ }

    // Expo FileSystem doesn't have a native append, so read + write
    let existing = '';
    if (existingSize > 0) {
      try {
        existing = await FileSystem.readAsStringAsync(filePath, { encoding: FileSystem.EncodingType.UTF8 });
      } catch { /* file doesn't exist yet */ }
    }

    await FileSystem.writeAsStringAsync(filePath, existing + content, {
      encoding: FileSystem.EncodingType.UTF8,
    });
    _currentFileSize = existingSize + contentBytes;
  } catch { /* never throw from logging */ }
}

/**
 * PersistCallback-compatible function for use with setLogPersistCallback().
 * Buffers log lines and periodically flushes to disk.
 */
export function fileLogWriter(level: LogLevel, tag: string, msg: string, data?: Record<string, unknown>): void {
  const line = JSON.stringify({ ts: Date.now(), level, tag, msg, ...data });
  if (_buffer.length >= MAX_BUFFER_LINES) _buffer.shift();
  _buffer.push(line);

  if (!_flushTimer) {
    _flushTimer = setInterval(() => { flushBuffer().catch(() => {}); }, BUFFER_FLUSH_INTERVAL_MS);
  }
}

/**
 * Force an immediate flush of buffered log entries.
 * Call before reading logs for diagnostics or on app lifecycle transitions.
 */
export async function flushLogs(): Promise<void> {
  await flushBuffer();
}

/**
 * Delete all rotating diagnostic log files and discard any buffered lines.
 * Used by account teardown so logs do not survive logout/unpair.
 */
export async function purgeFileLogs(): Promise<void> {
  if (_flushTimer) {
    clearInterval(_flushTimer);
    _flushTimer = null;
  }

  _buffer = [];

  if (_flushPromise) {
    await _flushPromise;
    _buffer = [];
  }

  const info = await FileSystem.getInfoAsync(LOG_DIR);
  if (info.exists) {
    await FileSystem.deleteAsync(LOG_DIR, { idempotent: true });
  }

  _currentFile = '';
  _currentFileSize = 0;
  _initialized = false;
}

/**
 * Subscribe to AppState changes to flush logs when the app goes to background.
 * Call once at app startup. Returns an unsubscribe function.
 */
export function startLifecycleFlush(): () => void {
  if (_appStateSubscription) return () => {};

  const handleAppStateChange = (nextState: AppStateStatus) => {
    if (nextState === 'background' || nextState === 'inactive') {
      flushBuffer().catch(() => {});
    }
  };

  _appStateSubscription = AppState.addEventListener('change', handleAppStateChange);

  return () => {
    _appStateSubscription?.remove();
    _appStateSubscription = null;
  };
}

/**
 * Read recent log content for diagnostic export.
 * Returns the most recent log entries as a string.
 *
 * Throws on read failure (caller should handle) rather than masking errors
 * as empty content. This lets diagnostics distinguish "no logs" from "read failed".
 */
export async function readRecentLogs(maxLines = 200): Promise<string> {
  // Flush any buffered content first
  await flushBuffer();

  await ensureLogDir();
  const files = await FileSystem.readDirectoryAsync(LOG_DIR);
  const logFiles = files.filter(f => f.startsWith('rebel-') && f.endsWith('.log')).sort().reverse();

  if (logFiles.length === 0) return '';

  let lines: string[] = [];
  for (const file of logFiles) {
    if (lines.length >= maxLines) break;
    const content = await FileSystem.readAsStringAsync(LOG_DIR + file, {
      encoding: FileSystem.EncodingType.UTF8,
    });
    const fileLines = content.trim().split('\n');
    // Use concat instead of push(...spread) to avoid V8 argument limit on large files
    lines = lines.concat(fileLines.reverse());
  }

  return lines.slice(0, maxLines).reverse().join('\n');
}
