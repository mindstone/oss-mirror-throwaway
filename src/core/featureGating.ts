export type LicenseTier = 'free' | 'teams';

export type FeatureKey = 'spaces:create-additional';

const FEATURE_REQUIREMENTS: Record<FeatureKey, LicenseTier> = {
  'spaces:create-additional': 'teams',
};

const LICENSE_TIER_RANK: Record<LicenseTier, number> = {
  free: 0,
  teams: 1,
};

let currentLicenseTier: LicenseTier = 'free';

export function setLicenseTier(tier: LicenseTier): void {
  currentLicenseTier = tier;
}

export function getLicenseTier(): LicenseTier {
  return currentLicenseTier;
}

export function isFeatureEnabled(feature: FeatureKey): boolean {
  const requiredTier = FEATURE_REQUIREMENTS[feature];
  return LICENSE_TIER_RANK[currentLicenseTier] >= LICENSE_TIER_RANK[requiredTier];
}

export function resetFeatureGating(): void {
  currentLicenseTier = 'free';
}
