import { useEffect, useRef } from 'react';
import type { AgentTurnMessage, AgentEvent } from '@shared/types';

export type UseVoiceModeAutoSpeakOptions = {
  autoSpeak: boolean;
  currentSessionId: string;
  messages: AgentTurnMessage[];
  eventsByTurn: Record<string, AgentEvent[]>;
  speakText: (text: string) => Promise<void>;
};

/**
 * Automatically speaks new assistant messages when autoSpeak is enabled.
 * 
 * Key behavior:
 * - When autoSpeak is enabled, marks the current last message as "already handled"
 *   so existing messages are not spoken
 * - Only speaks NEW result messages that arrive after autoSpeak was enabled
 * - Resets tracking when autoSpeak is disabled
 * - On session switch, re-marks the last message as "already handled" to prevent
 *   speaking stale results from the newly loaded conversation
 */
export function useVoiceModeAutoSpeak({
  autoSpeak,
  currentSessionId,
  messages,
  eventsByTurn,
  speakText
}: UseVoiceModeAutoSpeakOptions): void {
  const lastSpokenMessageIdRef = useRef<string | null>(null);
  const prevAutoSpeakRef = useRef(autoSpeak);
  const prevSessionIdRef = useRef(currentSessionId);
  const spokenMessageIdsRef = useRef<Set<string>>(new Set());

  // Track autoSpeak activation/deactivation and session switches.
  // This effect MUST run before the speak effect due to React's effect ordering.
  useEffect(() => {
    const sessionChanged = currentSessionId !== prevSessionIdRef.current;

    // On session switch while autoSpeak is active, treat all existing messages
    // in the new session as "already handled" to avoid speaking stale results.
    if (sessionChanged && autoSpeak) {
      if (messages.length > 0) {
        lastSpokenMessageIdRef.current = messages[messages.length - 1].id;
      }
      spokenMessageIdsRef.current.clear();
    }

    // Detect autoSpeak activation (false -> true transition)
    if (autoSpeak && !prevAutoSpeakRef.current) {
      if (messages.length > 0) {
        lastSpokenMessageIdRef.current = messages[messages.length - 1].id;
      }
    }
    // Detect autoSpeak deactivation (true -> false transition)
    if (!autoSpeak && prevAutoSpeakRef.current) {
      lastSpokenMessageIdRef.current = null;
    }

    prevAutoSpeakRef.current = autoSpeak;
    prevSessionIdRef.current = currentSessionId;
  }, [autoSpeak, currentSessionId, messages]);

  // Speak new result messages when autoSpeak is enabled.
  // Track which message IDs we've already spoken to avoid duplicates.
  useEffect(() => {
    if (!autoSpeak || messages.length === 0) {
      return;
    }
    const lastMessage = messages[messages.length - 1];

    // Only speak final result messages (not intermediate assistant messages)
    if (lastMessage.role !== 'result') {
      return;
    }

    // Skip if we've already spoken this message
    if (spokenMessageIdsRef.current.has(lastMessage.id)) {
      return;
    }

    // Skip if this message existed before autoSpeak was enabled (or before session switch)
    if (lastMessage.id === lastSpokenMessageIdRef.current) {
      return;
    }

    // Skip TTS for stopped/aborted turns - these have empty result event text AND no output tokens
    // Agent mode stops: result has empty text and no usage field
    // Chat mode stops: result has empty text and usage with zero outputTokens
    // Normal completions: result has text content or positive outputTokens
    const turnEvents = eventsByTurn[lastMessage.turnId] ?? [];
    const resultEvent = turnEvents.find((e): e is Extract<AgentEvent, { type: 'result' }> => e.type === 'result');
    const hasOutput = resultEvent?.usage?.outputTokens && resultEvent.usage.outputTokens > 0;
    if (resultEvent && !resultEvent.text.trim() && !hasOutput) {
      return;
    }

    // Mark as spoken and trigger TTS
    spokenMessageIdsRef.current.add(lastMessage.id);
    void speakText(lastMessage.text);
  }, [autoSpeak, messages, eventsByTurn, speakText]);
}
