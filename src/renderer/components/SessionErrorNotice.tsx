import type { AgentErrorResolution, AgentErrorResolutionAction } from '@rebel/shared';
import type { AgentEvent } from '@shared/types';
import { Notice, type NoticeAction, type NoticeTone } from '@renderer/components/ui';

type AgentEventError = Extract<AgentEvent, { type: 'error' }>;

type SessionErrorNoticeProps = {
  resolution: AgentErrorResolution;
  error?: AgentEventError | string;
  onApply: (action: AgentErrorResolutionAction) => void;
  onDismiss?: () => void;
  pendingAction?: AgentErrorResolutionAction['action'] | null;
  dismissible?: boolean;
};

const TONE_BY_CATEGORY: Record<AgentErrorResolution['category'], NoticeTone> = {
  transient: 'info',
  'user-fixable': 'warning',
  'system-broken': 'error',
  'unsupported-feature': 'warning',
  unknown: 'warning',
};

function isDefaultAction(
  action: AgentErrorResolutionAction,
  defaultAction: AgentErrorResolutionAction | undefined,
): boolean {
  if (!defaultAction) return false;
  return (
    action.action === defaultAction.action &&
    action.label === defaultAction.label &&
    action.payload?.model === defaultAction.payload?.model &&
    action.payload?.provider === defaultAction.payload?.provider &&
    action.payload?.settingsSection === defaultAction.payload?.settingsSection
  );
}

function mapNoticeActions(
  resolution: AgentErrorResolution,
  onApply: (action: AgentErrorResolutionAction) => void,
  pendingAction: AgentErrorResolutionAction['action'] | null | undefined,
): NoticeAction[] {
  return resolution.alternatives.slice(0, 2).map((action, index) => ({
    label: action.label,
    onClick: () => {
      if (pendingAction) return;
      onApply(action);
    },
    variant: isDefaultAction(action, resolution.defaultAction)
      ? 'primary'
      : action.variant ?? (index === 0 ? 'primary' : 'secondary'),
    disabled: !!pendingAction,
    loading: pendingAction === action.action,
    'data-testid': `session-error-action-${action.action}`,
  }));
}

export function SessionErrorNotice({
  resolution,
  onApply,
  onDismiss,
  pendingAction,
  dismissible = true,
}: SessionErrorNoticeProps) {
  const actions = mapNoticeActions(resolution, onApply, pendingAction);
  const dismissProps = dismissible
    ? { dismissible: true as const, onDismiss: onDismiss ?? (() => {}) }
    : { dismissible: false as const };

  return (
    <Notice
      tone={TONE_BY_CATEGORY[resolution.category]}
      title={resolution.title}
      actions={actions}
      {...dismissProps}
      data-testid="session-error-notice"
    >
      {resolution.body}
    </Notice>
  );
}
