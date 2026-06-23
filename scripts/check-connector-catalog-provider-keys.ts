#!/usr/bin/env npx tsx
/**
 * Validates that every `bundledConfig.providerKeyMapping` entry in
 * `resources/connector-catalog.json` is compatible with
 * `ALLOWED_PROVIDER_KEY_MAPPINGS` (see
 * `src/shared/data/connectorCatalogValidation.ts`).
 *
 * Defence-in-depth against catalog typos that would inject the wrong
 * vendor's secret into a connector's env at spawn time (Phase 3 H5).
 *
 * Run via: npx tsx scripts/check-connector-catalog-provider-keys.ts
 * Wired into: npm run validate:fast
 *
 * @see docs/plans/260503_openai_image_oss_migration.md (Stage 0a)
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ConnectorCatalog } from '../src/shared/types';
import { validateConnectorCatalogProviderKeyMappings } from '../src/shared/data/connectorCatalogValidation';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const catalogPath = join(__dirname, '..', 'resources', 'connector-catalog.json');

function main(): void {
  console.log('🔐 Connector Catalog providerKeyMapping Check');
  console.log('=============================================\n');

  const catalog = JSON.parse(readFileSync(catalogPath, 'utf8')) as ConnectorCatalog;
  const errors = validateConnectorCatalogProviderKeyMappings(catalog);

  if (errors.length === 0) {
    console.log('✅ All providerKeyMapping entries are compatible with ALLOWED_PROVIDER_KEY_MAPPINGS.\n');
    return;
  }

  console.error(`❌ ${errors.length} providerKeyMapping violation(s) detected:\n`);
  for (const error of errors) {
    console.error(`   - ${error.message}`);
  }
  console.error(
    '\nFix: update the catalog entry, or add the new env-var/provider pair to ' +
      'ALLOWED_PROVIDER_KEY_MAPPINGS in src/shared/data/connectorCatalogValidation.ts ' +
      'after confirming the new mapping is intentional.\n',
  );
  process.exit(1);
}

main();
