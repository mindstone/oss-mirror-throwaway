/**
 * Screen-mount smoke harness — prevention machinery.
 *
 * Mounts top-level screens and asserts they render without throwing. This is
 * the cheap, deterministic backstop the REBEL-1AZ postmortem recommended
 * (docs/postmortems/260417_rebel_1az_mobile_recording_infinite_rerender_postmortem.md):
 * it catches the class of mount-time JS crashes that ship to users —
 * infinite-render loops ("Maximum update depth exceeded" — REBEL-1AZ/1BB),
 * undefined-access, and bad-import crashes ("X is not a function") — without
 * needing a simulator. Add a row per screen as new top-level screens land.
 *
 * Scope note: gesture-handler's runtime "must be a descendant of
 * GestureHandlerRootView" check (REBEL-170) only fires in the real RN runtime,
 * not under jest (where GestureHandlerRootView is mocked passthrough, matching
 * the repo's existing test precedent). That invariant is enforced instead by
 * the GestureHandlerRootView hoist in app/_layout.tsx + the Maestro flows; this
 * harness covers the JS-level mount-crash class.
 */

import React from 'react';
import { render } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

// GestureHandlerRootView requires a native install() that isn't available under
// jest; mock it passthrough (mirrors src/__tests__/widgetLifecycle.test.ts).
jest.mock('react-native-gesture-handler', () => ({
  GestureHandlerRootView: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

// expo-router pulls in navigator internals that don't load under jest.
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn() },
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
  Stack: Object.assign(({ children }: { children?: React.ReactNode }) => children ?? null, {
    Screen: () => null,
  }),
}));

import { GestureHandlerRootView } from 'react-native-gesture-handler';

// The auth store must be initialised before any screen that reads it mounts
// (mirrors src/__tests__/homeScreen.test.tsx).
const { initAuthStore } = require('@rebel/cloud-client');
beforeAll(() => {
  initAuthStore({
    getToken: jest.fn().mockResolvedValue(null),
    setToken: jest.fn().mockResolvedValue(undefined),
    clearToken: jest.fn().mockResolvedValue(undefined),
  });
});

import { PairScreen } from '../screens/PairScreen';

// Mirrors the production wrapper order after the REBEL-170 fix in app/_layout.tsx:
// GestureHandlerRootView is the outermost wrapper for EVERY branch.
function mountInAppShell(node: React.ReactElement) {
  return render(
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider
        initialMetrics={{
          frame: { x: 0, y: 0, width: 390, height: 844 },
          insets: { top: 47, left: 0, right: 0, bottom: 34 },
        }}
      >
        {node}
      </SafeAreaProvider>
    </GestureHandlerRootView>,
  );
}

describe('screen-mount smoke', () => {
  it('mounts PairScreen (unpaired branch) without throwing', () => {
    expect(() => mountInAppShell(<PairScreen />)).not.toThrow();
  });
});
