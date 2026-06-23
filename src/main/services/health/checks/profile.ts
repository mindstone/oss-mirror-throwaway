/**
 * Profile Health Checks
 *
 * Checks that user profile configuration is complete.
 * Missing userFirstName breaks meeting bot speaker detection and voice triggers.
 *
 * Name resolution mirrors meetingBotService.resolveOwnerName(): settings first,
 * then auth profile. The health check should only warn when *neither* source
 * has a name, since the meeting bot falls back to auth automatically.
 */

import type { AppSettings } from '@shared/types';
import type { CheckResult } from '../types';
import { getRebelAuthProvider } from '@core/rebelAuth';

/**
 * Check that a user name is available from settings or auth profile.
 * When missing from both, the meeting bot cannot identify the owner's speech
 * in transcripts, causing voice triggers to be silently ignored.
 */
export function checkUserProfileComplete(settings: AppSettings): CheckResult {
  const fromSettings = settings.userFirstName?.trim();

  if (fromSettings) {
    return {
      id: 'userProfileComplete',
      name: 'User Profile',
      status: 'pass',
      message: `Name set: ${fromSettings}`,
      details: { userFirstName: fromSettings, source: 'settings' },
    };
  }

  const authUser = getRebelAuthProvider().getAuthState().user;
  const fromAuth = authUser?.name?.split(/\s+/)[0]?.trim();

  if (fromAuth) {
    return {
      id: 'userProfileComplete',
      name: 'User Profile',
      status: 'pass',
      message: `Name resolved from account profile: ${fromAuth}`,
      details: { userFirstName: fromAuth, source: 'auth-profile' },
    };
  }

  return {
    id: 'userProfileComplete',
    name: 'User Profile',
    status: 'warn',
    message: 'Your name is not set — meeting bot voice triggers will not work',
    details: {
      userFirstName: settings.userFirstName,
      meetingBotEnabled: settings.meetingBot?.enabled ?? false,
    },
    remediation: 'Go to Settings → Account and enter your name. This is needed for the meeting bot to recognise your voice in transcripts.',
  };
}
