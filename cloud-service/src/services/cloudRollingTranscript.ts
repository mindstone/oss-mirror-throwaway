import { createScopedLogger } from '@core/logger';
import type { TranscriptSegment } from '../schemas/transcriptSegment';

const log = createScopedLogger({ service: 'cloudRollingTranscript' });

const DEFAULT_ACTIVE_WINDOW_MS = 4 * 60 * 60 * 1000;
const DEFAULT_MAX_ACTIVE_MEETINGS = 100;
const DEFAULT_AUTH_FAILURE_WINDOW_MS = 5 * 60 * 1000;

interface CloudRollingTranscriptOptions {
  activeWindowMs?: number;
  maxActiveMeetings?: number;
  authFailureWindowMs?: number;
  now?: () => number;
}

interface AuthOutcome {
  atMs: number;
  success: boolean;
}

export interface RollingTranscriptMeeting {
  recallBotId: string;
  meetingTitle: string | null;
  recordingStartedAt: number;
  lastSegmentAt: number;
  segments: TranscriptSegment[];
}

export class CloudRollingTranscript {
  private readonly activeWindowMs: number;
  private readonly maxActiveMeetings: number;
  private readonly authFailureWindowMs: number;
  private readonly now: () => number;
  private readonly meetings = new Map<string, RollingTranscriptMeeting>();
  private readonly authOutcomes: AuthOutcome[] = [];
  private stickyAuthError = false;

  public constructor(options: CloudRollingTranscriptOptions = {}) {
    this.activeWindowMs = options.activeWindowMs ?? DEFAULT_ACTIVE_WINDOW_MS;
    this.maxActiveMeetings = options.maxActiveMeetings ?? DEFAULT_MAX_ACTIVE_MEETINGS;
    this.authFailureWindowMs = options.authFailureWindowMs ?? DEFAULT_AUTH_FAILURE_WINDOW_MS;
    this.now = options.now ?? (() => Date.now());
  }

  public appendSegments(recallBotId: string, segments: TranscriptSegment[], meetingTitle?: string): RollingTranscriptMeeting {
    const nowMs = this.now();
    this.evictExpiredMeetings(nowMs);

    const existing = this.meetings.get(recallBotId);
    const baseRecordingStartedAt = existing?.recordingStartedAt
      ?? segments.reduce((min, segment) => Math.min(min, segment.timestamp), Number.POSITIVE_INFINITY);
    const recordingStartedAt = Number.isFinite(baseRecordingStartedAt) ? baseRecordingStartedAt : nowMs;

    const mergedSegments = existing ? [...existing.segments] : [];
    const existingSegmentIds = new Set(mergedSegments.map((segment) => segment.segmentId));
    for (const segment of segments) {
      if (existingSegmentIds.has(segment.segmentId)) continue;
      mergedSegments.push({ ...segment });
      existingSegmentIds.add(segment.segmentId);
    }

    const latestTimestampInBatch = segments.reduce((max, segment) => Math.max(max, segment.timestamp), 0);
    const nextLastSegmentAt = existing
      ? Math.max(existing.lastSegmentAt, latestTimestampInBatch)
      : (latestTimestampInBatch > 0 ? latestTimestampInBatch : nowMs);

    const meeting: RollingTranscriptMeeting = {
      recallBotId,
      meetingTitle: meetingTitle ?? existing?.meetingTitle ?? null,
      recordingStartedAt,
      lastSegmentAt: nextLastSegmentAt,
      segments: mergedSegments,
    };

    this.meetings.delete(recallBotId);
    this.meetings.set(recallBotId, meeting);
    this.evictLeastRecentlyAppendedMeetings();

    return this.cloneMeeting(meeting);
  }

  public getActiveMeetings(): RollingTranscriptMeeting[] {
    const nowMs = this.now();
    this.evictExpiredMeetings(nowMs);
    return Array.from(this.meetings.values()).map((meeting) => this.cloneMeeting(meeting));
  }

  public getStaleness(recallBotId: string): number | null {
    const nowMs = this.now();
    this.evictExpiredMeetings(nowMs);
    const meeting = this.meetings.get(recallBotId);
    if (!meeting) return null;
    return Math.max(0, nowMs - meeting.lastSegmentAt);
  }

  public recordAuthOutcome(success: boolean, atMs: number = this.now()): void {
    this.authOutcomes.push({ atMs, success });
    this.pruneAuthOutcomes(atMs);
    const total = this.authOutcomes.length;
    if (total === 0) return;

    const failures = this.authOutcomes.filter((outcome) => !outcome.success).length;
    const failureRate = failures / total;
    if (failureRate > 0.5) {
      if (!this.stickyAuthError) {
        log.warn({ failures, total, failureRate }, 'meeting transcript ingest auth failure rate exceeded threshold');
      }
      this.stickyAuthError = true;
    }
  }

  public hasStickyAuthError(): boolean {
    return this.stickyAuthError;
  }

  public clearForTesting(): void {
    this.meetings.clear();
    this.authOutcomes.length = 0;
    this.stickyAuthError = false;
  }

  private evictExpiredMeetings(nowMs: number): void {
    for (const [recallBotId, meeting] of this.meetings.entries()) {
      if (nowMs - meeting.lastSegmentAt <= this.activeWindowMs) continue;
      this.meetings.delete(recallBotId);
      log.info({ recallBotId }, 'evicted stale meeting transcript from rolling store');
    }
  }

  private evictLeastRecentlyAppendedMeetings(): void {
    while (this.meetings.size > this.maxActiveMeetings) {
      const oldest = this.meetings.keys().next().value;
      if (!oldest) break;
      this.meetings.delete(oldest);
      log.warn({ recallBotId: oldest }, 'evicted least recently appended meeting transcript due to capacity limit');
    }
  }

  private pruneAuthOutcomes(nowMs: number): void {
    const oldestAllowed = nowMs - this.authFailureWindowMs;
    while (this.authOutcomes.length > 0 && this.authOutcomes[0].atMs < oldestAllowed) {
      this.authOutcomes.shift();
    }
  }

  private cloneMeeting(meeting: RollingTranscriptMeeting): RollingTranscriptMeeting {
    return {
      ...meeting,
      segments: meeting.segments.map((segment) => ({ ...segment })),
    };
  }
}

export const cloudRollingTranscript = new CloudRollingTranscript();
