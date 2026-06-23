import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import fm from 'front-matter';
import ReactDiffViewer, { DiffMethod } from 'react-diff-viewer-continued';
import {
  AlertTriangle,
  Copy,
  Eye,
  FileDiff,
  History,
  Loader2,
  RefreshCw,
  RotateCcw,
} from 'lucide-react';
import { SafeMarkdown } from '@renderer/components/SafeMarkdown';
import {
  Badge,
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  useToast,
} from '@renderer/components/ui';
import { useAuth } from '@renderer/features/auth/hooks/useAuth';
import { cn } from '@renderer/lib/utils';
import { getSkillActorLabel } from '../utils/skillAttribution';
import { SkillHistoryRow } from './SkillHistoryRow';
import styles from './SkillHistoryPanel.module.css';

type ViewMode = 'diff' | 'preview';

interface SkillHistoryPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  skillName: string;
  documentPath?: string | null;
  skillWorkspacePath: string;
  currentContent: string;
  hasUnsavedChanges?: boolean;
  /** Open a file path in the surrounding document flow. */
  onOpenFilePath: (path: string) => Promise<void> | void;
  onBeforeRestore?: () => boolean;
  onRestoreAttemptAborted?: () => void;
  /** When restore succeeds but no editor buffer is open — release external-commit lock (not an abort). */
  onRestoreExternalCommitReleased?: () => void;
  onRestoreVersionApplied?: (documentPath: string, content: string) => void;
}

interface SkillHistoryVersionSummary {
  snapshotId: string;
  filename: string;
  timestampMs: number;
  contentHash: string;
  summary: string;
  actorKind: 'human' | 'agent';
  actorId: string | null;
  actorLabel: string | null;
  actorEmail: string | null;
  skillWorkspacePath: string;
  restoredFromSnapshotId: string | null;
}

interface SkillHistorySnapshotPayload {
  snapshotId: string;
  timestampMs: number;
  contentHash: string;
  summary: string;
  actorKind: 'human' | 'agent';
  actorId: string | null;
  actorLabel: string | null;
  actorEmail: string | null;
  skillWorkspacePath: string;
  body: string;
  restoredFromSnapshotId: string | null;
  restoredFromSkillPath: string | null;
}

const HISTORY_DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

const DEFAULT_COPY_DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
});

function formatHistoryDate(timestampMs: number): string {
  return HISTORY_DATE_FORMAT.format(new Date(timestampMs));
}

function defaultCopyName(skillName: string, timestampMs: number): string {
  const dateLabel = DEFAULT_COPY_DATE_FORMAT.format(new Date(timestampMs));
  return `${skillName} (${dateLabel} copy)`;
}

function isSummaryPending(summary: string): boolean {
  return summary.trim() === 'Computing...';
}

const NOISE_SUMMARY_PATTERN = /^no\s+(changes?\s+)?detect|^metadata\s+restructur|^no\s+content\s+change|^both\s+(BEFORE\s+and\s+AFTER|documents?|are)\s+(are\s+)?identical/i;
const DRIVE_HISTORY_UNAVAILABLE_PREFIX = 'drive-history-unavailable';

function formatHistoryErrorMessage(raw: string): string {
  if (!raw.startsWith(DRIVE_HISTORY_UNAVAILABLE_PREFIX)) {
    return raw;
  }
  if (raw.includes('not-google-drive-backed')) {
    return 'Version history is available for shared skills stored in Google Drive.';
  }
  if (raw.includes('google-account-unresolved')) {
    return 'Connect a Google Workspace account in Settings to view version history for this skill.';
  }
  if (raw.includes('file-id-unresolved')) {
    return 'Rebel could not match this skill to a Google Drive file history yet.';
  }
  return 'Version history is unavailable for this skill right now.';
}

function cleanSummary(summary: string): string {
  if (!summary || summary === 'No summary yet.' || summary === 'Summary unavailable') return 'Saved version';
  if (NOISE_SUMMARY_PATTERN.test(summary.trim())) return 'Saved version';
  return summary;
}

function getPreviewBody(content: string): string {
  try {
    return fm(content).body || content;
  } catch {
    return content;
  }
}

async function openWorkspacePath(
  path: string,
  onOpenFilePath: (path: string) => Promise<void> | void,
  onOpenChange?: (open: boolean) => void,
) {
  await onOpenFilePath(path);
  onOpenChange?.(false);
}

export function SkillHistoryPanel({
  open,
  onOpenChange,
  skillName,
  documentPath,
  skillWorkspacePath,
  currentContent,
  hasUnsavedChanges = false,
  onOpenFilePath,
  onBeforeRestore,
  onRestoreAttemptAborted,
  onRestoreExternalCommitReleased,
  onRestoreVersionApplied,
}: SkillHistoryPanelProps) {
  const { user } = useAuth();
  const { showToast } = useToast();
  const isMountedRef = useRef(true);
  const [versions, setVersions] = useState<SkillHistoryVersionSummary[]>([]);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [versionsError, setVersionsError] = useState<string | null>(null);
  const [selectedSnapshotId, setSelectedSnapshotId] = useState<string | null>(null);
  const [selectedSnapshot, setSelectedSnapshot] = useState<SkillHistorySnapshotPayload | null>(null);
  const [snapshotLoading, setSnapshotLoading] = useState(false);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('diff');
  const [restoreIntentSnapshotId, setRestoreIntentSnapshotId] = useState<string | null>(null);
  const [restoringSnapshotId, setRestoringSnapshotId] = useState<string | null>(null);
  const [forkingSnapshotId, setForkingSnapshotId] = useState<string | null>(null);
  const [copyNamePrompt, setCopyNamePrompt] = useState<{ version: SkillHistoryVersionSummary; name: string } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [currentSkillContent, setCurrentSkillContent] = useState(currentContent);
  const [isDarkMode, setIsDarkMode] = useState(() => document.body.classList.contains('dark'));

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setIsDarkMode(document.body.classList.contains('dark'));
    });
    observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!open) {
      setVersions([]);
      setVersionsLoading(false);
      setVersionsError(null);
      setSelectedSnapshotId(null);
      setSelectedSnapshot(null);
      setSnapshotLoading(false);
      setSnapshotError(null);
      setRestoreIntentSnapshotId(null);
      setCopyNamePrompt(null);
      setActionError(null);
      setViewMode('diff');
      return;
    }

    setCurrentSkillContent(currentContent);
  }, [currentContent, open]);

  const loadVersions = useCallback(async () => {
    setVersionsLoading(true);
    setVersionsError(null);
    try {
      const result = await window.skillHistoryApi.getVersions({ skillWorkspacePath });
      if (!isMountedRef.current) {
        return;
      }
      if (!result.success) {
        setVersions([]);
        setVersionsError(formatHistoryErrorMessage(result.error));
        return;
      }

      setVersions(result.versions);
      setSelectedSnapshotId((previous) => {
        if (previous && result.versions.some((version) => version.snapshotId === previous)) {
          return previous;
        }
        return result.versions[0]?.snapshotId ?? null;
      });
    } catch (error) {
      if (!isMountedRef.current) {
        return;
      }
      setVersions([]);
      const message = error instanceof Error ? error.message : 'Failed to load skill history.';
      setVersionsError(formatHistoryErrorMessage(message));
    } finally {
      if (!isMountedRef.current) {
        return;
      }
      setVersionsLoading(false);
    }
  }, [skillWorkspacePath]);

  useEffect(() => {
    if (!open) {
      return;
    }
    void loadVersions();
  }, [loadVersions, open]);

  const fetchSnapshot = useCallback(async (snapshotId: string) => {
    try {
      const result = await window.skillHistoryApi.getSnapshot({
        skillWorkspacePath,
        snapshotId,
      });
      if (!result.success) {
        return { success: false as const, error: formatHistoryErrorMessage(result.error) };
      }
      return { success: true as const, snapshot: result.snapshot };
    } catch (error) {
      return {
        success: false as const,
        error: formatHistoryErrorMessage(error instanceof Error ? error.message : 'Failed to load version preview.'),
      };
    }
  }, [skillWorkspacePath]);

  useEffect(() => {
    if (!open || !selectedSnapshotId) {
      setSelectedSnapshot(null);
      setSnapshotError(null);
      return;
    }

    let active = true;
    setSelectedSnapshot(null);
    setSnapshotLoading(true);
    setSnapshotError(null);

    void (async () => {
      const result = await fetchSnapshot(selectedSnapshotId);
      if (!active) {
        return;
      }

      if (!result.success) {
        setSelectedSnapshot(null);
        setSnapshotError(result.error);
        setSnapshotLoading(false);
        return;
      }

      setSelectedSnapshot(result.snapshot);
      setSnapshotLoading(false);
    })();

    return () => {
      active = false;
    };
  }, [fetchSnapshot, open, selectedSnapshotId]);

  const selectedVersion = useMemo(
    () => versions.find((version) => version.snapshotId === selectedSnapshotId) ?? null,
    [selectedSnapshotId, versions],
  );

  const selectedActorLabel = useMemo(() => {
    if (!selectedVersion) {
      return null;
    }
    return (
      getSkillActorLabel(
        {
          id: selectedVersion.actorId ?? undefined,
          name: selectedVersion.actorLabel ?? undefined,
          email: selectedVersion.actorEmail ?? undefined,
        },
        user,
      ) ?? 'Unknown contributor'
    );
  }, [selectedVersion, user]);

  const previewContent = useMemo(() => {
    if (!selectedSnapshot) {
      return null;
    }

    return getPreviewBody(selectedSnapshot.body);
  }, [selectedSnapshot]);

  const diffStyles = useMemo(
    () => ({
      variables: {
        dark: {
          diffViewerBackground: 'rgba(15, 23, 42, 0.45)',
          diffViewerColor: 'rgba(248, 250, 255, 0.9)',
          addedBackground: 'rgba(34, 197, 94, 0.15)',
          addedColor: '#86efac',
          removedBackground: 'rgba(239, 68, 68, 0.15)',
          removedColor: '#fca5a5',
          wordAddedBackground: 'rgba(34, 197, 94, 0.28)',
          wordRemovedBackground: 'rgba(239, 68, 68, 0.28)',
          addedGutterBackground: 'rgba(34, 197, 94, 0.1)',
          removedGutterBackground: 'rgba(239, 68, 68, 0.1)',
          gutterBackground: 'rgba(15, 23, 42, 0.82)',
          gutterBackgroundDark: 'rgba(15, 23, 42, 0.92)',
          highlightBackground: 'rgba(99, 102, 241, 0.1)',
          highlightGutterBackground: 'rgba(99, 102, 241, 0.16)',
          codeFoldGutterBackground: 'rgba(30, 41, 59, 0.55)',
          codeFoldBackground: 'rgba(30, 41, 59, 0.35)',
          emptyLineBackground: 'rgba(30, 41, 59, 0.25)',
          gutterColor: 'rgba(148, 163, 184, 0.65)',
          addedGutterColor: '#86efac',
          removedGutterColor: '#fca5a5',
          codeFoldContentColor: 'rgba(148, 163, 184, 0.85)',
          diffViewerTitleBackground: 'rgba(30, 41, 59, 0.55)',
          diffViewerTitleColor: 'rgba(248, 250, 255, 0.92)',
          diffViewerTitleBorderColor: 'rgba(148, 163, 184, 0.16)',
        },
        light: {
          diffViewerBackground: 'rgba(255, 255, 255, 0.92)',
          diffViewerColor: '#1e293b',
          addedBackground: 'rgba(34, 197, 94, 0.1)',
          addedColor: '#166534',
          removedBackground: 'rgba(239, 68, 68, 0.1)',
          removedColor: '#b91c1c',
          wordAddedBackground: 'rgba(34, 197, 94, 0.22)',
          wordRemovedBackground: 'rgba(239, 68, 68, 0.22)',
          addedGutterBackground: 'rgba(34, 197, 94, 0.08)',
          removedGutterBackground: 'rgba(239, 68, 68, 0.08)',
          gutterBackground: 'rgba(241, 245, 249, 0.85)',
          gutterBackgroundDark: 'rgba(226, 232, 240, 0.85)',
          highlightBackground: 'rgba(79, 70, 229, 0.08)',
          highlightGutterBackground: 'rgba(79, 70, 229, 0.12)',
          codeFoldGutterBackground: 'rgba(241, 245, 249, 0.55)',
          codeFoldBackground: 'rgba(241, 245, 249, 0.32)',
          emptyLineBackground: 'rgba(241, 245, 249, 0.22)',
          gutterColor: '#64748b',
          addedGutterColor: '#166534',
          removedGutterColor: '#b91c1c',
          codeFoldContentColor: '#64748b',
          diffViewerTitleBackground: 'rgba(241, 245, 249, 0.55)',
          diffViewerTitleColor: '#1e293b',
          diffViewerTitleBorderColor: 'rgba(148, 163, 184, 0.2)',
        },
      },
      line: {
        padding: '4px 8px',
        fontSize: '13px',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      },
      contentText: {
        fontSize: '13px',
        lineHeight: '1.5',
      },
    }),
    [],
  );

  const handleConfirmRestore = useCallback(
    async (snapshotId: string) => {
      if (onBeforeRestore && !onBeforeRestore()) {
        onRestoreAttemptAborted?.();
        showToast({
          title: 'Wait for the current save to finish, then try restoring again.',
          variant: 'warning',
        });
        return;
      }

      setRestoringSnapshotId(snapshotId);
      setActionError(null);
      let restoreLockPrepared = true;
      try {
        let snapshot = selectedSnapshot;
        if (!snapshot || snapshot.snapshotId !== snapshotId) {
          const loaded = await fetchSnapshot(snapshotId);
          if (!isMountedRef.current) {
            if (restoreLockPrepared) {
              onRestoreAttemptAborted?.();
            }
            return;
          }
          if (!loaded.success) {
            onRestoreAttemptAborted?.();
            setActionError(loaded.error);
            showToast({ title: loaded.error, variant: 'error' });
            return;
          }
          snapshot = loaded.snapshot;
          if (selectedSnapshotId === snapshotId) {
            setSelectedSnapshot(loaded.snapshot);
          }
        }

        const result = await window.skillHistoryApi.restore({
          skillWorkspacePath,
          snapshotId,
        });
        if (!isMountedRef.current) {
          if (restoreLockPrepared) {
            onRestoreAttemptAborted?.();
          }
          return;
        }

        if (!result.success) {
          onRestoreAttemptAborted?.();
          const message = result.conflict
            ? 'The current skill changed before restore completed. Reload and try again.'
            : formatHistoryErrorMessage(result.error);
          setActionError(message);
          showToast({
            title: message,
            variant: result.conflict ? 'warning' : 'error',
          });
          return;
        }

        let restoredContent = snapshot.body;
        let restoreSyncWarning: string | null = null;
        try {
          const restoredFile = await window.libraryApi.readFile(skillWorkspacePath);
          if (!isMountedRef.current) {
            if (restoreLockPrepared) {
              onRestoreAttemptAborted?.();
            }
            return;
          }
          restoredContent = restoredFile.content;
        } catch {
          restoreSyncWarning = 'The skill was restored, but the latest collaboration metadata could not be refreshed automatically. Reload if anything looks stale.';
        }

        if (!isMountedRef.current) {
          if (restoreLockPrepared) {
            onRestoreAttemptAborted?.();
          }
          return;
        }
        setCurrentSkillContent(restoredContent);
        if (documentPath) {
          onRestoreVersionApplied?.(documentPath, restoredContent);
        } else {
          onRestoreExternalCommitReleased?.();
        }
        restoreLockPrepared = false;
        setRestoreIntentSnapshotId(null);
        await loadVersions();
        showToast({
          title: `${skillName} restored`,
          description: restoreSyncWarning ?? 'That version is live again. You can still undo from history if needed.',
          variant: restoreSyncWarning ? 'warning' : 'success',
        });
      } catch (error) {
        onRestoreAttemptAborted?.();
        const message = error instanceof Error ? error.message : 'Failed to restore this version.';
        setActionError(message);
        showToast({ title: message, variant: 'error' });
      } finally {
        setRestoringSnapshotId(null);
      }
    },
    [
      loadVersions,
      onRestoreVersionApplied,
      selectedSnapshot,
      selectedSnapshotId,
      showToast,
      skillName,
      skillWorkspacePath,
      fetchSnapshot,
      documentPath,
      onBeforeRestore,
      onRestoreAttemptAborted,
      onRestoreExternalCommitReleased,
    ],
  );

  const handleRequestRestore = useCallback(
    (snapshotId: string) => {
      setSelectedSnapshotId(snapshotId);
      setActionError(null);
      if (restoreIntentSnapshotId === snapshotId) {
        void handleConfirmRestore(snapshotId);
        return;
      }
      setRestoreIntentSnapshotId(snapshotId);
    },
    [handleConfirmRestore, restoreIntentSnapshotId],
  );

  const handleRequestCopy = useCallback(
    (version: SkillHistoryVersionSummary) => {
      setCopyNamePrompt({
        version,
        name: defaultCopyName(skillName, version.timestampMs),
      });
    },
    [skillName],
  );

  const handleConfirmCopy = useCallback(
    async () => {
      if (!copyNamePrompt) return;
      const { version, name } = copyNamePrompt;
      setCopyNamePrompt(null);
      setForkingSnapshotId(version.snapshotId);
      setActionError(null);
      try {
        const result = await window.skillHistoryApi.fork({
          skillWorkspacePath,
          snapshotId: version.snapshotId,
          forkName: name.trim() || undefined,
        });
        if (!result.success) {
          const message = formatHistoryErrorMessage(result.error);
          setActionError(message);
          showToast({ title: message, variant: 'error' });
          return;
        }

        showToast({
          title: `"${name.trim()}" saved to your Library.`,
          variant: 'success',
          action: {
            label: 'Open it',
            onClick: () => {
              void openWorkspacePath(result.forkPath, onOpenFilePath, onOpenChange);
            },
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Could not save this version as a new skill.';
        setActionError(message);
        showToast({ title: message, variant: 'error' });
      } finally {
        setForkingSnapshotId(null);
      }
    },
    [copyNamePrompt, onOpenChange, onOpenFilePath, showToast, skillWorkspacePath],
  );

  const restoreIntentVersion = useMemo(
    () => versions.find((version) => version.snapshotId === restoreIntentSnapshotId) ?? null,
    [restoreIntentSnapshotId, versions],
  );

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      disableOutsideClose={Boolean(restoringSnapshotId)}
      disableEscapeClose={Boolean(restoringSnapshotId)}
    >
      <DialogContent className={styles.dialog}>
        <DialogHeader onClose={restoringSnapshotId ? undefined : () => onOpenChange(false)}>
          <DialogTitle className={styles.title}>
            <History size={18} className={styles.titleIcon} />
            Version history - {skillName}
          </DialogTitle>
          <DialogDescription className={styles.description}>
            Browse past versions. You can restore an older one or save a copy as a new skill.
          </DialogDescription>
        </DialogHeader>

        <DialogBody className={styles.body}>
          {actionError && (
            <div className={styles.banner} data-tone="error">
              <AlertTriangle size={16} />
              <span>{actionError}</span>
            </div>
          )}

          {restoreIntentVersion && (
            <div className={styles.banner} data-tone="warning">
              <AlertTriangle size={16} />
              <div className={styles.bannerBody}>
                <strong>Restore this version?</strong>
                <span>
                  {hasUnsavedChanges
                    ? 'Your unsaved editor draft will be replaced with this selected version.'
                    : 'The current shared skill will be replaced with this selected version.'}
                </span>
              </div>
              <div className={styles.bannerActions}>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setRestoreIntentSnapshotId(null)}
                  disabled={Boolean(restoringSnapshotId)}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  onClick={() => void handleConfirmRestore(restoreIntentVersion.snapshotId)}
                  disabled={Boolean(restoringSnapshotId)}
                >
                  {restoringSnapshotId === restoreIntentVersion.snapshotId ? (
                    <Loader2 size={14} className={styles.spinner} />
                  ) : (
                    <RotateCcw size={14} />
                  )}
                  Restore now
                </Button>
              </div>
            </div>
          )}

          {copyNamePrompt && (
            <div className={styles.banner} data-tone="warning">
              <Copy size={16} />
              <div className={styles.bannerBody}>
                <strong>Name your new skill</strong>
                <Input
                  value={copyNamePrompt.name}
                  onChange={(e) => setCopyNamePrompt((prev) => prev ? { ...prev, name: e.target.value } : null)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void handleConfirmCopy();
                    if (e.key === 'Escape') setCopyNamePrompt(null);
                  }}
                  placeholder="My new skill"
                  autoFocus
                />
              </div>
              <div className={styles.bannerActions}>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setCopyNamePrompt(null)}
                  disabled={Boolean(forkingSnapshotId)}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  onClick={() => void handleConfirmCopy()}
                  disabled={Boolean(forkingSnapshotId) || !copyNamePrompt.name.trim()}
                >
                  {forkingSnapshotId ? (
                    <Loader2 size={14} className={styles.spinner} />
                  ) : (
                    <Copy size={14} />
                  )}
                  Save
                </Button>
              </div>
            </div>
          )}

          <div className={styles.layout}>
            <section className={styles.sidebar}>
              <div className={styles.sidebarHeader}>
                <span className={styles.sectionLabel}>Versions</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className={styles.refreshButton}
                  onClick={() => void loadVersions()}
                  disabled={versionsLoading}
                >
                  {versionsLoading ? <Loader2 size={14} className={styles.spinner} /> : <RefreshCw size={14} />}
                  Refresh
                </Button>
              </div>

              {versionsLoading && versions.length === 0 ? (
                <div className={styles.emptyState}>
                  <Loader2 size={18} className={styles.spinner} />
                  <span>Loading version history...</span>
                </div>
              ) : versionsError ? (
                <div className={styles.emptyState}>
                  <AlertTriangle size={18} />
                  <span>{versionsError}</span>
                  <Button size="sm" variant="outline" onClick={() => void loadVersions()}>
                    Try again
                  </Button>
                </div>
              ) : versions.length === 0 ? (
                <div className={styles.emptyState}>
                  <History size={18} />
                  <span>No saved versions yet.</span>
                  <p className={styles.emptyDetail}>
                    Once this shared skill changes, previous versions will show up here.
                  </p>
                </div>
              ) : (
                <div className={styles.versionList}>
                  {versions.map((version) => (
                    <SkillHistoryRow
                      key={version.snapshotId}
                      timestampLabel={formatHistoryDate(version.timestampMs)}
                      actorLabel={
                        getSkillActorLabel(
                          {
                            id: version.actorId ?? undefined,
                            name: version.actorLabel ?? undefined,
                            email: version.actorEmail ?? undefined,
                          },
                          user,
                        ) ?? 'Unknown contributor'
                      }
                      summary={cleanSummary(version.summary)}
                      isSummaryPending={isSummaryPending(version.summary)}
                      isSelected={version.snapshotId === selectedSnapshotId}
                      isPreviewLoading={snapshotLoading && version.snapshotId === selectedSnapshotId}
                      isRestorePending={restoreIntentSnapshotId === version.snapshotId}
                      isRestoring={restoringSnapshotId === version.snapshotId}
                      isForking={forkingSnapshotId === version.snapshotId}
                      isRestoredVersion={Boolean(version.restoredFromSnapshotId)}
                      onSelect={() => {
                        setSelectedSnapshotId(version.snapshotId);
                        setRestoreIntentSnapshotId(null);
                        setActionError(null);
                      }}
                      onRestore={() => handleRequestRestore(version.snapshotId)}
                      onFork={() => handleRequestCopy(version)}
                    />
                  ))}
                </div>
              )}
            </section>

            <section className={styles.previewPane}>
              {selectedVersion ? (
                <>
                  <div className={styles.previewHeader}>
                    <div className={styles.previewTitleGroup}>
                      <span className={styles.sectionLabel}>Selected version</span>
                      <h3 className={styles.previewTitle}>{formatHistoryDate(selectedVersion.timestampMs)}</h3>
                      <div className={styles.previewMeta}>
                        <span>{selectedActorLabel}</span>
                        {selectedVersion.restoredFromSnapshotId && (
                          <Badge variant="outline" size="sm">
                            Restored version
                          </Badge>
                        )}
                        {isSummaryPending(selectedVersion.summary) && (
                          <Badge variant="muted" size="sm">
                            <Loader2 size={11} className={styles.spinner} />
                            Computing...
                          </Badge>
                        )}
                      </div>
                      <p className={styles.previewSummary}>
                        {cleanSummary(selectedVersion.summary)}
                      </p>
                    </div>

                    <div className={styles.viewToggle}>
                      <Button
                        variant="ghost"
                        size="sm"
                        className={cn(styles.toggleButton, viewMode === 'diff' && styles.toggleButtonActive)}
                        onClick={() => setViewMode('diff')}
                      >
                        <FileDiff size={14} />
                        Diff
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className={cn(styles.toggleButton, viewMode === 'preview' && styles.toggleButtonActive)}
                        onClick={() => setViewMode('preview')}
                      >
                        <Eye size={14} />
                        Preview
                      </Button>
                    </div>
                  </div>

                  {hasUnsavedChanges && (
                    <div className={styles.inlineNotice}>
                      <AlertTriangle size={14} />
                      <span>
                        Preview compares against the last saved skill. You still have unsaved editor changes open.
                      </span>
                    </div>
                  )}

                  <div className={styles.previewSurface}>
                    {snapshotLoading ? (
                      <div className={styles.emptyState}>
                        <Loader2 size={18} className={styles.spinner} />
                        <span>Loading version preview...</span>
                      </div>
                    ) : snapshotError ? (
                      <div className={styles.emptyState}>
                        <AlertTriangle size={18} />
                        <span>{snapshotError}</span>
                      </div>
                    ) : !selectedSnapshot ? (
                      <div className={styles.emptyState}>
                        <History size={18} />
                        <span>Select a version to inspect it.</span>
                      </div>
                    ) : viewMode === 'diff' ? (
                      <div className={styles.diffWrapper}>
                        <ReactDiffViewer
                          oldValue={currentSkillContent}
                          newValue={selectedSnapshot.body}
                          splitView
                          useDarkTheme={isDarkMode}
                          compareMethod={DiffMethod.WORDS}
                          styles={diffStyles}
                          leftTitle="Current skill"
                          rightTitle="Selected version"
                          hideLineNumbers={false}
                        />
                      </div>
                    ) : (
                      <div className={styles.previewMarkdown}>
                        <SafeMarkdown>{previewContent ?? selectedSnapshot.body}</SafeMarkdown>
                      </div>
                    )}
                  </div>

                  <div className={styles.previewActions}>
                    <Button
                      variant="outline"
                      onClick={() => handleRequestRestore(selectedVersion.snapshotId)}
                      disabled={Boolean(restoringSnapshotId || snapshotLoading)}
                    >
                      {restoringSnapshotId === selectedVersion.snapshotId ? (
                        <Loader2 size={14} className={styles.spinner} />
                      ) : (
                        <RotateCcw size={14} />
                      )}
                      Restore this version
                    </Button>
                    <Button
                      onClick={() => handleRequestCopy(selectedVersion)}
                      disabled={Boolean(forkingSnapshotId || snapshotLoading)}
                    >
                      {forkingSnapshotId === selectedVersion.snapshotId ? (
                        <Loader2 size={14} className={styles.spinner} />
                      ) : (
                        <Copy size={14} />
                      )}
                      Save as new skill
                    </Button>
                  </div>
                </>
              ) : (
                <div className={styles.emptyState}>
                  <History size={18} />
                  <span>Select a version to inspect it.</span>
                </div>
              )}
            </section>
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
