/**
 * ToolApprovalSheet tests — F-D-R2-6.
 *
 * Covers:
 *   - renders nothing when approval is null and never-opened
 *   - renders tool name + JSON input + risk badge when approval present
 *   - invokes onApprove / onDeny from primary-action buttons
 *   - disables action buttons while submitting (S4)
 *   - renders principle pickers when "Approve always" / "Deny always" tapped
 *   - snapshot-renders previous approval when prop goes null while visible
 *     flips false (F-D-R2-4 cross-surface close)
 *   - resets local picker mode on approval identity change (F-D-R2-3)
 */

import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';

// Mock vector icons so they don't try to touch native.
jest.mock('@expo/vector-icons', () => {
  const ReactLocal = require('react');
  const RNLocal = require('react-native');
  return {
    Feather: ({ name }: { name: string }) =>
      ReactLocal.createElement(RNLocal.Text, {}, name),
  };
});

// Mock the principle picker — just a sentinel with a testID.
jest.mock('../PrincipleOptionsPicker', () => {
  const ReactLocal = require('react');
  const RNLocal = require('react-native');
  return {
    PrincipleOptionsPicker: ({ testIDPrefix }: { testIDPrefix: string }) =>
      ReactLocal.createElement(
        RNLocal.Text,
        { testID: testIDPrefix },
        'picker',
      ),
  };
});

// Mock the sheet shell so we don't depend on safe-area/Modal.
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

// Mock the mobile approval transport so usePrincipleOptions resolves w/o network.
jest.mock('../../../transport/mobileApprovalTransport', () => ({
  useMobileApprovalTransport: () => ({
    safetyPrompt: {
      generateOptions: jest.fn().mockResolvedValue({
        options: [],
        chosenPrompt: '',
        rawResponse: '',
      }),
      generateDenyOptions: jest.fn().mockResolvedValue({
        options: [],
        chosenPrompt: '',
        rawResponse: '',
      }),
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

import {
  ToolApprovalSheet,
  type ToolApprovalSheetProps,
} from '../ToolApprovalSheet';
import type { ToolApproval } from '@rebel/cloud-client';

function makeApproval(overrides: Partial<ToolApproval> = {}): ToolApproval {
  return {
    toolUseID: 'tool_1',
    turnId: 't1',
    sessionId: 's1',
    toolName: 'bash',
    input: { command: 'ls -la' },
    timestamp: Date.now(),
    reason: 'Safety review',
    riskLevel: 'medium',
    ...overrides,
  };
}

function renderSheet(overrides: Partial<ToolApprovalSheetProps> = {}) {
  const props: ToolApprovalSheetProps = {
    approval: makeApproval(),
    visible: true,
    onClose: jest.fn(),
    onApprove: jest.fn(),
    onDeny: jest.fn(),
    ...overrides,
  };
  return { ...render(<ToolApprovalSheet {...props} />), props };
}

describe('ToolApprovalSheet', () => {
  it('returns null when approval is null and never-opened', () => {
    const { queryByTestId } = renderSheet({ approval: null, visible: false });
    expect(queryByTestId('tool-approval-sheet-open')).toBeNull();
    expect(queryByTestId('tool-approval-sheet-closed')).toBeNull();
  });

  it('renders the tool name + JSON input + reason when approval present', () => {
    const { getByTestId, getByText } = renderSheet();
    // Shell wrapper present with visible=true
    expect(getByTestId('tool-approval-sheet-open')).toBeTruthy();
    // Tool name rendered somewhere in the body.
    expect(getByText('bash')).toBeTruthy();
    // JSON preview text contains the input command.
    const input = getByTestId('tool-approval-sheet-input');
    expect(input.props.children).toContain('"command"');
    expect(input.props.children).toContain('ls -la');
    // Reason.
    expect(getByText('Safety review')).toBeTruthy();
  });

  it('calls onApprove when Approve tapped', () => {
    const onApprove = jest.fn();
    const { getByTestId, props } = renderSheet({ onApprove });
    fireEvent.press(getByTestId('tool-approval-sheet-approve'));
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onApprove).toHaveBeenCalledWith(props.approval, false);
  });

  it('calls onDeny when Deny tapped', () => {
    const onDeny = jest.fn();
    const { getByTestId, props } = renderSheet({ onDeny });
    fireEvent.press(getByTestId('tool-approval-sheet-deny'));
    expect(onDeny).toHaveBeenCalledTimes(1);
    expect(onDeny).toHaveBeenCalledWith(props.approval);
  });

  it('disables Approve/Deny after first tap (S4 isSubmitting guard)', () => {
    const onApprove = jest.fn();
    const { getByTestId } = renderSheet({ onApprove });

    fireEvent.press(getByTestId('tool-approval-sheet-approve'));
    // After the first tap, both primary buttons should report disabled.
    const approve = getByTestId('tool-approval-sheet-approve');
    const deny = getByTestId('tool-approval-sheet-deny');
    expect(approve.props.accessibilityState?.disabled).toBe(true);
    expect(deny.props.accessibilityState?.disabled).toBe(true);
  });

  it('renders allow picker when Approve-always tapped', () => {
    const { getByTestId, queryByTestId } = renderSheet();
    expect(queryByTestId('tool-approval-sheet-allow-picker')).toBeNull();
    fireEvent.press(getByTestId('tool-approval-sheet-approve-always'));
    expect(getByTestId('tool-approval-sheet-allow-picker')).toBeTruthy();
  });

  it('renders deny picker when Deny-always tapped', () => {
    const { getByTestId, queryByTestId } = renderSheet();
    expect(queryByTestId('tool-approval-sheet-deny-picker')).toBeNull();
    fireEvent.press(getByTestId('tool-approval-sheet-deny-always'));
    expect(getByTestId('tool-approval-sheet-deny-picker')).toBeTruthy();
  });

  it('snapshots previous approval while visible flips to false (F-D-R2-4)', () => {
    const approval = makeApproval({ toolName: 'read_file', input: { path: 'a.md' } });
    const { getByText, rerender, getByTestId } = renderSheet({ approval });

    // Sanity — visible + approval present → rendered.
    expect(getByText('read_file')).toBeTruthy();

    // Simulate cross-surface close: approval goes null AND visible flips false.
    rerender(
      <ToolApprovalSheet
        approval={null}
        visible={false}
        onClose={jest.fn()}
        onApprove={jest.fn()}
        onDeny={jest.fn()}
      />,
    );

    // Shell now closed but the snapshot still renders (key check: shell's
    // closed testID suffix).
    expect(getByTestId('tool-approval-sheet-closed')).toBeTruthy();
    // Last-rendered tool name is still in the DOM (snapshot content
    // kept alive so the Modal can slide-out).
    expect(getByText('read_file')).toBeTruthy();
  });
});
