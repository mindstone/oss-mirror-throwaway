import { describe, it, expect } from 'vitest';
import { imageGridSourceFromEvent, imageGridSourceFromImageBlocks } from '../imageGridSource';
import type { ImageContentBlock, ImageRef } from '@shared/types';
import { sanitizeEventForMainAccumulation } from '@shared/utils/eventSanitization';

const refOf = (assetId: string, overrides: Partial<ImageRef> = {}): ImageRef => ({
  assetId,
  mimeType: 'image/png',
  byteSize: 12345,
  ...overrides,
});

const blockOf = (data = 'AAAA', mimeType = 'image/png'): ImageContentBlock => ({
  type: 'image',
  data,
  mimeType,
});

describe('imageGridSourceFromEvent', () => {
  it('returns empty array when both fields are missing', () => {
    expect(imageGridSourceFromEvent({}, 'session-1')).toEqual([]);
  });

  it('prefers imageRef when present', () => {
    const items = imageGridSourceFromEvent(
      {
        imageContent: [blockOf('legacy-bytes')],
        imageRef: [refOf('turn-1-0-0')],
      },
      'session-A',
    );
    expect(items).toHaveLength(1);
    expect(items[0].tileSrc).toContain('rebel-asset://session/session-A/turn-1-0-0');
    expect(items[0].tileSrc).toContain('thumb=1');
    expect(items[0].fullSrc).not.toContain('thumb=1');
    expect(items[0].fullSrc).toContain('rebel-asset://session/session-A/turn-1-0-0');
  });

  it('falls back to legacy bytes when a positional ref is null', () => {
    const items = imageGridSourceFromEvent(
      {
        imageContent: [blockOf('alpha'), blockOf('beta')],
        imageRef: [null, refOf('turn-1-0-1')],
      },
      'session-A',
    );
    expect(items).toHaveLength(2);
    expect(items[0].tileSrc.startsWith('data:image/png;base64,')).toBe(true);
    expect(items[1].tileSrc).toContain('rebel-asset://session/session-A/turn-1-0-1');
  });

  it('uses data URL fallback when sessionId is missing even if refs exist', () => {
    const items = imageGridSourceFromEvent(
      {
        imageContent: [blockOf('a'), blockOf('b')],
        imageRef: [refOf('asset-1'), refOf('asset-2')],
      },
      undefined,
    );
    expect(items).toHaveLength(2);
    expect(items[0].tileSrc.startsWith('data:image/png;base64,')).toBe(true);
    expect(items[1].tileSrc.startsWith('data:image/png;base64,')).toBe(true);
  });

  it('maps uploadStatus pending → loading and missing → failed', () => {
    const items = imageGridSourceFromEvent(
      {
        imageRef: [
          refOf('p', { uploadStatus: 'pending' }),
          refOf('m', { uploadStatus: 'missing' }),
          refOf('u', { uploadStatus: 'uploaded' }),
        ],
      },
      'session-1',
    );
    expect(items[0].state).toBe('loading');
    expect(items[1].state).toBe('failed');
    expect(items[2].state).toBe('ready');
  });

  it('produces stable keys for refs and legacy fallback', () => {
    const items = imageGridSourceFromEvent(
      {
        imageContent: [blockOf('a'), blockOf('b')],
        imageRef: [refOf('alpha'), null],
      },
      'sess',
      { keyPrefix: 'tool-1' },
    );
    expect(items[0].key).toContain('ref:alpha');
    expect(items[1].key).toContain('legacy:1');
    expect(items[0].key.startsWith('tool-1:')).toBe(true);
  });

  it('emits a failed positional tile when imageRef[i] is null and no legacy bytes are present', () => {
    const items = imageGridSourceFromEvent(
      {
        imageRef: [refOf('alpha'), null, refOf('gamma')],
      },
      'session-A',
    );
    expect(items).toHaveLength(3);
    expect(items[0].state).toBe('ready');
    expect(items[1].state).toBe('failed');
    expect(items[1].tileSrc).toBe('');
    expect(items[1].alt).toBe('Image unavailable');
    expect(items[1].key).toContain('failed:1');
    expect(items[2].state).toBe('ready');
  });

  it('preserves a middle legacy fallback slot after sanitization round-trip for [ref, null, ref]', () => {
    const sanitized = sanitizeEventForMainAccumulation({
      type: 'tool',
      toolName: 'screenshot',
      detail: 'captured',
      stage: 'end',
      timestamp: Date.now(),
      imageContent: [blockOf('a'), blockOf('b'), blockOf('c')],
      imageRef: [refOf('asset-0'), null, refOf('asset-2')],
    });

    expect(sanitized.type).toBe('tool');
    if (sanitized.type !== 'tool') return;

    const items = imageGridSourceFromEvent(
      {
        imageContent: sanitized.imageContent,
        imageRef: sanitized.imageRef,
      },
      'session-roundtrip',
    );

    expect(items).toHaveLength(3);
    expect(items[0].tileSrc).toContain('rebel-asset://session/session-roundtrip/asset-0');
    expect(items[1].tileSrc).toBe('data:image/png;base64,b');
    expect(items[2].tileSrc).toContain('rebel-asset://session/session-roundtrip/asset-2');
  });
});

describe('imageGridSourceFromImageBlocks', () => {
  it('returns empty array on missing or empty input', () => {
    expect(imageGridSourceFromImageBlocks(undefined)).toEqual([]);
    expect(imageGridSourceFromImageBlocks([])).toEqual([]);
  });

  it('maps blocks to data-URL grid items', () => {
    const items = imageGridSourceFromImageBlocks([blockOf('hello'), blockOf('world', 'image/jpeg')]);
    expect(items).toHaveLength(2);
    expect(items[0].tileSrc).toBe('data:image/png;base64,hello');
    expect(items[1].tileSrc).toBe('data:image/jpeg;base64,world');
  });
});
