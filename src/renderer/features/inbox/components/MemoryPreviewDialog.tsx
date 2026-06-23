import { useCallback, useEffect, useMemo, useState } from 'react';
import ReactDiffViewer, { DiffMethod } from 'react-diff-viewer-continued';
import { Brain, User, Columns, FileCode, Loader2, RefreshCw } from 'lucide-react';
import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogBody,
  DialogFooter,
  FileLocationBadge,
  Tooltip,
} from '@renderer/components/ui';
import { BlastRadiusStrip } from '@renderer/components/approval/actionPreview/BlastRadiusStrip';
import { getFileName } from '@renderer/utils/stringUtils';
import { isMarkdownPath } from '@renderer/utils/documentUtils';
import { SafeMarkdown } from '@renderer/components/SafeMarkdown';
import { useApprovalContent } from '@rebel/cloud-client';
import { legacyMissingLocation } from '@rebel/shared';
import type { BlastRadius, RiskReason } from '@rebel/shared';
import type { ApprovalContentItem } from '@rebel/cloud-client';
import type { PendingApprovalItem } from '../hooks/usePendingApprovals';
import { diffViewerStyles } from './diffViewerStyles';
import styles from './MemoryPreviewDialog.module.css';

/**
 * Build a user-visible error message for explicit content-load failures.
 *
 * Non-ENOENT remote-original failures (permission / network / other) must
 * surface an explicit error rather than silently falling back to "no
 * content". Per D8 in
 * `docs/plans/260416_centralize_approval_and_diff_viewing_ux.md`.
 */
function buildMemoryErrorMessage(
  err: { kind: 'missing' | 'permission' | 'network' | 'binary' | 'other'; detail: string },
): string {
  const prefix = 'Couldn\u2019t load the current version';
  switch (err.kind) {
    case 'permission':
      return `${prefix} \u2014 permission denied.`;
    case 'network':
      return `${prefix} \u2014 network error.`;
    case 'binary':
      return 'The existing file isn\u2019t previewable here.';
    case 'other':
    default:
      return `${prefix}${err.detail ? ` \u2014 ${err.detail}` : '.'}`;
  }
}

type ViewMode = 'diff' | 'preview';

type MemoryApprovalContentIdentity = {
  toolUseId: string;
  originalSessionId?: string;
  filePath?: string;
  approvalIdentifier?: string;
};

export type MemoryPreviewDialogProps = {
  approval: PendingApprovalItem;
  onClose: () => void;
  onApprove: (allowForSession: boolean) => void;
  onDiscard: () => void;
  privateMode?: boolean;
  blastRadius?: BlastRadius;
  riskReasons?: RiskReason[];
  /** Additional class for the Dialog overlay (used for z-index overrides) */
  overlayClassName?: string;
  readMemoryApprovalContent?: (
    identity: MemoryApprovalContentIdentity,
    signal: AbortSignal,
  ) => Promise<string | null>;
};

export const MemoryPreviewDialog = ({
  approval,
  onClose,
  onApprove,
  onDiscard,
  privateMode,
  blastRadius,
  riskReasons,
  overlayClassName,
  readMemoryApprovalContent,
}: MemoryPreviewDialogProps) => {
  const [isApproving, setIsApproving] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>('diff');
  const [isDarkMode, setIsDarkMode] = useState(() => document.body.classList.contains('dark'));

  useEffect(() => {
    setIsApproving(false);
  }, [approval.id]);

  const memoryApproval = approval.memoryApproval;
  const filename = memoryApproval ? getFileName(memoryApproval.filePath) : null;
  const isSharedSkillCheckpoint = memoryApproval?.approvalKind === 'shared_skill_checkpoint';
  const location = memoryApproval
    ? (memoryApproval.location
      ?? legacyMissingLocation({
        fileName: filename ?? undefined,
        spaceName: memoryApproval.spaceName,
        legacyPath: memoryApproval.spacePath || memoryApproval.filePath,
      }))
    : null;

  // Shared content-fetching hook — replaces the prior inline load effect.
  // See docs/plans/260416_centralize_approval_and_diff_viewing_ux.md Stage 2.
  //
  // `memoryApproval` is typed slightly differently from cloud-client's
  // `MemoryWriteApproval` (desktop carries a `content` field; cloud-client
  // only exposes `contentPreview`). The hook discriminates by the shape
  // `{ toolUseId, filePath }`, so passing the renderer shape directly works.
  const hookItem = useMemo<ApprovalContentItem | null>(() => {
    if (!memoryApproval) return null;
    // Cast to ApprovalContentItem — the renderer memoryApproval is a
    // superset of the cloud-client MemoryWriteApproval on the fields the
    // hook reads (toolUseId, filePath, content/contentPreview).
    return memoryApproval as unknown as ApprovalContentItem;
  }, [memoryApproval]);

  const {
    status: contentStatus,
    staged: recoveredContent,
    original: hookOriginal,
    loading: isLoadingOriginal,
    error: hookError,
    conflict: hookConflict,
    refetch,
  } = useApprovalContent(hookItem, {
    // Memory approval carries inline content; no staged-IPC call is needed.
    // The hook will use `content ?? contentPreview` from the item directly.
    readStagedContent: async () => null,
    readWorkspaceFile: async (path) => window.api.readWorkspaceFile(path),
    readMemoryApprovalContent,
  });

  // F2-2 error branching per Stage 2 D8 ("Fail loudly, not silently"):
  //  - null / missing (ENOENT)               → hook surfaces isNewFile + error:null;
  //                                             we keep the existing "new content" UX
  //                                             (no diff — the file doesn't exist yet)
  //  - binary | permission | network | other → explicit error UI + Retry,
  //                                             Allow disabled
  const isExplicitContentError = contentStatus === 'error' || (hookError !== null && hookError.kind !== 'missing');
  const originalContent = isExplicitContentError ? null : hookOriginal;
  const contentErrorMessage = isExplicitContentError && hookError
    ? buildMemoryErrorMessage(hookError)
    : 'Couldn’t load content.';
  const content = contentStatus === 'revealed' || contentStatus === 'empty'
    ? (recoveredContent ?? '')
    : '';
  const isWaitingForContent = contentStatus === 'not-loaded' || contentStatus === 'loading' || isLoadingOriginal;
  const isRecoveredEmpty = contentStatus === 'empty';

  // Observe theme changes
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setIsDarkMode(document.body.classList.contains('dark'));
    });
    observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  // Conflict detection is centralized in the hook (see D8 + Stage 2 plan).
  // `hookConflict` is true only when staged and original both exist AND
  // differ, so we reuse it verbatim as the "show a diff is meaningful" signal.
  // When we're blocked by an explicit error, never show a diff — the baseline
  // is untrustworthy.
  const hasDiff = !isExplicitContentError && hookConflict;
  const isMarkdown = filename ? isMarkdownPath(filename) : false;

  // Stage 5 R2 (F5-1): deliberately does NOT call `computeDiff` here yet.
  // Calling it to populate a memoized but never-rendered value was flagged
  // by three reviewers as dead synchronous CPU on the render thread (Myers
  // LCS is O(N*D)) with zero user-facing payoff. `hasDiff` already covers
  // byte-level "no actual changes" detection. Stage 6 will re-wire
  // `computeDiff` here once it drives real UI on mobile (visible
  // `+N / -M` stats).

  const showDiffView = hasDiff && viewMode === 'diff';

  const handleApprove = useCallback((allowForSession: boolean) => {
    if (isApproving) return;
    setIsApproving(true);
    onApprove(allowForSession);
  }, [onApprove, isApproving]);

  const handleDiscard = useCallback(() => {
    onDiscard();
    onClose();
  }, [onDiscard, onClose]);

  const handleOpenChange = useCallback((open: boolean) => {
    if (!open && !isApproving) {
      onClose();
    }
  }, [onClose, isApproving]);

  if (!memoryApproval) {
    return null;
  }

  const showSessionOption = !isSharedSkillCheckpoint && !privateMode && !memoryApproval.privateMode && Boolean(approval.sessionId);

  return (
    <Dialog
      open={true}
      onOpenChange={handleOpenChange}
      disableOutsideClose={isApproving}
      disableEscapeClose={isApproving}
      overlayClassName={overlayClassName}
    >
      <DialogContent size="lg" className={hasDiff ? styles.dialogContentWide : styles.dialogContent} data-testid="memory-preview-dialog">
        <DialogHeader
          icon={
            <div className={styles.iconContainer}>
              <Brain size={20} className={styles.icon} />
            </div>
          }
          onClose={isApproving ? undefined : onClose}
        >
          <div className={styles.headerRow}>
            <DialogTitle>{isSharedSkillCheckpoint ? 'Confirm shared skill update' : 'Preview Memory Write'}</DialogTitle>
            {hasDiff && (
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
                  title="Show full content"
                >
                  <FileCode size={14} />
                  Preview
                </button>
              </div>
            )}
          </div>
          {isSharedSkillCheckpoint && memoryApproval.authorLabel && (
            <div className={styles.authorLine}>
              <User size={14} />
              <span>Created by <strong>{memoryApproval.authorLabel}</strong></span>
            </div>
          )}
          {location && (
            <div className={styles.destination}>
              <FileLocationBadge location={location} />
            </div>
          )}
          {blastRadius && (
            <BlastRadiusStrip
              blastRadius={blastRadius}
              riskReasons={riskReasons}
            />
          )}
        </DialogHeader>

        <DialogBody className={styles.body}>
          {memoryApproval.summary && (
            <div className={styles.summary}>
              {memoryApproval.summary}
            </div>
          )}
          <div className={`${styles.contentContainer}${showDiffView ? '' : ` ${styles.contentPadded}`}`}>
            {isWaitingForContent ? (
              <div className={styles.loading}>
                <Loader2 size={20} className={styles.spinner} />
                <span>Loading...</span>
              </div>
            ) : isExplicitContentError ? (
              <div className={styles.error} role="alert" data-testid="memory-preview-recovery-error">
                <span>{contentErrorMessage}</span>
                <div data-testid="memory-preview-recovery-retry-state">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => refetch()}
                    aria-label="Retry loading content"
                    data-testid="memory-preview-retry-button"
                  >
                    <RefreshCw size={14} />
                    Retry
                  </Button>
                </div>
              </div>
            ) : showDiffView ? (
              <div className={styles.diffWrapper}>
                <ReactDiffViewer
                  oldValue={originalContent ?? ''}
                  newValue={content}
                  splitView={true}
                  useDarkTheme={isDarkMode}
                  compareMethod={DiffMethod.WORDS}
                  styles={diffViewerStyles}
                  leftTitle="Current"
                  rightTitle="Proposed"
                  hideLineNumbers={false}
                />
              </div>
            ) : isRecoveredEmpty ? (
              <pre className={styles.content} data-testid="memory-preview-empty-content">No content to show.</pre>
            ) : isMarkdown ? (
              <div className={styles.markdownContent}>
                <SafeMarkdown>{content}</SafeMarkdown>
              </div>
            ) : (
              <pre className={styles.content}>{content}</pre>
            )}
          </div>
        </DialogBody>

        <DialogFooter>
          <Button variant="ghost" onClick={handleDiscard} disabled={isApproving}>
            {isSharedSkillCheckpoint ? 'Keep shared skill unchanged' : 'Discard'}
          </Button>
          <div className={styles.spacer} />
          <Button variant="ghost" onClick={onClose} disabled={isApproving}>
            Cancel
          </Button>
          {showSessionOption && (
            <Tooltip
              content={isExplicitContentError
                ? 'Resolve the load error before allowing this write'
                : 'Allow all writes to this file for the rest of this conversation'}
              delayShow={300}
            >
              <span>
                <Button
                  variant="outline"
                  onClick={() => handleApprove(true)}
                  disabled={isApproving || isExplicitContentError}
                >
                  Allow for conversation
                </Button>
              </span>
            </Tooltip>
          )}
          <Button
            variant="default"
            onClick={() => handleApprove(false)}
            disabled={isApproving || isExplicitContentError}
          >
            {isSharedSkillCheckpoint ? 'Confirm and continue' : 'Allow'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

MemoryPreviewDialog.displayName = 'MemoryPreviewDialog';
