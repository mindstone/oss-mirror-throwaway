import type { ActiveProvider } from './settings';

/**
 * Server-assigned default model identifiers for a managed subscription tier.
 * These are the ONLY models the managed key is permitted to invoke — both
 * the renderer UI lockdown (Stage G1) and proxy fail-closed (Stage G2) treat
 * the populated entries as the strict allow-list when activeProvider === 'mindstone'.
 */
export interface ManagedDefaultModels {
  /** Default model for the "working" role (general-purpose turns). */
  working?: string;
  /** Default model for the "thinking" role (deeper reasoning / extended thinking). */
  thinking?: string;
  /** Default model for behind-the-scenes / background work. */
  bts?: string;
}

/**
 * Managed provider information delivered via /config.
 * Ephemeral, server-authoritative — NOT persisted in settings.
 * Stored in cachedAuthConfig and exposed to renderer via auth:get-config IPC.
 */
export interface ManagedProviderInfo {
  /** Provider identifier (currently always 'openrouter') */
  provider: string;
  /** Server-side key hash for usage tracking (NOT the API key itself) */
  keyHash: string;
  /** Server-curated model IDs allowed for this subscription tier */
  allowedModels: string[];
  /**
   * Server-assigned tier defaults. Source of truth for the managed-tier
   * model allow-list (see Stage G in
   * docs/plans/260513a_subscription_consumer_audit_gaps.md). May be omitted
   * by older servers; populated entries are treated as the allow-list.
   */
  defaultModels?: ManagedDefaultModels;
  /**
   * Monthly credit limit in USD.
   * Omitted when the server has not populated allowance data yet.
   */
  creditLimitMonthly?: number;
  /**
   * Credit used this month in USD.
   * Omitted when the server has not populated allowance data yet.
   */
  creditUsedMonthly?: number;
  /**
   * ISO-8601 timestamp of when the monthly allowance window ends and credits reset.
   * Optional — older servers may omit it; the renderer meter falls back to
   * "data unavailable" when this or the credit fields are missing/zero.
   * See Stage H1 in docs/plans/260513a_subscription_consumer_audit_gaps.md.
   */
  resetsAt?: string;
  /** Currency code for credit amounts. Currently always 'USD'. */
  currency?: string;
  /** Reset period cadence. Currently always 'month'. */
  period?: 'month';
}

export type ManagedAllowListState =
  | { kind: 'ready'; allowed: readonly string[] }
  | { kind: 'unavailable' }
  | { kind: 'empty' };

/**
 * Collect the populated default model identifiers as the managed-tier allow-list.
 * Returns an empty array when `defaultModels` is undefined or has no defined entries.
 * Used by both the renderer model picker (Stage G1) and the proxy fail-closed
 * enforcement (Stage G2).
 */
export function getManagedAllowedModelIds(
  info: Pick<ManagedProviderInfo, 'defaultModels'> | undefined | null,
): string[] {
  if (!info?.defaultModels) return [];
  const out: string[] = [];
  if (info.defaultModels.working) out.push(info.defaultModels.working);
  if (info.defaultModels.thinking) out.push(info.defaultModels.thinking);
  if (info.defaultModels.bts) out.push(info.defaultModels.bts);
  return Array.from(new Set(out));
}

/**
 * Tri-state allow-list snapshot used by council eligibility checks.
 *
 * - `unavailable`: `/config` data not hydrated yet (first boot / offline / pre-auth)
 * - `empty`: server payload present, but no populated default models
 * - `ready`: populated allow-list from server defaults
 */
export function getManagedAllowListState(
  info: Pick<ManagedProviderInfo, 'defaultModels'> | undefined | null,
): ManagedAllowListState {
  if (!info) return { kind: 'unavailable' };
  const allowed = getManagedAllowedModelIds(info);
  if (allowed.length === 0) return { kind: 'empty' };
  return { kind: 'ready', allowed };
}

function collectPopulatedDefaults(defaults: ManagedDefaultModels | undefined): Set<string> {
  const out = new Set<string>();
  if (!defaults) return out;
  if (defaults.working) out.add(defaults.working);
  if (defaults.thinking) out.add(defaults.thinking);
  if (defaults.bts) out.add(defaults.bts);
  return out;
}

/**
 * Compute the set difference between two ManagedDefaultModels snapshots,
 * returning the dedupe'd added/removed model IDs across the populated
 * working/thinking/bts roles. Stage G5 uses this to detect tier-model
 * changes on /config refresh and drive analytics + renderer snap-to-default.
 */
export function diffDefaultModels(
  prev: ManagedDefaultModels | undefined,
  next: ManagedDefaultModels | undefined,
): { added: string[]; removed: string[] } {
  const prevSet = collectPopulatedDefaults(prev);
  const nextSet = collectPopulatedDefaults(next);
  const added: string[] = [];
  const removed: string[] = [];
  for (const id of nextSet) {
    if (!prevSet.has(id)) added.push(id);
  }
  for (const id of prevSet) {
    if (!nextSet.has(id)) removed.push(id);
  }
  return { added, removed };
}

/**
 * Whether the managed (Mindstone-plan) route is USABLE for the given active provider —
 * i.e. whether a managed-listed model can be reached *flat* via the managed key right
 * now. **Today this is byte-identical to the inlined literal `activeProvider === 'mindstone'`**
 * (managed routing only works on Mindstone — `localModelProxyServer.ts:2074`).
 *
 * SCOPE: this is the single AVAILABILITY swap-point for the recommendation engine's
 * managed gate (`computeAvailability` in `src/core/modelRecommendation/recommendModels.ts`).
 * It is deliberately NARROW — NOT a global replacement for the many other
 * `activeProvider === 'mindstone'` sites repo-wide (UI / auth / provider-switch / billing).
 *
 * INTENDED SWAP-POINT (DECISION A): the smart-model-routing plan's Stage 1
 * (`docs/plans/260614_smart-model-routing/PLAN.md`) widens managed routing from a single
 * `activeProvider === 'mindstone'` to per-managed-key ("managed key present AND model in the
 * allow-list"). When it does, it widens THIS predicate **together with** the matching
 * cost-side flip in `resolveBillingSourceForModel` (`billingSource.ts`) — widening one without
 * the other would emit an internally-inconsistent `usable-now` row still priced `pool`/`paid`.
 * We do NOT touch the cost side this run (it stays byte-identical); availability is merely
 * made swappable here.
 *
 * PURE: no electron / electron-store import.
 *
 * @public Deliberate shared-API swap-point. Its only current production consumer is the
 *   recommendation engine (`src/core/modelRecommendation/**`), which is itself knip-ignored
 *   as shipped-ahead-of-its-UI-consumer; the routing agent's Stage 1 is the next consumer.
 *   Tagged `@public` so the dead-code production leg doesn't flag it as unused before those
 *   consumers go live. Remove the tag once a live production consumer traces to it.
 * @see docs/plans/260614_recommended-models-followup/PLAN.md (Stage 4, DECISION A)
 */
export function isManagedRouteUsable(ctx: {
  activeProvider: ActiveProvider | undefined;
}): boolean {
  return ctx.activeProvider === 'mindstone';
}
