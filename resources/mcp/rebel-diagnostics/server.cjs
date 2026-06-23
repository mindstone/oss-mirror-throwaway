#!/usr/bin/env node
// MUST be the first non-comment statement — see docs/plans/260428_graceful_fs_emfile_fix.md
// Uses globalThis.process so files that later `const process = require('node:process')` don't trigger TDZ.
if (globalThis.process.env.REBEL_DISABLE_GRACEFUL_FS !== '1') {
  try { require('graceful-fs').gracefulify(require('node:fs')); } catch (e) {
    globalThis.__REBEL_BOOTSTRAP_LEAF_ERROR__ = { kind: 'graceful_fs_leaf_install_failed', error: { name: e?.name, message: e?.message, stack: e?.stack }, at: Date.now() };
    if (globalThis.process.env.REBEL_DEBUG_BOOTSTRAP === '1') console.warn('[installGracefulFs] failed:', e);
  }
}
const fs = require('node:fs');
const process = require('node:process');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

const TOOL_NAMES = {
  health: 'rebel_diagnostics_check',
  quickCheck: 'rebel_diagnostics_quick',
  exportReport: 'rebel_diagnostics_export',
  recentEvents: 'rebel_diagnostics_recent_events',
  recentLogs: 'rebel_diagnostics_recent_logs',
  logFilePaths: 'rebel_diagnostics_log_file_paths'
};

const TOOL_DESCRIPTIONS = {
  health: `Run comprehensive diagnostics on the Rebel app configuration.

Checks workspace access, API keys, MCP configuration, permissions, disk space, and more.

WHEN TO USE:
- User reports "something isn't working" or "tools aren't available"
- Before suggesting configuration changes
- When troubleshooting agent failures or MCP issues
- User asks "what's wrong?" or "why isn't X working?"

Returns a detailed report with failures, warnings, and passed checks.
Use tier="quick" for fast checks (~100ms), tier="full" for comprehensive (~500ms).
For just quick checks, use rebel_diagnostics_quick instead.`,
  quickCheck: `Fast health check (~100ms) to verify basic system state.

Runs a subset of critical checks only. Use for quick validation before operations.
For comprehensive diagnostics, use rebel_diagnostics_check with tier="full" instead.`,
  exportReport: `Generate a shareable markdown health report for support or debugging.

Use when:
- User wants to share their system state with support
- Creating a bug report or issue
- Documenting system configuration

Returns formatted markdown suitable for copying/sharing.`,
  recentEvents: 'Recent diagnostic events captured by the F2 events ledger: cooldowns, MCP transitions, auth events, BTS errors, abort events, approval-stuck. Returns markdown with per-kind counts, last-seen timestamps, and the last N entries per kind within the requested time window. WHEN TO USE: after a user reports something failed, to surface the last 5 things that broke without reading raw logs.',
  recentLogs: 'Recent raw lines from Rebel\'s main application log (last <maxLines> lines, capped at <maxBytes> bytes). Returns the actual log content for triage when structured events aren\'t enough. WARNING: Calling this tool sends raw application logs to the active LLM provider. Logs may contain user-pasted secrets, customer data, or untrusted text. Default 256 KiB / 200 lines. Use rebel_diagnostics_log_file_paths instead if you need full file content beyond the soft cap.',
  logFilePaths: 'List Rebel\'s recent log file paths with sizes and modification times. Returns metadata only (path, basename, size, mtime), no log content. Use this when rebel_diagnostics_recent_logs hits its byte cap and you need to read full files via filesystem-capable tools. The logDir field gives you the absolute directory path; basename + logDir compose the full file path.'
};

const statePath = process.env.MINDSTONE_REBEL_BRIDGE_STATE;

const loadBridgeState = () => {
  if (!statePath) {
    return null;
  }
  try {
    const raw = fs.readFileSync(statePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (typeof parsed.port !== 'number' || !parsed.token) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
};

const tierSchema = z.object({
  tier: z.enum(['quick', 'full']).optional()
});

const recentEventsSchema = z.object({
  limit: z.number().int().min(1).max(20).optional(),
  windowHours: z.number().int().min(1).max(168).optional()
});

const recentLogsSchema = z.object({
  maxBytes: z.number().int().min(1024).max(4194304).default(262144).describe('Max response bytes (1 KiB - 4 MiB).'),
  maxLines: z.number().int().min(1).max(2000).default(200).describe('Max line count returned.')
});

const logFilePathsSchema = z.object({});

const formatHealthReport = (report) => {
  const lines = [];
  lines.push(`System Status: ${report.status.toUpperCase()}`);
  lines.push(`Platform: ${report.platform} | App: ${report.appVersion}${report.isPackaged ? '' : ' (dev)'}`);
  lines.push('');

  const checks = Object.values(report.checks);
  const failed = checks.filter(c => c.status === 'fail');
  const warnings = checks.filter(c => c.status === 'warn');
  const passed = checks.filter(c => c.status === 'pass');

  if (failed.length > 0) {
    lines.push('FAILURES:');
    for (const check of failed) {
      lines.push(`  ✗ ${check.name}: ${check.message}`);
      if (check.remediation) {
        lines.push(`    → Fix: ${check.remediation}`);
      }
    }
    lines.push('');
  }

  if (warnings.length > 0) {
    lines.push('WARNINGS:');
    for (const check of warnings) {
      lines.push(`  ⚠ ${check.name}: ${check.message}`);
      if (check.remediation) {
        lines.push(`    → Fix: ${check.remediation}`);
      }
    }
    lines.push('');
  }

  lines.push(`PASSED: ${passed.length} checks`);
  if (passed.length > 0) {
    for (const check of passed) {
      lines.push(`  ✓ ${check.name}`);
    }
  }

  if (report.recommendations?.length > 0) {
    lines.push('');
    lines.push('RECOMMENDATIONS:');
    for (const rec of report.recommendations) {
      lines.push(`  [${rec.priority}] ${rec.message}`);
      if (rec.action) {
        lines.push(`    → ${rec.action}`);
      }
    }
  }

  return lines.join('\n');
};

const buildQueryPath = (path, params) => {
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      searchParams.set(key, String(value));
    }
  }
  const query = searchParams.toString();
  return query ? `${path}?${query}` : path;
};

const createBridgeRequest = (bridgeBaseUrl, bridgeToken) => async (toolName, path, options = {}) => {
  const { method = 'GET' } = options;
  const headers = {
    'Content-Type': 'application/json',
    ...(bridgeToken ? { Authorization: `Bearer ${bridgeToken}` } : {})
  };

  const response = await fetch(`${bridgeBaseUrl}${path}`, {
    method,
    headers
  });

  if (!response.ok) {
    let detail = 'Diagnostics request failed.';
    try {
      const payload = await response.json();
      detail = payload?.error ?? detail;
    } catch {
      detail = await response.text();
    }
    throw new Error(`[${toolName}] ${detail || `Request failed (${response.status})`}`);
  }

  return response.json();
};

const registerTools = (server, bridgeRequest) => {
  server.registerTool(TOOL_NAMES.health, {
    title: 'System health check',
    description: TOOL_DESCRIPTIONS.health,
    inputSchema: tierSchema,
    annotations: { readOnlyHint: true }
  }, async (input) => {
    const tier = input?.tier || 'full';
    const endpoint = tier === 'quick' ? '/diagnostics/quick-check' : '/diagnostics/health-check';
    const result = await bridgeRequest(TOOL_NAMES.health, endpoint);
    const report = result.report;

    return {
      content: [
        {
          type: 'text',
          text: formatHealthReport(report)
        }
      ]
    };
  });

  server.registerTool(TOOL_NAMES.quickCheck, {
    title: 'Quick system check',
    description: TOOL_DESCRIPTIONS.quickCheck,
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true }
  }, async () => {
    const result = await bridgeRequest(TOOL_NAMES.quickCheck, '/diagnostics/quick-check');
    const report = result.report;

    return {
      content: [
        {
          type: 'text',
          text: formatHealthReport(report)
        }
      ]
    };
  });

  server.registerTool(TOOL_NAMES.exportReport, {
    title: 'Export health report',
    description: TOOL_DESCRIPTIONS.exportReport,
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true }
  }, async () => {
    const result = await bridgeRequest(TOOL_NAMES.exportReport, '/diagnostics/export');

    return {
      content: [
        {
          type: 'text',
          text: `Here's a shareable health report:\n\n${result.markdown}`
        }
      ]
    };
  });

  server.registerTool(TOOL_NAMES.recentEvents, {
    title: 'Recent diagnostic events',
    description: TOOL_DESCRIPTIONS.recentEvents,
    inputSchema: recentEventsSchema,
    annotations: { readOnlyHint: true }
  }, async (input) => {
    const result = await bridgeRequest(
      TOOL_NAMES.recentEvents,
      buildQueryPath('/diagnostics/recent-events', {
        limit: input?.limit,
        windowHours: input?.windowHours
      })
    );

    return {
      content: [
        {
          type: 'text',
          text: result.markdown
        }
      ]
    };
  });

  server.registerTool(TOOL_NAMES.recentLogs, {
    title: 'Recent raw application logs',
    description: TOOL_DESCRIPTIONS.recentLogs,
    inputSchema: recentLogsSchema,
    annotations: { readOnlyHint: true }
  }, async (input) => {
    const result = await bridgeRequest(
      TOOL_NAMES.recentLogs,
      buildQueryPath('/diagnostics/recent-logs', {
        maxBytes: input?.maxBytes,
        maxLines: input?.maxLines
      })
    );

    return {
      content: [
        {
          type: 'text',
          text: result.content
        }
      ]
    };
  });

  server.registerTool(TOOL_NAMES.logFilePaths, {
    title: 'Recent log file paths',
    description: TOOL_DESCRIPTIONS.logFilePaths,
    inputSchema: logFilePathsSchema,
    annotations: { readOnlyHint: true }
  }, async () => {
    const result = await bridgeRequest(
      TOOL_NAMES.logFilePaths,
      '/diagnostics/log-file-paths',
      {}
    );

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }
      ]
    };
  });
};

const startServer = () => {
  const bridgeState = loadBridgeState();

  if (!bridgeState) {
    console.error('[RebelDiagnostics] Missing bridge configuration file.');
    process.exit(1);
  }

  const bridgeBaseUrl = `http://127.0.0.1:${bridgeState.port}`;
  const server = new McpServer({
    name: 'RebelDiagnostics',
    version: '0.1.0'
  });
  registerTools(server, createBridgeRequest(bridgeBaseUrl, bridgeState.token));

  const transport = new StdioServerTransport();

  server
    .connect(transport)
    .then(() => {
      console.error('[RebelDiagnostics] Server started');
    })
    .catch((error) => {
      console.error('[RebelDiagnostics] Failed to start', error);
      process.exit(1);
    });
};

module.exports = {
  TOOL_NAMES,
  TOOL_DESCRIPTIONS
};

if (require.main === module) {
  startServer();
}
