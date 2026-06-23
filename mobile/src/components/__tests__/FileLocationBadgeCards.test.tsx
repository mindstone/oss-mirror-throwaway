import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import type { MemoryWriteApproval, StagedFile } from '@rebel/cloud-client';
import { describeFileLocation, type FileLocation } from '@rebel/shared';

jest.mock('@expo/vector-icons', () => {
  const { Text } = require('react-native');
  return {
    Feather: ({ name, testID }: { name: string; testID?: string }) => (
      <Text testID={testID}>{name}</Text>
    ),
  };
});

jest.mock('../../utils/haptics', () => ({
  hapticMedium: jest.fn(),
  hapticWarning: jest.fn(),
  hapticLight: jest.fn(),
  hapticHeavy: jest.fn(),
  hapticSuccess: jest.fn(),
}));

import { StagedFileCard } from '../StagedFileCard';
import { MemoryApprovalCard } from '../ApprovalCards';

function inSpaceLocation(): FileLocation {
  return {
    kind: 'in-space',
    spaceName: 'Project',
    spaceWorkspacePath: 'Project',
    spaceRelativePath: 'notes.md',
    workspaceRelativePath: 'Project/notes.md',
    fileName: 'notes.md',
    absolutePath: '/ws/Project/notes.md',
  };
}

function outsideWorkspaceLocation(): FileLocation {
  return {
    kind: 'outside-workspace',
    absolutePath: '/tmp/project/notes.md',
    fileName: 'notes.md',
    outsideCategory: 'outside',
  };
}

function legacyLocation(): FileLocation {
  return {
    kind: 'legacy-missing-location',
    fileName: 'notes.md',
    spaceName: 'Project',
    legacyPath: 'Project/notes.md',
  };
}

function makeStagedFile(overrides: Partial<StagedFile> = {}): StagedFile {
  return {
    id: 'staged-1',
    realPath: 'Project/notes.md',
    spaceName: 'Project',
    spacePath: 'Project/notes.md',
    sessionId: 'session-1',
    baseHash: 'hash',
    summary: 'Updated notes',
    stagedAt: Date.now(),
    sensitivity: 'high',
    hasConflict: false,
    ...overrides,
  };
}

function makeMemoryApproval(overrides: Partial<MemoryWriteApproval> = {}): MemoryWriteApproval {
  return {
    toolUseId: 'memory-1',
    originalTurnId: 'turn-1',
    originalSessionId: 'session-1',
    spaceName: 'Project',
    spacePath: 'Project/notes.md',
    filePath: 'Project/notes.md',
    summary: 'Updated notes',
    contentPreview: 'Preview',
    timestamp: Date.now(),
    isNewFile: false,
    blockedBy: 'safety_prompt',
    staged: false,
    sharing: 'private',
    ...overrides,
  };
}

function assertBadge(rendered: ReturnType<typeof render>, location: FileLocation) {
  const description = describeFileLocation(location);
  expect(rendered.getByTestId('file-location-badge-label').props.children).toBe(description.label);
  fireEvent(rendered.getByTestId('file-location-badge'), 'longPress');
  expect(rendered.getByTestId('file-location-badge-tooltip')).toBeTruthy();
  expect(rendered.getByText(description.tooltip)).toBeTruthy();
  if (location.kind === 'legacy-missing-location') {
    expect(rendered.queryByTestId('file-location-badge-warning-icon')).toBeTruthy();
  } else {
    expect(rendered.queryByTestId('file-location-badge-warning-icon')).toBeNull();
  }
}

describe('mobile approval cards render FileLocationBadge', () => {
  const variants: Array<[string, FileLocation]> = [
    ['in-space', inSpaceLocation()],
    ['outside-workspace', outsideWorkspaceLocation()],
    ['legacy-missing-location', legacyLocation()],
  ];

  it.each(variants)('StagedFileCard renders %s location via FileLocationBadge', (_name, location) => {
    const rendered = render(
      <StagedFileCard
        file={makeStagedFile({ location })}
        onPublish={jest.fn()}
        onDiscard={jest.fn()}
        onKeepPrivate={jest.fn()}
      />,
    );

    assertBadge(rendered, location);
  });

  it.each(variants)('MemoryApprovalCard renders %s location via FileLocationBadge', (_name, location) => {
    const rendered = render(
      <MemoryApprovalCard
        approval={makeMemoryApproval({ location })}
        onSave={jest.fn()}
        onSkip={jest.fn()}
      />,
    );

    assertBadge(rendered, location);
  });
});
