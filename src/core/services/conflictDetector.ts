import equal from 'fast-deep-equal';
import type { AgentSession } from '@shared/types';

type SessionSurfaceTag = 'desktop' | 'mobile' | 'cloud' | 'cloud-untagged' | 'cli';

const CONCURRENT_EDIT_WINDOW_MS = 10_000;
const FIELD_CACHE_TTL_MS = 60 * 60 * 1_000;
export const SURFACE_TIEBREAKER_RACE_WINDOW_MS = 100;

const NON_METADATA_FIELDS = new Set([
  'id',
  'createdAt',
  'updatedAt',
  'cloudUpdatedAt',
  'messages',
  '_deletedMessages',
  '_destructiveOpsLedger',
  'eventsByTurn',
  'maxSeq',
  'activeTurnId',
  'isBusy',
  'lastError',
  // Turn-progress fields: these change monotonically during active turns and
  // should not trigger stale-metadata conflicts. Without this exclusion, routine
  // turn updates (token counts, memory status) combined with stale cloudUpdatedAt
  // (from the push/pull round-trip gap) produce false "Edited elsewhere" badges.
  'usage',
  'memoryUpdateStatusByTurn',
  'timeSavedStatusByTurn',
  'compactionBoundaries',
]);

const REPORTED_FIELD_ALLOWLIST = new Set([
  'title',
  'doneAt', // canonical lifecycle field
  'starredAt',
  'origin',
  'resolvedAt',
  'deletedAt',
  'privateMode',
  'sessionWorkingModel',
  'sessionThinkingModel',
  'sessionWorkingProfileId',
  'sessionThinkingProfileId',
  'sessionThinkingEffort',
  'automationId',
  'automationRunId',
  'meetingCompanion',
  'draft',
  'annotations',
  'interruptedTurnId',
  'finishLine',
]);

const STALE_METADATA_LOCAL_ONLY_FIELDS = new Set([
  'annotations',
]);

// Stage 0.C tiebreaker applies only to user-controlled metadata fields that
// are persisted on AgentSession in this codebase. The planning doc gave
// conceptual examples (title, pinned, archived, tags, spaceId); the real set
// of persisted user-controlled metadata is wider. We intentionally include
// every persisted field a user can deliberately set via the UI so the
// desktop-as-tiebreaker invariant covers the full user-mutable surface.
//
// Mapping plan-concept -> persisted key:
//   done      -> doneAt  (timestamp toggle; non-null = Done)
//   starred   -> starredAt
//   archived  -> deletedAt  (trash-style archival)
//   tags      -> (not implemented on AgentSession today)
//   spaceId   -> (not implemented on AgentSession today)
//
// Additional user-mutable persisted metadata (raised in Stage 0.C review):
//   privateMode  -> user toggle, syncs cross-surface
//   resolvedAt   -> user marks the conversation resolved
//   finishLine   -> user-set finish line config
//   draft        -> user-composed unsent text
//
// System-managed fields (seq, cloudUpdatedAt, maxSeq, eventsByTurn, etc.) are
// NEVER eligible — they're either monotonic or owned by the merge protocol
// itself. See NON_METADATA_FIELDS above for the complementary exclusion list.
export const TIEBREAKER_ELIGIBLE_FIELDS: ReadonlySet<string> = new Set([
  'title',
  'doneAt', // canonical lifecycle field
  'starredAt',
  'deletedAt',
  'privateMode',
  'resolvedAt',
  'finishLine',
  'draft',
]);

type FieldWriteRecord = {
  changedAt: number;
  source: string;
  surface: SessionSurfaceTag;
};

type ConcurrentFieldConflict = {
  field: string;
  previousValue: unknown;
  newValue: unknown;
  priorSource: string;
  priorSurface: SessionSurfaceTag;
  priorChangedAt: number;
};

export type StaleMetadataConflictResult = {
  stale: boolean;
  changedFields: string[];
  reportedFields: string[];
  staleBy: 'cloudUpdatedAt' | 'seq' | null;
};

export type ConcurrentMetadataConflictResult = {
  hasConflict: boolean;
  changedFields: string[];
  reportedFields: string[];
  fieldConflicts: ConcurrentFieldConflict[];
};

export type SurfaceTiebreakerResult = {
  winner: 'desktop' | 'other';
  reason: 'within-race-window' | 'outside-race-window' | 'ineligible-field';
};

function toComparableSessionShape(session: AgentSession): Record<string, unknown> {
  return session as unknown as Record<string, unknown>;
}

function toReportedFieldName(fieldName: string): string {
  if (REPORTED_FIELD_ALLOWLIST.has(fieldName)) return fieldName;
  return 'metadata';
}

class ConflictDetector {
  private readonly recentWritesBySession = new Map<string, Map<string, FieldWriteRecord>>();

  getChangedMetadataFields(existing: AgentSession, incoming: AgentSession): {
    changedFields: string[];
    reportedFields: string[];
  } {
    const existingRecord = toComparableSessionShape(existing);
    const incomingRecord = toComparableSessionShape(incoming);
    const changedFields: string[] = [];
    const allKeys = new Set<string>([
      ...Object.keys(existingRecord),
      ...Object.keys(incomingRecord),
    ]);

    for (const key of allKeys) {
      if (NON_METADATA_FIELDS.has(key)) continue;
      if (!equal(existingRecord[key], incomingRecord[key])) {
        changedFields.push(key);
      }
    }

    const reportedFields = Array.from(new Set(changedFields.map(toReportedFieldName)));
    return { changedFields, reportedFields };
  }

  detectStaleMetadataConflict(args: {
    existing: AgentSession;
    incoming: AgentSession;
    clientCloudUpdatedAt: number | null;
    clientSeq: number | null;
    serverSeq: number;
  }): StaleMetadataConflictResult {
    const { changedFields, reportedFields } = this.getChangedMetadataFields(args.existing, args.incoming);
    if (changedFields.length === 0) {
      return {
        stale: false,
        changedFields: [],
        reportedFields: [],
        staleBy: null,
      };
    }

    const serverCloudUpdatedAt = (
      typeof args.existing.cloudUpdatedAt === 'number'
      && Number.isFinite(args.existing.cloudUpdatedAt)
    )
      ? args.existing.cloudUpdatedAt
      : null;

    const staleByCloudUpdatedAt = (
      args.clientCloudUpdatedAt !== null
      && serverCloudUpdatedAt !== null
      && args.clientCloudUpdatedAt < serverCloudUpdatedAt
    );

    const staleBySeq = (
      !staleByCloudUpdatedAt
      && args.clientSeq !== null
      && args.serverSeq > 0
      && args.clientSeq < args.serverSeq
    );

    return {
      stale: staleByCloudUpdatedAt || staleBySeq,
      changedFields,
      reportedFields,
      staleBy: staleByCloudUpdatedAt ? 'cloudUpdatedAt' : staleBySeq ? 'seq' : null,
    };
  }

  preserveStaleMetadataFields(args: {
    merged: AgentSession;
    existing: AgentSession;
    changedFields: string[];
  }): AgentSession {
    if (args.changedFields.length === 0) return args.merged;
    const mergedRecord = { ...(args.merged as unknown as Record<string, unknown>) };
    const existingRecord = args.existing as unknown as Record<string, unknown>;
    for (const field of args.changedFields) {
      if (STALE_METADATA_LOCAL_ONLY_FIELDS.has(field)) continue;
      mergedRecord[field] = existingRecord[field];
    }
    return mergedRecord as unknown as AgentSession;
  }

  recordWriteAndDetectConcurrentConflict(args: {
    sessionId: string;
    source: string;
    surface: SessionSurfaceTag;
    changedFields: string[];
    previous: AgentSession;
    next: AgentSession;
    now: number;
  }): ConcurrentMetadataConflictResult {
    this.pruneExpired(args.now);
    if (args.changedFields.length === 0) {
      return {
        hasConflict: false,
        changedFields: [],
        reportedFields: [],
        fieldConflicts: [],
      };
    }

    const byField = this.recentWritesBySession.get(args.sessionId) ?? new Map<string, FieldWriteRecord>();
    this.recentWritesBySession.set(args.sessionId, byField);
    const previousRecord = args.previous as unknown as Record<string, unknown>;
    const nextRecord = args.next as unknown as Record<string, unknown>;
    const fieldConflicts: ConcurrentFieldConflict[] = [];

    for (const field of args.changedFields) {
      const prior = byField.get(field);
      if (
        prior
        && prior.source !== args.source
        && args.now - prior.changedAt < CONCURRENT_EDIT_WINDOW_MS
      ) {
        fieldConflicts.push({
          field,
          previousValue: previousRecord[field],
          newValue: nextRecord[field],
          priorSource: prior.source,
          priorSurface: prior.surface,
          priorChangedAt: prior.changedAt,
        });
      }
      byField.set(field, {
        changedAt: args.now,
        source: args.source,
        surface: args.surface,
      });
    }

    if (fieldConflicts.length === 0) {
      return {
        hasConflict: false,
        changedFields: [],
        reportedFields: [],
        fieldConflicts: [],
      };
    }

    const changedFields = fieldConflicts.map((conflict) => conflict.field);
    return {
      hasConflict: true,
      changedFields,
      reportedFields: Array.from(new Set(changedFields.map(toReportedFieldName))),
      fieldConflicts,
    };
  }

  setRecentWriteForField(args: {
    sessionId: string;
    field: string;
    changedAt: number;
    source: string;
    surface: SessionSurfaceTag;
  }): void {
    const byField = this.recentWritesBySession.get(args.sessionId) ?? new Map<string, FieldWriteRecord>();
    this.recentWritesBySession.set(args.sessionId, byField);
    byField.set(args.field, {
      changedAt: args.changedAt,
      source: args.source,
      surface: args.surface,
    });
  }

  resolveSurfaceTiebreaker(args: {
    sessionId: string;
    field: string;
    desktopWrite: { changedAt: number; value: unknown };
    otherWrite: { surface: SessionSurfaceTag; changedAt: number; value: unknown };
    now: number;
  }): SurfaceTiebreakerResult {
    if (!TIEBREAKER_ELIGIBLE_FIELDS.has(args.field)) {
      return { winner: 'other', reason: 'ineligible-field' };
    }

    const delta = Math.abs(args.desktopWrite.changedAt - args.otherWrite.changedAt);
    if (delta > SURFACE_TIEBREAKER_RACE_WINDOW_MS) {
      return {
        winner: args.otherWrite.changedAt > args.desktopWrite.changedAt ? 'other' : 'desktop',
        reason: 'outside-race-window',
      };
    }

    return { winner: 'desktop', reason: 'within-race-window' };
  }

  resetForTests(): void {
    this.recentWritesBySession.clear();
  }

  private pruneExpired(now: number): void {
    for (const [sessionId, byField] of this.recentWritesBySession) {
      for (const [field, record] of byField) {
        if (now - record.changedAt > FIELD_CACHE_TTL_MS) {
          byField.delete(field);
        }
      }
      if (byField.size === 0) {
        this.recentWritesBySession.delete(sessionId);
      }
    }
  }
}

const conflictDetector = new ConflictDetector();

export function getConflictDetector(): ConflictDetector {
  return conflictDetector;
}

export function resetConflictDetectorForTests(): void {
  conflictDetector.resetForTests();
}
