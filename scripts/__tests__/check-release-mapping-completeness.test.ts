/**
 * Release-mapping completeness guard tests.
 *
 * The validate:fast step `check-release-mapping-completeness` enforces that
 * every `@mindstone/mcp-server-*` pin in resources/connector-catalog.json
 * resolves to a CONNECTOR_RELEASE_MAPPINGS entry (covering that catalog id) or
 * a documented EXCLUDED_PACKAGES exclusion — see
 * docs/plans/260611_mcp-landing-process/PLAN.md Stage 4 (the 24-of-35 mapping
 * deficit that made most connectors unreleasable via `npm run mcp:release`).
 *
 * These tests pin (a) the current repo state passing, and (b) each failure
 * mode firing, via the checker's exported pure function.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  checkReleaseMappingCompleteness,
  extractCatalogPins,
  type CatalogConnectorEntry,
} from '../check-release-mapping-completeness';
import {
  CONNECTOR_RELEASE_MAPPINGS,
  EXCLUDED_PACKAGES,
  type ConnectorReleaseMapping,
} from '../mcp-release-catalog-mapping';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function loadCatalogConnectors(): CatalogConnectorEntry[] {
  const catalog = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'resources', 'connector-catalog.json'), 'utf8'),
  ) as { connectors?: CatalogConnectorEntry[] };
  return catalog.connectors ?? [];
}

describe('check-release-mapping-completeness', () => {
  it('passes on the current catalog + mapping + exclusion state', () => {
    const connectors = loadCatalogConnectors();
    expect(connectors.length).toBeGreaterThan(0);

    const errors = checkReleaseMappingCompleteness(
      connectors,
      CONNECTOR_RELEASE_MAPPINGS,
      EXCLUDED_PACKAGES,
    );
    expect(errors, errors.join('\n')).toEqual([]);
  });

  it('canary (internal release-pipeline test connector) is mapped with empty catalogIds', () => {
    const canary = CONNECTOR_RELEASE_MAPPINGS.canary;
    expect(canary.npmPackage).toBe('@mindstone/mcp-server-canary');
    expect(canary.catalogIds).toEqual([]);
    // Empty catalogIds is valid by construction — pinned by the passing run above.
  });

  it('xero is a documented exclusion, not a mapping', () => {
    const names = Object.values(CONNECTOR_RELEASE_MAPPINGS).map((m) => m.npmPackage);
    expect(names).not.toContain('@mindstone/mcp-server-xero');

    const exclusion = EXCLUDED_PACKAGES.find(
      (e) => e.npmPackage === '@mindstone/mcp-server-xero',
    );
    expect(exclusion).toBeDefined();
    expect(exclusion!.reason).toContain('release ownership undecided');
  });

  it('fails (with an actionable message) when a mapping entry is removed', () => {
    const connectors = loadCatalogConnectors();
    const withoutSlack: Record<string, ConnectorReleaseMapping> = Object.fromEntries(
      Object.entries(CONNECTOR_RELEASE_MAPPINGS).filter(([name]) => name !== 'slack'),
    );

    const errors = checkReleaseMappingCompleteness(connectors, withoutSlack, EXCLUDED_PACKAGES);
    expect(errors.length).toBeGreaterThan(0);
    const slackError = errors.find((e) => e.includes('@mindstone/mcp-server-slack'));
    expect(slackError).toBeDefined();
    // The message must say exactly what to add and where.
    expect(slackError).toContain('bundled-slack');
    expect(slackError).toContain('scripts/mcp-release-catalog-mapping.ts');
    expect(slackError).toContain('EXCLUDED_PACKAGES');
  });

  it('fails when a catalog entry pins a mapped package but is missing from its catalogIds', () => {
    // email-imap maps one package to three catalog ids; dropping one must fail.
    const connectors = loadCatalogConnectors();
    const mutated: Record<string, ConnectorReleaseMapping> = {
      ...CONNECTOR_RELEASE_MAPPINGS,
      'email-imap': {
        ...CONNECTOR_RELEASE_MAPPINGS['email-imap'],
        catalogIds: ['bundled-icloud-mail', 'bundled-yahoo-mail'],
      },
    };

    const errors = checkReleaseMappingCompleteness(connectors, mutated, EXCLUDED_PACKAGES);
    const error = errors.find((e) => e.includes('bundled-custom-email'));
    expect(error, errors.join('\n')).toBeDefined();
    expect(error).toContain('email-imap');
    expect(error).toContain('catalogIds');
  });

  it('fails when a mapping lists a catalogId that does not exist in the catalog', () => {
    const connectors = loadCatalogConnectors();
    const mutated: Record<string, ConnectorReleaseMapping> = {
      ...CONNECTOR_RELEASE_MAPPINGS,
      slack: {
        ...CONNECTOR_RELEASE_MAPPINGS.slack,
        catalogIds: ['bundled-slack', 'bundled-does-not-exist'],
      },
    };

    const errors = checkReleaseMappingCompleteness(connectors, mutated, EXCLUDED_PACKAGES);
    const error = errors.find((e) => e.includes('bundled-does-not-exist'));
    expect(error, errors.join('\n')).toBeDefined();
    expect(error).toContain('does not exist');
  });

  it('fails when a package is both excluded and mapped', () => {
    const connectors = loadCatalogConnectors();
    const errors = checkReleaseMappingCompleteness(connectors, CONNECTOR_RELEASE_MAPPINGS, [
      ...EXCLUDED_PACKAGES,
      { npmPackage: '@mindstone/mcp-server-slack', reason: 'contradiction fixture' },
    ]);
    const error = errors.find(
      (e) => e.includes('@mindstone/mcp-server-slack') && e.includes('EXCLUDED_PACKAGES'),
    );
    expect(error, errors.join('\n')).toBeDefined();
  });

  it('fails on a stale exclusion (package no longer pinned in the catalog)', () => {
    const connectors = loadCatalogConnectors();
    const errors = checkReleaseMappingCompleteness(connectors, CONNECTOR_RELEASE_MAPPINGS, [
      ...EXCLUDED_PACKAGES,
      { npmPackage: '@mindstone/mcp-server-ghost', reason: 'stale fixture exclusion with a properly documented reason for the test' },
    ]);
    const error = errors.find((e) => e.includes('@mindstone/mcp-server-ghost'));
    expect(error, errors.join('\n')).toBeDefined();
    expect(error).toContain('stale');
  });

  it('extractCatalogPins finds the full pinned-package surface (incl. the email-imap 3-id case)', () => {
    const pins = extractCatalogPins(loadCatalogConnectors());
    const byPackage = new Map<string, string[]>();
    for (const pin of pins) {
      byPackage.set(pin.npmPackage, [...(byPackage.get(pin.npmPackage) ?? []), pin.catalogId]);
    }
    // 35 distinct packages pinned as of the Stage 4 backfill (2026-06-11);
    // growing is fine (the completeness check forces a mapping/exclusion),
    // shrinking unexpectedly would mean the regex or catalog schema drifted.
    expect(byPackage.size).toBeGreaterThanOrEqual(35);
    expect(byPackage.get('@mindstone/mcp-server-email-imap')).toEqual([
      'bundled-icloud-mail',
      'bundled-yahoo-mail',
      'bundled-custom-email',
    ]);
  });
});
