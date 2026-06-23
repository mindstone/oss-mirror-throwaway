import { describe, it, expect } from 'vitest';
import { extractMeetingId, urlsMatchSameMeeting, isWithinDedupWindow } from '../urlUtils';

describe('extractMeetingId', () => {
  describe('Zoom URLs', () => {
    it('extracts ID from standard zoom.us URL', () => {
      expect(extractMeetingId('https://zoom.us/j/1234567890')).toBe('zoom:1234567890');
    });

    it('extracts ID from regional subdomain URL', () => {
      expect(extractMeetingId('https://us02web.zoom.us/j/1234567890')).toBe('zoom:1234567890');
      expect(extractMeetingId('https://us04web.zoom.us/j/1234567890')).toBe('zoom:1234567890');
    });

    it('extracts ID from company subdomain URL', () => {
      expect(extractMeetingId('https://company.zoom.us/j/1234567890')).toBe('zoom:1234567890');
    });

    it('extracts ID from URL with password parameter', () => {
      expect(extractMeetingId('https://zoom.us/j/1234567890?pwd=secretpassword')).toBe('zoom:1234567890');
    });

    it('extracts ID from /s/ (start) URL', () => {
      expect(extractMeetingId('https://zoom.us/s/1234567890')).toBe('zoom:1234567890');
    });

    it('returns null for Zoom URL without meeting ID', () => {
      expect(extractMeetingId('https://zoom.us/profile')).toBe(null);
    });
  });

  describe('Google Meet URLs', () => {
    it('extracts code from standard Meet URL', () => {
      expect(extractMeetingId('https://meet.google.com/abc-defg-hij')).toBe('meet:abc-defg-hij');
    });

    it('extracts code ignoring authuser parameter', () => {
      expect(extractMeetingId('https://meet.google.com/abc-defg-hij?authuser=0')).toBe('meet:abc-defg-hij');
    });

    it('extracts code ignoring trailing slash', () => {
      expect(extractMeetingId('https://meet.google.com/abc-defg-hij/')).toBe('meet:abc-defg-hij');
    });

    it('returns null for Meet URL without code', () => {
      expect(extractMeetingId('https://meet.google.com/')).toBe(null);
    });
  });

  describe('Microsoft Teams URLs', () => {
    it('extracts meeting ID from meetup-join URL', () => {
      const url = 'https://teams.microsoft.com/l/meetup-join/abc123/tenant456';
      expect(extractMeetingId(url)).toBe('teams:join:abc123');
    });

    it('extracts meeting ID from teams.live.com URL', () => {
      const url = 'https://teams.live.com/meet/123456789';
      expect(extractMeetingId(url)).toBe('teams:live:123456789');
    });

    it('decodes URL-encoded meeting IDs', () => {
      const url = 'https://teams.microsoft.com/l/meetup-join/abc%40def/tenant456';
      expect(extractMeetingId(url)).toBe('teams:join:abc@def');
    });

    it('ignores query params for meetup-join URLs', () => {
      const url = 'https://teams.microsoft.com/l/meetup-join/abc123?context=foo&threadId=1&deeplinkId=2';
      expect(extractMeetingId(url)).toBe('teams:join:abc123');
    });

    it('falls back to path for non-join Teams URLs', () => {
      const url = 'https://teams.microsoft.com/some/other/path';
      expect(extractMeetingId(url)).toBe('teams:https://teams.microsoft.com/some/other/path');
    });
  });

  describe('Unknown platforms', () => {
    it('returns origin+pathname for unknown platforms', () => {
      expect(extractMeetingId('https://unknown-platform.com/meeting/123')).toBe(
        'other:https://unknown-platform.com/meeting/123'
      );
    });

    it('ignores query params for unknown platforms', () => {
      expect(extractMeetingId('https://unknown-platform.com/meeting/123?param=value')).toBe(
        'other:https://unknown-platform.com/meeting/123'
      );
    });
  });

  describe('Edge cases', () => {
    it('returns null for empty string', () => {
      expect(extractMeetingId('')).toBe(null);
    });

    it('returns null for invalid URL', () => {
      expect(extractMeetingId('not-a-url')).toBe(null);
    });

    it('returns null for null-like input', () => {
      // @ts-expect-error - Testing runtime behavior
      expect(extractMeetingId(null)).toBe(null);
      // @ts-expect-error - Testing runtime behavior
      expect(extractMeetingId(undefined)).toBe(null);
    });
  });
});

describe('urlsMatchSameMeeting', () => {
  describe('Zoom URL variations', () => {
    it('matches same meeting ID from different subdomains', () => {
      expect(
        urlsMatchSameMeeting(
          'https://us02web.zoom.us/j/1234567890',
          'https://company.zoom.us/j/1234567890'
        )
      ).toBe(true);
    });

    it('matches zoom.us vs regional subdomain', () => {
      expect(
        urlsMatchSameMeeting('https://zoom.us/j/1234567890', 'https://us04web.zoom.us/j/1234567890')
      ).toBe(true);
    });

    it('matches with/without password parameter', () => {
      expect(
        urlsMatchSameMeeting(
          'https://zoom.us/j/1234567890?pwd=secretpassword',
          'https://zoom.us/j/1234567890'
        )
      ).toBe(true);
    });

    it('matches /s/ (start) vs /j/ (join) URLs', () => {
      expect(
        urlsMatchSameMeeting('https://zoom.us/s/1234567890', 'https://zoom.us/j/1234567890')
      ).toBe(true);
    });

    it('does not match different Zoom meeting IDs', () => {
      expect(
        urlsMatchSameMeeting('https://zoom.us/j/1234567890', 'https://zoom.us/j/9876543210')
      ).toBe(false);
    });
  });

  describe('Google Meet URL variations', () => {
    it('matches same code with/without authuser', () => {
      expect(
        urlsMatchSameMeeting(
          'https://meet.google.com/abc-defg-hij',
          'https://meet.google.com/abc-defg-hij?authuser=0'
        )
      ).toBe(true);
    });

    it('matches same code with/without trailing slash', () => {
      expect(
        urlsMatchSameMeeting(
          'https://meet.google.com/abc-defg-hij',
          'https://meet.google.com/abc-defg-hij/'
        )
      ).toBe(true);
    });

    it('does not match different Meet codes', () => {
      expect(
        urlsMatchSameMeeting(
          'https://meet.google.com/abc-defg-hij',
          'https://meet.google.com/xyz-mnop-qrs'
        )
      ).toBe(false);
    });
  });

  describe('Teams URLs', () => {
    it('matches Teams URLs with different query params', () => {
      expect(
        urlsMatchSameMeeting(
          'https://teams.microsoft.com/l/meetup-join/abc123?context=foo&threadId=1',
          'https://teams.microsoft.com/l/meetup-join/abc123?context=bar&deeplinkId=2'
        )
      ).toBe(true);
    });

    it('does not match different Teams meeting IDs', () => {
      expect(
        urlsMatchSameMeeting(
          'https://teams.microsoft.com/l/meetup-join/abc123',
          'https://teams.microsoft.com/l/meetup-join/def456'
        )
      ).toBe(false);
    });

    it('matches same meetup-join URL with and without query params', () => {
      expect(
        urlsMatchSameMeeting(
          'https://teams.microsoft.com/l/meetup-join/abc123',
          'https://teams.microsoft.com/l/meetup-join/abc123?context=foo'
        )
      ).toBe(true);
    });

    it('matches same teams.live.com meeting code', () => {
      expect(
        urlsMatchSameMeeting(
          'https://teams.live.com/meet/123456789',
          'https://teams.live.com/meet/123456789'
        )
      ).toBe(true);
    });
  });

  describe('Unknown platforms', () => {
    it('matches same origin+pathname', () => {
      expect(
        urlsMatchSameMeeting(
          'https://unknown-platform.com/meeting/123',
          'https://unknown-platform.com/meeting/123'
        )
      ).toBe(true);
    });

    it('matches same path with different query params', () => {
      expect(
        urlsMatchSameMeeting(
          'https://unknown-platform.com/meeting/123?param=1',
          'https://unknown-platform.com/meeting/123?param=2'
        )
      ).toBe(true);
    });
  });

  describe('Edge cases', () => {
    it('returns false for empty URL', () => {
      expect(urlsMatchSameMeeting('', 'https://zoom.us/j/123')).toBe(false);
      expect(urlsMatchSameMeeting('https://zoom.us/j/123', '')).toBe(false);
    });

    it('returns false for invalid URL', () => {
      expect(urlsMatchSameMeeting('not-a-url', 'https://zoom.us/j/123')).toBe(false);
    });

    it('returns false when both URLs are empty', () => {
      expect(urlsMatchSameMeeting('', '')).toBe(false);
    });
  });
});

describe('isWithinDedupWindow', () => {
  const baseTime = '2026-01-12T10:00:00Z';

  it('returns true for timestamps within 2 hour window', () => {
    expect(isWithinDedupWindow(baseTime, '2026-01-12T10:30:00Z')).toBe(true);
    expect(isWithinDedupWindow(baseTime, '2026-01-12T11:00:00Z')).toBe(true);
    expect(isWithinDedupWindow(baseTime, '2026-01-12T11:59:59Z')).toBe(true);
  });

  it('returns false for timestamps outside 2 hour window', () => {
    expect(isWithinDedupWindow(baseTime, '2026-01-12T12:00:01Z')).toBe(false);
    expect(isWithinDedupWindow(baseTime, '2026-01-12T14:00:00Z')).toBe(false);
    expect(isWithinDedupWindow(baseTime, '2026-01-13T10:00:00Z')).toBe(false);
  });

  it('works with negative time difference', () => {
    expect(isWithinDedupWindow('2026-01-12T11:00:00Z', baseTime)).toBe(true);
  });

  it('returns false for invalid dates', () => {
    expect(isWithinDedupWindow('invalid', baseTime)).toBe(false);
    expect(isWithinDedupWindow(baseTime, 'invalid')).toBe(false);
  });

  it('accepts custom window size', () => {
    const oneHourMs = 60 * 60 * 1000;
    expect(isWithinDedupWindow(baseTime, '2026-01-12T10:30:00Z', oneHourMs)).toBe(true);
    expect(isWithinDedupWindow(baseTime, '2026-01-12T11:30:00Z', oneHourMs)).toBe(false);
  });
});
