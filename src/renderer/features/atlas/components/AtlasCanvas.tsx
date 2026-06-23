/**
 * AtlasCanvas
 * 
 * 3D/2D force-graph visualization of file embeddings.
 * Physics are disabled - PCA positions define the layout.
 * 
 * Phase 6 features:
 * - Hover edges: Show edges to 5 nearest neighbors on hover (debounced)
 * - Click to persist: Keep edges visible after click
 * - Space coloring: Color nodes by Space membership
 * - Search spotlight: Dim/hide non-matching nodes
 */

import { memo, useRef, useCallback, useMemo, useEffect, useState } from 'react';
import ForceGraph3D from 'react-force-graph-3d';
import ForceGraph2D from 'react-force-graph-2d';
import skmeans from 'skmeans';
import { SafeMarkdown } from '@renderer/components/SafeMarkdown';
import { tracking } from '@renderer/src/tracking';
import { ExternalLink, Sparkles, Map as MapIcon } from 'lucide-react';
import type { AtlasNode } from '../hooks/useAtlasProjection';
import type { AtlasNeighbor } from '../hooks/useAtlasNeighbors';
import { 
  ATLAS_CONFIG, 
  getNodeColor, 
  colorToRgba, 
  brightenColor, 
  isRecentFile,
  RECENT_SIZE_MULTIPLIER,
  RECENT_BRIGHTEN_AMOUNT,
} from '../utils/atlasConfig';
import { formatHistoryTimestamp } from '@renderer/utils/formatters';

// Debounce delay before fetching neighbors on hover (ms)
const HOVER_DEBOUNCE_MS = 150;

// Opacity levels for semantic search
const PRIMARY_MATCH_OPACITY = 1.0;   // Full opacity for matched files
const NEIGHBOR_OPACITY = 0.5;        // Dimmed for neighbor files

// Phase 8.6: Ambient edge configuration
const AMBIENT_EDGE_THRESHOLD = 0.7;     // Only show edges with similarity >= 0.7 (very strong relationships)
const AMBIENT_EDGE_MIN_OPACITY = 0.03;  // Nearly invisible at threshold
const AMBIENT_EDGE_MAX_OPACITY = 0.35;  // Subtle even at max (let nodes dominate)
const AMBIENT_EDGE_EXPONENT = 3;        // Cubic curve - emphasizes strongest connections
const ACTIVE_EDGE_OPACITY = 0.95;       // Highlighted edges for hovered/clicked node

// Phase 10: Cluster labels configuration
const MIN_NODES_FOR_CLUSTERS = 20;      // Don't cluster if fewer nodes
const MAX_CLUSTERS = 25;                // Cap cluster count for label display
const CLUSTER_LABEL_MIN_NODES = 3;      // Hide labels for clusters with fewer nodes

// Phase 11: Server-side cluster from backend
interface ServerCluster {
  id: number;
  centroid: { x: number; y: number; z: number };
  nodeCount: number;
  nodePaths: string[];
  representativePaths: string[];
  label: string | null;
}

interface AtlasCanvasProps {
  nodes: AtlasNode[];
  clusters?: ServerCluster[];         // Phase 11: Pre-computed clusters from backend
  totalFileCount?: number;            // Phase 11: Total files (for LOD decisions)
  is3D: boolean;
  onNodeClick?: (node: AtlasNode) => void;
  onNodeHover?: (node: AtlasNode | null) => void;
  // Neighbors for hover edges
  neighbors?: AtlasNeighbor[];
  onFetchNeighbors?: (filePath: string) => void;
  onClearNeighbors?: () => void;
  // Search spotlight
  searchQuery?: string;
  // Space coloring
  spaceColorMap?: Map<string, string>;
  // Phase 8: Space name lookup for tooltips
  spaceNameMap?: Map<string, string>;
  // Phase 7: Semantic search results
  semanticMatchPaths?: Set<string>;   // Primary semantic matches (full opacity)
  semanticNeighborPaths?: Set<string>; // Neighbors of matches (dimmed opacity)
  hasSemanticResults?: boolean;       // True when semantic (not just keyword) results are ready
  // Phase 10: Cluster labels
  showClusterLabels?: boolean;        // Toggle cluster label visibility
  // Space isolation - show only one space
  isolatedSpace?: string | null;
  // Hidden paths (e.g., system files hidden by default)
  hiddenPaths?: Set<string>;
  // Start a new conversation with files attached
  onStartConversation?: (message: string, filePaths: string[]) => void;
}

// Phase 10: Cluster data structure
interface ClusterInfo {
  id: number;
  centroid: { x: number; y: number; z: number };
  nodeCount: number;
  label: string | null;
}

interface ClusterLabelPosition extends ClusterInfo {
  screenX: number;
  screenY: number;
  visible: boolean;  // Whether cluster centroid is in front of camera
}

/**
 * Compute a label for a cluster based on dominant topic.
 * Returns null if no clear topic - clusters without topics should not be labeled.
 * 
 * Spaces are already shown via node colors, so we DON'T fall back to folder names.
 */
function computeClusterLabel(clusterNodes: AtlasNode[]): string | null {
  // Only use topics - spaces are already shown via colors
  const topicCounts = new Map<string, number>();
  for (const node of clusterNodes) {
    if (node.topic) {
      topicCounts.set(node.topic, (topicCounts.get(node.topic) || 0) + 1);
    }
  }
  
  if (topicCounts.size === 0) {
    return null;  // No topics in this cluster
  }
  
  // Find the most common topic
  let bestTopic: string | null = null;
  let bestCount = 0;
  
  for (const [topic, count] of topicCounts) {
    if (count > bestCount) {
      bestTopic = topic;
      bestCount = count;
    }
  }
  
  // Require at least 2 nodes with the topic, or 15% of cluster
  const threshold = Math.max(2, clusterNodes.length * 0.15);
  if (bestTopic && bestCount >= threshold) {
    return bestTopic;
  }
  
  return null;  // No dominant topic
}

interface GraphNode {
  id: string;
  x: number;
  y: number;
  z: number;
  fx?: number;
  fy?: number;
  fz?: number;
  name: string;
  relativePath: string;
  path: string; // Absolute path for neighbor matching
  extension: string;
  chunkCount: number;
  color: string;
  val: number;
  mtime?: number; // Phase 8: File modification timestamp
  topic?: string; // Phase 9: Detected topic name
}

interface GraphLink {
  source: string;
  target: string;
  similarity?: number;  // Phase 8.6: Similarity score for opacity mapping
  isActive?: boolean;   // Phase 8.6: True for hover/click edges (highlighted)
}

interface GraphData {
  nodes: GraphNode[];
  links: GraphLink[];
}

const getFileExtensionFromPath = (filePath: string): string => {
  const fileName = filePath.split(/[/\\]/).pop() ?? filePath;
  const extensionIndex = fileName.lastIndexOf('.');
  return extensionIndex > 0 ? fileName.slice(extensionIndex + 1).toLowerCase() : '';
};

export const AtlasCanvas = memo(function AtlasCanvas({
  nodes,
  clusters: serverClusters,
  is3D,
  onNodeClick,
  onNodeHover,
  neighbors = [],
  onFetchNeighbors,
  onClearNeighbors,
  searchQuery,
  spaceColorMap,
  spaceNameMap,
  semanticMatchPaths,
  semanticNeighborPaths,
  hasSemanticResults,
  showClusterLabels = true,
  isolatedSpace,
  hiddenPaths,
  onStartConversation,
}: AtlasCanvasProps) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ForceGraph ref type is not exported
  const graphRef = useRef<any>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });
  
  // Track which node has persisted edges (clicked)
  const [persistedNodeId, setPersistedNodeId] = useState<string | null>(null);
  
  // Track hovered node for edge display
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  
  // Debounce timer ref for hover
  const hoverDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wasWaitingForNeighborhoodRef = useRef(false);
  
  // File preview cache: path -> first ~150 chars of content
  const previewCacheRef = useRef<Map<string, string>>(new Map());
  const [previewLoadingPath, setPreviewLoadingPath] = useState<string | null>(null);
  // Trigger re-render when preview loads
  const [, setPreviewVersion] = useState(0);
  
  // AI Insights - unified cache with insight type
  // Only ONE insight is shown at a time (gist, zoom, or qa replace each other)
  interface NodeInsight {
    type: 'gist' | 'zoom' | 'qa';
    content: string;
    question?: string; // For Q&A type
  }
  const insightCacheRef = useRef<Map<string, NodeInsight>>(new Map());
  const [loadingInsight, setLoadingInsight] = useState<{ path: string; type: 'gist' | 'zoom' | 'qa' } | null>(null);
  
  // Input field state for Ask feature
  const [askInput, setAskInput] = useState('');
  
  // Tooltip state - we support two tooltips:
  // 1. selectedTooltip: The clicked/selected node (persists until deselected)
  // 2. hoverTooltip: The currently hovered node (only shows when different from selected)
  const [selectedTooltip, setSelectedTooltip] = useState<{
    node: GraphNode;
    x: number;
    y: number;
  } | null>(null);
  
  const [hoverTooltip, setHoverTooltip] = useState<{
    node: GraphNode;
    x: number;
    y: number;
  } | null>(null);
  
  // Track mouse position for tooltip (react-force-graph doesn't pass event to onNodeHover)
  const mousePosRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  
  // Track mouse down position for click detection (to distinguish from drag)
  const mouseDownPosRef = useRef<{ x: number; y: number } | null>(null);
  const CLICK_THRESHOLD = 5; // Max pixels mouse can move and still count as click
  
  // Track if camera is animating (suppress hover tooltips during zoom)
  const isAnimatingRef = useRef(false);
  
  // Phase 10: Cluster label positions (updated on camera change)
  const [clusterLabelPositions, setClusterLabelPositions] = useState<ClusterLabelPosition[]>([]);
  
  // Track container size and mouse position
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    
    const updateSize = () => {
      const rect = container.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        setDimensions({ width: rect.width, height: rect.height });
      }
    };
    
    // Track mouse position for tooltip
    const handleMouseMove = (e: MouseEvent) => {
      const rect = container.getBoundingClientRect();
      mousePosRef.current = {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      };
    };
    
    // Track mouse down for click detection
    const handleMouseDown = (e: MouseEvent) => {
      if (e.button === 0) { // Left click only
        mouseDownPosRef.current = { x: e.clientX, y: e.clientY };
      }
    };
    
    // Initial size
    updateSize();
    
    // Use ResizeObserver to track size changes
    const resizeObserver = new ResizeObserver(updateSize);
    resizeObserver.observe(container);
    
    // Listen for mouse events
    container.addEventListener('mousemove', handleMouseMove);
    container.addEventListener('mousedown', handleMouseDown);
    
    return () => {
      resizeObserver.disconnect();
      container.removeEventListener('mousemove', handleMouseMove);
      container.removeEventListener('mousedown', handleMouseDown);
    };
  }, []);
  
  // Cleanup WebGL context on unmount to prevent context exhaustion
  useEffect(() => {
    const graph = graphRef.current;
    return () => {
      try {
        if (graph) {
          // Clear graph data first (before disposing renderer)
          graph.graphData({ nodes: [], links: [] });
          
          // Then cleanup Three.js renderer
          const renderer = graph.renderer?.();
          if (renderer) {
            renderer.dispose();
            // forceContextLoss may not exist on all versions
            renderer.forceContextLoss?.();
          }
        }
      } catch (e) {
        console.warn('[Atlas] WebGL cleanup error:', e);
      }
    };
  }, []);
  
  // Build node lookup maps for O(1) access
  const { nodesById, nodesByPath } = useMemo(() => {
    const byId = new Map<string, GraphNode>();
    const byPath = new Map<string, GraphNode>();
    nodes.forEach(node => {
      // Phase 8: Recent files get larger size
      const baseVal = Math.max(1, Math.min(10, node.chunkCount));
      const isRecent = isRecentFile(node.mtime);
      const adjustedVal = isRecent ? baseVal * RECENT_SIZE_MULTIPLIER : baseVal;
      
      const graphNode: GraphNode = {
        id: node.id,
        x: node.x * 100,
        y: node.y * 100,
        z: node.z * 100,
        name: node.name,
        relativePath: node.relativePath,
        path: node.path,
        extension: node.extension,
        chunkCount: node.chunkCount,
        color: spaceColorMap?.get(node.path) || getNodeColor(node.extension),
        val: adjustedVal,
        mtime: node.mtime,
        topic: node.topic, // Phase 9: Include detected topic
      };
      byId.set(node.id, graphNode);
      byPath.set(node.path, graphNode);
    });
    return { nodesById: byId, nodesByPath: byPath };
  }, [nodes, spaceColorMap]);
  
  // Phase 10/11: Use server-side clusters when available, otherwise compute client-side
  const clusters = useMemo((): ClusterInfo[] => {
    // Phase 11: Use server clusters if provided
    if (serverClusters && serverClusters.length > 0) {
      // Convert server clusters to ClusterInfo format
      // Scale centroids to match client coordinate system (x100)
      const clusterInfos: ClusterInfo[] = serverClusters
        .filter(c => c.nodeCount >= CLUSTER_LABEL_MIN_NODES)
        .map(c => ({
          id: c.id,
          centroid: {
            x: c.centroid.x * 100,
            y: c.centroid.y * 100,
            z: c.centroid.z * 100,
          },
          nodeCount: c.nodeCount,
          label: c.label,
        }));
      
      // Deduplicate labels (keep only largest cluster per topic)
      const labelToLargestCluster = new Map<string, ClusterInfo>();
      for (const cluster of clusterInfos) {
        if (!cluster.label) continue;
        const existing = labelToLargestCluster.get(cluster.label);
        if (!existing || cluster.nodeCount > existing.nodeCount) {
          labelToLargestCluster.set(cluster.label, cluster);
        }
      }
      
      const largestClusterIds = new Set(
        Array.from(labelToLargestCluster.values()).map(c => c.id)
      );
      
      return clusterInfos.map(cluster => ({
        ...cluster,
        label: cluster.label && largestClusterIds.has(cluster.id) ? cluster.label : null,
      }));
    }
    
    // Fallback: Compute clusters client-side (original Phase 10 logic)
    if (nodes.length < MIN_NODES_FOR_CLUSTERS) return [];
    
    // Extract positions (scaled coordinates)
    const positions = nodes.map(n => [n.x * 100, n.y * 100, n.z * 100]);
    
    // Determine k: sqrt(n/2), capped at MAX_CLUSTERS
    const k = Math.min(MAX_CLUSTERS, Math.ceil(Math.sqrt(nodes.length / 2)));
    
    try {
      // Run k-means with k-means++ initialization ("kmpp"), 10 iterations
      const result = skmeans(positions, k, 'kmpp', 10);
      
      // Build cluster info with labels
      const clusterInfos: ClusterInfo[] = [];
      
      for (let i = 0; i < result.centroids.length; i++) {
        const centroid = result.centroids[i];
        const clusterNodeIndices = result.idxs
          .map((idx, nodeIdx) => (idx === i ? nodeIdx : -1))
          .filter(idx => idx !== -1);
        
        if (clusterNodeIndices.length < CLUSTER_LABEL_MIN_NODES) continue;
        
        // Get nodes in this cluster
        const clusterNodes = clusterNodeIndices.map(idx => nodes[idx]);
        
        // Compute label: topic only (no folder/extension fallback)
        const label = computeClusterLabel(clusterNodes);
        
        clusterInfos.push({
          id: i,
          centroid: { x: centroid[0], y: centroid[1], z: centroid[2] },
          nodeCount: clusterNodes.length,
          label,
        });
      }
      
      // Deduplicate: if multiple clusters have the same topic label,
      // keep only the one with the most nodes
      const labelToLargestCluster = new Map<string, ClusterInfo>();
      for (const cluster of clusterInfos) {
        if (!cluster.label) continue;
        const existing = labelToLargestCluster.get(cluster.label);
        if (!existing || cluster.nodeCount > existing.nodeCount) {
          labelToLargestCluster.set(cluster.label, cluster);
        }
      }
      
      // Return all clusters, but clear duplicate labels (keep only largest)
      const largestClusterIds = new Set(
        Array.from(labelToLargestCluster.values()).map(c => c.id)
      );
      
      return clusterInfos.map(cluster => ({
        ...cluster,
        // Clear label if this isn't the largest cluster with this topic
        label: cluster.label && largestClusterIds.has(cluster.id) ? cluster.label : null,
      }));
    } catch {
      // skmeans can fail with degenerate data
      return [];
    }
  }, [nodes, serverClusters]);
  
  // Compute links based on neighbors and current node (either hovered or persisted)
  // Check if a node is visible (for filtering edges)
  // This needs to match nodeVisibility logic but work with GraphNode
  // Phase 7: Updated to handle semantic search results
  // Space isolation: Also filter by isolated space
  // Hidden paths: Also filter out system files
  const isNodeVisible = useCallback((node: GraphNode): boolean => {
    // Hidden paths filter (e.g., system files hidden by default)
    if (hiddenPaths?.has(node.path)) {
      return false;
    }
    
    // Space isolation filter
    if (isolatedSpace && spaceNameMap) {
      const nodeSpace = spaceNameMap.get(node.path);
      if (nodeSpace !== isolatedSpace) {
        return false;
      }
    }
    
    if (!searchQuery?.trim()) return true;
    
    // If semantic search results are ready (not just keyword matches), use them
    if (hasSemanticResults && semanticMatchPaths) {
      return semanticMatchPaths.has(node.path) || 
             (semanticNeighborPaths?.has(node.path) ?? false);
    }
    
    // Fallback: keyword search (before semantic results arrive)
    const query = searchQuery.toLowerCase().trim();
    return node.name.toLowerCase().includes(query) ||
           node.relativePath.toLowerCase().includes(query);
  }, [searchQuery, hasSemanticResults, semanticMatchPaths, semanticNeighborPaths, isolatedSpace, spaceNameMap, hiddenPaths]);
  
  // Phase 8.6: Build ambient edges from hydrated node neighbors.
  // Stage 5 projections intentionally leave node.neighbors undefined; Stage 6
  // fills them through second-phase neighborhood IPC so the first frame can paint.
  const ambientEdges = useMemo((): GraphLink[] => {
    const edgeMap = new Map<string, GraphLink>();
    
    for (const node of nodes) {
      if (!node.neighbors || node.neighbors.length === 0) continue;
      
      const sourceNode = nodesById.get(node.id);
      if (!sourceNode) continue;
      
      for (const neighbor of node.neighbors) {
        // Skip if below threshold
        if (neighbor.similarity < AMBIENT_EDGE_THRESHOLD) continue;
        
        const targetNode = nodesByPath.get(neighbor.path);
        if (!targetNode || targetNode.id === sourceNode.id) continue;
        
        // Create canonical key to deduplicate bidirectional edges
        const key = [sourceNode.id, targetNode.id].sort().join('|');
        
        // Keep the edge with higher similarity if we've seen this pair before
        const existing = edgeMap.get(key);
        if (!existing || (neighbor.similarity > (existing.similarity || 0))) {
          edgeMap.set(key, {
            source: sourceNode.id,
            target: targetNode.id,
            similarity: neighbor.similarity,
            isActive: false,
          });
        }
      }
    }
    
    return Array.from(edgeMap.values());
  }, [nodes, nodesById, nodesByPath]);
  
  // Compute active links (hover/click edges) - these get highlighted
  const activeLinks = useMemo((): GraphLink[] => {
    if (!neighbors || neighbors.length === 0) return [];
    
    // Use persisted node if set, otherwise hovered node
    const activeNodeId = persistedNodeId || hoveredNodeId;
    if (!activeNodeId) return [];
    
    const sourceNode = nodesById.get(activeNodeId);
    if (!sourceNode) return [];
    
    // Don't show edges if source node is hidden
    if (!isNodeVisible(sourceNode)) return [];
    
    const links: GraphLink[] = [];
    for (const neighbor of neighbors) {
      const targetNode = nodesByPath.get(neighbor.path);
      // Only add edge if target exists, is different from source, AND is visible
      if (targetNode && targetNode.id !== sourceNode.id && isNodeVisible(targetNode)) {
        links.push({
          source: sourceNode.id,
          target: targetNode.id,
          isActive: true,  // Mark as active for highlighting
        });
      }
    }
    return links;
  }, [neighbors, persistedNodeId, hoveredNodeId, nodesById, nodesByPath, isNodeVisible]);
  
  // Set of active edge keys for fast lookup (to override ambient edge styling)
  const activeEdgeKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const link of activeLinks) {
      keys.add([link.source, link.target].sort().join('|'));
    }
    return keys;
  }, [activeLinks]);
  
  // Helper to extract node ID from link source/target
  // react-force-graph mutates links to replace string IDs with node object references
  const getLinkNodeId = useCallback((sourceOrTarget: string | GraphNode | { id: string }): string => {
    if (typeof sourceOrTarget === 'string') return sourceOrTarget;
    if (sourceOrTarget && typeof sourceOrTarget === 'object' && 'id' in sourceOrTarget) {
      return sourceOrTarget.id;
    }
    return '';
  }, []);
  
  // Merge ambient and active edges, filtering by visibility during search
  const currentLinks = useMemo((): GraphLink[] => {
    // Start with ambient edges, filtering by node visibility
    const visibleAmbient = ambientEdges.filter((link) => {
      // Handle react-force-graph's mutation of link.source/target to node objects
      const sourceId = getLinkNodeId(link.source);
      const targetId = getLinkNodeId(link.target);
      const sourceNode = nodesById.get(sourceId);
      const targetNode = nodesById.get(targetId);
      if (!sourceNode || !targetNode) {
        return false;
      }
      
      // During search, only show edges where both nodes are visible
      if (searchQuery?.trim()) {
        return isNodeVisible(sourceNode) && isNodeVisible(targetNode);
      }
      return true;
    });
    
    // Mark ambient edges as active if they're also in activeLinks
    const mergedAmbient = visibleAmbient.map(link => {
      const key = [link.source, link.target].sort().join('|');
      if (activeEdgeKeys.has(key)) {
        return { ...link, isActive: true };
      }
      return link;
    });
    
    // Add any active edges that weren't in ambient (shouldn't happen often, but safety)
    const ambientKeys = new Set(mergedAmbient.map(l => [l.source, l.target].sort().join('|')));
    const newActiveEdges = activeLinks.filter(link => {
      const key = [link.source, link.target].sort().join('|');
      return !ambientKeys.has(key);
    });
    
    return [...mergedAmbient, ...newActiveEdges];
  }, [ambientEdges, activeLinks, activeEdgeKeys, nodesById, searchQuery, isNodeVisible, getLinkNodeId]);
  
  const isWaitingForNeighborhood = nodes.some(node => node.neighbors === undefined);

  // Transform AtlasNodes to graph format (include computed links)
  const graphData: GraphData = useMemo(() => {
    const graphNodes = Array.from(nodesById.values()).map(node => {
      if (!isWaitingForNeighborhood) {
        return node;
      }
      return {
        ...node,
        fx: node.x,
        fy: node.y,
        fz: node.z,
      };
    });
    return {
      nodes: graphNodes,
      links: currentLinks,
    };
  }, [nodesById, currentLinks, isWaitingForNeighborhood]);
  
  // Track if a node was clicked (to distinguish from background clicks)
  const nodeClickedRef = useRef(false);
  
  // Extract preview text from file content, handling frontmatter intelligently
  const extractPreview = useCallback((content: string): string => {
    if (!content.trim()) return '(empty file)';
    
    let textContent = content;
    let frontmatterDescription: string | null = null;
    
    // Check for YAML frontmatter (starts with ---)
    if (content.startsWith('---')) {
      const endMatch = content.slice(3).indexOf('---');
      if (endMatch !== -1) {
        const frontmatter = content.slice(3, endMatch + 3);
        textContent = content.slice(endMatch + 6).trim(); // Skip past closing ---
        
        // Try to extract description from frontmatter
        const descMatch = frontmatter.match(/^description:\s*["']?(.+?)["']?\s*$/m);
        if (descMatch) {
          frontmatterDescription = descMatch[1].trim();
        }
      }
    }
    
    // If we found a description in frontmatter, use it
    if (frontmatterDescription) {
      if (frontmatterDescription.length > 200) {
        const truncated = frontmatterDescription.slice(0, 200);
        const lastSpace = truncated.lastIndexOf(' ');
        return (lastSpace > 150 ? truncated.slice(0, lastSpace) : truncated) + '...';
      }
      return frontmatterDescription;
    }
    
    // Otherwise extract from main content
    const lines = textContent.split('\n');
    const meaningfulLines: string[] = [];
    const TARGET_LENGTH = 200; // Aim for ~200 chars before truncating
    
    for (const line of lines) {
      const trimmed = line.trim();
      
      // Skip empty lines
      if (!trimmed) continue;
      
      // Skip markdown headers at the very start (but allow them later)
      if (trimmed.startsWith('#') && meaningfulLines.length === 0) continue;
      
      // Skip lines that are just markdown syntax (hr, list markers alone, etc.)
      if (/^[-*_]{3,}$/.test(trimmed)) continue;
      if (/^[-*+]\s*$/.test(trimmed)) continue;
      
      // Clean up the line
      const cleaned = trimmed
        .replace(/^#+\s*/, '') // Remove markdown headers
        .replace(/\*\*(.+?)\*\*/g, '$1') // Remove bold
        .replace(/\*(.+?)\*/g, '$1') // Remove italic
        .replace(/`(.+?)`/g, '$1') // Remove inline code
        .replace(/\[(.+?)\]\(.+?\)/g, '$1') // Convert links to text
        .replace(/^[-*+]\s+/, ''); // Remove list markers
      
      if (cleaned) {
        meaningfulLines.push(cleaned);
        // Stop once we have enough content
        if (meaningfulLines.join(' ').length >= TARGET_LENGTH) break;
      }
      
      // Stop after 10 lines max to avoid processing huge files
      if (meaningfulLines.length >= 10) break;
    }
    
    const preview = meaningfulLines.join(' ').trim();
    if (!preview) return '(no preview available)';
    
    // Truncate to ~200 chars, trying to break at word boundary
    if (preview.length > 200) {
      const truncated = preview.slice(0, 200);
      const lastSpace = truncated.lastIndexOf(' ');
      return (lastSpace > 150 ? truncated.slice(0, lastSpace) : truncated) + '...';
    }
    
    return preview;
  }, []);
  
  // Helper to load preview for a node
  const loadPreview = useCallback((path: string) => {
    const cachedPreview = previewCacheRef.current.get(path);
    if (cachedPreview !== undefined) return; // Already cached (even empty string)
    
    setPreviewLoadingPath(path);
    window.libraryApi.readFile(path)
      .then(result => {
        const preview = extractPreview(result.content || '');
        previewCacheRef.current.set(path, preview);
        setPreviewLoadingPath(prev => prev === path ? null : prev);
        setPreviewVersion(v => v + 1);
      })
      .catch(() => {
        previewCacheRef.current.set(path, '');
        setPreviewLoadingPath(prev => prev === path ? null : prev);
      });
  }, [extractPreview]);
  
  // Fetch AI summary for "The gist" button - replaces any existing insight
  const fetchGist = useCallback(async (path: string) => {
    setLoadingInsight({ path, type: 'gist' });
    try {
      const result = await window.searchApi.atlasSummarizeFile({ filePath: path });
      if (result.summary) {
        insightCacheRef.current.set(path, { type: 'gist', content: result.summary });
      } else if (result.error) {
        insightCacheRef.current.set(path, { type: 'gist', content: `Error: ${result.error}` });
      }
    } catch {
      insightCacheRef.current.set(path, { type: 'gist', content: 'Failed to generate summary' });
    } finally {
      setLoadingInsight(null);
      setPreviewVersion(v => v + 1);
    }
  }, []);
  
  // Fetch neighborhood insight for "Zoom out" button - replaces any existing insight
  const fetchZoomOut = useCallback(async (centerPath: string) => {
    if (neighbors.length === 0) return;
    
    setLoadingInsight({ path: centerPath, type: 'zoom' });
    try {
      const result = await window.searchApi.atlasSummarizeNeighborhood({
        centerFilePath: centerPath,
        neighborFilePaths: neighbors.map(n => n.path),
      });
      
      if (result.insight) {
        insightCacheRef.current.set(centerPath, { type: 'zoom', content: result.insight });
      } else if (result.error) {
        insightCacheRef.current.set(centerPath, { type: 'zoom', content: `Error: ${result.error}` });
      }
    } catch {
      insightCacheRef.current.set(centerPath, { type: 'zoom', content: 'Failed to analyze neighborhood' });
    } finally {
      setLoadingInsight(null);
      setPreviewVersion(v => v + 1);
    }
  }, [neighbors]);
  
  // Ask a question about the files - replaces any existing insight
  const askQuestion = useCallback(async (centerPath: string, question: string) => {
    if (!question.trim()) return;
    
    setLoadingInsight({ path: centerPath, type: 'qa' });
    try {
      const result = await window.searchApi.atlasAskQuestion({
        centerFilePath: centerPath,
        neighborFilePaths: neighbors.map(n => n.path),
        question: question.trim(),
      });
      
      if (result.answer) {
        insightCacheRef.current.set(centerPath, { type: 'qa', content: result.answer, question: question.trim() });
      } else if (result.error) {
        insightCacheRef.current.set(centerPath, { type: 'qa', content: `Error: ${result.error}`, question: question.trim() });
      }
    } catch {
      insightCacheRef.current.set(centerPath, { type: 'qa', content: 'Failed to answer question', question: question.trim() });
    } finally {
      setLoadingInsight(null);
      setAskInput('');
      setPreviewVersion(v => v + 1);
    }
  }, [neighbors]);
  
  // Handle node click - select node (persist tooltip), don't open file
  const handleNodeClick = useCallback((node: GraphNode) => {
    // Mark that we clicked a node (not background)
    nodeClickedRef.current = true;
    
    // Persist selection for this node
    setPersistedNodeId(node.id);
    setHoveredNodeId(node.id);
    
    // Clear hover tooltip since this node is now selected
    setHoverTooltip(null);
    
    // Fetch neighbors for this node
    if (onFetchNeighbors) {
      onFetchNeighbors(node.path);
    }
    
    // Load preview
    loadPreview(node.path);
    
    // Focus camera on clicked node (3D only) and show tooltip after animation
    if (graphRef.current && is3D) {
      const distance = 200;
      const animationDuration = 1000;
      
      // Suppress hover tooltips during camera animation
      isAnimatingRef.current = true;
      
      graphRef.current.cameraPosition(
        { x: node.x, y: node.y, z: node.z + distance },
        node,
        animationDuration
      );
      
      // Show tooltip after camera animation completes at the node's final screen position
      setTimeout(() => {
        isAnimatingRef.current = false;
        if (graphRef.current?.graph2ScreenCoords) {
          const screenPos = graphRef.current.graph2ScreenCoords(node.x, node.y, node.z);
          setSelectedTooltip({
            node,
            x: screenPos.x,
            y: screenPos.y,
          });
        }
      }, animationDuration + 50);
    } else {
      // 2D mode: show tooltip immediately at mouse position
      setSelectedTooltip({
        node,
        x: mousePosRef.current.x,
        y: mousePosRef.current.y,
      });
    }
    
    // Reset flag after a tick (to allow background click detection)
    setTimeout(() => { nodeClickedRef.current = false; }, 0);
  }, [onFetchNeighbors, is3D, loadPreview]);
  
  // Handle opening file from tooltip button
  const handleOpenFile = useCallback((tooltip: { node: GraphNode } | null) => {
    if (tooltip && onNodeClick) {
      const atlasNode = nodes.find(n => n.id === tooltip.node.id);
      if (atlasNode) {
        tracking.library.atlas.fileOpened(getFileExtensionFromPath(atlasNode.path));
        onNodeClick(atlasNode);
      }
    }
  }, [nodes, onNodeClick]);
  
  // Clear selection (used by background click and Escape key)
  const clearSelection = useCallback(() => {
    setPersistedNodeId(null);
    setHoveredNodeId(null);
    setSelectedTooltip(null);
    setHoverTooltip(null);
    onClearNeighbors?.();
  }, [onClearNeighbors]);
  
  // Handle background click - clear selection
  // Note: react-force-graph's onBackgroundClick can be unreliable with orbit controls
  const _handleBackgroundClick = useCallback(() => {
    // Only clear if we didn't just click a node
    if (!nodeClickedRef.current) {
      clearSelection();
    }
  }, [clearSelection]);
  
  // Handle node hover - show hover tooltip (can coexist with selected tooltip)
  const handleNodeHover = useCallback((node: GraphNode | null) => {
    // Clear any pending debounce
    if (hoverDebounceRef.current) {
      clearTimeout(hoverDebounceRef.current);
      hoverDebounceRef.current = null;
    }
    
    // Call external hover handler
    if (onNodeHover) {
      const atlasNode = node ? nodes.find(n => n.id === node.id) : null;
      onNodeHover(atlasNode || null);
    }
    
    // Update hover tooltip
    if (node) {
      // Don't show hover tooltip for the selected node (it already has selectedTooltip)
      if (persistedNodeId && node.id === persistedNodeId) {
        setHoverTooltip(null);
        return;
      }
      
      // Don't show hover tooltip during camera animation (prevents flicker as we zoom through nodes)
      if (isAnimatingRef.current) {
        return;
      }
      
      // Show hover tooltip for this node
      setHoverTooltip({
        node,
        x: mousePosRef.current.x,
        y: mousePosRef.current.y,
      });
      
      // Only update hoveredNodeId if no selection (for edge highlighting)
      if (!persistedNodeId) {
        setHoveredNodeId(node.id);
        
        // Debounce neighbor fetch only when no selection
        if (onFetchNeighbors) {
          hoverDebounceRef.current = setTimeout(() => {
            onFetchNeighbors(node.path);
          }, HOVER_DEBOUNCE_MS);
        }
      }
      
      // Load preview for hover tooltip
      loadPreview(node.path);
    } else {
      // Mouse left node - clear hover tooltip
      setHoverTooltip(null);
      
      // Only clear hoveredNodeId if no selection
      if (!persistedNodeId) {
        setHoveredNodeId(null);
        setPreviewLoadingPath(null);
      }
    }
  }, [nodes, onNodeHover, onFetchNeighbors, persistedNodeId, loadPreview]);
  
  // Cleanup debounce on unmount
  useEffect(() => {
    return () => {
      if (hoverDebounceRef.current) {
        clearTimeout(hoverDebounceRef.current);
      }
    };
  }, []);
  
  // Handle Escape key to clear selection
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && persistedNodeId) {
        clearSelection();
      }
    };
    
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [persistedNodeId, clearSelection]);
  
  // Custom click detection - bypasses orbit controls' interference
  // We track mousedown position and on mouseup check if it was a "click" (minimal movement)
  // Then do manual hit testing against node screen positions
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    
    const handleMouseUp = (e: MouseEvent) => {
      if (e.button !== 0) return; // Left click only
      
      // Ignore clicks inside the tooltip overlay (buttons, etc.)
      const target = e.target as HTMLElement;
      if (target.closest('[data-atlas-tooltip]')) {
        return;
      }
      
      const downPos = mouseDownPosRef.current;
      if (!downPos) return;
      
      // Check if this was a click (minimal movement) vs a drag
      const dx = e.clientX - downPos.x;
      const dy = e.clientY - downPos.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      
      mouseDownPosRef.current = null; // Reset
      
      if (distance > CLICK_THRESHOLD) {
        // This was a drag, not a click
        return;
      }
      
      // This was a click - do hit testing
      const graph = graphRef.current;
      if (!graph?.graph2ScreenCoords) return;
      
      const rect = container.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const clickY = e.clientY - rect.top;
      
      // Find the closest node to the click position
      let closestNode: GraphNode | null = null;
      let closestDistance = Infinity;
      const hitRadius = 20; // Pixels - how close click needs to be to node center
      
      for (const node of graphData.nodes as GraphNode[]) {
        if (!node.x || !node.y) continue;
        
        // Get screen position of node
        const screenPos = graph.graph2ScreenCoords(node.x, node.y, node.z || 0);
        if (!screenPos) continue;
        
        const nodeDx = screenPos.x - clickX;
        const nodeDy = screenPos.y - clickY;
        const nodeDistance = Math.sqrt(nodeDx * nodeDx + nodeDy * nodeDy);
        
        if (nodeDistance < hitRadius && nodeDistance < closestDistance) {
          closestNode = node;
          closestDistance = nodeDistance;
        }
      }
      
      if (closestNode) {
        // Clicked on a node
        handleNodeClick(closestNode);
      } else {
        // Clicked on background
        clearSelection();
      }
    };
    
    container.addEventListener('mouseup', handleMouseUp);
    return () => container.removeEventListener('mouseup', handleMouseUp);
  }, [graphData.nodes, handleNodeClick, clearSelection]);
  
  // Search spotlight - hide non-matching nodes when searching
  const normalizedQuery = useMemo(() => searchQuery?.toLowerCase().trim() || '', [searchQuery]);
  
  // Check if a node matches the search query (keyword match)
  const nodeMatchesKeywordQuery = useCallback((node: GraphNode) => {
    if (!normalizedQuery) return true;
    return node.name.toLowerCase().includes(normalizedQuery) ||
           node.relativePath.toLowerCase().includes(normalizedQuery);
  }, [normalizedQuery]);
  
  // Visibility: Show node if it matches or is a neighbor of a match
  // When semantic search is active, use semantic results
  // Otherwise, fall back to keyword-only search
  // Space isolation: Also filter by isolated space
  // Hidden paths: Filter out system files when not shown
  const nodeVisibility = useCallback((node: GraphNode) => {
    // Hidden paths filter (e.g., system files hidden by default)
    if (hiddenPaths?.has(node.path)) {
      return false;
    }
    
    // Space isolation filter
    if (isolatedSpace && spaceNameMap) {
      const nodeSpace = spaceNameMap.get(node.path);
      if (nodeSpace !== isolatedSpace) {
        return false;
      }
    }
    
    // No search - show all nodes (that pass filters)
    if (!normalizedQuery) return true;
    
    // Phase 7: If semantic results are ready, use them
    if (hasSemanticResults && semanticMatchPaths) {
      // Show primary matches and their neighbors
      return semanticMatchPaths.has(node.path) || 
             (semanticNeighborPaths?.has(node.path) ?? false);
    }
    
    // Fallback: Keyword-only search (Phase 6 behavior, before semantic results arrive)
    return nodeMatchesKeywordQuery(node);
  }, [normalizedQuery, hasSemanticResults, semanticMatchPaths, semanticNeighborPaths, nodeMatchesKeywordQuery, isolatedSpace, spaceNameMap, hiddenPaths]);
  
  // Phase 7+8: Node color with RGBA alpha for per-node opacity + recent file brightening
  // Primary matches: full opacity, Neighbors: dimmed, Recent files: brightened
  const nodeColor = useCallback((node: GraphNode) => {
    let baseColor = node.color;
    
    // Phase 8: Brighten recent files
    const isRecent = isRecentFile(node.mtime);
    if (isRecent) {
      baseColor = brightenColor(baseColor, RECENT_BRIGHTEN_AMOUNT);
    }
    
    // No search active - use (possibly brightened) base color
    if (!normalizedQuery) {
      return baseColor;
    }
    
    // Phase 7: If semantic results are ready, apply opacity based on match type
    if (hasSemanticResults && semanticMatchPaths) {
      if (semanticMatchPaths.has(node.path)) {
        // Primary match - full opacity
        return colorToRgba(baseColor, PRIMARY_MATCH_OPACITY);
      } else if (semanticNeighborPaths?.has(node.path)) {
        // Neighbor of match - dimmed
        return colorToRgba(baseColor, NEIGHBOR_OPACITY);
      }
    }
    
    // Keyword-only mode or no special handling - full opacity
    return colorToRgba(baseColor, PRIMARY_MATCH_OPACITY);
  }, [normalizedQuery, hasSemanticResults, semanticMatchPaths, semanticNeighborPaths]);
  
  const nodeVal = useCallback((node: GraphNode) => node.val, []);
  
  // Phase 8.6: Link color with opacity based on similarity score
  // Active (hover/click) edges are bright, ambient edges vary by similarity
  const linkColor = useCallback((link: GraphLink) => {
    // Active edges (hover/click) are highlighted
    if (link.isActive) {
      return `rgba(0, 255, 255, ${ACTIVE_EDGE_OPACITY})`; // Bright cyan
    }
    
    // Ambient edges: cubic opacity mapping for emphasis on strongest connections
    const similarity = link.similarity ?? AMBIENT_EDGE_THRESHOLD;
    const normalizedSim = Math.max(0, (similarity - AMBIENT_EDGE_THRESHOLD) / (1 - AMBIENT_EDGE_THRESHOLD));
    const opacity = AMBIENT_EDGE_MIN_OPACITY + Math.pow(normalizedSim, AMBIENT_EDGE_EXPONENT) * (AMBIENT_EDGE_MAX_OPACITY - AMBIENT_EDGE_MIN_OPACITY);
    
    // Subtle cool violet for ambient edges - recedes into dark background
    // Complements the colorful nodes without competing
    return `rgba(140, 130, 180, ${opacity.toFixed(3)})`;
  }, []);
  
  // Pin every node's position once the simulation cools so subsequent
  // graphData changes (search filter, hover-driven active edges, etc.) don't
  // re-warm d3-force and shake the semantic layout. Also re-fit the camera
  // because the simulation typically expands the cloud well past the initial
  // PCA seed range, leaving the original zoomToFit framing wrong.
  const handleEngineStop = useCallback(() => {
    const graph = graphRef.current;
    if (!graph?.graphData) return;
    const data = graph.graphData();
    if (!data?.nodes) return;
    for (const n of data.nodes as Array<{
      x?: number; y?: number; z?: number;
      fx?: number; fy?: number; fz?: number;
    }>) {
      if (typeof n.x === 'number') n.fx = n.x;
      if (typeof n.y === 'number') n.fy = n.y;
      if (typeof n.z === 'number') n.fz = n.z;
    }
    graph.zoomToFit?.(600, 80);
  }, []);

  const pinCurrentGraphNodes = useCallback((pinned: boolean) => {
    const graph = graphRef.current;
    if (!graph?.graphData) return;
    const data = graph.graphData();
    if (!data?.nodes) return;

    for (const n of data.nodes as GraphNode[]) {
      if (pinned) {
        n.fx = n.x;
        n.fy = n.y;
        n.fz = n.z;
      } else {
        delete n.fx;
        delete n.fy;
        delete n.fz;
      }
    }
  }, []);

  // Force-directed mode only runs when we have semantic edges (top-K
  // similarity neighbours hydrated after projection). Without edges, the simulation
  // has no springs to encode similarity, so any physics just inflates the
  // PCA sphere uniformly and makes the cloud sparser without adding value.
  // Stage 5 projections have no inline neighbors, so they fall through to the
  // static PCA layout until Stage 6 neighborhood IPC supplies edges.
  const hasSemanticEdges = graphData.links.length > 0;
  const shouldRunForces = hasSemanticEdges && !isWaitingForNeighborhood;

  useEffect(() => {
    if (nodes.length === 0) {
      wasWaitingForNeighborhoodRef.current = false;
      return;
    }

    if (isWaitingForNeighborhood) {
      wasWaitingForNeighborhoodRef.current = true;
      pinCurrentGraphNodes(true);
      return;
    }

    const shouldReheat = wasWaitingForNeighborhoodRef.current && hasSemanticEdges;
    wasWaitingForNeighborhoodRef.current = false;
    pinCurrentGraphNodes(false);
    if (shouldReheat) {
      graphRef.current?.d3ReheatSimulation?.();
    }
  }, [graphData, hasSemanticEdges, isWaitingForNeighborhood, nodes.length, pinCurrentGraphNodes]);

  // Common props for both 2D and 3D
  // Note: We handle clicks ourselves via mouseup hit testing (see custom click detection effect)
  // because react-force-graph's onNodeClick is unreliable with orbit/trackball controls
  const commonProps = useMemo(() => ({
    graphData,
    nodeId: 'id',
    nodeLabel: () => '', // Disable built-in tooltip, we use custom overlay
    nodeColor,
    nodeVal,
    nodeRelSize: ATLAS_CONFIG.nodeRelSize,
    nodeOpacity: ATLAS_CONFIG.nodeOpacity,
    nodeVisibility,
    onNodeHover: handleNodeHover,
    onEngineStop: handleEngineStop,
    d3AlphaDecay: shouldRunForces ? ATLAS_CONFIG.d3AlphaDecay : 1,
    d3VelocityDecay: shouldRunForces ? ATLAS_CONFIG.d3VelocityDecay : 1,
    warmupTicks: ATLAS_CONFIG.warmupTicks,
    cooldownTicks: shouldRunForces ? ATLAS_CONFIG.cooldownTicks : 0,
    // Links
    linkOpacity: ATLAS_CONFIG.linkOpacity,
    linkWidth: ATLAS_CONFIG.linkWidth,
    linkColor,
  }), [graphData, nodeColor, nodeVal, nodeVisibility, handleNodeHover, linkColor, handleEngineStop, shouldRunForces]);
  useEffect(() => {
    if (!shouldRunForces) return;
    const graph = graphRef.current;
    if (!graph?.d3Force || nodes.length === 0) return;
    try {
      const linkForce = graph.d3Force('link');
      if (linkForce) {
        linkForce.distance(ATLAS_CONFIG.forces.linkDistance);
        linkForce.strength(ATLAS_CONFIG.forces.linkStrength);
      }
      const chargeForce = graph.d3Force('charge');
      if (chargeForce) {
        chargeForce.strength(ATLAS_CONFIG.forces.chargeStrength);
        if (typeof chargeForce.distanceMax === 'function') {
          chargeForce.distanceMax(ATLAS_CONFIG.forces.chargeMaxDistance);
        }
      }
      const centerForce = graph.d3Force('center');
      if (centerForce && typeof centerForce.strength === 'function') {
        centerForce.strength(ATLAS_CONFIG.forces.centerStrength);
      }
      graph.d3ReheatSimulation?.();
    } catch (err) {
      console.warn('[Atlas] Failed to tune d3-force parameters', err);
    }
  }, [nodes.length, is3D, shouldRunForces]);

  // Fit view on data change
  useEffect(() => {
    if (graphRef.current && nodes.length > 0) {
      setTimeout(() => {
        graphRef.current?.zoomToFit?.(400, 50);
      }, 100);
    }
  }, [nodes.length, is3D]);
  
  // Phase 10: Update cluster label positions when camera moves (3D and 2D)
  useEffect(() => {
    if (!showClusterLabels || clusters.length === 0) {
      setClusterLabelPositions([]);
      return;
    }
    
    const graph = graphRef.current;
    if (!graph) return;
    
    let rafId = 0;
    
    const updateLabelPositions = () => {
      // Skip updates when document is hidden to reduce WindowServer memory pressure
      if (document.hidden) {
        cancelAnimationFrame(rafId);
        return;
      }
      
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        if (!graphRef.current?.graph2ScreenCoords) return;
        
        const positions: ClusterLabelPosition[] = clusters.map(cluster => {
          const screen = is3D
            ? graphRef.current.graph2ScreenCoords(
              cluster.centroid.x,
              cluster.centroid.y,
              cluster.centroid.z
            )
            : graphRef.current.graph2ScreenCoords(
              cluster.centroid.x,
              cluster.centroid.y,
            );
          
          // Check if visible (in front of camera, within viewport)
          const visible = screen.x >= -50 && screen.x <= dimensions.width + 50 &&
                         screen.y >= -50 && screen.y <= dimensions.height + 50;
          
          return {
            ...cluster,
            screenX: screen.x,
            screenY: screen.y,
            visible,
          };
        });
        
        setClusterLabelPositions(positions);
      });
    };
    
    // Handle visibility changes - refresh labels when becoming visible
    const handleVisibilityChange = () => {
      if (!document.hidden) {
        updateLabelPositions();
      }
    };
    
    // Initial update
    updateLabelPositions();
    
    // Subscribe to camera changes via controls
    const controls = graph.controls?.();
    document.addEventListener('visibilitychange', handleVisibilityChange);
    
    if (controls) {
      controls.addEventListener('change', updateLabelPositions);
      return () => {
        controls.removeEventListener('change', updateLabelPositions);
        document.removeEventListener('visibilitychange', handleVisibilityChange);
        cancelAnimationFrame(rafId);
      };
    }
    
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      cancelAnimationFrame(rafId);
    };
  }, [is3D, showClusterLabels, clusters, dimensions]);
  
  return (
    <div 
      ref={containerRef} 
      style={{ 
        width: '100%', 
        height: '100%',
        background: 'var(--color-bg-primary)',
        position: 'relative',  // For cluster labels overlay positioning
      }}
    >
      {is3D ? (
        <ForceGraph3D
          ref={graphRef}
          width={dimensions.width}
          height={dimensions.height}
          {...commonProps}
          backgroundColor="rgba(0,0,0,0)"
          showNavInfo={false}
          controlType="orbit"
          enableNodeDrag={false}
        />
      ) : (
        <ForceGraph2D
          ref={graphRef}
          width={dimensions.width}
          height={dimensions.height}
          {...commonProps}
          backgroundColor="rgba(0,0,0,0)"
          enableNodeDrag={false}
        />
      )}
      
      {/* Phase 10: Cluster labels overlay */}
      {showClusterLabels && clusterLabelPositions.length > 0 && (
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            height: '100%',
            pointerEvents: 'none',  // Allow clicks to pass through to graph
            overflow: 'hidden',
          }}
        >
          {clusterLabelPositions
            .filter(label => label.visible && label.label)  // Only show clusters with topic labels
            .map(label => (
              <div
                key={label.id}
                style={{
                  position: 'absolute',
                  left: label.screenX,
                  top: label.screenY,
                  transform: 'translate(-50%, -50%)',
                  background: 'rgba(0, 0, 0, 0.7)',
                  color: 'rgba(255, 255, 255, 0.9)',
                  padding: '3px 8px',
                  borderRadius: '4px',
                  fontSize: '11px',
                  fontWeight: 500,
                  whiteSpace: 'nowrap',
                  border: '1px solid rgba(255, 255, 255, 0.15)',
                  boxShadow: '0 2px 8px rgba(0, 0, 0, 0.3)',
                }}
              >
                {label.label}
                <span style={{ 
                  marginLeft: '4px', 
                  opacity: 0.6,
                  fontSize: '10px',
                }}>
                  ({label.nodeCount})
                </span>
              </div>
            ))}
        </div>
      )}
      
      {/* Tooltip renderer - renders both selected and hover tooltips */}
      {[
        { tooltip: selectedTooltip, isSelected: true, zIndex: 101 },
        { tooltip: hoverTooltip, isSelected: false, zIndex: 100 },
      ].map(({ tooltip, isSelected, zIndex }) => {
        if (!tooltip || tooltip.x <= 0 || tooltip.y <= 0) return null;
        
        const preview = previewCacheRef.current.get(tooltip.node.path);
        const isLoading = previewLoadingPath === tooltip.node.path;
        
        return (
          <div
            key={isSelected ? 'selected' : 'hover'}
            data-atlas-tooltip
            style={{
              position: 'absolute',
              left: Math.min(Math.max(tooltip.x + 12, 10), dimensions.width - 320),
              top: Math.min(Math.max(tooltip.y - 10, 10), dimensions.height - 400),
              maxHeight: dimensions.height - 40,
              overflowY: 'auto',
              pointerEvents: isSelected ? 'auto' : 'none',
              zIndex,
              animation: 'atlasTooltipFadeIn 0.15s ease-out',
            }}
          >
            <div
              style={{
                background: isSelected ? 'rgba(10, 10, 15, 0.95)' : 'rgba(20, 20, 30, 0.9)',
                backdropFilter: 'blur(var(--glass-overlay-blur))',
                padding: '10px 14px',
                borderRadius: '8px',
                fontSize: '12px',
                maxWidth: '300px',
                color: 'rgba(255, 255, 255, 0.9)',
                border: isSelected 
                  ? '1px solid rgba(59, 130, 246, 0.4)' 
                  : '1px solid rgba(255, 255, 255, 0.1)',
                boxShadow: isSelected
                  ? '0 4px 20px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(59, 130, 246, 0.2)'
                  : '0 4px 20px rgba(0, 0, 0, 0.4)',
              }}
            >
              {/* Title row with badges */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px', flexWrap: 'wrap' }}>
                <span style={{ fontWeight: 600, color: 'rgba(255, 255, 255, 0.95)' }}>
                  {tooltip.node.name}
                </span>
                {isRecentFile(tooltip.node.mtime) && (
                  <span style={{
                    background: 'linear-gradient(135deg, #22c55e, #16a34a)',
                    color: 'white',
                    padding: '1px 6px',
                    borderRadius: '4px',
                    fontSize: '9px',
                    fontWeight: 600,
                    textTransform: 'uppercase',
                    letterSpacing: '0.5px',
                  }}>
                    Recent
                  </span>
                )}
                {tooltip.node.topic && (
                  <span style={{
                    background: 'linear-gradient(135deg, #8b5cf6, #7c3aed)',
                    color: 'white',
                    padding: '1px 6px',
                    borderRadius: '4px',
                    fontSize: '9px',
                    fontWeight: 500,
                  }}>
                    {tooltip.node.topic}
                  </span>
                )}
              </div>
              
              {/* Path */}
              <div style={{ 
                opacity: 0.5, 
                fontSize: '10px', 
                marginBottom: '6px',
                wordBreak: 'break-all',
              }}>
                {tooltip.node.relativePath}
              </div>
              
              {/* Metadata row */}
              <div style={{ 
                display: 'flex', 
                gap: '8px', 
                fontSize: '10px', 
                opacity: 0.7,
                flexWrap: 'wrap',
              }}>
                {spaceNameMap?.get(tooltip.node.path) && (
                  <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <span style={{ 
                      width: '6px', 
                      height: '6px', 
                      borderRadius: '50%', 
                      background: spaceColorMap?.get(tooltip.node.path) || '#888',
                    }} />
                    {spaceNameMap.get(tooltip.node.path)}
                  </span>
                )}
                {tooltip.node.mtime && (
                  <span>{formatHistoryTimestamp(tooltip.node.mtime)}</span>
                )}
                {tooltip.node.chunkCount > 1 && (
                  <span>{tooltip.node.chunkCount} chunks</span>
                )}
              </div>
              
              {/* Preview section */}
              {(preview || isLoading) && (
                <div style={{
                  marginTop: '8px',
                  paddingTop: '8px',
                  borderTop: '1px solid rgba(255, 255, 255, 0.08)',
                }}>
                  {isLoading ? (
                    <div style={{ 
                      fontSize: '10px', 
                      opacity: 0.4,
                      fontStyle: 'italic',
                    }}>
                      <span style={{ 
                        display: 'inline-block',
                        animation: 'atlasTooltipPulse 1.5s ease-in-out infinite',
                      }}>
                        Loading preview...
                      </span>
                    </div>
                  ) : preview ? (
                    <div style={{
                      fontSize: '10px',
                      opacity: 0.6,
                      fontStyle: 'italic',
                      lineHeight: 1.5,
                      color: 'rgba(255, 255, 255, 0.8)',
                    }}>
                      "{preview}"
                    </div>
                  ) : null}
                </div>
              )}
              
              {/* Action buttons row - only show on selected tooltip */}
              {isSelected && (() => {
                const insight = insightCacheRef.current.get(tooltip.node.path);
                const isLoadingGist = loadingInsight?.path === tooltip.node.path && loadingInsight?.type === 'gist';
                const isLoadingZoom = loadingInsight?.path === tooltip.node.path && loadingInsight?.type === 'zoom';
                const isLoadingQa = loadingInsight?.path === tooltip.node.path && loadingInsight?.type === 'qa';
                const isLoading = isLoadingGist || isLoadingZoom || isLoadingQa;
                
                return (
                  <>
                    <div style={{ 
                      display: 'flex', 
                      gap: '6px', 
                      marginTop: '10px',
                      flexWrap: 'wrap',
                    }}>
                      {/* "The gist" button */}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          fetchGist(tooltip.node.path);
                        }}
                        disabled={isLoading}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '4px',
                          padding: '4px 8px',
                          background: insight?.type === 'gist' 
                            ? 'rgba(139, 92, 246, 0.3)' 
                            : 'rgba(139, 92, 246, 0.15)',
                          border: '1px solid rgba(139, 92, 246, 0.3)',
                          borderRadius: '4px',
                          color: 'rgba(255, 255, 255, 0.8)',
                          fontSize: '10px',
                          cursor: isLoading ? 'wait' : 'pointer',
                          transition: 'all 0.15s ease',
                          opacity: isLoadingGist ? 0.6 : 1,
                        }}
                        onMouseEnter={(e) => {
                          if (!isLoading) e.currentTarget.style.background = 'rgba(139, 92, 246, 0.25)';
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.background = insight?.type === 'gist'
                            ? 'rgba(139, 92, 246, 0.3)'
                            : 'rgba(139, 92, 246, 0.15)';
                        }}
                      >
                        <Sparkles size={10} style={{ 
                          animation: isLoadingGist ? 'atlasTooltipPulse 1s ease-in-out infinite' : 'none' 
                        }} />
                        {isLoadingGist ? 'Thinking…' : 'The gist'}
                      </button>
                      
                      {/* "Zoom out" button - only if neighbors exist */}
                      {neighbors.length > 0 && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            fetchZoomOut(tooltip.node.path);
                          }}
                          disabled={isLoading}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '4px',
                            padding: '4px 8px',
                            background: insight?.type === 'zoom'
                              ? 'rgba(59, 130, 246, 0.3)'
                              : 'rgba(59, 130, 246, 0.15)',
                            border: '1px solid rgba(59, 130, 246, 0.3)',
                            borderRadius: '4px',
                            color: 'rgba(255, 255, 255, 0.8)',
                            fontSize: '10px',
                            cursor: isLoading ? 'wait' : 'pointer',
                            transition: 'all 0.15s ease',
                            opacity: isLoadingZoom ? 0.6 : 1,
                          }}
                          onMouseEnter={(e) => {
                            if (!isLoading) e.currentTarget.style.background = 'rgba(59, 130, 246, 0.25)';
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.background = insight?.type === 'zoom'
                              ? 'rgba(59, 130, 246, 0.3)'
                              : 'rgba(59, 130, 246, 0.15)';
                          }}
                        >
                          <MapIcon size={10} style={{ 
                            animation: isLoadingZoom ? 'atlasTooltipPulse 1s ease-in-out infinite' : 'none' 
                          }} />
                          {isLoadingZoom ? 'Expanding…' : 'Zoom out'}
                        </button>
                      )}
                      
                      {/* Open file button */}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleOpenFile(tooltip);
                        }}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '4px',
                          padding: '4px 8px',
                          background: 'rgba(59, 130, 246, 0.15)',
                          border: '1px solid rgba(59, 130, 246, 0.3)',
                          borderRadius: '4px',
                          color: 'rgba(255, 255, 255, 0.8)',
                          fontSize: '10px',
                          cursor: 'pointer',
                          transition: 'all 0.15s ease',
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.background = 'rgba(59, 130, 246, 0.25)';
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.background = 'rgba(59, 130, 246, 0.15)';
                        }}
                      >
                        <ExternalLink size={10} />
                        Open
                      </button>
                    </div>
                    
                    {/* Ask input field */}
                    <div style={{ marginTop: '8px', display: 'flex', gap: '4px' }}>
                      <input
                        type="text"
                        placeholder="Ask about these files..."
                        value={askInput}
                        onChange={(e) => setAskInput(e.target.value)}
                        onKeyDown={(e) => {
                          e.stopPropagation();
                          if (e.key === 'Enter' && !e.shiftKey && askInput.trim()) {
                            askQuestion(tooltip.node.path, askInput);
                          }
                        }}
                        onClick={(e) => e.stopPropagation()}
                        disabled={isLoading}
                        style={{
                          flex: 1,
                          padding: '4px 8px',
                          fontSize: '10px',
                          background: 'rgba(255, 255, 255, 0.08)',
                          border: '1px solid rgba(255, 255, 255, 0.15)',
                          borderRadius: '4px',
                          color: 'rgba(255, 255, 255, 0.9)',
                          outline: 'none',
                        }}
                      />
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          if (askInput.trim()) askQuestion(tooltip.node.path, askInput);
                        }}
                        disabled={isLoading || !askInput.trim()}
                        style={{
                          padding: '4px 8px',
                          fontSize: '10px',
                          background: askInput.trim() ? 'rgba(34, 197, 94, 0.2)' : 'rgba(34, 197, 94, 0.1)',
                          border: '1px solid rgba(34, 197, 94, 0.3)',
                          borderRadius: '4px',
                          color: 'rgba(255, 255, 255, 0.8)',
                          cursor: isLoading || !askInput.trim() ? 'not-allowed' : 'pointer',
                          opacity: isLoading || !askInput.trim() ? 0.5 : 1,
                        }}
                      >
                        {isLoadingQa ? '...' : 'Ask'}
                      </button>
                      {/* Start conversation button */}
                      {onStartConversation && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            const filePaths = [tooltip.node.path, ...neighbors.map(n => n.path)];
                            tracking.library.atlas.conversationStarted(new Set(filePaths).size);
                            onStartConversation(askInput.trim() || `Help me understand this file and its neighbors`, filePaths);
                          }}
                          disabled={isLoading}
                          title="Start a new conversation with these files"
                          style={{
                            padding: '4px 8px',
                            fontSize: '10px',
                            background: 'rgba(168, 85, 247, 0.2)',
                            border: '1px solid rgba(168, 85, 247, 0.3)',
                            borderRadius: '4px',
                            color: 'rgba(255, 255, 255, 0.8)',
                            cursor: isLoading ? 'not-allowed' : 'pointer',
                            opacity: isLoading ? 0.5 : 1,
                          }}
                        >
                          Chat
                        </button>
                      )}
                    </div>
                    
                    {/* AI Insight result - single content area, replaces previous */}
                    {insight && (
                      <div style={{ 
                        marginTop: '8px',
                        maxHeight: '200px',
                        overflowY: 'auto',
                      }}>
                        <div style={{
                          fontSize: '11px',
                          color: 'rgba(255, 255, 255, 0.85)',
                          borderLeft: `2px solid ${
                            insight.type === 'gist' ? 'rgba(139, 92, 246, 0.5)' :
                            insight.type === 'zoom' ? 'rgba(59, 130, 246, 0.5)' :
                            'rgba(34, 197, 94, 0.5)'
                          }`,
                          paddingLeft: '8px',
                          lineHeight: 1.4,
                        }}
                        className="atlas-insight-markdown"
                        >
                          <div style={{ fontSize: '9px', opacity: 0.5, marginBottom: '4px' }}>
                            {insight.type === 'gist' ? 'The gist' :
                             insight.type === 'zoom' ? 'Neighborhood' :
                             `Q: ${insight.question}`}
                          </div>
                          <SafeMarkdown className="atlas-markdown-content">
                            {insight.content}
                          </SafeMarkdown>
                        </div>
                      </div>
                    )}
                  </>
                );
              })()}
            </div>
          </div>
        );
      })}
      
      {/* Tooltip animations and markdown styles */}
      <style>{`
        @keyframes atlasTooltipFadeIn {
          from { opacity: 0; transform: translateY(4px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes atlasTooltipPulse {
          0%, 100% { opacity: 0.4; }
          50% { opacity: 0.7; }
        }
        .atlas-markdown-content,
        .atlas-markdown-content * {
          color: rgba(255, 255, 255, 0.85) !important;
        }
        .atlas-markdown-content h1,
        .atlas-markdown-content h2,
        .atlas-markdown-content h3,
        .atlas-markdown-content h4 {
          font-size: 11px !important;
          font-weight: 600 !important;
          margin: 0 0 4px 0 !important;
          color: rgba(255, 255, 255, 0.95) !important;
        }
        .atlas-markdown-content p {
          margin: 0 0 6px 0 !important;
        }
        .atlas-markdown-content ul,
        .atlas-markdown-content ol {
          margin: 4px 0 !important;
          padding-left: 14px !important;
        }
        .atlas-markdown-content li {
          margin: 2px 0 !important;
        }
        .atlas-markdown-content strong {
          color: rgba(255, 255, 255, 0.95) !important;
        }
        .atlas-markdown-content code {
          background: rgba(255, 255, 255, 0.1) !important;
          padding: 1px 4px !important;
          border-radius: 3px !important;
          font-size: 10px !important;
        }
        .atlas-markdown-content blockquote {
          margin: 4px 0 !important;
          padding-left: 8px !important;
          border-left: 2px solid rgba(255, 255, 255, 0.2) !important;
          opacity: 0.8;
        }
      `}</style>
    </div>
  );
});

AtlasCanvas.displayName = 'AtlasCanvas';
