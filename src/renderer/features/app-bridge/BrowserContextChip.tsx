/**
 * BrowserContextChip
 *
 * Tiny "From Chrome — {hostname}" chip rendered above the composer when a
 * conversation was created (or updated) by the Rebel browser extension.
 * Shows the current tab host + page title in a subdued pill; clicking the
 * chip (future — not wired yet) would focus that tab.
 *
 * Stage 7 scope: purely presentational. The chip appears when
 * `useExternalContextForSession(id)` has a `tabContext`, and disappears
 * when the session is cleared or replaced.
 *
 * @see docs/plans/260418_rebel_app_bridge_and_browser_extension.md Stage 7
 */

import { memo } from 'react';
import { Globe } from 'lucide-react';
import { Tooltip } from '@renderer/components/ui';
import styles from './ContextChip.module.css';

export interface BrowserContextChipProps {
  /** Tab URL — hostname is extracted for display. */
  url?: string;
  /** Full page title — used as tooltip. */
  title?: string;
}

/** Defensive URL→hostname; falls back to the raw URL fragment if parsing fails. */
function safeHostname(url: string | undefined): string {
  if (!url) return '';
  try {
    const u = new URL(url);
    return u.hostname;
  } catch {
    return url.slice(0, 60);
  }
}

const BrowserContextChipComponent = ({
  url,
  title,
}: BrowserContextChipProps) => {
  const hostname = safeHostname(url);
  // Nothing useful to show? Bail — callers should also short-circuit,
  // but this is an extra safety net.
  if (!hostname && !title) return null;

  const tooltipText = title && url ? `${title}\n${url}` : title ?? url ?? hostname;

  return (
    <Tooltip content={tooltipText} placement="top">
      <div
        className={styles.chip}
        data-testid="browser-context-chip"
        role="status"
        aria-label={`Browser context: ${hostname || title || 'web page'}`}
      >
        <Globe size={12} className={styles.icon} aria-hidden="true" />
        <span className={styles.label}>From Chrome</span>
        {hostname && (
          <>
            <span className={styles.separator} aria-hidden="true">·</span>
            <span className={styles.host}>{hostname}</span>
          </>
        )}
      </div>
    </Tooltip>
  );
};

export const BrowserContextChip = memo(BrowserContextChipComponent);
BrowserContextChip.displayName = 'BrowserContextChip';
