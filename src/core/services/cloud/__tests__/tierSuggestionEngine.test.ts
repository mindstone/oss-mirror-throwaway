import { describe, expect, it } from 'vitest';
import type { CloudPressureState } from '@shared/types/cloudHealth';
import {
  suggestTier,
  type CloudPressureEvent,
  type SuggestTierInput,
  type TierSuggestionResult,
} from '../tierSuggestionEngine';

const NOW_MS = 1_700_000_000_000;
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

function buildEvent(
  atOffsetMs: number,
  pressureState: CloudPressureState,
  oomRecent = false,
): CloudPressureEvent {
  return {
    timestampMs: NOW_MS + atOffsetMs,
    pressure_state: pressureState,
    oomRecent,
  };
}

function buildInput(overrides: Partial<SuggestTierInput> = {}): SuggestTierInput {
  return {
    currentTierId: 'standard',
    recentPressureEvents: [],
    machineSpecMb: 4096,
    nowMs: NOW_MS,
    ...overrides,
  };
}

function createSeededRandom(seed: number): () => number {
  let current = seed >>> 0;
  return () => {
    current = (current * 1664525 + 1013904223) >>> 0;
    return current / 0x100000000;
  };
}

describe('suggestTier table rules', () => {
  it('suggests faster for standard when oomRecent is true within 24h', () => {
    const result = suggestTier(
      buildInput({
        currentTierId: 'standard',
        recentPressureEvents: [buildEvent(-5 * MINUTE_MS, 'warning', true)],
      }),
    );

    expect(result).toEqual({
      kind: 'suggestion',
      tierId: 'faster',
      reasonCode: 'oom_24h_standard',
      reasonCopy: 'Cloud is running tight',
    });
  });

  it('suggests faster for standard when critical is sustained for more than 10 minutes with no oom', () => {
    const result = suggestTier(
      buildInput({
        currentTierId: 'standard',
        recentPressureEvents: [buildEvent(-22 * MINUTE_MS, 'critical'), buildEvent(-11 * MINUTE_MS, 'critical')],
      }),
    );

    expect(result).toEqual({
      kind: 'suggestion',
      tierId: 'faster',
      reasonCode: 'sustained_critical_standard',
      reasonCopy: 'Cloud is running tight',
    });
  });

  it('suggests heavy-work for faster when oomRecent is true within 24h', () => {
    const result = suggestTier(
      buildInput({
        currentTierId: 'faster',
        recentPressureEvents: [buildEvent(-30 * MINUTE_MS, 'critical', true)],
      }),
    );

    expect(result).toEqual({
      kind: 'suggestion',
      tierId: 'heavy-work',
      reasonCode: 'oom_24h_faster',
      reasonCopy: 'Cloud needs more room',
    });
  });

  it('returns no_higher_tier for heavy-work when oomRecent is true within 24h', () => {
    const result = suggestTier(
      buildInput({
        currentTierId: 'heavy-work',
        recentPressureEvents: [buildEvent(-30 * MINUTE_MS, 'critical', true)],
      }),
    );

    expect(result).toEqual({ kind: 'no_higher_tier', currentTierId: 'heavy-work' });
  });

  it('returns isolated_warning when pressure is warning only and no oom', () => {
    const result = suggestTier(
      buildInput({
        currentTierId: 'standard',
        recentPressureEvents: [buildEvent(-10 * MINUTE_MS, 'warning'), buildEvent(-2 * MINUTE_MS, 'warning')],
      }),
    );

    expect(result).toEqual({ kind: 'none', reasonCode: 'isolated_warning' });
  });

  it('returns unknown_pressure_state when any event has unknown pressure state', () => {
    const result = suggestTier(
      buildInput({
        currentTierId: 'faster',
        recentPressureEvents: [buildEvent(-7 * MINUTE_MS, 'warning'), buildEvent(-3 * MINUTE_MS, 'unknown')],
      }),
    );

    expect(result).toEqual({ kind: 'none', reasonCode: 'unknown_pressure_state' });
  });

  it('returns no_pressure when events are empty', () => {
    const result = suggestTier(
      buildInput({
        currentTierId: 'standard',
        recentPressureEvents: [],
      }),
    );

    expect(result).toEqual({ kind: 'none', reasonCode: 'no_pressure' });
  });

  it('returns unknown_tier for unknown current tier ids', () => {
    const result = suggestTier(
      buildInput({
        currentTierId: 'enterprise',
        recentPressureEvents: [buildEvent(-10 * MINUTE_MS, 'critical', true)],
      }),
    );

    expect(result).toEqual({ kind: 'unknown_tier', observedTierId: 'enterprise' });
  });
});

describe('suggestTier edge cases', () => {
  it('returns no_pressure for empty windows (explicit edge-case coverage)', () => {
    const result = suggestTier(buildInput({ recentPressureEvents: [] }));
    expect(result).toEqual({ kind: 'none', reasonCode: 'no_pressure' });
  });

  it('returns unknown_tier for future tier ids (enterprise edge-case)', () => {
    const result = suggestTier(buildInput({ currentTierId: 'enterprise' }));
    expect(result).toEqual({ kind: 'unknown_tier', observedTierId: 'enterprise' });
  });

  it('returns unknown_pressure_state when unknown exists anywhere, even if latest sample is ok', () => {
    const result = suggestTier(
      buildInput({
        currentTierId: 'standard',
        recentPressureEvents: [buildEvent(-20 * MINUTE_MS, 'unknown'), buildEvent(-1 * MINUTE_MS, 'ok')],
      }),
    );

    expect(result).toEqual({ kind: 'none', reasonCode: 'unknown_pressure_state' });
  });

  it('still suggests when oomRecent event is 23 hours old and latest event is ok', () => {
    const result = suggestTier(
      buildInput({
        currentTierId: 'standard',
        recentPressureEvents: [buildEvent(-23 * HOUR_MS, 'critical', true), buildEvent(-5 * MINUTE_MS, 'ok')],
      }),
    );

    expect(result).toEqual({
      kind: 'suggestion',
      tierId: 'faster',
      reasonCode: 'oom_24h_standard',
      reasonCopy: 'Cloud is running tight',
    });
  });

  it('does not treat exactly 10 minutes of critical as sustained (>10 minutes required)', () => {
    const result = suggestTier(
      buildInput({
        currentTierId: 'standard',
        recentPressureEvents: [buildEvent(-20 * MINUTE_MS, 'critical'), buildEvent(-10 * MINUTE_MS, 'critical')],
      }),
    );

    expect(result).toEqual({ kind: 'none', reasonCode: 'isolated_warning' });
  });

  it('does not treat a single critical sample as sustained (run duration is zero)', () => {
    const result = suggestTier(
      buildInput({
        currentTierId: 'standard',
        recentPressureEvents: [buildEvent(-6 * MINUTE_MS, 'critical')],
      }),
    );

    expect(result).toEqual({ kind: 'none', reasonCode: 'isolated_warning' });
  });

  it('resets sustained-critical run when a non-critical sample appears between critical samples', () => {
    const result = suggestTier(
      buildInput({
        currentTierId: 'standard',
        recentPressureEvents: [
          buildEvent(-20 * MINUTE_MS, 'critical'),
          buildEvent(-15 * MINUTE_MS, 'warning'),
          buildEvent(-10 * MINUTE_MS, 'critical'),
          buildEvent(0, 'critical'),
        ],
      }),
    );

    expect(result).toEqual({ kind: 'none', reasonCode: 'isolated_warning' });
  });

  it('treats two critical samples 11 minutes apart as sustained when no intervening samples exist', () => {
    const result = suggestTier(
      buildInput({
        currentTierId: 'standard',
        recentPressureEvents: [buildEvent(-11 * MINUTE_MS, 'critical'), buildEvent(0, 'critical')],
      }),
    );

    expect(result).toEqual({
      kind: 'suggestion',
      tierId: 'faster',
      reasonCode: 'sustained_critical_standard',
      reasonCopy: 'Cloud is running tight',
    });
  });

  it('does not treat oomRecent older than 24 hours as an oom trigger', () => {
    const result = suggestTier(
      buildInput({
        currentTierId: 'standard',
        recentPressureEvents: [buildEvent(-25 * HOUR_MS, 'critical', true), buildEvent(-2 * MINUTE_MS, 'ok')],
      }),
    );

    expect(result).toEqual({ kind: 'none', reasonCode: 'isolated_warning' });
  });
});

describe('suggestTier property checks', () => {
  it('always returns one of the declared result kinds for fuzzed inputs', () => {
    const random = createSeededRandom(260527);
    const pressureStates: CloudPressureState[] = ['ok', 'warning', 'critical', 'unknown'];
    const tiers = ['standard', 'faster', 'heavy-work', 'enterprise', 'experimental-tier', ''];
    const allowedKinds: TierSuggestionResult['kind'][] = [
      'suggestion',
      'none',
      'unknown_tier',
      'no_higher_tier',
    ];

    for (let i = 0; i < 250; i += 1) {
      const eventCount = Math.floor(random() * 16);
      const events: CloudPressureEvent[] = [];

      for (let eventIndex = 0; eventIndex < eventCount; eventIndex += 1) {
        const timestampOffsetMs = -Math.floor(random() * 48 * HOUR_MS);
        const state = pressureStates[Math.floor(random() * pressureStates.length)];
        const oomRecent = random() < 0.25;
        events.push(buildEvent(timestampOffsetMs, state, oomRecent));
      }

      const tier = tiers[Math.floor(random() * tiers.length)];
      const result = suggestTier(
        buildInput({
          currentTierId: tier,
          recentPressureEvents: events,
        }),
      );

      expect(allowedKinds).toContain(result.kind);
    }
  });
});
