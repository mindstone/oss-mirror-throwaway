import { describe, expect, it } from 'vitest';
import { APIError, APIUserAbortError } from '@anthropic-ai/sdk';
import {
  classifyError,
  classifyHttpError,
  ModelError,
  MODEL_ERROR_KINDS,
  type ModelErrorKind,
} from '../modelErrors';

// ---------------------------------------------------------------------------
// Stage 1.5 — provider ERROR-CLASSIFICATION totality gate
// (cross-module-test-coverage; sibling of validateProviderCredentials.totality).
//
// The bug-in-waiting: the error CLASSIFIER (`classifyHttpError` / `classifyError`
// in modelErrors.ts) maps a `(status, body)` onto a `ModelErrorKind`, but NO test
// asserts that every `ModelErrorKind` is actually PRODUCIBLE — i.e. that there is
// a known input shape that yields it. The existing coverage proves STRUCTURE, not
// behaviour:
//   • `modelErrorFingerprint.test.ts` proves every kind gets a distinct Sentry
//     fingerprint — it iterates `MODEL_ERROR_KINDS` but never calls the classifier.
//   • `providerErrorCorpus.test.ts` drives `classifyHttpError` over a HAND-AUTHORED
//     subset: `it.each(PROVIDER_ERROR_BODY_FIXTURES)` (providerErrorCorpus.test.ts:7)
//     keyed on `$provider`/`$status` strings — NOT `satisfies Record<ModelErrorKind, …>`.
//     A new `ModelErrorKind` added to `MODEL_ERROR_KINDS` gets no fixture there, and
//     the corpus stays GREEN: the kind silently has no proof of which input produces
//     it (and might never be produced at all, or be mis-produced).
//
// That is the silent-fallthrough class behind
//   - 260607_provider_error_misclassification_403_billing (a 403 mis-classified to
//     the generic billing arm instead of its kind), and
//   - 260606_direct_anthropic_self_prefix_reject_auth_mislabel (an error mislabelled
//     because no canonical fixture pinned the correct classification).
//
// This file converts that into a COMPILE error: the map below is
// `satisfies Record<ModelErrorKind, ClassificationCase>`, so adding a new
// `ModelErrorKind` to the union fails to compile here until the author declares
// HOW that kind is produced (a canonical classifier input, or an explicit
// non-HTTP production path + reason). The behavioural `it.each` then drives the
// real classifier for every kind and asserts it yields the declared kind, so a
// classifier regression that stops producing a kind goes RED.
//
// PER-AXIS ONLY (DA descriptor-smell guard): this map classifies the
// `ModelErrorKind` × production-input axis ALONE. It does NOT touch provider
// credential validation (different union — `ActiveProvider`, gated by
// validateProviderCredentials.totality.test.ts), transport assignment, heal
// symmetry, or the humanizer partition (`AgentErrorKind`, already gated by
// humanizeAgentError.test.ts). No god-table; no new production type.
// ---------------------------------------------------------------------------

/**
 * How a given `ModelErrorKind` is produced, and what the classifier must yield.
 *
 * Most kinds are produced by the HTTP classifier from a canonical `(status, body)`.
 * Two kinds are deliberately NOT HTTP-derived: `abort` (raised from an abort
 * signal / `APIUserAbortError`) and `tool_input_too_large` (raised client-side by
 * the streaming guard in anthropicClient.ts when accumulated tool-input bytes
 * exceed the local cap). Those are declared `httpDerivable: false` with a reason,
 * and (for `abort`) exercised via the non-HTTP `classifyError` path below.
 */
type ClassificationCase =
  | {
      /** Produced by `classifyHttpError(status, body, provider)`. */
      httpDerivable: true;
      /** Canonical HTTP status that produces this kind. */
      status: number;
      /** Canonical provider error body (string) that produces this kind. */
      body: string;
      /** Representative `provider` arg, if relevant to classification. */
      provider?: string;
      /** Why this `(status, body)` is the canonical producer of the kind. */
      reason: string;
    }
  | {
      /** NOT produced by the HTTP classifier — raised on a different path. */
      httpDerivable: false;
      /** Where the kind is actually raised (forces a deliberate decision). */
      reason: string;
      /**
       * Construct the ACTUAL value the production path throws/produces for this
       * kind, so the behavioural `it.each` below can route it through the REAL
       * classifier (`classifyError`) and assert the kind — never a hand-asserted
       * constant. Mandatory so every non-HTTP kind is behaviourally exercised
       * (a kind whose producer drifts/disappears goes RED, not silently green).
       */
      produce: () => unknown;
      /** Optional aborted signal to pass to `classifyError` (abort path needs it). */
      signal?: () => AbortSignal;
    };

// EXHAUSTIVE over `ModelErrorKind`. A new kind added to `MODEL_ERROR_KINDS`
// (modelErrors.ts:44) forces a compile error here (the `satisfies` below), so a
// new kind cannot ship without an author declaring HOW it is classified/produced.
const ERROR_CLASSIFICATION_CASES = {
  rate_limit: {
    httpDerivable: true,
    status: 429,
    body: '{"type":"error","error":{"type":"rate_limit_error","message":"Too many requests"}}',
    reason: '429 with an Anthropic-style rate_limit_error type → transient rate_limit.',
  },
  auth: {
    httpDerivable: true,
    status: 401,
    body: '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
    reason: '401 with authentication_error → auth (key problem).',
  },
  billing: {
    httpDerivable: true,
    status: 402,
    body: '{"error":{"message":"This request requires more credits","code":402}}',
    provider: 'OpenRouter',
    reason: '402 (payment required) → non-retryable billing (260607 mis-class class).',
  },
  moderation: {
    httpDerivable: true,
    status: 403,
    body: '{"error":{"message":"Flagged","metadata":{"reasons":["violence"],"flagged_input":"x"}}}',
    provider: 'OpenRouter',
    reason: 'OpenRouter moderation metadata (reasons/flagged_input) → moderation.',
  },
  server_error: {
    httpDerivable: true,
    status: 529,
    body: '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
    reason: '529 overloaded_error (and 5xx generally) → transient server_error.',
  },
  network: {
    httpDerivable: false,
    reason:
      'Client-side transport failure: classifyError reads allowlisted network signals from Error.message/code/cause before the transient server_error fallback.',
    produce: () => Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'ECONNREFUSED' },
    }),
  },
  invalid_request: {
    httpDerivable: true,
    status: 400,
    body: '{"type":"error","error":{"type":"invalid_request_error","message":"bad parameter foo"}}',
    reason: '400 with no billing/context-overflow signal → invalid_request.',
  },
  context_overflow: {
    httpDerivable: true,
    status: 413,
    body: '{"error":{"message":"Payload too large"}}',
    reason: '413 (payload too large) → context_overflow.',
  },
  model_unavailable: {
    httpDerivable: true,
    status: 404,
    body: '{"type":"error","error":{"type":"not_found_error","message":"model: claude-does-not-exist-9"}}',
    reason: '404 not_found_error referencing a model → model_unavailable.',
  },
  image_input_unsupported: {
    httpDerivable: true,
    status: 404,
    body: '{"error":{"message":"No endpoints found that support image input."}}',
    provider: 'OpenRouter',
    reason:
      'OpenRouter 404 "No endpoints found … image input" — pre-empts the not_found→model_unavailable arm (260610).',
  },
  managed_model_not_allowed: {
    httpDerivable: true,
    status: 403,
    body: '{"type":"error","error":{"type":"invalid_request_error","code":"MANAGED_MODEL_NOT_ALLOWED","requested":"anthropic/claude-opus-4","allowed":["anthropic/claude-sonnet-4"]}}',
    provider: 'OpenRouter',
    reason: 'Managed-proxy 403 with code MANAGED_MODEL_NOT_ALLOWED → managed_model_not_allowed.',
  },
  unknown: {
    httpDerivable: true,
    status: 418,
    body: '{"error":{"message":"I am a teapot"}}',
    reason:
      'A status with no structured signal and no transient/heuristic match falls through to unknown (the explicit catch-all, NOT a misclassification).',
  },
  abort: {
    httpDerivable: false,
    reason:
      'Not HTTP-derived: raised from an abort signal / APIUserAbortError in classifyError() and the streaming clients — never produced by classifyHttpError. The PRODUCER here is a generic Error caught while the AbortSignal is aborted (matching the agent-loop cancel path); classifyError maps it via the signal branch (modelErrors.ts:746).',
    signal: () => {
      const c = new AbortController();
      c.abort();
      return c.signal;
    },
    produce: () => new Error('Operation was aborted'),
  },
  tool_input_too_large: {
    httpDerivable: false,
    reason:
      'Not HTTP-derived: raised client-side by the anthropicClient streaming byte-cap guard (anthropicClient.ts:1499-1505) when accumulated tool_use input bytes exceed the local cap — there is no provider HTTP status for it. The PRODUCER below mints the SAME ModelERROR the guard throws; classifyError must return it intact (the instanceof-ModelError short-circuit, modelErrors.ts:744) so recovery handlers see the kind.',
    produce: () =>
      new ModelError(
        'tool_input_too_large',
        "Tool input exceeded streaming cap: tool 'Read' accumulated 9000000 bytes (cap 8388608). The input likely contained a large inline payload such as base64 file data. Consider using a file path reference instead of inlining bytes.",
        undefined,
        'anthropic',
        {
          details: {
            toolName: 'Read',
            toolUseId: 'toolu_test',
            bytesAccumulated: 9_000_000,
            capBytes: 8_388_608,
            blockIndex: 0,
          },
        },
      ),
  },
} satisfies Record<ModelErrorKind, ClassificationCase>;

describe('provider error CLASSIFICATION totality gate', () => {
  it('classifies every ModelErrorKind (a new kind fails to compile until its production path is declared)', () => {
    // The `satisfies Record<ModelErrorKind, …>` above is the real teeth; this
    // runtime check guards against a duplicated/empty map and pins union
    // membership so the silent "new kind has no canonical input" gap can never
    // re-appear. Mirrors the union sync that modelErrorFingerprint.test.ts pins.
    expect(Object.keys(ERROR_CLASSIFICATION_CASES).sort()).toEqual([...MODEL_ERROR_KINDS].sort());
  });

  const httpEntries = (
    Object.entries(ERROR_CLASSIFICATION_CASES) as Array<[ModelErrorKind, ClassificationCase]>
  ).filter((entry): entry is [ModelErrorKind, Extract<ClassificationCase, { httpDerivable: true }>] =>
    entry[1].httpDerivable,
  );

  it.each(httpEntries)(
    "kind '%s' is actually PRODUCED by classifyHttpError from its canonical (status, body)",
    (kind, cse) => {
      const error = classifyHttpError(cse.status, cse.body, cse.provider);
      expect(error).toBeInstanceOf(ModelError);
      expect(
        error.kind,
        `classifyHttpError(${cse.status}, …) must yield kind '${kind}' (${cse.reason}) — got '${error.kind}'`,
      ).toBe(kind);
    },
  );

  const nonHttpEntries = (
    Object.entries(ERROR_CLASSIFICATION_CASES) as Array<[ModelErrorKind, ClassificationCase]>
  ).filter((entry): entry is [ModelErrorKind, Extract<ClassificationCase, { httpDerivable: false }>] =>
    !entry[1].httpDerivable,
  );

  it.each(nonHttpEntries)(
    "non-HTTP kind '%s' is actually PRODUCED by its real producer and routed through classifyError() to the declared kind",
    (kind, cse) => {
      // Drive the REAL classifier with the ACTUAL value the production path
      // throws (not a hand-asserted constant). A producer that drifts/disappears
      // — or a classifyError change that stops mapping it — turns this RED.
      const error = classifyError(cse.produce(), cse.signal?.());
      expect(error).toBeInstanceOf(ModelError);
      expect(
        error.kind,
        `classifyError(<real ${kind} producer>) must yield kind '${kind}' (${cse.reason}) — got '${error.kind}'`,
      ).toBe(kind);
    },
  );

  it("the non-HTTP kind 'abort' is also produced by the SDK's APIUserAbortError even without a signal", () => {
    // Complements the map-driven assertion above (which uses the aborted-signal
    // branch): the APIUserAbortError instanceof branch is a SECOND code path.
    expect(classifyError(new APIUserAbortError()).kind).toBe('abort');
  });

  it('the SDK classifier (classifyError over APIError) produces the same kind as the HTTP classifier for a representative kind', () => {
    // Symmetry sentinel: classifyError(APIError) and classifyHttpError must not
    // drift for the same upstream shape (the 260606/260607 mislabel class spans
    // BOTH entry points). Uses the auth case as the representative.
    const authCase = ERROR_CLASSIFICATION_CASES.auth;
    const apiError = new APIError(
      authCase.status,
      JSON.parse(authCase.body) as Record<string, unknown>,
      'invalid x-api-key',
      undefined,
    );
    expect(classifyError(apiError).kind).toBe('auth');
    expect(classifyHttpError(authCase.status, authCase.body).kind).toBe('auth');
  });
});
