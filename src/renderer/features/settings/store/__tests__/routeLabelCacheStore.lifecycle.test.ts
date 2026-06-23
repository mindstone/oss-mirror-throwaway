// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, flushAsync, renderHook } from '@renderer/test-utils';
import type { AppSettings } from '@shared/types';
import { useSessionStore } from '@renderer/features/agent-session/store/sessionStore';
import { useSettingsFeature } from '../../hooks/useSettingsFeature';
import { useRouteLabelCacheStore } from '../routeLabelCacheStore';

describe('routeLabelCacheStore lifecycle wiring', () => {
  beforeEach(() => {
    useRouteLabelCacheStore.getState().clearAll();
    // Reset the active conversation between lifecycle tests.
    useSessionStore.getState().resetSession();
    vi.restoreAllMocks();
  });

  it('clears route cache for the current session when resetSession runs', () => {
    const sessionId = useSessionStore.getState().currentSessionId;
    useRouteLabelCacheStore.getState().set({
      sessionId,
      turnAuthLabel: 'api-key',
      observedAt: Date.now(),
    });

    useSessionStore.getState().resetSession();

    expect(useRouteLabelCacheStore.getState().bySession[sessionId]).toBeUndefined();
  });

  it('clears route cache when the session is deleted', () => {
    const sessionId = useSessionStore.getState().currentSessionId;
    useRouteLabelCacheStore.getState().set({
      sessionId,
      turnAuthLabel: 'profile-direct',
      observedAt: Date.now(),
    });

    useSessionStore.getState().softDeleteSession(sessionId);

    expect(useRouteLabelCacheStore.getState().bySession[sessionId]).toBeUndefined();
  });

  it('clears all route labels when auth signs out', async () => {
    let authStateListener:
      | ((state: { isAuthenticated: boolean; user: null; isLoading: boolean }) => void)
      | null = null;

    Object.assign(window, {
      api: {
        onDemoModeChange: vi.fn(() => () => {}),
        onSettingsExternalUpdate: vi.fn(() => () => {}),
        onAuthConfigReceived: vi.fn(() => () => {}),
        onAgentRoutePlanResolved: vi.fn(() => () => {}),
        onAgentEvent: vi.fn(() => () => {}),
        onAuthStateChange: vi.fn((callback) => {
          authStateListener = callback;
          return () => {
            authStateListener = null;
          };
        }),
        getAnalyticsStatus: vi.fn(async () => null),
      },
      settingsApi: {
        get: vi.fn(async () => ({}) as Promise<AppSettings>),
        update: vi.fn(async (next: AppSettings) => next),
      },
    });

    const { unmount } = renderHook(() =>
      useSettingsFeature({
        emitLog: vi.fn(),
        showToast: vi.fn(),
      }),
    );

    await flushAsync();
    await flushAsync();

    useRouteLabelCacheStore.getState().set({
      sessionId: 'session-a',
      turnAuthLabel: 'openrouter',
      observedAt: Date.now(),
    });
    useRouteLabelCacheStore.getState().set({
      sessionId: 'session-b',
      turnAuthLabel: 'codex-subscription',
      observedAt: Date.now() + 1,
    });

    act(() => {
      authStateListener?.({
        isAuthenticated: false,
        user: null,
        isLoading: false,
      });
    });

    expect(useRouteLabelCacheStore.getState().bySession).toEqual({});
    expect(useRouteLabelCacheStore.getState().lastObserved).toBeNull();

    unmount();
  });
});
