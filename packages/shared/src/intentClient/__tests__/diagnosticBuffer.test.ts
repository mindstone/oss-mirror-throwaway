import { describe, expect, it, vi } from 'vitest';
import {
  composeDiagnosticSinks,
  createInMemoryDiagnosticBuffer,
} from '../diagnosticBuffer';
import type { DiagnosticEvent, DiagnosticSink } from '../diagnostics';

function makeEvent(requestId: string, ts: number): DiagnosticEvent {
  return {
    kind: 'fetch.start',
    op: 'sendMessage',
    url: '/intent/conversation/message',
    requestId,
    tokenLen: 12,
    ts,
  };
}

describe('diagnosticBuffer', () => {
  it('rolls over at capacity and keeps the newest events', () => {
    const buffer = createInMemoryDiagnosticBuffer({ capacity: 3 });

    buffer.emit(makeEvent('id-1', 1));
    buffer.emit(makeEvent('id-2', 2));
    buffer.emit(makeEvent('id-3', 3));
    buffer.emit(makeEvent('id-4', 4));

    expect(buffer.dump().map((event) => event.requestId)).toEqual([
      'id-2',
      'id-3',
      'id-4',
    ]);
  });

  it('filters events by request id with dumpById()', () => {
    const buffer = createInMemoryDiagnosticBuffer({ capacity: 5 });

    buffer.emit(makeEvent('trace-a', 1));
    buffer.emit(makeEvent('trace-b', 2));
    buffer.emit(makeEvent('trace-a', 3));

    const traceA = buffer.dumpById('trace-a');
    expect(traceA).toHaveLength(2);
    expect(traceA.map((event) => event.ts)).toEqual([1, 3]);
  });

  it('passes through to an optional wrapped sink', () => {
    const emitSpy = vi.fn<(event: DiagnosticEvent) => void>();
    const downstream: DiagnosticSink = { emit: emitSpy };
    const buffer = createInMemoryDiagnosticBuffer({
      capacity: 2,
      sink: downstream,
    });
    const event = makeEvent('trace-pass', 123);

    buffer.emit(event);

    expect(emitSpy).toHaveBeenCalledWith(event);
  });

  it('does not throw when overwriting old entries in a full buffer', () => {
    const buffer = createInMemoryDiagnosticBuffer({ capacity: 1 });

    expect(() => {
      for (let i = 0; i < 100; i += 1) {
        buffer.emit(makeEvent(`id-${i}`, i));
      }
    }).not.toThrow();

    expect(buffer.dump()).toHaveLength(1);
    expect(buffer.dump()[0]?.requestId).toBe('id-99');
  });

  it('composeDiagnosticSinks fans out and isolates sink failures', () => {
    const received: string[] = [];
    const sinkA: DiagnosticSink = {
      emit(event) {
        received.push(`a:${event.requestId}`);
      },
    };
    const sinkB: DiagnosticSink = {
      emit() {
        throw new Error('boom');
      },
    };
    const sinkC: DiagnosticSink = {
      emit(event) {
        received.push(`c:${event.requestId}`);
      },
    };

    const sink = composeDiagnosticSinks(sinkA, sinkB, sinkC);
    sink.emit(makeEvent('trace-compose', 1));

    expect(received).toEqual(['a:trace-compose', 'c:trace-compose']);
  });
});
