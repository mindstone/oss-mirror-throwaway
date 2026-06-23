/**
 * Tests for the shared Recall transcript formatter.
 *
 * Asserts it reproduces the worker's segment→"Speaker: text" derivation
 * (`meeting-bot-worker/src/index.ts:2178-2204`) exactly.
 */

import { describe, expect, it } from 'vitest';
import { formatRecallSegments } from '../recallTranscriptFormatter';

describe('formatRecallSegments', () => {
  it('joins words per segment and prefixes the speaker name', () => {
    const out = formatRecallSegments([
      { participant: { name: 'Alice' }, words: [{ text: 'hello' }, { text: 'world' }] },
      { participant: { name: 'Bob' }, words: [{ text: 'hi' }] },
    ]);
    expect(out.transcript).toBe('Alice: hello world\nBob: hi');
    expect(out.participants).toEqual(['Alice', 'Bob']);
  });

  it('defaults the speaker to Unknown and skips empty segments', () => {
    const out = formatRecallSegments([
      { words: [{ text: 'anon line' }] },
      { participant: { name: 'Carol' }, words: [] },
    ]);
    expect(out.transcript).toBe('Unknown: anon line');
    expect(out.participants).toEqual(['Unknown']);
  });

  it('computes duration as the rounded max end_timestamp.relative', () => {
    const out = formatRecallSegments([
      { participant: { name: 'A' }, words: [{ text: 'x', end_timestamp: { relative: 10.2 } }] },
      { participant: { name: 'B' }, words: [{ text: 'y', end_timestamp: { relative: 41.6 } }] },
    ]);
    expect(out.duration).toBe(42);
  });

  it('returns empty results for an empty segment list', () => {
    const out = formatRecallSegments([]);
    expect(out).toEqual({ transcript: '', participants: [], duration: 0 });
  });

  it('de-duplicates participants who speak in multiple segments', () => {
    const out = formatRecallSegments([
      { participant: { name: 'Alice' }, words: [{ text: 'one' }] },
      { participant: { name: 'Alice' }, words: [{ text: 'two' }] },
    ]);
    expect(out.participants).toEqual(['Alice']);
    expect(out.transcript).toBe('Alice: one\nAlice: two');
  });
});
