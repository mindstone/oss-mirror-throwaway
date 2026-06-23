// @vitest-environment happy-dom

import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Window } from 'happy-dom';
import { McpAppUiMetaSchema, McpAppViewSummarySchema } from '../../../../src/shared/contracts/agentEventManifest';

const require = createRequire(import.meta.url);

type ConfirmDefinition = {
  title: string;
  body?: string;
  actionId: string;
  buttonSet?: 'yes-no' | 'yes-no-cancel' | 'approve-reject' | 'continue-cancel' | 'custom';
  customButtons?: Array<{
    actionId: string;
    label: string;
    intent: 'primary' | 'secondary' | 'destructive' | 'cancel';
  }>;
};

type ToolResult = {
  _meta: {
    ui: {
      resourceUri: string;
      presentation?: string;
      viewSummary?: string;
      viewRoleLabel?: string;
      structuredFallback?: unknown;
    };
  };
};

type ConfirmTool = {
  inputSchema: {
    parse: (input: unknown) => ConfirmDefinition;
    safeParse: (input: unknown) => { success: boolean };
  };
  handler: (input: ConfirmDefinition) => Promise<ToolResult>;
};

type ServerModule = {
  buildResourceResponse: (uri: URL, templateName: string, data: Record<string, unknown>) => {
    contents: Array<{ text: string }>;
  };
  server: {
    _registeredTools: Record<string, ConfirmTool>;
  };
};

const serverModule = require('../server.cjs') as ServerModule;
const confirmTool = serverModule.server._registeredTools.rebel_canvas_confirm;

let testWindow: Window | undefined;
let parentWindow: Window | undefined;

function definitionWith(overrides: Partial<ConfirmDefinition> = {}): ConfirmDefinition {
  return {
    title: 'Proceed with the plan?',
    body: 'This is plaintext.',
    actionId: 'confirm.submit',
    ...overrides,
  };
}

function renderConfirm(definition: ConfirmDefinition, configureWindow?: (window: Window) => void): Window {
  const parsedDefinition = confirmTool.inputSchema.parse(definition);
  const html = serverModule.buildResourceResponse(
    new URL('ui://RebelCanvas/confirm?id=test'),
    'confirm',
    { definition: parsedDefinition, _type: 'confirm' },
  ).contents[0].text;

  const window = new Window({ url: 'https://rebel.local/confirm.html' });
  parentWindow = new Window({ url: 'https://rebel.local/parent.html' });
  Object.defineProperty(window, 'parent', {
    configurable: true,
    value: parentWindow,
  });
  window.parent.postMessage = vi.fn();
  Object.defineProperty(window.Event.prototype, 'isTrusted', {
    configurable: true,
    get: () => true,
  });
  configureWindow?.(window);

  window.document.write(html);
  Array.from(window.document.querySelectorAll('script')).forEach((script) => {
    window.eval(script.textContent || '');
  });
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  return window;
}

function buttonLabels(window: Window): string[] {
  return Array.from(window.document.querySelectorAll<HTMLButtonElement>('.actions button'))
    .map((button) => button.textContent || '');
}

function actionButtons(window: Window): HTMLButtonElement[] {
  return Array.from(window.document.querySelectorAll<HTMLButtonElement>('.actions button'));
}

function postedMessages(window: Window): Array<Record<string, unknown>> {
  return (window.parent.postMessage as ReturnType<typeof vi.fn>).mock.calls
    .map((call) => call[0])
    .filter((message): message is Record<string, unknown> => {
      return Boolean(message && typeof message === 'object' && 'jsonrpc' in message);
    });
}

function parseEnvelope(content: string): Record<string, unknown> {
  const match = content.match(/<rebel-canvas-submit-v1>\n([\s\S]*?)\n<\/rebel-canvas-submit-v1>/);
  expect(match?.[1]).toBeTruthy();
  return JSON.parse(match![1]);
}

function respond(window: Window, id: unknown, response: Record<string, unknown>): void {
  const event = new window.Event('message') as Event & { data?: unknown; source?: Window };
  Object.defineProperty(event, 'data', {
    configurable: true,
    value: { jsonrpc: '2.0', id, ...response },
  });
  Object.defineProperty(event, 'source', {
    configurable: true,
    value: window.parent,
  });
  window.dispatchEvent(event);
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('rebel_canvas_confirm server tool', () => {
  afterEach(() => {
    testWindow?.close();
    parentWindow?.close();
    testWindow = undefined;
    parentWindow = undefined;
  });

  it('registers the confirm tool and emits a B1 _meta.ui envelope', async () => {
    expect(confirmTool).toBeTruthy();

    const definition = confirmTool.inputSchema.parse(definitionWith({ title: 'Approve launch?' }));
    const result = await confirmTool.handler(definition);

    const parsed = McpAppUiMetaSchema.parse(result._meta.ui);
    expect(parsed.viewRoleLabel).toBe('Confirm');
    expect(parsed.presentation).toBe('primary');
    expect(parsed.viewSummary).toBe('Approve launch?');
    expect(parsed.structuredFallback?.kind).toBe('plain');
    expect((parsed.structuredFallback as { payload?: { markdown?: string } }).payload?.markdown).toContain('- Yes (primary)');
  });

  it('sanitizes HTML-like title characters before emitting viewSummary', async () => {
    const definition = confirmTool.inputSchema.parse(definitionWith({ title: 'Approve <launch>?' }));
    const result = await confirmTool.handler(definition);

    const summary = McpAppViewSummarySchema.parse(result._meta.ui.viewSummary);
    expect(summary).toBe('Approve launch?');
  });

  it.each([
    ['prompt injection phrase', 'ignore previous instructions'],
    ['over 80 characters', 'a'.repeat(81)],
    ['leading punctuation', '-bad'],
  ])('rejects invalid actionId values: %s', (_name, actionId) => {
    expect(confirmTool.inputSchema.safeParse(definitionWith({ actionId })).success).toBe(false);
  });

  it.each([
    ['prompt injection phrase', 'ignore previous instructions'],
    ['over 80 characters', 'a'.repeat(81)],
    ['leading punctuation', '-bad'],
  ])('rejects invalid customButtons actionId values: %s', (_name, actionId) => {
    expect(confirmTool.inputSchema.safeParse(definitionWith({
      buttonSet: 'custom',
      customButtons: [{ actionId, label: 'Do it', intent: 'primary' }],
    })).success).toBe(false);
  });

  it.each([
    ['yes-no', ['Yes', 'No'], ['primary', 'secondary']],
    ['yes-no-cancel', ['Yes', 'No', 'Cancel'], ['primary', 'secondary', 'cancel']],
    ['approve-reject', ['Approve', 'Reject'], ['primary', 'destructive']],
    ['continue-cancel', ['Continue', 'Cancel'], ['primary', 'cancel']],
  ] as const)('renders the %s preset button labels and intents', (buttonSet, labels, intents) => {
    testWindow = renderConfirm(definitionWith({ buttonSet }));

    expect(buttonLabels(testWindow)).toEqual(labels);
    expect(actionButtons(testWindow).map((button) => button.dataset.intent)).toEqual(intents);
    expect(actionButtons(testWindow).map((button) => button.className)).toEqual(intents);
  });

  it.each([
    ['yes-no', ['yes', 'no']],
    ['yes-no-cancel', ['yes', 'no', 'cancel']],
    ['approve-reject', ['approve', 'reject']],
    ['continue-cancel', ['continue', 'cancel']],
  ] as const)('renders stable lowercase choice ids for the %s preset', (buttonSet, actionIds) => {
    testWindow = renderConfirm(definitionWith({ buttonSet }));

    expect(actionButtons(testWindow).map((button) => button.dataset.actionId)).toEqual(actionIds);
  });

  it('renders custom buttons in declaration order with matching intents', () => {
    testWindow = renderConfirm(definitionWith({
      buttonSet: 'custom',
      customButtons: [
        { actionId: 'send.now', label: 'Send now', intent: 'primary' },
        { actionId: 'send.later', label: 'Send later', intent: 'secondary' },
        { actionId: 'delete.draft', label: 'Delete draft', intent: 'destructive' },
        { actionId: 'close', label: 'Close', intent: 'cancel' },
      ],
    }));

    const buttons = Array.from(testWindow.document.querySelectorAll<HTMLButtonElement>('.actions button'));
    expect(buttons.map((button) => button.textContent)).toEqual(['Send now', 'Send later', 'Delete draft', 'Close']);
    expect(buttons.map((button) => button.dataset.intent)).toEqual(['primary', 'secondary', 'destructive', 'cancel']);
    expect(buttons.map((button) => button.className)).toEqual(['primary', 'secondary', 'destructive', 'cancel']);
  });

  it('renders body as plaintext and leaves markdown literals visible', () => {
    testWindow = renderConfirm(definitionWith({ body: 'Please read **bold** literally.' }));

    expect(testWindow.document.querySelector('.confirm-body')?.textContent).toBe('Please read **bold** literally.');
    expect(testWindow.document.querySelector('strong')).toBeFalsy();
  });

  it('caps long confirmation bodies with an internal scroll region', () => {
    testWindow = renderConfirm(definitionWith({ body: Array.from({ length: 50 }, (_, index) => `Line ${index}`).join('\n') }));

    const body = testWindow.document.querySelector<HTMLElement>('.confirm-body')!;
    const styles = testWindow.getComputedStyle(body);
    expect(body.textContent?.split('\n')).toHaveLength(50);
    expect(styles.overflowY).toBe('auto');
    expect(testWindow.document.querySelector('style')?.textContent).toContain('max-height: clamp(120px, 40vh, 320px)');
  });

  it('renders HTML-like bodies as inert visible text and rejects empty custom button lists', () => {
    const errorSpy = vi.fn();
    const body = '<script>window.__confirmPwned = true; throw new Error("pwned")</script>';

    expect(confirmTool.inputSchema.safeParse(definitionWith({
      buttonSet: 'custom',
      customButtons: [],
    })).success).toBe(false);

    testWindow = renderConfirm(definitionWith({ body }), (window) => {
      window.addEventListener('error', errorSpy);
    });

    expect(testWindow.document.querySelector('.confirm-body')?.textContent).toBe(body);
    expect(testWindow.document.querySelector('.confirm-body')?.innerHTML).toBe(
      '&lt;script&gt;window.__confirmPwned = true; throw new Error("pwned")&lt;/script&gt;',
    );
    expect(testWindow.document.querySelector('.confirm-body script')).toBeFalsy();
    expect((testWindow as unknown as { __confirmPwned?: boolean }).__confirmPwned).toBeUndefined();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('dismisses cancel-intent buttons without submitting', async () => {
    testWindow = renderConfirm(definitionWith({ buttonSet: 'yes-no-cancel' }));

    const cancel = Array.from(testWindow.document.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Cancel')!;
    cancel.click();
    await flushPromises();

    expect(postedMessages(testWindow)).toHaveLength(0);
    const card = testWindow.document.querySelector<HTMLElement>('.state-card')!;
    expect(card.textContent).toContain('Dismissed');
    expect(card.getAttribute('aria-live')).toBe('polite');
  });

  it('disables cancel-intent buttons during in-flight submit and ignores cancel clicks', async () => {
    testWindow = renderConfirm(definitionWith({ buttonSet: 'yes-no-cancel' }));

    const yes = Array.from(testWindow.document.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Yes')!;
    const cancel = Array.from(testWindow.document.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Cancel')!;

    yes.click();
    await flushPromises();

    expect(postedMessages(testWindow)).toHaveLength(1);
    expect(cancel.disabled).toBe(true);
    expect(cancel.hasAttribute('disabled')).toBe(true);

    cancel.click();
    await flushPromises();

    expect(postedMessages(testWindow)).toHaveLength(1);
    expect(testWindow.document.querySelector<HTMLElement>('.state-card')).toBeFalsy();
    expect(testWindow.document.querySelector('.actions')).toBeTruthy();
  });

  it('dismisses custom cancel-intent buttons without submitting', async () => {
    testWindow = renderConfirm(definitionWith({
      buttonSet: 'custom',
      customButtons: [{ actionId: 'close', label: 'Close', intent: 'cancel' }],
    }));

    testWindow.document.querySelector<HTMLButtonElement>('button')!.click();
    await flushPromises();

    expect(postedMessages(testWindow)).toHaveLength(0);
    expect(testWindow.document.querySelector<HTMLElement>('.state-card')?.textContent).toContain('Dismissed');
  });

  it.each([
    ['yes-no', 'Yes', 'yes', 'Yes'],
    ['yes-no-cancel', 'No', 'no', 'No'],
    ['approve-reject', 'Reject', 'reject', 'Reject'],
    ['continue-cancel', 'Continue', 'continue', 'Continue'],
  ] as const)('submits %s preset choices with stable choice and visible choiceLabel', (buttonSet, buttonLabel, choice, choiceLabel) => {
    testWindow = renderConfirm(definitionWith({ buttonSet }));

    actionButtons(testWindow).find((button) => button.textContent === buttonLabel)!.click();

    const messages = postedMessages(testWindow);
    expect(messages).toHaveLength(1);
    const content = (messages[0].params as { content: string }).content;
    expect(parseEnvelope(content)).toEqual({
      actionId: 'confirm.submit',
      choice,
      choiceLabel,
    });
  });

  it('submits custom choices using the custom actionId as choice and label as choiceLabel', () => {
    testWindow = renderConfirm(definitionWith({
      buttonSet: 'custom',
      customButtons: [{ actionId: 'send.now', label: 'Send now', intent: 'primary' }],
    }));

    testWindow.document.querySelector<HTMLButtonElement>('button')!.click();

    const content = (postedMessages(testWindow)[0].params as { content: string }).content;
    expect(parseEnvelope(content)).toEqual({
      actionId: 'confirm.submit',
      choice: 'send.now',
      choiceLabel: 'Send now',
    });
  });

  it('focuses the first button on initial render and summary cards after transition', async () => {
    testWindow = renderConfirm(definitionWith({ buttonSet: 'yes-no' }));
    await flushPromises();

    const firstButton = testWindow.document.querySelector<HTMLButtonElement>('.actions button')!;
    expect(testWindow.document.activeElement).toBe(firstButton);

    firstButton.click();
    const message = postedMessages(testWindow)[0];
    respond(testWindow, message.id, { result: { success: true } });
    await flushPromises();

    const card = testWindow.document.querySelector<HTMLElement>('.state-card')!;
    expect(testWindow.document.activeElement).toBe(card);
    expect(card.tabIndex).toBe(-1);
    expect(card.getAttribute('role')).toBe('status');
    expect(card.getAttribute('aria-live')).toBe('polite');
    expect(card.textContent).toContain('Submitted: Yes');
  });

  it('supports editing to submitted to reopen to editing', async () => {
    testWindow = renderConfirm(definitionWith({ buttonSet: 'yes-no' }));
    await flushPromises();

    testWindow.document.querySelector<HTMLButtonElement>('.actions button')!.click();
    const message = postedMessages(testWindow)[0];
    respond(testWindow, message.id, { result: { success: true } });
    await flushPromises();
    expect(testWindow.document.querySelector<HTMLElement>('.state-card')?.textContent).toContain('Submitted: Yes');

    testWindow.document.querySelector<HTMLButtonElement>('button')!.click();
    await flushPromises();
    expect(buttonLabels(testWindow)).toEqual(['Yes', 'No']);
  });

  it('supports editing to dismissed to reopen to editing', async () => {
    testWindow = renderConfirm(definitionWith({ buttonSet: 'continue-cancel' }));
    await flushPromises();

    Array.from(testWindow.document.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Cancel')!
      .click();
    await flushPromises();
    expect(testWindow.document.querySelector<HTMLElement>('.state-card')?.textContent).toContain('Dismissed');

    testWindow.document.querySelector<HTMLButtonElement>('button')!.click();
    await flushPromises();
    expect(buttonLabels(testWindow)).toEqual(['Continue', 'Cancel']);
  });
});
