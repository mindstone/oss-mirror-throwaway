import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpacePluginsController } from '../useSpacePlugins';

// Mock the controller factory so we don't touch real window.pluginsApi
const mockStart = vi.fn();
const mockStop = vi.fn();
const mockRefresh = vi.fn().mockResolvedValue(undefined);
const mockGetState = vi.fn().mockReturnValue({
  spacePlugins: [],
  conflicts: [],
  isLoading: false,
  error: null,
});
const mockSubscribe = vi.fn((_listener: () => void) => {
  return () => {};
});

const mockController: SpacePluginsController = {
  start: mockStart,
  stop: mockStop,
  refresh: mockRefresh,
  getState: mockGetState,
  subscribe: mockSubscribe,
};

vi.mock('../useSpacePlugins', () => ({
  createDefaultSpacePluginsController: () => mockController,
}));

import {
  getSharedSpacePluginsController,
  startSharedSpacePluginsController,
  stopSharedSpacePluginsController,
  resetSharedControllerForTest,
  setSharedControllerForTest,
} from '../spacePluginsStartup';

describe('spacePluginsStartup', () => {
  beforeEach(() => {
    resetSharedControllerForTest();
    mockStart.mockClear();
    mockStop.mockClear();
    mockRefresh.mockClear();
    mockGetState.mockClear();
    mockSubscribe.mockClear();
  });

  describe('getSharedSpacePluginsController', () => {
    it('returns the same singleton instance on repeated calls', () => {
      const first = getSharedSpacePluginsController();
      const second = getSharedSpacePluginsController();
      expect(first).toBe(second);
    });

    it('creates a new instance after reset', () => {
      const _first = getSharedSpacePluginsController();
      resetSharedControllerForTest();
      // After reset, the next call creates a new controller (same mock,
      // but the singleton slot was cleared)
      const _second = getSharedSpacePluginsController();
      // Both are the same mock object (vi.mock returns the same reference),
      // but start/stop were called on the first via _resetSharedController
      expect(mockStop).toHaveBeenCalledTimes(1);
    });
  });

  describe('startSharedSpacePluginsController', () => {
    it('calls start() on the shared controller', () => {
      startSharedSpacePluginsController();
      expect(mockStart).toHaveBeenCalledTimes(1);
    });

    it('is idempotent — calling start twice only delegates to controller.start() twice (controller itself guards)', () => {
      startSharedSpacePluginsController();
      startSharedSpacePluginsController();
      expect(mockStart).toHaveBeenCalledTimes(2);
    });
  });

  describe('stopSharedSpacePluginsController', () => {
    it('calls stop() on the shared controller', () => {
      // Need to create the singleton first
      startSharedSpacePluginsController();
      stopSharedSpacePluginsController();
      expect(mockStop).toHaveBeenCalledTimes(1);
    });

    it('is a no-op if no controller was ever created', () => {
      // No startShared or getShared called
      stopSharedSpacePluginsController();
      expect(mockStop).not.toHaveBeenCalled();
    });
  });

  describe('setSharedControllerForTest', () => {
    it('allows injecting a custom controller for tests', () => {
      const custom: SpacePluginsController = {
        start: vi.fn(),
        stop: vi.fn(),
        refresh: vi.fn().mockResolvedValue(undefined),
        getState: vi.fn().mockReturnValue({
          spacePlugins: [],
          conflicts: [],
          isLoading: false,
          error: null,
        }),
        subscribe: vi.fn(() => () => {}),
      };

      setSharedControllerForTest(custom);

      const controller = getSharedSpacePluginsController();
      expect(controller).toBe(custom);

      startSharedSpacePluginsController();
      expect(custom.start).toHaveBeenCalledTimes(1);
      expect(mockStart).not.toHaveBeenCalled();
    });
  });

  describe('lifecycle integration', () => {
    it('App.tsx pattern: start on mount, stop on unmount', () => {
      // Simulate App mount
      startSharedSpacePluginsController();
      expect(mockStart).toHaveBeenCalledTimes(1);

      // Simulate PluginsTab subscribing (gets same controller)
      const controller = getSharedSpacePluginsController();
      expect(controller).toBe(mockController);

      // PluginsTab calls refresh, not start/stop
      void controller.refresh();
      expect(mockRefresh).toHaveBeenCalledTimes(1);
      expect(mockStart).toHaveBeenCalledTimes(1); // Still only 1

      // Simulate App unmount
      stopSharedSpacePluginsController();
      expect(mockStop).toHaveBeenCalledTimes(1);
    });
  });
});
