import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { errorSpy } = vi.hoisted(() => ({ errorSpy: vi.fn() }));
vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: errorSpy,
  }),
}));

import {
  __resetManagedKeyAvailabilityForTesting,
  getManagedKeyAvailability,
  registerManagedKeyAvailability,
} from '../managedKeyAvailability';

// F4 (260609): mirror of the BTS proxy-seam fix. `unwired` (a surface forgot to
// register) must be distinguishable from a legitimate registered-`false`. The
// read stays fail-soft (`false`, so the router fallback never crashes), but the
// unwired read emits the greppable `managed-key-availability-unwired` marker.
describe('managedKeyAvailability — unwired is LOUD but still fail-soft (F4)', () => {
  beforeEach(() => {
    errorSpy.mockClear();
    __resetManagedKeyAvailabilityForTesting();
  });

  afterEach(() => {
    __resetManagedKeyAvailabilityForTesting();
  });

  it('unwired → returns false WITHOUT throwing, and emits the bts-style unwired marker', () => {
    expect(getManagedKeyAvailability()).toBe(false);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][0]).toMatchObject({ marker: 'managed-key-availability-unwired' });
  });

  it('registered-false → returns false WITHOUT the unwired marker (legitimate "no managed key")', () => {
    registerManagedKeyAvailability(() => false);
    expect(getManagedKeyAvailability()).toBe(false);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('registered-true → returns true WITHOUT the unwired marker', () => {
    registerManagedKeyAvailability(() => true);
    expect(getManagedKeyAvailability()).toBe(true);
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
