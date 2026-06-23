import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { clearConfig, configure, deleteSession } from '../cloudClient';
import type { AssetResolutionReason, ImageRef } from '../index';

const TEST_URL = 'https://test.example.com';
const TEST_TOKEN = 'test-token';

describe('cloudClient CLI surface header', () => {
  beforeEach(() => {
    clearConfig();
    configure({ cloudUrl: TEST_URL, token: TEST_TOKEN });
    vi.restoreAllMocks();
  });

  afterEach(() => {
    clearConfig();
  });

  it('sends X-Rebel-Surface: cli when deleteSession is called with surface=cli', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ success: true }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await deleteSession('session-1', 'cli');

    expect(mockFetch).toHaveBeenCalledWith(
      `${TEST_URL}/api/sessions/session-1`,
      expect.objectContaining({
        method: 'DELETE',
        headers: expect.objectContaining({
          'X-Rebel-Surface': 'cli',
        }),
      }),
    );
  });

  it('exposes ImageRef and AssetResolutionReason from the public type surface', () => {
    const ref: ImageRef = {
      assetId: 'asset-1',
      mimeType: 'image/png',
      byteSize: 1234,
      uploadStatus: 'uploaded',
    };
    const reason: AssetResolutionReason = 'not-found';

    expect(ref.assetId).toBe('asset-1');
    expect(reason).toBe('not-found');
    expectTypeOf<ImageRef['mimeType']>().toEqualTypeOf<string>();
  });
});
