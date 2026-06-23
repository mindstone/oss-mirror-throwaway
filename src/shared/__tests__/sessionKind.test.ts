import { describe, expect, it } from 'vitest';
import {
  classifySessionKind,
  defaultTitleForKind,
  fixedTitleForKind,
  hasFixedTitle,
  DEFAULT_NEW_SESSION_TITLE,
  DELETE_ELIGIBLE_KINDS,
  EXCLUDED_FROM_ACTIVE_KINDS,
  isAutomationSession,
  isBackgroundConversationKind,
  isBackgroundConversationSession,
  isDeleteEligibleKind,
  isDeleteEligibleSession,
  isSidebarHiddenKind,
  isSidebarHiddenSession,
  type SessionKind,
  shouldSkipCheckpointing,
  SIDEBAR_HIDDEN_KINDS,
  SKIP_CHECKPOINTING_KINDS,
} from '../sessionKind';

type SessionKindTruthTableRow = {
  kind: SessionKind;
  sessionId: string;
  hints?: { isCompanion?: boolean };
  sidebarHidden: boolean;
  deleteEligible: boolean;
};

const TRUTH_TABLE: SessionKindTruthTableRow[] = [
  {
    kind: 'conversation',
    sessionId: 'conversation-123',
    sidebarHidden: false,
    deleteEligible: false,
  },
  {
    kind: 'meeting-companion',
    sessionId: 'conversation-123',
    hints: { isCompanion: true },
    sidebarHidden: false,
    deleteEligible: false,
  },
  {
    kind: 'automation',
    sessionId: 'automation-daily-sync--abc123',
    sidebarHidden: false,
    deleteEligible: false,
  },
  {
    kind: 'automation-insight',
    sessionId: 'automation-insight-abc123',
    sidebarHidden: false,
    deleteEligible: false,
  },
  {
    kind: 'meeting-analysis',
    sessionId: 'meeting-analysis-abc123',
    sidebarHidden: false,
    deleteEligible: false,
  },
  {
    kind: 'use-case-discovery',
    sessionId: 'use-case-discovery-abc123',
    sidebarHidden: false,
    deleteEligible: false,
  },
  {
    kind: 'cli-chat',
    sessionId: 'cli-chat-abc123',
    sidebarHidden: false,
    deleteEligible: false,
  },
  {
    kind: 'memory-update',
    sessionId: 'memory-update-turn-123',
    sidebarHidden: true,
    deleteEligible: true,
  },
  {
    kind: 'meeting-qa',
    sessionId: 'meeting-qa-abc123',
    sidebarHidden: true,
    deleteEligible: true,
  },
  {
    kind: 'error-eval',
    sessionId: 'error-eval-abc123',
    sidebarHidden: true,
    deleteEligible: true,
  },
  {
    kind: 'calendar-sync',
    sessionId: 'calendar-sync',
    sidebarHidden: true,
    deleteEligible: true,
  },
];

describe('sessionKind classifier truth table', () => {
  it.each(TRUTH_TABLE)(
    'classifies $sessionId as $kind',
    ({ sessionId, hints, kind, sidebarHidden, deleteEligible }) => {
      expect(classifySessionKind(sessionId, hints)).toBe(kind);
      expect(isSidebarHiddenKind(kind)).toBe(sidebarHidden);
      expect(isDeleteEligibleKind(kind)).toBe(deleteEligible);
      expect(shouldSkipCheckpointing(kind)).toBe(deleteEligible);
      expect(isSidebarHiddenSession(sessionId, hints)).toBe(sidebarHidden);
      expect(isDeleteEligibleSession(sessionId, hints)).toBe(deleteEligible);
    },
  );
});

describe('sessionKind lifecycle sets', () => {
  it('uses the same lifecycle scope for delete eligibility and checkpoint skipping', () => {
    expect(SKIP_CHECKPOINTING_KINDS).toBe(DELETE_ELIGIBLE_KINDS);
  });

  it('sidebar-hidden kinds are exactly the four ephemeral lifecycle kinds', () => {
    expect(Array.from(SIDEBAR_HIDDEN_KINDS).sort()).toEqual(
      ['calendar-sync', 'error-eval', 'meeting-qa', 'memory-update'],
    );
  });
});

describe('background conversation kinds excluded from Active', () => {
  const expectedBackgroundKinds = new Set<SessionKind>([
    'automation',
    'meeting-analysis',
    'use-case-discovery',
  ]);

  it('marks exactly the app-initiated background kinds as excluded from Active', () => {
    expect(Array.from(EXCLUDED_FROM_ACTIVE_KINDS).sort()).toEqual(
      Array.from(expectedBackgroundKinds).sort(),
    );

    for (const { kind, sessionId, hints } of TRUTH_TABLE) {
      const expected = expectedBackgroundKinds.has(kind);
      expect(isBackgroundConversationKind(kind)).toBe(expected);
      expect(isBackgroundConversationSession(sessionId, hints)).toBe(expected);
    }
  });

  it('classifies prefix-based background sessions without excluding user-initiated neighbours', () => {
    expect(isBackgroundConversationSession('automation-source-capture--abc123')).toBe(true);
    expect(isBackgroundConversationSession('meeting-analysis-abc123')).toBe(true);
    expect(isBackgroundConversationSession('use-case-discovery-abc123')).toBe(true);

    expect(isBackgroundConversationSession('automation-insight-abc123')).toBe(false);
    expect(isBackgroundConversationSession('cli-chat-abc123')).toBe(false);
    expect(isBackgroundConversationSession('conversation-abc123')).toBe(false);
    expect(isBackgroundConversationSession('meeting-companion-abc123', { isCompanion: true }))
      .toBe(false);
  });

  it('treats malformed ids as ordinary conversations for Active exclusion', () => {
    expect(() => isBackgroundConversationSession(undefined as never)).not.toThrow();
    expect(isBackgroundConversationSession(undefined as never)).toBe(false);
    expect(isBackgroundConversationSession('')).toBe(false);
  });
});

describe('automation session classifier', () => {
  it('classifies only automation-prefixed sessions as automation', () => {
    expect(isAutomationSession('automation-source-capture--abc123')).toBe(true);
    expect(isAutomationSession('automation-daily-sync--abc123')).toBe(true);

    expect(isAutomationSession('automation-insight-abc123')).toBe(false);
    expect(isAutomationSession('meeting-analysis-abc123')).toBe(false);
    expect(isAutomationSession('use-case-discovery-abc123')).toBe(false);
    expect(isAutomationSession('conversation-abc123')).toBe(false);
    expect(isAutomationSession('cli-chat-abc123')).toBe(false);
  });

  it('treats malformed ids as non-automation', () => {
    expect(() => isAutomationSession(undefined as never)).not.toThrow();
    expect(isAutomationSession(undefined as never)).toBe(false);
    expect(isAutomationSession('')).toBe(false);
  });
});

describe('fixed-title kinds', () => {
  it('fixedTitleForKind returns the fixed title for use-case-discovery, undefined otherwise', () => {
    expect(fixedTitleForKind('use-case-discovery')).toBe('Use-case ideas');
    expect(fixedTitleForKind('conversation')).toBeUndefined();
    expect(fixedTitleForKind('cli-chat')).toBeUndefined();
    expect(fixedTitleForKind('automation')).toBeUndefined();
  });

  it('hasFixedTitle is true exactly for kinds with a fixed title (the auto-title skip guard)', () => {
    expect(hasFixedTitle('use-case-discovery')).toBe(true);
    expect(hasFixedTitle('conversation')).toBe(false);
    expect(hasFixedTitle('cli-chat')).toBe(false);
    expect(hasFixedTitle('automation')).toBe(false);
  });

  it('defaultTitleForKind: fixed title for special kinds, desktop placeholder otherwise', () => {
    expect(defaultTitleForKind('use-case-discovery')).toBe('Use-case ideas');
    expect(defaultTitleForKind('conversation')).toBe(DEFAULT_NEW_SESSION_TITLE);
    expect(defaultTitleForKind('automation')).toBe('New Agent Run');
  });

  it('a fixed title differs from the placeholder', () => {
    expect(defaultTitleForKind('use-case-discovery')).not.toBe(DEFAULT_NEW_SESSION_TITLE);
  });
});

describe('sessionKind companion hint pathway', () => {
  it('prioritizes companion hint over prefixed IDs', () => {
    expect(classifySessionKind('memory-update-turn-123', { isCompanion: true }))
      .toBe('meeting-companion');
    expect(isSidebarHiddenSession('memory-update-turn-123', { isCompanion: true })).toBe(false);
    expect(isDeleteEligibleSession('memory-update-turn-123', { isCompanion: true })).toBe(false);
  });

  it('classifies legacy error-eval sessions as the error-eval lifecycle kind', () => {
    expect(classifySessionKind('error-eval-abc123')).toBe('error-eval');
    expect(isSidebarHiddenSession('error-eval-abc123')).toBe(true);
    expect(isDeleteEligibleSession('error-eval-abc123')).toBe(true);
  });
});

describe('sessionKind — malformed id containment (260617 crash repro)', () => {
  // ROOT BUG (Stage 1): `classifySessionKind(undefined)` threw on
  // `sessionId.startsWith(...)`, aborting `listSessions()` (sidebar/folders
  // empty), the time-saved backfill, and agent turns. The classifier must be a
  // tolerant boundary: a non-string/empty id degrades to 'conversation' and
  // never throws.
  it('returns conversation (does NOT throw) for an undefined id', () => {
    expect(() => classifySessionKind(undefined as never)).not.toThrow();
    expect(classifySessionKind(undefined as never)).toBe('conversation');
  });

  it('returns conversation for a null id', () => {
    expect(() => classifySessionKind(null as never)).not.toThrow();
    expect(classifySessionKind(null as never)).toBe('conversation');
  });

  it('returns conversation for an empty-string id', () => {
    expect(classifySessionKind('')).toBe('conversation');
  });

  it('returns conversation for a non-string id', () => {
    expect(() => classifySessionKind(123 as never)).not.toThrow();
    expect(classifySessionKind(123 as never)).toBe('conversation');
  });

  it('downstream helpers tolerate an undefined id', () => {
    expect(() => isSidebarHiddenSession(undefined as never)).not.toThrow();
    expect(isSidebarHiddenSession(undefined as never)).toBe(false);
    expect(() => isDeleteEligibleSession(undefined as never)).not.toThrow();
    expect(isDeleteEligibleSession(undefined as never)).toBe(false);
  });
});

describe('sessionKind bad-id defense-in-depth', () => {
  // Regression for the 260617 classifySessionKind(undefined) crash: a summary
  // built from a non-session sidecar file carried an `undefined` id, and the
  // unguarded `sessionId.startsWith(...)` threw — taking out sessions:list, the
  // time-saved repair backfill, and every agent turn on that pass. The guard
  // must fail safe to 'conversation', never throw.
  const badIds: Array<{ label: string; value: unknown }> = [
    { label: 'undefined', value: undefined },
    { label: 'null', value: null },
    { label: 'empty string', value: '' },
    { label: 'number', value: 42 },
    { label: 'object', value: {} },
  ];

  it.each(badIds)('returns "conversation" without throwing for $label', ({ value }) => {
    expect(() => classifySessionKind(value as unknown as string)).not.toThrow();
    expect(classifySessionKind(value as unknown as string)).toBe('conversation');
  });

  it('downstream session predicates also stay crash-safe on a bad id', () => {
    expect(() => isSidebarHiddenSession(undefined as unknown as string)).not.toThrow();
    expect(isSidebarHiddenSession(undefined as unknown as string)).toBe(false);
    expect(() => isDeleteEligibleSession(undefined as unknown as string)).not.toThrow();
    expect(isDeleteEligibleSession(undefined as unknown as string)).toBe(false);
  });
});
