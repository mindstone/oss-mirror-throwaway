import { useMemo, useSyncExternalStore } from 'react';
import type { ChatController, ChatControllerSnapshot } from './types';

const EMPTY_STREAMING = '';
const EMPTY_SNAPSHOT: ChatControllerSnapshot = {
  phase: 'hydrating',
  conversationId: null,
  conversationContext: {},
  messages: [],
  turnStatus: 'idle',
  error: null,
  retryableSend: null,
  creatingConversation: false,
  reconnectAttempt: 0,
};

const NOOP_ASYNC = async (): Promise<void> => undefined;

export function useChatController({ controller }: { controller: ChatController | null }) {
  const subscribe = useMemo(
    () => (listener: () => void) => controller?.subscribe(listener) ?? (() => undefined),
    [controller],
  );
  const subscribeStreaming = useMemo(
    () =>
      (listener: () => void) => controller?.subscribeStreamingText(listener) ?? (() => undefined),
    [controller],
  );
  const getSnapshot = useMemo(
    () => () => controller?.getSnapshot() ?? EMPTY_SNAPSHOT,
    [controller],
  );
  const getStreamingSnapshot = useMemo(
    () => () => controller?.getStreamingText() ?? EMPTY_STREAMING,
    [controller],
  );

  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const streamingText = useSyncExternalStore(
    subscribeStreaming,
    getStreamingSnapshot,
    getStreamingSnapshot,
  );

  return {
    snapshot,
    streamingText,
    send: controller?.send.bind(controller) ?? NOOP_ASYNC,
    startFresh: controller?.startFresh.bind(controller) ?? NOOP_ASYNC,
    openInRebel: controller?.openInRebel.bind(controller) ?? NOOP_ASYNC,
  };
}
