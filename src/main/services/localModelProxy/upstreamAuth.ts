/**
 * Central upstream-auth injector for the Local Model Proxy (Stage 13).
 *
 * Part of the CHIEF_ENGINEER2 hotspot-refactor roadmap
 * (`docs/plans/260526_hotspot-refactor-roadmap/PLAN.md`, Stage 13).
 *
 * THE PROXY IS THE AUTH BOUNDARY. Every passthrough / forwarding handler that
 * egresses to a real upstream provider MUST resolve auth from the proxy's
 * source-of-truth and inject it here — never forward a client-supplied
 * credential, never re-implement the strip/inject dance inline. Before Stage 13
 * the strip (`delete headers['authorization']`) and the inject (`headers[...] =
 * Bearer ...`) were duplicated across five handlers (Anthropic passthrough,
 * OpenRouter passthrough, profile/council Bearer, Responses-API Bearer, Codex
 * OAuth). Each duplicate was an independent chance to regress the symmetry — the
 * exact class of bug PM 260430 hit (Anthropic passthrough forwarded the SDK
 * sentinel `x-api-key: proxy-handles-auth` to api.anthropic.com → 401s).
 *
 * This module is the SINGLE named home for that injection. `injectUpstreamAuth`
 * takes a typed {@link CredentialPlan} (the `authPlan` axis of
 * `RequestClassification`, made concrete with the resolved credential) and a
 * mutable headers map, and:
 *   1. ALWAYS strips any inbound `x-api-key` / `authorization` first (defence:
 *      no client/proxy credential survives, including the
 *      `PROXY_HANDLES_AUTH_SENTINEL`), then
 *   2. injects the upstream-correct credential for the target host.
 *
 * A mechanical CI check (`scripts/check-proxy-auth-translator-centralization.ts`)
 * asserts that the raw strip / inject patterns appear ONLY inside this module —
 * so a future handler cannot quietly re-introduce an inline asymmetric path.
 *
 * Boundary note: this module is reached by the cloud bootstrap
 * (`cloud-service/src/bootstrap.ts` → `proxyManager` from `src/main`), so it MUST
 * NOT import `electron`. All dependencies are `@core` / `@shared`.
 *
 * Postmortem: `docs/plans/260430_eval_harness_recovery_and_anthropic_auth_fix.md`.
 * Contract: `src/core/rebelCore/proxyAuthContract.ts`.
 * Boundary-registry: `proxy-passthrough-auth-symmetry`.
 *
 * @see docs/project/PROXY_AUTH_BOUNDARY.md — the single sanctioned strip/inject site and the CredentialPlan union
 */

/**
 * The resolved credential plan for an upstream egress. This is the `authPlan`
 * axis of {@link import('./classifier').RequestClassification} made concrete:
 * the classifier pins WHICH plan (`codex-oauth` / `openrouter-bearer` /
 * `route-resolved`); the handler resolves the actual secret and hands the
 * matching variant here.
 *
 * Discriminated on `kind` so a new auth shape (e.g. a future per-host header
 * scheme) is a compile error at the injector rather than a silently-unhandled
 * branch.
 */
export type CredentialPlan =
  | {
      /**
       * Anthropic direct passthrough. Injects `x-api-key` from the proxy's
       * persisted Anthropic credential. (`handleAnthropicPassthrough`,
       * PM 260430.)
       */
      kind: 'anthropic-x-api-key';
      apiKey: string;
    }
  | {
      /**
       * OpenRouter passthrough. Injects `Authorization: Bearer <orKey>`.
       * (`handleOpenRouterPassthrough`.)
       */
      kind: 'openrouter-bearer';
      apiKey: string;
    }
  | {
      /**
       * Route-resolved profile / council-member / Responses-API egress. Injects
       * `Authorization: Bearer <effectiveKey>` when a key is present; a local
       * loopback profile may have no key (`effectiveKey === undefined`), in
       * which case no auth header is set — matching the prior inline `if
       * (effectiveKey)` behaviour byte-for-byte.
       */
      kind: 'profile-bearer';
      bearerToken: string | undefined;
    }
  | {
      /**
       * Codex Responses OAuth egress. Injects `Authorization: Bearer
       * <accessToken>` and, when present, `openai-organization: <accountId>`.
       * (`forwardToCodexModel` / `handleCodexStreamingRequest`.)
       */
      kind: 'codex-oauth';
      accessToken: string;
      accountId: string | null;
    };

/** The header names this injector owns. Exported for the CI centralization check. */
export const CLIENT_AUTH_HEADER_NAMES = ['x-api-key', 'authorization'] as const;

/**
 * Strip any inbound/client-supplied auth headers from a forwarding map.
 *
 * Always run before injecting upstream auth so no client credential (nor the
 * proxy-internal `PROXY_HANDLES_AUTH_SENTINEL`) can survive to the upstream.
 * Idempotent; safe on a header map that has none.
 *
 * This is the ONLY sanctioned place the raw `delete headers['x-api-key' |
 * 'authorization']` lives (the CI centralization check enforces it).
 *
 * Exported for the Anthropic fail-closed path (`injectAnthropicUpstreamAuth`
 * returns false when no key is configured): it must still strip the inbound
 * credential without injecting any upstream one.
 */
export function stripClientAuthHeaders(headers: Record<string, string>): void {
  delete headers['x-api-key'];
  delete headers['authorization'];
}

/**
 * Inject the upstream-correct credential into a forwarding headers map.
 *
 * ALWAYS strips inbound client auth first, then sets the host-appropriate
 * credential. Mutates `headers` in place (matching the prior inline handlers)
 * and returns it for call-site convenience.
 *
 * Behaviour-preserving consolidation of the five prior inline injectors — the
 * outbound header bytes are identical per branch:
 *   - anthropic-x-api-key → `x-api-key = apiKey`
 *   - openrouter-bearer   → `authorization = Bearer apiKey`
 *   - profile-bearer      → `Authorization = Bearer bearerToken` iff present
 *   - codex-oauth         → `Authorization = Bearer accessToken` (+ optional
 *                           `openai-organization = accountId`)
 *
 * NOTE the casing difference is preserved intentionally: the Anthropic/OR
 * passthrough handlers wrote lowercase `authorization` (they build from the
 * incoming Node-lowercased header map), while the profile/Codex handlers built
 * fresh maps with capitalised `Authorization`. fetch() treats header names
 * case-insensitively, so this is cosmetic — but we keep each branch's original
 * casing so the change is provably byte-identical against the existing tests.
 */
export function injectUpstreamAuth(
  headers: Record<string, string>,
  plan: CredentialPlan,
): Record<string, string> {
  stripClientAuthHeaders(headers);

  switch (plan.kind) {
    case 'anthropic-x-api-key':
      headers['x-api-key'] = plan.apiKey;
      return headers;
    case 'openrouter-bearer':
      headers['authorization'] = `Bearer ${plan.apiKey}`;
      return headers;
    case 'profile-bearer':
      if (plan.bearerToken) {
        headers['Authorization'] = `Bearer ${plan.bearerToken}`;
      }
      return headers;
    case 'codex-oauth':
      headers['Authorization'] = `Bearer ${plan.accessToken}`;
      if (plan.accountId) {
        headers['openai-organization'] = plan.accountId;
      }
      return headers;
  }
}
