import { describe, it, expect } from 'vitest';
import { mapRecallErrorToUserMessage } from '../meetingBotService';

describe('mapRecallErrorToUserMessage', () => {
  describe('sub-code specific messages', () => {
    it('maps teams_blacklisted_tenant', () => {
      const msg = mapRecallErrorToUserMessage(400, undefined, 'teams_blacklisted_tenant');
      expect(msg).toContain('Teams organization');
      expect(msg).toContain('admin settings');
    });

    it('maps meeting_requires_sign_in', () => {
      const msg = mapRecallErrorToUserMessage(400, undefined, 'meeting_requires_sign_in');
      expect(msg).toContain('sign-in');
    });

    it('maps meeting_not_accessible', () => {
      const msg = mapRecallErrorToUserMessage(400, undefined, 'meeting_not_accessible');
      expect(msg).toContain('access settings');
    });

    it('maps google_meet_bot_blocked', () => {
      const msg = mapRecallErrorToUserMessage(400, undefined, 'google_meet_bot_blocked');
      expect(msg).toContain('Google blocked');
    });

    it('maps google_meet_knocking_disabled', () => {
      const msg = mapRecallErrorToUserMessage(400, undefined, 'google_meet_knocking_disabled');
      expect(msg).toContain('knocking');
    });

    it('maps meeting_password_incorrect', () => {
      const msg = mapRecallErrorToUserMessage(400, undefined, 'meeting_password_incorrect');
      expect(msg.toLowerCase()).toMatch(/passcode|waiting room/);
    });

    it('maps meeting_ended', () => {
      const msg = mapRecallErrorToUserMessage(400, undefined, 'meeting_ended');
      expect(msg).toContain('ended');
    });

    it('maps meeting_not_found', () => {
      const msg = mapRecallErrorToUserMessage(400, undefined, 'meeting_not_found');
      expect(msg.toLowerCase()).toMatch(/invalid|expired/);
    });

    it('maps recording_permission_denied', () => {
      const msg = mapRecallErrorToUserMessage(400, undefined, 'recording_permission_denied');
      expect(msg).toContain('denied');
    });
  });

  describe('HTTP status code messages', () => {
    it('maps 507 (pool exhausted)', () => {
      const msg = mapRecallErrorToUserMessage(507);
      expect(msg).toContain('temporarily busy');
    });

    it('maps 402 (billing)', () => {
      const msg = mapRecallErrorToUserMessage(402);
      expect(msg).toContain('billing');
    });

    it('maps 429 (rate limited)', () => {
      const msg = mapRecallErrorToUserMessage(429);
      expect(msg).toContain('wait');
    });

    it('maps 401 (auth failed)', () => {
      const msg = mapRecallErrorToUserMessage(401);
      expect(msg).toContain('authentication');
    });
  });

  describe('sub-code takes precedence over status code', () => {
    it('prefers sub-code when both are present', () => {
      const msg = mapRecallErrorToUserMessage(400, 'some_code', 'teams_blacklisted_tenant');
      expect(msg).toContain('Teams organization');
    });
  });

  describe('fallback', () => {
    it('returns generic message for unknown error', () => {
      const msg = mapRecallErrorToUserMessage(500);
      expect(msg).toContain('Failed to start recording');
    });

    it('returns generic message with no arguments', () => {
      const msg = mapRecallErrorToUserMessage();
      expect(msg).toContain('Failed to start recording');
    });

    it('returns generic message for unknown sub-code', () => {
      const msg = mapRecallErrorToUserMessage(400, undefined, 'some_unknown_code');
      expect(msg).toContain('Failed to start recording');
    });
  });
});
