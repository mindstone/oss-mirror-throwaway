import type { PluginPreTurnContext } from '@shared/ipc/schemas/plugins';

const MAX_CONTEXT_CHARS_PER_PLUGIN = 2_000;
const MAX_CONTEXT_CHARS_TOTAL = 5_000;

let cachedContexts: PluginPreTurnContext[] = [];

function normalizePluginContexts(input: PluginPreTurnContext[]): PluginPreTurnContext[] {
  const sorted = input
    .map((context) => ({
      ...context,
      content: context.content.trim().slice(0, MAX_CONTEXT_CHARS_PER_PLUGIN),
    }))
    .filter((context) => context.content.length > 0)
    .sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.pluginId.localeCompare(b.pluginId);
    });

  let remaining = MAX_CONTEXT_CHARS_TOTAL;
  const keptReversed: PluginPreTurnContext[] = [];

  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    if (remaining <= 0) break;
    const context = sorted[index];
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

export function setPluginPreTurnContexts(contexts: PluginPreTurnContext[]): PluginPreTurnContext[] {
  cachedContexts = normalizePluginContexts(contexts);
  return cachedContexts;
}

export function getPluginPreTurnContexts(): PluginPreTurnContext[] {
  return [...cachedContexts];
}
