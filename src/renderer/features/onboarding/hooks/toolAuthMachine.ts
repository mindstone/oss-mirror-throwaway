/**
 * Pure tool-auth finite state machine for onboarding — the single typed source of
 * truth for "where is each connector in its auth lifecycle, and what status
 * change is legal from here". Replaces the ad-hoc `updateToolAuthState(tool,
 * Partial<ToolAuthState>)` mutation + scattered `[...].includes(status)` literal
 * membership checks that previously let any caller set any `status` to any value
 * with no guard — the exact shape that let postmortem `251202` silently collapse
 * `ready_to_connect` and `awaiting_auth`. Design rationale + the must-preserve
 * invariant list live in `docs/plans/260608_onboarding-flow-state-machine/PLAN.md`.
 *
 * Mirrors the open-union discipline of `src/shared/workspace/workspaceAccessState.ts`.
 *
 * The discipline this module enforces (read before editing):
 *
 *  1. USER-CLICK GATES NETWORK POLLING. Generating an auth URL only ever reaches
 *     `ready_to_connect`. Polling is gated behind the explicit
 *     `USER_CLICKED_CONNECT` (or `autoStart`) transition into `awaiting_auth` —
 *     no event may jump generate→awaiting_auth implicitly.
 *
 *  2. `ready_to_connect` (URL ready, waiting for the user) and `awaiting_auth`
 *     (polling in flight) are DISTINCT states, never collapsed. The only edges
 *     between them are an explicit click / auto-start (forward) and the polling
 *     terminal events (timeout→error, authenticated→connected). Collapsing them
 *     is the `251202` deadlock, so the transition table forbids the shortcuts and
 *     the reducer tests assert each forbidden edge.
 *
 *  3. STATUS CHANGES GO THROUGH NAMED EVENTS ONLY (M3). The public
 *     `updateToolAuthState` adapter is FIELD-ONLY (`ToolAuthFieldPatch` omits
 *     `status`), so a consumer-driven status change is a COMPILE ERROR. Every
 *     real status transition is a named `ToolAuthEvent` the table validates.
 *     The full-replace primitive (`STATES_REPLACED`, which validates every status
 *     delta through the table) and the legacy `PATCH_STATUS` event survive only
 *     as reducer-internal / test-only status drivers — neither is surfaced on the
 *     production `OnboardingFlowActions` contract, so there is no status-bypass
 *     escape hatch on the action surface.
 *
 *  4. OPEN-UNION DISCIPLINE. `ToolAuthEvent` / `ToolAuthStatus` are INTERNAL,
 *     post-parse unions. IPC payloads are runtime-unvalidated, so the boundary
 *     parsers below treat inputs as `unknown` and map every unrecognized shape to
 *     a source-aware internal event (no-op for polling; terminal failure/pending
 *     for in-flight generate and manual-verify). `isKnownStatus` likewise re-
 *     validates any status that crossed a runtime boundary. `assertNever` runs
 *     ONLY over these parsed internal unions — never over raw IPC payloads — so an
 *     unknown runtime value can never crash an exhaustive switch.
 */
import { assertNever } from '@shared/utils/assertNever';
import { invariant } from '@shared/utils/invariant';
import type { ToolAuthState, ToolAuthStatus, ToolType } from './toolAuthTypes';

/**
 * The ONLY shape a consumer may hand to the public `updateToolAuthState` adapter:
 * a partial of the mutable fields, with `tool` and `status` removed. Omitting
 * `status` here is what makes a consumer-driven status change a COMPILE ERROR
 * (M3) — status transitions must go through named events the FSM table validates.
 */
export type ToolAuthFieldPatch = Partial<Omit<ToolAuthState, 'tool' | 'status'>>;
type ToolAuthStatesReplacement = ToolAuthState[] | ((states: ToolAuthState[]) => ToolAuthState[]);
type ToolAuthStatusPatch = Partial<ToolAuthState> & { status: ToolAuthStatus };

type ToolAuthStatusPatchEventResult =
  | { ok: true; event: ToolAuthEvent | null }
  | { ok: false; reason: string };

export type ToolAuthEvent =
  | { type: 'GENERATE_REQUESTED'; tool: ToolType }
  | { type: 'URL_READY'; tool: ToolType; authUrl: string }
  | { type: 'USER_CLICKED_CONNECT'; tool: ToolType; authUrl?: string; awaitingSince: number; autoStart?: boolean }
  | { type: 'GENERATE_FAILED'; tool: ToolType; error: string }
  | { type: 'LOCAL_OAUTH_CONNECTED'; tools: ToolType[] }
  | { type: 'EXISTING_ACCOUNT_FOUND'; tools: ToolType[] }
  | { type: 'CATALOG_CONNECTION_OBSERVED'; tool: ToolType }
  | { type: 'POLL_AUTHENTICATED'; tool: ToolType }
  | { type: 'VERIFY_REQUESTED'; tool: ToolType }
  | { type: 'VERIFY_AUTHENTICATED'; tool: ToolType }
  | { type: 'VERIFY_PENDING'; tool: ToolType }
  | { type: 'VERIFY_FAILED'; tool: ToolType; error: string }
  | { type: 'POLL_TIMEOUT'; tool: ToolType; error: string }
  | { type: 'DISCONNECTED'; tool: ToolType }
  | { type: 'ERROR_CLEARED'; tool: ToolType }
  | { type: 'PATCH_STATUS'; tool: ToolType; status: ToolAuthStatus; fields: ToolAuthFieldPatch }
  | { type: 'FIELD_PATCHED'; tool: ToolType; patch: ToolAuthFieldPatch }
  | { type: 'STATES_REPLACED'; replacement: ToolAuthStatesReplacement };

type TransitionDecision = ToolAuthStatus | 'unchanged' | 'illegal';

export type VerifyResponseSource = 'poll' | 'verify';

const ALL_STATUSES: ToolAuthStatus[] = [
  'pending',
  'generating',
  'ready_to_connect',
  'awaiting_auth',
  'verifying',
  'connected',
  'error',
];

export function isPollingStatus(status: ToolAuthStatus): status is 'awaiting_auth' {
  return status === 'awaiting_auth';
}

export function isPendingStatus(status: ToolAuthStatus): status is 'pending' {
  return status === 'pending';
}

export function isGeneratingStatus(status: ToolAuthStatus): status is 'generating' {
  return status === 'generating';
}

export function isReadyToConnectStatus(status: ToolAuthStatus): status is 'ready_to_connect' {
  return status === 'ready_to_connect';
}

export function isVerifyingStatus(status: ToolAuthStatus): status is 'verifying' {
  return status === 'verifying';
}

export function isConnectedStatus(status: ToolAuthStatus): status is 'connected' {
  return status === 'connected';
}

export function isErrorStatus(status: ToolAuthStatus): status is 'error' {
  return status === 'error';
}

export function isInFlight(status: ToolAuthStatus): status is 'generating' | 'awaiting_auth' | 'verifying' {
  return status === 'generating' || status === 'awaiting_auth' || status === 'verifying';
}

export function isAwaitingOrVerifyingStatus(status: ToolAuthStatus): status is 'awaiting_auth' | 'verifying' {
  return isPollingStatus(status) || isVerifyingStatus(status);
}

export function isConnectorSetupClickableStatus(status: ToolAuthStatus): status is 'pending' | 'error' | 'ready_to_connect' {
  return isPendingStatus(status) || isErrorStatus(status) || isReadyToConnectStatus(status);
}

export function isCategoryActiveStatus(
  status: ToolAuthStatus,
): status is 'generating' | 'ready_to_connect' | 'awaiting_auth' | 'verifying' {
  return isGeneratingStatus(status) || isReadyToConnectStatus(status) || isAwaitingOrVerifyingStatus(status);
}

export function isToolAuthGateRelevantStatus(status: ToolAuthStatus): status is 'connected' | 'error' {
  return status === 'connected' || status === 'error';
}

function isKnownStatus(status: ToolAuthStatus): boolean {
  return ALL_STATUSES.includes(status);
}

function targetToolsForEvent(event: ToolAuthEvent): ToolType[] {
  switch (event.type) {
    case 'LOCAL_OAUTH_CONNECTED':
    case 'EXISTING_ACCOUNT_FOUND':
      return event.tools;
    case 'GENERATE_REQUESTED':
    case 'URL_READY':
    case 'USER_CLICKED_CONNECT':
    case 'GENERATE_FAILED':
    case 'CATALOG_CONNECTION_OBSERVED':
    case 'POLL_AUTHENTICATED':
    case 'VERIFY_REQUESTED':
    case 'VERIFY_AUTHENTICATED':
    case 'VERIFY_PENDING':
    case 'VERIFY_FAILED':
    case 'POLL_TIMEOUT':
    case 'DISCONNECTED':
    case 'ERROR_CLEARED':
    case 'PATCH_STATUS':
    case 'FIELD_PATCHED':
      return [event.tool];
    case 'STATES_REPLACED':
      return [];
    default:
      return assertNever(event, 'ToolAuthEvent');
  }
}

function transitionFor(status: ToolAuthStatus, event: ToolAuthEvent): TransitionDecision {
  switch (event.type) {
    case 'GENERATE_REQUESTED':
      switch (status) {
        case 'pending':
        case 'ready_to_connect':
        case 'error':
          return 'generating';
        case 'generating':
        case 'awaiting_auth':
        case 'verifying':
        case 'connected':
          return 'unchanged';
        default:
          return assertNever(status, 'ToolAuthStatus GENERATE_REQUESTED');
      }

    case 'URL_READY':
      switch (status) {
        case 'generating':
          return 'ready_to_connect';
        case 'pending':
        case 'ready_to_connect':
        case 'awaiting_auth':
        case 'verifying':
        case 'connected':
        case 'error':
          return 'unchanged';
        default:
          return assertNever(status, 'ToolAuthStatus URL_READY');
      }

    case 'USER_CLICKED_CONNECT':
      switch (status) {
        case 'ready_to_connect':
        case 'generating':
          return 'awaiting_auth';
        case 'pending':
        case 'awaiting_auth':
        case 'verifying':
        case 'connected':
        case 'error':
          return 'unchanged';
        default:
          return assertNever(status, 'ToolAuthStatus USER_CLICKED_CONNECT');
      }

    case 'GENERATE_FAILED':
      switch (status) {
        case 'generating':
          return 'error';
        case 'pending':
        case 'ready_to_connect':
        case 'awaiting_auth':
        case 'verifying':
        case 'connected':
        case 'error':
          return 'unchanged';
        default:
          return assertNever(status, 'ToolAuthStatus GENERATE_FAILED');
      }

    case 'LOCAL_OAUTH_CONNECTED':
      switch (status) {
        case 'pending':
        case 'generating':
        case 'ready_to_connect':
        case 'awaiting_auth':
        case 'verifying':
        case 'connected':
        case 'error':
          return 'connected';
        default:
          return assertNever(status, 'ToolAuthStatus LOCAL_OAUTH_CONNECTED');
      }

    case 'EXISTING_ACCOUNT_FOUND':
      switch (status) {
        case 'pending':
        case 'generating':
        case 'ready_to_connect':
        case 'awaiting_auth':
        case 'verifying':
          return 'connected';
        case 'connected':
        case 'error':
          return 'unchanged';
        default:
          return assertNever(status, 'ToolAuthStatus EXISTING_ACCOUNT_FOUND');
      }

    case 'CATALOG_CONNECTION_OBSERVED':
      switch (status) {
        case 'pending':
          return 'connected';
        case 'generating':
        case 'ready_to_connect':
        case 'awaiting_auth':
        case 'verifying':
        case 'connected':
        case 'error':
          return 'unchanged';
        default:
          return assertNever(status, 'ToolAuthStatus CATALOG_CONNECTION_OBSERVED');
      }

    case 'POLL_AUTHENTICATED':
    case 'VERIFY_AUTHENTICATED':
      switch (status) {
        case 'awaiting_auth':
        case 'verifying':
          return 'connected';
        case 'pending':
        case 'generating':
        case 'ready_to_connect':
        case 'connected':
        case 'error':
          return 'unchanged';
        default:
          return assertNever(status, `ToolAuthStatus ${event.type}`);
      }

    case 'VERIFY_REQUESTED':
      switch (status) {
        case 'awaiting_auth':
          return 'verifying';
        case 'pending':
        case 'generating':
        case 'ready_to_connect':
        case 'verifying':
        case 'connected':
        case 'error':
          return 'unchanged';
        default:
          return assertNever(status, 'ToolAuthStatus VERIFY_REQUESTED');
      }

    case 'VERIFY_PENDING':
      switch (status) {
        case 'verifying':
          return 'awaiting_auth';
        case 'pending':
        case 'generating':
        case 'ready_to_connect':
        case 'awaiting_auth':
        case 'connected':
        case 'error':
          return 'unchanged';
        default:
          return assertNever(status, 'ToolAuthStatus VERIFY_PENDING');
      }

    case 'VERIFY_FAILED':
      switch (status) {
        case 'verifying':
          return 'error';
        case 'pending':
        case 'generating':
        case 'ready_to_connect':
        case 'awaiting_auth':
        case 'connected':
        case 'error':
          return 'unchanged';
        default:
          return assertNever(status, 'ToolAuthStatus VERIFY_FAILED');
      }

    case 'POLL_TIMEOUT':
      switch (status) {
        case 'awaiting_auth':
          return 'error';
        case 'pending':
        case 'generating':
        case 'ready_to_connect':
        case 'verifying':
        case 'connected':
        case 'error':
          return 'unchanged';
        default:
          return assertNever(status, 'ToolAuthStatus POLL_TIMEOUT');
      }

    case 'DISCONNECTED':
      // Disconnecting a connector resets EVERY tool sharing it to `pending` and
      // clears transient fields, from whatever status it was in. This matches
      // the pre-FSM behaviour, where ToolAuthStep looped over every matching
      // tool calling `updateToolAuthState(p.value, { status: 'pending', error:
      // null, awaitingSince: null })` unconditionally — so a sibling tool left
      // in `error`/`awaiting_auth` on a shared connector is reset too, not just
      // the `connected` one.
      switch (status) {
        case 'connected':
        case 'pending':
        case 'generating':
        case 'ready_to_connect':
        case 'awaiting_auth':
        case 'verifying':
        case 'error':
          return 'pending';
        default:
          return assertNever(status, 'ToolAuthStatus DISCONNECTED');
      }

    case 'ERROR_CLEARED':
    case 'PATCH_STATUS':
    case 'FIELD_PATCHED':
      return status;

    case 'STATES_REPLACED':
      return status;

    default:
      return assertNever(event, 'ToolAuthEvent transition');
  }
}

function shouldThrowForIllegalTransition(): boolean {
  return import.meta.env.DEV || import.meta.env.MODE === 'test';
}

function handleIllegalTransition(state: ToolAuthState, event: ToolAuthEvent): ToolAuthState {
  const payload = {
    eventType: event.type,
    tool: state.tool,
    status: state.status,
  };

  if (shouldThrowForIllegalTransition()) {
    invariant(false, 'Illegal tool auth state transition', payload);
  }

  console.warn('[toolAuthMachine] Illegal tool auth state transition ignored', payload);
  return state;
}

function handleIllegalReplacement(reason: string): void {
  const payload = { reason };

  if (shouldThrowForIllegalTransition()) {
    invariant(false, 'Illegal tool auth state replacement', payload);
  }

  console.warn('[toolAuthMachine] Illegal tool auth state replacement ignored', payload);
}

export function toolAuthEventForStatusPatch(
  current: ToolAuthState,
  patch: ToolAuthStatusPatch,
): ToolAuthStatusPatchEventResult {
  if (current.status === patch.status) {
    return { ok: true, event: null };
  }

  switch (patch.status) {
    case 'pending':
      return current.status === 'connected'
        ? { ok: true, event: { type: 'DISCONNECTED', tool: current.tool } }
        : { ok: false, reason: `${current.status}->pending is not an allowed tool-auth transition` };

    case 'generating':
      return current.status === 'pending' || current.status === 'ready_to_connect' || current.status === 'error'
        ? { ok: true, event: { type: 'GENERATE_REQUESTED', tool: current.tool } }
        : { ok: false, reason: `${current.status}->generating is not an allowed tool-auth transition` };

    case 'ready_to_connect': {
      const authUrl = patch.authUrl ?? current.authUrl;
      if (current.status !== 'generating') {
        return { ok: false, reason: `${current.status}->ready_to_connect is not an allowed tool-auth transition` };
      }
      if (!authUrl) {
        return { ok: false, reason: 'ready_to_connect requires an authUrl' };
      }
      return { ok: true, event: { type: 'URL_READY', tool: current.tool, authUrl } };
    }

    case 'awaiting_auth':
      if (current.status === 'verifying') {
        return { ok: true, event: { type: 'VERIFY_PENDING', tool: current.tool } };
      }
      return current.status === 'ready_to_connect' || current.status === 'generating'
        ? {
            ok: true,
            event: {
              type: 'USER_CLICKED_CONNECT',
              tool: current.tool,
              authUrl: patch.authUrl ?? current.authUrl ?? undefined,
              awaitingSince: patch.awaitingSince ?? Date.now(),
            },
          }
        : { ok: false, reason: `${current.status}->awaiting_auth is not an allowed tool-auth transition` };

    case 'verifying':
      return current.status === 'awaiting_auth'
        ? { ok: true, event: { type: 'VERIFY_REQUESTED', tool: current.tool } }
        : { ok: false, reason: `${current.status}->verifying is not an allowed tool-auth transition` };

    case 'connected':
      if (current.status === 'pending') {
        return { ok: true, event: { type: 'CATALOG_CONNECTION_OBSERVED', tool: current.tool } };
      }
      if (current.status === 'awaiting_auth' || current.status === 'verifying') {
        return { ok: true, event: { type: 'VERIFY_AUTHENTICATED', tool: current.tool } };
      }
      return { ok: true, event: { type: 'LOCAL_OAUTH_CONNECTED', tools: [current.tool] } };

    case 'error':
      if (current.status === 'generating') {
        return {
          ok: true,
          event: { type: 'GENERATE_FAILED', tool: current.tool, error: patch.error ?? 'Failed to generate auth link' },
        };
      }
      if (current.status === 'verifying') {
        return {
          ok: true,
          event: { type: 'VERIFY_FAILED', tool: current.tool, error: patch.error ?? 'Failed to verify authentication' },
        };
      }
      return current.status === 'awaiting_auth'
        ? {
            ok: true,
            event: {
              type: 'POLL_TIMEOUT',
              tool: current.tool,
              error: patch.error ?? 'Timed out waiting for authentication - try again.',
            },
          }
        : { ok: false, reason: `${current.status}->error is not an allowed tool-auth transition` };

    default:
      return assertNever(patch.status, 'ToolAuthStatus status patch');
  }
}

function applyEventToState(state: ToolAuthState, event: ToolAuthEvent): ToolAuthState {
  if (!isKnownStatus(state.status)) {
    return handleIllegalTransition(state, event);
  }

  if (event.type === 'PATCH_STATUS') {
    if (!isKnownStatus(event.status)) {
      return handleIllegalTransition(state, event);
    }

    const result = toolAuthEventForStatusPatch(state, { ...event.fields, status: event.status });
    if (!result.ok) {
      return handleIllegalTransition(state, event);
    }

    if (!result.event && Object.keys(event.fields).length === 0) {
      return state;
    }

    return { ...state, ...event.fields, status: event.status };
  }

  if (event.type === 'FIELD_PATCHED' && Object.prototype.hasOwnProperty.call(event.patch, 'status')) {
    return handleIllegalTransition(state, event);
  }
  if (event.type === 'FIELD_PATCHED' && Object.keys(event.patch).length === 0) {
    return state;
  }

  const nextStatus = transitionFor(state.status, event);
  if (nextStatus === 'illegal') {
    return handleIllegalTransition(state, event);
  }
  if (nextStatus === 'unchanged') {
    return state;
  }

  switch (event.type) {
    case 'GENERATE_REQUESTED':
      return { ...state, status: nextStatus, error: null };
    case 'URL_READY':
      return { ...state, status: nextStatus, authUrl: event.authUrl };
    case 'USER_CLICKED_CONNECT':
      return {
        ...state,
        status: nextStatus,
        authUrl: event.authUrl ?? state.authUrl,
        error: null,
        awaitingSince: event.awaitingSince,
      };
    case 'GENERATE_FAILED':
    case 'VERIFY_FAILED':
      return {
        ...state,
        status: nextStatus,
        error: event.error,
        awaitingSince: null,
      };
    case 'LOCAL_OAUTH_CONNECTED':
    case 'EXISTING_ACCOUNT_FOUND':
    case 'CATALOG_CONNECTION_OBSERVED':
    case 'POLL_AUTHENTICATED':
    case 'VERIFY_AUTHENTICATED':
      return {
        ...state,
        status: nextStatus,
        error: null,
        awaitingSince: null,
      };
    case 'VERIFY_REQUESTED':
      return { ...state, status: nextStatus, error: null };
    case 'VERIFY_PENDING':
      return { ...state, status: nextStatus, error: null, awaitingSince: state.awaitingSince ?? null };
    case 'POLL_TIMEOUT':
      return {
        ...state,
        status: nextStatus,
        error: event.error,
        awaitingSince: null,
      };
    case 'DISCONNECTED':
      return {
        ...state,
        status: nextStatus,
        error: null,
        awaitingSince: null,
      };
    case 'ERROR_CLEARED':
      return { ...state, error: null };
    case 'FIELD_PATCHED':
      return { ...state, ...event.patch, status: state.status };
    case 'STATES_REPLACED':
      return state;
    default:
      return assertNever(event, 'ToolAuthEvent apply');
  }
}

export function toolAuthReducer(states: ToolAuthState[], event: ToolAuthEvent): ToolAuthState[] {
  if (event.type === 'STATES_REPLACED') {
    const replacement =
      typeof event.replacement === 'function' ? event.replacement(states) : event.replacement;

    const statesByTool = new Map(states.map((state) => [state.tool, state]));
    for (const nextState of replacement) {
      const currentState = statesByTool.get(nextState.tool);
      if (!isKnownStatus(nextState.status)) {
        handleIllegalReplacement(`Unknown status for ${nextState.tool}: ${nextState.status}`);
        return states;
      }
      if (!currentState || currentState.status === nextState.status) {
        continue;
      }

      const result = toolAuthEventForStatusPatch(currentState, nextState);
      if (!result.ok || !result.event || transitionFor(currentState.status, result.event) !== nextState.status) {
        handleIllegalReplacement(result.ok ? `${currentState.status}->${nextState.status} was not accepted by the transition table` : result.reason);
        return states;
      }
    }

    return replacement;
  }

  const targetTools = new Set(targetToolsForEvent(event));
  let changed = false;

  const nextStates = states.map((state) => {
    if (!targetTools.has(state.tool)) {
      return state;
    }

    const nextState = applyEventToState(state, event);
    if (nextState !== state) {
      changed = true;
    }
    return nextState;
  });

  return changed ? nextStates : states;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function noOpEvent(tool: ToolType): ToolAuthEvent {
  return { type: 'FIELD_PATCHED', tool, patch: {} };
}

function generateFailedEvent(
  tool: ToolType,
  raw: unknown,
  fallbackError: string | undefined,
): ToolAuthEvent {
  return {
    type: 'GENERATE_FAILED',
    tool,
    error: fallbackError ?? (isRecord(raw) ? stringField(raw.error) : undefined) ?? 'Failed to generate auth link',
  };
}

function verifyFailedEvent(
  tool: ToolType,
  raw: unknown,
  fallbackError: string | undefined,
): ToolAuthEvent {
  return {
    type: 'VERIFY_FAILED',
    tool,
    error: fallbackError ?? (isRecord(raw) ? stringField(raw.error) : undefined) ?? 'Failed to verify authentication',
  };
}

export function toolAuthEventFromAuthUrlResponse(
  tool: ToolType,
  raw: unknown,
  options?: { autoStart?: boolean; awaitingSince?: number; fallbackError?: string },
): ToolAuthEvent {
  if (!isRecord(raw)) {
    return generateFailedEvent(tool, raw, options?.fallbackError);
  }

  if (raw.success === true) {
    const authUrl = stringField(raw.authUrl);
    if (!authUrl) {
      return generateFailedEvent(tool, raw, options?.fallbackError);
    }

    if (options?.autoStart) {
      return {
        type: 'USER_CLICKED_CONNECT',
        tool,
        authUrl,
        awaitingSince: options.awaitingSince ?? Date.now(),
        autoStart: true,
      };
    }

    return { type: 'URL_READY', tool, authUrl };
  }

  if (raw.success === false) {
    return generateFailedEvent(tool, raw, options?.fallbackError);
  }

  return generateFailedEvent(tool, raw, options?.fallbackError);
}

export function toolAuthEventFromVerifyResponse(
  tool: ToolType,
  raw: unknown,
  options?: { source?: VerifyResponseSource; fallbackError?: string },
): ToolAuthEvent {
  const source = options?.source ?? 'verify';

  if (!isRecord(raw)) {
    return source === 'poll'
      ? noOpEvent(tool)
      : verifyFailedEvent(tool, raw, options?.fallbackError);
  }

  if (raw.success === true) {
    if (raw.isAuthenticated === true) {
      return { type: source === 'poll' ? 'POLL_AUTHENTICATED' : 'VERIFY_AUTHENTICATED', tool };
    }

    if (raw.isAuthenticated === false) {
      return source === 'verify' ? { type: 'VERIFY_PENDING', tool } : noOpEvent(tool);
    }

    return source === 'verify' ? { type: 'VERIFY_PENDING', tool } : noOpEvent(tool);
  }

  if (raw.success === false) {
    return source === 'verify'
      ? verifyFailedEvent(tool, raw, options?.fallbackError)
      : noOpEvent(tool);
  }

  return source === 'poll'
    ? noOpEvent(tool)
    : verifyFailedEvent(tool, raw, options?.fallbackError);
}
