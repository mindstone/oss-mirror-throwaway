import { useCallback, useEffect, useRef, useState, memo } from 'react';
import type { ChangeEvent } from 'react';
import {
  X, Copy, Lock, Globe, MoreHorizontal, FolderOpen, Folder,
  Download, FileText, Link, ExternalLink, PenLine, FolderInput,
  Trash2, Globe2, Check, History, ImagePlus, Loader2,
} from 'lucide-react';
import {
  useFloating,
  autoUpdate,
  offset,
  flip,
  shift,
  useClick,
  useDismiss,
  useRole,
  useInteractions,
  FloatingPortal,
} from '@floating-ui/react';
import { cn } from '@renderer/lib/utils';
import { IconButton, Tooltip } from '@renderer/components/ui';
import { getFilePrivacy } from '@renderer/utils/documentUtils';
import type { FileCategory } from '@renderer/utils/documentUtils';
import type { EditorKioskLevel } from '../hooks/useEditorKiosk';
import styles from './UnifiedDocumentEditor.module.css';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform);
const FOCUS_SHORTCUT_LABEL = isMac ? '⌘\\' : 'Ctrl+\\';

function getFocusButtonLabel(kioskLevel: EditorKioskLevel): string {
  switch (kioskLevel) {
    case 'off':
      return 'Focus';
    case 'wide':
      return 'Zen';
    case 'zen':
      return 'Exit';
    default:
      return 'Focus';
  }
}

function getFocusTooltipContent(kioskLevel: EditorKioskLevel): string {
  switch (kioskLevel) {
    case 'off':
      return `Focus document (${FOCUS_SHORTCUT_LABEL})`;
    case 'wide':
      return `Enter Zen mode (${FOCUS_SHORTCUT_LABEL})`;
    case 'zen':
      return `Exit focus (Esc or ${FOCUS_SHORTCUT_LABEL})`;
    default:
      return `Focus document (${FOCUS_SHORTCUT_LABEL})`;
  }
}

function getFocusAriaLabel(kioskLevel: EditorKioskLevel): string {
  switch (kioskLevel) {
    case 'off':
      return 'Focus document';
    case 'wide':
      return 'Enter Zen mode (hides file list and chrome)';
    case 'zen':
      return 'Exit focus';
    default:
      return 'Focus document';
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BreadcrumbSegment {
  path: string;
  label: string;
}

interface DocumentActionsResult {
  breadcrumbSegments: BreadcrumbSegment[];
  enclosingFolderPath: string | null;
  exporting: 'pdf' | 'docx' | null;
  copyFullPath: () => Promise<void>;
  copyRelativePath: () => Promise<void>;
  revealInFinder: () => void;
  exportPdf: () => Promise<void>;
  exportDocx: () => Promise<void>;
  exportMarkdown: () => Promise<void>;
  openWithDefaultApp: () => void;
}

interface MarkdownImageUploadControls {
  canUpload: boolean;
  isUploading: boolean;
  inputProps: {
    accept: string;
    multiple: false;
    disabled: boolean;
    onChange: (event: ChangeEvent<HTMLInputElement>) => void;
  };
}

interface DocumentHeaderProps {
  fileName: string;
  documentPath: string | null;
  absolutePath: string | null;
  fileCategory: FileCategory;
  isMarkdownFile: boolean;
  isEditing: boolean;
  isDirty: boolean;
  isSaving: boolean;
  justSaved: boolean;
  statusText: string;

  documentActions: DocumentActionsResult;

  // Copy content
  content: string | null;
  showToast?: (options: { title: string }) => void;

  // Focus / kiosk controls
  kioskModeEnabled?: boolean;
  kioskLevel?: EditorKioskLevel;
  onToggleKioskMode?: () => void;
  relativePath?: string | null;
  onRevealInTree?: () => void;

  // Navigation
  onNavigateToFolder?: (path: string) => void;
  onOpenInLibrary?: (path: string) => void;
  onClose: () => void;

  // File management
  onRename?: () => void;
  onDelete?: () => void;
  onMoveTo?: () => void;

  // Open in browser for tutorials/HTML
  showOpenInBrowser: boolean;
  onOpenInBrowser: () => void;

  // Version history (shared skills)
  onViewHistory?: () => void;

  // Save
  onSave: () => void;

  // Markdown image upload
  markdownImageUpload?: MarkdownImageUploadControls;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const DocumentHeaderComponent = ({
  fileName,
  documentPath,
  absolutePath,
  fileCategory,
  isMarkdownFile,
  isEditing: _isEditing,
  isDirty,
  isSaving: _isSaving,
  justSaved: _justSaved,
  statusText: _statusText,
  documentActions,
  content,
  showToast,
  kioskModeEnabled = false,
  kioskLevel = kioskModeEnabled ? 'wide' : 'off',
  onToggleKioskMode,
  relativePath,
  onRevealInTree,
  onNavigateToFolder,
  onOpenInLibrary,
  onClose,
  onRename,
  onDelete,
  onMoveTo,
  showOpenInBrowser,
  onOpenInBrowser,
  onViewHistory,
  onSave: _onSave,
  markdownImageUpload,
}: DocumentHeaderProps) => {
  const [copyFeedback, setCopyFeedback] = useState<'idle' | 'copied'>('idle');
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const imageUploadInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
    };
  }, []);

  // ── More actions menu (floating-ui) ──
  const [isMoreMenuOpen, setIsMoreMenuOpen] = useState(false);
  const { refs, floatingStyles, context, isPositioned } = useFloating({
    open: isMoreMenuOpen,
    onOpenChange: setIsMoreMenuOpen,
    placement: 'bottom-end',
    strategy: 'fixed',
    middleware: [offset(4), flip({ padding: 8 }), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });
  const menuClick = useClick(context);
  const menuDismiss = useDismiss(context, { ancestorScroll: true });
  const menuRole = useRole(context, { role: 'menu' });
  const { getReferenceProps, getFloatingProps } = useInteractions([menuClick, menuDismiss, menuRole]);

  // ── Copy content handler ──
  const handleCopyContent = useCallback(async () => {
    if (!content) {
      showToast?.({ title: 'No content to copy' });
      return;
    }
    try {
      await navigator.clipboard.writeText(content);
      setCopyFeedback('copied');
      showToast?.({ title: 'Content copied to clipboard' });
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
      copyTimeoutRef.current = setTimeout(() => setCopyFeedback('idle'), 2000);
    } catch {
      showToast?.({ title: 'Failed to copy content' });
    }
  }, [content, showToast]);

  const handleOpenInLibrary = useCallback(() => {
    if (documentPath && onOpenInLibrary) {
      onOpenInLibrary(documentPath);
    }
  }, [documentPath, onOpenInLibrary]);

  const handleShowEnclosingFolder = useCallback(() => {
    if (!documentActions.enclosingFolderPath) return;
    onNavigateToFolder?.(documentActions.enclosingFolderPath);
    setIsMoreMenuOpen(false);
  }, [documentActions.enclosingFolderPath, onNavigateToFolder]);

  const handleOpenImageUpload = useCallback(() => {
    if (!markdownImageUpload || markdownImageUpload.inputProps.disabled) return;
    imageUploadInputRef.current?.click();
  }, [markdownImageUpload]);

  // Privacy
  const privacy = documentPath ? getFilePrivacy(documentPath) : 'unknown';
  const displayPath = relativePath || fileName || 'No document open';

  return (
    <>
      <header className={styles.header}>
        <div className={styles.headerLeft}>
          <div className={styles.titleRow}>
            {isDirty && <span className={styles.unsavedDot} title="Unsaved changes" />}
            {privacy !== 'unknown' && (
              <Tooltip
                content={privacy === 'private'
                  ? 'Private — only you can see this file'
                  : 'Shared — visible to others with folder access'}
                placement="top"
                delayShow={200}
              >
                <span className={cn(styles.privacyIcon, privacy === 'private' ? styles.privacyIconPrivate : styles.privacyIconShared)}>
                  {privacy === 'private' ? <Lock size={14} aria-hidden /> : <Globe size={14} aria-hidden />}
                </span>
              </Tooltip>
            )}
            {onRevealInTree && relativePath ? (
              <button
                type="button"
                className={styles.titlePathButton}
                onClick={onRevealInTree}
                data-testid="document-reveal-in-tree"
                title={displayPath}
              >
                {displayPath}
              </button>
            ) : (
              <h3 className={styles.title} title={displayPath}>
                {displayPath}
              </h3>
            )}
          </div>
          {relativePath && !onRevealInTree ? <span className={styles.pathText}>{relativePath}</span> : null}
        </div>

        <div className={styles.headerActions}>
          {/* Copy content */}
          {content !== null && (
            <Tooltip content={copyFeedback === 'copied' ? 'Copied!' : 'Copy contents'}>
              <IconButton
                size="sm"
                variant="ghost"
                className={cn(styles.actionButton, copyFeedback === 'copied' && styles.actionButtonSuccess)}
                onClick={() => void handleCopyContent()}
                aria-label="Copy document content"
              >
                {copyFeedback === 'copied' ? <Check size={16} aria-hidden /> : <Copy size={16} aria-hidden />}
              </IconButton>
            </Tooltip>
          )}

          {markdownImageUpload?.canUpload && (
            <>
              <input
                ref={imageUploadInputRef}
                type="file"
                className={styles.hiddenFileInput}
                data-testid="markdown-image-upload-input"
                {...markdownImageUpload.inputProps}
              />
              <Tooltip content={markdownImageUpload.isUploading ? 'Adding image…' : 'Add image'}>
                <button
                  type="button"
                  className={styles.actionButton}
                  onClick={handleOpenImageUpload}
                  aria-label="Add image"
                  disabled={markdownImageUpload.inputProps.disabled}
                  data-testid="markdown-image-upload-button"
                >
                  {markdownImageUpload.isUploading
                    ? <Loader2 size={16} aria-hidden className={styles.actionButtonSpinner} />
                    : <ImagePlus size={16} aria-hidden />}
                </button>
              </Tooltip>
            </>
          )}

          {/* Open in browser (tutorials/HTML) */}
          {showOpenInBrowser && (
            <Tooltip content="Open in browser (full fidelity)">
              <IconButton
                size="sm"
                variant="ghost"
                className={styles.actionButton}
                onClick={onOpenInBrowser}
                aria-label="Open in browser"
              >
                <Globe2 size={16} aria-hidden />
              </IconButton>
            </Tooltip>
          )}

          {onToggleKioskMode && (
            <Tooltip content={getFocusTooltipContent(kioskLevel)}>
              <button
                type="button"
                className={cn(styles.focusButton, kioskModeEnabled && styles.focusButtonActive)}
                onClick={onToggleKioskMode}
                aria-label={getFocusAriaLabel(kioskLevel)}
                aria-pressed={kioskModeEnabled}
                data-testid="document-focus-toggle"
              >
                {getFocusButtonLabel(kioskLevel)}
              </button>
            </Tooltip>
          )}

          {/* Open in Library */}
          {onOpenInLibrary && (
            <Tooltip content="Open in Library">
              <IconButton
                size="sm"
                variant="ghost"
                className={styles.actionButton}
                onClick={handleOpenInLibrary}
                aria-label="Open in Library"
              >
                <FolderOpen size={16} aria-hidden />
              </IconButton>
            </Tooltip>
          )}

          {/* More actions menu */}
          <Tooltip content="More actions" disabled={isMoreMenuOpen}>
            <IconButton
              ref={refs.setReference}
              size="sm"
              variant="ghost"
              className={cn(styles.actionButton, isMoreMenuOpen && styles.actionButtonActive)}
              aria-label="More actions"
              aria-haspopup="menu"
              aria-expanded={isMoreMenuOpen}
              {...getReferenceProps()}
            >
              {documentActions.exporting ? (
                <span className={styles.exportingIndicator}>...</span>
              ) : (
                <MoreHorizontal size={16} aria-hidden />
              )}
            </IconButton>
          </Tooltip>
          {isMoreMenuOpen && (
            <FloatingPortal>
              <div
                ref={refs.setFloating}
                style={floatingStyles}
                className={styles.moreMenu}
                role="menu"
                data-positioned={isPositioned}
                {...getFloatingProps()}
              >
                <button type="button" className={styles.moreMenuItem} role="menuitem"
                  onClick={() => { setIsMoreMenuOpen(false); void documentActions.copyFullPath(); }}
                  disabled={!absolutePath}
                >
                  <Copy size={14} aria-hidden /><span>Copy full path</span>
                </button>
                <button type="button" className={styles.moreMenuItem} role="menuitem"
                  onClick={() => { setIsMoreMenuOpen(false); void documentActions.copyRelativePath(); }}
                >
                  <Link size={14} aria-hidden /><span>Copy relative path</span>
                </button>
                {documentActions.enclosingFolderPath && onNavigateToFolder && (
                  <button type="button" className={styles.moreMenuItem} role="menuitem" onClick={handleShowEnclosingFolder}>
                    <Folder size={14} aria-hidden /><span>Show enclosing folder</span>
                  </button>
                )}
                <button type="button" className={styles.moreMenuItem} role="menuitem"
                  onClick={() => { setIsMoreMenuOpen(false); documentActions.revealInFinder(); }}
                >
                  <FolderOpen size={14} aria-hidden /><span>Reveal in {isMac ? 'Finder' : 'Explorer'}</span>
                </button>

                {/* Export actions (text/markdown) */}
                {fileCategory === 'text' && content && (
                  <>
                    <div className={styles.menuDivider} />
                    <button type="button" className={styles.moreMenuItem} role="menuitem"
                      onClick={() => { setIsMoreMenuOpen(false); void documentActions.exportPdf(); }}
                      disabled={documentActions.exporting !== null}
                    >
                      <Download size={14} aria-hidden />
                      <span>{documentActions.exporting === 'pdf' ? 'Exporting...' : 'Export as PDF'}</span>
                    </button>
                    <button type="button" className={styles.moreMenuItem} role="menuitem"
                      onClick={() => { setIsMoreMenuOpen(false); void documentActions.exportDocx(); }}
                      disabled={documentActions.exporting !== null}
                    >
                      <Download size={14} aria-hidden />
                      <span>{documentActions.exporting === 'docx' ? 'Exporting...' : 'Export as Word'}</span>
                    </button>
                    {isMarkdownFile && (
                      <button type="button" className={styles.moreMenuItem} role="menuitem"
                        onClick={() => { setIsMoreMenuOpen(false); void documentActions.exportMarkdown(); }}
                      >
                        <FileText size={14} aria-hidden /><span>Export as Markdown</span>
                      </button>
                    )}
                  </>
                )}

                <div className={styles.menuDivider} />
                <button type="button" className={styles.moreMenuItem} role="menuitem"
                  onClick={() => { setIsMoreMenuOpen(false); documentActions.openWithDefaultApp(); }}
                  disabled={!absolutePath}
                >
                  <ExternalLink size={14} aria-hidden /><span>Open with default app</span>
                </button>

                {/* Version history (shared skills) */}
                {onViewHistory && (
                  <>
                    <div className={styles.menuDivider} />
                    <button type="button" className={styles.moreMenuItem} role="menuitem"
                      onClick={() => { setIsMoreMenuOpen(false); onViewHistory(); }}
                    >
                      <History size={14} aria-hidden /><span>Version history</span>
                    </button>
                  </>
                )}

                {/* File management */}
                {onRename && (
                  <button type="button" className={styles.moreMenuItem} role="menuitem"
                    onClick={() => { setIsMoreMenuOpen(false); onRename(); }}
                  >
                    <PenLine size={14} aria-hidden /><span>Rename</span>
                  </button>
                )}
                {onMoveTo && (
                  <button type="button" className={styles.moreMenuItem} role="menuitem"
                    onClick={() => { setIsMoreMenuOpen(false); onMoveTo(); }}
                  >
                    <FolderInput size={14} aria-hidden /><span>Move to…</span>
                  </button>
                )}
                {onDelete && (
                  <>
                    <div className={styles.menuDivider} />
                    <button type="button" className={cn(styles.moreMenuItem, styles.moreMenuItemDanger)} role="menuitem"
                      onClick={() => { setIsMoreMenuOpen(false); onDelete(); }}
                    >
                      <Trash2 size={14} aria-hidden /><span>Delete</span>
                    </button>
                  </>
                )}
              </div>
            </FloatingPortal>
          )}

          {/* Close */}
          <Tooltip content="Close">
            <IconButton
              size="sm"
              variant="ghost"
              danger
              className={styles.closeButton}
              onClick={onClose}
              aria-label="Close editor"
              data-testid="library-editor-close"
            >
              <X size={18} aria-hidden />
            </IconButton>
          </Tooltip>
        </div>
      </header>
    </>
  );
};

export const DocumentHeader = memo(DocumentHeaderComponent);
