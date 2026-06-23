// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { renderToString } from 'react-dom/server';
import { createElement } from 'react';
import { DocumentBlock } from '../DocumentBlock';

// Regression guard: the document-draft preview must keep line breaks for
// Slack/email-style drafts (single newlines → <br>). This pins the `breaks`
// opt-in wiring at DocumentBlock.tsx so removing it can't silently regress.
// See docs/plans/260615_fix-document-preview-linebreaks/PLAN.md.
const SLACK_DRAFT = [
  '*This week / today:*',
  '• Main focus is getting Rebel into a better public shape.',
  '• Also keeping an eye on reliability and cost plumbing.',
].join('\n');

describe('DocumentBlock preview', () => {
  it('renders single newlines as line breaks (breaks opt-in wired through)', () => {
    const html = renderToString(
      createElement(DocumentBlock, { content: SLACK_DRAFT, language: 'markdown' }),
    );
    // Preview is the default view mode; the draft's single newlines must become <br>.
    expect(html).toMatch(/<br\s*\/?>/);
    expect(html).toContain('Main focus');
  });
});
