/**
 * BEHAVIORAL CONTRACT tests for the image-unsupported-by-model fix
 * (docs/plans/260610_image-unsupported-by-model, Stages 1+2).
 *
 * These pin the USER-VISIBLE contract at the agent-loop boundary — a REAL
 * AnthropicClient (only the Anthropic SDK is mocked, to capture outbound
 * request bodies) driven through the REAL runAgentLoop, exactly the incident
 * shape: managed Mindstone/OpenRouter route, agent Reads a .png, image block
 * lands in the tool result, the next model call must not carry it to a
 * text-only model.
 *
 * Deliberately NOT pinned: which layer substitutes (agentLoop fresh-tool-result
 * gate vs client translate gate — defense in depth means either may absorb a
 * single-layer regression), exact placeholder copy, or capability plumbing
 * internals. A refactor that preserves the outbound-wire behavior passes; one
 * that leaks image bytes to a text-only model, strips them from a capable or
 * unknown model, or loses the persisted image, goes red.
 *
 * Complements (does not duplicate):
 *  - clients/__tests__/imageInputUnsupportedByModel.test.ts — unit seams
 *    (capability function, toAnthropicMessages, buildModelFacingToolResultContent,
 *    doCreate) with capability booleans resolved OUTSIDE the loop.
 *  - __tests__/agentLoop.imageContent.test.ts — loop gating with a MOCK client
 *    whose capability is hand-stubbed (cannot catch config.model → real-client
 *    → catalog wiring breaks).
 */
import { describe, expect, it, vi } from 'vitest';
import { unsafeAssertRoutingModelId } from '@shared/utils/modelChoiceCodec';

// ---- hoisted SDK mock (captures outbound request bodies) ----
const { mockSdkStream } = vi.hoisted(() => ({
  mockSdkStream: vi.fn(),
}));

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    messages = { stream: mockSdkStream };
    beta = { messages: { stream: mockSdkStream } };
    constructor() { /* accept any config */ }
  }
  class APIUserAbortError extends Error { name = 'APIUserAbortError'; }
  class APIError extends Error { status?: number; }
  return { Anthropic: MockAnthropic, APIUserAbortError, APIError };
});

import { runAgentLoop } from '../agentLoop';
import { AnthropicClient } from '../clients/anthropicClient';
import { PROXY_HANDLES_AUTH_SENTINEL } from '../proxyAuthContract';
import type { ExecuteToolFn, RebelCoreConfig, RebelCoreEvent } from '../types';

/** The incident model: Mindstone managed default working + BTS model, text-only. */
const INCIDENT_MODEL = 'deepseek/deepseek-v4-flash';
/** A vision-capable model served by the SAME managed-route client. */
const VISION_MODEL = 'anthropic/claude-sonnet-4-6';
/** An id no catalog entry will ever match — the fail-open (default-capable) leg. */
const UNCATALOGUED_MODEL = 'novalab/imagenext-preview';

// Tiny valid 1x1 transparent PNG (base64) — within all inline-image limits, so
// the ONLY thing that can stop it is the vision-capability gate.
const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const sdkMessage = (model: string, turn: 1 | 2) => (turn === 1
  ? {
    id: 'msg_tool_use',
    content: [{
      type: 'tool_use',
      id: 'tool-read-1',
      name: 'mcp__super-mcp-router__use_tool',
      input: { path: '.rebel/screenshots/capture.png' },
    }],
    stop_reason: 'tool_use',
    model,
    usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  }
  : {
    id: 'msg_end_turn',
    content: [{ type: 'text', text: 'Done looking at the image.' }],
    stop_reason: 'end_turn',
    model,
    usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  });

/**
 * Run one full agent turn (model → Read-style image tool result → model) for
 * `model` against an AnthropicClient shaped exactly like clientFactory
 * PRECEDENCE 1 builds it for the managed Mindstone/OpenRouter route. Returns
 * every request body the SDK saw plus the emitted core events.
 */
async function runIncidentShapedTurn(model: string): Promise<{
  bodies: Array<Record<string, unknown>>;
  events: RebelCoreEvent[];
}> {
  const bodies: Array<Record<string, unknown>> = [];
  mockSdkStream.mockReset();
  mockSdkStream.mockImplementation((body: Record<string, unknown>) => {
    bodies.push(body);
    const message = sdkMessage(model, bodies.length === 1 ? 1 : 2);
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: 'message_start', message: { id: message.id, usage: { input_tokens: 0 } } };
        yield { type: 'message_stop' };
      },
      finalMessage: () => message,
    };
  });

  const client = new AnthropicClient({
    apiKey: PROXY_HANDLES_AUTH_SENTINEL,
    baseURL: 'http://127.0.0.1:1',
    defaultHeaders: { 'x-openrouter-turn': 'true' },
    enableContextManagement: true,
    enableCompact: false,
    provider: 'OpenRouter',
  });

  // A Read-shaped tool result: text output + an inline image block, exactly
  // what builtinTools' Read produces for a .png.
  const executeTool: ExecuteToolFn = vi.fn(async () => ({
    output: '{"path":".rebel/screenshots/capture.png","status":"ok"}',
    isError: false,
    imageContent: [{ type: 'image' as const, data: TINY_PNG_B64, mimeType: 'image/png' }],
  }));

  const config: RebelCoreConfig = {
    client,
    model: unsafeAssertRoutingModelId(model),
    systemPrompt: 'You are a test assistant.',
    messages: [{ role: 'user', content: 'What is in capture.png?' }],
    tools: [{
      name: 'mcp__super-mcp-router__use_tool',
      description: 'MCP tool',
      input_schema: { type: 'object', properties: {} },
    }],
    maxTokens: 256,
  };

  const events: RebelCoreEvent[] = [];
  await runAgentLoop(config, executeTool, (event) => events.push(event));

  return { bodies, events };
}

/**
 * Run one single-leg agent turn (user message with an attached image → model
 * answers end_turn) for `model` against the same managed-route-shaped
 * AnthropicClient. This is the OTHER image ingress (PLAN root-cause #2):
 * user-attached images arrive in the user message content, which the
 * tool-result gate does not cover.
 */
async function runUserAttachmentTurn(model: string): Promise<{
  bodies: Array<Record<string, unknown>>;
}> {
  const bodies: Array<Record<string, unknown>> = [];
  mockSdkStream.mockReset();
  mockSdkStream.mockImplementation((body: Record<string, unknown>) => {
    bodies.push(body);
    const message = sdkMessage(model, 2); // answer immediately — no tool leg
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: 'message_start', message: { id: message.id, usage: { input_tokens: 0 } } };
        yield { type: 'message_stop' };
      },
      finalMessage: () => message,
    };
  });

  const client = new AnthropicClient({
    apiKey: PROXY_HANDLES_AUTH_SENTINEL,
    baseURL: 'http://127.0.0.1:1',
    defaultHeaders: { 'x-openrouter-turn': 'true' },
    enableContextManagement: true,
    enableCompact: false,
    provider: 'OpenRouter',
  });

  const executeTool: ExecuteToolFn = vi.fn(async () => {
    throw new Error('no tool should run on the attachment leg');
  });

  const config: RebelCoreConfig = {
    client,
    model: unsafeAssertRoutingModelId(model),
    systemPrompt: 'You are a test assistant.',
    // A user message carrying a pasted-screenshot-style attachment, exactly
    // the Anthropic-format image block agentTurnUtils builds for attachments.
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'What does this screenshot show?' },
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: TINY_PNG_B64 },
        } as never,
      ],
    }],
    tools: [],
    maxTokens: 256,
  };

  await runAgentLoop(config, executeTool, () => { /* events unused on this leg */ });
  return { bodies };
}

describe('image capability contract — incident shape end-to-end at the agent loop boundary', () => {
  it('a deepseek working model + Read image tool result sends ZERO base64 image payloads and a vision-unsupported placeholder', async () => {
    const { bodies } = await runIncidentShapedTurn(INCIDENT_MODEL);

    // The turn SURVIVED: tool leg + follow-up leg both reached the provider.
    expect(bodies.length).toBe(2);

    // THE incident contract: no request to a text-only model may carry image
    // bytes, anywhere in the serialized body.
    const wire = JSON.stringify(bodies);
    expect(
      wire,
      `image base64 leaked to text-only model ${INCIDENT_MODEL} — this re-creates the OpenRouter 404 `
      + '"No endpoints found that support image input" incident (turn dies with "Something went sideways")',
    ).not.toContain(TINY_PNG_B64);
    expect(wire).not.toContain('"type":"image"');

    // The model is TOLD why the image is missing (not silently dropped).
    expect(wire).toMatch(/vision (is )?not supported/i);
  });

  it('the SAME turn with a Claude model sends the actual image block', async () => {
    const { bodies } = await runIncidentShapedTurn(VISION_MODEL);

    expect(bodies.length).toBe(2);
    const followUp = JSON.stringify(bodies[1]);
    expect(
      followUp,
      `image was stripped for vision-capable model ${VISION_MODEL} — capability substitution must only `
      + 'fire for models that cannot see images',
    ).toContain(TINY_PNG_B64);
    expect(followUp).toContain('"type":"image"');
    expect(followUp).not.toMatch(/vision (is )?not supported/i);
  });

  it('FAIL-OPEN BY DESIGN: an uncatalogued model id keeps images flowing — never silently stripped', async () => {
    const { bodies } = await runIncidentShapedTurn(UNCATALOGUED_MODEL);

    expect(bodies.length).toBe(2);
    expect(
      JSON.stringify(bodies[1]),
      'images were stripped for an UNKNOWN model id. The catalog policy is deliberately default-CAPABLE '
      + '(modelSupportsImageInput returns true for unresolvable ids): a missed text-only model degrades to a '
      + 'classified, actionable provider error (the image_input_unsupported backstop), whereas default-false '
      + 'would SILENTLY degrade every new/uncatalogued vision model with no error and no telemetry. '
      + 'Do not flip this default — mark known text-only models in the catalog instead.',
    ).toContain(TINY_PNG_B64);
  });

  it('USER-ATTACHMENT leg: a deepseek model + pasted screenshot sends ZERO image payloads and an attachment placeholder', async () => {
    const { bodies } = await runUserAttachmentTurn(INCIDENT_MODEL);

    // The turn survived and reached the provider.
    expect(bodies.length).toBe(1);

    const wire = JSON.stringify(bodies);
    expect(
      wire,
      `user-attached image base64 leaked to text-only model ${INCIDENT_MODEL} — same class as the Read `
      + 'tool-result incident, different ingress (PLAN root-cause #2): the user pastes a screenshot while '
      + 'on the managed deepseek default and the turn dies with the OpenRouter image-input 404',
    ).not.toContain(TINY_PNG_B64);
    expect(wire).not.toContain('"type":"image"');

    // SUBSTITUTE, never drop (postmortem 260506): the model is told an
    // attachment existed, and the user's text survives.
    expect(wire).toMatch(/image attachment 1/i);
    expect(wire).toContain('What does this screenshot show?');
  });

  it('USER-ATTACHMENT leg: the SAME turn with a Claude model sends the actual image block', async () => {
    const { bodies } = await runUserAttachmentTurn(VISION_MODEL);

    expect(bodies.length).toBe(1);
    const wire = JSON.stringify(bodies);
    expect(
      wire,
      `user-attached image was stripped for vision-capable model ${VISION_MODEL} — capability `
      + 'substitution must only fire for models that cannot see images',
    ).toContain(TINY_PNG_B64);
    expect(wire).toContain('"type":"image"');
    expect(wire).not.toMatch(/image attachment 1 omitted/i);
  });

  it('substitution is model-facing only: the persisted tool result retains the real image even for the text-only model', async () => {
    const { bodies, events } = await runIncidentShapedTurn(INCIDENT_MODEL);

    // Wire saw no image bytes...
    expect(JSON.stringify(bodies)).not.toContain(TINY_PNG_B64);

    // ...but the emitted tool_use:result event — the source of the persisted
    // conversation — keeps the full original image. Switching this session to
    // a vision-capable model must be able to re-send the actual image.
    const resultEvent = events.find(
      (event): event is Extract<RebelCoreEvent, { type: 'tool_use:result' }> => event.type === 'tool_use:result',
    );
    expect(resultEvent).toBeDefined();
    expect(
      resultEvent?.imageContent,
      'the stored conversation lost the original image — capability substitution must happen at '
      + 'translate/request-build time only, never in persisted history',
    ).toEqual([{ type: 'image', data: TINY_PNG_B64, mimeType: 'image/png' }]);
  });
});
