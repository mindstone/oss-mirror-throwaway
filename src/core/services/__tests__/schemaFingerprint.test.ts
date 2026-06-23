import { describe, expect, it } from 'vitest';
import { computeSchemaFingerprint } from '../schemaFingerprint';

describe('computeSchemaFingerprint', () => {
  it('returns identical sha256 across reorderings of the input keys', () => {
    const a = computeSchemaFingerprint({ alpha: 1, beta: 2, gamma: 3 });
    const b = computeSchemaFingerprint({ gamma: 3, alpha: 1, beta: 2 });
    const c = computeSchemaFingerprint({ beta: 2, gamma: 3, alpha: 1 });

    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('differs when any version number changes', () => {
    const baseline = computeSchemaFingerprint({ alpha: 1, beta: 2 });
    const bumped = computeSchemaFingerprint({ alpha: 1, beta: 3 });
    expect(baseline).not.toBe(bumped);
  });

  it('differs when a key is added or removed', () => {
    const minimal = computeSchemaFingerprint({ alpha: 1 });
    const augmented = computeSchemaFingerprint({ alpha: 1, beta: 2 });
    expect(minimal).not.toBe(augmented);
  });

  it('returns the same value across separate processes-style inputs', () => {
    const cloudSide = computeSchemaFingerprint({ AGENT: 4, INBOX: 6, ROLE: 3 });
    const desktopSide = computeSchemaFingerprint({ ROLE: 3, AGENT: 4, INBOX: 6 });
    expect(cloudSide).toBe(desktopSide);
  });

  it('throws when a value is not a finite number', () => {
    expect(() => computeSchemaFingerprint({ broken: Number.NaN })).toThrow('non-numeric');
    expect(() =>
      computeSchemaFingerprint({ broken: Number.POSITIVE_INFINITY }),
    ).toThrow('non-numeric');
    expect(() =>
      computeSchemaFingerprint({ broken: 'one' as unknown as number }),
    ).toThrow('non-numeric');
  });
});
