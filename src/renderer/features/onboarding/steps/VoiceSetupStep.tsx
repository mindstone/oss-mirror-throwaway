import { useMemo, useRef, useEffect } from 'react';
import { Mic, AudioLines, Info } from 'lucide-react';
import { Button, Select, Tooltip } from '@renderer/components/ui';
import { LocalSttModelSection } from '@renderer/features/settings/components/LocalSttModelSection';
import type { AppSettings } from '@shared/types';
import { VOICE_INPUT_LANGUAGES } from '@shared/data/voiceLanguages';
import { tracking } from '@renderer/src/tracking';
import styles from '../OnboardingWizard.module.css';
import type { VoiceSetupStepProps } from './types';

const VALIDATION_DEBOUNCE_MS = 500;

export const VoiceSetupStep = ({
  state,
  draftSettings,
  updateDraft,
  updateVoice,
  isValidatingOpenAI,
  openAiValidationMessage,
  openAiValidationOk,
  openAiValidationReason,
  validateOpenAiKey,
  clearOpenAiValidation,
  isValidatingElevenLabs,
  elevenLabsValidationMessage,
  elevenLabsValidationOk,
  validateElevenLabsKey,
  clearElevenLabsValidation,
  openPrefsAndPoll,
}: VoiceSetupStepProps) => {
  const { voiceProvider, microphoneStatus } = state;

  const openAiValidationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const elevenLabsValidationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (openAiValidationTimerRef.current) clearTimeout(openAiValidationTimerRef.current);
      if (elevenLabsValidationTimerRef.current) clearTimeout(elevenLabsValidationTimerRef.current);
    };
  }, []);

  const sortedLanguageOptions = useMemo(() => {
    const entries = Object.entries(VOICE_INPUT_LANGUAGES);
    const autoEntry = entries.find(([code]) => code === 'auto');
    const otherEntries = entries
      .filter(([code]) => code !== 'auto')
      .sort((a, b) => a[1].localeCompare(b[1]));
    return autoEntry ? [autoEntry, ...otherEntries] : otherEntries;
  }, []);

  const isLocalSupported =
    window.electronEnv?.platform === 'darwin' || window.electronEnv?.platform === 'win32';

  const isLocalActive = isLocalSupported && voiceProvider === 'local-parakeet';

  const providerLabel =
    voiceProvider === 'local-parakeet' ? 'Built-in' :
    voiceProvider === 'openai-whisper' || voiceProvider === 'elevenlabs-scribe' ? 'External' : '';

  const providerHint =
    voiceProvider === 'local-parakeet'
      ? 'Included with Rebel. Your voice stays on your device.'
      : voiceProvider === 'openai-whisper'
        ? 'Uses OpenAI as your external voice provider. Requires internet.'
        : voiceProvider === 'elevenlabs-scribe'
          ? 'Uses ElevenLabs as your external voice provider. Requires internet.'
          : '';

  const handleProviderChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const nextProvider = event.target.value as AppSettings['voice']['provider'];
    tracking.onboarding.voiceProviderSelected(nextProvider);
    updateVoice('provider', nextProvider);
    if (nextProvider === 'elevenlabs-scribe') {
      updateVoice('openaiApiKey', null);
      clearOpenAiValidation();
      if (!draftSettings.voice.model.startsWith('scribe')) {
        updateVoice('model', 'scribe_v2');
      }
    }
    if (nextProvider === 'openai-whisper') {
      updateVoice('elevenlabsApiKey', null);
      clearElevenLabsValidation();
      if (!draftSettings.voice.model.startsWith('gpt-')) {
        updateVoice('model', 'gpt-4o-mini-transcribe-2025-12-15');
      }
    }
    if (nextProvider === 'local-parakeet') {
      clearOpenAiValidation();
      clearElevenLabsValidation();
      updateVoice('model', 'parakeet-v3');
    }
  };

  return (
    <div className={styles.stepBody}>
      <div className={styles.stepTitleGroup}>
        <h2>Talk to Rebel</h2>
        <p className={styles.stepDescription}>
          Speak instead of type. Rebel listens and responds — no keyboard needed.
        </p>
      </div>

      {/* Microphone row */}
      <div className={styles.voiceSetupRow}>
        <div className={styles.voiceSetupRowIcon}>
          <Mic size={18} />
        </div>
        <div className={styles.voiceSetupRowContent}>
          <span className={styles.voiceSetupRowTitle}>Microphone</span>
          <span className={styles.voiceSetupRowSubtitle}>
            Rebel listens and transcribes in real time.
          </span>
        </div>
        <div className={styles.voiceSetupRowEnd}>
          {microphoneStatus === 'granted' ? (
            <span className={`${styles.voiceSetupRowStatus} ${styles.statusGranted}`}>Enabled</span>
          ) : microphoneStatus === 'checking' ? (
            <span className={`${styles.voiceSetupRowStatus} ${styles.statusChecking}`}>
              <span className={styles.spinner} />
              Checking…
            </span>
          ) : (
            <Button
              variant="outline"
              className={styles.smallButton}
              onClick={() => void openPrefsAndPoll('microphone')}
              aria-label="Enable microphone"
            >
              Enable
            </Button>
          )}
        </div>
      </div>

      {/* Voice model row — same visual treatment as microphone */}
      <div className={styles.voiceSetupRow}>
        <div className={styles.voiceSetupRowIcon}>
          <AudioLines size={18} />
        </div>
        <div className={styles.voiceSetupRowContent}>
          <span className={styles.voiceSetupRowTitle}>
            Voice model ({providerLabel})
            {isLocalActive && <span className={styles.claudeMaxRecommended}> (recommended)</span>}
          </span>
          <span className={styles.voiceSetupRowSubtitle}>
            {isLocalActive
              ? 'Your voice is processed on your device. Nothing is sent to a server.'
              : 'Powers Rebel\'s voice features'}
          </span>
        </div>
        <div className={styles.voiceSetupRowEnd}>
          {isLocalActive ? (
            <LocalSttModelSection variant="badge" />
          ) : (
            <span className={`${styles.voiceSetupRowStatus} ${styles.statusGranted}`}>Active</span>
          )}
        </div>
      </div>

      {/* Shared card for both accordions */}
      <div className={styles.voiceOptionsCard}>
        <details className={styles.accordionInCard}>
          <summary>Switch to external voice</summary>
          <div className={styles.accordionInner}>
            <div className={styles.fieldGroup}>
              <label htmlFor="onboarding-voice-provider">Voice option</label>
              <Select
                id="onboarding-voice-provider"
                value={voiceProvider}
                onChange={handleProviderChange}
                selectSize="sm"
              >
                {isLocalSupported && (
                  <option value="local-parakeet">Built-in - included with Rebel, voice stays on your device (recommended)</option>
                )}
                <option value="openai-whisper">OpenAI Whisper - external provider, requires internet</option>
                <option value="elevenlabs-scribe">ElevenLabs Scribe - external provider, requires internet</option>
              </Select>
              {providerHint && (
                <p className={styles.fieldHint}>
                  <Tooltip content={providerHint} maxWidth="260px">
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', cursor: 'help' }}>
                      <Info size={13} style={{ opacity: 0.6, flexShrink: 0 }} aria-hidden />
                      {providerHint}
                    </span>
                  </Tooltip>
                </p>
              )}
            </div>

            {voiceProvider === 'openai-whisper' && (
              <div className={styles.fieldGroup}>
                <label htmlFor="onboarding-openai-key">OpenAI API key</label>
                <input
                  id="onboarding-openai-key"
                  type="password"
                  value={draftSettings.voice.openaiApiKey ?? ''}
                  onChange={(event) => {
                    const sanitized = event.target.value.replace(/\s/g, '') || null;
                    updateVoice('openaiApiKey', sanitized);
                    updateDraft('providerKeys', { ...draftSettings.providerKeys, openai: sanitized });
                    if (openAiValidationTimerRef.current) clearTimeout(openAiValidationTimerRef.current);
                    if (sanitized) {
                      tracking.onboarding.voiceKeyEntered('openai-whisper');
                      openAiValidationTimerRef.current = setTimeout(() => {
                        void validateOpenAiKey(sanitized);
                      }, VALIDATION_DEBOUNCE_MS);
                    } else {
                      clearOpenAiValidation();
                    }
                  }}
                  placeholder="Paste your OpenAI API key (starts with sk-proj-...)"
                />
                {openAiValidationMessage &&
                  (isValidatingOpenAI ? (
                    <p className={styles.statusChecking}>
                      <span className={styles.spinner} /> {openAiValidationMessage}
                    </p>
                  ) : (
                    <p className={
                      openAiValidationOk
                        ? openAiValidationReason === 'quota_exceeded' ? styles.warnStatus : styles.okStatus
                        : styles.validationText
                    }>
                      {openAiValidationMessage}
                    </p>
                  ))}
              </div>
            )}

            {voiceProvider === 'elevenlabs-scribe' && (
              <div className={styles.fieldGroup}>
                <label htmlFor="onboarding-elevenlabs-key">ElevenLabs API key</label>
                <input
                  id="onboarding-elevenlabs-key"
                  type="password"
                  value={draftSettings.voice.elevenlabsApiKey ?? ''}
                  onChange={(event) => {
                    const sanitized = event.target.value.replace(/\s/g, '') || null;
                    updateVoice('elevenlabsApiKey', sanitized);
                    if (elevenLabsValidationTimerRef.current) clearTimeout(elevenLabsValidationTimerRef.current);
                    if (sanitized) {
                      tracking.onboarding.voiceKeyEntered('elevenlabs-scribe');
                      elevenLabsValidationTimerRef.current = setTimeout(() => {
                        void validateElevenLabsKey(sanitized);
                      }, VALIDATION_DEBOUNCE_MS);
                    } else {
                      clearElevenLabsValidation();
                    }
                  }}
                  placeholder="Paste your ElevenLabs API key"
                />
                {elevenLabsValidationMessage &&
                  (isValidatingElevenLabs ? (
                    <p className={styles.statusChecking}>
                      <span className={styles.spinner} /> {elevenLabsValidationMessage}
                    </p>
                  ) : (
                    <p className={elevenLabsValidationOk ? styles.okStatus : styles.validationText}>
                      {elevenLabsValidationMessage}
                    </p>
                  ))}
              </div>
            )}
          </div>
        </details>

        {(voiceProvider === 'local-parakeet' ||
          (voiceProvider === 'openai-whisper' && draftSettings.voice.openaiApiKey) ||
          (voiceProvider === 'elevenlabs-scribe' && draftSettings.voice.elevenlabsApiKey)) && (
          <>
            <div className={styles.voiceOptionsDivider} />
            <details className={styles.accordionInCard}>
              <summary>Spoken language</summary>
              <div className={styles.accordionInner}>
                <div className={styles.fieldGroup}>
                  <label htmlFor="onboarding-voice-input-language">Language</label>
                  <Select
                    id="onboarding-voice-input-language"
                    value={draftSettings.voice.voiceInputLanguage ?? 'auto'}
                    onChange={(event) => updateVoice('voiceInputLanguage', event.target.value)}
                    selectSize="sm"
                  >
                    {sortedLanguageOptions.map(([code, name]) => (
                      <option key={code} value={code}>
                        {name}
                      </option>
                    ))}
                  </Select>
                  <p className={styles.fieldHint}>Select your spoken language, or Auto to detect.</p>
                </div>
              </div>
            </details>
          </>
        )}
      </div>

      <p className={styles.hintText}>
        Voice is optional — you can always set up voice later in Settings.
      </p>
    </div>
  );
};
