/**
 * API Cooldown Health Check
 *
 * Reports on the API rate-limit cooldown state. When the cooldown singleton
 * has ≥30s remaining at poll time, this check warns so the HelpMenu glow
 * contributes for persistent-cooldown cases. The event-driven toast for the
 * cooldown_enter impact moment is handled separately by the cooldown bridge.
 */

import { createScopedLogger } from '@core/logger';
import { apiRateLimitCooldown } from '@core/services/apiRateLimitCooldown';
import type { CheckResult } from '../types';
import {
  API_COOLDOWN_SCOPES,
  defineSafeCheckDetails,
  safeClosedSet,
} from '../safeCheckDetails';

const log = createScopedLogger({ service: 'apiCooldownHealth' });
const WARN_THRESHOLD_MS = 30_000;

let lastReportedState: 'pass' | 'warn' = 'pass';

export function checkApiCooldownHealth(): CheckResult {
  const remainingMs = apiRateLimitCooldown.remainingMs();

  if (remainingMs < WARN_THRESHOLD_MS) {
    if (lastReportedState === 'warn') {
      log.info({ engaged: false, remainingMs, scope: 'api' }, 'apiCooldownHealth threshold');
      lastReportedState = 'pass';
    }

    return {
      id: 'apiCooldownHealth',
      name: 'API Cooldown',
      status: 'pass',
      message: 'API rate-limit cooldown inactive.',
      details: defineSafeCheckDetails('apiCooldownHealth', {
        scope: safeClosedSet(API_COOLDOWN_SCOPES, 'api', 'api'),
        remainingMs,
      }),
    };
  }

  if (lastReportedState === 'pass') {
    log.info({ engaged: true, remainingMs, scope: 'api' }, 'apiCooldownHealth threshold');
    lastReportedState = 'warn';
  }

  return {
    id: 'apiCooldownHealth',
    name: 'API Cooldown',
    status: 'warn',
    message: 'API rate-limit cooldown active.',
    remediation: 'Rebel is briefly paused to respect a rate limit. New turns will resume automatically.',
    details: defineSafeCheckDetails('apiCooldownHealth', {
      scope: safeClosedSet(API_COOLDOWN_SCOPES, 'api', 'api'),
      remainingMs,
    }),
  };
}
