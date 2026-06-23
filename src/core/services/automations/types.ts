import type { AutomationDefinition } from '@shared/types';

/**
 * Context passed to a registered automation script.
 * The `automation` field is a snapshot frozen at dispatch time — scripts must not mutate it.
 * Attempting to mutate `ctx.automation` will throw in strict mode; it will NOT affect scheduler state.
 */
export interface ScriptAutomationContext {
  /** Frozen snapshot of the automation definition at dispatch time. */
  readonly automation: Readonly<AutomationDefinition>;
  /** Unique run identifier (matches the persisted AutomationRun.id). */
  readonly runId: string;
  /** How this run was triggered. */
  readonly trigger: 'manual' | 'scheduled' | 'event' | 'catchup';
  /** Optional abort signal for future cancellation wiring. Not yet propagated by the scheduler in PR 1. */
  readonly signal?: AbortSignal;
  /**
   * Scoped logger for the script run. Use the pino-first argument order: `log.info({ ... }, 'message')`.
   * The concrete logger is passed in by the scheduler; core does not import pino directly.
   */
  readonly log: ScriptAutomationLogger;
}

/** Minimal logger surface the script can rely on. */
export interface ScriptAutomationLogger {
  debug(obj: Record<string, unknown>, message: string): void;
  info(obj: Record<string, unknown>, message: string): void;
  warn(obj: Record<string, unknown>, message: string): void;
  error(obj: Record<string, unknown>, message: string): void;
}

/**
 * Outcome returned by a successful (non-throwing) script run.
 * Throwing is also supported: the runner maps thrown errors to `{ status: 'failure', errorMessage }`.
 */
export interface ScriptAutomationResult {
  /** Optional human-readable summary. Logged by the runner; NOT broadcast to session in PR 1. */
  readonly summary?: string;
  /** Optional structured output the script produced. Stage 3 threads this into analytics. */
  readonly output?: Record<string, unknown>;
}

/**
 * The function signature a registered script must conform to.
 * Throwing, rejecting, or returning a rejected Promise all produce a failure run.
 */
export type AutomationScriptFn = (ctx: ScriptAutomationContext) => Promise<ScriptAutomationResult | void>;

/**
 * Outcome produced by `runAutomationScript`. The scheduler adapts this to its internal result shape.
 * No throws escape the runner — this is the single normalized result.
 */
export type ScriptRunOutcome =
  | { status: 'success'; summary?: string; output?: Record<string, unknown> }
  | { status: 'failure'; errorCode: ScriptRunErrorCode; errorMessage: string };

export type ScriptRunErrorCode =
  | 'MISSING_SCRIPT_MODULE' // definition.scriptModule is undefined/empty
  | 'UNKNOWN_SCRIPT_MODULE' // no script registered under that id
  | 'INVALID_EXECUTOR' // executor value is neither 'llm' nor 'script' (unknown future/malformed value)
  | 'SCRIPT_THREW'; // script threw, rejected, or otherwise failed at runtime
