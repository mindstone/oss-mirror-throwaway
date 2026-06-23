/**
 * Turn Pipeline — Stage 2 admission phase.
 *
 * Takes the orchestrator's already-prepared inputs (turnId, win, prompt,
 * turnOptions, AbortController, rendererSessionId) and decides whether the
 * turn proceeds. Owns the admission terminal exits, effective reset decision,
 * session admission, provider override settings rebuild, Codex connectivity
 * snapshot, and prompt keyword stripping.
 */

import type { EventWindow } from '@core/types';
import type { TurnSessionLogger } from '@core/logger';
import type { ProviderRoutePlan } from '@core/rebelCore/providerRoutePlan';
import type { RouteRebuildHint } from '@core/rebelCore/providerRouteDecision';
import { classifySessionKind, shouldSkipCheckpointing } from '@shared/sessionKind';
import type { AnyAttachmentPayload, AppSettings, ThinkingEffort } from '@shared/types';
import type { ActiveProvider } from '@shared/types/settings';
import type { SessionType } from '@main/services/promptTemplateService';
import type {
  AdmittedTurn,
  MutableTrackingCounters,
  MutableWatchdogDiagnostics,
  TurnCompletionBaseContext,
  TurnPhaseResult,
} from '@main/services/turnPipeline/types';

import { getPlatformConfig } from '@core/platform';
import { getSettings } from '@core/services/settingsStore';
import { getCodexAuthProvider } from '@core/codexAuth';
import { getTurnCheckpointManager } from '@core/services/turnCheckpointService';
import { turnObservability } from '@core/services/turnObservability';
import { agentTurnRegistry } from '@main/services/agentTurnRegistry';
import { dispatchAgentErrorEvent, dispatchAgentEvent } from '@main/services/agentEventDispatcher';
import { makeSyntheticResult } from '@main/services/agentTurnCleanup';
import { mainTracking } from '@main/tracking';
import { getIncrementalSessionStore } from '@main/services/incrementalSessionStore';
import { credentialStateToErrorKind, validateProviderCredentials } from '@core/utils/validateProviderCredentials';
import { hasManagedOpenRouterKey } from '@main/services/openRouterTokenStorage';
import { cleanupSessionPendingApprovals } from '@main/services/toolSafetyService';
import { clearSchemaGateSession } from '@main/services/schemaGateHook';
import { stripDesignContextCommand } from '@main/services/designContextService';
import { stripOurComponentsCommand } from '@main/services/ourComponentsContextService';
import { getThinkingProfile, getWorkingProfile } from '@shared/utils/settingsUtils';
import { getApiKey, getCurrentModel, resolveModelSettings } from '@core/rebelCore/settingsAccessors';
import { getDefaultModelForProvider } from '@shared/utils/getDefaultModelForProvider';
import { normalizeFinishLine } from '@core/utils/finishLine';
import { derivePolicy } from '@core/services/turnPolicy';
import type { TurnPolicy } from '@core/types/turnPolicy';
import { createRoutedError } from '@shared/utils/agentErrorCatalog';
import {
  chiefOfStaffBlockCopy,
  evaluateChiefOfStaffAdmission,
  type ChiefOfStaffUnavailableReason,
} from '@core/services/turnPipeline/chiefOfStaffAdmission';

/**
 * The exact subset of orchestrator-scope inputs the admission phase reads.
 */
export interface AdmissionInput {
  /** Canonical turn id (clientTurnId when provided; generated fallback otherwise). */
  readonly turnId: string;
  readonly win: EventWindow | null;
  readonly prompt: string;
  readonly abortController: AbortController;
  readonly turnOptions:
    | {
        readonly resetConversation?: boolean;
        readonly sessionId?: string;
        readonly attachments?: AnyAttachmentPayload[];
        readonly privateMode?: boolean;
        readonly activeProviderOverride?: ActiveProvider;
        readonly unleashedMode?: boolean;
        readonly finishLine?: string;
        readonly councilMode?: boolean;
        readonly sessionType?: SessionType;
        readonly policy?: TurnPolicy;
        readonly policyOverrides?: Partial<TurnPolicy>;
        readonly thinkingEffortOverride?: ThinkingEffort;
        readonly modelOverride?: string;
        readonly thinkingModelOverride?: string;
        readonly longContextFallbackAttempted?: boolean;
        readonly rateLimitFallbackAttempted?: boolean;
        readonly configuredRoleFallbackAttempted?: Partial<Record<'working' | 'thinking' | 'background', boolean>>;
        readonly routeRebuildHint?: RouteRebuildHint;
        readonly inFlightProviderRoutePlan?: ProviderRoutePlan;
        readonly workingProfileOverrideId?: string;
        readonly thinkingProfileOverrideId?: string;
        readonly existingAbortController?: AbortController;
        readonly origin?: string;
        /**
         * Marks a turn that runs on a real desktop window but is NOT a
         * user-initiated interactive conversation turn — the live-meeting coach
         * (proactive). Such turns MUST NOT trip the Chief-of-Staff admission gate
         * (no block, no recovery UI on a turn the user didn't initiate). See the
         * gate below + PLAN Stage 3 refinement (Decision Log 2026-06-22 14:10).
         */
        readonly nonInteractiveTurn?: boolean;
        /**
         * True when this turn is a system continuation (tool/memory approval
         * retry the app dispatched on the user's behalf). Excluded from the
         * Chief-of-Staff admission gate for the same reason as
         * `nonInteractiveTurn` — the user didn't initiate it.
         */
        readonly isSystemContinuation?: boolean;
        /**
         * 260622 Stage 4: the user's "Run without my instructions" recovery
         * escape. When true, the Chief-of-Staff admission gate SKIPS its block
         * even on a user-initiated desktop interactive turn, logging a
         * structured WARN instead — the turn proceeds on the generic template
         * (the user's explicit allow-proceed-with-warning choice; observable,
         * never silent). Per-turn only — never persisted.
         */
        readonly proceedWithoutChiefOfStaff?: boolean;
      }
    | undefined;
  readonly rendererSessionId: string | null;
  /**
   * Session-level finish line (snapshot, captured by the caller before admission).
   * Used as the fallback when `turnOptions.finishLine` is absent. The per-turn
   * override always wins; see `docs/plans/260515_finish_line.md`.
   */
  readonly sessionFinishLine?: string;
}

/**
 * Stage 2 admission. Side-effect order is kept byte-equivalent with the
 * original `agentTurnExecutor.ts` admission slice.
 */
export async function admit(
  input: AdmissionInput,
  _signal: AbortSignal,
  logger: TurnSessionLogger,
): Promise<TurnPhaseResult<AdmittedTurn>> {
  const { turnId, win, prompt, abortController, turnOptions, rendererSessionId, sessionFinishLine } = input;
  const rendererSessionKind = rendererSessionId ? classifySessionKind(rendererSessionId) : null;
  const effectivePolicy =
    turnOptions?.policy
    ?? derivePolicy(turnOptions?.sessionType, turnOptions?.policyOverrides);

  const effectiveResetConversation = decideEffectiveReset(turnOptions, rendererSessionId);

  if (rendererSessionId) {
    agentTurnRegistry.recordSessionTurn(rendererSessionId);
  }

  if (effectiveResetConversation && rendererSessionId && turnOptions?.resetConversation === undefined) {
    // Admission analytics should reflect user-visible sessions only.
    const sessionIndex = getIncrementalSessionStore().listSessions();
    const isFirstSession =
      sessionIndex.length === 0 ||
      (sessionIndex.length === 1 && sessionIndex[0].id === rendererSessionId);
    const origin = effectivePolicy.origin;
    mainTracking.chatSessionCreated({
      sessionId: rendererSessionId,
      origin,
      isFirstSession,
    });
  }

  if (rendererSessionId) {
    agentTurnRegistry.setRendererSession(turnId, rendererSessionId);
    if (effectiveResetConversation) {
      agentTurnRegistry.clearExtendedContextFailed(rendererSessionId);
      cleanupSessionPendingApprovals(rendererSessionId);
      clearSchemaGateSession(rendererSessionId);
    }

    // Stage 2 (docs/plans/260501_memory_update_session_routing_and_event_dedup.md):
    // skip checkpointing for delete-eligible ephemeral sessions so they never
    // get first-written to disk.
    if (rendererSessionKind && !shouldSkipCheckpointing(rendererSessionKind)) {
      getTurnCheckpointManager()?.startCheckpointing(turnId, rendererSessionId);
    }

    try {
      dispatchAgentEvent(win, turnId, {
        type: 'turn_started',
        timestamp: Date.now(),
      });
    } catch (err) {
      logger.warn({ turnId, err }, 'turn_started dispatch failed — renderer may show delayed spinner');
    }
  }

  if (turnOptions?.privateMode) {
    agentTurnRegistry.setTurnPrivateMode(turnId, true);
  }

  if (rendererSessionKind === 'automation' || rendererSessionKind === 'automation-insight') {
    agentTurnRegistry.setTurnCategory(turnId, 'automation');
  } else if (rendererSessionKind === 'memory-update') {
    agentTurnRegistry.setTurnCategory(turnId, 'memory');
  } else {
    agentTurnRegistry.setTurnCategory(turnId, 'conversation');
  }

  // Register the turn-scoped logger AFTER session/category mutations to match
  // the prior monolith order (setTurnLogger fires after setTurnCategory, just
  // before the "Initializing agent turn" log). The orchestrator passes the
  // logger to runPhase but defers registration to admission so the registry
  // sequence stays parity-equivalent with the pre-Stage-2 trace.
  agentTurnRegistry.setTurnLogger(turnId, logger);

  logger.info(
    {
      effectiveResetConversation,
      rendererHint: turnOptions?.resetConversation ?? 'undefined',
      rendererSessionId: rendererSessionId ?? undefined,
    },
    'Initializing agent turn — main process resetConversation decision',
  );

  const rawSettings = getSettings();
  const settings: AppSettings = turnOptions?.activeProviderOverride
    ? buildSettingsWithOverride(rawSettings, turnOptions.activeProviderOverride)
    : rawSettings;
  const codexAuthProvider = getCodexAuthProvider();
  const codexConnectedAtTurnStart = codexAuthProvider.isConnected();

  const credentialState = validateProviderCredentials(settings, codexConnectedAtTurnStart);

  // Begin per-turn reliability observation (thin slice — see
  // `src/core/services/turnObservability.ts`). Placed after settings/provider
  // are resolved but BEFORE the credential/core-dir terminal early-returns so
  // admission-blocked turns are observed too — every admit exit path funnels
  // through `completeTurnCleanup` (agentTurnExecute.ts:1508/1515), so there is
  // no leak. First-wins, so fallback re-entry with the same turnId is a no-op.
  turnObservability.startTurn(turnId, {
    startedAt: Date.now(),
    origin: effectivePolicy.origin,
    // Pass the raw session kind; the service maps it to the coarse turnCategory.
    // This keeps the admission seam free of the `'automation'` literal (eslint
    // TurnPolicy fence) and avoids a registry read that partial test mocks of
    // agentTurnRegistry don't stub.
    sessionKind: rendererSessionKind,
    // The validated provider class at admission (always defined, post-default),
    // a more faithful "requested provider" than the optional `activeProvider`.
    requestedProvider: credentialState.kind,
    rendererSessionId,
    surface: getPlatformConfig().surface,
  });

  if (turnOptions?.activeProviderOverride) {
    logger.info(
      { originalProvider: rawSettings.activeProvider, overrideTo: turnOptions.activeProviderOverride },
      'Provider override active (rate-limit fallback)',
    );
  }

  if (!settings.coreDirectory) {
    const copy = 'Core directory is not configured.';
    logger.warn('Core directory not configured');
    dispatchAgentErrorEvent(win, turnId, new Error(copy), { humanizedOverride: copy });
    return { status: 'terminal', reason: 'missing-core-directory' };
  }

  switch (credentialState.kind) {
    case 'codex':
      if (credentialState.status === 'disconnected') {
        logger.warn(
          {
            activeProvider: settings.activeProvider,
            surface: getPlatformConfig().surface,
            hasAnthropicKey: !!getApiKey(settings),
          },
          'Codex selected but not connected — failing closed',
        );
        const copy = 'ChatGPT Pro is disconnected. Reconnect it in Settings, or switch to another provider.';
        dispatchAgentErrorEvent(win, turnId, new Error(copy), {
          errorKindOverride: credentialStateToErrorKind(credentialState),
          humanizedOverride: copy,
        });
        return { status: 'terminal', reason: 'codex-not-connected' };
      }
      break;
    case 'openrouter':
      if (credentialState.status === 'missing') {
        logger.warn(
          {
            activeProvider: settings.activeProvider,
            openRouterExists: !!settings.openRouter,
            oauthTokenType:
              settings.openRouter?.oauthToken === null
                ? 'null'
                : settings.openRouter?.oauthToken === undefined
                  ? 'undefined'
                  : settings.openRouter?.oauthToken === ''
                    ? 'empty-string'
                    : 'unexpected',
            enabled: settings.openRouter?.enabled ?? 'unset',
            hasAnthropicKey: !!getApiKey(settings),
          },
          'OpenRouter selected but not connected (no oauthToken) — failing closed',
        );
        const copy = 'OpenRouter is disconnected. Reconnect it in Settings, or switch to another provider.';
        dispatchAgentErrorEvent(win, turnId, new Error(copy), {
          errorKindOverride: credentialStateToErrorKind(credentialState),
          humanizedOverride: copy,
        });
        return { status: 'terminal', reason: 'openrouter-not-connected' };
      }
      break;
    case 'anthropic':
      if (credentialState.status === 'missing') {
        logger.warn('Authentication missing');
        dispatchAgentErrorEvent(
          win,
          turnId,
          new Error('Authentication is missing. Please add an API key in Settings.'),
          { errorKindOverride: credentialStateToErrorKind(credentialState) },
        );
        return { status: 'terminal', reason: 'missing-auth' };
      }
      break;
    case 'mindstone':
      if (!hasManagedOpenRouterKey()) {
        logger.warn(
          { activeProvider: 'mindstone' },
          'Mindstone managed mode selected but no managed key in storage — failing closed',
        );
        const copy = 'Your Mindstone subscription key is not available. Please check your subscription status in Settings.';
        // The managed-key check is a runtime storage probe, not modelled by the
        // `ProviderCredentialState` union (mindstone is always `status: 'valid'`
        // there), so it can't flow through `credentialStateToErrorKind`. It is
        // the SAME not-connected/not-configured class, so it uses the same kind:
        // a missing managed key was never *rejected*. The dedicated mindstone
        // `connection-not-configured` arm in `classifyErrorUx` ("subscription
        // not ready") is more accurate than the `auth` "rejected" copy.
        dispatchAgentErrorEvent(win, turnId, new Error(copy), {
          errorKindOverride: 'connection-not-configured',
          humanizedOverride: copy,
        });
        return { status: 'terminal', reason: 'mindstone-key-missing' };
      }
      break;
    case 'local':
      break;
    default: {
      const _exhaustive: never = credentialState;
      throw new Error(`Unhandled credential state: ${JSON.stringify(_exhaustive)}`);
    }
  }

  // Chief-of-Staff admission gate (260622 Stage 3; predicate refined at review
  // round 2 — Decision Log 2026-06-22 14:10). The user's Chief-of-Staff
  // instructions are the bedrock of the system prompt; if Rebel can't read them
  // on a USER-INITIATED, DESKTOP, INTERACTIVE conversation turn, that is a
  // fatally-blocking error — block and signal it, never silently run on the
  // template.
  //
  // The gate fires ONLY for a user-initiated desktop interactive conversation
  // turn. The original `win !== null` predicate was leaky on BOTH ends and is
  // replaced by an explicit eligibility check:
  //
  //  • Surface gate — `getPlatformConfig().surface === 'desktop'` (NOT window
  //    presence). Cloud passes a NON-NULL virtual event window
  //    (`cloudEventBroadcaster.virtualWindow`) into the same pipeline, so a
  //    `win !== null` gate would terminally block EVERY cloud turn — a FLEET
  //    OUTAGE. Mobile/cli are likewise off-desktop. Off-desktop, the no-op fs
  //    executor returns `reconnecting` for every cloud read and there is no user
  //    at a drive to reconnect, so those surfaces ADMIT + WARN.
  //
  //  • Interactivity gate — exclude non-user-initiated turns even on desktop,
  //    using layered, independent signals so no single brittle proxy carries the
  //    whole invariant:
  //      - session-kind gate: only `rendererSessionKind === 'conversation'` (the
  //        main user-typed conversation) is eligible. This excludes every
  //        background kind whose session id carries a prefix — `memory-update`,
  //        `automation` / `automation-insight`, `meeting-analysis`, `meeting-qa`,
  //        `use-case-discovery`, `cli-chat`, `error-eval`, `calendar-sync` — and
  //        a `meeting-companion` turn. This is the primary guard: the desktop
  //        memory/automation/meeting wrappers no longer rely on the old
  //        `win === null` proxy to stay out of the gate;
  //      - policy gate: `origin === 'manual'` AND `promptSessionMode ===
  //        'interactive'` excludes automation-policy turns (scheduled automations,
  //        onboarding discovery) and cli/mcp-server desktop modes;
  //      - explicit flags: the live-meeting coach (proactive) runs on a REAL
  //        desktop window with interactive policy and a `conversation`-classified
  //        session, so it sets `turnOptions.nonInteractiveTurn` at its call site;
  //        system continuations (tool/memory approval retries, error-recovery
  //        auxiliary turns) set `turnOptions.nonInteractiveTurn` /
  //        `turnOptions.isSystemContinuation` (the latter threaded from
  //        `AgentTurnRequest.isSystemContinuation`).
  //    Blocking + unprompted recovery UI on a turn the user didn't initiate is
  //    wrong UX; these degrade to the template path + a structured WARN, never
  //    block.
  //
  // NB: the FIRST attempt of a real user turn flows through the SAME recovery
  // wrapper (`executeAgentTurnWithRecovery` → `desktopRecoveryAdapter`), so we do
  // NOT exclude "recovery-adapter turns" wholesale — that would silently stop a
  // user's own message from blocking on a dead Chief-of-Staff. Only genuine
  // system continuations (the flags above) are excluded; a recovery RETRY of a
  // user turn re-evaluating the same dead-CoS state is harmless (fail-fast).
  //
  // Excluded turns take the SAME branch as off-desktop (template + WARN, never
  // block, never emit the recovery error event). See chiefOfStaffAdmission.ts +
  // PLAN Stage 3.
  const isUserInteractiveDesktopTurn =
    getPlatformConfig().surface === 'desktop'
    && rendererSessionKind === 'conversation'
    && effectivePolicy.origin === 'manual'
    && effectivePolicy.promptSessionMode === 'interactive'
    && turnOptions?.nonInteractiveTurn !== true
    && turnOptions?.isSystemContinuation !== true;

  // 260622 Stage 4: the user's "Run without my instructions" recovery escape.
  // When the renderer resends the turn with this flag (after the user clicked
  // the escape in the Chief-of-Staff recovery notice), SKIP the block — even on
  // a user-initiated desktop interactive turn — and proceed on the template.
  // Logged loudly (observable, never a silent degrade), per the user's
  // allow-proceed-with-explicit-warning decision. Per-turn only.
  const proceedWithoutChiefOfStaff = turnOptions?.proceedWithoutChiefOfStaff === true;

  let prefetchedChiefOfStaffContent: string | undefined;
  if (isUserInteractiveDesktopTurn && proceedWithoutChiefOfStaff) {
    logger.warn(
      { turnId, surface: getPlatformConfig().surface },
      'User chose to proceed without Chief-of-Staff instructions — admitting on template (recovery escape; not blocked)',
    );
  } else if (isUserInteractiveDesktopTurn) {
    const cosVerdict = await evaluateChiefOfStaffAdmission(settings);
    if (cosVerdict.decision === 'block') {
      const reason: ChiefOfStaffUnavailableReason = cosVerdict.reason;
      const copy = chiefOfStaffBlockCopy(reason);
      logger.warn(
        { turnId, reason, surface: getPlatformConfig().surface },
        'Chief-of-Staff instructions unavailable at admission — blocking turn',
      );
      // Mint a routed error so the dispatcher classifies it and so the cause
      // (`reason`) flows to classifyErrorUx / the renderer via __chiefOfStaffReason.
      const cosError = createRoutedError('chief-of-staff-unavailable', copy) as Error & {
        __chiefOfStaffReason?: ChiefOfStaffUnavailableReason;
      };
      cosError.__chiefOfStaffReason = reason;
      dispatchAgentErrorEvent(win, turnId, cosError, {
        errorKindOverride: 'chief-of-staff-unavailable',
        humanizedOverride: copy,
        markActionable: true,
      });
      return { status: 'terminal', reason: 'chief-of-staff-unavailable' };
    }
    // Admit. On an `ok` read, thread the content forward (F2) so
    // resolveSystemPrompt does not re-read the CoS body.
    prefetchedChiefOfStaffContent = cosVerdict.content;
  } else {
    // Not a user-initiated desktop interactive turn (off-desktop surface,
    // automation/memory/background, or a non-interactive desktop turn — live
    // coach / recovery continuation): NEVER block. Observe the skip loudly so a
    // fleet-wide CoS read problem stays visible, then proceed on the template
    // path unchanged.
    logger.warn(
      {
        turnId,
        surface: getPlatformConfig().surface,
        origin: effectivePolicy.origin,
        promptSessionMode: effectivePolicy.promptSessionMode,
        rendererSessionKind,
        nonInteractiveTurn: turnOptions?.nonInteractiveTurn === true,
        isSystemContinuation: turnOptions?.isSystemContinuation === true,
      },
      'Chief-of-Staff admission gate skipped (not a user-initiated desktop interactive turn) — proceeding on template; not blocked',
    );
  }

  if (abortController.signal.aborted) {
    logger.info('Turn aborted during setup');
    const reason = abortController.signal.reason === 'superseded'
      ? ('superseded' as const)
      : ('user_stopped' as const);
    dispatchAgentEvent(win, turnId, makeSyntheticResult(turnId, '', reason));
    return { status: 'terminal', reason: 'aborted' };
  }

  const unleashedPattern = /\/\/unleashed\b/i;
  const keywordUnleashed = unleashedPattern.test(prompt);
  const unleashedMode = keywordUnleashed || turnOptions?.unleashedMode === true;
  const promptWithoutUnleashed = keywordUnleashed
    ? prompt.replace(unleashedPattern, '').replace(/[ \t]{2,}/g, ' ').trim()
    : prompt;
  if (unleashedMode) {
    logger.info(
      { promptLength: promptWithoutUnleashed.length, source: keywordUnleashed ? 'keyword' : 'flag' },
      'Unleashed mode activated - using persistent continuation',
    );
  }

  // Per-turn finishLine override beats session-level. Mirrors unleashedMode's
  // admission-time snapshot semantics: the criterion is captured here and
  // does not change mid-turn. See `docs/plans/260515_finish_line.md`.
  const finishLine = normalizeFinishLine(turnOptions?.finishLine ?? sessionFinishLine);

  const councilPattern = /\/\/council\b/i;
  const keywordCouncil = councilPattern.test(promptWithoutUnleashed);
  const councilModeRequested = keywordCouncil || turnOptions?.councilMode === true;
  const promptWithoutCouncil = keywordCouncil
    ? promptWithoutUnleashed.replace(councilPattern, '').replace(/[ \t]{2,}/g, ' ').trim()
    : promptWithoutUnleashed;
  const promptForContext = councilModeRequested ? promptWithoutCouncil : promptWithoutUnleashed;

  const {
    explicitRequested: explicitDesignContextRequested,
    sanitizedPrompt: promptWithoutDesignContext,
  } = stripDesignContextCommand(promptForContext);
  const { sanitizedPrompt: promptWithoutDesignContextOrUnleashed } =
    stripDesignContextCommand(promptWithoutUnleashed);
  const {
    explicitRequested: explicitOurComponentsRequested,
    sanitizedPrompt: promptWithoutOurComponents,
  } = stripOurComponentsCommand(promptWithoutDesignContext);
  const { sanitizedPrompt: promptWithoutOurComponentsOrUnleashed } =
    stripOurComponentsCommand(promptWithoutDesignContextOrUnleashed);

  return {
    status: 'ok',
    value: {
      turnId,
      win,
      abortController,
      settings,
      codexConnectedAtTurnStart,
      rendererSessionId,
      effectiveResetConversation,
      unleashedMode,
      finishLine,
      councilModeRequested,
      prompts: {
        promptForContext,
        promptWithoutOurComponents,
        promptWithoutOurComponentsOrUnleashed,
        explicitDesignContextRequested,
        explicitOurComponentsRequested,
      },
      ...(prefetchedChiefOfStaffContent !== undefined
        ? { prefetchedChiefOfStaffContent }
        : {}),
    },
  };
}

export function createTrackingCounters(): MutableTrackingCounters {
  return {
    messageCount: 0,
    receivedResultMessage: false,
    lastMessageType: undefined,
    lastToolName: undefined,
    mcpMode: undefined,
    hasMedia: false,
  };
}

export function createWatchdogDiagnostics(): MutableWatchdogDiagnostics {
  return {
    abortedByWatchdog: false,
    abortedByAwaitingApiStall: false,
    watchdogFired: false,
    watchdogFiredAt: undefined,
    maxWatchdogLevel: 0,
    watchdogLevel: 0,
    effectiveAbortMs: 0,
    rawStreamEventCount: 0,
    rawStreamLastEventType: null,
    rawStreamLastEventAgeMs: null,
  };
}

export function buildTurnCompletionBaseContext(args: {
  turnId: string;
  win: EventWindow | null;
  turnLogger: TurnSessionLogger;
  abortController: AbortController;
  settings: AppSettings;
  rendererSessionId: string | null;
  turnOptions: TurnCompletionBaseContext['turnOptions'];
  prompt: string;
  retryTurn: TurnCompletionBaseContext['retryTurn'];
  trackingCounters: MutableTrackingCounters;
  watchdogDiagnostics: MutableWatchdogDiagnostics;
  effectiveResetConversation: boolean;
  getLastActivityAgeMs?: () => number;
  getMessageTimeoutMs?: () => number;
  isToolInFlight?: () => boolean;
}): TurnCompletionBaseContext {
  const availableProfiles = args.settings.localModel?.profiles ?? [];
  const thinkingProfile = getThinkingProfile(args.settings);
  const workingProfile = getWorkingProfile(args.settings);
  const requestedModelForTurn =
    args.turnOptions?.modelOverride ??
    getCurrentModel(args.settings) ??
    getDefaultModelForProvider(args.settings, 'working');

  return {
    turnId: args.turnId,
    win: args.win,
    turnLogger: args.turnLogger,
    abortController: args.abortController,
    settings: args.settings,
    rendererSessionId: args.rendererSessionId,
    turnOptions: args.turnOptions,
    prompt: args.prompt,
    retryTurn: args.retryTurn,
    trackingCounters: args.trackingCounters,
    watchdogDiagnostics: args.watchdogDiagnostics,
    effectiveResetConversation: args.effectiveResetConversation,
    availableProfiles,
    thinkingProfile,
    workingProfile,
    requestedModelForTurn,
    getLastActivityAgeMs: args.getLastActivityAgeMs ?? (() => 0),
    getMessageTimeoutMs: args.getMessageTimeoutMs ?? (() => 0),
    ...(args.isToolInFlight && { isToolInFlight: args.isToolInFlight }),
  };
}

function decideEffectiveReset(
  turnOptions: AdmissionInput['turnOptions'],
  rendererSessionId: string | null,
): boolean {
  if (turnOptions?.resetConversation !== undefined) return turnOptions.resetConversation;
  if (!rendererSessionId) return true;
  if (agentTurnRegistry.hasSessionHadTurns(rendererSessionId)) return false;
  // Reset heuristics are UI-facing and intentionally ignore internal sessions.
  const sessionIndex = getIncrementalSessionStore().listSessions();
  const indexEntry = sessionIndex.find((s) => s.id === rendererSessionId);
  return !indexEntry || (indexEntry.messageCount ?? 0) === 0;
}

export function buildSettingsWithOverride(rawSettings: AppSettings, override: ActiveProvider): AppSettings {
  const currentModels = resolveModelSettings(rawSettings) as NonNullable<AppSettings['models']>;
  return {
    ...rawSettings,
    activeProvider: override,
    models: { ...currentModels, workingProfileId: undefined, thinkingProfileId: undefined },
    localModel: { profiles: rawSettings.localModel?.profiles ?? [], activeProfileId: null },
    ...(override === 'openrouter' && rawSettings.openRouter
      ? { openRouter: { ...rawSettings.openRouter, enabled: true } }
      : {}),
  };
}
