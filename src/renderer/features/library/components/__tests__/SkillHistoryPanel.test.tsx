// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMockWindowApi, flushAsync } from '@renderer/test-utils';

const { showToastMock } = vi.hoisted(() => ({
  showToastMock: vi.fn(),
}));

 
vi.mock('@renderer/features/auth/hooks/useAuth', () => ({
  useAuth: () => ({
    user: {
      id: 'user-1',
      email: 'user@example.com',
    },
  }),
}));

 
vi.mock('@renderer/components/ui', async () => {
  const actual = await vi.importActual<typeof import('@renderer/components/ui')>('@renderer/components/ui');
  return {
    ...actual,
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

import { SkillHistoryPanel } from '../SkillHistoryPanel';

type SkillHistoryApiMock = {
  getVersions: ReturnType<typeof vi.fn>;
  getSnapshot: ReturnType<typeof vi.fn>;
  fork: ReturnType<typeof vi.fn>;
  restore: ReturnType<typeof vi.fn>;
};

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

function findButton(label: string): HTMLButtonElement {
  const button = Array.from(document.body.querySelectorAll('button')).find((candidate) =>
    candidate.textContent?.includes(label),
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Could not find button containing "${label}"`);
  }
  return button;
}

async function renderPanel(
  api: SkillHistoryApiMock,
  overrides: Partial<React.ComponentProps<typeof SkillHistoryPanel>> = {},
) {
  createMockWindowApi('skillHistoryApi', api);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const onOpenFilePath = vi.fn().mockResolvedValue(undefined);
  const onOpenChange = vi.fn();

  await act(async () => {
    root.render(
      <SkillHistoryPanel
        open
        onOpenChange={onOpenChange}
        skillName="Drafting"
        documentPath="skills/drafting.md"
        skillWorkspacePath="skills/drafting.md"
        currentContent="# Drafting"
        onOpenFilePath={onOpenFilePath}
        {...overrides}
      />,
    );
  });

  await flushAsync();
  await flushAsync();

  return {
    onOpenFilePath,
    onOpenChange,
    cleanup: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

function buildApi(overrides: Partial<SkillHistoryApiMock> = {}): SkillHistoryApiMock {
  return {
    getVersions: vi.fn().mockResolvedValue({ success: true, versions: [] }),
    getSnapshot: vi.fn().mockResolvedValue({
      success: true,
      snapshot: {
        snapshotId: 'snap-1',
        timestampMs: Date.UTC(2026, 3, 16),
        contentHash: 'hash-1',
        summary: 'Saved version',
        actorKind: 'human',
        actorId: 'user-1',
        actorLabel: 'User One',
        actorEmail: 'user@example.com',
        skillWorkspacePath: 'skills/drafting.md',
        body: '# Saved version',
        restoredFromSnapshotId: null,
        restoredFromSkillPath: null,
      },
    }),
    fork: vi.fn().mockResolvedValue({ success: true, forkPath: 'skills/drafting-copy.md' }),
    restore: vi.fn().mockResolvedValue({ success: true }),
    ...overrides,
  };
}

async function triggerToastOpenAction(api: SkillHistoryApiMock) {
  const rendered = await renderPanel(api);

  await act(async () => {
    findButton('Save as new skill').click();
  });

  await act(async () => {
    findButton('Save').click();
  });
  await flushAsync();

  const successToast = showToastMock.mock.calls.find(
    ([options]) => options?.action?.label === 'Open it',
  )?.[0];

  if (!successToast?.action) {
    throw new Error('Expected success toast with "Open it" action');
  }

  await act(async () => {
    successToast.action?.onClick();
  });
  await flushAsync();

  return rendered;
}

describe('SkillHistoryPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installMutationObserverStub();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders the empty state when no saved versions exist', async () => {
    const rendered = await renderPanel(buildApi());

    expect(document.body.textContent).toContain('No saved versions yet.');

    rendered.cleanup();
  });

  it('opens the copied skill through onOpenFilePath from the toast action without mutating window.location.href', async () => {
    const api = buildApi({
      getVersions: vi.fn().mockResolvedValue({
        success: true,
        versions: [
          {
            snapshotId: 'snap-1',
            filename: 'drafting.md',
            timestampMs: Date.UTC(2026, 3, 16),
            contentHash: 'hash-1',
            summary: 'Saved version',
            actorKind: 'human',
            actorId: 'user-1',
            actorLabel: 'User One',
            actorEmail: 'user@example.com',
            skillWorkspacePath: 'skills/drafting.md',
            restoredFromSnapshotId: null,
          },
        ],
      }),
      fork: vi.fn().mockResolvedValue({ success: true, forkPath: 'skills/drafting-copy.md' }),
    });
    const initialHref = window.location.href;

    const rendered = await triggerToastOpenAction(api);

    expect(window.location.href).toBe(initialHref);
    expect(rendered.onOpenFilePath).toHaveBeenCalledTimes(1);
    expect(rendered.onOpenFilePath).toHaveBeenCalledWith('skills/drafting-copy.md');

    rendered.cleanup();
  });

  it('closes the panel after opening the copied skill from the toast action', async () => {
    const api = buildApi({
      getVersions: vi.fn().mockResolvedValue({
        success: true,
        versions: [
          {
            snapshotId: 'snap-1',
            filename: 'drafting.md',
            timestampMs: Date.UTC(2026, 3, 16),
            contentHash: 'hash-1',
            summary: 'Saved version',
            actorKind: 'human',
            actorId: 'user-1',
            actorLabel: 'User One',
            actorEmail: 'user@example.com',
            skillWorkspacePath: 'skills/drafting.md',
            restoredFromSnapshotId: null,
          },
        ],
      }),
    });

    const rendered = await triggerToastOpenAction(api);

    expect(rendered.onOpenChange).toHaveBeenCalledWith(false);

    rendered.cleanup();
  });
});
