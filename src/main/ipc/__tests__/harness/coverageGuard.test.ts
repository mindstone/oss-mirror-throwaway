/**
 * Stage 7: fail-loud coverage guard test (anti-rot keystone).
 *
 * Boots the cloud-safe registrars (the same boot the Stage-6 harness suite uses),
 * reads the round-tripped channel set back from `listRegisteredChannels()`, and
 * asserts via `computeCoverageReport` that EVERY not-skipped `type:'invoke'`
 * channel is EITHER covered OR matched by a reasoned, category-based
 * `HARNESS_EXEMPT_DOMAINS` rule. A channel that is neither fails LOUD here.
 *
 * It also pins the exempt count (per category) so the deferred gap cannot silently
 * grow, proves the guard goes RED when a covered channel is dropped without
 * exempting it, and asserts the reused predicate is the REAL production one.
 */

import { afterAll, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  invoke: async (_channel: string, _request: unknown): Promise<unknown> => {
    throw new Error('harness.invoke not initialised');
  },
}));

vi.mock('electron', () => ({
  ipcRenderer: {
    invoke: (channel: string, request: unknown) => harness.invoke(channel, request),
    sendSync: () => {
      throw new Error('sync IPC is not modelled in the round-trip harness');
    },
  },
}));

import { allChannels } from '@shared/ipc/contracts';
import { getChannelMetadata } from '@shared/ipc/channelMetadata';
import { shouldSkipFromPresenceAssertion } from '../../handlerPresenceInvariant';

import { bootRealAmbientServices, type AmbientServicesHandle } from './bootRealAmbientServices';
import { bootCloudSafeRegistrars, buildHarnessRegistrarContext } from './cloudSafeRegistrars';
import { harnessInvoke } from './roundTrip';
import { computeCoverageReport } from './coverageGuard';
import { HARNESS_EXEMPT_DOMAINS, type HarnessExemptCategory } from './harnessExemptions';

type ChannelDefLike = { type?: string };

/**
 * Pinned current coverage numbers (Stage-7 probe, 2026-06-09). Pinning makes any
 * silent drift — a registrar added/dropped, a new uncovered domain, an exemption
 * quietly growing — a loud, named failure rather than an invisible erosion.
 */
// 608 → 609: REBEL-5D5 run added `system:heap-snapshot-capture` (dev-gated renderer
// heap-snapshot helper, sibling of `system:perf-renderer-profile`; Electron-only,
// not headless-bootable — joins desktop-native below).
// 609 → 610 / 276 → 277: `automations:provider-readiness-summary` (Stage 3a of
// 260611_provider-error-redesign — stateless credential-readiness aggregate for
// the Automations panel). Registered by the automations registrar, full Zod
// contract, harness round-trips it → covered.
// 610 → 613: 260618_recorder-install-button added 3 desktop-only meeting-bot
// invoke channels (`meeting-bot:install-recorder`, `:cancel-recorder-install`,
// `:is-recorder-installing`) for the OSS one-click recorder install. The
// `meeting-bot` domain is already desktop-native-exempt, so they join that
// category below (132 → 135); none is cloud-covered.
// 613 → 614: REBEL-696 added the `cloud:workspace-pending-update-apply` invoke
// channel (one-click "Update to newest" for a cloud-storage file edited on another
// device). It lives in the `cloud` domain, which the 23 cloud-safe registrars do
// NOT boot, so the harness round-trip cannot cover it — it joins the already-fully-
// exempt cloud-orchestration domain (58 → 59 below). It IS functionally tested via
// src/main/ipc/__tests__/cloudHandlers.pendingCloudUpdate.test.ts.
// 615 → 616: Stage 8's `search:spaces-with-index` cloud-safe invoke channel
// (260619_cloud-symlink-indexing), merged onto the dev base; it is round-trip-covered
// (covered +1 below), so exempt is unchanged.
// 616 → 615: 260622_render-preview-cloud-hang removed the dead, cloud-safe-covered
// `systemPrompt:render-preview` invoke channel (its only renderer consumer was
// deleted 2026-03-25; handler/contract orphaned). It was round-trip-covered, so
// covered −1 below and exempt is unchanged.
// 615 → 616: 260623_oss-identity-ask-lead-capture added the desktop-only
// `identity:capture-oss-lead` invoke channel (fire-and-forget Mindstone lead-capture
// egress, intentionally NOT cloud-routable — excluded from CLOUD_CHANNEL_POLICIES,
// see identityChannelCloudPolicy.test.ts). No cloud-safe registrar covers it by
// design, so the new `identity` domain is not-cloud-safe-exempt (21 → 22 below).
const EXPECTED_INVOKE_NOT_SKIPPED = 616;
// 277 → 280: FU-1 promoted `registerSafetyActivityLogHandlers` into the cloud-safe
// barrel (cloud now serves `safety-activity-log:get` for the desktop catch-up sync),
// so the safety-activity-log domain's original 3 invoke channels (get/flag/unflag)
// are now round-trip-covered rather than `not-cloud-safe`-exempt.
// 280 → 281: FU-1 S3 adds the desktop-only `safety-activity-log:sync-cloud`
// trigger channel; the same registrar covers it with a no-cloud default in the
// harness while desktop injects the real cloud sync callback.
// 281 → 282: Stage 8's `search:spaces-with-index` (cloud-safe + contract-covered).
// 282 → 281: 260622_render-preview-cloud-hang removed the dead, cloud-safe-covered
// `systemPrompt:render-preview` invoke channel (handler/contract orphaned since its
// renderer consumer was deleted 2026-03-25).
const EXPECTED_COVERED = 281;
const EXPECTED_EXEMPT = EXPECTED_INVOKE_NOT_SKIPPED - EXPECTED_COVERED; // 335
const EXPECTED_EXEMPT_BY_CATEGORY: Record<HarnessExemptCategory, number> = {
  'agent-surface': 43,
  connector: 23,
  'plugins-mcp': 53,
  // 131 → 132: `system:heap-snapshot-capture` (see header comment above).
  // 132 → 135: 3 desktop-only recorder-install meeting-bot channels
  // (260618_recorder-install-button — see header comment above).
  'desktop-native': 135,
  // 57 → 58: origin/dev added the `cloud:reattach-managed` invoke channel
  // (managed-instance re-attach recovery after a local "Forget"). It is NOT
  // registered by any of the 23 cloud-safe registrars (harness boot does not
  // cover it), so it joins the already-fully-exempt `cloud` domain rather than
  // being a real uncovered gap. The whole `cloud` domain stays cloud-orchestration-exempt.
  // 58 → 59: REBEL-696 added `cloud:workspace-pending-update-apply` (see header comment
  // above) — same fully-exempt `cloud` domain; functionally tested, not harness-covered.
  'cloud-orchestration': 59,
  // 24 → 21: FU-1 moved the original safety-activity-log domain channels
  // (get/flag/unflag) into the cloud-safe round-tripped set (see EXPECTED_COVERED note above).
  // 21 → 22: 260623_oss-identity-ask-lead-capture added the desktop-only `identity`
  // domain (`identity:capture-oss-lead` — fire-and-forget Mindstone lead-capture egress,
  // intentionally not cloud-routable; no cloud-safe registrar by design).
  'not-cloud-safe': 22,
};

// ---------------------------------------------------------------------------
// Boot ONCE; read the round-tripped (registered) invoke channels back.
// ---------------------------------------------------------------------------

let ambient: AmbientServicesHandle | null = await bootRealAmbientServices();
await bootCloudSafeRegistrars(buildHarnessRegistrarContext({ coreDirectory: '/tmp/rebel-coverage-guard' }));
harness.invoke = harnessInvoke;

const { getHandlerRegistry } = await import('@core/handlerRegistry');
const registeredChannels = [...getHandlerRegistry().listRegisteredChannels()];
const roundTrippedChannels = registeredChannels.filter((channel) => {
  const def = (allChannels as Record<string, ChannelDefLike | undefined>)[channel];
  return def?.type === 'invoke';
});

const report = computeCoverageReport({ coveredChannels: roundTrippedChannels });

afterAll(async () => {
  if (ambient) {
    await ambient.teardown();
    ambient = null;
  }
});

describe('IPC contract harness — fail-loud coverage guard', () => {
  it('classifies every not-skipped invoke channel as covered or reasoned-exempt (no SILENT gaps)', () => {
    // THE keystone assertion. If a new invoke channel is added and neither
    // covered nor on HARNESS_EXEMPT_DOMAINS, it lands here with its name + the
    // category it fell through, turning the guard RED.
    expect(
      report.uncovered,
      `uncovered, un-exempt invoke channels (each must be covered via cloudSafeRegistrars.ts OR given a reasoned HARNESS_EXEMPT_DOMAINS entry):\n${JSON.stringify(report.uncovered, null, 2)}`,
    ).toEqual([]);
  });

  it('the exemption map is internally consistent (no stale / no covered-but-exempt / clean domain partition)', () => {
    expect(report.staleExemptDomains, 'HARNESS_EXEMPT_DOMAINS keys that are not real ipcContract domains').toEqual([]);
    expect(
      report.coveredButExemptDomains,
      'domains marked exempt that are ACTUALLY covered — delete their stale HARNESS_EXEMPT_DOMAINS entry',
    ).toEqual([]);
    // The domain-keyed exemption granularity is only sound if each domain is
    // fully covered OR fully exempt — never split. If this fires, the exemption
    // map must move to a finer granularity than per-domain.
    expect(
      report.mixedDomainViolations,
      'channels whose domain is BOTH covered and exempt — domain-keyed exemptions are no longer sound',
    ).toEqual([]);
  });

  it('pins the covered / exempt counts so the deferred gap cannot silently grow', () => {
    expect(report.invokeNotSkipped.length).toBe(EXPECTED_INVOKE_NOT_SKIPPED);
    expect(report.covered.length).toBe(EXPECTED_COVERED);
    expect(report.exempt.length).toBe(EXPECTED_EXEMPT);
    // covered + exempt accounts for the WHOLE not-skipped invoke surface.
    expect(report.covered.length + report.exempt.length).toBe(report.invokeNotSkipped.length);
  });

  it('pins the exempt breakdown by reasoned category', () => {
    expect(report.exemptByCategory).toEqual(EXPECTED_EXEMPT_BY_CATEGORY);
    const total = Object.values(report.exemptByCategory).reduce((a, b) => a + b, 0);
    expect(total).toBe(report.exempt.length);
  });

  // -------------------------------------------------------------------------
  // DEFINITION-OF-DONE proofs (the guard actually bites)
  // -------------------------------------------------------------------------

  it('PROOF: dropping a covered channel from the round-trip set (without exempting it) turns the guard RED', () => {
    // `inbox:load` is a covered EXECUTE_SAFE channel in the `inbox` domain, which
    // is NOT on HARNESS_EXEMPT_DOMAINS. Removing it from the covered set with no
    // exemption must make it surface as uncovered.
    const droppedCovered = roundTrippedChannels.filter((c) => c !== 'inbox:load');
    const redReport = computeCoverageReport({ coveredChannels: droppedCovered });
    expect(redReport.uncovered.map((u) => u.channel)).toContain('inbox:load');
    expect(redReport.uncovered.find((u) => u.channel === 'inbox:load')?.domain).toBe('inbox');
  });

  it('PROOF: a hypothetical new cloud-safe channel with no coverage and no exemption is RED', () => {
    // Inject a fake invoke channel in a NON-exempt, currently-covered domain
    // (`inbox`) but DO NOT add it to the covered set → it must fail loud. (Using a
    // covered domain proves the guard is per-channel, not merely per-domain.)
    const fakeChannel = 'inbox:__hypothetical_new_channel__';
    const augmented = {
      ...(allChannels as Record<string, ChannelDefLike>),
      [fakeChannel]: { type: 'invoke' },
    };
    // The fake channel has no ipcContract domain entry, so it classifies as
    // "no domain group" — still RED (a brand-new channel must be wired into
    // ipcContract AND covered/exempted). This proves an un-grouped new channel
    // cannot slip through silently.
    const redReport = computeCoverageReport({
      coveredChannels: roundTrippedChannels,
      allChannels: augmented,
    });
    expect(redReport.uncovered.map((u) => u.channel)).toContain(fakeChannel);
  });

  it('PROOF: no-arg (void-request) covered channels are NOT whole-channel-exempt — they keep RESPONSE coverage', () => {
    // A void-request channel is exempt REQUEST-side only (vacuous request); it
    // must still be COVERED (response round-tripped), never dropped to exempt.
    // `inbox:load` is the canonical covered void-request channel. Assert it is in
    // the covered set (its response is parsed by the harness), NOT in `exempt`.
    expect(report.covered).toContain('inbox:load');
    expect(report.exempt).not.toContain('inbox:load');
    // And its declared request schema is genuinely no-arg (void/empty) — proving
    // this is the void-request case the request-side-only exemption is about.
    const def = (allChannels as Record<string, { request?: { _zod?: { def?: { type?: string } } } }>)['inbox:load'];
    const reqType = def?.request?._zod?.def?.type;
    expect(['void', 'object', 'undefined']).toContain(reqType ?? 'undefined');
  });

  it('reuses the REAL production shouldSkipFromPresenceAssertion (not a drifting duplicate)', () => {
    // The guard imports the predicate exported from handlerPresenceInvariant.ts.
    // Assert it behaves as the boot-time invariant does: a bypass channel is
    // skipped; a normal covered channel is not. (Equivalence backstop in case
    // someone re-introduces a private copy.)
    expect(shouldSkipFromPresenceAssertion(getChannelMetadata('sentry:capture-exception'))).toBe(true);
    expect(shouldSkipFromPresenceAssertion(getChannelMetadata('inbox:load'))).toBe(false);
  });

  it('every exempt domain hit is actually present in the HARNESS_EXEMPT_DOMAINS map', () => {
    for (const domain of report.exemptDomainsHit) {
      expect(HARNESS_EXEMPT_DOMAINS[domain]).toBeDefined();
    }
  });
});
