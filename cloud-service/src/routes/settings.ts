/**
 * Settings route handlers.
 */

import http from 'node:http';
import { readBody, sendJson, sendRouteError, RouteError } from '../httpUtils';
import { stripLocalSettings, stripSensitiveSettingsForClient } from '@shared/cloudSettingsPolicy';
import { mergeIncomingProfilesPreservingLearned } from '@shared/utils/learnedLimitsMergeGuard';
import type { AppSettings } from '@shared/types';
import type { CloudServiceDeps } from '../bootstrap';
import {
  consumeSettingsDriftEmissionDecision,
  createSettingsDriftEmissionCache,
  detectSettingsDrift,
} from '@core/services/diagnostics/settingsDriftDetector';
import { appendDiagnosticEvent } from '@core/services/diagnosticEventsLedger';
import { getErrorReporter } from '@core/errorReporter';

const cloudSettingsDriftEmissionCache = createSettingsDriftEmissionCache();
const hasOwn = (value: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

export async function handleSettings(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: CloudServiceDeps,
): Promise<void> {
  if (req.method === 'GET') {
    const settings = deps.getSettings() as Record<string, unknown>;
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (url.searchParams.has('strip-secrets')) {
      return sendJson(res, 200, stripSensitiveSettingsForClient(settings));
    }
    return sendJson(res, 200, settings);
  }
  if (req.method === 'PUT' || req.method === 'PATCH') {
    const body = await readBody(req) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') return sendRouteError(res, undefined, new RouteError('INVALID_BODY', { status: 400, message: 'Body must be a JSON object' }));
    if (hasOwn(body, 'coreDirectory')) {
      return sendRouteError(
        res,
        undefined,
        new RouteError('INVALID_BODY', {
          status: 400,
          message: 'coreDirectory is server-managed on cloud and cannot be updated via /api/settings.',
        }),
      );
    }

    const inboundPayload = stripLocalSettings(body) as Partial<AppSettings>;

    const local = deps.getSettings();

    try {
      const drifts = detectSettingsDrift(local, { ...local, ...inboundPayload } as AppSettings);
      const emission = consumeSettingsDriftEmissionDecision(drifts, cloudSettingsDriftEmissionCache);
      if (emission.shouldEmit) {
        for (const drift of emission.observations) {
          appendDiagnosticEvent({
            kind: 'settings_drift_observation',
            data: {
              ...drift,
              eventState: emission.eventState,
              surfaceA: 'cloud',
              surfaceB: 'desktop',
            },
          });
        }
      }
    } catch (err) {
      getErrorReporter().captureException(err instanceof Error ? err : new Error(String(err)), {
        tags: { area: 'settings_drift_detection', surface: 'cloud' },
      });
    }

    // Stage 2: preserve locally-recorded auto-learned context windows from
    // stale inbound cloud-sync writes. Only meaningful when the incoming
    // payload carries `localModel.profiles` (most settings updates do not).
    let payload: Partial<AppSettings> = inboundPayload;
    if (payload.localModel?.profiles) {
      const merged = mergeIncomingProfilesPreservingLearned(
        local,
        { ...local, ...payload } as AppSettings,
      );
      payload = { ...payload, localModel: merged.localModel };
    }

    deps.updateSettings(payload);

    // Stage 3 review fix: the cloud settings store has no change-event seam, so
    // this inbound dual-write chokepoint is how a freshly-synced owner email
    // flips analytics from anon-only → identified without a restart. Idempotent
    // on the same email; best-effort so an identity hiccup never fails the write.
    try {
      deps.refreshAnalyticsIdentity();
    } catch (err) {
      getErrorReporter().captureException(err instanceof Error ? err : new Error(String(err)), {
        tags: { area: 'cloud_analytics_identity_refresh', surface: 'cloud' },
      });
    }

    return sendJson(res, 200, deps.getSettings());
  }
  return sendRouteError(res, undefined, new RouteError('METHOD_NOT_ALLOWED', { status: 405, message: `${req.method} not allowed` }));
}
