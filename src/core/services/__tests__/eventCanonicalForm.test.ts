import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@shared/types/agent';
import { canonicalizeEvent } from '../eventCanonicalForm';

function expectKeysSortedDeep(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach(expectKeysSortedDeep);
    return;
  }

  const keys = Object.keys(value as Record<string, unknown>);
  const sorted = [...keys].sort();
  expect(keys).toEqual(sorted);
  for (const key of keys) {
    expectKeysSortedDeep((value as Record<string, unknown>)[key]);
  }
}

describe('eventCanonicalForm', () => {
  it('pins a stable canonical output fixture', () => {
    const event = {
      type: 'tool',
      toolName: 'search_docs',
      detail: 'done',
      stage: 'end',
      timestamp: 1_710_000_000_000,
      seq: 42,
      serverSeq: 7_001,
      cloudUpdatedAt: 9_999_999,
      toolResult: {
        structuredContent: {
          beta: { zeta: 2, alpha: 1 },
          alpha: { nested: { b: 'two', a: 'one' } },
        },
        content: [
          {
            type: 'content_ref',
            contentRef: {
              mimeType: 'text/plain',
              contentId: 'blob-1',
              byteSize: 12,
            },
          },
          {
            type: 'text',
            text: 'summary',
            meta: { z: 9, a: 1 },
          },
        ],
      },
    } as AgentEvent;

    // This value is the cross-runtime reference fixture. If Hermes ever
    // disagrees with this output, keep this V8 value pinned as source-of-truth.
    const expected = '{"detail":"done","stage":"end","timestamp":1710000000000,"toolName":"search_docs","toolResult":{"content":[{"contentRef":{"byteSize":12,"contentId":"blob-1","mimeType":"text/plain"},"type":"content_ref"},{"meta":{"a":1,"z":9},"text":"summary","type":"text"}],"structuredContent":{"alpha":{"nested":{"a":"one","b":"two"}},"beta":{"alpha":1,"zeta":2}}},"type":"tool"}';
    expect(canonicalizeEvent(event)).toBe(expected);
  });

  it('is stable across property declaration order', () => {
    const first = {
      type: 'status',
      message: 'ok',
      timestamp: 101,
      nested: { z: 2, a: 1 },
    } as AgentEvent;

    const second = {
      nested: { a: 1, z: 2 },
      timestamp: 101,
      message: 'ok',
      type: 'status',
    } as AgentEvent;

    expect(canonicalizeEvent(first)).toBe(canonicalizeEvent(second));
  });

  it('excludes top-level seq fields from canonical output', () => {
    const lowSeq = {
      type: 'assistant',
      text: 'hello',
      timestamp: 11,
      seq: 1,
    } as AgentEvent;

    const highSeq = {
      type: 'assistant',
      text: 'hello',
      timestamp: 11,
      seq: 999_999,
    } as AgentEvent;

    expect(canonicalizeEvent(lowSeq)).toBe(canonicalizeEvent(highSeq));
  });

  it('sorts keys recursively at every nested object level', () => {
    const event = {
      type: 'tool',
      toolName: 'nested',
      detail: 'ok',
      stage: 'end',
      timestamp: 123,
      toolResult: {
        structuredContent: {
          omega: { k2: 'v2', k1: 'v1' },
          alpha: {
            gamma: [
              { b: 2, a: 1 },
              { d: 4, c: 3 },
            ],
            delta: { z: 2, a: 1 },
          },
        },
      },
    } as AgentEvent;

    const parsed = JSON.parse(canonicalizeEvent(event));
    expectKeysSortedDeep(parsed);
  });
});
