/**
 * SafeModeOrchestrator
 *
 * Owns safe mode effects, refs, handlers, error recovery, and related JSX.
 * Extracted from App.tsx to remove 4 useState, 2 refs, 5 useEffect, 2 useCallback,
 * and safe-mode JSX from the main render path. Safe mode is a rare error-recovery
 * path, so these hooks execute for nothing 99.9% of the time.
 *
 * `safeModeContext` state remains in App.tsx because it's consumed by ~15 other
 * places (workspace recovery guard, E2E readiness, startup timeout, etc.).
 *
 * Emergency recovery (showEmergencyRecovery) also remains in App.tsx because it
 * controls the pre-settings early return path which must render before any providers.
 *
 * State communicated back to App.tsx:
 * - `setSafeModeContext` callback to update safe mode state from IPC listeners
 * - `handleSafeModeTroubleshootingTips` via useImperativeHandle (consumed by SafeModeIndicator JSX)
 */

import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { SafeModeContext, SafeModeErrorCategory } from '@shared/types';
import type { EmitLogFn } from '@renderer/contexts';
import type { FlowSurface } from '@renderer/features/flow-panels/FlowPanelsProvider';
import { getSessionStoreState } from '@renderer/features/agent-session/store';
import { useErrorRecovery } from '@renderer/hooks/useErrorRecovery';
import { useIpcEvent } from '@renderer/hooks/useIpcEvent';
import { SafeModeIndicator } from '@renderer/components/SafeModeIndicator';
import { ErrorRecoveryCard } from '@renderer/components/ErrorRecoveryCard';
import { StartupRecoveryDialog } from '@renderer/components/StartupRecoveryDialog';
import { getSafeModeCategoryPromptGuidance } from '../safeModeCategoryGuidance';

// ─── Public ref handle ──────────────────────────────────────────────────────
export interface SafeModeOrchestratorRef {
  handleSafeModeTroubleshootingTips: () => void;
}

/**
 * Whether to record the test-mode `superMcpStartupFailed` readiness signal on a Super-MCP
 * startup failure. Mirrors EXACTLY the condition under which the real-user recovery dialog
 * would show (onboarding complete + not already in safe mode) — but only in E2E mode,
 * where that dialog is suppressed and the packaged boot-smoke needs the signal instead.
 * Pure + exported so the producer condition is locked by a unit test (the boot-smoke's
 * classifier is separately tested, but this guards the signal SOURCE from silent drift).
 */
export function shouldRecordTestModeSuperMcpFailure(
  isE2EMode: boolean,
  onboardingCompleted: boolean | undefined,
  safeModeEnabled: boolean,
): boolean {
  return isE2EMode && Boolean(onboardingCompleted) && !safeModeEnabled;
}

// ─── Props ──────────────────────────────────────────────────────────────────
export interface SafeModeOrchestratorProps {
  // Safe mode context — owned by App.tsx, read here for rendering/effects
  safeModeContext: SafeModeContext;
  setSafeModeContext: (ctx: SafeModeContext) => void;

  // Settings state needed for startup guards
  settings: { onboardingCompleted?: boolean } | null;

  // MCP router running state
  mcpRouterIsRunning: boolean;

  // Callbacks for opening troubleshooting/fix conversations
  resetSessionState: () => string;
  setActiveSurface: (s: FlowSurface) => void;
  setShowConversation: (b: boolean) => void;
  setIsTextMode: (b: boolean) => void;
  setFlowHistoryOpen: (b: boolean) => void;

  emitLog: EmitLogFn;
}

// ─── Component ──────────────────────────────────────────────────────────────
const SafeModeOrchestratorInner = forwardRef<SafeModeOrchestratorRef, SafeModeOrchestratorProps>(
  function SafeModeOrchestrator(
    {
      safeModeContext,
      setSafeModeContext,
      settings,
      mcpRouterIsRunning,
      resetSessionState,
      setActiveSurface,
      setShowConversation,
      setIsTextMode,
      setFlowHistoryOpen,
      emitLog,
    },
    ref,
  ) {
    // ─── Startup Recovery Dialog state ──────────────────────────────────
    const [showStartupRecoveryDialog, setShowStartupRecoveryDialog] = useState(false);
    const [startupRecoveryVariant, setStartupRecoveryVariant] = useState<'timeout' | 'failed'>('timeout');
    const [startupFailureContext, setStartupFailureContext] = useState<{
      errorCategory?: SafeModeErrorCategory;
      sentryEventId?: string;
    } | null>(null);

    // ─── Refs ─────────────────────────────────────────────────────────────
    const safeModeAutoOpenedRef = useRef(false);
    const startupTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const recoveryDialogDismissedRef = useRef(false);

    // ─── Safe Mode State Management ─────────────────────────────────────
    // Fetch initial safe mode state on mount
    useEffect(() => {
      window.appApi
        .safeModeState()
        .then((ctx) => {
          setSafeModeContext(ctx);
          if (ctx.isEnabled) {
            emitLog({ level: 'info', message: 'App is running in Safe Mode', context: { reason: ctx.reason }, timestamp: Date.now() });
          }
        })
        .catch((err) => {
          console.error('Failed to fetch safe mode state:', err);
        });
    }, [emitLog, setSafeModeContext]);

    // Listen for safe mode state changes
    useIpcEvent(window.api.onSafeModeStateChange, (ctx) => {
      setSafeModeContext(ctx);
      emitLog({
        level: 'info',
        message: `Safe mode state changed: ${ctx.isEnabled ? 'enabled' : 'disabled'}`,
        timestamp: Date.now(),
      });
    }, [emitLog, setSafeModeContext]);

    // Show startup recovery dialog on Super-MCP failure (unless in onboarding, safe mode, or E2E)
    useIpcEvent(window.api.onSuperMcpStartupFailed, (data) => {
      const isE2EMode = Boolean(window.e2eApi?.isEnabled);
      console.warn('[App] onSuperMcpStartupFailed: isE2EMode =', isE2EMode, ', e2eApi =', typeof window.e2eApi);
      // In e2e mode the recovery dialog below is suppressed for determinism. Record the
      // suppressed failure on the readiness bridge so the packaged boot-smoke can treat
      // it as a degraded boot (it otherwise can't observe startupRecoveryDialogVisible,
      // which stays false under e2e). Guarded on isE2EMode → inert for real users.
      if (shouldRecordTestModeSuperMcpFailure(isE2EMode, settings?.onboardingCompleted, safeModeContext.isEnabled)) {
        window.e2eApi?.setReadiness?.({ superMcpStartupFailed: true });
      }
      if (settings?.onboardingCompleted && !safeModeContext.isEnabled && !isE2EMode) {
        emitLog({
          level: 'warn',
          message: 'Super-MCP startup failed, showing recovery dialog',
          context: { failureCategory: data.failureCategory, attempts: data.attempts },
          timestamp: Date.now(),
        });
        setStartupFailureContext({
          errorCategory: data.failureCategory,
        });
        setStartupRecoveryVariant('failed');
        setShowStartupRecoveryDialog(true);
      }
    }, [settings?.onboardingCompleted, safeModeContext.isEnabled, emitLog]);

    // ─── Startup timeout ────────────────────────────────────────────────
    useEffect(() => {
      if (startupTimeoutRef.current) {
        clearTimeout(startupTimeoutRef.current);
        startupTimeoutRef.current = null;
      }

      const isE2EMode = Boolean(window.e2eApi?.isEnabled);
      console.warn('[App] Startup timeout effect: isE2EMode =', isE2EMode, ', e2eApi =', typeof window.e2eApi);
      const routerIsRunning = mcpRouterIsRunning;
      if (
        isE2EMode ||
        safeModeContext.isEnabled ||
        !settings?.onboardingCompleted ||
        routerIsRunning ||
        showStartupRecoveryDialog ||
        recoveryDialogDismissedRef.current
      ) {
        return;
      }

      const startupRecoveryTimeoutMs = 30_000;
      startupTimeoutRef.current = setTimeout(async () => {
        if (
          !safeModeContext.isEnabled &&
          settings?.onboardingCompleted &&
          !showStartupRecoveryDialog &&
          !recoveryDialogDismissedRef.current
        ) {
          try {
            const freshSummary = await window.settingsApi.mcpSummary({ skipMetadata: true });
            if (freshSummary?.router?.isRunning) {
              emitLog({
                level: 'info',
                message: 'Super-MCP startup timeout fired but IPC confirms router is running - skipping recovery dialog',
                timestamp: Date.now(),
              });
              return;
            }
          } catch (e) {
            emitLog({
              level: 'warn',
              message: `Super-MCP startup timeout - IPC check failed: ${e}`,
              timestamp: Date.now(),
            });
          }

          emitLog({
            level: 'warn',
            message: 'Super-MCP startup timeout - showing recovery dialog',
            timestamp: Date.now(),
          });
          setStartupRecoveryVariant('timeout');
          setShowStartupRecoveryDialog(true);
        }
      }, startupRecoveryTimeoutMs);

      return () => {
        if (startupTimeoutRef.current) {
          clearTimeout(startupTimeoutRef.current);
          startupTimeoutRef.current = null;
        }
      };
    }, [safeModeContext.isEnabled, settings?.onboardingCompleted, mcpRouterIsRunning, showStartupRecoveryDialog, emitLog]);

    // Clear startup timeout when router starts successfully
    useEffect(() => {
      if (mcpRouterIsRunning && startupTimeoutRef.current) {
        clearTimeout(startupTimeoutRef.current);
        startupTimeoutRef.current = null;
        if (showStartupRecoveryDialog && startupRecoveryVariant === 'timeout') {
          setShowStartupRecoveryDialog(false);
        }
      }
    }, [mcpRouterIsRunning, showStartupRecoveryDialog, startupRecoveryVariant]);

    // ─── Error Recovery ─────────────────────────────────────────────────
    const handleStartErrorFixConversation = useCallback(
      (prompt: string, _errorCategory: SafeModeErrorCategory) => {
        const sessionId = resetSessionState();
        setShowConversation(true);
        setIsTextMode(true);
        setFlowHistoryOpen(true);
        setActiveSurface('sessions');
        getSessionStoreState().setDraftForSession(sessionId, prompt);
        emitLog({
          level: 'info',
          message: 'Starting error fix conversation from evaluation',
          timestamp: Date.now(),
        });
      },
      [resetSessionState, setShowConversation, setIsTextMode, setFlowHistoryOpen, setActiveSurface, emitLog],
    );

    const {
      state: errorRecoveryState,
      evaluate: evaluateError,
      dismiss: dismissErrorRecovery,
      handleLetRebelFix,
      handleAskAnyway,
    } = useErrorRecovery({
      onStartFixConversation: handleStartErrorFixConversation,
    });

    // Trigger error evaluation when Safe Mode is enabled with an error category
    useEffect(() => {
      if (
        safeModeContext.isEnabled &&
        safeModeContext.errorCategory &&
        safeModeContext.errorCategory !== 'unknown' &&
        errorRecoveryState.status === 'idle'
      ) {
        emitLog({
          level: 'info',
          message: 'Safe Mode enabled with error category, starting error evaluation',
          context: { errorCategory: safeModeContext.errorCategory },
          timestamp: Date.now(),
        });
        evaluateError(safeModeContext.errorCategory, undefined, {
          reason: safeModeContext.reason,
          sentryEventId: safeModeContext.sentryEventId,
        });
      }
    }, [safeModeContext.isEnabled, safeModeContext.errorCategory, safeModeContext.reason, safeModeContext.sentryEventId, errorRecoveryState.status, evaluateError, emitLog]);

    // ─── Troubleshooting Tips Handler ───────────────────────────────────
    const handleSafeModeTroubleshootingTips = useCallback(() => {
      const reasonText = (() => {
        switch (safeModeContext.reason) {
          case 'timeout':
            return 'a startup timeout';
          case 'failure':
            return 'tools failing to load';
          case 'cli':
            return 'the --safe-mode command line flag';
          case 'user':
            return 'user request';
          default:
            return 'an unknown issue';
        }
      })();

      const guidance = getSafeModeCategoryPromptGuidance(safeModeContext.errorCategory);

      let prompt = `I'm in Safe Mode because of ${reasonText}.`;
      if (safeModeContext.errorCategory && safeModeContext.errorCategory !== 'unknown') {
        prompt += ` Error category: ${safeModeContext.errorCategory.replace(/_/g, ' ')}.`;
      }

      prompt += `\n\n${guidance}`;

      prompt += `\n\nPlease help me diagnose what went wrong. I'd like:
1. A summary of what might be causing this
2. Steps I can try to fix it (starting with the most likely)
3. Information to share with support if needed

Don't make any changes without my explicit approval.`;

      if (safeModeContext.sentryEventId) {
        prompt += `\n\n(Sentry Event ID for support: ${safeModeContext.sentryEventId})`;
      }

      const sessionId = resetSessionState();
      setShowConversation(true);
      setIsTextMode(true);
      setFlowHistoryOpen(true);
      setActiveSurface('sessions');
      getSessionStoreState().setDraftForSession(sessionId, prompt);
    }, [resetSessionState, safeModeContext, setActiveSurface, setFlowHistoryOpen, setIsTextMode, setShowConversation]);

    // Auto-open troubleshooting conversation when entering Safe Mode due to failure/timeout
    useEffect(() => {
      const shouldAutoOpen =
        safeModeContext.isEnabled &&
        (safeModeContext.reason === 'failure' || safeModeContext.reason === 'timeout') &&
        !safeModeAutoOpenedRef.current;

      let timerId: ReturnType<typeof setTimeout> | null = null;

      if (shouldAutoOpen) {
        safeModeAutoOpenedRef.current = true;
        emitLog({
          level: 'info',
          message: 'Auto-opening troubleshooting conversation for Safe Mode',
          context: { reason: safeModeContext.reason },
          timestamp: Date.now(),
        });
        timerId = setTimeout(() => {
          handleSafeModeTroubleshootingTips();
        }, 100);
      }

      if (!safeModeContext.isEnabled) {
        safeModeAutoOpenedRef.current = false;
      }

      return () => {
        if (timerId) clearTimeout(timerId);
      };
    }, [safeModeContext.isEnabled, safeModeContext.reason, handleSafeModeTroubleshootingTips, emitLog]);

    // ─── Expose troubleshooting handler via ref ─────────────────────────
    useImperativeHandle(
      ref,
      () => ({
        handleSafeModeTroubleshootingTips,
      }),
      [handleSafeModeTroubleshootingTips],
    );

    // ─── Render ─────────────────────────────────────────────────────────
    return (
      <>
        <SafeModeIndicator
          context={safeModeContext}
          onGetTroubleshootingTips={handleSafeModeTroubleshootingTips}
        />
        {safeModeContext.isEnabled && errorRecoveryState.status !== 'idle' && (
          <ErrorRecoveryCard
            status={errorRecoveryState.status}
            evaluation={errorRecoveryState.evaluation}
            errorCategory={errorRecoveryState.errorCategory ?? safeModeContext.errorCategory ?? 'unknown'}
            startedAt={errorRecoveryState.startedAt}
            onLetRebelFix={handleLetRebelFix}
            onAskAnyway={handleAskAnyway}
            onDismiss={dismissErrorRecovery}
          />
        )}
        <StartupRecoveryDialog
          open={showStartupRecoveryDialog}
          onContinueWaiting={() => {
            recoveryDialogDismissedRef.current = true;
            setShowStartupRecoveryDialog(false);
            setStartupFailureContext(null);
          }}
          variant={startupRecoveryVariant}
          errorCategory={startupFailureContext?.errorCategory}
          sentryEventId={startupFailureContext?.sentryEventId}
        />
      </>
    );
  },
);

export const SafeModeOrchestrator = memo(SafeModeOrchestratorInner);
