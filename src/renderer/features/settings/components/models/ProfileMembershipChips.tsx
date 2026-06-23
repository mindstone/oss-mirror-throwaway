import { Button, Tooltip } from '@renderer/components/ui';
import type { KeyboardEvent } from 'react';
import { COUNCIL_MANAGED_NO_BYOK_TOOLTIP } from '@shared/utils/councilProfiles';
import styles from './ProfileTable.module.css';

export type ProfileMembershipDisabledReason =
  | 'companyManaged'
  | 'profileDisabled'
  | 'turnInFlight'
  | 'orphanedProvider'
  | 'managedNoBYOK';

export interface ProfileMembershipChipsProps {
  councilEnabled?: boolean;
  routingEligible?: boolean;
  disabledReason?: ProfileMembershipDisabledReason | null;
  passive?: boolean;
  passiveTooltip?: string;
  onToggleCouncil: () => void;
  onToggleSmartPicking: () => void;
  testIdPrefix?: string;
}

const COUNCIL_TOOLTIP = 'Joins parallel discussions when you ask for a council.';
const SMART_PICKING_TOOLTIP = 'May be picked for individual steps in plan mode.';

function disabledTooltip(reason: ProfileMembershipDisabledReason): string {
  switch (reason) {
    case 'companyManaged':
      return 'Managed by your company. Contact your admin to change.';
    case 'profileDisabled':
      return 'Enable this profile first.';
    case 'turnInFlight':
      return 'Edits apply to your next turn.';
    case 'orphanedProvider':
      return 'Fix this profile’s provider first.';
    case 'managedNoBYOK':
      return COUNCIL_MANAGED_NO_BYOK_TOOLTIP;
  }
}

export function ProfileMembershipChips({
  councilEnabled = false,
  routingEligible = false,
  disabledReason = null,
  passive = false,
  passiveTooltip,
  onToggleCouncil,
  onToggleSmartPicking,
  testIdPrefix = 'profile-membership',
}: ProfileMembershipChipsProps) {
  return (
    <span className={styles.badgeGroup} data-testid={`${testIdPrefix}-chips`}>
      <MembershipChip
        label="Council"
        pressed={councilEnabled}
        tooltip={passiveTooltip ?? COUNCIL_TOOLTIP}
        disabledReason={disabledReason}
        passive={passive}
        onToggle={onToggleCouncil}
        testId={`${testIdPrefix}-council`}
      />
      <MembershipChip
        label="Smart picking"
        pressed={routingEligible}
        tooltip={passiveTooltip ?? SMART_PICKING_TOOLTIP}
        disabledReason={disabledReason}
        passive={passive}
        onToggle={onToggleSmartPicking}
        testId={`${testIdPrefix}-smart-picking`}
      />
    </span>
  );
}

interface MembershipChipProps {
  label: string;
  pressed: boolean;
  tooltip: string;
  disabledReason: ProfileMembershipDisabledReason | null;
  passive: boolean;
  onToggle: () => void;
  testId: string;
}

function MembershipChip({
  label,
  pressed,
  tooltip,
  disabledReason,
  passive,
  onToggle,
  testId,
}: MembershipChipProps) {
  const disabled = Boolean(disabledReason);
  const tooltipContent = disabledReason ? disabledTooltip(disabledReason) : tooltip;
  const ariaLabel = disabled
    ? `${label} membership disabled — ${tooltipContent}`
    : pressed
      ? `Remove from ${label}`
      : `Add to ${label}`;
  const className = [
    styles.membershipChip,
    pressed ? styles.membershipChipOn : styles.membershipChipOff,
    disabled ? styles.membershipChipDisabled : '',
  ]
    .filter(Boolean)
    .join(' ');

  if (passive) {
    return (
      <Tooltip content={tooltip} delayShow={0}>
        <span
          className={`${className} ${styles.membershipChipPassive}`}
          tabIndex={0}
          aria-label={`${label}: ${pressed ? 'included' : 'not included'}`}
          data-testid={testId}
        >
          {label}
        </span>
      </Tooltip>
    );
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    onToggle();
  };

  if (disabled) {
    return (
      <Tooltip content={tooltipContent} delayShow={0}>
        <span
          tabIndex={0}
          className={styles.membershipChipDisabledWrap}
          role="button"
          aria-disabled="true"
          aria-label={ariaLabel}
          data-testid={testId}
        >
          <Button
            type="button"
            variant={pressed ? 'secondary' : 'outline'}
            size="xs"
            className={className}
            disabled
            tabIndex={-1}
            aria-hidden="true"
          >
            {label}
          </Button>
        </span>
      </Tooltip>
    );
  }

  return (
    <Tooltip content={tooltip} delayShow={0}>
      <Button
        type="button"
        variant={pressed ? 'secondary' : 'outline'}
        size="xs"
        className={className}
        aria-pressed={pressed}
        aria-label={ariaLabel}
        onClick={onToggle}
        onKeyDown={handleKeyDown}
        data-testid={testId}
      >
        {label}
      </Button>
    </Tooltip>
  );
}
