import { forwardRef, useCallback, useMemo, KeyboardEvent } from 'react';
import { motion } from 'motion/react';
import { AlertTriangle, Loader2, FileCode2 } from 'lucide-react';
import { Tooltip } from '@renderer/components/ui';
import type { UnifiedConnection, ConnectionStatus, ConnectionAttentionState } from '../hooks/useUnifiedConnections';
import { isBundledLikeProvider } from '@shared/types';
import { getCategoryColors, getCategoryIcon } from '../utils/connectorIcons';
import styles from './SettingsSurface.module.css';

// Status icons - only shown for problem states (replaces category icon)
const STATUS_ICONS: Record<ConnectionStatus, typeof AlertTriangle | null> = {
  connected: null, // No indicator for healthy connections
  'needs-setup': AlertTriangle,
  error: AlertTriangle,
  available: null,
};

const STATUS_COLORS: Record<ConnectionStatus, string> = {
  connected: 'var(--color-success, #22c55e)', // Kept for potential future use
  'needs-setup': 'var(--color-warning, #f59e0b)',
  error: 'var(--color-error, #ef4444)',
  available: 'var(--color-muted, #6b7280)',
};

/**
 * Get the appropriate badge for a connection based on its source and maturity.
 * Returns null for stable bundled MCPs (trusted default, no badge needed).
 */
function getConnectionBadge(
  connection: UnifiedConnection
): { label: string; className: string } | null {
  const { catalogEntry, provider } = connection;

  // Custom MCP (no catalog entry) - user added this
  if (!catalogEntry) {
    return { label: 'Custom', className: styles.connectionChipBadgeCustom };
  }

  // Bundled / rebel-oss connectors
  if (isBundledLikeProvider(provider)) {
    // Beta - new/experimental feature
    if (catalogEntry.maturity !== 'stable') {
      return { label: 'Beta', className: styles.connectionChipBadgeBeta };
    }
    // Stable - no badge (trusted default)
    return null;
  }

  // Direct OAuth - vendor-hosted endpoint
  if (provider === 'direct') {
    return { label: 'Official', className: styles.connectionChipBadgeOfficial };
  }

  // Community - third-party npx packages
  if (provider === 'community') {
    return { label: 'Community', className: styles.connectionChipBadgeCommunity };
  }

  return null;
}

// Badge explanations by badge text
const badgeExplanations: Record<string, string> = {
  'Official': 'Hosted by the service provider',
  'Community': 'Community-maintained',
  'Beta': 'Experimental - may have rough edges',
  'Custom': 'Manually configured',
};

// Status explanations (tooltips; align with Connectors scan copy)
const statusExplanations: Record<ConnectionStatus, string> = {
  connected: 'Connected',
  'needs-setup': 'Needs attention',
  available: 'Available to connect',
  error: 'Needs attention — connection issue',
};

/** Format a timestamp for tooltip display */
function formatLastConnected(timestamp: number | null | undefined): string | null {
  if (!timestamp) return null;
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  
  if (diffDays === 0) {
    return 'Connected today';
  } else if (diffDays === 1) {
    return 'Connected yesterday';
  } else if (diffDays < 7) {
    return `Connected ${diffDays} days ago`;
  } else if (diffDays < 30) {
    const weeks = Math.floor(diffDays / 7);
    return `Connected ${weeks} ${weeks === 1 ? 'week' : 'weeks'} ago`;
  } else {
    return `Connected ${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
  }
}

interface ConnectionChipProps {
  connection: UnifiedConnection;
  attentionState?: ConnectionAttentionState;
  isExpanded?: boolean;
  isLoading?: boolean;
  isRemoving?: boolean;
  onClick?: () => void;
  layoutId?: string;
  tabIndex?: number;
  'aria-selected'?: boolean;
  /** When true (in "All" tab), shows account email/workspace in the chip */
  showAccountIdentity?: boolean;
  /** When false, hides the connector icon (useful when chips are grouped by category) */
  showIcon?: boolean;
  /** When false, hides badges like Official/Community (show only in expanded view) */
  showBadge?: boolean;
  secondaryLabel?: string | null;
  /** data-section attribute for deep-link scroll-to-highlight from health toasts */
  dataSection?: string;
}

export const ConnectionChip = forwardRef<HTMLButtonElement, ConnectionChipProps>(
  function ConnectionChip(
    {
      connection,
      attentionState = 'healthy',
      isExpanded,
      isLoading,
      isRemoving,
      onClick,
      layoutId,
      tabIndex = 0,
      'aria-selected': ariaSelected,
      showAccountIdentity = false,
      showIcon = true,
      showBadge = true,
      secondaryLabel = null,
      dataSection,
    },
    ref
  ) {
    const effectiveStatus: ConnectionStatus =
      attentionState === 'needs-attention'
        ? 'needs-setup'
        : attentionState === 'inactive'
          ? 'available'
          : connection.status;
    const StatusIcon = STATUS_ICONS[effectiveStatus];
    const statusColor = STATUS_COLORS[effectiveStatus];
    const isConnected = connection.status !== 'available';

    // Get category icon and colors for visual differentiation
    // Connected chips use category icon for consistency with category headers
    const CategoryIcon = useMemo(
      () => getCategoryIcon(connection.catalogEntry?.category),
      [connection.catalogEntry?.category]
    );
    const categoryColors = useMemo(
      () => getCategoryColors(connection.catalogEntry?.category),
      [connection.catalogEntry?.category]
    );

    const handleKeyDown = useCallback(
      (e: KeyboardEvent<HTMLButtonElement>) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick?.();
        }
      },
      [onClick]
    );

    // Check if connection is disabled (from McpServerPreview.disabled)
    const isDisabled = connection.serverPreview?.disabled === true;

    const chipClassName = [
      styles.connectionChip,
      isConnected ? styles.connectionChipConnected : styles.connectionChipAvailable,
      attentionState === 'needs-attention' && styles.connectionChipWarning,
      attentionState === 'inactive' && styles.connectionChipInactive,
      connection.status === 'error' && attentionState !== 'needs-attention' && styles.connectionChipMuted,
      isExpanded && styles.connectionChipExpanded,
      onClick && styles.connectionChipClickable,
      isDisabled && styles.connectionChipDisabled,
    ]
      .filter(Boolean)
      .join(' ');

    // Check if this connector requires Python runtime
    const requiresPython = connection.catalogEntry?.runtime === 'python';

    // Get unified badge (Custom, Beta, Official, Community, or null for stable bundled)
    const badge = getConnectionBadge(connection);
    const badgeText = badge?.label;

    // Get account identity label (email or workspace) for display
    const accountIdentityLabel = secondaryLabel
      ?? connection.serverPreview?.email 
      ?? connection.serverPreview?.workspace 
      ?? null;

    // Format lastConnectedAt for tooltip
    const lastConnectedText = formatLastConnected(connection.serverPreview?.lastConnectedAt);

    // Enhanced tooltip content including status, badge explanation, and connection time
    const statusTooltipLine =
      attentionState === 'needs-attention'
        ? 'Needs attention — reconnect or finish setup if prompted'
        : attentionState === 'inactive'
          ? 'Not connected — turn it back on to use this connector again'
          : statusExplanations[connection.status] ?? connection.status;

    const tooltipContent = [
      connection.description,
      badgeText && badgeExplanations[badgeText] ? `${badgeText}: ${badgeExplanations[badgeText]}` : null,
      statusTooltipLine,
      lastConnectedText,
      requiresPython ? 'Requires Python' : null,
      isDisabled ? 'Disabled - tools from this connector are not active' : null,
    ].filter(Boolean).join(' · ');

    return (
      <Tooltip content={tooltipContent}>
        <motion.button
          ref={ref}
          layoutId={layoutId}
          className={chipClassName}
          onClick={isRemoving ? undefined : onClick}
          onKeyDown={isRemoving ? undefined : handleKeyDown}
          tabIndex={isRemoving ? -1 : tabIndex}
          aria-selected={ariaSelected}
          aria-label={`${connection.name} - ${attentionState === 'needs-attention' ? 'needs attention' : attentionState === 'inactive' ? 'not connected' : connection.status}`}
          aria-busy={isRemoving}
          data-chip
          data-section={dataSection}
          data-testid={`connector-card-${connection.id}`}
          initial={{ opacity: 0, scale: 0.9 }}
          animate={isRemoving 
            ? { opacity: 0, scale: 0.8, filter: 'blur(2px)' }
            : { opacity: 1, scale: 1, filter: 'blur(0px)' }
          }
          exit={{ opacity: 0, scale: 0.8 }}
          transition={{ duration: isRemoving ? 0.3 : 0.2, ease: 'easeOut' }}
          layout
          style={{
            ...(isRemoving ? { pointerEvents: 'none' as const } : {}),
            '--chip-bg': categoryColors.bg,
            '--chip-border': categoryColors.border,
            '--chip-hover-bg': categoryColors.hoverBg,
            '--chip-hover-border': categoryColors.hoverBorder,
            '--chip-icon-color': categoryColors.iconColor,
          } as React.CSSProperties}
        >
          {/* Icon area - shows category icon, warning indicator, or loading spinner */}
          {showIcon && (
            <span
              className={styles.connectionChipIcon}
              style={{ color: StatusIcon ? statusColor : categoryColors.iconColor }}
              data-testid={StatusIcon ? `connector-status-${connection.id}` : undefined}
            >
              {isLoading ? (
                <Loader2 size={14} className={styles.connectionChipStatusSpin} />
              ) : StatusIcon ? (
                // Show warning/error icon instead of category icon when there's an issue
                <StatusIcon size={14} />
              ) : (
                <CategoryIcon size={14} />
              )}
            </span>
          )}

          {/* Loading spinner when icon is hidden */}
          {!showIcon && isLoading && (
            <span className={styles.connectionChipIcon}>
              <Loader2 size={14} className={styles.connectionChipStatusSpin} />
            </span>
          )}

          {/* Name */}
          <span className={styles.connectionChipName}>
            {connection.name}
            {(showAccountIdentity || secondaryLabel) && accountIdentityLabel && (
              <span className={styles.connectionChipAccount}>{accountIdentityLabel}</span>
            )}
          </span>

          {/* Unified source/maturity badge - only show when showBadge is true */}
          {showBadge && badge && (
            <span className={badge.className}>{badge.label}</span>
          )}

          {/* Python runtime badge - always show (important technical info) */}
          {requiresPython && (
            <span className={styles.connectionChipBadgePython}>
              <FileCode2 size={10} aria-hidden />
              Python
            </span>
          )}

          {/* Disabled badge - always show (important status info) */}
          {isDisabled && (
            <span className={styles.connectionChipDisabledBadge}>
              Disabled
            </span>
          )}

          {/* Tool count - only show for connected chips */}
          {isConnected && connection.toolCount != null && connection.toolCount > 0 && (
            <span className={styles.connectionChipTools}>
              {connection.toolCount}
            </span>
          )}
        </motion.button>
      </Tooltip>
    );
  }
);
