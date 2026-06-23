/** @deprecated — use ConversationScopeResolver from @core/services/externalConversation */
import type { TabContext } from '../shared/protocol';
import type { BrowserTabContext } from '../../services/externalConversation/externalContext';
import { conversationScopeResolver } from '../../services/externalConversation/conversationScopeResolver';

export interface BrowserConversationScopeBinding {
  conversationId: string;
  tabContext: TabContext;
  boundAt: number;
}

export { tabContextsMateriallyMatch } from '../../services/externalConversation/externalContext';

export function tabContextToBrowserTabContext(tab: TabContext): BrowserTabContext {
  const url = tab.url || '';
  let origin = '';
  let pathname = '';
  let search = '';
  let hash = '';

  try {
    if (url) {
      const parsed = new URL(url);
      origin = parsed.origin.toLowerCase();
      pathname = parsed.pathname;
      search = parsed.search;
      hash = parsed.hash;
    }
  } catch {
    // Ignore parse errors, leave empty
  }

  return {
    kind: 'browser-tab',
    identity: {
      tabId: tab.tabId ?? -1,
      origin,
      pathname,
    },
    metadata: {
      url,
      title: tab.title,
      search: search || undefined,
      hash: hash || undefined,
      windowId: tab.windowId,
    },
  };
}

export class BrowserConversationScopeRegistry {
  constructor(private readonly maxBindings = 500) {}

  bind(conversationId: string, tabContext: TabContext): void {
    if (!conversationId || typeof tabContext.tabId !== 'number') return;
    const ctx = tabContextToBrowserTabContext(tabContext);
    conversationScopeResolver.bindConversation(conversationId, ctx);
  }

  get(conversationId: string | null | undefined): BrowserConversationScopeBinding | null {
    if (!conversationId) return null;
    const binding = conversationScopeResolver.getBinding(conversationId);
    if (!binding || binding.context.kind !== 'browser-tab') return null;

    const meta = binding.context.metadata;
    const tabContext: TabContext = {
      tabId: binding.context.identity.tabId,
    };
    if (meta.url !== undefined) tabContext.url = meta.url;
    if (meta.title !== undefined) tabContext.title = meta.title;
    if (meta.windowId !== undefined) tabContext.windowId = meta.windowId;

    return {
      conversationId: binding.conversationId,
      tabContext,
      boundAt: binding.boundAt,
    };
  }

  clear(conversationId: string): void {
    conversationScopeResolver.releaseBinding(conversationId);
  }

  clearAll(): void {
    conversationScopeResolver.clearAll();
  }
}

export const browserConversationScopeRegistry = new BrowserConversationScopeRegistry();
