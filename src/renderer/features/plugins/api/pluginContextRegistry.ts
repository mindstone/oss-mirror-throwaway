/**
 * Plugin pre-turn context registry.
 *
 * Stores plugin-provided context callbacks in-memory so the latest
 * context can be gathered quickly before agent turns.
 */

import type { PluginContext } from './types';

const MAX_CONTEXT_CHARS_PER_PLUGIN = 2_000;
const MAX_CONTEXT_CHARS_TOTAL = 5_000;

interface PluginContextRegistration {
  registrationId: string;
  pluginId: string;
  pluginName: string;
  getContext: () => string | null;
  priority: number;
  registeredOrder: number;
}

const registrations = new Map<string, PluginContextRegistration>();
let registrationCounter = 0;

function buildSortedContexts(): PluginContext[] {
  const contexts: Array<PluginContext & { registeredOrder: number }> = [];

  for (const registration of registrations.values()) {
    let content: string | null;
    try {
      content = registration.getContext();
    } catch {
      continue;
    }

    if (typeof content !== 'string') continue;
    const normalized = content.trim();
    if (!normalized) continue;

    contexts.push({
      pluginId: registration.pluginId,
      pluginName: registration.pluginName,
      content: normalized.slice(0, MAX_CONTEXT_CHARS_PER_PLUGIN),
      priority: registration.priority,
      registeredOrder: registration.registeredOrder,
    });
  }

  contexts.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.registeredOrder - b.registeredOrder;
  });

  return contexts.map(({ registeredOrder: _registeredOrder, ...context }) => context);
}

function applyTotalCap(sortedContexts: PluginContext[]): PluginContext[] {
  let remaining = MAX_CONTEXT_CHARS_TOTAL;
  const keptReversed: PluginContext[] = [];

  // Walk from highest priority to lowest so low-priority contexts are trimmed first.
  for (let index = sortedContexts.length - 1; index >= 0; index -= 1) {
    if (remaining <= 0) break;
    const context = sortedContexts[index];
    const content = context.content.slice(0, remaining);
    if (!content) continue;

    keptReversed.push({
      ...context,
      content,
    });
    remaining -= content.length;
  }

  return keptReversed.reverse();
}

export function registerPluginContext(
  pluginId: string,
  pluginName: string,
  getContext: () => string | null,
  priority: number,
): () => void {
  const registrationId = `${pluginId}:${++registrationCounter}`;
  registrations.set(registrationId, {
    registrationId,
    pluginId,
    pluginName,
    getContext,
    priority,
    registeredOrder: registrationCounter,
  });

  return () => {
    registrations.delete(registrationId);
  };
}

export function getPluginContexts(): PluginContext[] {
  return applyTotalCap(buildSortedContexts());
}
