/**
 * Conversation Diagnostic Export Service
 *
 * Exports a comprehensive diagnostic report for a specific conversation session.
 * Includes session metadata, conversation transcript, per-turn summaries with
 * tool calls and usage, error/warning summary, and filtered+deduplicated logs.
 *
 * Uses the same redaction machinery as the full diagnostic bundle to ensure
 * PII and secrets are never leaked.
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { createScopedLogger } from '@core/logger';
import { getDataPath, getAppVersion } from '@core/utils/dataPaths';
import { getIncrementalSessionStore } from './incrementalSessionStore';
import { redactSensitiveData } from '../utils/logRedaction';
import { aggregateSessionUsage, extractTurnUsage } from '@shared/utils/usageAggregator';
import type { AgentSession, AgentEvent } from '@shared/types';

const log = createScopedLogger({ service: 'conversationLogExport' });

// Pino log levels: 10=trace, 20=debug, 30=info, 40=warn, 50=error, 60=fatal
const LOG_LEVEL_WARN = 40;
const LOG_LEVEL_INFO = 30;

/**
 * Sanitize a value for use in log filename matching.
 * Must match the sanitization in logger.ts buildSessionLogFilePath().
 */
function sanitizeFilenameComponent(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9-_]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-/, '')
    .replace(/-$/, '')
    .slice(0, 32)
    .toLowerCase() || 'unknown';
}

export interface ConversationLogExportResult {
  success: boolean;
  content?: string;
  filename?: string;
  error?: string;
}

// =============================================================================
// Log Processing (mirrors logExportService.ts patterns)
// =============================================================================

interface ParsedLogLine {
  level: number;
  msg: string;
  time: string;
  raw: string;
}

function parseLogLine(line: string): ParsedLogLine | null {
  if (!line.trim()) return null;
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    return {
      level: typeof parsed.level === 'number' ? parsed.level : LOG_LEVEL_INFO,
      msg: typeof parsed.msg === 'string' ? parsed.msg : '',
      time: typeof parsed.time === 'string' ? parsed.time : '',
      raw: line,
    };
  } catch {
    return null;
  }
}

/**
 * Filter log lines to info level and above (drop trace + debug).
 */
function filterByMinLevel(lines: string[], minLevel: number): string[] {
  return lines.filter((line) => {
    const parsed = parseLogLine(line);
    return parsed !== null && parsed.level >= minLevel;
  });
}

/**
 * Deduplicate consecutive log entries with the same `msg` field.
 * Mirrors the deduplication in logExportService.ts.
 */
function deduplicateLogLines(lines: string[]): string[] {
  if (lines.length === 0) return lines;

  const result: string[] = [];
  let currentMsg: string | null = null;
  let currentLine: string | null = null;
  let count = 0;
  let firstTime = '';
  let lastTime = '';

  const emit = () => {
    if (currentLine === null) return;
    if (count === 1) {
      result.push(currentLine);
    } else {
      try {
        const parsed = JSON.parse(currentLine) as Record<string, unknown>;
        const range = firstTime && lastTime
          ? ` ${firstTime.slice(11, 16)}-${lastTime.slice(11, 16)}`
          : '';
        parsed.msg = `${currentMsg} (x${count}${range})`;
        result.push(JSON.stringify(parsed));
      } catch {
        result.push(currentLine);
      }
    }
  };

  for (const line of lines) {
    const parsed = parseLogLine(line);
    if (!parsed) continue;

    if (parsed.msg === currentMsg) {
      count++;
      lastTime = parsed.time;
    } else {
      emit();
      currentMsg = parsed.msg;
      currentLine = line;
      count = 1;
      firstTime = parsed.time;
      lastTime = parsed.time;
    }
  }
  emit();

  return result;
}

/**
 * Extract only warn+error lines and deduplicate by message.
 * Returns unique error patterns with counts, sorted by count desc.
 */
function extractErrorSummary(lines: string[]): Array<{ level: number; msg: string; count: number; firstSeen: string; lastSeen: string }> {
  const patternMap = new Map<string, { level: number; count: number; firstSeen: string; lastSeen: string }>();

  for (const line of lines) {
    const parsed = parseLogLine(line);
    if (!parsed || parsed.level < LOG_LEVEL_WARN) continue;

    const existing = patternMap.get(parsed.msg);
    if (existing) {
      existing.count++;
      if (parsed.time > existing.lastSeen) existing.lastSeen = parsed.time;
    } else {
      patternMap.set(parsed.msg, {
        level: parsed.level,
        count: 1,
        firstSeen: parsed.time,
        lastSeen: parsed.time,
      });
    }
  }

  return Array.from(patternMap.entries())
    .map(([msg, data]) => ({ msg, ...data }))
    .sort((a, b) => b.count - a.count);
}

// =============================================================================
// Session Data Extraction
// =============================================================================

function formatTimestamp(ts: number): string {
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 19);
}

function buildSessionMetadata(session: AgentSession): string[] {
  const lines: string[] = [];
  const usage = aggregateSessionUsage(session.eventsByTurn || {});
  const turnCount = Object.keys(session.eventsByTurn || {}).length;

  // Extract model from the first result event
  let model = 'unknown';
  for (const events of Object.values(session.eventsByTurn || {})) {
    for (const event of events) {
      if (event.type === 'result' && 'model' in event && event.model) {
        model = event.model;
        break;
      }
    }
    if (model !== 'unknown') break;
  }

  lines.push('## Session Metadata');
  lines.push('');
  lines.push(`| Field | Value |`);
  lines.push(`|-------|-------|`);
  lines.push(`| Session ID | \`${session.id}\` |`);
  lines.push(`| Title | ${session.title || '(untitled)'} |`);
  lines.push(`| Created | ${formatTimestamp(session.createdAt)} |`);
  lines.push(`| Updated | ${formatTimestamp(session.updatedAt)} |`);
  lines.push(`| Origin | ${session.origin || 'manual'} |`);
  lines.push(`| Model | ${model} |`);
  lines.push(`| Turns | ${turnCount} |`);
  lines.push(`| Messages | ${session.messages?.length ?? 0} |`);
  lines.push(`| Total Cost | $${usage.costUsd.toFixed(4)} |`);
  lines.push(`| Input Tokens | ${usage.inputTokens.toLocaleString()} |`);
  lines.push(`| Output Tokens | ${usage.outputTokens.toLocaleString()} |`);
  lines.push(`| Cache Read Tokens | ${usage.cacheReadTokens.toLocaleString()} |`);
  if (session.privateMode) {
    lines.push(`| Private Mode | Yes |`);
  }
  if (session.lastError) {
    lines.push(`| Last Error | ${redactSensitiveData(session.lastError)} |`);
  }
  lines.push('');

  return lines;
}

function buildConversationTranscript(session: AgentSession): string[] {
  const lines: string[] = [];
  const messages = session.messages || [];

  if (messages.length === 0) {
    lines.push('## Conversation Transcript');
    lines.push('');
    lines.push('*No messages recorded.*');
    lines.push('');
    return lines;
  }

  lines.push('## Conversation Transcript');
  lines.push('');

  for (const msg of messages) {
    if (msg.isHidden) continue;

    const roleLabel = msg.role === 'user' ? 'User' : msg.role === 'assistant' ? 'Assistant' : 'Result';
    const time = formatTimestamp(msg.createdAt);
    lines.push(`### ${roleLabel} (${time})`);
    lines.push('');

    // Redact and truncate message content
    const MAX_MSG_LENGTH = 2000;
    const text = msg.text || '';
    const redacted = redactSensitiveData(text);
    if (redacted.length > MAX_MSG_LENGTH) {
      lines.push(redacted.slice(0, MAX_MSG_LENGTH));
      lines.push(`\n*... truncated (${redacted.length.toLocaleString()} chars total)*`);
    } else {
      lines.push(redacted);
    }
    lines.push('');
  }

  return lines;
}

function buildPerTurnSummary(session: AgentSession): string[] {
  const lines: string[] = [];
  const eventsByTurn = session.eventsByTurn || {};
  const turnIds = Object.keys(eventsByTurn);

  if (turnIds.length === 0) {
    return lines;
  }

  lines.push('## Per-Turn Summary');
  lines.push('');

  for (const turnId of turnIds) {
    const events: AgentEvent[] = eventsByTurn[turnId];
    const usage = extractTurnUsage(turnId, events);

    // Collect tool calls
    const toolCalls: Array<{ name: string; stage: string }> = [];
    const errors: string[] = [];

    for (const event of events) {
      if (event.type === 'tool') {
        toolCalls.push({ name: event.toolName, stage: event.stage });
      } else if (event.type === 'error') {
        errors.push(redactSensitiveData(event.error));
      }
    }

    // Count unique tool calls (by start events)
    const toolStarts = toolCalls.filter((t) => t.stage === 'start');
    const uniqueTools = [...new Set(toolStarts.map((t) => t.name))];

    lines.push(`### Turn \`${turnId.slice(0, 12)}\``);
    lines.push('');

    if (usage) {
      lines.push(`- **Cost:** $${usage.costUsd.toFixed(4)} | **Tokens:** ${usage.inputTokens.toLocaleString()} in / ${usage.outputTokens.toLocaleString()} out`);
      if (usage.contextUtilization !== null) {
        lines.push(`- **Context:** ${usage.contextUtilization.toFixed(0)}% utilized${usage.contextWindow ? ` (${(usage.contextWindow / 1000).toFixed(0)}k window)` : ''}`);
      }
    }

    if (toolStarts.length > 0) {
      lines.push(`- **Tool calls (${toolStarts.length}):** ${uniqueTools.join(', ')}`);
    }

    if (errors.length > 0) {
      lines.push(`- **Errors (${errors.length}):**`);
      for (const err of errors) {
        const truncated = err.length > 200 ? err.slice(0, 200) + '...' : err;
        lines.push(`  - ${truncated}`);
      }
    }

    lines.push('');
  }

  return lines;
}

// =============================================================================
// Main Export Function
// =============================================================================

/**
 * Export a comprehensive diagnostic report for a specific conversation session.
 *
 * Includes:
 * - Session metadata (model, MCP, cost, timing)
 * - Error/warning summary (deduplicated, at top for quick triage)
 * - Conversation transcript (user + assistant messages, redacted)
 * - Per-turn summary (tool calls, usage, errors)
 * - Filtered & deduplicated application logs (info+ only, noise removed)
 *
 * All content is redacted using the same machinery as the full diagnostic bundle.
 *
 * @param sessionId - The conversation session ID
 * @returns Export result with diagnostic content
 */
export async function exportConversationLogs(sessionId: string): Promise<ConversationLogExportResult> {
  const sanitizedId = sanitizeFilenameComponent(sessionId);
  const logsDir = path.join(getDataPath(), 'logs', 'sessions');

  log.info({ sessionId, sanitizedId, logsDir }, 'Exporting conversation diagnostics');

  try {
    // Load session data
    const session = await getIncrementalSessionStore().getSession(sessionId);
    const sessionTitle = session?.title ?? 'Untitled';
    const timestamp = new Date().toISOString();

    const sections: string[] = [];

    // Header
    sections.push('# Conversation Diagnostic Report');
    sections.push('');
    sections.push(`**Exported:** ${timestamp}`);
    sections.push(`**App Version:** ${getAppVersion()}`);
    sections.push('');

    // Session metadata (if session data available)
    if (session) {
      sections.push(...buildSessionMetadata(session));
    } else {
      sections.push('## Session Metadata');
      sections.push('');
      sections.push(`**Session ID:** ${sessionId}`);
      sections.push('');
      sections.push('*Session data not found. Only log files will be included.*');
      sections.push('');
    }

    // Read log files for this session
    const allLogLines: string[] = [];
    let logFileCount = 0;

    try {
      await fs.access(logsDir);
      const entries = await fs.readdir(logsDir);
      const suffix = `-renderer-${sanitizedId}.log`;
      const matchingFiles = entries
        .filter((filename) => filename.endsWith(suffix))
        .sort();

      logFileCount = matchingFiles.length;

      for (const filename of matchingFiles) {
        const filePath = path.join(logsDir, filename);
        try {
          const content = await fs.readFile(filePath, 'utf-8');
          allLogLines.push(...content.split('\n').filter((l) => l.trim()));
        } catch (err) {
          log.warn({ err, filename }, 'Failed to read log file');
        }
      }
    } catch {
      // logs/sessions/ directory doesn't exist
    }

    // Error/warning summary (placed early for quick triage)
    const errorPatterns = extractErrorSummary(allLogLines);
    if (errorPatterns.length > 0) {
      sections.push('## Errors & Warnings');
      sections.push('');
      sections.push(`Found **${errorPatterns.length}** unique warning/error patterns:`);
      sections.push('');
      for (const pattern of errorPatterns) {
        const levelLabel = pattern.level >= 50 ? 'ERROR' : 'WARN';
        const countStr = pattern.count > 1 ? ` (x${pattern.count})` : '';
        sections.push(`- **[${levelLabel}]** ${redactSensitiveData(pattern.msg)}${countStr}`);
      }
      sections.push('');
    }

    // Conversation transcript
    if (session) {
      sections.push(...buildConversationTranscript(session));
    }

    // Per-turn summary
    if (session) {
      sections.push(...buildPerTurnSummary(session));
    }

    // Filtered & deduplicated logs
    sections.push('---');
    sections.push('');
    sections.push('## Application Logs');
    sections.push('');

    if (allLogLines.length === 0) {
      sections.push('*No log files found for this conversation. Logs may have been rotated out.*');
    } else {
      // Filter to info+ (drop trace/debug) then deduplicate
      const filtered = filterByMinLevel(allLogLines, LOG_LEVEL_INFO);
      const deduplicated = deduplicateLogLines(filtered);
      const redactedLines = deduplicated.map((line) => redactSensitiveData(line));

      sections.push(`*${logFileCount} log file(s), ${allLogLines.length} raw lines -> ${redactedLines.length} after filtering (info+) and deduplication*`);
      sections.push('');
      sections.push('````json');
      sections.push(redactedLines.join('\n'));
      sections.push('````');
    }
    sections.push('');

    // Footer
    sections.push('---');
    sections.push('');
    sections.push(
      '*This report redacts: API keys, OAuth tokens, secrets, email addresses, and user paths. ' +
        'Review before sharing externally.*'
    );

    // Generate output filename
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
    const timeStr = now.toISOString().slice(11, 19).replace(/:/g, '');
    const safeTitle = sessionTitle
      .replace(/[^a-zA-Z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .slice(0, 30);
    const outputFilename = `rebel-diagnostics-${safeTitle}-${dateStr}-${timeStr}.md`;

    log.info(
      { sessionId, logFileCount, outputFilename },
      'Conversation diagnostics exported successfully'
    );

    return {
      success: true,
      content: sections.join('\n'),
      filename: outputFilename,
    };
  } catch (err) {
    log.error({ err, sessionId }, 'Failed to export conversation diagnostics');
    return {
      success: false,
      error: `Export failed: ${(err as Error).message}`,
    };
  }
}
