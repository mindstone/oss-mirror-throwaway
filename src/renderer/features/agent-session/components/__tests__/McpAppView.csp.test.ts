// @vitest-environment happy-dom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { McpAppView } from '../McpAppView';
import type { McpAppUiMeta } from '@shared/types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function flushPromises(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function renderView(
  uiMeta: McpAppUiMeta,
  props: Partial<React.ComponentProps<typeof McpAppView>> = {},
): { container: HTMLDivElement; root: Root; unmount: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(React.createElement(McpAppView, {
      uiMeta,
      sessionId: 'conversation-1',
      conversationId: 'conversation-1',
      toolUseId: 'tool-1',
      theme: 'dark',
      trustedPreviewDomains: ['https://trusted.example.com'],
      ...props,
    }));
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

describe('McpAppView CSP injection', () => {
  let createdBlob: Blob | null = null;

  beforeEach(() => {
    createdBlob = null;
    vi.clearAllMocks();
    Object.defineProperty(globalThis.URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn((blob: Blob | MediaSource) => {
        createdBlob = blob as Blob;
        return 'data:text/html,<html><body>ready</body></html>';
      }),
    });
    Object.defineProperty(globalThis.URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    });
    (window as unknown as {
      mcpAppsApi: {
        readResource: ReturnType<typeof vi.fn>;
        invalidateNonce: ReturnType<typeof vi.fn>;
        openHtmlInBrowser: ReturnType<typeof vi.fn>;
      };
    }).mcpAppsApi = {
      readResource: vi.fn(async () => ({
        success: true,
        contents: [{
          uri: 'ui://google-workspace/compose-email',
          mimeType: 'text/html',
          text: '<html><head><title>Preview</title></head><body>Hello</body></html>',
        }],
      })),
      invalidateNonce: vi.fn(async () => ({ success: true })),
      openHtmlInBrowser: vi.fn(),
    };
  });

  it('uses shared CSP construction while preserving host-context and error-capture injection', async () => {
    const uiMeta: McpAppUiMeta = {
      resourceUri: 'ui://google-workspace/compose-email',
      sourcePackageId: 'GoogleWorkspace-joshua-example-com',
      csp: {
        connectDomains: ['https://api.example.com'],
        resourceDomains: ['https://cdn.example.com'],
        frameDomains: ['https://embed.example.com'],
      },
    };
    const rendered = renderView(uiMeta);

    await flushPromises();

    expect(createdBlob).toBeTruthy();
    const html = await createdBlob!.text();
    expect(html).toContain('<head><meta http-equiv="Content-Security-Policy"');
    expect(html).toContain('connect-src https://api.example.com');
    expect(html).toContain('script-src &#39;unsafe-inline&#39; blob: data: https://cdn.example.com https://trusted.example.com');
    expect(html).toContain('frame-src https://embed.example.com');
    expect(html).toContain('window.__MCP_HOST_CONTEXT__={"theme":"dark"');
    expect(html).toContain('window.__REBEL_HOST_CONTEXT__=window.__MCP_HOST_CONTEXT__');
    expect(html).toContain("parent.postMessage({ type: 'rebel-preview-error', errors: errors }, '*')");
    expect(html.indexOf('Content-Security-Policy')).toBeLessThan(html.indexOf('window.__MCP_HOST_CONTEXT__'));
    expect(html.indexOf('window.__MCP_HOST_CONTEXT__')).toBeLessThan(html.indexOf('window.__REBEL_HOST_CONTEXT__'));
    expect(html.indexOf('window.__REBEL_HOST_CONTEXT__')).toBeLessThan(html.indexOf('rebel-preview-error'));

    rendered.unmount();
  });

  it('keeps iframe load handling alive when cross-origin listener access is blocked', async () => {
    const uiMeta: McpAppUiMeta = {
      resourceUri: 'ui://google-workspace/compose-email',
      sourcePackageId: 'GoogleWorkspace-joshua-example-com',
    };
    const rendered = renderView(uiMeta, {
      toolResultText: 'Tool result body',
    });

    await flushPromises();

    const iframe = rendered.container.querySelector('iframe');
    expect(iframe).toBeTruthy();

    const postMessage = vi.fn();
    const crossOriginWindow = {
      get addEventListener(): never {
        throw new DOMException(
          'Blocked a frame with origin "file://" from accessing a cross-origin frame.',
          'SecurityError',
        );
      },
      postMessage,
    } as unknown as WindowProxy;

    Object.defineProperty(iframe!, 'contentWindow', {
      configurable: true,
      get: () => crossOriginWindow,
    });

    expect(() => {
      act(() => iframe!.dispatchEvent(new Event('load')));
    }).not.toThrow();
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        jsonrpc: '2.0',
        method: 'ui/notifications/tool-result',
        params: { content: [{ type: 'text', text: 'Tool result body' }] },
      }),
      '*',
    );

    rendered.unmount();
  });
});
