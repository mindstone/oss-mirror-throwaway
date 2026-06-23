import { describe, expect, it, vi } from 'vitest';
import {
  formatParallelSubagentsBanner,
  formatTaskRecoveryBanner,
  parseParallelSubagentsStatus,
  parseTaskRecoveryStatus,
} from '../parallelSubagentsStatus';

describe('parallelSubagentsStatus', () => {
  it('parses start payloads and formats start banners', () => {
    const parsed = parseParallelSubagentsStatus('parallel:subagents:start:{"requested":6,"cap":4}');
    expect(parsed).toEqual({
      kind: 'start',
      payload: {
        requested: 6,
        cap: 4,
      },
    });
    expect(formatParallelSubagentsBanner(parsed)).toBe('Running 6 parallel tasks (cap 4)…');
  });

  it('parses complete payloads with requested/aborted/skipped and formats completion banners', () => {
    const parsed = parseParallelSubagentsStatus(
      'parallel:subagents:complete:{"requested":6,"succeeded":3,"failed":1,"aborted":1,"skipped":1,"durationMs":42}',
    );

    expect(parsed).toEqual({
      kind: 'complete',
      payload: {
        requested: 6,
        succeeded: 3,
        failed: 1,
        aborted: 1,
        skipped: 1,
        durationMs: 42,
      },
    });
    expect(formatParallelSubagentsBanner(parsed)).toBe('Finished 4 of 6 parallel tasks (1 failed, 1 aborted, 1 skipped).');
  });

  it('keeps compatibility with legacy complete payloads without requested/aborted/skipped', () => {
    const parsed = parseParallelSubagentsStatus(
      'parallel:subagents:complete:{"succeeded":2,"failed":0,"durationMs":20}',
    );

    expect(parsed).toEqual({
      kind: 'complete',
      payload: {
        requested: 2,
        succeeded: 2,
        failed: 0,
        aborted: 0,
        skipped: 0,
        durationMs: 20,
      },
    });
    expect(formatParallelSubagentsBanner(parsed)).toBe('Finished 2 of 2 parallel tasks.');
  });

  it('keeps compatibility with payloads carrying aborted but no skipped', () => {
    const parsed = parseParallelSubagentsStatus(
      'parallel:subagents:complete:{"requested":4,"succeeded":2,"failed":1,"aborted":1,"durationMs":30}',
    );

    expect(parsed).toEqual({
      kind: 'complete',
      payload: {
        requested: 4,
        succeeded: 2,
        failed: 1,
        aborted: 1,
        skipped: 0,
        durationMs: 30,
      },
    });
    expect(formatParallelSubagentsBanner(parsed)).toBe('Finished 3 of 4 parallel tasks (1 failed, 1 aborted).');
  });

  it('returns invalid sentinel and warns when parallel payload JSON is malformed', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const parsed = parseParallelSubagentsStatus('parallel:subagents:start:{not-json');
    expect(parsed).toEqual({
      kind: 'invalid',
      prefix: 'parallel:subagents:start:',
      raw: 'parallel:subagents:start:{not-json',
    });
    expect(warnSpy).toHaveBeenCalledWith(
      '[parallel-subagents-parser] invalid payload',
      expect.objectContaining({
        prefix: 'parallel:subagents:start:',
        reason: 'malformed JSON',
      }),
    );
    expect(formatParallelSubagentsBanner(parsed)).toBeNull();
    warnSpy.mockRestore();
  });

  it('parses and formats task recovery status banners', () => {
    const parsed = parseTaskRecoveryStatus('task:recovery:orphans-marked:{"count":2}');
    expect(parsed).toEqual({
      kind: 'orphans_marked',
      payload: {
        count: 2,
      },
    });
    expect(formatTaskRecoveryBanner(parsed)).toBe('Recovered 2 interrupted tasks.');
  });
});
