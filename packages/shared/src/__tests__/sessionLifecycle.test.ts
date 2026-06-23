import { describe, expect, it } from 'vitest';
import { isSessionActive, isSessionDone } from '../sessionLifecycle';

describe('sessionLifecycle predicates', () => {
  it('treats a non-null doneAt timestamp as Done', () => {
    const s = { doneAt: 1_700_000_000_000 };
    expect(isSessionDone(s)).toBe(true);
    expect(isSessionActive(s)).toBe(false);
  });

  it('treats doneAt: 0 as Done (must not use truthiness)', () => {
    // Regression guard: `!doneAt` / `Boolean(doneAt)` would misclassify 0 as Active.
    const s = { doneAt: 0 };
    expect(isSessionDone(s)).toBe(true);
    expect(isSessionActive(s)).toBe(false);
  });

  it('treats doneAt: null as Active', () => {
    const s = { doneAt: null };
    expect(isSessionDone(s)).toBe(false);
    expect(isSessionActive(s)).toBe(true);
  });

  it('treats absent doneAt as Active', () => {
    const s = {};
    expect(isSessionDone(s)).toBe(false);
    expect(isSessionActive(s)).toBe(true);
  });

  it('treats doneAt: undefined as Active', () => {
    const s = { doneAt: undefined };
    expect(isSessionDone(s)).toBe(false);
    expect(isSessionActive(s)).toBe(true);
  });

  it('isSessionDone and isSessionActive are always exact complements', () => {
    for (const doneAt of [0, 1, 1_700_000_000_000, null, undefined]) {
      const s = { doneAt };
      expect(isSessionDone(s)).toBe(!isSessionActive(s));
    }
  });
});
