/**
 * Safe Mode Store Diagnostics
 *
 * Read-only diagnostic service for checking electron-store health when in Safe Mode.
 * This service NEVER modifies any files - it only reads and validates.
 *
 * Design principles:
 * - Fail gracefully: worst case returns an error, never crashes
 * - Read-only: no file modifications whatsoever
 * - Timeout protected: individual checks have timeouts
 * - Structured output: returns JSON that Rebel can interpret
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { createScopedLogger } from '@core/logger';
import { getDataPath } from '@core/utils/dataPaths';

const log = createScopedLogger({ service: 'safeModeStoreDiagnostics' });

// =============================================================================
// Types
// =============================================================================

export interface StoreCheckResult {
  exists: boolean;
  readable: boolean;
  validJson: boolean;
  sizeBytes: number;
  /** First 500 chars of file content (for debugging, redacted if sensitive) */
  preview?: string;
  error?: string;
}

export interface DiskSpaceResult {
  available: boolean;
  freeBytes?: number;
  error?: string;
}

export interface DiagnosticIssue {
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  suggestedFix?: string;
}

export interface SafeModeDiagnosticResult {
  status: 'healthy' | 'issues_found' | 'check_failed';
  timestamp: string;
  userDataPath: string;
  checks: {
    settingsStore: StoreCheckResult;
    sessionIndex: StoreCheckResult;
    inboxStore: StoreCheckResult;
    mcpRouterConfig: StoreCheckResult;
    logsAccessible: boolean;
  };
  issues: DiagnosticIssue[];
  suggestedActions: string[];
  recentLogErrors: string[];
}

// =============================================================================
// Individual Check Functions
// =============================================================================

const CHECK_TIMEOUT_MS = 3000;

/**
 * Wrap a promise with a timeout.
 */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), timeoutMs)),
  ]);
}

/**
 * Check a JSON store file's health.
 */
async function checkJsonStore(filePath: string, sensitive = false): Promise<StoreCheckResult> {
  const result: StoreCheckResult = {
    exists: false,
    readable: false,
    validJson: false,
    sizeBytes: 0,
  };

  try {
    // Check if file exists
    const stat = await fs.stat(filePath);
    result.exists = true;
    result.sizeBytes = stat.size;

    // Try to read the file
    const content = await fs.readFile(filePath, 'utf-8');
    result.readable = true;

    // Try to parse as JSON
    JSON.parse(content);
    result.validJson = true;

    // Add preview (redacted for sensitive files)
    if (!sensitive && content.length <= 500) {
      result.preview = content;
    } else if (!sensitive) {
      result.preview = content.slice(0, 500) + '... (truncated)';
    } else {
      result.preview = '[redacted - contains sensitive data]';
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      result.error = 'File does not exist';
    } else if ((err as NodeJS.ErrnoException).code === 'EACCES') {
      result.error = 'Permission denied';
      result.exists = true; // File exists but can't read
    } else if (err instanceof SyntaxError) {
      result.error = `Invalid JSON: ${err.message}`;
      result.readable = true; // Could read, but invalid JSON
    } else {
      result.error = err instanceof Error ? err.message : String(err);
    }
  }

  return result;
}

/**
 * Check if logs directory is accessible.
 */
async function checkLogsAccessible(userDataPath: string): Promise<boolean> {
  try {
    const logsPath = path.join(userDataPath, 'logs');
    await fs.access(logsPath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get recent error lines from the main log file.
 */
async function getRecentLogErrors(userDataPath: string, maxLines = 20): Promise<string[]> {
  const errors: string[] = [];

  try {
    const logPath = path.join(userDataPath, 'logs', 'mindstone-rebel.log');
    const content = await fs.readFile(logPath, 'utf-8');
    const lines = content.split('\n');

    // Look for error/warn lines in the last 500 lines
    const recentLines = lines.slice(-500);
    for (const line of recentLines) {
      if (line.includes('"level":"error"') || line.includes('"level":"warn"')) {
        // Redact potential PII: paths, emails, etc.
        const redacted = line
          .replace(/\/Users\/[^/\s"]+/g, '/Users/[REDACTED]')
          .replace(/\\Users\\[^\\s"]+/g, '\\Users\\[REDACTED]')
          .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[EMAIL]');
        errors.push(redacted);
        if (errors.length >= maxLines) break;
      }
    }
  } catch {
    // Ignore errors reading logs - not critical
  }

  return errors;
}

// =============================================================================
// Main Diagnostic Function
// =============================================================================

/**
 * Run a comprehensive diagnostic check on electron-store files.
 * This function is designed to NEVER throw - it always returns a result.
 */
export async function runSafeModeDiagnostics(): Promise<SafeModeDiagnosticResult> {
  const timestamp = new Date().toISOString();
  const userDataPath = getDataPath();

  // Initialize result with defaults
  const result: SafeModeDiagnosticResult = {
    status: 'healthy',
    timestamp,
    userDataPath,
    checks: {
      settingsStore: { exists: false, readable: false, validJson: false, sizeBytes: 0, error: 'Check not run' },
      sessionIndex: { exists: false, readable: false, validJson: false, sizeBytes: 0, error: 'Check not run' },
      inboxStore: { exists: false, readable: false, validJson: false, sizeBytes: 0, error: 'Check not run' },
      mcpRouterConfig: { exists: false, readable: false, validJson: false, sizeBytes: 0, error: 'Check not run' },
      logsAccessible: false,
    },
    issues: [],
    suggestedActions: [],
    recentLogErrors: [],
  };

  try {
    log.info('Starting Safe Mode diagnostics');

    // Run checks with timeouts
    const [settingsStore, sessionIndex, inboxStore, mcpRouterConfig, logsAccessible, recentLogErrors] =
      await Promise.all([
        withTimeout(
          checkJsonStore(path.join(userDataPath, 'app-settings.json'), true),
          CHECK_TIMEOUT_MS,
          { exists: false, readable: false, validJson: false, sizeBytes: 0, error: 'Check timed out' }
        ),
        withTimeout(
          checkJsonStore(path.join(userDataPath, 'sessions', 'index.json')),
          CHECK_TIMEOUT_MS,
          { exists: false, readable: false, validJson: false, sizeBytes: 0, error: 'Check timed out' }
        ),
        withTimeout(
          checkJsonStore(path.join(userDataPath, 'inbox.json')),
          CHECK_TIMEOUT_MS,
          { exists: false, readable: false, validJson: false, sizeBytes: 0, error: 'Check timed out' }
        ),
        withTimeout(
          checkJsonStore(path.join(userDataPath, 'mcp', 'super-mcp-router.json')),
          CHECK_TIMEOUT_MS,
          { exists: false, readable: false, validJson: false, sizeBytes: 0, error: 'Check timed out' }
        ),
        withTimeout(checkLogsAccessible(userDataPath), CHECK_TIMEOUT_MS, false),
        withTimeout(getRecentLogErrors(userDataPath), CHECK_TIMEOUT_MS, []),
      ]);

    result.checks = {
      settingsStore,
      sessionIndex,
      inboxStore,
      mcpRouterConfig,
      logsAccessible,
    };
    result.recentLogErrors = recentLogErrors;

    // Analyze results and build issues list
    const issues: DiagnosticIssue[] = [];
    const suggestedActions: string[] = [];

    // Check settings store
    if (!settingsStore.exists) {
      issues.push({
        severity: 'warning',
        code: 'SETTINGS_MISSING',
        message: 'Settings file does not exist (will be created with defaults)',
      });
    } else if (!settingsStore.readable) {
      issues.push({
        severity: 'error',
        code: 'SETTINGS_PERMISSION',
        message: 'Cannot read settings file - permission denied',
        suggestedFix: 'Check file permissions on app-settings.json',
      });
      suggestedActions.push('Check file permissions in userData directory');
    } else if (!settingsStore.validJson) {
      issues.push({
        severity: 'error',
        code: 'SETTINGS_CORRUPT',
        message: `Settings file contains invalid JSON: ${settingsStore.error}`,
        suggestedFix: 'Reset settings to defaults via Settings → Advanced',
      });
      suggestedActions.push('Consider resetting settings to defaults');
    }

    // Check MCP router config
    if (mcpRouterConfig.exists && !mcpRouterConfig.validJson) {
      issues.push({
        severity: 'error',
        code: 'MCP_CONFIG_CORRUPT',
        message: `MCP router config contains invalid JSON: ${mcpRouterConfig.error}`,
        suggestedFix: 'Reset MCP config via Settings > Connections > Reset to defaults',
      });
      suggestedActions.push('Consider resetting MCP configuration');
    }

    // Check for timeout errors in recent logs
    const timeoutErrors = recentLogErrors.filter(
      (line) => line.includes('timeout') || line.includes('ETIMEDOUT')
    );
    if (timeoutErrors.length > 3) {
      issues.push({
        severity: 'warning',
        code: 'REPEATED_TIMEOUTS',
        message: 'Multiple timeout errors detected in recent logs',
        suggestedFix: 'Check network connectivity and firewall settings',
      });
    }

    // Check for permission errors in recent logs
    const permissionErrors = recentLogErrors.filter(
      (line) => line.includes('EACCES') || line.includes('EPERM')
    );
    if (permissionErrors.length > 0) {
      issues.push({
        severity: 'warning',
        code: 'PERMISSION_ERRORS_IN_LOGS',
        message: 'Permission errors detected in recent logs',
        suggestedFix: 'Check Settings → Advanced for permission issues',
      });
      suggestedActions.push('Check file and folder permissions');
    }

    // Check for port conflicts in recent logs
    const portConflicts = recentLogErrors.filter((line) => line.includes('EADDRINUSE'));
    if (portConflicts.length > 0) {
      issues.push({
        severity: 'warning',
        code: 'PORT_CONFLICT_IN_LOGS',
        message: 'Port conflict errors detected - another app may be using the same port',
        suggestedFix: 'Close other apps that might use local ports, or restart your computer',
      });
      suggestedActions.push('Close other apps using local ports or restart computer');
    }

    result.issues = issues;
    result.suggestedActions = [...new Set(suggestedActions)]; // Dedupe

    // Set overall status
    const hasErrors = issues.some((i) => i.severity === 'error');
    const hasWarnings = issues.some((i) => i.severity === 'warning');
    result.status = hasErrors ? 'issues_found' : hasWarnings ? 'issues_found' : 'healthy';

    log.info({ status: result.status, issueCount: issues.length }, 'Safe Mode diagnostics complete');
  } catch (err) {
    log.error({ err }, 'Safe Mode diagnostics failed');
    result.status = 'check_failed';
    result.issues = [
      {
        severity: 'error',
        code: 'DIAGNOSTIC_FAILED',
        message: `Diagnostic check failed: ${err instanceof Error ? err.message : String(err)}`,
      },
    ];
  }

  return result;
}
