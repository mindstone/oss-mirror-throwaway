/**
 * Property / fuzz spike for the onboarding tool-auth FSM (`toolAuthMachine.ts`).
 *
 * Goal: raise confidence that the reducer cannot deadlock onboarding nor crash /
 * produce an unknown status, BY CONSTRUCTION, rather than via a finite hand-picked
 * matrix. Three invariants are asserted over thousands of deterministic random
 * event sequences applied to a multi-tool state array:
 *
 *  1. SAFETY — no crash, no unknown status. Applying any sequence of named events
 *     (incl. the ones the IPC boundary parsers emit when fed hostile/malformed
 *     `unknown`) leaves every tool in a valid `ToolAuthStatus`. We also assert the
 *     named-event vocabulary is *total*: under test the reducer THROWS on a
 *     genuinely-illegal transition (dev/test guard), so a clean run over the full
 *     named-event vocabulary proves every (status, named-event) pair is classified
 *     either as a real transition or a safe no-op — never illegal. (The legitimately
 *     throwing paths — status-bearing FIELD_PATCHED, off-table PATCH_STATUS /
 *     STATES_REPLACED — are deliberately excluded; those throws are the guard
 *     working as designed, not the property under test.)
 *
 *  2. LIVENESS / NO STRUCTURAL DEADLOCK (the key anti-deadlock guarantee) — from
 *     ANY reachable per-tool status there EXISTS a single event that moves an email
 *     tool to a gate-satisfying status (`connected` or `error`). i.e. the Continue
 *     gate (`isToolAuthGateRelevantStatus`) is always eventually reachable, so
 *     onboarding can never be permanently stuck. Proven as a reachability property
 *     over the live transition table (no hard-coded answer key).
 *
 *  3. IDEMPOTENCE — re-applying a terminal event (e.g. POLL_AUTHENTICATED on
 *     `connected`) is a referential no-op.
 *
 * Determinism: a small seeded xorshift32 PRNG (NO Math.random — it is banned), seed
 * varied by iteration index so every run is reproducible and any failure reports a
 * concrete seed to replay.
 *
 * Non-vacuity: stubbing the reducer to a constant (e.g. `() => states`) breaks
 * property 1 (the unchanged-state would be classified valid but the liveness probe
 * in property 2 would never reach connected/error → fail) — see the explicit
 * non-vacuity guard test at the bottom that re-derives reachability directly off the
 * real reducer so a constant reducer cannot satisfy it.
 */
import { describe, expect, it } from 'vitest';
import type { ToolAuthState, ToolAuthStatus, ToolType } from '../useOnboardingFlow';
import {
  isToolAuthGateRelevantStatus,
  toolAuthEventFromAuthUrlResponse,
  toolAuthEventFromVerifyResponse,
  toolAuthReducer,
  type ToolAuthEvent,
} from '../toolAuthMachine';

const ALL_STATUSES: ToolAuthStatus[] = [
  'pending',
  'generating',
  'ready_to_connect',
  'awaiting_auth',
  'verifying',
  'connected',
  'error',
];

const ALL_TOOLS: ToolType[] = [
  'gmail',
  'google-calendar',
  'slack',
  'outlook-mail',
  'outlook-calendar',
  'teams',
];

const EMAIL_TOOLS: ToolType[] = ['gmail', 'outlook-mail'];

function isValidStatus(status: ToolAuthStatus): boolean {
  return (ALL_STATUSES as string[]).includes(status as string);
}

// --- deterministic PRNG: xorshift32 (NO Math.random) -------------------------

function makeRng(seed: number): () => number {
  // Force a non-zero 32-bit state; xorshift32 has a fixed point at 0.
  let state = (seed | 0) === 0 ? 0x9e3779b9 : seed | 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    // Map to [0, 1).
    return ((state >>> 0) % 0xffffffff) / 0xffffffff;
  };
}

function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length) % items.length];
}

function randInt(rng: () => number, maxExclusive: number): number {
  return Math.floor(rng() * maxExclusive) % maxExclusive;
}

function makeState(status: ToolAuthStatus, tool: ToolType): ToolAuthState {
  return {
    tool,
    displayName: tool,
    description: `${tool} description`,
    serverName: tool,
    status,
    authUrl: status === 'ready_to_connect' || status === 'awaiting_auth' ? 'https://auth.example.test' : null,
    error: status === 'error' ? 'Previous error' : null,
    awaitingSince: status === 'awaiting_auth' || status === 'verifying' ? 1234 : null,
    required: EMAIL_TOOLS.includes(tool),
  };
}

/**
 * The full named-event vocabulary the reducer applies. EXCLUDES the three event
 * shapes whose illegal variants legitimately throw under test (those guards are
 * verified by the unit suite); the remainder are *table-driven* events for which
 * every (status, event) pair must be a real transition or a safe no-op.
 *
 * Includes hostile/malformed `unknown` payloads routed through the IPC boundary
 * parsers, so the parsers' total mapping (never an unknown event, never a throw)
 * is exercised on the fuzz path.
 */
function randomTableEvent(rng: () => number, tools: readonly ToolType[]): ToolAuthEvent {
  const tool = pick(rng, tools);
  const kind = randInt(rng, 18);
  switch (kind) {
    case 0:
      return { type: 'GENERATE_REQUESTED', tool };
    case 1:
      return { type: 'URL_READY', tool, authUrl: rng() < 0.5 ? 'https://auth.example.test/x' : '' };
    case 2:
      return { type: 'USER_CLICKED_CONNECT', tool, awaitingSince: randInt(rng, 1_000_000), autoStart: rng() < 0.5 };
    case 3:
      return { type: 'GENERATE_FAILED', tool, error: 'boom' };
    case 4:
      return { type: 'LOCAL_OAUTH_CONNECTED', tools: [tool, pick(rng, tools)] };
    case 5:
      return { type: 'EXISTING_ACCOUNT_FOUND', tools: [tool] };
    case 6:
      return { type: 'CATALOG_CONNECTION_OBSERVED', tool };
    case 7:
      return { type: 'POLL_AUTHENTICATED', tool };
    case 8:
      return { type: 'VERIFY_REQUESTED', tool };
    case 9:
      return { type: 'VERIFY_AUTHENTICATED', tool };
    case 10:
      return { type: 'VERIFY_PENDING', tool };
    case 11:
      return { type: 'VERIFY_FAILED', tool, error: 'nope' };
    case 12:
      return { type: 'POLL_TIMEOUT', tool, error: 'timeout' };
    case 13:
      return { type: 'DISCONNECTED', tool };
    case 14:
      return { type: 'ERROR_CLEARED', tool };
    case 15:
      // Hostile/malformed IPC payload through the auth-url boundary parser.
      return toolAuthEventFromAuthUrlResponse(tool, hostilePayload(rng), {
        autoStart: rng() < 0.5,
        awaitingSince: randInt(rng, 1_000_000),
      });
    case 16:
      // Hostile/malformed IPC payload through the verify boundary parser (poll).
      return toolAuthEventFromVerifyResponse(tool, hostilePayload(rng), { source: 'poll' });
    default:
      // Hostile/malformed IPC payload through the verify boundary parser (manual).
      return toolAuthEventFromVerifyResponse(tool, hostilePayload(rng), { source: 'verify' });
  }
}

/** A grab-bag of adversarial `unknown` shapes the IPC parsers must survive. */
function hostilePayload(rng: () => number): unknown {
  const variants: unknown[] = [
    null,
    undefined,
    42,
    'a string',
    [],
    {},
    { success: true },
    { success: true, authUrl: '' },
    { success: true, authUrl: 'https://auth.example.test/ok' },
    { success: false },
    { success: false, error: 'denied' },
    { success: 'maybe' },
    { success: true, isAuthenticated: true },
    { success: true, isAuthenticated: false },
    { success: true, isAuthenticated: 'sometimes' },
    { error: 'malformed' },
    { __proto__: { evil: true }, success: true },
  ];
  return variants[randInt(rng, variants.length)];
}

// --- Property 1: safety (no crash, no unknown status, totality of vocabulary) ---

describe('toolAuthMachine property: safety — never crashes, never an unknown status', () => {
  const ITERATIONS = 4000;
  const SEQ_LEN = 30;

  it(`leaves every tool in a valid status across ${ITERATIONS} random sequences`, () => {
    for (let i = 0; i < ITERATIONS; i++) {
      const rng = makeRng(0x5eed_0001 + i);

      // Random multi-tool starting array, each tool seeded at a random status.
      const toolCount = 1 + randInt(rng, ALL_TOOLS.length);
      const tools = ALL_TOOLS.slice(0, toolCount);
      let states: ToolAuthState[] = tools.map((tool) => makeState(pick(rng, ALL_STATUSES), tool));

      for (let step = 0; step < SEQ_LEN; step++) {
        const event = randomTableEvent(rng, tools);
        let next: ToolAuthState[];
        try {
          next = toolAuthReducer(states, event);
        } catch (err) {
          throw new Error(
            `[seed=${0x5eed_0001 + i} step=${step}] reducer THREW on a table-driven/parsed event ` +
              `${JSON.stringify(event)} from statuses ${JSON.stringify(states.map((s) => s.status))}: ${
                (err as Error).message
              }`,
          );
        }
        // Every resulting status must be a known ToolAuthStatus.
        for (const s of next) {
          if (!isValidStatus(s.status)) {
            throw new Error(
              `[seed=${0x5eed_0001 + i} step=${step}] produced unknown status ${JSON.stringify(
                s.status,
              )} for ${s.tool} after event ${JSON.stringify(event)}`,
            );
          }
        }
        states = next;
      }
    }
    // Reaching here means no throw and no unknown status over all iterations:
    // the named-event vocabulary is TOTAL (every pair is transition-or-no-op).
    expect(true).toBe(true);
  });
});

// --- Property 2: liveness — no structural deadlock (reachability of the gate) ---

/**
 * Build the candidate "escape" events that should drive an EMAIL tool to a
 * gate-satisfying status from some status. We do NOT hard-code which one works for
 * which status — we probe the real reducer to find an existing edge. The property
 * is: for EVERY reachable status there EXISTS at least one single event reaching
 * `connected` or `error`.
 */
function escapeProbeEvents(tool: ToolType): ToolAuthEvent[] {
  return [
    { type: 'GENERATE_REQUESTED', tool },
    { type: 'URL_READY', tool, authUrl: 'https://auth.example.test/ready' },
    { type: 'USER_CLICKED_CONNECT', tool, awaitingSince: 1 },
    { type: 'GENERATE_FAILED', tool, error: 'x' },
    { type: 'LOCAL_OAUTH_CONNECTED', tools: [tool] },
    { type: 'EXISTING_ACCOUNT_FOUND', tools: [tool] },
    { type: 'CATALOG_CONNECTION_OBSERVED', tool },
    { type: 'POLL_AUTHENTICATED', tool },
    { type: 'VERIFY_REQUESTED', tool },
    { type: 'VERIFY_AUTHENTICATED', tool },
    { type: 'VERIFY_PENDING', tool },
    { type: 'VERIFY_FAILED', tool, error: 'x' },
    { type: 'POLL_TIMEOUT', tool, error: 'x' },
    { type: 'DISCONNECTED', tool },
    { type: 'ERROR_CLEARED', tool },
  ];
}

/** Single-event reachability of a gate-satisfying status from `status`. */
function reachesGateInOneEvent(status: ToolAuthStatus, tool: ToolType): boolean {
  for (const event of escapeProbeEvents(tool)) {
    const next = toolAuthReducer([makeState(status, tool)], event)[0];
    if (isToolAuthGateRelevantStatus(next.status)) {
      return true;
    }
  }
  return false;
}

describe('toolAuthMachine property: liveness — the Continue gate is always reachable (no deadlock)', () => {
  it('from EVERY status, some single event drives an email tool to connected or error', () => {
    for (const tool of EMAIL_TOOLS) {
      for (const status of ALL_STATUSES) {
        const reachable = reachesGateInOneEvent(status, tool);
        expect(
          reachable,
          `Email tool ${tool} in status '${status}' has NO single event reaching connected/error — ` +
            `onboarding would be permanently STUCK here.`,
        ).toBe(true);
      }
    }
  });

  it('stays reachable along thousands of random walks (no status is a sink off the gate)', () => {
    const ITERATIONS = 2000;
    const SEQ_LEN = 40;
    for (let i = 0; i < ITERATIONS; i++) {
      const rng = makeRng(0x11ab_0001 + i);
      const tool = pick(rng, EMAIL_TOOLS);
      let state = makeState(pick(rng, ALL_STATUSES), tool);

      for (let step = 0; step < SEQ_LEN; step++) {
        // At every point on the walk the gate must be reachable in one event.
        if (!reachesGateInOneEvent(state.status, tool)) {
          throw new Error(
            `[seed=${0x11ab_0001 + i} step=${step}] DEADLOCK: ${tool} reached status '${state.status}' ` +
              `with no single event to connected/error.`,
          );
        }
        const event = randomTableEvent(rng, [tool]);
        state = toolAuthReducer([state], event)[0];
        if (!isValidStatus(state.status)) {
          throw new Error(`[seed=${0x11ab_0001 + i}] random walk produced unknown status ${state.status}`);
        }
      }
    }
    expect(true).toBe(true);
  });
});

// --- Property 3: idempotence / stability of terminal events --------------------

describe('toolAuthMachine property: idempotence of terminal events', () => {
  // The genuine "stability where expected" property is VALUE-idempotence:
  // re-applying a terminal event on its target status yields a value-equal state.
  // (`referentialNoOp` records whether the table also returns the same reference —
  // true for the `unchanged` edges, false for LOCAL_OAUTH_CONNECTED's unconditional
  // connected→connected self-edge, which value-equally re-allocates. See the
  // documented finding in the report.)
  const terminalCases: Array<{
    status: ToolAuthStatus;
    event: (tool: ToolType) => ToolAuthEvent;
    referentialNoOp: boolean;
  }> = [
    { status: 'connected', event: (tool) => ({ type: 'POLL_AUTHENTICATED', tool }), referentialNoOp: true },
    { status: 'connected', event: (tool) => ({ type: 'VERIFY_AUTHENTICATED', tool }), referentialNoOp: true },
    { status: 'connected', event: (tool) => ({ type: 'EXISTING_ACCOUNT_FOUND', tools: [tool] }), referentialNoOp: true },
    // Unconditional self-edge: value-idempotent but NOT a referential no-op.
    { status: 'connected', event: (tool) => ({ type: 'LOCAL_OAUTH_CONNECTED', tools: [tool] }), referentialNoOp: false },
    { status: 'error', event: (tool) => ({ type: 'GENERATE_FAILED', tool, error: 'again' }), referentialNoOp: true },
    { status: 'error', event: (tool) => ({ type: 'VERIFY_FAILED', tool, error: 'again' }), referentialNoOp: true },
    { status: 'error', event: (tool) => ({ type: 'POLL_TIMEOUT', tool, error: 'again' }), referentialNoOp: true },
  ];

  it('re-applying a terminal event on its target status is value-idempotent', () => {
    for (const tool of EMAIL_TOOLS) {
      for (const { status, event, referentialNoOp } of terminalCases) {
        const initial = [makeState(status, tool)];
        const next = toolAuthReducer(initial, event(tool));
        // Value-idempotence: status preserved and state value-equal.
        expect(next[0].status).toBe(status);
        expect(
          next[0],
          `Terminal event ${event(tool).type} on '${status}' for ${tool} changed state value (expected idempotent)`,
        ).toStrictEqual(initial[0]);
        // Where the table classifies the edge as `unchanged`, the reducer also
        // returns the SAME reference (cheap React identity short-circuit).
        if (referentialNoOp) {
          expect(
            next,
            `Terminal event ${event(tool).type} on '${status}' for ${tool} expected referential no-op`,
          ).toBe(initial);
        }
      }
    }
  });

  it('LOCAL_OAUTH_CONNECTED is value-idempotent under repeated application', () => {
    let states = [makeState('awaiting_auth', 'gmail')];
    const event: ToolAuthEvent = { type: 'LOCAL_OAUTH_CONNECTED', tools: ['gmail'] };
    states = toolAuthReducer(states, event);
    expect(states[0].status).toBe('connected');
    const again = toolAuthReducer(states, event);
    // Value-equal under repeated application (idempotent on state value).
    expect(again[0]).toStrictEqual(states[0]);
  });
});

// --- Non-vacuity guard --------------------------------------------------------

describe('toolAuthMachine property: non-vacuity', () => {
  it('a constant reducer would FAIL the liveness property (the property has teeth)', () => {
    // Simulate a degenerate "always returns input" reducer and assert our liveness
    // predicate detects the deadlock — i.e. property 2 is not trivially true.
    const constantReducer = (states: ToolAuthState[]): ToolAuthState[] => states;
    const reachesViaConstant = (status: ToolAuthStatus, tool: ToolType): boolean => {
      for (const event of escapeProbeEvents(tool)) {
        const next = constantReducer([makeState(status, tool)])[0];
        void event;
        if (isToolAuthGateRelevantStatus(next.status)) {
          return true;
        }
      }
      return false;
    };
    // 'pending' is NOT gate-relevant, so a constant reducer can never escape it.
    expect(reachesViaConstant('pending', 'gmail')).toBe(false);
    // The real reducer, by contrast, CAN escape 'pending'.
    expect(reachesGateInOneEvent('pending', 'gmail')).toBe(true);
  });
});
