/**
 * Stage 8 — permanent, postmortem-anchored contract-drift regression test.
 *
 * ## What this pins (the NEW, non-circular value)
 * This reconstructs the REAL escaped bug `260405_memory_approval_ipc_crash`
 * (see `docs-private/postmortems/260405_memory_approval_ipc_crash_postmortem.md`)
 * as an **invoke-channel** scenario and proves the Stage-2 contract-parse seam
 * (`registerContractHandler.ts`) catches that exact class of drift by
 * construction.
 *
 * The 260405 bug was a verified `design_gap` / `incomplete_implementation`:
 * a **flat persisted approval payload was dispatched through a channel whose
 * consumer expected a nested-destination shape** — "two shape contracts for the
 * same logical event". Its augmentation records `would_have_caught_by:
 * [contract_test, integration_test, cross_surface_contract_test]`, i.e. exactly
 * the runtime-seam contract assertion this harness installs.
 *
 * ## HONEST scope caveat (do NOT over-claim — Stage-8 / Stage-9)
 * The real 260405 bug fired on a cloud-catch-up **broadcast/event-dispatch**
 * path (renderer consumer `usePendingApprovals.ts`), which is structurally the
 * *event-channel* analog of this drift class. The harness/seam as built covers
 * the **invoke** analog of the same flat-vs-nested shape drift (a request
 * payload crossing the `registerHandler` chokepoint). The **broadcast analog is
 * the explicitly-deferred gap** (Stage 7 exemption + Stage 9 write-up). So this
 * test reconstructs the *invoke-channel form* of the 260405 drift; it does not
 * claim to cover the broadcast path that actually crashed in production.
 *
 * ## Why a clearly-labelled SYNTHETIC channel (not a live one)
 * No current live invoke channel declares a nested-destination *request* shape
 * (the real memory/staging channels take a flat `{ id }` request; the nested
 * destination lived in the persisted/dispatched approval payload). To reproduce
 * the precise flat-vs-nested drift faithfully — without editing the live
 * contract registry — we register a synthetic channel that mirrors the 260405
 * approval shapes and drive it through the REAL seam helper
 * (`wrapHandlerWithContractParse`) and the REAL `allChannels` lookup (mocked to
 * include the synthetic entry alongside the genuine contracts). The mechanism
 * under test is production code; only the channel definition is a labelled
 * fixture.
 */

import { ZodError } from 'zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// --- The synthetic 260405-shaped channel -----------------------------------
//
// The logical event: "a memory-write approval for a destination space/path".
//
// NESTED-destination shape (what the channel CONTRACT declares — the shape the
// renderer consumer in the real bug expected):
//   { approvalId, destination: { space, path } }
//
// FLAT-destination shape (the persisted payload that was dispatched in 260405 —
// the drift):
//   { approvalId, destination: <string>, space, path }
//
// 260405 = the flat payload reaching a consumer that read `destination.space` /
// `destination.path`, crashing. At the IPC seam, that flat payload fails the
// nested contract's `request.parse` — which is exactly what we assert below.

// `vi.mock` is hoisted above top-level consts, so the synthetic channel name +
// definition must live in a `vi.hoisted` block to be referenceable from both
// the mock factory and the test body.
const fixture = vi.hoisted(() => {
  const { z } = require('zod') as typeof import('zod');
  const DRIFT_CHANNEL = 'memory:__260405_approval_drift_fixture__';

  const NestedApprovalRequest = z.object({
    approvalId: z.string(),
    destination: z.object({
      space: z.string(),
      path: z.string(),
    }),
  });

  const ApprovalResponse = z.object({
    status: z.enum(['accepted', 'rejected']),
    // A field the OLD JSON wire silently corrupted: a real Date does not survive
    // structured/JSON transport as a Date, so the contract pins a numeric epoch.
    // A handler that returns a raw `Date` (or `undefined`) here drifts the
    // response shape — the seam's `response.parse` rejects it (axis 2).
    resolvedAtEpochMs: z.number(),
  });

  return {
    DRIFT_CHANNEL,
    SYNTHETIC_CHANNEL_DEF: {
      type: 'invoke' as const,
      channel: DRIFT_CHANNEL,
      request: NestedApprovalRequest,
      response: ApprovalResponse,
      description: 'Stage-8 fixture: 260405 flat-vs-nested approval drift (synthetic).',
    },
  };
});

const { DRIFT_CHANNEL } = fixture;

// Mock the contracts module so the REAL seam's `allChannels[channel]` lookup
// resolves our synthetic entry — every genuine contract is preserved via
// importOriginal, so nothing else in the registry changes.
vi.mock('@shared/ipc/contracts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shared/ipc/contracts')>();
  return {
    ...actual,
    allChannels: {
      ...actual.allChannels,
      [fixture.DRIFT_CHANNEL]: fixture.SYNTHETIC_CHANNEL_DEF,
    },
  };
});

import { wrapHandlerWithContractParse, isContractEnforcementOn } from '../../utils/registerContractHandler';

// A contract-valid (NESTED) request — the shape the channel actually declares.
const VALID_NESTED_REQUEST = {
  approvalId: 'appr-1',
  destination: { space: 'memory/topics', path: 'foo.md' },
};

// The 260405 drift: a FLAT-destination payload (the persisted shape) sent to a
// channel whose contract expects the nested-destination object.
const DRIFTED_FLAT_REQUEST = {
  approvalId: 'appr-1',
  destination: 'memory/topics/foo.md', // string, not { space, path }
  space: 'memory/topics',
  path: 'foo.md',
};

const VALID_RESPONSE = { status: 'accepted' as const, resolvedAtEpochMs: 1_700_000_000_000 };

beforeEach(() => {
  // Gate ON via the test-env idiom (matches the Stage-2 seam contract).
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('REBEL_CONTRACT_ENFORCE', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('260405 flat-vs-nested approval drift — invoke-channel regression', () => {
  it('GATE PRECONDITION: enforcement is ON under NODE_ENV==="test"', () => {
    // The whole regression depends on the seam being live; pin it explicitly so
    // a future change to the gate idiom turns THIS test red (not silently a-OK).
    expect(isContractEnforcementOn()).toBe(true);
  });

  it('THE ANCHOR: a flat-destination payload (260405 drift) throws ZodError at the request seam, BEFORE the body', async () => {
    // This is the invoke-channel reconstruction of the 260405 escape: the flat
    // persisted payload reaching a channel whose contract expects the nested
    // destination object. The Stage-2 seam rejects it at request.parse — where,
    // in the original bug, nothing on the dispatch path validated the shape and
    // the renderer consumer crashed dereferencing `destination.space`.
    const body = vi.fn().mockResolvedValue(VALID_RESPONSE);
    const wrapped = wrapHandlerWithContractParse(DRIFT_CHANNEL, body);

    // The seam must have WRAPPED (synthetic channel is in the mocked allChannels).
    expect(wrapped).not.toBe(body);

    await expect(wrapped(null, DRIFTED_FLAT_REQUEST)).rejects.toBeInstanceOf(ZodError);
    expect(body).not.toHaveBeenCalled(); // rejected BEFORE the body ran
  });

  it('the ZodError names the nested `destination` path (the precise drift locus)', async () => {
    const body = vi.fn().mockResolvedValue(VALID_RESPONSE);
    const wrapped = wrapHandlerWithContractParse(DRIFT_CHANNEL, body);

    await expect(wrapped(null, DRIFTED_FLAT_REQUEST)).rejects.toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({ path: expect.arrayContaining(['destination']) }),
      ]),
    });
  });

  it('the contract-valid NESTED request passes the seam unchanged (no false positive)', async () => {
    const body = vi.fn().mockResolvedValue(VALID_RESPONSE);
    const wrapped = wrapHandlerWithContractParse(DRIFT_CHANNEL, body);

    const result = await wrapped(null, VALID_NESTED_REQUEST);
    expect(result).toEqual(VALID_RESPONSE);
    expect(body).toHaveBeenCalledTimes(1);
    expect(body).toHaveBeenCalledWith(null, VALID_NESTED_REQUEST);
  });

  it('AXIS 2 (response drift): a Date-bearing response the JSON wire hid → ZodError AFTER the body', async () => {
    // The contract pins `resolvedAtEpochMs: z.number()`. A handler that returns a
    // raw `Date` (the kind of value the old JSON wire silently coerced) drifts the
    // response shape; the seam's response.parse catches it after the real body.
    const body = vi.fn().mockResolvedValue({ status: 'accepted', resolvedAtEpochMs: new Date() });
    const wrapped = wrapHandlerWithContractParse(DRIFT_CHANNEL, body);

    await expect(wrapped(null, VALID_NESTED_REQUEST)).rejects.toBeInstanceOf(ZodError);
    expect(body).toHaveBeenCalledTimes(1); // body DID run — response parse is after
  });

  it('AXIS 2 (response drift): an undefined required field → ZodError AFTER the body', async () => {
    const body = vi.fn().mockResolvedValue({ status: 'accepted', resolvedAtEpochMs: undefined });
    const wrapped = wrapHandlerWithContractParse(DRIFT_CHANNEL, body);

    await expect(wrapped(null, VALID_NESTED_REQUEST)).rejects.toBeInstanceOf(ZodError);
    expect(body).toHaveBeenCalledTimes(1);
  });

  it('SEAM-OFF PROOF: with enforcement OFF the IDENTICAL drift flows through untouched (the test genuinely depends on the seam)', async () => {
    // Disable the seam exactly as production does (no test env, no opt-in flag).
    // The drifted flat payload must NOT be rejected — proving this regression is
    // a real, seam-dependent guard, not a tautology that would pass regardless.
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('REBEL_CONTRACT_ENFORCE', '');
    expect(isContractEnforcementOn()).toBe(false);

    const body = vi.fn().mockResolvedValue(VALID_RESPONSE);
    const wrapped = wrapHandlerWithContractParse(DRIFT_CHANNEL, body);
    // Fail-safe-off: the seam returns the ORIGINAL handler reference (no wrap).
    expect(wrapped).toBe(body);

    const result = await wrapped(null, DRIFTED_FLAT_REQUEST);
    // The 260405 drift sails straight through to the body — exactly the
    // pre-fix production behaviour the seam (when on) now intercepts.
    expect(result).toEqual(VALID_RESPONSE);
    expect(body).toHaveBeenCalledWith(null, DRIFTED_FLAT_REQUEST);
  });
});
