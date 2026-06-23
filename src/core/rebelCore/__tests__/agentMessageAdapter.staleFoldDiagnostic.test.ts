/**
 * Option-Z residual diagnostic (docs/plans/260616_stream-result-source-hardening).
 *
 * The context-overflow recovery path (compaction/fallback/skeleton) reuses the
 * same adapter and re-streams; recovery events deliberately do NOT clear
 * accumulatedText (locked in by agentMessageAdapter.recovery.test.ts). If a
 * re-streaming recovery ever fires AFTER assistant text was emitted, the
 * post-recovery re-stream appends to the stale partial → the persisted result
 * is pre_recovery_partial + post_recovery_text (the same doubling class as the
 * original bug, one level above the client guard).
 *
 * This file proves the NON-FATAL diagnostic fires on that shape, does NOT fire
 * on the no-re-stream case (no false positive), and never alters the result.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setErrorReporter, type ErrorReporter } from '@core/errorReporter';

const { mockLog } = vi.hoisted(() => ({
  mockLog: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));
vi.mock('@core/logger', () => ({
  createScopedLogger: () => mockLog,
}));

// Import AFTER the logger mock is registered so the module's `log` is the mock.
import { createAgentMessageAdapter } from '../agentMessageAdapter';

function makeReporterSpy(): { reporter: ErrorReporter; captureException: ReturnType<typeof vi.fn> } {
  const captureException = vi.fn();
  return {
    reporter: {
      captureException,
      captureMessage: vi.fn(),
      addBreadcrumb: vi.fn(),
    },
    captureException,
  };
}

const SILENT: ErrorReporter = {
  captureException: () => {},
  captureMessage: () => {},
  addBreadcrumb: () => {},
};

const STALE_FOLD_MESSAGE_FRAGMENT = 'Stale-fold risk';

function staleFoldWarnCalls() {
  return mockLog.warn.mock.calls.filter(
    ([, message]) => typeof message === 'string' && message.includes(STALE_FOLD_MESSAGE_FRAGMENT),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  setErrorReporter(SILENT);
  vi.clearAllMocks();
});

describe('agentMessageAdapter — recovery stale-fold diagnostic (Option-Z residual)', () => {
  it('FIRES the diagnostic when a re-streaming recovery carried pre-recovery text into a longer result', () => {
    const { reporter, captureException } = makeReporterSpy();
    setErrorReporter(reporter);

    const adapter = createAgentMessageAdapter({ model: 'test-model' });

    // Pre-recovery assistant text (len 5).
    adapter.handleEvent({ type: 'assistant:text', text: 'Hello' });
    // Context-overflow recovery fires AFTER text exists — snapshots len 5.
    adapter.handleEvent({
      type: 'recovery:fallback',
      message: 'Switching to fallback...',
      fallbackModel: 'claude-opus-4-6',
    });
    // Post-recovery re-stream appends on top of the stale partial (len 11 > 5).
    adapter.handleEvent({ type: 'assistant:text', text: ' world' });

    const resultMsgs = adapter.handleEvent({
      type: 'loop:complete',
      totalUsage: { inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0 },
    });

    // Diagnostic fired (log.warn).
    const warnCalls = staleFoldWarnCalls();
    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0][0]).toMatchObject({ preRecoveryLen: 5, finalLen: 11 });

    // Diagnostic captured to the error reporter, lengths only (no text content).
    expect(captureException).toHaveBeenCalledTimes(1);
    const [capturedError, capturedContext] = captureException.mock.calls[0];
    expect(capturedError).toBeInstanceOf(Error);
    expect(capturedContext).toMatchObject({
      tags: { area: 'rebel-core', invariant: 'recovery-stale-fold' },
      extra: { preRecoveryLen: 5, finalLen: 11 },
    });
    // No text content captured anywhere.
    expect(JSON.stringify(capturedContext)).not.toContain('Hello');
    expect(JSON.stringify(capturedContext)).not.toContain('world');

    // Result is NOT altered — today it carries the doubled text (documents the residual).
    const result = resultMsgs.find(m => (m as Record<string, unknown>).type === 'result') as Record<string, unknown>;
    expect(result?.result).toBe('Hello world');
  });

  it('does NOT fire (no false positive) when recovery events arrive with NO post-recovery re-stream', () => {
    const { reporter, captureException } = makeReporterSpy();
    setErrorReporter(reporter);

    const adapter = createAgentMessageAdapter({ model: 'test-model' });

    // Mirrors the existing "does NOT mutate accumulatedText" case: text, then a
    // run of recovery events, then loop:complete — but NO further assistant:text.
    adapter.handleEvent({ type: 'assistant:text', text: 'Hello world' });
    adapter.handleEvent({ type: 'recovery:compaction', message: 'Compacting...' });
    adapter.handleEvent({ type: 'recovery:fallback', message: 'Switching...', fallbackModel: 'model' });
    adapter.handleEvent({
      type: 'recovery:skeleton',
      message: 'Skeleton',
      droppedToolResultCount: 1,
      droppedToolUseCount: 1,
      droppedThinkingCount: 1,
      droppedImageCount: 1,
      userTextPreserved: true,
    });
    adapter.handleEvent({ type: 'context:warning', utilization: 0.8, message: 'Warning' });

    const resultMsgs = adapter.handleEvent({
      type: 'loop:complete',
      totalUsage: { inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0 },
    });

    // accumulatedText.length == snapshot (not greater) → no diagnostic.
    expect(staleFoldWarnCalls()).toHaveLength(0);
    expect(captureException).not.toHaveBeenCalled();

    const result = resultMsgs.find(m => (m as Record<string, unknown>).type === 'result') as Record<string, unknown>;
    expect(result?.result).toBe('Hello world');
  });

  it('does NOT fire when no recovery event ever occurred (plain streaming turn)', () => {
    const { reporter, captureException } = makeReporterSpy();
    setErrorReporter(reporter);

    const adapter = createAgentMessageAdapter({ model: 'test-model' });

    adapter.handleEvent({ type: 'assistant:text', text: 'Hello' });
    adapter.handleEvent({ type: 'assistant:text', text: ' world' });

    adapter.handleEvent({
      type: 'loop:complete',
      totalUsage: { inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0 },
    });

    expect(staleFoldWarnCalls()).toHaveLength(0);
    expect(captureException).not.toHaveBeenCalled();
  });

  it('does NOT fire when a recovery fired with NO pre-recovery text (recovery before any output)', () => {
    const { reporter, captureException } = makeReporterSpy();
    setErrorReporter(reporter);

    const adapter = createAgentMessageAdapter({ model: 'test-model' });

    // Normal overflow shape: recovery is pre-output. No snapshot is taken.
    adapter.handleEvent({ type: 'recovery:compaction', message: 'Compacting...' });
    adapter.handleEvent({ type: 'assistant:text', text: 'Final answer after recovery' });

    adapter.handleEvent({
      type: 'loop:complete',
      totalUsage: { inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0 },
    });

    expect(staleFoldWarnCalls()).toHaveLength(0);
    expect(captureException).not.toHaveBeenCalled();
  });

  it('does NOT fire (F1 false-positive) when a tool-use clear intervenes between the recovery and the final answer', () => {
    // F1: pre-recovery text → recovery (snapshot armed) → assistant:message with
    // tool_use (clears accumulatedText, starting a fresh segment) → tool runs →
    // a LONGER final answer streams. At loop:complete accumulatedText.length >
    // snapshot, BUT the pre-recovery text was already cleared and is NOT in the
    // result — so this is NOT a real fold. The tool-use clear resets the
    // snapshot, so the diagnostic must stay silent on this common long-context
    // tool turn.
    const { reporter, captureException } = makeReporterSpy();
    setErrorReporter(reporter);

    const adapter = createAgentMessageAdapter({ model: 'test-model' });

    adapter.handleEvent({ type: 'assistant:text', text: 'Hello' });
    adapter.handleEvent({ type: 'recovery:compaction', message: 'Compacting...' });
    // Tool-use clear: resets accumulatedText AND the recovery snapshot.
    adapter.handleEvent({
      type: 'assistant:message',
      content: [
        { type: 'text', text: 'Hello' },
        { type: 'tool_use', id: 'tool-1', name: 'search', input: {} },
      ],
    });
    // Fresh segment: a longer final answer than the pre-recovery 'Hello' (len 5).
    adapter.handleEvent({ type: 'assistant:text', text: 'A much longer clean final answer' });

    const resultMsgs = adapter.handleEvent({
      type: 'loop:complete',
      totalUsage: { inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0 },
    });

    // No false fold report.
    expect(staleFoldWarnCalls()).toHaveLength(0);
    expect(captureException).not.toHaveBeenCalled();

    // Result is the clean post-clear answer — pre-recovery 'Hello' is not folded in.
    const result = resultMsgs.find(m => (m as Record<string, unknown>).type === 'result') as Record<string, unknown>;
    expect(result?.result).toBe('A much longer clean final answer');
  });

  it('FIRES again when a real fold happens AFTER a tool-use clear (snapshot re-arms in the new segment)', () => {
    // Confirms the reset does not over-suppress: tool → clear → text 'A' →
    // recovery (snapshot re-armed in the post-clear segment) → re-stream 'AB' →
    // a genuine stale fold within that segment → diagnostic fires.
    const { reporter, captureException } = makeReporterSpy();
    setErrorReporter(reporter);

    const adapter = createAgentMessageAdapter({ model: 'test-model' });

    // First segment ends with a tool-use clear.
    adapter.handleEvent({ type: 'assistant:text', text: 'pre-tool narration' });
    adapter.handleEvent({
      type: 'assistant:message',
      content: [{ type: 'tool_use', id: 'tool-1', name: 'search', input: {} }],
    });

    // New segment: text 'A' (len 1), recovery re-arms the snapshot, then a fold.
    adapter.handleEvent({ type: 'assistant:text', text: 'A' });
    adapter.handleEvent({ type: 'recovery:fallback', message: 'Switching...', fallbackModel: 'm' });
    adapter.handleEvent({ type: 'assistant:text', text: 'B' });

    adapter.handleEvent({
      type: 'loop:complete',
      totalUsage: { inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0 },
    });

    const warnCalls = staleFoldWarnCalls();
    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0][0]).toMatchObject({ preRecoveryLen: 1, finalLen: 2 });
    expect(captureException).toHaveBeenCalledTimes(1);
  });
});
