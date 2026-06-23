import { getWorkingModelProfile, type AppSettings } from '@shared/types';
import type { SettingsDriftField } from './manifest';

type DiffKind = 'a_set_b_unset' | 'b_set_a_unset' | 'a_b_differ_enum' | 'a_b_differ_typed';
export type SettingsDriftEventState = 'observed' | 'resolved';

export const SETTINGS_DRIFT_REEMIT_WINDOW_MS = 60_000;

export interface SettingsDriftObservation {
  field: SettingsDriftField;
  diffKind: DiffKind;
}

export interface SettingsDriftEmissionCache {
  lastFingerprint: string | null;
  lastEmittedAtMs: number | null;
  lastObservations: SettingsDriftObservation[];
}

export interface SettingsDriftEmissionDecision {
  shouldEmit: boolean;
  eventState: SettingsDriftEventState;
  fingerprint: string | null;
  observations: SettingsDriftObservation[];
}

export function detectSettingsDrift(a: AppSettings, b: AppSettings): SettingsDriftObservation[] {
  const diffs: SettingsDriftObservation[] = [];

  const check = (
    field: SettingsDriftField,
    valA: unknown,
    valB: unknown,
    compareTyped: boolean = false,
  ) => {
    if (valA !== undefined && valB === undefined) {
      diffs.push({ field, diffKind: 'a_set_b_unset' });
    } else if (valA === undefined && valB !== undefined) {
      diffs.push({ field, diffKind: 'b_set_a_unset' });
    } else if (valA !== valB) {
      diffs.push({ field, diffKind: compareTyped ? 'a_b_differ_typed' : 'a_b_differ_enum' });
    }
  };

  // Check the closed enum fields
  check('active_provider', a.activeProvider, b.activeProvider);
  check('memory_enabled', a.memoryUpdateEnabled, b.memoryUpdateEnabled);

  const turnProfileIdA = getWorkingModelProfile(a)?.id;
  const turnProfileIdB = getWorkingModelProfile(b)?.id;
  check('turn_model_profile_id', turnProfileIdA, turnProfileIdB, true);

  return diffs;
}

export function createSettingsDriftEmissionCache(): SettingsDriftEmissionCache {
  return {
    lastFingerprint: null,
    lastEmittedAtMs: null,
    lastObservations: [],
  };
}

export function fingerprintSettingsDriftObservations(
  observations: readonly SettingsDriftObservation[],
): string | null {
  if (observations.length === 0) return null;

  return sortSettingsDriftObservations(observations)
    .map(({ field, diffKind }) => `${field}:${diffKind}`)
    .join('|');
}

export function consumeSettingsDriftEmissionDecision(
  observations: readonly SettingsDriftObservation[],
  cache: SettingsDriftEmissionCache,
  options: {
    nowMs?: number;
    suppressWindowMs?: number;
  } = {},
): SettingsDriftEmissionDecision {
  const nowMs = options.nowMs ?? Date.now();
  const suppressWindowMs = options.suppressWindowMs ?? SETTINGS_DRIFT_REEMIT_WINDOW_MS;
  const fingerprint = fingerprintSettingsDriftObservations(observations);
  const previousFingerprint = cache.lastFingerprint;

  if (fingerprint === null && previousFingerprint === null) {
    return {
      shouldEmit: false,
      eventState: 'resolved',
      fingerprint,
      observations: [],
    };
  }

  const lastEmittedAtMs = cache.lastEmittedAtMs;
  const isWithinSuppressWindow = lastEmittedAtMs !== null
    && nowMs - lastEmittedAtMs < suppressWindowMs;

  if (fingerprint === previousFingerprint && isWithinSuppressWindow) {
    return {
      shouldEmit: false,
      eventState: fingerprint === null ? 'resolved' : 'observed',
      fingerprint,
      observations: [],
    };
  }

  const eventState: SettingsDriftEventState = fingerprint === null ? 'resolved' : 'observed';
  const observationsToEmit = eventState === 'resolved'
    ? cache.lastObservations
    : sortSettingsDriftObservations(observations);

  if (observationsToEmit.length === 0) {
    return {
      shouldEmit: false,
      eventState,
      fingerprint,
      observations: [],
    };
  }

  cache.lastFingerprint = fingerprint;
  cache.lastEmittedAtMs = nowMs;
  cache.lastObservations = eventState === 'resolved'
    ? []
    : observationsToEmit;

  return {
    shouldEmit: true,
    eventState,
    fingerprint,
    observations: observationsToEmit,
  };
}

function sortSettingsDriftObservations(
  observations: readonly SettingsDriftObservation[],
): SettingsDriftObservation[] {
  return [...observations].sort((left, right) => {
    const fieldComparison = left.field.localeCompare(right.field);
    if (fieldComparison !== 0) return fieldComparison;
    return left.diffKind.localeCompare(right.diffKind);
  });
}
