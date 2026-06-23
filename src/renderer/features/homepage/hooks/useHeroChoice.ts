/**
 * useHeroChoice — Fetches the current hero choice entry and manages candidate state.
 *
 * Fetches via IPC on mount, subscribes to `hero-choice:updated` broadcast for
 * live updates. Exposes the first pending candidate and actions (act, dismiss, feedback).
 *
 * Pattern follows useSystemImprovementSuggestions.ts:
 *   - window.heroChoiceApi for IPC calls
 *   - window.api.onHeroChoiceUpdated for broadcast subscription
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { isHeroChoiceStale, type HeroChoiceCandidate, type HeroChoiceEntry } from '../../../../core/heroChoiceTypes';

// ── Pure logic helpers (exported for testing) ────────────

/** Returns true if a meeting_prep candidate's meeting has already started. */
function isMeetingPrepExpired(candidate: HeroChoiceCandidate): boolean {
  return (
    candidate.type === 'meeting_prep' &&
    candidate.meetingStartTime != null &&
    candidate.meetingStartTime <= Date.now()
  );
}

/** Find the first pending candidate by priority order (sorted in candidates array). */
export function findPendingCandidate(entry: HeroChoiceEntry | null): HeroChoiceCandidate | null {
  if (!entry) return null;
  for (const candidate of entry.result.candidates) {
    if (entry.candidateStates[candidate.id] === 'pending' && !isMeetingPrepExpired(candidate)) {
      return candidate;
    }
  }
  return null;
}

/** Returns true when no actionable candidates remain (acted, dismissed, or expired). */
export function isAllCaughtUp(entry: HeroChoiceEntry | null): boolean {
  if (!entry) return false;
  return entry.result.candidates.every(
    (c: HeroChoiceCandidate) => entry.candidateStates[c.id] !== 'pending' || isMeetingPrepExpired(c)
  );
}

// ── Run mode type ────────────────────────────────────────

export type HeroChoiceRunMode = 'ask' | 'automatic' | 'off';

// ── Hook types ───────────────────────────────────────────

interface UseHeroChoiceReturn {
  /** The first pending candidate (by priority order) */
  currentCandidate: HeroChoiceCandidate | null;
  /** All pending candidates in priority order (for carousel integration) */
  pendingCandidates: HeroChoiceCandidate[];
  /** One-liner about the user's week (for ProgressCard) */
  weekSummary: string | null;
  /** Per-candidate feedback state */
  feedbackState: Record<string, 'helpful' | 'not_helpful'>;
  /** Data is still loading */
  isLoading: boolean;
  /** No entry exists (hero choice hasn't run yet) */
  isEmpty: boolean;
  /** Entry exists but all candidates are acted/dismissed */
  allCaughtUp: boolean;
  /** On-demand generation is in progress */
  isGenerating: boolean;
  /** Error message from last failed generation attempt (null when idle or successful) */
  generationError: string | null;
  /** Current run mode setting */
  runMode: HeroChoiceRunMode;
  /** Mark a candidate as acted */
  act: (candidateId: string) => void;
  /** Mark a candidate as dismissed, advances to next */
  dismiss: (candidateId: string) => void;
  /** Give feedback on a candidate */
  giveFeedback: (candidateId: string, feedback: 'helpful' | 'not_helpful') => void;
  /** Trigger on-demand generation (for the prompt card CTA) */
  generateNow: () => void;
  /** Update the run mode setting */
  updateRunMode: (mode: HeroChoiceRunMode) => void;
}

export function useHeroChoice(): UseHeroChoiceReturn {
  const [entry, setEntry] = useState<HeroChoiceEntry | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generationError, setGenerationError] = useState<string | null>(null);
  const [runMode, setRunMode] = useState<HeroChoiceRunMode>('ask');
  const generatingRef = useRef(false);

  const fetchEntry = useCallback(async () => {
    try {
      const result = await window.heroChoiceApi.getCurrent({});
      setEntry(result.entry);
    } catch (err) {
      console.warn('[HeroChoice] Failed to fetch current entry:', err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchEntry();

    void window.settingsApi.get().then(settings => {
      setRunMode(settings.heroChoiceRunMode ?? 'ask');
    }).catch(() => { /* use default */ });

    const cleanup = window.api.onHeroChoiceUpdated?.(() => {
      void fetchEntry();
    });

    return cleanup;
  }, [fetchEntry]);

  const isEntryStale = useMemo(
    () => entry ? isHeroChoiceStale(entry.result.generatedAt) : true,
    [entry],
  );

  const currentCandidate = useMemo(() => {
    if (runMode === 'off') return null;
    if (runMode === 'ask' && isEntryStale) return null;
    return findPendingCandidate(entry);
  }, [entry, runMode, isEntryStale]);

  const pendingCandidates = useMemo(() => {
    if (runMode === 'off') return [];
    if (runMode === 'ask' && isEntryStale) return [];
    if (!entry) return [];
    return entry.result.candidates.filter(
      (c: HeroChoiceCandidate) => entry.candidateStates[c.id] === 'pending' && !isMeetingPrepExpired(c)
    );
  }, [entry, runMode, isEntryStale]);

  const effectiveEntry = (runMode === 'ask' && isEntryStale) ? null : entry;
  const weekSummary = effectiveEntry?.result.weekSummary ?? null;
  const feedbackState = effectiveEntry?.feedback ?? {};
  const isEmpty = !isLoading && effectiveEntry === null;
  const allCaughtUp = useMemo(() => isAllCaughtUp(effectiveEntry), [effectiveEntry]);

  const act = useCallback((candidateId: string) => {
    setEntry((prev: HeroChoiceEntry | null) => {
      if (!prev) return prev;
      return {
        ...prev,
        candidateStates: { ...prev.candidateStates, [candidateId]: 'acted' },
      };
    });
    void window.heroChoiceApi.updateCandidateState({ candidateId, state: 'acted' });
  }, []);

  const dismiss = useCallback((candidateId: string) => {
    setEntry((prev: HeroChoiceEntry | null) => {
      if (!prev) return prev;
      return {
        ...prev,
        candidateStates: { ...prev.candidateStates, [candidateId]: 'dismissed' },
      };
    });
    void window.heroChoiceApi.updateCandidateState({ candidateId, state: 'dismissed' });
  }, []);

  const giveFeedback = useCallback((candidateId: string, feedback: 'helpful' | 'not_helpful') => {
    setEntry((prev: HeroChoiceEntry | null) => {
      if (!prev) return prev;
      return {
        ...prev,
        feedback: { ...prev.feedback, [candidateId]: feedback },
      };
    });
    void window.heroChoiceApi.setFeedback({ candidateId, feedback });
  }, []);

  const generateNow = useCallback(() => {
    if (generatingRef.current) return;
    generatingRef.current = true;
    setIsGenerating(true);
    setGenerationError(null);
    void window.heroChoiceApi.generateNow({}).then(result => {
      if (result.entry) {
        setEntry(result.entry);
      } else if (result.error) {
        setGenerationError(result.error);
      }
    }).catch(err => {
      const msg = err instanceof Error ? err.message : String(err);
      setGenerationError(msg);
      console.warn('[HeroChoice] On-demand generation failed:', err);
    }).finally(() => {
      generatingRef.current = false;
      setIsGenerating(false);
    });
  }, []);

  const updateRunMode = useCallback((mode: HeroChoiceRunMode) => {
    setRunMode(mode);
    void window.settingsApi.get().then(current => {
      void window.settingsApi.update({ ...current, heroChoiceRunMode: mode });
    }).catch(() => { /* best-effort */ });
  }, []);

  return {
    currentCandidate,
    pendingCandidates,
    weekSummary,
    feedbackState,
    isLoading,
    isEmpty,
    allCaughtUp,
    isGenerating,
    generationError,
    runMode,
    act,
    dismiss,
    giveFeedback,
    generateNow,
    updateRunMode,
  };
}
