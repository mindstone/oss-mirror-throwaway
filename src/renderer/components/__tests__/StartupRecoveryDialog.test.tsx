// @vitest-environment happy-dom

/**
 * Stage D (260610_supermcp-install-robustness) chain guard: the StartupRecoveryDialog
 * must (1) render the category-specific guidance for the failureCategory it received
 * over `super-mcp:startup-failed`, and (2) pass that SAME category through to
 * `window.appApi.enterSafeMode` so the relaunched app's Safe Mode context carries it.
 * Without (2) the category silently degrades to undefined and the post-relaunch
 * troubleshooting/error-recovery flow loses its diagnosis.
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StartupRecoveryDialog } from '../StartupRecoveryDialog';
import { SAFE_MODE_CATEGORY_GUIDANCE } from '@renderer/features/app-shell/safeModeCategoryGuidance';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Mounted = { container: HTMLDivElement; root: Root; unmount: () => void };

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
      act(() => { root.unmount(); });
      container.remove();
    },
  };
}

function findButtonByText(text: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === text,
  );
  if (!button) throw new Error(`Button "${text}" not found`);
  return button as HTMLButtonElement;
}

describe('StartupRecoveryDialog (failed variant)', () => {
  let mounted: Mounted | null = null;
  const enterSafeMode = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    enterSafeMode.mockClear();
    Object.assign(window, { appApi: { enterSafeMode } });
  });

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
  });

  it('shows the category guidance and passes the received category into enterSafeMode', async () => {
    mounted = mount(
      <StartupRecoveryDialog
        open
        onContinueWaiting={() => {}}
        variant="failed"
        errorCategory="missing_bundle"
        sentryEventId="evt-123"
      />,
    );

    // (1) The category-specific guidance line is what the user actually sees
    expect(document.body.textContent).toContain(SAFE_MODE_CATEGORY_GUIDANCE.missing_bundle);

    // (2) "Start in Safe Mode" forwards reason + category + event id unchanged
    await act(async () => {
      findButtonByText('Start in Safe Mode').click();
      await Promise.resolve();
    });
    expect(enterSafeMode).toHaveBeenCalledTimes(1);
    expect(enterSafeMode).toHaveBeenCalledWith({
      reason: 'failure',
      errorCategory: 'missing_bundle',
      sentryEventId: 'evt-123',
    });
  });
});
