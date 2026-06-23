// mobile/src/hooks/useRoutingQueueConsumer.ts

/**
 * Routing queue consumer — dispatches queue items to the appropriate
 * consumer based on item type.
 *
 * This replaces the inline switch in _layout.tsx to support the new
 * 'meeting-recording' item type alongside existing voice and text consumers.
 */

import type { QueueItem, QueueConsumerResult } from '@rebel/cloud-client';
import { createVoiceQueueConsumer } from './useVoiceQueueConsumer';
import { createTextQueueConsumer } from './useTextQueueConsumer';
import { createTextAttachmentsQueueConsumer } from './useTextAttachmentsQueueConsumer';
import { createMeetingRecordingConsumer } from './useMeetingRecordingConsumer';
import { createMeetingChunkConsumer } from './useMeetingChunkConsumer';
import { createFeedbackQueueConsumer } from './useFeedbackQueueConsumer';

/**
 * Creates a routing consumer that dispatches to the correct consumer
 * based on `item.type`. This is NOT a React hook — it returns a plain
 * async function suitable for `initOfflineQueueStore`.
 */
export function createRoutingConsumer(): (
  item: QueueItem,
  payloadUri: string | null,
  signal?: AbortSignal,
) => Promise<QueueConsumerResult> {
  const voiceConsumer = createVoiceQueueConsumer();
  const textConsumer = createTextQueueConsumer();
  const textAttachmentsConsumer = createTextAttachmentsQueueConsumer();
  const meetingConsumer = createMeetingRecordingConsumer();
  const meetingChunkConsumer = createMeetingChunkConsumer();
  const feedbackConsumer = createFeedbackQueueConsumer();

  return async (item: QueueItem, payloadUri: string | null, signal?: AbortSignal): Promise<QueueConsumerResult> => {
    switch (item.type) {
      case 'voice-transcription':
        return voiceConsumer(item, payloadUri, signal);
      case 'text-message':
        return textConsumer(item, payloadUri, signal);
      case 'text-with-attachments':
        return textAttachmentsConsumer(item, payloadUri, signal);
      case 'meeting-recording':
        return meetingConsumer(item, payloadUri, signal);
      case 'meeting-chunk':
        return meetingChunkConsumer(item, payloadUri, signal);
      case 'feedback':
        return feedbackConsumer(item, payloadUri, signal);
      default: {
        const unhandledType: never = item.type;
        return {
          success: false,
          error: `Unhandled queue item type: ${String(unhandledType)}`,
          errorCategory: 'permanent',
        };
      }
    }
  };
}
