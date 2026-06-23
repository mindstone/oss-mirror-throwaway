import { memo, useCallback, useState } from 'react';
import { createPortal } from 'react-dom';
import { Maximize2, X, Info, AlertTriangle, List, ShieldCheck, ExternalLink } from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import { Button, Tooltip } from '@renderer/components/ui';
import { ImageContextMenu } from '@renderer/components/ImageContextMenu';
import { useImageContextMenu } from '@renderer/components/useImageContextMenu';
import { MessageMarkdown } from '@renderer/components/MessageMarkdown';
import { DocumentOutlinePanel } from '@renderer/features/library/components/DocumentOutlinePanel';
import { AnnotatedTipTapEditor } from '@renderer/features/library/components/AnnotatedTipTapEditor';
import { FrontmatterPill } from '@renderer/features/library/components/FrontmatterPill';
import {
  SkillCard,
  type SkillSourceType,
} from '@renderer/features/library/components/SkillCard';
import type { SkillFrontmatter } from '@renderer/features/library/hooks/useSkillsIndex';
import type { FileCategory } from '@renderer/utils/documentUtils';
import type { SpaceStorageProvider } from '@shared/types';
import type { ImageLoadState, MediaLoadState, SharedSkillSaveProtection } from '../hooks/useDocumentFileIO';
import { useHtmlPreviewTrust } from '../hooks/useHtmlPreviewTrust';
import { getTutorialProtocolUrl, getHtmlProtocolUrl } from '../utils/protocolUrls';
import styles from './UnifiedDocumentEditor.module.css';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SkillInfo {
  relativePath: string;
  source: SkillSourceType | undefined;
  frontmatter?: SkillFrontmatter;
  sharing?: 'private' | 'restricted' | 'team' | 'company-wide' | 'public';
  storageProvider?: SpaceStorageProvider;
  qualityScore?: number;
  qualityBand?: 'seedling' | 'growing' | 'solid' | 'exemplary';
  qualityTopImprovement?: {
    dimension: string;
    suggestion: string;
  };
}

import type { SkillImproveQualityContext } from '../../library/utils/skillQualityUtils';
import { buildImproveQualityContext } from '../../library/utils/skillQualityUtils';

interface DocumentRenderersProps {
  fileCategory: FileCategory;
  documentPath: string | null;
  /** Absolute on-disk path of the active document, used for "open in default app". */
  absolutePath: string | null;
  fileName: string;
  content: string | null;
  isMarkdownFile: boolean;
  isEditing: boolean;
  editContent: string;
  isSaving: boolean;

  imageState: ImageLoadState;
  mediaState: MediaLoadState;
  setMediaState: (updater: (prev: MediaLoadState) => MediaLoadState) => void;

  // Lifted state: skill card + image expand
  showSkillCard: boolean;
  onSetShowSkillCard: (show: boolean) => void;
  isImageExpanded: boolean;
  onSetIsImageExpanded: (expanded: boolean) => void;
  skillInfo: SkillInfo | null;

  editorResult: any; // eslint-disable-line @typescript-eslint/no-explicit-any -- result shape varies by underlying editor (TipTap vs CodeMirror); narrowed at each renderer consumer

  outlineScrollRef: React.RefObject<HTMLDivElement | null>;

  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  onEditContentChange: (value: string) => void;
  onMarkdownImageMutation?: (markdown: string) => void | Promise<void>;
  onMarkdownImageFiles?: (files: File[], options?: { insertAt?: number }) => void | Promise<void>;

  onOpenFile?: (path: string) => Promise<void>;
  onOpenLinkedFile: (path: string) => void;
  showToast?: (options: { title: string }) => void;
  sharedSkillSaveProtection: SharedSkillSaveProtection | null;
  needsSharedSkillSaveConfirmation: boolean;
  onConfirmSharedSkillDirectSave: () => Promise<void>;
  onBeforeRestoreSkillVersion?: () => boolean;
  onRestoreAttemptAborted?: () => void;
  onRestoreSkillVersionApplied?: (documentPath: string, content: string) => void;

  // Skill callbacks
  onUseSkill?: (path: string) => void;
  onPersonaliseSkill?: (path: string) => void;
  onShareSkill?: (path: string) => void;
  onImproveSkill?: (path: string, qualityContext?: SkillImproveQualityContext) => void;
  hasPersonalSupplement?: boolean;
  skillExamplePaths?: string[];
  onClose?: () => void;
  /** Navigate back to the Skills browse (resets Library to opening state — default browse lens) */
  onBackToSkills?: () => void;

  onOpenInBrowser: () => void;
  onOpenInLibrary?: (path: string) => void;
}

function getSkillImproveQualityContext(skillInfo: SkillInfo | null): SkillImproveQualityContext | undefined {
  if (!skillInfo) return undefined;
  return buildImproveQualityContext(skillInfo.qualityScore, skillInfo.qualityBand, skillInfo.qualityTopImprovement);
}

// ---------------------------------------------------------------------------
// ImagePreview — drawer/document image surface with right-click context menu
//
// Mirrors ToolResultImage's pattern (thumbnail + expand overlay + ImageContextMenu)
// so right-click "Copy Image" / "Save Image As..." behaves identically to chat.
// Without this, the global Electron context-menu handler in src/main/index.ts
// short-circuits on non-editable, non-selection targets, leaving images silent.
// ---------------------------------------------------------------------------

interface ImagePreviewProps {
  dataUrl: string;
  fileName: string;
  documentPath: string | null;
  dimensions: { width: number; height: number } | null | undefined;
  isExpanded: boolean;
  onExpand: () => void;
  onCollapse: () => void;
  showToast?: (options: { title: string }) => void;
}

const ImagePreview = memo(({
  dataUrl,
  fileName,
  documentPath,
  dimensions,
  isExpanded,
  onExpand,
  onCollapse,
  showToast,
}: ImagePreviewProps) => {
  const { target: contextMenu, open: openContextMenu, close: closeContextMenu, handleMouseDown } = useImageContextMenu();

  const handleContextMenu = useCallback((event: React.MouseEvent) => {
    openContextMenu(event, { dataUrl, filePath: documentPath ?? undefined, fileName });
  }, [openContextMenu, dataUrl, documentPath, fileName]);

  return (
    <>
      <div className={styles.imageContainer}>
        <button
          type="button"
          className={styles.imageButton}
          onClick={onExpand}
          onContextMenu={handleContextMenu}
          onMouseDown={handleMouseDown}
          aria-label="Click to expand image"
          style={dimensions ? { maxWidth: Math.min(dimensions.width, 800) } : undefined}
        >
          <img
            src={dataUrl}
            alt={fileName}
            className={styles.image}
            style={dimensions ? {
              width: dimensions.width,
              height: dimensions.height,
              maxWidth: '100%',
              maxHeight: 'calc(100vh - 200px)',
            } : undefined}
          />
          <div className={styles.imageExpandHint}>
            <Maximize2 size={16} aria-hidden />
            <span>Click to expand</span>
          </div>
        </button>
      </div>
      {isExpanded && createPortal(
        <div
          className={styles.imageOverlay}
          onClick={onCollapse}
          role="dialog"
          aria-modal="true"
          aria-label="Expanded image view"
        >
          <div className={styles.imageOverlayContent} onClick={(e) => e.stopPropagation()}>
            <img
              src={dataUrl}
              alt={fileName}
              className={styles.imageExpanded}
              onContextMenu={handleContextMenu}
            />
            <button
              type="button"
              className={styles.imageOverlayClose}
              onClick={onCollapse}
              aria-label="Close expanded view"
            >
              <X size={20} aria-hidden />
            </button>
          </div>
        </div>,
        document.body,
      )}
      <ImageContextMenu
        target={contextMenu}
        onClose={closeContextMenu}
        showToast={showToast}
      />
    </>
  );
});
ImagePreview.displayName = 'ImagePreview';

// ---------------------------------------------------------------------------
// HtmlPreviewFrame — workspace HTML rendered via the rebel-html:// custom
// protocol with a two-tier CSP. The banner exposes the strict/trusted toggle
// driven by useHtmlPreviewTrust; the iframe key bumps on state change so the
// protocol handler reissues with the new CSP. See
// docs/plans/260525_html_preview_trust_tiers.md.
// ---------------------------------------------------------------------------

interface HtmlPreviewFrameProps {
  documentPath: string;
  fileName: string;
  onOpenInBrowser: () => void;
}

const HtmlPreviewFrame = memo(({ documentPath, fileName, onOpenInBrowser }: HtmlPreviewFrameProps) => {
  const { state, reloadKey, trust, reset } = useHtmlPreviewTrust(documentPath);
  const [pending, setPending] = useState(false);

  const handleTrust = useCallback(async () => {
    setPending(true);
    try {
      await trust();
    } finally {
      setPending(false);
    }
  }, [trust]);

  const handleReset = useCallback(async () => {
    setPending(true);
    try {
      await reset();
    } finally {
      setPending(false);
    }
  }, [reset]);

  const isTrusted = state === 'trusted';

  return (
    <>
      <div className={cn(styles.htmlNotice, isTrusted && styles.htmlNoticeTrusted)}>
        {isTrusted ? <ShieldCheck size={14} aria-hidden /> : <Info size={14} aria-hidden />}
        <span className={styles.htmlNoticeText}>
          {isTrusted
            ? 'Full content enabled for this file. External scripts and live data can run.'
            : 'Showing safe preview. Pages that need scripts or live data may look incomplete.'}
        </span>
        <span className={styles.htmlNoticeActions}>
          {isTrusted ? (
            <button
              type="button"
              onClick={handleReset}
              className={styles.htmlNoticeLink}
              disabled={pending}
            >
              Reset to safe preview
            </button>
          ) : (
            <button
              type="button"
              onClick={handleTrust}
              className={styles.htmlNoticeLink}
              disabled={pending || state === 'unknown'}
            >
              Show full content
            </button>
          )}
          <button type="button" onClick={onOpenInBrowser} className={styles.htmlNoticeLink}>
            Open in browser
          </button>
        </span>
      </div>
      <iframe
        key={`${documentPath}:${reloadKey}`}
        src={getHtmlProtocolUrl(documentPath)}
        sandbox="allow-scripts"
        className={styles.tutorialFrame}
        title={fileName}
      />
    </>
  );
});
HtmlPreviewFrame.displayName = 'HtmlPreviewFrame';

// ---------------------------------------------------------------------------
// PdfPreview — Chromium's built-in PDF viewer (PDFium) in an unsandboxed iframe.
//
// The iframe src is a rebel-media:// protocol URL (origin-independent, fetchable
// under the packaged file:// renderer) — NOT a renderer-owned blob: URL. A blob:
// URL is origin-scoped and the packaged preview rendered blank; whether PDFium's
// out-of-process viewer literally cannot fetch it is runtime-UNCONFIRMED, but the
// protocol path is robust regardless. See useDocumentFileIO PDF branch and
// docs/plans/260619_pdf-viewer-blank/PLAN.md.
//
// No sandbox attribute: PDFium is already sandboxed at the process level and
// adding iframe sandbox breaks its internal scripting needed for viewer controls.
//
// Recovery: an "Open in default app" affordance is ALWAYS shown for PDFs (not
// only on error). PDFium renders in an out-of-process viewer whose success or
// failure is NOT reliably observable from the renderer — its frame does not fire
// onLoad/onError the way a same-origin document does — so we deliberately do NOT
// try to detect a render failure and flip into a destructive error state. Doing
// so risks replacing a slow-but-working preview (large or cloud-resident PDF)
// with a hard error panel. The always-available recovery button is the
// non-destructive safety net: the user is never stranded by a blank panel,
// because there is always a clear next action.
// ---------------------------------------------------------------------------

interface PdfPreviewProps {
  mediaUrl: string;
  fileName: string;
  absolutePath: string | null;
}

const PdfPreview = memo(({ mediaUrl, fileName, absolutePath }: PdfPreviewProps) => {
  const handleOpenInDefaultApp = useCallback(() => {
    if (!absolutePath) return;
    void window.appApi.openPath(absolutePath);
  }, [absolutePath]);

  return (
    <div className={styles.pdfContainer}>
      <iframe
        src={mediaUrl}
        className={styles.pdfFrame}
        title={fileName}
      />
      {absolutePath && (
        <div className={styles.pdfToolbar}>
          <Button variant="outline" size="sm" onClick={handleOpenInDefaultApp}>
            <ExternalLink size={14} aria-hidden />
            Open in default app
          </Button>
        </div>
      )}
    </div>
  );
});
PdfPreview.displayName = 'PdfPreview';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const DocumentRenderersComponent = ({
  fileCategory,
  documentPath,
  absolutePath,
  fileName,
  content,
  isMarkdownFile,
  isEditing,
  editContent,
  isSaving,
  imageState,
  mediaState,
  setMediaState,
  showSkillCard,
  onSetShowSkillCard,
  isImageExpanded,
  onSetIsImageExpanded,
  skillInfo,
  editorResult,
  outlineScrollRef,
  textareaRef,
  onEditContentChange,
  onMarkdownImageMutation,
  onMarkdownImageFiles,
  onOpenFile,
  onOpenLinkedFile,
  showToast,
  sharedSkillSaveProtection,
  needsSharedSkillSaveConfirmation,
  onConfirmSharedSkillDirectSave,
  onBeforeRestoreSkillVersion,
  onRestoreAttemptAborted,
  onRestoreSkillVersionApplied,
  onUseSkill,
  onPersonaliseSkill,
  onShareSkill,
  onImproveSkill,
  hasPersonalSupplement,
  skillExamplePaths,
  onClose,
  onBackToSkills,
  onOpenInBrowser,
  onOpenInLibrary,
}: DocumentRenderersProps) => {
  const visibleSkillContent = isEditing ? editContent : content;

  const isShowingSkillCard = !!(skillInfo && showSkillCard);
  const skillImproveQualityContext = getSkillImproveQualityContext(skillInfo);
  const shouldShowSharedSkillWarning = Boolean(
    skillInfo &&
    sharedSkillSaveProtection &&
    needsSharedSkillSaveConfirmation &&
    documentPath,
  );

  // ── Tutorial / HTML iframes ──
  if (fileCategory === 'tutorial' && documentPath) {
    return (
      <iframe
        src={getTutorialProtocolUrl(documentPath)}
        sandbox="allow-scripts"
        className={styles.tutorialFrame}
        title={fileName}
      />
    );
  }

  if (fileCategory === 'html' && documentPath) {
    return (
      <HtmlPreviewFrame
        documentPath={documentPath}
        fileName={fileName}
        onOpenInBrowser={onOpenInBrowser}
      />
    );
  }

  // ── Image ──
  if (fileCategory === 'image' && imageState.dataUrl) {
    return (
      <ImagePreview
        dataUrl={imageState.dataUrl}
        fileName={fileName}
        documentPath={documentPath}
        dimensions={imageState.dimensions}
        isExpanded={isImageExpanded}
        onExpand={() => onSetIsImageExpanded(true)}
        onCollapse={() => onSetIsImageExpanded(false)}
        showToast={showToast}
      />
    );
  }

  // ── Video ──
  if (fileCategory === 'video' && mediaState.mediaUrl) {
    return (
      <div className={styles.videoContainer}>
        <video
          src={mediaState.mediaUrl}
          controls
          className={styles.video}
          preload="metadata"
          onError={() => setMediaState(prev => ({ ...prev, error: 'Failed to play video. The file may be corrupted or use an unsupported codec.', mediaUrl: null }))}
        >
          Your browser does not support video playback.
        </video>
      </div>
    );
  }

  // ── Audio ──
  if (fileCategory === 'audio' && mediaState.mediaUrl) {
    return (
      <div className={styles.audioContainer}>
        <audio
          src={mediaState.mediaUrl}
          controls
          className={styles.audio}
          preload="metadata"
          onError={() => setMediaState(prev => ({ ...prev, error: 'Failed to play audio. The file may be corrupted or use an unsupported codec.', mediaUrl: null }))}
        >
          Your browser does not support audio playback.
        </audio>
      </div>
    );
  }

  // ── PDF ──
  // Loading/error states are handled by the parent (UnifiedDocumentEditor) via
  // mediaState.loading / mediaState.error; PdfPreview adds the always-available
  // "Open in default app" recovery affordance + a load-timeout error fallback.
  if (fileCategory === 'pdf' && mediaState.mediaUrl) {
    return (
      <PdfPreview
        mediaUrl={mediaState.mediaUrl}
        fileName={fileName}
        absolutePath={absolutePath}
      />
    );
  }

  // ── Unsupported ──
  if (fileCategory === 'unsupported') {
    return (
      <div className={styles.error}>
        <AlertTriangle size={20} aria-hidden />
        <span>Preview not supported for this file type.</span>
        {onOpenInLibrary && documentPath && (
          <Button variant="outline" size="sm" onClick={() => onOpenInLibrary(documentPath)}>
            Open in Library
          </Button>
        )}
      </div>
    );
  }

  // ── Text content ──
  if (fileCategory === 'text' && content !== null) {
    // Skill card (overrides normal content)
    if (isShowingSkillCard && skillInfo && documentPath) {
      return (
        <div className={styles.bodyContent}>
          <SkillCard
            key={documentPath ?? skillInfo.relativePath}
            content={visibleSkillContent ?? ''}
            savedContent={content}
            frontmatter={skillInfo.frontmatter}
            documentPath={documentPath}
            relativePath={skillInfo.relativePath}
            fileName={fileName}
            skillSource={skillInfo.source}
            sharing={skillInfo.sharing}
            storageProvider={skillInfo.storageProvider}
            hasPersonalSupplement={hasPersonalSupplement}
            hasUnsavedChanges={Boolean(isEditing && editContent !== content)}
            examplePaths={skillExamplePaths}
            qualityScore={skillInfo.qualityScore}
            qualityBand={skillInfo.qualityBand}
            qualityTopImprovement={skillInfo.qualityTopImprovement}
            onUseSkill={onUseSkill ? () => onUseSkill(skillInfo.relativePath) : undefined}
            onShowRaw={() => onSetShowSkillCard(false)}
            onClose={onClose}
            onBackToSkills={onBackToSkills}
            onPersonalise={onPersonaliseSkill ? () => onPersonaliseSkill(skillInfo.relativePath) : undefined}
            onShare={onShareSkill ? () => onShareSkill(skillInfo.relativePath) : undefined}
            onImproveSkill={onImproveSkill}
            onViewExample={onOpenFile ? (p: string) => { void onOpenFile(p); } : undefined}
            onOpenFilePath={onOpenLinkedFile}
            onBeforeRestoreVersion={onBeforeRestoreSkillVersion}
            onRestoreAttemptAborted={onRestoreAttemptAborted}
            onRestoreExternalCommitReleased={onRestoreAttemptAborted}
            onRestoreVersionApplied={onRestoreSkillVersionApplied}
          />
        </div>
      );
    }

    // Markdown with outline sidebar
    if (isMarkdownFile) {
      return (
        <div className={styles.bodyWithOutline}>
          <div className={cn(styles.outlineContainer, editorResult.outline.isOpen && styles.outlineContainerOpen)}>
            <Tooltip content={editorResult.outline.isOpen ? 'Hide outline' : 'Show outline'} placement="right">
              <button
                type="button"
                className={cn(styles.outlineToggle, editorResult.outline.isOpen && styles.outlineToggleActive)}
                onClick={() => editorResult.outline.setOpen((prev: boolean) => !prev)}
                aria-label={editorResult.outline.isOpen ? 'Hide document outline' : 'Show document outline'}
                aria-expanded={editorResult.outline.isOpen}
              >
                <List size={16} />
              </button>
            </Tooltip>
            {editorResult.outline.isOpen && (
              <DocumentOutlinePanel
                // Remount on document change so per-heading collapse state
                // (indexed by heading position) doesn't leak across docs —
                // indices are not stable across documents.
                key={documentPath ?? 'no-doc'}
                content={editorResult.content.forOutline}
                currentHeadingIndex={editorResult.outline.currentHeadingIndex}
                onSelectHeading={editorResult.outline.goToHeading}
              />
            )}
          </div>
          <div ref={outlineScrollRef} className={styles.outlineMain}>
            {shouldShowSharedSkillWarning && (
              <div className={styles.skillEditWarning}>
                <AlertTriangle size={16} className={styles.skillEditWarningIcon} />
                <span className={styles.skillEditWarningText}>
                  {sharedSkillSaveProtection?.copy}
                </span>
                <div className={styles.skillEditWarningActions}>
                  {onImproveSkill && documentPath && (
                    <Button size="sm" variant="secondary" onClick={() => onImproveSkill(documentPath, skillImproveQualityContext)}>
                      Improve with Rebel
                    </Button>
                  )}
                  <Button size="sm" variant="default" onClick={() => { void onConfirmSharedSkillDirectSave(); }}>
                    {isEditing && editContent !== content ? 'Confirm and save' : 'Confirm direct edits'}
                  </Button>
                </div>
              </div>
            )}
            {skillInfo && (
              <div className={styles.skillBackRow}>
                <Button
                  variant="ghost"
                  size="sm"
                  className={styles.skillBackButton}
                  onClick={() => onSetShowSkillCard(true)}
                  title="Back to skill overview"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="15 18 9 12 15 6" />
                    <line x1="9" y1="12" x2="21" y2="12" />
                  </svg>
                  Skill overview
                </Button>
              </div>
            )}
            {editorResult.content.frontmatterFields && (
              <FrontmatterPill fields={editorResult.content.frontmatterFields} />
            )}
            <AnnotatedTipTapEditor
              editorResult={editorResult}
              className={styles.editorPane}
              documentPath={documentPath ?? undefined}
              readOnly={!isEditing}
              selectableContentActions="copy,reply,add-comment"
              onLinkClick={onOpenLinkedFile}
              onReply={(text) => {
                window.dispatchEvent(new CustomEvent('library:quote-reply', {
                  detail: { text, documentPath, documentTitle: fileName },
                }));
              }}
              onReplyInNewChat={(text) => {
                window.dispatchEvent(new CustomEvent('library:quote-reply-new-chat', {
                  detail: { text, documentPath, documentTitle: fileName },
                }));
              }}
              showToast={showToast}
              onImageMutation={onMarkdownImageMutation}
              onImageFiles={onMarkdownImageFiles}
            />
          </div>
        </div>
      );
    }

    // Non-markdown: edit
    if (isEditing) {
      return (
        <div className={styles.editorPane} data-selectable-content="copy,reply" data-document-path={documentPath ?? undefined}>
          <textarea
            ref={textareaRef}
            className={styles.textarea}
            value={editContent}
            onChange={(e) => onEditContentChange(e.target.value)}
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            placeholder="Start writing…"
            disabled={isSaving}
            data-testid="library-editor-textarea"
          />
        </div>
      );
    }

    // Non-markdown: preview
    return (
      <div className={styles.previewPane} data-selectable-content="copy,reply" data-document-path={documentPath ?? undefined}>
        <MessageMarkdown content={content} onOpenFile={onOpenFile} />
      </div>
    );
  }

  return null;
};

export const DocumentRenderers = memo(DocumentRenderersComponent);
