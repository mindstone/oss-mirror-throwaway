/**
 * `enableContributionRelay` feature flag resolution.
 *
 * The flag gates the Mindstone relay submit path (Rebel-name and
 * Anonymous attribution) in the MCP build share picker.
 *
 * Rollout history:
 *   - Stage 5a (260420 OSS MCP backend relay) introduced the flag with
 *     channel-aware defaults: stable off, beta + dev on.
 *   - 260427 (Tranche A — submit-transport hardening, see
 *     `docs/plans/260427_contribution_flow_followon_submission_auth.md`)
 *     graduated the flag to default-on across ALL channels including
 *     stable, after Stage 1+2+3 closed 12 submission-flow footguns
 *     (per-id single-flight, cross-transport DUPLICATE block, smarter
 *     422 classifier, TIMEOUT mapping, strict Retry-After parsing,
 *     GitHub-direct degraded persistence parity, effectiveAttributionMode
 *     routing, atomicity invariant, safe-method 5xx retry, etc.).
 *
 * A user-set boolean ALWAYS wins over the channel default — users who
 * disable the experiment in settings stay disabled, and users who
 * disabled it on stable before the graduation will keep their override.
 *
 * Refresh is NOT gated by this flag — users who previously submitted
 * via relay must still be able to poll for PR status even if the flag
 * has since been flipped off in their settings.
 */

/**
 * Release channel the app is running on. Structurally equivalent to
 * `BuildChannel` from `@core/utils/buildChannel`, inlined here so this
 * module can live in `@shared` without dragging the `@core` graph into
 * the renderer's tsconfig include list. Any future edits must keep
 * these two types in sync.
 */
export type ContributionRelayBuildChannel = 'stable' | 'beta' | 'dev';

/**
 * The subset of channels observable in the renderer via
 * `window.electronEnv?.buildChannel`. Includes `null` for the pre-IPC
 * boot window and `undefined` for the missing-electronEnv case (e.g.
 * tests that don't mock the preload bridge).
 */
export type RendererBuildChannel = ContributionRelayBuildChannel | null | undefined;

/**
 * Resolve the effective value of `enableContributionRelay` given the
 * user's setting (if any) and the current build channel.
 *
 * Pure function — safe to call from renderer, cloud, or tests. Has no
 * side effects and no IPC dependencies.
 *
 * Resolution rules (260427 onwards):
 *   1. A user-set boolean ALWAYS wins. Returned verbatim regardless of channel.
 *   2. Otherwise the default is `true` for every channel (stable + beta +
 *      dev) and for missing/null channels too.
 *
 * The `buildChannel` parameter is preserved in the signature even
 * though it no longer affects the default — keeping it lets us
 * reintroduce a channel-aware ramp later (e.g. for a follow-on
 * experiment) without a contract change at every call site.
 *
 * @param setting - `settings.experimental.enableContributionRelay`;
 *   `true` / `false` → user override honoured, `undefined` → universal
 *   default of `true`.
 * @param buildChannel - Release channel the app is running on.
 *   Currently observed only as a logging surface; future-proofing.
 */
export function resolveContributionRelayEnabled(
  setting: boolean | undefined,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- kept in signature for future channel-aware ramps; see JSDoc above
  buildChannel: RendererBuildChannel,
): boolean {
  if (typeof setting === 'boolean') return setting;
  return true;
}
