import type { AppSettings } from '@shared/types';

import { createScopedLogger } from '@core/logger';
import type { AuthState } from '@shared/ipc/schemas/auth';

const log = createScopedLogger({ service: 'userProfile' });
import { getSettings, updateSettings } from '@core/services/settingsStore';
import { identifyMainUser, getOrGenerateAnonymousId } from '../analytics';
import { setSentryUser } from '../sentry';

/**
 * Set user email in Electron storage and identify in analytics (RudderStack + Sentry).
 * Email must be provided - no longer fetches from Klavis.
 * Returns the email if successfully set, null if no email provided.
 */
export async function setUserEmail(settings: AppSettings, email: string): Promise<string | null> {
  if (!email) {
    log.debug('No email provided to setUserEmail');
    return null;
  }

  // Basic email format validation
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    log.warn({ email }, 'Invalid email format provided to setUserEmail');
    return null;
  }

  const userEmail = email.toLowerCase();

  // Store in Electron settings
  updateSettings({ userEmail });
  log.info({ email: userEmail }, 'User email stored in settings');

  // Identify in RudderStack analytics
  const anonymousId = getOrGenerateAnonymousId();
  identifyMainUser({
    userId: userEmail,
    anonymousId,
    traits: { email: userEmail }
  });
  log.debug({ email: userEmail }, 'User email identified in analytics');

  // Update Sentry user for error attribution
  setSentryUser({ id: anonymousId, email: userEmail });

  return userEmail;
}

/**
 * Identify user from auth state when authentication provides an email.
 * Compares against stored email to avoid redundant identification.
 * Returns the email if identification was performed, null otherwise.
 */
export function identifyUserFromAuthState(
  state: AuthState,
  onEmailIdentified?: (email: string) => void
): void {
  if (!state.isAuthenticated || !state.user?.email) {
    return;
  }

  const currentEmail = getSettings().userEmail?.toLowerCase();
  const authEmail = state.user.email.toLowerCase();

  if (authEmail === currentEmail) {
    log.debug({ email: authEmail }, 'Auth email matches stored email, skipping identification');
    return;
  }

  log.info(
    { hadStoredEmail: Boolean(currentEmail), emailChanged: authEmail !== currentEmail },
    'Auth email differs from stored, updating analytics identity'
  );

  setUserEmail(getSettings(), state.user.email)
    .then((email) => {
      if (email) {
        onEmailIdentified?.(email);
      }
    })
    .catch((err) => {
      log.warn({ err }, 'Failed to set user email from auth state');
    });
}
