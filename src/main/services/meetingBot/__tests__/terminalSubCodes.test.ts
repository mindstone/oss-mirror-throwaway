import { describe, expect, it } from 'vitest';
import { isTerminalFatalSubCode } from '../meetingBotService';

describe('isTerminalFatalSubCode', () => {
  it('returns true for meeting_password_incorrect', () => {
    expect(isTerminalFatalSubCode('meeting_password_incorrect')).toBe(true);
  });

  it('returns true for meeting_ended', () => {
    expect(isTerminalFatalSubCode('meeting_ended')).toBe(true);
  });

  it('returns true for meeting_not_found', () => {
    expect(isTerminalFatalSubCode('meeting_not_found')).toBe(true);
  });

  it('returns true for recording_permission_denied', () => {
    expect(isTerminalFatalSubCode('recording_permission_denied')).toBe(true);
  });

  it('returns false for bot_errored', () => {
    expect(isTerminalFatalSubCode('bot_errored')).toBe(false);
  });

  it('returns false for failed_to_launch_in_time', () => {
    expect(isTerminalFatalSubCode('failed_to_launch_in_time')).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isTerminalFatalSubCode(undefined)).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isTerminalFatalSubCode('')).toBe(false);
  });
});
