import { create } from 'zustand';
import { ipcCall } from '../cloudClient';
import type { StagedFile } from '../types';
import { createLogger } from '../utils/logger';
import { newClientDedupKey } from '../utils/clientDedupKey';

const log = createLogger('stagedFilesStore');

/**
 * Status values that mean "the staged file has already reached a terminal
 * state and further optimistic removal is a no-op success". Surfacing these
 * as errors would be a lie — the store's desired end state is the same.
 *
 * See FM #26 in the Stage 3 planning doc
 * (docs/plans/260416_centralize_approval_and_diff_viewing_ux.md).
 */
const IDEMPOTENT_SUCCESS_STATUSES = new Set<string>(['success', 'already-resolved', 'not-found']);

function isIdempotentSuccess(status: string): boolean {
  return IDEMPOTENT_SUCCESS_STATUSES.has(status);
}

interface PublishFileResult {
  status: string;
  error?: string;
  conflict?: { realContent: string; stagedContent: string };
}

interface StagedFilesState {
  files: StagedFile[];
  isLoading: boolean;
  error: string | null;

  resetStore: () => void;
  fetchStagedFiles: () => Promise<void>;
  publishFile: (id: string) => Promise<PublishFileResult>;
  discardFile: (id: string) => Promise<{ status: string; error?: string }>;
  keepPrivate: (id: string) => Promise<{ status: string; error?: string }>;
  publishAll: () => Promise<{ published: number; conflicts: number; errors: number }>;
  discardAll: () => Promise<void>;
  /**
   * Resolve a conflict on the server. Requires a capability token minted
   * via `memory:staging-mint-conflict-capability` before calling — the
   * handler now rejects calls without a valid, scoped, single-use token
   * (see Stage B of `docs/plans/260417_approval_consolidation_closeout.md`).
   */
  resolveConflict: (
    id: string,
    resolution: 'keep-staged' | 'keep-real',
    capabilityToken: string,
  ) => Promise<{ status: string; error?: string }>;
  /**
   * Mint a short-lived, scoped, single-use capability token authorizing
   * resolution of the given staged file. Surfaces the typed error codes
   * from `memory:staging-mint-conflict-capability` so callers can
   * classify (`UNKNOWN_STAGED_FILE`, `READ_ONLY`, etc.).
   */
  mintConflictCapability: (
    stagedFileId: string,
  ) => Promise<
    | { success: true; token: string; expiresAt: number }
    | { success: false; error: string }
  >;
  handleStagedFilesChanged: () => void;
}

interface FetchStagedFilesResponse {
  files: StagedFile[];
}

interface PublishAllResponse {
  published: string[];
  conflicts: string[];
  errors: string[];
}

interface StatusResponse {
  status: string;
  error?: string;
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export const useStagedFilesStore = create<StagedFilesState>((set, get) => ({
  files: [],
  isLoading: false,
  error: null,

  resetStore: () => set({
    files: [],
    isLoading: false,
    error: null,
  }),

  fetchStagedFiles: async () => {
    set({ isLoading: true, error: null });

    try {
      const result = await ipcCall<FetchStagedFilesResponse>('memory:staging-get-all');
      set({
        files: Array.isArray(result?.files) ? result.files : [],
        isLoading: false,
        error: null,
      });
    } catch (error) {
      set({
        isLoading: false,
        error: getErrorMessage(error, 'Failed to load staged files'),
      });
    }
  },

  publishFile: async (id: string) => {
    set({ error: null });

    // Stage C (260417_approval_consolidation_closeout): generate the
    // dedup key OUTSIDE `fetchWithRetry` so any retries of the same
    // user action share the same UUID. Server-side cache replays the
    // first response instead of re-running the mutation.
    const clientDedupKey = newClientDedupKey();

    try {
      const result = await ipcCall<PublishFileResult>('memory:staging-publish', {
        id,
        clientDedupKey,
      });

      if (isIdempotentSuccess(result.status)) {
        if (result.status !== 'success') {
          log.info('Idempotent publish — treating as success', { id, status: result.status, op: 'publishFile' });
        }
        set((state) => ({ files: state.files.filter((file) => file.id !== id) }));
      } else if (result.error) {
        set({ error: result.error });
      }

      return result;
    } catch (error) {
      const message = getErrorMessage(error, 'Failed to publish staged file');
      set({ error: message });
      return { status: 'error', error: message };
    }
  },

  discardFile: async (id: string) => {
    set({ error: null });

    // Stage C: see publishFile.
    const clientDedupKey = newClientDedupKey();

    try {
      const result = await ipcCall<StatusResponse>('memory:staging-discard', {
        id,
        clientDedupKey,
      });

      if (isIdempotentSuccess(result.status)) {
        if (result.status !== 'success') {
          log.info('Idempotent discard — treating as success', { id, status: result.status, op: 'discardFile' });
        }
        set((state) => ({ files: state.files.filter((file) => file.id !== id) }));
      } else if (result.error) {
        set({ error: result.error });
      }

      return result;
    } catch (error) {
      const message = getErrorMessage(error, 'Failed to discard staged file');
      set({ error: message });
      return { status: 'error', error: message };
    }
  },

  keepPrivate: async (id: string) => {
    set({ error: null });

    // Stage C: see publishFile.
    const clientDedupKey = newClientDedupKey();

    try {
      const result = await ipcCall<StatusResponse>('memory:staging-keep-private', {
        id,
        clientDedupKey,
      });

      if (isIdempotentSuccess(result.status)) {
        if (result.status !== 'success') {
          log.info('Idempotent keepPrivate — treating as success', { id, status: result.status, op: 'keepPrivate' });
        }
        set((state) => ({ files: state.files.filter((file) => file.id !== id) }));
      } else if (result.error) {
        set({ error: result.error });
      }

      return result;
    } catch (error) {
      const message = getErrorMessage(error, 'Failed to keep staged file private');
      set({ error: message });
      return { status: 'error', error: message };
    }
  },

  publishAll: async () => {
    set({ error: null });

    try {
      const result = await ipcCall<PublishAllResponse>('memory:staging-publish-all');
      await get().fetchStagedFiles();
      return {
        published: result.published.length,
        conflicts: result.conflicts.length,
        errors: result.errors.length,
      };
    } catch (error) {
      const message = getErrorMessage(error, 'Failed to publish staged files');
      set({ error: message });
      return { published: 0, conflicts: 0, errors: 0 };
    }
  },

  discardAll: async () => {
    set({ error: null });

    try {
      await ipcCall('memory:staging-discard-all');
      set({ files: [] });
    } catch (error) {
      set({ error: getErrorMessage(error, 'Failed to discard staged files') });
    }
  },

  resolveConflict: async (
    id: string,
    resolution: 'keep-staged' | 'keep-real',
    capabilityToken: string,
  ) => {
    set({ error: null });

    // Defense-in-depth: surface a clear error instead of reaching the
    // server with an empty token (which the handler would reject with
    // CAPABILITY_MALFORMED anyway). Stage B — see planning doc
    // 260417_approval_consolidation_closeout.md.
    if (typeof capabilityToken !== 'string' || capabilityToken.length === 0) {
      const message = 'Missing capability token';
      set({ error: message });
      return { status: 'error', error: message };
    }

    // Stage C: see publishFile. Generated BEFORE the retry loop (i.e.
    // outside `fetchWithRetry`) so transparent retries of the same user
    // action share the same dedup key; the server replays the cached
    // response instead of consuming the capability-token nonce twice
    // and landing on CAPABILITY_REUSED.
    const clientDedupKey = newClientDedupKey();

    try {
      const result = await ipcCall<StatusResponse>('memory:staging-resolve-conflict', {
        id,
        resolution,
        capabilityToken,
        clientDedupKey,
      });

      if (isIdempotentSuccess(result.status)) {
        if (result.status !== 'success') {
          log.info('Idempotent conflict resolution — treating as success', {
            id,
            status: result.status,
            resolution,
            op: 'resolveConflict',
          });
        }
        set((state) => ({ files: state.files.filter((file) => file.id !== id) }));
      } else if (result.error === 'CAPABILITY_REUSED') {
        // F-B-R2-7: `fetchWithRetry` auto-retries transient/network
        // failures. When the first resolve succeeded on the server but
        // the response got lost (e.g. TCP reset after commit), the
        // retry arrives with a nonce that the server has already
        // consumed. Treat this as idempotent success — the user's
        // action already completed, just the network ate the
        // confirmation. Remove the row and surface no error.
        log.info('Conflict-resolution retry landed after first success — treating REUSED as idempotent', {
          id,
          resolution,
          op: 'resolveConflict',
        });
        set((state) => ({ files: state.files.filter((file) => file.id !== id) }));
        return { status: 'already-resolved' };
      } else if (result.error) {
        set({ error: result.error });
      }

      return result;
    } catch (error) {
      const message = getErrorMessage(error, 'Failed to resolve staged file conflict');
      set({ error: message });
      return { status: 'error', error: message };
    }
  },

  mintConflictCapability: async (stagedFileId: string) => {
    try {
      const result = await ipcCall<
        | { success: true; token: string; expiresAt: number }
        | { success: false; error: string }
      >('memory:staging-mint-conflict-capability', { stagedFileId });
      return result;
    } catch (error) {
      const message = getErrorMessage(error, 'Failed to mint capability token');
      log.warn('Failed to mint conflict-resolution capability token', { stagedFileId, message });
      return { success: false, error: message };
    }
  },

  handleStagedFilesChanged: () => {
    void get().fetchStagedFiles();
  },
}));
