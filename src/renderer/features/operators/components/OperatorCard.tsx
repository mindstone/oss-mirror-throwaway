import { type ReactNode, useState } from 'react';
import { AlertTriangle, BookOpen, Mic, Sparkles, UserRoundCog } from 'lucide-react';
import type { OperatorMetadata } from '@shared/ipc/channels/operators';
import { Badge, Button, InlineToggle, Select } from '@renderer/components/ui';
import styles from '../OperatorsPanel.module.css';
import { OperatorMoreMenu, type OperatorMoreMenuAction } from './OperatorMoreMenu';

export type OperatorCardState =
  | { kind: 'bundled' }
  | { kind: 'activated'; personalised: boolean; personalising: boolean };

export interface OperatorCardActivationTarget {
  sourceSpacePath: string;
  label: string;
  isChiefOfStaff?: boolean;
}

export interface OperatorCardProps {
  operator: OperatorMetadata;
  state: OperatorCardState;
  spaceLabel?: string;
  highlighted?: boolean;
  busyAction?: 'activate' | 'personalise' | 'instructions' | 'live-toggle' | 'rename' | 'duplicate' | 'remove' | null;
  activationTargets?: OperatorCardActivationTarget[];
  defaultActivationTargetSpacePath?: string;
  activationErrorMessage?: string | null;
  activationErrorDetails?: string | null;
  liveMeetingEnabled?: boolean;
  onActivate?: (targetSpacePath: string) => void;
  onPersonalise?: () => void;
  onOpenInstructions?: () => void;
  onToggleLiveMeeting?: (next: boolean) => void;
  onRename?: () => void;
  onDuplicate?: () => void;
  onHistory?: () => void;
  onRemove?: () => void;
}

function StateBadges({
  category,
  personalised,
  personalising,
  hasOperatorRole,
  hasLiveMeetingRole,
}: {
  category: 'bundled' | 'space';
  personalised: boolean;
  personalising: boolean;
  hasOperatorRole: boolean;
  hasLiveMeetingRole: boolean;
}): ReactNode {
  const isActivated = category === 'space';
  const isLiveCoachOnly = isActivated && hasLiveMeetingRole && !hasOperatorRole;

  return (
    <div className={styles.roleBadges} aria-label="Operator status badges">
      {category === 'bundled'
        ? <Badge variant="secondary" size="sm">Bundled</Badge>
        : <Badge variant="success" size="sm">Activated</Badge>}
      {isActivated && (
        <Badge
          variant={personalised ? 'success' : 'secondary'}
          size="sm"
        >
          {personalised ? 'Personalised' : 'Generic'}
        </Badge>
      )}
      {personalising && <Badge variant="warning" size="sm">Personalising…</Badge>}
      {hasOperatorRole && (
        <Badge variant="muted" size="sm">Operator</Badge>
      )}
      {hasLiveMeetingRole && (
        <Badge variant="info" size="sm">Live coach</Badge>
      )}
      {isLiveCoachOnly && (
        <Badge variant="muted" size="sm">Meeting-only</Badge>
      )}
    </div>
  );
}

export function OperatorCard({
  operator,
  state,
  spaceLabel,
  highlighted = false,
  busyAction = null,
  activationTargets = [],
  defaultActivationTargetSpacePath,
  activationErrorMessage = null,
  activationErrorDetails = null,
  liveMeetingEnabled = false,
  onActivate,
  onPersonalise,
  onOpenInstructions,
  onToggleLiveMeeting,
  onRename,
  onDuplicate,
  onHistory,
  onRemove,
}: OperatorCardProps): ReactNode {
  const isActivated = state.kind === 'activated';
  const personalised = isActivated && state.personalised;
  const personalising = isActivated && state.personalising;
  const disabled = busyAction !== null || personalising;
  const displayName = operator.displayName ?? operator.name;
  const hasOperatorRole = operator.roles.includes('operator');
  const hasLiveMeetingRole = operator.roles.includes('live_meeting');
  const consultWhen = operator.consult_when.trim();
  const description = operator.description.trim();

  const defaultTarget = defaultActivationTargetSpacePath
    ?? activationTargets.find((target) => target.isChiefOfStaff)?.sourceSpacePath
    ?? activationTargets[0]?.sourceSpacePath
    ?? '';
  const [selectedActivationTarget, setSelectedActivationTarget] = useState(defaultTarget);

  const moreMenuActions: OperatorMoreMenuAction[] = [];
  if (isActivated) {
    if (onRename) {
      moreMenuActions.push({ id: 'rename', label: 'Rename…', icon: 'rename', onSelect: onRename });
    }
    if (onDuplicate && hasOperatorRole) {
      moreMenuActions.push({ id: 'duplicate', label: 'Duplicate…', icon: 'duplicate', onSelect: onDuplicate });
    }
    if (onHistory && hasOperatorRole) {
      moreMenuActions.push({ id: 'history', label: 'History', icon: 'history', onSelect: onHistory });
    }
    if (onRemove) {
      moreMenuActions.push({
        id: 'remove',
        label: busyAction === 'remove' ? 'Removing…' : 'Remove',
        icon: 'remove',
        onSelect: onRemove,
        isDanger: true,
      });
    }
  }

  return (
    <article
      className={`${styles.operatorCard} ${highlighted ? styles.operatorCardHighlighted : ''}`.trim()}
      data-testid="operator-card"
      data-operator-id={operator.id}
      data-highlighted={highlighted ? 'true' : undefined}
      tabIndex={-1}
    >
      <header className={styles.cardHeader}>
        <div className={styles.operatorIdentity}>
          <div className={styles.operatorIcon} aria-hidden>
            <UserRoundCog size={18} />
          </div>
          <div className={styles.operatorIdentityCopy}>
            <div className={styles.cardTitleRow}>
              <h3 className={styles.cardTitle}>{displayName}</h3>
              {operator.displayName && operator.displayName !== operator.name && (
                <span className={styles.cardSubtitle}>Based on {operator.name}</span>
              )}
            </div>
            {spaceLabel && <span className={styles.spacePill}>{spaceLabel}</span>}
          </div>
        </div>
        {moreMenuActions.length > 0 && (
          <OperatorMoreMenu actions={moreMenuActions} buttonLabel={`More actions for ${displayName}`} />
        )}
      </header>

      <StateBadges
        category={operator.category}
        personalised={personalised}
        personalising={personalising}
        hasOperatorRole={hasOperatorRole}
        hasLiveMeetingRole={hasLiveMeetingRole}
      />

      {operator.warnings && operator.warnings.length > 0 && (
        <div
          className={styles.frontmatterWarning}
          data-testid="operator-card-frontmatter-warning"
          role="status"
        >
          <AlertTriangle size={14} aria-hidden />
          <span
            className={styles.frontmatterWarningLabel}
            title={operator.warnings.join('\n')}
          >
            Frontmatter warnings
          </span>
          <ul className={styles.frontmatterWarningList}>
            {operator.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      )}

      {description && (
        <p className={styles.cardDescription} data-testid="operator-card-description">{description}</p>
      )}

      {hasOperatorRole && consultWhen && (
        <p className={styles.consultWhen}>
          <span>Best when:</span> {consultWhen}
        </p>
      )}

      {state.kind === 'bundled' ? (
        <div className={styles.cardStateBlock}>
          {activationTargets.length > 0 ? (
            <div className={styles.activationRow}>
              <Select
                selectSize="sm"
                aria-label={`Choose Space for ${displayName}`}
                value={selectedActivationTarget}
                onChange={(event) => setSelectedActivationTarget(event.currentTarget.value)}
              >
                {activationTargets.map((target) => (
                  <option key={target.sourceSpacePath} value={target.sourceSpacePath}>
                    {target.label}
                  </option>
                ))}
              </Select>
              <Button
                size="sm"
                onClick={() => onActivate?.(selectedActivationTarget)}
                disabled={disabled || !selectedActivationTarget}
                data-testid="operator-activate-button"
              >
                <Sparkles size={14} />
                {busyAction === 'activate' ? 'Activating…' : 'Activate'}
              </Button>
            </div>
          ) : (
            <p className={styles.mutedText}>No user Spaces are available for activation yet.</p>
          )}
          {activationErrorMessage && (
            <div className={styles.activationError}>
              <p className={styles.errorText} data-testid="operator-activation-error-message">{activationErrorMessage}</p>
              {activationErrorDetails && (
                <details className={styles.errorDetails}>
                  <summary>Details</summary>
                  <code>{activationErrorDetails}</code>
                </details>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className={styles.cardStateBlock}>
          <div className={styles.cardActions}>
            {hasOperatorRole && onPersonalise && (
              <Button
                size="sm"
                variant="secondary"
                onClick={onPersonalise}
                disabled={disabled}
                data-testid="operator-personalise-button"
              >
                <Sparkles size={14} />
                {personalising
                  ? 'Personalising…'
                  : busyAction === 'personalise'
                    ? 'Starting…'
                    : personalised ? 'Re-personalise' : 'Personalise'}
              </Button>
            )}
            {onOpenInstructions && (
              <Button
                size="sm"
                variant="ghost"
                onClick={onOpenInstructions}
                disabled={disabled}
                data-testid="operator-instructions-button"
              >
                <BookOpen size={14} />
                Instructions
              </Button>
            )}
          </div>

          {onToggleLiveMeeting !== undefined && (
            <div className={styles.liveMeetingFooter}>
              <InlineToggle
                label={
                  <span className={styles.liveMeetingToggleLabel}>
                    <Mic size={14} aria-hidden />
                    Live meeting coach
                  </span>
                }
                checked={liveMeetingEnabled}
                onCheckedChange={onToggleLiveMeeting}
                disabled={disabled || busyAction === 'live-toggle'}
                data-testid="operator-live-toggle"
              />
            </div>
          )}
        </div>
      )}
    </article>
  );
}
