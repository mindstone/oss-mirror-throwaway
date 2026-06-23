// @vitest-environment happy-dom
import React, { act, useEffect } from 'react';
import * as ReactDOMClient from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FlowPanelsProvider, FLOW_PANELS_STORAGE_KEY, type FlowSurface } from '../FlowPanelsProvider';
import { FlowPanelsShell } from '../FlowPanelsShell';
import {
  clearCurrentSessionEvents,
  useSessionStore,
} from '@renderer/features/agent-session/store/sessionStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Mounted = {
  unmount: () => void;
};

const mounted: Mounted[] = [];

function Probe({ id, events }: { id: string; events: string[] }) {
  useEffect(() => {
    events.push(`${id}:mount`);
    return () => {
      events.push(`${id}:unmount`);
    };
  }, [events, id]);

  return <div data-testid={`${id}-content`}>{id}</div>;
}

function renderShell(events: string[]): Mounted {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = ReactDOMClient.createRoot(container);
  const pluginSurface = 'plugin:contract' as FlowSurface;

  act(() => {
    root.render(
      <FlowPanelsProvider>
        <FlowPanelsShell
          brand={null}
          sidebar={null}
          surfaceTabs={[
            { id: 'home', label: 'Home' },
            { id: 'sessions', label: 'Conversations' },
            { id: pluginSurface, label: 'Contract Plugin' },
          ]}
          surfaces={{
            home: { content: <div data-testid="home-content">home</div> },
            sessions: { content: <Probe id="sessions" events={events} /> },
            [pluginSurface]: { content: <Probe id="plugin" events={events} /> },
          }}
          showConversation={false}
        />
      </FlowPanelsProvider>,
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
  Object.assign(window as unknown as Record<string, unknown>, {
    sessionsApi: {
      get: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
    },
    agentApi: {
      stopTurn: vi.fn().mockResolvedValue(undefined),
    },
  });

  window.localStorage.setItem(
    FLOW_PANELS_STORAGE_KEY,
    JSON.stringify({ history: false, surface: 'home' }),
  );

  act(() => {
    clearCurrentSessionEvents();
    useSessionStore.setState({
      isBusy: false,
      activeTurnId: null,
      sessionSummaries: [],
    });
  });
});

afterEach(() => {
  while (mounted.length > 0) {
    mounted.pop()?.unmount();
  }
  window.localStorage.removeItem(FLOW_PANELS_STORAGE_KEY);
  clearCurrentSessionEvents();
  vi.restoreAllMocks();
});

describe('FlowPanelsShell mount contract', () => {
  it('unmounts inactive non-session surface content while keeping sessions mounted', () => {
    const events: string[] = [];
    renderShell(events);

    expect(document.querySelector('[data-testid="home-content"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="sessions-content"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="plugin-content"]')).toBeNull();
    expect(events).toEqual(['sessions:mount']);

    const pluginTab = document.querySelector('button[data-flow-tab-id="plugin:contract"]');
    expect(pluginTab).toBeInstanceOf(HTMLButtonElement);

    act(() => {
      pluginTab?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(document.querySelector('[data-testid="home-content"]')).toBeNull();
    expect(document.querySelector('[data-testid="sessions-content"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="plugin-content"]')).not.toBeNull();
    expect(events).toEqual(['sessions:mount', 'plugin:mount']);

    const homeTab = document.querySelector('button[data-flow-tab-id="home"]');
    expect(homeTab).toBeInstanceOf(HTMLButtonElement);

    act(() => {
      homeTab?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(document.querySelector('[data-testid="home-content"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="sessions-content"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="plugin-content"]')).toBeNull();
    expect(events).toEqual(['sessions:mount', 'plugin:mount', 'plugin:unmount']);
  });
});
