import { describe, expect, it } from 'vitest';
import {
  deriveUnifiedApprovals,
  type DeriveUnifiedApprovalsInputs,
  type DeriveUnifiedApprovalsOptions,
  type MemoryApprovalInput,
  type SessionContextForApprovals,
  type StagedFileInput,
  type StagedToolCallInput,
  type ToolApprovalInput,
  type ToolApprovalSummary,
  type UnifiedApproval,
} from '../unifiedApprovalMapper';
import { isGenericReason } from '../approvalUtils';
import {
  APPROVAL_PARITY_FIXTURES,
  CLOUD_PARITY_OPTIONS,
  DESKTOP_PARITY_OPTIONS,
} from '../testFixtures/approvalParityFixtures';

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

const ctx = (
  entries: Array<[string, Partial<SessionContextForApprovals> & { title: string }]> = [],
): ReadonlyMap<string, SessionContextForApprovals> => {
  const map = new Map<string, SessionContextForApprovals>();
  for (const [id, partial] of entries) {
    map.set(id, {
      title: partial.title,
      firstMessagePreview: partial.firstMessagePreview,
      lastMessagePreview: partial.lastMessagePreview,
      messageCount: partial.messageCount ?? 0,
      sessionStartedAt: partial.sessionStartedAt,
      lastUpdatedAt: partial.lastUpdatedAt,
    });
  }
  return map;
};

const tool = (overrides: Partial<ToolApprovalInput> = {}): ToolApprovalInput => ({
  toolUseID: overrides.toolUseID ?? 'tool-1',
  turnId: overrides.turnId ?? 'turn-1',
  sessionId: overrides.sessionId,
  toolName: overrides.toolName ?? 'Bash',
  input: overrides.input ?? { command: 'echo hello' },
  reason: overrides.reason,
  timestamp: overrides.timestamp ?? 1_700_000_000_000,
  allowPermanentTrust: overrides.allowPermanentTrust,
  effectiveToolId: overrides.effectiveToolId,
  riskLevel: overrides.riskLevel,
  packageName: overrides.packageName,
  conversationTitle: overrides.conversationTitle,
});

const memory = (overrides: Partial<MemoryApprovalInput> = {}): MemoryApprovalInput => ({
  toolUseId: overrides.toolUseId ?? 'mem-1',
  originalSessionId: overrides.originalSessionId ?? 'session-a',
  filePath: overrides.filePath ?? 'memory/inbox/note.md',
  spaceName: overrides.spaceName ?? 'Memory',
  location: overrides.location,
  summary: overrides.summary ?? 'New note',
  content: overrides.content,
  timestamp: overrides.timestamp ?? 1_700_000_001_000,
  sensitivityReason: overrides.sensitivityReason,
  hasSpaceOverride: overrides.hasSpaceOverride,
  privateMode: overrides.privateMode,
  blockedBy: overrides.blockedBy,
  spacePath: overrides.spacePath,
  sharing: overrides.sharing,
  contentPreview: overrides.contentPreview,
  approvalIdentifier: overrides.approvalIdentifier,
  approvalKind: overrides.approvalKind,
  authorLabel: overrides.authorLabel,
  staged: overrides.staged,
});

const stagedCall = (overrides: Partial<StagedToolCallInput> = {}): StagedToolCallInput => ({
  id: overrides.id ?? 'staged-1',
  sessionId: overrides.sessionId ?? 'session-a',
  turnId: overrides.turnId ?? 'turn-1',
  timestamp: overrides.timestamp ?? 1_700_000_002_000,
  expiresAt: overrides.expiresAt ?? 1_800_000_000_000,
  status: overrides.status ?? 'pending',
  mcpPayload: overrides.mcpPayload ?? {
    packageId: 'gmail',
    toolId: 'send',
    args: { to: 'a@example.com' },
  },
  displayName: overrides.displayName ?? 'Send email',
  toolCategory: overrides.toolCategory ?? 'side-effect',
  riskLevel: overrides.riskLevel ?? 'high',
  reason: overrides.reason,
  allowPermanentTrust: overrides.allowPermanentTrust,
  blockedBy: overrides.blockedBy,
  automationId: overrides.automationId,
  automationName: overrides.automationName,
  result: overrides.result,
});

const stagedFile = (overrides: Partial<StagedFileInput> = {}): StagedFileInput => ({
  id: overrides.id ?? 'sf-1',
  realPath: overrides.realPath ?? '/workspace/memory/inbox/note.md',
  spaceName: overrides.spaceName ?? 'Memory',
  spacePath: overrides.spacePath ?? 'memory/inbox/note.md',
  location: overrides.location,
  sessionId: overrides.sessionId ?? 'session-a',
  baseHash: overrides.baseHash ?? 'hash-1',
  summary: overrides.summary ?? 'Staged note',
  stagedAt: overrides.stagedAt ?? 1_700_000_003_000,
  sensitivity: 'high',
  sharing: overrides.sharing,
  blockedBy: overrides.blockedBy,
  hasConflict: overrides.hasConflict,
  approvalKind: overrides.approvalKind,
  authorLabel: overrides.authorLabel,
  toolUseId: overrides.toolUseId,
  destination: overrides.destination,
});

const summaries = (entries: Array<[string, ToolApprovalSummary]> = []): ReadonlyMap<string, ToolApprovalSummary> => {
  const map = new Map<string, ToolApprovalSummary>();
  for (const [id, summary] of entries) map.set(id, summary);
  return map;
};

function run(
  inputs: Partial<DeriveUnifiedApprovalsInputs> = {},
  options: DeriveUnifiedApprovalsOptions = {},
): UnifiedApproval[] {
  return deriveUnifiedApprovals(
    {
      toolApprovals: inputs.toolApprovals ?? [],
      memoryApprovals: inputs.memoryApprovals ?? [],
      stagedCalls: inputs.stagedCalls ?? [],
      stagedFiles: inputs.stagedFiles ?? [],
      sessionContext: inputs.sessionContext ?? ctx(),
      toolSummaries: inputs.toolSummaries,
    },
    options,
  );
}

// ---------------------------------------------------------------------------
// 1. Baseline / empty states
// ---------------------------------------------------------------------------

describe('deriveUnifiedApprovals — baseline', () => {
  it('1.1 returns empty array when all inputs are empty', () => {
    expect(run()).toEqual([]);
  });

  it('1.2 returns empty array when only staged-files exist and includeStagedFileItems=false', () => {
    const items = run({ stagedFiles: [stagedFile()] });
    expect(items).toEqual([]);
  });

  it('1.3 emits a single staged-file row when includeStagedFileItems=true', () => {
    const items = run({ stagedFiles: [stagedFile()] }, { includeStagedFileItems: true });
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('staged-file');
    expect(items[0].id).toBe('staged-file:sf-1');
  });
});

// ---------------------------------------------------------------------------
// 2. Tool approvals
// ---------------------------------------------------------------------------

describe('deriveUnifiedApprovals — tool approvals', () => {
  it('2.1 maps a minimal tool approval with all required fields', () => {
    const items = run({ toolApprovals: [tool()] });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: 'tool:tool-1',
      kind: 'tool',
      title: 'Background task',
      sessionId: null,
      toolApproval: {
        toolUseID: 'tool-1',
        turnId: 'turn-1',
        toolName: 'Bash',
        input: { command: 'echo hello' },
      },
    });
  });

  it('2.2 resolves session title from context map when sessionId is present', () => {
    const items = run({
      toolApprovals: [tool({ sessionId: 'session-a' })],
      sessionContext: ctx([['session-a', { title: 'Planning session' }]]),
    });
    expect(items[0].title).toBe('Planning session');
    expect(items[0].sessionContext?.title).toBe('Planning session');
    expect(items[0].sessionId).toBe('session-a');
  });

  it('2.3 preserves reason when it is not generic', () => {
    const items = run({
      toolApprovals: [tool({ reason: 'Triggers remote send' })],
    });
    expect(items[0].description).toBe('Triggers remote send');
  });

  it('2.4 strips "Safety Rules blocked:" prefix from reason', () => {
    const items = run({
      toolApprovals: [tool({ reason: 'Safety Rules blocked: email is risky' })],
    });
    expect(items[0].description).toBe('email is risky');
  });

  it('2.5 falls back to tool summary when reason is generic', () => {
    const items = run(
      {
        toolApprovals: [tool({ reason: 'too-generic' })],
        toolSummaries: summaries([['tool-1', { label: 'Run npm test', detail: 'in /repo' }]]),
      },
      { isGenericReason: (r) => r === 'too-generic' },
    );
    expect(items[0].description).toBe('Run npm test: in /repo');
  });

  it('2.6 falls back to tool summary label only when detail is missing', () => {
    const items = run({
      toolApprovals: [tool({ reason: undefined })],
      toolSummaries: summaries([['tool-1', { label: 'Send an email' }]]),
    });
    expect(items[0].description).toBe('Send an email');
  });

  it('2.7 returns empty description when neither reason nor summary are supplied', () => {
    const items = run({ toolApprovals: [tool({ reason: undefined })] });
    expect(items[0].description).toBe('');
  });

  it('2.10 falls back to tool summary when reason is eval-unavailable (current copy, REBEL-5G8 follow-up)', () => {
    const items = run(
      {
        toolApprovals: [tool({ reason: "Safety Rules blocked: Rebel can't complete the safety check (provider error). This often clears on its own — if it keeps happening, restart Rebel or raise a bug and we'll look into it." })],
        toolSummaries: summaries([['tool-1', { label: 'Run bash', detail: 'npm test' }]]),
      },
      { isGenericReason },
    );
    expect(items[0].description).toBe('Run bash: npm test');
  });

  it('2.10b falls back to tool summary when reason is eval-unavailable (legacy copy, REBEL-147 back-compat)', () => {
    const items = run(
      {
        toolApprovals: [tool({ reason: 'Safety Rules blocked: Safety evaluation unavailable — please try again or approve one-time' })],
        toolSummaries: summaries([['tool-1', { label: 'Run bash', detail: 'npm test' }]]),
      },
      { isGenericReason },
    );
    expect(items[0].description).toBe('Run bash: npm test');
  });

  it('2.8 passes through riskLevel, packageName, conversationTitle, and effectiveToolId', () => {
    const items = run({
      toolApprovals: [
        tool({
          riskLevel: 'high',
          packageName: 'Gmail',
          conversationTitle: 'Meeting follow-up',
          effectiveToolId: 'real_tool_id',
        }),
      ],
    });
    expect(items[0].riskLevel).toBe('high');
    expect(items[0].packageName).toBe('Gmail');
    expect(items[0].conversationTitle).toBe('Meeting follow-up');
    expect(items[0].toolApproval?.effectiveToolId).toBe('real_tool_id');
  });

  it('2.9 coerces an unknown riskLevel string to undefined', () => {
    // Defense-in-depth: tool approvals sometimes arrive with null/extra fields
    // from historical payloads; the mapper narrows to the canonical enum.
    const items = run({ toolApprovals: [tool({ riskLevel: 'critical' as unknown as 'high' })] });
    expect(items[0].riskLevel).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3. Memory approvals
// ---------------------------------------------------------------------------

describe('deriveUnifiedApprovals — memory approvals', () => {
  it('3.1 maps a minimal memory approval', () => {
    const items = run({ memoryApprovals: [memory()] });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: 'memory:mem-1',
      kind: 'memory',
      sessionId: 'session-a',
      memoryApproval: {
        toolUseId: 'mem-1',
        filePath: 'memory/inbox/note.md',
      },
    });
  });

  it('3.2 synthesises description from spaceName + summary', () => {
    const items = run({
      memoryApprovals: [memory({ spaceName: 'Strategy', summary: 'Q1 plans' })],
    });
    expect(items[0].description).toBe('Wants to save to "Strategy": Q1 plans');
  });

  it('3.3 omits summary from description when missing', () => {
    const items = run({
      memoryApprovals: [memory({ spaceName: 'Strategy', summary: '' })],
    });
    expect(items[0].description).toBe('Wants to save to "Strategy"');
  });

  it('3.4 enriches "Outside workspace" with parent folder', () => {
    const items = run({
      memoryApprovals: [
        memory({ spaceName: 'Outside workspace', filePath: '/Users/me/Desktop/report.md', summary: '' }),
      ],
    });
    expect(items[0].description).toBe('Wants to save to "Outside workspace \u2014 Desktop"');
  });

  it('3.5 leaves "Outside workspace" unchanged when the path has no parent', () => {
    const items = run({
      memoryApprovals: [
        memory({ spaceName: 'Outside workspace', filePath: 'standalone.md', summary: '' }),
      ],
    });
    expect(items[0].description).toBe('Wants to save to "Outside workspace"');
  });

  it('3.6 normalises Windows-style paths when enriching destination', () => {
    const items = run({
      memoryApprovals: [
        memory({ spaceName: 'Outside workspace', filePath: 'C:\\Users\\me\\Docs\\file.md', summary: '' }),
      ],
    });
    expect(items[0].description).toBe('Wants to save to "Outside workspace \u2014 Docs"');
  });

  it('3.7 narrows blockedBy to the canonical enum or undefined', () => {
    const items = run({
      memoryApprovals: [memory({ blockedBy: 'safety_prompt' })],
    });
    expect(items[0].memoryApproval?.blockedBy).toBe('safety_prompt');
    const items2 = run({
      memoryApprovals: [memory({ blockedBy: 'bogus_value' })],
    });
    expect(items2[0].memoryApproval?.blockedBy).toBeUndefined();
  });

  it('3.8 narrows sharing and approvalKind to their canonical enums', () => {
    const items = run({
      memoryApprovals: [memory({ sharing: 'private', approvalKind: 'shared_skill_checkpoint' })],
    });
    expect(items[0].memoryApproval?.sharing).toBe('private');
    expect(items[0].memoryApproval?.approvalKind).toBe('shared_skill_checkpoint');

    const items2 = run({
      memoryApprovals: [memory({ sharing: 'unknown', approvalKind: 'weird' })],
    });
    expect(items2[0].memoryApproval?.sharing).toBeUndefined();
    expect(items2[0].memoryApproval?.approvalKind).toBeUndefined();
  });

  it('3.9 defaults content to empty string when omitted', () => {
    const items = run({ memoryApprovals: [memory({ content: undefined })] });
    expect(items[0].memoryApproval?.content).toBe('');
  });

  it('3.10 passes through staged flag verbatim', () => {
    const items = run({ memoryApprovals: [memory({ staged: true })] });
    expect(items[0].memoryApproval?.staged).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Staged tool calls
// ---------------------------------------------------------------------------

describe('deriveUnifiedApprovals — staged tool calls', () => {
  it('4.1 maps a pending staged call with defaults', () => {
    const items = run({ stagedCalls: [stagedCall()] });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: 'staged-tool:staged-1',
      kind: 'staged-tool',
      riskLevel: 'high',
      packageName: 'gmail',
      stagedToolCall: { id: 'staged-1', displayName: 'Send email' },
    });
  });

  it('4.2 excludes non-pending staged calls by default', () => {
    const items = run({ stagedCalls: [stagedCall({ status: 'executed' })] });
    expect(items).toHaveLength(0);
  });

  it('4.3 includes non-pending staged calls when excludeNonPendingStagedCalls=false', () => {
    const items = run(
      { stagedCalls: [stagedCall({ status: 'failed' })] },
      { excludeNonPendingStagedCalls: false },
    );
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('staged-tool:staged-1');
  });

  it('4.4 prefers automationName over session title for the title', () => {
    const items = run({
      stagedCalls: [stagedCall({ automationName: 'Wins & Learnings' })],
      sessionContext: ctx([['session-a', { title: 'Meeting prep' }]]),
    });
    expect(items[0].title).toBe('Wins & Learnings');
  });

  it('4.5 uses displayName when reason is generic', () => {
    const items = run(
      {
        stagedCalls: [stagedCall({ reason: 'part of your task' })],
      },
      { isGenericReason: (r) => r === 'part of your task' },
    );
    expect(items[0].description).toBe('Send email');
  });

  it('4.6 uses reason verbatim when non-generic', () => {
    const items = run({ stagedCalls: [stagedCall({ reason: 'Needs consent' })] });
    expect(items[0].description).toBe('Needs consent');
  });

  it('4.7 leaves riskLevel undefined when payload value is unknown', () => {
    const items = run({
      stagedCalls: [stagedCall({ riskLevel: 'catastrophic' as unknown as 'high' })],
    });
    expect(items[0].riskLevel).toBeUndefined();
    expect(items[0].stagedToolCall?.riskLevel).toBeUndefined();
  });

  it('4.8 preserves eval_error trust metadata for staged calls', () => {
    const items = run({
      stagedCalls: [
        stagedCall({
          blockedBy: 'eval_error',
          allowPermanentTrust: false,
        }),
      ],
    });
    expect(items[0].stagedToolCall?.blockedBy).toBe('eval_error');
    expect(items[0].stagedToolCall?.allowPermanentTrust).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. Staged files
// ---------------------------------------------------------------------------

describe('deriveUnifiedApprovals — staged files', () => {
  it('5.1 hides staged files by default (desktop parity)', () => {
    const items = run({ stagedFiles: [stagedFile()] });
    expect(items).toEqual([]);
  });

  it('5.2 emits staged files when includeStagedFileItems=true', () => {
    const items = run(
      { stagedFiles: [stagedFile({ summary: 'Summary', stagedAt: 42 })] },
      { includeStagedFileItems: true },
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: 'staged-file:sf-1',
      kind: 'staged-file',
      description: 'Wants to save to "Memory": Summary',
      timestamp: 42,
    });
  });

  it('5.3 uses "Memory" fallback for empty spaceName', () => {
    const items = run(
      { stagedFiles: [stagedFile({ spaceName: '' })] },
      { includeStagedFileItems: true },
    );
    expect(items[0].description).toBe('Wants to save to "Memory": Staged note');
  });
});

// ---------------------------------------------------------------------------
// 6. Sorting
// ---------------------------------------------------------------------------

describe('deriveUnifiedApprovals — sort order', () => {
  it('6.1 sorts mixed kinds by timestamp descending (most recent first)', () => {
    const items = run(
      {
        toolApprovals: [tool({ toolUseID: 't-old', timestamp: 100 })],
        memoryApprovals: [memory({ toolUseId: 'm-new', timestamp: 500 })],
        stagedCalls: [stagedCall({ id: 's-mid', timestamp: 300 })],
        stagedFiles: [stagedFile({ id: 'f-newest', stagedAt: 700 })],
      },
      { includeStagedFileItems: true },
    );
    expect(items.map((i) => i.id)).toEqual([
      'staged-file:f-newest',
      'memory:m-new',
      'staged-tool:s-mid',
      'tool:t-old',
    ]);
  });

  it('6.2 preserves relative insertion order when timestamps are identical', () => {
    const items = run({
      toolApprovals: [tool({ toolUseID: 't-a', timestamp: 100 }), tool({ toolUseID: 't-b', timestamp: 100 })],
    });
    // Stable sort: insertion order preserved on tie.
    expect(items.map((i) => i.id)).toEqual(['tool:t-a', 'tool:t-b']);
  });
});

// ---------------------------------------------------------------------------
// 7. Optimistic suppression (suppressedIds)
// ---------------------------------------------------------------------------

describe('deriveUnifiedApprovals — optimistic suppression', () => {
  it('7.1 suppresses a tool row whose id is in suppressedIds', () => {
    const items = run(
      { toolApprovals: [tool({ toolUseID: 't-1' })] },
      { suppressedIds: new Set(['tool:t-1']) },
    );
    expect(items).toHaveLength(0);
  });

  it('7.2 suppresses a memory row whose id is in suppressedIds', () => {
    const items = run(
      { memoryApprovals: [memory({ toolUseId: 'm-1' })] },
      { suppressedIds: new Set(['memory:m-1']) },
    );
    expect(items).toHaveLength(0);
  });

  it('7.3 suppresses a staged-tool row whose id is in suppressedIds', () => {
    const items = run(
      { stagedCalls: [stagedCall({ id: 'c-1' })] },
      { suppressedIds: new Set(['staged-tool:c-1']) },
    );
    expect(items).toHaveLength(0);
  });

  it('7.4 suppresses a staged-file row whose id is in suppressedIds', () => {
    const items = run(
      { stagedFiles: [stagedFile({ id: 'f-1' })] },
      { suppressedIds: new Set(['staged-file:f-1']), includeStagedFileItems: true },
    );
    expect(items).toHaveLength(0);
  });

  it('7.5 cascades staged-file suppression to its paired staged memory approval by toolUseId (F3-2)', () => {
    // Cascade requires BOTH: suppressed staged-file ID AND the paired memory
    // approval being itself a staged one (non-staged memory rows remain
    // visible — see 7.7).
    const items = run(
      {
        memoryApprovals: [memory({ toolUseId: 'paired', staged: true })],
        stagedFiles: [stagedFile({ id: 'sf-paired', toolUseId: 'paired' })],
      },
      { suppressedIds: new Set(['staged-file:sf-paired']), includeStagedFileItems: true },
    );
    expect(items).toHaveLength(0);
  });

  it('7.6 does NOT cascade when staged file has no toolUseId link and no destination match', () => {
    const items = run(
      {
        memoryApprovals: [memory({ toolUseId: 'standalone', staged: true, filePath: 'memory/unrelated.md' })],
        stagedFiles: [stagedFile({ id: 'sf-unlinked' })],
      },
      { suppressedIds: new Set(['staged-file:sf-unlinked']), includeStagedFileItems: true },
    );
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('memory:standalone');
  });

  it('7.7 does NOT cascade to non-staged memory even when toolUseId matches (F3-2)', () => {
    // A non-staged memory approval is an independent record; staged-file
    // suppression must not sweep it out just because ids happen to match.
    const items = run(
      {
        memoryApprovals: [memory({ toolUseId: 'paired', staged: false })],
        stagedFiles: [stagedFile({ id: 'sf-paired', toolUseId: 'paired' })],
      },
      { suppressedIds: new Set(['staged-file:sf-paired']), includeStagedFileItems: true },
    );
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('memory:paired');
  });

  it('7.8 cascades by destination match when toolUseId is missing (F3-2)', () => {
    const items = run(
      {
        memoryApprovals: [
          memory({ toolUseId: 'm-by-dest', staged: true, filePath: 'memory/note.md' }),
        ],
        stagedFiles: [
          stagedFile({
            id: 'sf-by-dest',
            toolUseId: undefined,
            spacePath: 'memory/note.md',
          }),
        ],
      },
      { suppressedIds: new Set(['staged-file:sf-by-dest']), includeStagedFileItems: true },
    );
    expect(items).toHaveLength(0);
  });

  it('7.9 prefers explicit pendingDestination over spacePath when cascading by destination (F3-2)', () => {
    // Mirrors cloud-client forwarding pendingDestination from the IPC payload;
    // the mapper must use that as the dedup key ahead of fallback paths.
    const items = run(
      {
        memoryApprovals: [
          memory({ toolUseId: 'm-pending', staged: true, filePath: 'memory/final.md' }),
        ],
        stagedFiles: [
          stagedFile({
            id: 'sf-pending',
            toolUseId: undefined,
            spacePath: 'memory/original.md',
            destination: 'memory/final.md',
          }),
        ],
      },
      { suppressedIds: new Set(['staged-file:sf-pending']), includeStagedFileItems: true },
    );
    expect(items).toHaveLength(0);
  });

  it('7.10 does NOT cascade by destination to non-staged memory approvals (F3-2)', () => {
    const items = run(
      {
        memoryApprovals: [
          memory({ toolUseId: 'm-visible', staged: false, filePath: 'memory/note.md' }),
        ],
        stagedFiles: [
          stagedFile({ id: 'sf-dest', toolUseId: undefined, spacePath: 'memory/note.md' }),
        ],
      },
      { suppressedIds: new Set(['staged-file:sf-dest']), includeStagedFileItems: true },
    );
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('memory:m-visible');
  });
});

// ---------------------------------------------------------------------------
// 8. FM #16 dedup
// ---------------------------------------------------------------------------

describe('deriveUnifiedApprovals — staged/memory dedup (FM #16)', () => {
  it('8.1 keeps staged-memory rows by default (desktop parity)', () => {
    const items = run({
      memoryApprovals: [memory({ toolUseId: 'shared', staged: true })],
      stagedFiles: [stagedFile({ toolUseId: 'shared' })],
    });
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('memory:shared');
  });

  it('8.2 drops staged-memory rows when dedupStagedMemoryApprovals=true + matching toolUseId', () => {
    const items = run(
      {
        memoryApprovals: [memory({ toolUseId: 'shared', staged: true })],
        stagedFiles: [stagedFile({ toolUseId: 'shared' })],
      },
      { dedupStagedMemoryApprovals: true },
    );
    expect(items).toHaveLength(0);
  });

  it('8.3 drops staged-memory rows via destination-path match when toolUseId absent', () => {
    const items = run(
      {
        memoryApprovals: [memory({ toolUseId: 'no-match', staged: true, filePath: 'memory/note.md' })],
        stagedFiles: [stagedFile({ spacePath: 'memory/note.md' })],
      },
      { dedupStagedMemoryApprovals: true },
    );
    expect(items).toHaveLength(0);
  });

  it('8.4 keeps staged-memory rows when no matching staged file exists', () => {
    const items = run(
      {
        memoryApprovals: [memory({ toolUseId: 'no-pair', staged: true, filePath: 'memory/orphan.md' })],
        stagedFiles: [stagedFile({ toolUseId: 'other', spacePath: 'memory/other.md' })],
      },
      { dedupStagedMemoryApprovals: true },
    );
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('memory:no-pair');
  });

  it('8.5 never filters memory rows whose staged flag is not true', () => {
    const items = run(
      {
        memoryApprovals: [memory({ toolUseId: 'live', staged: false })],
        stagedFiles: [stagedFile({ toolUseId: 'live' })],
      },
      { dedupStagedMemoryApprovals: true },
    );
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('memory:live');
  });

  it('8.6 prefers location-based dedup keys and falls back for outside + legacy variants', () => {
    const inSpaceItems = run(
      {
        memoryApprovals: [
          memory({
            toolUseId: 'loc-in-space',
            staged: true,
            filePath: '/legacy/memory.md',
            location: {
              kind: 'in-space',
              spaceName: 'General',
              spaceWorkspacePath: 'General',
              spaceRelativePath: 'skills/demo/SKILL.md',
              workspaceRelativePath: 'General/skills/demo/SKILL.md',
              fileName: 'SKILL.md',
              absolutePath: '/ws/General/skills/demo/SKILL.md',
            },
          }),
        ],
        stagedFiles: [
          stagedFile({
            id: 'loc-in-space-file',
            toolUseId: undefined,
            spacePath: 'legacy/staged.md',
            destination: undefined,
            location: {
              kind: 'in-space',
              spaceName: 'General',
              spaceWorkspacePath: 'General',
              spaceRelativePath: 'skills/demo/SKILL.md',
              workspaceRelativePath: 'General/skills/demo/SKILL.md',
              fileName: 'SKILL.md',
              absolutePath: '/ws/General/skills/demo/SKILL.md',
            },
          }),
        ],
      },
      { dedupStagedMemoryApprovals: true },
    );
    expect(inSpaceItems).toEqual([]);

    const outsideItems = run(
      {
        memoryApprovals: [
          memory({
            toolUseId: 'loc-outside',
            staged: true,
            filePath: 'Outside workspace/legacy.md',
            location: {
              kind: 'outside-workspace',
              absolutePath: '/tmp/rebel/report.md',
              fileName: 'report.md',
            },
          }),
        ],
        stagedFiles: [
          stagedFile({
            id: 'loc-outside-file',
            toolUseId: undefined,
            realPath: '/legacy/other.md',
            spacePath: 'legacy/other.md',
            location: {
              kind: 'outside-workspace',
              absolutePath: '/tmp/rebel/report.md',
              fileName: 'report.md',
            },
          }),
        ],
      },
      { dedupStagedMemoryApprovals: true },
    );
    expect(outsideItems).toEqual([]);

    const legacyItems = run(
      {
        memoryApprovals: [
          memory({
            toolUseId: 'loc-legacy',
            staged: true,
            filePath: 'General/legacy/path.md',
            location: {
              kind: 'legacy-missing-location',
              fileName: 'path.md',
              spaceName: 'General',
              legacyPath: 'General/legacy/path.md',
            },
          }),
        ],
        stagedFiles: [
          stagedFile({
            id: 'loc-legacy-file',
            toolUseId: undefined,
            realPath: '/legacy/not-used.md',
            spacePath: 'legacy/not-used.md',
            location: {
              kind: 'legacy-missing-location',
              fileName: 'path.md',
              spaceName: 'General',
              legacyPath: 'General/legacy/path.md',
            },
          }),
        ],
      },
      { dedupStagedMemoryApprovals: true },
    );
    expect(legacyItems).toEqual([]);
  });

  it('8.7 dedups canonical in-space locations against legacy spacePath-only staged files', () => {
    const items = run(
      {
        memoryApprovals: [
          memory({
            toolUseId: 'mixed-in-space',
            staged: true,
            filePath: 'legacy/not-used.md',
            location: {
              kind: 'in-space',
              spaceName: 'General',
              spaceWorkspacePath: 'General',
              spaceRelativePath: 'skills/demo/SKILL.md',
              workspaceRelativePath: 'General/skills/demo/SKILL.md',
              fileName: 'SKILL.md',
              absolutePath: '/ws/General/skills/demo/SKILL.md',
            },
          }),
        ],
        stagedFiles: [
          stagedFile({
            id: 'mixed-in-space-file',
            toolUseId: undefined,
            location: undefined,
            spacePath: 'General/skills/demo/SKILL.md',
          }),
        ],
      },
      { dedupStagedMemoryApprovals: true },
    );
    expect(items).toEqual([]);
  });

  it('8.8 dedups outside-workspace absolute paths against legacy absolute-path staged files', () => {
    const items = run(
      {
        memoryApprovals: [
          memory({
            toolUseId: 'mixed-outside',
            staged: true,
            filePath: '/legacy/not-used.md',
            location: {
              kind: 'outside-workspace',
              absolutePath: '/tmp/rebel/report.md',
              fileName: 'report.md',
            },
          }),
        ],
        stagedFiles: [
          stagedFile({
            id: 'mixed-outside-file',
            toolUseId: undefined,
            location: undefined,
            realPath: '/tmp/rebel/report.md',
            spacePath: '/tmp/rebel/report.md',
          }),
        ],
      },
      { dedupStagedMemoryApprovals: true },
    );
    expect(items).toEqual([]);
  });

  it('8.9 dedups legacy-missing-location fallbacks against legacy spacePath-only staged files', () => {
    const items = run(
      {
        memoryApprovals: [
          memory({
            toolUseId: 'mixed-legacy',
            staged: true,
            filePath: 'General/skills/legacy.md',
            location: {
              kind: 'legacy-missing-location',
              fileName: 'legacy.md',
              spaceName: 'General',
              legacyPath: 'General/skills/legacy.md',
            },
          }),
        ],
        stagedFiles: [
          stagedFile({
            id: 'mixed-legacy-file',
            toolUseId: undefined,
            location: undefined,
            spacePath: 'General/skills/legacy.md',
          }),
        ],
      },
      { dedupStagedMemoryApprovals: true },
    );
    expect(items).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 9. Session context lookups
// ---------------------------------------------------------------------------

describe('deriveUnifiedApprovals — session context', () => {
  it('9.1 falls back to "Background task" for unknown sessions', () => {
    const items = run({
      toolApprovals: [tool({ sessionId: 'unknown' })],
      sessionContext: ctx(),
    });
    expect(items[0].title).toBe('Background task');
  });

  it('9.2 uses parseBackgroundTaskType for unknown sessions when provided', () => {
    const items = run(
      {
        toolApprovals: [tool({ sessionId: 'meeting-analysis-xyz' })],
      },
      {
        parseBackgroundTaskType: (id) => (id.startsWith('meeting-analysis-') ? 'Meeting analysis' : null),
      },
    );
    expect(items[0].title).toBe('Meeting analysis');
  });

  it('9.3 passes session context through to the output row', () => {
    const items = run({
      toolApprovals: [tool({ sessionId: 's-1' })],
      sessionContext: ctx([
        ['s-1', { title: 'Strategy', firstMessagePreview: 'Hello', messageCount: 3 }],
      ]),
    });
    expect(items[0].sessionContext).toEqual({
      title: 'Strategy',
      firstMessagePreview: 'Hello',
      lastMessagePreview: undefined,
      messageCount: 3,
      sessionStartedAt: undefined,
      lastUpdatedAt: undefined,
    });
  });
});

// ---------------------------------------------------------------------------
// 10. Mixed scenarios + integration
// ---------------------------------------------------------------------------

describe('deriveUnifiedApprovals — integrated scenarios', () => {
  it('10.1 (mobile flow) mixed kinds + dedup + staged files emitted', () => {
    const items = run(
      {
        toolApprovals: [tool({ toolUseID: 't', timestamp: 100 })],
        memoryApprovals: [
          memory({ toolUseId: 'm-live', timestamp: 200 }),
          memory({ toolUseId: 'm-staged', staged: true, timestamp: 150, filePath: 'memory/x.md' }),
        ],
        stagedCalls: [stagedCall({ id: 'sc', timestamp: 300 })],
        stagedFiles: [stagedFile({ id: 'sf', toolUseId: 'm-staged', stagedAt: 500 })],
      },
      {
        dedupStagedMemoryApprovals: true,
        includeStagedFileItems: true,
      },
    );
    expect(items.map((i) => i.id)).toEqual([
      'staged-file:sf',
      'staged-tool:sc',
      'memory:m-live',
      'tool:t',
    ]);
  });

  it('10.2 (desktop flow) mixed kinds, staged files hidden, dedup disabled → 4 rows', () => {
    const items = run({
      toolApprovals: [tool({ toolUseID: 't', timestamp: 100 })],
      memoryApprovals: [
        memory({ toolUseId: 'm-live', timestamp: 200 }),
        memory({ toolUseId: 'm-staged', staged: true, timestamp: 150, filePath: 'memory/x.md' }),
      ],
      stagedCalls: [stagedCall({ id: 'sc', timestamp: 300 })],
      stagedFiles: [stagedFile({ id: 'sf', toolUseId: 'm-staged', stagedAt: 500 })],
    });
    expect(items.map((i) => i.id)).toEqual([
      'staged-tool:sc',
      'memory:m-live',
      'memory:m-staged',
      'tool:t',
    ]);
  });

  it('10.3 continuation-group: two tools sharing a session both appear', () => {
    const items = run({
      toolApprovals: [
        tool({ toolUseID: 't-a', timestamp: 100, sessionId: 's-1' }),
        tool({ toolUseID: 't-b', timestamp: 200, sessionId: 's-1' }),
      ],
      sessionContext: ctx([['s-1', { title: 'Session 1' }]]),
    });
    expect(items.map((i) => i.id)).toEqual(['tool:t-b', 'tool:t-a']);
    expect(items[0].title).toBe('Session 1');
    expect(items[1].title).toBe('Session 1');
  });

  it('10.4 batch-pending: many staged calls still sorted newest-first', () => {
    const calls = [0, 1, 2, 3, 4].map((i) =>
      stagedCall({ id: `batch-${i}`, timestamp: 1_000 + i }),
    );
    const items = run({ stagedCalls: calls });
    expect(items.map((i) => i.id)).toEqual([
      'staged-tool:batch-4',
      'staged-tool:batch-3',
      'staged-tool:batch-2',
      'staged-tool:batch-1',
      'staged-tool:batch-0',
    ]);
  });

  it('10.5 safety-block reason flows through unmodified', () => {
    const items = run({
      toolApprovals: [
        tool({
          reason: 'Safety Rules blocked: sending to 100+ recipients requires review',
        }),
      ],
    });
    expect(items[0].description).toBe('sending to 100+ recipients requires review');
  });

  it('10.6 conflict-aware staged file preserves hasConflict flag', () => {
    const items = run(
      { stagedFiles: [stagedFile({ hasConflict: true })] },
      { includeStagedFileItems: true },
    );
    expect(items[0].stagedFile?.hasConflict).toBe(true);
  });

  it('10.7 same-tick race: same-timestamp rows fall back to lexicographic id order', () => {
    // F3-9: timestamps alone are non-deterministic when two sources land in
    // the same tick; the mapper applies a secondary id-based tiebreaker so
    // every engine agrees on the visible order.
    const items = run({
      toolApprovals: [tool({ toolUseID: 't-1', timestamp: 500 })],
      memoryApprovals: [memory({ toolUseId: 'm-1', timestamp: 500 })],
      stagedCalls: [stagedCall({ id: 'c-1', timestamp: 500 })],
    });
    expect(items).toHaveLength(3);
    // Deterministic tiebreaker: 'memory:m-1' < 'staged-tool:c-1' < 'tool:t-1'.
    expect(items.map((i) => i.id)).toEqual([
      'memory:m-1',
      'staged-tool:c-1',
      'tool:t-1',
    ]);
  });

  it('10.8 empty session context map does not crash', () => {
    const items = run({
      toolApprovals: [tool({ sessionId: 'whatever' })],
      sessionContext: new Map(),
    });
    expect(items[0].title).toBe('Background task');
  });
});

// ---------------------------------------------------------------------------
// 11. Immutability / purity
// ---------------------------------------------------------------------------

describe('deriveUnifiedApprovals — purity', () => {
  it('11.1 does not mutate input arrays', () => {
    const memoryInputs: MemoryApprovalInput[] = [memory()];
    const stagedFiles: StagedFileInput[] = [stagedFile()];
    const snapshot = {
      memory: memoryInputs.map((m) => ({ ...m })),
      files: stagedFiles.map((f) => ({ ...f })),
    };
    run({ memoryApprovals: memoryInputs, stagedFiles }, {
      dedupStagedMemoryApprovals: true,
      includeStagedFileItems: true,
      suppressedIds: new Set(['staged-file:sf-1']),
    });
    expect(memoryInputs).toEqual(snapshot.memory);
    expect(stagedFiles).toEqual(snapshot.files);
  });

  it('11.2 called repeatedly with identical inputs returns equal output shape', () => {
    const inputs: DeriveUnifiedApprovalsInputs = {
      toolApprovals: [tool()],
      memoryApprovals: [memory()],
      stagedCalls: [stagedCall()],
      stagedFiles: [stagedFile()],
      sessionContext: ctx([['session-a', { title: 'S' }]]),
    };
    const a = deriveUnifiedApprovals(inputs);
    const b = deriveUnifiedApprovals(inputs);
    expect(a).toEqual(b);
  });
});

// ---------------------------------------------------------------------------
// 12. Cross-surface parity fixtures (F3-6, Round 3)
// ---------------------------------------------------------------------------
// Shared fixture set consumed here, in cloud-client's useUnifiedApprovals
// test, and in desktop's usePendingApprovals contract test. Asserts the
// pure mapper emits the expected IDs under each surface's option set.
// ---------------------------------------------------------------------------

describe('deriveUnifiedApprovals — shared parity fixtures (F3-6)', () => {
  it.each(APPROVAL_PARITY_FIXTURES)('$name — desktop IDs match', (fixture) => {
    const sessionContext = new Map(fixture.inputs.sessionContextEntries);
    const items = deriveUnifiedApprovals(
      {
        toolApprovals: fixture.inputs.toolApprovals,
        memoryApprovals: fixture.inputs.memoryApprovals,
        stagedCalls: fixture.inputs.stagedCalls,
        stagedFiles: fixture.inputs.stagedFiles,
        sessionContext,
      },
      { ...DESKTOP_PARITY_OPTIONS, ...fixture.desktopOptions },
    );
    expect(items.map((i) => i.id)).toEqual(fixture.expectedDesktopIds);
  });

  it.each(APPROVAL_PARITY_FIXTURES)('$name — cloud IDs match', (fixture) => {
    const sessionContext = new Map(fixture.inputs.sessionContextEntries);
    const items = deriveUnifiedApprovals(
      {
        toolApprovals: fixture.inputs.toolApprovals,
        memoryApprovals: fixture.inputs.memoryApprovals,
        stagedCalls: fixture.inputs.stagedCalls,
        stagedFiles: fixture.inputs.stagedFiles,
        sessionContext,
      },
      { ...CLOUD_PARITY_OPTIONS, ...fixture.cloudOptions },
    );
    expect(items.map((i) => i.id)).toEqual(fixture.expectedCloudIds);
  });
});
