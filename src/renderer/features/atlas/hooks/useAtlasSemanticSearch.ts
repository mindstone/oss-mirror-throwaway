/**
 * Atlas-only semantic spotlighting for the graph view.
 * Uses pre-fetched Atlas embeddings in the renderer to derive matched paths.
 * Neighbor-path dimming uses Stage 6's second-phase neighborhood hydration when available.
 */

import { useState, useEffect, useMemo, useRef } from 'react';
import type { AtlasNode } from './useAtlasProjection';

// Cosine similarity (vectors are L2-normalized, so dot product = cosine similarity)
function cosineSimilarity(a: number[], b: number[]): number {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  return dot;
}

export interface SemanticMatch {
  path: string;
  score: number;
  matchType: 'semantic' | 'keyword' | 'both';
}

interface UseAtlasSemanticSearchOptions {
  nodes: AtlasNode[];
  searchQuery: string;
  threshold?: number;        // Semantic similarity threshold (0-1)
  debounceMs?: number;       // Debounce delay for query embedding
}

interface UseAtlasSemanticSearchResult {
  matches: SemanticMatch[];          // Files matching the query (semantic + keyword)
  matchPaths: Set<string>;           // Set of matched file paths (for fast lookup)
  neighborPaths: Set<string>;        // Set of neighbor paths (for dimming)
  isSearching: boolean;              // Whether query embedding is in progress
  queryEmbedding: number[] | null;   // Current query embedding
  hasSemanticResults: boolean;       // Whether semantic results are available
}

export function useAtlasSemanticSearch(options: UseAtlasSemanticSearchOptions): UseAtlasSemanticSearchResult {
  const { 
    nodes, 
    searchQuery, 
    threshold = 0.5,
    debounceMs = 200,
  } = options;
  
  const [queryEmbedding, setQueryEmbedding] = useState<number[] | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);
  
  // Check if nodes have embeddings
  const hasEmbeddings = useMemo(() => {
    return nodes.some((node) => Boolean(node.embedding && node.embedding.length));
  }, [nodes]);
  
  // Fetch query embedding when search query changes (debounced)
  useEffect(() => {
    // Clear previous timer
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    
    // No query or no embeddings available
    if (!searchQuery?.trim() || !hasEmbeddings) {
      setQueryEmbedding(null);
      setIsSearching(false);
      return;
    }
    
    setIsSearching(true);
    
    // Debounce the embedding request
    debounceTimerRef.current = setTimeout(async () => {
      try {
        const result = await window.searchApi.atlasEmbedQuery({ query: searchQuery.trim() });
        if (result.embedding && result.embedding.length > 0) {
          setQueryEmbedding(result.embedding);
        } else {
          setQueryEmbedding(null);
        }
      } catch (err) {
        console.error('[Atlas Semantic] Failed to embed query:', err);
        setQueryEmbedding(null);
      } finally {
        setIsSearching(false);
      }
    }, debounceMs);
    
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, [searchQuery, hasEmbeddings, debounceMs]);
  
  // Compute semantic matches locally (~5ms for 2000 nodes)
  const matches = useMemo<SemanticMatch[]>(() => {
    // No search active
    if (!searchQuery?.trim()) {
      return [];
    }
    
    const query = searchQuery.toLowerCase().trim();
    const results: SemanticMatch[] = [];
    
    for (const node of nodes) {
      // Keyword match: filename or path contains query
      const keywordMatch = 
        node.name.toLowerCase().includes(query) || 
        node.relativePath.toLowerCase().includes(query);
      
      // Semantic match: cosine similarity above threshold
      let semanticScore = 0;
      let semanticMatch = false;
      
      if (queryEmbedding && node.embedding) {
        semanticScore = cosineSimilarity(queryEmbedding, node.embedding);
        semanticMatch = semanticScore >= threshold;
      }
      
      if (keywordMatch || semanticMatch) {
        results.push({
          path: node.path,
          score: semanticScore,
          matchType: keywordMatch && semanticMatch ? 'both' : keywordMatch ? 'keyword' : 'semantic',
        });
      }
    }
    
    // Sort by score (semantic similarity), with keyword matches boosted slightly
    results.sort((a, b) => {
      // Boost keyword matches
      const aBoost = a.matchType === 'keyword' || a.matchType === 'both' ? 0.1 : 0;
      const bBoost = b.matchType === 'keyword' || b.matchType === 'both' ? 0.1 : 0;
      return (b.score + bBoost) - (a.score + aBoost);
    });
    
    return results;
  }, [nodes, searchQuery, queryEmbedding, threshold]);
  
  // Set of matched paths for fast lookup
  const matchPaths = useMemo(() => {
    return new Set(matches.map(m => m.path));
  }, [matches]);
  
  // Set of neighbor paths (neighbors of matched files)
  // These will be dimmed (shown at 50% opacity)
  const neighborPaths = useMemo(() => {
    const neighbors = new Set<string>();
    
    // For each match, add hydrated neighbors when Stage 6's second-phase IPC has supplied them.
    // Stage 5 projections intentionally leave node.neighbors undefined.
    for (const match of matches) {
      const node = nodes.find(n => n.path === match.path);
      if (node?.neighbors && node.neighbors.length > 0) {
        for (const neighbor of node.neighbors) {
          // Don't add if it's already a primary match
          // Phase 8.6: neighbors are now objects with {path, similarity}
          if (!matchPaths.has(neighbor.path)) {
            neighbors.add(neighbor.path);
          }
        }
      }
    }
    
    return neighbors;
  }, [matches, nodes, matchPaths]);
  
  // Flag indicating if semantic results are ready (not just keyword)
  // This is true when we have a query embedding to compute semantic similarity
  const hasSemanticResults = queryEmbedding !== null && queryEmbedding.length > 0;
  
  return {
    matches,
    matchPaths,
    neighborPaths,
    isSearching,
    queryEmbedding,
    hasSemanticResults,
  };
}
