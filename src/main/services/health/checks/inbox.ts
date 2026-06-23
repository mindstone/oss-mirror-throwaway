/**
 * Inbox Health Checks
 *
 * Checks for inbox state and pending tasks.
 * NOTE: Must be read-only - do not trigger migrations or writes.
 */

import type { CheckResult } from '../types';
import { getInboxIndexSnapshot } from '../../inboxStore';

/**
 * Check inbox health.
 * Reports on pending tasks, migration status, and history size.
 * Uses read-only snapshot to avoid triggering migrations.
 */
export function checkInboxHealth(): CheckResult {
  const index = getInboxIndexSnapshot();

  const pendingCount = index.entries.filter(e => !e.archived).length;
  const archivedCount = index.entries.filter(e => e.archived).length;
  const historyCount = index.history.length;

  if (!index.migrationComplete) {
    return {
      id: 'inboxHealth',
      name: 'Inbox',
      status: 'warn',
      message: 'Inbox migration incomplete - some tasks may be missing',
      details: {
        migrationComplete: false,
        pendingTasks: pendingCount,
        archivedTasks: archivedCount,
        historyEntries: historyCount,
      },
      remediation: 'Open Settings → Inbox to trigger migration completion.',
    };
  }

  // Large inbox warning (>50 pending tasks)
  if (pendingCount > 50) {
    return {
      id: 'inboxHealth',
      name: 'Inbox',
      status: 'warn',
      message: `${pendingCount} pending tasks in inbox`,
      details: {
        migrationComplete: true,
        pendingTasks: pendingCount,
        archivedTasks: archivedCount,
        historyEntries: historyCount,
      },
      remediation: 'Consider reviewing and clearing old inbox tasks.',
    };
  }

  return {
    id: 'inboxHealth',
    name: 'Inbox',
    status: 'pass',
    message: pendingCount === 0 
      ? 'Inbox empty' 
      : `${pendingCount} pending task(s)`,
    details: {
      migrationComplete: true,
      pendingTasks: pendingCount,
      archivedTasks: archivedCount,
      historyEntries: historyCount,
    },
  };
}
