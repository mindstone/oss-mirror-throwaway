import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { PendingNotificationClickIntent } from '@shared/ipc/channels/app';
import type { RendererLogPayload } from '@shared/types';
import { fireAndForget } from '@shared/utils/fireAndForget';

interface UseNotificationClickNavigationArgs {
  enabled: boolean;
  startupConversationRestoreSuppressedRef: RefObject<boolean>;
  openNotificationConversation: (sessionId: string) => void | Promise<void>;
  openNotificationFile: (filePath: string) => void | Promise<void>;
  emitLog: (payload: RendererLogPayload) => void;
  initialCheckTimeoutMs?: number;
}

interface UseNotificationClickNavigationResult {
  initialNotificationCheckComplete: boolean;
}

const DEFAULT_INITIAL_CHECK_TIMEOUT_MS = 3000;
const MAX_CONSUME_ITERATIONS = 5;

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useNotificationClickNavigation({
  enabled,
  startupConversationRestoreSuppressedRef,
  openNotificationConversation,
  openNotificationFile,
  emitLog,
  initialCheckTimeoutMs = DEFAULT_INITIAL_CHECK_TIMEOUT_MS,
}: UseNotificationClickNavigationArgs): UseNotificationClickNavigationResult {
  const [initialNotificationCheckComplete, setInitialNotificationCheckComplete] = useState(false);
  const inFlightPullRef = useRef<Promise<void> | null>(null);
  const rerunRequestedRef = useRef(false);
  const initialCheckTimedOutRef = useRef(false);
  const initialCheckCompleteRef = useRef(false);
  const mountedRef = useRef(false);
  const argsRef = useRef({
    startupConversationRestoreSuppressedRef,
    openNotificationConversation,
    openNotificationFile,
    emitLog,
  });

  argsRef.current = {
    startupConversationRestoreSuppressedRef,
    openNotificationConversation,
    openNotificationFile,
    emitLog,
  };

  const markInitialCheckComplete = useCallback(() => {
    if (initialCheckCompleteRef.current) {
      return;
    }
    initialCheckCompleteRef.current = true;
    if (mountedRef.current) {
      setInitialNotificationCheckComplete(true);
    }
  }, []);

  const logWarn = useCallback((message: string, context?: Record<string, unknown>) => {
    argsRef.current.emitLog({
      level: 'warn',
      message,
      context,
      timestamp: Date.now(),
    });
  }, []);

  const consumeOnce = useCallback(async (
    trigger: 'mount' | 'nudge' | 'queued-rerun',
  ): Promise<PendingNotificationClickIntent | null> => {
    try {
      const consumePendingNotificationClick = window.appApi?.consumePendingNotificationClick;
      if (typeof consumePendingNotificationClick !== 'function') {
        logWarn('Notification click consume channel is unavailable', { trigger });
        return null;
      }

      return await consumePendingNotificationClick();
    } catch (error) {
      logWarn('Notification click consume failed', {
        trigger,
        error: getErrorMessage(error),
      });
      return null;
    }
  }, [logWarn]);

  const routeIntent = useCallback(async (intent: PendingNotificationClickIntent): Promise<void> => {
    argsRef.current.startupConversationRestoreSuppressedRef.current = true;

    if (intent.filePath) {
      await argsRef.current.openNotificationFile(intent.filePath);
      return;
    }

    if (intent.sessionId) {
      await argsRef.current.openNotificationConversation(intent.sessionId);
    }
  }, []);

  const consumeAndRoute = useCallback((trigger: 'mount' | 'nudge'): Promise<void> => {
    if (inFlightPullRef.current) {
      rerunRequestedRef.current = true;
      return inFlightPullRef.current;
    }

    const isInitialCheck = trigger === 'mount' && !initialCheckCompleteRef.current;
    const promise = (async () => {
      let nextTrigger: 'mount' | 'nudge' | 'queued-rerun' = trigger;
      let iterations = 0;

      do {
        rerunRequestedRef.current = false;
        iterations += 1;
        const intent = await consumeOnce(nextTrigger);
        if (!intent) {
          nextTrigger = 'queued-rerun';
          continue;
        }

        // Deliberate late-intent semantics: the timeout only unblocks startup
        // restore. A slow IPC result still routes, accepting a bounded
        // restore-then-notification double navigation so the final surface is
        // the conversation or file the user clicked.
        if (isInitialCheck && initialCheckTimedOutRef.current) {
          logWarn('notification intent resolved after initial-check timeout; routing anyway', {
            timeoutMs: initialCheckTimeoutMs,
            intentAgeMs: Date.now() - intent.clickedAt,
          });
        }

        await routeIntent(intent);
        nextTrigger = 'queued-rerun';
      } while (rerunRequestedRef.current && iterations < MAX_CONSUME_ITERATIONS);

      if (rerunRequestedRef.current) {
        rerunRequestedRef.current = false;
        logWarn('Notification click consume rerun limit reached', {
          maxIterations: MAX_CONSUME_ITERATIONS,
        });
        // A nudge that lands during the final iteration must not strand its
        // intent in the main store until the next remount: schedule exactly
        // one deferred consume after this pull settles.
        setTimeout(() => void consumeAndRoute('nudge'), 0);
      }
    })().finally(() => {
      inFlightPullRef.current = null;
    });

    inFlightPullRef.current = promise;
    return promise;
  }, [consumeOnce, initialCheckTimeoutMs, logWarn, routeIntent]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!enabled) {
      return undefined;
    }

    const timeoutId = window.setTimeout(() => {
      if (!initialCheckCompleteRef.current) {
        initialCheckTimedOutRef.current = true;
        logWarn('Initial notification click consume timed out', {
          timeoutMs: initialCheckTimeoutMs,
        });
        markInitialCheckComplete();
      }
    }, initialCheckTimeoutMs);

    fireAndForget(
      consumeAndRoute('mount').finally(() => {
        window.clearTimeout(timeoutId);
        markInitialCheckComplete();
      }),
      'initialNotificationClickConsume',
    );

    const unsubscribe = window.api.onNotificationClicked?.(() => {
      fireAndForget(consumeAndRoute('nudge'), 'notificationClickNudgeConsume');
    });

    return () => {
      window.clearTimeout(timeoutId);
      unsubscribe?.();
    };
  }, [consumeAndRoute, enabled, initialCheckTimeoutMs, logWarn, markInitialCheckComplete]);

  return { initialNotificationCheckComplete };
}
