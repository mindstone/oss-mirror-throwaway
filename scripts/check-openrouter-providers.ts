#!/usr/bin/env npx tsx
/**
 * Validates that CHINA_ORIGIN_PROVIDER_ALLOWLISTS entries match real OpenRouter
 * provider availability. Uses the public (no-auth) endpoints API.
 *
 * Usage:  npx tsx scripts/check-openrouter-providers.ts
 * Exit 1: if ALL allowlisted providers for a prefix are absent (routing would fail)
 * Exit 0: if at least one allowlisted provider hosts a representative model per prefix
 *
 * Not included in validate:fast (needs network). Run manually or in release CI.
 *
 * Imports CHINA_ORIGIN_PROVIDER_ALLOWLISTS directly from src/shared so this
 * script and the runtime injection logic can never drift. The shared module
 * has zero runtime dependencies, so tsx loads it without any path-alias setup.
 */

import { CHINA_ORIGIN_PROVIDER_ALLOWLISTS } from '../src/shared/openrouterProviderAllowlists';

const OR_ENDPOINTS_BASE = 'https://openrouter.ai/api/v1/models';

const PROVIDER_ALLOWLISTS = CHINA_ORIGIN_PROVIDER_ALLOWLISTS;

// Representative models per prefix — the ones users actually select.
const REPRESENTATIVE_MODELS: Record<string, string[]> = {
  'deepseek/': ['deepseek/deepseek-v4-flash', 'deepseek/deepseek-v3.2', 'deepseek/deepseek-r1-0528'],
  'minimax/': ['minimax/minimax-m2.7', 'minimax/minimax-m2.5'],
  'moonshotai/': ['moonshotai/kimi-k2.5'],
  'z-ai/': ['z-ai/glm-5.1', 'z-ai/glm-5'],
};

interface Endpoint {
  provider_name: string;
  tag: string;
  status?: number;
}

interface EndpointsResponse {
  data?: {
    endpoints?: Endpoint[];
  };
}

async function fetchProviders(model: string): Promise<string[]> {
  const url = `${OR_ENDPOINTS_BASE}/${model}/endpoints`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'rebel-app-CI/1.0' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    console.warn(`  ⚠ Failed to fetch ${model}: HTTP ${res.status}`);
    return [];
  }
  const json = (await res.json()) as EndpointsResponse;
  return (json.data?.endpoints ?? []).map((e) => e.provider_name);
}

async function main() {
  console.log('Checking OpenRouter provider allowlists against live endpoints...\n');

  let hasErrors = false;
  let hasWarnings = false;

  for (const entry of PROVIDER_ALLOWLISTS) {
    const models = REPRESENTATIVE_MODELS[entry.prefix];
    if (!models) {
      console.warn(`⚠ No representative models defined for prefix '${entry.prefix}'`);
      hasWarnings = true;
      continue;
    }

    console.log(`── ${entry.prefix} (allowlist: ${entry.providers.join(', ')})`);

    // Collect all providers seen across representative models
    const allLiveProviders = new Set<string>();
    const perModelResults: Record<string, string[]> = {};

    for (const model of models) {
      const providers = await fetchProviders(model);
      perModelResults[model] = providers;
      for (const p of providers) allLiveProviders.add(p);
      console.log(`  ${model}: ${providers.length > 0 ? providers.join(', ') : '(no providers found)'}`);
    }

    // Check each allowlisted provider against aggregated results
    let validCount = 0;
    for (const allowed of entry.providers) {
      const hostsAny = models.some((m) => perModelResults[m]?.includes(allowed));
      if (!hostsAny) {
        console.warn(`  ⚠ STALE: '${allowed}' not hosting any representative models`);
        hasWarnings = true;
      } else {
        validCount++;
        const modelsHosted = models.filter((m) => perModelResults[m]?.includes(allowed));
        console.log(`  ✓ ${allowed} → hosts: ${modelsHosted.join(', ')}`);
      }
    }

    // Fail only if NO allowlisted provider is live for this prefix
    if (validCount === 0) {
      console.error(`  ✗ FATAL: No allowlisted providers found for '${entry.prefix}' — routing will fail!`);
      hasErrors = true;
    }

    // Surface non-China providers available but not in allowlist
    const allowSet = new Set(entry.providers);
    const unlisted = [...allLiveProviders].filter((p) => !allowSet.has(p));
    if (unlisted.length > 0) {
      console.log(`  ℹ Not in allowlist: ${unlisted.join(', ')}`);
    }

    console.log();
  }

  if (hasErrors) {
    console.error('FAILED: Some allowlisted providers are completely absent from OpenRouter.');
    process.exit(1);
  }
  if (hasWarnings) {
    console.warn('WARNINGS: Some providers may not host all representative models. Review output above.');
  }
  console.log('All provider allowlists validated.');
}

main().catch((err) => {
  console.error('Script failed:', err);
  process.exit(1);
});
