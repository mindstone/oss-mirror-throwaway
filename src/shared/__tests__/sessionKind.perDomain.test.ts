import { describe, expect, it } from 'vitest';
import {
  type SessionKind,
  INTERNAL_LEDGER_KINDS,
  SKIP_MEMORY_UPDATE_KINDS,
  SKIP_TIME_SAVED_KINDS,
  isInternalLedgerKind,
  shouldSkipMemoryUpdate,
  shouldSkipTimeSaved,
} from '../sessionKind';

type PerDomainTruthRow = {
  kind: SessionKind;
  skipMemoryUpdate: boolean;
  skipTimeSaved: boolean;
  internalLedger: boolean;
};

const PER_DOMAIN_TRUTH_TABLE: PerDomainTruthRow[] = [
  { kind: 'conversation', skipMemoryUpdate: false, skipTimeSaved: false, internalLedger: false },
  { kind: 'meeting-companion', skipMemoryUpdate: false, skipTimeSaved: false, internalLedger: false },
  { kind: 'automation', skipMemoryUpdate: false, skipTimeSaved: true, internalLedger: true },
  { kind: 'automation-insight', skipMemoryUpdate: false, skipTimeSaved: true, internalLedger: true },
  { kind: 'meeting-analysis', skipMemoryUpdate: false, skipTimeSaved: true, internalLedger: true },
  { kind: 'use-case-discovery', skipMemoryUpdate: true, skipTimeSaved: true, internalLedger: true },
  { kind: 'cli-chat', skipMemoryUpdate: true, skipTimeSaved: true, internalLedger: true },
  { kind: 'memory-update', skipMemoryUpdate: true, skipTimeSaved: true, internalLedger: true },
  { kind: 'meeting-qa', skipMemoryUpdate: false, skipTimeSaved: true, internalLedger: true },
  { kind: 'error-eval', skipMemoryUpdate: false, skipTimeSaved: false, internalLedger: false },
  { kind: 'calendar-sync', skipMemoryUpdate: false, skipTimeSaved: true, internalLedger: true },
];

describe('sessionKind per-domain predicates', () => {
  it.each(PER_DOMAIN_TRUTH_TABLE)(
    'maps $kind correctly across memory/time/internal domains',
    ({ kind, skipMemoryUpdate, skipTimeSaved, internalLedger }) => {
      expect(shouldSkipMemoryUpdate(kind)).toBe(skipMemoryUpdate);
      expect(shouldSkipTimeSaved(kind)).toBe(skipTimeSaved);
      expect(isInternalLedgerKind(kind)).toBe(internalLedger);
    },
  );

  it('exposes the expected per-domain cardinalities', () => {
    expect(SKIP_MEMORY_UPDATE_KINDS.size).toBe(3);
    expect(SKIP_TIME_SAVED_KINDS.size).toBe(8);
    expect(INTERNAL_LEDGER_KINDS.size).toBe(8);
  });
});
