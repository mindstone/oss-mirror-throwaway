import { useCallback, useRef } from 'react';
import {
  useFloating,
  autoUpdate,
  offset,
  flip,
  shift,
  FloatingPortal,
  useHover,
  useDismiss,
  useInteractions,
} from '@floating-ui/react';
import { MessageCircle } from 'lucide-react';
import { Button } from '@renderer/components/ui/Button';
import { Tooltip } from '@renderer/components/ui/Tooltip';
import { useState } from 'react';
import './ContributionPill.css';

interface ContributionPreview {
  text: string;
  scores?: { relevance: number; helpfulness: number; timing: number } | null;
  triggerType?: string;
  triggerExcerpt?: string;
}

interface ContributionPillProps {
  preview: ContributionPreview;
  botId: string;
  onCleared: () => void;
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen).trimEnd() + '\u2026';
}

function scoreLabel(score: number): 'high' | 'medium' {
  return score > 0.8 ? 'high' : 'medium';
}

export function ContributionPill({ preview, botId, onCleared }: ContributionPillProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const actedRef = useRef(false);

  const { refs, floatingStyles, context, isPositioned } = useFloating({
    open: isOpen,
    onOpenChange: (open) => {
      if (!actedRef.current) {
        if (open) setChatError(null);
        setIsOpen(open);
      }
    },
    placement: 'bottom',
    strategy: 'fixed',
    middleware: [
      offset(8),
      flip({ fallbackAxisSideDirection: 'start', padding: 8 }),
      shift({ padding: 8 }),
    ],
    whileElementsMounted: autoUpdate,
  });

  const hover = useHover(context, { move: false, delay: { open: 100, close: 200 } });
  const dismiss = useDismiss(context, { escapeKey: true });
  const { getReferenceProps, getFloatingProps } = useInteractions([hover, dismiss]);

  const handleSayIt = useCallback(async () => {
    actedRef.current = true;
    setIsOpen(false);
    try {
      await window.meetingBotApi?.speakPendingResponse?.({ botId });
    } catch {
      // Ignore errors
    }
    onCleared();
  }, [botId, onCleared]);

  const handleChatIt = useCallback(async () => {
    setChatError(null);
    try {
      const result = await window.meetingBotApi?.chatPendingResponse?.({ botId });
      if (result?.success) {
        actedRef.current = true;
        setIsOpen(false);
        onCleared();
      } else {
        setChatError(result?.error || 'Something went wrong');
      }
    } catch {
      setChatError("Couldn't send that.");
    }
  }, [botId, onCleared]);

  const handleSkip = useCallback(async () => {
    actedRef.current = true;
    setIsOpen(false);
    try {
      await window.meetingBotApi?.dismissContribution?.({ botId });
    } catch {
      // Ignore errors
    }
    onCleared();
  }, [botId, onCleared]);

  return (
    <>
      <button
        ref={refs.setReference}
        type="button"
        className="contribution-pill"
        aria-label="Suggested contribution available"
        {...getReferenceProps()}
      >
        <span className="contribution-pill__glow" aria-hidden />
        <MessageCircle size={12} className="contribution-pill__icon" />
        <span className="contribution-pill__text">
          {truncate(preview.text, 28)}
        </span>
      </button>

      {isOpen && (
        <FloatingPortal>
          <div
            ref={refs.setFloating}
            style={floatingStyles}
            className="contribution-popover__anchor"
            {...getFloatingProps()}
          >
            <div className={`contribution-popover${isPositioned ? ' contribution-popover--positioned' : ''}`}>
              <div className="contribution-popover__accent" aria-hidden />

              <p className="contribution-popover__body">{preview.text}</p>

              {preview.triggerExcerpt && (
                <p className="contribution-popover__context">
                  In response to: &lsquo;{truncate(preview.triggerExcerpt, 80)}&rsquo;
                </p>
              )}

              {preview.scores && (
                <div className="contribution-popover__scores">
                  <Tooltip content="How relevant is this to the current discussion">
                    <span className="contribution-popover__score">
                      <span className={`contribution-popover__dot contribution-popover__dot--${scoreLabel(preview.scores.relevance)}`} />
                      Relevant
                    </span>
                  </Tooltip>
                  <Tooltip content="How much genuine value this would add">
                    <span className="contribution-popover__score">
                      <span className={`contribution-popover__dot contribution-popover__dot--${scoreLabel(preview.scores.helpfulness)}`} />
                      Helpful
                    </span>
                  </Tooltip>
                  <Tooltip content="Whether now is the right moment to speak">
                    <span className="contribution-popover__score">
                      <span className={`contribution-popover__dot contribution-popover__dot--${scoreLabel(preview.scores.timing)}`} />
                      Timely
                    </span>
                  </Tooltip>
                </div>
              )}

              {chatError && (
                <p className="contribution-popover__error">{chatError}</p>
              )}

              <div className="contribution-popover__actions">
                <Button size="sm" variant="ghost" onClick={handleSkip}>
                  Skip
                </Button>
                <Button size="sm" variant="secondary" onClick={handleChatIt}>
                  Chat it
                </Button>
                <Button size="sm" onClick={handleSayIt}>
                  Say it
                </Button>
              </div>
            </div>
          </div>
        </FloatingPortal>
      )}
    </>
  );
}
