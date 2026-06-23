// @vitest-environment happy-dom

/**
 * Phase 7 (third consumer found while building the renderer guard): the Todoist connect in the
 * scratchpad TasksPanel calls `miscApi.mcpAuthenticate({ serverId: 'Todoist' })` and previously
 * dropped any not-configured `setupGuidance`. It must now open the shared `ConnectorSetupDialog`.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OAUTH_CREDENTIALS_NOT_CONFIGURED_CODE, type OAuthSetupGuidance } from '@shared/ipc/schemas/common';
import { TasksPanel } from '../TasksPanel';

vi.mock('../../hooks/useTasks', () => ({
  useTasks: () => ({
    upcomingTasks: [],
    loading: false,
    error: null,
    addTask: vi.fn(),
    completeTask: vi.fn(),
    deleteTask: vi.fn(),
    todoistConnected: false,
    refresh: vi.fn().mockResolvedValue(undefined),
  }),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TODOIST_GUIDANCE: OAuthSetupGuidance = {
  code: OAUTH_CREDENTIALS_NOT_CONFIGURED_CODE,
  provider: 'todoist',
  displayName: 'Todoist',
  message: 'Todoist OAuth app not configured.',
  selfServe: true,
  setupUrl: 'https://developer.todoist.com',
  envVars: ['TODOIST_CLIENT_ID', 'TODOIST_CLIENT_SECRET'],
  redirectUris: ['mindstone://todoist/callback'],
};

describe('TasksPanel — Todoist setup guidance', () => {
  let container: HTMLDivElement;
  let root: Root;
  let originalSettingsApi: typeof window.settingsApi;
  let originalMiscApi: typeof window.miscApi;

  beforeEach(() => {
    vi.useFakeTimers();
    originalSettingsApi = window.settingsApi;
    originalMiscApi = window.miscApi;
    Object.defineProperty(window, 'settingsApi', {
      configurable: true,
      writable: true,
      value: {
        mcpUpsertServer: vi.fn().mockResolvedValue({ success: true }),
        mcpRestartSuperMcp: vi.fn().mockResolvedValue({ success: true }),
      },
    });
    Object.defineProperty(window, 'miscApi', {
      configurable: true,
      writable: true,
      value: {
        mcpAuthenticate: vi.fn().mockResolvedValue({
          success: false,
          error: TODOIST_GUIDANCE.message,
          setupGuidance: TODOIST_GUIDANCE,
        }),
      },
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    Object.defineProperty(window, 'settingsApi', { configurable: true, writable: true, value: originalSettingsApi });
    Object.defineProperty(window, 'miscApi', { configurable: true, writable: true, value: originalMiscApi });
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  it('opens the ConnectorSetupDialog when Todoist mcpAuthenticate returns not-configured guidance', async () => {
    act(() => root.render(React.createElement(TasksPanel, {})));

    const connectButton = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Connect',
    );
    expect(connectButton).toBeTruthy();

    await act(async () => {
      connectButton!.click();
    });
    // The connect flow waits 1500ms before calling mcpAuthenticate.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600);
    });

    expect(window.miscApi.mcpAuthenticate).toHaveBeenCalledWith({ serverId: 'Todoist' });
    expect(document.querySelector('[data-testid="connector-setup-dialog"]')).not.toBeNull();
  });
});
