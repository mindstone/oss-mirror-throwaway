import type { QueueItem, QueueConsumerResult } from '@rebel/cloud-client';
import {
  type QueueCompletionEvent,
  type QueueConsumerMetadataBase,
  createQueueConsumer,
} from './useQueueConsumer';

/** Metadata shape for text-message queue items. */
export interface TextQueueMetadata extends QueueConsumerMetadataBase {
  prompt: string;
}

export type TextQueueCompletionEvent = QueueCompletionEvent;

export type TextQueueCompletionListener = (event: TextQueueCompletionEvent) => void;

let _completionListener: TextQueueCompletionListener | null = null;

export function setTextQueueCompletionListener(listener: TextQueueCompletionListener): void {
  _completionListener = listener;
}

export function clearTextQueueCompletionListener(): void {
  _completionListener = null;
}

function notifyTextQueueCompletion(event: TextQueueCompletionEvent): void {
  try {
    _completionListener?.(event);
  } catch {
    // Non-critical: never fail queue completion due to listener errors.
  }
}

export function createTextQueueConsumer(): (
  item: QueueItem,
  payloadUri: string | null,
  signal?: AbortSignal,
) => Promise<QueueConsumerResult> {
  return createQueueConsumer<TextQueueMetadata>({
    loggerName: 'textQueueConsumer',
    sourceLabel: 'text message',
    sourcePresentParticiple: 'Text queue item',
    getAttemptLogData: ({ payloadUri }) => ({
      hasPayload: Boolean(payloadUri),
    }),
    buildTurnInput: ({ metadata }) => {
      const prompt = metadata.prompt?.trim() ?? '';
      if (!prompt) {
        return {
          success: false,
          error: 'Prompt is empty',
          errorCategory: 'permanent',
        };
      }
      return { prompt };
    },
    onCompletion: notifyTextQueueCompletion,
  });
}
