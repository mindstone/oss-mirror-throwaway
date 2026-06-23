import { useCallback, useEffect, useRef, useState } from 'react';
import { useIpcEvent } from '@renderer/hooks/useIpcEvent';
import type { AppSettings, ModelProfile } from '@shared/types';

type LearnedProfileSnapshot = Pick<
  ModelProfile,
  | 'id'
  | 'name'
  | 'model'
  | 'outputTokensSource'
  | 'outputTokensLearnedAt'
  | 'lastLearnedOutputTokens'
>;

type LearnedEventBase = {
  id: string;
  profileId: string;
  profileName: string;
  model: string;
  observedAt: number;
};

// The context-window learned banner was retired (PLAN.md Stage 3): the derived
// 0.9×last-good-input ceiling was never a value the model reported, so the only
// honest learned notice is the output-cap one (an exact, API-stated value).
export type ProfileLearnedEvent = LearnedEventBase & {
  kind: 'output-cap';
  observedCap: number;
};

type UseProfileLearnedEventsResult = {
  events: ProfileLearnedEvent[];
  dismissEvent: (id: string) => void;
};

const EMPTY_PROFILES: readonly ModelProfile[] = [];
const DISMISSALS_STORAGE_KEY = 'rebel:profile-learned-dismissed:v1';
const MAX_TRACKED_EVENT_IDS = 256;
const MAX_PERSISTED_DISMISSAL_IDS = 256;

const EMPTY_PROFILE_LIST: readonly ModelProfile[] = [];

const toSnapshotMap = (
  profiles: readonly ModelProfile[],
): Map<string, LearnedProfileSnapshot> =>
  new Map(
    profiles.map((profile) => [
      profile.id,
      {
        id: profile.id,
        name: profile.name,
        model: profile.model,
        outputTokensSource: profile.outputTokensSource,
        outputTokensLearnedAt: profile.outputTokensLearnedAt,
        lastLearnedOutputTokens: profile.lastLearnedOutputTokens,
      },
    ]),
  );

const readProfilesFromSettings = (
  settings: AppSettings | null | undefined,
): readonly ModelProfile[] => settings?.localModel?.profiles ?? EMPTY_PROFILES;

const resolveProfileName = (profile: LearnedProfileSnapshot): string => {
  const trimmed = profile.name?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : profile.model ?? profile.id;
};

const buildEventId = (
  profileId: string,
  kind: ProfileLearnedEvent['kind'],
  learnedAt: number,
): string => `${profileId}:${kind}:${learnedAt}`;

const trimEmittedSet = (set: Set<string>, max: number): void => {
  while (set.size > max) {
    const first = set.values().next().value;
    if (first === undefined) return;
    set.delete(first);
  }
};

const readPersistedDismissals = (): Set<string> => {
  if (typeof window === 'undefined' || !window.localStorage) return new Set();
  try {
    const raw = window.localStorage.getItem(DISMISSALS_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    const result = new Set<string>();
    for (const entry of parsed) {
      if (typeof entry === 'string') result.add(entry);
      if (result.size >= MAX_PERSISTED_DISMISSAL_IDS) break;
    }
    return result;
  } catch {
    return new Set();
  }
};

const persistDismissals = (set: Set<string>): void => {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    const limited = Array.from(set).slice(-MAX_PERSISTED_DISMISSAL_IDS);
    window.localStorage.setItem(DISMISSALS_STORAGE_KEY, JSON.stringify(limited));
  } catch {
    /* ignore quota / unavailable storage */
  }
};

const toOutputCapEvent = (
  current: LearnedProfileSnapshot,
  previous: LearnedProfileSnapshot | undefined,
): ProfileLearnedEvent | null => {
  if (current.outputTokensSource !== 'auto') return null;
  if (typeof current.outputTokensLearnedAt !== 'number') return null;
  if (
    typeof previous?.outputTokensLearnedAt === 'number'
    && current.outputTokensLearnedAt <= previous.outputTokensLearnedAt
  ) {
    return null;
  }
  if (typeof current.lastLearnedOutputTokens !== 'number') return null;

  const id = buildEventId(current.id, 'output-cap', current.outputTokensLearnedAt);
  return {
    id,
    kind: 'output-cap',
    profileId: current.id,
    profileName: resolveProfileName(current),
    model: current.model ?? '',
    observedCap: current.lastLearnedOutputTokens,
    observedAt: current.outputTokensLearnedAt,
  };
};

const collectExistingAutoEvents = (
  profiles: readonly ModelProfile[],
): ProfileLearnedEvent[] => {
  const events: ProfileLearnedEvent[] = [];
  const snapshots = toSnapshotMap(profiles);
  for (const profile of profiles) {
    const snapshot = snapshots.get(profile.id);
    if (!snapshot) continue;
    const event = toOutputCapEvent(snapshot, undefined);
    if (event) events.push(event);
  }
  events.sort((a, b) => b.observedAt - a.observedAt);
  return events;
};

export function useProfileLearnedEvents(
  initialProfiles?: readonly ModelProfile[],
): UseProfileLearnedEventsResult {
  const [events, setEvents] = useState<ProfileLearnedEvent[]>([]);
  const previousProfilesRef = useRef<Map<string, LearnedProfileSnapshot>>(new Map());
  const emittedEventIdsRef = useRef<Set<string>>(new Set());
  const dismissedEventIdsRef = useRef<Set<string>>(readPersistedDismissals());
  const seededRef = useRef<boolean>(false);
  const refreshSeqRef = useRef<number>(0);

  const seedFromProfiles = useCallback((profiles: readonly ModelProfile[]) => {
    if (seededRef.current) return;
    seededRef.current = true;
    previousProfilesRef.current = toSnapshotMap(profiles);

    const retroactive = collectExistingAutoEvents(profiles).filter(
      (event) => !dismissedEventIdsRef.current.has(event.id),
    );
    if (retroactive.length === 0) return;

    for (const event of retroactive) {
      emittedEventIdsRef.current.add(event.id);
    }
    trimEmittedSet(emittedEventIdsRef.current, MAX_TRACKED_EVENT_IDS);
    setEvents((prev) => [...retroactive, ...prev]);
  }, []);

  useEffect(() => {
    const list = initialProfiles && initialProfiles.length > 0
      ? initialProfiles
      : EMPTY_PROFILE_LIST;
    if (list.length === 0) return;
    if (seededRef.current) return;
    seedFromProfiles(list);
  }, [initialProfiles, seedFromProfiles]);

  useEffect(() => {
    const getSettings = window.settingsApi?.get;
    if (typeof getSettings !== 'function') return;

    let cancelled = false;
    void getSettings()
      .then((settings) => {
        if (cancelled) return;
        if (seededRef.current) return;
        seedFromProfiles(readProfilesFromSettings(settings));
      })
      .catch((error) => {
        console.warn('[useProfileLearnedEvents] Failed to seed profile snapshot', {
          error: error instanceof Error ? error.message : String(error),
        });
      });

    return () => {
      cancelled = true;
    };
  }, [seedFromProfiles]);

  const refreshFromExternalUpdate = useCallback(async () => {
    const getSettings = window.settingsApi?.get;
    if (typeof getSettings !== 'function') return;

    refreshSeqRef.current += 1;
    const seq = refreshSeqRef.current;

    try {
      const settings = await getSettings();
      if (seq !== refreshSeqRef.current) return;

      const profiles = readProfilesFromSettings(settings);
      const previousProfiles = previousProfilesRef.current;
      const nextProfiles = toSnapshotMap(profiles);

      if (!seededRef.current) {
        seedFromProfiles(profiles);
        return;
      }

      const nextEvents: ProfileLearnedEvent[] = [];
      for (const profile of profiles) {
        const current = nextProfiles.get(profile.id);
        if (!current) continue;

        const previous = previousProfiles.get(profile.id);
        const outputCapEvent = toOutputCapEvent(current, previous);
        if (
          outputCapEvent
          && !emittedEventIdsRef.current.has(outputCapEvent.id)
          && !dismissedEventIdsRef.current.has(outputCapEvent.id)
        ) {
          emittedEventIdsRef.current.add(outputCapEvent.id);
          nextEvents.push(outputCapEvent);
        }
      }

      previousProfilesRef.current = nextProfiles;
      trimEmittedSet(emittedEventIdsRef.current, MAX_TRACKED_EVENT_IDS);
      if (nextEvents.length > 0) {
        setEvents((currentEvents) => [...nextEvents, ...currentEvents]);
      }
    } catch (error) {
      console.warn('[useProfileLearnedEvents] Failed to read settings external update', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, [seedFromProfiles]);

  useIpcEvent(window.api?.onSettingsExternalUpdate, () => {
    void refreshFromExternalUpdate();
  }, [refreshFromExternalUpdate]);

  const dismissEvent = useCallback((id: string) => {
    dismissedEventIdsRef.current.add(id);
    persistDismissals(dismissedEventIdsRef.current);
    setEvents((currentEvents) => currentEvents.filter((event) => event.id !== id));
  }, []);

  return { events, dismissEvent };
}
