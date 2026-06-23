import type { PrivateMindstoneBootstrapMode } from '@core/services/privateMindstoneBootstrap';

/**
 * Pure build-mode signal for the OSS (stub) build.
 *
 * SOURCE OF TRUTH for `PlatformConfig.isOss` on the main process and the
 * direct read in `ensureAppIdentity` (which runs before electron-store).
 *
 * INVARIANT: this module MUST stay pure — ZERO imports of `@main/*`, stores,
 * logger, auth, IPC handlers, or anything that constructs `electron-store`.
 * The only allowed import is the type-only `PrivateMindstoneBootstrapMode`
 * from `@core/services/privateMindstoneBootstrap`. See
 * docs/plans/260607_oss-b6-launch-polish/PLAN.md Stage 1 + the arbitrator
 * report (260607_231045_arbitrator-claude-opus-4-8.md, decision A).
 */
export const PRIVATE_MINDSTONE_BOOTSTRAP_MODE: PrivateMindstoneBootstrapMode = 'stub';
