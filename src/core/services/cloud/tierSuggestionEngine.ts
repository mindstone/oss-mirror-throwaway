import type { CloudPressureState } from '@shared/types/cloudHealth';

/**
 * Single pressure observation point used by Stage D's desktop reconciler.
 * It is built from Stage B's detailed `/api/health?detailed=true` payload
 * plus accumulated rolling history (not directly from basic `/api/health`).
 * Stage D owns any naming transform between basic `state` and this
 * `pressure_state`; both refer to the same `CloudPressureState` enum.
 */
export type CloudPressureEvent = {
  timestampMs: number;
  pressure_state: CloudPressureState;
  oomRecent: boolean;
  rss_mb?: number;
  budget_mb?: number;
};

export type SuggestTierInput = {
  currentTierId: string;
  recentPressureEvents: CloudPressureEvent[];
  machineSpecMb: number;
  nowMs: number;
};

type KnownTierId = 'standard' | 'faster' | 'heavy-work';
type SuggestedTierId = 'faster' | 'heavy-work';

export type TierSuggestionReasonCode =
  | 'oom_24h_standard'
  | 'sustained_critical_standard'
  | 'oom_24h_faster';

export type TierSuggestionResult =
  | {
      kind: 'suggestion';
      tierId: SuggestedTierId;
      reasonCode: TierSuggestionReasonCode;
      reasonCopy: string;
    }
  | { kind: 'none'; reasonCode: 'no_pressure' | 'isolated_warning' | 'unknown_pressure_state' }
  | { kind: 'unknown_tier'; observedTierId: string }
  | { kind: 'no_higher_tier'; currentTierId: 'heavy-work' };

const OOM_WINDOW_MS = 24 * 60 * 60 * 1000;
const CRITICAL_SUSTAINED_THRESHOLD_MS = 10 * 60 * 1000;

const STANDARD_SUGGESTION_COPY = 'Cloud is running tight';
const FASTER_SUGGESTION_COPY = 'Cloud needs more room';

function isKnownTierId(tierId: string): tierId is KnownTierId {
  return tierId === 'standard' || tierId === 'faster' || tierId === 'heavy-work';
}

function hasUnknownPressureState(events: readonly CloudPressureEvent[]): boolean {
  return events.some((event) => event.pressure_state === 'unknown');
}

function hasOomInLast24Hours(events: readonly CloudPressureEvent[], nowMs: number): boolean {
  const windowStartMs = nowMs - OOM_WINDOW_MS;
  return events.some((event) =>
    event.oomRecent && event.timestampMs >= windowStartMs && event.timestampMs <= nowMs,
  );
}

function isCriticalPressureState(state: CloudPressureState): boolean {
  switch (state) {
    case 'critical':
      return true;
    case 'ok':
    case 'warning':
    case 'unknown':
      return false;
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}

function getLongestCriticalRunDurationMs(events: readonly CloudPressureEvent[]): number {
  const orderedEvents = [...events].sort((left, right) => left.timestampMs - right.timestampMs);

  let longestRunMs = 0;
  let runStartMs: number | null = null;

  for (const event of orderedEvents) {
    if (!isCriticalPressureState(event.pressure_state)) {
      runStartMs = null;
      continue;
    }

    if (runStartMs === null) {
      runStartMs = event.timestampMs;
    }

    const runDurationMs = event.timestampMs - runStartMs;
    if (runDurationMs > longestRunMs) {
      longestRunMs = runDurationMs;
    }
  }

  return longestRunMs;
}

function hasSustainedCritical(events: readonly CloudPressureEvent[]): boolean {
  return getLongestCriticalRunDurationMs(events) > CRITICAL_SUSTAINED_THRESHOLD_MS;
}

export function suggestTier(input: SuggestTierInput): TierSuggestionResult {
  const { currentTierId, recentPressureEvents, nowMs } = input;

  if (!isKnownTierId(currentTierId)) {
    return { kind: 'unknown_tier', observedTierId: currentTierId } as const;
  }

  if (recentPressureEvents.length === 0) {
    return { kind: 'none', reasonCode: 'no_pressure' } as const;
  }

  if (hasUnknownPressureState(recentPressureEvents)) {
    return { kind: 'none', reasonCode: 'unknown_pressure_state' } as const;
  }

  const hasOom24h = hasOomInLast24Hours(recentPressureEvents, nowMs);
  if (hasOom24h) {
    if (currentTierId === 'standard') {
      return {
        kind: 'suggestion',
        tierId: 'faster',
        reasonCode: 'oom_24h_standard',
        reasonCopy: STANDARD_SUGGESTION_COPY,
      } as const;
    }

    if (currentTierId === 'faster') {
      return {
        kind: 'suggestion',
        tierId: 'heavy-work',
        reasonCode: 'oom_24h_faster',
        reasonCopy: FASTER_SUGGESTION_COPY,
      } as const;
    }

    return { kind: 'no_higher_tier', currentTierId: 'heavy-work' } as const;
  }

  if (currentTierId === 'standard' && hasSustainedCritical(recentPressureEvents)) {
    return {
      kind: 'suggestion',
      tierId: 'faster',
      reasonCode: 'sustained_critical_standard',
      reasonCopy: STANDARD_SUGGESTION_COPY,
    } as const;
  }

  return { kind: 'none', reasonCode: 'isolated_warning' } as const;
}
