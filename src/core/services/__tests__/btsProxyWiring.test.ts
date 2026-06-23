/**
 * BTS proxy-resolution seam wiring contract (plan 260609 — proxy-resolution-seam).
 *
 * Hardens the bug class "a BTS-bootstrapping surface forgets to wire the proxy
 * provider, and nothing complains until a background task fails opaquely"
 * (root-cause follow-up to the containment fix `04f10bece`).
 *
 * Three representable states, exercised here:
 *   - unwired  → `resolveBtsProxyForTransport()` THROWS `BtsProxyNotWiredError`
 *     AND emits an `error`-level log carrying the greppable marker
 *     `bts-proxy-unwired` (survives a swallowing caller in CI/eval logs).
 *   - none     → explicit `declareNoBtsProxy()` → `{url:null, auth:null}`, no throw.
 *   - wired    → returns the (possibly transiently-null) provider values, no throw.
 *
 * Plus a parametrized sibling-parity matrix (the 260429 class): BOTH
 * `callViaOpenRouterProxy` and `callViaCodexProxy` must honour unwired-throws vs
 * no-proxy identically.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Capture the scoped logger's `error` calls so we can assert the unwired marker
// is emitted at the seam regardless of who catches the thrown error.
// `vi.hoisted` so the spy exists when the hoisted mock factory runs.
const { errorSpy } = vi.hoisted(() => ({ errorSpy: vi.fn() }));
vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: errorSpy,
  }),
  getTurnContext: vi.fn(() => undefined),
}));

import {
  BtsProxyNotWiredError,
  __resetBtsProxyProvidersForTesting,
  getProxyAuth,
  getProxyUrl,
  registerBtsProxyProviders,
  declareNoBtsProxy,
  resolveBtsProxyForTransport,
} from '../bts/transports/shared';
import { callViaOpenRouterProxy } from '../bts/transports/openrouter-proxy';
import { callViaCodexProxy } from '../bts/transports/codex-proxy';
import { sanitizeBtsOptionsForWireModel } from '../bts/transports/shared';

// Transports require the branded WireSafeBtsOptions; mint it the same way the
// dispatch layer does (identity copy for this non-always-on model).
const OPTIONS = sanitizeBtsOptionsForWireModel('anthropic/claude-sonnet-4', {
  messages: [{ role: 'user', content: 'test' }],
  codexConnectivity: 'unknown',
});

describe('BTS proxy-resolution seam — resolveBtsProxyForTransport (hard read)', () => {
  beforeEach(() => {
    __resetBtsProxyProvidersForTesting();
    errorSpy.mockClear();
  });

  afterEach(() => {
    __resetBtsProxyProvidersForTesting();
  });

  it('(a) unwired → throws BtsProxyNotWiredError and emits the bts-proxy-unwired marker', async () => {
    await expect(resolveBtsProxyForTransport()).rejects.toBeInstanceOf(BtsProxyNotWiredError);

    // The error-level log must carry the stable greppable marker, so a forgotten
    // bootstrap is attributable in CI/eval logs even if the throw is swallowed.
    expect(errorSpy).toHaveBeenCalled();
    const markerCall = errorSpy.mock.calls.find(
      ([ctx]) => (ctx as { marker?: string } | undefined)?.marker === 'bts-proxy-unwired',
    );
    expect(markerCall).toBeDefined();
  });

  it('(b) explicit-none → returns {url:null, auth:null} without throwing', async () => {
    declareNoBtsProxy();
    await expect(resolveBtsProxyForTransport()).resolves.toEqual({ url: null, auth: null });
    expect(errorSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ marker: 'bts-proxy-unwired' }),
      expect.anything(),
    );
  });

  it('(c) wired but providers return null (proxy stopped) → returns nulls without throwing', async () => {
    registerBtsProxyProviders({ url: () => null, auth: () => null });
    await expect(resolveBtsProxyForTransport()).resolves.toEqual({ url: null, auth: null });
  });

  it('wired with values → returns resolved url+auth (sync + async providers, lazily invoked)', async () => {
    let urlReads = 0;
    registerBtsProxyProviders({
      url: async () => {
        urlReads += 1;
        return 'http://127.0.0.1:9999';
      },
      auth: () => 'tok',
    });
    // Laziness (I2/I3): nothing invoked until read.
    expect(urlReads).toBe(0);
    await expect(resolveBtsProxyForTransport()).resolves.toEqual({
      url: 'http://127.0.0.1:9999',
      auth: 'tok',
    });
    expect(urlReads).toBe(1);
    // Restart-on-demand: the function is re-invoked on every read (never cached).
    await resolveBtsProxyForTransport();
    expect(urlReads).toBe(2);
  });

  it('soft getters resolve null on unwired WITHOUT throwing (dispatch plan-build read, I8)', async () => {
    // beforeEach reset the seam to unwired. The SOFT getters run on EVERY BTS
    // dispatch (including non-proxy paths) while only building a route decision,
    // so they must stay soft — unwired ⇒ null, never a throw. The LOUD unwired
    // error is the job of the decision-time assert / hard resolver, not these.
    __resetBtsProxyProvidersForTesting();
    await expect(getProxyUrl()).resolves.toBeNull();
    await expect(getProxyAuth()).resolves.toBeNull();
  });
});

// ─── Sibling-parity matrix (260429 class) ────────────────────────────────────
//
// Both proxy adapters must resolve the seam IDENTICALLY in the plan-less branch:
// unwired → BtsProxyNotWiredError; explicit-none → the adapter's transient
// "proxy not available" guard (nulls), never the unwired error.
describe.each([
  { name: 'callViaOpenRouterProxy', adapter: callViaOpenRouterProxy },
  { name: 'callViaCodexProxy', adapter: callViaCodexProxy },
])('BTS proxy sibling-parity — $name', ({ adapter }) => {
  beforeEach(() => {
    __resetBtsProxyProvidersForTesting();
    errorSpy.mockClear();
  });

  afterEach(() => {
    __resetBtsProxyProvidersForTesting();
  });

  it('plan-less + unwired → rejects with BtsProxyNotWiredError', async () => {
    await expect(adapter('anthropic/claude-sonnet-4', OPTIONS)).rejects.toBeInstanceOf(
      BtsProxyNotWiredError,
    );
  });

  it('plan-less + explicit-none → rejects with the transient "proxy not available" guard, NOT the unwired error', async () => {
    declareNoBtsProxy();
    await expect(adapter('anthropic/claude-sonnet-4', OPTIONS)).rejects.not.toBeInstanceOf(
      BtsProxyNotWiredError,
    );
    await expect(adapter('anthropic/claude-sonnet-4', OPTIONS)).rejects.toThrow(/proxy not available/);
  });
});
