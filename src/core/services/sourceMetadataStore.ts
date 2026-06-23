/**
 * Source Metadata Store
 *
 * Indexes metadata from source files (meetings, emails, slack threads) in memory/sources/.
 * Enables structured queries like "all meetings with Liam last month" without scanning files.
 *
 * Storage: electron-store (JSON) with in-memory filtering (~100-500 entries projected)
 * Indexing: Hooks into fileIndexService.indexFile() to piggyback on file watcher
 */

import { createStore } from '@core/storeFactory';
import type { KeyValueStore } from '@core/store';
import { mapWithConcurrencyLimit } from '@core/utils/concurrencyLimit';
import path from 'node:path';
import fm from 'front-matter';
import { createScopedLogger } from '@core/logger';
import { isUnderCloudSpace } from '@core/services/cloudSpaceContainment';
import { workspaceFs } from '@core/services/boundedWorkspaceFs';

const log = createScopedLogger({ service: 'sourceMetadata' });

const SOURCE_METADATA_STORE_VERSION = 1;

export interface SourceMetadataEntry {
  // File identity
  filePath: string;
  relativePath: string;
  title: string;
  mtime: number;

  // Source classification (from frontmatter, normalized to camelCase)
  sourceType: string;
  sourceSystem: string;
  sourceAccount: string;
  sourceUid: string;
  sourceUrl: string;

  // Temporal
  occurredAt: string;
  storedAt: string;

  // Participants
  participants: string[];
  durationMinutes?: number;
  truncated: boolean;
  description: string;

  // Extracted sections
  summary: string;
  keyTakeaways: string[];

  // Index metadata
  indexedAt: number;
  spacePath: string;
}

type SourceMetadataStoreShape = {
  version: number;
  workspacePath: string | null;
  entries: Record<string, SourceMetadataEntry>;
};

const createDefaultState = (): SourceMetadataStoreShape => ({
  version: SOURCE_METADATA_STORE_VERSION,
  workspacePath: null,
  entries: {},
});

let _store: KeyValueStore<SourceMetadataStoreShape> | null = null;
const getStore = () => _store ??= createStore<SourceMetadataStoreShape>({
  name: 'source-metadata',
  defaults: createDefaultState(),
});

/**
 * Initialize store for a workspace. Clears entries if workspace changed or version mismatch.
 */
export function initForWorkspace(workspacePath: string): void {
  const storedVersion = getStore().get('version');
  const storedWorkspace = getStore().get('workspacePath');

  // Clear on version mismatch (schema migration)
  if (storedVersion !== SOURCE_METADATA_STORE_VERSION) {
    log.info({ storedVersion, currentVersion: SOURCE_METADATA_STORE_VERSION }, 'Version mismatch, clearing store');
    getStore().set('version', SOURCE_METADATA_STORE_VERSION);
    getStore().set('entries', {});
  }

  // Clear on workspace switch
  if (storedWorkspace !== workspacePath) {
    log.info({ oldWorkspace: storedWorkspace, newWorkspace: workspacePath }, 'Workspace changed, clearing store');
    getStore().set('workspacePath', workspacePath);
    getStore().set('entries', {});
  }
}

/**
 * Check if store is empty (needs population via filesystem scan).
 */
export function isEmpty(): boolean {
  const entries = getStore().get('entries');
  return !entries || Object.keys(entries).length === 0;
}

/**
 * Check if a path is a source file that should be indexed.
 * Cross-platform: splits on both / and \ for segment matching.
 */
export function isSourcePath(filePath: string, workspacePath: string): boolean {
  const relativePath = path.relative(workspacePath, filePath);
  const segments = relativePath.split(/[/\\]/);
  return segments.includes('memory') && segments.includes('sources') && filePath.endsWith('.md');
}

/**
 * Normalize a date field to YYYY-MM-DD format.
 * YAML parsers convert date-like strings to Date objects, so we need to handle both.
 */
function normalizeDateField(value: unknown): string {
  if (!value) return '';
  if (value instanceof Date) {
    return value.toISOString().split('T')[0];
  }
  // Already a string - ensure it's in expected format
  const str = String(value);
  // If it looks like a long date string (from String(Date)), try to parse and reformat
  if (str.includes('GMT') || str.includes('UTC')) {
    const parsed = new Date(str);
    if (!isNaN(parsed.getTime())) {
      return parsed.toISOString().split('T')[0];
    }
  }
  return str;
}

/**
 * Normalize snake_case frontmatter to camelCase TypeScript fields.
 */
function normalizeSourceFrontmatter(attrs: Record<string, unknown>): Partial<SourceMetadataEntry> {
  return {
    sourceType: String(attrs.source_type ?? attrs.sourceType ?? ''),
    sourceSystem: String(attrs.source_system ?? attrs.sourceSystem ?? ''),
    sourceAccount: String(attrs.source_account ?? attrs.sourceAccount ?? ''),
    sourceUid: String(attrs.source_uid ?? attrs.sourceUid ?? ''),
    sourceUrl: String(attrs.source_url ?? attrs.sourceUrl ?? ''),
    occurredAt: normalizeDateField(attrs.occurred_at ?? attrs.occurredAt),
    storedAt: normalizeDateField(attrs.stored_at ?? attrs.storedAt),
    participants: Array.isArray(attrs.participants) ? attrs.participants.map(String) : [],
    durationMinutes: typeof attrs.duration_minutes === 'number' ? attrs.duration_minutes : undefined,
    truncated: attrs.truncated === true,
    description: String(attrs.description ?? ''),
    title: String(attrs.title ?? ''),
  };
}

/**
 * Extract ## Summary section from markdown body.
 * CRLF-tolerant for cross-platform compatibility.
 */
function extractSummary(body: string): string {
  const match = body.match(/## Summary\s*\r?\n([\s\S]*?)(?=\r?\n## |$)/);
  return match ? match[1].trim() : '';
}

/**
 * Extract ## Key Takeaways section from markdown body.
 * Returns array of bullet points.
 */
function extractKeyTakeaways(body: string): string[] {
  const match = body.match(/## Key Takeaways\s*\r?\n([\s\S]*?)(?=\r?\n## |$)/);
  if (!match) return [];

  const section = match[1];
  const bullets = section.match(/^[-*]\s+(.+)$/gm);
  if (!bullets) return [];

  return bullets.map((b) => b.replace(/^[-*]\s+/, '').trim());
}

/**
 * Determine space path from file path.
 * e.g., /workspace/memory/sources/meetings/file.md -> memory
 */
function extractSpacePath(relativePath: string): string {
  const segments = relativePath.split(/[/\\]/);
  const memoryIndex = segments.indexOf('memory');
  if (memoryIndex >= 0) {
    return 'memory';
  }
  return '';
}

/**
 * Index a source file. Called from fileIndexService.indexFile() hook.
 *
 * @param filePath - Absolute path to the file
 * @param relativePath - Path relative to workspace
 * @param content - File content (passed to avoid double I/O)
 * @param mtime - File modification time
 */
export function indexSource(
  filePath: string,
  relativePath: string,
  content: string,
  mtime: number
): void {
  try {
    // Validate frontmatter exists before parsing
    if (!fm.test(content)) {
      log.debug({ filePath }, 'No frontmatter found, skipping source indexing');
      return;
    }

    const parsed = fm<Record<string, unknown>>(content);
    const attrs = parsed.attributes;
    const body = parsed.body;

    // Normalize frontmatter fields
    const normalized = normalizeSourceFrontmatter(attrs);

    // Extract markdown sections
    const summary = extractSummary(body);
    const keyTakeaways = extractKeyTakeaways(body);

    const entry: SourceMetadataEntry = {
      filePath,
      relativePath,
      title: normalized.title || path.basename(filePath, '.md'),
      mtime,
      sourceType: normalized.sourceType || '',
      sourceSystem: normalized.sourceSystem || '',
      sourceAccount: normalized.sourceAccount || '',
      sourceUid: normalized.sourceUid || '',
      sourceUrl: normalized.sourceUrl || '',
      occurredAt: normalized.occurredAt || '',
      storedAt: normalized.storedAt || '',
      participants: normalized.participants || [],
      durationMinutes: normalized.durationMinutes,
      truncated: normalized.truncated || false,
      description: normalized.description || '',
      summary,
      keyTakeaways,
      indexedAt: Date.now(),
      spacePath: extractSpacePath(relativePath),
    };

    // Upsert into store
    const entries = getStore().get('entries') || {};
    entries[filePath] = entry;
    getStore().set('entries', entries);

    log.debug({ filePath, sourceType: entry.sourceType, participants: entry.participants.length }, 'Indexed source');
  } catch (error) {
    log.warn({ err: error, filePath }, 'Failed to index source');
  }
}

/**
 * Remove a source file from the index.
 */
export function removeSource(filePath: string): void {
  try {
    const entries = getStore().get('entries') || {};
    const keysToRemove = getMatchingSourceEntryKeys(entries, filePath);

    if (keysToRemove.length > 0) {
      for (const key of keysToRemove) {
        delete entries[key];
      }
      getStore().set('entries', entries);
      log.debug({ filePath, removedCount: keysToRemove.length }, 'Removed source from index');
    }
  } catch (error) {
    log.warn({ err: error, filePath }, 'Failed to remove source');
  }
}

/**
 * Get a single source entry by file path.
 */
export function getSource(filePath: string): SourceMetadataEntry | undefined {
  const entries = getStore().get('entries') || {};
  return entries[filePath];
}

/**
 * Get all source entries.
 */
export function getAllSources(): SourceMetadataEntry[] {
  const entries = getStore().get('entries') || {};
  return Object.values(entries);
}

/**
 * Check if a source needs reindexing based on mtime.
 */
export function needsReindexing(filePath: string, mtime: number): boolean {
  const existing = getSource(filePath);
  if (!existing) return true;
  return existing.mtime < mtime;
}

/**
 * Clear all entries (used for testing or manual reset).
 */
export function clearStore(): void {
  getStore().set('entries', {});
  log.info('Cleared source metadata store');
}

// ============================================================================
// Search API (Stage 3)
// ============================================================================

export interface SearchSourcesParams {
  query?: string;
  sourceTypes?: string[];
  participants?: string[];
  dateRange?: {
    after?: string;
    before?: string;
  };
  limit?: number;
  includeContent?: boolean;
}

/**
 * Discriminated status for source search, mirroring `FileSearchStatus` in
 * `src/main/services/fileIndexService/search.ts`.
 *
 * This is defined CORE-LOCALLY (identical string values) rather than imported
 * from `src/main` because `src/core` must not import `src/main` (boundary gate /
 * build break). Main-process callers inject a tiny adapter that maps
 * `semanticSearchWithStatus`'s `FileSearchStatus` onto this union.
 *
 * `'ok'` means semantic search was not needed (no query, or metadata filters
 * left zero candidates) or it succeeded; the other values mean the semantic
 * backend was unavailable. The MCP bridge uses this to distinguish "genuinely
 * no sources" from "search backend unavailable" — but ONLY when semantic was
 * actually needed AND returned empty (the hybrid-honesty rule, see the bridge).
 */
export type SourceSearchStatus =
  | 'ok'
  | 'index_not_ready'
  | 'embedding_unavailable'
  | 'error';

export interface SearchSourcesResult {
  sources: Array<SourceMetadataEntry & { relevanceScore?: number }>;
  totalCount: number;
  status: SourceSearchStatus;
}

/**
 * Check if a participant string matches a query.
 * Supports:
 * - Substring match (case-insensitive): "chen" matches "Alice Chen"
 * - Email prefix match: "alice" matches "[external-email]", "[external-email]"
 */
function matchesParticipant(participant: string, query: string): boolean {
  const pLower = participant.toLowerCase();
  const qLower = query.toLowerCase();

  // Direct substring match (existing behavior)
  if (pLower.includes(qLower)) {
    return true;
  }

  // Email prefix match: query matches if email local part starts with query
  // e.g., "alice" matches "[external-email]" or "[external-email]"
  const emailMatch = pLower.match(/^([^@]+)@/);
  if (emailMatch) {
    const localPart = emailMatch[1];
    // Check if query matches the start of local part or first name portion
    if (localPart.startsWith(qLower) || localPart.split('.')[0] === qLower) {
      return true;
    }
  }

  return false;
}

function normalizeStoredPath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

function getMatchingSourceEntryKeys(
  entries: Record<string, SourceMetadataEntry>,
  filePath: string
): string[] {
  const normalizedPath = normalizeStoredPath(filePath);
  return Object.entries(entries)
    .filter(([key, entry]) =>
      key === filePath ||
      normalizeStoredPath(key) === normalizedPath ||
      normalizeStoredPath(entry.filePath) === normalizedPath ||
      normalizeStoredPath(entry.relativePath) === normalizedPath
    )
    .map(([key]) => key);
}

function isMissingFileAccessError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = 'code' in error ? (error as { code?: unknown }).code : undefined;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

async function sourceExists(entry: SourceMetadataEntry): Promise<boolean> {
  // Routed through the bounded workspace-fs boundary (S4.1c/d): a dead cloud mount can
  // never block this existence probe. The R2 containment split in `filterExistingSources`
  // means cloud entries never reach here — only CONTAINMENT-LOCAL paths do — so the
  // boundary takes the bare-fs local lane (byte-equivalent to the prior `fs.access`). The
  // cloud-lane branch is therefore belt-and-braces; if a `reconnecting` ever surfaced we
  // RETAIN the entry (true), never purge on an unknowable mount — matching the catch-all
  // for non-ENOENT errors below.
  const outcome = await workspaceFs.access(entry.filePath);
  if (outcome.status === 'ok') {
    return true;
  }
  if (outcome.status === 'reconnecting') {
    log.warn(
      { filePath: entry.filePath },
      'Source existence check hit a reconnecting cloud mount; retaining the entry',
    );
    return true;
  }
  // status === 'error'
  if (isMissingFileAccessError(outcome.error)) {
    return false;
  }
  log.warn(
    { err: outcome.error, filePath: entry.filePath },
    'Could not verify source file existence',
  );
  return true;
}

async function filterExistingSources<T extends SourceMetadataEntry>(entries: T[]): Promise<T[]> {
  // R2 (Stage 4b, 260619_cloud-symlink-indexing) — search NEVER fs-checks cloud
  // entries. An entry under a cloud space is RETAINED without an `fs.access`,
  // which (a) kills the search-time hang vector (a dead Drive mount would block
  // `fs.access` here on EVERY search — `filterExistingSources` is called from
  // `searchSources` per query) and (b) prevents an accidental purge-on-search when
  // the mount is transiently unavailable. The index is the source of truth for
  // searchability; genuine-absence reconcile happens OFF the search path (the
  // verdict-gated Removal Coordinator). Containment is a pure cached string match
  // (no I/O — `isUnderCloudSpace`); local entries keep the existing cheap check.
  const cloudEntries: T[] = [];
  const localEntries: T[] = [];
  for (const entry of entries) {
    if (isUnderCloudSpace(entry.filePath)) {
      cloudEntries.push(entry);
    } else {
      localEntries.push(entry);
    }
  }

  // Bound the existence-check fan-out: source metadata can hold one entry per
  // indexed file (large), and an unbounded Promise.all of fs.access opens that
  // many descriptors at once, pushing the process over the FD limit (EMFILE).
  const checked = await mapWithConcurrencyLimit(localEntries, 8, async (entry) => ({
    entry,
    exists: await sourceExists(entry),
  }));

  const missing = checked.filter((result) => !result.exists).map((result) => result.entry);
  if (missing.length > 0) {
    const storeEntries = getStore().get('entries') || {};
    for (const entry of missing) {
      for (const key of getMatchingSourceEntryKeys(storeEntries, entry.filePath)) {
        delete storeEntries[key];
      }
    }
    getStore().set('entries', storeEntries);
    log.info({ prunedCount: missing.length }, 'Pruned stale source metadata entries');
  }

  // Cloud entries are returned unconditionally (retained, never fs-checked); local
  // entries are returned only if they still exist on disk.
  const survivingLocal = checked
    .filter((result) => result.exists)
    .map((result) => result.entry);
  return [...survivingLocal, ...cloudEntries];
}

/**
 * Reconcile the persisted source metadata store against the filesystem.
 * Returns the number of stale entries pruned.
 */
export async function reconcileSourceMetadataWithFilesystem(): Promise<number> {
  const before = getAllSources().length;
  await filterExistingSources(getAllSources());
  return before - getAllSources().length;
}

/**
 * Search sources with optional semantic query and structured filters.
 * Uses in-memory filtering for metadata, LanceDB for semantic search.
 *
 * Hybrid honesty: the returned `status` reflects whether the semantic backend
 * was available WHEN IT WAS NEEDED. It is `'ok'` if no query was given, or if
 * metadata filters left zero candidates (semantic can't change a pre-filtered-
 * empty result, so that stays an honest "no sources"), or if semantic search
 * succeeded. Otherwise it carries the backend's failure status. The MCP bridge
 * only reports "unavailable" when `status !== 'ok' && sources.length === 0`, so
 * text/metadata results are still shown silently when semantic happens to be
 * down. No Sentry capture happens here — `semanticSearchWithStatus` (reached via
 * the injected adapter) already captures `file_index_semantic_search_failed`
 * once per workspace; capturing again would double-count.
 *
 * @param params - Search parameters
 * @param semanticSearchFn - Injected status-aware semantic search function (to
 *   avoid a circular dependency on the main-process file index service)
 */
export async function searchSources(
  params: SearchSourcesParams,
  semanticSearchFn?: (
    query: string,
    options: { limit?: number; threshold?: number; pathPrefix?: string }
  ) => Promise<{ status: SourceSearchStatus; results: Array<{ relativePath: string; score: number }> }>
): Promise<SearchSourcesResult> {
  const { limit = 20 } = params;
  let status: SourceSearchStatus = 'ok';

  // 1. Load all entries and apply in-memory filters
  let candidates = await filterExistingSources(getAllSources());
  const totalBeforeFilter = candidates.length;

  // Filter by source types
  if (params.sourceTypes && params.sourceTypes.length > 0) {
    const types = params.sourceTypes.map((t) => t.toLowerCase());
    candidates = candidates.filter((e) => types.includes(e.sourceType.toLowerCase()));
  }

  // Filter by participants (case-insensitive matching)
  // Supports: exact/substring match, and email prefix matching (e.g., "alice" matches "[external-email]")
  if (params.participants && params.participants.length > 0) {
    const participantQueries = params.participants;
    candidates = candidates.filter((e) =>
      e.participants.some((p) =>
        participantQueries.some((query) => matchesParticipant(p, query))
      )
    );
  }

  // Filter by date range
  const { dateRange } = params;
  const afterTs = dateRange?.after;
  if (afterTs != null) {
    candidates = candidates.filter((e) => e.occurredAt >= afterTs);
  }
  const beforeTs = dateRange?.before;
  if (beforeTs != null) {
    candidates = candidates.filter((e) => e.occurredAt <= beforeTs);
  }

  log.debug(
    { totalSources: totalBeforeFilter, afterFilter: candidates.length, params },
    'Applied metadata filters'
  );

  // 2. If query provided, combine text-based metadata matching with semantic search
  let results: Array<SourceMetadataEntry & { relevanceScore?: number }> = candidates;

  if (params.query) {
    const queryLower = params.query.toLowerCase();

    // 2a. Text-based matching on metadata fields (title, participants, summary)
    // This catches exact name/keyword matches that semantic search may miss
    const textMatches = new Map<string, SourceMetadataEntry>();
    for (const entry of candidates) {
      const titleMatch = entry.title.toLowerCase().includes(queryLower);
      const participantMatch = entry.participants.some(
        (p) => p.toLowerCase().includes(queryLower)
      );
      const summaryMatch = entry.summary.toLowerCase().includes(queryLower);
      const descriptionMatch = entry.description.toLowerCase().includes(queryLower);

      if (titleMatch || participantMatch || summaryMatch || descriptionMatch) {
        textMatches.set(entry.relativePath, entry);
      }
    }

    // 2b. Semantic search for conceptual matches
    // Note: pathPrefix is NOT used because source paths include space prefixes
    // (e.g. 'Chief-of-Staff/memory/sources/...' or 'work/Mindstone/General/memory/sources/...').
    // The intersection with metadata candidates already constrains results to sources.
    const sourceScores = new Map<string, number>();
    // Skip semantic entirely when metadata filters already left zero candidates:
    // semantic can only narrow within candidates, so a pre-filtered-empty result
    // is an honest "no sources" (status stays 'ok') rather than "unavailable".
    if (semanticSearchFn && candidates.length > 0) {
      const semantic = await semanticSearchFn(params.query, {
        limit: 200,
        threshold: 0.2,
      });
      status = semantic.status;

      // Build score map, keeping only entries that are in our candidates set
      const candidatePaths = new Set(candidates.map((c) => c.relativePath));
      for (const r of semantic.results) {
        if (candidatePaths.has(r.relativePath)) {
          sourceScores.set(r.relativePath, r.score);
        }
      }
    }

    // 2c. Merge: union of text matches and semantic matches
    const mergedMap = new Map<string, SourceMetadataEntry & { relevanceScore?: number }>();

    // Add text matches, floored at a baseline relevance of 0.5. An exact text
    // match should never rank below the baseline just because it also picked up
    // a weak semantic score — and F9's lexical exemption can now admit
    // low-cosine semantic hits (clamped toward 0) into `sourceScores`, which
    // would otherwise demote an exact text match below pure-semantic hits.
    for (const [rPath, entry] of textMatches) {
      mergedMap.set(rPath, {
        ...entry,
        relevanceScore: Math.max(sourceScores.get(rPath) ?? 0.5, 0.5),
      });
    }

    // Add semantic matches not already covered by text
    for (const entry of candidates) {
      if (sourceScores.has(entry.relativePath) && !mergedMap.has(entry.relativePath)) {
        mergedMap.set(entry.relativePath, {
          ...entry,
          relevanceScore: sourceScores.get(entry.relativePath),
        });
      }
    }

    results = Array.from(mergedMap.values())
      .sort((a, b) => (b.relevanceScore ?? 0) - (a.relevanceScore ?? 0));

    log.debug(
      { textMatches: textMatches.size, semanticHits: sourceScores.size, merged: results.length },
      'Applied hybrid search (text + semantic)',
    );
  } else {
    // No query - sort by date (most recent first)
    results = candidates.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
  }

  return {
    sources: results.slice(0, limit),
    totalCount: results.length,
    status,
  };
}
