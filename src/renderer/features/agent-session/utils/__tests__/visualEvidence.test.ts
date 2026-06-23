import { describe, expect, it } from 'vitest';
import type { AgentEvent, ImageContentBlock, ImageRef } from '@shared/types';
import {
  extractAppScreenshotEvents,
  extractAppScreenshotImages,
} from '../visualEvidence';

const image = (data = 'base64-image'): ImageContentBlock => ({
  type: 'image',
  data,
  mimeType: 'image/png',
});

const refOf = (assetId: string): ImageRef => ({
  assetId,
  mimeType: 'image/png',
  byteSize: 1024,
});

const screenshotEvent = (
  overrides: Partial<Extract<AgentEvent, { type: 'tool' }>> = {},
): AgentEvent => ({
  type: 'tool',
  toolName: 'rebel_get_app_screenshot',
  stage: 'end',
  detail: '{"path":".rebel/screenshots/demo.png"}',
  timestamp: 1,
  toolUseId: 'screenshot-1',
  imageContent: [image()],
  ...overrides,
});

describe('extractAppScreenshotImages', () => {
  it('returns images from completed Rebel app screenshot tool results', () => {
    expect(extractAppScreenshotImages([screenshotEvent()])).toEqual([image()]);
  });

  it('ignores non-screenshot tools, starts, and screenshot errors without image content', () => {
    const events: AgentEvent[] = [
      screenshotEvent({ stage: 'start', imageContent: undefined }),
      screenshotEvent({ stage: 'end', imageContent: undefined, isError: true }),
      screenshotEvent({ toolName: 'Read', detail: '{"path":"notes/demo.png"}' }),
    ];

    expect(extractAppScreenshotImages(events)).toEqual([]);
  });

  it('deduplicates repeated screenshot events by tool use id and image index', () => {
    const events = [
      screenshotEvent(),
      screenshotEvent({ timestamp: 2 }),
      screenshotEvent({ toolUseId: 'screenshot-2', imageContent: [image('second')] }),
    ];

    expect(extractAppScreenshotImages(events)).toEqual([image(), image('second')]);
  });

  it('falls back to saved app screenshot paths when historical end events lost the tool name', () => {
    const event = screenshotEvent({
      toolName: 'call_123',
      detail: '{"path":".rebel/screenshots/260430_143625_dark_actions-review.png"}',
    });

    expect(extractAppScreenshotImages([event])).toEqual([image()]);
  });
});

describe('extractAppScreenshotEvents', () => {
  it('returns ref-bearing slices for ref-only events', () => {
    const event = screenshotEvent({
      imageContent: undefined,
      imageRef: [refOf('asset-1')],
    });
    const slices = extractAppScreenshotEvents([event]);
    expect(slices).toHaveLength(1);
    expect(slices[0].imageRef).toEqual([refOf('asset-1')]);
    expect(slices[0].imageContent).toBeUndefined();
  });

  it('preserves positional null slots for failed refs', () => {
    const event = screenshotEvent({
      imageContent: undefined,
      imageRef: [refOf('a'), null, refOf('c')],
    });
    const slices = extractAppScreenshotEvents([event]);
    expect(slices[0].imageRef).toEqual([refOf('a'), null, refOf('c')]);
  });

  it('returns mixed slices when an event has both refs and legacy content', () => {
    const event = screenshotEvent({
      imageContent: [image('legacy-bytes')],
      imageRef: [refOf('asset-1')],
    });
    const slices = extractAppScreenshotEvents([event]);
    expect(slices[0].imageContent).toEqual([image('legacy-bytes')]);
    expect(slices[0].imageRef).toEqual([refOf('asset-1')]);
  });

  it('dedupes whole events whose refs and legacy bytes are entirely already-seen', () => {
    const slices = extractAppScreenshotEvents([
      screenshotEvent({ imageContent: undefined, imageRef: [refOf('shared')] }),
      screenshotEvent({ timestamp: 2, imageContent: undefined, imageRef: [refOf('shared')] }),
    ]);
    expect(slices).toHaveLength(1);
  });

  it('keeps a new event when only some of its assets are novel', () => {
    const slices = extractAppScreenshotEvents([
      screenshotEvent({ imageContent: undefined, imageRef: [refOf('one')] }),
      screenshotEvent({
        toolUseId: 'screenshot-2',
        timestamp: 2,
        imageContent: undefined,
        imageRef: [refOf('one'), refOf('two')],
      }),
    ]);
    expect(slices).toHaveLength(2);
    expect(slices[1].imageRef).toEqual([refOf('one'), refOf('two')]);
  });

  it('ignores non-screenshot tool events', () => {
    const slices = extractAppScreenshotEvents([
      screenshotEvent({ toolName: 'Read', detail: '{"path":"notes/demo.png"}' }),
    ]);
    expect(slices).toEqual([]);
  });
});
