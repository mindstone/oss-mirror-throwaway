import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CloudClientError, clearConfig, configure } from '../cloudClient';
import { mapImageRef } from '../imageRefMapper';
import type { ImageRef } from '../types';

const SESSION_ID = 'sess-abc';
const BASE_REF: ImageRef = {
  assetId: 'asset-xyz',
  mimeType: 'image/png',
  byteSize: 1234,
};

describe('mapImageRef', () => {
  beforeEach(() => {
    clearConfig();
  });
  afterEach(() => {
    clearConfig();
  });

  it('maps a ref to the configured cloud asset URL', () => {
    configure({ cloudUrl: 'https://cloud.example.com', token: 'tok-1' });
    const mapped = mapImageRef(BASE_REF, SESSION_ID);
    expect(mapped.url).toBe(
      'https://cloud.example.com/api/sessions/sess-abc/assets/asset-xyz',
    );
    expect(mapped.headers?.Authorization).toBe('Bearer tok-1');
    expect(mapped.rnSource.uri).toBe(mapped.url);
    expect(mapped.rnSource.headers).toEqual({ Authorization: 'Bearer tok-1' });
  });

  it('appends ?thumb=1 when thumb is requested', () => {
    configure({ cloudUrl: 'https://cloud.example.com', token: 'tok-1' });
    const mapped = mapImageRef(BASE_REF, SESSION_ID, { thumb: true });
    expect(mapped.url).toBe(
      'https://cloud.example.com/api/sessions/sess-abc/assets/asset-xyz?thumb=1',
    );
  });

  it('preserves unknown ref fields (D3 forward-compat passthrough)', () => {
    configure({ cloudUrl: 'https://cloud.example.com', token: 'tok-1' });
    const refWithFuture: ImageRef = {
      ...BASE_REF,
      width: 800,
      height: 600,
      thumbnailAssetId: 'asset-xyz-thumb',
      ['someFutureField' as string]: { provenance: 'agent-run-42' },
    };
    const mapped = mapImageRef(refWithFuture, SESSION_ID);
    expect(mapped.ref).toBe(refWithFuture);
    expect((mapped.ref as Record<string, unknown>).someFutureField).toEqual({
      provenance: 'agent-run-42',
    });
    expect(mapped.ref.width).toBe(800);
    expect(mapped.ref.height).toBe(600);
    expect(mapped.ref.thumbnailAssetId).toBe('asset-xyz-thumb');
  });

  it('throws cloud-client-not-configured when no config and no override', () => {
    expect(() => mapImageRef(BASE_REF, SESSION_ID)).toThrow(CloudClientError);
    try {
      mapImageRef(BASE_REF, SESSION_ID);
    } catch (err) {
      expect((err as CloudClientError).code).toBe('cloud-client-not-configured');
    }
  });

  it('accepts an explicit cloudUrl override when not configured', () => {
    const mapped = mapImageRef(BASE_REF, SESSION_ID, {
      cloudUrl: 'https://override.example.com/',
      token: 'override-token',
    });
    expect(mapped.url).toBe(
      'https://override.example.com/api/sessions/sess-abc/assets/asset-xyz',
    );
    expect(mapped.headers?.Authorization).toBe('Bearer override-token');
  });

  it('omits Authorization header when no token is available', () => {
    const mapped = mapImageRef(BASE_REF, SESSION_ID, {
      cloudUrl: 'https://override.example.com',
    });
    expect(mapped.headers).toBeUndefined();
    expect(mapped.rnSource.headers).toBeUndefined();
  });

  it('encodes session and asset ids safely', () => {
    configure({ cloudUrl: 'https://cloud.example.com', token: 'tok-1' });
    const mapped = mapImageRef(
      { ...BASE_REF, assetId: 'asset/with?special' },
      'sess/with?special',
    );
    expect(mapped.url).toBe(
      'https://cloud.example.com/api/sessions/sess%2Fwith%3Fspecial/assets/asset%2Fwith%3Fspecial',
    );
  });
});
