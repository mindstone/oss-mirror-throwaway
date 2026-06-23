import { WifiOff } from 'lucide-react';
import type { DebouncedOnlineStatus } from '../hooks/useDebouncedOnlineStatus';
import styles from './OfflineBanner.module.css';

/**
 * Full-width top banner for a LONG-sustained offline outage.
 *
 * Driven by the shared debounced connectivity status (owned by a single
 * `useDebouncedOnlineStatus()` call in App.tsx and passed in) rather than raw
 * `navigator.onLine` — that's the fix for the flashing bug (raw onLine flickers
 * on every ~5s blip). Demoted to long-sustained-only (~45s) per chief-designer
 * Surface 2 option A: the header dot (OfflineIndicator) covers short outages
 * with zero nag; the banner is reserved for "you've been offline a while,
 * here's the reassurance up front".
 *
 * a11y: this banner owns the single `aria-live="polite"` announcement; the
 * header dot is `role="status"` without `aria-live` so offline is announced
 * once, not twice. `pointer-events: none` keeps it from blocking clicks.
 */
export interface OfflineBannerProps {
  /** Shared debounced connectivity status (owned by App.tsx). */
  status: DebouncedOnlineStatus;
}

export function OfflineBanner({ status }: OfflineBannerProps) {
  if (!status.isLongSustainedOffline) {
    return null;
  }

  return (
    <div className={styles.banner} role="status" aria-live="polite">
      <div className={styles.content}>
        <WifiOff size={16} className={styles.icon} aria-hidden="true" />
        <span className={styles.text}>
          You're offline. Your chats and files are safe. AI and voice features
          pick back up the moment you reconnect.
        </span>
      </div>
    </div>
  );
}

OfflineBanner.displayName = 'OfflineBanner';
