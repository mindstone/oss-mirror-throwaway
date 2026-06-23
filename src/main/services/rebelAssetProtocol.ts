// CORE-MOVE-EXEMPT: Electron custom protocol handler
import { createHash } from 'crypto';
import { getAssetStore } from '@core/assetStore';
import { createScopedLogger } from '@core/logger';
import { recordAssetResolutionFailure } from '@core/services/assetResolutionObservability';
import { ALLOWED_IMAGE_MIME_TYPES } from '@shared/markdownImageAssets';

const logger = createScopedLogger({ service: 'rebelAssetProtocol' });

function createBaseSecurityHeaders(): HeadersInit {
  return {
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; script-src 'none'; object-src 'none'; base-uri 'none'; img-src 'self'; style-src 'none'",
  };
}

function hashSessionId(id: string): string {
  return createHash('sha256').update(id).digest('hex').substring(0, 8);
}

export async function handleRebelAssetProtocol(request: Request): Promise<Response> {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    logger.warn({ reason: 'malformed-url' }, 'rebel-asset: Invalid URL encoding');
    return new Response('Bad request', { status: 400, headers: createBaseSecurityHeaders() });
  }

  if (url.protocol !== 'rebel-asset:') {
    logger.warn({ reason: 'invalid-scheme' }, 'rebel-asset: Invalid scheme');
    return new Response('Bad request', { status: 400, headers: createBaseSecurityHeaders() });
  }

  if (url.host !== 'session') {
    logger.warn({ urlPath: url.pathname, host: url.host, partsCount: url.pathname.split('/').length }, 'rebel-asset: Invalid host, expected "session"');
    return new Response('Bad request', { status: 400, headers: createBaseSecurityHeaders() });
  }

  let pathPart: string;
  try {
    pathPart = decodeURIComponent(url.pathname).replace(/^\//, '');
  } catch {
    logger.warn({ reason: 'malformed-encoding' }, 'rebel-asset: Invalid URL path encoding');
    return new Response('Bad request', { status: 400, headers: createBaseSecurityHeaders() });
  }

  const parts = pathPart.split('/');
  
  if (parts.length !== 2) {
    logger.warn({ urlPath: url.pathname, host: url.host, partsCount: parts.length }, 'rebel-asset: Invalid path structure, expected /{sessionId}/{assetId}');
    return new Response('Bad request', { status: 400, headers: createBaseSecurityHeaders() });
  }

  const [sessionId, baseAssetId] = parts;
  
  const SAFE_ID_REGEX = /^[a-z0-9_-]{1,128}$/;
  if (!SAFE_ID_REGEX.test(sessionId) || !SAFE_ID_REGEX.test(baseAssetId)) {
    const redactedSessionId = sessionId.length >= 8 ? hashSessionId(sessionId) : 'too-short';
    const redactedAssetId = baseAssetId.length >= 8 ? baseAssetId.slice(-8) : 'too-short';
    
    logger.warn({ sessionIdHash: redactedSessionId, assetIdSuffix: redactedAssetId }, 'rebel-asset: Invalid URL charset or length');
    return new Response('Bad request', { status: 400, headers: createBaseSecurityHeaders() });
  }

  const isThumb = url.searchParams.get('thumb') === '1';
  const targetAssetId = isThumb ? `${baseAssetId}_thumb` : baseAssetId;

  let result = await getAssetStore().readAsset({ sessionId, assetId: targetAssetId });
  
  // Fallback to full-size if thumbnail doesn't exist
  if (isThumb && result.reason === 'not-found') {
    result = await getAssetStore().readAsset({ sessionId, assetId: baseAssetId });
  }

  const baseHeaders = createBaseSecurityHeaders();

  if (result.reason === 'ok') {
    if (!ALLOWED_IMAGE_MIME_TYPES.includes(result.mimeType as (typeof ALLOWED_IMAGE_MIME_TYPES)[number])) {
      recordAssetResolutionFailure({
        sessionId,
        assetId: baseAssetId,
        reason: 'mime-rejected',
        context: 'protocol',
        metadata: {
          mimeType: result.mimeType,
          thumb: isThumb,
          sessionIdHash: hashSessionId(sessionId),
          assetIdSuffix: baseAssetId.slice(-8),
        },
        log: logger,
      });
      return new Response(null, { status: 415, headers: baseHeaders });
    }

    return new Response(result.bytes as unknown as BodyInit, {
      status: 200,
      headers: {
        ...baseHeaders,
        'Content-Type': result.mimeType,
        'Cache-Control': 'no-cache',
        'ETag': `"${baseAssetId}"`,
        'Content-Length': String(result.byteSize),
      },
    });
  }

  // Handled failure cases (logging already done by readAsset except for URL structure)
  recordAssetResolutionFailure({
    sessionId,
    assetId: baseAssetId,
    reason: result.reason,
    context: 'protocol',
    metadata: { thumb: isThumb, targetAssetId },
    log: logger,
  });

  if (result.reason === 'not-found') {
    return new Response(null, { status: 404, headers: baseHeaders });
  }
  if (result.reason === 'permission-denied') {
    return new Response(null, { status: 403, headers: baseHeaders });
  }
  if (result.reason === 'mime-rejected' || result.reason === 'corrupt') {
    return new Response(null, { status: 415, headers: baseHeaders });
  }
  if (result.reason === 'oversized') {
    return new Response(null, { status: 413, headers: baseHeaders });
  }

  return new Response(null, { status: 500, headers: baseHeaders });
}
