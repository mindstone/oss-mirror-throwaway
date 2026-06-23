import { memo, useEffect, useRef, useState, type FocusEvent, type KeyboardEvent } from 'react';
import { X, FastForward, ListPlus } from 'lucide-react';
import { Button, IconButton, Tooltip } from '@renderer/components/ui';
import styles from './QueuedMessagesTray.module.css';

/**
 * Props for the QueuedMessagesTray component.
 * Shows pending messages that will be sent after the current agent turn completes.
 */
export interface QueuedMessagesTrayProps {
  messageQueue: Array<{
    id: string;
    text: string;
    source: 'text' | 'voice';
    targetSessionId?: string;
  }>;
  currentSessionId: string;
  onRemove: (id: string) => void;
  onSendNow: (id: string) => void;
}

const MAX_PREVIEW_LENGTH = 100;
const MAX_ARIA_PREVIEW_LENGTH = 50;
const CONFIRMATION_PROMPT = 'Stop the current task and send this message now?';

/**
 * Truncate text to a maximum length, adding ellipsis if truncated.
 */
const truncateText = (text: string, maxLength: number = MAX_PREVIEW_LENGTH): string => {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength).trimEnd() + '…';
};

/**
 * QueuedMessagesTray displays pending messages above the composer.
 * Shows when user has queued messages while the agent is busy.
 */
const QueuedMessagesTrayComponent = ({
  messageQueue,
  currentSessionId,
  onRemove,
  onSendNow
}: QueuedMessagesTrayProps) => {
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [focusReturnId, setFocusReturnId] = useState<string | null>(null);
  const interruptButtonRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const confirmSendButtonRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  useEffect(() => {
    if (!confirmingId) {
      return;
    }

    if (messageQueue.some((message) => message.id === confirmingId)) {
      return;
    }

    setConfirmingId(null);
    setFocusReturnId(null);
  }, [confirmingId, messageQueue]);

  useEffect(() => {
    if (confirmingId) {
      confirmSendButtonRefs.current[confirmingId]?.focus();
      return;
    }

    if (!focusReturnId) {
      return;
    }

    interruptButtonRefs.current[focusReturnId]?.focus();
    setFocusReturnId(null);
  }, [confirmingId, focusReturnId]);

  const openConfirmation = (id: string): void => {
    setFocusReturnId(null);
    setConfirmingId(id);
  };

  const keepQueued = (id: string): void => {
    setFocusReturnId(id);
    setConfirmingId(null);
  };

  const confirmSendNow = (id: string): void => {
    onSendNow(id);
    setFocusReturnId(null);
    setConfirmingId(null);
  };

  const handleConfirmationEscape = (event: KeyboardEvent<HTMLLIElement>, id: string): void => {
    if (event.key !== 'Escape' || confirmingId !== id) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    keepQueued(id);
  };

  const handleConfirmationBlur = (event: FocusEvent<HTMLLIElement>, id: string): void => {
    if (confirmingId !== id) {
      return;
    }

    const nextFocused = event.relatedTarget as Node | null;
    if (nextFocused && event.currentTarget.contains(nextFocused)) {
      return;
    }

    setFocusReturnId(null);
    setConfirmingId(null);
  };

  // Don't render if queue is empty
  if (messageQueue.length === 0) return null;

  return (
    <div className={styles.wrapper}>
      <div
        className={styles.tray}
        data-testid="queued-messages-tray"
        role="region"
        aria-label="Queued messages"
        aria-live="polite"
      >
        <ul className={styles.list} role="list">
          {messageQueue.map((message, index) => {
            const previewText = truncateText(message.text);
            const ariaPreview = truncateText(message.text, MAX_ARIA_PREVIEW_LENGTH);
            const targetsDifferentSession =
              message.targetSessionId && message.targetSessionId !== currentSessionId;
            const isConfirming = confirmingId === message.id;

            return (
              <li
                key={message.id}
                className={styles.item}
                data-testid={`queued-message-item-${message.id}`}
                role="listitem"
                onKeyDown={(event) => handleConfirmationEscape(event, message.id)}
                onBlur={(event) => handleConfirmationBlur(event, message.id)}
              >
                <div className={styles.itemContent}>
                  {index === 0 ? (
                    <span className={styles.queueBadge} aria-hidden="true">
                      <ListPlus size={12} />
                    </span>
                  ) : (
                    <span className={styles.queueBadgeSpacer} aria-hidden="true" />
                  )}
                  <span className={styles.preview}>
                    {previewText}
                  </span>
                  {targetsDifferentSession && (
                    <span className={styles.sessionBadge}>Previous conversation</span>
                  )}
                </div>
                <div className={styles.actions}>
                  {isConfirming ? (
                    <div className={styles.confirmation}>
                      <span className={styles.confirmationPrompt} aria-live="polite">
                        {CONFIRMATION_PROMPT}
                      </span>
                      <div className={styles.confirmationActions}>
                        <Button
                          type="button"
                          size="xxs"
                          variant="destructive"
                          onClick={() => confirmSendNow(message.id)}
                          data-testid={`queued-message-confirm-send-${message.id}`}
                          ref={(node) => {
                            confirmSendButtonRefs.current[message.id] = node;
                          }}
                        >
                          <FastForward size={12} aria-hidden="true" />
                          Interrupt &amp; send
                        </Button>
                        <Button
                          type="button"
                          size="xxs"
                          variant="ghost"
                          onClick={() => keepQueued(message.id)}
                          data-testid={`queued-message-keep-queued-${message.id}`}
                        >
                          Keep queued
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <>
                      {!targetsDifferentSession && (
                        <Tooltip content="Interrupt current task and send this now" placement="top">
                          <IconButton
                            size="xs"
                            variant="ghost"
                            danger
                            onClick={() => openConfirmation(message.id)}
                            data-testid={`queued-message-send-now-${message.id}`}
                            aria-label={`Interrupt current task and send queued message: ${ariaPreview}`}
                            ref={(node) => {
                              interruptButtonRefs.current[message.id] = node;
                            }}
                          >
                            <FastForward size={14} />
                          </IconButton>
                        </Tooltip>
                      )}
                      <Tooltip content="Remove from queue" placement="top">
                        <button
                          type="button"
                          className={styles.removeButton}
                          onClick={() => onRemove(message.id)}
                          data-testid={`queued-message-remove-${message.id}`}
                          aria-label={`Remove queued message: ${ariaPreview}`}
                        >
                          <X size={14} />
                        </button>
                      </Tooltip>
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
};

export const QueuedMessagesTray = memo(QueuedMessagesTrayComponent);
QueuedMessagesTray.displayName = 'QueuedMessagesTray';
