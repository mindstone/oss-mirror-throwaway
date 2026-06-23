// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TurnAuthLabel } from '@shared/agentEvents';
import { useSessionStore } from '@renderer/features/agent-session/store/sessionStore';
import { RouteStatusLine } from '../RouteStatusLine';
import { useRouteLabelCacheStore } from '../../store/routeLabelCacheStore';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Mounted {
  container: HTMLDivElement;
  unmount: () => void;
}

function mount(ui: React.ReactElement): Mounted {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => {
    root.render(ui);
  });
  return {
    container,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

const COPY_BY_LABEL: Record<TurnAuthLabel, string> = {
  'codex-subscription': 'Routed via: your ChatGPT Pro subscription',
  openrouter: 'Routed via: your OpenRouter credits',
  mindstone: 'Routed via: your Mindstone subscription',
  'api-key': 'Routed via: your Anthropic API key (pay-per-use)',
  'oauth-token': 'Routed via: your Anthropic OAuth session',
  local: 'Routed via: your local model',
  'profile-direct': 'Routed via: your profile',
};

const SESSION_ID = 'session-route-status';

describe('RouteStatusLine', () => {
  const mounted: Mounted[] = [];

  beforeEach(() => {
    useRouteLabelCacheStore.getState().clearAll();
    useSessionStore.getState().setCurrentSessionMeta({
      currentSessionId: SESSION_ID,
    });
  });

  afterEach(() => {
    for (const view of mounted) {
      view.unmount();
    }
    mounted.length = 0;
    document.body.innerHTML = '';
  });

  it('renders nothing when no route label has been observed yet (pre-first-turn)', () => {
    const view = mount(<RouteStatusLine />);
    mounted.push(view);

    expect(
      view.container.querySelector('[data-testid="settings-models-route-status-line"]'),
    ).toBeNull();
  });

  for (const [label, expectedText] of Object.entries(COPY_BY_LABEL) as Array<
    [TurnAuthLabel, string]
  >) {
    it(`renders locked copy for "${label}"`, () => {
      useRouteLabelCacheStore.getState().set({
        sessionId: SESSION_ID,
        turnAuthLabel: label,
        observedAt: Date.now(),
      });

      const view = mount(<RouteStatusLine hasAnthropicAuth />);
      mounted.push(view);

      expect(view.container.textContent).toContain(expectedText);
    });
  }

  it('interpolates the profile name when label is "profile-direct"', () => {
    useRouteLabelCacheStore.getState().set({
      sessionId: SESSION_ID,
      turnAuthLabel: 'profile-direct',
      observedAt: Date.now(),
      profileName: 'My Custom Mistral',
    });

    const view = mount(<RouteStatusLine />);
    mounted.push(view);

    expect(view.container.textContent).toContain(
      'Routed via: your My Custom Mistral profile',
    );
  });

  it('renders Checking… while a turn is in flight', () => {
    useRouteLabelCacheStore.getState().setInflight(SESSION_ID);

    const view = mount(<RouteStatusLine />);
    mounted.push(view);

    const node = view.container.querySelector(
      '[data-testid="settings-models-route-status-line"]',
    );
    expect(node?.getAttribute('data-state')).toBe('checking');
    expect(node?.textContent).toContain('Checking route…');
  });

  it('clears the in-flight state once the route plan resolves', () => {
    useRouteLabelCacheStore.getState().setInflight(SESSION_ID);
    useRouteLabelCacheStore.getState().set({
      sessionId: SESSION_ID,
      turnAuthLabel: 'api-key',
      observedAt: Date.now(),
    });

    const view = mount(<RouteStatusLine hasAnthropicAuth />);
    mounted.push(view);

    const node = view.container.querySelector(
      '[data-testid="settings-models-route-status-line"]',
    );
    expect(node?.getAttribute('data-state')).toBe('resolved');
  });

  it('shows reconnect CTA when cached label is codex-subscription but auth is broken', () => {
    useRouteLabelCacheStore.getState().set({
      sessionId: SESSION_ID,
      turnAuthLabel: 'codex-subscription',
      observedAt: Date.now(),
    });
    const onReconnect = vi.fn();

    const view = mount(
      <RouteStatusLine
        codexConnected={false}
        codexNeedsReconnect
        onReconnectCodex={onReconnect}
      />,
    );
    mounted.push(view);

    const node = view.container.querySelector(
      '[data-testid="settings-models-route-status-line"]',
    );
    expect(node?.getAttribute('data-state')).toBe('broken-auth');
    expect(node?.textContent).toContain('Not ready: reconnect ChatGPT Pro');
    const button = view.container.querySelector<HTMLButtonElement>(
      '[data-testid="settings-models-route-status-reconnect-codex"]',
    );
    expect(button).not.toBeNull();
    act(() => {
      button?.click();
    });
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it('shows reconnect CTA when cached label is openrouter but auth is broken', () => {
    useRouteLabelCacheStore.getState().set({
      sessionId: SESSION_ID,
      turnAuthLabel: 'openrouter',
      observedAt: Date.now(),
    });
    const onReconnect = vi.fn();

    const view = mount(
      <RouteStatusLine
        openRouterConnected={false}
        openRouterNeedsReconnect
        onReconnectOpenRouter={onReconnect}
      />,
    );
    mounted.push(view);

    const node = view.container.querySelector(
      '[data-testid="settings-models-route-status-line"]',
    );
    expect(node?.getAttribute('data-state')).toBe('broken-auth');
    expect(node?.textContent).toContain('Not ready: reconnect OpenRouter');
  });

  it('shows reconnect copy without CTA when Anthropic auth is missing for an api-key cached label', () => {
    useRouteLabelCacheStore.getState().set({
      sessionId: SESSION_ID,
      turnAuthLabel: 'api-key',
      observedAt: Date.now(),
    });

    const view = mount(<RouteStatusLine hasAnthropicAuth={false} />);
    mounted.push(view);

    const node = view.container.querySelector(
      '[data-testid="settings-models-route-status-line"]',
    );
    expect(node?.getAttribute('data-state')).toBe('broken-auth');
    expect(node?.textContent).toContain('Not ready: reconnect Anthropic');
    expect(
      view.container.querySelector(
        '[data-testid^="settings-models-route-status-reconnect-"]',
      ),
    ).toBeNull();
  });
});
