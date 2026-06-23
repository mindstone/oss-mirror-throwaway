/**
 * Live Meeting Coach Service
 * 
 * Orchestrates proactive coaching during live meetings:
 * - Runs analysis every N minutes (configurable, default: 2)
 * - Delivers tips via agent turns to companion conversation
 */

import { createScopedLogger } from '@core/logger';
import type { OperatorRegistry } from '@core/services/operatorRegistry';
import type { HeadlessTurnOptions } from '@core/types/headlessTurnOptions';
import type { AgentEvent } from '@shared/types';
import type { BrowserWindow } from 'electron';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as operatorRegistry from '@core/services/operatorRegistry';
import { agentTurnRegistry } from './agentTurnRegistry';
import { getSettings } from '@core/services/settingsStore';
import { callBehindTheScenesWithAuth, type BehindTheScenesResponse } from './behindTheScenesClient';
import { dispatchAgentErrorEvent, dispatchAgentEvent } from './agentEventDispatcher';
import { formatMeetingContext, requestStateUpdate, type ConversationState } from './meetingBot/conversationStateService';
import { removeCodeFence, extractTextFromBtsResponse, hashTranscriptTail } from './meetingBot/btsResponseUtils';
import { getMeetingVoiceInstructions } from '@core/services/meetingVoiceService';
import { createPausableInterval } from './visibilityAwareScheduler';
import { resolveMeetingCoachPrompt } from './meetingCoachPromptResolver';
import { parseOperatorFrontmatterFromContent } from '@shared/schemas/operatorFrontmatter';

const log = createScopedLogger({ service: 'live-coach' });

// Minimum interval between analyses (prevent spam)
const MIN_INTERVAL_MS = 30 * 1000;

// Store last analysis timestamp per bot
const lastAnalysisTimeByBot = new Map<string, number>();

// Store hash of last analyzed transcript tail (to detect new content even if buffer trims)
const lastAnalyzedHashByBot = new Map<string, string>();

// Store last event-driven trigger timestamp per bot (debounce)
const lastEventTriggerTimeByBot = new Map<string, number>();

// Store when coach was set for each bot (for initial countdown calculation)
const coachStartTimeByBot = new Map<string, number>();

// Store in-flight participant contribution turns per bot (prevent overlap)
const participantTurnInFlight = new Map<string, boolean>();

// Track consecutive ignored proactive contributions per bot (for adaptive frequency)
const consecutiveIgnored = new Map<string, number>();

// Threshold: after this many consecutive ignored contributions, double the proactive interval
const BACKOFF_THRESHOLD = 3;

const EVENT_DEBOUNCE_MS = 45_000; // 45s for question/decision
const TENSION_DEBOUNCE_MS = 90_000; // 90s for tension

// Quality gate constants
const QUALITY_GATE_TIMEOUT_MS = 30000;
const QUALITY_GATE_MAX_TOKENS = 4096;
const QUALITY_GATE_SCORE_THRESHOLD = 0.7;
const MAX_RECENT_ANGLES = 5;

// Track recently surfaced contribution angles per bot (for novelty scoring)
const recentContributionAngles = new Map<string, string[]>();

// ---------------------------------------------------------------------------
// Coaching activity metrics (per bot)
// Logged as a structured summary at meeting end for system tuning.
// ---------------------------------------------------------------------------
interface CoachingMetrics {
  tipsDelivered: number;
  contributionsQueued: number;
  contributionsSkippedByGate: number;
  contributionsSkippedLegacy: number;
  eventTriggersReceived: number;
}

const coachingMetricsByBot = new Map<string, CoachingMetrics>();

function getOrCreateMetrics(botId: string): CoachingMetrics {
  let metrics = coachingMetricsByBot.get(botId);
  if (!metrics) {
    metrics = {
      tipsDelivered: 0,
      contributionsQueued: 0,
      contributionsSkippedByGate: 0,
      contributionsSkippedLegacy: 0,
      eventTriggersReceived: 0,
    };
    coachingMetricsByBot.set(botId, metrics);
  }
  return metrics;
}

// Timer reference for cleanup
let proactiveTimer: (() => void) | null = null;

// Dependency injection for agent turn execution
export type LiveCoachDeps = {
  executeAgentTurn: (
    win: BrowserWindow | null,
    turnId: string,
    prompt: string,
    options: {
      sessionId: string;
      resetConversation?: boolean;
      isSystemContinuation?: boolean;
      /**
       * Proactive coaching is NOT a user-initiated turn — set so the
       * Chief-of-Staff admission gate never blocks / pops recovery UI mid-meeting
       * (260622 Stage 3). See turnAdmission.admit.
       */
      nonInteractiveTurn?: boolean;
      getMeetingCompanionContext?: (sessionId: string) => Promise<{
        currentCoachPath: string | null;
        lastInjectedCoachPath: string | null | undefined;
        coachSkillContent?: string;
      } | null>;
      setLastInjectedCoachPath?: (sessionId: string, coachPath: string | null) => void;
    }
  ) => Promise<void>;
  runHeadlessTurn: (params: {
    prompt: string;
    onEvent: (event: AgentEvent) => void;
    options: HeadlessTurnOptions;
  }) => Promise<void>;
  queueContribution: (botId: string, text: string, metadata?: {
    scores?: { relevance: number; helpfulness: number; timing: number };
    triggerType?: string;
    triggerExcerpt?: string;
  }) => boolean;
  getTranscriptBuffer: (botId: string) => string | null;
  getConversationState: (botId: string) => ConversationState | null;
  getWindow: () => BrowserWindow | null;
  /** Get the active bot state - injected to avoid circular dependency with meetingBotService */
  getActiveBotState: () => {
    botId: string;
    coachSkillPath?: string;
    companionSessionId?: string;
    presenceMode?: 'silent' | 'coach' | 'participant';
    coachPrompt?: string;
    coachContentHash?: string;
    coachPromptSource?: 'operator-frontmatter' | 'file-body';
    coachProactiveIntervalMinutes?: number;
    coachPromptLastModifiedMs?: number;
  } | null;
  /** Get meeting companion context for tool hint injection (same as agentTurnExecutor option) */
  getMeetingCompanionContext?: (sessionId: string) => Promise<{
    currentCoachPath: string | null;
    lastInjectedCoachPath: string | null | undefined;
    coachSkillContent?: string;
  } | null>;
  /** Callback to update lastInjectedCoachPath after injection */
  setLastInjectedCoachPath?: (sessionId: string, coachPath: string | null) => void;
  /** Check whether the knowledge base toggle is enabled for a bot */
  isKnowledgeAccessEnabled?: (botId: string) => boolean;
  /** Check and expire stale pending proactive contributions (topic drift) */
  checkStalePending?: (botId: string) => boolean;
};

let deps: LiveCoachDeps | null = null;

type ActiveCoachState = NonNullable<ReturnType<LiveCoachDeps['getActiveBotState']>>;

const meetingCoachOperatorRegistry: OperatorRegistry = {
  listAvailable: operatorRegistry.listAvailable,
  listAvailableWithDiagnostics: operatorRegistry.listAvailableWithDiagnostics,
  getById: operatorRegistry.getById,
  invalidate: operatorRegistry.invalidateOperatorRegistry,
};

async function refreshCachedCoachPrompt(activeBotState: ActiveCoachState): Promise<void> {
  if (!activeBotState.coachSkillPath) {
    return;
  }

  const originalCoachSkillPath = activeBotState.coachSkillPath;

  let currentMtimeMs: number | undefined;
  let statError: unknown;
  try {
    const stat = await fs.stat(originalCoachSkillPath);
    currentMtimeMs = stat.mtimeMs;
  } catch (error) {
    statError = error;
    // Ignore here; we decide below whether this is actionable based on the latest state.
  }

  const latestActiveBotState = deps?.getActiveBotState();
  if (
    !latestActiveBotState ||
    latestActiveBotState.botId !== activeBotState.botId ||
    latestActiveBotState.coachSkillPath !== originalCoachSkillPath
  ) {
    log.info(
      {
        botId: activeBotState.botId,
        reason: 'coach_changed_during_refresh',
        originalCoachSkillPath,
        currentCoachSkillPath: latestActiveBotState?.coachSkillPath,
      },
      'operators:meeting_coach_refresh_aborted',
    );
    return;
  }

  const hasCachedPrompt = typeof latestActiveBotState.coachPrompt === 'string' && latestActiveBotState.coachPrompt.trim().length > 0;
  const hasCachedHash = typeof latestActiveBotState.coachContentHash === 'string' && latestActiveBotState.coachContentHash.length > 0;

  if (currentMtimeMs === undefined && !hasCachedPrompt) {
    log.warn(
      { botId: latestActiveBotState.botId, coachSkillPath: originalCoachSkillPath, error: statError },
      'Failed to stat coach prompt file',
    );
  }

  const mtimeChanged = currentMtimeMs !== undefined && latestActiveBotState.coachPromptLastModifiedMs !== currentMtimeMs;
  const shouldResolve = !hasCachedPrompt || !hasCachedHash || mtimeChanged;
  if (!shouldResolve) {
    return;
  }

  // Mid-meeting toggle OFF guard: if the operator's `live_meeting` role was
  // removed while a coach session is active, the resolver would silently fall
  // back to the file body and hot-swap the prompt. Per plan, we keep the
  // cached coach for the active meeting so the user-experienced coaching does
  // not change unexpectedly mid-call. New meetings see the updated registry.
  if (
    hasCachedPrompt
    && hasCachedHash
    && latestActiveBotState.coachPromptSource === 'operator-frontmatter'
    && path.basename(originalCoachSkillPath) === 'OPERATOR.md'
  ) {
    try {
      const fileContent = await fs.readFile(originalCoachSkillPath, 'utf-8');
      const parsed = parseOperatorFrontmatterFromContent(fileContent);
      if (parsed.success && !parsed.frontmatter.roles.includes('live_meeting')) {
        log.warn(
          {
            botId: latestActiveBotState.botId,
            coachSkillPath: originalCoachSkillPath,
            cachedContentHash: latestActiveBotState.coachContentHash,
          },
          'operators:meeting_coach_role_removed_during_active_meeting',
        );
        if (currentMtimeMs !== undefined) {
          latestActiveBotState.coachPromptLastModifiedMs = currentMtimeMs;
        }
        return;
      }
    } catch (error) {
      log.warn(
        { botId: latestActiveBotState.botId, coachSkillPath: originalCoachSkillPath, error },
        'operators:meeting_coach_role_removal_check_failed',
      );
    }
  }

  const previousHash = latestActiveBotState.coachContentHash;
  const resolvedPrompt = resolveMeetingCoachPrompt(originalCoachSkillPath, meetingCoachOperatorRegistry);
  latestActiveBotState.coachPrompt = resolvedPrompt.prompt;
  latestActiveBotState.coachContentHash = resolvedPrompt.contentHash;
  latestActiveBotState.coachPromptSource = resolvedPrompt.source;
  latestActiveBotState.coachProactiveIntervalMinutes = resolvedPrompt.proactiveIntervalMinutes;
  if (currentMtimeMs !== undefined) {
    latestActiveBotState.coachPromptLastModifiedMs = currentMtimeMs;
  }

  if (previousHash && previousHash !== resolvedPrompt.contentHash) {
    log.info(
      { botId: latestActiveBotState.botId, previous: previousHash, current: resolvedPrompt.contentHash },
      'operators:meeting_coach_content_hash_changed',
    );
    if (deps?.setLastInjectedCoachPath && latestActiveBotState.companionSessionId) {
      deps.setLastInjectedCoachPath(latestActiveBotState.companionSessionId, null);
    }
  }
}

/**
 * Initialize the live coach service with dependencies
 */
export function initializeLiveCoachService(dependencies: LiveCoachDeps): void {
  deps = dependencies;
  log.info('Live coach service initialized');
}

/**
 * Late-bind meeting companion context callbacks.
 * Called after registerAgentHandlers extracts the shared callbacks,
 * so coaching turns get the same tool-hint injection as user turns.
 */
export function updateLiveCoachMeetingContext(
  getMeetingCompanionContext: NonNullable<LiveCoachDeps['getMeetingCompanionContext']>,
  setLastInjectedCoachPath: NonNullable<LiveCoachDeps['setLastInjectedCoachPath']>,
): void {
  if (deps) {
    deps.getMeetingCompanionContext = getMeetingCompanionContext;
    deps.setLastInjectedCoachPath = setLastInjectedCoachPath;
    log.info('Meeting companion context callbacks wired for coaching turns');
  }
}

/**
 * Start the proactive analysis timer
 */
export function startProactiveTimer(): void {
  if (proactiveTimer) {
    return; // Already running
  }

  proactiveTimer = createPausableInterval(async () => {
    try {
      await runProactiveCheck();
    } catch (error) {
      log.error({ error }, 'Error in proactive analysis check');
    }
  }, MIN_INTERVAL_MS, {
    pauseOnBlur: true,
    catchUpPriority: 6,
    // Keep alive during active meetings -- user is likely in Zoom, not Rebel
    shouldKeepAlive: () => deps?.getActiveBotState() != null,
  });

  log.info('Proactive analysis timer started');
}

/**
 * Run a proactive analysis check
 */
async function runProactiveCheck(): Promise<void> {
  if (!deps) {
    return;
  }

  const activeBotState = deps.getActiveBotState();

  if (!activeBotState?.coachSkillPath) {
    return;
  }

  const presenceMode = activeBotState.presenceMode ?? (activeBotState.coachSkillPath ? 'coach' : 'silent');

  if (presenceMode === 'silent') {
    return;
  }
  
  if (presenceMode === 'coach' && !activeBotState.companionSessionId) {
    return;
  }

  try {
    await refreshCachedCoachPrompt(activeBotState);
  } catch (error) {
    log.warn({ botId: activeBotState.botId, coachSkillPath: activeBotState.coachSkillPath, error }, 'Failed to refresh cached coach prompt');
  }

  const { botId, companionSessionId } = activeBotState;
  const now = Date.now();
  requestStateUpdate(botId);

  // Expire stale pending contributions before deciding whether to generate new ones.
  // Runs on every tick (30s) so staleness is caught promptly.
  if (presenceMode === 'participant') {
    deps.checkStalePending?.(botId);
  }

  if (presenceMode === 'coach' && companionSessionId) {
    // Check if the companion session already has an active turn (avoid concurrent turns in same session)
    if (agentTurnRegistry.hasActiveTurnForSession(companionSessionId)) {
      log.debug({ botId, companionSessionId }, 'Skipping proactive analysis - companion session has active turn');
      return;
    }
  }

  // Get the configured interval (default 2 minutes)
  const settings = getSettings();
  const configuredProactiveIntervalMinutes = activeBotState.coachProactiveIntervalMinutes
    ?? settings.meetingBot?.coachProactiveIntervalMinutes
    ?? 2;
  const clampedProactiveIntervalMinutes = Math.min(60, Math.max(1, configuredProactiveIntervalMinutes));
  if (clampedProactiveIntervalMinutes !== configuredProactiveIntervalMinutes) {
    log.info(
      {
        botId,
        original: configuredProactiveIntervalMinutes,
        clamped: clampedProactiveIntervalMinutes,
      },
      'operators:proactive_interval_clamped',
    );
  }
  let intervalMs = clampedProactiveIntervalMinutes * 60 * 1000;

  // Adaptive backoff: double interval when user has ignored several contributions in a row
  const ignored = consecutiveIgnored.get(botId) ?? 0;
  if (ignored >= BACKOFF_THRESHOLD) {
    intervalMs *= 2;
    log.debug({ botId, ignored, effectiveIntervalMs: intervalMs }, 'Proactive interval backed off (contributions ignored)');
  }

  // Check if enough time has passed since last analysis (or since coach was set for first run)
  const lastAnalysis = lastAnalysisTimeByBot.get(botId);
  const coachStartTime = coachStartTimeByBot.get(botId);
  const referenceTime = lastAnalysis ?? coachStartTime ?? 0;
  if (now - referenceTime < intervalMs) {
    return;
  }

  // Get transcript buffer
  const transcript = deps.getTranscriptBuffer(botId);
  if (!transcript || transcript.trim().length === 0) {
    log.debug({ botId }, 'Skipping proactive analysis - no transcript');
    return;
  }

  // Check if transcript has changed since last analysis (using hash to handle buffer trimming)
  const currentHash = hashTranscriptTail(transcript);
  const lastHash = lastAnalyzedHashByBot.get(botId);
  if (lastHash === currentHash) {
    log.debug({ botId }, 'Skipping proactive analysis - no new transcript content');
    return;
  }

  log.info({ botId, transcriptLength: transcript.length }, 'Running proactive analysis');

  try {
    if (presenceMode === 'coach' && companionSessionId) {
      // Run coaching check via normal agent turn
      await deliverProactiveTip(companionSessionId, botId);
      lastAnalysisTimeByBot.set(botId, now);
      lastAnalyzedHashByBot.set(botId, currentHash);
    } else if (presenceMode === 'participant') {
      const processed = await deliverProactiveContribution(activeBotState);
      if (processed) {
        lastAnalysisTimeByBot.set(botId, now);
        lastAnalyzedHashByBot.set(botId, currentHash);
      }
    }
    
  } catch (error) {
    log.error({ botId, error }, 'Failed to run proactive analysis');
  }
}

export function handleHighSignalUtterance(
  botId: string,
  triggerType: string,
  utteranceExcerpt: string
): void {
  if (getSettings().meetingBot?.enableEventDrivenTriggers === false) {
    return;
  }
  if (!deps) {
    return;
  }

  const activeBotState = deps.getActiveBotState();
  if (!activeBotState || activeBotState.botId !== botId) {
    return;
  }

  const presenceMode = activeBotState.presenceMode ?? (activeBotState.coachSkillPath ? 'coach' : 'silent');
  if (presenceMode === 'silent') {
    return;
  }
  if (presenceMode === 'coach' && !activeBotState.companionSessionId) {
    return;
  }

  const debounceMs = triggerType === 'tension' ? TENSION_DEBOUNCE_MS : EVENT_DEBOUNCE_MS;
  const lastTrigger = lastEventTriggerTimeByBot.get(botId) ?? 0;
  if (Date.now() - lastTrigger < debounceMs) {
    return;
  }

  if (presenceMode === 'coach' && activeBotState.companionSessionId) {
    if (agentTurnRegistry.hasActiveTurnForSession(activeBotState.companionSessionId)) {
      return;
    }
  }

  const now = Date.now();
  lastEventTriggerTimeByBot.set(botId, now);
  lastAnalysisTimeByBot.set(botId, now);
  requestStateUpdate(botId);
  getOrCreateMetrics(botId).eventTriggersReceived++;

  log.info({ botId, triggerType, excerptLength: utteranceExcerpt.length }, 'Event-driven coaching trigger');

  if (presenceMode === 'coach' && activeBotState.companionSessionId) {
    void deliverProactiveTip(activeBotState.companionSessionId, botId, { triggerType, utteranceExcerpt }).catch(err => {
      log.error({ botId, error: err }, 'Event-driven coaching tip failed');
    });
  } else if (presenceMode === 'participant') {
    void deliverProactiveContribution(activeBotState, { triggerType, utteranceExcerpt }).catch(err => {
      log.error({ botId, error: err }, 'Event-driven contribution failed');
    });
  }
}

interface QualityGateScores {
  relevance: number;
  helpfulness: number;
  timing: number;
}

interface QualityGateResult {
  scores: QualityGateScores;
  contribution: string | null;
}

function parseQualityGateResponse(response: BehindTheScenesResponse): QualityGateResult | null {
  const rawJson = extractTextFromBtsResponse(response);
  if (!rawJson) {
    return null;
  }

  try {
    const parsed = JSON.parse(removeCodeFence(rawJson)) as Record<string, unknown>;

    const scores = parsed.scores as Record<string, unknown> | undefined;
    if (!scores || typeof scores !== 'object') {
      return null;
    }

    const relevance = Number(scores.relevance);
    const helpfulness = Number(scores.helpfulness);
    const timing = Number(scores.timing);

    if ([relevance, helpfulness, timing].some((s) => Number.isNaN(s) || s < 0 || s > 1)) {
      return null;
    }

    const contribution = typeof parsed.contribution === 'string' && parsed.contribution.trim().length > 0
      ? parsed.contribution.trim()
      : null;

    return { scores: { relevance, helpfulness, timing }, contribution };
  } catch (error) {
    log.warn({ error, rawPreview: rawJson.slice(0, 300) }, 'Failed to parse quality gate response');
    return null;
  }
}

function buildRecentAnglesBlock(botId: string): string {
  const angles = recentContributionAngles.get(botId);
  if (!angles || angles.length === 0) {
    return '';
  }
  return `[RECENTLY SURFACED ANGLES]\n${angles.map((a, i) => `${i + 1}. ${a}`).join('\n')}\n[/RECENTLY SURFACED ANGLES]\nAvoid repeating these angles. Offer a fresh perspective.\n`;
}

function recordContributionAngle(botId: string, contribution: string): void {
  // Extract first sentence as the angle summary
  const firstSentence = contribution.match(/^[^.!?]*[.!?]/)?.[0] ?? contribution.slice(0, 120);
  const angles = recentContributionAngles.get(botId) ?? [];
  angles.push(firstSentence);
  if (angles.length > MAX_RECENT_ANGLES) {
    angles.shift();
  }
  recentContributionAngles.set(botId, angles);
}

async function deliverProactiveContribution(
  activeBotState: ActiveCoachState,
  triggerContext?: { triggerType: string; utteranceExcerpt: string },
): Promise<boolean> {
  if (!deps || !activeBotState.coachSkillPath) {
    return false;
  }

  const { botId, coachSkillPath } = activeBotState;

  if (participantTurnInFlight.get(botId)) {
    log.debug({ botId }, 'Skipping proactive contribution - participant turn already in flight');
    return false;
  }

  participantTurnInFlight.set(botId, true);

  try {
    try {
      await refreshCachedCoachPrompt(activeBotState);
    } catch (error) {
      log.warn({ botId, coachSkillPath, error }, 'Failed to resolve coach prompt - skipping contribution');
      return false;
    }

    const coachSkillContent = activeBotState.coachPrompt?.trim() ?? '';
    if (!coachSkillContent) {
      log.warn({ botId, coachSkillPath }, 'Resolved coach prompt was empty - skipping contribution');
      return false;
    }

    const transcriptText = deps.getTranscriptBuffer(botId);
    if (!transcriptText || transcriptText.trim().length === 0) {
      log.debug({ botId }, 'Skipping proactive contribution - no transcript');
      return false;
    }
    const meetingContextBlock = formatMeetingContext(deps.getConversationState(botId));

    const ownerName = getSettings().userFirstName?.trim() || 'User';
    const triggerContextBlock = triggerContext
      ? `[TRIGGER] The other participant just said: "${triggerContext.utteranceExcerpt}" (${triggerContext.triggerType}).
Review your knowledge and coaching approach — is there something actionable to suggest right now?

`
      : '';

    // When knowledge base is enabled, use full agentic loop (tools, spaces, memory)
    if (deps.isKnowledgeAccessEnabled?.(botId)) {
      return await deliverViaAgenticLoop(botId, ownerName, coachSkillContent, transcriptText, meetingContextBlock, triggerContextBlock, triggerContext);
    }

    const settings = getSettings();
    const useQualityGate = settings.meetingBot?.enableQualityGate !== false;

    if (useQualityGate) {
      return await deliverViaQualityGate(botId, ownerName, coachSkillContent, transcriptText, meetingContextBlock, triggerContextBlock, triggerContext);
    }

    // Legacy [SKIP]/[CONTRIBUTE] binary path (kill switch fallback)
    return await deliverViaLegacyPath(botId, ownerName, coachSkillContent, transcriptText, meetingContextBlock, triggerContextBlock, triggerContext);
  } catch (error) {
    log.error({ botId, error }, 'Failed to generate proactive contribution');
    return false;
  } finally {
    participantTurnInFlight.delete(botId);
  }
}

/**
 * Agentic loop path (two-stage): knowledge search + quality gate.
 *
 * Stage 1 — A headless agent turn with full tool access searches the user's
 *   spaces, memory, and meeting prep for relevant context. The agent returns
 *   raw findings (not a ready-to-speak contribution).
 *
 * Stage 2 — The raw findings are injected into the existing quality gate BTS
 *   call, which scores relevance/helpfulness/timing and drafts a concise
 *   spoken contribution. This reuses the same structured-JSON format as the
 *   non-knowledge path, so the ContributionPill UI works identically.
 */
async function deliverViaAgenticLoop(
  botId: string,
  ownerName: string,
  coachSkillContent: string,
  transcriptText: string,
  meetingContextBlock: string,
  triggerContextBlock: string,
  triggerContext?: { triggerType: string; utteranceExcerpt: string },
): Promise<boolean> {
  if (!deps) {
    return false;
  }

  // --- Stage 1: Knowledge search via agentic turn ---
  const knowledgeFindings = await searchKnowledgeForContribution(
    botId, ownerName, coachSkillContent, transcriptText, meetingContextBlock, triggerContextBlock,
  );

  if (knowledgeFindings === null) {
    return false; // Error during search
  }

  // Verify mode hasn't changed during the agent turn
  const refreshedActiveBotState = deps.getActiveBotState();
  const refreshedMode = refreshedActiveBotState?.presenceMode
    ?? (refreshedActiveBotState?.coachSkillPath ? 'coach' : 'silent');
  if (!refreshedActiveBotState || refreshedActiveBotState.botId !== botId || refreshedMode !== 'participant') {
    log.debug({ botId, refreshedMode }, 'Discarding agentic contribution - mode changed during knowledge search');
    return false;
  }

  // --- Stage 2: Quality gate scoring with knowledge context ---
  return await deliverViaQualityGate(
    botId, ownerName, coachSkillContent, transcriptText, meetingContextBlock,
    triggerContextBlock, triggerContext, knowledgeFindings,
  );
}

/**
 * Stage 1 of the knowledge-enabled path: run a headless agent turn to search
 * spaces, memory, and meeting prep. Returns raw findings text, or null on error.
 */
async function searchKnowledgeForContribution(
  botId: string,
  ownerName: string,
  coachSkillContent: string,
  transcriptText: string,
  meetingContextBlock: string,
  triggerContextBlock: string,
): Promise<string | null> {
  if (!deps) {
    return null;
  }

  const prompt = `**MEETING KNOWLEDGE SEARCH**

${ownerName} is in a live meeting. Search their spaces and memory for information relevant to the current discussion.

${coachSkillContent ? `[COACHING APPROACH]\n${coachSkillContent}\n[/COACHING APPROACH]\n\n` : ''}${meetingContextBlock ? `${meetingContextBlock}\n\n` : ''}[MEETING TRANSCRIPT]
${transcriptText}
[/MEETING TRANSCRIPT]

${triggerContextBlock}
Search ${ownerName}'s spaces and memory for relevant information — prior meetings, notes, prep materials, data, or context related to what's being discussed.

**Response requirements:**
- Summarise what you found that is relevant to the current discussion
- Include specific facts, dates, numbers, or context from the knowledge base
- If nothing relevant was found, say "NO_RELEVANT_FINDINGS"
- Do NOT draft a spoken contribution — just report what you found`;

  let responseText = '';
  let sawError = false;

  try {
    const sessionId = `meeting-kb-search-${randomUUID()}`;
    await deps.runHeadlessTurn({
      prompt,
      onEvent: (event: AgentEvent) => {
        if (event.type === 'assistant' && event.text) {
          responseText = event.text.trim();
        } else if (event.type === 'result' && 'text' in event && event.text) {
          responseText = (event.text as string).trim();
        } else if (event.type === 'error') {
          sawError = true;
          log.error({ botId, error: event.error }, 'Error during knowledge search turn');
        }
      },
      options: {
        sessionType: 'automation',
        persistMode: { kind: 'none' },
        sessionId,
        resetConversation: true,
      },
    });
  } catch (error) {
    log.error({ botId, error: error instanceof Error ? error.message : String(error) }, 'Knowledge search turn failed');
    return null;
  }

  if (sawError || !responseText) {
    return null;
  }

  if (/NO_RELEVANT_FINDINGS/i.test(responseText)) {
    log.debug({ botId }, 'Knowledge search found nothing relevant');
    return ''; // Empty string = no findings, quality gate will likely score low
  }

  log.info({ botId, findingsLength: responseText.length }, 'Knowledge search returned findings');
  return responseText;
}

/**
 * Quality gate path: combined scoring + generation in a single BTS call.
 * Returns structured JSON with scores and contribution text.
 *
 * When `knowledgeFindings` is provided (from the agentic search stage),
 * they are injected into the prompt so the gate can incorporate facts from
 * the user's knowledge base into its contribution draft.
 */
async function deliverViaQualityGate(
  botId: string,
  ownerName: string,
  coachSkillContent: string,
  transcriptText: string,
  meetingContextBlock: string,
  triggerContextBlock: string,
  triggerContext?: { triggerType: string; utteranceExcerpt: string },
  knowledgeFindings?: string,
): Promise<boolean> {
  if (!deps) {
    return false;
  }

  const recentAnglesBlock = buildRecentAnglesBlock(botId);
  const knowledgeFindingsBlock = knowledgeFindings
    ? `[KNOWLEDGE BASE FINDINGS]\n${knowledgeFindings}\n[/KNOWLEDGE BASE FINDINGS]\nUse these findings to strengthen the contribution if they are relevant.\n\n`
    : '';

  const prompt = `You are a quality gate for meeting contributions. Evaluate whether the following contribution opportunity is worth speaking aloud.

${getMeetingVoiceInstructions()}

${coachSkillContent ? `[COACHING APPROACH]\n${coachSkillContent}\n[/COACHING APPROACH]\n\n` : ''}${meetingContextBlock ? `${meetingContextBlock}\n\n` : ''}[MEETING TRANSCRIPT]
${transcriptText}
[/MEETING TRANSCRIPT]

${triggerContextBlock}${recentAnglesBlock}${knowledgeFindingsBlock}
${ownerName}'s AI colleague is considering speaking. Score this opportunity and, if warranted, draft a contribution written as a direct participant (first person, addressing the room).

Return strict JSON:
{"scores": {"relevance": <0-1>, "helpfulness": <0-1>, "timing": <0-1>}, "contribution": "<1-3 sentences>" | null}

Scoring guide:
- relevance: How relevant is a contribution to the current discussion? (0 = off-topic, 1 = directly addresses the point)
- helpfulness: Would this add genuine value? (0 = restating obvious, 1 = unique insight or factual addition)
- timing: Is NOW the right moment? (0 = conversation moved on, 1 = perfectly timed)

If any score is below 0.7, set contribution to null.
IMPORTANT: The contribution will be spoken aloud. Do NOT share confidential information about ${ownerName}.`;

  try {
    const settings = getSettings();
    const response = await callBehindTheScenesWithAuth(
      settings,
      {
        messages: [{ role: 'user', content: prompt }],
        system: 'You are a meeting contribution quality gate. Return strict JSON only.',
        maxTokens: QUALITY_GATE_MAX_TOKENS,
        timeout: QUALITY_GATE_TIMEOUT_MS,
      },
      { category: 'coaching' },
    );

    const result = parseQualityGateResponse(response);
    if (!result) {
      log.warn({ botId }, 'Quality gate: failed to parse response - skipping contribution');
      return true;
    }

    const { scores, contribution } = result;
    log.info(
      { botId, relevance: scores.relevance, helpfulness: scores.helpfulness, timing: scores.timing, hasContribution: !!contribution, hasKnowledge: !!knowledgeFindings },
      'Quality gate scores',
    );

    // Check all scores clear the threshold
    if (
      scores.relevance < QUALITY_GATE_SCORE_THRESHOLD ||
      scores.helpfulness < QUALITY_GATE_SCORE_THRESHOLD ||
      scores.timing < QUALITY_GATE_SCORE_THRESHOLD
    ) {
      log.debug({ botId, scores }, 'Quality gate: below threshold - skipping contribution');
      getOrCreateMetrics(botId).contributionsSkippedByGate++;
      return true;
    }

    if (!contribution) {
      log.debug({ botId }, 'Quality gate: scores cleared but contribution is null - skipping');
      getOrCreateMetrics(botId).contributionsSkippedByGate++;
      return true;
    }

    // Verify mode hasn't changed during the BTS call
    const refreshedActiveBotState = deps.getActiveBotState();
    const refreshedMode = refreshedActiveBotState?.presenceMode
      ?? (refreshedActiveBotState?.coachSkillPath ? 'coach' : 'silent');
    if (!refreshedActiveBotState || refreshedActiveBotState.botId !== botId || refreshedMode !== 'participant') {
      log.debug({ botId, refreshedMode }, 'Discarding quality gate contribution - mode changed during generation');
      return false;
    }

    const queued = deps.queueContribution(botId, contribution, {
      scores,
      triggerType: triggerContext?.triggerType,
      triggerExcerpt: triggerContext?.utteranceExcerpt,
    });
    if (!queued) {
      log.debug({ botId }, 'Failed to queue quality gate contribution');
      return true;
    }

    recordContributionAngle(botId, contribution);
    getOrCreateMetrics(botId).contributionsQueued++;
    log.info({ botId, contributionLength: contribution.length, knowledgeEnabled: !!knowledgeFindings }, 'Queued quality-gated contribution');
    return true;
  } catch (error) {
    log.error({ botId, error: error instanceof Error ? error.message : String(error) }, 'Quality gate BTS call failed - skipping contribution');
    return true;
  }
}

/**
 * Legacy [SKIP]/[CONTRIBUTE] binary path.
 * Used as fallback when quality gate is disabled via kill switch.
 */
async function deliverViaLegacyPath(
  botId: string,
  ownerName: string,
  coachSkillContent: string,
  transcriptText: string,
  meetingContextBlock: string,
  triggerContextBlock: string,
  triggerContext?: { triggerType: string; utteranceExcerpt: string },
): Promise<boolean> {
  if (!deps) {
    return false;
  }

  const prompt = `You are participating in a live meeting as ${ownerName}'s AI colleague.

${getMeetingVoiceInstructions()}

${coachSkillContent ? `[COACHING APPROACH]\n${coachSkillContent}\n[/COACHING APPROACH]\n\n` : ''}${meetingContextBlock ? `${meetingContextBlock}\n\n` : ''}[MEETING TRANSCRIPT]
${transcriptText}
[/MEETING TRANSCRIPT]

IMPORTANT: Your response will be spoken aloud in front of all meeting participants.
Do NOT share confidential or sensitive information about ${ownerName}.

${triggerContextBlock}Review the transcript. If there is something valuable you can contribute to this discussion RIGHT NOW, draft a concise response (1-3 sentences) written as a direct participant addressing the room.

You MUST respond with exactly one of:
[SKIP] — nothing warrants contribution right now
[CONTRIBUTE] <your 1-3 sentence contribution>

Focus on: factual additions, relevant context, contradictions, unanswered questions, data from prep.
Do NOT contribute if: someone already made the point, the conversation is flowing well, or you'd be restating the obvious.`;

  let responseText = '';
  let sawError = false;

  const sessionId = `meeting-participation-${randomUUID()}`;
  await deps.runHeadlessTurn({
    prompt,
    onEvent: (event: AgentEvent) => {
      if (event.type === 'assistant' && event.text) {
        responseText = event.text.trim();
      } else if (event.type === 'result' && 'text' in event && event.text) {
        responseText = (event.text as string).trim();
      } else if (event.type === 'error') {
        sawError = true;
        log.error({ botId, error: event.error }, 'Error during proactive participation turn');
      }
    },
    options: {
      sessionType: 'automation',
      persistMode: { kind: 'none' },
      sessionId,
      resetConversation: true,
    },
  });

  if (sawError) {
    return false;
  }

  const refreshedActiveBotState = deps.getActiveBotState();
  const refreshedMode = refreshedActiveBotState?.presenceMode
    ?? (refreshedActiveBotState?.coachSkillPath ? 'coach' : 'silent');

  if (!refreshedActiveBotState || refreshedActiveBotState.botId !== botId || refreshedMode !== 'participant') {
    log.debug({ botId, refreshedMode }, 'Discarding proactive contribution - mode changed during generation');
    return false;
  }

  const trimmedResponse = responseText.trim();
  if (!trimmedResponse) {
    log.debug({ botId }, 'Discarding proactive contribution - empty response');
    return true;
  }

  if (/^\[SKIP\]/i.test(trimmedResponse)) {
    log.debug({ botId }, 'Proactive contribution skipped by model');
    getOrCreateMetrics(botId).contributionsSkippedLegacy++;
    return true;
  }

  const contributeMatch = trimmedResponse.match(/^\[CONTRIBUTE\]\s*([\s\S]*)$/i);
  if (!contributeMatch) {
    log.debug({ botId, responsePreview: trimmedResponse.slice(0, 120) }, 'Discarding proactive contribution - invalid prefix');
    return true;
  }

  const contribution = contributeMatch[1]?.trim();
  if (!contribution) {
    log.debug({ botId }, 'Discarding proactive contribution - empty contribution after prefix');
    return true;
  }

  const queued = deps.queueContribution(botId, contribution, {
    triggerType: triggerContext?.triggerType,
    triggerExcerpt: triggerContext?.utteranceExcerpt,
  });
  if (!queued) {
    log.debug({ botId }, 'Failed to queue proactive contribution');
    return true;
  }

  getOrCreateMetrics(botId).contributionsQueued++;
  log.info({ botId, contributionLength: contribution.length }, 'Queued proactive contribution (legacy path)');
  return true;
}

/**
 * Deliver a proactive coaching check via normal agent turn.
 * Uses a standard user message so the user can see the loop happening.
 * 
 * NOTE: The meeting companion context (coach skill + tool hint) is injected
 * by the agentTurnExecutor, so we just send the coaching check prompt here.
 * The executor will add the coach context on first turn or when coach changes.
 */
async function deliverProactiveTip(
  companionSessionId: string,
  botId: string,
  triggerContext?: { triggerType: string; utteranceExcerpt: string }
): Promise<void> {
  if (!deps) {
    return;
  }

  const win = deps.getWindow();
  if (!win) {
    log.warn('No window available for tip delivery');
    return;
  }

  const meetingContextBlock = formatMeetingContext(deps.getConversationState(botId));
  const triggerContextBlock = triggerContext
    ? `[TRIGGER] The other participant just said: "${triggerContext.utteranceExcerpt}" (${triggerContext.triggerType}).
Review your knowledge and coaching approach — is there something actionable to suggest right now?

`
    : '';

  // Simple coaching check prompt - context injection handled by executor
  const userMessage = `[Coaching check]

${triggerContextBlock}${meetingContextBlock ? `${meetingContextBlock}\n\n` : ''}
Review the transcript and provide coaching if there's something actionable right now. If you notice a coaching opportunity that's relevant RIGHT NOW, provide a brief, actionable tip (1-3 sentences). Focus on what I should do or say NEXT.

If nothing notable warrants coaching at this moment, just say "Nothing to add right now" or similar - keep it brief.`;

  const turnId = randomUUID();

  try {
    // Register turn->session mapping BEFORE dispatching event so it routes correctly
    agentTurnRegistry.setRendererSession(turnId, companionSessionId);
    
    // Dispatch user_message event first so renderer adds the user message to the conversation
    dispatchAgentEvent(win, turnId, {
      type: 'user_message',
      text: userMessage,
      isHidden: false, // Show coaching check prompts to user
      timestamp: Date.now(),
    });
    
    await deps.executeAgentTurn(win, turnId, userMessage, {
      sessionId: companionSessionId,
      resetConversation: false,
      getMeetingCompanionContext: deps.getMeetingCompanionContext,
      setLastInjectedCoachPath: deps.setLastInjectedCoachPath,
      // Proactive coaching check — NOT a user-initiated conversation turn. The
      // Chief-of-Staff admission gate must not block / pop recovery UI mid-meeting
      // on a flaky drive (260622 Stage 3). See turnAdmission.admit.
      nonInteractiveTurn: true,
    });
    
    getOrCreateMetrics(botId).tipsDelivered++;
    log.info({ companionSessionId, turnId }, 'Proactive coaching check delivered');
  } catch (error) {
    log.error({ companionSessionId, turnId, error }, 'Failed to deliver proactive coaching check');
    // Dispatch error event so session doesn't stay stuck busy
    dispatchAgentErrorEvent(win, turnId, error);
  }
}

/**
 * Report the outcome of a proactive contribution.
 * Resets the counter when a contribution is spoken (user engaged),
 * increments when ignored (cleared or overwritten).
 */
export function reportContributionOutcome(botId: string, spoken: boolean): void {
  if (spoken) {
    consecutiveIgnored.set(botId, 0);
    log.debug({ botId }, 'Proactive contribution spoken — reset backoff counter');
  } else {
    const count = (consecutiveIgnored.get(botId) ?? 0) + 1;
    consecutiveIgnored.set(botId, count);
    log.debug({ botId, consecutiveIgnored: count }, 'Proactive contribution ignored');
  }
}

/**
 * Reset analysis state for a bot (call when meeting ends).
 * Logs a structured coaching activity summary before clearing state.
 */
export function resetBotCoachState(botId: string): void {
  // Log coaching activity summary before clearing (useful for system tuning)
  const metrics = coachingMetricsByBot.get(botId);
  if (metrics) {
    const totalActivity = metrics.tipsDelivered + metrics.contributionsQueued
      + metrics.contributionsSkippedByGate + metrics.contributionsSkippedLegacy
      + metrics.eventTriggersReceived;

    if (totalActivity > 0) {
      log.info(
        {
          botId,
          tipsDelivered: metrics.tipsDelivered,
          contributionsQueued: metrics.contributionsQueued,
          contributionsSkippedByGate: metrics.contributionsSkippedByGate,
          contributionsSkippedLegacy: metrics.contributionsSkippedLegacy,
          eventTriggersReceived: metrics.eventTriggersReceived,
        },
        'Coaching session summary',
      );
    }
  }

  lastAnalysisTimeByBot.delete(botId);
  lastAnalyzedHashByBot.delete(botId);
  lastEventTriggerTimeByBot.delete(botId);
  coachStartTimeByBot.delete(botId);
  participantTurnInFlight.delete(botId);
  consecutiveIgnored.delete(botId);
  recentContributionAngles.delete(botId);
  coachingMetricsByBot.delete(botId);
  log.debug({ botId }, 'Reset coach state for bot');
}

/**
 * Record when a coach was set for a bot (for countdown calculation)
 */
export function setCoachStartTime(botId: string): void {
  coachStartTimeByBot.set(botId, Date.now());
}


