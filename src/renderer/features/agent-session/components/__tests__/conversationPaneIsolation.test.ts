import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const CONVERSATION_PANE_CSS = fs.readFileSync(
  path.resolve(__dirname, '..', 'ConversationPane.module.css'),
  'utf8',
);

function extractRuleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const headPattern = new RegExp(`(^|\\n)${escaped}\\s*\\{`);
  const headMatch = css.match(headPattern);
  if (!headMatch || headMatch.index === undefined) {
    throw new Error(`Selector "${selector}" not found in ConversationPane.module.css`);
  }
  const bodyStart = headMatch.index + headMatch[0].length;
  const tail = css.slice(bodyStart);
  const tailMatch = tail.match(/\n\}/);
  if (!tailMatch || tailMatch.index === undefined) {
    throw new Error(`Closing brace for "${selector}" not found in ConversationPane.module.css`);
  }
  return tail.slice(0, tailMatch.index);
}

describe('Stage 4 — transcript stacking-context isolation (F8)', () => {
  it('.sessionLogShell declares `isolation: isolate` so transcript repaints do not invalidate the app-shell composite tree', () => {
    const body = extractRuleBody(CONVERSATION_PANE_CSS, '.sessionLogShell');

    expect(body).toMatch(/isolation\s*:\s*isolate\s*;/);
  });

  it('.sessionLog declares `contain: layout style paint` so the scroll/virtualised list clips outside-the-box paint walks', () => {
    const body = extractRuleBody(CONVERSATION_PANE_CSS, '.sessionLog');

    expect(body).toMatch(/contain\s*:\s*layout\s+style\s+paint\s*;/);
  });

  it('.sessionLog containment value did not regress to `layout style` alone (paint containment is the Stage 4 win)', () => {
    const body = extractRuleBody(CONVERSATION_PANE_CSS, '.sessionLog');

    expect(body).not.toMatch(/contain\s*:\s*layout\s+style\s*;/);
  });
});
