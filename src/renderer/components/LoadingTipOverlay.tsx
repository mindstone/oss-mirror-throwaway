import { useEffect, useRef, useState } from 'react';
import { Sparkles } from 'lucide-react';
import styles from './LoadingTipOverlay.module.css';
import { LOADING_TIPS, type LoadingTip } from './LoadingTipOverlay.tips';

/**
 * Session-scoped memory of tip ids already shown, so the same tip doesn't
 * repeat back-to-back across skeleton appearances within a session. Resets
 * once every tip has been seen.
 */
const sessionShown = new Set<string>();

/**
 * Default timings. Overridable via props for stories/tests.
 *
 * `FADE_IN_DELAY_MS` is 0 so the tip reliably appears every time a skeleton
 * shows — the 260ms opacity transition still gives it a soft entrance, but
 * we don't gate on a minimum-load-time threshold. Skeletons that disappear
 * before the fade completes simply interrupt it gracefully.
 */
const DEFAULT_FADE_IN_DELAY_MS = 0;
const DEFAULT_ROTATE_MS = 5000;

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

function pickNextTip(previousId: string | null): LoadingTip {
  const pool = LOADING_TIPS.filter(
    (t) => t.id !== previousId && !sessionShown.has(t.id),
  );
  if (pool.length === 0) {
    sessionShown.clear();
    const fallback = LOADING_TIPS.filter((t) => t.id !== previousId);
    const source = fallback.length > 0 ? fallback : LOADING_TIPS;
    const pick = source[Math.floor(Math.random() * source.length)];
    sessionShown.add(pick.id);
    return pick;
  }
  const pick = pool[Math.floor(Math.random() * pool.length)];
  sessionShown.add(pick.id);
  return pick;
}

export interface LoadingTipOverlayProps {
  /**
   * When set to `true` by the parent, the overlay fades out smoothly before
   * the real content takes its place. The parent is responsible for actually
   * unmounting the skeleton/overlay after the fade completes (~150ms).
   */
  isExiting?: boolean;
  /**
   * Delay before the first tip fades in. Defaults to 0 so the visual treatment
   * appears immediately when the skeleton mounts.
   */
  fadeInDelayMs?: number;
  /** How long each tip stays before rotating to a new one. */
  rotateIntervalMs?: number;
  /** Optional test hook for selecting a deterministic tip. */
  initialTip?: LoadingTip;
  /** Optional eyebrow copy override for different loading surfaces. */
  eyebrowLabel?: string;
}

/**
 * `<LoadingTipOverlay />` — layers a friendly, single-sentence tip on top of
 * a loading skeleton. Does NOT replace the skeleton; the skeleton remains
 * visible behind a softly-blurred pill.
 *
 * Positioning: parent must be `position: relative` (or otherwise establish a
 * positioning context). The overlay uses `position: absolute` to sit inside
 * the skeleton container.
 */
export function LoadingTipOverlay({
  isExiting = false,
  fadeInDelayMs = DEFAULT_FADE_IN_DELAY_MS,
  rotateIntervalMs = DEFAULT_ROTATE_MS,
  initialTip,
  eyebrowLabel = 'While we wait',
}: LoadingTipOverlayProps) {
  const reducedMotion = useRef<boolean>(prefersReducedMotion());
  const [tip, setTip] = useState<LoadingTip>(() => initialTip ?? pickNextTip(null));
  const [visible, setVisible] = useState<boolean>(reducedMotion.current);
  const [swapping, setSwapping] = useState<boolean>(false);

  // Fade in after a short delay (skipped under reduced motion — already visible).
  useEffect(() => {
    if (reducedMotion.current) return;
    const id = window.setTimeout(() => setVisible(true), fadeInDelayMs);
    return () => window.clearTimeout(id);
  }, [fadeInDelayMs]);

  // Rotate tips every `rotateIntervalMs`. Skipped under reduced motion.
  useEffect(() => {
    if (reducedMotion.current) return;
    if (LOADING_TIPS.length <= 1) return;

    const swapDurationMs = 260;
    const id = window.setInterval(() => {
      setSwapping(true);
      window.setTimeout(() => {
        setTip((prev) => pickNextTip(prev.id));
        setSwapping(false);
      }, swapDurationMs);
    }, rotateIntervalMs);

    return () => window.clearInterval(id);
  }, [rotateIntervalMs]);

  const overlayClass = [
    styles.overlay,
    visible && !isExiting ? styles.overlay_visible : '',
    isExiting ? styles.overlay_exiting : '',
  ]
    .filter(Boolean)
    .join(' ');

  const textClass = [styles.tipText, swapping ? styles.tipText_swapping : '']
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={overlayClass}
      aria-hidden="true"
      data-testid="loading-tip-overlay"
    >
      <span className={styles.eyebrow}>
        <Sparkles className={styles.icon} aria-hidden="true" strokeWidth={1.8} />
        <span className={styles.eyebrowLabel}>{eyebrowLabel}</span>
      </span>
      <span className={textClass}>{tip.tip}</span>
    </div>
  );
}
