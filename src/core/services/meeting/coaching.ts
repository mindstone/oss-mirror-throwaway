/**
 * Meeting Coaching Engine — Server-side live coaching during meetings
 *
 * Runs a per-session timer that periodically analyzes the rolling transcript
 * and delivers coaching tips via the event channel. Adapted from the desktop
 * `liveCoachService.ts` patterns but runs entirely server-side.
 *
 * Features:
 * - Idempotent activation (calling twice replaces the existing timer)
 * - Quality gate: only delivers tips with relevance >= 0.7
 * - Adaptive backoff: doubles interval after 3 consecutive ignored tips
 * - Push notification fallback when no WS clients connected
 * - Self-healing: timer recovery on chunk upload if coaching.active but no timer
 */

import { createHash } from 'node:crypto';
import { createScopedLogger } from '@core/logger';
import { getSettings } from '@core/services/settingsStore';
import { callBehindTheScenesWithAuth } from '@core/services/behindTheScenesClient';
import { hashSessionId } from '@shared/trackingTypes';
import { getRollingTranscript, getConversationState } from './transcription';

const log = createScopedLogger({ service: 'meeting-coaching-engine' });

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes
const QUALITY_GATE_SCORE_THRESHOLD = 0.7;
const QUALITY_GATE_TIMEOUT_MS = 15000;
const QUALITY_GATE_MAX_TOKENS = 1024;
const BACKOFF_THRESHOLD = 3;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CoachingState {
  active: boolean;
  skillId: string;
  skillName: string;
  intervalMs: number;
  consecutiveIgnored: number;
  lastAnalysisAt?: string;
  lastTranscriptHash?: string;
}

export interface CoachingCard {
  sessionId: string;
  tip: string;
  skillName: string;
  timestamp: number;
  cardId: string;
}

export interface MeetingCoachingEngineEnvironment {
  broadcastCoachingCard: (card: CoachingCard) => void;
}

const defaultMeetingCoachingEngineEnvironment: MeetingCoachingEngineEnvironment = {
  broadcastCoachingCard: (card) => {
    log.warn(
      { sessionIdHash: hashSessionId(card.sessionId) },
      'meeting-coaching-card-broadcast-unconfigured',
    );
  },
};

let meetingCoachingEngineEnvironment: MeetingCoachingEngineEnvironment = defaultMeetingCoachingEngineEnvironment;

export function setMeetingCoachingEngineEnvironment(
  updates: Partial<MeetingCoachingEngineEnvironment>,
): void {
  meetingCoachingEngineEnvironment = {
    ...meetingCoachingEngineEnvironment,
    ...updates,
  };
}

function getMeetingCoachingEngineEnvironment(): MeetingCoachingEngineEnvironment {
  return meetingCoachingEngineEnvironment;
}

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------

const activeTimers = new Map<string, NodeJS.Timeout>();
const coachingStates = new Map<string, CoachingState>();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Activate coaching for a meeting session.
 * Idempotent: if a timer already exists for the session, clears old one first.
 */
export function activateCoaching(
  sessionId: string,
  skillId: string,
  skillName: string,
): void {
  // Clear existing timer if present (idempotent)
  deactivateCoaching(sessionId);

  const state: CoachingState = {
    active: true,
    skillId,
    skillName,
    intervalMs: DEFAULT_INTERVAL_MS,
    consecutiveIgnored: 0,
  };
  coachingStates.set(sessionId, state);

  startCoachingTimer(sessionId, state);

  log.info(
    { sessionId, skillId, skillName, intervalMs: state.intervalMs },
    'Coaching activated for meeting session',
  );
}

/**
 * Deactivate coaching for a meeting session. Clears the timer.
 */
export function deactivateCoaching(sessionId: string): void {
  const timer = activeTimers.get(sessionId);
  if (timer) {
    clearInterval(timer);
    activeTimers.delete(sessionId);
  }
  coachingStates.delete(sessionId);

  log.info({ sessionId }, 'Coaching deactivated for meeting session');
}

/**
 * Ensure coaching timer is running if coaching is marked active.
 * Self-healing: called on chunk upload to recover from server restart.
 */
export function ensureCoachingTimerIfActive(sessionId: string): void {
  const state = coachingStates.get(sessionId);
  if (state?.active && !activeTimers.has(sessionId)) {
    log.info({ sessionId }, 'Recovering coaching timer (self-healing)');
    startCoachingTimer(sessionId, state);
  }
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function startCoachingTimer(sessionId: string, state: CoachingState): void {
  const timer = setInterval(() => {
    void runCoachingTick(sessionId).catch((err) => {
      log.error(
        { sessionId, error: err instanceof Error ? err.message : String(err) },
        'Coaching tick failed',
      );
    });
  }, state.intervalMs);

  // Allow Node.js to exit even if timer is active
  timer.unref?.();
  activeTimers.set(sessionId, timer);
}

function hashTranscriptTail(transcript: string): string {
  const tail = transcript.slice(-500);
  return createHash('sha256').update(tail).digest('hex').slice(0, 16);
}

async function runCoachingTick(sessionId: string): Promise<void> {
  const state = coachingStates.get(sessionId);
  if (!state?.active) return;
  const sessionIdHash = hashSessionId(sessionId);

  // Check if new transcript content since last analysis
  const transcript = getRollingTranscript(sessionId);
  if (transcript === undefined) {
    log.debug({ sessionIdHash }, 'Skipping coaching tick — no transcription state');
    return;
  }
  if (transcript.trim().length === 0) {
    log.debug({ sessionIdHash }, 'Skipping coaching tick — no transcript');
    return;
  }

  const currentHash = hashTranscriptTail(transcript);
  if (state.lastTranscriptHash === currentHash) {
    log.debug({ sessionIdHash }, 'Skipping coaching tick — no new transcript content');
    return;
  }

  log.info({ sessionIdHash, transcriptLength: transcript.length }, 'Running coaching analysis');

  const settings = getSettings();
  const conversationState = getConversationState(sessionId);

  // Build conversation state block
  let conversationStateBlock = '';
  if (conversationState) {
    const parts: string[] = [];
    if (conversationState.currentTopic) parts.push(`Topic: ${conversationState.currentTopic}`);
    if (conversationState.summary) parts.push(`Summary: ${conversationState.summary}`);
    if (conversationState.openQuestions?.length) {
      parts.push(`Open questions: ${conversationState.openQuestions.join('; ')}`);
    }
    if (conversationState.recentDecisions?.length) {
      parts.push(`Recent decisions: ${conversationState.recentDecisions.join('; ')}`);
    }
    if (parts.length > 0) {
      conversationStateBlock = `[CONVERSATION STATE]\n${parts.join('\n')}\n[/CONVERSATION STATE]\n\n`;
    }
  }

  // Use last ~2000 words for the coaching prompt
  const words = transcript.split(/\s+/);
  const recentTranscript = words.length > 2000
    ? words.slice(-2000).join(' ')
    : transcript;

  const prompt = `You are a meeting coach using the "${state.skillName}" coaching approach.
Analyze the recent transcript and provide ONE actionable insight.
The user is in a meeting and will see this as a brief notification.

${conversationStateBlock}[RECENT TRANSCRIPT]
${recentTranscript}
[/RECENT TRANSCRIPT]

Reply as JSON: { "tip": "one sentence tip", "relevance": 0.0-1.0, "skip": true/false }
If you have nothing useful to say, set skip: true.`;

  try {
    const response = await callBehindTheScenesWithAuth(
      settings,
      {
        codexConnectivity: 'unsupported',
        messages: [{ role: 'user', content: prompt }],
        system: 'You are a meeting coaching engine. Return strict JSON only.',
        maxTokens: QUALITY_GATE_MAX_TOKENS,
        timeout: QUALITY_GATE_TIMEOUT_MS,
      },
      { category: 'coaching' },
    );

    const textContent = response.content
      .flatMap((block) => (block.type === 'text' && typeof block.text === 'string' ? [block.text] : []))
      .join('\n')
      .trim();

    if (!textContent) {
      log.debug({ sessionIdHash }, 'Empty coaching response — skipping');
      state.lastTranscriptHash = currentHash;
      state.lastAnalysisAt = new Date().toISOString();
      return;
    }

    // Strip markdown fences if present
    const cleaned = textContent
      .replace(/^```(?:json)?\s*\n?/, '')
      .replace(/\n?\s*```$/, '')
      .trim();

    const parsed = JSON.parse(cleaned) as Record<string, unknown>;

    const tip = typeof parsed.tip === 'string' ? parsed.tip.trim() : '';
    const relevance = typeof parsed.relevance === 'number' ? parsed.relevance : 0;
    const skip = parsed.skip === true;

    state.lastTranscriptHash = currentHash;
    state.lastAnalysisAt = new Date().toISOString();

    // Quality gate
    if (skip || relevance < QUALITY_GATE_SCORE_THRESHOLD || !tip) {
      log.debug(
        { sessionIdHash, relevance, skip, hasTip: !!tip },
        'Coaching tip filtered by quality gate',
      );
      state.consecutiveIgnored++;

      // Adaptive backoff: double interval after threshold
      if (state.consecutiveIgnored >= BACKOFF_THRESHOLD && !hasBackedOff(state)) {
        const oldInterval = state.intervalMs;
        state.intervalMs *= 2;
        restartTimer(sessionId, state);
        log.info(
          { sessionId, oldInterval, newInterval: state.intervalMs, consecutiveIgnored: state.consecutiveIgnored },
          'Coaching interval doubled (adaptive backoff)',
        );
      }
      return;
    }

    // Deliver coaching card via event channel
    const card: CoachingCard = {
      sessionId,
      tip,
      skillName: state.skillName,
      timestamp: Date.now(),
      cardId: `coach-${sessionId}-${Date.now()}`,
    };

    getMeetingCoachingEngineEnvironment().broadcastCoachingCard(card);

    // Reset backoff counter on successful delivery
    state.consecutiveIgnored = 0;

    log.info(
      { sessionId, relevance, tipLength: tip.length },
      'Coaching card delivered',
    );
  } catch (err) {
    log.error(
      { sessionId, error: err instanceof Error ? err.message : String(err) },
      'Coaching BTS call failed — skipping this tick',
    );
    state.consecutiveIgnored++;
  }
}

function hasBackedOff(state: CoachingState): boolean {
  return state.intervalMs > DEFAULT_INTERVAL_MS;
}

function restartTimer(sessionId: string, state: CoachingState): void {
  const oldTimer = activeTimers.get(sessionId);
  if (oldTimer) {
    clearInterval(oldTimer);
    activeTimers.delete(sessionId);
  }
  startCoachingTimer(sessionId, state);
}
