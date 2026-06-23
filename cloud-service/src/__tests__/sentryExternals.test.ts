import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

/**
 * Pins the load-bearing externalization of '@sentry/node' in the cloud bundle.
 *
 * The cloud build (cloud-service/build.mjs) externalizes '@sentry/node' via
 * runtimeExternals.json so the real Sentry SDK loads at runtime (capture, init,
 * scope, makeNodeTransport). If someone bundles it instead — or the offline
 * transport added in 260621 silently regresses — real Sentry breaks. '@sentry/core'
 * is intentionally NOT externalized (it is bundled for real to provide the
 * offline transport's makeOfflineTransport/serializeEnvelope/parseEnvelope);
 * only '@sentry/electron*' are shimmed to no-ops in build.mjs.
 *
 * See docs/plans/260621_cloud-sentry-shim-offline-transport/PLAN.md.
 */
describe('cloud-service Sentry externals', () => {
  const runtimeExternals: string[] = createRequire(import.meta.url)('../../runtimeExternals.json');

  it("externalizes '@sentry/node' (its real SDK must load at runtime)", () => {
    expect(runtimeExternals).toContain('@sentry/node');
  });

  it("does NOT externalize '@sentry/core' (it is bundled for real transport primitives)", () => {
    expect(runtimeExternals).not.toContain('@sentry/core');
  });
});
