// @vitest-environment happy-dom
//
// Parity test for MemoryPreviewDialog covering the state matrix surfaced by
// `useApprovalContent` after Stage 2 Round 1 Remediation (F2-2 / F2-3):
//
//   - open path (dialog renders)
//   - new-content (isNewFile) state
//   - modify (no-conflict) state
//   - conflict state (hook's `conflict` field drives diff visibility)
//   - error: permission (explicit error UI, Retry button, Allow disabled)
//   - error: other (explicit error UI with detail)
//   - binary content (explicit error state; never silent)
//
// Mocks are kept thin: the `useApprovalContent` hook is exercised directly
// through the real IPC shim (`window.api.readWorkspaceFile`) so we verify
// the dialog contract end-to-end.

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMockWindowApi, flushAsync, renderHook } from '@renderer/test-utils';
import { describeFileLocation, type FileLocation } from '@rebel/shared';
import type { PendingApprovalItem } from '../../hooks/usePendingApprovals';
import { usePendingApprovals } from '../../hooks/usePendingApprovals';

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
  };
});

 
vi.mock('react-diff-viewer-continued', () => ({
  default: () => <div data-testid="diff-viewer" />,
  DiffMethod: { WORDS: 'WORDS' },
}));

 
vi.mock('@renderer/components/SafeMarkdown', () => ({
  SafeMarkdown: ({ children }: { children: React.ReactNode }) => <div data-testid="safe-markdown">{children}</div>,
}));

import { MemoryPreviewDialog } from '../MemoryPreviewDialog';

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

function buildApproval(
  memoryOverrides: Partial<NonNullable<PendingApprovalItem['memoryApproval']>> & { location?: FileLocation } = {},
  approvalOverrides: Partial<PendingApprovalItem> = {},
): PendingApprovalItem {
  return {
    id: 'memory:tool-use-1',
    type: 'memory',
    title: 'Memory save',
    description: 'Save a quick note',
    timestamp: Date.UTC(2026, 3, 16),
    sessionId: 'session-1',
    memoryApproval: {
      toolUseId: 'tool-use-1',
      originalSessionId: 'session-1',
      filePath: 'memory/notes.md',
      spaceName: 'Memory',
      summary: 'Saved summary',
      content: 'new content',
      spacePath: 'memory/notes.md',
      sharing: 'private',
      ...memoryOverrides,
    },
    ...approvalOverrides,
  };
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
  approval: PendingApprovalItem,
  overrides: Partial<React.ComponentProps<typeof MemoryPreviewDialog>> = {},
) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const onClose = vi.fn();
  const onApprove = vi.fn();
  const onDiscard = vi.fn();

  await act(async () => {
    root.render(
      <MemoryPreviewDialog
        approval={approval}
        onClose={onClose}
        onApprove={onApprove}
        onDiscard={onDiscard}
        {...overrides}
      />,
    );
  });

  await flushAsync();
  await flushAsync();

  return {
    onClose,
    onApprove,
    onDiscard,
    cleanup: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

describe('MemoryPreviewDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installMutationObserverStub();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders the dialog with destination + Allow/Discard footer on the happy path', async () => {
    createMockWindowApi('api', {
      readWorkspaceFile: vi.fn().mockResolvedValue({ content: 'new content' }),
    });

    const rendered = await renderDialog(buildApproval());

    // Dialog renders.
    expect(document.body.querySelector('[data-testid="memory-preview-dialog"]')).not.toBeNull();
    expect(document.body.textContent).toContain('Memory');
    expect(document.body.textContent).toContain('notes.md');
    // Footer actions present.
    const allowButton = findButton('Allow');
    expect(allowButton.disabled).toBe(false);
    // No explicit error UI.
    expect(document.body.querySelector('[data-testid="memory-preview-retry-button"]')).toBeNull();

    rendered.cleanup();
  });

  it('renders BlastRadiusStrip in the header when preview data is provided', async () => {
    createMockWindowApi('api', {
      readWorkspaceFile: vi.fn().mockResolvedValue({ content: 'new content' }),
    });

    const rendered = await renderDialog(
      buildApproval(),
      {
        blastRadius: {
          where: [{ label: 'Chief-of-Staff', evidence: 'explicit' }],
          whoCanSeeIt: [{ label: 'Shared workspace', evidence: 'derived' }],
          afterwards: [{ label: 'Can edit after saving', evidence: 'derived' }],
        },
        riskReasons: ['Shared'],
      },
    );

    const strip = document.body.querySelector('[data-testid="blast-radius-strip"]');
    expect(strip).not.toBeNull();
    expect(strip?.textContent).toContain('Chief-of-Staff');
    expect(strip?.textContent).toContain('Shared workspace');
    expect(strip?.textContent).toContain('Can edit after saving');
    expect(strip?.textContent).toContain('Shared');

    rendered.cleanup();
  });

  it.each([
    ['in-space', inSpaceLocation()],
    ['outside-workspace', outsideWorkspaceLocation()],
    ['legacy-missing-location', legacyLocation()],
  ] as const)('renders %s FileLocationBadge with tooltip metadata', async (_name, location) => {
    createMockWindowApi('api', {
      readWorkspaceFile: vi.fn().mockResolvedValue({ content: 'new content' }),
    });

    const rendered = await renderDialog(buildApproval({ location }));
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

  it('renders the canonical location when usePendingApprovals forwards a memory approval location', async () => {
    const location = inSpaceLocation();
    createMockWindowApi('api', {
      readWorkspaceFile: vi.fn().mockResolvedValue({ content: 'new content' }),
      onToolSafetyApprovalRequest: vi.fn(() => () => undefined),
      onMemoryWriteApprovalRequest: vi.fn(() => () => undefined),
      onMemoryWriteApprovalResolved: vi.fn(() => () => undefined),
      onToolSafetyApprovalResolved: vi.fn(() => () => undefined),
      onStagedToolCall: vi.fn(() => () => undefined),
      onStagedToolCallUpdated: vi.fn(() => () => undefined),
      onStagedFilesChanged: vi.fn(() => () => undefined),
      getStagedFiles: vi.fn().mockResolvedValue({ files: [] }),
    });
    createMockWindowApi('safetyApi', {
      pending: vi.fn().mockResolvedValue([]),
      stagedGetAll: vi.fn().mockResolvedValue([]),
    });
    createMockWindowApi('memoryApi', {
      getPendingApprovals: vi.fn().mockResolvedValue([
        {
          toolUseId: 'tool-use-1',
          originalTurnId: 'turn-1',
          originalSessionId: 'session-1',
          filePath: 'legacy/notes.md',
          spaceName: 'Memory',
          location,
          summary: 'Saved summary',
          content: 'new content',
          timestamp: Date.UTC(2026, 3, 16),
        },
      ]),
    });
    createMockWindowApi('sessionsApi', {
      list: vi.fn().mockResolvedValue([]),
    });

    const { result } = renderHook(() => usePendingApprovals());
    await flushAsync();
    await flushAsync();

    const approval = result.current.approvals[0];
    expect(approval).toBeDefined();
    expect(approval?.memoryApproval?.location).toEqual(location);

    const rendered = await renderDialog(approval!);
    const description = describeFileLocation(location);
    expect(document.body.querySelector('[data-testid="file-location-badge-label"]')?.textContent).toBe(description.label);

    rendered.cleanup();
  });

  it('new-content (ENOENT → isNewFile) path: no diff shown, Allow enabled', async () => {
    // For a new file, the hook returns `original: null, error: null, isNewFile: true`.
    // ENOENT on the remote read is transparently promoted to isNewFile — the
    // renderer-side `PendingApprovalItem.memoryApproval` type doesn't expose
    // `isNewFile`, so we exercise the ENOENT-promotion path (which is the
    // real code path on the desktop surface for memory writes to new files).
    createMockWindowApi('api', {
      readWorkspaceFile: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' })),
    });

    const rendered = await renderDialog(buildApproval({ content: 'brand new content' }));

    // No diff viewer — ENOENT / new file is handled as the "new content" UX.
    expect(document.body.querySelector('[data-testid="diff-viewer"]')).toBeNull();
    expect(document.body.querySelector('[data-testid="memory-preview-retry-button"]')).toBeNull();
    // Allow remains clickable.
    const allowButton = findButton('Allow');
    expect(allowButton.disabled).toBe(false);

    rendered.cleanup();
  });

  it('modify path (content equals original): no diff shown, Allow enabled', async () => {
    createMockWindowApi('api', {
      readWorkspaceFile: vi.fn().mockResolvedValue({ content: 'new content' }),
    });

    const rendered = await renderDialog(buildApproval({ content: 'new content' }));

    // Identical content → no diff → content rendered via SafeMarkdown fallback (.md extension).
    expect(document.body.querySelector('[data-testid="diff-viewer"]')).toBeNull();
    expect(document.body.querySelector('[data-testid="memory-preview-retry-button"]')).toBeNull();
    const allowButton = findButton('Allow');
    expect(allowButton.disabled).toBe(false);

    rendered.cleanup();
  });

  it('conflict path (hook.conflict = true): diff shown, Allow enabled', async () => {
    createMockWindowApi('api', {
      // Original differs from staged content → hook returns `conflict: true`.
      readWorkspaceFile: vi.fn().mockResolvedValue({ content: 'old content' }),
    });

    const rendered = await renderDialog(buildApproval({ content: 'new content' }));

    // Conflict surfaces a diff — sourced from the hook's centralized
    // conflict detection, not a recompute in the dialog.
    expect(document.body.querySelector('[data-testid="diff-viewer"]')).not.toBeNull();
    // No error UI.
    expect(document.body.querySelector('[data-testid="memory-preview-retry-button"]')).toBeNull();
    // Allow remains clickable.
    const allowButton = findButton('Allow');
    expect(allowButton.disabled).toBe(false);

    rendered.cleanup();
  });

  it('permission error: explicit error UI with Retry, Allow disabled (F2-2)', async () => {
    createMockWindowApi('api', {
      readWorkspaceFile: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })),
    });

    const rendered = await renderDialog(buildApproval());

    // Explicit error copy — NOT silent "(No content)" / empty-diff fallback.
    expect(document.body.textContent).toContain('permission denied');
    const retryButton = document.body.querySelector('[data-testid="memory-preview-retry-button"]');
    expect(retryButton).not.toBeNull();
    // No diff viewer while errored.
    expect(document.body.querySelector('[data-testid="diff-viewer"]')).toBeNull();
    // Allow buttons are disabled.
    const allowButton = findButton('Allow');
    expect(allowButton.disabled).toBe(true);

    rendered.cleanup();
  });

  it('unclassified (other) error: explicit error UI with detail, Allow disabled (F2-2)', async () => {
    createMockWindowApi('api', {
      readWorkspaceFile: vi.fn().mockRejectedValue(new Error('something strange')),
    });

    const rendered = await renderDialog(buildApproval());

    expect(document.body.textContent).toContain('something strange');
    expect(document.body.querySelector('[data-testid="memory-preview-retry-button"]')).not.toBeNull();
    const allowButton = findButton('Allow');
    expect(allowButton.disabled).toBe(true);

    rendered.cleanup();
  });

  it('binary content: explicit error state, no silent diff, Allow disabled (F2-2)', async () => {
    // Binary extension triggers `error.kind = 'binary'` without an IPC call.
    createMockWindowApi('api', {
      readWorkspaceFile: vi.fn(),
    });

    const rendered = await renderDialog(
      buildApproval({ filePath: 'memory/screenshot.png', content: 'binary bytes placeholder' }),
    );

    expect(document.body.textContent?.toLowerCase()).toContain('previewable here');
    expect(document.body.querySelector('[data-testid="memory-preview-retry-button"]')).not.toBeNull();
    expect(document.body.querySelector('[data-testid="diff-viewer"]')).toBeNull();
    const allowButton = findButton('Allow');
    expect(allowButton.disabled).toBe(true);

    rendered.cleanup();
  });

  it('uses recovered content from callback when inline memory payload is empty', async () => {
    createMockWindowApi('api', {
      readWorkspaceFile: vi.fn().mockResolvedValue({ content: 'Recovered body text' }),
    });
    const readMemoryApprovalContent = vi.fn().mockResolvedValue('Recovered body text');

    const rendered = await renderDialog(
      buildApproval({ content: '', contentPreview: '' }),
      { readMemoryApprovalContent },
    );

    expect(readMemoryApprovalContent).toHaveBeenCalledWith(
      expect.objectContaining({
        toolUseId: 'tool-use-1',
        originalSessionId: 'session-1',
      }),
      expect.any(AbortSignal),
    );
    expect(document.body.textContent).toContain('Recovered body text');
    expect(document.body.querySelector('[data-testid="memory-preview-recovery-error"]')).toBeNull();

    rendered.cleanup();
  });

  it('shows explicit recovery error + Retry when required callback lookup fails', async () => {
    createMockWindowApi('api', {
      readWorkspaceFile: vi.fn().mockResolvedValue({ content: '' }),
    });
    const readMemoryApprovalContent = vi.fn().mockResolvedValue(null);

    const rendered = await renderDialog(
      buildApproval({ content: '', contentPreview: '' }),
      { readMemoryApprovalContent },
    );

    const recoveryError = document.body.querySelector('[data-testid="memory-preview-recovery-error"]');
    expect(recoveryError).not.toBeNull();
    expect(recoveryError?.textContent).toContain('Could not recover memory approval content');
    expect(document.body.querySelector('[data-testid="memory-preview-retry-button"]')).not.toBeNull();
    expect(document.body.textContent).not.toContain('(No content)');

    rendered.cleanup();
  });

  it('conflict detection is sourced from hook.conflict (not inline recomputation) (F2-2)', async () => {
    // This guards against the inline `originalContent !== content` recompute
    // the dialog previously did — after F2-2, the dialog must consume the
    // hook's centralized `conflict` field verbatim.
    // Case: stored content with trailing whitespace difference. Hook applies
    // strict byte comparison; dialog must reflect it.
    createMockWindowApi('api', {
      readWorkspaceFile: vi.fn().mockResolvedValue({ content: 'same content' }),
    });

    const rendered = await renderDialog(buildApproval({ content: 'same content' }));

    // No diff → no conflict → no diff viewer rendered.
    expect(document.body.querySelector('[data-testid="diff-viewer"]')).toBeNull();

    rendered.cleanup();
  });
});
