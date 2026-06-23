// @vitest-environment happy-dom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CARD_COPY,
  PermissionGrantCard,
} from '../../src/permissions/PermissionGrantCard';
import type { PendingPermissionEntry } from '../../src/permissions/permissionState';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Mounted {
  container: HTMLDivElement;
  root: Root;
  unmount: () => void;
}

function mount(ui: React.ReactElement): Mounted {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(ui);
  });
  return {
    container,
    root,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

function makeEntry(
  overrides: Partial<PendingPermissionEntry> = {},
): PendingPermissionEntry {
  return {
    origin: 'https://portal.pitchbook.com',
    capability: 'read_page',
    tabIds: [11],
    firstRequestedAt: Date.now(),
    lastRequestedAt: Date.now(),
    displayName: 'Pitchbook',
    ...overrides,
  };
}

interface ChromeMock {
  permissions: {
    request: ReturnType<typeof vi.fn>;
  };
  runtime: {
    getURL: ReturnType<typeof vi.fn>;
  };
}

function stubChrome(
  overrides: Partial<ChromeMock['permissions']> = {},
): ChromeMock {
  const permissions = {
    request: vi.fn(async () => true),
    ...overrides,
  } as ChromeMock['permissions'];
  const runtime = {
    getURL: vi.fn((path: string) => `chrome-extension://fake-id/${path}`),
  };
  const chromeMock = { permissions, runtime } as ChromeMock;
  vi.stubGlobal('chrome', chromeMock);
  return chromeMock;
}

describe('PermissionGrantCard', () => {
  let mounted: Mounted | null = null;

  beforeEach(() => {
    stubChrome();
  });

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('renders the idle state with verbatim brand-voice copy and a11y label', () => {
    const entry = makeEntry();
    mounted = mount(
      <PermissionGrantCard
        entry={entry}
        onAllow={vi.fn()}
        surface="popup"
      />,
    );

    const card = mounted.container.querySelector(
      '[data-testid="permission-grant-card"]',
    );
    expect(card).not.toBeNull();
    expect(card?.getAttribute('data-state')).toBe('idle');

    // Title, body, summary, body-of-summary — verbatim against CARD_COPY.
    const displayOrigin = 'portal.pitchbook.com';
    expect(mounted.container.textContent).toContain(
      CARD_COPY.title(displayOrigin),
    );
    expect(mounted.container.textContent).toContain(
      CARD_COPY.body(displayOrigin),
    );
    expect(mounted.container.textContent).toContain(
      CARD_COPY.whatThisMeansSummary,
    );
    expect(mounted.container.textContent).toContain(
      CARD_COPY.whatThisMeansBody,
    );
    expect(mounted.container.textContent).toContain(CARD_COPY.revokeLink);

    const allowBtn = mounted.container.querySelector(
      '[data-testid="permission-allow"]',
    ) as HTMLButtonElement | null;
    expect(allowBtn).not.toBeNull();
    expect(allowBtn?.textContent).toBe(
      CARD_COPY.primaryIdle(displayOrigin),
    );
    expect(allowBtn?.getAttribute('aria-label')).toBe(
      `Allow Rebel on ${displayOrigin}`,
    );

    const dismissBtn = mounted.container.querySelector(
      '[data-testid="permission-not-now"]',
    ) as HTMLButtonElement | null;
    expect(dismissBtn).not.toBeNull();
    expect(dismissBtn?.textContent).toBe(CARD_COPY.secondaryDismiss);
  });

  it('keyboard tab order follows Allow → Not now → Revoke link → summary', () => {
    const entry = makeEntry();
    mounted = mount(
      <PermissionGrantCard
        entry={entry}
        onAllow={vi.fn()}
        surface="popup"
      />,
    );

    // Gather all tabbable-by-default elements in document order. The card
    // relies on native tab order (no explicit tabindex beyond defaults) so
    // the document order IS the tab order.
    const tabbables = Array.from(
      mounted.container.querySelectorAll(
        'button, a[href], summary',
      ) as NodeListOf<HTMLElement>,
    );

    // Expected order: Not now → Allow → revoke link → summary
    // (Secondary renders BEFORE primary in the DOM per flex justify-end
    // so the primary visually sits on the right; but tab order follows
    // DOM order.)
    //
    // The task specifies Allow → Not now → Revoke link → expandable summary
    // for tab order. We therefore expect the DOM order to match that.
    const testIds = tabbables.map((el) => el.getAttribute('data-testid'));
    // Summary doesn't get a data-testid; check tag name instead.
    expect(testIds[0]).toBe('permission-allow');
    expect(testIds[1]).toBe('permission-not-now');
    expect(testIds[2]).toBe('permission-revoke-link');
    expect(tabbables[3]?.tagName.toLowerCase()).toBe('summary');
  });

  it('single-flight: two rapid clicks dispatch exactly one chrome.permissions.request', async () => {
    const chromeMock = stubChrome({
      request: vi.fn(
        () =>
          new Promise<boolean>((resolve) => {
            // Leave unresolved long enough to interleave the second click.
            setTimeout(() => resolve(true), 50);
          }),
      ),
    });
    const onAllow = vi.fn();

    mounted = mount(
      <PermissionGrantCard
        entry={makeEntry()}
        onAllow={onAllow}
        surface="popup"
      />,
    );

    const allowBtn = mounted.container.querySelector(
      '[data-testid="permission-allow"]',
    ) as HTMLButtonElement;

    await act(async () => {
      allowBtn.click();
      allowBtn.click();
    });

    // Exactly one request dispatched.
    expect(chromeMock.permissions.request).toHaveBeenCalledTimes(1);

    // While pending, the button is disabled + aria-disabled + the label
    // has swapped to "Waiting for Chrome…".
    expect(allowBtn.hasAttribute('disabled')).toBe(true);
    expect(allowBtn.getAttribute('aria-disabled')).toBe('true');
    expect(allowBtn.textContent).toBe(CARD_COPY.primaryAwaiting);
    // pointer-events none — enforced via inline style so rapid clicks cannot
    // even reach the handler in a real browser.
    expect(allowBtn.style.pointerEvents).toBe('none');

    // Let the promise settle so the test tears down cleanly.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 75));
    });
    expect(onAllow).toHaveBeenCalledTimes(1);
  });

  it('passes { origins: [matchPattern] } (not <all_urls>) to chrome.permissions.request', async () => {
    const chromeMock = stubChrome({
      request: vi.fn(async () => true),
    });
    mounted = mount(
      <PermissionGrantCard
        entry={makeEntry({ origin: 'https://portal.pitchbook.com' })}
        onAllow={vi.fn()}
        surface="popup"
      />,
    );

    const allowBtn = mounted.container.querySelector(
      '[data-testid="permission-allow"]',
    ) as HTMLButtonElement;
    await act(async () => {
      allowBtn.click();
      await Promise.resolve();
    });

    expect(chromeMock.permissions.request).toHaveBeenCalledWith({
      origins: ['https://portal.pitchbook.com/*'],
    });
    expect(chromeMock.permissions.request).not.toHaveBeenCalledWith({
      origins: ['<all_urls>'],
    });
  });

  it('transitions to "denied" state with softened copy when chrome returns false', async () => {
    stubChrome({ request: vi.fn(async () => false) });
    mounted = mount(
      <PermissionGrantCard
        entry={makeEntry()}
        onAllow={vi.fn()}
        surface="popup"
      />,
    );

    const allowBtn = mounted.container.querySelector(
      '[data-testid="permission-allow"]',
    ) as HTMLButtonElement;
    await act(async () => {
      allowBtn.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    const card = mounted.container.querySelector(
      '[data-testid="permission-grant-card"]',
    );
    expect(card?.getAttribute('data-state')).toBe('denied');
    const displayOrigin = 'portal.pitchbook.com';
    expect(mounted.container.textContent).toContain(
      CARD_COPY.deniedBody(displayOrigin),
    );
    // Softened denial — MUST NOT contain shaming language.
    expect(mounted.container.textContent).not.toContain('you declined');
    expect(mounted.container.textContent).not.toContain('You previously declined');
  });

  it('transitions to "request-failed" state when chrome.permissions.request throws', async () => {
    stubChrome({
      request: vi.fn(async () => {
        throw new Error('policy denial');
      }),
    });
    mounted = mount(
      <PermissionGrantCard
        entry={makeEntry()}
        onAllow={vi.fn()}
        surface="popup"
      />,
    );

    const allowBtn = mounted.container.querySelector(
      '[data-testid="permission-allow"]',
    ) as HTMLButtonElement;
    await act(async () => {
      allowBtn.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    const card = mounted.container.querySelector(
      '[data-testid="permission-grant-card"]',
    );
    expect(card?.getAttribute('data-state')).toBe('request-failed');
    expect(mounted.container.textContent).toContain(
      CARD_COPY.requestFailedBody,
    );
    // Distinct from denied — no "No problem" copy.
    expect(mounted.container.textContent).not.toContain(
      CARD_COPY.deniedBody('portal.pitchbook.com'),
    );
  });

  it('calls onAllow with the origin only after a successful grant', async () => {
    stubChrome({ request: vi.fn(async () => true) });
    const onAllow = vi.fn(async () => undefined);
    mounted = mount(
      <PermissionGrantCard
        entry={makeEntry()}
        onAllow={onAllow}
        surface="popup"
      />,
    );

    const allowBtn = mounted.container.querySelector(
      '[data-testid="permission-allow"]',
    ) as HTMLButtonElement;
    await act(async () => {
      allowBtn.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onAllow).toHaveBeenCalledWith('https://portal.pitchbook.com');
  });

  it('calls onDismiss when the user clicks "Not now"', () => {
    const onDismiss = vi.fn();
    mounted = mount(
      <PermissionGrantCard
        entry={makeEntry()}
        onAllow={vi.fn()}
        onDismiss={onDismiss}
        surface="popup"
      />,
    );

    const dismissBtn = mounted.container.querySelector(
      '[data-testid="permission-not-now"]',
    ) as HTMLButtonElement;
    act(() => {
      dismissBtn.click();
    });

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('renders the globe SVG fallback when the favicon image fails to load', async () => {
    mounted = mount(
      <PermissionGrantCard
        entry={makeEntry()}
        onAllow={vi.fn()}
        surface="popup"
      />,
    );

    const img = mounted.container.querySelector(
      '[data-testid="favicon-img"]',
    ) as HTMLImageElement | null;
    expect(img).not.toBeNull();

    await act(async () => {
      img?.dispatchEvent(new Event('error'));
    });

    expect(
      mounted.container.querySelector('[data-testid="favicon-fallback"]'),
    ).not.toBeNull();
    expect(
      mounted.container.querySelector('[data-testid="favicon-img"]'),
    ).toBeNull();
  });

  it('renders the globe fallback when chrome.runtime.getURL is unavailable', () => {
    vi.stubGlobal('chrome', { permissions: { request: vi.fn() } });
    mounted = mount(
      <PermissionGrantCard
        entry={makeEntry()}
        onAllow={vi.fn()}
        surface="popup"
      />,
    );

    expect(
      mounted.container.querySelector('[data-testid="favicon-fallback"]'),
    ).not.toBeNull();
    expect(
      mounted.container.querySelector('[data-testid="favicon-img"]'),
    ).toBeNull();
  });

  it('requests a 32px favicon for HiDPI while rendering at 20px', () => {
    const chromeMock = stubChrome();
    mounted = mount(
      <PermissionGrantCard
        entry={makeEntry()}
        onAllow={vi.fn()}
        surface="popup"
      />,
    );

    expect(chromeMock.runtime.getURL).toHaveBeenCalledWith(
      `_favicon/?pageUrl=${encodeURIComponent('https://portal.pitchbook.com')}&size=32`,
    );
    const img = mounted.container.querySelector(
      '[data-testid="favicon-img"]',
    ) as HTMLImageElement;
    expect(img.getAttribute('width')).toBe('20');
    expect(img.getAttribute('height')).toBe('20');
  });

  it('uses http display suffix for non-secure origins', () => {
    mounted = mount(
      <PermissionGrantCard
        entry={makeEntry({ origin: 'http://localhost:3000' })}
        onAllow={vi.fn()}
        surface="popup"
      />,
    );

    expect(mounted.container.textContent).toContain(
      CARD_COPY.title('localhost:3000 (http)'),
    );
    expect(mounted.container.textContent).toContain(
      CARD_COPY.body('localhost:3000 (http)'),
    );
  });

  it('exports the sidepanel banner copy used by SidePanel.tsx (v2.1 warmth pass)', () => {
    // Spot-check the cross-surface banner title so copy drift fails loudly.
    expect(CARD_COPY.sidepanelBannerTitle).toBe('One thing before I can help here');
  });

  it('exports the verbatim MCP-aligned copy strings', () => {
    // These are the brand-voice-reviewed strings; any edit must be intentional.
    expect(CARD_COPY.successToast).toBe(
      "Thanks. Re-ask Rebel and I'll get on with it.",
    );
    expect(CARD_COPY.revokedToast('example.com')).toBe(
      "Rebel's access to example.com was removed. No hard feelings.",
    );
    expect(CARD_COPY.revokeLink).toBe(
      "You can change this in your browser's extension settings →",
    );
    expect(CARD_COPY.primaryAwaiting).toBe('Waiting for Chrome…');
    expect(CARD_COPY.secondaryDismiss).toBe('Not now');
  });
});
