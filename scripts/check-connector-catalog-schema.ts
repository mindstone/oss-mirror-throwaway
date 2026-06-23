#!/usr/bin/env npx tsx
/**
 * Validates `resources/connector-catalog.json` against:
 *
 *   1. The full `CatalogSchema` Zod schema in `src/shared/connectorCatalogSchema.ts`
 *      (the same schema used to validate runtime override catalogs in
 *      `connectorCatalogResolver.ts`). Failing here means runtime override
 *      attempts with the same shape would also be rejected — i.e., schema
 *      drift between the bundled catalog and the runtime gate.
 *
 *   2. rebel-oss provider invariants (transport=stdio, command=npx,
 *      verifiedSource URL, non-empty tools array) — narrower invariants
 *      that are NOT enforced by the Zod schema because they're
 *      provider-specific operational rules, not shape rules.
 *
 *   3. Maturity allow-list (`stable | beta | deprecated`) per the runtime
 *      Zod enum.
 *
 * Wired into `npm run validate:fast` so any catalog drift fails fast in PRs
 * instead of waiting for the full unit-test pass.
 *
 * Run via: npx tsx scripts/check-connector-catalog-schema.ts
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CatalogSchema } from '../src/shared/connectorCatalogSchema';
import { validateLocalFileSandboxRequirements } from './lib/validateCatalogImport';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const catalogPath = join(__dirname, '..', 'resources', 'connector-catalog.json');

const VALID_MATURITY = new Set(['stable', 'beta', 'deprecated', 'preview']);

interface InvariantViolation {
  connectorId: string;
  message: string;
}

function checkRebelOssInvariants(catalog: { connectors: Array<Record<string, unknown>> }): InvariantViolation[] {
  const violations: InvariantViolation[] = [];

  for (const connector of catalog.connectors) {
    const id = String(connector.id ?? '<unknown>');

    const maturity = connector.maturity;
    if (maturity !== undefined && (typeof maturity !== 'string' || !VALID_MATURITY.has(maturity))) {
      violations.push({
        connectorId: id,
        message: `\`maturity\` must be one of ${[...VALID_MATURITY].join('|')} or omitted (got ${JSON.stringify(maturity)})`,
      });
    }

    if (connector.provider !== 'rebel-oss') continue;
    if (connector.hidden === true) continue;

    const mcpConfig = connector.mcpConfig as Record<string, unknown> | undefined;

    if (!mcpConfig) {
      violations.push({ connectorId: id, message: 'rebel-oss connector missing `mcpConfig`' });
      continue;
    }

    if (mcpConfig.transport !== 'stdio') {
      violations.push({
        connectorId: id,
        message: `rebel-oss connector \`mcpConfig.transport\` must be 'stdio' (got ${JSON.stringify(mcpConfig.transport)})`,
      });
    }

    if (mcpConfig.command !== 'npx') {
      violations.push({
        connectorId: id,
        message: `rebel-oss connector \`mcpConfig.command\` must be 'npx' (got ${JSON.stringify(mcpConfig.command)})`,
      });
    }

    const verifiedSource = connector.verifiedSource;
    if (typeof verifiedSource !== 'string' || !/^https?:\/\//.test(verifiedSource)) {
      violations.push({
        connectorId: id,
        message: `rebel-oss connector missing or malformed \`verifiedSource\` URL (got ${JSON.stringify(verifiedSource)})`,
      });
    }

    const tools = connector.tools;
    if (!Array.isArray(tools)) {
      violations.push({ connectorId: id, message: 'rebel-oss connector must have a `tools` array' });
    } else if (tools.length === 0) {
      violations.push({
        connectorId: id,
        message: 'rebel-oss connector must have a non-empty `tools` array (backfill from upstream `dist/tools/` or `registerTool()` calls)',
      });
    }
  }

  return violations;
}

function main(): void {
  console.log('📚 Connector Catalog Schema + rebel-oss Invariants Check');
  console.log('=======================================================\n');

  const raw = readFileSync(catalogPath, 'utf8');
  const parsed = JSON.parse(raw) as unknown;

  const zodResult = CatalogSchema.safeParse(parsed);
  if (!zodResult.success) {
    console.error(`❌ ${zodResult.error.issues.length} Zod schema violation(s):\n`);
    for (const issue of zodResult.error.issues.slice(0, 50)) {
      const path = issue.path.length > 0 ? issue.path.join('.') : '<root>';
      console.error(`   - [${path}] ${issue.code}: ${issue.message.slice(0, 200)}`);
    }
    if (zodResult.error.issues.length > 50) {
      console.error(`   …and ${zodResult.error.issues.length - 50} more.`);
    }
    console.error(
      '\nFix: align `resources/connector-catalog.json` with `src/shared/connectorCatalogSchema.ts`. ' +
        'If the catalog shape is correct but the schema is out of date, widen the schema (and ' +
        'matching runtime types in `src/shared/types/mcp.ts`).\n',
    );
    process.exit(1);
  }

  const catalog = parsed as { connectors: Array<Record<string, unknown>> };
  const violations = checkRebelOssInvariants(catalog);
  if (violations.length > 0) {
    console.error(`❌ ${violations.length} rebel-oss / maturity invariant violation(s):\n`);
    for (const violation of violations) {
      console.error(`   - [${violation.connectorId}] ${violation.message}`);
    }
    console.error(
      '\nFix: backfill the missing field(s) on the affected entries. See ' +
        '`scripts/__tests__/mcp-catalog.test.ts` and `mcp-catalog-schema.test.ts` ' +
        'for the canonical contract.\n',
    );
    process.exit(1);
  }

  // Local-file sandbox contract (260531 Runway postmortem, type_constraint):
  // every connector flagged requiresLocalFileSandbox: true must declare the
  // sandbox env keys with their exact placeholder values, so the host resolver
  // and cloud backfill produce a concrete user-trusted root at spawn time.
  let sandboxConnectors = 0;
  const sandboxViolations: string[] = [];
  for (const connector of catalog.connectors) {
    if (connector.requiresLocalFileSandbox === true) sandboxConnectors += 1;
    try {
      validateLocalFileSandboxRequirements(
        connector as {
          id: string;
          requiresLocalFileSandbox?: boolean;
          mcpConfig?: { env?: Record<string, string> };
        },
      );
    } catch (err) {
      sandboxViolations.push(err instanceof Error ? err.message : String(err));
    }
  }
  if (sandboxViolations.length > 0) {
    console.error(`❌ ${sandboxViolations.length} local-file sandbox contract violation(s):\n`);
    for (const message of sandboxViolations) {
      console.error(`   ${message}\n`);
    }
    process.exit(1);
  }

  console.log(
    `✅ ${catalog.connectors.length} connector(s) pass full Zod schema + rebel-oss + maturity invariants.\n` +
      `   Local-file sandbox contract verified for ${sandboxConnectors} flagged connector(s).\n`,
  );
}

main();
