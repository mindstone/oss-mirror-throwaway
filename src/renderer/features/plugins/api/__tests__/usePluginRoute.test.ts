import { describe, it, expect } from 'vitest';
import { usePluginRoute } from '../usePluginRoute';
import {
  setPluginRoute,
  getPluginRoute,
  clearPluginRoute,
  subscribeToPluginRouteStore,
  _resetRouteStore,
} from '../pluginRouteStore';
import type { PluginRouteInfo } from '../types';

/**
 * Tests for usePluginRoute hook.
 *
 * Since the project doesn't have @testing-library/react installed,
 * these tests verify the exported function type, interface structures,
 * and behavioral contracts via structural/type-level checks.
 *
 * The underlying pluginRouteStore is fully tested in pluginRouteStore.test.ts.
 */

describe('usePluginRoute', () => {
  describe('exports', () => {
    it('exports usePluginRoute as a function', () => {
      expect(typeof usePluginRoute).toBe('function');
    });

    it('is a React hook (starts with "use")', () => {
      expect(usePluginRoute.name).toBe('usePluginRoute');
    });
  });

  describe('pluginRouteStore integration', () => {
    it('exports all store functions needed by the hook', () => {
      expect(typeof setPluginRoute).toBe('function');
      expect(typeof getPluginRoute).toBe('function');
      expect(typeof clearPluginRoute).toBe('function');
      expect(typeof subscribeToPluginRouteStore).toBe('function');
      expect(typeof _resetRouteStore).toBe('function');
    });
  });

  describe('PluginRouteInfo type contract', () => {
    it('matches the expected shape with required fields', () => {
      const routeInfo: PluginRouteInfo = {
        pluginId: 'test-plugin',
        params: {},
      };
      expect(routeInfo.pluginId).toBe('test-plugin');
      expect(routeInfo.params).toEqual({});
      expect(routeInfo.tabId).toBeUndefined();
    });

    it('accepts optional tabId', () => {
      const routeInfo: PluginRouteInfo = {
        pluginId: 'test-plugin',
        tabId: 'agenda',
        params: { meetingId: 'abc' },
      };
      expect(routeInfo.tabId).toBe('agenda');
      expect(routeInfo.params).toEqual({ meetingId: 'abc' });
    });

    it('params is always Record<string, string>', () => {
      const routeInfo: PluginRouteInfo = {
        pluginId: 'file-viewer',
        params: { path: '/docs/README.md', highlight: '42' },
      };
      for (const [key, value] of Object.entries(routeInfo.params)) {
        expect(typeof key).toBe('string');
        expect(typeof value).toBe('string');
      }
    });
  });
});
