/**
 * Meeting Bot Q&A Service
 * 
 * Handles question answering for the meeting bot:
 * - Polls chat messages for triggers
 * - Detects voice triggers from transcript
 * - Queries knowledge base via headless Rebel agent turn
 * - Responds via TTS (voice) or chat
 */

import { createScopedLogger } from '@core/logger';
import { getBroadcastService } from '@core/broadcastService';
import type { OperatorRegistry } from '@core/services/operatorRegistry';
import * as operatorRegistry from '@core/services/operatorRegistry';
import { getSettings } from '@core/services/settingsStore';
import {
  GO_AHEAD_IN_TEXT_RE,
  createMeetingTriggerDetector,
  extractFollowUpAfterConfirmation,
  extractQuestion,
  isConfirmationPhrase,
  matchesDiscardTrigger,
  matchesStopTrigger,
  matchesTrigger,
  stripTriggerPrefix,
  type MeetingTriggerDetector,
} from '@core/services/meetingTriggerDetector';
export { classifyHighSignalUtterance } from '@core/services/meetingTriggerDetector';
import { speakInMeeting, setAvatarState, stopSpeaking } from './botVoiceService';
import { getActiveBotState } from './meetingBotRuntimeRegistry';
import {
  registerSetBotSpeakingState,
  registerShouldAbortSpeaking,
} from './botSpeakingStateRegistry';
import { getMeetingVoiceInstructions } from '@core/services/meetingVoiceService';
import {
  meetingBotBackendConfigMissingLogContext,
  resolveMeetingBotBackendConfig,
} from '@core/services/meetingBotBackendConfig';
import { getBackendAuthHeader } from './backendAuth';
import { callBehindTheScenesWithAuth } from '../behindTheScenesClient';
import { randomUUID } from 'node:crypto';
import type { AgentEvent } from '@shared/types';
import type { HeadlessTurnOptions } from '@core/types/headlessTurnOptions';
import {
  saveLiveTranscript,
  appendToLiveTranscript,
  type LiveTranscriptSegment,
  type LiveTranscriptData,
  type ChatMessage,
} from './transcriptStorage';
import { updateLiveTranscriptPath, getPendingTranscript } from './pendingTranscriptsStore';
import { formatMeetingContext, type ConversationState } from './conversationStateService';
import {
  MEETING_TRIGGER_DETECTED_CHANNEL,
  type MeetingTriggerDetectedPayload,
} from '@shared/ipc/channels/meetingTrigger';
import { hashSessionId } from '@shared/trackingTypes';
import { resolveMeetingCoachPrompt } from '../meetingCoachPromptResolver';
import { fireAndForget } from '@shared/utils/fireAndForget';

const log = createScopedLogger({ service: 'bot-qa' });

// Dependency injection for headless agent turn
export type BotQADeps = {
  runHeadlessTurn: (params: {
    prompt: string;
    onEvent: (event: AgentEvent) => void;
    options: HeadlessTurnOptions;
  }) => Promise<void>;
  getConversationState: (botId: string) => ConversationState | null;
  /** Report whether a proactive contribution was spoken or ignored (for adaptive frequency) */
  onProactiveOutcome?: (botId: string, spoken: boolean) => void;
  onHighSignalUtterance?: (botId: string, triggerType: string, utteranceExcerpt: string) => void;
};

let deps: BotQADeps | null = null;

const meetingCoachOperatorRegistry: OperatorRegistry = {
  listAvailable: operatorRegistry.listAvailable,
  listAvailableWithDiagnostics: operatorRegistry.listAvailableWithDiagnostics,
  getById: operatorRegistry.getById,
  invalidate: operatorRegistry.invalidateOperatorRegistry,
};

/**
 * Initialize the Q&A service with dependencies
 */
export function initializeBotQAService(dependencies: BotQADeps): void {
  deps = dependencies;
  log.info('Bot Q&A service initialized');
}

// Transcript segment with pre-computed word count for efficient trimming
interface TranscriptSegment {
  speaker: string;
  text: string;
  timestamp: number;
  wordCount: number;
}

// Max transcript buffer size (in words) - roughly 20k tokens / ~60-90 minutes
const MAX_TRANSCRIPT_WORDS = 15000;

// Minimum speaking time before trigger-based interrupts are honored (prevents accidental interrupts).
// Note: the stop trigger ("stop Spark") always works immediately regardless of this grace period.
const MIN_SPEAKING_BEFORE_INTERRUPT_MS = 8000; // 8 seconds

// Sustained overlap threshold — how long a participant must continuously speak
// over a proactive contribution before we yield. Previous value (3s) was too aggressive
// and caused multi-chunk TTS to get interrupted between chunks when conversation
// continued normally. Set high so the bot finishes its response unless someone is
// genuinely trying to talk over it for an extended period.
const MIN_OVERLAP_BEFORE_YIELD_MS = 15_000; // 15 seconds of sustained overlap

// =============================================================================
// Semantic Query Accumulation Constants
// =============================================================================

// Minimum silence before checking completion (ms)
const MIN_SILENCE_BEFORE_COMPLETION_CHECK = 400;

// Maximum time to wait for query completion (ms)
const MAX_QUERY_ACCUMULATION_TIME = 20000; // 20 seconds

// Polling interval for completion checks (ms) - single timer approach
const ACCUMULATION_CHECK_INTERVAL = 300;

// Minimum words before running LLM check (skip for very short/empty queries)
const MIN_WORDS_FOR_LLM_CHECK = 2;

// Silence threshold for error fallback (ms)
const ERROR_FALLBACK_SILENCE = 1500;

// Live transcript persistence interval (ms) - write to disk every 30 seconds
const LIVE_TRANSCRIPT_PERSIST_INTERVAL = 30000;

// Per-bot write lock to prevent concurrent writes (following savesInProgress pattern)
const writesInProgress = new Set<string>();

// Pending response waiting to be spoken
interface PendingResponse {
  text: string;
  question: string;
  sender: string;
  readyAt: number;
  source: 'qa' | 'proactive';
  // Quality gate metadata for UI preview
  scores?: { relevance: number; helpfulness: number; timing: number } | null;
  triggerType?: string;
  triggerExcerpt?: string;
  // Topic context at queue time (for staleness detection)
  queuedTopic?: string;
}

// How long a proactive contribution can sit pending before staleness checks kick in
const STALENESS_CHECK_AGE_MS = 60_000; // 60 seconds

// Minimum word overlap ratio to consider two topics "same enough"
const TOPIC_DRIFT_THRESHOLD = 0.3;

/**
 * Check whether the conversation topic has drifted since a contribution was queued.
 * Uses word overlap between the stored topic and current topic.
 * Words shorter than 4 chars are filtered (articles, prepositions, etc.).
 */
function topicHasDrifted(oldTopic: string | undefined, currentTopic: string | undefined): boolean {
  if (!oldTopic || !currentTopic) return false;
  if (oldTopic === currentTopic) return false;

  const extractWords = (t: string) => new Set(t.toLowerCase().split(/\s+/).filter(w => w.length > 3));
  const oldWords = extractWords(oldTopic);
  const currentWords = extractWords(currentTopic);
  if (oldWords.size === 0 || currentWords.size === 0) return false;

  let overlap = 0;
  for (const word of oldWords) {
    if (currentWords.has(word)) overlap++;
  }

  const overlapRatio = overlap / Math.max(oldWords.size, currentWords.size);
  return overlapRatio < TOPIC_DRIFT_THRESHOLD;
}

/**
 * Get the minimum score from a quality gate score set.
 */
function minScore(scores: { relevance: number; helpfulness: number; timing: number }): number {
  return Math.min(scores.relevance, scores.helpfulness, scores.timing);
}

// Pending query accumulation state (for semantic turn detection)
interface PendingQueryAccumulation {
  id: string;                    // Unique ID to detect stale async callbacks
  triggerTimestamp: number;      // When trigger was first detected
  segments: string[];            // Accumulated text segments
  fullText: string;              // Combined text for LLM check
  lastSegmentAt: number;         // Timestamp of last segment received
  speaker: string;               // Who asked the question (only accumulate from this speaker)
  completionCheckInFlight: boolean; // Prevent concurrent LLM checks
  abortController: AbortController | null; // To cancel in-flight Haiku calls
}

export type BotQAOutputMode = 'bot-with-tts' | 'companion-only-question-listening' | 'silent';

// Q&A state per bot
interface BotQAState {
  botId: string;
  ownerName: string;
  triggerPhrase: string | null;
  knowledgeAccessEnabled: boolean;
  respondViaVoice: boolean;
  chatPollTimer: ReturnType<typeof setInterval> | null;
  lastChatTimestamp: string | null;
  questionsAnswered: number;
  maxQuestionsPerMeeting: number;
  /** Transcript buffering remains enabled even when trigger output is silent (coaching engine input). */
  bufferOnly: boolean;
  outputMode: BotQAOutputMode;
  triggerSessionId: string;
  // Transcript accumulation for context-aware Q&A
  transcriptBuffer: TranscriptSegment[];
  transcriptWordCount: number;
  // Speaking state for interrupt handling
  isSpeaking: boolean;
  speakingStartedAt: number | null; // Timestamp when speaking began
  abortSpeaking: boolean;
  speakingSource: PendingResponse['source'] | null; // What type of response is currently being spoken
  overlapDetectedAt: number | null; // When participant overlap was first noticed during proactive speech
  // Ready-to-speak state (Phase 2)
  pendingResponse: PendingResponse | null;
  triggerDetector: MeetingTriggerDetector | null;
  // Semantic query accumulation state
  pendingQueryAccumulation: PendingQueryAccumulation | null;
  accumulationCheckTimer: ReturnType<typeof setInterval> | null;
  // Live transcript persistence (never trimmed, written to disk every 30s)
  persistenceBuffer: TranscriptSegment[];
  lastPersistedIndex: number;
  liveFilePath: string | null;
  persistenceTimer: ReturnType<typeof setInterval> | null;
  // Chat message persistence (accumulated from polling, written to live transcript)
  chatBuffer: ChatMessage[];
}

const botQAStates = new Map<string, BotQAState>();

export function getChatBuffer(botId: string): ChatMessage[] {
  const state = botQAStates.get(botId);
  return state?.chatBuffer ?? [];
}

/**
 * Get the effective bot display name (used for triggers and meeting display)
 */
export function getBotDisplayName(ownerName: string, triggerPhrase: string | null): string {
  if (triggerPhrase?.trim()) {
    return triggerPhrase.trim();
  }
  const firstName = ownerName.split(/\s+/)[0] || 'User';
  return `${firstName}'s Rebel`;
}

/**
 * Post a chat message to the meeting
 */
interface PostChatResult {
  success: boolean;
  rateLimited?: boolean;
  error?: string;
}

function resolveBackendUrlForChat(botId: string): string | null {
  const config = resolveMeetingBotBackendConfig();
  if (!config.configured) {
    log.error(
      { ...meetingBotBackendConfigMissingLogContext(config.missing), botId },
      'Meeting bot backend config missing; refusing chat backend request',
    );
    return null;
  }
  return config.url;
}

async function postChatMessage(botId: string, message: string): Promise<PostChatResult> {
  const backendUrl = resolveBackendUrlForChat(botId);
  if (!backendUrl) return { success: false, error: 'Meeting bot backend not configured' };

  const authHeader = getBackendAuthHeader();
  if (!authHeader) return { success: false, error: 'Not authenticated' };

  try {
    const response = await fetch(`${backendUrl}/api/bot/${botId}/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Mindstone-Auth': authHeader,
      },
      body: JSON.stringify({ message }),
    });

    if (response.status === 429) {
      const data = await response.json().catch(() => ({})) as { error?: string };
      log.warn({ botId }, 'Chat message rate limited');
      return { success: false, rateLimited: true, error: data.error || 'Rate limit exceeded' };
    }

    if (!response.ok) {
      log.warn({ botId, status: response.status }, 'Failed to post chat message');
      return { success: false, error: `Request failed: ${response.status}` };
    }

    return { success: true };
  } catch (error) {
    log.error({ botId, error }, 'Failed to post chat message');
    return { success: false, error: 'Network error' };
  }
}

/**
 * Get chat messages from the meeting
 */
export async function fetchChatMessagesFromBackend(botId: string): Promise<Array<{ text: string; sender: string; timestamp: string }>> {
  const backendUrl = resolveBackendUrlForChat(botId);
  if (!backendUrl) return [];

  const authHeader = getBackendAuthHeader();
  if (!authHeader) {
    log.warn({ botId }, 'No auth header for chat messages');
    return [];
  }

  const url = `${backendUrl}/api/bot/${botId}/chat`;
  log.debug({ botId }, 'Fetching chat messages');
  
  try {
    const response = await fetch(url, {
      headers: {
        'X-Mindstone-Auth': authHeader,
      },
    });

    if (!response.ok) {
      const text = await response.text();
      log.warn({ botId, status: response.status, body: text }, 'Chat fetch returned error');
      return [];
    }

    const data = await response.json() as { 
      success: boolean; 
      messages: Array<{ 
        text: string; 
        sender: { name: string | null }; 
        timestamp: string;  // Original message timestamp from Recall
        created_at: string; // When we stored it
      }> 
    };
    if (!data.success) {
      log.warn({ botId, data }, 'Chat response not successful');
      return [];
    }

    return (data.messages || []).map(m => ({
      text: m.text,
      sender: m.sender?.name || 'Unknown',
      timestamp: m.timestamp || m.created_at, // Prefer original timestamp
    }));
  } catch (error) {
    log.error({ botId, error }, 'Failed to get chat messages');
    return [];
  }
}

/**
 * Answer a question using only the meeting transcript context.
 * Uses a fast, lightweight LLM call (Haiku) for responsive meeting UX.
 * Returns null if LLM call fails (caller should fallback to defer message).
 */
async function answerFromTranscript(
  botId: string,
  question: string,
  senderName: string,
  ownerName: string,
  transcriptBuffer: TranscriptSegment[]
): Promise<string | null> {
  const settings = getSettings();
  
  // Snapshot buffer to avoid mutation during async call
  const bufferSnapshot = [...transcriptBuffer];
  const transcript = formatTranscriptForPrompt(bufferSnapshot);
  const participants = getParticipantsFromTranscript(bufferSnapshot);
  const meetingContext = buildMeetingContextWarning(ownerName, participants);
  const meetingContextBlock = deps ? formatMeetingContext(deps.getConversationState(botId)) : '';
  const meetingContextSection = meetingContextBlock ? `${meetingContextBlock}\n\n` : '';

  // PRIVACY-GUARD: the bullet below covers 6 categories that the
  // botqa-transcript eval treats as load-bearing safety contracts (salary,
  // performance, medical, personal info, confidential deals, termination).
  // Even when the transcript contains the info, the LLM must redirect rather
  // than disclose. Do not soften or remove this rule without re-running
  // `npx tsx evals/botqa-transcript.ts --category privacy --runs 3` and
  // mirroring the change in evals/botqa-transcript.ts. See
  // docs/plans/260504_fix_ci_failures.md § Stage 3.
  const prompt = `You are answering a question in a live meeting based on what's been discussed so far.

${getMeetingVoiceInstructions()}

${meetingContext}

${meetingContextSection}[MEETING TRANSCRIPT]
${transcript}
[/MEETING TRANSCRIPT]

QUESTION from ${senderName}: "${question}"

Instructions:
- Answer based ONLY on what was said in this meeting transcript
- Keep your response concise (1-3 sentences) - it will be spoken aloud
- If the topic wasn't discussed in the transcript, say "That hasn't come up yet"
- Don't make up information not in the transcript
- Privacy guard: if the question concerns salary, compensation, performance reviews, medical or health information, personal contact details, confidential deals, or termination/firing, ALWAYS redirect privately. Do NOT repeat the topic, summarize what was said, or hint at the reason — even if it is in the transcript. Reply with just: "I'd rather share that privately — talk with ${ownerName} after the meeting."`;

  try {
    log.info({ question, senderName, transcriptLength: bufferSnapshot.length }, 'Answering from transcript via Haiku');
    
    const response = await callBehindTheScenesWithAuth(
      settings,
      {
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 1024,
        timeout: 8000, // 8s timeout for meeting responsiveness
      },
      {
        category: 'meeting-qa',
      }
    );
    
    const answer = response.content[0]?.text?.trim() ?? null;
    if (answer) {
      log.info({ question, answer: answer.slice(0, 100) }, 'Got answer from transcript');
    }
    return answer;
  } catch (error) {
    log.warn({ error, question }, 'Failed to answer from transcript, falling back to defer');
    return null;
  }
}

/**
 * Query knowledge base for an answer using a headless Rebel agent turn.
 * The agent has access to all user's spaces, tools, and knowledge.
 * Includes meeting transcript context if available.
 * Optionally includes coach skill context for coached Q&A.
 */
async function queryKnowledgeBase(
  botId: string,
  question: string,
  ownerName: string,
  senderName: string,
  transcriptBuffer: TranscriptSegment[] = [],
  coachSkillContent?: string
): Promise<string | null> {
  if (!deps) {
    log.warn('Bot Q&A service not initialized - cannot query knowledge base');
    return null;
  }

  // Snapshot buffer for transcript context
  const bufferSnapshot = [...transcriptBuffer];
  const transcriptContext = bufferSnapshot.length > 0
    ? `\n[MEETING TRANSCRIPT - for context]\n${formatTranscriptForPrompt(bufferSnapshot)}\n[/MEETING TRANSCRIPT]\n\n`
    : '';
  
  // Build meeting privacy context warning
  const participants = getParticipantsFromTranscript(bufferSnapshot);
  const meetingContext = buildMeetingContextWarning(ownerName, participants);
  const meetingContextBlock = formatMeetingContext(deps.getConversationState(botId));
  const meetingContextSection = meetingContextBlock ? `\n${meetingContextBlock}\n\n` : '';

  log.info({ question, ownerName, senderName, hasTranscript: bufferSnapshot.length > 0, participantCount: participants.length, hasCoach: !!coachSkillContent }, 'Querying knowledge base via Rebel agent');
  
  // Build coach context if available
  const coachContext = coachSkillContent
    ? `\n[COACH SKILL - Apply this coaching approach]\n${coachSkillContent}\n[/COACH SKILL]\n\n`
    : '';

  // Build prompt for the agent - optimized to work with system prompt (avoids redundancy)
  const hasTranscript = bufferSnapshot.length > 0;
  const prompt = `**MEETING Q&A MODE**

${ownerName} is in a live meeting and triggered you to answer a question.

${getMeetingVoiceInstructions()}
${coachContext}${meetingContext}
${meetingContextSection}${transcriptContext}**QUESTION:** ${question}

**Response requirements:**
- Your response will be spoken aloud in front of other participants - do not reveal sensitive or personal information unless ${ownerName} explicitly asks for it
- Keep it conversational since it will be spoken
- Search ${ownerName}'s spaces and memory for relevant information
- Look for related prior sessions, meetings, or conversations that may be relevant
- If useful, rebel_meetings_find_prep can retrieve meeting prep materials
- You can ask a brief clarifying question if the request is ambiguous
- Answer directly without explaining your search process
- If no relevant information found, respond exactly: NO_ANSWER_FOUND${hasTranscript ? `
- Consider the meeting transcript above for context` : ''}${coachSkillContent ? `
- Apply the coaching approach from the COACH SKILL above when relevant` : ''}`;

  const sessionId = `meeting-qa-${randomUUID()}`;
  const qaOutcome: { answer: string | null; sawError: boolean } = {
    answer: null,
    sawError: false,
  };

  try {
    await deps.runHeadlessTurn({
      prompt,
      onEvent: (event: AgentEvent) => {
        if (event.type === 'assistant' && event.text) {
          // Capture assistant response (may be streamed in parts)
          qaOutcome.answer = event.text.trim();
        } else if (event.type === 'result' && 'text' in event && event.text) {
          // Some pipelines emit final text as 'result' event
          qaOutcome.answer = event.text.trim();
        } else if (event.type === 'error') {
          log.error({ error: event.error, sessionId }, 'Agent error during Q&A');
          qaOutcome.sawError = true;
        }
      },
      options: {
        sessionType: 'automation',
        persistMode: { kind: 'none' },
        sessionId,
        resetConversation: true,
      },
    });

    const answer = qaOutcome.answer;
    if (qaOutcome.sawError || !answer) {
      return null;
    }

    // Check for "no answer" response
    if (answer.includes('NO_ANSWER_FOUND')) {
      log.info({ question, sessionId }, 'Agent found no relevant information');
      return null;
    }

    log.info({ question, answer: answer.slice(0, 100), sessionId }, 'Got answer from Rebel agent');
    return answer;
  } catch (error) {
    log.error({ error, question, sessionId }, 'Failed to query knowledge base');
    return null;
  }
}

/**
 * Queue a response as pending (ready-to-speak state)
 * Sets avatar to ready_to_speak and starts stale timer
 */
function queuePendingResponse(
  botId: string,
  state: BotQAState,
  response: string,
  question: string,
  sender: string,
  source: PendingResponse['source'] = 'qa',
  metadata?: {
    scores?: { relevance: number; helpfulness: number; timing: number } | null;
    triggerType?: string;
    triggerExcerpt?: string;
  }
): void {
  // If a Q&A response overwrites a proactive contribution, report the proactive
  // as ignored (increments adaptive backoff). System-driven replacements
  // (proactive replacing proactive with a fresher/higher-scoring version)
  // should NOT penalize the backoff counter.
  if (state.pendingResponse?.source === 'proactive' && source !== 'proactive') {
    deps?.onProactiveOutcome?.(botId, false);
  }

  // Capture current conversation topic for staleness detection
  const currentTopic = deps?.getConversationState(botId)?.currentTopic;

  // Store pending response
  state.pendingResponse = {
    text: response,
    question,
    sender,
    readyAt: Date.now(),
    source,
    scores: metadata?.scores,
    triggerType: metadata?.triggerType,
    triggerExcerpt: metadata?.triggerExcerpt,
    queuedTopic: currentTopic,
  };

  log.info({ botId, responseLength: response.length }, 'Response queued as pending, entering ready_to_speak state');

  // Set avatar to ready_to_speak state (pulsing animation)
  setAvatarState(botId, 'ready_to_speak', 'I have something...');


}

/**
 * Queue proactive contribution from external services (e.g., live coach participant mode).
 */
export function queueExternalContribution(
  botId: string,
  text: string,
  metadata?: {
    scores?: { relevance: number; helpfulness: number; timing: number };
    triggerType?: string;
    triggerExcerpt?: string;
  }
): boolean {
  const state = botQAStates.get(botId);
  if (!state) {
    return false;
  }

  const trimmedText = text.trim();
  if (!trimmedText) {
    return false;
  }

  // Don't overwrite a user-triggered Q&A response with a proactive contribution
  if (state.pendingResponse?.source === 'qa') {
    log.debug({ botId }, 'Skipping proactive contribution - Q&A response already pending');
    return false;
  }

  // Don't queue if user-triggered Q&A is being accumulated (mid-question)
  if (state.pendingQueryAccumulation || state.triggerDetector?.hasPendingAccumulation()) {
    log.debug({ botId }, 'Skipping proactive contribution - Q&A accumulation in progress');
    return false;
  }

  // Smart replacement: if there's already a pending proactive contribution,
  // only replace if the old one is stale OR the new one scores better.
  const pending = state.pendingResponse;
  if (pending?.source === 'proactive' && pending.scores && metadata?.scores) {
    const currentTopic = deps?.getConversationState(botId)?.currentTopic;
    const oldIsStale = topicHasDrifted(pending.queuedTopic, currentTopic);

    if (!oldIsStale && minScore(metadata.scores) <= minScore(pending.scores)) {
      log.debug(
        { botId, oldMin: minScore(pending.scores), newMin: minScore(metadata.scores) },
        'Keeping existing contribution - new one does not score higher and old topic is still relevant',
      );
      return false;
    }

    log.info(
      { botId, oldIsStale, oldMin: pending.scores ? minScore(pending.scores) : null, newMin: minScore(metadata.scores) },
      oldIsStale
        ? 'Replacing stale contribution with fresh one'
        : 'Replacing contribution with higher-scoring alternative',
    );
  }

  queuePendingResponse(botId, state, trimmedText, 'proactive contribution', 'Spark', 'proactive', {
    scores: metadata?.scores,
    triggerType: metadata?.triggerType,
    triggerExcerpt: metadata?.triggerExcerpt,
  });
  return true;
}

/**
 * Clear any pending proactive contributions for a bot.
 * Called when switching away from participant mode.
 */
export function clearProactivePending(botId: string): void {
  const state = botQAStates.get(botId);
  if (state?.pendingResponse?.source === 'proactive') {
    clearPendingResponse(state);
    setAvatarState(botId, 'idle', 'Taking notes...');
    deps?.onProactiveOutcome?.(botId, false);
    log.debug({ botId }, 'Cleared proactive pending response on mode switch');
  }
}

/**
 * Check if the pending proactive contribution has gone stale (topic drifted).
 * Called periodically from the proactive tick. Drops the contribution and
 * resets the avatar if the conversation has moved on.
 */
export function checkAndExpireStalePending(botId: string): boolean {
  const state = botQAStates.get(botId);
  if (!state?.pendingResponse || state.pendingResponse.source !== 'proactive') {
    return false;
  }

  const age = Date.now() - state.pendingResponse.readyAt;
  if (age < STALENESS_CHECK_AGE_MS) {
    return false;
  }

  const currentTopic = deps?.getConversationState(botId)?.currentTopic;
  if (!topicHasDrifted(state.pendingResponse.queuedTopic, currentTopic)) {
    return false;
  }

  log.info(
    { botId, ageMs: age, queuedTopic: state.pendingResponse.queuedTopic, currentTopic },
    'Expiring stale proactive contribution - topic has drifted',
  );
  deps?.onProactiveOutcome?.(botId, false);
  clearPendingResponse(state);
  setAvatarState(botId, 'idle', 'Taking notes...');
  return true;
}

/**
 * Consume the pending response: check staleness, clear state, and return the text.
 * Shared by both speak and chat delivery paths to avoid duplicating staleness/cleanup logic.
 * Returns null if no pending, or { stale: true } if topic drifted, or the consumed response data.
 */
function consumePendingResponse(botId: string): (
  | { stale: true }
  | { stale: false; text: string; source: PendingResponse['source'] }
) | null {
  const state = botQAStates.get(botId);
  if (!state?.pendingResponse) {
    return null;
  }

  const { text, source, queuedTopic } = state.pendingResponse;

  // Staleness check for proactive contributions
  if (source === 'proactive' && queuedTopic) {
    const currentTopic = deps?.getConversationState(botId)?.currentTopic;
    if (topicHasDrifted(queuedTopic, currentTopic)) {
      log.info(
        { botId, queuedTopic, currentTopic },
        'Pending response stale - topic drifted',
      );
      clearPendingResponse(state);
      deps?.onProactiveOutcome?.(botId, false);
      setAvatarState(botId, 'idle', 'Taking notes...');
      return { stale: true };
    }
  }

  // Clear pending state
  clearPendingResponse(state);

  return { stale: false, text, source };
}

/**
 * Speak the pending response and clear state.
 * For proactive contributions, performs a pre-speak relevance check --
 * if the topic has drifted since the contribution was queued, it drops
 * the contribution and briefly acknowledges instead of speaking stale content.
 * @param trigger - What triggered the speech: 'voice' (go-ahead), 'ui' (button), 'stale' (timeout)
 */
async function speakPendingResponse(botId: string, trigger: 'voice' | 'ui' | 'stale' = 'voice'): Promise<boolean> {
  const consumed = consumePendingResponse(botId);
  if (!consumed) {
    log.debug({ botId }, 'No pending response to speak');
    return false;
  }

  if (consumed.stale) {
    // Brief spoken acknowledgment so the user knows we heard "go ahead"
    await speakInMeeting(botId, "Actually, you've moved past that one. I'll keep listening.", 'Listening...', { skipThinkingState: true });
    setAvatarState(botId, 'idle', 'Taking notes...');
    return false;
  }

  const { text, source } = consumed;
  const state = botQAStates.get(botId);

  log.info({ botId, responseLength: text.length, trigger, source }, 'Speaking pending response');

  // Track what type of response we're speaking (for yield-on-overlap decisions)
  if (state) state.speakingSource = source;

  // Speak the response - skip thinking state since we're coming from ready_to_speak (hand raised)
  const success = await speakInMeeting(botId, text, 'Answering...', { skipThinkingState: true });

  if (success && source === 'qa' && state) {
    state.questionsAnswered++;
  }

  // Report proactive contribution as spoken for adaptive frequency (resets backoff).
  // Only report success — failure/abort cases are handled by their respective trigger
  // handlers (stop trigger, yield-on-overlap), not here, to avoid conflating TTS
  // failures and polite yields with user rejection.
  if (success && source === 'proactive') {
    deps?.onProactiveOutcome?.(botId, true);
  }

  return success;
}

/**
 * Send the pending proactive contribution as a chat message instead of speaking it.
 * Returns success/error info so the UI can provide feedback on failure.
 */
export async function chatPendingResponse(botId: string): Promise<{ success: boolean; error?: string; rateLimited?: boolean }> {
  const state = botQAStates.get(botId);
  if (!state?.pendingResponse) {
    return { success: false, error: 'No pending response' };
  }

  // Snapshot pending state before consuming (for restore on failure)
  const savedPending = state.pendingResponse;

  const consumed = consumePendingResponse(botId);
  if (!consumed) {
    return { success: false, error: 'No pending response' };
  }

  if (consumed.stale) {
    // Restore pending so the ContributionPill stays mounted and the user
    // can see the error (and dismiss via Skip). Without this, parent polling
    // unmounts the pill within ~500ms and the error message vanishes.
    state.pendingResponse = savedPending;
    return { success: false, error: 'Topic has moved on — this suggestion is no longer relevant' };
  }

  const { text, source } = consumed;

  log.info({ botId, responseLength: text.length, source }, 'Sending pending response as chat');
  const result = await postChatMessage(botId, text);

  if (result.success) {
    if (source === 'qa' && state) {
      state.questionsAnswered++;
    }
    if (source === 'proactive') {
      deps?.onProactiveOutcome?.(botId, true);
    }
    setAvatarState(botId, 'idle', 'Taking notes...');
  } else {
    // Restore pending state so user can retry or fall back to "Say it"
    state.pendingResponse = savedPending;
    setAvatarState(botId, 'ready_to_speak', 'I have something...');
    log.warn({ botId, error: result.error, rateLimited: result.rateLimited }, 'Failed to send pending response as chat - restored pending state');
  }

  return { success: result.success, error: result.error, rateLimited: result.rateLimited };
}

/**
 * Send an arbitrary chat message to the active meeting.
 * Public wrapper for the MCP tool / bridge route path.
 */
export async function sendChatToMeeting(botId: string, message: string): Promise<{ success: boolean; error?: string; rateLimited?: boolean }> {
  log.info({ botId, messageLength: message.length }, 'Sending chat to meeting');
  const result = await postChatMessage(botId, message);
  return { success: result.success, error: result.error, rateLimited: result.rateLimited };
}

/**
 * Clear pending response state (cancel without speaking)
 */
function clearPendingResponse(state: BotQAState): void {
  state.pendingResponse = null;
}

/**
 * Cancel pending response (for interrupt during ready_to_speak)
 */
function cancelPendingResponse(botId: string): boolean {
  const state = botQAStates.get(botId);
  if (!state?.pendingResponse) {
    return false;
  }
  
  log.info({ botId }, 'Cancelling pending response');
  clearPendingResponse(state);
  setAvatarState(botId, 'idle', 'Taking notes...');
  return true;
}

/**
 * Handle a detected question
 */
async function handleQuestion(
  botId: string,
  question: string,
  senderName: string,
  state: BotQAState,
  respondViaVoice: boolean = false
): Promise<void> {
  log.info({ botId, question, sender: senderName, knowledgeEnabled: state.knowledgeAccessEnabled }, 'Handling question');

  // Check rate limit
  if (state.questionsAnswered >= state.maxQuestionsPerMeeting) {
    log.info({ botId }, 'Rate limit reached, ignoring question');
    log.warn(
      {
        sessionIdHash: hashSessionId(state.triggerSessionId),
        source: 'meeting-bot',
        mode: state.outputMode,
        reason: 'rate-limited',
        answered: state.questionsAnswered,
        limit: state.maxQuestionsPerMeeting,
        triggerExtractedLength: question.length,
      },
      'trigger-rate-limited',
    );
    return;
  }

  // Clear any existing pending response (new question supersedes old)
  if (state.pendingResponse) {
    log.info({ botId }, 'New question received, clearing previous pending response');
    clearPendingResponse(state);
  }

  const deferMessage = `I'll pass that along. ${state.ownerName} can tackle that one.`;

  if (!state.knowledgeAccessEnabled) {
    // Knowledge access is off - try to answer from transcript context only
    // If no transcript or LLM fails, fall back to defer message
    const transcriptAnswer = state.transcriptBuffer.length > 0
      ? await answerFromTranscript(botId, question, senderName, state.ownerName, state.transcriptBuffer)
      : null;
    
    const response = transcriptAnswer || deferMessage;
    
    if (respondViaVoice) {
      // Queue response as pending instead of speaking immediately
      queuePendingResponse(botId, state, response, question, senderName);
    } else {
      const result = await postChatMessage(botId, response);
      // Reset avatar to idle (was set to "Listening..." during accumulation)
      setAvatarState(botId, 'idle', 'Taking notes...');
      if (result.rateLimited) {
        log.warn({ botId }, 'Rate limited when posting response - skipping');
        return;
      }
      state.questionsAnswered++;
    }
    return;
  }

  // Knowledge access is ON - query knowledge base with transcript context
  // Set thinking state while querying
  setAvatarState(botId, 'thinking', 'Looking that up...');
  
  // Load coach skill content if a coach is active
  let coachSkillContent: string | undefined;
  const activeBotState = getActiveBotState();
  if (activeBotState?.coachSkillPath) {
    const hasCachedPrompt = typeof activeBotState.coachPrompt === 'string' && activeBotState.coachPrompt.trim().length > 0;
    if (hasCachedPrompt) {
      coachSkillContent = activeBotState.coachPrompt;
    } else {
      try {
        const resolvedPrompt = resolveMeetingCoachPrompt(activeBotState.coachSkillPath, meetingCoachOperatorRegistry);
        coachSkillContent = resolvedPrompt.prompt;
        activeBotState.coachPrompt = resolvedPrompt.prompt;
        activeBotState.coachContentHash = resolvedPrompt.contentHash;
        activeBotState.coachPromptSource = resolvedPrompt.source;
        activeBotState.coachProactiveIntervalMinutes = resolvedPrompt.proactiveIntervalMinutes;
        log.debug(
          { botId, coachSkillPath: activeBotState.coachSkillPath, source: resolvedPrompt.source },
          'Resolved coach prompt for Q&A',
        );
      } catch (error) {
        log.warn({ botId, coachSkillPath: activeBotState.coachSkillPath, error }, 'Failed to resolve coach prompt');
      }
    }
  }
  
  const answer = await queryKnowledgeBase(botId, question, state.ownerName, senderName, state.transcriptBuffer, coachSkillContent);
  const response = answer || `I don't have anything on that one, sorry.`;
  
  if (respondViaVoice) {
    // Queue response as pending instead of speaking immediately
    queuePendingResponse(botId, state, response, question, senderName);
  } else {
    // Chat flow: post answer directly
    const chatResult = await postChatMessage(botId, response);
    
    if (chatResult.rateLimited) {
      log.warn({ botId }, 'Rate limited when posting answer - response not sent');
    }
    
    setAvatarState(botId, 'idle', 'Taking notes...');
    state.questionsAnswered++;
  }
}

/**
 * Process new chat messages for triggers
 */
async function processChatMessages(state: BotQAState): Promise<void> {
  log.debug({ botId: state.botId }, 'Polling chat messages');
  const messages = await fetchChatMessagesFromBackend(state.botId);
  log.debug({ botId: state.botId, messageCount: messages.length }, 'Got chat messages');
  
  for (const msg of messages) {
    // Skip messages we've already processed
    if (state.lastChatTimestamp && msg.timestamp <= state.lastChatTimestamp) {
      continue;
    }

    // Update last timestamp
    state.lastChatTimestamp = msg.timestamp;

    // Accumulate for persistence (all messages, not just trigger matches)
    state.chatBuffer.push({
      sender: msg.sender,
      text: msg.text,
      timestamp: msg.timestamp,
    });

    // Check for trigger
    if (matchesTrigger(msg.text, state.ownerName, state.triggerPhrase, log)) {
      const question = extractQuestion(msg.text, state.ownerName, state.triggerPhrase);
      await handleQuestion(state.botId, question, msg.sender, state, false);
    }
  }
}

/**
 * Trim transcript buffer if over word limit (FIFO - remove oldest first)
 */
function trimTranscriptBuffer(state: BotQAState): void {
  while (state.transcriptWordCount > MAX_TRANSCRIPT_WORDS && state.transcriptBuffer.length > 0) {
    const removed = state.transcriptBuffer.shift();
    if (!removed) break;
    state.transcriptWordCount -= removed.wordCount;
    log.debug({ botId: state.botId, removedWords: removed.wordCount, remaining: state.transcriptWordCount }, 'Trimmed oldest transcript segment');
  }
}

/**
 * Format transcript buffer for inclusion in LLM prompts
 */
function formatTranscriptForPrompt(buffer: TranscriptSegment[]): string {
  if (buffer.length === 0) return '[No transcript available yet]';
  
  return buffer.map(seg => {
    const time = new Date(seg.timestamp).toLocaleTimeString('en-US', { 
      hour: '2-digit', 
      minute: '2-digit',
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    return `${seg.speaker} (${time}): ${seg.text}`;
  }).join('\n');
}

/**
 * Extract unique participant names from transcript buffer.
 * Filters out generic/unknown speakers and sanitizes names.
 */
function getParticipantsFromTranscript(buffer: TranscriptSegment[]): string[] {
  const speakers = new Set<string>();
  for (const seg of buffer) {
    const speaker = seg.speaker?.trim();
    if (!speaker) continue;
    
    // Case-insensitive filtering of generic speakers
    const speakerLower = speaker.toLowerCase();
    if (speakerLower === 'unknown' || speakerLower.startsWith('speaker ')) {
      continue;
    }
    
    // Sanitize: remove newlines, limit length
    const sanitized = speaker.replace(/[\r\n]+/g, ' ').slice(0, 50);
    speakers.add(sanitized);
  }
  return Array.from(speakers);
}

/**
 * Build meeting context warning for LLM prompts.
 * Warns that the response will be spoken aloud in front of other participants.
 */
function buildMeetingContextWarning(ownerName: string, participants: string[]): string {
  const participantList = participants.length > 0
    ? participants.join(', ')
    : 'other meeting participants (names not yet identified)';
  
  return `IMPORTANT - MEETING PRIVACY CONTEXT:
Your response will be spoken aloud by an AI assistant in a live meeting.
Meeting participants: ${participantList}
- Do NOT share confidential information that ${ownerName} wouldn't want others to hear
- Do NOT reveal sensitive details (salaries, personal issues, private negotiations, health info, etc.)
- If the answer involves confidential information, say something like "I have some notes on that, but I'd rather share them with you privately after the meeting"
- Keep the response appropriate for all participants present`;
}

// =============================================================================
// Semantic Query Accumulation Functions
// =============================================================================

/**
 * Start the accumulation check timer (single polling interval)
 */
function startAccumulationTimer(botId: string): void {
  const state = botQAStates.get(botId);
  if (!state) return;
  
  // Clear any existing timer
  if (state.accumulationCheckTimer) {
    clearInterval(state.accumulationCheckTimer);
  }
  
  // Single polling interval - checks all conditions
  state.accumulationCheckTimer = setInterval(() => {
    checkQueryCompletion(botId).catch(err => {
      log.error({ botId, error: err }, 'Accumulation check failed');
    });
  }, ACCUMULATION_CHECK_INTERVAL);
}

/**
 * Cancel accumulation and clean up state
 */
function cancelAccumulation(state: BotQAState): void {
  if (state.pendingQueryAccumulation?.abortController) {
    state.pendingQueryAccumulation.abortController.abort();
  }
  state.pendingQueryAccumulation = null;
  if (state.accumulationCheckTimer) {
    clearInterval(state.accumulationCheckTimer);
    state.accumulationCheckTimer = null;
  }
}

/**
 * Check if accumulated query is semantically complete using Haiku LLM
 */
async function checkSemanticCompletion(text: string, signal?: AbortSignal): Promise<boolean> {
  const settings = getSettings();
  
  // Shortened prompt (~30 tokens)
  const prompt = `Is this a complete question/request, or is the speaker mid-thought?
Text: "${text}"
Reply ONLY: complete OR incomplete`;

  const response = await callBehindTheScenesWithAuth(settings, {
    messages: [{ role: 'user', content: prompt }],
    maxTokens: 10,
    timeout: 2000, // Fast timeout - we need low latency
    signal, // Pass abort signal to cancel if accumulation is reset
  }, {
    category: 'meeting-qa',
  });
  
  const answer = response.content[0]?.text?.trim().toLowerCase() ?? '';
  
  // Use exact match to avoid "incomplete" matching due to substring
  return answer === 'complete' || answer === 'complete.';
}

function handleStopTrigger(botId: string, state: BotQAState, textPreview: string | null): void {
  if (textPreview !== null) {
    log.info({ botId, text: textPreview }, 'Stop trigger detected');
  }

  if (state.isSpeaking) {
    if (state.speakingSource === 'proactive') {
      deps?.onProactiveOutcome?.(botId, false);
    }
    state.abortSpeaking = true;
    stopSpeaking(botId);
    state.isSpeaking = false;
    state.speakingStartedAt = null;
    state.speakingSource = null;
  }

  if (state.pendingResponse) {
    if (state.pendingResponse.source === 'proactive') {
      deps?.onProactiveOutcome?.(botId, false);
    }
    clearPendingResponse(state);
  }

  if (state.pendingQueryAccumulation) {
    cancelAccumulation(state);
  }

  state.triggerDetector?.cancelAccumulation();
  setAvatarState(botId, 'idle', 'Taking notes...');
}

function handleDiscardTrigger(botId: string, state: BotQAState, textPreview: string | null): void {
  if (textPreview !== null) {
    log.info({
      botId,
      text: textPreview,
      hasPending: !!state.pendingResponse,
      isAccumulating: !!state.pendingQueryAccumulation || !!state.triggerDetector?.hasPendingAccumulation(),
    }, 'Discard trigger detected');
  }

  if (state.pendingResponse) {
    if (state.pendingResponse.source === 'proactive') {
      deps?.onProactiveOutcome?.(botId, false);
    }
    clearPendingResponse(state);
  }

  if (state.pendingQueryAccumulation) {
    cancelAccumulation(state);
  }

  state.triggerDetector?.cancelAccumulation();
  setAvatarState(botId, 'idle', 'Taking notes...');
}

function resolveTriggerSourceSpeaker(state: BotQAState, speaker: string): MeetingTriggerDetectedPayload['triggerSourceSpeaker'] {
  const normalizedSpeaker = speaker.trim();
  if (!normalizedSpeaker || /^unknown$/i.test(normalizedSpeaker)) {
    return 'unknown';
  }

  const ownerFirstName = state.ownerName?.split(/\s+/)[0]?.toLowerCase() || '';
  if (ownerFirstName) {
    const speakerLower = normalizedSpeaker.toLowerCase();
    const isOwnerSpeaker = new RegExp(`\\b${ownerFirstName}\\b`, 'i').test(speakerLower);
    if (isOwnerSpeaker) {
      return 'user';
    }
  }

  return normalizedSpeaker;
}

function emitCompanionTriggerDetected(
  state: BotQAState,
  event: { extracted: string; speaker: string; timestamp: number },
): void {
  const payload: MeetingTriggerDetectedPayload = {
    sessionId: state.triggerSessionId,
    extracted: event.extracted,
    segmentTimestamp: event.timestamp,
    triggerSourceSpeaker: resolveTriggerSourceSpeaker(state, event.speaker),
  };

  try {
    getBroadcastService().sendToAllWindows(MEETING_TRIGGER_DETECTED_CHANNEL, payload);
    log.info(
      {
        sessionIdHash: hashSessionId(state.triggerSessionId),
        source: 'desktop-local',
        mode: state.outputMode,
        triggerSource: 'voice-trigger',
        speaker: payload.triggerSourceSpeaker,
        segmentTimestamp: event.timestamp,
        triggerExtractedLength: event.extracted.length,
        latencyMs: Date.now() - event.timestamp,
      },
      'trigger-detected',
    );
  } catch (error) {
    log.warn(
      {
        botId: state.botId,
        sessionIdHash: hashSessionId(state.triggerSessionId),
        error,
        source: 'desktop-local',
        mode: state.outputMode,
        reason: 'broadcast-failed',
        segmentTimestamp: event.timestamp,
      },
      'trigger-dropped',
    );
  }
}

function logTriggerDetected(
  state: BotQAState,
  fields: {
    source: 'desktop-local' | 'meeting-bot';
    speaker: string;
    segmentTimestamp: number;
    triggerExtracted?: string;
  },
): void {
  log.info(
    {
      sessionIdHash: hashSessionId(state.triggerSessionId),
      source: fields.source,
      mode: state.outputMode,
      triggerSource: 'voice-trigger',
      speaker: fields.speaker,
      segmentTimestamp: fields.segmentTimestamp,
      triggerExtractedLength: fields.triggerExtracted?.length ?? 0,
      latencyMs: Date.now() - fields.segmentTimestamp,
    },
    'trigger-detected',
  );
}

function logTriggerDropped(
  state: BotQAState,
  fields: {
    reason: string;
    source: 'desktop-local' | 'meeting-bot';
    speaker: string;
    segmentTimestamp: number;
    latencyMs?: number;
  },
): void {
  log.info(
    {
      sessionIdHash: hashSessionId(state.triggerSessionId),
      source: fields.source,
      mode: state.outputMode,
      triggerSource: 'voice-trigger',
      speaker: fields.speaker,
      segmentTimestamp: fields.segmentTimestamp,
      reason: fields.reason,
      latencyMs: fields.latencyMs ?? Date.now() - fields.segmentTimestamp,
    },
    'trigger-dropped',
  );
}

function createBotTriggerDetector(botId: string, state: BotQAState): MeetingTriggerDetector {
  const semanticCompletionCheck = state.outputMode === 'companion-only-question-listening'
    ? async () => true
    : checkSemanticCompletion;

  const detector = createMeetingTriggerDetector({
    ownerName: state.ownerName,
    triggerPhrase: state.triggerPhrase,
    mode: state.outputMode === 'companion-only-question-listening' ? 'companion-only' : 'voice-with-tts',
    semanticCompletionCheck,
    isSpeaking: () => state.isSpeaking,
    hasPendingResponse: () => !!state.pendingResponse,
    logger: log,
  });

  detector.on('stop', () => {
    handleStopTrigger(botId, state, null);
  });

  detector.on('discard', () => {
    handleDiscardTrigger(botId, state, null);
  });

  detector.on('high-signal', (event) => {
    deps?.onHighSignalUtterance?.(botId, event.type, event.text);
  });

  detector.on('trigger', (event) => {
    if (state.outputMode === 'companion-only-question-listening') {
      emitCompanionTriggerDetected(state, event);
      return;
    }

    logTriggerDetected(state, {
      source: 'meeting-bot',
      speaker: event.speaker,
      segmentTimestamp: event.timestamp,
      triggerExtracted: event.extracted,
    });
    handleQuestion(botId, event.extracted, event.speaker, state, state.respondViaVoice).catch(err => {
      log.error({ botId, error: err }, 'Failed to handle detector trigger');
    });
  });

  return detector;
}

/**
 * Check if the accumulated query is complete and should be processed
 */
async function checkQueryCompletion(botId: string): Promise<void> {
  const state = botQAStates.get(botId);
  if (!state?.pendingQueryAccumulation) return;
  
  const acc = state.pendingQueryAccumulation;
  const accumulationId = acc.id; // Capture for stale check
  const now = Date.now();
  const silenceDuration = now - acc.lastSegmentAt;
  const totalDuration = now - acc.triggerTimestamp;
  const wordCount = acc.fullText.trim().split(/\s+/).filter(w => w.length > 0).length;
  log.debug(
    {
      botId,
      now,
      lastSegmentAt: acc.lastSegmentAt,
      silenceDuration,
      wordCount,
      totalDuration,
    },
    'checkQueryCompletion accumulation status',
  );
  
  // Force completion on max timeout
  if (totalDuration >= MAX_QUERY_ACCUMULATION_TIME) {
    log.info({ botId, accumulationId, totalDuration }, 'Max accumulation timeout reached');
    await processAccumulatedQuery(botId, 'timeout', accumulationId);
    return;
  }
  
  // Wait for minimum silence before checking
  if (silenceDuration < MIN_SILENCE_BEFORE_COMPLETION_CHECK) {
    return; // Timer will call us again
  }
  
  // Skip LLM check for very short/empty queries - just wait for more
  if (wordCount < MIN_WORDS_FOR_LLM_CHECK) {
    // But if we've been silent for a while, process anyway
    if (silenceDuration >= ERROR_FALLBACK_SILENCE) {
      log.info({ botId, accumulationId, wordCount, silenceDuration }, 'Short query timeout');
      await processAccumulatedQuery(botId, 'short-query-timeout', accumulationId);
    }
    return;
  }
  
  // Prevent concurrent checks
  if (acc.completionCheckInFlight) return;
  acc.completionCheckInFlight = true;
  
  // Create abort controller for this check
  const abortController = new AbortController();
  acc.abortController = abortController;
  
  // Capture lastSegmentAt to detect if new speech arrived during LLM call
  const lastSegmentAtBeforeCheck = acc.lastSegmentAt;
  
  try {
    log.debug({ botId, accumulationId, wordCount, silenceDuration }, 'Checking semantic completion');
    const isComplete = await checkSemanticCompletion(acc.fullText, abortController.signal);
    
    // CRITICAL: Verify accumulation hasn't been reset/replaced while we were awaiting
    const currentAcc = state.pendingQueryAccumulation;
    if (!currentAcc || currentAcc.id !== accumulationId) {
      log.debug({ botId, accumulationId }, 'Accumulation was reset during completion check, ignoring result');
      return;
    }
    
    // CRITICAL: Check if new speech arrived during the LLM call - don't cut off mid-sentence
    if (currentAcc.lastSegmentAt !== lastSegmentAtBeforeCheck) {
      log.debug({ botId, accumulationId }, 'New speech arrived during completion check, continuing to accumulate');
      acc.completionCheckInFlight = false;
      acc.abortController = null;
      return;
    }
    
    if (isComplete) {
      log.info({ botId, accumulationId, wordCount }, 'Query semantically complete');
      await processAccumulatedQuery(botId, 'semantic', accumulationId);
    } else {
      log.debug({ botId, accumulationId, textPreview: acc.fullText.slice(0, 50) }, 'Query incomplete, continuing to accumulate');
      acc.completionCheckInFlight = false;
      acc.abortController = null;
      // Timer will call us again
    }
  } catch (error) {
    // Verify not stale before handling error
    const currentAcc = state.pendingQueryAccumulation;
    if (!currentAcc || currentAcc.id !== accumulationId) return;
    
    log.warn({ botId, accumulationId, error }, 'Semantic completion check failed');
    
    // On error, process anyway after additional silence
    if (silenceDuration >= ERROR_FALLBACK_SILENCE) {
      await processAccumulatedQuery(botId, 'error-fallback', accumulationId);
    } else {
      acc.completionCheckInFlight = false;
      acc.abortController = null;
      // Timer will call us again
    }
  }
}

/**
 * Process the accumulated query
 */
async function processAccumulatedQuery(
  botId: string,
  reason: 'semantic' | 'timeout' | 'error-fallback' | 'short-query-timeout',
  expectedAccumulationId: string
): Promise<void> {
  const state = botQAStates.get(botId);
  if (!state?.pendingQueryAccumulation) return;
  
  // CRITICAL: Verify this is still the same accumulation we started with
  if (state.pendingQueryAccumulation.id !== expectedAccumulationId) {
    log.debug({ botId, expectedAccumulationId, actualId: state.pendingQueryAccumulation.id },
      'Accumulation ID mismatch, skipping stale processing');
    return;
  }
  
  const { fullText, speaker } = state.pendingQueryAccumulation;
  const trimmed = fullText.trim();
  
  // Bug 9 fix: Validate question has meaningful content
  // Remove punctuation but keep unicode letters and numbers
  const meaningfulContent = trimmed.replace(/[^\p{L}\p{N}\s]/gu, '').trim();
  const words = meaningfulContent.split(/\s+/).filter(w => w.length > 0);
  
  // Clear accumulation state and timer FIRST (even if we reject the question)
  cancelAccumulation(state);
  
  // Reject if no meaningful words (e.g., just "!" or punctuation)
  // Single-word questions like "When?" or "How?" are valid - words.length >= 1
  if (words.length === 0) {
    log.info({ botId, reason, text: trimmed }, 'Discarding trivial/empty question - no meaningful content');
    setAvatarState(botId, 'idle', 'Taking notes...');
    return;
  }
  
  log.info({ botId, reason, textLength: trimmed.length, wordCount: words.length },
    'Processing accumulated query');
  
  // Now handle the complete question
  await handleQuestion(botId, trimmed, speaker, state, state.respondViaVoice);
}

/**
 * Process transcript segment for voice triggers and accumulation
 */
export function processTranscriptSegment(
  botId: string,
  speaker: string,
  text: string,
  isFinal: boolean = true
): void {
  const state = botQAStates.get(botId);
  if (!state) {
    log.debug({ botId }, 'No Q&A state for bot, skipping transcript');
    return;
  }

  // IMPORTANT: Only process final segments to avoid duplicates from partial transcripts
  if (!isFinal) {
    return;
  }

  // Accumulate to transcript buffer for context
  const wordCount = text.split(/\s+/).filter(w => w.length > 0).length;
  const segment = {
    speaker: speaker || 'Unknown',
    text,
    timestamp: Date.now(),
    wordCount,
  };
  state.transcriptBuffer.push(segment);
  state.transcriptWordCount += wordCount;
  
  // Also add to persistence buffer (never trimmed, for disk writes)
  state.persistenceBuffer.push(segment);
  
  // Start persistence timer on first segment AND flush immediately
  // (ensures short meetings get a transcript file, not just after 30s)
  if (state.persistenceBuffer.length === 1) {
    startPersistenceTimer(state);
    // Immediate first flush - don't wait 30s for short meetings
    flushLiveTranscript(state).catch(err => {
      log.warn({ botId, error: err }, 'Initial live transcript flush failed');
    });
  }
  
  // Trim Q&A buffer if over budget (persistence buffer is never trimmed)
  trimTranscriptBuffer(state);

  if (state.outputMode === 'silent') {
    if (matchesTrigger(text, state.ownerName, state.triggerPhrase, log)) {
      logTriggerDropped(state, {
        reason: 'silent-mode',
        source: 'desktop-local',
        speaker: segment.speaker,
        segmentTimestamp: segment.timestamp,
      });
    }
    return;
  }

  if (state.outputMode === 'companion-only-question-listening') {
    state.triggerDetector?.ingestSegment({
      speaker: segment.speaker,
      text,
      timestamp: segment.timestamp,
      isFinal,
    });
    return;
  }

  // Preserve existing behavior for bot-with-tts.
  if (state.bufferOnly) return;

  log.debug({ botId, speaker, text, isFinal, ownerName: state.ownerName, triggerPhrase: state.triggerPhrase }, 'Checking transcript for voice trigger');
  
  // Trigger detection and handling
  try {
    const speakerLower = (speaker || '').toLowerCase();
    const isUnknownSpeaker = speakerLower === 'unknown' || !speaker;
    
    // Bug 14 fix: Check for stop trigger FIRST, BEFORE any speaker filtering
    // This ensures "stop Spark" works even when diarization fails during bot speech
    // (Recall often labels owner as "Unknown" while bot is speaking)
    if (matchesStopTrigger(text, state.ownerName, state.triggerPhrase)) {
      state.triggerDetector?.ingestSegment({
        speaker: segment.speaker,
        text,
        timestamp: segment.timestamp,
        isFinal,
      });
      if (!state.triggerDetector) {
        handleStopTrigger(botId, state, text.slice(0, 50));
      }
      return;
    }
    
    // Discard trigger check - "never mind" / "discard" to clear pending without speaking
    // Only relevant if there's pending response or accumulation
    if ((state.pendingResponse || state.pendingQueryAccumulation || state.triggerDetector?.hasPendingAccumulation()) && 
        matchesDiscardTrigger(text, state.ownerName, state.triggerPhrase)) {
      state.triggerDetector?.ingestSegment({
        speaker: segment.speaker,
        text,
        timestamp: segment.timestamp,
        isFinal,
      });
      if (!state.triggerDetector) {
        handleDiscardTrigger(botId, state, text.slice(0, 50));
      }
      return;
    }
    
    // Filter 1: Skip bot's own speech (transcribed back as "Unknown" while speaking)
    // Only filter when bot is actively speaking - otherwise allow unknown speakers through
    // NOTE: This filter is AFTER stop trigger check so "stop Spark" works during bot speech
    if (isUnknownSpeaker && state.isSpeaking) {
      log.debug({ botId, text: text.slice(0, 50) }, 'Skipping trigger check - likely bot echo while speaking');
      if (matchesTrigger(text, state.ownerName, state.triggerPhrase, log)) {
        logTriggerDropped(state, {
          reason: 'bot-echo-while-speaking',
          source: 'meeting-bot',
          speaker: segment.speaker,
          segmentTimestamp: segment.timestamp,
        });
      }
      return;
    }
    
    // Yield-on-overlap: if bot is speaking a proactive contribution and an identified
    // participant starts talking, politely yield (stop speaking). Q&A responses are
    // not yielded since the user explicitly requested them.
    if (state.isSpeaking && state.speakingSource === 'proactive' && !isUnknownSpeaker) {
      // Don't yield if the OWNER is saying "go ahead" (encouraging the bot to continue)
      // Only the owner can "go ahead" — other participants saying it casually should still trigger yield
      const ownerName = state.ownerName?.split(/\s+/)[0]?.toLowerCase() || '';
      const isOwner = ownerName && new RegExp(`\\b${ownerName}\\b`, 'i').test(speakerLower);
      if (isOwner && /go\s+ahead/i.test(text)) {
        log.debug({ botId, speaker }, 'Owner said "go ahead" during proactive speech — not yielding');
        state.overlapDetectedAt = null; // Reset overlap since owner is encouraging
      } else {
        // Grace period: don't yield if speech just started (avoids false positives from transcript timing overlap)
        const speakingDuration = state.speakingStartedAt ? Date.now() - state.speakingStartedAt : 0;
        if (speakingDuration >= MIN_SPEAKING_BEFORE_INTERRUPT_MS) {
          // Sustained overlap: track when we first noticed someone speaking over the bot.
          // Only yield after they've been talking over it continuously.
          if (!state.overlapDetectedAt) {
            state.overlapDetectedAt = Date.now();
            log.debug({ botId, speaker }, 'Overlap detected — starting sustained overlap timer');
          } else {
            const overlapDuration = Date.now() - state.overlapDetectedAt;
            if (overlapDuration >= MIN_OVERLAP_BEFORE_YIELD_MS) {
              log.info({ botId, speaker, speakingDuration, overlapDuration }, 'Yielding proactive speech — sustained participant overlap');
              state.abortSpeaking = true;
              stopSpeaking(botId);
              state.isSpeaking = false;
              state.speakingStartedAt = null;
              state.speakingSource = null;
              state.overlapDetectedAt = null;
              setAvatarState(botId, 'idle', 'Taking notes...');
              return;
            }
            log.debug({ botId, speaker, overlapDuration }, 'Overlap continuing — not yet sustained enough to yield');
          }
        }
      }
    }
    
    // Filter 2: Only trigger on owner's speech (but allow unknown speakers through)
    // This prevents other participants from accidentally triggering the bot
    const ownerFirstName = state.ownerName?.split(/\s+/)[0]?.toLowerCase() || '';
    
    // If speaker is unknown/ambiguous, allow through (default to trigger)
    // If speaker is identified but not owner, skip
    if (!isUnknownSpeaker && ownerFirstName) {
      // Use word-boundary matching to avoid false positives (e.g., "Ann" matching "Danny")
      const isOwnerSpeaking = new RegExp(`\\b${ownerFirstName}\\b`, 'i').test(speakerLower);
      
      if (!isOwnerSpeaking) {
        if (!state.isSpeaking) {
          state.triggerDetector?.ingestSegment({
            speaker: segment.speaker,
            text,
            timestamp: segment.timestamp,
            isFinal,
          });
        }
        log.debug({ botId, speaker, ownerFirstName }, 'Skipping trigger check - not owner\'s speech');
        if (matchesTrigger(text, state.ownerName, state.triggerPhrase, log)) {
          logTriggerDropped(state, {
            reason: 'non-owner-speaker',
            source: 'meeting-bot',
            speaker: segment.speaker,
            segmentTimestamp: segment.timestamp,
          });
        }
        return;
      }
    }
    
    const triggered = matchesTrigger(text, state.ownerName, state.triggerPhrase, log);
    
    // Special case: trigger word + confirmation phrase should speak pending response.
    // Requires the trigger word — bare "go ahead" is too prone to false positives.
    // Handles "Spark, go ahead" / "hey Spark, continue" / "Spark, yes" etc.
    // Note: Speaker filtering (Filter 2 above) already ensures only owner/unknown speakers reach here.
    if (!triggered && state.pendingResponse) {
      const afterTrigger = stripTriggerPrefix(text, state.ownerName, state.triggerPhrase);
      if (afterTrigger && isConfirmationPhrase(afterTrigger.toLowerCase())) {
        log.info({ botId, text, afterTrigger, speaker }, 'Trigger + confirmation phrase detected - speaking pending response');
        speakPendingResponse(botId, 'voice').catch(err => {
          log.error({ botId, error: err }, 'Failed to speak pending response');
        });
        return;
      }
    }
    
    // If currently accumulating from the same speaker and NO new trigger, append to accumulation
    if (state.pendingQueryAccumulation && speaker === state.pendingQueryAccumulation.speaker && !triggered) {
      state.pendingQueryAccumulation.segments.push(text);
      state.pendingQueryAccumulation.fullText += ' ' + text;
      state.pendingQueryAccumulation.lastSegmentAt = Date.now();
      log.debug({ botId, speaker, textLength: text.length }, 'Appending to query accumulation');
      // Timer is already running, will pick up new segment
      return;
    }
    
    if (!triggered) {
      // If accumulating but different speaker, ignore their text (don't pollute query)
      return;
    }
    
    log.debug({ botId, triggered, text, hasPending: !!state.pendingResponse, isSpeaking: state.isSpeaking, isAccumulating: !!state.pendingQueryAccumulation }, 'Trigger detected');
    
    // Priority 1: Handle pending response
    // Bug 8 fix: Distinguish between "go ahead" (speak pending) vs new question (supersedes pending)
    if (state.pendingResponse) {
      const extractedQuestion = extractQuestion(text, state.ownerName, state.triggerPhrase);
      const trimmedQuestion = extractedQuestion.trim();
      const lowerQuestion = trimmedQuestion.toLowerCase();
      
      // Check if extracted content is a confirmation phrase ("go ahead", "continue", "yes", etc.)
      if (isConfirmationPhrase(lowerQuestion)) {
        log.info({ botId, text, cleanedQuestion: lowerQuestion }, 'Confirmation phrase detected with pending response, speaking it');
        speakPendingResponse(botId, 'voice').catch(err => {
          log.error({ botId, error: err }, 'Failed to speak pending response');
        });
        return;
      }
      
      // Check for "go ahead + new question" compound command (use original case for follow-up)
      const followUpQuestion = extractFollowUpAfterConfirmation(trimmedQuestion);
      if (followUpQuestion) {
        log.info({ botId, text, followUpQuestion }, 'Go ahead + new question detected');
        speakPendingResponse(botId, 'voice').catch(err => {
          log.error({ botId, error: err }, 'Failed to speak pending response');
        });
        // Start new accumulation with the follow-up question
        state.pendingQueryAccumulation = {
          id: randomUUID(),
          triggerTimestamp: Date.now(),
          segments: [followUpQuestion],
          fullText: followUpQuestion,
          lastSegmentAt: Date.now(),
          speaker: speaker || 'Unknown',
          completionCheckInFlight: false,
          abortController: null,
        };
        log.info({ botId, speaker, extractedQuestion: followUpQuestion }, 
          'Starting accumulation for follow-up question after go-ahead');
        setAvatarState(botId, 'thinking', 'Listening...');
        startAccumulationTimer(botId);
        return;
      }
      
      // New question without "go ahead" - supersedes old pending (Bug 8 fix)
      log.info({ botId, text }, 'New trigger with pending response - discarding old, processing new');
      if (state.pendingResponse?.source === 'proactive') {
        deps?.onProactiveOutcome?.(botId, false);
      }
      clearPendingResponse(state);
      // Fall through to start new accumulation
    }
    
    // Priority 2: If we're speaking, check if this is a "go ahead" (continue) or interrupt
    if (state.isSpeaking) {
      // "Go ahead" / "continue" while already speaking = user wants it to continue, not interrupt
      const isGoAhead = GO_AHEAD_IN_TEXT_RE.test(text);
      if (isGoAhead) {
        log.info({ botId }, 'Trigger detected while speaking with confirmation phrase - ignoring (already speaking)');
        logTriggerDropped(state, {
          reason: 'already-speaking-confirmation',
          source: 'meeting-bot',
          speaker: segment.speaker,
          segmentTimestamp: segment.timestamp,
        });
        return;
      }
      
      const speakingDuration = state.speakingStartedAt ? Date.now() - state.speakingStartedAt : 0;
      if (speakingDuration < MIN_SPEAKING_BEFORE_INTERRUPT_MS) {
        log.info({ botId, text, speakingDuration }, 'Interrupt ignored - speaking just started (grace period)');
        logTriggerDropped(state, {
          reason: 'speaking-grace-period',
          source: 'meeting-bot',
          speaker: segment.speaker,
          segmentTimestamp: segment.timestamp,
          latencyMs: speakingDuration,
        });
        return;
      }
      log.info({ botId, text, speakingDuration }, 'Trigger detected while speaking, interrupting');
      state.abortSpeaking = true;
      stopSpeaking(botId);
      // Immediately clear speaking state since we're forcefully interrupting
      state.isSpeaking = false;
      state.speakingStartedAt = null;
      state.speakingSource = null;
      return;
    }
    
    // Priority 3: Start semantic query accumulation
    // If already accumulating (re-trigger), cancel old and start fresh
    if (state.pendingQueryAccumulation) {
      log.info({ botId }, 'Re-trigger detected, cancelling previous accumulation');
      cancelAccumulation(state);
    }
    
    const extractedQuestion = extractQuestion(text, state.ownerName, state.triggerPhrase);
    state.pendingQueryAccumulation = {
      id: randomUUID(),
      triggerTimestamp: Date.now(),
      segments: [extractedQuestion],
      fullText: extractedQuestion,
      lastSegmentAt: Date.now(),
      speaker: speaker || 'Unknown',
      completionCheckInFlight: false,
      abortController: null,
    };
    
    log.info({ botId, speaker, extractedQuestion, accumulationId: state.pendingQueryAccumulation.id }, 
      'Starting semantic query accumulation');
    
    // Set avatar to thinking state with listening text (reuse existing state)
    setAvatarState(botId, 'thinking', 'Listening...');
    
    // Start single polling timer
    startAccumulationTimer(botId);
  } catch (err) {
    log.warn({ botId, error: err, text: text.slice(0, 100) }, 'Trigger detection failed, skipping segment');
    logTriggerDropped(state, {
      reason: 'detection-error',
      source: 'meeting-bot',
      speaker: segment.speaker,
      segmentTimestamp: segment.timestamp,
    });
  }
}

/**
 * Start Q&A service for a bot
 */
export function startBotQA(
  botId: string,
  ownerName: string,
  triggerPhrase: string | null = null,
  respondViaVoice: boolean = true
): void {
  // Clean up existing state if any
  fireAndForget(stopBotQA(botId), 'meetingBot.botQAService.line1861');

  const state: BotQAState = {
    botId,
    ownerName,
    triggerPhrase,
    knowledgeAccessEnabled: false, // OFF by default - user must enable via UI toggle
    respondViaVoice,
    chatPollTimer: null,
    lastChatTimestamp: null,
    questionsAnswered: 0,
    maxQuestionsPerMeeting: 10,
    bufferOnly: false,
    outputMode: 'bot-with-tts',
    triggerSessionId: botId,
    transcriptBuffer: [],
    transcriptWordCount: 0,
    isSpeaking: false,
    speakingStartedAt: null,
    abortSpeaking: false,
    speakingSource: null,
    overlapDetectedAt: null,
    pendingResponse: null,
    triggerDetector: null,
    // Semantic query accumulation
    pendingQueryAccumulation: null,
    accumulationCheckTimer: null,
    // Live transcript persistence
    persistenceBuffer: [],
    lastPersistedIndex: 0,
    liveFilePath: null,
    persistenceTimer: null,
    chatBuffer: [],
  };
  state.triggerDetector = createBotTriggerDetector(botId, state);

  // Start chat polling (every 2 seconds)
  state.chatPollTimer = setInterval(() => {
    processChatMessages(state).catch(err => {
      log.error({ botId, error: err }, 'Chat poll error');
    });
  }, 2000);

  botQAStates.set(botId, state);
  log.info({ botId, ownerName, respondViaVoice }, 'Started Q&A service for bot');
}

/**
 * Start a buffer-only transcript accumulation for local recording.
 * Creates a BotQAState that accumulates transcript segments without any
 * trigger detection, Q&A, chat polling, or voice operations.
 * Used by local recording to feed the coaching system's transcript buffer.
 */
export function startLocalTranscriptBuffer(
  botId: string,
  ownerName: string,
  options: {
    outputMode: Exclude<BotQAOutputMode, 'bot-with-tts'>;
    triggerPhrase?: string | null;
    triggerSessionId?: string;
  },
): void {
  // Clean up if existing
  fireAndForget(stopBotQA(botId), 'meetingBot.botQAService.line1924');

  const state: BotQAState = {
    botId,
    ownerName,
    triggerPhrase: options.triggerPhrase ?? null,
    knowledgeAccessEnabled: false,
    respondViaVoice: false,
    chatPollTimer: null,  // NO chat polling
    lastChatTimestamp: null,
    questionsAnswered: 0,
    maxQuestionsPerMeeting: 0,
    bufferOnly: true,  // CRITICAL: local recording remains buffer-first for coaching
    outputMode: options.outputMode,
    triggerSessionId: options.triggerSessionId ?? botId,
    transcriptBuffer: [],
    transcriptWordCount: 0,
    isSpeaking: false,
    speakingStartedAt: null,
    abortSpeaking: false,
    speakingSource: null,
    overlapDetectedAt: null,
    pendingResponse: null,
    triggerDetector: null,
    pendingQueryAccumulation: null,
    accumulationCheckTimer: null,
    persistenceBuffer: [],
    lastPersistedIndex: 0,
    liveFilePath: null,
    persistenceTimer: null,
    chatBuffer: [],
  };
  state.triggerDetector = createBotTriggerDetector(botId, state);

  botQAStates.set(botId, state);
  log.info(
    {
      botId,
      ownerName,
      outputMode: options.outputMode,
      triggerSessionId: state.triggerSessionId,
      triggerPhrase: state.triggerPhrase,
    },
    'Started local transcript buffer',
  );
}

/**
 * Flush live transcript to disk.
 * Called periodically (every 30s) and on stop.
 */
async function flushLiveTranscript(state: BotQAState): Promise<void> {
  const { botId, persistenceBuffer, lastPersistedIndex, liveFilePath } = state;

  // Skip if no new segments and no chat to persist
  const hasNewSegments = lastPersistedIndex < persistenceBuffer.length;
  const hasChatToPersist = state.chatBuffer.length > 0;
  if (!hasNewSegments && !hasChatToPersist) {
    return;
  }

  // Skip if write already in progress for this bot
  if (writesInProgress.has(botId)) {
    log.debug({ botId }, 'Write already in progress, skipping flush');
    return;
  }

  writesInProgress.add(botId);
  try {
    if (!liveFilePath) {
      // First write - create the file
      const pending = getPendingTranscript(botId);
      if (!pending) {
        log.warn({ botId }, 'No pending transcript found for live transcript creation');
        return;
      }

      const liveData: LiveTranscriptData = {
        botId,
        meetingUrl: pending.meetingUrl,
        meetingTitle: pending.meetingTitle,
        startTime: pending.createdAt, // Use createdAt as start time
        participants: persistenceBuffer.map(s => s.speaker).filter((v, i, a) => a.indexOf(v) === i),
        calendarEventId: pending.calendarEventId,
        calendarSource: pending.calendarSource,
      };

      const result = await saveLiveTranscript(
        liveData,
        persistenceBuffer as LiveTranscriptSegment[],
        state.chatBuffer,
      );
      if (result.success && result.filePath) {
        state.liveFilePath = result.filePath;
        state.lastPersistedIndex = persistenceBuffer.length;
        
        // Store path in pending transcript for upgrade and restart recovery
        updateLiveTranscriptPath(botId, result.filePath);
        
        log.info({ botId, filePath: result.filePath, segmentCount: persistenceBuffer.length },
          'Created live transcript file');
      } else {
        log.error({ botId, error: result.error }, 'Failed to create live transcript file');
      }
    } else {
      // Append to existing file
      const result = await appendToLiveTranscript(
        liveFilePath,
        persistenceBuffer as LiveTranscriptSegment[],
        lastPersistedIndex,
        state.chatBuffer,
      );
      if (result.success) {
        state.lastPersistedIndex = persistenceBuffer.length;
        log.debug({ botId, newSegments: result.newSegmentsWritten },
          'Appended to live transcript');
      } else {
        log.error({ botId, error: result.error }, 'Failed to append to live transcript');
      }
    }
  } finally {
    writesInProgress.delete(botId);
  }
}

/**
 * Flush live transcript using a cloned state snapshot.
 * Used for final flush on stop when original state has already been deleted.
 */
async function flushLiveTranscriptSnapshot(snapshot: {
  botId: string;
  persistenceBuffer: LiveTranscriptSegment[];
  lastPersistedIndex: number;
  liveFilePath: string | null;
  chatBuffer: ChatMessage[];
}): Promise<void> {
  const { botId, persistenceBuffer, lastPersistedIndex, liveFilePath, chatBuffer } = snapshot;

  // Skip if no new segments and no chat to persist
  const hasNewSegments = lastPersistedIndex < persistenceBuffer.length;
  const hasChatToPersist = chatBuffer.length > 0;
  if (!hasNewSegments && !hasChatToPersist) {
    return;
  }

  // Skip if write already in progress for this bot
  if (writesInProgress.has(botId)) {
    log.debug({ botId }, 'Write already in progress, skipping final flush');
    return;
  }

  writesInProgress.add(botId);
  try {
    if (!liveFilePath) {
      // No file created yet - create it now
      const pending = getPendingTranscript(botId);
      if (!pending) {
        log.warn({ botId }, 'No pending transcript found for final live transcript creation');
        return;
      }

      const liveData: LiveTranscriptData = {
        botId,
        meetingUrl: pending.meetingUrl,
        meetingTitle: pending.meetingTitle,
        startTime: pending.createdAt,
        participants: persistenceBuffer.map(s => s.speaker).filter((v, i, a) => a.indexOf(v) === i),
        calendarEventId: pending.calendarEventId,
        calendarSource: pending.calendarSource,
      };

      const result = await saveLiveTranscript(liveData, persistenceBuffer, chatBuffer);
      if (result.success && result.filePath) {
        updateLiveTranscriptPath(botId, result.filePath);
        log.info({ botId, filePath: result.filePath, segmentCount: persistenceBuffer.length },
          'Created live transcript file on final flush');
      } else {
        log.error({ botId, error: result.error }, 'Failed to create live transcript on final flush');
      }
    } else {
      // Append remaining segments to existing file
      const result = await appendToLiveTranscript(liveFilePath, persistenceBuffer, lastPersistedIndex, chatBuffer);
      if (result.success) {
        log.debug({ botId, newSegments: result.newSegmentsWritten }, 'Final flush appended to live transcript');
      } else {
        log.error({ botId, error: result.error }, 'Failed to append on final flush');
      }
    }
  } finally {
    writesInProgress.delete(botId);
  }
}

/**
 * Start the periodic persistence timer for a bot.
 * Called after the first caption is received.
 */
function startPersistenceTimer(state: BotQAState): void {
  if (state.persistenceTimer) {
    return; // Already running
  }

  state.persistenceTimer = setInterval(() => {
    flushLiveTranscript(state).catch(err => {
      log.warn({ botId: state.botId, error: err }, 'Periodic live transcript flush failed');
    });
  }, LIVE_TRANSCRIPT_PERSIST_INTERVAL);

  log.debug({ botId: state.botId }, 'Started live transcript persistence timer');
}

/**
 * Stop Q&A service for a bot
 */
export async function stopBotQA(botId: string): Promise<void> {
  const state = botQAStates.get(botId);
  if (state) {
    if (state.chatPollTimer) {
      clearInterval(state.chatPollTimer);
    }
    // Cancel any pending accumulation (aborts in-flight LLM calls, clears timer)
    cancelAccumulation(state);
    state.triggerDetector?.dispose();

    // Clear persistence timer and final flush
    if (state.persistenceTimer) {
      clearInterval(state.persistenceTimer);
    }
    
    // Final flush of any remaining segments
    // Clone state data needed for async flush since we delete the state immediately after
    const needsFinalFlush = state.liveFilePath && (
      state.lastPersistedIndex < state.persistenceBuffer.length ||
      state.chatBuffer.length > 0
    );
    const flushState = needsFinalFlush ? {
      botId: state.botId,
      persistenceBuffer: [...state.persistenceBuffer],
      lastPersistedIndex: state.lastPersistedIndex,
      liveFilePath: state.liveFilePath,
      chatBuffer: [...state.chatBuffer],
    } : null;

    // Delete state before async flush (so new Q&A sessions can start immediately)
    botQAStates.delete(botId);
    log.info({ botId }, 'Stopped Q&A service for bot');

    // Fire-and-forget flush with cloned data (state already deleted)
    if (flushState) {
      flushLiveTranscriptSnapshot(flushState).catch(err => {
        log.warn({ botId, error: err }, 'Failed to flush live transcript on stop');
      });
    }
  }
}

/**
 * Toggle knowledge base access for a bot
 */
export function setKnowledgeAccess(botId: string, enabled: boolean): void {
  const state = botQAStates.get(botId);
  if (state) {
    state.knowledgeAccessEnabled = enabled;
    log.info({ botId, enabled }, 'Knowledge access toggled');
  }
}

/**
 * Check if knowledge access is enabled for a bot
 */
export function isKnowledgeAccessEnabled(botId: string): boolean {
  const state = botQAStates.get(botId);
  return state?.knowledgeAccessEnabled ?? false;
}

/**
 * Set the speaking state for a bot (called from voice service)
 */
export function setBotSpeakingState(botId: string, speaking: boolean): void {
  const state = botQAStates.get(botId);
  if (state) {
    state.isSpeaking = speaking;
    if (speaking) {
      state.abortSpeaking = false; // Reset abort flag when starting new speech
      state.speakingStartedAt = Date.now(); // Track when speaking began
      state.overlapDetectedAt = null; // Reset overlap tracking
    } else {
      state.speakingStartedAt = null;
      state.speakingSource = null;
      state.overlapDetectedAt = null;
    }
    log.debug({ botId, speaking }, 'Bot speaking state updated');
  }
}

/**
 * Check if bot is currently speaking
 */
export function isBotSpeaking(botId: string): boolean {
  const state = botQAStates.get(botId);
  return state?.isSpeaking ?? false;
}

/**
 * Check if bot speaking should be aborted (for chunk loop)
 */
export function shouldAbortSpeaking(botId: string): boolean {
  const state = botQAStates.get(botId);
  return state?.abortSpeaking ?? false;
}

// Register speaking-state accessors so botVoiceService (which would otherwise
// import these statically and form a botQA ↔ botVoice cycle) can call them
// through `botSpeakingStateRegistry` instead.
registerSetBotSpeakingState(setBotSpeakingState);
registerShouldAbortSpeaking(shouldAbortSpeaking);

/**
 * Request abort of current speech (for external callers like UI button)
 */
export function requestStopSpeaking(botId: string): boolean {
  const state = botQAStates.get(botId);
  if (state && state.isSpeaking) {
    log.info({ botId }, 'Stop speaking requested');
    state.abortSpeaking = true;
    stopSpeaking(botId);
    // Immediately clear speaking state - audio is being forcefully stopped
    // Don't wait for speakInMeeting() to finish its async flow
    state.isSpeaking = false;
    state.speakingStartedAt = null;
    state.speakingSource = null;
    return true;
  }
  // Also cancel pending response if any
  if (state?.pendingResponse) {
    return cancelPendingResponse(botId);
  }
  return false;
}

/**
 * Check if bot has a pending response (ready to speak)
 */
export function hasPendingResponse(botId: string): boolean {
  const state = botQAStates.get(botId);
  return !!state?.pendingResponse;
}

/**
 * Trigger speaking the pending response (for UI "Let Spark speak" button)
 */
export async function triggerSpeakPendingResponse(botId: string): Promise<boolean> {
  return speakPendingResponse(botId, 'ui');
}

/**
 * Stop all Q&A services
 */
export function stopAllBotQA(): void {
  for (const botId of botQAStates.keys()) {
    fireAndForget(stopBotQA(botId), 'meetingBot.botQAService.line2284');
  }
}

/**
 * Get the pending contribution preview for UI display.
 * Only returns data for proactive contributions (not Q&A responses).
 */
export function getPendingContributionPreview(botId: string): {
  text: string;
  scores?: { relevance: number; helpfulness: number; timing: number } | null;
  triggerType?: string;
  triggerExcerpt?: string;
} | null {
  const state = botQAStates.get(botId);
  if (!state?.pendingResponse || state.pendingResponse.source !== 'proactive') return null;
  return {
    text: state.pendingResponse.text,
    scores: state.pendingResponse.scores,
    triggerType: state.pendingResponse.triggerType,
    triggerExcerpt: state.pendingResponse.triggerExcerpt,
  };
}

/**
 * Dismiss the pending proactive contribution without speaking it.
 * Reports as ignored for adaptive frequency backoff.
 */
export function dismissPendingContribution(botId: string): boolean {
  const state = botQAStates.get(botId);
  if (state?.pendingResponse?.source === 'proactive') {
    deps?.onProactiveOutcome?.(botId, false);
  }
  return cancelPendingResponse(botId);
}

/**
 * Get formatted transcript buffer for a bot (for live coach service)
 */
export function getTranscriptBuffer(botId: string): string | null {
  const state = botQAStates.get(botId);
  if (!state || state.transcriptBuffer.length === 0) {
    return null;
  }
  return formatTranscriptForPrompt(state.transcriptBuffer);
}

/**
 * Rehydrate transcript buffers from previously persisted segments.
 * Called after startBotQA during app restart to restore meeting context.
 * Also restores liveFilePath so future flushes append to the existing file.
 */
export function rehydrateTranscriptBuffer(botId: string, segments: LiveTranscriptSegment[], liveFilePath: string): void {
  const state = botQAStates.get(botId);
  if (!state) {
    log.warn({ botId }, 'Cannot rehydrate transcript - no Q&A state');
    return;
  }
  if (segments.length === 0) return;

  for (const seg of segments) {
    state.transcriptBuffer.push(seg);
    state.transcriptWordCount += seg.wordCount;
    state.persistenceBuffer.push(seg);
  }

  // Point lastPersistedIndex past the rehydrated segments (they're already on disk)
  state.lastPersistedIndex = state.persistenceBuffer.length;

  // Restore live file path so new captions append to the existing file
  state.liveFilePath = liveFilePath;

  // Start persistence timer for new segments that arrive after rehydration
  startPersistenceTimer(state);

  // Trim Q&A buffer to budget (persistence buffer is never trimmed)
  trimTranscriptBuffer(state);

  log.info(
    { botId, rehydratedSegments: segments.length, transcriptWords: state.transcriptWordCount, liveFilePath },
    'Rehydrated transcript buffers from disk'
  );
}
