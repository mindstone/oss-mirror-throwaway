/**
 * Queue consumer for text-with-attachments items.
 * Loads persisted attachment JSON payload and submits via shared queue logic.
 */

import {
  useOfflineQueueStore,
} from '@rebel/cloud-client';
import type {
  QueueItem,
  QueueConsumerResult,
  WebFileAttachment,
} from '@rebel/cloud-client';
import {
  createQueueConsumer,
  type QueueCompletionEvent,
  type QueueConsumerMetadataBase,
} from './useQueueConsumer';

/** Metadata shape for text-with-attachments queue items. */
export interface TextAttachmentsQueueMetadata extends QueueConsumerMetadataBase {
  prompt: string;
  attachmentCount: number; // For logging/debugging only
}

/** JSON payload shape persisted alongside the queue item. */
export interface TextAttachmentsQueueJsonPayload {
  prompt: string;
  attachments: WebFileAttachment[];
}

export type TextAttachmentsQueueCompletionEvent = QueueCompletionEvent;

export type TextAttachmentsQueueCompletionListener = (event: TextAttachmentsQueueCompletionEvent) => void;

let _completionListener: TextAttachmentsQueueCompletionListener | null = null;

export function setTextAttachmentsQueueCompletionListener(listener: TextAttachmentsQueueCompletionListener): void {
  _completionListener = listener;
}

export function clearTextAttachmentsQueueCompletionListener(): void {
  _completionListener = null;
}

function notifyTextAttachmentsQueueCompletion(event: TextAttachmentsQueueCompletionEvent): void {
  try {
    _completionListener?.(event);
  } catch {
    // Non-critical: never fail queue completion due to listener errors.
  }
}

/**
 * Creates the text-with-attachments queue consumer callback.
 * Loads persisted attachment JSON, then submits via shared queue logic.
 */
export function createTextAttachmentsQueueConsumer(): (
  item: QueueItem,
  payloadUri: string | null,
  signal?: AbortSignal,
) => Promise<QueueConsumerResult> {
  return createQueueConsumer<
    TextAttachmentsQueueMetadata,
    TextAttachmentsQueueJsonPayload
  >({
    loggerName: 'textAttachmentsQueueConsumer',
    sourceLabel: 'text-with-attachments',
    sourcePresentParticiple: 'Text-with-attachments queue item',
    getAttemptLogData: ({ metadata }) => ({
      attachmentCount: metadata.attachmentCount,
    }),
    prepare: async ({ item, signal }) => {
      const payload = await useOfflineQueueStore
        .getState()
        .loadJsonPayload<TextAttachmentsQueueJsonPayload>(item.id);

      if (!payload) {
        return {
          success: false,
          error: 'Attachment payload missing',
          errorCategory: 'permanent',
        };
      }

      if (signal?.aborted) {
        return { success: false, error: 'Aborted', errorCategory: 'timeout' };
      }

      const prompt = payload.prompt?.trim() ?? '';
      if (!prompt) {
        return {
          success: false,
          error: 'Prompt is empty',
          errorCategory: 'permanent',
        };
      }

      return {
        prompt,
        attachments: Array.isArray(payload.attachments) ? payload.attachments : [],
      };
    },
    buildTurnInput: ({ prepared }) => ({
      prompt: prepared.prompt,
      attachments: prepared.attachments,
    }),
    getSuccessLogData: ({ turnInput }) => ({
      attachmentCount: turnInput.attachments?.length ?? 0,
    }),
    onCompletion: notifyTextAttachmentsQueueCompletion,
  });
}
