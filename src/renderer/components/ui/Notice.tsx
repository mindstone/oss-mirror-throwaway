import * as React from 'react';
import type { AriaRole } from 'react';
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '../../lib/utils';
import { Button } from './Button';
import { IconButton } from './IconButton';
import { Spinner } from './Spinner';
import styles from './Notice.module.css';

export type NoticeTone = 'info' | 'warning' | 'error' | 'success';
export type NoticeDensity = 'standard' | 'compact';
export type NoticePlacement = 'section' | 'inline' | 'embedded';

export interface NoticeAction {
  label: string;
  onClick: () => void;
  variant?: 'primary' | 'secondary';
  disabled?: boolean;
  loading?: boolean;
  'data-testid'?: string;
}

type NoticeRole = Extract<AriaRole, 'status' | 'alert' | 'note'>;

type NoticeActionPlacementProps =
  | {
      placement?: Exclude<NoticePlacement, 'embedded'>;
      actions?: NoticeAction[];
    }
  | {
      placement: 'embedded';
      actions?: never;
    };

type NoticeDismissProps =
  | {
      dismissible?: false;
      onDismiss?: never;
    }
  | {
      dismissible: true;
      onDismiss: () => void;
    };

type NoticeBaseProps = {
  tone?: NoticeTone;
  density?: NoticeDensity;
  title?: React.ReactNode;
  children: React.ReactNode;
  icon?: LucideIcon;
  role?: NoticeRole;
  'data-testid'?: string;
};

export type NoticeProps = NoticeDismissProps & NoticeActionPlacementProps & NoticeBaseProps;

const TONE_ICONS: Record<NoticeTone, LucideIcon> = {
  info: Info,
  warning: AlertTriangle,
  error: XCircle,
  success: CheckCircle2,
};

const TONE_DEFAULT_ROLE: Record<NoticeTone, NoticeRole> = {
  info: 'status',
  warning: 'note',
  error: 'note',
  success: 'status',
};

const TONE_CLASS: Record<NoticeTone, string> = {
  info: styles.toneInfo,
  warning: styles.toneWarning,
  error: styles.toneError,
  success: styles.toneSuccess,
};

const PLACEMENT_CLASS: Record<NoticePlacement, string> = {
  section: styles.placementSection,
  inline: styles.placementInline,
  embedded: styles.placementEmbedded,
};

/**
 * `Notice` is the persistent in-flow status, attention, and prerequisite primitive.
 *
 * Use `Notice` for contextual messages that should stay visible near the thing they affect.
 * Use the `Toast` family from this package for transient feedback that auto-dismisses.
 *
 * The three placements (`section`, `inline`, `embedded`) deliberately render at different
 * weights so that section warnings, inline nudges, and field-embedded warnings can share
 * one primitive without flattening their roles.
 */
export const Notice = React.forwardRef<HTMLDivElement, NoticeProps>(
  (
    {
      tone = 'info',
      density = 'standard',
      placement = 'inline',
      title,
      children,
      icon: IconOverride,
      actions,
      role,
      dismissible,
      onDismiss,
      'data-testid': dataTestId,
    },
    ref,
  ) => {
    const Icon = IconOverride ?? TONE_ICONS[tone];
    const resolvedRole: NoticeRole = role ?? TONE_DEFAULT_ROLE[tone];
    const ariaLive = resolvedRole === 'status' ? 'polite' : undefined;
    const limitedActions = actions ? actions.slice(0, 2) : undefined;
    const iconSize = density === 'compact' || placement === 'embedded' ? 16 : 18;

    return (
      <div
        ref={ref}
        role={resolvedRole}
        aria-live={ariaLive}
        data-has-title={title ? 'true' : 'false'}
        data-action-count={limitedActions?.length ?? 0}
        data-testid={dataTestId}
        className={cn(
          styles.notice,
          TONE_CLASS[tone],
          PLACEMENT_CLASS[placement],
          density === 'compact' && styles.densityCompact,
        )}
      >
        <span className={styles.icon} aria-hidden="true">
          <Icon size={iconSize} />
        </span>

        <div className={styles.body}>
          {title ? <p className={styles.title}>{title}</p> : null}
          <div className={styles.description}>{children}</div>
        </div>

        {limitedActions && limitedActions.length > 0 ? (
          <div className={styles.actions}>
            {limitedActions.map((action, index) => {
              const buttonVariant =
                action.variant === 'secondary' || (action.variant === undefined && index === 1)
                  ? 'ghost'
                  : 'outline';
              return (
                <Button
                  key={index}
                  type="button"
                  size="sm"
                  variant={buttonVariant}
                  onClick={action.onClick}
                  disabled={action.disabled || action.loading}
                  data-testid={action['data-testid']}
                >
                  {action.loading ? <Spinner size="sm" /> : null}
                  {action.label}
                </Button>
              );
            })}
          </div>
        ) : null}

        {dismissible ? (
          <IconButton
            type="button"
            size="xs"
            variant="ghost"
            aria-label="Dismiss notice"
            onClick={onDismiss}
            className={styles.dismiss}
          >
            <X size={14} />
          </IconButton>
        ) : null}
      </div>
    );
  },
);

Notice.displayName = 'Notice';
