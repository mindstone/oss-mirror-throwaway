/**
 * Stage 5 test: the in-process IPC contract round-trip driver.
 *
 * The driver has two HONESTLY-distinguished modes (Stage-5 review F1/F2):
 *  - `mode: 'executed'` (EXECUTE_SAFE allowlist) — the channel routes through the
 *    FULL real path: `sampleRequest` → driver `request.parse` → faithful
 *    `structuredClone` transport → REAL per-domain `makeDomainApi`
 *    (fake `ipcRenderer`) → transport → local `MapHandlerRegistry` dispatch →
 *    Stage-2 seam decorator → REAL handler body → transport → driver
 *    `response.parse`. This is GENUINE response-contract coverage.
 *  - `mode: 'stubbed'` (everything else, safe by construction) — the body is
 *    NEVER run and the registry is NEVER hit; a sampled response is substituted
 *    and parsed against its own schema. This proves request-valid +
 *    schema-sampleable ONLY — NOT real-response coverage.
 *
 * Coverage:
 *  - ≥3 representative EXECUTE_SAFE channels: one void-request (`inbox:load`),
 *    one object-request (`feedback:conversation-get`), one union-request
 *    (`library:stat-file`) — all `mode: 'executed'`.
 *  - The 5 cases from `ipcContractRoundTrip.integration.test.ts` reproduced
 *    through the new driver, with `structuredClone` replacing the JSON wire.
 *  - EXECUTE_SAFE spy proof: an EXECUTE_SAFE channel runs its REAL body
 *    (`executed`); a non-EXECUTE_SAFE channel is stubbed — its body is NOT
 *    invoked and the registry is never hit.
 *  - EXECUTE_SAFE allowlist is typed + runtime-validated against `allChannels`
 *    (a stale/typo key fails a test); F1: every `requestOverrides` /
 *    `UNSAMPLEABLE` key is a real current channel.
 *  - F4: the reported counts (registered cloud-safe channels, EXECUTE_SAFE ∩
 *    registered, vacuous-in-subset) are asserted so they cannot silently drift.
 *
 * ## How the fake `ipcRenderer` is wired
 * `makeDomainApi` (the REAL preload builder) binds `ipcRenderer` at module load.
 * We `vi.mock('electron')` so its `invoke` delegates to a hoisted holder that the
 * test points at `harnessInvoke` (transport → registry dispatch → transport).
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildSettings } from '@core/__tests__/builders/settingsBuilder';

// Hoisted holder so the (hoisted) vi.mock factory can reach the real
// harnessInvoke set in beforeEach.
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

import { bootRealAmbientServices, type AmbientServicesHandle } from './bootRealAmbientServices';
import {
  bootCloudSafeRegistrars,
  buildHarnessRegistrarContext,
  CLOUD_SAFE_REGISTRARS,
} from './cloudSafeRegistrars';
import { harnessInvoke, roundTrip, isVacuousResponse } from './roundTrip';
import { requestOverrides, UNSAMPLEABLE } from './requestOverrides';
import { allChannels } from '@shared/ipc/contracts';
import { EXECUTE_SAFE, isExecuteSafe } from '../../utils/registerContractHandler';

// ---------------------------------------------------------------------------
// Boot the ambient layer + cloud-safe registrars once per test (resetModules-safe)
// ---------------------------------------------------------------------------

let ambient: AmbientServicesHandle | null = null;
let workspacePath: string | null = null;

/**
 * The number of channels the 23 cloud-safe registrars register into the live
 * registry (F4 drift guard). Pinned to the measured count so a registrar
 * add/drop becomes a visible test failure; Stage 6 owns the exhaustive taxonomy.
 * 283 → 284: FU-1 S3 added the `safety-activity-log:sync-cloud` invoke channel,
 * registered by the (already cloud-safe) safety-activity-log registrar.
 * 284 → 285: Stage 8's `search:spaces-with-index` per-space prior-index probe
 * (260619_cloud-symlink-indexing), merged onto the FU-1 base on the dev catch-up.
 * 285 → 284: 260622_render-preview-cloud-hang removed the dead
 * `systemPrompt:render-preview` channel and its cloud-safe registrar (its only
 * renderer consumer was deleted 2026-03-25; handler/contract orphaned).
 */
const REGISTERED_CLOUD_SAFE_COUNT = 284;

/** Boot ambient services + cloud-safe registrars against `coreDirectory`. */
async function bootHarness(coreDirectory: string): Promise<void> {
  ambient = await bootRealAmbientServices();
  await bootCloudSafeRegistrars(buildHarnessRegistrarContext({ coreDirectory }));
  harness.invoke = harnessInvoke;
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(async () => {
  if (ambient) {
    await ambient.teardown();
    ambient = null;
  }
  if (workspacePath) {
    await rm(workspacePath, { recursive: true, force: true });
    workspacePath = null;
  }
  vi.resetModules();
});

// ---------------------------------------------------------------------------
// F1 — stale-key guard (carry-in from Stage-4 review)
// ---------------------------------------------------------------------------

describe('requestOverrides / UNSAMPLEABLE key validity (F1)', () => {
  it('every requestOverrides key is a real current channel', () => {
    for (const key of Object.keys(requestOverrides)) {
      expect(allChannels, `requestOverrides key '${key}' is not a current channel`).toHaveProperty(key);
    }
  });

  it('every UNSAMPLEABLE key is a real current channel', () => {
    for (const key of Object.keys(UNSAMPLEABLE)) {
      expect(allChannels, `UNSAMPLEABLE key '${key}' is not a current channel`).toHaveProperty(key);
    }
  });
});

// ---------------------------------------------------------------------------
// EXECUTE_SAFE allowlist validity (F1 core fix) — a stale/typo key fails here
// ---------------------------------------------------------------------------

describe('EXECUTE_SAFE allowlist key validity (F1)', () => {
  it('every EXECUTE_SAFE entry is a real current channel (fails loud on a stale/typo key)', () => {
    for (const channel of EXECUTE_SAFE) {
      expect(allChannels, `EXECUTE_SAFE entry '${channel}' is not a current channel`).toHaveProperty(channel);
    }
  });

  it('the allowlist has no duplicates', () => {
    expect(new Set(EXECUTE_SAFE).size).toBe(EXECUTE_SAFE.length);
  });
});

// ---------------------------------------------------------------------------
// 3 representative channels (void / object / union request)
// ---------------------------------------------------------------------------

describe('roundTrip — 3 representative EXECUTE_SAFE channels (mode: executed)', () => {
  it('void-request: inbox:load round-trips the REAL body through preload → transport → seam → handler', async () => {
    workspacePath = await mkdtemp(path.join(os.tmpdir(), 'rebel-rt-inbox-'));
    await bootHarness(workspacePath);

    const { mode, response } = await roundTrip('inbox:load');

    expect(mode).toBe('executed');
    // InboxStateSchema — an empty store yields a well-formed empty state.
    expect(response).toMatchObject({ items: expect.any(Array) });
  });

  it('object-request: feedback:conversation-get round-trips the REAL body', async () => {
    workspacePath = await mkdtemp(path.join(os.tmpdir(), 'rebel-rt-feedback-'));
    await bootHarness(workspacePath);

    const { mode, response } = await roundTrip('feedback:conversation-get', {
      sessionId: 'rt-session-get',
    });

    expect(mode).toBe('executed');
    expect(response).toEqual({ votes: [], dismissedAt: null });
  });

  it('union-request: library:stat-file round-trips the REAL body (string-arm of the request union)', async () => {
    workspacePath = await mkdtemp(path.join(os.tmpdir(), 'rebel-rt-library-'));
    await writeFile(path.join(workspacePath, 'fixture.txt'), 'contract harness fixture', 'utf8');
    await bootHarness(workspacePath);

    const { mode, response } = await roundTrip('library:stat-file', 'fixture.txt');

    expect(mode).toBe('executed');
    expect(response).toEqual({
      exists: true,
      mtimeMs: expect.any(Number),
      size: Buffer.byteLength('contract harness fixture'),
    });
  });
});

// ---------------------------------------------------------------------------
// Reproduce the 5 existing ipcContractRoundTrip.integration.test.ts cases
// (structuredClone wire replacing JSON)
// ---------------------------------------------------------------------------

describe('roundTrip — reproduces the 5 existing integration cases via the new driver', () => {
  it('feedback:conversation-get (case 1, executed)', async () => {
    workspacePath = await mkdtemp(path.join(os.tmpdir(), 'rebel-rt-c1-'));
    await bootHarness(workspacePath);

    const { mode, response } = await roundTrip('feedback:conversation-get', {
      sessionId: 'session-feedback-get',
    });
    expect(mode).toBe('executed');
    expect(response).toEqual({ votes: [], dismissedAt: null });
  });

  it('feedback:conversation-rate is STUBBED (write channel — body NOT run; F2 honesty)', async () => {
    workspacePath = await mkdtemp(path.join(os.tmpdir(), 'rebel-rt-c2-'));
    await bootHarness(workspacePath);

    // conversation-rate is a WRITE (appends a vote to the store + calls the
    // feedback reporter / Sentry), so it is deliberately NOT in EXECUTE_SAFE:
    // the driver stubs it (sampled response), the real side-effecting body never
    // runs. We can only assert request-validity + response-SCHEMA conformance —
    // NOT a real `voteId`/`success` (the prior denylist test over-claimed that).
    const { mode, response } = await roundTrip('feedback:conversation-rate', {
      sessionId: 'session-feedback-rate',
      rating: 4,
      comment: 'Useful answer',
      chips: ['saved-time'],
    });
    expect(mode).toBe('stubbed');
    expect(response).toMatchObject({
      success: expect.any(Boolean),
      voteId: expect.any(String),
    });
  });

  it('feedback:conversation-rate rejects a malformed request driver-side BEFORE the seam (case 3, F3)', async () => {
    workspacePath = await mkdtemp(path.join(os.tmpdir(), 'rebel-rt-c3-'));
    await bootHarness(workspacePath);

    // F3 honesty: `roundTrip()` always runs driver-side `request.parse` BEFORE
    // makeDomainApi/the transport/the seam, so a malformed request is rejected by
    // the DRIVER and never reaches the seam. (Stage 2's own tests own the real
    // seam-malformed proof — see registerContractHandler.test.ts.)
    await expect(
      roundTrip('feedback:conversation-rate', {
        sessionId: 'session-feedback-rate-malformed',
        rating: 4,
        chips: ['saved-time'],
      }),
    ).rejects.toMatchObject({
      issues: expect.arrayContaining([expect.objectContaining({ path: ['comment'] })]),
    });
  });

  it('library:stat-file existing-file branch (case 4, executed)', async () => {
    workspacePath = await mkdtemp(path.join(os.tmpdir(), 'rebel-rt-c4-'));
    await writeFile(path.join(workspacePath, 'fixture.txt'), 'contract harness fixture', 'utf8');
    await bootHarness(workspacePath);

    const { mode, response } = await roundTrip('library:stat-file', 'fixture.txt');
    expect(mode).toBe('executed');
    expect(response).toEqual({
      exists: true,
      mtimeMs: expect.any(Number),
      size: Buffer.byteLength('contract harness fixture'),
    });
  });

  it('library:stat-file missing-file null branch (case 5, executed)', async () => {
    workspacePath = await mkdtemp(path.join(os.tmpdir(), 'rebel-rt-c5-'));
    await bootHarness(workspacePath);

    const { mode, response } = await roundTrip('library:stat-file', 'missing-fixture.txt');
    expect(mode).toBe('executed');
    expect(response).toEqual({ exists: false, mtimeMs: null, size: null });
  });
});

// ---------------------------------------------------------------------------
// EXECUTE_SAFE spy proof (safe-by-construction): stub default vs allowlisted run
// ---------------------------------------------------------------------------

describe('roundTrip — EXECUTE_SAFE execute policy', () => {
  it('does NOT invoke the real registry handler for a NON-EXECUTE_SAFE side-effecting channel (stub default)', async () => {
    workspacePath = await mkdtemp(path.join(os.tmpdir(), 'rebel-rt-stub-'));
    await bootHarness(workspacePath);

    // `feedback:conversation-rate` is registered, side-effecting (a write), and
    // NOT in EXECUTE_SAFE — so the driver must stub it: a spy on the live registry
    // must observe NO dispatch for this channel, and the mode is 'stubbed'.
    const stubChannel = 'feedback:conversation-rate';
    expect(isExecuteSafe(stubChannel)).toBe(false);
    const { getHandlerRegistry } = await import('@core/handlerRegistry');
    const registry = getHandlerRegistry();
    expect(registry.listRegisteredChannels()).toContain(stubChannel);

    const dispatchSpy = vi.spyOn(registry, 'invokeWithRouting');

    const { mode } = await roundTrip(stubChannel, {
      sessionId: 'rt-stub', rating: 3, comment: 'x', chips: [],
    });

    expect(mode).toBe('stubbed');
    const calledForChannel = dispatchSpy.mock.calls.some((call) => call[0] === stubChannel);
    expect(calledForChannel, 'the side-effecting body must NOT be dispatched').toBe(false);

    dispatchSpy.mockRestore();
  });

  it('DOES invoke the real registry handler for an EXECUTE_SAFE channel (executed)', async () => {
    workspacePath = await mkdtemp(path.join(os.tmpdir(), 'rebel-rt-exec-'));
    await bootHarness(workspacePath);

    const { getHandlerRegistry } = await import('@core/handlerRegistry');
    const registry = getHandlerRegistry();
    expect(isExecuteSafe('inbox:load')).toBe(true);

    const dispatchSpy = vi.spyOn(registry, 'invokeWithRouting');
    const { mode } = await roundTrip('inbox:load');

    expect(mode).toBe('executed');
    const calledForChannel = dispatchSpy.mock.calls.some((call) => call[0] === 'inbox:load');
    expect(calledForChannel).toBe(true);

    dispatchSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Sanity: the cloud-safe table mirrors the barrel size
// ---------------------------------------------------------------------------

describe('cloud-safe registrar table', () => {
  it('mirrors the 23-registrar barrel', () => {
    expect(CLOUD_SAFE_REGISTRARS).toHaveLength(23);
    expect(new Set(CLOUD_SAFE_REGISTRARS.map((r) => r.name)).size).toBe(23);
  });

  it('boots all registrars without throwing and registers channels', async () => {
    workspacePath = await mkdtemp(path.join(os.tmpdir(), 'rebel-rt-boot-'));
    await bootHarness(workspacePath);
    const { getHandlerRegistry } = await import('@core/handlerRegistry');
    expect(getHandlerRegistry().listRegisteredChannels().length).toBeGreaterThan(0);
    // buildSettings is exercised by the context builder.
    expect(buildSettings({ coreDirectory: workspacePath, spaces: [] }).coreDirectory).toBe(workspacePath);
  });
});

// ---------------------------------------------------------------------------
// F4 — assert the reported counts so they cannot silently drift
// ---------------------------------------------------------------------------

describe('reported counts (F4)', () => {
  it('asserts registered-channel, EXECUTE_SAFE∩registered, and vacuous-in-subset counts', async () => {
    workspacePath = await mkdtemp(path.join(os.tmpdir(), 'rebel-rt-counts-'));
    await bootHarness(workspacePath);

    const { getHandlerRegistry } = await import('@core/handlerRegistry');
    const registered = getHandlerRegistry().listRegisteredChannels();
    const registeredSet = new Set(registered);

    // The cloud-safe subset registers a stable, non-trivial number of channels.
    // (Pinned to today's measured count so a registrar add/drop is visible; the
    // Stage-6 enumerator will own the exhaustive coverage taxonomy.)
    expect(registered.length).toBe(REGISTERED_CLOUD_SAFE_COUNT);

    // EXECUTE_SAFE ∩ registered — exactly the curated executed channels (3),
    // all of them actually registered by the cloud-safe subset.
    const executeSafeRegistered = EXECUTE_SAFE.filter((c) => registeredSet.has(c));
    expect(executeSafeRegistered.length).toBe(EXECUTE_SAFE.length);
    expect(executeSafeRegistered.length).toBe(3);

    // Vacuous (z.any()/z.unknown()) responses among the EXECUTE_SAFE subset: none
    // (the curated read-only getters all have concrete response schemas).
    const vacuousInSubset = EXECUTE_SAFE.filter((c) => isVacuousResponse(c));
    expect(vacuousInSubset).toEqual([]);
  });
});
