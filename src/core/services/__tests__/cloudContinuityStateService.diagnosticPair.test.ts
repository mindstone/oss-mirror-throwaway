import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setErrorReporter } from '@core/errorReporter';
import {
  resetDiagnosticEventsLedgerForTests,
  setDiagnosticEventsLedgerWriter,
  setDiagnosticEventsSurface,
} from '@core/services/diagnosticEventsLedger';
import type { DiagnosticEventEntry } from '@core/services/diagnostics/manifest';

import {
  GC_GRACE_WINDOW_MS,
  mergePreservingCloudActive,
  runStateMapGC,
  sanitizeContinuityStateMapInput,
  type CloudContinuityStateEffectSink,
} from '../cloudContinuityStateService';

const breadcrumbs: Array<{ category: string; message: string; data?: Record<string, unknown> }> = [];
const diagnosticEvents: DiagnosticEventEntry[] = [];

function installDiagnosticSpies(): void {
  setErrorReporter({
    captureException: () => {},
    captureMessage: () => {},
    addBreadcrumb: (breadcrumb) => {
      breadcrumbs.push({
        category: breadcrumb.category,
        message: breadcrumb.message,
        data: breadcrumb.data,
      });
    },
  });
  setDiagnosticEventsSurface('cloud');
  setDiagnosticEventsLedgerWriter({
    append: (entry) => {
      diagnosticEvents.push(entry);
    },
  });
}

function continuityEvents(): Array<Extract<DiagnosticEventEntry, { kind: 'continuity_transition' }>> {
  return diagnosticEvents.filter((event): event is Extract<DiagnosticEventEntry, { kind: 'continuity_transition' }> => (
    event.kind === 'continuity_transition'
  ));
}

function makeSink(): CloudContinuityStateEffectSink {
  return { emit: () => {} };
}

describe('cloudContinuityStateService diagnostic breadcrumb pairing', () => {
  beforeEach(() => {
    breadcrumbs.length = 0;
    diagnosticEvents.length = 0;
    resetDiagnosticEventsLedgerForTests();
    installDiagnosticSpies();
  });

  afterEach(() => {
    setErrorReporter({
      captureException: () => {},
      captureMessage: () => {},
      addBreadcrumb: () => {},
    });
    resetDiagnosticEventsLedgerForTests();
    vi.restoreAllMocks();
  });

  it('pairs sanitizer breadcrumbs for incoherent cloud-active removal intent', () => {
    sanitizeContinuityStateMapInput({
      'coherence-guard': {
        state: 'cloud_active',
        cloudRemovalIntent: { requestedAt: 300, requestedBy: 'user' },
      },
    });

    expect(breadcrumbs).toEqual([
      expect.objectContaining({
        category: 'continuity.sanitizer',
        message: 'continuity-intent-incoherent',
        data: expect.objectContaining({ reason: 'cloud-active-with-removal-intent' }),
      }),
    ]);
    expect(continuityEvents()).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          family: 'state',
          message: 'continuity-intent-incoherent',
          reason: 'cloud-active-with-removal-intent',
          level: 'warning',
          sessionIdHash: expect.any(String),
        }),
      }),
    ]);
  });

  it('pairs merge-guard breadcrumbs when incoming demotion lacks removal intent', () => {
    mergePreservingCloudActive(
      { 'shared-session': { state: 'local_only' } },
      { 'shared-session': { state: 'cloud_active', lastCloudActivityAt: 1_000 } },
    );

    expect(breadcrumbs).toEqual([
      expect.objectContaining({
        category: 'continuity.merge-guard',
        message: 'continuity-merge-refused',
        data: expect.objectContaining({ refusal: 'no-intent' }),
      }),
    ]);
    expect(continuityEvents()).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          family: 'state',
          message: 'continuity-merge-refused',
          reason: 'no-intent',
          level: 'warning',
          sessionIdHash: expect.any(String),
        }),
      }),
    ]);
  });

  it('pairs GC guard breadcrumbs for retention-policy visibility-only protection', async () => {
    const old = Date.now() - GC_GRACE_WINDOW_MS - 60_000;

    await runStateMapGC(
      {
        'retention-only': {
          state: 'local_only',
          cloudRemovalIntent: { requestedAt: old, requestedBy: 'retention-policy' },
        },
      },
      {
        listSessions: () => [{ id: 'retention-only', updatedAt: old }],
        deleteSession: async () => {},
      },
      makeSink(),
    );

    expect(breadcrumbs).toEqual([
      expect.objectContaining({
        category: 'continuity.gc-guard',
        message: 'state-map-gc-protected',
        data: expect.objectContaining({ protected: 'retention-policy-visibility-only' }),
      }),
    ]);
    expect(continuityEvents()).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          family: 'state',
          message: 'state-map-gc-protected',
          reason: 'retention-policy-visibility-only',
          level: 'info',
          sessionIdHash: expect.any(String),
        }),
      }),
    ]);
  });

  it('pairs GC guard breadcrumbs for sessions without removal intent', async () => {
    const old = Date.now() - GC_GRACE_WINDOW_MS - 60_000;

    await runStateMapGC(
      { 'no-intent': { state: 'local_only' } },
      {
        listSessions: () => [{ id: 'no-intent', updatedAt: old }],
        deleteSession: async () => {},
      },
      makeSink(),
    );

    expect(breadcrumbs).toEqual([
      expect.objectContaining({
        category: 'continuity.gc-guard',
        message: 'state-map-gc-protected',
        data: expect.objectContaining({ protected: 'no-removal-intent' }),
      }),
    ]);
    expect(continuityEvents()).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          family: 'state',
          message: 'state-map-gc-protected',
          reason: 'no-removal-intent',
          level: 'info',
          sessionIdHash: expect.any(String),
        }),
      }),
    ]);
  });
});
