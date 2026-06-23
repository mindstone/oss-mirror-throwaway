export interface SlackPollGate {
  /**
   * Synchronous gate check. Returns paused=true when desktop polling
   * MUST yield to cloud webhook for this team_id.
   *
   * Synchronous because called at the top of poll() in a hot loop.
   * Cloud-status freshness is the responsibility of the producer (settings sync).
   */
  shouldPause(workspaceTeamId: string): { paused: boolean; reason: string | null };
}

export interface SlackPollGateState {
  cloudFlagEnabled: boolean;
  cloudWorkspaceTeamId: string | null;
  cloudWorkspaceStatus: 'connected' | 'needs_reconnect' | 'disconnected' | null;
  cloudReachable: boolean;
}

export function evaluatePollGate(
  state: SlackPollGateState,
  pollWorkspaceTeamId: string,
): { paused: boolean; reason: string | null } {
  if (!state.cloudFlagEnabled) {
    return { paused: false, reason: null };
  }

  if (!state.cloudReachable) {
    return { paused: false, reason: null };
  }

  if (state.cloudWorkspaceTeamId !== pollWorkspaceTeamId) {
    return { paused: false, reason: null };
  }

  if (state.cloudWorkspaceStatus !== 'connected') {
    return { paused: false, reason: null };
  }

  return { paused: true, reason: 'cloud-canonical' };
}
