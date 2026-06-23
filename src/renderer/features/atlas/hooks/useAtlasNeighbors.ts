/**
 * useAtlasNeighbors
 * 
 * Hook to fetch k-nearest neighbors for a file on hover.
 * Used for lazy edge loading in the Atlas visualization.
 */

import { useState, useCallback, useRef } from 'react';

export interface AtlasNeighbor {
  path: string;
  relativePath: string;
  score: number;
}

interface UseAtlasNeighborsResult {
  neighbors: AtlasNeighbor[];
  isLoading: boolean;
  fetchNeighbors: (filePath: string) => void;
  clearNeighbors: () => void;
}

export function useAtlasNeighbors(limit = 5): UseAtlasNeighborsResult {
  const [neighbors, setNeighbors] = useState<AtlasNeighbor[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const currentPathRef = useRef<string | null>(null);
  
  // Cache of already-fetched neighbors to avoid redundant calls
  const neighborsCache = useRef<Map<string, AtlasNeighbor[]>>(new Map());
  
  const fetchNeighbors = useCallback(async (filePath: string) => {
    // Return cached result if available
    const cached = neighborsCache.current.get(filePath);
    if (cached) {
      if (currentPathRef.current !== filePath) {
        currentPathRef.current = filePath;
        setNeighbors(cached);
      }
      return;
    }
    
    currentPathRef.current = filePath;
    setIsLoading(true);
    
    try {
      const result = await window.searchApi.atlasNeighbors({ path: filePath, limit });
      
      // Cache the result
      neighborsCache.current.set(filePath, result.neighbors);
      
      // Only update state if this is still the current request
      if (currentPathRef.current === filePath) {
        setNeighbors(result.neighbors);
      }
    } catch (err) {
      console.error('[Atlas] Failed to fetch neighbors:', err);
      if (currentPathRef.current === filePath) {
        setNeighbors([]);
      }
    } finally {
      if (currentPathRef.current === filePath) {
        setIsLoading(false);
      }
    }
  }, [limit]); // Removed neighbors.length - use ref cache instead
  
  const clearNeighbors = useCallback(() => {
    currentPathRef.current = null;
    neighborsCache.current.clear();
    setNeighbors([]);
  }, []);
  
  return {
    neighbors,
    isLoading,
    fetchNeighbors,
    clearNeighbors,
  };
}
