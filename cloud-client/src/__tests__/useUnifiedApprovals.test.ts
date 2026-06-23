/**
 * useUnifiedApprovals tests
 *
 * Verifies the cloud-client React hook wires `deriveUnifiedApprovals` to the
 * Zustand stores, applies sensible defaults (staged-file rows emitted, FM #16
 * dedup on), and reacts to store updates.
 */

import { act, renderHook } from '@testing-library/react';
import { useApprovalStore } from '../stores/approvalStore';
import { useStagedFilesStore } from '../stores/stagedFilesStore';
import { useUnifiedApprovals } from '../hooks/useUnifiedApprovals';
import type {
  CloudStagedToolCall,
  MemoryWriteApproval,
  StagedFile,
  ToolApproval,
} from '../types';
import type { SessionContextForApprovals } from '@rebel/shared';
import {
  APPROVAL_PARITY_FIXTURES,
  type ApprovalParityFixture,
} from '@rebel/shared/testFixtures/approvalParityFixtures';

// ---------------------------------------------------------------------------
// Fixture builders (kept minimal; we're wiring a hook, not retesting the mapper)
// ---------------------------------------------------------------------------

function buildToolApproval(overrides: Partial<ToolApproval> = {}): ToolApproval {
  return {
    toolUseID: 'tool-1',
    turnId: 'turn-1',
    sessionId: 'session-a',
    toolName: 'Bash',
    input: { command: 'ls' },
    reason: 'part of task',
    timestamp: 100,
    ...overrides,
  };
}

function buildMemoryApproval(overrides: Partial<MemoryWriteApproval> = {}): MemoryWriteApproval {
  return {
    toolUseId: 'mem-1',
    originalTurnId: 'turn-1',
    originalSessionId: 'session-a',
    spaceName: 'Memory',
    spacePath: 'memory/note.md',
    filePath: 'memory/note.md',
    summary: 'Take a note',
    contentPreview: 'preview',
    sharing: 'private',
    isNewFile: false,
    blockedBy: 'safety_prompt',
    timestamp: 200,
    ...overrides,
  };
}

function buildStagedCall(overrides: Partial<CloudStagedToolCall> = {}): CloudStagedToolCall {
  return {
    id: 'staged-1',
    sessionId: 'session-a',
    turnId: 'turn-1',
    timestamp: 300,
    status: 'pending',
    displayName: 'Send email',
    toolCategory: 'side-effect',
    riskLevel: 'high',
    reason: 'needs consent',
    mcpPayload: { packageId: 'gmail', toolId: 'send', args: {} },
    ...overrides,
  };
}

function buildStagedFile(overrides: Partial<StagedFile> = {}): StagedFile {
  return {
    id: 'file-1',
    realPath: '/workspace/memory/note.md',
    spaceName: 'Memory',
    spacePath: 'memory/note.md',
    sessionId: 'session-a',
    baseHash: 'hash-1',
    summary: 'Staged note',
    stagedAt: 400,
    sensitivity: 'high',
    ...overrides,
  };
}

function resetStores(): void {
  useApprovalStore.setState({
    toolApprovals: [],
    stagedCalls: [],
    memoryApprovals: [],
    isLoading: false,
    error: null,
  });
  useStagedFilesStore.setState({
    files: [],
    isLoading: false,
    error: null,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useUnifiedApprovals', () => {
  beforeEach(() => resetStores());

  it('returns empty items and zero count when stores are empty', () => {
    const { result } = renderHook(() => useUnifiedApprovals());
    expect(result.current.items).toEqual([]);
    expect(result.current.count).toBe(0);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('aggregates tool, memory, staged-tool, and staged-file rows', () => {
    useApprovalStore.setState({
      toolApprovals: [buildToolApproval()],
      memoryApprovals: [buildMemoryApproval()],
      stagedCalls: [buildStagedCall()],
    });
    useStagedFilesStore.setState({ files: [buildStagedFile()] });

    const { result } = renderHook(() => useUnifiedApprovals());
    const kinds = result.current.items.map((i) => i.kind).sort();
    expect(kinds).toEqual(['memory', 'staged-file', 'staged-tool', 'tool']);
    expect(result.current.count).toBe(4);
  });

  it('sorts rows newest-first', () => {
    useApprovalStore.setState({
      toolApprovals: [buildToolApproval({ toolUseID: 't', timestamp: 100 })],
      memoryApprovals: [buildMemoryApproval({ toolUseId: 'm', timestamp: 200 })],
      stagedCalls: [buildStagedCall({ id: 's', timestamp: 300 })],
    });
    useStagedFilesStore.setState({ files: [buildStagedFile({ id: 'f', stagedAt: 400 })] });

    const { result } = renderHook(() => useUnifiedApprovals());
    expect(result.current.items.map((i) => i.id)).toEqual([
      'staged-file:f',
      'staged-tool:s',
      'memory:m',
      'tool:t',
    ]);
  });

  it('applies FM #16 dedup by default: staged-memory row is hidden when matching staged-file exists', () => {
    useApprovalStore.setState({
      memoryApprovals: [
        buildMemoryApproval({ toolUseId: 'paired', staged: true, filePath: 'memory/note.md' }),
      ],
    });
    useStagedFilesStore.setState({
      files: [buildStagedFile({ toolUseId: 'paired', spacePath: 'memory/note.md' })],
    });

    const { result } = renderHook(() => useUnifiedApprovals());
    expect(result.current.items.map((i) => i.id)).toEqual(['staged-file:file-1']);
  });

  it('preserves memory isNewFile through useUnifiedApprovals', () => {
    useApprovalStore.setState({
      memoryApprovals: [buildMemoryApproval({ toolUseId: 'mem-new', isNewFile: true })],
    });

    const { result } = renderHook(() => useUnifiedApprovals());
    expect(result.current.items).toHaveLength(1);
    expect(result.current.items[0].id).toBe('memory:mem-new');
    expect(result.current.items[0].memoryApproval?.isNewFile).toBe(true);
  });

  it('optimistic suppression: id in suppressedIds is filtered out', () => {
    useApprovalStore.setState({
      toolApprovals: [buildToolApproval({ toolUseID: 'drop-me' })],
    });
    const suppressedIds = new Set(['tool:drop-me']);
    const { result } = renderHook(() => useUnifiedApprovals({ suppressedIds }));
    expect(result.current.items).toEqual([]);
  });

  it('staged-file suppression cascades to paired staged memory approval (F3-2)', () => {
    // Cascade only suppresses a memory row when it is itself a staged one.
    // Non-staged memory approvals with the same toolUseId stay visible — see
    // "staged-file suppression does NOT cascade to non-staged memory".
    useApprovalStore.setState({
      memoryApprovals: [
        buildMemoryApproval({ toolUseId: 'paired', staged: true }),
      ],
    });
    useStagedFilesStore.setState({
      files: [buildStagedFile({ id: 'sf-1', toolUseId: 'paired' })],
    });

    const suppressedIds = new Set(['staged-file:sf-1']);
    const { result } = renderHook(() => useUnifiedApprovals({ suppressedIds }));
    expect(result.current.items).toEqual([]);
  });

  it('staged-file suppression does NOT cascade to non-staged memory approvals (F3-2)', () => {
    useApprovalStore.setState({
      memoryApprovals: [buildMemoryApproval({ toolUseId: 'paired', staged: false })],
    });
    useStagedFilesStore.setState({
      files: [buildStagedFile({ id: 'sf-1', toolUseId: 'paired' })],
    });

    const suppressedIds = new Set(['staged-file:sf-1']);
    const { result } = renderHook(() => useUnifiedApprovals({ suppressedIds }));
    expect(result.current.items.map((i) => i.id)).toEqual(['memory:paired']);
  });

  it('staged-file suppression cascades by destination when toolUseId absent (F3-2)', () => {
    useApprovalStore.setState({
      memoryApprovals: [
        buildMemoryApproval({
          toolUseId: 'm-dest',
          staged: true,
          filePath: 'memory/note.md',
        }),
      ],
    });
    useStagedFilesStore.setState({
      files: [
        buildStagedFile({
          id: 'sf-dest',
          toolUseId: undefined,
          spacePath: 'memory/note.md',
        }),
      ],
    });

    const suppressedIds = new Set(['staged-file:sf-dest']);
    const { result } = renderHook(() => useUnifiedApprovals({ suppressedIds }));
    expect(result.current.items).toEqual([]);
  });

  it('reflects store updates reactively', () => {
    const { result } = renderHook(() => useUnifiedApprovals());
    expect(result.current.count).toBe(0);

    act(() => {
      useApprovalStore.setState({
        toolApprovals: [buildToolApproval()],
      });
    });
    expect(result.current.count).toBe(1);

    act(() => {
      useApprovalStore.setState({ toolApprovals: [] });
    });
    expect(result.current.count).toBe(0);
  });

  it('uses the supplied session context map when resolving titles', () => {
    const sessionContext = new Map<string, SessionContextForApprovals>([
      ['session-a', { title: 'Mission planning', messageCount: 1 }],
    ]);
    useApprovalStore.setState({
      toolApprovals: [buildToolApproval()],
    });
    const { result } = renderHook(() => useUnifiedApprovals({ sessionContext }));
    expect(result.current.items[0].title).toBe('Mission planning');
  });

  it('passes isGenericReason through via mapperOptions', () => {
    useApprovalStore.setState({
      toolApprovals: [buildToolApproval({ reason: 'part of task' })],
    });
    const { result } = renderHook(() =>
      useUnifiedApprovals({
        toolSummaries: new Map([['tool-1', { label: 'Run ls', detail: undefined }]]),
        mapperOptions: { isGenericReason: (r) => r === 'part of task' },
      }),
    );
    expect(result.current.items[0].description).toBe('Run ls');
  });

  it('leaves staged-tool riskLevel undefined when cloud payload risk is off-spec', () => {
    useApprovalStore.setState({
      stagedCalls: [buildStagedCall({ riskLevel: 'catastrophic' })],
    });

    const { result } = renderHook(() => useUnifiedApprovals());
    expect(result.current.items).toHaveLength(1);
    expect(result.current.items[0].riskLevel).toBeUndefined();
    expect(result.current.items[0].stagedToolCall?.riskLevel).toBeUndefined();
  });

  it('preserves staged-tool eval_error trust metadata from cloud DTOs', () => {
    useApprovalStore.setState({
      stagedCalls: [
        buildStagedCall({
          blockedBy: 'eval_error',
          allowPermanentTrust: false,
        }),
      ],
    });

    const { result } = renderHook(() => useUnifiedApprovals());
    expect(result.current.items).toHaveLength(1);
    expect(result.current.items[0].stagedToolCall?.blockedBy).toBe('eval_error');
    expect(result.current.items[0].stagedToolCall?.allowPermanentTrust).toBe(false);
  });

  it('surfaces approval-store loading state', () => {
    useApprovalStore.setState({ isLoading: true });
    const { result } = renderHook(() => useUnifiedApprovals());
    expect(result.current.loading).toBe(true);
  });

  it('surfaces staged-files-store loading state', () => {
    useStagedFilesStore.setState({ isLoading: true });
    const { result } = renderHook(() => useUnifiedApprovals());
    expect(result.current.loading).toBe(true);
  });

  it('returns aggregate error message from either store', () => {
    useApprovalStore.setState({ error: 'approval broke' });
    const { result } = renderHook(() => useUnifiedApprovals());
    expect(result.current.error).toBe('approval broke');

    act(() => {
      useApprovalStore.setState({ error: null });
      useStagedFilesStore.setState({ error: 'files broke' });
    });
    expect(result.current.error).toBe('files broke');
  });

  it('allows caller to turn off staged-file emission', () => {
    useStagedFilesStore.setState({ files: [buildStagedFile()] });
    const { result } = renderHook(() =>
      useUnifiedApprovals({ mapperOptions: { includeStagedFileItems: false } }),
    );
    expect(result.current.items).toEqual([]);
  });

  it('allows caller to turn off FM #16 dedup', () => {
    useApprovalStore.setState({
      memoryApprovals: [
        buildMemoryApproval({ toolUseId: 'paired', staged: true, filePath: 'memory/note.md' }),
      ],
    });
    useStagedFilesStore.setState({
      files: [buildStagedFile({ toolUseId: 'paired', spacePath: 'memory/note.md' })],
    });

    const { result } = renderHook(() =>
      useUnifiedApprovals({ mapperOptions: { dedupStagedMemoryApprovals: false } }),
    );
    expect(result.current.items.map((i) => i.id).sort()).toEqual([
      'memory:paired',
      'staged-file:file-1',
    ]);
  });
});

// ---------------------------------------------------------------------------
// F3-6 (Round 3): cross-surface parity fixtures
// ---------------------------------------------------------------------------
// Each shared fixture is hydrated into the Zustand stores, then the real
// `useUnifiedApprovals` hook is mounted and its items asserted against the
// fixture's `expectedCloudIds`. Catches drift between the pure mapper (which
// the shared mapper test covers directly) and the cloud-client hook that
// wraps it.
// ---------------------------------------------------------------------------

/**
 * Translate mapper-shaped fixture inputs into cloud-client store shapes and
 * hydrate both stores. The mapper input types are looser than cloud DTOs
 * (`MemoryWriteApproval` requires `spacePath` + `isNewFile` + `blockedBy`),
 * so we fill in sensible defaults for any missing fields.
 */
function hydrateFromFixture(fixture: ApprovalParityFixture): void {
  const toolApprovals: ToolApproval[] = fixture.inputs.toolApprovals.map((t) => ({
    toolUseID: t.toolUseID,
    turnId: t.turnId,
    sessionId: t.sessionId,
    toolName: t.toolName,
    input: t.input,
    reason: t.reason,
    timestamp: t.timestamp,
    allowPermanentTrust: t.allowPermanentTrust,
    blockedBy: t.blockedBy,
    riskLevel: t.riskLevel,
    packageName: t.packageName,
    conversationTitle: t.conversationTitle,
  }));

  const memoryApprovals: MemoryWriteApproval[] = fixture.inputs.memoryApprovals.map((m) => ({
    toolUseId: m.toolUseId,
    originalTurnId: m.toolUseId, // fixture doesn't carry it; use toolUseId as a stable stand-in
    originalSessionId: m.originalSessionId,
    spaceName: m.spaceName,
    spacePath: m.spacePath ?? m.filePath,
    location: m.location,
    filePath: m.filePath,
    summary: m.summary,
    contentPreview: m.contentPreview,
    sharing: m.sharing,
    isNewFile: m.isNewFile ?? false,
    blockedBy: m.blockedBy ?? 'safety_prompt',
    timestamp: m.timestamp,
    staged: m.staged,
    authorLabel: m.authorLabel,
    approvalKind: m.approvalKind,
  }));

  const stagedCalls: CloudStagedToolCall[] = fixture.inputs.stagedCalls.map((c) => ({
    id: c.id,
    sessionId: c.sessionId,
    turnId: c.turnId,
    timestamp: c.timestamp,
    status: c.status,
    mcpPayload: c.mcpPayload,
    displayName: c.displayName,
    toolCategory: c.toolCategory,
    riskLevel: c.riskLevel ?? 'unknown',
    reason: c.reason,
    automationName: c.automationName,
    allowPermanentTrust: c.allowPermanentTrust,
    blockedBy: c.blockedBy,
  }));

  const stagedFiles: StagedFile[] = fixture.inputs.stagedFiles.map((f) => ({
    id: f.id,
    realPath: f.realPath,
    spaceName: f.spaceName,
    spacePath: f.spacePath,
    location: f.location,
    sessionId: f.sessionId,
    baseHash: f.baseHash,
    summary: f.summary,
    stagedAt: f.stagedAt,
    sensitivity: 'high' as const,
    sharing: f.sharing,
    blockedBy: f.blockedBy,
    hasConflict: f.hasConflict,
    approvalKind: f.approvalKind,
    authorLabel: f.authorLabel,
    toolUseId: f.toolUseId,
    pendingDestination: f.destination,
  }));

  useApprovalStore.setState({ toolApprovals, memoryApprovals, stagedCalls });
  useStagedFilesStore.setState({ files: stagedFiles });
}

describe('useUnifiedApprovals — parity with shared fixtures (F3-6)', () => {
  beforeEach(() => resetStores());

  it.each(APPROVAL_PARITY_FIXTURES)('$name — cloud hook emits expectedCloudIds', (fixture) => {
    hydrateFromFixture(fixture);
    const sessionContext = new Map(fixture.inputs.sessionContextEntries);
    // `suppressedIds` is exposed at the top level of the hook's API;
    // everything else (dedup / include-staged-files / generic-reason etc.)
    // goes through `mapperOptions`. The hook's built-in defaults already
    // match cloud-mode expectations (staged-files ON, FM #16 dedup ON),
    // so the fixture's `cloudOptions` typically only adds `suppressedIds`.
    const { suppressedIds, ...mapperOptions } = fixture.cloudOptions;
    const { result } = renderHook(() =>
      useUnifiedApprovals({
        sessionContext,
        suppressedIds,
        mapperOptions,
      }),
    );
    expect(result.current.items.map((i) => i.id)).toEqual(fixture.expectedCloudIds);
  });
});
