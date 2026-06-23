/**
 * contentMaterialization — producer-side offload of large opaque-content
 * blocks from tool results into the session-scoped {@link ContentStore}.
 *
 * Mirrors `imageAssetMaterialization.ts` for the non-image dimension. For
 * each `toolResult.content` block whose inline payload exceeds
 * `CONTENT_REF_THRESHOLD_BYTES`, we:
 *
 *  1. Compute `contentId = sha256(bytes).slice(0, 32)`.
 *  2. Atomically publish the bytes to the local `ContentStore`.
 *  3. Replace the inline block with a `content_ref` variant carrying the
 *     {@link ContentRef} and a `summary` (first ~500 chars) so the renderer
 *     and search can display a preview without hydration.
 *
 * On any failure (disk full, conflict, unknown fs error), the producer
 * **keeps the inline content** and we emit a structured warn log. Never
 * emit a `contentRef` pointing to nothing.
 *
 * @see docs/plans/260518_cloud_sync_reconciliation_hardening.md § Stage B1a
 */

import { createHash } from 'node:crypto';
import type { ContentStore } from '@core/contentStore';
import {
  CONTENT_REF_THRESHOLD_BYTES,
  CONTENT_REF_SUMMARY_CHAR_LIMIT,
  CONTENT_STORE_ERROR_CODES,
} from '@core/contentStore';
import { createScopedLogger } from '@core/logger';
import type { ContentRef } from '@shared/types/agent';

const log = createScopedLogger({ service: 'contentMaterialization' });
const CONTENT_STORE_CODE_SET = new Set<string>(CONTENT_STORE_ERROR_CODES);

type MaterializeFailureReason =
  | 'storage-full'
  | 'conflict'
  | 'path-traversal'
  | 'unknown';

export interface MaterializeContentRefsInput {
  sessionId: string;
  turnId: string;
  eventSeq: number;
  /**
   * Tool result content blocks (typed as `unknown[]` because the upstream
   * `toolResult.content` field is `unknown[]` after Zod passthrough). The
   * function inspects each block and replaces qualifying ones with the
   * `content_ref` variant; non-qualifying blocks pass through unchanged.
   */
  content: readonly unknown[];
  /** 'desktop' → uploadStatus = 'pending'; 'cloud' → 'uploaded' (cloud already has the bytes). */
  surface: 'desktop' | 'cloud';
}

export interface MaterializeContentRefsResult {
  /** Updated content array with large blocks replaced by `content_ref` variants. */
  content: unknown[];
  /**
   * Positional refs matching `content` length. Non-content blocks and
   * blocks that stayed inline appear as `null`. Failed materializations
   * also appear as `null` so downstream sanitizers preserve the original
   * inline block instead of compacting indices.
   */
  refs: Array<ContentRef | null>;
  /** Content blocks that failed to materialize, by index. */
  failures: Array<{
    index: number;
    reason: MaterializeFailureReason;
    error?: unknown;
  }>;
}

function redactIds(sessionId: string, contentId: string): {
  sessionIdHash: string;
  contentIdSuffix: string;
} {
  return {
    sessionIdHash: createHash('sha256').update(sessionId).digest('hex').slice(0, 8),
    contentIdSuffix: contentId.slice(-8),
  };
}

function getFailureReason(error: unknown): MaterializeFailureReason {
  const code = (error as { code?: unknown })?.code;
  if (typeof code !== 'string' || !CONTENT_STORE_CODE_SET.has(code)) {
    return 'unknown';
  }
  if (code === 'storage-full') return 'storage-full';
  if (code === 'conflict') return 'conflict';
  if (code === 'path-traversal') return 'path-traversal';
  return 'unknown';
}

interface InlineExtraction {
  bytes: Buffer;
  mimeType: string;
}

/**
 * Extract the inline payload of a tool-result content block for offload
 * inspection. Returns `null` if the block has no offloadable inline payload
 * (e.g. already a `content_ref`, an image block, or an unknown shape).
 *
 * Supported shapes (matched by structural sniffing rather than a strict
 * discriminant, since `toolResult.content` is `unknown[]` and the producer
 * surface accepts forward-compatible variants):
 *  - `{ type: 'text', text: string }` — Anthropic-style inline text block.
 *  - `{ type: 'document', source: { data: base64, media_type } }` — inline
 *    base64 binary block.
 *  - `{ data: string, mimeType: string }` — generic raw payload form.
 */
function extractInlineBytes(block: unknown): InlineExtraction | null {
  if (!block || typeof block !== 'object') return null;
  const obj = block as Record<string, unknown>;

  if (obj.type === 'content_ref') return null;
  if (obj.type === 'image') return null;

  if (obj.type === 'text' && typeof obj.text === 'string') {
    return {
      bytes: Buffer.from(obj.text, 'utf8'),
      mimeType: typeof obj.mimeType === 'string' ? obj.mimeType : 'text/plain',
    };
  }

  if (typeof obj.text === 'string' && !obj.type) {
    return {
      bytes: Buffer.from(obj.text, 'utf8'),
      mimeType: typeof obj.mimeType === 'string' ? obj.mimeType : 'text/plain',
    };
  }

  if (
    obj.type === 'document'
    && obj.source
    && typeof obj.source === 'object'
  ) {
    const src = obj.source as Record<string, unknown>;
    if (typeof src.data === 'string') {
      return {
        bytes: Buffer.from(src.data, 'base64'),
        mimeType: typeof src.media_type === 'string'
          ? src.media_type
          : 'application/octet-stream',
      };
    }
  }

  if (typeof obj.data === 'string' && typeof obj.mimeType === 'string') {
    const isBase64 = /^[A-Za-z0-9+/=\r\n]+$/.test(obj.data.slice(0, 64));
    return {
      bytes: isBase64
        ? Buffer.from(obj.data, 'base64')
        : Buffer.from(obj.data, 'utf8'),
      mimeType: obj.mimeType,
    };
  }

  return null;
}

function buildSummary(bytes: Buffer, mimeType: string): string {
  if (mimeType.startsWith('text/') || mimeType.includes('json') || mimeType.includes('xml')) {
    return bytes.toString('utf8').slice(0, CONTENT_REF_SUMMARY_CHAR_LIMIT);
  }
  return '';
}

export async function materializeContentRefsForEvent(
  input: MaterializeContentRefsInput,
  contentStore: ContentStore,
): Promise<MaterializeContentRefsResult> {
  const outputContent: unknown[] = input.content.slice();
  const refs: Array<ContentRef | null> = Array.from({ length: input.content.length }, () => null);
  const failures: MaterializeContentRefsResult['failures'] = [];

  for (let index = 0; index < input.content.length; index += 1) {
    const block = input.content[index];
    const extracted = extractInlineBytes(block);
    if (!extracted) continue;
    if (extracted.bytes.byteLength <= CONTENT_REF_THRESHOLD_BYTES) continue;

    const contentId = createHash('sha256')
      .update(extracted.bytes)
      .digest('hex')
      .slice(0, 32);
    const redacted = redactIds(input.sessionId, contentId);

    try {
      const result = await contentStore.writeContent({
        sessionId: input.sessionId,
        contentId,
        bytes: extracted.bytes,
        mimeType: extracted.mimeType,
      });

      const summary = buildSummary(extracted.bytes, extracted.mimeType);
      const ref: ContentRef = {
        contentId: result.ref.contentId,
        mimeType: result.ref.mimeType,
        byteSize: result.ref.byteSize,
        etag: result.ref.etag ?? contentId,
        uploadStatus: input.surface === 'desktop' ? 'pending' : 'uploaded',
        ...(summary ? { summary } : {}),
      };
      refs[index] = ref;
      outputContent[index] = {
        type: 'content_ref',
        contentRef: ref,
        ...(summary ? { summary } : {}),
      };
    } catch (error) {
      const reason = getFailureReason(error);
      failures.push({ index, reason, error });
      log.warn(
        {
          ...redacted,
          index,
          reason,
          errorCode: (error as { code?: unknown })?.code,
          byteSize: extracted.bytes.byteLength,
          turnId: input.turnId,
          eventSeq: input.eventSeq,
        },
        'Content ref materialization failed during content store write; keeping inline content',
      );
      // Producer falls back to inline content — leave outputContent[index]
      // and refs[index] untouched (null) so the original block survives.
    }
  }

  return { content: outputContent, refs, failures };
}
