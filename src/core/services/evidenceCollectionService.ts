/**
 * Evidence Collection Service
 *
 * Analyzes completed sessions to detect AI fluency signals for tier progression.
 * Uses Haiku (behind-the-scenes) calls to identify qualitative patterns.
 * 
 * Signals are split into:
 * - LLM-detected: Qualitative patterns requiring analysis
 * - Metric-based: Evaluated directly from counters (handled in tierEvaluator)
 * - Cross-session: Weekly patterns (handled in weeklyAssessmentService)
 */

import type { AppSettings, AgentSession } from '@shared/types';
import { createScopedLogger } from '@core/logger';
import { callBehindTheScenesWithAuth } from './behindTheScenesClient';
import { safeJsonParseFromModelText } from '@shared/utils/safeJsonParse';
import { recordEvidence, type EvidenceSignal } from './achievementsStore';
import { getPrompt, PROMPT_IDS } from '@core/services/promptFileService';
import { resolveCodexConnectivity } from '@core/rebelCore/codexConnectivity';

const log = createScopedLogger({ service: 'evidenceCollection' });

const EVIDENCE_TIMEOUT_MS = 30000;
const MIN_CONFIDENCE_THRESHOLD = 80;

// LLM-detected signals (qualitative patterns requiring analysis)
const LLM_DETECTED_SIGNALS: EvidenceSignal[] = [
  'multi_turn_conversation',
  'skill_used',
  'memory_consulted',
  'context_provided',
  'correction_given',
  'delegation_success',
  'parallel_execution'
];

const EVIDENCE_JSON_SCHEMA = {
  type: 'object',
  properties: {
    signals: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          signal: {
            type: 'string',
            enum: LLM_DETECTED_SIGNALS,
            description: 'The detected fluency signal'
          },
          confidence: {
            type: 'number',
            description: 'Confidence 0-100. Only report if 80+'
          },
          proof: {
            type: 'string',
            description: 'Brief quote or reference from the conversation'
          }
        },
        required: ['signal', 'confidence', 'proof']
      }
    }
  },
  required: ['signals'],
  additionalProperties: false
};

interface EvidenceResponse {
  signals: Array<{
    signal: string;
    confidence: number;
    proof: string;
  }>;
}

const buildPrompt = (transcript: string, toolsUsed: string[]): string => {
  return getPrompt(PROMPT_IDS.INTELLIGENCE_EVIDENCE_COLLECTION, {
    transcript,
    tools_used: toolsUsed.length > 0 ? toolsUsed.join(', ') : 'None',
  });
};

/**
 * Collect evidence signals from a completed session.
 * Fire-and-forget pattern - errors are logged but don't propagate.
 */
export async function collectSessionEvidence(
  session: AgentSession,
  settings: AppSettings
): Promise<void> {
  const { id: sessionId, messages } = session;

  if (messages.length < 4) {
    log.debug({ sessionId, messageCount: messages.length }, 'Skipping evidence collection: conversation too short');
    return;
  }

  // Build transcript (limit text length per message to control token usage)
  const transcript = messages
    .map(m => `[${m.role}]: ${m.text?.slice(0, 500) ?? ''}`)
    .join('\n\n');

  // Extract tools used from events
  const toolEvents = Object.values(session.eventsByTurn ?? {})
    .flat()
    .filter(e => e.type === 'tool');
  const toolsUsed = [...new Set(
    toolEvents.map(e => (e as { toolName?: string }).toolName).filter(Boolean)
  )] as string[];

  log.info({ sessionId, messageCount: messages.length, toolCount: toolsUsed.length }, 'Starting evidence collection');

  try {
    const prompt = buildPrompt(transcript, toolsUsed);

    const response = await callBehindTheScenesWithAuth(settings, {
      codexConnectivity: resolveCodexConnectivity(),
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 512,
      outputFormat: {
        type: 'json_schema',
        schema: EVIDENCE_JSON_SCHEMA
      },
      timeout: EVIDENCE_TIMEOUT_MS
    }, { category: 'evidence', sessionId });

    // Use find() pattern - response.content may have multiple blocks
    const textBlock = response.content.find((block) => block.type === 'text');
    if (!textBlock?.text) {
      log.warn({ sessionId }, 'Empty response from evidence collection');
      return;
    }

    const parsed = safeJsonParseFromModelText<EvidenceResponse>(
      textBlock.text,
      'evidenceCollection.collect',
      log
    );
    if (!parsed?.signals) {
      log.debug({ sessionId }, 'No signals array in response');
      return;
    }

    let recordedCount = 0;
    for (const { signal, confidence, proof } of parsed.signals) {
      // Validate signal is in our enum
      if (!LLM_DETECTED_SIGNALS.includes(signal as EvidenceSignal)) {
        log.warn({ sessionId, signal }, 'Unknown signal in response, skipping');
        continue;
      }

      if (confidence >= MIN_CONFIDENCE_THRESHOLD) {
        recordEvidence(signal as EvidenceSignal, sessionId, { proof, confidence });
        recordedCount++;
      }
    }

    log.info({ sessionId, signalsDetected: parsed.signals.length, signalsRecorded: recordedCount }, 'Evidence collection completed');
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    log.error({ sessionId, error: errMsg }, 'Evidence collection failed');
    // Fire-and-forget: don't rethrow
  }
}
