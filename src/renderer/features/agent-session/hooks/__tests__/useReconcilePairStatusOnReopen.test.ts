// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmitLogFn, ShowToastFn } from '@renderer/contexts';
import { useReconcilePairStatusOnReopen } from '../useReconcilePairStatusOnReopen';
import { useSessionStore } from '../../store';
import { getCurrentSessionEventsForTurn } from '../../store/sessionStore';
import type { AgentEvent } from '@shared/types';
import type { RetryConfigureWithRebelFn } from '../connectorStatusEffects';

function ReconcileHarness(props: {
  retryConfigureWithRebel: RetryConfigureWithRebelFn;
  showToast: ShowToastFn;
  emitLog: EmitLogFn;
}) {
  useReconcilePairStatusOnReopen(props);
  return null;
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

async function mountReconcileHook(props?: {
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
  const showToast = props?.showToast ?? vi.fn<ShowToastFn>();
  const emitLog = props?.emitLog ?? vi.fn<EmitLogFn>();
  const retryConfigureWithRebel =
    props?.retryConfigureWithRebel ??
    vi.fn<RetryConfigureWithRebelFn>().mockResolvedValue(undefined);

  await act(async () => {
    root.render(
      createElement(ReconcileHarness, {
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
  (window as typeof window & { appBridgeApi: Window['appBridgeApi'] }).appBridgeApi = {
    checkPairStatus: vi.fn().mockResolvedValue({
      paired: [],
      hasPending: false,
      activeSessionCount: 0,
    }),
  } as unknown as Window['appBridgeApi'];

  act(() => {
    useSessionStore.getState().resetSession();
  });
});

describe('useReconcilePairStatusOnReopen', () => {
  it('materialises a pending connected announcement and clears setupContext', async () => {
    const pairSessionId = nextId('pair');
    const turnId = seedPairingTurn(pairSessionId);

    act(() => {
      useSessionStore.getState().setSetupContext({
        kind: 'bundled-app-bridge',
        pairSessionId,
        pendingAnnouncement: {
          status: 'connected',
          emittedAt: 123,
        },
      });
    });

    const { root } = await mountReconcileHook();

    const statusEvents = getCurrentSessionEventsForTurn(turnId).filter(
      (event) => event.type === 'status',
    );
    expect(statusEvents).toHaveLength(1);
    expect(statusEvents[0]).toMatchObject({
      type: 'status',
      message:
        'Rebel Browser is connected. You can now ask me to summarise a page, fill a form, extract details, or compare tabs.',
    });
    expect(useSessionStore.getState().currentSessionSetupContext).toBeNull();

    await act(async () => {
      root.unmount();
    });
  });

  it('announces success when checkPairStatus reports paired clients', async () => {
    const pairSessionId = nextId('pair');
    const turnId = seedPairingTurn(pairSessionId);
    const checkPairStatus = vi.fn().mockResolvedValue({
      paired: [{ appId: 'browser-extension', clientId: nextId('client') }],
      hasPending: false,
      activeSessionCount: 0,
    });
    (window as typeof window & { appBridgeApi: Window['appBridgeApi'] }).appBridgeApi = {
      checkPairStatus,
    } as unknown as Window['appBridgeApi'];

    act(() => {
      useSessionStore.getState().setSetupContext({
        kind: 'bundled-app-bridge',
        pairSessionId,
      });
    });

    const { root } = await mountReconcileHook();

    expect(checkPairStatus).toHaveBeenCalledWith({ pairSessionId });
    const statusEvents = getCurrentSessionEventsForTurn(turnId).filter(
      (event) => event.type === 'status',
    );
    expect(statusEvents).toHaveLength(1);
    expect(useSessionStore.getState().currentSessionSetupContext).toBeNull();

    await act(async () => {
      root.unmount();
    });
  });

  it('silently clears stale setupContext when the pair session expired', async () => {
    const pairSessionId = nextId('pair');
    const checkPairStatus = vi.fn().mockResolvedValue({
      paired: [],
      hasPending: false,
      activeSessionCount: 0,
      pairSessionExpired: true,
    });
    (window as typeof window & { appBridgeApi: Window['appBridgeApi'] }).appBridgeApi = {
      checkPairStatus,
    } as unknown as Window['appBridgeApi'];

    act(() => {
      useSessionStore.getState().setSetupContext({
        kind: 'bundled-app-bridge',
        pairSessionId,
      });
    });

    const { root, showToast } = await mountReconcileHook();

    expect(checkPairStatus).toHaveBeenCalledWith({ pairSessionId });
    expect(showToast).not.toHaveBeenCalled();
    expect(useSessionStore.getState().currentSessionSetupContext).toBeNull();

    await act(async () => {
      root.unmount();
    });
  });

  it('keeps setupContext intact and logs when checkPairStatus throws', async () => {
    const pairSessionId = nextId('pair');
    const checkPairStatus = vi
      .fn()
      .mockRejectedValue(new Error('bridge temporarily unavailable'));
    (window as typeof window & { appBridgeApi: Window['appBridgeApi'] }).appBridgeApi = {
      checkPairStatus,
    } as unknown as Window['appBridgeApi'];

    act(() => {
      useSessionStore.getState().setSetupContext({
        kind: 'bundled-app-bridge',
        pairSessionId,
      });
    });

    const { root, emitLog } = await mountReconcileHook();

    expect(checkPairStatus).toHaveBeenCalledWith({ pairSessionId });
    expect(useSessionStore.getState().currentSessionSetupContext).toEqual({
      kind: 'bundled-app-bridge',
      pairSessionId,
    });
    expect(emitLog).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'warn',
        message: 'Failed to reconcile pair status on session reopen',
        context: expect.objectContaining({
          pairSessionId,
          sessionId: useSessionStore.getState().currentSessionId,
        }),
      }),
    );

    await act(async () => {
      root.unmount();
    });
  });
});
