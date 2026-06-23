/**
 * Repro + regression tests for the image-unsupported-by-model incident
 * (docs/plans/260610_image-unsupported-by-model, Stage 2).
 *
 * Incident: the managed Mindstone/OpenRouter route (clientFactory PRECEDENCE 1)
 * constructs an AnthropicClient whose `capabilities.supportsImageContent` was a
 * hardcoded `true` — a PROVIDER-level claim with no per-model term. For the
 * managed default working+BTS model `deepseek/deepseek-v4-flash` (no vision),
 * the agent `Read` a .png → image block in the tool result → next API call →
 * OpenRouter 404 "No endpoints found that support image input" → turn died
 * with a generic "Something went sideways" toast.
 *
 * Fix under test: `ProviderCapabilities.supportsImageContent` is now
 * `(model: string) => boolean` — the compiler forces every reader to supply
 * the per-request model, and the clients AND their provider-level bit with
 * `modelSupportsImageInput()` (catalog metadata, fail-open for unknown ids).
 *
 * RED (pre-fix) evidence: with `supportsImageContent: true` hardcoded, the
 * capability tests throw "supportsImageContent is not a function" and the
 * translator/gate tests leak the raw image block to the provider body.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

// ---- hoisted SDK mocks (capture outbound request bodies) ----
const { mockStream, mockCreate } = vi.hoisted(() => ({
  mockStream: vi.fn(),
  mockCreate: vi.fn(),
}));

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    messages = { stream: mockStream, create: mockCreate };
    beta = { messages: { stream: mockStream, create: mockCreate } };
    constructor() { /* accept any config */ }
  }
  class APIUserAbortError extends Error { name = 'APIUserAbortError'; }
  class APIError extends Error { status?: number; }
  return { Anthropic: MockAnthropic, APIUserAbortError, APIError };
});

import { AnthropicClient, toAnthropicMessages } from '../anthropicClient';
import { OpenAIClient } from '../openaiClient';
import { translateMessagesToOpenAI } from '../openaiTranslators';
import { buildModelFacingToolResultContent } from '../../agentLoop';
import { PROXY_HANDLES_AUTH_SENTINEL } from '../../proxyAuthContract';
import { unsafeAssertRoutingModelId } from '@shared/utils/modelChoiceCodec';
import { buildVisionUnsupportedAttachmentPlaceholder } from '@core/utils/fileTypeDetection';
import type { ChatMessage } from '../../modelTypes';

// The incident model: Mindstone managed default working + BTS model, text-only.
const INCIDENT_MODEL = 'deepseek/deepseek-v4-flash';

// A tiny valid 1x1 transparent PNG (base64) — passes the inline-image limits,
// so the ONLY thing that can stop it is the vision-capability gate.
const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const imageHistory = (toolUseId: string): ChatMessage[] => [
  {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: [
          { type: 'text', text: 'Read image file' },
          { type: 'image', data: TINY_PNG_B64, mimeType: 'image/png' },
        ],
      } as never,
    ],
  },
];

/**
 * AnthropicClient shaped exactly like clientFactory PRECEDENCE 1 builds it for
 * the managed Mindstone / OpenRouter proxy route (sentinel key + OR turn
 * header). This client serves EVERY proxied model, vision or not.
 */
const managedRouteClient = (): AnthropicClient =>
  new AnthropicClient({
    apiKey: PROXY_HANDLES_AUTH_SENTINEL,
    baseURL: 'http://127.0.0.1:1',
    defaultHeaders: { 'x-openrouter-turn': 'true' },
    enableContextManagement: true,
    enableCompact: false,
    provider: 'OpenRouter',
  });

/** Route-table (council/ad-hoc) shaped PRECEDENCE-1 client. */
const routeTableClient = (): AnthropicClient =>
  new AnthropicClient({
    apiKey: PROXY_HANDLES_AUTH_SENTINEL,
    baseURL: 'http://127.0.0.1:1',
    defaultHeaders: { 'x-routed-turn-id': 'turn-1', 'x-proxy-auth': 'token-1' },
    enableContextManagement: true,
    enableCompact: false,
  });

describe('ProviderCapabilities.supportsImageContent is model-aware', () => {
  it('managed/OpenRouter-route AnthropicClient denies image input for the incident model', () => {
    const client = managedRouteClient();
    expect(client.capabilities.supportsImageContent(INCIDENT_MODEL)).toBe(false);
  });

  it('managed/OpenRouter-route AnthropicClient still allows images for vision models', () => {
    const client = managedRouteClient();
    expect(client.capabilities.supportsImageContent('anthropic/claude-sonnet-4-6')).toBe(true);
    expect(client.capabilities.supportsImageContent('openai/gpt-5.5')).toBe(true);
  });

  it('direct-Anthropic client allows images for Claude models', () => {
    const client = new AnthropicClient({ apiKey: 'test-key-not-real' });
    expect(client.capabilities.supportsImageContent('claude-sonnet-4-6')).toBe(true);
    expect(client.capabilities.supportsImageContent('claude-opus-4-8')).toBe(true);
  });

  it('route-table-shaped client denies image input when the concrete deepseek slug flows as params.model (DA F3)', () => {
    const client = routeTableClient();
    expect(client.capabilities.supportsImageContent(INCIDENT_MODEL)).toBe(false);
  });

  it('route-table ALIAS body models fail open (documented residual, NOT a regression)', () => {
    // Route-table SUB-AGENT dispatch streams the route-table-safe alias (e.g.
    // 'working') as the body model (agentTool.ts REBEL-5N8) while the concrete
    // backend rides in `x-routed-model`. The alias is not catalog-resolvable,
    // so the capability check fails OPEN by design — a deepseek route target on
    // that leg degrades to the classified image_input_unsupported error
    // (Stage 4 backstop), never to silent image-stripping on a capable model.
    const client = routeTableClient();
    expect(client.capabilities.supportsImageContent('working')).toBe(true);
  });

  it('OpenAI first-party client ANDs the provider bit with the per-model term', () => {
    const client = new OpenAIClient({
      baseURL: 'http://127.0.0.1:1',
      apiKey: 'test-key-not-real',
      providerType: 'openai',
    });
    expect(client.capabilities.supportsImageContent('gpt-5.5')).toBe(true);
    // Vision provider + text-only model → still denied (the per-model term).
    expect(client.capabilities.supportsImageContent('deepseek-chat')).toBe(false);
  });

  it('OpenAI-compat catch-all providers stay fail-closed regardless of model', () => {
    const client = new OpenAIClient({
      baseURL: 'http://127.0.0.1:1',
      apiKey: 'test-key-not-real',
      providerType: 'other',
    });
    expect(client.capabilities.supportsImageContent('gpt-5.5')).toBe(false);
  });

  it('the capability is a function of the model BY TYPE (truthiness-leak guard)', () => {
    // Compile-time pin: if someone reverts the field to a boolean, this stops
    // compiling. A bare (non-invoked) read of a function value is always
    // truthy, which is exactly the silent-bypass this shape kills.
    const client = managedRouteClient();
    const pin: (model: string) => boolean = client.capabilities.supportsImageContent;
    expect(typeof pin).toBe('function');
  });
});

describe('replayed history honors the per-model capability (toAnthropicMessages seam)', () => {
  it('substitutes a text placeholder for image tool_results bound for the incident model', async () => {
    const client = managedRouteClient();
    const translated = await toAnthropicMessages(
      imageHistory('tool-img-1'),
      client.capabilities.supportsImageContent(INCIDENT_MODEL),
    ) as unknown as Array<{ content: Array<{ tool_use_id: string; content: Array<Record<string, unknown>> }> }>;

    const block = translated[0].content[0];
    expect(block.tool_use_id).toBe('tool-img-1'); // pairing intact
    expect(block.content.find((p) => p.type === 'image')).toBeUndefined();
    const text = block.content
      .filter((p) => p.type === 'text')
      .map((p) => String((p as { text?: unknown }).text ?? ''))
      .join('\n');
    expect(text).toMatch(/vision is not supported/);
    expect(JSON.stringify(translated)).not.toContain(TINY_PNG_B64);
  });

  it('passes image tool_results through unchanged for a vision model on the same client', async () => {
    const client = managedRouteClient();
    const translated = await toAnthropicMessages(
      imageHistory('tool-img-2'),
      client.capabilities.supportsImageContent('anthropic/claude-sonnet-4-6'),
    ) as unknown as Array<{ content: Array<{ content: Array<Record<string, unknown>> }> }>;

    const image = translated[0].content[0].content.find((p) => p.type === 'image');
    expect(image).toBeDefined();
    expect((image?.source as { data?: string } | undefined)?.data).toBe(TINY_PNG_B64);
  });
});

describe('fresh tool results honor the per-model capability (agentLoop chokepoint)', () => {
  const freshResult = {
    output: 'Read image file',
    isError: false,
    imageContent: [{ data: TINY_PNG_B64, mimeType: 'image/png' }],
  } as Parameters<typeof buildModelFacingToolResultContent>[0];

  it('substitutes text placeholders for the incident model', () => {
    const client = managedRouteClient();
    const content = buildModelFacingToolResultContent(
      freshResult,
      client.capabilities.supportsImageContent(INCIDENT_MODEL),
    );
    const blocks = content as Array<{ type: string; text?: string }>;
    expect(blocks.some((b) => b.type === 'image')).toBe(false);
    expect(blocks.some((b) => b.type === 'text' && /vision not supported/.test(b.text ?? ''))).toBe(true);
  });

  it('passes images through for a vision model', () => {
    const client = managedRouteClient();
    const content = buildModelFacingToolResultContent(
      freshResult,
      client.capabilities.supportsImageContent('anthropic/claude-sonnet-4-6'),
    );
    const blocks = content as Array<{ type: string }>;
    expect(blocks.some((b) => b.type === 'image')).toBe(true);
  });
});

describe('user-attached/direct image blocks honor the per-model capability (Stage 3)', () => {
  // User attachments arrive as Anthropic-format image blocks in the user
  // message content array (agentTurnUtils.ts): the ingress the tool_result
  // gate does NOT cover (PLAN root-cause #2 — same class, different ingress).
  const userAttachmentHistory = (): ChatMessage[] => [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'What does this screenshot show?' },
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: TINY_PNG_B64 },
        } as never,
      ],
    },
  ];

  describe('Anthropic path (toAnthropicMessages)', () => {
    it('substitutes a text placeholder for a user image block bound for a text-only model', async () => {
      const translated = await toAnthropicMessages(userAttachmentHistory(), false);
      const wire = JSON.stringify(translated);
      expect(wire, 'image bytes must not reach a text-only model').not.toContain(TINY_PNG_B64);
      expect(wire).not.toContain('"type":"image"');
      // SUBSTITUTE, never drop (postmortem 260506): the model must be told an
      // attachment existed, and the user's text must survive.
      expect(wire).toMatch(/image attachment 1/i);
      expect(wire).toContain('What does this screenshot show?');
    });

    it('passes the real user image block through for a vision-capable model (postmortem 260506 regression guard)', async () => {
      const translated = await toAnthropicMessages(userAttachmentHistory(), true);
      expect(JSON.stringify(translated)).toContain(TINY_PNG_B64);
    });

    it('substitution is translate-time only — the persisted history input keeps the real image', async () => {
      const history = userAttachmentHistory();
      await toAnthropicMessages(history, false);
      // Switching to a vision model later must be able to re-send the actual image.
      expect(JSON.stringify(history)).toContain(TINY_PNG_B64);
    });
  });

  describe('OpenAI path (translateMessagesToOpenAI → buildDirectUserContentParts)', () => {
    it('substitutes a text placeholder for a user image block bound for a text-only model', async () => {
      const translated = await translateMessagesToOpenAI(
        userAttachmentHistory(),
        { supportsImageContent: false },
      );
      const wire = JSON.stringify(translated);
      expect(wire, 'image bytes must not reach a text-only model').not.toContain(TINY_PNG_B64);
      expect(wire).not.toContain('image_url');
      expect(wire).toMatch(/image attachment 1/i);
      expect(wire).toContain('What does this screenshot show?');
    });

    it('passes the real user image part through for a vision-capable model (postmortem 260506 regression guard)', async () => {
      const translated = await translateMessagesToOpenAI(
        userAttachmentHistory(),
        { supportsImageContent: true },
      );
      const wire = JSON.stringify(translated);
      expect(wire).toContain('image_url');
      expect(wire).toContain(TINY_PNG_B64);
    });

    it('substitution is translate-time only — the persisted history input keeps the real image', async () => {
      const history = userAttachmentHistory();
      await translateMessagesToOpenAI(history, { supportsImageContent: false });
      expect(JSON.stringify(history)).toContain(TINY_PNG_B64);
    });

    it('numbers multiple substituted attachments independently', async () => {
      const history: ChatMessage[] = [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: TINY_PNG_B64 } } as never,
            { type: 'text', text: 'two screenshots attached' },
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: TINY_PNG_B64 } } as never,
          ],
        },
      ];
      const translated = await translateMessagesToOpenAI(history, { supportsImageContent: false });
      const wire = JSON.stringify(translated);
      expect(wire).toMatch(/image attachment 1/i);
      expect(wire).toMatch(/image attachment 2/i);
      expect(wire).not.toContain(TINY_PNG_B64);

      // The all-text collapse branch must separate parts with newlines, not
      // run them together ("two screenshots attached[Image attachment 2…]")
      // — Claude stage-4 review F5.
      const userMessage = (translated as Array<{ role: string; content: unknown }>)
        .find((m) => m.role === 'user');
      expect(userMessage?.content).toBe(
        `${buildVisionUnsupportedAttachmentPlaceholder(0)}\n`
        + 'two screenshots attached\n'
        + `${buildVisionUnsupportedAttachmentPlaceholder(1)}`,
      );
    });
  });
});

describe('outbound request body is gated per params.model (doCreate seam — incident shape)', () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      model: INCIDENT_MODEL,
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  });

  const createParams = (model: string) => ({
    model: unsafeAssertRoutingModelId(model),
    systemPrompt: 'test',
    messages: imageHistory('tool-img-3'),
    maxTokens: 64,
  });

  it('a managed-route create() for the incident model sends NO image blocks', async () => {
    const client = managedRouteClient();
    await client.create(createParams(INCIDENT_MODEL));

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const body = mockCreate.mock.calls[0][0] as { messages: unknown };
    const wire = JSON.stringify(body.messages);
    expect(wire).not.toContain(TINY_PNG_B64);
    expect(wire).toMatch(/vision is not supported/);
  });

  it('the SAME client create() for an OR Claude model still sends the image', async () => {
    const client = managedRouteClient();
    await client.create(createParams('anthropic/claude-sonnet-4-6'));

    const body = mockCreate.mock.calls[0][0] as { messages: unknown };
    expect(JSON.stringify(body.messages)).toContain(TINY_PNG_B64);
  });
});
