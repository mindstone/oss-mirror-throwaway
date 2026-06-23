/**
 * Unit tests for runPhase() — the typed phase wrapper that produces the
 * four-arm result contract consumed by the (forthcoming) Stage 2+ orchestrator.
 *
 * Tests the four discriminated arms of TurnPhaseResult:
 *   - terminal (pre-abort)
 *   - ok (happy path)
 *   - failed-terminal (pre-runtime phase throw)
 *   - failed-recoverable (runtime phase throw)
 *
 * Entry/exit logging and late-abort detection are deferred to integration
 * coverage at Stage 2+ when a real consumer drives them. See planning doc
 * docs/plans/260428_kw_ci_knip_and_e2e_orphan_fixes.md Stage 1.
 */

import { describe, expect, it, vi } from 'vitest';
import { runPhase, type RunPhaseDeps } from '../turnPipeline/runPhase';

function createDeps(signal: AbortSignal): RunPhaseDeps {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as RunPhaseDeps['logger'];

  return {
    logger,
    signal,
    base: {
      turnId: 'turn-1',
      rendererSessionId: 'session-1',
    } as unknown as RunPhaseDeps['base'],
    accumulator: { stage: 'pre-runtime' },
    attempt: 1,
    emitPhaseLog: vi.fn(),
  };
}

describe('runPhase()', () => {
  it('returns terminal:aborted without invoking phaseFn when signal is pre-aborted', async () => {
    const abortController = new AbortController();
    abortController.abort();
    const phaseFn = vi.fn(async () => ({ status: 'ok' as const, value: 'unused' }));

    const result = await runPhase('admission', phaseFn, { any: 'input' }, createDeps(abortController.signal));

    expect(phaseFn).not.toHaveBeenCalled();
    expect(result).toEqual({ status: 'terminal', reason: 'aborted' });
  });

  it('returns the same ok result from the phase function on happy path', async () => {
    const expected = { status: 'ok' as const, value: { token: 'ok-value' } };
    const phaseFn = vi.fn(async () => expected);

    const result = await runPhase('admission', phaseFn, 'input', createDeps(new AbortController().signal));

    expect(result).toBe(expected);
    expect(result).toEqual({ status: 'ok', value: { token: 'ok-value' } });
  });

  it('maps throws in pre-runtime phases to failed-terminal with pre-runtime-failure reason', async () => {
    const cause = new Error('pre-runtime boom');
    const phaseFn = vi.fn(async () => {
      throw cause;
    });

    const result = await runPhase('admission', phaseFn, null, createDeps(new AbortController().signal));

    expect(result).toMatchObject({
      status: 'failed-terminal',
      error: { phase: 'admission', cause },
      completion: { reason: 'pre-runtime-failure' },
    });
  });

  it('maps throws in runtime phases to failed-recoverable with recursive-retry', async () => {
    const cause = new Error('runtime boom');
    const phaseFn = vi.fn(async () => {
      throw cause;
    });

    const result = await runPhase('hookGraph', phaseFn, null, createDeps(new AbortController().signal));

    expect(result).toMatchObject({
      status: 'failed-recoverable',
      error: { phase: 'hookGraph', cause },
      recovery: { kind: 'recursive-retry' },
    });
  });
});
