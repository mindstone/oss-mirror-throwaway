/**
 * Automation Context Lookup
 *
 * Resolves automation identity from a session ID. Used by approval handlers
 * and IPC handlers that need to know which automation a session belongs to,
 * independent of access rules status or grant presence.
 *
 * The store getter is set lazily by index.ts after the AutomationScheduler
 * is created, so hooks can be created before the scheduler exists.
 *
 * Extracted from accessRulesLookup.ts for Stage 2 cleanup — the access rules
 * infrastructure is being removed, but automation identity resolution is still needed.
 */

import type { AutomationDefinition } from '@shared/types';
import { classifySessionKind } from '@shared/sessionKind';

// =============================================================================
// Store access
// =============================================================================

/** Lazy getter for automation store state, set by index.ts at startup */
let automationStoreGetter: (() => { definitions: AutomationDefinition[] }) | null = null;

/**
 * Set the getter function for accessing the automation store.
 * Called by index.ts after the AutomationScheduler is created.
 */
export function setAutomationStoreGetter(
  getter: () => { definitions: AutomationDefinition[] }
): void {
  automationStoreGetter = getter;
}

// =============================================================================
// Automation Context Lookup (identity only — no grant/rule filtering)
// =============================================================================

export interface AutomationContextResult {
  automationId: string;
  automationName: string;
}

/**
 * Resolve automation identity from a session ID.
 * Returns the automation's id and name regardless of access rules status or grant presence.
 * Used by approval handlers that need to persist grants to an automation that may have none yet.
 */
export function getAutomationContext(
  sessionId: string
): AutomationContextResult | null {
  const sessionKind = classifySessionKind(sessionId);
  if (sessionKind !== 'automation' && sessionKind !== 'automation-insight') return null;
  if (!automationStoreGetter) return null;
  const store = automationStoreGetter();

  const match = sessionId.match(/^automation-(.+?)--/);
  if (!match) return null;
  const automationType = match[1];

  const definition = store.definitions.find(
    (d) => d.systemType === automationType || d.id === automationType
  );
  if (!definition) return null;

  return { automationId: definition.id, automationName: definition.name };
}
