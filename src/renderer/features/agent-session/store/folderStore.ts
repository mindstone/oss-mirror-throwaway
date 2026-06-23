import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { useShallow } from 'zustand/react/shallow';
import type { ConversationFolder, FolderStoreData } from '@shared/ipc/schemas/folders';
import { createId } from '@shared/utils/id';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';
import { tracking } from '@renderer/src/tracking';

const COLLAPSE_STORAGE_KEY = 'rebel:folder-collapse-state';
const DONE_COLLAPSE_STORAGE_KEY = 'rebel:folder-done-collapse-state';
const SAVE_DEBOUNCE_MS = 300;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FolderDeleteUndoResult {
  folderName: string;
  childCount: number;
  undo: () => void;
  commitDelete: () => void;
}

interface FolderStoreState {
  folders: ConversationFolder[];
  /** sessionId → folderId */
  membership: Record<string, string>;
  /** folderId → collapsed? */
  collapseState: Record<string, boolean>;
  /** folderId → done-subsection collapsed? (default: collapsed when absent) */
  doneCollapseState: Record<string, boolean>;
  loaded: boolean;

  // Actions
  loadFolders: () => Promise<void>;
  createFolder: (name: string) => string;
  renameFolder: (id: string, name: string) => void;
  deleteFolder: (id: string) => void;
  deleteFolderWithUndo: (id: string) => FolderDeleteUndoResult | null;
  moveSessionToFolder: (sessionId: string, folderId: string) => void;
  removeSessionFromFolder: (sessionId: string) => void;
  toggleFolderCollapse: (folderId: string) => void;
  toggleFolderDoneCollapse: (folderId: string) => void;
  flushFolderState: () => void;
}

// ---------------------------------------------------------------------------
// Debounced save helpers (module-scoped to avoid closure leaks)
// ---------------------------------------------------------------------------

let saveTimer: ReturnType<typeof setTimeout> | null = null;

function cancelPendingSave(): void {
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
}

function buildPersistPayload(state: FolderStoreState): FolderStoreData {
  return {
    version: 1 as const,
    folders: state.folders,
    membership: state.membership,
  };
}

function scheduleSave(getState: () => FolderStoreState): void {
  cancelPendingSave();
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const payload = buildPersistPayload(getState());
    window.foldersApi.save(payload).catch((err: unknown) => {
      console.warn('[folderStore] Failed to save folder state:', err);
    });
  }, SAVE_DEBOUNCE_MS);
}

function saveCollapseToLocalStorage(collapseState: Record<string, boolean>): void {
  try {
    localStorage.setItem(COLLAPSE_STORAGE_KEY, JSON.stringify(collapseState));
  } catch {
    // localStorage quota or unavailable — non-critical
  }
}

function loadCollapseFromLocalStorage(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(COLLAPSE_STORAGE_KEY);
    if (raw) return JSON.parse(raw) as Record<string, boolean>;
  } catch {
    // corrupted or unavailable — start fresh
  }
  return {};
}

function saveDoneCollapseToLocalStorage(doneCollapseState: Record<string, boolean>): void {
  try {
    localStorage.setItem(DONE_COLLAPSE_STORAGE_KEY, JSON.stringify(doneCollapseState));
  } catch (error) {
    // localStorage quota or unavailable — collapse state is a disposable UI pref.
    ignoreBestEffortCleanup(error, {
      operation: 'folderStore.saveDoneCollapseToLocalStorage',
      reason: 'localStorage unavailable or over quota; done-subsection collapse state is non-critical UI pref',
    });
  }
}

function loadDoneCollapseFromLocalStorage(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(DONE_COLLAPSE_STORAGE_KEY);
    if (raw) return JSON.parse(raw) as Record<string, boolean>;
  } catch (error) {
    // corrupted or unavailable — start fresh.
    ignoreBestEffortCleanup(error, {
      operation: 'folderStore.loadDoneCollapseFromLocalStorage',
      reason: 'localStorage unavailable or corrupted; defaulting done-subsection collapse state to empty',
    });
  }
  return {};
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useFolderStore = create<FolderStoreState>()(
  devtools(
    (set, get) => ({
      folders: [],
      membership: {},
      collapseState: {},
      doneCollapseState: {},
      loaded: false,

      loadFolders: async () => {
        try {
          const data = await window.foldersApi.load();
          const savedCollapse = loadCollapseFromLocalStorage();
          const savedDoneCollapse = loadDoneCollapseFromLocalStorage();
          set({
            folders: data.folders,
            membership: data.membership,
            collapseState: savedCollapse,
            doneCollapseState: savedDoneCollapse,
            loaded: true,
          });
        } catch (err) {
          console.warn('[folderStore] Failed to load folders:', err);
          set({ loaded: true });
        }
      },

      createFolder: (name: string) => {
        const now = Date.now();
        const id = `fldr_${createId()}`;
        const folder: ConversationFolder = { id, name, createdAt: now, updatedAt: now };
        set((s) => ({ folders: [...s.folders, folder] }));
        scheduleSave(get);
        tracking.folders.created(id);
        return id;
      },

      renameFolder: (id: string, name: string) => {
        set((s) => ({
          folders: s.folders.map((f) =>
            f.id === id ? { ...f, name, updatedAt: Date.now() } : f,
          ),
        }));
        scheduleSave(get);
        tracking.folders.renamed(id);
      },

      deleteFolder: (id: string) => {
        set((s) => {
          const nextMembership = { ...s.membership };
          for (const [sessionId, folderId] of Object.entries(nextMembership)) {
            if (folderId === id) delete nextMembership[sessionId];
          }
          return {
            folders: s.folders.filter((f) => f.id !== id),
            membership: nextMembership,
          };
        });
        scheduleSave(get);
        tracking.folders.deleted(id);
      },

      deleteFolderWithUndo: (id: string): FolderDeleteUndoResult | null => {
        const state = get();
        const folder = state.folders.find((f) => f.id === id);
        if (!folder) return null;

        const affectedMembership: Record<string, string> = {};
        for (const [sessionId, folderId] of Object.entries(state.membership)) {
          if (folderId === id) affectedMembership[sessionId] = folderId;
        }
        const childCount = Object.keys(affectedMembership).length;

        set((s) => {
          const nextMembership = { ...s.membership };
          for (const sessionId of Object.keys(affectedMembership)) {
            delete nextMembership[sessionId];
          }
          return {
            folders: s.folders.filter((f) => f.id !== id),
            membership: nextMembership,
          };
        });

        tracking.folders.deleted(id);
        cancelPendingSave();

        return {
          folderName: folder.name,
          childCount,
          undo: () => {
            set((s) => ({
              folders: [...s.folders, folder],
              membership: { ...s.membership, ...affectedMembership },
            }));
            scheduleSave(get);
          },
          commitDelete: () => {
            scheduleSave(get);
          },
        };
      },

      moveSessionToFolder: (sessionId: string, folderId: string) => {
        set((s) => ({ membership: { ...s.membership, [sessionId]: folderId } }));
        scheduleSave(get);
        tracking.sessionFolder.movedToFolder(sessionId, folderId);
      },

      removeSessionFromFolder: (sessionId: string) => {
        set((s) => {
          const { [sessionId]: _, ...rest } = s.membership;
          return { membership: rest };
        });
        scheduleSave(get);
        tracking.sessionFolder.removedFromFolder(sessionId);
      },

      toggleFolderCollapse: (folderId: string) => {
        set((s) => {
          const next = { ...s.collapseState, [folderId]: !s.collapseState[folderId] };
          saveCollapseToLocalStorage(next);
          return { collapseState: next };
        });
      },

      toggleFolderDoneCollapse: (folderId: string) => {
        set((s) => {
          // Default state is collapsed (absent === true); first toggle expands.
          const current = s.doneCollapseState[folderId] === undefined ? true : s.doneCollapseState[folderId];
          const next = { ...s.doneCollapseState, [folderId]: !current };
          saveDoneCollapseToLocalStorage(next);
          return { doneCollapseState: next };
        });
      },

      flushFolderState: () => {
        cancelPendingSave();
        const payload = buildPersistPayload(get());
        try {
          window.foldersApi.saveSync(payload);
        } catch (err) {
          console.warn('[folderStore] Sync flush failed:', err);
        }
      },
    }),
    {
      name: 'FolderStore',
      enabled: import.meta.env.DEV,
    },
  ),
);

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

export const useFolders = () => useFolderStore((s) => s.folders);
export const useFolderMembership = () => useFolderStore((s) => s.membership);
export const useFolderCollapseState = () => useFolderStore((s) => s.collapseState);
export const useFolderDoneCollapseState = () => useFolderStore((s) => s.doneCollapseState);

export const useFolderActions = () =>
  useFolderStore(
    useShallow((s) => ({
      loadFolders: s.loadFolders,
      createFolder: s.createFolder,
      renameFolder: s.renameFolder,
      deleteFolder: s.deleteFolder,
      deleteFolderWithUndo: s.deleteFolderWithUndo,
      moveSessionToFolder: s.moveSessionToFolder,
      removeSessionFromFolder: s.removeSessionFromFolder,
      toggleFolderCollapse: s.toggleFolderCollapse,
      toggleFolderDoneCollapse: s.toggleFolderDoneCollapse,
      flushFolderState: s.flushFolderState,
    })),
  );

export const getFolderStoreState = () => useFolderStore.getState();
