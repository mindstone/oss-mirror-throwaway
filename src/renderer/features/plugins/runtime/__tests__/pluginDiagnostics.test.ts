import { describe, it, expect, beforeEach } from 'vitest';
import { recordPluginCrash, getPluginCrashes, clearPluginCrashes } from '../pluginDiagnostics';

describe('pluginDiagnostics', () => {
  beforeEach(() => {
    clearPluginCrashes('test-plugin');
    clearPluginCrashes('other-plugin');
  });

  describe('recordPluginCrash', () => {
    it('records a crash with error details', () => {
      const error = new Error('Component failed');
      error.name = 'TypeError';
      recordPluginCrash('test-plugin', error, '<div>\n  <PluginComponent>');

      const crashes = getPluginCrashes('test-plugin');
      expect(crashes).toHaveLength(1);
      expect(crashes[0].name).toBe('TypeError');
      expect(crashes[0].message).toBe('Component failed');
      expect(crashes[0].componentStack).toBe('<div>\n  <PluginComponent>');
      expect(crashes[0].timestamp).toBeGreaterThan(0);
    });

    it('records multiple crashes for the same plugin', () => {
      recordPluginCrash('test-plugin', new Error('first'));
      recordPluginCrash('test-plugin', new Error('second'));

      const crashes = getPluginCrashes('test-plugin');
      expect(crashes).toHaveLength(2);
      expect(crashes[0].message).toBe('first');
      expect(crashes[1].message).toBe('second');
    });

    it('isolates crashes between plugins', () => {
      recordPluginCrash('test-plugin', new Error('plugin A crash'));
      recordPluginCrash('other-plugin', new Error('plugin B crash'));

      expect(getPluginCrashes('test-plugin')).toHaveLength(1);
      expect(getPluginCrashes('other-plugin')).toHaveLength(1);
      expect(getPluginCrashes('test-plugin')[0].message).toBe('plugin A crash');
    });

    it('caps at 20 entries per plugin, evicting oldest first', () => {
      for (let i = 0; i < 25; i++) {
        recordPluginCrash('test-plugin', new Error(`crash-${i}`));
      }

      const crashes = getPluginCrashes('test-plugin');
      expect(crashes).toHaveLength(20);
      expect(crashes[0].message).toBe('crash-5');
      expect(crashes[19].message).toBe('crash-24');
    });

    it('handles null componentStack', () => {
      recordPluginCrash('test-plugin', new Error('test'), null);
      const crashes = getPluginCrashes('test-plugin');
      expect(crashes[0].componentStack).toBeUndefined();
    });
  });

  describe('getPluginCrashes', () => {
    it('returns empty array for unknown plugin', () => {
      expect(getPluginCrashes('nonexistent')).toEqual([]);
    });

    it('returns defensive copies', () => {
      recordPluginCrash('test-plugin', new Error('test'));
      const a = getPluginCrashes('test-plugin');
      const b = getPluginCrashes('test-plugin');
      expect(a).not.toBe(b);
      expect(a[0]).not.toBe(b[0]);
    });
  });

  describe('clearPluginCrashes', () => {
    it('clears crashes for a specific plugin', () => {
      recordPluginCrash('test-plugin', new Error('test'));
      recordPluginCrash('other-plugin', new Error('other'));

      clearPluginCrashes('test-plugin');

      expect(getPluginCrashes('test-plugin')).toEqual([]);
      expect(getPluginCrashes('other-plugin')).toHaveLength(1);
    });

    it('is a no-op for unknown plugins', () => {
      expect(() => clearPluginCrashes('nonexistent')).not.toThrow();
    });
  });
});
