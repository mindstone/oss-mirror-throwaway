import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Play, Square, Loader2, Check } from "lucide-react";
import { Button, Tooltip, Select } from "@renderer/components/ui";
import { ShortcutRecorder } from "../ShortcutRecorder";
import { LocalSttModelSection } from "../LocalSttModelSection";
import { CustomVoiceProfileSection } from "../CustomVoiceProfileSection";
import { SettingRow } from "../SettingRow";
import { SettingSection } from "../SettingSection";
import { DEFAULT_VOICE_ACTIVATION_HOTKEY } from "@shared/types";
import type { AppSettings } from "@shared/types";
import { VOICE_INPUT_LANGUAGES } from "@shared/data/voiceLanguages";
import { redactSensitiveString } from "@shared/utils/sentryRedaction";
import { getNextPreviewQuip } from "../../utils/voicePreviewQuips";
import styles from "../SettingsSurface.module.css";
import type { VoiceTabProps } from "./types";

/** Strip all whitespace from API key input (consistent with onboarding) */
const sanitizeApiKey = (value: string): string => value.replace(/\s/g, "");

/**
 * Parse newline-separated vocabulary input into a clean array.
 * Trims whitespace, removes empty lines, and deduplicates.
 */
const parseVocabulary = (input: string): string[] => {
  const lines = input
    .split(/[\n\r]+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  // Deduplicate while preserving order
  return [...new Set(lines)];
};

/**
 * Format vocabulary array back to newline-separated string for display.
 */
const formatVocabulary = (vocabulary: string[] | undefined): string => {
  return vocabulary?.join("\n") ?? "";
};

/**
 * Validate vocabulary terms for ElevenLabs constraints.
 * Returns counts of valid/invalid terms for UI feedback.
 */
const validateVocabularyForElevenLabs = (
  terms: string[],
): {
  valid: number;
  tooLong: number;
  tooManyWords: number;
  exceeds100: number;
} => {
  let valid = 0;
  let tooLong = 0;
  let tooManyWords = 0;

  for (const term of terms) {
    const trimmed = term.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.length > 50) {
      tooLong++;
    } else if (trimmed.split(/\s+/).length > 5) {
      tooManyWords++;
    } else {
      valid++;
    }
  }

  const exceeds100 = Math.max(0, valid - 100);
  return { valid: Math.min(valid, 100), tooLong, tooManyWords, exceeds100 };
};

export const VoiceTab = ({ draftSettings, updateVoice }: VoiceTabProps) => {
  // Local state for vocabulary textarea to allow free-form editing
  // Only parse and save to settings on blur
  const [vocabularyText, setVocabularyText] = useState(() =>
    formatVocabulary(draftSettings.voice.transcriptionVocabulary),
  );

  // Sync local state when settings change externally (e.g., reset)
  useEffect(() => {
    setVocabularyText(
      formatVocabulary(draftSettings.voice.transcriptionVocabulary),
    );
  }, [draftSettings.voice.transcriptionVocabulary]);

  // ElevenLabs API key validation state
  const [isValidatingElevenLabs, setIsValidatingElevenLabs] = useState(false);
  const [elevenLabsValidationMessage, setElevenLabsValidationMessage] =
    useState<string | null>(null);
  const [elevenLabsValidationOk, setElevenLabsValidationOk] = useState<
    boolean | null
  >(null);
  const elevenLabsRequestIdRef = useRef(0);
  const lastValidatedElevenLabsKeyRef = useRef<string | null>(null);
  const [codexConnected, setCodexConnected] = useState(false);

  useEffect(() => {
    window.codexApi
      ?.status()
      .then((s) => setCodexConnected(s.connected))
      .catch(() => {});
  }, []);

  const handleVocabularyBlur = useCallback(() => {
    const parsed = parseVocabulary(vocabularyText);
    updateVoice(
      "transcriptionVocabulary",
      parsed.length > 0 ? parsed : undefined,
    );
  }, [vocabularyText, updateVoice]);

  // Clear ElevenLabs validation state when switching away from that provider
  const prevVoiceProviderRef = useRef(draftSettings.voice.provider);
  useEffect(() => {
    if (prevVoiceProviderRef.current !== draftSettings.voice.provider) {
      if (prevVoiceProviderRef.current === "elevenlabs-scribe") {
        setIsValidatingElevenLabs(false);
        setElevenLabsValidationMessage(null);
        setElevenLabsValidationOk(null);
        lastValidatedElevenLabsKeyRef.current = null;
        elevenLabsRequestIdRef.current += 1;
      }
      prevVoiceProviderRef.current = draftSettings.voice.provider;
    }
  }, [draftSettings.voice.provider]);

  const validateElevenLabsKey = useCallback(
    async (apiKey: string | null | undefined) => {
      const key = apiKey ? sanitizeApiKey(apiKey) : "";
      if (!key) {
        setElevenLabsValidationMessage(null);
        setElevenLabsValidationOk(null);
        return;
      }
      if (
        lastValidatedElevenLabsKeyRef.current === key &&
        elevenLabsValidationOk !== null
      ) {
        return;
      }
      const requestId = ++elevenLabsRequestIdRef.current;
      setIsValidatingElevenLabs(true);
      setElevenLabsValidationMessage("Validating...");
      setElevenLabsValidationOk(null);
      try {
        const result = await window.settingsApi.validateElevenlabsKey({
          apiKey: key,
        });
        if (requestId !== elevenLabsRequestIdRef.current) return;
        lastValidatedElevenLabsKeyRef.current = key;
        setElevenLabsValidationMessage(
          result.ok
            ? "ElevenLabs key is valid."
            : result.message || "ElevenLabs key validation failed.",
        );
        setElevenLabsValidationOk(result.ok);
      } catch (error: unknown) {
        if (requestId !== elevenLabsRequestIdRef.current) return;
        const message =
          error instanceof Error
            ? redactSensitiveString(error.message)
            : "Validation failed.";
        setElevenLabsValidationMessage(message);
        setElevenLabsValidationOk(false);
      } finally {
        if (requestId === elevenLabsRequestIdRef.current) {
          setIsValidatingElevenLabs(false);
        }
      }
    },
    [elevenLabsValidationOk],
  );

  // Voice preview state
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);
  const [isPreviewPlaying, setIsPreviewPlaying] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioSourceRef = useRef<AudioBufferSourceNode | null>(null);

  const stopVoicePreview = useCallback(() => {
    if (audioSourceRef.current) {
      try {
        audioSourceRef.current.stop();
      } catch {
        // Already stopped
      }
      audioSourceRef.current = null;
    }
    setIsPreviewLoading(false);
    setIsPreviewPlaying(false);
  }, []);

  const playVoicePreview = useCallback(
    async (
      provider: "openai-whisper" | "elevenlabs-scribe",
      voiceId: string,
      apiKey: string | null,
    ) => {
      if (!apiKey) {
        setPreviewError("API key required to preview voice");
        return;
      }
      if (!voiceId) {
        setPreviewError("Select a voice to preview");
        return;
      }

      // Stop any current preview
      stopVoicePreview();
      setPreviewError(null);
      setIsPreviewLoading(true);

      try {
        const quip = getNextPreviewQuip();
        const audioData = await window.voiceApi.previewTts({
          text: quip,
          provider,
          voiceId,
          apiKey,
        });

        setIsPreviewLoading(false);

        if (!audioData || audioData.byteLength === 0) {
          throw new Error("No audio data received");
        }

        // Create or reuse AudioContext
        if (
          !audioContextRef.current ||
          audioContextRef.current.state === "closed"
        ) {
          audioContextRef.current = new AudioContext();
        }
        const ctx = audioContextRef.current;
        if (ctx.state === "suspended") {
          await ctx.resume();
        }

        const decoded = await ctx.decodeAudioData(audioData);
        const source = ctx.createBufferSource();
        source.buffer = decoded;
        source.connect(ctx.destination);
        audioSourceRef.current = source;

        source.onended = () => {
          audioSourceRef.current = null;
          setIsPreviewPlaying(false);
        };

        source.start(0);
        setIsPreviewPlaying(true);
      } catch (error) {
        const message =
          error instanceof Error
            ? redactSensitiveString(error.message)
            : "Preview failed";
        setPreviewError(message);
        setIsPreviewLoading(false);
        setIsPreviewPlaying(false);
      }
    },
    [stopVoicePreview],
  );

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopVoicePreview();
      if (audioContextRef.current) {
        void audioContextRef.current.close().catch(() => undefined);
        audioContextRef.current = null;
      }
    };
  }, [stopVoicePreview]);

  // Compute sorted language options: 'auto' first, then alphabetically by display name
  const sortedLanguageOptions = useMemo(() => {
    const entries = Object.entries(VOICE_INPUT_LANGUAGES);
    const autoEntry = entries.find(([code]) => code === "auto");
    const otherEntries = entries
      .filter(([code]) => code !== "auto")
      .sort((a, b) => a[1].localeCompare(b[1]));
    return autoEntry ? [autoEntry, ...otherEntries] : otherEntries;
  }, []);

  // Determine if the provider OpenAI key is set (for voice section hint)
  const hasProviderOpenAiKey = !!draftSettings.providerKeys?.openai?.trim();
  const voiceViaCodex = !hasProviderOpenAiKey && codexConnected;

  return (
    <SettingSection
      title="Voice & Audio"
      description="Choose capture providers and playback preferences."
      data-section="voiceAudio"
    >
      <SettingRow
        label="Voice provider"
        tooltip="Choose where Rebel transcribes audio and generates spoken previews. OpenAI and ElevenLabs use cloud APIs; Local keeps transcription on-device."
        htmlFor="voice-provider"
      >
        <Select
          id="voice-provider"
          value={draftSettings.voice.provider}
          onChange={(event) => {
            const newProvider = event.target
              .value as AppSettings["voice"]["provider"];
            updateVoice("provider", newProvider);
            // Clear any preview errors when switching providers
            setPreviewError(null);
            stopVoicePreview();
            if (newProvider === "elevenlabs-scribe") {
              if (!draftSettings.voice.model.includes("scribe")) {
                updateVoice("model", "scribe_v2");
              }
              // Reset TTS voice to ElevenLabs default (Rachel)
              updateVoice("ttsVoice", "21m00Tcm4TlvDq8ikWAM");
            } else if (newProvider === "openai-whisper") {
              if (draftSettings.voice.model.includes("scribe")) {
                updateVoice("model", "gpt-4o-mini-transcribe-2025-12-15");
              }
              // Reset TTS voice to OpenAI default (nova)
              updateVoice("ttsVoice", "nova");
            } else if (newProvider === "local-parakeet") {
              updateVoice("model", "parakeet-v3");
            }
          }}
        >
          <option value="openai-whisper">OpenAI Whisper</option>
          <option value="elevenlabs-scribe">ElevenLabs Scribe</option>
          {/* Local options available on macOS and Windows */}
          {(window.electronEnv?.platform === "darwin" ||
            window.electronEnv?.platform === "win32") && (
            <option value="local-parakeet">Local (Parakeet)</option>
          )}
          <option value="custom-openai">Custom (OpenAI-compatible)</option>
        </Select>
        {window.electronEnv?.platform === "linux" && (
          <p
            className={styles.modelConfigHint}
            style={{ marginTop: "4px", color: "var(--color-text-tertiary)" }}
          >
            Local transcription coming soon for Linux.
          </p>
        )}
      </SettingRow>

      {/* Local Parakeet provider settings */}
      {draftSettings.voice.provider === "local-parakeet" && (
        <div>
          <p
            style={{
              fontSize: "13px",
              color: "var(--color-text-secondary)",
              padding: "12px",
              background: "var(--color-bg-secondary)",
              borderRadius: "6px",
              marginBottom: "12px",
            }}
          >
            <strong>Local transcription</strong> processes your voice on-device
            using Parakeet V3. Your audio never leaves your computer.
            <br />
            <br />
            <span style={{ color: "var(--color-text-tertiary)" }}>
              Note: Text-to-speech is not available with local transcription.
              Rebel will respond with text only.
            </span>
          </p>
          <LocalSttModelSection />
        </div>
      )}

      {draftSettings.voice.provider === "openai-whisper" && (
        <>
          <SettingRow
            label="OpenAI API key"
            tooltip="Voice uses your shared OpenAI provider key, or your ChatGPT subscription if connected."
            description={
              hasProviderOpenAiKey
                ? "Using your OpenAI key from AI & Models > Providers."
                : voiceViaCodex
                  ? "Using your ChatGPT subscription for voice."
                  : "Set your OpenAI key in AI & Models > Providers, or connect your ChatGPT account in AI & Models."
            }
          >
            <span
              style={{
                fontSize: "12px",
                color:
                  hasProviderOpenAiKey || voiceViaCodex
                    ? "var(--color-success)"
                    : "var(--color-text-muted)",
              }}
            >
              {hasProviderOpenAiKey
                ? "Connected"
                : voiceViaCodex
                  ? "ChatGPT"
                  : "Not set"}
            </span>
          </SettingRow>
          <SettingRow label="OpenAI Model" htmlFor="openai-model">
            <Select
              id="openai-model"
              value={draftSettings.voice.model ?? undefined}
              onChange={(event) => updateVoice("model", event.target.value)}
            >
              <option value="gpt-4o-mini-transcribe-2025-12-15">
                gpt-4o-mini-transcribe (recommended)
              </option>
            </Select>
          </SettingRow>
          <SettingRow label="Text-to-Speech voice" htmlFor="openai-tts-voice">
            <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
              <Select
                id="openai-tts-voice"
                value={draftSettings.voice.ttsVoice ?? "nova"}
                onChange={(event) =>
                  updateVoice("ttsVoice", event.target.value)
                }
                wrapperStyle={{ flex: 1, minWidth: 0 }}
              >
                <option value="alloy">Alloy</option>
                <option value="echo">Echo</option>
                <option value="fable">Fable</option>
                <option value="onyx">Onyx</option>
                <option value="nova">Nova</option>
                <option value="shimmer">Shimmer</option>
              </Select>
              <Tooltip
                content={
                  voiceViaCodex && !hasProviderOpenAiKey
                    ? "TTS preview requires an OpenAI API key."
                    : isPreviewPlaying
                      ? "Stop preview"
                      : "Preview voice"
                }
              >
                <span style={{ display: "inline-flex", flexShrink: 0 }}>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      if (isPreviewPlaying) {
                        stopVoicePreview();
                      } else {
                        void playVoicePreview(
                          "openai-whisper",
                          draftSettings.voice.ttsVoice ?? "nova",
                          draftSettings.providerKeys?.openai ??
                            draftSettings.voice.openaiApiKey,
                        );
                      }
                    }}
                    disabled={
                      !(
                        draftSettings.providerKeys?.openai ||
                        draftSettings.voice.openaiApiKey
                      ) || isPreviewLoading
                    }
                    style={{ flexShrink: 0 }}
                  >
                    {isPreviewLoading ? (
                      <Loader2 size={16} className="animate-spin" />
                    ) : isPreviewPlaying ? (
                      <Square size={16} />
                    ) : (
                      <Play size={16} />
                    )}
                  </Button>
                </span>
              </Tooltip>
            </div>
            {previewError &&
              draftSettings.voice.provider === "openai-whisper" && (
                <p
                  style={{
                    fontSize: "12px",
                    color: "var(--color-error)",
                    marginTop: "4px",
                  }}
                >
                  {previewError}
                </p>
              )}
          </SettingRow>
        </>
      )}

      {draftSettings.voice.provider === "custom-openai" && (
        <CustomVoiceProfileSection
          voiceSettings={draftSettings.voice}
          sharedOpenAiKey={draftSettings.providerKeys?.openai ?? null}
          updateVoice={updateVoice}
        />
      )}

      {draftSettings.voice.provider === "elevenlabs-scribe" && (
        <>
          <SettingRow
            label="ElevenLabs API key"
            tooltip="Required for ElevenLabs transcription and text-to-speech previews."
            htmlFor="elevenlabs-key"
            variant="stacked"
          >
            <input
              id="elevenlabs-key"
              type="password"
              value={draftSettings.voice.elevenlabsApiKey ?? ""}
              onChange={(event) => {
                const sanitized = sanitizeApiKey(event.target.value) || null;
                updateVoice("elevenlabsApiKey", sanitized);
                if (sanitized !== lastValidatedElevenLabsKeyRef.current) {
                  setElevenLabsValidationMessage(null);
                  setElevenLabsValidationOk(null);
                  elevenLabsRequestIdRef.current += 1;
                }
              }}
              onBlur={() =>
                void validateElevenLabsKey(draftSettings.voice.elevenlabsApiKey)
              }
              placeholder="Your ElevenLabs API key"
            />
            {elevenLabsValidationMessage && (
              <p
                className={
                  isValidatingElevenLabs
                    ? styles.modelConfigHint
                    : elevenLabsValidationOk
                      ? styles.successMessage
                      : styles.errorMessage
                }
                style={{
                  marginTop: "4px",
                  display: "flex",
                  alignItems: "center",
                  gap: "4px",
                }}
              >
                {isValidatingElevenLabs ? (
                  <Loader2 size={12} className={styles.spinnerIcon} />
                ) : elevenLabsValidationOk ? (
                  <Check size={12} />
                ) : null}
                {elevenLabsValidationMessage}
              </p>
            )}
          </SettingRow>
          <SettingRow label="ElevenLabs Model" htmlFor="elevenlabs-model">
            <select
              id="elevenlabs-model"
              value={draftSettings.voice.model ?? undefined}
              onChange={(event) => updateVoice("model", event.target.value)}
            >
              <option value="scribe_v2">scribe_v2 (latest, best)</option>
            </select>
          </SettingRow>
          <SettingRow
            label="Text-to-Speech voice"
            htmlFor="elevenlabs-tts-voice"
          >
            <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
              <select
                id="elevenlabs-tts-voice"
                value={
                  [
                    "21m00Tcm4TlvDq8ikWAM",
                    "EXAVITQu4vr4xnSDxMaL",
                    "MF3mGyEYCl7XYWbV9V6O",
                    "TxGEqnHWrfWFTfGW9XjX",
                    "VR6AewLTigWG4xSOukaG",
                    "pNInz6obpgDQGcFmaJgB",
                    "yoZ06aMxZJJ28mfd3POQ",
                    "nPczCjzI2devNBz1zQrb",
                    "onwK4e9ZLuTAKqWW03F9",
                  ].includes(draftSettings.voice.ttsVoice ?? "")
                    ? (draftSettings.voice.ttsVoice ?? undefined)
                    : draftSettings.voice.ttsVoice
                      ? "custom"
                      : "21m00Tcm4TlvDq8ikWAM"
                }
                onChange={(event) => {
                  if (event.target.value === "custom") {
                    updateVoice("ttsVoice", "");
                  } else {
                    updateVoice("ttsVoice", event.target.value);
                  }
                }}
                style={{ flex: 1 }}
              >
                <option value="21m00Tcm4TlvDq8ikWAM">Rachel (Default)</option>
                <option value="EXAVITQu4vr4xnSDxMaL">Sarah</option>
                <option value="MF3mGyEYCl7XYWbV9V6O">Elli</option>
                <option value="TxGEqnHWrfWFTfGW9XjX">Josh</option>
                <option value="VR6AewLTigWG4xSOukaG">Arnold</option>
                <option value="pNInz6obpgDQGcFmaJgB">Adam</option>
                <option value="yoZ06aMxZJJ28mfd3POQ">Sam</option>
                <option value="nPczCjzI2devNBz1zQrb">Brian</option>
                <option value="onwK4e9ZLuTAKqWW03F9">Daniel</option>
                <option value="custom">Custom voice ID...</option>
              </select>
              <Tooltip
                content={isPreviewPlaying ? "Stop preview" : "Preview voice"}
              >
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    if (isPreviewPlaying) {
                      stopVoicePreview();
                    } else {
                      const voiceId =
                        draftSettings.voice.ttsVoice || "21m00Tcm4TlvDq8ikWAM";
                      void playVoicePreview(
                        "elevenlabs-scribe",
                        voiceId,
                        draftSettings.voice.elevenlabsApiKey,
                      );
                    }
                  }}
                  disabled={
                    !draftSettings.voice.elevenlabsApiKey || isPreviewLoading
                  }
                  style={{ flexShrink: 0 }}
                >
                  {isPreviewLoading ? (
                    <Loader2 size={16} className="animate-spin" />
                  ) : isPreviewPlaying ? (
                    <Square size={16} />
                  ) : (
                    <Play size={16} />
                  )}
                </Button>
              </Tooltip>
            </div>
            {previewError &&
              draftSettings.voice.provider === "elevenlabs-scribe" && (
                <p
                  style={{
                    fontSize: "12px",
                    color: "var(--color-error)",
                    marginTop: "4px",
                  }}
                >
                  {previewError}
                </p>
              )}
          </SettingRow>
          {/* Show custom voice ID input when "Custom" is selected or when a non-preset ID is set */}
          {(draftSettings.voice.ttsVoice === "" ||
            (draftSettings.voice.ttsVoice &&
              ![
                "21m00Tcm4TlvDq8ikWAM",
                "EXAVITQu4vr4xnSDxMaL",
                "MF3mGyEYCl7XYWbV9V6O",
                "TxGEqnHWrfWFTfGW9XjX",
                "VR6AewLTigWG4xSOukaG",
                "pNInz6obpgDQGcFmaJgB",
                "yoZ06aMxZJJ28mfd3POQ",
                "nPczCjzI2devNBz1zQrb",
                "onwK4e9ZLuTAKqWW03F9",
              ].includes(draftSettings.voice.ttsVoice))) && (
            <SettingRow
              label="Custom voice ID"
              htmlFor="elevenlabs-custom-voice-id"
              variant="stacked"
            >
              <input
                id="elevenlabs-custom-voice-id"
                type="text"
                value={draftSettings.voice.ttsVoice ?? ""}
                onChange={(event) =>
                  updateVoice("ttsVoice", event.target.value || null)
                }
                placeholder="e.g. 21m00Tcm4TlvDq8ikWAM"
              />
              <p
                style={{
                  fontSize: "12px",
                  color: "var(--color-text-muted)",
                  marginTop: "4px",
                }}
              >
                Find voice IDs in your{" "}
                <a
                  href="https://elevenlabs.io/app/voice-lab"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: "var(--color-accent)" }}
                >
                  ElevenLabs Voice Lab
                </a>{" "}
                (click ... then Copy voice ID).
              </p>
            </SettingRow>
          )}
        </>
      )}

      <SettingRow
        label="Voice input language"
        description="Select your spoken language, or Auto to detect."
        htmlFor="voice-input-language"
      >
        <select
          id="voice-input-language"
          value={draftSettings.voice.voiceInputLanguage ?? "auto"}
          onChange={(event) =>
            updateVoice("voiceInputLanguage", event.target.value)
          }
        >
          {sortedLanguageOptions.map(([code, name]) => (
            <option key={code} value={code}>
              {name}
            </option>
          ))}
        </select>
      </SettingRow>

      {(draftSettings.voice.provider === "openai-whisper" ||
        draftSettings.voice.provider === "elevenlabs-scribe" ||
        draftSettings.voice.provider === "custom-openai") && (
        <SettingRow
          label="Custom vocabulary"
          tooltip="Add names, acronyms, and technical terms to improve transcription accuracy."
          description="Enter words or phrases that speech recognition often gets wrong (one per line). Names, technical terms, acronyms work well."
          htmlFor="transcription-vocabulary"
          variant="stacked"
        >
          <textarea
            id="transcription-vocabulary"
            value={vocabularyText}
            onChange={(e) => setVocabularyText(e.target.value)}
            onBlur={handleVocabularyBlur}
            rows={4}
            style={{
              resize: "vertical",
              minHeight: "80px",
            }}
          />
          {draftSettings.voice.provider === "elevenlabs-scribe" &&
            (() => {
              const parsed = parseVocabulary(vocabularyText);
              const validation = validateVocabularyForElevenLabs(parsed);
              const hasWarnings =
                validation.tooLong > 0 ||
                validation.tooManyWords > 0 ||
                validation.exceeds100 > 0;
              return (
                <p
                  style={{
                    fontSize: "12px",
                    color: hasWarnings
                      ? "var(--color-warning)"
                      : "var(--color-text-muted)",
                    marginTop: "4px",
                  }}
                >
                  {validation.valid} of {parsed.length} terms valid
                  {validation.tooLong > 0 &&
                    ` · ${validation.tooLong} too long (max 50 chars)`}
                  {validation.tooManyWords > 0 &&
                    ` · ${validation.tooManyWords} too many words (max 5)`}
                  {validation.exceeds100 > 0 &&
                    ` · ${validation.exceeds100} over limit (max 100)`}
                  {!hasWarnings &&
                    parsed.length > 0 &&
                    " · ElevenLabs max: 100 terms, 50 chars, 5 words each"}
                </p>
              );
            })()}
        </SettingRow>
      )}

      <SettingRow label="Global voice activation hotkey" htmlFor="voice-hotkey">
        <ShortcutRecorder
          value={draftSettings.voice.activationHotkey ?? null}
          onChange={(next) => updateVoice("activationHotkey", next)}
          placeholder={DEFAULT_VOICE_ACTIVATION_HOTKEY}
        />
      </SettingRow>
      <SettingRow
        label="After the hotkey sends..."
        tooltip="Choose what happens after your hotkey sends the recording: continue with spoken replies, or return to text-only responses."
        description="Turn this on if you want Rebel to continue in Voice Mode with spoken answers; turn it off to keep responses as on-screen text."
        htmlFor="voice-hotkey-mode"
      >
        <input
          id="voice-hotkey-mode"
          type="checkbox"
          checked={draftSettings.voice.activationHotkeyVoiceMode}
          onChange={(event) =>
            updateVoice("activationHotkeyVoiceMode", event.target.checked)
          }
        />
      </SettingRow>

      <SettingRow
        label="In-conversation voice shortcut"
        description="Toggle voice recording in the current conversation without starting a new one. Only active when a conversation is visible."
        htmlFor="inline-voice-hotkey"
      >
        <ShortcutRecorder
          value={draftSettings.voice.inlineVoiceHotkey ?? null}
          onChange={(next) => updateVoice("inlineVoiceHotkey", next)}
          placeholder="Not set"
        />
      </SettingRow>
    </SettingSection>
  );
};
