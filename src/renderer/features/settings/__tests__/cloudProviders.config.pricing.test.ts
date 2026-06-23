/**
 * Pricing-helper tests for `cloudProviders.config.ts`.
 *
 * Kept in a dedicated file so it doesn't disturb the existing
 * `cloudProviders.config.test.ts` (which covers `resolveHelpUrl`).
 *
 * Covers Stage 4 of:
 *   docs/plans/260419_cloud_setup_adaptive_sizing_and_honest_progress.md
 */

import { describe, it, expect } from 'vitest';
import {
  CLOUD_PROVIDERS,
  estimateMonthlyCost,
  formatPriceForProvider,
  formatServerMinForProvider,
  latestPricingAsOf,
  type CloudProviderUIConfig,
} from '../cloudProviders.config';

function getProvider(id: 'fly' | 'digitalocean' | 'hetzner' | 'mindstone'): CloudProviderUIConfig {
  const p = CLOUD_PROVIDERS.find((x) => x.id === id);
  if (!p) throw new Error(`fixture provider not found: ${id}`);
  return p;
}

describe('estimateMonthlyCost', () => {
  it('computes USD storage + server for Fly at 15 GB', () => {
    const fly = getProvider('fly');
    const est = estimateMonthlyCost(fly, 15);
    expect(est).not.toBeNull();
    expect(est!.currency).toBe('USD');
    // 0.15 * 15 = 2.25 (float comparison tolerance).
    expect(est!.storage).toBeCloseTo(2.25, 5);
    expect(est!.server).toBe(fly.pricing!.serverMinPerMonth);
  });

  it('computes EUR storage + server for Hetzner at 15 GB', () => {
    const hetzner = getProvider('hetzner');
    const est = estimateMonthlyCost(hetzner, 15);
    expect(est).not.toBeNull();
    expect(est!.currency).toBe('EUR');
    // 0.044 * 15 = 0.66.
    expect(est!.storage).toBeCloseTo(0.66, 5);
    expect(est!.server).toBe(hetzner.pricing!.serverMinPerMonth);
  });

  it('computes USD storage + server for DigitalOcean at 15 GB', () => {
    const digitalocean = getProvider('digitalocean');
    const est = estimateMonthlyCost(digitalocean, 15);
    expect(est).not.toBeNull();
    expect(est!.currency).toBe('USD');
    // 0.10 * 15 = 1.50.
    expect(est!.storage).toBeCloseTo(1.5, 5);
  });

  it('returns null for a provider without structured pricing (managed Mindstone)', () => {
    const mindstone = getProvider('mindstone');
    expect(mindstone.pricing).toBeUndefined();
    expect(estimateMonthlyCost(mindstone, 15)).toBeNull();
  });

  it('returns null for non-finite or non-positive volumeGb', () => {
    const fly = getProvider('fly');
    expect(estimateMonthlyCost(fly, 0)).toBeNull();
    expect(estimateMonthlyCost(fly, -10)).toBeNull();
    expect(estimateMonthlyCost(fly, Number.NaN)).toBeNull();
    expect(estimateMonthlyCost(fly, Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('formatPriceForProvider', () => {
  it('formats Fly USD storage at 15 GB as "~$2.25/mo for 15 GB"', () => {
    expect(formatPriceForProvider(getProvider('fly'), 15)).toBe('~$2.25/mo for 15 GB');
  });

  it('formats DigitalOcean USD storage at 15 GB as "~$1.50/mo for 15 GB"', () => {
    expect(formatPriceForProvider(getProvider('digitalocean'), 15)).toBe('~$1.50/mo for 15 GB');
  });

  it('formats Hetzner EUR storage at 15 GB with approx USD equivalent', () => {
    // 0.044 * 15 = 0.66 EUR ; 0.66 * 1.08 = 0.7128 → $0.71.
    expect(formatPriceForProvider(getProvider('hetzner'), 15)).toBe(
      '~€0.66/mo for 15 GB (approx $0.71)',
    );
  });

  it('returns em-dash when volumeGb is null', () => {
    expect(formatPriceForProvider(getProvider('fly'), null)).toBe('\u2014');
  });

  it('returns em-dash for provider without structured pricing', () => {
    expect(formatPriceForProvider(getProvider('mindstone'), 15)).toBe('\u2014');
  });

  it('returns em-dash for non-finite or non-positive volumeGb', () => {
    const fly = getProvider('fly');
    expect(formatPriceForProvider(fly, 0)).toBe('\u2014');
    expect(formatPriceForProvider(fly, -5)).toBe('\u2014');
    expect(formatPriceForProvider(fly, Number.NaN)).toBe('\u2014');
  });
});

describe('formatServerMinForProvider', () => {
  it('formats Fly USD minimum as "from $1.94/mo"', () => {
    expect(formatServerMinForProvider(getProvider('fly'))).toBe('from $1.94/mo');
  });

  it('formats DigitalOcean whole-dollar minimum without decimals', () => {
    // DO serverMinPerMonth = 6 — whole number renders as "$6", not "$6.00".
    expect(formatServerMinForProvider(getProvider('digitalocean'))).toBe('from $6/mo');
  });

  it('formats Hetzner EUR minimum with approx USD equivalent', () => {
    // 4.51 * 1.08 = 4.8708 → $4.87.
    expect(formatServerMinForProvider(getProvider('hetzner'))).toBe(
      'from €4.51/mo (approx $4.87)',
    );
  });

  it('returns em-dash for provider without structured pricing', () => {
    expect(formatServerMinForProvider(getProvider('mindstone'))).toBe('\u2014');
  });
});

describe('latestPricingAsOf', () => {
  it('returns the most recent ISO date across BYOK providers', () => {
    const byok = CLOUD_PROVIDERS.filter((p) => !!p.pricing);
    const latest = latestPricingAsOf(byok);
    // ISO YYYY-MM-DD strings sort lexicographically; all three BYOK providers
    // are on 2026-04-19 today, so latest === 2026-04-19.
    expect(latest).toBe('2026-04-19');
  });

  it('returns null when no provider has pricing data', () => {
    expect(latestPricingAsOf([getProvider('mindstone')])).toBeNull();
  });

  it('picks the maximum when dates differ', () => {
    const base = getProvider('fly');
    const older: CloudProviderUIConfig = {
      ...base,
      id: 'fly',
      pricing: { ...base.pricing!, pricingAsOf: '2025-11-01' },
    };
    const newer: CloudProviderUIConfig = {
      ...base,
      id: 'fly',
      pricing: { ...base.pricing!, pricingAsOf: '2026-03-15' },
    };
    expect(latestPricingAsOf([older, newer])).toBe('2026-03-15');
  });
});
