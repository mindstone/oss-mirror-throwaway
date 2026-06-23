// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeFileLocation, type FileLocation } from '@rebel/shared';
import type { StagedFileItem } from '../../hooks/useStagedFiles';
import type { SkillChangeNotificationItem } from '../../hooks/useSkillChangeNotifications';

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

import { DrawerApprovalCard } from '../DrawerApprovalCard';
import { DrawerSkillNotificationCard } from '../DrawerSkillNotificationCard';
import { StagedFileCard } from '../StagedFileCard';

afterEach(() => {
  document.body.innerHTML = '';
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

function buildStagedFile(
  location: FileLocation,
  overrides: Partial<StagedFileItem> = {},
): StagedFileItem & { location: FileLocation } {
  return {
    id: 'staged-1',
    realPath: '/Users/demo/General/skills/workflows/demo/SKILL.md',
    spaceName: 'General',
    spacePath: 'General/skills/workflows/demo/SKILL.md',
    sessionId: 'session-1',
    baseHash: 'existing-file',
    summary: 'Summary',
    stagedAt: Date.UTC(2026, 3, 19),
    sensitivity: 'high',
    fileName: location.fileName,
    sessionTitle: 'Inbox review',
    location,
    ...overrides,
  };
}

function buildNotification(
  location?: FileLocation,
): SkillChangeNotificationItem {
  return {
    id: 'notification-1',
    skillName: 'Demo skill',
    skillWorkspacePath: 'General/skills/workflows/demo/SKILL.md',
    spacePath: 'General',
    spaceName: 'General',
    actorLabel: 'Someone',
    actorKind: 'human',
    recipientReason: 'previous_editor',
    createdAt: Date.UTC(2026, 3, 18),
    updatedAt: Date.UTC(2026, 3, 19),
    location,
  };
}

function assertBadge(container: HTMLElement, location: FileLocation, options: { compact?: boolean } = {}) {
  const description = describeFileLocation(location);
  const badge = container.querySelector('[data-testid="file-location-badge"]');
  const label = container.querySelector('[data-testid="file-location-badge-label"]');

  expect(badge).not.toBeNull();
  expect(label?.textContent).toBe(options.compact ? description.shortLabel : description.label);
  expect(badge?.getAttribute('data-tooltip-content')).toBe(description.tooltip);

  if (location.kind === 'legacy-missing-location') {
    expect(badge?.className).toMatch(/degraded/i);
    expect(container.querySelector('[data-testid="file-location-badge-warning-icon"]')).not.toBeNull();
  } else {
    expect(container.querySelector('[data-testid="file-location-badge-warning-icon"]')).toBeNull();
  }
}

describe('desktop approval cards render FileLocationBadge', () => {
  const variants: Array<[string, FileLocation]> = [
    ['in-space', inSpaceLocation()],
    ['outside-workspace', outsideWorkspaceLocation()],
    ['legacy-missing-location', legacyLocation()],
  ];

  it.each(variants)('DrawerApprovalCard renders %s path via FileLocationBadge', (_name, location) => {
    const rendered = renderIntoBody(
      <DrawerApprovalCard
        stagedFile={buildStagedFile(location, { spaceName: undefined })}
        onSave={vi.fn()}
        onKeepPrivate={vi.fn()}
      />,
    );

    assertBadge(rendered.container, location, { compact: true });
    rendered.cleanup();
  });

  it.each(variants)('DrawerSkillNotificationCard renders %s path via FileLocationBadge', (_name, location) => {
    const rendered = renderIntoBody(
      <DrawerSkillNotificationCard
        notification={buildNotification(location)}
        onView={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    assertBadge(rendered.container, location, { compact: true });
    rendered.cleanup();
  });

  it('DrawerSkillNotificationCard falls back to the skillWorkspacePath basename when location is absent', () => {
    const rendered = renderIntoBody(
      <DrawerSkillNotificationCard
        notification={buildNotification()}
        onView={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    const label = rendered.container.querySelector('[data-testid="file-location-badge-label"]');
    expect(label?.textContent).toContain('SKILL.md');
    expect(label?.textContent).not.toContain('Demo skill');

    rendered.cleanup();
  });

  it('DrawerSkillNotificationCard follows the drawer approval card layout contract', () => {
    const onView = vi.fn();
    const onDismiss = vi.fn();
    const rendered = renderIntoBody(
      <DrawerSkillNotificationCard
        notification={buildNotification(inSpaceLocation())}
        onView={onView}
        onDismiss={onDismiss}
      />,
    );

    expect(rendered.container.querySelector('.drawer-card__headline-row')).not.toBeNull();
    expect(rendered.container.querySelector('.drawer-card__time-row')).toBeNull();
    expect(rendered.container.querySelector('.drawer-card__type-icon svg')).not.toBeNull();
    expect(rendered.container.querySelector('.drawer-card__headline-copy')).not.toBeNull();
    expect(rendered.container.querySelector('.drawer-card__headline-title')?.textContent).toContain('Demo skill');

    const viewButton = rendered.container.querySelector(
      '[data-testid="drawer-card-skill-notification-open"]',
    ) as HTMLButtonElement | null;
    const dismissButton = rendered.container.querySelector(
      '[data-testid="drawer-card-skill-notification-dismiss"]',
    ) as HTMLButtonElement | null;

    expect(viewButton?.className).toContain('drawer-card__action-button');
    expect(viewButton?.className).toContain('drawer-card__btn-main-action');
    expect(dismissButton?.className).toContain('drawer-card__action-button');
    expect(dismissButton?.className).toContain('drawer-card__btn-tertiary');

    viewButton?.click();
    dismissButton?.click();

    expect(onView).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);

    rendered.cleanup();
  });

  it.each(variants)('StagedFileCard renders %s path via FileLocationBadge', (_name, location) => {
    const rendered = renderIntoBody(
      <StagedFileCard
        file={buildStagedFile(location)}
        onApprove={vi.fn()}
        onDeny={vi.fn()}
        onPreview={vi.fn()}
      />,
    );

    assertBadge(rendered.container, location);
    rendered.cleanup();
  });
});
