/**
 * OnboardingCoachOrchestrator
 *
 * Pure-orchestration component (renders null) that owns all refs, effects, and
 * callbacks for the onboarding coach flow.  Conditionally mounted only while
 * `settings.onboardingCompletedAt` is unset, so its ~32 hooks never execute
 * after onboarding finishes.
 *
 * State consumed by App.tsx JSX (isOnboardingCoachActive,
 * showOnboardingManualContinue) is owned by App.tsx and written here via callbacks.
 * handleCoachComplete and handleFinalSetupStepEntered are
 * exposed via useImperativeHandle so App.tsx can forward them to JSX consumers.
 */

import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { AgentAttachmentPayload, AppSettings } from '@shared/types';
import type { EmitLogFn } from '@renderer/contexts';
import { subscribeToSessionStore, getSessionStoreState } from '@renderer/features/agent-session/store';
import { createId } from '@shared/utils/id';
import { fireAndForget } from '@shared/utils/fireAndForget';
import { setSuppressNotifications } from '@renderer/utils/notificationSuppress';
import { tracking } from '@renderer/src/tracking';
import { useEscapeHatchHotkey } from './hooks/useEscapeHatchHotkey';
import { TUTORIAL_STEPS } from './config/tutorialChecklistConfig';
import type { OnboardingChecklistStep } from '@shared/types';

// ─── Public ref handle ──────────────────────────────────────────────────────
export interface OnboardingCoachOrchestratorRef {
  handleCoachComplete: () => void;
  handleCoachDeferred: () => void;
  handleFinalSetupStepEntered: () => void;
}

// ─── Props ──────────────────────────────────────────────────────────────────
export interface OnboardingCoachOrchestratorProps {
  // Inbound — narrow, stable values from App.tsx
  shouldRenderMainApp: boolean;
  showOnboardingWizard: boolean;
  onboardingDay: number | undefined;
  onboardingCompletedAt: number | undefined;
  launchRequestId?: number;
  isOnboardingCoachActive: boolean;
  resetSessionState: () => string;
  handleUserMessageRef: RefObject<((
    text: string,
    source?: 'text' | 'voice',
    attachments?: AgentAttachmentPayload[],
    options?: { editTargetMessageId?: string; targetSessionId?: string; sessionType?: 'manual' | 'automation'; bypassToolSafety?: boolean }
  ) => Promise<void>) | null>;
  saveSettingsWith: (updater: (draft: AppSettings) => AppSettings) => Promise<void>;
  emitLog: EmitLogFn;

  /** Coach session ID from persisted settings (for resuming after app restart) */
  persistedCoachSessionId?: string;
  /** Discovery session ID from persisted settings (prevents re-running discovery on onboarding re-entry) */
  persistedDiscoverySessionId?: string;

  // Outbound — individual setters (avoids object identity churn)
  setIsOnboardingCoachActive: (b: boolean) => void;
  setShowOnboardingManualContinue: (b: boolean) => void;
  setActiveSurface: (s: string) => void;
  setShowConversation: (b: boolean) => void;
}

// ─── Prompt constants ───────────────────────────────────────────────────────

/**
 * Hard-coded first assistant message for the onboarding coach.
 * Injected directly into the session store to eliminate the 3-8s wait for the
 * agent to generate a greeting. The coaching instructions are provided via the
 * system prompt (sessionType: 'onboarding-coach'), so the agent picks up
 * naturally when the user replies.
 *
 * Reusable pattern: Any conversation can pre-seed an instant greeting by
 * injecting a result event into the store before the first real agent turn.
 * The agent sees this in conversation history and continues naturally.
 */
const ONBOARDING_COACH_GREETING = "So. What's your main focus this quarter? The thing that, if it went well, would make the next few months feel worthwhile.";

const ONBOARDING_DISCOVERY_PROMPT = `
[ONBOARDING DISCOVERY - COMBINED DATA CRAWL]

IMPORTANT: Mindstone is the company that builds Rebel. Do NOT assume the user works at Mindstone unless explicitly discovered. If company is unknown, avoid company-specific assumptions when generating use cases or inbox items.

Run the skill at @\`rebel-system/skills/system/onboarding-discovery/SKILL.md\`

This is running during onboarding. The skill will:
1. Crawl Gmail, Calendar, and Slack data ONCE
2. Generate memory files for Chief-of-Staff space
3. Discover and save 3 high-value use cases
4. Seed the inbox with 5-12 actionable items across a mix of priorities
5. Extract and save user identity (name/email)

Run completely non-interactively - no questions, no confirmations needed.
`;

// ─── Component ──────────────────────────────────────────────────────────────
const OnboardingCoachOrchestratorInner = forwardRef<
  OnboardingCoachOrchestratorRef,
  OnboardingCoachOrchestratorProps
>(function OnboardingCoachOrchestrator(
  {
    shouldRenderMainApp,
    showOnboardingWizard,
    onboardingDay,
    onboardingCompletedAt,
    launchRequestId,
    isOnboardingCoachActive,
    resetSessionState,
    handleUserMessageRef,
    saveSettingsWith,
    emitLog,
    persistedCoachSessionId,
    persistedDiscoverySessionId,
    setIsOnboardingCoachActive,
    setShowOnboardingManualContinue,
    setActiveSurface,
    setShowConversation,
  },
  ref,
) {
  // ─── Internal state (only consumed by orchestration logic) ──────────────

  // Track session IDs for the two parallel onboarding conversations
  const [onboardingSessionIds, setOnboardingSessionIds] = useState<{
    coach: string | null;
    discovery: string | null;
  }>({ coach: null, discovery: null });

  // Track when coach has signaled completion (prevents re-triggering)
  const [onboardingCoachComplete, setOnboardingCoachComplete] = useState(false);

  // ─── Refs ─────────────────────────────────────────────────────────────────

  // Track when onboarding coach started (for timeout fallback)
  const onboardingCoachStartedAtRef = useRef<number | null>(null);
  // Track whether coach conversation has been started (prevents duplicate starts)
  const onboardingCoachStartedRef = useRef(false);
  // Track if onboarding conversations have been initiated (prevents duplicate calls)
  const onboardingConversationsInitiatedRef = useRef(false);
  // Track whether discovery conversation has been started (prevents double-start)
  // Declared here (before reset effect) so it can be reset when wizard reopens
  const discoveryStartedRef = useRef(false);
  // Timer ref for deferred discovery start — survives effect re-runs
  const discoveryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastHandledLaunchRequestRef = useRef<number | undefined>(undefined);

  // ─── Unmount cleanup ────────────────────────────────────────────────────
  // Ensure coach mode is always deactivated when the orchestrator unmounts.
  // This prevents the UI from getting permanently stuck in dimmed state if
  // the component unmounts before handleCoachComplete finishes (e.g., settings
  // sync sets onboardingCompletedAt, or a re-render unmounts the component).
  useEffect(() => {
    return () => {
      setIsOnboardingCoachActive(false);
      setShowOnboardingManualContinue(false);
    };
  }, [setIsOnboardingCoachActive, setShowOnboardingManualContinue]);

  // ─── Resume effect ──────────────────────────────────────────────────────
  // When coach mode is re-activated after a restart (via "Continue your intro"
  // on the homepage), the local session ID is null. Initialize it from the
  // persisted settings so completion detection and system prompt injection work.
  useEffect(() => {
    if (isOnboardingCoachActive && !onboardingSessionIds.coach && persistedCoachSessionId) {
      emitLog({ level: 'info', message: 'Onboarding: Resuming coach — initializing session ID from persisted settings', context: { persistedCoachSessionId }, timestamp: Date.now() });
      setOnboardingSessionIds(prev => ({ ...prev, coach: persistedCoachSessionId }));
      onboardingCoachStartedRef.current = true;
      onboardingCoachStartedAtRef.current = Date.now();
    }
  }, [isOnboardingCoachActive, onboardingSessionIds.coach, persistedCoachSessionId, emitLog]);

  // If Home detects a stale/deleted coach session and clears the persisted ID,
  // allow a fresh explicit launch in the same app run.
  useEffect(() => {
    if (persistedCoachSessionId || isOnboardingCoachActive) return;
    if (!onboardingSessionIds.coach && !onboardingCoachStartedRef.current) return;

    setOnboardingSessionIds(prev => ({ ...prev, coach: null }));
    onboardingCoachStartedRef.current = false;
    onboardingCoachStartedAtRef.current = null;
  }, [persistedCoachSessionId, isOnboardingCoachActive, onboardingSessionIds.coach]);

  // ─── Reset effect ─────────────────────────────────────────────────────────

  // Reset all onboarding state when wizard reopens
  useEffect(() => {
    if (showOnboardingWizard) {
      onboardingConversationsInitiatedRef.current = false;
      onboardingCoachStartedRef.current = false;
      onboardingCoachStartedAtRef.current = null;
      discoveryStartedRef.current = false;
      if (discoveryTimerRef.current) { clearTimeout(discoveryTimerRef.current); discoveryTimerRef.current = null; }
      setIsOnboardingCoachActive(false);
      setOnboardingSessionIds({ coach: null, discovery: null });
      setOnboardingCoachComplete(false);
      setShowOnboardingManualContinue(false);
    }
  }, [showOnboardingWizard, setIsOnboardingCoachActive, setShowOnboardingManualContinue]);

  // ─── Callbacks ────────────────────────────────────────────────────────────

  // Start discovery conversation (deferred from coach start)
  // This is called 3 seconds after coach starts to eliminate resource contention
  const startDiscoveryConversation = useCallback(() => {
    if (discoveryStartedRef.current) return;

    // Persistent guard: if discovery already ran in a previous session, don't re-run.
    // This prevents duplicate inbox seeding when onboarding is re-entered (e.g. testing).
    // The ref guard only survives within a single mount cycle; this survives across sessions.
    if (persistedDiscoverySessionId) {
      discoveryStartedRef.current = true;
      emitLog({ level: 'info', message: 'Onboarding: Discovery already ran in a previous session, skipping', context: { persistedDiscoverySessionId }, timestamp: Date.now() });
      return;
    }

    discoveryStartedRef.current = true;

    emitLog({ level: 'info', message: 'Onboarding: Starting discovery conversation (deferred)', timestamp: Date.now() });

    // COMBINED DISCOVERY (background fire-and-forget)
    // Single conversation that handles: memory population, use case discovery, inbox seeding, user identity
    // Use createBackgroundSession to avoid hijacking the coach session's currentSessionId
    const discoverySessionId = createId();
    getSessionStoreState().createBackgroundSession(discoverySessionId, 'automation');
    fireAndForget(handleUserMessageRef.current?.(ONBOARDING_DISCOVERY_PROMPT, 'text', undefined, { targetSessionId: discoverySessionId, sessionType: 'automation', bypassToolSafety: true }), 'onboardingDiscovery');

    setOnboardingSessionIds(prev => ({ ...prev, discovery: discoverySessionId }));

    // Persist immediately so the guard survives app restarts / re-entries
    void saveSettingsWith((draft) => ({
      ...draft,
      onboardingSessionIds: {
        coach: draft.onboardingSessionIds?.coach ?? null,
        memory: draft.onboardingSessionIds?.memory ?? null,
        useCases: draft.onboardingSessionIds?.useCases ?? null,
        ...draft.onboardingSessionIds,
        discovery: discoverySessionId,
      },
    }));

    emitLog({ level: 'info', message: 'Onboarding: Discovery conversation started', context: { discoverySessionId }, timestamp: Date.now() });
  }, [handleUserMessageRef, emitLog, persistedDiscoverySessionId, saveSettingsWith]);

  // Mark final setup step entered. The coach is no longer auto-launched from
  // setup completion; Home owns the explicit activation CTA.
  const handleFinalSetupStepEntered = useCallback(() => {
    if (onboardingConversationsInitiatedRef.current) {
      emitLog({ level: 'debug', message: 'Onboarding: handleFinalSetupStepEntered called but already initiated', timestamp: Date.now() });
      return;
    }
    onboardingConversationsInitiatedRef.current = true;
    emitLog({ level: 'info', message: 'Onboarding: Final setup step entered; coach waits for explicit Home activation', timestamp: Date.now() });
  }, [emitLog]);

  // Handle coach deferred — user skipped the coaching conversation.
  // Immediate cleanup — CSS un-dim transition handles the visual.
  // Does NOT set onboardingCompletedAt so the homepage "Continue your intro" card appears.
  const handleCoachDeferred = useCallback(() => {
    if (onboardingCoachComplete) return;

    const coachDurationMs = onboardingCoachStartedAtRef.current
      ? Date.now() - onboardingCoachStartedAtRef.current
      : 0;
    tracking.onboarding.stageAbandoned('coach', coachDurationMs / 1000);

    setShowOnboardingManualContinue(false);
    setSuppressNotifications(false);
    setIsOnboardingCoachActive(false); // triggers CSS un-dim transition
    setActiveSurface('home');
    if (discoveryTimerRef.current) {
      clearTimeout(discoveryTimerRef.current);
      discoveryTimerRef.current = null;
    }

    emitLog({ level: 'info', message: 'Onboarding: Coach deferred by user (skip), navigated to homepage', timestamp: Date.now() });

    void saveSettingsWith((draft) => ({
      ...draft,
      onboardingSessionIds: {
        coach: onboardingSessionIds.coach ?? draft.onboardingSessionIds?.coach ?? null,
        memory: draft.onboardingSessionIds?.memory ?? null,
        useCases: draft.onboardingSessionIds?.useCases ?? null,
        discovery: onboardingSessionIds.discovery ?? draft.onboardingSessionIds?.discovery ?? null,
      },
    }));

    window.dispatchEvent(new CustomEvent('onboarding-coach-deferred'));
  }, [onboardingCoachComplete, onboardingSessionIds, saveSettingsWith, emitLog, setActiveSurface, setIsOnboardingCoachActive, setShowOnboardingManualContinue]);

  // Handle coach completion — immediate cleanup, CSS un-dim handles the visual transition.
  const handleCoachComplete = useCallback(() => {
    if (onboardingCoachComplete) return;
    if (!isOnboardingCoachActive) return;
    setOnboardingCoachComplete(true);

    const coachDurationMs = onboardingCoachStartedAtRef.current
      ? Date.now() - onboardingCoachStartedAtRef.current
      : 0;
    tracking.onboarding.stageCompleted('coach', coachDurationMs / 1000);

    // Immediate cleanup — CSS opacity transition handles the un-dim
    setShowOnboardingManualContinue(false);
    setSuppressNotifications(false);
    setIsOnboardingCoachActive(false); // triggers CSS un-dim transition
    setActiveSurface('home');

    emitLog({ level: 'info', message: 'Onboarding: Coach completed, navigating to homepage', timestamp: Date.now() });

    const setupPromises = [
      saveSettingsWith((draft) => {
        const currentChecklist = draft.onboardingChecklist;
        const newCompletedSteps = {
          ...currentChecklist?.completedSteps,
          0: true
        };
        const allDone = TUTORIAL_STEPS.every(s => newCompletedSteps[s.id]);

        return {
          ...draft,
          onboardingDay: 1,
          onboardingCompletedAt: Date.now(),
          onboardingSessionIds: {
            coach: onboardingSessionIds.coach,
            memory: draft.onboardingSessionIds?.memory ?? null,
            useCases: draft.onboardingSessionIds?.useCases ?? null,
          },
          onboardingChecklist: {
            ...currentChecklist,
            step: (allDone ? 'complete' : currentChecklist?.step ?? 1) as OnboardingChecklistStep,
            completedSteps: newCompletedSteps,
            sessionIds: {
              ...currentChecklist?.sessionIds,
              0: onboardingSessionIds.coach ?? undefined
            }
          }
        } as AppSettings;
      }),
      window.dashboardApi.ensureGoalsInFrontmatter().then((result) => {
        if (result.action === 'extracted_from_body') {
          emitLog({ level: 'info', message: 'Onboarding: Extracted goals from README body to frontmatter', context: { goalCount: result.goalCount }, timestamp: Date.now() });
        } else if (result.action === 'error') {
          emitLog({ level: 'warn', message: 'Onboarding: Failed to ensure goals in frontmatter', context: { error: result.error }, timestamp: Date.now() });
        }
      }).catch(() => {})
    ];

    const dispatchCompletionEvents = () => {
      window.dispatchEvent(new CustomEvent('onboarding-coach-complete'));
      void window.api.startOnboardingJourney?.();
    };

    Promise.all(setupPromises).then(dispatchCompletionEvents).catch(dispatchCompletionEvents);
  }, [onboardingCoachComplete, isOnboardingCoachActive, onboardingSessionIds, saveSettingsWith, emitLog, setActiveSurface, setIsOnboardingCoachActive, setShowOnboardingManualContinue]);

  const startCoachConversation = useCallback(() => {
    if (!shouldRenderMainApp || showOnboardingWizard || onboardingCoachStartedRef.current || onboardingCoachComplete) {
      return;
    }

    // Don't start coach if already completed onboarding previously
    if (onboardingCompletedAt || (onboardingDay && onboardingDay >= 1)) {
      return;
    }

    // No need to wait for handleUserMessageRef here -- we inject the greeting
    // directly into the session store (no agent turn). The ref is only needed
    // when the user sends their first real message (handled by App.tsx).
    onboardingCoachStartedRef.current = true;
    tracking.onboarding.stageEntered('coach');
    emitLog({ level: 'info', message: 'Onboarding: Starting coach conversation (main app now visible)', timestamp: Date.now() });

    const coachSessionId = resetSessionState();
    setSuppressNotifications(true);
    setActiveSurface('sessions');
    setShowConversation(true);
    setIsOnboardingCoachActive(true);

    // Pre-seed the coach greeting directly into the session store.
    // This appears instantly (no agent turn needed). The coaching prompt is
    // injected into the system prompt via sessionType: 'onboarding-coach'
    // (see mcpService.ts), so when the user replies, the agent has full
    // coaching context and continues from the greeting naturally.
    //
    // Reusable pattern: any conversation can pre-seed an assistant greeting by
    // calling processEvent with a synthetic turnId before the first real turn.
    const greetingTurnId = `pre-seeded-greeting-${coachSessionId}`;
    const store = getSessionStoreState();
    store.processEvent(greetingTurnId, {
      type: 'result',
      text: ONBOARDING_COACH_GREETING,
      timestamp: Date.now(),
    });

    setOnboardingSessionIds(prev => ({ ...prev, coach: coachSessionId }));
    void saveSettingsWith((draft) => ({
      ...draft,
      onboardingSessionIds: {
        coach: coachSessionId,
        memory: draft.onboardingSessionIds?.memory ?? null,
        useCases: draft.onboardingSessionIds?.useCases ?? null,
      },
      onboardingChecklist: {
        ...draft.onboardingChecklist,
        step: draft.onboardingChecklist?.step ?? 1,
        sessionIds: {
          ...draft.onboardingChecklist?.sessionIds,
          0: coachSessionId
        }
      }
    }));
    onboardingCoachStartedAtRef.current = Date.now();
    emitLog({ level: 'info', message: 'Onboarding: Coach conversation started', context: { coachSessionId }, timestamp: Date.now() });

    discoveryTimerRef.current = setTimeout(() => {
      discoveryTimerRef.current = null;
      startDiscoveryConversation();
    }, 3000);
  }, [shouldRenderMainApp, showOnboardingWizard, onboardingCoachComplete, onboardingDay, onboardingCompletedAt, resetSessionState, emitLog, startDiscoveryConversation, setActiveSurface, setShowConversation, setIsOnboardingCoachActive, saveSettingsWith]);

  // ─── Effects ──────────────────────────────────────────────────────────────

  // Start coach conversation only after an explicit Home activation request.
  useEffect(() => {
    if (launchRequestId == null || lastHandledLaunchRequestRef.current === launchRequestId) {
      return;
    }
    lastHandledLaunchRequestRef.current = launchRequestId;
    onboardingCoachStartedRef.current = false;
    onboardingCoachStartedAtRef.current = null;
    setOnboardingSessionIds(prev => ({ ...prev, coach: null }));
    startCoachConversation();
  }, [launchRequestId, startCoachConversation]);

  // If the user deferred quickly, the discovery timer was cancelled. Resuming an
  // existing coach session should still start discovery once unless it already ran.
  useEffect(() => {
    if (!isOnboardingCoachActive) return;
    if (!persistedCoachSessionId || onboardingSessionIds.coach !== persistedCoachSessionId) return;
    if (persistedDiscoverySessionId || discoveryStartedRef.current || discoveryTimerRef.current) return;

    discoveryTimerRef.current = setTimeout(() => {
      discoveryTimerRef.current = null;
      startDiscoveryConversation();
    }, 3000);
  }, [
    isOnboardingCoachActive,
    onboardingSessionIds.coach,
    persistedCoachSessionId,
    persistedDiscoverySessionId,
    startDiscoveryConversation,
  ]);

  // Suppress toasts/notifications during onboarding coach to keep parallel work a surprise
  useEffect(() => {
    setSuppressNotifications(isOnboardingCoachActive);
    // Cleanup: ensure notifications re-enabled if component unmounts during onboarding
    return () => setSuppressNotifications(false);
  }, [isOnboardingCoachActive]);

  // Completion detection: Watch for [ONBOARDING_COACH_COMPLETE] marker in coach conversation
  // Layer 1: Auto-complete when marker found + session not busy
  // Layer 2: Show manual continue button when session idle without marker (after substantial conversation)
  useEffect(() => {
    // Only run if coach is active and not already complete
    if (!isOnboardingCoachActive || onboardingCoachComplete || !onboardingSessionIds.coach) return;

    const evaluateCoachSession = (state: ReturnType<typeof getSessionStoreState>) => {
      // Use summary for busy state
      const summary = state.sessionSummaries.find(s => s.id === onboardingSessionIds.coach);
      if (!summary) return;

      // Must wait for turn to finish (not busy) to avoid partial message false positives
      if (summary.isBusy) {
        // Hide manual continue while agent is working
        setShowOnboardingManualContinue(false);
        return;
      }

      // Get coach messages from loadedSessions (works even if currentSessionId changed)
      // This handles the case where discovery starts and switches currentSessionId away from coach
      const coachSession = onboardingSessionIds.coach ? state.loadedSessions.get(onboardingSessionIds.coach) : undefined;
      const coachMessages = coachSession?.messages ?? 
        (state.currentSessionId === onboardingSessionIds.coach ? state.messages : []);

      // Layer 1a: Check for deferred marker (user skipped — exit coach without completing)
      const hasDeferredMarker = coachMessages.some(
        m => (m.role === 'assistant' || m.role === 'result') && m.text?.includes('[ONBOARDING_COACH_DEFERRED]')
      );

      if (hasDeferredMarker) {
        setShowOnboardingManualContinue(false);
        handleCoachDeferred();
        return;
      }

      // Layer 1b: Check for completion marker (coaching finished successfully)
      const hasCompletionMarker = coachMessages.some(
        m => (m.role === 'assistant' || m.role === 'result') && m.text?.includes('[ONBOARDING_COACH_COMPLETE]')
      );

      if (hasCompletionMarker) {
        setShowOnboardingManualContinue(false);
        handleCoachComplete();
        return;
      }

      // Layer 2: Show manual continue if session is idle (not busy) without marker
      // Only show after substantial conversation (at least 4 assistant/result messages / turns)
      const assistantMessageCount = coachMessages.filter(m => m.role === 'assistant' || m.role === 'result').length;
      if (assistantMessageCount >= 4) {
        setShowOnboardingManualContinue(true);
      } else {
        setShowOnboardingManualContinue(false);
      }
    };

    evaluateCoachSession(getSessionStoreState());
    const unsubscribe = subscribeToSessionStore(evaluateCoachSession);

    return unsubscribe;
  }, [isOnboardingCoachActive, onboardingCoachComplete, onboardingSessionIds.coach, handleCoachComplete, handleCoachDeferred, setShowOnboardingManualContinue]);

  // Timeout fallback (Layer 3): If coach runs for >20 minutes without completion, force show manual continue
  useEffect(() => {
    if (!isOnboardingCoachActive || onboardingCoachComplete || !onboardingCoachStartedAtRef.current) return;

    const TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
    const elapsed = Date.now() - onboardingCoachStartedAtRef.current;
    const remaining = TIMEOUT_MS - elapsed;

    if (remaining <= 0) {
      // Already past timeout - force show manual continue button
      setShowOnboardingManualContinue(true);
      emitLog({ level: 'warn', message: 'Onboarding: Coach timeout already exceeded, showing manual continue', timestamp: Date.now() });
      return;
    }

    const timeoutId = setTimeout(() => {
      emitLog({ level: 'warn', message: 'Onboarding: Coach timeout reached (10 min), forcing manual continue button', timestamp: Date.now() });
      setShowOnboardingManualContinue(true);
    }, remaining);

    return () => clearTimeout(timeoutId);
  }, [isOnboardingCoachActive, onboardingCoachComplete, emitLog, setShowOnboardingManualContinue]);

  // ─── Escape hatch hotkey (Cmd/Ctrl+Shift+Alt+E) ────────────────────────
  // Allows the user to skip the coach conversation at any time.
  useEscapeHatchHotkey({
    isActive: isOnboardingCoachActive && !onboardingCoachComplete,
    onTrigger: handleCoachDeferred,
  });

  // ─── Imperative handle ────────────────────────────────────────────────────

  useImperativeHandle(ref, () => ({
    handleCoachComplete,
    handleCoachDeferred,
    handleFinalSetupStepEntered,
  }));

  return null;
});

export const OnboardingCoachOrchestrator = memo(OnboardingCoachOrchestratorInner);
