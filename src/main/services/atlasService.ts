/**
 * Atlas Service
 * 
 * Manages semantic visualization of workspace files using UMAP projection.
 * Reads materialized file-level vectors, runs UMAP in a worker thread, and
 * caches projection results per workspace.
 */

import { Worker } from 'worker_threads';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { isPackaged, getAppRoot } from '@core/utils/dataPaths';
import { buildSymlinkMap, convertPathWithSymlinkMap } from '@core/utils/symlinkMap';
import { computeAveragedNormalizedVector, l2Normalize } from '@core/utils/vectorMath';
import { EMBEDDING_DIMENSION } from '@core/embeddingGenerator';
import skmeans from 'skmeans';
import { logger } from '@core/logger';
import { isShuttingDown } from './shutdownState';
import { fireAndForget } from '@shared/utils/fireAndForget';

// REBEL-4X: Track active workers for graceful shutdown
const activeAtlasWorkers = new Set<Worker>();
let isAtlasDisposed = false;

// =============================================================================
// Phase 9: Topic Detection Configuration
// =============================================================================

/**
 * Topic definitions for zero-shot classification.
 * Each topic has multiple descriptive anchor phrases for better accuracy.
 * Research shows 30% accuracy boost from descriptive labels vs single words.
 * 
 * We use 100 topics total:
 * - 50 generic knowledge worker topics (broad professional coverage)
 * - 50 user-specific topics (from spaces, memory/topics folders, and files)
 */
interface TopicDefinition {
  id: string;
  name: string;
  anchors: string[];  // Multiple descriptive phrases per topic
  source: 'generic' | 'user';  // Track where topic came from
}

/**
 * 50 Generic knowledge worker topics - broad professional coverage
 * These cover common activities for executives, PMs, researchers, professionals
 */
const GENERIC_TOPIC_DEFINITIONS: Omit<TopicDefinition, 'source'>[] = [
  // Meetings & Communication
  { id: 'meetings', name: 'Meetings', anchors: ['meeting notes, agendas, action items, attendees', 'call summary, decisions made, follow-ups'] },
  { id: 'one-on-ones', name: '1:1s', anchors: ['one on one meeting, 1:1 notes, direct report conversation', 'manager check-in, career discussion, feedback session'] },
  { id: 'emails', name: 'Emails', anchors: ['email correspondence, inbox, sent messages', 'email thread, reply, forward, cc'] },
  { id: 'presentations', name: 'Presentations', anchors: ['presentation slides, deck, keynote, powerpoint', 'talk outline, speaker notes, demo script'] },
  { id: 'announcements', name: 'Announcements', anchors: ['company announcement, team update, news', 'memo, broadcast, communication to all'] },
  
  // Planning & Strategy
  { id: 'strategy', name: 'Strategy', anchors: ['strategic planning, long-term vision, direction', 'business strategy, competitive analysis, market positioning'] },
  { id: 'goals', name: 'Goals', anchors: ['goals, objectives, targets, KPIs, OKRs', 'quarterly goals, annual objectives, success metrics'] },
  { id: 'roadmap', name: 'Roadmap', anchors: ['product roadmap, feature timeline, release plan', 'roadmap priorities, upcoming milestones, planned work'] },
  { id: 'planning', name: 'Planning', anchors: ['project planning, resource allocation, scheduling', 'capacity planning, sprint planning, quarterly planning'] },
  { id: 'priorities', name: 'Priorities', anchors: ['priority list, what matters most, focus areas', 'top priorities, urgent items, must-do tasks'] },
  
  // Projects & Execution
  { id: 'projects', name: 'Projects', anchors: ['project status, deliverables, milestones', 'project plan, scope, requirements, timeline'] },
  { id: 'tasks', name: 'Tasks', anchors: ['todo list, tasks, action items, checklist', 'work items, assignments, backlog items'] },
  { id: 'deadlines', name: 'Deadlines', anchors: ['deadline, due date, time-sensitive, urgent', 'delivery date, launch date, ship date'] },
  { id: 'status-updates', name: 'Status Updates', anchors: ['status report, progress update, weekly update', 'project status, what got done, blockers'] },
  { id: 'reviews', name: 'Reviews', anchors: ['review notes, feedback, evaluation', 'code review, design review, quarterly review'] },
  
  // Research & Analysis
  { id: 'research', name: 'Research', anchors: ['research findings, analysis, data insights', 'investigation, discovery, exploration'] },
  { id: 'analysis', name: 'Analysis', anchors: ['data analysis, metrics, statistics', 'analytical findings, trends, patterns'] },
  { id: 'reports', name: 'Reports', anchors: ['report, summary report, executive summary', 'findings report, analysis report, status report'] },
  { id: 'insights', name: 'Insights', anchors: ['key insights, learnings, takeaways', 'observations, conclusions, recommendations'] },
  { id: 'competitive', name: 'Competitive Intel', anchors: ['competitor analysis, market research, competitive landscape', 'competitor news, industry trends, market intelligence'] },
  
  // Documentation & Knowledge
  { id: 'documentation', name: 'Documentation', anchors: ['technical documentation, how-to guide, manual', 'reference docs, specifications, README'] },
  { id: 'processes', name: 'Processes', anchors: ['process documentation, workflow, procedure', 'standard operating procedure, how we do things'] },
  { id: 'templates', name: 'Templates', anchors: ['template, boilerplate, starter, example', 'document template, email template, meeting template'] },
  { id: 'guidelines', name: 'Guidelines', anchors: ['guidelines, best practices, standards', 'policy, rules, recommendations'] },
  { id: 'faqs', name: 'FAQs', anchors: ['frequently asked questions, common questions', 'FAQ, Q&A, help topics'] },
  
  // People & Relationships
  { id: 'people', name: 'People', anchors: ['team members, contacts, profiles', 'people notes, personnel, org chart'] },
  { id: 'hiring', name: 'Hiring', anchors: ['hiring, recruiting, job candidates', 'interview notes, job description, candidate evaluation'] },
  { id: 'onboarding', name: 'Onboarding', anchors: ['onboarding, new hire, getting started', 'welcome guide, first week, orientation'] },
  { id: 'feedback', name: 'Feedback', anchors: ['feedback, performance feedback, constructive criticism', 'peer feedback, 360 feedback, review feedback'] },
  { id: 'networking', name: 'Networking', anchors: ['networking, connections, relationships', 'contacts, introductions, professional network'] },
  
  // Finance & Business
  { id: 'finance', name: 'Finance', anchors: ['financial data, budget, expenses, revenue', 'financial planning, invoices, accounting'] },
  { id: 'budget', name: 'Budget', anchors: ['budget planning, cost allocation, spending', 'budget review, financial forecast, expense tracking'] },
  { id: 'deals', name: 'Deals', anchors: ['deal notes, sales opportunity, prospect', 'contract negotiation, pricing, proposal'] },
  { id: 'customers', name: 'Customers', anchors: ['customer notes, client information, account', 'customer feedback, client relationship, account management'] },
  { id: 'vendors', name: 'Vendors', anchors: ['vendor information, supplier, contractor', 'vendor evaluation, procurement, outsourcing'] },
  
  // Ideas & Innovation
  { id: 'ideas', name: 'Ideas', anchors: ['brainstorming, ideas, concepts, possibilities', 'creative thoughts, proposals, suggestions'] },
  { id: 'experiments', name: 'Experiments', anchors: ['experiment, test, hypothesis, trial', 'A/B test, prototype, proof of concept'] },
  { id: 'opportunities', name: 'Opportunities', anchors: ['opportunity, potential, possibility', 'growth opportunity, new market, expansion'] },
  { id: 'innovation', name: 'Innovation', anchors: ['innovation, new approach, disruption', 'innovative solution, creative problem solving'] },
  { id: 'brainstorm', name: 'Brainstorm', anchors: ['brainstorm session, ideation, mind map', 'creative session, whiteboard, blue sky thinking'] },
  
  // Learning & Development
  { id: 'learning', name: 'Learning', anchors: ['learning notes, course materials, tutorials', 'study notes, educational content, training'] },
  { id: 'books', name: 'Books', anchors: ['book notes, reading notes, book summary', 'book highlights, key takeaways from book'] },
  { id: 'courses', name: 'Courses', anchors: ['course notes, class materials, lecture notes', 'online course, workshop, seminar notes'] },
  { id: 'skills', name: 'Skills', anchors: ['skill development, learning new skill, competency', 'skill gap, training needs, professional development'] },
  { id: 'certifications', name: 'Certifications', anchors: ['certification, credential, qualification', 'exam prep, certification study, professional certification'] },
  
  // Personal & Reflection
  { id: 'journal', name: 'Journal', anchors: ['journal entry, daily reflection, personal log', 'diary, thoughts, daily notes'] },
  { id: 'reflections', name: 'Reflections', anchors: ['reflection, retrospective, lessons learned', 'what went well, what to improve, hindsight'] },
  { id: 'personal-goals', name: 'Personal Goals', anchors: ['personal goals, life goals, self-improvement', 'new year resolutions, personal development'] },
  { id: 'health', name: 'Health', anchors: ['health notes, wellness, fitness', 'medical notes, health tracking, wellbeing'] },
  { id: 'travel', name: 'Travel', anchors: ['travel plans, trip notes, itinerary', 'travel booking, vacation planning, trip summary'] },
];

// Topic classification threshold - only assign if similarity > this value
// Lowered from 0.42 to allow more files to get topics (was too strict)
const TOPIC_CLASSIFICATION_THRESHOLD = 0.35;

// Margin rule: best topic must be this much better than second-best
// Lowered from 0.02 to be more permissive
const TOPIC_MARGIN_THRESHOLD = 0.01;

// Maximum user topics to extract from spaces/folders
const MAX_USER_TOPICS = 50;

// Cache for topic embeddings (computed once per session, per workspace)
interface TopicEmbedding {
  topicId: string;
  topicName: string;
  embedding: number[];
  source: 'generic' | 'user';
}
let topicEmbeddingsCache: TopicEmbedding[] | null = null;
let topicEmbeddingsCacheWorkspace: string | null = null;

/**
 * Convert a folder/file name to a readable topic name.
 * E.g., "ai-strategy" -> "AI Strategy", "team_building" -> "Team Building"
 */
function toReadableTopicName(name: string): string {
  return name
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
    .replace(/\bAi\b/g, 'AI')
    .replace(/\bApi\b/g, 'API')
    .replace(/\bUi\b/g, 'UI')
    .replace(/\bUx\b/g, 'UX')
    .trim();
}

/**
 * Extract user-specific topics from workspace memory/topics folders.
 * Scans all spaces for {space}/memory/topics/{folder} and {folder}/{file}.
 * Returns up to MAX_USER_TOPICS topics.
 */
async function extractUserTopics(workspacePath: string): Promise<TopicDefinition[]> {
  const userTopics: TopicDefinition[] = [];
  const seenNames = new Set<string>();
  
  try {
    // Import space scanning function
    const { scanSpaces } = await import('./spaceService');
    // Read-only consumer (topic discovery) — never mutate frontmatter.
    // See docs/plans/260411_shared_space_maintenance.md Stage 3 Refinement.
    const spaces = await scanSpaces(workspacePath, { skipAutoFix: true });
    
    // Collect all topic folders from all spaces
    const topicFolders: { name: string; spaceName: string }[] = [];
    const topicFiles: { name: string; spaceName: string; folderName: string }[] = [];
    
    for (const space of spaces) {
      const topicsPath = path.join(workspacePath, space.path, 'memory', 'topics');
      
      try {
        const entries = await fs.promises.readdir(topicsPath, { withFileTypes: true });
        
        for (const entry of entries) {
          if (entry.isDirectory()) {
            topicFolders.push({ name: entry.name, spaceName: space.name });
            
            // Also scan files within the folder for potential topics
            const folderPath = path.join(topicsPath, entry.name);
            try {
              const files = await fs.promises.readdir(folderPath, { withFileTypes: true });
              for (const file of files) {
                if (file.isFile() && (file.name.endsWith('.md') || file.name.endsWith('.txt'))) {
                  const baseName = file.name.replace(/\.(md|txt)$/, '');
                  if (baseName && baseName !== 'README' && baseName !== 'index') {
                    topicFiles.push({ 
                      name: baseName, 
                      spaceName: space.name,
                      folderName: entry.name 
                    });
                  }
                }
              }
            } catch {
              // Folder read failed, skip files
            }
          }
        }
      } catch {
        // Topics folder doesn't exist for this space, skip
      }
    }
    
    // First, add folder-based topics (priority)
    for (const folder of topicFolders) {
      if (userTopics.length >= MAX_USER_TOPICS) break;
      
      const readableName = toReadableTopicName(folder.name);
      const lowerName = readableName.toLowerCase();
      
      if (seenNames.has(lowerName)) continue;
      seenNames.add(lowerName);
      
      userTopics.push({
        id: `user-${folder.name.toLowerCase()}`,
        name: readableName,
        source: 'user',
        // Research shows descriptive sentence-like phrases improve accuracy 30%
        anchors: [
          `Notes and documentation about ${readableName}, including key insights and learnings`,
          `${readableName} related materials, references, summaries, and important information`
        ]
      });
    }
    
    // If we need more topics, add file-based topics
    if (userTopics.length < MAX_USER_TOPICS) {
      for (const file of topicFiles) {
        if (userTopics.length >= MAX_USER_TOPICS) break;
        
        const readableName = toReadableTopicName(file.name);
        const lowerName = readableName.toLowerCase();
        
        if (seenNames.has(lowerName)) continue;
        seenNames.add(lowerName);
        
        userTopics.push({
          id: `user-file-${file.name.toLowerCase()}`,
          name: readableName,
          source: 'user',
          anchors: [
            `Information and notes about ${readableName}, key points and takeaways`,
            `${readableName} details, context, and relevant background information`
          ]
        });
      }
    }
    
    logger.info({ 
      workspacePath, 
      userTopicCount: userTopics.length,
      fromFolders: topicFolders.length,
      fromFiles: topicFiles.length 
    }, 'Extracted user topics from workspace');
    
  } catch (err) {
    logger.warn({ err, workspacePath }, 'Failed to extract user topics from workspace');
  }
  
  return userTopics;
}

/**
 * Get or compute topic embeddings for classification.
 * Combines 50 generic topics + up to 50 user topics from workspace.
 * Cached per workspace session.
 */
async function getTopicEmbeddings(workspacePath: string): Promise<TopicEmbedding[]> {
  // Return cached if available for this workspace
  if (topicEmbeddingsCache && topicEmbeddingsCacheWorkspace === workspacePath) {
    return topicEmbeddingsCache;
  }
  
  const { generateQueryEmbedding } = await import('./embeddingService');
  
  // Build full topic list: generic + user
  const genericTopics: TopicDefinition[] = GENERIC_TOPIC_DEFINITIONS.map(t => ({ ...t, source: 'generic' as const }));
  const userTopics = await extractUserTopics(workspacePath);
  const allTopics = [...genericTopics, ...userTopics];
  
  logger.info({ 
    genericCount: genericTopics.length, 
    userCount: userTopics.length,
    totalCount: allTopics.length 
  }, 'Computing topic embeddings');
  
  // Compute embeddings for all topic anchors
  const topicEmbeddings: TopicEmbedding[] = [];
  
  for (const topic of allTopics) {
    // Average embeddings from all anchors for this topic
    const anchorEmbeddings: number[][] = [];
    
    for (const anchor of topic.anchors) {
      const embedding = await generateQueryEmbedding(anchor);
      anchorEmbeddings.push(Array.from(embedding));
    }
    
    const { vector: avgEmbedding } = computeAveragedNormalizedVector(anchorEmbeddings, EMBEDDING_DIMENSION);
    if (!avgEmbedding) {
      logger.warn(
        { topicId: topic.id, topicName: topic.name, anchorCount: anchorEmbeddings.length },
        'Skipping topic with invalid anchor embeddings',
      );
      continue;
    }

    topicEmbeddings.push({
      topicId: topic.id,
      topicName: topic.name,
      embedding: avgEmbedding,
      source: topic.source
    });
  }
  
  // Cache for this workspace
  topicEmbeddingsCache = topicEmbeddings;
  topicEmbeddingsCacheWorkspace = workspacePath;
  
  logger.info({ topicCount: topicEmbeddings.length }, 'Topic embeddings computed and cached');
  
  return topicEmbeddings;
}

/**
 * Classify a file's topic based on its embedding.
 * Returns the best matching topic name, or undefined if no confident match.
 */
function classifyFileTopic(
  fileEmbedding: number[],
  topicEmbeddings: TopicEmbedding[]
): string | undefined {
  if (!fileEmbedding || fileEmbedding.length === 0 || topicEmbeddings.length === 0) {
    return undefined;
  }
  
  // Compute cosine similarity with all topics
  const scores: { topicName: string; score: number }[] = [];
  
  for (const topic of topicEmbeddings) {
    // Cosine similarity (both vectors should be L2-normalized)
    let dotProduct = 0;
    for (let i = 0; i < fileEmbedding.length; i++) {
      dotProduct += fileEmbedding[i] * topic.embedding[i];
    }
    scores.push({ topicName: topic.topicName, score: dotProduct });
  }
  
  // Sort by score descending
  scores.sort((a, b) => b.score - a.score);
  
  const best = scores[0];
  const secondBest = scores[1];
  
  // Apply threshold and margin rules
  if (best.score < TOPIC_CLASSIFICATION_THRESHOLD) {
    return undefined;  // Not confident enough
  }
  
  if (secondBest && (best.score - secondBest.score) < TOPIC_MARGIN_THRESHOLD) {
    return undefined;  // Too close to second choice
  }
  
  return best.topicName;
}

/**
 * Clear topic embeddings cache (called when workspace changes)
 */
export function clearTopicEmbeddingsCache(): void {
  topicEmbeddingsCache = null;
  topicEmbeddingsCacheWorkspace = null;
}

// =============================================================================
// Phase 11: LOD Clustering
// =============================================================================

// Minimum nodes to compute clusters
const MIN_NODES_FOR_CLUSTERING = 50;

// Maximum clusters to compute (keeps LOD manageable)
const MAX_LOD_CLUSTERS = 50;

// Minimum nodes per cluster (don't create tiny clusters)
const MIN_NODES_PER_CLUSTER = 3;

/**
 * Compute clusters for LOD (Level of Detail) rendering.
 * Uses k-means clustering on PCA coordinates.
 */
function computeLodClusters(nodes: AtlasNode[]): AtlasCluster[] {
  if (nodes.length < MIN_NODES_FOR_CLUSTERING) {
    return [];
  }
  
  // Extract positions (scale for k-means stability)
  const positions = nodes.map(n => [n.x * 100, n.y * 100, n.z * 100]);
  
  // Determine k: sqrt(n/2), capped at MAX_LOD_CLUSTERS
  const k = Math.min(MAX_LOD_CLUSTERS, Math.ceil(Math.sqrt(nodes.length / 2)));
  
  try {
    // Run k-means with k-means++ initialization
    const result = skmeans(positions, k, 'kmpp', 10);
    
    const clusters: AtlasCluster[] = [];
    
    for (let i = 0; i < result.centroids.length; i++) {
      const centroid = result.centroids[i];
      
      // Find nodes in this cluster
      const clusterNodeIndices = result.idxs
        .map((idx: number, nodeIdx: number) => (idx === i ? nodeIdx : -1))
        .filter((idx: number) => idx !== -1);
      
      if (clusterNodeIndices.length < MIN_NODES_PER_CLUSTER) continue;
      
      const clusterNodes = clusterNodeIndices.map((idx: number) => nodes[idx]);
      
      // Compute cluster label from dominant topic
      const label = computeClusterTopicLabel(clusterNodes);
      
      // Find representative nodes (closest to centroid)
      const nodesWithDistance = clusterNodes.map(node => {
        const dx = node.x * 100 - centroid[0];
        const dy = node.y * 100 - centroid[1];
        const dz = node.z * 100 - centroid[2];
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        return { node, dist };
      });
      nodesWithDistance.sort((a, b) => a.dist - b.dist);
      const representativePaths = nodesWithDistance.slice(0, 5).map(n => n.node.path);
      
      clusters.push({
        id: i,
        centroid: {
          x: centroid[0] / 100,  // Unscale
          y: centroid[1] / 100,
          z: centroid[2] / 100,
        },
        nodeCount: clusterNodes.length,
        nodePaths: clusterNodes.map(n => n.path),
        representativePaths,
        label,
      });
    }
    
    return clusters;
  } catch (err) {
    logger.warn({ err }, 'LOD clustering failed');
    return [];
  }
}

/**
 * Compute a topic label for a cluster based on dominant topic.
 * Returns null if no clear dominant topic (>= 15% of nodes).
 */
function computeClusterTopicLabel(clusterNodes: AtlasNode[]): string | null {
  const topicCounts = new Map<string, number>();
  
  for (const node of clusterNodes) {
    if (node.topic) {
      topicCounts.set(node.topic, (topicCounts.get(node.topic) || 0) + 1);
    }
  }
  
  if (topicCounts.size === 0) return null;
  
  // Find most common topic
  let bestTopic: string | null = null;
  let bestCount = 0;
  
  for (const [topic, count] of topicCounts) {
    if (count > bestCount) {
      bestTopic = topic;
      bestCount = count;
    }
  }
  
  // Require at least 15% of cluster or 2 nodes
  const threshold = Math.max(2, clusterNodes.length * 0.15);
  return bestTopic && bestCount >= threshold ? bestTopic : null;
}

// Types
// Phase 8.6: Neighbor with similarity score for ambient edge visualization
export interface AtlasNeighborWithSimilarity {
  path: string;
  similarity: number;  // Cosine similarity (0.0-1.0)
}

export interface AtlasNode {
  path: string;
  relativePath: string;
  x: number;
  y: number;
  z: number;
  extension: string;
  chunkCount: number;
  // Phase 7: Semantic search support (optional, only when includeEmbeddings=true)
  embedding?: number[];  // 384-dim normalized embedding
  neighbors?: AtlasNeighborWithSimilarity[];  // Undefined after Stage 5; Stage 6 neighborhood IPC hydrates edges.
  // Phase 8: Recent file highlight + enhanced tooltips
  mtime?: number;  // File modification timestamp (ms since epoch)
  // Phase 9: Topic detection
  topic?: string;  // Detected topic name (e.g., "Meetings", "Research")
}

// Phase 11: Cluster for LOD (Level of Detail) rendering
export interface AtlasCluster {
  id: number;
  centroid: { x: number; y: number; z: number };
  nodeCount: number;
  nodePaths: string[];           // All file paths in this cluster
  representativePaths: string[]; // Top-5 closest to centroid (for mid-zoom)
  label: string | null;          // Topic label if dominant topic exists
}

export interface AtlasProjectionResult {
  nodes: AtlasNode[];
  clusters: AtlasCluster[];      // Phase 11: Pre-computed clusters for LOD
  count: number;
  totalFileCount: number;        // Total indexed files (may differ if sampled)
  computedAt: number;
  cached: boolean;
}

interface ProjectionCache {
  nodes: AtlasNode[];
  clusters: AtlasCluster[]; // Phase 11: LOD clusters
  computedAt: number;
  workspacePath: string;
  fileCount: number;       // Actual nodes rendered (may be sampled)
  totalFileCount: number;  // Total indexed files (for cache invalidation)
  hasEmbeddings: boolean;  // Whether embeddings are included; neighbors hydrate separately in Stage 6.
}

// =============================================================================
// Symlink Map for O(1) Path Conversion
// -----------------------------------------------------------------------------
// buildSymlinkMap / convertPathWithSymlinkMap were promoted to the shared
// @core/utils/symlinkMap module so systemUtils.tryConvertToWorkspacePath can
// reuse the exact same registry/containment logic. Atlas still pre-computes the
// map ONCE per projection (see buildSymlinkMap usage below) to avoid calling
// tryConvertToWorkspacePath (which scans directories) for every node.
// =============================================================================

// =============================================================================
// State
// =============================================================================

// State
let projectionCache: ProjectionCache | null = null;
let currentWorkspacePath: string | null = null;
let projectionInProgress: { workspacePath: string; promise: Promise<AtlasProjectionResult> } | null = null;

// Worker path
function getWorkerPath(): string {
  if (isPackaged()) {
    return path.join(
      getAppRoot().replace('app.asar', 'app.asar.unpacked'),
      'workers',
      'atlasWorker.js'
    );
  }
  
  const possiblePaths = [
    path.join(__dirname, 'workers', 'atlasWorker.js'),
    path.join(getAppRoot(), 'out', 'main', 'workers', 'atlasWorker.js'),
    path.join(process.cwd(), 'out', 'main', 'workers', 'atlasWorker.js'),
  ];
  
  for (const workerPath of possiblePaths) {
    if (fs.existsSync(workerPath)) {
      return workerPath;
    }
  }
  
  return possiblePaths[1];
}

// Maximum files to visualize with PCA projection
// PCA is O(n) so we can handle much larger datasets
// Frontend uses LOD (Level of Detail) to render appropriately
const MAX_ATLAS_FILES = 20000;

/**
 * Get PCA projection of workspace files
 * @param forceRecompute - Force recomputation even if cached
 * @param includeEmbeddings - Include embeddings for semantic search; projection neighbors are intentionally omitted until Stage 6 IPC hydration
 */
export async function getAtlasProjection(
  forceRecompute = false,
  includeEmbeddings = false
): Promise<AtlasProjectionResult> {
  // TODO: Get workspace path from file watcher service
  // For now, return empty result if no workspace
  if (!currentWorkspacePath) {
    // Try to get from file watcher
    const { getWatchedWorkspace } = await import('./fileWatcherService');
    currentWorkspacePath = getWatchedWorkspace();
    
    if (!currentWorkspacePath) {
      logger.debug('No workspace set for Atlas projection');
      return {
        nodes: [],
        clusters: [],
        count: 0,
        totalFileCount: 0,
        computedAt: Date.now(),
        cached: false,
      };
    }
  }
  
  // Return cached if valid and not forcing recompute
  // Also check if we need embeddings but cache doesn't have them
  const cacheHasNeededEmbeddings = !includeEmbeddings || projectionCache?.hasEmbeddings;
  
  if (!forceRecompute && projectionCache && projectionCache.workspacePath === currentWorkspacePath && cacheHasNeededEmbeddings) {
    // Check if file count has changed significantly (>10% delta)
    // If so, invalidate cache and recompute
    const { getIndexedFileCount } = await import('./fileIndexService');
    const currentFileCount = await getIndexedFileCount();
    // Compare against totalFileCount (original indexed count, not sampled)
    const cachedTotalCount = projectionCache.totalFileCount;
    
    if (cachedTotalCount > 0 && currentFileCount > 0) {
      const delta = Math.abs(currentFileCount - cachedTotalCount) / cachedTotalCount;
      if (delta > 0.1) { // >10% change
        logger.info({ 
          cachedTotalCount, 
          currentCount: currentFileCount, 
          deltaPercent: Math.round(delta * 100) 
        }, 'File count changed >10%, invalidating Atlas cache');
        projectionCache = null;
        // Fall through to recompute
      } else {
        logger.debug({ 
          displayedNodes: projectionCache.fileCount,
          totalFiles: cachedTotalCount,
          hasEmbeddings: projectionCache.hasEmbeddings,
        }, 'Returning cached Atlas projection');
        return {
          nodes: projectionCache.nodes,
          clusters: projectionCache.clusters,
          count: projectionCache.nodes.length,
          totalFileCount: projectionCache.totalFileCount,
          computedAt: projectionCache.computedAt,
          cached: true,
        };
      }
    } else {
      logger.debug({ 
        displayedNodes: projectionCache.fileCount,
        totalFiles: cachedTotalCount,
        hasEmbeddings: projectionCache.hasEmbeddings,
      }, 'Returning cached Atlas projection');
      return {
        nodes: projectionCache.nodes,
        clusters: projectionCache.clusters,
        count: projectionCache.nodes.length,
        totalFileCount: projectionCache.totalFileCount,
        computedAt: projectionCache.computedAt,
        cached: true,
      };
    }
  }
  
  // If a projection is already in progress FOR THE SAME WORKSPACE, await it
  if (projectionInProgress && projectionInProgress.workspacePath === currentWorkspacePath) {
    logger.debug('Atlas projection already in progress for this workspace, awaiting...');
    return projectionInProgress.promise;
  }
  
  // Capture workspace path for this computation
  const workspaceForComputation = currentWorkspacePath;
  
  // Start new projection and store the Promise for concurrent callers
  const promise = computeProjection(workspaceForComputation, includeEmbeddings);
  projectionInProgress = { workspacePath: workspaceForComputation, promise };
  
  try {
    return await promise;
  } finally {
    // Only clear if this is still the current in-flight projection
    if (projectionInProgress?.promise === promise) {
      projectionInProgress = null;
    }
  }
}

/**
 * Internal: Compute PCA projection (called by getAtlasProjection)
 * @param workspacePath - The workspace path at the time computation started
 * @param includeEmbeddings - Include embeddings; `node.neighbors` remains undefined post-Stage 5
 */
async function computeProjection(workspacePath: string, includeEmbeddings: boolean): Promise<AtlasProjectionResult> {
  
  try {
    // Get file embeddings from the file index
    const { getFileEmbeddings } = await import('./fileIndexService');
    const fileData = await getFileEmbeddings();

    if (!fileData || fileData.length === 0) {
      logger.debug('No file embeddings available for Atlas projection');
      projectionCache = null;
      return {
        nodes: [],
        clusters: [],
        count: 0,
        totalFileCount: 0,
        computedAt: Date.now(),
        cached: false,
      };
    }
    
    // Sample down if too many files (projection and rendering still have practical scale limits)
    let workingData = fileData;
    let sampled = false;
    if (fileData.length > MAX_ATLAS_FILES) {
      logger.info({ 
        totalFiles: fileData.length, 
        sampledTo: MAX_ATLAS_FILES 
      }, 'Sampling files for Atlas (too many for full projection)');
      
      // Random sampling - shuffle and take first N
      const shuffled = [...fileData].sort(() => Math.random() - 0.5);
      workingData = shuffled.slice(0, MAX_ATLAS_FILES);
      sampled = true;
    }
    
    logger.info({ 
      fileCount: workingData.length, 
      sampled,
      originalCount: fileData.length 
    }, 'Computing Atlas projection');
    
    // Extract vectors and paths
    const fileVectors = workingData.map(f => f.vector);
    const filePaths = workingData.map(f => f.path);
    
    // Run UMAP in worker
    const workerPath = getWorkerPath();
    
    if (!fs.existsSync(workerPath)) {
      throw new Error(`Atlas worker not found: ${workerPath}. Run 'npm run build:workers'`);
    }
    
    const projected = await runUmapWorker(fileVectors, filePaths, workerPath);
    
    // Build lookup map for file metadata (avoid O(n²) find inside map)
    // Use workingData (possibly sampled) for the map
    const fileDataMap = new Map(workingData.map(f => [f.path, f]));
    
    // Validate workspace hasn't changed during computation
    if (currentWorkspacePath !== workspacePath) {
      logger.warn({ 
        startedWith: workspacePath, 
        currentNow: currentWorkspacePath 
      }, 'Workspace changed during Atlas projection, discarding result');
      return {
        nodes: [],
        clusters: [],
        count: 0,
        totalFileCount: 0,
        computedAt: Date.now(),
        cached: false,
      };
    }
    
    // Pre-compute symlink mappings ONCE for O(1) path conversion
    // This avoids calling tryConvertToWorkspacePath (which scans directories) for every node
    const symlinkMap = buildSymlinkMap(workspacePath);
    
    // Build nodes with metadata
    const nodes: AtlasNode[] = projected.map(p => {
      const fileInfo = fileDataMap.get(p.path);
      // Convert absolute path to workspace-relative using pre-computed symlink map
      const relativePath = convertPathWithSymlinkMap(p.path, symlinkMap) ?? p.path;
      const ext = path.extname(p.path).toLowerCase() || '';
      
      const node: AtlasNode = {
        path: p.path,
        relativePath,
        x: p.x,
        y: p.y,
        z: p.z,
        extension: ext,
        chunkCount: fileInfo?.chunkCount ?? 1,
        // Phase 8: Include mtime for recent file highlight
        mtime: fileInfo?.mtime,
      };
      
      // Phase 7: Include embedding if requested
      if (includeEmbeddings && fileInfo) {
        node.embedding = fileInfo.vector;
      }
      
      return node;
    });

    // Stage 5 intentionally leaves node.neighbors undefined; AtlasCanvas and
    // useAtlasSemanticSearch already guard optional neighbors, and Stage 6
    // hydrates neighborhood edges through a separate IPC path.
    
    // Phase 9: Topic detection - classify each file based on its embedding
    // Only run if we have embeddings (topic classification requires vectors)
    if (includeEmbeddings && nodes.length > 0) {
      logger.info({ nodeCount: nodes.length }, 'Classifying topics for all nodes...');
      const topicStartTime = Date.now();
      
      try {
        // Get topic embeddings (cached per workspace)
        const topicEmbeddings = await getTopicEmbeddings(workspacePath);
        
        // Classify each node
        let classifiedCount = 0;
        for (const node of nodes) {
          if (node.embedding) {
            const topic = classifyFileTopic(node.embedding, topicEmbeddings);
            if (topic) {
              node.topic = topic;
              classifiedCount++;
            }
          }
        }
        
        const topicElapsed = Date.now() - topicStartTime;
        logger.info({ 
          topicElapsed, 
          nodeCount: nodes.length, 
          classifiedCount,
          topicCount: topicEmbeddings.length 
        }, 'Topic classification completed');
      } catch (err) {
        logger.warn({ err }, 'Topic classification failed, continuing without topics');
      }
    }
    
    // Phase 11: Compute LOD clusters for large datasets
    logger.info({ nodeCount: nodes.length }, 'Computing LOD clusters...');
    const clusterStartTime = Date.now();
    const clusters = computeLodClusters(nodes);
    const clusterElapsed = Date.now() - clusterStartTime;
    logger.info({ 
      clusterElapsed, 
      clusterCount: clusters.length,
      nodeCount: nodes.length 
    }, 'LOD clustering completed');

    if (currentWorkspacePath !== workspacePath) {
      logger.info(
        { workspacePathAtStart: workspacePath, currentWorkspacePath },
        'projection.workspace_switch_drop',
      );
      return {
        nodes: [],
        clusters: [],
        count: 0,
        totalFileCount: 0,
        computedAt: Date.now(),
        cached: false,
      };
    }
    
    // Cache result (only if workspace still matches)
    const computedAt = Date.now();
    if (currentWorkspacePath === workspacePath) {
      projectionCache = {
        nodes,
        clusters,
        computedAt,
        workspacePath,
        fileCount: nodes.length,
        totalFileCount: fileData.length, // Original count for cache invalidation
        hasEmbeddings: includeEmbeddings,
      };
    }
    
    logger.info({ nodeCount: nodes.length, clusterCount: clusters.length, includeEmbeddings }, 'Atlas projection completed');
    
    return {
      nodes,
      clusters,
      count: nodes.length,
      totalFileCount: fileData.length,
      computedAt,
      cached: false,
    };
    
  } catch (error) {
    logger.error({ err: error }, 'Atlas projection failed');
    throw error;
  }
}

/**
 * Run UMAP projection in worker thread
 */
async function runUmapWorker(
  fileVectors: number[][],
  filePaths: string[],
  workerPath: string
): Promise<Array<{ path: string; x: number; y: number; z: number }>> {
  // REBEL-4X: Prevent worker creation during shutdown to avoid V8 platform crash
  if (isAtlasDisposed || isShuttingDown()) {
    return Promise.reject(new Error('Atlas service unavailable - app shutting down'));
  }

  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const worker = new Worker(workerPath);
    activeAtlasWorkers.add(worker);
    // REBEL-4X: Track if promise is settled to avoid hanging on unexpected exit
    let settled = false;
    
    // Scale timeout based on file count: ~2ms per file minimum, with 60s base
    // 500 files: 60s, 2000 files: 64s, 5000 files: 70s
    const fileCount = fileVectors.length;
    const timeoutMs = Math.max(60000, 60000 + fileCount * 2);
    
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      activeAtlasWorkers.delete(worker);
      fireAndForget(worker.terminate(), 'atlasService.line938');
      reject(new Error(`UMAP worker timeout (${Math.round(timeoutMs / 1000)}s for ${fileCount} files)`));
    }, timeoutMs);
    
    // REBEL-4X: Handle worker exit - always reject if not settled to avoid hanging promises
    worker.on('exit', (code) => {
      activeAtlasWorkers.delete(worker);
      clearTimeout(timeout);
      // Reject on ANY exit if promise not yet settled (handles code 0 without result)
      if (!settled) {
        settled = true;
        const reason = isAtlasDisposed ? 'app shutting down' : `worker exited with code ${code}`;
        reject(new Error(`UMAP worker terminated (${reason})`));
      }
    });
    
    worker.on('message', (msg) => {
      if (msg.type === 'result' && msg.id === id) {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        activeAtlasWorkers.delete(worker);
        fireAndForget(worker.terminate(), 'atlasService.line960');
        resolve(msg.projected);
      } else if (msg.type === 'error' && msg.id === id) {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        activeAtlasWorkers.delete(worker);
        fireAndForget(worker.terminate(), 'atlasService.line967');
        reject(new Error(msg.error));
      }
    });
    
    worker.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      activeAtlasWorkers.delete(worker);
      fireAndForget(worker.terminate(), 'atlasService.line977');
      reject(err);
    });
    
    worker.postMessage({
      type: 'project',
      id,
      fileVectors,
      filePaths,
    });
  });
}

/**
 * Get k-nearest neighbors for a file (lazy edge loading)
 * Delegates to the file_vectors k-NN search API.
 */
export interface AtlasNeighbor {
  path: string;
  relativePath: string;
  score: number;
}

export async function getAtlasNeighbors(
  filePath: string,
  limit = 5
): Promise<AtlasNeighbor[]> {
  try {
    const { findSimilarFiles } = await import('./fileIndexService');
    const results = await findSimilarFiles(filePath, limit);
    return results.map(result => ({
      path: result.path,
      relativePath: result.relativePath,
      // Keep the legacy atlas-neighbors IPC field name (`score`) for renderer compatibility.
      score: result.score,
    }));
  } catch (error) {
    logger.error({ err: error, filePath }, 'Failed to get Atlas neighbors');
    return [];
  }
}

/**
 * Clear the projection cache (call when workspace changes)
 */
export function clearAtlasCache(): void {
  projectionCache = null;
  currentWorkspacePath = null;
  logger.debug('Atlas cache cleared');
}

/**
 * Update workspace path (call when workspace changes)
 * Clears caches if workspace changed
 */
export function setAtlasWorkspace(workspacePath: string | null): void {
  if (workspacePath !== currentWorkspacePath) {
    projectionCache = null;
    currentWorkspacePath = workspacePath;
    logger.debug({ workspacePath }, 'Atlas workspace updated');
  }
}

/**
 * Phase 7: Get embedding for a search query
 * Uses BGE query prefix and L2-normalizes the result
 * @returns 384-dim L2-normalized embedding vector
 */
export async function getAtlasQueryEmbedding(query: string): Promise<number[]> {
  if (!query || query.trim().length === 0) {
    return [];
  }
  
  try {
    // Use the existing embedding service with query prefix
    const { generateQueryEmbedding } = await import('./embeddingService');
    const embedding = await generateQueryEmbedding(query.trim());
    
    // Convert Float32Array to regular array and L2-normalize
    const vector = Array.from(embedding);
    
    // L2 normalize (embeddings from BGE should already be normalized, but ensure it)
    const normalizedVector = l2Normalize(vector) ?? [];
    
    logger.debug({ queryLength: query.length, embeddingDim: normalizedVector.length }, 'Atlas query embedding generated');
    return normalizedVector;
    
  } catch (error) {
    logger.error({ err: error, query: query.substring(0, 50) }, 'Failed to generate Atlas query embedding');
    return [];
  }
}

/**
 * REBEL-4X: Terminate all active atlas workers during app shutdown.
 * Called from gracefulShutdown.ts before process exit.
 */
export async function terminateAllAtlasWorkers(): Promise<void> {
  isAtlasDisposed = true;
  const workers = [...activeAtlasWorkers];
  if (workers.length > 0) {
    logger.info({ count: workers.length }, 'Terminating active atlas workers for shutdown');
  }
  await Promise.allSettled(workers.map(w => w.terminate()));
  activeAtlasWorkers.clear();
}
