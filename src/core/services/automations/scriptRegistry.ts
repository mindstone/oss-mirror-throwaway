import type { AutomationScriptFn } from './types';

const automationScripts = new Map<string, AutomationScriptFn>();

function assertValidModuleId(moduleId: string): void {
  if (moduleId.trim().length === 0) {
    throw new Error('Automation script moduleId must be a non-empty string.');
  }
}

/**
 * Register an automation script under a stable module identifier.
 * @throws if `moduleId` is already registered. Use `replaceAutomationScript` for explicit hot-reload.
 * @returns an unregister function for scoped registration (useful in tests).
 */
export function registerAutomationScript(moduleId: string, fn: AutomationScriptFn): () => void {
  assertValidModuleId(moduleId);

  if (automationScripts.has(moduleId)) {
    throw new Error(`Automation script "${moduleId}" is already registered. Use replaceAutomationScript for hot-reload.`);
  }

  automationScripts.set(moduleId, fn);

  return () => {
    if (automationScripts.get(moduleId) === fn) {
      automationScripts.delete(moduleId);
    }
  };
}

/**
 * Get the registered script for a module identifier, or undefined if not registered.
 */
export function getAutomationScript(moduleId: string): AutomationScriptFn | undefined {
  assertValidModuleId(moduleId);
  return automationScripts.get(moduleId);
}

/**
 * Replace a registered script. Unlike `register`, this does not throw on existing registration.
 * Intended for plugin hot-reload paths.
 */
export function replaceAutomationScript(moduleId: string, fn: AutomationScriptFn): void {
  assertValidModuleId(moduleId);
  automationScripts.set(moduleId, fn);
}

/**
 * Unregister a script. No-op if not registered.
 */
export function unregisterAutomationScript(moduleId: string): void {
  assertValidModuleId(moduleId);
  automationScripts.delete(moduleId);
}

/**
 * Clear the entire registry. Test-only utility; call in `afterEach`.
 */
export function clearAutomationScripts(): void {
  automationScripts.clear();
}

/**
 * Return the list of currently registered module IDs. Test/diagnostic utility.
 */
export function listAutomationScripts(): string[] {
  return Array.from(automationScripts.keys()).sort();
}
