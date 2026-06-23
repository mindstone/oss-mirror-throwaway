import type { AppSettings, AgentTurnMessage } from '@shared/types';

import { createScopedLogger } from '@core/logger';
import { hasValidAuth } from '../utils/authEnvUtils';
import { unwrapCompactionArtifact } from '../utils/compactionUtils';
import { callBehindTheScenesWithAuth, SelfImposedRateLimitError } from './behindTheScenesClient';
import { getPrompt, PROMPT_IDS } from '@core/services/promptFileService';
import { resolveCodexConnectivity } from '@core/rebelCore/codexConnectivity';

const log = createScopedLogger({ service: 'compaction' });

const SUMMARY_TIMEOUT_MS = 30000;
const SUMMARY_MAX_CHARS = 4000;
const NARRATIVE_TRANSCRIPT_MAX_CHARS = 1000;
const FALLBACK_NARRATIVE_SYSTEM_PROMPT = 'You are a context preservation assistant. Summarize conversation history concisely while preserving goals, decisions, file paths, tool names, and remaining work. Output only the summary.';

export interface CompactionTranscriptEntry {
  role: 'user' | 'assistant' | 'result';
  text: string;
}

const formatTranscript = (transcript: CompactionTranscriptEntry[]): string => {
  return transcript
    .map((entry) => {
      const label = entry.role === 'user' ? 'User' : entry.role === 'result' ? 'Summary' : 'Assistant';
      const text = entry.text.length > 2000 ? entry.text.slice(0, 2000) + '... [truncated]' : entry.text;
      return `${label}:\n${text}`;
    })
    .join('\n\n');
};

const messagesToTranscript = (messages: AgentTurnMessage[]): CompactionTranscriptEntry[] => {
  return messages
    .filter((m) => m.text && m.text.trim().length > 0)
    .map((m) => ({
      role: m.role as 'user' | 'assistant' | 'result',
      text: m.text
    }));
};

/** @deprecated Use getPrompt(PROMPT_IDS.CONVERSATION_COMPACTION) inside functions instead */
export const COMPACTION_SYSTEM_PROMPT = [
  'You are a context preservation assistant. Your job is to summarize conversations so they can continue seamlessly.',
  'Rules:',
  '- Capture the user\'s original goal and any sub-tasks.',
  '- Note what was accomplished and what remains to be done.',
  '- Preserve any important decisions, constraints, or preferences mentioned.',
  '- Keep technical details that would be needed to continue the work.',
  '- Be concise but complete - aim for 500-1500 words.',
  '- Write in a way that allows the conversation to resume naturally.',
  '- Output only the summary, no preamble or explanation.'
].join('\n');

export async function generateCompactionSummary(
  settings: AppSettings,
  messages: AgentTurnMessage[],
  largeToolNames?: string[]
): Promise<string | null> {
  if (!Array.isArray(messages) || messages.length === 0) {
    log.warn('Cannot generate compaction summary: no messages provided');
    return null;
  }

  if (!hasValidAuth(settings)) {
    throw new Error('Claude API key or OAuth token is missing.');
  }

  const transcript = messagesToTranscript(messages);
  if (transcript.length === 0) {
    log.warn('Cannot generate compaction summary: transcript is empty');
    return null;
  }

  const transcriptBlock = formatTranscript(transcript);
  const toolWarning = largeToolNames && largeToolNames.length > 0
    ? `\n\nNote: The following tools returned very large outputs and should be used with output limits: ${largeToolNames.join(', ')}`
    : '';

  const prompt = [
    'Summarize the following conversation so it can continue in a new session:',
    '',
    transcriptBlock,
    toolWarning,
    '',
    'Write a comprehensive summary that preserves the context needed to continue this conversation.'
  ].join('\n');

  let summary = '';
  try {
    log.info({ messageCount: messages.length }, 'Generating compaction summary');

    const response = await callBehindTheScenesWithAuth(
      settings,
      {
        codexConnectivity: resolveCodexConnectivity(),
        messages: [{ role: 'user', content: prompt }],
        system: getPrompt(PROMPT_IDS.CONVERSATION_COMPACTION),
        maxTokens: SUMMARY_MAX_CHARS,
        timeout: SUMMARY_TIMEOUT_MS,
      },
      { category: 'compaction' }
    );

    summary = response.content?.[0]?.text?.trim() ?? '';
  } catch (error) {
    // Self-imposed rate-limit skip: degrade gracefully instead of surfacing
    // "Context overflow recovery failed" to the user. The agent turn will
    // retry compaction on the next turn when cooldown expires.
    if (error instanceof SelfImposedRateLimitError) {
      log.warn({ remainingMs: error.resetAtMs ? error.resetAtMs - Date.now() : undefined },
        'Compaction summary skipped — rate-limit cooldown active');
      return null;
    }
    const message = error instanceof Error ? error.message.toLowerCase() : '';
    if (message.includes('timed out')) {
      log.warn('Compaction summary generation timed out');
      throw new Error('Compaction summary generation timed out.');
    }
    throw error;
  }

  const trimmed = summary.trim();
  if (!trimmed) {
    log.warn('Claude returned an empty compaction summary');
    return null;
  }

  if (trimmed.length > SUMMARY_MAX_CHARS) {
    log.info({ originalLength: trimmed.length }, 'Truncating compaction summary');
    return trimmed.slice(0, SUMMARY_MAX_CHARS) + '...';
  }

  log.info({ summaryLength: trimmed.length }, 'Compaction summary generated successfully');
  return trimmed;
}


// =============================================================================
// Intelligent Context Compaction (Sliding Window + BTS Compression)
//
// New modular architecture that preserves recent turns verbatim and compresses
// only older content via behind-the-scenes LLM calls. The original
// generateCompactionSummary() above is preserved for backward compatibility.
// =============================================================================

/** Number of recent turns to keep verbatim in the sliding window */
export const SLIDING_WINDOW_TURNS = 3;

/** Minimum character length for a message to be worth BTS compression */
export const COMPRESSION_THRESHOLD_CHARS = 5000;

/** Min fraction of older messages that must exceed COMPRESSION_THRESHOLD_CHARS for per-message compression to be worthwhile */
export const NARRATIVE_COMPRESSION_RATIO = 0.2;

/** Maximum number of messages to compress in parallel */
export const MAX_PARALLEL_COMPRESSIONS = 5;

/** Timeout for a single BTS compression call (ms) */
export const BTS_COMPRESSION_TIMEOUT_MS = 15000;

/** Reduced window size for depth-2 fallback (when first attempt still overflows) */
export const DEPTH_2_WINDOW_TURNS = 1;
/** Final aggressive fallback: summarize all prior context, keep no verbatim turn window. */
export const DEPTH_3_WINDOW_TURNS = 0;

/**
 * Options for the intelligent summary orchestrator.
 */
export interface IntelligentSummaryOptions {
  /** App settings containing auth credentials for BTS calls */
  settings: AppSettings;
  /** Brief description of the user's task (typically first user message text) */
  taskContext: string;
  /** Compaction depth: 1 = normal, 2 = aggressive, 3 = summarize all prior context */
  depth?: number;
}

/**
 * Split messages into older (compressible) and recent (kept verbatim) groups
 * based on turn boundaries.
 *
 * Uses `turnId` to identify turn groups. The last `windowTurns` unique turns
 * are kept in the recent window; everything else goes to older.
 */
export function splitMessagesByWindow(
  messages: AgentTurnMessage[],
  windowTurns: number
): { older: AgentTurnMessage[]; recent: AgentTurnMessage[] } {
  if (!messages.length) {
    return { older: [], recent: [] };
  }

  if (windowTurns <= 0) {
    return { older: [...messages], recent: [] };
  }

  // Collect unique turnIds preserving first-seen order
  const seenTurnIds = new Set<string>();
  const orderedTurnIds: string[] = [];
  for (const msg of messages) {
    if (!seenTurnIds.has(msg.turnId)) {
      seenTurnIds.add(msg.turnId);
      orderedTurnIds.push(msg.turnId);
    }
  }

  // If all turns fit in the window, nothing to compress
  if (orderedTurnIds.length <= windowTurns) {
    return { older: [], recent: [...messages] };
  }

  const recentTurnIds = new Set(orderedTurnIds.slice(-windowTurns));

  const older: AgentTurnMessage[] = [];
  const recent: AgentTurnMessage[] = [];

  for (const msg of messages) {
    if (recentTurnIds.has(msg.turnId)) {
      recent.push(msg);
    } else {
      older.push(msg);
    }
  }

  return { older, recent };
}

/**
 * Compress a single long message text via BTS.
 *
 * Sends the message to a behind-the-scenes model with task context so
 * the compression preserves task-relevant information. Falls back to
 * simple truncation (first 2000 chars) on timeout or failure.
 */
export async function compressLongMessage(
  text: string,
  taskContext: string,
  settings: AppSettings
): Promise<string> {
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), BTS_COMPRESSION_TIMEOUT_MS);

  try {
    const response = await callBehindTheScenesWithAuth(
      settings,
      {
        codexConnectivity: resolveCodexConnectivity(),
        messages: [
          {
            role: 'user',
            content: [
              `Task context: ${taskContext}`,
              '',
              'Compress the following message to ~20% of its size while preserving all task-relevant information.',
              'Output only the compressed text, no preamble.',
              '',
              '--- MESSAGE TO COMPRESS ---',
              text
            ].join('\n')
          }
        ],
        system: 'You are a context compression assistant. Compress messages while preserving all task-relevant details, decisions, and technical specifics. Be concise but complete.',
        maxTokens: 2048,
        signal: abortController.signal,
        timeout: BTS_COMPRESSION_TIMEOUT_MS,
      },
      {
        category: 'compaction-bts',
      }
    );

    const compressed = response.content?.[0]?.text?.trim();
    if (compressed) {
      log.debug(
        { originalLength: text.length, compressedLength: compressed.length },
        'Message compressed via BTS'
      );
      return compressed;
    }

    // Empty response — fall back to truncation
    log.warn('BTS returned empty compression, falling back to truncation');
    return text.slice(0, 2000) + '\n[...compressed...]';
  } catch (error) {
    log.warn(
      { err: error instanceof Error ? error.message : String(error) },
      'BTS compression failed, falling back to truncation'
    );
    return text.slice(0, 2000) + '\n[...compressed...]';
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Compress long messages in the older portion of a conversation.
 *
 * Identifies messages exceeding COMPRESSION_THRESHOLD_CHARS, compresses
 * up to MAX_PARALLEL_COMPRESSIONS in parallel via BTS, and returns the
 * messages array with long texts replaced by compressed versions.
 * Short messages are returned unchanged.
 */
export async function compressOlderMessages(
  messages: AgentTurnMessage[],
  taskContext: string,
  settings: AppSettings
): Promise<AgentTurnMessage[]> {
  if (!messages.length) return [];

  // Identify messages that exceed the compression threshold
  const compressionTargets = messages
    .map((msg, index) => ({ msg, index }))
    .filter(({ msg }) => msg.text && msg.text.length > COMPRESSION_THRESHOLD_CHARS);

  if (compressionTargets.length === 0) {
    log.debug({ messageCount: messages.length }, 'No messages exceed compression threshold');
    return messages;
  }

  log.info(
    { totalMessages: messages.length, compressible: compressionTargets.length },
    'Compressing long messages in older context'
  );

  // Process ALL targets in batches of MAX_PARALLEL_COMPRESSIONS
  const compressedByIndex = new Map<number, string>();
  let originalTotalChars = 0;
  let compressedTotalChars = 0;

  for (let batchStart = 0; batchStart < compressionTargets.length; batchStart += MAX_PARALLEL_COMPRESSIONS) {
    const batch = compressionTargets.slice(batchStart, batchStart + MAX_PARALLEL_COMPRESSIONS);
    const results = await Promise.allSettled(
      batch.map(({ msg }) => compressLongMessage(msg.text, taskContext, settings))
    );

    let batchSuccessCount = 0;
    let batchFailureCount = 0;
    results.forEach((result, i) => {
      const targetIndex = batch[i].index;
      const originalLength = messages[targetIndex].text.length;
      originalTotalChars += originalLength;

      if (result.status === 'fulfilled') {
        compressedByIndex.set(targetIndex, result.value);
        compressedTotalChars += result.value.length;
        batchSuccessCount++;
      } else {
        const truncated = messages[targetIndex].text.slice(0, 2000) + '\n[...compressed...]';
        compressedByIndex.set(targetIndex, truncated);
        compressedTotalChars += truncated.length;
        batchFailureCount++;
      }
    });

    log.debug({
      batchSize: batch.length,
      successCount: batchSuccessCount,
      failureCount: batchFailureCount,
    }, 'BTS compression batch completed');
  }

  if (originalTotalChars > 0) {
    log.info({
      originalTotalChars,
      compressedTotalChars,
      ratio: (compressedTotalChars / originalTotalChars * 100).toFixed(0) + '%',
    }, 'Older message compression complete');
  }

  // Return messages with long texts replaced by compressed versions
  return messages.map((msg, index) => {
    const compressed = compressedByIndex.get(index);
    if (compressed !== undefined) {
      return { ...msg, text: compressed };
    }
    return msg;
  });
}

function getNarrativeSystemPrompt(): string {
  try {
    return getPrompt(PROMPT_IDS.CONVERSATION_COMPACTION);
  } catch (error) {
    log.debug(
      { error: error instanceof Error ? error.message : String(error) },
      'Compaction prompt unavailable for narrative summary, using fallback prompt'
    );
    return FALLBACK_NARRATIVE_SYSTEM_PROMPT;
  }
}

/**
 * Generate a single narrative summary for many older messages.
 *
 * Falls back to formatted per-message output when BTS summarization fails.
 */
export async function generateNarrativeSummary(
  messages: AgentTurnMessage[],
  taskContext: string,
  settings: AppSettings
): Promise<string> {
  if (messages.length === 0) {
    return '';
  }

  const compressibleCount = messages.filter((m) => m.text.length > COMPRESSION_THRESHOLD_CHARS).length;
  const transcript = messages
    .filter((m) => m.text.trim().length > 0)
    .map((m) => {
      const label = m.role === 'user' ? 'User' : m.role === 'result' ? 'Result' : 'Assistant';
      const truncatedText = m.text.length > NARRATIVE_TRANSCRIPT_MAX_CHARS
        ? `${m.text.slice(0, NARRATIVE_TRANSCRIPT_MAX_CHARS)}...[truncated]`
        : m.text;
      return `[${label}]: ${truncatedText}`;
    })
    .join('\n\n');

  if (!transcript) {
    return '';
  }

  try {
    const response = await callBehindTheScenesWithAuth(
      settings,
      {
        codexConnectivity: resolveCodexConnectivity(),
        messages: [{
          role: 'user',
          content: [
            `Task context: ${taskContext}`,
            '',
            'Summarize these older conversation messages into a concise narrative that preserves continuation-critical context.',
            'Preserve specific file paths, tool names, concrete decisions, constraints, and what remains to be done.',
            'Include unresolved blockers and pending next steps when present.',
            'Output only the summary.',
            '',
            '--- OLDER CONVERSATION ---',
            transcript
          ].join('\n')
        }],
        system: getNarrativeSystemPrompt(),
        maxTokens: 2048,
        timeout: SUMMARY_TIMEOUT_MS,
      },
      { category: 'compaction-bts' }
    );

    const summary = response.content?.[0]?.text?.trim();
    if (summary) {
      return summary;
    }

    log.warn(
      {
        olderCount: messages.length,
        compressibleCount,
        error: 'BTS returned an empty narrative summary',
      },
      'Narrative summary generation failed, falling back to formatted older messages'
    );
    return formatCompressedMessages(messages);
  } catch (error) {
    log.warn(
      {
        olderCount: messages.length,
        compressibleCount,
        error: error instanceof Error ? error.message : String(error),
      },
      'Narrative summary generation failed, falling back to formatted older messages'
    );
    return formatCompressedMessages(messages);
  }
}

/**
 * Format compressed older messages into a readable summary string.
 */
function formatCompressedMessages(messages: AgentTurnMessage[]): string {
  return messages
    .filter((m) => m.text && m.text.trim().length > 0)
    .map((m) => {
      const label = m.role === 'user' ? 'User' : m.role === 'result' ? 'Result' : 'Assistant';
      return `[${label}]: ${m.text}`;
    })
    .join('\n\n');
}

/**
 * Generate an intelligent summary using sliding window preservation and
 * BTS-powered compression.
 *
 * Splits the conversation into older and recent portions by turn boundaries,
 * compresses long messages in the older portion via BTS, and returns both
 * the compressed older summary and the verbatim recent messages.
 *
 * @param messages - Full conversation messages
 * @param options - Settings, task context, and depth
 * @returns olderSummary (formatted string of compressed older context) and
 *          recentMessages (verbatim recent turns to keep in the prompt)
 */
export async function generateIntelligentSummary(
  messages: AgentTurnMessage[],
  options: IntelligentSummaryOptions
): Promise<{ olderSummary: string; recentMessages: AgentTurnMessage[] }> {
  const { settings, taskContext, depth = 1 } = options;

  if (!messages.length) {
    return { olderSummary: '', recentMessages: [] };
  }

  const windowTurns =
    depth >= 3
      ? DEPTH_3_WINDOW_TURNS
      : depth >= 2
        ? DEPTH_2_WINDOW_TURNS
        : SLIDING_WINDOW_TURNS;

  log.info(
    { messageCount: messages.length, windowTurns, depth },
    'Generating intelligent summary with sliding window'
  );

  const preprocessedMessages = messages.map((message) => {
    const unwrappedText = unwrapCompactionArtifact(message.text);
    if (unwrappedText === message.text) {
      return message;
    }

    log.debug(
      { originalLength: message.text.length, unwrappedLength: unwrappedText.length },
      'Unwrapped compaction artifact message before intelligent summary'
    );

    return { ...message, text: unwrappedText };
  });

  const { older, recent } = splitMessagesByWindow(preprocessedMessages, windowTurns);

  if (older.length === 0) {
    // All messages fit in the window — no compression needed
    log.info('All messages fit within sliding window, no compression needed');
    return { olderSummary: '', recentMessages: recent };
  }

  // Switch to narrative summary when per-message compression would be mostly ineffective.
  const compressibleCount = older.filter((m) => m.text.length > COMPRESSION_THRESHOLD_CHARS).length;
  const compressionEffective = compressibleCount / older.length >= NARRATIVE_COMPRESSION_RATIO;

  if (!compressionEffective) {
    log.info(
      { olderCount: older.length, compressibleCount, ratioThreshold: NARRATIVE_COMPRESSION_RATIO },
      'Per-message compression ineffective, using narrative summary'
    );

    try {
      const narrativeSummary = await generateNarrativeSummary(older, taskContext, settings);
      return { olderSummary: narrativeSummary, recentMessages: recent };
    } catch (error) {
      log.warn(
        {
          olderCount: older.length,
          compressibleCount,
          error: error instanceof Error ? error.message : String(error),
        },
        'Narrative summary failed unexpectedly, falling back to per-message compression'
      );
    }
  }

  // Compress long messages in the older portion
  const compressedOlder = await compressOlderMessages(older, taskContext, settings);

  // Format the compressed older messages as a readable summary
  const olderSummary = formatCompressedMessages(compressedOlder);

  log.info(
    { olderCount: older.length, recentCount: recent.length, summaryLength: olderSummary.length },
    'Intelligent summary generated'
  );

  return { olderSummary, recentMessages: recent };
}
