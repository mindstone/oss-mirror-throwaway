import { describe, it, expect, vi } from 'vitest';

vi.mock('@core/services/settingsStore', () => ({
  setSettingsStoreAdapter: vi.fn(),
  getSettings: vi.fn(() => ({})),
}));

import { repairOrphanedToolCalls } from '../localModelProxyServer';

describe('repairOrphanedToolCalls', () => {
  it('returns messages unchanged when no orphans exist', () => {
    const messages = [
      { role: 'user' as const, content: 'hello' },
      {
        role: 'assistant' as const,
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function' as const, function: { name: 'Read', arguments: '{}' } }],
      },
      { role: 'tool' as const, content: 'file contents', tool_call_id: 'call_1' },
      { role: 'assistant' as const, content: 'Done.' },
    ];
    const result = repairOrphanedToolCalls(messages);
    expect(result).toBe(messages); // same reference — no copy needed
  });

  it('synthesizes placeholder for orphaned tool call (missing tool result)', () => {
    const messages = [
      { role: 'user' as const, content: 'hello' },
      {
        role: 'assistant' as const,
        content: null,
        tool_calls: [{ id: 'call_orphan', type: 'function' as const, function: { name: 'Write', arguments: '{}' } }],
      },
      // No tool message for call_orphan — runtime compacted it away
      { role: 'user' as const, content: 'continue' },
    ];
    const result = repairOrphanedToolCalls(messages);
    expect(result).toHaveLength(4); // original 3 + 1 synthetic
    expect(result[2]).toEqual({
      role: 'tool',
      content: '[Tool output unavailable — conversation was summarized]',
      tool_call_id: 'call_orphan',
    });
    expect(result[3]).toEqual({ role: 'user', content: 'continue' });
  });

  it('removes orphaned tool result (no matching tool call)', () => {
    const messages = [
      { role: 'user' as const, content: 'hello' },
      // No preceding assistant with tool_calls for call_gone
      { role: 'tool' as const, content: 'stale result', tool_call_id: 'call_gone' },
      { role: 'assistant' as const, content: 'Done.' },
    ];
    const result = repairOrphanedToolCalls(messages);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ role: 'user', content: 'hello' });
    expect(result[1]).toEqual({ role: 'assistant', content: 'Done.' });
  });

  it('handles multiple orphaned calls in one assistant message', () => {
    const messages = [
      {
        role: 'assistant' as const,
        content: 'Doing three things',
        tool_calls: [
          { id: 'call_a', type: 'function' as const, function: { name: 'Read', arguments: '{}' } },
          { id: 'call_b', type: 'function' as const, function: { name: 'Write', arguments: '{}' } },
          { id: 'call_c', type: 'function' as const, function: { name: 'Search', arguments: '{}' } },
        ],
      },
      { role: 'tool' as const, content: 'result a', tool_call_id: 'call_a' },
      // call_b and call_c have no results
      { role: 'assistant' as const, content: 'Next step' },
    ];
    const result = repairOrphanedToolCalls(messages);
    // Original: assistant, tool(a), assistant
    // Repaired: assistant, synthetic(b), synthetic(c), tool(a), assistant
    // Synthetics are inserted right after the assistant; real tool(a) follows.
    // OpenAI matches by ID, so order among tool messages doesn't matter.
    expect(result).toHaveLength(5);
    expect(result[0].role).toBe('assistant');
    expect(result[1].tool_call_id).toBe('call_b');
    expect(result[2].tool_call_id).toBe('call_c');
    expect(result[3]).toEqual({ role: 'tool', content: 'result a', tool_call_id: 'call_a' });
    expect(result[4]).toEqual({ role: 'assistant', content: 'Next step' });
  });

  it('handles mixed orphaned calls and results simultaneously', () => {
    const messages = [
      { role: 'tool' as const, content: 'orphaned result', tool_call_id: 'call_old' },
      {
        role: 'assistant' as const,
        content: null,
        tool_calls: [{ id: 'call_new', type: 'function' as const, function: { name: 'Bash', arguments: '{}' } }],
      },
      { role: 'user' as const, content: 'keep going' },
    ];
    const result = repairOrphanedToolCalls(messages);
    // Orphaned result removed, synthetic result added for call_new
    expect(result).toHaveLength(3);
    expect(result[0].role).toBe('assistant');
    expect(result[1]).toEqual({
      role: 'tool',
      content: '[Tool output unavailable — conversation was summarized]',
      tool_call_id: 'call_new',
    });
    expect(result[2]).toEqual({ role: 'user', content: 'keep going' });
  });

  it('does not touch messages without tool calls', () => {
    const messages = [
      { role: 'user' as const, content: 'hello' },
      { role: 'assistant' as const, content: 'hi there' },
      { role: 'user' as const, content: 'bye' },
    ];
    const result = repairOrphanedToolCalls(messages);
    expect(result).toBe(messages);
  });
});

describe('repairOrphanedToolCalls diagnostic event emits', () => {
  let appendSpy: ReturnType<typeof vi.fn>;
  let repairOrphanedToolCallsReloaded: typeof repairOrphanedToolCalls;

  beforeEach(async () => {
    vi.resetModules();
    appendSpy = vi.fn();
     
    vi.doMock('@core/services/diagnosticEventsLedger', () => ({
      appendDiagnosticEvent: appendSpy,
    }));
    const mod = await import('../localModelProxyServer');
    repairOrphanedToolCallsReloaded = mod.repairOrphanedToolCalls;
  });

  afterEach(() => {
    vi.doUnmock('@core/services/diagnosticEventsLedger');
  });

  it('emits SEPARATE orphan_tool_use and orphan_tool_result events when both kinds present (A7)', () => {
    const messages = [
      { role: 'tool' as const, content: 'orphaned result', tool_call_id: 'call_old' },
      {
        role: 'assistant' as const,
        content: null,
        tool_calls: [{ id: 'call_new', type: 'function' as const, function: { name: 'Bash', arguments: '{}' } }],
      },
      { role: 'user' as const, content: 'keep going' },
    ];
    repairOrphanedToolCallsReloaded(messages);

    const useCalls = appendSpy.mock.calls.filter(
      ([entry]) => entry?.kind === 'streaming_invariant' && entry?.data?.violation === 'orphan_tool_use',
    );
    const resultCalls = appendSpy.mock.calls.filter(
      ([entry]) => entry?.kind === 'streaming_invariant' && entry?.data?.violation === 'orphan_tool_result',
    );

    expect(useCalls).toHaveLength(1);
    expect(resultCalls).toHaveLength(1);
    expect(useCalls[0][0].data).toMatchObject({ occurrenceCount: 1, repaired: true });
    expect(resultCalls[0][0].data).toMatchObject({ occurrenceCount: 1, repaired: true });
  });
});
