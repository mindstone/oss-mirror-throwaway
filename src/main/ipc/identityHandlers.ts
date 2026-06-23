/**
 * Identity Domain IPC Handlers — OSS lead-capture egress.
 *
 * Receives the user-typed identity (name + email) from the renderer's optional
 * "About you" onboarding block and fires a best-effort, fire-and-forget POST to
 * Mindstone's `POST /api/oss/lead`.
 *
 * Two load-bearing properties:
 * 1. FIRE-AND-FORGET: the handler validates + returns IMMEDIATELY; the actual
 *    fetch is detached (not awaited before the IPC response resolves), so a
 *    hung/slow/failing endpoint can never block, delay, or fail onboarding.
 * 2. NO TRUSTED METADATA FROM RENDERER: `appVersion`/`platform` are sourced
 *    HERE via getPlatformConfig(), not from the renderer payload — keeping core
 *    electron-free and the payload trust-free.
 */

import type { HandlerInvokeEvent } from '@core/handlerRegistry';
import { createScopedLogger } from '@core/logger';
import { getPlatformConfig } from '@core/platform';
import { MINDSTONE_API_URL } from '@core/services/mindstoneApiUrl';
import { postOssLeadCapture } from '@core/services/identity/leadCapture';
import { identityChannels } from '@shared/ipc/channels/identity';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';
import { registerHandler } from './utils/registerHandler';

const log = createScopedLogger({ ipc: 'identity' });

export function registerIdentityHandlers(): void {
  const channel = identityChannels['identity:capture-oss-lead'];
  registerHandler(channel.channel, (_event: HandlerInvokeEvent, request: unknown) => {
    const { firstName, email } = channel.request.parse(request);

    // The endpoint requires an email; skip name-only submissions entirely.
    if (!email) {
      return;
    }

    let appVersion = 'unknown';
    let platform: string = process.platform;
    let isOss = false;
    try {
      const platformConfig = getPlatformConfig();
      appVersion = platformConfig.version;
      platform = platformConfig.platform;
      isOss = platformConfig.isOss;
    } catch (error) {
      // PlatformConfig not initialised (shouldn't happen in main, but stay
      // best-effort): fall back to process-level metadata, and fail CLOSED on
      // the OSS gate below (isOss stays false) so we never egress when we can't
      // confirm this is the OSS build. Non-fatal, but observable.
      ignoreBestEffortCleanup(error, {
        operation: 'identity.captureOssLead.platformConfigLookup',
        reason: 'platform-config-unavailable-fail-closed-on-oss-gate',
      });
    }

    // DEFENSE-IN-DEPTH (F4): lead-capture egress is OSS-only. The renderer path
    // is already OSS-gated, but `identityApi` + this handler exist in every
    // build, so a direct renderer call in a commercial build could otherwise
    // reach the lead POST. Gate at the egress boundary too: no-op unless OSS.
    if (!isOss) {
      log.debug('OSS lead-capture skipped: not an OSS build (egress no-op)');
      return;
    }

    // Detached: fire-and-forget. We do NOT await this before returning the IPC
    // response. postOssLeadCapture never throws, but guard the detached promise
    // defensively so an unexpected rejection can't surface as an unhandled
    // rejection.
    void postOssLeadCapture(
      { firstName, email, appVersion, platform },
      { apiUrl: MINDSTONE_API_URL, log },
    ).catch((error: unknown) => {
      log.warn(
        { err: error instanceof Error ? error.name : 'unknown' },
        'OSS lead-capture egress rejected unexpectedly (best-effort; onboarding unaffected)',
      );
    });

    // Return immediately. Response is void.
  });

  log.info('Identity IPC handlers registered');
}
