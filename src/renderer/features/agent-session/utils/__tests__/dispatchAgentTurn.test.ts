// @vitest-environment happy-dom
/**
 * Decision → wire mapping for the renderer agent:turn dispatch chokepoint
 * (docs/plans/260611_recs-round4 Stage 3, rec 10d93cdce18d854b).
 *
 * The load-bearing contract is the 'inherit-legacy' arm: the wire request
 * must OMIT supersedePolicy entirely (not send undefined-as-value semantics
 * drift), because main-side admission treats absence as the legacy supersede
 * backstop and the pinned engine test
 * (useAgentSessionEngine.supersedePolicy.test.ts) relies on omission.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { dispatchAgentTurn } from '../dispatchAgentTurn';

const turnMock = vi.fn().mockResolvedValue({ turnId: 'turn-1' });

beforeEach(() => {
  turnMock.mockClear();
  vi.stubGlobal('agentApi', { turn: turnMock });
});

const request = { sessionId: 'session-1', prompt: 'hello', isSystemContinuation: true };

describe('dispatchAgentTurn', () => {
  it("maps { policy: 'reject' } to supersedePolicy: 'reject' on the wire", async () => {
    await dispatchAgentTurn(request, { policy: 'reject' });
    expect(turnMock).toHaveBeenCalledExactlyOnceWith({
      ...request,
      supersedePolicy: 'reject',
    });
  });

  it("maps { policy: 'interrupt' } to supersedePolicy: 'supersede' on the wire", async () => {
    await dispatchAgentTurn(request, { policy: 'interrupt' });
    expect(turnMock).toHaveBeenCalledExactlyOnceWith({
      ...request,
      supersedePolicy: 'supersede',
    });
  });

  it("'inherit-legacy' OMITS supersedePolicy entirely (legacy omission semantics)", async () => {
    await dispatchAgentTurn(request, {
      policy: 'inherit-legacy',
      reason: 'test: pre-seam path',
    });
    expect(turnMock).toHaveBeenCalledTimes(1);
    const wireRequest = turnMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(wireRequest).toEqual(request);
    expect(Object.prototype.hasOwnProperty.call(wireRequest, 'supersedePolicy')).toBe(false);
  });

  it('returns the turn handle from the wire call', async () => {
    await expect(dispatchAgentTurn(request, { policy: 'reject' })).resolves.toEqual({
      turnId: 'turn-1',
    });
  });

  it('propagates wire rejections (typed busy refusals reach the caller)', async () => {
    turnMock.mockRejectedValueOnce(new Error('AGENT_TURN_TARGET_BUSY'));
    await expect(dispatchAgentTurn(request, { policy: 'reject' })).rejects.toThrow(
      'AGENT_TURN_TARGET_BUSY',
    );
  });
});
