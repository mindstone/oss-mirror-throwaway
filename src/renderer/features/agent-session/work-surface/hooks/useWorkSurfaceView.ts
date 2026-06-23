import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentEvent } from '@shared/types';
import { createMessageSnippet, formatDurationShort } from '@renderer/utils/formatters';
import {
  DEFAULT_STORYLINE_FILTERS,
  STORYLINE_FILTER_STORAGE_KEY,
  type StorylineFilters,
  type WorkSurfaceView
} from '../types';
import {
  buildPersonaState,
  getDurationBucket,
  getNextPersonaQuip,
  getToolQuip,
  DYNAMIC_QUIP_THRESHOLD_MS,
  PERSONA_QUIP_DELAY_MS,
  PERSONA_QUIP_ROTATION_MS,
  TIP_PHASE_DURATION_MS,
  type PersonaDurationBucket,
  type PersonaState,
  type ToolCategory
} from '../utils/personaQuips';
import { getRandomTipExcluding } from '@shared/data/tips';

type ThinkingStage = 'generation' | 'processing' | null;

type UseWorkSurfaceViewArgs = {
  assistantEvents: AgentEvent[];
  assistantSteps: AgentEvent[];
  /** All events for the current turn (currently unused - kept for potential future router re-enablement) */
  allTurnEvents: AgentEvent[];
  isViewSessionBusy: boolean;
  /** Timestamp (epoch ms) when the active turn started, or null when idle.
   *  busyElapsedMs is computed locally from this — no Zustand store involvement. */
  runtimeStartedAt: number | null;
  visibleTurnId: string | null;
  /** Current session ID — used to reset view mode (e.g., exit diagnostics) on session switch */
  sessionId: string | null;
  /** Last user message text for contextual quip generation */
  lastUserMessage?: string;
};

type UseWorkSurfaceViewResult = {
  workSurfaceView: WorkSurfaceView;
  isInsightSurface: boolean;
  isDiagnosticsSurface: boolean;
  isSessionSurface: boolean;
  storylineFilters: StorylineFilters;
  toggleStorylineFilter: (filter: keyof StorylineFilters) => void;
  toggleWorkSurfaceView: () => void;
  toggleDiagnosticsView: () => void;
  /** Exit diagnostics/insights and return to normal session view */
  resetToSessionView: () => void;
  showTechnicalDetails: boolean;
  setShowTechnicalDetails: React.Dispatch<React.SetStateAction<boolean>>;
  thinkingStage: ThinkingStage;
  thinkingHeadline: string;
  thinkingHeadlinePreview: string;
  thinkingHint: string;
  thinkingElapsedLabel: string;
  thinkingDurationBucket: PersonaDurationBucket | null;
  displayStepsCount: number;
  insightButtonDescription: string;
};

export const useWorkSurfaceView = (args: UseWorkSurfaceViewArgs): UseWorkSurfaceViewResult => {
  // Note: allTurnEvents is currently unused (router is disabled) but kept in interface for future use
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- field kept in destructure to preserve the API surface when the router is re-enabled
  const { assistantEvents, assistantSteps, allTurnEvents, isViewSessionBusy, runtimeStartedAt, visibleTurnId, sessionId, lastUserMessage } = args;

  // PERF: Compute busyElapsedMs locally instead of subscribing to Zustand store.
  // This eliminates 12 Zustand writes/min during active turns. Uses the same 5s
  // bucket strategy previously implemented in useAgentSessionEngine.
  const ELAPSED_BUCKET_MS = 5000;
  const [busyElapsedMs, setBusyElapsedMs] = useState(0);

  useEffect(() => {
    if (runtimeStartedAt == null) {
      setBusyElapsedMs(0);
      return;
    }
    // Compute initial value immediately
    const elapsed = Math.max(0, Date.now() - runtimeStartedAt);
    const bucket = Math.floor(elapsed / ELAPSED_BUCKET_MS) * ELAPSED_BUCKET_MS;
    setBusyElapsedMs(bucket);

    const tick = () => {
      const now = Math.max(0, Date.now() - runtimeStartedAt);
      const b = Math.floor(now / ELAPSED_BUCKET_MS) * ELAPSED_BUCKET_MS;
      setBusyElapsedMs((prev) => (b !== prev ? b : prev));
    };
    const id = window.setInterval(tick, 1000);
    const handleVisibility = () => { if (!document.hidden) tick(); };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [runtimeStartedAt]);

  const [workSurfaceView, setWorkSurfaceView] = useState<WorkSurfaceView>('session');

  // Reset to normal session view when switching conversations
  useEffect(() => {
    setWorkSurfaceView('session');
  }, [sessionId]);

  const [storylineFilters, setStorylineFilters] = useState<StorylineFilters>(() => {
    if (typeof window === 'undefined') return { ...DEFAULT_STORYLINE_FILTERS };
    try {
      const stored = window.localStorage.getItem(STORYLINE_FILTER_STORAGE_KEY);
      if (!stored) return { ...DEFAULT_STORYLINE_FILTERS };
      const parsed = JSON.parse(stored) as Partial<StorylineFilters>;
      return { ...DEFAULT_STORYLINE_FILTERS, ...parsed };
    } catch {
      return { ...DEFAULT_STORYLINE_FILTERS };
    }
  });
  const [showTechnicalDetails, setShowTechnicalDetails] = useState(true);
  const personaCursorRef = useRef<Record<PersonaState, number | undefined>>({} as Record<PersonaState, number | undefined>);
  const toolCursorRef = useRef<Record<ToolCategory, number | undefined>>({} as Record<ToolCategory, number | undefined>);
  const [personaHeadline, setPersonaHeadline] = useState('');

  // Dynamic quip generation state
  const [dynamicQuips, setDynamicQuips] = useState<string[]>([]);
  const dynamicQuipIndexRef = useRef(0);
  const dynamicQuipRequestedForTurnRef = useRef<string | null>(null);
  const busyElapsedMsRef = useRef(busyElapsedMs);
  // Track whether we're past the initial delay for this turn
  const [pastInitialDelay, setPastInitialDelay] = useState(false);
  // Track whether we're past the tip phase (into quip phase)
  const [pastTipPhase, setPastTipPhase] = useState(false);
  // Track recently shown tips to avoid repetition
  const recentTipIdsRef = useRef<string[]>([]);
  const pastInitialDelayRef = useRef(pastInitialDelay);
  const pastTipPhaseRef = useRef(pastTipPhase);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORYLINE_FILTER_STORAGE_KEY, JSON.stringify(storylineFilters));
    } catch {
      // Ignore persistence errors
    }
  }, [storylineFilters]);

  useEffect(() => {
    setShowTechnicalDetails(true);
  }, [visibleTurnId]);

  // Keep busyElapsedMs ref current
  useEffect(() => {
    busyElapsedMsRef.current = busyElapsedMs;
  }, [busyElapsedMs]);

  // Reset dynamic quips, tip phase, and initial delay when turn changes
  useEffect(() => {
    setDynamicQuips([]);
    dynamicQuipIndexRef.current = 0;
    dynamicQuipRequestedForTurnRef.current = null;
    setPastInitialDelay(false);
    setPastTipPhase(false);
    // Keep recent tips across turns to maintain variety
  }, [visibleTurnId]);

  // Ref to trigger immediate headline update AND restart the interval timer
  // This ensures the next rotation waits the full interval from the phase transition
  const restartHeadlineRotationRef = useRef<(() => void) | null>(null);

  // Set up timeout to enable tips after initial delay
  useEffect(() => {
    if (!isViewSessionBusy || pastInitialDelay) {
      return;
    }
    const timeoutId = window.setTimeout(() => {
      // Update ref immediately so updateHeadline sees the new value
      pastInitialDelayRef.current = true;
      setPastInitialDelay(true);
      // Trigger immediate update and restart interval when entering tip phase
      restartHeadlineRotationRef.current?.();
    }, PERSONA_QUIP_DELAY_MS);
    return () => window.clearTimeout(timeoutId);
  }, [isViewSessionBusy, pastInitialDelay]);

  // Set up timeout to transition from tip phase to quip phase
  useEffect(() => {
    if (!isViewSessionBusy || !pastInitialDelay || pastTipPhase) {
      return;
    }
    const timeoutId = window.setTimeout(() => {
      // Update ref immediately so updateHeadline sees the new value
      pastTipPhaseRef.current = true;
      setPastTipPhase(true);
      // Trigger immediate update and restart interval when entering quip phase
      restartHeadlineRotationRef.current?.();
    }, TIP_PHASE_DURATION_MS);
    return () => window.clearTimeout(timeoutId);
  }, [isViewSessionBusy, pastInitialDelay, pastTipPhase]);

  const toggleStorylineFilter = useCallback((filter: keyof StorylineFilters) => {
    setStorylineFilters((prev) => {
      const next = { ...prev, [filter]: !prev[filter] };
      if (!Object.values(next).some(Boolean)) {
        return prev;
      }
      return next;
    });
  }, []);

  const toggleWorkSurfaceView = useCallback(() => {
    setWorkSurfaceView((mode) => (mode === 'insights' ? 'session' : 'insights'));
  }, []);

  const toggleDiagnosticsView = useCallback(() => {
    if (isViewSessionBusy) {
      return;
    }
    setWorkSurfaceView((mode) => (mode === 'diagnostics' ? 'session' : 'diagnostics'));
  }, [isViewSessionBusy]);

  const resetToSessionView = useCallback(() => {
    setWorkSurfaceView('session');
  }, []);

  const assistantStepsCount = assistantSteps.length;

  const displayStepsCount = useMemo(
    () => (isViewSessionBusy ? assistantEvents.length : assistantStepsCount),
    [assistantEvents.length, assistantStepsCount, isViewSessionBusy]
  );

  const thinkingStage: ThinkingStage = useMemo(() => {
    if (!isViewSessionBusy) {
      return null;
    }
    return assistantEvents.length > 0 ? 'generation' : 'processing';
  }, [assistantEvents.length, isViewSessionBusy]);

  const activeToolName = useMemo<string | null>(() => {
    if (!isViewSessionBusy) {
      return null;
    }
    const startedTools = new Map<string, string>();
    for (const event of assistantEvents) {
      if (event.type === 'tool' && event.toolUseId) {
        if (event.stage === 'start') {
          startedTools.set(event.toolUseId, event.toolName);
        } else if (event.stage === 'end') {
          startedTools.delete(event.toolUseId);
        }
      }
    }
    const activeTools = Array.from(startedTools.values());
    return activeTools.length > 0 ? activeTools[activeTools.length - 1] : null;
  }, [assistantEvents, isViewSessionBusy]);

  const defaultThinkingHeadline = useMemo(() => {
    if (thinkingStage === 'generation') {
      return 'Drafting your answer';
    }
    if (thinkingStage === 'processing') {
      return 'Reviewing your request';
    }
    return '';
  }, [thinkingStage]);

  const personaState = useMemo<PersonaState | null>(() => {
    if (!isViewSessionBusy || !thinkingStage) {
      return null;
    }
    return buildPersonaState(thinkingStage, busyElapsedMs);
  }, [busyElapsedMs, isViewSessionBusy, thinkingStage]);

  // Derived state that only changes when crossing the 30s threshold
  // This prevents the dynamic quip effect from re-running every tick
  const pastDynamicThreshold = busyElapsedMs >= DYNAMIC_QUIP_THRESHOLD_MS;

  // Request dynamic quips when threshold is crossed
  useEffect(() => {
    if (!isViewSessionBusy || !visibleTurnId || !lastUserMessage || !thinkingStage) {
      return;
    }

    // Only request when past the 30s threshold
    if (!pastDynamicThreshold) {
      return;
    }

    // Only request once per turn
    if (dynamicQuipRequestedForTurnRef.current === visibleTurnId) {
      return;
    }

    dynamicQuipRequestedForTurnRef.current = visibleTurnId;

    // Request dynamic quips via IPC
    window.miscApi
      ?.generate({
        userMessage: lastUserMessage,
        turnId: visibleTurnId,
        stage: thinkingStage
      })
      .then((result) => {
        // Verify we're still on the same turn before updating state
        if (dynamicQuipRequestedForTurnRef.current !== visibleTurnId) {
          return;
        }
        if (result.success && result.quips && result.quips.length > 0) {
          setDynamicQuips(result.quips);
          dynamicQuipIndexRef.current = 0;
        }
      })
      .catch((err) => {
        // Log for debugging but fall back to static quips silently
        if (err?.name !== 'AbortError') {
          console.warn('[useWorkSurfaceView] Dynamic quip generation failed:', err);
        }
      });
  }, [isViewSessionBusy, lastUserMessage, pastDynamicThreshold, thinkingStage, visibleTurnId]);

  // Store latest values in refs so the interval callback always has current data
  // without requiring effect re-runs that would reset the interval
  const activeToolNameRef = useRef(activeToolName);
  const dynamicQuipsRef = useRef(dynamicQuips);
  const personaStateRef = useRef(personaState);

  useEffect(() => {
    activeToolNameRef.current = activeToolName;
  }, [activeToolName]);

  useEffect(() => {
    dynamicQuipsRef.current = dynamicQuips;
  }, [dynamicQuips]);

  useEffect(() => {
    pastInitialDelayRef.current = pastInitialDelay;
  }, [pastInitialDelay]);

  useEffect(() => {
    pastTipPhaseRef.current = pastTipPhase;
  }, [pastTipPhase]);

  useEffect(() => {
    personaStateRef.current = personaState;
  }, [personaState]);

  // Set up headline rotation interval - only re-runs when session busy state changes
  useEffect(() => {
    if (!isViewSessionBusy) {
      setPersonaHeadline('');
      return;
    }

    const updateHeadline = () => {
      const currentPersonaState = personaStateRef.current;
      const currentPastInitialDelay = pastInitialDelayRef.current;
      const currentPastTipPhase = pastTipPhaseRef.current;
      const currentDynamicQuips = dynamicQuipsRef.current;
      const currentActiveToolName = activeToolNameRef.current;

      // Show just spinner (empty headline) before the delay threshold
      if (!currentPastInitialDelay || !currentPersonaState) {
        setPersonaHeadline('');
        return;
      }

      // Tip phase: show tips before switching to quips (4-12s)
      if (!currentPastTipPhase) {
        const tip = getRandomTipExcluding(recentTipIdsRef.current);
        // Track recent tips (keep last 5 to avoid repetition)
        recentTipIdsRef.current = [...recentTipIdsRef.current.slice(-4), tip.id];
        setPersonaHeadline(tip.content);
        return;
      }

      // Use dynamic quips when available (after 30s threshold)
      if (currentDynamicQuips.length > 0) {
        const quip = currentDynamicQuips[dynamicQuipIndexRef.current % currentDynamicQuips.length];
        dynamicQuipIndexRef.current = (dynamicQuipIndexRef.current + 1) % currentDynamicQuips.length;
        setPersonaHeadline((prev) => (prev === quip ? prev : quip));
        return;
      }

      // Use tool-specific quips when a tool is active
      if (currentActiveToolName) {
        const toolQuip = getToolQuip(currentActiveToolName, toolCursorRef);
        if (toolQuip) {
          setPersonaHeadline((prev) => (prev === toolQuip ? prev : toolQuip));
          return;
        }
      }

      // Fall back to persona quips
      const next = getNextPersonaQuip(currentPersonaState, personaCursorRef) || '';
      setPersonaHeadline((prev) => (prev === next ? prev : next));
    };

    if (typeof window === 'undefined') {
      return undefined;
    }

    let intervalId: number | null = null;

    const start = () => {
      if (intervalId !== null) {
        return;
      }
      intervalId = window.setInterval(updateHeadline, PERSONA_QUIP_ROTATION_MS);
    };

    const stop = () => {
      if (intervalId !== null) {
        window.clearInterval(intervalId);
        intervalId = null;
      }
    };

    const handleVisibility = () => {
      if (typeof document !== 'undefined' && document.hidden) {
        stop();
      } else {
        updateHeadline();
        start();
      }
    };

    // Expose a restart function so phase transitions can update immediately
    // and reset the interval timer (so next rotation waits full interval)
    const restart = () => {
      stop();
      updateHeadline();
      start();
    };
    restartHeadlineRotationRef.current = restart;

    if (typeof document === 'undefined' || !document.hidden) {
      updateHeadline();
      start();
    }

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibility);
    }

    return () => {
      restartHeadlineRotationRef.current = null;
      stop();
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibility);
      }
    };
  }, [isViewSessionBusy]);

  // Only fall back to default headline after the initial delay period
  // During the delay, we want an empty headline so the UI shows dots/spinner
  const thinkingHeadline = personaHeadline || (pastInitialDelay ? defaultThinkingHeadline : '');

  const thinkingHeadlinePreview = useMemo(() => {
    if (!thinkingHeadline) {
      return '';
    }
    return createMessageSnippet(thinkingHeadline, 60);
  }, [thinkingHeadline]);

  const thinkingDurationBucket = useMemo<PersonaDurationBucket | null>(() => {
    if (!isViewSessionBusy) {
      return null;
    }
    return getDurationBucket(busyElapsedMs);
  }, [busyElapsedMs, isViewSessionBusy]);

  const thinkingHint = useMemo(() => {
    if (!thinkingStage) {
      return '';
    }

    if (busyElapsedMs >= 300_000) {
      return 'Marathon mode: your agent is deep in thought. Check back when you are ready—we will have something good.';
    }
    if (busyElapsedMs >= 120_000) {
      return 'Taking a while, but making progress. The Steps panel shows what is happening.';
    }
    if (busyElapsedMs >= 60_000) {
      return 'This is a longer run—perfect time to grab coffee or review other code.';
    }
    if (busyElapsedMs >= 45_000) {
      return "Long run detected—feel free to explore other files. We'll keep this transcript updated.";
    }
    if (busyElapsedMs >= 25_000) {
      return 'Still running. Peek at "Steps" to watch tool activity while you continue working.';
    }
    if (busyElapsedMs >= 12_000) {
      return thinkingStage === 'generation'
        ? 'Streaming the draft in real time. You can skim earlier messages meanwhile.'
        : 'Gathering workspace context and tools. Open "Steps" to see progress.';
    }
    return thinkingStage === 'generation'
      ? 'Drafting the response—tokens will appear as they are ready.'
      : 'Analyzing your prompt and loading relevant context.';
  }, [busyElapsedMs, thinkingStage]);

  const thinkingElapsedLabel = useMemo(() => {
    if (!isViewSessionBusy || busyElapsedMs < 1000) {
      return '';
    }
    return formatDurationShort(busyElapsedMs);
  }, [busyElapsedMs, isViewSessionBusy]);

  const insightButtonDescription = useMemo(() => {
    if (isViewSessionBusy) {
      const parts = [thinkingHeadline || 'Working on it'];
      if (thinkingElapsedLabel) {
        parts.push(thinkingElapsedLabel);
      }
      return parts.join(' · ');
    }
    if (displayStepsCount > 0) {
      return `${displayStepsCount} step${displayStepsCount === 1 ? '' : 's'}`;
    }
    return 'No steps yet';
  }, [displayStepsCount, isViewSessionBusy, thinkingElapsedLabel, thinkingHeadline]);

  return {
    workSurfaceView,
    isInsightSurface: workSurfaceView === 'insights',
    isDiagnosticsSurface: workSurfaceView === 'diagnostics',
    isSessionSurface: workSurfaceView === 'session',
    storylineFilters,
    toggleStorylineFilter,
    toggleWorkSurfaceView,
    toggleDiagnosticsView,
    resetToSessionView,
    showTechnicalDetails,
    setShowTechnicalDetails,
    thinkingStage,
    thinkingHeadline,
    thinkingHeadlinePreview,
    thinkingHint,
    thinkingElapsedLabel,
    thinkingDurationBucket,
    displayStepsCount,
    insightButtonDescription,
  };
};
