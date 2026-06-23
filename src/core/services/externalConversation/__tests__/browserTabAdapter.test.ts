import { describe, it, expect } from 'vitest';
import { BrowserTabAdapter, BROWSER_TAB_TOOLS } from '../adapters/browserTabAdapter';
import type { BrowserTabContext } from '../externalContext';

describe('BrowserTabAdapter', () => {
  it('getContextTools returns correct tools', () => {
    const adapter = new BrowserTabAdapter();
    expect(adapter.getContextTools()).toEqual(BROWSER_TAB_TOOLS);
  });

  it('formatInitialPrompt correctly formats the intent', () => {
    const adapter = new BrowserTabAdapter();
    const ctx: BrowserTabContext = {
      kind: 'browser-tab',
      identity: { tabId: 1, origin: 'https://example.com', pathname: '/test' },
      metadata: { url: 'https://example.com/test', title: 'Test Page' },
    };

    const res = adapter.formatInitialPrompt({
      intent: 'summarise',
      context: ctx,
    });
    expect(res).toContain('Summarise the page I\'m looking at.');
    expect(res).toContain('Tab: Test Page — https://example.com/test');
  });

  it('assertContextCanBind throws if tabs do not match materially', () => {
    const adapter = new BrowserTabAdapter();
    const ctx1: BrowserTabContext = {
      kind: 'browser-tab',
      identity: { tabId: 1, origin: 'https://example.com', pathname: '/test' },
      metadata: { url: 'https://example.com/test', title: 'Test Page' },
    };
    const ctx2: BrowserTabContext = {
      kind: 'browser-tab',
      identity: { tabId: 2, origin: 'https://other.com', pathname: '/other' },
      metadata: { url: 'https://other.com/other', title: 'Other Page' },
    };

    expect(() => adapter.assertContextCanBind('c1', ctx1, ctx2)).toThrow(/That browser conversation belongs to a different tab/);
  });

  it('assertContextCanBind succeeds if tabs match materially', () => {
    const adapter = new BrowserTabAdapter();
    const ctx1: BrowserTabContext = {
      kind: 'browser-tab',
      identity: { tabId: 1, origin: 'https://example.com', pathname: '/test' },
      metadata: { url: 'https://example.com/test', title: 'Test Page' },
    };
    const ctx2: BrowserTabContext = {
      kind: 'browser-tab',
      identity: { tabId: 1, origin: 'https://example.com', pathname: '/test' },
      metadata: { url: 'https://example.com/test', title: 'Test Page Updated' },
    };

    expect(() => adapter.assertContextCanBind('c1', ctx1, ctx2)).not.toThrow();
  });
});
