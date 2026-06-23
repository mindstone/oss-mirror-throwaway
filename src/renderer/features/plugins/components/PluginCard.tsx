/**
 * PluginCard
 *
 * Library Plugins lens card. Mirrors the grid density of `SkillCard` (180–240px,
 * elevated surface, hover states) and reuses shared primitives — `Badge`,
 * `MaturityBadge`, `InlineToggle`, `Notice`, and the existing
 * `PluginActionsMenu` overflow.
 *
 * Stage A1.3 of docs/plans/260521_plugin_publishing_org_distribution.md.
 */

import { useCallback, useMemo, type FC, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react';
import { Clock, Puzzle, Star, User } from 'lucide-react';
import { Badge, MaturityBadge, Notice, Tooltip } from '@renderer/components/ui';
import { InlineToggle } from '@renderer/components/ui/InlineToggle';
import { cn } from '@renderer/lib/utils';
import type { PluginManifest } from '../manifest/pluginManifest';
import { PluginActionsMenu, type PluginAction } from './PluginActionsMenu';
import { formatSpaceSourceLabel } from '../utils/formatSpaceSourceLabel';
import { shouldIgnoreCardClick } from '@renderer/features/library/components/views/cardClickGuard';
import styles from './PluginCard.module.css';

export interface PluginCardProps {
  manifest: PluginManifest;
  /** Origin of the card; controls source-Space line and overflow menu contents. */
  origin: 'space' | 'local';
  /** Filesystem path of the owning Space, when origin === 'space'. */
  spacePath?: string;
  /** Whether the plugin is currently registered/running for this user. */
  isActive: boolean;
  /** Indicates the toggle is mid-flight (compile + IPC). */
  isPending?: boolean;
  /** Conflict file paths reported by `scanSpacePlugins` (rendered as a warning Notice). */
  conflictFiles?: string[];
  /** True when this plugin was seeded from Rebel's built-in plugin bundle. */
  isBuiltIn?: boolean;
  /** Suppresses the embedded conflict warning when host page renders its own resolver. */
  hideConflictNotice?: boolean;
  /** Called when the user toggles "On for me" / "Off for me". */
  onActiveChange: (next: boolean) => void;
  /** Called when the user opens the card (Enter/Space, click). */
  onOpen?: () => void;
  /** Called for each item from the overflow menu. */
  onAction?: (action: PluginAction) => void;
  hasDocumentation?: boolean;
  isDocsOpen?: boolean;
  hasDataBackup?: boolean;
  className?: string;
  'data-testid'?: string;
}

function formatLastUpdatedLine(manifest: PluginManifest): string | null {
  const latest = manifest.changelog?.[0];
  if (latest?.date) {
    const author = latest.author ? ` by ${latest.author}` : '';
    return `Updated ${latest.date}${author}`;
  }
  return null;
}

export const PluginCard: FC<PluginCardProps> = ({
  manifest,
  origin,
  spacePath,
  isActive,
  isPending = false,
  conflictFiles,
  isBuiltIn = false,
  hideConflictNotice = false,
  onActiveChange,
  onOpen,
  onAction,
  hasDocumentation,
  isDocsOpen,
  hasDataBackup,
  className,
  'data-testid': dataTestId,
}) => {
  const isHero = manifest.role === 'hero';
  const isLabs = manifest.maturity === 'labs';
  const isSpacePlugin = origin === 'space';
  const sourceLabel = isSpacePlugin ? formatSpaceSourceLabel(spacePath) : 'Local';
  const updatedLine = useMemo(() => formatLastUpdatedLine(manifest), [manifest]);
  const conflictCount = conflictFiles?.length ?? 0;
  const hasConflict = conflictCount > 0 && !hideConflictNotice;

  const handleCardClick = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      if (!onOpen) return;
      if (shouldIgnoreCardClick(event)) return;
      onOpen();
    },
    [onOpen],
  );

  const handleCardKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      if (!onOpen) return;
      if (event.currentTarget !== event.target) return;
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        onOpen();
      }
    },
    [onOpen],
  );

  return (
    <article
      className={cn(styles.card, className)}
      data-testid={dataTestId ?? 'plugin-card'}
      data-hero={isHero ? 'true' : 'false'}
      data-active={isActive ? 'true' : 'false'}
      tabIndex={onOpen ? 0 : -1}
      onClick={handleCardClick}
      onKeyDown={handleCardKeyDown}
    >
      <header className={styles.header}>
        <div className={styles.headerTop}>
          <div className={styles.titleGroup}>
            <div className={styles.iconBadge} aria-hidden="true">
              <Puzzle size={16} />
            </div>
            <div className={styles.titleText}>
              <h2 className={styles.title} title={manifest.name}>
                {manifest.name}
              </h2>
              <div className={styles.badgeRow}>
                {isHero && (
                  <Tooltip content="Hero plugin — featured for this Space.">
                    <Badge variant="primary" size="sm" className={styles.heroBadge}>
                      <Star size={11} aria-hidden /> Hero
                    </Badge>
                  </Tooltip>
                )}
                {isLabs && <MaturityBadge level="labs" featureName={manifest.name} />}
                {isBuiltIn && (
                  <Tooltip content="Built-in plugin from Rebel. Your editable copy lives in your Space.">
                    <Badge variant="muted" size="sm" className={styles.builtInBadge}>
                      Built-in
                    </Badge>
                  </Tooltip>
                )}
              </div>
            </div>
          </div>
          {onAction && (
            <div className={styles.headerActions} onClick={(e) => e.stopPropagation()}>
              <PluginActionsMenu
                pluginName={manifest.name}
                hasDocumentation={hasDocumentation}
                isDocsOpen={isDocsOpen}
                isSpacePlugin={isSpacePlugin}
                spacePath={spacePath}
                hasDataBackup={hasDataBackup}
                onAction={onAction}
              />
            </div>
          )}
        </div>
      </header>

      <div className={styles.body}>
        {manifest.description ? (
          <p className={styles.description}>{manifest.description}</p>
        ) : (
          <p className={cn(styles.description, styles.descriptionMuted)}>
            No description provided.
          </p>
        )}

        <div className={styles.provenance}>
          <div className={styles.provenanceRow}>
            <User size={12} aria-hidden />
            <span title={sourceLabel}>From: {sourceLabel}</span>
          </div>
          {updatedLine && (
            <div className={styles.provenanceRow}>
              <Clock size={12} aria-hidden />
              <span>{updatedLine}</span>
            </div>
          )}
        </div>

        {hasConflict && (
          <div className={styles.conflictNotice}>
            <Notice tone="warning" placement="embedded" density="compact">
              {conflictCount === 1
                ? 'Another file conflicts with this plugin. Resolve it from Settings → Plugins.'
                : `${conflictCount} files conflict with this plugin. Resolve them from Settings → Plugins.`}
            </Notice>
          </div>
        )}
      </div>

      <footer className={styles.footer} onClick={(e) => e.stopPropagation()}>
        <InlineToggle
          checked={isActive}
          disabled={isPending}
          stopPropagation
          label={isActive ? 'On for me' : 'Off for me'}
          onCheckedChange={(next) => onActiveChange(next)}
          aria-label={`Toggle ${manifest.name} for me`}
        />
      </footer>
    </article>
  );
};

PluginCard.displayName = 'PluginCard';
