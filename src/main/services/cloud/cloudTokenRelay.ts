import { watch, type FSWatcher } from 'chokidar';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createScopedLogger } from '@core/logger';
import { toPortablePath } from '@core/utils/portablePath';
import {
  type RelayProvider,
  resolveProviderBasePath,
  isSafeRelativePath,
} from '@shared/authRelayConfig';
import { getDataPath } from '../../utils/dataPaths';
import { CloudServiceClient } from './cloudServiceClient';
import { fireAndForget } from '@shared/utils/fireAndForget';

const log = createScopedLogger({ service: 'cloudTokenRelay' });

const RELAY_DEBOUNCE_MS = 500;

/**
 * Global batch window (ms). After all per-file debounces fire, actual uploads
 * are queued into a serial batch that waits this long for more uploads before
 * flushing. This prevents N providers refreshing near-simultaneously from
 * causing N independent relay calls that each trigger MCP re-registration.
 */
const GLOBAL_BATCH_WINDOW_MS = 5000;

interface RelayPayload {
  provider: RelayProvider;
  relativePath: string;
  data: Record<string, unknown>;
}

interface WatchGroup {
  provider: RelayProvider;
  basePath: string;
  patterns: string[];
}

function buildWatchGroups(): WatchGroup[] {
  const userDataPath = getDataPath();
  const homedir = os.homedir();

  const bp = (provider: RelayProvider) =>
    resolveProviderBasePath(provider, userDataPath, homedir);

  const superMcpBase = bp('super-mcp');
  const freshdeskBase = bp('freshdesk');
  const googleBase = bp('google-workspace');
  const slackBase = bp('slack');
  const hubspotBase = bp('hubspot');
  const salesforceBase = bp('salesforce');
  const microsoftBase = bp('microsoft');

  return [
    {
      provider: 'super-mcp',
      basePath: superMcpBase,
      patterns: [path.join(superMcpBase, '*.json')],
    },
    {
      provider: 'freshdesk',
      basePath: freshdeskBase,
      patterns: [
        path.join(freshdeskBase, 'credentials', '*.token.json'),
        path.join(freshdeskBase, 'accounts.json'),
      ],
    },
    {
      provider: 'google-workspace',
      basePath: googleBase,
      patterns: [
        path.join(googleBase, 'credentials', '*.token.json'),
        path.join(googleBase, 'accounts.json'),
        path.join(googleBase, '**', 'credentials', '*.token.json'),
        path.join(googleBase, '**', 'accounts.json'),
      ],
    },
    {
      provider: 'slack',
      basePath: slackBase,
      patterns: [
        path.join(slackBase, 'workspaces', '*.json'),
        path.join(slackBase, 'config.json'),
      ],
    },
    {
      provider: 'hubspot',
      basePath: hubspotBase,
      patterns: [
        path.join(hubspotBase, 'credentials', '*.token.json'),
        path.join(hubspotBase, 'accounts.json'),
      ],
    },
    {
      provider: 'salesforce',
      basePath: salesforceBase,
      patterns: [path.join(salesforceBase, 'credentials', '*.token.json')],
    },
    {
      provider: 'microsoft',
      basePath: microsoftBase,
      patterns: [
        path.join(microsoftBase, 'credentials', '*.token.json'),
        path.join(microsoftBase, 'accounts.json'),
      ],
    },
  ];
}

function isPathWithin(filePath: string, basePath: string): boolean {
  const relative = path.relative(basePath, filePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function readJsonFile(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    if (error?.code === 'ENOENT') {
      return null;
    }
    log.warn({ err, filePath }, 'Failed to read token/config file for relay');
    return null;
  }
}

interface BatchEntry {
  filePath: string;
  group: WatchGroup;
}

class CloudTokenRelay {
  private watcher: FSWatcher | null = null;
  private client: CloudServiceClient | null = null;
  private watchGroups: WatchGroup[] = [];
  private pendingUploads = new Map<string, NodeJS.Timeout>();
  private connection: { cloudUrl: string; cloudToken: string } | null = null;

  /** Global batch queue — collects uploads from per-file debounces. */
  private batchQueue: BatchEntry[] = [];
  /** Timer for the global batch window trailing debounce. */
  private batchTimer: NodeJS.Timeout | null = null;
  /** True while the batch is being flushed (uploads are in flight). */
  private batchFlushing = false;

  start(cloudUrl: string, cloudToken: string): void {
    if (
      this.watcher &&
      this.connection?.cloudUrl === cloudUrl &&
      this.connection.cloudToken === cloudToken
    ) {
      return;
    }

    fireAndForget(this.stop(), 'cloud.cloudTokenRelay.line170');

    this.connection = { cloudUrl, cloudToken };
    this.client = new CloudServiceClient(cloudUrl, cloudToken);
    this.watchGroups = buildWatchGroups();

    const watchPaths = this.watchGroups.flatMap((group) => group.patterns);
    if (watchPaths.length === 0) {
      log.warn('No watch paths configured for token relay');
      return;
    }

    this.watcher = watch(watchPaths, {
      ignoreInitial: false,
      awaitWriteFinish: {
        stabilityThreshold: 500,
        pollInterval: 1000,
      },
      ignorePermissionErrors: true,
    });

    this.watcher.on('add', (filePath) => this.handleFileChange(filePath));
    this.watcher.on('change', (filePath) => this.handleFileChange(filePath));
    this.watcher.on('unlink', (filePath) => {
      log.debug({ filePath }, 'Token relay saw file removal (no action taken)');
    });
    this.watcher.on('ready', () => {
      log.info({ watchCount: watchPaths.length }, 'Token relay watcher ready');
    });
    this.watcher.on('error', (err) => {
      log.warn({ err }, 'Token relay watcher error');
    });

    log.info({ watchCount: watchPaths.length }, 'Token relay started');
  }

  getConnection(): { cloudUrl: string; cloudToken: string } | null {
    return this.connection ? { ...this.connection } : null;
  }

  async stop(): Promise<void> {
    for (const timeout of this.pendingUploads.values()) {
      clearTimeout(timeout);
    }
    this.pendingUploads.clear();

    // Clear global batch state
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
    this.batchQueue = [];
    this.batchFlushing = false;

    // Capture the watcher we're tearing down. `start()` calls stop() detached
    // (fireAndForget) then synchronously installs a new watcher/client/connection;
    // clearing those fields unconditionally after awaiting the OLD close() would
    // null the freshly-installed NEW state and silently kill a just-restarted
    // relay (DI-23 review F1). Only clear state we still own.
    const watcher = this.watcher;
    if (watcher) {
      try {
        await watcher.close();
      } catch (err) {
        log.warn({ err }, 'Error closing token relay watcher');
      }
      if (this.watcher !== watcher) {
        // A concurrent start() superseded us while close() was in flight — leave
        // its new watcher/client/connection/watchGroups intact.
        log.debug('Token relay: superseded by a concurrent start(); leaving new state intact');
        return;
      }
      this.watcher = null;
    }

    this.client = null;
    this.connection = null;
    this.watchGroups = [];

    log.info('Token relay stopped');
  }

  private handleFileChange(filePath: string): void {
    const group = this.watchGroups.find((candidate) => isPathWithin(filePath, candidate.basePath));
    if (!group) {
      log.debug({ filePath }, 'Token relay ignored file outside watch roots');
      return;
    }

    this.scheduleUpload(filePath, group);
  }

  private scheduleUpload(filePath: string, group: WatchGroup): void {
    const existing = this.pendingUploads.get(filePath);
    if (existing) {
      clearTimeout(existing);
    }

    // Per-file debounce — after settling, push into global batch queue
    const timeout = setTimeout(() => {
      this.pendingUploads.delete(filePath);
      this.enqueueBatch(filePath, group);
    }, RELAY_DEBOUNCE_MS);

    this.pendingUploads.set(filePath, timeout);
  }

  /**
   * Add an upload to the global batch queue and (re)start the batch window.
   * Deduplicates by filePath — only the latest entry per file is kept.
   */
  private enqueueBatch(filePath: string, group: WatchGroup): void {
    // Deduplicate: remove any existing entry for this file
    const existingIdx = this.batchQueue.findIndex((e) => e.filePath === filePath);
    if (existingIdx !== -1) {
      this.batchQueue.splice(existingIdx, 1);
    }
    this.batchQueue.push({ filePath, group });

    // Reset the global batch trailing debounce
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
    }
    this.batchTimer = setTimeout(() => {
      this.batchTimer = null;
      fireAndForget(this.flushBatch(), 'cloud.cloudTokenRelay.line279');
    }, GLOBAL_BATCH_WINDOW_MS);
  }

  /**
   * Flush the global batch queue — upload all queued files serially.
   * Serialization prevents concurrent relay calls from overwhelming the cloud.
   */
  private async flushBatch(): Promise<void> {
    if (this.batchFlushing) return; // Already flushing — the timer will re-queue
    this.batchFlushing = true;

    try {
      while (this.batchQueue.length > 0) {
        // Drain current snapshot (new entries may arrive during upload)
        const entries = [...this.batchQueue];
        this.batchQueue = [];

        log.debug({ count: entries.length }, 'Flushing token relay batch');
        for (const { filePath, group } of entries) {
          await this.uploadFile(filePath, group);
        }
      }
    } finally {
      this.batchFlushing = false;
    }
  }

  private async uploadFile(filePath: string, group: WatchGroup): Promise<void> {
    if (!this.client) return;

    const relativePath = toPortablePath(path.relative(group.basePath, filePath));
    if (!isSafeRelativePath(relativePath)) {
      log.warn({ filePath, provider: group.provider }, 'Token relay skipped unsafe path');
      return;
    }

    const data = await readJsonFile(filePath);
    if (!data) {
      return;
    }

    const payload: RelayPayload = {
      provider: group.provider,
      relativePath,
      data,
    };

    try {
      await this.client.post('/api/auth/relay', payload);
      log.debug({ provider: group.provider, relativePath }, 'Relayed token/config update');
    } catch (err) {
      log.warn({ err, provider: group.provider, relativePath }, 'Failed to relay token/config update');
    }
  }
}

export const cloudTokenRelay = new CloudTokenRelay();
