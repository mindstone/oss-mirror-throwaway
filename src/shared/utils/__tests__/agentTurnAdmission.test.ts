/**
 * Stage 2 of docs/plans/260610_queue-drain-cancels-turn/PLAN.md — shared
 * sentinel + matcher for the typed target-busy admission refusal.
 */
import { describe, expect, it } from 'vitest';
import {
  AGENT_TURN_TARGET_BUSY_CODE,
  attachRequeueMessageId,
  createTargetBusyRejectionError,
  getRequeueMessageId,
  isTargetBusyRejection,
} from '../agentTurnAdmission';

describe('agentTurnAdmission sentinel + matcher', () => {
  it('creates an Error whose message carries the sentinel code, session, and active turn', () => {
    const error = createTargetBusyRejectionError('session-1', 'turn-9');
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain(AGENT_TURN_TARGET_BUSY_CODE);
    expect(error.message).toContain('session-1');
    expect(error.message).toContain('turn-9');
  });

  it('matches the raw thrown error', () => {
    expect(isTargetBusyRejection(createTargetBusyRejectionError('s', 't'))).toBe(true);
  });

  it("matches the Electron invoke rejection form (\"Error invoking remote method 'agent:turn': …\" prefix)", () => {
    // ipcRenderer.invoke rejections re-wrap the main-process error message —
    // the matcher must survive that prefix (plan assumption, asserted here).
    const original = createTargetBusyRejectionError('session-1', 'turn-9');
    const ipcWrapped = new Error(
      `Error invoking remote method 'agent:turn': Error: ${original.message}`,
    );
    expect(isTargetBusyRejection(ipcWrapped)).toBe(true);
  });

  it('matches a raw string rethrow', () => {
    expect(isTargetBusyRejection(`${AGENT_TURN_TARGET_BUSY_CODE}: busy`)).toBe(true);
  });

  it('does not match unrelated errors, strings, objects, or nullish values', () => {
    expect(isTargetBusyRejection(new Error('Upstream exploded'))).toBe(false);
    expect(isTargetBusyRejection('plain failure')).toBe(false);
    expect(isTargetBusyRejection({ code: AGENT_TURN_TARGET_BUSY_CODE })).toBe(false);
    expect(isTargetBusyRejection(null)).toBe(false);
    expect(isTargetBusyRejection(undefined)).toBe(false);
  });
});

describe('requeue message-id enrichment (renderer-side, never crosses IPC)', () => {
  it('attaches and reads back the persisted message id on an Error', () => {
    const error = createTargetBusyRejectionError('session-1', 'turn-9');
    const enriched = attachRequeueMessageId(error, 'msg-42');
    expect(enriched).toBe(error); // same Error instance — message/sentinel intact
    expect(isTargetBusyRejection(enriched)).toBe(true);
    expect(getRequeueMessageId(enriched)).toBe('msg-42');
  });

  it('wraps non-Error throwables while preserving the sentinel text', () => {
    const enriched = attachRequeueMessageId(`${AGENT_TURN_TARGET_BUSY_CODE}: busy`, 'msg-7');
    expect(enriched).toBeInstanceOf(Error);
    expect(isTargetBusyRejection(enriched)).toBe(true);
    expect(getRequeueMessageId(enriched)).toBe('msg-7');
  });

  it('returns undefined for errors without enrichment', () => {
    expect(getRequeueMessageId(new Error('nope'))).toBeUndefined();
    expect(getRequeueMessageId('nope')).toBeUndefined();
  });
});
