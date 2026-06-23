import { memo, useRef, useCallback, useEffect } from 'react';
import { Loader2, Mic, Square } from 'lucide-react';
import { Tooltip } from '@renderer/components/ui';
import styles from './VoiceMicButton.module.css';

const DOUBLE_CLICK_DELAY_MS = 250;

export type VoiceMicButtonProps = {
  isRecording: boolean;
  isProcessing: boolean;
  disabled: boolean;
  audioLevel: number;
  onToggle: () => void;
  /** Called on double-tap while recording to stop and send immediately */
  onStopAndSend?: () => void;
};

const VoiceMicButtonComponent = ({
  isRecording,
  isProcessing,
  disabled,
  audioLevel,
  onToggle,
  onStopAndSend,
}: VoiceMicButtonProps) => {
  const clickTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (clickTimeoutRef.current) {
        clearTimeout(clickTimeoutRef.current);
      }
    };
  }, []);

  const handleClick = useCallback(() => {
    if (!isRecording) {
      onToggle();
      return;
    }

    // Recording: use delayed click to detect double-click
    if (clickTimeoutRef.current) {
      clearTimeout(clickTimeoutRef.current);
      clickTimeoutRef.current = null;
      onStopAndSend?.();
    } else {
      clickTimeoutRef.current = setTimeout(() => {
        clickTimeoutRef.current = null;
        onToggle();
      }, DOUBLE_CLICK_DELAY_MS);
    }
  }, [isRecording, onToggle, onStopAndSend]);

  return (
    <Tooltip
      content={isRecording ? 'Tap to stop, double-tap to send' : 'Voice input'}
      placement="top"
      delayShow={0}
    >
      <button
        type="button"
        className={`${styles.micButton} ${isRecording ? styles.micButtonRecording : ''} ${isProcessing ? styles.micButtonProcessing : ''}`}
        onClick={handleClick}
        disabled={disabled}
        aria-label={isRecording ? 'Stop recording' : 'Start voice input'}
        aria-pressed={isRecording}
        style={{ '--audio-level': isRecording ? audioLevel : 0 } as React.CSSProperties}
      >
        {isProcessing ? (
          <Loader2 size={12} className={styles.spinner} />
        ) : isRecording ? (
          <Square size={10} />
        ) : (
          <Mic size={12} />
        )}
      </button>
    </Tooltip>
  );
};

export const VoiceMicButton = memo(VoiceMicButtonComponent);
VoiceMicButton.displayName = 'VoiceMicButton';
