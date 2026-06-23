/**
 * InterruptedSessionsModal — shown on startup when interrupted sessions are detected.
 *
 * Lists sessions that were interrupted when the app closed. User can resume
 * individual sessions (agent picks up where it left off) or dismiss them.
 */

import { useCallback } from 'react';
import { RotateCcw, X, Wrench, Loader2 } from 'lucide-react';
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
import type { InterruptedSessionInfo } from '../features/agent-session/hooks/useInterruptedSessionResume';

interface InterruptedSessionsModalProps {
  open: boolean;
  onClose: () => void;
  sessions: InterruptedSessionInfo[];
  isResuming: boolean;
  onResumeSession: (sessionId: string) => Promise<void>;
  onResumeAll: () => Promise<void>;
  onDismissSession: (sessionId: string) => Promise<void>;
  onDismissAll: () => void;
}

const truncate = (text: string, maxLen: number): string =>
  text.length > maxLen ? text.slice(0, maxLen) + '...' : text;

export const InterruptedSessionsModal = ({
  open,
  onClose,
  sessions,
  isResuming,
  onResumeSession,
  onResumeAll,
  onDismissSession,
  onDismissAll,
}: InterruptedSessionsModalProps) => {
  const handleResumeAll = useCallback(async () => {
    await onResumeAll();
  }, [onResumeAll]);

  const count = sessions.length;

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !isResuming) onClose();
      }}
      disableOutsideClose={isResuming}
    >
      <DialogContent size="md" data-testid="interrupted-sessions-modal">
        <DialogHeader icon={<RotateCcw size={24} className="text-primary" />}>
          <DialogTitle>Pick Up Where You Left Off?</DialogTitle>
          <DialogDescription>
            {count === 1
              ? 'A conversation was interrupted when the app closed. Would you like to continue?'
              : `${count} conversations were interrupted when the app closed. Would you like to pick up where you left off?`}
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          <div className="space-y-2 max-h-60 overflow-y-auto">
            {sessions.map((session) => (
              <div
                key={session.sessionId}
                className="flex items-center gap-3 p-2 rounded-md bg-muted/50"
              >
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">{session.title}</div>
                  <div className="text-xs text-muted-foreground truncate">
                    {truncate(session.userMessageText, 80)}
                  </div>
                  {session.hasToolEvents && (
                    <div className="flex items-center gap-1 mt-0.5 text-xs text-muted-foreground">
                      <Wrench size={12} />
                      <span>Was using tools when interrupted</span>
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {!isResuming && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void onDismissSession(session.sessionId)}
                    >
                      <X size={14} />
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={isResuming}
                    onClick={() => void onResumeSession(session.sessionId)}
                  >
                    Resume
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </DialogBody>

        <DialogFooter>
          {!isResuming && (
            <Button variant="ghost" onClick={onDismissAll}>
              Dismiss All
            </Button>
          )}
          <Button disabled={isResuming} onClick={() => void handleResumeAll()}>
            {isResuming ? (
              <Loader2 size={16} className="mr-2 animate-spin" />
            ) : (
              <RotateCcw size={16} className="mr-2" />
            )}
            {isResuming ? 'Resuming...' : 'Resume All'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
