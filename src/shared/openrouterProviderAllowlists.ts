/**
 * Provider allowlists for OpenRouter models that have CN/SGP-origin providers.
 *
 * The proxy injects `provider.only` (never `provider.order`) so that OpenRouter's
 * native load-balanced routing handles failover and outage detection across all
 * listed providers. Setting `provider.order` disables OR's load balancing and
 * pins traffic to the first provider — do NOT reintroduce it.
 *
 * WHEN ADDING A NEW MODEL PREFIX: check the model's provider list on
 * openrouter.ai/models/<vendor>/<model> and add an entry here if ANY provider
 * is CN/SGP-origin (e.g. SiliconFlow, Moonshot AI, Minimax, ModelRun, Inceptron).
 * List only the non-CN/SGP providers in `providers`.
 *
 * Consumers:
 *   - src/main/services/localModelProxyServer.ts (canonical injection logic)
 *   - scripts/check-openrouter-providers.ts      (CI validator)
 *
 * This file intentionally has zero runtime dependencies so it can be imported
 * from both the Vite/Vitest build (via `@shared/...` alias) and bare `tsx`
 * scripts (via relative path).
 *
 * @see docs/research/260414_openrouter_non_china_routing.md
 * @see docs/project/ADDING_AN_OPENROUTER_MODEL.md — runbook for adding a new CN/SGP-origin model
 */
export const CHINA_ORIGIN_PROVIDER_ALLOWLISTS: ReadonlyArray<{
  prefix: string;
  providers: readonly string[];
}> = [
  // DeepSeek — excludes DeepSeek (first-party CN), SiliconFlow, Novita (operates a NOVITA SG PTE. LTD. SGP entity)
  { prefix: 'deepseek/', providers: ['DeepInfra', 'Parasail', 'Together', 'Azure', 'SambaNova', 'Fireworks', 'Crusoe', 'BaseTen', 'Nebius', 'AtlasCloud', 'GMICloud'] },
  // MiniMax — excludes Minimax (first-party CN), SiliconFlow, Inceptron
  { prefix: 'minimax/', providers: ['DekaLLM', 'Fireworks', 'Morph', 'SambaNova', 'Together', 'DeepInfra', 'Chutes', 'AkashML', 'Nebius', 'Parasail', 'AtlasCloud', 'Venice'] },
  // MoonshotAI — excludes Moonshot AI (first-party CN), SiliconFlow, ModelRun
  { prefix: 'moonshotai/', providers: ['AtlasCloud', 'BaseTen', 'Chutes', 'Cloudflare', 'DeepInfra', 'Fireworks', 'Novita', 'Parasail', 'Phala', 'Together', 'Venice'] },
  // xAI/GLM — US-only; no CN/SGP providers exist. Entry kept for safety.
  { prefix: 'z-ai/', providers: ['DeepInfra', 'Fireworks', 'AtlasCloud'] },
];
