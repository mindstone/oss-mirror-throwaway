/**
 * Mobile root module-load smoke - MMKV/startup native-module regression guard.
 *
 * This is the stronger smoke: it imports the real `app/_layout.tsx` module,
 * so the production top-level startup wiring runs (`initAuthStore`,
 * `initOfflineQueueStore`, `initPersistence`, logger setup, and friends).
 * Jest runs this suite in CommonJS mode, so the import is expressed as an async
 * require wrapper rather than native `import()` (which requires vm modules).
 * The test deliberately keeps the real persistence/storage adapters in the
 * graph:
 *
 * - `mobile/src/storage/asyncStoragePersistence.ts`
 * - `mobile/src/storage/secureTokenStorage.ts`
 * - `mobile/src/storage/offlineQueueStorage.ts`
 *
 * That coupling is the point. A future MMKV-style startup import that is not
 * available in the supported Expo preview/runtime should fail here before
 * release. Only Jest-incompatible shell/native UI edges are mocked.
 *
 * @see ../../app/_layout.tsx
 * @see docs/postmortems/260531_mobile_expo_go_mmkv_compatibility_postmortem.md
 */

import React from 'react';

// GestureHandlerRootView requires a native install() unavailable under jest;
// passthrough matches the existing screen-mount smoke precedent.
jest.mock('react-native-gesture-handler', () => ({
  GestureHandlerRootView: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

// expo-router pulls in navigator internals that do not load under jest. The
// module-load smoke only needs the exports `_layout.tsx` touches at startup.
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn() },
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
  useSegments: () => [],
  Stack: Object.assign(({ children }: { children?: React.ReactNode }) => children ?? null, {
    Screen: () => null,
  }),
}));

jest.mock('react-native-reanimated', () => {
  const Reanimated = require('react-native-reanimated/mock');
  return {
    ...Reanimated,
    __esModule: true,
    default: Reanimated.default ?? Reanimated,
  };
});

jest.mock('@sentry/react-native', () => ({
  init: jest.fn(),
  setTag: jest.fn(),
  setUser: jest.fn(),
  captureMessage: jest.fn(),
  captureException: jest.fn(),
  addBreadcrumb: jest.fn(),
  wrap: (component: unknown) => component,
}));

jest.mock('expo-notifications', () => ({
  setNotificationHandler: jest.fn(),
  addNotificationResponseReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
  getPermissionsAsync: jest.fn().mockResolvedValue({ status: 'denied' }),
  requestPermissionsAsync: jest.fn().mockResolvedValue({ status: 'denied' }),
  getExpoPushTokenAsync: jest.fn().mockResolvedValue({ data: 'test-token' }),
}));

jest.mock('expo-task-manager', () => ({
  defineTask: jest.fn(),
  isTaskRegisteredAsync: jest.fn().mockResolvedValue(false),
}));

jest.mock('expo-background-fetch', () => ({
  BackgroundFetchResult: {
    NoData: 'NoData',
    NewData: 'NewData',
    Failed: 'Failed',
  },
  BackgroundFetchStatus: {
    Denied: 'Denied',
    Restricted: 'Restricted',
    Available: 'Available',
  },
  getStatusAsync: jest.fn().mockResolvedValue('Available'),
  registerTaskAsync: jest.fn().mockResolvedValue(undefined),
  unregisterTaskAsync: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('expo-file-system', () => {
  function joinUri(...parts: unknown[]): string {
    const strings = parts.map((part) => {
      if (part && typeof part === 'object' && 'uri' in part) return (part as { uri: string }).uri;
      return String(part);
    });

    let result = strings[0] ?? '';
    for (let index = 1; index < strings.length; index += 1) {
      const segment = strings[index];
      result = result.endsWith('/') ? result + segment : `${result}/${segment}`;
    }
    return result;
  }

  class MockDirectory {
    uri: string;
    exists = true;
    create = jest.fn();
    delete = jest.fn();
    list = jest.fn().mockReturnValue([]);

    constructor(...uris: unknown[]) {
      this.uri = joinUri(...uris);
    }
  }

  class MockFile {
    uri: string;
    name: string;
    exists = false;
    create = jest.fn(() => { this.exists = true; });
    write = jest.fn();
    text = jest.fn().mockResolvedValue('');
    delete = jest.fn(() => { this.exists = false; });
    move = jest.fn();
    rename = jest.fn((newName: string) => {
      const lastSlash = this.uri.lastIndexOf('/');
      this.uri = `${this.uri.slice(0, lastSlash + 1)}${newName}`;
      this.name = newName;
      this.exists = true;
    });
    copy = jest.fn();

    constructor(...uris: unknown[]) {
      this.uri = joinUri(...uris);
      const lastSlash = this.uri.lastIndexOf('/');
      this.name = lastSlash >= 0 ? this.uri.slice(lastSlash + 1) : this.uri;
    }
  }

  return {
    Paths: { document: 'file:///jest-document' },
    Directory: MockDirectory,
    File: MockFile,
  };
});

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: {
    expoConfig: {
      version: '0.0.0-test',
      runtimeVersion: 'test',
      extra: { eas: { projectId: 'test-project-id' } },
    },
  },
}));

describe('mobile root module-load smoke', () => {
  it('imports the real app root startup wiring without throwing', async () => {
    await expect(Promise.resolve().then(() => require('../../app/_layout'))).resolves.toBeDefined();
  });
});
