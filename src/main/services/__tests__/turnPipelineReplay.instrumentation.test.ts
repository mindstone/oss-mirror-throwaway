import { describe, expect, it } from 'vitest';
import { installReplayHarness } from './turnPipelineReplay.harness';
import {
  UNKNOWN_EVENT_BUCKET,
  aggregateLogCounts,
  assertEventOrdering,
  countPersistenceWrites,
  dispatchAgentEventTypeSelector,
} from './turnPipelineReplay.instrumentation';

describe('turnPipelineReplay.instrumentation — aggregateLogCounts', () => {
  it('returns zeroed counts for empty records', () => {
    const handle = installReplayHarness();
    const counts = aggregateLogCounts(handle.records);
    expect(counts.byLevel).toEqual({ info: 0, warn: 0, error: 0, debug: 0 });
    expect(counts.byEvent).toEqual({});
    expect(counts.total).toBe(0);
    expect(counts.filteredOut).toBe(0);
    handle.uninstall();
  });

  it('counts deliberate warn log entries (positive control)', () => {
    const handle = installReplayHarness();
    handle.recorder.recordLog('warn', [{ event: 'test.warn' }, 'warn message']);
    const counts = aggregateLogCounts(handle.records);
    expect(counts.byLevel.warn).toBe(1);
    expect(counts.byEvent['test.warn']).toBe(1);
    expect(counts.total).toBe(1);
    expect(counts.filteredOut).toBe(0);
    handle.uninstall();
  });

  it('aggregates per-level and per-event buckets across multiple log entries', () => {
    const handle = installReplayHarness();
    handle.recorder.recordLog('info', [{ event: 'test.info' }, 'info']);
    handle.recorder.recordLog('warn', [{ event: 'test.warn' }, 'warn']);
    handle.recorder.recordLog('warn', [{ event: 'test.warn' }, 'warn again']);
    handle.recorder.recordLog('error', [{ event: 'test.error' }, 'error']);
    const counts = aggregateLogCounts(handle.records);
    expect(counts.byLevel).toEqual({ info: 1, warn: 2, error: 1, debug: 0 });
    expect(counts.byEvent).toEqual({
      'test.info': 1,
      'test.warn': 2,
      'test.error': 1,
    });
    expect(counts.total).toBe(4);
    handle.uninstall();
  });

  it('filters turnPhase.* events by default', () => {
    const handle = installReplayHarness();
    handle.recorder.recordLog('debug', [{ event: 'turnPhase.entry' }, 'phase']);
    handle.recorder.recordLog('warn', [{ event: 'test.warn' }, 'warn']);
    const counts = aggregateLogCounts(handle.records);
    expect(counts.byLevel).toEqual({ info: 0, warn: 1, error: 0, debug: 0 });
    expect(counts.byEvent).toEqual({ 'test.warn': 1 });
    expect(counts.total).toBe(1);
    expect(counts.filteredOut).toBe(1);
    handle.uninstall();
  });

  it('can disable turnPhase.* filtering', () => {
    const handle = installReplayHarness();
    handle.recorder.recordLog('debug', [{ event: 'turnPhase.exit' }, 'phase']);
    handle.recorder.recordLog('warn', [{ event: 'test.warn' }, 'warn']);
    const counts = aggregateLogCounts(handle.records, { filterTurnPhase: false });
    expect(counts.byLevel).toEqual({ info: 0, warn: 1, error: 0, debug: 1 });
    expect(counts.byEvent).toEqual({ 'turnPhase.exit': 1, 'test.warn': 1 });
    expect(counts.total).toBe(2);
    expect(counts.filteredOut).toBe(0);
    handle.uninstall();
  });

  it('ignores non-log surfaces', () => {
    const handle = installReplayHarness();
    handle.recorder.recordEvent('dispatchAgentEvent', [null, 'turn-1', { type: 'assistant' }]);
    handle.recorder.recordPersistence('writeSession', [{ turnId: 'turn-1' }]);
    handle.recorder.recordLog('info', [{ event: 'test.info' }, 'info']);
    const counts = aggregateLogCounts(handle.records);
    expect(counts.byLevel).toEqual({ info: 1, warn: 0, error: 0, debug: 0 });
    expect(counts.total).toBe(1);
    handle.uninstall();
  });

  it('uses UNKNOWN_EVENT_BUCKET when first log arg is not an object', () => {
    const handle = installReplayHarness();
    handle.recorder.recordLog('warn', ['warn-only-message']);
    const counts = aggregateLogCounts(handle.records);
    expect(counts.byLevel.warn).toBe(1);
    expect(counts.byEvent[UNKNOWN_EVENT_BUCKET]).toBe(1);
    expect(counts.total).toBe(1);
    handle.uninstall();
  });

  it('uses UNKNOWN_EVENT_BUCKET when event field is missing/non-string', () => {
    const handle = installReplayHarness();
    handle.recorder.recordLog('warn', [{ other: 'value' }, 'warn']);
    handle.recorder.recordLog('warn', [{ event: 42 }, 'warn']);
    const counts = aggregateLogCounts(handle.records);
    expect(counts.byEvent[UNKNOWN_EVENT_BUCKET]).toBe(2);
    expect(counts.byLevel.warn).toBe(2);
    expect(counts.total).toBe(2);
    handle.uninstall();
  });
});

describe('turnPipelineReplay.instrumentation — countPersistenceWrites', () => {
  it('returns zero counts for empty records', () => {
    const handle = installReplayHarness();
    const counts = countPersistenceWrites(handle.records);
    expect(counts.total).toBe(0);
    expect(counts.byMethod).toEqual({});
    handle.uninstall();
  });

  it('counts persistence writes by method (positive control)', () => {
    const handle = installReplayHarness();
    handle.recorder.recordPersistence('writeTurnSnapshot', [{ turnId: 'turn-1' }]);
    handle.recorder.recordPersistence('writeTurnSnapshot', [{ turnId: 'turn-2' }]);
    handle.recorder.recordPersistence('writeSessionSummary', [{ sessionId: 'session-1' }]);
    const counts = countPersistenceWrites(handle.records);
    expect(counts.total).toBe(3);
    expect(counts.byMethod).toEqual({
      writeTurnSnapshot: 2,
      writeSessionSummary: 1,
    });
    handle.uninstall();
  });

  it('ignores non-persistence surfaces', () => {
    const handle = installReplayHarness();
    handle.recorder.recordLog('warn', [{ event: 'test.warn' }, 'warn']);
    handle.recorder.recordEvent('dispatchAgentEvent', [null, 'turn-1', { type: 'status' }]);
    const counts = countPersistenceWrites(handle.records);
    expect(counts.total).toBe(0);
    expect(counts.byMethod).toEqual({});
    handle.uninstall();
  });

  it('counts distinct persistence methods independently', () => {
    const handle = installReplayHarness();
    handle.recorder.recordPersistence('writeA', []);
    handle.recorder.recordPersistence('writeB', []);
    handle.recorder.recordPersistence('writeB', []);
    const counts = countPersistenceWrites(handle.records);
    expect(counts.byMethod.writeA).toBe(1);
    expect(counts.byMethod.writeB).toBe(2);
    expect(counts.total).toBe(3);
    handle.uninstall();
  });
});

describe('turnPipelineReplay.instrumentation — assertEventOrdering', () => {
  it('returns ok=true when tracked methods are in declared order (positive control)', () => {
    const handle = installReplayHarness();
    handle.recorder.recordEvent('phase.start', []);
    handle.recorder.recordLog('debug', [{ event: 'noise' }, 'noise']);
    handle.recorder.recordEvent('phase.middle', []);
    handle.recorder.recordPersistence('writeTurnSnapshot', []);
    handle.recorder.recordEvent('phase.end', []);
    const result = assertEventOrdering(handle.records, ['phase.start', 'phase.middle', 'phase.end']);
    expect(result).toEqual({
      ok: true,
      missing: [],
      outOfOrder: [],
    });
    handle.uninstall();
  });

  it('reports missing tracked events', () => {
    const handle = installReplayHarness();
    handle.recorder.recordEvent('phase.start', []);
    const result = assertEventOrdering(handle.records, ['phase.start', 'phase.middle', 'phase.end']);
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(['phase.middle', 'phase.end']);
    expect(result.outOfOrder).toEqual([]);
    handle.uninstall();
  });

  it('reports out-of-order transitions with structured detail', () => {
    const handle = installReplayHarness();
    handle.recorder.recordEvent('phase.middle', []);
    handle.recorder.recordEvent('phase.start', []);
    const result = assertEventOrdering(handle.records, ['phase.start', 'phase.middle']);
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual([]);
    expect(result.outOfOrder).toEqual([
      { event: 'phase.middle', expectedAfter: 'phase.start' },
    ]);
    handle.uninstall();
  });

  it('ignores methods that are not in the declared ordering list', () => {
    const handle = installReplayHarness();
    handle.recorder.recordEvent('phase.start', []);
    handle.recorder.recordEvent('untracked.noise', []);
    handle.recorder.recordEvent('phase.end', []);
    const result = assertEventOrdering(handle.records, ['phase.start', 'phase.end']);
    expect(result).toEqual({
      ok: true,
      missing: [],
      outOfOrder: [],
    });
    handle.uninstall();
  });

  it('enforces strict ordering across repeated occurrences', () => {
    const handle = installReplayHarness();
    handle.recorder.recordEvent('phase.start', []);
    handle.recorder.recordEvent('phase.end', []);
    handle.recorder.recordEvent('phase.start', []);
    const result = assertEventOrdering(handle.records, ['phase.start', 'phase.end']);
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual([]);
    expect(result.outOfOrder).toEqual([
      { event: 'phase.end', expectedAfter: 'phase.start' },
    ]);
    handle.uninstall();
  });

  it('passes repeated occurrences when all next events happen after the last previous event', () => {
    const handle = installReplayHarness();
    handle.recorder.recordEvent('phase.start', []);
    handle.recorder.recordEvent('phase.start', []);
    handle.recorder.recordEvent('phase.end', []);
    handle.recorder.recordEvent('phase.end', []);
    const result = assertEventOrdering(handle.records, ['phase.start', 'phase.end']);
    expect(result).toEqual({
      ok: true,
      missing: [],
      outOfOrder: [],
    });
    handle.uninstall();
  });

  it('returns ok=true with no findings for empty orderedEventTypes', () => {
    const handle = installReplayHarness();
    handle.recorder.recordEvent('phase.start', []);
    handle.recorder.recordEvent('phase.end', []);
    const result = assertEventOrdering(handle.records, []);
    expect(result).toEqual({
      ok: true,
      missing: [],
      outOfOrder: [],
    });
    handle.uninstall();
  });
});

describe('turnPipelineReplay.instrumentation — assertEventOrdering with dispatchAgentEventTypeSelector', () => {
  // Stage 3a integration shape: in turnPipelineReplay.test.ts, events are
  // recorded as `recordEvent('dispatchAgentEvent', [win, turnId, event])`,
  // so the actual AgentEvent.type lives in args[2].type — not in
  // call.method (which is uniformly 'dispatchAgentEvent'). The default
  // method-based selector cannot order such events; the
  // `dispatchAgentEventTypeSelector` lifts the type out of the conventional
  // wiring so Stage 3a tests can assert ordering across event types.

  it('orders AgentEvent types lifted from dispatchAgentEvent wiring (positive control)', () => {
    const handle = installReplayHarness();
    handle.recorder.recordEvent('dispatchAgentEvent', [null, 't1', { type: 'turn_started' }]);
    handle.recorder.recordEvent('dispatchAgentEvent', [null, 't1', { type: 'assistant_delta' }]);
    handle.recorder.recordEvent('dispatchAgentEvent', [null, 't1', { type: 'result' }]);
    const result = assertEventOrdering(
      handle.records,
      ['turn_started', 'assistant_delta', 'result'],
      { extractKey: dispatchAgentEventTypeSelector },
    );
    expect(result).toEqual({
      ok: true,
      missing: [],
      outOfOrder: [],
    });
    handle.uninstall();
  });

  it('detects out-of-order AgentEvent types via the selector', () => {
    const handle = installReplayHarness();
    handle.recorder.recordEvent('dispatchAgentEvent', [null, 't1', { type: 'result' }]);
    handle.recorder.recordEvent('dispatchAgentEvent', [null, 't1', { type: 'turn_started' }]);
    const result = assertEventOrdering(
      handle.records,
      ['turn_started', 'result'],
      { extractKey: dispatchAgentEventTypeSelector },
    );
    expect(result.ok).toBe(false);
    expect(result.outOfOrder).toEqual([{ event: 'result', expectedAfter: 'turn_started' }]);
    handle.uninstall();
  });

  it('selector skips non-event surfaces without misclassifying them', () => {
    // recordLog/recordPersistence calls must be invisible to the selector —
    // they would otherwise either pollute ordering buckets (if their method
    // name happened to match a tracked event) or trigger false out-of-order
    // detections on the next dispatched event.
    const handle = installReplayHarness();
    handle.recorder.recordEvent('dispatchAgentEvent', [null, 't1', { type: 'turn_started' }]);
    handle.recorder.recordLog('warn', [{ event: 'result' }, 'noise that names a tracked type']);
    handle.recorder.recordPersistence('result', [{}]);
    handle.recorder.recordEvent('dispatchAgentEvent', [null, 't1', { type: 'result' }]);
    const result = assertEventOrdering(
      handle.records,
      ['turn_started', 'result'],
      { extractKey: dispatchAgentEventTypeSelector },
    );
    expect(result).toEqual({
      ok: true,
      missing: [],
      outOfOrder: [],
    });
    handle.uninstall();
  });

  it('selector returns undefined for malformed dispatchAgentEvent args (missing type)', () => {
    const handle = installReplayHarness();
    // Malformed: third arg has no `type` field — should be skipped, not crash.
    handle.recorder.recordEvent('dispatchAgentEvent', [null, 't1', { notType: 'oops' }]);
    handle.recorder.recordEvent('dispatchAgentEvent', [null, 't1', { type: 'turn_started' }]);
    const result = assertEventOrdering(
      handle.records,
      ['turn_started'],
      { extractKey: dispatchAgentEventTypeSelector },
    );
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
    handle.uninstall();
  });
});
