import { describe, expect, it, vi } from 'vitest';

vi.mock('@core/services/settingsStore', () => ({
  setSettingsStoreAdapter: vi.fn(),
  getSettings: vi.fn(() => ({})),
}));

import {
  createStreamState,
  flushLateReasoningBuffer,
  processStreamChunk,
  repairOrphanedToolCalls,
  translateMessagesToOpenAI,
} from '../localModelProxyServer';

type OpenAIChunkInput = {
  delta: {
    content?: string;
    reasoning_content?: string | null;
    tool_calls?: Array<{
      index: number;
      id?: string;
      type?: string;
      function?: { name?: string; arguments?: string };
    }>;
  };
  finish_reason?: 'stop' | 'tool_calls' | 'length' | null;
};

const makeChunk = ({ delta, finish_reason = null }: OpenAIChunkInput): Parameters<typeof processStreamChunk>[0] => ({
  id: 'chunk-1',
  object: 'chat.completion.chunk' as const,
  created: Date.now(),
  model: 'deepseek-v4-flash',
  choices: [
    {
      index: 0,
      delta,
      finish_reason,
    },
  ],
});

const collect = (events: Generator<string>): string[] => Array.from(events);

describe('translateMessagesToOpenAI (local proxy)', () => {
  it('preserves order for 3-turn history with text+thinking+tool_use', () => {
    const messages = [
      { role: 'user', content: 'turn-1 user' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'reasoning-1' },
          { type: 'text', text: 'turn-1 assistant' },
          { type: 'tool_use', id: 'call_1', name: 'Read', input: { path: '/tmp/a.txt' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call_1', content: 'file content' },
          { type: 'text', text: 'turn-2 user' },
        ],
      },
    ] as const;

    const result = translateMessagesToOpenAI(messages as unknown as Parameters<typeof translateMessagesToOpenAI>[0], undefined, 'deepseek-v4-flash', true);
    expect(result).toHaveLength(4);
    expect(result[0]).toEqual({ role: 'user', content: 'turn-1 user' });
    expect(result[1]).toMatchObject({
      role: 'assistant',
      content: 'turn-1 assistant',
      reasoning_content: 'reasoning-1',
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'Read', arguments: JSON.stringify({ path: '/tmp/a.txt' }) },
        },
      ],
    });
    expect(result[2]).toEqual({ role: 'tool', content: 'file content', tool_call_id: 'call_1' });
    expect(result[3]).toEqual({ role: 'user', content: 'turn-2 user' });
  });

  it('coalesces thinking_delta blocks into reasoning_content', () => {
    const result = translateMessagesToOpenAI([
      {
        role: 'assistant',
        content: [
          { type: 'thinking_delta', thinking: 'part-1 ' },
          { type: 'thinking_delta', thinking: 'part-2' },
          { type: 'text', text: 'answer' },
        ],
      },
    ] as unknown as Parameters<typeof translateMessagesToOpenAI>[0], undefined, 'deepseek-v4-flash', true);

    expect(result[0]).toMatchObject({
      role: 'assistant',
      content: 'answer',
      reasoning_content: 'part-1 part-2',
    });
  });

  it('does not emit spurious empty reasoning_content when history has no thinking blocks', () => {
    const result = translateMessagesToOpenAI([
      { role: 'assistant', content: [{ type: 'text', text: 'plain text' }] },
    ] as unknown as Parameters<typeof translateMessagesToOpenAI>[0], undefined, 'deepseek-v4-flash', true);

    expect(result[0]).toEqual({ role: 'assistant', content: 'plain text' });
    expect('reasoning_content' in result[0]).toBe(false);
  });

  it('gates reasoning_content emission by destination capability', () => {
    const result = translateMessagesToOpenAI([
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'hidden chain' },
          { type: 'text', text: 'visible answer' },
        ],
      },
    ] as unknown as Parameters<typeof translateMessagesToOpenAI>[0], undefined, 'gpt-4o-mini', false);

    expect(result[0]).toEqual({ role: 'assistant', content: 'visible answer' });
    expect('reasoning_content' in result[0]).toBe(false);
  });

  it('emits reasoning_content for each assistant message when capability is enabled', () => {
    const result = translateMessagesToOpenAI([
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'r1' },
          { type: 'text', text: 'a1' },
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'r2' },
          { type: 'text', text: 'a2' },
        ],
      },
    ] as unknown as Parameters<typeof translateMessagesToOpenAI>[0], undefined, 'deepseek-v4-flash', true);

    expect(result).toEqual([
      { role: 'assistant', content: 'a1', reasoning_content: 'r1' },
      { role: 'assistant', content: 'a2', reasoning_content: 'r2' },
    ]);
  });
});

describe('repairOrphanedToolCalls', () => {
  it('preserves assistant reasoning_content on untruncated messages', () => {
    const repaired = repairOrphanedToolCalls([
      {
        role: 'assistant',
        content: 'answer',
        reasoning_content: 'kept reasoning',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'Read', arguments: '{}' },
          },
        ],
      },
    ]);

    expect(repaired[0]).toMatchObject({
      role: 'assistant',
      content: 'answer',
      reasoning_content: 'kept reasoning',
    });
  });
});

describe('late reasoning buffer flush', () => {
  it('emits degraded-status when byte cap is hit', () => {
    const state = createStreamState();
    collect(processStreamChunk(makeChunk({ delta: { content: 'ok' }, finish_reason: 'stop' }), state, 'deepseek-v4-flash', new Map(), () => {}));
    collect(processStreamChunk(makeChunk({ delta: { reasoning_content: 'x'.repeat(300_000) } }), state, 'deepseek-v4-flash', new Map(), () => {}));

    const flushed = collect(flushLateReasoningBuffer(state));
    expect(state.lateReasoningCapHit).toBe(null);
    expect(flushed.some((event) => event.includes('event: degraded-status'))).toBe(true);
    expect(flushed.some((event) => event.includes('"cap":"bytes"'))).toBe(true);
  });

  it('emits degraded-status when chunk cap is hit', () => {
    const state = createStreamState();
    collect(processStreamChunk(makeChunk({ delta: { content: 'ok' }, finish_reason: 'stop' }), state, 'deepseek-v4-flash', new Map(), () => {}));

    for (let i = 0; i < 1000; i += 1) {
      collect(processStreamChunk(makeChunk({ delta: { reasoning_content: 'z' } }), state, 'deepseek-v4-flash', new Map(), () => {}));
    }

    const flushed = collect(flushLateReasoningBuffer(state));
    expect(flushed.some((event) => event.includes('"cap":"chunks"'))).toBe(true);
  });

  it('emits degraded-status when time cap is hit', () => {
    const state = createStreamState();
    state.lateReasoningBuffer = 'late-thinking';
    state.lateReasoningBufferedBytes = 12;
    state.lateReasoningBufferedChunks = 1;
    state.lateReasoningCapHit = 'time';

    const flushed = collect(flushLateReasoningBuffer(state));
    expect(flushed.some((event) => event.includes('event: degraded-status'))).toBe(true);
    expect(flushed.some((event) => event.includes('"cap":"time"'))).toBe(true);
  });

  it('flushes buffered late reasoning when stream closes without [DONE]', () => {
    const state = createStreamState();
    collect(processStreamChunk(makeChunk({ delta: { content: 'ok' }, finish_reason: 'stop' }), state, 'deepseek-v4-flash', new Map(), () => {}));
    collect(processStreamChunk(makeChunk({ delta: { reasoning_content: 'late tail' } }), state, 'deepseek-v4-flash', new Map(), () => {}));

    const flushed = collect(flushLateReasoningBuffer(state));
    expect(flushed.some((event) => event.includes('"type":"thinking_delta"'))).toBe(true);
    expect(flushed.some((event) => event.includes('event: degraded-status'))).toBe(false);
  });
});
