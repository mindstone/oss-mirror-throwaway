/**
 * Meeting Prep Reconciler
 *
 * Reconciles on-disk meeting prep documents with the in-memory meeting cache.
 *
 * Background: When the agent creates prep docs via the generic `Write` tool
 * (instead of the `rebel_meetings_save_prep` MCP tool that goes through
 * /meetings/save-prep → updateMeetingPrepPath), the cached meeting's
 * `prepPath` stays empty — and the Focus view keeps showing the meeting as
 * needing prep even though a prep file exists on disk.
 *
 * This reconciler closes that gap by scanning the prep-doc directory for the
 * relevant date range, matching by `meetingId` (primary — written into every
 * prep doc's frontmatter by the skill template) or `meetingStartTime`
 * (fallback for legacy docs), and attaching the relative path to matching
 * meetings before they are written to the cache.
 *
 * @see src/core/services/meetingCacheStore.ts — setCachedMeetings merges prepPaths from prior cache
 * @see src/main/services/prepDocScanner.ts — findPrepDocPaths + PrepDocPathMetadata
 * @see src/main/services/bundledInboxBridge.ts — /meetings/save-prep endpoint (sets prepPath on auto-link)
 * @see docs/plans/260414_fix_focus_prep_remaining.md — earlier preserve-across-syncs fix (incomplete — never populated prepPath in the first place when Write was used)
 */

import path from 'node:path';
import { createScopedLogger } from '@core/logger';
import { hasRealPrepPath } from '@shared/ipc/channels/calendar';
import type { CachedMeeting } from './meetingCacheStore';
import { findPrepDocPaths, type PrepDocPathMetadata } from './prepDocScanner';
import { scanSpaces } from './spaceService';

const log = createScopedLogger({ service: 'meetingPrepReconciler' });

const DATE_RANGE_PADDING_MS = 24 * 60 * 60 * 1000; // 1-day buffer each side for timezone boundaries

interface PrepPathIndex {
  byMeetingId: Map<string, string>;
  /** Keyed by `Date.getTime()` so we are resilient to ISO string format drift (Z suffix, ms precision, etc.) */
  byStartTimeMs: Map<number, string>;
}

/**
 * Resolve the absolute path of the Chief-of-Staff space. Prep docs live there
 * (see `determineTargetSpace` in transcriptStorage). Falls back to
 * `coreDirectory` if CoS cannot be resolved — same pattern as
 * `focusAutomationContext.buildFocusAutomationContext`.
 */
async function resolvePrepBasePath(coreDirectory: string): Promise<string> {
  try {
    // Read-only: resolving CoS path for prep storage — must not mutate
    // frontmatter. See docs/plans/260411_shared_space_maintenance.md Stage 3 Refinement.
    const spaces = await scanSpaces(coreDirectory, { skipAutoFix: true });
    const cosSpace = spaces.find(s => s.type === 'chief-of-staff');
    return cosSpace?.absolutePath ?? coreDirectory;
  } catch (err) {
    log.warn({ err }, 'Failed to resolve CoS space path; falling back to coreDirectory');
    return coreDirectory;
  }
}

/**
 * Compute the date range spanning the given meetings, padded by 1 day on each
 * side to avoid missing prep docs stored under a neighbouring day folder
 * because of timezone boundaries.
 */
function computeDateRange(meetings: CachedMeeting[]): { start: Date; end: Date } | null {
  if (meetings.length === 0) return null;

  let minMs = Number.POSITIVE_INFINITY;
  let maxMs = Number.NEGATIVE_INFINITY;

  for (const m of meetings) {
    const ms = new Date(m.startTime).getTime();
    if (!Number.isFinite(ms)) continue;
    if (ms < minMs) minMs = ms;
    if (ms > maxMs) maxMs = ms;
  }

  if (!Number.isFinite(minMs) || !Number.isFinite(maxMs)) return null;

  return {
    start: new Date(minMs - DATE_RANGE_PADDING_MS),
    end: new Date(maxMs + DATE_RANGE_PADDING_MS),
  };
}

/**
 * Build a lookup index of prep docs in the given range, keyed by both
 * meetingId and meetingStartTime. The stored value is the relative path from
 * `prepBasePath` — the same shape that `/meetings/save-prep` writes into the
 * cache today.
 */
function buildPrepPathIndex(
  prepDocs: PrepDocPathMetadata[],
  prepBasePath: string,
): PrepPathIndex {
  const byMeetingId = new Map<string, string>();
  const byStartTimeMs = new Map<number, string>();

  for (const doc of prepDocs) {
    const relativePath = toRelativePortablePath(prepBasePath, doc.path);
    if (doc.meetingId && !byMeetingId.has(doc.meetingId)) {
      byMeetingId.set(doc.meetingId, relativePath);
    }
    const startMs = new Date(doc.meetingStartTime).getTime();
    if (Number.isFinite(startMs) && !byStartTimeMs.has(startMs)) {
      byStartTimeMs.set(startMs, relativePath);
    }
  }

  return { byMeetingId, byStartTimeMs };
}

function toRelativePortablePath(basePath: string, absolutePath: string): string {
  const relative = path.relative(basePath, absolutePath);
  return relative.split(path.sep).join('/');
}

/**
 * Scan disk for prep docs covering the date range of the given meetings and
 * attach `prepPath` to any meeting that has a matching on-disk prep file but
 * no cached `prepPath` yet. Skip-sentinels and meetings that already have a
 * real prepPath are left untouched — callers keep full control of explicit
 * state.
 *
 * Returns a new array; input is not mutated. Never throws — disk errors are
 * logged and the original meetings are returned so a scan failure cannot
 * break calendar sync.
 */
export async function attachPrepPathsFromDisk(
  meetings: CachedMeeting[],
  coreDirectory: string | null | undefined,
): Promise<CachedMeeting[]> {
  if (!coreDirectory || meetings.length === 0) return meetings;

  const range = computeDateRange(meetings);
  if (!range) return meetings;

  try {
    const prepBasePath = await resolvePrepBasePath(coreDirectory);
    const prepDocs = findPrepDocPaths(prepBasePath, range.start, range.end);
    if (prepDocs.length === 0) return meetings;

    const index = buildPrepPathIndex(prepDocs, prepBasePath);
    if (index.byMeetingId.size === 0 && index.byStartTimeMs.size === 0) {
      return meetings;
    }

    let attached = 0;
    const updated = meetings.map(meeting => {
      // Preserve any explicit prepPath the caller already set (real or skip
      // sentinel) — this lets direct user actions (e.g. skip button) win.
      if (hasRealPrepPath(meeting.prepPath) || meeting.prepPath) return meeting;

      const byId = index.byMeetingId.get(meeting.id);
      if (byId) {
        attached += 1;
        return { ...meeting, prepPath: byId };
      }
      const startMs = new Date(meeting.startTime).getTime();
      if (Number.isFinite(startMs)) {
        const byTime = index.byStartTimeMs.get(startMs);
        if (byTime) {
          attached += 1;
          return { ...meeting, prepPath: byTime };
        }
      }
      return meeting;
    });

    if (attached > 0) {
      log.info({
        scanned: prepDocs.length,
        byIdCandidates: index.byMeetingId.size,
        byStartTimeCandidates: index.byStartTimeMs.size,
        attached,
      }, 'Attached prep paths from disk to cached meetings');
    }

    return updated;
  } catch (err) {
    log.warn({ err }, 'Failed to reconcile prep paths from disk; returning meetings unchanged');
    return meetings;
  }
}

// Test-only export for unit coverage of the index helper without disk I/O.
export const _testing = {
  buildPrepPathIndex,
  computeDateRange,
  toRelativePortablePath,
};
