import { describe, expect, it } from 'vitest';
import { evaluatePollGate, type SlackPollGateState } from '../slackPollGate';

const allGreen: SlackPollGateState = {
  cloudFlagEnabled: true,
  cloudWorkspaceTeamId: 'T1',
  cloudWorkspaceStatus: 'connected',
  cloudReachable: true,
};

describe('evaluatePollGate', () => {
  it('does not pause when the cloud webhook flag is false', () => {
    expect(evaluatePollGate({ ...allGreen, cloudFlagEnabled: false }, 'T1')).toEqual({
      paused: false,
      reason: null,
    });
  });

  it('does not pause when cloud is unreachable', () => {
    expect(evaluatePollGate({ ...allGreen, cloudReachable: false }, 'T1')).toEqual({
      paused: false,
      reason: null,
    });
  });

  it('does not pause on workspace mismatch even when cloud is connected', () => {
    expect(evaluatePollGate(allGreen, 'T2')).toEqual({
      paused: false,
      reason: null,
    });
  });

  it('does not pause when cloud workspace status is null', () => {
    expect(evaluatePollGate({ ...allGreen, cloudWorkspaceStatus: null }, 'T1')).toEqual({
      paused: false,
      reason: null,
    });
  });

  it('does not pause when cloud workspace status is needs_reconnect', () => {
    expect(evaluatePollGate({ ...allGreen, cloudWorkspaceStatus: 'needs_reconnect' }, 'T1')).toEqual({
      paused: false,
      reason: null,
    });
  });

  it('does not pause when cloud workspace status is disconnected', () => {
    expect(evaluatePollGate({ ...allGreen, cloudWorkspaceStatus: 'disconnected' }, 'T1')).toEqual({
      paused: false,
      reason: null,
    });
  });

  it('pauses with cloud-canonical reason when all conditions are green', () => {
    expect(evaluatePollGate(allGreen, 'T1')).toEqual({
      paused: true,
      reason: 'cloud-canonical',
    });
  });
});
