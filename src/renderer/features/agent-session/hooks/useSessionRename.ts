import { useCallback, useState, useRef, useEffect } from 'react';

const MAX_TITLE_LENGTH = 48;

type UseSessionRenameOptions = {
  onRename: (sessionId: string, newTitle: string) => void;
};

type UseSessionRenameResult = {
  editingSessionId: string | null;
  editValue: string;
  inputRef: React.RefObject<HTMLInputElement | null>;
  startRename: (sessionId: string, currentTitle: string) => void;
  handleEditChange: (value: string) => void;
  handleEditKeyDown: (event: React.KeyboardEvent<HTMLInputElement>, originalTitle: string) => void;
  handleEditBlur: (sessionId: string, originalTitle: string) => void;
  cancelRename: () => void;
};

export const useSessionRename = ({ onRename }: UseSessionRenameOptions): UseSessionRenameResult => {
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);
  const originalTitleRef = useRef<string>('');

  const startRename = useCallback((sessionId: string, currentTitle: string) => {
    setEditingSessionId(sessionId);
    setEditValue(currentTitle);
    originalTitleRef.current = currentTitle;
  }, []);

  const commitRename = useCallback(
    (sessionId: string, originalTitle: string) => {
      const trimmed = editValue.trim().slice(0, MAX_TITLE_LENGTH);
      if (trimmed && trimmed !== originalTitle) {
        onRename(sessionId, trimmed);
      }
      setEditingSessionId(null);
      setEditValue('');
    },
    [editValue, onRename]
  );

  const cancelRename = useCallback(() => {
    setEditingSessionId(null);
    setEditValue('');
  }, []);

  const handleEditChange = useCallback((value: string) => {
    setEditValue(value.slice(0, MAX_TITLE_LENGTH));
  }, []);

  const handleEditKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>, originalTitle: string) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        if (editingSessionId) {
          commitRename(editingSessionId, originalTitle);
        }
      } else if (event.key === 'Escape') {
        event.preventDefault();
        cancelRename();
      }
    },
    [cancelRename, commitRename, editingSessionId]
  );

  const handleEditBlur = useCallback(
    (sessionId: string, originalTitle: string) => {
      commitRename(sessionId, originalTitle);
    },
    [commitRename]
  );

  useEffect(() => {
    if (editingSessionId && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingSessionId]);

  return {
    editingSessionId,
    editValue,
    inputRef,
    startRename,
    handleEditChange,
    handleEditKeyDown,
    handleEditBlur,
    cancelRename
  };
};
