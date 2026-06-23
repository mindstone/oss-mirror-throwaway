// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FileLocation } from '@rebel/shared';
import type { StagedFileItem } from '../../hooks/useStagedFiles';
import { StagedFileCard } from '../StagedFileCard';
import { buildEvalErrorUserReason } from '@shared/safety/evalErrorCopy';
import cardStyles from '../ApprovalCard.module.css';
import sharingBadgeStyles from '@renderer/components/approval/primitives/SharingBadge.module.css';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

 
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

 
vi.mock('@renderer/transport/useDesktopApprovalTransport', () => ({
  useDesktopApprovalTransport: () => ({
    safetyPrompt: {
      generateOptions: vi.fn().mockResolvedValue({ options: [], chosenPrompt: '', rawResponse: '' }),
      generateDenyOptions: vi.fn().mockResolvedValue({ options: [], chosenPrompt: '', rawResponse: '' }),
      update: vi.fn().mockResolvedValue({ success: true }),
      applySelection: vi.fn().mockResolvedValue({ success: true }),
      addInstruction: vi.fn().mockResolvedValue({ success: true }),
    },
    toolSafety: {
      addToolAllowRule: vi.fn().mockResolvedValue({ success: true }),
      addToolBlockRule: vi.fn().mockResolvedValue({ success: true }),
      isToolPermanentlyTrusted: vi.fn().mockResolvedValue({ trusted: false, scope: null }),
      addTrustedTool: vi.fn().mockResolvedValue({ success: true }),
    },
  }),
}));

 
vi.mock('@rebel/cloud-client', async () => {
  const actual = await vi.importActual<typeof import('@rebel/cloud-client')>('@rebel/cloud-client');
  return {
    ...actual,
    usePrincipleOptions: () => ({
      generationState: 'idle',
      options: [],
      generationError: null,
      selectedOption: null,
      otherText: '',
      applyState: 'idle',
      applyError: null,
      appliedUpdate: null,
      selectOption: vi.fn(),
      setOtherText: vi.fn(),
      confirmSelection: vi.fn(),
      confirmTrustedTool: vi.fn(),
      cancelTrustedTool: vi.fn(),
      goBack: vi.fn(),
      retryGeneration: vi.fn(),
      resolveOnce: vi.fn(),
      approveOnce: vi.fn(),
      retryApply: vi.fn(),
      startGeneration: vi.fn(),
      direction: 'allow',
    }),
  };
});

type CleanupHandle = { cleanup: () => void; container: HTMLElement };

function renderIntoBody(element: React.ReactNode): CleanupHandle {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  act(() => {
    root.render(<>{element}</>);
  });

  return {
    container,
    cleanup: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
      document.body.innerHTML = '';
    },
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

function buildStagedFile(overrides: Partial<StagedFileItem> = {}): StagedFileItem {
  return {
    id: 'staged-file-1',
    realPath: '/Users/demo/General/skills/workflows/demo/SKILL.md',
    spaceName: 'General',
    spacePath: 'General/skills/workflows/demo/SKILL.md',
    sessionId: 'session-1',
    baseHash: 'existing-file',
    summary: 'Summary of staged file content',
    stagedAt: Date.UTC(2026, 3, 19),
    sensitivity: 'high',
    fileName: 'SKILL.md',
    sessionTitle: 'Inbox review',
    location: inSpaceLocation(),
    ...overrides,
  };
}

function getSharingBadge(container: HTMLElement): HTMLSpanElement | null {
  return container.querySelector(`.${cardStyles.memoryDestination} .${sharingBadgeStyles.badge}`) as HTMLSpanElement | null;
}

function expectSharingBadge(container: HTMLElement, variantClass: string, label: string): void {
  const badge = getSharingBadge(container);
  expect(badge).not.toBeNull();
  expect(badge?.className).toContain(sharingBadgeStyles.badge);
  expect(badge?.className).toContain(variantClass);
  expect(badge?.textContent).toContain(label);
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

describe('StagedFileCard', () => {
  it('renders a private sharing badge for private staged files', () => {
    const rendered = renderIntoBody(
      <StagedFileCard
        file={buildStagedFile({ sharing: 'private' })}
        onApprove={vi.fn()}
        onDeny={vi.fn()}
        onPreview={vi.fn()}
      />,
    );

    expectSharingBadge(rendered.container, sharingBadgeStyles.private, 'Private');

    rendered.cleanup();
  });

  it('renders a restricted sharing badge for restricted staged files', () => {
    const rendered = renderIntoBody(
      <StagedFileCard
        file={buildStagedFile({ sharing: 'restricted' })}
        onApprove={vi.fn()}
        onDeny={vi.fn()}
        onPreview={vi.fn()}
      />,
    );

    expectSharingBadge(rendered.container, sharingBadgeStyles.shared, 'Restricted');

    rendered.cleanup();
  });

  it('renders an unclear sharing badge for staged files with undefined sharing', () => {
    const rendered = renderIntoBody(
      <StagedFileCard
        file={buildStagedFile({ sharing: undefined })}
        onApprove={vi.fn()}
        onDeny={vi.fn()}
        onPreview={vi.fn()}
      />,
    );

    expectSharingBadge(rendered.container, sharingBadgeStyles.unclear, 'Unclear');

    rendered.cleanup();
  });

  it('renders an unclear sharing badge for staged files with empty-string sharing', () => {
    const rendered = renderIntoBody(
      <StagedFileCard
        file={buildStagedFile({ sharing: '' })}
        onApprove={vi.fn()}
        onDeny={vi.fn()}
        onPreview={vi.fn()}
      />,
    );

    expectSharingBadge(rendered.container, sharingBadgeStyles.unclear, 'Unclear');

    rendered.cleanup();
  });

  it('keeps card preview clicks bubbling through the sharing badge', () => {
    const onPreview = vi.fn();
    const rendered = renderIntoBody(
      <StagedFileCard
        file={buildStagedFile({ sharing: 'restricted' })}
        onApprove={vi.fn()}
        onDeny={vi.fn()}
        onPreview={onPreview}
      />,
    );

    const sharingBadge = getSharingBadge(rendered.container);
    expect(sharingBadge).not.toBeNull();

    act(() => {
      sharingBadge?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onPreview).toHaveBeenCalledTimes(1);

    rendered.cleanup();
  });

  it('renders eval_error staged files as paused save decisions', () => {
    const rendered = renderIntoBody(
      <StagedFileCard
        file={buildStagedFile({ blockedBy: 'eval_error' })}
        onApprove={vi.fn()}
        onDeny={vi.fn()}
        onPreview={vi.fn()}
      />,
    );

    expect(rendered.container.textContent).toContain(buildEvalErrorUserReason());
    expect(rendered.container.textContent).toContain("Don't save this");
    expect(rendered.container.textContent).toContain('Save it once');
    expect(rendered.container.textContent).not.toContain('Allow & choose rule update');

    rendered.cleanup();
  });
});
