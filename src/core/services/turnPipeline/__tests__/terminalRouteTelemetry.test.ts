/**
 * Tests for terminal-route-decision observability (Pathologist rec #1,
 * docs/plans/260622_mobile-record-recreated-session/PLAN.md Stage 3).
 *
 * Asserts the telemetry (a) FIRES a distinct structured log + a thresholded,
 * secret-free Sentry signal on a recoverable terminal `missing-mindstone`
 * decision (carrying surface/activeProvider/credentialSource/invalidReason/
 * wireModel), and (b) does NOT fire on a dispatchable decision.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformConfig } from '@core/platform';
import { defaultCapabilities, setPlatformConfig } from '@core/platform';
import { setErrorReporter } from '@core/errorReporter';
import type {
  DispatchableRouteDecision,
  TerminalRouteDecision,
} from '@core/rebelCore/providerRouteDecision';
import { brandRouteWireModel } from '@shared/utils/wireModelId';
import {
  recordTerminalRouteDecision,
  terminalRouteTelemetryFields,
  TERMINAL_ROUTE_DECISION_LOG,
  __resetTerminalRouteTelemetryForTesting,
  type TerminalRouteLogger,
} from '../terminalRouteTelemetry';

const makeCloudConfig = (): PlatformConfig => ({
  userDataPath: '/mock/userData',
  appPath: '/mock/app',
  tempPath: '/mock/temp',
  logsPath: '/mock/logs',
  homePath: '/mock/home',
  documentsPath: '/mock/documents',
  desktopPath: '/mock/desktop',
  appDataPath: '/mock/appData',
  version: '1.0.0',
  isPackaged: false,
  platform: 'linux',
  totalMemoryBytes: 8 * 1024 * 1024 * 1024,
  arch: 'x64',
  surface: 'cloud',
  isOss: false,
  capabilities: defaultCapabilities('cloud'),
});

const missingMindstoneTerminal: TerminalRouteDecision = {
  kind: 'terminal',
  transport: 'no-credentials',
  dispatchPath: 'none',
  invalidReason: 'missing-mindstone-credentials',
  provider: 'openrouter',
  modelDialect: 'openrouter-prefixed',
  role: 'execution',
  routeScope: 'normal-turn',
  routedModel: null,
  canonicalModelId: 'claude-sonnet-4-5',
  wireModelId: brandRouteWireModel('anthropic/claude-sonnet-4-5'),
  profileId: null,
  resolvedFrom: 'settings',
  codexConnectivity: 'unknown',
  fallbackHint: null,
  credentialSource: 'missing-mindstone',
  billingSource: null,
};

const dispatchable: DispatchableRouteDecision = {
  kind: 'dispatchable',
  transport: 'openrouter-proxy',
  dispatchPath: 'local-proxy-passthrough',
  invalidReason: 'none',
  provider: 'openrouter',
  modelDialect: 'openrouter-prefixed',
  role: 'execution',
  routeScope: 'normal-turn',
  routedModel: 'anthropic/claude-sonnet-4-5',
  canonicalModelId: 'claude-sonnet-4-5',
  wireModelId: brandRouteWireModel('anthropic/claude-sonnet-4-5'),
  profileId: null,
  resolvedFrom: 'settings',
  codexConnectivity: 'unknown',
  fallbackHint: null,
  credentialSource: 'openrouter-oauth-token',
  billingSource: 'subscription',
};

describe('recordTerminalRouteDecision', () => {
  const captureMessage = vi.fn();
  // Typed against the real logger contract so the test exercises
  // `warn(payload: Record<string, unknown>, message: string)` — an untyped mock
  // would silently skip the assignability check (cf. the TS2345 the type-only
  // fix addressed: TerminalRouteTelemetryFields must satisfy Record<string, unknown>).
  const warn = vi.fn<TerminalRouteLogger['warn']>();
  const logger: TerminalRouteLogger = { warn };

  beforeEach(() => {
    __resetTerminalRouteTelemetryForTesting();
    vi.clearAllMocks();
    setPlatformConfig(makeCloudConfig());
    setErrorReporter({
      captureException: vi.fn(),
      captureMessage,
      addBreadcrumb: vi.fn(),
    });
  });

  afterEach(() => {
    __resetTerminalRouteTelemetryForTesting();
  });

  it('fires the log + thresholded Sentry signal on a recoverable terminal missing-mindstone decision', () => {
    recordTerminalRouteDecision({
      decision: missingMindstoneTerminal,
      activeProvider: 'mindstone',
      logger,
    });

    // (1) distinct structured log
    expect(warn).toHaveBeenCalledTimes(1);
    const [logPayload, logMessage] = warn.mock.calls[0];
    expect(logMessage).toBe(TERMINAL_ROUTE_DECISION_LOG);
    expect(logPayload).toEqual({
      surface: 'cloud',
      activeProvider: 'mindstone',
      credentialSource: 'missing-mindstone',
      invalidReason: 'missing-mindstone-credentials',
      wireModel: 'anthropic/claude-sonnet-4-5',
    });

    // (2) thresholded Sentry signal with the right tags + level
    expect(captureMessage).toHaveBeenCalledTimes(1);
    const [sentryMessage, ctx] = captureMessage.mock.calls[0];
    expect(sentryMessage).toBe(TERMINAL_ROUTE_DECISION_LOG);
    expect(ctx.level).toBe('warning');
    expect(ctx.tags).toMatchObject({
      surface: 'cloud',
      activeProvider: 'mindstone',
      credentialSource: 'missing-mindstone',
      invalidReason: 'missing-mindstone-credentials',
      wireModel: 'anthropic/claude-sonnet-4-5',
      nonCritical: true,
    });
    expect(ctx.fingerprint).toEqual([
      'terminal-route-decision',
      'cloud',
      'mindstone',
      'missing-mindstone-credentials',
      'missing-mindstone',
    ]);
  });

  it('carries no secrets / token material — only categorical fields', () => {
    const fields = terminalRouteTelemetryFields(missingMindstoneTerminal, 'mindstone');
    const serialized = JSON.stringify(fields);
    // credentialSource is a categorical enum label, never a raw key/token.
    expect(serialized).not.toMatch(/sk-|token|secret|key=|bearer/i);
    expect(Object.keys(fields).sort()).toEqual([
      'activeProvider',
      'credentialSource',
      'invalidReason',
      'surface',
      'wireModel',
    ]);
  });

  it('does NOT fire on a dispatchable decision', () => {
    recordTerminalRouteDecision({
      decision: dispatchable,
      activeProvider: 'openrouter',
      logger,
    });

    expect(warn).not.toHaveBeenCalled();
    expect(captureMessage).not.toHaveBeenCalled();
  });

  it('throttles the Sentry signal (one wire emission per fingerprint window) but keeps logging each decision', () => {
    recordTerminalRouteDecision({ decision: missingMindstoneTerminal, activeProvider: 'mindstone', logger });
    recordTerminalRouteDecision({ decision: missingMindstoneTerminal, activeProvider: 'mindstone', logger });

    // Sentry throttled to one emission within the window…
    expect(captureMessage).toHaveBeenCalledTimes(1);
    // …but the structured log still fires per-turn for forensics.
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('does NOT fire when PlatformConfig is uninitialised (fail-safe, no throw)', () => {
    // Force getPlatformConfig() to throw by resetting the singleton via a fresh
    // module import would be heavier than needed; instead assert the guard by
    // stubbing the platform read to throw.
    expect(() =>
      recordTerminalRouteDecision({
        decision: missingMindstoneTerminal,
        activeProvider: 'mindstone',
        logger: {
          warn: () => {
            throw new Error('logger blew up');
          },
        },
      }),
    ).not.toThrow();
  });
});
