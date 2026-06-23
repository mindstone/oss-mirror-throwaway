/**
 * Safety Prompt Types
 *
 * Shared types for the Safety Prompt system.
 * Used by store, logic, IPC channels, and implementations.
 */

/** Direction of a principle update — allow (permission) or deny (restriction) */
export type PrincipleDirection = 'allow' | 'deny';

/** Who last updated the Safety Prompt */
export type SafetyPromptUpdater = 'user' | 'system' | 'migration';

/** A historical version of the Safety Prompt for undo capability */
export interface SafetyPromptHistoryEntry {
  prompt: string;
  version: number;
  updatedAt: number;
  updatedBy: SafetyPromptUpdater;
}

/** Store schema for SafetyPromptStore */
export type SafetyPromptStoreSchema = {
  /** The Markdown principles document */
  safetyPrompt: string;
  /** Incremented on each update */
  version: number;
  /** Epoch ms of last update */
  lastUpdatedAt: number;
  /** Who triggered the last update */
  lastUpdatedBy: SafetyPromptUpdater;
  /** Gate: block evaluations until migration completes */
  migrationComplete: boolean;
  /** Last versions for undo */
  history: SafetyPromptHistoryEntry[];
};

/** Context describing an action being evaluated */
export type ActionContextSpaceSharingClass = 'private' | 'team' | 'shared' | 'public' | 'unknown';

export interface ActionContextSpaceSharing {
  /** Settings-authoritative audience trust label used by safety eval logic */
  effective: ActionContextSpaceSharingClass;
  /** Which source provided `effective` */
  source: 'settings' | 'frontmatter' | 'default';
  /** Raw sharing class derived from settings, when available */
  settingsValue?: ActionContextSpaceSharingClass;
  /** Raw sharing class derived from frontmatter, when available */
  frontmatterValue?: ActionContextSpaceSharingClass;
  /** True when settings and frontmatter disagree */
  mismatch?: boolean;
}

/**
 * Recent user-intent context for the safety evaluator.
 *
 * Carries the last few user messages from the session (oldest-first) so the
 * evaluator can reason about sustained intent across turns. The current turn's
 * `userMessage` (untrusted, may be tiny) is often insufficient on its own —
 * e.g., turn 2 says "where is the image?" with no clue that turn 1 asked for
 * OpenAI image generation. This fence supplies that missing context.
 *
 * Treated as untrusted user data (fenced separately from the trusted Safety
 * Prompt). See `fenceSessionIntent` in `safetyPromptLogic.ts`.
 *
 * @see docs/plans/260526_safety_eval_context_completeness.md (Stage 2, P0.7)
 */
export interface ActionContextSessionIntent {
  /** Recent user messages, oldest-first, each pre-truncated to a per-message cap. */
  recentUserMessages: string[];
  /** Sum of `recentUserMessages` character lengths (post-truncation). */
  totalChars: number;
}

/**
 * Salience signal injected when the user's most-recent message contains an
 * unambiguous imperative or confirmation directed at the imminent tool. The
 * payload is a SALIENCE hint for the safety evaluator — it does NOT override
 * any safety rule. Confidence-graduated production: only `medium`/`high`
 * classifier results reach the eval (`low` and `none` are filtered upstream).
 *
 * @see docs/plans/260526_safety_eval_context_completeness.md (Stage 3, P0.5)
 * @see fenceUserIntentExplicit in safetyPromptLogic.ts
 */
export interface ActionContextUserIntentExplicit {
  signal: 'imperative' | 'confirmation';
  triggerPhrase: string;
}

export interface ActionContext {
  /** Tool name (e.g., "slack_send_message") */
  toolName: string;
  /** Tool input parameters */
  toolInput: Record<string, unknown>;
  /** Optional human-readable description of the tool's purpose */
  toolDescription?: string;
  /** Optional space description for memory write context */
  spaceDescription?: string;
  /** Optional human-readable target space label (e.g., "Mindstone - Exec") */
  spaceLabel?: string;
  /** Optional normalized sharing context for audience-aware safety decisions */
  spaceSharing?: ActionContextSpaceSharing;
  /** Optional preview of the space README body (first ~1000 chars, after frontmatter) for exclusion policy visibility */
  spaceReadmePreview?: string;
  /** Session type for context-aware evaluation */
  sessionType?: 'interactive' | 'automation' | 'role';
  /** Automation name if applicable */
  automationName?: string;
  /** The user's message that triggered this turn (truncated, fenced as untrusted) */
  userMessage?: string;
  /** Recent session-level user intent (oldest-first, pre-truncated). Untrusted, fenced separately. */
  sessionIntent?: ActionContextSessionIntent;
  /**
   * Optional salience signal that the user's current message contains an
   * unambiguous imperative or confirmation for this tool family. Informational
   * — never authorisation. Stage 3 / P0.5.
   */
  userIntentExplicit?: ActionContextUserIntentExplicit;
}

export interface PersistenceIntentSignal {
  detected: boolean;
  confidence: 'high' | 'medium' | 'low';
  scopeHint: 'trusted_tool' | 'broad' | 'specific';
  triggerPhrase: string;
  rationale: string;
}

/** Result of a safety evaluation */
export interface SafetyEvalResult {
  decision: 'allow' | 'block';
  reason: string;
  confidence: 'high' | 'medium' | 'low';
  persistenceIntent?: PersistenceIntentSignal;
  /**
   * True when the evaluator couldn't reach a decision (e.g. retries exhausted,
   * parse failure, queue timeout, or cooldown short-circuit).
   *
   * Consumers must fail closed (never auto-allow), then route by session policy:
   * interactive desktop asks the user with `blockedBy: 'eval_error'`, automation
   * and other no-human paths stage when possible, and cloud ingress remains
   * fail-closed drop for inbound approvals marked `failClosed === true`.
   */
  failClosed?: boolean;
  /**
   * Diagnostic field distinguishing *why* the evaluator failed closed.
   * Only set when `failClosed` is true. Helps operators distinguish transient
   * concurrency starvation from genuine evaluator failures. (FOX-3231)
   */
  failClosedReason?: 'queue-timeout' | 'parse-failure' | 'retries-exhausted' | 'rate-limited';
  /** Cooldown-window generation captured when `failClosedReason === 'rate-limited'`. */
  cooldownGenerationId?: number;
}

/** Context for a blocked action (extends ActionContext with block reason) */
export interface BlockedActionContext extends ActionContext {
  /** Why the action was blocked */
  blockReason: string;
}

/** A proposed principle update generated by LLM */
export interface PrincipleUpdate {
  /** Short human-readable summary of the proposed change */
  summary: string;
  /** The proposed new principle text */
  proposedPrinciple: string;
  /** The full updated Safety Prompt with the new principle inserted */
  fullUpdatedPrompt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Multiple-choice principle selection types (Gap 3)
// ─────────────────────────────────────────────────────────────────────────────

/** Scope of a generated principle option */
export type PrincipleOptionScope = 'trusted_tool' | 'broad' | 'specific';

/** A single option in the multiple-choice principle selector */
export interface PrincipleOption {
  /** Human-readable label (e.g., "Always allow sending Slack messages") */
  label: string;
  /** Scope — determines how the option is applied */
  scope: PrincipleOptionScope;
}

/** Result of generating principle options */
export interface PrincipleOptionsResult {
  /** The generated options (exactly 3 items, one per scope) */
  options: PrincipleOption[];
}

/** Maximum number of history entries to keep */
export const SAFETY_PROMPT_MAX_HISTORY = 10;
