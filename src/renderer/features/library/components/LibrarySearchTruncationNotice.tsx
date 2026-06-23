import { ArrowRight, Info } from 'lucide-react';
import { Button, IconButton, Notice, Tooltip } from '@renderer/components/ui';
import type { TruncationSignal } from '@renderer/features/library/search/useTruncationSignal';
import { INCOMPLETE_LIBRARY_COPY } from './IncompleteLibraryHint';
import styles from './LibrarySearchTruncationNotice.module.css';

type LibrarySearchTruncationNoticeProps = {
  signal: TruncationSignal;
  placement: 'embedded' | 'inline';
  onDismiss?: () => void;
  /**
   * Optional: opens Settings → Spaces (where the per-Space Re-check lever lives).
   * Only consumed for the `cloud-degraded` kind. Absent ⇒ tooltip-only, no dead
   * button — mirrors the `onDismiss`-absent honesty pattern below.
   */
  onManageSpaces?: () => void;
};

export const ENGINE_CAP_COPY = 'Only the first 100,000 files were searched. If the file is beyond that, browse folders or choose a smaller Library folder.';
// `tree` = the file tree itself is a partial view (the producer node/byte cap),
// not just the search engine. Keep this honest and non-alarming; no ordering claim.
export const TREE_COPY = INCOMPLETE_LIBRARY_COPY;
export const BOTH_COPY = `Only the first 100,000 files were searched, and this is a partial view of a very large Library. Some files may not appear here.`;
// `cloud-degraded` = a linked cloud folder in scope is reconnecting, so results may
// be the last-known index. Calm + honest; never blames the user, never names a raw
// path. Singular vs plural depending on how many spaces are reconnecting.
export const CLOUD_DEGRADED_COPY_SINGULAR =
  "Some files here are from a folder that's reconnecting, so you're seeing your last-known results. This usually sorts itself out.";
export const CLOUD_DEGRADED_COPY_PLURAL =
  "Some files here are from folders that are reconnecting, so you're seeing your last-known results. This usually sorts itself out.";

// Fuller, non-technical explanation surfaced via the info tooltip. No em dashes
// (brand voice; PLAN must-address F1); names the providers concretely (the
// user's mental model is "my Dropbox"), promises self-heal, and points at the
// exact lever (Settings → Spaces → Re-check) without naming any raw path or
// implementation term ("symlink", "mount", "probe").
export const CLOUD_DEGRADED_TOOLTIP_COPY =
  "This folder lives in a cloud app (like Dropbox, Google Drive or iCloud) that's briefly out of reach, so Rebel is showing your most recent saved view. Anything you've just added there might not appear yet. It usually reconnects on its own within a minute or two. To give it a push, open Settings, then Spaces, and choose Re-check.";

function getCopy(signal: TruncationSignal): string | null {
  if (signal.kind === 'engine-cap') {
    return ENGINE_CAP_COPY;
  }

  if (signal.kind === 'tree') {
    return TREE_COPY;
  }

  if (signal.kind === 'both') {
    return BOTH_COPY;
  }

  if (signal.kind === 'cloud-degraded') {
    return signal.reconnectingSpaceCount > 1
      ? CLOUD_DEGRADED_COPY_PLURAL
      : CLOUD_DEGRADED_COPY_SINGULAR;
  }

  return null;
}

/**
 * Enriched body for the `cloud-degraded` kind only: the calm message plus an
 * inline info-tooltip trigger (focusable IconButton so the focus-fired Tooltip
 * is keyboard/SR reachable — PLAN must-address F2) and, when `onManageSpaces` is
 * supplied, a quiet ghost button to Settings → Spaces. One code path serves both
 * placements; the button lives in `children` (not `Notice.actions`, which is
 * typed `never` for embedded). Mirrors `SpaceCard` `SyncStatusBanner`.
 */
function CloudDegradedBody({
  message,
  onManageSpaces,
}: {
  message: string;
  onManageSpaces?: () => void;
}) {
  return (
    <div className={styles.cloudDegradedBody}>
      <span className={styles.messageWithTrigger}>
        {message}
        <Tooltip content={CLOUD_DEGRADED_TOOLTIP_COPY} placement="top" delayShow={300}>
          <IconButton
            size="xs"
            variant="ghost"
            aria-label="What does reconnecting mean?"
            className={styles.infoTrigger}
            data-testid="library-truncation-notice-info"
          >
            <Info size={14} aria-hidden="true" />
          </IconButton>
        </Tooltip>
      </span>
      {onManageSpaces ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={onManageSpaces}
          data-testid="library-truncation-notice-manage-spaces"
        >
          Manage in Settings <ArrowRight size={12} />
        </Button>
      ) : null}
    </div>
  );
}

export function LibrarySearchTruncationNotice({
  signal,
  placement,
  onDismiss,
  onManageSpaces,
}: LibrarySearchTruncationNoticeProps) {
  if (signal.kind === 'none' || signal.kind === 'unknown') {
    return null;
  }

  const message = getCopy(signal);
  if (!message) {
    return null;
  }

  // `cloud-degraded` is the only enriched variant: it gains the info tooltip and
  // (when wired) the Settings shortcut, and is always a non-dismissible live
  // status. Every other kind renders byte-identically to before.
  const body =
    signal.kind === 'cloud-degraded' ? (
      <CloudDegradedBody message={message} onManageSpaces={onManageSpaces} />
    ) : (
      message
    );

  // By-construction honesty: only render a dismiss "X" when a real handler is
  // supplied. Defaulting `onDismiss` to a no-op (the previous behaviour) shipped
  // a dead button on callers that pass no handler (e.g. WorkspaceFileNavigator).
  // No handler → non-dismissible Notice (no X); handler → working dismiss.
  if (!onDismiss) {
    return (
      <Notice
        tone="info"
        density="compact"
        placement={placement}
        dismissible={false}
        role="status"
        data-testid="library-search-truncation-notice"
      >
        {body}
      </Notice>
    );
  }

  return (
    <Notice
      tone="info"
      density="compact"
      placement={placement}
      dismissible
      onDismiss={onDismiss}
      role="status"
      data-testid="library-search-truncation-notice"
    >
      {body}
    </Notice>
  );
}
