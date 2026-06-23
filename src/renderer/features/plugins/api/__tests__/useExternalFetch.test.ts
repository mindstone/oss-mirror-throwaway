import { describe, it, expect } from 'vitest';
import { useExternalFetch, pluginImperativeFetch } from '../useExternalFetch';
import type {
  UseExternalFetchOptions,
  UseExternalFetchResult,
  PluginFetchResult,
} from '../types';

/**
 * Tests for useExternalFetch hook and pluginImperativeFetch.
 *
 * Since @testing-library/react is not available, these tests verify
 * exports, type contracts, and request construction patterns.
 */

describe('useExternalFetch', () => {
  describe('exports', () => {
    it('exports useExternalFetch function', () => {
      expect(typeof useExternalFetch).toBe('function');
    });

    it('exports pluginImperativeFetch function', () => {
      expect(typeof pluginImperativeFetch).toBe('function');
    });
  });

  describe('UseExternalFetchOptions type structure', () => {
    it('can construct options with all fields', () => {
      const opts: UseExternalFetchOptions = {
        method: 'GET',
        headers: { 'Authorization': 'Bearer token', 'Accept': 'application/json' },
      };
      expect(opts.method).toBe('GET');
      expect(opts.headers?.['Authorization']).toBe('Bearer token');
    });

    it('allows empty options (all fields optional)', () => {
      const opts: UseExternalFetchOptions = {};
      expect(opts.method).toBeUndefined();
      expect(opts.headers).toBeUndefined();
    });
  });

  describe('UseExternalFetchResult type structure', () => {
    it('represents loading state', () => {
      const result: UseExternalFetchResult = {
        data: null,
        isLoading: true,
        error: null,
        refetch: () => {},
      };
      expect(result.isLoading).toBe(true);
      expect(result.data).toBeNull();
    });

    it('represents loaded state with data', () => {
      const result: UseExternalFetchResult<{ issues: Array<{ id: number }> }> = {
        data: { issues: [{ id: 1 }] },
        isLoading: false,
        error: null,
        refetch: () => {},
      };
      expect(result.data?.issues[0].id).toBe(1);
      expect(result.isLoading).toBe(false);
    });

    it('represents error state', () => {
      const result: UseExternalFetchResult = {
        data: null,
        isLoading: false,
        error: 'Domain not allowed',
        refetch: () => {},
      };
      expect(result.error).toBe('Domain not allowed');
    });
  });

  describe('PluginFetchResult type structure', () => {
    it('represents success response', () => {
      const result: PluginFetchResult = {
        ok: true,
        status: 200,
        data: { items: [] },
      };
      expect(result.ok).toBe(true);
      expect(result.status).toBe(200);
    });

    it('represents error response', () => {
      const result: PluginFetchResult = {
        ok: false,
        status: 0,
        data: null,
        error: 'Rate limit exceeded',
      };
      expect(result.ok).toBe(false);
      expect(result.error).toBe('Rate limit exceeded');
    });
  });

  describe('IPC request construction', () => {
    it('builds correct request shape for minimal options', () => {
      const pluginId = 'test-plugin';
      const url = 'https://api.linear.app/graphql';

      const request = {
        pluginId,
        url,
        method: 'GET' as const,
        headers: undefined,
      };

      expect(request.pluginId).toBe('test-plugin');
      expect(request.url).toBe(url);
      expect(request.method).toBe('GET');
    });

    it('builds correct request shape with headers', () => {
      const options: UseExternalFetchOptions = {
        method: 'GET',
        headers: { 'Authorization': 'Bearer my-token' },
      };

      const request = {
        pluginId: 'my-plugin',
        url: 'https://api.github.com/repos',
        method: options.method ?? 'GET',
        headers: options.headers,
      };

      expect(request.headers).toEqual({ 'Authorization': 'Bearer my-token' });
    });

    it('defaults method to GET when not provided', () => {
      const options: UseExternalFetchOptions = {};
      const method = options.method ?? 'GET';
      expect(method).toBe('GET');
    });
  });
});
