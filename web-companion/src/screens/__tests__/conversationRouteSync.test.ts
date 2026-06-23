import { describe, expect, it } from 'vitest';

import { planConversationRouteSync, type RouteSyncPlan } from '../conversationRouteSync';

/**
 * Pure unit tests for the route-sync planner extracted from
 * `ConversationScreen.syncConversationForRoute`. These tests are the cheapest
 * regression guard for the auto-send bug class fixed in I10 follow-up AMD-8
 * (see `docs/plans/260422_i10_followups_STAGED_PLAN.md`). They run in the
 * default vitest node environment — no DOM, no mocks.
 */
describe('planConversationRouteSync', () => {
  // T-RS.1 — initialPrompt + new id → send
  it('returns "send" when initialPrompt is set and id has not been sent before', () => {
    const plan = planConversationRouteSync({
      id: 'conv-1',
      initialPrompt: 'hello',
      composeMode: null,
      lastSentForId: null,
    });

    expect(plan).toEqual<RouteSyncPlan>({
      kind: 'send',
      id: 'conv-1',
      prompt: 'hello',
      nextSentForId: 'conv-1',
    });
  });

  // T-RS.1b — initialPrompt + id that was previously sent for a DIFFERENT id
  // should still fire (regression-guard for the original `initialSentRef`
  // boolean which prevented a second auto-send across route changes).
  it('returns "send" when initialPrompt is set and a different id was previously sent', () => {
    const plan = planConversationRouteSync({
      id: 'conv-2',
      initialPrompt: 'second prompt',
      composeMode: null,
      lastSentForId: 'conv-1',
    });

    expect(plan.kind).toBe('send');
    if (plan.kind !== 'send') throw new Error('expected send');
    expect(plan.id).toBe('conv-2');
    expect(plan.prompt).toBe('second prompt');
    expect(plan.nextSentForId).toBe('conv-2');
  });

  // T-RS.2 — initialPrompt + same id already sent → noop
  it('returns "noop-already-sent" when initialPrompt is set and id matches lastSentForId', () => {
    const plan = planConversationRouteSync({
      id: 'conv-1',
      initialPrompt: 'hello',
      composeMode: null,
      lastSentForId: 'conv-1',
    });

    expect(plan).toEqual<RouteSyncPlan>({ kind: 'noop-already-sent', id: 'conv-1' });
  });

  // T-RS.3 — no prompt + compose=text → compose-text
  it('returns "compose-text" when no prompt and composeMode is "text"', () => {
    const plan = planConversationRouteSync({
      id: 'conv-1',
      initialPrompt: undefined,
      composeMode: 'text',
      lastSentForId: null,
    });

    expect(plan).toEqual<RouteSyncPlan>({
      kind: 'compose-text',
      id: 'conv-1',
      nextSentForId: null,
    });
  });

  // T-RS.4 — no prompt + no compose → fetch
  it('returns "fetch" when no prompt and no compose mode', () => {
    const plan = planConversationRouteSync({
      id: 'conv-1',
      initialPrompt: undefined,
      composeMode: null,
      lastSentForId: null,
    });

    expect(plan).toEqual<RouteSyncPlan>({
      kind: 'fetch',
      id: 'conv-1',
      nextSentForId: null,
    });
  });

  // T-RS.5 — initialPrompt takes precedence over composeMode
  // Pins the current semantics: if both are present, send wins and we ignore
  // composeMode. If future behavior should combine them, update both this test
  // and the helper.
  it('returns "send" when initialPrompt and composeMode are both set (prompt wins)', () => {
    const plan = planConversationRouteSync({
      id: 'conv-1',
      initialPrompt: 'hello',
      composeMode: 'text',
      lastSentForId: null,
    });

    expect(plan.kind).toBe('send');
    if (plan.kind !== 'send') throw new Error('expected send');
    expect(plan.prompt).toBe('hello');
  });

  // T-RS.6 — empty-string initialPrompt is treated as not present
  it('returns "fetch" when initialPrompt is empty string and no compose mode', () => {
    const plan = planConversationRouteSync({
      id: 'conv-1',
      initialPrompt: '',
      composeMode: null,
      lastSentForId: null,
    });

    expect(plan.kind).toBe('fetch');
  });

  // T-RS.7 — other compose values (e.g. 'voice') fall through to fetch
  it('returns "fetch" when composeMode is something other than "text" and no prompt', () => {
    const plan = planConversationRouteSync({
      id: 'conv-1',
      initialPrompt: undefined,
      composeMode: 'voice',
      lastSentForId: null,
    });

    expect(plan.kind).toBe('fetch');
  });
});
