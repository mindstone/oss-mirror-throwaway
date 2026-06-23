import type { MeetingBotBackendConfigProvider } from '@core/services/meetingBotBackendConfig';

/**
 * OSS-build meeting-bot backend provider — intentionally empty.
 *
 * Operators can supply their own Worker URL + HMAC key via MEETING_BOT_* env vars.
 * Without those, backend calls fail closed before signing or sending requests.
 */
export const LIVE_MEETING_BOT_BACKEND_CONFIG_PROVIDER: MeetingBotBackendConfigProvider = {
  get(): null {
    return null;
  },
};
