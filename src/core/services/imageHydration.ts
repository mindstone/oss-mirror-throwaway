import { Buffer } from 'node:buffer';
import { PNG } from 'pngjs';
import type { AssetResolutionReason, ImageRef } from '@shared/types/agent';
import type { AssetStore } from '@core/assetStore';
import type { Logger } from '@core/logger';
import { fireAndForget } from '@shared/utils/fireAndForget';
import { hashSessionIdForBreadcrumb } from '@shared/utils/hashSessionIdForBreadcrumb';
import { TurnScopedHydrationCache } from './imageHydrationCache';
import { recordAssetResolutionFailure } from './assetResolutionObservability';

export type HydrationDeps = {
  assetStore: AssetStore;
  cache: TurnScopedHydrationCache;
  providerKey: 'anthropic' | 'openai' | 'codex' | 'openrouter';
  maxBytes: number; // per-provider cap
  log: Logger;
};

export type HydratedImage = { data: string; mimeType: string; byteSize: number };

/**
 * Downscales an image using pngjs to get under the byte cap.
 * Converts to PNG if not already. Half dimensions iteratively.
 */
async function downscaleUnderCap(
  originalBytes: Buffer,
  maxBytes: number,
  log: Logger,
  sessionIdHash: string,
  assetIdHash: string
): Promise<{ bytes: Buffer; mimeType: string } | null> {
  return new Promise((resolve) => {
    // Attempt to parse with pngjs (this will fail if it's a JPEG or other format we can't parse easily)
    // In that case, we return null so the caller can mark it unavailable.
    // In a real production system we might want a lightweight jpeg decoder, but we use what we have.
    new PNG().parse(originalBytes, (err, data) => {
      if (err) {
        log.warn(
          { err: err.message, sessionIdHash, assetIdHash },
          'pngjs parse failed during downscale attempt (may not be a PNG)'
        );
        return resolve(null);
      }

      let currentData = data;
      let scaleFactor = 1;

      const tryEncode = (pngData: PNG): Promise<Buffer> => {
        return new Promise((res, rej) => {
          const bufs: Buffer[] = [];
          pngData.pack()
            .on('data', (chunk) => bufs.push(chunk))
            .on('end', () => res(Buffer.concat(bufs)))
            .on('error', rej);
        });
      };

      const iterate = async () => {
        try {
          let encoded = await tryEncode(currentData);
          let iteration = 0;
          while (encoded.length > maxBytes && iteration < 5) {
            iteration++;
            scaleFactor /= 2;
            const newWidth = Math.max(1, Math.floor(currentData.width / 2));
            const newHeight = Math.max(1, Math.floor(currentData.height / 2));
            const newPng = new PNG({ width: newWidth, height: newHeight });

            // Nearest-neighbor downsample
            for (let y = 0; y < newHeight; y++) {
              for (let x = 0; x < newWidth; x++) {
                const srcX = x * 2;
                const srcY = y * 2;
                const idxSrc = (currentData.width * srcY + srcX) << 2;
                const idxDst = (newWidth * y + x) << 2;

                newPng.data[idxDst] = currentData.data[idxSrc];
                newPng.data[idxDst + 1] = currentData.data[idxSrc + 1];
                newPng.data[idxDst + 2] = currentData.data[idxSrc + 2];
                newPng.data[idxDst + 3] = currentData.data[idxSrc + 3];
              }
            }

            currentData = newPng;
            encoded = await tryEncode(currentData);
          }

          if (encoded.length > maxBytes) {
             return resolve(null); // still too big
          }

          log.info({
            sessionIdHash,
            assetIdHash,
            originalByteSize: originalBytes.length,
            scaledByteSize: encoded.length,
            scaleFactor
          }, 'Downscaled image to fit under provider cap');
          
          return resolve({ bytes: encoded, mimeType: 'image/png' });
        } catch (e) {
          log.warn({ err: e instanceof Error ? e.message : String(e), sessionIdHash, assetIdHash }, 'Downscale encoding failed');
          return resolve(null);
        }
      };

      fireAndForget(iterate(), 'imageHydration.downscaleUnderCap.iterate');
    });
  });
}

export async function hydrateImageRef(
  ref: ImageRef,
  sessionId: string,
  deps: HydrationDeps
): Promise<HydratedImage | { kind: 'unavailable'; reason: AssetResolutionReason }> {
  const { assetStore, cache, providerKey, maxBytes, log } = deps;
  const sessionIdHash = hashSessionIdForBreadcrumb(sessionId);
  const assetIdHash = hashSessionIdForBreadcrumb(ref.assetId);

  // 1. Check cache for hit
  const cacheKeyOriginal = `${sessionId}::${ref.assetId}::orig::${providerKey}` as const;
  const cacheKeyDownscaled = `${sessionId}::${ref.assetId}::downscaled::${providerKey}` as const;

  const hitDownscaled = cache.get(cacheKeyDownscaled);
  if (hitDownscaled) {
    return { data: hitDownscaled.bytes.toString('base64'), mimeType: hitDownscaled.mimeType, byteSize: hitDownscaled.byteSize };
  }
  const hitOrig = cache.get(cacheKeyOriginal);
  if (hitOrig) {
    return { data: hitOrig.bytes.toString('base64'), mimeType: hitOrig.mimeType, byteSize: hitOrig.byteSize };
  }

  // 2. Read from asset store
  const result = await assetStore.readAsset({ sessionId, assetId: ref.assetId });
  if (result.reason !== 'ok') {
    recordAssetResolutionFailure({
      sessionId,
      assetId: ref.assetId,
      reason: result.reason,
      context: 'hydrate',
      metadata: { providerKey },
      log,
    });
    return { kind: 'unavailable', reason: result.reason };
  }

  let { bytes, mimeType, byteSize } = result;

  // 3. Downscale if needed
  if (byteSize > maxBytes) {
    const downscaled = await downscaleUnderCap(bytes, maxBytes, log, sessionIdHash, assetIdHash);
    
    if (!downscaled || downscaled.bytes.length > maxBytes) {
      recordAssetResolutionFailure({
        sessionId,
        assetId: ref.assetId,
        reason: 'oversized',
        context: 'hydrate',
        metadata: { byteSize, maxBytes, providerKey },
        log,
      });
      return { kind: 'unavailable', reason: 'oversized' as AssetResolutionReason };
    }
    
    bytes = downscaled.bytes;
    mimeType = downscaled.mimeType;
    byteSize = bytes.length;
    
    cache.set(cacheKeyDownscaled, { bytes, mimeType, byteSize });
  } else {
    cache.set(cacheKeyOriginal, { bytes, mimeType, byteSize });
  }

  return {
    data: bytes.toString('base64'),
    mimeType,
    byteSize
  };
}
