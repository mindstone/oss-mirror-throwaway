import { describe, it, expect } from 'vitest';
import { _testing, getGoogleCalendarColorPalette, getGoogleEventColor } from '../directCalendarSync';

const {
  extractMeetingUrlFromGoogle,
  extractMeetingUrlFromMicrosoft,
  extractMeetingUrlFromText,
  cleanMeetingUrl,
  googleEventToMeeting,
  microsoftEventToMeeting,
  deduplicateMeetings,
  normalizeMsDateTime,
  createDropReasonCounters,
  totalDrops,
} = _testing;

describe('directCalendarSync', () => {
  describe('cleanMeetingUrl', () => {
    it('removes trailing punctuation', () => {
      expect(cleanMeetingUrl('https://zoom.us/j/123.')).toBe('https://zoom.us/j/123');
      expect(cleanMeetingUrl('https://zoom.us/j/123,')).toBe('https://zoom.us/j/123');
      expect(cleanMeetingUrl('https://zoom.us/j/123;')).toBe('https://zoom.us/j/123');
      expect(cleanMeetingUrl('https://zoom.us/j/123)')).toBe('https://zoom.us/j/123');
      expect(cleanMeetingUrl('https://zoom.us/j/123>')).toBe('https://zoom.us/j/123');
    });

    it('removes multiple trailing punctuation', () => {
      expect(cleanMeetingUrl('https://zoom.us/j/123...')).toBe('https://zoom.us/j/123');
      expect(cleanMeetingUrl('https://zoom.us/j/123).')).toBe('https://zoom.us/j/123');
    });

    it('trims whitespace', () => {
      expect(cleanMeetingUrl('  https://zoom.us/j/123  ')).toBe('https://zoom.us/j/123');
    });

    it('preserves valid URLs', () => {
      expect(cleanMeetingUrl('https://zoom.us/j/123?pwd=abc')).toBe('https://zoom.us/j/123?pwd=abc');
    });
  });

  describe('extractMeetingUrlFromText', () => {
    it('extracts Zoom URLs', () => {
      expect(extractMeetingUrlFromText(['Join: https://zoom.us/j/123456789'])).toBe('https://zoom.us/j/123456789');
      expect(extractMeetingUrlFromText(['https://us02web.zoom.us/j/123'])).toBe('https://us02web.zoom.us/j/123');
    });

    it('extracts Google Meet URLs', () => {
      expect(extractMeetingUrlFromText(['https://meet.google.com/abc-defg-hij'])).toBe('https://meet.google.com/abc-defg-hij');
    });

    it('extracts Microsoft Teams URLs', () => {
      expect(extractMeetingUrlFromText(['https://teams.microsoft.com/l/meetup-join/abc'])).toBe('https://teams.microsoft.com/l/meetup-join/abc');
      expect(extractMeetingUrlFromText(['https://teams.live.com/meet/123'])).toBe('https://teams.live.com/meet/123');
    });

    it('extracts Webex URLs', () => {
      expect(extractMeetingUrlFromText(['https://company.webex.com/meet/user'])).toBe('https://company.webex.com/meet/user');
    });

    it('returns undefined when no URL found', () => {
      expect(extractMeetingUrlFromText(['No meeting link here'])).toBeUndefined();
      expect(extractMeetingUrlFromText([undefined, null as any])).toBeUndefined();
      expect(extractMeetingUrlFromText([])).toBeUndefined();
    });

    it('combines multiple text fields', () => {
      expect(extractMeetingUrlFromText(['Location: Room 1', 'https://zoom.us/j/123'])).toBe('https://zoom.us/j/123');
    });
  });

  describe('extractMeetingUrlFromGoogle', () => {
    it('extracts from conferenceData video entry', () => {
      const event = {
        id: '1',
        start: { dateTime: '2024-01-01T10:00:00Z' },
        end: { dateTime: '2024-01-01T11:00:00Z' },
        conferenceData: {
          entryPoints: [
            { entryPointType: 'phone', uri: 'tel:+1234567890' },
            { entryPointType: 'video', uri: 'https://meet.google.com/abc-defg-hij' },
          ],
        },
      };
      expect(extractMeetingUrlFromGoogle(event)).toBe('https://meet.google.com/abc-defg-hij');
    });

    it('falls back to hangoutLink', () => {
      const event = {
        id: '1',
        start: { dateTime: '2024-01-01T10:00:00Z' },
        end: { dateTime: '2024-01-01T11:00:00Z' },
        hangoutLink: 'https://meet.google.com/xyz-uvwx-rst',
      };
      expect(extractMeetingUrlFromGoogle(event)).toBe('https://meet.google.com/xyz-uvwx-rst');
    });

    it('scans location for Zoom URL', () => {
      const event = {
        id: '1',
        start: { dateTime: '2024-01-01T10:00:00Z' },
        end: { dateTime: '2024-01-01T11:00:00Z' },
        location: 'https://zoom.us/j/123456789',
      };
      expect(extractMeetingUrlFromGoogle(event)).toBe('https://zoom.us/j/123456789');
    });

    it('scans description for meeting URL', () => {
      const event = {
        id: '1',
        start: { dateTime: '2024-01-01T10:00:00Z' },
        end: { dateTime: '2024-01-01T11:00:00Z' },
        description: 'Join via Teams: https://teams.microsoft.com/l/meetup-join/abc',
      };
      expect(extractMeetingUrlFromGoogle(event)).toBe('https://teams.microsoft.com/l/meetup-join/abc');
    });

    it('returns undefined when no URL found', () => {
      const event = {
        id: '1',
        start: { dateTime: '2024-01-01T10:00:00Z' },
        end: { dateTime: '2024-01-01T11:00:00Z' },
        summary: 'In-person meeting',
        location: 'Conference Room A',
      };
      expect(extractMeetingUrlFromGoogle(event)).toBeUndefined();
    });
  });

  describe('extractMeetingUrlFromMicrosoft', () => {
    it('extracts from onlineMeeting.joinUrl', () => {
      const event = {
        id: '1',
        start: { dateTime: '2024-01-01T10:00:00Z' },
        end: { dateTime: '2024-01-01T11:00:00Z' },
        onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/meetup-join/abc' },
      };
      expect(extractMeetingUrlFromMicrosoft(event)).toBe('https://teams.microsoft.com/l/meetup-join/abc');
    });

    it('scans location for URL', () => {
      const event = {
        id: '1',
        start: { dateTime: '2024-01-01T10:00:00Z' },
        end: { dateTime: '2024-01-01T11:00:00Z' },
        location: { displayName: 'https://zoom.us/j/123' },
      };
      expect(extractMeetingUrlFromMicrosoft(event)).toBe('https://zoom.us/j/123');
    });

    it('returns undefined when no URL found', () => {
      const event = {
        id: '1',
        start: { dateTime: '2024-01-01T10:00:00Z' },
        end: { dateTime: '2024-01-01T11:00:00Z' },
        location: { displayName: 'Room 101' },
      };
      expect(extractMeetingUrlFromMicrosoft(event)).toBeUndefined();
    });
  });

  describe('googleEventToMeeting', () => {
    it('converts a basic event', () => {
      const event = {
        id: 'event123',
        summary: 'Team Meeting',
        start: { dateTime: '2024-01-15T10:00:00Z' },
        end: { dateTime: '2024-01-15T11:00:00Z' },
        hangoutLink: 'https://meet.google.com/abc-defg-hij',
        attendees: [
          { email: 'alice@example.com', displayName: 'Alice', responseStatus: 'accepted' },
          { email: 'bob@example.com', self: true, responseStatus: 'accepted' },
        ],
        colorId: '5',
      };
      
      const meeting = googleEventToMeeting(event, 'user@example.com', 'team-calendar');
      
      expect(meeting).toEqual({
        id: 'google:event123',
        calendarEventId: 'event123',
        calendarSource: 'google:user@example.com',
        calendarId: 'team-calendar',
        title: 'Team Meeting',
        startTime: '2024-01-15T10:00:00Z',
        endTime: '2024-01-15T11:00:00Z',
        meetingUrl: 'https://meet.google.com/abc-defg-hij',
        participants: ['Alice'],
        participantEmails: ['alice@example.com'],
        colorId: '5',
      });
    });

    it('extracts participantEmails and excludes self/declined attendees', () => {
      const event = {
        id: 'event-emails',
        summary: 'Email Extraction',
        start: { dateTime: '2024-01-15T10:00:00Z' },
        end: { dateTime: '2024-01-15T11:00:00Z' },
        attendees: [
          { email: 'user@example.com', self: true, responseStatus: 'accepted' },
          { email: '[external-email]', displayName: 'Accepted', responseStatus: 'accepted' },
          { email: 'declined@example.com', displayName: 'Declined', responseStatus: 'declined' },
          { email: 'missing-response@example.com', displayName: 'No Response' },
        ],
      };

      const meeting = googleEventToMeeting(event, 'user@example.com');

      expect(meeting?.participantEmails).toEqual(['accepted@example.com']);
      expect(meeting?.participants).toEqual(['Accepted', 'Declined', 'No Response']);
    });

    it('skips cancelled events', () => {
      const event = {
        id: 'event123',
        status: 'cancelled',
        start: { dateTime: '2024-01-15T10:00:00Z' },
        end: { dateTime: '2024-01-15T11:00:00Z' },
      };
      expect(googleEventToMeeting(event, 'user@example.com')).toBeNull();
    });

    it('skips declined events', () => {
      const event = {
        id: 'event123',
        start: { dateTime: '2024-01-15T10:00:00Z' },
        end: { dateTime: '2024-01-15T11:00:00Z' },
        attendees: [
          { email: 'user@example.com', self: true, responseStatus: 'declined' },
        ],
      };
      expect(googleEventToMeeting(event, 'user@example.com')).toBeNull();
    });

    it('skips tentative events', () => {
      const event = {
        id: 'event123',
        start: { dateTime: '2024-01-15T10:00:00Z' },
        end: { dateTime: '2024-01-15T11:00:00Z' },
        attendees: [
          { email: 'user@example.com', self: true, responseStatus: 'tentative' },
        ],
      };
      expect(googleEventToMeeting(event, 'user@example.com')).toBeNull();
    });

    it('handles all-day events', () => {
      const event = {
        id: 'event123',
        summary: 'Holiday',
        start: { date: '2024-01-15' },
        end: { date: '2024-01-16' },
        creator: { email: 'user@example.com', self: true },
      };
      
      const meeting = googleEventToMeeting(event, 'user@example.com');
      expect(meeting?.startTime).toBe('2024-01-15');
      expect(meeting?.endTime).toBe('2024-01-16');
    });

    it('uses (No title) for events without summary', () => {
      const event = {
        id: 'event123',
        start: { dateTime: '2024-01-15T10:00:00Z' },
        end: { dateTime: '2024-01-15T11:00:00Z' },
        creator: { email: 'user@example.com', self: true },
      };
      
      const meeting = googleEventToMeeting(event, 'user@example.com');
      expect(meeting?.title).toBe('(No title)');
    });
  });

  describe('microsoftEventToMeeting', () => {
    it('converts a basic event (normalizes naive UTC datetimes with Z suffix)', () => {
      const event = {
        id: 'msEvent123',
        subject: 'Project Sync',
        // Microsoft Graph returns naive strings (no Z) alongside timeZone: 'UTC'
        // because we set `Prefer: outlook.timezone="UTC"`. We normalize by appending Z
        // so downstream `new Date(...)` parsers treat them as absolute UTC instants.
        start: { dateTime: '2024-01-15T10:00:00.0000000', timeZone: 'UTC' },
        end: { dateTime: '2024-01-15T11:00:00.0000000', timeZone: 'UTC' },
        responseStatus: { response: 'organizer' },
        onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/meetup-join/abc' },
        attendees: [
          { emailAddress: { address: 'alice@example.com', name: 'Alice Smith' }, status: { response: 'accepted' } },
        ],
        categories: ['Blue Category'],
      };

      const meeting = microsoftEventToMeeting(event, 'user@example.com', 'team-calendar');

      expect(meeting).toEqual({
        id: 'microsoft:msEvent123',
        calendarEventId: 'msEvent123',
        calendarSource: 'microsoft:user@example.com',
        calendarId: 'team-calendar',
        title: 'Project Sync',
        startTime: '2024-01-15T10:00:00.0000000Z',
        endTime: '2024-01-15T11:00:00.0000000Z',
        meetingUrl: 'https://teams.microsoft.com/l/meetup-join/abc',
        participants: ['Alice Smith'],
        participantEmails: ['alice@example.com'],
        colorId: 'Blue Category',
      });
    });

    it('extracts participantEmails and excludes the current user email', () => {
      const event = {
        id: 'msEvent-emails',
        subject: 'Project Sync',
        responseStatus: { response: 'organizer' },
        start: { dateTime: '2024-01-15T10:00:00' },
        end: { dateTime: '2024-01-15T11:00:00' },
        attendees: [
          { emailAddress: { address: '[external-email]', name: 'Me' }, status: { response: 'organizer' } },
          { emailAddress: { address: '[external-email]', name: 'Alice' }, status: { response: 'accepted' } },
          { emailAddress: { address: '[external-email]', name: 'Bob' }, status: { response: 'accepted' } },
        ],
      };

      const meeting = microsoftEventToMeeting(event, 'user@example.com');

      expect(meeting?.participantEmails).toEqual(['alice@example.com', 'bob@example.com']);
      expect(meeting?.participants).toEqual(['Alice', 'Bob']);
    });

    it('skips cancelled events', () => {
      const event = {
        id: 'msEvent123',
        isCancelled: true,
        start: { dateTime: '2024-01-15T10:00:00' },
        end: { dateTime: '2024-01-15T11:00:00' },
      };
      expect(microsoftEventToMeeting(event, 'user@example.com')).toBeNull();
    });

    it('skips non-accepted response statuses', () => {
      const event = {
        id: 'msEvent123',
        responseStatus: { response: 'tentativelyAccepted' },
        start: { dateTime: '2024-01-15T10:00:00' },
        end: { dateTime: '2024-01-15T11:00:00' },
      };
      expect(microsoftEventToMeeting(event, 'user@example.com')).toBeNull();
    });
  });

  describe('normalizeMsDateTime (timezone offset regression)', () => {
    // Regression coverage for the Microsoft calendar timezone bug.
    // See docs-private/investigations/260420_microsoft_calendar_timezone_offset.md
    //
    // Microsoft Graph's calendarView returns naive ISO strings like
    // "2026-04-21T19:00:00.0000000" without a 'Z' suffix. `new Date(...)`
    // treats offset-less strings as local time, so UTC values were being
    // displayed in the user's local timezone (e.g., GMT/London instead of CDT).
    // The fix sets `Prefer: outlook.timezone="UTC"` and normalizes returned
    // datetimes to explicit UTC instants.

    it('appends Z to naive UTC datetime (Microsoft calendarView shape)', () => {
      expect(normalizeMsDateTime('2026-04-21T19:00:00.0000000', 'UTC'))
        .toBe('2026-04-21T19:00:00.0000000Z');
    });

    it('passes through datetime that already has Z suffix unchanged', () => {
      expect(normalizeMsDateTime('2026-04-21T19:00:00Z', 'UTC'))
        .toBe('2026-04-21T19:00:00Z');
      expect(normalizeMsDateTime('2026-04-21T19:00:00.0000000Z', 'UTC'))
        .toBe('2026-04-21T19:00:00.0000000Z');
    });

    it('passes through datetime that already has a numeric offset unchanged', () => {
      expect(normalizeMsDateTime('2026-04-21T14:00:00-05:00', 'UTC'))
        .toBe('2026-04-21T14:00:00-05:00');
      expect(normalizeMsDateTime('2026-04-21T14:00:00+0000', 'UTC'))
        .toBe('2026-04-21T14:00:00+0000');
    });

    it('treats missing timeZone as UTC (we request UTC via the Prefer header)', () => {
      expect(normalizeMsDateTime('2026-04-21T19:00:00.0000000', undefined))
        .toBe('2026-04-21T19:00:00.0000000Z');
    });

    it('passes through non-UTC timezones unchanged rather than guessing', () => {
      // Unexpected (we request UTC), but we preserve the input rather than
      // silently corrupt it. The mapping function logs a warning in this case.
      expect(normalizeMsDateTime('2026-04-21T14:00:00', 'Central Standard Time'))
        .toBe('2026-04-21T14:00:00');
    });

    it('returns empty string for undefined input', () => {
      expect(normalizeMsDateTime(undefined, 'UTC')).toBe('');
    });

    it('accepts lowercase utc timeZone (case-insensitive)', () => {
      expect(normalizeMsDateTime('2026-04-21T19:00:00', 'utc'))
        .toBe('2026-04-21T19:00:00Z');
    });
  });

  describe('microsoftEventToMeeting (timezone regression)', () => {
    // End-to-end coverage: the bug surface is at the mapping boundary.
    // See docs-private/investigations/260420_microsoft_calendar_timezone_offset.md

    it('normalizes naive UTC start/end datetimes so they are absolute instants', () => {
      const event = {
        id: 'tz-regression',
        subject: 'Meeting',
        responseStatus: { response: 'organizer' },
        start: { dateTime: '2026-04-21T19:00:00.0000000', timeZone: 'UTC' },
        end: { dateTime: '2026-04-21T20:00:00.0000000', timeZone: 'UTC' },
      };
      const meeting = microsoftEventToMeeting(event, 'user@example.com');
      expect(meeting?.startTime).toBe('2026-04-21T19:00:00.0000000Z');
      expect(meeting?.endTime).toBe('2026-04-21T20:00:00.0000000Z');

      // Sanity check: `new Date(...)` should now parse this as UTC, not local.
      expect(new Date(meeting!.startTime).toISOString()).toBe('2026-04-21T19:00:00.000Z');
    });

    it('leaves offset-aware datetimes (Google-style shape) unchanged', () => {
      // Google Calendar already returns offset-aware strings; this test documents
      // that our normalizer doesn't munge correctly-formatted inputs.
      const event = {
        id: 'google-shape',
        subject: 'Meeting',
        responseStatus: { response: 'organizer' },
        start: { dateTime: '2026-04-21T14:00:00-05:00', timeZone: 'UTC' },
        end: { dateTime: '2026-04-21T15:00:00-05:00', timeZone: 'UTC' },
      };
      const meeting = microsoftEventToMeeting(event, 'user@example.com');
      expect(meeting?.startTime).toBe('2026-04-21T14:00:00-05:00');
      expect(meeting?.endTime).toBe('2026-04-21T15:00:00-05:00');
    });
  });

  describe('deduplicateMeetings', () => {
    it('removes duplicate meetings by title and startTime', () => {
      const meetings = [
        { id: 'google:1', calendarEventId: '1', calendarSource: 'google', title: 'Sync', startTime: '2024-01-15T10:00:00Z', endTime: '2024-01-15T11:00:00Z', participants: [] },
        { id: 'microsoft:1', calendarEventId: '1', calendarSource: 'microsoft', title: 'Sync', startTime: '2024-01-15T10:00:00Z', endTime: '2024-01-15T11:00:00Z', participants: [] },
      ];
      
      const deduped = deduplicateMeetings(meetings);
      expect(deduped).toHaveLength(1);
    });

    it('keeps meeting with URL when deduplicating', () => {
      const meetings = [
        { id: 'google:1', calendarEventId: '1', calendarSource: 'google', title: 'Sync', startTime: '2024-01-15T10:00:00Z', endTime: '2024-01-15T11:00:00Z', participants: [] },
        { id: 'microsoft:1', calendarEventId: '1', calendarSource: 'microsoft', title: 'Sync', startTime: '2024-01-15T10:00:00Z', endTime: '2024-01-15T11:00:00Z', meetingUrl: 'https://teams.microsoft.com/abc', participants: [] },
      ];
      
      const deduped = deduplicateMeetings(meetings);
      expect(deduped).toHaveLength(1);
      expect(deduped[0].meetingUrl).toBe('https://teams.microsoft.com/abc');
    });

    it('keeps different meetings', () => {
      const meetings = [
        { id: 'google:1', calendarEventId: '1', calendarSource: 'google', title: 'Meeting A', startTime: '2024-01-15T10:00:00Z', endTime: '2024-01-15T11:00:00Z', participants: [] },
        { id: 'google:2', calendarEventId: '2', calendarSource: 'google', title: 'Meeting B', startTime: '2024-01-15T14:00:00Z', endTime: '2024-01-15T15:00:00Z', participants: [] },
      ];
      
      const deduped = deduplicateMeetings(meetings);
      expect(deduped).toHaveLength(2);
    });
  });

  describe('getGoogleCalendarColorPalette', () => {
    it('returns a palette with all 11 event colors', () => {
      const palette = getGoogleCalendarColorPalette();
      expect(palette.event).toBeDefined();
      expect(Object.keys(palette.event)).toHaveLength(11);
      for (let i = 1; i <= 11; i++) {
        expect(palette.event[String(i)]).toBeDefined();
        expect(palette.event[String(i)].background).toMatch(/^#[0-9a-f]{6}$/i);
        expect(palette.event[String(i)].foreground).toMatch(/^#[0-9a-f]{6}$/i);
      }
    });
  });

  describe('getGoogleEventColor', () => {
    it('returns color for valid colorId', () => {
      const color = getGoogleEventColor('5');
      expect(color).toBeDefined();
      expect(color?.background).toBe('#fbd75b');
    });

    it('returns undefined for undefined colorId', () => {
      expect(getGoogleEventColor(undefined)).toBeUndefined();
    });

    it('returns undefined for invalid colorId', () => {
      expect(getGoogleEventColor('99')).toBeUndefined();
    });
  });

  // REBEL-5CG / FOX-3250 regression coverage.
  //
  // Bug: Google events organised by the user, where the organiser was the
  // only "participant" but was NOT present in the attendees array (Google
  // sometimes omits the organiser when the event was created via an external
  // tool or imported from another calendar), fell through to the
  // "no attendees, no creator-self" branch and were excluded.
  //
  // Symmetric Microsoft case: organiser events with an unexpectedly missing
  // responseStatus (delegated mailboxes, imported events, group calendars)
  // could also be dropped.
  //
  // The fix checks organiser/creator FIRST in both functions, regardless of
  // attendees presence, and exits early on declined-by-organiser.
  describe('event filtering decision matrix (REBEL-5CG / FOX-3250)', () => {
    describe('googleEventToMeeting', () => {
      it('includes organizer event when organizer is NOT in attendees (REBEL-5CG bug)', () => {
        const counters = createDropReasonCounters();
        const event = {
          id: 'rebel-5cg',
          summary: 'XXX sync',
          start: { dateTime: '2026-05-06T12:30:00Z' },
          end: { dateTime: '2026-05-06T12:55:00Z' },
          organizer: { email: 'user@example.com', self: true },
          creator: { email: 'user@example.com', self: true },
          hangoutLink: 'https://meet.google.com/abc-defg-hij',
          // Crucial: no attendees array. Pre-fix this path returned null.
        };
        const meeting = googleEventToMeeting(event, 'user@example.com', undefined, counters);
        expect(meeting).not.toBeNull();
        expect(meeting?.title).toBe('XXX sync');
        expect(meeting?.meetingUrl).toBe('https://meet.google.com/abc-defg-hij');
        expect(totalDrops(counters)).toBe(0);
      });

      it('includes organizer event when self is matched by email (organizer.self flag missing)', () => {
        const counters = createDropReasonCounters();
        const event = {
          id: 'creator-by-email',
          summary: 'Email-matched organizer',
          start: { dateTime: '2026-05-06T12:30:00Z' },
          end: { dateTime: '2026-05-06T12:55:00Z' },
          // Imported event — Google didn't set self:true, but the email matches.
          creator: { email: 'USER@example.com' },
          organizer: { email: 'USER@example.com' },
        };
        const meeting = googleEventToMeeting(event, 'user@example.com', undefined, counters);
        expect(meeting).not.toBeNull();
        expect(totalDrops(counters)).toBe(0);
      });

      it('excludes declined organizer event and increments not_accepted', () => {
        const counters = createDropReasonCounters();
        const event = {
          id: 'declined-organizer',
          summary: 'Declined org',
          start: { dateTime: '2026-05-06T12:30:00Z' },
          end: { dateTime: '2026-05-06T12:55:00Z' },
          organizer: { email: 'user@example.com', self: true },
          attendees: [
            { email: 'user@example.com', self: true, responseStatus: 'declined' },
          ],
        };
        expect(googleEventToMeeting(event, 'user@example.com', undefined, counters)).toBeNull();
        expect(counters.dropped_not_accepted).toBe(1);
        expect(totalDrops(counters)).toBe(1);
      });

      it('includes organizer event when organizer is also in attendees with needsAction/tentative (organizer ownership wins)', () => {
        const counters = createDropReasonCounters();
        const event = {
          id: 'organizer-needs-action',
          summary: 'Self-organized, pending response',
          start: { dateTime: '2026-05-06T12:30:00Z' },
          end: { dateTime: '2026-05-06T12:55:00Z' },
          organizer: { email: 'user@example.com', self: true },
          creator: { email: 'user@example.com', self: true },
          attendees: [
            { email: 'user@example.com', self: true, responseStatus: 'needsAction' },
            { email: 'other@example.com', responseStatus: 'accepted' },
          ],
        };
        const meeting = googleEventToMeeting(event, 'user@example.com', undefined, counters);
        expect(meeting).not.toBeNull();
        expect(totalDrops(counters)).toBe(0);
      });

      it('preserves personal block with no attendees, no creator/organizer (e.g. all-day reminder)', () => {
        const counters = createDropReasonCounters();
        const event = {
          id: 'personal-block',
          summary: 'Focus time',
          start: { dateTime: '2026-05-06T12:30:00Z' },
          end: { dateTime: '2026-05-06T12:55:00Z' },
        };
        const meeting = googleEventToMeeting(event, 'user@example.com', undefined, counters);
        expect(meeting).not.toBeNull();
        expect(totalDrops(counters)).toBe(0);
      });

      it('excludes shared/subscribed calendar event (creator is someone else, no attendees) and increments not_creator', () => {
        const counters = createDropReasonCounters();
        const event = {
          id: 'shared',
          summary: 'Someone else block',
          start: { dateTime: '2026-05-06T12:30:00Z' },
          end: { dateTime: '2026-05-06T12:55:00Z' },
          creator: { email: 'other@example.com' },
          organizer: { email: 'other@example.com' },
        };
        expect(googleEventToMeeting(event, 'user@example.com', undefined, counters)).toBeNull();
        expect(counters.dropped_not_creator).toBe(1);
      });

      it('excludes cancelled event and increments cancelled', () => {
        const counters = createDropReasonCounters();
        const event = {
          id: 'cancelled',
          status: 'cancelled',
          start: { dateTime: '2026-05-06T12:30:00Z' },
          end: { dateTime: '2026-05-06T12:55:00Z' },
        };
        expect(googleEventToMeeting(event, 'user@example.com', undefined, counters)).toBeNull();
        expect(counters.dropped_cancelled).toBe(1);
      });

      it('excludes event where user is not in attendees list and increments not_self_attendee', () => {
        const counters = createDropReasonCounters();
        const event = {
          id: 'not-invited',
          summary: 'Other people meeting',
          start: { dateTime: '2026-05-06T12:30:00Z' },
          end: { dateTime: '2026-05-06T12:55:00Z' },
          creator: { email: 'other@example.com' },
          attendees: [
            { email: 'alice@example.com', responseStatus: 'accepted' },
            { email: 'bob@example.com', responseStatus: 'accepted' },
          ],
        };
        expect(googleEventToMeeting(event, 'user@example.com', undefined, counters)).toBeNull();
        expect(counters.dropped_not_self_attendee).toBe(1);
      });

      it('excludes event where user declined as attendee and increments not_accepted', () => {
        const counters = createDropReasonCounters();
        const event = {
          id: 'declined-attendee',
          summary: 'Invited and declined',
          start: { dateTime: '2026-05-06T12:30:00Z' },
          end: { dateTime: '2026-05-06T12:55:00Z' },
          creator: { email: 'other@example.com' },
          attendees: [
            { email: 'user@example.com', self: true, responseStatus: 'declined' },
            { email: 'other@example.com', responseStatus: 'accepted' },
          ],
        };
        expect(googleEventToMeeting(event, 'user@example.com', undefined, counters)).toBeNull();
        expect(counters.dropped_not_accepted).toBe(1);
      });

      it('aggregates multiple drops across calls', () => {
        const counters = createDropReasonCounters();
        const cancelled = { id: 'a', status: 'cancelled', start: {}, end: {} };
        const declined = {
          id: 'b',
          start: { dateTime: '2026-05-06T12:30:00Z' },
          end: { dateTime: '2026-05-06T12:55:00Z' },
          attendees: [{ email: 'user@example.com', self: true, responseStatus: 'declined' }],
        };
        googleEventToMeeting(cancelled, 'user@example.com', undefined, counters);
        googleEventToMeeting(declined, 'user@example.com', undefined, counters);
        expect(counters.dropped_cancelled).toBe(1);
        expect(counters.dropped_not_accepted).toBe(1);
        expect(totalDrops(counters)).toBe(2);
      });
    });

    describe('microsoftEventToMeeting', () => {
      it('includes organizer event when responseStatus is missing (symmetric REBEL-5CG fix)', () => {
        const counters = createDropReasonCounters();
        const event = {
          id: 'ms-organizer-no-response',
          subject: 'Imported organiser event',
          start: { dateTime: '2026-05-06T12:30:00.0000000', timeZone: 'UTC' },
          end: { dateTime: '2026-05-06T12:55:00.0000000', timeZone: 'UTC' },
          organizer: { emailAddress: { address: 'user@example.com', name: 'Me' } },
          // No responseStatus, no attendees — pre-fix this dropped to the
          // shared-calendar branch and returned null.
        };
        const meeting = microsoftEventToMeeting(event, 'user@example.com', undefined, counters);
        expect(meeting).not.toBeNull();
        expect(meeting?.title).toBe('Imported organiser event');
        expect(totalDrops(counters)).toBe(0);
      });

      it('excludes declined organizer event and increments not_accepted', () => {
        const counters = createDropReasonCounters();
        const event = {
          id: 'ms-declined-organizer',
          subject: 'Declined org',
          start: { dateTime: '2026-05-06T12:30:00.0000000', timeZone: 'UTC' },
          end: { dateTime: '2026-05-06T12:55:00.0000000', timeZone: 'UTC' },
          organizer: { emailAddress: { address: 'user@example.com' } },
          responseStatus: { response: 'declined' },
        };
        expect(microsoftEventToMeeting(event, 'user@example.com', undefined, counters)).toBeNull();
        expect(counters.dropped_not_accepted).toBe(1);
      });

      it('excludes shared calendar event with no organizer match, no responseStatus, no attendees', () => {
        const counters = createDropReasonCounters();
        const event = {
          id: 'ms-shared',
          subject: 'Someone else block',
          start: { dateTime: '2026-05-06T12:30:00.0000000', timeZone: 'UTC' },
          end: { dateTime: '2026-05-06T12:55:00.0000000', timeZone: 'UTC' },
          organizer: { emailAddress: { address: 'other@example.com' } },
        };
        expect(microsoftEventToMeeting(event, 'user@example.com', undefined, counters)).toBeNull();
        expect(counters.dropped_not_creator).toBe(1);
      });

      it('excludes cancelled event and increments cancelled', () => {
        const counters = createDropReasonCounters();
        const event = {
          id: 'ms-cancelled',
          isCancelled: true,
          start: { dateTime: '2026-05-06T12:30:00.0000000', timeZone: 'UTC' },
          end: { dateTime: '2026-05-06T12:55:00.0000000', timeZone: 'UTC' },
        };
        expect(microsoftEventToMeeting(event, 'user@example.com', undefined, counters)).toBeNull();
        expect(counters.dropped_cancelled).toBe(1);
      });

      it('excludes event where user is not the organizer, no responseStatus, and not in attendees', () => {
        const counters = createDropReasonCounters();
        const event = {
          id: 'ms-not-invited',
          subject: 'Other people meeting',
          start: { dateTime: '2026-05-06T12:30:00.0000000', timeZone: 'UTC' },
          end: { dateTime: '2026-05-06T12:55:00.0000000', timeZone: 'UTC' },
          organizer: { emailAddress: { address: 'other@example.com' } },
          attendees: [
            { emailAddress: { address: 'alice@example.com' }, status: { response: 'accepted' } },
          ],
        };
        expect(microsoftEventToMeeting(event, 'user@example.com', undefined, counters)).toBeNull();
        expect(counters.dropped_not_self_attendee).toBe(1);
      });

      it('excludes event where user declined as attendee and increments not_accepted', () => {
        const counters = createDropReasonCounters();
        const event = {
          id: 'ms-declined-attendee',
          subject: 'Invited and declined',
          start: { dateTime: '2026-05-06T12:30:00.0000000', timeZone: 'UTC' },
          end: { dateTime: '2026-05-06T12:55:00.0000000', timeZone: 'UTC' },
          organizer: { emailAddress: { address: 'other@example.com' } },
          attendees: [
            { emailAddress: { address: 'user@example.com' }, status: { response: 'declined' } },
          ],
        };
        expect(microsoftEventToMeeting(event, 'user@example.com', undefined, counters)).toBeNull();
        expect(counters.dropped_not_accepted).toBe(1);
      });
    });

    describe('counters helpers', () => {
      it('createDropReasonCounters returns all zero', () => {
        const counters = createDropReasonCounters();
        expect(counters).toEqual({
          dropped_cancelled: 0,
          dropped_not_self_attendee: 0,
          dropped_not_accepted: 0,
          dropped_not_creator: 0,
          dropped_unknown: 0,
        });
        expect(totalDrops(counters)).toBe(0);
      });

      it('totalDrops sums all counters', () => {
        const counters = {
          dropped_cancelled: 1,
          dropped_not_self_attendee: 2,
          dropped_not_accepted: 3,
          dropped_not_creator: 4,
          dropped_unknown: 5,
        };
        expect(totalDrops(counters)).toBe(15);
      });
    });
  });
});
