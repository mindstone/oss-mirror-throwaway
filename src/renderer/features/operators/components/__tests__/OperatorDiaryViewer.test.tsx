import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { OperatorMetadata } from '@shared/ipc/channels/operators';
import { OperatorDiaryViewer } from '../OperatorDiaryViewer';

const operator: OperatorMetadata = {
  id: '/workspace/Chief-of-Staff::customer-voice',
  operatorSlug: 'customer-voice',
  spacePath: '/workspace/Chief-of-Staff',
  sourceSpacePath: '/workspace/Chief-of-Staff',
  category: 'space',
  name: 'Customer Voice',
  description: 'Grounds work in customer language.',
  consult_when: 'When the plan needs customer evidence.',
  kind: 'operator',
  roles: ['operator'],
  operatorFileAbsolutePath: '/workspace/Chief-of-Staff/operators/customer-voice/OPERATOR.md',
  groundingPath: '/workspace/Chief-of-Staff/operators/customer-voice/grounding.md',
  diaryPath: '/workspace/Chief-of-Staff/operators/customer-voice/diary.md',
};

describe('OperatorDiaryViewer', () => {
  it('renders empty state copy', () => {
    const html = renderToString(createElement(OperatorDiaryViewer, {
      operator,
      initialDiary: '',
    }));

    expect(html).toContain('Recently asked');
    expect(html).toContain('No questions asked yet.');
  });

  it('renders diary entries read-only', () => {
    const html = renderToString(createElement(OperatorDiaryViewer, {
      operator,
      initialDiary: '## Today\nAsked about onboarding copy.',
    }));

    expect(html).toContain('Asked about onboarding copy.');
  });
});
