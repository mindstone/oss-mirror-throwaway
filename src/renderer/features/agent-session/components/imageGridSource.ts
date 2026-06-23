import type { ImageContentBlock, ImageRef } from '@shared/types';

export type ImageTileState = 'loading' | 'ready' | 'failed' | 'empty';

export interface ImageGridItem {
  key: string;
  tileSrc: string;
  fullSrc: string;
  alt: string;
  mimeType?: string;
  width?: number;
  height?: number;
  uploadStatus?: ImageRef['uploadStatus'];
  state?: ImageTileState;
}

export interface ImageGridSourceInput {
  imageContent?: ImageContentBlock[];
  imageRef?: (ImageRef | null | undefined)[];
}

const buildAssetUrl = (sessionId: string, assetId: string, thumb: boolean): string => {
  const suffix = thumb ? '?thumb=1' : '';
  return `rebel-asset://session/${encodeURIComponent(sessionId)}/${encodeURIComponent(assetId)}${suffix}`;
};

const buildDataUrl = (image: ImageContentBlock): string => {
  return `data:${image.mimeType};base64,${image.data}`;
};

const altFor = (prefix: string | undefined, index: number, total: number): string => {
  const base = prefix && prefix.trim().length > 0 ? prefix : 'Tool result image';
  if (total <= 1) {
    return base;
  }
  return `${base} ${index + 1} of ${total}`;
};

const lengthFromInput = (input: ImageGridSourceInput): number => {
  const refLen = input.imageRef?.length ?? 0;
  const contentLen = input.imageContent?.length ?? 0;
  return Math.max(refLen, contentLen);
};

/**
 * Build the grid items for a tool event. Prefers `imageRef` (resolved through
 * `rebel-asset://`) and falls back to inline base64 from `imageContent` when
 * the ref is absent at the corresponding positional index. Returns one item
 * per image slot — refs and legacy bytes never double-render. A positional
 * slot where `imageRef[i]` is explicit `null` (Stage 4 materialization
 * failure) AND no legacy `imageContent[i]` is present renders as a failed
 * tile so spatial integrity matches the producing event.
 */
export const imageGridSourceFromEvent = (
  input: ImageGridSourceInput,
  sessionId: string | undefined,
  options: { altPrefix?: string; keyPrefix?: string } = {},
): ImageGridItem[] => {
  const total = lengthFromInput(input);
  if (total === 0) {
    return [];
  }

  const refsLen = input.imageRef?.length ?? 0;
  const items: ImageGridItem[] = [];
  for (let index = 0; index < total; index += 1) {
    const hasRefSlot = index < refsLen;
    const refSlot = hasRefSlot ? input.imageRef?.[index] : undefined;
    const legacy = input.imageContent?.[index];
    const alt = altFor(options.altPrefix, index, total);
    const keyPrefix = options.keyPrefix ? `${options.keyPrefix}:` : '';

    if (refSlot && sessionId) {
      const tileSrc = buildAssetUrl(sessionId, refSlot.assetId, true);
      const fullSrc = buildAssetUrl(sessionId, refSlot.assetId, false);
      const uploadStatus = refSlot.uploadStatus;
      items.push({
        key: `${keyPrefix}ref:${refSlot.assetId}`,
        tileSrc,
        fullSrc,
        alt,
        mimeType: refSlot.mimeType,
        width: refSlot.width,
        height: refSlot.height,
        uploadStatus,
        state:
          uploadStatus === 'missing'
            ? 'failed'
            : uploadStatus === 'pending'
              ? 'loading'
              : 'ready',
      });
      continue;
    }

    if (legacy?.data && legacy.mimeType) {
      const dataUrl = buildDataUrl(legacy);
      items.push({
        key: `${keyPrefix}legacy:${index}:${legacy.mimeType}`,
        tileSrc: dataUrl,
        fullSrc: dataUrl,
        alt,
        mimeType: legacy.mimeType,
        state: 'ready',
      });
      continue;
    }

    if (hasRefSlot && refSlot === null) {
      items.push({
        key: `${keyPrefix}failed:${index}`,
        tileSrc: '',
        fullSrc: '',
        alt: 'Image unavailable',
        state: 'failed',
      });
      continue;
    }
  }

  return items;
};

/**
 * Convenience helper for legacy callers that only carry an `ImageContentBlock[]`
 * (for example `extractAppScreenshotImages`). Returns ready-state grid items
 * backed by data URIs.
 */
export const imageGridSourceFromImageBlocks = (
  images: ImageContentBlock[] | undefined,
  options: { altPrefix?: string; keyPrefix?: string } = {},
): ImageGridItem[] => {
  if (!images || images.length === 0) {
    return [];
  }
  return imageGridSourceFromEvent({ imageContent: images }, undefined, options);
};
