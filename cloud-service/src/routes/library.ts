/**
 * Library route handlers — list, read, write files.
 */

import http from 'node:http';
import crypto from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import path from 'node:path';
import { readBody, sendJson, sendRouteError, RouteError } from '../httpUtils';
import type { CloudServiceDeps } from '../bootstrap';
import { safeWalkDirectory } from '@core/utils/safeWalkDirectory';
import {
  getWorkspaceFileSystem,
  WORKSPACE_NOT_CONFIGURED_MESSAGE,
  WORKSPACE_PATH_TRAVERSAL_MESSAGE,
} from '@core/workspaceFileSystem';
import { ALWAYS_SKIP_DIRS, ALWAYS_SKIP_NAMES } from '@shared/workspaceConstants';
import {
  isExistingDirectory,
  isSuppressibleConflictCopy,
  isSuppressibleConflictDir,
} from '@shared/conflictSuppression';

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB — same as desktop

interface CloudManifestEntry {
  hash: string;
  size: number;
}

interface CloudManifestEnvelope {
  entries: Record<string, CloudManifestEntry>;
  complete: boolean;
  reasons: string[];
}

function mapWorkspaceFileSystemRouteError(
  error: unknown,
  fallbackCode: 'DELETE_FAILED' | 'WRITE_FAILED',
): RouteError {
  if (error instanceof RouteError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (message === WORKSPACE_PATH_TRAVERSAL_MESSAGE) {
    return new RouteError('INVALID_PATH', { status: 400, message });
  }
  if (message === WORKSPACE_NOT_CONFIGURED_MESSAGE) {
    return new RouteError('NO_WORKSPACE', { status: 500, message });
  }
  return new RouteError(fallbackCode, { status: 500, message });
}

function hashFile(filePath: string): Promise<{ hash: string; sizeBytes: number }> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = createReadStream(filePath);
    let sizeBytes = 0;
    stream.on('error', reject);
    stream.on('data', (chunk) => {
      const chunkSize = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
      sizeBytes += chunkSize;
      hash.update(chunk);
    });
    stream.on('end', () => resolve({ hash: hash.digest('hex').slice(0, 16), sizeBytes }));
  });
}

export async function buildCloudManifest(
  workspaceDir: string,
): Promise<CloudManifestEnvelope> {
  const entries: Record<string, CloudManifestEntry> = {};
  let hashFailures = 0;

  const safeWalkResult = await safeWalkDirectory(workspaceDir, {
    onDirectory: ({ name, absolutePath }) => {
      if (ALWAYS_SKIP_NAMES.has(name)) return false;
      if (ALWAYS_SKIP_DIRS.has(name)) return false;
      // REBEL-62A — server-side defense-in-depth. The per-user Fly cloud-service
      // is the canonical store the desktop peers sync against; if a polluted
      // manifest or a stale desktop ever uploaded a Drive/Dropbox conflict-copy
      // directory (`Project (1)/`) whose original sibling is present, mirroring
      // it back would re-seed every peer with the runaway `(1) (1) …` fan-out.
      // Prune the whole conflict-copy subtree here too, sibling-gated, mirroring
      // desktop cloudWorkspaceSync.ts onDirectory.
      if (
        isSuppressibleConflictDir(name, (originalBasename) =>
          isExistingDirectory(path.join(path.dirname(absolutePath), originalBasename)),
        )
      ) {
        return false;
      }
      return true;
    },
    onFile: async ({ absolutePath, name }) => {
      if (ALWAYS_SKIP_NAMES.has(name)) return;
      if (name.endsWith('.pending.md')) return;

      // REBEL-62A — server-side defense-in-depth (mirrors desktop
      // cloudWorkspaceSync.ts:537). Drop sibling-gated Drive/Dropbox conflict
      // copies (`foo (1).md`) so a polluted cloud manifest / stale desktop can't
      // re-seed peers. The gate already declines `rebel-cloud-conflict`
      // internally and `.pending.md` is skipped above, so no double-handling.
      if (
        isSuppressibleConflictCopy(name, (originalBasename) =>
          existsSync(path.join(path.dirname(absolutePath), originalBasename)),
        )
      ) {
        return;
      }

      const relativePath = path.relative(workspaceDir, absolutePath).split(path.sep).join('/');

      try {
        const { hash, sizeBytes } = await hashFile(absolutePath);
        if (sizeBytes > MAX_FILE_SIZE || sizeBytes === 0) return;
        entries[relativePath] = { hash, size: sizeBytes };
      } catch {
        // Skip files we can't stat or hash. Record the manifest as incomplete
        // so absence-derived desktop repairs fail closed.
        hashFailures++;
      }
    },
  });

  const reasons = [
    ...new Set([
      ...safeWalkResult.truncatedReasons,
      ...(hashFailures > 0 ? ['unreadable'] : []),
    ]),
  ];

  return {
    entries,
    complete: reasons.length === 0,
    reasons,
  };
}

export async function handleLibrary(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  segments: string[],
  deps: CloudServiceDeps,
): Promise<void> {
  const action = segments[2];
  const workspaceDir = deps.getSettings().coreDirectory || '/data/workspace';

  // Manifest: returns hash + size for every workspace file.
  // Used by desktop's bidirectional workspace sync to detect cloud-side edits.
  if (req.method === 'POST' && action === 'manifest') {
    const settings = deps.getSettings();
    const workspaceDir = settings.coreDirectory;
    if (!workspaceDir) return sendRouteError(res, undefined, new RouteError('NO_WORKSPACE', { status: 500, message: 'Core directory not configured' }));
    try {
      const result = await buildCloudManifest(workspaceDir);
      return sendJson(res, 200, result, req);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return sendRouteError(res, undefined, new RouteError('MANIFEST_FAILED', { status: 500, message: message }));
    }
  }
  if (req.method === 'GET' && action === 'files') {
    // Cloud `/files` is a separate SHALLOW listing (not the recursive desktop
    // tree). Surface listing failures explicitly — an error must NOT be
    // presented as an empty (complete) directory (Bug-2 critique F6).
    try {
      const files = await deps.listFiles();
      return sendJson(res, 200, files, req);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return sendRouteError(res, undefined, new RouteError('LIST_FILES_FAILED', { status: 500, message }));
    }
  }
  if (req.method === 'POST' && action === 'read') {
    const body = await readBody(req) as { path?: string } | null;
    if (!body?.path) return sendRouteError(res, undefined, new RouteError('INVALID_BODY', { status: 400, message: 'Request body must include a "path" string' }));
    const content = await deps.readFile(body.path);
    return sendJson(res, 200, { content }, req);
  }
  if (req.method === 'POST' && action === 'write') {
    const body = await readBody(req) as { path?: string; content?: string } | null;
    if (!body?.path || body.content === undefined) return sendRouteError(res, undefined, new RouteError('INVALID_BODY', { status: 400, message: 'Missing path or content' }));
    const result = await deps.writeFile({ path: body.path, content: body.content });
    return sendJson(res, 200, result, req);
  }
  // Single-file upload endpoint for workspace migration
  if (req.method === 'POST' && action === 'upload-file') {
    const body = await readBody(req) as { path?: string; content?: string; encoding?: string } | null;
    if (!body?.path || body.content === undefined) return sendRouteError(res, undefined, new RouteError('INVALID_BODY', { status: 400, message: 'Missing path or content' }));
    try {
      const content = body.encoding === 'base64'
        ? Buffer.from(body.content, 'base64')
        : body.content;
      await getWorkspaceFileSystem().writeFile(workspaceDir, body.path, content);
      return sendJson(res, 200, { path: body.path, updatedAt: Date.now() }, req);
    } catch (error) {
      return sendRouteError(res, undefined, mapWorkspaceFileSystemRouteError(error, 'WRITE_FAILED'));
    }
  }
  // Delete a workspace file
  if (req.method === 'POST' && action === 'delete-file') {
    const body = await readBody(req) as { path?: string } | null;
    if (!body?.path) return sendRouteError(res, undefined, new RouteError('INVALID_BODY', { status: 400, message: 'Missing path' }));
    try {
      await getWorkspaceFileSystem().deleteFile(workspaceDir, body.path);
      return sendJson(res, 200, { success: true }, req);
    } catch (error) {
      return sendRouteError(res, undefined, mapWorkspaceFileSystemRouteError(error, 'DELETE_FAILED'));
    }
  }
  return sendRouteError(res, undefined, new RouteError('NOT_FOUND', { status: 404, message: `Unknown library action: ${action}` }));
}
