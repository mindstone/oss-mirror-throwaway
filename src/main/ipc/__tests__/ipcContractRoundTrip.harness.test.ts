/**
 * Stage 6: enumerate-and-assert the cloud-safe IPC channel subset through the
 * round-trip harness.
 *
 * ## What this suite does (honest, data-driven, non-vacuous)
 * 1. Boots `bootRealAmbientServices()` + the 23 cloud-safe registrars ONCE, then
 *    reads the **actually-registered** channels back from
 *    `registry.listRegisteredChannels()` — NOT a domain-group guess (the
 *    completeness-F4 fix). Filters to `type: 'invoke'` via `allChannels`.
 * 2. Runs `roundTrip(channel)` per channel via **`it.each`** — one named case per
 *    channel, so a single channel's contract drift fails in ISOLATION with a
 *    clear name (`feedback:conversation-rate`), not a buried loop assertion.
 * 3. Reports + asserts the honest **executed vs stubbed** split (Stage-5 labeling):
 *    - `executed` (on `EXECUTE_SAFE`) — the REAL handler body ran and its REAL
 *      response was parsed against the contract = GENUINE response coverage.
 *    - `stubbed` (everything else, safe by construction) — request is sampled +
 *      `request.parse`d (request-sampleability proof) and a sampled response is
 *      parsed against its own schema (schema-sampleability only; NOT real-response
 *      coverage — the body never ran).
 * 4. **Non-vacuity guard:** asserts the generated `it.each` case count EQUALS the
 *    post-boot registered invoke-channel count. An empty / over-filtered table
 *    that would pass vacuously fails this assertion loudly.
 *
 * ## Honest numbers (Stage-9 input — see the dynamic `console.info` banner below)
 * The suite prints, on every run, the real fractions:
 *   total registered cloud-safe invoke channels / # executed (real
 *   response-verified) / # stubbed (request-sampleable only) /
 *   # routed via requestOverrides / # UNSAMPLEABLE-exempt / # vacuous-response.
 * These feed Stage-9's covered-fraction without over-claiming.
 *
 * ## Tiering (DoD) — FAST pre-push tier
 * Filename is `.harness.test.ts` (NOT `.integration.test.ts`) on PURPOSE: fast
 * mode (`VITEST_FAST=1`) excludes the `integration` test glob (vitest.config.ts
 * :201) but KEEPS `src/` `.harness.test.ts` files in the `desktop` project. So
 * this suite runs in the always-on fast tier. The wall-time is recorded in the
 * Stage-6 report; the single-shared-boot design keeps it well inside the pre-push
 * budget (one boot, N cheap in-process dispatches — not N boots).
 *
 * ## Single-boot design (perf) — NO per-case `vi.resetModules()`
 * Unlike the Stage-5 `roundTrip.test.ts` (which resets per `it` because each `it`
 * boots fresh), this suite boots ONCE at module top-level (vitest awaits the
 * module) and tears down once in `afterAll`. Resetting modules per case would (a)
 * drop the booted registry and (b) cost 280× the boot. The driver's `harnessInvoke`
 * resolves the registry by DYNAMIC import each call, so it correctly lands on the
 * single live graph this boot installed (Stage-3 graph-fork note).
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

// Hoisted holder so the (hoisted) vi.mock factory can reach the real
// harnessInvoke once it is wired after boot (same pattern as roundTrip.test.ts).
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
import { EXECUTE_SAFE, isExecuteSafe } from '../utils/registerContractHandler';

import { bootRealAmbientServices, type AmbientServicesHandle } from './harness/bootRealAmbientServices';
import { bootCloudSafeRegistrars, buildHarnessRegistrarContext } from './harness/cloudSafeRegistrars';
import { harnessInvoke, roundTrip, isVacuousResponse } from './harness/roundTrip';
import { requestOverrides, UNSAMPLEABLE } from './harness/requestOverrides';
import { sampleRequest } from './harness/sampleRequest';

type ChannelDefLike = {
  type: 'invoke' | 'sync';
  request: { parse: (v: unknown) => unknown };
  response: { parse: (v: unknown) => unknown };
};

/**
 * Expected post-boot registered invoke-channel count for the cloud-safe registrars.
 * Pinned (matches `REGISTERED_CLOUD_SAFE_COUNT`) so a registrar add/drop — or a filter
 * regression that silently empties the table — becomes a loud, named failure. These
 * are ALL invoke channels (the cloud-safe registrars register no sync channels), so
 * the invoke-filtered count equals it.
 * 280 → 281: Stage 8's `search:spaces-with-index` per-space prior-index probe
 * (260619_cloud-symlink-indexing). 281 → 285 on the dev merge: FU-1 promoted the
 * safety-activity-log registrar into the cloud-safe barrel (its
 * `:get`/`:flag`/`:unflag`/`:sync-cloud` invoke channels register).
 * 285 → 284: 260622_render-preview-cloud-hang removed the dead, cloud-safe
 * `systemPrompt:render-preview` invoke channel + its registrar (orphaned since
 * its renderer consumer was deleted 2026-03-25).
 */
const EXPECTED_REGISTERED_INVOKE_COUNT = 284;

// ---------------------------------------------------------------------------
// Boot ONCE at module top-level (vitest awaits the test module), enumerate the
// actually-registered invoke channels, and wire the fake ipcRenderer. A single
// shared temp workspace backs the executed read channels (e.g. library:stat-file).
// ---------------------------------------------------------------------------

const workspacePath = await mkdtemp(path.join(os.tmpdir(), 'rebel-rt-harness-'));
// A small on-disk fixture so EXECUTE_SAFE read channels resolving a path find
// something deterministic if they sample an existing-file arm.
await writeFile(path.join(workspacePath, 'fixture.txt'), 'contract harness fixture', 'utf8');

let ambient: AmbientServicesHandle | null = await bootRealAmbientServices();
await bootCloudSafeRegistrars(buildHarnessRegistrarContext({ coreDirectory: workspacePath }));
harness.invoke = harnessInvoke;

const { getHandlerRegistry } = await import('@core/handlerRegistry');
const registeredChannels = [...getHandlerRegistry().listRegisteredChannels()];

/** The registered channels that are `type: 'invoke'` per `allChannels`. */
const registeredInvokeChannels = registeredChannels.filter((channel) => {
  const def = (allChannels as Record<string, ChannelDefLike | undefined>)[channel];
  return def?.type === 'invoke';
});

// ---------------------------------------------------------------------------
// Honest accounting (computed BEFORE the round-trips so the banner is the plan,
// and the per-channel cases prove it). A "stubbed" channel whose request comes
// from the sampler vs a curated override vs UNSAMPLEABLE is tracked for Stage 9.
// ---------------------------------------------------------------------------

const executedChannels = registeredInvokeChannels.filter((c) => isExecuteSafe(c));

/**
 * Curated requests for EXECUTE_SAFE channels whose REAL body applies runtime
 * validation BEYOND the request schema (so a bounded-sampler min value — e.g. the
 * empty-string arm of `library:stat-file`'s `string | object` union — is
 * schema-valid but body-rejected). These point at the on-disk `workspacePath`
 * fixture so the executed body returns a real, contract-valid response.
 *
 * Only executed (real-body) channels can need this; stubbed channels never run a
 * body. Keep it tiny — it tracks `EXECUTE_SAFE`, the curated read-only allowlist.
 */
const executedRequestOverrides: Record<string, unknown> = {
  // `string`-arm of the request union, pointing at the fixture written below.
  'library:stat-file': 'fixture.txt',
};
const stubbedChannels = registeredInvokeChannels.filter((c) => !isExecuteSafe(c));
// STUBBED-request overrides: curated requests from the shared, Stage-4-owned
// `requestOverrides` map, used INSTEAD of the bounded sampler to drive a stubbed
// channel (the body never runs). Measured 0 for this cloud-safe subset.
const stubbedRequestOverriddenChannels = registeredInvokeChannels.filter(
  (c) => !isExecuteSafe(c) && c in requestOverrides,
);
// EXECUTED body-only overrides: harness-local `executedRequestOverrides` that feed
// an EXECUTE_SAFE channel whose REAL body applies validation beyond the request
// schema (e.g. `library:stat-file` → an on-disk fixture). These are NOT
// bounded-sampler requests, so they must be accounted for separately — reporting
// "0 overrides" would falsely imply all 280 requests came from the sampler (F1).
const executedBodyOverriddenChannels = registeredInvokeChannels.filter(
  (c) => isExecuteSafe(c) && c in executedRequestOverrides,
);
const unsampleableChannels = registeredInvokeChannels.filter((c) => c in UNSAMPLEABLE);
const vacuousResponseChannels = registeredInvokeChannels.filter((c) => isVacuousResponse(c));

// Channels the bounded sampler cannot auto-produce a request for AND which are not
// covered by a curated override or an UNSAMPLEABLE exemption — these would make a
// per-channel case throw at sample time. Computed here so the banner is honest
// (and so the count assertions below can subtract a documented, reviewed set if
// one ever appears). Measured: 0 for the current cloud-safe subset.
const unsampleableAtRuntime = stubbedChannels.filter((channel) => {
  if (channel in requestOverrides || channel in UNSAMPLEABLE) return false;
  const def = (allChannels as Record<string, ChannelDefLike>)[channel];
  try {
    sampleRequest(def.request as Parameters<typeof sampleRequest>[0]);
    return false;
  } catch {
    return true;
  }
});

// eslint-disable-next-line no-console
console.info(
  [
    '',
    '── Stage 6: cloud-safe IPC channel round-trip coverage (HONEST numbers) ──',
    `  registered cloud-safe invoke channels : ${registeredInvokeChannels.length}`,
    `  executed (REAL response-verified)      : ${executedChannels.length}  ${JSON.stringify(executedChannels)}`,
    `    └─ via executed body-only overrides  : ${executedBodyOverriddenChannels.length}  ${JSON.stringify(executedBodyOverriddenChannels)}`,
    `  stubbed  (request-sampleable only)     : ${stubbedChannels.length}`,
    `    ├─ via stubbed-request overrides     : ${stubbedRequestOverriddenChannels.length}  ${JSON.stringify(stubbedRequestOverriddenChannels)}`,
    `    └─ via bounded sampler               : ${stubbedChannels.length - stubbedRequestOverriddenChannels.length - unsampleableChannels.length}`,
    `  UNSAMPLEABLE-exempt (no request)       : ${unsampleableChannels.length}`,
    `  vacuous response (z.any()/z.unknown()) : ${vacuousResponseChannels.length}`,
    `  sampler-unsatisfiable & un-exempt      : ${unsampleableAtRuntime.length}  ${JSON.stringify(unsampleableAtRuntime)}`,
    '───────────────────────────────────────────────────────────────────────────',
    '',
  ].join('\n'),
);

afterAll(async () => {
  if (ambient) {
    await ambient.teardown();
    ambient = null;
  }
  await rm(workspacePath, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// NON-VACUITY GUARD: the generated case count == post-boot registered invoke count
// ---------------------------------------------------------------------------

describe('cloud-safe round-trip enumeration — non-vacuity', () => {
  it('boots a non-trivial registered invoke set (the it.each table is not empty)', () => {
    expect(registeredInvokeChannels.length).toBeGreaterThan(0);
    expect(registeredInvokeChannels.length).toBe(EXPECTED_REGISTERED_INVOKE_COUNT);
  });

  it('the it.each case count equals the post-boot registered invoke-channel count', () => {
    // `registeredInvokeChannels` is the EXACT array `it.each` iterates below, so
    // its length IS the generated case count. Asserting it == the registered
    // count (and pinning that count above) makes an empty/over-filtered table —
    // which would pass vacuously — a loud failure.
    expect(registeredInvokeChannels.length).toBe(registeredChannels.length);
    expect(executedChannels.length + stubbedChannels.length).toBe(registeredInvokeChannels.length);
  });

  it('every registered cloud-safe invoke channel can produce a contract-valid request (no silent un-sampleable skips)', () => {
    expect(unsampleableAtRuntime).toEqual([]);
  });

  it('reports a stable executed/stubbed split (cannot silently drift)', () => {
    // The executed set is exactly EXECUTE_SAFE ∩ registered (the 3 curated
    // read-only channels); pinning it keeps the genuine-coverage number honest.
    expect(executedChannels.length).toBe(EXECUTE_SAFE.filter((c) => registeredChannels.includes(c)).length);
    expect(executedChannels.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// One named case per registered cloud-safe invoke channel.
// ---------------------------------------------------------------------------

describe('cloud-safe round-trip — one case per registered invoke channel', () => {
  it.each(registeredInvokeChannels)('%s round-trips through the contract harness', async (channel) => {
    const def = (allChannels as Record<string, ChannelDefLike>)[channel];
    const expectedMode = isExecuteSafe(channel) ? 'executed' : 'stubbed';

    const { mode, response } = await roundTrip(channel, executedRequestOverrides[channel]);

    // The honest mode label must match the allowlist by construction.
    expect(mode).toBe(expectedMode);

    // Both modes end with a driver-side `response.parse` (asserted inside
    // roundTrip). For an EXECUTED channel that parse is against the REAL handler
    // output (genuine coverage); for a STUBBED channel it is against a sampled
    // response. Re-parse here so a per-channel failure is attributed to THIS
    // channel's `it.each` case (and not swallowed). A vacuous (z.any/z.unknown)
    // response asserts nothing on purpose — recorded in the banner, not faked.
    expect(() => def.response.parse(response)).not.toThrow();
  });
});
