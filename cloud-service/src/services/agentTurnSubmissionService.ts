// SHIM-RETAINED: Cloud routes/bootstrap still rely on this compatibility module for environment wiring.
/**
 * @deprecated Canonical implementation moved to @core/services/agentTurnSubmissionService.
 * This cloud file remains as a compatibility shim + cloud wiring.
 */

import {
  setPushNotificationSinkFactory,
  type PushNotificationPayload,
  type PushNotificationSink,
} from '@core/pushNotificationSink';
import {
  setAgentTurnSubmissionEnvironment,
  type BuildMeetingTranscriptContextArgs,
  type TranscriptContextResult,
} from '@core/services/agentTurnSubmissionService';
import { cloudEventBroadcaster } from '../cloudEventBroadcaster';
import { buildMeetingTranscriptContext } from './meetingTranscriptContext';
import { sendPushNotification } from './pushNotificationService';

export class CloudPushNotificationSink implements PushNotificationSink {
  canSendPushNotifications(): boolean {
    return true;
  }

  async sendPushNotification(
    _userId: string | null,
    payload: PushNotificationPayload,
  ): Promise<void> {
    await sendPushNotification(payload);
  }
}

setPushNotificationSinkFactory(() => new CloudPushNotificationSink());
setAgentTurnSubmissionEnvironment({
  eventWindow: cloudEventBroadcaster.virtualWindow,
  getConnectedClientCount: () => cloudEventBroadcaster.clientCount,
  buildMeetingTranscriptContext: (
    args: BuildMeetingTranscriptContextArgs,
  ): TranscriptContextResult | null => buildMeetingTranscriptContext(args),
});

export * from '@core/services/agentTurnSubmissionService';
