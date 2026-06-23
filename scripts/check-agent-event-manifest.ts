#!/usr/bin/env tsx
/**
 * R2 Stage 2 — manifest-guard CI walker (chunk **S2-CG**).
 *
 * Mitigates the **highest-priority risk** of the
 * `defineAgentEvent`-based AgentEvent manifest refactor:
 *
 *   > "Manifest becomes parallel-declaration #13 instead of replacing
 *   > #1-#12."
 *
 * (parent doc `docs/plans/260427_refactor_contract_manifest.md`,
 *  lines 356, 623, 651, 727 — Risks section, Stage 2 implementation
 *  checklist, follow-on action items.)
 *
 * Runs as part of `npm run validate:fast` AND
 * `npm run validate:r2-manifest-guard`. Fails the build loudly on any
 * of the following violations:
 *
 *   (a) **defineAgentEvent outside the manifest module.** Any
 *       `defineAgentEvent({...})` call in a file other than
 *       `src/shared/contracts/agentEventManifest.ts` is a
 *       parallel-declaration smell — it bypasses the single-source-of-
 *       truth invariant the manifest exists to enforce.
 *
 *   (b) **Hand-edits to derived export names.** The names
 *       `AgentEventSchema`, `COMPACTION_POLICY`, `SANITIZATION_POLICY`,
 *       and `buildAgentEvent` may only be `export`-declared in the
 *       manifest modules (`agentEventManifest.ts` /
 *       `agentEventPolicyManifest.ts`) OR at their pre-existing Stage 2
 *       shadow-derive counterpart locations (the allowlist below). New
 *       declarations elsewhere are blocked.
 *
 *   (c) **Spread expressions inside `defineAgentEvent` nested object
 *       literals at ANY depth.** Per Phase-6 review (gemini3.1-pro P1)
 *       and post-commit review (P0 recursion fix): `envelope: { ...baseEnv }`
 *       AND `envelope: { persistence: { ...baseEnv } }` AND deeper
 *       nestings all slip past TS-2353. The walker recurses into every
 *       object literal inside the `defineAgentEvent({...})` argument
 *       and reports `SpreadAssignment` at any nested depth.
 *
 *       **Allowed exceptions**:
 *       - **Top-level spread INTO `defineAgentEvent`'s immediate argument**
 *         (e.g. `defineAgentEvent({ ...agentEventPolicyManifest.tool, ... })`).
 *         Top-level extras are caught by `NoExtraKeys`'s closed-strict
 *         mapped-type intersection — this IS the legitimate composition
 *         pattern the manifest uses.
 *       - **Spread inside `z.object({...})` literal arguments**. Zod
 *         schemas use `...seqPayloadShape` as a typed Zod-shape merge.
 *         Detected by tracking whether the current literal is the
 *         argument to a `z.object` / `<obj>.object` call expression.
 *
 *       Refactor to inline literals at nested object positions if you
 *       genuinely need the same shape across variants, or extend
 *       `agentEventManifestAxes.ts`.
 *
 * **Known limitations** (not S2-CG's responsibility):
 *   - **Variable / function-call values at nested-axis positions** —
 *     e.g. `envelope: maybeMaliciousVar` or `envelope: buildEnv()`.
 *     The walker can only inspect inline literals it can see. Type-
 *     erasure bypasses (`as ` casts at the binding site) are addressed
 *     by S2-B2's ESLint rule plus the closed-strict `AgentEventManifestEntry`
 *     constraint — if `maybeMaliciousVar` has the typed `PersistenceFlags`
 *     shape, TS-2353 catches extras at its binding declaration.
 *   - `as AgentEvent` casts in consumer code → S2-B2 ESLint rule.
 *   - Runtime envelope-required-fields enforcement → `buildAgentEvent`
 *     itself (S2-C, defence-in-depth).
 *   - Structural drift between hand-authored `AgentEvent` and
 *     `AgentEventFromManifest` → S2-D parity corpus.
 *
 * Usage: `npx tsx scripts/check-agent-event-manifest.ts`
 *
 * @see docs/plans/260427_refactor_contract_manifest.md
 * @see docs/plans/260429_r2_stage2_chunked_implementation_plan.md
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Project-relative paths used to derive the per-root absolute paths. */
const MANIFEST_REL = path.join(
  'src',
  'shared',
  'contracts',
  'agentEventManifest.ts',
);
const POLICY_MANIFEST_REL = path.join(
  'src',
  'shared',
  'contracts',
  'agentEventPolicyManifest.ts',
);

function manifestModulesFor(rootDir: string): ReadonlySet<string> {
  return new Set([
    path.join(rootDir, MANIFEST_REL),
    path.join(rootDir, POLICY_MANIFEST_REL),
  ]);
}

/**
 * Stage 2 shadow-derive allowlist: the pre-existing hand-authored
 * counterparts that the manifest projections derive against. Stage 3
 * cutover deletes these and migrates consumers to the manifest
 * derivations — at which point the allowlist entry shrinks.
 *
 * Stage 3a-L1 (2026-05-01): `src/shared/utils/eventCompaction.ts` was
 * cut over to consume `COMPACTION_POLICY_FROM_MANIFEST` directly; the
 * private `COMPACTION_POLICY` local const is no longer hand-authored
 * (it aliases the manifest export with a `satisfies` guard preserved
 * for compile-time exhaustiveness). The allowlist entry was therefore
 * removed in the same commit.
 */
function shadowDeriveAllowlistFor(
  rootDir: string,
): ReadonlyMap<string, ReadonlySet<string>> {
  return new Map<string, ReadonlySet<string>>([
    [
      path.join(rootDir, 'src', 'shared', 'ipc', 'schemas', 'agent.ts'),
      new Set(['AgentEventSchema']),
    ],
  ]);
}

const GUARDED_NAMES: ReadonlySet<string> = new Set([
  'AgentEventSchema',
  'COMPACTION_POLICY',
  'SANITIZATION_POLICY',
  'buildAgentEvent',
]);

/**
 * Method names we treat as "Zod object constructors" — when their
 * argument is an object literal, we allow spread inside that literal
 * (Zod uses `...sharedShape` as a typed shape merge). Detection is by
 * call-expression callee name match: `z.object(...)`, `Z.object(...)`,
 * any `*.object(...)`, or bare `object(...)` if imported from Zod.
 *
 * We err on the side of generous detection here — false-allowing a
 * non-Zod `.object()` call is a missed spread, which is acceptable
 * given the realistic threat model (the spread bypass we're closing
 * is in `defineAgentEvent` axes, not arbitrary object-literal subtrees).
 */
const ZOD_OBJECT_METHOD_NAMES: ReadonlySet<string> = new Set(['object']);

export type ManifestGuardRule =
  | 'no-defineAgentEvent-outside-manifest'
  | 'no-shadow-derived-export'
  | 'no-spread-in-defineAgentEvent';

export interface Violation {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly rule: ManifestGuardRule;
  readonly message: string;
}

function listSourceFiles(rootDir: string): string[] {
  const results: string[] = [];
  const stack: string[] = [rootDir];
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
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!full.endsWith('.ts') && !full.endsWith('.tsx')) continue;
      if (full.endsWith('.d.ts')) continue;
      results.push(full);
    }
  }
  return results;
}

function getLineColumn(
  sourceFile: ts.SourceFile,
  pos: number,
): { line: number; column: number } {
  const lc = sourceFile.getLineAndCharacterOfPosition(pos);
  return { line: lc.line + 1, column: lc.character + 1 };
}

function isZodObjectCall(node: ts.CallExpression): boolean {
  const callee = node.expression;
  if (ts.isPropertyAccessExpression(callee)) {
    return ZOD_OBJECT_METHOD_NAMES.has(callee.name.text);
  }
  if (ts.isIdentifier(callee)) {
    return ZOD_OBJECT_METHOD_NAMES.has(callee.text);
  }
  return false;
}

/**
 * Collect identifier names in this source that bind to `defineAgentEvent`
 * via import-alias or local const-alias. Used to make rule (a) robust
 * against `import { defineAgentEvent as foo } from '...'` and
 * `const foo = defineAgentEvent;` bypasses (gemini3.1-pro P1 review).
 */
function collectDefineAgentEventAliases(sf: ts.SourceFile): Set<string> {
  const aliases = new Set<string>(['defineAgentEvent']);

  function visit(node: ts.Node): void {
    // import { defineAgentEvent as foo } from '...'
    if (
      ts.isImportDeclaration(node) &&
      node.importClause?.namedBindings &&
      ts.isNamedImports(node.importClause.namedBindings)
    ) {
      for (const elem of node.importClause.namedBindings.elements) {
        const importedName = elem.propertyName?.text ?? elem.name.text;
        if (importedName === 'defineAgentEvent') {
          aliases.add(elem.name.text);
        }
      }
    }
    // const foo = defineAgentEvent;
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (
          ts.isIdentifier(decl.name) &&
          decl.initializer &&
          ts.isIdentifier(decl.initializer) &&
          aliases.has(decl.initializer.text)
        ) {
          aliases.add(decl.name.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sf);
  return aliases;
}

/**
 * Pure source-string check (exported for unit tests). Returns violations
 * for the given source under the given absolute file path. The walker is
 * purely AST-driven; no type-checker is constructed (keeps runtime cheap
 * — single-pass over each file's syntax tree).
 */
export function checkSourceText(
  source: string,
  absPath: string,
  rootDir: string = ROOT,
): Violation[] {
  const violations: Violation[] = [];
  walkSource(source, absPath, rootDir, violations);
  return violations;
}

function checkFile(
  absPath: string,
  rootDir: string,
  violations: Violation[],
  manifestModules: ReadonlySet<string>,
  shadowAllowlist: ReadonlyMap<string, ReadonlySet<string>>,
): void {
  const source = fs.readFileSync(absPath, 'utf8');
  walkSource(
    source,
    absPath,
    rootDir,
    violations,
    manifestModules,
    shadowAllowlist,
  );
}

function walkSource(
  source: string,
  absPath: string,
  rootDir: string,
  violations: Violation[],
  manifestModules: ReadonlySet<string> = manifestModulesFor(rootDir),
  shadowAllowlist: ReadonlyMap<
    string,
    ReadonlySet<string>
  > = shadowDeriveAllowlistFor(rootDir),
): void {
  const sf = ts.createSourceFile(
    absPath,
    source,
    ts.ScriptTarget.Latest,
    true,
    absPath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const isManifestModule = manifestModules.has(absPath);
  const allowedShadowNames = shadowAllowlist.get(absPath);
  const relPath = path.relative(rootDir, absPath);
  const isTestFile =
    absPath.includes(`${path.sep}__tests__${path.sep}`) ||
    absPath.endsWith('.test.ts') ||
    absPath.endsWith('.test.tsx') ||
    absPath.endsWith('.spec.ts') ||
    absPath.endsWith('.spec.tsx');

  // Build the alias set up-front so rule (a) sees aliased
  // `defineAgentEvent` references (gemini3.1-pro P1).
  const defineAgentEventAliases = collectDefineAgentEventAliases(sf);

  /**
   * Recursively walk an object literal at any depth inside a
   * `defineAgentEvent({...})` argument tree, reporting any
   * `SpreadAssignment`. The walker descends into:
   *   - Property values that are themselves object literals.
   *   - CallExpression arguments whose callee is `*.object` (Zod
   *     z.object → spreads inside the Zod object literal are ALLOWED
   *     and are not reported, but we keep recursing in case the Zod
   *     literal itself contains a `defineAgentEvent`-relevant subtree
   *     via further property values, e.g. `payloadSchema:
   *     z.object({ field: someManifestRef })` — these are not
   *     spread-bypass risks).
   *   - Other CallExpression arguments (we walk them defensively in
   *     case some helper wraps an axis literal).
   *
   * `isTopLevelArg` is true only for the immediate object literal that
   * is the first argument to `defineAgentEvent`. At that depth, spreads
   * are ALLOWED (the `...agentEventPolicyManifest.<variant>` legitimate
   * composition pattern; top-level extras are caught by NoExtraKeys).
   */
  function checkObjectForSpreads(
    obj: ts.ObjectLiteralExpression,
    isTopLevelArg: boolean,
    inZodObject: boolean,
  ): void {
    for (const prop of obj.properties) {
      if (ts.isSpreadAssignment(prop)) {
        if (!isTopLevelArg && !inZodObject) {
          const lc = getLineColumn(sf, prop.getStart());
          violations.push({
            file: relPath,
            line: lc.line,
            column: lc.column,
            rule: 'no-spread-in-defineAgentEvent',
            message:
              `Spread expression inside a nested object literal of a ` +
              `defineAgentEvent({...}) argument bypasses TS-2353 ` +
              `closed-strict checks. Inline the keys, or — if a typed ` +
              `Zod-shape merge is intended — wrap in z.object({...}). ` +
              `(Phase-6 spread-aware S2-CG.)`,
          });
        }
        // Don't recurse into the spread expression itself — it points
        // at an Identifier or property access, not a literal.
        continue;
      }

      if (ts.isPropertyAssignment(prop)) {
        descendInitializer(prop.initializer, inZodObject);
      } else if (ts.isShorthandPropertyAssignment(prop)) {
        // Nothing to recurse into for shorthand `{ foo }`.
      }
    }
  }

  function descendInitializer(
    initializer: ts.Expression,
    inZodObject: boolean,
  ): void {
    if (ts.isObjectLiteralExpression(initializer)) {
      checkObjectForSpreads(initializer, false, inZodObject);
    } else if (ts.isCallExpression(initializer)) {
      const isZod = isZodObjectCall(initializer);
      for (const arg of initializer.arguments) {
        if (ts.isObjectLiteralExpression(arg)) {
          checkObjectForSpreads(arg, false, inZodObject || isZod);
        }
      }
    } else if (ts.isArrayLiteralExpression(initializer)) {
      for (const elem of initializer.elements) {
        if (ts.isObjectLiteralExpression(elem)) {
          checkObjectForSpreads(elem, false, inZodObject);
        }
      }
    }
    // Other initializer kinds (Identifier, PropertyAccessExpression,
    // function calls returning object) are not literal-walkable; the
    // type system catches their bypass via the closed-strict
    // `AgentEventManifestEntry` constraint.
  }

  function visit(node: ts.Node): void {
    // Rule (a): defineAgentEvent outside the manifest module.
    // Aliased identifiers (`import { defineAgentEvent as foo }` or
    // `const foo = defineAgentEvent`) are also caught.
    // Test files (legitimate fixture construction) are excluded.
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      defineAgentEventAliases.has(node.expression.text)
    ) {
      if (!isManifestModule && !isTestFile) {
        const lc = getLineColumn(sf, node.getStart());
        violations.push({
          file: relPath,
          line: lc.line,
          column: lc.column,
          rule: 'no-defineAgentEvent-outside-manifest',
          message:
            `defineAgentEvent() may only be called inside ` +
            `src/shared/contracts/agentEventManifest.ts. New variants ` +
            `must extend the manifest, not declare a parallel one. ` +
            `(Aliased call: '${node.expression.text}'.)`,
        });
      } else if (isManifestModule) {
        // Rule (c, scoped to manifest module): recursively walk the
        // call's first-argument literal and report spread at any
        // nested depth (top-level spread allowed; Zod-object spread
        // allowed — see header docstring).
        const arg = node.arguments[0];
        if (arg && ts.isObjectLiteralExpression(arg)) {
          checkObjectForSpreads(arg, true, false);
        }
      }
    }

    // Rule (b): hand-edits to guarded export names outside manifest +
    // allowlist.
    if (ts.isVariableStatement(node)) {
      const isExported = (node.modifiers ?? []).some(
        (m) => m.kind === ts.SyntaxKind.ExportKeyword,
      );
      if (isExported && !isManifestModule) {
        for (const decl of node.declarationList.declarations) {
          if (ts.isIdentifier(decl.name) && GUARDED_NAMES.has(decl.name.text)) {
            const name = decl.name.text;
            const allowed = allowedShadowNames?.has(name) === true;
            if (!allowed) {
              const lc = getLineColumn(sf, decl.name.getStart());
              violations.push({
                file: relPath,
                line: lc.line,
                column: lc.column,
                rule: 'no-shadow-derived-export',
                message:
                  `'${name}' is a manifest-derived name — declare it ` +
                  `in src/shared/contracts/agentEventManifest.ts (or ` +
                  `agentEventPolicyManifest.ts) only. If this is a ` +
                  `Stage-2 shadow-derive counterpart, extend the ` +
                  `SHADOW_DERIVE_ALLOWLIST and link to the Stage 3 ` +
                  `cutover plan.`,
              });
            }
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sf);
}

interface CheckResult {
  readonly violations: readonly Violation[];
  readonly filesScanned: number;
}

/**
 * Pure entry-point — exported for unit tests. Call with a single root
 * directory to scan; violations and file count are returned.
 */
export function runManifestGuard(rootDir: string): CheckResult {
  const srcDir = path.join(rootDir, 'src');
  const files = listSourceFiles(srcDir);
  const violations: Violation[] = [];
  // Compute the per-root manifest-module set and shadow-derive
  // allowlist once per run (P2 from gemini3.1-pro: avoid 5604
  // per-file allocations).
  const manifestModules = manifestModulesFor(rootDir);
  const shadowAllowlist = shadowDeriveAllowlistFor(rootDir);
  for (const file of files) {
    checkFile(file, rootDir, violations, manifestModules, shadowAllowlist);
  }
  return { violations, filesScanned: files.length };
}

export function main(): void {
  console.log('R2 S2-CG: manifest-guard walker');
  console.log('================================\n');

  const { violations, filesScanned } = runManifestGuard(ROOT);

  console.log(`Scanned ${filesScanned} source file(s).`);

  if (violations.length === 0) {
    console.log('PASS — no manifest-guard violations detected.\n');
    process.exit(0);
  }

  console.error(
    `\nFAIL — ${violations.length} manifest-guard violation(s):\n`,
  );
  for (const v of violations) {
    console.error(
      `  [${v.rule}] ${v.file}:${v.line}:${v.column}\n    ${v.message}\n`,
    );
  }
  console.error(
    'See docs/plans/260427_refactor_contract_manifest.md (lines 356, 623, ' +
      '651, 727) for the parallel-declaration risk this guard prevents.\n',
  );
  process.exit(1);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) ===
    fileURLToPath(import.meta.url)
) {
  main();
}
