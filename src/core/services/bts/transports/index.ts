/**
 * BTS transport adapter registry.
 *
 * Single source of truth mapping every `BtsTransport` (= `DispatchableTransport`)
 * to its `BtsTransportAdapter`. The central dispatch in `behindTheScenesClient.ts`
 * selects an adapter from here via an exhaustive `switch (transport)`; the
 * symmetry CI script (`scripts/check-bts-transport-symmetry.ts`) walks this map
 * to assert each adapter's declared `requiredBehaviors` are actually present in
 * its implementation source.
 *
 * The `Record<BtsTransport, BtsTransportAdapter>` annotation makes the map
 * exhaustive at compile time: adding a transport to the union without an entry
 * here is a TypeScript error.
 */
import type { BtsTransport, BtsTransportAdapter } from './types';
import { anthropicDirectAdapter } from './anthropic';
import { anthropicCompatibleProxyAdapter } from './anthropic-compatible-proxy';
import { codexProxyAdapter } from './codex-proxy';
import { openRouterProxyAdapter } from './openrouter-proxy';
import { profileHttpAdapter } from './profile-http';

export const BTS_TRANSPORT_ADAPTERS: Record<BtsTransport, BtsTransportAdapter> = {
  'anthropic-direct': anthropicDirectAdapter,
  'anthropic-compatible-local-proxy': anthropicCompatibleProxyAdapter,
  'openrouter-proxy': openRouterProxyAdapter,
  'codex-proxy': codexProxyAdapter,
  // Both OpenAI-compatible HTTP transports share the profile-direct adapter
  // (identical wire behaviour). The adapter's own `.transport` is
  // 'openai-compatible-http'; the dispatch switch keys on the plan's transport.
  'openai-compatible-http': profileHttpAdapter,
  'local-openai-compatible-http': profileHttpAdapter,
};

export type { BtsTransport, BtsTransportAdapter } from './types';
