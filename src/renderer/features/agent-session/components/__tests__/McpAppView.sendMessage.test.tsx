// @vitest-environment happy-dom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { McpAppView } from '../McpAppView';
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

describe('McpAppView sendMessage bridge', () => {
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
        sendMessage: ReturnType<typeof vi.fn>;
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
      sendMessage: vi.fn(async () => ({ success: true })),
      invalidateNonce: vi.fn(async () => ({ success: true })),
      openHtmlInBrowser: vi.fn(),
    };
    (window as unknown as { appApi: { openPath: ReturnType<typeof vi.fn> } }).appApi = {
      openPath: vi.fn(),
    };
  });

  it('issues a fresh nonce, forwards ui/sendMessage to IPC, and returns success', async () => {
    const rendered = renderView();
    await flushPromises();
    const iframe = rendered.container.querySelector('iframe')!;
    const postMessage = vi.spyOn(iframe.contentWindow!, 'postMessage');

    postIframeMessage(iframe, {
      jsonrpc: '2.0',
      id: 7,
      method: 'ui/sendMessage',
      params: { nonce: 'nonce-1', role: 'user', content: 'Use this edited draft.' },
    });
    await flushPromises();

    expect(window.mcpAppsApi.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      sourcePackageId: uiMeta.sourcePackageId,
      toolUseId: 'tool-1',
      sessionId: 'conversation-1',
      conversationId: 'conversation-1',
      nonce: 'nonce-1',
      content: 'Use this edited draft.',
      role: 'user',
    }));
    expect(window.mcpAppsApi.issueNonce).toHaveBeenCalledWith(expect.objectContaining({
      sourcePackageId: uiMeta.sourcePackageId,
      toolUseId: 'tool-1',
      sessionId: 'conversation-1',
      conversationId: 'conversation-1',
    }));
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      id: 7,
      result: { success: true },
    }), '*');

    rendered.unmount();
  });

  it('forwards unauthorized roles to IPC so main owns business validation', async () => {
    window.mcpAppsApi.sendMessage = vi.fn(async () => ({
      success: false as const,
      rejection: {
        jsonRpcCode: -32602,
        reason: 'invalid_role',
        safeMessage: 'View tried to send a message in an unauthorized role.',
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
      id: 8,
      method: 'ui/sendMessage',
      params: { nonce: 'nonce-1', role: 'assistant', content: 'I am the assistant now.' },
    });
    await flushPromises();

    expect(window.mcpAppsApi.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      role: 'assistant',
      content: 'I am the assistant now.',
      nonce: 'nonce-1',
    }));
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      id: 8,
      error: {
        code: -32602,
        message: 'View tried to send a message in an unauthorized role.',
      },
    }), '*');
    expect(trustListener).toHaveBeenCalledWith(expect.objectContaining({
      detail: expect.objectContaining({
        method: 'ui/sendMessage',
        rejection: expect.objectContaining({ reason: 'invalid_role' }),
      }),
    }));

    window.removeEventListener('mcp-app:trust-rejection', trustListener);
    rendered.unmount();
  });

  it('rejects malformed sendMessage requests with missing fields before IPC', async () => {
    const rendered = renderView();
    await flushPromises();
    const iframe = rendered.container.querySelector('iframe')!;
    const postMessage = vi.spyOn(iframe.contentWindow!, 'postMessage');

    postIframeMessage(iframe, {
      jsonrpc: '2.0',
      id: 88,
      method: 'ui/sendMessage',
      params: { role: 'user' },
    });
    await flushPromises();

    expect(window.mcpAppsApi.issueNonce).not.toHaveBeenCalled();
    expect(window.mcpAppsApi.sendMessage).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      id: 88,
      error: {
        code: -32602,
        message: 'Invalid send message request',
      },
    }), '*');

    rendered.unmount();
  });

  it('posts JSON-RPC errors and emits trust rejection events on send failure', async () => {
    window.mcpAppsApi.sendMessage = vi.fn(async () => ({
      success: false as const,
      rejection: {
        jsonRpcCode: -32603,
        reason: 'permission_denied',
        safeMessage: 'View tried to send a message on your behalf. Grant in Settings to enable.',
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
      id: 9,
      method: 'ui/sendMessage',
      params: { nonce: 'nonce-1', role: 'user', content: 'Send this.' },
    });
    await flushPromises();

    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      id: 9,
      error: {
        code: -32603,
        message: 'View tried to send a message on your behalf. Grant in Settings to enable.',
      },
    }), '*');
    expect(trustListener).toHaveBeenCalledWith(expect.objectContaining({
      detail: expect.objectContaining({
        method: 'ui/sendMessage',
        rejection: expect.objectContaining({ reason: 'permission_denied' }),
      }),
    }));

    window.removeEventListener('mcp-app:trust-rejection', trustListener);
    rendered.unmount();
  });
});
