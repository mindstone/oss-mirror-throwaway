/**
 * unifiedApprovalMapper
 *
 * Pure, platform-agnostic list derivation for the Inbox approvals surface.
 *
 * Takes the canonical DTOs for tool approvals, memory approvals, staged tool
 * calls, and staged files, plus a pre-computed session title/context map, and
 * returns a deterministic ordered list of `UnifiedApproval` items for display.
 *
 * This module is the single source of truth for:
 * - the **shape** of a unified approval item (serializable fields only)
 * - the **sort order** (most recent first — easier triage)
 * - the **dedup rule** between memory approvals and staged files
 *   (FM #16: `memoryApproval.staged === true` is excluded when a matching
 *   staged file is present — staged files are the canonical representation)
 * - the **optimistic-removal suppression** (items whose composite id is in
 *   `options.suppressedIds` are filtered out)
 *
 * Callbacks / actions (approve/deny/dismiss/saveContent/etc.) are deliberately
 * NOT included here — those are platform-specific and live in the React hook
 * that wraps this mapper (`useUnifiedApprovals` on web/mobile;
 * `usePendingApprovals` on desktop).
 *
 * See: docs/plans/260416_centralize_approval_and_diff_viewing_ux.md §Stage 3.
 */

import type {
  ToolApprovalRequest,
  StagedToolCall,
} from './types/cloudClientDtos';
import type { FileLocation } from './fileLocation';
import { BlockSourceSchema } from './safety/blockSource';
import type { BlockSource, ToolBlockSource } from './safety/blockSource';

// ============================================================================
// Public types
// ============================================================================

/** Risk level as used across the approval surface. */
export type UnifiedApprovalRiskLevel = 'low' | 'medium' | 'high';

export type UnifiedApprovalKind = 'tool' | 'memory' | 'staged-tool' | 'staged-file';

/** The four canonical memory-approval block sources. */
export type MemoryBlockedBySource = BlockSource;

/** Sharing level for memory approvals. */
export type MemorySharing = 'private' | 'restricted' | 'company-wide' | 'public';

export type MemoryApprovalKind = 'memory_write' | 'shared_skill_checkpoint';

/**
 * Rich session context (title, message previews, timestamps) threaded through
 * the item so hover tooltips and secondary UI can render without a second
 * round-trip.
 */
export interface SessionContextForApprovals {
  title: string;
  firstMessagePreview?: string;
  lastMessagePreview?: string;
  messageCount: number;
  sessionStartedAt?: number;
  lastUpdatedAt?: number;
}

/**
 * The StagedFile DTO as returned by `memory:staging-get-all`.
 * Mirrors the desktop `StagedFile` shape (useStagedFiles.ts) and the
 * cloud-client `StagedFile` shape (cloud-client/src/types.ts). Intentionally
 * a new, slightly loose shape here to avoid circular imports.
 */
export interface UnifiedStagedFileInput {
  id: string;
  realPath: string;
  spaceName: string;
  spacePath: string;
  location?: FileLocation;
  sessionId: string;
  baseHash: string;
  summary: string;
  stagedAt: number;
  sensitivity: 'high';
  sharing?: string;
  blockedBy?: string;
  hasConflict?: boolean;
  approvalKind?: string;
  authorLabel?: string;
  /** Stable identifier for dedup between approval events and staged files */
  toolUseId?: string;
  /** Optional destination path used for dedup against memory approvals (FM #16). */
  destination?: string;
}

/**
 * One unified, serializable approval row.
 *
 * Every field here is JSON-serializable — no functions, no React state. The
 * hook that consumes this mapper attaches action callbacks (approve, deny,
 * dismiss, save) downstream.
 */
export interface UnifiedApproval {
  /** Composite key: `tool:${id}` | `memory:${id}` | `staged-tool:${id}` | `staged-file:${id}`. */
  id: string;
  /** Which source canonicalized this row. */
  kind: UnifiedApprovalKind;
  /** Display title — session title, automation name, or a task-type fallback. */
  title: string;
  /** Human-readable summary of the pending action (safety reason or synthesized description). */
  description: string;
  /** When the approval was captured (ms epoch). */
  timestamp: number;
  /** Session the approval belongs to (null = background task / no session). */
  sessionId: string | null;
  /** Tool / staged-tool risk level (when applicable). */
  riskLevel?: UnifiedApprovalRiskLevel;
  /** Package name (for tool + staged-tool kinds). */
  packageName?: string;
  /** Conversation title for legacy tool approvals. */
  conversationTitle?: string;
  /** Full session context for rich tooltips. */
  sessionContext?: SessionContextForApprovals;
  /** Tool-approval source payload (for `kind === 'tool'`). */
  toolApproval?: {
    toolUseID: string;
    turnId: string;
    toolName: string;
    input: Record<string, unknown>;
    reason?: string;
    effectiveToolId?: string;
    blockedBy?: ToolBlockSource;
  };
  /** Memory-approval source payload (for `kind === 'memory'`). */
  memoryApproval?: {
    toolUseId: string;
    originalSessionId: string;
    filePath: string;
    spaceName: string;
    location?: FileLocation;
    summary: string;
    content: string;
    sensitivityReason?: string;
    hasSpaceOverride?: boolean;
    privateMode?: boolean;
    blockedBy?: MemoryBlockedBySource;
    spacePath?: string;
    sharing?: MemorySharing;
    contentPreview?: string;
    approvalIdentifier?: string;
    approvalKind?: MemoryApprovalKind;
    authorLabel?: string;
    staged?: boolean;
    isNewFile?: boolean;
  };
  /** Staged-tool-call source payload (for `kind === 'staged-tool'`). */
  stagedToolCall?: {
    id: string;
    displayName: string;
    mcpPayload: {
      packageId: string;
      toolId: string;
      args: Record<string, unknown>;
    };
    riskLevel?: UnifiedApprovalRiskLevel;
    reason?: string;
    allowPermanentTrust?: boolean;
    blockedBy?: ToolBlockSource;
    automationName?: string;
  };
  /** Staged-file source payload (for `kind === 'staged-file'`). */
  stagedFile?: UnifiedStagedFileInput;
}

/**
 * Summary of a tool call for display. Platform hosts compute this because it
 * depends on renderer-only utilities (`summarizeToolForApproval`). The mapper
 * just looks it up and does not synthesize one.
 */
export interface ToolApprovalSummary {
  label: string;
  detail?: string;
}

/** Tool-approval input row. Accepts the extra desktop-side fields inline. */
export interface ToolApprovalInput extends ToolApprovalRequest {
  riskLevel?: UnifiedApprovalRiskLevel;
  packageName?: string;
  conversationTitle?: string;
}

/**
 * Memory-approval input row. Accepts the canonical desktop DTO shape but
 * widens `sharing`, `blockedBy`, and `content` to be tolerant of cloud-client
 * payloads that normalize legacy formats on the fly.
 */
export interface MemoryApprovalInput {
  toolUseId: string;
  originalSessionId: string;
  filePath: string;
  spaceName: string;
  location?: FileLocation;
  summary: string;
  /** Full body content (desktop flow has this; cloud flow may not). */
  content?: string;
  timestamp: number;
  sensitivityReason?: string;
  hasSpaceOverride?: boolean;
  privateMode?: boolean;
  blockedBy?: string;
  spacePath?: string;
  sharing?: string;
  contentPreview?: string;
  approvalIdentifier?: string;
  approvalKind?: string;
  authorLabel?: string;
  staged?: boolean;
  isNewFile?: boolean;
}

/** Staged-tool-call input row. */
export type StagedToolCallInput = StagedToolCall;

/** Staged-file input row. */
export type StagedFileInput = UnifiedStagedFileInput;

/** Full inputs to the derivation function. */
export interface DeriveUnifiedApprovalsInputs {
  toolApprovals: readonly ToolApprovalInput[];
  memoryApprovals: readonly MemoryApprovalInput[];
  stagedCalls: readonly StagedToolCallInput[];
  stagedFiles: readonly StagedFileInput[];
  /** Map of sessionId -> rich session context (title, previews, timestamps). */
  sessionContext: ReadonlyMap<string, SessionContextForApprovals>;
  /** Optional per-tool summaries keyed by `toolUseID`. */
  toolSummaries?: ReadonlyMap<string, ToolApprovalSummary>;
}

export interface DeriveUnifiedApprovalsOptions {
  /**
   * Composite ids to suppress (optimistic removal). Items whose `id` is in
   * this set are filtered from the output.
   *
   * Staged-file suppression also cascades: when `staged-file:X` is suppressed
   * and X has a `toolUseId`, the paired `memory:<toolUseId>` item is also
   * suppressed (the two are representations of the same underlying write).
   */
  suppressedIds?: ReadonlySet<string>;
  /**
   * Opt-in to filter out staged calls whose `status !== 'pending'`.
   * Defaults to `true` because desktop today only displays pending staged
   * calls; mobile can opt out if it wants to show executing/failed rows.
   */
  excludeNonPendingStagedCalls?: boolean;
  /**
   * Whether to emit `staged-file` kind rows into the output list.
   *
   * - **Desktop (default: `false`)** — desktop renders staged files in a
   *   dedicated section via `useStagedFiles` and must NOT see them in
   *   `usePendingApprovals.approvals`; the mapper still accepts `stagedFiles`
   *   so FM #16 dedup logic can apply (when `dedupStagedMemoryApprovals` is
   *   on), but suppresses the rows themselves.
   * - **Mobile (default: `true` when passing through `useUnifiedApprovals`)** —
   *   the new hook deliberately emits staged files as first-class rows because
   *   the mobile UX centralizes on a single unified list.
   */
  includeStagedFileItems?: boolean;
  /**
   * Whether to drop memory-approval rows whose `staged === true` has a
   * matching staged-file entry (FM #16 dedup).
   *
   * - **Desktop default: `false`** — matches legacy `usePendingApprovals`
   *   behaviour, which included staged-memory rows in `items` and only
   *   deduped at count time via `usePendingApprovalCount`. Flipping this on
   *   in desktop would be a user-visible change (fewer rows in the drawer).
   * - **Mobile / unified flow default: `true`** — the mobile surface renders
   *   staged files as first-class rows, so the memory counterpart must not
   *   double up.
   */
  dedupStagedMemoryApprovals?: boolean;
  /**
   * Parser for background-task-style session IDs (e.g.
   * `meeting-analysis-<uuid>` → "Meeting analysis"). Kept injectable so
   * consumers with different taxonomies don't need to fork the mapper.
   */
  parseBackgroundTaskType?: (sessionId: string) => string | null;
  /** Strip a common "Safety Rules blocked:" prefix. Injectable for testability. */
  stripSafetyPrefix?: (reason: string) => string;
  /** Predicate for "this reason is too generic to surface verbatim". */
  isGenericReason?: (reason: string) => boolean;
}

// ============================================================================
// Internal helpers
// ============================================================================

const DEFAULT_SAFETY_PREFIX = 'Safety Rules blocked:';

const defaultStripSafetyPrefix = (reason: string): string => {
  if (reason.startsWith(DEFAULT_SAFETY_PREFIX)) {
    return reason.slice(DEFAULT_SAFETY_PREFIX.length).trim();
  }
  return reason;
};

const defaultIsGenericReason = (_reason: string): boolean => false;

const defaultParseBackgroundTaskType = (_sessionId: string): string | null => null;

function getSessionContext(
  sessionId: string | undefined,
  contextMap: ReadonlyMap<string, SessionContextForApprovals>,
): SessionContextForApprovals | undefined {
  if (!sessionId) return undefined;
  return contextMap.get(sessionId);
}

function getSessionTitle(
  sessionId: string | undefined,
  contextMap: ReadonlyMap<string, SessionContextForApprovals>,
  parseBackgroundTaskType: (sessionId: string) => string | null,
): string {
  if (!sessionId) return 'Background task';
  const contextTitle = contextMap.get(sessionId)?.title;
  if (contextTitle) return contextTitle;
  const taskType = parseBackgroundTaskType(sessionId);
  return taskType || 'Background task';
}

function getLocationDedupKey(
  location: FileLocation | undefined,
  legacyFallback: string | undefined,
): string | undefined {
  if (!location) {
    return legacyFallback;
  }

  switch (location.kind) {
    case 'in-space':
      return location.workspaceRelativePath;
    case 'outside-workspace':
      return location.absolutePath;
    case 'legacy-missing-location':
      return location.legacyPath || legacyFallback;
    default: {
      const _exhaustive: never = location;
      void _exhaustive;
      return legacyFallback;
    }
  }
}

function enrichDestination(spaceName: string, filePath: string): string {
  // Mirrors desktop enrichment (FOX-3013): when saving "Outside workspace",
  // append the parent folder so users can disambiguate destinations at a glance.
  if (spaceName !== 'Outside workspace' || !filePath) return spaceName;
  const segs = filePath.replace(/\\/g, '/').split('/').filter(Boolean);
  const parent = segs.length >= 2 ? segs[segs.length - 2] : '';
  if (!parent) return spaceName;
  return `${spaceName} \u2014 ${parent}`;
}

function buildMemoryDescription(input: {
  spaceName: string;
  filePath: string;
  summary: string;
}): string {
  const dest = enrichDestination(input.spaceName, input.filePath);
  return input.summary ? `Wants to save to "${dest}": ${input.summary}` : `Wants to save to "${dest}"`;
}

function deriveToolDescription(
  reason: string | undefined,
  summary: ToolApprovalSummary | undefined,
  opts: { isGenericReason: (reason: string) => boolean; stripSafetyPrefix: (reason: string) => string },
): string {
  if (reason && !opts.isGenericReason(reason)) {
    return opts.stripSafetyPrefix(reason);
  }
  if (!summary) return '';
  return summary.detail ? `${summary.label}: ${summary.detail}` : summary.label;
}

function deriveStagedToolDescription(
  reason: string | undefined,
  displayName: string,
  opts: { isGenericReason: (reason: string) => boolean; stripSafetyPrefix: (reason: string) => string },
): string {
  if (reason && !opts.isGenericReason(reason)) {
    return opts.stripSafetyPrefix(reason);
  }
  return displayName;
}

function deriveStagedFileDescription(file: StagedFileInput): string {
  const dest = file.spaceName || 'Memory';
  return file.summary ? `Wants to save to "${dest}": ${file.summary}` : `Wants to save to "${dest}"`;
}

function toRiskLevel(value: string | undefined): UnifiedApprovalRiskLevel | undefined {
  if (value === 'low' || value === 'medium' || value === 'high') return value;
  return undefined;
}

function narrowBlockedBy(value: string | undefined): MemoryBlockedBySource | undefined {
  const parsed = BlockSourceSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function narrowSharing(value: string | undefined): MemorySharing | undefined {
  switch (value) {
    case 'private':
    case 'restricted':
    case 'company-wide':
    case 'public':
      return value;
    default:
      return undefined;
  }
}

function narrowApprovalKind(value: string | undefined): MemoryApprovalKind | undefined {
  switch (value) {
    case 'memory_write':
    case 'shared_skill_checkpoint':
      return value;
    default:
      return undefined;
  }
}

// ============================================================================
// Main derivation
// ============================================================================

export function deriveUnifiedApprovals(
  inputs: DeriveUnifiedApprovalsInputs,
  options: DeriveUnifiedApprovalsOptions = {},
): UnifiedApproval[] {
  const {
    toolApprovals,
    memoryApprovals,
    stagedCalls,
    stagedFiles,
    sessionContext,
    toolSummaries,
  } = inputs;

  const suppressedIds = options.suppressedIds ?? new Set<string>();
  const excludeNonPendingStagedCalls = options.excludeNonPendingStagedCalls ?? true;
  const includeStagedFileItems = options.includeStagedFileItems ?? false;
  const dedupStagedMemoryApprovals = options.dedupStagedMemoryApprovals ?? false;
  const parseBackgroundTaskType = options.parseBackgroundTaskType ?? defaultParseBackgroundTaskType;
  const stripSafetyPrefix = options.stripSafetyPrefix ?? defaultStripSafetyPrefix;
  const isGenericReason = options.isGenericReason ?? defaultIsGenericReason;

  // ---- Staged-file cascade suppression -----------------------------------
  // When a `staged-file:<id>` is in suppressedIds, the paired memory approval
  // (if any) must also be suppressed. Pairing rules (F3-2):
  //   - ONLY suppress when the memory approval is itself a staged one
  //     (`memoryApproval.staged === true`). Non-staged memory approvals
  //     remain visible even if they happen to share a toolUseId.
  //   - A pair matches when BOTH `toolUseId`s are non-empty AND equal, OR
  //     when BOTH destinations (`staged.destination || staged.pendingDestination`
  //     vs `memoryApproval.filePath`) are non-empty AND equal.
  //
  // Suppressed staged-file ids → matching memory composite ids for cascade.
  const cascadedSuppressedMemoryIds = new Set<string>();
  if (suppressedIds.size > 0 && memoryApprovals.length > 0) {
    for (const file of stagedFiles) {
      const stagedFileId = `staged-file:${file.id}`;
      if (!suppressedIds.has(stagedFileId)) continue;
      const fileToolUseId = file.toolUseId || '';
      const fileDestination = getLocationDedupKey(
        file.location,
        file.destination || file.spacePath || file.realPath || '',
      ) || '';

      for (const m of memoryApprovals) {
        if (m.staged !== true) continue;
        const toolUseIdMatch =
          fileToolUseId.length > 0 && m.toolUseId && fileToolUseId === m.toolUseId;
        const destinationMatch =
          fileDestination.length > 0
          && fileDestination === getLocationDedupKey(m.location, m.filePath);
        if (toolUseIdMatch || destinationMatch) {
          cascadedSuppressedMemoryIds.add(`memory:${m.toolUseId}`);
        }
      }
    }
  }

  const isSuppressed = (compositeId: string): boolean =>
    suppressedIds.has(compositeId) || cascadedSuppressedMemoryIds.has(compositeId);

  const reasoningOpts = { isGenericReason, stripSafetyPrefix };

  // ---- Dedup: memory approvals with a matching staged file (FM #16) -----
  // Staged files are the canonical representation; a memory approval marked
  // `staged === true` is informational only and would cause double-counting /
  // double-rendering. When the flag is enabled, exclude those memory approvals
  // from the output when a staged file with the same toolUseId (preferred) or
  // destination path is present.
  const stagedFileByToolUseId = new Map<string, StagedFileInput>();
  const stagedFileByDestination = new Map<string, StagedFileInput>();
  if (dedupStagedMemoryApprovals) {
    for (const file of stagedFiles) {
      if (file.toolUseId) {
        stagedFileByToolUseId.set(file.toolUseId, file);
      }
      const dest = getLocationDedupKey(
        file.location,
        file.destination ?? file.spacePath ?? file.realPath,
      );
      if (dest) {
        stagedFileByDestination.set(dest, file);
      }
    }
  }

  // ---- Transform each source ---------------------------------------------

  const toolItems: UnifiedApproval[] = [];
  for (const t of toolApprovals) {
    const id = `tool:${t.toolUseID}`;
    if (isSuppressed(id)) continue;
    const summary = toolSummaries?.get(t.toolUseID);
    const description = deriveToolDescription(t.reason, summary, reasoningOpts);
    toolItems.push({
      id,
      kind: 'tool',
      title: getSessionTitle(t.sessionId, sessionContext, parseBackgroundTaskType),
      description,
      timestamp: t.timestamp,
      sessionId: t.sessionId ?? null,
      riskLevel: toRiskLevel(t.riskLevel),
      packageName: t.packageName,
      conversationTitle: t.conversationTitle,
      sessionContext: getSessionContext(t.sessionId, sessionContext),
      toolApproval: {
        toolUseID: t.toolUseID,
        turnId: t.turnId,
        toolName: t.toolName,
        input: t.input,
        reason: t.reason,
        effectiveToolId: t.effectiveToolId,
        blockedBy: t.blockedBy,
      },
    });
  }

  const memoryItems: UnifiedApproval[] = [];
  for (const m of memoryApprovals) {
    const id = `memory:${m.toolUseId}`;
    if (isSuppressed(id)) continue;

    // FM #16 dedup: when content is already staged (approval is informational)
    // and we also have a matching staged file, skip the memory row so we show
    // only one representation.
    // Opt-in because desktop parity requires keeping staged memory rows; the
    // legacy `usePendingApprovals.approvals` list included them and only the
    // count hook filtered at tally time.
    if (dedupStagedMemoryApprovals && m.staged === true) {
      if (stagedFileByToolUseId.has(m.toolUseId)) continue;
      const destMatch = stagedFileByDestination.get(
        getLocationDedupKey(m.location, m.filePath) ?? m.filePath,
      );
      if (destMatch) continue;
    }

    memoryItems.push({
      id,
      kind: 'memory',
      title: getSessionTitle(m.originalSessionId, sessionContext, parseBackgroundTaskType),
      description: buildMemoryDescription({
        spaceName: m.spaceName,
        filePath: m.filePath,
        summary: m.summary,
      }),
      timestamp: m.timestamp,
      sessionId: m.originalSessionId,
      sessionContext: getSessionContext(m.originalSessionId, sessionContext),
      memoryApproval: {
        toolUseId: m.toolUseId,
        originalSessionId: m.originalSessionId,
        filePath: m.filePath,
        spaceName: m.spaceName,
        location: m.location,
        summary: m.summary,
        content: m.content ?? '',
        sensitivityReason: m.sensitivityReason,
        hasSpaceOverride: m.hasSpaceOverride,
        privateMode: m.privateMode,
        blockedBy: narrowBlockedBy(m.blockedBy),
        spacePath: m.spacePath,
        sharing: narrowSharing(m.sharing),
        contentPreview: m.contentPreview,
        approvalIdentifier: m.approvalIdentifier,
        approvalKind: narrowApprovalKind(m.approvalKind),
        authorLabel: m.authorLabel,
        staged: m.staged,
        isNewFile: m.isNewFile,
      },
    });
  }

  const stagedToolItems: UnifiedApproval[] = [];
  for (const call of stagedCalls) {
    if (excludeNonPendingStagedCalls && call.status !== 'pending') continue;
    const id = `staged-tool:${call.id}`;
    if (isSuppressed(id)) continue;
    const title = call.automationName
      || getSessionTitle(call.sessionId, sessionContext, parseBackgroundTaskType);
    const description = deriveStagedToolDescription(call.reason, call.displayName, reasoningOpts);
    const riskLevel = toRiskLevel(call.riskLevel);
    stagedToolItems.push({
      id,
      kind: 'staged-tool',
      title,
      description,
      timestamp: call.timestamp,
      sessionId: call.sessionId,
      riskLevel,
      packageName: call.mcpPayload.packageId,
      sessionContext: getSessionContext(call.sessionId, sessionContext),
      stagedToolCall: {
        id: call.id,
        displayName: call.displayName,
        mcpPayload: call.mcpPayload,
        riskLevel,
        reason: call.reason,
        allowPermanentTrust: call.allowPermanentTrust,
        blockedBy: call.blockedBy,
        automationName: call.automationName,
      },
    });
  }

  const stagedFileItems: UnifiedApproval[] = [];
  if (includeStagedFileItems) {
    for (const file of stagedFiles) {
      const id = `staged-file:${file.id}`;
      if (isSuppressed(id)) continue;
      const description = deriveStagedFileDescription(file);
      stagedFileItems.push({
        id,
        kind: 'staged-file',
        title: getSessionTitle(file.sessionId, sessionContext, parseBackgroundTaskType),
        description,
        timestamp: file.stagedAt,
        sessionId: file.sessionId,
        sessionContext: getSessionContext(file.sessionId, sessionContext),
        stagedFile: { ...file },
      });
    }
  }

  // ---- Sort (most recent first) ------------------------------------------
  // Primary: timestamp descending (newest first). Secondary tiebreaker: id
  // lexicographic (F3-9) so engines with non-stable sorts (or differing
  // implementations between hosts) agree on output order.
  const combined = [
    ...toolItems,
    ...memoryItems,
    ...stagedToolItems,
    ...stagedFileItems,
  ];
  combined.sort((a, b) => {
    if (a.timestamp !== b.timestamp) return b.timestamp - a.timestamp;
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  });
  return combined;
}
