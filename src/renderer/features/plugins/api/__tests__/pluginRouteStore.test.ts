import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  setPluginRoute,
  getPluginRoute,
  clearPluginRoute,
  subscribeToPluginRouteStore,
  _resetRouteStore,
} from '../pluginRouteStore';

describe('pluginRouteStore', () => {
  beforeEach(() => {
    _resetRouteStore();
  });

  describe('getPluginRoute', () => {
    it('returns frozen EMPTY_ROUTE for unknown plugins', () => {
      const route = getPluginRoute('unknown-plugin');
      expect(route).toEqual({ params: {} });
      expect(route.tabId).toBeUndefined();
    });

    it('returns the same frozen reference for unknown plugins on every call', () => {
      const route1 = getPluginRoute('unknown-a');
      const route2 = getPluginRoute('unknown-b');
      const route3 = getPluginRoute('unknown-a');
      // All should be the exact same frozen object reference
      expect(route1).toBe(route2);
      expect(route1).toBe(route3);
    });

    it('returns frozen EMPTY_ROUTE that cannot be mutated', () => {
      const route = getPluginRoute('unknown');
      expect(Object.isFrozen(route)).toBe(true);
      expect(() => {
        (route as Record<string, unknown>).tabId = 'hacked';
      }).toThrow();
    });
  });

  describe('setPluginRoute', () => {
    it('sets route with params', () => {
      setPluginRoute('file-viewer', { params: { path: '/docs/README.md' } });
      const route = getPluginRoute('file-viewer');
      expect(route.params).toEqual({ path: '/docs/README.md' });
      expect(route.tabId).toBeUndefined();
    });

    it('sets route with tabId and params', () => {
      setPluginRoute('meeting-prep', { tabId: 'agenda', params: { meetingId: 'abc' } });
      const route = getPluginRoute('meeting-prep');
      expect(route.tabId).toBe('agenda');
      expect(route.params).toEqual({ meetingId: 'abc' });
    });

    it('defaults params to empty object when not provided', () => {
      setPluginRoute('my-plugin', { tabId: 'main' });
      const route = getPluginRoute('my-plugin');
      expect(route.tabId).toBe('main');
      expect(route.params).toEqual({});
    });

    it('replaces previous route entirely (no merge)', () => {
      setPluginRoute('file-viewer', { tabId: 'tab1', params: { path: '/a', mode: 'edit' } });
      // Now replace with different state — tabId and old params should NOT persist
      setPluginRoute('file-viewer', { params: { path: '/b' } });

      const route = getPluginRoute('file-viewer');
      expect(route.tabId).toBeUndefined(); // tabId was not provided, so it's gone
      expect(route.params).toEqual({ path: '/b' }); // only the new params
    });

    it('replaces params fully on re-open with empty params', () => {
      setPluginRoute('my-plugin', { params: { key: 'value' } });
      setPluginRoute('my-plugin', {}); // open without params

      const route = getPluginRoute('my-plugin');
      expect(route.params).toEqual({});
    });

    it('notifies listeners on set', () => {
      const listener = vi.fn();
      subscribeToPluginRouteStore(listener);

      setPluginRoute('test-plugin', { params: { a: '1' } });
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('supports multiple plugins independently', () => {
      setPluginRoute('plugin-a', { params: { x: '1' } });
      setPluginRoute('plugin-b', { tabId: 'tab2', params: { y: '2' } });

      expect(getPluginRoute('plugin-a').params).toEqual({ x: '1' });
      expect(getPluginRoute('plugin-b').params).toEqual({ y: '2' });
      expect(getPluginRoute('plugin-b').tabId).toBe('tab2');
    });
  });

  describe('clearPluginRoute', () => {
    it('removes stored route so getPluginRoute returns EMPTY_ROUTE', () => {
      setPluginRoute('my-plugin', { params: { a: '1' } });
      clearPluginRoute('my-plugin');

      const route = getPluginRoute('my-plugin');
      expect(route).toEqual({ params: {} });
      // Should return the frozen EMPTY_ROUTE reference
      expect(route).toBe(getPluginRoute('other-unknown'));
    });

    it('no-ops if plugin has no stored route (no listener notification)', () => {
      const listener = vi.fn();
      subscribeToPluginRouteStore(listener);

      clearPluginRoute('never-set-plugin');
      expect(listener).not.toHaveBeenCalled();
    });

    it('notifies listeners when clearing an existing route', () => {
      setPluginRoute('my-plugin', { params: { a: '1' } });

      const listener = vi.fn();
      subscribeToPluginRouteStore(listener);

      clearPluginRoute('my-plugin');
      expect(listener).toHaveBeenCalledTimes(1);
    });
  });

  describe('subscribeToPluginRouteStore', () => {
    it('returns an unsubscribe function', () => {
      const listener = vi.fn();
      const unsub = subscribeToPluginRouteStore(listener);

      setPluginRoute('test', { params: { a: '1' } });
      expect(listener).toHaveBeenCalledTimes(1);

      unsub();
      setPluginRoute('test', { params: { b: '2' } });
      expect(listener).toHaveBeenCalledTimes(1); // not called again
    });

    it('supports multiple listeners', () => {
      const listener1 = vi.fn();
      const listener2 = vi.fn();
      subscribeToPluginRouteStore(listener1);
      subscribeToPluginRouteStore(listener2);

      setPluginRoute('test', { params: {} });
      expect(listener1).toHaveBeenCalledTimes(1);
      expect(listener2).toHaveBeenCalledTimes(1);
    });

    it('unsubscribing one listener does not affect others', () => {
      const listener1 = vi.fn();
      const listener2 = vi.fn();
      const unsub1 = subscribeToPluginRouteStore(listener1);
      subscribeToPluginRouteStore(listener2);

      unsub1();
      setPluginRoute('test', { params: {} });

      expect(listener1).not.toHaveBeenCalled();
      expect(listener2).toHaveBeenCalledTimes(1);
    });
  });

  describe('_resetRouteStore', () => {
    it('clears all routes and listeners', () => {
      const listener = vi.fn();
      subscribeToPluginRouteStore(listener);
      setPluginRoute('test', { params: { a: '1' } });
      expect(listener).toHaveBeenCalledTimes(1);

      _resetRouteStore();

      // Route should be cleared
      expect(getPluginRoute('test')).toEqual({ params: {} });

      // Old listener should not be notified after reset
      setPluginRoute('test', { params: { b: '2' } });
      expect(listener).toHaveBeenCalledTimes(1); // still 1 from before reset
    });
  });
});
