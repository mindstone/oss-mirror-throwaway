/**
 * CloudTab Test Helpers
 *
 * Mock factories and setup/teardown utilities for testing CloudTab
 * and its future extracted hooks (Stage 9).
 *
 * Usage:
 *   const { cloudApi, emit } = createMockCloudApi();
 *   const settingsApi = createMockSettingsApi();
 *   setupCloudTabMocks({ cloudApi: cloudApi.api, settingsApi });
 *   // ...run tests...
 *   cleanupCloudTabMocks();
 */

import { vi } from 'vitest';
import type { AppSettings, CloudInstanceConfig } from '@shared/types';

// ---------------------------------------------------------------------------
// Types for mock APIs
// ---------------------------------------------------------------------------

type IpcListener = (...args: unknown[]) => void;

interface MockCloudApiResult {
  /** The mock cloud API object (wire into window.cloudApi) */
  api: Record<string, unknown>;
  /** Emit a simulated IPC event (e.g., emit('onMigrationProgress', data)) */
  emit: (event: string, ...args: unknown[]) => void;
  /** Access registered listeners by event name */
  listeners: Record<string, IpcListener[]>;
}

// ---------------------------------------------------------------------------
// Mock Cloud API
// ---------------------------------------------------------------------------

/**
 * Creates a mock window.cloudApi with all methods as vi.fn() and
 * event subscription support (onXxx methods register callbacks).
 */
export function createMockCloudApi(): MockCloudApiResult {
  const listeners: Record<string, IpcListener[]> = {};

  const emit = (event: string, ...args: unknown[]) => {
    (listeners[event] || []).forEach((cb) => cb(...args));
  };

  const api: Record<string, unknown> = {
    // Connection & sync
    migrate: vi.fn().mockResolvedValue({ success: true }),
    syncNow: vi.fn().mockResolvedValue({ success: true, workspace: { pushed: 0 } }),
    destroy: vi.fn().mockResolvedValue({}),
    status: vi.fn().mockResolvedValue({ status: 'running' }),

    // Provisioning
    provision: vi.fn().mockResolvedValue({
      success: true,
      cloudUrl: 'https://test.fly.dev',
      cloudToken: 'test-token',
      appName: 'test-app',
      machineId: 'machine-1',
      volumeId: 'vol-1',
      region: 'iad',
    }),
    deprovision: vi.fn().mockResolvedValue({ kind: 'remote-removed' }),
    switchProvider: vi.fn().mockResolvedValue({ success: true }),

    // Updates
    checkUpdate: vi.fn().mockResolvedValue({ success: true }),
    applyUpdate: vi.fn().mockResolvedValue({ success: true }),

    // Discovery & conflict resolution
    discoverInstances: vi.fn().mockResolvedValue({
      managed: { exists: false },
      byok: { exists: false, healthy: false },
      conflict: false,
      activeInSettings: 'none' as const,
    }),
    resolveConflict: vi.fn().mockResolvedValue({ success: true }),

    // Fly management
    linkFlyToken: vi.fn().mockResolvedValue({ success: true }),
    repairIngress: vi.fn().mockResolvedValue({ success: true }),
    repairToken: vi.fn().mockResolvedValue({ success: true }),

    // Diagnostics
    exportDiagnostics: vi.fn().mockResolvedValue({ success: true }),

    // DigitalOcean OAuth
    doOauthStatus: vi.fn().mockResolvedValue({ connected: false }),
    doStartOauth: vi.fn().mockResolvedValue({ success: true }),
    doDisconnectOauth: vi.fn().mockResolvedValue({ success: true }),

    // Sharing
    shareList: vi.fn().mockResolvedValue({ success: true, shares: [] }),
    shareRevoke: vi.fn().mockResolvedValue({ success: true }),

    // Outbox
    outboxStatus: vi.fn().mockResolvedValue({ pending: 0, failed: 0 }),

    // Event subscriptions — register callbacks and return unsubscribe fn
    onMigrationProgress: vi.fn((cb: IpcListener) => {
      listeners['onMigrationProgress'] = listeners['onMigrationProgress'] || [];
      listeners['onMigrationProgress'].push(cb);
      return () => {
        listeners['onMigrationProgress'] = (listeners['onMigrationProgress'] || []).filter((l) => l !== cb);
      };
    }),
    onOutboxChanged: vi.fn((cb: IpcListener) => {
      listeners['onOutboxChanged'] = listeners['onOutboxChanged'] || [];
      listeners['onOutboxChanged'].push(cb);
      return () => {
        listeners['onOutboxChanged'] = (listeners['onOutboxChanged'] || []).filter((l) => l !== cb);
      };
    }),
    onContinuityChanged: vi.fn((cb: IpcListener) => {
      listeners['onContinuityChanged'] = listeners['onContinuityChanged'] || [];
      listeners['onContinuityChanged'].push(cb);
      return () => {
        listeners['onContinuityChanged'] = (listeners['onContinuityChanged'] || []).filter((l) => l !== cb);
      };
    }),
  };

  return { api, emit, listeners };
}

// ---------------------------------------------------------------------------
// Mock Settings API
// ---------------------------------------------------------------------------

/** Creates a mock window.settingsApi */
export function createMockSettingsApi() {
  return {
    update: vi.fn().mockResolvedValue(undefined),
  };
}

// ---------------------------------------------------------------------------
// Mock Cloud Continuity API
// ---------------------------------------------------------------------------

/** Creates a mock window.cloudContinuityApi */
export function createMockCloudContinuityApi() {
  return {
    getAll: vi.fn().mockResolvedValue({}),
  };
}

// ---------------------------------------------------------------------------
// Mock Fetch
// ---------------------------------------------------------------------------

export interface MockFetchConfig {
  healthStatus?: 'ok' | 'unhealthy' | 'error';
  healthHttpStatus?: number;
  authHttpStatus?: number;
  healthBody?: Record<string, unknown>;
}

interface MockFetchResponse {
  ok: boolean;
  status: number;
  json: () => Promise<Record<string, unknown>>;
}

/**
 * Creates a configurable fetch mock for /api/health and /api/settings endpoints.
 * Default: healthy endpoint with 200 auth response.
 */
export function createMockFetch(config: MockFetchConfig = {}): (input: RequestInfo | URL, init?: RequestInit) => Promise<MockFetchResponse> {
  const {
    healthStatus = 'ok',
    healthHttpStatus = 200,
    authHttpStatus = 200,
    healthBody,
  } = config;

  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();

    if (url.includes('/api/health')) {
      if (healthHttpStatus !== 200) {
        return { ok: false, status: healthHttpStatus, json: () => Promise.resolve({}) };
      }
      const body = healthBody ?? {
        status: healthStatus,
        version: '1.0.0',
        buildCommit: 'abc1234',
        buildDate: '2026-04-10',
        uptime: 3600,
      };
      return { ok: true, status: 200, json: () => Promise.resolve(body) };
    }

    if (url.includes('/api/settings')) {
      if (authHttpStatus === 401) {
        return { ok: false, status: 401, json: () => Promise.resolve({}) };
      }
      if (authHttpStatus !== 200) {
        return { ok: false, status: authHttpStatus, json: () => Promise.resolve({}) };
      }
      return { ok: true, status: 200, json: () => Promise.resolve({}) };
    }

    return { ok: false, status: 404, json: () => Promise.resolve({}) };
  });
}

// ---------------------------------------------------------------------------
// Default Factories
// ---------------------------------------------------------------------------

/** Creates a default CloudInstanceConfig for testing. */
export function createDefaultCloudInstance(overrides: Partial<CloudInstanceConfig> = {}): CloudInstanceConfig {
  return {
    mode: 'local',
    ...overrides,
  } as CloudInstanceConfig;
}

/** Creates a minimal AppSettings shape sufficient for CloudTab testing. */
export function createDefaultDraftSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    cloudInstance: createDefaultCloudInstance(),
    ...overrides,
  } as AppSettings;
}

/** Creates a connected cloud config for testing. */
export function createConnectedCloudInstance(overrides: Partial<CloudInstanceConfig> = {}): CloudInstanceConfig {
  return createDefaultCloudInstance({
    mode: 'cloud',
    cloudUrl: 'https://test.fly.dev',
    cloudToken: 'test-token-123',
    lastKnownStatus: 'running',
    lastSyncedAt: Date.now(),
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

interface SetupCloudTabMocksOptions {
  cloudApi?: Record<string, unknown>;
  settingsApi?: Record<string, unknown>;
  cloudContinuityApi?: Record<string, unknown>;
  electronEnv?: Record<string, unknown>;
  fetch?: ReturnType<typeof vi.fn>;
}

/** Wire mocks into window globals for testing. */
export function setupCloudTabMocks(options: SetupCloudTabMocksOptions = {}): void {
  const win = window as unknown as Record<string, unknown>;

  if (options.cloudApi) {
    win.cloudApi = options.cloudApi;
  }
  if (options.settingsApi) {
    win.settingsApi = options.settingsApi;
  }
  if (options.cloudContinuityApi) {
    win.cloudContinuityApi = options.cloudContinuityApi;
  }
  if (options.electronEnv) {
    win.electronEnv = options.electronEnv;
  }
  if (options.fetch) {
    vi.stubGlobal('fetch', options.fetch);
  }
}

/** Remove mocks from window globals. */
export function cleanupCloudTabMocks(): void {
  const win = window as unknown as Record<string, unknown>;
  delete win.cloudApi;
  delete win.settingsApi;
  delete win.cloudContinuityApi;
  delete win.electronEnv;
  vi.unstubAllGlobals();
}
