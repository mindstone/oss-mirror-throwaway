/**
 * Print Cloud Schema Fingerprint
 *
 * Used by cloud-service/build.mjs to bake the schemaFingerprint into
 * dist/default-lkg.json at build time. Imports the SAME runtime helper the
 * cloud-service uses at startup so the baked fingerprint cannot drift from
 * the running value.
 *
 * Output: a single lowercase hex sha256 (64 chars) followed by a newline.
 * Build script asserts this format and aborts on mismatch.
 *
 * Lives in scripts/ (root) — not under cloud-service/ — because
 * cloud-service/package.json declares `"type": "module"` which causes tsx to
 * choke on TypeScript files importing from outside that scope. The other
 * scripts/*.ts files use the same import style and run via tsx without
 * issue, so we follow that convention here.
 *
 * Stage C1 of docs/plans/260510_cloud_image_rollback_defense_in_depth.md.
 */

import { computeSchemaFingerprint } from '../src/core/services/schemaFingerprint';
import { ALL_STORE_VERSIONS } from '../src/core/constants';

process.stdout.write(`${computeSchemaFingerprint(ALL_STORE_VERSIONS)}\n`);
