// Stage 19c — thread real (envelope) provenance into the BACKGROUND routing
// path (`processHistoryEvent`).
//
// Before 19c, `processHistoryEvent` validated a background-routed event with NO
// `eventSessionId` provenance, so the validator fell back to `event.sessionId`.
// Most background variants (status/assistant/etc.) carry none → every such
// event landed as `accepted-legacy` and was WRITTEN, even if it had actually
// originated from a foreign session. 19c threads the envelope `eventSessionId`
// (independent of the routing target) so a foreign-routed background event is
// REJECTED, while a legitimate background event still writes.
//
// The foreground sibling (`processEvent`, engine ~L941) already threads this;
// 19c restores foreground/background symmetry.
//
// Observable signal: a LOADED background session buffers non-terminal events via
// `bufferBackgroundEvent` (drained by `takeBackgroundEventBuffer`). An accepted
// event appears in the buffer; a dropped event leaves the buffer empty. We use a
// `status` event with NO event-stamped `sessionId` so the ONLY provenance is the
// threaded `eventSessionId` — making this a RED-without-fix test: remove the
// threading and the foreign event reverts to `accepted-legacy` (written), which
// fails the rejection assertion.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@shared/types';

const { captureRendererMessage, recordRendererBreadcrumb } = vi.hoisted(() => ({
  captureRendererMessage: vi.fn(),
  recordRendererBreadcrumb: vi.fn(),
}));

vi.mock('@renderer/src/sentry', () => ({
  captureRendererMessage,
  recordRendererBreadcrumb,
  captureRendererException: vi.fn(),
}));

import {
  createSessionStore,
  takeBackgroundEventBuffer,
  __resetValidationOutcomeReportingForTest,
} from '../sessionStore';
import {
  __resetEventSessionValidationDiagnosticsForTest,
  getEventSessionValidationDiagnostics,
} from '@shared/utils/eventSessionValidation';

// A `status` event with NO event-stamped `sessionId`: provenance can ONLY come
// from the threaded `eventSessionId` arg. This is the variant that, pre-19c,
// always classified as `accepted-legacy` on the background path.
const bareStatusEvent = (message: string): AgentEvent =>
  ({ type: 'status', message, timestamp: Date.now() }) as AgentEvent;

function loadBackgroundSession(
  store: ReturnType<typeof createSessionStore>,
  sessionId: string,
): void {
  // `createBackgroundSession` inserts a loaded session (so `processHistoryEvent`
  // takes the LOADED branch and buffers non-terminal events).
  store.getState().createBackgroundSession(sessionId, 'manual');
}

describe('Stage 19c — background routing path threads envelope provenance', () => {
  const TARGET = 'session-bg-target';
  const FOREIGN = 'session-foreign-origin';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('window', {
      sessionsApi: {
        get: vi.fn().mockResolvedValue(null),
        upsert: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
        list: vi.fn().mockResolvedValue([]),
      },
      agentApi: {
        stopTurn: vi.fn().mockResolvedValue(undefined),
      },
    });
    // Drain any buffer left by a prior case (module-level Map).
    takeBackgroundEventBuffer(TARGET);
    __resetEventSessionValidationDiagnosticsForTest();
    __resetValidationOutcomeReportingForTest();
  });

  afterEach(() => {
    takeBackgroundEventBuffer(TARGET);
    vi.unstubAllGlobals();
  });

  it('REJECTS a foreign-routed background event (provenance != target) and telemeters it', () => {
    const store = createSessionStore();
    loadBackgroundSession(store, TARGET);

    // Event routed to TARGET, but its TRUE envelope origin is FOREIGN.
    store.getState().processHistoryEvent(
      TARGET,
      'turn-foreign',
      bareStatusEvent('foreign background event'),
      FOREIGN, // <-- the envelope eventSessionId (independent of the routing target)
    );

    // RED-without-fix: without the 4th-arg threading, the validator falls back
    // to the event's (absent) sessionId → accepted-legacy → the event is
    // buffered. With threading, the foreign provenance is detected and the event
    // is dropped, so the buffer stays empty.
    const buffer = takeBackgroundEventBuffer(TARGET);
    expect(buffer).toHaveLength(0);

    // Genuine enforcement is telemetered as a rejected-foreign outcome on the
    // history-replay (background) source.
    const diagnostics = getEventSessionValidationDiagnostics();
    expect(
      diagnostics.rejectsByKey['history-replay:rejected-foreign:status'],
    ).toBeGreaterThanOrEqual(1);
    expect(captureRendererMessage).toHaveBeenCalledWith(
      'cross-session-event-rejected-foreign',
      expect.objectContaining({
        level: 'warning',
        tags: expect.objectContaining({
          crossSessionOutcome: 'rejected-foreign',
          crossSessionSource: 'history-replay',
          crossSessionEventType: 'status',
        }),
      }),
    );
  });

  it('still WRITES a legitimate background event (provenance == target) — behaviour-preserving', () => {
    const store = createSessionStore();
    loadBackgroundSession(store, TARGET);

    // Event routed to TARGET whose envelope origin IS TARGET (the normal case).
    store.getState().processHistoryEvent(
      TARGET,
      'turn-legit',
      bareStatusEvent('legit background event'),
      TARGET,
    );

    const buffer = takeBackgroundEventBuffer(TARGET);
    expect(buffer).toHaveLength(1);
    expect(buffer[0].turnId).toBe('turn-legit');

    // A matching-provenance event is an `accept` (not even accepted-legacy), so
    // no foreign rejection is recorded for this source.
    const diagnostics = getEventSessionValidationDiagnostics();
    expect(
      diagnostics.rejectsByKey['history-replay:rejected-foreign:status'],
    ).toBeUndefined();
  });

  it('preserves legacy behaviour when no provenance is threaded (event written, counted legacy)', () => {
    // Mirrors callers that omit the optional 4th arg (e.g. background-buffer
    // flush): with no eventSessionId AND no event-stamped sessionId, the event
    // is accepted-legacy and written — unchanged from pre-19c.
    const store = createSessionStore();
    loadBackgroundSession(store, TARGET);

    store.getState().processHistoryEvent(
      TARGET,
      'turn-legacy',
      bareStatusEvent('legacy background event'),
      // no eventSessionId
    );

    const buffer = takeBackgroundEventBuffer(TARGET);
    expect(buffer).toHaveLength(1);

    const diagnostics = getEventSessionValidationDiagnostics();
    expect(
      diagnostics.legacyByKey['history-replay:accepted-legacy:status'],
    ).toBeGreaterThanOrEqual(1);
    expect(
      diagnostics.rejectsByKey['history-replay:rejected-foreign:status'],
    ).toBeUndefined();
  });
});
