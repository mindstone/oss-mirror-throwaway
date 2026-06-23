import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

import { setErrorReporter } from '@core/errorReporter';
import {
  resetDiagnosticEventsLedgerForTests,
  setDiagnosticEventsLedgerWriter,
  setDiagnosticEventsSurface,
} from '@core/services/diagnosticEventsLedger';
import type { DiagnosticEventEntry } from '@core/services/diagnostics/manifest';
import type { AgentSession } from '@shared/types';

 
vi.mock('@main/utils/dataPaths', () => ({
  getDataPath: () => '/tmp/test-cloud-continuity-meta-diagnostic-pair',
}));

const mockInvariantGetSession = vi.fn();
 
vi.mock('../../incrementalSessionStore', () => ({
  getIncrementalSessionStore: () => ({
    getSession: mockInvariantGetSession,
  }),
}));

import {
  _resetForTesting,
  markCloudActive,
  markLocalOnly,
  recordTurnPersistenceAckStatus,
  setContinuityState,
} from '../cloudContinuityMetadata';

const META_PATH = path.join('/tmp/test-cloud-continuity-meta-diagnostic-pair', 'sessions', 'cloud-continuity-meta.json');
const breadcrumbs: Array<{ category: string; message: string; data?: Record<string, unknown> }> = [];
const diagnosticEvents: DiagnosticEventEntry[] = [];

function makeInvariantSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: 'session-invariant',
    title: 'Invariant Session',
    createdAt: 1_000,
    updatedAt: 2_000,
    messages: [],
    eventsByTurn: {},
    activeTurnId: null,
    isBusy: false,
    lastError: null,
    resolvedAt: null,
    ...overrides,
  };
}

async function flushPromises(iterations = 8): Promise<void> {
  for (let i = 0; i < iterations; i += 1) {
    await Promise.resolve();
  }
}

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
  setDiagnosticEventsSurface('desktop');
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

describe('cloudContinuityMetadata diagnostic breadcrumb pairing', () => {
  beforeEach(() => {
    _resetForTesting();
    mockInvariantGetSession.mockReset();
    breadcrumbs.length = 0;
    diagnosticEvents.length = 0;
    resetDiagnosticEventsLedgerForTests();
    installDiagnosticSpies();
    try { fs.rmSync(path.dirname(META_PATH), { recursive: true, force: true }); } catch { /* ok */ }
  });

  afterEach(() => {
    _resetForTesting();
    setErrorReporter({
      captureException: () => {},
      captureMessage: () => {},
      addBreadcrumb: () => {},
    });
    resetDiagnosticEventsLedgerForTests();
    try { fs.rmSync(path.dirname(META_PATH), { recursive: true, force: true }); } catch { /* ok */ }
    vi.restoreAllMocks();
  });

  it('pairs state-transition helper breadcrumbs once per transition with the correct reason', () => {
    markCloudActive('session-first');

    markCloudActive('session-disabled');
    markLocalOnly('session-disabled', 'cloud-disabled', 'inferred');

    markLocalOnly('session-enabled', 'manual-reset', 'user');
    markCloudActive('session-enabled', 'cloud-enabled');

    markCloudActive('session-manual');
    setContinuityState('session-manual', 'local_only');

    const transitionBreadcrumbs = breadcrumbs.filter((breadcrumb) => breadcrumb.message === 'state-transition');
    const transitionEvents = continuityEvents().filter((event) => event.data.message === 'state-transition');

    expect(transitionEvents).toHaveLength(transitionBreadcrumbs.length);
    expect(transitionEvents).toHaveLength(6);
    expect(transitionEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        data: expect.objectContaining({
          family: 'metadata',
          message: 'state-transition',
          reason: 'first-cloud-sync',
          sessionIdHash: expect.any(String),
        }),
      }),
      expect.objectContaining({
        data: expect.objectContaining({
          family: 'metadata',
          message: 'state-transition',
          reason: 'cloud-disabled',
          sessionIdHash: expect.any(String),
        }),
      }),
      expect.objectContaining({
        data: expect.objectContaining({
          family: 'metadata',
          message: 'state-transition',
          reason: 'cloud-enabled',
          sessionIdHash: expect.any(String),
        }),
      }),
      expect.objectContaining({
        data: expect.objectContaining({
          family: 'metadata',
          message: 'state-transition',
          reason: 'manual-reset',
          sessionIdHash: expect.any(String),
        }),
      }),
    ]));
  });

  it('pairs invariant-violation helper breadcrumbs without a reason', async () => {
    recordTurnPersistenceAckStatus('session-acked', 'turn-acked-1', 'in_flight');
    mockInvariantGetSession.mockResolvedValueOnce(makeInvariantSession({
      id: 'session-acked',
      activeTurnId: 'turn-acked-1',
    }));

    markCloudActive('session-acked');
    await flushPromises();

    expect(breadcrumbs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        category: 'continuity.continuity-state',
        message: 'invariant-violation',
        data: expect.objectContaining({
          invariant: 'cloud-active-requires-acked-turn-id',
          sessionIdHash: expect.any(String),
        }),
      }),
    ]));
    const invariantEvents = continuityEvents().filter((event) => event.data.message === 'invariant-violation');
    expect(invariantEvents).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          family: 'metadata',
          message: 'invariant-violation',
          level: 'error',
          sessionIdHash: expect.any(String),
        }),
      }),
    ]);
    expect(invariantEvents[0]?.data).not.toHaveProperty('reason');
  });

  it('pairs intent-cleared breadcrumbs for cloud-active promotion', () => {
    markLocalOnly('session-intent-clear', 'manual-reset', 'user');
    breadcrumbs.length = 0;
    diagnosticEvents.length = 0;

    markCloudActive('session-intent-clear');

    expect(breadcrumbs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        category: 'continuity.intent-cleared',
        message: 'cloud-removal-intent-cleared',
        data: expect.objectContaining({
          previousIntent: expect.objectContaining({
            requestedBy: 'user',
            requestedAt: expect.any(Number),
          }),
          reason: 'cloud-active-promotion',
          sessionIdHash: expect.any(String),
        }),
      }),
    ]));
    const intentClearedEvents = continuityEvents().filter((event) => event.data.message === 'cloud-removal-intent-cleared');
    expect(intentClearedEvents).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          family: 'metadata',
          message: 'cloud-removal-intent-cleared',
          reason: 'cloud-active-promotion',
          sessionIdHash: expect.any(String),
        }),
      }),
    ]);
  });
});
