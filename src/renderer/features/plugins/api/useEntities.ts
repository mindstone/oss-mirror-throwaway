/**
 * useEntities — Plugin hook for listing/searching people and company metadata.
 *
 * Debounces IPC calls (300ms) when params change.
 */

import { useEffect, useRef, useState } from 'react';
import type { EntityEntry, UseEntitiesParams, UseEntitiesResult } from './types';
import { usePluginId } from './PluginContext';

export function useEntities(params?: UseEntitiesParams): UseEntitiesResult {
  const pluginId = usePluginId();
  const [entities, setEntities] = useState<EntityEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef(0);

  const paramsKey = JSON.stringify(params ?? {});

  useEffect(() => {
    setIsLoading(true);
    const requestId = ++abortRef.current;

    const timer = setTimeout(async () => {
      try {
        if (typeof window === 'undefined' || !window.pluginsApi?.getEntities) {
          throw new Error('Entities API not available');
        }

        const request: Record<string, unknown> = { pluginId };
        const query = params?.query?.trim();
        const company = params?.company?.trim();

        if (params?.entityType) request.entityType = params.entityType;
        if (query) request.query = query;
        if (company) request.company = company;
        if (params?.limit != null) request.limit = params.limit;

        const response = await window.pluginsApi.getEntities(
          request as Parameters<typeof window.pluginsApi.getEntities>[0],
        );

        if (requestId === abortRef.current) {
          setEntities(response.entities);
          setIsLoading(false);
          setError(null);
        }
      } catch (err) {
        if (requestId === abortRef.current) {
          setError(err instanceof Error ? err.message : 'Entity search failed');
          setIsLoading(false);
        }
      }
    }, 300);

    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: omitting pluginId/params object because plugin context is stable per mount and paramsKey is the debounced entity-search trigger
  }, [paramsKey]);

  return { entities, isLoading, error };
}
