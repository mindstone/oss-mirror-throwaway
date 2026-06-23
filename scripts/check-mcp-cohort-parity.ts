#!/usr/bin/env npx tsx
/**
 * MCP cohort parity gate for `provider: rebel-oss` catalog entries.
 *
 * Hardens the desktop→cloud MCP sync path against the regression class
 * documented in
 * `docs-private/investigations/260520_mcp_api_key_cross_surface_parity.md`:
 * api-key setup-field literals were silently lost when the desktop sync
 * path replaced `entry.env` wholesale with the catalog's placeholder env.
 *
 * The fix moved that rewrite to a selective env merge, but only works if the
 * catalog declares the credential env keys in canonical `{{VAR}}` form (so
 * the merge knows the slot is a placeholder the user value should fill).
 * This check enforces the contract at PR time:
 *
 *   1. Every `provider: rebel-oss` catalog `mcpConfig.env` value is either a
 *      canonical `{{VAR}}` placeholder or a literal that does NOT use the
 *      `${VAR}` / `$VAR` shell-style placeholder forms. The shell-style
 *      forms are unsupported by the cloud rewrite's placeholder detector
 *      and were the original source of the Retell regression.
 *   2. Every `setupFields[].envVar` declared by a `provider: rebel-oss`
 *      connector has a corresponding catalog `mcpConfig.env` entry whose
 *      value is the canonical `{{VAR}}` placeholder. Without the slot in
 *      `mcpConfig.env`, the desktop→cloud merge has nowhere to land the
 *      user's setup-field literal and the cloud sync silently drops it.
 *      A non-placeholder literal in the slot is just as bad: the merge
 *      logic only lets the user value win when the catalog value matches
 *      the canonical placeholder shape, so a literal would also silently
 *      drop the user's setup-field value on cloud.
 *
 * Known exceptions are listed in `EXEMPT_FROM_SETUP_FIELD_PARITY` with a
 * docs reference. Anything else fails the check.
 *
 * Run via: npx tsx scripts/check-mcp-cohort-parity.ts
 * Wired into: npm run validate:fast
 */

import { readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ConnectorCatalog, ConnectorCatalogEntry } from '../src/shared/types';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = join(__dirname, '..');
const catalogPath = join(repoRoot, 'resources', 'connector-catalog.json');

/**
 * Catalog entries that have one or more `setupFields[].envVar` without a
 * matching `mcpConfig.env` slot. Cross-surface parity is incomplete for
 * each of these connectors — the desktop→cloud rewrite has nowhere to
 * land the user's setup-field literal, so api keys / OAuth client creds
 * silently drop on cloud. Tracked as a single FOLLOW-UP in
 * `docs-private/investigations/260520_mcp_api_key_cross_surface_parity.md` →
 * `## Discovered Improvements`. The check is a *ratchet*: existing
 * violators are exempted so new cohort members are forced into a working
 * contract at PR time.
 */
const EXEMPT_FROM_SETUP_FIELD_PARITY: ReadonlySet<string> = new Set([
  'bundled-browser-automation',
  'bundled-fathom',
  'bundled-google-analytics',
  'bundled-icloud-mail',
  'bundled-yahoo-mail',
  'bundled-custom-email',
  'bundled-pandadoc',
  'bundled-mixmax',
  'bundled-kling',
  'bundled-runway',
  'bundled-humaans',
  'bundled-workday',
  'bundled-quickbooks',
  'bundled-servicenow',
  'bundled-talentlms',
]);

/** Canonical placeholder syntax for catalog env values. */
const CANONICAL_PLACEHOLDER_RE = /\{\{[A-Z_][A-Z0-9_]*\}\}/;
/** Forbidden shell-style placeholder forms. */
const FORBIDDEN_PLACEHOLDER_RE = /\$\{[A-Z_][A-Z0-9_]*\}|(?<![A-Za-z0-9_])\$[A-Z_][A-Z0-9_]*(?![A-Za-z0-9_])/;

interface Violation {
  catalogId: string;
  message: string;
}

function isRebelOss(entry: ConnectorCatalogEntry): boolean {
  return entry.provider === 'rebel-oss';
}

function checkPlaceholderForms(entry: ConnectorCatalogEntry, violations: Violation[]): void {
  const env = entry.mcpConfig?.env;
  if (!env) return;
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== 'string') continue;
    if (FORBIDDEN_PLACEHOLDER_RE.test(value)) {
      violations.push({
        catalogId: entry.id,
        message:
          `mcpConfig.env.${key} = ${JSON.stringify(value)} uses an unsupported ` +
          `placeholder form. Use the canonical \`{{${key}}}\` form so the ` +
          `desktop→cloud rewrite preserves user-set literals.`,
      });
    }
  }
}

function checkSetupFieldEnvParity(entry: ConnectorCatalogEntry, violations: Violation[]): void {
  const setupFields = entry.setupFields;
  if (!Array.isArray(setupFields) || setupFields.length === 0) return;
  if (EXEMPT_FROM_SETUP_FIELD_PARITY.has(entry.id)) return;
  const env = entry.mcpConfig?.env ?? {};
  for (const field of setupFields) {
    const envVar = field?.envVar;
    if (typeof envVar !== 'string' || envVar.length === 0) continue;
    if (!Object.prototype.hasOwnProperty.call(env, envVar)) {
      violations.push({
        catalogId: entry.id,
        message:
          `setupFields[].envVar=${JSON.stringify(envVar)} has no matching ` +
          `entry in mcpConfig.env. Add ${JSON.stringify(envVar)}: "{{${envVar}}}" ` +
          `to mcpConfig.env so the desktop→cloud rewrite has a slot to ` +
          `preserve the user's setup-field literal.`,
      });
      continue;
    }
    // The slot exists, but the desktop→cloud merge in
    // `mergePreservedUserEnv` only lets a user-set literal win when the
    // catalog value matches the canonical `{{VAR}}` placeholder form.
    // A literal or empty string in the catalog slot would silently drop
    // the user's setup-field value on cloud — exactly the original bug
    // class on a new connector. Enforce the placeholder shape here.
    const slot = env[envVar];
    if (typeof slot !== 'string' || !CANONICAL_PLACEHOLDER_RE.test(slot)) {
      violations.push({
        catalogId: entry.id,
        message:
          `mcpConfig.env.${envVar} = ${JSON.stringify(slot)} must be the ` +
          `canonical \`{{${envVar}}}\` placeholder so the desktop→cloud ` +
          `rewrite can preserve the user's setup-field literal. A literal ` +
          `or empty string here would be silently dropped on cloud.`,
      });
    }
  }
}

function main(): void {
  console.log('🔗 MCP rebel-oss Cohort Parity Check');
  console.log('====================================\n');

  const catalog = JSON.parse(readFileSync(catalogPath, 'utf8')) as ConnectorCatalog;
  const violations: Violation[] = [];

  for (const entry of catalog.connectors) {
    if (!isRebelOss(entry)) continue;
    checkPlaceholderForms(entry, violations);
    checkSetupFieldEnvParity(entry, violations);
  }

  if (violations.length === 0) {
    const exemptedCount = EXEMPT_FROM_SETUP_FIELD_PARITY.size;
    console.log(
      `✅ All rebel-oss catalog entries pass cohort parity (${exemptedCount} known violators ratcheted via EXEMPT_FROM_SETUP_FIELD_PARITY).\n`,
    );
    return;
  }

  console.error(`❌ ${violations.length} cohort parity violation(s) in ${relative(repoRoot, catalogPath)}:\n`);
  for (const v of violations) {
    console.error(`   - [${v.catalogId}] ${v.message}`);
  }
  console.error(
    '\nSee docs-private/investigations/260520_mcp_api_key_cross_surface_parity.md for ' +
      'context. The desktop→cloud sync (rewriteManagedMcpEntriesToNpxForCloud) ' +
      'depends on these contracts to preserve api-key setup-field literals.\n',
  );
  process.exit(1);
}

main();
