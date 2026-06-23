import { describe, expect, it } from 'vitest';
import type { InboxItem } from '@shared/types';
import {
  findSupportedEmailReference,
  selectEmailResolutionCandidates,
  selectResolutionCandidates,
} from '../inboxHandlers';

const now = Date.UTC(2026, 4, 26, 10, 0, 0);

function item(overrides: Partial<InboxItem> & Pick<InboxItem, 'id' | 'title'>): InboxItem {
  return {
    id: overrides.id,
    title: overrides.title,
    text: overrides.text ?? overrides.title,
    references: overrides.references ?? [],
    addedAt: overrides.addedAt ?? now,
    category: overrides.category,
    dueBy: overrides.dueBy,
    tags: overrides.tags,
  };
}

describe('selectResolutionCandidates', () => {
  it('prioritises due/reference-rich completion candidates ahead of old vague backlog', () => {
    const oldVague = item({
      id: '00000000-0000-4000-8000-000000000001',
      title: 'Old vague reminder',
      addedAt: now - 30 * 24 * 60 * 60 * 1000,
    });
    const liamReview = item({
      id: '00000000-0000-4000-8000-000000000002',
      title: "Review Liam's prod engineer hiring criteria in Notion",
      addedAt: now - 5 * 24 * 60 * 60 * 1000,
      dueBy: now - 60 * 60 * 1000,
      references: [{ kind: 'url', url: 'https://notion.example/hiring', label: 'Notion: Hiring criteria' }],
    });
    const operatorsCheck = item({
      id: '00000000-0000-4000-8000-000000000003',
      title: 'Check Operators beta exposure with Josh',
      addedAt: now - 5 * 24 * 60 * 60 * 1000,
      references: [{ kind: 'workspace', path: 'Chief-of-Staff/memory/sources/operators.md' }],
    });

    const selected = selectResolutionCandidates([oldVague, operatorsCheck, liamReview], {
      mode: 'normal',
      maxItems: 2,
      now,
    });

    expect(selected.map(candidate => candidate.id)).toEqual([
      liamReview.id,
      operatorsCheck.id,
    ]);
  });

  it('caps normal and backlog modes separately', () => {
    const items = Array.from({ length: 120 }, (_, index) => item({
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      title: `Review item ${index + 1}`,
      references: [{ kind: 'workspace', path: `source-${index + 1}.md` }],
      addedAt: now + index,
    }));

    expect(selectResolutionCandidates(items, { mode: 'normal', maxItems: 200, now })).toHaveLength(15);
    expect(selectResolutionCandidates(items, { mode: 'backlog', maxItems: 200, now })).toHaveLength(100);
  });

  it('does not let unsupported reference-rich items starve email resolution checks', () => {
    const unsupportedItems = Array.from({ length: 20 }, (_, index) => item({
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      title: `Review Notion item ${index + 1}`,
      references: [{ kind: 'url', url: `https://notion.example/${index + 1}` }],
      addedAt: now + index,
    }));
    const emailItem = item({
      id: '00000000-0000-4000-8000-000000000999',
      title: 'Respond to Jane about Android Rebel',
      references: [{ kind: 'email', threadId: 'thread-1', provider: 'gmail' }],
      addedAt: now + 999,
    });

    const selected = selectEmailResolutionCandidates([...unsupportedItems, emailItem], {
      mode: 'normal',
      maxItems: 15,
      now,
    });

    expect(selected).toHaveLength(1);
    expect(selected[0].id).toBe(emailItem.id);
  });

  it('does not let unsupported Outlook email items starve Gmail resolution checks', () => {
    const outlookItems = Array.from({ length: 20 }, (_, index) => item({
      id: `00000000-0000-4000-8001-${String(index + 1).padStart(12, '0')}`,
      title: `Respond to Outlook item ${index + 1}`,
      references: [{ kind: 'email', threadId: `outlook-thread-${index + 1}`, provider: 'outlook' }],
      addedAt: now + index,
    }));
    const gmailItem = item({
      id: '00000000-0000-4000-8001-000000000999',
      title: 'Respond to Gmail thread',
      references: [{ kind: 'email', threadId: 'gmail-thread-1', provider: 'gmail' }],
      addedAt: now + 999,
    });

    const selected = selectEmailResolutionCandidates([...outlookItems, gmailItem], {
      mode: 'normal',
      maxItems: 15,
      now,
    });

    expect(selected).toHaveLength(1);
    expect(selected[0].id).toBe(gmailItem.id);
  });

  it('uses the supported Gmail reference when an item also has unsupported email refs', () => {
    const mixedReferenceItem = item({
      id: '00000000-0000-4000-8002-000000000001',
      title: 'Respond to mixed provider thread',
      references: [
        { kind: 'email', threadId: 'outlook-thread-1', provider: 'outlook' },
        { kind: 'email', threadId: 'gmail-thread-1', provider: 'gmail' },
      ],
    });

    expect(findSupportedEmailReference(mixedReferenceItem)?.threadId).toBe('gmail-thread-1');
  });
});
