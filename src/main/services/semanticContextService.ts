/**
 * Semantic Context Service
 *
 * Provides relevant file context for agent turns by performing semantic search
 * on the indexed workspace files and formatting results for inclusion in the prompt.
 *
 * Keyword-triggered search: Runs when user explicitly requests via @files or @skills.
 * Direct vector search: Uses raw query embedding — no query expansion or HyDE.
 */

import type { AppSettings } from '@shared/types';
import { createHash } from 'node:crypto';
import { logger } from '@core/logger';
import { semanticSearch, getCurrentLibraryPath, hasIndex, type SemanticSearchResult } from './fileIndexService';

const MAX_CONTEXT_FILES = 5;
const _MAX_SNIPPET_LENGTH = 800;
const _MAX_SNIPPET_LENGTH_HIGH_CONFIDENCE = 3000;
const MAX_SNIPPET_LENGTH_MULTI_CHUNK = 5000;
const MAX_TOTAL_FILE_CONTEXT_CHARS = 15000;
const MAX_CHUNKS_PER_HIGH_CONFIDENCE_FILE = 3;
const FOCUSED_SNIPPET_MAX_LEN = 300;
const SNIPPET_FRAGMENT_LEN = 100;
const MAX_SNIPPET_FRAGMENTS = 3;

/** High-confidence file matches get full chunk content instead of truncated snippets */
const HIGH_CONFIDENCE_FILE_THRESHOLD = 0.65;

/** Low-confidence file matches (hints) just show filename + description, no content */
const HINT_FILE_THRESHOLD = 0.40;

/**
 * Relevance thresholds for semantic search.
 * Exported as single source of truth - use scenario-specific values.
 */
export const RELEVANCE_THRESHOLDS = {
  /** Default threshold for most queries - balanced recall/precision (lowered from 0.60 based on A/B eval) */
  default: 0.50,
  /** Threshold for explicit @files - cast widest net */
  explicitSearch: 0.30,
  /** Threshold for action queries - automatic context for actionable prompts */
  actionIntent: 0.35,
} as const;

const RELEVANCE_THRESHOLD = RELEVANCE_THRESHOLDS.default;

/** Maximum files to return for explicit @files */
const MAX_EXPLICIT_SEARCH_FILES = 15;

/** Maximum files to return for action-intent queries */
const MAX_ACTION_INTENT_FILES = 10;

/**
 * Action verbs that indicate the user wants to DO something (not just find info).
 * Matched at the start of the query.
 */
const ACTION_VERBS = /^(update|edit|modify|change|fix|add|create|remove|delete|refactor|implement|build|write|move|rename|replace|improve|optimize)/i;

/**
 * Detect if a query has action intent (user wants to DO something, not just find info).
 * Action queries benefit from more context (more files, lower threshold).
 */
export function detectActionIntent(query: string): boolean {
  const trimmed = query.trim();
  
  // Check if starts with action verb
  if (ACTION_VERBS.test(trimmed)) return true;
  
  // Check for imperative patterns like "can you update...", "please fix..."
  const imperativePattern = /^(can you|could you|please|help me|I need to|I want to)\s+(\w+)/i;
  const match = trimmed.match(imperativePattern);
  if (match && ACTION_VERBS.test(match[2])) return true;
  
  return false;
}

/**
 * Keywords that trigger comprehensive workspace search.
 * Must be matched with word boundaries to avoid false positives.
 * - @files: Search all workspace files
 * - @skills: Search only skill files (SKILL.md)
 */
const SEARCH_KEYWORDS = ['@files', '@skills'] as const;

export interface ParsedSearchKeywords {
  /** Whether an explicit search keyword was found */
  hasExplicitSearch: boolean;
  /** The prompt with keywords stripped (for sending to agent) */
  sanitizedPrompt: string;
  /** Which keyword was matched, if any */
  matchedKeyword?: string;
}

/**
 * Parse a prompt for explicit search keyword (@files).
 * Uses boundary-aware matching to avoid false positives.
 * 
 * Valid matches:
 * - Start of message: "@files find the config"
 * - Isolated token: "please @files for pricing"
 * - With punctuation: "@files, what about..."
 * 
 * @param prompt - The user's original prompt
 * @returns Parsing result with hasExplicitSearch flag and sanitized prompt
 */
export function parseSearchKeywords(prompt: string): ParsedSearchKeywords {
  const trimmedPrompt = prompt.trim();
  
  for (const keyword of SEARCH_KEYWORDS) {
    // Build regex that matches keyword at word boundary
    // - Start of string OR preceded by whitespace
    // - The keyword itself (case-insensitive)
    // - End of string OR followed by whitespace/punctuation (not alphanumeric or underscore)
    const pattern = new RegExp(
      `(^|\\s)(${keyword.replace('@', '@')})(?=$|[\\s,.:;!?\\n\\r])`,
      'i'
    );
    
    const match = trimmedPrompt.match(pattern);
    if (match) {
      // Remove the keyword from prompt, preserving surrounding structure
      const sanitizedPrompt = trimmedPrompt
        .replace(pattern, '$1') // Keep the leading whitespace if any
        .trim()
        .replace(/^[,.:;!?\s]+/, '') // Strip leading punctuation left after keyword removal
        .replace(/\s+/g, ' '); // Normalize multiple spaces
      
      logger.debug(
        { keyword, originalLength: prompt.length, sanitizedLength: sanitizedPrompt.length },
        'Explicit search keyword detected'
      );
      
      return {
        hasExplicitSearch: true,
        sanitizedPrompt,
        matchedKeyword: keyword,
      };
    }
  }
  
  return {
    hasExplicitSearch: false,
    sanitizedPrompt: trimmedPrompt,
  };
}

export interface SemanticContext {
  files: SemanticSearchResult[];
  formattedContext: string;
  totalFiles: number;
}

/**
 * Get relevant files for a given query using semantic search
 * @param query - The user's original query
 * @param options.limit - Maximum number of files to return
 * @param options.threshold - Minimum similarity threshold
 */
export async function getSemanticContext(
  query: string,
  options: { limit?: number; threshold?: number; displayQuery?: string } = {}
): Promise<SemanticContext> {
  const { limit = MAX_CONTEXT_FILES, threshold = RELEVANCE_THRESHOLD } = options;

  if (!hasIndex()) {
    logger.debug('Semantic search skipped: no index available');
    return { files: [], formattedContext: '', totalFiles: 0 };
  }

  const workspacePath = getCurrentLibraryPath();
  if (!workspacePath) {
    logger.debug('Semantic search skipped: no workspace path');
    return { files: [], formattedContext: '', totalFiles: 0 };
  }

  const searchStartTime = Date.now();
  const queryHash = createHash('md5').update(query).digest('hex').slice(0, 8);

  try {
    // Single search at the hint threshold, then partition into main vs hints in memory.
    // This avoids two LanceDB queries.
    const effectiveSearchThreshold = threshold > HINT_FILE_THRESHOLD ? HINT_FILE_THRESHOLD : threshold;
    const allResults = await semanticSearch(query, { limit: limit + 5, threshold: effectiveSearchThreshold });
    const mergedResults = selectAndMergeMultiChunkResults(allResults);

    const results = mergedResults.filter(r => r.score >= threshold).slice(0, limit);
    const cappedResults = applyTotalFileContextCharCap(results);
    const hints = threshold > HINT_FILE_THRESHOLD
      ? mergedResults.filter(r => r.score < threshold && r.score >= HINT_FILE_THRESHOLD).slice(0, 5)
      : [];

    const durationMs = Date.now() - searchStartTime;
    const topScores = cappedResults.slice(0, 5).map(r => r.score);
    const totalContextChars = cappedResults.reduce((sum, r) => sum + (r.snippet?.length ?? 0), 0);

    if (cappedResults.length === 0 && hints.length === 0) {
      logger.info(
        { queryHash, queryLength: query.length, threshold, resultCount: 0, hintCount: 0, durationMs },
        'Semantic search (fallback path): no relevant files found'
      );
      logger.debug({ query: query.slice(0, 100) }, 'No relevant files found for query');
      return { files: [], formattedContext: '', totalFiles: 0 };
    }

    const formattedContext = formatContextForPrompt(cappedResults, hints, options.displayQuery ?? query);

    logger.info(
      {
        queryHash,
        queryLength: query.length,
        threshold,
        resultCount: cappedResults.length,
        hintCount: hints.length,
        topScores,
        totalContextChars,
        durationMs,
      },
      'Semantic search (fallback path): results found'
    );
    logger.debug(
      { query: query.slice(0, 100), fileCount: cappedResults.length, hintCount: hints.length },
      'Semantic context query details'
    );

    return {
      files: cappedResults,
      formattedContext,
      totalFiles: cappedResults.length,
    };
  } catch (error) {
    logger.warn({ err: error, queryHash, durationMs: Date.now() - searchStartTime }, 'Failed to get semantic context');
    return { files: [], formattedContext: '', totalFiles: 0 };
  }
}

type MultiChunkCandidate = Pick<SemanticSearchResult, 'path' | 'relativePath' | 'snippet' | 'score' | 'extension' | 'chunkIndex'>;

export function hasSignificantOverlap(
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

export function selectNonOverlappingChunks(
  chunks: MultiChunkCandidate[],
  maxChunks: number,
): MultiChunkCandidate[] {
  if (chunks.length <= 1 || maxChunks <= 1) {
    return chunks.slice(0, 1);
  }

  const sorted = [...chunks].sort((a, b) => b.score - a.score);
  const kept: MultiChunkCandidate[] = [];

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

export function mergeChunksForFile(
  chunks: MultiChunkCandidate[],
  maxSnippetLength = MAX_SNIPPET_LENGTH_MULTI_CHUNK,
): SemanticSearchResult {
  const sortedByScore = [...chunks].sort((a, b) => b.score - a.score);
  const best = sortedByScore[0];
  if (!best) {
    throw new Error('mergeChunksForFile requires at least one chunk');
  }

  if (sortedByScore.length === 1) {
    return best;
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
    ...best,
    snippet: mergedSnippet.length > maxSnippetLength ? mergedSnippet.slice(0, maxSnippetLength) : mergedSnippet,
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

// NOTE: Multi-chunk behavior is effectively worker-only in practice.
// fileIndexService.semanticSearch() deduplicates to one chunk per file before returning,
// so this function won't see multiple chunks per path via the main-process fallback.
// Kept here for parity and future-proofing if fileIndexService adds multi-chunk support.
function selectAndMergeMultiChunkResults(results: SemanticSearchResult[]): SemanticSearchResult[] {
  if (results.length <= 1) return results;

  const chunksByPath = new Map<string, MultiChunkCandidate[]>();
  const maxScoreByPath = new Map<string, number>();

  for (const result of results) {
    const existing = chunksByPath.get(result.relativePath) ?? [];
    existing.push(result);
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
      merged.push(best);
    }
  }

  merged.sort((a, b) => b.score - a.score);
  return merged;
}

/**
 * Format semantic search results for inclusion in the agent prompt.
 * Uses tiered injection based on confidence:
 * - High confidence (>= 0.65): full chunk content (up to 3000 chars)
 * - Medium confidence: truncated snippet (800 chars)
 * - Hints (below main threshold but >= 0.40): filename only, no content
 *
 * Includes numbered source references to encourage citation in responses.
 */
function formatContextForPrompt(results: SemanticSearchResult[], hints?: SemanticSearchResult[], userQuery?: string): string {
  if (results.length === 0 && (!hints || hints.length === 0)) {
    return '';
  }

  const queryTerms = userQuery ? extractQueryTerms(userQuery) : [];

  const sections = results.map((result, index) => {
    const snippets = extractMultipleSnippets(result.snippet, queryTerms);

    // Relevance reason from path + term overlap (use full snippet for better term coverage)
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

/**
 * Format skill search results for inclusion in the agent prompt.
 * Extracts skill name from path and shows description-focused snippets.
 */
function formatSkillsForPrompt(results: SemanticSearchResult[]): string {
  if (results.length === 0) {
    return '## Skills Search\n\nNo matching skills found. Try `@files` for broader search, or describe the task you want to accomplish.';
  }

  const sections = results.map((result, index) => {
    const pathParts = result.relativePath.split('/');
    const skillMdIndex = pathParts.findIndex(p => p.toLowerCase() === 'skill.md');
    const skillName = skillMdIndex > 0 ? pathParts[skillMdIndex - 1] : pathParts[pathParts.length - 2];
    const snippet = result.snippet.length > 500
      ? result.snippet.slice(0, 500) + '...'
      : result.snippet;

    return `### [${index + 1}] ${skillName} (${(result.score * 100).toFixed(0)}% match)
**Path**: \`${result.relativePath}\`
\`\`\`markdown
${snippet}
\`\`\``;
  });

  return `## Skills Matching Your Query

The following skills from your Library may help with this task.
To use a skill, mention it with \`@skill-name\`.

${sections.join('\n\n')}`;
}

/**
 * Filter semantic search results to only include skill files.
 */
function filterToSkillFiles(results: SemanticSearchResult[]): SemanticSearchResult[] {
  return results.filter(result =>
    result.relativePath.includes('/skills/') &&
    result.relativePath.toLowerCase().endsWith('skill.md')
  );
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'it', 'as', 'be', 'was', 'are',
  'this', 'that', 'can', 'will', 'do', 'has', 'had', 'have', 'my', 'me',
  'our', 'we', 'you', 'your', 'its', 'their', 'them', 'they', 'he', 'she',
  'about', 'what', 'how', 'when', 'where', 'who', 'which', 'some', 'all',
  'any', 'each', 'not', 'would', 'could', 'should',
]);

/**
 * Extract meaningful search terms from a query, stripping stopwords.
 * Exported for testing.
 */
export function extractQueryTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[\s,;:!?.()[\]{}"'`]+/)
    .filter(t => t.length > 2 && !STOPWORDS.has(t));
}

/**
 * Extract a focused snippet from a chunk by finding the densest cluster of query terms.
 * Returns the snippet text and its character offset within the chunk.
 * Falls back to the chunk start when no query terms overlap (pure vector match).
 * Exported for testing.
 */
export function extractFocusedSnippet(
  chunk: string,
  queryTerms: string[],
  maxLen = FOCUSED_SNIPPET_MAX_LEN,
): { text: string; charOffset: number } {
  if (chunk.length <= maxLen) {
    return { text: chunk, charOffset: 0 };
  }

  const lowerChunk = chunk.toLowerCase();

  // Find all positions where query terms appear in the chunk
  const positions: number[] = [];
  for (const term of queryTerms) {
    let idx = lowerChunk.indexOf(term);
    while (idx !== -1) {
      positions.push(idx);
      idx = lowerChunk.indexOf(term, idx + 1);
    }
  }

  // No term overlap — pure vector match, use chunk start
  if (positions.length === 0) {
    const endPos = findBreakPoint(chunk, maxLen);
    return { text: chunk.slice(0, endPos), charOffset: 0 };
  }

  // Find window with most term hits
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

  // Center the window around the best cluster, snap to word boundaries
  const rawStart = Math.max(0, bestStart - 40);
  const rawEnd = Math.min(chunk.length, rawStart + maxLen);

  // Snap start forward to a word boundary (after whitespace)
  let start = rawStart;
  if (start > 0) {
    const nextSpace = chunk.indexOf(' ', start);
    if (nextSpace !== -1 && nextSpace < start + 20) start = nextSpace + 1;
  }

  // Snap end to a sentence/word boundary
  const end = findBreakPoint(chunk, rawEnd, start);

  return { text: chunk.slice(start, end), charOffset: start };
}

/**
 * Extract multiple non-overlapping snippet fragments from content (single or multi-chunk).
 * Returns up to MAX_SNIPPET_FRAGMENTS fragments, each ~SNIPPET_FRAGMENT_LEN chars,
 * from the densest query-term clusters. For short content, returns a single fragment.
 * Exported for testing.
 */
export function extractMultipleSnippets(
  fullSnippet: string,
  queryTerms: string[],
  maxFragments = MAX_SNIPPET_FRAGMENTS,
  fragmentLen = SNIPPET_FRAGMENT_LEN,
): string[] {
  // For short content, return as-is
  if (fullSnippet.length <= fragmentLen * 2) {
    return [fullSnippet];
  }

  // Collect all chunks (split merged multi-chunk content)
  const chunks = fullSnippet.includes('\n\n[...]\n\n')
    ? fullSnippet.split('\n\n[...]\n\n')
    : [fullSnippet];

  // Find all term positions across all chunks, tracking global offset
  const lowerContent = fullSnippet.toLowerCase();
  const positions: number[] = [];
  for (const term of queryTerms) {
    let idx = lowerContent.indexOf(term);
    while (idx !== -1) {
      positions.push(idx);
      idx = lowerContent.indexOf(term, idx + 1);
    }
  }

  // No term overlap — return fragments from chunk starts
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

  // Greedily select non-overlapping windows around the densest term clusters
  const fragments: { text: string; start: number }[] = [];
  const used = new Set<number>(); // track consumed position ranges

  for (let attempt = 0; attempt < maxFragments * 3 && fragments.length < maxFragments; attempt++) {
    // Find best unused window
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

    // Extract and snap to boundaries
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
      // Mark positions in this window as used
      for (const p of positions) {
        if (p >= start && p < end) used.add(p);
      }
    }
  }

  // Sort fragments by position in document for natural reading order
  fragments.sort((a, b) => a.start - b.start);

  return fragments.length > 0
    ? fragments.map(f => f.text)
    : [fullSnippet.slice(0, fragmentLen)];
}

/** Find a clean break point (sentence end, then word boundary) near targetPos. */
function findBreakPoint(text: string, targetPos: number, searchFrom = 0): number {
  if (targetPos >= text.length) return text.length;

  // Look for sentence end (. ? !) within last 60 chars of window
  const searchStart = Math.max(searchFrom, targetPos - 60);
  const window = text.slice(searchStart, targetPos);
  const sentenceEnd = Math.max(
    window.lastIndexOf('. '),
    window.lastIndexOf('? '),
    window.lastIndexOf('! '),
    window.lastIndexOf('.\n'),
  );
  if (sentenceEnd !== -1) return searchStart + sentenceEnd + 2;

  // Fall back to last space
  const lastSpace = text.lastIndexOf(' ', targetPos);
  if (lastSpace > searchFrom + 20) return lastSpace;

  return targetPos;
}

/**
 * Generate a brief relevance reason from path/filename overlap and snippet term matches.
 * Uses the original user query (not HyDE) for meaningful explanations.
 */
function generateRelevanceReason(
  relativePath: string,
  snippet: string,
  queryTerms: string[],
): string {
  if (queryTerms.length === 0) return '';

  const reasons: string[] = [];

  // Check path/filename overlap
  const lowerPath = relativePath.toLowerCase();
  const pathTerms = lowerPath.split(/[/\-_.]/).filter(t => t.length > 2);
  const pathMatches = queryTerms.filter(qt => pathTerms.some(pt => pt.includes(qt) || qt.includes(pt)));
  if (pathMatches.length > 0) {
    reasons.push(`path contains "${pathMatches.slice(0, 3).join('", "')}"`);
  }

  // Check snippet term overlap (beyond what path already matched)
  const lowerSnippet = snippet.toLowerCase();
  const snippetMatches = queryTerms
    .filter(qt => !pathMatches.includes(qt) && lowerSnippet.includes(qt))
    .slice(0, 4);
  if (snippetMatches.length > 0) {
    reasons.push(`content mentions "${snippetMatches.join('", "')}"`);
  }

  return reasons.length > 0 ? reasons.join('; ') : '';
}

// NOTE: formatContextForPrompt and associated helpers are duplicated in
// preTurnWorker.ts (utilityProcess path). Keep both in sync.
function _getLanguageFromExtension(extension: string): string {
  const extLower = extension.toLowerCase().replace(/^\./, '');

  const languageMap: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    py: 'python',
    rb: 'ruby',
    go: 'go',
    rs: 'rust',
    java: 'java',
    kt: 'kotlin',
    swift: 'swift',
    c: 'c',
    cpp: 'cpp',
    h: 'c',
    hpp: 'cpp',
    cs: 'csharp',
    php: 'php',
    sql: 'sql',
    sh: 'bash',
    bash: 'bash',
    zsh: 'bash',
    fish: 'fish',
    ps1: 'powershell',
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    toml: 'toml',
    xml: 'xml',
    html: 'html',
    htm: 'html',
    css: 'css',
    scss: 'scss',
    less: 'less',
    md: 'markdown',
    mdx: 'markdown'
  };

  return languageMap[extLower] || '';
}

/**
 * Enhance a prompt with semantic context from the workspace
 * @param prompt - The user's original prompt
 * @param options.limit - Maximum number of files to include
 * @param options.threshold - Minimum similarity threshold
 * @param options.enabled - Whether to enable semantic context (default: true)
 * @param options.settings - App settings (kept for caller compatibility)
 * @param options.backgroundModel - Background model (kept for caller compatibility)
 */
export async function enhancePromptWithSemanticContext(
  prompt: string,
  options: { limit?: number; threshold?: number; enabled?: boolean; settings?: AppSettings; backgroundModel?: string } = {}
): Promise<{ 
  enhancedPrompt: string; 
  contextAdded: boolean; 
  fileCount: number;
  formattedContext?: string;
  files: Array<{ relativePath: string; score: number }>;
}> {
  const { enabled = true } = options;

  if (!enabled) {
    return { enhancedPrompt: prompt, contextAdded: false, fileCount: 0, files: [] };
  }

  // Check for explicit search keyword (@files)
  const { hasExplicitSearch, sanitizedPrompt, matchedKeyword } = parseSearchKeywords(prompt);
  
  // Check for action intent (user wants to DO something)
  const queryForIntentCheck = hasExplicitSearch ? sanitizedPrompt : prompt;
  const hasActionIntent = detectActionIntent(queryForIntentCheck);
  
  // Adjust options based on explicit search or action intent
  let effectiveLimit = options.limit ?? MAX_CONTEXT_FILES;
  let effectiveThreshold = options.threshold ?? RELEVANCE_THRESHOLD;
  
  if (hasExplicitSearch) {
    // User explicitly requested search - expand limits, lower threshold
    effectiveLimit = MAX_EXPLICIT_SEARCH_FILES;
    effectiveThreshold = RELEVANCE_THRESHOLDS.explicitSearch;
    
    logger.debug(
      { matchedKeyword, limit: effectiveLimit, threshold: effectiveThreshold },
      'Using explicit search settings'
    );
  } else if (hasActionIntent) {
    // Action queries need more context to complete tasks
    effectiveLimit = MAX_ACTION_INTENT_FILES;
    effectiveThreshold = RELEVANCE_THRESHOLDS.actionIntent;
    
    logger.debug(
      { query: queryForIntentCheck.slice(0, 50), limit: effectiveLimit, threshold: effectiveThreshold },
      'Using action intent search settings'
    );
  }

  // Use raw query directly for search (HyDE was removed — empirically degrades quality)
  const searchQuery = hasExplicitSearch ? sanitizedPrompt : prompt;

  let context = await getSemanticContext(
    searchQuery,
    { 
      limit: effectiveLimit, 
      threshold: effectiveThreshold,
      displayQuery: searchQuery,
    }
  );

  // For @skills keyword, filter and reformat results
  if (matchedKeyword === '@skills') {
    const skillResults = filterToSkillFiles(context.files);
    context = {
      files: skillResults,
      formattedContext: formatSkillsForPrompt(skillResults),
      totalFiles: skillResults.length,
    };
    
    logger.debug(
      { originalCount: context.files.length, skillCount: skillResults.length },
      'Filtered to skill files for @skills search'
    );
  }

  if (!context.formattedContext) {
    return { 
      enhancedPrompt: hasExplicitSearch ? sanitizedPrompt : prompt, 
      contextAdded: false, 
      fileCount: 0,
      files: [],
    };
  }

  const promptForAgent = hasExplicitSearch ? sanitizedPrompt : prompt;

  return {
    enhancedPrompt: promptForAgent,
    contextAdded: true,
    fileCount: context.totalFiles,
    formattedContext: context.formattedContext,
    files: context.files.map(f => ({ relativePath: f.relativePath, score: f.score })),
  };
}
