#!/usr/bin/env -S npx tsx --tsconfig tsconfig.node.json

/**
 * CI Validation: OperatorDefinition field producer-consumer precedence
 *
 * Several `OperatorDefinition` fields (src/shared/types/operators.ts) carry a
 * DOCUMENTED PRECEDENCE rule over an older/superseded field — the new field
 * should win when present, falling back to the old one otherwise:
 *
 *   - `consultationPrompt` precedes `body` (consult prompt source;
 *     see operatorConsultRunner.ts resolveConsultPromptSource)
 *   - `displayName`        precedes `name` (UI label; `displayName ?? name`)
 *
 * The 260531 Stage-8 completeness postmortem records the exact failure this
 * gate prevents: a precedence field was added to the type/schema, but several
 * FINAL consumers (renderer labels, consult runner, persisted restore) still
 * read ONLY the older canonical field — so the new contract was silently
 * ignored at the surfaces users actually see.
 *
 * Design — deliberately COARSE and registry-driven, NOT dataflow analysis.
 * Precedence is documented intent (nothing in the type system says
 * `consultationPrompt` should win over `body`), so the precedence pairs are a
 * hand-maintained registry. Adding a precedence field is rare and deliberate;
 * declaring the pair here is the author's one obligation. Two cheap assertions
 * per pair:
 *   1. New field is WIRED — declared on OperatorDefinition AND read in >=1
 *      non-test, non-typedef source file (catches "added to type, wired
 *      nowhere").
 *   2. No OLD-ONLY consumer — each declared consumer file that references the
 *      old field must also reference the new field (catches the postmortem's
 *      exact stale-consumer shape).
 *
 * Run: npx tsx scripts/check-operator-field-precedence-consumers.ts
 * Wired into: npm run validate:fast (validate:operator-field-precedence)
 *
 * @see docs/plans/260614_recs8-ci-gates/PLAN.md
 * @see docs-private/postmortems/260531_close_stage_8_completeness_gaps_before_c95cff9_postmortem.md
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';

const REPO_ROOT = path.resolve(__dirname, '..');
const OPERATOR_TYPES_PATH = path.join(REPO_ROOT, 'src/shared/types/operators.ts');

export interface PrecedencePair {
  /** The newer field that should win when present. */
  readonly newField: string;
  /** The older/superseded field it falls back to. */
  readonly oldField: string;
  /**
   * Final-consumer source files (repo-relative) that resolve this value to a
   * user/runtime/persistence surface. If any of these reads `oldField`, it must
   * also read `newField` (otherwise it ignores the precedence contract).
   */
  readonly consumers: readonly string[];
}

/**
 * Hand-maintained precedence registry for OperatorDefinition.
 * When you add a precedence field to OperatorDefinition, add its pair here.
 */
export const OPERATOR_PRECEDENCE_PAIRS: readonly PrecedencePair[] = [
  {
    newField: 'consultationPrompt',
    oldField: 'body',
    consumers: ['src/core/services/operatorConsultRunner.ts'],
  },
  {
    newField: 'displayName',
    oldField: 'name',
    consumers: [
      'src/renderer/features/operators/components/OperatorCard.tsx',
      'src/renderer/features/operators/components/OperatorDiaryViewer.tsx',
      'src/renderer/features/operators/OperatorsPanel.tsx',
      'src/renderer/components/MeetingCompanionBanner.tsx',
    ],
  },
];

export interface PrecedenceViolation {
  readonly kind: 'unwired-new-field' | 'missing-on-type' | 'old-only-consumer' | 'missing-consumer-file';
  readonly pair: PrecedencePair;
  readonly file?: string;
  readonly message: string;
}

export interface PrecedenceCheckResult {
  readonly exitCode: 0 | 1;
  readonly violations: readonly PrecedenceViolation[];
  readonly output: readonly string[];
}

export interface PrecedenceCheckDeps {
  /** Reads a repo-relative file. Returns null if it does not exist. */
  readFile(relPath: string): string | null;
  /** OperatorDefinition type source (used to confirm the field is declared). */
  operatorTypesSource: string;
  /**
   * Returns repo-relative source files (excluding tests + the type def) that
   * reference `field` — used to confirm a new field is wired SOMEWHERE.
   */
  filesReferencing(field: string): readonly string[];
  pairs?: readonly PrecedencePair[];
}

/**
 * Whether `source` reads `field` as a RUNTIME PROPERTY/BINDING access — using
 * the TypeScript AST, NOT raw text. We count only:
 *   - `obj.field` / `obj?.field`            (PropertyAccessExpression)
 *   - `obj['field']`                         (ElementAccessExpression, value position)
 *   - `const { field } = ...` / `({ field }) => ...` (BindingElement destructure)
 *
 * AST analysis (vs the earlier regex) eliminates false positives from
 * type-position syntax (`OperatorDefinition['displayName']` indexed-access
 * types, `{ consultationPrompt: string }` type literals), comments, and string
 * literals — and eliminates false negatives like typed parameter destructures
 * (`function Card({ name }: OperatorMetadata)`). The failure shape the
 * postmortem targets is reading the field OFF the operator object, so
 * property/binding access is the precise signal; a local variable merely NAMED
 * `displayName` does not count.
 */
export function referencesField(source: string, field: string): boolean {
  const sf = ts.createSourceFile('in.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let found = false;

  const visit = (node: ts.Node): void => {
    if (found) return;

    // obj.field / obj?.field
    if (ts.isPropertyAccessExpression(node) && node.name.text === field) {
      found = true;
      return;
    }

    // obj['field'] — value-position element access only (not an indexed-access TYPE)
    if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      node.argumentExpression.text === field
    ) {
      found = true;
      return;
    }

    // { field } / { field: alias } destructuring binding (incl. typed params)
    if (ts.isBindingElement(node)) {
      const nameOrProp = node.propertyName ?? node.name;
      if (ts.isIdentifier(nameOrProp) && nameOrProp.text === field) {
        found = true;
        return;
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sf);
  return found;
}

/** Whether OperatorDefinition declares `field` (a `field:` or `field?:` member). */
export function typeDeclaresField(operatorTypesSource: string, field: string): boolean {
  return new RegExp(`\\n\\s*${field}\\??\\s*:`).test(operatorTypesSource);
}

export function analyzeOperatorPrecedence(deps: PrecedenceCheckDeps): PrecedenceCheckResult {
  const pairs = deps.pairs ?? OPERATOR_PRECEDENCE_PAIRS;
  const violations: PrecedenceViolation[] = [];
  const output: string[] = [];

  for (const pair of pairs) {
    // Assertion 0: the new field must actually be declared on the type.
    if (!typeDeclaresField(deps.operatorTypesSource, pair.newField)) {
      violations.push({
        kind: 'missing-on-type',
        pair,
        message: `Precedence pair declares newField "${pair.newField}" but OperatorDefinition does not declare it. Remove the stale pair or restore the field.`,
      });
      continue;
    }

    // Assertion 1: the new field must be read somewhere outside the type def + tests.
    const refs = deps.filesReferencing(pair.newField);
    if (refs.length === 0) {
      violations.push({
        kind: 'unwired-new-field',
        pair,
        message: `Precedence field "${pair.newField}" (precedes "${pair.oldField}") is declared on OperatorDefinition but is not read by any non-test consumer. A new precedence field that no final consumer honors is the exact Stage-8 stale-consumer failure.`,
      });
    }

    // Assertion 2: each declared consumer that reads the OLD field must also read the NEW field.
    for (const consumer of pair.consumers) {
      const source = deps.readFile(consumer);
      if (source === null) {
        violations.push({
          kind: 'missing-consumer-file',
          pair,
          file: consumer,
          message: `Declared consumer "${consumer}" for precedence pair ${pair.newField}/${pair.oldField} does not exist. Update the registry in scripts/check-operator-field-precedence-consumers.ts.`,
        });
        continue;
      }
      const readsOld = referencesField(source, pair.oldField);
      const readsNew = referencesField(source, pair.newField);
      if (readsOld && !readsNew) {
        violations.push({
          kind: 'old-only-consumer',
          pair,
          file: consumer,
          message: `Final consumer "${consumer}" reads the superseded field "${pair.oldField}" but not the precedence field "${pair.newField}". It must honor "${pair.newField}" (falling back to "${pair.oldField}"), e.g. \`${pair.newField} ?? ${pair.oldField}\`.`,
        });
      }
    }
  }

  if (violations.length > 0) {
    output.push(`✗ OperatorDefinition field precedence: ${violations.length} violation(s)`);
    for (const v of violations) {
      output.push(`  [${v.kind}] ${pairLabel(v.pair)}${v.file ? ` @ ${v.file}` : ''}`);
      output.push(`    ${v.message}`);
    }
    return { exitCode: 1, violations, output };
  }

  output.push(
    `✓ OperatorDefinition field precedence: ${pairs.length} precedence pair(s) honored by all declared consumers`,
  );
  return { exitCode: 0, violations, output };
}

function pairLabel(pair: PrecedencePair): string {
  return `${pair.newField} precedes ${pair.oldField}`;
}

// ── File-system deps (production) ───────────────────────────────────────────

const SOURCE_GLOB_DIRS = ['src'];
const SKIP_DIR_NAMES = new Set(['__tests__', 'node_modules', '.vite']);

function* walkSourceFiles(absDir: string): Generator<string> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const abs = path.join(absDir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      yield* walkSourceFiles(abs);
    } else if (
      (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.test.tsx') &&
      !entry.name.endsWith('.d.ts')
    ) {
      yield abs;
    }
  }
}

function createFsDeps(): PrecedenceCheckDeps {
  const operatorTypesSource = fs.readFileSync(OPERATOR_TYPES_PATH, 'utf8');
  const typeDefRel = path.relative(REPO_ROOT, OPERATOR_TYPES_PATH);

  return {
    operatorTypesSource,
    readFile(relPath: string): string | null {
      const abs = path.join(REPO_ROOT, relPath);
      try {
        return fs.readFileSync(abs, 'utf8');
      } catch {
        return null;
      }
    },
    filesReferencing(field: string): string[] {
      const hits: string[] = [];
      for (const dir of SOURCE_GLOB_DIRS) {
        for (const abs of walkSourceFiles(path.join(REPO_ROOT, dir))) {
          const rel = path.relative(REPO_ROOT, abs);
          if (rel === typeDefRel) continue; // the declaration itself doesn't count as a consumer
          const source = fs.readFileSync(abs, 'utf8');
          if (referencesField(source, field)) hits.push(rel);
        }
      }
      return hits;
    },
  };
}

if (!process.env.VITEST) {
  let result: PrecedenceCheckResult;
  try {
    result = analyzeOperatorPrecedence(createFsDeps());
  } catch (error) {
    console.error('[check-operator-field-precedence-consumers] fatal:', error);
    process.exit(1);
  }
  for (const line of result.output) {
    if (result.exitCode === 0) console.log(line);
    else console.error(line);
  }
  process.exit(result.exitCode);
}
