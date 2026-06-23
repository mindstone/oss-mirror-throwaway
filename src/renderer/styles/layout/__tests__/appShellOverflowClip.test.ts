import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Regression guard for REBEL-68G / FOX-3493:
 * "When you add a custom model, the whole app shifts up to the top left — you
 * lose the top bar, and need to restart."
 *
 * Root cause: `.app-shell` used `overflow: hidden`, which still makes an
 * element a programmatically-scrollable scroll container. The Settings →
 * Agent & Voice "just added" model row appends below the fold and calls
 * `scrollIntoView()` / `focus()` (see ProfileTable.tsx). Those walked up and
 * scrolled the whole shell to ~70px, pushing the app header off-screen with no
 * scrollbar to recover — persisting until restart.
 *
 * Fix: `overflow: clip` clips identically but is NOT a scroll container, so the
 * shell can never be displaced by a descendant scrollIntoView/focus/anchor.
 * jsdom has no layout/scroll engine, so the live behaviour can't be unit-tested;
 * this asserts the CSS rule that encodes the fix so it can't silently regress
 * back to a scroll-establishing value.
 */
const APP_SHELL_CSS = fs.readFileSync(
  path.resolve(__dirname, '..', 'app-shell.css'),
  'utf8',
);

function extractRuleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const headPattern = new RegExp(`(^|\\n)${escaped}\\s*\\{`);
  const headMatch = css.match(headPattern);
  if (!headMatch || headMatch.index === undefined) {
    throw new Error(`Selector "${selector}" not found in app-shell.css`);
  }
  const bodyStart = headMatch.index + headMatch[0].length;
  const tail = css.slice(bodyStart);
  const tailMatch = tail.match(/\n\}/);
  if (!tailMatch || tailMatch.index === undefined) {
    throw new Error(`Closing brace for "${selector}" not found in app-shell.css`);
  }
  return tail.slice(0, tailMatch.index);
}

describe('REBEL-68G — .app-shell must not be a scroll container', () => {
  const body = extractRuleBody(APP_SHELL_CSS, '.app-shell');

  it('.app-shell declares `overflow: clip` (clips without becoming scrollable)', () => {
    expect(body).toMatch(/overflow\s*:\s*clip\s*;/);
  });

  it('.app-shell did NOT regress to a scroll-establishing overflow (hidden/auto/scroll)', () => {
    // `clip` and `visible` are the only non-scroll-container values; any of
    // hidden/auto/scroll would re-open the displacement bug.
    expect(body).not.toMatch(/overflow\s*:\s*(hidden|auto|scroll)\s*;/);
  });
});

describe('REBEL-68G — .flow-stage must not be a scroll container', () => {
  // `.flow-stage` (the conversation-surface flex wrapper around transcript +
  // composer + compaction overlay) is the same class of non-scroll-intended
  // `overflow: hidden` container as `.app-shell`: a descendant scrollIntoView/
  // focus on below-the-fold content could otherwise scroll the whole surface
  // with no scrollbar to recover. The transcript's own `.sessionLog` owns
  // scrolling, so `.flow-stage` must use `overflow: clip`.
  const body = extractRuleBody(APP_SHELL_CSS, '.app-shell.flow-mode .flow-stage');

  it('.flow-stage declares `overflow: clip` (clips without becoming scrollable)', () => {
    expect(body).toMatch(/overflow\s*:\s*clip\s*;/);
  });

  it('.flow-stage did NOT regress to a scroll-establishing overflow (hidden/auto/scroll)', () => {
    expect(body).not.toMatch(/overflow\s*:\s*(hidden|auto|scroll)\s*;/);
  });
});
