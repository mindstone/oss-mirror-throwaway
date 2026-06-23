import { useEffect, useRef } from 'react';
import { Tooltip } from '@renderer/components/ui';
import type { CustomProvider, ModelProviderType } from '@shared/types';
import {
  LOCAL_INFERENCE_PRESETS,
  PROVIDER_PRESETS,
  type LocalInferencePreset,
} from '@shared/data/modelProviderPresets';
import styles from '../ProfileWizardDialog.module.css';

export interface ProviderStepProps {
  customProviders?: CustomProvider[];
  openRouterConnected: boolean;
  orphanedCustomProvider?: boolean;
  localInferenceEnabled?: boolean;
  onSelect: (
    providerType: Exclude<ModelProviderType, 'anthropic' | 'local'>,
    customProvider?: CustomProvider,
    localPreset?: LocalInferencePreset,
  ) => void;
}

type ProviderCardProps = {
  name: string;
  description: string;
  disabled?: boolean;
  tooltip?: string;
  testId: string;
  innerRef?: (node: HTMLButtonElement | null) => void;
  onClick: () => void;
};

function ProviderCard({
  name,
  description,
  disabled,
  tooltip,
  testId,
  innerRef,
  onClick,
}: ProviderCardProps) {
  const card = (
    <button
      type="button"
      className={styles.providerCard}
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      data-testid={testId}
      ref={innerRef}
    >
      <span className={styles.providerCardName}>{name}</span>
      <span className={styles.providerCardDescription}>{description}</span>
    </button>
  );

  if (tooltip) {
    return <Tooltip content={tooltip}>{card}</Tooltip>;
  }
  return card;
}

const PROVIDER_CARD_DESCRIPTIONS: Record<
  Exclude<ModelProviderType, 'anthropic' | 'other' | 'local'>,
  string
> = {
  openai: 'GPT models via your OpenAI API key.',
  google: 'Gemini models via Google AI Studio.',
  together: 'Open-source models (Llama, DeepSeek) at speed.',
  cerebras: 'Blazing-fast inference for Llama and friends.',
  openrouter: 'One account, many providers — Claude, GPT, Gemini, and more.',
};

const OTHER_CARD_DESCRIPTION =
  'OpenAI-compatible endpoint — LM Studio, vLLM, self-hosted gateways.';

export const ProviderStep = ({
  customProviders,
  openRouterConnected,
  orphanedCustomProvider,
  localInferenceEnabled = true,
  onSelect,
}: ProviderStepProps) => {
  const firstCardRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    // Focus the first card after mount (step-transition focus management).
    firstCardRef.current?.focus();
  }, []);

  const presetEntries = Object.entries(PROVIDER_PRESETS) as [
    Exclude<ModelProviderType, 'anthropic' | 'other' | 'local'>,
    (typeof PROVIDER_PRESETS)[keyof typeof PROVIDER_PRESETS],
  ][];

  return (
    <div className={styles.stepRoot} data-testid="settings-models-wizard-step-provider">
      {orphanedCustomProvider && (
        <div className={styles.banner} role="alert">
          This profile&rsquo;s custom provider is gone. Pick a new provider to continue.
        </div>
      )}
      <div className={styles.stepHeader}>Pick a provider to add a model from.</div>

      <div className={styles.providerGroup}>
        <div className={styles.providerGroupLabel}>Built-in providers</div>
        <div className={styles.providerGrid}>
          {presetEntries.map(([providerType, preset], index) => {
            const description = PROVIDER_CARD_DESCRIPTIONS[providerType];
            const disabled = providerType === 'openrouter' && !openRouterConnected;
            const tooltip = disabled
              ? 'Connect OpenRouter first (Settings → Connection).'
              : undefined;
            return (
              <ProviderCard
                key={providerType}
                name={preset.label}
                description={
                  disabled
                    ? 'Connect OpenRouter to add OpenRouter-routed models.'
                    : description
                }
                disabled={disabled}
                tooltip={tooltip}
                testId={`settings-models-wizard-provider-${providerType}`}
                innerRef={
                  index === 0
                    ? (node: HTMLButtonElement | null) => {
                        firstCardRef.current = node;
                      }
                    : undefined
                }
                onClick={() => onSelect(providerType)}
              />
            );
          })}
          <ProviderCard
            name="Other (OpenAI-compatible)"
            description={OTHER_CARD_DESCRIPTION}
            testId="settings-models-wizard-provider-other"
            onClick={() => onSelect('other')}
          />
        </div>
      </div>

      {localInferenceEnabled && (
        <div className={styles.providerGroup}>
          <div className={styles.providerGroupLabel}>Models on your machine</div>
          <div className={styles.providerGrid}>
            {LOCAL_INFERENCE_PRESETS.map((preset) => (
              <ProviderCard
                key={preset.presetKey}
                name={preset.label}
                description={preset.description}
                testId={`settings-models-wizard-local-preset-${preset.key}`}
                onClick={() => onSelect('other', undefined, preset)}
              />
            ))}
          </div>
        </div>
      )}

      {customProviders && customProviders.length > 0 && (
        <div className={styles.providerGroup}>
          <div className={styles.providerGroupLabel}>Your custom providers</div>
          <div className={styles.providerGrid}>
            {customProviders.map((cp) => (
              <ProviderCard
                key={cp.id}
                name={cp.name}
                description={cp.serverUrl}
                testId={`settings-models-wizard-provider-custom-${cp.id}`}
                onClick={() => onSelect('other', cp)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
