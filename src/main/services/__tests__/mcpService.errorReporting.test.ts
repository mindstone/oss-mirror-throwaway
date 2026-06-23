import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { initTestPlatformConfig } from '@core/__tests__/testHelpers';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AppSettings } from '@shared/types';

const mockCaptureMainException = vi.fn();
const mockTrackMainEvent = vi.fn();
const mockGetOrGenerateAnonymousId = vi.fn(() => 'test-anon-id');
let mockStartWithRetries: ReturnType<typeof vi.fn>;

describe('MCP error reporting (reportMcpError)', () => {
  let reportMcpError: (
    error: unknown,
    operation: string,
    opts?: {
      serverId?: string;
      level?: 'error' | 'warning';
      extra?: Record<string, unknown>;
      extraTags?: Record<string, string | number | boolean>;
      fingerprintDiscriminators?: string[];
    }
  ) => void;

  let resolveMcpServers: (settings: AppSettings) => Promise<unknown>;
  let getSafeServerName: (serverId: string) => string;

  beforeEach(async () => {
    vi.resetModules();
    await initTestPlatformConfig();
    mockStartWithRetries = vi.fn().mockRejectedValue(new Error('Injected lazy restart failure'));

    vi.doMock('@core/errorReporter', () => ({
      setErrorReporter: vi.fn(),
      getErrorReporter: () => ({
        captureException: mockCaptureMainException,
        captureMessage: vi.fn(),
        addBreadcrumb: vi.fn(),
      }),
    }));
    vi.doMock('../../analytics', () => ({
      trackMainEvent: mockTrackMainEvent,
      getOrGenerateAnonymousId: mockGetOrGenerateAnonymousId,
    }));
    vi.doMock('@core/services/settingsStore', () => ({
      setSettingsStoreAdapter: vi.fn(),
      getSettings: vi.fn(() => ({ mcpConfigFile: null })),
      settingsStore: { store: {} },
    }));
    vi.doMock('../superMcpHttpManager', () => ({
      superMcpHttpManager: {
        getHttpConfig: vi.fn(() => null),
        startWithRetries: mockStartWithRetries,
        getState: vi.fn(() => ({ isRunning: false, url: null, port: null })),
        isConfigured: vi.fn(() => false),
      },
      CircuitBreakerError: class CircuitBreakerError extends Error {},
      findAvailablePort: vi.fn(),
    }));
    vi.doMock('@core/logger', () => ({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      createScopedLogger: vi.fn(() => ({
        info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
      })),
    }));

    mockCaptureMainException.mockReset();
    mockTrackMainEvent.mockReset();
    mockGetOrGenerateAnonymousId.mockReset();
    mockGetOrGenerateAnonymousId.mockReturnValue('test-anon-id');

    // reportMcpError is exported, so test the REAL shipped function (its
    // getErrorReporter()/trackMainEvent()/getOrGenerateAnonymousId deps are
    // mocked above) instead of a re-derived copy — otherwise the fingerprint /
    // backward-compat assertions could pass while production drifts.
    // (Codex final-review F1, REBEL-13Y.)
    const _mod = await import('../mcpService');
    reportMcpError = _mod.reportMcpError;
    resolveMcpServers = _mod.resolveMcpServers;

    // getSafeServerName is a private module helper; re-derive it for its direct
    // unit tests below (pure, low-drift — and also exercised indirectly via the
    // mcp_server tag asserted in the reportMcpError tests).
    const { parseMultiInstanceServer } = await import('@shared/utils/mcpInstanceUtils');
    getSafeServerName = (serverId: string): string => {
      const parsed = parseMultiInstanceServer(serverId);
      return parsed.isInstance && parsed.baseName ? parsed.baseName : serverId;
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getSafeServerName', () => {
    it('strips email slug from multi-instance server names', () => {
      expect(getSafeServerName('GoogleWorkspace-greg-work-com')).toBe('GoogleWorkspace');
    });

    it('strips email slug from HubSpot instance', () => {
      expect(getSafeServerName('HubSpot-alice-example-com')).toBe('HubSpot');
    });

    it('returns original name for non-instance servers', () => {
      expect(getSafeServerName('Slack')).toBe('Slack');
    });

    it('returns original name for custom MCPs', () => {
      expect(getSafeServerName('MyCustomMcp')).toBe('MyCustomMcp');
    });
  });

  describe('reportMcpError', () => {
    it('sends to both Sentry and PostHog', () => {
      reportMcpError(new Error('auth failed'), 'oauth_authenticate', {
        serverId: 'Attio',
      });

      expect(mockCaptureMainException).toHaveBeenCalledOnce();
      expect(mockTrackMainEvent).toHaveBeenCalledOnce();
    });

    it('uses correct Sentry tags and fingerprint', () => {
      reportMcpError(new Error('timeout'), 'oauth_authenticate', {
        serverId: 'GoogleWorkspace-greg-work-com',
      });

      const sentryCall = mockCaptureMainException.mock.calls[0]!;
      const sentryOpts = sentryCall[1];

      expect(sentryOpts.tags).toEqual({
        area: 'mcp',
        mcp_operation: 'oauth_authenticate',
        mcp_server: 'GoogleWorkspace',
      });
      expect(sentryOpts.fingerprint).toEqual(['mcp', 'oauth_authenticate', 'GoogleWorkspace']);
    });

    it('does not include raw serverId in Sentry extras', () => {
      reportMcpError(new Error('fail'), 'oauth_authenticate', {
        serverId: 'GoogleWorkspace-greg-work-com',
      });

      const sentryCall = mockCaptureMainException.mock.calls[0]!;
      const sentryOpts = sentryCall[1];

      expect(sentryOpts.extra).not.toHaveProperty('serverId');
    });

    it('truncates error messages in PostHog to 200 chars', () => {
      const longMessage = 'x'.repeat(300);
      reportMcpError(new Error(longMessage), 'config_read');

      const analyticsCall = mockTrackMainEvent.mock.calls[0]![0];
      expect(analyticsCall.properties.errorMessage).toHaveLength(200);
    });

    it('converts non-Error values to Error', () => {
      reportMcpError('string error', 'config_parse');

      const sentryCall = mockCaptureMainException.mock.calls[0]!;
      expect(sentryCall[0]).toBeInstanceOf(Error);
      expect(sentryCall[0].message).toBe('string error');
    });

    it('includes extra data in Sentry', () => {
      reportMcpError(new Error('fail'), 'config_read', {
        extra: { configPath: '/some/path' },
      });

      const sentryOpts = mockCaptureMainException.mock.calls[0]![1];
      expect(sentryOpts.extra).toEqual({ configPath: '/some/path' });
    });

    it('respects warning level', () => {
      reportMcpError(new Error('fail'), 'list_tools', { level: 'warning' });

      const sentryOpts = mockCaptureMainException.mock.calls[0]![1];
      expect(sentryOpts.level).toBe('warning');

      const analyticsProps = mockTrackMainEvent.mock.calls[0]![0].properties;
      expect(analyticsProps.level).toBe('warning');
    });

    it('keeps legacy fingerprint tuples unchanged for existing callers without discriminators', () => {
      reportMcpError(new Error('legacy-serverid'), 'oauth_authenticate', {
        serverId: 'GoogleWorkspace-greg-work-com',
      });
      reportMcpError(new Error('legacy-no-serverid'), 'config_read');

      const serverIdFingerprint = mockCaptureMainException.mock.calls[0]![1].fingerprint;
      const noServerIdFingerprint = mockCaptureMainException.mock.calls[1]![1].fingerprint;

      expect(serverIdFingerprint).toEqual(['mcp', 'oauth_authenticate', 'GoogleWorkspace']);
      expect(noServerIdFingerprint).toEqual(['mcp', 'config_read', 'unknown']);
    });

    it('appends fingerprintDiscriminators only when explicitly supplied', () => {
      reportMcpError(new Error('base'), 'execute_tool', {
        serverId: 'super-mcp',
      });
      reportMcpError(new Error('with-discriminator'), 'execute_tool', {
        serverId: 'super-mcp',
        fingerprintDiscriminators: ['kind:mcp_error', 'code:-33003'],
      });

      const baseFingerprint = mockCaptureMainException.mock.calls[0]![1].fingerprint;
      const discriminatedFingerprint = mockCaptureMainException.mock.calls[1]![1].fingerprint;

      expect(baseFingerprint).toEqual(['mcp', 'execute_tool', 'super-mcp']);
      expect(discriminatedFingerprint).toEqual([
        'mcp',
        'execute_tool',
        'super-mcp',
        'kind:mcp_error',
        'code:-33003',
      ]);
    });

    it('does not throw when captureMainException throws', () => {
      mockCaptureMainException.mockImplementation(() => {
        throw new Error('Sentry init failed');
      });

      expect(() => {
        reportMcpError(new Error('original error'), 'oauth_authenticate');
      }).not.toThrow();
    });

    it('does not throw when trackMainEvent throws', () => {
      mockTrackMainEvent.mockImplementation(() => {
        throw new Error('RudderStack failed');
      });

      expect(() => {
        reportMcpError(new Error('original error'), 'oauth_authenticate');
      }).not.toThrow();
    });

    it('merges extraTags into Sentry tags without splitting fingerprint unless explicit discriminators are provided', () => {
      reportMcpError(new Error('Not connected'), 'execute_tool', {
        serverId: 'super-mcp',
        extraTags: { mcp_error_kind: 'transport_not_connected' },
      });

      const sentryOpts = mockCaptureMainException.mock.calls[0]![1];
      expect(sentryOpts.tags).toMatchObject({
        area: 'mcp',
        mcp_operation: 'execute_tool',
        mcp_server: 'super-mcp',
        mcp_error_kind: 'transport_not_connected',
      });
      // Fingerprint must NOT be split by tags. Splitting requires the explicit
      // fingerprintDiscriminators seam.
      expect(sentryOpts.fingerprint).toEqual(['mcp', 'execute_tool', 'super-mcp']);
    });

    it('splits fingerprints by labelled kind/code discriminators while keeping stable groups for identical tuples', () => {
      reportMcpError(new Error('first'), 'execute_tool', {
        fingerprintDiscriminators: ['kind:mcp_error', 'code:-33003'],
      });
      reportMcpError(new Error('same'), 'execute_tool', {
        fingerprintDiscriminators: ['kind:mcp_error', 'code:-33003'],
      });
      reportMcpError(new Error('different-code'), 'execute_tool', {
        fingerprintDiscriminators: ['kind:mcp_error', 'code:-33004'],
      });
      reportMcpError(new Error('different-kind'), 'execute_tool', {
        fingerprintDiscriminators: ['kind:transport_not_connected', 'code:-33003'],
      });

      const firstFingerprint = mockCaptureMainException.mock.calls[0]![1].fingerprint;
      const sameFingerprint = mockCaptureMainException.mock.calls[1]![1].fingerprint;
      const diffCodeFingerprint = mockCaptureMainException.mock.calls[2]![1].fingerprint;
      const diffKindFingerprint = mockCaptureMainException.mock.calls[3]![1].fingerprint;

      expect(firstFingerprint).toEqual(sameFingerprint);
      expect(firstFingerprint).not.toEqual(diffCodeFingerprint);
      expect(firstFingerprint).not.toEqual(diffKindFingerprint);
      expect(diffCodeFingerprint).not.toEqual(diffKindFingerprint);
    });

    it('handles undefined serverId gracefully', () => {
      reportMcpError(new Error('fail'), 'describe_config');

      const sentryOpts = mockCaptureMainException.mock.calls[0]![1];
      expect(sentryOpts.tags.mcp_server).toBeUndefined();
      expect(sentryOpts.fingerprint).toEqual(['mcp', 'describe_config', 'unknown']);
    });
  });

  describe('resolveMcpServers router-not-running reporting', () => {
    it('captures the downstream router-not-running error with a stable fingerprint', async () => {
      mockStartWithRetries.mockResolvedValueOnce({
        success: true,
        port: 3131,
        attempts: 1,
      });
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-router-not-running-'));
      const configPath = path.join(tempDir, 'super-mcp-router.json');
      await fs.writeFile(
        configPath,
        JSON.stringify({ superMcpVersion: '1.0', configPaths: [], upstreamServers: {} }),
        'utf8',
      );

      try {
        await expect(resolveMcpServers({
          coreDirectory: tempDir,
          mcpConfigFile: configPath,
          diagnostics: { debugBreadcrumbsUntil: null },
        } as unknown as AppSettings)).rejects.toThrow('Tools are temporarily unavailable');

        const routerCapture = mockCaptureMainException.mock.calls.find(([, context]) => (
          context?.tags?.component === 'resolveSuperMcpRouterEntry'
        ));

        expect(routerCapture).toBeDefined();
        expect(routerCapture?.[0]).toBeInstanceOf(Error);
        expect((routerCapture?.[0] as Error).message).toBe(
          'Tools are temporarily unavailable. Open Settings → Advanced and click "Restart Super-MCP" — if it keeps failing, restart Rebel and use Safe Mode to troubleshoot.',
        );
        expect(routerCapture?.[1].fingerprint).toEqual(['super-mcp', 'router-not-running']);
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });
  });
});
