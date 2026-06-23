/**
 * Single source of truth for the env keys the bundled MCP catalog provides as
 * DEFAULTS for Runway-style local-file sandbox boundaries.
 *
 * Lives in `src/shared/` (not `src/main/`) so non-Electron tooling — notably
 * the catalog-import validators under `scripts/` — can import the contract
 * without pulling in Electron. `src/main/services/mcpSandboxEnvKeys.ts`
 * re-exports from here for back-compat with existing main-process importers.
 *
 * These keys are "default-only": when a user sets a non-blank value via
 * advanced config, that value MUST win over the catalog default — even after
 * placeholder resolution has filled in the catalog's `{{ALLOWED_ROOTS_ANCESTOR}}`
 * slot with a real path.
 *
 * IMPORTANT: do NOT add these keys to `INTERNAL_ENV_KEYS`
 * (`@core/mcpInternalEnvKeys`). Doing so would make `mergePreservedUserEnv` skip
 * them entirely before any preservation logic runs (`bundledMcpManager.ts`),
 * silently breaking user override. The whole point of this set is the opposite:
 * preserve user value over catalog default for these specific keys.
 *
 * @see docs-private/postmortems/260531_resolve_runway_sandbox_to_user_trusted_80c7e79_postmortem.md
 */

/**
 * The "primary" sandbox key whose realpath state determines whether the
 * full set is treated as stale. Stale-detection callers should only check
 * this key — paired keys (e.g. `RUNWAY_DOWNLOAD_ROOT`) are tied to it
 * because their concrete values point at not-yet-created subdirectories
 * (`<ancestor>/runway-mcp`) the runtime creates lazily on first use, so
 * checking them independently produces a false-positive scrub-and-re-add
 * loop on every cloud boot.
 */
export const DEFAULT_ONLY_SANDBOX_ENV_PRIMARY_KEY = 'RUNWAY_ALLOWED_ROOT';

/**
 * Sandbox keys that travel with {@link DEFAULT_ONLY_SANDBOX_ENV_PRIMARY_KEY}.
 * If the primary is stale on this surface, the paired keys are scrubbed
 * alongside so the default-only sandbox env pass re-resolves the whole set
 * coherently. If the primary is fine, paired keys are left alone — even
 * when their target directory doesn't exist yet.
 */
export const DEFAULT_ONLY_SANDBOX_ENV_PAIRED_KEYS: ReadonlySet<string> = new Set([
  'RUNWAY_DOWNLOAD_ROOT',
]);

export const DEFAULT_ONLY_SANDBOX_ENV_KEYS: ReadonlySet<string> = new Set([
  DEFAULT_ONLY_SANDBOX_ENV_PRIMARY_KEY,
  ...DEFAULT_ONLY_SANDBOX_ENV_PAIRED_KEYS,
]);

/**
 * The exact placeholder value each local-file sandbox env key MUST carry in the
 * catalog. A connector flagged `requiresLocalFileSandbox: true` must declare
 * every key here with exactly this value, so the host's catalog-env resolver
 * (`bundledMcpManager.ts` — `{{ALLOWED_ROOTS_ANCESTOR}}` /
 * `{{ALLOWED_ROOTS_ANCESTOR_DOWNLOADS}}`) and the cloud backfill migration both
 * produce a concrete user-trusted root at spawn time.
 *
 * Validated by `validateLocalFileSandboxRequirements` in
 * `scripts/lib/validateCatalogImport.ts` (exact value, not just presence — a
 * paired key drifting to the wrong placeholder must fail). Keep this in lockstep
 * with the catalog resolver's recognised placeholders.
 *
 * @see docs-private/postmortems/260531_resolve_runway_sandbox_to_user_trusted_80c7e79_postmortem.md
 */
export const LOCAL_FILE_SANDBOX_ENV_PLACEHOLDERS: Readonly<Record<string, string>> = {
  RUNWAY_ALLOWED_ROOT: '{{ALLOWED_ROOTS_ANCESTOR}}',
  RUNWAY_DOWNLOAD_ROOT: '{{ALLOWED_ROOTS_ANCESTOR_DOWNLOADS}}',
};
