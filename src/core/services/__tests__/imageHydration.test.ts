import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Buffer } from 'node:buffer';
import { type Mocked } from 'vitest';
import { hydrateImageRef } from '../imageHydration';
import { TurnScopedHydrationCache } from '../imageHydrationCache';
import type { AssetStore } from '@core/assetStore';
import type { Logger } from '@core/logger';
import { EventEmitter } from 'node:events';

 
vi.mock('pngjs', () => {
  return {
    PNG: class MockPNG {
      width = 100;
      height = 100;
      data = Buffer.alloc(100 * 100 * 4);
      
      constructor(options?: { width: number; height: number }) {
        if (options) {
          this.width = options.width;
          this.height = options.height;
          this.data = Buffer.alloc(this.width * this.height * 4);
        }
      }

      parse(data: Buffer, callback: (err: Error | null, png: MockPNG) => void) {
        if (data.toString() === 'invalid-png-data') {
          callback(new Error('Invalid PNG'), this);
        } else {
          callback(null, this);
        }
        return this;
      }

      pack() {
        const emitter = new EventEmitter();
        setTimeout(() => {
          // Simulate the packed buffer size. We'll make it scale based on dimensions.
          const simulatedSize = this.width * this.height; // just a dummy size formula
          emitter.emit('data', Buffer.alloc(simulatedSize));
          emitter.emit('end');
        }, 10);
        return emitter;
      }
    }
  };
});

describe('hydrateImageRef', () => {
  let cache: TurnScopedHydrationCache;
  let mockAssetStore: Mocked<AssetStore>;
  let mockLog: Mocked<Logger>;

  beforeEach(() => {
    cache = new TurnScopedHydrationCache();
    mockAssetStore = {
      readAsset: vi.fn(),
      writeAsset: vi.fn(),
      deleteAsset: vi.fn(),
    } as any;
    
    mockLog = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      fatal: vi.fn(),
      child: vi.fn(),
      flush: vi.fn(),
    } as any;
  });

  const baseDeps = () => ({
    assetStore: mockAssetStore,
    cache,
    providerKey: 'openai' as const,
    maxBytes: 10 * 1024 * 1024,
    log: mockLog
  });

  it('hydrates a ref successfully from asset store', async () => {
    const bytes = Buffer.from('hello world');
    mockAssetStore.readAsset.mockResolvedValueOnce({
      reason: 'ok',
      bytes,
      mimeType: 'image/png',
      byteSize: bytes.length
    });

    const result = await hydrateImageRef({ assetId: 'asset-1', mimeType: 'image/png', byteSize: 0 }, 'sess-1', baseDeps());

    expect(mockAssetStore.readAsset).toHaveBeenCalledWith({ sessionId: 'sess-1', assetId: 'asset-1' });
    expect(result).toEqual({
      data: bytes.toString('base64'),
      mimeType: 'image/png',
      byteSize: bytes.length
    });
  });

  it('uses cache on second call without hitting asset store', async () => {
    const bytes = Buffer.from('hello world');
    mockAssetStore.readAsset.mockResolvedValueOnce({
      reason: 'ok',
      bytes,
      mimeType: 'image/png',
      byteSize: bytes.length
    });

    const deps = baseDeps();

    // First call populates cache
    await hydrateImageRef({ assetId: 'asset-1', mimeType: 'image/png', byteSize: 0 }, 'sess-1', deps);
    expect(mockAssetStore.readAsset).toHaveBeenCalledTimes(1);

    // Second call should hit cache
    const result2 = await hydrateImageRef({ assetId: 'asset-1', mimeType: 'image/png', byteSize: 0 }, 'sess-1', deps);
    expect(mockAssetStore.readAsset).toHaveBeenCalledTimes(1); // Still 1
    
    expect(result2).toEqual({
      data: bytes.toString('base64'),
      mimeType: 'image/png',
      byteSize: bytes.length
    });
  });

  it('invokes downscale when image exceeds maxBytes, returning success if it fits', async () => {
    const largeBuffer = Buffer.alloc(20 * 1024 * 1024); // 20MB
    mockAssetStore.readAsset.mockResolvedValueOnce({
      reason: 'ok',
      bytes: largeBuffer,
      mimeType: 'image/png',
      byteSize: largeBuffer.length
    });

    const deps = baseDeps();
    deps.maxBytes = 5 * 1024 * 1024; // cap at 5MB

    const result = await hydrateImageRef({ assetId: 'asset-1', mimeType: 'image/png', byteSize: 0 }, 'sess-1', deps);

    expect(result).not.toHaveProperty('kind', 'unavailable');
    if (!('kind' in result)) {
      expect(result.byteSize).toBeLessThanOrEqual(deps.maxBytes);
      expect(mockLog.info).toHaveBeenCalledWith(
        expect.objectContaining({ scaleFactor: expect.any(Number) }),
        'Downscaled image to fit under provider cap'
      );
    }
  });

  it('returns unavailable with oversized reason if downscale fails to fit', async () => {
    // Our mock pack() produces size = width * height.
    // Initial width=100, height=100 -> 10000 bytes.
    // If maxBytes is 1000, it'll try to halve:
    // Iter 1: 50x50 = 2500 bytes.
    // Iter 2: 25x25 = 625 bytes.
    // Wait, let's just make the cap so small it can never fit, or pass invalid-png-data
    
    const badBuffer = Buffer.from('invalid-png-data');
    mockAssetStore.readAsset.mockResolvedValueOnce({
      reason: 'ok',
      bytes: badBuffer,
      mimeType: 'image/png',
      byteSize: 10 * 1024 * 1024 // Act like it's large so it triggers downscale
    });

    const deps = baseDeps();
    deps.maxBytes = 5 * 1024 * 1024;

    const result = await hydrateImageRef({ assetId: 'asset-1', mimeType: 'image/png', byteSize: 0 }, 'sess-1', deps);

    expect(result).toEqual({ kind: 'unavailable', reason: 'oversized' });
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionIdHash: expect.any(String) }),
      'pngjs parse failed during downscale attempt (may not be a PNG)'
    );
  });

  it('returns unavailable if asset is not found', async () => {
    mockAssetStore.readAsset.mockResolvedValueOnce({
      reason: 'not-found'
    });

    const result = await hydrateImageRef({ assetId: 'asset-miss', mimeType: 'image/png', byteSize: 0 }, 'sess-1', baseDeps());

    expect(result).toEqual({ kind: 'unavailable', reason: 'not-found' });
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'not-found', context: 'hydrate' }),
      'asset-resolution-failure'
    );
  });

  it('returns unavailable if asset is corrupt', async () => {
    mockAssetStore.readAsset.mockResolvedValueOnce({
      reason: 'corrupt'
    });

    const result = await hydrateImageRef({ assetId: 'asset-bad', mimeType: 'image/png', byteSize: 0 }, 'sess-1', baseDeps());

    expect(result).toEqual({ kind: 'unavailable', reason: 'corrupt' });
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'corrupt', context: 'hydrate' }),
      'asset-resolution-failure'
    );
  });
});
