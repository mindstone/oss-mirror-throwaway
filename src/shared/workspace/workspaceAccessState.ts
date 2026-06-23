/**
 * Discriminated representation of a *workspace-access probe result* — the single
 * typed vocabulary for "is the configured/suggested workspace usable, and if not,
 * why". Replaces the duplicated `code === 'EACCES' || code === 'EPERM'` literal
 * interpretation that previously lived independently at each onboarding/recovery
 * gate (auto-default persist, completion gate, startup recovery), where the
 * surfaces could drift on what "denied" vs "missing" meant.
 *
 * Prevention for the `onboarding_continue_button_deadlock` family — postmortem
 * `260531_windows_cfa_workspace_onboarding_deadlock` (FOX-2873) recommendation
 * `893d1e79`. Design rationale + the must-preserve invariant list + the reframe
 * (why this is the cross-surface seam, not a hook-local union) live in
 * `docs/plans/260608_onboarding-workspace-state-union/PLAN.md`.
 *
 * IMPORTANT — open-union discipline: this is an INTERNAL, post-parse type. The
 * IPC wire schema (`ValidateWorkspaceAccessResponse`) is deliberately left as a
 * tolerant `{accessible, code?}` shape. Raw IPC payloads / raw errno codes are
 * mapped here via the two parsers below, each of which maps every unrecognized
 * input to a real member — so a consumer's exhaustive `switch` (with
 * `assertNever`) only ever sees parsed values and can never crash on an unknown
 * runtime code. The two parsers use SOURCE-SPECIFIC fallbacks to preserve each
 * consumer's pre-existing user-visible copy (fromResponse: unknown -> invalid;
 * fromErrno: any non-denied throw -> missing).
 */
import type { ValidateWorkspaceAccessResponse } from '@shared/ipc/channels/health';

export type WorkspaceAccessState =
  | { status: 'accessible'; resolvedPath?: string; created?: boolean }
  | { status: 'denied'; code: 'EACCES' | 'EPERM'; error?: string; resolvedPath?: string }
  | { status: 'missing'; code?: string; error?: string; resolvedPath?: string }
  | { status: 'invalid'; code?: string; error?: string; resolvedPath?: string };

function isDeniedWorkspaceAccessCode(code: string | undefined): code is 'EACCES' | 'EPERM' {
  return code === 'EACCES' || code === 'EPERM';
}

export function workspaceAccessStateFromResponse(
  response: ValidateWorkspaceAccessResponse,
): WorkspaceAccessState {
  if (response.accessible) {
    return {
      status: 'accessible',
      resolvedPath: response.resolvedPath,
      created: response.created,
    };
  }

  if (isDeniedWorkspaceAccessCode(response.code)) {
    return {
      status: 'denied',
      code: response.code,
      error: response.error,
      resolvedPath: response.resolvedPath,
    };
  }

  return {
    status: 'invalid',
    code: response.code,
    error: response.error,
    resolvedPath: response.resolvedPath,
  };
}

export function workspaceAccessStateFromErrno(
  code: string | undefined,
): WorkspaceAccessState {
  if (isDeniedWorkspaceAccessCode(code)) {
    return { status: 'denied', code };
  }

  return { status: 'missing', code };
}
