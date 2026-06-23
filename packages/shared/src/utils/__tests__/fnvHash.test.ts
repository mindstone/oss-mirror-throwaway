import { fnvHashBase36, fnvHashHex } from '../fnvHash';

/**
 * Golden fixture for FNV-1a 32-bit `fnvHashBase36` and `fnvHashHex`.
 *
 * **Bit-identity is intent-critical** — Sentry breadcrumbs cross-reference
 * these short hashes across releases. If a future agent "tidies up" the
 * formatter (e.g., removes the no-op `.slice(0, 8)`, changes `padStart(7,…)`
 * to `padStart(8,…)`, or rounds the integer differently), this test fails
 * before the change ships.
 *
 * Expected values were computed by running the original Variant-A
 * (`(h >>> 0).toString(36).padStart(7, '0').slice(0, 8)`) and Variant-C
 * (`(h >>> 0).toString(16).padStart(8, '0')`) bodies against each input.
 */
const GOLDEN_FIXTURE: ReadonlyArray<{
  input: string;
  base36: string;
  hex: string;
  description: string;
}> = [
  { input: '', base36: '0ztntfp', hex: '811c9dc5', description: 'empty string (FNV offset basis)' },
  { input: 'a', base36: '1r9wi7g', hex: 'e40c292c', description: 'single ASCII character' },
  { input: 'session_abc', base36: '1mkwfew', hex: 'd320d208', description: 'typical session-id-shaped input' },
  {
    input: 'session_550e8400-e29b-41d4-a716-446655440000',
    base36: '0v3kxf5',
    hex: '7015a531',
    description: 'UUID-shaped session id',
  },
  {
    input: 'The quick brown fox jumps over the lazy dog 0123456789 The quick brown fox jumps over the lazy dog',
    base36: '024zpgk',
    hex: '07b537a4',
    description: 'long ASCII (~98 chars)',
  },
  { input: 'café', base36: '0e5rkos', hex: '3308be7c', description: 'unicode (combining/accented)' },
  { input: '\u{1F600}', base36: '1kdnhdk', hex: 'cb31c4b8', description: 'unicode surrogate pair (emoji)' },
  { input: 'a\u{1F600}b', base36: '13waept', hex: '8fca8501', description: 'mixed ASCII + surrogate pair' },
];

describe('fnvHashBase36', () => {
  it.each(GOLDEN_FIXTURE)(
    'matches the golden fixture for $description',
    ({ input, base36 }) => {
      expect(fnvHashBase36(input)).toBe(base36);
    },
  );

  it('always returns exactly 7 characters for any input', () => {
    for (const { input } of GOLDEN_FIXTURE) {
      expect(fnvHashBase36(input)).toHaveLength(7);
    }
  });

  it('is deterministic across calls', () => {
    expect(fnvHashBase36('session_abc')).toBe(fnvHashBase36('session_abc'));
  });

  it('produces distinct outputs for distinct inputs (smoke check)', () => {
    const outputs = GOLDEN_FIXTURE.map(({ input }) => fnvHashBase36(input));
    expect(new Set(outputs).size).toBe(outputs.length);
  });
});

describe('fnvHashHex', () => {
  it.each(GOLDEN_FIXTURE)(
    'matches the golden fixture for $description',
    ({ input, hex }) => {
      expect(fnvHashHex(input)).toBe(hex);
    },
  );

  it('always returns exactly 8 characters for any input', () => {
    for (const { input } of GOLDEN_FIXTURE) {
      expect(fnvHashHex(input)).toHaveLength(8);
    }
  });

  it('is deterministic across calls', () => {
    expect(fnvHashHex('session_abc')).toBe(fnvHashHex('session_abc'));
  });

  it('produces distinct outputs for distinct inputs (smoke check)', () => {
    const outputs = GOLDEN_FIXTURE.map(({ input }) => fnvHashHex(input));
    expect(new Set(outputs).size).toBe(outputs.length);
  });
});

describe('fnvHashBase36 / fnvHashHex equivalence', () => {
  it('both formatters agree on equality of inputs', () => {
    // If two inputs produce the same hex, they must produce the same base36
    // (and vice versa) — both formatters consume the same underlying hash.
    for (const a of GOLDEN_FIXTURE) {
      for (const b of GOLDEN_FIXTURE) {
        const hexEq = fnvHashHex(a.input) === fnvHashHex(b.input);
        const b36Eq = fnvHashBase36(a.input) === fnvHashBase36(b.input);
        expect(hexEq).toBe(b36Eq);
      }
    }
  });
});
