/**
 * Shared Safety Types
 *
 * Unified type definitions for safety evaluation across domains (tools, memory, etc.).
 * These types provide a consistent interface for risk assessment and approval flows.
 */

/**
 * Unified safety level - same 3-tier pattern for all domains.
 * Each domain interprets these levels in its own context.
 *
 * - 'permissive': Minimal interruption, only catastrophic operations prompt
 * - 'balanced': Reasonable protection, prompt for risky external actions (DEFAULT)
 * - 'cautious': Extra protection, prompt more frequently
 */
export type SafetyLevel = 'permissive' | 'balanced' | 'cautious';

/**
 * Risk level from evaluation.
 * Evaluators assess operations and return one of these levels.
 */
export type RiskLevel = 'low' | 'medium' | 'high';

/**
 * Risk assessment result from any evaluator.
 */
export interface RiskAssessment {
  risk: RiskLevel;
  reason: string;
  /** If true, this tool is safe to permanently trust (read-only, no external side effects) */
  allowPermanentTrust?: boolean;
}

/**
 * Decision after applying safety level to risk assessment.
 * - 'allow': Proceed without user interaction
 * - 'deny': Block the operation (used when approval is needed but we return immediately)
 * - 'ask': Request user approval (mapped to 'deny' in non-blocking architecture)
 */
export type SafetyDecision = 'allow' | 'deny' | 'ask';

/**
 * Domain identifier for safety operations.
 * Used to namespace session approvals and approval requests.
 */
export type SafetyDomain = 'tool' | 'memory';

/**
 * Approval request sent to UI.
 * Generic structure that can be specialized by domain.
 */
export interface ApprovalRequest {
  /** Unique ID for this request (e.g., toolUseID, memoryUpdateId) */
  id: string;
  /** Which safety domain this belongs to */
  domain: SafetyDomain;
  /** Session this request belongs to */
  sessionId: string;
  /** Turn that triggered this request */
  turnId: string;
  /** Identifier for the operation (tool name, space path, etc.) */
  identifier: string;
  /** Human-readable name for display */
  displayName: string;
  /** Reason approval is needed */
  reason: string;
  /** Domain-specific additional data */
  metadata?: Record<string, unknown>;
  /** When the request was created */
  timestamp: number;
}

/**
 * Scope for approval - how long the approval lasts.
 */
export type ApprovalScope = 'once' | 'session' | 'always';

/**
 * User response to an approval request.
 */
export interface ApprovalResponse {
  /** ID of the request being responded to */
  requestId: string;
  /** Whether the user approved */
  approved: boolean;
  /** How long the approval should last */
  scope: ApprovalScope;
}

// =============================================================================
// Observed Tool Calls
// =============================================================================

/**
 * A tool call observed during an automation run.
 * Used by agentTurnRegistry to track tool calls for safety analysis.
 *
 * Relocated from accessRulesGenerator.ts for Stage 2 cleanup.
 */
export interface ObservedToolCall {
  toolName: string;
  toolInput: Record<string, unknown>;
  timestamp: number;
}
