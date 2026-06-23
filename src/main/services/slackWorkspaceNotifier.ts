import { getBroadcastService } from '@core/broadcastService';
import { logger } from '@core/logger';
import {
  SLACK_WORKSPACE_CHANGED_CHANNEL,
  SlackWorkspaceChangedSchema,
} from '@shared/ipc/channels/slack';

export function notifySlackWorkspaceConnected(teamId: string, teamName: string): boolean {
  const workspaceChanged = SlackWorkspaceChangedSchema.safeParse({
    teamId,
    teamName,
    status: 'connected',
    occurredAt: Date.now(),
  });
  if (!workspaceChanged.success) {
    logger.warn(
      { error: workspaceChanged.error.flatten(), teamId, teamName },
      'Slack workspace changed payload failed schema validation',
    );
    return false;
  }

  try {
    getBroadcastService().sendToAllWindows(
      SLACK_WORKSPACE_CHANGED_CHANNEL,
      workspaceChanged.data,
    );
    return true;
  } catch (broadcastError) {
    logger.warn(
      { err: broadcastError, teamId, teamName },
      'Failed to broadcast Slack workspace changed event',
    );
    return false;
  }
}
