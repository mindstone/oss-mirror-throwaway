/**
 * Shared approval-parity fixtures (F3-6 Round-3).
 *
 * Single source of truth for cross-surface parity tests between the pure
 * `deriveUnifiedApprovals` mapper, the desktop `usePendingApprovals` hook,
 * and the cross-surface `useUnifiedApprovals` hook. Each fixture carries:
 *
 * 1. `inputs` — the raw canonical DTO shapes fed through the mapper.
 * 2. `desktopOptions` / `cloudOptions` — per-surface option overrides
 *    (desktop hides staged-file rows; cloud emits them with FM #16 dedup).
 * 3. `expectedDesktopIds` / `expectedCloudIds` — the deterministic composite
 *    ID order each surface should emit.
 *
 * Consumers:
 * - `packages/shared/src/__tests__/unifiedApprovalMapper.test.ts` — asserts
 *   the pure mapper emits the expected IDs under each surface's option set.
 * - `cloud-client/src/__tests__/useUnifiedApprovals.test.ts` — hydrates the
 *   Zustand stores from each fixture, mounts the hook, asserts cloud IDs.
 * - `src/renderer/features/inbox/hooks/__tests__/usePendingApprovals.contract.test.ts`
 *   — mocks the IPC bridges with each fixture's inputs, mounts the desktop
 *   hook, asserts desktop IDs.
 *
 * Philosophy: every fixture runs through BOTH real hook mounts, not just
 * mapper calls. This is what makes the block a genuine parity test rather
 * than two unrelated mapper assertions.
 */

import type {
  DeriveUnifiedApprovalsInputs,
  DeriveUnifiedApprovalsOptions,
  MemoryApprovalInput,
  SessionContextForApprovals,
  StagedFileInput,
  StagedToolCallInput,
  ToolApprovalInput,
} from '../unifiedApprovalMapper';
import type { FileLocation } from '../fileLocation';

/**
 * One parity case.
 *
 * The `inputs.sessionContext` is optional to keep fixture shorthand light;
 * consumers hydrate a `Map` before passing through.
 */
export interface ApprovalParityFixture {
  name: string;
  /** Raw DTO inputs. `sessionContext` is plain entries — consumers build the Map. */
  inputs: Omit<DeriveUnifiedApprovalsInputs, 'sessionContext'> & {
    sessionContextEntries: Array<[string, SessionContextForApprovals]>;
  };
  /** Desktop option overrides layered on top of desktop defaults below. */
  desktopOptions: Partial<DeriveUnifiedApprovalsOptions>;
  /** Cloud option overrides layered on top of cloud defaults below. */
  cloudOptions: Partial<DeriveUnifiedApprovalsOptions>;
  /** Expected composite IDs in order for the desktop surface. */
  expectedDesktopIds: string[];
  /** Expected composite IDs in order for the cloud surface. */
  expectedCloudIds: string[];
}

/**
 * Desktop parity defaults: staged-file rows are hidden inline (a dedicated
 * strip renders them), FM #16 dedup is off (the count hook handles it
 * separately). Matches `usePendingApprovals`' options.
 */
export const DESKTOP_PARITY_OPTIONS: DeriveUnifiedApprovalsOptions = {
  includeStagedFileItems: false,
  dedupStagedMemoryApprovals: false,
  excludeNonPendingStagedCalls: true,
};

/**
 * Cloud parity defaults: staged-file rows ARE emitted inline (mobile renders
 * them as first-class rows) and FM #16 dedup is on (drop the paired memory
 * row when a staged file exists). Matches `useUnifiedApprovals`' defaults.
 */
export const CLOUD_PARITY_OPTIONS: DeriveUnifiedApprovalsOptions = {
  includeStagedFileItems: true,
  dedupStagedMemoryApprovals: true,
  excludeNonPendingStagedCalls: true,
};

// ---------------------------------------------------------------------------
// Builder helpers (kept tiny; fixtures below are explicit and self-contained)
// ---------------------------------------------------------------------------

function tool(overrides: Partial<ToolApprovalInput>): ToolApprovalInput {
  return {
    toolUseID: overrides.toolUseID ?? 't',
    turnId: overrides.turnId ?? 'turn-1',
    sessionId: overrides.sessionId,
    toolName: overrides.toolName ?? 'Bash',
    input: overrides.input ?? { command: 'ls' },
    reason: overrides.reason,
    timestamp: overrides.timestamp ?? 1_000,
    riskLevel: overrides.riskLevel,
    packageName: overrides.packageName,
    conversationTitle: overrides.conversationTitle,
  };
}

function memory(overrides: Partial<MemoryApprovalInput>): MemoryApprovalInput {
  return {
    toolUseId: overrides.toolUseId ?? 'm',
    originalSessionId: overrides.originalSessionId ?? 'session-a',
    filePath: overrides.filePath ?? 'memory/note.md',
    spaceName: overrides.spaceName ?? 'Memory',
    location: overrides.location,
    summary: overrides.summary ?? 'note',
    content: overrides.content ?? '',
    timestamp: overrides.timestamp ?? 2_000,
    blockedBy: overrides.blockedBy,
    sharing: overrides.sharing,
    contentPreview: overrides.contentPreview,
    staged: overrides.staged,
    authorLabel: overrides.authorLabel,
    approvalKind: overrides.approvalKind,
  };
}

function stagedCall(overrides: Partial<StagedToolCallInput>): StagedToolCallInput {
  return {
    id: 'c',
    sessionId: 'session-a',
    turnId: 'turn-1',
    timestamp: 3_000,
    expiresAt: 4_000,
    status: 'pending',
    mcpPayload: { packageId: 'slack', toolId: 'post', args: {} },
    displayName: 'Send Slack message',
    toolCategory: 'side-effect',
    riskLevel: 'high',
    ...overrides,
  };
}

function stagedFile(overrides: Partial<StagedFileInput>): StagedFileInput {
  return {
    id: overrides.id ?? 'f',
    realPath: overrides.realPath ?? '/ws/memory/note.md',
    spaceName: overrides.spaceName ?? 'Memory',
    spacePath: overrides.spacePath ?? 'memory/note.md',
    location: overrides.location,
    sessionId: overrides.sessionId ?? 'session-a',
    baseHash: overrides.baseHash ?? 'hash',
    summary: overrides.summary ?? 'staged note',
    stagedAt: overrides.stagedAt ?? 4_000,
    sensitivity: 'high',
    sharing: overrides.sharing,
    blockedBy: overrides.blockedBy,
    hasConflict: overrides.hasConflict,
    approvalKind: overrides.approvalKind,
    authorLabel: overrides.authorLabel,
    toolUseId: overrides.toolUseId,
    destination: overrides.destination,
  };
}

function inSpaceLocation(overrides: Partial<Extract<FileLocation, { kind: 'in-space' }>> = {}): FileLocation {
  return {
    kind: 'in-space',
    spaceName: overrides.spaceName ?? 'Memory',
    spaceWorkspacePath: overrides.spaceWorkspacePath ?? 'Memory',
    spaceRelativePath: overrides.spaceRelativePath ?? 'notes.md',
    workspaceRelativePath: overrides.workspaceRelativePath ?? 'Memory/notes.md',
    fileName: overrides.fileName ?? 'notes.md',
    absolutePath: overrides.absolutePath ?? '/ws/Memory/notes.md',
  };
}

function outsideWorkspaceLocation(
  overrides: Partial<Extract<FileLocation, { kind: 'outside-workspace' }>> = {},
): FileLocation {
  return {
    kind: 'outside-workspace',
    absolutePath: overrides.absolutePath ?? '/tmp/notes.md',
    fileName: overrides.fileName ?? 'notes.md',
    outsideCategory: overrides.outsideCategory,
  };
}

function legacyLocation(
  overrides: Partial<Extract<FileLocation, { kind: 'legacy-missing-location' }>> = {},
): FileLocation {
  return {
    kind: 'legacy-missing-location',
    fileName: overrides.fileName ?? 'notes.md',
    spaceName: overrides.spaceName,
    legacyPath: overrides.legacyPath,
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

export const APPROVAL_PARITY_FIXTURES: ApprovalParityFixture[] = [
  {
    name: 'empty',
    inputs: {
      toolApprovals: [],
      memoryApprovals: [],
      stagedCalls: [],
      stagedFiles: [],
      sessionContextEntries: [],
    },
    desktopOptions: {},
    cloudOptions: {},
    expectedDesktopIds: [],
    expectedCloudIds: [],
  },
  {
    name: 'tool-and-memory-mixed',
    inputs: {
      toolApprovals: [
        tool({ toolUseID: 't-mix', sessionId: 'session-a', reason: 'r', timestamp: 100 }),
      ],
      memoryApprovals: [
        memory({ toolUseId: 'm-mix', originalSessionId: 'session-a', timestamp: 200 }),
      ],
      stagedCalls: [],
      stagedFiles: [],
      sessionContextEntries: [
        ['session-a', { title: 'Session A', messageCount: 1 }],
      ],
    },
    desktopOptions: {},
    cloudOptions: {},
    expectedDesktopIds: ['memory:m-mix', 'tool:t-mix'],
    expectedCloudIds: ['memory:m-mix', 'tool:t-mix'],
  },
  {
    // F3-6 staged-file-only (with pairing): staged file holds the canonical
    // entry; a matching `memoryApproval.staged === true` row is
    // informational-only. Desktop hides staged-file rows inline AND keeps the
    // memory row (count hook dedupes downstream). Cloud emits the staged file
    // and drops the paired memory row (FM #16 dedup).
    name: 'staged-file-only-with-pairing',
    inputs: {
      toolApprovals: [],
      memoryApprovals: [
        memory({
          toolUseId: 'sf-paired-tuid',
          staged: true,
          filePath: 'memory/paired.md',
          timestamp: 500,
        }),
      ],
      stagedCalls: [],
      stagedFiles: [
        stagedFile({
          id: 'sf-paired',
          toolUseId: 'sf-paired-tuid',
          spacePath: 'memory/paired.md',
          stagedAt: 510,
        }),
      ],
      sessionContextEntries: [],
    },
    desktopOptions: {},
    cloudOptions: {},
    // Desktop: memory stays, staged-file hidden → just the memory row.
    expectedDesktopIds: ['memory:sf-paired-tuid'],
    // Cloud: dedup fires → staged-file replaces the paired memory row.
    expectedCloudIds: ['staged-file:sf-paired'],
  },
  {
    name: 'staged-tool-only',
    inputs: {
      toolApprovals: [],
      memoryApprovals: [],
      stagedCalls: [
        stagedCall({ id: 's-only', sessionId: 'session-c', timestamp: 300 }),
      ],
      stagedFiles: [],
      sessionContextEntries: [
        ['session-c', { title: 'Team update', messageCount: 1 }],
      ],
    },
    desktopOptions: {},
    cloudOptions: {},
    expectedDesktopIds: ['staged-tool:s-only'],
    expectedCloudIds: ['staged-tool:s-only'],
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
          timestamp: 301,
          riskLevel: undefined,
        }),
      ],
      stagedFiles: [],
      sessionContextEntries: [
        ['session-c', { title: 'Team update', messageCount: 1 }],
      ],
    },
    desktopOptions: {},
    cloudOptions: {},
    expectedDesktopIds: ['staged-tool:s-missing-risk'],
    expectedCloudIds: ['staged-tool:s-missing-risk'],
  },
  {
    // Multiple tool approvals sharing a session id — the "continuation group"
    // scenario downstream consumers care about (ordering preserved).
    name: 'continuation-group',
    inputs: {
      toolApprovals: [
        tool({ toolUseID: 't-a', sessionId: 'session-g', reason: 'A', timestamp: 100 }),
        tool({ toolUseID: 't-b', sessionId: 'session-g', reason: 'B', timestamp: 200 }),
      ],
      memoryApprovals: [],
      stagedCalls: [],
      stagedFiles: [],
      sessionContextEntries: [
        ['session-g', { title: 'Group session', messageCount: 2 }],
      ],
    },
    desktopOptions: {},
    cloudOptions: {},
    expectedDesktopIds: ['tool:t-b', 'tool:t-a'],
    expectedCloudIds: ['tool:t-b', 'tool:t-a'],
  },
  {
    name: 'safety-block-with-reason',
    inputs: {
      toolApprovals: [
        tool({
          toolUseID: 't-safety',
          reason: 'Safety Rules blocked: shell can delete files',
          timestamp: 500,
        }),
      ],
      memoryApprovals: [],
      stagedCalls: [],
      stagedFiles: [],
      sessionContextEntries: [],
    },
    desktopOptions: {},
    cloudOptions: {},
    expectedDesktopIds: ['tool:t-safety'],
    expectedCloudIds: ['tool:t-safety'],
  },
  {
    // Many staged calls in a batch — same session — smoke test ordering.
    name: 'with-batch-pending',
    inputs: {
      toolApprovals: [],
      memoryApprovals: [],
      stagedCalls: [0, 1, 2, 3, 4].map((i) =>
        stagedCall({
          id: `batch-${i}`,
          sessionId: 'session-batch',
          timestamp: 100 + i,
        }),
      ),
      stagedFiles: [],
      sessionContextEntries: [
        ['session-batch', { title: 'Batch', messageCount: 0 }],
      ],
    },
    desktopOptions: {},
    cloudOptions: {},
    expectedDesktopIds: [
      'staged-tool:batch-4',
      'staged-tool:batch-3',
      'staged-tool:batch-2',
      'staged-tool:batch-1',
      'staged-tool:batch-0',
    ],
    expectedCloudIds: [
      'staged-tool:batch-4',
      'staged-tool:batch-3',
      'staged-tool:batch-2',
      'staged-tool:batch-1',
      'staged-tool:batch-0',
    ],
  },
  {
    name: 'location-dedup-in-space',
    inputs: {
      toolApprovals: [],
      memoryApprovals: [
        memory({
          toolUseId: 'loc-in-space',
          staged: true,
          filePath: '/absolute/legacy-memory.md',
          location: inSpaceLocation({
            spaceName: 'General',
            spaceWorkspacePath: 'General',
            spaceRelativePath: 'skills/workflows/demo/SKILL.md',
            workspaceRelativePath: 'General/skills/workflows/demo/SKILL.md',
            fileName: 'SKILL.md',
            absolutePath: '/ws/General/skills/workflows/demo/SKILL.md',
          }),
          timestamp: 700,
        }),
      ],
      stagedCalls: [],
      stagedFiles: [
        stagedFile({
          id: 'loc-in-space-file',
          toolUseId: undefined,
          spacePath: 'legacy/staged-path.md',
          destination: undefined,
          location: inSpaceLocation({
            spaceName: 'General',
            spaceWorkspacePath: 'General',
            spaceRelativePath: 'skills/workflows/demo/SKILL.md',
            workspaceRelativePath: 'General/skills/workflows/demo/SKILL.md',
            fileName: 'SKILL.md',
            absolutePath: '/ws/General/skills/workflows/demo/SKILL.md',
          }),
          stagedAt: 710,
        }),
      ],
      sessionContextEntries: [],
    },
    desktopOptions: {},
    cloudOptions: {},
    expectedDesktopIds: ['memory:loc-in-space'],
    expectedCloudIds: ['staged-file:loc-in-space-file'],
  },
  {
    name: 'location-dedup-outside-workspace',
    inputs: {
      toolApprovals: [],
      memoryApprovals: [
        memory({
          toolUseId: 'loc-outside',
          staged: true,
          filePath: 'Outside workspace/mismatch.md',
          location: outsideWorkspaceLocation({
            absolutePath: '/tmp/rebel/demo/report.md',
            fileName: 'report.md',
          }),
          timestamp: 720,
        }),
      ],
      stagedCalls: [],
      stagedFiles: [
        stagedFile({
          id: 'loc-outside-file',
          toolUseId: undefined,
          realPath: '/another/path/report.md',
          spacePath: 'another/mismatch.md',
          location: outsideWorkspaceLocation({
            absolutePath: '/tmp/rebel/demo/report.md',
            fileName: 'report.md',
          }),
          stagedAt: 730,
        }),
      ],
      sessionContextEntries: [],
    },
    desktopOptions: {},
    cloudOptions: {},
    expectedDesktopIds: ['memory:loc-outside'],
    expectedCloudIds: ['staged-file:loc-outside-file'],
  },
  {
    name: 'location-dedup-legacy-missing',
    inputs: {
      toolApprovals: [],
      memoryApprovals: [
        memory({
          toolUseId: 'loc-legacy',
          staged: true,
          filePath: 'General/legacy/fallback.md',
          location: legacyLocation({
            fileName: 'fallback.md',
            spaceName: 'General',
            legacyPath: 'General/legacy/fallback.md',
          }),
          timestamp: 740,
        }),
      ],
      stagedCalls: [],
      stagedFiles: [
        stagedFile({
          id: 'loc-legacy-file',
          toolUseId: undefined,
          realPath: '/mismatch/path/fallback.md',
          spacePath: 'General/other.md',
          location: legacyLocation({
            fileName: 'fallback.md',
            spaceName: 'General',
            legacyPath: 'General/legacy/fallback.md',
          }),
          stagedAt: 750,
        }),
      ],
      sessionContextEntries: [],
    },
    desktopOptions: {},
    cloudOptions: {},
    expectedDesktopIds: ['memory:loc-legacy'],
    expectedCloudIds: ['staged-file:loc-legacy-file'],
  },
  {
    // Optimistic removal of a staged file must cascade to its paired
    // staged-memory approval. Desktop shows nothing; cloud shows nothing.
    name: 'with-optimistic-removal-of-staged-file',
    inputs: {
      toolApprovals: [],
      memoryApprovals: [
        memory({
          toolUseId: 'opt-paired',
          staged: true,
          filePath: 'memory/opt.md',
          timestamp: 600,
        }),
      ],
      stagedCalls: [],
      stagedFiles: [
        stagedFile({
          id: 'opt-sf',
          toolUseId: 'opt-paired',
          spacePath: 'memory/opt.md',
          stagedAt: 610,
        }),
      ],
      sessionContextEntries: [],
    },
    desktopOptions: {
      suppressedIds: new Set(['staged-file:opt-sf']),
    },
    cloudOptions: {
      suppressedIds: new Set(['staged-file:opt-sf']),
    },
    expectedDesktopIds: [],
    expectedCloudIds: [],
  },
];
