/**
/**
 * Threshold Analysis Spike (Stage 0)
 *
 * Runs semantic-search threshold analysis against real LanceDB indices:
 * - File index (workspace-scoped)
 * - Conversation index (global)
 * - Tool index (global)
 *
 * Outputs:
 * - Human-readable summary to stdout
 * - Machine-readable JSON at tmp/threshold-analysis-results.json
 *
 * Usage:
 *   npx tsx scripts/threshold-analysis.ts
 *   npx tsx scripts/threshold-analysis.ts --workspace-path "/abs/workspace/path"
 *   npx tsx scripts/threshold-analysis.ts --queries "/abs/path/to/queries.json"
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type LanceDBModule = typeof import('@lancedb/lancedb');
type LanceDBConnection = Awaited<ReturnType<LanceDBModule['connect']>>;
type LanceDBTable = Awaited<ReturnType<LanceDBConnection['openTable']>>;

interface EmbeddingTensorLike {
  tolist(): unknown;
  dispose?: () => void;
}

type EmbeddingPipeline = (
  inputs: string[],
  options: { pooling: 'mean'; normalize: true },
) => Promise<EmbeddingTensorLike> | EmbeddingTensorLike;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const OUTPUT_JSON_PATH = path.join(REPO_ROOT, 'tmp', 'threshold-analysis-results.json');

const MODEL_NAME = 'Xenova/bge-small-en-v1.5';
const BGE_QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';

const CONVERSATION_RECENCY_BOOST = 0.15;
const CONVERSATION_RECENCY_HALF_LIFE_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

const TABLE_NAMES = {
  file: 'file_embeddings',
  conversation: 'conversation_embeddings',
  tool: 'tool_embeddings',
} as const;

const HISTOGRAM_BIN_SIZE = 0.05;
const DISTRIBUTION_PERCENTILES = [10, 25, 50, 75, 90, 95] as const;
const THRESHOLD_LEVELS = [0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9];
const FILE_MULTI_CHUNK_THRESHOLDS = [0.5, 0.6, 0.7, 0.8] as const;
const EDGE_COMPARE_CHARS = 200;
const MAX_PAIR_SAMPLES_PER_THRESHOLD = 25;
const TOP_N_RECENCY_COMPARISON = 5;

const DEFAULT_QUERIES: string[] = [
  // Short queries (1-15 chars) — realistic minimal user inputs
  'hi',
  'help',
  'meeting',
  'Q4 numbers',
  'email draft',
  'onboarding',
  'action items',
  // Medium-short queries (16-30 chars)
  'prep for tomorrow',
  'rebrand timeline',
  'pricing changes email',
  'product meeting notes',
  'revenue forecast Q4',
  'enterprise onboarding',
  // Medium queries (31-45 chars)
  'meeting prep for tomorrow leadership sync',
  'what did we decide about the rebrand timeline',
  'Q4 revenue numbers and forecast assumptions',
  'what are the main themes in user feedback',
  'help me plan next week priorities',
  'summarize decisions from strategy offsite',
  'create talking points for partner meeting',
  'prepare a one-page weekly executive brief',
  'prepare a board update on growth and risks',
  'find notes about hiring plan for engineering',
  // Long queries (46+ chars)
  'draft an email to a client about pricing changes',
  'summarize action items from last product meeting',
  'customer success playbook for enterprise onboarding',
  'competitive analysis for Salesforce alternatives',
  'research summary on AI safety regulation updates',
  'write a follow-up after investor conversation',
  'status update for delayed launch milestones',
  'document synthesis for product requirements',
  'draft a concise project timeline update',
  'find context on churn and retention discussions',
  'collect references about roadmap commitments',
  'what did we promise in the last customer call',
  'gather research on market positioning',
  'find tool guidance for Gmail and calendar workflows',
];

interface QueryLengthBucket {
  label: string;
  minLen: number;
  maxLen: number;
  queryCount: number;
  avgMaxScore: number | null;
  avgMeanScore: number | null;
  avgP90Score: number | null;
  maxScoreRange: [number, number] | null;
  queries: Array<{ query: string; maxScore: number | null }>;
}

const QUERY_LENGTH_BUCKETS: Array<{ label: string; minLen: number; maxLen: number }> = [
  { label: 'short (1-15 chars)', minLen: 1, maxLen: 15 },
  { label: 'medium-short (16-30 chars)', minLen: 16, maxLen: 30 },
  { label: 'medium (31-45 chars)', minLen: 31, maxLen: 45 },
  { label: 'long (46+ chars)', minLen: 46, maxLen: Infinity },
];

interface CliOptions {
  workspacePath?: string;
  userDataPath?: string;
  queriesPath?: string;
  help: boolean;
}

interface WorkspaceResolution {
  workspacePath: string | null;
  source: 'cli' | 'app-settings' | 'env' | 'none';
}

interface OpenIndexHandle {
  kind: 'file' | 'conversation' | 'tool';
  lanceDir: string;
  tableName: string;
  rowCount: number;
  connection: LanceDBConnection;
  table: LanceDBTable;
}

interface MissingIndex {
  available: false;
  kind: 'file' | 'conversation' | 'tool';
  lanceDir: string;
  tableName: string;
  reason: string;
}

interface AvailableIndex {
  available: true;
  kind: 'file' | 'conversation' | 'tool';
  lanceDir: string;
  tableName: string;
  rowCount: number;
}

type IndexAvailability = MissingIndex | AvailableIndex;

interface QueryScoreSummary {
  query: string;
  resultCount: number;
  min: number | null;
  max: number | null;
  mean: number | null;
  p90: number | null;
}

interface HistogramBin {
  label: string;
  start: number;
  end: number;
  count: number;
  pct: number;
}

interface DistributionSummary {
  count: number;
  min: number;
  max: number;
  mean: number;
  percentiles: Record<string, number>;
  histogram: {
    binSize: number;
    bins: HistogramBin[];
    belowZero: number;
    aboveOne: number;
  };
  thresholdCounts: Array<{ threshold: number; count: number; pct: number }>;
}

interface FileChunkResult {
  relativePath: string;
  chunkIndex: number;
  score: number;
  content: string;
}

interface ChunkPairComparison {
  edgeOverlap: boolean;
  adjacentChunkIndex: boolean;
  likelyOverlap: boolean;
  matches: {
    aStartInB: boolean;
    aEndInB: boolean;
    bStartInA: boolean;
    bEndInA: boolean;
  };
}

interface FileChunkPairSample {
  query: string;
  relativePath: string;
  chunkAIndex: number;
  chunkBIndex: number;
  chunkAScore: number;
  chunkBScore: number;
  edgeOverlap: boolean;
  adjacentChunkIndex: boolean;
  likelyOverlap: boolean;
  matches: ChunkPairComparison['matches'];
}

interface FileMultiChunkThresholdSummary {
  threshold: number;
  queriesWithMultiChunk: number;
  queriesWithMultiChunkPct: number;
  totalMultiChunkFiles: number;
  totalChunksInMultiChunkFiles: number;
  pairCount: number;
  edgeOverlapPairs: number;
  adjacentChunkPairs: number;
  likelyOverlapPairs: number;
  distinctPairs: number;
  distinctPairPct: number | null;
  samplePairs: FileChunkPairSample[];
}

interface FileIndexAnalysis {
  availability: IndexAvailability;
  queryCount: number;
  totalScoresAnalyzed: number;
  distributionBasis: 'chunk-level-vector-search';
  scoreDistribution: DistributionSummary | null;
  querySummaries: QueryScoreSummary[];
  queryLengthBuckets: QueryLengthBucket[];
  multiChunkAnalysis: {
    compareChars: number;
    thresholds: FileMultiChunkThresholdSummary[];
  };
}

interface ToolIndexAnalysis {
  availability: IndexAvailability;
  queryCount: number;
  totalScoresAnalyzed: number;
  scoreDistribution: DistributionSummary | null;
  querySummaries: QueryScoreSummary[];
}

interface ConversationIndexAnalysis {
  availability: IndexAvailability;
  queryCount: number;
  totalRawScoresAnalyzed: number;
  totalBoostedScoresAnalyzed: number;
  rawScoreDistribution: DistributionSummary | null;
  boostedScoreDistribution: DistributionSummary | null;
  boostMultiplierDistribution: DistributionSummary | null;
  querySummaries: Array<{
    query: string;
    resultCount: number;
    topRawScore: number | null;
    topBoostedScore: number | null;
    topResultChanged: boolean;
    topNOverlap: number;
  }>;
  recencyImpact: {
    top1ChangedQueries: number;
    top1ChangedQueriesPct: number;
    averageTopNOverlap: number | null;
  };
}

interface ThresholdAnalysisOutput {
  generatedAt: string;
  model: string;
  querySource: 'default' | 'file';
  queryCount: number;
  queries: string[];
  workspace: {
    userDataPath: string;
    workspacePath: string | null;
    workspacePathSource: WorkspaceResolution['source'];
    workspaceHash: string | null;
    fileIndexDir: string | null;
    conversationIndexDir: string;
    toolIndexDir: string;
  };
  indices: {
    file: FileIndexAnalysis;
    conversation: ConversationIndexAnalysis;
    tool: ToolIndexAnalysis;
  };
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { help: false };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--workspace-path': {
        const value = argv[++i];
        if (!value) throw new Error('--workspace-path requires a value');
        opts.workspacePath = value;
        break;
      }
      case '--user-data-path': {
        const value = argv[++i];
        if (!value) throw new Error('--user-data-path requires a value');
        opts.userDataPath = value;
        break;
      }
      case '--queries': {
        const value = argv[++i];
        if (!value) throw new Error('--queries requires a value');
        opts.queriesPath = value;
        break;
      }
      case '--help':
      case '-h':
        opts.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return opts;
}

function showHelp(): void {
  console.log(`
Threshold Analysis Spike (Stage 0)

Usage:
  npx tsx scripts/threshold-analysis.ts [options]

Options:
  --workspace-path <path>  Workspace root path used to locate file index hash
  --user-data-path <path>  Override userData path (default: standard app data path)
  --queries <json-path>    Load query array from JSON file (default: built-in query set)
  --help, -h               Show this help text

Examples:
  npx tsx scripts/threshold-analysis.ts
  npx tsx scripts/threshold-analysis.ts --workspace-path "/Users/me/workspace"
  npx tsx scripts/threshold-analysis.ts --queries "/tmp/my-queries.json"
`);
}

function getDefaultUserDataPath(): string {
  if (process.env.REBEL_USER_DATA && process.env.REBEL_USER_DATA.trim()) {
    return process.env.REBEL_USER_DATA.trim();
  }

  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'mindstone-rebel');
  }

  if (process.platform === 'win32') {
    const appDataBase = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appDataBase, 'mindstone-rebel');
  }

  const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(xdgConfig, 'mindstone-rebel');
}

function hashWorkspacePath(workspacePath: string): string {
  return crypto.createHash('sha256').update(workspacePath).digest('hex').slice(0, 16);
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function resolveWorkspacePath(
  userDataPath: string,
  explicitWorkspacePath?: string,
): Promise<WorkspaceResolution> {
  if (explicitWorkspacePath) {
    return { workspacePath: path.resolve(explicitWorkspacePath), source: 'cli' };
  }

  const appSettingsPath = path.join(userDataPath, 'app-settings.json');
  try {
    const raw = await fs.readFile(appSettingsPath, 'utf8');
    const parsed = JSON.parse(raw) as { coreDirectory?: unknown };
    if (typeof parsed.coreDirectory === 'string' && parsed.coreDirectory.trim()) {
      return {
        workspacePath: path.resolve(parsed.coreDirectory),
        source: 'app-settings',
      };
    }
  } catch {
    // ignore and continue
  }

  if (process.env.REBEL_WORKSPACE && process.env.REBEL_WORKSPACE.trim()) {
    return { workspacePath: path.resolve(process.env.REBEL_WORKSPACE.trim()), source: 'env' };
  }

  return { workspacePath: null, source: 'none' };
}

async function loadQueries(queriesPath?: string): Promise<{ queries: string[]; source: 'default' | 'file' }> {
  if (!queriesPath) {
    return { queries: DEFAULT_QUERIES, source: 'default' };
  }

  const resolvedPath = path.resolve(queriesPath);
  const raw = await fs.readFile(resolvedPath, 'utf8');
  const parsed = JSON.parse(raw) as unknown;

  let candidateQueries: unknown;
  if (Array.isArray(parsed)) {
    candidateQueries = parsed;
  } else if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { queries?: unknown }).queries)) {
    candidateQueries = (parsed as { queries: unknown[] }).queries;
  } else {
    throw new Error('--queries file must be a JSON string[] or { "queries": string[] }');
  }

  const queries = (candidateQueries as unknown[])
    .filter((q): q is string => typeof q === 'string')
    .map((q) => q.trim())
    .filter((q) => q.length > 0);

  if (queries.length === 0) {
    throw new Error('--queries file produced an empty query set');
  }

  return { queries, source: 'file' };
}

async function initEmbeddingPipeline(): Promise<EmbeddingPipeline> {
  const { pipeline, env } = await import('@huggingface/transformers');
  env.allowLocalModels = true;
  env.allowRemoteModels = true;

  console.log(`Loading embedding model: ${MODEL_NAME}`);
  const embedder = await pipeline('feature-extraction', MODEL_NAME, {
    dtype: 'fp32',
    device: 'cpu',
  });
  console.log('Embedding model loaded.');
  // The transformers pipeline overload is broader than this feature-extraction script needs.
  return embedder as EmbeddingPipeline;
}

async function embedQueries(embedder: EmbeddingPipeline, queries: string[]): Promise<number[][]> {
  const prefixed = queries.map((q) => (BGE_QUERY_PREFIX + q).slice(0, 8000));
  const result = await embedder(prefixed, { pooling: 'mean', normalize: true });
  const vectors = result.tolist() as number[][];
  result.dispose?.();
  return vectors;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'bigint') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function scoreFromDistance(distance: unknown): number | null {
  const d = toFiniteNumber(distance);
  if (d == null) return null;
  const score = 1 - d;
  return Number.isFinite(score) ? score : null;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const index = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  const weight = index - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function buildThresholdCounts(scores: number[], thresholds: number[]): Array<{ threshold: number; count: number; pct: number }> {
  const total = scores.length;
  if (total === 0) {
    return thresholds.map((threshold) => ({ threshold, count: 0, pct: 0 }));
  }

  return thresholds.map((threshold) => {
    let count = 0;
    for (const score of scores) {
      if (score >= threshold) count++;
    }
    return { threshold, count, pct: count / total };
  });
}

function buildHistogram(scores: number[], binSize: number): DistributionSummary['histogram'] {
  const binCount = Math.round(1 / binSize);
  const bins: HistogramBin[] = Array.from({ length: binCount }, (_, index) => {
    const start = index * binSize;
    const end = start + binSize;
    return {
      label: `${start.toFixed(2)}-${end.toFixed(2)}`,
      start,
      end,
      count: 0,
      pct: 0,
    };
  });

  let belowZero = 0;
  let aboveOne = 0;
  for (const score of scores) {
    if (score < 0) {
      belowZero++;
      continue;
    }
    if (score > 1) {
      aboveOne++;
      continue;
    }
    const index = Math.min(binCount - 1, Math.floor(score / binSize));
    bins[index].count++;
  }

  const totalInRange = bins.reduce((acc, bin) => acc + bin.count, 0);
  for (const bin of bins) {
    bin.pct = totalInRange > 0 ? bin.count / totalInRange : 0;
  }

  return { binSize, bins, belowZero, aboveOne };
}

function summarizeScores(scores: number[]): DistributionSummary | null {
  if (scores.length === 0) return null;
  const sorted = [...scores].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, value) => acc + value, 0);
  const percentiles: Record<string, number> = {};
  for (const p of DISTRIBUTION_PERCENTILES) {
    percentiles[`p${p}`] = percentile(sorted, p);
  }

  return {
    count: sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: sum / sorted.length,
    percentiles,
    histogram: buildHistogram(sorted, HISTOGRAM_BIN_SIZE),
    thresholdCounts: buildThresholdCounts(sorted, THRESHOLD_LEVELS),
  };
}

function buildQueryLengthBuckets(querySummaries: QueryScoreSummary[]): QueryLengthBucket[] {
  return QUERY_LENGTH_BUCKETS.map(({ label, minLen, maxLen }) => {
    const matching = querySummaries.filter(
      (qs) => qs.query.length >= minLen && qs.query.length <= maxLen
    );
    if (matching.length === 0) {
      return { label, minLen, maxLen, queryCount: 0, avgMaxScore: null, avgMeanScore: null, avgP90Score: null, maxScoreRange: null, queries: [] };
    }
    const maxScores = matching.map((m) => m.max).filter((v): v is number => v != null);
    const meanScores = matching.map((m) => m.mean).filter((v): v is number => v != null);
    const p90Scores = matching.map((m) => m.p90).filter((v): v is number => v != null);
    const avg = (arr: number[]) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
    return {
      label,
      minLen,
      maxLen,
      queryCount: matching.length,
      avgMaxScore: avg(maxScores),
      avgMeanScore: avg(meanScores),
      avgP90Score: avg(p90Scores),
      maxScoreRange: maxScores.length > 0
        ? [Math.min(...maxScores), Math.max(...maxScores)] as [number, number]
        : null,
      queries: matching.map((m) => ({ query: m.query, maxScore: m.max })),
    };
  });
}

function summarizeQueryScores(query: string, scores: number[]): QueryScoreSummary {
  if (scores.length === 0) {
    return {
      query,
      resultCount: 0,
      min: null,
      max: null,
      mean: null,
      p90: null,
    };
  }
  const sorted = [...scores].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, value) => acc + value, 0);
  return {
    query,
    resultCount: sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: sum / sorted.length,
    p90: percentile(sorted, 90),
  };
}

function getEdgeSegments(text: string, edgeChars: number): { start: string; end: string } {
  if (text.length === 0) return { start: '', end: '' };
  if (text.length <= edgeChars) {
    return { start: text, end: text };
  }
  return {
    start: text.slice(0, edgeChars),
    end: text.slice(-edgeChars),
  };
}

function compareChunkPair(a: FileChunkResult, b: FileChunkResult): ChunkPairComparison {
  const aEdge = getEdgeSegments(a.content, EDGE_COMPARE_CHARS);
  const bEdge = getEdgeSegments(b.content, EDGE_COMPARE_CHARS);

  const matches = {
    aStartInB: aEdge.start.length > 0 && b.content.includes(aEdge.start),
    aEndInB: aEdge.end.length > 0 && b.content.includes(aEdge.end),
    bStartInA: bEdge.start.length > 0 && a.content.includes(bEdge.start),
    bEndInA: bEdge.end.length > 0 && a.content.includes(bEdge.end),
  };

  const edgeOverlap = matches.aStartInB || matches.aEndInB || matches.bStartInA || matches.bEndInA;
  const adjacentChunkIndex = Math.abs(a.chunkIndex - b.chunkIndex) <= 1;
  const likelyOverlap = edgeOverlap || adjacentChunkIndex;

  return {
    edgeOverlap,
    adjacentChunkIndex,
    likelyOverlap,
    matches,
  };
}

function calculateConversationRecencyBoost(updatedAt: number, nowMs: number): number {
  const ageMs = Math.max(0, nowMs - updatedAt);
  const decayFactor = Math.pow(2, -ageMs / CONVERSATION_RECENCY_HALF_LIFE_MS);
  return 1 + CONVERSATION_RECENCY_BOOST * decayFactor;
}

async function openIndexHandle(
  lancedb: LanceDBModule,
  kind: OpenIndexHandle['kind'],
  lanceDir: string,
  tableName: string,
): Promise<{ handle: OpenIndexHandle | null; availability: IndexAvailability }> {
  if (!(await pathExists(lanceDir))) {
    return {
      handle: null,
      availability: {
        available: false,
        kind,
        lanceDir,
        tableName,
        reason: 'LanceDB directory not found',
      },
    };
  }

  let connection: LanceDBConnection | null = null;
  try {
    connection = await lancedb.connect(lanceDir, { readConsistencyInterval: 1 });
    const tableNames = await connection.tableNames();
    if (!tableNames.includes(tableName)) {
      await connection.close();
      return {
        handle: null,
        availability: {
          available: false,
          kind,
          lanceDir,
          tableName,
          reason: `Table "${tableName}" not found`,
        },
      };
    }

    const table = await connection.openTable(tableName);
    const rowCountRaw = await table.countRows();
    const rowCount = toFiniteNumber(rowCountRaw) ?? 0;
    return {
      handle: { kind, lanceDir, tableName, rowCount, connection, table },
      availability: {
        available: true,
        kind,
        lanceDir,
        tableName,
        rowCount,
      },
    };
  } catch (error) {
    if (connection) {
      try { await connection.close(); } catch { /* ignore */ }
    }
    return {
      handle: null,
      availability: {
        available: false,
        kind,
        lanceDir,
        tableName,
        reason: `Open failed: ${(error as Error).message}`,
      },
    };
  }
}

async function closeIndexHandle(handle: OpenIndexHandle | null): Promise<void> {
  if (!handle) return;
  try { handle.table.close(); } catch { /* ignore */ }
  try { await handle.connection.close(); } catch { /* ignore */ }
}

async function runVectorQueryAllRows(table: LanceDBTable, embedding: number[], rowCount: number): Promise<Array<Record<string, unknown>>> {
  if (rowCount <= 0) return [];
  const results = await table
    .vectorSearch(embedding)
    .distanceType('cosine')
    .limit(rowCount)
    .toArray();
  return results as Array<Record<string, unknown>>;
}

function updateFileThresholdSummary(
  summary: FileMultiChunkThresholdSummary,
  query: string,
  chunks: FileChunkResult[],
): void {
  const byPath = new Map<string, FileChunkResult[]>();
  for (const chunk of chunks) {
    if (chunk.score < summary.threshold) continue;
    const existing = byPath.get(chunk.relativePath) ?? [];
    existing.push(chunk);
    byPath.set(chunk.relativePath, existing);
  }

  const multiChunkGroups = Array.from(byPath.entries()).filter(([, group]) => group.length >= 2);
  if (multiChunkGroups.length === 0) return;

  summary.queriesWithMultiChunk++;
  summary.totalMultiChunkFiles += multiChunkGroups.length;

  for (const [relativePath, group] of multiChunkGroups) {
    summary.totalChunksInMultiChunkFiles += group.length;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i];
        const b = group[j];
        const comparison = compareChunkPair(a, b);

        summary.pairCount++;
        if (comparison.edgeOverlap) summary.edgeOverlapPairs++;
        if (comparison.adjacentChunkIndex) summary.adjacentChunkPairs++;
        if (comparison.likelyOverlap) {
          summary.likelyOverlapPairs++;
        } else {
          summary.distinctPairs++;
        }

        if (summary.samplePairs.length < MAX_PAIR_SAMPLES_PER_THRESHOLD) {
          summary.samplePairs.push({
            query,
            relativePath,
            chunkAIndex: a.chunkIndex,
            chunkBIndex: b.chunkIndex,
            chunkAScore: a.score,
            chunkBScore: b.score,
            edgeOverlap: comparison.edgeOverlap,
            adjacentChunkIndex: comparison.adjacentChunkIndex,
            likelyOverlap: comparison.likelyOverlap,
            matches: comparison.matches,
          });
        }
      }
    }
  }
}

async function analyzeFileIndex(
  availability: IndexAvailability,
  handle: OpenIndexHandle | null,
  queryEmbeddings: number[][],
  queries: string[],
): Promise<FileIndexAnalysis> {
  if (!handle || !availability.available) {
    return {
      availability,
      queryCount: queries.length,
      totalScoresAnalyzed: 0,
      distributionBasis: 'chunk-level-vector-search',
      scoreDistribution: null,
      querySummaries: [],
      queryLengthBuckets: buildQueryLengthBuckets([]),
      multiChunkAnalysis: {
        compareChars: EDGE_COMPARE_CHARS,
        thresholds: FILE_MULTI_CHUNK_THRESHOLDS.map((threshold) => ({
          threshold,
          queriesWithMultiChunk: 0,
          queriesWithMultiChunkPct: 0,
          totalMultiChunkFiles: 0,
          totalChunksInMultiChunkFiles: 0,
          pairCount: 0,
          edgeOverlapPairs: 0,
          adjacentChunkPairs: 0,
          likelyOverlapPairs: 0,
          distinctPairs: 0,
          distinctPairPct: null,
          samplePairs: [],
        })),
      },
    };
  }

  const allScores: number[] = [];
  const querySummaries: QueryScoreSummary[] = [];
  const thresholdSummaries: FileMultiChunkThresholdSummary[] = FILE_MULTI_CHUNK_THRESHOLDS.map((threshold) => ({
    threshold,
    queriesWithMultiChunk: 0,
    queriesWithMultiChunkPct: 0,
    totalMultiChunkFiles: 0,
    totalChunksInMultiChunkFiles: 0,
    pairCount: 0,
    edgeOverlapPairs: 0,
    adjacentChunkPairs: 0,
    likelyOverlapPairs: 0,
    distinctPairs: 0,
    distinctPairPct: null,
    samplePairs: [],
  }));

  for (let i = 0; i < queryEmbeddings.length; i++) {
    const embedding = queryEmbeddings[i];
    const query = queries[i];
    const rows = await runVectorQueryAllRows(handle.table, embedding, handle.rowCount);

    const queryScores: number[] = [];
    const fileChunks: FileChunkResult[] = [];

    for (const row of rows) {
      const record = row as {
        relativePath?: unknown;
        content?: unknown;
        chunkIndex?: unknown;
        _distance?: unknown;
      };

      const score = scoreFromDistance(record._distance);
      if (score == null) continue;
      queryScores.push(score);
      allScores.push(score);

      if (typeof record.relativePath === 'string' && typeof record.content === 'string') {
        fileChunks.push({
          relativePath: record.relativePath,
          content: record.content,
          chunkIndex: toFiniteNumber(record.chunkIndex) ?? -1,
          score,
        });
      }
    }

    querySummaries.push(summarizeQueryScores(query, queryScores));
    for (const thresholdSummary of thresholdSummaries) {
      updateFileThresholdSummary(thresholdSummary, query, fileChunks);
    }
  }

  for (const thresholdSummary of thresholdSummaries) {
    thresholdSummary.queriesWithMultiChunkPct = queries.length > 0
      ? thresholdSummary.queriesWithMultiChunk / queries.length
      : 0;
    thresholdSummary.distinctPairPct = thresholdSummary.pairCount > 0
      ? thresholdSummary.distinctPairs / thresholdSummary.pairCount
      : null;
  }

  return {
    availability,
    queryCount: queries.length,
    totalScoresAnalyzed: allScores.length,
    distributionBasis: 'chunk-level-vector-search',
    scoreDistribution: summarizeScores(allScores),
    querySummaries,
    queryLengthBuckets: buildQueryLengthBuckets(querySummaries),
    multiChunkAnalysis: {
      compareChars: EDGE_COMPARE_CHARS,
      thresholds: thresholdSummaries,
    },
  };
}

async function analyzeToolIndex(
  availability: IndexAvailability,
  handle: OpenIndexHandle | null,
  queryEmbeddings: number[][],
  queries: string[],
): Promise<ToolIndexAnalysis> {
  if (!handle || !availability.available) {
    return {
      availability,
      queryCount: queries.length,
      totalScoresAnalyzed: 0,
      scoreDistribution: null,
      querySummaries: [],
    };
  }

  const allScores: number[] = [];
  const querySummaries: QueryScoreSummary[] = [];

  for (let i = 0; i < queryEmbeddings.length; i++) {
    const embedding = queryEmbeddings[i];
    const query = queries[i];
    const rows = await runVectorQueryAllRows(handle.table, embedding, handle.rowCount);

    const queryScores: number[] = [];
    for (const row of rows) {
      const score = scoreFromDistance((row as { _distance?: unknown })._distance);
      if (score == null) continue;
      queryScores.push(score);
      allScores.push(score);
    }

    querySummaries.push(summarizeQueryScores(query, queryScores));
  }

  return {
    availability,
    queryCount: queries.length,
    totalScoresAnalyzed: allScores.length,
    scoreDistribution: summarizeScores(allScores),
    querySummaries,
  };
}

async function analyzeConversationIndex(
  availability: IndexAvailability,
  handle: OpenIndexHandle | null,
  queryEmbeddings: number[][],
  queries: string[],
): Promise<ConversationIndexAnalysis> {
  if (!handle || !availability.available) {
    return {
      availability,
      queryCount: queries.length,
      totalRawScoresAnalyzed: 0,
      totalBoostedScoresAnalyzed: 0,
      rawScoreDistribution: null,
      boostedScoreDistribution: null,
      boostMultiplierDistribution: null,
      querySummaries: [],
      recencyImpact: {
        top1ChangedQueries: 0,
        top1ChangedQueriesPct: 0,
        averageTopNOverlap: null,
      },
    };
  }

  const allRawScores: number[] = [];
  const allBoostedScores: number[] = [];
  const allBoostMultipliers: number[] = [];
  const querySummaries: ConversationIndexAnalysis['querySummaries'] = [];
  let top1ChangedQueries = 0;
  let topNOverlapSum = 0;
  let topNOverlapCount = 0;

  for (let i = 0; i < queryEmbeddings.length; i++) {
    const embedding = queryEmbeddings[i];
    const query = queries[i];
    const rows = await runVectorQueryAllRows(handle.table, embedding, handle.rowCount);
    const nowMs = Date.now();

    const bySession = new Map<string, { rawScore: number; boostedScore: number; boostMultiplier: number }>();

    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
      const row = rows[rowIndex] as {
        sessionId?: unknown;
        createdAt?: unknown;
        updatedAt?: unknown;
        _distance?: unknown;
      };

      const rawScore = scoreFromDistance(row._distance);
      if (rawScore == null) continue;

      const createdAt = toFiniteNumber(row.createdAt) ?? nowMs;
      const updatedAt = toFiniteNumber(row.updatedAt) ?? createdAt;
      const boostMultiplier = calculateConversationRecencyBoost(updatedAt, nowMs);
      const boostedScore = rawScore * boostMultiplier;

      const sessionId = typeof row.sessionId === 'string' && row.sessionId.trim().length > 0
        ? row.sessionId
        : `__missing_session_id_${rowIndex}`;

      const existing = bySession.get(sessionId);
      if (!existing || rawScore > existing.rawScore) {
        bySession.set(sessionId, { rawScore, boostedScore, boostMultiplier });
      }
    }

    const entries = Array.from(bySession.values());
    const rawScores = entries.map((entry) => entry.rawScore);
    const boostedScores = entries.map((entry) => entry.boostedScore);
    const boostMultipliers = entries.map((entry) => entry.boostMultiplier);

    allRawScores.push(...rawScores);
    allBoostedScores.push(...boostedScores);
    allBoostMultipliers.push(...boostMultipliers);

    const rankedByRaw = Array.from(bySession.entries())
      .sort((a, b) => b[1].rawScore - a[1].rawScore)
      .slice(0, TOP_N_RECENCY_COMPARISON)
      .map(([sessionId]) => sessionId);

    const rankedByBoosted = Array.from(bySession.entries())
      .sort((a, b) => b[1].boostedScore - a[1].boostedScore)
      .slice(0, TOP_N_RECENCY_COMPARISON)
      .map(([sessionId]) => sessionId);

    const rawTop = rankedByRaw[0] ?? null;
    const boostedTop = rankedByBoosted[0] ?? null;
    const topResultChanged = rawTop !== boostedTop;
    if (topResultChanged) top1ChangedQueries++;

    const boostedSet = new Set(rankedByBoosted);
    let overlap = 0;
    for (const sessionId of rankedByRaw) {
      if (boostedSet.has(sessionId)) overlap++;
    }
    const overlapPct = TOP_N_RECENCY_COMPARISON > 0 ? overlap / TOP_N_RECENCY_COMPARISON : 0;
    topNOverlapSum += overlapPct;
    topNOverlapCount++;

    querySummaries.push({
      query,
      resultCount: entries.length,
      topRawScore: rawScores.length > 0 ? Math.max(...rawScores) : null,
      topBoostedScore: boostedScores.length > 0 ? Math.max(...boostedScores) : null,
      topResultChanged,
      topNOverlap: overlapPct,
    });
  }

  return {
    availability,
    queryCount: queries.length,
    totalRawScoresAnalyzed: allRawScores.length,
    totalBoostedScoresAnalyzed: allBoostedScores.length,
    rawScoreDistribution: summarizeScores(allRawScores),
    boostedScoreDistribution: summarizeScores(allBoostedScores),
    boostMultiplierDistribution: summarizeScores(allBoostMultipliers),
    querySummaries,
    recencyImpact: {
      top1ChangedQueries,
      top1ChangedQueriesPct: queries.length > 0 ? top1ChangedQueries / queries.length : 0,
      averageTopNOverlap: topNOverlapCount > 0 ? topNOverlapSum / topNOverlapCount : null,
    },
  };
}

function formatNumber(value: number | null, digits = 4): string {
  if (value == null || !Number.isFinite(value)) return 'n/a';
  return value.toFixed(digits);
}

function formatPct(value: number | null, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return 'n/a';
  return `${(value * 100).toFixed(digits)}%`;
}

function printDistribution(title: string, distribution: DistributionSummary | null): void {
  console.log(`\n${title}`);
  if (!distribution) {
    console.log('  No scores available.');
    return;
  }

  console.log(
    `  count=${distribution.count} min=${formatNumber(distribution.min)} max=${formatNumber(distribution.max)} mean=${formatNumber(distribution.mean)}`
  );
  console.log(
    `  p10=${formatNumber(distribution.percentiles.p10)} p25=${formatNumber(distribution.percentiles.p25)} p50=${formatNumber(distribution.percentiles.p50)} p75=${formatNumber(distribution.percentiles.p75)} p90=${formatNumber(distribution.percentiles.p90)} p95=${formatNumber(distribution.percentiles.p95)}`
  );

  const maxBinCount = Math.max(...distribution.histogram.bins.map((bin) => bin.count), 1);
  console.log(`  Histogram (0.0-1.0, bin=${distribution.histogram.binSize.toFixed(2)}):`);
  for (const bin of distribution.histogram.bins) {
    const barLen = Math.round((bin.count / maxBinCount) * 24);
    const bar = '#'.repeat(barLen);
    console.log(`    ${bin.label.padEnd(11)} ${String(bin.count).padStart(8)} ${bar}`);
  }
  if (distribution.histogram.belowZero > 0 || distribution.histogram.aboveOne > 0) {
    console.log(`    out-of-range: below0=${distribution.histogram.belowZero}, above1=${distribution.histogram.aboveOne}`);
  }

  console.log('  Threshold counts:');
  for (const threshold of distribution.thresholdCounts) {
    console.log(`    >= ${threshold.threshold.toFixed(2)} : ${String(threshold.count).padStart(8)} (${formatPct(threshold.pct)})`);
  }
}

function printAvailability(label: string, availability: IndexAvailability): void {
  if (availability.available) {
    console.log(`${label}: available (rows=${availability.rowCount}, table=${availability.tableName})`);
  } else {
    console.log(`${label}: unavailable (${availability.reason})`);
  }
}

function printHumanReport(output: ThresholdAnalysisOutput): void {
  console.log('\n============================================================');
  console.log('Threshold Analysis Report (Stage 0)');
  console.log('============================================================');
  console.log(`Generated: ${output.generatedAt}`);
  console.log(`Model: ${output.model}`);
  console.log(`Queries: ${output.queryCount} (${output.querySource})`);
  console.log(`User data path: ${output.workspace.userDataPath}`);
  console.log(`Workspace path: ${output.workspace.workspacePath ?? 'unresolved'} (${output.workspace.workspacePathSource})`);
  console.log(`Workspace hash: ${output.workspace.workspaceHash ?? 'n/a'}`);

  console.log('\nIndex availability:');
  printAvailability('  File', output.indices.file.availability);
  printAvailability('  Conversation', output.indices.conversation.availability);
  printAvailability('  Tool', output.indices.tool.availability);

  console.log('\n--- FILE INDEX ---');
  printDistribution('File score distribution', output.indices.file.scoreDistribution);
  console.log('Query length vs score analysis:');
  for (const bucket of output.indices.file.queryLengthBuckets) {
    if (bucket.queryCount === 0) {
      console.log(`  ${bucket.label}: (no queries)`);
      continue;
    }
    const range = bucket.maxScoreRange
      ? `[${bucket.maxScoreRange[0].toFixed(4)}..${bucket.maxScoreRange[1].toFixed(4)}]`
      : 'n/a';
    console.log(
      `  ${bucket.label}: n=${bucket.queryCount}, avgMax=${bucket.avgMaxScore?.toFixed(4) ?? 'n/a'}, avgMean=${bucket.avgMeanScore?.toFixed(4) ?? 'n/a'}, avgP90=${bucket.avgP90Score?.toFixed(4) ?? 'n/a'}, maxRange=${range}`
    );
    for (const q of bucket.queries) {
      console.log(`    "${q.query}" → max=${q.maxScore?.toFixed(4) ?? 'n/a'}`);
    }
  }

  console.log('\nFile multi-chunk analysis:');
  for (const item of output.indices.file.multiChunkAnalysis.thresholds) {
    console.log(
      `  threshold >= ${item.threshold.toFixed(2)} | queries with 2+ chunks same file: ${item.queriesWithMultiChunk}/${output.queryCount} (${formatPct(item.queriesWithMultiChunkPct)}) | multi-chunk files=${item.totalMultiChunkFiles} | distinct pairs=${item.distinctPairs}/${item.pairCount} (${formatPct(item.distinctPairPct)})`
    );
  }

  console.log('\n--- CONVERSATION INDEX ---');
  printDistribution('Conversation raw score distribution (no recency boost)', output.indices.conversation.rawScoreDistribution);
  printDistribution('Conversation boosted score distribution (with recency boost)', output.indices.conversation.boostedScoreDistribution);
  printDistribution('Conversation recency multiplier distribution', output.indices.conversation.boostMultiplierDistribution);
  console.log(
    `Recency impact: top1 changed for ${output.indices.conversation.recencyImpact.top1ChangedQueries}/${output.queryCount} queries (${formatPct(output.indices.conversation.recencyImpact.top1ChangedQueriesPct)}), avg top-${TOP_N_RECENCY_COMPARISON} overlap=${formatPct(output.indices.conversation.recencyImpact.averageTopNOverlap)}`
  );

  console.log('\n--- TOOL INDEX ---');
  printDistribution('Tool score distribution', output.indices.tool.scoreDistribution);

  console.log('\n------------------------------------------------------------');
  console.log(`JSON output written to: ${OUTPUT_JSON_PATH}`);
  console.log('------------------------------------------------------------\n');
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    showHelp();
    return;
  }

  const userDataPath = path.resolve(opts.userDataPath ?? getDefaultUserDataPath());
  const workspaceResolution = await resolveWorkspacePath(userDataPath, opts.workspacePath);
  const workspacePath = workspaceResolution.workspacePath;
  const workspaceHash = workspacePath ? hashWorkspacePath(workspacePath) : null;

  const fileIndexDir = workspaceHash
    ? path.join(userDataPath, 'indices', workspaceHash, 'lancedb')
    : null;
  const conversationIndexDir = path.join(userDataPath, 'indices', 'global', 'conversations', 'lancedb');
  const toolIndexDir = path.join(userDataPath, 'indices', 'tools', 'lancedb');

  const { queries, source: querySource } = await loadQueries(opts.queriesPath);
  console.log(`Using ${queries.length} queries (${querySource}).`);

  const embedder = await initEmbeddingPipeline();
  const queryEmbeddings = await embedQueries(embedder, queries);

  const lancedb = await import('@lancedb/lancedb');

  const fileOpenResult = fileIndexDir
    ? await openIndexHandle(lancedb, 'file', fileIndexDir, TABLE_NAMES.file)
    : {
        handle: null,
        availability: {
          available: false,
          kind: 'file',
          lanceDir: '(workspace unresolved)',
          tableName: TABLE_NAMES.file,
          reason: 'Workspace path not resolved (provide --workspace-path to analyze file index)',
        } as IndexAvailability,
      };

  const conversationOpenResult = await openIndexHandle(
    lancedb,
    'conversation',
    conversationIndexDir,
    TABLE_NAMES.conversation,
  );

  const toolOpenResult = await openIndexHandle(
    lancedb,
    'tool',
    toolIndexDir,
    TABLE_NAMES.tool,
  );

  let fileAnalysis: FileIndexAnalysis;
  let conversationAnalysis: ConversationIndexAnalysis;
  let toolAnalysis: ToolIndexAnalysis;

  try {
    fileAnalysis = await analyzeFileIndex(
      fileOpenResult.availability,
      fileOpenResult.handle,
      queryEmbeddings,
      queries,
    );

    conversationAnalysis = await analyzeConversationIndex(
      conversationOpenResult.availability,
      conversationOpenResult.handle,
      queryEmbeddings,
      queries,
    );

    toolAnalysis = await analyzeToolIndex(
      toolOpenResult.availability,
      toolOpenResult.handle,
      queryEmbeddings,
      queries,
    );
  } finally {
    await closeIndexHandle(fileOpenResult.handle);
    await closeIndexHandle(conversationOpenResult.handle);
    await closeIndexHandle(toolOpenResult.handle);
    await (embedder as { dispose?: () => Promise<void> | void }).dispose?.();
  }

  const output: ThresholdAnalysisOutput = {
    generatedAt: new Date().toISOString(),
    model: MODEL_NAME,
    querySource,
    queryCount: queries.length,
    queries,
    workspace: {
      userDataPath,
      workspacePath,
      workspacePathSource: workspaceResolution.source,
      workspaceHash,
      fileIndexDir,
      conversationIndexDir,
      toolIndexDir,
    },
    indices: {
      file: fileAnalysis,
      conversation: conversationAnalysis,
      tool: toolAnalysis,
    },
  };

  await fs.mkdir(path.dirname(OUTPUT_JSON_PATH), { recursive: true });
  await fs.writeFile(OUTPUT_JSON_PATH, JSON.stringify(output, null, 2));

  printHumanReport(output);
}

main().catch((error) => {
  console.error('Threshold analysis failed:', error);
  process.exit(1);
});
