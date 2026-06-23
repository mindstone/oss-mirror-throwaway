import { createContext, useContext, type ReactNode } from 'react';
import type { MentionFilterType, UnifiedMentionResult } from '@renderer/features/mentions';
import type { FlatFileEntry } from '@renderer/utils/librarySearch';

export interface MentionContextValue {
  /** Unified mention search function (files + conversations + commands + models) */
  mentionResultsForQuery: (query: string, filter?: MentionFilterType) => UnifiedMentionResult[];
  /** Trigger library index loading if needed */
  ensureLibraryIndex: () => void;
  /** Convert absolute path to library-relative path */
  getRelativeLibraryPath: (fullPath: string) => string;
  /** Whether a workspace/library is configured */
  hasWorkspace: boolean;
  /** Whether conversation history is available for mentions */
  hasConversations: boolean;
  /** Workspace core directory path */
  coreDirectory: string | null | undefined;
  /** Flattened library file index */
  libraryIndex: FlatFileEntry[] | null;
  /** Whether library index is currently loading */
  libraryIndexLoading: boolean;
  /** Error from library index loading, if any */
  libraryIndexError: string | null;
  /** Refresh the library file index */
  refreshLibraryIndex: () => Promise<void>;
}

const MentionContext = createContext<MentionContextValue | null>(null);

interface MentionProviderProps {
  value: MentionContextValue;
  children: ReactNode;
}

/**
 * Provides mention-related state and callbacks to consumer components.
 * Eliminates prop drilling of the 10-prop mention bundle through surfaces.
 *
 * Place this above FlowPanelsShell so all surface panels can access mention data.
 * The `value` prop should be a memoized object from the parent (App.tsx).
 */
export function MentionProvider({ value, children }: MentionProviderProps) {
  return (
    <MentionContext.Provider value={value}>
      {children}
    </MentionContext.Provider>
  );
}

/**
 * Hook to access mention context. Must be used within a MentionProvider.
 */
export function useMentionContext(): MentionContextValue {
  const context = useContext(MentionContext);
  if (context === null) {
    throw new Error('useMentionContext must be used within a MentionProvider');
  }
  return context;
}
