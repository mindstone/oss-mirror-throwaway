/**
 * ApprovalSheetHost — hosts the three approval detail sheets (StagedFile /
 * Memory / Tool) and the currently-selected-approval state.
 *
 * Stage D of `docs/plans/260417_approval_consolidation_closeout.md`.
 *
 * Design:
 *  - State: `selectedApproval: { kind, id } | null`. Sheets are derived from
 *    the central stores by id — we NEVER snapshot the full item into local
 *    state (that would go stale the moment the store emits a change event).
 *  - Cross-surface sync: when the store no longer contains the selected id
 *    (another session resolved the item, or the local store processed a
 *    `memory:staged-files-changed` push), the hook auto-closes the sheet.
 *  - The host itself is UI-agnostic — callers call `openApproval(kind, id)`
 *    via the `ref` handle to drive it. This keeps the state out of the
 *    consumer tree so we can reuse the host from both the inbox screen and
 *    conversation screens.
 *
 * Action callbacks are passed via props so the host doesn't reach into
 * store methods directly — keeps it testable and surface-agnostic.
 */

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useState } from 'react';
import {
  useApprovalStore,
  useStagedFilesStore,
  type CloudStagedToolCall,
  type MemoryWriteApproval,
  type StagedFile,
  type ToolApproval,
} from '@rebel/cloud-client';

import { StagedFileApprovalSheet } from './StagedFileApprovalSheet';
import { MemoryApprovalSheet } from './MemoryApprovalSheet';
import { ToolApprovalSheet } from './ToolApprovalSheet';

/**
 * F-D-R2-7 — adapt a `CloudStagedToolCall` to the `ToolApproval` shape so
 * the same `ToolApprovalSheet` UX works for both inline tool approvals
 * and staged tool calls. The only behavioural difference is the IPC
 * action — `onApprove` for a staged-call maps to "execute" and `onDeny`
 * to "reject".
 */
export function stagedCallToToolApproval(call: CloudStagedToolCall): ToolApproval {
  const risk = call.riskLevel === 'low' || call.riskLevel === 'medium' || call.riskLevel === 'high'
    ? call.riskLevel
    : undefined;
  const payload = call.mcpPayload as { args?: Record<string, unknown> } | null | undefined;
  return {
    toolUseID: call.id,
    turnId: call.turnId,
    sessionId: call.sessionId,
    toolName: call.displayName,
    input: (payload?.args ?? {}) as Record<string, unknown>,
    timestamp: call.timestamp,
    reason: call.reason,
    riskLevel: risk,
    allowPermanentTrust: call.allowPermanentTrust,
    blockedBy: call.blockedBy,
    packageName: undefined,
    conversationTitle: call.automationName,
  };
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ApprovalSheetKind = 'staged-file' | 'memory' | 'tool' | 'staged-call';

export interface ApprovalSheetHandle {
  /** Programmatically open a detail sheet for the given approval. */
  openApproval: (kind: ApprovalSheetKind, id: string) => void;
  /** Force-close whichever sheet is currently open. */
  closeApproval: () => void;
}

export interface ApprovalSheetHostProps {
  /** Staged-file actions. */
  onPublishStagedFile: (file: StagedFile) => void;
  onDiscardStagedFile: (file: StagedFile) => void;
  onKeepPrivateStagedFile: (file: StagedFile) => void;
  onResolveWithRebel: (file: StagedFile) => void;
  onKeepMine: (file: StagedFile) => void;
  onKeepTheirs: (file: StagedFile) => void;

  /** Memory approval actions. */
  onApproveMemoryWrite: (approval: MemoryWriteApproval) => void;
  onSkipMemoryWrite: (approval: MemoryWriteApproval) => void;

  /** Tool approval actions. */
  onApproveTool: (approval: ToolApproval, allowForSession: boolean) => void;
  onDenyTool: (approval: ToolApproval) => void;

  /**
   * F-D-R2-7 — staged-call actions. A `CloudStagedToolCall` is
   * effectively a tool call with deferred execution; we route it through
   * the same `ToolApprovalSheet` UX via `stagedCallToToolApproval`.
   */
  onExecuteStagedCall: (call: CloudStagedToolCall) => void;
  onRejectStagedCall: (call: CloudStagedToolCall) => void;

  /** Global online state. */
  isOnline: boolean;
}

interface SelectedApproval {
  kind: ApprovalSheetKind;
  id: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const ApprovalSheetHost = forwardRef<ApprovalSheetHandle, ApprovalSheetHostProps>(
  function ApprovalSheetHost(
    {
      onPublishStagedFile,
      onDiscardStagedFile,
      onKeepPrivateStagedFile,
      onResolveWithRebel,
      onKeepMine,
      onKeepTheirs,
      onApproveMemoryWrite,
      onSkipMemoryWrite,
      onApproveTool,
      onDenyTool,
      onExecuteStagedCall,
      onRejectStagedCall,
      isOnline,
    },
    ref,
  ) {
    const [selected, setSelected] = useState<SelectedApproval | null>(null);

    // Subscribe to the stores so we can:
    //  1. Look up the currently-selected item by id (never snapshot).
    //  2. Auto-close the sheet if the id disappears from the store.
    const stagedFiles = useStagedFilesStore((s) => s.files);
    const toolApprovals = useApprovalStore((s) => s.toolApprovals);
    const memoryApprovals = useApprovalStore((s) => s.memoryApprovals);
    const stagedCalls = useApprovalStore((s) => s.stagedCalls);

    const stagedFile = useMemo<StagedFile | null>(() => {
      if (!selected || selected.kind !== 'staged-file') return null;
      return stagedFiles.find((f) => f.id === selected.id) ?? null;
    }, [selected, stagedFiles]);

    const memoryApproval = useMemo<MemoryWriteApproval | null>(() => {
      if (!selected || selected.kind !== 'memory') return null;
      return memoryApprovals.find((a) => a.toolUseId === selected.id) ?? null;
    }, [selected, memoryApprovals]);

    const toolApproval = useMemo<ToolApproval | null>(() => {
      if (!selected || selected.kind !== 'tool') return null;
      return toolApprovals.find((a) => a.toolUseID === selected.id) ?? null;
    }, [selected, toolApprovals]);

    // F-D-R2-7 — look up the staged-call by id, then adapt to a
    // ToolApproval so the existing ToolApprovalSheet renders it.
    const stagedCall = useMemo<CloudStagedToolCall | null>(() => {
      if (!selected || selected.kind !== 'staged-call') return null;
      return stagedCalls.find((c) => c.id === selected.id) ?? null;
    }, [selected, stagedCalls]);

    const stagedCallApproval = useMemo<ToolApproval | null>(() => {
      return stagedCall ? stagedCallToToolApproval(stagedCall) : null;
    }, [stagedCall]);

    // Cross-surface close — when the selected approval disappears from the
    // store (another surface resolved it, or the store processed a push
    // event), close the sheet. We schedule the close on the next tick so
    // the sheet can still animate out instead of abruptly disappearing.
    useEffect(() => {
      if (!selected) return;
      if (selected.kind === 'staged-file' && stagedFile === null) {
        setSelected(null);
        return;
      }
      if (selected.kind === 'memory' && memoryApproval === null) {
        setSelected(null);
        return;
      }
      if (selected.kind === 'tool' && toolApproval === null) {
        setSelected(null);
        return;
      }
      if (selected.kind === 'staged-call' && stagedCall === null) {
        setSelected(null);
        return;
      }
    }, [selected, stagedFile, memoryApproval, toolApproval, stagedCall]);

    const closeSheet = useCallback(() => {
      setSelected(null);
    }, []);

    useImperativeHandle(
      ref,
      () => ({
        openApproval: (kind: ApprovalSheetKind, id: string) => {
          setSelected({ kind, id });
        },
        closeApproval: () => setSelected(null),
      }),
      [],
    );

    // F-D-R2-7 — staged-call wraps the existing ToolApprovalSheet
    // actions to call execute/reject instead of the regular
    // respondToApproval flow.
    const handleStagedCallApprove = useCallback(() => {
      if (stagedCall) onExecuteStagedCall(stagedCall);
    }, [stagedCall, onExecuteStagedCall]);
    const handleStagedCallDeny = useCallback(() => {
      if (stagedCall) onRejectStagedCall(stagedCall);
    }, [stagedCall, onRejectStagedCall]);

    return (
      <>
        <StagedFileApprovalSheet
          file={stagedFile}
          visible={selected?.kind === 'staged-file'}
          onClose={closeSheet}
          onPublish={onPublishStagedFile}
          onDiscard={onDiscardStagedFile}
          onKeepPrivate={onKeepPrivateStagedFile}
          onResolveWithRebel={onResolveWithRebel}
          onKeepMine={onKeepMine}
          onKeepTheirs={onKeepTheirs}
          isOnline={isOnline}
        />
        <MemoryApprovalSheet
          approval={memoryApproval}
          visible={selected?.kind === 'memory'}
          onClose={closeSheet}
          onSave={onApproveMemoryWrite}
          onSkip={onSkipMemoryWrite}
        />
        <ToolApprovalSheet
          approval={toolApproval}
          visible={selected?.kind === 'tool'}
          onClose={closeSheet}
          onApprove={onApproveTool}
          onDeny={onDenyTool}
        />
        <ToolApprovalSheet
          approval={stagedCallApproval}
          visible={selected?.kind === 'staged-call'}
          onClose={closeSheet}
          onApprove={handleStagedCallApprove}
          onDeny={handleStagedCallDeny}
        />
      </>
    );
  },
);

ApprovalSheetHost.displayName = 'ApprovalSheetHost';

export default ApprovalSheetHost;
