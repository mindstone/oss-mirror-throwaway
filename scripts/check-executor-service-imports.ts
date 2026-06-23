#!/usr/bin/env npx tsx
/**
 * Anti-rot construction guard for the agent-turn executor's `@main/services/*`
 * dependency surface.
 *
 * WHY: `src/test-utils/bootRealAgentServices.ts` stands up the REAL agent-turn
 * service graph (with only `globalThis.fetch` stubbed) so that real
 * `executeAgentTurn` tests catch executor↔service contract drift. That value
 * decays SILENTLY if a future service is added to the executor but NOT wired
 * into the boot helper: a real-boot test would still go green while exercising
 * an under-booted graph (false green). See
 * docs/plans/260609_agent-turn-executor-real-services-boot/PLAN.md (Stage 6) and
 * its BOUNDARY_CHECKLIST.md.
 *
 * WHAT: statically extract the set of `@main/services/*` (and
 * `@main/services/.../*`) import specifiers from the executor and diff them
 * against a recorded baseline. ADDED specifiers (in source, not in baseline)
 * FAIL with a message pointing the author at the boot helper + BOUNDARY_CHECKLIST.
 * REMOVED specifiers (in baseline, not in source) also FAIL as a stale baseline.
 *
 * This mirrors the team's `check-*-chokepoint.ts` grep-style guard convention
 * (file-scoped static check wired into validate:fast via run-validate-fast.ts),
 * NOT a repo-wide ESLint rule. It is cheap/static, unlike the slow-tier real-
 * boot turn tests it protects.
 *
 * UPDATE: when you have CONFIRMED the new/removed dependency is correctly
 * reflected in bootRealAgentServices.ts (and the BOUNDARY_CHECKLIST), regenerate
 * the baseline with either:
 *     npx tsx scripts/check-executor-service-imports.ts --write
 *     UPDATE_BASELINE=1 npx tsx scripts/check-executor-service-imports.ts
 */
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..');
const EXECUTOR_PATH = path.join(
  REPO_ROOT,
  'src',
  'core',
  'services',
  'turnPipeline',
  'agentTurnExecute.ts',
);
const BASELINE_PATH = path.join(REPO_ROOT, 'scripts', 'executor-service-imports.baseline.json');
const BOOT_HELPER_REL = 'src/test-utils/bootRealAgentServices.ts';
const BOUNDARY_CHECKLIST_REL =
  'docs/plans/260609_agent-turn-executor-real-services-boot/BOUNDARY_CHECKLIST.md';

interface BaselineFile {
  readonly description: string;
  readonly source: string;
  readonly imports: readonly string[];
}

/**
 * Extract every `@main/services/...` module specifier reached from an
 * `import`/`export ... from`/dynamic `import(...)` in the given source text.
 *
 * Robust to multi-line import statements (we match only the quoted module
 * specifier, which is single-line even when the named-binding list spans many
 * lines) and to both static and dynamic forms. We deliberately scan the literal
 * specifier rather than parsing the binding list, matching the team's
 * grep-based guard style — but we anchor on `from '...'` / `import('...')` so we
 * do NOT pick up `@main/services/...` mentions inside comments or string data.
 */
function extractMainServiceImports(sourceText: string): string[] {
  const specifiers = new Set<string>();
  // `from '@main/services/...'` (static import / re-export) and
  // `import('@main/services/...')` (dynamic import). The character class for the
  // path excludes the quote so we capture the full specifier exactly.
  const importFromRe = /\bfrom\s*['"](@main\/services\/[^'"]+)['"]/g;
  const dynamicImportRe = /\bimport\s*\(\s*['"](@main\/services\/[^'"]+)['"]\s*\)/g;

  for (const re of [importFromRe, dynamicImportRe]) {
    let match: RegExpExecArray | null;
    while ((match = re.exec(sourceText)) !== null) {
      specifiers.add(match[1]);
    }
  }
  return [...specifiers].sort();
}

function readBaseline(): BaselineFile {
  const raw = fs.readFileSync(BASELINE_PATH, 'utf8');
  const parsed = JSON.parse(raw) as unknown;
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !Array.isArray((parsed as { imports?: unknown }).imports)
  ) {
    throw new Error(
      `Malformed baseline at ${path.relative(REPO_ROOT, BASELINE_PATH)}: expected { imports: string[] }.`,
    );
  }
  return parsed as BaselineFile;
}

function writeBaseline(imports: readonly string[]): void {
  const payload: BaselineFile = {
    description:
      'Anti-rot baseline: the set of @main/services/* module specifiers imported by ' +
      'the agent-turn executor (src/core/services/turnPipeline/agentTurnExecute.ts). ' +
      'On ADD/REMOVE, confirm the change is reflected in ' +
      `${BOOT_HELPER_REL} (+ ${BOUNDARY_CHECKLIST_REL}) then regenerate with ` +
      'scripts/check-executor-service-imports.ts --write. Guarded in validate:fast.',
    source: 'src/core/services/turnPipeline/agentTurnExecute.ts',
    imports: [...imports].sort(),
  };
  fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function main(): void {
  if (!fs.existsSync(EXECUTOR_PATH)) {
    console.error(`❌ Executor not found at ${path.relative(REPO_ROOT, EXECUTOR_PATH)}.`);
    process.exit(1);
  }

  const sourceText = fs.readFileSync(EXECUTOR_PATH, 'utf8');
  const current = extractMainServiceImports(sourceText);

  const shouldWrite = process.argv.includes('--write') || process.env.UPDATE_BASELINE === '1';
  if (shouldWrite) {
    writeBaseline(current);
    console.log(
      `✓ Wrote executor @main/services baseline (${current.length} specifiers) → ` +
        `${path.relative(REPO_ROOT, BASELINE_PATH)}`,
    );
    return;
  }

  if (!fs.existsSync(BASELINE_PATH)) {
    console.error(
      `❌ No baseline at ${path.relative(REPO_ROOT, BASELINE_PATH)}. ` +
        `Generate it with: npx tsx scripts/check-executor-service-imports.ts --write`,
    );
    process.exit(1);
  }

  const baseline = readBaseline();
  const baselineSet = new Set(baseline.imports);
  const currentSet = new Set(current);

  const added = current.filter((s) => !baselineSet.has(s));
  const removed = baseline.imports.filter((s) => !currentSet.has(s));

  if (added.length === 0 && removed.length === 0) {
    console.log(
      `✓ Executor @main/services import surface matches baseline (${current.length} specifiers). ` +
        `Real-boot helper coverage cannot rot silently.`,
    );
    return;
  }

  const lines: string[] = [];
  if (added.length > 0) {
    lines.push(
      `❌ The agent-turn executor gained NEW @main/services dependencies not in the baseline:`,
      ...added.map((s) => `   + ${s}`),
      ``,
      `A new executor service dependency was added. Before updating this baseline you MUST`,
      `confirm the service is wired into the real-boot helper:`,
      `   ${BOOT_HELPER_REL}`,
      `and recorded in the boundary contract:`,
      `   ${BOUNDARY_CHECKLIST_REL}`,
      `Otherwise a real-boot turn test (which only stubs globalThis.fetch) will run against an`,
      `under-booted graph and go green while NOT exercising this service — a silent false green.`,
    );
  }
  if (removed.length > 0) {
    if (lines.length > 0) lines.push(``);
    lines.push(
      `❌ The baseline lists @main/services dependencies the executor no longer imports (STALE):`,
      ...removed.map((s) => `   - ${s}`),
      ``,
      `The executor dropped these dependencies; the boot helper / BOUNDARY_CHECKLIST may now`,
      `over-boot. Re-confirm the helper, then refresh the baseline.`,
    );
  }
  lines.push(
    ``,
    `Once confirmed, regenerate the baseline with:`,
    `   npx tsx scripts/check-executor-service-imports.ts --write`,
  );
  console.error(lines.join('\n'));
  process.exit(1);
}

main();
