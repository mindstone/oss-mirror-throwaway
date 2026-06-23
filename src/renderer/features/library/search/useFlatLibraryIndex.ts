import type { useLibraryIndex } from '../hooks/useLibraryIndex';
import type { FlatLibraryEntry } from './types';

type LibraryIndexState = ReturnType<typeof useLibraryIndex>;

const EMPTY_FILES: FlatLibraryEntry[] = [];

export interface FlatLibraryIndexState {
  files: FlatLibraryEntry[];
  /** Mirrors useLibraryIndex.filesRef and may be null before first load or after failed refresh. */
  filesRef: React.RefObject<FlatLibraryEntry[] | null>;
  isLoading: boolean;
  error: string | null;
  hasLoaded: boolean;
  refresh: () => Promise<void>;
}

export const useFlatLibraryIndex = (
  state: Pick<LibraryIndexState, 'files' | 'filesRef' | 'loading' | 'error' | 'hasLoaded' | 'refresh'>
): FlatLibraryIndexState => {
  return {
    files: state.files ?? EMPTY_FILES,
    filesRef: state.filesRef,
    isLoading: state.loading,
    error: state.error,
    hasLoaded: state.hasLoaded,
    refresh: state.refresh,
  };
};
