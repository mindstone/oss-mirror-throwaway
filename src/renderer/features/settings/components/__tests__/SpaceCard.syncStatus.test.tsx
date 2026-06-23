// @vitest-environment happy-dom

/**
 * Stage 8 (260619_cloud-symlink-indexing) — the per-space "Reconnecting"
 * degraded-state signal on SpaceCard: the sync-status badge + the comprehension
 * banner across the three locked Chief-Designer states, plus the inert default.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SpaceCard } from '../SpaceCard';
import type { EnrichedSpaceInfo } from '../spaceTypes';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Mounted = { container: HTMLDivElement; root: Root; unmount: () => void };

function mount(ui: React.ReactElement, bodyClass?: string): Mounted {
  if (bodyClass) document.body.className = bodyClass;
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(ui));
  return {
    container,
    root,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function makeCloudSpace(overrides: Partial<EnrichedSpaceInfo> = {}): EnrichedSpaceInfo {
  return {
    name: 'Company Memories',
    path: 'work/Mindstone/Company Memories',
    absolutePath: '/workspace/work/Mindstone/Company Memories',
    type: 'company',
    isSymlink: true,
    hasReadme: true,
    description: 'Shared company knowledge',
    sharing: 'restricted',
    storageProvider: 'google_drive',
    status: 'ok',
    ...overrides,
  };
}

function renderCard(
  space: EnrichedSpaceInfo,
  theme: 'light' | 'dark' = 'dark',
  extra: Partial<React.ComponentProps<typeof SpaceCard>> = {},
): Mounted {
  return mount(
    <SpaceCard
      space={space}
      onEdit={vi.fn()}
      onOpenInWorkspace={vi.fn()}
      onRevealInFolder={vi.fn()}
      onEditReadme={vi.fn()}
      onRemove={vi.fn()}
      onMigrateLegacyAgentsMd={vi.fn()}
      {...extra}
    />,
    theme,
  );
}

describe('SpaceCard cloud sync-status signal', () => {
  let mounted: Mounted | null = null;

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    document.body.innerHTML = '';
    document.body.className = '';
    vi.clearAllMocks();
  });

  it('is INERT for a healthy/absent syncStatus (no badge, no banner)', () => {
    mounted = renderCard(makeCloudSpace({ syncStatus: undefined }));
    expect(mounted.container.querySelector('[data-testid^="space-sync-badge"]')).toBeNull();
    expect(mounted.container.querySelector('[data-testid^="space-sync-banner"]')).toBeNull();
  });

  it('is INERT when syncStatus is explicitly healthy', () => {
    mounted = renderCard(makeCloudSpace({ syncStatus: 'healthy' }));
    expect(mounted.container.querySelector('[data-testid^="space-sync-badge"]')).toBeNull();
    expect(mounted.container.querySelector('[data-testid^="space-sync-banner"]')).toBeNull();
  });

  it('State A — reconnecting + prior index: badge "Reconnecting" + last-known copy + Re-check', () => {
    const onReCheckSync = vi.fn();
    mounted = renderCard(makeCloudSpace({ syncStatus: 'reconnecting' }), 'dark', {
      onReCheckSync,
      hasPriorIndex: true,
    });

    const badge = mounted.container.querySelector('[data-testid="space-sync-badge-reconnecting"]');
    expect(badge?.textContent).toContain('Reconnecting');
    expect(badge?.getAttribute('aria-label')).toBe('Reconnecting to this folder');

    const banner = mounted.container.querySelector('[data-testid="space-sync-banner-reconnecting"]');
    expect(banner?.textContent).toContain('Reconnecting to Google Drive');
    expect(banner?.textContent).toContain('showing your last-known files');
    expect(banner?.getAttribute('role')).toBe('status');

    const recheck = mounted.container.querySelector('[data-testid="space-sync-recheck"]') as HTMLButtonElement;
    expect(recheck).toBeTruthy();
    act(() => recheck.click());
    expect(onReCheckSync).toHaveBeenCalledTimes(1);
  });

  it('State B — reconnecting + NO prior index: honest "empty for now" copy (no last-known claim)', () => {
    mounted = renderCard(makeCloudSpace({ syncStatus: 'reconnecting' }), 'dark', {
      hasPriorIndex: false,
    });
    const banner = mounted.container.querySelector('[data-testid="space-sync-banner-reconnecting"]');
    expect(banner?.textContent).toContain("Can't reach Google Drive yet");
    expect(banner?.textContent).toContain('this space is empty for now');
    expect(banner?.textContent).not.toContain('last-known files');
  });

  it('State C — not_found: "Not found" badge + warning banner with Reconnect + Remove, no recovery promise', () => {
    const onEdit = vi.fn();
    const onRemove = vi.fn();
    mounted = renderCard(makeCloudSpace({ syncStatus: 'not_found' }), 'dark', { onEdit, onRemove });

    const badge = mounted.container.querySelector('[data-testid="space-sync-badge-not-found"]');
    expect(badge?.textContent).toContain('Not found');

    const banner = mounted.container.querySelector('[data-testid="space-sync-banner-not-found"]');
    // JSX uses a curly apostrophe (&rsquo;) for the rendered copy.
    expect(banner?.textContent).toContain('Rebel can’t find this folder anymore');
    expect(banner?.textContent).toContain('Your last-known files are still searchable');
    expect(banner?.textContent).not.toContain('reconnecting');

    const reconnect = mounted.container.querySelector('[data-testid="space-sync-reconnect"]') as HTMLButtonElement;
    const remove = mounted.container.querySelector('[data-testid="space-sync-remove"]') as HTMLButtonElement;
    act(() => reconnect.click());
    expect(onEdit).toHaveBeenCalledTimes(1);
    act(() => remove.click());
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it('hides the Re-check action when no onReCheckSync handler is provided', () => {
    mounted = renderCard(makeCloudSpace({ syncStatus: 'reconnecting' }), 'dark', {
      onReCheckSync: undefined,
    });
    expect(mounted.container.querySelector('[data-testid="space-sync-banner-reconnecting"]')).toBeTruthy();
    expect(mounted.container.querySelector('[data-testid="space-sync-recheck"]')).toBeNull();
  });

  it('never surfaces a raw path/email; uses the friendly provider name (or generic fallback)', () => {
    mounted = renderCard(
      makeCloudSpace({ syncStatus: 'reconnecting', storageProvider: undefined }),
      'dark',
      { hasPriorIndex: true },
    );
    const banner = mounted.container.querySelector('[data-testid="space-sync-banner-reconnecting"]');
    // Unknown provider → generic phrase, never a CloudStorage path.
    expect(banner?.textContent).toContain('this linked folder');
    expect(banner?.textContent).not.toContain('CloudStorage');
    expect(banner?.textContent).not.toContain('@');
  });

  it.each(['light', 'dark'] as const)('renders the reconnecting state in %s mode', (theme) => {
    mounted = renderCard(makeCloudSpace({ syncStatus: 'reconnecting' }), theme, { hasPriorIndex: true });
    expect(mounted.container.querySelector('[data-testid="space-sync-banner-reconnecting"]')).toBeTruthy();
  });
});
