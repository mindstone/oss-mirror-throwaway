import { describe, expect, it } from 'vitest';
import {
  AnthropicError,
  APIError,
  APIConnectionError,
  APIConnectionTimeoutError,
  APIUserAbortError,
} from '@anthropic-ai/sdk';
import { classifyError, classifyHttpError, type ModelErrorKind } from '../modelErrors';

// ---------------------------------------------------------------------------
// WS4 Component 2 — per-transport error/retry CONFORMANCE suite.
//
// Today Rebel runs TWO transports for model traffic:
//   • raw `fetch` + Rebel-owned StreamLifecycle for the real-provider egress
//     (OpenRouter / Codex / Anthropic) — errors flow through classifyHttpError(status, body).
//   • the Anthropic SDK for the ONE hop executor `AnthropicClient` -> localhost proxy —
//     errors arrive as SDK error objects and flow through classifyError(err).
//
// This file PINS the retry-relevant classification (`kind` + `isTransient`) that
// each transport produces for the canonical transport scenarios: connection
// timeout, 429 rate-limit, 5xx server errors, 401/403 auth/billing, user abort,
// and offline/DNS failure. It is the regression net for the deep Component 2
// follow-on ("drop the Anthropic SDK for non-Anthropic routes"): a Rebel-owned
// transport that replaces the SDK MUST reproduce the SAME (kind, isTransient)
// verdicts asserted here, so it can be diffed against this baseline.
//
// All cases pin CURRENT behaviour. Two refinements are pinned here: (1) the
// connection-timeout MESSAGE case is transient (the confirmed turn-hang fix);
// (2) recognised transport errnos (ENOTFOUND / ECONNREFUSED / ECONNRESET /
// ETIMEDOUT / fetch-failed) mint the dedicated `network` kind rather than
// server_error (REBEL-6B6/FOX-3513 — a local-network failure is not a provider
// failure). Both are pinned as the contract a future Rebel-owned transport must
// honour. A timeout MESSAGE with no transport errno stays server_error.
//
// Scope discipline: retry-decision axis only (kind + isTransient). Billing
// subtype, reset-timing, output-cap parsing, and structured-body totality are
// covered by their own suites (providerErrorCorpus, providerErrorClassification
// .totality, modelErrors). No god-table; no duplication of those axes.
// ---------------------------------------------------------------------------

type Verdict = { kind: ModelErrorKind; isTransient: boolean };

describe('transport error conformance — raw-fetch HTTP transport (classifyHttpError)', () => {
  const httpCases: Array<{ name: string; status: number; body: string; expect: Verdict }> = [
    {
      name: '429 rate-limit (no quota signal) -> rate_limit, transient',
      status: 429,
      body: JSON.stringify({ error: { type: 'rate_limit_error', message: 'Rate limit exceeded' } }),
      expect: { kind: 'rate_limit', isTransient: true },
    },
    {
      name: '500 internal server error -> server_error, transient',
      status: 500,
      body: JSON.stringify({ error: { type: 'api_error', message: 'Internal server error' } }),
      expect: { kind: 'server_error', isTransient: true },
    },
    {
      name: '502 bad gateway -> server_error, transient',
      status: 502,
      body: 'Bad Gateway',
      expect: { kind: 'server_error', isTransient: true },
    },
    {
      name: '503 service unavailable -> server_error, transient',
      status: 503,
      body: JSON.stringify({ error: { type: 'overloaded_error', message: 'Overloaded' } }),
      expect: { kind: 'server_error', isTransient: true },
    },
    {
      name: '401 unauthorized -> auth, NON-transient',
      status: 401,
      body: JSON.stringify({ error: { type: 'authentication_error', message: 'invalid x-api-key' } }),
      expect: { kind: 'auth', isTransient: false },
    },
    {
      name: '403 forbidden (no auth/moderation signal) -> billing, NON-transient',
      status: 403,
      body: JSON.stringify({ error: { message: 'Forbidden' } }),
      expect: { kind: 'billing', isTransient: false },
    },
    {
      name: '402 payment required -> billing, NON-transient',
      status: 402,
      body: JSON.stringify({ error: { message: 'Payment required' } }),
      expect: { kind: 'billing', isTransient: false },
    },
    {
      name: '400 invalid request -> invalid_request, NON-transient',
      status: 400,
      body: JSON.stringify({ error: { type: 'invalid_request_error', message: 'Stream must be true' } }),
      expect: { kind: 'invalid_request', isTransient: false },
    },
    {
      name: '429 + quota-exhaustion body -> billing (NOT rate_limit), NON-transient',
      status: 429,
      body: JSON.stringify({ error: { type: 'rate_limit_error', code: 'usage_limit_reached', message: 'quota' } }),
      expect: { kind: 'billing', isTransient: false },
    },
  ];

  it.each(httpCases)('$name', ({ status, body, expect: e }) => {
    const err = classifyHttpError(status, body, 'OpenRouter');
    expect(err.kind).toBe(e.kind);
    expect(err.isTransient).toBe(e.isTransient);
  });
});

describe('transport error conformance — Anthropic SDK transport (classifyError)', () => {
  it('connection TIMEOUT (APIConnectionTimeoutError) -> server_error, transient [turn-hang fix]', () => {
    const err = classifyError(new APIConnectionTimeoutError());
    expect(err.kind).toBe('server_error');
    expect(err.isTransient).toBe(true);
  });

  it('connection ERROR (APIConnectionError, offline/DNS) -> network, transient', () => {
    // The SDK wraps a network-layer failure (DNS/connect) as APIConnectionError
    // with status=undefined; its `cause` carries the underlying Node error.
    // The ENOTFOUND errno in the cause mints the dedicated `network` kind
    // (REBEL-6B6/FOX-3513: a transport failure must not be misclassified as a
    // provider server_error).
    const err = classifyError(
      new APIConnectionError({ message: 'Connection error.', cause: new Error('getaddrinfo ENOTFOUND') }),
    );
    expect(err.kind).toBe('network');
    expect(err.isTransient).toBe(true);
  });

  it('429 rate-limit (RateLimitError) -> rate_limit, transient', () => {
    const err = classifyError(new APIError(429, undefined as never, 'Rate limited', undefined));
    expect(err.kind).toBe('rate_limit');
    expect(err.isTransient).toBe(true);
  });

  it('500 internal server error (APIError) -> server_error, transient', () => {
    const err = classifyError(new APIError(500, undefined as never, 'Internal Server Error', undefined));
    expect(err.kind).toBe('server_error');
    expect(err.isTransient).toBe(true);
  });

  it('503 service unavailable (APIError) -> server_error, transient', () => {
    const err = classifyError(new APIError(503, undefined as never, 'Service Unavailable', undefined));
    expect(err.kind).toBe('server_error');
    expect(err.isTransient).toBe(true);
  });

  it('401 unauthorized (APIError) -> auth, NON-transient', () => {
    const err = classifyError(new APIError(401, undefined as never, 'Unauthorized', undefined));
    expect(err.kind).toBe('auth');
    expect(err.isTransient).toBe(false);
  });

  it('403 forbidden (APIError, no moderation/auth signal) -> billing, NON-transient', () => {
    const err = classifyError(new APIError(403, undefined as never, 'Forbidden', undefined));
    expect(err.kind).toBe('billing');
    expect(err.isTransient).toBe(false);
  });

  it('user abort (APIUserAbortError) -> abort, NON-transient', () => {
    const err = classifyError(new APIUserAbortError());
    expect(err.kind).toBe('abort');
    expect(err.isAbort).toBe(true);
    expect(err.isTransient).toBe(false);
  });

  it('aborted AbortSignal -> abort, NON-transient', () => {
    const ac = new AbortController();
    ac.abort();
    const err = classifyError(new Error('whatever'), ac.signal);
    expect(err.kind).toBe('abort');
    expect(err.isTransient).toBe(false);
  });

  it('SDK stream-lifecycle drop (AnthropicError, not APIError) -> server_error, transient', () => {
    const err = classifyError(new AnthropicError('request ended without sending any chunks'));
    expect(err.kind).toBe('server_error');
    expect(err.isTransient).toBe(true);
  });
});

describe('transport error conformance — bare Node network errors (generic Error path)', () => {
  // Both transports can surface a raw Node error (e.g. before any HTTP/SDK
  // wrapping). These pin the offline/DNS + timeout retry verdicts.
  const networkCases: Array<{ name: string; message: string; expect: Verdict }> = [
    // Transport errnos mint the dedicated `network` kind (REBEL-6B6/FOX-3513): a
    // local-network failure must not be misclassified as a provider server_error.
    { name: 'ENOTFOUND (DNS) -> network, transient', message: 'getaddrinfo ENOTFOUND api.example', expect: { kind: 'network', isTransient: true } },
    { name: 'ECONNREFUSED -> network, transient', message: 'connect ECONNREFUSED 127.0.0.1:443', expect: { kind: 'network', isTransient: true } },
    { name: 'ECONNRESET -> network, transient', message: 'socket hang up ECONNRESET', expect: { kind: 'network', isTransient: true } },
    { name: 'ETIMEDOUT (Node code) -> network, transient', message: 'connect ETIMEDOUT', expect: { kind: 'network', isTransient: true } },
    // A timeout MESSAGE with no transport errno is retryable but is NOT a network
    // errno, so it stays server_error — distinct from the errno cases above.
    { name: 'bare "Request timed out." (timeout message) -> server_error, transient', message: 'Request timed out.', expect: { kind: 'server_error', isTransient: true } },
    { name: 'fetch failed -> network, transient', message: 'TypeError: fetch failed', expect: { kind: 'network', isTransient: true } },
    { name: 'genuinely unknown -> unknown, NON-transient', message: 'something completely unexpected', expect: { kind: 'unknown', isTransient: false } },
  ];

  it.each(networkCases)('$name', ({ message, expect: e }) => {
    const err = classifyError(new Error(message));
    expect(err.kind).toBe(e.kind);
    expect(err.isTransient).toBe(e.isTransient);
  });
});
