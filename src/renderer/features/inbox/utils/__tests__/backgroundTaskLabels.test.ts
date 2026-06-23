import { describe, expect, it } from 'vitest';
import {
  parseBackgroundTaskType,
  humanizeAutomationType,
  sessionKindBadgeLabel,
} from '../backgroundTaskLabels';

describe('humanizeAutomationType', () => {
  it('returns curated label for known system types', () => {
    expect(humanizeAutomationType('wins-learnings-uncover')).toBe('Wins & learnings');
    expect(humanizeAutomationType('community-highlights')).toBe('Community highlights');
    expect(humanizeAutomationType('calendar-sync')).toBe('Calendar sync');
    expect(humanizeAutomationType('source-capture')).toBe('Source capture');
    expect(humanizeAutomationType('transcript-analysis')).toBe('Transcript analysis');
  });

  it('falls back to title-cased slug for unknown types', () => {
    expect(humanizeAutomationType('custom-report')).toBe('Custom report');
    expect(humanizeAutomationType('daily-digest')).toBe('Daily digest');
  });

  it('handles underscores in slug', () => {
    expect(humanizeAutomationType('my_automation')).toBe('My automation');
  });

  it('handles single-word slug', () => {
    expect(humanizeAutomationType('sync')).toBe('Sync');
  });
});

describe('parseBackgroundTaskType', () => {
  it('returns "Meeting analysis" for meeting-analysis sessions', () => {
    expect(parseBackgroundTaskType('meeting-analysis-550e8400-e29b-41d4-a716-446655440000'))
      .toBe('Meeting analysis');
  });

  it('returns "Memory update" for memory-update sessions', () => {
    expect(parseBackgroundTaskType('memory-update-abc123'))
      .toBe('Memory update');
  });

  it('returns "Error evaluation" for error-eval sessions', () => {
    expect(parseBackgroundTaskType('error-eval-abc123'))
      .toBe('Error evaluation');
  });

  it('returns humanized automation type for automation sessions', () => {
    expect(parseBackgroundTaskType('automation-wins-learnings-uncover--550e8400'))
      .toBe('Wins & learnings');
    expect(parseBackgroundTaskType('automation-calendar-sync--550e8400'))
      .toBe('Calendar sync');
  });

  it('handles unknown automation types via fallback', () => {
    expect(parseBackgroundTaskType('automation-custom-report--550e8400'))
      .toBe('Custom report');
  });

  it('returns "Automation" when type slug is empty after prefix', () => {
    // Edge case: "automation-" with no type or uuid
    expect(parseBackgroundTaskType('automation-')).toBe('Automation');
  });

  it('returns null for regular session IDs', () => {
    expect(parseBackgroundTaskType('550e8400-e29b-41d4-a716-446655440000')).toBeNull();
    expect(parseBackgroundTaskType('my-conversation')).toBeNull();
  });

  it('returns "Suggested" for use-case-discovery sessions', () => {
    expect(parseBackgroundTaskType('use-case-discovery-abc123')).toBe('Suggested');
  });

  it('returns null for empty string', () => {
    expect(parseBackgroundTaskType('')).toBeNull();
  });
});

describe('sessionKindBadgeLabel', () => {
  it('labels use-case-discovery as "Suggested"', () => {
    expect(sessionKindBadgeLabel('use-case-discovery-abc123')).toBe('Suggested');
  });

  it('labels automation sessions as the category "Automation" (not the specific name)', () => {
    // Distinct from parseBackgroundTaskType, which returns the specific automation name.
    expect(sessionKindBadgeLabel('automation-wins-learnings-uncover--550e8400')).toBe('Automation');
    expect(sessionKindBadgeLabel('automation-insight-550e8400')).toBe('Automation');
  });

  it('labels meeting-analysis as "Meeting"', () => {
    expect(sessionKindBadgeLabel('meeting-analysis-550e8400')).toBe('Meeting');
  });

  it('returns null for user-started conversations and CLI chats (no badge)', () => {
    expect(sessionKindBadgeLabel('550e8400-e29b-41d4-a716-446655440000')).toBeNull();
    expect(sessionKindBadgeLabel('my-conversation')).toBeNull();
    expect(sessionKindBadgeLabel('cli-chat-abc')).toBeNull();
  });
});
