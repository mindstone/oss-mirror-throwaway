/**
 * Tests for meeting history store.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock electron-store before importing the module
vi.mock('electron-store', () => {
  return {
    default: class MockStore {
      private data: Record<string, unknown> = {};
      private defaults: Record<string, unknown>;
      
      constructor(options?: { name?: string; defaults?: Record<string, unknown> }) {
        this.defaults = options?.defaults ?? {};
        // Initialize with defaults
        this.data = JSON.parse(JSON.stringify(this.defaults));
      }
      
      get store(): Record<string, unknown> {
        return this.data;
      }
      
      set store(value: Record<string, unknown>) {
        this.data = value;
      }
      
      get<T>(key: string): T {
        if (key in this.data) {
          return this.data[key] as T;
        }
        return this.defaults[key] as T;
      }
      
      set(key: string, value: unknown): void {
        this.data[key] = value;
      }
      
      clear(): void {
        this.data = JSON.parse(JSON.stringify(this.defaults));
      }
    }
  };
});

// Mock demoModeService
vi.mock('../demoModeService', () => ({
  isDemoModeActive: () => false,
}));

// Mock transcriptEventBus
vi.mock('../meetingBot/transcriptEventBus', () => ({
  onTranscriptSaved: vi.fn(() => () => {}),
}));

// Import after mocks
import {
  generateMeetingId,
  reconcileCalendarMeetings,
  upsertMeetingEntry,
  getMeetingEntry,
  getMeetingsInRange,
  getMissedMeetings,
  getAllMeetingEntries,
  clearMeetingHistory,
  type MeetingHistoryEntry,
} from '../meetingHistoryStore';

describe('meetingHistoryStore', () => {
  beforeEach(() => {
    clearMeetingHistory();
  });

  describe('generateMeetingId', () => {
    it('creates collision-safe ID from source:eventId:startTime', () => {
      const id = generateMeetingId('google', 'event123', '2026-01-15T10:00:00Z');
      expect(id).toMatch(/^google:event123:2026-01-15T10:00:00\.000Z$/);
    });

    it('different sources with same eventId produce different IDs', () => {
      const googleId = generateMeetingId('google', 'same-id', '2026-01-15T10:00:00Z');
      const msftId = generateMeetingId('microsoft', 'same-id', '2026-01-15T10:00:00Z');
      expect(googleId).not.toBe(msftId);
    });

    it('same event at different times produces different IDs (recurring)', () => {
      const week1 = generateMeetingId('google', 'weekly-standup', '2026-01-13T09:00:00Z');
      const week2 = generateMeetingId('google', 'weekly-standup', '2026-01-20T09:00:00Z');
      expect(week1).not.toBe(week2);
    });
  });

  describe('upsertMeetingEntry', () => {
    it('creates new entry when none exists', () => {
      const entry: MeetingHistoryEntry = {
        id: 'google:event1:2026-01-15T10:00:00.000Z',
        calendarEventId: 'event1',
        calendarSource: 'google',
        title: 'Team Standup',
        startTime: '2026-01-15T10:00:00Z',
        endTime: '2026-01-15T10:30:00Z',
        meetingUrl: 'https://meet.google.com/abc-defg-hij',
        participants: ['alice@example.com', 'bob@example.com'],
        transcriptStatus: 'upcoming',
        botScheduled: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      upsertMeetingEntry(entry);
      
      const retrieved = getMeetingEntry(entry.id);
      expect(retrieved).toBeDefined();
      expect(retrieved?.title).toBe('Team Standup');
    });

    it('updates existing entry without creating duplicate', () => {
      const id = 'google:event1:2026-01-15T10:00:00.000Z';
      const entry: MeetingHistoryEntry = {
        id,
        calendarEventId: 'event1',
        calendarSource: 'google',
        title: 'Team Standup',
        startTime: '2026-01-15T10:00:00Z',
        endTime: '2026-01-15T10:30:00Z',
        participants: [],
        transcriptStatus: 'upcoming',
        botScheduled: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      upsertMeetingEntry(entry);
      
      // Update with new status
      upsertMeetingEntry({
        ...entry,
        transcriptStatus: 'captured',
        transcriptPath: '/path/to/transcript.md',
      });

      const allEntries = getAllMeetingEntries();
      expect(allEntries.length).toBe(1);
      expect(allEntries[0].transcriptStatus).toBe('captured');
      expect(allEntries[0].transcriptPath).toBe('/path/to/transcript.md');
    });
  });

  describe('getMeetingsInRange', () => {
    beforeEach(() => {
      // Seed with test data
      const meetings = [
        { id: 'g:1:2026-01-13T10:00:00.000Z', startTime: '2026-01-13T10:00:00Z', endTime: '2026-01-13T11:00:00Z', title: 'Monday standup' },
        { id: 'g:2:2026-01-14T10:00:00.000Z', startTime: '2026-01-14T10:00:00Z', endTime: '2026-01-14T11:00:00Z', title: 'Tuesday standup' },
        { id: 'g:3:2026-01-15T10:00:00.000Z', startTime: '2026-01-15T10:00:00Z', endTime: '2026-01-15T11:00:00Z', title: 'Wednesday standup' },
        { id: 'g:4:2026-01-16T10:00:00.000Z', startTime: '2026-01-16T10:00:00Z', endTime: '2026-01-16T11:00:00Z', title: 'Thursday standup' },
      ];
      
      for (const m of meetings) {
        upsertMeetingEntry({
          ...m,
          calendarEventId: m.id.split(':')[1],
          calendarSource: 'google',
          participants: [],
          transcriptStatus: 'captured',
          botScheduled: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      }
    });

    it('returns meetings within date range', () => {
      const start = new Date('2026-01-14T00:00:00Z');
      const end = new Date('2026-01-15T23:59:59Z');
      
      const meetings = getMeetingsInRange(start, end);
      
      expect(meetings.length).toBe(2);
      expect(meetings.map(m => m.title)).toContain('Tuesday standup');
      expect(meetings.map(m => m.title)).toContain('Wednesday standup');
    });

    it('returns empty array when no meetings in range', () => {
      const start = new Date('2026-02-01T00:00:00Z');
      const end = new Date('2026-02-07T23:59:59Z');
      
      const meetings = getMeetingsInRange(start, end);
      
      expect(meetings.length).toBe(0);
    });
  });

  describe('getMissedMeetings', () => {
    beforeEach(() => {
      // Use a fixed "now" for testing - Jan 15, 2026 at noon
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-15T12:00:00Z'));
      
      const meetings = [
        { id: 'g:1:2026-01-13T10:00:00.000Z', startTime: '2026-01-13T10:00:00Z', endTime: '2026-01-13T11:00:00Z', transcriptStatus: 'missed' as const },
        { id: 'g:2:2026-01-14T10:00:00.000Z', startTime: '2026-01-14T10:00:00Z', endTime: '2026-01-14T11:00:00Z', transcriptStatus: 'captured' as const },
        { id: 'g:3:2026-01-15T10:00:00.000Z', startTime: '2026-01-15T10:00:00Z', endTime: '2026-01-15T11:00:00Z', transcriptStatus: 'missed' as const },
        { id: 'g:4:2026-01-15T14:00:00.000Z', startTime: '2026-01-15T14:00:00Z', endTime: '2026-01-15T15:00:00Z', transcriptStatus: 'upcoming' as const }, // Future
      ];
      
      for (const m of meetings) {
        upsertMeetingEntry({
          ...m,
          title: 'Test Meeting',
          calendarEventId: m.id.split(':')[1],
          calendarSource: 'google',
          participants: [],
          botScheduled: false,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      }
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('returns only missed meetings that have ended', () => {
      const since = new Date('2026-01-12T00:00:00Z');
      const missed = getMissedMeetings(since);
      
      // Should include Jan 13 and Jan 15 10am meetings (both missed and ended)
      // Should NOT include Jan 14 (captured) or Jan 15 2pm (future)
      expect(missed.length).toBe(2);
    });

    it('respects the "since" parameter', () => {
      const since = new Date('2026-01-14T00:00:00Z');
      const missed = getMissedMeetings(since);
      
      // Only Jan 15 10am meeting is missed and after Jan 14
      expect(missed.length).toBe(1);
    });
  });

  describe('reconcileCalendarMeetings', () => {
    it('propagates participantEmails when creating entries', () => {
      const startTime = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const endTime = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();

      const { created, updated } = reconcileCalendarMeetings([
        {
          id: 'google:event-1',
          calendarEventId: 'event-1',
          calendarSource: 'google:user@example.com',
          title: 'Team Sync',
          startTime,
          endTime,
          participants: ['Alice'],
          participantEmails: ['alice@example.com'],
        },
      ]);

      expect(created).toBe(1);
      expect(updated).toBe(0);

      const meetingId = generateMeetingId('google:user@example.com', 'event-1', startTime);
      const entry = getMeetingEntry(meetingId);
      expect(entry?.participantEmails).toEqual(['alice@example.com']);
    });

    it('propagates participantEmails when updating existing entries', () => {
      const startTime = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const endTime = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();

      reconcileCalendarMeetings([
        {
          id: 'google:event-2',
          calendarEventId: 'event-2',
          calendarSource: 'google:user@example.com',
          title: 'Team Sync',
          startTime,
          endTime,
          participants: ['Alice'],
          participantEmails: ['alice@example.com'],
        },
      ]);

      const { created, updated } = reconcileCalendarMeetings([
        {
          id: 'google:event-2',
          calendarEventId: 'event-2',
          calendarSource: 'google:user@example.com',
          title: 'Team Sync Updated',
          startTime,
          endTime,
          participants: ['Alice', 'Bob'],
          participantEmails: ['alice@example.com', 'bob@example.com'],
        },
      ]);

      expect(created).toBe(0);
      expect(updated).toBe(1);

      const meetingId = generateMeetingId('google:user@example.com', 'event-2', startTime);
      const entry = getMeetingEntry(meetingId);
      expect(entry?.title).toBe('Team Sync Updated');
      expect(entry?.participantEmails).toEqual(['alice@example.com', 'bob@example.com']);
    });
  });
});
