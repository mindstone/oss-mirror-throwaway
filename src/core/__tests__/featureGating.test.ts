import { beforeEach, describe, expect, it } from 'vitest';
import {
  getLicenseTier,
  isFeatureEnabled,
  resetFeatureGating,
  setLicenseTier,
  type LicenseTier,
} from '@core/featureGating';

describe('featureGating', () => {
  beforeEach(() => {
    resetFeatureGating();
  });

  it('defaults to free tier', () => {
    expect(getLicenseTier()).toBe('free');
  });

  it('sets and returns the current tier', () => {
    setLicenseTier('teams');
    expect(getLicenseTier()).toBe('teams');

    setLicenseTier('free');
    expect(getLicenseTier()).toBe('free');
  });

  it.each([
    ['free', false],
    ['teams', true],
  ] as const)('checks spaces:create-additional for %s tier', (tier: LicenseTier, expected) => {
    setLicenseTier(tier);
    expect(isFeatureEnabled('spaces:create-additional')).toBe(expected);
  });

  it('resets to free tier', () => {
    setLicenseTier('teams');
    expect(isFeatureEnabled('spaces:create-additional')).toBe(true);

    resetFeatureGating();

    expect(getLicenseTier()).toBe('free');
    expect(isFeatureEnabled('spaces:create-additional')).toBe(false);
  });
});
