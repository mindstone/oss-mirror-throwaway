// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMockWindowApi, flushAsync } from '@renderer/test-utils';
import { describeFileLocation, type FileLocation } from '@rebel/shared';
import type { StagedFileItem } from '../../hooks/useStagedFiles';

const { showToastMock } = vi.hoisted(() => ({
  showToastMock: vi.fn(),
}));

 
vi.mock('@renderer/components/ui', async () => {
  const ReactLocal = await vi.importActual<typeof import('react')>('react');
  const actual = await vi.importActual<typeof import('@renderer/components/ui')>('@renderer/components/ui');
  return {
    ...actual,
    Tooltip: ({
      content,
      children,
    }: {
      content: React.ReactNode;
      children: React.ReactElement<Record<string, unknown>>;
    }) => ReactLocal.cloneElement(children, {
      'data-tooltip-content': String(content),
    }),
    useToast: () => ({ showToast: showToastMock }),
  };
});

 
vi.mock('react-diff-viewer-continued', () => ({
  default: () => <div data-testid="diff-viewer" />,
  DiffMethod: { WORDS: 'WORDS' },
}));

 
vi.mock('@renderer/components/SafeMarkdown', () => ({
  SafeMarkdown: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { StagedFilePreviewDialog } from '../StagedFilePreviewDialog';
import { buildEvalErrorUserReason } from '@shared/safety/evalErrorCopy';

function installMutationObserverStub() {
  class MutationObserverStub {
    observe() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  }

  Object.defineProperty(globalThis, 'MutationObserver', {
    configurable: true,
    writable: true,
    value: MutationObserverStub,
  });
}

function inSpaceLocation(): FileLocation {
  return {
    kind: 'in-space',
    spaceName: 'General',
    spaceWorkspacePath: 'General',
    spaceRelativePath: 'skills/workflows/demo/SKILL.md',
    workspaceRelativePath: 'General/skills/workflows/demo/SKILL.md',
    fileName: 'SKILL.md',
    absolutePath: '/Users/demo/General/skills/workflows/demo/SKILL.md',
  };
}

function outsideWorkspaceLocation(): FileLocation {
  return {
    kind: 'outside-workspace',
    absolutePath: '/tmp/rebel/report.md',
    fileName: 'report.md',
    outsideCategory: 'outside',
  };
}

function legacyLocation(): FileLocation {
  return {
    kind: 'legacy-missing-location',
    fileName: 'skill.md',
    spaceName: 'General',
    legacyPath: 'General/skills/skill.md',
  };
}

function buildFile(overrides: Partial<StagedFileItem> & { location?: FileLocation } = {}): StagedFileItem & { location?: FileLocation } {
  return {
    id: 'staged-1',
    realPath: 'memory/inbox/notes.md',
    spaceName: 'Memory',
    spacePath: 'memory/inbox/notes.md',
    sessionId: 'session-1',
    baseHash: 'existing-file',
    summary: 'Saved summary',
    stagedAt: Date.UTC(2026, 3, 16),
    sensitivity: 'high',
    fileName: 'notes.md',
    sessionTitle: 'Inbox review',
    ...overrides,
  };
}

function findButton(label: string): HTMLButtonElement {
  const button = Array.from(document.body.querySelectorAll('button')).find((candidate) =>
    candidate.textContent?.includes(label),
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Could not find button containing "${label}"`);
  }
  return button;
}

async function renderDialog(
  file: StagedFileItem | null,
  overrides: Partial<React.ComponentProps<typeof StagedFilePreviewDialog>> = {},
) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const onClose = vi.fn();
  const onOpenFilePath = vi.fn();

  await act(async () => {
    root.render(
      <StagedFilePreviewDialog
        file={file}
        onClose={onClose}
        onOpenFilePath={onOpenFilePath}
        onPublish={vi.fn().mockResolvedValue({ success: true })}
        onDiscard={vi.fn().mockResolvedValue({ success: true })}
        {...overrides}
      />,
    );
  });

  await flushAsync();
  await flushAsync();

  return {
    onClose,
    onOpenFilePath,
    cleanup: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

describe('StagedFilePreviewDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installMutationObserverStub();
    createMockWindowApi('api', {
      getStagedContent: vi.fn().mockResolvedValue('staged body'),
      readWorkspaceFile: vi.fn().mockResolvedValue({ content: 'original body' }),
      publishWithConflictResolution: vi.fn().mockResolvedValue({ status: 'success' }),
      // Stage B (260417_approval_consolidation_closeout): resolve calls
      // now mint a token first. Default happy-path mock keeps existing
      // tests green.
      mintConflictCapability: vi.fn().mockResolvedValue({
        success: true,
        token: 'test.capability.token',
        expiresAt: Date.now() + 5 * 60 * 1000,
      }),
    });
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('does not render the dialog when no staged file is selected', async () => {
    const rendered = await renderDialog(null);

    expect(document.body.querySelector('[role="dialog"]')).toBeNull();

    rendered.cleanup();
  });

  it('renders BlastRadiusStrip in the header when preview data is provided', async () => {
    const rendered = await renderDialog(
      buildFile(),
      {
        blastRadius: {
          where: [{ label: 'Shared Space', evidence: 'explicit' }],
          whoCanSeeIt: [{ label: 'Company-wide', evidence: 'explicit' }],
          afterwards: [{ label: 'Can edit after saving', evidence: 'derived' }],
        },
        riskReasons: ['Shared'],
      },
    );

    const strip = document.body.querySelector('[data-testid="blast-radius-strip"]');
    expect(strip).not.toBeNull();
    expect(strip?.textContent).toContain('Shared Space');
    expect(strip?.textContent).toContain('Company-wide');
    expect(strip?.textContent).toContain('Can edit after saving');
    expect(strip?.textContent).toContain('Shared');

    rendered.cleanup();
  });

  it('opens the staged file through onOpenFilePath when the library path is clicked without mutating window.location.href', async () => {
    const file = buildFile();
    const initialHref = window.location.href;
    const rendered = await renderDialog(file);
    const openButton = document.body.querySelector('button[aria-label="Open file in library"]');

    await act(async () => {
      if (!(openButton instanceof HTMLButtonElement)) {
        throw new Error('Could not find open-in-library button');
      }
      openButton.click();
    });

    expect(window.location.href).toBe(initialHref);
    expect(rendered.onOpenFilePath).toHaveBeenCalledTimes(1);
    expect(rendered.onOpenFilePath).toHaveBeenCalledWith(file.realPath);
    expect(rendered.onClose).toHaveBeenCalledTimes(1);

    rendered.cleanup();
  });

  it('renders new files without a clickable library-navigation button', async () => {
    const file = buildFile({
      baseHash: 'new-file',
      realPath: 'memory/inbox/new-note.md',
      spacePath: 'memory/inbox/new-note.md',
      fileName: 'new-note.md',
    });
    const rendered = await renderDialog(file);

    const clickablePath = document.body.querySelector('button[aria-label="Open file in library"]');

    expect(clickablePath).toBeNull();
    expect(document.body.textContent).toContain('Memory / new-note.md');
    expect(document.body.textContent).toContain('Review before saving');
    expect(document.body.textContent).toContain('Draft prepared. Review the file before Rebel saves it to Memory.');
    expect(document.body.textContent).not.toContain('Ready to allow');
    expect(document.body.textContent).not.toContain('Saved as draft');

    rendered.cleanup();
  });

  it('renders unclear sharing metadata without broken Unknown copy', async () => {
    const rendered = await renderDialog(buildFile({ sharing: undefined }));

    expect(document.body.textContent).toContain('Unclear');
    expect(document.body.textContent).not.toContain('Unknown');

    rendered.cleanup();
  });

  it('uses the shared sharing badge labels for known non-private visibility', async () => {
    const rendered = await renderDialog(buildFile({ sharing: 'company-wide' }));

    expect(document.body.textContent).toContain('Company-wide');
    expect(document.body.textContent).not.toContain('Unknown');

    rendered.cleanup();
  });

  it('renders eval_error staged files as paused save decisions', async () => {
    const rendered = await renderDialog(buildFile({ blockedBy: 'eval_error' }), {
      onKeepPrivate: vi.fn().mockResolvedValue({ success: true }),
    });

    expect(document.body.textContent).toContain('Paused before saving');
    expect(document.body.textContent).toContain(buildEvalErrorUserReason());
    expect(findButton("Don't save this")).toBeTruthy();
    expect(findButton('Save it once')).toBeTruthy();
    expect(document.body.textContent).not.toContain('Allow & choose rule update');

    rendered.cleanup();
  });

  it.each([
    ['in-space', inSpaceLocation()],
    ['outside-workspace', outsideWorkspaceLocation()],
    ['legacy-missing-location', legacyLocation()],
  ] as const)('renders %s FileLocationBadge with tooltip metadata', async (_name, location) => {
    const rendered = await renderDialog(buildFile({ location, fileName: location.fileName }));
    const description = describeFileLocation(location);
    const badge = document.body.querySelector('[data-testid="file-location-badge"]');
    const label = document.body.querySelector('[data-testid="file-location-badge-label"]');

    expect(label?.textContent).toBe(description.label);
    expect(badge?.getAttribute('data-tooltip-content')).toBe(description.tooltip);

    if (location.kind === 'legacy-missing-location') {
      expect(badge?.className).toMatch(/degraded/i);
    }

    rendered.cleanup();
  });

  // ===========================================================================
  // F2-2: Error handling (Stage 2 D8 — fail loudly, not silently)
  // ===========================================================================

  it('surfaces an explicit error with Retry when the remote-original read fails with a permission error, and disables Publish (F2-2)', async () => {
    createMockWindowApi('api', {
      getStagedContent: vi.fn().mockResolvedValue('staged body'),
      readWorkspaceFile: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })),
      publishWithConflictResolution: vi.fn().mockResolvedValue({ status: 'success' }),
      mintConflictCapability: vi.fn().mockResolvedValue({
        success: true,
        token: 'test.capability.token',
        expiresAt: Date.now() + 5 * 60 * 1000,
      }),
    });

    const rendered = await renderDialog(buildFile());

    // Explicit error copy is surfaced, not a generic "Failed to load content".
    expect(document.body.textContent).toContain('permission denied');
    // Retry button is rendered and wired.
    expect(document.body.querySelector('[data-testid="staged-file-retry-button"]')).not.toBeNull();
    // Publish (Allow) is disabled while the error is active.
    const allowButton = findButton('Allow');
    expect(allowButton.disabled).toBe(true);

    rendered.cleanup();
  });

  it('surfaces an explicit error with Retry and disables Publish when staged-content IPC reports a canonical { content: null, error } response, even for a new file (F2-2)', async () => {
    createMockWindowApi('api', {
      // Canonical shape returned by `memory:staging-get-content` on failure.
      getStagedContent: vi
        .fn()
        .mockResolvedValue({ content: null, error: 'Invalid staged file ID' }),
      readWorkspaceFile: vi.fn(),
      publishWithConflictResolution: vi.fn().mockResolvedValue({ status: 'success' }),
      mintConflictCapability: vi.fn().mockResolvedValue({
        success: true,
        token: 'test.capability.token',
        expiresAt: Date.now() + 5 * 60 * 1000,
      }),
    });

    const rendered = await renderDialog(
      buildFile({ baseHash: 'new-file' /* new file → we still expect a hard error */ }),
    );

    // Error surfaces with the IPC detail — NOT silently "no content" / delete.
    expect(document.body.textContent).toContain('Invalid staged file ID');
    expect(document.body.querySelector('[data-testid="staged-file-retry-button"]')).not.toBeNull();
    // Allow is disabled.
    const allowButton = findButton('Allow');
    expect(allowButton.disabled).toBe(true);

    rendered.cleanup();
  });
});
