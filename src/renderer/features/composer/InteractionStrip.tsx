import { memo, useCallback, useEffect, useMemo, useRef, type RefObject } from 'react';
import { Mic, Square, Users, Settings2 } from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import { Spinner, Tooltip } from '@renderer/components/ui';
import { useAudioInputDevice } from '../voice/hooks/useAudioInputDevice';
import { ComposerWithState, type ComposerWithStateProps, type ComposerHandle } from './ComposerWithState';
import { SessionSettingsMenu } from './SessionSettingsMenu';
import { FilesIndicatorButton } from './FilesIndicatorButton';
import { FinishLineButton } from './FinishLineButton';
import { FinishLineEditor } from './FinishLineEditor';
import { ComposerContextChip } from './components/ComposerContextChip';
import { PendingAudioPopover } from './PendingAudioPopover';
import type { ConversationFileSummary } from '@renderer/features/agent-session/hooks/useConversationFiles';
import styles from './InteractionStrip.module.css';

const FINISH_LINE_CHIP_MAX_CHARS = 40;

function truncateFinishLineForChip(value: string): string {
  if (value.length <= FINISH_LINE_CHIP_MAX_CHARS) return value;
  return `${value.slice(0, FINISH_LINE_CHIP_MAX_CHARS - 1).trimEnd()}…`;
}

const DOUBLE_CLICK_DELAY_MS = 250;

type InteractionStripProps = {
  isInsightSurface: boolean;
  isDiagnosticsSurface: boolean;
  isBusy: boolean;
  isStopping: boolean;
  processingTurnId: string | null;
  onStopActiveTurn: () => Promise<void> | void;
  composerRef: RefObject<ComposerHandle | null>;
  composerProps: ComposerWithStateProps;
  // Transcription mic props (external mic button)
  isTranscribing: boolean;
  isTranscribeProcessing: boolean;
  onToggleTranscription: () => void;
  /** Stop recording and send the transcript immediately (double-click flow). */
  onStopAndSend: () => void;
  /** Normalized audio level from 0 (silence) to 1 (loud), shown during recording */
  audioLevel?: number;
  // Speaker toggle props
  autoSpeak: boolean;
  onToggleAutoSpeak: () => void;
  // Private mode props
  privateMode?: boolean;
  onPrivateModeChange?: (enabled: boolean) => void;
  // Council mode props
  councilMode?: boolean;
  onCouncilModeChange?: (enabled: boolean) => void;
  councilModeAvailable?: boolean;
  councilModeDisabledTooltip?: string;
  // Auto-done toggle props
  autoDoneEnabled?: boolean;
  onToggleAutoDone?: (source?: 'click' | 'keyboard' | 'long_press' | 'menu') => void;
  /** Whether the conversation has messages (enables long-press to mark done now) */
  hasMessages?: boolean;
  /** Callback for long-press to mark done immediately */
  onMarkDoneNow?: () => void;
  // Toast for mode toggle education
  showToast?: (options: { title: string }) => void;
  /**
   * Whether the STT key/path is unavailable for the selected provider (gates the mic button).
   * For `openai-whisper`, Codex/ChatGPT Pro provides an STT fallback, so this remains `false`
   * when the active provider is Codex even without a standalone OpenAI key. See App.tsx
   * `sttKeyMissing` computation for the full rule.
   */
  sttKeyMissing?: boolean;
  /**
   * Whether the TTS key is missing for the selected provider (gates the speaker toggle).
   * TTS is strictly key-based; Codex does not provide a TTS fallback.
   */
  ttsKeyMissing?: boolean;
  /** Whether local STT model is not installed (only relevant for local-parakeet provider) */
  localModelMissing?: boolean;
  /** Whether local STT model is currently downloading */
  localModelDownloading?: boolean;
  /** Whether TTS is unavailable for the selected provider (e.g., local-parakeet) */
  ttsUnavailable?: boolean;
  /** Current voice provider name for tooltip display */
  voiceProviderLabel?: string;
  /** Callback to open settings (for voice key setup) */
  onOpenSettings?: () => void;
  /** Resolved model info for SessionSettingsMenu model row */
  modelInfo?: {
    workingModelName: string;
    thinkingModelName: string;
    thinkingInheritsFromWorking: boolean;
    hasAnyCustom: boolean;
    backgroundModelName: string;
    backgroundIsCustom: boolean;
  };
  /** Callback to navigate to Settings > AI & Models */
  onNavigateToModelSettings?: () => void;
  /** Aggregated file operations for the conversation (files indicator) */
  conversationFiles?: ConversationFileSummary;
  /** Callback to open a file from the files indicator */
  onOpenFile?: (path: string) => void;
  /** Core workspace directory for relative path display */
  coreDirectory?: string;
  /** Number of pending conversation annotations (shown in Send button label) */
  annotationCount?: number;
  /** Callback to send annotations + composer text as a combined message */
  onSendAnnotations?: () => void;
  /** Whether council review can be triggered (not busy, available, has messages, not already reviewed) */
  canRequestCouncilReview?: boolean;
  /** Callback to trigger a council review of the last response */
  onRequestCouncilReview?: () => void;
  /** Optional accessory content rendered directly above the input field */
  topAccessory?: React.ReactNode;
  /** When provided, replaces the composer text input area (e.g., with a question card) */
  composerOverride?: React.ReactNode;
  /** Current Finish line criterion for the conversation (null = unset). */
  finishLine?: string | null;
  /** Set or clear the Finish line criterion. `null` clears it. */
  onFinishLineChange?: (next: string | null) => void;
  /** Whether the Finish line editor is currently open. */
  isEditingFinishLine?: boolean;
  /** Toggle the Finish line editor open/closed. */
  onToggleEditFinishLine?: () => void;
};

const InteractionStripComponent = ({
  isInsightSurface,
  isDiagnosticsSurface,
  isBusy,
  processingTurnId,
  onStopActiveTurn,
  composerRef,
  composerProps,
  isTranscribing,
  isTranscribeProcessing,
  onToggleTranscription,
  onStopAndSend,
  audioLevel = 0,
  autoSpeak,
  onToggleAutoSpeak,
  privateMode = false,
  onPrivateModeChange,
  councilMode = false,
  onCouncilModeChange,
  councilModeAvailable = false,
  councilModeDisabledTooltip,
  autoDoneEnabled = false,
  onToggleAutoDone,
  hasMessages = false,
  onMarkDoneNow,
  showToast,
  sttKeyMissing = false,
  ttsKeyMissing = false,
  localModelMissing = false,
  localModelDownloading = false,
  ttsUnavailable = false,
  voiceProviderLabel,
  onOpenSettings,
  modelInfo,
  onNavigateToModelSettings,
  conversationFiles,
  onOpenFile,
  coreDirectory,
  annotationCount = 0,
  onSendAnnotations,
  canRequestCouncilReview = false,
  onRequestCouncilReview,
  topAccessory,
  composerOverride,
  finishLine = null,
  onFinishLineChange,
  isEditingFinishLine = false,
  onToggleEditFinishLine,
}: InteractionStripProps) => {
  const { deviceLabel } = useAudioInputDevice();
  const clickTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const canMarkDoneNow = !isBusy && hasMessages && !!onMarkDoneNow;

  // Handle mic button clicks with double-click detection while recording
  const handleMicClick = useCallback(() => {
    // Guard: block STARTING recording when key/model is missing (but always allow stopping)
    // Tooltip already informs the user; no navigation to avoid disruptive screen transitions
    if (!isTranscribing && (sttKeyMissing || localModelMissing)) {
      return;
    }

    if (!isTranscribing) {
      // Not recording: start immediately
      onToggleTranscription();
      return;
    }

    // Use delayed click to detect double-click
    if (clickTimeoutRef.current) {
      // Second click within delay = double-click -> stop and send
      clearTimeout(clickTimeoutRef.current);
      clickTimeoutRef.current = null;
      onStopAndSend();
    } else {
      // First click: wait to see if it's a double-click
      clickTimeoutRef.current = setTimeout(() => {
        clickTimeoutRef.current = null;
        // Single click confirmed -> just stop recording
        onToggleTranscription();
      }, DOUBLE_CLICK_DELAY_MS);
    }
  }, [isTranscribing, sttKeyMissing, localModelMissing, onToggleTranscription, onStopAndSend]);

  // Clear pending click timeout if recording stops externally (hotkey, error, etc.)
  // This prevents the "phantom stop" race where a stale timer affects a new recording
  useEffect(() => {
    if (!isTranscribing && clickTimeoutRef.current) {
      clearTimeout(clickTimeoutRef.current);
      clickTimeoutRef.current = null;
    }
  }, [isTranscribing]);

  // Cleanup timeout on unmount to prevent memory leaks / stale callbacks
  useEffect(() => {
    return () => {
      if (clickTimeoutRef.current) {
        clearTimeout(clickTimeoutRef.current);
      }
    };
  }, []);

  // Mic is "blocked" if key/model is missing AND not currently recording (allow stopping)
  // Declared early so it can be used in the escape hatch effect
  const micBlocked = (sttKeyMissing || localModelMissing) && !isTranscribing;

  const hasFinishLine = !!finishLine;
  const canEditFinishLine = !!onToggleEditFinishLine && !!onFinishLineChange;
  const handleFinishLineSave = useCallback(
    (next: string) => {
      const trimmed = next.trim();
      onFinishLineChange?.(trimmed.length > 0 ? trimmed : null);
      onToggleEditFinishLine?.();
    },
    [onFinishLineChange, onToggleEditFinishLine],
  );
  const handleFinishLineCancel = useCallback(() => {
    onToggleEditFinishLine?.();
  }, [onToggleEditFinishLine]);
  const handleFinishLineClear = useCallback(() => {
    onFinishLineChange?.(null);
    onToggleEditFinishLine?.();
  }, [onFinishLineChange, onToggleEditFinishLine]);
  const handleFinishLineChipRemove = useCallback(() => {
    onFinishLineChange?.(null);
  }, [onFinishLineChange]);

  const finishLineChip = useMemo(() => {
    if (!hasFinishLine || isEditingFinishLine || !finishLine) return null;
    const label = truncateFinishLineForChip(finishLine);
    return (
      <ComposerContextChip
        key="finish-line-chip"
        kind="finishLine"
        label={label}
        ariaLabel={`Finish line: ${finishLine}`}
        title={`Rebel stops when this is met.\n${finishLine}`}
        onRemove={onFinishLineChange ? handleFinishLineChipRemove : undefined}
      />
    );
  }, [hasFinishLine, isEditingFinishLine, finishLine, onFinishLineChange, handleFinishLineChipRemove]);

  const effectiveTopAccessory = (topAccessory || finishLineChip)
    ? (
      <>
        {topAccessory}
        {finishLineChip}
      </>
    )
    : undefined;

  const finishLineEditor = canEditFinishLine && isEditingFinishLine
    ? (
      <FinishLineEditor
        initialValue={finishLine ?? ''}
        onSave={handleFinishLineSave}
        onCancel={handleFinishLineCancel}
        onClear={handleFinishLineClear}
      />
    )
    : null;

  const effectiveComposerOverride = composerOverride ?? finishLineEditor ?? undefined;

  if (isInsightSurface || isDiagnosticsSurface) {
    return null;
  }

  // Merge stop-related and annotation props into composer props
  const composerPropsWithStop: ComposerWithStateProps = {
    ...composerProps,
    processingTurnId,
    onStopActiveTurn,
    annotationCount,
    onSendAnnotations,
  };

  // Mic button state classes
  const micButtonClassName = cn(
    styles.micButton,
    isTranscribing && styles.micButtonRecording,
    isTranscribeProcessing && styles.micButtonProcessing,
    micBlocked && styles.micButtonDisabled
  );

  const missingKeyTooltip = 'Voice API key not configured. Add one in Settings → Agents & Voice → Voice provider.';
  const missingModelTooltip = 'Local transcription model not downloaded. Download it in Settings → Agents & Voice → Voice & Audio.';
  const downloadingModelTooltip = 'Voice model downloading — you can type instead while it finishes.';

  const micBlockedNeedsSetup = micBlocked && !localModelDownloading;
  const micBlockedContent = micBlocked
    ? localModelDownloading
      ? downloadingModelTooltip
      : (
        <>
          <p className={styles.micTooltipText}>{localModelMissing ? missingModelTooltip : missingKeyTooltip}</p>
          <button type="button" className={styles.micTooltipButton} onClick={() => onOpenSettings?.()}>
            <Settings2 size={12} aria-hidden />
            Set up in settings
          </button>
        </>
      )
    : null;

  // Mic button label based on state
  const micLabel = micBlocked
    ? 'Voice input unavailable'
    : isTranscribeProcessing
      ? 'Processing voice input'
      : isTranscribing
        ? 'Stop recording'
        : 'Start voice input';
  // Build mic tooltip with device and provider info
  const micTooltipParts: string[] = [];
  if (deviceLabel) micTooltipParts.push(deviceLabel);
  if (voiceProviderLabel) micTooltipParts.push(voiceProviderLabel);
  const micIdleTooltip = micTooltipParts.length > 0 ? micTooltipParts.join(' • ') : 'Voice input';
  
  const micTooltip = micBlockedContent
    ?? (isTranscribing ? 'Enter or click to stop • Double-click to send' : micIdleTooltip);
  // Full UI
  return (
    <footer className={styles.recorderStrip} data-testid="interaction-strip">
      <div className={styles.body}>
        <div className={cn(styles.main, effectiveComposerOverride && styles.mainWithOverride)}>
          {/* Mic button - outside input on left */}
          <div className={styles.micButtonWrapper}>
            <Tooltip content={micTooltip} placement="top" delayShow={0} interactive={micBlockedNeedsSetup}>
              <button
                type="button"
                className={micButtonClassName}
                onClick={handleMicClick}
                disabled={isTranscribeProcessing}
                aria-label={micLabel}
                aria-disabled={micBlocked}
                aria-busy={isTranscribeProcessing}
                data-testid="unified-mic-button"
                style={{ '--audio-level': isTranscribing ? audioLevel : 0 } as React.CSSProperties}
              >
              {isTranscribeProcessing ? (
                <Spinner size="xs" decorative />
              ) : isTranscribing ? (
                <Square size={18} aria-hidden />
              ) : (
                <Mic size={20} aria-hidden />
              )}
              </button>
            </Tooltip>
            <PendingAudioPopover
              isTranscribing={isTranscribing}
              isTranscribeProcessing={isTranscribeProcessing}
              onOpenSettings={onOpenSettings}
            />
          </div>
          <div className={styles.composerColumn}>
            {effectiveTopAccessory && (
              <div className={styles.topAccessorySlot}>
                {effectiveTopAccessory}
              </div>
            )}
            {/* Input container — composer or question card override */}
            <div className={cn(styles.inputContainer, effectiveComposerOverride && styles.inputContainerOverride)}>
              {effectiveComposerOverride ?? (
                <div className={styles.panel}>
                  <ComposerWithState
                    ref={composerRef}
                    {...composerPropsWithStop}
                    chromeMode="embedded"
                  />
                </div>
              )}
            </div>
          </div>

          {/* Session controls */}
          <div className={styles.sessionControls}>
            {conversationFiles && (
              <FilesIndicatorButton
                files={conversationFiles}
                coreDirectory={coreDirectory}
                onOpenFile={onOpenFile}
              />
            )}
            {canEditFinishLine && onToggleEditFinishLine && (
              <FinishLineButton
                hasFinishLine={hasFinishLine}
                isEditing={isEditingFinishLine}
                onClick={onToggleEditFinishLine}
              />
            )}
            {canRequestCouncilReview && onRequestCouncilReview && (
              <Tooltip content="Second opinions from the council">
                <button
                  type="button"
                  className={styles.councilReviewButton}
                  onClick={onRequestCouncilReview}
                >
                  <Users size={14} />
                  <span>Review</span>
                </button>
              </Tooltip>
            )}
            <SessionSettingsMenu
              autoSpeak={autoSpeak}
              onToggleAutoSpeak={onToggleAutoSpeak}
              ttsKeyMissing={ttsKeyMissing}
              ttsUnavailable={ttsUnavailable}
              privateMode={privateMode}
              onPrivateModeChange={onPrivateModeChange}
              councilMode={councilMode}
              onCouncilModeChange={onCouncilModeChange}
              councilModeAvailable={councilModeAvailable}
              councilModeDisabledTooltip={councilModeDisabledTooltip}
              isBusy={isBusy}
              autoDoneEnabled={autoDoneEnabled}
              onToggleAutoDone={onToggleAutoDone}
              canMarkDoneNow={canMarkDoneNow}
              onMarkDoneNow={onMarkDoneNow}
              showToast={showToast}
              onOpenSettings={onOpenSettings}
              modelInfo={modelInfo}
              onNavigateToModelSettings={onNavigateToModelSettings}
            />
          </div>
        </div>
      </div>
    </footer>
  );
};

export const InteractionStrip = memo(InteractionStripComponent);
InteractionStrip.displayName = 'InteractionStrip';
