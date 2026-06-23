import { describe, expect, it } from 'vitest';
import { createAgentMessageAdapter } from '../agentMessageAdapter';

describe('RebelCoreAgentMessageAdapter accumulatedText reset on tool turns', () => {
  const makeAdapter = () =>
    createAgentMessageAdapter({
      model: 'claude-sonnet-4-20250514',
      tools: ['Read', 'Bash'],
      sessionId: 'test-session',
      cwd: '/tmp',
    });

  it('resets accumulatedText when assistant:message contains tool_use', () => {
    const adapter = makeAdapter();

    // Simulate pre-tool text streaming (plan narration)
    adapter.handleEvent({ type: 'assistant:text', text: 'Let me plan this out...' });

    // assistant:message with tool_use — should reset accumulated text
    adapter.handleEvent({
      type: 'assistant:message',
      content: [
        { type: 'text', text: 'Let me plan this out...' },
        { type: 'tool_use', id: 'tu_1', name: 'Read', input: { path: '/tmp/test' } },
      ],
    });

    // Post-tool text (the actual user-facing response)
    adapter.handleEvent({ type: 'assistant:text', text: 'Done! Here is the result.' });

    // Finalize with loop:complete
    const results = adapter.handleEvent({
      type: 'loop:complete',
      totalUsage: { inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0 },
    });

    const resultMessage = results.find((m) => m.type === 'result');
    expect(resultMessage).toBeDefined();
    expect((resultMessage as any).result).toBe('Done! Here is the result.');
    expect((resultMessage as any).result).not.toContain('Let me plan this out');
  });

  it('preserves accumulatedText when assistant:message has no tool_use', () => {
    const adapter = makeAdapter();

    adapter.handleEvent({ type: 'assistant:text', text: 'Here is your answer.' });

    // assistant:message with only text — no tool_use
    adapter.handleEvent({
      type: 'assistant:message',
      content: [{ type: 'text', text: 'Here is your answer.' }],
    });

    const results = adapter.handleEvent({
      type: 'loop:complete',
      totalUsage: { inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0 },
    });

    const resultMessage = results.find((m) => m.type === 'result');
    expect((resultMessage as any).result).toBe('Here is your answer.');
  });

  it('accumulates only final-turn text across multiple tool turns', () => {
    const adapter = makeAdapter();

    // Turn 1: plan text + tool
    adapter.handleEvent({ type: 'assistant:text', text: 'Planning step 1...' });
    adapter.handleEvent({
      type: 'assistant:message',
      content: [
        { type: 'text', text: 'Planning step 1...' },
        { type: 'tool_use', id: 'tu_1', name: 'Read', input: {} },
      ],
    });
    adapter.handleEvent({
      type: 'turn:complete',
      usage: { inputTokens: 50, outputTokens: 25, cacheCreationTokens: 0, cacheReadTokens: 0 },
      stopReason: 'tool_use',
    });

    // Turn 2: more narration + tool
    adapter.handleEvent({ type: 'assistant:text', text: 'Now doing step 2...' });
    adapter.handleEvent({
      type: 'assistant:message',
      content: [
        { type: 'text', text: 'Now doing step 2...' },
        { type: 'tool_use', id: 'tu_2', name: 'Bash', input: {} },
      ],
    });
    adapter.handleEvent({
      type: 'turn:complete',
      usage: { inputTokens: 50, outputTokens: 25, cacheCreationTokens: 0, cacheReadTokens: 0 },
      stopReason: 'tool_use',
    });

    // Turn 3: final response (no tools)
    adapter.handleEvent({ type: 'assistant:text', text: 'All done. Email sent.' });
    adapter.handleEvent({
      type: 'assistant:message',
      content: [{ type: 'text', text: 'All done. Email sent.' }],
    });
    adapter.handleEvent({
      type: 'turn:complete',
      usage: { inputTokens: 50, outputTokens: 25, cacheCreationTokens: 0, cacheReadTokens: 0 },
      stopReason: 'end_turn',
    });

    const results = adapter.handleEvent({
      type: 'loop:complete',
      totalUsage: { inputTokens: 150, outputTokens: 75, cacheCreationTokens: 0, cacheReadTokens: 0 },
    });

    const resultMessage = results.find((m) => m.type === 'result');
    expect((resultMessage as any).result).toBe('All done. Email sent.');
    expect((resultMessage as any).result).not.toContain('Planning step 1');
    expect((resultMessage as any).result).not.toContain('Now doing step 2');
  });

  // Regression: false-positive empty_result_anomaly with loop-total tokens
  // See docs/plans/260417_empty_result_anomaly_resilience.md (Bug 1)
  //
  // loop:complete result carries TWO token fields:
  //   - usage.output_tokens: loop-total across all turns
  //   - last_turn_output_tokens: final turn only (used by anomaly detector)
  //
  // When an earlier tool turn consumed tokens but the final turn was empty,
  // last_turn_output_tokens must be 0 even though the loop-total is positive.
  it('exposes last_turn_output_tokens from the final turn (not loop total)', () => {
    const adapter = makeAdapter();

    // Turn 1: substantial narration + tool use (25 output tokens)
    adapter.handleEvent({ type: 'assistant:text', text: 'Let me check the file first.' });
    adapter.handleEvent({
      type: 'assistant:message',
      content: [
        { type: 'text', text: 'Let me check the file first.' },
        { type: 'tool_use', id: 'tu_1', name: 'Read', input: {} },
      ],
    });
    adapter.handleEvent({
      type: 'turn:complete',
      usage: { inputTokens: 100, outputTokens: 25, cacheCreationTokens: 0, cacheReadTokens: 0 },
      stopReason: 'tool_use',
    });

    // Turn 2: final turn is empty (0 output tokens) — "model done after tools"
    adapter.handleEvent({
      type: 'assistant:message',
      content: [],
    });
    adapter.handleEvent({
      type: 'turn:complete',
      usage: { inputTokens: 200, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
      stopReason: 'end_turn',
    });

    const results = adapter.handleEvent({
      type: 'loop:complete',
      totalUsage: { inputTokens: 300, outputTokens: 25, cacheCreationTokens: 0, cacheReadTokens: 0 },
    });

    const resultMessage = results.find((m) => m.type === 'result');
    expect(resultMessage).toBeDefined();

    // last_turn_output_tokens reflects only the final turn (0)
    expect((resultMessage as any).last_turn_output_tokens).toBe(0);

    // usage.output_tokens reflects the loop-total (25 from turn 1)
    expect((resultMessage as any).usage.output_tokens).toBe(25);
  });

  it('exposes last_turn_output_tokens when final turn has content', () => {
    const adapter = makeAdapter();

    // Turn 1: narration + tool
    adapter.handleEvent({ type: 'assistant:text', text: 'Checking...' });
    adapter.handleEvent({
      type: 'assistant:message',
      content: [
        { type: 'text', text: 'Checking...' },
        { type: 'tool_use', id: 'tu_1', name: 'Read', input: {} },
      ],
    });
    adapter.handleEvent({
      type: 'turn:complete',
      usage: { inputTokens: 100, outputTokens: 20, cacheCreationTokens: 0, cacheReadTokens: 0 },
      stopReason: 'tool_use',
    });

    // Turn 2: final response (40 tokens)
    adapter.handleEvent({ type: 'assistant:text', text: 'Here is the result.' });
    adapter.handleEvent({
      type: 'assistant:message',
      content: [{ type: 'text', text: 'Here is the result.' }],
    });
    adapter.handleEvent({
      type: 'turn:complete',
      usage: { inputTokens: 150, outputTokens: 40, cacheCreationTokens: 0, cacheReadTokens: 0 },
      stopReason: 'end_turn',
    });

    const results = adapter.handleEvent({
      type: 'loop:complete',
      totalUsage: { inputTokens: 250, outputTokens: 60, cacheCreationTokens: 0, cacheReadTokens: 0 },
    });

    const resultMessage = results.find((m) => m.type === 'result');
    expect((resultMessage as any).last_turn_output_tokens).toBe(40);
    expect((resultMessage as any).usage.output_tokens).toBe(60);
  });

  // Regression: rebel://conversation/c75180b3-a3c3-4aa3-b637-0efa162f9fa1
  // When the agent's only turn contains text + tool_use and the loop ends
  // immediately after (no post-tool text), the result should use the
  // lastClearedText fallback instead of returning empty string.
  it('uses lastClearedText fallback when loop ends after tool_use with no post-tool text', () => {
    const adapter = makeAdapter();

    // Agent streams a greeting
    adapter.handleEvent({ type: 'assistant:text', text: 'Hey Greg!' });

    // assistant:message with text + tool_use — clears accumulatedText, saves to lastClearedText
    adapter.handleEvent({
      type: 'assistant:message',
      content: [
        { type: 'text', text: 'Hey Greg!' },
        { type: 'tool_use', id: 'tu_1', name: 'Read', input: { path: '/tmp/test' } },
      ],
    });

    // turn:complete for tool_use
    adapter.handleEvent({
      type: 'turn:complete',
      usage: { inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0 },
      stopReason: 'tool_use',
    });

    // Loop ends immediately — no post-tool text was streamed
    const results = adapter.handleEvent({
      type: 'loop:complete',
      totalUsage: { inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0 },
    });

    const resultMessage = results.find((m) => m.type === 'result');
    expect(resultMessage).toBeDefined();
    expect((resultMessage as any).result).toBe('Hey Greg!');
  });
});
