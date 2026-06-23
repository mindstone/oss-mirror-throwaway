/**
 * Proxy Auth Contract
 *
 * Shared producer/consumer contract for the local proxy's "proxy handles auth"
 * pattern. The local proxy server (desktop-only, `src/main/services/
 * localModelProxyServer.ts`) is the authoritative auth boundary for all
 * proxy-routed upstream requests. The SDK side (`src/core/rebelCore/
 * clientFactory.ts`) constructs `AnthropicClient` with a sentinel API key —
 * the real credential is injected by the proxy at egress time.
 *
 * Producers:
 * - `clientFactory.ts:createModelClient` — sets `apiKey: PROXY_HANDLES_AUTH_SENTINEL`
 *   when the proxy has identified itself via Codex/OpenRouter/route-table headers.
 *
 * Consumers:
 * - `localModelProxyServer.ts:handleAnthropicPassthrough` — strips inbound auth
 *   and re-injects from settings.
 * - `localModelProxyServer.ts:handleOpenRouterPassthrough` — same pattern with
 *   OpenRouter Bearer.
 * - `localModelProxyServer.ts` Codex passthrough — same pattern with Codex
 *   OAuth token.
 * - `localModelProxyServer.ts` council-member routing (`forwardToLocalModel` /
 *   `handleStreamingRequest`) — same pattern with profile API key.
 *
 * Invariant (enforced by `localModelProxyServer.crossHandlerAuth.test.ts`):
 *   No client-supplied `x-api-key` or `authorization` header survives any of
 *   the 4 proxy passthrough handlers' upstream emission. Auth must always be
 *   resolved at the proxy boundary.
 *
 * History: this constant was inlined as a string literal until 2026-05-01 when
 * the eval-harness recovery plan
 * (`docs/plans/260430_eval_harness_recovery_and_anthropic_auth_fix.md` Stage 2)
 * extracted it after a sentinel-leak bug was diagnosed in
 * `handleAnthropicPassthrough` (the only handler that didn't honor the
 * proxy-side half of the contract).
 */

export const PROXY_HANDLES_AUTH_SENTINEL = 'proxy-handles-auth' as const;

export type ProxyHandlesAuthSentinel = typeof PROXY_HANDLES_AUTH_SENTINEL;
