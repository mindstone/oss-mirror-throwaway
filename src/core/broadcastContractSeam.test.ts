/**
 * Stage-2 DoD tests for the broadcast sink-seam decorator
 * (`wrapBroadcastWithContractParse`).
 *
 * Proves the five load-bearing behaviours:
 *  1. Gate OFF → returns the SAME service reference; drift sails through.
 *  2. Gate ON + schema channel + drifted payload → ZodError BEFORE the inner
 *     service is called.
 *  3. Gate ON + non-schema channel → passthrough, never throws.
 *  4. Gate ON + valid payload with an UNKNOWN extra field → forwarded
 *     byte-identical (NOT Zod-stripped); inner service called exactly once.
 *  5. Gate ON + schema channel + 2 args → throws (a 2nd arg is drift).
 *
 * The gate is toggled via `stubEnv('NODE_ENV', 'test'|'production')`.
 */

import { ZodError } from 'zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DRIVE_AWARE_SYNC_DEFERRED_CHANNEL,
  type DriveAwareSyncDeferredEvent,
} from '@shared/ipc/broadcasts';

import { wrapBroadcastWithContractParse } from './broadcastContractSeam';

type BroadcastFn = (channel: string, ...args: unknown[]) => void;

function makeInnerService(): {
  sendToAllWindows: ReturnType<typeof vi.fn<BroadcastFn>>;
  sendToFocusedWindow: ReturnType<typeof vi.fn<BroadcastFn>>;
} {
  return {
    sendToAllWindows: vi.fn<BroadcastFn>(),
    sendToFocusedWindow: vi.fn<BroadcastFn>(),
  };
}

// A minimal-valid payload for the `cloud:drive-aware-sync-deferred` schema.
const VALID_DRIVE_PAYLOAD: DriveAwareSyncDeferredEvent = {
  workspaceFingerprint: 'fp-1',
  timestamp: 1_700_000_000_000,
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('wrapBroadcastWithContractParse — gate OFF (prod-simulated)', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('REBEL_CONTRACT_ENFORCE', '');
  });

  it('returns the SAME service reference (no wrapper on the hot path)', () => {
    const inner = makeInnerService();
    expect(wrapBroadcastWithContractParse(inner)).toBe(inner);
  });

  it('lets a drifted schema-backed payload sail straight through', () => {
    const inner = makeInnerService();
    const wrapped = wrapBroadcastWithContractParse(inner);
    // Missing required `timestamp` → would be a ZodError if the gate were on.
    const drifted = { workspaceFingerprint: 'fp-1' };
    expect(() => wrapped.sendToAllWindows(DRIVE_AWARE_SYNC_DEFERRED_CHANNEL, drifted)).not.toThrow();
    expect(inner.sendToAllWindows).toHaveBeenCalledTimes(1);
    expect(inner.sendToAllWindows).toHaveBeenCalledWith(DRIVE_AWARE_SYNC_DEFERRED_CHANNEL, drifted);
  });
});

describe('wrapBroadcastWithContractParse — gate ON (NODE_ENV==="test")', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('REBEL_CONTRACT_ENFORCE', '');
  });

  it('returns a DIFFERENT (wrapping) service reference', () => {
    const inner = makeInnerService();
    expect(wrapBroadcastWithContractParse(inner)).not.toBe(inner);
  });

  it('throws ZodError on a drifted schema-backed payload BEFORE forwarding', () => {
    const inner = makeInnerService();
    const wrapped = wrapBroadcastWithContractParse(inner);
    const drifted = { workspaceFingerprint: 'fp-1' }; // missing required `timestamp`
    expect(() => wrapped.sendToAllWindows(DRIVE_AWARE_SYNC_DEFERRED_CHANNEL, drifted)).toThrow(ZodError);
    expect(inner.sendToAllWindows).not.toHaveBeenCalled();
  });

  it('passes a non-schema channel through untouched (never throws)', () => {
    const inner = makeInnerService();
    const wrapped = wrapBroadcastWithContractParse(inner);
    const payload = { anything: 'goes' };
    expect(() => wrapped.sendToAllWindows('menu:something', payload)).not.toThrow();
    expect(inner.sendToAllWindows).toHaveBeenCalledTimes(1);
    expect(inner.sendToAllWindows).toHaveBeenCalledWith('menu:something', payload);
  });

  it('forwards a valid payload with an UNKNOWN extra field BYTE-IDENTICAL (not Zod-stripped)', () => {
    const inner = makeInnerService();
    const wrapped = wrapBroadcastWithContractParse(inner);
    const payloadWithExtra = { ...VALID_DRIVE_PAYLOAD, unknownExtra: 'keep-me' };
    wrapped.sendToAllWindows(DRIVE_AWARE_SYNC_DEFERRED_CHANNEL, payloadWithExtra);
    expect(inner.sendToAllWindows).toHaveBeenCalledTimes(1);
    const forwarded = inner.sendToAllWindows.mock.calls[0][1];
    // Object identity preserved + the unknown field survives — Zod's parsed
    // (stripped) output was NOT forwarded.
    expect(forwarded).toBe(payloadWithExtra);
    expect((forwarded as Record<string, unknown>).unknownExtra).toBe('keep-me');
  });

  it('throws on a schema-backed channel emitted with 2 args (a 2nd arg is drift)', () => {
    const inner = makeInnerService();
    const wrapped = wrapBroadcastWithContractParse(inner);
    expect(() =>
      wrapped.sendToAllWindows(DRIVE_AWARE_SYNC_DEFERRED_CHANNEL, VALID_DRIVE_PAYLOAD, 'extra-arg'),
    ).toThrow(/exactly one payload arg/);
    expect(inner.sendToAllWindows).not.toHaveBeenCalled();
  });

  it('forwards a valid single-arg payload and calls the inner service once', () => {
    const inner = makeInnerService();
    const wrapped = wrapBroadcastWithContractParse(inner);
    wrapped.sendToAllWindows(DRIVE_AWARE_SYNC_DEFERRED_CHANNEL, VALID_DRIVE_PAYLOAD);
    expect(inner.sendToAllWindows).toHaveBeenCalledTimes(1);
    expect(inner.sendToAllWindows).toHaveBeenCalledWith(DRIVE_AWARE_SYNC_DEFERRED_CHANNEL, VALID_DRIVE_PAYLOAD);
  });
});
