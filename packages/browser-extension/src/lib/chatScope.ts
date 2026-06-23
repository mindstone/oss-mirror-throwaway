import { fnvHashHex as hashText } from '@rebel/shared/utils/fnvHash';

import type { TabContext } from './intents';

export interface BrowserTabScope {
  key: string;
  mode: 'tab' | 'ephemeral';
  tabId?: number;
  windowId?: number;
  url?: string;
  title?: string;
  urlFingerprint?: string;
  titleFingerprint?: string;
}

export function buildBrowserTabScope(
  tabContext: Partial<TabContext> | null | undefined,
  panelSessionId: string,
): BrowserTabScope {
  const url = typeof tabContext?.url === 'string' && tabContext.url.length > 0
    ? tabContext.url
    : undefined;
  const title = typeof tabContext?.title === 'string' && tabContext.title.length > 0
    ? tabContext.title
    : undefined;
  const urlFingerprint = url ? hashText(url) : undefined;
  const titleFingerprint = title ? hashText(title) : undefined;

  if (typeof tabContext?.tabId === 'number') {
    const locationSegment = urlFingerprint
      ? `url:${urlFingerprint}`
      : titleFingerprint
        ? `title:${titleFingerprint}`
        : `ephemeral:${panelSessionId}`;
    return {
      key: `browser-tab:${tabContext.tabId}:${locationSegment}`,
      mode: 'tab',
      tabId: tabContext.tabId,
      ...(typeof tabContext.windowId === 'number' ? { windowId: tabContext.windowId } : {}),
      ...(url && urlFingerprint ? { url, urlFingerprint } : {}),
      ...(title && titleFingerprint ? { title, titleFingerprint } : {}),
    };
  }

  return {
    key: `browser-ephemeral:${panelSessionId}`,
    mode: 'ephemeral',
    ...(typeof tabContext?.windowId === 'number' ? { windowId: tabContext.windowId } : {}),
    ...(url && urlFingerprint ? { url, urlFingerprint } : {}),
    ...(title && titleFingerprint ? { title, titleFingerprint } : {}),
  };
}

export function hashScopeKey(scopeKey: string): string {
  return hashText(scopeKey);
}
