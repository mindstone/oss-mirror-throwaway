/**
 * useExternalFetch — Plugin hook for mediated HTTP GET requests.
 *
 * Fetches data from an allowlisted external URL via the main process.
 * The URL is validated against the plugin's manifest `externalDomains`.
 * Only GET requests are supported for MVP.
 *
 * Security: All requests are mediated by the main process which validates
 * domain allowlisting, blocks private IPs, enforces rate limits (30/min),
 * applies timeouts (30s), and caps response size (1MB).
 *
 * @see src/main/services/pluginExternalFetchService.ts — execution engine
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePluginId } from './PluginContext';
import type { UseExternalFetchOptions, UseExternalFetchResult, PluginFetchResult } from './types';

export function useExternalFetch<T = unknown>(
  url: string,
  options?: UseExternalFetchOptions,
): UseExternalFetchResult<T> {
  const pluginId = usePluginId();
  const [data, setData] = useState<T | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef(0);

  const optionsKey = JSON.stringify(options ?? {});

  const doFetch = useCallback(async (requestId: number) => {
    if (!url) {
      setIsLoading(false);
      setError('Needs a URL to work with.');
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      if (typeof window === 'undefined' || !window.pluginsApi?.externalFetch) {
        throw new Error('External fetch API not available.');
      }

      const result = await window.pluginsApi.externalFetch({
        pluginId,
        url,
        method: options?.method ?? 'GET',
        headers: options?.headers,
      });

      if (requestId !== abortRef.current) return;

      if (result.ok) {
        setData(result.data as T);
        setError(null);
      } else {
        setData(null);
        setError(result.error ?? `Request failed with status ${result.status}`);
      }
    } catch (err) {
      if (requestId !== abortRef.current) return;
      setData(null);
      setError(err instanceof Error ? err.message : 'External fetch failed.');
    } finally {
      if (requestId === abortRef.current) {
        setIsLoading(false);
      }
    }
  }, [pluginId, url, optionsKey]); // eslint-disable-line react-hooks/exhaustive-deps -- intentional: omitting options object because optionsKey captures method/headers without refetching on object identity churn

  useEffect(() => {
    const requestId = ++abortRef.current;
    doFetch(requestId);
  }, [doFetch]);

  const refetch = useCallback(() => {
    const requestId = ++abortRef.current;
    doFetch(requestId);
  }, [doFetch]);

  return { data, isLoading, error, refetch };
}

/**
 * Imperative fetch function for use in `rebel.fetch()`.
 * Called from pluginApiFactory.ts — not a React hook.
 */
export async function pluginImperativeFetch(
  pluginId: string,
  url: string,
  options?: UseExternalFetchOptions,
): Promise<PluginFetchResult> {
  if (typeof window === 'undefined' || !window.pluginsApi?.externalFetch) {
    return { ok: false, status: 0, data: null, error: 'External fetch API not available.' };
  }

  return window.pluginsApi.externalFetch({
    pluginId,
    url,
    method: options?.method ?? 'GET',
    headers: options?.headers,
  });
}
