// @vitest-environment happy-dom

import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Window } from 'happy-dom';
import { McpAppUiMetaSchema } from '../../../../src/shared/contracts/agentEventManifest';

const require = createRequire(import.meta.url);

type ToolResult = {
  content: Array<{ type: string; text: string }>;
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

type FormTool = {
  inputSchema: {
    parse: (input: unknown) => FormDefinition;
    safeParse: (input: unknown) => { success: boolean; error?: { issues: Array<{ message: string; path: Array<string | number> }> } };
  };
  handler: (input: FormDefinition) => Promise<ToolResult>;
};

type ServerModule = {
  ACTION_ID_PATTERN: RegExp;
  FORM_FIELD_TYPES: string[];
  buildResourceResponse: (uri: URL, templateName: string, data: Record<string, unknown>) => {
    contents: Array<{ text: string }>;
  };
  formInputSchema: FormTool['inputSchema'];
  loadActionSubstrateScript: () => string;
  server: {
    _registeredTools: Record<string, FormTool>;
  };
};

type FormField = {
  type: string;
  id: string;
  label: string;
  required?: boolean;
  default?: unknown;
  [key: string]: unknown;
};

type FormDefinition = {
  title: string;
  actionId: string;
  description?: string;
  fields: FormField[];
};

const serverModule = require('../server.cjs') as ServerModule;
const formTool = serverModule.server._registeredTools.rebel_canvas_form;

let testWindow: Window | undefined;
let parentWindow: Window | undefined;

const baseOptions = [
  { label: 'Alpha', value: 'alpha' },
  { label: 'Bravo', value: 'bravo' },
  { label: 'Charlie', value: 'charlie' },
];

const fieldFixtures: FormField[] = [
  { type: 'text', id: 'text', label: 'Text', placeholder: 'Short answer' },
  { type: 'longtext', id: 'longtext', label: 'Long text', rows: 5, maxLength: 120 },
  { type: 'email', id: 'email', label: 'Email' },
  { type: 'url', id: 'url', label: 'URL' },
  { type: 'number', id: 'number', label: 'Number', min: 1, max: 10, step: 1 },
  { type: 'date', id: 'date', label: 'Date', min: '2026-01-01', max: '2026-12-31' },
  { type: 'time', id: 'time', label: 'Time', min: '09:00', max: '17:00' },
  { type: 'datetime', id: 'datetime', label: 'Datetime', min: '2026-01-01T09:00', max: '2026-12-31T17:00' },
  { type: 'select', id: 'select', label: 'Select', options: baseOptions },
  { type: 'multiselect', id: 'multiselect', label: 'Multiselect', options: baseOptions, minCount: 1, maxCount: 2 },
  { type: 'slider', id: 'slider', label: 'Slider', min: 0, max: 60, step: 5, unit: ' minutes' },
  { type: 'rating', id: 'rating', label: 'Rating' },
  { type: 'checkbox', id: 'checkbox', label: 'Checkbox' },
  { type: 'radio', id: 'radio', label: 'Radio', options: baseOptions },
];

function definitionWith(fields: FormField[], overrides: Partial<FormDefinition> = {}): FormDefinition {
  return {
    title: 'Stage 2 form',
    actionId: 'stage2.submit',
    fields,
    ...overrides,
  };
}

function renderForm(definition: FormDefinition): Window {
  const html = serverModule.buildResourceResponse(
    new URL('ui://RebelCanvas/form?id=test'),
    'form',
    { definition, _type: 'form' },
  ).contents[0].text;

  const window = new Window({ url: 'https://rebel.local/form.html' });
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

function submitForm(window: Window): void {
  const form = window.document.querySelector('form');
  expect(form).toBeTruthy();
  form!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
}

function clickSubmitAnyway(window: Window): void {
  const button = Array.from(window.document.querySelectorAll<HTMLButtonElement>('button'))
    .find((candidate) => candidate.textContent === 'Submit anyway');
  expect(button).toBeTruthy();
  button!.click();
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

function dispatchPermissionChanged(window: Window): void {
  const event = new window.Event('message') as Event & { data?: unknown; source?: Window };
  Object.defineProperty(event, 'data', {
    configurable: true,
    value: { kind: 'mcp-app:permission-changed', scope: 'conversation' },
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

function setInputValue(window: Window, selector: string, value: string): void {
  const input = window.document.querySelector(selector) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null;
  expect(input).toBeTruthy();
  input!.value = value;
  if (input!.value !== value) {
    Object.defineProperty(input!, 'value', {
      configurable: true,
      writable: true,
      value,
    });
  }
  input!.dispatchEvent(new window.Event('input', { bubbles: true }));
  input!.dispatchEvent(new window.Event('change', { bubbles: true }));
}

function dispatchKeyboardEvent(window: Window, target: Element, key: string): KeyboardEvent {
  const event = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

function simulateKeyboardRangeChange(window: Window, input: HTMLInputElement, key: string, nextValue: string): void {
  dispatchKeyboardEvent(window, input, key);
  input.value = nextValue;
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
}

function checkInput(window: Window, selector: string): void {
  const input = window.document.querySelector<HTMLInputElement>(selector);
  expect(input).toBeTruthy();
  input!.checked = true;
  input!.dispatchEvent(new window.Event('change', { bubbles: true }));
}

describe('rebel_canvas_form server tool', () => {
  afterEach(() => {
    testWindow?.close();
    parentWindow?.close();
    testWindow = undefined;
    parentWindow = undefined;
  });

  it('registers the form tool and accepts all 14 Stage 2 field types', () => {
    expect(serverModule.FORM_FIELD_TYPES).toEqual([
      'text',
      'longtext',
      'email',
      'url',
      'number',
      'date',
      'time',
      'datetime',
      'select',
      'multiselect',
      'slider',
      'rating',
      'checkbox',
      'radio',
    ]);

    for (const field of fieldFixtures) {
      expect(() => formTool.inputSchema.parse(definitionWith([field]))).not.toThrow();
    }
  });

  it('emits a B1 _meta.ui envelope that passes McpAppUiMetaSchema', async () => {
    const result = await formTool.handler(formTool.inputSchema.parse(definitionWith(fieldFixtures.slice(0, 2))));

    const parsed = McpAppUiMetaSchema.parse(result._meta.ui);
    expect(parsed.viewSummary).toMatch(/^.+ · \d+ field/);
    expect(parsed.viewRoleLabel).toBe('Form');
    expect(parsed.presentation).toBe('primary');
    expect(parsed.structuredFallback?.kind).toBe('plain');
    expect((parsed.structuredFallback as { payload?: { markdown?: string } }).payload?.markdown).toContain('- Text (text, id: text)');
  });

  it.each([
    ['prompt injection phrase', 'ignore previous instructions'],
    ['over 80 characters', 'a'.repeat(81)],
    ['leading punctuation', '-bad'],
  ])('rejects invalid actionId values: %s', (_name, actionId) => {
    expect(formTool.inputSchema.safeParse(definitionWith([fieldFixtures[0]], { actionId })).success).toBe(false);
  });

  it('keeps server and iframe substrate action-id regexes in parity', () => {
    const substrate = serverModule.loadActionSubstrateScript();
    const match = substrate.match(/var ACTION_ID_RE = (\/\^\[A-Za-z0-9\][^;]+\/);/);
    expect(match?.[1]).toBeTruthy();
    const substrateRegex = new Function(`return ${match![1]};`)() as RegExp;
    const serverRegex = serverModule.ACTION_ID_PATTERN;
    const fixtures = [
      'submit',
      'form.submit',
      'form_submit:1',
      'form-submit',
      'a'.repeat(80),
      '',
      '-bad',
      'has space',
      'a'.repeat(81),
      'ümlaut',
    ];

    for (const fixture of fixtures) {
      expect(substrateRegex.test(fixture)).toBe(serverRegex.test(fixture));
    }
  });

  it.each([
    ['date default', { type: 'date', id: 'date', label: 'Date', default: 'tomorrow' }],
    ['date min', { type: 'date', id: 'date', label: 'Date', min: '2026/01/01' }],
    ['date max', { type: 'date', id: 'date', label: 'Date', max: '01-01-2026' }],
    ['time default', { type: 'time', id: 'time', label: 'Time', default: '9am' }],
    ['time min', { type: 'time', id: 'time', label: 'Time', min: '09' }],
    ['time max', { type: 'time', id: 'time', label: 'Time', max: '17:00:00Z' }],
    ['datetime default', { type: 'datetime', id: 'datetime', label: 'Datetime', default: '2026-01-01 09:00' }],
    ['datetime min', { type: 'datetime', id: 'datetime', label: 'Datetime', min: '2026-01-01' }],
    ['datetime max', { type: 'datetime', id: 'datetime', label: 'Datetime', max: 'not-a-datetime' }],
  ])('rejects malformed ISO schema strings for %s', (_name, field) => {
    expect(formTool.inputSchema.safeParse(definitionWith([field])).success).toBe(false);
  });

  it.each([
    ['date', { type: 'date', id: 'date', label: 'Date', min: '2026-12-31', max: '2026-01-01' }],
    ['time', { type: 'time', id: 'time', label: 'Time', min: '17:00', max: '09:00' }],
    ['datetime', { type: 'datetime', id: 'datetime', label: 'Datetime', min: '2026-12-31T17:00', max: '2026-01-01T09:00' }],
    ['datetime-offset', { type: 'datetime', id: 'datetime', label: 'Datetime', min: '2026-01-01T09:00-05:00', max: '2026-01-01T10:00+05:00' }],
  ])('rejects %s fields when min is after max', (_type, field) => {
    const result = formTool.inputSchema.safeParse(definitionWith([field]));

    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        message: 'min must be less than or equal to max',
        path: ['fields', 0, 'min'],
      }),
    ]));
  });

  it.each([
    ['duplicate field ids', [{ type: 'text', id: 'same', label: 'One' }, { type: 'text', id: 'same', label: 'Two' }]],
    ['number min greater than max', [{ type: 'number', id: 'n', label: 'N', min: 10, max: 1 }]],
    ['slider min greater than max', [{ type: 'slider', id: 's', label: 'S', min: 10, max: 1 }]],
    ['slider default outside range', [{ type: 'slider', id: 's', label: 'S', min: 0, max: 10, default: 11 }]],
    ['rating default outside max', [{ type: 'rating', id: 'r', label: 'R', max: 5, default: 6 }]],
    ['multiselect minCount greater than maxCount', [{ type: 'multiselect', id: 'm', label: 'M', options: baseOptions, minCount: 3, maxCount: 2 }]],
    ['multiselect default outside options', [{ type: 'multiselect', id: 'm', label: 'M', options: baseOptions, default: ['rogue'] }]],
    ['select default outside options', [{ type: 'select', id: 's', label: 'S', options: baseOptions, default: 'rogue' }]],
    ['radio default outside options', [{ type: 'radio', id: 'r', label: 'R', options: baseOptions, default: 'rogue' }]],
  ])('rejects schema invariant failure: %s', (_name, fields) => {
    expect(formTool.inputSchema.safeParse(definitionWith(fields)).success).toBe(false);
  });

  it('includes compact option labels and constraints in structuredFallback markdown', async () => {
    const result = await formTool.handler(formTool.inputSchema.parse(definitionWith([
      { type: 'select', id: 'choice', label: 'Choice', options: baseOptions },
      { type: 'multiselect', id: 'many', label: 'Many', options: baseOptions, minCount: 1, maxCount: 2 },
      { type: 'slider', id: 'duration', label: 'Duration', min: 0, max: 60, step: 5, default: 10 },
      { type: 'rating', id: 'score', label: 'Score', max: 10, default: 3 },
      { type: 'date', id: 'date', label: 'Date', min: '2026-01-01', max: '2026-12-31' },
    ])));

    const markdown = ((result._meta.ui.structuredFallback as { payload: { markdown: string } }).payload.markdown);
    expect(markdown).toContain('Alpha=alpha');
    expect(markdown).toContain('min selections: 1');
    expect(markdown).toContain('max: 60');
    expect(markdown).toContain('step: 5');
    expect(markdown).toContain('default: 3');
    expect(markdown).toContain('min: 2026-01-01');
  });

  it.each(fieldFixtures)('renders %s fields with the expected native/control pattern', (field) => {
    testWindow = renderForm(definitionWith([field]));
    const document = testWindow.document;

    if (field.type === 'longtext') {
      expect(document.querySelector('textarea[name="longtext"]')).toBeTruthy();
      expect(document.querySelector('#counter-longtext')?.textContent).toContain('0 / 120 characters');
    } else if (field.type === 'select') {
      expect(document.querySelector('select[name="select"]')).toBeTruthy();
      expect(document.querySelectorAll('select[name="select"] option')).toHaveLength(4);
    } else if (field.type === 'multiselect') {
      expect(document.querySelector('fieldset input[type="checkbox"][name="multiselect"]')).toBeTruthy();
      expect(document.querySelector('select[multiple]')).toBeFalsy();
    } else if (field.type === 'slider') {
      expect(document.querySelector('input[type="range"][name="slider"]')).toBeTruthy();
      expect(document.querySelector('output#output-slider')?.textContent).toBe('0 minutes');
    } else if (field.type === 'rating') {
      expect(document.querySelectorAll('fieldset input[type="radio"][name="rating"]')).toHaveLength(5);
    } else if (field.type === 'checkbox') {
      expect(document.querySelector('input[type="checkbox"][name="checkbox"]')).toBeTruthy();
    } else if (field.type === 'radio') {
      expect(document.querySelectorAll('fieldset input[type="radio"][name="radio"]')).toHaveLength(3);
    } else {
      const expectedType = field.type === 'datetime' ? 'datetime-local' : field.type;
      expect(document.querySelector(`input[type="${expectedType}"][name="${field.id}"]`)).toBeTruthy();
    }

    const inputs = Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input, textarea, select'));
    for (const input of inputs) {
      expect(document.querySelector(`label[for="${input.id}"]`)).toBeTruthy();
      expect(input.getAttribute('aria-describedby')).toContain(`error-${input.name}`);
      expect(input.getAttribute('aria-invalid')).toBe('false');
    }
  });

  it('applies required and dark-mode native-control accessibility affordances', () => {
    testWindow = renderForm(definitionWith([
      { type: 'text', id: 'name', label: 'Name', required: true },
      { type: 'radio', id: 'choice', label: 'Choice', required: true, options: baseOptions },
      { type: 'date', id: 'date', label: 'Date' },
    ]));

    expect(testWindow.document.body.textContent).toBeTruthy();
    expect(testWindow.document.querySelector<HTMLInputElement>('input[name="name"]')?.getAttribute('aria-required')).toBe('true');
    expect(testWindow.document.querySelector<HTMLInputElement>('input[name="choice"]')?.getAttribute('aria-required')).toBe('true');
    expect(testWindow.document.querySelector('style')?.textContent).toContain('color-scheme: light dark');
  });

  it('caps multiselect scrolling only when more than eight options are visible', () => {
    const eight = Array.from({ length: 8 }, (_, index) => ({ label: `Option ${index}`, value: `option-${index}` }));
    const nine = Array.from({ length: 9 }, (_, index) => ({ label: `Option ${index}`, value: `option-${index}` }));

    testWindow = renderForm(definitionWith([{ type: 'multiselect', id: 'eight', label: 'Eight', options: eight }]));
    expect(testWindow.document.querySelector('.choice-list')?.classList.contains('choice-list-scroll')).toBe(false);

    testWindow.close();
    parentWindow?.close();
    testWindow = renderForm(definitionWith([{ type: 'multiselect', id: 'nine', label: 'Nine', options: nine }]));
    expect(testWindow.document.querySelector('.choice-list')?.classList.contains('choice-list-scroll')).toBe(true);
  });

  it('ships grouped-control invalid wrappers and hover-state CSS hooks', () => {
    testWindow = renderForm(definitionWith([
      { type: 'multiselect', id: 'choices', label: 'Choices', options: baseOptions, minCount: 1 },
      { type: 'rating', id: 'score', label: 'Score', required: true },
      { type: 'slider', id: 'duration', label: 'Duration', min: 0, max: 10, step: 5 },
    ]));

    const duration = testWindow.document.querySelector<HTMLInputElement>('input[name="duration"]')!;
    Object.defineProperty(duration, 'value', {
      configurable: true,
      writable: true,
      value: '7',
    });
    submitForm(testWindow);

    expect(testWindow.document.querySelector<HTMLElement>('#container-choices')?.dataset.invalid).toBe('true');
    expect(testWindow.document.querySelector<HTMLElement>('#container-score')?.dataset.invalid).toBe('true');
    expect(testWindow.document.querySelector<HTMLElement>('#container-duration')?.dataset.invalid).toBe('true');
    const css = testWindow.document.querySelector('style')?.textContent || '';
    expect(css).toContain('button.primary:not(:disabled):hover');
    expect(css).toContain('.choice-row:not(:disabled):hover');
    expect(css).toContain('.rating-option input:not(:disabled) + label:hover');
    expect(css).toContain('fieldset[data-invalid="true"]');
    expect(css).toContain('border-color: var(--rc-danger)');
    expect(css).toContain('.field[data-invalid="true"] .slider-row');
    expect(css).toContain('body.dark');
    expect(css).toContain('--rc-danger: #ffb4ab');
  });

  it('renders rating defaults, max override, keyboard navigation, and aria-checked state', () => {
    testWindow = renderForm(definitionWith([{ type: 'rating', id: 'score', label: 'Score' }]));
    expect(testWindow.document.querySelectorAll('input[name="score"]')).toHaveLength(5);

    testWindow.close();
    testWindow = renderForm(definitionWith([{ type: 'rating', id: 'score', label: 'Score', max: 10 }]));
    const radios = Array.from(testWindow.document.querySelectorAll<HTMLInputElement>('input[name="score"]'));
    expect(radios).toHaveLength(10);
    radios[0].focus();
    radios[0].dispatchEvent(new testWindow.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));

    expect(testWindow.document.activeElement).toBe(radios[1]);
    expect(radios[1].checked).toBe(true);
    expect(radios[1].getAttribute('aria-checked')).toBe('true');
    expect(radios[0].getAttribute('aria-checked')).toBe('false');
  });

  it('moves rating focus and selection with arrow keys without trapping Tab inside individual stars', () => {
    testWindow = renderForm(definitionWith([{ type: 'rating', id: 'score', label: 'Score', max: 5 }]));
    const radios = Array.from(testWindow.document.querySelectorAll<HTMLInputElement>('input[name="score"]'));

    radios[1].focus();
    dispatchKeyboardEvent(testWindow, radios[1], 'ArrowRight');
    expect(testWindow.document.activeElement).toBe(radios[2]);
    expect(radios[2].checked).toBe(true);
    expect(radios[2].getAttribute('aria-checked')).toBe('true');

    dispatchKeyboardEvent(testWindow, radios[2], 'ArrowLeft');
    expect(testWindow.document.activeElement).toBe(radios[1]);
    expect(radios[1].checked).toBe(true);
    expect(radios[1].getAttribute('aria-checked')).toBe('true');
    expect(radios[2].getAttribute('aria-checked')).toBe('false');

    const tabEvent = dispatchKeyboardEvent(testWindow, radios[1], 'Tab');
    expect(tabEvent.defaultPrevented).toBe(false);
    expect(testWindow.document.activeElement).toBe(radios[1]);
    expect(radios[1].checked).toBe(true);
  });

  it('updates slider output with unit, valueLabel override, and step snapping', () => {
    testWindow = renderForm(definitionWith([
      { type: 'slider', id: 'duration', label: 'Duration', min: 0, max: 60, step: 5, unit: ' minutes' },
      { type: 'slider', id: 'compact', label: 'Compact', min: 0, max: 60, step: 5, valueLabel: '{value} min' },
    ]));

    const duration = testWindow.document.querySelector<HTMLInputElement>('input[name="duration"]')!;
    duration.value = '17';
    duration.dispatchEvent(new testWindow.Event('input', { bubbles: true }));
    expect(duration.value).toBe('15');
    expect(testWindow.document.querySelector('#output-duration')?.textContent).toBe('15 minutes');

    const compact = testWindow.document.querySelector<HTMLInputElement>('input[name="compact"]')!;
    compact.value = '20';
    compact.dispatchEvent(new testWindow.Event('input', { bubbles: true }));
    expect(testWindow.document.querySelector('#output-compact')?.textContent).toBe('20 min');
  });

  it('keeps slider live output current for keyboard-originated range changes', () => {
    testWindow = renderForm(definitionWith([
      { type: 'slider', id: 'duration', label: 'Duration', min: 0, max: 60, step: 5, unit: ' minutes', default: 20 },
      { type: 'slider', id: 'compact', label: 'Compact', min: 0, max: 60, step: 5, valueLabel: '{value} min', default: 20 },
    ]));

    const duration = testWindow.document.querySelector<HTMLInputElement>('input[name="duration"]')!;
    simulateKeyboardRangeChange(testWindow, duration, 'PageUp', '30');
    expect(duration.value).toBe('30');
    expect(testWindow.document.querySelector('#output-duration')?.textContent).toBe('30 minutes');
    simulateKeyboardRangeChange(testWindow, duration, 'ArrowLeft', '25');
    expect(testWindow.document.querySelector('#output-duration')?.textContent).toBe('25 minutes');

    const compact = testWindow.document.querySelector<HTMLInputElement>('input[name="compact"]')!;
    simulateKeyboardRangeChange(testWindow, compact, 'PageDown', '10');
    expect(compact.value).toBe('10');
    expect(testWindow.document.querySelector('#output-compact')?.textContent).toBe('10 min');
    simulateKeyboardRangeChange(testWindow, compact, 'ArrowRight', '15');
    expect(testWindow.document.querySelector('#output-compact')?.textContent).toBe('15 min');
  });

  it.each([
    ['date', '2025-12-31', '2026-01-01', '2026-12-31'],
    ['time', '08:30', '09:00', '17:00'],
    ['datetime', '2025-12-31T08:00', '2026-01-01T09:00', '2026-12-31T17:00'],
  ])('rejects out-of-range %s values with inline errors', (type, value, min, max) => {
    testWindow = renderForm(definitionWith([{ type, id: type, label: type, min, max }]));
    const inputType = type === 'datetime' ? 'datetime-local' : type;
    setInputValue(testWindow, `input[type="${inputType}"]`, value);
    submitForm(testWindow);

    expect(testWindow.document.querySelector(`#error-${type}`)?.textContent).toContain('must be on or after');
    expect(testWindow.document.querySelector('[role="alert"]')?.textContent).toContain('Please fix 1 field');
    expect(postedMessages(testWindow)).toHaveLength(0);
  });

  it('renders multiselect as a checkbox list and enforces minCount/maxCount', () => {
    testWindow = renderForm(definitionWith([{
      type: 'multiselect',
      id: 'choices',
      label: 'Choices',
      options: baseOptions,
      minCount: 1,
      maxCount: 2,
    }]));

    expect(testWindow.document.querySelectorAll('fieldset input[type="checkbox"][name="choices"]')).toHaveLength(3);
    expect(testWindow.document.querySelector('select[multiple]')).toBeFalsy();

    submitForm(testWindow);
    expect(testWindow.document.querySelector('#error-choices')?.textContent).toContain('at least 1');

    const boxes = Array.from(testWindow.document.querySelectorAll<HTMLInputElement>('input[name="choices"]'));
    boxes.forEach((box) => {
      box.checked = true;
      box.dispatchEvent(new testWindow.Event('change', { bubbles: true }));
    });
    submitForm(testWindow);
    expect(testWindow.document.querySelector('#error-choices')?.textContent).toContain('at most 2');
  });

  it.each([
    ['malformed date', [{ type: 'date', id: 'date', label: 'Date' }], 'input[name="date"]', 'not-a-date', '#error-date'],
    ['malformed time', [{ type: 'time', id: 'time', label: 'Time' }], 'input[name="time"]', '9am', '#error-time'],
    ['malformed datetime', [{ type: 'datetime', id: 'datetime', label: 'Datetime' }], 'input[name="datetime"]', 'tomorrow', '#error-datetime'],
    ['javascript url', [{ type: 'url', id: 'url', label: 'URL' }], 'input[name="url"]', 'javascript:alert(1)', '#error-url'],
    ['NaN number', [{ type: 'number', id: 'number', label: 'Number' }], 'input[name="number"]', 'NaN', '#error-number'],
    ['Infinity number', [{ type: 'number', id: 'number', label: 'Number' }], 'input[name="number"]', 'Infinity', '#error-number'],
  ])('rejects client-side bypass value: %s', (_name, fields, selector, value, errorSelector) => {
    testWindow = renderForm(definitionWith(fields));
    setInputValue(testWindow, selector, value);
    submitForm(testWindow);

    expect(testWindow.document.querySelector(errorSelector)?.textContent).not.toBe('');
    expect(postedMessages(testWindow)).toHaveLength(0);
  });

  it('rejects invalid options, rating ranges, and unknown DOM field keys before submit', () => {
    testWindow = renderForm(definitionWith([
      { type: 'select', id: 'choice', label: 'Choice', options: baseOptions },
      { type: 'multiselect', id: 'many', label: 'Many', options: baseOptions, maxCount: 2 },
      { type: 'rating', id: 'score', label: 'Score', max: 5 },
    ]));

    setInputValue(testWindow, 'select[name="choice"]', 'rogue');
    checkInput(testWindow, 'input[name="many"][value="alpha"]');
    const multiselect = testWindow.document.querySelector<HTMLInputElement>('input[name="many"][value="alpha"]')!;
    multiselect.value = 'rogue';
    const rating = testWindow.document.querySelector<HTMLInputElement>('input[name="score"][value="1"]')!;
    rating.checked = true;
    rating.value = '999';
    const rogue = testWindow.document.createElement('input');
    rogue.name = 'rogue';
    rogue.value = 'surprise';
    testWindow.document.querySelector('form')!.appendChild(rogue);

    submitForm(testWindow);

    expect(testWindow.document.querySelector('#error-choice')?.textContent).toContain('unavailable choice');
    expect(testWindow.document.querySelector('#error-many')?.textContent).toContain('unavailable choice');
    expect(testWindow.document.querySelector('#error-score')?.textContent).toContain('between 1 and 5');
    expect(testWindow.document.querySelector('[role="alert"]')?.textContent).toContain('Unknown field "rogue"');
    expect(postedMessages(testWindow)).toHaveLength(0);
  });

  it('skips invalid custom regex patterns without crashing or blocking submit', () => {
    testWindow = renderForm(definitionWith([{ type: 'text', id: 'code', label: 'Code', pattern: '[' }]));
    setInputValue(testWindow, 'input[name="code"]', 'anything');

    submitForm(testWindow);

    expect(postedMessages(testWindow)).toHaveLength(1);
  });

  it('surfaces required-field errors in summary, inline error, and focuses the first invalid field', () => {
    testWindow = renderForm(definitionWith([{ type: 'text', id: 'name', label: 'Name', required: true }]));

    submitForm(testWindow);

    const input = testWindow.document.querySelector<HTMLInputElement>('input[name="name"]')!;
    expect(testWindow.document.querySelector('#error-name')?.textContent).toBe('Name is required.');
    expect(testWindow.document.querySelector('[role="alert"]')?.textContent).toContain('Name is required.');
    expect(testWindow.document.activeElement).toBe(input);
    expect(input.getAttribute('aria-invalid')).toBe('true');
  });

  it('submits exactly one ui/sendMessage request with a parsable XML envelope', () => {
    testWindow = renderForm(definitionWith([{ type: 'text', id: 'name', label: 'Name', required: true }]));
    setInputValue(testWindow, 'input[name="name"]', 'Ada');

    submitForm(testWindow);

    const messages = postedMessages(testWindow);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      jsonrpc: '2.0',
      method: 'ui/sendMessage',
      params: { role: 'user' },
    });
    const content = (messages[0].params as { content: string }).content;
    expect(parseEnvelope(content)).toEqual({
      actionId: 'stage2.submit',
      fields: { name: 'Ada' },
    });
  });

  it('warns before submitting values over 4 KB and allows explicit proceed through truncation', () => {
    testWindow = renderForm(definitionWith([{ type: 'longtext', id: 'body', label: 'Body' }]));
    setInputValue(testWindow, 'textarea[name="body"]', 'x'.repeat(5 * 1024));

    submitForm(testWindow);
    expect(postedMessages(testWindow)).toHaveLength(0);
    expect(testWindow.document.querySelector('#error-body')?.textContent).toBe('This text is over the size limit; please shorten.');
    expect(testWindow.document.querySelector('[role="alert"]')?.textContent).toContain('Submit anyway');

    clickSubmitAnyway(testWindow);

    const content = (postedMessages(testWindow)[0].params as { content: string }).content;
    const payload = parseEnvelope(content);
    expect(payload._truncated).toBe(true);
    expect((payload.fields as { body: string }).body).toContain('[truncated; 5120 chars]');
  });

  it('renders submitted summaries from the post-truncation payload', async () => {
    testWindow = renderForm(definitionWith([{ type: 'longtext', id: 'body', label: 'Body' }]));
    setInputValue(testWindow, 'textarea[name="body"]', 'x'.repeat(5 * 1024));
    submitForm(testWindow);
    clickSubmitAnyway(testWindow);
    const message = postedMessages(testWindow)[0];
    const payload = parseEnvelope((message.params as { content: string }).content);

    respond(testWindow, message.id, { result: { success: true, submittedPayload: payload } });
    await flushPromises();

    const card = testWindow.document.querySelector<HTMLElement>('.state-card')!;
    expect(card.textContent).toContain('[truncated; 5120 chars]');
    expect(card.textContent).toContain('(truncated)');
  });

  it('renders option labels instead of raw values in submitted summaries', async () => {
    testWindow = renderForm(definitionWith([
      { type: 'select', id: 'select', label: 'Select', options: baseOptions },
      { type: 'radio', id: 'radio', label: 'Radio', options: baseOptions },
      { type: 'multiselect', id: 'many', label: 'Many', options: baseOptions },
    ]));
    setInputValue(testWindow, 'select[name="select"]', 'bravo');
    checkInput(testWindow, 'input[name="radio"][value="charlie"]');
    checkInput(testWindow, 'input[name="many"][value="alpha"]');
    checkInput(testWindow, 'input[name="many"][value="bravo"]');
    submitForm(testWindow);
    const message = postedMessages(testWindow)[0];
    respond(testWindow, message.id, { result: { success: true } });
    await flushPromises();

    const cardText = testWindow.document.querySelector<HTMLElement>('.state-card')?.textContent || '';
    expect(cardText).toContain('Bravo');
    expect(cardText).toContain('Charlie');
    expect(cardText).toContain('Alpha, Bravo');
    expect(cardText).not.toContain('alpha, bravo');
  });

  it('cancels without emitting a message and transitions to the dismissed card', () => {
    testWindow = renderForm(definitionWith([{ type: 'text', id: 'name', label: 'Name' }]));

    const cancel = Array.from(testWindow.document.querySelectorAll('button')).find((button) => button.textContent === 'Cancel')!;
    cancel.click();

    expect(postedMessages(testWindow)).toHaveLength(0);
    const card = testWindow.document.querySelector<HTMLElement>('.state-card')!;
    expect(card.textContent).toContain('Dismissed');
    expect(card.textContent).toContain('Nothing sent');
    expect(card.tabIndex).toBe(-1);
    expect(card.getAttribute('aria-live')).toBe('polite');
    expect(testWindow.document.querySelector('button')?.textContent).toBe('Reopen');
  });

  it('keeps a cancelled pending submit dismissed when a late success response arrives', async () => {
    testWindow = renderForm(definitionWith([{ type: 'text', id: 'name', label: 'Name' }]));
    setInputValue(testWindow, 'input[name="name"]', 'Ada');
    submitForm(testWindow);
    const message = postedMessages(testWindow)[0];
    const cancel = Array.from(testWindow.document.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === 'Cancel')!;

    cancel.dispatchEvent(new testWindow.Event('click', { bubbles: true, cancelable: true }));
    await flushPromises();
    respond(testWindow, message.id, { result: { success: true } });
    await flushPromises();

    const card = testWindow.document.querySelector<HTMLElement>('.state-card')!;
    expect(card.textContent).toContain('Dismissed');
    expect(card.textContent).not.toContain('Submitted');
  });

  it('disables Cancel while submit is in flight and re-enables it after permission denial', async () => {
    testWindow = renderForm(definitionWith([{ type: 'text', id: 'name', label: 'Name' }]));
    setInputValue(testWindow, 'input[name="name"]', 'Ada');
    submitForm(testWindow);
    const message = postedMessages(testWindow)[0];
    const cancel = Array.from(testWindow.document.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === 'Cancel')!;

    expect(cancel.disabled).toBe(true);

    respond(testWindow, message.id, { error: { code: -32000, message: 'Permission required. Allow this app in settings.' } });
    await flushPromises();

    expect(cancel.disabled).toBe(false);
  });

  it('transitions to a readonly submitted card with Reopen after submit success', async () => {
    testWindow = renderForm(definitionWith([{ type: 'text', id: 'name', label: 'Name' }]));
    setInputValue(testWindow, 'input[name="name"]', 'Ada');
    submitForm(testWindow);
    const message = postedMessages(testWindow)[0];

    respond(testWindow, message.id, { result: { success: true } });
    await flushPromises();

    const card = testWindow.document.querySelector<HTMLElement>('.state-card')!;
    expect(card.textContent).toContain('Submitted');
    expect(card.textContent).toContain('Ada');
    expect(card.tabIndex).toBe(-1);
    expect(card.getAttribute('aria-live')).toBe('polite');
    expect(testWindow.document.querySelector('button')?.textContent).toBe('Reopen');
  });

  it('transitions to Submitted after permission-denied auto-retry succeeds', async () => {
    testWindow = renderForm(definitionWith([{ type: 'text', id: 'name', label: 'Name' }]));
    setInputValue(testWindow, 'input[name="name"]', 'Ada');
    submitForm(testWindow);
    const firstMessage = postedMessages(testWindow)[0];

    respond(testWindow, firstMessage.id, { error: { code: -32000, message: 'Permission required. Allow this app in settings.' } });
    await flushPromises();
    expect(testWindow.document.body.textContent).toContain('Permission required');
    expect(testWindow.document.querySelector<HTMLElement>('.state-card')).toBeFalsy();

    dispatchPermissionChanged(testWindow);
    await flushPromises();
    const retryMessage = postedMessages(testWindow)[1];
    expect(retryMessage).toBeTruthy();
    respond(testWindow, retryMessage.id, { result: { success: true } });
    await flushPromises();

    const card = testWindow.document.querySelector<HTMLElement>('.state-card')!;
    expect(card.textContent).toContain('Submitted');
    expect(card.textContent).toContain('Ada');
  });

  it('clears pending permission retry on Cancel before later permission grants', async () => {
    testWindow = renderForm(definitionWith([{ type: 'text', id: 'name', label: 'Name' }]));
    setInputValue(testWindow, 'input[name="name"]', 'Ada');
    submitForm(testWindow);
    const firstMessage = postedMessages(testWindow)[0];
    respond(testWindow, firstMessage.id, { error: { code: -32000, message: 'Permission required. Allow this app in settings.' } });
    await flushPromises();

    const cancel = Array.from(testWindow.document.querySelectorAll('button')).find((button) => button.textContent === 'Cancel')!;
    cancel.click();
    dispatchPermissionChanged(testWindow);
    await flushPromises();

    expect(postedMessages(testWindow)).toHaveLength(1);
    expect(testWindow.document.querySelector<HTMLElement>('.state-card')?.textContent).toContain('Dismissed');
  });

  it('reopens after submit with values pre-filled and sends a fresh request id on resubmit', async () => {
    testWindow = renderForm(definitionWith([{ type: 'text', id: 'name', label: 'Name' }]));
    setInputValue(testWindow, 'input[name="name"]', 'Ada');
    submitForm(testWindow);
    const firstMessage = postedMessages(testWindow)[0];
    respond(testWindow, firstMessage.id, { result: { success: true } });
    await flushPromises();

    testWindow.document.querySelector<HTMLButtonElement>('button')!.click();
    expect(testWindow.document.querySelector<HTMLInputElement>('input[name="name"]')?.value).toBe('Ada');
    submitForm(testWindow);

    const messages = postedMessages(testWindow);
    expect(messages).toHaveLength(2);
    expect(messages[1].id).not.toBe(firstMessage.id);
  });

  it('submits a single-text-field form when Enter is pressed in the input', async () => {
    testWindow = renderForm(definitionWith([{ type: 'text', id: 'name', label: 'Name' }]));
    setInputValue(testWindow, 'input[name="name"]', 'Ada');
    const input = testWindow.document.querySelector<HTMLInputElement>('input[name="name"]')!;

    dispatchKeyboardEvent(testWindow, input, 'Enter');
    await flushPromises();

    expect(postedMessages(testWindow)).toHaveLength(1);
  });

  it('moves focus to the next field instead of submitting on Enter in multi-field forms', () => {
    testWindow = renderForm(definitionWith([
      { type: 'text', id: 'first', label: 'First' },
      { type: 'text', id: 'second', label: 'Second' },
    ]));
    const first = testWindow.document.querySelector<HTMLInputElement>('input[name="first"]')!;
    const second = testWindow.document.querySelector<HTMLInputElement>('input[name="second"]')!;
    first.focus();

    dispatchKeyboardEvent(testWindow, first, 'Enter');

    expect(testWindow.document.activeElement).toBe(second);
    expect(postedMessages(testWindow)).toHaveLength(0);
  });

  it('keeps Enter inside longtext fields as a newline editing action', () => {
    testWindow = renderForm(definitionWith([
      { type: 'longtext', id: 'body', label: 'Body' },
      { type: 'text', id: 'title', label: 'Title' },
    ]));
    const textarea = testWindow.document.querySelector<HTMLTextAreaElement>('textarea[name="body"]')!;
    textarea.focus();

    const event = dispatchKeyboardEvent(testWindow, textarea, 'Enter');

    expect(event.defaultPrevented).toBe(false);
    expect(testWindow.document.activeElement).toBe(textarea);
    expect(postedMessages(testWindow)).toHaveLength(0);
  });

  it('focuses the submitted status card after transition', async () => {
    testWindow = renderForm(definitionWith([{ type: 'text', id: 'name', label: 'Name' }]));
    setInputValue(testWindow, 'input[name="name"]', 'Ada');
    submitForm(testWindow);
    const message = postedMessages(testWindow)[0];
    respond(testWindow, message.id, { result: { success: true } });
    await flushPromises();

    const card = testWindow.document.querySelector<HTMLElement>('.state-card')!;
    expect(testWindow.document.activeElement).toBe(card);
    expect(card.tabIndex).toBe(-1);
    expect(card.getAttribute('role')).toBe('status');
  });

  it('deduplicates rapid Enter submits and reopens submitted forms with every field value preserved', async () => {
    testWindow = renderForm(definitionWith([{ type: 'text', id: 'name', label: 'Name', required: true }]));
    setInputValue(testWindow, 'input[name="name"]', 'Ada');
    const input = testWindow.document.querySelector<HTMLInputElement>('input[name="name"]')!;
    input.focus();

    for (let index = 0; index < 3; index += 1) {
      dispatchKeyboardEvent(testWindow, input, 'Enter');
      submitForm(testWindow);
    }

    const rapidMessages = postedMessages(testWindow);
    expect(rapidMessages).toHaveLength(1);
    respond(testWindow, rapidMessages[0].id, { result: { success: true } });
    await flushPromises();
    expect(testWindow.document.querySelector<HTMLElement>('.state-card')?.textContent).toContain('Submitted');

    testWindow.close();
    parentWindow?.close();
    testWindow = renderForm(definitionWith([
      { type: 'text', id: 'text', label: 'Text', default: 'Default text' },
      { type: 'longtext', id: 'longtext', label: 'Long text', default: 'Default long text' },
      { type: 'email', id: 'email', label: 'Email', default: 'default@example.com' },
      { type: 'url', id: 'url', label: 'URL', default: 'https://default.example.com' },
      { type: 'number', id: 'number', label: 'Number', min: 0, max: 10, step: 1, default: 1 },
      { type: 'date', id: 'date', label: 'Date', default: '2026-02-03' },
      { type: 'time', id: 'time', label: 'Time', default: '10:00' },
      { type: 'datetime', id: 'datetime', label: 'Datetime', default: '2026-02-03T10:00' },
      { type: 'select', id: 'select', label: 'Select', options: baseOptions, default: 'alpha' },
      { type: 'multiselect', id: 'multiselect', label: 'Multiselect', options: baseOptions, default: ['alpha'] },
      { type: 'slider', id: 'slider', label: 'Slider', min: 0, max: 60, step: 5, unit: ' minutes', default: 5 },
      { type: 'rating', id: 'rating', label: 'Rating', default: 2 },
      { type: 'checkbox', id: 'checkbox', label: 'Checkbox', default: false },
      { type: 'radio', id: 'radio', label: 'Radio', options: baseOptions, default: 'alpha' },
    ]));

    setInputValue(testWindow, 'input[name="text"]', 'Edited text');
    setInputValue(testWindow, 'textarea[name="longtext"]', 'Edited long text');
    setInputValue(testWindow, 'input[name="email"]', 'ada@example.com');
    setInputValue(testWindow, 'input[name="url"]', 'https://example.com/edited');
    setInputValue(testWindow, 'input[name="number"]', '7');
    setInputValue(testWindow, 'input[name="date"]', '2026-04-05');
    setInputValue(testWindow, 'input[name="time"]', '14:30');
    setInputValue(testWindow, 'input[name="datetime"]', '2026-04-05T14:30');
    setInputValue(testWindow, 'select[name="select"]', 'bravo');
    checkInput(testWindow, 'input[name="multiselect"][value="alpha"]');
    checkInput(testWindow, 'input[name="multiselect"][value="charlie"]');
    setInputValue(testWindow, 'input[name="slider"]', '35');
    checkInput(testWindow, 'input[name="rating"][value="4"]');
    checkInput(testWindow, 'input[name="checkbox"]');
    checkInput(testWindow, 'input[name="radio"][value="bravo"]');

    submitForm(testWindow);
    const firstMessage = postedMessages(testWindow)[0];
    respond(testWindow, firstMessage.id, { result: { success: true } });
    await flushPromises();
    testWindow.document.querySelector<HTMLButtonElement>('button')!.click();

    expect(testWindow.document.querySelector<HTMLInputElement>('input[name="text"]')?.value).toBe('Edited text');
    expect(testWindow.document.querySelector<HTMLTextAreaElement>('textarea[name="longtext"]')?.value).toBe('Edited long text');
    expect(testWindow.document.querySelector<HTMLInputElement>('input[name="email"]')?.value).toBe('ada@example.com');
    expect(testWindow.document.querySelector<HTMLInputElement>('input[name="url"]')?.value).toBe('https://example.com/edited');
    expect(testWindow.document.querySelector<HTMLInputElement>('input[name="number"]')?.value).toBe('7');
    expect(testWindow.document.querySelector<HTMLInputElement>('input[name="date"]')?.value).toBe('2026-04-05');
    expect(testWindow.document.querySelector<HTMLInputElement>('input[name="time"]')?.value).toBe('14:30');
    expect(testWindow.document.querySelector<HTMLInputElement>('input[name="datetime"]')?.value).toBe('2026-04-05T14:30');
    expect(testWindow.document.querySelector<HTMLSelectElement>('select[name="select"]')?.value).toBe('bravo');
    expect(testWindow.document.querySelector<HTMLInputElement>('input[name="multiselect"][value="alpha"]')?.checked).toBe(true);
    expect(testWindow.document.querySelector<HTMLInputElement>('input[name="multiselect"][value="bravo"]')?.checked).toBe(false);
    expect(testWindow.document.querySelector<HTMLInputElement>('input[name="multiselect"][value="charlie"]')?.checked).toBe(true);
    expect(testWindow.document.querySelector<HTMLInputElement>('input[name="slider"]')?.value).toBe('35');
    expect(testWindow.document.querySelector('#output-slider')?.textContent).toBe('35 minutes');
    expect(testWindow.document.querySelector<HTMLInputElement>('input[name="rating"][value="4"]')?.checked).toBe(true);
    expect(testWindow.document.querySelector<HTMLInputElement>('input[name="checkbox"]')?.checked).toBe(true);
    expect(testWindow.document.querySelector<HTMLInputElement>('input[name="radio"][value="bravo"]')?.checked).toBe(true);
  });

  it('reopens after dismiss with defaults restored and no message emitted by dismiss/reopen', () => {
    testWindow = renderForm(definitionWith([{ type: 'text', id: 'name', label: 'Name', default: 'Default name' }]));
    setInputValue(testWindow, 'input[name="name"]', 'Temporary');
    const cancel = Array.from(testWindow.document.querySelectorAll('button')).find((button) => button.textContent === 'Cancel')!;
    cancel.click();
    testWindow.document.querySelector<HTMLButtonElement>('button')!.click();

    expect(testWindow.document.querySelector<HTMLInputElement>('input[name="name"]')?.value).toBe('Default name');
    expect(postedMessages(testWindow)).toHaveLength(0);
  });

  it('reopens after a cancelled pending submit and resubmits with a fresh request', async () => {
    testWindow = renderForm(definitionWith([{ type: 'text', id: 'name', label: 'Name', default: 'Default name' }]));
    setInputValue(testWindow, 'input[name="name"]', 'Ada');
    submitForm(testWindow);
    const firstMessage = postedMessages(testWindow)[0];
    const cancel = Array.from(testWindow.document.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === 'Cancel')!;
    cancel.dispatchEvent(new testWindow.Event('click', { bubbles: true, cancelable: true }));
    await flushPromises();

    testWindow.document.querySelector<HTMLButtonElement>('button')!.click();
    setInputValue(testWindow, 'input[name="name"]', 'Grace');
    submitForm(testWindow);

    const messages = postedMessages(testWindow);
    expect(messages).toHaveLength(2);
    expect(messages[1].id).not.toBe(firstMessage.id);

    respond(testWindow, firstMessage.id, { result: { success: true } });
    respond(testWindow, messages[1].id, { result: { success: true } });
    await flushPromises();

    const card = testWindow.document.querySelector<HTMLElement>('.state-card')!;
    expect(card.textContent).toContain('Submitted');
    expect(card.textContent).toContain('Grace');
    expect(card.textContent).not.toContain('Ada');
  });
});
