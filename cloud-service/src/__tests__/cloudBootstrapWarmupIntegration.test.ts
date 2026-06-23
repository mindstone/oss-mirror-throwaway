import { EventEmitter } from 'node:events';
import type http from 'node:http';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cloudBootstrapWarmup,
  createCloudBootstrapWarmupServiceForTests,
} from '../services/cloudBootstrapWarmup';

type RequestHandler = (req: http.IncomingMessage, res: http.ServerResponse) => void | Promise<void>;
type UpgradeHandler = (req: http.IncomingMessage, socket: NodeJS.Socket, head: Buffer) => void;
type MockResponse = Omit<http.ServerResponse, 'headersSent'> & {
  headersSent: boolean;
  __jsonPayload?: unknown;
};

const sendJsonMock = vi.hoisted(() => vi.fn(
  (
    res: {
      writeHead: (statusCode: number) => void;
      end: () => void;
      __jsonPayload?: unknown;
    },
    status: number,
    payload: unknown,
  ) => {
    res.__jsonPayload = payload;
    res.writeHead(status);
    res.end();
  },
));
const applyCommonResponseHeadersMock = vi.hoisted(() => vi.fn());
const authorizeMock = vi.hoisted(() => vi.fn(() => true));
const sampleCloudPressureMock = vi.hoisted(() => vi.fn());
const captureExceptionMock = vi.hoisted(() => vi.fn());
// Capturable so individual tests can drive the detailed-health check results
// through the REAL /api/health handler (e.g. simulate a failing critical-prompt
// check and assert basic stays 200/'ok' while detailed escalates to 'critical').
const runAllCloudChecksMock = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => [] as unknown[]));

function createMockResponse(): MockResponse {
  const headers = new Map<string, number | string | readonly string[]>();
  const res = new EventEmitter() as MockResponse;

  res.statusCode = 200;
  res.headersSent = false;
  res.setHeader = ((name: string, value: number | string | readonly string[]): MockResponse => {
    headers.set(name, value);
    return res;
  }) as unknown as typeof res.setHeader;
  res.getHeader = ((name: string) => headers.get(name)) as typeof res.getHeader;
  res.writeHead = ((
    statusCode: number,
    extraHeaders?: http.OutgoingHttpHeaders | http.OutgoingHttpHeader[],
  ): MockResponse => {
    res.statusCode = statusCode;
    if (extraHeaders && !Array.isArray(extraHeaders)) {
      for (const [key, value] of Object.entries(extraHeaders)) {
        if (value !== undefined) {
          headers.set(key, value as number | string | readonly string[]);
        }
      }
    }
    return res;
  }) as unknown as typeof res.writeHead;
  res.end = ((): MockResponse => {
    res.headersSent = true;
    res.emit('finish');
    return res;
  }) as unknown as typeof res.end;

  return res;
}

describe('cloud bootstrap warmup integration', () => {
  let requestHandler: RequestHandler;
  let upgradeHandler: UpgradeHandler;
  let processExitSpy: ReturnType<typeof vi.spyOn>;
  let previousRebelVersion: string | undefined;
  let previousRebelUserData: string | undefined;
  const handleAgentTurnWs = vi.fn();
  const handleEventChannelWs = vi.fn();

  beforeAll(async () => {
    const unresolvedFetch = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal('fetch', unresolvedFetch as unknown as typeof fetch);

    processExitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${String(code)})`);
    }) as never);
    previousRebelVersion = process.env.REBEL_VERSION;
    previousRebelUserData = process.env.REBEL_USER_DATA;
    process.env.REBEL_VERSION = 'test-version';
    process.env.REBEL_USER_DATA = path.join(process.cwd(), '.tmp-cloud-warmup-health');

    const fakeServer = {
      requestTimeout: 0,
      headersTimeout: 0,
      timeout: 0,
      on: vi.fn((event: string, handler: UpgradeHandler) => {
        if (event === 'upgrade') {
          upgradeHandler = handler;
        }
        return fakeServer;
      }),
      listen: vi.fn((_port: number, callback?: () => void) => {
        callback?.();
        return fakeServer;
      }),
      close: vi.fn((callback?: () => void) => {
        callback?.();
      }),
    };

    vi.doMock('../installGracefulFs', () => ({}));
    vi.doMock('../platformInit', () => ({}));
    vi.doMock('node:http', () => ({
      default: {
        createServer: vi.fn((handler: RequestHandler) => {
          requestHandler = handler;
          return fakeServer;
        }),
      },
    }));
    vi.doMock('ws', () => ({
      WebSocketServer: class MockWebSocketServer {
        public readonly clients = new Set();

        handleUpgrade(
          _req: http.IncomingMessage,
          _socket: NodeJS.Socket,
          _head: Buffer,
          callback: (socket: unknown) => void,
        ): void {
          callback({});
        }
      },
    }));
    vi.doMock('../bootstrap', () => ({
      bootstrap: vi.fn(async () => {
        cloudBootstrapWarmup.configure({ superMcpUrl: 'https://super-mcp.example/mcp' });
        return {
          getSettings: () => ({}),
          listSessions: () => [],
          getSession: async () => null,
          upsertSession: async () => undefined,
          getActiveTurnController: () => undefined,
          setEventListener: vi.fn(),
          agentTurnServiceDeps: {
            executeAgentTurn: vi.fn(async () => undefined),
          },
          cleanup: async () => undefined,
        };
      }),
      stopGracefulFsObservability: vi.fn(),
    }));
    vi.doMock('../services/cloudDiagnosticEventsLedger', () => ({
      shutdownCloudDiagnosticEventsLedger: vi.fn(async () => undefined),
    }));
    vi.doMock('../services/cloudRollingTranscript', () => ({
      cloudRollingTranscript: {},
    }));
    vi.doMock('../cloudEventBroadcaster', () => ({
      cloudEventBroadcaster: {
        broadcast: vi.fn(),
        closeAll: vi.fn(),
      },
    }));
    vi.doMock('@core/errorReporter', () => ({
      getErrorReporter: vi.fn(() => ({
        captureException: (...args: unknown[]) => captureExceptionMock(...args),
        addBreadcrumb: vi.fn(),
        captureMessage: vi.fn(),
      })),
    }));
    vi.doMock('../httpUtils', () => ({
      log: vi.fn(),
      sendJson: (
        res: http.ServerResponse,
        status: number,
        data: unknown,
      ) => sendJsonMock(res as Parameters<typeof sendJsonMock>[0], status, data),
      parsePath: (url?: string) => (url || '').split('?')[0].split('/').filter(Boolean),
      sendRouteError: vi.fn((res: http.ServerResponse, _req: http.IncomingMessage | undefined, err: { status?: number }) => {
        res.writeHead(err.status ?? 500);
        res.end();
      }),
      RouteError: class RouteError extends Error {
        public readonly status: number;

        constructor(_code: string, options: { status?: number; message?: string } = {}) {
          super(options.message ?? 'Route error');
          this.status = options.status ?? 500;
        }
      },
    }));
    vi.doMock('../auth', () => ({
      authorize: authorizeMock,
    }));
    vi.doMock('../utils/hmacV2', () => ({
      handleMeetingTranscriptSegmentReceive: vi.fn(async () => undefined),
    }));
    vi.doMock('../webAppServing', () => ({
      serveWebApp: vi.fn(async () => undefined),
      serveWebAppWithOgTags: vi.fn(async () => undefined),
    }));
    vi.doMock('../health/checks', () => ({
      runAllCloudChecks: (...args: unknown[]) => runAllCloudChecksMock(...args),
      resolveRssBudgetMb: vi.fn(async () => 4096),
    }));
    vi.doMock('../health/pressureSampler', () => ({
      sampleCloudPressure: (...args: unknown[]) => sampleCloudPressureMock(...args),
    }));
    vi.doMock('../routes', () => ({
      handleSessions: vi.fn(async () => undefined),
      handleSettings: vi.fn(async () => undefined),
      handleCodexTokens: vi.fn(async () => undefined),
      handleAgentStop: vi.fn(async () => undefined),
      handleAgentTurnWs,
      handleLibrary: vi.fn(async () => undefined),
      handleDataUploadArchive: vi.fn(async () => undefined),
      handleDataReconcile: vi.fn(async () => undefined),
      handleMcpConfig: vi.fn(async () => undefined),
      handleAuthRelay: vi.fn(async () => undefined),
      handleAuthRelayPull: vi.fn(async () => undefined),
      handleGenericIpc: vi.fn(async () => undefined),
      handleEventChannelWs,
      handlePush: vi.fn(async () => undefined),
      handleContinuity: vi.fn(async () => undefined),
      handleVoiceTranscribe: vi.fn(async () => undefined),
      handleVoiceTts: vi.fn(async () => undefined),
      handleFeedback: vi.fn(async () => undefined),
      handleAdmin: vi.fn(async () => undefined),
      handleSharedConversation: vi.fn(async () => undefined),
      handleAppOpen: vi.fn(async () => undefined),
      handleMeetingFallbackAnalysis: vi.fn(async () => undefined),
      handleMeetingRecordingUpload: vi.fn(async () => undefined),
      handleMeetingRecordingStatus: vi.fn(async () => undefined),
      handleMeetingSessionCreate: vi.fn(async () => undefined),
      handleMeetingSessionChunkUpload: vi.fn(async () => undefined),
      handleMeetingSessionStatus: vi.fn(async () => undefined),
      handleMeetingSessionFinalize: vi.fn(async () => undefined),
      handleMeetingSessionCoachActivate: vi.fn(async () => undefined),
      handleMeetingSessionCoachDeactivate: vi.fn(async () => undefined),
    }));
    vi.doMock('../routes/slackWebhook', () => ({ handleSlackWebhook: vi.fn(async () => undefined) }));
    vi.doMock('../routes/slackOAuth', () => ({
      handleSlackOAuthCallback: vi.fn(async () => undefined),
      handleSlackOAuthStartByok: vi.fn(async () => undefined),
      handleSlackOAuthStartManaged: vi.fn(async () => undefined),
      handleSlackWorkspaceDelete: vi.fn(async () => undefined),
      handleSlackWorkspaceGet: vi.fn(async () => undefined),
    }));
    vi.doMock('../routes/slackManaged', () => ({
      handleSlackManagedInbound: vi.fn(async () => undefined),
      handleSlackManagedProvisionTokens: vi.fn(async () => undefined),
    }));
    vi.doMock('../routes/slackRecentSenders', () => ({
      handleSlackRecentSenders: vi.fn(async () => undefined),
      handleSlackRecentSendersClearAll: vi.fn(async () => undefined),
    }));
    vi.doMock('../routes/diagnostics', () => ({
      handleDiagnostics: vi.fn(async () => undefined),
      handleDiagnosticsLogFilePaths: vi.fn(async () => undefined),
      handleDiagnosticsRecentEvents: vi.fn(async () => undefined),
      handleDiagnosticsRecentLogs: vi.fn(async () => undefined),
      handleDiagnosticsSelf: vi.fn(async () => undefined),
    }));
    vi.doMock('../routes/storage', () => ({
      handleStorageUsage: vi.fn(async () => undefined),
    }));
    vi.doMock('../routes/share', () => ({
      handleSharedConversationUnlock: vi.fn(async () => undefined),
      handleSharedFileDownload: vi.fn(async () => undefined),
      handleSharesList: vi.fn(async () => undefined),
      handleFileShare: vi.fn(async () => undefined),
    }));
    vi.doMock('@core/services/shareLinksService', () => ({
      getSharePreviewData: vi.fn(async () => null),
    }));
    vi.doMock('../services/staleBusyReaper', () => ({
      startStaleBusyReaper: vi.fn(),
      stopStaleBusyReaper: vi.fn(),
    }));
    vi.doMock('../services/meetingUploadSessionStoreFactory', () => ({
      createMeetingUploadSessionStore: vi.fn(() => ({
        getCompanionSessionId: vi.fn(() => 'session-1'),
        stop: vi.fn(),
      })),
    }));
    vi.doMock('../services/agentTurnSubmissionService', () => ({
      submitAgentTurnInternal: vi.fn(async () => ({
        turnId: 'turn-1',
        completion: Promise.resolve(),
      })),
    }));
    vi.doMock('../services/meetingQuestionTriggerService', () => ({
      createMeetingQuestionTriggerService: vi.fn(() => ({
        onSegmentAppended: vi.fn(),
        onSessionEnded: vi.fn(async () => undefined),
        dispose: vi.fn(async () => undefined),
      })),
    }));
    vi.doMock('../services/meetingTranscriptionEngine', () => ({
      getRollingTranscript: vi.fn(() => []),
      onSegmentAppended: vi.fn(() => () => {}),
      onTranscriptionSessionCleanup: vi.fn(() => () => {}),
    }));
    vi.doMock('@core/services/audioChunking', () => ({
      checkFfmpegAvailable: vi.fn(async () => true),
      checkFfprobeAvailable: vi.fn(async () => true),
    }));
    vi.doMock('../capabilities', () => ({
      getCloudCapabilities: vi.fn(() => []),
    }));
    vi.doMock('../serverHeaders', () => ({
      applyCommonResponseHeaders: applyCommonResponseHeadersMock,
    }));
    vi.doMock('../services/lastKnownGoodImageTagStore', () => ({
      createLastKnownGoodImageTagStore: vi.fn(() => ({})),
    }));
    vi.doMock('../services/bootStateStore', () => ({
      createBootStateStore: vi.fn(() => ({})),
    }));
    vi.doMock('../services/bootSuccessMarker', () => ({
      scheduleBootSuccessMarker: vi.fn(() => ({ cancel: vi.fn() })),
      DEFAULT_BOOT_GRACE_MS: 5_000,
    }));
    vi.doMock('@core/services/schemaFingerprint', () => ({
      computeSchemaFingerprint: vi.fn(() => 'schema-fingerprint'),
    }));
    vi.doMock('@core/constants', () => ({
      ALL_STORE_VERSIONS: {},
    }));
    vi.doMock('../services/forcedBootCrash', () => ({
      maybeInstallForcedBootCrash: vi.fn(),
    }));
    vi.doMock('@core/services/turnPolicy', () => ({
      derivePolicy: vi.fn(() => ({})),
    }));

    await import('../server');
    await vi.waitFor(() => {
      expect(typeof requestHandler).toBe('function');
      expect(typeof upgradeHandler).toBe('function');
    });
  });

  beforeEach(() => {
    cloudBootstrapWarmup.configure({
      superMcpUrl: 'https://super-mcp.example/mcp',
      idleTriggerMs: 60_000,
      watchdogDelayMs: 65_000,
    });
    sampleCloudPressureMock.mockReset();
    sampleCloudPressureMock.mockResolvedValue({
      state: 'ok',
      oomRecent: false,
      recentRestart: false,
      pressure_state: 'ok',
      rss_mb: 600,
      heap_used_mb: 120,
      heap_total_mb: 300,
      uptime_sec: 120,
      openFdCount: 321,
      recent_restart: false,
      oom_recent: false,
      pressure_window_ms: 30 * 60 * 1000,
      history_status: 'ok',
      rss_budget_mb: 4096,
    });
    runAllCloudChecksMock.mockReset();
    runAllCloudChecksMock.mockResolvedValue([]);
    captureExceptionMock.mockClear();
    sendJsonMock.mockClear();
    applyCommonResponseHeadersMock.mockReset();
    applyCommonResponseHeadersMock.mockImplementation(() => undefined);
    authorizeMock.mockClear();
    authorizeMock.mockImplementation(() => true);
    handleAgentTurnWs.mockClear();
    handleEventChannelWs.mockClear();
    delete process.env.REBEL_SUPPRESS_WARMUP_WATCHDOG;
  });

  afterAll(() => {
    cloudBootstrapWarmup.resetForTests();
    processExitSpy.mockRestore();
    vi.unstubAllGlobals();
    delete process.env.REBEL_SUPPRESS_WARMUP_WATCHDOG;
    if (previousRebelVersion === undefined) {
      delete process.env.REBEL_VERSION;
    } else {
      process.env.REBEL_VERSION = previousRebelVersion;
    }
    if (previousRebelUserData === undefined) {
      delete process.env.REBEL_USER_DATA;
    } else {
      process.env.REBEL_USER_DATA = previousRebelUserData;
    }
  });

  async function invokeHttpRequest(method: string, url: string): Promise<MockResponse> {
    const req = {
      method,
      url,
      headers: { host: 'localhost' },
    } as unknown as http.IncomingMessage;
    const res = createMockResponse();
    await requestHandler(req, res);
    return res;
  }

  function invokeUpgrade(url: string): { destroy: ReturnType<typeof vi.fn>; write: ReturnType<typeof vi.fn> } {
    const socket = {
      destroy: vi.fn(),
      write: vi.fn(),
    };
    const req = {
      url,
      headers: {},
    } as unknown as http.IncomingMessage;
    upgradeHandler(req, socket as unknown as NodeJS.Socket, Buffer.alloc(0));
    return socket;
  }

  it('schedules warmup on first /api/agent/turn websocket upgrade', () => {
    expect(cloudBootstrapWarmup.getState()).toBe('not_scheduled');

    invokeUpgrade('/api/agent/turn?token=test-token');

    expect(cloudBootstrapWarmup.getState()).toBe('scheduled');
    expect(handleAgentTurnWs).toHaveBeenCalledTimes(1);
  });

  it('schedules warmup on first non-health HTTP request', async () => {
    expect(cloudBootstrapWarmup.getState()).toBe('not_scheduled');

    await invokeHttpRequest('POST', '/api/sessions');

    expect(cloudBootstrapWarmup.getState()).not.toBe('not_scheduled');
  });

  it('maps pre-auth async request failures to a RouteError 500 response', async () => {
    applyCommonResponseHeadersMock.mockImplementationOnce(() => {
      throw new Error('pre-auth failure');
    });

    const response = await invokeHttpRequest('POST', '/api/sessions');

    await vi.waitFor(() => {
      expect(response.statusCode).toBe(500);
      expect(response.headersSent).toBe(true);
    });
    expect(authorizeMock).not.toHaveBeenCalled();
  });

  it('does not schedule warmup for health-check HTTP or upgrade requests', async () => {
    await invokeHttpRequest('GET', '/api/health');
    expect(cloudBootstrapWarmup.getState()).toBe('not_scheduled');

    const socket = invokeUpgrade('/api/health');
    expect(cloudBootstrapWarmup.getState()).toBe('not_scheduled');
    expect(socket.destroy).toHaveBeenCalledTimes(1);
  });

  it('keeps basic /api/health live with unknown fallback pressure when sampler throws', async () => {
    sampleCloudPressureMock.mockRejectedValueOnce(new Error('sampler boom'));

    const response = await invokeHttpRequest('GET', '/api/health');
    const payload = response.__jsonPayload as Record<string, unknown>;

    expect(response.statusCode).toBe(200);
    expect(payload).toEqual(expect.objectContaining({
      status: 'ok',
      version: 'test-version',
      pressure: {
        state: 'unknown',
        oomRecent: false,
        recentRestart: false,
      },
    }));
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
  });

  it('omits detailed pressure payload when sampler throws on /api/health?detailed=true', async () => {
    sampleCloudPressureMock.mockRejectedValueOnce(new Error('sampler boom'));

    const response = await invokeHttpRequest('GET', '/api/health?detailed=true');
    const payload = response.__jsonPayload as Record<string, unknown>;

    expect(response.statusCode).toBe(200);
    expect(payload.status).toBe('ok');
    expect(payload.checks).toEqual([]);
    expect(payload).not.toHaveProperty('pressure');
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
  });

  // Option B-lite load-bearing guard, exercised through the REAL /api/health
  // handler in server.ts (not a copied local mapping). A failing critical-prompt
  // check MUST surface on the DETAILED face (status 'critical') while the BASIC
  // face — the Fly/Docker/CI/provisioning liveness gate — stays HTTP 200/'ok'.
  // This pair makes the rejected crash-loop (Option B) failure mode
  // unrepresentable: if someone wired runAllCloudChecks() into the basic branch,
  // the basic assertion below would flip to 'critical' and fail.
  describe('Option B-lite crash-loop guard — basic /api/health stays 200/ok when a critical-prompt check fails', () => {
    const failingCriticalPromptChecks = [
      {
        id: 'cloud-critical-prompts',
        name: 'Critical safety prompts',
        status: 'fail' as const,
        message: '1 critical safety prompt(s) unavailable: safety/public-broadcast',
        details: { failedCriticalIds: ['safety/public-broadcast'] },
        remediation: 'Verify rebel-system/prompts are bundled in the cloud image.',
      },
    ];

    it('BASIC endpoint returns 200/ok even when a critical-prompt check fails (no crash-loop)', async () => {
      runAllCloudChecksMock.mockResolvedValue(failingCriticalPromptChecks);

      const response = await invokeHttpRequest('GET', '/api/health');
      const payload = response.__jsonPayload as Record<string, unknown>;

      // Liveness gate: must stay green regardless of the failing check.
      expect(response.statusCode).toBe(200);
      expect(payload.status).toBe('ok');
      // Basic body never carries the detailed checks.
      expect(payload).not.toHaveProperty('checks');
    });

    it('DETAILED endpoint escalates to critical and names the failing prompt (operator-visible)', async () => {
      runAllCloudChecksMock.mockResolvedValue(failingCriticalPromptChecks);

      const response = await invokeHttpRequest('GET', '/api/health?detailed=true');
      const payload = response.__jsonPayload as Record<string, unknown>;

      // Non-gating: still HTTP 200, but body status escalates so operators see it.
      expect(response.statusCode).toBe(200);
      expect(payload.status).toBe('critical');
      const checks = payload.checks as Array<{ id: string; status: string; message: string }>;
      const promptCheck = checks.find((c) => c.id === 'cloud-critical-prompts');
      expect(promptCheck?.status).toBe('fail');
      expect(promptCheck?.message).toContain('safety/public-broadcast');
    });
  });

  it('suppresses watchdog Sentry capture with REBEL_SUPPRESS_WARMUP_WATCHDOG=1 and keeps transitions working', async () => {
    vi.useFakeTimers();
    process.env.REBEL_SUPPRESS_WARMUP_WATCHDOG = '1';

    const addBreadcrumb = vi.fn();
    const captureMessage = vi.fn();
    const warmup = createCloudBootstrapWarmupServiceForTests({
      scheduler: {
        registerTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
        clear: (timer) => clearTimeout(timer),
        now: () => Date.now(),
      },
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      errorReporter: {
        addBreadcrumb,
        captureMessage,
        captureException: vi.fn(),
      },
      fetchImpl: vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch,
    });

    warmup.configure({
      superMcpUrl: 'https://super-mcp.example/mcp',
      idleTriggerMs: 120_000,
      watchdogDelayMs: 65_000,
    });
    warmup.scheduleIdleTimerAndWatchdog(250);

    await vi.advanceTimersByTimeAsync(65_000);
    expect(captureMessage).not.toHaveBeenCalled();
    expect(addBreadcrumb).toHaveBeenCalledWith(expect.objectContaining({
      message: 'cloud.warmup.watchdog.late',
      data: expect.objectContaining({
        sentrySuppressed: true,
      }),
    }));

    warmup.observeRequest('POST', '/api/sessions', false);
    expect(warmup.getState()).toBe('scheduled');

    vi.useRealTimers();
  });
});
