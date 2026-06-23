import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenAIClient } from '../openaiClient';
import { ModelError } from '../../modelErrors';
import { PLAN_OUTPUT_FORMAT, PLAN_RESPONSE_SCHEMA_OPENAI_STRICT } from '../../planningMode';
import type { RuntimeActivityEvent } from '../../runtimeActivity';
import type { CodexModeConfig } from '../../codexModeTypes';
import { unsafeAssertRoutingModelId } from '@shared/utils/modelChoiceCodec';
import { setTracker, type Tracker } from '@core/tracking';
import {
  GATEWAY_TOOL_SIGNATURE_EVENT,
  LITELLM_THOUGHT_ID_DELIMITER,
} from '../gatewayToolSignatureDiagnostic';

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Fail-fast-offline gate (Stage 2 refinement): OpenAIClient.runWithRetry now
// probes reachability on the retry path. The transient-retry tests below key on
// exact mockFetch behavior, so stub the probe to "online" (false) so it never
// issues its own corroboration HEADs through mockFetch.
vi.mock('@core/services/timeoutDiagnosticsService', () => ({
  isMachineOffline: vi.fn(async () => false),
}));

// Mock codexResponsesTranslator — not testing Responses API translation internals here
vi.mock('@core/services/codexResponsesTranslator', () => ({
  translateChatToResponses: vi.fn((req: unknown) => req),
  translateResponsesToChatCompletion: vi.fn((res: unknown) => res),
  createStreamTranslator: vi.fn(() => ({
    translateEvent: vi.fn(() => null),
  })),
  parseSseEventBlock: vi.fn((block: string) => {
    let event = '';
    const dataLines: string[] = [];
    for (const rawLine of block.split(/\r?\n/)) {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      if (!line || line.startsWith(':')) continue;
      const colonIndex = line.indexOf(':');
      if (colonIndex === -1) continue;
      const field = line.slice(0, colonIndex);
      let value = line.slice(colonIndex + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') event = value.trim();
      else if (field === 'data') dataLines.push(value);
    }
    if (dataLines.length === 0) return null;
    return { event, data: dataLines.join('\n') };
  }),
}));

const BASE_PARAMS = {
  model: unsafeAssertRoutingModelId('gpt-5.5'),
  systemPrompt: 'You are helpful.',
  messages: [{ role: 'user' as const, content: 'Hello' }],
  maxTokens: 256,
};

const CHAT_COMPLETION_RESPONSE = {
  id: 'resp-1',
  object: 'chat.completion',
  created: Date.now(),
  model: 'gpt-5.5',
  choices: [
    {
      index: 0,
      message: { role: 'assistant', content: 'Hi there!' },
      finish_reason: 'stop',
    },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
};

const CODEX_ENDPOINT = 'https://chatgpt.com/backend-api/codex';

// Tiny valid 1x1 transparent PNG (base64) — within all inline-image limits,
// so the ONLY thing that could stop it is the vision-capability gate.
const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const JSON_SCHEMA_OUTPUT_CONFIG = {
  format: {
    type: 'json_schema' as const,
    name: 'planner_output',
    schema: {
      type: 'object',
      properties: {
        routing: {
          type: ['object', 'null'],
          properties: {
            mode: { type: 'string' },
          },
        },
      },
    },
  },
};

function makeDoneStream(): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
}

function makeCodexMode(): CodexModeConfig {
  return {
    endpointUrl: CODEX_ENDPOINT,
    getAccessToken: vi.fn(async () => 'codex-token'),
    getAccountId: vi.fn(() => 'org_test'),
    forceRefreshToken: vi.fn(async () => 'codex-token-refreshed'),
  };
}

describe('OpenAIClient', () => {
  afterEach(() => {
    mockFetch.mockReset();
    vi.restoreAllMocks();
  });

  describe('construction', () => {
    it('requires a base URL', () => {
      expect(() => new OpenAIClient({ baseURL: '' })).toThrow('requires a base URL');
    });

    it('accepts config with apiKey and baseURL', () => {
      const client = new OpenAIClient({
        baseURL: 'https://api.openai.com/v1',
        apiKey: 'fake-test',
        provider: 'OpenAI',
      });
      expect(client).toBeInstanceOf(OpenAIClient);
    });

    it('defaults provider name from providerType', () => {
      const client = new OpenAIClient({
        baseURL: 'https://api.cerebras.ai/v1',
        providerType: 'cerebras',
      });
      expect(client).toBeInstanceOf(OpenAIClient);
    });
  });

  describe('vision capability is fail-closed (Stage 4 #4)', () => {
    it('advertises vision ONLY for the first-party openai provider', () => {
      const client = new OpenAIClient({
        baseURL: 'https://api.openai.com/v1',
        apiKey: 'fake-test',
        providerType: 'openai',
      });
      // Per-model term (260610 image-unsupported-by-model): a vision-capable
      // catalog model passes; a text-only model is denied even on the trusted
      // first-party provider.
      expect(client.capabilities.supportsImageContent('gpt-5.5')).toBe(true);
      expect(client.capabilities.supportsImageContent('deepseek-chat')).toBe(false);
    });

    it.each(['together', 'cerebras', 'other'] as const)(
      'treats %s (incl. local/openrouter/google-compat collapsed to "other") as NON-vision',
      (providerType) => {
        const client = new OpenAIClient({
          baseURL: 'http://localhost:1234/v1',
          providerType,
        });
        expect(client.capabilities.supportsImageContent('gpt-5.5')).toBe(false);
      },
    );

    it('defaults to NON-vision when providerType is unspecified', () => {
      const client = new OpenAIClient({ baseURL: 'http://localhost:1234/v1' });
      expect(client.capabilities.supportsImageContent('gpt-5.5')).toBe(false);
    });
  });

  describe('create()', () => {
    it('sends non-streaming request and parses response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => CHAT_COMPLETION_RESPONSE,
      });

      const client = new OpenAIClient({
        baseURL: 'https://api.openai.com/v1',
        apiKey: 'fake-test',
      });
      const result = await client.create(BASE_PARAMS);

      expect(result.content).toEqual([{ type: 'text', text: 'Hi there!' }]);
      expect(result.stopReason).toBe('end_turn');
      expect(result.usage.inputTokens).toBe(10);
      expect(result.usage.outputTokens).toBe(5);

      // Verify fetch was called with correct URL and non-streaming body
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toContain('/chat/completions');
      const body = JSON.parse(opts.body as string);
      expect(body.stream).toBe(false);
      expect(body.model).toBe('gpt-5.5');
    });

    it('refuses oversized prompts before sending the request', async () => {
      const client = new OpenAIClient({
        baseURL: 'https://api.openai.com/v1',
        apiKey: 'sk-test',
        provider: 'OpenAI',
      });

      await expect(
        client.create({
          ...BASE_PARAMS,
          model: unsafeAssertRoutingModelId('unknown-openai-compatible-model'),
          messages: [{ role: 'user', content: 'x'.repeat(800_000) }],
        }),
      ).rejects.toMatchObject({ kind: 'context_overflow' });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('a vision-capable first-party openai model still emits image parts in the actual request body (260610 stage-5 image-SEND pin)', async () => {
      // Body-level regression guard for the per-model capability gate
      // (docs/plans/260610_image-unsupported-by-model): the gate must only
      // STRIP for text-only models — a catalogued vision model on the trusted
      // first-party provider must keep sending real image parts on BOTH
      // ingresses (direct user attachment + replayed image tool_result).
      // Asserted at the fetch body, not the translator, so capability wiring
      // regressions inside doCreate (e.g. a flipped boolean) go red.
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => CHAT_COMPLETION_RESPONSE,
      });

      const client = new OpenAIClient({
        baseURL: 'https://api.openai.com/v1',
        apiKey: 'fake-test',
        providerType: 'openai',
      });

      await client.create({
        ...BASE_PARAMS,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'What does this screenshot show?' },
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: TINY_PNG_B64 } },
            ] as unknown as never,
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tool-read-1',
                content: [
                  { type: 'text', text: 'Read image file' },
                  { type: 'image', data: TINY_PNG_B64, mimeType: 'image/jpeg' },
                ],
              },
            ] as unknown as never,
          },
        ],
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [, opts] = mockFetch.mock.calls[0];
      const body = JSON.parse(opts.body as string) as { messages: unknown };
      const wire = JSON.stringify(body.messages);
      // Direct user attachment survived as a real image_url part…
      expect(wire).toContain(`data:image/png;base64,${TINY_PNG_B64}`);
      // …and so did the replayed tool-result image.
      expect(wire).toContain(`data:image/jpeg;base64,${TINY_PNG_B64}`);
      expect(wire).not.toMatch(/image attachment 1 omitted|vision is not supported/i);
    });

    it('includes Authorization header when apiKey is set', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => CHAT_COMPLETION_RESPONSE,
      });

      const client = new OpenAIClient({
        baseURL: 'https://api.openai.com/v1',
        apiKey: 'fake-secret',
      });
      await client.create(BASE_PARAMS);

      const [, opts] = mockFetch.mock.calls[0];
      expect(opts.headers.Authorization).toBe('Bearer fake-secret');
    });
  });

  describe('response_format gating', () => {
    const getLatestRequestBody = (): Record<string, unknown> => {
      const [, opts] = mockFetch.mock.calls.at(-1) as [string, { body: string }];
      return JSON.parse(opts.body) as Record<string, unknown>;
    };

    it('doCreate emits OpenAI-strict planner schema for providerType openai', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => CHAT_COMPLETION_RESPONSE,
      });

      const client = new OpenAIClient({
        baseURL: 'https://api.openai.com/v1',
        apiKey: 'fake-test',
        providerType: 'openai',
      });

      await client.create({
        ...BASE_PARAMS,
        outputConfig: { format: PLAN_OUTPUT_FORMAT },
      });

      const body = getLatestRequestBody();
      expect(body).toHaveProperty('response_format');
      expect(body.response_format).toMatchObject({
        type: 'json_schema',
        json_schema: {
          name: 'rebel_plan',
          strict: true,
          schema: {
            type: 'object',
          },
        },
      });
      expect((body.response_format as { json_schema: { schema: unknown } }).json_schema.schema).toEqual(
        PLAN_RESPONSE_SCHEMA_OPENAI_STRICT,
      );
      // Per `docs/plans/260508_planner_schema_openai_strict_flatten_discriminator.md`,
      // OpenAI strict mode forbids root combinators unconditionally. The
      // emitted schema MUST be flat (no top-level anyOf/oneOf/allOf) with
      // the discriminator in `properties.type`.
      const emittedSchema = (
        body.response_format as { json_schema: { schema: Record<string, unknown> } }
      ).json_schema.schema;
      expect(emittedSchema.anyOf).toBeUndefined();
      expect(emittedSchema.oneOf).toBeUndefined();
      expect((emittedSchema.properties as Record<string, unknown> | undefined)?.type).toMatchObject({
        type: 'string',
        enum: ['direct_answer', 'plan'],
      });
    });

    it('doCreate passes through non-planner response_format schema for providerType openai', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => CHAT_COMPLETION_RESPONSE,
      });

      const client = new OpenAIClient({
        baseURL: 'https://api.openai.com/v1',
        apiKey: 'fake-test',
        providerType: 'openai',
      });

      await client.create({
        ...BASE_PARAMS,
        outputConfig: JSON_SCHEMA_OUTPUT_CONFIG,
      });

      const body = getLatestRequestBody();
      expect(body).toHaveProperty('response_format');
      expect(body.response_format).toMatchObject({
        type: 'json_schema',
        json_schema: {
          name: 'planner_output',
          strict: true,
        },
      });
      expect((body.response_format as { json_schema: { schema: unknown } }).json_schema.schema).toEqual(
        JSON_SCHEMA_OUTPUT_CONFIG.format.schema,
      );
    });

    it('doCreate omits response_format for providerType other', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => CHAT_COMPLETION_RESPONSE,
      });

      const client = new OpenAIClient({
        baseURL: 'https://api.cohere.ai/v1',
        apiKey: 'fake-test',
        providerType: 'other',
      });

      await client.create({
        ...BASE_PARAMS,
        outputConfig: { format: PLAN_OUTPUT_FORMAT },
      });

      const body = getLatestRequestBody();
      expect(body).not.toHaveProperty('response_format');
    });

    it('doStream emits OpenAI-strict planner schema for providerType openai', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: makeDoneStream(),
      });

      const client = new OpenAIClient({
        baseURL: 'https://api.openai.com/v1',
        apiKey: 'fake-test',
        providerType: 'openai',
      });

      await client.stream(
        {
          ...BASE_PARAMS,
          outputConfig: { format: PLAN_OUTPUT_FORMAT },
        },
        () => {},
      );

      const body = getLatestRequestBody();
      expect(body).toHaveProperty('response_format');
      expect(body.response_format).toMatchObject({
        type: 'json_schema',
        json_schema: {
          name: 'rebel_plan',
          strict: true,
          schema: {
            type: 'object',
          },
        },
      });
      expect((body.response_format as { json_schema: { schema: unknown } }).json_schema.schema).toEqual(
        PLAN_RESPONSE_SCHEMA_OPENAI_STRICT,
      );
      // See doCreate counterpart above for the flat-shape rationale.
      const emittedSchema = (
        body.response_format as { json_schema: { schema: Record<string, unknown> } }
      ).json_schema.schema;
      expect(emittedSchema.anyOf).toBeUndefined();
      expect(emittedSchema.oneOf).toBeUndefined();
      expect((emittedSchema.properties as Record<string, unknown> | undefined)?.type).toMatchObject({
        type: 'string',
        enum: ['direct_answer', 'plan'],
      });
    });

    it('doStream passes through non-planner response_format schema for providerType openai', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: makeDoneStream(),
      });

      const client = new OpenAIClient({
        baseURL: 'https://api.openai.com/v1',
        apiKey: 'fake-test',
        providerType: 'openai',
      });

      await client.stream(
        {
          ...BASE_PARAMS,
          outputConfig: JSON_SCHEMA_OUTPUT_CONFIG,
        },
        () => {},
      );

      const body = getLatestRequestBody();
      expect(body).toHaveProperty('response_format');
      expect(body.response_format).toMatchObject({
        type: 'json_schema',
        json_schema: {
          name: 'planner_output',
          strict: true,
        },
      });
      expect((body.response_format as { json_schema: { schema: unknown } }).json_schema.schema).toEqual(
        JSON_SCHEMA_OUTPUT_CONFIG.format.schema,
      );
    });

    it('doStream omits response_format for providerType other', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: makeDoneStream(),
      });

      const client = new OpenAIClient({
        baseURL: 'https://api.cohere.ai/v1',
        apiKey: 'fake-test',
        providerType: 'other',
      });

      await client.stream(
        {
          ...BASE_PARAMS,
          outputConfig: { format: PLAN_OUTPUT_FORMAT },
        },
        () => {},
      );

      const body = getLatestRequestBody();
      expect(body).not.toHaveProperty('response_format');
    });
  });

  describe('stream()', () => {
    it('parses SSE stream and emits events', async () => {
      const sseData = [
        'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"gpt-5.5","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}\n\n',
        'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"gpt-5.5","choices":[{"index":0,"delta":{"content":" world"},"finish_reason":null}]}\n\n',
        'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"gpt-5.5","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\n',
        'data: [DONE]\n\n',
      ];

      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          for (const chunk of sseData) {
            controller.enqueue(encoder.encode(chunk));
          }
          controller.close();
        },
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: stream,
      });

      const client = new OpenAIClient({
        baseURL: 'https://api.openai.com/v1',
        apiKey: 'fake-test',
      });

      const events: Array<{ type: string; text?: string }> = [];
      const result = await client.stream(BASE_PARAMS, (event) => {
        events.push(event);
      });

      expect(events).toEqual([
        { type: 'text_delta', text: 'Hello' },
        { type: 'text_delta', text: ' world' },
      ]);
      expect(result.content).toEqual([{ type: 'text', text: 'Hello world' }]);
      expect(result.stopReason).toBe('end_turn');
      expect(result.usage.inputTokens).toBe(5);
      expect(result.usage.outputTokens).toBe(2);
    });

    it('returns undefined model when stream chunks carry empty-string model', async () => {
      const sseData = [
        'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"","choices":[{"index":0,"delta":{"content":"Hi"},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":1,"total_tokens":6}}\n\n',
        'data: [DONE]\n\n',
      ];

      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          for (const chunk of sseData) {
            controller.enqueue(encoder.encode(chunk));
          }
          controller.close();
        },
      });

      mockFetch.mockResolvedValueOnce({ ok: true, body: stream });

      const client = new OpenAIClient({
        baseURL: 'https://api.openai.com/v1',
        apiKey: 'fake-test',
      });

      const result = await client.stream(BASE_PARAMS, () => {});
      // Empty-string model must not leak — downstream consumers use || fallback
      expect(result.model).toBeUndefined();
    });

    it('classifies streaming maximum-context errors as context_overflow', async () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              'data: {"error":{"type":"invalid_request_error","message":"maximum context length is 196608 tokens. However, you requested about 201187 tokens"}}\n\n',
            ),
          );
          controller.close();
        },
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: stream,
      });

      const client = new OpenAIClient({
        baseURL: 'https://api.openai.com/v1',
        apiKey: 'sk-test',
      });

      await expect(client.stream(BASE_PARAMS, () => {})).rejects.toMatchObject({
        kind: 'context_overflow',
      });
    });
  });

  describe('error classification via classifyHttpError', () => {
    it('classifies 429 as rate_limit', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: async () => JSON.stringify({ error: { message: 'Rate limit exceeded' } }),
      });

      const client = new OpenAIClient({
        baseURL: 'https://api.openai.com/v1',
        apiKey: 'fake-test',
        provider: 'OpenAI',
      });

      await expect(client.create(BASE_PARAMS)).rejects.toThrow(ModelError);
      try {
        await client.create(BASE_PARAMS);
      } catch {
        // Retry exhausted — need to check initial classification
      }
    });

    it('classifies 401 as auth error', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => JSON.stringify({ error: { message: 'Invalid API key' } }),
      });

      const client = new OpenAIClient({
        baseURL: 'https://api.openai.com/v1',
        apiKey: 'fake-bad',
        provider: 'OpenAI',
      });

      try {
        await client.create(BASE_PARAMS);
        expect.unreachable('should throw');
      } catch (e) {
        expect(e).toBeInstanceOf(ModelError);
        const err = e as ModelError;
        expect(err.kind).toBe('auth');
        expect(err.provider).toBe('OpenAI');
      }
    });

    // REBEL-66J/65G: a 403 carrying an auth marker must classify as auth (not
    // billing) so it reaches the re-authenticate UX. 401 is special-cased with
    // a token refresh; 403 flows through classifyHttpError → classifyStatus.
    it('classifies 403 with auth message as auth error (REBEL-66J/65G)', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 403,
        text: async () => JSON.stringify({ error: { message: 'Invalid authentication' } }),
      });

      const client = new OpenAIClient({
        baseURL: 'https://openrouter.ai/api/v1',
        apiKey: 'fake-bad',
        provider: 'OpenRouter',
      });

      try {
        await client.create(BASE_PARAMS);
        expect.unreachable('should throw');
      } catch (e) {
        expect(e).toBeInstanceOf(ModelError);
        const err = e as ModelError;
        expect(err.kind).toBe('auth');
        expect(err.provider).toBe('OpenRouter');
      }
    });

    // Guard: a genuine billing-403 (no auth marker) stays billing.
    it('classifies 403 billing message as billing (auth carve-out guard)', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 403,
        text: async () => JSON.stringify({ error: { message: 'Account suspended for non-payment' } }),
      });

      const client = new OpenAIClient({
        baseURL: 'https://openrouter.ai/api/v1',
        apiKey: 'fake-test',
        provider: 'OpenRouter',
      });

      try {
        await client.create(BASE_PARAMS);
        expect.unreachable('should throw');
      } catch (e) {
        expect(e).toBeInstanceOf(ModelError);
        const err = e as ModelError;
        expect(err.kind).toBe('billing');
      }
    });

    it('classifies 500 as server_error', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      });

      const client = new OpenAIClient({
        baseURL: 'https://api.openai.com/v1',
        apiKey: 'fake-test',
        provider: 'OpenAI',
      });

      try {
        await client.create(BASE_PARAMS);
        expect.unreachable('should throw');
      } catch (e) {
        expect(e).toBeInstanceOf(ModelError);
        const err = e as ModelError;
        // server_error is transient so retries happen first, but ultimately throws
        expect(err.kind).toBe('server_error');
      }
    });

    it('classifies 400 as invalid_request', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ error: { message: 'Invalid model name' } }),
      });

      const client = new OpenAIClient({
        baseURL: 'https://api.openai.com/v1',
        apiKey: 'fake-test',
        provider: 'OpenAI',
      });

      try {
        await client.create(BASE_PARAMS);
        expect.unreachable('should throw');
      } catch (e) {
        expect(e).toBeInstanceOf(ModelError);
        expect((e as ModelError).kind).toBe('invalid_request');
      }
    });
  });

  describe('retry behavior', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.spyOn(Math, 'random').mockReturnValue(0);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('retries on transient errors and calls onRetry', async () => {
      let callCount = 0;
      mockFetch.mockImplementation(async () => {
        callCount++;
        if (callCount < 3) {
          return {
            ok: false,
            status: 429,
            text: async () => JSON.stringify({ error: { message: 'Rate limited' } }),
          };
        }
        return {
          ok: true,
          json: async () => CHAT_COMPLETION_RESPONSE,
        };
      });

      const client = new OpenAIClient({
        baseURL: 'https://api.openai.com/v1',
        apiKey: 'fake-test',
        provider: 'OpenAI',
      });

      const onRetry = vi.fn();
      const promise = client.create({ ...BASE_PARAMS, onRetry });

      // Advance through retry delays
      await vi.advanceTimersByTimeAsync(1_000); // 1st retry delay
      await vi.advanceTimersByTimeAsync(2_000); // 2nd retry delay

      const result = await promise;
      expect(result.content).toEqual([{ type: 'text', text: 'Hi there!' }]);

      expect(onRetry).toHaveBeenCalledTimes(2);
      expect(onRetry).toHaveBeenNthCalledWith(1, {
        attempt: 1,
        maxRetries: 3,
        delayMs: 1_000,
        errorKind: 'rate_limit',
        provider: 'OpenAI',
      });
      expect(onRetry).toHaveBeenNthCalledWith(2, {
        attempt: 2,
        maxRetries: 3,
        delayMs: 2_000,
        errorKind: 'rate_limit',
        provider: 'OpenAI',
      });
    });

    it('retries stream start stalls as transient server errors', async () => {
      mockFetch.mockImplementation((_url: string, opts: { signal?: AbortSignal }) => {
        const signal = opts.signal;
        return new Promise((_, reject) => {
          if (!signal) {
            reject(new Error('missing signal'));
            return;
          }
          if (signal.aborted) {
            reject(new DOMException('Aborted', 'AbortError'));
            return;
          }
          signal.addEventListener(
            'abort',
            () => {
              reject(new DOMException('Aborted', 'AbortError'));
            },
            { once: true },
          );
        });
      });

      const client = new OpenAIClient({
        baseURL: 'https://api.openai.com/v1',
        apiKey: 'fake-test',
        provider: 'OpenAI',
      });

      const onRetry = vi.fn();
      const promise = client.stream({ ...BASE_PARAMS, onRetry }, () => {}).catch((e: unknown) => e);

      await vi.advanceTimersByTimeAsync(1_300_000);

      const err = await promise;
      expect(err).toBeInstanceOf(ModelError);
      expect((err as ModelError).kind).toBe('server_error');
      expect((err as ModelError).message).toContain('timed out waiting for first response chunk');
      expect(mockFetch).toHaveBeenCalledTimes(4);
      expect(onRetry).toHaveBeenCalledTimes(3);
      expect(onRetry).toHaveBeenNthCalledWith(1, {
        attempt: 1,
        maxRetries: 3,
        delayMs: 1_000,
        errorKind: 'server_error',
        provider: 'OpenAI',
      });
      expect(onRetry).toHaveBeenNthCalledWith(2, {
        attempt: 2,
        maxRetries: 3,
        delayMs: 2_000,
        errorKind: 'server_error',
        provider: 'OpenAI',
      });
      expect(onRetry).toHaveBeenNthCalledWith(3, {
        attempt: 3,
        maxRetries: 3,
        delayMs: 4_000,
        errorKind: 'server_error',
        provider: 'OpenAI',
      });
    });
  });

  describe('Responses API routing', () => {
    it('uses Responses API when providerType is openai with reasoning_effort and tools', async () => {
      // The Responses API route needs both reasoning_effort AND tools
      const sseData = [
        'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"gpt-5.5","choices":[{"index":0,"delta":{"content":"Done"},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":1,"total_tokens":6}}\n\n',
        'data: [DONE]\n\n',
      ];

      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          for (const chunk of sseData) {
            controller.enqueue(encoder.encode(chunk));
          }
          controller.close();
        },
      });

      mockFetch.mockResolvedValueOnce({ ok: true, body: stream });

      const client = new OpenAIClient({
        baseURL: 'https://api.openai.com/v1',
        apiKey: 'fake-test',
        providerType: 'openai',
      });

      const tools = [
        {
          name: 'Read',
          description: 'Read a file',
          input_schema: {
            type: 'object' as const,
            properties: { path: { type: 'string' } },
          },
        },
      ];

      await client.stream({ ...BASE_PARAMS, tools, effort: 'high' }, () => {});

      // The fetch URL should target the Responses API path
      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain('/responses');
    });

    it('suppressReasoningEffort keeps an openai+tools turn on chat completions (no Responses route)', async () => {
      // Subtle interaction: the Responses route requires reasoning_effort. When reasoning is
      // suppressed (the profile's thinkingCompatibility is incompatible), reasoning_effort is
      // omitted upstream, so even an openai-type profile with tools stays on /chat/completions
      // and sends no reasoning param.
      mockFetch.mockResolvedValueOnce({ ok: true, body: makeDoneStream() });
      const client = new OpenAIClient({
        baseURL: 'https://api.openai.com/v1',
        apiKey: 'fake-test',
        providerType: 'openai',
        suppressReasoningEffort: true,
      });
      const tools = [
        { name: 'Read', description: 'Read a file', input_schema: { type: 'object' as const, properties: { path: { type: 'string' } } } },
      ];
      await client.stream({ ...BASE_PARAMS, tools, effort: 'high' }, () => {});
      const [url, opts] = mockFetch.mock.calls[0] as [string, { body: string }];
      expect(url).toContain('/chat/completions');
      expect(JSON.parse(opts.body)).not.toHaveProperty('reasoning_effort');
    });

    it('uses chat completions for non-openai provider even with reasoning_effort + tools', async () => {
      const sseData = [
        'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"llama","choices":[{"index":0,"delta":{"content":"Done"},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
      ];

      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          for (const chunk of sseData) {
            controller.enqueue(encoder.encode(chunk));
          }
          controller.close();
        },
      });

      mockFetch.mockResolvedValueOnce({ ok: true, body: stream });

      const client = new OpenAIClient({
        baseURL: 'https://api.together.xyz/v1',
        apiKey: 'fake-test',
        providerType: 'together',
      });

      const tools = [
        {
          name: 'Read',
          description: 'Read a file',
          input_schema: {
            type: 'object' as const,
            properties: { path: { type: 'string' } },
          },
        },
      ];

      await client.stream({ ...BASE_PARAMS, tools, effort: 'high' }, () => {});

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain('/chat/completions');
    });

    it('omits reasoning_effort entirely when the client suppresses thinking (stream)', async () => {
      // gw/litellm→Vertex case: a gateway that mistranslates reasoning_effort into a
      // thinking format the model rejects. A suppressed client must send NO
      // reasoning param so the gateway never injects a thinking block.
      mockFetch.mockResolvedValueOnce({ ok: true, body: makeDoneStream() });

      const client = new OpenAIClient({
        baseURL: 'https://gateway.example.com/v1',
        apiKey: 'fake-test',
        providerType: 'other',
        suppressReasoningEffort: true,
      });

      await client.stream({ ...BASE_PARAMS, effort: 'high' }, () => {});

      const [url, opts] = mockFetch.mock.calls[0] as [string, { body: string }];
      const body = JSON.parse(opts.body) as Record<string, unknown>;
      expect(url).toContain('/chat/completions');
      expect(body).not.toHaveProperty('reasoning_effort');
    });

    it('omits reasoning_effort entirely when the client suppresses thinking (doCreate / non-stream)', async () => {
      // Same suppression gate, but on the non-stream create() path (doCreate at
      // openaiClient.ts) — the gate lives in both doCreate and doStream.
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => CHAT_COMPLETION_RESPONSE });

      const client = new OpenAIClient({
        baseURL: 'https://gateway.example.com/v1',
        apiKey: 'fake-test',
        providerType: 'other',
        suppressReasoningEffort: true,
      });

      await client.create({ ...BASE_PARAMS, effort: 'high' });

      const [url, opts] = mockFetch.mock.calls[0] as [string, { body: string }];
      const body = JSON.parse(opts.body) as Record<string, unknown>;
      expect(url).toContain('/chat/completions');
      expect(body.stream).toBe(false);
      expect(body).not.toHaveProperty('reasoning_effort');
    });

    it('still sends reasoning_effort when suppression is not set (gate is conditional)', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, body: makeDoneStream() });
      const client = new OpenAIClient({
        baseURL: 'https://gateway.example.com/v1',
        apiKey: 'fake-test',
        providerType: 'other',
      });
      await client.stream({ ...BASE_PARAMS, effort: 'high' }, () => {});
      const [, opts] = mockFetch.mock.calls[0] as [string, { body: string }];
      const body = JSON.parse(opts.body) as Record<string, unknown>;
      expect(body.reasoning_effort).toBe('high');
    });

    it('still sends reasoning_effort on the non-stream create() path when not suppressed', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => CHAT_COMPLETION_RESPONSE });
      const client = new OpenAIClient({
        baseURL: 'https://gateway.example.com/v1',
        apiKey: 'fake-test',
        providerType: 'other',
      });
      await client.create({ ...BASE_PARAMS, effort: 'high' });
      const [, opts] = mockFetch.mock.calls[0] as [string, { body: string }];
      const body = JSON.parse(opts.body) as Record<string, unknown>;
      expect(body.reasoning_effort).toBe('high');
    });

    it('uses Codex Responses API passthrough when codexMode is set with reasoning_effort and tools', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, body: makeDoneStream() });

      const client = new OpenAIClient({
        baseURL: 'https://api.openai.com/v1',
        apiKey: 'unused',
        codexMode: makeCodexMode(),
      });

      const tools = [
        {
          name: 'Read',
          description: 'Read a file',
          input_schema: {
            type: 'object' as const,
            properties: { path: { type: 'string' } },
          },
        },
      ];

      await client.stream({ ...BASE_PARAMS, tools, effort: 'high' }, () => {});

      const [url, opts] = mockFetch.mock.calls[0] as [string, { body: string }];
      const body = JSON.parse(opts.body) as Record<string, unknown>;
      expect(url).toBe(CODEX_ENDPOINT);
      expect(body.stream).toBe(true);
      expect(body.reasoning_effort).toBe('high');
      expect(body.tools).toEqual([
        {
          type: 'function',
          function: {
            name: 'Read',
            description: 'Read a file',
            parameters: {
              type: 'object',
              properties: { path: { type: 'string' } },
            },
          },
        },
      ]);
    });
  });

  describe('AbortSignal handling', () => {
    it('passes signal to fetch', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => CHAT_COMPLETION_RESPONSE,
      });

      const controller = new AbortController();
      const client = new OpenAIClient({
        baseURL: 'https://api.openai.com/v1',
        apiKey: 'fake-test',
      });

      await client.create({ ...BASE_PARAMS, signal: controller.signal });

      const [, opts] = mockFetch.mock.calls[0];
      expect(opts.signal).toBe(controller.signal);
    });

    it('classifies abort errors', async () => {
      const controller = new AbortController();
      controller.abort();

      mockFetch.mockRejectedValueOnce(new DOMException('Aborted', 'AbortError'));

      const client = new OpenAIClient({
        baseURL: 'https://api.openai.com/v1',
        apiKey: 'fake-test',
        provider: 'OpenAI',
      });

      try {
        await client.create({ ...BASE_PARAMS, signal: controller.signal });
        expect.unreachable('should throw');
      } catch (e) {
        expect(e).toBeInstanceOf(ModelError);
        expect((e as ModelError).kind).toBe('abort');
        expect((e as ModelError).isAbort).toBe(true);
      }
    });

    it('keeps caller-triggered stream aborts classified as abort', async () => {
      vi.useFakeTimers();
      try {
        const controller = new AbortController();

        mockFetch.mockImplementation((_url: string, opts: { signal?: AbortSignal }) => {
          const signal = opts.signal;
          return new Promise((_, reject) => {
            if (!signal) {
              reject(new Error('missing signal'));
              return;
            }
            if (signal.aborted) {
              reject(new DOMException('Aborted', 'AbortError'));
              return;
            }
            signal.addEventListener(
              'abort',
              () => {
                reject(new DOMException('Aborted', 'AbortError'));
              },
              { once: true },
            );
          });
        });

        const client = new OpenAIClient({
          baseURL: 'https://api.openai.com/v1',
          apiKey: 'fake-test',
          provider: 'OpenAI',
        });

        const promise = client
          .stream({ ...BASE_PARAMS, signal: controller.signal }, () => {})
          .catch((e: unknown) => e);

        controller.abort();
        await vi.runOnlyPendingTimersAsync();

        const err = await promise;
        expect(err).toBeInstanceOf(ModelError);
        expect((err as ModelError).kind).toBe('abort');
        expect((err as ModelError).isAbort).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('streaming error classification', () => {
    function makeErrorStream(errorPayload: Record<string, unknown>): ReadableStream<Uint8Array> {
      const encoder = new TextEncoder();
      const sseData = `data: ${JSON.stringify(errorPayload)}\n\n`;
      return new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(sseData));
          controller.close();
        },
      });
    }

    it('classifies streaming error with code rate_limit_exceeded as rate_limit', async () => {
      vi.useFakeTimers();
      vi.spyOn(Math, 'random').mockReturnValue(0);

      mockFetch.mockImplementation(async () => ({
        ok: true,
        body: makeErrorStream({
          error: { code: 'rate_limit_exceeded', message: 'Rate limit' },
        }),
      }));

      const client = new OpenAIClient({
        baseURL: 'https://api.openai.com/v1',
        apiKey: 'fake-test',
        provider: 'OpenAI',
      });

      // Attach .catch immediately to prevent unhandled rejection warnings during timer advancement
      const promise = client.stream(BASE_PARAMS, () => {}).catch((e: unknown) => e);

      // Advance through all retry delays (3 retries: 1s, 2s, 4s)
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(2_000);
      await vi.advanceTimersByTimeAsync(4_000);

      const err = await promise;
      expect(err).toBeInstanceOf(ModelError);
      expect((err as ModelError).kind).toBe('rate_limit');
      expect((err as ModelError).provider).toBe('OpenAI');

      vi.useRealTimers();
    });

    it('classifies streaming error with code insufficient_quota as billing', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: makeErrorStream({
          error: { code: 'insufficient_quota', message: 'Quota exceeded' },
        }),
      });

      const client = new OpenAIClient({
        baseURL: 'https://api.openai.com/v1',
        apiKey: 'fake-test',
        provider: 'OpenAI',
      });

      try {
        await client.stream(BASE_PARAMS, () => {});
        expect.unreachable('should throw');
      } catch (e) {
        expect(e).toBeInstanceOf(ModelError);
        const err = e as ModelError;
        expect(err.kind).toBe('billing');
        expect(err.isTransient).toBe(false);
        expect(err.provider).toBe('OpenAI');
      }
    });

    it('classifies streaming error with type insufficient_funds as billing', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: makeErrorStream({
          error: { type: 'insufficient_funds', message: 'No funds' },
        }),
      });

      const client = new OpenAIClient({
        baseURL: 'https://api.openai.com/v1',
        apiKey: 'fake-test',
        provider: 'OpenAI',
      });

      try {
        await client.stream(BASE_PARAMS, () => {});
        expect.unreachable('should throw');
      } catch (e) {
        expect(e).toBeInstanceOf(ModelError);
        const err = e as ModelError;
        expect(err.kind).toBe('billing');
        expect(err.isTransient).toBe(false);
      }
    });

    it('classifies streaming error with code invalid_prompt as invalid_request', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: makeErrorStream({
          error: { code: 'invalid_prompt', message: 'Bad prompt' },
        }),
      });

      const client = new OpenAIClient({
        baseURL: 'https://api.openai.com/v1',
        apiKey: 'fake-test',
        provider: 'OpenAI',
      });

      try {
        await client.stream(BASE_PARAMS, () => {});
        expect.unreachable('should throw');
      } catch (e) {
        expect(e).toBeInstanceOf(ModelError);
        expect((e as ModelError).kind).toBe('invalid_request');
      }
    });

    it('classifies streaming error with no code/type as server_error (backwards-compatible)', async () => {
      vi.useFakeTimers();
      vi.spyOn(Math, 'random').mockReturnValue(0);

      mockFetch.mockImplementation(async () => ({
        ok: true,
        body: makeErrorStream({ error: { message: 'Something went wrong' } }),
      }));

      const client = new OpenAIClient({
        baseURL: 'https://api.openai.com/v1',
        apiKey: 'fake-test',
        provider: 'OpenAI',
      });

      const promise = client.stream(BASE_PARAMS, () => {}).catch((e: unknown) => e);

      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(2_000);
      await vi.advanceTimersByTimeAsync(4_000);

      const err = await promise;
      expect(err).toBeInstanceOf(ModelError);
      expect((err as ModelError).kind).toBe('server_error');
      expect((err as ModelError).message).toBe('Something went wrong');

      vi.useRealTimers();
    });

    it('classifies streaming error with explicit server_error code as server_error', async () => {
      vi.useFakeTimers();
      vi.spyOn(Math, 'random').mockReturnValue(0);

      mockFetch.mockImplementation(async () => ({
        ok: true,
        body: makeErrorStream({
          error: { code: 'server_error', message: 'Internal error' },
        }),
      }));

      const client = new OpenAIClient({
        baseURL: 'https://api.openai.com/v1',
        apiKey: 'fake-test',
        provider: 'OpenAI',
      });

      const promise = client.stream(BASE_PARAMS, () => {}).catch((e: unknown) => e);

      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(2_000);
      await vi.advanceTimersByTimeAsync(4_000);

      const err = await promise;
      expect(err).toBeInstanceOf(ModelError);
      expect((err as ModelError).kind).toBe('server_error');
      expect((err as ModelError).message).toBe('Internal error');

      vi.useRealTimers();
    });
  });

  describe('provider name in errors', () => {
    it('includes provider name in HTTP errors', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => JSON.stringify({ error: { message: 'Unauthorized' } }),
      });

      const client = new OpenAIClient({
        baseURL: 'https://api.cerebras.ai/v1',
        apiKey: 'fake-bad',
        provider: 'Cerebras',
      });

      try {
        await client.create(BASE_PARAMS);
        expect.unreachable('should throw');
      } catch (e) {
        const err = e as ModelError;
        expect(err.provider).toBe('Cerebras');
      }
    });
  });

  describe('onStreamActivity callback', () => {
    it('fires onStreamActivity per chunk during chat completions streaming', async () => {
      const sseData = [
        'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"gpt-5.5","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}\n\n',
        'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"gpt-5.5","choices":[{"index":0,"delta":{"content":" world"},"finish_reason":null}]}\n\n',
        'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"gpt-5.5","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\n',
        'data: [DONE]\n\n',
      ];

      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          for (const chunk of sseData) {
            controller.enqueue(encoder.encode(chunk));
          }
          controller.close();
        },
      });

      mockFetch.mockResolvedValueOnce({ ok: true, body: stream });

      const client = new OpenAIClient({
        baseURL: 'https://api.openai.com/v1',
        apiKey: 'fake-test',
      });

      const activityCalls: RuntimeActivityEvent[] = [];
      const onStreamActivity = vi.fn((event: RuntimeActivityEvent) => activityCalls.push(event));

      await client.stream({ ...BASE_PARAMS, onStreamActivity }, () => {});

      // Should fire once per successfully parsed chunk (3 chunks, [DONE] is skipped)
      expect(onStreamActivity).toHaveBeenCalledTimes(3);
      expect(activityCalls).toEqual([
        {
          kind: 'token-delta',
          subkind: 'text',
          rawEventType: 'chat.completion.chunk',
        },
        {
          kind: 'token-delta',
          subkind: 'text',
          rawEventType: 'chat.completion.chunk',
        },
        {
          kind: 'lifecycle',
          subkind: 'chat-chunk-final',
          rawEventType: 'chat.completion.chunk',
        },
      ]);
    });

    it('fires onStreamActivity per event during Responses API streaming', async () => {
      const sseData = [
        'event: response.created\ndata: {"id":"r1","type":"response.created"}\n\n',
        'event: response.output_item.added\ndata: {"type":"response.output_item.added"}\n\n',
        'event: response.completed\ndata: {"type":"response.completed"}\n\n',
      ];

      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          for (const chunk of sseData) {
            controller.enqueue(encoder.encode(chunk));
          }
          controller.close();
        },
      });

      mockFetch.mockResolvedValueOnce({ ok: true, body: stream });

      const client = new OpenAIClient({
        baseURL: 'https://api.openai.com/v1',
        apiKey: 'fake-test',
        providerType: 'openai',
      });

      const activityCalls: RuntimeActivityEvent[] = [];
      const onStreamActivity = vi.fn((event: RuntimeActivityEvent) => activityCalls.push(event));

      const tools = [
        {
          name: 'Read',
          description: 'Read a file',
          input_schema: {
            type: 'object' as const,
            properties: { path: { type: 'string' } },
          },
        },
      ];

      await client.stream({ ...BASE_PARAMS, tools, effort: 'high', onStreamActivity }, () => {});

      // Should fire for each parsed SSE event
      expect(onStreamActivity).toHaveBeenCalledTimes(3);
      expect(activityCalls).toEqual([
        {
          kind: 'lifecycle',
          subkind: 'response-created',
          rawEventType: 'response.created',
        },
        {
          kind: 'lifecycle',
          subkind: 'output-item-added',
          rawEventType: 'response.output_item.added',
        },
        {
          kind: 'lifecycle',
          subkind: 'response-completed',
          rawEventType: 'response.completed',
        },
      ]);
    });

    it('swallows errors thrown by onStreamActivity callback', async () => {
      const sseData = [
        'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"gpt-5.5","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}\n\n',
        'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"gpt-5.5","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":1,"total_tokens":6}}\n\n',
        'data: [DONE]\n\n',
      ];

      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          for (const chunk of sseData) {
            controller.enqueue(encoder.encode(chunk));
          }
          controller.close();
        },
      });

      mockFetch.mockResolvedValueOnce({ ok: true, body: stream });

      const client = new OpenAIClient({
        baseURL: 'https://api.openai.com/v1',
        apiKey: 'fake-test',
      });

      const throwingCallback = vi.fn(() => {
        throw new Error('Callback exploded');
      });

      const events: Array<{ type: string; text?: string }> = [];
      const result = await client.stream({ ...BASE_PARAMS, onStreamActivity: throwingCallback }, (event) => {
        events.push(event);
      });

      // Callback was called but its errors didn't break streaming
      expect(throwingCallback).toHaveBeenCalled();
      expect(events).toEqual([{ type: 'text_delta', text: 'Hello' }]);
      expect(result.content).toEqual([{ type: 'text', text: 'Hello' }]);
      expect(result.stopReason).toBe('end_turn');
    });

    it('swallows errors thrown by onStreamActivity in Responses API path', async () => {
      const sseData = [
        'event: response.created\ndata: {"id":"r1","type":"response.created"}\n\n',
        'event: response.completed\ndata: {"type":"response.completed"}\n\n',
      ];

      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          for (const chunk of sseData) {
            controller.enqueue(encoder.encode(chunk));
          }
          controller.close();
        },
      });

      mockFetch.mockResolvedValueOnce({ ok: true, body: stream });

      const client = new OpenAIClient({
        baseURL: 'https://api.openai.com/v1',
        apiKey: 'fake-test',
        providerType: 'openai',
      });

      const throwingCallback = vi.fn(() => {
        throw new Error('Callback exploded');
      });

      const tools = [
        {
          name: 'Read',
          description: 'Read a file',
          input_schema: {
            type: 'object' as const,
            properties: { path: { type: 'string' } },
          },
        },
      ];

      // Should not throw despite the callback error
      const result = await client.stream(
        {
          ...BASE_PARAMS,
          tools,
          effort: 'high',
          onStreamActivity: throwingCallback,
        },
        () => {},
      );

      expect(throwingCallback).toHaveBeenCalled();
      expect(result).toBeDefined();
    });

    it('does not change stream output when onStreamActivity is provided', async () => {
      const sseData = [
        'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"gpt-5.5","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}\n\n',
        'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"gpt-5.5","choices":[{"index":0,"delta":{"content":" world"},"finish_reason":null}]}\n\n',
        'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"gpt-5.5","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\n',
        'data: [DONE]\n\n',
      ];

      const encoder = new TextEncoder();

      // Run with callback
      const stream1 = new ReadableStream({
        start(controller) {
          for (const chunk of sseData) controller.enqueue(encoder.encode(chunk));
          controller.close();
        },
      });
      mockFetch.mockResolvedValueOnce({ ok: true, body: stream1 });

      const client = new OpenAIClient({
        baseURL: 'https://api.openai.com/v1',
        apiKey: 'fake-test',
      });

      const eventsWithCallback: Array<{ type: string; text?: string }> = [];
      const resultWithCallback = await client.stream({ ...BASE_PARAMS, onStreamActivity: vi.fn() }, (event) => {
        eventsWithCallback.push(event);
      });

      // Run without callback
      const stream2 = new ReadableStream({
        start(controller) {
          for (const chunk of sseData) controller.enqueue(encoder.encode(chunk));
          controller.close();
        },
      });
      mockFetch.mockResolvedValueOnce({ ok: true, body: stream2 });

      const eventsWithout: Array<{ type: string; text?: string }> = [];
      const resultWithout = await client.stream(BASE_PARAMS, (event) => {
        eventsWithout.push(event);
      });

      // Both should produce identical output
      expect(eventsWithCallback).toEqual(eventsWithout);
      expect(resultWithCallback.content).toEqual(resultWithout.content);
      expect(resultWithCallback.stopReason).toEqual(resultWithout.stopReason);
      expect(resultWithCallback.usage).toEqual(resultWithout.usage);
    });
  });
});

// ── F4: Gateway tool-signature diagnostic — client/stream-level final payload ──
//
// Drives the FULL streaming path (client.stream → consumeChatCompletionStream →
// toStreamResult) for a custom-gateway (`providerType: 'other'`) Gemini-style
// tool-call response, and asserts the final `Gateway Tool Signature Observed`
// analytics payload. The key case is the F1 field-before-id ordering: a
// signature-bearing delta with NO id arrives first, then the real id arrives —
// the streaming state machine must UPGRADE the fallback-id state in place (not
// replace it), so the final event still counts the signature. Pre-F1, the real-id
// delta replaced the fallback state and dropped the accumulated flags → this test
// would observe withAnySignature:0 and fail.
describe('OpenAIClient — Gateway Tool Signature diagnostic (stream-level)', () => {
  const FAKE_SIG = 'CioKChIQ-FAKE-CLIENT-STREAM-SIGNATURE-MUST-NEVER-LEAK';

  interface CapturedTrack {
    event: string;
    props?: Record<string, unknown>;
  }

  function installCapturingTracker(): { events: CapturedTrack[] } {
    const events: CapturedTrack[] = [];
    setTracker({
      track: (event, props) => {
        events.push({ event, props });
      },
      identify: () => {},
      getAnonymousId: () => 'anon',
      isAvailable: () => true,
    });
    return { events };
  }

  const NOOP_TRACKER: Tracker = {
    track: () => {},
    identify: () => {},
    getAnonymousId: () => '',
    isAvailable: () => false,
  };

  function makeSseStream(chunks: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(`data: ${chunk}\n\n`));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
  }

  function chunk(delta: Record<string, unknown>, finishReason: string | null = null): string {
    return JSON.stringify({
      id: 'c1',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'gemini-2.5-pro',
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    });
  }

  afterEach(() => {
    setTracker(NOOP_TRACKER);
    mockFetch.mockReset();
  });

  it('counts a signature that arrives BEFORE the real id (F1 field-before-id ordering)', async () => {
    const { events } = installCapturingTracker();

    // Delta 1: opens the tool-call at index 0 with provider_specific_fields but NO id.
    // Delta 2: the real (litellm id-embedded) id arrives, plus args. Pre-F1 this
    // replaced the fallback state and dropped sawProviderSpecificFields.
    const realId = `call_abc123${LITELLM_THOUGHT_ID_DELIMITER}${FAKE_SIG}`;
    mockFetch.mockResolvedValueOnce({
      ok: true,
      body: makeSseStream([
        chunk({
          tool_calls: [
            {
              index: 0,
              type: 'function',
              function: { name: 'health_check', arguments: '' },
              provider_specific_fields: { thought_signature: FAKE_SIG },
            },
          ],
        }),
        chunk({
          tool_calls: [{ index: 0, id: realId, function: { arguments: '{}' } }],
        }),
        chunk({}, 'tool_calls'),
      ]),
    });

    const client = new OpenAIClient({
      baseURL: 'https://gateway.example.com/v1',
      apiKey: 'fake-test',
      providerType: 'other',
      provider: 'custom-gateway',
    });

    const result = await client.stream({ ...BASE_PARAMS }, () => {});

    // The tool-call must be assembled with the upgraded real id (proves F1 upgrade-in-place).
    expect(result.content).toEqual([
      { type: 'tool_use', id: realId, name: 'health_check', input: {} },
    ]);

    const observed = events.filter((e) => e.event === GATEWAY_TOOL_SIGNATURE_EVENT);
    expect(observed).toHaveLength(1);
    expect(observed[0].props).toMatchObject({
      providerType: 'other',
      provider: 'custom-gateway',
      modelId: 'gemini-2.5-pro',
      streaming: true,
      toolCallCount: 1,
      // idEmbedded derived from the FINAL assembled id (litellm `__thought__`).
      withIdEmbedded: 1,
      // Preserved across the field-before-id reorder (the F1 fix).
      withProviderSpecificFields: 1,
      withExtraContent: 0,
      withAnySignature: 1,
    });

    // The raw signature VALUE must NEVER appear in any emitted property.
    expect(JSON.stringify(observed[0].props)).not.toContain(FAKE_SIG);
  });

  it('reports withAnySignature:0 for a plain GPT-style streamed tool call (negative control)', async () => {
    const { events } = installCapturingTracker();

    mockFetch.mockResolvedValueOnce({
      ok: true,
      body: makeSseStream([
        chunk({
          tool_calls: [
            { index: 0, id: 'call_plain', type: 'function', function: { name: 'lookup', arguments: '{}' } },
          ],
        }),
        chunk({}, 'tool_calls'),
      ]),
    });

    const client = new OpenAIClient({
      baseURL: 'https://gateway.example.com/v1',
      apiKey: 'fake-test',
      providerType: 'other',
      provider: 'custom-gateway',
    });

    await client.stream({ ...BASE_PARAMS }, () => {});

    const observed = events.filter((e) => e.event === GATEWAY_TOOL_SIGNATURE_EVENT);
    expect(observed).toHaveLength(1);
    expect(observed[0].props).toMatchObject({
      toolCallCount: 1,
      withIdEmbedded: 0,
      withProviderSpecificFields: 0,
      withExtraContent: 0,
      withAnySignature: 0,
    });
  });
});
