// @vitest-environment happy-dom

import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Window } from 'happy-dom';
import { McpAppUiMetaSchema, McpAppViewSummarySchema } from '../../../../src/shared/contracts/agentEventManifest';

const require = createRequire(import.meta.url);

type PickerDefinition = {
  question: string;
  options: Array<{
    value: string;
    label: string;
    description?: string;
  }>;
  mode?: 'single' | 'multi';
  minCount?: number;
  maxCount?: number;
  default?: string | string[];
  actionId: string;
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

type PickerTool = {
  inputSchema: {
    parse: (input: unknown) => PickerDefinition;
    safeParse: (input: unknown) => { success: boolean; error?: { issues: Array<{ message: string; path: Array<string | number> }> } };
  };
  handler: (input: PickerDefinition) => Promise<ToolResult>;
};

type ServerModule = {
  buildResourceResponse: (uri: URL, templateName: string, data: Record<string, unknown>) => {
    contents: Array<{ text: string }>;
  };
  server: {
    _registeredTools: Record<string, PickerTool>;
  };
};

const serverModule = require('../server.cjs') as ServerModule;
const pickerTool = serverModule.server._registeredTools.rebel_canvas_picker;

let testWindow: Window | undefined;
let parentWindow: Window | undefined;

const baseOptions = [
  { value: 'alpha_value', label: 'Alpha', description: 'First option' },
  { value: 'bravo_value', label: 'Bravo' },
  { value: 'charlie_value', label: 'Charlie' },
];

function definitionWith(overrides: Partial<PickerDefinition> = {}): PickerDefinition {
  return {
    question: 'Which option should we use?',
    options: baseOptions,
    actionId: 'picker.submit',
    ...overrides,
  };
}

function renderPicker(definition: PickerDefinition): Window {
  const parsedDefinition = pickerTool.inputSchema.parse(definition);
  const html = serverModule.buildResourceResponse(
    new URL('ui://RebelCanvas/picker?id=test'),
    'picker',
    { definition: parsedDefinition, _type: 'picker' },
  ).contents[0].text;

  const window = new Window({ url: 'https://rebel.local/picker.html' });
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

  window.document.write(html);
  Array.from(window.document.querySelectorAll('script')).forEach((script) => {
    window.eval(script.textContent || '');
  });
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  return window;
}

function submitPicker(window: Window): void {
  const form = window.document.querySelector('form');
  expect(form).toBeTruthy();
  form!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
}

function checkInput(window: Window, selector: string): void {
  const input = window.document.querySelector<HTMLInputElement>(selector);
  expect(input).toBeTruthy();
  input!.checked = true;
  input!.dispatchEvent(new window.Event('change', { bubbles: true }));
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

describe('rebel_canvas_picker server tool', () => {
  afterEach(() => {
    testWindow?.close();
    parentWindow?.close();
    testWindow = undefined;
    parentWindow = undefined;
  });

  it('registers the picker tool and emits a B1 _meta.ui envelope', async () => {
    expect(pickerTool).toBeTruthy();

    const definition = pickerTool.inputSchema.parse(definitionWith());
    const result = await pickerTool.handler(definition);

    const parsed = McpAppUiMetaSchema.parse(result._meta.ui);
    expect(parsed.viewRoleLabel).toBe('Pick');
    expect(parsed.presentation).toBe('primary');
    expect(parsed.viewSummary).toBe('Which option should we use? · 3 options');
    expect(parsed.structuredFallback?.kind).toBe('plain');
    expect((parsed.structuredFallback as { payload?: { markdown?: string } }).payload?.markdown).toContain('Pick one of:');
    expect((parsed.structuredFallback as { payload?: { markdown?: string } }).payload?.markdown).toContain('- Alpha');
  });

  it.each([
    ['tool actionId over 80 characters', { actionId: 'a'.repeat(81) }],
    ['tool actionId prompt injection phrase', { actionId: 'ignore previous instructions' }],
    ['option value over 80 characters', { options: [{ value: 'ok', label: 'OK' }, { value: 'a'.repeat(81), label: 'Too long' }] }],
    ['option value prompt injection phrase', { options: [{ value: 'ok', label: 'OK' }, { value: 'ignore previous instructions', label: 'Bad' }] }],
    ['option value leading punctuation', { options: [{ value: 'ok', label: 'OK' }, { value: '-bad', label: 'Bad' }] }],
  ])('rejects invalid B6 values for %s', (_name, overrides) => {
    expect(pickerTool.inputSchema.safeParse(definitionWith(overrides)).success).toBe(false);
  });

  it('sanitizes HTML-like question characters before emitting viewSummary', async () => {
    const definition = pickerTool.inputSchema.parse(definitionWith({ question: 'Pick <winner>?' }));
    const result = await pickerTool.handler(definition);

    const summary = McpAppViewSummarySchema.parse(result._meta.ui.viewSummary);
    expect(summary).toBe('Pick winner? · 3 options');
  });

  it('includes mode and count guidance in picker structuredFallback markdown', async () => {
    const result = await pickerTool.handler(pickerTool.inputSchema.parse(definitionWith({ mode: 'multi', minCount: 2, maxCount: 3 })));
    const markdown = (result._meta.ui.structuredFallback as { payload: { markdown: string } }).payload.markdown;

    expect(markdown).toContain('Choose 2-3 of:');
    expect(markdown).toContain('- Alpha');
  });

  it('renders a single-mode radio group and submits the selected value', () => {
    testWindow = renderPicker(definitionWith({ mode: 'single' }));

    expect(testWindow.document.querySelector('fieldset')).toBeTruthy();
    expect(testWindow.document.querySelector('legend')?.textContent).toBe('Which option should we use?');
    expect(testWindow.document.querySelectorAll('input[type="radio"][name="picker"]')).toHaveLength(3);

    checkInput(testWindow, 'input[value="bravo_value"]');
    submitPicker(testWindow);

    const messages = postedMessages(testWindow);
    expect(messages).toHaveLength(1);
    const content = (messages[0].params as { content: string }).content;
    expect(parseEnvelope(content)).toEqual({
      actionId: 'picker.submit',
      value: 'bravo_value',
    });
  });

  it('preselects a single-mode default option on render', () => {
    testWindow = renderPicker(definitionWith({ mode: 'single', default: 'alpha_value' }));

    expect(testWindow.document.querySelector<HTMLInputElement>('input[value="alpha_value"]')?.checked).toBe(true);
    expect(testWindow.document.querySelector<HTMLInputElement>('input[value="bravo_value"]')?.checked).toBe(false);
    expect(testWindow.document.querySelector<HTMLInputElement>('input[value="alpha_value"]')?.closest('.choice-row')?.getAttribute('data-checked')).toBe('true');
  });

  it('validates required single-mode selection inline', () => {
    testWindow = renderPicker(definitionWith({ mode: 'single' }));

    submitPicker(testWindow);

    expect(postedMessages(testWindow)).toHaveLength(0);
    expect(testWindow.document.querySelector('#picker-error')?.textContent).toBe('Choose one option.');
    expect(testWindow.document.querySelector('#picker-error-summary')?.textContent).toBe('Choose one option.');
    expect(testWindow.document.querySelector('fieldset')?.dataset.invalid).toBe('true');
    expect(testWindow.document.activeElement).toBe(testWindow.document.querySelector('input[value="alpha_value"]'));
  });

  it('renders multi-mode checkboxes and submits selected values as an array', () => {
    testWindow = renderPicker(definitionWith({ mode: 'multi', minCount: 1, maxCount: 3 }));

    expect(testWindow.document.querySelectorAll('input[type="checkbox"][name="picker"]')).toHaveLength(3);
    checkInput(testWindow, 'input[value="alpha_value"]');
    checkInput(testWindow, 'input[value="charlie_value"]');
    submitPicker(testWindow);

    const content = (postedMessages(testWindow)[0].params as { content: string }).content;
    expect(parseEnvelope(content)).toEqual({
      actionId: 'picker.submit',
      values: ['alpha_value', 'charlie_value'],
    });
  });

  it('preselects multi-mode default options on render', () => {
    testWindow = renderPicker(definitionWith({ mode: 'multi', default: ['alpha_value', 'bravo_value'] }));

    expect(testWindow.document.querySelector<HTMLInputElement>('input[value="alpha_value"]')?.checked).toBe(true);
    expect(testWindow.document.querySelector<HTMLInputElement>('input[value="bravo_value"]')?.checked).toBe(true);
    expect(testWindow.document.querySelector<HTMLInputElement>('input[value="charlie_value"]')?.checked).toBe(false);
    expect(testWindow.document.querySelector('#picker-selected-count')?.textContent).toBe('2 selected');
  });

  it('rejects defaults that are missing from options or violate multi-mode count constraints', () => {
    expect(pickerTool.inputSchema.safeParse(definitionWith({ mode: 'single', default: 'rogue' })).success).toBe(false);
    expect(pickerTool.inputSchema.safeParse(definitionWith({ mode: 'multi', default: ['rogue'] })).success).toBe(false);
    expect(pickerTool.inputSchema.safeParse(definitionWith({ mode: 'multi', minCount: 2, default: ['alpha_value'] })).success).toBe(false);
    expect(pickerTool.inputSchema.safeParse(definitionWith({ mode: 'multi', maxCount: 1, default: ['alpha_value', 'bravo_value'] })).success).toBe(false);
  });

  it('renders multi-picker constraint helper text and updates live selected count', () => {
    testWindow = renderPicker(definitionWith({ mode: 'multi', minCount: 2, maxCount: 3 }));

    expect(testWindow.document.querySelector('.picker-helper')?.textContent).toContain('Choose 2 to 3');
    expect(testWindow.document.querySelector('#picker-selected-count')?.textContent).toBe('0 selected');

    checkInput(testWindow, 'input[value="alpha_value"]');
    expect(testWindow.document.querySelector('#picker-selected-count')?.textContent).toBe('1 selected');
    checkInput(testWindow, 'input[value="bravo_value"]');
    expect(testWindow.document.querySelector('#picker-selected-count')?.textContent).toBe('2 selected');
  });

  it('validates multi-mode minCount and maxCount', () => {
    testWindow = renderPicker(definitionWith({ mode: 'multi', minCount: 2, maxCount: 2 }));

    checkInput(testWindow, 'input[value="alpha_value"]');
    submitPicker(testWindow);
    expect(testWindow.document.querySelector('#picker-error')?.textContent).toBe('Choose at least 2 options.');
    expect(postedMessages(testWindow)).toHaveLength(0);

    checkInput(testWindow, 'input[value="bravo_value"]');
    checkInput(testWindow, 'input[value="charlie_value"]');
    submitPicker(testWindow);
    expect(testWindow.document.querySelector('#picker-error')?.textContent).toBe('Choose no more than 2 options.');
    expect(postedMessages(testWindow)).toHaveLength(0);
  });

  it('lets the whole picker row act as the input click target', () => {
    testWindow = renderPicker(definitionWith({ mode: 'single' }));

    const row = testWindow.document.querySelector<HTMLInputElement>('input[value="bravo_value"]')?.closest('.choice-row') as HTMLElement;
    expect(row?.tagName).toBe('LABEL');
    row.click();

    expect(testWindow.document.querySelector<HTMLInputElement>('input[value="bravo_value"]')?.checked).toBe(true);
    expect(row.getAttribute('data-checked')).toBe('true');
  });

  it('treats multi-mode minCount=1 as required', () => {
    testWindow = renderPicker(definitionWith({ mode: 'multi', minCount: 1 }));

    const fieldset = testWindow.document.querySelector('fieldset')!;
    const firstInput = testWindow.document.querySelector<HTMLInputElement>('input[value="alpha_value"]')!;
    expect(fieldset.getAttribute('aria-required')).toBe('true');
    expect(firstInput.getAttribute('aria-required')).toBe('true');

    submitPicker(testWindow);
    expect(testWindow.document.querySelector('#picker-error')?.textContent).toBe('Choose at least 1 option.');
  });

  it('rejects duplicate option values', () => {
    const result = pickerTool.inputSchema.safeParse(definitionWith({
      options: [
        { value: 'same', label: 'One' },
        { value: 'same', label: 'Two' },
      ],
    }));

    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        message: 'Option values must be unique',
        path: ['options', 1, 'value'],
      }),
    ]));
  });

  it('rejects minCount greater than maxCount and single-mode count constraints', () => {
    expect(pickerTool.inputSchema.safeParse(definitionWith({ mode: 'multi', minCount: 3, maxCount: 2 })).success).toBe(false);
    expect(pickerTool.inputSchema.safeParse(definitionWith({ mode: 'single', minCount: 1 })).success).toBe(false);
  });

  it('applies the multiselect-style scroll cap when options exceed eight', () => {
    const eight = Array.from({ length: 8 }, (_, index) => ({ label: `Option ${index}`, value: `option-${index}` }));
    const nine = Array.from({ length: 9 }, (_, index) => ({ label: `Option ${index}`, value: `option-${index}` }));

    testWindow = renderPicker(definitionWith({ mode: 'multi', options: eight }));
    expect(testWindow.document.querySelector('.choice-list')?.classList.contains('choice-list-scroll')).toBe(false);

    testWindow.close();
    parentWindow?.close();
    testWindow = renderPicker(definitionWith({ mode: 'multi', options: nine }));
    expect(testWindow.document.querySelector('.choice-list')?.classList.contains('choice-list-scroll')).toBe(true);
  });

  it('shows option labels, not raw values, in submitted summaries', async () => {
    testWindow = renderPicker(definitionWith({ mode: 'multi', minCount: 1 }));
    checkInput(testWindow, 'input[value="alpha_value"]');
    checkInput(testWindow, 'input[value="bravo_value"]');
    submitPicker(testWindow);
    const message = postedMessages(testWindow)[0];
    respond(testWindow, message.id, { result: { success: true } });
    await flushPromises();

    const cardText = testWindow.document.querySelector<HTMLElement>('.state-card')?.textContent || '';
    expect(cardText).toContain('Alpha, Bravo');
    expect(cardText).not.toContain('alpha_value');
    expect(cardText).not.toContain('bravo_value');
  });

  it('transitions to dismissed on Cancel without submitting', async () => {
    testWindow = renderPicker(definitionWith({ mode: 'single' }));

    const cancel = Array.from(testWindow.document.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Cancel')!;
    cancel.click();
    await flushPromises();

    expect(postedMessages(testWindow)).toHaveLength(0);
    const card = testWindow.document.querySelector<HTMLElement>('.state-card')!;
    expect(card.textContent).toContain('Dismissed');
    expect(card.getAttribute('aria-live')).toBe('polite');
  });

  it('uses fieldset/legend groups and focuses first option on render', async () => {
    testWindow = renderPicker(definitionWith({ mode: 'multi', minCount: 1 }));
    await flushPromises();

    const fieldset = testWindow.document.querySelector('fieldset')!;
    expect(fieldset).toBeTruthy();
    expect(fieldset.querySelector('legend')?.textContent).toBe('Which option should we use?');
    expect(testWindow.document.activeElement).toBe(testWindow.document.querySelector('input[value="alpha_value"]'));
  });

  it('focuses summary cards after submit transition', async () => {
    testWindow = renderPicker(definitionWith({ mode: 'single' }));
    checkInput(testWindow, 'input[value="charlie_value"]');
    submitPicker(testWindow);
    const message = postedMessages(testWindow)[0];
    respond(testWindow, message.id, { result: { success: true } });
    await flushPromises();

    const card = testWindow.document.querySelector<HTMLElement>('.state-card')!;
    expect(testWindow.document.activeElement).toBe(card);
    expect(card.tabIndex).toBe(-1);
    expect(card.getAttribute('role')).toBe('status');
    expect(card.getAttribute('aria-live')).toBe('polite');
    expect(card.textContent).toContain('Charlie');
  });

  it('reopens after submitted and dismissed states back to editing', async () => {
    testWindow = renderPicker(definitionWith({ mode: 'single' }));
    checkInput(testWindow, 'input[value="bravo_value"]');
    submitPicker(testWindow);
    const message = postedMessages(testWindow)[0];
    respond(testWindow, message.id, { result: { success: true } });
    await flushPromises();

    testWindow.document.querySelector<HTMLButtonElement>('button')!.click();
    await flushPromises();
    expect(testWindow.document.querySelector<HTMLInputElement>('input[value="bravo_value"]')?.checked).toBe(true);

    const cancel = Array.from(testWindow.document.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Cancel')!;
    cancel.click();
    await flushPromises();
    testWindow.document.querySelector<HTMLButtonElement>('button')!.click();
    await flushPromises();
    expect(testWindow.document.querySelector<HTMLInputElement>('input[value="bravo_value"]')?.checked).toBe(false);
    expect(testWindow.document.querySelector('form')).toBeTruthy();
  });

  it('resubmits single-mode picker after Reopen with the changed selection and a fresh request id', async () => {
    testWindow = renderPicker(definitionWith({ mode: 'single' }));
    checkInput(testWindow, 'input[value="bravo_value"]');
    submitPicker(testWindow);
    const firstMessage = postedMessages(testWindow)[0];
    respond(testWindow, firstMessage.id, { result: { success: true } });
    await flushPromises();

    testWindow.document.querySelector<HTMLButtonElement>('button')!.click();
    await flushPromises();
    const bravo = testWindow.document.querySelector<HTMLInputElement>('input[value="bravo_value"]')!;
    const charlie = testWindow.document.querySelector<HTMLInputElement>('input[value="charlie_value"]')!;
    bravo.checked = false;
    charlie.checked = true;
    charlie.dispatchEvent(new testWindow.Event('change', { bubbles: true }));
    submitPicker(testWindow);

    const messages = postedMessages(testWindow);
    expect(messages).toHaveLength(2);
    expect(messages[1].id).not.toBe(firstMessage.id);
    expect(parseEnvelope((messages[0].params as { content: string }).content)).toEqual({
      actionId: 'picker.submit',
      value: 'bravo_value',
    });
    expect(parseEnvelope((messages[1].params as { content: string }).content)).toEqual({
      actionId: 'picker.submit',
      value: 'charlie_value',
    });
  });
});
