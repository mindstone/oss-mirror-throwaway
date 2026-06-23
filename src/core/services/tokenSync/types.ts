import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';

export type TokenFileMetadata = {
  expiryEpochMs: number;
  mtimeMs: number;
  surfaceWrote: 'desktop' | 'cloud';
};

export type TokenSyncEvent =
  | {
      kind: 'local_write';
      provider: string;
      accountKey: string;
      relativePath: string;
      metadata: TokenFileMetadata;
    }
  | {
      kind: 'peer_signal';
      provider: string;
      accountKey: string;
      metadata: TokenFileMetadata;
    }
  | {
      kind: 'peer_tombstone';
      provider: string;
      accountKey: string;
      relativePath: string;
      tombstoneEpochMs: number;
    };

type TokenMetadataNormalizer = (
  parsed: Record<string, unknown>,
  mtimeMs: number,
  fallbackSurface: 'desktop' | 'cloud',
) => TokenFileMetadata | null;

function readNumericField(parsed: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = parsed[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

function readSurface(parsed: Record<string, unknown>, fallbackSurface: 'desktop' | 'cloud'): 'desktop' | 'cloud' {
  return parsed.surfaceWrote === 'cloud' || parsed.surfaceWrote === 'desktop'
    ? parsed.surfaceWrote
    : fallbackSurface;
}

const DEFAULT_METADATA_NORMALIZER: TokenMetadataNormalizer = (
  parsed,
  mtimeMs,
  fallbackSurface,
) => {
  const expiryEpochMs = readNumericField(parsed, [
    'expiryEpochMs',
    'expiry_date',
    'expires_at',
    'expiresAt',
    'accessTokenExpiresAt',
  ]);
  if (expiryEpochMs === null) return null;
  return {
    expiryEpochMs,
    mtimeMs,
    surfaceWrote: readSurface(parsed, fallbackSurface),
  };
};

const TOKEN_METADATA_NORMALIZERS: TokenMetadataNormalizer[] = [DEFAULT_METADATA_NORMALIZER];

export function parseTokenFileMetadata(
  content: Buffer,
  mtimeMs: number,
  fallbackSurface: 'desktop' | 'cloud',
): TokenFileMetadata | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.toString('utf8'));
  } catch (error) {
    ignoreBestEffortCleanup(error, {
      operation: 'token_sync_parse_metadata_json',
      reason: 'invalid token-file JSON is treated as missing metadata',
    });
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  for (const normalize of TOKEN_METADATA_NORMALIZERS) {
    const normalized = normalize(parsed as Record<string, unknown>, mtimeMs, fallbackSurface);
    if (normalized) return normalized;
  }
  return null;
}
