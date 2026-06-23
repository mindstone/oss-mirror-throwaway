#!/usr/bin/env npx tsx
/**
 * CI Validation: Release Mapping Completeness
 *
 * Verifies that scripts/mcp-release-catalog-mapping.ts stays in lockstep with
 * resources/connector-catalog.json:
 *
 *   1. Every `@mindstone/mcp-server-<x>@<ver>` pin in the catalog resolves to
 *      a `CONNECTOR_RELEASE_MAPPINGS` entry OR an explicit `EXCLUDED_PACKAGES`
 *      exclusion (with a documented reason).
 *   2. For a mapped package, EVERY catalog entry that pins it is listed in the
 *      mapping's `catalogIds` (so a release bumps all pins atomically — see
 *      the email-imap 3-id case).
 *   3. Every mapping `catalogIds` entry exists in the catalog. An EMPTY
 *      `catalogIds` is valid by construction (canary — the internal
 *      release-pipeline test connector has zero user surface).
 *   4. Exclusions can't contradict mappings, and stale exclusions (package no
 *      longer pinned in the catalog) must be removed.
 *
 * Without this, a connector whose package is pinned in the catalog but absent
 * from the mapping is silently unreleasable via `npm run mcp:release <name>`
 * (the 24-of-35 deficit found 2026-06-11 — see
 * docs/plans/260611_mcp-landing-process/PLAN.md Stage 4).
 *
 * Run: npx tsx scripts/check-release-mapping-completeness.ts
 * Wired into: npm run validate:fast (scripts/run-validate-fast.ts)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CONNECTOR_RELEASE_MAPPINGS,
  EXCLUDED_PACKAGES,
  type ConnectorReleaseMapping,
  type ExcludedReleasePackage,
} from './mcp-release-catalog-mapping';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG_PATH = path.join(ROOT, 'resources', 'connector-catalog.json');
const MAPPING_FILE = 'scripts/mcp-release-catalog-mapping.ts';

const PIN_PATTERN = /^(@mindstone\/mcp-server-[a-z0-9-]+)@\d+\.\d+\.\d+(?:[-.][\w.]+)?$/;

export interface CatalogConnectorEntry {
  readonly id: string;
  readonly mcpConfig?: { readonly args?: readonly string[] };
}

/** One catalog entry pinning one @mindstone/mcp-server-* package. */
export interface CatalogPin {
  readonly catalogId: string;
  readonly npmPackage: string;
}

/** Extract every @mindstone/mcp-server-* pin from catalog `mcpConfig.args`. */
export function extractCatalogPins(connectors: readonly CatalogConnectorEntry[]): CatalogPin[] {
  const pins: CatalogPin[] = [];
  for (const entry of connectors) {
    for (const arg of entry.mcpConfig?.args ?? []) {
      const match = typeof arg === 'string' ? arg.match(PIN_PATTERN) : null;
      if (match) pins.push({ catalogId: entry.id, npmPackage: match[1] });
    }
  }
  return pins;
}

/**
 * Pure core of the check — exported for unit tests
 * (scripts/__tests__/check-release-mapping-completeness.test.ts pins the
 * current state and the failure modes against it).
 */
export function checkReleaseMappingCompleteness(
  connectors: readonly CatalogConnectorEntry[],
  mappings: Readonly<Record<string, ConnectorReleaseMapping>>,
  excluded: readonly ExcludedReleasePackage[],
): string[] {
  const errors: string[] = [];

  const pins = extractCatalogPins(connectors);
  const catalogIds = new Set(connectors.map((e) => e.id));
  const excludedPackages = new Set(excluded.map((e) => e.npmPackage));
  const mappingByPackage = new Map<string, ConnectorReleaseMapping>();
  for (const mapping of Object.values(mappings)) {
    mappingByPackage.set(mapping.npmPackage, mapping);
  }

  // 1 + 2: every catalog pin resolves to a mapping (covering that catalog id)
  // or an explicit exclusion.
  for (const pin of pins) {
    if (excludedPackages.has(pin.npmPackage)) {
      if (mappingByPackage.has(pin.npmPackage)) {
        errors.push(
          `${pin.npmPackage} is in EXCLUDED_PACKAGES but also has a CONNECTOR_RELEASE_MAPPINGS entry ` +
            `("${mappingByPackage.get(pin.npmPackage)!.name}") in ${MAPPING_FILE}. ` +
            `Pick one: remove the exclusion (package is releasable) or remove the mapping entry.`,
        );
      }
      continue;
    }
    const mapping = mappingByPackage.get(pin.npmPackage);
    if (!mapping) {
      const suffix = pin.npmPackage.replace('@mindstone/mcp-server-', '');
      errors.push(
        `Catalog entry "${pin.catalogId}" pins ${pin.npmPackage}, which has no release mapping. ` +
          `Add a ConnectorReleaseMapping entry to CONNECTOR_RELEASE_MAPPINGS in ${MAPPING_FILE} ` +
          `(name: '${suffix}', npmPackage: '${pin.npmPackage}', catalogIds: ['${pin.catalogId}']), ` +
          `or — if it is deliberately unreleasable via mcp:release — add it to EXCLUDED_PACKAGES with a documented reason.`,
      );
    } else if (!mapping.catalogIds.includes(pin.catalogId)) {
      errors.push(
        `Catalog entry "${pin.catalogId}" pins ${pin.npmPackage}, but the "${mapping.name}" mapping's ` +
          `catalogIds (${JSON.stringify([...mapping.catalogIds])}) does not include it. ` +
          `Add '${pin.catalogId}' to the "${mapping.name}" entry's catalogIds in ${MAPPING_FILE} ` +
          `so a release bumps every pin of this package atomically.`,
      );
    }
  }

  // 3: every mapping catalogId exists in the catalog. Empty catalogIds is
  // valid by construction (internal test connectors with no user surface).
  for (const mapping of Object.values(mappings)) {
    for (const id of mapping.catalogIds) {
      if (!catalogIds.has(id)) {
        errors.push(
          `Mapping "${mapping.name}" in ${MAPPING_FILE} lists catalogId '${id}', which does not exist in ` +
            `resources/connector-catalog.json. Fix the id or remove it from the entry's catalogIds.`,
        );
      }
    }
  }

  // 4 (stale exclusions): an exclusion whose package no longer appears in the
  // catalog is dead config — remove it so the exclusion list stays honest.
  const pinnedPackages = new Set(pins.map((p) => p.npmPackage));
  for (const exclusion of excluded) {
    if (exclusion.reason.trim().length < 20) {
      errors.push(
        `EXCLUDED_PACKAGES in ${MAPPING_FILE}: ${exclusion.npmPackage} has a blank or trivial reason. ` +
          `Exclusions must document WHY the package is unreleasable and what would change that.`,
      );
    }
    if (!pinnedPackages.has(exclusion.npmPackage)) {
      errors.push(
        `EXCLUDED_PACKAGES in ${MAPPING_FILE} lists ${exclusion.npmPackage}, but no catalog entry pins it ` +
          `any more. Remove the stale exclusion.`,
      );
    }
  }

  return errors;
}

function main(): number {
  const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8')) as {
    connectors?: CatalogConnectorEntry[];
  };
  const connectors = catalog.connectors ?? [];
  if (connectors.length === 0) {
    process.stderr.write(
      `check-release-mapping-completeness: FAIL — no connectors found in ${CATALOG_PATH} (schema change?)\n`,
    );
    return 1;
  }

  const errors = checkReleaseMappingCompleteness(
    connectors,
    CONNECTOR_RELEASE_MAPPINGS,
    EXCLUDED_PACKAGES,
  );

  if (errors.length === 0) {
    const mapped = Object.keys(CONNECTOR_RELEASE_MAPPINGS).length;
    process.stdout.write(
      `check-release-mapping-completeness: OK — ${mapped} mapping(s) + ${EXCLUDED_PACKAGES.length} exclusion(s) ` +
        `cover every @mindstone/mcp-server-* pin in the catalog.\n`,
    );
    return 0;
  }

  process.stderr.write(
    `check-release-mapping-completeness: FAIL — ${errors.length} problem(s) between ` +
      `resources/connector-catalog.json and ${MAPPING_FILE}:\n\n`,
  );
  for (const error of errors) {
    process.stderr.write(`  - ${error}\n`);
  }
  process.stderr.write(
    `\nSee docs/plans/260611_mcp-landing-process/PLAN.md Stage 4 for the policy.\n`,
  );
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
