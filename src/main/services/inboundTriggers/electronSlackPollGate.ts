import type { AppSettings } from '@shared/types';
import {
  evaluatePollGate,
  type SlackPollGate,
  type SlackPollGateState,
} from '@shared/utils/slackPollGate';

function normalizeCloudWorkspaceStatus(
  status: NonNullable<NonNullable<AppSettings['experimental']>['cloudSlackWorkspace']>['status'] | undefined,
): SlackPollGateState['cloudWorkspaceStatus'] {
  switch (status) {
    case 'connected':
      return 'connected';
    case 'needs_reconnect':
      return 'needs_reconnect';
    case 'disconnected':
      return 'disconnected';
    case 'disconnecting':
      return 'disconnected';
    case undefined:
      return null;
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

export class ElectronSlackPollGate implements SlackPollGate {
  constructor(
    private readonly getSettings: () => AppSettings,
    private readonly getCloudReachable: () => boolean,
  ) {}

  shouldPause(workspaceTeamId: string): { paused: boolean; reason: string | null } {
    const settings = this.getSettings();
    const cloudWorkspace = settings.experimental?.cloudSlackWorkspace;
    return evaluatePollGate({
      cloudFlagEnabled: settings.experimental?.slackCloudWebhookEnabled === true,
      cloudWorkspaceTeamId: cloudWorkspace?.teamId ?? null,
      cloudWorkspaceStatus: normalizeCloudWorkspaceStatus(cloudWorkspace?.status),
      cloudReachable: this.getCloudReachable(),
    }, workspaceTeamId);
  }
}
