import { describe, it, expect } from 'vitest';
import { AnthropicError, APIError, APIConnectionTimeoutError } from '@anthropic-ai/sdk';
import {
  classifyError,
  classifyHttpError,
  classifyStatus,
  ModelError,
  parseOutputCapFrom400,
  reclassifyOrRethrow,
} from '../modelErrors';
import { classifyErrorUx } from '@rebel/shared';
import { humanizeError } from '@shared/utils/friendlyErrors';
import { CodexDisconnectedBtsError } from '@core/services/behindTheScenesClient';
import { ConnectionNotConfiguredError, UnsupportedModelError } from '@shared/utils/connectionCredentials';

describe('reclassifyOrRethrow', () => {
  it('rethrows an abort ModelError unchanged before catalog-kind inspection', () => {
    const existing = new ModelError('abort', 'user cancelled');

    try {
      reclassifyOrRethrow(existing, 'auth', 'fallback auth');
      throw new Error('Expected reclassifyOrRethrow to throw');
    } catch (caught) {
      expect(caught).toBe(existing);
      expect(caught).toMatchObject({ kind: 'abort', __agentErrorKind: 'unknown' });
    }
  });

  it('rethrows connection and unsupported-model branded errors intact', () => {
    const connectionError = new ConnectionNotConfiguredError('Reconnect OpenAI', 'OpenAI');
    const unsupportedError = new UnsupportedModelError('Unsupported model', 'gpt-9', 'OpenAI');

    for (const existing of [connectionError, unsupportedError]) {
      try {
        reclassifyOrRethrow(existing, 'auth', 'fallback auth');
        throw new Error('Expected reclassifyOrRethrow to throw');
      } catch (caught) {
        expect(caught).toBe(existing);
      }
    }
  });

  it('rethrows routing-branded plain Errors intact', () => {
    const routingError = Object.assign(
      new Error('Route plan is terminal'),
      { __agentErrorKind: 'routing' as const, __routingCause: 'proxy-dialect-in-direct-anthropic' },
    );

    try {
      reclassifyOrRethrow(routingError, 'auth', 'fallback auth');
      throw new Error('Expected reclassifyOrRethrow to throw');
    } catch (caught) {
      expect(caught).toBe(routingError);
      expect(caught).toMatchObject({
        __agentErrorKind: 'routing',
        __routingCause: 'proxy-dialect-in-direct-anthropic',
      });
    }
  });

  it('wraps unclassified Errors with the fallback ModelError kind', () => {
    const plainError = new Error('plain failure');

    try {
      reclassifyOrRethrow(plainError, 'server_error', undefined, 503, 'TestProvider');
      throw new Error('Expected reclassifyOrRethrow to throw');
    } catch (caught) {
      expect(caught).toBeInstanceOf(ModelError);
      expect(caught).toMatchObject({
        kind: 'server_error',
        message: 'plain failure',
        status: 503,
        provider: 'TestProvider',
      });
    }
  });
});

describe('classifyError', () => {
  it('should return existing ModelError as-is', () => {
    const existing = new ModelError('rate_limit', 'test');
    expect(classifyError(existing)).toBe(existing);
  });

  it('should keep CodexDisconnectedBtsError as model_unavailable', () => {
    const error = new CodexDisconnectedBtsError();
    const result = classifyError(error);
    expect(result).toBe(error);
    expect(result.kind).toBe('model_unavailable');
    expect(result.isTransient).toBe(false);
  });

  it('should classify AbortError', () => {
    const error = new Error('aborted');
    error.name = 'AbortError';
    const result = classifyError(error);
    expect(result.kind).toBe('abort');
    expect(result.isAbort).toBe(true);
  });

  it('should classify aborted signal', () => {
    const ac = new AbortController();
    ac.abort();
    const error = new Error('something');
    const result = classifyError(error, ac.signal);
    expect(result.kind).toBe('abort');
  });

  describe('SDK stream-lifecycle errors (AnthropicError, not APIError)', () => {
    it('should classify "request ended without sending any chunks" as transient server_error', () => {
      const error = new AnthropicError('request ended without sending any chunks');
      const result = classifyError(error);
      expect(result.kind).toBe('server_error');
      expect(result.isTransient).toBe(true);
    });

    it('should classify "stream ended without producing a Message" as transient server_error', () => {
      const error = new AnthropicError('stream ended without producing a Message with role=assistant');
      const result = classifyError(error);
      expect(result.kind).toBe('server_error');
      expect(result.isTransient).toBe(true);
    });

    it('should classify "stream has ended" as transient server_error', () => {
      const error = new AnthropicError("stream has ended, this shouldn't happen");
      const result = classifyError(error);
      expect(result.kind).toBe('server_error');
      expect(result.isTransient).toBe(true);
    });

    it('should classify "stream ended without producing a content block" as transient server_error', () => {
      const error = new AnthropicError('stream ended without producing a content block with type=text');
      const result = classifyError(error);
      expect(result.kind).toBe('server_error');
      expect(result.isTransient).toBe(true);
    });

    it('should NOT classify APIError subclass as stream-lifecycle error', () => {
      // APIError extends AnthropicError, so the instanceof check order matters.
      // APIError should go through classifyStatus, not the stream-lifecycle path.
      const error = new APIError(401, undefined as any, 'Unauthorized', undefined);
      const result = classifyError(error);
      expect(result.kind).toBe('auth');
    });

    // Surfaced live (Stage 7 tests/live-api/anthropicDirect 404 arm, 2026-06-06):
    // the AnthropicClient throws an SDK APIError whose parsed body type is
    // `not_found_error` for an unknown model, with a "model: <id>" message that
    // matches no message-substring pattern. classifyError must thread the parsed
    // body `type` into classifyStatus so this classifies as model_unavailable
    // (→ Opus fallback, 260401/260417), not `unknown`.
    it('classifies SDK APIError 404 not_found_error as model_unavailable (Anthropic unknown model)', () => {
      const error = new APIError(
        404,
        { type: 'error', error: { type: 'not_found_error', message: 'model: claude-does-not-exist-9' } } as any,
        'model: claude-does-not-exist-9',
        undefined,
      );
      const result = classifyError(error);
      expect(result.kind).toBe('model_unavailable');
      expect(result.status).toBe(404);
    });

    // WS4 turn-hang fix: the Anthropic SDK governs the executor->localhost-proxy
    // hop. A connection timeout there throws APIConnectionTimeoutError (a subclass
    // of APIError with status=undefined and message 'Request timed out.'). It must
    // classify as a TRANSIENT server_error so recovery retries; before the fix it
    // fell through classifyStatus -> `unknown` (isTransientError didn't match the
    // bare 'timed out' wording) -> NON-retryable dead-end (the turn hung).
    it('classifies SDK APIConnectionTimeoutError as transient server_error (turn-hang fix)', () => {
      const error = new APIConnectionTimeoutError();
      expect(error.message.toLowerCase()).toContain('timed out');
      expect(error.status).toBeUndefined();
      const result = classifyError(error);
      expect(result.kind).toBe('server_error');
      expect(result.isTransient).toBe(true);
    });

    it('classifies an APIError-shaped connection timeout (custom message) as transient server_error', () => {
      const error = new APIConnectionTimeoutError({ message: 'Request timed out.' });
      const result = classifyError(error);
      expect(result.kind).toBe('server_error');
      expect(result.isTransient).toBe(true);
    });
  });

  describe('generic Error with transient message', () => {
    it('should classify unknown errors as unknown', () => {
      const result = classifyError(new Error('something unexpected'));
      expect(result.kind).toBe('unknown');
      expect(result.isTransient).toBe(false);
    });

    it('should classify OpenAI Responses API "terminated" as transient server_error', () => {
      const result = classifyError(new Error('terminated'), undefined, 'OpenAI (Codex)');
      expect(result.kind).toBe('server_error');
      expect(result.isTransient).toBe(true);
      expect(result.provider).toBe('OpenAI (Codex)');
    });
  });

  describe('lossy-collapse guard for network transport classification', () => {
    const recognizedNetworkSignals = [
      'ETIMEDOUT',
      'ECONNRESET',
      'ECONNREFUSED',
      'ENOTFOUND',
      'EAI_AGAIN',
      'ENETUNREACH',
      'EHOSTUNREACH',
      'EPIPE',
      'UND_ERR_SOCKET',
      'UND_ERR_CONNECT_TIMEOUT',
      'ConnectTimeoutError',
      'Connect Timeout Error',
      'socket hang up',
      'network error',
      'connection error.',
      'fetch failed',
      'TypeError: fetch failed',
    ] as const;

    // Re-collapsing a transport errno/signal into server_error or unknown must
    // fail this table: transport failures are local-network conditions, not
    // provider failures.
    it.each(recognizedNetworkSignals)('mints network for top-level transport signal: %s', (signal) => {
      const result = classifyError(new Error(signal));

      expect(result.kind).toBe('network');
      expect(result.__agentErrorKind).toBe('network');
      expect(result.isTransient).toBe(true);
    });

    it.each(recognizedNetworkSignals)('mints network for cause.code transport signal: %s', (signal) => {
      const error = Object.assign(new Error('request failed'), {
        cause: { code: signal },
      });

      const result = classifyError(error);

      expect(result.kind).toBe('network');
      expect(result.__agentErrorKind).toBe('network');
      expect(result.isTransient).toBe(true);
    });

    it('mints network for bare REBEL-6B6 ConnectTimeoutError / UND_ERR_CONNECT_TIMEOUT shapes', () => {
      expect(classifyError(Object.assign(new Error('Connect Timeout Error'), {
        name: 'ConnectTimeoutError',
      })).kind).toBe('network');
      expect(classifyError(Object.assign(new Error('request failed'), {
        code: 'UND_ERR_CONNECT_TIMEOUT',
      })).kind).toBe('network');
      expect(classifyError(Object.assign(new Error('request failed'), {
        cause: { code: 'UND_ERR_CONNECT_TIMEOUT' },
      })).kind).toBe('network');
    });

    it('keeps bare timeout unclassified', () => {
      const result = classifyError(new Error('timeout'));

      expect(result.kind).toBe('unknown');
      expect(result.isTransient).toBe(false);
    });

    it('keeps genuine provider server failures classified as server_error', () => {
      expect(classifyHttpError(503, 'Service Unavailable').kind).toBe('server_error');
      expect(classifyHttpError(503, 'TypeError: fetch failed').kind).toBe('server_error');
      expect(classifyError(new Error('internal server error')).kind).toBe('server_error');
      expect(classifyError(new Error('Error type: api_error')).kind).toBe('server_error');
      expect(classifyError(
        new APIError(500, undefined as any, 'TypeError: fetch failed', undefined),
      ).kind).toBe('server_error');
      expect(classifyStatus(undefined as unknown as number, 'upstream api_error', { type: 'api_error' }).kind).toBe('unknown');
    });

    it('keeps AbortError classified as abort', () => {
      const error = new Error('fetch failed');
      error.name = 'AbortError';

      expect(classifyError(error).kind).toBe('abort');
    });

    it('uses static network copy without leaking host, IP, or errno details', () => {
      const raw =
        'TypeError: fetch failed caused by ConnectTimeoutError UND_ERR_CONNECT_TIMEOUT chatgpt.com 2606:4700::1';
      const legacyCopy = humanizeError(raw, { errorKind: 'network' });
      const resolution = classifyErrorUx({ errorKind: 'network', rawMessage: raw });
      const rendered = [
        legacyCopy,
        resolution.title,
        resolution.body,
        ...resolution.alternatives.map((action) => action.label),
      ].join(' ');

      expect(resolution.category).toBe('transient');
      expect(resolution.defaultAction).toMatchObject({ label: 'Try again', action: 'retry' });
      expect(resolution.alternatives[1]).toMatchObject({
        label: 'Check connections',
        action: 'open-settings',
        payload: { settingsSection: 'diagnose' },
        variant: 'secondary',
      });
      expect(rendered).toContain("Can't reach the AI service.");
      expect(rendered).not.toContain('2606:4700::1');
      expect(rendered).not.toContain('chatgpt.com');
      expect(rendered).not.toContain('UND_ERR_CONNECT_TIMEOUT');
    });
  });

  it('should classify non-Error values', () => {
    const result = classifyError('a string error');
    expect(result.kind).toBe('unknown');
    expect(result.message).toBe('a string error');
  });

  it('classifies APIError(400) with billing message as billing', () => {
    const error = new APIError(
      400,
      undefined as any,
      'Your credit balance is too low to access the Anthropic API',
      undefined,
    );
    const result = classifyError(error);
    expect(result.kind).toBe('billing');
    expect(result.isTransient).toBe(false);
    expect(result.status).toBe(400);
    expect(result.__agentErrorKind).toBe('billing');
  });

  it('classifies APIError(429) + billing message as billing (Anthropic SDK path)', () => {
    const error = new APIError(
      429,
      undefined as any,
      'Key limit exceeded (daily limit). Manage it using https://openrouter.ai/settings/keys',
      undefined,
    );
    const result = classifyError(error);
    expect(result.kind).toBe('billing');
    expect(result.isTransient).toBe(false);
    expect(result.status).toBe(429);
  });

  it('keeps APIError(429) + non-billing message as rate_limit (regression)', () => {
    const error = new APIError(
      429,
      undefined as any,
      'Too many requests, please try again later.',
      undefined,
    );
    const result = classifyError(error);
    expect(result.kind).toBe('rate_limit');
    expect(result.isTransient).toBe(true);
  });

  // REBEL-4GH / FOX-3152: `usage_limit_reached` (Codex Team-plan cap) was
  // previously treated as a transient rate-limit and auto-retried/auto-fell-
  // back to OpenRouter, compounding the quota burn. The SDK path now extracts
  // `type`/`code` from the parsed body and reclassifies to `billing`.
  it('classifies APIError(429) + usage_limit_reached in parsed body as billing with resetAtMs (SDK path)', () => {
    const resetsAt = Math.floor(Date.now() / 1000) + 3600;
    // The Anthropic SDK stores the parsed JSON body in `error.error`
    const error = new APIError(
      429,
      { error: { type: 'usage_limit_reached', message: 'The usage limit has been reached', resets_at: resetsAt } } as any,
      'The usage limit has been reached',
      undefined,
    );
    const result = classifyError(error, undefined, 'Codex');
    expect(result.kind).toBe('billing');
    expect(result.isTransient).toBe(false);
    expect(result.resetAtMs).toBe(resetsAt * 1000);
    expect(result.limitScope).toBeUndefined();
  });

  it('classifies APIError(429) + Codex-proxy-rewritten body (rate_limit_error + code:usage_limit_reached) as billing', () => {
    // Mirrors the shape that localModelProxyServer.ts emits when it rewrites
    // an upstream Codex 429: the top-level type is the Anthropic-SDK-compatible
    // `rate_limit_error`, but the upstream quota signal is preserved as `code`.
    const resetsAt = Math.floor(Date.now() / 1000) + 7200;
    const error = new APIError(
      429,
      {
        error: {
          type: 'rate_limit_error',
          code: 'usage_limit_reached',
          message: 'Codex passthrough failed: ...',
          resets_at: resetsAt,
        },
      } as any,
      'Codex passthrough failed',
      undefined,
    );
    const result = classifyError(error, undefined, 'Codex');
    expect(result.kind).toBe('billing');
    expect(result.resetAtMs).toBe(resetsAt * 1000);
    expect(result.limitScope).toBeUndefined();
  });

  it('classifies SDK APIError(403) by parsed code before the 403 billing fallback', () => {
    const error = new APIError(
      403,
      { error: { code: 'invalid_api_key', message: 'Provider rejected the request' } } as any,
      'Provider rejected the request',
      undefined,
    );
    const result = classifyError(error, undefined, 'OpenRouter');
    expect(result.kind).toBe('auth');
    expect(result.isTransient).toBe(false);
  });

  it('extracts resetAtMs from APIError(429) billing-classified error with resets_in_seconds', () => {
    const before = Date.now();
    const error = new APIError(
      429,
      { error: { type: 'usage_limit_reached', message: 'Rate limited', resets_in_seconds: 1800 } } as any,
      'Rate limited',
      undefined,
    );
    const result = classifyError(error, undefined, 'Codex');
    const after = Date.now();
    expect(result.kind).toBe('billing');
    expect(result.resetAtMs).toBeGreaterThanOrEqual(before + 1800 * 1000);
    expect(result.resetAtMs).toBeLessThanOrEqual(after + 1800 * 1000);
  });

  it('extracts resetAtMs from APIError(429) insufficient_quota billing error (so UI can show reset time)', () => {
    // Previously the SDK path dropped resetAtMs for billing-classified 429s.
    // We now extract it for both rate_limit and billing — the reset time is
    // useful UI context regardless of the classification.
    const resetsAt = Math.floor(Date.now() / 1000) + 3600;
    const error = new APIError(
      429,
      { error: { type: 'insufficient_quota', message: 'Quota exceeded', resets_at: resetsAt } } as any,
      'Quota exceeded',
      undefined,
    );
    const result = classifyError(error, undefined, 'OpenAI');
    expect(result.kind).toBe('billing');
    expect(result.resetAtMs).toBe(resetsAt * 1000);
  });

  it('still classifies APIError(429) + plain rate_limit_error (no quota signal) as rate_limit', () => {
    // Regression guard: structural change must NOT flip generic transient 429s.
    const error = new APIError(
      429,
      { error: { type: 'rate_limit_error', message: 'Too many requests' } } as any,
      'Too many requests',
      undefined,
    );
    const result = classifyError(error, undefined, 'Anthropic');
    expect(result.kind).toBe('rate_limit');
    expect(result.isTransient).toBe(true);
  });

  it('attaches details.outputCap for APIError(400) max_tokens cap errors', () => {
    const error = new APIError(
      400,
      undefined as any,
      'max_tokens: 1000000 > maximum allowed value 8192',
      undefined,
    );
    const result = classifyError(error);
    expect(result.kind).toBe('invalid_request');
    expect(result.details?.outputCap).toBe(8192);
  });

  // REBEL-5M4 / REBEL-561 / REBEL-52P: the SDK path must consume the parsed
  // nested body's `type` (symmetric with the HTTP path), not just the message
  // string. A local-proxy SSE `error` frame surfaces as an APIError with
  // status `undefined` and a `stream_error` body type; today it falls through
  // to `unknown` (the JSON-envelope message defeats isTransientError's
  // exact-match guards) and gets ZERO retries. And a 404 `not_found_error`
  // body misses `model_unavailable` (losing configured-role auto-fallback).
  describe('SDK path consumes parsed-body type (REBEL-5M4/561/52P)', () => {
    it('classifies a stream_error SSE frame (status undefined) as retryable server_error', () => {
      const body = { type: 'error', error: { type: 'stream_error', message: 'terminated' } };
      const error = new APIError(undefined, body as any, JSON.stringify(body), undefined);
      const result = classifyError(error, undefined, 'Codex');
      expect(result.kind).toBe('server_error');
      expect(result.isTransient).toBe(true);
    });

    it('classifies a 404 not_found_error body as model_unavailable', () => {
      const body = { type: 'error', error: { type: 'not_found_error', message: 'model: foo-bar' } };
      const error = new APIError(404, body as any, JSON.stringify(body), undefined);
      const result = classifyError(error);
      expect(result.kind).toBe('model_unavailable');
    });

    // Negative guard (retry-storm): the new body-`type` path promotes ONLY the
    // two handled types. Asserted at the pure classifyStatus level to isolate
    // the type path from the SDK's message-envelope quirk (the SDK forces
    // error.message to the JSON body, whose literal "api_error" independently
    // trips the pre-existing isTransientError substring path — a separate,
    // pre-existing behaviour, not this change). An unhandled `api_error` type
    // must fall through to status/message logic, NOT be promoted by type.
    it('classifyStatus does NOT promote an unhandled body type (api_error) by type', () => {
      expect(classifyStatus(undefined as unknown as number, 'policy refusal', { type: 'api_error' }).kind).toBe('unknown');
      // And the two handled types ARE recognised at the classifyStatus level:
      expect(classifyStatus(undefined as unknown as number, 'x', { type: 'stream_error' }).kind).toBe('server_error');
      expect(classifyStatus(404, 'x', { type: 'not_found_error' }).kind).toBe('model_unavailable');
    });

    // Scope lock: `stream_error` is promoted to server_error ONLY for the
    // absent-status SSE shape. A concrete HTTP status must NOT be overridden by
    // the type (guards against an external provider using that type in a 4xx).
    it('classifyStatus does NOT let stream_error type override a concrete status', () => {
      expect(classifyStatus(400, 'bad', { type: 'stream_error' }).kind).toBe('invalid_request');
    });
  });
});

describe('classifyHttpError', () => {
  it('classifies 429 as rate_limit', () => {
    const error = classifyHttpError(429, '{"error":{"message":"Rate limit exceeded"}}', 'OpenAI');
    expect(error.kind).toBe('rate_limit');
    expect(error.isTransient).toBe(true);
    expect(error.status).toBe(429);
    expect(error.provider).toBe('OpenAI');
    expect(error.limitScope).toBe('provider');
  });

  // gw (REBEL-5RJ): litellm→Vertex wraps the Anthropic error in a non-JSON prefix
  // (`litellm.BadRequestError: Vertex_aiException BadRequestError - b'{...}'…`), so the
  // top-level JSON.parse fails. We must still recover the clean inner provider message
  // and NOT surface the litellm/byte-repr wrapper.
  it('recovers the inner provider message from a litellm-wrapped 400 body', () => {
    const body = `litellm.BadRequestError: Vertex_aiException BadRequestError - b'{"type":"error","error":{"type":"invalid_request_error","message":"\\"thinking.type.enabled\\" is not supported for this model. Use \\"thinking.type.adaptive\\" and \\"output_config.effort\\" to control thinking behavior."},"request_id":"req_vrtx_011Cc5XAoTxapFjLMiKRDFKw"}'No fallback model group found for original model_group=claude-opus-4-8.`;
    const error = classifyHttpError(400, body, 'profile');
    expect(error.kind).toBe('invalid_request');
    expect(error.message).toContain('is not supported for this model');
    expect(error.message).toContain('thinking.type.adaptive');
    expect(error.message).not.toContain('litellm.BadRequestError');
    expect(error.message).not.toContain("b'{");
  });

  // Integration (cross-family review F2): the full chain — wrapped body →
  // classifyHttpError → the error's surfaced `.message` → classifyErrorUx banner — must
  // show the clean provider reason, never the litellm/byte-repr wrapper.
  it('surfaces the clean provider reason end-to-end (classifyHttpError → classifyErrorUx)', () => {
    const body = `litellm.BadRequestError: Vertex_aiException BadRequestError - b'{"type":"error","error":{"type":"invalid_request_error","message":"\\"thinking.type.enabled\\" is not supported for this model. Use \\"thinking.type.adaptive\\" and \\"output_config.effort\\" to control thinking behavior."},"request_id":"req_vrtx_x"}'`;
    const error = classifyHttpError(400, body, 'profile');
    expect(error.kind).toBe('invalid_request');
    const resolution = classifyErrorUx({ errorKind: 'invalid_request', rawMessage: error.message });
    expect(resolution.body).toContain('thinking.type.adaptive');
    expect(resolution.body).not.toContain('litellm.BadRequestError');
    expect(resolution.body).not.toContain("b'{");
  });

  // gw variant 2 (REBEL-5RJ, Gemini-via-gateway): the gateway routes a tool turn to
  // Vertex-Gemini and returns the native Gemini 400 wrapped in a Python bytes-repr
  // (`b'{...}'`) — a distinct wrapper from the litellm.BadRequestError prefix above.
  // The whole body is non-JSON (leading `b'`), so top-level JSON.parse fails; we must
  // still recover the clean inner provider message and never surface the `b'{` wrapper.
  it('recovers the inner provider message from a Gemini thought_signature bytes-repr 400 body', () => {
    const body = `b'{\n  "error": {\n    "code": 400,\n    "message": "Function call is missing a thought_signature in functionCall parts. Please include the thought_signature in subsequent requests.",\n    "status": "INVALID_ARGUMENT"\n  }\n}\n'`;
    const error = classifyHttpError(400, body, 'profile');
    expect(error.kind).toBe('invalid_request');
    expect(error.message).toContain('Function call is missing a thought_signature');
    expect(error.message).not.toContain("b'{");
    expect(error.message).not.toContain('INVALID_ARGUMENT');
  });

  it('classifies 401 as auth', () => {
    const error = classifyHttpError(401, '{"error":{"message":"Invalid API key"}}', 'OpenAI');
    expect(error.kind).toBe('auth');
    expect(error.isTransient).toBe(false);
    expect(error.provider).toBe('OpenAI');
  });

  it('classifies 402 as billing', () => {
    const error = classifyHttpError(402, '{"error":{"message":"Payment required"}}', 'Cerebras');
    expect(error.kind).toBe('billing');
    expect(error.provider).toBe('Cerebras');
  });

  it('classifies 403 moderation metadata as moderation', () => {
    const error = classifyHttpError(
      403,
      '{"error":{"message":"Flagged","metadata":{"reasons":["violence"],"flagged_input":"please help"}}}',
      'OpenRouter',
    );
    expect(error.kind).toBe('moderation');
    expect(error.provider).toBe('OpenRouter');
    expect(error.isTransient).toBe(false);
  });

  it('classifies 403 moderation text fallback as moderation', () => {
    const error = classifyHttpError(
      403,
      '{"error":{"message":"This model requires moderation and your input was flagged"}}',
    );
    expect(error.kind).toBe('moderation');
  });

  it('classifies 403 without moderation signals as billing', () => {
    const error = classifyHttpError(403, '{"error":{"message":"Account suspended for non-payment"}}');
    expect(error.kind).toBe('billing');
  });

  // REBEL-66J: OpenRouter returns 403 "Invalid authentication" for a
  // revoked/invalid key. Must reach the re-authenticate UX, not the billing
  // banner. The 403 default used to bucket it as billing.
  it('classifies 403 "Invalid authentication" as auth (REBEL-66J)', () => {
    const error = classifyHttpError(403, '{"error":{"message":"Invalid authentication"}}', 'OpenRouter');
    expect(error.kind).toBe('auth');
    expect(error.isTransient).toBe(false);
    expect(error.provider).toBe('OpenRouter');
  });

  it('classifies 403 "No auth credentials found" as auth (REBEL-66J)', () => {
    const error = classifyHttpError(403, '{"error":{"message":"No auth credentials found"}}', 'OpenRouter');
    expect(error.kind).toBe('auth');
  });

  // REBEL-65G: OpenAI/Codex 403 carrying an auth marker → auth, not billing.
  it('classifies 403 "Invalid API key" as auth (REBEL-65G)', () => {
    const error = classifyHttpError(403, '{"error":{"message":"Invalid API key provided"}}', 'OpenAI');
    expect(error.kind).toBe('auth');
  });

  // Guard: a genuine billing-403 with no auth marker stays billing.
  it('keeps insufficient-credits 403 as billing (auth carve-out guard)', () => {
    const error = classifyHttpError(403, '{"error":{"message":"You have insufficient credits to continue"}}');
    expect(error.kind).toBe('billing');
  });

  it('classifies 500 as server_error', () => {
    const error = classifyHttpError(500, 'Internal Server Error', 'Together');
    expect(error.kind).toBe('server_error');
    expect(error.isTransient).toBe(true);
    expect(error.provider).toBe('Together');
  });

  it('classifies 400 as invalid_request', () => {
    const error = classifyHttpError(400, '{"error":{"message":"Invalid model name"}}');
    expect(error.kind).toBe('invalid_request');
    expect(error.isTransient).toBe(false);
  });

  it('attaches details.outputCap for Anthropic-style max_tokens cap errors', () => {
    const error = classifyHttpError(
      400,
      '{"error":{"message":"max_tokens: 1000000 > maximum allowed value 8192"}}',
      'Anthropic',
    );
    expect(error.kind).toBe('invalid_request');
    expect(error.details?.outputCap).toBe(8192);
  });

  it('attaches details.outputCap for OpenAI-style max_tokens cap errors', () => {
    const error = classifyHttpError(
      400,
      '{"error":{"message":"max_tokens is too large: 20000. This model supports at most 4096 completion tokens."}}',
      'OpenAI',
    );
    expect(error.kind).toBe('invalid_request');
    expect(error.details?.outputCap).toBe(4096);
  });

  it('attaches details.outputCap for OpenRouter passthrough envelope variants', () => {
    const error = classifyHttpError(
      400,
      '{"error":{"message":"Provider returned error","metadata":{"provider_name":"anthropic","raw":"{\\"error\\":{\\"message\\":\\"max_tokens: 50000 > maximum allowed value 8192\\"}}"}}',
      'OpenRouter',
    );
    expect(error.kind).toBe('invalid_request');
    expect(error.details?.outputCap).toBe(8192);
  });

  it('classifies 400 with context overflow message as context_overflow', () => {
    const error = classifyHttpError(
      400,
      '{"error":{"message":"This model\'s maximum context length is 128000 tokens. However, your messages resulted in 200000 tokens."}}',
    );
    expect(error.kind).toBe('context_overflow');
  });

  it('extracts nested error message from JSON body', () => {
    const error = classifyHttpError(500, '{"error":{"message":"Server overloaded"}}');
    expect(error.message).toBe('Server overloaded');
  });

  it('uses raw body when JSON parsing fails', () => {
    const error = classifyHttpError(500, 'plain text error');
    expect(error.message).toBe('plain text error');
  });

  it('preserves the raw HTTP body on __rawMessage', () => {
    const body = '{"error":{"message":"Server overloaded"}}';
    const error = classifyHttpError(500, body);
    expect(error.__rawMessage).toBe(body);
  });

  it('extracts upstream provider_name metadata', () => {
    const error = classifyHttpError(
      402,
      '{"error":{"message":"Payment required","metadata":{"provider_name":"anthropic"}}}',
      'OpenRouter',
    );
    expect(error.upstreamProvider).toBe('anthropic');
  });

  it('preserves provider name through ModelError', () => {
    const error = classifyHttpError(429, '{"error":{"message":"slow down"}}', 'Google Gemini');
    expect(error).toBeInstanceOf(ModelError);
    expect(error.provider).toBe('Google Gemini');
  });

  it('works without provider (defaults to undefined)', () => {
    const error = classifyHttpError(500, 'error');
    expect(error.provider).toBeUndefined();
  });

  describe('429 quota detection (billing vs rate_limit)', () => {
    it('classifies 429 + nested insufficient_quota as billing', () => {
      const body = JSON.stringify({
        error: {
          type: 'insufficient_quota',
          code: 'insufficient_quota',
          message: 'You exceeded your current quota, please check your plan and billing details.',
        },
      });
      const error = classifyHttpError(429, body, 'OpenAI');
      expect(error.kind).toBe('billing');
      expect(error.isTransient).toBe(false);
      expect(error.status).toBe(429);
      expect(error.provider).toBe('OpenAI');
    });

    it('keeps 429 + rate_limit_exceeded as rate_limit (unchanged)', () => {
      const body = JSON.stringify({
        error: {
          type: 'rate_limit_exceeded',
          message: 'Rate limit exceeded. Please retry after 20s.',
        },
      });
      const error = classifyHttpError(429, body, 'OpenAI');
      expect(error.kind).toBe('rate_limit');
      expect(error.isTransient).toBe(true);
    });

    it('keeps 429 + Google Gemini "per minute" quota as rate_limit (NOT billing)', () => {
      // Stage 3 Round 1 HIGH convergent finding: bare "quota exceeded" would
      // have regressed this to billing (never-retry) via the 429→billing
      // reclassification path. The window-qualifier guard (`per minute`/
      // `per second`/`per hour`/`per day`) in isBillingMessage keeps it
      // classified as a transient rate-limit — retry-after should be honored.
      const body = JSON.stringify({
        error: {
          code: 429,
          message:
            "Quota exceeded for quota metric 'generativelanguage.googleapis.com/generate_content_requests' " +
            "and limit 'GenerateContent requests per minute' of service " +
            "'generativelanguage.googleapis.com' for your plan.",
          status: 'RESOURCE_EXHAUSTED',
        },
      });
      const error = classifyHttpError(429, body, 'Google Gemini');
      expect(error.kind).toBe('rate_limit');
      expect(error.isTransient).toBe(true);
    });

    it('classifies 429 + top-level insufficient_quota as billing', () => {
      const body = JSON.stringify({
        type: 'insufficient_quota',
        message: 'Your quota has been exceeded.',
      });
      const error = classifyHttpError(429, body);
      expect(error.kind).toBe('billing');
      expect(error.isTransient).toBe(false);
    });

    it('classifies 429 + insufficient_funds as billing', () => {
      const body = JSON.stringify({
        error: {
          type: 'insufficient_funds',
          message: 'Insufficient funds.',
        },
      });
      const error = classifyHttpError(429, body);
      expect(error.kind).toBe('billing');
      expect(error.isTransient).toBe(false);
    });

    // REBEL-4GH / FOX-3152: ChatGPT Team plan quota cap exhaustion. The 429
    // body type is `usage_limit_reached` with `plan_type` + `resets_at`. Must
    // be reclassified to billing so it skips the rate-limit retry / fallback
    // path (which would compound the burn against an already-depleted quota).
    it('classifies 429 + usage_limit_reached (Codex Team plan) as billing', () => {
      const resetsAt = Math.floor(Date.now() / 1000) + 3600;
      const body = JSON.stringify({
        error: {
          type: 'usage_limit_reached',
          message: 'The usage limit has been reached',
          plan_type: 'team',
          resets_at: resetsAt,
        },
      });
      const error = classifyHttpError(429, body);
      expect(error.kind).toBe('billing');
      expect(error.isTransient).toBe(false);
      expect(error.resetAtMs).toBe(resetsAt * 1000);
    });

    it('classifies 429 + top-level usage_limit_reached as billing', () => {
      const body = JSON.stringify({
        type: 'usage_limit_reached',
        message: 'The usage limit has been reached',
      });
      const error = classifyHttpError(429, body);
      expect(error.kind).toBe('billing');
      expect(error.isTransient).toBe(false);
    });

    it('classifies 429 + code-only usage_limit_reached as billing', () => {
      const body = JSON.stringify({
        error: {
          code: 'usage_limit_reached',
          message: 'The usage limit has been reached',
        },
      });
      const error = classifyHttpError(429, body);
      expect(error.kind).toBe('billing');
      expect(error.isTransient).toBe(false);
    });

    it('keeps 429 + non-JSON body as rate_limit (fallback)', () => {
      const error = classifyHttpError(429, 'Too Many Requests');
      expect(error.kind).toBe('rate_limit');
      expect(error.isTransient).toBe(true);
    });

    it('keeps 429 + JSON without error object as rate_limit (fallback)', () => {
      const body = JSON.stringify({ message: 'Rate limited, try again later' });
      const error = classifyHttpError(429, body);
      expect(error.kind).toBe('rate_limit');
      expect(error.isTransient).toBe(true);
    });

    it('classifies 429 + code-only insufficient_quota as billing', () => {
      const body = JSON.stringify({
        error: {
          code: 'insufficient_quota',
          message: 'Quota exceeded.',
        },
      });
      const error = classifyHttpError(429, body);
      expect(error.kind).toBe('billing');
      expect(error.isTransient).toBe(false);
    });

    it('classifies 429 + top-level code insufficient_funds as billing', () => {
      const body = JSON.stringify({
        code: 'insufficient_funds',
        message: 'No funds remaining.',
      });
      const error = classifyHttpError(429, body);
      expect(error.kind).toBe('billing');
      expect(error.isTransient).toBe(false);
    });

    it('classifies 429 + nested type/code WITHOUT message as billing', () => {
      const body = JSON.stringify({
        error: { type: 'insufficient_quota' },
      });
      const error = classifyHttpError(429, body);
      expect(error.kind).toBe('billing');
    });

    it('classifies 429 + top-level type WITHOUT message as billing', () => {
      const body = JSON.stringify({ type: 'insufficient_funds' });
      const error = classifyHttpError(429, body);
      expect(error.kind).toBe('billing');
    });

    it('classifies 429 + nested code at different level from message as billing', () => {
      const body = JSON.stringify({
        error: { code: 'insufficient_quota' },
        message: 'Some top-level message',
      });
      const error = classifyHttpError(429, body);
      expect(error.kind).toBe('billing');
    });
  });

  it('classifies 429 + "key limit exceeded" message as billing (not rate_limit)', () => {
    const body = JSON.stringify({
      error: {
        message: 'Key limit exceeded (daily limit). Manage it using https://openrouter.ai/settings/keys',
        code: 403,
      },
    });
    const error = classifyHttpError(429, body);
    expect(error.kind).toBe('billing');
    expect(error.isTransient).toBe(false);
    expect(error.limitScope).toBe('account');
  });

  it('classifies 429 + "more credits" message as billing (not rate_limit)', () => {
    const body = JSON.stringify({
      error: {
        message: 'This request requires more credits, or fewer max_tokens.',
        code: 402,
      },
    });
    const error = classifyHttpError(429, body);
    expect(error.kind).toBe('billing');
    expect(error.isTransient).toBe(false);
  });

  it('keeps 429 + non-billing message as rate_limit (regression)', () => {
    const body = JSON.stringify({
      error: { message: 'Too many requests, please try again later.' },
    });
    const error = classifyHttpError(429, body);
    expect(error.kind).toBe('rate_limit');
    expect(error.isTransient).toBe(true);
  });

  it('classifies 400 with Anthropic billing error JSON as billing', () => {
    const error = classifyHttpError(
      400,
      '{"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}',
    );
    expect(error.kind).toBe('billing');
    expect(error.isTransient).toBe(false);
    expect(error.status).toBe(400);
  });

  // REBEL-1D9: End-to-end check with real OpenAI JSON body format
  it('classifies 404 with OpenAI "not a chat model" JSON body as model_unavailable', () => {
    const error = classifyHttpError(
      404,
      '{"error":{"message":"This is not a chat model and thus not supported in the v1/chat/completions endpoint. Did you mean to use v1/completions?","type":"invalid_request_error","param":null,"code":null}}',
      'OpenAI',
    );
    expect(error).toBeInstanceOf(ModelError);
    expect(error.kind).toBe('model_unavailable');
    expect(error.status).toBe(404);
    expect(error.provider).toBe('OpenAI');
    expect(error.isTransient).toBe(false);
  });

  // Surfaced live (Stage 7 tests/live-api/anthropicDirect 404 arm, 2026-06-06):
  // the REAL Anthropic 404 body for an unknown model is
  // {"type":"error","error":{"type":"not_found_error","message":"model: <id>"}}.
  // Its message matches NONE of the message-substring patterns ("does not exist",
  // "model not found", …) so it fell through to `unknown` — but model_unavailable
  // is what drives the Opus-fallback (260401) / 404-classification (260417) paths.
  // Classify by the structured `not_found_error` type, which is robust to the
  // "model: <id>" message phrasing. See docs/postmortems 260417_rebel_1d9_404_*.
  it('classifies real Anthropic 404 not_found_error body as model_unavailable', () => {
    const error = classifyHttpError(
      404,
      '{"type":"error","error":{"type":"not_found_error","message":"model: claude-does-not-exist-9"}}',
      'Anthropic',
    );
    expect(error).toBeInstanceOf(ModelError);
    expect(error.kind).toBe('model_unavailable');
    expect(error.status).toBe(404);
  });

  describe('resetAtMs extraction from Codex 429 bodies', () => {
    it('extracts resets_at (unix seconds) from nested error object', () => {
      const resetsAt = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now
      const body = JSON.stringify({
        error: { type: 'usage_limit_reached', message: 'Rate limited', resets_at: resetsAt },
      });
      const error = classifyHttpError(429, body, 'OpenAI');
      expect(error.resetAtMs).toBe(resetsAt * 1000);
    });

    it('extracts resets_at from top-level object', () => {
      const resetsAt = Math.floor(Date.now() / 1000) + 7200;
      const body = JSON.stringify({
        type: 'usage_limit_reached',
        message: 'Rate limited',
        resets_at: resetsAt,
      });
      const error = classifyHttpError(429, body, 'OpenAI');
      expect(error.resetAtMs).toBe(resetsAt * 1000);
    });

    it('extracts resets_in_seconds when resets_at is absent', () => {
      const before = Date.now();
      const body = JSON.stringify({
        error: { type: 'usage_limit_reached', message: 'Rate limited', resets_in_seconds: 1800 },
      });
      const error = classifyHttpError(429, body, 'OpenAI');
      const after = Date.now();
      expect(error.resetAtMs).toBeGreaterThanOrEqual(before + 1800 * 1000);
      expect(error.resetAtMs).toBeLessThanOrEqual(after + 1800 * 1000);
    });

    it('prefers resets_at over resets_in_seconds', () => {
      const resetsAt = Math.floor(Date.now() / 1000) + 3600;
      const body = JSON.stringify({
        error: {
          type: 'usage_limit_reached',
          message: 'Rate limited',
          resets_at: resetsAt,
          resets_in_seconds: 999999,
        },
      });
      const error = classifyHttpError(429, body, 'OpenAI');
      expect(error.resetAtMs).toBe(resetsAt * 1000);
    });

    it('rejects resets_at outside sanity range (too small)', () => {
      const body = JSON.stringify({
        error: { type: 'usage_limit_reached', message: 'Rate limited', resets_at: 500 },
      });
      const error = classifyHttpError(429, body, 'OpenAI');
      expect(error.resetAtMs).toBeUndefined();
    });

    it('rejects resets_at outside sanity range (too large)', () => {
      const body = JSON.stringify({
        error: { type: 'usage_limit_reached', message: 'Rate limited', resets_at: 20_000_000_000 },
      });
      const error = classifyHttpError(429, body, 'OpenAI');
      expect(error.resetAtMs).toBeUndefined();
    });

    it('rejects resets_in_seconds exceeding 7 days', () => {
      const body = JSON.stringify({
        error: { type: 'usage_limit_reached', message: 'Rate limited', resets_in_seconds: 700_000 },
      });
      const error = classifyHttpError(429, body, 'OpenAI');
      expect(error.resetAtMs).toBeUndefined();
    });

    it('returns undefined resetAtMs when neither field is present', () => {
      const body = JSON.stringify({ error: { type: 'rate_limit_error', message: 'Rate limited' } });
      const error = classifyHttpError(429, body, 'OpenAI');
      expect(error.resetAtMs).toBeUndefined();
    });

    it('returns undefined resetAtMs for non-JSON body', () => {
      const error = classifyHttpError(429, 'Too Many Requests', 'OpenAI');
      expect(error.resetAtMs).toBeUndefined();
    });
  });
});

describe('classifyStatus', () => {
  it('classifies 404 model access/nonexistence messages as model_unavailable', () => {
    const result = classifyStatus(
      404,
      'The model claude-opus-4-7 does not exist or you do not have access to it.',
    );
    expect(result).toEqual({ kind: 'model_unavailable' });
  });

  it('classifies 413 as context_overflow regardless of message', () => {
    expect(classifyStatus(413, 'Request Entity Too Large')).toEqual({ kind: 'context_overflow' });
    expect(classifyStatus(413, 'any message at all')).toEqual({ kind: 'context_overflow' });
  });

  it('classifies 400 + "prompt is too long" as context_overflow', () => {
    const result = classifyStatus(400, 'prompt is too long: 250000 tokens > 200000 maximum');
    expect(result).toEqual({ kind: 'context_overflow' });
  });

  it('classifies 400 + "prompt too large for model" as context_overflow', () => {
    const result = classifyStatus(400, 'prompt too large for model');
    expect(result).toEqual({ kind: 'context_overflow' });
  });

  it('classifies 400 + "request too large" as context_overflow', () => {
    const result = classifyStatus(400, 'request too large for processing');
    expect(result).toEqual({ kind: 'context_overflow' });
  });

  it('classifies 400 + "request_too_large" as context_overflow', () => {
    const result = classifyStatus(400, 'Error: request_too_large — payload exceeds limit');
    expect(result).toEqual({ kind: 'context_overflow' });
  });

  it('classifies 400 + "token count exceeds the maximum" as context_overflow', () => {
    const result = classifyStatus(400, 'input token count exceeds the maximum number of tokens');
    expect(result).toEqual({ kind: 'context_overflow' });
  });

  it('classifies 400 + "exceeds context limit" as context_overflow', () => {
    const result = classifyStatus(400, 'exceeds context limit');
    expect(result).toEqual({ kind: 'context_overflow' });
  });

  it('classifies 400 + "context window exceeded" as context_overflow', () => {
    const result = classifyStatus(400, 'context window exceeded');
    expect(result).toEqual({ kind: 'context_overflow' });
  });

  it('classifies 400 + "maximum context length" as context_overflow (existing)', () => {
    const result = classifyStatus(
      400,
      "This model's maximum context length is 128000 tokens. However, your messages resulted in 200000 tokens.",
    );
    expect(result).toEqual({ kind: 'context_overflow' });
  });

  it('classifies 400 + "prompt exceeds token limit" as context_overflow', () => {
    const result = classifyStatus(400, 'prompt exceeds token limit for this model');
    expect(result).toEqual({ kind: 'context_overflow' });
  });

  it('classifies 400 + Anthropic "credit balance is too low" as billing', () => {
    const result = classifyStatus(
      400,
      'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.',
    );
    expect(result).toEqual({ kind: 'billing' });
  });

  it('classifies 400 + "insufficient credit" as billing', () => {
    const result = classifyStatus(400, 'Insufficient credit to process request');
    expect(result).toEqual({ kind: 'billing' });
  });

  it('classifies 400 + "billing error" as billing', () => {
    const result = classifyStatus(400, 'billing error: account suspended');
    expect(result).toEqual({ kind: 'billing' });
  });

  it('classifies 403 with moderation metadata as moderation', () => {
    const result = classifyStatus(403, 'Flagged', {
      metadata: { reasons: ['violence'] },
    });
    expect(result).toEqual({ kind: 'moderation' });
  });

  it('classifies 403 + moderation text fallback as moderation', () => {
    const result = classifyStatus(
      403,
      'This model requires moderation and your input was flagged',
    );
    expect(result).toEqual({ kind: 'moderation' });
  });

  it('classifies 403 billing copy as billing (regression)', () => {
    const result = classifyStatus(403, 'Account suspended for non-payment');
    expect(result).toEqual({ kind: 'billing' });
  });

  it('classifies 403 + auth message as auth (REBEL-66J/65G)', () => {
    expect(classifyStatus(403, 'Invalid authentication')).toEqual({ kind: 'auth' });
    expect(classifyStatus(403, 'No auth credentials found')).toEqual({ kind: 'auth' });
    expect(classifyStatus(403, 'Invalid API key provided')).toEqual({ kind: 'auth' });
  });

  it('classifies 400 + "insufficient_quota" as billing', () => {
    const result = classifyStatus(400, 'Error: insufficient_quota');
    expect(result).toEqual({ kind: 'billing' });
  });

  it('classifies 400 + OpenAI bare-quota text as billing (Stage 3 extension)', () => {
    // Stage 3 Round 1 Completeness regression: the shared predicate consumer
    // `classifyStatus` must also recognize the extended OpenAI patterns.
    const result = classifyStatus(
      400,
      'You exceeded your current quota, please check your plan and billing details.',
    );
    expect(result).toEqual({ kind: 'billing' });
  });

  it('does NOT classify 400 + Google "per minute" quota as billing (rate_limit guard)', () => {
    // Stage 3 Round 1 HIGH: Google Gemini RESOURCE_EXHAUSTED with "per minute"
    // quota-window phrasing must NOT flip into the 400→billing path. It stays
    // generic 400 (invalid_request) — rate-limit classification happens at 429
    // via a different path (classifyHttpError), not via classifyStatus(400).
    const result = classifyStatus(
      400,
      "Quota exceeded for quota metric 'generate_content_requests per minute' for your plan",
    );
    expect(result).toEqual({ kind: 'invalid_request' });
  });

  it('classifies 400 + "context reduction is suggested" as context_overflow (REBEL-1BF)', () => {
    const result = classifyStatus(400, 'context reduction is suggested');
    expect(result).toEqual({ kind: 'context_overflow' });
  });

  it('classifies 400 + OpenRouter "more credits" as billing', () => {
    const result = classifyStatus(400, 'This request requires more credits, or fewer max_tokens');
    expect(result).toEqual({ kind: 'billing' });
  });

  it('classifies 400 + OpenRouter "key limit" as billing', () => {
    const result = classifyStatus(400, 'Key limit exceeded (daily limit)');
    expect(result).toEqual({ kind: 'billing' });
  });

  it('classifies 400 + "Invalid model name" as invalid_request (no regression)', () => {
    const result = classifyStatus(400, 'Invalid model name');
    expect(result).toEqual({ kind: 'invalid_request' });
  });

  // Negative tests — non-overflow errors that contain overflow-adjacent keywords
  it('does NOT classify 400 + "max_tokens exceeds limit" as context_overflow', () => {
    const result = classifyStatus(400, 'max_tokens: 1000000 > maximum allowed value 8192');
    expect(result).toEqual({ kind: 'invalid_request' });
  });

  it('does NOT classify 400 + generic "invalid request" as context_overflow', () => {
    const result = classifyStatus(400, 'Invalid request: missing required field');
    expect(result).toEqual({ kind: 'invalid_request' });
  });

  it('does NOT classify 400 + "content length" as context_overflow', () => {
    const result = classifyStatus(400, 'Content-Length header exceeds maximum');
    expect(result).toEqual({ kind: 'invalid_request' });
  });

  it('classifies generic 404 not found as unknown', () => {
    const result = classifyStatus(404, 'Not found');
    expect(result).toEqual({ kind: 'unknown' });
  });

  it('classifies 404 model not found as model_unavailable', () => {
    const result = classifyStatus(404, 'model not found');
    expect(result).toEqual({ kind: 'model_unavailable' });
  });

  // REBEL-1D9: BYOK users configuring non-chat models (e.g. gpt-5.5-pro) hit the
  // chat/completions endpoint and get 404 "not a chat model". Classify as
  // model_unavailable so the recovery pipeline and humanization handle it.
  it('classifies 404 + "not a chat model" as model_unavailable (OpenAI exact)', () => {
    const result = classifyStatus(
      404,
      'This is not a chat model and thus not supported in the v1/chat/completions endpoint. Did you mean to use v1/completions?',
    );
    expect(result).toEqual({ kind: 'model_unavailable' });
  });

  it('classifies 404 + "not supported" + "chat/completions" as model_unavailable', () => {
    const result = classifyStatus(
      404,
      'This model is not supported in the v1/chat/completions endpoint',
    );
    expect(result).toEqual({ kind: 'model_unavailable' });
  });

  // Regression guards: generic "not supported" without chat/completions must NOT
  // match — avoids false positives on unrelated 404 errors.
  it('does NOT classify 404 + generic "not supported" as model_unavailable', () => {
    const result = classifyStatus(404, 'Not supported');
    expect(result).toEqual({ kind: 'unknown' });
  });

  it('does NOT classify 404 + "not supported" with unrelated endpoint as model_unavailable', () => {
    expect(classifyStatus(404, 'This feature is not supported in the v1/embeddings endpoint')).toEqual({ kind: 'unknown' });
    expect(classifyStatus(404, 'Operation not supported for this endpoint')).toEqual({ kind: 'unknown' });
  });
});

describe('image_input_unsupported (OpenRouter 404 image-input backstop — 260610 incident)', () => {
  // The LITERAL body from the incident conversation (deepseek/deepseek-v4-flash
  // on the managed OpenRouter route, after Read produced an image tool result):
  // pre-fix this classified to kind 'unknown' → generic "Something went
  // sideways" toast, retry re-fails forever.
  const INCIDENT_BODY = '{"error":{"message":"No endpoints found that support image input","code":404}}';

  it('classifyHttpError routes the literal incident 404 body to image_input_unsupported', () => {
    const error = classifyHttpError(404, INCIDENT_BODY, 'OpenRouter');
    expect(error.kind).toBe('image_input_unsupported');
    // NOT transient: retrying re-sends the same image-bearing history.
    expect(error.isTransient).toBe(false);
    // Carried through to the AgentErrorKind catalog verbatim.
    expect(error.__agentErrorKind).toBe('image_input_unsupported');
  });

  it('classifyError (SDK path) routes the same 404 to image_input_unsupported', () => {
    const body = JSON.parse(INCIDENT_BODY) as Record<string, unknown>;
    const error = new APIError(404, body as never, `404 ${INCIDENT_BODY}`, undefined);
    const result = classifyError(error, undefined, 'OpenRouter');
    expect(result.kind).toBe('image_input_unsupported');
    expect(result.isTransient).toBe(false);
  });

  it('requires BOTH "no endpoints" AND "image input" (narrow matcher — other routing 404s unaffected)', () => {
    expect(classifyStatus(404, 'No endpoints found matching your data policy').kind).toBe('unknown');
    expect(classifyStatus(404, 'image input is not available on this endpoint').kind).toBe('unknown');
  });

  it('wins over the not_found_error type signal when both are present', () => {
    expect(
      classifyStatus(404, 'No endpoints found that support image input', { type: 'not_found_error' }).kind,
    ).toBe('image_input_unsupported');
  });

  it('does not shadow the existing 404 model_unavailable family', () => {
    expect(classifyStatus(404, 'model not found').kind).toBe('model_unavailable');
    expect(classifyStatus(404, 'model: foo-bar', { type: 'not_found_error' }).kind).toBe('model_unavailable');
  });

  it('does NOT match the legacy thinking-model-unavailable predicate (no silent downgrade)', async () => {
    // handleThinkingModelFallback keys on kind 'model_unavailable' OR the
    // legacy isThinkingModelUnavailableError() predicate. The incident error
    // must match NEITHER — it should flow to a terminal, actionable error
    // event, not a silent model-downgrade that re-fails on the same history.
    const { isThinkingModelUnavailableError } = await import('@shared/utils/modelNormalization');
    const error = classifyHttpError(404, INCIDENT_BODY, 'OpenRouter');
    expect(error.kind).not.toBe('model_unavailable');
    expect(isThinkingModelUnavailableError(error)).toBe(false);
  });
});

describe('isChatIncompatibilityError', () => {
  // Import dynamically since the module is already imported at top level
  let isChatIncompatibilityError: typeof import('../modelErrors').isChatIncompatibilityError;
  beforeAll(async () => {
    const mod = await import('../modelErrors');
    isChatIncompatibilityError = mod.isChatIncompatibilityError;
  });

  it('returns true for exact OpenAI "not a chat model" pattern', () => {
    expect(isChatIncompatibilityError(
      new Error('This is not a chat model and thus not supported in the v1/chat/completions endpoint. Did you mean to use v1/completions?')
    )).toBe(true);
  });

  it('returns true for variant "not supported" + "chat/completions"', () => {
    expect(isChatIncompatibilityError(
      new Error('This model is not supported in the v1/chat/completions endpoint')
    )).toBe(true);
  });

  it('returns true for string input (not Error)', () => {
    expect(isChatIncompatibilityError('not a chat model')).toBe(true);
  });

  it('returns false for generic "model not found"', () => {
    expect(isChatIncompatibilityError(new Error('The model does not exist'))).toBe(false);
  });

  it('returns false for generic "not supported" without chat/completions', () => {
    expect(isChatIncompatibilityError(new Error('Not supported'))).toBe(false);
    expect(isChatIncompatibilityError(
      new Error('This feature is not supported in the v1/embeddings endpoint')
    )).toBe(false);
  });

  it('returns false for unrelated errors', () => {
    expect(isChatIncompatibilityError(new Error('rate limited'))).toBe(false);
    expect(isChatIncompatibilityError(new Error('authentication failed'))).toBe(false);
  });

  it('handles ModelError objects', () => {
    const modelErr = new ModelError('model_unavailable',
      'This is not a chat model and thus not supported in the v1/chat/completions endpoint.',
      404, 'openai');
    expect(isChatIncompatibilityError(modelErr)).toBe(true);
  });
});

describe('isToolUseIncompatibilityError (REBEL-5RJ variant 2)', () => {
  let isToolUseIncompatibilityError: typeof import('../modelErrors').isToolUseIncompatibilityError;
  beforeAll(async () => {
    const mod = await import('../modelErrors');
    isToolUseIncompatibilityError = mod.isToolUseIncompatibilityError;
  });

  it('returns true for the Gemini thought_signature error', () => {
    expect(isToolUseIncompatibilityError(
      new Error('Function call is missing a thought_signature in functionCall parts. This is required for tools to work correctly.')
    )).toBe(true);
  });

  it('returns true for string input (not Error)', () => {
    expect(isToolUseIncompatibilityError('Function call is missing a thought_signature in functionCall parts.')).toBe(true);
  });

  it('returns true on a ModelError carrying the recovered provider message', () => {
    const modelErr = new ModelError('invalid_request',
      'Function call is missing a thought_signature in functionCall parts.',
      400, 'openai');
    expect(isToolUseIncompatibilityError(modelErr)).toBe(true);
  });

  it('returns false for unrelated errors', () => {
    expect(isToolUseIncompatibilityError(new Error('rate limited'))).toBe(false);
    expect(isToolUseIncompatibilityError(new Error('This is not a chat model'))).toBe(false);
    expect(isToolUseIncompatibilityError(new Error('thinking.type.enabled is not supported'))).toBe(false);
  });

  it('fails narrow: a generic function-call argument error does NOT auto-mark (only thought_signature triggers)', () => {
    // Auto-marking toolUseCompatibility:'incompatible' is a persistent state change, so the
    // predicate must not fire on transient/fixable tool-call errors.
    expect(isToolUseIncompatibilityError(new Error('The function call returned a value'))).toBe(false);
    expect(isToolUseIncompatibilityError(new Error('Function call is missing a required parameter "location"'))).toBe(false);
    expect(isToolUseIncompatibilityError(new Error('Invalid tool_call: missing arguments'))).toBe(false);
  });
});

describe('ModelError', () => {
  it('sets __agentErrorKind for backward compat', () => {
    const error = new ModelError('rate_limit', 'test', 429, 'OpenAI');
    expect(error.__agentErrorKind).toBe('rate_limit');
    expect(error.__rawMessage).toBe('test');
  });

  it('maps abort to unknown __agentErrorKind', () => {
    const error = new ModelError('abort', 'cancelled');
    expect(error.__agentErrorKind).toBe('unknown');
    expect(error.isAbort).toBe(true);
  });

  it('tracks provider name', () => {
    const error = new ModelError('server_error', 'down', 503, 'Cerebras');
    expect(error.provider).toBe('Cerebras');
    expect(error.status).toBe(503);
  });

  it('tracks rawMessage and upstreamProvider options', () => {
    const error = new ModelError('billing', 'Needs credits', 402, 'OpenRouter', {
      rawMessage: '{"error":{"message":"Needs credits","metadata":{"provider_name":"anthropic"}}}',
      upstreamProvider: 'anthropic',
    });
    expect(error.__rawMessage).toBe('{"error":{"message":"Needs credits","metadata":{"provider_name":"anthropic"}}}');
    expect(error.upstreamProvider).toBe('anthropic');
  });
});

describe('parseOutputCapFrom400', () => {
  it('returns undefined for non-max_tokens messages', () => {
    expect(parseOutputCapFrom400('Invalid model name')).toBeUndefined();
    expect(parseOutputCapFrom400('This model\'s maximum context length is 128000 tokens.')).toBeUndefined();
  });

  it('returns undefined for 400 messages about input token limits', () => {
    expect(
      parseOutputCapFrom400('max input tokens exceeded: this model supports up to 200000 input tokens'),
    ).toBeUndefined();
  });

  it('returns undefined for 400 messages about context window overflow', () => {
    expect(
      parseOutputCapFrom400('context window of 200000 tokens exceeded for this request'),
    ).toBeUndefined();
  });

  it('returns undefined when parsed outputCap is zero', () => {
    expect(
      parseOutputCapFrom400('max_tokens: 1000000 > maximum allowed value 0'),
    ).toBeUndefined();
  });
});
