import { memo, useState, useEffect, useMemo, useCallback, useRef } from 'react';
import ReactDiffViewer, { DiffMethod } from 'react-diff-viewer-continued';
import { isMarkdownPath } from '@renderer/utils/documentUtils';
import { SafeMarkdown } from '@renderer/components/SafeMarkdown';
import { diffViewerStyles } from './diffViewerStyles';
import { FileText, Check, X, AlertTriangle, Loader2, Columns, FileCode, Send, Copy, ExternalLink, ShieldCheck, RefreshCw } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogFooter,
  Button,
  FileLocationBadge,
  Input,
  Textarea,
  Tooltip,
  useToast,
} from '@renderer/components/ui';
import { BlastRadiusStrip } from '@renderer/components/approval/actionPreview/BlastRadiusStrip';
import { SCOPE_LABELS, DENY_SCOPE_LABELS } from '@renderer/components/approval/scopeLabels';
import {
  buildMemoryBlockedAction,
  useApprovalContent,
  usePrincipleOptions,
} from '@rebel/cloud-client';
import { useDesktopApprovalTransport } from '@renderer/transport/useDesktopApprovalTransport';
import { SharingBadge } from '@renderer/components/approval/primitives';
import { buildConversationalPublishMessage, legacyMissingLocation } from '@rebel/shared';
import type { BlastRadius, RiskReason } from '@rebel/shared';
import type { StagedFileItem } from '../hooks/useStagedFiles';
import type { StagedFileSaveReceiptOptions } from './stagedFileReceipts';
import { narrowSharing } from '../utils/approvalFacetAnalysis';
import { getStagedFileWhyText } from '../utils/approvalWhyText';
import styles from './StagedFilePreviewDialog.module.css';

type ViewMode = 'diff' | 'preview';

/**
 * Build a user-visible error message for explicit content-load failures.
 *
 * Staged-content failures (F2-1 / F2-2) and non-ENOENT remote-original
 * failures (permission / network / other) must surface an explicit error
 * rather than silently falling back to empty content. Per D8 in
 * `docs/plans/260416_centralize_approval_and_diff_viewing_ux.md`.
 */
function buildStagedFileErrorMessage(
  err: { kind: 'missing' | 'permission' | 'network' | 'binary' | 'other'; detail: string },
  opts: { failedOnStaged: boolean },
): string {
  const prefix = opts.failedOnStaged
    ? 'Couldn\u2019t load the staged version'
    : 'Couldn\u2019t load the current version';
  switch (err.kind) {
    case 'permission':
      return `${prefix} \u2014 permission denied.`;
    case 'network':
      return `${prefix} \u2014 network error.`;
    case 'other':
    default:
      return `${prefix}${err.detail ? ` \u2014 ${err.detail}` : '.'}`;
  }
}

export type StagedFilePreviewDialogProps = {
  file: StagedFileItem | null;
  onClose: () => void;
  /** Open the staged file in the surrounding file/library flow. */
  onOpenFilePath: (path: string) => Promise<void> | void;
  onPublish: (id: string) => Promise<{ 
    success: boolean; 
    hasConflict?: boolean; 
    error?: string;
    conflict?: { realContent: string; stagedContent: string };
  }>;
  onDiscard: (id: string) => Promise<{ success: boolean; error?: string }>;
  /** Keep the file private in the user's private space (memory/topics) */
  onKeepPrivate?: (id: string) => Promise<{ success: boolean; error?: string; destinationPath?: string }>;
  /** Adds a receipt to the originating chat after the staged file is saved. */
  onSaved?: (file: StagedFileItem, options?: StagedFileSaveReceiptOptions) => Promise<void> | void;
  /** Send a message to a specific session (for conversational approval instructions) */
  onSendMessageToSession?: (sessionId: string, message: string) => Promise<void>;
  /** Navigate to a session (opens the conversation view) */
  onNavigateToSession?: (sessionId: string) => void;
  /** Pre-populated conflict data from a card quick-approve that detected a conflict */
  initialConflictData?: { realContent: string; stagedContent: string } | null;
  blastRadius?: BlastRadius;
  riskReasons?: RiskReason[];
  /** Additional class for the Dialog overlay (used for z-index overrides) */
  overlayClassName?: string;
};

const StagedFilePreviewDialogComponent = ({
  file,
  onClose,
  onOpenFilePath,
  onPublish,
  onDiscard,
  onKeepPrivate,
  onSaved,
  onSendMessageToSession,
  onNavigateToSession,
  initialConflictData,
  blastRadius,
  riskReasons,
  overlayClassName,
}: StagedFilePreviewDialogProps) => {
  const { showToast } = useToast();
  const [isPublishing, setIsPublishing] = useState(false);
  const [isDenying, setIsDenying] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('diff');
  const [isDarkMode, setIsDarkMode] = useState(() => document.body.classList.contains('dark'));
  const [showRuleUpdateDialog, setShowRuleUpdateDialog] = useState(false);
  const [showDenyRuleUpdateDialog, setShowDenyRuleUpdateDialog] = useState(false);
  const rememberOnApproveRef = useRef(false);

  // Conversational approval state
  const [instruction, setInstruction] = useState('');
  const [isProcessingInstruction, setIsProcessingInstruction] = useState(false);
  const [instructionError, setInstructionError] = useState<string | null>(null);

  // Conflict state
  const [conflictData, setConflictData] = useState<{
    realContent: string;
    stagedContent: string;
  } | null>(null);
  const [isResolvingConflict, setIsResolvingConflict] = useState(false);

  // Shared content-fetching hook — replaces the prior inline load effect.
  // See docs/plans/260416_centralize_approval_and_diff_viewing_ux.md Stage 2.
  const content = useApprovalContent(file, {
    readStagedContent: async (id) => window.api.getStagedContent(id),
    readWorkspaceFile: async (path) => window.api.readWorkspaceFile(path),
  });

  // Metadata-based new-file detection drives the "new file banner" and the
  // diff-view gating. This is intentionally separate from the hook's runtime
  // `isNewFile` (which also promotes ENOENT to new-file) so that the
  // "original deleted between staging and review" edge case still renders
  // the diff-from-empty view rather than swapping to the new-file banner.
  const isNewFile = file?.baseHash === 'new-file';
  const stagedContent = content.staged;
  const isLoading = content.loading;

  // F2-2 error branching per Stage 2 D8 ("Fail loudly, not silently"):
  //  - binary                                 → existing binary-error UI
  //  - missing                                → never reaches here (hook
  //                                             collapses to isNewFile + error:null)
  //  - permission | network | other           → explicit error UI + Retry,
  //                                             Publish disabled
  // Staged-content failures are ALWAYS hard errors, regardless of isNewFile
  // (see Failure Mode Matrix entry for useApprovalContent).
  const contentError = content.error;
  const isBinaryError = contentError?.kind === 'binary';
  const binaryErrorDetail = contentError && contentError.kind === 'binary' ? contentError.detail : null;
  const isExplicitContentError = contentError !== null
    && contentError.kind !== 'binary'
    && contentError.kind !== 'missing';
  // Staged-content failure is always a hard error. Remote-original failure
  // on a NON-new file is also a hard error. (ENOENT on the original fetch
  // has already been transparently promoted to isNewFile + error:null.)
  const stagedFetchFailed = content.staged === null && !content.loading && isExplicitContentError;
  const hasBlockingError = isExplicitContentError || isBinaryError;

  const originalContent = hasBlockingError
    ? null
    : isNewFile
      ? null
      : (content.original ?? (content.loading ? null : ''));

  const explicitErrorMessage = isExplicitContentError && contentError
    ? buildStagedFileErrorMessage(contentError, { failedOnStaged: stagedFetchFailed })
    : null;
  const error = fetchError
    ?? (binaryErrorDetail ? 'This file type can\u2019t be previewed here.' : null)
    ?? explicitErrorMessage;

  const hasConflict = conflictData !== null;
  const hasInstruction = instruction.trim().length > 0;
  const isSafetyPromptBlocked = file?.blockedBy === 'safety_prompt';
  const isEvalError = file?.blockedBy === 'eval_error';
  const evalErrorText = file && isEvalError ? getStagedFileWhyText(file) : undefined;
  const [copiedPath, setCopiedPath] = useState(false);
  const location = useMemo(() => {
    if (!file) {
      return null;
    }
    return file.location ?? legacyMissingLocation({
      fileName: file.fileName,
      spaceName: file.spaceName,
      legacyPath: file.spacePath || file.realPath,
    });
  }, [file]);

  const blockedAction = file && isSafetyPromptBlocked
    ? buildMemoryBlockedAction({
        spaceName: file.spaceName,
        filePath: file.realPath,
        sharing: file.sharing,
        spacePath: file.spacePath,
        location: location ?? undefined,
        contentSummary: file.summary,
      })
    : null;

  const transport = useDesktopApprovalTransport();

  const principleOptions = usePrincipleOptions({
    blockedAction,
    effectiveToolId: null,
    onApprove: () => {
      setShowRuleUpdateDialog(false);
      const remembered = rememberOnApproveRef.current;
      rememberOnApproveRef.current = false;
      void handlePublish({ remembered });
    },
    transport,
  });

  const denyPrincipleOptions = usePrincipleOptions({
    blockedAction,
    effectiveToolId: null,
    direction: 'deny',
    onApprove: () => void handleDeny(),
    onDeny: () => {
      setShowDenyRuleUpdateDialog(false);
      void handleDeny();
    },
    transport,
  });

  const handleCopyPath = useCallback(async () => {
    if (!file) return;
    try {
      await navigator.clipboard.writeText(file.realPath);
      setCopiedPath(true);
      setTimeout(() => setCopiedPath(false), 2000);
    } catch (err) {
      console.error('Failed to copy path:', err);
    }
  }, [file]);

  const handleOpenInLibrary = useCallback(() => {
    if (!file || isNewFile) return;
    void onOpenFilePath(file.realPath);
    onClose();
  }, [file, isNewFile, onClose, onOpenFilePath]);

  // Observe theme changes on body class
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setIsDarkMode(document.body.classList.contains('dark'));
    });
    observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  // Reset per-dialog state whenever the file changes. Content fetching is
  // now handled by `useApprovalContent` above; this effect only owns the
  // dialog-local UI state (instruction, conflict data, transient error).
  // Action-in-progress flags (isPublishing, isDenying, etc.) are also reset
  // here because the component stays mounted across file previews — if a
  // previous session's action completed after the dialog closed (optimistic
  // removal raced the finally block), the flag would be stuck and disable
  // buttons on the next preview.
  useEffect(() => {
    setFetchError(null);
    setInstruction('');
    setInstructionError(null);
    setConflictData(null);
    setIsPublishing(false);
    setIsDenying(false);
    setIsProcessingInstruction(false);
    setIsResolvingConflict(false);
    setShowRuleUpdateDialog(false);
    setShowDenyRuleUpdateDialog(false);
  }, [file?.id]);

  // Seed conflict data from external prop (e.g., card quick-approve detected a conflict).
  // Runs after file-load effect which resets conflictData to null on file change.
  useEffect(() => {
    if (initialConflictData) {
      setConflictData(initialConflictData);
    }
  }, [initialConflictData]);

  async function handlePublish(options: StagedFileSaveReceiptOptions = {}) {
    if (!file) return;
    setIsPublishing(true);
    try {
      const result = await onPublish(file.id);
      if (result.success) {
        await Promise.resolve(onSaved?.(file, options));
        onClose();
      } else if (result.hasConflict && result.conflict) {
        // Capture conflict data for conflict resolution UI
        setConflictData({
          realContent: result.conflict.realContent,
          stagedContent: result.conflict.stagedContent,
        });
        setFetchError(null); // Clear error since we're showing conflict UI
      } else {
        setFetchError(result.error || 'Failed to approve');
      }
    } finally {
      setIsPublishing(false);
    }
  }

  const handleKeepMine = async () => {
    if (!file) return;
    setIsResolvingConflict(true);
    try {
      // Stage B (260417_approval_consolidation_closeout): mint a
      // capability token before resolving. The handler rejects any
      // resolve call without a valid, scoped, one-time-use token.
      // F-B-R2-9 R2: catch IPC rejection explicitly so the user sees a
      // surfaced error instead of a silently-failed promise when the
      // main process can't reach the new handler (e.g. process not
      // restarted after upgrade).
      let mintResult: Awaited<ReturnType<typeof window.api.mintConflictCapability>>;
      try {
        mintResult = await window.api.mintConflictCapability(file.id);
      } catch (err) {
        console.warn('[StagedFilePreviewDialog] mintConflictCapability threw', {
          fileId: file.id,
          error: err instanceof Error ? err.message : String(err),
        });
        setFetchError('Could not authorize conflict resolution. Please try again.');
        return;
      }
      if (!mintResult.success) {
        setFetchError(`Could not authorize conflict resolution (${mintResult.error})`);
        return;
      }
      // Stage C (260417_approval_consolidation_closeout): per-action
      // dedup key so a double-dispatch (user clicks twice while the
      // first request is in flight) replays the original response
      // instead of landing on CAPABILITY_REUSED after the nonce is
      // consumed on the first call.
      const clientDedupKey = crypto.randomUUID();
      const result = await window.api.publishWithConflictResolution(
        file.id,
        'keep-staged',
        mintResult.token,
        clientDedupKey,
      );
      if (result.status === 'success' || result.status === 'already-resolved') {
        await Promise.resolve(onSaved?.(file));
        onClose();
      } else {
        setFetchError(result.error || 'Failed to resolve conflict');
      }
    } finally {
      setIsResolvingConflict(false);
    }
  };

  const handleKeepTheirs = async () => {
    if (!file) return;
    setIsResolvingConflict(true);
    try {
      // Keep theirs = discard staged version
      const result = await onDiscard(file.id);
      if (result.success) {
        onClose();
      } else {
        setFetchError(result.error || 'Failed to deny');
      }
    } finally {
      setIsResolvingConflict(false);
    }
  };

  async function handleDeny() {
    if (!file) return;
    if (!onKeepPrivate) {
      setFetchError('Private redirect is unavailable for this staged file');
      return;
    }
    setIsDenying(true);
    try {
      const result = await onKeepPrivate(file.id);
      if (result.success) {
        onClose();
      } else {
        setFetchError(result.error || 'Failed to deny');
      }
    } finally {
      setIsDenying(false);
    }
  }

  const handleAllowAndChooseRuleUpdate = useCallback(() => {
    setShowDenyRuleUpdateDialog(false);
    setShowRuleUpdateDialog(true);
    principleOptions.startGeneration();
  }, [principleOptions]);

  const handleCloseRuleUpdateDialog = useCallback(() => {
    setShowRuleUpdateDialog(false);
    principleOptions.goBack();
  }, [principleOptions]);

  const handleDenyAndChooseRuleUpdate = useCallback(() => {
    setShowRuleUpdateDialog(false);
    setShowDenyRuleUpdateDialog(true);
    denyPrincipleOptions.startGeneration();
  }, [denyPrincipleOptions]);

  const handleCloseDenyRuleUpdateDialog = useCallback(() => {
    setShowDenyRuleUpdateDialog(false);
    denyPrincipleOptions.goBack();
  }, [denyPrincipleOptions]);

  const handleSendInstruction = useCallback(async () => {
    if (!file || !instruction.trim() || !onSendMessageToSession) return;
    
    // For conflicts, use conflict data; otherwise use stagedContent
    const contentToSend = hasConflict ? conflictData?.stagedContent : stagedContent;
    if (contentToSend == null) {
      setInstructionError('No file content available to send');
      return;
    }
    
    setIsProcessingInstruction(true);
    setInstructionError(null);
    
    try {
      const message = buildConversationalPublishMessage({
        filePath: file.realPath,
        spaceName: file.spaceName,
        stagedContent: contentToSend,
        instruction: instruction.trim(),
        conflictContent: hasConflict ? conflictData?.realContent : undefined,
      });
      
      await onSendMessageToSession(file.sessionId, message);
      
      // Discard the pending file — the agent already has the full content in the prompt.
      // This removes it from the UI immediately so the user doesn't see stale staged state.
      await onDiscard(file.id);
      
      onClose();
      
      // Navigate to the session so the user can see the agent working
      if (onNavigateToSession && file.sessionId) {
        onNavigateToSession(file.sessionId);
      } else {
        showToast({ title: 'Instruction sent — Rebel will continue in the conversation' });
      }
    } catch (err) {
      console.error('Failed to send instruction:', err);
      setInstructionError(err instanceof Error ? err.message : 'Failed to send instruction');
    } finally {
      setIsProcessingInstruction(false);
    }
  }, [file, instruction, onSendMessageToSession, onDiscard, onNavigateToSession, stagedContent, conflictData, hasConflict, onClose, showToast]);

  const handleInstructionKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && instruction.trim()) {
      e.preventDefault();
      void handleSendInstruction();
    }
  }, [instruction, handleSendInstruction]);



  // Stage 5 R2 (F5-1): the shared `computeDiff` engine is now available to
  // this dialog via `@rebel/shared`, but we deliberately do NOT call it here
  // yet. Calling it and discarding the result was flagged by three reviewers
  // as dead synchronous CPU on the render thread (Myers LCS is O(N*D)) with
  // zero user-facing payoff. `hookConflict`-equivalent detection for
  // "staged === original" is already handled byte-wise by `useApprovalContent`.
  // Stage 6 will re-wire `computeDiff` here once it drives real UI on mobile
  // (visible `+N / -M` stats). Until then, keep this path free of unbounded
  // work so large staged files don't freeze the dialog on open.

  if (!file) return null;

  const timeAgo = formatDistanceToNow(file.stagedAt, { addSuffix: true });
  const showDiffView = !isNewFile && viewMode === 'diff' && originalContent !== null;
  const sharingLevel = narrowSharing(file.sharing) ?? 'unclear';
  const sharingTooltip = sharingLevel === 'unclear'
    ? 'Rebel could not confirm who can see this file'
    : sharingLevel === 'private'
      ? 'Only you can see this file'
      : 'This file may be visible to others in this Space';

  return (
    <Dialog open={!!file} onOpenChange={(open) => !open && onClose()} overlayClassName={overlayClassName}>
      <DialogContent className={styles.dialog}>
        <DialogHeader>
          <div className={styles.headerRow}>
            <DialogTitle className={styles.title}>
              <FileText size={18} className={styles.titleIcon} />
              {file.fileName}
            </DialogTitle>
            {!isNewFile && (
              <div className={styles.viewToggle}>
                <button
                  type="button"
                  className={`${styles.toggleButton} ${viewMode === 'diff' ? styles.active : ''}`}
                  onClick={() => setViewMode('diff')}
                  title="Show diff"
                >
                  <Columns size={14} />
                  Diff
                </button>
                <button
                  type="button"
                  className={`${styles.toggleButton} ${viewMode === 'preview' ? styles.active : ''}`}
                  onClick={() => setViewMode('preview')}
                  title="Show preview"
                >
                  <FileCode size={14} />
                  Preview
                </button>
              </div>
            )}
          </div>
          <DialogDescription className={styles.description}>
            {hasConflict 
              ? 'This file was modified while you were reviewing it. Choose how to proceed.'
              : isEvalError
                ? `Paused before saving · ${timeAgo}`
                : isNewFile
                  ? `Review before saving · ${timeAgo}`
                  : `Changes ready for review · ${timeAgo}`
            }
          </DialogDescription>
          <div className={styles.pathRow}>
            {location && (
              <FileLocationBadge location={location} className={styles.pathDisplay} />
            )}
            {!isNewFile && (
              <button
                type="button"
                className={`${styles.pathDisplay} ${styles.pathClickable}`}
                onClick={handleOpenInLibrary}
                aria-label="Open file in library"
              >
                <ExternalLink size={12} className={styles.pathLinkIcon} />
              </button>
            )}
            <Tooltip content={copiedPath ? 'Copied!' : 'Copy full path'} placement="top" delayShow={200}>
              <button
                type="button"
                className={styles.pathCopyButton}
                onClick={handleCopyPath}
                aria-label="Copy full path"
              >
                <Copy size={12} />
              </button>
            </Tooltip>
          </div>
          {blastRadius && (
            <BlastRadiusStrip
              blastRadius={blastRadius}
              riskReasons={riskReasons}
            />
          )}
        </DialogHeader>

        <DialogBody className={styles.body}>
          {hasConflict && (
            <div className={styles.conflictBanner}>
              <AlertTriangle size={16} className={styles.conflictIcon} />
              <span>This file was modified while you were reviewing it.</span>
            </div>
          )}
          
          {!hasConflict && isNewFile && (
            <div className={styles.newFileBanner}>
              <FileText size={14} className={styles.newFileIcon} />
              <span>Draft prepared. Review the file before Rebel saves it to {file.spaceName}.</span>
            </div>
          )}

          {!hasConflict && evalErrorText && (
            <div className={styles.summary}>
              <AlertTriangle size={14} className={styles.summaryIcon} />
              <span>{evalErrorText}</span>
            </div>
          )}
          
          {!hasConflict && file.summary && (
            <div className={styles.summary}>
              <AlertTriangle size={14} className={styles.summaryIcon} />
              <span>{file.summary}</span>
            </div>
          )}

          <div className={styles.contentWrapper}>
            {isLoading ? (
              <div className={styles.loading}>
                <Loader2 size={24} className={styles.spinner} />
                <span>Loading content...</span>
              </div>
            ) : error ? (
              <div className={styles.error} role="alert">
                <span>{error}</span>
                {isExplicitContentError && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => content.refetch()}
                    aria-label="Retry loading content"
                    data-testid="staged-file-retry-button"
                  >
                    <RefreshCw size={14} />
                    Retry
                  </Button>
                )}
              </div>
            ) : hasConflict && conflictData ? (
              <div className={styles.diffWrapper}>
                <ReactDiffViewer
                  oldValue={conflictData.realContent}
                  newValue={conflictData.stagedContent}
                  splitView={true}
                  useDarkTheme={isDarkMode}
                  compareMethod={DiffMethod.WORDS}
                  styles={diffViewerStyles}
                  leftTitle="Current File (modified by others)"
                  rightTitle="Your Changes"
                  hideLineNumbers={false}
                />
              </div>
            ) : stagedContent !== null ? (
              showDiffView ? (
                <div className={styles.diffWrapper}>
                  <ReactDiffViewer
                    oldValue={originalContent ?? ''}
                    newValue={stagedContent}
                    splitView={true}
                    useDarkTheme={isDarkMode}
                    compareMethod={DiffMethod.WORDS}
                    styles={diffViewerStyles}
                    leftTitle="Current"
                    rightTitle="Your Changes"
                    hideLineNumbers={false}
                  />
                </div>
              ) : (
                <div className={styles.content}>
                  {isMarkdownPath(file.fileName) ? (
                    <SafeMarkdown>{stagedContent}</SafeMarkdown>
                  ) : (
                    <pre><code>{stagedContent}</code></pre>
                  )}
                </div>
              )
            ) : (
              <div className={styles.empty}>No content available</div>
            )}
          </div>

          <Tooltip 
            content={sharingTooltip}
            placement="top"
            delayShow={300}
          >
            <div className={styles.meta}>
              <SharingBadge sharing={sharingLevel} />
            </div>
          </Tooltip>
        </DialogBody>

        {/* Conversational approval instruction input */}
        {onSendMessageToSession && (
          <div className={styles.instructionSection}>
            <div className={styles.instructionDivider}>
              <span>Need changes? Tell Rebel what to adjust.</span>
            </div>
            <div className={styles.instructionInput}>
              <Textarea
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                onKeyDown={handleInstructionKeyDown}
                placeholder='e.g., "Remove the bank details" or "Save this to a different Space"'
                disabled={isProcessingInstruction || isPublishing || isDenying || isResolvingConflict}
                className={styles.instructionTextarea}
                rows={1}
              />
              <Tooltip 
                content={`Send revision instruction to Rebel (${navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}+Enter)`} 
                placement="top" 
                delayShow={300}
              >
                <Button
                  size="sm"
                  onClick={handleSendInstruction}
                  disabled={!instruction.trim() || isProcessingInstruction || isPublishing || isDenying || isResolvingConflict}
                  className={styles.sendButton}
                >
                  {isProcessingInstruction ? (
                    <Loader2 size={14} className={styles.spinner} />
                  ) : (
                    <Send size={14} />
                  )}
                </Button>
              </Tooltip>
            </div>
            {instructionError && (
              <div className={styles.instructionError}>{instructionError}</div>
            )}
          </div>
        )}

        <DialogFooter className={styles.footer}>
          {/* Left side: Deny redirects this write to private memory (no deletion) */}
          <div className={styles.footerLeft}>
            <Tooltip
              content={isEvalError
                ? 'Save this privately instead of to the target Space'
                : 'Deny this write to the target space and save it privately instead'}
              placement="top"
              delayShow={300}
            >
              <Button
                variant="outline"
                onClick={isSafetyPromptBlocked && !hasConflict ? handleDenyAndChooseRuleUpdate : handleDeny}
                disabled={!onKeepPrivate || isPublishing || isDenying || isProcessingInstruction || isResolvingConflict}
              >
                {isDenying ? (
                  <>
                    <Loader2 size={14} className={styles.spinner} />
                    Denying...
                  </>
                ) : (
                  <>
                    <X size={14} />
                    {isSafetyPromptBlocked && !hasConflict ? 'Don\u2019t allow\u2026' : isEvalError ? "Don't save this" : 'Deny'}
                  </>
                )}
              </Button>
            </Tooltip>
          </div>
          
          {/* Right side: Safe actions */}
          <div className={styles.footerRight}>
            {hasConflict ? (
              <>
                <Tooltip content="Discard your staged changes and keep the current file" placement="top" delayShow={300}>
                  <Button
                    variant="outline"
                    onClick={handleKeepTheirs}
                    disabled={isResolvingConflict || isProcessingInstruction}
                  >
                    {isResolvingConflict ? (
                      <Loader2 size={14} className={styles.spinner} />
                    ) : (
                      <X size={14} />
                    )}
                    Keep current
                  </Button>
                </Tooltip>
                <Tooltip content="Overwrite the current file with your staged changes" placement="top" delayShow={300}>
                  <Button
                    onClick={handleKeepMine}
                    disabled={isResolvingConflict || isProcessingInstruction}
                  >
                    {isResolvingConflict ? (
                      <Loader2 size={14} className={styles.spinner} />
                    ) : (
                      <Check size={14} />
                    )}
                    Use staged
                  </Button>
                </Tooltip>
              </>
            ) : (
              <>
                {isSafetyPromptBlocked && (
                  <Tooltip content="Allow this write and choose how to update your safety rules" placement="top" delayShow={300}>
                    <span>
                      <Button
                        variant="outline"
                        onClick={handleAllowAndChooseRuleUpdate}
                        disabled={isPublishing || isDenying || isProcessingInstruction || stagedContent === null || hasInstruction || hasBlockingError}
                      >
                        <ShieldCheck size={14} />
                        Allow and remember…
                      </Button>
                    </span>
                  </Tooltip>
                )}
                <Tooltip
                  content={hasBlockingError
                    ? 'Resolve the load error before allowing this file'
                    : hasInstruction
                      ? 'Clear your instruction or click Send to revise first'
                      : isEvalError
                        ? `Save to ${file.spaceName} once without the unfinished safety check`
                        : isNewFile
                        ? `Allow write to ${file.spaceName}`
                        : `Allow changes to ${file.spaceName}`
                  }
                  placement="top"
                  delayShow={300}
                >
                  <span>
                      <Button
                        onClick={() => void handlePublish()}
                      disabled={isPublishing || isDenying || isProcessingInstruction || stagedContent === null || hasInstruction || hasBlockingError}
                    >
                      {isPublishing ? (
                        <>
                          <Loader2 size={14} className={styles.spinner} />
                          Allowing...
                        </>
                      ) : (
                        <>
                        <Check size={14} />
                        {isEvalError ? 'Save it once' : isSafetyPromptBlocked ? 'Allow once' : 'Allow'}
                        </>
                      )}
                    </Button>
                  </span>
                </Tooltip>
              </>
            )}
          </div>
        </DialogFooter>

        {isSafetyPromptBlocked && !hasConflict && (
          <Dialog open={showRuleUpdateDialog} onOpenChange={(open) => !open && handleCloseRuleUpdateDialog()}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Allow and remember</DialogTitle>
                <DialogDescription>
                  Choose how broadly to allow similar staged memory writes in the future.
                </DialogDescription>
              </DialogHeader>
              <DialogBody>
                {principleOptions.generationState === 'loading' && <p>Generating options…</p>}

                {principleOptions.generationState === 'error' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <p>{principleOptions.generationError || 'Unable to generate options'}</p>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <Button size="sm" variant="outline" onClick={principleOptions.retryGeneration}>
                        Retry
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => {
                          rememberOnApproveRef.current = false;
                          principleOptions.approveOnce();
                        }}
                      >
                        Allow
                      </Button>
                    </div>
                  </div>
                )}

                {principleOptions.generationState === 'loaded' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {principleOptions.options.map((opt, idx) => {
                      const { label: scopeLabel, icon: ScopeIcon } = SCOPE_LABELS[opt.scope];

                      return (
                        <Button
                          key={opt.scope}
                          size="sm"
                          variant={principleOptions.selectedOption === idx ? 'default' : 'outline'}
                          onClick={() => principleOptions.selectOption(idx)}
                          style={{ justifyContent: 'flex-start', textAlign: 'left' }}
                        >
                          <ScopeIcon size={10} /><strong>{scopeLabel}:</strong>&nbsp;{opt.label}
                        </Button>
                      );
                    })}

                    <Button
                      size="sm"
                      variant={principleOptions.selectedOption === 'other' ? 'default' : 'outline'}
                      onClick={() => principleOptions.selectOption('other')}
                      style={{ justifyContent: 'flex-start' }}
                    >
                      Custom
                    </Button>

                    {principleOptions.selectedOption === 'other' && (
                      <Input
                        value={principleOptions.otherText}
                        onChange={(e) => principleOptions.setOtherText(e.target.value)}
                        placeholder="Type your own rule…"
                      />
                    )}

                    {principleOptions.applyState === 'confirming_trust' && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        <p>Saves to this space will always be allowed without safety checks. Are you sure?</p>
                        <div style={{ display: 'flex', gap: 8 }}>
                          <Button size="sm" variant="outline" onClick={principleOptions.cancelTrustedTool}>Back</Button>
                          <Button size="sm" onClick={principleOptions.confirmTrustedTool}>Yes, always allow</Button>
                        </div>
                      </div>
                    )}

                    {principleOptions.applyState === 'applying' && <p>Applying…</p>}

                    {principleOptions.applyState === 'error' && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        <p>{principleOptions.applyError || 'Failed to apply selection'}</p>
                        <Button size="sm" variant="outline" onClick={principleOptions.retryApply}>
                          Retry
                        </Button>
                      </div>
                    )}
                  </div>
                )}
              </DialogBody>
              <DialogFooter>
                <Button variant="ghost" onClick={handleCloseRuleUpdateDialog}>Cancel</Button>
                {principleOptions.generationState === 'loaded'
                  && principleOptions.applyState === 'idle'
                  && principleOptions.selectedOption !== null && (
                    <Button
                      onClick={() => {
                        rememberOnApproveRef.current = true;
                        principleOptions.confirmSelection();
                      }}
                      disabled={principleOptions.selectedOption === 'other' && !principleOptions.otherText.trim()}
                    >
                      Save &amp; allow
                    </Button>
                  )}
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}

        {isSafetyPromptBlocked && !hasConflict && (
          <Dialog open={showDenyRuleUpdateDialog} onOpenChange={(open) => !open && handleCloseDenyRuleUpdateDialog()}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Don&apos;t allow and remember</DialogTitle>
                <DialogDescription>
                  Choose how broadly to block similar staged memory writes in the future.
                </DialogDescription>
              </DialogHeader>
              <DialogBody>
                {denyPrincipleOptions.generationState === 'loading' && <p>Generating options…</p>}

                {denyPrincipleOptions.generationState === 'error' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <p>{denyPrincipleOptions.generationError || 'Unable to generate options'}</p>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <Button size="sm" variant="outline" onClick={denyPrincipleOptions.retryGeneration}>
                        Retry
                      </Button>
                      <Button size="sm" onClick={denyPrincipleOptions.resolveOnce}>
                        Deny
                      </Button>
                    </div>
                  </div>
                )}

                {denyPrincipleOptions.generationState === 'loaded' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {denyPrincipleOptions.options.map((opt, idx) => {
                      const { label: scopeLabel, icon: ScopeIcon } = DENY_SCOPE_LABELS[opt.scope];

                      return (
                        <Button
                          key={opt.scope}
                          size="sm"
                          variant={denyPrincipleOptions.selectedOption === idx ? 'default' : 'outline'}
                          onClick={() => denyPrincipleOptions.selectOption(idx)}
                          style={{ justifyContent: 'flex-start', textAlign: 'left' }}
                        >
                          <ScopeIcon size={10} /><strong>{scopeLabel}:</strong>&nbsp;{opt.label}
                        </Button>
                      );
                    })}

                    <Button
                      size="sm"
                      variant={denyPrincipleOptions.selectedOption === 'other' ? 'default' : 'outline'}
                      onClick={() => denyPrincipleOptions.selectOption('other')}
                      style={{ justifyContent: 'flex-start' }}
                    >
                      Custom
                    </Button>

                    {denyPrincipleOptions.selectedOption === 'other' && (
                      <Input
                        value={denyPrincipleOptions.otherText}
                        onChange={(e) => denyPrincipleOptions.setOtherText(e.target.value)}
                        placeholder="Type your own rule…"
                      />
                    )}

                    {denyPrincipleOptions.applyState === 'confirming_trust' && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        <p>This will always be blocked by your safety rules. Are you sure?</p>
                        <div style={{ display: 'flex', gap: 8 }}>
                          <Button size="sm" variant="outline" onClick={denyPrincipleOptions.cancelTrustedTool}>Back</Button>
                          <Button
                            size="sm"
                            onClick={denyPrincipleOptions.confirmTrustedTool}
                            style={{ background: 'linear-gradient(135deg, rgba(239, 68, 68, 0.9) 0%, rgba(220, 38, 38, 0.9) 100%)' }}
                          >
                            Yes, always block
                          </Button>
                        </div>
                      </div>
                    )}

                    {denyPrincipleOptions.applyState === 'applying' && <p>Applying…</p>}

                    {denyPrincipleOptions.applyState === 'error' && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        <p>{denyPrincipleOptions.applyError || 'Failed to apply selection'}</p>
                        <Button size="sm" variant="outline" onClick={denyPrincipleOptions.retryApply}>
                          Retry
                        </Button>
                      </div>
                    )}
                  </div>
                )}
              </DialogBody>
              <DialogFooter>
                <Button variant="ghost" onClick={handleCloseDenyRuleUpdateDialog}>Cancel</Button>
                {denyPrincipleOptions.generationState === 'loaded'
                  && denyPrincipleOptions.applyState === 'idle'
                  && denyPrincipleOptions.selectedOption !== null && (
                    <Button
                      onClick={denyPrincipleOptions.confirmSelection}
                      disabled={denyPrincipleOptions.selectedOption === 'other' && !denyPrincipleOptions.otherText.trim()}
                      style={{ background: 'linear-gradient(135deg, rgba(239, 68, 68, 0.9) 0%, rgba(220, 38, 38, 0.9) 100%)' }}
                    >
                      Save &amp; deny
                    </Button>
                  )}
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}
      </DialogContent>
    </Dialog>
  );
};

export const StagedFilePreviewDialog = memo(StagedFilePreviewDialogComponent);
StagedFilePreviewDialog.displayName = 'StagedFilePreviewDialog';
