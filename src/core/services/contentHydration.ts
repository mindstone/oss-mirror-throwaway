import { Buffer } from 'node:buffer';
import type { ContentRef } from '@shared/types/agent';
import type { ContentStore } from '@core/contentStore';
import type { Logger } from '@core/logger';
import {
  ContentHydrationCache,
} from './contentHydrationCache';
import { recordContentResolutionFailure } from './contentResolutionFailureRecorder';
import type {
  KnownContentResolutionReason,
  ContentResolutionReason,
} from '@core/types/contentResolutionReason';
import { normalizeContentResolutionReason } from '@core/types/contentResolutionReason';
import { truncateForBudget } from './contentTruncation';

/**
 * Cloud-side content fetcher abstraction. Supports both call signatures:
 * - downloadContent(sessionId, contentId)
 * - downloadContent({ sessionId, contentId })
 */
export interface ContentDownloader {
  downloadContent(
    ...args:
      | [sessionId: string, contentId: string]
      | [{ sessionId: string; contentId: string }]
  ): Promise<
    | { bytes: Buffer | Uint8Array; mimeType: string }
    | { reason: string; bytes?: Buffer | Uint8Array; mimeType?: string }
  >;
}

export interface HydratedContent {
  contentRef: ContentRef;
  bytes: Buffer;
  mimeType: string;
  reason: 'ok';
}

export interface ContentHydrationFailure {
  contentRef: ContentRef;
  reason: Exclude<KnownContentResolutionReason, 'ok'>;
  details?: Record<string, unknown>;
}

export type HydratedContentResult = HydratedContent | ContentHydrationFailure;

export function isHydratedContent(value: HydratedContentResult): value is HydratedContent {
  return value.reason === 'ok' && 'bytes' in value;
}

export interface HydrateContentRefsDeps {
  contentStore?: ContentStore;
  cache?: ContentHydrationCache;
  cloudClient?: ContentDownloader;
  log: Logger;
  sessionId?: string;
}

type LocalFetchSuccess = { reason: 'ok'; bytes: Buffer; mimeType: string };
type LocalFetchFailure = { reason: Exclude<KnownContentResolutionReason, 'ok'> };
type LocalFetchResult = LocalFetchSuccess | LocalFetchFailure;

function isLocalFetchSuccess(value: LocalFetchResult): value is LocalFetchSuccess {
  return value.reason === 'ok' && 'bytes' in value;
}

function resolveSessionId(ref: ContentRef, deps: HydrateContentRefsDeps): string | undefined {
  if (deps.sessionId) return deps.sessionId;
  const fromRef = (ref as { sessionId?: unknown }).sessionId;
  return typeof fromRef === 'string' && fromRef.length > 0 ? fromRef : undefined;
}

async function readFromLocal(
  ref: ContentRef,
  sessionId: string,
  store: ContentStore,
): Promise<LocalFetchResult> {
  try {
    const result = await store.readContent({ sessionId, contentId: ref.contentId });
    if (result.reason === 'ok') {
      return { reason: 'ok', bytes: result.bytes, mimeType: result.mimeType };
    }
    return {
      reason: result.reason === 'not-found' ? 'missing' : 'unknown',
    };
  } catch {
    return { reason: 'unknown' };
  }
}

type DownloadResult =
  | { reason: 'ok'; bytes: Buffer; mimeType: string }
  | { reason: Exclude<KnownContentResolutionReason, 'ok'>; details?: Record<string, unknown> };

function toDownloadFailure(reason: unknown): DownloadResult {
  const normalized = normalizeContentResolutionReason(reason);
  return {
    reason: normalized === 'ok' ? 'unknown' : normalized,
  };
}

async function readFromCloud(
  ref: ContentRef,
  sessionId: string,
  client: ContentDownloader,
): Promise<DownloadResult> {
  try {
    let result:
      | { bytes: Buffer | Uint8Array; mimeType: string }
      | { reason: string; bytes?: Buffer | Uint8Array; mimeType?: string };
    try {
      result = await client.downloadContent(sessionId, ref.contentId);
    } catch {
      result = await client.downloadContent({ sessionId, contentId: ref.contentId });
    }
    if (
      result
      && typeof result === 'object'
      && !('reason' in result)
      && 'bytes' in result
      && 'mimeType' in result
    ) {
      const bytes = Buffer.isBuffer(result.bytes) ? result.bytes : Buffer.from(result.bytes);
      return {
        reason: 'ok',
        bytes,
        mimeType: result.mimeType,
      };
    }

    if (
      result
      && typeof result === 'object'
      && 'reason' in result
      && result.reason === 'ok'
      && 'bytes' in result
      && 'mimeType' in result
    ) {
      const bytesSource = result.bytes;
      const mimeType = result.mimeType;
      if (
        !(Buffer.isBuffer(bytesSource) || bytesSource instanceof Uint8Array)
        || typeof mimeType !== 'string'
      ) {
        return { reason: 'unknown' };
      }
      const bytes = Buffer.isBuffer(bytesSource) ? bytesSource : Buffer.from(bytesSource);
      return {
        reason: 'ok',
        bytes,
        mimeType,
      };
    }

    if (result && typeof result === 'object' && 'reason' in result) {
      return toDownloadFailure(result.reason);
    }
    return { reason: 'unknown' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/network|fetch|abort|timeout/i.test(message)) {
      return { reason: 'fetch-failed' };
    }
    return { reason: 'unknown' };
  }
}

/**
 * Hydrate content refs from local store and optional cloud fallback.
 */
export async function hydrateContentRefs(
  refs: ContentRef[],
  deps: HydrateContentRefsDeps,
): Promise<HydratedContentResult[]> {
  if (refs.length === 0) return [];
  const out: Array<HydratedContent | ContentHydrationFailure> = [];

  for (const ref of refs) {
    const sessionId = resolveSessionId(ref, deps);
    if (!sessionId) {
      out.push({
        contentRef: ref,
        reason: 'unknown',
        details: { message: 'Missing sessionId for content hydration' },
      });
      continue;
    }

    const cached = deps.cache?.get(sessionId, ref.contentId);
    if (cached) {
      out.push({
        contentRef: ref,
        bytes: cached.bytes,
        mimeType: cached.mimeType,
        reason: 'ok',
      });
      continue;
    }

    let localFailure: Exclude<KnownContentResolutionReason, 'ok'> = 'missing';
    if (deps.contentStore) {
      const local = await readFromLocal(ref, sessionId, deps.contentStore);
      if (isLocalFetchSuccess(local)) {
        deps.cache?.set(sessionId, ref.contentId, {
          bytes: local.bytes,
          mimeType: local.mimeType,
        });
        out.push({
          contentRef: ref,
          bytes: local.bytes,
          mimeType: local.mimeType,
          reason: 'ok',
        });
        continue;
      }
      localFailure = local.reason;
    }

    if (deps.cloudClient) {
      const cloud = await readFromCloud(ref, sessionId, deps.cloudClient);
      if (cloud.reason === 'ok') {
        deps.cache?.set(sessionId, ref.contentId, {
          bytes: cloud.bytes,
          mimeType: cloud.mimeType,
        });
        out.push({
          contentRef: ref,
          bytes: cloud.bytes,
          mimeType: cloud.mimeType,
          reason: 'ok',
        });
        continue;
      }

      const cloudReason = cloud.reason;
      const reason: Exclude<KnownContentResolutionReason, 'ok'> =
        localFailure === 'missing' && cloudReason === 'missing'
          ? (ref.uploadStatus === 'pending' ? 'pending-upload' : 'missing')
          : cloudReason;

      recordContentResolutionFailure({
        sessionId,
        contentId: ref.contentId,
        reason,
        details: {
          source: 'cloud',
          localReason: localFailure,
          ...(cloud.details ? { cloudDetails: cloud.details } : {}),
        },
        log: deps.log,
      });
      out.push({ contentRef: ref, reason });
      continue;
    }

    const reason: Exclude<KnownContentResolutionReason, 'ok'> =
      localFailure === 'missing' && ref.uploadStatus === 'pending'
        ? 'pending-upload'
        : localFailure;
    recordContentResolutionFailure({
      sessionId,
      contentId: ref.contentId,
      reason,
      details: { source: 'local' },
      log: deps.log,
    });
    out.push({ contentRef: ref, reason });
  }

  return out;
}

export async function hydrateContentRef(
  ref: ContentRef,
  sessionId: string,
  deps: Omit<HydrateContentRefsDeps, 'sessionId'>,
): Promise<HydratedContentResult> {
  const [result] = await hydrateContentRefs([ref], { ...deps, sessionId });
  if (!result) {
    return {
      contentRef: ref,
      reason: 'unknown',
      details: { message: 'No hydration result returned' },
    };
  }
  return result;
}

export interface HydratedTextBlock {
  index: number;
  contentRef: ContentRef;
  text: string;
  byteSize: number;
}

export interface ApplyTruncationOptions {
  /** Per-provider context budget in bytes (conservative). */
  budgetBytes: number;
  /**
   * Bytes already accounted for elsewhere in the request (system prompt,
   * tools, messages). The hydrated text must fit within
   * `budgetBytes - usedBytes`.
   */
  usedBytes: number;
  log: Logger;
  sessionId: string;
}

/**
 * Apply truncation-for-budget to hydrated text blocks. Largest blocks are
 * truncated first until total bytes fit the remaining budget.
 */
export function applyTruncationForBudget(
  blocks: HydratedTextBlock[],
  options: ApplyTruncationOptions,
): HydratedTextBlock[] {
  const remaining = Math.max(0, options.budgetBytes - options.usedBytes);
  if (remaining <= 0) return blocks;

  let total = blocks.reduce((s, b) => s + b.byteSize, 0);
  if (total <= remaining) return blocks;

  const sorted = blocks.slice().sort((a, b) => b.byteSize - a.byteSize);
  for (const block of sorted) {
    if (total <= remaining) break;
    const overflow = total - remaining;
    const targetBytes = Math.max(256, block.byteSize - overflow);
    const result = truncateForBudget(block.text, targetBytes, block.contentRef.contentId);
    if (!result.wasTruncated) continue;

    const markerIndex = result.text.indexOf(result.marker);
    const keptHead = markerIndex >= 0
      ? Buffer.byteLength(result.text.slice(0, markerIndex), 'utf8')
      : result.keptBytes;
    const keptTail = markerIndex >= 0
      ? Buffer.byteLength(result.text.slice(markerIndex + result.marker.length), 'utf8')
      : 0;
    const truncatedBytes = Math.max(0, result.originalBytes - result.keptBytes);
    const delta = Math.max(0, block.byteSize - result.keptBytes);

    block.text = result.text;
    block.byteSize = result.keptBytes;
    total -= delta;

    options.log.warn(
      {
        contentIdSuffix: block.contentRef.contentId.slice(-8),
        contentId: block.contentRef.contentId,
        originalBytes: result.originalBytes,
        truncatedBytes,
        keptHead,
        keptTail,
        budgetBytes: options.budgetBytes,
        usedBytes: options.usedBytes,
      },
      'content-hydration:truncated-for-budget',
    );

    recordContentResolutionFailure({
      sessionId: options.sessionId,
      contentId: block.contentRef.contentId,
      reason: 'truncated-for-budget',
      details: {
        originalBytes: result.originalBytes,
        truncatedBytes,
        keptHead,
        keptTail,
        budgetBytes: options.budgetBytes,
      },
    });
  }
  return blocks;
}

export type { ContentResolutionReason };
