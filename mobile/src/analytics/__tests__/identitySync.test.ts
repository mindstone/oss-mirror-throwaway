/**
 * Stage B3 fix — post-pair identity sync race + generation guard (GPT F2).
 * Verifies that identify (a) waits for analytics init before applying, and
 * (b) bails when the pairing generation changed mid-fetch (a 401/unpair landed),
 * so a stale identity is never applied over the reset/anonymous session.
 */

import {
  syncIdentityAfterPair,
  clearTelemetryIdentity,
  type IdentitySyncDeps,
} from '../identitySync';

function makeDeps(overrides: Partial<IdentitySyncDeps> = {}): {
  deps: IdentitySyncDeps;
  setSentryUser: jest.Mock;
  identifyByEmail: jest.Mock;
  breadcrumb: jest.Mock;
} {
  const setSentryUser = jest.fn();
  const identifyByEmail = jest.fn();
  const breadcrumb = jest.fn();
  const deps: IdentitySyncDeps = {
    whenReady: jest.fn().mockResolvedValue(undefined),
    getSettings: jest.fn().mockResolvedValue({ userEmail: 'worker@example.com' }),
    resolveAnonId: jest.fn().mockResolvedValue('anon-install-id'),
    currentGeneration: () => 1,
    capturedGeneration: 1,
    setSentryUser,
    identifyByEmail,
    breadcrumb,
    ...overrides,
  };
  return { deps, setSentryUser, identifyByEmail, breadcrumb };
}

describe('syncIdentityAfterPair', () => {
  it('awaits init (whenReady) BEFORE applying identity — no drop (F2)', async () => {
    const order: string[] = [];
    const whenReady = jest.fn().mockImplementation(async () => {
      order.push('ready');
    });
    const identifyByEmail = jest.fn().mockImplementation(() => {
      order.push('identify');
    });
    const { deps } = makeDeps({ whenReady, identifyByEmail });
    await syncIdentityAfterPair(deps);
    expect(whenReady).toHaveBeenCalledTimes(1);
    expect(identifyByEmail).toHaveBeenCalledWith('worker@example.com');
    // init must have settled before identify ran.
    expect(order).toEqual(['ready', 'identify']);
  });

  it('applies identity to BOTH Sentry (id + email) and analytics on a fresh generation', async () => {
    const { deps, setSentryUser, identifyByEmail } = makeDeps();
    await syncIdentityAfterPair(deps);
    // Sentry carries the anon id AND the email (matches desktop — F4).
    expect(setSentryUser).toHaveBeenCalledWith({ id: 'anon-install-id', email: 'worker@example.com' });
    expect(identifyByEmail).toHaveBeenCalledWith('worker@example.com');
  });

  it('sets Sentry user to the anon id ONLY when no email is present (F4 — never empty)', async () => {
    const { deps, setSentryUser, identifyByEmail, breadcrumb } = makeDeps({
      getSettings: jest.fn().mockResolvedValue({}),
    });
    await syncIdentityAfterPair(deps);
    // Sentry still gets identity (the anon id) so it matches analytics' anonymousId,
    // even though analytics stays anonymous (no email to identify by).
    expect(setSentryUser).toHaveBeenCalledWith({ id: 'anon-install-id' });
    expect(identifyByEmail).not.toHaveBeenCalled();
    expect(breadcrumb).toHaveBeenCalledWith(
      'identity',
      expect.stringContaining('no userEmail'),
      'warning',
    );
  });

  it('sets an empty Sentry user (no-op) when neither email nor anon id resolve', async () => {
    const { deps, setSentryUser, identifyByEmail } = makeDeps({
      getSettings: jest.fn().mockResolvedValue({}),
      resolveAnonId: jest.fn().mockResolvedValue(undefined),
    });
    await syncIdentityAfterPair(deps);
    // setSentryUser receives {} — the Sentry impl no-ops on an empty user.
    expect(setSentryUser).toHaveBeenCalledWith({});
    expect(identifyByEmail).not.toHaveBeenCalled();
  });

  it('DROPS a stale identity apply when the generation changed mid-fetch (unpair) — F2', async () => {
    // Simulate a 401/unpair landing while getSettings was in flight: the live
    // generation advanced past the captured one.
    const { deps, setSentryUser, identifyByEmail, breadcrumb } = makeDeps({
      capturedGeneration: 1,
      currentGeneration: () => 2,
    });
    await syncIdentityAfterPair(deps);
    expect(setSentryUser).not.toHaveBeenCalled();
    expect(identifyByEmail).not.toHaveBeenCalled();
    expect(breadcrumb).toHaveBeenCalledWith(
      'identity',
      expect.stringContaining('stale generation'),
      'info',
    );
  });

  it('checks the generation AFTER awaiting init+settings (not before)', async () => {
    // Generation is still equal at entry, flips only once getSettings resolves.
    let generation = 1;
    const { deps, identifyByEmail, breadcrumb } = makeDeps({
      capturedGeneration: 1,
      currentGeneration: () => generation,
      getSettings: jest.fn().mockImplementation(async () => {
        generation = 2; // unpair lands during the fetch
        return { userEmail: 'worker@example.com' };
      }),
    });
    await syncIdentityAfterPair(deps);
    expect(identifyByEmail).not.toHaveBeenCalled();
    expect(breadcrumb).toHaveBeenCalledWith('identity', expect.stringContaining('stale generation'), 'info');
  });

  it('leaves analytics anonymous + breadcrumb when no userEmail is present (Sentry still gets anon id)', async () => {
    const { deps, setSentryUser, identifyByEmail, breadcrumb } = makeDeps({
      getSettings: jest.fn().mockResolvedValue({}),
    });
    await syncIdentityAfterPair(deps);
    // Analytics identify is skipped (no email), but Sentry gets the anon id (F4).
    expect(setSentryUser).toHaveBeenCalledWith({ id: 'anon-install-id' });
    expect(identifyByEmail).not.toHaveBeenCalled();
    expect(breadcrumb).toHaveBeenCalledWith(
      'identity',
      expect.stringContaining('no userEmail'),
      'warning',
    );
  });

  it('degrades to anonymous + breadcrumb (never throws) when getSettings fails', async () => {
    const { deps, identifyByEmail, breadcrumb } = makeDeps({
      getSettings: jest.fn().mockRejectedValue(new Error('offline')),
    });
    await expect(syncIdentityAfterPair(deps)).resolves.toBeUndefined();
    expect(identifyByEmail).not.toHaveBeenCalled();
    expect(breadcrumb).toHaveBeenCalledWith(
      'identity',
      expect.stringContaining('getSettings failed'),
      'warning',
    );
  });

  it('trims surrounding whitespace from the email', async () => {
    const { deps, setSentryUser, identifyByEmail } = makeDeps({
      getSettings: jest.fn().mockResolvedValue({ userEmail: '  worker@example.com  ' }),
    });
    await syncIdentityAfterPair(deps);
    expect(setSentryUser).toHaveBeenCalledWith({ id: 'anon-install-id', email: 'worker@example.com' });
    expect(identifyByEmail).toHaveBeenCalledWith('worker@example.com');
  });
});

describe('clearTelemetryIdentity (DA #1 — single clear chokepoint)', () => {
  it('fans the clear out to BOTH Sentry and analytics', () => {
    const clearSentryContext = jest.fn();
    const resetIdentity = jest.fn();
    clearTelemetryIdentity({ clearSentryContext, resetIdentity });
    expect(clearSentryContext).toHaveBeenCalledTimes(1);
    expect(resetIdentity).toHaveBeenCalledTimes(1);
  });
});

/**
 * GPT F1 — the 401 auto-unpair path must route telemetry-identity teardown
 * through the SAME ordered chokepoint as a normal logout, NOT a direct
 * clearSentryContext() call.
 *
 * `_layout.tsx` is a heavy RN root component with no test harness, so we
 * characterise the CONTRACT the 401 path now relies on: on a real pair→unpair
 * transition the unified `[isPaired]=false` effect emits `Unpaired` exactly once
 * (guarded by prevPairedRef) BEFORE calling clearTelemetryIdentity exactly once
 * (one Sentry clear + one analytics reset). The 401 handler no longer clears
 * Sentry directly, so there is no out-of-order / double clear. This helper
 * mirrors the `else` branch of that effect.
 */
describe('401 auto-unpair routes through the ordered identity chokepoint (F1)', () => {
  // Mirrors the `[isPaired]` effect's `else` branch (the path a 401 reaches once
  // account teardown flips isPaired to false).
  function runUnpairBranch(args: {
    prevPaired: boolean | null;
    emitUnpaired: () => void;
    clearSentryContext: () => void;
    resetIdentity: () => void;
  }): void {
    if (args.prevPaired === true) {
      args.emitUnpaired();
    }
    clearTelemetryIdentity({
      clearSentryContext: args.clearSentryContext,
      resetIdentity: args.resetIdentity,
    });
  }

  it('emits Unpaired ONCE before a SINGLE telemetry clear (no out-of-order, no double-clear)', () => {
    const order: string[] = [];
    const emitUnpaired = jest.fn(() => order.push('unpaired'));
    const clearSentryContext = jest.fn(() => order.push('clearSentry'));
    const resetIdentity = jest.fn(() => order.push('resetIdentity'));

    // A 401 lands on a previously-paired session → real pair→unpair transition.
    runUnpairBranch({ prevPaired: true, emitUnpaired, clearSentryContext, resetIdentity });

    expect(emitUnpaired).toHaveBeenCalledTimes(1);
    expect(clearSentryContext).toHaveBeenCalledTimes(1); // single clear, not double
    expect(resetIdentity).toHaveBeenCalledTimes(1);
    // Unpaired is emitted while still identified, BEFORE the clear fan-out.
    expect(order).toEqual(['unpaired', 'clearSentry', 'resetIdentity']);
  });

  it('does NOT emit Unpaired when the session was never paired (initial unpaired mount)', () => {
    const emitUnpaired = jest.fn();
    const clearSentryContext = jest.fn();
    const resetIdentity = jest.fn();

    runUnpairBranch({ prevPaired: null, emitUnpaired, clearSentryContext, resetIdentity });

    expect(emitUnpaired).not.toHaveBeenCalled();
    // Identity clear is still idempotent/safe on the initial mount.
    expect(clearSentryContext).toHaveBeenCalledTimes(1);
    expect(resetIdentity).toHaveBeenCalledTimes(1);
  });
});
