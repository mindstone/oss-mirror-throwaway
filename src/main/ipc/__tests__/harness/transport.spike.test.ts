import { describe, expect, it } from 'vitest';

import { isDataCloneError, transport } from './transport';

/**
 * Stage-1 transport-fidelity spike.
 *
 * Locks the contract of the faithful in-process IPC transport the whole harness
 * depends on, asserting over the F3 payload set from the transport-fidelity
 * research report (`subagent_reports/260609_130935_transport-fidelity.md`):
 *
 *  - REJECT rows  → `transport()` throws the canonical `DataCloneError`, exactly
 *    as Electron's V8 Structured-Clone-Algorithm IPC would.
 *  - PRESERVE rows → round-trip is identity/shape-preserving (Date stays Date,
 *    Map stays Map, an `undefined`-valued key survives, bigint round-trips).
 *  - NON-VACUITY baseline → a `JSON.parse(JSON.stringify())` transport would have
 *    *silently accepted* the function-bearing payloads, proving the new transport
 *    is strictly stricter than the status-quo JSON wire it replaces.
 */

/**
 * The status-quo transport this harness replaces: the JSON wire used today by
 * `ipcContractRoundTrip.integration.test.ts`. Used ONLY to prove the new
 * transport is strictly stricter (non-vacuity baseline) — not part of the harness.
 */
function jsonTransport<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe('faithful IPC transport — F3 reject set (Electron SCA rejects → transport throws)', () => {
  // F3 rows 1-6 + 8: functions (top-level / own-prop / nested), symbols, Promises,
  // getter-that-throws. Each MUST throw rather than silently mutate.
  const rejectRows: Array<{ name: string; make: () => unknown }> = [
    { name: 'function (top-level)', make: () => () => {} },
    {
      name: 'object with own function property ({ userId, onDone })',
      make: () => ({ userId: '1', onDone: () => {} }),
    },
    {
      name: 'object with a nested function ({ ok, meta: { cb } })',
      make: () => ({ ok: true, meta: { cb: () => {} } }),
    },
    { name: 'symbol value (top-level)', make: () => Symbol('x') },
    { name: 'object with a symbol value ({ tag: Symbol })', make: () => ({ tag: Symbol('x') }) },
    { name: 'Promise (top-level)', make: () => Promise.resolve(1) },
    { name: 'object with a Promise value ({ pending })', make: () => ({ pending: Promise.resolve(1) }) },
  ];

  it.each(rejectRows)('rejects $name with DataCloneError', ({ make }) => {
    let thrown: unknown;
    try {
      transport(make());
    } catch (err) {
      thrown = err;
    }
    expect(thrown, 'expected the transport to throw on a non-cloneable payload').toBeDefined();
    expect(
      isDataCloneError(thrown),
      `expected canonical DataCloneError, got ${String((thrown as Error)?.name)}: ${String(thrown)}`,
    ).toBe(true);
  });

  it('propagates a throwing getter (does not swallow the error)', () => {
    const payload = {
      get x() {
        throw new Error('boom');
      },
    };
    // The getter is evaluated during clone; the throw must propagate (not be
    // silently dropped). It surfaces as the getter's own Error, not DataCloneError.
    expect(() => transport(payload)).toThrow('boom');
  });
});

describe('faithful IPC transport — F3 preserve set (Electron SCA preserves → round-trip identity/shape)', () => {
  it('keeps a Date as a Date with the same time', () => {
    const input = new Date('2026-06-09T12:34:56.000Z');
    const out = transport(input);
    expect(out).toBeInstanceOf(Date);
    expect(out.getTime()).toBe(input.getTime());
    // Contrast: the JSON wire silently degrades Date → string.
    expect(typeof jsonTransport(input)).toBe('string');
  });

  it('keeps a Map as a Map with the same entries', () => {
    const input = new Map<string, string>([['k', 'v']]);
    const out = transport(input);
    expect(out).toBeInstanceOf(Map);
    expect(out.get('k')).toBe('v');
    expect([...out.entries()]).toEqual([['k', 'v']]);
    // Contrast: the JSON wire silently degrades Map → {}.
    expect(jsonTransport(input)).toEqual({});
  });

  it('keeps a Set as a Set with the same members', () => {
    const input = new Set<number>([1, 2, 3]);
    const out = transport(input);
    expect(out).toBeInstanceOf(Set);
    expect([...out.values()]).toEqual([1, 2, 3]);
  });

  it('keeps an undefined-valued key present (optional-vs-key-present drift)', () => {
    const input: { a: undefined } = { a: undefined };
    const out = transport(input);
    // The KEY must survive with value undefined — this is exactly the
    // .optional()-vs-key-present drift the JSON wire silently hides.
    expect('a' in out).toBe(true);
    expect(out.a).toBeUndefined();
    // Contrast: the JSON wire drops the key entirely.
    expect('a' in jsonTransport(input)).toBe(false);
  });

  it('round-trips a bigint', () => {
    const input = 10n;
    const out = transport(input);
    expect(out).toBe(10n);
    expect(typeof out).toBe('bigint');
    // Contrast: the JSON wire false-rejects bigint with a TypeError.
    expect(() => jsonTransport(input)).toThrow(TypeError);
  });
});

describe('faithful IPC transport — non-vacuity baseline (strictly stricter than JSON)', () => {
  // >=2 rows: prove a JSON transport would have SILENTLY ACCEPTED the
  // function-bearing payloads (dropping the function), whereas the faithful
  // transport rejects them. This is the explicit "strictly better than the
  // status quo" proof.
  it('JSON SILENTLY accepts an own-function payload (dropping the fn); faithful transport rejects it', () => {
    const payload = { userId: '1', onDone: () => {} };

    // Status quo: JSON accepts, silently dropping the function — the textbook false-green.
    const viaJson = jsonTransport(payload);
    expect(viaJson).toEqual({ userId: '1' });
    expect('onDone' in viaJson).toBe(false);

    // Faithful transport: rejects, by construction of the SCA contract.
    let thrown: unknown;
    try {
      transport(payload);
    } catch (err) {
      thrown = err;
    }
    expect(isDataCloneError(thrown)).toBe(true);
  });

  it('JSON SILENTLY accepts a nested-function payload (dropping the cb); faithful transport rejects it', () => {
    const payload = { ok: true, meta: { cb: () => {} } };

    const viaJson = jsonTransport(payload);
    expect(viaJson).toEqual({ ok: true, meta: {} });
    expect('cb' in (viaJson.meta as object)).toBe(false);

    let thrown: unknown;
    try {
      transport(payload);
    } catch (err) {
      thrown = err;
    }
    expect(isDataCloneError(thrown)).toBe(true);
  });
});
