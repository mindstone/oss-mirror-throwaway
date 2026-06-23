/**
 * useDocumentActions
 *
 * Shared hook for document export, path operations, and breadcrumb computation
 * used by both LibraryEditorPanel and DocumentPreviewDrawer. Extracts ~80 LOC
 * of near-identical logic from each surface.
 *
 * @see docs/plans/finished/260223_unify_document_preview_and_library_editor.md (Stage 5)
 */

import { useState, useCallback, useMemo, useRef } from 'react';
import { exportToPdf, exportToDocx } from '@renderer/utils/exportUtils';
import { showPathOpenFailureToast } from '@renderer/utils/pathOpenFailure';
import { tracking } from '@renderer/src/tracking';

export interface BreadcrumbSegment {
  label: string;
  path: string;
}

export interface UseDocumentActionsOptions {
  /** Document content for exports */
  content: string | null;
  /** File name (used for export default naming) */
  fileName: string;
  /** Absolute file path (for reveal, open, and copy operations) */
  absolutePath: string | null;
  /** Relative file path (for copy and breadcrumb computation) */
  relativePath: string | null;
  /** Toast notification callback. Does NOT need to be memoized. */
  showToast?: (options: { title: string }) => void;
  /** Whether to call tracking.library.exported() on export success. Defaults to false. */
  trackExport?: boolean;
}

export interface UseDocumentActionsResult {
  /** Current export in progress (for disabling buttons / showing loading) */
  exporting: 'pdf' | 'docx' | null;
  /** Breadcrumb path segments for the folder hierarchy (excludes the file itself) */
  breadcrumbSegments: BreadcrumbSegment[];
  /** Enclosing folder relative path (null for root-level files) */
  enclosingFolderPath: string | null;
  exportPdf: () => Promise<void>;
  exportDocx: () => Promise<void>;
  exportMarkdown: () => Promise<void>;
  copyFullPath: () => Promise<void>;
  copyRelativePath: () => Promise<void>;
  revealInFinder: () => void;
  openWithDefaultApp: () => void;
}

export function useDocumentActions({
  content,
  fileName,
  absolutePath,
  relativePath,
  showToast,
  trackExport = false,
}: UseDocumentActionsOptions): UseDocumentActionsResult {
  const [exporting, setExporting] = useState<'pdf' | 'docx' | null>(null);

  // Refs to stabilize callback identities — consumers don't need to memoize inputs
  const contentRef = useRef(content);
  contentRef.current = content;
  const fileNameRef = useRef(fileName);
  fileNameRef.current = fileName;
  const absolutePathRef = useRef(absolutePath);
  absolutePathRef.current = absolutePath;
  const relativePathRef = useRef(relativePath);
  relativePathRef.current = relativePath;
  const showToastRef = useRef(showToast);
  showToastRef.current = showToast;
  const trackExportRef = useRef(trackExport);
  trackExportRef.current = trackExport;
  const exportingRef = useRef<'pdf' | 'docx' | null>(null);

  const exportPdf = useCallback(async () => {
    const c = contentRef.current;
    const fn = fileNameRef.current;
    if (!c || exportingRef.current) return;
    exportingRef.current = 'pdf';
    setExporting('pdf');
    try {
      const result = await exportToPdf(c, fn);
      if (trackExportRef.current) tracking.library.exported('pdf', result.success);
      if (result.success) {
        showToastRef.current?.({ title: 'Exported as PDF successfully' });
      } else if (!result.cancelled) {
        showToastRef.current?.({ title: result.error ?? 'Failed to export PDF' });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showToastRef.current?.({ title: `Failed to export: ${message}` });
    } finally {
      exportingRef.current = null;
      setExporting(null);
    }
  }, []);

  const exportDocx = useCallback(async () => {
    const c = contentRef.current;
    const fn = fileNameRef.current;
    if (!c || exportingRef.current) return;
    exportingRef.current = 'docx';
    setExporting('docx');
    try {
      const result = await exportToDocx(c, fn);
      if (trackExportRef.current) tracking.library.exported('docx', result.success);
      if (result.success) {
        showToastRef.current?.({ title: 'Exported as Word document successfully' });
      } else if (!result.cancelled) {
        showToastRef.current?.({ title: result.error ?? 'Failed to export Word document' });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showToastRef.current?.({ title: `Failed to export: ${message}` });
    } finally {
      exportingRef.current = null;
      setExporting(null);
    }
  }, []);

  const exportMarkdown = useCallback(async () => {
    const c = contentRef.current;
    const fn = fileNameRef.current;
    if (!c) return;
    try {
      const defaultName = fn.replace(/\.(md|markdown)$/i, '') + '.md';
      const encoder = new TextEncoder();
      const data = encoder.encode(c);
      const result = await window.exportApi.saveFile({
        data: data.buffer,
        fileName: defaultName,
        filters: [{ name: 'Markdown', extensions: ['md'] }],
        title: 'Export as Markdown'
      });
      if (result.success) {
        showToastRef.current?.({ title: 'Exported as Markdown successfully' });
      } else if (!result.cancelled) {
        showToastRef.current?.({ title: result.error ?? 'Failed to export Markdown' });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showToastRef.current?.({ title: `Failed to export: ${message}` });
    }
  }, []);

  const copyFullPath = useCallback(async () => {
    const path = absolutePathRef.current;
    if (!path) return;
    try {
      await navigator.clipboard.writeText(path);
      showToastRef.current?.({ title: 'Full path copied' });
    } catch {
      showToastRef.current?.({ title: 'Failed to copy path' });
    }
  }, []);

  const copyRelativePath = useCallback(async () => {
    const path = relativePathRef.current;
    if (!path) return;
    try {
      await navigator.clipboard.writeText(path);
      showToastRef.current?.({ title: 'Relative path copied' });
    } catch {
      showToastRef.current?.({ title: 'Failed to copy path' });
    }
  }, []);

  const revealInFinder = useCallback(() => {
    const path = absolutePathRef.current;
    if (!path) return;
    // FOX-3422: surface a toast when the reveal fails (moved file / blocked access)
    // instead of silently swallowing.
    void window.appApi.revealPath(path).then(
      (result) => showPathOpenFailureToast(result, showToastRef.current),
      (error) => showPathOpenFailureToast(error, showToastRef.current),
    );
  }, []);

  const openWithDefaultApp = useCallback(() => {
    const path = absolutePathRef.current;
    if (!path) return;
    // FOX-3422: app:open-path rejects on failure — surface a toast instead of swallowing.
    void window.appApi.openPath(path).catch((error) =>
      showPathOpenFailureToast(error, showToastRef.current),
    );
  }, []);

  const breadcrumbSegments = useMemo((): BreadcrumbSegment[] => {
    if (!relativePath) return [];
    const parts = relativePath.replace(/\\/g, '/').split('/').filter(Boolean);
    if (parts.length <= 1) return [];
    // Exclude the last segment (filename) — breadcrumbs show only the folder hierarchy
    return parts.slice(0, -1).map((part, index, arr) => ({
      label: part,
      path: arr.slice(0, index + 1).join('/')
    }));
  }, [relativePath]);

  const enclosingFolderPath = useMemo(() => {
    if (!relativePath) return null;
    const normalized = relativePath.replace(/\\/g, '/');
    const lastSlash = normalized.lastIndexOf('/');
    if (lastSlash <= 0) return null;
    return normalized.slice(0, lastSlash);
  }, [relativePath]);

  return {
    exporting,
    breadcrumbSegments,
    enclosingFolderPath,
    exportPdf,
    exportDocx,
    exportMarkdown,
    copyFullPath,
    copyRelativePath,
    revealInFinder,
    openWithDefaultApp,
  };
}
