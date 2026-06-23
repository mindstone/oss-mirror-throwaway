import { describe, expect, it } from 'vitest';
import type { PendingApprovalItem } from '../../hooks/usePendingApprovals';
import type { StagedFileItem } from '../../hooks/useStagedFiles';
import { toActionPreviewInput } from '../toActionPreviewInput';

function buildToolApproval(): PendingApprovalItem {
  return {
    id: 'tool:1',
    type: 'tool',
    title: 'Tool',
    description: 'Tool approval',
    timestamp: 1,
    sessionId: 'session-1',
    packageName: 'slack',
    toolApproval: {
      toolUseID: 'tool-use-1',
      turnId: 'turn-1',
      toolName: 'post_slack_message',
      effectiveToolId: 'post_slack_message',
      reason: 'Needs approval',
      input: {
        package_id: 'slack',
        args: {
          channel: '#ops',
          text: 'Status',
        },
      },
    },
  };
}

function buildMemoryApproval(): PendingApprovalItem {
  return {
    id: 'memory:1',
    type: 'memory',
    title: 'Memory',
    description: 'Memory approval',
    timestamp: 2,
    sessionId: 'session-2',
    memoryApproval: {
      toolUseId: 'memory-tool-1',
      originalSessionId: 'session-2',
      filePath: '/spaces/general/notes.md',
      spaceName: 'General',
      spacePath: '/spaces/general',
      summary: 'Summary',
      content: 'Content',
      contentPreview: 'Preview',
      sensitivityReason: 'none',
      isNewFile: true,
      approvalKind: 'memory_write',
      sharing: 'restricted',
    },
  };
}

function buildStagedToolApproval(): PendingApprovalItem {
  return {
    id: 'staged-tool:1',
    type: 'staged-tool',
    title: 'Staged tool',
    description: 'Staged tool approval',
    timestamp: 3,
    sessionId: 'session-3',
    stagedToolCall: {
      id: 'staged-1',
      displayName: 'Slack send',
      reason: 'Needs approval',
      mcpPayload: {
        packageId: 'slack',
        toolId: 'post_slack_message',
        args: {
          channel: '#eng',
          text: 'Ship it',
        },
      },
    },
  };
}

function buildStagedFile(): StagedFileItem {
  return {
    id: 'staged-file-1',
    realPath: '/spaces/chief/file.md',
    spaceName: 'Chief-of-Staff',
    spacePath: '/spaces/chief',
    sessionId: 'session-4',
    baseHash: 'new-file',
    summary: 'Staged file summary',
    stagedAt: 4,
    sensitivity: 'high',
    sharing: 'company-wide',
    hasConflict: true,
    approvalKind: 'memory_write',
    fileName: 'file.md',
    sessionTitle: 'Session 4',
  };
}

describe('toActionPreviewInput', () => {
  it('maps tool approvals', () => {
    const mapped = toActionPreviewInput(buildToolApproval(), {
      resolvedRecipientLabel: 'Alex',
      resolvedChannelName: 'ops',
    });

    expect(mapped).toEqual({
      kind: 'tool',
      toolName: 'post_slack_message',
      effectiveToolId: 'post_slack_message',
      packageId: 'slack',
      reason: 'Needs approval',
      args: {
        channel: '#ops',
        text: 'Status',
      },
      resolvedRecipientLabel: 'Alex',
      resolvedChannelName: 'ops',
    });
  });

  it('maps memory approvals', () => {
    const mapped = toActionPreviewInput(buildMemoryApproval());
    expect(mapped).toEqual({
      kind: 'memory',
      toolUseId: 'memory-tool-1',
      filePath: '/spaces/general/notes.md',
      spaceName: 'General',
      spacePath: '/spaces/general',
      sharing: 'restricted',
      summary: 'Summary',
      content: 'Content',
      contentPreview: 'Preview',
      sensitivityReason: 'none',
      isNewFile: true,
      approvalKind: 'memory_write',
      hasConflict: false,
    });
  });

  it('maps staged-tool approvals', () => {
    const mapped = toActionPreviewInput(buildStagedToolApproval(), {
      resolvedRecipientLabel: 'Morgan',
    });
    expect(mapped).toEqual({
      kind: 'staged-tool',
      toolId: 'post_slack_message',
      packageId: 'slack',
      displayName: 'Slack send',
      reason: 'Needs approval',
      args: {
        channel: '#eng',
        text: 'Ship it',
      },
      resolvedRecipientLabel: 'Morgan',
      resolvedChannelName: undefined,
    });
  });

  it('maps staged files from the dialog shape', () => {
    const mapped = toActionPreviewInput(buildStagedFile());
    expect(mapped).toEqual({
      kind: 'staged-file',
      stagedFileId: 'staged-file-1',
      filePath: '/spaces/chief/file.md',
      spaceName: 'Chief-of-Staff',
      spacePath: '/spaces/chief',
      sharing: 'company-wide',
      summary: 'Staged file summary',
      baseHash: 'new-file',
      isNewFile: true,
      hasConflict: true,
      approvalKind: 'memory_write',
    });
  });

  it('maps staged-file pending approval wrappers', () => {
    const stagedFile = buildStagedFile();
    const mapped = toActionPreviewInput({
      type: 'staged-file',
      stagedFile,
    });
    expect(mapped).toEqual({
      kind: 'staged-file',
      stagedFileId: 'staged-file-1',
      filePath: '/spaces/chief/file.md',
      spaceName: 'Chief-of-Staff',
      spacePath: '/spaces/chief',
      sharing: 'company-wide',
      summary: 'Staged file summary',
      baseHash: 'new-file',
      isNewFile: true,
      hasConflict: true,
      approvalKind: 'memory_write',
    });
  });
});
