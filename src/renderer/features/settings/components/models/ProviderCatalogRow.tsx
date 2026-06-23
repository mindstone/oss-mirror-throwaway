import type { KeyboardEvent, ReactNode } from 'react';
import { useCallback, useRef } from 'react';
import { Badge, BillingBadge, Button, Tooltip } from '@renderer/components/ui';
import type { BillingSource } from '@shared/utils/billingSource';
import type { ThinkingEffort } from '@shared/types';
import { THINKING_LEVELS } from './profileHelpers';
import styles from './ProviderCatalogRow.module.css';

export interface ProviderCatalogRowProps {
  /** The underlying curated model. */
  model: { value: string; label: string };
  providerLabel: string;
  billingSource: BillingSource;
  description?: string;
  /** The currently-selected thinking effort. `undefined` renders the default. */
  effort: ThinkingEffort | undefined;
  /** Whether this model supports reasoning. When false, no segmented control. */
  reasoning?: boolean;
  /** Whether to show per-model thinking controls and the no-reasoning label. */
  showEffortControl?: boolean;
  /** Optional compact capability indicators for curated catalog rows. */
  capabilityBadges?: ReactNode;
  /** Connection-managed catalog rows stay visible and show team state here. */
  onTeam?: boolean;
  setupHint?: string;
  onRemoveFromTeam?: () => void;
  onEffortChange: (effort: ThinkingEffort) => void;
}

export const ProviderCatalogRow = ({
  model,
  providerLabel,
  billingSource,
  description,
  effort,
  reasoning,
  showEffortControl = true,
  capabilityBadges,
  onTeam,
  setupHint,
  onRemoveFromTeam,
  onEffortChange,
}: ProviderCatalogRowProps) => {
  const buttonRefs = useRef<Map<ThinkingEffort, HTMLButtonElement>>(new Map());

  const setButtonRef = useCallback(
    (value: ThinkingEffort) => (el: HTMLButtonElement | null) => {
      if (el) buttonRefs.current.set(value, el);
      else buttonRefs.current.delete(value);
    },
    [],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      const delta = event.key === 'ArrowRight' ? 1 : -1;
      const nextIndex =
        (index + delta + THINKING_LEVELS.length) % THINKING_LEVELS.length;
      const nextLevel = THINKING_LEVELS[nextIndex];
      if (!nextLevel) return;
      onEffortChange(nextLevel.value);
      const target = buttonRefs.current.get(nextLevel.value);
      target?.focus();
    },
    [onEffortChange],
  );

  return (
    <div
      className={styles.row}
      data-testid={`settings-models-catalog-row-${model.value}`}
    >
      <div className={styles.info}>
        {description ? (
          <Tooltip content={description} placement="top">
            <div className={styles.name} tabIndex={0}>{model.label}</div>
          </Tooltip>
        ) : (
          <div className={styles.name}>{model.label}</div>
        )}
        <div className={styles.metaLine}>
          <span className={styles.provider}>{providerLabel}</span>
          <BillingBadge source={billingSource} />
          {capabilityBadges && (
            <span className={styles.capabilities}>{capabilityBadges}</span>
          )}
        </div>
      </div>
      {onTeam ? (
        <div className={styles.teamActions}>
          <Badge variant="success" size="sm">On your team</Badge>
          {setupHint ? (
            <Badge variant="warning" size="sm">{setupHint}</Badge>
          ) : null}
          {onRemoveFromTeam ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={onRemoveFromTeam}
              data-testid={`settings-models-catalog-remove-${model.value}`}
            >
              Remove
            </Button>
          ) : null}
        </div>
      ) : showEffortControl && reasoning ? (
        <div
          className={styles.effortGroup}
          role="group"
          aria-label={`Thinking level for ${model.label}`}
        >
          {THINKING_LEVELS.map((level, index) => {
            const active = effort === level.value;
            return (
              <button
                key={level.value}
                ref={setButtonRef(level.value)}
                type="button"
                aria-pressed={active}
                className={active ? styles.effortButtonActive : styles.effortButton}
                onClick={() => onEffortChange(level.value)}
                onKeyDown={(event) => handleKeyDown(event, index)}
                data-testid={`settings-models-catalog-effort-${model.value}-${level.value}`}
              >
                {level.label}
              </button>
            );
          })}
        </div>
      ) : showEffortControl ? (
        <div className={styles.noReasoning} aria-label={`${model.label} does not support thinking levels`}>
          No reasoning
        </div>
      ) : null}
    </div>
  );
};
