import { describe, expect, it } from 'vitest';
import { createAgentMessageAdapter } from '../agentMessageAdapter';

describe('agentMessageAdapter recovery event handling', () => {
  const adapter = createAgentMessageAdapter({ model: 'test-model' });

  it('maps recovery:compaction to status message', () => {
    const msgs = adapter.handleEvent({ type: 'recovery:compaction', message: 'Compacting...' });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ type: 'system', subtype: 'status' });
    expect((msgs[0] as Record<string, unknown>).message).toBe('Compacting...');
  });

  it('maps recovery:fallback to status message', () => {
    const msgs = adapter.handleEvent({
      type: 'recovery:fallback',
      message: 'Switching to claude-opus...',
      fallbackModel: 'claude-opus-4-6',
    });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ type: 'system', subtype: 'status' });
  });

  it('maps recovery:skeleton to status message with uuid', () => {
    const message = 'Skeleton mode engaged.';
    const msgs = adapter.handleEvent({
      type: 'recovery:skeleton',
      message,
      droppedToolResultCount: 3,
      droppedToolUseCount: 1,
      droppedThinkingCount: 2,
      droppedImageCount: 4,
      userTextPreserved: true,
    });

    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ type: 'system', subtype: 'status', message });
    expect((msgs[0] as Record<string, unknown>).uuid).not.toBeNull();
  });

  it('maps context:warning to status message', () => {
    const msgs = adapter.handleEvent({
      type: 'context:warning',
      utilization: 0.75,
      message: 'Context nearing capacity',
    });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ type: 'system', subtype: 'status' });
  });

  it('does NOT mutate accumulatedText for recovery events', () => {
    const fresh = createAgentMessageAdapter({ model: 'test-model' });

    // Accumulate some text first
    fresh.handleEvent({ type: 'assistant:text', text: 'Hello world' });

    // Fire recovery events
    fresh.handleEvent({ type: 'recovery:compaction', message: 'Compacting...' });
    fresh.handleEvent({ type: 'recovery:fallback', message: 'Switching...', fallbackModel: 'model' });
    fresh.handleEvent({
      type: 'recovery:skeleton',
      message: 'Skeleton',
      droppedToolResultCount: 1,
      droppedToolUseCount: 1,
      droppedThinkingCount: 1,
      droppedImageCount: 1,
      userTextPreserved: true,
    });
    fresh.handleEvent({ type: 'context:warning', utilization: 0.8, message: 'Warning' });

    // Complete the loop — accumulatedText should still contain 'Hello world'
    const resultMsgs = fresh.handleEvent({
      type: 'loop:complete',
      totalUsage: { inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0 },
    });

    const result = resultMsgs.find(m => (m as Record<string, unknown>).type === 'result') as Record<string, unknown>;
    expect(result?.result).toBe('Hello world');
  });

  it('does NOT mutate turns counter for recovery events', () => {
    const fresh = createAgentMessageAdapter({ model: 'test-model' });

    fresh.handleEvent({ type: 'recovery:compaction', message: 'Compacting...' });
    fresh.handleEvent({ type: 'recovery:compaction', message: 'Compacting again...' });
    fresh.handleEvent({ type: 'recovery:fallback', message: 'Switching...', fallbackModel: 'model' });
    fresh.handleEvent({
      type: 'recovery:skeleton',
      message: 'Skeleton',
      droppedToolResultCount: 1,
      droppedToolUseCount: 1,
      droppedThinkingCount: 1,
      droppedImageCount: 1,
      userTextPreserved: true,
    });

    // Complete with explicit turn count tracking
    fresh.handleEvent({
      type: 'turn:complete',
      usage: { inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0 },
      stopReason: 'end_turn',
    });

    const resultMsgs = fresh.handleEvent({
      type: 'loop:complete',
      totalUsage: { inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0 },
    });

    const result = resultMsgs.find(m => (m as Record<string, unknown>).type === 'result') as Record<string, unknown>;
    expect(result?.num_turns).toBe(1);
  });
});
