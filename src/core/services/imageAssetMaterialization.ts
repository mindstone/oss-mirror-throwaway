import { createHash } from 'node:crypto';
import type { AssetStore } from '@core/assetStore';
import { ASSET_STORE_ERROR_CODES } from '@core/assetStore';
import { createScopedLogger } from '@core/logger';
import { ALLOWED_IMAGE_MIME_TYPES } from '@shared/markdownImageAssets';
import type { ImageContentBlock, ImageRef } from '@shared/types/agent';

const log = createScopedLogger({ service: 'imageAssetMaterialization' });

const ALLOWED_MIME_SET = new Set<string>(ALLOWED_IMAGE_MIME_TYPES);
const ASSET_STORE_CODE_SET = new Set<string>(ASSET_STORE_ERROR_CODES);

type MaterializeFailureReason =
  | 'mime-rejected'
  | 'magic-byte-mismatch'
  | 'storage-full'
  | 'conflict'
  | 'unknown';

export interface MaterializeImageRefsInput {
  sessionId: string;
  turnId: string;
  eventSeq: number;
  imageContent: readonly ImageContentBlock[];
  /** 'desktop' → uploadStatus = 'pending'; 'cloud' → 'uploaded' */
  surface: 'desktop' | 'cloud';
}

export interface MaterializeImageRefsResult {
  /**
   * Positional refs matching `imageContent` length.
   * Failed materializations stay `null` so downstream sanitizers preserve the
   * matching inline fallback bytes instead of compacting indices.
   */
  refs: Array<ImageRef | null>;
  /** Images that failed to materialize, by index. The caller still has the original imageContent. */
  failures: Array<{
    index: number;
    reason: MaterializeFailureReason;
    error?: unknown;
  }>;
}

function redactIds(sessionId: string, assetId: string): {
  sessionIdHash: string;
  assetIdSuffix: string;
} {
  return {
    sessionIdHash: createHash('sha256').update(sessionId).digest('hex').slice(0, 8),
    assetIdSuffix: assetId.slice(-8),
  };
}

function getFailureReason(error: unknown): MaterializeFailureReason {
  const code = (error as { code?: unknown })?.code;
  if (typeof code !== 'string' || !ASSET_STORE_CODE_SET.has(code)) {
    return 'unknown';
  }
  if (code === 'mime-rejected') return 'mime-rejected';
  if (code === 'magic-byte-mismatch') return 'magic-byte-mismatch';
  if (code === 'storage-full') return 'storage-full';
  if (code === 'conflict') return 'conflict';
  return 'unknown';
}

export async function materializeImageRefsForEvent(
  input: MaterializeImageRefsInput,
  assetStore: AssetStore,
): Promise<MaterializeImageRefsResult> {
  const refs: Array<ImageRef | null> = Array.from({ length: input.imageContent.length }, () => null);
  const failures: MaterializeImageRefsResult['failures'] = [];

  for (let index = 0; index < input.imageContent.length; index += 1) {
    const image = input.imageContent[index];
    const mimeType = image.mimeType.toLowerCase();
    const assetId = `${input.turnId}-${input.eventSeq}-${index}`;
    const redacted = redactIds(input.sessionId, assetId);

    if (!ALLOWED_MIME_SET.has(mimeType)) {
      failures.push({ index, reason: 'mime-rejected' });
      log.warn(
        {
          ...redacted,
          index,
          reason: 'mime-rejected',
          mimeType,
        },
        'Image ref materialization skipped due to disallowed MIME type',
      );
      continue;
    }

    const bytes = Buffer.from(image.data, 'base64');

    try {
      await assetStore.writeAsset({
        sessionId: input.sessionId,
        assetId,
        bytes,
        mimeType,
      });
    } catch (error) {
      const reason = getFailureReason(error);
      failures.push({ index, reason, error });
      log.warn(
        {
          ...redacted,
          index,
          reason,
          errorCode: (error as { code?: unknown })?.code,
        },
        'Image ref materialization failed during asset write',
      );
      continue;
    }

    let thumbnailAssetId: string | undefined;
    try {
      const thumbnail = await assetStore.generateThumbnail(bytes, mimeType);
      if ('bytes' in thumbnail && thumbnail.mimeType === 'image/png') {
        thumbnailAssetId = `${assetId}_thumb`;
        await assetStore.writeThumbnail({
          sessionId: input.sessionId,
          assetId,
          thumbnailAssetId,
          bytes: thumbnail.bytes,
        });
      }
    } catch (error) {
      log.debug(
        {
          ...redacted,
          index,
          errorCode: (error as { code?: unknown })?.code,
        },
        'Thumbnail write failed; continuing without thumbnail reference',
      );
      thumbnailAssetId = undefined;
    }

    refs[index] = {
      assetId,
      mimeType,
      byteSize: bytes.byteLength,
      ...(thumbnailAssetId ? { thumbnailAssetId } : {}),
      uploadStatus: input.surface === 'desktop' ? 'pending' : 'uploaded',
    };
  }

  return { refs, failures };
}
