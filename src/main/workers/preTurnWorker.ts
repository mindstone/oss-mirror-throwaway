/**
 * Pre-Turn Context Worker (utilityProcess)
 *
 * Runs pre-turn processing in a separate OS process to avoid blocking the main
 * Electron process event loop. This keeps the UI responsive during:
 * - Semantic search (embedding generation + LanceDB queries)
 * - Tool index search
 *
 * Communication protocol (same pattern as embeddingWorker.ts):
 * - init: Initialize LanceDB connections and embedding model
 * - preTurnContext: Assemble context for a turn (semantic + tool search)
 * - dispose: Clean up resources
 *
 * IMPORTANT: This runs in a utilityProcess, NOT a worker_thread.
 * - Use `process.parentPort` instead of `parentPort` from worker_threads
 * - No access to Electron APIs (app, BrowserWindow, etc.)
 * - Paths must be passed via init message, not read from electron.app
 */

// MUST be the very first import — see docs/plans/260428_graceful_fs_emfile_fix.md
import '../startup/installGracefulFs';
import { fireAndForget } from '@shared/utils/fireAndForget';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
// Use relative path — workers are built by esbuild (scripts/build-worker.mjs)
// without the @core alias plugin. See build-worker.mjs pathAliases.
import { cosineDistance } from '../../core/utils/vectorMath';

// Types
type LanceDBConnection = Awaited<ReturnType<typeof import('@lancedb/lancedb').connect>>;
type LanceDBTable = Awaited<ReturnType<LanceDBConnection['openTable']>>;

// Relevance thresholds (copied from semanticContextService.ts)
const RELEVANCE_THRESHOLDS = {
  default: 0.50,
  explicitSearch: 0.30,
  actionIntent: 0.35,
} as const;

// Config limits
const MAX_CONTEXT_FILES = 5;
const _MAX_SNIPPET_LENGTH = 800;
const _MAX_SNIPPET_LENGTH_HIGH_CONFIDENCE = 3000;
const MAX_SNIPPET_LENGTH_MULTI_CHUNK = 5000;
const MAX_TOTAL_FILE_CONTEXT_CHARS = 15000;
const MAX_CHUNKS_PER_HIGH_CONFIDENCE_FILE = 3;
const HIGH_CONFIDENCE_FILE_THRESHOLD = 0.65;
const MAX_EXPLICIT_SEARCH_FILES = 15;
const MAX_ACTION_INTENT_FILES = 10;

// ============================================================================
// DUPLICATED CONSTANTS — canonical sources listed. MUST be kept in sync.
// This worker runs in a utilityProcess with no access to main-process modules.
//
// AUTO_CONVERSATION_THRESHOLD             ← conversationContextService.ts
// CONVERSATION_RECENCY_BOOST/HALF_LIFE   ← defined here only (no main-process equivalent)
// RELEVANCE_THRESHOLDS                    ← semanticContextService.ts
// formatContextForPrompt()                ← semanticContextService.ts
// getLanguageFromExtension()              ← semanticContextService.ts
// MAX_CONTEXT_FILES                       ← semanticContextService.ts
// MAX_SNIPPET_LENGTH                      ← semanticContextService.ts
// MAX_SNIPPET_LENGTH_MULTI_CHUNK          ← semanticContextService.ts
// MAX_TOTAL_FILE_CONTEXT_CHARS            ← semanticContextService.ts
// MAX_CHUNKS_PER_HIGH_CONFIDENCE_FILE     ← semanticContextService.ts
// MAX_EXPLICIT_SEARCH_FILES               ← semanticContextService.ts
// MAX_ACTION_INTENT_FILES                 ← semanticContextService.ts
// ACTION_VERBS                            ← semanticContextService.ts
// ============================================================================

// Conversation auto-injection config (keep in sync with conversationContextService.ts)
const MAX_AUTO_CONVERSATION_CANDIDATES = 5;
const AUTO_CONVERSATION_THRESHOLD = 0.70;

// Conversation recency boost — recent conversations are more likely to be what the user means.
// Uses shorter half-life than file search (3 days vs 7 days) because
// conversational relevance decays faster than document relevance.
// Canonical source: conversationContextService.ts
const CONVERSATION_RECENCY_BOOST = 0.15;
const CONVERSATION_RECENCY_HALF_LIFE_MS = 3 * 24 * 60 * 60 * 1000; // 3-day half-life

function calculateConversationRecencyBoost(updatedAt: number, nowMs: number = Date.now()): number {
  const ageMs = Math.max(0, nowMs - updatedAt);
  const decayFactor = Math.pow(2, -ageMs / CONVERSATION_RECENCY_HALF_LIFE_MS);
  return 1 + CONVERSATION_RECENCY_BOOST * decayFactor;
}

// Action verb detection
const ACTION_VERBS = /^(update|edit|modify|change|fix|add|create|remove|delete|refactor|implement|build|write|move|rename|replace|improve|optimize)/i;

// State
let nativeRequire: NodeRequire | null = null;
let config: WorkerConfig | null = null;

// Cache LanceDB module reference (but NOT connections - those are opened fresh each request)
let lancedbModule: typeof import('@lancedb/lancedb') | null = null;

interface WorkerConfig {
  userDataPath: string;
  workspacePath: string;
  unpackedNodeModules?: string;
}

interface WorkerMessage {
  type: 'init' | 'preTurnContext' | 'dispose';
  id?: string;
  config?: WorkerConfig;
  request?: PreTurnRequest;
}

interface PreTurnRequest {
  prompt: string;
  fileQueryEmbedding?: number[];  // For semantic file search
  toolQueryEmbedding?: number[];  // For tool search
  conversationQueryEmbedding?: number[];  // For conversation search
  skillQueryEmbedding?: number[];  // For skill search
  fileQueryText?: string;  // For hybrid FTS in file search (Stage 3)
  toolSearchIntentionallySkipped?: boolean;  // Smart query determined no tools needed
  toolIndexUsable?: boolean;  // False when main process marked tool index stale/invalidated
}

interface WorkerResponse {
  type: 'ready' | 'preTurnResult' | 'error' | 'disposed';
  id?: string;
  result?: PreTurnResult;
  error?: string;
  hasFileIndex?: boolean;
  hasToolIndex?: boolean;
  hasConversationIndex?: boolean;
}

interface PreTurnResult {
  semanticContext?: {
    formattedContext: string;
    fileCount: number;
    files?: Array<{ relativePath: string; score: number }>;
  };
  suggestedTools?: Array<{
    toolId: string;
    serverId: string;
    serverName: string;
    description: string;
    summary: string;
    inputSchema: string;
    score: number;
  }>;
  suggestedConversations?: Array<{
    sessionId: string;
    title: string;
    score: number;
    createdAt: number;
    messageCount: number;
  }>;
  suggestedSkills?: Array<{
    relativePath: string;
    skillName: string;
    description: string;
    score: number;
  }>;
  toolSearchStatus?: 'ok' | 'skipped' | 'unavailable';
  conversationSearchStatus?: 'ok' | 'unavailable';
}

interface SemanticSearchResult {
  relativePath: string;
  snippet: string;
  score: number;
  extension: string;
  chunkIndex?: number;
}

export function resolveToolSearchStatus(
  toolSearchIntentionallySkipped: boolean | undefined,
  searchStatus: 'ok' | 'unavailable' | undefined,
): PreTurnResult['toolSearchStatus'] {
  if (toolSearchIntentionallySkipped) {
    return 'skipped';
  }

  return searchStatus;
}

// Get parentPort from process (utilityProcess pattern)
const parentPort = process.parentPort;
if (!parentPort) {
  throw new Error('Pre-turn worker must be spawned via utilityProcess');
}

function sendResponse(response: WorkerResponse): void {
  parentPort.postMessage(response);
}

function createNativeRequire(unpackedNodeModules?: string): NodeRequire {
  if (unpackedNodeModules) {
    const unpackedPath = path.join(unpackedNodeModules, '.package-lock.json');
    return createRequire(unpackedPath);
  }
  return createRequire(__filename);
}

function getLanceDB(): typeof import('@lancedb/lancedb') {
  if (!lancedbModule) {
    if (!nativeRequire) {
      throw new Error('Worker not configured');
    }
    lancedbModule = nativeRequire('@lancedb/lancedb') as typeof import('@lancedb/lancedb');
  }
  return lancedbModule;
}

/**
 * Open a fresh file index table connection.
 * Returns null if index doesn't exist.
 * Caller is responsible for closing the connection after use.
 */
async function openFileIndexTable(): Promise<{ table: LanceDBTable; connection: LanceDBConnection } | null> {
  if (!config) {
    throw new Error('Worker not configured');
  }

  const lancedb = getLanceDB();
  const workspaceHash = crypto.createHash('sha256').update(config.workspacePath).digest('hex').slice(0, 16);
  const fileIndexDir = path.join(config.userDataPath, 'indices', workspaceHash, 'lancedb');
  
  // Check if directory exists first (avoids connection that would immediately fail)
  try {
    await fs.access(fileIndexDir);
  } catch {
    return null; // Directory doesn't exist
  }

  let connection: LanceDBConnection | null = null;
  try {
    connection = await lancedb.connect(fileIndexDir, {
      readConsistencyInterval: 1
    });
    const tableNames = await connection.tableNames();
    if (tableNames.includes('file_embeddings')) {
      const table = await connection.openTable('file_embeddings');
      return { table, connection };
    }
    // Table doesn't exist - close connection and return null
    connection.close();
    return null;
  } catch {
    // Ensure connection is closed on any error
    if (connection) {
      try {
        connection.close();
      } catch {
        // Ignore close errors
      }
    }
    return null;
  }
}

/**
 * Open a fresh tool index table connection.
 * Returns null if index doesn't exist.
 * Caller is responsible for closing the connection after use.
 */
async function openToolIndexTable(): Promise<{ table: LanceDBTable; connection: LanceDBConnection } | null> {
  if (!config) {
    throw new Error('Worker not configured');
  }

  const lancedb = getLanceDB();
  const toolIndexDir = path.join(config.userDataPath, 'indices', 'tools', 'lancedb');
  
  // Check if directory exists first (avoids connection that would immediately fail)
  try {
    await fs.access(toolIndexDir);
  } catch {
    return null; // Directory doesn't exist
  }

  let connection: LanceDBConnection | null = null;
  try {
    connection = await lancedb.connect(toolIndexDir, {
      readConsistencyInterval: 1
    });
    const tableNames = await connection.tableNames();
    if (tableNames.includes('tool_embeddings')) {
      const table = await connection.openTable('tool_embeddings');
      return { table, connection };
    }
    // Table doesn't exist - close connection and return null
    connection.close();
    return null;
  } catch {
    // Ensure connection is closed on any error
    if (connection) {
      try {
        connection.close();
      } catch {
        // Ignore close errors
      }
    }
    return null;
  }
}

/**
 * Open a fresh conversation index table connection.
 * Uses the GLOBAL path (not per-workspace) since conversations span workspaces.
 */
async function openConversationIndexTable(): Promise<{ table: LanceDBTable; connection: LanceDBConnection } | null> {
  if (!config) throw new Error('Worker not configured');

  const lancedb = getLanceDB();
  const conversationIndexDir = path.join(config.userDataPath, 'indices', 'global', 'conversations', 'lancedb');

  try {
    await fs.access(conversationIndexDir);
  } catch {
    return null;
  }

  let connection: LanceDBConnection | null = null;
  try {
    connection = await lancedb.connect(conversationIndexDir, { readConsistencyInterval: 1 });
    const tableNames = await connection.tableNames();
    if (tableNames.includes('conversation_embeddings')) {
      const table = await connection.openTable('conversation_embeddings');
      return { table, connection };
    }
    connection.close();
    return null;
  } catch {
    if (connection) {
      try { connection.close(); } catch { /* ignore */ }
    }
    return null;
  }
}

/**
 * Check if indices exist (for init response).
 * Opens and immediately closes connections to verify.
 */
async function checkIndicesExist(): Promise<{ hasFileIndex: boolean; hasToolIndex: boolean; hasConversationIndex: boolean }> {
  let hasFileIndex = false;
  let hasToolIndex = false;
  let hasConversationIndex = false;

  const fileHandle = await openFileIndexTable();
  if (fileHandle) {
    hasFileIndex = true;
    fileHandle.connection.close();
  }

  const toolHandle = await openToolIndexTable();
  if (toolHandle) {
    hasToolIndex = true;
    toolHandle.connection.close();
  }

  const conversationHandle = await openConversationIndexTable();
  if (conversationHandle) {
    hasConversationIndex = true;
    conversationHandle.connection.close();
  }

  return { hasFileIndex, hasToolIndex, hasConversationIndex };
}

function detectActionIntent(query: string): boolean {
  const trimmed = query.trim();
  if (ACTION_VERBS.test(trimmed)) return true;
  const imperativePattern = /^(can you|could you|please|help me|I need to|I want to)\s+(\w+)/i;
  const match = trimmed.match(imperativePattern);
  if (match && ACTION_VERBS.test(match[2])) return true;
  return false;
}

function parseSearchKeywords(prompt: string): { hasExplicitSearch: boolean; sanitizedPrompt: string; matchedKeyword?: string } {
  const trimmedPrompt = prompt.trim();
  const SEARCH_KEYWORDS = ['@files', '@skills'] as const;
  
  for (const keyword of SEARCH_KEYWORDS) {
    const pattern = new RegExp(`(^|\\s)(${keyword.replace('@', '@')})(?=$|[\\s,.:;!?\\n\\r])`, 'i');
    const match = trimmedPrompt.match(pattern);
    if (match) {
      const sanitizedPrompt = trimmedPrompt
        .replace(pattern, '$1')
        .trim()
        .replace(/^[,.:;!?\s]+/, '')
        .replace(/\s+/g, ' ');
      return { hasExplicitSearch: true, sanitizedPrompt, matchedKeyword: keyword };
    }
  }
  return { hasExplicitSearch: false, sanitizedPrompt: trimmedPrompt };
}

// NOTE: getLanguageFromExtension, formatContextForPrompt, extractQueryTerms,
// extractFocusedSnippet, findBreakPoint, and generateRelevanceReason are duplicated
// in semanticContextService.ts (main-process fallback). Keep both in sync.
// Cannot share via import because this worker runs in utilityProcess with no path aliases.

const FOCUSED_SNIPPET_MAX_LEN = 300;

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'it', 'as', 'be', 'was', 'are',
  'this', 'that', 'can', 'will', 'do', 'has', 'had', 'have', 'my', 'me',
  'our', 'we', 'you', 'your', 'its', 'their', 'them', 'they', 'he', 'she',
  'about', 'what', 'how', 'when', 'where', 'who', 'which', 'some', 'all',
  'any', 'each', 'not', 'would', 'could', 'should',
]);

function extractQueryTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[\s,;:!?.()[\]{}"'`]+/)
    .filter(t => t.length > 2 && !STOPWORDS.has(t));
}

function _extractFocusedSnippet(
  chunk: string,
  queryTerms: string[],
  maxLen = FOCUSED_SNIPPET_MAX_LEN,
): { text: string; charOffset: number } {
  if (chunk.length <= maxLen) {
    return { text: chunk, charOffset: 0 };
  }

  const lowerChunk = chunk.toLowerCase();
  const positions: number[] = [];
  for (const term of queryTerms) {
    let idx = lowerChunk.indexOf(term);
    while (idx !== -1) {
      positions.push(idx);
      idx = lowerChunk.indexOf(term, idx + 1);
    }
  }

  if (positions.length === 0) {
    const endPos = findBreakPoint(chunk, maxLen);
    return { text: chunk.slice(0, endPos), charOffset: 0 };
  }

  positions.sort((a, b) => a - b);
  let bestStart = positions[0];
  let bestCount = 0;
  for (const pos of positions) {
    const windowEnd = pos + maxLen;
    let count = 0;
    for (const p of positions) {
      if (p >= pos && p < windowEnd) count++;
    }
    if (count > bestCount) {
      bestCount = count;
      bestStart = pos;
    }
  }

  const rawStart = Math.max(0, bestStart - 40);
  const rawEnd = Math.min(chunk.length, rawStart + maxLen);

  let start = rawStart;
  if (start > 0) {
    const nextSpace = chunk.indexOf(' ', start);
    if (nextSpace !== -1 && nextSpace < start + 20) start = nextSpace + 1;
  }

  const end = findBreakPoint(chunk, rawEnd, start);
  return { text: chunk.slice(start, end), charOffset: start };
}

const SNIPPET_FRAGMENT_LEN = 100;
const MAX_SNIPPET_FRAGMENTS = 3;

function extractMultipleSnippets(
  fullSnippet: string,
  queryTerms: string[],
  maxFragments = MAX_SNIPPET_FRAGMENTS,
  fragmentLen = SNIPPET_FRAGMENT_LEN,
): string[] {
  if (fullSnippet.length <= fragmentLen * 2) {
    return [fullSnippet];
  }

  const chunks = fullSnippet.includes('\n\n[...]\n\n')
    ? fullSnippet.split('\n\n[...]\n\n')
    : [fullSnippet];

  const lowerContent = fullSnippet.toLowerCase();
  const positions: number[] = [];
  for (const term of queryTerms) {
    let idx = lowerContent.indexOf(term);
    while (idx !== -1) {
      positions.push(idx);
      idx = lowerContent.indexOf(term, idx + 1);
    }
  }

  if (positions.length === 0) {
    const fragments: string[] = [];
    for (const chunk of chunks) {
      if (fragments.length >= maxFragments) break;
      const endPos = findBreakPoint(chunk, fragmentLen);
      fragments.push(chunk.slice(0, endPos));
    }
    return fragments.length > 0 ? fragments : [fullSnippet.slice(0, fragmentLen)];
  }

  positions.sort((a, b) => a - b);

  const fragments: { text: string; start: number }[] = [];
  const used = new Set<number>();

  for (let attempt = 0; attempt < maxFragments * 3 && fragments.length < maxFragments; attempt++) {
    let bestStart = -1;
    let bestCount = 0;
    for (const pos of positions) {
      if (used.has(pos)) continue;
      const windowEnd = pos + fragmentLen;
      let count = 0;
      for (const p of positions) {
        if (!used.has(p) && p >= pos && p < windowEnd) count++;
      }
      if (count > bestCount) {
        bestCount = count;
        bestStart = pos;
      }
    }
    if (bestStart === -1 || bestCount === 0) break;

    const rawStart = Math.max(0, bestStart - 20);
    const rawEnd = Math.min(fullSnippet.length, rawStart + fragmentLen);

    let start = rawStart;
    if (start > 0) {
      const nextSpace = fullSnippet.indexOf(' ', start);
      if (nextSpace !== -1 && nextSpace < start + 15) start = nextSpace + 1;
    }
    const end = findBreakPoint(fullSnippet, rawEnd, start);
    const text = fullSnippet.slice(start, end);

    if (text.trim().length > 20) {
      fragments.push({ text, start });
      for (const p of positions) {
        if (p >= start && p < end) used.add(p);
      }
    }
  }

  fragments.sort((a, b) => a.start - b.start);

  return fragments.length > 0
    ? fragments.map(f => f.text)
    : [fullSnippet.slice(0, fragmentLen)];
}

function findBreakPoint(text: string, targetPos: number, searchFrom = 0): number {
  if (targetPos >= text.length) return text.length;
  const searchStart = Math.max(searchFrom, targetPos - 60);
  const window = text.slice(searchStart, targetPos);
  const sentenceEnd = Math.max(
    window.lastIndexOf('. '),
    window.lastIndexOf('? '),
    window.lastIndexOf('! '),
    window.lastIndexOf('.\n'),
  );
  if (sentenceEnd !== -1) return searchStart + sentenceEnd + 2;
  const lastSpace = text.lastIndexOf(' ', targetPos);
  if (lastSpace > searchFrom + 20) return lastSpace;
  return targetPos;
}

function generateRelevanceReason(
  relativePath: string,
  snippet: string,
  queryTerms: string[],
): string {
  if (queryTerms.length === 0) return '';
  const reasons: string[] = [];
  const lowerPath = relativePath.toLowerCase();
  const pathTerms = lowerPath.split(/[/\-_.]/).filter(t => t.length > 2);
  const pathMatches = queryTerms.filter(qt => pathTerms.some(pt => pt.includes(qt) || qt.includes(pt)));
  if (pathMatches.length > 0) {
    reasons.push(`path contains "${pathMatches.slice(0, 3).join('", "')}"`);
  }
  const lowerSnippet = snippet.toLowerCase();
  const snippetMatches = queryTerms
    .filter(qt => !pathMatches.includes(qt) && lowerSnippet.includes(qt))
    .slice(0, 4);
  if (snippetMatches.length > 0) {
    reasons.push(`content mentions "${snippetMatches.join('", "')}"`);
  }
  return reasons.length > 0 ? reasons.join('; ') : '';
}

function _getLanguageFromExtension(extension: string): string {
  const extLower = extension.toLowerCase().replace(/^\./, '');
  const languageMap: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    mjs: 'javascript', cjs: 'javascript', py: 'python', rb: 'ruby',
    go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', swift: 'swift',
    c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp', cs: 'csharp', php: 'php',
    sql: 'sql', sh: 'bash', bash: 'bash', zsh: 'bash', json: 'json',
    yaml: 'yaml', yml: 'yaml', toml: 'toml', xml: 'xml', html: 'html',
    css: 'css', scss: 'scss', less: 'less', md: 'markdown', mdx: 'markdown'
  };
  return languageMap[extLower] || '';
}

function formatContextForPrompt(results: SemanticSearchResult[], hints?: SemanticSearchResult[], userQuery?: string): string {
  if (results.length === 0 && (!hints || hints.length === 0)) return '';

  const queryTerms = userQuery ? extractQueryTerms(userQuery) : [];

  const sections = results.map((result, index) => {
    const snippets = extractMultipleSnippets(result.snippet, queryTerms);

    const reason = generateRelevanceReason(result.relativePath, result.snippet, queryTerms);
    const reasonLine = reason ? `**Why:** ${reason}\n` : '';

    const isPartial = result.snippet.length > SNIPPET_FRAGMENT_LEN * 2;
    const previewLabel = snippets.length > 1
      ? `**Snippets** (${snippets.length} excerpts from a longer file):`
      : (isPartial ? '**Preview** (short excerpt):' : '**Preview:**');

    const quotedSnippets = snippets
      .map(s => `> ${s.replace(/\n/g, '\n> ')}`)
      .join('\n>\n');

    return `### [${index + 1}] ${result.relativePath} (${(result.score * 100).toFixed(0)}% match)\n${reasonLine}${previewLabel}\n${quotedSnippets}\n\u2192 **Read this file** for full content`;
  });

  let hintSection = '';
  if (hints && hints.length > 0) {
    const hintLines = hints.map(h => `- \`${h.relativePath}\``);
    hintSection = `\n\n**Other possibly relevant files** (use Read tool if needed):\n${hintLines.join('\n')}`;
  }

  const preamble = `The following files from your Library may be relevant to this request. These are short previews — **Read the full files** before using their content in your response.
When referencing information, cite the source (e.g., "According to [1]..." or "see [2]").
If a file comes from a shared team space (e.g., under work/), mention the space or team context when referencing it.`;

  return `${preamble}\n\n${sections.join('\n\n')}${hintSection}`;
}

interface ChunkSelectionCandidate {
  relativePath: string;
  snippet: string;
  score: number;
  extension: string;
  chunkIndex: number;
}

function normalizeChunkIndex(chunkIndex: number | undefined, fallbackOrdinal: number): number {
  return chunkIndex != null && Number.isInteger(chunkIndex) ? chunkIndex : fallbackOrdinal * 1000;
}

function hasSignificantOverlap(
  candidate: { content: string; chunkIndex: number },
  kept: Array<{ content: string; chunkIndex: number }>,
  edgeWindowSize = 200,
): boolean {
  for (const existing of kept) {
    if (Math.abs(candidate.chunkIndex - existing.chunkIndex) <= 1) {
      return true;
    }

    if (candidate.content.length < edgeWindowSize) {
      if (candidate.content.length > 0 && existing.content.includes(candidate.content)) {
        return true;
      }
      continue;
    }

    const candidateStart = candidate.content.slice(0, edgeWindowSize);
    const candidateEnd = candidate.content.slice(-edgeWindowSize);
    if (existing.content.includes(candidateStart) || existing.content.includes(candidateEnd)) {
      return true;
    }
  }

  return false;
}

function selectNonOverlappingChunks(
  chunks: ChunkSelectionCandidate[],
  maxChunks: number,
): ChunkSelectionCandidate[] {
  if (chunks.length <= 1 || maxChunks <= 1) {
    return chunks.slice(0, 1);
  }

  const sorted = [...chunks].sort((a, b) => b.score - a.score);
  const kept: ChunkSelectionCandidate[] = [];

  for (const chunk of sorted) {
    if (kept.length >= maxChunks) break;

    const overlaps = hasSignificantOverlap(
      { content: chunk.snippet, chunkIndex: chunk.chunkIndex },
      kept.map((k) => ({ content: k.snippet, chunkIndex: k.chunkIndex })),
    );

    if (!overlaps) {
      kept.push(chunk);
    }
  }

  return kept.length > 0 ? kept : [sorted[0]];
}

function mergeChunksForFile(
  chunks: ChunkSelectionCandidate[],
  maxSnippetLength = MAX_SNIPPET_LENGTH_MULTI_CHUNK,
): SemanticSearchResult {
  const sortedByScore = [...chunks].sort((a, b) => b.score - a.score);
  const best = sortedByScore[0];
  if (!best) {
    throw new Error('mergeChunksForFile requires at least one chunk');
  }

  if (sortedByScore.length === 1) {
    return {
      relativePath: best.relativePath,
      snippet: best.snippet,
      score: best.score,
      extension: best.extension,
      chunkIndex: best.chunkIndex,
    };
  }

  const orderedForMerge = [...sortedByScore].sort((a, b) => a.chunkIndex - b.chunkIndex);

  const separator = '\n\n[...]\n\n';
  const separatorChars = separator.length * (orderedForMerge.length - 1);
  const availableSnippetChars = Math.max(1, maxSnippetLength - separatorChars);
  const perChunkBudget = Math.max(1, Math.floor(availableSnippetChars / orderedForMerge.length));

  const mergedSnippet = orderedForMerge
    .map((chunk) => chunk.snippet.length > perChunkBudget ? chunk.snippet.slice(0, perChunkBudget) : chunk.snippet)
    .join(separator);

  return {
    relativePath: best.relativePath,
    snippet: mergedSnippet.length > maxSnippetLength ? mergedSnippet.slice(0, maxSnippetLength) : mergedSnippet,
    score: best.score,
    extension: best.extension,
    chunkIndex: best.chunkIndex,
  };
}

function applyTotalFileContextCharCap(
  results: SemanticSearchResult[],
  maxTotalChars = MAX_TOTAL_FILE_CONTEXT_CHARS,
): SemanticSearchResult[] {
  const totalChars = results.reduce((sum, result) => sum + result.snippet.length, 0);
  if (totalChars <= maxTotalChars) return results;

  const sortedByScore = [...results].sort((a, b) => b.score - a.score);
  const kept: SemanticSearchResult[] = [];
  let charsUsed = 0;

  for (const result of sortedByScore) {
    if (charsUsed + result.snippet.length > maxTotalChars && kept.length > 0) {
      continue;
    }
    kept.push(result);
    charsUsed += result.snippet.length;
  }

  return kept;
}

function selectAndMergeMultiChunkResults(results: SemanticSearchResult[]): SemanticSearchResult[] {
  if (results.length <= 1) return results;

  const chunksByPath = new Map<string, ChunkSelectionCandidate[]>();
  const maxScoreByPath = new Map<string, number>();

  for (const result of results) {
    const existing = chunksByPath.get(result.relativePath) ?? [];
    const normalizedChunk: ChunkSelectionCandidate = {
      relativePath: result.relativePath,
      snippet: result.snippet,
      score: result.score,
      extension: result.extension,
      chunkIndex: normalizeChunkIndex(result.chunkIndex, existing.length),
    };
    existing.push(normalizedChunk);
    chunksByPath.set(result.relativePath, existing);
    maxScoreByPath.set(result.relativePath, Math.max(maxScoreByPath.get(result.relativePath) ?? 0, result.score));
  }

  const merged: SemanticSearchResult[] = [];
  for (const [relativePath, chunks] of chunksByPath) {
    const sortedByScore = [...chunks].sort((a, b) => b.score - a.score);
    const maxScore = maxScoreByPath.get(relativePath) ?? 0;

    if (maxScore >= HIGH_CONFIDENCE_FILE_THRESHOLD && sortedByScore.length > 1) {
      const selected = selectNonOverlappingChunks(sortedByScore, MAX_CHUNKS_PER_HIGH_CONFIDENCE_FILE);
      merged.push(mergeChunksForFile(selected));
      continue;
    }

    const best = sortedByScore[0];
    if (best) {
      merged.push({
        relativePath: best.relativePath,
        snippet: best.snippet,
        score: best.score,
        extension: best.extension,
        chunkIndex: best.chunkIndex,
      });
    }
  }

  merged.sort((a, b) => b.score - a.score);
  return applyTotalFileContextCharCap(merged);
}

/**
 * Check if the file index table has FTS capability (filename_stem column present).
 * FTS indexes are created on content + filename_stem columns; if filename_stem
 * is missing, the table predates the FTS migration and hybrid search won't work.
 */
async function hasFtsCapability(table: LanceDBTable): Promise<boolean> {
  try {
    const schema = await table.schema();
    const fields = schema.fields as Array<{ name: string }>;
    return fields.some((f) => f.name === 'filename_stem');
  } catch {
    return false;
  }
}

async function semanticSearch(
  embedding: number[] | undefined,
  options: { limit?: number; threshold?: number; queryText?: string; allowMultiChunk?: boolean } = {}
): Promise<SemanticSearchResult[]> {
  // Validate embedding is provided and valid
  if (!embedding || !Array.isArray(embedding) || embedding.length === 0) {
    console.warn('Semantic search: No valid embedding provided, returning empty results');
    return [];
  }

  const { limit = 10, threshold = 0.3, queryText, allowMultiChunk = false } = options;

  // Open a fresh connection for this query (short-lived to avoid stale handles)
  const handle = await openFileIndexTable();
  if (!handle) return [];

  try {
    // Determine if hybrid search is possible: FTS requires filename_stem column + query text
    const canHybrid = queryText && queryText.trim().length > 0 && await hasFtsCapability(handle.table);

    if (canHybrid) {
      // --- Hybrid search path: vector + FTS + RRF reranking ---
      // Matches the pattern in fileIndexService.ts semanticSearch()
      try {
        const lancedb = getLanceDB();

        const ftsQuery = new lancedb.MultiMatchQuery(queryText.trim(), ['content', 'filename_stem'], {
          boosts: [1.0, 2.0]  // Boost filename matches
        });

        const reranker = await lancedb.rerankers.RRFReranker.create(60);

        const hybridQuery = handle.table
          .query()
          .nearestTo(Array.from(embedding))
          .distanceType('cosine')
          .fullTextSearch(ftsQuery)
          .rerank(reranker)
          .limit(limit * 3);

        const rawResults = await hybridQuery.toArray();

        // Process hybrid results:
        // _distance is ALWAYS null in hybrid mode — compute cosine similarity manually
        // Use _relevance_score (RRF) for ranking order, cosine score for threshold
        const candidates: (SemanticSearchResult & { rrfScore: number })[] = [];
        const bestByPath = new Map<string, SemanticSearchResult & { rrfScore: number }>();

        for (const row of rawResults) {
          const record = row as {
            relativePath: string;
            content: string;
            extension: string;
            chunkIndex?: number;
            vector: number[] | Float32Array;
            _relevance_score?: number;
          };

          // Compute cosine similarity manually (hybrid returns null _distance)
          const score = 1 - cosineDistance(embedding, record.vector);

          // Guard against NaN: non-finite scores fail the threshold check
          if (!Number.isFinite(score) || score < threshold) continue;

          const candidate = {
            relativePath: record.relativePath,
            snippet: record.content,
            extension: record.extension,
            score,
            chunkIndex: record.chunkIndex,
            rrfScore: record._relevance_score ?? 0,
          };

          if (allowMultiChunk) {
            candidates.push(candidate);
            continue;
          }

          const existing = bestByPath.get(record.relativePath);
          if (!existing || candidate.rrfScore > existing.rrfScore) {
            bestByPath.set(record.relativePath, candidate);
          }
        }

        const results = allowMultiChunk ? candidates : Array.from(bestByPath.values());

        // Sort by RRF score for ranking (higher = more relevant)
        results.sort((a, b) => b.rrfScore - a.rrfScore);

        const outputLimit = allowMultiChunk ? limit * 3 : limit;
        return results.slice(0, outputLimit).map(({ rrfScore: _rrf, ...rest }) => rest);
      } catch (hybridError) {
        // Hybrid search failed — fall through to vector-only below
        console.warn('Hybrid search failed, falling back to vector-only:', hybridError);
      }
    }

    // --- Vector-only fallback (or primary path when FTS unavailable) ---
    const vectorResults = await handle.table
      .vectorSearch(embedding)
      .distanceType('cosine')
      .limit(limit * 3)
      .toArray();

    // Convert distance to similarity score (cosine distance -> similarity)
    const candidates: SemanticSearchResult[] = [];
    const bestByPath = new Map<string, SemanticSearchResult>();
    for (const row of vectorResults) {
      const record = row as {
        relativePath: string;
        content: string;
        extension: string;
        chunkIndex?: number;
        _distance: number;
      };
      const score = 1 - record._distance;
      if (score >= threshold) {
        const candidate: SemanticSearchResult = {
          relativePath: record.relativePath,
          snippet: record.content,
          extension: record.extension,
          score,
          chunkIndex: record.chunkIndex,
        };

        candidates.push(candidate);

        // Vector-only dedup safety: keep highest score per path when multi-chunk mode is disabled.
        // This closes the old bug where vector fallback returned duplicate paths.
        const existing = bestByPath.get(record.relativePath);
        if (!existing || candidate.score > existing.score) {
          bestByPath.set(record.relativePath, candidate);
        }
      }
    }

    if (allowMultiChunk) {
      candidates.sort((a, b) => b.score - a.score);
      return candidates.slice(0, limit * 3);
    }

    return Array.from(bestByPath.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  } catch (error) {
    console.error('Semantic search error:', error);
    return [];
  } finally {
    // Always close the connection to avoid stale handles
    handle.connection.close();
  }
}

async function searchTools(
  embedding: number[] | undefined,
  limit: number = 10,
  threshold: number = 0.35,
  maxPerServer: number = 5,
  toolIndexUsable: boolean = true,
): Promise<{ results: NonNullable<PreTurnResult['suggestedTools']>; status: 'ok' | 'unavailable' }> {
  if (!toolIndexUsable) {
    return { results: [], status: 'unavailable' };
  }

  // Validate embedding is provided and valid
  if (!embedding || !Array.isArray(embedding) || embedding.length === 0) {
    console.warn('Tool search: No valid embedding provided, returning empty results');
    return { results: [], status: 'unavailable' };
  }

  // Open a fresh connection for this query (short-lived to avoid stale handles)
  const handle = await openToolIndexTable();
  if (!handle) return { results: [], status: 'unavailable' };

  try {
    const vectorResults = await handle.table
      .vectorSearch(embedding)
      .distanceType('cosine')
      .limit(limit * 3)
      .toArray();

    const results: NonNullable<PreTurnResult['suggestedTools']> = [];

    const serverCounts = new Map<string, number>();

    for (const row of vectorResults) {
      const record = row as {
        toolId: string;
        serverId: string;
        serverName: string;
        description: string;
        summary: string;
        inputSchema: string;
        _distance: number;
      };
      const score = 1 - record._distance;
      if (score < threshold) continue;

      const serverCount = serverCounts.get(record.serverId) || 0;
      if (serverCount >= maxPerServer) continue;

      serverCounts.set(record.serverId, serverCount + 1);
      results.push({
        toolId: record.toolId,
        serverId: record.serverId,
        serverName: record.serverName,
        description: record.description,
        summary: record.summary,
        inputSchema: record.inputSchema || '{}',
        score
      });

      if (results.length >= limit) break;
    }

    return { results, status: 'ok' };
  } catch (error) {
    console.error('Tool search error:', error);
    return { results: [], status: 'unavailable' };
  } finally {
    // Always close the connection to avoid stale handles
    handle.connection.close();
  }
}

/**
 * Search conversations by vector similarity with recency boost.
 * Over-fetches, deduplicates by sessionId, applies recency boost for ranking,
 * then sorts by boosted score and returns top candidates.
 *
 * Scoring rules (important — see docs/plans/260327_semantic_search_quality_improvements.md):
 * - Raw cosine similarity is used for threshold filtering (0.55)
 * - Boosted score (raw * recency multiplier) is used for ranking order
 * - The returned `score` field contains the raw cosine similarity (not boosted)
 *   so downstream consumers see the true semantic match quality
 */
async function searchConversations(
  embedding: number[] | undefined,
): Promise<{ results: PreTurnResult['suggestedConversations'] & Array<unknown>; status: 'ok' | 'unavailable' }> {
  if (!embedding || embedding.length === 0) {
    return { results: [], status: 'unavailable' };
  }

  const handle = await openConversationIndexTable();
  if (!handle) return { results: [], status: 'unavailable' };

  try {
    const nowMs = Date.now();
    const vectorResults = await handle.table
      .vectorSearch(embedding)
      .distanceType('cosine')
      .limit(MAX_AUTO_CONVERSATION_CANDIDATES * 3)
      .toArray();

    // Phase 1: Collect all candidates above raw threshold, deduplicate
    const candidates: Array<{
      sessionId: string;
      title: string;
      rawScore: number;
      boostedScore: number;
      createdAt: number;
      messageCount: number;
    }> = [];
    const seenSessionIds = new Set<string>();

    for (const row of vectorResults) {
      const record = row as {
        sessionId: string;
        title: string;
        createdAt: number;
        updatedAt: number;
        messageCount: number;
        _distance: number;
      };
      const rawScore = 1 - record._distance;
      if (rawScore < AUTO_CONVERSATION_THRESHOLD) continue;
      if (seenSessionIds.has(record.sessionId)) continue;
      seenSessionIds.add(record.sessionId);

      const lastUpdate = record.updatedAt ?? record.createdAt;
      const boost = calculateConversationRecencyBoost(lastUpdate, nowMs);

      candidates.push({
        sessionId: record.sessionId,
        title: record.title,
        rawScore,
        boostedScore: rawScore * boost,
        createdAt: record.createdAt,
        messageCount: record.messageCount,
      });
    }

    // Phase 2: Sort by boosted score (recency-weighted) and take top N
    candidates.sort((a, b) => b.boostedScore - a.boostedScore);

    const results: NonNullable<PreTurnResult['suggestedConversations']> = candidates
      .slice(0, MAX_AUTO_CONVERSATION_CANDIDATES)
      .map(c => ({
        sessionId: c.sessionId,
        title: c.title,
        score: c.rawScore,
        createdAt: c.createdAt,
        messageCount: c.messageCount,
      }));

    return { results, status: 'ok' };
  } catch (error) {
    console.error('Conversation search error:', error);
    return { results: [], status: 'unavailable' };
  } finally {
    handle.connection.close();
  }
}

// Skill search config
const SKILL_SEARCH_THRESHOLD = 0.35;
const SKILL_SEARCH_LIMIT = 5;

/**
 * Search for relevant skills by querying the file index and filtering to SKILL.md files.
 * Until Stage 4 builds a dedicated skill index, this reuses the file index.
 */
async function searchSkills(
  embedding: number[] | undefined,
): Promise<Array<{ relativePath: string; skillName: string; description: string; score: number }>> {
  if (!embedding || !Array.isArray(embedding) || embedding.length === 0) {
    return [];
  }

  const handle = await openFileIndexTable();
  if (!handle) return [];

  try {
    // Over-fetch to compensate for filtering
    const vectorResults = await handle.table
      .vectorSearch(embedding)
      .distanceType('cosine')
      .limit(SKILL_SEARCH_LIMIT * 10)
      .toArray();

    const results: Array<{ relativePath: string; skillName: string; description: string; score: number }> = [];
    const seenSkillPaths = new Set<string>();

    for (const row of vectorResults) {
      const record = row as { relativePath: string; content: string; _distance: number };
      const score = 1 - record._distance;
      if (score < SKILL_SEARCH_THRESHOLD) continue;

      // Filter to skill files: path contains /skills/ and ends with skill.md (case-insensitive)
      // Use forward slashes (LanceDB stores portable paths on all platforms)
      const pathLower = record.relativePath.toLowerCase();
      if (!pathLower.includes('/skills/') || !pathLower.endsWith('skill.md')) continue;

      // Dedup by skill path (multi-chunk files can produce multiple hits)
      const skillPathKey = pathLower;
      if (seenSkillPaths.has(skillPathKey)) continue;
      seenSkillPaths.add(skillPathKey);

      // Extract skill name from path (last directory before SKILL.md)
      const parts = record.relativePath.split('/');
      const skillDirIndex = parts.length - 2;
      const skillName = skillDirIndex >= 0
        ? parts[skillDirIndex].replace(/-/g, ' ')
        : record.relativePath;

      // Use first line or first 150 chars of content as description
      const firstLine = record.content.split('\n').find(l => l.trim().length > 0) ?? '';
      const description = firstLine.length > 150 ? firstLine.slice(0, 147) + '...' : firstLine;

      results.push({ relativePath: record.relativePath, skillName, description, score });
      if (results.length >= SKILL_SEARCH_LIMIT) break;
    }

    return results;
  } catch (error) {
    console.error('Skill search error:', error);
    return [];
  } finally {
    handle.connection.close();
  }
}

async function assemblePreTurnContext(request: PreTurnRequest): Promise<PreTurnResult> {
  const result: PreTurnResult = {};

  // With smart query generation, individual embeddings may be undefined (empty query = skip index).
  // Only abort if NO embeddings are available at all.
  if (!request.fileQueryEmbedding && !request.toolQueryEmbedding && !request.conversationQueryEmbedding && !request.skillQueryEmbedding) {
    console.warn('Pre-turn context: No embeddings provided, returning empty results');
    // Preserve intentional skip status even on early return (smart query may have
    // determined no tools/files/conversations/skills needed for this prompt)
    const toolSearchStatus = resolveToolSearchStatus(
      request.toolSearchIntentionallySkipped,
      request.toolIndexUsable === false ? 'unavailable' : undefined,
    );
    if (toolSearchStatus) {
      result.toolSearchStatus = toolSearchStatus;
    }
    return result;
  }

  const { hasExplicitSearch, sanitizedPrompt } = parseSearchKeywords(request.prompt);
  const queryForSearch = hasExplicitSearch ? sanitizedPrompt : request.prompt;
  const hasActionIntent = detectActionIntent(queryForSearch);

  let fileLimit = MAX_CONTEXT_FILES;
  let fileThreshold: number = RELEVANCE_THRESHOLDS.default;

  if (hasExplicitSearch) {
    fileLimit = MAX_EXPLICIT_SEARCH_FILES;
    fileThreshold = RELEVANCE_THRESHOLDS.explicitSearch;
  } else if (hasActionIntent) {
    fileLimit = MAX_ACTION_INTENT_FILES;
    fileThreshold = RELEVANCE_THRESHOLDS.actionIntent;
  }

  // Run file, tool, conversation, and skill search in parallel
  const searchStartTime = Date.now();
  const [rawFileResults, toolResults, conversationResults, skillResults] = await Promise.all([
    // NOTE: this pre-turn file search intentionally does NOT opt into the F9
    // lexical exemption, even when `hasExplicitSearch` is set. Its results are
    // silently injected as `pre-turn-context` (never shown as a user-visible
    // result list), so a low-cosine keyword coincidence surviving the floor here
    // would reintroduce the F1 failure mode (context flooding every turn). The
    // explicit user-facing surfaces (rebel_search_files, @files IPC) opt in
    // instead. Keep this gate strict — it is not a missed F9 call site.
    semanticSearch(request.fileQueryEmbedding, {
      limit: fileLimit,
      threshold: fileThreshold,
      queryText: request.fileQueryText ?? request.prompt,
      allowMultiChunk: true,
    }),
    searchTools(request.toolQueryEmbedding, 10, 0.35, 5, request.toolIndexUsable !== false),
    searchConversations(request.conversationQueryEmbedding),
    searchSkills(request.skillQueryEmbedding),
  ]);
  const searchDurationMs = Date.now() - searchStartTime;
  const fileResults = selectAndMergeMultiChunkResults(rawFileResults).slice(0, fileLimit);

  // Diagnostic: log search results metadata
  {
    const topFileScore = fileResults.length > 0 ? fileResults[0].score : undefined;
    const actualFileQuery = request.fileQueryText ?? request.prompt;
    const queryHash = actualFileQuery
      ? crypto.createHash('md5').update(actualFileQuery).digest('hex').slice(0, 8)
      : undefined;
    console.warn(JSON.stringify({
      level: 'info',
      msg: 'Pre-turn worker search results',
      queryHash,
      fileResultCount: fileResults.length,
      toolResultCount: toolResults.results.length,
      conversationResultCount: conversationResults.results.length,
      skillResultCount: skillResults.length,
      topFileScore,
      fileThreshold,
      hasExplicitSearch,
      hasActionIntent,
      searchDurationMs,
    }));
  }

  if (fileResults.length > 0) {
    result.semanticContext = {
      formattedContext: formatContextForPrompt(fileResults, undefined, request.prompt),
      fileCount: fileResults.length,
      files: fileResults.map(f => ({ relativePath: f.relativePath, score: f.score })),
    };
  }

  if (toolResults.results.length > 0) {
    result.suggestedTools = toolResults.results;
  }
  // Set tool search status: explicit skip overrides the search result status
  result.toolSearchStatus = resolveToolSearchStatus(request.toolSearchIntentionallySkipped, toolResults.status);

  if (skillResults.length > 0) {
    result.suggestedSkills = skillResults;
  }

  if (conversationResults.results.length > 0) {
    result.suggestedConversations = conversationResults.results;
  }
  result.conversationSearchStatus = conversationResults.status;

  return result;
}

async function handleMessage(msg: WorkerMessage): Promise<void> {
  try {
    switch (msg.type) {
      case 'init': {
        if (!msg.config) {
          throw new Error('Config required for init');
        }
        config = msg.config;
        nativeRequire = createNativeRequire(config.unpackedNodeModules);
        
        const { hasFileIndex, hasToolIndex, hasConversationIndex } = await checkIndicesExist();
        
        sendResponse({
          type: 'ready',
          hasFileIndex,
          hasToolIndex,
          hasConversationIndex,
        });
        break;
      }

      case 'preTurnContext': {
        if (!msg.request) {
          throw new Error('Request required for preTurnContext');
        }
        const result = await assemblePreTurnContext(msg.request);
        sendResponse({ type: 'preTurnResult', id: msg.id, result });
        break;
      }

      case 'dispose': {
        // No persistent connections to close - we use short-lived connections
        // that are opened and closed per-request
        lancedbModule = null;
        sendResponse({ type: 'disposed' });
        break;
      }
    }
  } catch (error) {
    sendResponse({
      type: 'error',
      id: msg.id,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

parentPort.on('message', (event: { data: WorkerMessage }) => {
  fireAndForget(handleMessage(event.data), 'preTurnWorker.handleMessage');
});
