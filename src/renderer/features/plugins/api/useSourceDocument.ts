/**
 * useSourceDocument — Plugin hook for loading a single source document
 *
 * Fetches the full document (metadata + content) when relativePath changes.
 * Uses AbortController-style cleanup to prevent state updates after unmount.
 *
 * @see src/main/ipc/pluginHandlers.ts — get-source-document handler
 * @see src/core/services/sourceMetadataStore.ts — getSource() implementation
 */

import { useState, useEffect } from 'react';
import type { SourceDocument, UseSourceDocumentResult } from './types';
import { usePluginId } from './PluginContext';

export function useSourceDocument(relativePath: string): UseSourceDocumentResult {
  const pluginId = usePluginId();
  const [document, setDocument] = useState<SourceDocument | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const trimmed = relativePath.trim();
    if (!trimmed) {
      setDocument(null);
      setIsLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setIsLoading(true);
    setError(null);

    (async () => {
      try {
        if (typeof window === 'undefined' || !window.pluginsApi?.getSourceDocument) {
          throw new Error('Source document API not available');
        }

        const response = await window.pluginsApi.getSourceDocument({ pluginId, relativePath: trimmed });

        if (!cancelled) {
          setDocument(response.document);
          setIsLoading(false);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load source document');
          setIsLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [pluginId, relativePath]);

  return { document, isLoading, error };
}
