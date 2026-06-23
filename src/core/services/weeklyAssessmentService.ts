/**
 * Weekly Assessment Service
 *
 * Analyzes sessions from the past week to detect cross-session AI fluency patterns.
 * Runs weekly (e.g., Sunday morning) to identify signals like technique consistency.
 * 
 * Cross-session signals detected:
 * - technique_consistency: Same technique used in 5+ sessions
 * - increasing_complexity: Request sophistication trending up
 * - high_efficiency_pattern: Multiple high-efficiency sessions
 */

import type { AppSettings, AgentSession } from '@shared/types';
import { createScopedLogger } from '@core/logger';
import { callBehindTheScenesWithAuth } from './behindTheScenesClient';
import { safeJsonParseFromModelText } from '@shared/utils/safeJsonParse';
import { recordEvidence, type EvidenceSignal } from './achievementsStore';
import { getIncrementalSessionStore } from './incrementalSessionStore';
import { getPrompt, PROMPT_IDS } from '@core/services/promptFileService';
import { resolveCodexConnectivity } from '@core/rebelCore/codexConnectivity';

const log = createScopedLogger({ service: 'weeklyAssessment' });

const ASSESSMENT_TIMEOUT_MS = 45000;
const MIN_CONFIDENCE_THRESHOLD = 80;
const MIN_SESSIONS_REQUIRED = 5;
const MAX_SESSIONS_TO_ANALYZE = 20;
const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// Cross-session signals (weekly assessment only)
const CROSS_SESSION_SIGNALS: EvidenceSignal[] = [
  'technique_consistency',
  'increasing_complexity',
  'high_efficiency_pattern'
];

const WEEKLY_ASSESSMENT_SCHEMA = {
  type: 'object',
  properties: {
    signals: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          signal: {
            type: 'string',
            enum: CROSS_SESSION_SIGNALS,
            description: 'The detected cross-session pattern'
          },
          confidence: {
            type: 'number',
            description: 'Confidence 0-100. Only report if 80+'
          },
          proof: {
            type: 'string',
            description: 'Brief explanation of the pattern observed'
          }
        },
        required: ['signal', 'confidence', 'proof']
      }
    }
  },
  required: ['signals'],
  additionalProperties: false
};

interface WeeklyAssessmentResponse {
  signals: Array<{
    signal: string;
    confidence: number;
    proof: string;
  }>;
}

interface SessionSummary {
  date: string;
  messageCount: number;
  toolCount: number;
  durationMinutes: number;
  topics: string[];
}

const buildPrompt = (sessions: SessionSummary[]): string => {
  const sessionList = sessions.map((s, i) => 
    `Session ${i + 1} (${s.date}): ${s.messageCount} messages, ${s.toolCount} tools, ${s.durationMinutes}min, topics: ${s.topics.join(', ') || 'general'}`
  ).join('\n');

  return getPrompt(PROMPT_IDS.INTELLIGENCE_WEEKLY_ASSESSMENT, { sessions: sessionList });
};

/**
 * Run weekly assessment to detect cross-session patterns.
 * Should be scheduled to run weekly (e.g., Sunday morning).
 */
export async function runWeeklyAssessment(settings: AppSettings): Promise<void> {
  log.info('Starting weekly assessment');

  try {
    const store = getIncrementalSessionStore();
    // Weekly assessment should analyze user-visible sessions only.
    const summaries = store.listSessions();

    // Filter to sessions from past week, sort by resolvedAt descending
    const weekAgo = Date.now() - ONE_WEEK_MS;
    const recentSessions = summaries
      .filter(s => s.resolvedAt && s.resolvedAt > weekAgo)
      .sort((a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0));

    if (recentSessions.length < MIN_SESSIONS_REQUIRED) {
      log.debug(
        { sessionCount: recentSessions.length, required: MIN_SESSIONS_REQUIRED },
        'Not enough sessions for weekly assessment'
      );
      return;
    }

    // Load full sessions for analysis (limit to control costs)
    const sessionIds = recentSessions.slice(0, MAX_SESSIONS_TO_ANALYZE).map(s => s.id);
    const loadedSessions = (await Promise.all(
      sessionIds.map(id => store.getSession(id).catch(err => {
        log.warn({ sessionId: id, error: err.message }, 'Failed to load session');
        return null;
      }))
    )).filter((s): s is AgentSession => s !== null);

    if (loadedSessions.length < MIN_SESSIONS_REQUIRED) {
      log.warn(
        { loaded: loadedSessions.length, attempted: sessionIds.length },
        'Failed to load enough sessions for assessment'
      );
      return;
    }

    // Build session summaries for LLM
    const sessionSummaries: SessionSummary[] = loadedSessions.map(s => {
      const toolEvents = Object.values(s.eventsByTurn ?? {})
        .flat()
        .filter(e => e.type === 'tool');
      
      // Extract rough topics from first user message
      const firstUserMsg = s.messages.find(m => m.role === 'user')?.text ?? '';
      const topics = extractTopics(firstUserMsg);

      return {
        date: new Date(s.resolvedAt ?? s.createdAt).toISOString().split('T')[0],
        messageCount: s.messages.length,
        toolCount: toolEvents.length,
        durationMinutes: Math.round(((s.resolvedAt ?? s.updatedAt) - s.createdAt) / 60000),
        topics
      };
    });

    const prompt = buildPrompt(sessionSummaries);

    const response = await callBehindTheScenesWithAuth(settings, {
      codexConnectivity: resolveCodexConnectivity(),
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 512,
      outputFormat: {
        type: 'json_schema',
        schema: WEEKLY_ASSESSMENT_SCHEMA
      },
      timeout: ASSESSMENT_TIMEOUT_MS
    }, { category: 'weekly_assessment' });

    // Use find() pattern - response.content may have multiple blocks
    const textBlock = response.content.find((block) => block.type === 'text');
    if (!textBlock?.text) {
      log.warn('Empty response from weekly assessment');
      return;
    }

    const parsed = safeJsonParseFromModelText<WeeklyAssessmentResponse>(
      textBlock.text,
      'weeklyAssessment.run',
      log
    );
    if (!parsed?.signals) {
      log.debug('No signals array in weekly assessment response');
      return;
    }

    let recordedCount = 0;
    for (const { signal, confidence, proof } of parsed.signals) {
      // Validate signal is in our enum
      if (!CROSS_SESSION_SIGNALS.includes(signal as EvidenceSignal)) {
        log.warn({ signal }, 'Unknown cross-session signal, skipping');
        continue;
      }

      if (confidence >= MIN_CONFIDENCE_THRESHOLD) {
        recordEvidence(signal as EvidenceSignal, undefined, {
          proof,
          confidence,
          assessmentType: 'weekly',
          sessionsAnalyzed: loadedSessions.length
        });
        recordedCount++;
      }
    }

    log.info(
      { signalsDetected: parsed.signals.length, signalsRecorded: recordedCount, sessionsAnalyzed: loadedSessions.length },
      'Weekly assessment completed'
    );
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    log.error({ error: errMsg }, 'Weekly assessment failed');
    // Fire-and-forget: don't rethrow
  }
}

/**
 * Extract rough topic keywords from message text.
 * Simple heuristic for LLM context.
 */
function extractTopics(text: string): string[] {
  const cleaned = text.slice(0, 200).toLowerCase();
  const keywords: string[] = [];
  
  // Look for common task patterns
  if (cleaned.includes('email') || cleaned.includes('mail')) keywords.push('email');
  if (cleaned.includes('meeting') || cleaned.includes('calendar')) keywords.push('meetings');
  if (cleaned.includes('research') || cleaned.includes('find')) keywords.push('research');
  if (cleaned.includes('write') || cleaned.includes('draft')) keywords.push('writing');
  if (cleaned.includes('analyze') || cleaned.includes('analysis')) keywords.push('analysis');
  if (cleaned.includes('code') || cleaned.includes('programming')) keywords.push('coding');
  if (cleaned.includes('plan') || cleaned.includes('strategy')) keywords.push('planning');
  
  return keywords.slice(0, 3);
}
