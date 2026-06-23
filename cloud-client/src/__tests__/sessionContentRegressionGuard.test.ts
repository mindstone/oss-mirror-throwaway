/**
 * Unit tests for the pure session content-regression guard (REBEL-6C0/6BZ
 * mobile parity). Covers the strict-shrink-refuse and apply-everything-else
 * semantics: a richer/equal/different-session/first-load snapshot must always
 * win; only a clear strict same-session shrink is refused.
 */

import { describe, it, expect } from 'vitest';
import {
  decideSessionContentRegression,
  type RegressionGuardSnapshot,
} from '../stores/sessionContentRegressionGuard';

const msg = (id: string, role: 'user' | 'assistant' | 'result') => ({
  id,
  turnId: 'turn-1',
  role,
  text: id,
  createdAt: 1,
});

const live: RegressionGuardSnapshot = {
  id: 'session-1',
  messages: [msg('u-1', 'user'), msg('a-1', 'assistant'), msg('r-1', 'result')],
  maxSeq: 12,
};

describe('decideSessionContentRegression', () => {
  it('refuses a strict shrink by non-user message count (same session)', () => {
    const incoming: RegressionGuardSnapshot = {
      id: 'session-1',
      // Only the user message + preamble — the result message is gone.
      messages: [msg('u-1', 'user'), msg('a-1', 'assistant')],
      // No maxSeq (cache-branch snapshot) — count is the only signal.
    };
    const decision = decideSessionContentRegression(live, incoming, 12);
    expect(decision.refuse).toBe(true);
    expect(decision.reason).toBe('message-count-shrink');
    expect(decision.liveNonUserCount).toBe(2);
    expect(decision.incomingNonUserCount).toBe(1);
  });

  it('refuses a strict shrink by seq (incoming maxSeq below appliedSeq)', () => {
    const incoming: RegressionGuardSnapshot = {
      id: 'session-1',
      // Equal non-user count, but a stale maxSeq below appliedSeq.
      messages: [msg('u-1', 'user'), msg('a-1', 'assistant'), msg('r-1', 'result')],
      maxSeq: 8,
    };
    const decision = decideSessionContentRegression(live, incoming, 12);
    expect(decision.refuse).toBe(true);
    expect(decision.reason).toBe('seq-shrink');
    expect(decision.incomingMaxSeq).toBe(8);
    expect(decision.appliedSeq).toBe(12);
  });

  it('applies an equal snapshot (no shrink)', () => {
    const incoming: RegressionGuardSnapshot = {
      id: 'session-1',
      messages: [msg('u-1', 'user'), msg('a-1', 'assistant'), msg('r-1', 'result')],
      maxSeq: 12,
    };
    expect(decideSessionContentRegression(live, incoming, 12).refuse).toBe(false);
  });

  it('applies a superset snapshot (richer/higher seq)', () => {
    const incoming: RegressionGuardSnapshot = {
      id: 'session-1',
      messages: [
        msg('u-1', 'user'),
        msg('a-1', 'assistant'),
        msg('r-1', 'result'),
        msg('a-2', 'assistant'),
      ],
      maxSeq: 20,
    };
    expect(decideSessionContentRegression(live, incoming, 12).refuse).toBe(false);
  });

  it('applies when the incoming is a different session', () => {
    const incoming: RegressionGuardSnapshot = {
      id: 'session-OTHER',
      messages: [msg('u-1', 'user')],
      maxSeq: 1,
    };
    expect(decideSessionContentRegression(live, incoming, 12).refuse).toBe(false);
  });

  it('applies when there is no live session', () => {
    const incoming: RegressionGuardSnapshot = {
      id: 'session-1',
      messages: [msg('u-1', 'user')],
      maxSeq: 1,
    };
    expect(decideSessionContentRegression(null, incoming, 0).refuse).toBe(false);
    expect(decideSessionContentRegression(undefined, incoming, 0).refuse).toBe(false);
  });

  it('applies when the live transcript is empty (empty -> populated)', () => {
    const emptyLive: RegressionGuardSnapshot = { id: 'session-1', messages: [] };
    const incoming: RegressionGuardSnapshot = {
      id: 'session-1',
      messages: [msg('u-1', 'user'), msg('a-1', 'assistant')],
      maxSeq: 3,
    };
    expect(decideSessionContentRegression(emptyLive, incoming, 0).refuse).toBe(false);
  });

  it('with useMessageCountSignal=false (REST branch), a fewer-message snapshot still applies', () => {
    // The authoritative server snapshot may legitimately shrink; without a seq
    // signal below appliedSeq, it must apply (no over-aggression).
    const incoming: RegressionGuardSnapshot = {
      id: 'session-1',
      messages: [msg('u-1', 'user')],
      // No maxSeq, or one not below appliedSeq.
    };
    expect(
      decideSessionContentRegression(live, incoming, 12, { useMessageCountSignal: false }).refuse,
    ).toBe(false);
  });

  it('with useMessageCountSignal=false (REST branch), still refuses on a stale seq', () => {
    const incoming: RegressionGuardSnapshot = {
      id: 'session-1',
      messages: [msg('u-1', 'user'), msg('a-1', 'assistant'), msg('r-1', 'result')],
      maxSeq: 5,
    };
    const decision = decideSessionContentRegression(live, incoming, 12, { useMessageCountSignal: false });
    expect(decision.refuse).toBe(true);
    expect(decision.reason).toBe('seq-shrink');
  });

  it('does not refuse a fewer-count snapshot on seq grounds when appliedSeq is 0', () => {
    // Defensive: seq-shrink requires appliedSeq > 0. With appliedSeq 0 and an
    // equal/superset count, nothing is refused.
    const incoming: RegressionGuardSnapshot = {
      id: 'session-1',
      messages: [msg('u-1', 'user'), msg('a-1', 'assistant'), msg('r-1', 'result')],
      maxSeq: 0,
    };
    expect(decideSessionContentRegression(live, incoming, 0).refuse).toBe(false);
  });

  // F1 count-stable regression: the most dangerous desktop REBEL-6C0 shape.
  // `mergeResultMessage` promotes an assistant preamble to `result` IN-PLACE
  // (same id, same count). A stale cache where the turn's final answer is still
  // the short `assistant` preamble has the SAME non-user count as the live
  // `result` transcript, so the count signal alone passes the regressing cache.
  it('refuses a count-stable cache regression (turn result demoted to assistant)', () => {
    const liveResult: RegressionGuardSnapshot = {
      id: 'session-1',
      // One turn, final answer is the promoted `result`. No maxSeq on the cache.
      messages: [msg('u-1', 'user'), msg('r-1', 'result')],
    };
    const stalePreamble: RegressionGuardSnapshot = {
      id: 'session-1',
      // SAME non-user count (1), but the turn's answer is still the preamble.
      messages: [msg('u-1', 'user'), msg('a-1', 'assistant')],
      // No maxSeq → seq signal can't catch it; count is stable → only the
      // per-turn richness check catches it.
    };
    // Cache branch (default useMessageCountSignal: true).
    const decision = decideSessionContentRegression(liveResult, stalePreamble, 12);
    expect(decision.refuse).toBe(true);
    expect(decision.reason).toBe('content-regression');
    expect(decision.liveNonUserCount).toBe(1);
    expect(decision.incomingNonUserCount).toBe(1);
  });

  it('applies a count-stable incoming that PRESERVES the turn result (no regression)', () => {
    const liveResult: RegressionGuardSnapshot = {
      id: 'session-1',
      messages: [msg('u-1', 'user'), msg('r-1', 'result')],
    };
    // Same turn still carries a `result` — equal richness, must apply.
    const equallyRich: RegressionGuardSnapshot = {
      id: 'session-1',
      messages: [msg('u-1', 'user'), msg('r-1', 'result')],
    };
    expect(decideSessionContentRegression(liveResult, equallyRich, 12).refuse).toBe(false);
  });

  it('REST branch (useMessageCountSignal=false) does NOT refuse a count-stable regression', () => {
    // The authoritative server snapshot must win even if a shared turn looks
    // poorer by role — only the cache branch applies the per-turn richness check.
    const liveResult: RegressionGuardSnapshot = {
      id: 'session-1',
      messages: [msg('u-1', 'user'), msg('r-1', 'result')],
    };
    const restPreamble: RegressionGuardSnapshot = {
      id: 'session-1',
      messages: [msg('u-1', 'user'), msg('a-1', 'assistant')],
      // No maxSeq below appliedSeq → seq signal inert → REST applies.
    };
    expect(
      decideSessionContentRegression(liveResult, restPreamble, 12, { useMessageCountSignal: false }).refuse,
    ).toBe(false);
  });

  it('does not refuse on a turn the incoming has not loaded yet (only shared turns count)', () => {
    const twoTurnLive: RegressionGuardSnapshot = {
      id: 'session-1',
      messages: [
        { id: 'u-1', turnId: 'turn-1', role: 'user', text: 'q1', createdAt: 1 },
        { id: 'r-1', turnId: 'turn-1', role: 'result', text: 'a1', createdAt: 2 },
        { id: 'u-2', turnId: 'turn-2', role: 'user', text: 'q2', createdAt: 3 },
        { id: 'r-2', turnId: 'turn-2', role: 'result', text: 'a2', createdAt: 4 },
      ],
    };
    // Incoming preserves turn-1 fully and simply doesn't carry turn-2 yet — fewer
    // total non-user messages, so the COUNT signal refuses, but per-turn richness
    // alone (for the shared turn-1) would not. Assert count signal still fires.
    const incomingMissingTurn: RegressionGuardSnapshot = {
      id: 'session-1',
      messages: [
        { id: 'u-1', turnId: 'turn-1', role: 'user', text: 'q1', createdAt: 1 },
        { id: 'r-1', turnId: 'turn-1', role: 'result', text: 'a1', createdAt: 2 },
      ],
    };
    const decision = decideSessionContentRegression(twoTurnLive, incomingMissingTurn, 12);
    expect(decision.refuse).toBe(true);
    // The whole-turn disappearance is a count shrink (2 → 1), caught first.
    expect(decision.reason).toBe('message-count-shrink');
  });
});
