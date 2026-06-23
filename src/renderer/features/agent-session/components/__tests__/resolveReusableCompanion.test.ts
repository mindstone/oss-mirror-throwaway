import { describe, expect, it } from 'vitest';
import { extractMeetingId } from '@rebel/shared';
import type { AgentSessionSummary } from '@shared/types';
import {
  COMPANION_REUSE_WINDOW_MS,
  resolveReusableCompanion,
} from '../resolveReusableCompanion';

const NOW = 1_778_503_600_000;
const BASE_MEETING_URL = 'https://us02web.zoom.us/j/85014715189?pwd=abc';
const BASE_MEETING_KEY = extractMeetingId(BASE_MEETING_URL) ?? BASE_MEETING_URL;

function makeSummary(
  overrides: Partial<AgentSessionSummary> & Pick<AgentSessionSummary, 'id'>,
): AgentSessionSummary {
  return {
    id: overrides.id,
    title: overrides.title ?? null,
    createdAt: overrides.createdAt ?? NOW - 60_000,
    updatedAt: overrides.updatedAt ?? NOW - 30_000,
    resolvedAt: overrides.resolvedAt ?? null,
    doneAt: overrides.doneAt ?? null,
    starredAt: overrides.starredAt ?? null,
    deletedAt: overrides.deletedAt ?? null,
    origin: overrides.origin ?? 'manual',
    isCorrupted: overrides.isCorrupted ?? false,
    preview: overrides.preview ?? '',
    messageCount: overrides.messageCount ?? 0,
    hasDraft: overrides.hasDraft ?? false,
    draftPreview: overrides.draftPreview ?? null,
    draftUpdatedAt: overrides.draftUpdatedAt ?? null,
    usage: overrides.usage ?? {
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      turnCount: 0,
    },
    activeTurnId: overrides.activeTurnId ?? null,
    isBusy: overrides.isBusy ?? false,
    lastError: overrides.lastError ?? null,
    meetingCompanion: overrides.meetingCompanion,
  };
}

describe('resolveReusableCompanion', () => {
  it('reuses companion when botId matches', () => {
    const summary = makeSummary({
      id: 'session-bot-match',
      meetingCompanion: {
        meetingUrl: BASE_MEETING_URL,
        botId: 'bot-123',
        startedAt: NOW - 120_000,
      },
    });

    const result = resolveReusableCompanion({
      currentBotId: 'bot-123',
      currentMeetingKey: BASE_MEETING_KEY,
      summaries: [summary],
      now: NOW,
    });

    expect(result?.id).toBe('session-bot-match');
  });

  it('returns null when summary botId mismatches even if meeting key matches', () => {
    const summary = makeSummary({
      id: 'session-bot-mismatch',
      meetingCompanion: {
        meetingUrl: BASE_MEETING_URL,
        botId: 'bot-old',
        startedAt: NOW - 120_000,
      },
    });

    const result = resolveReusableCompanion({
      currentBotId: 'bot-new',
      currentMeetingKey: BASE_MEETING_KEY,
      summaries: [summary],
      now: NOW,
    });

    expect(result).toBeNull();
  });

  it('reuses legacy summary within recency window when meeting key matches', () => {
    const summary = makeSummary({
      id: 'legacy-recent',
      meetingCompanion: {
        meetingUrl: BASE_MEETING_URL,
        startedAt: NOW - (COMPANION_REUSE_WINDOW_MS - 1_000),
      },
    });

    const result = resolveReusableCompanion({
      currentBotId: 'bot-new',
      currentMeetingKey: BASE_MEETING_KEY,
      summaries: [summary],
      now: NOW,
    });

    expect(result?.id).toBe('legacy-recent');
  });

  it('returns null for legacy summary outside recency window', () => {
    const summary = makeSummary({
      id: 'legacy-stale',
      meetingCompanion: {
        meetingUrl: BASE_MEETING_URL,
        startedAt: NOW - (COMPANION_REUSE_WINDOW_MS + 1_000),
      },
    });

    const result = resolveReusableCompanion({
      currentBotId: 'bot-new',
      currentMeetingKey: BASE_MEETING_KEY,
      summaries: [summary],
      now: NOW,
    });

    expect(result).toBeNull();
  });

  it('returns null when meeting key differs', () => {
    const summary = makeSummary({
      id: 'different-key',
      meetingCompanion: {
        meetingUrl: 'https://meet.google.com/abc-defg-hij',
        botId: 'bot-123',
        startedAt: NOW - 30_000,
      },
    });

    const result = resolveReusableCompanion({
      currentBotId: 'bot-123',
      currentMeetingKey: BASE_MEETING_KEY,
      summaries: [summary],
      now: NOW,
    });

    expect(result).toBeNull();
  });

  it('returns null for deleted summaries', () => {
    const summary = makeSummary({
      id: 'deleted-summary',
      deletedAt: NOW - 1_000,
      meetingCompanion: {
        meetingUrl: BASE_MEETING_URL,
        botId: 'bot-123',
        startedAt: NOW - 30_000,
      },
    });

    const result = resolveReusableCompanion({
      currentBotId: 'bot-123',
      currentMeetingKey: BASE_MEETING_KEY,
      summaries: [summary],
      now: NOW,
    });

    expect(result).toBeNull();
  });

  it('returns newest legacy candidate by startedAt then createdAt', () => {
    const older = makeSummary({
      id: 'legacy-older',
      createdAt: NOW - 200_000,
      meetingCompanion: {
        meetingUrl: BASE_MEETING_URL,
        startedAt: NOW - 180_000,
      },
    });
    const newerByCreatedAt = makeSummary({
      id: 'legacy-newer-createdAt',
      createdAt: NOW - 80_000,
      meetingCompanion: {
        meetingUrl: BASE_MEETING_URL,
      },
    });

    const result = resolveReusableCompanion({
      currentBotId: 'bot-new',
      currentMeetingKey: BASE_MEETING_KEY,
      summaries: [older, newerByCreatedAt],
      now: NOW,
    });

    expect(result?.id).toBe('legacy-newer-createdAt');
  });

  it('prefers botId match over legacy candidate regardless of recency', () => {
    const botMatchOutsideWindow = makeSummary({
      id: 'bot-match-old',
      meetingCompanion: {
        meetingUrl: BASE_MEETING_URL,
        botId: 'bot-live',
        startedAt: NOW - (COMPANION_REUSE_WINDOW_MS + 10_000),
      },
    });
    const legacyWithinWindow = makeSummary({
      id: 'legacy-recent',
      meetingCompanion: {
        meetingUrl: BASE_MEETING_URL,
        startedAt: NOW - 30_000,
      },
    });

    const result = resolveReusableCompanion({
      currentBotId: 'bot-live',
      currentMeetingKey: BASE_MEETING_KEY,
      summaries: [legacyWithinWindow, botMatchOutsideWindow],
      now: NOW,
    });

    expect(result?.id).toBe('bot-match-old');
  });

  it('returns null when currentBotId is undefined and summary has botId within recency window', () => {
    const summary = makeSummary({
      id: 'summary-with-bot-id',
      meetingCompanion: {
        meetingUrl: BASE_MEETING_URL,
        botId: 'bot-live',
        startedAt: NOW - 30_000,
      },
    });

    const result = resolveReusableCompanion({
      currentBotId: undefined,
      currentMeetingKey: BASE_MEETING_KEY,
      summaries: [summary],
      now: NOW,
    });

    expect(result).toBeNull();
  });

  it('reuses legacy summary when currentBotId is undefined and summary has no botId within recency window', () => {
    const summary = makeSummary({
      id: 'legacy-no-bot-id',
      meetingCompanion: {
        meetingUrl: BASE_MEETING_URL,
        startedAt: NOW - 30_000,
      },
    });

    const result = resolveReusableCompanion({
      currentBotId: undefined,
      currentMeetingKey: BASE_MEETING_KEY,
      summaries: [summary],
      now: NOW,
    });

    expect(result?.id).toBe('legacy-no-bot-id');
  });

  it('returns null when currentBotId is undefined and summary has no botId outside recency window', () => {
    const summary = makeSummary({
      id: 'legacy-no-bot-id-stale',
      meetingCompanion: {
        meetingUrl: BASE_MEETING_URL,
        startedAt: NOW - (COMPANION_REUSE_WINDOW_MS + 1_000),
      },
    });

    const result = resolveReusableCompanion({
      currentBotId: undefined,
      currentMeetingKey: BASE_MEETING_KEY,
      summaries: [summary],
      now: NOW,
    });

    expect(result).toBeNull();
  });

  it('returns null when summary botId is empty string and currentBotId is set', () => {
    const summary = makeSummary({
      id: 'empty-string-bot-id',
      meetingCompanion: {
        meetingUrl: BASE_MEETING_URL,
        botId: '',
        startedAt: NOW - 30_000,
      },
    });

    const result = resolveReusableCompanion({
      currentBotId: 'bot-1',
      currentMeetingKey: BASE_MEETING_KEY,
      summaries: [summary],
      now: NOW,
    });

    expect(result).toBeNull();
  });
});
