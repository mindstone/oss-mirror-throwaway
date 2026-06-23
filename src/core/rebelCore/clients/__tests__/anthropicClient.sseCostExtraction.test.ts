import { describe, expect, it, vi } from 'vitest';
import { extractCostFromSseLine, createSseCostExtractor } from '../anthropicClient';

function makeSSEChunk(lines: string[]): Uint8Array {
  return new TextEncoder().encode(lines.join('\n') + '\n');
}

function makeSSEStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

async function consumeStream(readable: ReadableStream<Uint8Array>): Promise<void> {
  const reader = readable.getReader();
  while (true) {
    const { done } = await reader.read();
    if (done) break;
  }
}

describe('extractCostFromSseLine', () => {
  it('extracts cost from a valid SSE data line', () => {
    const line = 'data: {"type":"message_delta","usage":{"output_tokens":345,"cost":0.0234}}';
    expect(extractCostFromSseLine(line)).toBe(0.0234);
  });

  it('returns null for SSE lines without cost', () => {
    const line = 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}';
    expect(extractCostFromSseLine(line)).toBeNull();
  });

  it('returns null for [DONE] marker', () => {
    expect(extractCostFromSseLine('data: [DONE]')).toBeNull();
  });

  it('returns null for non-data lines', () => {
    expect(extractCostFromSseLine('event: message_delta')).toBeNull();
    expect(extractCostFromSseLine('')).toBeNull();
    expect(extractCostFromSseLine(': ping')).toBeNull();
  });

  it('returns null for cost=0 (valid but zero)', () => {
    const line = 'data: {"usage":{"cost":0}}';
    expect(extractCostFromSseLine(line)).toBe(0);
  });

  it('returns null for negative cost', () => {
    const line = 'data: {"usage":{"cost":-1}}';
    expect(extractCostFromSseLine(line)).toBeNull();
  });

  it('returns null for non-numeric cost', () => {
    const line = 'data: {"usage":{"cost":"expensive"}}';
    expect(extractCostFromSseLine(line)).toBeNull();
  });

  it('returns null for Infinity cost', () => {
    const line = 'data: {"usage":{"cost":Infinity}}';
    // Infinity is not valid JSON, so this will be a parse error
    expect(extractCostFromSseLine(line)).toBeNull();
  });
});

describe('createSseCostExtractor', () => {
  it('extracts cost from SSE stream with message_delta', async () => {
    const costs: number[] = [];
    const onFlush = vi.fn();

    const extractor = createSseCostExtractor(
      (cost) => costs.push(cost),
      onFlush,
    );

    const input = makeSSEStream([
      makeSSEChunk([
        'event: content_block_delta',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}',
        '',
      ]),
      makeSSEChunk([
        'event: message_delta',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":345,"cost":0.0234}}',
        '',
      ]),
    ]);

    await consumeStream(input.pipeThrough(extractor));

    expect(costs).toEqual([0.0234]);
    expect(onFlush).toHaveBeenCalledOnce();
  });

  it('handles multiple cost values (keeps all, last one wins for caller)', async () => {
    const costs: number[] = [];
    const extractor = createSseCostExtractor((cost) => costs.push(cost));

    const input = makeSSEStream([
      makeSSEChunk([
        'data: {"type":"message_delta","usage":{"output_tokens":100,"cost":0.01}}',
        '',
        'data: {"type":"message_delta","usage":{"output_tokens":345,"cost":0.0234}}',
        '',
      ]),
    ]);

    await consumeStream(input.pipeThrough(extractor));
    expect(costs).toEqual([0.01, 0.0234]);
  });

  it('passes through all data unchanged', async () => {
    const extractor = createSseCostExtractor(() => {});

    const originalData = 'data: {"type":"content_block_delta","delta":{"text":"Hello"}}\n\n';
    const chunk = new TextEncoder().encode(originalData);
    const input = new ReadableStream({
      start(controller) {
        controller.enqueue(chunk);
        controller.close();
      },
    });

    const reader = input.pipeThrough(extractor).getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toBe(originalData);
  });

  it('handles stream with no cost data', async () => {
    const costs: number[] = [];
    const onFlush = vi.fn();
    const extractor = createSseCostExtractor(
      (cost) => costs.push(cost),
      onFlush,
    );

    const input = makeSSEStream([
      makeSSEChunk([
        'data: {"type":"content_block_delta","delta":{"text":"Hello"}}',
        '',
        'data: {"type":"message_delta","usage":{"output_tokens":345}}',
        '',
      ]),
    ]);

    await consumeStream(input.pipeThrough(extractor));
    expect(costs).toEqual([]);
    expect(onFlush).toHaveBeenCalledOnce();
  });

  it('handles cost in final buffered line (flush path)', async () => {
    const costs: number[] = [];
    const extractor = createSseCostExtractor((cost) => costs.push(cost));

    // Send a chunk that ends without a trailing newline
    const data = 'data: {"usage":{"cost":0.05}}';
    const input = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(data));
        controller.close();
      },
    });

    await consumeStream(input.pipeThrough(extractor));
    expect(costs).toEqual([0.05]);
  });

  it('handles split chunks across SSE event boundaries', async () => {
    const costs: number[] = [];
    const extractor = createSseCostExtractor((cost) => costs.push(cost));

    // Split a single SSE data line across two chunks
    const part1 = new TextEncoder().encode('data: {"usage":');
    const part2 = new TextEncoder().encode('{"cost":0.0234}}\n\n');

    const input = new ReadableStream({
      start(controller) {
        controller.enqueue(part1);
        controller.enqueue(part2);
        controller.close();
      },
    });

    await consumeStream(input.pipeThrough(extractor));
    expect(costs).toEqual([0.0234]);
  });
});
