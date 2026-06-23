// @vitest-environment happy-dom
/**
 * WorkspaceConflictDialog — pending-cloud-update affordance (REBEL-696 Stage 5).
 *
 * A pending update is a DISTINCT single-action card (NOT the three-way conflict
 * UI): "Update to newest" fast-forwards a file whose newer version arrived from
 * the synced workspace. These
 * tests cover the brief's load-bearing behaviours:
 *   - pending card renders with the calm copy + single "Update to newest" action
 *   - pending-only state uses the calm title ("Newer versions ready"), not alarm
 *   - clicking apply calls the dedicated channel and shows the success toast
 *   - a failed apply surfaces an error toast + inline error, and does NOT remove
 *     the card (no silent success)
 */

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ShowToastFn } from '@renderer/contexts';
import { WorkspaceConflictDialog } from '../WorkspaceConflictDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const originalCloudApi = window.cloudApi;

// Public pending-update shape: only `relativePath` crosses the preload boundary
// (REBEL-696 Fix 2 — store-internal hashes/timestamps stay main-side).
type PendingUpdate = {
  relativePath: string;
};

function makePending(relativePath: string): PendingUpdate {
  return { relativePath };
}

interface SetupOptions {
  pendingUpdates?: PendingUpdate[];
  conflicts?: Array<{ localPath: string; cloudCopyPath: string; relativePath: string }>;
  applyResult?: { success: boolean; reason?: string; error?: string };
}

async function flush(): Promise<void> {
  // Let the queued microtasks (the list load promise) settle.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function setup(options: SetupOptions = {}) {
  const pendingUpdates = options.pendingUpdates ?? [];
  const conflicts = options.conflicts ?? [];
  const applyResult = options.applyResult ?? { success: true };

  const workspacePendingUpdateApply = vi.fn(async () => applyResult);
  const workspaceConflictList = vi.fn(async () => ({ conflicts, pendingUpdates }));
  const onWorkspacePendingUpdates = vi.fn(() => () => {});

  (window as unknown as { cloudApi: unknown }).cloudApi = {
    workspaceConflictList,
    workspacePendingUpdateApply,
    workspaceConflictMerge: vi.fn(),
    workspaceConflictResolve: vi.fn(),
    onWorkspacePendingUpdates,
  };

  const showToast = vi.fn() as unknown as ShowToastFn;

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(
      <WorkspaceConflictDialog open onOpenChange={() => {}} showToast={showToast} />,
    );
  });
  await flush();

  return { root, container, showToast, workspacePendingUpdateApply, workspaceConflictList };
}

afterEach(() => {
  (window as unknown as { cloudApi: unknown }).cloudApi = originalCloudApi;
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

describe('WorkspaceConflictDialog — pending cloud updates', () => {
  it('renders a pending-update card with the calm copy and a single "Update to newest" action', async () => {
    await setup({ pendingUpdates: [makePending('memory/topics/note.md')] });

    const card = document.body.querySelector('[data-testid="pending-update-card"]');
    expect(card).not.toBeNull();
    expect(card?.textContent).toContain('memory/topics/note.md');
    expect(card?.textContent).toContain('A newer version is available from your synced workspace.');
    // Source-neutral copy: never misattribute the edit to "you" (the change may
    // come from a teammate, another device, or Rebel's own agent). See Stage 1
    // of docs/plans/260622_conflict-dialog-false-positives/PLAN.md.
    expect(card?.textContent).not.toContain('you edited');

    const applyBtn = document.body.querySelector('[data-testid="pending-update-apply"]');
    expect(applyBtn).not.toBeNull();
    expect(applyBtn?.textContent).toContain('Update to newest');

    // It must NOT offer the three-way conflict controls (no false risk / footgun).
    expect(document.body.textContent).not.toContain('Keep mine');
    expect(document.body.textContent).not.toContain('Ask Rebel to merge');
  });

  it('pending-only state uses the calm title (no alarm)', async () => {
    await setup({ pendingUpdates: [makePending('a.md')] });

    const header = document.body.querySelector('[data-testid="workspace-conflict-dialog-header"]');
    expect(header?.textContent).toContain('Newer versions ready');
    expect(header?.textContent).not.toContain('Resolve file conflicts');
  });

  it('clicking "Update to newest" calls the dedicated apply channel and shows the success toast', async () => {
    const { showToast, workspacePendingUpdateApply, workspaceConflictList } = await setup({
      pendingUpdates: [makePending('memory/note.md')],
      applyResult: { success: true },
    });

    // After a successful apply the silent reload should show an empty list.
    workspaceConflictList.mockResolvedValueOnce({ conflicts: [], pendingUpdates: [] });

    const applyBtn = document.body.querySelector('[data-testid="pending-update-apply"]') as HTMLButtonElement;
    await act(async () => {
      applyBtn.click();
    });
    await flush();

    expect(workspacePendingUpdateApply).toHaveBeenCalledWith({ relativePath: 'memory/note.md' });
    expect(showToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Updated to the newest version', variant: 'success' }),
    );
  });

  it('a failed apply surfaces an error toast and keeps the card (no silent success)', async () => {
    const { showToast, workspacePendingUpdateApply } = await setup({
      pendingUpdates: [makePending('memory/note.md')],
      applyResult: { success: false, reason: 'cloud_read_failed', error: "Couldn't update that file. Try again." },
    });

    const applyBtn = document.body.querySelector('[data-testid="pending-update-apply"]') as HTMLButtonElement;
    await act(async () => {
      applyBtn.click();
    });
    await flush();

    expect(workspacePendingUpdateApply).toHaveBeenCalledWith({ relativePath: 'memory/note.md' });
    expect(showToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Couldn't update that file", variant: 'error' }),
    );
    // The card is still present (apply returned failure; the silent reload still
    // lists the pending update because the mock keeps returning it).
    expect(document.body.querySelector('[data-testid="pending-update-card"]')).not.toBeNull();
  });
});
