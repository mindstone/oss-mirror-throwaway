// @vitest-environment happy-dom

/**
 * Unit coverage for the shared `useConnectorSetupGuidance` funnel (Stage 5). Asserts the helper
 * opens the dialog ONLY for the `oauth-credentials-not-configured` discriminant and falls through
 * for every other result (generic errors, success, null), so non-credential failures keep their
 * existing toast/error handling.
 *
 * Uses a local `createRoot` + `act` renderHook (no `@testing-library/react-hooks` in this repo).
 */

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import {
  isOAuthSetupGuidance,
  useConnectorSetupGuidance,
} from '../useConnectorSetupGuidance';
import type { OAuthSetupGuidance } from '@shared/ipc/schemas/common';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const cleanups: Array<() => void> = [];

function renderHook<T>(hookFn: () => T): { current: T } {
  const result = { current: undefined as unknown as T };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const TestComponent = () => {
    result.current = hookFn();
    return null;
  };
  act(() => root.render(React.createElement(TestComponent)));
  cleanups.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return result;
}

afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

/** Mimic a real connect/auth IPC result (extra fields beyond `setupGuidance` are common). */
const res = (r: { success?: boolean; error?: string; setupGuidance?: OAuthSetupGuidance }) => r;

const guidance: OAuthSetupGuidance = {
  code: 'oauth-credentials-not-configured',
  provider: 'slack',
  displayName: 'Slack',
  message: 'Slack needs OAuth client credentials before anyone can connect.',
  selfServe: true,
  setupUrl: 'https://api.slack.com/apps',
  envVars: ['SLACK_CLIENT_ID', 'SLACK_CLIENT_SECRET'],
  redirectUris: ['https://rebel-auth.mindstone.com/slack/callback'],
};

describe('isOAuthSetupGuidance', () => {
  it('accepts only the not-configured discriminant', () => {
    expect(isOAuthSetupGuidance(guidance)).toBe(true);
    expect(isOAuthSetupGuidance({ code: 'something-else' })).toBe(false);
    expect(isOAuthSetupGuidance({})).toBe(false);
    expect(isOAuthSetupGuidance(null)).toBe(false);
    expect(isOAuthSetupGuidance(undefined)).toBe(false);
    expect(isOAuthSetupGuidance('error string')).toBe(false);
  });
});

describe('useConnectorSetupGuidance', () => {
  it('starts closed', () => {
    const result = renderHook(() => useConnectorSetupGuidance());
    expect(result.current.isOpen).toBe(false);
    expect(result.current.guidance).toBeNull();
  });

  it('opens the dialog when a result carries not-configured guidance', () => {
    const result = renderHook(() => useConnectorSetupGuidance());
    let handled = false;
    act(() => {
      handled = result.current.handleResult(res({ success: false, error: "x", setupGuidance: guidance }));
    });
    expect(handled).toBe(true);
    expect(result.current.isOpen).toBe(true);
    expect(result.current.guidance).toEqual(guidance);
  });

  it('does NOT open for generic errors, success, or null results', () => {
    const result = renderHook(() => useConnectorSetupGuidance());
    let handled = true;
    act(() => {
      handled = result.current.handleResult(res({ success: false, error: "timed out" }));
    });
    expect(handled).toBe(false);
    expect(result.current.isOpen).toBe(false);

    act(() => {
      handled = result.current.handleResult(res({ success: true }));
    });
    expect(handled).toBe(false);

    act(() => {
      handled = result.current.handleResult(null);
    });
    expect(handled).toBe(false);
    expect(result.current.isOpen).toBe(false);
  });

  it('setOpen(false) and close() clear the guidance', () => {
    const result = renderHook(() => useConnectorSetupGuidance());
    act(() => {
      result.current.handleResult(res({ success: false, setupGuidance: guidance }));
    });
    expect(result.current.isOpen).toBe(true);

    act(() => result.current.setOpen(false));
    expect(result.current.isOpen).toBe(false);
    expect(result.current.guidance).toBeNull();

    act(() => result.current.open(guidance));
    expect(result.current.isOpen).toBe(true);
    act(() => result.current.close());
    expect(result.current.isOpen).toBe(false);
  });

  // Regression guard for the onboarding render-churn loop (a real user, ~70k effect
  // re-fires). The hook's return is listed in consumer `useCallback`/`useEffect`
  // deps (e.g. `generateAuthLink` in `useOnboardingFlow`, two `ToolAuthStep`
  // callbacks). An UNMEMOISED return object got a new identity every render, which
  // recreated those callbacks every render and re-fired the OnboardingWizard
  // auto-gen effect on every render. The fix memoises the return; this locks it.
  it('keeps a STABLE return identity across re-renders when guidance is unchanged, and a NEW identity when it changes', () => {
    const seen: Array<ReturnType<typeof useConnectorSetupGuidance>> = [];
    let forceRerender: () => void = () => {};
    let openDialog: (g: OAuthSetupGuidance) => void = () => {};

    const Host = () => {
      // A parent-owned tick forces the host to re-render WITHOUT touching the
      // hook's own `guidance` state — the exact condition under which the return
      // identity must stay stable.
      const [, setTick] = React.useState(0);
      forceRerender = () => setTick((t) => t + 1);
      const api = useConnectorSetupGuidance();
      openDialog = api.open;
      seen.push(api);
      return null;
    };

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    cleanups.push(() => {
      act(() => root.unmount());
      container.remove();
    });

    act(() => root.render(React.createElement(Host)));
    const first = seen[seen.length - 1];

    // Re-render with unchanged guidance → identity MUST be stable (the regression).
    act(() => forceRerender());
    expect(seen[seen.length - 1]).toBe(first);

    // A second unrelated re-render — still stable.
    act(() => forceRerender());
    expect(seen[seen.length - 1]).toBe(first);

    // Changing the hook's own state MUST yield a fresh identity (values stay live).
    act(() => openDialog(guidance));
    const afterOpen = seen[seen.length - 1];
    expect(afterOpen).not.toBe(first);
    expect(afterOpen.isOpen).toBe(true);
    expect(afterOpen.guidance).toEqual(guidance);
  });
});
