import type {
  AuthInfo,
  EnrichmentResult,
  FrontmatterShape,
  MeetingSourceInput,
} from './types';

type RecallInput = Extract<MeetingSourceInput, { kind: 'recall' }>;
type ExternalInput = Extract<MeetingSourceInput, { kind: 'external' }>;
type PlaudInput = Extract<MeetingSourceInput, { kind: 'plaud' }>;
type LimitlessInput = Extract<MeetingSourceInput, { kind: 'limitless' }>;
type DesktopSdkInput = Extract<MeetingSourceInput, { kind: 'desktop_sdk' }>;
type QuickCaptureInput = Extract<MeetingSourceInput, { kind: 'quick_capture' }>;

function asDateOnly(dateInput: string): string {
  const parsed = new Date(dateInput);
  if (Number.isNaN(parsed.getTime())) {
    return '1970-01-01';
  }
  return parsed.toISOString().split('T')[0];
}

function toDurationMinutes(durationMs: number): number {
  return Math.round(durationMs / 60000);
}

function pickCalendarFields(
  enriched: EnrichmentResult,
  fallbackMeetingUrl?: string,
  fallbackCalendarEventId?: string,
  fallbackCalendarSource?: string,
): Partial<FrontmatterShape> {
  const meetingUrl = enriched.meetingUrl ?? fallbackMeetingUrl;
  const calendarEventId = enriched.calendarEventId ?? fallbackCalendarEventId;
  const calendarSource = enriched.calendarSource ?? fallbackCalendarSource;

  return {
    ...(meetingUrl ? { meeting_url: meetingUrl } : {}),
    ...(calendarEventId ? { calendar_event_id: calendarEventId } : {}),
    ...(calendarSource ? { calendar_source: calendarSource } : {}),
  };
}

function baseFrontmatter(
  sourceSystem: FrontmatterShape['source_system'],
  sourceUid: string,
  sourceUrl: string,
  description: string,
  occurredAt: string,
  durationMinutes: number,
  auth: AuthInfo,
): FrontmatterShape {
  return {
    source_type: 'meeting',
    source_system: sourceSystem,
    source_uid: sourceUid,
    source_url: sourceUrl,
    source_account: auth.userEmail ?? 'unknown',
    description,
    occurred_at: occurredAt,
    stored_at: occurredAt,
    truncated: false,
    duration_minutes: durationMinutes,
    review_status: 'pending',
  };
}

/**
 * buildRecallFrontmatter(input, enriched, auth) — source_system: 'recall', source_url: urn:recall:bot:<botId>.
 */
export function buildRecallFrontmatter(
  input: RecallInput,
  enriched: EnrichmentResult,
  auth: AuthInfo,
): FrontmatterShape {
  const occurredAt = asDateOnly(input.transcript.startTime);

  return {
    ...baseFrontmatter(
      'recall',
      input.transcript.botId,
      `urn:recall:bot:${input.transcript.botId}`,
      input.transcript.meetingTitle,
      occurredAt,
      toDurationMinutes(input.transcript.durationMs),
      auth,
    ),
    ...pickCalendarFields(
      enriched,
      input.transcript.meetingUrl,
      input.transcript.calendarEventId,
      input.transcript.calendarSource,
    ),
  };
}

/**
 * buildExternalFrontmatter(input, enriched, auth) — source_system: <provider>, source_url: urn:<provider>:transcript:<externalId>.
 * Pulls meetingUrl + calendarEventId from input variant directly; enrichment overrides.
 */
export function buildExternalFrontmatter(
  input: ExternalInput,
  enriched: EnrichmentResult,
  auth: AuthInfo,
): FrontmatterShape {
  const occurredAt = asDateOnly(input.transcript.startTime);
  const meetingUrl = input.meetingUrl ?? input.transcript.meetingUrl;

  return {
    ...baseFrontmatter(
      input.provider,
      input.transcript.externalId,
      `urn:${input.provider}:transcript:${input.transcript.externalId}`,
      input.transcript.meetingTitle,
      occurredAt,
      toDurationMinutes(input.transcript.durationMs),
      auth,
    ),
    ...pickCalendarFields(enriched, meetingUrl, input.calendarEventId ?? undefined),
  };
}

/**
 * buildPlaudFrontmatter(input, enriched, auth) — source_system: 'plaud', source_url: urn:plaud:recording:<fileId>, device: "Plaud".
 */
export function buildPlaudFrontmatter(
  input: PlaudInput,
  enriched: EnrichmentResult,
  auth: AuthInfo,
): FrontmatterShape {
  const occurredAt = asDateOnly(input.transcript.startAt);

  return {
    ...baseFrontmatter(
      'plaud',
      `plaud_${input.transcript.fileId}`,
      `urn:plaud:recording:${input.transcript.fileId}`,
      enriched.title ?? 'Plaud Recording',
      occurredAt,
      toDurationMinutes(input.transcript.durationMs),
      auth,
    ),
    ...pickCalendarFields(enriched),
    device: 'Plaud',
  };
}

/**
 * buildLimitlessFrontmatter(input, enriched, auth) — source_system: 'limitless', source_url: urn:limitless:recording:<lifelogId>, device: "Limitless Pendant".
 */
export function buildLimitlessFrontmatter(
  input: LimitlessInput,
  enriched: EnrichmentResult,
  auth: AuthInfo,
): FrontmatterShape {
  const occurredAt = asDateOnly(input.transcript.startTime);

  return {
    ...baseFrontmatter(
      'limitless',
      `limitless_${input.transcript.lifelogId}`,
      `urn:limitless:recording:${input.transcript.lifelogId}`,
      input.transcript.title,
      occurredAt,
      toDurationMinutes(input.transcript.durationMs),
      auth,
    ),
    ...pickCalendarFields(enriched),
    device: 'Limitless Pendant',
  };
}

/**
 * buildDesktopSdkFrontmatter(input, enriched, auth) — source_system: 'desktop_sdk', source_url: urn:desktop_sdk:session:<sessionId>.
 */
export function buildDesktopSdkFrontmatter(
  input: DesktopSdkInput,
  enriched: EnrichmentResult,
  auth: AuthInfo,
): FrontmatterShape {
  const occurredAt = asDateOnly(input.transcript.startTime);

  return {
    ...baseFrontmatter(
      'desktop_sdk',
      input.transcript.sessionId,
      `urn:desktop_sdk:session:${input.transcript.sessionId}`,
      input.transcript.meetingTitle,
      occurredAt,
      toDurationMinutes(input.transcript.durationMs),
      auth,
    ),
    ...pickCalendarFields(enriched, input.transcript.meetingUrl),
  };
}

/**
 * buildQuickCaptureFrontmatter(input, enriched, auth) — source_system: 'quick_capture', source_url: urn:quick_capture:session:<sessionId>.
 */
export function buildQuickCaptureFrontmatter(
  input: QuickCaptureInput,
  enriched: EnrichmentResult,
  auth: AuthInfo,
): FrontmatterShape {
  const occurredAt = asDateOnly(input.transcript.startTime);

  return {
    ...baseFrontmatter(
      'quick_capture',
      `quick_capture_${input.transcript.sessionId}`,
      `urn:quick_capture:session:${input.transcript.sessionId}`,
      input.transcript.title,
      occurredAt,
      toDurationMinutes(input.transcript.durationMs),
      auth,
    ),
    ...pickCalendarFields(enriched),
  };
}

function resolveClockDate(clock: (() => Date) | Date): Date {
  return typeof clock === 'function' ? clock() : clock;
}

function parseDateOrClock(isoLike: string | undefined, clock: (() => Date) | Date): Date {
  const parsed = new Date(isoLike ?? '');
  return Number.isNaN(parsed.getTime()) ? resolveClockDate(clock) : parsed;
}

/**
 * defaultPlaudTitle(input, clock) — Plaud Recording - <h:mm AM/PM>
 */
export function defaultPlaudTitle(input: PlaudInput, clock: () => Date): string {
  const date = parseDateOrClock(input.transcript?.startAt, clock);
  const timeStr = date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  return `Plaud Recording - ${timeStr}`;
}

/**
 * defaultLimitlessTitle(input, clock) — matches physicalRecording/transcriptionService.ts generateDefaultTitle().
 */
export function defaultLimitlessTitle(input: LimitlessInput, clock: () => Date): string {
  const date = parseDateOrClock(input.transcript.startTime, clock);
  const timeStr = date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  return `Recording at ${timeStr}`;
}

/**
 * defaultDesktopSdkTitle(input, clock) — matches localRecordingService.ts fallback.
 */
export function defaultDesktopSdkTitle(input: DesktopSdkInput, _clock: () => Date): string {
  const title = input.transcript.meetingTitle.trim();
  return title.length > 0 ? title : 'Local Recording';
}

/**
 * defaultQuickCaptureTitle(input, clock) — matches transcriptionService.ts fallback.
 */
export function defaultQuickCaptureTitle(input: QuickCaptureInput, clock: () => Date): string {
  const date = parseDateOrClock(input.transcript.startTime, clock);
  const timeStr = date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  return `Recording at ${timeStr}`;
}
