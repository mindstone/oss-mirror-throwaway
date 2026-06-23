import { WifiOff } from 'lucide-react';
import { Tooltip } from '@renderer/components/ui/Tooltip';
import { IconButton } from '@renderer/components/ui/IconButton';
import type { DebouncedOnlineStatus } from '../hooks/useDebouncedOnlineStatus';
import './OfflineIndicator.css';

/**
 * Primary, ambient "you're offline" signal for the header status cluster
 * (sibling to CloudSyncIndicator). Reuses that idiom: header IconButton + 8px
 * pulse-dot badge + tooltip. Design: chief-designer Surface 2, option A —
 * header-dot-only at rest.
 *
 * - No dot at all when online: zero nag at rest.
 * - Calm pulse-dot ONLY when offline is sustained (the debounced signal handles
 *   the slow-to-alarm / instant-to-clear asymmetry — a brief blip never flashes).
 * - Tooltip carries the reassurance ("your work is safe"), which is the single
 *   most important sentence in the whole feature for a flaky-network user.
 *
 * The connectivity status is owned by a SINGLE `useDebouncedOnlineStatus()` call
 * in App.tsx (one source of truth, one set of listeners/timers) and passed in —
 * this component does not subscribe independently.
 *
 * a11y: `role="status"` WITHOUT `aria-live` — the banner (OfflineBanner) owns
 * the single polite announcement so a screen reader doesn't hear "offline"
 * twice. Tooltip text is duplicated into `aria-label`. `tabIndex={-1}` keeps
 * this purely-informational control out of the tab order (it has no action,
 * unlike the clickable CloudSyncIndicator). The pulse respects
 * `prefers-reduced-motion` (see OfflineIndicator.css).
 *
 * Distinct from CloudSyncIndicator: that reports "cloud reachable"; this reports
 * "device online". They share the header idiom and may both show, but stay
 * separate jobs (chief-designer: don't flatten lookalikes).
 */
const OFFLINE_TOOLTIP =
  "Offline. Your chats and files are safe, and I'll catch up when you reconnect.";

export interface OfflineIndicatorProps {
  /** Shared debounced connectivity status (owned by App.tsx). */
  status: DebouncedOnlineStatus;
}

export function OfflineIndicator({ status }: OfflineIndicatorProps) {
  // Zero nag at rest: render nothing at all until offline is sustained.
  if (!status.isSustainedOffline) {
    return null;
  }

  return (
    <Tooltip content={OFFLINE_TOOLTIP} delayShow={200}>
      <IconButton
        size="sm"
        className="header-icon-button offline-indicator"
        aria-label={OFFLINE_TOOLTIP}
        role="status"
        // Purely informational, no onClick — keep it out of the tab order so a
        // keyboard user doesn't land on an inert control (DS-1).
        tabIndex={-1}
      >
        <WifiOff size={16} aria-hidden="true" />
        <span className="offline-indicator__badge" />
      </IconButton>
    </Tooltip>
  );
}

OfflineIndicator.displayName = 'OfflineIndicator';
