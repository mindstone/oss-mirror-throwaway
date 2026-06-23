#!/usr/bin/env npx tsx

/**
 * Import a rebel-oss connector catalog entry from the mcp-servers repo.
 *
 * Reads a catalog-entry.json manifest from a checked-out mcp-servers connector
 * directory and upserts it into resources/connector-catalog.json.
 *
 * Derives:
 * - provider: "rebel-oss" (always)
 * - mcpConfig.command: "npx"
 * - mcpConfig.args: ["-y", "<package>@<version>"]
 *
 * Preserves curation fields (popular, hidden, featured) from existing entries.
 *
 * Usage:
 *   npx tsx scripts/import-rebel-oss-catalog-entry.ts \
 *     --connector zendesk \
 *     --package @mindstone-engineering/mcp-server-zendesk \
 *     --version 0.2.0 \
 *     --entry-path _mcp-servers/connectors/zendesk/catalog-entry.json
 *
 * @see docs/plans/260409_productionise_build_custom_mcp_server.md (Stage 6)
 */

import { readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import {
  validateBundledConfigInvariant,
  validateEnvPlaceholderResolvability,
  validateLocalFileSandboxRequirements,
} from './lib/validateCatalogImport.js';

// ─── Types ────────────────────────────────────────────────────────────────────

interface CatalogEntryManifest {
  id: string;
  name: string;
  description: string;
  category: string;
  icon: string;
  maturity: string;
  verifiedSource: string;
  requiresSetup: boolean;
  setupFields?: Array<{
    key: string;
    label: string;
    type: string;
    placeholder?: string;
  }>;
  accountIdentity?: string;
  contributors?: Array<{ name: string; github: string }>;
}

interface CatalogConnector {
  id: string;
  name: string;
  description: string;
  category: string;
  provider: string;
  mcpConfig: {
    transport: string;
    command: string;
    args: string[];
    env?: Record<string, string>;
  };
  icon: string;
  maturity?: string;
  popular?: boolean;
  hidden?: boolean;
  featured?: boolean;
  verified?: boolean;
  verifiedSource?: string;
  requiresSetup?: boolean;
  setupFields?: Array<{
    id: string;
    label: string;
    type: string;
    placeholder?: string;
    envVar?: string;
  }>;
  accountIdentity?: string;
  contributors?: Array<{ name: string; github: string }>;
  tools?: Array<{ name: string; description?: string }>;
  bundledConfig?: { providerKeyMapping?: Record<string, string>; [key: string]: unknown };
  [key: string]: unknown;
}

interface ConnectorCatalog {
  version: number;
  connectors: CatalogConnector[];
}

interface CliArgs {
  connector: string;
  package: string;
  version: string;
  entryPath: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '..');
const CATALOG_PATH = join(PROJECT_ROOT, 'resources', 'connector-catalog.json');

// ─── CLI Parsing ──────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): CliArgs {
  const args: Partial<CliArgs> = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];

    switch (arg) {
      case '--connector':
        args.connector = next;
        i++;
        break;
      case '--package':
        args.package = next;
        i++;
        break;
      case '--version':
        args.version = next;
        i++;
        break;
      case '--entry-path':
        args.entryPath = next;
        i++;
        break;
      default:
        if (arg.startsWith('--')) {
          throw new Error(`Unknown argument: ${arg}`);
        }
    }
  }

  if (!args.connector) throw new Error('Missing required --connector argument');
  if (!args.package) throw new Error('Missing required --package argument');
  if (!args.version) throw new Error('Missing required --version argument');
  if (!args.entryPath) throw new Error('Missing required --entry-path argument');

  return args as CliArgs;
}

// ─── Validation ───────────────────────────────────────────────────────────────

function validateManifest(manifest: CatalogEntryManifest): void {
  const required: Array<keyof CatalogEntryManifest> = [
    'id', 'name', 'description', 'category', 'icon', 'maturity', 'verifiedSource',
  ];

  for (const field of required) {
    if (!manifest[field]) {
      throw new Error(`catalog-entry.json missing required field: ${field}`);
    }
  }

  if (typeof manifest.requiresSetup !== 'boolean') {
    throw new Error('catalog-entry.json: requiresSetup must be a boolean');
  }

  if (manifest.setupFields) {
    for (const field of manifest.setupFields) {
      if (!field.key || !field.label || !field.type) {
        throw new Error(
          `catalog-entry.json: setupFields entries must have key, label, and type. Got: ${JSON.stringify(field)}`,
        );
      }
    }
  }
}

// ─── Import Logic ─────────────────────────────────────────────────────────────

/**
 * Build a catalog entry from a manifest. Fields that the manifest does not
 * carry are left unset on the new entry so `upsertEntry`'s preserve-all merge
 * can keep the existing catalog values.
 *
 * Setting an optional field unconditionally (e.g. `accountIdentity: manifest.accountIdentity`)
 * would inject `undefined` and then drop the existing value during the merge —
 * the FOX-3319 silent-drop bug this function guards against.
 */
export function buildCatalogEntry(
  manifest: CatalogEntryManifest,
  npmPackage: string,
  version: string,
): Omit<CatalogConnector, 'tools' | 'bundledConfig'> {
  const entry: Record<string, unknown> = {
    id: manifest.id,
    name: manifest.name,
    description: manifest.description,
    category: manifest.category,
    provider: 'rebel-oss',
    mcpConfig: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', `${npmPackage}@${version}`],
    },
    icon: manifest.icon,
    verified: true,
    verifiedSource: manifest.verifiedSource,
    requiresSetup: manifest.requiresSetup,
    maturity: manifest.maturity,
  };

  if (manifest.accountIdentity !== undefined) {
    entry.accountIdentity = manifest.accountIdentity;
  }

  if (manifest.contributors && manifest.contributors.length > 0) {
    entry.contributors = manifest.contributors;
  }

  if (manifest.setupFields) {
    entry.setupFields = manifest.setupFields.map((field) => ({
      id: field.key,
      label: field.label,
      type: field.type,
      ...(field.placeholder ? { placeholder: field.placeholder } : {}),
    }));
  }

  return entry as Omit<CatalogConnector, 'tools' | 'bundledConfig'>;
}

/**
 * Upsert `newEntry` into `catalog`. On update, preserves every field on the
 * existing entry that the new entry does not specify (generic shallow merge).
 *
 * Returns `true` if the catalog was changed (insert or replacement), `false`
 * if a no-op.
 *
 * The merge protects load-bearing fields the manifest pipeline does not carry
 * (setupFields envVar, setupUrl, setupInstructions, callbackUrl, platforms,
 * curation flags, bundledConfig, tools, accountIdentity, contributors, ...).
 * Removed fields must be removed deliberately at the source.
 */
export function upsertEntry(catalog: ConnectorCatalog, newEntry: CatalogConnector): boolean {
  const existingIndex = catalog.connectors.findIndex((c) => c.id === newEntry.id);

  if (existingIndex === -1) {
    catalog.connectors.push(newEntry);
    return true;
  }

  const existing = catalog.connectors[existingIndex];
  const newRecord = newEntry as Record<string, unknown>;

  for (const [key, value] of Object.entries(existing)) {
    if (!(key in newRecord)) {
      newRecord[key] = value;
    }
  }

  if (existing.mcpConfig?.env && newEntry.mcpConfig && !newEntry.mcpConfig.env) {
    newEntry.mcpConfig.env = existing.mcpConfig.env;
  }

  catalog.connectors[existingIndex] = newEntry;
  return true;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  // Read the catalog entry manifest
  let manifestRaw: string;
  try {
    manifestRaw = readFileSync(args.entryPath, 'utf8');
  } catch (error) {
    throw new Error(
      `Failed to read catalog-entry.json at ${args.entryPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const manifest = JSON.parse(manifestRaw) as CatalogEntryManifest;
  validateManifest(manifest);

  // Read the existing catalog
  const catalog = JSON.parse(readFileSync(CATALOG_PATH, 'utf8')) as ConnectorCatalog;

  // Build the new catalog entry
  const newEntry = buildCatalogEntry(manifest, args.package, args.version) as CatalogConnector;

  // Upsert into catalog
  const changed = upsertEntry(catalog, newEntry);

  // Validate the FINAL entry (post-upsert, pre-write) enforces the 260417
  // bundledConfig-preservation invariant. Fires before writeFileSync so no
  // bad catalog state ever lands on disk. See scripts/lib/validateCatalogImport.ts.
  validateBundledConfigInvariant(newEntry, {
    manifestPath: args.entryPath,
    packageSpec: `${args.package}@${args.version}`,
  });
  validateEnvPlaceholderResolvability(newEntry);
  validateLocalFileSandboxRequirements(newEntry);

  if (changed) {
    writeFileSync(CATALOG_PATH, `${JSON.stringify(catalog, null, 2)}\n`);
    console.log(`✓ Upserted ${manifest.id} into connector-catalog.json`);
    console.log(`  Package: ${args.package}@${args.version}`);
    console.log(`  Provider: rebel-oss`);
  } else {
    console.log(`No changes needed for ${manifest.id}`);
  }
}

const isDirectInvocation = process.argv[1] === fileURLToPath(import.meta.url);
if (isDirectInvocation) {
  main();
}
