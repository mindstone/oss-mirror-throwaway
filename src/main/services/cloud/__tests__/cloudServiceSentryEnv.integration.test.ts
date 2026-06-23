import { describe, expect, it } from 'vitest';
import {
  ensureCloudServiceBuilt,
  startLocalCloudService,
} from '../../../../test-utils/cloudHarness/localCloudServiceFixture';

const TEST_TIMEOUT_MS = 180_000;

/**
 * Runtime contract pin (regression guard, not a would-have-caught test):
 * cloud-service Sentry is gated SOLELY on the SENTRY_DSN env var at module
 * load (cloud-service/src/bootstrap.ts). The desktop delivers that env via
 * Fly machine config / Fly secrets / cloud-init compose env — this test pins
 * the receiving end of that contract so it can't silently grow extra
 * conditions (e.g. a NODE_ENV gate) that would turn delivered env into a
 * silently-disabled Sentry.
 *
 * Runs the REAL built server via the local cloud harness. Lives in the
 * `.integration.` tier (excluded from fast mode, runs in the full desktop
 * suite alongside cloudWorkspaceSync.localCloud.integration.test.ts).
 */
describe('cloud-service Sentry env contract', () => {
  it(
    'boots with sentry-enabled when SENTRY_DSN is set, sentry-disabled when not',
    async () => {
      await ensureCloudServiceBuilt();

      // Well-formed fake DSN: @sentry/node accepts it and sends nothing at
      // init. Deliberately NOT *.sentry.io so the OSS leak gate never matches.
      const fakeDsn = 'https://public@example.invalid/1';

      const withDsn = await startLocalCloudService({ env: { SENTRY_DSN: fakeDsn } });
      try {
        expect(withDsn.getOutput()).toContain('"event":"sentry-enabled"');
        expect(withDsn.getOutput()).not.toContain('"event":"sentry-disabled"');
        // The DSN itself must never be logged — only its host.
        expect(withDsn.getOutput()).not.toContain(fakeDsn);
      } finally {
        await withDsn.cleanup();
      }

      // Explicit empty value: overrides any ambient SENTRY_DSN inherited from
      // the test runner's environment (bootstrap trims '' → disabled).
      const withoutDsn = await startLocalCloudService({ env: { SENTRY_DSN: '' } });
      try {
        expect(withoutDsn.getOutput()).toContain('"event":"sentry-disabled"');
        expect(withoutDsn.getOutput()).not.toContain('"event":"sentry-enabled"');
      } finally {
        await withoutDsn.cleanup();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
