import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
import { ConditionMeta, KNOWN_CONDITIONS } from '../src/core/sentry/knownConditions';

export interface SnapshotEntry {
  addedAt: string;
  /**
   * Delivery policy (Stage 6 of docs/plans/260610_improve-sentry-noise/PLAN.md):
   * `level` + `sink` are snapshotted so a silent re-level or sink flip
   * (e.g. `issue-stream` → `ledger-only`) shows up as a snapshot diff and a
   * `level-or-sink-mismatch` violation until the snapshot is regenerated —
   * making the change visible in review. Optional only for historical
   * tombstone entries (removed conditions are not compared).
   */
  level?: string;
  sink?: string;
  deprecatedAt?: string;
  removableAfter?: string;
  expectedDegradedUntil?: string;
}

export type Snapshot = Record<string, SnapshotEntry>;

export interface CheckOptions {
  now: Date;
}

export type LintRegexParitySubKind =
  | 'anchor-missing'
  | 'regex-not-found-after-anchor'
  | 'members-out-of-lockstep';

export interface CheckViolation {
  kind:
    | 'removed-active'
    | 'removed-deprecated-too-soon'
    | 'removed-deprecated-no-removable-after'
    | 'added-without-snapshot-update'
    | 'expired-degraded'
    | 'snapshot-mismatch'
    | 'level-or-sink-mismatch'
    | 'lint-regex-out-of-lockstep';
  condition: string;
  detail: string;
  recoveryHint: string;
  subKind?: LintRegexParitySubKind;
}

export interface WarnAdvisory {
  kind: 'near-expiry-degraded';
  condition: string;
  detail: string;
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const LINT_REGEX_RECOVERY_HINT = 'Update eslint.config.mjs knownStructuredErrorCaptureSelectors and src/core/sentry/knownConditions.ts together, then run npm run regenerate:known-conditions-snapshot if the registry changed.';

function sorted(values: string[]): string[] {
  return [...values].sort((a, b) => a.localeCompare(b));
}

function arraysEqual(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((value, index) => value === right[index]);
}

export function checkKnownConditions(
  liveRegistry: Record<string, ConditionMeta>,
  snapshot: Snapshot,
  options: CheckOptions,
): { violations: CheckViolation[]; warnings: WarnAdvisory[] } {
  const violations: CheckViolation[] = [];
  const warnings: WarnAdvisory[] = [];
  const nowTime = options.now.getTime();

  for (const [condition, snapEntry] of Object.entries(snapshot)) {
    if (!(condition in liveRegistry)) {
      if (!snapEntry.deprecatedAt) {
        violations.push({
          kind: 'removed-active',
          condition,
          detail: 'Entry was removed but snapshot has no deprecatedAt.',
          recoveryHint: `Entry \`${condition}\` was removed from the registry but has no \`deprecatedAt\` in the snapshot. Restore the entry, mark \`deprecatedAt: <today>\`, regenerate snapshot via \`npm run regenerate:known-conditions-snapshot\`, and merge. The entry can only be removed after \`removableAfter\`.`
        });
      } else if (!snapEntry.removableAfter) {
        violations.push({
          kind: 'removed-deprecated-no-removable-after',
          condition,
          detail: 'Entry was removed but its snapshot has deprecatedAt without removableAfter.',
          recoveryHint: `Entry \`${condition}\` was removed but its snapshot has \`deprecatedAt: ${snapEntry.deprecatedAt}\` without \`removableAfter\`. The snapshot is malformed — restore the entry, ensure \`removableAfter\` is set in the registry, regenerate snapshot, and re-attempt removal after \`removableAfter\` passes.`
        });
      } else {
        const removableTime = Date.parse(snapEntry.removableAfter);
        if (Number.isNaN(removableTime)) {
          violations.push({
            kind: 'snapshot-mismatch',
            condition,
            detail: `removableAfter (${snapEntry.removableAfter}) is not a valid date.`,
            recoveryHint: `Entry \`${condition}\` has a malformed \`removableAfter\` in its snapshot. Restore the entry, fix the date format (must be parseable ISO8601), regenerate snapshot, and re-attempt removal.`
          });
        } else if (removableTime > nowTime) {
          violations.push({
            kind: 'removed-deprecated-too-soon',
            condition,
            detail: `removableAfter (${snapEntry.removableAfter}) is in the future.`,
            recoveryHint: `Entry \`${condition}\` was removed but its snapshot \`removableAfter\` (${snapEntry.removableAfter}) has not yet passed (now: ${options.now.toISOString()}). Wait until ${snapEntry.removableAfter} before removal, OR keep the entry.`
          });
        }
      }
    }
  }

  for (const [condition, meta] of Object.entries(liveRegistry)) {
    if (!(condition in snapshot)) {
      violations.push({
        kind: 'added-without-snapshot-update',
        condition,
        detail: 'Entry is in registry but not in snapshot.',
        recoveryHint: `Entry \`${condition}\` was added to the registry but the snapshot does not include it. Run \`npm run regenerate:known-conditions-snapshot\` and commit the snapshot alongside the registry change.`
      });
    } else {
      // Delivery-policy parity: a level or sink change without a snapshot
      // regeneration fails here, so a silent re-level (e.g. warning→info) or
      // sink flip (issue-stream→ledger-only) always produces a reviewable
      // snapshot diff. See docs/project/ERROR_MONITORING_AND_SENTRY.md
      // (level semantics & sink policy).
      const snapEntry = snapshot[condition];
      const mismatches: string[] = [];
      if (snapEntry.level !== meta.level) {
        mismatches.push(`level (snapshot: ${snapEntry.level ?? '<missing>'}, registry: ${meta.level})`);
      }
      if (snapEntry.sink !== meta.sink) {
        mismatches.push(`sink (snapshot: ${snapEntry.sink ?? '<none>'}, registry: ${meta.sink ?? '<none>'})`);
      }
      if (mismatches.length > 0) {
        violations.push({
          kind: 'level-or-sink-mismatch',
          condition,
          detail: `Delivery policy diverged from snapshot: ${mismatches.join('; ')}.`,
          recoveryHint: `Entry \`${condition}\` changed its delivery policy (level/sink) without a snapshot update. If the change is intentional, run \`npm run regenerate:known-conditions-snapshot\` and commit the snapshot diff alongside the registry change — the diff is the review surface for re-levels and sink flips. If unintentional, revert the registry change.`
        });
      }
    }

    if (meta.expectedDegraded) {
      const untilTime = Date.parse(meta.expectedDegraded.until);
      if (untilTime < nowTime) {
        violations.push({
          kind: 'expired-degraded',
          condition,
          detail: `expectedDegraded.until (${meta.expectedDegraded.until}) is in the past.`,
          recoveryHint: `Entry \`${condition}\` (owner: ${meta.owner}) has \`expectedDegraded.until\` (${meta.expectedDegraded.until}) in the past (now: ${options.now.toISOString()}). Reason was: ${meta.expectedDegraded.reason}. Recovery options: bump \`until\` with new reason; remove \`expectedDegraded\` to make it a hard error; mark \`deprecatedAt\` if the condition no longer occurs.`
        });
      } else if (untilTime - nowTime <= SEVEN_DAYS_MS) {
        warnings.push({
          kind: 'near-expiry-degraded',
          condition,
          detail: `Entry \`${condition}\` (owner: ${meta.owner}) \`expectedDegraded.until\` (${meta.expectedDegraded.until}) is within 7 days. Plan re-evaluation.`
        });
      }
    }
  }

  return { violations, warnings };
}

export function checkLintRegexParity(
  eslintConfigText: string,
  liveRegistry: Record<string, ConditionMeta>,
): CheckViolation[] {
  const anchorIndex = eslintConfigText.indexOf('LOCKSTEP-ANCHOR:');
  if (anchorIndex === -1) {
    return [{
      kind: 'lint-regex-out-of-lockstep',
      condition: 'known-condition-lint-regex',
      detail: 'Could not find the "LOCKSTEP-ANCHOR:" comment marker in eslint.config.mjs. The CI parity check anchors regex extraction on this marker; removing or renaming it breaks the lockstep guarantee.',
      recoveryHint: LINT_REGEX_RECOVERY_HINT,
      subKind: 'anchor-missing',
    }];
  }

  const afterAnchor = eslintConfigText.slice(anchorIndex);
  const regexAfterAnchor =
    /Property\[key\.name='condition'\]\[value\.type='Literal'\]\[value\.value=\/\^\(([^)]+)\)\$\/\]/;
  const match = afterAnchor.match(regexAfterAnchor);

  if (!match) {
    return [{
      kind: 'lint-regex-out-of-lockstep',
      condition: 'known-condition-lint-regex',
      detail: 'Found "LOCKSTEP-ANCHOR:" comment but could not extract a Property[key.name=\'condition\'][value.type=\'Literal\'][value.value=/^(...)$/] selector after it.',
      recoveryHint: LINT_REGEX_RECOVERY_HINT,
      subKind: 'regex-not-found-after-anchor',
    }];
  }

  const lintMembers = sorted(match[1].split('|').filter(Boolean));
  const registryMembers = sorted(Object.keys(liveRegistry));

  if (arraysEqual(lintMembers, registryMembers)) {
    return [];
  }

  return [{
    kind: 'lint-regex-out-of-lockstep',
    condition: 'known-condition-lint-regex',
    detail: `ESLint known-condition tag regex members (${lintMembers.join(', ')}) do not match KNOWN_CONDITIONS keys (${registryMembers.join(', ')}).`,
    recoveryHint: LINT_REGEX_RECOVERY_HINT,
    subKind: 'members-out-of-lockstep',
  }];
}

// ---------------------------------------------------------------------------
// Placeholder audit (Stage 3, audit-only — does NOT fail CI)
// ---------------------------------------------------------------------------
//
// Detects KNOWN_CONDITIONS entries that have ZERO production callsites of
// `captureKnownCondition('<name>', ...)`. Such entries are "placeholders" —
// declared in the registry (with snapshot, lockstep regex, etc.) but never
// wired up to any emission site. This is legitimate for entries that land
// before their consumers, but should be visible so reviewers can confirm
// follow-through is on a roadmap, not lost.
//
// Audit-only: prints `[INFO]` lines, never returns violations / exits non-zero.
//
// See docs/plans/260503_post_wave1_invariant_locking_bundle.md § Stage 3.

export interface PlaceholderAuditResult {
  /** Conditions declared in the registry but with zero production callsites. */
  readonly placeholders: readonly string[];
  /** Production callsite count per registry condition (sorted by name). */
  readonly callsiteCounts: Readonly<Record<string, number>>;
}

const PLACEHOLDER_AUDIT_PROJECTS: readonly string[] = [
  'src',
  'cloud-service',
  'cloud-client',
  'mobile',
];

const PLACEHOLDER_AUDIT_SKIP_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  'dist',
  'out',
  'release',
  'build',
  '.electron-vite',
  '__tests__',
  '__mocks__',
  'coverage',
  'fixtures',
]);

function isProductionTsFile(filePath: string): boolean {
  if (!(filePath.endsWith('.ts') || filePath.endsWith('.tsx') || filePath.endsWith('.mts'))) {
    return false;
  }
  if (filePath.endsWith('.test.ts') || filePath.endsWith('.test.tsx')) return false;
  if (filePath.endsWith('.spec.ts') || filePath.endsWith('.spec.tsx')) return false;
  if (filePath.endsWith('.d.ts')) return false;
  return true;
}

function listProductionSourceFiles(rootDir: string): string[] {
  const results: string[] = [];
  for (const project of PLACEHOLDER_AUDIT_PROJECTS) {
    const projectRoot = path.join(rootDir, project);
    if (!fs.existsSync(projectRoot)) continue;
    const stack: string[] = [projectRoot];
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) continue;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        if (PLACEHOLDER_AUDIT_SKIP_DIRS.has(entry.name)) continue;
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
          continue;
        }
        if (entry.isFile() && isProductionTsFile(full)) {
          results.push(full);
        }
      }
    }
  }
  return results;
}

/**
 * Strip wrappers that don't change the runtime value of an expression so
 * `'foo' as const`, `<const>'foo'`, `('foo')` etc. are treated as the
 * underlying string literal for callsite-counting purposes.
 */
function unwrapValuePreservingExpression(expr: ts.Expression): ts.Expression {
  let cursor: ts.Expression = expr;
  // Cap to avoid pathological deeply-nested expressions.
  for (let i = 0; i < 8; i++) {
    if (ts.isAsExpression(cursor)) {
      cursor = cursor.expression;
      continue;
    }
    if (ts.isTypeAssertionExpression(cursor)) {
      cursor = cursor.expression;
      continue;
    }
    if (ts.isParenthesizedExpression(cursor)) {
      cursor = cursor.expression;
      continue;
    }
    if (ts.isSatisfiesExpression(cursor)) {
      cursor = cursor.expression;
      continue;
    }
    return cursor;
  }
  return cursor;
}

/**
 * Audit which KNOWN_CONDITIONS entries have zero production callsites.
 *
 * Syntactic identifier scan (NOT import-resolved): counts call expressions
 * whose callee identifier text is `captureKnownCondition` and whose first
 * argument is a (possibly `as const`-wrapped, parenthesized, or
 * type-asserted) string literal that matches a registry key. Module-scope
 * imports are not validated, so a hypothetical local function with the same
 * name in a different module would also be counted. The risk is small in
 * this repo: there is exactly one exported `captureKnownCondition` and
 * its callsites are tracked centrally.
 *
 * Wrapper-routed conditions (e.g., `model_error` is dispatched via a wrapper
 * in turnErrorRecovery, which itself calls `captureKnownCondition`) are
 * counted because the wrapper file is scanned as a production file.
 *
 * Test files (`__tests__/`, `*.test.ts`, `*.spec.ts`) are excluded so test
 * fixtures (e.g., `captureKnownCondition('cloud_outbox_stuck', ...)`) don't
 * mask a missing production call site. Same for `__mocks__/` and `fixtures/`.
 *
 * `evals/`, `scripts/`, `docs/`, `analyze*.ts` are not scanned because they
 * are not runtime application code.
 *
 * Comments and dynamic dispatch (variable references, template literals,
 * untyped string contexts) are not counted -- the AST visit only inspects
 * literal first arguments.
 */
export function auditPlaceholderConditions(
  rootDir: string,
  liveRegistry: Record<string, ConditionMeta>,
): PlaceholderAuditResult {
  const knownConditionNames = new Set(Object.keys(liveRegistry));
  const counts: Record<string, number> = {};
  for (const name of knownConditionNames) counts[name] = 0;

  const sourceFiles = listProductionSourceFiles(rootDir);

  for (const filePath of sourceFiles) {
    let source: string;
    try {
      source = fs.readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }
    // Cheap pre-filter: skip files that don't even mention the function name.
    // Safe: if the name appears anywhere -- code OR comment -- we parse and
    // let the AST visitor decide. A file with the name only in a comment
    // simply won't yield a CallExpression match.
    if (!source.includes('captureKnownCondition')) continue;

    const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true);

    function visit(node: ts.Node): void {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'captureKnownCondition' &&
        node.arguments.length >= 1
      ) {
        const first = unwrapValuePreservingExpression(node.arguments[0]);
        if (ts.isStringLiteral(first) && knownConditionNames.has(first.text)) {
          counts[first.text] = (counts[first.text] ?? 0) + 1;
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(sf);
  }

  const placeholders = Object.entries(counts)
    .filter(([, n]) => n === 0)
    .map(([name]) => name)
    .sort((a, b) => a.localeCompare(b));

  // Freeze the per-condition counts in deterministic order so callers can
  // diff/serialize without sort-order surprises.
  const sortedCounts: Record<string, number> = {};
  for (const name of [...knownConditionNames].sort((a, b) => a.localeCompare(b))) {
    sortedCounts[name] = counts[name] ?? 0;
  }

  return {
    placeholders: Object.freeze(placeholders),
    callsiteCounts: Object.freeze(sortedCounts),
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const snapshotPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data', 'known-conditions.snapshot.json');
  let snapshot: Snapshot = {};
  if (fs.existsSync(snapshotPath)) {
    snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  }

  const registryCheck = checkKnownConditions(KNOWN_CONDITIONS, snapshot, { now: new Date() });
  const eslintConfigPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'eslint.config.mjs');
  const lintRegexViolations = checkLintRegexParity(fs.readFileSync(eslintConfigPath, 'utf8'), KNOWN_CONDITIONS);
  const violations = [...registryCheck.violations, ...lintRegexViolations];
  const warnings = registryCheck.warnings;

  if (warnings.length > 0) {
    for (const w of warnings) {
      console.warn(`[WARN] ${w.detail}`);
    }
  }

  // Audit-only: detect KNOWN_CONDITIONS placeholders (zero production callsites).
  // Never fails CI; emits INFO so reviewers can confirm follow-through is on a roadmap.
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const audit = auditPlaceholderConditions(repoRoot, KNOWN_CONDITIONS);
  if (audit.placeholders.length > 0) {
    const noun = audit.placeholders.length === 1 ? 'entry' : 'entries';
    console.log(
      `[INFO] ${audit.placeholders.length} known-condition placeholder ${noun} ` +
        `(declared in registry, no production callsites): ${audit.placeholders.join(', ')}`,
    );
    console.log('[INFO] Callsite counts (production only, excludes tests/mocks/fixtures):');
    for (const [name, count] of Object.entries(audit.callsiteCounts)) {
      console.log(`         ${name}: ${count}`);
    }
    console.log(
      '[INFO] Placeholders are legitimate when consumers are queued; if no consumer is planned, ' +
        'consider deprecating per docs/project/ERROR_MONITORING_AND_SENTRY.md.',
    );
  }

  if (violations.length > 0) {
    for (const v of violations) {
      const kindLabel = v.subKind ? `${v.kind} (${v.subKind})` : v.kind;
      console.error(`[FAIL] ${kindLabel}: ${v.condition}`);
      console.error(`       Detail: ${v.detail}`);
      console.error(`       Hint: ${v.recoveryHint}`);
    }
    process.exit(1);
  }

  console.log('PASS — known conditions check');
  process.exit(0);
}
