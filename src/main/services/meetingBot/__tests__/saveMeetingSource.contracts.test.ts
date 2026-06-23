import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import fm from 'front-matter';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  EnrichmentQuery,
  MeetingSourceInput,
  SaveMeetingSourceDeps,
} from '@core/meetingSource';
import {
  saveMeetingSource,
  upgradeAndEmit,
} from '@core/meetingSource/saveMeetingSource';
import { enrichWithCalendar } from '@core/meetingSource/calendar/enrichWithCalendar';
import {
  buildSaveMeetingSourceDeps,
  type SaveMeetingSourceLegacyHelpers,
} from '../saveMeetingSourceDeps';
import {
  findTranscriptByStableId as findTranscriptByStableIdFs,
  formatExternalTranscriptMarkdown,
  formatTranscriptMarkdown,
  generateFilename,
} from '../transcriptStorage';
import { parsePendingFile, serializePendingFile } from '../../safety/cosPendingService';

type LoggerMock = {
  trace: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  fatal: ReturnType<typeof vi.fn>;
};

type CalendarMeeting = {
  calendarEventId: string;
  calendarSource: string;
  title: string;
  startTime: string;
  endTime?: string;
  meetingUrl?: string;
  participants?: string[];
  invitees?: string[];
};

type LegacyTargetSpace = {
  spacePath: string;
  absolutePath: string;
  spaceName?: string;
  sharing?: string;
  description?: string;
};

type PendingWriteOptions = {
  destinationPath: string;
  content: string;
  sessionId: string;
  summary: string;
  spaceName: string;
  sharing: 'private' | 'shared' | 'public' | 'team';
  transcriptMeta: string;
};

const FIXED_NOW = new Date('2026-05-19T10:00:00.000Z');
const DEFAULT_CORE_DIR = '/workspace';
const DEFAULT_TARGET_SPACE: LegacyTargetSpace = {
  spacePath: 'Chief-of-Staff',
  absolutePath: '/workspace/Chief-of-Staff',
  spaceName: 'Chief of Staff',
  sharing: 'private',
};

function createLoggerMock(): LoggerMock {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  };
}

function normalizeMeetingUrl(url: string): string {
  const zoomMatch = url.match(/\/j\/([^/?]+)/i);
  if (zoomMatch) {
    return zoomMatch[1].toLowerCase();
  }

  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.pathname}`.replace(/\/+$/, '').toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
}

function createCalendarEnricher(
  meetings: CalendarMeeting[],
  logger: SaveMeetingSourceDeps['logger'],
): SaveMeetingSourceDeps['enrichWithCalendar'] {
  return async (query: EnrichmentQuery) => enrichWithCalendar(query, {
    listCachedMeetings: async () => meetings,
    normalizeUrl: normalizeMeetingUrl,
    logger,
    clock: () => FIXED_NOW,
  });
}

type RecallOverrides = Partial<Extract<MeetingSourceInput, { kind: 'recall' }>['transcript']>;
type ExternalOverrides = Partial<Extract<MeetingSourceInput, { kind: 'external' }>['transcript']>;
type PlaudOverrides = Partial<Extract<MeetingSourceInput, { kind: 'plaud' }>['transcript']>;
type LimitlessOverrides = Partial<Extract<MeetingSourceInput, { kind: 'limitless' }>['transcript']>;
type DesktopOverrides = Partial<Extract<MeetingSourceInput, { kind: 'desktop_sdk' }>['transcript']>;
type QuickCaptureOverrides = Partial<Extract<MeetingSourceInput, { kind: 'quick_capture' }>['transcript']>;

function makeRecallInput(overrides: RecallOverrides = {}): MeetingSourceInput {
  return {
    kind: 'recall',
    provider: 'recall',
    transcript: {
      botId: 'recall-bot-1',
      meetingTitle: 'Recall Fallback Title',
      meetingUrl: 'https://meet.google.com/recall-abc',
      participants: ['Alice Example', 'Bob Example'],
      durationMs: 30 * 60 * 1000,
      startTime: '2026-05-19T10:00:00.000Z',
      rawTranscript: 'Recall transcript content',
      ...overrides,
    },
  };
}

function makeExternalInput(
  provider: 'fireflies' | 'fathom',
  overrides: ExternalOverrides = {},
  metadataOverrides: Partial<Extract<MeetingSourceInput, { kind: 'external' }>> = {},
): MeetingSourceInput {
  return {
    kind: 'external',
    provider,
    meetingUrl: 'https://zoom.us/j/111111111',
    calendarEventId: null,
    transcript: {
      externalId: `${provider}-ext-1`,
      meetingTitle: `${provider} Transcript`,
      meetingUrl: 'https://zoom.us/j/111111111',
      participants: ['Casey Example', 'Jordan Example'],
      durationMs: 25 * 60 * 1000,
      startTime: '2026-05-19T10:00:00.000Z',
      rawTranscript: `${provider} transcript content`,
      ...overrides,
    },
    ...metadataOverrides,
  };
}

function makePlaudInput(
  fallbackTitleStrategy: () => Promise<string>,
  overrides: PlaudOverrides = {},
): MeetingSourceInput {
  return {
    kind: 'plaud',
    fallbackTitleStrategy,
    transcript: {
      fileId: 'plaud-file-1',
      startAt: '2026-05-12T10:15:00.000Z',
      durationMs: 30 * 60 * 1000,
      rawTranscript: 'Plaud transcript content',
      ...overrides,
    },
  };
}

function makeLimitlessInput(
  fallbackTitleStrategy: () => string,
  overrides: LimitlessOverrides = {},
): MeetingSourceInput {
  return {
    kind: 'limitless',
    fallbackTitleStrategy,
    transcript: {
      lifelogId: 'limitless-lifelog-1',
      title: 'Limitless Recording',
      startTime: '2026-05-19T10:00:00.000Z',
      durationMs: 40 * 60 * 1000,
      rawTranscript: 'Limitless transcript content',
      ...overrides,
    },
  };
}

function makeDesktopInput(
  fallbackTitleStrategy: () => string,
  overrides: DesktopOverrides = {},
): MeetingSourceInput {
  return {
    kind: 'desktop_sdk',
    fallbackTitleStrategy,
    transcript: {
      sessionId: 'desktop-session-1',
      meetingTitle: 'Desktop SDK Recording',
      meetingUrl: 'https://teams.microsoft.com/l/desktop-session',
      participants: ['Desktop User'],
      durationMs: 20 * 60 * 1000,
      startTime: '2026-05-19T10:00:00.000Z',
      rawTranscript: 'Desktop transcript content',
      ...overrides,
    },
  };
}

function makeQuickCaptureInput(
  fallbackTitleStrategy: () => Promise<string>,
  overrides: QuickCaptureOverrides = {},
): MeetingSourceInput {
  return {
    kind: 'quick_capture',
    fallbackTitleStrategy,
    transcript: {
      sessionId: 'quick-session-1',
      title: 'Quick Capture Recording',
      startTime: '2026-05-19T10:00:00.000Z',
      durationMs: 15 * 60 * 1000,
      rawTranscript: 'Quick capture transcript content',
      ...overrides,
    },
  };
}

type HarnessOptions = {
  coreDirectory?: string | null;
  authInfo?: { userName: string | null; userEmail: string | null };
  targetSpace?: LegacyTargetSpace | null;
  helperOverrides?: Partial<SaveMeetingSourceLegacyHelpers>;
  depOverrides?: Partial<SaveMeetingSourceDeps>;
};

type KernelHarness = {
  deps: SaveMeetingSourceDeps;
  logger: LoggerMock;
  writes: Array<{ filePath: string; content: string }>;
  spies: {
    determineTargetSpace: ReturnType<typeof vi.fn>;
    findTranscriptByStableId: ReturnType<typeof vi.fn>;
    mkdir: ReturnType<typeof vi.fn>;
    uniqueFilePath: ReturnType<typeof vi.fn>;
    writeFile: ReturnType<typeof vi.fn>;
    writeToPending: ReturnType<typeof vi.fn>;
    broadcastStaging: ReturnType<typeof vi.fn>;
    linkTranscriptToExistingPrep: ReturnType<typeof vi.fn>;
    emitTranscriptSaved: ReturnType<typeof vi.fn>;
    deferTranscriptSaved: ReturnType<typeof vi.fn>;
    emitTranscriptDistributionReady: ReturnType<typeof vi.fn>;
  };
};

function createKernelHarness(options: HarnessOptions = {}): KernelHarness {
  const logger = createLoggerMock();
  const writes: Array<{ filePath: string; content: string }> = [];

  const resolvedTargetSpace = options.targetSpace === undefined
    ? DEFAULT_TARGET_SPACE
    : options.targetSpace;
  const determineTargetSpace = vi.fn(async () => resolvedTargetSpace);
  const findTranscriptByStableId = vi.fn(async () => null);
  const getUniqueFilePath = vi.fn(async (filePath: string) => filePath);
  const linkTranscriptToExistingPrep = vi.fn(async () => undefined);

  const helpers: SaveMeetingSourceLegacyHelpers = {
    determineTargetSpace,
    findTranscriptByStableId,
    formatTranscriptMarkdown,
    formatExternalTranscriptMarkdown,
    generateFilename,
    getUniqueFilePath,
    linkTranscriptToExistingPrep,
    ...options.helperOverrides,
  };

  const builtDeps = buildSaveMeetingSourceDeps(helpers, {
    logger: logger as unknown as SaveMeetingSourceDeps['logger'],
  });

  const mkdir = vi.fn(async () => undefined);
  const uniqueFilePath = vi.fn(async (filePath: string) => filePath);
  const writeFile = vi.fn(async (filePath: string, content: string) => {
    writes.push({ filePath, content });
  });
  const writeToPending = vi.fn(async (pendingOptions: PendingWriteOptions) => ({
    id: 'pending-1',
    destinationPath: pendingOptions.destinationPath,
  }));
  const broadcastStaging = vi.fn();
  const emitTranscriptSaved = vi.fn();
  const deferTranscriptSaved = vi.fn();
  const emitTranscriptDistributionReady = vi.fn();
  const linkToPrep = vi.fn(async () => undefined);

  const deps: SaveMeetingSourceDeps = {
    ...builtDeps,
    getCoreDirectory: vi.fn(() => (
      options.coreDirectory === undefined ? DEFAULT_CORE_DIR : options.coreDirectory
    )),
    getAuthInfo: vi.fn(() => options.authInfo ?? {
      userName: 'Test User',
      userEmail: 'test@example.com',
    }),
    enrichWithCalendar: async () => ({ matched: false }),
    evaluateGuard: async () => ({ decision: 'allow' }),
    mkdir,
    uniqueFilePath,
    writeFile,
    writeToPending,
    broadcastStaging,
    linkTranscriptToExistingPrep: linkToPrep,
    emitTranscriptSaved,
    deferTranscriptSaved,
    emitTranscriptDistributionReady,
    clock: () => FIXED_NOW,
    logger: logger as unknown as SaveMeetingSourceDeps['logger'],
    ...options.depOverrides,
  };

  return {
    deps,
    logger,
    writes,
    spies: {
      determineTargetSpace,
      findTranscriptByStableId,
      mkdir,
      uniqueFilePath,
      writeFile,
      writeToPending,
      broadcastStaging,
      linkTranscriptToExistingPrep: linkToPrep,
      emitTranscriptSaved,
      deferTranscriptSaved,
      emitTranscriptDistributionReady,
    },
  };
}

function getLastWrite(harness: KernelHarness): { filePath: string; content: string } {
  const write = harness.writes.at(-1);
  if (!write) {
    throw new Error('Expected at least one write');
  }
  return write;
}

function parseFrontmatter(markdown: string): Record<string, unknown> {
  return fm<Record<string, unknown>>(markdown).attributes;
}

function extractTitle(markdown: string): string {
  const match = markdown.match(/^#\s+(.+)$/m);
  if (!match) {
    throw new Error('Missing markdown title');
  }
  return match[1].trim();
}

function readCalendarEventId(frontmatter: Record<string, unknown>): string | undefined {
  const direct = frontmatter.calendar_event_id;
  if (typeof direct === 'string' && direct.length > 0) {
    return direct;
  }

  const legacy = frontmatter.calendar_id;
  if (typeof legacy === 'string' && legacy.length > 0) {
    return legacy;
  }

  return undefined;
}

function readMeetingUrl(frontmatter: Record<string, unknown>): string | undefined {
  const direct = frontmatter.meeting_url;
  if (typeof direct === 'string' && direct.length > 0) {
    return direct;
  }

  const legacy = frontmatter.conference_url;
  if (typeof legacy === 'string' && legacy.length > 0) {
    return legacy;
  }

  return undefined;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
  vi.spyOn(Date.prototype, 'toLocaleTimeString').mockReturnValue('10:00 AM');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('saveMeetingSource contracts (Stage 4)', () => {
  it('(a) Recall calendar match enriches title/frontmatter/event payload', async () => {
    const harness = createKernelHarness();
    harness.deps.enrichWithCalendar = createCalendarEnricher(
      [
        {
          calendarEventId: 'calendar-recall-1',
          calendarSource: 'google',
          title: 'Maria, 2026-05-12',
          meetingUrl: 'https://meet.google.com/maria-sync',
          startTime: '2026-05-19T10:01:00.000Z',
          endTime: '2026-05-19T11:00:00.000Z',
        },
      ],
      harness.deps.logger,
    );

    const result = await saveMeetingSource(
      makeRecallInput({ meetingUrl: 'https://meet.google.com/maria-sync' }),
      harness.deps,
    );

    expect(result.kind).toBe('saved');
    expect(result.kind === 'saved' && result.alreadyExists).toBe(false);

    const { content } = getLastWrite(harness);
    const frontmatter = parseFrontmatter(content);
    expect(extractTitle(content)).toBe('Maria, 2026-05-12');
    expect(readMeetingUrl(frontmatter)).toBe('https://meet.google.com/maria-sync');
    expect(readCalendarEventId(frontmatter)).toBe('calendar-recall-1');
    expect(harness.spies.emitTranscriptSaved).toHaveBeenCalledWith(
      expect.objectContaining({
        meetingUrl: 'https://meet.google.com/maria-sync',
        calendarEventId: 'calendar-recall-1',
      }),
    );
  });

  it('(b) Recall calendar miss uses fallback title and leaves payload calendarEventId undefined', async () => {
    const harness = createKernelHarness();
    const result = await saveMeetingSource(
      makeRecallInput({ meetingTitle: 'Recall Fallback Title' }),
      harness.deps,
    );

    expect(result.kind).toBe('saved');
    const { content } = getLastWrite(harness);
    expect(extractTitle(content)).toBe('Recall Fallback Title');
    expect(harness.spies.emitTranscriptSaved).toHaveBeenCalledWith(
      expect.objectContaining({
        calendarEventId: undefined,
      }),
    );
  });

  it('(c) External fireflies prioritizes URL match over time-window candidate', async () => {
    const harness = createKernelHarness();
    harness.deps.enrichWithCalendar = createCalendarEnricher(
      [
        {
          calendarEventId: 'calendar-url-wins',
          calendarSource: 'google',
          title: 'URL Priority Meeting',
          meetingUrl: 'https://zoom.us/j/111111111?pwd=abc',
          startTime: '2026-05-19T13:00:00.000Z',
          endTime: '2026-05-19T13:30:00.000Z',
        },
        {
          calendarEventId: 'calendar-time-window',
          calendarSource: 'google',
          title: 'Time Window Meeting',
          meetingUrl: 'https://zoom.us/j/222222222',
          startTime: '2026-05-19T10:01:00.000Z',
          endTime: '2026-05-19T10:30:00.000Z',
        },
      ],
      harness.deps.logger,
    );

    const result = await saveMeetingSource(
      makeExternalInput(
        'fireflies',
        { meetingUrl: 'https://zoom.us/j/111111111' },
        { meetingUrl: 'https://zoom.us/j/111111111', calendarEventId: 'upstream-cal-id' },
      ),
      harness.deps,
    );

    expect(result.kind).toBe('saved');
    const { content } = getLastWrite(harness);
    const frontmatter = parseFrontmatter(content);
    expect(readCalendarEventId(frontmatter)).toBe('calendar-url-wins');
    expect(harness.spies.emitTranscriptSaved).toHaveBeenCalledWith(
      expect.objectContaining({
        calendarEventId: 'calendar-url-wins',
        meetingUrl: 'https://zoom.us/j/111111111?pwd=abc',
      }),
    );
  });

  it('(d) External fathom with meetingUrl-only enriches via URL match', async () => {
    const harness = createKernelHarness();
    harness.deps.enrichWithCalendar = createCalendarEnricher(
      [
        {
          calendarEventId: 'calendar-fathom-1',
          calendarSource: 'google',
          title: 'Fathom URL Match',
          meetingUrl: 'https://zoom.us/j/333333333',
          startTime: '2026-05-19T10:00:30.000Z',
          endTime: '2026-05-19T10:30:00.000Z',
        },
      ],
      harness.deps.logger,
    );

    const result = await saveMeetingSource(
      makeExternalInput(
        'fathom',
        { meetingUrl: 'https://zoom.us/j/333333333' },
        { meetingUrl: 'https://zoom.us/j/333333333', calendarEventId: null },
      ),
      harness.deps,
    );

    expect(result.kind).toBe('saved');
    expect(harness.spies.emitTranscriptSaved).toHaveBeenCalledWith(
      expect.objectContaining({
        calendarEventId: 'calendar-fathom-1',
        meetingUrl: 'https://zoom.us/j/333333333',
      }),
    );
  });

  it('(e) Plaud calendar match uses calendar title and does not call fallbackTitleStrategy', async () => {
    const fallbackTitleStrategy = vi.fn(async () => 'Should not be used');
    const harness = createKernelHarness();
    harness.deps.enrichWithCalendar = createCalendarEnricher(
      [
        {
          calendarEventId: 'calendar-maria-1',
          calendarSource: 'google',
          title: 'Maria, 2026-05-12',
          meetingUrl: 'https://meet.google.com/maria-sync',
          startTime: '2026-05-12T10:00:00.000Z',
          endTime: '2026-05-12T11:00:00.000Z',
        },
      ],
      harness.deps.logger,
    );

    const result = await saveMeetingSource(
      makePlaudInput(fallbackTitleStrategy),
      harness.deps,
    );

    expect(result.kind).toBe('saved');
    expect(fallbackTitleStrategy).not.toHaveBeenCalled();

    const { content } = getLastWrite(harness);
    expect(extractTitle(content)).toBe('Maria, 2026-05-12');
    expect(harness.spies.emitTranscriptSaved).toHaveBeenCalledWith(
      expect.objectContaining({
        meetingUrl: 'https://meet.google.com/maria-sync',
        calendarEventId: 'calendar-maria-1',
      }),
    );
  });

  it('(f) Plaud calendar miss calls fallbackTitleStrategy once and honors returned title', async () => {
    const fallbackTitleStrategy = vi.fn(async () => 'Plaud Smart Title');
    const harness = createKernelHarness();

    const result = await saveMeetingSource(
      makePlaudInput(fallbackTitleStrategy),
      harness.deps,
    );

    expect(result.kind).toBe('saved');
    expect(fallbackTitleStrategy).toHaveBeenCalledTimes(1);
    const { content } = getLastWrite(harness);
    expect(extractTitle(content)).toBe('Plaud Smart Title');
  });

  it('(g1) Limitless happy path uses source-specific frontmatter and payload', async () => {
    const harness = createKernelHarness();
    const result = await saveMeetingSource(
      makeLimitlessInput(() => 'Limitless Happy Path Title'),
      harness.deps,
    );

    expect(result.kind).toBe('saved');
    const { content } = getLastWrite(harness);
    const frontmatter = parseFrontmatter(content);

    expect(frontmatter.source_system).toBe('limitless');
    expect(frontmatter.source_url).toBe('urn:limitless:recording:limitless-lifelog-1');
    expect(frontmatter.device).toBe('Limitless Pendant');
    expect(harness.spies.emitTranscriptSaved).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceSystem: 'limitless',
        sourceUid: 'limitless_limitless-lifelog-1',
      }),
    );
  });

  it('(g2) Desktop SDK happy path emits saved + distribution-ready in the same turn', async () => {
    const harness = createKernelHarness();
    const result = await saveMeetingSource(
      makeDesktopInput(() => 'Desktop SDK Happy Path'),
      harness.deps,
    );

    expect(result.kind).toBe('saved');
    expect(harness.spies.emitTranscriptSaved).toHaveBeenCalledTimes(1);
    expect(harness.spies.emitTranscriptDistributionReady).toHaveBeenCalledTimes(1);

    const savedOrder = harness.spies.emitTranscriptSaved.mock.invocationCallOrder[0];
    const distributionOrder = harness.spies.emitTranscriptDistributionReady.mock.invocationCallOrder[0];
    expect(savedOrder).toBeLessThan(distributionOrder);
  });

  it('(g3) Quick capture happy path uses source-specific frontmatter shape', async () => {
    const harness = createKernelHarness();
    const result = await saveMeetingSource(
      makeQuickCaptureInput(async () => 'Quick Capture Happy Title'),
      harness.deps,
    );

    expect(result.kind).toBe('saved');
    const { content } = getLastWrite(harness);
    const frontmatter = parseFrontmatter(content);
    expect(frontmatter.source_system).toBe('quick_capture');
    expect(frontmatter.source_url).toBe('urn:quick_capture:session:quick-session-1');
    expect(frontmatter.device).toBe('Built-in Microphone');
  });

  it('(g4) Recall live upgrade replay emits saved first, then one distribution-ready on upgrade, duplicate upgrade is idempotent', async () => {
    const harness = createKernelHarness();
    const liveInput = makeRecallInput({
      isLiveTranscriptInitial: true,
      transcriptQuality: 'captions',
    });

    const initialSave = await saveMeetingSource(liveInput, harness.deps);
    expect(initialSave.kind).toBe('saved');
    expect(harness.spies.emitTranscriptSaved).toHaveBeenCalledTimes(1);
    expect(harness.spies.emitTranscriptDistributionReady).not.toHaveBeenCalled();

    const savedFilePath = initialSave.kind === 'saved' ? initialSave.filePath : '';
    const initialContent = getLastWrite(harness).content;
    const fileContents = new Map<string, string>([[savedFilePath, initialContent]]);

    const upgradeLogger = createLoggerMock() as unknown as SaveMeetingSourceDeps['logger'];
    const readFile = vi.fn(async (filePath: string) => fileContents.get(filePath) ?? '');
    const writeFile = vi.fn(async (filePath: string, content: string) => {
      fileContents.set(filePath, content);
    });
    const emitTranscriptSaved = vi.fn();
    const emitTranscriptDistributionReady = vi.fn();

    const firstUpgrade = await upgradeAndEmit(
      {
        filePath: savedFilePath,
        newTranscript: '# upgraded transcript',
        newQuality: 'recallai_async',
        sourceUid: 'recall-bot-1',
        sourceSystem: 'recall',
        spacePath: 'Chief-of-Staff',
        meetingTitle: 'Recall Fallback Title',
      },
      {
        readFile,
        writeFile,
        emitTranscriptSaved,
        emitTranscriptDistributionReady,
        logger: upgradeLogger,
      },
    );

    expect(firstUpgrade.success).toBe(true);
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(emitTranscriptSaved).not.toHaveBeenCalled();
    expect(emitTranscriptDistributionReady).toHaveBeenCalledTimes(1);

    const duplicateUpgrade = await upgradeAndEmit(
      {
        filePath: savedFilePath,
        newTranscript: '# upgraded transcript',
        newQuality: 'recallai_async',
        sourceUid: 'recall-bot-1',
        sourceSystem: 'recall',
        spacePath: 'Chief-of-Staff',
        meetingTitle: 'Recall Fallback Title',
      },
      {
        readFile,
        writeFile,
        emitTranscriptSaved,
        emitTranscriptDistributionReady,
        logger: upgradeLogger,
      },
    );

    expect(duplicateUpgrade.success).toBe(true);
    expect(duplicateUpgrade.alreadyUpgraded).toBe(true);
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(emitTranscriptDistributionReady).toHaveBeenCalledTimes(1);
  });

  it('(h) pending_transcript_meta round-trips via parsePendingFile()', async () => {
    const writeToPending = vi.fn(async (options: PendingWriteOptions) => {
      return {
        id: 'pending-roundtrip-1',
        destinationPath: options.destinationPath,
      };
    });

    const harness = createKernelHarness({
      depOverrides: {
        evaluateGuard: async () => ({ decision: 'stage', summary: 'Needs review' }),
        writeToPending,
      },
    });
    harness.deps.enrichWithCalendar = async () => ({
      matched: true,
      meetingUrl: 'https://meet.google.com/meta-roundtrip',
      calendarEventId: 'calendar-meta-1',
      calendarSource: 'google',
      title: 'Pending Meta Meeting',
    });

    const result = await saveMeetingSource(makeRecallInput(), harness.deps);
    expect(result.kind).toBe('staged');
    const staged = writeToPending.mock.calls[0]?.[0] as PendingWriteOptions | undefined;
    if (!staged) {
      throw new Error('Expected pending write options for staged transcript');
    }
    const pendingMarkdown = serializePendingFile(
      {
        pending_destination: staged.destinationPath,
        staged_at: FIXED_NOW.toISOString(),
        session_id: staged.sessionId,
        summary: staged.summary,
        original_space: staged.spaceName,
        base_hash: 'new-file',
        pending_transcript_meta: staged.transcriptMeta,
        sharing: 'private',
      },
      staged.content,
    );

    const parsed = parsePendingFile(pendingMarkdown, '/tmp/pending-meta-roundtrip.pending.md');
    expect(parsed).not.toBeNull();
    expect(parsed?.frontmatter.pending_transcript_meta).toBe(staged.transcriptMeta);
    const parsedTranscriptMeta = JSON.parse(
      parsed?.frontmatter.pending_transcript_meta ?? '{}',
    );
    expect(parsedTranscriptMeta).toEqual({
      sourceSystem: 'recall',
      sourceUid: 'recall-bot-1',
      meetingTitle: 'Pending Meta Meeting',
      startTime: '2026-05-19T10:00:00.000Z',
      participants: ['Alice Example', 'Bob Example'],
      duration: 1800,
      meetingUrl: 'https://meet.google.com/meta-roundtrip',
      calendarEventId: 'calendar-meta-1',
      spacePath: 'Chief-of-Staff',
    });
  });

  it("(i) Dedup hit returns saved/alreadyExists and doesn't write", async () => {
    const existingFilePath = '/workspace/Chief-of-Staff/memory/sources/2026/05-May/19/existing.md';
    const harness = createKernelHarness({
      helperOverrides: {
        findTranscriptByStableId: vi.fn(async () => existingFilePath),
      },
    });

    const result = await saveMeetingSource(makeRecallInput(), harness.deps);
    expect(result.kind).toBe('saved');
    expect(result.kind === 'saved' && result.alreadyExists).toBe(true);
    if (result.kind === 'saved' && result.alreadyExists) {
      expect(result.existingFilePath).toBe(existingFilePath);
      expect(result.filePath).toBe(existingFilePath);
    }

    expect(harness.spies.writeFile).not.toHaveBeenCalled();
    expect(harness.spies.writeToPending).not.toHaveBeenCalled();
    expect(harness.spies.emitTranscriptSaved).toHaveBeenCalledWith(
      expect.objectContaining({
        alreadyExists: true,
        filePath: existingFilePath,
      }),
    );
  });

  describe('(j) failure modes', () => {
    it('returns no_workspace when getCoreDirectory() is null', async () => {
      const harness = createKernelHarness({ coreDirectory: null });
      const result = await saveMeetingSource(makeRecallInput(), harness.deps);

      expect(result).toEqual({ kind: 'failed', reason: 'no_workspace' });
      expect(harness.spies.writeFile).not.toHaveBeenCalled();
      expect(harness.spies.emitTranscriptSaved).not.toHaveBeenCalled();
      expect(harness.spies.emitTranscriptDistributionReady).not.toHaveBeenCalled();
    });

    it('returns no_target_space when resolveTargetSpace() returns null', async () => {
      const harness = createKernelHarness({ targetSpace: null });
      const result = await saveMeetingSource(makeRecallInput(), harness.deps);

      expect(result).toEqual({ kind: 'failed', reason: 'no_target_space' });
      expect(harness.spies.writeFile).not.toHaveBeenCalled();
      expect(harness.spies.emitTranscriptSaved).not.toHaveBeenCalled();
    });

    it('returns cos_unavailable when staged writeToPending returns null', async () => {
      const harness = createKernelHarness({
        depOverrides: {
          evaluateGuard: async () => ({ decision: 'stage', summary: 'Needs review' }),
          writeToPending: vi.fn(async () => null),
        },
      });

      const result = await saveMeetingSource(makeRecallInput(), harness.deps);
      expect(result).toEqual({ kind: 'failed', reason: 'cos_unavailable' });
      expect(harness.spies.writeFile).not.toHaveBeenCalled();
      expect(harness.spies.emitTranscriptSaved).not.toHaveBeenCalled();
      expect(harness.spies.emitTranscriptDistributionReady).not.toHaveBeenCalled();
    });

    it('returns guard_error when guard throws', async () => {
      const harness = createKernelHarness({
        depOverrides: {
          evaluateGuard: async () => {
            throw new Error('guard exploded');
          },
        },
      });

      const result = await saveMeetingSource(makeRecallInput(), harness.deps);
      expect(result.kind).toBe('failed');
      if (result.kind === 'failed') {
        expect(result.reason).toBe('guard_error');
      }
      expect(harness.spies.writeFile).not.toHaveBeenCalled();
      expect(harness.spies.emitTranscriptSaved).not.toHaveBeenCalled();
    });

    it('returns fs_error when fs write fails', async () => {
      const harness = createKernelHarness({
        depOverrides: {
          writeFile: vi.fn(async () => {
            throw new Error('disk full');
          }),
        },
      });

      const result = await saveMeetingSource(makeRecallInput(), harness.deps);
      expect(result.kind).toBe('failed');
      if (result.kind === 'failed') {
        expect(result.reason).toBe('fs_error');
      }
      expect(harness.spies.emitTranscriptSaved).not.toHaveBeenCalled();
      expect(harness.spies.emitTranscriptDistributionReady).not.toHaveBeenCalled();
    });

    it('returns dedup_lookup_error when dedup lookup returns { error }', async () => {
      const harness = createKernelHarness({
        depOverrides: {
          findTranscriptByStableId: vi.fn(async () => ({
            error: new Error('dedup lookup failed'),
          })),
        },
      });

      const result = await saveMeetingSource(makeRecallInput(), harness.deps);
      expect(result.kind).toBe('failed');
      if (result.kind === 'failed') {
        expect(result.reason).toBe('dedup_lookup_error');
      }
      expect(harness.spies.writeFile).not.toHaveBeenCalled();
      expect(harness.spies.emitTranscriptSaved).not.toHaveBeenCalled();
      expect(harness.spies.emitTranscriptDistributionReady).not.toHaveBeenCalled();
    });
  });

  describe('(k) fallbackTitleStrategy failure modes', () => {
    it('uses source default + logs when fallbackTitleStrategy throws (plaud)', async () => {
      const fallbackTitleStrategy = vi.fn(async () => {
        throw new Error('LLM title failure');
      });
      const harness = createKernelHarness();

      const result = await saveMeetingSource(
        makePlaudInput(fallbackTitleStrategy),
        harness.deps,
      );

      expect(result.kind).toBe('saved');
      expect(extractTitle(getLastWrite(harness).content)).toBe('Plaud Recording - 10:00 AM');
      const warningMessages = harness.logger.warn.mock.calls.map((call) => call[1]);
      expect(warningMessages).toContain('kernel_fallback_title_failed');
    });

    it('uses source default when fallbackTitleStrategy returns empty (quick_capture)', async () => {
      const harness = createKernelHarness();
      const result = await saveMeetingSource(
        makeQuickCaptureInput(async () => '   '),
        harness.deps,
      );

      expect(result.kind).toBe('saved');
      expect(extractTitle(getLastWrite(harness).content)).toBe('Recording at 10:00 AM');
      const warningMessages = harness.logger.warn.mock.calls.map((call) => call[1]);
      expect(warningMessages).toContain('kernel_fallback_title_empty');
    });

    it('truncates >100-char fallback title and logs truncation (quick_capture)', async () => {
      const longTitle = 'X'.repeat(140);
      const harness = createKernelHarness();
      const result = await saveMeetingSource(
        makeQuickCaptureInput(async () => longTitle),
        harness.deps,
      );

      expect(result.kind).toBe('saved');
      const title = extractTitle(getLastWrite(harness).content);
      expect(title.length).toBe(100);
      expect(title).toBe(longTitle.slice(0, 100));
      const warningMessages = harness.logger.warn.mock.calls.map((call) => call[1]);
      expect(warningMessages).toContain('kernel_fallback_title_truncated');
    });

    it('strips control chars and falls back to source default when empty after strip (plaud)', async () => {
      const harness = createKernelHarness();
      const result = await saveMeetingSource(
        makePlaudInput(async () => '\u0000\u0007'),
        harness.deps,
      );

      expect(result.kind).toBe('saved');
      expect(extractTitle(getLastWrite(harness).content)).toBe('Plaud Recording - 10:00 AM');
      const warningMessages = harness.logger.warn.mock.calls.map((call) => call[1]);
      expect(warningMessages).toContain('kernel_fallback_title_stripped');
      expect(warningMessages).toContain('kernel_fallback_title_empty');
    });

    it('strips Unicode format characters and falls back to source default when empty after strip (plaud)', async () => {
      const harness = createKernelHarness();
      const result = await saveMeetingSource(
        makePlaudInput(async () => '\u200B\u202E'),
        harness.deps,
      );

      expect(result.kind).toBe('saved');
      expect(extractTitle(getLastWrite(harness).content)).toBe('Plaud Recording - 10:00 AM');
      const warningMessages = harness.logger.warn.mock.calls.map((call) => call[1]);
      expect(warningMessages).toContain('kernel_fallback_title_stripped');
      expect(warningMessages).toContain('kernel_fallback_title_empty');
    });

    it('strips newline/carriage-return/tab from fallback title to keep heading single-line (plaud)', async () => {
      const harness = createKernelHarness();
      const result = await saveMeetingSource(
        makePlaudInput(async () => 'Safe title\n## Sneaky Heading\r\tTabbed'),
        harness.deps,
      );

      expect(result.kind).toBe('saved');
      const written = getLastWrite(harness).content;
      expect(written).not.toContain('\n## Sneaky Heading');
      expect(extractTitle(written)).toBe('Safe title## Sneaky HeadingTabbed');
      const warningMessages = harness.logger.warn.mock.calls.map((call) => call[1]);
      expect(warningMessages).toContain('kernel_fallback_title_stripped');
    });
  });

  it('(m) source_url frontmatter maps to per-source URNs', async () => {
    const scenarios: Array<{
      name: string;
      input: MeetingSourceInput;
      expectedSourceUrl: string;
    }> = [
      {
        name: 'recall',
        input: makeRecallInput({ botId: 'recall-source-url' }),
        expectedSourceUrl: 'urn:recall:bot:recall-source-url',
      },
      {
        name: 'fireflies',
        input: makeExternalInput('fireflies', { externalId: 'fireflies-source-url' }),
        expectedSourceUrl: 'urn:fireflies:transcript:fireflies-source-url',
      },
      {
        name: 'fathom',
        input: makeExternalInput('fathom', { externalId: 'fathom-source-url' }),
        expectedSourceUrl: 'urn:fathom:transcript:fathom-source-url',
      },
      {
        name: 'plaud',
        input: makePlaudInput(async () => 'Plaud Title', { fileId: 'plaud-source-url' }),
        expectedSourceUrl: 'urn:plaud:recording:plaud-source-url',
      },
      {
        name: 'limitless',
        input: makeLimitlessInput(() => 'Limitless Title', { lifelogId: 'limitless-source-url' }),
        expectedSourceUrl: 'urn:limitless:recording:limitless-source-url',
      },
      {
        name: 'desktop_sdk',
        input: makeDesktopInput(() => 'Desktop Title', { sessionId: 'desktop-source-url' }),
        expectedSourceUrl: 'urn:desktop_sdk:session:desktop-source-url',
      },
      {
        name: 'quick_capture',
        input: makeQuickCaptureInput(async () => 'Quick Title', { sessionId: 'quick-source-url' }),
        expectedSourceUrl: 'urn:quick_capture:session:quick-source-url',
      },
    ];

    for (const scenario of scenarios) {
      const harness = createKernelHarness();
      const result = await saveMeetingSource(scenario.input, harness.deps);
      expect(result.kind, `${scenario.name} should save`).toBe('saved');

      const frontmatter = parseFrontmatter(getLastWrite(harness).content);
      expect(frontmatter.source_url, scenario.name).toBe(scenario.expectedSourceUrl);
    }
  });

  it("(n) staged-for-review returns staged result and calls defer + broadcast after writeToPending", async () => {
    const writeToPending = vi.fn(async (options: PendingWriteOptions) => ({
      id: 'pending-stage-1',
      destinationPath: `${options.destinationPath}.pending`,
    }));
    const broadcastStaging = vi.fn();
    const deferTranscriptSaved = vi.fn();

    const harness = createKernelHarness({
      depOverrides: {
        evaluateGuard: async () => ({ decision: 'stage', summary: 'Needs human review' }),
        writeToPending,
        broadcastStaging,
        deferTranscriptSaved,
      },
    });

    const result = await saveMeetingSource(makeRecallInput(), harness.deps);
    expect(result).toEqual(
      expect.objectContaining({
        kind: 'staged',
        pendingFileId: 'pending-stage-1',
      }),
    );

    expect(writeToPending).toHaveBeenCalledTimes(1);
    expect(broadcastStaging).toHaveBeenCalledTimes(1);
    expect(deferTranscriptSaved).toHaveBeenCalledTimes(1);

    const writeOrder = writeToPending.mock.invocationCallOrder[0];
    const broadcastOrder = broadcastStaging.mock.invocationCallOrder[0];
    expect(writeOrder).toBeLessThan(broadcastOrder);
  });

  it('(o) broadcastStaging happens in same turn immediately after writeToPending resolution', async () => {
    let writeResolvedAt = 0;
    let broadcastAt = 0;
    const writeToPending = vi.fn(async (options: PendingWriteOptions) => {
      writeResolvedAt = performance.now();
      return {
        id: 'pending-stage-2',
        destinationPath: options.destinationPath,
      };
    });

    const broadcastStaging = vi.fn(() => {
      broadcastAt = performance.now();
    });
    const deferTranscriptSaved = vi.fn();

    const harness = createKernelHarness({
      depOverrides: {
        evaluateGuard: async () => ({ decision: 'stage', summary: 'Needs review' }),
        writeToPending,
        broadcastStaging,
        deferTranscriptSaved,
      },
    });

    const result = await saveMeetingSource(makeRecallInput(), harness.deps);
    expect(result.kind).toBe('staged');
    const writeOrder = writeToPending.mock.invocationCallOrder[0];
    const broadcastOrder = broadcastStaging.mock.invocationCallOrder[0];
    const deferOrder = deferTranscriptSaved.mock.invocationCallOrder[0];
    expect(writeOrder).toBeLessThan(broadcastOrder);
    expect(broadcastOrder).toBeLessThan(deferOrder);
    expect(broadcastAt).toBeGreaterThanOrEqual(writeResolvedAt);
    expect(broadcastAt - writeResolvedAt).toBeLessThan(1);
  });

  it('(p) calendar ambiguity tiebreaker is deterministic and logs both candidate ids', async () => {
    const harness = createKernelHarness();
    harness.deps.enrichWithCalendar = createCalendarEnricher(
      [
        {
          calendarEventId: 'z-event',
          calendarSource: 'google',
          title: 'Ambiguous Candidate Z',
          meetingUrl: 'https://zoom.us/j/555555555',
          startTime: '2026-05-19T09:58:00.000Z',
          endTime: '2026-05-19T10:30:00.000Z',
        },
        {
          calendarEventId: 'a-event',
          calendarSource: 'google',
          title: 'Ambiguous Candidate A',
          meetingUrl: 'https://zoom.us/j/555555555',
          startTime: '2026-05-19T10:02:00.000Z',
          endTime: '2026-05-19T10:30:00.000Z',
        },
      ],
      harness.deps.logger,
    );

    const result = await saveMeetingSource(
      makeRecallInput({ meetingUrl: undefined }),
      harness.deps,
    );

    expect(result.kind).toBe('saved');
    expect(harness.spies.emitTranscriptSaved).toHaveBeenCalledWith(
      expect.objectContaining({
        calendarEventId: 'a-event',
      }),
    );

    const ambiguousLog = harness.logger.warn.mock.calls.find(
      (call) => call[1] === 'calendar_matcher_ambiguous',
    );
    expect(ambiguousLog).toBeDefined();
    const payload = ambiguousLog?.[0] as {
      chosenCalendarEventId?: string;
      candidates?: Array<{ calendarEventId: string }>;
    };
    expect(payload.chosenCalendarEventId).toBe('a-event');
    expect((payload.candidates ?? []).map((candidate) => candidate.calendarEventId).sort()).toEqual([
      'a-event',
      'z-event',
    ]);
  });

  it("(q) desktop_sdk dedup finds legacy source_system 'local' transcripts", async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'save-meeting-source-contract-q-'));
    const transcriptDir = path.join(tmpRoot, 'memory', 'sources', '2026', '05-May', '19');
    const existingPath = path.join(
      transcriptDir,
      '260519_1000_meeting_desktop_sdk_existing.md',
    );

    await fs.mkdir(transcriptDir, { recursive: true });
    await fs.writeFile(
      existingPath,
      [
        '---',
        'source_type: meeting',
        'source_system: local',
        'source_uid: desktop-legacy-session',
        '---',
        '',
        '# Existing Desktop Transcript',
      ].join('\n'),
      'utf-8',
    );

    try {
      const harness = createKernelHarness({
        targetSpace: {
          spacePath: 'Chief-of-Staff',
          absolutePath: tmpRoot,
          spaceName: 'Chief of Staff',
          sharing: 'private',
        },
        helperOverrides: {
          findTranscriptByStableId: findTranscriptByStableIdFs,
        },
      });

      const result = await saveMeetingSource(
        makeDesktopInput(
          () => 'Desktop Legacy Dedup',
          {
            sessionId: 'desktop-legacy-session',
            startTime: '2026-05-19T10:00:00.000Z',
          },
        ),
        harness.deps,
      );

      expect(result.kind).toBe('saved');
      expect(result.kind === 'saved' && result.alreadyExists).toBe(true);
      if (result.kind === 'saved' && result.alreadyExists) {
        expect(result.filePath).toBe(existingPath);
        expect(result.existingFilePath).toBe(existingPath);
      }
      expect(harness.spies.emitTranscriptSaved).toHaveBeenCalledWith(
        expect.objectContaining({
          alreadyExists: true,
          filePath: existingPath,
        }),
      );
      expect(harness.spies.writeFile).not.toHaveBeenCalled();
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });
});
