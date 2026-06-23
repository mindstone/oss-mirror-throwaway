// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectorStatusChangedPayload } from '@shared/ipc/channels/appBridge';
import type { EmitLogFn, ShowToastFn } from '@renderer/contexts';
import { useConnectorStatusWatcher } from '../useConnectorStatusWatcher';
import { useSessionStore } from '../../store';
import {
  getCurrentSessionEvents,
  getCurrentSessionEventsForTurn,
} from '../../store/sessionStore';
import type { AgentEvent } from '@shared/types';
import type { RetryConfigureWithRebelFn } from '../connectorStatusEffects';

function WatcherHarness(props: {
  retryConfigureWithRebel: RetryConfigureWithRebelFn;
  showToast: ShowToastFn;
  emitLog: EmitLogFn;
}) {
  useConnectorStatusWatcher(props);
  return null;
}

function createConnectorStatusEmitter() {
  let callback: ((payload: ConnectorStatusChangedPayload) => void) | null = null;

  return {
    subscriptions: {
      onConnectorStatusChanged(next: (payload: ConnectorStatusChangedPayload) => void) {
        callback = next;
        return () => {
          if (callback === next) {
            callback = null;
          }
        };
      },
    },
    fire(payload: ConnectorStatusChangedPayload) {
      callback?.(payload);
    },
  };
}

let idCounter = 0;

const nextId = (prefix: string): string => {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
};

const seedPairingTurn = (pairSessionId: string): string => {
  const turnId = nextId('turn');
  const store = useSessionStore.getState();
  const timestamp = Date.now();
  act(() => {
    store.processEvent(turnId, {
      type: 'tool',
      stage: 'end',
      toolName: 'rebel_bridge_prepare_install',
      toolUseId: nextId('tool'),
      detail: JSON.stringify({
        ok: true,
        data: { setupStatus: 'awaiting_user_handoff', installSessionAlias: pairSessionId },
      }),
      isError: false,
      timestamp,
    } satisfies AgentEvent);
    store.processEvent(turnId, {
      type: 'result',
      text: 'Install instructions sent.',
      timestamp: timestamp + 1,
    } satisfies AgentEvent);
  });
  return turnId;
};

async function mountWatcher(props: {
  retryConfigureWithRebel?: ReturnType<typeof vi.fn<RetryConfigureWithRebelFn>>;
  showToast?: ReturnType<typeof vi.fn<ShowToastFn>>;
  emitLog?: ReturnType<typeof vi.fn<EmitLogFn>>;
}): Promise<{
  root: Root;
  showToast: ReturnType<typeof vi.fn<ShowToastFn>>;
  emitLog: ReturnType<typeof vi.fn<EmitLogFn>>;
  retryConfigureWithRebel: ReturnType<typeof vi.fn<RetryConfigureWithRebelFn>>;
}> {
  const container = document.createElement('div');
  const root = createRoot(container);
  const showToast = props.showToast ?? vi.fn<ShowToastFn>();
  const emitLog = props.emitLog ?? vi.fn<EmitLogFn>();
  const retryConfigureWithRebel =
    props.retryConfigureWithRebel ??
    vi.fn<RetryConfigureWithRebelFn>().mockResolvedValue(undefined);

  await act(async () => {
    root.render(
      createElement(WatcherHarness, {
        retryConfigureWithRebel,
        showToast,
        emitLog,
      }),
    );
  });

  return { root, showToast, emitLog, retryConfigureWithRebel };
}

beforeEach(() => {
  vi.clearAllMocks();
  idCounter = 0;
  // @ts-expect-error vitest act env flag
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;

  (window as typeof window & { sessionsApi: Window['sessionsApi'] }).sessionsApi = {
    get: vi.fn().mockResolvedValue(null),
    upsert: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue([]),
  } as unknown as Window['sessionsApi'];
  (window as typeof window & { agentApi: Window['agentApi'] }).agentApi = {
    stopTurn: vi.fn().mockResolvedValue(undefined),
  } as unknown as Window['agentApi'];
  Reflect.deleteProperty(
    window as unknown as Record<string, unknown>,
    'appBridgeSubscriptions',
  );
  Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'appBridgeApi');

  act(() => {
    useSessionStore.getState().resetSession();
  });
});

describe('useConnectorStatusWatcher', () => {
  it('appends a connected status event to the active session and dedups repeats', async () => {
    const emitter = createConnectorStatusEmitter();
    (
      window as typeof window & {
        appBridgeSubscriptions: { onConnectorStatusChanged: typeof emitter.subscriptions.onConnectorStatusChanged };
      }
    ).appBridgeSubscriptions = emitter.subscriptions;

    const pairSessionId = nextId('pair');
    const turnId = seedPairingTurn(pairSessionId);

    act(() => {
      useSessionStore.getState().setSetupContext({
        kind: 'bundled-app-bridge',
        pairSessionId,
      });
    });

    const { root } = await mountWatcher({});
    const payload: ConnectorStatusChangedPayload = {
      connectorId: 'bundled-app-bridge',
      status: 'connected',
      pairSessionId,
      emittedAt: 1,
      eventId: `${pairSessionId}:1:connected`,
    };

    await act(async () => {
      emitter.fire(payload);
    });

    const firstPassStatusEvents = getCurrentSessionEventsForTurn(turnId).filter(
      (event) => event.type === 'status',
    );
    expect(firstPassStatusEvents).toHaveLength(1);
    expect(firstPassStatusEvents[0]).toMatchObject({
      type: 'status',
      message:
        'Rebel Browser is connected. You can now ask me to summarise a page, fill a form, extract details, or compare tabs.',
    });
    expect(useSessionStore.getState().currentSessionSetupContext).toBeNull();

    await act(async () => {
      emitter.fire(payload);
    });

    const secondPassStatusEvents = getCurrentSessionEventsForTurn(turnId).filter(
      (event) => event.type === 'status',
    );
    expect(secondPassStatusEvents).toHaveLength(1);

    await act(async () => {
      root.unmount();
    });
  });

  it('stores pendingAnnouncement on a background session without touching the active session', async () => {
    const emitter = createConnectorStatusEmitter();
    (
      window as typeof window & {
        appBridgeSubscriptions: { onConnectorStatusChanged: typeof emitter.subscriptions.onConnectorStatusChanged };
      }
    ).appBridgeSubscriptions = emitter.subscriptions;

    const activeStore = useSessionStore.getState();
    const backgroundSessionId = nextId('background-session');
    const pairSessionId = nextId('pair');

    act(() => {
      activeStore.createBackgroundSession(backgroundSessionId);
      activeStore.setSetupContextForSession(backgroundSessionId, {
        kind: 'bundled-app-bridge',
        pairSessionId,
      });
    });

    const { root } = await mountWatcher({});

    await act(async () => {
      emitter.fire({
        connectorId: 'bundled-app-bridge',
        status: 'connected',
        pairSessionId,
        emittedAt: 55,
        eventId: `${pairSessionId}:55:connected`,
      });
      await Promise.resolve();
    });

    expect(useSessionStore.getState().currentSessionSetupContext).toBeNull();
    expect(useSessionStore.getState().loadedSessions.get(backgroundSessionId)?.setupContext)
      .toEqual({
        kind: 'bundled-app-bridge',
        pairSessionId,
        pendingAnnouncement: {
          status: 'connected',
          emittedAt: 55,
        },
      });

    await act(async () => {
      root.unmount();
    });
  });

  it('shows the retry toast for an expired active-session pairing event', async () => {
    const emitter = createConnectorStatusEmitter();
    (
      window as typeof window & {
        appBridgeSubscriptions: { onConnectorStatusChanged: typeof emitter.subscriptions.onConnectorStatusChanged };
      }
    ).appBridgeSubscriptions = emitter.subscriptions;

    const pairSessionId = nextId('pair');
    seedPairingTurn(pairSessionId);
    act(() => {
      useSessionStore.getState().setSetupContext({
        kind: 'bundled-app-bridge',
        pairSessionId,
      });
    });

    const { root, showToast, retryConfigureWithRebel } = await mountWatcher({});

    await act(async () => {
      emitter.fire({
        connectorId: 'bundled-app-bridge',
        status: 'expired',
        pairSessionId,
        emittedAt: 5,
        eventId: `${pairSessionId}:5:expired`,
      });
    });

    expect(showToast).toHaveBeenCalledOnce();
    expect(showToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Install window closed',
        description: 'That install window expired. Want to try again?',
        action: expect.objectContaining({
          label: 'Try again',
          onClick: expect.any(Function),
        }),
      }),
    );

    const toastPayload = showToast.mock.calls[0]?.[0];
    expect(toastPayload?.action).toBeTruthy();

    await act(async () => {
      (toastPayload?.action as { label: string; onClick: () => void }).onClick();
      await Promise.resolve();
    });
    expect(retryConfigureWithRebel).toHaveBeenCalledOnce();

    await act(async () => {
      root.unmount();
    });
  });

  it('clears setupContext and shows the retry toast even when no pairing turn is resolvable (F1)', async () => {
    const emitter = createConnectorStatusEmitter();
    (
      window as typeof window & {
        appBridgeSubscriptions: { onConnectorStatusChanged: typeof emitter.subscriptions.onConnectorStatusChanged };
      }
    ).appBridgeSubscriptions = emitter.subscriptions;

    const pairSessionId = nextId('pair');
    // Intentionally do NOT seed a pairing turn — this exercises the
    // reconcile-after-compaction / malformed-session path where
    // resolveAnnouncementTurnId returns null. Plan invariant F9 requires
    // setupContext to clear and the retry toast to fire regardless.
    act(() => {
      useSessionStore.getState().setSetupContext({
        kind: 'bundled-app-bridge',
        pairSessionId,
      });
    });

    const { root, showToast, emitLog } = await mountWatcher({});

    await act(async () => {
      emitter.fire({
        connectorId: 'bundled-app-bridge',
        status: 'expired',
        pairSessionId,
        emittedAt: 42,
        eventId: `${pairSessionId}:42:expired`,
      });
    });

    // Inline status event is skipped (no turn), but:
    expect(useSessionStore.getState().currentSessionSetupContext).toBeNull();
    expect(showToast).toHaveBeenCalledOnce();
    expect(showToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Install window closed',
      }),
    );
    // The skipped inline announcement is logged observably (not silent).
    expect(emitLog).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'warn',
        message: expect.stringContaining('skipping inline announcement'),
      }),
    );

    await act(async () => {
      root.unmount();
    });
  });

  it('ignores unmatched pairSessionId payloads', async () => {
    const emitter = createConnectorStatusEmitter();
    (
      window as typeof window & {
        appBridgeSubscriptions: { onConnectorStatusChanged: typeof emitter.subscriptions.onConnectorStatusChanged };
      }
    ).appBridgeSubscriptions = emitter.subscriptions;

    const { root, showToast } = await mountWatcher({});
    const eventCountBefore = Object.values(getCurrentSessionEvents()).flat().length;

    await act(async () => {
      emitter.fire({
        connectorId: 'bundled-app-bridge',
        status: 'connected',
        pairSessionId: nextId('unknown-pair'),
        emittedAt: 99,
        eventId: nextId('event'),
      });
    });

    expect(Object.values(getCurrentSessionEvents()).flat()).toHaveLength(eventCountBefore);
    expect(showToast).not.toHaveBeenCalled();
    expect(useSessionStore.getState().currentSessionSetupContext).toBeNull();

    await act(async () => {
      root.unmount();
    });
  });
});
