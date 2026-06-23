/**
 * Tests for meeting history reconciliation logic.
 * 
 * These tests verify the matching algorithm that links transcripts to calendar meetings.
 * Written before implementation to validate assumptions and catch edge cases.
 */

import { describe, it, expect } from 'vitest';
import { urlsMatchSameMeeting, isWithinDedupWindow } from '../urlUtils';

// Test the matching algorithm we'll use in reconciliation
// This function will be implemented in meetingHistoryStore.ts
function matchTranscriptToMeeting(
  transcript: { calendarId?: string; conferenceUrl?: string; startedAt: string },
  meeting: { calendarEventId: string; meetingUrl?: string; startTime: string }
): boolean {
  // Priority 1: calendar_event_id match (exact, no ambiguity)
  if (transcript.calendarId && meeting.calendarEventId) {
    return transcript.calendarId === meeting.calendarEventId;
  }
  
  // Priority 2: URL + time window (reuse existing dedup logic)
  if (transcript.conferenceUrl && meeting.meetingUrl) {
    return urlsMatchSameMeeting(transcript.conferenceUrl, meeting.meetingUrl) &&
           isWithinDedupWindow(transcript.startedAt, meeting.startTime);
  }
  
  return false;
}

describe('matchTranscriptToMeeting', () => {
  describe('calendarId matching (priority 1)', () => {
    it('matches when calendarIds are identical', () => {
      const transcript = { 
        calendarId: 'abc123', 
        conferenceUrl: 'https://zoom.us/j/111',
        startedAt: '2026-01-15T10:00:00Z' 
      };
      const meeting = { 
        calendarEventId: 'abc123', 
        meetingUrl: 'https://zoom.us/j/999', // Different URL!
        startTime: '2026-01-15T14:00:00Z' // Different time!
      };
      
      // calendarId match takes precedence over URL/time
      expect(matchTranscriptToMeeting(transcript, meeting)).toBe(true);
    });

    it('does NOT match when calendarIds differ', () => {
      const transcript = { 
        calendarId: 'abc123', 
        conferenceUrl: 'https://zoom.us/j/111',
        startedAt: '2026-01-15T10:00:00Z' 
      };
      const meeting = { 
        calendarEventId: 'xyz789', 
        meetingUrl: 'https://zoom.us/j/111', // Same URL
        startTime: '2026-01-15T10:00:00Z' // Same time
      };
      
      // Different calendarId = no match, even if URL/time match
      expect(matchTranscriptToMeeting(transcript, meeting)).toBe(false);
    });
  });

  describe('URL + time window matching (priority 2)', () => {
    it('matches same Zoom URL within 2-hour window', () => {
      const transcript = { 
        conferenceUrl: 'https://us02web.zoom.us/j/1234567890',
        startedAt: '2026-01-15T10:00:00Z' 
      };
      const meeting = { 
        calendarEventId: 'event1',
        meetingUrl: 'https://zoom.us/j/1234567890', // Same meeting ID, different subdomain
        startTime: '2026-01-15T10:30:00Z' // 30 min later - within window
      };
      
      expect(matchTranscriptToMeeting(transcript, meeting)).toBe(true);
    });

    it('matches Google Meet URL with query params', () => {
      const transcript = { 
        conferenceUrl: 'https://meet.google.com/abc-defg-hij',
        startedAt: '2026-01-15T14:00:00Z' 
      };
      const meeting = { 
        calendarEventId: 'event2',
        meetingUrl: 'https://meet.google.com/abc-defg-hij?authuser=0',
        startTime: '2026-01-15T14:05:00Z'
      };
      
      expect(matchTranscriptToMeeting(transcript, meeting)).toBe(true);
    });

    it('does NOT match same URL outside 2-hour window (recurring meeting)', () => {
      const transcript = { 
        conferenceUrl: 'https://zoom.us/j/1234567890',
        startedAt: '2026-01-15T10:00:00Z' 
      };
      const meeting = { 
        calendarEventId: 'event3',
        meetingUrl: 'https://zoom.us/j/1234567890', // Same personal room URL
        startTime: '2026-01-15T14:00:00Z' // 4 hours later - different meeting instance
      };
      
      // This is critical for recurring meetings with same personal room URL
      expect(matchTranscriptToMeeting(transcript, meeting)).toBe(false);
    });

    it('does NOT match different Zoom meeting IDs', () => {
      const transcript = { 
        conferenceUrl: 'https://zoom.us/j/1111111111',
        startedAt: '2026-01-15T10:00:00Z' 
      };
      const meeting = { 
        calendarEventId: 'event4',
        meetingUrl: 'https://zoom.us/j/2222222222',
        startTime: '2026-01-15T10:00:00Z'
      };
      
      expect(matchTranscriptToMeeting(transcript, meeting)).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('returns false when transcript has no calendarId and no URL', () => {
      const transcript = { 
        startedAt: '2026-01-15T10:00:00Z' 
      };
      const meeting = { 
        calendarEventId: 'event5',
        meetingUrl: 'https://zoom.us/j/123',
        startTime: '2026-01-15T10:00:00Z'
      };
      
      expect(matchTranscriptToMeeting(transcript, meeting)).toBe(false);
    });

    it('returns false when meeting has no URL and transcript has no calendarId', () => {
      const transcript = { 
        conferenceUrl: 'https://zoom.us/j/123',
        startedAt: '2026-01-15T10:00:00Z' 
      };
      const meeting = { 
        calendarEventId: 'event6',
        startTime: '2026-01-15T10:00:00Z'
      };
      
      expect(matchTranscriptToMeeting(transcript, meeting)).toBe(false);
    });

    it('handles timezone-aware ISO strings correctly', () => {
      const transcript = { 
        conferenceUrl: 'https://zoom.us/j/123',
        startedAt: '2026-01-15T10:00:00-08:00' // PST
      };
      const meeting = { 
        calendarEventId: 'event7',
        meetingUrl: 'https://zoom.us/j/123',
        startTime: '2026-01-15T18:00:00Z' // Same moment in UTC
      };
      
      expect(matchTranscriptToMeeting(transcript, meeting)).toBe(true);
    });

    it('falls back to URL matching when only transcript has calendarId', () => {
      const transcript = { 
        calendarId: 'abc123',
        conferenceUrl: 'https://zoom.us/j/123',
        startedAt: '2026-01-15T10:00:00Z' 
      };
      const meeting = { 
        calendarEventId: '', // Empty - calendar didn't provide it
        meetingUrl: 'https://zoom.us/j/123',
        startTime: '2026-01-15T10:00:00Z'
      };
      
      // Should fall back to URL matching since meeting has no calendarEventId
      // Current implementation: calendarId check requires BOTH to have values
      expect(matchTranscriptToMeeting(transcript, meeting)).toBe(true);
    });
  });
});

describe('generateMeetingId', () => {
  // This function will be implemented in meetingHistoryStore.ts
  function generateMeetingId(
    calendarSource: string,
    calendarEventId: string,
    startTime: string
  ): string {
    // Canonicalize startTime to ISO string for consistent IDs
    const canonicalTime = new Date(startTime).toISOString();
    return `${calendarSource}:${calendarEventId}:${canonicalTime}`;
  }

  it('creates ID with source:eventId:isoTime format', () => {
    const id = generateMeetingId('google', 'abc123', '2026-01-15T10:00:00Z');
    expect(id).toBe('google:abc123:2026-01-15T10:00:00.000Z');
  });

  it('canonicalizes different time formats to same ID', () => {
    const id1 = generateMeetingId('google', 'abc123', '2026-01-15T10:00:00Z');
    const id2 = generateMeetingId('google', 'abc123', '2026-01-15T10:00:00.000Z');
    const _id3 = generateMeetingId('google', 'abc123', '2026-01-15T18:00:00+08:00'); // Same moment
    
    expect(id1).toBe(id2);
    // Note: id3 would be different because it's a different moment in time
  });

  it('different calendar sources produce different IDs', () => {
    const googleId = generateMeetingId('google', 'abc123', '2026-01-15T10:00:00Z');
    const msftId = generateMeetingId('microsoft', 'abc123', '2026-01-15T10:00:00Z');
    
    expect(googleId).not.toBe(msftId);
  });

  it('recurring meetings (same event, different times) have different IDs', () => {
    const monday = generateMeetingId('google', 'recurring123', '2026-01-13T10:00:00Z');
    const tuesday = generateMeetingId('google', 'recurring123', '2026-01-14T10:00:00Z');
    
    expect(monday).not.toBe(tuesday);
  });
});
