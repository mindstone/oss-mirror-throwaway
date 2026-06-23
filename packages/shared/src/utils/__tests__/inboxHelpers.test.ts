import type { InboxItem } from '../../types/inbox';
import { getQuadrantLabel, getQuadrantPriority, sortInboxItems } from '../inboxHelpers';

const createMockItem = (overrides: Partial<InboxItem> = {}): InboxItem => ({
  id: 'test-id',
  title: 'Test item',
  text: 'Test text',
  references: [],
  addedAt: 1000,
  ...overrides,
});

describe('getQuadrantLabel', () => {
  it('returns "Do Now" when urgent and important', () => {
    expect(getQuadrantLabel(createMockItem({ urgent: true, important: true }))).toBe('Do Now');
  });

  it('returns "Schedule" when important but not urgent', () => {
    expect(getQuadrantLabel(createMockItem({ urgent: false, important: true }))).toBe('Schedule');
  });

  it('returns "Delegate" when urgent but not important', () => {
    expect(getQuadrantLabel(createMockItem({ urgent: true, important: false }))).toBe('Delegate');
  });

  it('returns "Consider" when neither urgent nor important (both explicitly false)', () => {
    expect(getQuadrantLabel(createMockItem({ urgent: false, important: false }))).toBe('Consider');
  });

  it('returns null when neither flag is explicitly set', () => {
    expect(getQuadrantLabel(createMockItem())).toBeNull();
  });
});

describe('getQuadrantPriority', () => {
  it('returns 0 for executing items', () => {
    expect(getQuadrantPriority(createMockItem({ executingSessionId: 'session-1' }))).toBe(0);
  });

  it('returns 1 for urgent and important', () => {
    expect(getQuadrantPriority(createMockItem({ urgent: true, important: true }))).toBe(1);
  });

  it('returns 2 for important only', () => {
    expect(getQuadrantPriority(createMockItem({ important: true }))).toBe(2);
  });

  it('returns 3 for urgent only', () => {
    expect(getQuadrantPriority(createMockItem({ urgent: true, important: false }))).toBe(3);
  });

  it('returns 4 for neither urgent nor important', () => {
    expect(getQuadrantPriority(createMockItem({ urgent: false, important: false }))).toBe(4);
  });

  it('returns 4 when no flags are set (undefined)', () => {
    expect(getQuadrantPriority(createMockItem())).toBe(4);
  });

  it('returns 3 when urgent is true but important is undefined', () => {
    expect(getQuadrantPriority(createMockItem({ urgent: true }))).toBe(3);
  });
});

describe('sortInboxItems', () => {
  it('keeps priority ahead of draft readiness', () => {
    const items = [
      createMockItem({ id: 'low-draft', important: false, draft: 'Ready to send', addedAt: 3000 }),
      createMockItem({ id: 'urgent', urgent: true, important: true, addedAt: 1000 }),
      createMockItem({ id: 'high', category: 'user-request', addedAt: 2000 }),
    ];

    const sorted = sortInboxItems(items);
    expect(sorted.map((i) => i.id)).toEqual(['urgent', 'high', 'low-draft']);
  });

  it('uses drafts as a tiebreaker within the same priority band', () => {
    const items = [
      createMockItem({ id: 'same-priority-newer', category: 'user-request', addedAt: 2000 }),
      createMockItem({ id: 'same-priority-draft', category: 'user-request', draft: 'Ready to send', addedAt: 1000 }),
    ];

    const sorted = sortInboxItems(items);
    expect(sorted.map((i) => i.id)).toEqual(['same-priority-draft', 'same-priority-newer']);
  });

  it('sorts by priority level (urgent > high > medium > low)', () => {
    const items = [
      createMockItem({ id: 'low', important: false, addedAt: 1000 }),
      createMockItem({ id: 'urgent', urgent: true, important: true, addedAt: 1000 }),
      createMockItem({ id: 'high', category: 'user-request', addedAt: 1000 }),
    ];

    const sorted = sortInboxItems(items);
    expect(sorted.map((i) => i.id)).toEqual(['urgent', 'high', 'low']);
  });

  it('sorts by addedAt descending within the same priority', () => {
    const items = [
      createMockItem({ id: 'older', addedAt: 1000 }),
      createMockItem({ id: 'newer', addedAt: 2000 }),
    ];

    const sorted = sortInboxItems(items);
    expect(sorted.map((i) => i.id)).toEqual(['newer', 'older']);
  });

  it('sorts items with dueBy before items without dueBy at same priority', () => {
    const futureMs = Date.now() + 86_400_000;
    const items = [
      createMockItem({ id: 'no-due', addedAt: 2000 }),
      createMockItem({ id: 'has-due', dueBy: futureMs, addedAt: 1000 }),
    ];

    const sorted = sortInboxItems(items);
    expect(sorted.map((i) => i.id)).toEqual(['has-due', 'no-due']);
  });

  it('returns a new array without mutating the original', () => {
    const items = [
      createMockItem({ id: 'b', addedAt: 1000 }),
      createMockItem({ id: 'a', addedAt: 2000 }),
    ];
    const original = [...items];

    const sorted = sortInboxItems(items);
    expect(sorted).not.toBe(items);
    expect(items).toEqual(original);
  });
});
