/**
 * useStagedFiles
 *
 * Hook to load and track staged memory files that are waiting for user review.
 * Staged files are HIGH sensitivity writes that were captured instead of blocking
 * the agent, allowing the user to approve or discard them at their leisure.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { basename } from 'pathe';
import type { BlockSource, FileLocation } from '@rebel/shared';
import { notifyOptimisticRemoval } from './approvalOptimisticRemoval';
import { useIpcEvent } from '@renderer/hooks/useIpcEvent';
import { toUserFacingActionErrorReason } from '@renderer/utils/actionErrorMessage';

/** Staged file metadata from the staging service */
export interface StagedFile {
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
  blockedBy?: BlockSource;
  /** Conflict detected upfront - destination file was modified or created since staging */
  hasConflict?: boolean;
  /**
   * F3-1-residual: extra canonical schema fields pulled from
   * `memory:staging-get-all` so the shared mapper's destination-based dedup
   * and paired-memory cascade work end-to-end on desktop, not just via
   * synthetic test inputs. All optional — older persisted payloads may lack
   * them and the mapper tolerates missing values.
   */
  approvalKind?: 'memory_write' | 'shared_skill_checkpoint';
  authorLabel?: string;
  /** Tool-use id that produced the staged write (paired-memory cascade key). */
  toolUseId?: string;
  /** Optional workspace-relative destination (destination-match fallback key). */
  pendingDestination?: string;
}

/** Staged file with display-friendly properties */
export interface StagedFileItem extends StagedFile {
  fileName: string;
  sessionTitle: string | null;
}

export interface UseStagedFilesReturn {
  files: StagedFileItem[];
  isLoading: boolean;
  refresh: () => Promise<void>;
  publish: (id: string) => Promise<{ success: boolean; hasConflict?: boolean; error?: string }>;
  discard: (id: string) => Promise<{ success: boolean; error?: string }>;
  keepPrivate: (id: string) => Promise<{ success: boolean; error?: string; destinationPath?: string }>;
  /**
   * Resolve a detected conflict by choosing the staged or current-on-disk
   * version. Exposed for callers that want to go through the same optimistic
   * + idempotent-success machinery as `publish` / `keepPrivate` instead of
   * calling `window.api.publishWithConflictResolution` directly.
   */
  resolveConflict: (
    id: string,
    resolution: 'keep-staged' | 'keep-real',
  ) => Promise<{ success: boolean; error?: string }>;
  publishAll: () => Promise<{ published: number; conflicts: number; errors: number }>;
  discardAll: () => Promise<void>;
}

type SessionTitleMap = Map<string, string>;

/**
 * Statuses that semantically mean "the staged row is already in its final
 * terminal state — optimistic removal succeeds even though this surface
 * didn't win the race". Mirrors the cloud-client helper of the same name
 * (see `cloud-client/src/stores/stagedFilesStore.ts`). F3-4 rollout to
 * desktop: apply across Publish / KeepPrivate / Discard / ResolveConflict.
 */
const IDEMPOTENT_SUCCESS_STATUSES = new Set<string>([
  'success',
  'already-resolved',
  'not-found',
]);

function isIdempotentSuccess(status: string): boolean {
  return IDEMPOTENT_SUCCESS_STATUSES.has(status);
}

/**
 * Emit a structured breadcrumb when an idempotent-success path fires. Uses
 * `console.warn` (allowed by ESLint; renderer logs are captured with a
 * `[Renderer]` prefix) so the signal is observable rather than silent.
 */
function logIdempotentSuccess(op: string, id: string, status: string): void {
  // `status === 'success'` is the normal happy path — no breadcrumb needed.
  if (status === 'success') return;
  console.warn(`[useStagedFiles] idempotent ${op} succeeded`, {
    op,
    id,
    status,
    surface: 'desktop',
  });
}

/**
 * Hook to load and manage staged memory files.
 */
export function useStagedFiles(): UseStagedFilesReturn {
  const [files, setFiles] = useState<StagedFileItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const sessionTitlesRef = useRef<SessionTitleMap>(new Map());

  const loadSessionTitles = useCallback(async (): Promise<SessionTitleMap> => {
    try {
      const summaries = await window.sessionsApi.list();
      const map = new Map<string, string>();
      for (const s of summaries) {
        if (s.title) {
          map.set(s.id, s.title);
        }
      }
      sessionTitlesRef.current = map;
      return map;
    } catch (err) {
      console.error('Failed to load session titles:', err);
      return sessionTitlesRef.current;
    }
  }, []);

  const transformFile = useCallback(
    (file: StagedFile, titleMap: SessionTitleMap): StagedFileItem => ({
      ...file,
      fileName: basename(file.realPath),
      sessionTitle: titleMap.get(file.sessionId) ?? null,
    }),
    []
  );

  const loadFiles = useCallback(async () => {
    try {
      const titleMap = await loadSessionTitles();
      const result = await window.api.getStagedFiles();
      // Backend returns { files: [...] }, extract the array
      const stagedFiles = Array.isArray(result) ? result : (result as { files: StagedFile[] }).files ?? [];
      const transformed = stagedFiles.map((f) => transformFile(f, titleMap));
      // Sort by stagedAt (oldest first - they've been waiting longest)
      transformed.sort((a, b) => a.stagedAt - b.stagedAt);
      setFiles(transformed);
    } catch (err) {
      console.error('Failed to load staged files:', err);
    } finally {
      setIsLoading(false);
    }
  }, [loadSessionTitles, transformFile]);

  // Initial load
  useEffect(() => {
    setIsLoading(true);
    void loadFiles();
  }, [loadFiles]);

  // Subscribe to staged files changed events
  useIpcEvent(window.api.onStagedFilesChanged, () => {
    void loadFiles();
  }, [loadFiles]);

  // Poll on window focus
  useEffect(() => {
    const handleFocus = () => void loadFiles();
    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, [loadFiles]);

  const publish = useCallback(async (id: string): Promise<{ 
    success: boolean; 
    hasConflict?: boolean; 
    error?: string;
    conflict?: { realContent: string; stagedContent: string };
  }> => {
    // Optimistic removal (F3-1): suppress the paired memory-approval row
    // immediately via cascade. If the IPC returns conflict / error, the row
    // will re-appear on the next staged-files broadcast / focus refresh.
    notifyOptimisticRemoval(`staged-file:${id}`);
    // Stage C (260417_approval_consolidation_closeout): attach a per-
    // action UUID so the main-process IPC dedup cache can suppress any
    // accidental double-dispatch (double-click, re-mount re-fire).
    // Desktop doesn't use a retry loop, but the key is cheap and keeps
    // the surface consistent with cloud-client.
    const clientDedupKey = crypto.randomUUID();
    try {
      const result = await window.api.publishStagedFile(id, clientDedupKey);
      if (isIdempotentSuccess(result.status)) {
        logIdempotentSuccess('publish', id, result.status);
        setFiles((prev) => prev.filter((f) => f.id !== id));
        return { success: true };
      } else if (result.status === 'conflict' && result.conflict) {
        return {
          success: false,
          hasConflict: true,
          conflict: {
            realContent: result.conflict.realContent,
            stagedContent: result.conflict.stagedContent,
          },
        };
      } else {
        return { success: false, error: toUserFacingActionErrorReason(result.error) };
      }
    } catch (err) {
      console.error('Failed to approve staged file:', err);
      return { success: false, error: toUserFacingActionErrorReason(err) };
    }
  }, []);

  const discard = useCallback(async (id: string): Promise<{ success: boolean; error?: string }> => {
    // Stage C: see `publish`.
    const clientDedupKey = crypto.randomUUID();
    try {
      const result = await window.api.discardStagedFile(id, clientDedupKey);
      if (isIdempotentSuccess(result.status)) {
        logIdempotentSuccess('discard', id, result.status);
        setFiles((prev) => prev.filter((f) => f.id !== id));
        return { success: true };
      } else {
        return { success: false, error: toUserFacingActionErrorReason(result.error) };
      }
    } catch (err) {
      console.error('Failed to discard staged file:', err);
      return { success: false, error: toUserFacingActionErrorReason(err) };
    }
  }, []);

  const keepPrivate = useCallback(async (id: string): Promise<{ success: boolean; error?: string; destinationPath?: string }> => {
    // Optimistic removal (F3-1): see comment in `publish` above.
    notifyOptimisticRemoval(`staged-file:${id}`);
    // Stage C: see `publish`.
    const clientDedupKey = crypto.randomUUID();
    try {
      const result = await window.api.keepStagedFilePrivate(id, clientDedupKey);
      if (isIdempotentSuccess(result.status)) {
        logIdempotentSuccess('keepPrivate', id, result.status);
        setFiles((prev) => prev.filter((f) => f.id !== id));
        return { success: true, destinationPath: result.destinationPath };
      } else {
        return { success: false, error: toUserFacingActionErrorReason(result.error) };
      }
    } catch (err) {
      console.error('Failed to keep staged file private:', err);
      return { success: false, error: toUserFacingActionErrorReason(err) };
    }
  }, []);

  const resolveConflict = useCallback(
    async (
      id: string,
      resolution: 'keep-staged' | 'keep-real',
    ): Promise<{ success: boolean; error?: string }> => {
      // Stage C: see `publish`. Generated here, OUTSIDE the mint call,
      // so that the dedup cache only kicks in once we've actually
      // dispatched the resolve IPC — a retry of JUST the mint step
      // produces a different token and should not be deduped.
      const clientDedupKey = crypto.randomUUID();
      try {
        // Stage B (260417_approval_consolidation_closeout): mint a
        // single-use capability token before calling the resolve
        // handler. A jailbroken agent bypassing this mint step gets
        // rejected with CAPABILITY_* at the handler.
        const mintResult = await window.api.mintConflictCapability(id);
        if (!mintResult.success) {
          console.warn('[useStagedFiles] Failed to mint capability token', {
            id,
            error: mintResult.error,
          });
          return {
            success: false,
            error: `Failed to authorize conflict resolution: ${mintResult.error}`,
          };
        }
        const result = await window.api.publishWithConflictResolution(
          id,
          resolution,
          mintResult.token,
          clientDedupKey,
        );
        if (isIdempotentSuccess(result.status)) {
          logIdempotentSuccess('resolveConflict', id, result.status);
          setFiles((prev) => prev.filter((f) => f.id !== id));
          return { success: true };
        }
        return { success: false, error: toUserFacingActionErrorReason(result.error) };
      } catch (err) {
        console.error('Failed to resolve staged file conflict:', err);
        return { success: false, error: toUserFacingActionErrorReason(err) };
      }
    },
    [],
  );

  const publishAll = useCallback(async (): Promise<{ published: number; conflicts: number; errors: number }> => {
    try {
      const result = await window.api.publishAllStagedFiles();
      // Refresh to get current state
      void loadFiles();
      return {
        published: result.published.length,
        conflicts: result.conflicts.length,
        errors: result.errors.length,
      };
    } catch (err) {
      console.error('Failed to approve all staged files:', err);
      return { published: 0, conflicts: 0, errors: files.length };
    }
  }, [loadFiles, files.length]);

  const discardAll = useCallback(async (): Promise<void> => {
    try {
      await window.api.discardAllStagedFiles();
      setFiles([]);
    } catch (err) {
      console.error('Failed to discard all staged files:', err);
    }
  }, []);

  return {
    files,
    isLoading,
    refresh: loadFiles,
    publish,
    discard,
    keepPrivate,
    resolveConflict,
    publishAll,
    discardAll,
  };
}
