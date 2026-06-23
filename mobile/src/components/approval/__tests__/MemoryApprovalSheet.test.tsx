/**
 * MemoryApprovalSheet tests — F-D-R2-6.
 *
 * Covers:
 *   - returns null before any data has been seen
 *   - renders path + timestamp + summary + content block
 *   - shows error block + retry when content fetch fails (S5)
 *   - calls onSave / onSkip from the primary actions
 *   - disables primary actions after first tap (S4)
 *   - renders Save-always + Skip-always buttons when blocked
 *   - opens the allow picker when Save-always tapped
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

// Mock useApprovalContent so we can control loading/error/content states.
const mockContent = {
  original: 'old content',
  staged: 'new content',
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
  MemoryApprovalSheet,
  type MemoryApprovalSheetProps,
} from '../MemoryApprovalSheet';
import type { MemoryWriteApproval } from '@rebel/cloud-client';

function makeApproval(
  overrides: Partial<MemoryWriteApproval> = {},
): MemoryWriteApproval {
  return {
    toolUseId: 'mem_1',
    originalTurnId: 't1',
    originalSessionId: 's1',
    spaceName: 'Project',
    spacePath: 'Project/notes.md',
    filePath: 'Project/notes.md',
    summary: 'Add meeting notes',
    contentPreview: 'Meeting notes preview',
    timestamp: Date.now(),
    isNewFile: false,
    blockedBy: 'unknown',
    staged: false,
    sharing: 'private',
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

function renderSheet(overrides: Partial<MemoryApprovalSheetProps> = {}) {
  const props: MemoryApprovalSheetProps = {
    approval: makeApproval(),
    visible: true,
    onClose: jest.fn(),
    onSave: jest.fn(),
    onSkip: jest.fn(),
    ...overrides,
  };
  return { ...render(<MemoryApprovalSheet {...props} />), props };
}

beforeEach(() => {
  mockContent.loading = false;
  mockContent.error = null;
  mockContent.original = 'old content';
  mockContent.staged = 'new content';
  mockContent.refetch.mockClear();
});

describe('MemoryApprovalSheet', () => {
  it('returns null when approval is null and never-opened', () => {
    const { queryByTestId } = renderSheet({ approval: null, visible: false });
    expect(queryByTestId('memory-approval-sheet-open')).toBeNull();
    expect(queryByTestId('memory-approval-sheet-closed')).toBeNull();
  });

  it('renders location badge + summary + proposed content diff', () => {
    const { getByTestId, getByText } = renderSheet();
    expect(getByTestId('memory-approval-sheet-open')).toBeTruthy();
    expect(getByTestId('file-location-badge-label').props.children).toBe('Project / notes.md');
    expect(getByText('Add meeting notes')).toBeTruthy();
    expect(getByTestId('mock-diff-view').props.children).toBe(
      'old content->Meeting notes preview',
    );
  });

  it.each([
    ['in-space', inSpaceLocation()],
    ['outside-workspace', outsideWorkspaceLocation()],
    ['legacy-missing-location', legacyLocation()],
  ] as const)('renders %s FileLocationBadge metadata', (_name, location) => {
    const { getByTestId, getByText, queryByTestId } = renderSheet({
      approval: makeApproval({ location }),
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

  it('shows the error block + retry when content fetch fails (S5)', () => {
    mockContent.loading = false;
    mockContent.error = { kind: 'network', message: 'offline' };
    const { getByTestId } = renderSheet();
    expect(getByTestId('memory-approval-sheet-error')).toBeTruthy();
    fireEvent.press(getByTestId('memory-approval-sheet-error-retry'));
    expect(mockContent.refetch).toHaveBeenCalledTimes(1);
  });

  it('calls onSave when Save is tapped', () => {
    const onSave = jest.fn();
    const { getByTestId, props } = renderSheet({ onSave });
    fireEvent.press(getByTestId('memory-approval-sheet-save'));
    expect(onSave).toHaveBeenCalledWith(props.approval);
  });

  it('calls onSkip when Skip is tapped', () => {
    const onSkip = jest.fn();
    const { getByTestId, props } = renderSheet({ onSkip });
    fireEvent.press(getByTestId('memory-approval-sheet-skip'));
    expect(onSkip).toHaveBeenCalledWith(props.approval);
  });

  it('disables Save/Skip after first tap (S4 isSubmitting guard)', () => {
    const { getByTestId } = renderSheet();
    fireEvent.press(getByTestId('memory-approval-sheet-save'));
    const save = getByTestId('memory-approval-sheet-save');
    const skip = getByTestId('memory-approval-sheet-skip');
    expect(save.props.accessibilityState?.disabled).toBe(true);
    expect(skip.props.accessibilityState?.disabled).toBe(true);
  });

  it('renders Save-always + Skip-always buttons when blocked by safety_prompt', () => {
    const { queryByTestId, getByTestId } = renderSheet({
      approval: makeApproval({ blockedBy: 'safety_prompt' }),
    });
    expect(getByTestId('memory-approval-sheet-save-always')).toBeTruthy();
    expect(getByTestId('memory-approval-sheet-skip-always')).toBeTruthy();
    expect(getByTestId('memory-approval-sheet-blocked')).toBeTruthy();
    // Not in picker mode yet.
    expect(queryByTestId('memory-approval-sheet-allow-picker')).toBeNull();
  });

  it('opens the allow picker when Save-always is tapped (blocked path)', () => {
    const { getByTestId } = renderSheet({
      approval: makeApproval({ blockedBy: 'safety_prompt' }),
    });
    fireEvent.press(getByTestId('memory-approval-sheet-save-always'));
    expect(getByTestId('memory-approval-sheet-allow-picker')).toBeTruthy();
  });
});
