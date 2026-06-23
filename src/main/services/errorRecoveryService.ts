/**
 * Error Recovery Service
 *
 * Orchestrates background evaluation of errors to determine if Rebel can help fix them.
 * Implements "Rebel using Rebel" philosophy - using Rebel's own diagnostics and agent
 * capabilities to diagnose issues in the Rebel ecosystem.
 *
 * Flow:
 * 1. Error detected (Safe Mode, config parse, etc.)
 * 2. Quick evaluation: deterministic check for obviously-unfixable errors
 * 3. Agent evaluation: headless agent runs troubleshooting skill with read-only tools
 * 4. Result: can_help | cannot_help | evaluation_failed
 * 5. User action: "Let Rebel fix it" opens pre-populated conversation
 */

import { randomUUID } from 'node:crypto';
import type { AgentEvent, SafeModeErrorCategory, AppSettings } from '@shared/types';
import { createScopedLogger } from '@core/logger';
import { createReadOnlyHook } from './safety/readOnlyHook';
import { agentTurnRegistry } from './agentTurnRegistry';
import { redactSensitiveData } from '../utils/logRedaction';
import { safeJsonParseFromModelText } from '@shared/utils/safeJsonParse';

const log = createScopedLogger({ service: 'errorRecoveryService' });

// Circuit breaker: prevent evaluation loops
const CIRCUIT_BREAKER_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const CIRCUIT_BREAKER_MAX_EVALUATIONS = 3;
const recentEvaluations: Array<{ category: SafeModeErrorCategory; timestamp: number }> = [];

/**
 * Error categories that are definitely outside Rebel's control.
 * Skip agent evaluation for these - show "cannot help" immediately.
 */
const QUICK_CANNOT_HELP_CATEGORIES: SafeModeErrorCategory[] = [
  'network',
  'timeout',
  'process_crash',
  'missing_bundle',
  'spawn_missing_executable',
  'fs_exhaustion',
  'health_timeout',
];

/**
 * Error categories where Rebel likely CAN help (worth running agent evaluation).
 */
const LIKELY_CAN_HELP_CATEGORIES: SafeModeErrorCategory[] = [
  'config_parse',
  'permission',
];

export type ErrorRecoveryStatus = 'idle' | 'evaluating' | 'can_help' | 'cannot_help' | 'evaluation_failed';

export interface ErrorRecoveryRequest {
  errorCategory: SafeModeErrorCategory;
  errorMessage?: string;
  context?: Record<string, unknown>;
}

export interface ErrorRecoveryEvaluation {
  status: ErrorRecoveryStatus;
  canHelp: boolean;
  confidence: 'high' | 'medium' | 'low';
  summary: string;
  suggestedAction?: string;
  contextForConversation: {
    filesExamined: string[];
    relevantExcerpts: Record<string, string>;
    healthCheckSummary?: string;
    diagnosticInfo?: string;
  };
  evaluationDurationMs?: number;
  error?: string;
}

export interface ErrorRecoveryState {
  evaluationId: string | null;
  status: ErrorRecoveryStatus;
  errorCategory: SafeModeErrorCategory | null;
  evaluation: ErrorRecoveryEvaluation | null;
  startedAt: number | null;
  quipIndex: number;
}

const createDefaultState = (): ErrorRecoveryState => ({
  evaluationId: null,
  status: 'idle',
  errorCategory: null,
  evaluation: null,
  startedAt: null,
  quipIndex: 0,
});

type ExecuteAgentTurnFn = (
  turnId: string,
  prompt: string,
  options: {
    sessionId: string;
    onEvent: (event: AgentEvent) => void;
    bypassToolSafety?: boolean;
    readOnlyHook?: ReturnType<typeof createReadOnlyHook>;
  }
) => Promise<void>;

export interface ErrorRecoveryServiceDeps {
  executeAgentTurn: ExecuteAgentTurnFn;
  getSettings: () => AppSettings;
  notifyRenderer?: (state: ErrorRecoveryState) => void;
}

/**
 * Error Recovery Service
 *
 * Singleton service that manages error evaluation lifecycle.
 */
export class ErrorRecoveryService {
  private deps: ErrorRecoveryServiceDeps;
  private state: ErrorRecoveryState = createDefaultState();
  private currentTurnId: string | null = null;

  constructor(deps: ErrorRecoveryServiceDeps) {
    this.deps = deps;
  }

  /**
   * Get current evaluation state.
   */
  getState(): ErrorRecoveryState {
    return { ...this.state };
  }

  /**
   * Check if circuit breaker should prevent evaluation.
   */
  private isCircuitBreakerTripped(category: SafeModeErrorCategory): boolean {
    const now = Date.now();
    // Clean old entries
    while (recentEvaluations.length > 0 && now - recentEvaluations[0].timestamp > CIRCUIT_BREAKER_WINDOW_MS) {
      recentEvaluations.shift();
    }
    // Count recent evaluations for this category
    const recentCount = recentEvaluations.filter(e => e.category === category).length;
    return recentCount >= CIRCUIT_BREAKER_MAX_EVALUATIONS;
  }

  /**
   * Record an evaluation attempt for circuit breaker tracking.
   */
  private recordEvaluationAttempt(category: SafeModeErrorCategory): void {
    recentEvaluations.push({ category, timestamp: Date.now() });
  }

  /**
   * Quick evaluation: deterministic check without agent.
   * Returns null if agent evaluation is needed.
   */
  private quickEvaluate(request: ErrorRecoveryRequest): ErrorRecoveryEvaluation | null {
    const { errorCategory, errorMessage: _errorMessage } = request;

    // Check circuit breaker
    if (this.isCircuitBreakerTripped(errorCategory)) {
      log.warn({ errorCategory }, 'Circuit breaker tripped - skipping evaluation');
      return {
        status: 'cannot_help',
        canHelp: false,
        confidence: 'high',
        summary: 'This error has occurred multiple times recently. Check Settings → Advanced for more details.',
        contextForConversation: {
          filesExamined: [],
          relevantExcerpts: {},
          diagnosticInfo: 'Circuit breaker triggered - repeated error',
        },
      };
    }

    // Categories that are definitely outside Rebel's control
    if (QUICK_CANNOT_HELP_CATEGORIES.includes(errorCategory)) {
      const summaries: Record<string, string> = {
        network: 'This is a network connectivity issue. Check your internet connection and firewall settings.',
        timeout: 'The operation timed out. This could be due to slow network or overloaded servers.',
        process_crash: 'A background process crashed unexpectedly. Try restarting the app or check Settings → Advanced.',
        missing_bundle: 'Part of Rebel\'s bundled tools runtime is missing. Reinstall or update Rebel, then try again.',
        spawn_missing_executable: 'A bundled executable could not be found. Reinstall or update Rebel, then try again.',
        fs_exhaustion: 'The system ran out of available file handles. Close a few apps or restart the computer, then try again.',
        health_timeout: 'The tools server started but did not become ready in time. Try restarting the app or check Settings → Advanced.',
      };

      return {
        status: 'cannot_help',
        canHelp: false,
        confidence: 'high',
        summary: summaries[errorCategory] ?? 'This is outside what Rebel can fix directly.',
        contextForConversation: {
          filesExamined: [],
          relevantExcerpts: {},
          diagnosticInfo: `Quick evaluation: ${errorCategory} errors are typically outside Rebel's control`,
        },
      };
    }

    // Categories that likely need agent evaluation
    if (LIKELY_CAN_HELP_CATEGORIES.includes(errorCategory)) {
      return null; // Needs agent evaluation
    }

    // Unknown category - try agent evaluation
    return null;
  }

  /**
   * Build the evaluation prompt for the agent.
   */
  private buildEvaluationPrompt(request: ErrorRecoveryRequest): string {
    const { errorCategory, errorMessage, context } = request;

    return `# Error Evaluation Task

You are evaluating whether you can help fix an error. Be honest about limitations.

**IMPORTANT:** You are in READ-ONLY evaluation mode. You may read files, search, and run diagnostics. You MUST NOT write, edit, create, or delete any files. Your job is to diagnose, not fix.

## Error Details

- **Category:** ${errorCategory.replace(/_/g, ' ')}
- **Message:** ${errorMessage ?? 'No specific error message provided'}
${context ? `- **Context:** ${JSON.stringify(context, null, 2)}` : ''}

## Your Task

1. **Run \`rebel_diagnostics_quick\` first** to understand overall system state
2. Based on the error category, read relevant files (configs, logs)
3. Determine if this is something you can help fix
4. Report your findings in JSON format

## Output Format

Respond with ONLY a JSON object (no markdown code blocks):

{
  "canHelp": true or false,
  "confidence": "high" | "medium" | "low",
  "summary": "Human-readable explanation of what you found",
  "suggestedAction": "What you would do to fix it (only if canHelp is true)",
  "filesExamined": ["list", "of", "files", "you", "read"],
  "relevantExcerpts": {
    "filename:line-range": "relevant content..."
  },
  "healthCheckSummary": "Summary of rebel_diagnostics_quick results"
}

## Guidelines

- Be fast. Target under 15 seconds.
- Be honest. If you can't help, say so clearly.
- Be specific. "Syntax error on line 15" is better than "config issue".
- Don't attempt fixes. Just evaluate and report.
- Use rebel_diagnostics_quick - it gives you system context quickly.
`;
  }

  /**
   * Parse agent response to extract evaluation result.
   * Handles various formats: raw JSON, markdown code blocks, or JSON embedded in text.
   */
  private parseAgentResponse(response: string): ErrorRecoveryEvaluation | null {
    // Use safe JSON parsing (handles markdown fences, whitespace, non-JSON refusals)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- LLM JSON output shape is variable; narrowed by downstream callers
    let parsed = safeJsonParseFromModelText<Record<string, any>>(
      response,
      'errorRecovery.parseAgentResponse',
      log
    );

    // Fallback: Try to find JSON object with "canHelp" key if standard parsing failed
    if (!parsed) {
      const jsonObjectMatch = response.match(/\{[\s\S]*"canHelp"[\s\S]*\}/);
      if (jsonObjectMatch) {
        try {
          parsed = JSON.parse(jsonObjectMatch[0]);
        } catch {
          // Ignore - will return null below
        }
      }
    }

    if (!parsed) {
      return null;
    }

    // Validate required field exists
    if (typeof parsed.canHelp !== 'boolean' && parsed.canHelp !== undefined) {
      // Try to coerce string "true"/"false" to boolean
      if (parsed.canHelp === 'true') parsed.canHelp = true;
      else if (parsed.canHelp === 'false') parsed.canHelp = false;
    }

    // Redact sensitive data from excerpts (API keys, paths, etc.)
    // Guard against null (typeof null === 'object') and arrays
    const rawExcerpts = 
      parsed.relevantExcerpts && 
      typeof parsed.relevantExcerpts === 'object' && 
      !Array.isArray(parsed.relevantExcerpts) 
        ? parsed.relevantExcerpts 
        : {};
    const redactedExcerpts: Record<string, string> = {};
    for (const [key, value] of Object.entries(rawExcerpts)) {
      if (typeof value === 'string') {
        redactedExcerpts[key] = redactSensitiveData(value);
      }
    }

    return {
      status: parsed.canHelp ? 'can_help' : 'cannot_help',
      canHelp: Boolean(parsed.canHelp),
      confidence: this.normalizeConfidence(parsed.confidence),
      summary: String(parsed.summary ?? 'Evaluation completed'),
      suggestedAction: parsed.suggestedAction ? String(parsed.suggestedAction) : undefined,
      contextForConversation: {
        filesExamined: Array.isArray(parsed.filesExamined) ? parsed.filesExamined : [],
        relevantExcerpts: redactedExcerpts,
        healthCheckSummary: parsed.healthCheckSummary ? String(parsed.healthCheckSummary) : undefined,
      },
    };
  }

  /**
   * Normalize confidence value to expected enum.
   */
  private normalizeConfidence(value: unknown): 'high' | 'medium' | 'low' {
    if (typeof value === 'string') {
      const lower = value.toLowerCase();
      if (lower === 'high') return 'high';
      if (lower === 'low') return 'low';
    }
    return 'medium';
  }

  /**
   * Run agent evaluation with read-only tools.
   */
  private async runAgentEvaluation(request: ErrorRecoveryRequest): Promise<ErrorRecoveryEvaluation> {
    const evaluationId = randomUUID();
    const turnId = randomUUID();
    const sessionId = `error-eval-${evaluationId}`;

    log.info({ evaluationId, errorCategory: request.errorCategory }, 'Starting agent evaluation');

    // Track for cost categorization
    agentTurnRegistry.setTurnCategory(turnId, 'error-evaluation');

    // Store turnId for cancellation
    this.currentTurnId = turnId;

    // Create read-only hook
    const readOnlyHook = createReadOnlyHook({
      turnId,
      onBlocked: (toolName) => {
        log.info({ turnId, toolName }, 'Write operation blocked during evaluation');
      },
    });

    const prompt = this.buildEvaluationPrompt(request);
    let agentResponse = '';

    return new Promise<ErrorRecoveryEvaluation>((resolve) => {
      const timeout = setTimeout(() => {
        log.warn({ evaluationId, turnId }, 'Evaluation timed out');
        // Abort the actual agent turn
        agentTurnRegistry.getActiveTurnController(turnId)?.abort();
        this.currentTurnId = null;
        resolve({
          status: 'evaluation_failed',
          canHelp: false,
          confidence: 'low',
          summary: 'The evaluation took too long. You can still ask Rebel for help.',
          error: 'Evaluation timed out after 45 seconds',
          contextForConversation: {
            filesExamined: [],
            relevantExcerpts: {},
            diagnosticInfo: 'Evaluation timed out',
          },
        });
      }, 45000); // 45 second timeout (similar to coaching evaluation)

      const onEvent = (event: AgentEvent) => {
        if (event.type === 'assistant') {
          // Accumulate streaming assistant text
          agentResponse += event.text ?? '';
        } else if (event.type === 'error') {
          // Error event terminates the turn - resolve immediately
          clearTimeout(timeout);
          const errorMsg = event.error ?? 'Unknown error';
          log.warn({ evaluationId, turnId, error: errorMsg }, 'Evaluation received error event');
          resolve({
            status: 'evaluation_failed',
            canHelp: false,
            confidence: 'low',
            summary: 'Something went wrong during evaluation. You can still ask Rebel for help.',
            error: errorMsg,
            contextForConversation: {
              filesExamined: [],
              relevantExcerpts: {},
              diagnosticInfo: `Evaluation error: ${errorMsg}`,
            },
          });
        } else if (event.type === 'result') {
          clearTimeout(timeout);

          // Use result.text as authoritative output if available, fall back to accumulated assistant text
          const finalResponse = event.text || agentResponse;

          const parsed = this.parseAgentResponse(finalResponse);
          if (parsed) {
            resolve(parsed);
          } else {
            resolve({
              status: 'evaluation_failed',
              canHelp: false,
              confidence: 'low',
              summary: 'Could not understand the evaluation results. You can still ask Rebel for help.',
              error: 'Failed to parse evaluation response',
              contextForConversation: {
                filesExamined: [],
                relevantExcerpts: {},
                diagnosticInfo: 'Response parsing failed',
              },
            });
          }
        }
      };

      // Execute the agent turn
      // Note: The actual executeAgentTurn call needs to be wired up with the read-only hook
      // For now, we call through deps which should be configured in index.ts
      this.deps.executeAgentTurn(turnId, prompt, {
        sessionId,
        onEvent,
        bypassToolSafety: true, // We have our own read-only enforcement
        readOnlyHook,
      }).catch((err) => {
        clearTimeout(timeout);
        log.error({ err, evaluationId, turnId }, 'Agent evaluation failed');
        resolve({
          status: 'evaluation_failed',
          canHelp: false,
          confidence: 'low',
          summary: 'The evaluation encountered an error. You can still ask Rebel for help.',
          error: err instanceof Error ? err.message : String(err),
          contextForConversation: {
            filesExamined: [],
            relevantExcerpts: {},
            diagnosticInfo: `Execution error: ${err instanceof Error ? err.message : String(err)}`,
          },
        });
      });
    });
  }

  /**
   * Start error evaluation.
   * Returns immediately with 'evaluating' status, then broadcasts updates.
   */
  async evaluate(request: ErrorRecoveryRequest): Promise<ErrorRecoveryEvaluation> {
    const evaluationId = randomUUID();
    const startedAt = Date.now();

    log.info({ evaluationId, errorCategory: request.errorCategory }, 'Error evaluation requested');

    // Cancel any ongoing evaluation (both the internal state and the actual agent turn)
    if (this.currentTurnId) {
      agentTurnRegistry.getActiveTurnController(this.currentTurnId)?.abort();
      this.currentTurnId = null;
    }

    // Record attempt for circuit breaker
    this.recordEvaluationAttempt(request.errorCategory);

    // Update state to evaluating
    this.state = {
      evaluationId,
      status: 'evaluating',
      errorCategory: request.errorCategory,
      evaluation: null,
      startedAt,
      quipIndex: 0,
    };
    this.broadcast();

    // Try quick evaluation first
    const quickResult = this.quickEvaluate(request);
    if (quickResult) {
      log.info({ evaluationId, status: quickResult.status }, 'Quick evaluation complete');
      quickResult.evaluationDurationMs = Date.now() - startedAt;

      this.state = {
        ...this.state,
        status: quickResult.status,
        evaluation: quickResult,
      };
      this.broadcast();
      return quickResult;
    }

    // Run agent evaluation
    const agentResult = await this.runAgentEvaluation(request);
    agentResult.evaluationDurationMs = Date.now() - startedAt;

    // Clear turnId after completion
    this.currentTurnId = null;

    // Check if we've been dismissed or superseded by a new evaluation
    if (this.state.evaluationId !== evaluationId) {
      log.info({ evaluationId }, 'Evaluation superseded or dismissed, skipping state update');
      return agentResult;
    }

    log.info(
      { evaluationId, status: agentResult.status, durationMs: agentResult.evaluationDurationMs },
      'Agent evaluation complete'
    );

    this.state = {
      ...this.state,
      status: agentResult.status,
      evaluation: agentResult,
    };
    this.broadcast();

    return agentResult;
  }

  /**
   * Dismiss current evaluation (user clicked dismiss).
   */
  dismiss(): void {
    // Abort the actual agent turn if running
    if (this.currentTurnId) {
      agentTurnRegistry.getActiveTurnController(this.currentTurnId)?.abort();
      this.currentTurnId = null;
    }
    this.state = createDefaultState();
    this.broadcast();
  }

  /**
   * Build the prompt for "Let Rebel fix it" conversation.
   */
  buildFixConversationPrompt(): string | null {
    const { evaluation, errorCategory } = this.state;
    if (!evaluation || !errorCategory) {
      return null;
    }

    const parts: string[] = [];

    // Diagnostic context
    if (evaluation.contextForConversation.healthCheckSummary) {
      parts.push('## Diagnostic Context');
      parts.push(evaluation.contextForConversation.healthCheckSummary);
      parts.push('');
    }

    // What was found
    parts.push('## What Rebel Found');
    parts.push(evaluation.summary);
    parts.push('');

    // Suggested fix
    if (evaluation.suggestedAction) {
      parts.push('## Suggested Fix');
      parts.push(evaluation.suggestedAction);
      parts.push('');
    }

    // Files examined
    if (evaluation.contextForConversation.filesExamined.length > 0) {
      parts.push('## Files Examined');
      parts.push(evaluation.contextForConversation.filesExamined.join(', '));
      parts.push('');
    }

    // Request
    parts.push('Please help me fix this issue.');

    return parts.join('\n');
  }

  /**
   * Broadcast state to renderer.
   */
  private broadcast(): void {
    this.deps.notifyRenderer?.(this.getState());
  }
}

// Singleton instance (initialized in index.ts)
let errorRecoveryService: ErrorRecoveryService | null = null;

export function initializeErrorRecoveryService(deps: ErrorRecoveryServiceDeps): ErrorRecoveryService {
  errorRecoveryService = new ErrorRecoveryService(deps);
  log.info('Error recovery service initialized');
  return errorRecoveryService;
}

export function getErrorRecoveryService(): ErrorRecoveryService {
  if (!errorRecoveryService) {
    throw new Error('Error recovery service not initialized');
  }
  return errorRecoveryService;
}
