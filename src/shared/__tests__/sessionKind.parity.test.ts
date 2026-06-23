import { describe, expect, it } from 'vitest';
import {
  type SessionKind,
  classifySessionKind,
  isInternalLedgerKind,
  shouldSkipMemoryUpdate,
  shouldSkipTimeSaved,
} from '../sessionKind';

type Fixture = {
  sessionId: string;
  expectedKind: SessionKind;
  hints?: { isCompanion?: boolean };
};

const FIXTURE_CORPUS: Fixture[] = [
  { sessionId: 'session-abc', expectedKind: 'conversation' },
  { sessionId: 'conversation', expectedKind: 'conversation' },
  { sessionId: 'conversation-123', expectedKind: 'conversation' },
  { sessionId: 'draft-only-0001', expectedKind: 'conversation' },
  { sessionId: 'memory-update', expectedKind: 'conversation' },
  { sessionId: 'rolex-123', expectedKind: 'conversation' },
  { sessionId: 'automationx-123', expectedKind: 'conversation' },
  { sessionId: 'calendar-sync-v2', expectedKind: 'conversation' },
  { sessionId: 'meeting-analysis', expectedKind: 'conversation' },
  { sessionId: 'companion-thread-1', expectedKind: 'meeting-companion', hints: { isCompanion: true } },
  { sessionId: 'session-42', expectedKind: 'meeting-companion', hints: { isCompanion: true } },
  { sessionId: 'standup-notes', expectedKind: 'meeting-companion', hints: { isCompanion: true } },
  { sessionId: 'automation-calendar-sync--uuid-1', expectedKind: 'automation' },
  { sessionId: 'automation-wins-learnings--run-2', expectedKind: 'automation' },
  { sessionId: 'automation-digest--abc', expectedKind: 'automation' },
  { sessionId: 'automation-legacy-type', expectedKind: 'automation' },
  { sessionId: 'automation-insight-abc123', expectedKind: 'automation-insight' },
  { sessionId: 'automation-insight-run-42', expectedKind: 'automation-insight' },
  { sessionId: 'automation-insight-daily-report', expectedKind: 'automation-insight' },
  { sessionId: 'meeting-analysis-abc123', expectedKind: 'meeting-analysis' },
  { sessionId: 'meeting-analysis-2026-05-01', expectedKind: 'meeting-analysis' },
  { sessionId: 'meeting-analysis-bot-77', expectedKind: 'meeting-analysis' },
  { sessionId: 'use-case-discovery-abc123', expectedKind: 'use-case-discovery' },
  { sessionId: 'use-case-discovery-lead-42', expectedKind: 'use-case-discovery' },
  { sessionId: 'use-case-discovery-2026-05-02', expectedKind: 'use-case-discovery' },
  { sessionId: 'cli-chat-abc123', expectedKind: 'cli-chat' },
  { sessionId: 'cli-chat-shell-42', expectedKind: 'cli-chat' },
  { sessionId: 'cli-chat-2026-05-02T12-00-00', expectedKind: 'cli-chat' },
  { sessionId: 'memory-update-turn-abc', expectedKind: 'memory-update' },
  { sessionId: 'memory-update-session-42', expectedKind: 'memory-update' },
  { sessionId: 'memory-update-2026-05-02', expectedKind: 'memory-update' },
  { sessionId: 'meeting-qa-abc123', expectedKind: 'meeting-qa' },
  { sessionId: 'meeting-qa-bot-42', expectedKind: 'meeting-qa' },
  { sessionId: 'meeting-qa-2026-05-02', expectedKind: 'meeting-qa' },
  { sessionId: 'error-eval-abc123', expectedKind: 'error-eval' },
  { sessionId: 'error-eval-retry-42', expectedKind: 'error-eval' },
  { sessionId: 'error-eval-2026-05-02', expectedKind: 'error-eval' },
  { sessionId: 'calendar-sync', expectedKind: 'calendar-sync' },
];

const legacyShouldSkipMemoryUpdate = (sessionId: string): boolean => {
  return (
    sessionId.startsWith('memory-update-')
    || sessionId.startsWith('use-case-discovery-')
    || sessionId.startsWith('cli-chat-')
  );
};

const legacyShouldSkipTimeSavedAdditional = (sessionId: string): boolean => {
  return (
    sessionId.startsWith('automation-')
    || sessionId === 'calendar-sync'
    || sessionId.startsWith('meeting-qa-')
    || sessionId.startsWith('meeting-analysis-')
  );
};

const legacyShouldSkipTimeSaved = (sessionId: string): boolean => {
  return legacyShouldSkipMemoryUpdate(sessionId) || legacyShouldSkipTimeSavedAdditional(sessionId);
};

const legacyIsInternalLedgerSession = (sessionId: string): boolean => {
  return (
    sessionId.startsWith('memory-update-')
    || sessionId.startsWith('meeting-qa-')
    || sessionId === 'calendar-sync'
    || sessionId.startsWith('automation-')
    || sessionId.startsWith('meeting-analysis-')
    || sessionId.startsWith('use-case-discovery-')
    || sessionId.startsWith('cli-chat-')
  );
};

const legacyIsCostLedgerInternalSession = (sessionId: string): boolean => {
  return (
    sessionId.startsWith('automation-')
    || sessionId.startsWith('memory-update-')
    || sessionId.startsWith('use-case-discovery-')
    || sessionId.startsWith('cli-chat-')
    || sessionId === 'calendar-sync'
  );
};

const legacyIsAutomationSession = (sessionId: string): boolean => sessionId.startsWith('automation-');
const isAutomationSessionKind = (kind: SessionKind): boolean => kind === 'automation' || kind === 'automation-insight';

describe('sessionKind Phase 2 fixture coverage', () => {
  it('covers all 11 session kinds with 30+ representative IDs', () => {
    expect(FIXTURE_CORPUS.length).toBeGreaterThanOrEqual(30);
    const coveredKinds = new Set(
      FIXTURE_CORPUS.map((fixture) => classifySessionKind(fixture.sessionId, fixture.hints)),
    );
    expect(Array.from(coveredKinds).sort()).toEqual([
      'automation',
      'automation-insight',
      'calendar-sync',
      'cli-chat',
      'conversation',
      'error-eval',
      'meeting-analysis',
      'meeting-companion',
      'meeting-qa',
      'memory-update',
      'use-case-discovery',
    ]);
  });

  it.each(FIXTURE_CORPUS)(
    'classifies $sessionId as $expectedKind',
    ({ sessionId, hints, expectedKind }) => {
      expect(classifySessionKind(sessionId, hints)).toBe(expectedKind);
    },
  );
});

describe('sessionKind Phase 2 parity with legacy prefix checks', () => {
  it.each(FIXTURE_CORPUS)(
    'matches legacy decisions for $sessionId',
    ({ sessionId, hints }) => {
      const kind = classifySessionKind(sessionId, hints);

      expect(shouldSkipMemoryUpdate(kind)).toBe(legacyShouldSkipMemoryUpdate(sessionId));
      expect(shouldSkipTimeSaved(kind)).toBe(legacyShouldSkipTimeSaved(sessionId));
      expect(shouldSkipMemoryUpdate(kind) || shouldSkipTimeSaved(kind)).toBe(legacyShouldSkipTimeSaved(sessionId));
      expect(isInternalLedgerKind(kind)).toBe(legacyIsInternalLedgerSession(sessionId));
      expect(
        isInternalLedgerKind(kind) && kind !== 'meeting-qa' && kind !== 'meeting-analysis',
      ).toBe(legacyIsCostLedgerInternalSession(sessionId));
      expect(isAutomationSessionKind(kind)).toBe(legacyIsAutomationSession(sessionId));
    },
  );
});
