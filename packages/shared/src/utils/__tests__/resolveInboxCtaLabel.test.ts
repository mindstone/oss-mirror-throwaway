import { resolveInboxCtaLabel } from '../resolveInboxCtaLabel';
import type { ResolveInboxCtaLabelItem } from '../resolveInboxCtaLabel';

const item = (overrides: Partial<ResolveInboxCtaLabelItem> = {}): ResolveInboxCtaLabelItem => ({
  ...overrides,
});

describe('resolveInboxCtaLabel', () => {
  it('uses Review even when the item has a specific action label', () => {
    expect(resolveInboxCtaLabel(item({ actionLabel: 'Approve expense' }))).toBe('Review');
  });

  it('uses Review for verb-led and noun-led titles', () => {
    expect(resolveInboxCtaLabel(item({ title: 'Send proposal to Hannah' }))).toBe('Review');
    expect(resolveInboxCtaLabel(item({ title: 'Revenue update: $559K' }))).toBe('Review');
  });

  it('uses Review for empty or missing titles', () => {
    expect(resolveInboxCtaLabel(item({ title: '' }))).toBe('Review');
    expect(resolveInboxCtaLabel(item({ title: null }))).toBe('Review');
    expect(resolveInboxCtaLabel(item({}))).toBe('Review');
  });

  it('uses Review regardless of draft/source/references', () => {
    const rich = item({
      title: 'Fix the proposal',
      draft: 'some draft',
      clarifyingQuestion: 'formal or casual?',
      source: { kind: 'automation' },
      references: [{ kind: 'email' }],
      actions: [{ type: 'shareToSocial' }],
      category: 'follow-up',
    });
    expect(resolveInboxCtaLabel(rich)).toBe('Review');
  });
});
