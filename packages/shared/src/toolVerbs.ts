/**
 * Canonical side-effect verb heuristics shared across surfaces.
 *
 * This module is intentionally pure and platform-agnostic so both desktop
 * safety flows and shared preview projection can rely on one source of truth.
 */

export const SIDE_EFFECT_VERBS = [
  'send',
  'post',
  'create',
  'delete',
  'remove',
  'update',
  'modify',
  'edit',
  'add',
  'submit',
  'publish',
  'archive',
  'move',
  'copy',
  'transfer',
  'execute',
  'run',
  'trigger',
  'start',
  'stop',
  'cancel',
  'approve',
  'reject',
  'assign',
  'unassign',
  'replace',
  'manage',
] as const;

export const sideEffectPatterns = SIDE_EFFECT_VERBS.map(
  (verb) => new RegExp(`(?:^|_)${verb}(?:_|$)`),
);

function normalizeToolVerbInput(toolId: string): string {
  return toolId
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/-/g, '_')
    .toLowerCase();
}

export function isSideEffectVerb(toolId: string): boolean {
  const normalized = normalizeToolVerbInput(toolId);
  return sideEffectPatterns.some((pattern) => pattern.test(normalized));
}
