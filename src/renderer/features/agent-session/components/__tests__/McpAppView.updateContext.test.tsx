// @vitest-environment happy-dom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createIframeInstanceId, McpAppView } from '../McpAppView';
import type { McpAppUiMeta } from '@shared/types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const uiMeta: McpAppUiMeta = {
  resourceUri: 'ui://google-workspace/compose-email',
  sourcePackageId: 'GoogleWorkspace-joshua-example-com',
};

function renderView(): { container: HTMLElement; root: Root; unmount: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <McpAppView
        uiMeta={uiMeta}
        sessionId="conversation-1"
        conversationId="conversation-1"
        toolUseId="tool-1"
        theme="dark"
      />,
    );
  });
  return {
    container,
    root,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

async function flushPromises(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function postIframeMessage(iframe: HTMLIFrameElement, data: unknown): void {
  window.dispatchEvent(new MessageEvent('message', {
    data,
    origin: 'null',
    source: iframe.contentWindow,
  }));
}

describe('McpAppView updateModelContext bridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(globalThis.URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'data:text/html,<html><body>ready</body></html>'),
    });
    Object.defineProperty(globalThis.URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    });
    (window as unknown as {
      mcpAppsApi: {
        readResource: ReturnType<typeof vi.fn>;
        issueNonce: ReturnType<typeof vi.fn>;
        updateContext: ReturnType<typeof vi.fn>;
        invalidateNonce: ReturnType<typeof vi.fn>;
        openHtmlInBrowser: ReturnType<typeof vi.fn>;
      };
      appApi: { openPath: ReturnType<typeof vi.fn> };
    }).mcpAppsApi = {
      readResource: vi.fn(async () => ({
        success: true,
        contents: [{ uri: uiMeta.resourceUri, mimeType: 'text/html', text: '<html><body>ready</body></html>' }],
      })),
      issueNonce: vi.fn(async () => ({ success: true, nonce: 'nonce-1' })),
      updateContext: vi.fn(async () => ({ success: true })),
      invalidateNonce: vi.fn(async () => ({ success: true })),
      openHtmlInBrowser: vi.fn(),
    };
    (window as unknown as { appApi: { openPath: ReturnType<typeof vi.fn> } }).appApi = {
      openPath: vi.fn(),
    };
  });

  it('requires crypto.randomUUID for iframe instance IDs', () => {
    const originalCrypto = globalThis.crypto;
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: {},
    });

    expect(() => createIframeInstanceId()).toThrow('crypto.randomUUID');

    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: originalCrypto,
    });
  });

  it('returns a nonce on ui/initialize and forwards updateModelContext to IPC', async () => {
    const rendered = renderView();
    await flushPromises();
    const iframe = rendered.container.querySelector('iframe');
    expect(iframe?.contentWindow).toBeTruthy();
    const postMessage = vi.spyOn(iframe!.contentWindow!, 'postMessage');

    postIframeMessage(iframe!, { jsonrpc: '2.0', id: 1, method: 'ui/initialize' });
    await flushPromises();

    expect(window.mcpAppsApi.issueNonce).toHaveBeenCalledWith(expect.objectContaining({
      sourcePackageId: uiMeta.sourcePackageId,
      sessionId: 'conversation-1',
      conversationId: 'conversation-1',
      toolUseId: 'tool-1',
      iframeInstanceId: expect.any(String),
    }));
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      id: 1,
      result: expect.objectContaining({ nonce: 'nonce-1' }),
    }), '*');

    postIframeMessage(iframe!, {
      jsonrpc: '2.0',
      id: 2,
      method: 'ui/updateModelContext',
      params: { nonce: 'nonce-1', content: 'Use this draft recipient.' },
    });
    await flushPromises();

    expect(window.mcpAppsApi.updateContext).toHaveBeenCalledWith(expect.objectContaining({
      sourcePackageId: uiMeta.sourcePackageId,
      toolUseId: 'tool-1',
      sessionId: 'conversation-1',
      conversationId: 'conversation-1',
      nonce: 'nonce-1',
      content: 'Use this draft recipient.',
    }));
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      id: 2,
      result: { success: true },
    }), '*');

    rendered.unmount();
    expect(window.mcpAppsApi.invalidateNonce).toHaveBeenCalledWith({
      iframeInstanceId: expect.any(String),
    });
  });

  it('forwards missing-content updateModelContext requests to IPC for host validation', async () => {
    const rendered = renderView();
    await flushPromises();
    const iframe = rendered.container.querySelector('iframe')!;

    postIframeMessage(iframe, {
      jsonrpc: '2.0',
      id: 22,
      method: 'ui/updateModelContext',
      params: { nonce: 'nonce-1' },
    });
    await flushPromises();

    expect(window.mcpAppsApi.updateContext).toHaveBeenCalledWith(expect.objectContaining({
      nonce: 'nonce-1',
    }));
    rendered.unmount();
  });

  it('posts JSON-RPC errors and emits trust rejection events on update failure', async () => {
    window.mcpAppsApi.updateContext = vi.fn(async () => ({
      success: false,
      rejection: {
        jsonRpcCode: -32603,
        reason: 'permission_denied',
        safeMessage: 'View tried to provide context to the assistant. Grant in Settings to enable.',
      },
    }));
    const trustListener = vi.fn();
    window.addEventListener('mcp-app:trust-rejection', trustListener);
    const rendered = renderView();
    await flushPromises();
    const iframe = rendered.container.querySelector('iframe')!;
    const postMessage = vi.spyOn(iframe.contentWindow!, 'postMessage');

    postIframeMessage(iframe, {
      jsonrpc: '2.0',
      id: 3,
      method: 'ui/updateModelContext',
      params: { nonce: 'nonce-1', content: 'Context' },
    });
    await flushPromises();

    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      id: 3,
      error: {
        code: -32603,
        message: 'View tried to provide context to the assistant. Grant in Settings to enable.',
      },
    }), '*');
    expect(trustListener).toHaveBeenCalledTimes(1);

    window.removeEventListener('mcp-app:trust-rejection', trustListener);
    rendered.unmount();
  });

  it('returns -32601 for unknown JSON-RPC methods', async () => {
    const rendered = renderView();
    await flushPromises();
    const iframe = rendered.container.querySelector('iframe')!;
    const postMessage = vi.spyOn(iframe.contentWindow!, 'postMessage');

    postIframeMessage(iframe, { jsonrpc: '2.0', id: 4, method: 'ui/unknown' });

    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      id: 4,
      error: expect.objectContaining({ code: -32601 }),
    }), '*');

    rendered.unmount();
  });
});
