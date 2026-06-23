/**
 * ResumeConversationsModal - Shown when network returns with pending turns
 *
 * Displays a list of conversations that can be resumed after network failure.
 * Provides "Resume All", "Not Now", and "Dismiss All" options.
 * Shows progress during resume with ability to cancel.
 */

import { useCallback, useState, useRef, useEffect } from 'react';
import { RefreshCw, X, Check, Circle, Loader2, WifiOff } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogFooter,
  Button,
} from './ui';
import type { PendingNetworkRetryTurn } from '../features/agent-session/store/sessionStore';

/** Status of a single conversation during resume */
export type ResumeStatus = 'pending' | 'loading' | 'switching' | 'done' | 'failed' | 'cancelled';

export interface ResumeProgress {
  /** Session ID for stable tracking (array indices can change) */
  sessionId: string;
  status: ResumeStatus;
  error?: string;
}

interface ResumeConversationsModalProps {
  open: boolean;
  onClose: () => void;
  pendingTurns: PendingNetworkRetryTurn[];
  /** Session list for title lookup. Can be sessionSummaries or agentSessions (lazy loading Stage 7). */
  sessions: { id: string; title?: string | null }[];
  onResumeAll: (
    onProgress: (progress: ResumeProgress) => void,
    abortSignal: AbortSignal
  ) => Promise<void>;
  /** Called when user chooses to handle manually - closes modal */
  onHandleManually: () => void;
}

const getConversationTitle = (
  turn: PendingNetworkRetryTurn,
  sessionList: { id: string; title?: string | null }[]
): string => {
  const session = sessionList.find((s) => s.id === turn.sessionId);
  if (session?.title) return session.title;
  // Truncate user message as fallback title
  const text = turn.userMessageText;
  if (text.length > 40) return text.slice(0, 40) + '...';
  return text || 'Untitled conversation';
};

const StatusIcon = ({ status }: { status: ResumeStatus }) => {
  switch (status) {
    case 'done':
      return <Check size={16} className="text-green-500" />;
    case 'failed':
      return <X size={16} className="text-red-500" />;
    case 'loading':
    case 'switching':
      return <Loader2 size={16} className="text-primary animate-spin" />;
    case 'cancelled':
      return <Circle size={16} className="text-muted-foreground" />;
    default:
      return <Circle size={16} className="text-muted-foreground" />;
  }
};

export const ResumeConversationsModal = ({
  open,
  onClose,
  pendingTurns,
  sessions,
  onResumeAll,
  onHandleManually,
}: ResumeConversationsModalProps) => {
  const [isResuming, setIsResuming] = useState(false);
  // Key by sessionId for stable tracking (array indices can change during resume)
  const [progress, setProgress] = useState<Map<string, ResumeProgress>>(new Map());
  const abortControllerRef = useRef<AbortController | null>(null);
  // Snapshot of turns when resume started (so list doesn't mutate during resume)
  const [turnsSnapshot, setTurnsSnapshot] = useState<PendingNetworkRetryTurn[]>([]);

  // Reset state when modal opens
  useEffect(() => {
    if (open) {
      setIsResuming(false);
      setProgress(new Map());
      setTurnsSnapshot([]);
      abortControllerRef.current = null;
    }
  }, [open]);

  const handleResumeAll = useCallback(async () => {
    // Snapshot the turns at start of resume - this list won't change
    setTurnsSnapshot([...pendingTurns]);
    setIsResuming(true);
    setProgress(new Map());
    abortControllerRef.current = new AbortController();

    try {
      await onResumeAll(
        (progressUpdate) => {
          setProgress((prev) => {
            const next = new Map(prev);
            next.set(progressUpdate.sessionId, progressUpdate);
            return next;
          });
        },
        abortControllerRef.current.signal
      );
    } finally {
      setIsResuming(false);
      abortControllerRef.current = null;
    }
  }, [onResumeAll, pendingTurns]);

  const handleCancel = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
  }, []);

  const handleManually = useCallback(() => {
    if (isResuming && abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    onHandleManually();
    onClose();
  }, [isResuming, onHandleManually, onClose]);

  // Use snapshot during resume, otherwise live turns
  const displayTurns = isResuming || turnsSnapshot.length > 0 ? turnsSnapshot : pendingTurns;
  const totalCount = displayTurns.length;

  // Count completed/failed for progress display
  const completedCount = Array.from(progress.values()).filter(
    (p) => p.status === 'done'
  ).length;
  const failedCount = Array.from(progress.values()).filter(
    (p) => p.status === 'failed'
  ).length;

  // Check if all done (for auto-close or showing summary)
  const allDone = completedCount + failedCount === totalCount && totalCount > 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !isResuming) {
          onClose();
        }
      }}
      disableOutsideClose={isResuming}
    >
      <DialogContent size="md" data-testid="resume-conversations-modal">
        <DialogHeader icon={<WifiOff size={24} className="text-primary" />}>
          <DialogTitle>
            {isResuming
              ? 'Resuming Conversations'
              : allDone
              ? 'Resume Complete'
              : 'You\'re Back Online'}
          </DialogTitle>
          <DialogDescription>
            {isResuming
              ? `Resuming ${completedCount + 1} of ${totalCount}...`
              : allDone
              ? `${completedCount} succeeded${failedCount > 0 ? `, ${failedCount} failed` : ''}`
              : `${totalCount} conversation${totalCount !== 1 ? 's were' : ' was'} interrupted when you went offline. Would you like to pick up where you left off?`}
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          <div className="space-y-2 max-h-60 overflow-y-auto">
            {displayTurns.map((turn) => {
              const status = progress.get(turn.sessionId)?.status ?? 'pending';
              const error = progress.get(turn.sessionId)?.error;
              const title = getConversationTitle(turn, sessions);
              const hasAttachments = (turn.attachmentCacheIds?.length ?? 0) > 0;

              return (
                <div
                  key={turn.sessionId}
                  className="flex items-center gap-3 p-2 rounded-md bg-muted/50"
                >
                  <StatusIcon status={status} />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">{title}</div>
                    {hasAttachments && status === 'pending' && (
                      <div className="text-xs text-muted-foreground">
                        With attachments
                      </div>
                    )}
                    {error && (
                      <div className="text-xs text-red-500">{error}</div>
                    )}
                    {status === 'switching' && (
                      <div className="text-xs text-muted-foreground">
                        Switching to conversation...
                      </div>
                    )}
                    {status === 'loading' && (
                      <div className="text-xs text-muted-foreground">
                        Loading attachments...
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </DialogBody>

        <DialogFooter>
          {!isResuming && !allDone && (
            <>
              <Button variant="ghost" onClick={handleManually}>
                I'll Handle This Manually
              </Button>
              <Button onClick={handleResumeAll}>
                <RefreshCw size={16} className="mr-2" />
                Resume All Conversations
              </Button>
            </>
          )}
          {isResuming && (
            <Button variant="ghost" onClick={handleCancel}>
              Stop Resuming
            </Button>
          )}
          {allDone && !isResuming && (
            <Button onClick={onClose}>Done</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
