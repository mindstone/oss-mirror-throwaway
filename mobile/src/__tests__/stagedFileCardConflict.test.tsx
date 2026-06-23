/**
 * StagedFileCard conflict-flow tests — exercises the Stage 6
 * `ConflictCallout` wiring: the callout shows up when handlers are
 * supplied and the file has `hasConflict`, and the correct handler
 * fires on press. Validates the legacy fallback (conflict badge only)
 * when no conflict handlers are provided.
 */

import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import type { StagedFile } from '@rebel/cloud-client';

jest.mock('@expo/vector-icons', () => {
  const { Text } = require('react-native');
  return {
    Feather: ({ name, testID }: { name: string; testID?: string }) => (
      <Text testID={testID}>{name}</Text>
    ),
  };
});
jest.mock('../utils/haptics', () => ({
  hapticMedium: jest.fn(),
  hapticWarning: jest.fn(),
  hapticLight: jest.fn(),
  hapticHeavy: jest.fn(),
  hapticSuccess: jest.fn(),
}));

import { StagedFileCard } from '../components/StagedFileCard';

function mockStagedFile(overrides: Partial<StagedFile> = {}): StagedFile {
  return {
    id: 'stg_42',
    realPath: 'Project/NOTES.md',
    spaceName: 'Project',
    spacePath: 'Project',
    sessionId: 'session-abc',
    baseHash: 'abc',
    summary: 'Updated notes',
    stagedAt: Date.now(),
    sensitivity: 'high' as const,
    hasConflict: false,
    ...overrides,
  };
}

describe('StagedFileCard conflict flow', () => {
  it('renders conflict callout when hasConflict=true and all conflict handlers are supplied', () => {
    const onResolveWithRebel = jest.fn();
    const onKeepMine = jest.fn();
    const onKeepTheirs = jest.fn();
    const file = mockStagedFile({ hasConflict: true });

    const { getByTestId, queryByText } = render(
      <StagedFileCard
        file={file}
        onPublish={jest.fn()}
        onDiscard={jest.fn()}
        onKeepPrivate={jest.fn()}
        onResolveWithRebel={onResolveWithRebel}
        onKeepMine={onKeepMine}
        onKeepTheirs={onKeepTheirs}
      />,
    );

    expect(getByTestId('conflict-callout')).toBeTruthy();
    expect(getByTestId('conflict-callout-resolve-with-rebel')).toBeTruthy();
    expect(getByTestId('conflict-callout-keep-mine')).toBeTruthy();
    expect(getByTestId('conflict-callout-keep-theirs')).toBeTruthy();
    // Legacy "Conflict" badge should NOT render when the callout is shown.
    expect(queryByText('Conflict')).toBeNull();
  });

  it('forwards the file identity to each handler on press', async () => {
    const onResolveWithRebel = jest.fn();
    const onKeepMine = jest.fn();
    const onKeepTheirs = jest.fn();
    const file = mockStagedFile({ hasConflict: true });

    const { getByTestId } = render(
      <StagedFileCard
        file={file}
        onPublish={jest.fn()}
        onDiscard={jest.fn()}
        onKeepPrivate={jest.fn()}
        onResolveWithRebel={onResolveWithRebel}
        onKeepMine={onKeepMine}
        onKeepTheirs={onKeepTheirs}
      />,
    );

    // F6-R1-5 rapid-tap defense: all actions disable while ANY is in-flight.
    // Since our void-returning mock handlers clear busy on the next microtask,
    // we flush between presses so each tap lands on an idle callout.
    fireEvent.press(getByTestId('conflict-callout-resolve-with-rebel'));
    expect(onResolveWithRebel).toHaveBeenCalledWith(file);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    fireEvent.press(getByTestId('conflict-callout-keep-mine'));
    expect(onKeepMine).toHaveBeenCalledWith(file);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    fireEvent.press(getByTestId('conflict-callout-keep-theirs'));
    expect(onKeepTheirs).toHaveBeenCalledWith(file);
  });

  it('falls back to legacy "Conflict" badge when conflict handlers are NOT supplied', () => {
    const file = mockStagedFile({ hasConflict: true });

    const { queryByTestId, getByText } = render(
      <StagedFileCard
        file={file}
        onPublish={jest.fn()}
        onDiscard={jest.fn()}
        onKeepPrivate={jest.fn()}
      />,
    );

    expect(queryByTestId('conflict-callout')).toBeNull();
    expect(getByText('Conflict')).toBeTruthy();
  });

  it('does NOT render conflict callout when hasConflict is false, even with handlers', () => {
    const file = mockStagedFile({ hasConflict: false });

    const { queryByTestId } = render(
      <StagedFileCard
        file={file}
        onPublish={jest.fn()}
        onDiscard={jest.fn()}
        onKeepPrivate={jest.fn()}
        onResolveWithRebel={jest.fn()}
        onKeepMine={jest.fn()}
        onKeepTheirs={jest.fn()}
      />,
    );

    expect(queryByTestId('conflict-callout')).toBeNull();
  });

  it('propagates isOnline=false through to the callout', () => {
    const file = mockStagedFile({ hasConflict: true });

    const { getByTestId } = render(
      <StagedFileCard
        file={file}
        onPublish={jest.fn()}
        onDiscard={jest.fn()}
        onKeepPrivate={jest.fn()}
        onResolveWithRebel={jest.fn()}
        onKeepMine={jest.fn()}
        onKeepTheirs={jest.fn()}
        isOnline={false}
      />,
    );

    expect(getByTestId('conflict-callout-offline')).toBeTruthy();
  });
});
