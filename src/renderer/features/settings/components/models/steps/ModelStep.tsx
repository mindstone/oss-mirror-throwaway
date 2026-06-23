import { useEffect, useRef } from 'react';
import { Badge } from '@renderer/components/ui';
import { PROVIDER_PRESETS, type ModelOption } from '@shared/data/modelProviderPresets';
import type { CustomProvider } from '@shared/types';
import type { WizardProviderType, WizardRolePreference } from '../useProfileWizard';
import styles from '../ProfileWizardDialog.module.css';

export interface ModelStepProps {
  providerType: WizardProviderType;
  customProvider?: CustomProvider;
  rolePreference?: WizardRolePreference;
  onSelectModel: (model: ModelOption) => void;
  onSelectTypeManually: () => void;
}

const FAST_MODEL_HINT = /\b(mini|nano|flash|haiku|fast|lite|small)\b/i;

/**
 * User-facing label per capability tier, matching the Settings → Models IA the
 * wizard is launched from. Keyed on the canonical `WizardRolePreference`
 * (`ModelRoleTier`) — the cheap tier is "Behind the Scenes", never the internal
 * 'background'/'fast' spelling.
 */
const ROLE_PREFERENCE_LABELS: Record<WizardRolePreference, string> = {
  working: 'Main work',
  thinking: 'Planner',
  background: 'Behind the Scenes',
};

function filterModelsByRole(
  models: readonly ModelOption[],
  rolePreference: WizardRolePreference | undefined,
): readonly ModelOption[] {
  if (!rolePreference || rolePreference === 'working') {
    return models;
  }

  if (rolePreference === 'thinking') {
    const reasoningModels = models.filter((model) => model.reasoning !== false);
    return reasoningModels.length > 0 ? reasoningModels : models;
  }

  const fastModels = models.filter((model) => {
    if (model.reasoning === false) return true;
    const haystack = `${model.label} ${model.value} ${model.description ?? ''}`;
    return FAST_MODEL_HINT.test(haystack);
  });
  return fastModels.length > 0 ? fastModels : models;
}

export const ModelStep = ({
  providerType,
  customProvider,
  rolePreference,
  onSelectModel,
  onSelectTypeManually,
}: ModelStepProps) => {
  const firstItemRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    // Focus the first preset after mount (step-transition focus management).
    firstItemRef.current?.focus();
  }, []);

  // Guard: this step should never render for providers without presets, but
  // handle it defensively.
  const preset =
    providerType !== 'other' && !customProvider
      ? PROVIDER_PRESETS[providerType]
      : undefined;
  const models = filterModelsByRole(preset?.models ?? [], rolePreference);

  const providerLabel = customProvider?.name ?? preset?.label ?? 'Provider';
  const roleLabel = rolePreference ? ROLE_PREFERENCE_LABELS[rolePreference] : null;

  return (
    <div className={styles.stepRoot} data-testid="settings-models-wizard-step-model">
      <div className={styles.stepHeader}>
        {roleLabel ? `Pick a ${roleLabel} model from ${providerLabel}.` : `Which ${providerLabel} model?`}
      </div>
      <div className={styles.modelList}>
        {models.map((model, index) => (
          <button
            key={model.value}
            type="button"
            className={styles.modelOption}
            onClick={() => onSelectModel(model)}
            data-testid={`settings-models-wizard-model-${model.value}`}
            ref={
              index === 0
                ? (node: HTMLButtonElement | null) => {
                    firstItemRef.current = node;
                  }
                : undefined
            }
          >
            <div className={styles.modelOptionContent}>
              <span className={styles.modelOptionLabel}>{model.label}</span>
              {model.description && (
                <span className={styles.modelOptionDescription}>{model.description}</span>
              )}
            </div>
            {model.reasoning === false && (
              <Badge variant="muted" size="sm">
                No reasoning
              </Badge>
            )}
          </button>
        ))}
        <button
          type="button"
          className={styles.typeManuallyRow}
          onClick={onSelectTypeManually}
          data-testid="settings-models-wizard-type-manually"
        >
          <div className={styles.modelOptionContent}>
            <span className={styles.modelOptionLabel}>Type it manually</span>
            <span className={styles.modelOptionDescription}>
              Paste any model ID this provider supports.
            </span>
          </div>
        </button>
      </div>
    </div>
  );
};
