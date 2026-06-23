import fs from 'node:fs/promises';
import path from 'node:path';
import { createScopedLogger } from '@core/logger';
import {
  buildDesktopSdkFrontmatter,
  buildExternalFrontmatter,
  buildLimitlessFrontmatter,
  buildPlaudFrontmatter,
  buildQuickCaptureFrontmatter,
  buildRecallFrontmatter,
  defaultDesktopSdkTitle,
  defaultLimitlessTitle,
  defaultPlaudTitle,
  defaultQuickCaptureTitle,
} from '@core/meetingSource/builders';
import type {
  AuthInfo,
  EnrichmentResult,
  FrontmatterShape,
  MeetingSourceInput,
  SaveMeetingSourceDeps,
} from '@core/meetingSource';
import { getSettings } from '@core/services/settingsStore';
import { getRebelAuthProvider } from '@core/rebelAuth';
import { enrichMeetingFromCalendarCache } from '@main/services/calendar/calendarEnrichment';
import {
  broadcastTranscriptStagingEvents,
  evaluateTranscriptForSharedSpace,
} from '@main/services/meetingBot/transcriptSensitivityGuard';
import {
  deferTranscriptSaved,
  emitTranscriptDistributionReady,
  emitTranscriptSaved,
} from '@main/services/meetingBot/transcriptEventBus';
import { normalizeSharing } from '@main/services/safety/memoryWriteHook';
import { writeToPending } from '@main/services/safety/cosPendingService';

const log = createScopedLogger({ service: 'save-meeting-source-deps' });
const MAX_FALLBACK_TITLE_LENGTH = 100;
const DISALLOWED_CONTROL_OR_FORMAT_CHARS = /[\p{Cc}\p{Cf}]/gu;

type LegacyTranscriptQuality = 'captions' | 'recallai_async' | 'desktop_sdk';

type LegacyTranscriptData = {
  botId: string;
  meetingTitle: string;
  meetingUrl?: string;
  participants: string[];
  duration: number;
  startTime: string;
  rawTranscript: string;
  summary?: string;
  keyPoints?: string[];
  actionItems?: string[];
  decisions?: string[];
  openQuestions?: string[];
  calendarId?: string;
  recordingId?: string;
  transcriptQuality?: LegacyTranscriptQuality;
  sourceSystem?: 'recall' | 'local' | 'desktop_sdk';
  calendarEventId?: string;
  calendarSource?: string;
  chatMessages?: Array<{ sender: string; text: string; timestamp: string }>;
};

type LegacyExternalTranscriptData = {
  externalId: string;
  provider: 'fireflies' | 'fathom';
  meetingTitle: string;
  meetingUrl?: string;
  transcriptUrl?: string;
  participants: string[];
  duration: number;
  startTime: string;
  rawTranscript: string;
  summary?: string;
  actionItems?: string[];
  calendarId?: string;
};

type LegacyTargetSpace = {
  spacePath: string;
  absolutePath: string;
  spaceName?: string;
  sharing?: string;
  description?: string;
};

export type SaveMeetingSourceLegacyHelpers = {
  determineTargetSpace: (participantCount: number, coreDirectory: string) => Promise<LegacyTargetSpace | null>;
  findTranscriptByStableId: (
    spacePath: string,
    stableId: string,
    provider?: string,
    meetingDate?: Date,
  ) => Promise<string | null>;
  formatTranscriptMarkdown: (transcript: LegacyTranscriptData, userEmail: string | null) => string;
  formatExternalTranscriptMarkdown: (
    transcript: LegacyExternalTranscriptData,
    userEmail: string | null,
  ) => string;
  generateFilename: (
    title: string,
    meetingDate: Date,
    participants: string[],
    userName: string | null,
    provider: string,
  ) => { subfolder: string; filename: string };
  getUniqueFilePath: (filePath: string) => Promise<string>;
  linkTranscriptToExistingPrep: (filePath: string) => Promise<void>;
};

function getParticipantCount(input: MeetingSourceInput): number {
  switch (input.kind) {
    case 'recall':
    case 'external':
    case 'desktop_sdk':
      return input.transcript.participants.length;
    case 'plaud':
    case 'limitless':
    case 'quick_capture':
      return 0;
    default:
      return 0;
  }
}

function getSourceUid(input: MeetingSourceInput): string {
  switch (input.kind) {
    case 'recall':
      return input.transcript.botId;
    case 'external':
      return input.transcript.externalId;
    case 'desktop_sdk':
      return input.transcript.sessionId;
    case 'plaud':
      return `plaud_${input.transcript.fileId}`;
    case 'limitless':
      return `limitless_${input.transcript.lifelogId}`;
    case 'quick_capture':
      return `quick_capture_${input.transcript.sessionId}`;
    default:
      return '';
  }
}

function getTranscriptDate(input: MeetingSourceInput): Date {
  switch (input.kind) {
    case 'plaud':
      return new Date(input.transcript.startAt);
    case 'recall':
    case 'external':
    case 'limitless':
    case 'desktop_sdk':
    case 'quick_capture':
      return new Date(input.transcript.startTime);
    default:
      return new Date();
  }
}

function resolveProviderForFilename(input: MeetingSourceInput): string {
  switch (input.kind) {
    case 'external':
      return input.provider;
    case 'desktop_sdk':
      return 'desktop_sdk';
    case 'plaud':
      return 'plaud';
    case 'limitless':
      return 'limitless';
    case 'quick_capture':
      return 'quick_capture';
    case 'recall':
    default:
      return 'recall';
  }
}

function fallbackTitleForInput(input: MeetingSourceInput): string {
  const clock = () => new Date();
  switch (input.kind) {
    case 'recall':
      return input.transcript.meetingTitle;
    case 'external':
      return input.transcript.meetingTitle;
    case 'desktop_sdk':
      return defaultDesktopSdkTitle(input, clock);
    case 'plaud':
      return defaultPlaudTitle(input, clock);
    case 'limitless':
      return defaultLimitlessTitle(input, clock);
    case 'quick_capture':
      return defaultQuickCaptureTitle(input, clock);
    default:
      return 'Meeting';
  }
}

function normalizeFallbackTitle(
  rawTitle: string,
  sourceKind: MeetingSourceInput['kind'],
  defaultTitle: string,
  logger: SaveMeetingSourceDeps['logger'],
): string {
  const trimmed = rawTitle.trim();
  const stripped = trimmed.replace(DISALLOWED_CONTROL_OR_FORMAT_CHARS, '');

  if (stripped !== trimmed) {
    logger.warn(
      {
        sourceKind,
        originalLength: trimmed.length,
        strippedLength: stripped.length,
      },
      'kernel_fallback_title_stripped',
    );
  }

  if (stripped.length === 0) {
    logger.warn(
      {
        sourceKind,
      },
      'kernel_fallback_title_empty',
    );
    return defaultTitle;
  }

  if (stripped.length > MAX_FALLBACK_TITLE_LENGTH) {
    logger.warn(
      {
        sourceKind,
        titleLength: stripped.length,
        maxLength: MAX_FALLBACK_TITLE_LENGTH,
      },
      'kernel_fallback_title_truncated',
    );
    return stripped.slice(0, MAX_FALLBACK_TITLE_LENGTH);
  }

  return stripped;
}

async function resolveFallbackTitle(
  input: Extract<MeetingSourceInput, { kind: 'desktop_sdk' | 'plaud' | 'limitless' | 'quick_capture' }>,
  logger: SaveMeetingSourceDeps['logger'],
): Promise<string> {
  const defaultTitle = fallbackTitleForInput(input);
  try {
    const fallbackRaw = input.kind === 'plaud' || input.kind === 'quick_capture'
      ? await input.fallbackTitleStrategy()
      : input.fallbackTitleStrategy();

    return normalizeFallbackTitle(
      typeof fallbackRaw === 'string' ? fallbackRaw : String(fallbackRaw ?? ''),
      input.kind,
      defaultTitle,
      logger,
    );
  } catch (error) {
    logger.warn(
      {
        err: error,
        sourceKind: input.kind,
      },
      'kernel_fallback_title_failed',
    );
    return defaultTitle;
  }
}

async function resolveTitle(
  input: MeetingSourceInput,
  enriched: EnrichmentResult,
  logger: SaveMeetingSourceDeps['logger'],
): Promise<string> {
  if (enriched.title && enriched.title.trim().length > 0) {
    return enriched.title.trim();
  }

  switch (input.kind) {
    case 'quick_capture':
    case 'plaud':
    case 'limitless':
    case 'desktop_sdk':
      return resolveFallbackTitle(input, logger);
    case 'recall':
    case 'external':
      return fallbackTitleForInput(input);
    default:
      return 'Meeting';
  }
}

function toTranscriptData(
  input: MeetingSourceInput,
  title: string,
  enriched: EnrichmentResult,
): LegacyTranscriptData {
  if (input.kind === 'desktop_sdk') {
    return {
      botId: input.transcript.sessionId,
      meetingTitle: title,
      meetingUrl: enriched.meetingUrl ?? input.transcript.meetingUrl,
      participants: input.transcript.participants,
      duration: Math.round(input.transcript.durationMs / 1000),
      startTime: input.transcript.startTime,
      rawTranscript: input.transcript.rawTranscript,
      transcriptQuality: 'desktop_sdk',
      sourceSystem: 'desktop_sdk',
      calendarEventId: enriched.calendarEventId,
      calendarSource: enriched.calendarSource,
    };
  }

  return {
    botId: input.kind === 'recall' ? input.transcript.botId : getSourceUid(input),
    meetingTitle: title,
    meetingUrl: input.kind === 'recall'
      ? (enriched.meetingUrl ?? input.transcript.meetingUrl)
      : undefined,
    participants: input.kind === 'recall' ? input.transcript.participants : [],
    duration: Math.round(input.transcript.durationMs / 1000),
    startTime: input.kind === 'recall' ? input.transcript.startTime : new Date().toISOString(),
    rawTranscript: input.transcript.rawTranscript,
    summary: input.kind === 'recall' ? input.transcript.summary : undefined,
    keyPoints: input.kind === 'recall' ? input.transcript.keyPoints : undefined,
    actionItems: input.kind === 'recall' ? input.transcript.actionItems : undefined,
    decisions: input.kind === 'recall' ? input.transcript.decisions : undefined,
    openQuestions: input.kind === 'recall' ? input.transcript.openQuestions : undefined,
    recordingId: input.kind === 'recall' ? input.transcript.recordingId : undefined,
    transcriptQuality: input.kind === 'recall' ? input.transcript.transcriptQuality : undefined,
    sourceSystem: 'recall',
    calendarEventId: enriched.calendarEventId
      ?? (input.kind === 'recall' ? input.transcript.calendarEventId : undefined),
    calendarSource: enriched.calendarSource
      ?? (input.kind === 'recall' ? input.transcript.calendarSource : undefined),
    chatMessages: input.kind === 'recall' ? input.transcript.chatMessages : undefined,
  };
}

function toExternalTranscriptData(
  input: Extract<MeetingSourceInput, { kind: 'external' }>,
  title: string,
  enriched: EnrichmentResult,
): LegacyExternalTranscriptData {
  return {
    externalId: input.transcript.externalId,
    provider: input.provider,
    meetingTitle: title,
    meetingUrl: enriched.meetingUrl ?? input.meetingUrl ?? input.transcript.meetingUrl,
    transcriptUrl: input.transcript.transcriptUrl,
    participants: input.transcript.participants,
    duration: Math.round(input.transcript.durationMs / 1000),
    startTime: input.transcript.startTime,
    rawTranscript: input.transcript.rawTranscript,
    summary: input.transcript.summary,
    actionItems: input.transcript.actionItems,
    calendarId: enriched.calendarEventId ?? input.calendarEventId ?? undefined,
  };
}

function frontmatterForInput(
  input: MeetingSourceInput,
  enriched: EnrichmentResult,
  auth: AuthInfo,
): FrontmatterShape {
  switch (input.kind) {
    case 'recall':
      return buildRecallFrontmatter(input, enriched, auth);
    case 'external':
      return buildExternalFrontmatter(input, enriched, auth);
    case 'desktop_sdk':
      return buildDesktopSdkFrontmatter(input, enriched, auth);
    case 'plaud':
      return buildPlaudFrontmatter(input, enriched, auth);
    case 'limitless':
      return buildLimitlessFrontmatter(input, enriched, auth);
    case 'quick_capture':
      return buildQuickCaptureFrontmatter(input, enriched, auth);
    default:
      return buildRecallFrontmatter(
        {
          kind: 'recall',
          provider: 'recall',
          transcript: {
            botId: '',
            meetingTitle: '',
            participants: [],
            durationMs: 0,
            startTime: new Date().toISOString(),
            rawTranscript: '',
          },
        },
        enriched,
        auth,
      );
  }
}

function escapeYaml(value: string): string {
  return value.replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function dateOnly(isoLike: string): string {
  const parsed = new Date(isoLike);
  if (Number.isNaN(parsed.getTime())) {
    return new Date().toISOString().split('T')[0];
  }
  return parsed.toISOString().split('T')[0];
}

function buildOptionalCalendarLines(frontmatter: FrontmatterShape): string[] {
  const lines: string[] = [];
  if (typeof frontmatter.meeting_url === 'string' && frontmatter.meeting_url.length > 0) {
    lines.push(`meeting_url: "${escapeYaml(frontmatter.meeting_url)}"`);
  }
  if (typeof frontmatter.calendar_event_id === 'string' && frontmatter.calendar_event_id.length > 0) {
    lines.push(`calendar_event_id: "${escapeYaml(frontmatter.calendar_event_id)}"`);
  }
  if (typeof frontmatter.calendar_source === 'string' && frontmatter.calendar_source.length > 0) {
    lines.push(`calendar_source: "${escapeYaml(frontmatter.calendar_source)}"`);
  }
  return lines;
}

function upsertFrontmatterString(
  markdown: string,
  key: string,
  value: string,
): string {
  const frontmatterMatch = markdown.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatterMatch) {
    return markdown;
  }

  const fields = frontmatterMatch[1].split('\n');
  const serialized = `${key}: "${escapeYaml(value)}"`;
  const keyPrefix = `${key}:`;
  const index = fields.findIndex((line) => line.startsWith(keyPrefix));

  if (index >= 0) {
    fields[index] = serialized;
  } else {
    fields.push(serialized);
  }

  const frontmatterBlock = `---\n${fields.join('\n')}\n---`;
  return `${frontmatterBlock}${markdown.slice(frontmatterMatch[0].length)}`;
}

function alignKernelFrontmatter(
  markdown: string,
  frontmatter: FrontmatterShape,
): string {
  let updated = upsertFrontmatterString(markdown, 'source_system', frontmatter.source_system);
  updated = upsertFrontmatterString(updated, 'source_uid', frontmatter.source_uid);
  updated = upsertFrontmatterString(updated, 'source_url', frontmatter.source_url);
  return updated;
}

function markdownBodyForInput(
  input: MeetingSourceInput,
  title: string,
  frontmatter: FrontmatterShape,
  auth: AuthInfo,
  helpers: SaveMeetingSourceLegacyHelpers,
): string {
  const meetingUrl = typeof frontmatter.meeting_url === 'string'
    ? frontmatter.meeting_url
    : undefined;
  const calendarEventId = typeof frontmatter.calendar_event_id === 'string'
    ? frontmatter.calendar_event_id
    : undefined;
  const calendarSource = typeof frontmatter.calendar_source === 'string'
    ? frontmatter.calendar_source
    : undefined;

  switch (input.kind) {
    case 'recall':
      return alignKernelFrontmatter(helpers.formatTranscriptMarkdown(
        toTranscriptData(input, title, {
          matched: !!calendarEventId,
          meetingUrl,
          calendarEventId,
          calendarSource,
        }),
        auth.userEmail,
      ), frontmatter);
    case 'desktop_sdk':
      return alignKernelFrontmatter(helpers.formatTranscriptMarkdown(
        toTranscriptData(input, title, {
          matched: !!calendarEventId,
          meetingUrl,
          calendarEventId,
          calendarSource,
        }),
        auth.userEmail,
      ), frontmatter);
    case 'external':
      return alignKernelFrontmatter(helpers.formatExternalTranscriptMarkdown(
        toExternalTranscriptData(input, title, {
          matched: !!calendarEventId,
          meetingUrl,
          calendarEventId,
          calendarSource,
        }),
        auth.userEmail,
      ), frontmatter);
    case 'plaud': {
      const optionalCalendarLines = buildOptionalCalendarLines(frontmatter);
      const occurredAt = dateOnly(input.transcript.startAt);
      const storedAt = new Date().toISOString().split('T')[0];
      const durationMinutes = Math.round(input.transcript.durationMs / 60000);

      return alignKernelFrontmatter([
        '---',
        `description: "${escapeYaml(title)}"`,
        'source_type: meeting',
        'source_system: plaud',
        `source_account: ${auth.userEmail ?? 'unknown'}`,
        `source_uid: plaud_${input.transcript.fileId}`,
        `source_url: "urn:plaud:recording:${input.transcript.fileId}"`,
        `occurred_at: ${occurredAt}`,
        `stored_at: ${storedAt}`,
        'truncated: false',
        `duration_minutes: ${durationMinutes}`,
        'device: "Plaud"',
        ...optionalCalendarLines,
        'review_status: pending',
        '---',
        '',
        `# ${title}`,
        '',
        '*Recorded in-person with Plaud*',
        '',
        '## Full Content',
        '',
        input.transcript.rawTranscript,
      ].join('\n'), frontmatter);
    }
    case 'limitless': {
      const optionalCalendarLines = buildOptionalCalendarLines(frontmatter);
      const occurredAt = dateOnly(input.transcript.startTime);
      const storedAt = new Date().toISOString().split('T')[0];
      const durationMinutes = Math.round(input.transcript.durationMs / 60000);

      return alignKernelFrontmatter([
        '---',
        `description: "${escapeYaml(title)}"`,
        'source_type: meeting',
        'source_system: limitless',
        `source_account: ${auth.userEmail ?? 'unknown'}`,
        `source_uid: limitless_${input.transcript.lifelogId}`,
        `source_url: "urn:limitless:recording:${input.transcript.lifelogId}"`,
        `occurred_at: ${occurredAt}`,
        `stored_at: ${storedAt}`,
        'truncated: false',
        `duration_minutes: ${durationMinutes}`,
        'device: "Limitless Pendant"',
        ...optionalCalendarLines,
        'review_status: pending',
        '---',
        '',
        `# ${title}`,
        '',
        '*Recorded in-person with Limitless Pendant*',
        '',
        '## Full Content',
        '',
        input.transcript.rawTranscript,
      ].join('\n'), frontmatter);
    }
    case 'quick_capture': {
      const optionalCalendarLines = buildOptionalCalendarLines(frontmatter);
      const occurredAt = dateOnly(input.transcript.startTime);
      const storedAt = new Date().toISOString().split('T')[0];
      const durationMinutes = Math.round(input.transcript.durationMs / 60000);

      return alignKernelFrontmatter([
        '---',
        `description: "${escapeYaml(title)}"`,
        'source_type: meeting',
        'source_system: quick_capture',
        `source_account: ${auth.userEmail ?? 'unknown'}`,
        `source_uid: quick_capture_${input.transcript.sessionId}`,
        `source_url: "urn:quick_capture:session:${input.transcript.sessionId}"`,
        `occurred_at: ${occurredAt}`,
        `stored_at: ${storedAt}`,
        'truncated: false',
        `duration_minutes: ${durationMinutes}`,
        'device: "Built-in Microphone"',
        ...optionalCalendarLines,
        'review_status: pending',
        '---',
        '',
        `# ${title}`,
        '',
        '*Recorded in-person with Built-in Microphone*',
        '',
        '## Full Content',
        '',
        input.transcript.rawTranscript,
      ].join('\n'), frontmatter);
    }
    default:
      return '';
  }
}

function inferMeetingUrlAndParticipants(input: MeetingSourceInput): {
  meetingUrl?: string;
  participants?: string[];
  startTime: string;
  durationMs: number;
} {
  switch (input.kind) {
    case 'recall':
      return {
        meetingUrl: input.transcript.meetingUrl,
        participants: input.transcript.participants,
        startTime: input.transcript.startTime,
        durationMs: input.transcript.durationMs,
      };
    case 'external':
      return {
        meetingUrl: input.meetingUrl ?? input.transcript.meetingUrl ?? undefined,
        participants: input.transcript.participants,
        startTime: input.transcript.startTime,
        durationMs: input.transcript.durationMs,
      };
    case 'desktop_sdk':
      return {
        meetingUrl: input.transcript.meetingUrl,
        participants: input.transcript.participants,
        startTime: input.transcript.startTime,
        durationMs: input.transcript.durationMs,
      };
    case 'plaud':
      return {
        participants: [],
        startTime: input.transcript.startAt,
        durationMs: input.transcript.durationMs,
      };
    case 'limitless':
    case 'quick_capture':
      return {
        participants: [],
        startTime: input.transcript.startTime,
        durationMs: input.transcript.durationMs,
      };
    default:
      return {
        startTime: new Date().toISOString(),
        durationMs: 0,
      };
  }
}

function toKernelSharing(
  sharing: string | undefined,
): 'private' | 'shared' | 'public' | 'team' {
  const normalized = normalizeSharing(sharing);
  if (normalized === 'private' || normalized === 'public') {
    return normalized;
  }
  return 'shared';
}

export function buildSaveMeetingSourceDeps(
  helpers: SaveMeetingSourceLegacyHelpers,
  options?: { logger?: SaveMeetingSourceDeps['logger'] },
): SaveMeetingSourceDeps {
  const logger = options?.logger ?? log;
  return {
    getCoreDirectory: () => getSettings().coreDirectory ?? null,
    resolveTargetSpace: async (coreDirectory, input) => {
      const target = await helpers.determineTargetSpace(getParticipantCount(input), coreDirectory);
      if (!target) {
        return null;
      }
      return {
        spacePath: target.spacePath,
        absolutePath: target.absolutePath,
        spaceName: target.spaceName ?? target.spacePath,
        sharing: toKernelSharing(target.sharing),
        description: target.description,
      };
    },
    getAuthInfo: () => {
      const authState = getRebelAuthProvider().getAuthState();
      return {
        userName: authState?.user?.name ?? null,
        userEmail: authState?.user?.email ?? null,
      };
    },
    enrichWithCalendar: async (query) => enrichMeetingFromCalendarCache(query),
    findTranscriptByStableId: async (spacePath, stableId, provider, meetingDate) => {
      try {
        const existing = await helpers.findTranscriptByStableId(
          spacePath,
          stableId,
          provider,
          meetingDate,
        );
        if (!existing) {
          return { found: false };
        }
        return { found: true, filePath: existing };
      } catch (error) {
        return { error: error instanceof Error ? error : new Error(String(error)) };
      }
    },
    generateStableId: (input) => getSourceUid(input),
    resolveFrontmatter: (input, enriched, auth) => frontmatterForInput(input, enriched, auth),
    resolveTitle: async (input, enriched) => resolveTitle(input, enriched, logger),
    generateFilename: (input, title, auth) =>
      helpers.generateFilename(
        title,
        getTranscriptDate(input),
        inferMeetingUrlAndParticipants(input).participants ?? [],
        auth.userName,
        resolveProviderForFilename(input),
      ),
    formatMarkdownBody: (input, title, frontmatter, auth) =>
      markdownBodyForInput(input, title, frontmatter, auth, helpers),
    evaluateGuard: async (rawTranscript, target, coreDirectory) => {
      const result = await evaluateTranscriptForSharedSpace(rawTranscript, target, coreDirectory);
      if (result.decision === 'stage') {
        return { decision: 'stage', summary: result.summary };
      }
      return { decision: 'allow' };
    },
    mkdir: async (folder) => {
      await fs.mkdir(folder, { recursive: true });
    },
    uniqueFilePath: async (basePath) => helpers.getUniqueFilePath(basePath),
    writeFile: async (filePath, content) => {
      await fs.writeFile(filePath, content, 'utf-8');
    },
    writeToPending: async (options) => {
      const pending = await writeToPending({
        ...options,
        sharing: normalizeSharing(options.sharing),
      });
      if (!pending) {
        return null;
      }
      return {
        id: pending.id,
        destinationPath: options.destinationPath,
      };
    },
    broadcastStaging: (pendingFile, destinationPath, spaceName, summary) => {
      broadcastTranscriptStagingEvents(
        {
          id: pendingFile.id,
          filename: path.basename(destinationPath),
        },
        destinationPath,
        spaceName,
        summary,
      );
    },
    linkTranscriptToExistingPrep: async (filePath) => helpers.linkTranscriptToExistingPrep(filePath),
    emitTranscriptSaved,
    deferTranscriptSaved,
    emitTranscriptDistributionReady,
    clock: () => new Date(),
    logger,
  };
}
