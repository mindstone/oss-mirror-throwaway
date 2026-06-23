import { useEffect, useState } from 'react';
import { Camera } from 'lucide-react';
import { Button, IconTile } from '@renderer/components/ui';
import styles from './VisualCaptureOverlay.module.css';

export type VisualCaptureOverlayPhase = 'navigating' | 'preparing' | 'captured';

export type VisualCaptureOverlayEventDetail =
  | {
      action: 'show';
      phase: VisualCaptureOverlayPhase;
      message: string;
      autoHideMs?: number;
    }
  | {
      action: 'hide';
    };

export const VISUAL_CAPTURE_OVERLAY_EVENT = 'rebel:visual-capture-overlay';

interface VisualCaptureOverlayProps {
  onStop?: () => void;
}

export function VisualCaptureOverlay({ onStop }: VisualCaptureOverlayProps) {
  const [state, setState] = useState<Extract<VisualCaptureOverlayEventDetail, { action: 'show' }> | null>(null);

  useEffect(() => {
    let autoHideTimer: ReturnType<typeof setTimeout> | null = null;

    const clearAutoHide = () => {
      if (autoHideTimer) {
        clearTimeout(autoHideTimer);
        autoHideTimer = null;
      }
    };

    const handleOverlayEvent = (event: Event) => {
      const detail = (event as CustomEvent<VisualCaptureOverlayEventDetail>).detail;
      if (!detail) return;

      clearAutoHide();

      if (detail.action === 'hide') {
        setState(null);
        return;
      }

      setState(detail);
      if (detail.autoHideMs && detail.autoHideMs > 0) {
        autoHideTimer = setTimeout(() => setState(null), detail.autoHideMs);
      }
    };

    window.addEventListener(VISUAL_CAPTURE_OVERLAY_EVENT, handleOverlayEvent);
    return () => {
      clearAutoHide();
      window.removeEventListener(VISUAL_CAPTURE_OVERLAY_EVENT, handleOverlayEvent);
    };
  }, []);

  if (!state) return null;

  const statusText = [
    state.message,
    state.phase !== 'captured' && onStop ? 'Press Stop to interrupt' : null,
  ].filter(Boolean).join('. ');

  return (
    <div className={styles.overlay} role="status" aria-live="polite" aria-label={statusText}>
      <div className={styles.frame} />
      <div className={styles.pill} data-phase={state.phase}>
        <span className={styles.cameraCue} aria-hidden="true">
          <IconTile icon={Camera} size="sm" tone={state.phase === 'captured' ? 'success' : 'inbox'} />
          <span className={styles.pulse} />
        </span>
        <span className={styles.message}>{state.message}</span>
        {state.phase !== 'captured' && onStop && (
          <Button
            type="button"
            variant="secondary"
            size="xs"
            className={styles.stopButton}
            onClick={onStop}
            aria-label="Stop the current screenshot capture"
          >
            Stop
          </Button>
        )}
      </div>
    </div>
  );
}
