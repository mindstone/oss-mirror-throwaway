import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from '@core/logger';
import type { CrossProcessLease, LeaseHandle } from '@core/setCrossProcessLease';
import type { TokenSyncCoordinator as TokenSyncCoordinatorContract } from '@core/setTokenSyncCoordinator';
import { hashAccountSlug } from '@core/services/diagnostics/eventHashing';
import type { TokenSyncTransport } from '@core/setTokenSyncTransport';
import { NULL_TOKEN_SYNC_TRANSPORT } from '@core/setTokenSyncTransport';
import { atomicCredentialWrite } from '@core/utils/atomicCredentialWrite';
import { safeWalkDirectory } from '@core/utils/safeWalkDirectory';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';
import { mergeDecision } from './merge';
import { parseTokenFileMetadata, type TokenFileMetadata } from './types';

const LOCAL_WRITE_DEBOUNCE_MS = 500;
const LEASE_TTL_MS = 15_000;
const PEER_SIGNAL_PULL_BUDGET_MS = 3_000;
const TOKEN_FILE_SCAN_MAX_DEPTH = 5;

type AtomicWriter = (filePath: string, data: string, opts?: { mode?: number }) => Promise<void>;

type CoordinatorConstructorArgs = {
  surface: 'desktop' | 'cloud';
  transport: TokenSyncTransport;
  lease: CrossProcessLease;
  logger: Logger;
  atomicWriter?: AtomicWriter;
  tokenRootResolver: (provider: string) => string;
  clock?: () => number;
  readFile?: (filePath: string) => Promise<Buffer>;
  stat?: (filePath: string) => Promise<{ mtimeMs: number }>;
  unlink?: (filePath: string) => Promise<void>;
};

type LocalSnapshot = {
  relativePath: string;
  metadata: TokenFileMetadata;
};

function makeKey(provider: string, accountKey: string): string {
  return `${provider}:${accountKey}`;
}

function normalizeAccountKey(accountKey: string): string {
  return accountKey.toLowerCase().replace(/[^a-z0-9]/g, '-');
}

function isMissingFileError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

function isDirectoryTraversalCandidate(relativePath: string): boolean {
  if (!relativePath || path.isAbsolute(relativePath)) return true;
  const normalized = relativePath.replace(/\\/g, '/');
  return normalized.split('/').some((segment) => segment === '..' || segment.length === 0);
}

function scoreCandidate(relativePath: string, accountKey: string): number {
  const lower = relativePath.toLowerCase();
  const accountKeyLower = accountKey.toLowerCase();
  const normalizedAccountKey = normalizeAccountKey(accountKey);

  let score = 0;
  if (lower.endsWith('.token.json')) score += 5;
  if (lower.endsWith('.json')) score += 1;
  if (lower.includes(accountKeyLower)) score += 4;
  if (normalizedAccountKey.length > 0 && lower.includes(normalizedAccountKey)) score += 3;
  if (lower.includes('/credentials/')) score += 2;
  return score;
}

async function listJsonFilesInDirectory(dirPath: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true, encoding: 'utf8' });
    return entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))
      .map((entry) => path.join(dirPath, entry.name));
  } catch (error) {
    // Directory absent (ENOENT) is normal during token discovery — recover
    // silently. Any other read failure silently presenting as "no token files"
    // is the dangerous case, so make it observable (best-effort scan; the empty
    // fallback is preserved).
    if (isMissingFileError(error)) return [];
    ignoreBestEffortCleanup(error, {
      operation: 'tokenSync.listJsonFilesInDirectory',
      reason: 'token-candidate directory could not be listed; treating as no token files',
    });
    return [];
  }
}

async function walkJsonFiles(rootPath: string, depth: number): Promise<string[]> {
  if (depth < 0) return [];
  const files: string[] = [];
  await safeWalkDirectory(rootPath, {
    maxDepth: depth,
    onFile: ({ absolutePath, name }) => {
      if (name.toLowerCase().endsWith('.json')) {
        files.push(absolutePath);
      }
    },
  });
  return files;
}

export class TokenSyncCoordinator implements TokenSyncCoordinatorContract {
  private readonly surface: 'desktop' | 'cloud';
  private readonly transport: TokenSyncTransport;
  private readonly lease: CrossProcessLease;
  private readonly logger: Logger;
  private readonly atomicWriter: AtomicWriter;
  private readonly tokenRootResolver: (provider: string) => string;
  private readonly clock: () => number;
  private readonly readFile: (filePath: string) => Promise<Buffer>;
  private readonly stat: (filePath: string) => Promise<{ mtimeMs: number }>;
  private readonly unlink: (filePath: string) => Promise<void>;

  private readonly pendingPullByKey = new Map<string, Promise<{ ok: true; source: 'local' | 'peer' | 'unwired' } | { ok: false; error: string }>>();
  private readonly localWriteDebounceTimers = new Map<string, NodeJS.Timeout>();
  private readonly relativePathCacheByKey = new Map<string, string>();

  constructor(args: CoordinatorConstructorArgs) {
    this.surface = args.surface;
    this.transport = args.transport;
    this.lease = args.lease;
    this.logger = args.logger;
    this.atomicWriter = args.atomicWriter ?? atomicCredentialWrite;
    this.tokenRootResolver = args.tokenRootResolver;
    this.clock = args.clock ?? Date.now;
    this.readFile = args.readFile ?? ((filePath) => fs.readFile(filePath));
    this.stat = args.stat ?? ((filePath) => fs.stat(filePath));
    this.unlink = args.unlink ?? ((filePath) => fs.unlink(filePath));
  }

  async ensureFreshish(args: {
    provider: string;
    accountKey: string;
    deadlineMs: number;
  }): Promise<{ ok: true; source: 'local' | 'peer' | 'unwired' } | { ok: false; error: string }> {
    if (this.transport === NULL_TOKEN_SYNC_TRANSPORT) {
      return { ok: true, source: 'unwired' };
    }

    const key = makeKey(args.provider, args.accountKey);
    const existing = this.pendingPullByKey.get(key);
    if (existing) return existing;

    const next = this.ensureFreshishInternal(args).finally(() => {
      this.pendingPullByKey.delete(key);
    });
    this.pendingPullByKey.set(key, next);
    return next;
  }

  async onLocalWrite(args: {
    provider: string;
    accountKey: string;
    relativePath: string;
    expiryEpochMs: number;
    mtimeMs: number;
  }): Promise<void> {
    const key = makeKey(args.provider, args.accountKey);
    this.relativePathCacheByKey.set(key, args.relativePath);

    const existing = this.localWriteDebounceTimers.get(key);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.localWriteDebounceTimers.delete(key);
      void this.transport.publishSignal({
        provider: args.provider,
        accountKey: args.accountKey,
        expiryEpochMs: args.expiryEpochMs,
        mtimeMs: args.mtimeMs,
        surfaceWrote: this.surface,
      }).catch((error) => {
        this.logger.warn(
          {
            event: 'token_sync_publish_signal_failed',
            provider: args.provider,
            accountKeyHash: hashAccountSlug(args.accountKey),
            err: error instanceof Error ? error.message : String(error),
          },
          'Token sync publish signal failed',
        );
      });
    }, LOCAL_WRITE_DEBOUNCE_MS);

    this.localWriteDebounceTimers.set(key, timer);
  }

  async onPeerSignal(args: {
    provider: string;
    accountKey: string;
    expiryEpochMs: number;
    mtimeMs: number;
    surfaceWrote: 'desktop' | 'cloud';
  }): Promise<void> {
    // best-effort freshness; ok:false is non-fatal here.
    void (await this.ensureFreshish({
      provider: args.provider,
      accountKey: args.accountKey,
      deadlineMs: this.clock() + PEER_SIGNAL_PULL_BUDGET_MS,
    }));
  }

  async onPeerTombstone(args: {
    provider: string;
    accountKey: string;
    relativePath: string;
    tombstoneEpochMs: number;
  }): Promise<void> {
    const absolutePath = this.resolveAbsolutePath(args.provider, args.relativePath);
    if (!absolutePath) return;

    let stats: { mtimeMs: number };
    try {
      stats = await this.stat(absolutePath);
    } catch (error) {
      if (isMissingFileError(error)) {
        ignoreBestEffortCleanup(error, {
          operation: 'token_sync_peer_tombstone_stat_missing',
          reason: 'peer tombstone target was already absent before stat',
        });
        return;
      }
      throw error;
    }

    if (stats.mtimeMs > args.tombstoneEpochMs) return;

    try {
      await this.unlink(absolutePath);
    } catch (error) {
      if (isMissingFileError(error)) {
        ignoreBestEffortCleanup(error, {
          operation: 'token_sync_peer_tombstone_missing_file',
          reason: 'peer tombstone unlink target was already absent',
        });
        return;
      }
      throw error;
    }
  }

  async getStatus(): Promise<Record<string, unknown>> {
    return {
      surface: this.surface,
      pendingPullCount: this.pendingPullByKey.size,
      debouncedLocalWrites: this.localWriteDebounceTimers.size,
      cachedPathCount: this.relativePathCacheByKey.size,
      transportWired: this.transport !== NULL_TOKEN_SYNC_TRANSPORT,
      watcherCount: 0,
    };
  }

  private async ensureFreshishInternal(args: {
    provider: string;
    accountKey: string;
    deadlineMs: number;
  }): Promise<{ ok: true; source: 'local' | 'peer' | 'unwired' } | { ok: false; error: string }> {
    const localSnapshot = await this.readLocalSnapshot(args.provider, args.accountKey);
    const metadataResult = await this.transport.pullMetadata({
      provider: args.provider,
      accountKey: args.accountKey,
    });

    if (!metadataResult.ok) {
      if (metadataResult.error === 'unwired') {
        return { ok: true, source: 'unwired' };
      }
      return { ok: true, source: 'local' };
    }

    const decision = mergeDecision(localSnapshot?.metadata ?? null, metadataResult.metadata);
    const shouldAdoptPeer = decision === 'adopt_peer'
      || (decision === 'tie_cloud_wins' && metadataResult.metadata.surfaceWrote === 'cloud');
    if (!shouldAdoptPeer) {
      return { ok: true, source: 'local' };
    }

    const tokenResult = await this.transport.pullToken({
      provider: args.provider,
      relativePath: metadataResult.metadata.relativePath,
    });
    if (!tokenResult.ok) {
      return { ok: true, source: 'local' };
    }

    const leaseScope = this.makeLeaseScope(args.provider, args.accountKey);
    const leaseHandle = await this.acquireLease(leaseScope, args.deadlineMs);
    if (!leaseHandle) {
      return { ok: true, source: 'local' };
    }

    const absolutePath = this.resolveAbsolutePath(args.provider, metadataResult.metadata.relativePath);
    if (!absolutePath) {
      await this.releaseLease(leaseHandle, leaseScope, args.provider, args.accountKey);
      return { ok: true, source: 'local' };
    }

    try {
      await this.atomicWriter(absolutePath, tokenResult.content.toString('utf8'), { mode: 0o600 });
      this.relativePathCacheByKey.set(makeKey(args.provider, args.accountKey), metadataResult.metadata.relativePath);
      this.logger.info(
        {
          event: 'synced_from_peer',
          provider: args.provider,
          accountKeyHash: hashAccountSlug(args.accountKey),
          expiryEpochMs: tokenResult.expiryEpochMs,
        },
        'Token sync coordinator event',
      );
      return { ok: true, source: 'peer' };
    } catch (error) {
      return {
        ok: false,
        error: `atomic_write_failed:${error instanceof Error ? error.message : String(error)}`,
      };
    } finally {
      await this.releaseLease(leaseHandle, leaseScope, args.provider, args.accountKey);
    }
  }

  private async readLocalSnapshot(provider: string, accountKey: string): Promise<LocalSnapshot | null> {
    const relativePath = await this.resolveRelativePathForAccount(provider, accountKey);
    if (!relativePath) return null;

    const absolutePath = this.resolveAbsolutePath(provider, relativePath);
    if (!absolutePath) return null;

    try {
      const [content, stats] = await Promise.all([
        this.readFile(absolutePath),
        this.stat(absolutePath),
      ]);
      const metadata = parseTokenFileMetadata(content, stats.mtimeMs, this.surface);
      if (!metadata) return null;
      return { relativePath, metadata };
    } catch (error) {
      if (isMissingFileError(error)) {
        ignoreBestEffortCleanup(error, {
          operation: 'token_sync_read_local_snapshot_missing',
          reason: 'local token snapshot is absent during sync merge',
        });
        return null;
      }
      ignoreBestEffortCleanup(error, {
        operation: 'token_sync_read_local_snapshot',
        reason: 'local snapshot failures fall back to peer/local metadata merge',
      });
      return null;
    }
  }

  private async resolveRelativePathForAccount(provider: string, accountKey: string): Promise<string | null> {
    const cacheKey = makeKey(provider, accountKey);
    const cached = this.relativePathCacheByKey.get(cacheKey);
    if (cached) {
      const absolutePath = this.resolveAbsolutePath(provider, cached);
      if (absolutePath) {
        try {
          await this.stat(absolutePath);
          return cached;
        } catch (error) {
          ignoreBestEffortCleanup(error, {
            operation: 'token_sync_cached_relative_path_stat',
            reason: 'invalidate stale relative-path cache when file is unreadable or missing',
          });
          this.relativePathCacheByKey.delete(cacheKey);
        }
      }
    }

    const rootPath = this.tokenRootResolver(provider);
    if (!rootPath) return null;

    const candidatePaths: string[] = [];
    const accountPathCandidates = [
      path.join(rootPath, accountKey, 'credentials'),
      path.join(rootPath, accountKey),
      path.join(rootPath, 'credentials'),
    ];
    for (const candidateDirectory of accountPathCandidates) {
      const files = await listJsonFilesInDirectory(candidateDirectory);
      candidatePaths.push(...files);
    }

    if (candidatePaths.length === 0) {
      candidatePaths.push(...await walkJsonFiles(rootPath, TOKEN_FILE_SCAN_MAX_DEPTH));
    }

    if (candidatePaths.length === 0) return null;

    const ranked = candidatePaths
      .map((absolutePath) => {
        const relativePath = path.relative(rootPath, absolutePath).replace(/\\/g, '/');
        return { relativePath, score: scoreCandidate(relativePath, accountKey) };
      })
      .filter((candidate) => candidate.relativePath.length > 0 && candidate.relativePath.toLowerCase().endsWith('.json'))
      .sort((a, b) => b.score - a.score);

    const best = ranked[0];
    if (!best) return null;

    this.relativePathCacheByKey.set(cacheKey, best.relativePath);
    return best.relativePath;
  }

  private resolveAbsolutePath(provider: string, relativePath: string): string | null {
    if (isDirectoryTraversalCandidate(relativePath)) return null;
    const rootPath = this.tokenRootResolver(provider);
    if (!rootPath) return null;

    const absoluteRoot = path.resolve(rootPath);
    const absolutePath = path.resolve(absoluteRoot, relativePath);
    if (absolutePath !== absoluteRoot && !absolutePath.startsWith(`${absoluteRoot}${path.sep}`)) {
      return null;
    }
    return absolutePath;
  }

  private makeLeaseScope(provider: string, accountKey: string): string {
    const fallbackHash = createHash('sha256').update(accountKey).digest('hex').slice(0, 16);
    const accountHash = hashAccountSlug(accountKey) || fallbackHash;
    return `sync:${provider}:${accountHash}`;
  }

  private async acquireLease(scope: string, deadlineMs: number): Promise<LeaseHandle | null> {
    if (this.clock() > deadlineMs) return null;
    return this.lease.acquire(scope, LEASE_TTL_MS);
  }

  private async releaseLease(
    handle: LeaseHandle,
    scope: string,
    provider: string,
    accountKey: string,
  ): Promise<void> {
    try {
      await this.lease.release(handle);
    } catch (error) {
      this.logger.warn(
        {
          event: 'token_sync_lease_release_failed',
          provider,
          accountKeyHash: hashAccountSlug(accountKey),
          scope,
          err: error instanceof Error ? error.message : String(error),
        },
        'Token sync lease release failed',
      );
    }
  }
}
