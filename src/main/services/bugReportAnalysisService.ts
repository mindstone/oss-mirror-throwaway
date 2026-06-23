/**
 * Bug Report Analysis Service
 *
 * Uses the behind-the-scenes LLM infrastructure to analyze bug reports.
 * The LLM reads the FULL diagnostic data (including potentially sensitive fields)
 * and produces a privacy-safe summary. The prompt explicitly instructs the model
 * to exclude proprietary content from its output.
 *
 * This is the "Phase B" of enriched bug report diagnostics — it runs after
 * the deterministic Phase A gathering and adds LLM-powered root cause analysis.
 *
 * @see docs/plans/260324_enriched_bug_report_diagnostics.md — Stage 2
 */

import { createScopedLogger } from '@core/logger';
import { getPrompt, PROMPT_IDS } from '@core/services/promptFileService';
import type { AppSettings } from '@shared/types';
import { callBehindTheScenesWithAuth } from './behindTheScenesClient';
import { isShuttingDown } from './shutdownState';
import type { DeterministicDiagnostics } from './bugReportDiagnosticService';

const log = createScopedLogger({ service: 'bugReportAnalysis' });

// 60s gives enough headroom for the LLM to digest a heavy diagnostic payload
// (filtered logs, raw logs, sessions, error patterns, cost stats, MCP state)
// without losing the highest-value diagnostic-summary.md attachment when we
// most need it. The previous 20s budget timed out under realistic load,
// leaving Sentry events without LLM-derived root cause analysis. Background
// flow, so user wait time is not a constraint.
const ANALYSIS_TIMEOUT_MS = 60_000;
const ANALYSIS_MAX_TOKENS = 2048;

// =============================================================================
// User Message Construction
// =============================================================================

/**
 * Build the user message containing the bug description and diagnostic data.
 */
function buildUserMessage(params: {
  bugDescription: string;
  stepsToReproduce?: string;
  expectedBehavior?: string;
  urgency: string;
  rawDiagnostics: DeterministicDiagnostics;
  rawLogs?: string;
}): string {
  const sections: string[] = [];

  sections.push(`## Bug Report\n\n**Description:** ${params.bugDescription}`);

  if (params.stepsToReproduce) {
    sections.push(`**Steps to Reproduce:** ${params.stepsToReproduce}`);
  }

  if (params.expectedBehavior) {
    sections.push(`**Expected Behavior:** ${params.expectedBehavior}`);
  }

  sections.push(`**Urgency:** ${params.urgency}`);

  // Diagnostic data
  const diag = params.rawDiagnostics;

  if (diag.health) {
    sections.push(
      `## System Health\n\n` +
      `**Status:** ${diag.health.status}\n` +
      `**Failed checks:** ${diag.health.failedChecks.length > 0 ? diag.health.failedChecks.join(', ') : 'none'}\n` +
      `**Warning checks:** ${diag.health.warnChecks.length > 0 ? diag.health.warnChecks.join(', ') : 'none'}`,
    );
  }

  if (diag.errorPatterns.length > 0) {
    // Quotes are fine HERE (unlike the fallback summary at ~line 297): this string
    // is the LLM *input*, which is never run through the blanket `sanitizeLogMessage`
    // pass, so the quoted-string rule can't collapse it. `p.msg` is already
    // source-sanitized. Do NOT "align" the fallback to use quotes — that re-gutted
    // the fallback (Stage C). The asymmetry is deliberate.
    const patternLines = diag.errorPatterns.map(
      (p) => `- [level ${p.level}] "${p.msg}" — ${p.count}x (${p.firstSeen} to ${p.lastSeen})`,
    );
    sections.push(`## Error Patterns\n\n${patternLines.join('\n')}`);
  }

  if (diag.recentSessions.length > 0) {
    const sessionLines = diag.recentSessions.map(
      (s) =>
        `- Session ${s.id}: ${s.turnCount} turns, ${s.errorEventCount} errors, ${s.toolFailureCount} tool failures`,
    );
    sections.push(`## Recent Sessions\n\n${sessionLines.join('\n')}`);
  }

  if (diag.filteredLogs.length > 0) {
    const logLines = diag.filteredLogs.map(
      (f) => `### ${f.filename} (${f.lineCount} lines)\n\`\`\`\n${f.filteredContent}\n\`\`\``,
    );
    sections.push(`## Filtered Log Entries\n\n${logLines.join('\n\n')}`);
  }

  // Raw logs (unfiltered) — the LLM can see everything for analysis
  if (params.rawLogs) {
    sections.push(`## Raw Application Logs\n\n\`\`\`\n${params.rawLogs}\n\`\`\``);
  }

  if (diag.storeStats.cleanExitFlag != null || diag.storeStats.autoUpdateState != null) {
    sections.push(
      `## Store State\n\n` +
      `**Clean exit flag:** ${JSON.stringify(diag.storeStats.cleanExitFlag)}\n` +
      `**Auto-update state:** ${JSON.stringify(diag.storeStats.autoUpdateState)}`,
    );
  }

  if (diag.continuity) {
    const continuity = diag.continuity;
    sections.push(
      `## Continuity Diagnostics\n\n` +
      `**Outbox:** pending=${continuity.outboxState.pending}, entries=${continuity.outboxState.entryCount}\n` +
      `**Workspace sync:** lastSyncAt=${continuity.workspaceSyncHistory.lastSyncAt}, trackedFiles=${continuity.workspaceSyncHistory.trackedFileCount}\n` +
      `**State map:** cloudActive=${continuity.stateMachineTransitions.cloudActiveCount}, localOnly=${continuity.stateMachineTransitions.localOnlyCount}, total=${continuity.stateMachineTransitions.totalSessionCount}\n` +
      `**Last tombstone sync:** ${continuity.stateMachineTransitions.lastSessionTombstoneSyncAt ?? 'none'}`,
    );
  }

  // Analytics health — helps diagnose tracking gaps and silent analytics failures
  if (diag.analyticsHealth) {
    const main = diag.analyticsHealth.main;
    const renderer = diag.analyticsHealth.renderer;
    sections.push(
      `## Analytics Health\n\n` +
      `**Main process:** state=${main.state}, enabled=${main.enabled}${main.error ? `, error="${main.error}"` : ''}\n` +
      `**Renderer:** ${renderer ? `state=${renderer.state}, enabled=${renderer.enabled}, hasKnownUserId=${renderer.hasKnownUserId}${renderer.error ? `, error="${renderer.error}"` : ''}` : 'no data (renderer health not reported)'}`,
    );
  }

  // Cost stats — helps diagnose cost anomalies and token usage patterns
  if (diag.costStats) {
    const c = diag.costStats;
    const modelLines = Object.entries(c.last24hByModel)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .map(([model, cost]) => `  ${model}: $${cost.toFixed(4)}`);
    sections.push(
      `## Cost Summary\n\n` +
      `**Last 24h:** $${c.last24hCostUsd.toFixed(4)} (${c.last24hTurns} turns)\n` +
      `**Last 7d:** $${c.last7dCostUsd.toFixed(4)} (${c.last7dTurns} turns)\n` +
      `**Cache hit ratio (24h):** ${c.last24hCacheHitRatio != null ? `${c.last24hCacheHitRatio}%` : 'N/A'}\n` +
      `**Tokens (24h):** ${c.last24hTotalInputTokens.toLocaleString()} input, ${c.last24hTotalOutputTokens.toLocaleString()} output\n` +
      (modelLines.length > 0 ? `**Top models (24h):**\n${modelLines.join('\n')}` : ''),
    );
  }

  // MCP registration status — helps diagnose feature gate and registration issues
  if (diag.mcpRegistration && diag.mcpRegistration.lifecycle !== 'not_started') {
    const mcp = diag.mcpRegistration;
    const gatedList = mcp.gated.length > 0 ? mcp.gated.map(g => `${g.id} (${g.code})`).join(', ') : 'none';
    const failedList = mcp.failed.length > 0 ? mcp.failed.map(f => `${f.id} (${f.code})`).join(', ') : 'none';
    sections.push(
      `## MCP Registration\n\n` +
      `**Lifecycle:** ${mcp.lifecycle}\n` +
      `**Registered:** ${mcp.registered.length} servers\n` +
      `**Gated:** ${gatedList}\n` +
      `**Failed:** ${failedList}`,
    );
  }

  return sections.join('\n\n');
}

// =============================================================================
// Main Analysis Function
// =============================================================================

/**
 * Analyze a bug report using the behind-the-scenes LLM.
 *
 * The LLM receives the full diagnostic data and produces a privacy-safe summary.
 * On ANY failure (auth, network, timeout, parse), returns null for graceful degradation.
 *
 * @returns Privacy-safe markdown summary, or null if analysis fails
 */
export async function analyzeBugReport(params: {
  bugDescription: string;
  stepsToReproduce?: string;
  expectedBehavior?: string;
  urgency: string;
  rawDiagnostics: DeterministicDiagnostics;
  rawLogs?: string;
  settings: AppSettings;
}): Promise<string | null> {
  // Don't start LLM call during shutdown
  if (isShuttingDown()) {
    log.info('Skipping bug report analysis — app is shutting down');
    return null;
  }

  const userMessage = buildUserMessage(params);

  try {
    log.info('Starting LLM bug report analysis');

    const response = await callBehindTheScenesWithAuth(
      params.settings,
      {
        messages: [{ role: 'user', content: userMessage }],
        system: getPrompt(PROMPT_IDS.UTILITY_BUG_REPORT_ANALYSIS),
        maxTokens: ANALYSIS_MAX_TOKENS,
        timeout: ANALYSIS_TIMEOUT_MS,
      },
      { category: 'bug-report-diagnostics' },
    );

    // Extract text from response
    const textBlock = response.content?.find(
      (item) => item.type === 'text' && typeof item.text === 'string' && item.text.length > 0,
    );

    if (textBlock?.text) {
      log.info({ responseLength: textBlock.text.length }, 'Bug report analysis complete');
      return textBlock.text;
    }

    log.warn('LLM returned empty or invalid response for bug report analysis');
    return null;
  } catch (error) {
    // Graceful degradation: log and return null on any failure
    if (error instanceof Error && error.name === 'AbortError') {
      log.warn('Bug report analysis timed out');
    } else {
      log.warn({ err: error }, 'Bug report analysis failed');
    }
    return null;
  }
}

// =============================================================================
// Deterministic Fallback Summary
// =============================================================================

/**
 * Build a deterministic Markdown summary from the Phase A diagnostics payload.
 *
 * Used when Phase B LLM analysis is unavailable (rate-limited, timed out,
 * skipped during shutdown, or returned empty). Ensures Sentry always has a
 * `diagnostic-summary.md` attachment — the most valuable triage artefact
 * historically dropped by silent Phase B failures (see REBEL-4GH / FOX-3152).
 *
 * No LLM calls, no network: built entirely from the already-gathered
 * `DeterministicDiagnostics` payload. Strictly additive and privacy-safe
 * (uses the same already-sanitised fields shown to the LLM, never raw logs).
 */
export function buildFallbackDiagnosticSummary(params: {
  bugDescription: string;
  stepsToReproduce?: string;
  expectedBehavior?: string;
  urgency: string;
  rawDiagnostics: DeterministicDiagnostics;
  reason: 'llm_failed' | 'llm_empty' | 'llm_skipped_shutdown' | 'llm_not_attempted';
}): string {
  const diag = params.rawDiagnostics;
  const sections: string[] = [];

  sections.push('# Bug Report — Deterministic Diagnostic Summary');
  sections.push(
    `> _LLM analysis was not attached for this report (reason: \`${params.reason}\`). ` +
    `This stub is built from the deterministic Phase A diagnostic payload so triage ` +
    `is never blocked by Phase B failure._`,
  );

  sections.push(`## Report`);
  sections.push(`- **Description:** ${params.bugDescription}`);
  if (params.stepsToReproduce) {
    sections.push(`- **Steps to Reproduce:** ${params.stepsToReproduce}`);
  }
  if (params.expectedBehavior) {
    sections.push(`- **Expected Behavior:** ${params.expectedBehavior}`);
  }
  sections.push(`- **Urgency:** ${params.urgency}`);
  sections.push(`- **Gathered at:** ${diag.gatheredAt}`);

  if (diag.health) {
    sections.push(`## System Health`);
    sections.push(`- **Status:** ${diag.health.status}`);
    sections.push(
      `- **Failed checks:** ${diag.health.failedChecks.length > 0 ? diag.health.failedChecks.join(', ') : 'none'}`,
    );
    sections.push(
      `- **Warning checks:** ${diag.health.warnChecks.length > 0 ? diag.health.warnChecks.join(', ') : 'none'}`,
    );
  }

  if (diag.errorPatterns.length > 0) {
    sections.push(`## Top Error Patterns (${diag.errorPatterns.length})`);
    const top = diag.errorPatterns.slice(0, 10);
    for (const p of top) {
      // No surrounding quotes: p.msg is already sanitized at the source
      // (sanitizeErrorPatterns), so the defense-in-depth `sanitizeLogMessage`
      // pass over the whole summary must not re-collapse it via the quoted-string
      // rule. Backtick-delimit for readability instead. See Stage C in
      // docs/plans/260606_bug-report-data-quality/PLAN.md.
      sections.push(
        `- [level ${p.level}] \`${p.msg}\` — ${p.count}x (${p.firstSeen} → ${p.lastSeen})`,
      );
    }
  }

  if (diag.recentSessions.length > 0) {
    sections.push(`## Recent Sessions (${diag.recentSessions.length})`);
    for (const s of diag.recentSessions) {
      sections.push(
        `- Session ${s.id}: ${s.turnCount} turns, ${s.errorEventCount} errors, ${s.toolFailureCount} tool failures`,
      );
    }
  }

  if (diag.costStats) {
    const c = diag.costStats;
    sections.push(`## Cost Summary`);
    sections.push(`- **Last 24h:** $${c.last24hCostUsd.toFixed(4)} (${c.last24hTurns} turns)`);
    sections.push(`- **Last 7d:** $${c.last7dCostUsd.toFixed(4)} (${c.last7dTurns} turns)`);
    if (c.last24hCacheHitRatio != null) {
      sections.push(`- **Cache hit ratio (24h):** ${c.last24hCacheHitRatio}%`);
    }
    sections.push(
      `- **Tokens (24h):** ${c.last24hTotalInputTokens.toLocaleString()} input, ${c.last24hTotalOutputTokens.toLocaleString()} output`,
    );
    const topModels = Object.entries(c.last24hByModel)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5);
    if (topModels.length > 0) {
      sections.push(`- **Top models (24h):**`);
      for (const [model, cost] of topModels) {
        sections.push(`  - ${model}: $${cost.toFixed(4)}`);
      }
    }
  }

  if (diag.mcpRegistration && diag.mcpRegistration.lifecycle !== 'not_started') {
    const mcp = diag.mcpRegistration;
    sections.push(`## MCP Registration`);
    sections.push(`- **Lifecycle:** ${mcp.lifecycle}`);
    sections.push(`- **Registered:** ${mcp.registered.length} servers`);
    sections.push(
      `- **Gated:** ${mcp.gated.length > 0 ? mcp.gated.map((g) => `${g.id} (${g.code})`).join(', ') : 'none'}`,
    );
    sections.push(
      `- **Failed:** ${mcp.failed.length > 0 ? mcp.failed.map((f) => `${f.id} (${f.code})`).join(', ') : 'none'}`,
    );
  }

  if (diag.analyticsHealth) {
    const main = diag.analyticsHealth.main;
    const renderer = diag.analyticsHealth.renderer;
    sections.push(`## Analytics Health`);
    sections.push(
      `- **Main process:** state=${main.state}, enabled=${main.enabled}` +
      (main.error ? `, error="${main.error}"` : ''),
    );
    sections.push(
      `- **Renderer:** ${
        renderer
          ? `state=${renderer.state}, enabled=${renderer.enabled}, hasKnownUserId=${renderer.hasKnownUserId}` +
            (renderer.error ? `, error="${renderer.error}"` : '')
          : 'no data (renderer health not reported)'
      }`,
    );
  }

  if (diag.storeStats.cleanExitFlag != null || diag.storeStats.autoUpdateState != null) {
    sections.push(`## Store State`);
    sections.push(`- **Clean exit flag:** \`${JSON.stringify(diag.storeStats.cleanExitFlag)}\``);
    sections.push(`- **Auto-update state:** \`${JSON.stringify(diag.storeStats.autoUpdateState)}\``);
  }

  if (diag.continuity) {
    const continuity = diag.continuity;
    sections.push(`## Continuity Diagnostics`);
    sections.push(
      `- **Outbox:** pending=${continuity.outboxState.pending}, entries=${continuity.outboxState.entryCount}`,
    );
    sections.push(
      `- **Workspace sync:** lastSyncAt=${continuity.workspaceSyncHistory.lastSyncAt}, trackedFiles=${continuity.workspaceSyncHistory.trackedFileCount}`,
    );
    sections.push(
      `- **State map:** cloudActive=${continuity.stateMachineTransitions.cloudActiveCount}, ` +
      `localOnly=${continuity.stateMachineTransitions.localOnlyCount}, ` +
      `total=${continuity.stateMachineTransitions.totalSessionCount}`,
    );
  }

  if (diag.filteredLogs.length > 0) {
    sections.push(
      `## Filtered Logs (${diag.filteredLogs.length} files, ` +
      `${diag.filteredLogs.reduce((sum, f) => sum + f.lineCount, 0)} lines total)`,
    );
    sections.push(`_See \`filtered-logs.ndjson\` attachment for full content._`);
  }

  return sections.join('\n\n');
}
