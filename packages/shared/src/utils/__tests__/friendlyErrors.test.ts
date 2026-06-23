import { describe, it, expect } from 'vitest';
import {
  classifyBillingSubtype,
  humanizeError,
  isAuthErrorMessage,
  isBillingMessage,
  isTransientError,
  isNetworkError,
  shouldSuppressErrorDuringRetry,
  isRateLimitMessage,
  extractRetryAfterMs
} from '../friendlyErrors';

describe('friendlyErrors', () => {
  describe('humanizeError', () => {
    describe('billing/credit errors (user-actionable)', () => {
      it('should handle "Credit balance is too low" errors', () => {
        const result = humanizeError('Credit balance is too low to complete this request');
        expect(result).toContain('billing attention');
      });

      it('should handle "credit balance" errors', () => {
        const result = humanizeError('Your credit balance is insufficient');
        expect(result).toContain('billing attention');
      });

      it('should handle "insufficient credit" errors', () => {
        const result = humanizeError('Insufficient credit in your account');
        expect(result).toContain('billing attention');
      });

      it('should handle "billing error" errors', () => {
        const result = humanizeError('Billing error: payment method declined');
        expect(result).toContain('billing attention');
      });
    });

    describe('quota exhaustion errors (user-actionable)', () => {
      it('should handle "insufficient_quota" errors', () => {
        const result = humanizeError('Error: insufficient_quota - you have exceeded your plan limits');
        expect(result).toContain('usage limit');
      });

      it('should handle "quota exceeded" errors', () => {
        const result = humanizeError('Quota exceeded for this billing period');
        expect(result).toContain('usage limit');
      });
    });

    describe('OpenRouter billing errors (REBEL-1CG/1CV/1BP)', () => {
      it('should handle OpenRouter "more credits" error (REBEL-1CG exact string)', () => {
        const result = humanizeError('402 {"error":{"message":"This request requires more credits, or fewer max_tokens. You requested up to 4096 tokens, but can only afford 2381. To increase, visit https://openrouter.ai/settings/credits and upgrade to a paid account","code":402,"metadata":{"provider_name":null}},"user_id":"user_39q36wYfdGqH0kbEtjqBjUVcPGE"}');
        expect(result).toContain('billing attention');
        expect(result).not.toContain('{');
        expect(result).not.toContain('openrouter.ai/settings');
      });

      it('should handle OpenRouter "can only afford" variant (REBEL-1CV exact string)', () => {
        const result = humanizeError('402 {"error":{"message":"This request requires more credits, or fewer max_tokens. You requested up to 128000 tokens, but can only afford 82277. To increase, visit https://openrouter.ai/settings/keys and create a key with a higher monthly limit","code":402,"metadata":{"provider_name":null}},"user_id":"user_3CTh43dEjP4aAGrN1KZU72IVBL4"}');
        expect(result).toContain('billing attention');
        expect(result).not.toContain('{');
      });

      it('should handle OpenRouter "key limit exceeded" (REBEL-1BP exact string)', () => {
        const result = humanizeError('403 {"error":{"message":"Key limit exceeded (daily limit). Manage it using https://openrouter.ai/settings/keys","code":403}}');
        expect(result).toContain('usage limit');
        expect(result).not.toContain('{');
        expect(result).not.toContain('openrouter.ai');
      });

      it('should handle bare "monthly limit" errors', () => {
        const result = humanizeError('Key monthly limit exceeded. Upgrade your plan.');
        expect(result).toContain('usage limit');
      });
    });

    describe('context reduction errors (REBEL-1BF)', () => {
      it('should handle Anthropic "context reduction is suggested" (REBEL-1BF exact string)', () => {
        const result = humanizeError('{"type":"error","error":{"details":null,"type":"invalid_request_error","message":"context reduction is suggested"},"request_id":"req_011Ca9jSXf7cx5H8ssiZnmJ2"}');
        expect(result).toContain('conversation got too long');
        expect(result).not.toContain('{');
        expect(result).not.toContain('invalid_request_error');
      });

      it('should handle bare "context reduction" message', () => {
        const result = humanizeError('context reduction is suggested');
        expect(result).toContain('conversation got too long');
      });
    });

    describe('API spend limit errors (user-actionable)', () => {
      it('should handle "API usage limits" errors with reset date', () => {
        const error = 'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"You have reached your specified API usage limits. You will regain access on 2026-02-01 at 00:00 UTC."},"request_id":"req_123"}';
        const result = humanizeError(error);
        expect(result).toContain('spending limit');
        expect(result).toContain('2026-02-01');
        expect(result).toContain('(UTC)');
        expect(result).toContain('console.anthropic.com');
      });

      it('should handle "API usage limits" errors without reset date', () => {
        const error = 'You have reached your API usage limits';
        const result = humanizeError(error);
        expect(result).toContain('spending limit');
        expect(result).toContain('console.anthropic.com');
        expect(result).not.toContain('regain access');
      });

      it('should prioritize spend limit over rate limiting patterns', () => {
        const error = 'API usage limits reached, retry-after: 429';
        const result = humanizeError(error);
        expect(result).toContain('spending limit');
        expect(result).not.toContain("provider's rate limit");
      });
    });

    describe('rate limiting (transient)', () => {
      it('should handle 429 rate limit errors', () => {
        const result = humanizeError('HTTP 429 - Rate limit exceeded');
        expect(result).toContain("provider's rate limit");
      });

      it('should handle "rate limit" text', () => {
        const result = humanizeError('You have hit the rate limit');
        expect(result).toContain("provider's rate limit");
      });

      it('should handle "taking a quick breather" text', () => {
        const result = humanizeError('Taking a quick breather. Will continue in a moment.');
        expect(result).toContain("provider's rate limit");
      });

      it('should return OpenAI-specific slower reset hint when provider is OpenAI', () => {
        const result = humanizeError('HTTP 429 - Rate limit exceeded', { provider: 'OpenAI' });
        expect(result).toContain('few hours');
        expect(result).not.toContain('few minutes');
      });

      it('should return OpenAI-specific hint for Codex provider', () => {
        const result = humanizeError('rate limit hit', { provider: 'Codex' });
        expect(result).toContain('few hours');
      });

      it('should return standard reset hint for Anthropic provider', () => {
        const result = humanizeError('HTTP 429', { provider: 'Anthropic' });
        expect(result).toContain('few minutes');
        expect(result).not.toContain('can take a while');
      });

      it('should return standard reset hint when no provider is specified', () => {
        const result = humanizeError('rate limit exceeded');
        expect(result).toContain('few minutes');
      });
    });

    describe('billing errors should take precedence over rate limiting patterns', () => {
      // This is critical: billing errors mention "rate" sometimes but shouldn't be treated as transient
      it('should prioritize billing over 429-like patterns', () => {
        const result = humanizeError('Credit balance is too low');
        expect(result).not.toContain("provider's rate limit"); // Not a rate limit
        expect(result).toContain('billing');
      });
    });

    describe('provider-aware server errors', () => {
      it('names OpenAI Codex for server_error copy when provider is Codex', () => {
        const result = humanizeError('Internal server error', {
          errorKind: 'server_error',
          provider: 'OpenAI (Codex)',
        });

        expect(result).toBe('OpenAI Codex had a moment. Retry — your work so far is saved.');
      });

      it('names Anthropic for server_error copy when provider is Anthropic', () => {
        const result = humanizeError('Internal server error', {
          errorKind: 'server_error',
          provider: 'Anthropic',
        });

        expect(result).toBe('Anthropic had a moment. Retry — your work so far is saved.');
      });

      it('uses generic model-service copy for server_error without provider metadata', () => {
        const result = humanizeError('Internal server error', {
          errorKind: 'server_error',
        });

        expect(result).toBe('The model service had a moment. Retry — your work so far is saved.');
      });
    });

    describe('network errors', () => {
      it('uses static classified network copy without raw transport detail', () => {
        const result = humanizeError(
          'TypeError: fetch failed UND_ERR_CONNECT_TIMEOUT chatgpt.com 2606:4700::1',
          { errorKind: 'network' },
        );

        expect(result).toContain("Can't reach the AI service.");
        expect(result).not.toContain('UND_ERR_CONNECT_TIMEOUT');
        expect(result).not.toContain('chatgpt.com');
        expect(result).not.toContain('2606:4700::1');
      });

      it('should handle timeout errors', () => {
        const result = humanizeError('ETIMEDOUT');
        expect(result).toContain('longer than usual');
      });

      it('should handle connection refused', () => {
        const result = humanizeError('ECONNREFUSED');
        expect(result).toContain('trouble connecting');
      });
    });

    describe('provider routing failures', () => {
      const providerRoutingMessage = "This model isn't available from our preferred providers right now. Try a different model, or try again later.";

      it('should humanize "no endpoints" + "provider.only" errors', () => {
        const result = humanizeError('API Error: 400 {"type":"error","error":{"message":"No endpoints available that support provider.only constraint"}}');
        expect(result).toBe(providerRoutingMessage);
      });

      it('should humanize "no endpoints" + "provider restrictions" errors', () => {
        const result = humanizeError('API Error: 402 {"type":"error","error":{"message":"No endpoints found matching your provider restrictions"}}');
        expect(result).toBe(providerRoutingMessage);
      });

      it('should NOT match cache_control unavailable errors (REBEL-cache_control false-match fix)', () => {
        const cacheControlError = 'API Error: 404 {"error":{"message":"No endpoints found that support Anthropic automatic caching (top-level cache_control). See https://openrouter.ai/docs/provider-routing"}}';
        const result = humanizeError(cacheControlError);
        expect(result).not.toBe(providerRoutingMessage);
      });

      it('should still match real provider routing errors with "provider" in message', () => {
        const result = humanizeError('No endpoints found matching your provider preferences');
        expect(result).toBe(providerRoutingMessage);
      });

      it('should keep normal API server error handling unchanged (regression)', () => {
        const result = humanizeError('HTTP 503 Service Unavailable');
        expect(result).toContain('momentarily busy');
      });
    });

    describe('moderation errors', () => {
      it('should humanize moderation/safety filter errors', () => {
        const result = humanizeError('Your input was flagged by the moderation system safety filter.');
        expect(result).toBe("Your message was flagged by the model's safety filter. Try rephrasing — a less direct framing or more context usually helps.");
      });
    });

    describe('529 overloaded errors', () => {
      it('should handle "Repeated 529 Overloaded errors" from SDK', () => {
        const result = humanizeError('API Error: Repeated 529 Overloaded errors');
        expect(result).toContain('momentarily busy');
        expect(result).toContain('retry');
      });

      it('should handle raw 529 status code', () => {
        const result = humanizeError('HTTP 529 Service Overloaded');
        expect(result).toContain('momentarily busy');
      });
    });

    describe('API server errors (500/api_error)', () => {
      it('should handle full API Error 500 JSON response', () => {
        const error = 'API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"},"request_id":"req_123"}';
        const result = humanizeError(error);
        expect(result).toContain('hiccup');
        expect(result).not.toContain('{');
      });

      it('should handle "Internal server error" text', () => {
        const result = humanizeError('Internal server error');
        expect(result).toContain('hiccup');
      });

      it('should handle "api_error" text', () => {
        const result = humanizeError('Error type: api_error');
        expect(result).toContain('hiccup');
      });

      it('should NOT match "500" alone (avoids false positives)', () => {
        const result = humanizeError('Found 500 files in directory');
        expect(result).toBe('Found 500 files in directory');
      });

      it('should match 500 with API error context', () => {
        const result = humanizeError('API Error: 500 with "type":"error" in response');
        expect(result).toContain('hiccup');
      });
    });

    describe('empty response errors', () => {
      it('should handle "200 OK but response body was empty"', () => {
        const result = humanizeError('Error: LLM returned 200 OK but response body was empty (possible rate limit)');
        expect(result).toContain('empty');
        expect(result).toContain('try again');
      });
    });

    describe('OpenAI invalid_request_error (missing tool output)', () => {
      it('should humanize "No tool output found" proxy errors', () => {
        const result = humanizeError('500 {"type":"error","error":{"message":"No tool output found for function call call_abc123.","type":"invalid_request_error"}}');
        expect(result).toContain('mid-conversation');
        expect(result).toContain('saved');
      });

      it('should humanize errors mentioning tool_use_id', () => {
        const result = humanizeError('Missing tool_use_id in request');
        expect(result).toContain('mid-conversation');
        expect(result).toContain('saved');
      });
    });

    describe('legacy "encountered an error" messages (safety net)', () => {
      it('should humanize legacy model-name-exposing error messages', () => {
        const result = humanizeError('OpenAI GPT 5.4 encountered an error. Please try again.');
        expect(result).not.toContain('OpenAI');
        expect(result).not.toContain('GPT');
        expect(result).toContain('AI service');
        expect(result).toContain('safe');
      });

      it('should humanize generic "encountered an error" messages', () => {
        const result = humanizeError('The API service encountered an error after multiple retries.');
        expect(result).not.toContain('API service');
        expect(result).toContain('AI service');
        expect(result).toContain('safe');
      });
    });

    describe('model not found errors', () => {
      it('should show actionable guidance when not_found_error references a model', () => {
        const result = humanizeError(
          'API Error: 404 {"type":"error","error":{"type":"not_found_error","message":"model: anthropic/claude-opus-4.6"}}',
        );
        expect(result).toBe("The model 'anthropic/claude-opus-4.6' wasn't found. Open Settings → Models to pick a different one, or turn off Plan Mode to keep going.");
      });

      it('should keep generic fallback for non-model not_found_error responses', () => {
        const result = humanizeError(
          'API Error: 404 {"type":"error","error":{"type":"not_found_error","message":"workspace not found"}}',
        );
        expect(result).toBe("The AI service ran into trouble. Your message is safe — try again.");
      });
    });

    describe('JSON-stripping fallback', () => {
      it('should strip API Error format with JSON', () => {
        const result = humanizeError('API Error: 400 {"some":"json"}');
        expect(result).not.toContain('{');
        expect(result).toContain('safe');
      });

      it('should strip raw JSON error objects', () => {
        const result = humanizeError('{"type":"error","error":{"type":"invalid","message":"bad"}}');
        expect(result).not.toContain('{"type"');
        expect(result).toContain('safe');
      });
    });

    describe('spawn/process errors (REBEL-P8)', () => {
      it('should not show raw "spawn EBADF" to users', () => {
        // Exact production error from Sentry REBEL-P8: child_process.spawn
        // fails with EBADF (bad file descriptor), typically caused by port
        // conflicts or FD exhaustion. Users see this in the error banner.
        const result = humanizeError('spawn EBADF');
        expect(result).not.toBe('spawn EBADF');
        expect(result).not.toContain('EBADF');
        expect(result).toContain('restart');
      });

      it('should handle spawn ENOENT (command not found)', () => {
        const result = humanizeError('spawn ENOENT');
        expect(result).not.toContain('ENOENT');
        expect(result).toContain('restart');
      });

      it('should handle spawn EACCES (permission denied)', () => {
        const result = humanizeError('spawn EACCES');
        expect(result).not.toContain('EACCES');
        expect(result).toContain('restart');
      });

      it('should not treat spawn errors as transient', () => {
        // Spawn errors won't resolve with retry — user needs to restart
        expect(isTransientError('spawn EBADF')).toBe(false);
        expect(isTransientError('spawn ENOENT')).toBe(false);
        expect(isTransientError('spawn EACCES')).toBe(false);
      });
    });

    describe('EMFILE and file-access exhaustion', () => {
      it('should humanize raw EMFILE errors with recovery steps', () => {
        const result = humanizeError("EMFILE: too many open files, open 'C:\\\\Users\\\\vion\\\\AppData\\\\Roaming\\\\mindstone-rebel\\\\tool-usage.json.tmp-abc123'");
        expect(result).not.toContain('EMFILE');
        expect(result).not.toContain('tool-usage.json.tmp');
        expect(result).toContain('Restart Rebel');
        expect(result).toContain('restart your computer');
        expect(result).toContain('send diagnostics');
        expect(result).toContain('Your files are still there');
      });

      it('should humanize ENFILE variants too', () => {
        const result = humanizeError('spawn helper failed with ENFILE after local file pressure');
        expect(result).toContain('restart');
      });
    });

    describe('model endpoint incompatibility (REBEL-1D9)', () => {
      it('should humanize OpenAI "not a chat model" error', () => {
        const result = humanizeError(
          'This is not a chat model and thus not supported in the v1/chat/completions endpoint. Did you mean to use v1/completions?',
        );
        expect(result).toContain('different model');
        expect(result).toContain('Settings');
      });

      it('should humanize "not supported" + "chat/completions" variant', () => {
        const result = humanizeError('This model is not supported in the v1/chat/completions endpoint');
        expect(result).toContain('different model');
        expect(result).toContain('Settings');
      });

      it('should produce the same friendly copy for both variants', () => {
        const exact = humanizeError(
          'This is not a chat model and thus not supported in the v1/chat/completions endpoint.',
        );
        const variant = humanizeError('Model is not supported in the v1/chat/completions endpoint');
        expect(exact).toBe(variant);
      });

      it('should NOT match generic "not supported" without chat/completions context', () => {
        const generic = humanizeError('This feature is not supported in the v1/embeddings endpoint');
        expect(generic).not.toContain('different model');
        expect(generic).not.toContain('Settings');
      });
    });

    describe('SDK stream-lifecycle errors', () => {
      it('should humanize "request ended without sending any chunks"', () => {
        const result = humanizeError('request ended without sending any chunks');
        expect(result).toContain('interrupted');
        expect(result).toContain('try again');
      });

      it('should humanize "stream ended without producing a Message"', () => {
        const result = humanizeError('stream ended without producing a Message with role=assistant');
        expect(result).toContain('interrupted');
        expect(result).toContain('try again');
      });

      it('should humanize "stream has ended"', () => {
        const result = humanizeError("stream has ended, this shouldn't happen");
        expect(result).toContain('interrupted');
        expect(result).toContain('try again');
      });

      it('should humanize "stream ended without producing a content block"', () => {
        const result = humanizeError('stream ended without producing a content block with type=text');
        expect(result).toContain('interrupted');
        expect(result).toContain('try again');
      });
    });

    describe('fallback', () => {
      it('should return original error for unknown patterns', () => {
        const originalError = 'Some completely unknown error XYZ123';
        const result = humanizeError(originalError);
        expect(result).toBe(originalError);
      });
    });

    describe('exceed-branch narrowing (260421 regression guard)', () => {
      // The `exceed` qualifier set was narrowed to `request|prompt|token|size`
      // (excluding `limit`) to prevent OpenAI bare-quota / spending-limit messages
      // from being mis-copy'd as "too large". Context-window phrasings are caught
      // by the context-overflow branch above.

      it('positive: "exceeded max prompt tokens" still returns size-overflow copy', () => {
        const result = humanizeError('Your request exceeded max prompt tokens by 1500');
        expect(result).toContain('too large');
      });

      it('positive: "exceeded the request size limit" still returns size-overflow copy', () => {
        const result = humanizeError('exceeded the request size limit');
        expect(result).toContain('too large');
      });

      it('positive: bare "too large" still matches', () => {
        const result = humanizeError('The payload is too large for this endpoint.');
        expect(result).toContain('too large');
      });

      it('positive: bare "too long" still matches', () => {
        const result = humanizeError('Your prompt is too long.');
        expect(result).toContain('too large');
      });

      it('positive: "maximum context length exceeded" returns context-overflow copy (not size)', () => {
        // This exact phrasing is exercised by agentRuntimeContract.test.ts:747.
        // Routed through the context branch because it is the correct UX — we auto-summarize,
        // not ask the user to "break it into smaller parts".
        const result = humanizeError('Local model error (400): maximum context length exceeded');
        expect(result).toContain('too long');
        expect(result).toContain('summarize');
      });

      it("positive: \"input exceeds the model's context window\" returns context-overflow copy", () => {
        const result = humanizeError("Your input exceeds the model's context window");
        expect(result).toContain('too long');
        expect(result).toContain('summarize');
      });

      it('negative: "You exceeded your current quota" does NOT return "too large"', () => {
        // Target bug from conversation 82d61626-3d3c-4ea2-b369-f2ec7c9531de.
        const result = humanizeError('You exceeded your current quota, please check your plan and billing details.');
        expect(result).not.toContain('too large');
      });

      it('negative: "exceeded your spending limit" does NOT return "too large"', () => {
        // Covered earlier in this suite (routes to billing via `isBillingMessage`), but
        // this is a belt-and-braces check at the raw `humanizeError` layer.
        const result = humanizeError('You have exceeded your spending limit on this API key.');
        expect(result).not.toContain('too large');
      });

      it('negative: bare "exceeded your quota" does NOT return "too large"', () => {
        const result = humanizeError('exceeded your quota');
        expect(result).not.toContain('too large');
      });
    });
  });

  describe('isTransientError', () => {
    describe('kind-first classification', () => {
      it('FOX-3267 / BTS 260430: invalid_request wins over historical stream substring matching', () => {
        expect(isTransientError('Stream must be true', 'invalid_request')).toBe(false);
      });

      it('should return true for transient kinds without substring matching', () => {
        expect(isTransientError('not a transient-looking message', 'rate_limit')).toBe(true);
      });

      it('should fall back to substring matching when kind is unknown', () => {
        expect(isTransientError('HTTP 503 Service Unavailable', 'unknown')).toBe(true);
      });

      it('should fall back to substring matching when kind is omitted', () => {
        expect(isTransientError('HTTP 503 Service Unavailable')).toBe(true);
      });
    });

    describe('billing/quota errors are NOT transient', () => {
      it('should return false for "credit balance" errors', () => {
        expect(isTransientError('Credit balance is too low')).toBe(false);
      });

      it('should return false for "billing error" errors', () => {
        expect(isTransientError('Billing error occurred')).toBe(false);
      });

      it('should return false for "insufficient_quota" errors', () => {
        expect(isTransientError('Error: insufficient_quota')).toBe(false);
      });

      it('should return false for "insufficient credit" errors', () => {
        expect(isTransientError('Insufficient credit in account')).toBe(false);
      });

      it('should return false for "API usage limits" errors', () => {
        expect(isTransientError('You have reached your API usage limits')).toBe(false);
      });

      it('should return false for OpenRouter "more credits" errors', () => {
        expect(isTransientError('This request requires more credits, or fewer max_tokens')).toBe(false);
      });

      it('should return false for OpenRouter "can only afford" errors', () => {
        expect(isTransientError('can only afford 2381 tokens')).toBe(false);
      });

      it('should return false for OpenRouter "key limit" errors', () => {
        expect(isTransientError('Key limit exceeded (daily limit)')).toBe(false);
      });

      it('should return false for OpenRouter "daily limit" errors', () => {
        expect(isTransientError('daily limit exceeded')).toBe(false);
      });

      it('should return false for OpenRouter "monthly limit" errors', () => {
        expect(isTransientError('monthly limit reached')).toBe(false);
      });
    });

    describe('provider routing failures are NOT transient', () => {
      it('should return false for "no endpoints" + "provider.only" errors', () => {
        expect(isTransientError('No endpoints available that support provider.only constraint')).toBe(false);
      });

      it('should return false for "no endpoints" + "provider restrictions" errors', () => {
        expect(isTransientError('No endpoints found matching your provider restrictions')).toBe(false);
      });

      it('should NOT treat cache_control errors as provider routing (they are transient via proxy retry)', () => {
        const cacheError = 'No endpoints found that support Anthropic automatic caching (top-level cache_control)';
        expect(isTransientError(cacheError)).toBe(false);
      });
    });

    describe('network errors ARE transient', () => {
      it('should return true for timeout errors', () => {
        expect(isTransientError('ETIMEDOUT')).toBe(true);
      });

      // WS4 turn-hang fix: the Anthropic SDK governs the executor->localhost-proxy
      // hop; a connection timeout there surfaces as APIConnectionTimeoutError with
      // message 'Request timed out.' (NOT the Node `ETIMEDOUT` code). Before this
      // fix isTransientError matched `etimedout` but not the bare words, so the
      // error classified as `unknown` -> NON-retryable dead-end (the turn hung).
      it('should return true for the Anthropic SDK connection-timeout message', () => {
        expect(isTransientError('Request timed out.')).toBe(true);
      });

      it('should return true for a generic connection-timeout phrasing', () => {
        expect(isTransientError('Connection timed out')).toBe(true);
      });

      it('should return true for a bare "Connection timeout"', () => {
        expect(isTransientError('Connection timeout')).toBe(true);
      });

      it('should return true for connection reset', () => {
        expect(isTransientError('ECONNRESET')).toBe(true);
      });

      it('should return true for 503 errors', () => {
        expect(isTransientError('HTTP 503 Service Unavailable')).toBe(true);
      });

      it('should return true for 529 overloaded errors', () => {
        expect(isTransientError('API Error: Repeated 529 Overloaded errors')).toBe(true);
      });

      it('should return true for 429 errors', () => {
        expect(isTransientError('HTTP 429 Rate Limited')).toBe(true);
      });

      it('should return true for empty_result_anomaly', () => {
        expect(isTransientError('empty_result_anomaly detected')).toBe(true);
      });

      // Specificity guard for the timeout-message fix: genuinely non-retryable
      // errors with no connection-timeout semantics must STAY non-transient even
      // though connection-timeout phrasings ('timed out' / 'connection timeout')
      // were added to the transient matcher. (The bare word 'timeout' is NOT
      // matched — see modelErrors.test.ts "keeps bare timeout unclassified".)
      it('keeps an auth error non-transient (no timeout semantics)', () => {
        expect(isTransientError('401 Unauthorized: invalid API key')).toBe(false);
      });

      it('keeps an invalid-request error non-transient (no timeout semantics)', () => {
        expect(isTransientError('Stream must be true for this endpoint')).toBe(false);
      });

      // The billing/quota guard runs BEFORE the transient matcher, so a billing
      // error that happens to mention a timeout still classifies non-transient.
      it('keeps a billing error non-transient even if it mentions a timeout', () => {
        expect(isTransientError('Credit balance is too low; request timed out waiting for funds')).toBe(false);
      });

      // The bare word 'timeout' (no connection/request context) is too generic to
      // be a retry signal and must stay non-transient — the production-matcher twin
      // of the model-level "keeps bare timeout unclassified" guard in
      // modelErrors.test.ts. Pins the 'timeout' -> 'connection timeout' narrowing.
      it('keeps the bare word "timeout" non-transient (too generic)', () => {
        expect(isTransientError('timeout')).toBe(false);
      });

      it('should return true for internal server error', () => {
        expect(isTransientError('Internal server error')).toBe(true);
      });

      it('should return true for api_error', () => {
        expect(isTransientError('Error type: api_error')).toBe(true);
      });

      it('should return true for 200 OK empty body', () => {
        expect(isTransientError('LLM returned 200 OK but response body was empty')).toBe(true);
      });
    });

    describe('SDK stream-lifecycle errors ARE transient', () => {
      it('should return true for "request ended without sending any chunks"', () => {
        expect(isTransientError('request ended without sending any chunks')).toBe(true);
      });

      it('should return true for "stream ended without producing a Message"', () => {
        expect(isTransientError('stream ended without producing a Message with role=assistant')).toBe(true);
      });

      it('should return true for "stream has ended"', () => {
        expect(isTransientError("stream has ended, this shouldn't happen")).toBe(true);
      });

      it('should return true for "stream ended without producing a content block"', () => {
        expect(isTransientError('stream ended without producing a content block with type=text')).toBe(true);
      });
    });

    describe('OpenAI Responses API termination errors ARE transient', () => {
      it('should return true for bare "terminated" status', () => {
        expect(isTransientError('terminated')).toBe(true);
      });

      it('should not match "terminated" as a substring (e.g. "account terminated")', () => {
        expect(isTransientError('Your account has been terminated')).toBe(false);
      });
    });

    describe('unknown errors', () => {
      it('should return false for unknown errors', () => {
        expect(isTransientError('Something completely unexpected')).toBe(false);
      });
    });
  });

  describe('isNetworkError', () => {
    const networkSignals = [
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

    it('should return false for provider routing failures', () => {
      expect(isNetworkError('No endpoints available that support provider.only constraint')).toBe(false);
      expect(isNetworkError('No endpoints found matching your provider restrictions')).toBe(false);
    });

    it.each(networkSignals)('should return true for real network failure signal: %s', (signal) => {
      expect(isNetworkError(signal)).toBe(true);
    });

    it.each(networkSignals)('should keep network failure signal transient: %s', (signal) => {
      expect(isTransientError(signal)).toBe(true);
    });
  });

  describe('isRateLimitMessage', () => {
    it('should detect "rate_limit" pattern', () => {
      expect(isRateLimitMessage('Error: rate_limit exceeded')).toBe(true);
    });

    it('should detect "rate limit" with space', () => {
      expect(isRateLimitMessage('You hit the rate limit')).toBe(true);
    });

    it('should detect 429 status code', () => {
      expect(isRateLimitMessage('HTTP 429 Too Many Requests')).toBe(true);
    });

    it('should detect "too many requests"', () => {
      expect(isRateLimitMessage('too many requests from your IP')).toBe(true);
    });

    it('should detect "taking a quick breather"', () => {
      expect(isRateLimitMessage('Taking a quick breather. Will continue in a moment.')).toBe(true);
    });

    it('should be case-insensitive', () => {
      expect(isRateLimitMessage('TAKING A QUICK BREATHER')).toBe(true);
      expect(isRateLimitMessage('RATE_LIMIT')).toBe(true);
    });

    it('should detect Claude Max "hit your limit" message', () => {
      expect(isRateLimitMessage("You've hit your limit \u00b7 resets 6pm (Europe/Paris)")).toBe(true);
    });

    it('should detect "usage limit" pattern', () => {
      expect(isRateLimitMessage('You have reached your usage limit')).toBe(true);
      expect(isRateLimitMessage('Usage limits will reset shortly')).toBe(true);
    });

    it('should detect Gemini "resource_exhausted" plain-text pattern', () => {
      expect(isRateLimitMessage('RESOURCE_EXHAUSTED: Quota metric exceeded')).toBe(true);
      expect(isRateLimitMessage('resource_exhausted')).toBe(true);
    });

    it('should return false for non-rate-limit errors', () => {
      expect(isRateLimitMessage('Internal server error')).toBe(false);
      expect(isRateLimitMessage('Authentication failed')).toBe(false);
      expect(isRateLimitMessage('Unknown error occurred')).toBe(false);
    });

    it('should return false for empty string', () => {
      expect(isRateLimitMessage('')).toBe(false);
    });
  });

  describe('shouldSuppressErrorDuringRetry', () => {
    it('should suppress 503 errors', () => {
      expect(shouldSuppressErrorDuringRetry('HTTP 503')).toBe(true);
    });

    it('should suppress 529 overloaded errors', () => {
      expect(shouldSuppressErrorDuringRetry('API Error: Repeated 529 Overloaded errors')).toBe(true);
    });

    it('should suppress empty_result_anomaly', () => {
      expect(shouldSuppressErrorDuringRetry('empty_result_anomaly')).toBe(true);
    });

    it('should NOT suppress 429 errors (user should know about rate limits)', () => {
      expect(shouldSuppressErrorDuringRetry('HTTP 429')).toBe(false);
    });

    it('should suppress internal server error', () => {
      expect(shouldSuppressErrorDuringRetry('Internal server error')).toBe(true);
    });

    it('should suppress api_error', () => {
      expect(shouldSuppressErrorDuringRetry('Error: api_error')).toBe(true);
    });

    it('should suppress SDK stream-lifecycle errors', () => {
      expect(shouldSuppressErrorDuringRetry('request ended without sending any chunks')).toBe(true);
      expect(shouldSuppressErrorDuringRetry('stream ended without producing a Message with role=assistant')).toBe(true);
      expect(shouldSuppressErrorDuringRetry("stream has ended, this shouldn't happen")).toBe(true);
    });
  });

  describe('extractRetryAfterMs', () => {
    it('parses "retry after N seconds"', () => {
      expect(extractRetryAfterMs('Rate limited, retry after 30 seconds')).toBe(30_000);
      expect(extractRetryAfterMs('retry after 5 seconds')).toBe(5_000);
    });

    it('parses "retry after N minutes"', () => {
      expect(extractRetryAfterMs('retry after 2 minutes')).toBe(120_000);
      expect(extractRetryAfterMs('retry after 1 minute')).toBe(60_000);
    });

    it('parses "try again in N seconds"', () => {
      expect(extractRetryAfterMs('Please try again in 14 seconds')).toBe(14_000);
      expect(extractRetryAfterMs('try again in 60 secs')).toBe(60_000);
    });

    it('parses "try again in N minutes"', () => {
      expect(extractRetryAfterMs('try again in 5 minutes')).toBe(300_000);
      expect(extractRetryAfterMs('try again in 3 mins')).toBe(180_000);
    });

    it('parses "wait N seconds"', () => {
      expect(extractRetryAfterMs('wait 10 seconds before trying again')).toBe(10_000);
      expect(extractRetryAfterMs('please wait 45 secs')).toBe(45_000);
    });

    it('parses "wait for N seconds"', () => {
      expect(extractRetryAfterMs('wait for 20 seconds')).toBe(20_000);
    });

    it('returns undefined for no match', () => {
      expect(extractRetryAfterMs('Rate limit reached')).toBeUndefined();
      expect(extractRetryAfterMs("You've hit your limit · resets 6pm PT")).toBeUndefined();
      expect(extractRetryAfterMs('Taking a quick breather')).toBeUndefined();
      expect(extractRetryAfterMs('')).toBeUndefined();
    });

    it('returns undefined for invalid values', () => {
      expect(extractRetryAfterMs('retry after 0 seconds')).toBeUndefined();
      expect(extractRetryAfterMs('retry after -5 seconds')).toBeUndefined();
    });

    it('handles case insensitivity', () => {
      expect(extractRetryAfterMs('RETRY AFTER 15 SECONDS')).toBe(15_000);
      expect(extractRetryAfterMs('Try Again In 2 Minutes')).toBe(120_000);
    });
  });

  describe('classifyBillingSubtype', () => {
    it('classifies OpenRouter "more credits" responses as credits', () => {
      expect(classifyBillingSubtype(
        '402 {"error":{"message":"This request requires more credits, or fewer max_tokens. You requested up to 4096 tokens, but can only afford 2381.","code":402}}'
      )).toBe('credits');
    });

    it('classifies negative balance before generic credits wording', () => {
      expect(classifyBillingSubtype(
        '402 {"error":{"message":"Your OpenRouter account has a negative balance of -$0.01, so this request requires more credits.","code":402}}'
      )).toBe('negative_balance');
    });

    it('classifies key limit responses as key_limit', () => {
      expect(classifyBillingSubtype(
        '403 {"error":{"message":"Key limit exceeded (daily limit). Manage it using https://openrouter.ai/settings/keys","code":403}}'
      )).toBe('key_limit');
    });

    it('classifies spend cap responses as spend_limit', () => {
      expect(classifyBillingSubtype(
        '400 {"error":{"message":"You have reached your API usage limits. Raise your spending limit to continue.","code":400}}'
      )).toBe('spend_limit');
    });

    // REBEL-5YW: OpenRouter's period spend-cap 402 body contains BOTH the
    // affordability phrasing ("more credits"/"can only afford") AND the cap
    // marker ("monthly limit"). The user has credit but hit a per-key spending
    // cap, so it must surface as key_limit ("raise your limit"), NOT "out of
    // credits". Previously the credits branch was tested first and won.
    it('classifies OpenRouter spend-cap (credits + monthly limit) as key_limit (REBEL-5YW)', () => {
      expect(classifyBillingSubtype(
        '402 {"error":{"message":"This request requires more credits, or fewer max_tokens. You requested up to 128000 tokens, but can only afford 82277. To increase, visit https://openrouter.ai/settings/keys and create a key with a higher monthly limit","code":402}}'
      )).toBe('key_limit');
    });

    // Guard: a genuine depleted-balance 402 (no cap marker) still → credits.
    it('keeps genuine depleted-balance as credits (REBEL-5YW guard)', () => {
      expect(classifyBillingSubtype(
        '402 {"error":{"message":"This request requires more credits, or fewer max_tokens. You requested up to 4096 tokens, but can only afford 2381. To increase, visit https://openrouter.ai/settings/credits and upgrade to a paid account","code":402}}'
      )).toBe('credits');
    });

    it('classifies free-model exhaustion via model id', () => {
      expect(classifyBillingSubtype(
        '429 {"error":{"message":"Free-tier allowance exhausted for today.","code":429}}',
        { modelId: 'google/gemini-2.5-flash:free' },
      )).toBe('free_tier_exhausted');
    });

    it('falls back to unknown for unmatched billing messages', () => {
      expect(classifyBillingSubtype(
        '402 {"error":{"message":"Payment verification required before continuing.","code":402}}'
      )).toBe('unknown');
    });
  });

  describe('isBillingMessage', () => {
    it('should detect existing billing patterns', () => {
      expect(isBillingMessage('Credit balance is too low')).toBe(true);
      expect(isBillingMessage('Insufficient credit in account')).toBe(true);
      expect(isBillingMessage('Billing error: payment declined')).toBe(true);
      expect(isBillingMessage('Error: insufficient_quota')).toBe(true);
    });

    it('should detect OpenRouter "more credits" pattern', () => {
      expect(isBillingMessage('This request requires more credits, or fewer max_tokens')).toBe(true);
    });

    it('should detect OpenRouter "can only afford" pattern', () => {
      expect(isBillingMessage('You can only afford 2381 tokens')).toBe(true);
    });

    it('should detect OpenRouter "key limit" pattern', () => {
      expect(isBillingMessage('Key limit exceeded (daily limit)')).toBe(true);
    });

    it('should detect "daily limit" pattern', () => {
      expect(isBillingMessage('daily limit exceeded')).toBe(true);
    });

    it('should detect "monthly limit" pattern', () => {
      expect(isBillingMessage('monthly limit reached')).toBe(true);
    });

    it('should NOT match unrelated errors', () => {
      expect(isBillingMessage('Connection timeout')).toBe(false);
      expect(isBillingMessage('Internal server error')).toBe(false);
      expect(isBillingMessage('Rate limit exceeded')).toBe(false);
      expect(isBillingMessage('context overflow')).toBe(false);
    });

    describe('OpenAI bare-quota patterns (260421 Stage 3)', () => {
      // Positive: extended patterns must catch the OpenAI 429 insufficient_quota body.
      // See conversation 82d61626-3d3c-4ea2-b369-f2ec7c9531de.
      it('matches the OpenAI canonical bare-quota + plan-and-billing phrase', () => {
        expect(isBillingMessage(
          'You exceeded your current quota, please check your plan and billing details.',
        )).toBe(true);
      });

      it('matches bare "insufficient_quota" token', () => {
        expect(isBillingMessage('insufficient_quota')).toBe(true);
      });

      it('matches bare "quota exceeded — add credits" wording', () => {
        expect(isBillingMessage('quota exceeded — add credits')).toBe(true);
      });

      it('matches "quota" with billing-adjacent co-occurrence (plan)', () => {
        expect(isBillingMessage('Your quota for this plan has been used up.')).toBe(true);
      });

      it('matches "quota" with billing-adjacent co-occurrence (account)', () => {
        expect(isBillingMessage('quota exhausted on this account; add credits')).toBe(true);
      });

      // Negative: rate-limit-adjacent phrasings MUST NOT false-positive.
      // `deriveErrorKind` runs `isBillingMessage` BEFORE `isRateLimitMessage`,
      // so any hit here would silently misclassify rate-limit errors as billing.
      it('does NOT match OpenAI rate-limit "rate limit exceeded" phrasing', () => {
        expect(isBillingMessage('Rate limit exceeded. Please try again in 20s.')).toBe(false);
      });

      it('does NOT match bare "exceeded rate limit"', () => {
        expect(isBillingMessage('exceeded rate limit')).toBe(false);
      });

      it('does NOT match "429 Too Many Requests"', () => {
        expect(isBillingMessage('429 Too Many Requests')).toBe(false);
      });

      it('does NOT match generic Anthropic 429 rate-limit wording', () => {
        expect(isBillingMessage('Rate limit reached for requests per minute')).toBe(false);
      });

      it('does NOT match bare "quota" without billing-adjacent context', () => {
        // A stray "quota" without plan/billing/credit/payment/account co-occurring
        // should not classify as billing — it could be a non-error operational line.
        expect(isBillingMessage('quota counter reset in 5 seconds')).toBe(false);
      });

      // Google Gemini canonical 429 `RESOURCE_EXHAUSTED` body — it contains both
      // "quota" AND "plan" (billing-adjacent), but the "per minute" window
      // qualifier marks it as a rate limit, not billing. Without this guard,
      // Stage 3 would regress a retryable 60-second rate-limit into a
      // non-retryable billing banner. See Round 1 HIGH convergent finding
      // (Opus 88% / Gemini 85% / GPT5.4 93%).
      it('does NOT match Google Gemini RESOURCE_EXHAUSTED with "per minute" quota window', () => {
        const msg =
          "Quota exceeded for quota metric 'generativelanguage.googleapis.com/generate_content_requests' " +
          "and limit 'GenerateContent requests per minute' of service " +
          "'generativelanguage.googleapis.com' for your plan.";
        expect(isBillingMessage(msg)).toBe(false);
      });

      it('does NOT match Google Gemini quota-window phrasing with "per second"', () => {
        expect(
          isBillingMessage(
            'Quota exceeded for quota metric requests per second for your billing plan',
          ),
        ).toBe(false);
      });

      it('does NOT match "per hour" quota-window phrasing even with plan co-occurrence', () => {
        expect(
          isBillingMessage('Quota exceeded: 1000 requests per hour limit for this plan'),
        ).toBe(false);
      });

      // Negative: bare "check your plan" (no "billing" keyword) must not flip
      // to billing. The canonical OpenAI phrase is "check your plan AND
      // billing details" — requiring both tokens keeps the predicate tight.
      it('does NOT match bare "check your plan" without "billing"', () => {
        expect(isBillingMessage('Please check your plan configuration.')).toBe(false);
      });
    });

    // Cross-consumer regression guards: isBillingMessage is shared with
    // isTransientError and classifyStatus. Any silent drift in these consumers
    // would break never-retry-billing and transient-retry semantics.
    describe('isTransientError regression for extended billing patterns (Stage 3)', () => {
      it('treats OpenAI bare-quota billing text as non-transient (never-retry)', () => {
        // Before Stage 3 this was classified as generic-exceed and could slip
        // through as transient. After Stage 3 the extended isBillingMessage
        // MUST suppress it — billing errors never retry (260414/260419).
        expect(
          isTransientError(
            'You exceeded your current quota, please check your plan and billing details.',
          ),
        ).toBe(false);
      });

      it('does NOT treat Google Gemini quota-window text as billing (never-retry trap avoided)', () => {
        // Round 1 HIGH regression guard: the extended billing patterns MUST
        // NOT capture Google's per-minute quota, which would flip it from
        // retryable rate-limit to non-retryable billing. `isTransientError`'s
        // plain-string path can't prove "is rate-limit" without HTTP 429
        // context (see classifyHttpError path in modelErrors.test.ts), but it
        // MUST at least NOT classify as never-retry billing.
        //
        // Concretely: isBillingMessage must be false (otherwise isTransientError
        // early-returns false via the billing gate). Any transient-ness beyond
        // that comes from HTTP status context on the real 429 path.
        const googleText =
          "Quota exceeded for quota metric 'generate_content_requests per minute'";
        expect(isBillingMessage(googleText)).toBe(false);
        // The string lacks "429" / "rate limit" keywords so plain-string
        // isTransientError returns false — but the critical invariant is
        // that it's not BLOCKED by the billing gate (never-retry). Verified
        // via isBillingMessage above.
      });
    });

    describe('existing billing patterns remain green (260421 Stage 3 regression guard)', () => {
      // Belt-and-braces: re-assert the high-value existing positives so the new
      // substring additions can never accidentally weaken them.
      it('still matches "Credit balance is too low"', () => {
        expect(isBillingMessage('Credit balance is too low')).toBe(true);
      });

      it('still matches "Billing error: payment declined"', () => {
        expect(isBillingMessage('Billing error: payment declined')).toBe(true);
      });

      it('still matches OpenRouter 402 "more credits" body', () => {
        expect(isBillingMessage(
          '402 {"error":{"message":"This request requires more credits, or fewer max_tokens."}}',
        )).toBe(true);
      });
    });
  });

  describe('isAuthErrorMessage', () => {
    // ----------------------------------------------------------------
    // POSITIVE cases — genuine auth/credential rejection signals
    // ----------------------------------------------------------------
    describe('positive: genuine auth markers return true', () => {
      it('matches "Invalid authentication" (OpenRouter revoked key)', () => {
        expect(isAuthErrorMessage('Invalid authentication')).toBe(true);
      });

      it('matches "No auth credentials found" (OpenRouter missing key)', () => {
        expect(isAuthErrorMessage('No auth credentials found')).toBe(true);
      });

      it('matches "Invalid API key provided" (OpenAI revoked key)', () => {
        expect(isAuthErrorMessage('Invalid API key provided')).toBe(true);
      });

      it('matches "invalid x-api-key" (OpenAI header variant)', () => {
        expect(isAuthErrorMessage('invalid x-api-key')).toBe(true);
      });

      it('matches "authentication_error" (OpenAI error type token)', () => {
        expect(isAuthErrorMessage('authentication_error')).toBe(true);
      });

      it('matches "Authentication failed"', () => {
        expect(isAuthErrorMessage('Authentication failed')).toBe(true);
      });

      it('matches "Unauthorized"', () => {
        expect(isAuthErrorMessage('Unauthorized')).toBe(true);
      });

      it('is case-insensitive — uppercase variant still matches', () => {
        expect(isAuthErrorMessage('INVALID AUTHENTICATION')).toBe(true);
        expect(isAuthErrorMessage('UNAUTHORIZED')).toBe(true);
        expect(isAuthErrorMessage('AUTHENTICATION FAILED')).toBe(true);
      });
    });

    // ----------------------------------------------------------------
    // NEGATIVE cases — discipline-pinning: must NOT false-positive
    // ----------------------------------------------------------------
    describe('negative: false-positive discipline — must return false', () => {
      // "api key not configured" is workspace-setup copy. The predicate
      // intentionally excludes the bare `api key` substring to avoid matching
      // this setup-guidance message as a credential rejection.
      it('does NOT match "API key not configured" (workspace-setup copy)', () => {
        expect(isAuthErrorMessage('API key not configured')).toBe(false);
      });

      it('does NOT match billing-adjacent "You have insufficient credits to continue"', () => {
        expect(isAuthErrorMessage('You have insufficient credits to continue')).toBe(false);
      });

      it('does NOT match billing-adjacent "Account suspended for non-payment"', () => {
        expect(isAuthErrorMessage('Account suspended for non-payment')).toBe(false);
      });

      it('does NOT match billing "This request requires more credits"', () => {
        expect(isAuthErrorMessage('This request requires more credits')).toBe(false);
      });

      it('does NOT match moderation "Your input was flagged by content moderation"', () => {
        expect(isAuthErrorMessage('Your input was flagged by content moderation')).toBe(false);
      });

      it('does NOT match empty string', () => {
        expect(isAuthErrorMessage('')).toBe(false);
      });
    });
  });
});
