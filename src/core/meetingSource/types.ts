// src/core/meetingSource/types.ts

import type { Logger } from '@core/logger';
import type {
  TranscriptSavedEvent,
  TranscriptDistributionReadyEvent,
  TranscriptSourceSystem,
} from '@shared/types/transcript';

// ---------- Raw transcript shapes (one per source) ----------

export interface RawRecallTranscript {
  botId: string;
  meetingTitle: string;
  meetingUrl?: string;
  participants: string[];
  durationMs: number; // canonical unit; today's TranscriptData.duration is seconds — adapter converts
  startTime: string;
  rawTranscript: string;
  summary?: string;
  keyPoints?: string[];
  actionItems?: string[];
  decisions?: string[];
  openQuestions?: string[];
  recordingId?: string;
  transcriptQuality?: 'captions' | 'recallai_async' | 'desktop_sdk';
  calendarEventId?: string;
  calendarSource?: string;
  chatMessages?: Array<{ sender: string; text: string; timestamp: string }>;
  // For live-transcript flow: kernel saves initial transcript, returns
  // result, and a separate upgradeAndEmit() call later finalises.
  isLiveTranscriptInitial?: boolean;
}

export interface RawExternalTranscript {
  externalId: string;
  meetingTitle: string;
  meetingUrl?: string;
  transcriptUrl?: string;
  participants: string[];
  durationMs: number;
  startTime: string;
  rawTranscript: string;
  summary?: string;
  keyPoints?: string[];
  actionItems?: string[];
  decisions?: string[];
  openQuestions?: string[];
}

export interface RawPlaudTranscript {
  fileId: string;
  startAt: string;
  durationMs: number; // today's Plaud uses ms (verified at plaudSyncService.ts:902,955)
  rawTranscript: string;
}

export interface RawLimitlessTranscript {
  lifelogId: string;
  title: string;
  startTime: string;
  durationMs: number; // adapter converts from today's seconds (physicalRecording/types.ts:45)
  rawTranscript: string;
}

export interface RawDesktopSdkTranscript {
  sessionId: string;
  meetingTitle: string;
  meetingUrl?: string;
  participants: string[];
  durationMs: number;
  startTime: string;
  rawTranscript: string;
}

export interface RawQuickCaptureTranscript {
  sessionId: string;
  title: string;
  startTime: string;
  durationMs: number;
  rawTranscript: string;
}

// ---------- Discriminated input ----------

export type MeetingSourceInput =
  | {
      kind: 'recall';
      transcript: RawRecallTranscript;
      provider: 'recall' | 'meetingbass';
    }
  | {
      kind: 'external';
      transcript: RawExternalTranscript;
      provider: 'fireflies' | 'fathom';
      meetingUrl: string | null;
      calendarEventId: string | null;
    }
  | {
      kind: 'plaud';
      transcript: RawPlaudTranscript;
      fallbackTitleStrategy: () => Promise<string>;
    }
  | {
      kind: 'limitless';
      transcript: RawLimitlessTranscript;
      fallbackTitleStrategy: () => string;
    }
  | {
      kind: 'desktop_sdk';
      transcript: RawDesktopSdkTranscript;
      fallbackTitleStrategy: () => string;
    }
  | {
      kind: 'quick_capture';
      transcript: RawQuickCaptureTranscript;
      fallbackTitleStrategy: () => Promise<string>;
    };

// ---------- Target space + auth ----------

export interface TargetSpace {
  spacePath: string;
  absolutePath: string;
  spaceName: string;
  sharing: 'private' | 'shared' | 'public' | 'team';
  description?: string;
}

export interface AuthInfo {
  userName: string | null;
  userEmail: string | null;
}

// ---------- Calendar enrichment ----------

export interface EnrichmentResult {
  matched: boolean;
  calendarEventId?: string;
  calendarSource?: 'google' | 'microsoft' | string;
  title?: string;
  meetingUrl?: string;
  startTime?: string;
}

export interface EnrichmentQuery {
  meetingUrl?: string;
  participants?: string[];
  startTime: string; // ISO timestamp
  durationMs: number; // canonical unit; matcher derives endTime
  // Stage 0a: matcher tuning knobs; see enrichWithCalendar.ts.
  timeWindowMinutes?: number;
  minParticipantOverlap?: number;
}

// ---------- Sensitivity guard ----------

export type GuardDecision =
  | { decision: 'allow' }
  | { decision: 'stage'; summary?: string };

// ---------- Pending file ----------

export interface PendingFileHandle {
  id: string;
  destinationPath: string;
}

// ---------- Frontmatter ----------

export interface FrontmatterShape {
  source_type: 'meeting';
  source_system: TranscriptSourceSystem;
  source_uid: string;
  source_url: string;
  source_account?: string;
  description?: string;
  occurred_at: string;
  stored_at: string;
  truncated: boolean;
  duration_minutes?: number;
  review_status: 'pending' | 'reviewed' | 'archived';
  meeting_url?: string;
  calendar_event_id?: string;
  calendar_source?: string;
  [key: string]: unknown;
}

// ---------- Dedup lookup result ----------

export type DedupLookupResult =
  | { found: true; filePath: string }
  | { found: false }
  | { error: Error };

// ---------- Kernel result ----------

export type MeetingSourceKernelResult =
  | {
      kind: 'saved';
      filePath: string;
      emittedEvent: TranscriptSavedEvent;
      alreadyExists: false;
    }
  | {
      kind: 'saved';
      filePath: string;
      emittedEvent: TranscriptSavedEvent;
      alreadyExists: true;
      existingFilePath: string;
    }
  | {
      kind: 'staged';
      pendingFileId: string;
      destinationPath: string;
      // Kernel calls deferTranscriptSaved() internally before returning;
      // adapter does NOT need to wire deferral. See Invariant 4.
    }
  | {
      kind: 'failed';
      reason: MeetingSourceKernelFailureReason;
      error?: Error;
      detail?: string;
    };

// Dedup is a SUCCESS path (alreadyExists: true). Staged-for-review is
// a separate success variant. Only true failures are 'failed'.
export type MeetingSourceKernelFailureReason =
  | 'no_workspace'
  | 'no_target_space'
  | 'cos_unavailable'
  | 'guard_error'
  | 'dedup_lookup_error' // distinct from "not found"
  | 'content_build_error'
  | 'fs_error';

// ---------- Deps (explicit interfaces; correct aliases) ----------

export interface SaveMeetingSourceDeps {
  // Workspace + spaces
  getCoreDirectory: () => string | null;
  resolveTargetSpace: (
    coreDirectory: string,
    input: MeetingSourceInput,
  ) => Promise<TargetSpace | null>;

  // Auth
  getAuthInfo: () => AuthInfo;

  // Calendar enrichment (Stage 0a; net-new helper)
  enrichWithCalendar: (query: EnrichmentQuery) => Promise<EnrichmentResult>;

  // Dedup — wrapped at dep boundary to distinguish "not found" from error.
  // Today's findTranscriptByStableId returns Promise<string | null> and
  // swallows readdir errors as null; the adapter wraps as:
  //   try { return await findById(...); }   // null → {found:false}
  //   catch (e) { return {error: e}; }
  //   string → {found:true, filePath}
  // Inside the adapter the readdir try/catch is also tightened to
  // distinguish ENOENT (folder absent → not found) from EACCES /
  // other errors (→ {error}). Stage 1 deliverable.
  findTranscriptByStableId: (
    spacePath: string,
    stableId: string,
    provider: string,
    meetingDate: Date,
  ) => Promise<DedupLookupResult>;

  // Stable-id construction (per-input policy)
  generateStableId: (input: MeetingSourceInput) => string;

  // Frontmatter + title (per-input policy)
  resolveFrontmatter: (
    input: MeetingSourceInput,
    enriched: EnrichmentResult,
    auth: AuthInfo,
  ) => FrontmatterShape;
  resolveTitle: (
    input: MeetingSourceInput,
    enriched: EnrichmentResult,
  ) => Promise<string>;

  // Filename + folder (per-input policy)
  generateFilename: (
    input: MeetingSourceInput,
    title: string,
    auth: AuthInfo,
    enriched: EnrichmentResult,
  ) => { subfolder: string; filename: string };

  // Markdown body (per-input policy)
  formatMarkdownBody: (
    input: MeetingSourceInput,
    title: string,
    frontmatter: FrontmatterShape,
    auth: AuthInfo,
  ) => string;

  // Sensitivity guard
  evaluateGuard: (
    rawTranscript: string,
    target: TargetSpace,
    coreDirectory: string,
  ) => Promise<GuardDecision>;

  // Filesystem (atomic)
  mkdir: (folder: string) => Promise<void>;
  uniqueFilePath: (basePath: string) => Promise<string>;
  writeFile: (filePath: string, content: string) => Promise<void>;

  // Pending (cos) writes
  writeToPending: (options: {
    destinationPath: string;
    content: string;
    sessionId: string;
    summary: string;
    spaceName: string;
    sharing: 'private' | 'shared' | 'public' | 'team';
    transcriptMeta: string;
  }) => Promise<PendingFileHandle | null>;

  // Sensitivity-guard staging broadcast (called same-tick after writeToPending)
  broadcastStaging: (
    pendingFile: PendingFileHandle,
    destinationPath: string,
    spaceName: string,
    summary: string,
  ) => void;

  // Prep linking (fire-and-forget)
  linkTranscriptToExistingPrep: (filePath: string) => Promise<void>;

  // Event emission (kernel-only callers)
  emitTranscriptSaved: (event: TranscriptSavedEvent) => void;
  deferTranscriptSaved: (
    canonicalDestPath: string,
    event: TranscriptSavedEvent,
  ) => void;
  emitTranscriptDistributionReady: (
    event: TranscriptDistributionReadyEvent,
  ) => void;

  // Misc
  clock: () => Date;
  logger: Logger;
}

// ---------- Kernel-exported upgrade helper ----------
// Synchronous entry-point for the Recall live-transcript upgrade flow.
// Replaces the file content atomically AND emits the
// distribution-ready event in one call. Collapses the v4-era
// UpgradeHelperHandle pattern (which had a silent-failure surface
// when the caller forgot to call the helper).

export interface UpgradeAndEmitInput {
  filePath: string;
  newTranscript: string;
  newQuality: 'recallai_async' | 'desktop_sdk';
  extraFrontmatter?: Record<string, unknown>;
  sourceUid: string;
  sourceSystem: TranscriptSourceSystem;
  spacePath: string;
  meetingTitle: string;
  meetingUrl?: string;
  calendarEventId?: string;
  emitSavedFirst?: { event: TranscriptSavedEvent };
}

export interface UpgradeAndEmitResult {
  success: boolean;
  filePath: string;
  emittedEvent?: TranscriptDistributionReadyEvent;
  alreadyUpgraded?: boolean;
  error?: Error;
}

// Implemented in src/core/meetingSource/saveMeetingSource.ts:
// export async function upgradeAndEmit(
//   input: UpgradeAndEmitInput,
//   deps: Pick<SaveMeetingSourceDeps,
//     'writeFile' | 'emitTranscriptSaved' | 'emitTranscriptDistributionReady' | 'logger'
//   >,
// ): Promise<UpgradeAndEmitResult>
