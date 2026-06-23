import { describe, it, expect } from 'vitest';
import {
  extractFirstJsonObject,
  boundContextState,
  contextStateFailureToLedgerReason,
  CONTEXT_STATE_MAX_ITEMS_PER_CATEGORY,
  CONTEXT_STATE_MAX_SUMMARY_CHARS,
} from '../contextStateUpdate';
import { createEmptyContextState } from '../taskState';
import type { RebelCoreContextState } from '../taskState';

describe('extractFirstJsonObject', () => {
  it('extracts a bare JSON object', () => {
    expect(extractFirstJsonObject('{"a":1}')).toBe('{"a":1}');
  });

  it('extracts JSON wrapped in prose (old greedy regex would over-span)', () => {
    const text = 'Here is the state: {"a":1} — note: see {example} for details.';
    // The old /\{.*\}/s would grab `{"a":1} — note: see {example}` (invalid JSON).
    expect(extractFirstJsonObject(text)).toBe('{"a":1}');
  });

  it('extracts JSON from inside a markdown code fence', () => {
    const text = '```json\n{"goals":"ship it"}\n```';
    expect(extractFirstJsonObject(text)).toBe('{"goals":"ship it"}');
  });

  it('handles nested objects and braces inside string values', () => {
    const json = '{"a":{"b":2},"note":"a } brace { in a string"}';
    expect(extractFirstJsonObject(`prefix ${json} suffix`)).toBe(json);
  });

  it('handles escaped quotes inside strings', () => {
    const json = '{"q":"she said \\"hi\\" }"}';
    expect(extractFirstJsonObject(json)).toBe(json);
  });

  it('returns null for truncated output (never-closed object)', () => {
    expect(extractFirstJsonObject('{"a":1, "b": [1,2,3')).toBeNull();
  });

  it('returns null when there is no object at all', () => {
    expect(extractFirstJsonObject('no json here')).toBeNull();
  });

  it('returns the first balanced object (caller validates it as JSON)', () => {
    // Extraction is balance-based, not parse-based: it returns the first balanced
    // {...}; the caller JSON-parses and attributes parse_error if invalid.
    expect(extractFirstJsonObject('see {"taskContext":{"goals":"g"}} ok')).toBe(
      '{"taskContext":{"goals":"g"}}',
    );
  });
});

describe('boundContextState', () => {
  function stateWith(overrides: Partial<RebelCoreContextState>): RebelCoreContextState {
    return { ...createEmptyContextState(), ...overrides };
  }

  it('caps each append-prone array to the most-recent N items', () => {
    const n = CONTEXT_STATE_MAX_ITEMS_PER_CATEGORY;
    const artifacts = Array.from({ length: n + 25 }, (_, i) => ({ pathOrUrl: `f${i}.ts`, identifier: `id${i}` }));
    const bounded = boundContextState(stateWith({ artifacts }));
    expect(bounded.artifacts).toHaveLength(n);
    // Keeps the most-recent (tail) items.
    expect(bounded.artifacts[bounded.artifacts.length - 1].pathOrUrl).toBe(`f${n + 24}.ts`);
    expect(bounded.artifacts[0].pathOrUrl).toBe(`f25.ts`);
  });

  it('dedupes by key, keeping the most-recent occurrence', () => {
    const constraints = ['a', 'b', 'a', 'c', 'b'];
    const bounded = boundContextState(stateWith({ constraints }));
    expect(bounded.constraints).toEqual(['a', 'c', 'b']);
  });

  it('does NOT collapse artifacts that share a path but differ by identifier', () => {
    const artifacts = [
      { pathOrUrl: 'proposal.docx', identifier: 'budget table' },
      { pathOrUrl: 'proposal.docx', identifier: 'risk table' },
    ];
    const bounded = boundContextState(stateWith({ artifacts }));
    expect(bounded.artifacts).toHaveLength(2);
  });

  it('collapses genuinely identical artifacts', () => {
    const artifacts = [
      { pathOrUrl: 'a.ts', identifier: 'x' },
      { pathOrUrl: 'a.ts', identifier: 'x' },
    ];
    expect(boundContextState(stateWith({ artifacts })).artifacts).toHaveLength(1);
  });

  it('bounds all four progressState arrays', () => {
    const n = CONTEXT_STATE_MAX_ITEMS_PER_CATEGORY;
    const big = Array.from({ length: n + 10 }, (_, i) => `item-${i}`);
    const bounded = boundContextState(stateWith({
      progressState: { accomplished: big, remaining: big, blockers: big, failedApproaches: big },
    }));
    expect(bounded.progressState.accomplished).toHaveLength(n);
    expect(bounded.progressState.remaining).toHaveLength(n);
    expect(bounded.progressState.blockers).toHaveLength(n);
    expect(bounded.progressState.failedApproaches).toHaveLength(n);
  });

  it('truncates an over-long rolling summary keeping the most-recent (tail) text', () => {
    // Sentinel at the END must survive — "recent context" keeps the tail.
    const summary = 'x'.repeat(CONTEXT_STATE_MAX_SUMMARY_CHARS + 500) + 'NEWEST_SENTINEL';
    const bounded = boundContextState(stateWith({ recentContextSummary: summary }));
    expect(bounded.recentContextSummary.endsWith('NEWEST_SENTINEL')).toBe(true);
    expect(bounded.recentContextSummary.startsWith('…[earlier truncated] ')).toBe(true);
    // Bounded: marker prefix (~21 chars) + the most-recent CONTEXT_STATE_MAX_SUMMARY_CHARS.
    expect(bounded.recentContextSummary.length).toBeLessThanOrEqual(CONTEXT_STATE_MAX_SUMMARY_CHARS + 25);
  });

  it('is idempotent (bounding an already-bounded state is a no-op)', () => {
    const n = CONTEXT_STATE_MAX_ITEMS_PER_CATEGORY;
    const artifacts = Array.from({ length: n + 30 }, (_, i) => ({ pathOrUrl: `f${i}.ts`, identifier: `id${i}` }));
    const once = boundContextState(stateWith({ artifacts }));
    const twice = boundContextState(once);
    expect(twice).toEqual(once);
  });

  it('leaves a small real-world state untouched', () => {
    const state = stateWith({
      taskContext: { goals: 'ship deck', constraints: 'by Friday', requirements: '' },
      keyDecisions: [{ choice: 'use pipeline', rationale: 'fast', rejectedAlternatives: ['manual'] }],
      artifacts: [{ pathOrUrl: 'deck.pptx', identifier: 'deck' }],
    });
    expect(boundContextState(state)).toEqual(state);
  });
});

describe('contextStateFailureToLedgerReason', () => {
  it('maps truncation to the distinct truncated ledger reason (the bug this fixes)', () => {
    expect(contextStateFailureToLedgerReason('truncated')).toBe('truncated');
  });

  it('maps the remaining reasons sensibly', () => {
    expect(contextStateFailureToLedgerReason('timeout')).toBe('timeout');
    expect(contextStateFailureToLedgerReason('parse_error')).toBe('parse_error');
    expect(contextStateFailureToLedgerReason('empty')).toBe('parse_error');
    expect(contextStateFailureToLedgerReason('aborted')).toBe('other');
    expect(contextStateFailureToLedgerReason(undefined)).toBe('other');
  });
});
