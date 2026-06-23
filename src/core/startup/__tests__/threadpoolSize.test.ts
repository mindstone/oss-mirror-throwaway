import { describe, expect, it } from 'vitest';
import {
  computeThreadpoolSize,
  decideThreadpoolBuffer,
  snapshotThreadpoolBuffer,
  THREADPOOL_SIZE_CAP,
  THREADPOOL_SIZE_FLOOR,
} from '../threadpoolSize';

describe('computeThreadpoolSize', () => {
  it('FLOOR is the load-bearing minimum: 32, exceeding realistic parked syscalls plus DNS headroom', () => {
    expect(THREADPOOL_SIZE_FLOOR).toBe(32);
    expect(THREADPOOL_SIZE_FLOOR).toBeGreaterThan(9);
  });

  it('small machines still get at least the floor (parked-syscall headroom is CPU-independent)', () => {
    // A 4-core machine with a dead Drive mount needs the same minimum as an
    // 8-core one — the danger is parked syscalls, not CPU count.
    expect(computeThreadpoolSize(1)).toBe(THREADPOOL_SIZE_FLOOR);
    expect(computeThreadpoolSize(4)).toBe(THREADPOOL_SIZE_FLOOR);
    expect(computeThreadpoolSize(8)).toBe(THREADPOOL_SIZE_FLOOR);
  });

  it('an 8-core machine gets the floor so it clears 9 parked symlinks with DNS headroom', () => {
    // 8 * 2 = 16, then floor to 32.
    expect(computeThreadpoolSize(8)).toBe(THREADPOOL_SIZE_FLOOR);
    expect(computeThreadpoolSize(8) - 9).toBeGreaterThanOrEqual(7);
  });

  it('scales as parallelism*2 between floor and cap', () => {
    expect(computeThreadpoolSize(17)).toBe(34);
    expect(computeThreadpoolSize(24)).toBe(48);
    expect(computeThreadpoolSize(31)).toBe(62);
  });

  it('clamps large machines down to the cap (64)', () => {
    expect(computeThreadpoolSize(32)).toBe(THREADPOOL_SIZE_CAP);
    expect(computeThreadpoolSize(128)).toBe(THREADPOOL_SIZE_CAP);
    expect(THREADPOOL_SIZE_CAP).toBe(64);
  });

  it('falls back to the floor on non-finite / non-positive input (Infinity is not finite → floor)', () => {
    expect(computeThreadpoolSize(0)).toBe(THREADPOOL_SIZE_FLOOR);
    expect(computeThreadpoolSize(-4)).toBe(THREADPOOL_SIZE_FLOOR);
    expect(computeThreadpoolSize(Number.NaN)).toBe(THREADPOOL_SIZE_FLOOR);
    expect(computeThreadpoolSize(Number.POSITIVE_INFINITY)).toBe(THREADPOOL_SIZE_FLOOR);
  });

  it('rounds fractional parallelism before scaling', () => {
    expect(computeThreadpoolSize(16.4)).toBe(32); // round(16.4)=16 → *2 = 32
    expect(computeThreadpoolSize(31.6)).toBe(64); // round(31.6)=32 → *2 = 64 (cap)
  });
});

describe('decideThreadpoolBuffer', () => {
  it('sets the value when the env var is unset', () => {
    const d = decideThreadpoolBuffer(undefined, 12);
    expect(d).toEqual({ applied: true, value: '12', reason: 'set-from-default' });
  });

  it('sets the value when the env var is empty/whitespace', () => {
    expect(decideThreadpoolBuffer('', 12).applied).toBe(true);
    expect(decideThreadpoolBuffer('   ', 12).applied).toBe(true);
  });

  it('keeps a larger operator-chosen value (never shrink)', () => {
    const d = decideThreadpoolBuffer('32', 12);
    expect(d).toEqual({ applied: false, value: '32', reason: 'kept-existing-larger' });
  });

  it('keeps an equal value untouched', () => {
    expect(decideThreadpoolBuffer('12', 12)).toEqual({
      applied: false,
      value: '12',
      reason: 'kept-existing-larger',
    });
  });

  it('raises a smaller existing value up to the desired buffer', () => {
    const d = decideThreadpoolBuffer('4', 12);
    expect(d).toEqual({ applied: true, value: '12', reason: 'raised-existing-smaller' });
  });

  it('raises an unparseable override to the buffer (libuv would otherwise silently fall back to 4) — F5', () => {
    const d = decideThreadpoolBuffer('not-a-number', 12);
    expect(d).toEqual({ applied: true, value: '12', reason: 'raised-existing-unparseable' });
  });

  it('treats zero / negative existing values as garbage → raises to the buffer', () => {
    expect(decideThreadpoolBuffer('0', 12)).toEqual({
      applied: true,
      value: '12',
      reason: 'raised-existing-unparseable',
    });
    expect(decideThreadpoolBuffer('-1', 12)).toEqual({
      applied: true,
      value: '12',
      reason: 'raised-existing-unparseable',
    });
  });
});

describe('snapshotThreadpoolBuffer (GPT F1 — effective-pool read-back for field diagnostics)', () => {
  it('reports bufferApplied=true when the env value clears the desired buffer', () => {
    // 8-core → desired 32. Env at 32 → effective 32, buffer in force.
    const snap = snapshotThreadpoolBuffer('32', 8);
    expect(snap).toEqual({
      effectiveSize: 32,
      rawEnvValue: '32',
      desiredSize: 32,
      bufferApplied: true,
    });
  });

  it('reports bufferApplied=true for an operator value above the desired', () => {
    const snap = snapshotThreadpoolBuffer('64', 8);
    expect(snap.effectiveSize).toBe(64);
    expect(snap.bufferApplied).toBe(true);
  });

  it('reports effectiveSize=null + bufferApplied=false when unset (libuv would default to 4)', () => {
    const snap = snapshotThreadpoolBuffer(undefined, 8);
    expect(snap.effectiveSize).toBeNull();
    expect(snap.bufferApplied).toBe(false);
    expect(snap.desiredSize).toBe(THREADPOOL_SIZE_FLOOR);
  });

  it('treats a garbage env value as unset (libuv default 4) → bufferApplied=false', () => {
    expect(snapshotThreadpoolBuffer('auto', 8).effectiveSize).toBeNull();
    expect(snapshotThreadpoolBuffer('0', 8).effectiveSize).toBeNull();
    expect(snapshotThreadpoolBuffer('auto', 8).bufferApplied).toBe(false);
  });

  it('reports bufferApplied=false when a stale-small value would silently undercut the buffer (the bundler-reorder no-op signal)', () => {
    // e.g. emitted bundle ran an async pool op before our set, libuv locked 4.
    const snap = snapshotThreadpoolBuffer('4', 8);
    expect(snap.effectiveSize).toBe(4);
    expect(snap.bufferApplied).toBe(false);
  });

  it('does NOT mutate process.env (pure read for the breadcrumb)', () => {
    const before = process.env.UV_THREADPOOL_SIZE;
    snapshotThreadpoolBuffer('32', 8);
    snapshotThreadpoolBuffer(undefined, 8);
    expect(process.env.UV_THREADPOOL_SIZE).toBe(before);
  });
});
