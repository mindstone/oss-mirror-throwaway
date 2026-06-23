/**
 * Stage 7: the fail-loud coverage guard for the IPC contract round-trip harness.
 *
 * ## What it computes (pure — no boot, no Electron)
 * Given (a) the full channel registry `allChannels`, (b) the channel→metadata
 * lookup, and (c) the set of channels the harness actually round-trips (the
 * Stage-6 covered set), this classifies EVERY `type:'invoke'` channel that is NOT
 * skipped from the handler-presence assertion into exactly one bucket:
 *   - `covered`   — round-tripped by the harness.
 *   - `exempt`    — its `ipcContract` domain is on the reasoned, category-based
 *                   {@link HARNESS_EXEMPT_DOMAINS} map (a deliberate deferral).
 *   - `uncovered` — NEITHER covered NOR exempt → the guard FAILS LOUD on these.
 *
 * The "is this channel skipped" predicate REUSES the production
 * {@link shouldSkipFromPresenceAssertion} (exported from
 * `handlerPresenceInvariant.ts`) so the harness guard and the boot-time presence
 * invariant agree on what "expected to register through the chokepoint" means by
 * construction — there is no second, drifting copy of the bypass/lazy/featureFlag
 * rule.
 *
 * ## Precise wording (Stage-2 carry-forward)
 * "Skipped" means **not registered through the `registerHandler` chokepoint** (a
 * `RAW_IPC_BYPASS_CHANNELS`/e2e direct-`ipcMain.handle` channel, lazy, or
 * feature-flagged) — it does NOT mean "absent from `allChannels`": many bypass
 * channels ARE contract-backed entries in `allChannels`. The covered/exempt diff
 * runs over the not-skipped invoke surface only.
 */

import {
  isInvokeChannel,
  shouldSkipFromPresenceAssertion,
} from '../../handlerPresenceInvariant';
import { getChannelMetadata, type ChannelMetadata } from '@shared/ipc/channelMetadata';
import { allChannels as realAllChannels, ipcContract } from '@shared/ipc/contracts';

import {
  HARNESS_EXEMPT_DOMAINS,
  type HarnessExemptCategory,
  type IpcContractDomain,
} from './harnessExemptions';

type ChannelDefLike = { type?: string };

/** A channel that is neither covered nor exempt — the guard fails on a non-empty list. */
export interface UncoveredChannel {
  readonly channel: string;
  readonly domain: IpcContractDomain | null;
  /** Why it fell through, in human terms (for the loud failure message). */
  readonly fellThrough: string;
}

export interface CoverageReport {
  /** All `type:'invoke'`, not-skipped channels (the surface the guard reasons over). */
  readonly invokeNotSkipped: readonly string[];
  /** Covered ∩ invokeNotSkipped (the harness round-tripped these). */
  readonly covered: readonly string[];
  /** Uncovered-but-exempt (domain on HARNESS_EXEMPT_DOMAINS). */
  readonly exempt: readonly string[];
  /** Exempt count broken down by reasoned category (so it cannot silently grow). */
  readonly exemptByCategory: Readonly<Record<HarnessExemptCategory, number>>;
  /** The exempt `ipcContract` domains actually hit (subset of the map's keys). */
  readonly exemptDomainsHit: readonly IpcContractDomain[];
  /** Channels that are neither covered nor exempt — NON-EMPTY = guard RED. */
  readonly uncovered: readonly UncoveredChannel[];
  /**
   * Channels whose domain is BOTH covered (some sibling channel round-trips) AND
   * exempt-mapped — a contradiction that would make the domain-keyed exemption
   * granularity unsound. Expected empty (the clean-partition invariant).
   */
  readonly mixedDomainViolations: readonly string[];
  /** Exempt-map keys that are not real `ipcContract` domains (stale/typo) — expected empty. */
  readonly staleExemptDomains: readonly string[];
  /** Exempt-map keys for domains that are actually covered (the deferral is stale) — expected empty. */
  readonly coveredButExemptDomains: readonly IpcContractDomain[];
}

/** channel id → its `ipcContract` domain-group key (or null if ungrouped). */
function buildChannelDomainIndex(): ReadonlyMap<string, IpcContractDomain> {
  const m = new Map<string, IpcContractDomain>();
  for (const [domain, group] of Object.entries(ipcContract)) {
    for (const channel of Object.keys(group as Record<string, unknown>)) {
      m.set(channel, domain as IpcContractDomain);
    }
  }
  return m;
}

const EMPTY_CATEGORY_COUNTS: Record<HarnessExemptCategory, number> = {
  'agent-surface': 0,
  connector: 0,
  'plugins-mcp': 0,
  'desktop-native': 0,
  'cloud-orchestration': 0,
  'not-cloud-safe': 0,
};

/**
 * Classify the full invoke surface against the harness-covered set + the reasoned
 * exemption map. Pure: takes the covered channel ids; the test supplies them from
 * the post-boot `roundTrip` set.
 */
export function computeCoverageReport(args: {
  coveredChannels: Iterable<string>;
  allChannels?: Readonly<Record<string, ChannelDefLike>>;
  getMetadata?: (channel: string) => ChannelMetadata;
}): CoverageReport {
  const {
    coveredChannels,
    getMetadata = getChannelMetadata,
  } = args;
  // Default to the real registry; allow injection for unit tests.
  const channels =
    args.allChannels ?? (realAllChannels as Readonly<Record<string, ChannelDefLike>>);

  const domainIndex = buildChannelDomainIndex();
  const coveredSet = new Set(coveredChannels);

  const invokeNotSkipped: string[] = [];
  for (const [channel, def] of Object.entries(channels)) {
    if (!isInvokeChannel(def)) continue;
    if (shouldSkipFromPresenceAssertion(getMetadata(channel))) continue;
    invokeNotSkipped.push(channel);
  }

  const covered: string[] = [];
  const exempt: string[] = [];
  const uncovered: UncoveredChannel[] = [];
  const exemptByCategory: Record<HarnessExemptCategory, number> = { ...EMPTY_CATEGORY_COUNTS };
  const exemptDomainsHit = new Set<IpcContractDomain>();

  // Track which domains have at least one covered channel (for the no-mixed-domain
  // invariant: a domain must be fully covered OR fully exempt, never split).
  const coveredDomains = new Set<IpcContractDomain>();
  for (const channel of coveredSet) {
    const d = domainIndex.get(channel);
    if (d) coveredDomains.add(d);
  }

  for (const channel of invokeNotSkipped) {
    if (coveredSet.has(channel)) {
      covered.push(channel);
      continue;
    }
    const domain = domainIndex.get(channel) ?? null;
    const exemptEntry = domain ? HARNESS_EXEMPT_DOMAINS[domain] : undefined;
    if (domain && exemptEntry) {
      exempt.push(channel);
      exemptByCategory[exemptEntry.category] += 1;
      exemptDomainsHit.add(domain);
      continue;
    }
    uncovered.push({
      channel,
      domain,
      fellThrough:
        domain === null
          ? 'channel has no ipcContract domain group (cannot classify)'
          : `domain '${domain}' is neither covered by the harness nor on HARNESS_EXEMPT_DOMAINS — add its registrar to cloudSafeRegistrars.ts (to cover) OR add a reasoned HARNESS_EXEMPT_DOMAINS entry (to defer)`,
    });
  }

  // Mixed-domain violations: a not-skipped invoke channel whose domain is BOTH
  // covered and exempt-mapped. This breaks the domain-keyed exemption assumption
  // and must be revisited if it ever fires.
  const mixedDomainViolations: string[] = [];
  for (const channel of invokeNotSkipped) {
    const domain = domainIndex.get(channel);
    if (domain && coveredDomains.has(domain) && HARNESS_EXEMPT_DOMAINS[domain]) {
      mixedDomainViolations.push(channel);
    }
  }

  // Stale exempt-map entries: a key that is not a real domain, or a domain that is
  // actually covered (so its deferral is out of date and should be deleted).
  const realDomains = new Set(Object.keys(ipcContract));
  const staleExemptDomains = Object.keys(HARNESS_EXEMPT_DOMAINS).filter((d) => !realDomains.has(d));
  const coveredButExemptDomains = (Object.keys(HARNESS_EXEMPT_DOMAINS) as IpcContractDomain[]).filter(
    (d) => coveredDomains.has(d),
  );

  return {
    invokeNotSkipped,
    covered,
    exempt,
    exemptByCategory,
    exemptDomainsHit: [...exemptDomainsHit].sort(),
    uncovered,
    mixedDomainViolations,
    staleExemptDomains,
    coveredButExemptDomains,
  };
}
