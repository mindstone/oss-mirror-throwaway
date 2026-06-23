#!/usr/bin/env npx tsx
/**
 * CI Validation: Office MCP Package Version Consistency
 *
 * Verifies that the Office MCP package version in connector-catalog.json
 * matches the canonical constant in src/shared/sidecar/officePackage.ts.
 *
 * Catches drift where one is bumped without the other.
 *
 * Run: npx tsx scripts/check-office-package-version.ts
 * Wired into: npm run validate:fast
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');
const CATALOG_PATH = path.join(ROOT, 'resources', 'connector-catalog.json');
const CONSTANT_PATH = path.join(ROOT, 'src', 'shared', 'sidecar', 'officePackage.ts');

function extractConstantSpec(): string {
  const source = fs.readFileSync(CONSTANT_PATH, 'utf8');
  const nameMatch = source.match(/OFFICE_MCP_PACKAGE_NAME\s*=\s*'([^']+)'/);
  const versionMatch = source.match(/OFFICE_MCP_PACKAGE_VERSION\s*=\s*'([^']+)'/);
  if (!nameMatch || !versionMatch) {
    throw new Error(`Could not extract OFFICE_MCP_PACKAGE_NAME or OFFICE_MCP_PACKAGE_VERSION from ${CONSTANT_PATH}`);
  }
  return `${nameMatch[1]}@${versionMatch[1]}`;
}

const OFFICE_PACKAGE_SPEC_PREFIX = '@mindstone/mcp-server-office@';

function extractCatalogSpec(): string {
  const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
  const connectors: { id: string; mcpConfig?: { args?: string[] } }[] = catalog.connectors ?? catalog;
  const entry = connectors.find((e) => e.id === 'bundled-office');
  if (!entry) {
    throw new Error(`No 'bundled-office' entry found in ${CATALOG_PATH}`);
  }
  const args: string[] = entry.mcpConfig?.args ?? [];
  const spec = args.find((a: string) => a.startsWith(OFFICE_PACKAGE_SPEC_PREFIX));
  if (!spec) {
    throw new Error(
      `No office mcp-server arg matching ${OFFICE_PACKAGE_SPEC_PREFIX}* found in bundled-office mcpConfig.args`,
    );
  }
  return spec;
}

const constantSpec = extractConstantSpec();
const catalogSpec = extractCatalogSpec();

if (constantSpec !== catalogSpec) {
  console.error(
    `\n❌ Office MCP package version mismatch!\n` +
    `   Constant (src/shared/sidecar/officePackage.ts): ${constantSpec}\n` +
    `   Catalog  (resources/connector-catalog.json):     ${catalogSpec}\n\n` +
    `   Update the canonical constant in officePackage.ts — the catalog and sidecar manager both derive from it.\n`,
  );
  process.exit(1);
}

console.log(`✅ Office MCP package version consistent: ${constantSpec}`);
