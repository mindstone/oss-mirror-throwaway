#!/usr/bin/env npx tsx
/**
 * Overrides-validity gate: the committed `_recommendations_overrides.yaml` must be
 * valid and every override fingerprint must map to exactly one live recommendation
 * in the freshly-regenerated postmortem corpus.
 *
 * Runs `runTracker({ check: true })`, which parses the overrides file with a real
 * YAML parser (rejecting syntax errors + duplicate keys), schema-validates each
 * entry (status enum, required YYMMDD `last_revisited` for status overrides,
 * `rejection_reason` for rejected/wont-do, `absorbed_into` for absorbed,
 * `revisit_signal` for blocked-on-signal, and catalog-backed `cluster_id`), and
 * checks each fingerprint against the live corpus (0 matches = orphan, >1 =
 * ambiguous). The big generated index is NOT compared (it is a gitignored build
 * artifact); this gate does not require it to exist, so it is safe on a fresh CI
 * checkout.
 *
 * To resolve a failure:
 *   - Edit `docs-private/postmortems/_recommendations_overrides.yaml` — fix the
 *     malformed entry, or remove an orphaned fingerprint whose recommendation no
 *     longer exists in the corpus.
 *   - Only regenerate the full index when you actually need the artifact:
 *       npm run regenerate:postmortem-recommendations
 *
 * Wired into `validate:fast`.
 */

import * as fs from 'node:fs';

import {
  CLAIMS_PATH,
  formatClaimsValidationErrors,
  formatClaimsValidationWarnings,
  validateClaimsDetailed,
} from './recs-claim';
import {
  formatTrackerWarnings,
  loadClusterCatalogIfPresent,
  parseExistingIndex,
  runTracker,
} from './postmortem-recommendations-tracker';

function parseNow(argv: string[]): Date {
  const index = argv.indexOf('--now');
  if (index === -1) return new Date();
  const raw = argv[index + 1];
  if (!raw) {
    process.stderr.write('[postmortem-recommendations-tracker] FAIL: --now requires an ISO timestamp\n');
    process.exit(1);
  }
  const parsed = new Date(raw);
  if (!Number.isFinite(parsed.getTime())) {
    process.stderr.write(`[postmortem-recommendations-tracker] FAIL: invalid --now ${JSON.stringify(raw)}\n`);
    process.exit(1);
  }
  return parsed;
}

const result = runTracker({ check: true });
if (result.exitCode !== 0) {
  process.stderr.write(result.message);
  process.stderr.write(formatTrackerWarnings(result.warnings));
  process.exit(result.exitCode);
}
process.stderr.write(formatTrackerWarnings(result.warnings));

if (fs.existsSync(CLAIMS_PATH)) {
  const now = parseNow(process.argv.slice(2));
  const liveRows = parseExistingIndex(result.generatedYaml).rows;
  const clusterCatalog = loadClusterCatalogIfPresent();
  const claimsYaml = fs.readFileSync(CLAIMS_PATH, 'utf-8');
  const claimsValidation = validateClaimsDetailed(claimsYaml, liveRows, clusterCatalog, now);
  process.stderr.write(formatClaimsValidationWarnings(claimsValidation.warnings));
  if (claimsValidation.errors.length > 0) {
    process.stderr.write(formatClaimsValidationErrors(claimsValidation.errors));
    process.exit(1);
  }
}

process.exit(0);
