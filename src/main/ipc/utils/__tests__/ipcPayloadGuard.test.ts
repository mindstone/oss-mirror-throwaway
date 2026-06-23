/**
 * Unit tests for IPC Payload Size Guard.
 *
 * Tests estimatePayloadSize() with various value types and boundary conditions,
 * and verifies threshold-based recording and perf-mode gating.
 *
 * Uses vi.resetModules() + dynamic import to control IS_PERF_MODE, which is
 * cached at module load from process.env.REBEL_E2E_PERF_MODE.
 *
 * @see src/main/ipc/utils/ipcPayloadGuard.ts
 * @see docs/plans/260328_perf_regression_tests.md
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';

// Type alias for the module shape
type PayloadGuardModule = typeof import('../ipcPayloadGuard');

describe('ipcPayloadGuard', () => {
  // =========================================================================
  // estimatePayloadSize — pure function, no env dependency.
  // We import once with perf mode ON (needed for recording tests below).
  // =========================================================================
  let guard: PayloadGuardModule;

  beforeAll(async () => {
    process.env.REBEL_E2E_PERF_MODE = '1';
    vi.resetModules();
    guard = await import('../ipcPayloadGuard');
  });

  afterAll(() => {
    delete process.env.REBEL_E2E_PERF_MODE;
    vi.resetModules();
  });

  describe('estimatePayloadSize', () => {
    describe('null and undefined', () => {
      it('returns 0 for null', () => {
        expect(guard.estimatePayloadSize(null)).toBe(0);
      });

      it('returns 0 for undefined', () => {
        expect(guard.estimatePayloadSize(undefined)).toBe(0);
      });
    });

    describe('strings', () => {
      it('returns correct byte length for ASCII string', () => {
        expect(guard.estimatePayloadSize('hello')).toBe(5);
      });

      it('returns correct byte length for empty string', () => {
        expect(guard.estimatePayloadSize('')).toBe(0);
      });

      it('returns correct byte length for UTF-8 multibyte characters', () => {
        // '€' is 3 bytes in UTF-8
        expect(guard.estimatePayloadSize('€')).toBe(3);
        // '𝕳' (mathematical double-struck H) is 4 bytes in UTF-8
        expect(guard.estimatePayloadSize('𝕳')).toBe(4);
        // Mixed: 'a€b' = 1 + 3 + 1 = 5 bytes
        expect(guard.estimatePayloadSize('a€b')).toBe(5);
      });
    });

    describe('Buffer', () => {
      it('returns correct size for Buffer', () => {
        const buf = Buffer.alloc(128);
        expect(guard.estimatePayloadSize(buf)).toBe(128);
      });

      it('returns 0 for empty Buffer', () => {
        expect(guard.estimatePayloadSize(Buffer.alloc(0))).toBe(0);
      });
    });

    describe('ArrayBuffer', () => {
      it('returns correct size for ArrayBuffer', () => {
        const ab = new ArrayBuffer(256);
        expect(guard.estimatePayloadSize(ab)).toBe(256);
      });

      it('returns 0 for empty ArrayBuffer', () => {
        expect(guard.estimatePayloadSize(new ArrayBuffer(0))).toBe(0);
      });
    });

    describe('TypedArrays', () => {
      it('returns correct size for Uint8Array', () => {
        const arr = new Uint8Array(64);
        expect(guard.estimatePayloadSize(arr)).toBe(64);
      });

      it('returns correct size for Float64Array', () => {
        // 8 elements × 8 bytes = 64 bytes
        const arr = new Float64Array(8);
        expect(guard.estimatePayloadSize(arr)).toBe(64);
      });

      it('returns correct size for Int32Array', () => {
        // 4 elements × 4 bytes = 16 bytes
        const arr = new Int32Array(4);
        expect(guard.estimatePayloadSize(arr)).toBe(16);
      });
    });

    describe('objects and arrays', () => {
      it('returns JSON byte length for plain object', () => {
        const obj = { key: 'value' };
        const expected = Buffer.byteLength(JSON.stringify(obj), 'utf-8');
        expect(guard.estimatePayloadSize(obj)).toBe(expected);
      });

      it('returns JSON byte length for array', () => {
        const arr = [1, 2, 3];
        const expected = Buffer.byteLength(JSON.stringify(arr), 'utf-8');
        expect(guard.estimatePayloadSize(arr)).toBe(expected);
      });

      it('returns JSON byte length for nested object', () => {
        const obj = { a: { b: { c: 'deep' } } };
        const expected = Buffer.byteLength(JSON.stringify(obj), 'utf-8');
        expect(guard.estimatePayloadSize(obj)).toBe(expected);
      });

      it('returns JSON byte length for empty object', () => {
        expect(guard.estimatePayloadSize({})).toBe(2); // '{}'
      });

      it('returns JSON byte length for empty array', () => {
        expect(guard.estimatePayloadSize([])).toBe(2); // '[]'
      });
    });

    describe('non-serializable values (fail-open)', () => {
      it('returns 0 for circular references', () => {
        const obj: Record<string, unknown> = { a: 1 };
        obj.self = obj;
        expect(guard.estimatePayloadSize(obj)).toBe(0);
      });

      it('returns 0 for BigInt', () => {
        expect(guard.estimatePayloadSize(BigInt(42))).toBe(0);
      });

      it('returns 0 for object containing BigInt', () => {
        expect(guard.estimatePayloadSize({ value: BigInt(42) })).toBe(0);
      });

      it('returns 0 for function', () => {
        expect(guard.estimatePayloadSize(() => {})).toBe(0);
      });
    });

    describe('numbers and booleans', () => {
      it('returns JSON byte length for number', () => {
        // JSON.stringify(42) = '42' = 2 bytes
        expect(guard.estimatePayloadSize(42)).toBe(2);
      });

      it('returns JSON byte length for boolean', () => {
        expect(guard.estimatePayloadSize(true)).toBe(4);
        expect(guard.estimatePayloadSize(false)).toBe(5);
      });
    });
  });

  // =========================================================================
  // recordIfOversized (with REBEL_E2E_PERF_MODE=1 via dynamic import)
  // =========================================================================
  describe('recordIfOversized', () => {
    beforeEach(() => {
      guard.clearViolations();
    });

    it('does not record payloads below warn threshold', () => {
      const smallPayload = 'x'.repeat(guard.WARN_THRESHOLD - 1);
      guard.recordIfOversized('test:channel', smallPayload);
      expect(guard.getViolations()).toHaveLength(0);
    });

    it('does not record payloads at exactly warn threshold', () => {
      const payload = 'x'.repeat(guard.WARN_THRESHOLD);
      guard.recordIfOversized('test:channel', payload);
      expect(guard.getViolations()).toHaveLength(0);
    });

    it('records warn-level violation for payload just above warn threshold', () => {
      const payload = 'x'.repeat(guard.WARN_THRESHOLD + 1);
      guard.recordIfOversized('test:channel', payload);
      const v = guard.getViolations();
      expect(v).toHaveLength(1);
      expect(v[0].level).toBe('warn');
      expect(v[0].channel).toBe('test:channel');
      expect(v[0].size).toBe(guard.WARN_THRESHOLD + 1);
      expect(v[0].timestamp).toBeGreaterThan(0);
    });

    it('does not record fail-level at exactly fail threshold', () => {
      const payload = 'x'.repeat(guard.FAIL_THRESHOLD);
      guard.recordIfOversized('test:channel', payload);
      const v = guard.getViolations();
      // Should be warn-level, not fail-level
      expect(v).toHaveLength(1);
      expect(v[0].level).toBe('warn');
    });

    it('records fail-level violation for payload above fail threshold', () => {
      const payload = 'x'.repeat(guard.FAIL_THRESHOLD + 1);
      guard.recordIfOversized('test:channel', payload);
      const v = guard.getViolations();
      expect(v).toHaveLength(1);
      expect(v[0].level).toBe('fail');
      expect(v[0].channel).toBe('test:channel');
      expect(v[0].size).toBe(guard.FAIL_THRESHOLD + 1);
    });

    it('accumulates multiple violations', () => {
      guard.recordIfOversized('channel:a', 'x'.repeat(guard.WARN_THRESHOLD + 1));
      guard.recordIfOversized('channel:b', 'x'.repeat(guard.FAIL_THRESHOLD + 1));
      expect(guard.getViolations()).toHaveLength(2);
      expect(guard.getViolations()[0].level).toBe('warn');
      expect(guard.getViolations()[1].level).toBe('fail');
    });

    it('does not record null/undefined payloads', () => {
      guard.recordIfOversized('test:channel', null);
      guard.recordIfOversized('test:channel', undefined);
      expect(guard.getViolations()).toHaveLength(0);
    });
  });

  // =========================================================================
  // getViolations + clearViolations
  // =========================================================================
  describe('getViolations and clearViolations', () => {
    beforeEach(() => {
      guard.clearViolations();
    });

    it('returns empty array when no violations', () => {
      expect(guard.getViolations()).toEqual([]);
    });

    it('returns a copy (not the internal array)', () => {
      guard.recordIfOversized('test:channel', 'x'.repeat(guard.WARN_THRESHOLD + 1));
      const a = guard.getViolations();
      const b = guard.getViolations();
      expect(a).toEqual(b);
      expect(a).not.toBe(b);
    });

    it('clearViolations resets to empty', () => {
      guard.recordIfOversized('test:channel', 'x'.repeat(guard.WARN_THRESHOLD + 1));
      expect(guard.getViolations()).toHaveLength(1);
      guard.clearViolations();
      expect(guard.getViolations()).toHaveLength(0);
    });
  });

  // =========================================================================
  // Threshold constants
  // =========================================================================
  describe('threshold constants', () => {
    it('WARN_THRESHOLD is 64KB', () => {
      expect(guard.WARN_THRESHOLD).toBe(64 * 1024);
    });

    it('FAIL_THRESHOLD is 256KB', () => {
      expect(guard.FAIL_THRESHOLD).toBe(256 * 1024);
    });

    it('FAIL_THRESHOLD is greater than WARN_THRESHOLD', () => {
      expect(guard.FAIL_THRESHOLD).toBeGreaterThan(guard.WARN_THRESHOLD);
    });
  });
});

// =========================================================================
// IS_PERF_MODE gating (off case) — separate describe to isolate module state
// =========================================================================
describe('ipcPayloadGuard (perf mode OFF)', () => {
  it('recordIfOversized is a no-op when REBEL_E2E_PERF_MODE is not set', async () => {
    const savedValue = process.env.REBEL_E2E_PERF_MODE;
    delete process.env.REBEL_E2E_PERF_MODE;
    vi.resetModules();

    try {
      const offGuard = await import('../ipcPayloadGuard');
      offGuard.clearViolations();
      offGuard.recordIfOversized('test:channel', 'x'.repeat(offGuard.FAIL_THRESHOLD + 100));
      expect(offGuard.getViolations()).toHaveLength(0);
    } finally {
      if (savedValue !== undefined) {
        process.env.REBEL_E2E_PERF_MODE = savedValue;
      }
      vi.resetModules();
    }
  });
});
