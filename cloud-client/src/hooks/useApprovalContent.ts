/**
 * `useApprovalContent` — shared React hook that fetches the staged and
 * original/remote content for an approval item and derives conflict /
 * change-type / new-file / binary flags in one place.
 *
 * Consumed by:
 * - `src/renderer/features/inbox/components/StagedFilePreviewDialog.tsx`
 * - `src/renderer/features/inbox/components/MemoryPreviewDialog.tsx`
 * - `mobile/src/components/approval/*` (Stage 6)
 *
 * Platform-specific IPC transports are injected via `options.readStagedContent`
 * and `options.readWorkspaceFile` — desktop passes preload-bridge wrappers;
 * mobile passes `cloudClient.ipcCall` / `cloudClient.readWorkspaceFile`. The
 * pure decision helpers live in `@rebel/shared/approvalContent`.
 *
 * See `docs/plans/260416_centralize_approval_and_diff_viewing_ux.md` Stage 2.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  classifyReadError,
  detectChangeType,
  detectConflict,
  isLikelyBinary,
  type ApprovalChangeType,
  type ApprovalContentError,
  type ApprovalContentErrorKind,
} from '@rebel/shared';
import type { CloudStagedToolCall, MemoryWriteApproval, StagedFile } from '../types';
import { createLogger } from '../utils/logger';

const log = createLogger('useApprovalContent');

/**
 * Error thrown internally when the staged-content IPC returns a canonical
 * `{ content: null, error: '...' }` response. This lets the `normalize ->
 * throw -> classify` path be unified with the existing `try/catch` handling
 * for thrown rejections, so all staged-content failures flow through the
 * same error-reporting branch and can be classified consistently.
 */
class StagedContentIpcError extends Error {
  override readonly name = 'StagedContentIpcError';
  constructor(message: string) {
    super(message);
  }
}

/**
 * Error thrown when recovery is required for a memory approval but no unique
 * persisted row can be recovered for the requested identity.
 */
class MissingMemoryApprovalContentError extends Error {
  override readonly name = 'MissingMemoryApprovalContentError';
  constructor(message: string) {
    super(message);
  }
}

// =============================================================================
// Types
// =============================================================================

/**
 * Item shapes accepted by {@link useApprovalContent}.
 *
 * The hook internally discriminates at runtime based on fields (no explicit
 * `kind` field is required on the input — this keeps desktop callers free
 * to pass the canonical `StagedFile` / renderer-side `memoryApproval` shape
 * as-is).
 *
 * NOTE: The desktop renderer's `PendingApprovalItem.memoryApproval` extends
 * the cloud-client `MemoryWriteApproval` shape with a `content` field. The
 * hook reads `content` first and falls back to `contentPreview` — both are
 * accepted at the runtime level.
 */
export type ApprovalContentItem =
  | StagedFile
  | MemoryWriteApproval
  | CloudStagedToolCall;

/** Staged content IPC result shape.
 *  Accepts string | null (legacy preload shape) OR { content, error } (canonical IPC shape). */
export type StagedContentIpcResult =
  | string
  | null
  | { content: string | null; error?: string };

export interface ReadWorkspaceFileResult {
  content: string;
}

export interface UseApprovalContentOptions {
  /**
   * Platform-specific fetch for the staged content by ID.
   * Desktop: `(id) => window.api.getStagedContent(id)` (legacy `string | null` shape).
   * Mobile:  `(id) => cloudClient.ipcCall('memory:staging-get-content', { id })`.
   */
  readStagedContent: (id: string, signal: AbortSignal) => Promise<StagedContentIpcResult>;

  /**
   * Platform-specific fetch for the remote/original file content.
   * Desktop: `(path) => window.api.readWorkspaceFile(path)`.
   * Mobile:  `(path) => cloudClient.readWorkspaceFile(path)`.
   */
  readWorkspaceFile: (path: string, signal: AbortSignal) => Promise<ReadWorkspaceFileResult>;

  /**
   * Optional host-injected callback used to recover memory approval content
   * from local persistence when inline content is intentionally absent.
   *
   * Returning `null` is treated as a lookup failure (error state), not as
   * successful empty content.
   */
  readMemoryApprovalContent?: (
    identity: MemoryApprovalContentIdentity,
    signal: AbortSignal,
  ) => Promise<string | null>;

  /** Optional structured-logging callback fired on every classified error.
   *  The hook logs to its own logger as well; this hook exists for consumers
   *  that want to forward into Sentry/telemetry pipelines. */
  onError?: (event: ApprovalContentErrorEvent) => void;
}

export interface ApprovalContentErrorEvent {
  itemId: string;
  kind: ApprovalContentErrorKind;
  detail: string;
}

export interface MemoryApprovalContentIdentity {
  toolUseId: string;
  originalSessionId?: string;
  filePath?: string;
  approvalIdentifier?: string;
}

export type ApprovalContentStatus = 'not-loaded' | 'loading' | 'revealed' | 'empty' | 'error';

export interface UseApprovalContentResult {
  /**
   * Explicit content lifecycle state. Prevents callers from inferring
   * "not-loaded" from `staged === null`.
   */
  status: ApprovalContentStatus;
  /** Staged content (inline or fetched). `null` while loading or on fetch failure. */
  staged: string | null;
  /** Original/remote content. `null` when the file is new, ENOENT, or when we
   *  don't fetch it (binary, tool call). */
  original: string | null;
  /** True while either fetch is in-flight. */
  loading: boolean;
  /** User-visible error. `missing` (ENOENT) is surfaced as `isNewFile: true`
   *  with `error: null` instead — per Stage 2 contract, ENOENT is not a
   *  user-visible error. */
  error: ApprovalContentError | null;
  /** True iff the remote file does not / did not exist on disk (metadata
   *  `baseHash === 'new-file'` OR `memoryApproval.isNewFile === true` OR
   *  runtime ENOENT on the remote fetch). */
  isNewFile: boolean;
  /** True iff staged and original both exist and differ. */
  conflict: boolean;
  /** Semantic change type. */
  changeType: ApprovalChangeType;
  /**
   * Re-run the content fetch for the current item. Callers use this to wire
   * a "Retry" affordance to an explicit error state. The in-flight fetch
   * (if any) is aborted before the new request starts, and state resets to
   * `loading: true` synchronously. No-op when `item` is null.
   */
  refetch: () => void;
}

// =============================================================================
// Runtime type guards
// =============================================================================

/** True when the item looks like a {@link StagedFile} (has `baseHash`). */
function isStagedFile(item: ApprovalContentItem): item is StagedFile {
  return 'baseHash' in item && 'realPath' in item;
}

/** True when the item looks like a {@link MemoryWriteApproval}.
 *  Uses `toolUseId` + `filePath` pair since `StagedFile` also has `filePath`-ish fields. */
function isMemoryWriteApproval(item: ApprovalContentItem): item is MemoryWriteApproval {
  return 'toolUseId' in item && 'filePath' in item;
}

/** True when the item looks like a {@link CloudStagedToolCall}. */
function isCloudStagedToolCall(item: ApprovalContentItem): item is CloudStagedToolCall {
  return 'displayName' in item && 'toolCategory' in item;
}

/** Safely extract an item identifier for logging / error events. */
function getItemId(item: ApprovalContentItem): string {
  if (isStagedFile(item)) return item.id;
  if (isMemoryWriteApproval(item)) {
    const record = item as unknown as Record<string, unknown>;
    const originalSessionId = typeof record['originalSessionId'] === 'string' ? record['originalSessionId'] : '';
    const approvalIdentifier = typeof record['approvalIdentifier'] === 'string' ? record['approvalIdentifier'] : '';
    return `${item.toolUseId}|${originalSessionId}|${approvalIdentifier}|${item.filePath}`;
  }
  if (isCloudStagedToolCall(item)) return item.id;
  return '';
}

/** Read the `content` / `contentPreview` field from a memory approval.
 *  Desktop's extended shape has `content`; cloud-client's has only
 *  `contentPreview`. This function tolerates both without TypeScript
 *  breakage by reading via `unknown` index signature. */
function getInlineMemoryContent(item: MemoryWriteApproval): string {
  const record = item as unknown as Record<string, unknown>;
  const content = record['content'];
  if (typeof content === 'string') return content;
  const preview = record['contentPreview'];
  if (typeof preview === 'string') return preview;
  return '';
}

function getMemoryApprovalIdentity(item: MemoryWriteApproval): MemoryApprovalContentIdentity {
  const record = item as unknown as Record<string, unknown>;
  return {
    toolUseId: item.toolUseId,
    originalSessionId: typeof record['originalSessionId'] === 'string' ? record['originalSessionId'] : undefined,
    filePath: item.filePath,
    approvalIdentifier: typeof record['approvalIdentifier'] === 'string' ? record['approvalIdentifier'] : undefined,
  };
}

// =============================================================================
// Hook
// =============================================================================

const NOOP_REFETCH = () => {
  /* no item to refetch */
};

/**
 * Neutral state the hook emits for tool-call items, null items, and as the
 * starting state before any fetch has run. The `refetch` callback is added
 * on the return path (it's stable per-item; the neutral state does not need
 * a distinct identity per render).
 */
const INITIAL_STATE_WITHOUT_REFETCH: Omit<UseApprovalContentResult, 'refetch'> = {
  status: 'not-loaded',
  staged: null,
  original: null,
  loading: false,
  error: null,
  isNewFile: false,
  conflict: false,
  changeType: 'modify',
};

/**
 * Normalize the staged-content IPC result into `string | null`.
 *
 * The canonical IPC shape is `{ content: string | null, error?: string }`.
 * When the IPC surface reports a non-empty `error` (e.g.
 * `'Invalid staged file ID'`), this helper throws a
 * {@link StagedContentIpcError}. Throwing — rather than returning `null`
 * silently — funnels the failure into the effect's existing error-handling
 * branch so the hook surfaces it as a user-visible error AND emits the
 * `approval.content-fetch` breadcrumb. Per Stage 2 Decision D8 in
 * `docs/plans/260416_centralize_approval_and_diff_viewing_ux.md`, staged
 * IPC failures are always hard errors.
 *
 * Legacy shape: raw `string | null` (desktop preload bridge) is passed
 * through as-is; a bare `null` remains a valid "no content" tombstone, not
 * an error. Only the canonical `{ content, error }` object with a
 * non-empty `error` string is treated as a failure here.
 */
function normalizeStagedResult(result: StagedContentIpcResult): string | null {
  if (result === null) return null;
  if (typeof result === 'string') return result;
  if (typeof result === 'object') {
    const rawError = result.error;
    if (typeof rawError === 'string' && rawError.length > 0) {
      throw new StagedContentIpcError(rawError);
    }
    return result.content ?? null;
  }
  return null;
}

/**
 * Fetch staged + original content for an approval item and derive combined
 * state. Cancels on item-id change and on unmount via `AbortController`.
 *
 * Notes for callers:
 * - Returns `loading: true` only when a fetch is in-flight. Tool-call items
 *   and null items resolve to a neutral state synchronously.
 * - For binary extensions, skips fetching content and surfaces
 *   `error.kind = 'binary'` immediately.
 * - ENOENT on the remote read collapses to `isNewFile: true, original: null,
 *   error: null` — matching the Stage 2 failure-mode matrix entry
 *   ("Remote file missing / permission denied when fetching original").
 * - Staged-content IPC failures (whether thrown, or reported via the
 *   canonical `{ content: null, error }` response shape) always surface as
 *   a hook-level error — per D8 in the plan, never silently fall back to
 *   "no content".
 */
export function useApprovalContent(
  item: ApprovalContentItem | null,
  options: UseApprovalContentOptions,
): UseApprovalContentResult {
  const [state, setState] = useState<Omit<UseApprovalContentResult, 'refetch'>>(INITIAL_STATE_WITHOUT_REFETCH);
  // Counter used to trigger a refetch. Incrementing this value re-runs the
  // effect below for the current item without requiring the caller to
  // remount/rekey the hook.
  const [retryCounter, setRetryCounter] = useState(0);

  // Stable refs for the fetch callbacks + error reporter so we don't restart
  // the effect when the caller passes inline arrows.
  const readStagedRef = useRef(options.readStagedContent);
  const readWorkspaceRef = useRef(options.readWorkspaceFile);
  const readMemoryApprovalContentRef = useRef(options.readMemoryApprovalContent);
  const onErrorRef = useRef(options.onError);
  readStagedRef.current = options.readStagedContent;
  readWorkspaceRef.current = options.readWorkspaceFile;
  readMemoryApprovalContentRef.current = options.readMemoryApprovalContent;
  onErrorRef.current = options.onError;

  // Keep track of the latest request to defend against out-of-order resolution.
  const requestIdRef = useRef(0);

  // Identity key we want to react on — ignores unstable object refs.
  const itemId = item ? getItemId(item) : null;

  // Stable refetch callback. The function identity never changes, so callers
  // can use it in effect deps or pass it down without re-triggering work.
  const refetch = useCallback(() => {
    if (item == null) return;
    setRetryCounter((n) => n + 1);
  }, [item]);

  useEffect(() => {
    // Reset when there is no item (dialog closed or transitioning).
    if (item == null) {
      setState(INITIAL_STATE_WITHOUT_REFETCH);
      return;
    }

    // CloudStagedToolCall has no file content to fetch — return neutral state
    // and let callers render the tool-call UX directly.
    if (isCloudStagedToolCall(item)) {
      setState(INITIAL_STATE_WITHOUT_REFETCH);
      return;
    }

    const controller = new AbortController();
    const requestId = ++requestIdRef.current;

    // Derive metadata before any async work.
    const id = getItemId(item);
    const isMetadataNewFile = isStagedFile(item)
      ? item.baseHash === 'new-file'
      : Boolean((item as MemoryWriteApproval).isNewFile);
    const realPath = isStagedFile(item) ? item.realPath : (item as MemoryWriteApproval).filePath;

    // Binary check — extension-based fallback because the IPC layer returns text only.
    if (realPath && isLikelyBinary(realPath)) {
      const err: ApprovalContentError = {
        kind: 'binary',
        detail: `Binary content (${realPath}) cannot be rendered as text.`,
      };
      emitError({ itemId: id, kind: 'binary', detail: err.detail });
      setState({
        status: 'error',
        staged: null,
        original: null,
        loading: false,
        error: err,
        isNewFile: isMetadataNewFile,
        conflict: false,
        changeType: isMetadataNewFile ? 'create' : 'modify',
      });
      return;
    }

    // Signal loading and start the async work.
    setState({ ...INITIAL_STATE_WITHOUT_REFETCH, status: 'loading', loading: true });

    void (async () => {
      // ---------- 1. Staged content ----------
      let staged: string | null = null;
      let stagedFetchBecameStale = false;
      let stagedFetchFailed = false;
      try {
        if (isStagedFile(item)) {
          const result = await readStagedRef.current(item.id, controller.signal);
          // Throws `StagedContentIpcError` when the IPC returns the canonical
          // `{ content, error }` shape with a non-empty `error` — handled
          // below in the catch block.
          staged = normalizeStagedResult(result);
        } else {
          // MemoryWriteApproval — inline content fast-path plus optional
          // host-side recovery for broadcast-first payloads where content is
          // intentionally omitted.
          const memoryItem = item as MemoryWriteApproval;
          const inlineContent = getInlineMemoryContent(memoryItem);
          if (inlineContent.length > 0) {
            staged = inlineContent;
          } else {
            const recoverContent = readMemoryApprovalContentRef.current;
            if (recoverContent && memoryItem.toolUseId.trim().length > 0) {
              const recovered = await recoverContent(
                getMemoryApprovalIdentity(memoryItem),
                controller.signal,
              );
              if (recovered === null) {
                throw new MissingMemoryApprovalContentError(
                  'Could not recover memory approval content for this request.',
                );
              }
              staged = recovered;
            } else {
              staged = inlineContent;
            }
          }
        }
      } catch (err) {
        if (controller.signal.aborted || requestId !== requestIdRef.current) {
          stagedFetchBecameStale = true;
        } else {
        // Staged-content failures are always hard errors per D8 in
        // docs/plans/260416_centralize_approval_and_diff_viewing_ux.md. Classify
        // via the shared helper, but force `StagedContentIpcError` and any
        // `missing` classification into `other` — the staged record should
        // always have content, so neither ENOENT-style nor IPC-reported
        // errors should collapse into the "isNewFile" success path.
          const classified = err instanceof StagedContentIpcError || err instanceof MissingMemoryApprovalContentError
            ? { kind: 'other' as ApprovalContentErrorKind, detail: err.message }
            : classifyReadError(err);
          emitError({ itemId: id, kind: classified.kind, detail: classified.detail });
          setState({
            status: 'error',
            staged: null,
            original: null,
            loading: false,
            error: classified.kind === 'missing' ? { kind: 'other', detail: classified.detail } : classified,
            isNewFile: isMetadataNewFile,
            conflict: false,
            changeType: isMetadataNewFile ? 'create' : 'modify',
          });
          stagedFetchFailed = true;
        }
      }

      if (stagedFetchBecameStale || stagedFetchFailed) return;

      if (controller.signal.aborted || requestId !== requestIdRef.current) return;

      // ---------- 2. Original/remote content ----------
      let original: string | null = null;
      let existsOnDisk = !isMetadataNewFile;
      let fetchError: ApprovalContentError | null = null;
      let runtimeIsNewFile = isMetadataNewFile;
      let originalFetchBecameStale = false;

      if (!isMetadataNewFile && realPath) {
        try {
          const result = await readWorkspaceRef.current(realPath, controller.signal);
          original = result?.content ?? '';
        } catch (err) {
          if (controller.signal.aborted || requestId !== requestIdRef.current) {
            originalFetchBecameStale = true;
          } else {
            const classified = classifyReadError(err);
            if (classified.kind === 'missing') {
              // ENOENT → treat as new file (contract). Emit a log breadcrumb
              // but do NOT surface a user-visible error.
              original = null;
              existsOnDisk = false;
              runtimeIsNewFile = true;
              emitError({ itemId: id, kind: 'missing', detail: classified.detail });
            } else {
              // permission / network / other → user-visible error.
              fetchError = classified;
              emitError({ itemId: id, kind: classified.kind, detail: classified.detail });
            }
          }
        }
      }

      if (originalFetchBecameStale) return;

      if (controller.signal.aborted || requestId !== requestIdRef.current) return;

      const conflict = fetchError === null && detectConflict(staged, original);
      const changeType = detectChangeType(staged, original, existsOnDisk);
      const status: ApprovalContentStatus = fetchError
        ? 'error'
        : (staged === '' || staged === null)
          ? 'empty'
          : 'revealed';

      setState({
        status,
        staged,
        original,
        loading: false,
        error: fetchError,
        isNewFile: runtimeIsNewFile,
        conflict,
        changeType,
      });
    })();

    return () => {
      controller.abort();
    };
    // The effect intentionally depends only on the stable itemId + the
    // retryCounter: the hook is identity-based, not object-based, and
    // callback refs are captured via refs above to keep the effect stable
    // against inline-arrow callbacks. `retryCounter` advances on every
    // `refetch()` call so the fetch re-runs for the same item.
  }, [itemId, retryCounter]);

  return { ...state, refetch: item == null ? NOOP_REFETCH : refetch };

  // Emit a structured log for every classified error, and forward to the
  // optional caller-provided reporter. Stage 2 contract: always observable.
  function emitError(event: ApprovalContentErrorEvent): void {
    log.warn('approval.content-fetch', {
      itemId: event.itemId,
      kind: event.kind,
      detail: event.detail,
    });
    try {
      onErrorRef.current?.(event);
    } catch (reporterErr) {
      log.warn('approval.content-fetch onError reporter threw', {
        itemId: event.itemId,
        err: reporterErr instanceof Error ? reporterErr.message : String(reporterErr),
      });
    }
  }
}
