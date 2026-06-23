/**
 * Stage 3 (260611_calendar-cache-attention): per-account needs-reconnect overlay
 * in `describeMcpConfiguration`.
 *
 * [Claude-MA-1 / GPT-F3] The overlay is applied UNCONDITIONALLY (independent of
 * routerMetadata / skipMetadata) to every emitted server list the panel can
 * consume: `editableServers`, `displayedServers` (summary.servers), and
 * `router.upstreamServers`. Source of truth is Stage 2's
 * `listNeedsReconnectSlugsForMainProcess()`; on `ok: false` the field is
 * omitted entirely (semantically "unknown") + a warn is logged once.
 * [RS-F6] Zero-match canary: store reports ≥1 latched slug but the overlay
 * matched zero server names → count-only warn (never slugs — Sentry breadcrumb
 * privacy).
 *
 * Red→green: against pre-Stage-3 code, `needsReconnect` never appears on any
 * preview, so the flagging tests fail.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initTestPlatformConfig } from '@core/__tests__/testHelpers';
import { buildSettings } from '@core/__tests__/builders';
import type { AppSettings } from '@shared/types';
import type { NeedsReconnectSlugsResult } from '../oauthRefreshFailureStore';

const LATCHED_SLUG = 'GoogleWorkspace-jane-example-com';
const HEALTHY_SLUG = 'GoogleWorkspace-teammember-mindstone-com';

const loggerMock = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
}));

const listSlugsMock = vi.hoisted(() =>
  vi.fn<() => NeedsReconnectSlugsResult>(() => ({ ok: true, slugs: [] })),
);

describe('describeMcpConfiguration — per-account needs-reconnect overlay (Stage 3)', () => {
  let tempDir: string;
  let describeMcpConfiguration: typeof import('../mcpService').describeMcpConfiguration;

  const configPath = (): string => path.join(tempDir, 'super-mcp-router.json');

  const settingsFor = (filePath: string, { forceDirect = false }: { forceDirect?: boolean } = {}): AppSettings =>
    buildSettings({
      mcpConfigFile: filePath,
      diagnostics: {
        ...buildSettings().diagnostics,
        forceDirectMcp: forceDirect,
      },
    });

  const writeConfig = async (config: unknown): Promise<void> => {
    await fs.writeFile(configPath(), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  };

  const twoAccountConfig = {
    mcpServers: {
      [LATCHED_SLUG]: {
        command: 'npx',
        args: ['-y', '@mindstone/mcp-server-google-workspace@0.1.3'],
        email: 'jane@example.com',
      },
      [HEALTHY_SLUG]: {
        command: 'npx',
        args: ['-y', '@mindstone/mcp-server-google-workspace@0.1.3'],
        email: '[Mindstone-email]',
      },
    },
  };

  beforeEach(async () => {
    vi.resetModules();
    listSlugsMock.mockReset();
    listSlugsMock.mockReturnValue({ ok: true, slugs: [] });
    for (const fn of Object.values(loggerMock)) fn.mockClear();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-needs-reconnect-'));
    await initTestPlatformConfig({ userDataPath: tempDir });

    vi.doMock('@core/logger', () => ({
      logger: loggerMock,
      createScopedLogger: vi.fn(() => loggerMock),
    }));

    vi.doMock('../superMcpHttpManager', () => ({
      superMcpHttpManager: {
        getState: vi.fn(() => ({ isRunning: true, url: 'http://127.0.0.1:39990/mcp', port: 39990 })),
        // Non-null http config so resolveSuperMcpRouterEntry resolves without
        // attempting a live router start (it THROWS when unavailable, which
        // would mask the overlay under a status: 'error' summary).
        getHttpConfig: vi.fn(() => ({ type: 'http', url: 'http://127.0.0.1:39990/mcp' })),
        isConfigured: vi.fn(() => true),
        startWithRetries: vi.fn(async () => ({ success: true })),
      },
      CircuitBreakerError: class CircuitBreakerError extends Error {},
      findAvailablePort: vi.fn(),
    }));

    vi.doMock('../oauthRefreshFailureStore', () => ({
      listNeedsReconnectSlugsForMainProcess: listSlugsMock,
    }));

    const mod = await import('../mcpService');
    describeMcpConfiguration = mod.describeMcpConfiguration;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  /** Every warn call serialized — used to prove no slug/email fragment leaks. */
  const serializedWarns = (): string =>
    loggerMock.warn.mock.calls.map((call) => JSON.stringify(call)).join('\n');

  it('flags the latched server (and only it) on editableServers AND displayedServers in super-mcp mode with skipMetadata: true', async () => {
    listSlugsMock.mockReturnValue({ ok: true, slugs: [LATCHED_SLUG] });
    await writeConfig(twoAccountConfig);

    const summary = await describeMcpConfiguration(settingsFor(configPath()), true);

    expect(summary.status).toBe('ready');
    expect(summary.mode).toBe('super-mcp');

    const editableLatched = summary.editableServers?.find((s) => s.name === LATCHED_SLUG);
    const editableHealthy = summary.editableServers?.find((s) => s.name === HEALTHY_SLUG);
    expect(editableLatched?.needsReconnect).toBe(true);
    expect(editableHealthy?.needsReconnect).toBeUndefined();

    // displayedServers (summary.servers) is what the panel consumes in super-mcp mode
    const displayedLatched = summary.servers.find((s) => s.name === LATCHED_SLUG);
    expect(displayedLatched?.needsReconnect).toBe(true);
  });

  it('flags matching entries in router.upstreamServers', async () => {
    listSlugsMock.mockReturnValue({ ok: true, slugs: [LATCHED_SLUG] });
    await writeConfig({
      ...twoAccountConfig,
      upstreamServers: {
        [LATCHED_SLUG]: {
          command: 'npx',
          args: ['-y', '@mindstone/mcp-server-google-workspace@0.1.3'],
        },
      },
    });

    const summary = await describeMcpConfiguration(settingsFor(configPath()), true);

    expect(summary.router).toBeTruthy();
    const upstreamLatched = summary.router?.upstreamServers.find((s) => s.name === LATCHED_SLUG);
    expect(upstreamLatched?.needsReconnect).toBe(true);
  });

  it('applies the overlay in direct (forced) mode too — independent of router metadata paths', async () => {
    listSlugsMock.mockReturnValue({ ok: true, slugs: [LATCHED_SLUG] });
    await writeConfig(twoAccountConfig);

    const summary = await describeMcpConfiguration(settingsFor(configPath(), { forceDirect: true }), true);

    expect(summary.mode).toBe('direct');
    const editableLatched = summary.editableServers?.find((s) => s.name === LATCHED_SLUG);
    expect(editableLatched?.needsReconnect).toBe(true);
    const displayedLatched = summary.servers.find((s) => s.name === LATCHED_SLUG);
    expect(displayedLatched?.needsReconnect).toBe(true);
    const displayedHealthy = summary.servers.find((s) => s.name === HEALTHY_SLUG);
    expect(displayedHealthy?.needsReconnect).toBeUndefined();
  });

  it('omits the field entirely on a failed store read (ok: false) and logs once without slugs', async () => {
    listSlugsMock.mockReturnValue({ ok: false, reason: 'read-error' });
    await writeConfig(twoAccountConfig);

    const summary = await describeMcpConfiguration(settingsFor(configPath()), true);

    for (const server of [...(summary.editableServers ?? []), ...summary.servers]) {
      expect(server.needsReconnect).toBeUndefined();
    }
    const readErrorWarns = loggerMock.warn.mock.calls.filter((call) =>
      JSON.stringify(call).includes('needs-reconnect'),
    );
    expect(readErrorWarns.length).toBeGreaterThanOrEqual(1);
    expect(serializedWarns()).not.toContain(LATCHED_SLUG);
    expect(serializedWarns()).not.toContain('provenance');

    // "log once": a second describe call must not re-log the same degradation
    loggerMock.warn.mockClear();
    await describeMcpConfiguration(settingsFor(configPath()), true);
    const repeatWarns = loggerMock.warn.mock.calls.filter((call) =>
      JSON.stringify(call).includes('needs-reconnect'),
    );
    expect(repeatWarns).toHaveLength(0);
  });

  it('[RS-F6] warns (count only, never slugs) when ≥1 latched slug matches zero server names', async () => {
    listSlugsMock.mockReturnValue({ ok: true, slugs: ['GoogleWorkspace-gone-account'] });
    await writeConfig(twoAccountConfig);

    const summary = await describeMcpConfiguration(settingsFor(configPath()), true);

    for (const server of [...(summary.editableServers ?? []), ...summary.servers]) {
      expect(server.needsReconnect).toBeUndefined();
    }
    const canaryWarns = loggerMock.warn.mock.calls.filter((call) =>
      JSON.stringify(call).includes('matched no MCP server'),
    );
    expect(canaryWarns).toHaveLength(1);
    expect(JSON.stringify(canaryWarns[0])).toContain('"latchedCount":1');
    expect(serializedWarns()).not.toContain('gone-account');
  });

  it('does not warn the zero-match canary when the store is legitimately empty', async () => {
    listSlugsMock.mockReturnValue({ ok: true, slugs: [] });
    await writeConfig(twoAccountConfig);

    await describeMcpConfiguration(settingsFor(configPath()), true);

    const canaryWarns = loggerMock.warn.mock.calls.filter((call) =>
      JSON.stringify(call).includes('matched no MCP server'),
    );
    expect(canaryWarns).toHaveLength(0);
  });
});

/**
 * Phase 6 refinement (general reviewer F1) — REAL-path read-error contract.
 *
 * The block above mocks `listNeedsReconnectSlugsForMainProcess`, which is
 * exactly how the original double-log escaped: the accessor ALSO logged on
 * every read failure before returning `{ ok: false }`, so production got two
 * warns on first failure and a fresh accessor warn on every later summary
 * poll. Here the REAL accessor module runs; only `@core/storeFactory` is
 * mocked, and only for the `oauth-refresh-failures` store (throwing `.store`
 * getter — every other store in the mcpService import graph stays real).
 * Contract proven: read failure → field omitted on all lists + EXACTLY ONE
 * warn across repeated summary polls.
 */
describe('describeMcpConfiguration — needs-reconnect read-error, REAL accessor path (Phase 6 F1)', () => {
  let tempDir: string;
  let describeMcpConfiguration: typeof import('../mcpService').describeMcpConfiguration;

  const configPath = (): string => path.join(tempDir, 'super-mcp-router.json');

  const settingsFor = (filePath: string): AppSettings => buildSettings({ mcpConfigFile: filePath });

  // [Stage 4 F1] Non-empty `upstreamServers` (incl. a slug the store would
  // latch) so the "omitted on router.upstreamServers" assertion below is
  // exercised against real entries instead of an empty list.
  const twoAccountConfig = {
    mcpServers: {
      [LATCHED_SLUG]: {
        command: 'npx',
        args: ['-y', '@mindstone/mcp-server-google-workspace@0.1.3'],
        email: 'jane@example.com',
      },
      [HEALTHY_SLUG]: {
        command: 'npx',
        args: ['-y', '@mindstone/mcp-server-google-workspace@0.1.3'],
        email: '[Mindstone-email]',
      },
    },
    upstreamServers: {
      [LATCHED_SLUG]: {
        command: 'npx',
        args: ['-y', '@mindstone/mcp-server-google-workspace@0.1.3'],
      },
    },
  };

  beforeEach(async () => {
    vi.resetModules();
    for (const fn of Object.values(loggerMock)) fn.mockClear();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-needs-reconnect-real-'));
    await initTestPlatformConfig({ userDataPath: tempDir });

    vi.doMock('@core/logger', () => ({
      logger: loggerMock,
      createScopedLogger: vi.fn(() => loggerMock),
    }));

    vi.doMock('../superMcpHttpManager', () => ({
      superMcpHttpManager: {
        getState: vi.fn(() => ({ isRunning: true, url: 'http://127.0.0.1:39990/mcp', port: 39990 })),
        getHttpConfig: vi.fn(() => ({ type: 'http', url: 'http://127.0.0.1:39990/mcp' })),
        isConfigured: vi.fn(() => true),
        startWithRetries: vi.fn(async () => ({ success: true })),
      },
      CircuitBreakerError: class CircuitBreakerError extends Error {},
      findAvailablePort: vi.fn(),
    }));

    // NOT mocking ../oauthRefreshFailureStore — the real accessor runs.
    // (doUnmock is required: the doMock registered by the block above
    // survives vi.resetModules and would otherwise still apply here.)
    vi.doUnmock('../oauthRefreshFailureStore');
    // Force the accessor's (lazily created) backing store, and ONLY it, to
    // throw on read.
    vi.doMock('@core/storeFactory', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@core/storeFactory')>();
      const createStore = ((options: { name: string }) => {
        if (options.name === 'oauth-refresh-failures') {
          return {
            get store(): never {
              throw new Error('boom: latch store unreadable');
            },
            set store(_v: unknown) {
              /* no-op */
            },
            get: () => undefined,
            set: () => undefined,
            has: () => false,
            delete: () => undefined,
            clear: () => undefined,
            path: path.join(tempDir, 'throwing.json'),
          };
        }
        return actual.createStore(options as Parameters<typeof actual.createStore>[0]);
      }) as typeof actual.createStore;
      return { ...actual, createStore };
    });

    const mod = await import('../mcpService');
    describeMcpConfiguration = mod.describeMcpConfiguration;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.doUnmock('@core/storeFactory');
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('omits the field on ALL lists and warns EXACTLY ONCE across repeated polls (no accessor-level log)', async () => {
    await fs.writeFile(configPath(), `${JSON.stringify(twoAccountConfig, null, 2)}\n`, 'utf8');

    const summary = await describeMcpConfiguration(settingsFor(configPath()), true);

    expect(summary.status).toBe('ready');
    // Guard against a vacuous loop: all three lists must actually carry the
    // would-be-latched server (upstreamServers via the fixture's
    // `upstreamServers` block).
    const upstreamServers = summary.router?.upstreamServers ?? [];
    expect(upstreamServers.some((s) => s.name === LATCHED_SLUG)).toBe(true);
    expect(summary.editableServers?.some((s) => s.name === LATCHED_SLUG)).toBe(true);
    expect(summary.servers.some((s) => s.name === LATCHED_SLUG)).toBe(true);
    for (const server of [...(summary.editableServers ?? []), ...summary.servers, ...upstreamServers]) {
      expect(server.needsReconnect).toBeUndefined();
    }

    const readErrorWarns = () =>
      loggerMock.warn.mock.calls.filter((call) => JSON.stringify(call).includes('needs-reconnect'));
    // Single-log contract: pre-fix, the REAL accessor logged too → 2 warns here.
    expect(readErrorWarns()).toHaveLength(1);

    // Later summary polls during the same degradation episode stay silent
    // (pre-fix, the accessor re-logged on every poll).
    await describeMcpConfiguration(settingsFor(configPath()), true);
    await describeMcpConfiguration(settingsFor(configPath()), true);
    expect(readErrorWarns()).toHaveLength(1);

    // Privacy: the warn carries no slugs/emails.
    const serialized = loggerMock.warn.mock.calls.map((call) => JSON.stringify(call)).join('\n');
    expect(serialized).not.toContain(LATCHED_SLUG);
    expect(serialized).not.toContain('provenance');
  });
});
