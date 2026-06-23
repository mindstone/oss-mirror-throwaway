/**
 * StagedFileApprovalSheet tests — F-D-R2-6.
 *
 * Covers:
 *   - returns null before any data has been seen
 *   - renders summary + relative-time + diff
 *   - renders ConflictCallout when hasConflict is true
 *   - Save button is disabled while offline or conflicted (defensive)
 *   - Discard / Keep private / Save invoke the right handlers
 *   - S4 isSubmitting disables Save after tap
 *   - S5 retry affordance surfaces on content-fetch error
 *   - F-D-R2-10 safety-prompt-blocked path exposes Save-always + Deny-always
 *   - Save-always opens allow picker
 *   - snapshot-renders previous file while visible flips false (F-D-R2-4)
 */

import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import { describeFileLocation, type FileLocation } from '@rebel/shared';

jest.mock('@expo/vector-icons', () => {
  const ReactLocal = require('react');
  const RNLocal = require('react-native');
  return {
    Feather: ({ name, testID }: { name: string; testID?: string }) =>
      ReactLocal.createElement(RNLocal.Text, { testID }, name),
  };
});

jest.mock('../PrincipleOptionsPicker', () => {
  const ReactLocal = require('react');
  const RNLocal = require('react-native');
  return {
    PrincipleOptionsPicker: ({ testIDPrefix }: { testIDPrefix: string }) =>
      ReactLocal.createElement(RNLocal.Text, { testID: testIDPrefix }, 'picker'),
  };
});

jest.mock('../MobileDiffView', () => {
  const ReactLocal = require('react');
  const RNLocal = require('react-native');
  return {
    MobileDiffView: ({ before, after }: { before: string; after: string }) =>
      ReactLocal.createElement(
        RNLocal.Text,
        { testID: 'mock-diff-view' },
        `${before}->${after}`,
      ),
  };
});

jest.mock('../ConflictCallout', () => {
  const ReactLocal = require('react');
  const RNLocal = require('react-native');
  return {
    ConflictCallout: () =>
      ReactLocal.createElement(
        RNLocal.View,
        { testID: 'mock-conflict-callout' },
      ),
  };
});

jest.mock('../ApprovalSheetShell', () => {
  const ReactLocal = require('react');
  const RNLocal = require('react-native');
  return {
    ApprovalSheetShell: ({
      children,
      testID,
      visible,
    }: {
      children: React.ReactNode;
      testID: string;
      visible: boolean;
    }) =>
      ReactLocal.createElement(
        RNLocal.View,
        { testID: `${testID}-${visible ? 'open' : 'closed'}` },
        children,
      ),
  };
});

jest.mock('../../../transport/mobileApprovalTransport', () => ({
  useMobileApprovalTransport: () => ({
    safetyPrompt: {
      generateOptions: jest.fn().mockResolvedValue({ options: [], chosenPrompt: '', rawResponse: '' }),
      generateDenyOptions: jest.fn().mockResolvedValue({ options: [], chosenPrompt: '', rawResponse: '' }),
      addInstruction: jest.fn().mockResolvedValue({ success: true }),
    },
    toolSafety: {
      addToolAllowRule: jest.fn().mockResolvedValue({ success: true }),
      addToolBlockRule: jest.fn().mockResolvedValue({ success: true }),
      isToolPermanentlyTrusted: jest
        .fn()
        .mockResolvedValue({ trusted: false, scope: null }),
    },
  }),
}));

const mockContent = {
  original: 'base',
  staged: 'updated',
  loading: false,
  error: null as null | { kind: string; message: string },
  isNewFile: false,
  refetch: jest.fn(),
};
jest.mock('@rebel/cloud-client', () => {
  const actual = jest.requireActual('@rebel/cloud-client');
  return {
    ...actual,
    useApprovalContent: () => mockContent,
    usePrincipleOptions: () => ({
      generationState: 'idle',
      options: [],
      generationError: null,
      selectedOption: null,
      otherText: '',
      applyState: 'idle',
      applyError: null,
      appliedUpdate: null,
      selectOption: jest.fn(),
      setOtherText: jest.fn(),
      confirmSelection: jest.fn(),
      confirmTrustedTool: jest.fn(),
      cancelTrustedTool: jest.fn(),
      goBack: jest.fn(),
      retryGeneration: jest.fn(),
      resolveOnce: jest.fn(),
      approveOnce: jest.fn(),
      retryApply: jest.fn(),
      startGeneration: jest.fn(),
      direction: 'allow',
    }),
    ipcCall: jest.fn(),
    readWorkspaceFile: jest.fn(),
  };
});

import {
  StagedFileApprovalSheet,
  type StagedFileApprovalSheetProps,
} from '../StagedFileApprovalSheet';
import type { StagedFile } from '@rebel/cloud-client';

function makeFile(overrides: Partial<StagedFile> = {}): StagedFile {
  return {
    id: 'stg_1',
    realPath: 'Project/notes.md',
    spaceName: 'Project',
    spacePath: 'Project/notes.md',
    sessionId: 's1',
    baseHash: 'h',
    summary: 'Add meeting notes',
    stagedAt: Date.now(),
    sensitivity: 'high',
    hasConflict: false,
    ...overrides,
  };
}

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

function renderSheet(overrides: Partial<StagedFileApprovalSheetProps> = {}) {
  const props: StagedFileApprovalSheetProps = {
    file: makeFile(),
    visible: true,
    onClose: jest.fn(),
    onPublish: jest.fn(),
    onDiscard: jest.fn(),
    onKeepPrivate: jest.fn(),
    onResolveWithRebel: jest.fn(),
    onKeepMine: jest.fn(),
    onKeepTheirs: jest.fn(),
    isOnline: true,
    ...overrides,
  };
  return { ...render(<StagedFileApprovalSheet {...props} />), props };
}

beforeEach(() => {
  mockContent.loading = false;
  mockContent.error = null;
  mockContent.original = 'base';
  mockContent.staged = 'updated';
  mockContent.refetch.mockClear();
});

describe('StagedFileApprovalSheet', () => {
  it('returns null when file is null and never-opened', () => {
    const { queryByTestId } = renderSheet({ file: null, visible: false });
    expect(queryByTestId('staged-file-approval-sheet-open')).toBeNull();
    expect(queryByTestId('staged-file-approval-sheet-closed')).toBeNull();
  });

  it('renders summary + diff view', () => {
    const { getByText, getByTestId } = renderSheet();
    expect(getByText('Add meeting notes')).toBeTruthy();
    expect(getByTestId('mock-diff-view').props.children).toBe('base->updated');
  });

  it.each([
    ['in-space', inSpaceLocation()],
    ['outside-workspace', outsideWorkspaceLocation()],
    ['legacy-missing-location', legacyLocation()],
  ] as const)('renders %s FileLocationBadge metadata', (_name, location) => {
    const { getByTestId, getByText, queryByTestId } = renderSheet({
      file: makeFile({ location }),
    });
    const description = describeFileLocation(location);

    expect(getByTestId('file-location-badge-label').props.children).toBe(description.label);
    fireEvent(getByTestId('file-location-badge'), 'longPress');
    expect(getByTestId('file-location-badge-tooltip')).toBeTruthy();
    expect(getByText(description.tooltip)).toBeTruthy();

    if (location.kind === 'legacy-missing-location') {
      expect(queryByTestId('file-location-badge-warning-icon')).toBeTruthy();
    } else {
      expect(queryByTestId('file-location-badge-warning-icon')).toBeNull();
    }
  });

  it('renders ConflictCallout when hasConflict is true', () => {
    const { getByTestId, queryByTestId } = renderSheet({
      file: makeFile({ hasConflict: true }),
    });
    expect(getByTestId('mock-conflict-callout')).toBeTruthy();
    // Save should be disabled (accessibilityState) when conflicted.
    expect(
      queryByTestId('staged-file-approval-sheet-save')?.props.accessibilityState?.disabled,
    ).toBe(true);
  });

  it('disables Save when offline', () => {
    const { getByTestId } = renderSheet({ isOnline: false });
    expect(
      getByTestId('staged-file-approval-sheet-save').props.accessibilityState
        ?.disabled,
    ).toBe(true);
  });

  it('calls onPublish when Save tapped', () => {
    const onPublish = jest.fn();
    const { getByTestId, props } = renderSheet({ onPublish });
    fireEvent.press(getByTestId('staged-file-approval-sheet-save'));
    expect(onPublish).toHaveBeenCalledWith(props.file);
  });

  it('calls onDiscard when Discard tapped', () => {
    const onDiscard = jest.fn();
    const { getByTestId, props } = renderSheet({ onDiscard });
    fireEvent.press(getByTestId('staged-file-approval-sheet-discard'));
    expect(onDiscard).toHaveBeenCalledWith(props.file);
  });

  it('calls onKeepPrivate when Keep-private tapped', () => {
    const onKeepPrivate = jest.fn();
    const { getByTestId, props } = renderSheet({ onKeepPrivate });
    fireEvent.press(getByTestId('staged-file-approval-sheet-keep-private'));
    expect(onKeepPrivate).toHaveBeenCalledWith(props.file);
  });

  it('disables Save after first tap (S4 isSubmitting)', () => {
    const { getByTestId } = renderSheet();
    fireEvent.press(getByTestId('staged-file-approval-sheet-save'));
    expect(
      getByTestId('staged-file-approval-sheet-save').props.accessibilityState
        ?.disabled,
    ).toBe(true);
  });

  it('shows error block + retry on content-fetch failure (S5)', () => {
    mockContent.error = { kind: 'network', message: 'offline' };
    const { getByTestId } = renderSheet();
    expect(getByTestId('staged-file-approval-sheet-error')).toBeTruthy();
    fireEvent.press(getByTestId('staged-file-approval-sheet-error-retry'));
    expect(mockContent.refetch).toHaveBeenCalledTimes(1);
  });

  it('exposes Save-always + Deny-always buttons when blocked by safety_prompt (F-D-R2-10)', () => {
    const { getByTestId } = renderSheet({
      file: makeFile({ blockedBy: 'safety_prompt' }),
    });
    expect(getByTestId('staged-file-approval-sheet-save-always')).toBeTruthy();
    expect(getByTestId('staged-file-approval-sheet-deny-always')).toBeTruthy();
  });

  it('opens allow picker when Save-always is tapped (blocked path)', () => {
    const { getByTestId } = renderSheet({
      file: makeFile({ blockedBy: 'safety_prompt' }),
    });
    fireEvent.press(getByTestId('staged-file-approval-sheet-save-always'));
    expect(getByTestId('staged-file-approval-sheet-allow-picker')).toBeTruthy();
  });
});
