import { useState, useCallback, useRef, useEffect } from 'react';

export interface UseScratchpadOptions {
  coreDirectory: string | null;
  onError?: (message: string) => void;
}

export interface Selection {
  start: number;
  end: number;
  text: string;
}

export interface UseScratchpadReturn {
  content: string;
  setContent: (content: string) => void;
  loading: boolean;
  error: string | null;
  isDirty: boolean;
  lastModified: number | null;
  save: (contentOverride?: string) => Promise<void>;
  load: () => Promise<string>;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  selection: Selection | null;
  updateSelection: () => void;
}

export const useScratchpad = ({ coreDirectory, onError }: UseScratchpadOptions): UseScratchpadReturn => {
  const [content, setContent] = useState('');
  const [originalContent, setOriginalContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastModified, setLastModified] = useState<number | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isDirty = content !== originalContent;

  const load = useCallback(async (): Promise<string> => {
    if (!coreDirectory) return '';
    
    setLoading(true);
    setError(null);
    
    try {
      const result = await window.scratchpadApi.load({});
      setContent(result.content);
      setOriginalContent(result.content);
      setLastModified(result.lastModified);
      return result.content;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      onError?.(message);
      return '';
    } finally {
      setLoading(false);
    }
  }, [coreDirectory, onError]);

  const save = useCallback(async (contentOverride?: string) => {
    const contentToSave = contentOverride ?? content;
    if (!coreDirectory) return;
    if (contentToSave === originalContent) return;
    
    try {
      await window.scratchpadApi.save({ content: contentToSave });
      setOriginalContent(contentToSave);
      setLastModified(Date.now());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      onError?.(message);
    }
  }, [coreDirectory, content, originalContent, onError]);

  // Debounced auto-save
  useEffect(() => {
    if (!isDirty) return;
    
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }
    
    saveTimeoutRef.current = setTimeout(() => {
      void save();
    }, 1000);
    
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, [content, isDirty, save]);

  const updateSelection = useCallback(() => {
    if (!textareaRef.current) {
      setSelection(null);
      return;
    }
    
    const { selectionStart, selectionEnd, value } = textareaRef.current;
    if (selectionStart === selectionEnd) {
      setSelection(null);
      return;
    }
    
    setSelection({
      start: selectionStart,
      end: selectionEnd,
      text: value.slice(selectionStart, selectionEnd)
    });
  }, []);

  return {
    content,
    setContent,
    loading,
    error,
    isDirty,
    lastModified,
    save,
    load,
    textareaRef,
    selection,
    updateSelection
  };
};
