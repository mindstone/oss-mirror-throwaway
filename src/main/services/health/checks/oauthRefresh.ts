/**
 * OAuth Refresh Health Check
 *
 * Reports on OAuth refresh-failure state. Returns `warn` when any provider
 * has flipped to `needsReconnect` via the failure store's invalid-grant
 * streak threshold; populates a privacy-filtered list of connector base
 * names for the HelpMenu glow + deep-link path.
 */

import type { CheckResult } from '../types';
import { listNeedsReconnectProviders } from '../../oauthRefreshFailureStore';
import {
  defineSafeCheckDetails,
  OAUTH_REFRESH_PROVIDER_BASE_NAMES,
  safeClosedSetArray,
} from '@core/services/health/safeCheckDetails';

// TODO consolidate this and the calendar check's table once a third caller
// needs it (signposted to keep the modules independent for now).
const DISPLAY_NAMES: Record<string, string> = {
  GoogleWorkspace: 'Google Workspace',
  Microsoft365Calendar: 'Microsoft 365 Calendar',
  Microsoft365Mail: 'Microsoft 365 Mail',
};

function friendlyProviderName(baseName: string): string {
  return DISPLAY_NAMES[baseName] ?? baseName;
}

export function checkOauthRefreshHealth(): CheckResult {
  const result = listNeedsReconnectProviders();

  if (!result.ok) {
    return {
      id: 'oauthRefreshHealth',
      name: 'Account Sign-in',
      status: 'skip',
      message: 'Could not read OAuth refresh state',
      details: { reason: result.reason },
    };
  }

  if (result.providers.length === 0) {
    return {
      id: 'oauthRefreshHealth',
      name: 'Account Sign-in',
      status: 'pass',
      message: 'All accounts signed in',
    };
  }

  const baseNames = result.providers.map((p) => p.providerBaseName);
  const friendlyNames = baseNames.map(friendlyProviderName);
  const isSingle = result.providers.length === 1;

  return {
    id: 'oauthRefreshHealth',
    name: isSingle ? `${friendlyNames[0]} sign-in` : 'Sign-ins',
    status: 'warn',
    message: isSingle
      ? `${friendlyNames[0]} needs reconnecting`
      : `${friendlyNames.length} accounts need reconnecting: ${friendlyNames.join(', ')}`,
    remediation: 'Your sign-in expired. Reconnect it to get back in sync.',
    details: {
      ...defineSafeCheckDetails('oauthRefreshHealth', {
        connectorServerNames: safeClosedSetArray(
          OAUTH_REFRESH_PROVIDER_BASE_NAMES,
          baseNames,
          'unknown',
        ),
        providerCount: result.providers.length,
      }),
    },
  };
}
