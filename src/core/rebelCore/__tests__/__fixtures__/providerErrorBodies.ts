import type { BillingSubtype } from '@shared/utils/friendlyErrors';
import type { ModelErrorKind } from '../../modelErrors';

export interface ProviderErrorBodyFixture {
  id: string;
  provider: string;
  cause: string;
  status: number;
  body: string;
  expected: {
    kind: ModelErrorKind;
    billingSubtype?: BillingSubtype;
  };
}

// Real provider/proxy error bodies harvested from modelErrors.test.ts,
// friendlyErrors.test.ts, and the provider-error postmortem. New provider
// strings should be added here first, then covered by the corpus test, instead
// of becoming one-off incident tests that drift from the classifier contract.
export const PROVIDER_ERROR_BODY_FIXTURES: readonly ProviderErrorBodyFixture[] = [
  {
    id: 'openrouter-auth-invalid-authentication-403',
    provider: 'OpenRouter',
    cause: 'auth',
    status: 403,
    body: '{"error":{"message":"Invalid authentication"}}',
    expected: { kind: 'auth' },
  },
  {
    id: 'openrouter-auth-no-credentials-403',
    provider: 'OpenRouter',
    cause: 'auth',
    status: 403,
    body: '{"error":{"message":"No auth credentials found"}}',
    expected: { kind: 'auth' },
  },
  {
    id: 'openrouter-structured-auth-code-403',
    provider: 'OpenRouter',
    cause: 'auth',
    status: 403,
    body: '{"error":{"message":"Provider rejected the request","code":"invalid_api_key"}}',
    expected: { kind: 'auth' },
  },
  {
    id: 'openai-auth-invalid-api-key-403',
    provider: 'OpenAI',
    cause: 'auth',
    status: 403,
    body: '{"error":{"message":"Invalid API key provided"}}',
    expected: { kind: 'auth' },
  },
  {
    id: 'openai-structured-auth-type-403',
    provider: 'OpenAI',
    cause: 'auth',
    status: 403,
    body: '{"error":{"type":"authentication_error","message":"Provider rejected the request"}}',
    expected: { kind: 'auth' },
  },
  {
    id: 'anthropic-authentication-error-401',
    provider: 'Anthropic',
    cause: 'auth',
    status: 401,
    body: '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"},"request_id":"req_123"}',
    expected: { kind: 'auth' },
  },
  {
    id: 'openrouter-credits-402-rebel-1cg',
    provider: 'OpenRouter',
    cause: 'billing_credits',
    status: 402,
    body: '{"error":{"message":"This request requires more credits, or fewer max_tokens. You requested up to 4096 tokens, but can only afford 2381. To increase, visit https://openrouter.ai/settings/credits and upgrade to a paid account","code":402,"metadata":{"provider_name":null}},"user_id":"user_39q36wYfdGqH0kbEtjqBjUVcPGE"}',
    expected: { kind: 'billing', billingSubtype: 'credits' },
  },
  {
    id: 'openrouter-key-spend-cap-402-rebel-5yw',
    provider: 'OpenRouter',
    cause: 'billing_key_limit',
    status: 402,
    body: '{"error":{"message":"This request requires more credits, or fewer max_tokens. You requested up to 128000 tokens, but can only afford 82277. To increase, visit https://openrouter.ai/settings/keys and create a key with a higher monthly limit","code":402,"metadata":{"provider_name":null}},"user_id":"user_3CTh43dEjP4aAGrN1KZU72IVBL4"}',
    expected: { kind: 'billing', billingSubtype: 'key_limit' },
  },
  {
    id: 'openrouter-key-limit-403-rebel-1bp',
    provider: 'OpenRouter',
    cause: 'billing_key_limit',
    status: 403,
    body: '{"error":{"message":"Key limit exceeded (daily limit). Manage it using https://openrouter.ai/settings/keys","code":403}}',
    expected: { kind: 'billing', billingSubtype: 'key_limit' },
  },
  {
    id: 'openrouter-billing-no-auth-marker-403',
    provider: 'OpenRouter',
    cause: 'billing',
    status: 403,
    body: '{"error":{"message":"Account suspended for non-payment"}}',
    expected: { kind: 'billing', billingSubtype: 'unknown' },
  },
  {
    id: 'openai-insufficient-quota-429',
    provider: 'OpenAI',
    cause: 'billing_quota',
    status: 429,
    body: '{"error":{"type":"insufficient_quota","code":"insufficient_quota","message":"You exceeded your current quota, please check your plan and billing details."}}',
    expected: { kind: 'billing', billingSubtype: 'unknown' },
  },
  {
    id: 'codex-usage-limit-reached-429',
    provider: 'Codex',
    cause: 'billing_quota',
    status: 429,
    body: '{"error":{"type":"usage_limit_reached","message":"The usage limit has been reached","plan_type":"team","resets_at":1893456000}}',
    expected: { kind: 'billing', billingSubtype: 'unknown' },
  },
  {
    id: 'anthropic-credit-balance-400-rebel-1ar',
    provider: 'Anthropic',
    cause: 'billing_credits',
    status: 400,
    body: '{"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}',
    expected: { kind: 'billing', billingSubtype: 'credits' },
  },
  {
    id: 'anthropic-api-usage-limit-400',
    provider: 'Anthropic',
    cause: 'billing_spend_limit',
    status: 400,
    body: '{"type":"error","error":{"type":"invalid_request_error","message":"You have reached your specified API usage limits. You will regain access on 2026-02-01 at 00:00 UTC."},"request_id":"req_123"}',
    expected: { kind: 'billing', billingSubtype: 'spend_limit' },
  },
  {
    id: 'openrouter-moderation-metadata-403',
    provider: 'OpenRouter',
    cause: 'moderation',
    status: 403,
    body: '{"error":{"message":"Flagged","metadata":{"reasons":["violence"],"flagged_input":"please help"}}}',
    expected: { kind: 'moderation' },
  },
  {
    id: 'openrouter-managed-model-not-allowed-403',
    provider: 'OpenRouter',
    cause: 'managed_model_not_allowed',
    status: 403,
    body: '{"type":"error","error":{"type":"invalid_request_error","code":"MANAGED_MODEL_NOT_ALLOWED","requested":"anthropic/claude-opus-4","allowed":["anthropic/claude-sonnet-4","openai/gpt-5"]}}',
    expected: { kind: 'managed_model_not_allowed' },
  },
  {
    id: 'anthropic-not-found-model-404',
    provider: 'Anthropic',
    cause: 'model_unavailable',
    status: 404,
    body: '{"type":"error","error":{"type":"not_found_error","message":"model: claude-does-not-exist-9"}}',
    expected: { kind: 'model_unavailable' },
  },
  {
    id: 'anthropic-permission-model-access-403',
    provider: 'Anthropic',
    cause: 'model_unavailable',
    status: 403,
    body: '{"type":"error","error":{"type":"permission_error","message":"You do not have access to the model with the specified model ID."}}',
    expected: { kind: 'model_unavailable' },
  },
  {
    id: 'openai-not-chat-model-404-rebel-1d9',
    provider: 'OpenAI',
    cause: 'model_unavailable',
    status: 404,
    body: '{"error":{"message":"This is not a chat model and thus not supported in the v1/chat/completions endpoint. Did you mean to use v1/completions?","type":"invalid_request_error","param":null,"code":null}}',
    expected: { kind: 'model_unavailable' },
  },
  {
    id: 'anthropic-context-reduction-400-rebel-1bf',
    provider: 'Anthropic',
    cause: 'context_overflow',
    status: 400,
    body: '{"type":"error","error":{"details":null,"type":"invalid_request_error","message":"context reduction is suggested"},"request_id":"req_011Ca9jSXf7cx5H8ssiZnmJ2"}',
    expected: { kind: 'context_overflow' },
  },
  {
    id: 'anthropic-rate-limit-429',
    provider: 'Anthropic',
    cause: 'rate_limit',
    status: 429,
    body: '{"type":"error","error":{"type":"rate_limit_error","message":"Too many requests"}}',
    expected: { kind: 'rate_limit' },
  },
  {
    id: 'google-gemini-resource-exhausted-429',
    provider: 'Google Gemini',
    cause: 'rate_limit',
    status: 429,
    body: `{"error":{"code":429,"message":"Quota exceeded for quota metric 'generativelanguage.googleapis.com/generate_content_requests' and limit 'GenerateContent requests per minute' of service 'generativelanguage.googleapis.com' for your plan.","status":"RESOURCE_EXHAUSTED"}}`,
    expected: { kind: 'rate_limit' },
  },
  {
    id: 'anthropic-overloaded-529',
    provider: 'Anthropic',
    cause: 'server_error',
    status: 529,
    body: '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
    expected: { kind: 'server_error' },
  },
] as const;
