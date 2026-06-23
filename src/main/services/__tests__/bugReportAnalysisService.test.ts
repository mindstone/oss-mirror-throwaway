/**
 * Unit tests for bugReportAnalysisService.
 *
 * Tests:
 * - System prompt includes privacy instructions
 * - User bug description is included in the prompt
 * - Raw diagnostics data is included in the prompt
 * - callBehindTheScenesWithAuth is called with correct tracking category
 * - Timeout behavior (20s)
 * - Graceful fallback: auth failure returns null
 * - Graceful fallback: network error returns null
 * - Graceful fallback: timeout returns null
 * - isShuttingDown() check prevents call during shutdown
 * - Response text is extracted correctly from BTS response
 */

import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { configurePromptFileService, _resetForTesting } from '@core/services/promptFileService';
import { sanitizeLogMessage } from '@core/utils/logFieldFilter';
import type { AppSettings } from '@shared/types';
import type { DeterministicDiagnostics } from '../bugReportDiagnosticService';

// =============================================================================
// Mocks
// =============================================================================

const mockCallBehindTheScenesWithAuth = vi.fn();

vi.mock('../behindTheScenesClient', () => ({
  callBehindTheScenesWithAuth: (...args: unknown[]) => mockCallBehindTheScenesWithAuth(...args),
}));

const mockIsShuttingDown = vi.fn();

vi.mock('../shutdownState', () => ({
  isShuttingDown: () => mockIsShuttingDown(),
}));

// =============================================================================
// Test Fixtures
// =============================================================================

const mockSettings: AppSettings = {
  claude: { apiKey: 'test-key' },
} as unknown as AppSettings;

function makeDiagnostics(overrides?: Partial<DeterministicDiagnostics>): DeterministicDiagnostics {
  return {
    gatheredAt: '2026-03-24T10:00:00Z',
    health: {
      status: 'degraded',
      failedChecks: ['claudeApiKeyValid'],
      warnChecks: ['nodeBundleHealth'],
    },
    filteredLogs: [
      {
        filename: 'mindstone-rebel.log',
        filteredContent: '{"level":50,"service":"mcp","code":"ECONNREFUSED"}',
        lineCount: 1,
      },
    ],
    errorPatterns: [
      {
        msg: 'Connection refused',
        level: 50,
        count: 5,
        firstSeen: '2026-03-24T09:50:00Z',
        lastSeen: '2026-03-24T09:58:00Z',
      },
    ],
    recentSessions: [
      {
        id: 'session-abc',
        turnCount: 3,
        totalMessageCount: 8,
        errorEventCount: 2,
        toolFailureCount: 1,
        costUsd: undefined,
        createdAt: 1711200000000,
        updatedAt: 1711286400000,
        origin: 'manual',
      },
    ],
    storeStats: {
      cleanExitFlag: { cleanExit: true },
      autoUpdateState: { state: 'idle' },
    },
    providerReachability: null,
    ...overrides,
  };
}

function makeSuccessResponse(text: string) {
  return {
    content: [{ type: 'text', text }],
    model: 'claude-3-haiku-20240307',
    usage: { input_tokens: 500, output_tokens: 200 },
  };
}

const defaultParams = {
  bugDescription: 'MCP tools stopped working after update',
  stepsToReproduce: 'Open app, try to use MCP tool, get error',
  expectedBehavior: 'MCP tools should work normally',
  urgency: 'high',
  rawDiagnostics: makeDiagnostics(),
  rawLogs: '{"level":50,"msg":"MCP connection refused","err":"ECONNREFUSED"}',
  settings: mockSettings,
};

// =============================================================================
// Import module under test AFTER mocks
// =============================================================================

import {
  analyzeBugReport,
  buildFallbackDiagnosticSummary,
} from '../bugReportAnalysisService';

// =============================================================================
// Tests
// =============================================================================

describe('analyzeBugReport', () => {
  beforeEach(() => {
    _resetForTesting();
    const promptsDir = path.resolve(__dirname, '../../../..', 'rebel-system', 'prompts');
    configurePromptFileService(promptsDir);

    vi.clearAllMocks();
    mockIsShuttingDown.mockReturnValue(false);
    mockCallBehindTheScenesWithAuth.mockResolvedValue(
      makeSuccessResponse('## Likely Root Cause\nMCP connection failure'),
    );
  });

  afterEach(() => {
    _resetForTesting();
  });

  // ---------------------------------------------------------------------------
  // Prompt content
  // ---------------------------------------------------------------------------

  it('includes privacy instructions in the system prompt', async () => {
    await analyzeBugReport(defaultParams);

    const [, options] = mockCallBehindTheScenesWithAuth.mock.calls[0];
    expect(options.system).toContain('PRIVACY INSTRUCTIONS');
    expect(options.system).toContain('MUST NOT include');
    expect(options.system).toContain('File paths');
    expect(options.system).toContain('Conversation content');
    expect(options.system).toContain('personal names');
    expect(options.system).toContain('API keys');
    expect(options.system).toContain('proprietary information');
  });

  it('includes the user bug description in the prompt', async () => {
    await analyzeBugReport(defaultParams);

    const [, options] = mockCallBehindTheScenesWithAuth.mock.calls[0];
    const userMessage = options.messages[0].content;
    expect(userMessage).toContain('MCP tools stopped working after update');
  });

  it('includes steps to reproduce in the prompt when provided', async () => {
    await analyzeBugReport(defaultParams);

    const [, options] = mockCallBehindTheScenesWithAuth.mock.calls[0];
    const userMessage = options.messages[0].content;
    expect(userMessage).toContain('Open app, try to use MCP tool, get error');
  });

  it('includes expected behavior in the prompt when provided', async () => {
    await analyzeBugReport(defaultParams);

    const [, options] = mockCallBehindTheScenesWithAuth.mock.calls[0];
    const userMessage = options.messages[0].content;
    expect(userMessage).toContain('MCP tools should work normally');
  });

  it('includes raw diagnostics data in the prompt', async () => {
    await analyzeBugReport(defaultParams);

    const [, options] = mockCallBehindTheScenesWithAuth.mock.calls[0];
    const userMessage = options.messages[0].content;

    // Health info
    expect(userMessage).toContain('degraded');
    expect(userMessage).toContain('claudeApiKeyValid');
    expect(userMessage).toContain('nodeBundleHealth');

    // Error patterns
    expect(userMessage).toContain('Connection refused');
    expect(userMessage).toContain('5x');

    // Session info
    expect(userMessage).toContain('session-abc');
    expect(userMessage).toContain('3 turns');
    expect(userMessage).toContain('2 errors');

    // Filtered log content
    expect(userMessage).toContain('ECONNREFUSED');
  });

  it('includes raw logs in the prompt when provided', async () => {
    await analyzeBugReport(defaultParams);

    const [, options] = mockCallBehindTheScenesWithAuth.mock.calls[0];
    const userMessage = options.messages[0].content;
    expect(userMessage).toContain('Raw Application Logs');
    expect(userMessage).toContain('MCP connection refused');
  });

  it('includes continuity diagnostics when provided', async () => {
    await analyzeBugReport({
      ...defaultParams,
      rawDiagnostics: makeDiagnostics({
        continuity: {
          outboxState: {
            pending: 2,
            failed: 0,
            entryCount: 2,
            sampleEntries: [],
          },
          workspaceSyncHistory: {
            lastSyncAt: 1711286400000,
            trackedFileCount: 12,
            sampleFiles: [],
          },
          stateMachineTransitions: {
            cloudActiveCount: 7,
            localOnlyCount: 3,
            totalSessionCount: 10,
            lastSessionTombstoneSyncAt: 1711286405000,
            sampleStates: [],
          },
        },
      }),
    });

    const [, options] = mockCallBehindTheScenesWithAuth.mock.calls[0];
    const userMessage = options.messages[0].content;
    expect(userMessage).toContain('Continuity Diagnostics');
    expect(userMessage).toContain('pending=2');
    expect(userMessage).toContain('trackedFiles=12');
  });

  it('omits optional fields from prompt when not provided', async () => {
    await analyzeBugReport({
      bugDescription: 'Something broke',
      urgency: 'low',
      rawDiagnostics: makeDiagnostics({
        health: null,
        errorPatterns: [],
        recentSessions: [],
        filteredLogs: [],
        storeStats: { cleanExitFlag: null, autoUpdateState: null },
      }),
      settings: mockSettings,
    });

    const [, options] = mockCallBehindTheScenesWithAuth.mock.calls[0];
    const userMessage = options.messages[0].content;
    expect(userMessage).not.toContain('Steps to Reproduce');
    expect(userMessage).not.toContain('Expected Behavior');
    expect(userMessage).not.toContain('Raw Application Logs');
    expect(userMessage).not.toContain('System Health');
    expect(userMessage).not.toContain('Error Patterns');
  });

  // ---------------------------------------------------------------------------
  // BTS call configuration
  // ---------------------------------------------------------------------------

  it('calls BTS with correct tracking category', async () => {
    await analyzeBugReport(defaultParams);

    const [, , tracking] = mockCallBehindTheScenesWithAuth.mock.calls[0];
    expect(tracking).toEqual({ category: 'bug-report-diagnostics' });
  });

  it('calls BTS with 60s timeout', async () => {
    await analyzeBugReport(defaultParams);

    const [, options] = mockCallBehindTheScenesWithAuth.mock.calls[0];
    expect(options.timeout).toBe(60_000);
  });

  it('calls BTS with maxTokens 2048', async () => {
    // Bumped from 1024 -> 2048 in commit c72170807 ("fix(bts): Increase
    // maxTokens across BTS LLM calls to prevent output truncation") as part
    // of a systematic sweep to stop diagnostic analyses from being cut off
    // mid-response. If this budget changes again, keep test + source in sync.
    await analyzeBugReport(defaultParams);

    const [, options] = mockCallBehindTheScenesWithAuth.mock.calls[0];
    expect(options.maxTokens).toBe(2048);
  });

  it('passes settings to BTS call', async () => {
    await analyzeBugReport(defaultParams);

    const [settings] = mockCallBehindTheScenesWithAuth.mock.calls[0];
    expect(settings).toBe(mockSettings);
  });

  // ---------------------------------------------------------------------------
  // Response extraction
  // ---------------------------------------------------------------------------

  it('extracts text from successful BTS response', async () => {
    const analysisText = '## Likely Root Cause\nMCP server crashed due to connection timeout';
    mockCallBehindTheScenesWithAuth.mockResolvedValue(makeSuccessResponse(analysisText));

    const result = await analyzeBugReport(defaultParams);

    expect(result).toBe(analysisText);
  });

  it('returns null when BTS response has no text content', async () => {
    mockCallBehindTheScenesWithAuth.mockResolvedValue({
      content: [{ type: 'image', text: undefined }],
      model: 'claude-3-haiku-20240307',
    });

    const result = await analyzeBugReport(defaultParams);

    expect(result).toBeNull();
  });

  it('returns null when BTS response has empty text', async () => {
    mockCallBehindTheScenesWithAuth.mockResolvedValue({
      content: [{ type: 'text', text: '' }],
      model: 'claude-3-haiku-20240307',
    });

    const result = await analyzeBugReport(defaultParams);

    expect(result).toBeNull();
  });

  it('returns null when BTS response content array is empty', async () => {
    mockCallBehindTheScenesWithAuth.mockResolvedValue({
      content: [],
      model: 'claude-3-haiku-20240307',
    });

    const result = await analyzeBugReport(defaultParams);

    expect(result).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Graceful degradation
  // ---------------------------------------------------------------------------

  it('returns null on auth failure (no API key)', async () => {
    mockCallBehindTheScenesWithAuth.mockRejectedValue(
      new Error('No API key or OAuth token available for background task'),
    );

    const result = await analyzeBugReport(defaultParams);

    expect(result).toBeNull();
  });

  it('returns null on network error', async () => {
    mockCallBehindTheScenesWithAuth.mockRejectedValue(
      new Error('Anthropic API error (500): Internal Server Error'),
    );

    const result = await analyzeBugReport(defaultParams);

    expect(result).toBeNull();
  });

  it('returns null on timeout (AbortError)', async () => {
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    mockCallBehindTheScenesWithAuth.mockRejectedValue(abortError);

    const result = await analyzeBugReport(defaultParams);

    expect(result).toBeNull();
  });

  it('returns null on unexpected error', async () => {
    mockCallBehindTheScenesWithAuth.mockRejectedValue(new TypeError('Cannot read property'));

    const result = await analyzeBugReport(defaultParams);

    expect(result).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Shutdown awareness
  // ---------------------------------------------------------------------------

  it('returns null immediately when app is shutting down', async () => {
    mockIsShuttingDown.mockReturnValue(true);

    const result = await analyzeBugReport(defaultParams);

    expect(result).toBeNull();
    expect(mockCallBehindTheScenesWithAuth).not.toHaveBeenCalled();
  });

  it('proceeds with analysis when app is not shutting down', async () => {
    mockIsShuttingDown.mockReturnValue(false);

    await analyzeBugReport(defaultParams);

    expect(mockCallBehindTheScenesWithAuth).toHaveBeenCalledOnce();
  });
});

// =============================================================================
// buildFallbackDiagnosticSummary
// =============================================================================

describe('buildFallbackDiagnosticSummary', () => {
  it('includes the bug description, urgency, and gather timestamp', () => {
    const md = buildFallbackDiagnosticSummary({
      bugDescription: 'Tools went sideways',
      urgency: 'high',
      rawDiagnostics: makeDiagnostics(),
      reason: 'llm_failed',
    });

    expect(md).toContain('Tools went sideways');
    expect(md).toContain('**Urgency:** high');
    expect(md).toContain('**Gathered at:** 2026-03-24T10:00:00Z');
  });

  it('annotates the fallback reason at the top so triagers know LLM analysis was skipped', () => {
    const md = buildFallbackDiagnosticSummary({
      bugDescription: 'x',
      urgency: 'low',
      rawDiagnostics: makeDiagnostics(),
      reason: 'llm_failed',
    });

    expect(md).toContain('Deterministic Diagnostic Summary');
    expect(md).toContain('`llm_failed`');
  });

  it('includes optional steps to reproduce and expected behaviour when provided', () => {
    const md = buildFallbackDiagnosticSummary({
      bugDescription: 'x',
      stepsToReproduce: 'Open, click, observe sadness',
      expectedBehavior: 'Less sadness',
      urgency: 'medium',
      rawDiagnostics: makeDiagnostics(),
      reason: 'llm_failed',
    });

    expect(md).toContain('Open, click, observe sadness');
    expect(md).toContain('Less sadness');
  });

  it('renders health, top error patterns, and recent sessions from diagnostics', () => {
    const md = buildFallbackDiagnosticSummary({
      bugDescription: 'x',
      urgency: 'low',
      rawDiagnostics: makeDiagnostics(),
      reason: 'llm_failed',
    });

    expect(md).toContain('## System Health');
    expect(md).toContain('degraded');
    expect(md).toContain('claudeApiKeyValid');

    expect(md).toContain('Top Error Patterns');
    expect(md).toContain('Connection refused');
    expect(md).toContain('5x');

    expect(md).toContain('Recent Sessions');
    expect(md).toContain('session-abc');
  });

  // REGRESSION GUARD (Stage C): the fallback's "Top Error Patterns" is the single
  // most useful section when Phase B (LLM) fails, but the handler runs the WHOLE
  // assembled summary through sanitizeLogMessage as defense-in-depth. Previously
  // every `"<msg>"` was collapsed to `"[content-redacted]"` by the quoted-string
  // rule, blinding the fallback. The msg is now sanitized at the source
  // (sanitizeErrorPatterns) and rendered without surrounding quotes, so the
  // structural stem must survive the blanket pass.
  it('keeps error-pattern stems readable after the handler blanket-sanitize pass', () => {
    const md = buildFallbackDiagnosticSummary({
      bugDescription: 'x',
      urgency: 'low',
      // Mirror what sanitizeErrorPatterns produces in production: the stem is
      // already content-stripped (a quoted secret would be redacted) but the
      // structural prefix survives.
      rawDiagnostics: makeDiagnostics({
        errorPatterns: [
          {
            msg: 'Codex passthrough failed',
            level: 50,
            count: 41,
            firstSeen: '2026-03-24T09:50:00Z',
            lastSeen: '2026-03-24T09:58:00Z',
          },
        ],
      }),
      reason: 'llm_failed',
    });

    // Simulate bugReportHandlers' defense-in-depth pass over the whole document.
    const shipped = sanitizeLogMessage(md);

    expect(shipped).toContain('Top Error Patterns');
    expect(shipped).toContain('Codex passthrough failed'); // stem survives
    expect(shipped).toContain('41x');
    // The error-pattern LINE itself must carry the readable stem, not a
    // collapsed `"[content-redacted]"` (the pre-fix failure mode).
    const patternLine = shipped.split('\n').find((l) => l.includes('41x')) ?? '';
    expect(patternLine).toContain('Codex passthrough failed');
    expect(patternLine).not.toContain('[content-redacted]');
  });

  it('points triagers at the filtered-logs.ndjson attachment rather than embedding content', () => {
    const md = buildFallbackDiagnosticSummary({
      bugDescription: 'x',
      urgency: 'low',
      rawDiagnostics: makeDiagnostics(),
      reason: 'llm_failed',
    });

    expect(md).toContain('Filtered Logs');
    expect(md).toContain('filtered-logs.ndjson');
    // The stub must NOT embed raw filtered log JSON — that would balloon the
    // attachment size and partially duplicate filtered-logs.ndjson.
    expect(md).not.toContain('ECONNREFUSED');
  });

  it('omits optional diagnostic sections when not provided', () => {
    const md = buildFallbackDiagnosticSummary({
      bugDescription: 'x',
      urgency: 'low',
      rawDiagnostics: makeDiagnostics({
        health: null,
        errorPatterns: [],
        recentSessions: [],
        filteredLogs: [],
        storeStats: { cleanExitFlag: null, autoUpdateState: null },
      }),
      reason: 'llm_not_attempted',
    });

    expect(md).not.toContain('## System Health');
    expect(md).not.toContain('Top Error Patterns');
    expect(md).not.toContain('Recent Sessions');
    expect(md).not.toContain('## Store State');
    expect(md).toContain('`llm_not_attempted`');
  });
});
