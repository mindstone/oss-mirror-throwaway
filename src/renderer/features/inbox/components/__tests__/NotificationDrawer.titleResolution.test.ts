// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import type { AgentEvent, UserQuestion } from '@shared/types';
import type { PendingApprovalItem } from '../../hooks/usePendingApprovals';
import {
  buildQuestionWaitingItems,
  resolveQuestionWaitingSourceLabel,
} from '../../hooks/usePendingQuestionWaiting';
import {
  resolveGroupDisplayTitle,
  truncatePreview,
} from '../NotificationDrawer';

type DrawerGroup = Parameters<typeof resolveGroupDisplayTitle>[0];
type DrawerApprovalItem = Extract<
  DrawerGroup['items'][number],
  { kind: 'approval' }
>;

function buildApproval(
  overrides: Partial<PendingApprovalItem> = {},
): PendingApprovalItem {
  return {
    id: 'tool:approval-1',
    type: 'tool',
    title: 'New conversation',
    description: 'Rebel wants to run a tool',
    timestamp: Date.UTC(2026, 4, 3),
    sessionId: 'session-1',
    toolApproval: {
      toolUseID: 'tool-use-1',
      turnId: 'turn-1',
      toolName: 'browser_navigate',
      input: {},
    },
    ...overrides,
  };
}

function buildApprovalItem(firstMessagePreview?: string): DrawerApprovalItem {
  const approval = buildApproval({
    sessionContext:
      firstMessagePreview == null
        ? undefined
        : {
            title: 'New conversation',
            firstMessagePreview,
            messageCount: 1,
          },
  });

  return {
    kind: 'approval',
    id: approval.id,
    timestamp: approval.timestamp,
    sessionId: approval.sessionId,
    groupTitle: approval.title,
    approval,
  };
}

function buildGroup(overrides: Partial<DrawerGroup> = {}): DrawerGroup {
  return {
    sessionId: 'session-1',
    title: 'New conversation',
    items: [],
    mostRecentTimestamp: Date.UTC(2026, 4, 3),
    ...overrides,
  };
}

describe('resolveGroupDisplayTitle', () => {
  it('uses a live non-default title when available', () => {
    const group = buildGroup();
    const liveTitleById = new Map([['session-1', 'Quarterly planning']]);

    expect(resolveGroupDisplayTitle(group, liveTitleById)).toBe(
      'Quarterly planning',
    );
  });

  it('prefers the live title over a non-default snapshot title', () => {
    const group = buildGroup({ title: 'Stale snapshot title' });
    const liveTitleById = new Map([['session-1', 'Fresh live title']]);

    expect(resolveGroupDisplayTitle(group, liveTitleById)).toBe(
      'Fresh live title',
    );
  });

  it('uses the first approval preview when the live title is still default', () => {
    const group = buildGroup({
      items: [buildApprovalItem('  Draft the partner launch plan  ')],
    });
    const liveTitleById = new Map([['session-1', 'New conversation']]);

    expect(resolveGroupDisplayTitle(group, liveTitleById)).toBe(
      'Draft the partner launch plan',
    );
  });

  it('keeps the snapshot title when the live title is default and no preview exists', () => {
    const group = buildGroup({
      title: 'New Agent Run',
      items: [buildApprovalItem()],
    });
    const liveTitleById = new Map([['session-1', 'New conversation']]);

    expect(resolveGroupDisplayTitle(group, liveTitleById)).toBe(
      'New Agent Run',
    );
  });

  it.each([
    ['__background__', 'Background tasks'],
    ['__skill_updates__', 'Skill updates'],
    ['__mcp_contributions__', "Tools you've shared"],
  ])('keeps pseudo-session title %s verbatim', (sessionId, title) => {
    const group = buildGroup({ sessionId, title });
    const liveTitleById = new Map([[sessionId, 'Live title should not win']]);

    expect(resolveGroupDisplayTitle(group, liveTitleById)).toBe(title);
  });

  it('falls back to the snapshot title when the session is missing from live summaries', () => {
    const group = buildGroup({ title: 'Cached conversation title' });

    expect(resolveGroupDisplayTitle(group, new Map())).toBe(
      'Cached conversation title',
    );
  });
});

describe('truncatePreview', () => {
  it('collapses whitespace and trims short text without ellipsizing', () => {
    expect(truncatePreview('  Send   email\n\tto Alex  ', 50)).toBe(
      'Send email to Alex',
    );
  });

  it('leaves already-short text alone', () => {
    expect(truncatePreview('Short preview', 50)).toBe('Short preview');
  });

  it('ellipsizes text longer than the maximum length', () => {
    expect(truncatePreview('1234567890', 6)).toBe('12345…');
  });
});

describe('question waiting drawer items', () => {
  const question: UserQuestion = {
    id: 'q-calendar',
    question: ' Which calendar should hold this? ',
    header: 'Calendar',
    options: [
      { id: 'work', label: 'Work', description: 'Use the work calendar' },
      { id: 'personal', label: 'Personal', description: 'Use the personal calendar' },
    ],
    multiSelect: false,
    purpose: 'approval_clarification',
  };

  it('surfaces pending approval clarifications as Question waiting items', () => {
    const eventsByTurn: Record<string, AgentEvent[]> = {
      'turn-1': [
        {
          type: 'user_question',
          batchId: 'batch-question',
          toolUseId: 'tool-question',
          questions: [question],
          sessionId: 'automation-weekly-report',
          timestamp: 10,
        },
      ],
    };

    const items = buildQuestionWaitingItems([
      {
        id: 'automation-weekly-report',
        title: 'Weekly report',
        origin: 'automation',
        eventsByTurn,
      },
    ]);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: 'question:automation-weekly-report:turn-1:batch-question',
      groupTitle: 'Weekly report',
      sourceLabel: 'Automation',
      questionText: 'Which calendar should hold this?',
    });
  });

  it('does not surface answered clarification batches', () => {
    const eventsByTurn: Record<string, AgentEvent[]> = {
      'turn-1': [
        {
          type: 'user_question',
          batchId: 'batch-question',
          toolUseId: 'tool-question',
          questions: [question],
          sessionId: 'session-1',
          timestamp: 10,
        },
        {
          type: 'user_question_answered',
          batchId: 'batch-question',
          answers: [{ questionId: 'q-calendar', selectedOptionIds: ['work'] }],
          sessionId: 'session-1',
          timestamp: 11,
        },
      ],
    };

    expect(buildQuestionWaitingItems([
      {
        id: 'session-1',
        title: 'Planning',
        origin: 'manual',
        eventsByTurn,
      },
    ])).toEqual([]);
  });

  it('does not surface dismissed clarification batches', () => {
    const eventsByTurn: Record<string, AgentEvent[]> = {
      'turn-1': [
        {
          type: 'user_question',
          batchId: 'batch-question',
          toolUseId: 'tool-question',
          questions: [question],
          sessionId: 'session-1',
          timestamp: 10,
        },
      ],
    };

    expect(buildQuestionWaitingItems(
      [
        {
          id: 'session-1',
          title: 'Planning',
          origin: 'manual',
          eventsByTurn,
        },
      ],
      { 'session-1': ['batch-question'] },
    )).toEqual([]);
  });

  it('labels automation session ids even when origin is missing', () => {
    expect(resolveQuestionWaitingSourceLabel('automation-morning-brief')).toBe('Automation');
  });
});
