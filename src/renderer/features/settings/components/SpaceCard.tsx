/**
 * SpaceCard Component
 *
 * Compact card for displaying a space with clear information hierarchy:
 * - Name + metadata badges on first row
 * - Full description on second row (if present)
 * - Source path with folder icon on third row (if symlink)
 * - Actions always visible, secondary actions on hover
 */

import { useState, useRef, useLayoutEffect } from 'react';
import { Badge, Button, IconButton, Tooltip } from '@renderer/components/ui';
import {
  Lock,
  Folder,
  FolderOpen,
  PenSquare,
  Link2Off,
  FolderOutput,
  FileWarning,
  ArrowRight,
  Target,
  CheckCircle2,
  AlertCircle,
  Cloud,
  HardDrive,
  Link2,
  Users,
  Globe,
  Building2,
  Settings,
  ShieldAlert,
  RefreshCw,
  CloudOff,
} from 'lucide-react';
import type { SpaceInfo, SpaceStorageProvider } from '@shared/ipc/schemas/library';
import type { EnrichedSpaceInfo } from './spaceTypes';
import { isStale, getDaysSinceReview } from '@renderer/features/usecases/utils/dateUtils';
import styles from './SpaceCard.module.css';

// Re-export for consumers who were importing from SpaceCard
export type { EnrichedSpaceInfo } from './spaceTypes';

// Import brand icons
import googleDriveIcon from '@renderer/assets/brand/google-drive.png';
import oneDriveIcon from '@renderer/assets/brand/onedrive.png';

/**
 * Replace {USERNAME} placeholder with "you" for display
 */
function formatDescription(desc: string | undefined): string | undefined {
  if (!desc) return undefined;
  return desc.replace(/\{USERNAME\}/g, 'you');
}

/**
 * Friendly, non-technical name for a storage provider, for the cloud sync-status
 * copy ("Reconnecting to {Provider}…"). Never surface a raw mount path. Falls back
 * to a generic phrase when the provider is unknown (Chief-Designer F8: attribute to
 * "this linked folder", never a categorical provider-outage claim).
 */
function friendlyProviderName(provider: SpaceStorageProvider | undefined): string {
  switch (provider) {
    case 'google_drive':
      return 'Google Drive';
    case 'onedrive':
      return 'OneDrive';
    case 'dropbox':
      return 'Dropbox';
    case 'icloud':
      return 'iCloud';
    case 'box':
      return 'Box';
    default:
      return 'this linked folder';
  }
}

/**
 * Props for the SpaceCard component
 */
export interface SpaceCardProps {
  /** The space to display (enriched with SpaceConfig data) */
  space: EnrichedSpaceInfo;
  /** Called when user clicks Edit button */
  onEdit: (space: SpaceInfo) => void;
  /** Called when user clicks Open in Workspace button */
  onOpenInWorkspace: (spacePath: string) => void;
  /** Called when user clicks Reveal button */
  onRevealInFolder: (absolutePath: string) => void;
  /** Called when user clicks README button */
  onEditReadme: (spacePath: string) => void;
  /** Called when user clicks Remove/Move Out button */
  onRemove: (space: SpaceInfo) => void;
  /** Called when user clicks migrate legacy AGENTS.md button */
  onMigrateLegacyAgentsMd: (spacePath: string) => void;
  /** Called when user clicks Rename button */
  onRename?: (space: SpaceInfo) => void;
  /**
   * Called when the user clicks "Re-check" on a reconnecting space's banner — should
   * trigger a fresh cloud-liveness re-probe + spaces refresh (Stage 8). Optional;
   * the Re-check action is hidden when not provided.
   */
  onReCheckSync?: (space: SpaceInfo) => void;
  /** True while a Re-check re-probe is in flight for this space. */
  isReCheckingSync?: boolean;
  /**
   * Whether this space has a prior (last-known) index — drives the reconnecting
   * copy: with a prior index we say "showing your last-known files"; without one we
   * honestly say "this space is empty for now". Defaults to true (the common case;
   * never claim emptiness we can't prove).
   */
  hasPriorIndex?: boolean;
  /** Whether this space is currently being removed (symlink) */
  isRemoving?: boolean;
  /** Whether this space is currently being moved */
  isMoving?: boolean;
  /** Whether this space is currently being migrated (AGENTS.md -> README.md) */
  isMigrating?: boolean;
  /** Whether this space is currently being renamed */
  isRenaming?: boolean;
  /** If true, this is the Chief-of-Staff card (special styling, no Edit/Remove) */
  isChiefOfStaff?: boolean;
}

/**
 * Compact inline badge for storage provider
 */
function StorageBadge({ space }: { space: EnrichedSpaceInfo }) {
  const provider = space.storageProvider;
  
  if (provider === 'google_drive') {
    return (
      <Tooltip content="Google Drive" placement="top">
        <span className={styles.badge}>
          <img src={googleDriveIcon} alt="" width={12} height={12} />
        </span>
      </Tooltip>
    );
  }
  if (provider === 'onedrive') {
    return (
      <Tooltip content="OneDrive" placement="top">
        <span className={styles.badge}>
          <img src={oneDriveIcon} alt="" width={12} height={12} />
        </span>
      </Tooltip>
    );
  }
  if (provider === 'icloud' || provider === 'dropbox' || provider === 'box') {
    const label = provider === 'icloud' ? 'iCloud' : provider === 'dropbox' ? 'Dropbox' : 'Box';
    return (
      <Tooltip content={label} placement="top">
        <span className={styles.badge}>
          <Cloud size={12} />
        </span>
      </Tooltip>
    );
  }
  if (space.isSymlink && !provider) {
    return (
      <Tooltip content="Linked folder" placement="top">
        <span className={styles.badge}>
          <Link2 size={12} />
        </span>
      </Tooltip>
    );
  }
  if (provider === 'local') {
    return (
      <Tooltip content="Local" placement="top">
        <span className={styles.badge}>
          <HardDrive size={12} />
        </span>
      </Tooltip>
    );
  }
  return null;
}

/**
 * Per-space cloud SYNC-status badge (Stage 8) — sibling to the read-only
 * `ShieldAlert` badge. Shown ONLY when the space's cloud mount is reconnecting or
 * the linked folder is structurally gone; a 'healthy'/absent `syncStatus` renders
 * nothing, so this is inert for local spaces / a flag-off build. Info tone for
 * reconnecting (calmer than the amber `badgeWarning`), warning tone for not-found.
 * Conveyed by icon + tooltip + aria-label (not colour alone).
 */
function SyncStatusBadge({ space }: { space: EnrichedSpaceInfo }) {
  const syncStatus = space.syncStatus;
  if (!syncStatus || syncStatus === 'healthy') return null;

  if (syncStatus === 'not_found') {
    return (
      <Tooltip content="This linked folder no longer exists where Rebel expected it." placement="top">
        <span
          className={`${styles.badge} ${styles.badgeWarning}`}
          aria-label="This linked folder can't be found"
          data-testid="space-sync-badge-not-found"
        >
          <CloudOff size={12} />
          <span className={styles.badgeLabel}>Not found</span>
        </span>
      </Tooltip>
    );
  }

  // reconnecting
  return (
    <Tooltip content="Reconnecting to this folder. Showing your last-known files until it's back." placement="top">
      <span
        className={`${styles.badge} ${styles.badgeInfo}`}
        aria-label="Reconnecting to this folder"
        data-testid="space-sync-badge-reconnecting"
      >
        <RefreshCw size={12} />
        <span className={styles.badgeLabel}>Reconnecting</span>
      </span>
    </Tooltip>
  );
}

/**
 * Compact inline badge for sharing level (skip for Chief-of-Staff, shown separately)
 */
function SharingBadge({ space, isChiefOfStaff }: { space: EnrichedSpaceInfo; isChiefOfStaff?: boolean }) {
  // Chief-of-Staff always shows private, handled separately
  if (isChiefOfStaff) return null;
  
  const sharing = space.sharing;
  if (!sharing) return null;
  
  if (sharing === 'private') {
    return (
      <Tooltip content="Private" placement="top">
        <span className={styles.badge}>
          <Lock size={12} />
        </span>
      </Tooltip>
    );
  }
  if (sharing === 'restricted') {
    return (
      <Tooltip content="Restricted sharing" placement="top">
        <span className={styles.badge}>
          <Users size={12} />
        </span>
      </Tooltip>
    );
  }
  if (sharing === 'company-wide') {
    return (
      <Tooltip content="Company-wide" placement="top">
        <span className={styles.badge}>
          <Building2 size={12} />
        </span>
      </Tooltip>
    );
  }
  if (sharing === 'public') {
    return (
      <Tooltip content="Public" placement="top">
        <span className={styles.badge}>
          <Globe size={12} />
        </span>
      </Tooltip>
    );
  }
  return null;
}

function OrganisationBadge({
  space,
  onEdit,
}: {
  space: EnrichedSpaceInfo;
  onEdit?: (space: SpaceInfo) => void;
}) {
  const organisationName = space.organisationName?.trim();
  if (!organisationName) return null;

  // When an edit affordance is available (every space except Chief-of-Staff, which
  // has no edit surface), the badge is a click-through into the Edit Space wizard —
  // the only post-onboarding path to change or clear a per-space organisation name.
  // Without it (Chief-of-Staff) the badge stays a read-only label.
  if (onEdit) {
    return (
      <Tooltip content="Edit organisation" placement="top">
        <button
          type="button"
          className={styles.organisationBadgeButton}
          onClick={() => onEdit(space)}
          aria-label={`Edit organisation: ${organisationName}`}
        >
          <Badge variant="muted" size="sm" className={styles.organisationBadge}>
            <Building2 size={12} />
            <span className={styles.badgeLabel}>{organisationName}</span>
          </Badge>
        </button>
      </Tooltip>
    );
  }

  return (
    <Tooltip content={`Organisation: ${organisationName}`} placement="top">
      <Badge
        variant="muted"
        size="sm"
        className={styles.organisationBadge}
        aria-label={`Organisation: ${organisationName}`}
      >
        <Building2 size={12} />
        <span className={styles.badgeLabel}>{organisationName}</span>
      </Badge>
    </Tooltip>
  );
}

/**
 * Clickable status badge for goals/values - opens README where they're set
 */
function StatusBadge({ 
  space, 
  onEditReadme 
}: { 
  space: EnrichedSpaceInfo; 
  onEditReadme: (spacePath: string) => void;
}) {
  // Chief-of-Staff: show personal goals status
  if (space.type === 'chief-of-staff') {
    const goalsReviewed = space.goalsLastReviewed;
    if (!goalsReviewed) {
      return (
        <Tooltip content="Set your personal goals in README" placement="top">
          <button
            type="button"
            className={`${styles.badge} ${styles.badgeWarning} ${styles.badgeClickable}`}
            onClick={() => onEditReadme(space.path)}
          >
            <Target size={12} />
            <span className={styles.badgeLabel}>Set goals</span>
          </button>
        </Tooltip>
      );
    }
    const daysSince = getDaysSinceReview(goalsReviewed);
    if (isStale(goalsReviewed)) {
      return (
        <Tooltip content={`Goals need review (${daysSince ?? '?'}d ago)`} placement="top">
          <button
            type="button"
            className={`${styles.badge} ${styles.badgeWarning} ${styles.badgeClickable}`}
            onClick={() => onEditReadme(space.path)}
          >
            <AlertCircle size={12} />
            <span className={styles.badgeLabel}>Review goals</span>
          </button>
        </Tooltip>
      );
    }
    return (
      <Tooltip content={`Goals set ${daysSince ?? '?'}d ago`} placement="top">
        <span className={`${styles.badge} ${styles.badgeSuccess}`}>
          <CheckCircle2 size={12} />
        </span>
      </Tooltip>
    );
  }

  // Company/Team spaces: show values status
  if (space.type === 'company' || space.type === 'team') {
    const valuesReviewed = space.valuesLastReviewed;
    if (!valuesReviewed) {
      return (
        <Tooltip content="Set company values in README" placement="top">
          <button
            type="button"
            className={`${styles.badge} ${styles.badgeWarning} ${styles.badgeClickable}`}
            onClick={() => onEditReadme(space.path)}
          >
            <Target size={12} />
            <span className={styles.badgeLabel}>Set values</span>
          </button>
        </Tooltip>
      );
    }
    const daysSince = getDaysSinceReview(valuesReviewed);
    if (isStale(valuesReviewed)) {
      return (
        <Tooltip content={`Values need review (${daysSince ?? '?'}d ago)`} placement="top">
          <button
            type="button"
            className={`${styles.badge} ${styles.badgeWarning} ${styles.badgeClickable}`}
            onClick={() => onEditReadme(space.path)}
          >
            <AlertCircle size={12} />
            <span className={styles.badgeLabel}>Review values</span>
          </button>
        </Tooltip>
      );
    }
    return (
      <Tooltip content={`Values set ${daysSince ?? '?'}d ago`} placement="top">
        <span className={`${styles.badge} ${styles.badgeSuccess}`}>
          <CheckCircle2 size={12} />
        </span>
      </Tooltip>
    );
  }

  return null;
}

/**
 * Warning banner for legacy config or missing sharing (shown below card)
 */
function WarningBanner({
  space,
  onMigrate,
  onEdit,
  isMigrating,
  isChiefOfStaff,
}: {
  space: SpaceInfo;
  onMigrate: (spacePath: string) => void;
  onEdit: (space: SpaceInfo) => void;
  isMigrating: boolean;
  isChiefOfStaff?: boolean;
}) {
  // Both config files warning
  if (space.hasBothConfigFiles) {
    return (
      <div className={styles.warning}>
        <FileWarning size={14} />
        <span>Has both README.md and AGENTS.md - please merge or remove one</span>
      </div>
    );
  }

  // Legacy AGENTS.md warning
  if (space.hasLegacyAgentsMd) {
    return (
      <div className={styles.warning}>
        <FileWarning size={14} />
        <span>Uses legacy AGENTS.md</span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onMigrate(space.path)}
          disabled={isMigrating}
          className={styles.warningAction}
        >
          {isMigrating ? 'Renaming...' : <>Rename to README.md <ArrowRight size={12} /></>}
        </Button>
      </div>
    );
  }

  // Missing sharing warning (not for Chief-of-Staff)
  if (!isChiefOfStaff && !space.sharing) {
    return (
      <div className={styles.warning}>
        <FileWarning size={14} />
        <span>No sharing level set</span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onEdit(space)}
          className={styles.warningAction}
        >
          Configure <ArrowRight size={12} />
        </Button>
      </div>
    );
  }

  return null;
}

/**
 * Cloud sync-status banner (Stage 8) — the comprehension path for the reconnecting /
 * not-found states. Calm, info-tone for reconnecting; warning-tone for the
 * structurally-gone case. Renders nothing for a healthy/absent `syncStatus`, so it
 * is inert for local spaces / a flag-off build. Copy is the locked Chief-Designer
 * spec; provider is the friendly name, never a raw path.
 *
 * Three states:
 *  - (A) reconnecting + a prior index exists ⇒ "showing your last-known files".
 *  - (B) reconnecting + NO prior index ⇒ honest "this space is empty for now".
 *  - (C) not_found ⇒ warning tone + Reconnect / Remove (no recovery promise).
 */
function SyncStatusBanner({
  space,
  hasPriorIndex,
  onReCheck,
  onReconnect,
  onRemove,
  isReChecking,
  showReCheck,
}: {
  space: EnrichedSpaceInfo;
  hasPriorIndex: boolean;
  onReCheck: (space: SpaceInfo) => void;
  onReconnect: (space: SpaceInfo) => void;
  onRemove: (space: SpaceInfo) => void;
  isReChecking: boolean;
  showReCheck: boolean;
}) {
  const syncStatus = space.syncStatus;
  if (!syncStatus || syncStatus === 'healthy') return null;

  const provider = friendlyProviderName(space.storageProvider);

  // State C — structurally gone. Warning tone, real next steps, no recovery promise.
  if (syncStatus === 'not_found') {
    return (
      <div className={styles.syncBannerWarning} role="status" data-testid="space-sync-banner-not-found">
        <CloudOff size={14} />
        <span>
          Rebel can&rsquo;t find this folder anymore &mdash; it may have been moved, renamed, or you&rsquo;ve
          lost access. Your last-known files are still searchable.
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onReconnect(space)}
          className={styles.warningAction}
          data-testid="space-sync-reconnect"
        >
          Reconnect <ArrowRight size={12} />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onRemove(space)}
          className={styles.warningAction}
          data-testid="space-sync-remove"
        >
          Remove link
        </Button>
      </div>
    );
  }

  // States A / B — reconnecting. Info tone, auto-recover headline + one quiet Re-check.
  return (
    <div className={styles.syncBannerInfo} role="status" data-testid="space-sync-banner-reconnecting">
      <RefreshCw size={14} />
      <span>
        {hasPriorIndex
          ? `Reconnecting to ${provider} — showing your last-known files. This usually sorts itself out.`
          : `Can't reach ${provider} yet, so this space is empty for now. We'll keep trying and fill it in once it's back.`}
      </span>
      {showReCheck && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onReCheck(space)}
          disabled={isReChecking}
          className={styles.warningAction}
          data-testid="space-sync-recheck"
        >
          {isReChecking ? 'Checking…' : 'Re-check'}
        </Button>
      )}
    </div>
  );
}

/**
 * SpaceCard displays a single space in a compact, clear format.
 */
export function SpaceCard({
  space,
  onEdit,
  onOpenInWorkspace,
  onRevealInFolder,
  onEditReadme,
  onRemove,
  onMigrateLegacyAgentsMd,
  onRename: _onRename,
  onReCheckSync,
  isReCheckingSync = false,
  hasPriorIndex = true,
  isRemoving = false,
  isMoving = false,
  isMigrating = false,
  isRenaming = false,
  isChiefOfStaff = false,
}: SpaceCardProps) {
  const isDisabled = isRemoving || isMoving || isRenaming;
  const displayName = space.displayName || space.name;
  const description = formatDescription(space.description);
  
  // Track if description is truncated and expanded state
  const [isExpanded, setIsExpanded] = useState(false);
  const [isTruncated, setIsTruncated] = useState(false);
  const descriptionRef = useRef<HTMLParagraphElement>(null);
  
  // Check if text is truncated after render
  // With -webkit-line-clamp, Chromium may report scrollHeight === clientHeight
  // even when content is visually truncated. Temporarily remove the clamp to
  // measure the true content height (runs before paint — no visual flash).
  useLayoutEffect(() => {
    const el = descriptionRef.current;
    if (!el || !description || isExpanded) return;
    const clampedHeight = el.clientHeight;
    if (clampedHeight === 0) return;
    el.style.display = 'block';
    el.style.overflow = 'visible';
    el.style.webkitLineClamp = 'unset';
    const fullHeight = el.scrollHeight;
    el.style.display = '';
    el.style.overflow = '';
    el.style.webkitLineClamp = '';
    setIsTruncated(fullHeight > clampedHeight + 1);
  }, [description, isExpanded]);

  return (
    <div className={styles.card}>
      {/* Row 1: Name + badges + actions */}
      <div className={styles.headerRow}>
        <span className={styles.name}>{displayName}</span>
        
        {/* Metadata badges */}
        <div className={styles.badges}>
          <OrganisationBadge space={space} onEdit={isChiefOfStaff ? undefined : onEdit} />
          <StorageBadge space={space} />
          <SharingBadge space={space} isChiefOfStaff={isChiefOfStaff} />
          {space.writable === false && (
            <Tooltip content="Read-only — cannot write to this space" placement="top">
              <span className={styles.badge}>
                <ShieldAlert size={12} />
              </span>
            </Tooltip>
          )}
          <SyncStatusBadge space={space} />
          <StatusBadge space={space} onEditReadme={onEditReadme} />
          {isChiefOfStaff && (
            <Tooltip content="Private - only you can see this" placement="top">
              <span className={styles.badge}>
                <Lock size={12} />
              </span>
            </Tooltip>
          )}
        </div>

        {/* Actions - always visible */}
        <div className={styles.actions}>
          <Tooltip content="Open in Library" placement="top">
            <IconButton
              size="sm"
              variant="ghost"
              onClick={() => onOpenInWorkspace(space.path)}
              className={styles.actionButton}
              aria-label="Open in Library"
            >
              <Folder size={14} />
            </IconButton>
          </Tooltip>

          {space.hasReadme && (
            <Tooltip content="Edit README" placement="top">
              <IconButton
                size="sm"
                variant="ghost"
                onClick={() => onEditReadme(space.path)}
                className={styles.actionButton}
                aria-label="Edit README"
              >
                <PenSquare size={14} />
              </IconButton>
            </Tooltip>
          )}

          {/* Edit button - not shown for Chief-of-Staff */}
          {!isChiefOfStaff && (
            <Tooltip content="Edit space settings" placement="top">
              <IconButton
                size="sm"
                variant="ghost"
                onClick={() => onEdit(space)}
                className={styles.actionButton}
                aria-label="Edit space settings"
              >
                <Settings size={14} />
              </IconButton>
            </Tooltip>
          )}

          {/* Secondary actions in overflow menu style */}
          <div className={styles.secondaryActions}>
            <Tooltip content="Reveal in Finder" placement="top">
              <IconButton
                size="sm"
                variant="ghost"
                onClick={() => onRevealInFolder(space.absolutePath)}
                className={styles.actionButton}
                aria-label="Reveal in Finder"
              >
                <FolderOpen size={14} />
              </IconButton>
            </Tooltip>

            {!isChiefOfStaff && (
              <Tooltip
                content={space.isSymlink ? 'Remove link' : 'Move out of Library'}
                placement="top"
              >
                <IconButton
                  size="sm"
                  variant="ghost"
                  danger={space.isSymlink}
                  onClick={() => onRemove(space)}
                  disabled={isDisabled}
                  className={styles.actionButton}
                  aria-label={space.isSymlink ? 'Remove link' : 'Move out of Library'}
                >
                  {isRemoving ? '...' : isMoving ? '...' : space.isSymlink ? <Link2Off size={14} /> : <FolderOutput size={14} />}
                </IconButton>
              </Tooltip>
            )}
          </div>
        </div>
      </div>

      {/* Row 2: Description with optional "Read more" */}
      {description && (
        <div className={styles.descriptionWrapper}>
          <p 
            ref={descriptionRef}
            className={styles.description}
            style={isExpanded ? { WebkitLineClamp: 'unset' } : undefined}
          >
            {description}
          </p>
          {isTruncated && !isExpanded && (
            <button
              type="button"
              className={styles.readMore}
              onClick={() => setIsExpanded(true)}
            >
              Read more
            </button>
          )}
          {isExpanded && (
            <button
              type="button"
              className={styles.readMore}
              onClick={() => setIsExpanded(false)}
            >
              Show less
            </button>
          )}
        </div>
      )}

      {/* Row 3: Source path with folder icon (for symlinks) */}
      {space.isSymlink && space.sourcePath && (
        <div className={styles.sourcePath}>
          <FolderOpen size={12} className={styles.sourcePathIcon} />
          <span>{space.sourcePath}</span>
        </div>
      )}

      {/* Cloud sync-status banner (reconnecting / not-found) — Stage 8. Inert for a
          healthy/local space. Rendered above the config WarningBanner because a
          folder Rebel can't reach is more salient than a config nit. */}
      <SyncStatusBanner
        space={space}
        hasPriorIndex={hasPriorIndex}
        onReCheck={onReCheckSync ?? (() => undefined)}
        onReconnect={onEdit}
        onRemove={onRemove}
        isReChecking={isReCheckingSync}
        showReCheck={Boolean(onReCheckSync)}
      />

      {/* Warning banner if needed */}
      <WarningBanner
        space={space}
        onMigrate={onMigrateLegacyAgentsMd}
        onEdit={onEdit}
        isMigrating={isMigrating}
        isChiefOfStaff={isChiefOfStaff}
      />
    </div>
  );
}
