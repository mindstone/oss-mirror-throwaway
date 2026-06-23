import { describe, it, expect } from 'vitest';
import {
  createPluginSurfaceId,
  isBuiltInSurface,
  isPluginSurface,
  getPluginIdFromSurface,
  BUILT_IN_FLOW_SURFACES,
} from '../types';

describe('plugin types', () => {
  describe('createPluginSurfaceId', () => {
    it('should create a surface ID from a plugin ID', () => {
      const id = createPluginSurfaceId('my-plugin');
      expect(id).toBe('plugin:my-plugin');
    });

    it('should create a surface ID with a tab ID', () => {
      const id = createPluginSurfaceId('my-plugin', 'settings');
      expect(id).toBe('plugin:my-plugin:settings');
    });

    it('should accept numeric IDs', () => {
      const id = createPluginSurfaceId('plugin-123');
      expect(id).toBe('plugin:plugin-123');
    });

    it('should throw for invalid plugin ID (uppercase)', () => {
      expect(() => createPluginSurfaceId('MyPlugin')).toThrow('Invalid plugin ID: MyPlugin');
    });

    it('should throw for invalid plugin ID (spaces)', () => {
      expect(() => createPluginSurfaceId('my plugin')).toThrow('Invalid plugin ID: my plugin');
    });

    it('should throw for invalid plugin ID (underscores)', () => {
      expect(() => createPluginSurfaceId('my_plugin')).toThrow('Invalid plugin ID: my_plugin');
    });

    it('should throw for empty plugin ID', () => {
      expect(() => createPluginSurfaceId('')).toThrow('Invalid plugin ID: ');
    });

    it('should throw for invalid tab ID', () => {
      expect(() => createPluginSurfaceId('my-plugin', 'Bad Tab')).toThrow('Invalid tab ID: Bad Tab');
    });

    it('should throw for empty tab ID', () => {
      expect(() => createPluginSurfaceId('my-plugin', '')).toThrow('Invalid tab ID: ');
    });
  });

  describe('isBuiltInSurface', () => {
    it('should return true for all built-in surfaces', () => {
      for (const s of BUILT_IN_FLOW_SURFACES) {
        expect(isBuiltInSurface(s)).toBe(true);
      }
    });

    it('should return false for plugin surface IDs', () => {
      expect(isBuiltInSurface('plugin:test')).toBe(false);
    });

    it('should return false for arbitrary strings', () => {
      expect(isBuiltInSurface('random')).toBe(false);
      expect(isBuiltInSurface('')).toBe(false);
    });
  });

  describe('isPluginSurface', () => {
    it('should return true for plugin surface IDs', () => {
      expect(isPluginSurface('plugin:test')).toBe(true);
      expect(isPluginSurface('plugin:my-plugin')).toBe(true);
      expect(isPluginSurface('plugin:my-plugin:settings')).toBe(true);
    });

    it('should return false for built-in surfaces', () => {
      expect(isPluginSurface('home')).toBe(false);
      expect(isPluginSurface('sessions')).toBe(false);
    });

    it('should return false for strings that almost match', () => {
      expect(isPluginSurface('plugin')).toBe(false);
      expect(isPluginSurface('Plugin:test')).toBe(false);
    });
  });

  describe('getPluginIdFromSurface', () => {
    it('should extract plugin ID from a simple surface', () => {
      expect(getPluginIdFromSurface('plugin:test')).toBe('test');
    });

    it('should extract plugin ID from a surface with tab', () => {
      expect(getPluginIdFromSurface('plugin:my-plugin:settings')).toBe('my-plugin');
    });

    it('should return undefined for non-plugin surfaces', () => {
      expect(getPluginIdFromSurface('home')).toBeUndefined();
      expect(getPluginIdFromSurface('sessions')).toBeUndefined();
      expect(getPluginIdFromSurface('')).toBeUndefined();
    });
  });
});
