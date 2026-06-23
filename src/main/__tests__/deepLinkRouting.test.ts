/**
 * CHARACTERIZATION TEST for the deep-link extraction
 * (plan: docs/plans/260623_refactor-index-startup-extract/PLAN.md).
 *
 * Pins the CRITICAL cross-module contract Stage 2/3 must preserve: the
 * navigation send-vs-buffer seam, plus a couple of representative
 * `mindstone://<provider>/callback` routing branches.
 *
 * Current behavior pinned (src/main/startup/deepLinkHandler.ts, formerly
 * src/main/index.ts):
 *   - handleNavigationDeepLink:
 *       live window  → mainWindow.webContents.send('app:navigate-deep-link', url);
 *                       if minimized → restore(); then focus()
 *       no live window (null OR destroyed) → setPendingNavigationUrl(url) (buffer)
 *   - handleDeepLink:
 *       url startsWith `${NAV_DEEP_LINK_PROTOCOL}://` (rebel://) → handleNavigationDeepLink, return
 *       url startsWith `${DEEP_LINK_PROTOCOL}://slack/callback`    → handleSlackOAuthCallback
 *       url startsWith `${DEEP_LINK_PROTOCOL}://microsoft/callback`→ handleMicrosoftOAuthCallback
 *       (10-way provider dispatch; per-handler `.catch(log)`)
 *
 * STAGE-2 MECHANISM (Decision Log §8.2 refinement): the extracted module imports
 * its OAuth callback handlers DIRECTLY (not injected), so routing is asserted by
 * `vi.mock`-ing the provider service modules. Only the two genuinely index.ts-local
 * accessors (`getMainWindow`, `setPendingNavigationUrl`) are injected via deps —
 * the nav send-vs-buffer seam below exercises those. The asserted BEHAVIORS are
 * identical to the pre-extraction code.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the directly-imported OAuth provider modules so routing is testable
// without the real service graph. Each export is a spy.
vi.mock('../services/slackAuthService', () => ({
  handleSlackOAuthCallback: vi.fn(async () => {}),
}));
vi.mock('../services/microsoftAuthService', () => ({
  handleMicrosoftOAuthCallback: vi.fn(async () => {}),
}));

import { createDeepLinkHandler } from '../startup/deepLinkHandler';
import { handleSlackOAuthCallback } from '../services/slackAuthService';
import { handleMicrosoftOAuthCallback } from '../services/microsoftAuthService';

/** Minimal mock window matching the surface handleNavigationDeepLink touches. */
function makeMockWindow(opts: { destroyed?: boolean; minimized?: boolean } = {}) {
  const send = vi.fn();
  const restore = vi.fn();
  const focus = vi.fn();
  return {
    win: {
      isDestroyed: () => opts.destroyed ?? false,
      isMinimized: () => opts.minimized ?? false,
      restore,
      focus,
      webContents: { send },
    },
    send,
    restore,
    focus,
  };
}

// Module-level OAuth spies are shared across tests (vi.mock factories run once),
// so reset call history between tests to keep assertions independent.
beforeEach(() => {
  vi.clearAllMocks();
});

function makeDeps(getMainWindow: () => unknown) {
  const setPendingNavigationUrl = vi.fn();
  // `as never` keeps the structural mock decoupled from the BrowserWindow type
  // without an explicit-any lint disable.
  const handler = createDeepLinkHandler({
    getMainWindow: getMainWindow as never,
    setPendingNavigationUrl,
  });
  return { handler, setPendingNavigationUrl };
}

describe('handleNavigationDeepLink (nav send-vs-buffer seam)', () => {
  it('sends to the renderer + focuses when a live window exists', () => {
    const { win, send, restore, focus } = makeMockWindow({ minimized: false });
    const { handler, setPendingNavigationUrl } = makeDeps(() => win);

    handler.handleNavigationDeepLink('rebel://space/123');

    expect(send).toHaveBeenCalledWith('app:navigate-deep-link', 'rebel://space/123');
    expect(focus).toHaveBeenCalledTimes(1);
    expect(restore).not.toHaveBeenCalled(); // not minimized → no restore
    expect(setPendingNavigationUrl).not.toHaveBeenCalled(); // sent, not buffered
  });

  it('restores a minimized live window before focusing', () => {
    const { win, restore, focus } = makeMockWindow({ minimized: true });
    const { handler } = makeDeps(() => win);

    handler.handleNavigationDeepLink('rebel://settings/connectors');

    expect(restore).toHaveBeenCalledTimes(1);
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it('buffers into pendingNavigationUrl when there is no window', () => {
    const { handler, setPendingNavigationUrl } = makeDeps(() => null);

    handler.handleNavigationDeepLink('rebel://space/123');

    expect(setPendingNavigationUrl).toHaveBeenCalledWith('rebel://space/123');
  });

  it('buffers when the window is destroyed (treated as no live window)', () => {
    const { win, send } = makeMockWindow({ destroyed: true });
    const { handler, setPendingNavigationUrl } = makeDeps(() => win);

    handler.handleNavigationDeepLink('rebel://space/123');

    expect(setPendingNavigationUrl).toHaveBeenCalledWith('rebel://space/123');
    expect(send).not.toHaveBeenCalled();
  });
});

describe('handleDeepLink (representative provider routing)', () => {
  it('routes rebel:// nav links to the navigation seam (buffers when no window)', () => {
    const { handler, setPendingNavigationUrl } = makeDeps(() => null);

    handler.handleDeepLink('rebel://space/123');

    expect(setPendingNavigationUrl).toHaveBeenCalledWith('rebel://space/123');
    expect(handleSlackOAuthCallback).not.toHaveBeenCalled();
  });

  it('routes mindstone://slack/callback to the Slack OAuth handler', () => {
    const { win } = makeMockWindow();
    const { handler } = makeDeps(() => win);

    handler.handleDeepLink('mindstone://slack/callback?code=abc');

    expect(handleSlackOAuthCallback).toHaveBeenCalledWith('mindstone://slack/callback?code=abc');
    expect(handleMicrosoftOAuthCallback).not.toHaveBeenCalled();
  });

  it('routes mindstone://microsoft/callback to the Microsoft OAuth handler', () => {
    const { win } = makeMockWindow();
    const { handler } = makeDeps(() => win);

    handler.handleDeepLink('mindstone://microsoft/callback?code=abc');

    expect(handleMicrosoftOAuthCallback).toHaveBeenCalledWith('mindstone://microsoft/callback?code=abc');
    expect(handleSlackOAuthCallback).not.toHaveBeenCalled();
  });
});
