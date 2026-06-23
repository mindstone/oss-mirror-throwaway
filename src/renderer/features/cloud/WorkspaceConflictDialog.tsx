import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Check, Cloud, Laptop, Sparkles, X } from 'lucide-react';
import {
  Button,
  Card,
  CardContent,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Spinner,
  Textarea,
} from '@renderer/components/ui';
import type { ShowToastFn } from '@renderer/contexts';

type WorkspaceConflictEntry = {
  localPath: string;
  cloudCopyPath: string;
  relativePath: string;
};

/**
 * A "pending cloud update": a file whose newer version arrived from the synced
 * workspace (another device, a teammate, or Rebel's own agent — provenance is
 * unknown to the sync engine) and lives only in Rebel's cloud. The desktop
 * deliberately did NOT
 * overwrite it (an OS sync engine owns the local write), so we offer a calm,
 * one-click safe fast-forward. This is a DISTINCT, single-action state — NOT a
 * three-way conflict (only the cloud side changed; nothing local to lose).
 * See the chief-designer brief 260619_111500 (REBEL-696 Stage 5).
 *
 * PUBLIC SHAPE: only `relativePath` crosses the preload boundary. The
 * store-internal fingerprints (`cloudHash`/`baselineLocalHash`) and timestamps
 * stay main-side — the renderer only ever needs the path to render a card and
 * call apply; the apply handler reads the baseline from the store itself.
 */
type PendingCloudUpdateEntry = {
  relativePath: string;
};

type PendingConflictAction = 'merge' | 'keep-local' | 'keep-cloud' | 'accept-merge';

interface WorkspaceConflictDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialConflictPaths?: string[];
  showToast: ShowToastFn;
}

function pruneByActivePaths<T>(entries: Record<string, T>, activePaths: Set<string>): Record<string, T> {
  const next: Record<string, T> = {};
  for (const [path, value] of Object.entries(entries)) {
    if (activePaths.has(path)) {
      next[path] = value;
    }
  }
  return next;
}

function removeEntry<T>(entries: Record<string, T>, key: string): Record<string, T> {
  if (!(key in entries)) {
    return entries;
  }
  const next = { ...entries };
  delete next[key];
  return next;
}

export function WorkspaceConflictDialog({
  open,
  onOpenChange,
  initialConflictPaths = [],
  showToast,
}: WorkspaceConflictDialogProps) {
  const [conflicts, setConflicts] = useState<WorkspaceConflictEntry[]>([]);
  const [pendingUpdates, setPendingUpdates] = useState<PendingCloudUpdateEntry[]>([]);
  const [isLoadingConflicts, setIsLoadingConflicts] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [pendingActionByPath, setPendingActionByPath] = useState<Record<string, PendingConflictAction>>({});
  const [mergeProposalByPath, setMergeProposalByPath] = useState<Record<string, string>>({});
  const [mergeErrorByPath, setMergeErrorByPath] = useState<Record<string, string>>({});
  // Pending-update apply state, keyed by relativePath: which one is being applied
  // (busy/disabled) and any inline error from a failed apply.
  const [applyingPaths, setApplyingPaths] = useState<Set<string>>(() => new Set());
  const [applyErrorByPath, setApplyErrorByPath] = useState<Record<string, string>>({});

  const conflictCountHint = useMemo(() => {
    if (conflicts.length > 0) {
      return conflicts.length;
    }
    return initialConflictPaths.length;
  }, [conflicts.length, initialConflictPaths.length]);

  const loadConflicts = useCallback(
    async (options?: { silent?: boolean }) => {
      if (!options?.silent) {
        setIsLoadingConflicts(true);
      }
      setListError(null);

      try {
        const result = await window.cloudApi.workspaceConflictList();
        const nextConflicts = result.conflicts ?? [];
        const nextPendingUpdates = result.pendingUpdates ?? [];
        setConflicts(nextConflicts);
        setPendingUpdates(nextPendingUpdates);

        const activeConflictPaths = new Set(nextConflicts.map((conflict) => conflict.relativePath));
        setPendingActionByPath((current) => pruneByActivePaths(current, activeConflictPaths));
        setMergeProposalByPath((current) => pruneByActivePaths(current, activeConflictPaths));
        setMergeErrorByPath((current) => pruneByActivePaths(current, activeConflictPaths));

        const activePendingPaths = new Set(nextPendingUpdates.map((entry) => entry.relativePath));
        setApplyingPaths((current) => {
          const next = new Set<string>();
          for (const p of current) if (activePendingPaths.has(p)) next.add(p);
          return next.size === current.size ? current : next;
        });
        setApplyErrorByPath((current) => pruneByActivePaths(current, activePendingPaths));

        // Auto-close only when BOTH lists are empty — a pending update alone is
        // reason enough to keep the dialog open (the user came to clear it).
        if (open && nextConflicts.length === 0 && nextPendingUpdates.length === 0) {
          onOpenChange(false);
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Couldn't load the conflicts.";
        setListError(errorMessage);
      } finally {
        if (!options?.silent) {
          setIsLoadingConflicts(false);
        }
      }
    },
    [onOpenChange, open],
  );

  useEffect(() => {
    if (!open) {
      return;
    }
    void loadConflicts();
  }, [loadConflicts, open]);

  const setPendingAction = useCallback((relativePath: string, action: PendingConflictAction | null) => {
    setPendingActionByPath((current) => {
      if (!action) {
        return removeEntry(current, relativePath);
      }
      return { ...current, [relativePath]: action };
    });
  }, []);

  const clearMergeError = useCallback((relativePath: string) => {
    setMergeErrorByPath((current) => removeEntry(current, relativePath));
  }, []);

  const handleAskRebelToMerge = useCallback(
    async (relativePath: string) => {
      setPendingAction(relativePath, 'merge');
      clearMergeError(relativePath);

      try {
        const result = await window.cloudApi.workspaceConflictMerge({ relativePath });
        const mergedContent = result.mergedContent;
        if (!result.success || typeof mergedContent !== 'string') {
          const errorMessage = result.error ?? 'Rebel could not propose a merge yet.';
          setMergeErrorByPath((current) => ({ ...current, [relativePath]: errorMessage }));
          showToast({
            title: "Couldn't draft a merge yet",
            description: errorMessage,
            variant: 'error',
          });
          return;
        }

        setMergeProposalByPath((current) => ({ ...current, [relativePath]: mergedContent }));
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Rebel could not propose a merge.';
        setMergeErrorByPath((current) => ({ ...current, [relativePath]: errorMessage }));
        showToast({
          title: "Couldn't draft a merge yet",
          description: errorMessage,
          variant: 'error',
        });
      } finally {
        setPendingAction(relativePath, null);
      }
    },
    [clearMergeError, setPendingAction, showToast],
  );

  const handleResolveConflict = useCallback(
    async (relativePath: string, resolution: 'keep-local' | 'keep-cloud' | 'accept-merge', mergedContent?: string) => {
      if (resolution === 'accept-merge' && typeof mergedContent !== 'string') {
        showToast({
          title: "Couldn't accept that merge",
          description: 'The merged content is missing. Ask Rebel to merge again.',
          variant: 'error',
        });
        return;
      }

      setPendingAction(relativePath, resolution);
      clearMergeError(relativePath);

      try {
        const result = await window.cloudApi.workspaceConflictResolve({
          relativePath,
          resolution,
          ...(resolution === 'accept-merge' ? { mergedContent } : {}),
        });

        if (!result.success) {
          showToast({
            title: "Couldn't resolve this file",
            description: result.error ?? 'Try again.',
            variant: 'error',
          });
          return;
        }

        if (resolution === 'accept-merge') {
          setMergeProposalByPath((current) => removeEntry(current, relativePath));
        }

        showToast({
          title:
            resolution === 'keep-local'
              ? 'Kept your version'
              : resolution === 'keep-cloud'
                ? 'Kept cloud version'
                : 'Saved merged version',
          description: relativePath,
          variant: 'success',
        });

        await loadConflicts({ silent: true });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Try again.';
        showToast({
          title: "Couldn't resolve this file",
          description: errorMessage,
          variant: 'error',
        });
      } finally {
        setPendingAction(relativePath, null);
      }
    },
    [clearMergeError, loadConflicts, setPendingAction, showToast],
  );

  const handleRejectMergeProposal = useCallback((relativePath: string) => {
    setMergeProposalByPath((current) => removeEntry(current, relativePath));
    clearMergeError(relativePath);
  }, [clearMergeError]);

  // Apply one pending cloud update: one click, no confirm. The backend re-checks
  // the current local file against the recorded baseline RIGHT BEFORE writing
  // (REBEL-696 Fix 1): if the user edited it here in the meantime, apply does NOT
  // overwrite — it routes the file to the conflict flow (`local_changed`) and we
  // show its `error` toast + reload. On success the card leaves via the silent
  // reload; on failure it stays with an inline error.
  const handleApplyPendingUpdate = useCallback(
    async (relativePath: string) => {
      setApplyingPaths((current) => {
        const next = new Set(current);
        next.add(relativePath);
        return next;
      });
      setApplyErrorByPath((current) => removeEntry(current, relativePath));

      try {
        const result = await window.cloudApi.workspacePendingUpdateApply({ relativePath });

        if (!result.success) {
          const errorMessage = result.error ?? "Couldn't update that file. Try again.";
          setApplyErrorByPath((current) => ({ ...current, [relativePath]: errorMessage }));
          showToast({
            title: "Couldn't update that file",
            description: errorMessage,
            variant: 'error',
          });
          // A stale record (cloud moved on / already delivered) won't reappear —
          // re-read silently so the card disappears instead of lingering wrong.
          await loadConflicts({ silent: true });
          return;
        }

        showToast({
          title: 'Updated to the newest version',
          description: relativePath,
          variant: 'success',
        });

        await loadConflicts({ silent: true });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Couldn't update that file. Try again.";
        setApplyErrorByPath((current) => ({ ...current, [relativePath]: errorMessage }));
        showToast({
          title: "Couldn't update that file",
          description: errorMessage,
          variant: 'error',
        });
      } finally {
        setApplyingPaths((current) => {
          if (!current.has(relativePath)) return current;
          const next = new Set(current);
          next.delete(relativePath);
          return next;
        });
      }
    },
    [loadConflicts, showToast],
  );

  // While the dialog is open, re-read silently when the backend signals the
  // pending-update set changed (a new one appeared, or one auto-resolved because
  // the OS sync engine finally delivered it). Mirrors the conflict broadcast.
  useEffect(() => {
    if (!open) return;
    const cleanup = window.cloudApi?.onWorkspacePendingUpdates?.(() => {
      void loadConflicts({ silent: true });
    });
    return () => cleanup?.();
  }, [loadConflicts, open]);

  const hasPendingUpdates = pendingUpdates.length > 0;
  const hasConflicts = conflicts.length > 0;
  // State-aware framing: a conflict (heavier, decide-or-lose-work) dominates the
  // title/icon; a pending-update-only state is calm — "newer versions ready",
  // Cloud icon, no alarm. See the chief-designer brief's Dialog title section.
  const dialogTitle = hasConflicts ? 'Resolve file conflicts' : 'Newer versions ready';
  const dialogIcon = hasConflicts ? <AlertTriangle size={18} /> : <Cloud size={18} />;
  const dialogDescription = hasConflicts && hasPendingUpdates
    ? 'Some files have newer versions ready, and a few changed in more than one place. Here’s each one.'
    : hasConflicts
      ? (conflictCountHint > 0
        ? `${conflictCountHint} file${conflictCountHint === 1 ? '' : 's'} changed in more than one place. Choose how to keep each one.`
        : 'These files changed in more than one place. Choose how to keep each one.')
      : hasPendingUpdates
        ? `${pendingUpdates.length === 1 ? 'A newer version is' : 'Newer versions are'} available from your synced workspace. Bring this computer up to date.`
        : 'Nothing waiting — every file is up to date.';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader icon={dialogIcon} onClose={() => onOpenChange(false)} data-testid="workspace-conflict-dialog-header">
          <DialogTitle>{dialogTitle}</DialogTitle>
          <DialogDescription>{dialogDescription}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          {isLoadingConflicts ? (
            <div style={{ display: 'flex', justifyContent: 'center', padding: '1.5rem 0' }}>
              <Spinner size="md" label="Checking for updates…" />
            </div>
          ) : listError ? (
            <Card variant="outlined">
              <CardContent style={{ padding: '0.875rem' }}>
                <p style={{ margin: 0, color: 'var(--color-text-secondary)' }}>
                  Couldn’t load this right now: {listError}
                </p>
                <div style={{ marginTop: '0.75rem' }}>
                  <Button size="sm" variant="outline" onClick={() => void loadConflicts()}>
                    Try again
                  </Button>
                </div>
              </CardContent>
            </Card>
          ) : !hasPendingUpdates && !hasConflicts ? (
            <p style={{ margin: 0, color: 'var(--color-text-secondary)' }}>Nothing waiting — every file is up to date.</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              {/* Pending cloud updates FIRST — safe, one-click, zero-risk wins
                  the user can clear instantly, above the heavier conflicts. */}
              {pendingUpdates.map((update) => {
                const relativePath = update.relativePath;
                const isApplying = applyingPaths.has(relativePath);
                const applyError = applyErrorByPath[relativePath];

                return (
                  <Card key={`pending:${relativePath}`} variant="outlined" data-testid="pending-update-card">
                    <CardContent style={{ padding: '0.875rem' }}>
                      <p
                        style={{
                          margin: 0,
                          fontSize: '0.875rem',
                          fontWeight: 600,
                          wordBreak: 'break-word',
                        }}
                      >
                        {relativePath}
                      </p>
                      <p style={{ margin: '0.25rem 0 0', fontSize: '0.8125rem', color: 'var(--color-text-secondary)' }}>
                        A newer version is available from your synced workspace.
                      </p>

                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginTop: '0.75rem' }}>
                        <Button
                          size="sm"
                          disabled={isApplying}
                          data-testid="pending-update-apply"
                          onClick={() => void handleApplyPendingUpdate(relativePath)}
                        >
                          {isApplying ? <Spinner size="sm" /> : <Cloud size={14} />}
                          {isApplying ? 'Updating…' : 'Update to newest'}
                        </Button>
                      </div>

                      {applyError && (
                        <p style={{ margin: '0.5rem 0 0', fontSize: '0.75rem', color: 'var(--color-text-secondary)' }}>
                          {applyError}
                        </p>
                      )}
                    </CardContent>
                  </Card>
                );
              })}

              {conflicts.map((conflict) => {
                const relativePath = conflict.relativePath;
                const pendingAction = pendingActionByPath[relativePath];
                const mergeProposal = mergeProposalByPath[relativePath];
                const mergeError = mergeErrorByPath[relativePath];
                const isBusy = typeof pendingAction === 'string';

                return (
                  <Card key={relativePath} variant="outlined">
                    <CardContent style={{ padding: '0.875rem' }}>
                      <p
                        style={{
                          margin: 0,
                          fontSize: '0.875rem',
                          fontWeight: 600,
                          wordBreak: 'break-word',
                        }}
                      >
                        {relativePath}
                      </p>
                      <p style={{ margin: '0.25rem 0 0', fontSize: '0.8125rem', color: 'var(--color-text-secondary)' }}>
                        This file changed in more than one place, so Rebel kept both copies for review.
                      </p>

                      {mergeProposal ? (
                        <div style={{ marginTop: '0.75rem' }}>
                          <p style={{ margin: '0 0 0.5rem', fontSize: '0.75rem', color: 'var(--color-text-secondary)' }}>
                            Rebel’s merge suggestion
                          </p>
                          <Textarea
                            value={mergeProposal}
                            readOnly
                            rows={10}
                            style={{
                              fontFamily:
                                'var(--font-family-mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace)',
                              fontSize: '0.75rem',
                              lineHeight: 1.5,
                            }}
                          />
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginTop: '0.75rem' }}>
                            <Button
                              size="sm"
                              disabled={isBusy}
                              onClick={() => void handleResolveConflict(relativePath, 'accept-merge', mergeProposal)}
                            >
                              <Check size={14} />
                              {pendingAction === 'accept-merge' ? 'Saving…' : 'Accept'}
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={isBusy}
                              onClick={() => handleRejectMergeProposal(relativePath)}
                            >
                              <X size={14} />
                              Reject
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginTop: '0.75rem' }}>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={isBusy}
                            onClick={() => void handleResolveConflict(relativePath, 'keep-local')}
                          >
                            <Laptop size={14} />
                            {pendingAction === 'keep-local' ? 'Keeping mine…' : 'Keep mine'}
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={isBusy}
                            onClick={() => void handleResolveConflict(relativePath, 'keep-cloud')}
                          >
                            <Cloud size={14} />
                            {pendingAction === 'keep-cloud' ? 'Keeping cloud version…' : 'Keep cloud version'}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={isBusy}
                            onClick={() => void handleAskRebelToMerge(relativePath)}
                          >
                            <Sparkles size={14} />
                            {pendingAction === 'merge' ? 'Asking Rebel…' : 'Ask Rebel to merge'}
                          </Button>
                        </div>
                      )}

                      {mergeError && (
                        <p style={{ margin: '0.5rem 0 0', fontSize: '0.75rem', color: 'var(--color-text-secondary)' }}>
                          {mergeError}
                        </p>
                      )}
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
