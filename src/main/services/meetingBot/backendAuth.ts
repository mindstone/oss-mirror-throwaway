import crypto from 'crypto';
import { createScopedLogger } from '@core/logger';
import { getRebelAuthProvider } from '@core/rebelAuth';
import {
  meetingBotBackendConfigMissingLogContext,
  resolveMeetingBotBackendConfig,
} from '@core/services/meetingBotBackendConfig';

const log = createScopedLogger({ service: 'meeting-bot' });

/**
 * Generate HMAC auth header for backend requests.
 * Format: userId:timestamp:signature
 * DO NOT CHANGE THIS FORMAT — it is hard-coded in cloud service auth middleware.
 */
export function generateBackendAuthHeader(userId: string): string | null {
  const config = resolveMeetingBotBackendConfig();
  if (!config.configured) {
    log.error(
      meetingBotBackendConfigMissingLogContext(config.missing),
      'Meeting bot backend config missing; refusing to sign backend request',
    );
    return null;
  }

  const timestamp = Date.now().toString();
  const toSign = `${userId}:${timestamp}`;
  const signature = crypto
    .createHmac('sha256', config.authKey)
    .update(toSign)
    .digest('base64');
  return `${userId}:${timestamp}:${signature}`;
}

/**
 * Convenience wrapper: get HMAC auth header using current authenticated user.
 * Returns null if not authenticated.
 */
export function getBackendAuthHeader(): string | null {
  const authState = getRebelAuthProvider().getAuthState();
  const userId = authState?.user?.id;
  if (!userId) return null;
  return generateBackendAuthHeader(userId);
}
