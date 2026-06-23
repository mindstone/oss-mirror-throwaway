import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  executeBuiltinTool,
  getBuiltinToolDefinitions,
  isBuiltinToolName,
  registerCloudOnlyBuiltins,
  resetCloudOnlyBuiltinsForTesting,
} from '../builtinTools';
import {
  executeLiveMeetingTranscriptTool,
  setLiveMeetingTranscriptProvider,
  type LiveMeetingTranscriptRecord,
} from '../tools/liveMeetingTranscriptTool';

const parseToolOutput = (output: string): Record<string, unknown> => JSON.parse(output) as Record<string, unknown>;

describe('live meeting transcript tool', () => {
  const originalIngestFlag = process.env.CLOUD_TRANSCRIPT_RECEIVE_ENABLED;
  let meetings: LiveMeetingTranscriptRecord[] = [];
  let stickyAuthError = false;

  beforeEach(() => {
    resetCloudOnlyBuiltinsForTesting();
    delete process.env.CLOUD_TRANSCRIPT_RECEIVE_ENABLED;
    meetings = [];
    stickyAuthError = false;
    setLiveMeetingTranscriptProvider({
      getActiveMeetings: () => [...meetings],
      hasStickyAuthError: () => stickyAuthError,
    });
  });

  afterEach(() => {
    setLiveMeetingTranscriptProvider(null);
    resetCloudOnlyBuiltinsForTesting();
    if (originalIngestFlag == null) {
      delete process.env.CLOUD_TRANSCRIPT_RECEIVE_ENABLED;
    } else {
      process.env.CLOUD_TRANSCRIPT_RECEIVE_ENABLED = originalIngestFlag;
    }
  });

  it('registerCloudOnlyBuiltins is idempotent and only registers one tool definition/executor pair', async () => {
    const beforeNames = getBuiltinToolDefinitions().map((tool) => tool.name);
    expect(beforeNames).not.toContain('rebel_meetings_live_transcript');
    expect(isBuiltinToolName('rebel_meetings_live_transcript')).toBe(false);

    registerCloudOnlyBuiltins();
    registerCloudOnlyBuiltins();

    const afterNames = getBuiltinToolDefinitions().map((tool) => tool.name);
    expect(afterNames.filter((name) => name === 'rebel_meetings_live_transcript')).toHaveLength(1);
    expect(isBuiltinToolName('rebel_meetings_live_transcript')).toBe(true);

    process.env.CLOUD_TRANSCRIPT_RECEIVE_ENABLED = 'true';
    const result = await executeBuiltinTool('rebel_meetings_live_transcript', {}, { surfaceCapability: 'cloud' });
    expect(result.isError).toBe(false);
  });

  it('fail-closes on desktop surface', async () => {
    const result = await executeLiveMeetingTranscriptTool({}, { surfaceCapability: 'desktop' });
    expect(result.isError).toBe(true);
    expect(result.output).toContain('only available in cloud');
  });

  it('returns ingest_unavailable when ingest is disabled and no meetings are active', async () => {
    process.env.CLOUD_TRANSCRIPT_RECEIVE_ENABLED = 'false';
    const result = await executeLiveMeetingTranscriptTool({}, { surfaceCapability: 'cloud' });
    expect(result.isError).toBe(false);
    expect(parseToolOutput(result.output)).toMatchObject({
      success: true,
      hasActiveMeeting: false,
      metadata: {
        source: 'recall',
        status: 'ingest_unavailable',
      },
    });
  });

  it('returns no_active_meeting when ingest is enabled and the store is empty', async () => {
    process.env.CLOUD_TRANSCRIPT_RECEIVE_ENABLED = 'true';
    const result = await executeLiveMeetingTranscriptTool({}, { surfaceCapability: 'cloud' });
    expect(result.isError).toBe(false);
    expect(parseToolOutput(result.output)).toMatchObject({
      success: true,
      hasActiveMeeting: false,
      metadata: {
        source: 'recall',
        status: 'no_active_meeting',
      },
    });
  });

  it('reports no_segments_yet for active meetings that have no transcript segments', async () => {
    process.env.CLOUD_TRANSCRIPT_RECEIVE_ENABLED = 'true';
    const now = Date.now();
    meetings = [{
      recallBotId: 'bot-empty',
      meetingTitle: 'Quarterly planning',
      recordingStartedAt: now,
      lastSegmentAt: now,
      segments: [],
    }];

    const result = await executeLiveMeetingTranscriptTool({}, { surfaceCapability: 'cloud' });
    expect(result.isError).toBe(false);
    expect(parseToolOutput(result.output)).toMatchObject({
      success: true,
      hasActiveMeeting: true,
      activeMeetingCount: 1,
      metadata: {
        source: 'recall',
        status: 'no_segments_yet',
      },
    });
  });

  it('returns active meeting summaries with transcript/participant metadata', async () => {
    process.env.CLOUD_TRANSCRIPT_RECEIVE_ENABLED = 'true';
    const now = Date.now();
    meetings = [{
      recallBotId: 'bot-active',
      meetingTitle: 'Weekly sync',
      recordingStartedAt: now - 30_000,
      lastSegmentAt: now - 10_000,
      segments: [
        {
          segmentId: 'seg-1',
          text: 'Hello everyone',
          speaker: 'Alex',
          timestamp: now - 20_000,
          isFinal: true,
          source: 'recall-bot',
        },
        {
          segmentId: 'seg-2',
          text: 'Thanks for joining',
          speaker: 'Jordan',
          timestamp: now - 10_000,
          isFinal: true,
          source: 'recall-bot',
        },
      ],
    }];

    const result = await executeLiveMeetingTranscriptTool({}, { surfaceCapability: 'cloud' });
    expect(result.isError).toBe(false);
    const parsed = parseToolOutput(result.output);
    expect(parsed).toMatchObject({
      success: true,
      hasActiveMeeting: true,
      activeMeetingCount: 1,
      metadata: {
        source: 'recall',
        status: 'active',
      },
    });

    const parsedMeetings = parsed.meetings as Array<Record<string, unknown>>;
    expect(parsedMeetings[0]).toMatchObject({
      botId: 'bot-active',
      meetingTitle: 'Weekly sync',
      hasTranscript: true,
      participantCount: 2,
      transcriptTruncated: false,
    });
    expect(parsedMeetings[0].participants).toEqual(['Alex', 'Jordan']);
    expect(typeof parsedMeetings[0].wordCount).toBe('number');
    expect((parsedMeetings[0].transcript as string).length).toBeGreaterThan(0);
  });

  it('truncates transcript to keep the most recent 50000 characters (catches slice-direction regression)', async () => {
    process.env.CLOUD_TRANSCRIPT_RECEIVE_ENABLED = 'true';
    const now = Date.now();
    const OLD_PREFIX_MARKER = 'OLD_PREFIX_MARKER_DISCARD_ME_';
    const NEW_SUFFIX_MARKER = '_NEW_SUFFIX_MARKER_KEEP_ME';
    const filler = 'X'.repeat(60_000);
    const text = `${OLD_PREFIX_MARKER}${filler}${NEW_SUFFIX_MARKER}`;
    meetings = [{
      recallBotId: 'bot-truncate',
      meetingTitle: 'Long transcript',
      recordingStartedAt: now - 30_000,
      lastSegmentAt: now - 1_000,
      segments: [
        {
          segmentId: 'seg-long',
          text,
          speaker: null,
          timestamp: now - 1_000,
          isFinal: true,
          source: 'recall-bot',
        },
      ],
    }];

    const result = await executeLiveMeetingTranscriptTool({}, { surfaceCapability: 'cloud' });
    expect(result.isError).toBe(false);
    const parsed = parseToolOutput(result.output);
    const parsedMeetings = parsed.meetings as Array<Record<string, unknown>>;
    const transcript = parsedMeetings[0].transcript as string;

    expect(transcript).toHaveLength(50_000);
    expect(transcript.endsWith(NEW_SUFFIX_MARKER)).toBe(true);
    expect(transcript.startsWith(OLD_PREFIX_MARKER)).toBe(false);
    expect(transcript.includes(OLD_PREFIX_MARKER)).toBe(false);
    expect(parsedMeetings[0].transcriptTruncated).toBe(true);
  });

  it('reports stale when the latest transcript segment is older than one minute', async () => {
    process.env.CLOUD_TRANSCRIPT_RECEIVE_ENABLED = 'true';
    meetings = [{
      recallBotId: 'bot-stale',
      meetingTitle: 'Stale meeting',
      recordingStartedAt: Date.now() - 180_000,
      lastSegmentAt: Date.now() - 120_000,
      segments: [{
        segmentId: 'seg-old',
        text: 'Earlier update',
        speaker: 'Morgan',
        timestamp: Date.now() - 120_000,
        isFinal: true,
        source: 'recall-bot',
      }],
    }];

    const result = await executeLiveMeetingTranscriptTool({}, { surfaceCapability: 'cloud' });
    expect(result.isError).toBe(false);
    expect(parseToolOutput(result.output)).toMatchObject({
      metadata: {
        status: 'stale',
      },
    });
  });

  it('surfaces auth_error once HMAC verification failures become sticky', async () => {
    process.env.CLOUD_TRANSCRIPT_RECEIVE_ENABLED = 'true';
    stickyAuthError = true;

    const result = await executeLiveMeetingTranscriptTool({}, { surfaceCapability: 'cloud' });
    expect(result.isError).toBe(false);
    expect(parseToolOutput(result.output)).toMatchObject({
      hasActiveMeeting: false,
      metadata: {
        status: 'auth_error',
      },
    });
  });
});
