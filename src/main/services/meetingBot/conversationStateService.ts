import { createScopedLogger } from '@core/logger';
import { callBehindTheScenesWithAuth, type BehindTheScenesResponse } from '../behindTheScenesClient';
import { getPrompt, PROMPT_IDS } from '@core/services/promptFileService';
import { getSettings } from '@core/services/settingsStore';
import { removeCodeFence, extractTextFromBtsResponse, hashTranscriptTail } from './btsResponseUtils';
import { fireAndForget } from '@shared/utils/fireAndForget';

const log = createScopedLogger({ service: 'conversation-state' });

const HASH_WINDOW_CHARS = 2000;
const TRANSCRIPT_WINDOW_CHARS = 6000;
const UPDATE_DEBOUNCE_MS = 1200;
const MAX_LIST_ITEMS = 4;
const MAX_TOPIC_CHARS = 120;
const MAX_SUMMARY_CHARS = 320;
const MAX_LIST_ITEM_CHARS = 120;

// Prompt externalized to rebel-system/prompts/utility/meeting-conversation-state.md

export interface ConversationState {
  currentTopic: string;
  shortSummary: string;
  openQuestions: string[];
  recentDecisions: string[];
  lastUpdatedAt: number; // timestamp
}

export type ConversationStateDeps = {
  getTranscriptBuffer: (botId: string) => string | null;
  getActiveBotState: () => { botId: string } | null;
};

interface ConversationStateTracker {
  state: ConversationState;
  lastTranscriptHash: string | null;
  updateInFlight: boolean;
  dirty: boolean;
  debounceTimer: ReturnType<typeof setTimeout> | null;
}

type ConversationStatePayload = Partial<Pick<
  ConversationState,
  'currentTopic' | 'shortSummary' | 'openQuestions' | 'recentDecisions'
>>;

let deps: ConversationStateDeps | null = null;
const trackersByBot = new Map<string, ConversationStateTracker>();

function createInitialState(): ConversationState {
  return {
    currentTopic: '',
    shortSummary: '',
    openQuestions: [],
    recentDecisions: [],
    lastUpdatedAt: Date.now(),
  };
}

function cloneState(state: ConversationState): ConversationState {
  return {
    currentTopic: state.currentTopic,
    shortSummary: state.shortSummary,
    openQuestions: [...state.openQuestions],
    recentDecisions: [...state.recentDecisions],
    lastUpdatedAt: state.lastUpdatedAt,
  };
}

export function formatMeetingContext(state: ConversationState | null): string {
  if (!state) {
    return '';
  }

  const hasTopic = state.currentTopic.length > 0;
  const hasSummary = state.shortSummary.length > 0;
  if (!hasTopic && !hasSummary && state.openQuestions.length === 0 && state.recentDecisions.length === 0) {
    return '';
  }

  const parts = ['[MEETING CONTEXT]'];
  if (hasTopic) parts.push(`Topic: ${state.currentTopic}`);
  if (hasSummary) parts.push(`Summary: ${state.shortSummary}`);
  if (state.openQuestions.length > 0) parts.push(`Open questions: ${state.openQuestions.join(', ')}`);
  if (state.recentDecisions.length > 0) parts.push(`Recent decisions: ${state.recentDecisions.join(', ')}`);
  parts.push('[/MEETING CONTEXT]');

  return parts.join('\n');
}

function isConversationStateEnabled(): boolean {
  return getSettings().meetingBot?.enableConversationState !== false;
}

function trimText(value: unknown, maxChars: number): string {
  if (typeof value !== 'string') {
    return '';
  }
  const compact = value.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxChars) {
    return compact;
  }
  return `${compact.slice(0, Math.max(0, maxChars - 1)).trim()}…`;
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const items: string[] = [];
  for (const item of value) {
    const text = trimText(item, MAX_LIST_ITEM_CHARS);
    if (!text) {
      continue;
    }
    const dedupeKey = text.toLowerCase();
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    items.push(text);
    if (items.length >= MAX_LIST_ITEMS) {
      break;
    }
  }
  return items;
}

function normalizeStatePayload(
  payload: ConversationStatePayload,
  previousState: ConversationState,
): ConversationState {
  const currentTopic = trimText(payload.currentTopic, MAX_TOPIC_CHARS) || previousState.currentTopic;
  const shortSummary = trimText(payload.shortSummary, MAX_SUMMARY_CHARS) || previousState.shortSummary;

  const hasOpenQuestions = Array.isArray(payload.openQuestions);
  const hasRecentDecisions = Array.isArray(payload.recentDecisions);

  return {
    currentTopic,
    shortSummary,
    openQuestions: hasOpenQuestions ? normalizeStringList(payload.openQuestions) : previousState.openQuestions,
    recentDecisions: hasRecentDecisions ? normalizeStringList(payload.recentDecisions) : previousState.recentDecisions,
    lastUpdatedAt: Date.now(),
  };
}

function parseConversationStateResponse(
  response: BehindTheScenesResponse,
  previousState: ConversationState,
): ConversationState | null {
  const rawJson = extractTextFromBtsResponse(response);
  if (!rawJson) {
    return null;
  }

  try {
    const parsed = JSON.parse(removeCodeFence(rawJson)) as ConversationStatePayload;
    return normalizeStatePayload(parsed, previousState);
  } catch (error) {
    log.warn({ error, rawPreview: rawJson.slice(0, 300) }, 'Failed to parse conversation state response');
    return null;
  }
}

function buildStateUpdatePrompt(previousState: ConversationState, transcript: string): string {
  const compactPreviousState = {
    currentTopic: previousState.currentTopic,
    shortSummary: previousState.shortSummary,
    openQuestions: previousState.openQuestions,
    recentDecisions: previousState.recentDecisions,
  };

  return `Update the meeting state using the transcript excerpt.

Return strict JSON with exactly these keys:
- currentTopic (string)
- shortSummary (string, max 2 sentences)
- openQuestions (array of short strings, max 4)
- recentDecisions (array of short strings, max 4)

openQuestions rules:
- ONLY include questions or uncertainties explicitly raised by a participant that remain genuinely unanswered.
- A question counts as answered even if the answer is approximate (e.g. "early April" answers "when?").
- Include genuinely pending external outcomes only when explicitly flagged as unresolved (e.g. "I need CFO approval" = pending; "I'll send it by EOD" = committed, not open).
- When a question from the previous state has been answered, REMOVE it.
- Do NOT invent follow-up questions, speculate about what might be asked, or reframe action items/directives as questions.
- If no questions are genuinely unresolved, return an empty array [].

recentDecisions rules:
- ONLY include explicit decisions, agreements, or committed action items.
- Do NOT include observations, acknowledgments, or descriptions of past work.

Keep it compact (~200-300 tokens total). No markdown.

Previous state:
${JSON.stringify(compactPreviousState)}

Transcript excerpt:
${transcript.slice(-TRANSCRIPT_WINDOW_CHARS)}`;
}

function scheduleDebouncedUpdate(botId: string): void {
  const tracker = trackersByBot.get(botId);
  if (!tracker || tracker.debounceTimer) {
    return;
  }

  tracker.debounceTimer = setTimeout(() => {
    const latestTracker = trackersByBot.get(botId);
    if (!latestTracker) {
      return;
    }
    latestTracker.debounceTimer = null;
    fireAndForget(runStateUpdate(botId), 'meetingBot.conversationStateService.line214');
  }, UPDATE_DEBOUNCE_MS);
}

async function runStateUpdate(botId: string): Promise<void> {
  const tracker = trackersByBot.get(botId);
  if (!tracker || !deps) {
    return;
  }

  if (tracker.updateInFlight) {
    tracker.dirty = true;
    return;
  }

  if (!tracker.dirty) {
    return;
  }

  if (!isConversationStateEnabled()) {
    tracker.dirty = false;
    return;
  }

  const activeBotState = deps.getActiveBotState();
  if (!activeBotState || activeBotState.botId !== botId) {
    tracker.dirty = false;
    return;
  }

  const transcript = deps.getTranscriptBuffer(botId);
  if (!transcript || transcript.trim().length === 0) {
    tracker.dirty = false;
    return;
  }

  const transcriptHash = hashTranscriptTail(transcript, HASH_WINDOW_CHARS);
  if (tracker.lastTranscriptHash === transcriptHash) {
    tracker.dirty = false;
    return;
  }

  tracker.updateInFlight = true;
  tracker.dirty = false;

  try {
    const settings = getSettings();
    const response = await callBehindTheScenesWithAuth(
      settings,
      {
        messages: [
          {
            role: 'user',
            content: buildStateUpdatePrompt(tracker.state, transcript),
          },
        ],
        system: getPrompt(PROMPT_IDS.UTILITY_MEETING_CONVERSATION_STATE),
        maxTokens: 1024,
        timeout: 15000,
      },
      { category: 'meeting-state' },
    );

    const parsedState = parseConversationStateResponse(response, tracker.state);
    if (!parsedState) {
      // Parse failed -- don't set dirty or advance hash. The next proactive
      // timer tick (~30s) will call requestStateUpdate which sets dirty and
      // retries with potentially more transcript content. Avoids hot retry loop.
      return;
    }

    const latestTracker = trackersByBot.get(botId);
    if (!latestTracker) {
      return;
    }

    latestTracker.state = parsedState;
    latestTracker.lastTranscriptHash = transcriptHash;
    log.debug(
      {
        botId,
        topic: parsedState.currentTopic,
        openQuestions: parsedState.openQuestions.length,
        recentDecisions: parsedState.recentDecisions.length,
      },
      'Updated conversation state',
    );
  } catch (error) {
    log.warn({ botId, error: error instanceof Error ? error.message : String(error) }, 'Conversation state update failed');
  } finally {
    const latestTracker = trackersByBot.get(botId);
    if (!latestTracker) {
      return;
    }

    latestTracker.updateInFlight = false;

    if (latestTracker.dirty) {
      fireAndForget(runStateUpdate(botId), 'meetingBot.conversationStateService.line312');
    }
  }
}

export function initializeConversationStateService(dependencies: ConversationStateDeps): void {
  deps = dependencies;
}

export function getConversationState(botId: string): ConversationState | null {
  const tracker = trackersByBot.get(botId);
  return tracker ? cloneState(tracker.state) : null;
}

export function requestStateUpdate(botId: string): void {
  const tracker = trackersByBot.get(botId);
  if (!tracker || !deps) {
    return;
  }

  if (!isConversationStateEnabled()) {
    return;
  }

  tracker.dirty = true;

  if (tracker.updateInFlight) {
    return;
  }

  scheduleDebouncedUpdate(botId);
}

// TODO(Stage 1B): Accept optional persisted state for restart recovery.
// On restart, load from pendingTranscriptsStore.conversationState,
// validate timestamp (>5 min stale → start fresh), then seed here.
export function startStateTracking(botId: string): void {
  if (!trackersByBot.has(botId)) {
    trackersByBot.set(botId, {
      state: createInitialState(),
      lastTranscriptHash: null,
      updateInFlight: false,
      dirty: false,
      debounceTimer: null,
    });
  }

  requestStateUpdate(botId);
}

export function stopStateTracking(botId: string): ConversationState | null {
  const tracker = trackersByBot.get(botId);
  if (!tracker) {
    return null;
  }

  if (tracker.debounceTimer) {
    clearTimeout(tracker.debounceTimer);
  }

  const finalState = cloneState(tracker.state);
  trackersByBot.delete(botId);
  return finalState;
}


