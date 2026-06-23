export interface McpAppContextEntry {
  sourcePackageId: string;
  conversationId: string;
  toolUseId: string;
  content?: string;
  structuredContent?: unknown;
  storedAt: string;
}

interface StoredContextEntry extends McpAppContextEntry {
  sequence: number;
}

const contextEntries = new Map<string, StoredContextEntry>();
let sequence = 0;

function contextKey(sourcePackageId: string, conversationId: string): string {
  return `${sourcePackageId}\u0000${conversationId}`;
}

export function storeContext(entry: McpAppContextEntry): void {
  sequence += 1;
  contextEntries.set(contextKey(entry.sourcePackageId, entry.conversationId), {
    ...entry,
    sequence,
  });
}

export function getContextsForConversation(conversationId: string): McpAppContextEntry[] {
  return Array.from(contextEntries.values())
    .filter((entry) => entry.conversationId === conversationId)
    .sort((a, b) => a.sequence - b.sequence)
    .map(({ sequence: _sequence, ...entry }) => ({ ...entry }));
}

export function cleanupConversation(conversationId: string): void {
  for (const [key, entry] of contextEntries) {
    if (entry.conversationId === conversationId) {
      contextEntries.delete(key);
    }
  }
}

export function cleanupOlderThan(maxEntriesPerSource: number): void {
  if (maxEntriesPerSource < 1) {
    contextEntries.clear();
    return;
  }

  const bySource = new Map<string, StoredContextEntry[]>();
  for (const entry of contextEntries.values()) {
    const entries = bySource.get(entry.sourcePackageId) ?? [];
    entries.push(entry);
    bySource.set(entry.sourcePackageId, entries);
  }

  for (const entries of bySource.values()) {
    const sorted = entries.sort((a, b) => b.sequence - a.sequence);
    for (const staleEntry of sorted.slice(maxEntriesPerSource)) {
      contextEntries.delete(contextKey(staleEntry.sourcePackageId, staleEntry.conversationId));
    }
  }
}

export const mcpAppModelContextStore = {
  storeContext,
  getContextsForConversation,
  cleanupConversation,
  cleanupOlderThan,
};

export function _resetMcpAppModelContextStoreForTests(): void {
  contextEntries.clear();
  sequence = 0;
}
