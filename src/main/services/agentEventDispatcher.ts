/**
 * Agent Event Dispatcher — Desktop Decorator
 *
 * Wraps the core dispatcher with desktop-specific side effects:
 * dock badge and OS notifications on result events.
 *
 * Consumers in @main/ continue to import from this file.
 * Core logic (event delivery, accumulation, listeners, auto-title)
 * lives in @core/services/agentEventDispatcher.
 *
 * Automation notifications are owned by `automationScheduler` via
 * `showAutomationOutcomeNotification` (exported below), because the
 * scheduler is the only component that knows the final reconciled
 * status (including security denials, cancellation, tool failures).
 */

import {
  dispatchAgentErrorEvent as coreDispatchAgentErrorEvent,
  dispatchAgentEvent as coreDispatchAgentEvent,
} from '@core/services/agentEventDispatcher';
import type { EventWindow } from '@core/types';
import type { AgentEvent, AutomationRunStatus } from '@shared/types';
import type { ClassifyErrorUxInput } from '@rebel/shared';
import { createScopedLogger } from '@core/logger';
import { getCodexAuthProvider } from '@core/codexAuth';
import { agentTurnRegistry } from './agentTurnRegistry';
import { showUnreadDot } from './dockBadgeService';
import { getSettings } from '../settingsStore';
import { showDesktopNotification } from './desktopNotificationService';
import { getIncrementalSessionStore } from './incrementalSessionStore';
import { isDefaultOrFallbackTitle } from './conversationTitleService';
import { resolveModelSettings } from '@shared/utils/modelSettingsResolver';
import { normalizeApiKey, resolveProfileApiKey } from '@shared/utils/providerKeys';
import { isProfileSelectable, isLoopbackRoutableProfile } from '@shared/utils/profileHelpers';
import { fireAndForget } from '@shared/utils/fireAndForget';

const log = createScopedLogger({ service: 'agentEventDispatcher' });

export function buildAgentErrorSettingsContext(): ClassifyErrorUxInput['settingsContext'] | undefined {
  try {
    const settings = getSettings();
    const modelSettings = resolveModelSettings(settings);
    let hasCodexSubscription = false;
    try {
      hasCodexSubscription = getCodexAuthProvider().isConnected();
    } catch (err) {
      log.debug({ err }, 'Codex auth provider unavailable while building error settings context');
    }

    // Slim projection of profiles that can ACTUALLY serve a model, so classifyErrorUx
    // can offer "Use <profile>" recovery when one serves a model that can't run on the
    // active provider (e.g. a custom OpenAI-compatible gateway proxying claude-opus-4-8).
    // Credential-reachability gate (review F1): only offer a profile that is selectable,
    // has a model, AND is currently routeable — local/loopback (no key needed) or has a
    // resolvable per-profile/custom-provider API key. Erring toward under-offering keeps
    // the recovery from leading users into a second `missing-profile-credentials` terminal.
    const recoveryProfiles = (settings.localModel?.profiles ?? [])
      .filter(
        (profile) =>
          isProfileSelectable(profile) &&
          !!profile.model?.trim() &&
          (isLoopbackRoutableProfile(profile) ||
            !!resolveProfileApiKey(profile, settings.providerKeys, settings.customProviders)),
      )
      .map((profile) => ({ id: profile.id, name: profile.name, model: profile.model as string }));

    return {
      activeProvider: settings.activeProvider ?? 'anthropic',
      ...(typeof modelSettings.model === 'string' ? { currentModel: modelSettings.model } : {}),
      hasAnthropicCredentials: !!normalizeApiKey(modelSettings.apiKey),
      hasOpenRouterCredentials: !!(
        normalizeApiKey(settings.openRouter?.oauthToken) ??
        normalizeApiKey(settings.providerKeys?.openrouter)
      ),
      hasCodexSubscription,
      ...(recoveryProfiles.length > 0 ? { recoveryProfiles } : {}),
    };
  } catch (err) {
    log.debug({ err }, 'Failed to build error settings context');
    return undefined;
  }
}

/**
 * Desktop-decorated agent event dispatch.
 * Calls core dispatch first (event delivery, accumulation, listeners, auto-title),
 * then applies desktop-only side effects (dock badge, OS notification).
 *
 * Signature narrowed to exclude `type: 'error'` — the Stage 3 type-wall
 * cascades from the core dispatcher through this decorator unchanged so
 * error events MUST route through `dispatchAgentErrorEvent` end-to-end.
 * See docs/plans/260420_inline_error_dispatch_migration.md Stage 3.
 *
 * Also excludes the renderer-only lifecycle event types (currently
 * `answer_phase_started`); those MUST flow through the core dispatcher's
 * `dispatchRendererOnlyAgentEvent` helper to bypass listener/subscriber
 * fan-out and the main accumulator. See Stage 2 R2-3 / R2-4.
 */
export const dispatchAgentEvent = (
  win: EventWindow | null,
  turnId: string,
  event: Exclude<AgentEvent, { type: 'error' | 'answer_phase_started' }>,
): void => {
  // Core dispatch — event delivery, accumulation, listeners, auto-title
  coreDispatchAgentEvent(win, turnId, event);

  // Desktop-only: dock badge + OS notification when a turn finishes in the background
  if (event.type === 'result') {
    const sessionId = agentTurnRegistry.getRendererSession(turnId);
    const category = agentTurnRegistry.getTurnCategory(turnId);

    // Automation notifications are owned by automationScheduler (knows the final
    // reconciled status including security denials, cancellation, tool failures).
    // Dispatcher continues to handle conversation notifications.
    if (category === 'automation') return;

    const isUserFacing =
      category === 'conversation' || category === undefined;
    const isFocused = win && !win.isDestroyed() && 'isFocused' in win && typeof win.isFocused === 'function' && (win as { isFocused(): boolean }).isFocused();

    if (isUserFacing && !isFocused) {
      showUnreadDot();

      fireAndForget((async () => {
        try {
          const settings = getSettings();

          if (settings.notifications?.enabled !== true || !sessionId) return;

          const categoryEnabled = settings.notifications?.conversationComplete !== false;

          if (!categoryEnabled) return;

          let sessionTitle: string | undefined;
          try {
            const store = getIncrementalSessionStore();
            const session = await store.getSession(sessionId);
            if (session?.title && !isDefaultOrFallbackTitle(session.title, session.messages)) {
              sessionTitle = session.title;
            }
          } catch {
            // Best effort — use fallback title
          }

          showDesktopNotification({
            title: 'Rebel conversation finished',
            body: sessionTitle ?? 'Conversation finished',
            sessionId,
          });
        } catch (err) {
          log.debug({ err, turnId }, 'Failed to show desktop notification on turn complete');
        }
      })(), 'agentEventDispatcher.line104');
    }
  }
};

/**
 * Show a native OS notification for automation outcomes.
 *
 * Called by the automation scheduler AFTER final classification (security
 * reconciliation + all-tools-failed check). The scheduler is the single source
 * of truth for automation notifications; the main dispatch path above skips
 * automation-category result events so only one notification fires per run.
 *
 * Does NOT notify on `cancelled` (user initiated the stop — they already know).
 */
export async function showAutomationOutcomeNotification(params: {
  status: AutomationRunStatus;
  errorMessage: string | null;
  sessionId: string;
}): Promise<void> {
  const { status, errorMessage, sessionId } = params;

  if (status === 'cancelled' || status === 'pending' || status === 'running') return;
  if (!sessionId) return;

  try {
    const settings = getSettings();

    if (settings.notifications?.enabled !== true) return;
    if (settings.notifications?.automationComplete === false) return;

    showUnreadDot();

    let sessionTitle: string | undefined;
    try {
      const store = getIncrementalSessionStore();
      const session = await store.getSession(sessionId);
      if (session?.title && !isDefaultOrFallbackTitle(session.title, session.messages)) {
        sessionTitle = session.title;
      }
    } catch {
      // Best effort
    }

    let title: string;
    let body: string;
    if (status === 'failure') {
      title = 'Rebel automation needs attention';
      body = sessionTitle
        ? `${sessionTitle} — ${errorMessage ?? "couldn't complete"}`
        : errorMessage ?? "The automation couldn't complete its work.";
    } else if (status === 'blocked_by_security') {
      title = 'Rebel automation blocked';
      body = sessionTitle
        ? `${sessionTitle} — approval needed`
        : errorMessage ?? 'Approval needed to continue';
    } else {
      // success or completed_with_blocks
      title = 'Rebel automation complete';
      body = sessionTitle ?? 'Automation complete';
    }

    showDesktopNotification({ title, body, sessionId });
  } catch (err) {
    log.debug({ err, sessionId, status }, 'Failed to show automation outcome notification');
  }
}

// Re-export core exports so @main/ consumers don't need to change import paths.
// Error events are decorated with the current settings snapshot here so the
// platform-agnostic classifier can choose provider-aware recovery actions.
export const dispatchAgentErrorEvent = (
  win: EventWindow | null,
  turnId: string,
  rawError: Parameters<typeof coreDispatchAgentErrorEvent>[2],
  opts?: Parameters<typeof coreDispatchAgentErrorEvent>[3],
): ReturnType<typeof coreDispatchAgentErrorEvent> => coreDispatchAgentErrorEvent(
  win,
  turnId,
  rawError,
  {
    ...opts,
    settingsContext: opts?.settingsContext ?? buildAgentErrorSettingsContext(),
  },
);
export {
  sanitizeEventForMainAccumulation,
  sanitizeEventForRenderer,
  clearAnswerPhaseStartedSentinel,
} from '@core/services/agentEventDispatcher';
export {
  broadcastSequencedAgentEvent,
  sendSequencedAgentEventToWindow,
} from '@core/services/agentEventBroadcast';
