import { useCallback, useEffect, useMemo, useState } from 'react';
import { assertNever } from '@shared/utils/assertNever';

export type EditorKioskLevel = 'off' | 'wide' | 'zen';

export function getNextEditorKioskLevel(level: EditorKioskLevel): EditorKioskLevel {
  switch (level) {
    case 'off':
      return 'wide';
    case 'wide':
      return 'zen';
    case 'zen':
      return 'off';
    default:
      return assertNever(level);
  }
}

interface UseEditorKioskOptions {
  editorOpen: boolean;
  librarySurfaceActive: boolean;
}

interface UseEditorKioskResult {
  level: EditorKioskLevel;
  isActive: boolean;
  cycleLevel: () => void;
  clearLevel: () => void;
}

export function useEditorKiosk({
  editorOpen,
  librarySurfaceActive,
}: UseEditorKioskOptions): UseEditorKioskResult {
  const [level, setLevel] = useState<EditorKioskLevel>('off');

  const clearLevel = useCallback(() => {
    setLevel('off');
  }, []);

  const cycleLevel = useCallback(() => {
    if (!editorOpen || !librarySurfaceActive) {
      setLevel('off');
      return;
    }
    setLevel((previous) => getNextEditorKioskLevel(previous));
  }, [editorOpen, librarySurfaceActive]);

  useEffect(() => {
    if (!editorOpen || !librarySurfaceActive) {
      setLevel('off');
    }
  }, [editorOpen, librarySurfaceActive]);

  return useMemo(
    () => ({
      level,
      isActive: level !== 'off',
      cycleLevel,
      clearLevel,
    }),
    [level, cycleLevel, clearLevel],
  );
}
