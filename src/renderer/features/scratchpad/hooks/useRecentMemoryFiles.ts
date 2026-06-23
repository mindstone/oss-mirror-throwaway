import { useState, useCallback, useEffect } from 'react';

export interface MemoryFileInfo {
  path: string;
  relativePath: string;
  name: string;
  updatedAt: number;
}

export interface UseRecentMemoryFilesOptions {
  coreDirectory: string | null;
  enabled: boolean;
}

export interface UseRecentMemoryFilesReturn {
  files: MemoryFileInfo[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export const useRecentMemoryFiles = ({ 
  coreDirectory, 
  enabled 
}: UseRecentMemoryFilesOptions): UseRecentMemoryFilesReturn => {
  const [files, setFiles] = useState<MemoryFileInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!coreDirectory || !enabled) return;
    
    setLoading(true);
    setError(null);
    
    try {
      const result = await window.scratchpadApi.listRecentMemoryFiles({ limit: 5 });
      setFiles(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setFiles([]);
    } finally {
      setLoading(false);
    }
  }, [coreDirectory, enabled]);

  useEffect(() => {
    if (enabled) {
      void refresh();
    }
  }, [enabled, refresh]);

  return {
    files,
    loading,
    error,
    refresh
  };
};
