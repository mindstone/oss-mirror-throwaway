import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { BroadcastService } from '@core/broadcastService';
import type { ErrorReporter } from '@core/errorReporter';
import type { Logger as PinoLogger } from '@core/logger';
import {
  createCloudConnectionReconciler,
  type CloudConnectionReconciler,
  type CloudInstanceSettingsAdapter,
} from '@core/services/cloud/cloudConnectionReconciler';
import type { CloudHealthProbe, CloudHealthProbeResult } from '@core/services/cloud/cloudHealthProbe';
import type { CloudInstanceConfig } from '@shared/types/settings';

const CLOUD_URL = 'https://rebel-cloud-test.fly.dev';

class InMemorySettingsAdapter implements CloudInstanceSettingsAdapter {
  private cloudInstance: CloudInstanceConfig | undefined;

  constructor(initialCloudInstance: CloudInstanceConfig | undefined) {
    this.cloudInstance = initialCloudInstance;
  }

  read(): CloudInstanceConfig | undefined {
    return this.cloudInstance;
  }

  async update(merge: Partial<CloudInstanceConfig>): Promise<void> {
    const latest = this.cloudInstance;
    if (!latest) return;
    this.cloudInstance = { ...latest, ...merge };
  }
}

class FakeCloudHealthProbe implements CloudHealthProbe {
  private queue: Array<() => Promise<CloudHealthProbeResult>> = [];

  queueResult(result: CloudHealthProbeResult): void {
    this.queue.push(async () => result);
  }

  queueError(error: unknown): void {
    this.queue.push(async () => {
      throw error;
    });
  }

  async probe(): Promise<CloudHealthProbeResult> {
    const next = this.queue.shift();
    if (!next) {
      throw new Error('FakeCloudHealthProbe has no queued result');
    }
    return next();
  }
}

class FakeBroadcastService implements BroadcastService {
  calls: Array<{ channel: string; args: unknown[] }> = [];

  sendToAllWindows(channel: string, ...args: unknown[]): void {
    this.calls.push({ channel, args });
  }

  sendToFocusedWindow(channel: string, ...args: unknown[]): void {
    this.calls.push({ channel, args });
  }

  clear(): void {
    this.calls = [];
  }
}

function createNoopErrorReporter(): ErrorReporter {
  return {
    captureException: () => undefined,
    captureMessage: () => undefined,
    addBreadcrumb: () => undefined,
  };
}

function createNoopLogger(): PinoLogger {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  } as unknown as PinoLogger;
}

function initialCloudInstance(): CloudInstanceConfig {
  return {
    mode: 'cloud',
    cloudUrl: CLOUD_URL,
    cloudToken: 'test-token',
    lastKnownStatus: 'cold',
  };
}

describe('REBEL-568 replay — Apr 30 → May 4 sticky state recovery', () => {
  let reconciler: CloudConnectionReconciler;
  let settingsAdapter: InMemorySettingsAdapter;
  let probe: FakeCloudHealthProbe;
  let broadcast: FakeBroadcastService;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-30T08:00:00Z'));

    settingsAdapter = new InMemorySettingsAdapter(initialCloudInstance());
    probe = new FakeCloudHealthProbe();
    broadcast = new FakeBroadcastService();
    reconciler = createCloudConnectionReconciler({
      settings: settingsAdapter,
      broadcastService: broadcast,
      errorReporter: createNoopErrorReporter(),
      logger: createNoopLogger(),
      probe,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('clears stale fetch-failed state on next successful call (REBEL-568 timeline)', async () => {
    // T0 = Apr 30: successful refresh sets lastSyncedAt.
    probe.queueResult({ ok: true, status: 200 });
    await reconciler.reconcile({ writer: 'manual-refresh', cloudUrl: CLOUD_URL });
    const apr30State = settingsAdapter.read();
    expect(apr30State?.lastKnownStatus).toBe('running');
    expect(apr30State?.lastSyncedAt).toBeDefined();
    const apr30Synced = apr30State!.lastSyncedAt!;

    // T1 = May 1 startup: fetch throws the literal undici TypeError("fetch failed").
    vi.setSystemTime(new Date('2026-05-01T08:00:00Z'));
    probe.queueError(new TypeError('fetch failed'));
    await reconciler.reconcile({ writer: 'startup-health', cloudUrl: CLOUD_URL });
    const may1State = settingsAdapter.read();
    expect(may1State?.lastKnownStatus).toBe('error');
    expect(may1State?.errorCategory).toEqual({ kind: 'network', subkind: 'fetch_failed' });
    expect(may1State?.lastSyncedAt).toBe(apr30Synced);
    expect(may1State?.lastWriter).toBe('startup-health');

    // T1+1 = May 2 startup: still failing, without corrupting the last successful timestamp.
    vi.setSystemTime(new Date('2026-05-02T08:00:00Z'));
    probe.queueError(new TypeError('fetch failed'));
    await reconciler.reconcile({ writer: 'startup-health', cloudUrl: CLOUD_URL });
    const may2State = settingsAdapter.read();
    expect(may2State?.lastKnownStatus).toBe('error');
    expect(may2State?.lastSyncedAt).toBe(apr30Synced);

    // T2 = May 4: cloud recovers, focus triggers reportSuccess.
    vi.setSystemTime(new Date('2026-05-04T08:00:00Z'));
    await reconciler.reportSuccess({ writer: 'focus', cloudUrl: CLOUD_URL });
    const may4State = settingsAdapter.read();
    expect(may4State?.lastKnownStatus).toBe('running');
    expect(may4State?.lastError).toBeUndefined();
    expect(may4State?.errorCategory).toBeUndefined();
    expect(may4State?.degradedSince).toBeUndefined();
    expect(may4State?.lastWriter).toBe('focus');
    expect(may4State?.lastSyncedAt).toBeGreaterThan(apr30Synced);
  });

  it('curates undici TypeError correctly (Bug B regression-prevention at the reconciler seam)', async () => {
    probe.queueError(new TypeError('fetch failed'));
    const outcome = await reconciler.reconcile({ writer: 'startup-health', cloudUrl: 'https://test/' });
    expect(outcome.result).toBe('failure');
    if (outcome.result !== 'failure') {
      throw new Error('expected startup-health reconcile to fail');
    }
    expect(outcome.category).toEqual({ kind: 'network', subkind: 'fetch_failed' });
  });

  it('emits cloud:status-changed broadcast on the failure → success transition', async () => {
    probe.queueError(new TypeError('fetch failed'));
    await reconciler.reconcile({ writer: 'startup-health', cloudUrl: 'https://test/' });
    broadcast.clear();

    await reconciler.reportSuccess({ writer: 'focus', cloudUrl: 'https://test/' });
    expect(broadcast.calls).toHaveLength(1);
    expect(broadcast.calls[0].channel).toBe('cloud:status-changed');
  });
});
