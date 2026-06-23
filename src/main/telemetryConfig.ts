import { getPlatformConfig } from '@core/platform';
import { getSettings } from '@core/services/settingsStore';
import type { TelemetrySettings } from '@shared/types/settings';
import { TelemetrySettingsSchema } from '@shared/ipc/schemas/settings';

/**
 * Local-only telemetry config exposed to the renderer via the preload bridge
 * (`electronEnv.telemetryConfig`), so the OSS renderer reads the USER's own
 * Sentry/RudderStack credentials instead of `runtimeConfig`/env.
 *
 * The no-phone-home invariant (B6.a / Stage 3a): this is sourced EXCLUSIVELY
 * from `settings.telemetry` (LOCAL_ONLY) and only ever populated in an OSS
 * build. In an enterprise build it is `null` — the renderer keeps reading
 * `runtimeConfig`/env exactly as before. This bridge must NEVER echo
 * `runtimeConfig`/env creds, or the no-phone-home gate would leak through it.
 */
export const getTelemetryConfigForRenderer = (): TelemetrySettings | null => {
  let isOss = false;
  try {
    isOss = getPlatformConfig().isOss;
  } catch {
    // Platform config not wired (should not happen on desktop) → treat as
    // enterprise: expose nothing, renderer falls back to its normal env path.
    return null;
  }
  if (!isOss) {
    return null;
  }
  try {
    const telemetry = getSettings().telemetry;
    if (!telemetry) {
      return null;
    }
    // Re-shape explicitly so only the known telemetry fields cross the bridge,
    // then contract-validate through the telemetry Zod schema so the bridge can
    // never echo a non-telemetry value (F3 hardening). A parse failure fails
    // closed (returns null → renderer keeps telemetry off).
    const reshaped = {
      enabled: Boolean(telemetry.enabled),
      ...(telemetry.sentryDsn ? { sentryDsn: telemetry.sentryDsn } : {}),
      ...(telemetry.rudderWriteKey ? { rudderWriteKey: telemetry.rudderWriteKey } : {}),
      ...(telemetry.rudderDataPlaneUrl ? { rudderDataPlaneUrl: telemetry.rudderDataPlaneUrl } : {})
    };
    return TelemetrySettingsSchema.nullable().parse(reshaped);
  } catch {
    return null;
  }
};
