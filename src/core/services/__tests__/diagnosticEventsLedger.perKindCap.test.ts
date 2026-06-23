import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  appendDiagnosticEvent,
  resetDiagnosticEventsLedgerForTests,
  setDiagnosticEventsLedgerWriter,
} from '@core/services/diagnosticEventsLedger';
import { MAX_EVENTS_PER_KIND, type DiagnosticEventEntry, type DiagnosticEventKind } from '../diagnostics/manifest';

describe('diagnostic events ledger per-kind cap', () => {
  let append: ReturnType<typeof vi.fn<(entry: DiagnosticEventEntry) => void>>;

  beforeEach(() => {
    resetDiagnosticEventsLedgerForTests();
    append = vi.fn<(entry: DiagnosticEventEntry) => void>();
    setDiagnosticEventsLedgerWriter({ append });
  });

  afterEach(() => {
    resetDiagnosticEventsLedgerForTests();
  });

  it('emits a warning at the default cap boundary and still accepts the over-cap event', () => {
    emitCooldownExit(MAX_EVENTS_PER_KIND.cooldown_exit);

    expect(kinds()).not.toContain('events_per_kind_cap_engaged');
    expect(countKind('cooldown_exit')).toBe(MAX_EVENTS_PER_KIND.cooldown_exit);

    emitCooldownExit(1);

    expect(countKind('events_per_kind_cap_engaged')).toBe(1);
    expect(countKind('cooldown_exit')).toBe(MAX_EVENTS_PER_KIND.cooldown_exit + 1);
    expect(entries().at(-2)).toMatchObject({
      kind: 'events_per_kind_cap_engaged',
      data: { kind: 'cooldown_exit', capLimit: MAX_EVENTS_PER_KIND.cooldown_exit, droppedSinceLastWarning: 0 },
    });
    expect(entries().at(-1)?.kind).toBe('cooldown_exit');
  });

  it('does not re-warn on subsequent over-cap writes in the same engagement window', () => {
    emitCooldownExit(MAX_EVENTS_PER_KIND.cooldown_exit + 10);

    expect(countKind('events_per_kind_cap_engaged')).toBe(1);
    expect(countKind('cooldown_exit')).toBe(MAX_EVENTS_PER_KIND.cooldown_exit + 10);
  });

  it('tracks different kinds independently', () => {
    emitCooldownExit(MAX_EVENTS_PER_KIND.cooldown_exit + 1);
    emitToolAdvisory(MAX_EVENTS_PER_KIND.tool_advisory + 1);

    const engagedKinds = entries()
      .filter((entry): entry is Extract<DiagnosticEventEntry, { kind: 'events_per_kind_cap_engaged' }> => (
        entry.kind === 'events_per_kind_cap_engaged'
      ))
      .map((entry) => entry.data.kind)
      .sort();

    expect(engagedKinds).toEqual(['cooldown_exit', 'tool_advisory']);
    expect(countKind('cooldown_exit')).toBe(MAX_EVENTS_PER_KIND.cooldown_exit + 1);
    expect(countKind('tool_advisory')).toBe(MAX_EVENTS_PER_KIND.tool_advisory + 1);
  });

  it('guards re-entrant cap warning emits from infinite recursion', () => {
    expect(() => {
      emitCapEngaged(MAX_EVENTS_PER_KIND.events_per_kind_cap_engaged + 1);
    }).not.toThrow();

    expect(countKind('events_per_kind_cap_engaged')).toBe(MAX_EVENTS_PER_KIND.events_per_kind_cap_engaged + 2);
    expect(entries().at(-2)).toMatchObject({
      kind: 'events_per_kind_cap_engaged',
      data: {
        kind: 'events_per_kind_cap_engaged',
        capLimit: MAX_EVENTS_PER_KIND.events_per_kind_cap_engaged,
        droppedSinceLastWarning: 0,
      },
    });
    expect(entries().at(-1)).toMatchObject({
      kind: 'events_per_kind_cap_engaged',
      data: { kind: 'cooldown_exit', droppedSinceLastWarning: 0 },
    });
  });

  it('uses the higher cap for continuity_transition', () => {
    emitContinuityTransition(MAX_EVENTS_PER_KIND.continuity_transition);

    expect(kinds()).not.toContain('events_per_kind_cap_engaged');
    expect(countKind('continuity_transition')).toBe(MAX_EVENTS_PER_KIND.continuity_transition);

    emitContinuityTransition(1);

    expect(countKind('events_per_kind_cap_engaged')).toBe(1);
    expect(countKind('continuity_transition')).toBe(MAX_EVENTS_PER_KIND.continuity_transition + 1);
    expect(entries().at(-2)).toMatchObject({
      kind: 'events_per_kind_cap_engaged',
      data: { kind: 'continuity_transition', capLimit: MAX_EVENTS_PER_KIND.continuity_transition },
    });
  });

  function entries(): DiagnosticEventEntry[] {
    return append.mock.calls.map(([entry]) => entry as DiagnosticEventEntry);
  }

  function kinds(): DiagnosticEventKind[] {
    return entries().map((entry) => entry.kind);
  }

  function countKind(kind: DiagnosticEventKind): number {
    return kinds().filter((entryKind) => entryKind === kind).length;
  }
});

function emitCooldownExit(count: number): void {
  for (let i = 0; i < count; i++) {
    appendDiagnosticEvent({
      kind: 'cooldown_exit',
      data: { scope: 'api', reason: 'success' },
    });
  }
}

function emitToolAdvisory(count: number): void {
  for (let i = 0; i < count; i++) {
    appendDiagnosticEvent({
      kind: 'tool_advisory',
      data: { advisory: 'soft_budget', totalToolCalls: 1 },
    });
  }
}

function emitCapEngaged(count: number): void {
  for (let i = 0; i < count; i++) {
    appendDiagnosticEvent({
      kind: 'events_per_kind_cap_engaged',
      data: { kind: 'cooldown_exit', capLimit: MAX_EVENTS_PER_KIND.cooldown_exit, droppedSinceLastWarning: 0 },
    });
  }
}

function emitContinuityTransition(count: number): void {
  for (let i = 0; i < count; i++) {
    appendDiagnosticEvent({
      kind: 'continuity_transition',
      data: {
        family: 'outbox_stall',
        message: 'stuck-outbox',
        reason: 'stuck-outbox',
        level: 'warning',
      },
    });
  }
}
