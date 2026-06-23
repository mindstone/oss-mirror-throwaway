// @vitest-environment happy-dom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpAppUiMeta } from '@shared/types';
import { McpAppView } from '../McpAppView';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const uiMeta: McpAppUiMeta = {
  resourceUri: 'ui://RebelCanvas/form?id=form-1',
  sourcePackageId: 'RebelCanvas',
};

function renderView(): { container: HTMLElement; root: Root; unmount: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <McpAppView
        uiMeta={uiMeta}
        sessionId="session-1"
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

async function loadInlineIframe(rendered: { container: HTMLElement }): Promise<HTMLIFrameElement> {
  await flushPromises();
  const iframe = rendered.container.querySelector('iframe')!;
  act(() => {
    iframe.dispatchEvent(new Event('load'));
  });
  await flushPromises();
  return iframe;
}

async function openFullscreen(rendered: { container: HTMLElement }): Promise<HTMLIFrameElement> {
  const button = rendered.container.querySelector('[aria-label="Expand preview"]') as HTMLButtonElement;
  act(() => button.click());
  await flushPromises();
  const iframes = Array.from(document.body.querySelectorAll('iframe'));
  expect(iframes).toHaveLength(2);
  return iframes[1];
}

describe('McpAppView iframe instance id split', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = '';
    Object.defineProperty(globalThis.URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'data:text/html,<html><body>ready</body></html>'),
    });
    Object.defineProperty(globalThis.URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    });
    let nonceCount = 0;
    (window as unknown as {
      mcpAppsApi: {
        readResource: ReturnType<typeof vi.fn>;
        issueNonce: ReturnType<typeof vi.fn>;
        sendMessage: ReturnType<typeof vi.fn>;
        updateContext: ReturnType<typeof vi.fn>;
        callTool: ReturnType<typeof vi.fn>;
        invalidateNonce: ReturnType<typeof vi.fn>;
        openHtmlInBrowser: ReturnType<typeof vi.fn>;
      };
      appApi: { openPath: ReturnType<typeof vi.fn> };
    }).mcpAppsApi = {
      readResource: vi.fn(async () => ({
        success: true,
        contents: [{ uri: uiMeta.resourceUri, mimeType: 'text/html', text: '<html><body>ready</body></html>' }],
      })),
      issueNonce: vi.fn(async () => ({ success: true, nonce: `nonce-${++nonceCount}` })),
      sendMessage: vi.fn(async () => ({ success: true })),
      updateContext: vi.fn(async () => ({ success: true })),
      callTool: vi.fn(async () => ({ success: true, result: { ok: true } })),
      invalidateNonce: vi.fn(async () => ({ success: true })),
      openHtmlInBrowser: vi.fn(),
    };
    (window as unknown as { appApi: { openPath: ReturnType<typeof vi.fn> } }).appApi = {
      openPath: vi.fn(),
    };
  });

  it('uses the :inline instance id for inline iframe sendMessage trust calls', async () => {
    const rendered = renderView();
    const iframe = await loadInlineIframe(rendered);

    postIframeMessage(iframe, {
      jsonrpc: '2.0',
      id: 1,
      method: 'ui/sendMessage',
      params: { role: 'user', content: 'Inline submit' },
    });
    await flushPromises();

    expect(window.mcpAppsApi.issueNonce).toHaveBeenCalledWith(expect.objectContaining({
      iframeInstanceId: expect.stringMatching(/:inline$/),
    }));
    expect(window.mcpAppsApi.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      iframeInstanceId: expect.stringMatching(/:inline$/),
    }));

    rendered.unmount();
  });

  it('uses the :fullscreen instance id for fullscreen iframe sendMessage trust calls', async () => {
    const rendered = renderView();
    await loadInlineIframe(rendered);
    const fullscreenIframe = await openFullscreen(rendered);

    postIframeMessage(fullscreenIframe, {
      jsonrpc: '2.0',
      id: 2,
      method: 'ui/sendMessage',
      params: { role: 'user', content: 'Fullscreen submit' },
    });
    await flushPromises();

    expect(window.mcpAppsApi.issueNonce).toHaveBeenCalledWith(expect.objectContaining({
      iframeInstanceId: expect.stringMatching(/:fullscreen$/),
    }));
    expect(window.mcpAppsApi.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      iframeInstanceId: expect.stringMatching(/:fullscreen$/),
    }));

    rendered.unmount();
  });

  it('allows concurrent submits from both surfaces with distinct trust-state entries', async () => {
    const rendered = renderView();
    const inlineIframe = await loadInlineIframe(rendered);
    const fullscreenIframe = await openFullscreen(rendered);

    postIframeMessage(inlineIframe, {
      jsonrpc: '2.0',
      id: 3,
      method: 'ui/sendMessage',
      params: { role: 'user', content: 'Inline submit' },
    });
    postIframeMessage(fullscreenIframe, {
      jsonrpc: '2.0',
      id: 4,
      method: 'ui/sendMessage',
      params: { role: 'user', content: 'Fullscreen submit' },
    });
    await flushPromises();

    const sendMessageMock = window.mcpAppsApi.sendMessage as unknown as ReturnType<typeof vi.fn>;
    const instanceIds = sendMessageMock.mock.calls
      .map((call: Array<{ iframeInstanceId: string }>) => call[0].iframeInstanceId);
    expect(instanceIds).toHaveLength(2);
    expect(instanceIds[0]).not.toBe(instanceIds[1]);
    expect(instanceIds).toEqual(expect.arrayContaining([
      expect.stringMatching(/:inline$/),
      expect.stringMatching(/:fullscreen$/),
    ]));

    rendered.unmount();
  });

  it('issues distinct nonces for concurrent inline and fullscreen sendMessage submits', async () => {
    const rendered = renderView();
    const inlineIframe = await loadInlineIframe(rendered);
    const fullscreenIframe = await openFullscreen(rendered);

    postIframeMessage(inlineIframe, {
      jsonrpc: '2.0',
      id: 5,
      method: 'ui/sendMessage',
      params: { role: 'user', content: 'Inline submit' },
    });
    postIframeMessage(fullscreenIframe, {
      jsonrpc: '2.0',
      id: 6,
      method: 'ui/sendMessage',
      params: { role: 'user', content: 'Fullscreen submit' },
    });
    await flushPromises();

    const issueNonceMock = window.mcpAppsApi.issueNonce as unknown as ReturnType<typeof vi.fn>;
    const nonceScopes = issueNonceMock.mock.calls
      .map((call: Array<{ iframeInstanceId: string }>) => call[0].iframeInstanceId);
    expect(nonceScopes).toEqual(expect.arrayContaining([
      expect.stringMatching(/:inline$/),
      expect.stringMatching(/:fullscreen$/),
    ]));

    const sendMessageMock = window.mcpAppsApi.sendMessage as unknown as ReturnType<typeof vi.fn>;
    const sendCalls = sendMessageMock.mock.calls
      .map((call: Array<{ iframeInstanceId: string; nonce: string }>) => call[0]);
    const inlineSend = sendCalls.find((call) => call.iframeInstanceId.endsWith(':inline'));
    const fullscreenSend = sendCalls.find((call) => call.iframeInstanceId.endsWith(':fullscreen'));
    expect(inlineSend?.nonce).toBeTruthy();
    expect(fullscreenSend?.nonce).toBeTruthy();
    expect(inlineSend?.nonce).not.toBe(fullscreenSend?.nonce);

    rendered.unmount();
  });

  it('invalidates both surface-specific instance ids on unmount', async () => {
    const rendered = renderView();
    await loadInlineIframe(rendered);

    rendered.unmount();

    const invalidateNonceMock = window.mcpAppsApi.invalidateNonce as unknown as ReturnType<typeof vi.fn>;
    const invalidatedIds = invalidateNonceMock.mock.calls
      .map((call: Array<{ iframeInstanceId: string }>) => call[0].iframeInstanceId);
    expect(invalidatedIds).toEqual(expect.arrayContaining([
      expect.stringMatching(/:inline$/),
      expect.stringMatching(/:fullscreen$/),
    ]));
  });
});
