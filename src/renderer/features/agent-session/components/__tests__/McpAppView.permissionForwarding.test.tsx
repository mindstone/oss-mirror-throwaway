// @vitest-environment happy-dom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpAppUiMeta } from '@shared/types';
import { McpAppView } from '../McpAppView';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const substrateScript = readFileSync(
  join(process.cwd(), 'resources/mcp/rebel-canvas/views/_actionSubstrate.js'),
  'utf8',
);

type PermissionPayload = {
  kind: 'granted' | 'revoked';
  scope: 'method' | 'tool' | 'conversation' | 'package';
  sourcePackageId?: string;
  conversationId?: string;
  method?: string;
};

const uiMeta: McpAppUiMeta = {
  resourceUri: 'ui://RebelCanvas/form?id=form-1',
  sourcePackageId: 'RebelCanvas',
};

let permissionCallbacks: Array<(payload: PermissionPayload) => void> = [];

function renderView(meta: McpAppUiMeta = uiMeta): { container: HTMLElement; root: Root; unmount: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <McpAppView
        uiMeta={meta}
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

async function loadInlineIframe(rendered: { container: HTMLElement }): Promise<HTMLIFrameElement> {
  await flushPromises();
  const iframe = rendered.container.querySelector('iframe')!;
  act(() => {
    iframe.dispatchEvent(new Event('load'));
  });
  await flushPromises();
  return iframe;
}

function postIframeMessage(iframe: HTMLIFrameElement, data: unknown): void {
  window.dispatchEvent(new MessageEvent('message', {
    data,
    origin: 'null',
    source: iframe.contentWindow,
  }));
}

function trustedIframeEvent(iframeWindow: Window): Event {
  const EventCtor = (iframeWindow as unknown as { Event: typeof Event }).Event;
  const event = new EventCtor('click', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'isTrusted', {
    configurable: true,
    value: true,
  });
  return event;
}

function installActionSubstrate(iframe: HTMLIFrameElement): Window & {
  __rebelCanvas: {
    submit: (event: Event, actionId: string, summary: string, payload: unknown) => Promise<unknown>;
  };
} {
  const iframeWindow = iframe.contentWindow as Window & {
    __rebelCanvas: {
      submit: (event: Event, actionId: string, summary: string, payload: unknown) => Promise<unknown>;
    };
  };
  const fakeParent = {
    postMessage: vi.fn((data: unknown) => postIframeMessage(iframe, data)),
  };
  Object.defineProperty(iframeWindow, 'parent', {
    configurable: true,
    value: fakeParent,
  });
  vi.spyOn(iframeWindow, 'postMessage').mockImplementation((data: unknown) => {
    const EventCtor = (iframeWindow as unknown as { Event: typeof Event }).Event;
    const event = new EventCtor('message') as Event & { data?: unknown; source?: unknown };
    Object.defineProperty(event, 'data', {
      configurable: true,
      value: data,
    });
    Object.defineProperty(event, 'source', {
      configurable: true,
      value: fakeParent,
    });
    iframeWindow.dispatchEvent(event);
  });
  (iframeWindow as unknown as { eval: (script: string) => unknown }).eval(substrateScript);
  return iframeWindow;
}

async function openFullscreen(rendered: { container: HTMLElement }): Promise<HTMLIFrameElement> {
  const button = rendered.container.querySelector('[aria-label="Expand preview"]') as HTMLButtonElement;
  act(() => button.click());
  await flushPromises();
  const iframes = Array.from(document.body.querySelectorAll('iframe'));
  return iframes[iframes.length - 1];
}

function firePermissionChanged(payload: PermissionPayload): void {
  act(() => {
    for (const callback of [...permissionCallbacks]) {
      callback(payload);
    }
  });
}

describe('McpAppView permission forwarding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = '';
    permissionCallbacks = [];
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
      api: {
        onMcpPermissionChanged: (callback: (payload: PermissionPayload) => void) => () => void;
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
    (window as unknown as {
      api: {
        onMcpPermissionChanged: (callback: (payload: PermissionPayload) => void) => () => void;
      };
    }).api = {
      onMcpPermissionChanged: (callback) => {
        permissionCallbacks.push(callback);
        return () => {
          permissionCallbacks = permissionCallbacks.filter((candidate) => candidate !== callback);
        };
      },
    };
    (window as unknown as { appApi: { openPath: ReturnType<typeof vi.fn> } }).appApi = {
      openPath: vi.fn(),
    };
  });

  it('forwards matching ui/sendMessage grants to inline and fullscreen iframes', async () => {
    const rendered = renderView();
    const inlineIframe = await loadInlineIframe(rendered);
    const fullscreenIframe = await openFullscreen(rendered);
    const inlinePostMessage = vi.spyOn(inlineIframe.contentWindow!, 'postMessage');
    const fullscreenPostMessage = vi.spyOn(fullscreenIframe.contentWindow!, 'postMessage');

    firePermissionChanged({
      kind: 'granted',
      scope: 'method',
      sourcePackageId: 'RebelCanvas',
      conversationId: 'conversation-1',
      method: 'ui/sendMessage',
    });

    const expectedPayload = {
      kind: 'mcp-app:permission-changed',
      scope: 'method',
      sourcePackageId: 'RebelCanvas',
    };
    expect(inlinePostMessage).toHaveBeenCalledWith(expectedPayload, '*');
    expect(fullscreenPostMessage).toHaveBeenCalledWith(expectedPayload, '*');

    rendered.unmount();
  });

  it('does not forward mismatching broadcasts', async () => {
    const rendered = renderView();
    const iframe = await loadInlineIframe(rendered);
    const postMessage = vi.spyOn(iframe.contentWindow!, 'postMessage');

    firePermissionChanged({
      kind: 'granted',
      scope: 'method',
      sourcePackageId: 'OtherPackage',
      conversationId: 'conversation-1',
      method: 'ui/sendMessage',
    });
    firePermissionChanged({
      kind: 'granted',
      scope: 'method',
      sourcePackageId: 'RebelCanvas',
      conversationId: 'conversation-2',
      method: 'ui/sendMessage',
    });
    firePermissionChanged({
      kind: 'granted',
      scope: 'method',
      sourcePackageId: 'RebelCanvas',
      conversationId: 'conversation-1',
      method: 'ui/updateModelContext',
    });

    expect(postMessage).not.toHaveBeenCalled();
    rendered.unmount();
  });

  it('cleans up the subscription on unmount and does not post to detached iframes', async () => {
    const rendered = renderView();
    const iframe = await loadInlineIframe(rendered);
    const postMessage = vi.spyOn(iframe.contentWindow!, 'postMessage');

    rendered.unmount();
    firePermissionChanged({
      kind: 'granted',
      scope: 'method',
      sourcePackageId: 'RebelCanvas',
      conversationId: 'conversation-1',
      method: 'ui/sendMessage',
    });

    expect(permissionCallbacks).toHaveLength(0);
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('forwards matching broadcasts to multiple iframes in the same conversation', async () => {
    const first = renderView({
      ...uiMeta,
      resourceUri: 'ui://RebelCanvas/form?id=form-1',
    });
    const second = renderView({
      ...uiMeta,
      resourceUri: 'ui://RebelCanvas/form?id=form-2',
    });
    const firstIframe = await loadInlineIframe(first);
    const secondIframe = await loadInlineIframe(second);
    const firstPostMessage = vi.spyOn(firstIframe.contentWindow!, 'postMessage');
    const secondPostMessage = vi.spyOn(secondIframe.contentWindow!, 'postMessage');

    firePermissionChanged({
      kind: 'granted',
      scope: 'method',
      sourcePackageId: 'RebelCanvas',
      conversationId: 'conversation-1',
      method: 'ui/sendMessage',
    });

    expect(firstPostMessage).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'mcp-app:permission-changed',
    }), '*');
    expect(secondPostMessage).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'mcp-app:permission-changed',
    }), '*');

    first.unmount();
    second.unmount();
  });

  it('lets two matching iframes auto-retry independently after a grant broadcast', async () => {
    const sendMessage = window.mcpAppsApi.sendMessage as unknown as ReturnType<typeof vi.fn>;
    sendMessage
      .mockResolvedValueOnce({
        success: false,
        rejection: {
          jsonRpcCode: -32603,
          reason: 'permission_denied',
          safeMessage: 'Permission denied. Grant in Settings to enable.',
        },
      })
      .mockResolvedValueOnce({
        success: false,
        rejection: {
          jsonRpcCode: -32603,
          reason: 'permission_denied',
          safeMessage: 'Permission denied. Grant in Settings to enable.',
        },
      })
      .mockResolvedValue({ success: true });
    const first = renderView({
      ...uiMeta,
      resourceUri: 'ui://RebelCanvas/form?id=form-1',
    });
    const second = renderView({
      ...uiMeta,
      resourceUri: 'ui://RebelCanvas/form?id=form-2',
    });
    const firstIframeWindow = installActionSubstrate(await loadInlineIframe(first));
    const secondIframeWindow = installActionSubstrate(await loadInlineIframe(second));

    void firstIframeWindow.__rebelCanvas.submit(
      trustedIframeEvent(firstIframeWindow),
      'submit-1',
      'Submit first',
      {},
    );
    void secondIframeWindow.__rebelCanvas.submit(
      trustedIframeEvent(secondIframeWindow),
      'submit-2',
      'Submit second',
      {},
    );
    await flushPromises();
    expect(sendMessage).toHaveBeenCalledTimes(2);

    firePermissionChanged({
      kind: 'granted',
      scope: 'method',
      sourcePackageId: 'RebelCanvas',
      conversationId: 'conversation-1',
      method: 'ui/sendMessage',
    });
    await flushPromises();

    expect(sendMessage).toHaveBeenCalledTimes(4);
    first.unmount();
    second.unmount();
  });

  it('does not auto-retry after a non-permission sendMessage error', async () => {
    const sendMessage = window.mcpAppsApi.sendMessage as unknown as ReturnType<typeof vi.fn>;
    sendMessage.mockResolvedValueOnce({
      success: false,
      rejection: {
        jsonRpcCode: -32000,
        reason: 'rate_limited',
        safeMessage: 'Rate limit exceeded. Try later.',
      },
    });
    const rendered = renderView();
    const iframeWindow = installActionSubstrate(await loadInlineIframe(rendered));

    void iframeWindow.__rebelCanvas.submit(
      trustedIframeEvent(iframeWindow),
      'rate-limited-1',
      'Rate limited',
      {},
    );
    await flushPromises();
    expect(sendMessage).toHaveBeenCalledTimes(1);

    firePermissionChanged({
      kind: 'granted',
      scope: 'method',
      sourcePackageId: 'RebelCanvas',
      conversationId: 'conversation-1',
      method: 'ui/sendMessage',
    });
    await flushPromises();

    expect(sendMessage).toHaveBeenCalledTimes(1);
    rendered.unmount();
  });
});
