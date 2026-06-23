import { getPlatformConfig } from '@core/platform';
import { resolveSentryDsnForBuild } from '@shared/telemetry/sentryConfig';

/**
 * Commercial-only Sentry DSN resolution for delivery to cloud-service
 * instances — the single chokepoint for every cloud delivery path (Fly
 * machine-create `config.env`, Fly secret backfill, DO/Hetzner cloud-init).
 *
 * Raw `resolveSentryDsn()` reads the runtime env (`SENTRY_DSN` /
 * `VITE_SENTRY_DSN`), so calling it from cloud sourcing would let an OSS
 * build — or a dev run with the var exported — inject a DSN into cloud
 * machines, violating the OSS no-phone-home invariant
 * (`resolveSentryDsnForBuild` in `@shared/telemetry/sentryConfig` documents
 * the resolver contract).
 *
 * - OSS build: always `undefined`. We deliberately do NOT forward the user's
 *   opt-in OSS telemetry DSN (`settings.telemetry`) — that opt-in governs the
 *   desktop client only, never instances we provision.
 * - Commercial build: `resolveSentryDsn()` as before (build-inlined in
 *   packaged builds; env in dev).
 */
export const resolveCommercialCloudSentryDsn = (): string | undefined =>
  resolveSentryDsnForBuild(getPlatformConfig().isOss);
