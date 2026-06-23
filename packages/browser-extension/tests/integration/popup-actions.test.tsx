/**
 * Stage 6c — popup quick-action integration tests.
 *
 * Exercises `QuickActions` under happy-dom with stubbed chrome APIs and a
 * stubbed `sendIntent` client. Verifies that:
 *   - The component hides itself when not paired or not connected
 *   - Summarise captures tabContext + full page context
 *   - Ask captures tabContext + user-typed text
 *   - Save-to-notes captures selection when present, else full page text
 *   - Network / server failures surface as inline error UI (not silent)
 *
 * @see docs/plans/260418_rebel_app_bridge_and_browser_extension.md (Stage 6c)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import QuickActions, { fetchPageContext } from '../../src/popup/QuickActions';

// React requires this global to be set when using `act()` outside of react-
// testing-library. Without it every render logs a noisy `act(...)` warning.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import type {
  SendIntentInput,
  SendIntentResult,
  TabContext,
} from '../../src/lib/intents';

// ---------------------------------------------------------------------------
// React test harness (tiny — we deliberately avoid pulling react-testing-
// library into the extension package's deps).
// ---------------------------------------------------------------------------

interface Harness {
  container: HTMLDivElement;
  root: Root;
  unmount(): void;
}

function mount(element: React.ReactElement): Harness {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(element);
  });
  return {
    container,
    root,
    unmount() {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

async function flush(): Promise<void> {
  // Allow any microtasks + queued state updates (sendIntent promise chain) to settle.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function byTestId<T extends HTMLElement = HTMLElement>(
  root: ParentNode,
  id: string,
): T | null {
  return root.querySelector(`[data-testid="${id}"]`) as T | null;
}

function click(el: HTMLElement | null): void {
  if (!el) throw new Error('element not found');
  act(() => {
    el.click();
  });
}

function setInput(el: HTMLTextAreaElement | HTMLInputElement, value: string): void {
  act(() => {
    // happy-dom fires input events on direct value set via native setter.
    const proto = Object.getPrototypeOf(el) as object;
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    descriptor?.set?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function successSendIntent(conversationId = 's_123') {
  const calls: SendIntentInput[] = [];
  const sendIntentImpl = vi.fn(async (input: SendIntentInput): Promise<SendIntentResult> => {
    calls.push(input);
    return { ok: true, conversationId, state: 'new' };
  });
  return { sendIntentImpl, calls };
}

function failingSendIntent(
  failure: Extract<SendIntentResult, { ok: false }> = {
    ok: false,
    error: 'NETWORK_ERROR',
    message: 'Network down',
  },
) {
  const calls: SendIntentInput[] = [];
  const sendIntentImpl = vi.fn(async (input: SendIntentInput): Promise<SendIntentResult> => {
    calls.push(input);
    return failure;
  });
  return { sendIntentImpl, calls };
}

const STUB_TAB_CTX: TabContext = {
  tabId: 42,
  windowId: 1,
  url: 'https://example.com/article',
  title: 'Example Article',
};

function stubCapture(ctx: TabContext | null = STUB_TAB_CTX) {
  return vi.fn(async () => ctx) as unknown as typeof import('../../src/lib/intents').captureTabContext;
}

function stubPageContext(
  snapshot:
    | { title?: string; url?: string; selection?: string; text?: string }
    | null = {
    title: 'Example Article',
    url: 'https://example.com/article',
    text: 'This is the page body text.',
  },
) {
  return vi.fn(async () => snapshot) as unknown as typeof fetchPageContext;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('QuickActions — visibility gating', () => {
  it('renders nothing when visible=false (not paired / not connected)', () => {
    const { sendIntentImpl } = successSendIntent();
    const h = mount(
      <QuickActions
        visible={false}
        clientId="client-abc"
        token="pair-token-xyz"
        sendIntentImpl={sendIntentImpl}
        captureTabContextImpl={stubCapture()}
        fetchPageContextImpl={stubPageContext()}
      />,
    );
    expect(byTestId(h.container, 'quick-actions')).toBeNull();
    h.unmount();
  });

  it('renders the three quick-action buttons when visible=true', () => {
    const { sendIntentImpl } = successSendIntent();
    const h = mount(
      <QuickActions
        visible
        clientId="client-abc"
        token="pair-token-xyz"
        sendIntentImpl={sendIntentImpl}
        captureTabContextImpl={stubCapture()}
        fetchPageContextImpl={stubPageContext()}
      />,
    );
    expect(byTestId(h.container, 'quick-actions')).not.toBeNull();
    expect(byTestId(h.container, 'quick-action-summarise')).not.toBeNull();
    expect(byTestId(h.container, 'quick-action-ask-toggle')).not.toBeNull();
    expect(byTestId(h.container, 'quick-action-save')).not.toBeNull();
    h.unmount();
  });
});

describe('QuickActions — Summarise', () => {
  it('captures tabContext + pageContext and POSTs summarise intent', async () => {
    const { sendIntentImpl, calls } = successSendIntent('s_summary');
    const onSuccess = vi.fn();
    const h = mount(
      <QuickActions
        visible
        clientId="client-abc"
        token="pair-token-xyz"
        sendIntentImpl={sendIntentImpl}
        captureTabContextImpl={stubCapture()}
        fetchPageContextImpl={stubPageContext()}
        onIntentSuccess={onSuccess}
      />,
    );
    click(byTestId(h.container, 'quick-action-summarise'));
    await flush();
    expect(calls).toHaveLength(1);
    const payload = calls[0];
    if (!payload) throw new Error('expected an intent call');
    expect(payload.intent).toBe('summarise');
    expect(payload.clientId).toBe('client-abc');
    expect(payload.tabContext).toEqual(STUB_TAB_CTX);
    expect(payload.pageContext?.title).toBe('Example Article');
    expect(payload.pageContext?.url).toBe('https://example.com/article');
    expect(payload.pageContext?.text).toBe('This is the page body text.');
    expect(onSuccess).toHaveBeenCalledWith(
      'summarise',
      expect.objectContaining({ ok: true, conversationId: 's_summary' }),
    );
    const status = byTestId(h.container, 'quick-action-status');
    expect(status?.getAttribute('data-kind')).toBe('success');
    h.unmount();
  });
});

describe('QuickActions — Ask', () => {
  it('captures user text and sends the ask intent', async () => {
    const { sendIntentImpl, calls } = successSendIntent('s_ask');
    const h = mount(
      <QuickActions
        visible
        clientId="client-abc"
        token="pair-token-xyz"
        sendIntentImpl={sendIntentImpl}
        captureTabContextImpl={stubCapture()}
        fetchPageContextImpl={stubPageContext()}
      />,
    );
    click(byTestId(h.container, 'quick-action-ask-toggle'));
    await flush();
    const input = byTestId<HTMLTextAreaElement>(h.container, 'quick-action-ask-input');
    if (!input) throw new Error('expected input');
    setInput(input, 'What are the three main arguments?');
    click(byTestId(h.container, 'quick-action-ask-send'));
    await flush();
    expect(calls).toHaveLength(1);
    const payload = calls[0];
    if (!payload) throw new Error('expected an intent call');
    expect(payload.intent).toBe('ask');
    expect(payload.userText).toBe('What are the three main arguments?');
    expect(payload.tabContext).toEqual(STUB_TAB_CTX);
    h.unmount();
  });
});

describe('QuickActions — Save to notes', () => {
  it('prefers selection over full page text when a selection exists', async () => {
    const { sendIntentImpl, calls } = successSendIntent('s_save');
    const h = mount(
      <QuickActions
        visible
        clientId="client-abc"
        token="pair-token-xyz"
        sendIntentImpl={sendIntentImpl}
        captureTabContextImpl={stubCapture()}
        fetchPageContextImpl={stubPageContext({
          title: 'Example Article',
          url: 'https://example.com/article',
          selection: 'the quoted bit',
          text: 'full page body',
        })}
      />,
    );
    click(byTestId(h.container, 'quick-action-save'));
    await flush();
    expect(calls).toHaveLength(1);
    const payload = calls[0];
    if (!payload) throw new Error('expected an intent call');
    expect(payload.intent).toBe('save_to_notes');
    expect(payload.pageContext?.selection).toBe('the quoted bit');
    // When selection is present we deliberately omit the full text so Rebel
    // treats the highlight as the user's intent.
    expect(payload.pageContext?.text).toBeUndefined();
    h.unmount();
  });

  it('falls back to full page text when no selection exists', async () => {
    const { sendIntentImpl, calls } = successSendIntent('s_save2');
    const h = mount(
      <QuickActions
        visible
        clientId="client-abc"
        token="pair-token-xyz"
        sendIntentImpl={sendIntentImpl}
        captureTabContextImpl={stubCapture()}
        fetchPageContextImpl={stubPageContext({
          title: 'Example Article',
          url: 'https://example.com/article',
          text: 'full page body',
        })}
      />,
    );
    click(byTestId(h.container, 'quick-action-save'));
    await flush();
    expect(calls).toHaveLength(1);
    const payload = calls[0];
    if (!payload) throw new Error('expected an intent call');
    expect(payload.pageContext?.selection).toBeUndefined();
    expect(payload.pageContext?.text).toBe('full page body');
    h.unmount();
  });
});

describe('QuickActions — error UX', () => {
  it('renders an inline error chip when sendIntent returns NETWORK_ERROR', async () => {
    const { sendIntentImpl } = failingSendIntent({
      ok: false,
      error: 'NETWORK_ERROR',
      message: "Couldn't reach Rebel.",
    });
    const h = mount(
      <QuickActions
        visible
        clientId="client-abc"
        token="pair-token-xyz"
        sendIntentImpl={sendIntentImpl}
        captureTabContextImpl={stubCapture()}
        fetchPageContextImpl={stubPageContext()}
      />,
    );
    click(byTestId(h.container, 'quick-action-summarise'));
    await flush();
    const status = byTestId(h.container, 'quick-action-status');
    expect(status?.getAttribute('data-kind')).toBe('error');
    expect(status?.textContent).toMatch(/rebel/i);
    h.unmount();
  });

  it('renders a "not yet" message when Stage 7 handler returns 501 NOT_IMPLEMENTED', async () => {
    const { sendIntentImpl } = failingSendIntent({
      ok: false,
      error: 'NOT_IMPLEMENTED',
      message: "Rebel can't take this action yet — the feature is still landing.",
      status: 501,
    });
    const h = mount(
      <QuickActions
        visible
        clientId="client-abc"
        token="pair-token-xyz"
        sendIntentImpl={sendIntentImpl}
        captureTabContextImpl={stubCapture()}
        fetchPageContextImpl={stubPageContext()}
      />,
    );
    click(byTestId(h.container, 'quick-action-summarise'));
    await flush();
    const status = byTestId(h.container, 'quick-action-status');
    expect(status?.getAttribute('data-kind')).toBe('error');
    expect(status?.textContent).toMatch(/still landing|can't take/i);
    h.unmount();
  });

  it('surfaces an actionable message when tabContext capture fails', async () => {
    const { sendIntentImpl, calls } = successSendIntent();
    const h = mount(
      <QuickActions
        visible
        clientId="client-abc"
        token="pair-token-xyz"
        sendIntentImpl={sendIntentImpl}
        captureTabContextImpl={stubCapture(null)}
        fetchPageContextImpl={stubPageContext()}
      />,
    );
    click(byTestId(h.container, 'quick-action-summarise'));
    await flush();
    expect(calls).toHaveLength(0);
    const status = byTestId(h.container, 'quick-action-status');
    expect(status?.getAttribute('data-kind')).toBe('error');
    expect(status?.textContent?.toLowerCase()).toContain('tab');
    h.unmount();
  });

  it('errors when clientId is absent (edge case: paired but clientId not hydrated)', async () => {
    const { sendIntentImpl, calls } = successSendIntent();
    const h = mount(
      <QuickActions
        visible
        clientId={null}
        token={null}
        sendIntentImpl={sendIntentImpl}
        captureTabContextImpl={stubCapture()}
        fetchPageContextImpl={stubPageContext()}
      />,
    );
    click(byTestId(h.container, 'quick-action-summarise'));
    await flush();
    expect(calls).toHaveLength(0);
    const status = byTestId(h.container, 'quick-action-status');
    expect(status?.getAttribute('data-kind')).toBe('error');
    expect(status?.textContent?.toLowerCase()).toContain('paired');
    h.unmount();
  });

  it('errors when token is absent but clientId exists (A4 gate)', async () => {
    // Post-review A4: /intent/* requires the paired app token. When the
    // popup still has a clientId but the token has been cleared (e.g. a
    // stale storage row from before pairing was strictly enforced),
    // QuickActions must refuse to send rather than firing a 401-doomed
    // request.
    const { sendIntentImpl, calls } = successSendIntent();
    const h = mount(
      <QuickActions
        visible
        clientId="client-abc"
        token={null}
        sendIntentImpl={sendIntentImpl}
        captureTabContextImpl={stubCapture()}
        fetchPageContextImpl={stubPageContext()}
      />,
    );
    click(byTestId(h.container, 'quick-action-summarise'));
    await flush();
    expect(calls).toHaveLength(0);
    const status = byTestId(h.container, 'quick-action-status');
    expect(status?.getAttribute('data-kind')).toBe('error');
    expect(status?.textContent?.toLowerCase()).toContain('paired');
    h.unmount();
  });
});
