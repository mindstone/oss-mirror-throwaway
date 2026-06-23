// @vitest-environment happy-dom
import React, { act } from 'react';
import * as ReactDOMClient from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PluginContext } from '../PluginContext';
import { pluginEventBus } from '../pluginEventBus';
import { useRebelEvent } from '../useRebelEvent';
import type { RebelEventType } from '../types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let privateMode = false;
let sessionSummaries: Array<{ id: string; privateMode?: boolean }> = [];

vi.mock('@renderer/features/agent-session/store/sessionStore', () => ({
  getSessionStoreState: () => ({ privateMode, sessionSummaries }),
}));

type Mounted = {
  unmount: () => void;
};

const mounted: Mounted[] = [];

function Subscriber({
  eventType,
  onEvent,
}: {
  eventType: RebelEventType;
  onEvent: (payload: unknown) => void;
}) {
  useRebelEvent(eventType, onEvent);
  return null;
}

function mountSubscriber(
  pluginId: string,
  eventType: RebelEventType,
  onEvent: (payload: unknown) => void,
): Mounted {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = ReactDOMClient.createRoot(container);

  act(() => {
    root.render(
      <PluginContext.Provider value={{ pluginId }}>
        <Subscriber eventType={eventType} onEvent={onEvent} />
      </PluginContext.Provider>,
    );
  });

  const m: Mounted = {
    unmount: () => {
      act(() => { root.unmount(); });
      container.remove();
    },
  };
  mounted.push(m);
  return m;
}

beforeEach(() => {
  pluginEventBus.reset();
  pluginEventBus.initialize();
  privateMode = false;
  sessionSummaries = [
    { id: 'public-session', privateMode: false },
    { id: 'privacy-flip-session', privateMode: false },
  ];
});

afterEach(() => {
  while (mounted.length > 0) {
    mounted.pop()?.unmount();
  }
  pluginEventBus.reset();
  vi.restoreAllMocks();
});

describe('useRebelEvent replay-on-remount contract', () => {
  it('replays events missed after unmount while an always-mounted subscriber receives the live event once', () => {
    const replaySubscriber = vi.fn();
    const liveSubscriber = vi.fn();

    const hidden = mountSubscriber('hidden-plugin', 'conversation:created', replaySubscriber);
    hidden.unmount();
    mounted.pop();

    mountSubscriber('always-mounted-plugin', 'conversation:created', liveSubscriber);

    const payload = { sessionId: 'public-session', title: 'Replay contract' };
    act(() => {
      pluginEventBus.emit('conversation:created', payload, 'public-session');
    });

    expect(liveSubscriber).toHaveBeenCalledTimes(1);
    expect(liveSubscriber).toHaveBeenCalledWith(payload);
    expect(replaySubscriber).not.toHaveBeenCalled();

    mountSubscriber('hidden-plugin', 'conversation:created', replaySubscriber);

    expect(replaySubscriber).toHaveBeenCalledTimes(1);
    expect(replaySubscriber).toHaveBeenCalledWith(payload);
    expect(liveSubscriber).toHaveBeenCalledTimes(1);
  });

  it('reconstructs on remount by re-delivering an event the prior mount already consumed live', () => {
    // Regression for plugin-conversation-api.spec.ts:201 — the conversation:created
    // event is consumed LIVE during the first mount (advancing the cursor past it),
    // then the surface unmounts (losing event-derived useState). On remount, the
    // fresh component must re-receive the buffered event to rebuild its view, even
    // though gap-only (seq > cursor) replay would skip it.
    const subscriber = vi.fn();

    const first = mountSubscriber('reopen-plugin', 'conversation:created', subscriber);

    const payload = { sessionId: 'public-session', title: 'Consumed live' };
    act(() => {
      pluginEventBus.emit('conversation:created', payload, 'public-session');
    });

    // Live delivery during the first mount.
    expect(subscriber).toHaveBeenCalledTimes(1);
    expect(subscriber).toHaveBeenCalledWith(payload);

    first.unmount();
    mounted.pop();

    // Remount: the event was already consumed live, but reconstruct-on-reopen
    // must re-deliver it so the fresh component rebuilds its derived state.
    mountSubscriber('reopen-plugin', 'conversation:created', subscriber);

    expect(subscriber).toHaveBeenCalledTimes(2);
    expect(subscriber).toHaveBeenNthCalledWith(2, payload);
  });

  it('drops buffered privacy-guarded events on replay if the target session later becomes private', () => {
    const replaySubscriber = vi.fn();
    const hidden = mountSubscriber('privacy-plugin', 'turn:completed', replaySubscriber);
    hidden.unmount();
    mounted.pop();

    act(() => {
      pluginEventBus.emit(
        'turn:completed',
        {
          sessionId: 'privacy-flip-session',
          turnId: 'turn-1',
          assistantText: 'done',
          toolsUsed: [],
        },
        'privacy-flip-session',
      );
    });

    sessionSummaries = [
      { id: 'public-session', privateMode: false },
      { id: 'privacy-flip-session', privateMode: true },
    ];

    mountSubscriber('privacy-plugin', 'turn:completed', replaySubscriber);

    expect(replaySubscriber).not.toHaveBeenCalled();
  });
});
