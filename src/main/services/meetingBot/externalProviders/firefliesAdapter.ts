/**
 * Fireflies Adapter
 *
 * Imports meeting transcripts from Fireflies' GraphQL API.
 * Uses a two-phase fetch to avoid large payloads:
 * 1. List transcripts (metadata only)
 * 2. Fetch full transcript per ID
 *
 * API Docs: https://docs.fireflies.ai/
 */

import { createScopedLogger } from '@core/logger';
import type {
  ProviderAdapter,
  ConnectionTestResult,
  FetchTranscriptsResult,
  ExternalTranscript,
} from './types';
import { classifyError, formatTimestamp } from './types';

const log = createScopedLogger({ service: 'fireflies-adapter' });

const GRAPHQL_ENDPOINT = 'https://api.fireflies.ai/graphql';

/** Fireflies API response types */
interface FirefliesSentence {
  index: number;
  speaker_name: string;
  text: string;
  start_time: number; // seconds
}

interface FirefliesSummary {
  action_items?: string[];
  overview?: string;
  short_summary?: string;
}

interface FirefliesTranscriptSummary {
  id: string;
  title: string;
  date: number; // timestamp in ms
  meeting_link?: string;
  calendar_id?: string;
  participants?: string[];
}

interface FirefliesTranscriptDetail {
  id: string;
  title: string;
  date: number;
  meeting_link?: string;
  calendar_id?: string;
  participants?: string[];
  sentences?: FirefliesSentence[];
  summary?: FirefliesSummary;
  duration?: number;
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{
    message: string;
    code?: string;
    extensions?: {
      code?: string;
      status?: number;
      metadata?: {
        retryAfter?: number;
      };
    };
  }>;
}

/** GraphQL queries */
const LIST_TRANSCRIPTS_QUERY = `
  query ListTranscripts($fromDate: DateTime, $limit: Int, $skip: Int) {
    transcripts(fromDate: $fromDate, limit: $limit, skip: $skip) {
      id
      title
      date
      meeting_link
      calendar_id
      participants
    }
  }
`;

const GET_TRANSCRIPT_QUERY = `
  query GetTranscript($id: String!) {
    transcript(id: $id) {
      id
      title
      date
      meeting_link
      calendar_id
      participants
      duration
      sentences {
        index
        speaker_name
        text
        start_time
      }
      summary {
        action_items
        overview
        short_summary
      }
    }
  }
`;

const USER_QUERY = `
  query User {
    user {
      user_id
      email
      name
    }
  }
`;

/**
 * Create a Fireflies adapter instance.
 */
export function createFirefliesAdapter(apiKey: string): ProviderAdapter {
  /**
   * Execute a GraphQL query against Fireflies API.
   */
  async function graphqlFetch<T>(
    query: string,
    variables: Record<string, unknown> = {}
  ): Promise<{
    data: T | null;
    status: number;
    error?: string;
    errorCode?: string;
    retryAfter?: number;
  }> {
    try {
      const response = await fetch(GRAPHQL_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ query, variables }),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        return {
          data: null,
          status: response.status,
          error: errorText,
        };
      }

      const result = (await response.json()) as GraphQLResponse<T>;

      // Check for GraphQL errors
      if (result.errors && result.errors.length > 0) {
        const firstError = result.errors[0];
        const errorCode = firstError.extensions?.code || firstError.code;
        const retryAfter = firstError.extensions?.metadata?.retryAfter;

        return {
          data: null,
          status: firstError.extensions?.status || 400,
          error: firstError.message,
          errorCode,
          retryAfter,
        };
      }

      return {
        data: result.data ?? null,
        status: 200,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Network error';
      log.error({ error }, 'Fireflies GraphQL request failed');
      return { data: null, status: 0, error: message };
    }
  }

  /**
   * Format Fireflies sentences to standard transcript format.
   */
  function formatTranscript(sentences: FirefliesSentence[]): string {
    return sentences
      .filter((s) => s.text?.trim())
      .sort((a, b) => a.index - b.index)
      .map((sentence) => {
        const timestamp = formatTimestamp(sentence.start_time);
        const speaker = sentence.speaker_name?.trim() || 'Speaker';
        const text = sentence.text.trim();
        return `[${timestamp}] ${speaker}: ${text}`;
      })
      .join('\n');
  }

  /**
   * Calculate duration from sentences if not provided.
   */
  function calculateDuration(detail: FirefliesTranscriptDetail): number {
    if (detail.duration && detail.duration > 0) {
      return detail.duration;
    }
    if (detail.sentences && detail.sentences.length > 0) {
      const sorted = [...detail.sentences].sort((a, b) => b.start_time - a.start_time);
      return Math.ceil(sorted[0].start_time);
    }
    return 0;
  }

  /**
   * Convert Fireflies transcript to normalized ExternalTranscript.
   */
  function normalizeTranscript(detail: FirefliesTranscriptDetail): ExternalTranscript {
    return {
      externalId: detail.id,
      provider: 'fireflies',
      title: detail.title || 'Meeting',
      participants: detail.participants || [],
      startTime: new Date(detail.date).toISOString(),
      duration: calculateDuration(detail),
      transcript: detail.sentences ? formatTranscript(detail.sentences) : '',
      summary: detail.summary?.overview || detail.summary?.short_summary,
      actionItems: detail.summary?.action_items,
      meetingUrl: detail.meeting_link,
      calendarId: detail.calendar_id,
    };
  }

  return {
    name: 'fireflies',

    async testConnection(): Promise<ConnectionTestResult> {
      log.info('Testing Fireflies connection');

      const result = await graphqlFetch<{ user: { email: string; name: string } }>(USER_QUERY);

      if (result.errorCode === 'forbidden' || result.status === 401 || result.status === 403) {
        return {
          success: false,
          error: 'Invalid API key',
          message: 'Your Fireflies API key is invalid. Please check and try again.',
        };
      }

      if (!result.data?.user) {
        const classification = classifyError(result.status, result.errorCode);
        return {
          success: false,
          error: result.error || 'Connection failed',
          message:
            classification === 'rate_limited'
              ? 'Rate limited. Please try again in a moment.'
              : 'Could not connect to Fireflies. Please check your internet connection.',
        };
      }

      log.info({ email: result.data.user.email }, 'Fireflies connection successful');
      return {
        success: true,
        message: `Connected as ${result.data.user.name || result.data.user.email}.`,
      };
    },

    async fetchTranscripts(since: Date, cursor?: string): Promise<FetchTranscriptsResult> {
      // Add 1 hour overlap to catch late-arriving transcripts
      const fromDate = new Date(since.getTime() - 60 * 60 * 1000);
      const skip = cursor ? parseInt(cursor, 10) : 0;

      log.info({ fromDate: fromDate.toISOString(), skip }, 'Fetching Fireflies transcripts (phase 1: list)');

      // Phase 1: List transcripts (metadata only)
      const listResult = await graphqlFetch<{ transcripts: FirefliesTranscriptSummary[] }>(
        LIST_TRANSCRIPTS_QUERY,
        {
          fromDate: fromDate.toISOString(),
          limit: 50,
          skip,
        }
      );

      if (!listResult.data) {
        const classification = classifyError(listResult.status, listResult.errorCode);
        log.warn({ status: listResult.status, error: listResult.error }, 'Failed to list Fireflies transcripts');

        return {
          success: false,
          transcripts: [],
          error:
            classification === 'auth_invalid'
              ? 'Fireflies API key is invalid'
              : classification === 'rate_limited'
                ? 'Rate limited by Fireflies'
                : listResult.error || 'Failed to fetch transcripts',
        };
      }

      const summaries = listResult.data.transcripts || [];
      log.info({ count: summaries.length }, 'Listed Fireflies transcripts');

      if (summaries.length === 0) {
        return {
          success: true,
          transcripts: [],
        };
      }

      // Phase 2: Fetch full details for each transcript
      const transcripts: ExternalTranscript[] = [];

      for (const summary of summaries) {
        log.debug({ id: summary.id, title: summary.title }, 'Fetching Fireflies transcript details');

        const detailResult = await graphqlFetch<{ transcript: FirefliesTranscriptDetail }>(
          GET_TRANSCRIPT_QUERY,
          { id: summary.id }
        );

        if (!detailResult.data?.transcript) {
          log.warn({ id: summary.id, error: detailResult.error }, 'Failed to fetch transcript details');
          continue;
        }

        const detail = detailResult.data.transcript;

        // Skip if no sentences (empty transcript)
        if (!detail.sentences || detail.sentences.length === 0) {
          log.debug({ id: summary.id }, 'Skipping transcript with no sentences');
          continue;
        }

        transcripts.push(normalizeTranscript(detail));
      }

      // Calculate next cursor for pagination
      const nextCursor = summaries.length === 50 ? String(skip + 50) : undefined;

      log.info({ fetched: transcripts.length, nextCursor }, 'Fetched Fireflies transcript details');

      return {
        success: true,
        transcripts,
        nextCursor,
      };
    },
  };
}
