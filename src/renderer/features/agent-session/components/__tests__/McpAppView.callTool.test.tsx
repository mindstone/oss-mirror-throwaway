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

describe('McpAppView tools/call bridge', () => {
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
      issueNonce: vi.fn(async () => ({ success: true, nonce: 'nonce-tool-1' })),
      callTool: vi.fn(async () => ({ success: true, result: { ok: true } })),
      invalidateNonce: vi.fn(async () => ({ success: true })),
      openHtmlInBrowser: vi.fn(),
    };
    (window as unknown as { appApi: { openPath: ReturnType<typeof vi.fn> } }).appApi = {
      openPath: vi.fn(),
    };
    (window as unknown as { api: { logEvent: ReturnType<typeof vi.fn> } }).api = {
      logEvent: vi.fn(),
    };
  });

  type DeliveryLogCall = [{ level: string; message: string; context: { kind?: string; reason?: string } & Record<string, unknown> }];
  function deliveryLogCalls(kind: string): DeliveryLogCall[] {
    const logEvent = (window as unknown as { api: { logEvent: ReturnType<typeof vi.fn> } }).api.logEvent;
    return logEvent.mock.calls.filter(
      ([payload]) => (payload as { context?: { kind?: string } })?.context?.kind === kind,
    ) as unknown as DeliveryLogCall[];
  }

  it('issues a fresh nonce, forwards tools/call to IPC, and returns the tool result', async () => {
    const rendered = renderView();
    await flushPromises();
    const iframe = rendered.container.querySelector('iframe')!;
    const postMessage = vi.spyOn(iframe.contentWindow!, 'postMessage');

    postIframeMessage(iframe, {
      jsonrpc: '2.0',
      id: 42,
      method: 'tools/call',
      params: { name: 'send_workspace_email', arguments: { to: 'user@example.com' } },
    });
    await flushPromises();

    expect(window.mcpAppsApi.issueNonce).toHaveBeenCalledWith(expect.objectContaining({
      sourcePackageId: uiMeta.sourcePackageId,
      toolUseId: 'tool-1',
      sessionId: 'conversation-1',
      conversationId: 'conversation-1',
      iframeInstanceId: expect.any(String),
    }));
    expect(window.mcpAppsApi.callTool).toHaveBeenCalledWith(expect.objectContaining({
      appFamily: 'google-workspace',
      sourcePackageId: uiMeta.sourcePackageId,
      toolUseId: 'tool-1',
      sessionId: 'conversation-1',
      conversationId: 'conversation-1',
      nonce: 'nonce-tool-1',
      toolName: 'send_workspace_email',
      args: { to: 'user@example.com' },
    }));
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      id: 42,
      result: { ok: true },
    }), '*');

    rendered.unmount();
  });

  it('posts JSON-RPC errors and emits trust rejection events on tools/call rejection', async () => {
    window.mcpAppsApi.callTool = vi.fn(async () => ({
      success: false as const,
      rejection: {
        jsonRpcCode: -32603,
        reason: 'tool_not_allowed',
        safeMessage: "View tried to use a tool that isn't allowed. Grant access in Settings.",
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
      id: 43,
      method: 'tools/call',
      params: { name: 'delete_all_emails', arguments: {} },
    });
    await flushPromises();

    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      id: 43,
      error: {
        code: -32603,
        message: "View tried to use a tool that isn't allowed. Grant access in Settings.",
      },
    }), '*');
    expect(trustListener).toHaveBeenCalledWith(expect.objectContaining({
      detail: expect.objectContaining({
        method: 'tools/call',
        toolName: 'delete_all_emails',
        rejection: expect.objectContaining({ reason: 'tool_not_allowed' }),
      }),
    }));

    window.removeEventListener('mcp-app:trust-rejection', trustListener);
    rendered.unmount();
  });

  it('emits telemetry when a request-shaped message is dropped at the sandbox-frame guard', async () => {
    const rendered = renderView();
    await flushPromises();

    // A request-shaped tools/call whose source is NOT the iframe (e.g. a stale
    // window after the iframe changed identity) fails the guard and is dropped
    // with no reply — the REBEL-677 silent sink. It must be logged.
    window.dispatchEvent(new MessageEvent('message', {
      data: {
        jsonrpc: '2.0',
        id: 99,
        method: 'tools/call',
        params: { name: 'send_workspace_email', arguments: { to: 'user@example.com' } },
      },
      origin: 'null',
      source: window, // not the iframe's contentWindow → guard rejects
    }));
    await flushPromises();

    const calls = deliveryLogCalls('dropped_request_source_mismatch');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([expect.objectContaining({
      level: 'warn',
      context: expect.objectContaining({
        kind: 'dropped_request_source_mismatch',
        method: 'tools/call',
      }),
    })]);

    rendered.unmount();
  });

  it('does not log foreign (non-request-shaped) messages dropped at the guard', async () => {
    const rendered = renderView();
    await flushPromises();

    // Ambient window chatter that is not an MCP App request must not be logged.
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'some-other-library', payload: 123 },
      origin: 'null',
      source: window,
    }));
    await flushPromises();

    expect(deliveryLogCalls('dropped_request_source_mismatch')).toHaveLength(0);

    rendered.unmount();
  });

  it('logs an undeliverable reply when the iframe is gone before the tools/call resolves', async () => {
    let resolveCallTool!: (value: { success: true; result?: unknown }) => void;
    window.mcpAppsApi.callTool = vi.fn((): Promise<{ success: true; result?: unknown }> =>
      new Promise((resolve) => { resolveCallTool = resolve; }));

    const rendered = renderView();
    await flushPromises();
    const iframe = rendered.container.querySelector('iframe')!;

    postIframeMessage(iframe, {
      jsonrpc: '2.0',
      id: 77,
      method: 'tools/call',
      params: { name: 'send_workspace_email', arguments: { to: 'user@example.com' } },
    });
    await flushPromises(); // advances up to the awaited callTool

    // The iframe goes away (re-mount / unmount race) before the reply arrives.
    rendered.unmount();

    // The tool now resolves; the reply has no live window to land in.
    await act(async () => {
      resolveCallTool({ success: true, result: { ok: true } });
      await Promise.resolve();
      await Promise.resolve();
    });

    const calls = deliveryLogCalls('undeliverable_reply');
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect((calls[0][0] as { context?: { reason?: string } }).context?.reason).toBe('iframe_unmounted');
  });

  it('does not emit delivery telemetry on a normal tools/call round-trip', async () => {
    const rendered = renderView();
    await flushPromises();
    const iframe = rendered.container.querySelector('iframe')!;

    postIframeMessage(iframe, {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'send_workspace_email', arguments: { to: 'user@example.com' } },
    });
    await flushPromises();

    expect(deliveryLogCalls('dropped_request_source_mismatch')).toHaveLength(0);
    expect(deliveryLogCalls('undeliverable_reply')).toHaveLength(0);

    rendered.unmount();
  });
});
