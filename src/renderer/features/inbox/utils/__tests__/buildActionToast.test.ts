import { describe, it, expect, vi } from 'vitest';
import { buildActionToast } from '../buildActionToast';
import type { InboxItem } from '@shared/types';

const makeItem = (overrides: Partial<InboxItem> = {}): InboxItem => ({
  id: crypto.randomUUID(),
  title: 'Test item',
  text: 'Body',
  addedAt: Date.now(),
  archived: false,
  references: [],
  ...overrides,
});

describe('buildActionToast', () => {
  const noop = () => {};

  it('returns "Archived" title for single archive action', () => {
    const result = buildActionToast({
      action: 'archive',
      items: [makeItem()],
      undoCallback: noop,
    });
    expect(result.title).toBe('Archived');
  });

  it('returns count for batch-archive', () => {
    const items = [makeItem(), makeItem(), makeItem()];
    const result = buildActionToast({
      action: 'batch-archive',
      items,
      undoCallback: noop,
    });
    expect(result.title).toBe('Archived 3 items');
  });

  it('returns "Deleted" for dismiss action', () => {
    const result = buildActionToast({
      action: 'dismiss',
      items: [makeItem()],
      undoCallback: noop,
    });
    expect(result.title).toBe('Deleted');
  });

  it('returns count for batch-dismiss', () => {
    const items = [makeItem(), makeItem()];
    const result = buildActionToast({
      action: 'batch-dismiss',
      items,
      undoCallback: noop,
    });
    expect(result.title).toBe('Deleted 2 items');
  });

  it('returns count for batch-done', () => {
    const items = [makeItem(), makeItem(), makeItem(), makeItem()];
    const result = buildActionToast({
      action: 'batch-done',
      items,
      undoCallback: noop,
    });
    expect(result.title).toBe('Marked 4 items done');
  });

  it('includes undo action button', () => {
    const undoFn = vi.fn();
    const result = buildActionToast({
      action: 'archive',
      items: [makeItem()],
      undoCallback: undoFn,
    });
    const action = result.action as { label: string; onClick: () => void } | undefined;
    expect(result.action).toBeDefined();
    expect(action?.label).toBe('Undo');
    action?.onClick();
    expect(undoFn).toHaveBeenCalledOnce();
  });

  it('uses longer duration for destructive actions (execute)', () => {
    const destructive = buildActionToast({
      action: 'execute',
      items: [makeItem()],
      undoCallback: noop,
    });
    const reversible = buildActionToast({
      action: 'archive',
      items: [makeItem()],
      undoCallback: noop,
    });
    expect(destructive.duration).toBeGreaterThan(reversible.duration!);
  });

  it('includes "Email sent" title for email-referenced execute', () => {
    const item = makeItem({
      references: [{ kind: 'email', threadId: 't1' }],
    });
    const result = buildActionToast({
      action: 'execute',
      items: [item],
      undoCallback: noop,
    });
    expect(result.title).toBe('Email sent');
  });

  it('adds view callback as cancel button for execute action', () => {
    const viewFn = vi.fn();
    const result = buildActionToast({
      action: 'execute',
      items: [makeItem()],
      undoCallback: noop,
      viewCallback: viewFn,
    });
    const cancel = result.cancel as { label: string; onClick: () => void } | undefined;
    expect(cancel?.label).toBe('View conversation');
    cancel?.onClick();
    expect(viewFn).toHaveBeenCalledOnce();
  });
});
