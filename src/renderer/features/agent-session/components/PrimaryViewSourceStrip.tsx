import type { FC } from 'react';
import { Tooltip } from '@renderer/components/ui';
import { cn } from '@renderer/lib/utils';
import {
  resolveSourceDisplayName,
  type ResolvedSourceDisplayName,
} from '../utils/mcpAppDisplayNames';
import styles from './ConversationPane.module.css';

const DEFAULT_VIEW_ROLE_LABEL = 'Interactive view';
const TRUST_TOOLTIP_BODY = 'This view runs separately from Rebel for safety.';
const FAILURE_TOOLTIP_BODY = 'This view failed to load. Rebel is showing a summary instead.';

export interface PrimaryViewSourceStripProps {
  sourcePackageId?: string | null;
  viewRoleLabel?: string;
  isCompact?: boolean;
  hasFailure?: boolean;
  className?: string;
  /** Story/test hook for the documented open-tooltip state. */
  defaultTooltipOpen?: boolean;
}

function getResolvedRoleLabel(viewRoleLabel: string | undefined): string {
  return viewRoleLabel?.trim() || DEFAULT_VIEW_ROLE_LABEL;
}

function SafeViewTrigger({
  children,
  tooltipBody,
  defaultTooltipOpen,
}: {
  children: string;
  tooltipBody: string;
  defaultTooltipOpen?: boolean;
}) {
  const accessibleLabel = children.replace(/\.$/u, '');
  return (
    <Tooltip
      content={tooltipBody}
      placement="top"
      delayShow={0}
      clickToToggle
      defaultOpen={defaultTooltipOpen}
    >
      <button
        type="button"
        className={styles.primaryViewSafeViewTrigger}
        aria-label={`${accessibleLabel}: ${tooltipBody}`}
        onClick={(event) => event.stopPropagation()}
      >
        {children}
      </button>
    </Tooltip>
  );
}

function WideSourceLine({
  source,
  tooltipBody,
  defaultTooltipOpen,
}: {
  source: ResolvedSourceDisplayName;
  tooltipBody: string;
  defaultTooltipOpen?: boolean;
}) {
  const sourceText = source.sourceKind === 'internal-rebel'
    ? source.displayName
    : `From ${source.displayName}`;

  return (
    <span className={styles.primaryViewSourceLine}>
      <span>{sourceText}</span>
      <span aria-hidden="true"> · </span>
      <SafeViewTrigger tooltipBody={tooltipBody} defaultTooltipOpen={defaultTooltipOpen}>
        Safe view
      </SafeViewTrigger>
    </span>
  );
}

function CompactSourceLine({
  source,
  tooltipBody,
  defaultTooltipOpen,
}: {
  source: ResolvedSourceDisplayName;
  tooltipBody: string;
  defaultTooltipOpen?: boolean;
}) {
  const sourceText = source.sourceKind === 'internal-rebel'
    ? source.displayName
    : `From ${source.displayName}`;

  return (
    <span className={styles.primaryViewSourceLine}>
      <span>{sourceText}. </span>
      <SafeViewTrigger tooltipBody={tooltipBody} defaultTooltipOpen={defaultTooltipOpen}>
        Runs separately for safety.
      </SafeViewTrigger>
    </span>
  );
}

export const PrimaryViewSourceStrip: FC<PrimaryViewSourceStripProps> = ({
  sourcePackageId,
  viewRoleLabel,
  isCompact = false,
  hasFailure = false,
  className,
  defaultTooltipOpen = false,
}) => {
  const source = resolveSourceDisplayName(sourcePackageId);
  const roleLabel = getResolvedRoleLabel(viewRoleLabel);
  const tooltipBody = hasFailure ? FAILURE_TOOLTIP_BODY : TRUST_TOOLTIP_BODY;

  return (
    <div
      className={cn(
        styles.primaryViewSourceStrip,
        isCompact && styles.primaryViewSourceStripForceCompact,
        className,
      )}
      data-testid="primary-view-source-strip"
    >
      <div className={styles.primaryViewSourceStripWideLayout}>
        <span className={styles.primaryViewRoleLabel}>{roleLabel}</span>
        <WideSourceLine
          source={source}
          tooltipBody={tooltipBody}
          defaultTooltipOpen={defaultTooltipOpen}
        />
      </div>
      <div className={styles.primaryViewSourceStripCompactLayout}>
        <span className={styles.primaryViewRoleLabel}>{roleLabel}</span>
        <CompactSourceLine
          source={source}
          tooltipBody={tooltipBody}
          defaultTooltipOpen={defaultTooltipOpen}
        />
      </div>
    </div>
  );
};
