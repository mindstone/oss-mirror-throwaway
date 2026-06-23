#!/usr/bin/env npx tsx

import { MODEL_CATALOG } from '../src/shared/data/modelCatalog';

// Only the capabilities the /v1/models endpoint advertises as explicit booleans.
// `extendedContext` (the `[1m]` beta) is intentionally NOT here — the endpoint's
// context-window number conflates native size with beta support, so that flag is
// locked by the static flag-lock test rather than cross-checked live.
interface CapabilitySnapshot {
  compact: boolean;
  maxEffort: boolean;
}

interface LiveAnthropicModelResponse {
  capabilities?: {
    context_management?: {
      compact_20260112?: {
        supported?: boolean;
      };
    };
    effort?: {
      max?: {
        supported?: boolean;
      };
    };
  };
}

/**
 * Known, INTENTIONAL catalog-vs-live divergences (reported as advisory, not failure).
 * These are capabilities the live API advertises but we deliberately don't enable yet —
 * a flip would be a user-visible behaviour/cost change pending an explicit decision.
 *
 * `claude-sonnet-4-6` maxEffort: API supports effort.max, but enabling it changes
 * thinking depth/cost on a default model — deferred follow-up (see
 * docs/plans/260530_model-capability-drift-guard/PLAN.md Discovered Improvements).
 */
const KNOWN_DIVERGENCES: Record<string, ReadonlyArray<keyof CapabilitySnapshot>> = {
  'claude-sonnet-4-6': ['maxEffort'],
};

function expectedFromCatalog(entry: (typeof MODEL_CATALOG)[number]): CapabilitySnapshot {
  return {
    compact: entry.supportsCompact ?? false,
    maxEffort: entry.supportsMaxEffort ?? false,
  };
}

function liveFromApi(payload: LiveAnthropicModelResponse): CapabilitySnapshot {
  const compact = payload.capabilities?.context_management?.compact_20260112?.supported === true;
  const maxEffort = payload.capabilities?.effort?.max?.supported === true;
  return { compact, maxEffort };
}

async function fetchAnthropicCapabilities(model: string, apiKey: string): Promise<LiveAnthropicModelResponse> {
  const response = await fetch(`https://api.anthropic.com/v1/models/${encodeURIComponent(model)}?beta=true`, {
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`${model} returned HTTP ${response.status}${body ? `: ${body}` : ''}`);
  }

  return await response.json() as LiveAnthropicModelResponse;
}

/** List live Anthropic model ids (best-effort; returns [] on failure). */
async function listLiveAnthropicModels(apiKey: string): Promise<string[]> {
  try {
    const response = await fetch('https://api.anthropic.com/v1/models?limit=100', {
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    });
    if (!response.ok) return [];
    const payload = await response.json() as { data?: Array<{ id?: string }> };
    return (payload.data ?? [])
      .map(m => m.id)
      .filter((id): id is string => typeof id === 'string' && id.startsWith('claude-'));
  } catch {
    return [];
  }
}

/**
 * Live-only coverage check (the opus-4-8 class): flag live Anthropic models that
 * advertise a capability we gate on but are absent from the catalog — they'd fall
 * through to the legacy regex and could silently miss a capability. Advisory only.
 */
async function reportUncoveredLiveModels(apiKey: string): Promise<void> {
  const liveIds = await listLiveAnthropicModels(apiKey);
  if (liveIds.length === 0) {
    console.log('[check-model-capabilities] (live model enumeration unavailable; skipping coverage check)');
    return;
  }
  const covered = new Set<string>();
  for (const entry of MODEL_CATALOG) {
    if (entry.provider !== 'anthropic') continue;
    covered.add(entry.id);
    for (const alias of entry.aliases ?? []) covered.add(alias);
  }
  const stripDate = (id: string): string => id.replace(/-(?:\d{8}|\d{4}-\d{2}-\d{2})$/, '');
  for (const liveId of liveIds) {
    if (covered.has(liveId) || covered.has(stripDate(liveId))) continue;
    let caps: CapabilitySnapshot;
    try {
      caps = liveFromApi(await fetchAnthropicCapabilities(liveId, apiKey));
    } catch {
      continue;
    }
    const advertised = Object.entries(caps).filter(([, v]) => v).map(([k]) => k);
    if (advertised.length > 0) {
      console.warn(
        `[WARN] live model "${liveId}" advertises [${advertised.join(', ')}] but is not in MODEL_CATALOG — ` +
        'it relies on the legacy regex fallback. Add a catalog entry (with capability flags) when rostering it.',
      );
    }
  }
}

async function main(): Promise<void> {
  const apiKey = process.env.TEST_CLAUDE_API_KEY ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.log(
      '[check-model-capabilities] SKIP: set TEST_CLAUDE_API_KEY or ANTHROPIC_API_KEY to run live Anthropic capability checks.',
    );
    process.exit(0);
  }

  const anthropicModels = MODEL_CATALOG.filter(
    entry => entry.provider === 'anthropic' && !entry.migratesTo,
  );

  if (anthropicModels.length === 0) {
    console.log('[check-model-capabilities] SKIP: no non-deprecated Anthropic catalog entries found.');
    process.exit(0);
  }

  let hasErrors = false;
  console.log(`[check-model-capabilities] Checking ${anthropicModels.length} Anthropic catalog entries...`);

  for (const entry of anthropicModels) {
    const expected = expectedFromCatalog(entry);
    let live: CapabilitySnapshot;
    try {
      live = liveFromApi(await fetchAnthropicCapabilities(entry.id, apiKey));
    } catch (error) {
      hasErrors = true;
      console.error(`[FAIL] ${entry.id}: unable to fetch live capabilities (${String(error)})`);
      continue;
    }

    const known = KNOWN_DIVERGENCES[entry.id] ?? [];
    const drift: string[] = [];
    const knownDrift: string[] = [];
    // Only cross-check capabilities the models endpoint advertises as explicit
    // booleans. `extendedContext` (the `[1m]` beta) is NOT cleanly exposed by
    // /v1/models (the context-window number conflates native size with beta
    // support), so it's locked by the static flag-lock test instead.
    (['compact', 'maxEffort'] as const).forEach(cap => {
      if (live[cap] === expected[cap]) return;
      const msg = `${cap} catalog=${expected[cap]} live=${live[cap]}`;
      if (known.includes(cap)) knownDrift.push(msg);
      else drift.push(msg);
    });

    if (drift.length > 0) {
      hasErrors = true;
      console.error(`[FAIL] ${entry.id}: ${drift.join('; ')}`);
      continue;
    }
    if (knownDrift.length > 0) {
      console.warn(`[KNOWN-DIVERGENCE] ${entry.id}: ${knownDrift.join('; ')} (intentional — see KNOWN_DIVERGENCES)`);
      continue;
    }

    console.log(`[OK] ${entry.id}`);
  }

  // Advisory: live Anthropic models that advertise a gated capability but aren't
  // in the catalog (the opus-4-8 class — relies on the legacy regex fallback).
  await reportUncoveredLiveModels(apiKey);

  if (hasErrors) {
    console.error('[check-model-capabilities] FAILED: catalog capabilities drift from live Anthropic API.');
    process.exit(1);
  }

  console.log('[check-model-capabilities] PASSED: catalog capabilities match live Anthropic API.');
}

main().catch((error: unknown) => {
  console.error(`[check-model-capabilities] FAILED: ${String(error)}`);
  process.exit(1);
});
