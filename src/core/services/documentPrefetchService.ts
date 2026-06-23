import { createScopedLogger } from '@core/logger';
import { findConnectorsForUrl } from '@core/services/connectorCatalogService';
import type { ConnectorCatalog } from '@shared/types';
import type { ExtractedUrl } from '@core/services/urlDetectionService';

const log = createScopedLogger({ service: 'documentPrefetch' });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PrefetchDocumentFn {
  (params: {
    serverInstanceId: string;
    toolName: string;
    args: Record<string, string>;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<PrefetchToolResult>;
}

export interface PrefetchToolResult {
  content: string;
  charCount: number;
  isMaterialized: boolean;
  materializedPath?: string;
}

export interface PrefetchResult {
  url: string;
  label?: string;
  status: 'fetched' | 'materialized' | 'failed';
  content?: string;
  preview?: string;
  materializedPath?: string;
  charCount?: number;
  serverInstanceId?: string;
  error?: string;
}

export interface PrefetchOptions {
  perUrlTimeoutMs?: number;
  totalTimeoutMs?: number;
  maxUrls?: number;
  inlineCharLimit?: number;
  totalInlineCharLimit?: number;
  signal?: AbortSignal;
}

export interface ServerInstanceInfo {
  instanceId: string;
  catalogId: string;
  isDisabled: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_PER_URL_TIMEOUT_MS = 8_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_URLS = 5;
const DEFAULT_INLINE_CHAR_LIMIT = 15_000;
const DEFAULT_TOTAL_INLINE_CHAR_LIMIT = 60_000;
const PREVIEW_CHAR_LIMIT = 2048;

// ---------------------------------------------------------------------------
// Core prefetch function
// ---------------------------------------------------------------------------

export async function prefetchDocuments(
  urls: ExtractedUrl[],
  connectorCatalog: ConnectorCatalog,
  activeInstances: ServerInstanceInfo[],
  fetchDocument: PrefetchDocumentFn,
  options?: PrefetchOptions,
): Promise<PrefetchResult[]> {
  const perUrlTimeout = options?.perUrlTimeoutMs ?? DEFAULT_PER_URL_TIMEOUT_MS;
  const totalTimeout = options?.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;
  const maxUrls = options?.maxUrls ?? DEFAULT_MAX_URLS;
  const inlineCharLimit = options?.inlineCharLimit ?? DEFAULT_INLINE_CHAR_LIMIT;
  const totalInlineLimit = options?.totalInlineCharLimit ?? DEFAULT_TOTAL_INLINE_CHAR_LIMIT;

  if (urls.length === 0) return [];

  // Limit URLs processed
  const urlsToProcess = urls.slice(0, maxUrls);
  if (urls.length > maxUrls) {
    log.warn({ total: urls.length, maxUrls }, 'Limiting prefetch to maximum URL count');
  }

  // Match URLs against catalog patterns
  const matchedUrls = urlsToProcess.map(url => {
    const matches = findConnectorsForUrl(url.url, connectorCatalog);
    return { url, matches };
  }).filter(m => m.matches.length > 0);

  if (matchedUrls.length === 0) return [];

  log.debug({ matchedCount: matchedUrls.length, totalUrls: urlsToProcess.length }, 'Matched URLs to catalog patterns');

  // Resolve server instances for each match
  const fetchTasks = matchedUrls.map(({ url, matches }) => {
    // Safe: we filtered to only entries with matches.length > 0 above
    const match = matches[0] as (typeof matches)[0];
    const catalogId = match.catalogEntry.id;

    const instance = activeInstances.find(
      inst => inst.catalogId === catalogId && !inst.isDisabled
    );

    if (!instance) {
      log.warn({ catalogId, url: url.url }, 'No active server instance found for matched catalog entry');
      return {
        url: url.url,
        label: match.pattern.label,
        resolve: async (): Promise<PrefetchResult> => ({
          url: url.url,
          label: match.pattern.label,
          status: 'failed' as const,
          error: `No active connector instance for ${match.catalogEntry.name}`,
        }),
      };
    }

    return {
      url: url.url,
      label: match.pattern.label,
      resolve: async (signal?: AbortSignal): Promise<PrefetchResult> => {
        try {
          const result = await fetchDocument({
            serverInstanceId: instance.instanceId,
            toolName: match.pattern.tool,
            args: match.extractedArgs,
            timeoutMs: perUrlTimeout,
            signal,
          });

          if (result.isMaterialized) {
            return {
              url: url.url,
              label: match.pattern.label,
              status: 'materialized',
              preview: result.content.slice(0, PREVIEW_CHAR_LIMIT),
              materializedPath: result.materializedPath,
              charCount: result.charCount,
              serverInstanceId: instance.instanceId,
            };
          }

          return {
            url: url.url,
            label: match.pattern.label,
            status: 'fetched',
            content: result.content,
            charCount: result.charCount,
            serverInstanceId: instance.instanceId,
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.warn({ url: url.url, serverInstanceId: instance.instanceId, err: message }, 'Document prefetch failed');
          return {
            url: url.url,
            label: match.pattern.label,
            status: 'failed',
            error: message,
          };
        }
      },
    };
  });

  // Execute all fetches in parallel with total deadline
  const deadlinePromise = new Promise<'deadline'>(resolve =>
    setTimeout(() => resolve('deadline'), totalTimeout)
  );

  const resultPromises = fetchTasks.map(async task => {
    const raceResult = await Promise.race([
      task.resolve(options?.signal),
      deadlinePromise.then((): PrefetchResult => ({
        url: task.url,
        label: task.label,
        status: 'failed',
        error: 'Prefetch deadline exceeded',
      })),
    ]);
    return raceResult;
  });

  const rawResults = await Promise.all(resultPromises);

  // Apply inline budget: convert fetched docs that exceed budget to "materialized" status
  let totalInlineChars = 0;
  const results = rawResults.map(result => {
    if (result.status !== 'fetched' || !result.content) return result;

    const charCount = result.charCount ?? result.content.length;

    if (charCount > inlineCharLimit || totalInlineChars + charCount > totalInlineLimit) {
      return {
        ...result,
        status: 'failed' as const,
        content: undefined,
        error: `Document too large for inline injection (${charCount.toLocaleString()} chars). The agent should use tools to fetch this content.`,
      };
    }

    totalInlineChars += charCount;
    return result;
  });

  const counts = {
    fetched: results.filter(r => r.status === 'fetched').length,
    materialized: results.filter(r => r.status === 'materialized').length,
    failed: results.filter(r => r.status === 'failed').length,
  };
  log.info(counts, 'Document prefetch complete');

  return results;
}

// ---------------------------------------------------------------------------
// Format prefetched documents for context injection
// ---------------------------------------------------------------------------

export function formatPrefetchedDocumentsContext(results: PrefetchResult[]): string | undefined {
  const successful = results.filter(r => r.status !== 'failed');
  if (successful.length === 0) return undefined;

  const parts = results.map(r => {
    const attrs = [`url="${r.url}"`, `status="${r.status}"`];
    if (r.serverInstanceId) attrs.push(`source="${r.serverInstanceId}"`);
    if (r.charCount) attrs.push(`chars="${r.charCount}"`);
    if (r.materializedPath) attrs.push(`file="${r.materializedPath}"`);

    if (r.status === 'fetched' && r.content) {
      return `<document ${attrs.join(' ')}>\n${r.content}\n</document>`;
    }

    if (r.status === 'materialized') {
      const sizeDesc = r.charCount ? `(${r.charCount.toLocaleString()} chars)` : '';
      return `<document ${attrs.join(' ')}>\nLarge document ${sizeDesc} saved to file. Use Read (with offset/limit) or Grep to explore.\n${r.preview ?? ''}\n</document>`;
    }

    if (r.status === 'failed' && r.error) {
      return `<document ${attrs.join(' ')}>\nPrefetch failed: ${r.error}\n</document>`;
    }

    return '';
  }).filter(Boolean);

  return parts.join('\n');
}
