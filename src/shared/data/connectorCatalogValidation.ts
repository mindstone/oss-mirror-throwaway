/**
 * Catalog defence-in-depth validator: enforces compatibility between the
 * env-var name and provider ID declared in `bundledConfig.providerKeyMapping`.
 *
 * A catalog typo such as `{ OPENAI_API_KEY: "google" }` would silently
 * exfiltrate the wrong provider's secret to the wrong vendor on next
 * connector spawn. This validator gates that class of mistake by requiring
 * every `[envVar, providerId]` pair in any catalog entry's
 * `providerKeyMapping` to appear in `ALLOWED_PROVIDER_KEY_MAPPINGS`.
 *
 * @see docs/plans/260503_openai_image_oss_migration.md (Stage 0a, Phase 3 H5)
 */

import type { ConnectorCatalog, ProviderKeyId } from '../types';

/**
 * Single source of truth for env-var → provider-ID compatibility in
 * `bundledConfig.providerKeyMapping`. New entries must use a value from the
 * `ProviderKeyId` union (`src/shared/types/settings.ts`); unknown values are
 * rejected by the validator below.
 *
 * Multiple env-var names may map to the same `ProviderKeyId` (e.g.,
 * `GEMINI_API_KEY` and `GOOGLE_API_KEY` both target `'google'`) because
 * different OSS connectors use different vendor-SDK conventions.
 */
export const ALLOWED_PROVIDER_KEY_MAPPINGS: Readonly<Record<string, ProviderKeyId>> =
  Object.freeze({
    OPENAI_API_KEY: 'openai',
    GOOGLE_API_KEY: 'google',
    GEMINI_API_KEY: 'google',
    TOGETHER_API_KEY: 'together',
    CEREBRAS_API_KEY: 'cerebras',
    OPENROUTER_API_KEY: 'openrouter',
  } as const);

export interface ProviderKeyMappingError {
  connectorId: string;
  envVar: string;
  providerId: string;
  reason: 'unknown-env-var' | 'env-var-provider-mismatch';
  message: string;
}

/**
 * Walks every catalog entry and returns one error per offending
 * `providerKeyMapping` pair. Returns an empty array when the catalog is
 * compatible with `ALLOWED_PROVIDER_KEY_MAPPINGS`.
 *
 * Entries without a `providerKeyMapping` are skipped (no false positives on
 * existing connectors).
 */
export function validateConnectorCatalogProviderKeyMappings(
  catalog: Pick<ConnectorCatalog, 'connectors'>,
): ProviderKeyMappingError[] {
  const errors: ProviderKeyMappingError[] = [];

  for (const entry of catalog.connectors) {
    const mapping = entry.bundledConfig?.providerKeyMapping;
    if (!mapping) continue;

    for (const [envVar, providerId] of Object.entries(mapping)) {
      if (providerId === undefined) continue;

      const expectedProviderId = ALLOWED_PROVIDER_KEY_MAPPINGS[envVar];

      if (expectedProviderId === undefined) {
        const allowedEnvVars = Object.keys(ALLOWED_PROVIDER_KEY_MAPPINGS).sort();
        errors.push({
          connectorId: entry.id,
          envVar,
          providerId,
          reason: 'unknown-env-var',
          message:
            `Catalog entry "${entry.id}" declares ` +
            `bundledConfig.providerKeyMapping["${envVar}"] = "${providerId}", but ` +
            `"${envVar}" is not in ALLOWED_PROVIDER_KEY_MAPPINGS. ` +
            `Allowed env-vars: ${allowedEnvVars.join(', ')}.`,
        });
        continue;
      }

      if (expectedProviderId !== providerId) {
        errors.push({
          connectorId: entry.id,
          envVar,
          providerId,
          reason: 'env-var-provider-mismatch',
          message:
            `Catalog entry "${entry.id}" declares ` +
            `bundledConfig.providerKeyMapping["${envVar}"] = "${providerId}", but ` +
            `"${envVar}" is reserved for provider "${expectedProviderId}" in ` +
            `ALLOWED_PROVIDER_KEY_MAPPINGS. A typo here would inject the wrong ` +
            `vendor's secret into "${envVar}" at MCP server spawn — see Phase 3 ` +
            `H5 in docs/plans/260503_openai_image_oss_migration.md.`,
        });
      }
    }
  }

  return errors;
}
