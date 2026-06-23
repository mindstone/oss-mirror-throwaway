/**
 * Safety Module
 *
 * Shared infrastructure for safety evaluation across domains (tools, memory, etc.).
 *
 * This module provides:
 * - Unified types for safety levels, risk assessment, and approvals
 * - Single-use approval storage for "Allow once" behavior
 *
 * Usage:
 * ```typescript
 * import {
 *   type SafetyLevel,
 *   type RiskLevel,
 *   storeSingleUseApproval,
 *   consumeSingleUseApproval,
 * } from './safety';
 * ```
 */

// Types
export type {
  SafetyLevel,
  RiskLevel,
  RiskAssessment,
  SafetyDecision,
  SafetyDomain,
  ApprovalRequest,
  ApprovalScope,
  ApprovalResponse,
} from './types';

// Single-use approvals (consumed on first check)
// NOTE: the execution-expectation query/mark functions are intentionally NOT
// re-exported here — their only consumer (approvalExecutionGuardHook) imports
// directly from './sessionApprovals'.
export {
  storeSingleUseApproval,
  consumeSingleUseApproval,
  clearSessionSingleUseApprovals,
} from './sessionApprovals';

// Pending approvals persistence (tool safety)
export {
  type PersistedToolApprovalRequest,
  getPendingApprovals,
  addPendingApproval,
  removePendingApproval,
  clearPendingApprovalsForTurn,
  clearPendingApprovalsForSession,
  filterStaleApprovals,
  clearAllPendingApprovals,
} from './pendingApprovalsStore';

// Pending memory approvals persistence
export {
  type PersistedMemoryApprovalRequest,
  getPendingMemoryApprovals,
  addPendingMemoryApproval,
  removePendingMemoryApproval,
  clearPendingMemoryApprovalsForSession,
  clearAllPendingMemoryApprovals,
  filterStaleMemoryApprovals,
} from './pendingApprovalsStore';

// Memory write hook (Phase 2 - intercepts Edit/Create during memory turns)
export {
  createMemoryWriteHook,
  handleMemoryWriteApprovalResponse,
  hasPendingWriteApprovals,
  clearAllPendingWriteApprovals,
  type MemoryWriteApprovalRequest,
  type MemoryWriteHookOptions,
} from './memoryWriteHook';

// MCP deny hook (blocks MCP tool calls during memory-update turns for cache alignment)
export { createMcpDenyHook } from './mcpDenyHook';
