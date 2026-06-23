#!/usr/bin/env -S npx tsx --tsconfig tsconfig.node.json --require tsconfig-paths/register

/**
 * Manual dev harness for Stage 6 BUG-PREVENTION gate.
 * Run with `npx tsx scripts/test-rebel-canvas-action-submit.ts`.
 * Asserts the four substrate-capable tools round-trip through happy-dom + envelope sanitization.
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Window } from 'happy-dom';

const require = createRequire(import.meta.url);
const serverModule = require('../resources/mcp/rebel-canvas/server.cjs') as ServerModule;

const ENVELOPE_TAG = 'rebel-canvas-submit-v1';

type ToolResult = {
  content?: Array<{ type: string; text: string }>;
  _meta?: {
    ui?: {
      resourceUri?: string;
    };
  };
  isError?: boolean;
};

type RegisteredTool = {
  inputSchema: {
    parse: (input: unknown) => unknown;
  };
  handler: (input: unknown) => Promise<ToolResult>;
};

type RegisteredResource = {
  readCallback: (uri: URL) => Promise<{
    contents: Array<{ text: string }>;
  }>;
};

type ServerModule = {
  server: {
    _registeredTools: Record<string, RegisteredTool>;
    _registeredResourceTemplates: Record<string, RegisteredResource>;
  };
};

type JsonRpcMessage = {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: {
    role?: string;
    content?: string;
  };
};

type HarnessWindow = Window & {
  __rebelCanvas?: {
    submit: (...args: unknown[]) => Promise<unknown>;
  };
};

type RenderedHarness = {
  window: HarnessWindow;
  parent: Window;
  postedMessages: JsonRpcMessage[];
};

type Scenario = {
  name: string;
  toolName: string;
  resourceName: string;
  input: unknown;
  exercise: (window: HarnessWindow) => void | Promise<void>;
  expectedSummary: string;
  expectedPayload: Record<string, unknown>;
};

function isJsonRpcMessage(message: unknown): message is JsonRpcMessage {
  return Boolean(
    message
      && typeof message === 'object'
      && (message as { jsonrpc?: unknown }).jsonrpc === '2.0'
      && typeof (message as { method?: unknown }).method === 'string',
  );
}

async function callToolAndReadHtml(
  toolName: string,
  resourceName: string,
  input: unknown,
): Promise<string> {
  const tool = serverModule.server._registeredTools[toolName];
  assert.ok(tool, `Missing registered tool: ${toolName}`);

  const parsed = tool.inputSchema.parse(input);
  const result = await tool.handler(parsed);
  assert.notEqual(result.isError, true, `${toolName} returned an error`);

  const resourceUri = result._meta?.ui?.resourceUri;
  assert.ok(resourceUri, `${toolName} did not return _meta.ui.resourceUri`);

  const resource = serverModule.server._registeredResourceTemplates[resourceName];
  assert.ok(resource, `Missing registered resource: ${resourceName}`);

  const response = await resource.readCallback(new URL(resourceUri));
  assert.equal(response.contents.length, 1, `${resourceName} returned one resource`);
  return response.contents[0].text;
}

function renderHarness(html: string): RenderedHarness {
  const window = new Window({ url: 'https://rebel.local/canvas-harness.html' }) as HarnessWindow;
  const parent = new Window({ url: 'https://rebel.local/parent.html' });
  const postedMessages: JsonRpcMessage[] = [];

  Object.defineProperty(window, 'parent', {
    configurable: true,
    value: parent,
  });
  Object.defineProperty(window.Event.prototype, 'isTrusted', {
    configurable: true,
    get: () => true,
  });
  Object.defineProperty(parent, 'postMessage', {
    configurable: true,
    value: (message: unknown) => {
      if (isJsonRpcMessage(message)) {
        postedMessages.push(message);
      }
    },
  });

  window.document.write(html);
  Array.from(window.document.querySelectorAll('script')).forEach((script) => {
    window.eval(script.textContent || '');
  });
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));

  return { window, parent, postedMessages };
}

function trustedEvent(window: HarnessWindow, type: string): Event {
  return new window.Event(type, { bubbles: true, cancelable: true });
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function respondSuccess(harness: RenderedHarness, message: JsonRpcMessage): void {
  const event = new harness.window.Event('message') as Event & {
    data?: unknown;
    source?: Window;
  };
  Object.defineProperty(event, 'data', {
    configurable: true,
    value: {
      jsonrpc: '2.0',
      id: message.id,
      result: { accepted: true },
    },
  });
  Object.defineProperty(event, 'source', {
    configurable: true,
    value: harness.parent,
  });
  harness.window.dispatchEvent(event);
}

function parseEnvelope(content: string): { summary: string; payload: Record<string, unknown> } {
  const match = content.match(new RegExp(`^([\\s\\S]*?)\\n\\n<${ENVELOPE_TAG}>\\n([\\s\\S]*?)\\n</${ENVELOPE_TAG}>$`));
  assert.ok(match, `Content did not contain a single ${ENVELOPE_TAG} envelope`);
  return {
    summary: match[1],
    payload: JSON.parse(match[2]) as Record<string, unknown>,
  };
}

function minimalSanitizeForHarness(content: string): string {
  // This manual script intentionally avoids importing the production sanitizer because
  // that module initializes Electron IPC dependencies. It mirrors the relevant floor:
  // CRLF normalization, control/tag-character cleanup, and prompt-injection literal blocking.
  const normalized = content.replace(/\r\n?/gu, '\n').slice(0, 16_384);
  if (normalized.toLowerCase().includes('ignore previous instructions')) {
    throw new Error('Message content contains unsafe instruction text');
  }
  return normalized
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\uFEFF\u202A-\u202E\u2066-\u2069]/gu, '')
    .replace(/[\u{E0000}-\u{E007F}]/gu, '')
    .replace(/\p{M}{4,}/gu, '')
    .trim();
}

function assertEnvelope(
  message: JsonRpcMessage,
  expectedSummary: string,
  expectedPayload: Record<string, unknown>,
): void {
  assert.equal(message.method, 'ui/sendMessage');
  assert.equal(message.params?.role, 'user');
  assert.ok(message.params?.content, 'ui/sendMessage params.content is present');

  const content = message.params.content;
  assert.ok(content.includes(`<${ENVELOPE_TAG}>`), 'content contains opening envelope tag');
  assert.ok(content.includes(`</${ENVELOPE_TAG}>`), 'content contains closing envelope tag');

  const parsed = parseEnvelope(content);
  assert.equal(parsed.summary, expectedSummary);
  assert.deepEqual(parsed.payload, expectedPayload);

  const sanitized = minimalSanitizeForHarness(content);
  const parsedAfterSanitize = parseEnvelope(sanitized);
  assert.equal(parsedAfterSanitize.summary, expectedSummary);
  assert.deepEqual(parsedAfterSanitize.payload, expectedPayload);
}

function setInputValue(window: HarnessWindow, selector: string, value: string): void {
  const input = window.document.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(selector);
  assert.ok(input, `Missing input for selector: ${selector}`);
  input.value = value;
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  input.dispatchEvent(new window.Event('change', { bubbles: true }));
}

function submitFirstForm(window: HarnessWindow): void {
  const form = window.document.querySelector('form');
  assert.ok(form, 'Expected a form to submit');
  form.dispatchEvent(trustedEvent(window, 'submit'));
}

function clickButtonByText(window: HarnessWindow, text: string): void {
  const button = Array.from(window.document.querySelectorAll<HTMLButtonElement>('button'))
    .find((candidate) => candidate.textContent?.trim() === text);
  assert.ok(button, `Expected button with text: ${text}`);
  button.click();
}

async function runScenario(scenario: Scenario): Promise<void> {
  const html = await callToolAndReadHtml(scenario.toolName, scenario.resourceName, scenario.input);
  assert.ok(html.includes('window.__rebelCanvas'), `${scenario.name} HTML includes action substrate`);

  const harness = renderHarness(html);
  try {
    await scenario.exercise(harness.window);
    await flushMicrotasks();

    const message = harness.postedMessages.find((candidate) => candidate.method === 'ui/sendMessage');
    assert.ok(message, `${scenario.name} posted ui/sendMessage`);
    assertEnvelope(message, scenario.expectedSummary, scenario.expectedPayload);
    respondSuccess(harness, message);
    await flushMicrotasks();

    console.log(`PASS ${scenario.name}`);
  } finally {
    harness.window.close();
    harness.parent.close();
  }
}

async function main(): Promise<void> {
  const scenarios: Scenario[] = [
    {
      name: 'rebel_canvas_form',
      toolName: 'rebel_canvas_form',
      resourceName: 'Form View',
      input: {
        title: 'Trip details',
        actionId: 'trip',
        fields: [{ id: 'destination', type: 'text', label: 'Destination' }],
      },
      exercise: (window) => {
        setInputValue(window, 'input[name="destination"]', 'Paris');
        submitFirstForm(window);
      },
      expectedSummary: 'Submitted Trip details',
      expectedPayload: {
        actionId: 'trip',
        fields: { destination: 'Paris' },
      },
    },
    {
      name: 'rebel_canvas_confirm',
      toolName: 'rebel_canvas_confirm',
      resourceName: 'Confirm View',
      input: {
        title: 'Send the draft?',
        body: 'One last check.',
        actionId: 'confirm.send',
        buttonSet: 'yes-no',
      },
      exercise: (window) => {
        clickButtonByText(window, 'Yes');
      },
      expectedSummary: 'Submitted: Yes',
      expectedPayload: {
        actionId: 'confirm.send',
        choice: 'yes',
        choiceLabel: 'Yes',
      },
    },
    {
      name: 'rebel_canvas_picker',
      toolName: 'rebel_canvas_picker',
      resourceName: 'Pick View',
      input: {
        question: 'Pick a meeting time',
        actionId: 'meeting.time',
        mode: 'single',
        options: [
          { value: 'slot_10', label: '10:00' },
          { value: 'slot_14', label: '14:00' },
          { value: 'slot_16', label: '16:00' },
        ],
      },
      exercise: (window) => {
        const input = window.document.querySelector<HTMLInputElement>('input[value="slot_10"]');
        assert.ok(input, 'Expected picker option slot_10');
        input.checked = true;
        input.dispatchEvent(new window.Event('change', { bubbles: true }));
        submitFirstForm(window);
      },
      expectedSummary: 'Picked: 10:00',
      expectedPayload: {
        actionId: 'meeting.time',
        value: 'slot_10',
      },
    },
    {
      name: 'rebel_canvas_html action-submit',
      toolName: 'rebel_canvas_html',
      resourceName: 'HTML View',
      input: {
        html: [
          '<!doctype html><html><body>',
          '<form data-rebel-submit="html.trip" data-rebel-summary="Submitted: destination=Paris">',
          '<input name="destination" value="Paris">',
          '<button type="submit">Submit</button>',
          '</form>',
          '</body></html>',
        ].join(''),
      },
      exercise: (window) => {
        submitFirstForm(window);
      },
      expectedSummary: 'Submitted: destination=Paris',
      expectedPayload: {
        actionId: 'html.trip',
        fields: { destination: 'Paris' },
      },
    },
  ];

  for (const scenario of scenarios) {
    await runScenario(scenario);
  }

  console.log('PASS rebel-canvas action-submit harness');
}

main().catch((error) => {
  console.error('FAIL rebel-canvas action-submit harness');
  console.error(error);
  process.exit(1);
});
