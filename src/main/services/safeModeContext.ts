/**
 * Safe Mode Context Service
 *
 * Manages Safe Mode state including the reason it was triggered, error category,
 * and Sentry event ID. This module provides:
 * - Persistence across app restarts via a temp file
 * - In-memory state for runtime access
 * - Error categorization from error codes
 *
 * Privacy note: We store error categories (derived from error codes like EADDRINUSE),
 * NOT raw error messages which may contain paths, usernames, or other PII.
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { createScopedLogger } from '@core/logger';
import { getDataPath } from '@core/utils/dataPaths';
import type { SafeModeContext, SafeModeErrorCategory, SafeModeReason } from '@shared/types';
import { categorizeSafeModeError } from '@shared/safeModeErrorClassifier';

// Re-export types for convenience
export type { SafeModeContext, SafeModeErrorCategory, SafeModeReason };

const log = createScopedLogger({ service: 'safeModeContext' });

// =============================================================================
// State
// =============================================================================

let currentContext: SafeModeContext = { isEnabled: false };

const CONTEXT_FILE_NAME = 'safe-mode-context.json';
const CONTEXT_TTL_MS = 5 * 60 * 1000; // 5 minutes — ignore stale context files

// =============================================================================
// Error Categorization
// =============================================================================

/**
 * Categorize an error into a safe, privacy-preserving category.
 * Uses error codes (e.g., EADDRINUSE) rather than parsing error messages.
 */
export function categorizeError(error: Error | unknown, attemptPhase?: string): SafeModeErrorCategory {
  return categorizeSafeModeError(error, attemptPhase);
}

// =============================================================================
// Context File Management
// =============================================================================

function getContextFilePath(): string {
  return path.join(getDataPath(), CONTEXT_FILE_NAME);
}

/**
 * Save Safe Mode context to a temp file before app relaunch.
 * Must be awaited before calling app.relaunch().
 */
export async function saveContextBeforeRelaunch(context: Omit<SafeModeContext, 'isEnabled'>): Promise<void> {
  const fullContext: SafeModeContext = {
    isEnabled: true,
    triggeredAt: new Date().toISOString(),
    ...context,
  };

  try {
    const filePath = getContextFilePath();
    await fs.writeFile(filePath, JSON.stringify(fullContext, null, 2), 'utf-8');
    log.info({ filePath }, 'Saved Safe Mode context for relaunch');
  } catch (err) {
    log.error({ err }, 'Failed to save Safe Mode context');
  }
}

/**
 * Load Safe Mode context from temp file on startup.
 * Returns null if no context file exists or if it's stale (TTL expired).
 * Deletes the file after reading (one-shot).
 */
export async function loadContextOnStartup(): Promise<SafeModeContext | null> {
  const filePath = getContextFilePath();

  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const context = JSON.parse(content) as SafeModeContext;

    // TTL check — ignore stale context files
    if (context.triggeredAt) {
      const triggeredAt = new Date(context.triggeredAt).getTime();
      const age = Date.now() - triggeredAt;
      if (age > CONTEXT_TTL_MS) {
        log.warn({ age, ttl: CONTEXT_TTL_MS }, 'Safe Mode context file is stale, ignoring');
        await cleanupContextFile();
        return null;
      }
    }

    log.info({ context }, 'Loaded Safe Mode context from file');

    // Delete after reading (one-shot)
    await cleanupContextFile();

    return context;
  } catch (err) {
    // File doesn't exist or is invalid — that's fine
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn({ err }, 'Failed to load Safe Mode context');
    }
    return null;
  }
}

/**
 * Clean up orphan context files.
 * Called on normal startup (no --safe-mode flag) to remove stale files.
 */
export async function cleanupContextFile(): Promise<void> {
  try {
    await fs.unlink(getContextFilePath());
    log.debug('Cleaned up Safe Mode context file');
  } catch (err) {
    // File doesn't exist — that's fine
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn({ err }, 'Failed to clean up Safe Mode context file');
    }
  }
}

// =============================================================================
// Runtime State Management
// =============================================================================

/**
 * Initialize Safe Mode context on app startup.
 * - If --safe-mode flag is present, load context from file
 * - If no flag, clean up any orphan context files
 */
export async function initializeSafeModeContext(isSafeModeEnabled: boolean): Promise<void> {
  if (isSafeModeEnabled) {
    const loadedContext = await loadContextOnStartup();
    if (loadedContext) {
      currentContext = loadedContext;
    } else {
      // CLI-only launch without context file (e.g., manual --safe-mode)
      currentContext = {
        isEnabled: true,
        reason: 'cli',
        triggeredAt: new Date().toISOString(),
      };
    }
    log.info({ context: currentContext }, 'Safe Mode initialized');
  } else {
    // Normal startup — clean up any orphan files
    await cleanupContextFile();
    currentContext = { isEnabled: false };
  }
}

/**
 * Get the current Safe Mode context.
 * Used by generateEnvContext() for system prompt injection.
 */
export function getSafeModeContext(): SafeModeContext {
  return { ...currentContext };
}

/**
 * Update Safe Mode context (used when entering Safe Mode via IPC).
 */
export function setSafeModeContext(context: SafeModeContext): void {
  currentContext = { ...context };
}
