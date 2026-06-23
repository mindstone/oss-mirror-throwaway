// approvalStore imports its API from the internal cloud-client module.
jest.mock('../../../../cloud-client/src/cloudClient', () => ({
  ipcCall: jest.fn(),
}));

const { useApprovalStore } = require('@rebel/cloud-client');
const cloudClient = require('../../../../cloud-client/src/cloudClient');

afterEach(() => {
  useApprovalStore.setState({
    toolApprovals: [],
    stagedCalls: [],
    isLoading: false,
    error: null,
  });
  jest.clearAllMocks();
});

const mockApproval = (id: string) => ({
  toolUseID: id,
  turnId: 't1',
  toolName: 'bash',
  input: { command: 'ls' },
  timestamp: Date.now(),
});

const mockStaged = (id: string) => ({
  id,
  sessionId: 's1',
  turnId: 't1',
  timestamp: Date.now(),
  status: 'pending',
  displayName: 'bash: ls',
  toolCategory: 'side-effect',
  riskLevel: 'medium',
  mcpPayload: { packageId: 'core', toolId: 'bash', args: { command: 'ls' } },
});

describe('approvalStore', () => {
  it('starts empty', () => {
    const state = useApprovalStore.getState();
    expect(state.toolApprovals).toEqual([]);
    expect(state.stagedCalls).toEqual([]);
  });

  it('fetches pending approvals', async () => {
    cloudClient.ipcCall
      .mockResolvedValueOnce([mockApproval('a1')])
      .mockResolvedValueOnce([mockStaged('s1')]);

    await useApprovalStore.getState().fetchPending();
    const state = useApprovalStore.getState();
    expect(state.toolApprovals).toHaveLength(1);
    expect(state.stagedCalls).toHaveLength(1);
  });

  it('responds to approval and removes it', async () => {
    useApprovalStore.setState({ toolApprovals: [mockApproval('a1')] });
    cloudClient.ipcCall.mockResolvedValueOnce({});

    await useApprovalStore.getState().respondToApproval('a1', true);
    expect(useApprovalStore.getState().toolApprovals).toHaveLength(0);
  });

  it('handles approval-request event', () => {
    const req = mockApproval('a2');
    useApprovalStore.getState().handleApprovalEvent('tool-safety:approval-request', [req]);
    expect(useApprovalStore.getState().toolApprovals).toHaveLength(1);
    expect(useApprovalStore.getState().toolApprovals[0].toolUseID).toBe('a2');
  });

  it('handles approval-resolved event', () => {
    useApprovalStore.setState({ toolApprovals: [mockApproval('a1')] });
    useApprovalStore.getState().handleApprovalEvent('tool-safety:approval-resolved', [{ toolUseID: 'a1' }]);
    expect(useApprovalStore.getState().toolApprovals).toHaveLength(0);
  });

  it('handles staged-call event', () => {
    const call = mockStaged('s1');
    useApprovalStore.getState().handleApprovalEvent('tool-safety:staged-call', [call]);
    expect(useApprovalStore.getState().stagedCalls).toHaveLength(1);
  });

  it('removes staged call when status changes from pending', () => {
    useApprovalStore.setState({ stagedCalls: [mockStaged('s1')] });
    useApprovalStore.getState().handleApprovalEvent('tool-safety:staged-call-updated', [
      { ...mockStaged('s1'), status: 'executed' },
    ]);
    expect(useApprovalStore.getState().stagedCalls).toHaveLength(0);
  });
});
