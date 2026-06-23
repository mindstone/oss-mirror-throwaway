import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleRebelAssetProtocol } from '../services/rebelAssetProtocol';
import type { AssetStoreReadResult } from '@core/assetStore';
import { createHash } from 'crypto';
import { hashSessionIdForBreadcrumb } from '@shared/utils/hashSessionIdForBreadcrumb';

const { mockLog } = vi.hoisted(() => ({
  mockLog: {
    warn: vi.fn(),
  },
}));

 
vi.mock('@core/logger', () => ({
  createScopedLogger: vi.fn(() => mockLog),
}));

const mockReadAsset = vi.fn<(params: { sessionId: string; assetId: string }) => Promise<AssetStoreReadResult>>();
 
vi.mock('@core/assetStore', () => ({
  getAssetStore: () => ({
    readAsset: mockReadAsset,
  }),
}));

const EXPECTED_CSP = "default-src 'none'; script-src 'none'; object-src 'none'; base-uri 'none'; img-src 'self'; style-src 'none'";

describe('handleRebelAssetProtocol', () => {
  beforeEach(() => {
    mockReadAsset.mockReset();
    mockLog.warn.mockReset();
  });

  const getResponseData = async (response: Response) => {
    if (!response.body) return null;
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  };

  it('Valid URL → bytes, correct headers, ETag', async () => {
    const mockBytes = Buffer.from('mock-asset-bytes');
    mockReadAsset.mockResolvedValueOnce({
      reason: 'ok',
      bytes: mockBytes,
      mimeType: 'image/png',
      byteSize: mockBytes.length,
    });

    const request = new Request('rebel-asset://session/sess1/asset1');
    const response = await handleRebelAssetProtocol(request);

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/png');
    expect(response.headers.get('Content-Security-Policy')).toBe(EXPECTED_CSP);
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('ETag')).toBe('"asset1"');
    
    const body = await getResponseData(response);
    expect(body?.equals(mockBytes)).toBe(true);

    expect(mockReadAsset).toHaveBeenCalledWith({ sessionId: 'sess1', assetId: 'asset1' });
  });

  it('Thumbnail URL with existing thumbnail → returns thumbnail bytes', async () => {
    const mockThumbBytes = Buffer.from('mock-thumb-bytes');
    mockReadAsset.mockResolvedValueOnce({
      reason: 'ok',
      bytes: mockThumbBytes,
      mimeType: 'image/png',
      byteSize: mockThumbBytes.length,
    });

    const request = new Request('rebel-asset://session/sess1/asset1?thumb=1');
    const response = await handleRebelAssetProtocol(request);

    expect(response.status).toBe(200);
    const body = await getResponseData(response);
    expect(body?.equals(mockThumbBytes)).toBe(true);

    expect(mockReadAsset).toHaveBeenCalledWith({ sessionId: 'sess1', assetId: 'asset1_thumb' });
    expect(mockReadAsset).toHaveBeenCalledTimes(1);
  });

  it('Thumbnail URL with missing thumbnail → falls back to full size', async () => {
    const mockFullBytes = Buffer.from('mock-full-bytes');
    mockReadAsset.mockResolvedValueOnce({ reason: 'not-found' });
    mockReadAsset.mockResolvedValueOnce({
      reason: 'ok',
      bytes: mockFullBytes,
      mimeType: 'image/png',
      byteSize: mockFullBytes.length,
    });

    const request = new Request('rebel-asset://session/sess1/asset1?thumb=1');
    const response = await handleRebelAssetProtocol(request);

    expect(response.status).toBe(200);
    const body = await getResponseData(response);
    expect(body?.equals(mockFullBytes)).toBe(true);

    expect(mockReadAsset).toHaveBeenNthCalledWith(1, { sessionId: 'sess1', assetId: 'asset1_thumb' });
    expect(mockReadAsset).toHaveBeenNthCalledWith(2, { sessionId: 'sess1', assetId: 'asset1' });
  });

  it('Missing asset → 404', async () => {
    mockReadAsset.mockResolvedValueOnce({ reason: 'not-found' });

    const request = new Request('rebel-asset://session/sess1/missing');
    const response = await handleRebelAssetProtocol(request);

    expect(response.status).toBe(404);
    expect(response.headers.get('Content-Security-Policy')).toBe(EXPECTED_CSP);
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('Bad sessionId (traversal, invalid charset) → 400', async () => {
    // using characters that fail the regex
    const request = new Request('rebel-asset://session/in^valid123/asset1');
    const response = await handleRebelAssetProtocol(request);

    expect(response.status).toBe(400);
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({ 
        sessionIdHash: createHash('sha256').update('in^valid123').digest('hex').substring(0, 8), 
        assetIdSuffix: 'too-short' 
      }),
      'rebel-asset: Invalid URL charset or length'
    );
    expect(mockReadAsset).not.toHaveBeenCalled();
  });

  it('Bad assetId → 400', async () => {
    const request = new Request('rebel-asset://session/sess1/in^valid123!');
    const response = await handleRebelAssetProtocol(request);

    expect(response.status).toBe(400);
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({ 
        sessionIdHash: 'too-short', 
        assetIdSuffix: 'alid123!' 
      }),
      'rebel-asset: Invalid URL charset or length'
    );
    expect(mockReadAsset).not.toHaveBeenCalled();
  });

  it('Wrong host → 400', async () => {
    const request = new Request('rebel-asset://other/sess/asset');
    const response = await handleRebelAssetProtocol(request);

    expect(response.status).toBe(400);
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'other' }),
      'rebel-asset: Invalid host, expected "session"'
    );
    expect(mockReadAsset).not.toHaveBeenCalled();
  });

  it('Tampered file (asset store returns corrupt reason) → 415', async () => {
    mockReadAsset.mockResolvedValueOnce({ reason: 'corrupt' });

    const request = new Request('rebel-asset://session/sess1/asset1');
    const response = await handleRebelAssetProtocol(request);

    expect(response.status).toBe(415);
    expect(response.headers.get('Content-Security-Policy')).toBe(EXPECTED_CSP);
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('Permission-denied (asset store returns that reason) → 403', async () => {
    mockReadAsset.mockResolvedValueOnce({ reason: 'permission-denied' });

    const request = new Request('rebel-asset://session/sess1/asset1');
    const response = await handleRebelAssetProtocol(request);

    expect(response.status).toBe(403);
    expect(response.headers.get('Content-Security-Policy')).toBe(EXPECTED_CSP);
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });
  
  it('Oversized (asset store returns that reason) → 413', async () => {
    mockReadAsset.mockResolvedValueOnce({ reason: 'oversized' });

    const request = new Request('rebel-asset://session/sess1/asset1');
    const response = await handleRebelAssetProtocol(request);

    expect(response.status).toBe(413);
  });

  it('Log redaction: assert no raw sessionId or assetId leaks in URL parsing logs', async () => {
    mockReadAsset.mockResolvedValueOnce({
      reason: 'not-found'
    });
    const request = new Request('rebel-asset://session/sensitivesession123/sensitiveasset456');
    // Valid URL + missing asset should emit structured Stage 9 observability log.
    await handleRebelAssetProtocol(request);
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'not-found',
        context: 'protocol',
      }),
      'asset-resolution-failure',
    );
    mockLog.warn.mockClear();

    // Now test a structural error to verify redaction
    const request2 = new Request('rebel-asset://session/sensitivesession123/sensitiveasset456/extra');
    await handleRebelAssetProtocol(request2);
    
    // Check that we logged the structured url Path but not the raw IDs explicitly
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        partsCount: 3,
        urlPath: '/sensitivesession123/sensitiveasset456/extra'
      }),
      'rebel-asset: Invalid path structure, expected /{sessionId}/{assetId}'
    );
  });

  // NEW TESTS FOR STAGE 3 REFINEMENT

  it('Bad URL (malformed scheme) → 400 with security headers', async () => {
    const request = { url: 'not a url' } as Request;
    const response = await handleRebelAssetProtocol(request);

    expect(response.status).toBe(400);
    expect(response.headers.get('Content-Security-Policy')).toBe(EXPECTED_CSP);
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(mockLog.warn).toHaveBeenCalledWith({ reason: 'malformed-url' }, 'rebel-asset: Invalid URL encoding');
  });

  it('CSP doesn\'t include style-src \'unsafe-inline\' or data:', async () => {
    mockReadAsset.mockResolvedValueOnce({
      reason: 'ok',
      bytes: Buffer.from('mock'),
      mimeType: 'image/png',
      byteSize: 4,
    });
    const request = new Request('rebel-asset://session/sess1/asset1');
    const response = await handleRebelAssetProtocol(request);
    
    const csp = response.headers.get('Content-Security-Policy');
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('data:');
    expect(csp).toBe(EXPECTED_CSP);
  });

  it('URL with malformed percent-encoding (%E0%80) → 400 with security headers, structured log', async () => {
    const request = new Request('rebel-asset://session/%E0%80/asset1');
    const response = await handleRebelAssetProtocol(request);

    expect(response.status).toBe(400);
    expect(response.headers.get('Content-Security-Policy')).toBe(EXPECTED_CSP);
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(mockLog.warn).toHaveBeenCalledWith({ reason: 'malformed-encoding' }, 'rebel-asset: Invalid URL path encoding');
  });

  it('URL with wrong scheme → 400 with security headers', async () => {
    const request = new Request('https://session/sess1/asset1');
    const response = await handleRebelAssetProtocol(request);

    expect(response.status).toBe(400);
    expect(response.headers.get('Content-Security-Policy')).toBe(EXPECTED_CSP);
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(mockLog.warn).toHaveBeenCalledWith({ reason: 'invalid-scheme' }, 'rebel-asset: Invalid scheme');
  });

  it('Handler receives ok result with disallowed MIME → 415 with security headers, structured log', async () => {
    mockReadAsset.mockResolvedValueOnce({
      reason: 'ok',
      bytes: Buffer.from('mock'),
      mimeType: 'image/svg+xml', // Disallowed
      byteSize: 4,
    });
    
    const sessionId = 'sensitivesession123';
    const assetId = 'sensitiveasset456';
    const request = new Request(`rebel-asset://session/${sessionId}/${assetId}`);
    const response = await handleRebelAssetProtocol(request);

    expect(response.status).toBe(415);
    expect(response.headers.get('Content-Security-Policy')).toBe(EXPECTED_CSP);
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionIdHash: hashSessionIdForBreadcrumb(sessionId),
        assetIdHash: hashSessionIdForBreadcrumb(assetId),
        assetIdSuffix: assetId.slice(-8),
        reason: 'mime-rejected',
        context: 'protocol',
        mimeType: 'image/svg+xml',
      }),
      'asset-resolution-failure',
    );
  });
});
