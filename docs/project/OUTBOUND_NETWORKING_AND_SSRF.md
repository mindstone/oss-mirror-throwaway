---
description: "Outbound HTTP reliability and SSRF hardening — DNS decoupling, retry bounds, and pinned-dispatcher connect-to-validated-IP"
last_updated: "2026-06-21"
---

# Outbound Networking and SSRF

Focused reference for how Rebel chooses outbound HTTP DNS resolution and closes DNS-rebinding SSRF windows. Covers the OS-resolver default, c-ares rollback/cloud mode, bounded retry storms, and per-request pinned undici dispatchers.

**Why this matters:** Node's OS resolver (`dns.lookup` / getaddrinfo) honors OS-scoped and VPN split-DNS rules, while c-ares can bypass that resolver configuration. c-ares still has a place as an opt-in/cacheable off-threadpool resolver for cloud and rollback. Separately, validating a hostname then connecting by name leaves a DNS-rebinding time-of-check/time-of-use gap unless the socket is pinned to the already-validated IP.

## See also

- [RESILIENCE_TO_CONNECTIVITY_AND_CRASHES](./RESILIENCE_TO_CONNECTIVITY_AND_CRASHES.md) — user-visible reconnect behaviour; §5 signposts here for DNS decouple
- [PLUGINS_SECURITY](./PLUGINS_SECURITY.md) — plugin `external-fetch` SSRF layers
- [REBEL_CORE](./REBEL_CORE.md) — built-in `WebFetch` tool
- Planning: `docs/plans/260617_meeting-bot-dns-starvation/PLAN.md`

---

## Outbound DNS Resolver Choice

**Intent:** Centralize undici connect-time hostname resolution so desktop honors VPN split-DNS by default while c-ares remains one env flag away for rollback and cloud.

**Mechanism:**

- By default, `installGlobalUndiciDnsDecouple()` in `src/core/utils/dnsThreadpoolDecouple.ts` leaves undici on Node's OS resolver (`dns.lookup` / getaddrinfo).
- `REBEL_HTTP_RESOLVER=cares` or `REBEL_DNS_DECOUPLE=1` opts into a global undici `Agent` whose `connect.lookup` is `getDecoupledLookup()` — cacheable c-ares resolution (`cacheable-lookup` / `dns.resolve4/6`) with **`dns.lookup` fallback** for `/etc/hosts`, `.local`, and names c-ares cannot answer.
- **Wired at boot** before any outbound HTTP:
  - Desktop: `src/main/bootstrap.ts`
  - Cloud: `cloud-service/src/installDnsDecouple.ts` (leaf import before `bootstrap`) plus idempotent re-call in `cloud-service/src/bootstrap.ts`; Fly deploy env sets `REBEL_HTTP_RESOLVER=cares`.
- MCP uses its own undici `Agent` — `src/core/rebelCore/mcpClient.ts` reads the same resolver selector because it is not covered by the global dispatcher.
- **Lint guard:** `eslint.config.mjs` blocks new undici dispatchers unless they route through the centralized resolver choice (escape via `dns-decouple-justified` comment when lookup is pinned or selector-driven by construction).

**SSRF interaction:** Pre-fetch validation in `src/core/utils/ssrfProtection.ts` still runs `dns.resolve4/6` before connect; resolver selection only changes connect-time resolution and does not bypass validation.

---

## Meeting-bot transcript-save retry bounds

**Intent:** Prevent a failed transcript save from re-running on every poll/startup without spacing or caps — a retry storm that amplified libuv pool saturation.

**Mechanism** (`src/main/services/meetingBot/pendingTranscriptsStore.ts`, `retryUnsavedTranscripts()` in `src/main/services/meetingBot/meetingBotService.ts`):

- **`saveAttempts`** incremented only on real save failures that should count toward exhaustion (not on transient network blips that use backoff alone).
- **Caps:** `MAX_SAVE_ATTEMPTS` (6) and `MAX_RETRY_HOURS` (24) with `retryWindowStartedAt` anchored to first failure so the duration cap survives restarts.
- **Backoff:** `setNextRetryTime()` / `nextRetryAt` spacing; auth-not-ready is the sole no-backoff transient.
- **Concurrency:** `MAX_TRANSCRIPT_RETRY_CONCURRENCY` (3) limits parallel retry fan-out.
- **Telemetry:** terminal-failure and retry-batch summary logging for runaway detection.

---

## Codex proxy — single retry on pre-response network blip

**Intent:** A single thrown network error before any Codex upstream response headers (REBEL-5EZ / REBEL-5K4) should not hard-fail BTS/sub-agent callers that lack turn-level `runWithRetry`.

**Mechanism:** `fetchCodexFirstWithNetworkRetry()` in `src/main/services/localModelProxyServer.ts` retries **once** when `isRetriableUpstreamNetworkError()` is true — only on the **first** upstream `fetch()`, before any HTTP response or stream bytes exist. Deliberate timeouts/aborts and surfaced 4xx/429 responses are not retried. Tests: `src/main/services/__tests__/localModelProxyServer.codexNetworkRetry.test.ts`.

---

## SSRF — pinned-dispatcher lifecycle

**Intent:** Close the DNS-rebinding TOCTOU window between hostname validation and socket connect by pinning each hop's undici dispatcher to the **already-validated IP** while keeping the URL hostname unchanged (correct TLS SNI + `Host` header).

**Mechanism** (`src/core/utils/ssrfProtection.ts`):

- **`buildPinnedDispatcher(validatedIp)`** — per-request undici `Agent` with `createPinnedLookup()` (constant-returning lookup, off threadpool by construction).
- **`followRedirectsSafely()`** — per-hop: validate IP → build pinned dispatcher → fetch → on redirect discard, **cancel response body then close dispatcher** via `cancelBodyAndCloseDispatcher()` so sockets release even if `body.cancel()` rejects (`closePinnedDispatcher()` in `finally`).
- **Consumers:** Rebel Core `WebFetch` (`src/core/rebelCore/tools/webFetchTool.ts`); plugin external fetch (`src/main/services/pluginExternalFetchService.ts` — `resolveAndValidateHost` + `buildPinnedDispatcher`).

Pre-fetch private-IP blocking, 5s DNS cache, redirect re-validation, and hop limits remain as documented in [PLUGINS_SECURITY § External Fetch Security](./PLUGINS_SECURITY.md#external-fetch-security).
