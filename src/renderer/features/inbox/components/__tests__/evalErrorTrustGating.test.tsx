// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  deriveUnifiedApprovals,
  type StagedToolCallInput,
} from '@rebel/shared';
import { flushAsync } from '@renderer/test-utils';
import {
  mergeStagedToolCallBroadcast,
  type PendingApprovalItem,
} from '../../hooks/usePendingApprovals';
import { DrawerApprovalCard } from '../DrawerApprovalCard';

const { usePrincipleOptionsMock } = vi.hoisted(() => ({
  usePrincipleOptionsMock: vi.fn(),
}));

 
vi.mock('@rebel/cloud-client', () => ({
  buildMemoryBlockedAction: vi.fn(() => ({ toolName: 'memory_write', toolInput: {}, blockReason: 'blocked' })),
  usePrincipleOptions: usePrincipleOptionsMock,
}));

 
vi.mock('@renderer/transport/useDesktopApprovalTransport', () => ({
  useDesktopApprovalTransport: () => ({}),
}));

 
vi.mock('../BrowserToolApprovalDetails', () => ({
  BrowserToolApprovalDetails: () => null,
}));

 
vi.mock('@renderer/components/ui', async () => {
  const ReactModule = await vi.importActual<typeof import('react')>('react');
  return {
    Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
      <button {...props}>{children}</button>
    ),
    Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    Badge: ({ children, ...props }: React.HTMLAttributes<HTMLSpanElement>) => (
      <span {...props}>{children}</span>
    ),
    FileLocationBadge: () => null,
    Textarea: ReactModule.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
      function MockTextarea(props, ref) {
        return <textarea ref={ref} {...props} />;
      },
    ),
  };
});

const DRAWER_EVAL_ERROR_TEXT = 'The safety check did not finish, so nothing has run.';

function buildStagedToolApproval(): PendingApprovalItem {
  return {
    id: 'staged-tool:eval-error',
    type: 'staged-tool',
    title: 'Session A',
    description: 'Rebel paused before running Send email',
    timestamp: Date.UTC(2026, 4, 6),
    sessionId: 'session-a',
    riskLevel: 'high',
    stagedToolCall: {
      id: 'eval-error',
      displayName: 'Send email',
      mcpPayload: {
        packageId: 'gmail',
        toolId: 'send',
        args: {},
      },
      riskLevel: 'high',
      reason: 'Safety check paused',
      allowPermanentTrust: false,
      blockedBy: 'eval_error',
    },
  };
}

async function renderDrawerApproval(approval: PendingApprovalItem): Promise<() => void> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<DrawerApprovalCard approval={approval} />);
  });
  await flushAsync();
  return () => {
    act(() => root.unmount());
    container.remove();
  };
}

function buildStagedCallInput(overrides: Partial<StagedToolCallInput> = {}): StagedToolCallInput {
  return {
    id: 'eval-error',
    sessionId: 'session-a',
    turnId: 'turn-a',
    timestamp: 100,
    expiresAt: 1_000,
    status: 'pending',
    mcpPayload: {
      packageId: 'gmail',
      toolId: 'send',
      args: {},
    },
    displayName: 'Send email',
    toolCategory: 'side-effect',
    riskLevel: 'high',
    reason: 'Safety check paused',
    allowPermanentTrust: false,
    blockedBy: 'eval_error',
    ...overrides,
  };
}

type RenderSurfaceId =
  | 'drawer-approval-card'
  | 'desktop-live-event-flow'
  | 'unified-approval-mapper';

interface TestCase {
  assert: () => Promise<void> | void;
}

const SURFACE_TESTS: Record<RenderSurfaceId, TestCase> = {
  'drawer-approval-card': {
    async assert() {
      const cleanup = await renderDrawerApproval(buildStagedToolApproval());

      expect(document.body.textContent).toContain(DRAWER_EVAL_ERROR_TEXT);
      expect(document.body.textContent).toContain('Do it once');
      expect(document.body.textContent).not.toContain('Approve always');
      expect(document.body.textContent).not.toContain('Allow for session');
      expect(document.body.textContent).not.toContain('Save a rule for next time');
      expect(document.body.textContent).not.toContain('Allow and remember');

      cleanup();
    },
  },
  'desktop-live-event-flow': {
    assert() {
      const merged = mergeStagedToolCallBroadcast([], {
        id: 'eval-error',
        sessionId: 'session-a',
        displayName: 'Send email',
        packageId: 'gmail',
        toolId: 'send',
        riskLevel: 'high',
        reason: 'Safety check paused',
        timestamp: 100,
        allowPermanentTrust: false,
        blockedBy: 'eval_error',
      });

      expect(merged[0].blockedBy).toBe('eval_error');
      expect(merged[0].allowPermanentTrust).toBe(false);
    },
  },
  'unified-approval-mapper': {
    assert() {
      const items = deriveUnifiedApprovals({
        toolApprovals: [],
        memoryApprovals: [],
        stagedCalls: [buildStagedCallInput()],
        stagedFiles: [],
        sessionContext: new Map(),
      });

      expect(items).toHaveLength(1);
      expect(items[0].stagedToolCall?.blockedBy).toBe('eval_error');
      expect(items[0].stagedToolCall?.allowPermanentTrust).toBe(false);
    },
  },
};

describe('eval_error trust gating parity — desktop and shared mapper surfaces', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
    usePrincipleOptionsMock.mockReset();
  });

  it.each(Object.entries(SURFACE_TESTS))('%s honors eval_error trust gating', async (_surfaceId, testCase) => {
    usePrincipleOptionsMock.mockReturnValue({
      generationState: 'idle',
      generationError: null,
      startGeneration: vi.fn(),
      options: [],
      selectedOption: null,
      selectOption: vi.fn(),
      otherText: '',
      setOtherText: vi.fn(),
      applyState: 'idle',
      applyError: null,
      goBack: vi.fn(),
      retryGeneration: vi.fn(),
      retryApply: vi.fn(),
      confirmSelection: vi.fn(),
      confirmTrustedTool: vi.fn(),
      cancelTrustedTool: vi.fn(),
      resolveOnce: vi.fn(),
    });

    await testCase.assert();
  });
});
