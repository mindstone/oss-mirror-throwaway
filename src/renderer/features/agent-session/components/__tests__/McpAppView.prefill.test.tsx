// @vitest-environment happy-dom

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

const toolResult = {
  content: [{ type: 'text' as const, text: 'Drafting email to alice@example.com' }],
  structuredContent: {
    to: 'alice@example.com',
    subject: 'Lunch?',
    body: 'Are you free Thursday?',
  },
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
        toolResult={toolResult}
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

describe('McpAppView prefill delivery robustness', () => {
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
  });

  // RED before fix: the host posts the prefill only once, in handleIframeLoad. If
  // the iframe's message listener attaches AFTER that single post (a real timing
  // window for a sandboxed blob iframe), the draft is lost forever because the host
  // never re-delivers it. The iframe DOES emit `mcp-app:ready` once its listener is
  // bound; the host must use that signal to (re-)deliver the draft.
  it('re-delivers the tool-result prefill when the iframe signals mcp-app:ready', async () => {
    const rendered = renderView();
    await flushPromises();
    const iframe = rendered.container.querySelector('iframe')!;
    const postMessage = vi.spyOn(iframe.contentWindow!, 'postMessage');

    // Simulate the iframe announcing readiness (its listener is now attached).
    postIframeMessage(iframe, {
      jsonrpc: '2.0',
      method: 'mcp-app:ready',
      params: { resourceUri: uiMeta.resourceUri },
    });
    await flushPromises();

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        jsonrpc: '2.0',
        method: 'ui/notifications/tool-result',
        params: expect.objectContaining({
          structuredContent: expect.objectContaining({
            to: 'alice@example.com',
            subject: 'Lunch?',
            body: 'Are you free Thursday?',
          }),
        }),
      }),
      '*',
    );

    rendered.unmount();
  });

  it('does not post a tool-result on ready when there is no prefill payload', async () => {
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
    await flushPromises();
    const iframe = container.querySelector('iframe')!;
    const postMessage = vi.spyOn(iframe.contentWindow!, 'postMessage');

    postIframeMessage(iframe, {
      jsonrpc: '2.0',
      method: 'mcp-app:ready',
      params: { resourceUri: uiMeta.resourceUri },
    });
    await flushPromises();

    const toolResultPosts = postMessage.mock.calls.filter(
      ([msg]) => (msg as { method?: string })?.method === 'ui/notifications/tool-result',
    );
    expect(toolResultPosts).toHaveLength(0);

    act(() => root.unmount());
    container.remove();
  });
});
