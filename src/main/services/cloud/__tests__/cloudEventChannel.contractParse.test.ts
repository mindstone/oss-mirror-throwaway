/**
 * Stage-2b DoD tests for the cloud-ingress broadcast contract parse in
 * `cloudEventChannel.dispatchToRenderer`.
 *
 * This is the single point where `as`-cast HTTP/WS JSON enters the broadcast
 * bus — the genuine 260405 surface. The Stage-2 sink-seam is `vi.mock`ed away
 * here (the sink is replaced below), so the ingress parse is the ONLY contract
 * check that fires on this path.
 *
 * `dispatchToRenderer` is private and its sole live caller (the WS `message`
 * handler) wraps it in a swallowing try/catch that turns a parse throw into a
 * `log.warn` + dropped broadcast. We therefore assert the parse THROW directly
 * at the `dispatchToRenderer` boundary (via a typed cast — no source visibility
 * change); the end-to-end "WS drift is logged + dropped, never reaches the sink"
 * effect is left to the WS-handler suite / a later stage (NOT asserted here).
 * Gate toggled via `stubEnv('NODE_ENV', 'test'|'production')`.
 */

import { ZodError } from 'zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockSend = vi.fn();

vi.mock('@core/broadcastService', () => ({
  getBroadcastService: () => ({
    sendToAllWindows: mockSend,
    sendToFocusedWindow: vi.fn(),
  }),
}));

import { cloudEventChannel } from '../cloudEventChannel';

// `agent:route-plan-resolved` is schema-backed (BROADCAST_SCHEMAS) AND on the
// CLOUD_PUSH_ALLOWLIST with no special interceptor branch — a clean ingress
// target downstream of the channel-specific handling.
const CHANNEL = 'agent:route-plan-resolved';

const VALID_PAYLOAD = {
  sessionId: 'session-1',
  turnAuthLabel: 'mindstone' as const,
  resolvedAt: 1_700_000_000_000,
};

// Drifted: `resolvedAt` is required by the schema but absent.
const DRIFTED_PAYLOAD = {
  sessionId: 'session-1',
  turnAuthLabel: 'mindstone' as const,
};

/** Reach the private dispatch boundary where the ingress parse throws. */
function dispatch(channel: string, args: unknown[]): void {
  (cloudEventChannel as unknown as { dispatchToRenderer(c: string, a: unknown[]): void })
    .dispatchToRenderer(channel, args);
}

afterEach(() => {
  vi.unstubAllEnvs();
  mockSend.mockClear();
});

describe('cloud-ingress contract parse — gate ON (NODE_ENV==="test")', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('REBEL_CONTRACT_ENFORCE', '');
  });

  it('throws ZodError on a drifted schema-backed cloud push (before forwarding)', () => {
    expect(() => dispatch(CHANNEL, [DRIFTED_PAYLOAD])).toThrow(ZodError);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('forwards a valid payload unchanged to the sink', () => {
    expect(() => dispatch(CHANNEL, [VALID_PAYLOAD])).not.toThrow();
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledWith(CHANNEL, VALID_PAYLOAD);
  });

  // GPT cross-family F1: the sink is vi.mock'ed here, so the ingress is the ONLY
  // guard on the broadcast call SHAPE — it must reject a wrong arg COUNT, not
  // just validate args[0]. Otherwise `[validPayload, extra]` would be forwarded.
  it('throws on a schema-backed channel with extra args (not just args[0])', () => {
    expect(() => dispatch(CHANNEL, [VALID_PAYLOAD, { extra: true }])).toThrow(
      /must emit exactly one payload arg, got 2/,
    );
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('throws on a schema-backed channel with zero args', () => {
    expect(() => dispatch(CHANNEL, [])).toThrow(/must emit exactly one payload arg, got 0/);
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('cloud-ingress contract parse — gate OFF (NODE_ENV==="production")', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('REBEL_CONTRACT_ENFORCE', '');
  });

  it('passes a drifted payload straight through (no parse, no throw)', () => {
    expect(() => dispatch(CHANNEL, [DRIFTED_PAYLOAD])).not.toThrow();
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledWith(CHANNEL, DRIFTED_PAYLOAD);
  });
});
