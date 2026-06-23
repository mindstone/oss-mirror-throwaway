/**
 * Cloud-connection telemetry — Stage 3 of docs/plans/260610_improve-sentry-noise/PLAN.md.
 *
 * Contract under test (Stage 4 amended — degraded is now sink: 'ledger-only'):
 * - "cloud_connection_recovered" NEVER reaches the error reporter as a capture
 *   (diagnostic ledger + breadcrumb only).
 * - "cloud_connection_degraded" goes through captureKnownCondition but the
 *   wrapper's sink policy skips the Sentry capture — ledger + skip breadcrumb
 *   (carrying the transition extras) only.
 * - "degraded_escalated" still captures through the wrapper (warning, stable
 *   fingerprint) and the transition extras survive verbatim.
 * - All helpers are fail-safe (the cooldown observability hooks run on the
 *   reconciler hot path and must never throw).
 *
 * Deliberately uses the REAL captureKnownCondition + KNOWN_CONDITIONS registry
 * (only the reporter/ledger sinks are injected) so registry drift — missing
 * entry, level change, fingerprint rename — fails these tests.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ErrorReporter, ErrorReporterCaptureContext } from '@core/errorReporter';
import { setErrorReporter } from '@core/errorReporter';
import {
  resetDiagnosticEventsLedgerForTests,
  setDiagnosticEventsLedgerWriter,
  setDiagnosticEventsSurface,
  type DiagnosticEventsLedgerWriter,
} from '@core/services/diagnosticEventsLedger';
import type { DiagnosticEventEntry } from '@core/services/diagnostics/manifest';
import {
  captureCloudConnectionDegraded,
  captureCloudConnectionDegradedEscalated,
  recordCloudConnectionRecovered,
  type CloudInstanceObservabilityExtra,
} from '../cloudConnectionTelemetry';
import type {
  CloudFailureCooldownRecoveryContext,
  CloudFailureCooldownTransitionContext,
} from '../cloudFailureCooldown';

const captureException = vi.fn<(error: unknown, context?: ErrorReporterCaptureContext) => void>();
const captureMessage = vi.fn<(message: string, context?: ErrorReporterCaptureContext) => void>();
const addBreadcrumb = vi.fn();

const reporter: ErrorReporter = { captureException, captureMessage, addBreadcrumb };

let ledgerEntries: DiagnosticEventEntry[] = [];
const ledgerWriter: DiagnosticEventsLedgerWriter = {
  append: (entry) => {
    ledgerEntries.push(entry);
  },
};

function knownConditionLedgerEntries(): Array<{ condition: string; level: string }> {
  return ledgerEntries
    .filter((entry) => entry.kind === 'known_condition')
    .map((entry) => entry.data as { condition: string; level: string });
}

const networkTimeout = { kind: 'network', subkind: 'timeout' } as const;

const transitionContext: CloudFailureCooldownTransitionContext = {
  category: networkTimeout,
  writer: 'auto-refresh',
  escalationLevel: 0,
  consecutiveFailures: 3,
};

const recoveryContext: CloudFailureCooldownRecoveryContext = {
  downtimeMs: 95_000,
  ticksToRecovery: 7,
  lastCategory: networkTimeout,
  lastWriter: 'auto-refresh',
};

const instanceExtra: CloudInstanceObservabilityExtra = {
  cloudUrl: 'https://test-app.fly.dev',
  flyAppName: 'test-app',
};

beforeEach(() => {
  vi.clearAllMocks();
  ledgerEntries = [];
  resetDiagnosticEventsLedgerForTests();
  setDiagnosticEventsSurface('desktop');
  setDiagnosticEventsLedgerWriter(ledgerWriter);
  setErrorReporter(reporter);
});

afterEach(() => {
  setDiagnosticEventsLedgerWriter(null);
  resetDiagnosticEventsLedgerForTests();
});

describe('captureCloudConnectionDegraded', () => {
  it('is ledger-only via the Stage-4 sink policy: no Sentry capture; ledger + skip breadcrumb with the transition extras', () => {
    captureCloudConnectionDegraded(transitionContext, instanceExtra);

    // sink: 'ledger-only' in the registry — the wrapper skips the capture.
    expect(captureException).not.toHaveBeenCalled();
    expect(captureMessage).not.toHaveBeenCalled();

    // Wrapper still mirrors the call into the ledger.
    expect(knownConditionLedgerEntries()).toEqual([
      { condition: 'cloud_connection_degraded', level: 'info' },
    ]);

    // The skip breadcrumb carries the transition extras (the ledger records
    // only {condition, level}) onto the next real Sentry event.
    expect(addBreadcrumb).toHaveBeenCalledTimes(1);
    expect(addBreadcrumb).toHaveBeenCalledWith({
      category: 'known_condition',
      message: 'cloud_connection_degraded',
      level: 'info',
      data: {
        category: networkTimeout,
        writer: 'auto-refresh',
        escalationLevel: 0,
        consecutiveFailures: 3,
        cloudUrl: 'https://test-app.fly.dev',
        flyAppName: 'test-app',
        condition: 'cloud_connection_degraded',
        sink: 'ledger-only',
      },
    });
  });
});

describe('captureCloudConnectionDegradedEscalated', () => {
  it('captures through the registry wrapper with stable fingerprint and WARNING level', () => {
    captureCloudConnectionDegradedEscalated(
      { ...transitionContext, escalationLevel: 2, consecutiveFailures: 10 },
      instanceExtra,
    );

    expect(captureException).toHaveBeenCalledTimes(1);
    const [error, context] = captureException.mock.calls[0] as [Error, Record<string, unknown>];
    expect(error.message).toBe('cloud_connection_degraded_escalated');

    expect(context).toMatchObject({
      fingerprint: ['cloud-connection-degraded-escalated'],
      level: 'warning',
      _knownConditionWrapped: true,
    });
    expect(context.extra).toMatchObject({
      escalationLevel: 2,
      consecutiveFailures: 10,
      cloudUrl: 'https://test-app.fly.dev',
    });

    expect(knownConditionLedgerEntries()).toEqual([
      { condition: 'cloud_connection_degraded_escalated', level: 'warning' },
    ]);
  });
});

describe('recordCloudConnectionRecovered', () => {
  it('writes the ledger and a breadcrumb WITHOUT any Sentry capture', () => {
    recordCloudConnectionRecovered(recoveryContext, instanceExtra);

    // The whole point: success telemetry never reaches the issue stream.
    expect(captureException).not.toHaveBeenCalled();
    expect(captureMessage).not.toHaveBeenCalled();

    // Breadcrumb carries the recovery context onto the next real event.
    expect(addBreadcrumb).toHaveBeenCalledTimes(1);
    expect(addBreadcrumb).toHaveBeenCalledWith({
      category: 'cloud.connection',
      message: 'cloud_connection_recovered',
      level: 'info',
      data: {
        downtime_ms: 95_000,
        ticks_to_recovery: 7,
        lastCategory: networkTimeout,
        lastWriter: 'auto-refresh',
        cloudUrl: 'https://test-app.fly.dev',
        flyAppName: 'test-app',
      },
    });

    // Ledger mirror via recordKnownConditionLedgerOnly.
    expect(knownConditionLedgerEntries()).toEqual([
      { condition: 'cloud_connection_recovered', level: 'info' },
    ]);
  });

  it('still writes the ledger and never throws when the breadcrumb sink fails', () => {
    addBreadcrumb.mockImplementationOnce(() => {
      throw new Error('breadcrumb sink down');
    });

    expect(() => recordCloudConnectionRecovered(recoveryContext, {})).not.toThrow();

    expect(knownConditionLedgerEntries()).toEqual([
      { condition: 'cloud_connection_recovered', level: 'info' },
    ]);
    expect(captureException).not.toHaveBeenCalled();
    expect(captureMessage).not.toHaveBeenCalled();
  });
});

describe('fail-safe contract (reconciler hot path)', () => {
  it('no helper throws even when the diagnostic ledger writer fails', () => {
    setDiagnosticEventsLedgerWriter({
      append: () => {
        throw new Error('disk full');
      },
    });

    expect(() => captureCloudConnectionDegraded(transitionContext, instanceExtra)).not.toThrow();
    expect(() =>
      captureCloudConnectionDegradedEscalated(transitionContext, instanceExtra),
    ).not.toThrow();
    expect(() => recordCloudConnectionRecovered(recoveryContext, instanceExtra)).not.toThrow();

    // The escalated Sentry capture still goes out despite ledger failure
    // (degraded + recovered are ledger-only and never capture).
    expect(captureException).toHaveBeenCalledTimes(1);
  });
});

describe('cloudConnectionReconcilerSingleton call sites (source guard)', () => {
  it('routes the connection family through the telemetry helpers — no raw cloud_connection captures remain', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'cloudConnectionReconcilerSingleton.ts'),
      'utf8',
    );

    // Converted hook bodies are present.
    expect(source).toContain('captureCloudConnectionDegraded(');
    expect(source).toContain('captureCloudConnectionDegradedEscalated(');
    expect(source).toContain('recordCloudConnectionRecovered(');

    // The old raw captures are gone (recovered must NOT re-grow a Sentry
    // capture; degraded/escalated must stay registry-owned).
    expect(source).not.toContain("captureMessage('cloud_connection_degraded'");
    expect(source).not.toContain("captureMessage('cloud_connection_degraded_escalated'");
    expect(source).not.toContain("captureMessage('cloud_connection_recovered'");
  });
});
