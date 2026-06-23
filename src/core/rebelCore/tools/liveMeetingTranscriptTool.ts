import type { ToolDefinition } from '../modelTypes';
import type { BuiltinToolContext, ToolExecutionResult } from '../types';

const MAX_TRANSCRIPT_CHARS = 50_000;
const ACTIVE_TRANSCRIPT_STALENESS_MS = 60 * 1000;

type LiveTranscriptStatus =
  | 'ingest_unavailable'
  | 'no_active_meeting'
  | 'no_segments_yet'
  | 'active'
  | 'stale'
  | 'auth_error';

export interface LiveMeetingTranscriptSegment {
  segmentId: string;
  text: string;
  speaker: string | null;
  timestamp: number;
  isFinal: boolean;
  source: 'recall-bot';
}

export interface LiveMeetingTranscriptRecord {
  recallBotId: string;
  meetingTitle: string | null;
  recordingStartedAt: number;
  lastSegmentAt: number;
  segments: LiveMeetingTranscriptSegment[];
}

export interface LiveMeetingTranscriptProvider {
  getActiveMeetings: () => LiveMeetingTranscriptRecord[];
  hasStickyAuthError: () => boolean;
}

let liveMeetingTranscriptProvider: LiveMeetingTranscriptProvider | null = null;

export const setLiveMeetingTranscriptProvider = (provider: LiveMeetingTranscriptProvider | null): void => {
  liveMeetingTranscriptProvider = provider;
};

export const REBEL_MEETINGS_LIVE_TRANSCRIPT_TOOL_DEFINITION: ToolDefinition = {
  name: 'rebel_meetings_live_transcript',
  description: 'Returns active Recall meeting transcript context currently buffered on cloud.',
  input_schema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
};

function getMetadataStatus(args: {
  hasStickyAuthError: boolean;
  ingestEnabled: boolean;
  meetings: Array<{ lastSegmentAt: number; segments: unknown[] }>;
}): LiveTranscriptStatus {
  if (args.hasStickyAuthError) return 'auth_error';
  if (args.meetings.length === 0) {
    return args.ingestEnabled ? 'no_active_meeting' : 'ingest_unavailable';
  }
  const latestMeeting = args.meetings[0];
  if (latestMeeting.segments.length === 0) {
    return 'no_segments_yet';
  }
  return Date.now() - latestMeeting.lastSegmentAt < ACTIVE_TRANSCRIPT_STALENESS_MS
    ? 'active'
    : 'stale';
}

function countWords(input: string): number {
  if (!input.trim()) return 0;
  return input.trim().split(/\s+/).length;
}

function formatNoMeetingMessage(status: LiveTranscriptStatus): string {
  if (status === 'ingest_unavailable') {
    return 'Live transcript ingest is currently disabled on this cloud deployment.';
  }
  if (status === 'auth_error') {
    return 'Live transcript ingest is currently degraded due to authentication failures.';
  }
  return 'No active meeting transcript is available yet.';
}

export async function executeLiveMeetingTranscriptTool(
  _input: unknown,
  context: BuiltinToolContext,
): Promise<ToolExecutionResult> {
  if (context.surfaceCapability === 'desktop') {
    return {
      isError: true,
      output: 'Live meeting transcript access is only available in cloud sessions.',
    };
  }

  const ingestEnabled = process.env.CLOUD_TRANSCRIPT_RECEIVE_ENABLED === 'true';
  if (!liveMeetingTranscriptProvider) {
    return {
      isError: false,
      output: JSON.stringify({
        success: true,
        hasActiveMeeting: false,
        message: 'Live transcript provider is unavailable on this cloud deployment.',
        metadata: {
          source: 'recall',
          status: 'ingest_unavailable',
        },
      }),
    };
  }

  try {
    const activeMeetings = liveMeetingTranscriptProvider.getActiveMeetings()
      .sort((left, right) => right.lastSegmentAt - left.lastSegmentAt);
    const metadataStatus = getMetadataStatus({
      hasStickyAuthError: liveMeetingTranscriptProvider.hasStickyAuthError(),
      ingestEnabled,
      meetings: activeMeetings,
    });

    if (activeMeetings.length === 0) {
      return {
        isError: false,
        output: JSON.stringify({
          success: true,
          hasActiveMeeting: false,
          message: formatNoMeetingMessage(metadataStatus),
          metadata: {
            source: 'recall',
            status: metadataStatus,
          },
        }),
      };
    }

    const nowMs = Date.now();
    const meetings = activeMeetings.map((meeting) => {
      const sortedSegments = [...meeting.segments].sort((left, right) => left.timestamp - right.timestamp);
      const participants = Array.from(new Set(
        sortedSegments
          .map((segment) => segment.speaker?.trim())
          .filter((speaker): speaker is string => Boolean(speaker)),
      ));
      const transcriptLines = sortedSegments
        .map((segment) => {
          const text = segment.text.trim();
          if (!text) return null;
          const speaker = segment.speaker?.trim();
          return speaker ? `${speaker}: ${text}` : text;
        })
        .filter((line): line is string => Boolean(line));
      const fullTranscript = transcriptLines.join('\n');
      const transcriptTruncated = fullTranscript.length > MAX_TRANSCRIPT_CHARS;
      const transcript = transcriptTruncated
        ? `${fullTranscript.slice(-MAX_TRANSCRIPT_CHARS).trimEnd()}`
        : fullTranscript;

      return {
        botId: meeting.recallBotId,
        meetingTitle: meeting.meetingTitle ?? 'Meeting in progress',
        recordingStartedAt: new Date(meeting.recordingStartedAt).toISOString(),
        elapsedMinutes: Math.max(0, Math.round((nowMs - meeting.recordingStartedAt) / 60_000)),
        hasTranscript: fullTranscript.trim().length > 0,
        participants,
        participantCount: participants.length,
        wordCount: countWords(fullTranscript),
        transcript,
        transcriptTruncated,
      };
    });

    return {
      isError: false,
      output: JSON.stringify({
        success: true,
        hasActiveMeeting: true,
        activeMeetingCount: meetings.length,
        meetings,
        metadata: {
          source: 'recall',
          status: metadataStatus,
        },
      }),
    };
  } catch (error) {
    return {
      isError: true,
      output: error instanceof Error
        ? `Failed to load live meeting transcript: ${error.message}`
        : 'Failed to load live meeting transcript.',
    };
  }
}
