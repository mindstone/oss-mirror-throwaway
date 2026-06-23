/**
 * Meeting trigger detector — platform-agnostic detection orchestrator.
 *
 * Mirrors the trigger / stop / discard / high-signal / accumulation state
 * machine that lives inside `src/main/services/meetingBot/botQAService.ts`'s
 * `processTranscriptSegment`, minus the TTS / chat / pendingResponse / live
 * transcript persistence side-effects. The bot continues to own those.
 *
 * Stage 2a's behavioural characterisation corpus
 * (`evals/fixtures/meeting-trigger-detection-corpus/`) is the byte-equivalence
 * contract. Both this orchestrator and `botQAService` must satisfy the same
 * fixtures.
 *
 * Cross-surface goal: the cloud-side per-segment hook (Stage 3) and the
 * desktop-local-recording path (Stage 7) both consume this detector via
 * `ingestSegment`. The detector is dependency-injected with the LLM-based
 * semantic completion check so `src/core/` stays free of Electron / Pino /
 * Anthropic-client imports.
 */

import { randomUUID } from 'node:crypto';

import {
  matchesTrigger,
  matchesStopTrigger,
  matchesDiscardTrigger,
  type DetectorLogger,
} from './triggerPatterns';
import { extractQuestion } from './questionExtraction';
import { classifyHighSignalUtterance, type HighSignalType } from './highSignalClassifier';

export type { DetectorLogger } from './triggerPatterns';
export type { HighSignalType } from './highSignalClassifier';

/** Minimum silence (ms) before the LLM completion check is allowed to run. */
export const MIN_SILENCE_BEFORE_COMPLETION_CHECK = 400;

/** Maximum total accumulation duration (ms) before force-completing. */
export const MAX_QUERY_ACCUMULATION_TIME = 20_000;

/** Polling interval (ms) for the accumulation completion check. */
export const ACCUMULATION_CHECK_INTERVAL = 300;

/** Minimum words before running the (cost-bearing) LLM completion check. */
export const MIN_WORDS_FOR_LLM_CHECK = 2;

/** Silence (ms) at which we fall through and process the question even on errors. */
export const ERROR_FALLBACK_SILENCE = 1500;

export interface DetectorSegment {
  speaker: string;
  text: string;
  /** Segment timestamp; ms epoch. Used as the canonical timestamp for emitted events. */
  timestamp: number;
  /** Defaults to true. Non-final segments are ignored to avoid partial-transcript duplicates. */
  isFinal?: boolean;
}

export type DetectorEvent =
  | { kind: 'trigger'; extracted: string; speaker: string; timestamp: number }
  | { kind: 'stop'; speaker: string; timestamp: number }
  | { kind: 'discard'; speaker: string; timestamp: number }
  | { kind: 'high-signal'; type: HighSignalType; text: string; speaker: string; timestamp: number };

export type DetectorEventKind = DetectorEvent['kind'];

type DetectorEventListener<K extends DetectorEventKind> = (
  event: Extract<DetectorEvent, { kind: K }>,
) => void;

export interface MeetingTriggerDetectorConfig {
  ownerName: string;
  triggerPhrase: string | null;
  /**
   * Optional mode hint. Currently informational only; reserved for future
   * surface-specific behaviour (e.g. skipping high-signal emission on
   * surfaces that don't consume it).
   */
  mode?: 'voice-with-tts' | 'companion-only' | 'cloud-mobile';
  /**
   * Injected semantic completion check (typically a fast LLM call).
   * Returns true when the accumulated text reads as a complete question.
   * Required when callers expect `trigger` events; without it the
   * accumulation falls through to the silence/timeout fallbacks.
   */
  semanticCompletionCheck?: (text: string, signal: AbortSignal) => Promise<boolean>;
  /** Optional hook into bot speaking state. Used to gate filtering rules. */
  isSpeaking?: () => boolean;
  /** Optional hook: does the surrounding consumer have a pending response queued? */
  hasPendingResponse?: () => boolean;
  /** Optional clock for testability. Defaults to `Date.now`. */
  now?: () => number;
  /** Optional structured logger. Defaults to no-op. */
  logger?: DetectorLogger;
}

export interface MeetingTriggerDetector {
  /** Feed one finalised transcript segment through the detector. */
  ingestSegment(seg: DetectorSegment): void;
  on<K extends DetectorEventKind>(event: K, listener: DetectorEventListener<K>): void;
  off<K extends DetectorEventKind>(event: K, listener: DetectorEventListener<K>): void;
  hasPendingAccumulation(): boolean;
  getAccumulationSpeaker(): string | null;
  /**
   * Begin a fresh accumulation window directly (bypassing the segment
   * dispatch). Used by `botQAService` for the follow-up branch where the
   * extracted text is already known.
   */
  beginAccumulation(extractedQuestion: string, speaker: string, triggerTimestamp: number): void;
  /** Append text to the current accumulation buffer. */
  appendToAccumulation(text: string): void;
  /** Cancel the current accumulation (aborts in-flight completion check, clears timer). */
  cancelAccumulation(): void;
  /** Final cleanup — cancels accumulation, drops listeners, freezes the instance. */
  dispose(): void;
}

interface PendingQueryAccumulation {
  id: string;
  triggerTimestamp: number;
  segments: string[];
  fullText: string;
  lastSegmentAt: number;
  speaker: string;
  completionCheckInFlight: boolean;
  abortController: AbortController | null;
}

const noopLogger: DetectorLogger = {};

export function createMeetingTriggerDetector(
  config: MeetingTriggerDetectorConfig,
): MeetingTriggerDetector {
  const {
    ownerName,
    triggerPhrase,
    semanticCompletionCheck,
    isSpeaking = () => false,
    hasPendingResponse = () => false,
    now = () => Date.now(),
    logger = noopLogger,
  } = config;

  const listeners: { [K in DetectorEventKind]: Array<DetectorEventListener<K>> } = {
    'trigger': [],
    'stop': [],
    'discard': [],
    'high-signal': [],
  };

  let pendingAccumulation: PendingQueryAccumulation | null = null;
  let accumulationCheckTimer: ReturnType<typeof setInterval> | null = null;
  let disposed = false;

  function emit<K extends DetectorEventKind>(event: Extract<DetectorEvent, { kind: K }>): void {
    if (disposed) return;
    const list = listeners[event.kind] as Array<DetectorEventListener<K>>;
    for (const listener of [...list]) {
      try {
        listener(event);
      } catch (err) {
        logger.error?.({ error: err, kind: event.kind }, 'Detector listener threw');
      }
    }
  }

  function startAccumulationTimer(): void {
    if (accumulationCheckTimer) {
      clearInterval(accumulationCheckTimer);
    }
    accumulationCheckTimer = setInterval(() => {
      checkQueryCompletion().catch(err => {
        logger.error?.({ error: err }, 'Accumulation check failed');
      });
    }, ACCUMULATION_CHECK_INTERVAL);
  }

  function cancelAccumulationInternal(): void {
    if (pendingAccumulation?.abortController) {
      pendingAccumulation.abortController.abort();
    }
    pendingAccumulation = null;
    if (accumulationCheckTimer) {
      clearInterval(accumulationCheckTimer);
      accumulationCheckTimer = null;
    }
  }

  function beginAccumulationInternal(extractedQuestion: string, speaker: string, triggerTimestamp: number): void {
    if (pendingAccumulation) {
      cancelAccumulationInternal();
    }
    const currentTime = now();
    pendingAccumulation = {
      id: randomUUID(),
      triggerTimestamp,
      segments: [extractedQuestion],
      fullText: extractedQuestion,
      lastSegmentAt: currentTime,
      speaker,
      completionCheckInFlight: false,
      abortController: null,
    };
    startAccumulationTimer();
  }

  async function checkQueryCompletion(): Promise<void> {
    if (!pendingAccumulation) return;
    const acc = pendingAccumulation;
    const accumulationId = acc.id;
    const currentTime = now();
    const silenceDuration = currentTime - acc.lastSegmentAt;
    const totalDuration = currentTime - acc.triggerTimestamp;
    const wordCount = acc.fullText.trim().split(/\s+/).filter(w => w.length > 0).length;

    if (totalDuration >= MAX_QUERY_ACCUMULATION_TIME) {
      await processAccumulatedQuery('timeout', accumulationId);
      return;
    }

    if (silenceDuration < MIN_SILENCE_BEFORE_COMPLETION_CHECK) {
      return;
    }

    if (wordCount < MIN_WORDS_FOR_LLM_CHECK) {
      if (silenceDuration >= ERROR_FALLBACK_SILENCE) {
        await processAccumulatedQuery('short-query-timeout', accumulationId);
      }
      return;
    }

    if (acc.completionCheckInFlight) return;
    acc.completionCheckInFlight = true;

    const abortController = new AbortController();
    acc.abortController = abortController;

    const lastSegmentAtBeforeCheck = acc.lastSegmentAt;

    try {
      const isComplete = semanticCompletionCheck
        ? await semanticCompletionCheck(acc.fullText, abortController.signal)
        : false;

      const currentAcc = pendingAccumulation;
      if (!currentAcc || currentAcc.id !== accumulationId) return;

      if (currentAcc.lastSegmentAt !== lastSegmentAtBeforeCheck) {
        acc.completionCheckInFlight = false;
        acc.abortController = null;
        return;
      }

      if (isComplete) {
        await processAccumulatedQuery('semantic', accumulationId);
      } else {
        acc.completionCheckInFlight = false;
        acc.abortController = null;
      }
    } catch (error) {
      const currentAcc = pendingAccumulation;
      if (!currentAcc || currentAcc.id !== accumulationId) return;

      logger.warn?.({ error }, 'Semantic completion check failed');

      if (silenceDuration >= ERROR_FALLBACK_SILENCE) {
        await processAccumulatedQuery('error-fallback', accumulationId);
      } else {
        acc.completionCheckInFlight = false;
        acc.abortController = null;
      }
    }
  }

  async function processAccumulatedQuery(
    reason: 'semantic' | 'timeout' | 'error-fallback' | 'short-query-timeout',
    expectedAccumulationId: string,
  ): Promise<void> {
    if (!pendingAccumulation) return;
    if (pendingAccumulation.id !== expectedAccumulationId) return;

    const { fullText, speaker, triggerTimestamp } = pendingAccumulation;
    const trimmed = fullText.trim();
    const meaningfulContent = trimmed.replace(/[^\p{L}\p{N}\s]/gu, '').trim();
    const words = meaningfulContent.split(/\s+/).filter(w => w.length > 0);

    cancelAccumulationInternal();

    if (words.length === 0) {
      logger.info?.({ reason, text: trimmed }, 'Discarding trivial/empty question - no meaningful content');
      return;
    }

    emit({ kind: 'trigger', extracted: trimmed, speaker, timestamp: triggerTimestamp });
  }

  function ingestSegment(seg: DetectorSegment): void {
    if (disposed) return;
    if (seg.isFinal === false) return;

    const speaker = seg.speaker || 'Unknown';
    const text = seg.text;
    const segmentTimestamp = seg.timestamp;

    try {
      const speakerLower = speaker.toLowerCase();
      const isUnknownSpeaker = speakerLower === 'unknown' || !speaker;

      if (matchesStopTrigger(text, ownerName, triggerPhrase)) {
        logger.info?.({ text: text.slice(0, 50) }, 'Stop trigger detected');
        cancelAccumulationInternal();
        emit({ kind: 'stop', speaker, timestamp: segmentTimestamp });
        return;
      }

      const hasPendingExternal = hasPendingResponse();
      if (
        (pendingAccumulation || hasPendingExternal)
        && matchesDiscardTrigger(text, ownerName, triggerPhrase)
      ) {
        logger.info?.({
          text: text.slice(0, 50),
          hasPending: hasPendingExternal,
          isAccumulating: !!pendingAccumulation,
        }, 'Discard trigger detected');
        cancelAccumulationInternal();
        emit({ kind: 'discard', speaker, timestamp: segmentTimestamp });
        return;
      }

      const speaking = isSpeaking();
      if (isUnknownSpeaker && speaking) {
        return;
      }

      const ownerFirstName = ownerName?.split(/\s+/)[0]?.toLowerCase() || '';
      if (!isUnknownSpeaker && ownerFirstName) {
        const isOwnerSpeaking = new RegExp(`\\b${ownerFirstName}\\b`, 'i').test(speakerLower);

        if (!isOwnerSpeaking) {
          if (!speaking) {
            const highSignal = classifyHighSignalUtterance(text);
            if (highSignal) {
              emit({
                kind: 'high-signal',
                type: highSignal.type,
                text: text.slice(0, 200),
                speaker,
                timestamp: segmentTimestamp,
              });
            }
          }
          return;
        }
      }

      const triggered = matchesTrigger(text, ownerName, triggerPhrase, logger);

      if (pendingAccumulation && speaker === pendingAccumulation.speaker && !triggered) {
        pendingAccumulation.segments.push(text);
        pendingAccumulation.fullText += ' ' + text;
        pendingAccumulation.lastSegmentAt = now();
        return;
      }

      if (!triggered) return;

      if (pendingAccumulation) {
        cancelAccumulationInternal();
      }

      const extractedQuestion = extractQuestion(text, ownerName, triggerPhrase);
      beginAccumulationInternal(extractedQuestion, speaker, segmentTimestamp);
    } catch (err) {
      logger.warn?.({ error: err, text: text.slice(0, 100) }, 'Trigger detection failed, skipping segment');
    }
  }

  return {
    ingestSegment,
    on(kind, listener) {
      (listeners[kind] as Array<typeof listener>).push(listener);
    },
    off(kind, listener) {
      const list = listeners[kind] as Array<typeof listener>;
      const idx = list.indexOf(listener);
      if (idx >= 0) list.splice(idx, 1);
    },
    hasPendingAccumulation() {
      return !!pendingAccumulation;
    },
    getAccumulationSpeaker() {
      return pendingAccumulation?.speaker ?? null;
    },
    beginAccumulation: beginAccumulationInternal,
    appendToAccumulation(text: string) {
      if (!pendingAccumulation) return;
      pendingAccumulation.segments.push(text);
      pendingAccumulation.fullText += ' ' + text;
      pendingAccumulation.lastSegmentAt = now();
    },
    cancelAccumulation: cancelAccumulationInternal,
    dispose() {
      disposed = true;
      cancelAccumulationInternal();
      (Object.keys(listeners) as DetectorEventKind[]).forEach(kind => {
        listeners[kind].length = 0;
      });
    },
  };
}

export {
  escapeRegex,
  levenshteinDistance,
  getFuzzyThreshold,
  getTriggerPatterns,
  fuzzyMatchTrigger,
  matchesTrigger,
  getStopTriggerPatterns,
  fuzzyMatchStopTrigger,
  matchesStopTrigger,
  getDiscardTriggerPatterns,
  matchesDiscardTrigger,
} from './triggerPatterns';
export {
  stripLeadingPunctuation,
  isConfirmationPhrase,
  extractFollowUpAfterConfirmation,
  GO_AHEAD_IN_TEXT_RE,
  stripTriggerPrefix,
  extractQuestion,
} from './questionExtraction';
export { classifyHighSignalUtterance } from './highSignalClassifier';
