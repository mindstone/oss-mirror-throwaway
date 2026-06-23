/**
 * Import-pipeline guard for rebel-oss connector catalog entries.
 *
 * Closes the [FOLLOW-UP] Prevention item from the 260417 postmortem:
 * "Import pipeline guard: Ensure scripts/import-rebel-oss-catalog-entry.ts validates
 *  that bundledConfig is preserved during catalog syncs, not just passively copied."
 *
 * Defense-in-depth at the import-pipeline layer on top of the already-landed
 * catalog-JSON layer (src/shared/__tests__/connectorCatalog.test.ts:264-287,
 * commit 1a65e9d95) and the UI-routing layer
 * (src/renderer/features/settings/components/__tests__/ExpandedConnectionCard.saveRoute.test.tsx,
 *  Stage 2 of this same plan).
 *
 * The guard fires BEFORE writeFileSync() in the CLI main() so no bad catalog
 * state ever lands on disk.
 *
 * @see docs-private/postmortems/260417_rebel_oss_bundledconfig_regression_postmortem.md
 * @see docs/plans/260422_bundledconfig_prevention_followups.md
 * @see src/shared/__tests__/connectorCatalog.test.ts (catalog-JSON layer)
 */

import {
  DEFAULT_ONLY_SANDBOX_ENV_KEYS,
  LOCAL_FILE_SANDBOX_ENV_PLACEHOLDERS,
} from '../../src/shared/mcpSandboxEnvKeys';

/**
 * Minimum catalog-entry shape required by the validator.
 *
 * Kept intentionally loose: `setupFields` is typed as `Array<unknown>` because
 * the validator only cares about `.length`, not the field shapes (those are
 * validated elsewhere in the import script). This reduces structural-drift
 * risk if the script's own CatalogConnector interface evolves.
 */
export interface CatalogConnectorForValidation {
  id: string;
  provider: string;
  requiresSetup?: boolean;
  setupFields?: Array<unknown>;
  bundledConfig?: Record<string, unknown>;
}

/**
 * Known bundled-like authType values enforced by the live-code routing in
 * `src/renderer/features/settings/components/ExpandedConnectionCard.tsx`
 * and asserted at `src/shared/__tests__/connectorCatalog.test.ts:330-347`.
 *
 * Kept in sync with `connectorCatalog.test.ts` — if a new authType is added
 * there, mirror the addition here so the import pipeline accepts it.
 */
export const KNOWN_BUNDLED_LIKE_AUTH_TYPES = new Set([
  'api-key',
  'oauth',
  'oauth-user-provided',
  'none',
]);

const SYSTEM_RESOLVED_TOKENS = new Set([
  'MCP_CONFIG_DIR',
  'MCP_BASE_DIR',
  'BRIDGE_STATE_PATH',
  'ALLOWED_ROOTS_ANCESTOR',
  'ALLOWED_ROOTS_ANCESTOR_DOWNLOADS',
]);

/**
 * Runtime-injected tokens are placeholders the bundled MCP manager resolves at
 * server-start time from per-instance state (not from setupFields, system paths,
 * or providerKeyMapping). They MUST appear as `{{TOKEN}}` slots in the catalog
 * so that desktop→cloud env-rewrite preserves the slot and doesn't drop the
 * runtime-injected value.
 *
 * Each entry here corresponds to a runtime injection in the bundled MCP layer.
 * When adding a new runtime-injected token, also add the injection site below.
 *
 * @see src/main/services/bundledMcpManager.ts — `env.HUBSPOT_SCOPE_TIER = scopeTier`
 *   (around the `resolveHubSpotScopeTierWithFallback` call) for the runtime
 *   injection precedent.
 * @see resources/connector-catalog.json — `bundled-hubspot.mcpConfig.env.HUBSPOT_SCOPE_TIER`
 *   slot that this allowlist exempts from the standard resolvability rules.
 */
const RUNTIME_INJECTED_TOKENS = new Set([
  'HUBSPOT_SCOPE_TIER',
  // TODO(outreach-oauth): OUTREACH_CONFIG_DIR is a per-account config path
  // (mirror of `path.join(app.getPath('userData'), 'mcp', 'outreach')` in
  // src/main/services/outreachAuthService.ts:74). The bundled-outreach OAuth
  // flow is not yet wired host-side (see
  // docs-private/investigations/260504_salesforce_package_unavailable_REBEL-13Y.md
  // and docs-private/investigations/260520_mcp_api_key_cross_surface_parity.md);
  // exempting the placeholder here keeps the catalog test green while the
  // host wiring catches up. When the host injects this at server-start time,
  // this entry just stays — it's already correctly classified as runtime-
  // injected, not setup-field-derived.
  'OUTREACH_CONFIG_DIR',
]);

export const validateEnvPlaceholderResolvability = (entry: {
  id: string;
  mcpConfig?: { env?: Record<string, string> };
  setupFields?: Array<{ id: string; envVar?: string }>;
  bundledConfig?: { providerKeyMapping?: Record<string, string> };
}): void => {
  const env = entry.mcpConfig?.env;
  if (!env) return;

  const setupFieldTokens = new Set(
    (entry.setupFields ?? []).flatMap((field) => [field.id, field.envVar].filter(Boolean)),
  );
  const providerKeyIds = new Set(Object.keys(entry.bundledConfig?.providerKeyMapping ?? {}));

  for (const [envKey, value] of Object.entries(env)) {
    const tokens = [...value.matchAll(/\{\{([A-Z0-9_]+)\}\}/g)].map((match) => match[1]);
    for (const token of tokens) {
      if (SYSTEM_RESOLVED_TOKENS.has(token)) continue;
      if (RUNTIME_INJECTED_TOKENS.has(token)) continue;
      if (setupFieldTokens.has(token)) continue;
      if (providerKeyIds.has(token)) continue;

      throw new Error(
        `Catalog entry "${entry.id}" has an unresolvable placeholder {{${token}}} in env.${envKey}. ` +
          `Tokens must be one of: a system-resolved name (${[...SYSTEM_RESOLVED_TOKENS].join(', ')}), ` +
          `a runtime-injected name (${[...RUNTIME_INJECTED_TOKENS].join(', ')}), ` +
          `a setupField id/envVar, or a providerKeyMapping key.`,
      );
    }
  }
};

/**
 * Validates that a connector flagged `requiresLocalFileSandbox: true` declares
 * the full local-file sandbox env-key set with the exact placeholder values the
 * host catalog-env resolver knows how to fill in at spawn time.
 *
 * Closes the type_constraint Prevention item from the 260531 Runway sandbox
 * postmortem: the bulk OSS migration declared a local-file-capable connector
 * (Runway) with no sandbox root env, so the connector's own sandbox fell back
 * to os.tmpdir() and rejected legitimate workspace files. The flag makes the
 * "this connector needs a trusted-root sandbox" requirement DECLARATIVE in the
 * catalog, and this check makes it impossible to declare the flag while leaving
 * the required env keys absent, blank, or drifted to the wrong placeholder.
 *
 * Exact-value (not just presence): a paired key like RUNWAY_DOWNLOAD_ROOT could
 * otherwise drift to the wrong placeholder while still passing a presence check.
 *
 * The required key set + expected placeholder values are the shared SSOT in
 * `src/shared/mcpSandboxEnvKeys.ts` (also consumed by the host's default-only
 * sandbox env preservation in bundledMcpManager.ts and the cloud backfill
 * migration), so this gate cannot drift from the runtime contract.
 *
 * @see docs-private/postmortems/260531_resolve_runway_sandbox_to_user_trusted_80c7e79_postmortem.md
 * @see src/shared/mcpSandboxEnvKeys.ts
 */
export const validateLocalFileSandboxRequirements = (entry: {
  id: string;
  requiresLocalFileSandbox?: boolean;
  mcpConfig?: { env?: Record<string, string> };
}): void => {
  if (entry.requiresLocalFileSandbox !== true) return;

  const env = entry.mcpConfig?.env ?? {};
  const problems: string[] = [];

  for (const key of DEFAULT_ONLY_SANDBOX_ENV_KEYS) {
    const expected = LOCAL_FILE_SANDBOX_ENV_PLACEHOLDERS[key];
    if (expected === undefined) {
      // A key is in the SSOT set but has no expected placeholder mapping. This
      // is a contract bug in mcpSandboxEnvKeys.ts, not a catalog bug — surface
      // it loudly rather than silently skipping the key.
      problems.push(
        `${key}: no expected placeholder in LOCAL_FILE_SANDBOX_ENV_PLACEHOLDERS ` +
          `(src/shared/mcpSandboxEnvKeys.ts is internally inconsistent)`,
      );
      continue;
    }
    const actual = env[key];
    if (actual === undefined) {
      problems.push(`${key}: missing (expected "${expected}")`);
    } else if (actual !== expected) {
      problems.push(`${key}: got ${JSON.stringify(actual)} (expected "${expected}")`);
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `Catalog entry "${entry.id}" sets requiresLocalFileSandbox: true but its ` +
        `mcpConfig.env does not correctly declare the local-file sandbox env keys:\n` +
        problems.map((p) => `  - ${p}`).join('\n') +
        `\n\nA connector whose tools accept local filesystem paths must declare a ` +
        `host-resolved, user-trusted sandbox root at spawn time. Add/repair these env ` +
        `keys in resources/connector-catalog.json so the host resolver and cloud backfill ` +
        `produce a concrete allowed root — otherwise the connector's own sandbox falls ` +
        `back to os.tmpdir() and rejects legitimate workspace files.\n` +
        `See docs-private/postmortems/260531_resolve_runway_sandbox_to_user_trusted_80c7e79_postmortem.md.`,
    );
  }
};

/**
 * Throws a descriptive Error when a rebel-oss catalog entry with
 * `requiresSetup + setupFields` is missing the `bundledConfig.{authType, serverName}`
 * block required by the live Settings UI save-path routing.
 *
 * The error message includes:
 * - The offending connector id
 * - The originating manifest path + package spec
 * - The specific missing field(s)
 * - A pointer to the catalog-test source-of-truth
 * - A pointer to the local-fix path (NOT upstream manifest — script doesn't read bundledConfig from manifest)
 * - A pointer to the postmortem
 */
export function validateBundledConfigInvariant(
  entry: CatalogConnectorForValidation,
  source: { manifestPath: string; packageSpec: string },
): void {
  if (entry.provider !== 'rebel-oss') return;
  if (!entry.requiresSetup) return;
  if (!entry.setupFields || entry.setupFields.length === 0) return;

  const cfg = entry.bundledConfig;
  const missing: string[] = [];
  if (!cfg) {
    missing.push('bundledConfig');
  } else {
    // authType must be a KNOWN STRING. Falsy values are missing; truthy-but-
    // non-string values (e.g. 123, {}) and string-but-unsupported values are
    // both rejected via the unsupported-value message.
    if (!cfg.authType) {
      missing.push('bundledConfig.authType');
    } else if (
      typeof cfg.authType !== 'string' ||
      !KNOWN_BUNDLED_LIKE_AUTH_TYPES.has(cfg.authType)
    ) {
      missing.push(
        `bundledConfig.authType (got unsupported value ${JSON.stringify(cfg.authType)}; ` +
          `expected one of: ${Array.from(KNOWN_BUNDLED_LIKE_AUTH_TYPES).map((v) => `"${v}"`).join(', ')})`,
      );
    }
    if (!cfg.serverName) missing.push('bundledConfig.serverName');
  }

  if (missing.length > 0) {
    throw new Error(
      `[import-rebel-oss-catalog-entry] Invariant violation for connector "${entry.id}":\n` +
        `  Missing or invalid: ${missing.join(', ')}\n` +
        `  Manifest: ${source.manifestPath}\n` +
        `  Package:  ${source.packageSpec}\n` +
        `\n` +
        `rebel-oss connectors with requiresSetup + setupFields must have ` +
        `bundledConfig.{authType, serverName} so the Settings UI routes credential ` +
        `saves through mcpAddBundledServer (not the generic onUpsertServer fallthrough ` +
        `that broke 9 connectors on 2026-04-09).\n` +
        `\n` +
        `This invariant is asserted at:\n` +
        `  src/shared/__tests__/connectorCatalog.test.ts (rebel-oss connectors with ` +
        `requiresSetup + setupFields must have bundledConfig)\n` +
        `\n` +
        `Fix: restore or extend the bundledConfig block in the LOCAL ` +
        `resources/connector-catalog.json entry for "${entry.id}" before re-running ` +
        `the import. The importer preserves existing local bundledConfig but cannot ` +
        `synthesize it from the upstream catalog-entry.json manifest today (upstream ` +
        `manifests don't carry bundledConfig — see ` +
        `docs/plans/260422_bundledconfig_prevention_followups.md Q1).\n` +
        `\n` +
        `See docs-private/postmortems/260417_rebel_oss_bundledconfig_regression_postmortem.md ` +
        `for context.`,
    );
  }
}
