#!/usr/bin/env npx tsx
/**
 * CI Validation: Cross-Surface Import Discipline (Stage 3)
 *
 * Blocks `@main/*` imports from `cloud-service/**` and `mobile/**` unless
 * the exact `(file, specifier)` pair is in the allowlist below. Catches BOTH
 * static `import { x } from '@main/...'` AND dynamic `await import('@main/...')`
 * forms — `@typescript-eslint/no-restricted-imports` does not cover dynamic
 * `import()` calls, so the script is the primary enforcement and ESLint is
 * the secondary belt-and-suspenders.
 *
 * Allowlist semantics:
 *   - Each entry is an exact `(file, specifier)` pair. Adding a NEW specifier
 *     to an already-allowlisted file is still a violation — that closes the
 *     "file-level bypass" class.
 *   - Each entry encodes a real deferred migration. Shrinking the list
 *     requires migrating the import to `@core/*` first.
 *
 * Run: npx tsx scripts/check-cross-surface-imports.ts
 * Wired into: npm run validate:fast
 *
 * @see docs/plans/260514_surface_capabilities_and_quick_wins.md (Stage 3)
 * @see scripts/check-core-imports.ts (sibling pattern for core layer)
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Allowlist — Stage 4.A reached 0 entries. One reintroduction for the Stage 0.5
// cross-surface symmetry contract test (cloud vs desktop output equality).
// ---------------------------------------------------------------------------

export interface AllowlistEntry {
  readonly file: string;
  readonly specifier: string;
  readonly reason: string;
}

const ALLOWLIST: ReadonlyArray<AllowlistEntry> = [
  {
    file: 'cloud-service/src/__tests__/mcpEnvResolver.test.ts',
    specifier: '@main/services/bundledMcpManager',
    reason:
      'Stage 0.5 cross-surface symmetry contract — intentionally imports the desktop helper applyProviderKeyMappingToEnv to assert the cloud resolver returns equal output for the same inputs. Removing this import requires lifting applyProviderKeyMappingToEnv into a shared @core/ location (deferred).',
  },
  {
    file: 'cloud-service/src/__tests__/mcpRoute.test.ts',
    specifier: '@main/services/bundledMcpManager',
    reason:
      'SF-7 post-write backfill route test — calls configureBundledMcpManager to point the bundled-MCP catalog at a temp dir so handleMcpConfig can resolve @main/services/catalogEnvBackfillMigration against a controlled fixture. Removing this import requires lifting configureBundledMcpManager (or a test seam for the catalog path override) into a shared @core/ location.',
  },
  {
    file: 'cloud-service/src/bootstrap.ts',
    specifier: '@main/services/bundledMcpManager',
    reason:
      'SF-7 runtime parity — cloud bootstrap pre-configures the bundled-MCP catalog dir before createHeadlessRuntime spawns Super-MCP, so the same catalog-env scrub/backfill machinery used by desktop runs identically in cloud. Plan: SF-7 in docs/plans/260520_runway_sandbox_central_trusted_roots.md. Removing requires lifting configureBundledMcpManager + backfillCatalogEnvForExistingServers into a shared @core/ location.',
  },
  {
    file: 'cloud-service/src/bootstrap.ts',
    specifier: '@main/services/catalogEnvBackfillMigration',
    reason:
      'SF-7 runtime parity (companion to bundledMcpManager above) — cloud bootstrap calls backfillCatalogEnvForExistingServers() to scrub stale desktop-resolved sandbox env values from already-migrated cloud configs. The original single-line cross-surface regex missed this multi-line dynamic `await import()` call; the AST-based scripts/check-cloud-bootstrap-policy.ts (Stage A3 of docs/plans/260527_cloud_capacity_optimisation_and_pressure_surfacing.md) detects it and points here for the explicit deferred-migration record. Plan: SF-7 in docs/plans/260520_runway_sandbox_central_trusted_roots.md. Removing requires lifting backfillCatalogEnvForExistingServers into a shared @core/ location alongside configureBundledMcpManager.',
  },
  {
    file: 'cloud-service/src/bootstrap.ts',
    specifier: '@main/services/safety/pendingApprovalsStore',
    reason:
      'Stage 14 mobile E2E harness B-variant — cloud bootstrap wires a test-mode-only e2eSeed dependency after the E2E safe-data-root guard so cloud routes can seed real pending tool approvals without importing @main from cloud-service/src/routes. Removing requires lifting the pending approval store behind a shared @core boundary.',
  },
  {
    file: 'cloud-service/src/bootstrap.ts',
    specifier: '@main/services/safety/cosPendingService',
    reason:
      'Stage 14 mobile E2E harness B-variant — cloud bootstrap wires a test-mode-only e2eSeed dependency after the E2E safe-data-root guard so cloud routes can seed real CoS pending-file conflicts without importing @main from cloud-service/src/routes. Removing requires lifting CoS pending staging behind a shared @core boundary.',
  },
  {
    file: 'cloud-service/src/__tests__/providerFailover.cloud.test.ts',
    specifier: '@main/services/turnErrorRecovery',
    reason:
      'Cross-surface 429 failover parity contract (mirrors the mcpEnvResolver.test.ts cross-surface symmetry archetype) — a cloud test that asserts the cloud build runs the REAL src/main recovery engine on the multi-provider rate-limit chain. The cloud build genuinely resolves @main/services/turnErrorRecovery to the real impl (electron-only stub is for the bundler), so driving the real handleRateLimitFallback (not a mock) is the whole point of the parity test (planner top-risk mitigation: mocking the handler would prove nothing). Removing this import requires lifting the recovery engine (handleRateLimitFallback / dispatchErrorRecovery) into a shared @core/ location — a deferred migration.',
  },
  {
    file: 'cloud-service/src/bootstrap.ts',
    specifier: '@main/services/openRouterTokenStorage',
    reason:
      'Layer 3 / DI-05 cloud parity (PLAN.md Stage L3a) — the cloud availability seam re-wire reads the live managed-key store via hasManagedOpenRouterKey(), the SAME registrant desktop wires in behindTheScenesClient.ts:29 (replacing the constant () => false stub). The function lives only in src/main/services/openRouterTokenStorage.ts (no @core equivalent); the cloud build resolves @main → src/main and the module is already in the cloud bundle via localModelProxyServer + src/core (turnAdmission.ts, agentTurnExecute.ts). Removing this requires lifting the managed-key storage into a shared @core/ location — the deferred architecture-smell cleanup tracked as PLAN.md L3.5.',
  },
  {
    file: 'cloud-service/src/routes/openRouterManagedKey.ts',
    specifier: '@main/services/openRouterTokenStorage',
    reason:
      'Layer 3 / DI-05 cloud parity (docs/plans/260622_mobile-record-recreated-session/PLAN.md, Stage L3a) — the cloud receive route for the relayed Mindstone managed key persists/clears it via saveManagedOpenRouterKey/clearManagedOpenRouterKey, which live ONLY in src/main/services/openRouterTokenStorage.ts (no @core equivalent). The cloud build genuinely resolves @main → src/main and the same module is already pulled into the cloud bundle out-of-band by localModelProxyServer (loadManagedOpenRouterKey) and by src/core itself (turnAdmission.ts, agentTurnExecute.ts import hasManagedOpenRouterKey from the same @main path). Removing this requires lifting the managed-key storage into a shared @core/ location — the deferred architecture-smell cleanup tracked as PLAN.md L3.5.',
  },
  {
    file: 'cloud-service/src/__tests__/openRouterManagedKeyRoute.test.ts',
    specifier: '@main/services/openRouterTokenStorage',
    reason:
      'Layer 3 / DI-05 route test (companion to cloud-service/src/routes/openRouterManagedKey.ts above) — asserts the cloud route persists/clears the relayed managed key via the REAL src/main storage (hasManagedOpenRouterKey/loadManagedOpenRouterKey/clearManagedOpenRouterKey), proving write→present and null→cleared against the same module the cloud build resolves. Removing this requires lifting the managed-key storage into a shared @core/ location (PLAN.md L3.5).',
  },
  {
    file: 'cloud-service/src/__tests__/managedKeyRouting.cloud.test.ts',
    specifier: '@main/services/openRouterTokenStorage',
    reason:
      'Layer 3 / DI-05 routing parity test — drives the REAL post-Layer-3 cloud availability seam (() => hasManagedOpenRouterKey()) with a key written to the real src/main store, asserting a `mindstone` route resolves dispatchable (mindstone-managed-key) not the missing-mindstone terminal arm. Mocking the storage would prove nothing about cross-surface resolution. Removing this requires lifting the managed-key storage into a shared @core/ location (PLAN.md L3.5).',
  },
  {
    file: 'cloud-service/src/__tests__/openRouterManagedKeyServerAuth.test.ts',
    specifier: '@main/services/openRouterTokenStorage',
    reason:
      'Layer 3 / DI-05 server-auth test (4th sibling of the openRouterTokenStorage carve-out above) — asserts the cloud managed-key route enforces server-side auth before persisting/clearing the relayed key, exercising hasManagedOpenRouterKey/clearManagedOpenRouterKey against the REAL src/main store the cloud build resolves. Mocking the storage would not prove cross-surface auth gating. Removing this requires lifting the managed-key storage into a shared @core/ location (PLAN.md L3.5).',
  },
];

// ---------------------------------------------------------------------------
// Exported helpers (unit-testable — match `findCoreImportViolations` shape)
// ---------------------------------------------------------------------------

export interface CrossSurfaceViolation {
  file: string;
  line: number;
  specifier: string;
  isDynamic: boolean;
  text: string;
}

function normalisePath(filePath: string): string {
  return filePath.split(path.sep).join('/');
}

/**
 * Pure detection: scans source for `@main/*` imports and returns those not
 * in the allowlist. Handles BOTH static `from '@main/...'` and dynamic
 * `import('@main/...')` forms. Strips line and block comments first so
 * commented-out code does not flag.
 *
 * The allowlist is matched on EXACT `(file, specifier)` pairs — adding a new
 * specifier to an already-allowlisted file still fires.
 */
export function findCrossSurfaceViolations(
  source: string,
  filePath: string,
  allowlist: ReadonlyArray<AllowlistEntry>,
): CrossSurfaceViolation[] {
  const violations: CrossSurfaceViolation[] = [];
  const lines = source.split('\n');
  let inBlockComment = false;
  const normalisedFile = normalisePath(filePath);
  const allowSet = new Set<string>(
    allowlist.map((entry) => `${entry.file}\u0000${entry.specifier}`),
  );

  for (let i = 0; i < lines.length; i++) {
    const originalLine = lines[i];
    let line = originalLine;
    const lineNum = i + 1;

    // Continue / exit block comment
    if (inBlockComment) {
      const endIdx = line.indexOf('*/');
      if (endIdx !== -1) {
        inBlockComment = false;
        line = line.slice(endIdx + 2);
      } else {
        continue;
      }
    }

    // Strip inline block comments (/* ... */ on one line)
    while (line.includes('/*')) {
      const startIdx = line.indexOf('/*');
      const endIdx = line.indexOf('*/', startIdx + 2);
      if (endIdx !== -1) {
        line = line.slice(0, startIdx) + line.slice(endIdx + 2);
      } else {
        line = line.slice(0, startIdx);
        inBlockComment = true;
        break;
      }
    }

    // Strip line comments
    const commentIdx = line.indexOf('//');
    if (commentIdx !== -1) {
      line = line.slice(0, commentIdx);
    }

    if (!line.trim()) continue;

    // Static / re-export: `from '@main/...'`
    const staticMatch = line.match(/from\s+['"](@main\/[^'"]+)['"]/);
    if (staticMatch) {
      const specifier = staticMatch[1];
      const key = `${normalisedFile}\u0000${specifier}`;
      if (!allowSet.has(key)) {
        violations.push({
          file: normalisedFile,
          line: lineNum,
          specifier,
          isDynamic: false,
          text: originalLine.trim(),
        });
      }
    }

    // Dynamic: `import('@main/...')` or `import("@main/...")`
    const dynamicRegex = /import\(\s*['"](@main\/[^'"]+)['"]\s*\)/g;
    let dynamicMatch: RegExpExecArray | null;
    while ((dynamicMatch = dynamicRegex.exec(line)) !== null) {
      const specifier = dynamicMatch[1];
      const key = `${normalisedFile}\u0000${specifier}`;
      if (!allowSet.has(key)) {
        violations.push({
          file: normalisedFile,
          line: lineNum,
          specifier,
          isDynamic: true,
          text: originalLine.trim(),
        });
      }
    }

    // require('@main/...')
    const requireRegex = /require\(\s*['"](@main\/[^'"]+)['"]\s*\)/g;
    let requireMatch: RegExpExecArray | null;
    while ((requireMatch = requireRegex.exec(line)) !== null) {
      const specifier = requireMatch[1];
      const key = `${normalisedFile}\u0000${specifier}`;
      if (!allowSet.has(key)) {
        violations.push({
          file: normalisedFile,
          line: lineNum,
          specifier,
          isDynamic: true,
          text: originalLine.trim(),
        });
      }
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// File collection
// ---------------------------------------------------------------------------

const SCAN_ROOTS = ['cloud-service', 'mobile', 'scripts/rebel-cli'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.vite', 'out', 'release']);

function parseExpectedCount(args: readonly string[]): number | null {
  const inline = args.find((arg) => arg.startsWith('--expected-count='));
  const splitIndex = args.indexOf('--expected-count');
  const raw = inline
    ? inline.slice('--expected-count='.length)
    : (splitIndex >= 0 ? args[splitIndex + 1] : undefined);

  if (raw === undefined) return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid --expected-count value: ${raw}`);
  }
  return parsed;
}

function collectFiles(rootDir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(rootDir)) return results;

  function walk(currentDir: string): void {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(fullPath);
      } else if (
        entry.name.endsWith('.ts')
        || entry.name.endsWith('.tsx')
        || entry.name.endsWith('.js')
        || entry.name.endsWith('.mjs')
        || entry.name.endsWith('.cjs')
      ) {
        results.push(fullPath);
      }
    }
  }

  walk(rootDir);
  return results;
}

// ---------------------------------------------------------------------------
// CLI runner — skipped when imported as a library. We detect direct invocation
// via `process.argv[1]` (matches the pattern in scripts/run-validate-fast.ts)
// so other validation scripts can `import { ALLOWLIST }` without triggering a
// duplicate scan. Vitest also sets VITEST as a belt-and-suspenders guard.
// ---------------------------------------------------------------------------

function isDirectInvocation(): boolean {
  if (process.env.VITEST) return false;
  try {
    return process.argv[1] === fileURLToPath(import.meta.url);
  } catch {
    // CommonJS fallback (tsx may compile to either format depending on config).
    return process.argv[1] !== undefined && process.argv[1].endsWith('check-cross-surface-imports.ts');
  }
}

if (isDirectInvocation()) {
  let expectedCount: number | null = null;
  try {
    expectedCount = parseExpectedCount(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  if (expectedCount !== null && expectedCount !== ALLOWLIST.length) {
    console.error(
      `✗ Allowlist count mismatch: expected ${expectedCount}, actual ${ALLOWLIST.length}.\n` +
      'Update ALLOWLIST and --expected-count together when draining planned entries.',
    );
    process.exit(1);
  }

  const REPO_ROOT = path.join(__dirname, '..');

  console.log('Checking cross-surface import discipline...\n');
  console.log(`Scanning: ${SCAN_ROOTS.map((r) => `${r}/`).join(', ')}`);
  console.log(`Allowlist: ${ALLOWLIST.length} entries\n`);

  const allViolations: CrossSurfaceViolation[] = [];
  let scannedCount = 0;

  for (const root of SCAN_ROOTS) {
    const absRoot = path.join(REPO_ROOT, root);
    const files = collectFiles(absRoot);
    scannedCount += files.length;
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8');
      const relativePath = normalisePath(path.relative(REPO_ROOT, file));
      const violations = findCrossSurfaceViolations(source, relativePath, ALLOWLIST);
      allViolations.push(...violations);
    }
  }

  if (allViolations.length > 0) {
    console.error(`✗ Found ${allViolations.length} cross-surface import violation(s):\n`);
    for (const v of allViolations) {
      const kind = v.isDynamic ? 'dynamic-import-main' : 'import-main';
      console.error(`  ${v.file}:${v.line} [${kind}]`);
      console.error(`    ${v.text}\n`);
    }
    console.error(
      'cloud-service/** and mobile/** must not import from src/main/.\n' +
        'If this coupling is intentional and reflects a deferred migration,\n' +
        'add the EXACT (file, specifier) pair to ALLOWLIST in\n' +
        'scripts/check-cross-surface-imports.ts with a reason. Adding a new\n' +
        'specifier to an already-allowlisted file is intentionally still a\n' +
        'violation — this closes the file-level-bypass class.\n\n' +
        'See: docs/plans/260514_surface_capabilities_and_quick_wins.md (Stage 3)',
    );
    process.exit(1);
  } else {
    console.log(
      `✓ ${scannedCount} files scanned across ${SCAN_ROOTS.join(', ')} — ` +
        `${ALLOWLIST.length} allowlisted imports preserved, no new violations.`,
    );
  }
}

// Exported for tests
export { ALLOWLIST };
