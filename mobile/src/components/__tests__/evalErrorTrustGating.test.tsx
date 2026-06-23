import React from 'react';
import { render } from '@testing-library/react-native';
import type {
  CloudStagedToolCall,
  ToolApproval,
} from '@rebel/cloud-client';
import { ToolApprovalCard, StagedCallCard } from '../ApprovalCards';
import { stagedCallToToolApproval } from '../approval/ApprovalSheetHost';
import { ToolApprovalSheet } from '../approval/ToolApprovalSheet';

jest.mock('@expo/vector-icons', () => {
  const ReactLocal = require('react');
  const RNLocal = require('react-native');
  return {
    Feather: ({ name }: { name: string }) =>
      ReactLocal.createElement(RNLocal.Text, {}, name),
  };
});

jest.mock('../approval/PrincipleOptionsPicker', () => {
  const ReactLocal = require('react');
  const RNLocal = require('react-native');
  return {
    PrincipleOptionsPicker: ({ testIDPrefix }: { testIDPrefix: string }) =>
      ReactLocal.createElement(RNLocal.Text, { testID: testIDPrefix }, 'picker'),
  };
});

jest.mock('../approval/ApprovalSheetShell', () => {
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

jest.mock('../../transport/mobileApprovalTransport', () => ({
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

const EVAL_ERROR_TEXT = 'The safety check did not finish, so nothing has run. It will not keep trying in the background.';

function buildToolApproval(overrides: Partial<ToolApproval> = {}): ToolApproval {
  return {
    toolUseID: 'tool-1',
    turnId: 'turn-1',
    sessionId: 'session-a',
    toolName: 'Send email',
    input: { to: 'a@example.com' },
    reason: 'Safety check paused',
    timestamp: 100,
    riskLevel: 'high',
    blockedBy: 'eval_error',
    allowPermanentTrust: false,
    ...overrides,
  };
}

function buildStagedCall(overrides: Partial<CloudStagedToolCall> = {}): CloudStagedToolCall {
  return {
    id: 'staged-1',
    sessionId: 'session-a',
    turnId: 'turn-1',
    timestamp: 100,
    status: 'pending',
    displayName: 'Send email',
    toolCategory: 'side-effect',
    riskLevel: 'high',
    reason: 'Safety check paused',
    mcpPayload: { packageId: 'gmail', toolId: 'send', args: { to: 'a@example.com' } },
    blockedBy: 'eval_error',
    allowPermanentTrust: false,
    ...overrides,
  };
}

type RenderSurfaceId =
  | 'tool-approval-sheet'
  | 'approval-cards-tool-inline'
  | 'approval-cards-staged-inline';

interface TestCase {
  renderSurface: () => ReturnType<typeof render>;
}

const SURFACE_TESTS: Record<RenderSurfaceId, TestCase> = {
  'tool-approval-sheet': {
    renderSurface: () => render(
      <ToolApprovalSheet
        approval={buildToolApproval()}
        visible
        onClose={jest.fn()}
        onApprove={jest.fn()}
        onDeny={jest.fn()}
      />,
    ),
  },
  'approval-cards-tool-inline': {
    renderSurface: () => render(
      <ToolApprovalCard
        approval={buildToolApproval()}
        onApprove={jest.fn()}
        onDeny={jest.fn()}
      />,
    ),
  },
  'approval-cards-staged-inline': {
    renderSurface: () => render(
      <StagedCallCard
        call={buildStagedCall()}
        onExecute={jest.fn()}
        onReject={jest.fn()}
      />,
    ),
  },
};

describe('eval_error trust gating parity — mobile approval surfaces', () => {
  it.each(Object.entries(SURFACE_TESTS))('%s honors eval_error trust gating', (_surfaceId, testCase) => {
    const screen = testCase.renderSurface();

    expect(screen.getByText(EVAL_ERROR_TEXT)).toBeTruthy();
    expect(screen.queryByText('Approve always')).toBeNull();
    expect(screen.queryByText('Deny always')).toBeNull();
    expect(screen.queryByText('Allow for session')).toBeNull();
    expect(screen.getByText('Cancel this')).toBeTruthy();
    expect(screen.getByText('Do it once')).toBeTruthy();
  });

  it('preserves eval_error trust metadata when adapting staged calls for the sheet', () => {
    expect(stagedCallToToolApproval(buildStagedCall())).toMatchObject({
      blockedBy: 'eval_error',
      allowPermanentTrust: false,
    });
  });
});
