import { useMemo, useState } from 'react';
import {
  CloudClientError,
  mapImageRef,
  type ImageContentBlock,
  type ImageRef,
} from '@rebel/cloud-client';
import { XIcon } from './icons';
import styles from './ToolResultImage.module.css';

interface ToolResultImageProps {
  images?: ImageContentBlock[];
  imageRef?: (ImageRef | null)[];
  owningSessionId?: string;
}

type DisplayImage =
  | {
    key: string;
    state: 'ready';
    thumbSrc: string;
    fullSrc: string;
    alt: string;
  }
  | {
    key: string;
    state: 'loading';
    alt: string;
  }
  | {
    key: string;
    state: 'failed';
    alt: string;
  };

const resolveDisplayImages = (
  images: ImageContentBlock[] | undefined,
  imageRef: (ImageRef | null)[] | undefined,
  owningSessionId: string | undefined,
): DisplayImage[] => {
  const total = Math.max(images?.length ?? 0, imageRef?.length ?? 0);
  const displayImages: DisplayImage[] = [];

  for (let index = 0; index < total; index += 1) {
    const ref = imageRef?.[index];
    const image = images?.[index];

    if (ref) {
      if (ref.uploadStatus === 'pending') {
        displayImages.push({
          key: `ref-${ref.assetId}-${index}`,
          state: 'loading',
          alt: `Tool result image ${index + 1} syncing`,
        });
        continue;
      }

      if (ref.uploadStatus === 'missing') {
        displayImages.push({
          key: `ref-${ref.assetId}-${index}`,
          state: 'failed',
          alt: `Tool result image ${index + 1} unavailable`,
        });
        continue;
      }

      if (owningSessionId) {
        try {
          const full = mapImageRef(ref, owningSessionId);
          const thumb = mapImageRef(ref, owningSessionId, { thumb: true });
          displayImages.push({
            key: `ref-${ref.assetId}-${index}`,
            state: 'ready',
            thumbSrc: thumb.url,
            fullSrc: full.url,
            alt: `Tool result ${index + 1}`,
          });
          continue;
        } catch (err) {
          if (!(err instanceof CloudClientError) || err.code !== 'cloud-client-not-configured') {
            throw err;
          }
        }
      }
    }

    if (image?.type === 'image' && image.data && image.mimeType) {
      const src = `data:${image.mimeType};base64,${image.data}`;
      displayImages.push({
        key: `legacy-${image.mimeType}-${index}`,
        state: 'ready',
        thumbSrc: src,
        fullSrc: src,
        alt: `Tool result ${index + 1}`,
      });
      continue;
    }

    if (ref === null || ref) {
      displayImages.push({
        key: ref ? `ref-${ref.assetId}-${index}` : `ref-null-${index}`,
        state: 'failed',
        alt: `Tool result image ${index + 1} unavailable`,
      });
    }
  }

  return displayImages;
};

export function ToolResultImage({ images, imageRef, owningSessionId }: ToolResultImageProps) {
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);

  const displayImages = useMemo(
    () => resolveDisplayImages(images, imageRef, owningSessionId),
    [images, imageRef, owningSessionId],
  );

  if (displayImages.length === 0) {
    return null;
  }

  const expandedImage = expandedIndex === null ? null : displayImages[expandedIndex];

  return (
    <>
      <div className={styles.gallery} data-testid="tool-result-images">
        {displayImages.map((image, index) => {
          if (image.state === 'loading') {
            return (
              <div
                key={image.key}
                className={`${styles.statusTile} ${styles.statusTileLoading}`}
                data-testid="tool-result-image-loading"
              >
                Syncing image…
              </div>
            );
          }

          if (image.state === 'failed') {
            return (
              <div
                key={image.key}
                className={`${styles.statusTile} ${styles.statusTileFailed}`}
                data-testid="tool-result-image-failed"
              >
                Image unavailable
              </div>
            );
          }

          return (
            <button
              type="button"
              key={image.key}
              className={styles.thumbnailButton}
              onClick={() => setExpandedIndex(index)}
              aria-label={`Open tool result image ${index + 1}`}
            >
              <img
                src={image.thumbSrc}
                alt={`Tool result ${index + 1}`}
                className={styles.thumbnailImage}
                loading="lazy"
              />
            </button>
          );
        })}
      </div>

      {expandedImage && expandedImage.state === 'ready' ? (
        <div
          className={styles.overlay}
          role="dialog"
          aria-modal="true"
          aria-label="Expanded tool result image"
          onClick={() => setExpandedIndex(null)}
        >
          <button
            type="button"
            className={styles.closeButton}
            onClick={() => setExpandedIndex(null)}
            aria-label="Close expanded image"
          >
            <XIcon size={16} />
          </button>
          <img
            src={expandedImage.fullSrc}
            alt="Expanded tool result"
            className={styles.expandedImage}
            onClick={(event) => event.stopPropagation()}
          />
        </div>
      ) : null}
    </>
  );
}
