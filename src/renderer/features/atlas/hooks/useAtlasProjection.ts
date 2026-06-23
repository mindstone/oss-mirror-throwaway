/**
 * useAtlasProjection
 * 
 * Hook to fetch UMAP-projected file coordinates from the main process.
 * Handles loading, caching, and error states.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { getFileName } from '@renderer/utils/stringUtils';

// Phase 8.6: Neighbor with similarity score for ambient edge visualization
export interface AtlasNeighborWithSimilarity {
  path: string;
  similarity: number;  // Cosine similarity (0.0-1.0)
}

export interface AtlasNode {
  id: string;
  path: string;
  relativePath: string;
  name: string;
  x: number;
  y: number;
  z: number;
  extension: string;
  chunkCount: number;
  // Phase 7: Semantic search support (optional)
  embedding?: number[];  // 384-dim normalized embedding
  neighbors?: AtlasNeighborWithSimilarity[];  // Undefined post-Stage 5; Stage 6 neighborhood IPC hydrates this.
  // Phase 8: Recent file highlight + enhanced tooltips
  mtime?: number;  // File modification timestamp (ms since epoch)
  // Phase 9: Topic detection
  topic?: string;  // Detected topic name (e.g., "Meetings", "Research")
}

// Phase 11: LOD cluster for large dataset visualization
export interface AtlasCluster {
  id: number;
  centroid: { x: number; y: number; z: number };
  nodeCount: number;
  nodePaths: string[];           // All file paths in this cluster
  representativePaths: string[]; // Top-5 closest to centroid
  label: string | null;          // Topic label if dominant
}

interface UseAtlasProjectionOptions {
  includeEmbeddings?: boolean; // Include embeddings for semantic search
}

interface UseAtlasProjectionResult {
  nodes: AtlasNode[];
  clusters: AtlasCluster[];  // Phase 11: LOD clusters
  totalFileCount: number;    // Phase 11: Total files (may differ from nodes.length if sampled)
  isLoading: boolean;
  isComputing: boolean;
  error: string | null;
  cached: boolean;
  computedAt: number | null;
  hasEmbeddings: boolean;  // Whether nodes have embedding data; neighbors hydrate separately in Stage 6.
  neighborsLoading: boolean; // Whether second-phase neighborhood hydration is in flight.
  refetch: (forceRecompute?: boolean) => void;
}

export function useAtlasProjection(options: UseAtlasProjectionOptions = {}): UseAtlasProjectionResult {
  const { includeEmbeddings = false } = options;
  const [nodes, setNodes] = useState<AtlasNode[]>([]);
  const [clusters, setClusters] = useState<AtlasCluster[]>([]);
  const [totalFileCount, setTotalFileCount] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [isComputing, setIsComputing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cached, setCached] = useState(false);
  const [computedAt, setComputedAt] = useState<number | null>(null);
  const [hasEmbeddings, setHasEmbeddings] = useState(false);
  const [neighborsLoading, setNeighborsLoading] = useState(false);
  const [neighborhoodRefreshNonce, setNeighborhoodRefreshNonce] = useState(0);
  const neighborhoodGenerationRef = useRef(0);
  const lastNeighborhoodRefreshNonceRef = useRef(0);
  const lastNeighborhoodRequestKeyRef = useRef<string | null>(null);
  
  const fetchProjection = useCallback(async (forceRecompute = false) => {
    try {
      setIsLoading(true);
      setError(null);
      setNeighborsLoading(false);
      
      if (forceRecompute) {
        setIsComputing(true);
      }
      
      const result = await window.searchApi.atlasProjection({ 
        forceRecompute,
        includeEmbeddings,
      });
      
      // Transform to AtlasNode format
      const transformedNodes: AtlasNode[] = result.nodes.map(node => ({
        id: node.path,
        path: node.path,
        relativePath: node.relativePath,
        name: getFileName(node.relativePath),
        x: node.x,
        y: node.y,
        z: node.z,
        extension: node.extension,
        chunkCount: node.chunkCount,
        // Phase 7: Include embeddings if provided. Stage 5 projections leave
        // neighbors undefined until Stage 6's second-phase IPC hydrates them.
        embedding: node.embedding,
        neighbors: node.neighbors,
        // Phase 8: Include mtime for recent file highlight
        mtime: node.mtime,
        // Phase 9: Include topic classification
        topic: node.topic,
      }));
      
      setNodes(transformedNodes);
      setNeighborsLoading(transformedNodes.some(node => node.neighbors === undefined));
      setClusters(result.clusters);
      setTotalFileCount(result.totalFileCount);
      setCached(result.cached);
      setComputedAt(result.computedAt);
      // Check if any node has embeddings
      setHasEmbeddings(transformedNodes.some((node) => Boolean(node.embedding && node.embedding.length)));
      
    } catch (err) {
      const message = err instanceof Error ? err.message : "Couldn't fetch the projection";
      setError(message);
      setNeighborsLoading(false);
      console.error('[Atlas] Projection fetch error:', err);
    } finally {
      setIsLoading(false);
      setIsComputing(false);
    }
  }, [includeEmbeddings]);
  
  // Fetch on mount
  useEffect(() => {
    fetchProjection();
  }, [fetchProjection]);

  // Stage 6b: second-phase neighborhood hydration. Projection paints nodes
  // first; edges arrive shortly afterwards from the materialized file_neighbors table.
  useEffect(() => {
    if (nodes.length === 0) {
      setNeighborsLoading(false);
      return;
    }

    const hasPendingNeighbors = nodes.some(node => node.neighbors === undefined);
    const forceRefresh = neighborhoodRefreshNonce !== lastNeighborhoodRefreshNonceRef.current;
    if (!hasPendingNeighbors && !forceRefresh) {
      setNeighborsLoading(false);
      return;
    }

    const neighborhoodRequestKey = `${neighborhoodRefreshNonce}:${nodes.map(node => node.path).join('\0')}`;
    if (lastNeighborhoodRequestKeyRef.current === neighborhoodRequestKey) {
      setNeighborsLoading(hasPendingNeighbors);
      return;
    }
    lastNeighborhoodRequestKeyRef.current = neighborhoodRequestKey;
    lastNeighborhoodRefreshNonceRef.current = neighborhoodRefreshNonce;
    let cancelled = false;
    neighborhoodGenerationRef.current = Math.max(
      neighborhoodGenerationRef.current + 1000,
      Date.now() * 1000,
    );
    const generation = neighborhoodGenerationRef.current;
    setNeighborsLoading(true);

    const timer = setTimeout(async () => {
      try {
        const response = await window.searchApi.atlasNeighborhood({
          paths: nodes.map(node => node.path),
          limit: 5,
          generation,
        });

        if (cancelled) {
          return;
        }

        if (!response || response.generation !== generation) {
          setNeighborsLoading(false);
          return;
        }

        const hasNeighborsForPath = (nodePath: string) => (
          Object.prototype.hasOwnProperty.call(response.neighbors, nodePath)
        );
        const stillPending = nodes.some(node => (
          !hasNeighborsForPath(node.path) && node.neighbors === undefined
        ));
        setNodes(prev => prev.map(node => ({
          ...node,
          neighbors: hasNeighborsForPath(node.path)
            ? response.neighbors[node.path].map(neighbor => ({
              path: neighbor.path,
              similarity: neighbor.score,
            }))
            : node.neighbors,
        })));
        setNeighborsLoading(stillPending);
      } catch (err) {
        if (!cancelled) {
          console.error('[Atlas] Neighborhood fetch error:', err);
          setNeighborsLoading(false);
        }
      }
    }, 50);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [nodes, neighborhoodRefreshNonce]);

  useEffect(() => {
    const unsubscribeProgress = window.api?.onFileNeighborsProgress?.((event) => {
      setNeighborsLoading(event.total > 0 && event.filled < event.total);
    });
    const unsubscribeComplete = window.api?.onFileNeighborsComplete?.((event) => {
      if (event.aborted) {
        setNeighborsLoading(false);
        return;
      }
      setNeighborsLoading(event.total > 0);
      setNeighborhoodRefreshNonce(nonce => nonce + 1);
    });

    return () => {
      unsubscribeProgress?.();
      unsubscribeComplete?.();
    };
  }, []);
  
  return {
    nodes,
    clusters,
    totalFileCount,
    isLoading,
    isComputing,
    error,
    cached,
    computedAt,
    hasEmbeddings,
    neighborsLoading,
    refetch: fetchProjection,
  };
}
