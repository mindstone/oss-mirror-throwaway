// cloud-client/src/imageRefMapper.ts — Map ImageRef to a renderable cloud URL.
//
// Counterpart to desktop's `rebel-asset://` protocol (src/main/services/rebelAssetProtocol.ts).
// Used by mobile / web-companion to resolve cross-surface image refs through the
// Stage 7b GET /api/sessions/:sessionId/assets/:assetId route.
//
// D3 forward-compat: the mapped output retains the original `ref` unchanged so
// future additive `ImageRef` fields propagate without code changes here.
//
// @see docs/plans/260516_image_asset_architecture.md § Stage 7b

import type { ImageRef } from './types';
import { CloudClientError, getCloudClientConfig } from './cloudClient';

export interface MappedImageRef {
  /** Authenticated cloud asset URL (token-bearing). */
  url: string;
  /** Headers to pass to fetch-based clients (web/cloud-client). */
  headers?: { Authorization?: string };
  /**
   * React Native `<Image source>` shape. RN's `<Image>` can accept
   * `headers` directly, so we mirror the same Authorization header here.
   */
  rnSource: { uri: string; headers?: Record<string, string> };
  /**
   * Pass-through of the original ref. Preserves any unknown fields per the
   * additive ImageRef schema policy (D3).
   */
  ref: ImageRef;
}

export interface MapImageRefOptions {
  /** When true, requests the thumbnail variant via `?thumb=1`. */
  thumb?: boolean;
  /** Overrides the configured cloud base URL. */
  cloudUrl?: string;
  /** Overrides the configured bearer token. */
  token?: string;
}

/**
 * Build a renderable cloud asset URL for an {@link ImageRef}.
 *
 * Throws {@link CloudClientError} with code `cloud-client-not-configured`
 * when neither an explicit `cloudUrl` is provided nor `configure()` has been
 * called.
 */
export function mapImageRef(
  ref: ImageRef,
  sessionId: string,
  options: MapImageRefOptions = {},
): MappedImageRef {
  const config = getCloudClientConfig();
  const cloudUrl = options.cloudUrl ?? config?.cloudUrl;
  if (!cloudUrl) {
    throw new CloudClientError(
      'Cloud client is not configured; call configure() or pass cloudUrl explicitly.',
      undefined,
      undefined,
      'cloud-client-not-configured',
    );
  }

  const token = options.token ?? config?.token;
  const normalizedBase = cloudUrl.replace(/\/+$/, '');
  const path =
    `/api/sessions/${encodeURIComponent(sessionId)}/assets/${encodeURIComponent(ref.assetId)}`;
  const url = options.thumb ? `${normalizedBase}${path}?thumb=1` : `${normalizedBase}${path}`;

  const headers: { Authorization?: string } | undefined = token
    ? { Authorization: `Bearer ${token}` }
    : undefined;

  const rnSource: { uri: string; headers?: Record<string, string> } = headers
    ? { uri: url, headers: { Authorization: headers.Authorization as string } }
    : { uri: url };

  const mapped: MappedImageRef = {
    url,
    rnSource,
    ref,
  };
  if (headers) {
    mapped.headers = headers;
  }
  return mapped;
}
