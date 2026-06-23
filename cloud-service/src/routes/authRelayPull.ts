import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { getTokenSyncCoordinator } from '@core/setTokenSyncCoordinator';
import { hashAccountSlug } from '@core/services/diagnostics/eventHashing';
import { parseTokenFileMetadata } from '@core/services/tokenSync/types';
import { type OAuthRelayProvider, resolveProviderBasePath } from '@shared/authRelayConfig';
import { authorize, getBearerTokenHash } from '../auth';
import { log, readBody, RouteError, sendJson, sendRouteError } from '../httpUtils';

const DATA_PATH = process.env.REBEL_USER_DATA || '/data';
const RATE_LIMIT_MAX_REQUESTS = 60;
const RATE_LIMIT_WINDOW_MS = 60_000;
const rateLimitBuckets = new Map<string, number[]>();

const SYNC_PROVIDER_TO_RELAY_PROVIDER: Record<string, OAuthRelayProvider> = {
  google: 'google-workspace',
  slack: 'slack',
  hubspot: 'hubspot',
  microsoft: 'microsoft',
};

function audit(req: http.IncomingMessage, args: {
  provider: string;
  accountKey: string;
  status: number;
}): void {
  log({
    level: 'info',
    msg: 'Auth relay pull audit',
    provider: args.provider,
    accountKeyHash: hashAccountSlug(args.accountKey),
    method: req.method,
    status: args.status,
    ip: req.socket?.remoteAddress ?? 'unknown',
  });
}

function applyRateLimit(req: http.IncomingMessage): boolean {
  const bearerHash = getBearerTokenHash(req);
  if (!bearerHash) return false;
  const now = Date.now();
  const recent = (rateLimitBuckets.get(bearerHash) ?? []).filter((ts) => now - ts < RATE_LIMIT_WINDOW_MS);
  if (recent.length >= RATE_LIMIT_MAX_REQUESTS) {
    rateLimitBuckets.set(bearerHash, recent);
    return true;
  }
  recent.push(now);
  rateLimitBuckets.set(bearerHash, recent);
  return false;
}

function decodeRelativePathOnce(rawRelativePath: string): string {
  if (rawRelativePath.includes('\0')) {
    throw new RouteError('INVALID_BODY', { status: 400, message: 'Path contains null byte' });
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(rawRelativePath);
  } catch {
    throw new RouteError('INVALID_BODY', { status: 400, message: 'Invalid encoded path' });
  }

  if (decoded.includes('\0')) {
    throw new RouteError('INVALID_BODY', { status: 400, message: 'Path contains null byte' });
  }
  if (/%[0-9a-f]{2}/i.test(decoded)) {
    throw new RouteError('INVALID_BODY', { status: 400, message: 'Path appears double-encoded' });
  }
  if (decoded.includes('\\')) {
    throw new RouteError('INVALID_BODY', { status: 400, message: 'Windows path separators are not allowed' });
  }
  if (/^[a-z]:/i.test(decoded)) {
    throw new RouteError('INVALID_BODY', { status: 400, message: 'Windows drive paths are not allowed' });
  }
  if (decoded.startsWith('/')) {
    throw new RouteError('INVALID_BODY', { status: 400, message: 'Absolute paths are not allowed' });
  }

  const normalized = decoded.replace(/\\/g, '/');
  if (normalized.split('/').some((segment) => segment === '..' || segment.length === 0)) {
    throw new RouteError('INVALID_BODY', { status: 400, message: 'Path traversal is not allowed' });
  }
  return normalized;
}

async function resolveCandidateRelativePath(basePath: string, candidate: string): Promise<string> {
  const directPath = path.join(basePath, candidate);
  if (candidate.toLowerCase().endsWith('.json')) return candidate;

  const hintDirectories = [
    path.join(basePath, candidate, 'credentials'),
    path.join(basePath, candidate),
  ];

  const files: string[] = [];
  for (const dirPath of hintDirectories) {
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.toLowerCase().endsWith('.json')) {
          files.push(path.relative(basePath, path.join(dirPath, entry.name)).replace(/\\/g, '/'));
        }
      }
    } catch {
      // best effort
    }
  }

  if (files.length > 0) {
    const preferred = files.find((file) => file.toLowerCase().endsWith('.token.json'));
    return preferred ?? files[0]!;
  }

  return path.relative(basePath, directPath).replace(/\\/g, '/');
}

function deriveAccountKey(relativePath: string): string {
  const segments = relativePath.split('/').filter(Boolean);
  if (segments.length === 0) return 'unknown';
  if (segments.length >= 2 && segments[1] === 'credentials') {
    return segments[0] ?? 'unknown';
  }
  const first = segments[0];
  if (first && first !== 'credentials' && first !== 'workspaces') return first;
  return path.basename(relativePath, path.extname(relativePath));
}

async function resolveTokenPath(args: {
  provider: string;
  rawRelativePath: string;
}): Promise<{
  provider: string;
  accountKey: string;
  relativePath: string;
  absolutePath: string;
  mtimeMs: number;
}> {
  const relayProvider = SYNC_PROVIDER_TO_RELAY_PROVIDER[args.provider];
  if (!relayProvider) {
    throw new RouteError('INVALID_BODY', { status: 403, message: 'Unsupported provider' });
  }

  const decodedRelativePath = decodeRelativePathOnce(args.rawRelativePath);
  const basePath = resolveProviderBasePath(relayProvider, DATA_PATH, os.homedir());
  const absoluteBase = path.resolve(basePath);
  const relativePath = await resolveCandidateRelativePath(absoluteBase, decodedRelativePath);

  const absolutePath = path.resolve(absoluteBase, relativePath);
  if (absolutePath !== absoluteBase && !absolutePath.startsWith(`${absoluteBase}${path.sep}`)) {
    throw new RouteError('INVALID_BODY', { status: 400, message: 'Unsafe target path' });
  }
  if (!relativePath.toLowerCase().endsWith('.json')) {
    throw new RouteError('INVALID_BODY', { status: 403, message: 'Only JSON token files are allowed' });
  }

  let stats: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stats = await fs.lstat(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
      throw new RouteError('NOT_FOUND', { status: 404, message: 'Token file not found' });
    }
    throw error;
  }
  if (stats.isSymbolicLink()) {
    throw new RouteError('INVALID_BODY', { status: 403, message: 'Symlink token paths are not allowed' });
  }
  if (!stats.isFile()) {
    throw new RouteError('NOT_FOUND', { status: 404, message: 'Token file not found' });
  }

  const realBase = await fs.realpath(absoluteBase).catch(() => absoluteBase);
  const realPath = await fs.realpath(absolutePath).catch(() => absolutePath);
  if (realPath !== realBase && !realPath.startsWith(`${realBase}${path.sep}`)) {
    throw new RouteError('INVALID_BODY', { status: 400, message: 'Path escaped provider root' });
  }

  return {
    provider: args.provider,
    accountKey: deriveAccountKey(relativePath),
    relativePath,
    absolutePath,
    mtimeMs: stats.mtimeMs,
  };
}

function parseRoute(req: http.IncomingMessage): {
  provider: string;
  rawRelativePath: string;
  metadataOnly: boolean;
} {
  const route = (req.url ?? '').split('?')[0] ?? '';
  const prefix = '/api/auth/relay/';
  if (!route.startsWith(prefix)) {
    throw new RouteError('NOT_FOUND', { status: 404, message: 'Route not found' });
  }

  const pathWithoutPrefix = route.slice(prefix.length);
  const metadataSuffix = '/metadata';
  const metadataOnly = pathWithoutPrefix.endsWith(metadataSuffix);
  const providerAndPath = metadataOnly
    ? pathWithoutPrefix.slice(0, -metadataSuffix.length)
    : pathWithoutPrefix;

  const splitIndex = providerAndPath.indexOf('/');
  if (splitIndex <= 0 || splitIndex >= providerAndPath.length - 1) {
    throw new RouteError('INVALID_BODY', { status: 400, message: 'Missing provider or relative path' });
  }

  let provider: string;
  try {
    provider = decodeURIComponent(providerAndPath.slice(0, splitIndex));
  } catch {
    throw new RouteError('INVALID_BODY', { status: 400, message: 'Invalid provider path segment' });
  }

  return {
    provider,
    rawRelativePath: providerAndPath.slice(splitIndex + 1),
    metadataOnly,
  };
}

export async function handleAuthRelayPull(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  if (!authorize(req)) {
    return sendRouteError(res, undefined, new RouteError('UNAUTHORIZED', { status: 401, message: 'Invalid or missing bearer token' }));
  }
  if (applyRateLimit(req)) {
    return sendRouteError(res, undefined, new RouteError('RATE_LIMITED', { status: 429, message: 'Rate limit exceeded' }));
  }

  let route: ReturnType<typeof parseRoute>;
  try {
    route = parseRoute(req);
  } catch (error) {
    if (error instanceof RouteError) {
      return sendRouteError(res, req, error);
    }
    return sendRouteError(res, undefined, new RouteError('INVALID_BODY', { status: 400, message: 'Invalid route path' }));
  }

  if (req.method === 'GET') {
    try {
      const resolved = await resolveTokenPath({
        provider: route.provider,
        rawRelativePath: route.rawRelativePath,
      });
      const content = await fs.readFile(resolved.absolutePath);
      const metadata = parseTokenFileMetadata(content, resolved.mtimeMs, 'cloud');
      if (!metadata) {
        audit(req, { provider: resolved.provider, accountKey: resolved.accountKey, status: 404 });
        return sendRouteError(res, undefined, new RouteError('NOT_FOUND', { status: 404, message: 'Token metadata unavailable' }));
      }

      audit(req, { provider: resolved.provider, accountKey: resolved.accountKey, status: 200 });
      if (route.metadataOnly) {
        return sendJson(res, 200, {
          relativePath: resolved.relativePath,
          expiryEpochMs: metadata.expiryEpochMs,
          mtimeMs: metadata.mtimeMs,
          surfaceWrote: metadata.surfaceWrote,
        });
      }

      return sendJson(res, 200, {
        content: content.toString('base64'),
        mtimeMs: metadata.mtimeMs,
        expiryEpochMs: metadata.expiryEpochMs,
        surfaceWrote: metadata.surfaceWrote,
        relativePath: resolved.relativePath,
      });
    } catch (error) {
      if (error instanceof RouteError) {
        return sendRouteError(res, req, error);
      }
      return sendRouteError(res, undefined, new RouteError('INTERNAL_ERROR', { status: 500, message: 'Failed to read token file' }));
    }
  }

  if (req.method === 'DELETE') {
    if (route.metadataOnly) {
      return sendRouteError(res, undefined, new RouteError('METHOD_NOT_ALLOWED', { status: 405, message: 'DELETE /metadata is not allowed' }));
    }

    try {
      const body = await readBody(req) as { tombstoneEpochMs?: unknown } | null;
      if (!body || typeof body.tombstoneEpochMs !== 'number' || !Number.isFinite(body.tombstoneEpochMs)) {
        return sendRouteError(res, undefined, new RouteError('INVALID_BODY', { status: 400, message: 'Missing tombstoneEpochMs' }));
      }

      const resolved = await resolveTokenPath({
        provider: route.provider,
        rawRelativePath: route.rawRelativePath,
      });

      await getTokenSyncCoordinator().onPeerTombstone({
        provider: resolved.provider,
        accountKey: resolved.accountKey,
        relativePath: resolved.relativePath,
        tombstoneEpochMs: body.tombstoneEpochMs,
      });

      audit(req, { provider: resolved.provider, accountKey: resolved.accountKey, status: 200 });
      return sendJson(res, 200, { success: true });
    } catch (error) {
      if (error instanceof RouteError) {
        return sendRouteError(res, req, error);
      }
      return sendRouteError(res, undefined, new RouteError('INTERNAL_ERROR', { status: 500, message: 'Failed to process token tombstone' }));
    }
  }

  return sendRouteError(res, undefined, new RouteError('METHOD_NOT_ALLOWED', { status: 405, message: 'Only GET and DELETE are allowed' }));
}
