import { describe, expect, it } from 'vitest';
import {
  BACKSTOP_THRESHOLD_MS,
  classifyUpdatePhase,
  type ClassifyInput,
  STALL_THRESHOLD_MS,
  TERMINAL_MACHINE_STATE_GRACE_MS,
} from '../cloudUpdateProgress';

function classify(overrides: Partial<ClassifyInput> = {}) {
  return classifyUpdatePhase({
    machineStateAvailable: false,
    healthStatus: 0,
    elapsedMs: 10_000,
    lastPhaseChangeMs: 0,
    ...overrides,
  });
}

describe('classifyUpdatePhase', () => {
  it('returns backstop at the absolute threshold', () => {
    expect(classify({ elapsedMs: BACKSTOP_THRESHOLD_MS })?.phase).toBe('backstop');
  });

  it('prioritizes backstop over stall detection', () => {
    expect(classify({
      elapsedMs: BACKSTOP_THRESHOLD_MS,
      lastPhaseChangeMs: STALL_THRESHOLD_MS,
    })?.phase).toBe('backstop');
  });

  it('returns stalled at the no-progress threshold boundary', () => {
    expect(classify({ lastPhaseChangeMs: STALL_THRESHOLD_MS })?.phase).toBe('stalled');
  });

  it('does not return stalled before the threshold boundary', () => {
    expect(classify({ lastPhaseChangeMs: STALL_THRESHOLD_MS - 1 })?.phase).toBe('deploying');
  });

  it('marks stopped and destroyed machines as terminal errors after the grace period', () => {
    for (const machineState of ['stopped', 'destroyed']) {
      const result = classify({
        machineStateAvailable: true,
        machineState,
        elapsedMs: TERMINAL_MACHINE_STATE_GRACE_MS + 1,
      });

      expect(result).toMatchObject({
        phase: 'stalled',
        isTerminalError: true,
        machineState,
      });
    }
  });

  it('does not mark terminal machine states as errors during the initial restart grace period', () => {
    const result = classify({
      machineStateAvailable: true,
      machineState: 'stopped',
      elapsedMs: TERMINAL_MACHINE_STATE_GRACE_MS,
    });

    expect(result).toMatchObject({
      phase: 'deploying',
      machineState: 'stopped',
    });
    expect(result?.isTerminalError).toBeUndefined();
  });

  it('classifies stopping machines as restarting', () => {
    expect(classify({
      machineStateAvailable: true,
      machineState: 'stopping',
      elapsedMs: 5_000,
    })?.phase).toBe('restarting');
  });

  it('classifies pre-started Fly machine states as starting', () => {
    for (const machineState of ['starting', 'created', 'replacing']) {
      expect(classify({
        machineStateAvailable: true,
        machineState,
      })?.phase).toBe('starting');
    }
  });

  it('classifies a started machine with no health response as health_check', () => {
    expect(classify({
      machineStateAvailable: true,
      machineState: 'started',
      healthStatus: 0,
    })?.phase).toBe('health_check');
  });

  it('classifies connection refused without machine state as deploying', () => {
    expect(classify({ healthStatus: 0 })?.phase).toBe('deploying');
  });

  it('falls back to HTTP-only classification when Fly machine state is unavailable', () => {
    const result = classify({
      machineStateAvailable: false,
      machineState: 'started',
      healthStatus: 0,
    });

    expect(result).toMatchObject({
      phase: 'deploying',
      lastHealthStatus: 0,
    });
    expect(result?.machineState).toBeUndefined();
  });

  it('classifies server errors as starting', () => {
    expect(classify({ healthStatus: 503 })?.phase).toBe('starting');
  });

  it('classifies a healthy old build as verifying', () => {
    expect(classify({
      healthStatus: 200,
      healthBody: { status: 'ok', buildCommit: 'old1234' },
      expectedTag: 'prod-new5678',
    })?.phase).toBe('verifying');
  });

  it('returns null when the health body buildCommit matches the expected tag', () => {
    expect(classify({
      healthStatus: 200,
      healthBody: { status: 'ok', buildCommit: 'abc1234' },
      expectedTag: 'prod-abc1234',
    })).toBeNull();
  });

  it('uses existing version comparison logic for short and long commit matches', () => {
    expect(classify({
      healthStatus: 200,
      healthBody: { status: 'ok', buildCommit: 'abc1234def5678' },
      expectedTag: 'prod-abc1234',
    })).toBeNull();
  });

  it('defaults to deploying for non-terminal, non-ready responses', () => {
    expect(classify({ healthStatus: 404 })?.phase).toBe('deploying');
  });
});
