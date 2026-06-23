import { useCallback, useEffect, useRef, useState } from 'react';
import type { InboxItem } from '@shared/types';

const DEFAULT_UNDO_EXPIRY_MS = 8_000;

/** Generates a unique undo ID. Extracted for test mockability. */
export function generateUndoId(): string {
  return crypto.randomUUID();
}

export type UndoAction = 'archive' | 'dismiss' | 'done' | 'execute' | 'schedule' | 'batch-archive' | 'batch-dismiss' | 'batch-done';

export type UndoEntry = {
  id: string;
  action: UndoAction;
  items: InboxItem[];
  timestamp: number;
};

type StoredUndo = {
  entry: UndoEntry;
  timer: ReturnType<typeof setTimeout>;
  reverseCallback: () => Promise<void>;
};

export type UseUndoStackResult = {
  pushUndo: (action: UndoAction, items: InboxItem[], reverseCallback: () => Promise<void>, expiryMs?: number) => string;
  executeUndo: (undoId: string) => Promise<boolean>;
  clearAll: () => void;
  hasPendingUndo: boolean;
};

export function useUndoStack(): UseUndoStackResult {
  const mapRef = useRef<Map<string, StoredUndo>>(new Map());
  const [entryCount, setEntryCount] = useState(0);

  const removeEntry = useCallback((id: string) => {
    const stored = mapRef.current.get(id);
    if (stored) {
      clearTimeout(stored.timer);
      mapRef.current.delete(id);
      setEntryCount(mapRef.current.size);
    }
  }, []);

  const pushUndo = useCallback(
    (action: UndoAction, items: InboxItem[], reverseCallback: () => Promise<void>, expiryMs = DEFAULT_UNDO_EXPIRY_MS): string => {
      const id = generateUndoId();
      const entry: UndoEntry = { id, action, items, timestamp: Date.now() };
      const timer = setTimeout(() => removeEntry(id), expiryMs);

      mapRef.current.set(id, { entry, timer, reverseCallback });
      setEntryCount(mapRef.current.size);
      return id;
    },
    [removeEntry],
  );

  const executeUndo = useCallback(
    async (undoId: string): Promise<boolean> => {
      const stored = mapRef.current.get(undoId);
      if (!stored) return false;

      removeEntry(undoId);
      try {
        await stored.reverseCallback();
        return true;
      } catch {
        return false;
      }
    },
    [removeEntry],
  );

  const clearAll = useCallback(() => {
    for (const stored of mapRef.current.values()) {
      clearTimeout(stored.timer);
    }
    mapRef.current.clear();
    setEntryCount(0);
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    return () => {
      for (const stored of map.values()) {
        clearTimeout(stored.timer);
      }
      map.clear();
    };
  }, []);

  return { pushUndo, executeUndo, clearAll, hasPendingUndo: entryCount > 0 };
}
