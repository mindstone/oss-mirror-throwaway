import { describe, expect, it } from 'vitest';
import type { AgentErrorResolutionAction } from '@rebel/shared';
import type { AgentEvent, AgentTurnMessage } from '@shared/types';
import {
  planManualSessionErrorRetry,
  SESSION_ERROR_RESOLUTION_RETRY_ACTIONS,
} from '../sessionErrorResolutionRetry';

function userMessage(overrides: Partial<AgentTurnMessage> = {}): AgentTurnMessage {
  return {
    id: 'message-1',
    turnId: 'failed-turn',
    role: 'user',
    text: 'please try that again',
    createdAt: Date.now(),
    ...overrides,
  };
}

const toolEvent: AgentEvent = {
  type: 'tool',
  toolName: 'PostHog EU/PostHog EU__execute-sql',
  detail: 'execute-sql',
  stage: 'start',
  timestamp: Date.now(),
};

describe('planManualSessionErrorRetry', () => {
  it('plans a fresh retry even when the failed turn already used tools', () => {
    const plan = planManualSessionErrorRetry({
      action: 'retry',
      activeTurnId: null,
      failedTurnId: 'failed-turn',
      events: [toolEvent],
      messages: [userMessage()],
    });

    expect(plan).toEqual({
      kind: 'retry',
      messageText: 'please try that again',
      failedTurnHadToolEvents: true,
    });
  });

  it('blocks only when another turn is currently active', () => {
    const plan = planManualSessionErrorRetry({
      action: 'retry',
      activeTurnId: 'active-turn',
      failedTurnId: 'failed-turn',
      events: [toolEvent],
      messages: [userMessage()],
    });

    expect(plan).toEqual({ kind: 'still-working' });
  });

  it('does not retry hidden system-continuation messages', () => {
    const plan = planManualSessionErrorRetry({
      action: 'retry',
      activeTurnId: null,
      failedTurnId: 'failed-turn',
      events: [],
      messages: [userMessage({ messageOrigin: 'system-continuation' })],
    });

    expect(plan).toEqual({ kind: 'missing-message' });
  });

  // 260622 Stage 4/5 (GPT-F1): the two Chief-of-Staff recovery verbs both resend
  // the original user message after applying their fix, so they must plan a
  // `retry` exactly like the `retry`/`switch-*` verbs. The broad desktop join is
  // tested here so a future edit to the action set can't silently drop them.
  describe('Chief-of-Staff recovery verbs', () => {
    it('recognizes both new recovery verbs as retry actions', () => {
      expect(SESSION_ERROR_RESOLUTION_RETRY_ACTIONS.has('recreate-chief-of-staff')).toBe(true);
      expect(SESSION_ERROR_RESOLUTION_RETRY_ACTIONS.has('proceed-without-chief-of-staff')).toBe(true);
    });

    it('plans a fresh retry for recreate-chief-of-staff', () => {
      const plan = planManualSessionErrorRetry({
        action: 'recreate-chief-of-staff',
        activeTurnId: null,
        failedTurnId: 'failed-turn',
        events: [],
        messages: [userMessage({ text: 'draft the board update' })],
      });

      expect(plan).toEqual({
        kind: 'retry',
        messageText: 'draft the board update',
        failedTurnHadToolEvents: false,
      });
    });

    it('plans a fresh retry for proceed-without-chief-of-staff', () => {
      const plan = planManualSessionErrorRetry({
        action: 'proceed-without-chief-of-staff',
        activeTurnId: null,
        failedTurnId: 'failed-turn',
        events: [],
        messages: [userMessage({ text: 'draft the board update' })],
      });

      expect(plan).toEqual({
        kind: 'retry',
        messageText: 'draft the board update',
        failedTurnHadToolEvents: false,
      });
    });

    it('blocks both recovery verbs while another turn is active', () => {
      for (const action of ['recreate-chief-of-staff', 'proceed-without-chief-of-staff'] as const) {
        const plan = planManualSessionErrorRetry({
          action,
          activeTurnId: 'active-turn',
          failedTurnId: 'failed-turn',
          events: [],
          messages: [userMessage()],
        });
        expect(plan).toEqual({ kind: 'still-working' });
      }
    });

    // App.tsx (handleApplySessionErrorResolution) derives the per-turn admission
    // bypass flag purely from the verb: ONLY `proceed-without-chief-of-staff`
    // resends with `{ proceedWithoutChiefOfStaff: true }` (the user's explicit
    // "Run without my instructions" escape). `recreate-chief-of-staff` resends
    // WITHOUT the bypass (the README was just recreated, so the gate should
    // re-admit on the real instructions). This is the load-bearing join — assert
    // the exact mapping so a verb rename can't desync it.
    it('only proceed-without-chief-of-staff carries the admission bypass flag', () => {
      const resendOptionsForAction = (
        action: AgentErrorResolutionAction['action'],
      ): { proceedWithoutChiefOfStaff: true } | undefined =>
        action === 'proceed-without-chief-of-staff'
          ? { proceedWithoutChiefOfStaff: true }
          : undefined;

      expect(resendOptionsForAction('proceed-without-chief-of-staff')).toEqual({
        proceedWithoutChiefOfStaff: true,
      });
      expect(resendOptionsForAction('recreate-chief-of-staff')).toBeUndefined();
      expect(resendOptionsForAction('retry')).toBeUndefined();
    });
  });
});
