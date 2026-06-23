/**
 * approvalStore tests — fetchPending, respondToApproval, staged calls, event handling.
 */

import { __approvalStoreTestUtils, useApprovalStore } from '../stores/approvalStore';
import type { ToolApproval, MemoryWriteApproval, CloudStagedToolCall } from '../types';
import { setLogEnabled } from '../utils/logger';

vi.mock('../cloudClient', async () => {
  const actual = await vi.importActual<typeof import('../cloudClient')>('../cloudClient');
  return {
    ...actual,
    ipcCall: vi.fn(),
  };
});

import * as cloudClient from '../cloudClient';
const mockedIpcCall = vi.mocked(cloudClient.ipcCall);
let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

function mockApproval(overrides: Partial<ToolApproval> = {}): ToolApproval {
  return {
    toolUseID: `tool-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    turnId: 'turn-1',
    sessionId: 'session-1',
    toolName: 'read_file',
    input: { path: '/test.txt' },
    reason: 'File access',
    timestamp: Date.now(),
    ...overrides,
  };
}

function mockStagedCall(overrides: Partial<CloudStagedToolCall> = {}): CloudStagedToolCall {
  return {
    id: `staged-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    sessionId: 'session-1',
    turnId: 'turn-1',
    timestamp: Date.now(),
    status: 'pending',
    displayName: 'Read File',
    toolCategory: 'filesystem',
    riskLevel: 'medium',
    reason: 'Needs file access',
    mcpPayload: { packageId: 'pkg-1', toolId: 'read_file', args: { path: '/test.txt' } },
    ...overrides,
  };
}

function mockMemoryApproval(overrides: Partial<MemoryWriteApproval> = {}): MemoryWriteApproval {
  return {
    toolUseId: `memory-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    originalTurnId: 'turn-1',
    originalSessionId: 'session-1',
    spaceName: 'Memory',
    spacePath: 'Memory',
    filePath: 'Memory/test.md',
    summary: 'Save memory',
    contentPreview: 'Draft memory content',
    sharing: 'private',
    isNewFile: false,
    blockedBy: 'safety_prompt',
    timestamp: Date.now(),
    ...overrides,
  };
}

beforeEach(() => {
  setLogEnabled(true);
  useApprovalStore.setState({
    toolApprovals: [],
    stagedCalls: [],
    memoryApprovals: [],
    isLoading: false,
    error: null,
  });
  mockedIpcCall.mockReset();
  __approvalStoreTestUtils.resetInvalidLocationWarnings();
  consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  consoleWarnSpy.mockRestore();
});

describe('approvalStore', () => {
  describe('fetchPending', () => {
    it('loads approvals and staged calls successfully', async () => {
      const approvals = [mockApproval({ toolUseID: 'a1' })];
      const staged = [mockStagedCall({ id: 's1', status: 'pending' })];
      const memory = [
        {
          toolUseId: 'm1',
          originalTurnId: 'turn-2',
          originalSessionId: 'session-1',
          destination: {
            path: 'Memory/plan.md',
            spaceName: 'Memory',
            spacePath: 'Memory',
            isNew: true,
          },
          summary: 'Save planning notes',
          blockedBy: 'safety_prompt',
          timestamp: Date.now(),
        },
      ];

      mockedIpcCall
        .mockResolvedValueOnce(approvals)
        .mockResolvedValueOnce(staged)
        .mockResolvedValueOnce(memory);

      await useApprovalStore.getState().fetchPending();

      const state = useApprovalStore.getState();
      expect(state.toolApprovals).toHaveLength(1);
      expect(state.toolApprovals[0].toolUseID).toBe('a1');
      expect(state.stagedCalls).toHaveLength(1);
      expect(state.stagedCalls[0].id).toBe('s1');
      expect(state.memoryApprovals).toHaveLength(1);
      expect(state.memoryApprovals[0].toolUseId).toBe('m1');
      expect(state.isLoading).toBe(false);
      expect(state.error).toBeNull();
    });

    it('normalizes memory approval location from payload when present', async () => {
      mockedIpcCall
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            toolUseId: 'm-location',
            originalTurnId: 'turn-2',
            originalSessionId: 'session-1',
            filePath: '/legacy/memory.md',
            spaceName: 'Memory',
            summary: 'Save planning notes',
            location: {
              kind: 'in-space',
              spaceName: 'General',
              spaceWorkspacePath: 'General',
              spaceRelativePath: 'skills/demo/SKILL.md',
              workspaceRelativePath: 'General/skills/demo/SKILL.md',
              fileName: 'SKILL.md',
            },
            blockedBy: 'safety_prompt',
            timestamp: Date.now(),
          },
        ])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            toolUseId: 'm-invalid-location',
            originalTurnId: 'turn-2',
            originalSessionId: 'session-1',
            filePath: '/tmp/rebel/report.md',
            spaceName: 'Outside workspace',
            summary: 'Save planning notes',
            location: {
              kind: 'in-space',
              spaceName: '',
            },
            blockedBy: 'safety_prompt',
            timestamp: Date.now(),
          },
        ]);

      await useApprovalStore.getState().fetchPending();

      expect(useApprovalStore.getState().memoryApprovals[0]?.location).toMatchObject({
        kind: 'in-space',
        workspaceRelativePath: 'General/skills/demo/SKILL.md',
      });
      expect(useApprovalStore.getState().memoryApprovals[0]?.spacePath).toBe('General/skills/demo/SKILL.md');
    });

    it('falls back to legacyMissingLocation when payload location is absent', async () => {
      mockedIpcCall
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            toolUseId: 'm-legacy',
            originalTurnId: 'turn-2',
            originalSessionId: 'session-1',
            filePath: '/tmp/rebel/report.md',
            spaceName: 'Outside workspace',
            summary: 'Save planning notes',
            blockedBy: 'safety_prompt',
            timestamp: Date.now(),
          },
        ]);

      await useApprovalStore.getState().fetchPending();

      expect(useApprovalStore.getState().memoryApprovals[0]?.location).toMatchObject({
        kind: 'legacy-missing-location',
        fileName: 'report.md',
      });
    });

    it('warns once and falls back when payload location is invalid', async () => {
      const payload = {
        toolUseId: 'm-invalid-location',
        originalTurnId: 'turn-2',
        originalSessionId: 'session-1',
        filePath: '/tmp/rebel/report.md',
        spaceName: 'Outside workspace',
        summary: 'Save planning notes',
        location: {
          kind: 'in-space',
          spaceName: '',
        },
        blockedBy: 'safety_prompt',
        timestamp: Date.now(),
      };

      const first = __approvalStoreTestUtils.toMemoryApproval(payload);
      const second = __approvalStoreTestUtils.toMemoryApproval(payload);

      expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
      expect(String(consoleWarnSpy.mock.calls[0]?.[0])).toContain('[WARN] [approvalStore]');
      expect(String(consoleWarnSpy.mock.calls[0]?.[0])).toContain('approvalStore received invalid location; falling back to legacy shim');
      expect(String(consoleWarnSpy.mock.calls[0]?.[0])).toContain('"toolUseId":"m-invalid-location"');
      expect(String(consoleWarnSpy.mock.calls[0]?.[0])).toContain('"reason":"invalid-location"');
      expect(first?.location).toMatchObject({
        kind: 'legacy-missing-location',
        fileName: 'report.md',
      });
      expect(second?.location).toMatchObject({
        kind: 'legacy-missing-location',
        fileName: 'report.md',
      });
    });

    it('filters out non-pending staged calls', async () => {
      const staged = [
        mockStagedCall({ id: 's1', status: 'pending' }),
        mockStagedCall({ id: 's2', status: 'executed' }),
        mockStagedCall({ id: 's3', status: 'rejected' }),
      ];

      mockedIpcCall
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce(staged)
        .mockResolvedValueOnce([]);

      await useApprovalStore.getState().fetchPending();

      expect(useApprovalStore.getState().stagedCalls).toHaveLength(1);
      expect(useApprovalStore.getState().stagedCalls[0].id).toBe('s1');
    });

    it('sets error when all calls fail', async () => {
      mockedIpcCall
        .mockRejectedValueOnce(new Error('Network error'))
        .mockRejectedValueOnce(new Error('Network error'))
        .mockRejectedValueOnce(new Error('Network error'));

      await useApprovalStore.getState().fetchPending();

      const state = useApprovalStore.getState();
      expect(state.toolApprovals).toEqual([]);
      expect(state.stagedCalls).toEqual([]);
      expect(state.memoryApprovals).toEqual([]);
      expect(state.isLoading).toBe(false);
      expect(state.error).toBe('Failed to load approvals');
    });

    it('keeps partial data when only one call fails', async () => {
      const approvals = [mockApproval({ toolUseID: 'a1' })];

      mockedIpcCall
        .mockResolvedValueOnce(approvals)
        .mockRejectedValueOnce(new Error('Staged calls unavailable'))
        .mockResolvedValueOnce([]);

      await useApprovalStore.getState().fetchPending();

      const state = useApprovalStore.getState();
      expect(state.toolApprovals).toHaveLength(1);
      expect(state.toolApprovals[0].toolUseID).toBe('a1');
      expect(state.stagedCalls).toEqual([]);
      expect(state.memoryApprovals).toEqual([]);
      expect(state.isLoading).toBe(false);
      expect(state.error).toBeNull();
    });

    it('sets isLoading during fetch', async () => {
      let resolvePromise: (v: unknown) => void;
      const pending = new Promise((r) => { resolvePromise = r; });
      mockedIpcCall.mockReturnValue(pending as Promise<unknown>);

      const fetchPromise = useApprovalStore.getState().fetchPending();
      expect(useApprovalStore.getState().isLoading).toBe(true);

      resolvePromise!([]);
      await fetchPromise;
      expect(useApprovalStore.getState().isLoading).toBe(false);
    });
  });

  describe('respondToApproval', () => {
    it('approves and removes from list', async () => {
      const approval = mockApproval({ toolUseID: 'a1' });
      useApprovalStore.setState({ toolApprovals: [approval] });
      mockedIpcCall.mockResolvedValueOnce(undefined);

      await useApprovalStore.getState().respondToApproval('a1', true);

      expect(mockedIpcCall).toHaveBeenCalledWith('agent:tool-safety-response', {
        toolUseID: 'a1',
        approved: true,
        allowForSession: false,
        input: {},
      });
      expect(useApprovalStore.getState().toolApprovals).toHaveLength(0);
    });

    it('denies and removes from list', async () => {
      const approval = mockApproval({ toolUseID: 'a1' });
      useApprovalStore.setState({ toolApprovals: [approval] });
      mockedIpcCall.mockResolvedValueOnce(undefined);

      await useApprovalStore.getState().respondToApproval('a1', false);

      expect(mockedIpcCall).toHaveBeenCalledWith('agent:tool-safety-response', {
        toolUseID: 'a1',
        approved: false,
        allowForSession: false,
        input: {},
      });
      expect(useApprovalStore.getState().toolApprovals).toHaveLength(0);
    });

    it('passes allowForSession when true', async () => {
      useApprovalStore.setState({ toolApprovals: [mockApproval({ toolUseID: 'a1' })] });
      mockedIpcCall.mockResolvedValueOnce(undefined);

      await useApprovalStore.getState().respondToApproval('a1', true, true);

      expect(mockedIpcCall).toHaveBeenCalledWith('agent:tool-safety-response', {
        toolUseID: 'a1',
        approved: true,
        allowForSession: true,
        input: {},
      });
    });

    it('sets error on failure', async () => {
      useApprovalStore.setState({ toolApprovals: [mockApproval({ toolUseID: 'a1' })] });
      mockedIpcCall.mockRejectedValueOnce(new Error('Network error'));

      await expect(useApprovalStore.getState().respondToApproval('a1', true)).rejects.toThrow('Network error');

      expect(useApprovalStore.getState().error).toBe('Network error');
    });
  });

  describe('executeStagedCall', () => {
    it('executes and removes from list', async () => {
      const staged = mockStagedCall({ id: 's1' });
      useApprovalStore.setState({ stagedCalls: [staged] });
      mockedIpcCall.mockResolvedValueOnce(undefined);

      await useApprovalStore.getState().executeStagedCall('s1');

      expect(mockedIpcCall).toHaveBeenCalledWith('tool-safety:staged-execute', { id: 's1' });
      expect(useApprovalStore.getState().stagedCalls).toHaveLength(0);
    });

    it('sets error on failure', async () => {
      useApprovalStore.setState({ stagedCalls: [mockStagedCall({ id: 's1' })] });
      mockedIpcCall.mockRejectedValueOnce(new Error('Failed'));

      await expect(useApprovalStore.getState().executeStagedCall('s1')).rejects.toThrow('Failed');

      expect(useApprovalStore.getState().error).toBe('Failed');
    });
  });

  describe('rejectStagedCall', () => {
    it('rejects and removes from list', async () => {
      const staged = mockStagedCall({ id: 's1' });
      useApprovalStore.setState({ stagedCalls: [staged] });
      mockedIpcCall.mockResolvedValueOnce(undefined);

      await useApprovalStore.getState().rejectStagedCall('s1');

      expect(mockedIpcCall).toHaveBeenCalledWith('tool-safety:staged-reject', { id: 's1' });
      expect(useApprovalStore.getState().stagedCalls).toHaveLength(0);
    });

    it('sets error on failure', async () => {
      useApprovalStore.setState({ stagedCalls: [mockStagedCall({ id: 's1' })] });
      mockedIpcCall.mockRejectedValueOnce(new Error('Failed'));

      await expect(useApprovalStore.getState().rejectStagedCall('s1')).rejects.toThrow('Failed');

      expect(useApprovalStore.getState().error).toBe('Failed');
    });
  });

  describe('handleApprovalEvent', () => {
    it('adds new approval on approval-request', () => {
      const approval = mockApproval({ toolUseID: 'a1' });

      useApprovalStore.getState().handleApprovalEvent('tool-safety:approval-request', [approval]);

      expect(useApprovalStore.getState().toolApprovals).toHaveLength(1);
      expect(useApprovalStore.getState().toolApprovals[0].toolUseID).toBe('a1');
    });

    it('deduplicates approval on approval-request', () => {
      const approval = mockApproval({ toolUseID: 'a1', reason: 'old' });
      useApprovalStore.setState({ toolApprovals: [approval] });

      const updated = mockApproval({ toolUseID: 'a1', reason: 'new' });
      useApprovalStore.getState().handleApprovalEvent('tool-safety:approval-request', [updated]);

      const approvals = useApprovalStore.getState().toolApprovals;
      expect(approvals).toHaveLength(1);
      expect(approvals[0].reason).toBe('new');
    });

    it('removes approval on approval-resolved', () => {
      useApprovalStore.setState({
        toolApprovals: [mockApproval({ toolUseID: 'a1' }), mockApproval({ toolUseID: 'a2' })],
      });

      useApprovalStore.getState().handleApprovalEvent('tool-safety:approval-resolved', [{ toolUseID: 'a1' }]);

      const approvals = useApprovalStore.getState().toolApprovals;
      expect(approvals).toHaveLength(1);
      expect(approvals[0].toolUseID).toBe('a2');
    });

    it('adds pending staged call on staged-call', () => {
      const call = mockStagedCall({ id: 's1', status: 'pending' });

      useApprovalStore.getState().handleApprovalEvent('tool-safety:staged-call', [call]);

      expect(useApprovalStore.getState().stagedCalls).toHaveLength(1);
      expect(useApprovalStore.getState().stagedCalls[0].id).toBe('s1');
    });

    it('ignores non-pending staged call on staged-call', () => {
      const call = mockStagedCall({ id: 's1', status: 'executed' });

      useApprovalStore.getState().handleApprovalEvent('tool-safety:staged-call', [call]);

      expect(useApprovalStore.getState().stagedCalls).toHaveLength(0);
    });

    it('removes staged call on staged-call-updated when not pending', () => {
      useApprovalStore.setState({ stagedCalls: [mockStagedCall({ id: 's1', status: 'pending' })] });

      const updated = mockStagedCall({ id: 's1', status: 'executed' });
      useApprovalStore.getState().handleApprovalEvent('tool-safety:staged-call-updated', [updated]);

      expect(useApprovalStore.getState().stagedCalls).toHaveLength(0);
    });

    it('updates staged call on staged-call-updated when still pending', () => {
      const original = mockStagedCall({ id: 's1', status: 'pending', reason: 'old' });
      useApprovalStore.setState({ stagedCalls: [original] });

      const updated = mockStagedCall({ id: 's1', status: 'pending', reason: 'updated' });
      useApprovalStore.getState().handleApprovalEvent('tool-safety:staged-call-updated', [updated]);

      const calls = useApprovalStore.getState().stagedCalls;
      expect(calls).toHaveLength(1);
      expect(calls[0].reason).toBe('updated');
    });

    it('ignores events with invalid payloads', () => {
      // No toolUseID
      useApprovalStore.getState().handleApprovalEvent('tool-safety:approval-request', [{}]);
      expect(useApprovalStore.getState().toolApprovals).toHaveLength(0);

      // No id
      useApprovalStore.getState().handleApprovalEvent('tool-safety:staged-call', [{}]);
      expect(useApprovalStore.getState().stagedCalls).toHaveLength(0);

      // Unknown channel
      useApprovalStore.getState().handleApprovalEvent('unknown:channel', [{ toolUseID: 'a1' }]);
      expect(useApprovalStore.getState().toolApprovals).toHaveLength(0);
    });
  });

  describe('handleMemoryEvent', () => {
    it('adds memory approval on write-approval-request', () => {
      const request = {
        toolUseId: 'm1',
        originalTurnId: 'turn-1',
        originalSessionId: 'session-1',
        destination: {
          path: 'Memory/test.md',
          spaceName: 'Memory',
          spacePath: 'Memory',
          isNew: true,
        },
        summary: 'Save memory',
        blockedBy: 'safety_prompt',
        timestamp: Date.now(),
      };

      useApprovalStore.getState().handleMemoryEvent('memory:write-approval-request', [request]);

      const approvals = useApprovalStore.getState().memoryApprovals;
      expect(approvals).toHaveLength(1);
      expect(approvals[0].toolUseId).toBe('m1');
      expect(approvals[0].isNewFile).toBe(true);
    });

    it('deduplicates memory approval by toolUseId', () => {
      useApprovalStore.setState({
        memoryApprovals: [mockMemoryApproval({ toolUseId: 'm1', summary: 'Old summary' })],
      });

      const updated = {
        toolUseId: 'm1',
        originalTurnId: 'turn-2',
        originalSessionId: 'session-1',
        destination: {
          path: 'Memory/test.md',
          spaceName: 'Memory',
          spacePath: 'Memory',
          isNew: false,
        },
        summary: 'New summary',
        blockedBy: 'safety_prompt',
        timestamp: Date.now(),
      };

      useApprovalStore.getState().handleMemoryEvent('memory:write-approval-request', [updated]);

      const approvals = useApprovalStore.getState().memoryApprovals;
      expect(approvals).toHaveLength(1);
      expect(approvals[0].summary).toBe('New summary');
      expect(approvals[0].originalTurnId).toBe('turn-2');
    });

    it('removes memory approval on write-approval-resolved', () => {
      useApprovalStore.setState({
        memoryApprovals: [
          mockMemoryApproval({ toolUseId: 'm1' }),
          mockMemoryApproval({ toolUseId: 'm2' }),
        ],
      });

      useApprovalStore.getState().handleMemoryEvent('memory:write-approval-resolved', [{ toolUseId: 'm1' }]);

      const approvals = useApprovalStore.getState().memoryApprovals;
      expect(approvals).toHaveLength(1);
      expect(approvals[0].toolUseId).toBe('m2');
    });

    it('ignores invalid memory payloads', () => {
      useApprovalStore.getState().handleMemoryEvent('memory:write-approval-request', [{}]);
      expect(useApprovalStore.getState().memoryApprovals).toHaveLength(0);

      useApprovalStore.setState({
        memoryApprovals: [mockMemoryApproval({ toolUseId: 'm1' })],
      });
      useApprovalStore.getState().handleMemoryEvent('memory:write-approval-resolved', [{}]);
      expect(useApprovalStore.getState().memoryApprovals).toHaveLength(1);
    });
  });
});
