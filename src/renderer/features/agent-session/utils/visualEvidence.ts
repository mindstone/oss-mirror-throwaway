import type { AgentEvent, ImageContentBlock, ImageRef } from '@shared/types';
import { safeParseDetail } from './safeParseDetail';

const APP_SCREENSHOT_TOOL_NAME = 'rebel_get_app_screenshot';
const APP_SCREENSHOT_PATH_PREFIX = '.rebel/screenshots/';

const hasAppScreenshotPath = (detail: string): boolean => {
  const parsed = safeParseDetail(detail);
  if (parsed.ok) {
    const path = (parsed.value as { path?: unknown } | null)?.path;
    return typeof path === 'string' && path.startsWith(APP_SCREENSHOT_PATH_PREFIX);
  }
  // too-large / malformed → substring fallback (bounded), as before
  return detail.includes(APP_SCREENSHOT_PATH_PREFIX);
};

type ScreenshotEvent = Extract<AgentEvent, { type: 'tool' }>;

const isAppScreenshotEvent = (event: AgentEvent): event is ScreenshotEvent => {
  if (event.type !== 'tool' || event.stage !== 'end') return false;
  const hasImageContent = !!event.imageContent && event.imageContent.length > 0;
  const hasImageRef = !!event.imageRef && event.imageRef.some((slot) => slot !== null);
  if (!hasImageContent && !hasImageRef) return false;
  return event.toolName === APP_SCREENSHOT_TOOL_NAME || hasAppScreenshotPath(event.detail);
};

const getImageKey = (event: ScreenshotEvent, image: ImageContentBlock, index: number): string => {
  if (event.toolUseId) {
    return `${event.toolUseId}:${index}`;
  }

  return `${image.mimeType}:${image.data.length}:${image.data.slice(0, 64)}`;
};

const getRefKey = (event: ScreenshotEvent, ref: ImageRef, index: number): string => {
  if (event.toolUseId) {
    return `${event.toolUseId}:ref:${index}`;
  }
  return `ref:${ref.assetId}`;
};

/**
 * Legacy helper. Returns only legacy base64 image blocks from completed
 * Rebel app screenshot events. Ref-only screenshots are not represented here.
 * Prefer `extractAppScreenshotEvents` so the renderer can resolve refs
 * through `rebel-asset://` (see Stage 6 refinement).
 */
export const extractAppScreenshotImages = (events: AgentEvent[]): ImageContentBlock[] => {
  const images: ImageContentBlock[] = [];
  const seen = new Set<string>();

  for (const event of events) {
    if (!isAppScreenshotEvent(event)) continue;
    if (!event.imageContent || event.imageContent.length === 0) continue;

    event.imageContent.forEach((image, index) => {
      const key = getImageKey(event, image, index);
      if (seen.has(key)) return;
      seen.add(key);
      images.push(image);
    });
  }

  return images;
};

export interface AppScreenshotEventSlice {
  toolUseId: string | undefined;
  imageContent?: ImageContentBlock[];
  imageRef?: (ImageRef | null)[];
}

/**
 * Returns the per-event payloads needed to render the "Screenshot captured"
 * grid via `imageGridSourceFromEvent`. Dedupes whole events whose refs and
 * legacy bytes have all already been seen by an earlier event so historical
 * sessions that re-emit the same screenshot don't double-render.
 */
export const extractAppScreenshotEvents = (events: AgentEvent[]): AppScreenshotEventSlice[] => {
  const slices: AppScreenshotEventSlice[] = [];
  const seenContent = new Set<string>();
  const seenRefs = new Set<string>();

  for (const event of events) {
    if (!isAppScreenshotEvent(event)) continue;

    const refsLen = event.imageRef?.length ?? 0;
    const contentLen = event.imageContent?.length ?? 0;
    const total = Math.max(refsLen, contentLen);
    if (total === 0) continue;

    let anyNovel = false;

    for (let index = 0; index < total; index += 1) {
      const ref = event.imageRef?.[index];
      const block = event.imageContent?.[index];

      if (ref) {
        const refKey = getRefKey(event, ref, index);
        if (!seenRefs.has(refKey)) {
          seenRefs.add(refKey);
          anyNovel = true;
        }
      } else if (ref === null) {
        anyNovel = true;
      }

      if (block) {
        const contentKey = getImageKey(event, block, index);
        if (!seenContent.has(contentKey)) {
          seenContent.add(contentKey);
          anyNovel = true;
        }
      }
    }

    if (!anyNovel) continue;

    slices.push({
      toolUseId: event.toolUseId,
      imageContent: contentLen > 0 ? event.imageContent : undefined,
      imageRef: refsLen > 0 ? (event.imageRef as (ImageRef | null)[]) : undefined,
    });
  }

  return slices;
};
