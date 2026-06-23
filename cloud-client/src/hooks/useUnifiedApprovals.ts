/**
 * useUnifiedApprovals
 *
 * Cross-surface React hook that derives a single, deterministic list of
 * pending approvals (tools, memory writes, staged tool calls, and staged
 * files) from the existing Zustand stores in `cloud-client`.
 *
 * Wraps the pure `deriveUnifiedApprovals` mapper from `@rebel/shared` with
 * reactive store subscriptions so mobile/web UIs can consume a single source
 * of truth. The mapper itself is pure and exhaustively tested; this hook is
 * the integration point.
 *
 * Actions (approve/deny/execute/keepPrivate/etc.) are deliberately NOT
 * attached here — platform hosts own that concern (mobile wires transport
 * callbacks in its own action layer). This keeps the hook free of side
 * effects so it stays easy to mock in tests.
 *
 * See: docs/plans/260416_centralize_approval_and_diff_viewing_ux.md §Stage 3.
 */

import { useMemo } from 'react';
import {
  deriveUnifiedApprovals,
  type DeriveUnifiedApprovalsOptions,
  type MemoryApprovalInput,
  type SessionContextForApprovals,
  type StagedFileInput,
  type StagedToolCallInput,
  type ToolApprovalInput,
  type ToolApprovalSummary,
  type UnifiedApproval,
} from '@rebel/shared';
import { useApprovalStore } from '../stores/approvalStore';
import { useStagedFilesStore } from '../stores/stagedFilesStore';
import type {
  CloudStagedToolCall,
  MemoryWriteApproval,
  StagedFile,
  ToolApproval,
} from '../types';

export interface UseUnifiedApprovalsOptions {
  /**
   * Optional session-title/context map. Mobile wires this from the existing
   * session store once we have it; web apps can supply an empty map and
   * rely on fallbacks ("Background task").
   */
  sessionContext?: ReadonlyMap<string, SessionContextForApprovals>;
  /**
   * Optional per-tool summaries keyed by `toolUseID`. Desktop computes these
   * via `summarizeToolForApproval`; mobile can generate its own or omit.
   */
  toolSummaries?: ReadonlyMap<string, ToolApprovalSummary>;
  /**
   * Optional set of composite ids to suppress (optimistic removal). Use this
   * to hide rows the user has just actioned before the backend broadcast
   * arrives.
   */
  suppressedIds?: ReadonlySet<string>;
  /**
   * Override any of the pure mapper's options (stripping safety prefixes,
   * parsing background-task ids, dedup/staged-file knobs, etc.).
   *
   * Defaults applied by the hook (can be overridden):
   * - `includeStagedFileItems: true`
   * - `dedupStagedMemoryApprovals: true`
   * - `excludeNonPendingStagedCalls: true`
   */
  mapperOptions?: Omit<
    DeriveUnifiedApprovalsOptions,
    'suppressedIds'
  >;
}

export interface UseUnifiedApprovalsResult {
  /** Unified list of pending approvals, sorted by timestamp (newest first). */
  items: UnifiedApproval[];
  /** Convenience accessor: items.length. */
  count: number;
  /** Whether either underlying store is still loading. */
  loading: boolean;
  /** Aggregate error message from either store, if any. */
  error: string | null;
}

// ---------------------------------------------------------------------------
// Source-to-mapper translators
// ---------------------------------------------------------------------------

function toToolApprovalInput(a: ToolApproval): ToolApprovalInput {
  return {
    toolUseID: a.toolUseID,
    turnId: a.turnId,
    sessionId: a.sessionId,
    toolName: a.toolName,
    input: a.input,
    reason: a.reason,
    timestamp: a.timestamp,
    allowPermanentTrust: a.allowPermanentTrust,
    blockedBy: a.blockedBy,
    riskLevel: a.riskLevel,
    packageName: a.packageName,
    conversationTitle: a.conversationTitle,
  };
}

function toMemoryApprovalInput(a: MemoryWriteApproval): MemoryApprovalInput {
  return {
    toolUseId: a.toolUseId,
    originalSessionId: a.originalSessionId,
    filePath: a.filePath,
    spaceName: a.spaceName,
    location: a.location,
    summary: a.summary,
    content: '', // cloud flow fetches via useApprovalContent; mapper needs only a stub
    timestamp: a.timestamp,
    blockedBy: a.blockedBy,
    spacePath: a.spacePath,
    sharing: a.sharing,
    contentPreview: a.contentPreview,
    staged: a.staged,
    authorLabel: a.authorLabel,
    approvalKind: a.approvalKind,
    isNewFile: a.isNewFile,
  };
}

function toStagedCallInput(c: CloudStagedToolCall): StagedToolCallInput {
  // Cloud DTO widens several enums to `string`; narrow by assertion for the
  // mapper. If any value is out-of-range, the mapper handles gracefully:
  // unknown riskLevel becomes undefined (no silent medium-fallback as of Phase 1 UI landing).
  return {
    id: c.id,
    sessionId: c.sessionId,
    turnId: c.turnId,
    timestamp: c.timestamp,
    expiresAt: 0,
    status: c.status as StagedToolCallInput['status'],
    mcpPayload: c.mcpPayload,
    displayName: c.displayName,
    toolCategory: c.toolCategory as StagedToolCallInput['toolCategory'],
    riskLevel: c.riskLevel as StagedToolCallInput['riskLevel'],
    reason: c.reason,
    automationName: c.automationName,
    allowPermanentTrust: c.allowPermanentTrust,
    blockedBy: c.blockedBy,
  };
}

function toStagedFileInput(f: StagedFile): StagedFileInput {
  return {
    id: f.id,
    realPath: f.realPath,
    spaceName: f.spaceName,
    spacePath: f.spacePath,
    location: f.location,
    sessionId: f.sessionId,
    baseHash: f.baseHash,
    summary: f.summary,
    stagedAt: f.stagedAt,
    sensitivity: 'high',
    sharing: f.sharing,
    blockedBy: f.blockedBy,
    hasConflict: f.hasConflict,
    approvalKind: f.approvalKind,
    authorLabel: f.authorLabel,
    toolUseId: f.toolUseId,
    // Pending destination is used by the mapper's FM #16 dedup path when
    // toolUseId isn't available but the destination paths match.
    destination: f.pendingDestination,
  };
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

const EMPTY_SESSION_CONTEXT: ReadonlyMap<string, SessionContextForApprovals> = new Map();

export function useUnifiedApprovals(
  options: UseUnifiedApprovalsOptions = {},
): UseUnifiedApprovalsResult {
  const toolApprovals = useApprovalStore((s) => s.toolApprovals);
  const memoryApprovals = useApprovalStore((s) => s.memoryApprovals);
  const stagedCalls = useApprovalStore((s) => s.stagedCalls);
  const approvalsLoading = useApprovalStore((s) => s.isLoading);
  const approvalsError = useApprovalStore((s) => s.error);

  const stagedFiles = useStagedFilesStore((s) => s.files);
  const stagedLoading = useStagedFilesStore((s) => s.isLoading);
  const stagedError = useStagedFilesStore((s) => s.error);

  const sessionContext = options.sessionContext ?? EMPTY_SESSION_CONTEXT;

  const items = useMemo(
    () => {
      return deriveUnifiedApprovals(
        {
          toolApprovals: toolApprovals.map(toToolApprovalInput),
          memoryApprovals: memoryApprovals.map(toMemoryApprovalInput),
          stagedCalls: stagedCalls.map(toStagedCallInput),
          stagedFiles: stagedFiles.map(toStagedFileInput),
          sessionContext,
          toolSummaries: options.toolSummaries,
        },
        {
          includeStagedFileItems: true,
          dedupStagedMemoryApprovals: true,
          excludeNonPendingStagedCalls: true,
          ...options.mapperOptions,
          suppressedIds: options.suppressedIds,
        },
      );
    },
    [
      toolApprovals,
      memoryApprovals,
      stagedCalls,
      stagedFiles,
      sessionContext,
      options.toolSummaries,
      options.suppressedIds,
      options.mapperOptions,
    ],
  );

  return {
    items,
    count: items.length,
    loading: approvalsLoading || stagedLoading,
    error: approvalsError ?? stagedError ?? null,
  };
}
