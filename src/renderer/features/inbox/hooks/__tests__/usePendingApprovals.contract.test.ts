// @vitest-environment happy-dom
/**
 * usePendingApprovals — contract test with typed fixtures.
 *
 * Locks the public shape of `usePendingApprovals`'s return value by running
 * the pure list derivation (now in `@rebel/shared`) against a curated set of
 * typed fixtures and asserting both the serializable contents AND the
 * presence of the callback API (with `typeof === 'function'`).
 *
 * Why not snapshots?
 *   - Snapshots break silently on cosmetic diffs and are easy to re-baseline
 *     without re-reading. Typed fixtures with explicit `expectedItems` entries
 *     force contributors to understand which fields changed.
 *
 * Covered scenarios (Stage 3 DoD + F3-5):
 *   - empty
 *   - tool-only
 *   - memory-only
 *   - staged-tool-only
 *   - staged-file-only (F3-5c — desktop still hides staged files inline)
 *   - mixed
 *   - with-conflict
 *   - with-safety-block
 *   - with-continuation-group
 *   - with-batch-pending
 *   - with-optimistic-removal-of-staged-file (cascade suppression)
 *   - with-same-tick-race (three events at identical timestamps; F3-9 id tiebreaker)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act, flushAsync } from '@renderer/test-utils';
import {
  deriveUnifiedApprovals,
  type MemoryApprovalInput,
  type SessionContextForApprovals,
  type StagedFileInput,
  type StagedToolCallInput,
  type ToolApprovalInput,
  type UnifiedApproval,
} from '@rebel/shared';
import {
  APPROVAL_PARITY_FIXTURES,
  type ApprovalParityFixture,
} from '@rebel/shared/testFixtures/approvalParityFixtures';
import {
  notifyOptimisticRemoval,
  usePendingApprovals,
  type PendingApprovalItem,
  type UsePendingApprovalsReturn,
} from '../usePendingApprovals';

// ---------------------------------------------------------------------------
// Fixture types (F3-5a: expand ContractFixture)
// ---------------------------------------------------------------------------

/**
 * F3-5 rigor: the full serializable projection of `PendingApprovalItem`.
 *
 * `PendingApprovalItem` has no function-typed fields (callbacks live on the
 * hook's return object, not on each item), so the serializable projection is
 * identical to the item itself. Using an alias here keeps the intent loud
 * — if someone adds a callback to `PendingApprovalItem` later, this type
 * should be narrowed explicitly and the fixtures updated. Using `toEqual`
 * against this type forces fixtures to declare every field, which catches
 * silent additions/drops that `toMatchObject(Partial<...>)` would miss.
 */
type SerializableFields = PendingApprovalItem;

interface ContractFixture {
  name: string;
  inputs: {
    toolApprovals: ToolApprovalInput[];
    memoryApprovals: MemoryApprovalInput[];
    stagedCalls: StagedToolCallInput[];
    stagedFiles: StagedFileInput[];
    sessionContext: ReadonlyMap<string, SessionContextForApprovals>;
    suppressedIds?: Set<string>;
  };
  /**
   * Full serializable expectations for every emitted row (in order). Empty
   * array for fixtures that emit nothing. Each entry is asserted with
   * `toEqual(SerializableFields)` — no partial matches.
   */
  expectedItems: SerializableFields[];
  expectedContract: {
    itemCount: number;
    idsInOrder: string[];
    typesInOrder: Array<PendingApprovalItem['type']>;
    /** F3-5a: the exact exported-key surface the hook returns. */
    exportedKeys: string[];
    /** F3-5a: whether batch actions (batchApproveToolApprovals) are present. */
    hasBatchActions: boolean;
  };
}

// ---------------------------------------------------------------------------
// Shared builders
// ---------------------------------------------------------------------------

const emptyCtx: ReadonlyMap<string, SessionContextForApprovals> = new Map();

function ctx(entries: Array<[string, SessionContextForApprovals]>): ReadonlyMap<string, SessionContextForApprovals> {
  return new Map(entries);
}

function toolApproval(overrides: Partial<ToolApprovalInput>): ToolApprovalInput {
  return {
    toolUseID: 'tool-default',
    turnId: 'turn-1',
    toolName: 'Bash',
    input: {},
    timestamp: 1_700_000_000_000,
    ...overrides,
  };
}

function memoryApproval(overrides: Partial<MemoryApprovalInput>): MemoryApprovalInput {
  return {
    toolUseId: 'mem-default',
    originalSessionId: 'session-a',
    filePath: 'memory/note.md',
    spaceName: 'Memory',
    summary: 'Summary',
    content: '',
    timestamp: 1_700_000_000_000,
    ...overrides,
  };
}

function stagedCall(overrides: Partial<StagedToolCallInput>): StagedToolCallInput {
  return {
    id: 'staged-default',
    sessionId: 'session-a',
    turnId: 'turn-1',
    timestamp: 1_700_000_000_000,
    expiresAt: 1_800_000_000_000,
    status: 'pending',
    mcpPayload: { packageId: 'pkg', toolId: 'tool', args: {} },
    displayName: 'Staged action',
    toolCategory: 'side-effect',
    riskLevel: 'high',
    ...overrides,
  };
}

function stagedFile(overrides: Partial<StagedFileInput>): StagedFileInput {
  return {
    id: 'sf-default',
    realPath: '/ws/memory/note.md',
    spaceName: 'Memory',
    spacePath: 'memory/note.md',
    sessionId: 'session-a',
    baseHash: 'hash',
    summary: 'Staged note',
    stagedAt: 1_700_000_000_000,
    sensitivity: 'high',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Hook-return key set — the canonical contract consumers rely on. If this
// changes, callers must be updated in lockstep (see AGENTS.md rules on
// desktop parity for Stage 3).
// ---------------------------------------------------------------------------

const EXPECTED_HOOK_KEYS = [
  'approvals',
  'approveToolApproval',
  'batchApproveToolApprovals',
  'dismissApproval',
  'executeStagedApproval',
  'isLoading',
  'refresh',
  'removeApproval',
  'saveApproval',
].sort();

// ---------------------------------------------------------------------------
// Run desktop-parity mapper (same options as usePendingApprovals wires)
// ---------------------------------------------------------------------------

function deriveDesktopItems(
  inputs: ContractFixture['inputs'],
): UnifiedApproval[] {
  return deriveUnifiedApprovals(
    {
      toolApprovals: inputs.toolApprovals,
      memoryApprovals: inputs.memoryApprovals,
      stagedCalls: inputs.stagedCalls,
      stagedFiles: inputs.stagedFiles,
      sessionContext: inputs.sessionContext,
    },
    {
      suppressedIds: inputs.suppressedIds,
      excludeNonPendingStagedCalls: true,
      includeStagedFileItems: false,
      dedupStagedMemoryApprovals: false,
    },
  );
}

/**
 * Cloud-client mode — staged files ARE emitted inline, and paired memory
 * approvals are deduplicated. Used by the F3-6 parity block below.
 */
function deriveCloudItems(
  inputs: ContractFixture['inputs'],
): UnifiedApproval[] {
  return deriveUnifiedApprovals(
    {
      toolApprovals: inputs.toolApprovals,
      memoryApprovals: inputs.memoryApprovals,
      stagedCalls: inputs.stagedCalls,
      stagedFiles: inputs.stagedFiles,
      sessionContext: inputs.sessionContext,
    },
    {
      suppressedIds: inputs.suppressedIds,
      excludeNonPendingStagedCalls: true,
      includeStagedFileItems: true,
      dedupStagedMemoryApprovals: true,
    },
  );
}

function unifiedToDesktop(u: UnifiedApproval): PendingApprovalItem {
  return {
    id: u.id,
    type: u.kind === 'staged-tool' ? 'staged-tool' : u.kind === 'memory' ? 'memory' : 'tool',
    title: u.title,
    description: u.description,
    timestamp: u.timestamp,
    sessionId: u.sessionId,
    riskLevel: u.riskLevel,
    packageName: u.packageName,
    conversationTitle: u.conversationTitle,
    sessionContext: u.sessionContext,
    toolApproval: u.toolApproval,
    memoryApproval: u.memoryApproval,
    stagedToolCall: u.stagedToolCall,
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const COMMON_CONTRACT = {
  exportedKeys: EXPECTED_HOOK_KEYS,
  hasBatchActions: true,
} as const;

const FIXTURES: ContractFixture[] = [
  {
    name: 'empty',
    inputs: {
      toolApprovals: [],
      memoryApprovals: [],
      stagedCalls: [],
      stagedFiles: [],
      sessionContext: emptyCtx,
    },
    expectedItems: [],
    expectedContract: {
      ...COMMON_CONTRACT,
      itemCount: 0,
      idsInOrder: [],
      typesInOrder: [],
    },
  },
  {
    name: 'tool-only',
    inputs: {
      toolApprovals: [
        toolApproval({
          toolUseID: 't-1',
          sessionId: 'session-a',
          toolName: 'Bash',
          input: { command: 'ls' },
          reason: 'Shell commands are powerful',
          timestamp: 1_000,
        }),
      ],
      memoryApprovals: [],
      stagedCalls: [],
      stagedFiles: [],
      sessionContext: ctx([['session-a', { title: 'Planning', messageCount: 2 }]]),
    },
    expectedItems: [
      {
        id: 'tool:t-1',
        type: 'tool',
        title: 'Planning',
        description: 'Shell commands are powerful',
        timestamp: 1_000,
        sessionId: 'session-a',
        riskLevel: undefined,
        packageName: undefined,
        conversationTitle: undefined,
        sessionContext: { title: 'Planning', messageCount: 2 },
        toolApproval: {
          toolUseID: 't-1',
          turnId: 'turn-1',
          toolName: 'Bash',
          input: { command: 'ls' },
          reason: 'Shell commands are powerful',
          effectiveToolId: undefined,
        },
        memoryApproval: undefined,
        stagedToolCall: undefined,
      },
    ],
    expectedContract: {
      ...COMMON_CONTRACT,
      itemCount: 1,
      idsInOrder: ['tool:t-1'],
      typesInOrder: ['tool'],
    },
  },
  {
    name: 'memory-only',
    inputs: {
      toolApprovals: [],
      memoryApprovals: [
        memoryApproval({
          toolUseId: 'm-1',
          originalSessionId: 'session-b',
          spaceName: 'Strategy',
          filePath: 'Strategy/plan.md',
          summary: 'Q1 OKRs',
          timestamp: 2_000,
        }),
      ],
      stagedCalls: [],
      stagedFiles: [],
      sessionContext: ctx([['session-b', { title: 'Strategy session', messageCount: 5 }]]),
    },
    expectedItems: [
      {
        id: 'memory:m-1',
        type: 'memory',
        title: 'Strategy session',
        description: 'Wants to save to "Strategy": Q1 OKRs',
        timestamp: 2_000,
        sessionId: 'session-b',
        riskLevel: undefined,
        packageName: undefined,
        conversationTitle: undefined,
        sessionContext: { title: 'Strategy session', messageCount: 5 },
        toolApproval: undefined,
        memoryApproval: {
          toolUseId: 'm-1',
          originalSessionId: 'session-b',
          filePath: 'Strategy/plan.md',
          spaceName: 'Strategy',
          summary: 'Q1 OKRs',
          content: '',
          sensitivityReason: undefined,
          hasSpaceOverride: undefined,
          privateMode: undefined,
          blockedBy: undefined,
          spacePath: undefined,
          sharing: undefined,
          contentPreview: undefined,
          approvalIdentifier: undefined,
          approvalKind: undefined,
          authorLabel: undefined,
          staged: undefined,
        },
        stagedToolCall: undefined,
      },
    ],
    expectedContract: {
      ...COMMON_CONTRACT,
      itemCount: 1,
      idsInOrder: ['memory:m-1'],
      typesInOrder: ['memory'],
    },
  },
  {
    name: 'staged-tool-only',
    inputs: {
      toolApprovals: [],
      memoryApprovals: [],
      stagedCalls: [
        stagedCall({
          id: 's-1',
          sessionId: 'session-c',
          displayName: 'Send Slack message',
          reason: 'Needs consent',
          riskLevel: 'high',
          timestamp: 3_000,
          mcpPayload: { packageId: 'slack', toolId: 'post', args: {} },
        }),
      ],
      stagedFiles: [],
      sessionContext: ctx([['session-c', { title: 'Team update', messageCount: 1 }]]),
    },
    expectedItems: [
      {
        id: 'staged-tool:s-1',
        type: 'staged-tool',
        title: 'Team update',
        description: 'Needs consent',
        timestamp: 3_000,
        sessionId: 'session-c',
        riskLevel: 'high',
        packageName: 'slack',
        conversationTitle: undefined,
        sessionContext: { title: 'Team update', messageCount: 1 },
        toolApproval: undefined,
        memoryApproval: undefined,
        stagedToolCall: {
          id: 's-1',
          displayName: 'Send Slack message',
          mcpPayload: { packageId: 'slack', toolId: 'post', args: {} },
          riskLevel: 'high',
          reason: 'Needs consent',
          allowPermanentTrust: undefined,
          automationName: undefined,
        },
      },
    ],
    expectedContract: {
      ...COMMON_CONTRACT,
      itemCount: 1,
      idsInOrder: ['staged-tool:s-1'],
      typesInOrder: ['staged-tool'],
    },
  },
  {
    name: 'staged-tool-with-missing-risk',
    inputs: {
      toolApprovals: [],
      memoryApprovals: [],
      stagedCalls: [
        stagedCall({
          id: 's-missing-risk',
          sessionId: 'session-c',
          displayName: 'Send Slack message',
          reason: 'Needs consent',
          riskLevel: undefined,
          timestamp: 3_001,
          mcpPayload: { packageId: 'slack', toolId: 'post', args: {} },
        }),
      ],
      stagedFiles: [],
      sessionContext: ctx([['session-c', { title: 'Team update', messageCount: 1 }]]),
    },
    expectedItems: [
      {
        id: 'staged-tool:s-missing-risk',
        type: 'staged-tool',
        title: 'Team update',
        description: 'Needs consent',
        timestamp: 3_001,
        sessionId: 'session-c',
        riskLevel: undefined,
        packageName: 'slack',
        conversationTitle: undefined,
        sessionContext: { title: 'Team update', messageCount: 1 },
        toolApproval: undefined,
        memoryApproval: undefined,
        stagedToolCall: {
          id: 's-missing-risk',
          displayName: 'Send Slack message',
          mcpPayload: { packageId: 'slack', toolId: 'post', args: {} },
          riskLevel: undefined,
          reason: 'Needs consent',
          allowPermanentTrust: undefined,
          automationName: undefined,
        },
      },
    ],
    expectedContract: {
      ...COMMON_CONTRACT,
      itemCount: 1,
      idsInOrder: ['staged-tool:s-missing-risk'],
      typesInOrder: ['staged-tool'],
    },
  },
  {
    // F3-5c: staged-file-only fixture — proves desktop parity (staged files
    // never render inline; they live in a dedicated strip). The underlying
    // mapper IS receiving the input, but `includeStagedFileItems: false`
    // keeps the row out of `approvals`.
    name: 'staged-file-only (desktop hides inline; count stays 0)',
    inputs: {
      toolApprovals: [],
      memoryApprovals: [],
      stagedCalls: [],
      stagedFiles: [
        stagedFile({ id: 'sf-only', toolUseId: 'sf-only-tuid' }),
      ],
      sessionContext: emptyCtx,
    },
    expectedItems: [],
    expectedContract: {
      ...COMMON_CONTRACT,
      itemCount: 0,
      idsInOrder: [],
      typesInOrder: [],
    },
  },
  {
    name: 'mixed',
    inputs: {
      toolApprovals: [
        toolApproval({ toolUseID: 't-mix', sessionId: 'session-a', reason: 'reason', timestamp: 100 }),
      ],
      memoryApprovals: [
        memoryApproval({
          toolUseId: 'm-mix',
          originalSessionId: 'session-a',
          spaceName: 'Memory',
          filePath: 'memory/x.md',
          summary: 'note',
          timestamp: 200,
        }),
      ],
      stagedCalls: [
        stagedCall({ id: 's-mix', sessionId: 'session-a', reason: 'needs consent', timestamp: 300 }),
      ],
      stagedFiles: [],
      sessionContext: ctx([['session-a', { title: 'Session A', messageCount: 1 }]]),
    },
    expectedItems: [
      {
        id: 'staged-tool:s-mix',
        type: 'staged-tool',
        title: 'Session A',
        description: 'needs consent',
        timestamp: 300,
        sessionId: 'session-a',
        riskLevel: 'high',
        packageName: 'pkg',
        conversationTitle: undefined,
        sessionContext: { title: 'Session A', messageCount: 1 },
        toolApproval: undefined,
        memoryApproval: undefined,
        stagedToolCall: {
          id: 's-mix',
          displayName: 'Staged action',
          mcpPayload: { packageId: 'pkg', toolId: 'tool', args: {} },
          riskLevel: 'high',
          reason: 'needs consent',
          allowPermanentTrust: undefined,
          automationName: undefined,
        },
      },
      {
        id: 'memory:m-mix',
        type: 'memory',
        title: 'Session A',
        description: 'Wants to save to "Memory": note',
        timestamp: 200,
        sessionId: 'session-a',
        riskLevel: undefined,
        packageName: undefined,
        conversationTitle: undefined,
        sessionContext: { title: 'Session A', messageCount: 1 },
        toolApproval: undefined,
        memoryApproval: {
          toolUseId: 'm-mix',
          originalSessionId: 'session-a',
          filePath: 'memory/x.md',
          spaceName: 'Memory',
          summary: 'note',
          content: '',
          sensitivityReason: undefined,
          hasSpaceOverride: undefined,
          privateMode: undefined,
          blockedBy: undefined,
          spacePath: undefined,
          sharing: undefined,
          contentPreview: undefined,
          approvalIdentifier: undefined,
          approvalKind: undefined,
          authorLabel: undefined,
          staged: undefined,
        },
        stagedToolCall: undefined,
      },
      {
        id: 'tool:t-mix',
        type: 'tool',
        title: 'Session A',
        description: 'reason',
        timestamp: 100,
        sessionId: 'session-a',
        riskLevel: undefined,
        packageName: undefined,
        conversationTitle: undefined,
        sessionContext: { title: 'Session A', messageCount: 1 },
        toolApproval: {
          toolUseID: 't-mix',
          turnId: 'turn-1',
          toolName: 'Bash',
          input: {},
          reason: 'reason',
          effectiveToolId: undefined,
        },
        memoryApproval: undefined,
        stagedToolCall: undefined,
      },
    ],
    expectedContract: {
      ...COMMON_CONTRACT,
      itemCount: 3,
      idsInOrder: ['staged-tool:s-mix', 'memory:m-mix', 'tool:t-mix'],
      typesInOrder: ['staged-tool', 'memory', 'tool'],
    },
  },
  {
    name: 'with-conflict (staged-file hidden inline, dedup off → memory still visible)',
    inputs: {
      toolApprovals: [],
      memoryApprovals: [
        memoryApproval({ toolUseId: 'm-con', staged: true, filePath: 'memory/conflict.md', timestamp: 100 }),
      ],
      stagedCalls: [],
      stagedFiles: [
        stagedFile({ id: 'sf-con', toolUseId: 'm-con', hasConflict: true }),
      ],
      sessionContext: emptyCtx,
    },
    expectedItems: [
      {
        id: 'memory:m-con',
        type: 'memory',
        title: 'Background task',
        description: 'Wants to save to "Memory": Summary',
        timestamp: 100,
        sessionId: 'session-a',
        riskLevel: undefined,
        packageName: undefined,
        conversationTitle: undefined,
        sessionContext: undefined,
        toolApproval: undefined,
        memoryApproval: {
          toolUseId: 'm-con',
          originalSessionId: 'session-a',
          filePath: 'memory/conflict.md',
          spaceName: 'Memory',
          summary: 'Summary',
          content: '',
          sensitivityReason: undefined,
          hasSpaceOverride: undefined,
          privateMode: undefined,
          blockedBy: undefined,
          spacePath: undefined,
          sharing: undefined,
          contentPreview: undefined,
          approvalIdentifier: undefined,
          approvalKind: undefined,
          authorLabel: undefined,
          staged: true,
        },
        stagedToolCall: undefined,
      },
    ],
    expectedContract: {
      ...COMMON_CONTRACT,
      // Desktop parity: staged files don't appear inline, but the paired
      // memory row stays. (usePendingApprovalCount dedupes — items do not.)
      itemCount: 1,
      idsInOrder: ['memory:m-con'],
      typesInOrder: ['memory'],
    },
  },
  {
    name: 'with-safety-block',
    inputs: {
      toolApprovals: [
        toolApproval({
          toolUseID: 't-safety',
          reason: 'Safety Rules blocked: shell can delete files',
          timestamp: 500,
        }),
      ],
      memoryApprovals: [],
      stagedCalls: [],
      stagedFiles: [],
      sessionContext: emptyCtx,
    },
    expectedItems: [
      {
        id: 'tool:t-safety',
        type: 'tool',
        title: 'Background task',
        description: 'shell can delete files',
        timestamp: 500,
        sessionId: null,
        riskLevel: undefined,
        packageName: undefined,
        conversationTitle: undefined,
        sessionContext: undefined,
        toolApproval: {
          toolUseID: 't-safety',
          turnId: 'turn-1',
          toolName: 'Bash',
          input: {},
          reason: 'Safety Rules blocked: shell can delete files',
          effectiveToolId: undefined,
        },
        memoryApproval: undefined,
        stagedToolCall: undefined,
      },
    ],
    expectedContract: {
      ...COMMON_CONTRACT,
      itemCount: 1,
      idsInOrder: ['tool:t-safety'],
      typesInOrder: ['tool'],
    },
  },
  {
    name: 'with-continuation-group',
    inputs: {
      toolApprovals: [
        toolApproval({ toolUseID: 't-a', sessionId: 'session-1', reason: 'reason A', timestamp: 100 }),
        toolApproval({ toolUseID: 't-b', sessionId: 'session-1', reason: 'reason B', timestamp: 200 }),
      ],
      memoryApprovals: [],
      stagedCalls: [],
      stagedFiles: [],
      sessionContext: ctx([['session-1', { title: 'Session 1', messageCount: 1 }]]),
    },
    expectedItems: [
      {
        id: 'tool:t-b',
        type: 'tool',
        title: 'Session 1',
        description: 'reason B',
        timestamp: 200,
        sessionId: 'session-1',
        riskLevel: undefined,
        packageName: undefined,
        conversationTitle: undefined,
        sessionContext: { title: 'Session 1', messageCount: 1 },
        toolApproval: {
          toolUseID: 't-b',
          turnId: 'turn-1',
          toolName: 'Bash',
          input: {},
          reason: 'reason B',
          effectiveToolId: undefined,
        },
        memoryApproval: undefined,
        stagedToolCall: undefined,
      },
      {
        id: 'tool:t-a',
        type: 'tool',
        title: 'Session 1',
        description: 'reason A',
        timestamp: 100,
        sessionId: 'session-1',
        riskLevel: undefined,
        packageName: undefined,
        conversationTitle: undefined,
        sessionContext: { title: 'Session 1', messageCount: 1 },
        toolApproval: {
          toolUseID: 't-a',
          turnId: 'turn-1',
          toolName: 'Bash',
          input: {},
          reason: 'reason A',
          effectiveToolId: undefined,
        },
        memoryApproval: undefined,
        stagedToolCall: undefined,
      },
    ],
    expectedContract: {
      ...COMMON_CONTRACT,
      itemCount: 2,
      idsInOrder: ['tool:t-b', 'tool:t-a'],
      typesInOrder: ['tool', 'tool'],
    },
  },
  {
    name: 'with-batch-pending',
    inputs: {
      toolApprovals: [],
      memoryApprovals: [],
      stagedCalls: [0, 1, 2, 3, 4].map((i) =>
        stagedCall({ id: `batch-${i}`, sessionId: 'session-batch', timestamp: 100 + i }),
      ),
      stagedFiles: [],
      sessionContext: ctx([['session-batch', { title: 'Batch', messageCount: 0 }]]),
    },
    expectedItems: [4, 3, 2, 1, 0].map((i) => ({
      id: `staged-tool:batch-${i}`,
      type: 'staged-tool' as const,
      title: 'Batch',
      description: 'Staged action',
      timestamp: 100 + i,
      sessionId: 'session-batch',
      riskLevel: 'high' as const,
      packageName: 'pkg',
      conversationTitle: undefined,
      sessionContext: { title: 'Batch', messageCount: 0 },
      toolApproval: undefined,
      memoryApproval: undefined,
      stagedToolCall: {
        id: `batch-${i}`,
        displayName: 'Staged action',
        mcpPayload: { packageId: 'pkg', toolId: 'tool', args: {} },
        riskLevel: 'high' as const,
        reason: undefined,
        allowPermanentTrust: undefined,
        automationName: undefined,
      },
    })),
    expectedContract: {
      ...COMMON_CONTRACT,
      itemCount: 5,
      idsInOrder: [
        'staged-tool:batch-4',
        'staged-tool:batch-3',
        'staged-tool:batch-2',
        'staged-tool:batch-1',
        'staged-tool:batch-0',
      ],
      typesInOrder: ['staged-tool', 'staged-tool', 'staged-tool', 'staged-tool', 'staged-tool'],
    },
  },
  {
    name: 'with-optimistic-removal-of-staged-file (cascade suppresses paired memory)',
    inputs: {
      toolApprovals: [],
      memoryApprovals: [
        memoryApproval({ toolUseId: 'paired', staged: true, timestamp: 100 }),
      ],
      stagedCalls: [],
      stagedFiles: [
        stagedFile({ id: 'sf-cas', toolUseId: 'paired' }),
      ],
      sessionContext: emptyCtx,
      suppressedIds: new Set(['staged-file:sf-cas']),
    },
    expectedItems: [],
    expectedContract: {
      ...COMMON_CONTRACT,
      itemCount: 0,
      idsInOrder: [],
      typesInOrder: [],
    },
  },
  {
    name: 'with-same-tick-race (three events at identical timestamps; F3-9 id tiebreaker)',
    inputs: {
      toolApprovals: [toolApproval({ toolUseID: 't-race', timestamp: 500 })],
      memoryApprovals: [
        memoryApproval({ toolUseId: 'm-race', timestamp: 500, filePath: 'memory/race.md' }),
      ],
      stagedCalls: [stagedCall({ id: 's-race', timestamp: 500 })],
      stagedFiles: [],
      sessionContext: emptyCtx,
    },
    expectedItems: [
      {
        id: 'memory:m-race',
        type: 'memory',
        title: 'Background task',
        description: 'Wants to save to "Memory": Summary',
        timestamp: 500,
        sessionId: 'session-a',
        riskLevel: undefined,
        packageName: undefined,
        conversationTitle: undefined,
        sessionContext: undefined,
        toolApproval: undefined,
        memoryApproval: {
          toolUseId: 'm-race',
          originalSessionId: 'session-a',
          filePath: 'memory/race.md',
          spaceName: 'Memory',
          summary: 'Summary',
          content: '',
          sensitivityReason: undefined,
          hasSpaceOverride: undefined,
          privateMode: undefined,
          blockedBy: undefined,
          spacePath: undefined,
          sharing: undefined,
          contentPreview: undefined,
          approvalIdentifier: undefined,
          approvalKind: undefined,
          authorLabel: undefined,
          staged: undefined,
        },
        stagedToolCall: undefined,
      },
      {
        id: 'staged-tool:s-race',
        type: 'staged-tool',
        title: 'Background task',
        description: 'Staged action',
        timestamp: 500,
        sessionId: 'session-a',
        riskLevel: 'high',
        packageName: 'pkg',
        conversationTitle: undefined,
        sessionContext: undefined,
        toolApproval: undefined,
        memoryApproval: undefined,
        stagedToolCall: {
          id: 's-race',
          displayName: 'Staged action',
          mcpPayload: { packageId: 'pkg', toolId: 'tool', args: {} },
          riskLevel: 'high',
          reason: undefined,
          allowPermanentTrust: undefined,
          automationName: undefined,
        },
      },
      {
        id: 'tool:t-race',
        type: 'tool',
        title: 'Background task',
        description: '',
        timestamp: 500,
        sessionId: null,
        riskLevel: undefined,
        packageName: undefined,
        conversationTitle: undefined,
        sessionContext: undefined,
        toolApproval: {
          toolUseID: 't-race',
          turnId: 'turn-1',
          toolName: 'Bash',
          input: {},
          reason: undefined,
          effectiveToolId: undefined,
        },
        memoryApproval: undefined,
        stagedToolCall: undefined,
      },
    ],
    expectedContract: {
      ...COMMON_CONTRACT,
      itemCount: 3,
      // F3-9: deterministic id-based tiebreaker for same-timestamp rows.
      idsInOrder: ['memory:m-race', 'staged-tool:s-race', 'tool:t-race'],
      typesInOrder: ['memory', 'staged-tool', 'tool'],
    },
  },
];

// ---------------------------------------------------------------------------
// Mapper-based fixture tests
// ---------------------------------------------------------------------------

describe('usePendingApprovals — contract (typed fixtures)', () => {
  it.each(FIXTURES)('$name', (fixture) => {
    const derived = deriveDesktopItems(fixture.inputs).map(unifiedToDesktop);

    // 1. Ordering and types
    expect(derived.map((i) => i.id)).toEqual(fixture.expectedContract.idsInOrder);
    expect(derived.map((i) => i.type)).toEqual(fixture.expectedContract.typesInOrder);
    expect(derived).toHaveLength(fixture.expectedContract.itemCount);

    // 2. F3-5 rigor: full typed equality for every emitted row. No partial
    // matching — fixtures must spell out every serializable field. Catches
    // silent field additions / drops that `toMatchObject` would miss.
    expect(derived).toEqual(fixture.expectedItems);

    // 3. Staged-file rows must never be emitted in the desktop-parity list
    for (const item of derived) {
      expect(item.type).not.toBe('staged-file');
    }

    // 4. Every serialized row round-trips through JSON without loss
    const roundTripped = JSON.parse(JSON.stringify(derived));
    expect(roundTripped).toEqual(derived);
  });
});

// ---------------------------------------------------------------------------
// F3-5d: real race test — mount the hook, dispatch
// notifyOptimisticRemoval('staged-file:X'), push a store update containing
// that staged-file in the same task, and verify:
//   - no staged-file row is ever emitted
//   - the paired memory approval is also absent from .items after flush
// ---------------------------------------------------------------------------

interface WindowMocks {
  safetyApi: { pending: ReturnType<typeof vi.fn>; stagedGetAll: ReturnType<typeof vi.fn> };
  memoryApi: { getPendingApprovals: ReturnType<typeof vi.fn> };
  sessionsApi: { list: ReturnType<typeof vi.fn> };
  api: Record<string, ReturnType<typeof vi.fn>>;
}

let stagedFilesChangedHandler: ((args?: unknown) => void) | null = null;

function setupMocks(): WindowMocks {
  // Fresh handler references per test. Many "on*" events never fire, but we
  // capture the staged-files-changed handler so the real race test can
  // synthesize a "new staged file arrived" event.
  stagedFilesChangedHandler = null;

  const memoryFixture = [
    {
      toolUseId: 'paired',
      originalTurnId: 'turn-1',
      originalSessionId: 'session-a',
      turnId: 'turn-1',
      sessionId: 'session-a',
      filePath: 'memory/race.md',
      spaceName: 'Memory',
      summary: 'summary',
      content: '',
      timestamp: 500,
      staged: true,
    },
  ];

  const api: Record<string, ReturnType<typeof vi.fn>> = {
    onToolSafetyApprovalRequest: vi.fn(() => () => undefined),
    onMemoryWriteApprovalRequest: vi.fn(() => () => undefined),
    onMemoryWriteApprovalResolved: vi.fn(() => () => undefined),
    onToolSafetyApprovalResolved: vi.fn(() => () => undefined),
    onStagedToolCall: vi.fn(() => () => undefined),
    onStagedToolCallUpdated: vi.fn(() => () => undefined),
    onStagedFilesChanged: vi.fn((cb: (args?: unknown) => void) => {
      stagedFilesChangedHandler = cb;
      return () => {
        stagedFilesChangedHandler = null;
      };
    }),
    getStagedFiles: vi.fn().mockResolvedValue({ files: [] }),
    sendMemoryWriteApprovalResponse: vi.fn().mockResolvedValue({ success: true }),
  };

  const safetyApi = {
    pending: vi.fn().mockResolvedValue([]),
    stagedGetAll: vi.fn().mockResolvedValue([]),
  };
  const memoryApi = {
    getPendingApprovals: vi.fn().mockResolvedValue(memoryFixture),
  };
  const sessionsApi = { list: vi.fn().mockResolvedValue([]) };

  (window as unknown as { api: typeof api }).api = api;
  (window as unknown as { safetyApi: typeof safetyApi }).safetyApi = safetyApi;
  (window as unknown as { memoryApi: typeof memoryApi }).memoryApi = memoryApi;
  (window as unknown as { sessionsApi: typeof sessionsApi }).sessionsApi = sessionsApi;

  return { safetyApi, memoryApi, sessionsApi, api };
}

describe('usePendingApprovals — optimistic removal race (F3-5d)', () => {
  let mocks: WindowMocks;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks = setupMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('suppresses staged-file:* and its paired memory row when notify + store update land same-tick', async () => {
    // 1. Seed a "staged-file present" state BEFORE mount so the hook picks
    // it up on its initial load. We emit the file via onStagedFilesChanged
    // after hooking in, to simulate an IPC broadcast.
    mocks.api.getStagedFiles.mockResolvedValue({
      files: [
        {
          id: 'race-sf',
          realPath: '/ws/memory/race.md',
          spaceName: 'Memory',
          spacePath: 'memory/race.md',
          sessionId: 'session-a',
          baseHash: 'h',
          summary: 'race',
          stagedAt: 500,
          sensitivity: 'high',
          toolUseId: 'paired',
        },
      ],
    });

    // 2. Mount + wait for first load to settle.
    const { result } = renderHook(() => usePendingApprovals());

    // Give the effect's async loadApprovals a tick.
    await flushAsync();

    // Sanity: before optimistic removal fires, the paired memory row is
    // visible (desktop parity — staged-memory rows DO appear in items here).
    expect(result.current.approvals.map((a) => a.id)).toContain('memory:paired');

    // 3. Same-tick race: notify suppression AND simulate a broadcast
    // arriving in the same task. The mapper must:
    //   - never emit `staged-file:*` (desktop option)
    //   - cascade-suppress `memory:paired` because it's staged + paired
    await act(async () => {
      notifyOptimisticRemoval('staged-file:race-sf');
      stagedFilesChangedHandler?.();
      await Promise.resolve();
    });

    const ids = result.current.approvals.map((a) => a.id);
    expect(ids).not.toContain('memory:paired'); // cascade suppression
    expect(ids.filter((id) => id.startsWith('staged-file:'))).toHaveLength(0);
  });

  // F3-1-residual: destination-only pairing — the staged file payload is
  // missing `toolUseId` entirely (older IPC payloads, or cases where the
  // main process couldn't link the write back to its request). Cascade must
  // still fire via the `pendingDestination === memoryApproval.filePath`
  // fallback path. Without the preload / hook / mapper forwarding added in
  // this residual item, `pendingDestination` would be dropped before
  // reaching the mapper and the paired memory row would linger on desktop.
  it('suppresses paired memory via destination fallback when staged file has no toolUseId', async () => {
    // Paired memory approval: staged=true, filePath matches the staged
    // file's pendingDestination. No toolUseId anywhere.
    mocks.memoryApi.getPendingApprovals.mockResolvedValue([
      {
        toolUseId: 'm-dest-only',
        originalTurnId: 'turn-1',
        originalSessionId: 'session-a',
        turnId: 'turn-1',
        sessionId: 'session-a',
        filePath: 'memory/dest-only.md',
        spaceName: 'Memory',
        summary: 'dest-only',
        content: '',
        timestamp: 600,
        staged: true,
      },
    ]);
    mocks.api.getStagedFiles.mockResolvedValue({
      files: [
        {
          id: 'sf-dest',
          realPath: '/ws/memory/dest-only.md',
          spaceName: 'Memory',
          spacePath: 'memory/dest-only.md',
          sessionId: 'session-a',
          baseHash: 'h',
          summary: 'dest-only',
          stagedAt: 600,
          sensitivity: 'high',
          // No toolUseId on the staged file — destination is the only link.
          pendingDestination: 'memory/dest-only.md',
        },
      ],
    });

    const { result } = renderHook(() => usePendingApprovals());
    await flushAsync();

    // Sanity: paired memory row is visible before suppression.
    expect(result.current.approvals.map((a) => a.id)).toContain('memory:m-dest-only');

    await act(async () => {
      notifyOptimisticRemoval('staged-file:sf-dest');
      stagedFilesChangedHandler?.();
      await Promise.resolve();
    });

    const ids = result.current.approvals.map((a) => a.id);
    expect(ids).not.toContain('memory:m-dest-only'); // destination-based cascade
    expect(ids.filter((id) => id.startsWith('staged-file:'))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Public-API / callback surface contract
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// F3-6: cross-surface parity fixtures — same inputs, assert that desktop and
// cloud modes produce *semantically consistent* output:
//   - Staged-tool + tool + plain memory rows appear in both.
//   - Cloud additionally surfaces `staged-file:*` rows.
//   - Cloud dedupes `memory:*` that is paired with a `staged-file:*` by id.
//   - Both modes respect `suppressedIds` uniformly.
// This catches accidental drift between the two callers of the shared mapper.
// ---------------------------------------------------------------------------

describe('useUnifiedApprovals × usePendingApprovals — cross-surface parity (F3-6)', () => {
  it.each(FIXTURES)('$name: desktop is a subset of cloud rows (minus staged-file + deduped memory)', (fixture) => {
    const desktop = deriveDesktopItems(fixture.inputs);
    const cloud = deriveCloudItems(fixture.inputs);

    const desktopIds = new Set(desktop.map((a) => a.id));
    const cloudIds = new Set(cloud.map((a) => a.id));

    // Cloud may include staged-file IDs; desktop must not.
    for (const id of desktopIds) {
      expect(id.startsWith('staged-file:')).toBe(false);
    }

    // Every non-staged-file, non-deduped-paired-memory desktop ID should be
    // present in cloud output.
    const cloudPairedMemoryIds = new Set(
      fixture.inputs.stagedFiles
        .map((sf) => sf.toolUseId)
        .filter((v): v is string => typeof v === 'string')
        .map((tuid) => `memory:${tuid}`),
    );
    for (const id of desktopIds) {
      if (cloudPairedMemoryIds.has(id)) {
        // Cloud dedupes this ID → absent on cloud side.
        expect(cloudIds.has(id)).toBe(false);
      } else {
        expect(cloudIds.has(id)).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// F3-6 (Round 3): shared parity fixtures — real hook mount
// ---------------------------------------------------------------------------
// The block above compares mapper outputs in the two modes (pure derivation).
// This block goes one level deeper: it uses the SAME shared fixtures as the
// cloud-client hook test, mocks the desktop IPC bridges from the fixture,
// mounts the real `usePendingApprovals` hook, and asserts `.approvals` match
// the fixture's `expectedDesktopIds`. That makes the fixture set a
// hook-vs-hook parity contract, not just a mapper-output one.
// ---------------------------------------------------------------------------

/** Seed the desktop IPC bridges so `usePendingApprovals` sees fixture inputs. */
function mockIpcFromFixture(fixture: ApprovalParityFixture): WindowMocks {
  const mocks = setupMocks();

  // Safety approvals: derived from ToolApprovalInput[] → live payload shape.
  mocks.safetyApi.pending.mockResolvedValue(
    fixture.inputs.toolApprovals.map((t) => ({
      toolUseID: t.toolUseID,
      turnId: t.turnId,
      sessionId: t.sessionId,
      toolName: t.toolName,
      input: t.input,
      reason: t.reason,
      timestamp: t.timestamp,
      riskLevel: t.riskLevel,
      packageName: t.packageName,
      conversationTitle: t.conversationTitle,
    })),
  );

  // Staged tool calls live on safetyApi.stagedGetAll.
  mocks.safetyApi.stagedGetAll.mockResolvedValue(fixture.inputs.stagedCalls);

  // Memory approvals go through memoryApi.getPendingApprovals.
  mocks.memoryApi.getPendingApprovals.mockResolvedValue(
    fixture.inputs.memoryApprovals.map((m) => ({
      toolUseId: m.toolUseId,
      originalTurnId: m.toolUseId, // fixtures don't carry this; stable stand-in
      originalSessionId: m.originalSessionId,
      turnId: m.toolUseId,
      sessionId: m.originalSessionId,
      filePath: m.filePath,
      spaceName: m.spaceName,
      summary: m.summary,
      content: m.content ?? '',
      timestamp: m.timestamp,
      location: m.location,
      staged: m.staged,
      blockedBy: m.blockedBy,
      sharing: m.sharing,
      contentPreview: m.contentPreview,
      authorLabel: m.authorLabel,
      approvalKind: m.approvalKind,
    })),
  );

  // Staged files come from api.getStagedFiles — include all the canonical
  // fields (toolUseId, pendingDestination) so the mapper's paired-memory
  // cascade actually fires end-to-end on desktop (F3-1-residual).
  mocks.api.getStagedFiles.mockResolvedValue({
    files: fixture.inputs.stagedFiles.map((f) => ({
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
    })),
  });

  // Session context surface: `sessionsApi.list` returns full session summary
  // rows; the hook builds its internal map from them. For fixtures that
  // carry context entries, fabricate the minimum summary shape.
  mocks.sessionsApi.list.mockResolvedValue(
    fixture.inputs.sessionContextEntries.map(([id, ctx]) => ({
      id,
      title: ctx.title ?? null,
      createdAt: 0,
      updatedAt: 0,
      resolvedAt: null,
      doneAt: null,
      starredAt: null,
      deletedAt: null,
      origin: 'manual' as const,
      isCorrupted: false,
      preview: '',
      messageCount: ctx.messageCount ?? 0,
      hasDraft: false,
      draftPreview: null,
      draftUpdatedAt: null,
      usage: { costUsd: 0, inputTokens: 0, outputTokens: 0, turnCount: 0 },
      activeTurnId: null,
      isBusy: false,
      lastError: null,
    })),
  );

  return mocks;
}

describe('usePendingApprovals — shared parity fixtures (F3-6)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(APPROVAL_PARITY_FIXTURES)(
    '$name — desktop hook emits expectedDesktopIds',
    async (fixture) => {
      mockIpcFromFixture(fixture);
      // Apply any fixture-level suppressedIds BEFORE mount so the first
      // render sees the suppression set (notifyOptimisticRemoval is a
      // module-level sink; calling it here seeds the same module-level
      // state the hook reads).
      if (fixture.desktopOptions.suppressedIds) {
        for (const id of fixture.desktopOptions.suppressedIds) {
          notifyOptimisticRemoval(id);
        }
      }

      const { result } = renderHook(() => usePendingApprovals());
      await flushAsync();

      expect(result.current.approvals.map((a) => a.id)).toEqual(
        fixture.expectedDesktopIds,
      );
    },
  );
});

describe('usePendingApprovals — public API contract', () => {
  it('UsePendingApprovalsReturn type exposes the expected callback keys', () => {
    const _stub = {
      approvals: [] as PendingApprovalItem[],
      isLoading: false,
      refresh: async () => undefined,
      removeApproval: () => undefined,
      dismissApproval: async () => true,
      saveApproval: async () => undefined,
      approveToolApproval: async () => ({ ok: true as const }),
      executeStagedApproval: async () => ({ ok: true as const }),
      batchApproveToolApprovals: async () => ({ total: 0, succeeded: 0, failed: 0, failures: [] }),
    } satisfies UsePendingApprovalsReturn;
    expect(Object.keys(_stub).sort()).toEqual(EXPECTED_HOOK_KEYS);
    const callbackKeys = [
      'refresh',
      'removeApproval',
      'dismissApproval',
      'saveApproval',
      'approveToolApproval',
      'executeStagedApproval',
      'batchApproveToolApprovals',
    ] as const;
    for (const key of callbackKeys) {
      expect(typeof _stub[key]).toBe('function');
    }
  });
});
