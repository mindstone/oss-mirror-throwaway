#!/usr/bin/env npx tsx
/**
 * AST-based check that integration test gates compose a provider-shape
 * predicate alongside any auth-shape helper or raw auth-field reference
 * (260419 prepush postmortem A3b), AND that integration tests do not
 * read from the legacy `claude.<canonical-field>` namespace directly
 * (260507 fullPath investigation).
 *
 * **What it catches** (per the 260419 + 260406 + 260507 sibling-pattern history):
 *   - `const canRun = !!getApiKeyForDirectUse(settings);` (the literal
 *     260419 misuse — auth-shape masquerading as provider gate).
 *   - `const apiKey = getApiKeyForDirectUse(s); const canRun = !!apiKey;`
 *     (one-level aliased return — the same shape Behavioral-Safety
 *     Round-2 surfaced).
 *   - `const apiKey = settings?.claude?.apiKey; const canRun = !!apiKey;`
 *     (raw-field gate — `rebelCore.integration.test.ts` Phase-6 Stage-1
 *     refinement target).
 *   - `const canRun = hasRequiredSetup(settings);` where the body of
 *     `hasRequiredSetup` is locally defined and composes auth-shape
 *     only without provider-shape (Phase-6 Round-2 review refinement —
 *     helper-recursion catches gate-shape leaks via small wrappers).
 *   - `mockSettings.claude.<field>` ANYWHERE in the test body, where
 *     `<field>` is any key in `MODEL_SETTINGS_FIELD_KEYS` (260507 —
 *     legacy-namespace mirror can drift from canonical `models.*`,
 *     piping a stale proxy-dialect string into the direct-Anthropic
 *     path). Use `getCurrentModel(settings)` /
 *     `getThinkingModel(settings)` / `getPermissionMode(settings)` etc.
 *     from `@core/rebelCore/settingsAccessors` instead.
 *
 * **What composes correctly** (PASS):
 *   - `const canRun = isDirectAnthropicConfig(settings) && !!apiKey;`
 *     (the documented A6 pattern — provider-shape AND auth-shape).
 *   - `const workingModel = getCurrentModel(settings);` (canonical
 *     accessor — reads `settings.models.*` first, falls through to
 *     `settings.claude.*` only when `models.*` lacks the key).
 *
 * **Escape-hatch grammar:**
 *   A `// SKIP-GATE-INTENT: <reason>` comment on the offending line (or
 *   the line immediately above) bypasses the check but is logged to
 *   stderr so reviewers see the suppression. An empty `<reason>` (e.g.
 *   `// SKIP-GATE-INTENT:` alone) is REJECTED — a rationale is required.
 *
 *   Live-API tests additionally must import `src/test-utils/liveApiHarness`
 *   unless they carry `// SKIP-LIVE-HARNESS-INTENT: <reason>` with a non-empty
 *   reason. This keeps the five live-tier invariants enforced by construction.
 *
 * **Source-of-truth imports:**
 *   `AUTH_SHAPE_HELPERS` is parsed at startup from
 *   `src/core/utils/authEnvUtils.ts` via AST, NOT a hardcoded list inside
 *   this script. `MODEL_SETTINGS_FIELD_KEYS` is parsed identically from
 *   `src/core/rebelCore/settingsAccessors.ts`. This prevents silent
 *   drift when a new helper or field is added to either module.
 *
 * **Scope:** `**\/*.integration.test.ts` under `src/`, `evals/`,
 * `cloud-service/`, and `tests/`.
 *
 * Run via: `npx tsx scripts/check-integration-test-provider-gates.ts`
 * Wired into `npm run validate:fast`.
 *
 * @see docs-private/postmortems/260419_prepush_live_api_integration_test_404_postmortem.md
 * @see docs/plans/260419_prepush_followups_roadmap.md (A3b)
 * @see docs-private/investigations/260507_fullpath_integration_proxy_dialect_routing_failure.md
 * @see src/core/utils/authEnvUtils.ts (AUTH_SHAPE_HELPERS)
 * @see src/core/rebelCore/settingsAccessors.ts (MODEL_SETTINGS_FIELD_KEYS, canonical accessors)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import { fileURLToPath } from 'node:url';

import { readFileToleratingVanished } from './lib/safeScanRead';

// Source-of-truth import (not an AST source-text walk). settingsAccessorsPure.ts
// is the renderer-safe pure twin (no node-only deps), so importing the constant
// here is safe under tsx and — unlike the old `parseStringArrayExport` of this
// file — follows TypeScript's module graph: a relocation or re-export of the
// declaration resolves correctly instead of silently breaking `validate:fast`.
// This removes the 260529 reexport-blindness landmine.
import { MODEL_SETTINGS_FIELD_KEYS } from '@core/rebelCore/settingsAccessorsPure';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The provider-shape predicate that must compose with any auth-shape gate. */
export const PROVIDER_SHAPE_PREDICATE = 'isDirectAnthropicConfig';

/**
 * Names that, when bound at the top level of an integration test, are
 * treated as a "gate". Their initializer is recursively analysed and
 * MUST compose `isDirectAnthropicConfig` (or sibling provider-shape
 * predicate) when it also references an auth-shape helper or raw auth
 * field.
 */
const GATE_BINDING_NAMES: ReadonlySet<string> = new Set([
  'canRun',
  'shouldSkip',
  'hasRequiredSetup',
]);

/**
 * Member-access "gate sinks" — call-expression callees whose argument
 * is treated as a gate expression in addition to (or instead of) gate
 * bindings.
 */
const GATE_CALLEE_PATTERNS: ReadonlyArray<{ object: string; property: string }> = [
  { object: 'describe', property: 'skipIf' },
  { object: 'it', property: 'skipIf' },
  { object: 'test', property: 'skipIf' },
];

/** Suppression-comment grammar. The reason is mandatory. */
const SUPPRESSION_REGEX = /\/\/\s*SKIP-GATE-INTENT:\s*(.+\S)/;
const EMPTY_SUPPRESSION_REGEX = /\/\/\s*SKIP-GATE-INTENT:\s*$/;
// Anchored to a real line-comment (`^\s*//`) so the marker is honoured only as
// an actual comment, not when it appears inside a string/array literal such as
// `const doc = "see // SKIP-LIVE-HARNESS-INTENT: x"` (review F3).
const LIVE_HARNESS_SUPPRESSION_REGEX = /^\s*\/\/\s*SKIP-LIVE-HARNESS-INTENT:\s*(.+\S)/;
const EMPTY_LIVE_HARNESS_SUPPRESSION_REGEX = /^\s*\/\/\s*SKIP-LIVE-HARNESS-INTENT:\s*$/;

export type GateViolation = {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly gateLabel: string;
  readonly reason: string;
};

export type GateSuppression = {
  readonly file: string;
  readonly line: number;
  readonly gateLabel: string;
  readonly justification: string;
};

export interface GateCheckResult {
  readonly violations: readonly GateViolation[];
  readonly suppressions: readonly GateSuppression[];
  readonly filesScanned: number;
  /**
   * Count of files enumerated by the walk but deleted before we could read
   * them (concurrent deletion / TOCTOU — see scripts/lib/safeScanRead.ts).
   * Benign under parallel test runs; never silently swallowed.
   */
  readonly vanishedDuringScan: number;
}

/**
 * Parse a top-level `<EXPORT_NAME> = [...] as const` array-literal export
 * out of `<filePath>` via AST so the list never drifts silently from
 * this script. Throws fail-closed if the declaration is missing,
 * renamed, or malformed — this is intentional: a missing declaration
 * is a code-health regression in its own right.
 */
function parseStringArrayExport(
  filePath: string,
  exportName: string,
): string[] {
  const source = fs.readFileSync(filePath, 'utf8');
  const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true);

  let parsed: string[] = [];

  function visit(node: ts.Node): void {
    if (parsed.length > 0) return;
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (
          ts.isIdentifier(decl.name) &&
          decl.name.text === exportName &&
          decl.initializer
        ) {
          // The initializer may be `[...] as const` or
          // `[...] as const satisfies <Type>` — strip both wrappers.
          let init: ts.Expression = decl.initializer;
          while (ts.isAsExpression(init) || ts.isSatisfiesExpression(init)) {
            init = init.expression;
          }
          if (ts.isArrayLiteralExpression(init)) {
            const list: string[] = [];
            for (const elem of init.elements) {
              if (ts.isStringLiteral(elem) || ts.isNoSubstitutionTemplateLiteral(elem)) {
                list.push(elem.text);
              }
            }
            parsed = list;
          }
        }
      }
    }
    if (parsed.length === 0) ts.forEachChild(node, visit);
  }
  visit(sf);

  if (parsed.length === 0) {
    throw new Error(
      `Could not parse ${exportName} from ${filePath}. ` +
        `Has the export been renamed or removed? Restore the source-of-truth ` +
        `list there before re-running this check.`,
    );
  }
  return parsed;
}

/**
 * Parse the `AUTH_SHAPE_HELPERS = [...] as const` literal out of
 * `src/core/utils/authEnvUtils.ts` via AST so the list never drifts
 * silently from this script. Falls back to a hard error if the
 * declaration is missing or malformed — this is intentional: a missing
 * declaration is a code-health regression in its own right.
 *
 * @param rootDir  Repo root used to resolve the source-of-truth path.
 */
export function loadAuthShapeHelpers(rootDir: string): string[] {
  return parseStringArrayExport(
    path.join(rootDir, 'src', 'core', 'utils', 'authEnvUtils.ts'),
    'AUTH_SHAPE_HELPERS',
  );
}

/**
 * Parse the `MODEL_SETTINGS_FIELD_KEYS = [...] as const satisfies
 * ReadonlyArray<keyof ModelSettings>` literal out of
 * `src/core/rebelCore/settingsAccessorsPure.ts` (the pure twin that
 * holds the canonical declaration since the 260518 logger-leak fix —
 * `settingsAccessors.ts` re-exports it for backwards compatibility)
 * Returned from the direct source-of-truth import at the top of this file, so
 * a rename / relocation / re-export of `MODEL_SETTINGS_FIELD_KEYS` is resolved
 * by TypeScript's module graph rather than a brittle source-text walk (the
 * 260529 failure mode). Returns a fresh array so callers can't mutate the
 * shared constant. (`loadAuthShapeHelpers` still AST-parses its own const;
 * that module is out of scope for this stage.)
 */
export function loadModelSettingsFieldKeys(): string[] {
  return [...MODEL_SETTINGS_FIELD_KEYS];
}

/**
 * Recursively walk a directory collecting `**\/*.integration.test.ts`
 * files. Skips `node_modules`, `dist`, `out`, `release`, `build`,
 * `.electron-vite`, and dotfiles.
 */
function listIntegrationTestFiles(rootDir: string): string[] {
  const projects = ['src', 'evals', 'cloud-service', 'tests'];
  const results: string[] = [];
  for (const project of projects) {
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
        if (
          entry.name === 'node_modules' ||
          entry.name === 'dist' ||
          entry.name === 'out' ||
          entry.name === 'release' ||
          entry.name === 'build' ||
          entry.name === '.electron-vite'
        ) {
          continue;
        }
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
          continue;
        }
        if (entry.isFile() && full.endsWith('.integration.test.ts')) {
          results.push(full);
        }
      }
    }
  }
  return results;
}

/**
 * Per-file context. Locals binding to auth-shape calls / raw-field
 * accesses / provider-shape predicate calls are recorded here so gate
 * expressions can resolve aliased identifiers one level back.
 *
 * `localFunctionBodies` maps a locally-defined helper name (function
 * declaration or `const x = (...) => ...` arrow form) to the body
 * node we should recurse into when the gate expression calls it. This
 * lets `analyseExpression` see through indirection like
 * `const canRun = hasRequiredSetup(settings)` where `hasRequiredSetup`
 * is a one-liner defined nearby (Phase-6 review refinement; previously
 * the visitor stopped at the call boundary).
 */
interface FileContext {
  readonly authShapeLocals: Set<string>;
  readonly providerShapeLocals: Set<string>;
  readonly rawFieldLocals: Set<string>;
  readonly localFunctionBodies: Map<string, ts.Node>;
}

/** Cap recursion when following local helper calls so mutually-recursive
 *  helpers (extremely unlikely in tests, but cheap to defend) terminate. */
const MAX_HELPER_RECURSION_DEPTH = 3;

/**
 * True iff a property-access path looks like a raw direct-Anthropic auth field.
 *
 * Match is **suffix-based** on the access chain — we check for the
 * `…claude.apiKey` / `…claude.oauthToken` / `…openrouter.oauthToken` /
 * `…openRouter.oauthToken` shapes regardless of the root identifier name.
 * The earlier root-name allowlist (`settings`, `s`, anything containing
 * `setting`) was bypassable with `myConfig.claude.apiKey` and contradicted
 * the goal of catching the misuse class wherever it surfaces (per Round-3
 * reviewer-gemini3.1-pro finding).
 */
function isRawAuthFieldExpression(node: ts.Expression): boolean {
  if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) {
    return false;
  }
  // Stringify the chain by walking left until the root.
  const chain: string[] = [];
  let cursor: ts.Expression = node;
  // Cap recursion at 8 levels — in practice these chains are 3–5 deep.
  for (let i = 0; i < 8; i++) {
    if (ts.isPropertyAccessExpression(cursor)) {
      chain.push(cursor.name.text);
      cursor = cursor.expression;
    } else if (ts.isElementAccessExpression(cursor)) {
      // settings['claude'].apiKey style — extract the literal.
      if (ts.isStringLiteral(cursor.argumentExpression)) {
        chain.push(cursor.argumentExpression.text);
      } else {
        chain.push('<computed>');
      }
      cursor = cursor.expression;
    } else if (ts.isNonNullExpression(cursor)) {
      cursor = cursor.expression;
    } else {
      break;
    }
  }

  // Suffix-only matching against the access chain. Root identifier name
  // is intentionally ignored (per Round-3 fix) — `myConfig.claude.apiKey`
  // is just as much a leak as `settings.claude.apiKey`.
  const reversed = chain.slice().reverse(); // root-side property first
  // Match any of:
  //   <…>.claude.(apiKey|oauthToken)
  //   <…>.openrouter.(oauthToken)
  //   <…>.openRouter.(oauthToken)
  for (let i = 0; i < reversed.length - 1; i++) {
    const provider = reversed[i].toLowerCase();
    const field = reversed[i + 1];
    if (
      (provider === 'claude' && (field === 'apiKey' || field === 'oauthToken')) ||
      ((provider === 'openrouter') && field === 'oauthToken')
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Suffix-based check for `<…>.claude.<canonical-field>` against a
 * caller-supplied set of canonical-accessor field names. Returns the
 * matched field name when the access chain ends with one of the listed
 * legacy fields, or null otherwise.
 *
 * Root identifier name is intentionally ignored (same rationale as
 * `isRawAuthFieldExpression`): `myCfg.claude.model` is just as much a
 * leak as `settings.claude.model`.
 *
 * The `legacyFields` set is sourced at startup from
 * `MODEL_SETTINGS_FIELD_KEYS` in `settingsAccessors.ts` so the script
 * stays in sync with the canonical accessor surface (Phase-6 review
 * refinement; previously a hard-coded subset that could silently drift).
 *
 * @see docs-private/investigations/260507_fullpath_integration_proxy_dialect_routing_failure.md
 * @see src/core/rebelCore/settingsAccessors.ts (MODEL_SETTINGS_FIELD_KEYS)
 */
function matchRawLegacyModelField(
  node: ts.Expression,
  legacyFields: ReadonlySet<string>,
): string | null {
  if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) {
    return null;
  }
  const chain: string[] = [];
  let cursor: ts.Expression = node;
  for (let i = 0; i < 8; i++) {
    if (ts.isPropertyAccessExpression(cursor)) {
      chain.push(cursor.name.text);
      cursor = cursor.expression;
    } else if (ts.isElementAccessExpression(cursor)) {
      if (ts.isStringLiteral(cursor.argumentExpression)) {
        chain.push(cursor.argumentExpression.text);
      } else {
        chain.push('<computed>');
      }
      cursor = cursor.expression;
    } else if (ts.isNonNullExpression(cursor)) {
      cursor = cursor.expression;
    } else {
      break;
    }
  }
  const reversed = chain.slice().reverse();
  for (let i = 0; i < reversed.length - 1; i++) {
    const provider = reversed[i].toLowerCase();
    const field = reversed[i + 1];
    if (provider === 'claude' && legacyFields.has(field)) {
      return field;
    }
  }
  return null;
}

/** Strip `!`, `Boolean(...)`, parens, and `as` casts to get to the core. */
function stripCoercion(expr: ts.Expression): ts.Expression {
  let cur = expr;
  while (true) {
    if (ts.isParenthesizedExpression(cur)) {
      cur = cur.expression;
    } else if (ts.isPrefixUnaryExpression(cur) && cur.operator === ts.SyntaxKind.ExclamationToken) {
      cur = cur.operand;
    } else if (ts.isAsExpression(cur)) {
      cur = cur.expression;
    } else if (ts.isNonNullExpression(cur)) {
      cur = cur.expression;
    } else if (
      ts.isCallExpression(cur) &&
      ts.isIdentifier(cur.expression) &&
      cur.expression.text === 'Boolean' &&
      cur.arguments.length === 1
    ) {
      cur = cur.arguments[0];
    } else {
      break;
    }
  }
  return cur;
}

interface ExprAnalysis {
  hasAuthShape: boolean;
  hasRawField: boolean;
  hasProviderShape: boolean;
}

/**
 * Walk the file's top-level import declarations and record any local
 * binding name that aliases either an `AUTH_SHAPE_HELPERS` member or
 * the provider-shape predicate. The original Round-2 implementation
 * keyed solely on the callee identifier text, which made
 * `import { getApiKeyForDirectUse as fetchKey } from '...'`
 * an undetected escape hatch (Round-3 reviewer finding [HIGH, 4/6]).
 *
 * Returned sets contain *local* binding names. The expression analyser
 * checks both the original helper set and these alias sets.
 */
function buildImportAliasContext(
  sf: ts.SourceFile,
  authShapeHelpers: ReadonlySet<string>,
): { authShapeAliases: Set<string>; providerShapeAliases: Set<string> } {
  const authShapeAliases = new Set<string>();
  const providerShapeAliases = new Set<string>();

  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    const importClause = stmt.importClause;
    if (!importClause || !importClause.namedBindings) continue;
    if (!ts.isNamedImports(importClause.namedBindings)) continue;
    for (const spec of importClause.namedBindings.elements) {
      // `import { foo as bar }` — `propertyName` is `foo`, `name` is `bar`.
      // `import { foo }`        — `propertyName` is undefined, `name` is `foo`.
      const original = (spec.propertyName ?? spec.name).text;
      const local = spec.name.text;
      if (authShapeHelpers.has(original)) authShapeAliases.add(local);
      if (original === PROVIDER_SHAPE_PREDICATE) providerShapeAliases.add(local);
    }
  }

  return { authShapeAliases, providerShapeAliases };
}

/**
 * Recursively analyse an expression for auth-shape / raw-field /
 * provider-shape contributions. Resolves identifier references through
 * one level of file-local aliasing via the FileContext, and through
 * import-time aliasing via the alias sets.
 *
 * When the visitor encounters a `CallExpression` whose callee is an
 * identifier matching a locally-defined helper (function declaration
 * or arrow form bound at top-level), it recurses into that helper's
 * body up to `MAX_HELPER_RECURSION_DEPTH` levels deep. This prevents
 * gate-shape leaks via small wrapper helpers — e.g.
 * `const canRun = hasRequiredSetup(settings)` where
 * `hasRequiredSetup`'s body composes auth-shape only without
 * provider-shape (Phase-6 review refinement).
 */
function analyseExpression(
  expr: ts.Expression,
  ctx: FileContext,
  authShapeHelpers: ReadonlySet<string>,
  importAliases: { authShapeAliases: ReadonlySet<string>; providerShapeAliases: ReadonlySet<string> },
): ExprAnalysis {
  const result: ExprAnalysis = {
    hasAuthShape: false,
    hasRawField: false,
    hasProviderShape: false,
  };

  /** Helper-recursion depth; prevents infinite loops on mutually-recursive
   *  helpers and bounds analysis cost on long call chains. */
  let depth = 0;
  /** Names already entered on the current call stack — prevents direct
   *  recursion (`function fn() { return fn(); }`) regardless of depth cap. */
  const visiting = new Set<string>();

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression)) {
        const name = node.expression.text;
        if (name === PROVIDER_SHAPE_PREDICATE) result.hasProviderShape = true;
        if (importAliases.providerShapeAliases.has(name)) result.hasProviderShape = true;
        if (authShapeHelpers.has(name)) result.hasAuthShape = true;
        if (importAliases.authShapeAliases.has(name)) result.hasAuthShape = true;

        // Recurse into local helpers when the callee is a locally-defined
        // function whose body we've captured in the file context.
        const localBody = ctx.localFunctionBodies.get(name);
        if (
          localBody &&
          depth < MAX_HELPER_RECURSION_DEPTH &&
          !visiting.has(name)
        ) {
          depth++;
          visiting.add(name);
          try {
            visit(localBody);
          } finally {
            visiting.delete(name);
            depth--;
          }
        }
      }
    }
    if (ts.isIdentifier(node)) {
      const name = node.text;
      if (ctx.providerShapeLocals.has(name)) result.hasProviderShape = true;
      if (ctx.authShapeLocals.has(name)) result.hasAuthShape = true;
      if (ctx.rawFieldLocals.has(name)) result.hasRawField = true;
    }
    if (
      ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node)
    ) {
      if (isRawAuthFieldExpression(node)) result.hasRawField = true;
    }
    ts.forEachChild(node, visit);
  }
  visit(expr);

  return result;
}

/** Build the per-file alias context by walking top-level + describe-level bindings. */
function buildFileContext(
  sf: ts.SourceFile,
  authShapeHelpers: ReadonlySet<string>,
  importAliases: { authShapeAliases: ReadonlySet<string>; providerShapeAliases: ReadonlySet<string> },
): FileContext {
  const authShapeLocals = new Set<string>();
  const providerShapeLocals = new Set<string>();
  const rawFieldLocals = new Set<string>();
  const localFunctionBodies = new Map<string, ts.Node>();

  // First pass — collect local helper bodies (top-level only). We do
  // this before the alias pass so analyseExpression's helper-recursion
  // can resolve call chains regardless of declaration order within the
  // file. Restricted to top-level statements: a recursive walk would
  // let a nested helper with the same name as a top-level one win the
  // map slot, with no scope-awareness in the analyser to disambiguate.
  // Test files don't usually have such collisions, but the recursive
  // form was strictly broader than necessary.
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.body) {
      localFunctionBodies.set(stmt.name.text, stmt.body);
      continue;
    }
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.initializer) {
          const init = decl.initializer;
          if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
            // Arrow / function expression bodies are either a Block or an
            // expression (single-line arrow). Both are visitable nodes.
            localFunctionBodies.set(decl.name.text, init.body);
          }
        }
      }
    }
  }

  function visit(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.name)) {
      const stripped = stripCoercion(node.initializer);
      // Run a uniform deep analysis over the binding initializer. This
      // catches direct calls, raw-field accesses, binary/logical chains,
      // ternaries (`s ? !!getApiKeyForDirectUse(s) : false`), and arrow
      // bodies in one pass — without needing per-shape special cases.
      // The dummy context references the alias sets currently being
      // built; since this walker visits in document order, references
      // to earlier locals resolve correctly while later ones are simply
      // not yet recorded (one-level alias resolution).
      const dummyCtx: FileContext = {
        authShapeLocals,
        providerShapeLocals,
        rawFieldLocals,
        localFunctionBodies,
      };
      const analysis = analyseExpression(stripped, dummyCtx, authShapeHelpers, importAliases);
      if (analysis.hasAuthShape) authShapeLocals.add(node.name.text);
      if (analysis.hasProviderShape) providerShapeLocals.add(node.name.text);
      if (analysis.hasRawField) rawFieldLocals.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);

  return { authShapeLocals, providerShapeLocals, rawFieldLocals, localFunctionBodies };
}

/**
 * Look for a `// SKIP-GATE-INTENT: <reason>` comment on the gate-binding
 * line or the line directly above it. Returns the reason if non-empty,
 * `''` if a marker exists but the reason is missing/empty, or null if
 * no marker is present.
 */
function findSuppressionForGate(source: string, gateLine0Indexed: number): string | null {
  const lines = source.split('\n');
  for (const idx of [gateLine0Indexed - 1, gateLine0Indexed]) {
    if (idx < 0 || idx >= lines.length) continue;
    const line = lines[idx];
    if (EMPTY_SUPPRESSION_REGEX.test(line)) return '';
    const m = SUPPRESSION_REGEX.exec(line);
    if (m) return m[1].trim();
  }
  return null;
}

function findLiveHarnessIntent(source: string): { reason: string; line: number } | { reason: ''; line: number } | null {
  const lines = source.split('\n');
  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx];
    if (EMPTY_LIVE_HARNESS_SUPPRESSION_REGEX.test(line)) {
      return { reason: '', line: idx + 1 };
    }
    const match = LIVE_HARNESS_SUPPRESSION_REGEX.exec(line);
    if (match) {
      return { reason: match[1].trim(), line: idx + 1 };
    }
  }
  return null;
}

/**
 * Anchored match for the real shared harness module — NOT a loose
 * `endsWith('test-utils/liveApiHarness')`, which a look-alike local stub like
 * `./local-test-utils/liveApiHarness` (re-implementing none of the five
 * invariants) would satisfy (review F2). Accept only the canonical relative
 * path from `tests/live-api/` (`(../)+src/test-utils/liveApiHarness`) or a
 * `@test-utils/liveApiHarness` alias, so the gate enforces the *real* harness
 * by construction.
 */
const LIVE_API_HARNESS_SPECIFIER_REGEX = /^(?:(?:\.\.\/)+src\/test-utils\/liveApiHarness|@test-utils\/liveApiHarness)$/;

function hasLiveApiHarnessImport(sf: ts.SourceFile): boolean {
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    const moduleSpecifier = stmt.moduleSpecifier;
    if (!ts.isStringLiteral(moduleSpecifier)) continue;
    if (LIVE_API_HARNESS_SPECIFIER_REGEX.test(moduleSpecifier.text)) {
      return true;
    }
  }
  return false;
}

/**
 * Live-API integration tests must use the shared harness unless they carry an
 * explicit, non-empty intent comment. The harness enforces missing-key SKIP
 * behavior, one key-free skip diagnostic, key opacity, trim/blank handling, and
 * no retries by construction.
 */
export function findLiveHarnessViolations(source: string, relPath: string): GateViolation[] {
  if (!relPath.endsWith('.live.integration.test.ts')) {
    return [];
  }

  const sf = ts.createSourceFile(relPath, source, ts.ScriptTarget.Latest, true);
  if (hasLiveApiHarnessImport(sf)) {
    return [];
  }

  const intent = findLiveHarnessIntent(source);
  if (intent !== null && intent.reason.length > 0) {
    return [];
  }

  return [
    {
      file: relPath,
      line: intent?.line ?? 1,
      column: 1,
      gateLabel: 'live-harness-required',
      reason:
        `Live-API tests must import src/test-utils/liveApiHarness so missing-key SKIP behavior, key-free diagnostics, key opacity, trim/blank handling, and no-retry behavior are enforced by construction. ` +
        (intent?.reason === ''
          ? `(A '// SKIP-LIVE-HARNESS-INTENT:' marker was found but the rationale was empty — provide a non-empty reason or import the harness.)`
          : `Import the harness or annotate with '// SKIP-LIVE-HARNESS-INTENT: <reason>'.`),
    },
  ];
}

/**
 * True iff the SourceFile contains hard parse errors (missing braces,
 * unterminated calls, etc.). The compiler attaches these to the source
 * file via `parseDiagnostics` (see `ts.SourceFile['parseDiagnostics']`,
 * an internal-but-public property exposed through `getSourceFile`'s
 * full parsing path). We use that list rather than a full type-check
 * so this stays cheap.
 */
function hasFatalParseDiagnostics(sf: ts.SourceFile): ts.DiagnosticWithLocation[] {
  // `parseDiagnostics` is the unfiltered list of syntactic errors
  // produced by the parser. It's exposed as a (non-readonly) property
  // on the SourceFile node returned by `createSourceFile` when the
  // last argument (`setParentNodes`) is true. Cast through `unknown`
  // because the field is intentionally not part of the public typing.
  const diags = (sf as unknown as { parseDiagnostics?: ts.DiagnosticWithLocation[] }).parseDiagnostics ?? [];
  return diags.filter((d) => d.category === ts.DiagnosticCategory.Error);
}

/**
 * File-wide scan for raw legacy-namespace canonical-field reads
 * (`<…>.claude.<field>` for any `<field>` in
 * `MODEL_SETTINGS_FIELD_KEYS`). Unlike the gate-binding check above,
 * this fires anywhere in the test body — the failure mode introduced
 * in 260507 was a stale `claude.model` read inside the test body, not
 * in the eligibility gate. Scanning the gate alone would have missed it.
 *
 * Suppression grammar mirrors the gate-binding check
 * (`// SKIP-GATE-INTENT: <reason>` on the same/preceding line, with a
 * mandatory non-empty rationale).
 *
 * `gateRanges` are text ranges of expressions already handled by the
 * gate-composition pass (gate-binding initializers and gate-sink first
 * arguments). Nodes within those ranges are skipped here ONLY when
 * they are also raw auth-field accesses (`claude.apiKey` /
 * `claude.oauthToken` / `openrouter.oauthToken`) — the gate pass
 * surfaces those reads under its own `canRun` / `describe.skipIf`
 * label with composing-`isDirectAnthropicConfig` remediation guidance,
 * so reporting them twice would inflate counts.
 *
 * Crucially, non-auth legacy fields (`claude.model`,
 * `claude.thinkingModel`, `claude.permissionMode`, etc.) are NEVER
 * suppressed by gate ranges. The gate-composition pass does not
 * inspect those fields at all (`isRawAuthFieldExpression` only matches
 * the auth-shape fields), so a position-only dedup would silently hide
 * a legacy-model-read inside a gate that *appears* correctly composed.
 * Round-3 reviewers (`reviewer-gpt5.5-high` + `reviewer-opus4.7-thinking`
 * concurrently at 89% each) flagged this as the exact bug class the
 * AST guardrail is meant to prevent — see e.g.
 *   `const canRun = isDirectAnthropicConfig(s) && !!getApiKeyForDirectUse(s) && !!s.claude.model;`
 * where the legacy-model read is the gate-internal hazard, not the
 * gate-composition shape.
 */
function scanRawLegacyModelReads(
  sf: ts.SourceFile,
  source: string,
  relPath: string,
  legacyFields: ReadonlySet<string>,
  gateRanges: ReadonlyArray<readonly [number, number]>,
): { violations: GateViolation[]; suppressions: GateSuppression[] } {
  const violations: GateViolation[] = [];
  const suppressions: GateSuppression[] = [];

  function isInsideGateRange(start: number): boolean {
    for (const [s, e] of gateRanges) {
      if (start >= s && start < e) return true;
    }
    return false;
  }

  function visit(node: ts.Node): void {
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const matchedField = matchRawLegacyModelField(node, legacyFields);
      if (matchedField !== null) {
        const start = node.getStart(sf);
        const suppressedByGatePass =
          isRawAuthFieldExpression(node) && isInsideGateRange(start);
        if (!suppressedByGatePass) {
          const lc = sf.getLineAndCharacterOfPosition(start);
          const suppression = findSuppressionForGate(source, lc.line);
          const label = `legacy-model-read:${matchedField}`;
          if (suppression !== null && suppression.length > 0) {
            suppressions.push({
              file: relPath,
              line: lc.line + 1,
              gateLabel: label,
              justification: suppression,
            });
          } else {
            const reason =
              `Direct legacy-namespace read of '...claude.${matchedField}' in an integration test. ` +
              (suppression === ''
                ? `(A '// SKIP-GATE-INTENT:' marker was found but the rationale was empty — provide a non-empty reason or fix the read.) `
                : '') +
              `After the 260603/260604 settings namespace migration, 'claude.*' is a legacy mirror that can drift from canonical 'models.*'. ` +
              `Use the canonical accessor (e.g. 'getCurrentModel(settings)' / 'getThinkingModel(settings)' / 'getPermissionMode(settings)' from '@core/rebelCore/settingsAccessors') instead, ` +
              `or annotate with '// SKIP-GATE-INTENT: <reason>' on the same/preceding line if this read is intentional. ` +
              `See docs-private/investigations/260507_fullpath_integration_proxy_dialect_routing_failure.md.`;
            violations.push({
              file: relPath,
              line: lc.line + 1,
              column: lc.character + 1,
              gateLabel: label,
              reason,
            });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);

  return { violations, suppressions };
}

/** Pure source-string check (exported for unit tests). */
export function checkSourceText(
  source: string,
  relPath: string,
  authShapeHelpers: ReadonlyArray<string>,
  legacyModelFields: ReadonlyArray<string>,
): { violations: GateViolation[]; suppressions: GateSuppression[] } {
  const sf = ts.createSourceFile(relPath, source, ts.ScriptTarget.Latest, true);

  // Fail-closed on malformed TypeScript. Silently producing
  // `violations: []` for a file the parser couldn't fully understand
  // would let an integration test sneak through with no analysis at
  // all (the same class as the 260419 silent-success). Instead, throw
  // so `validate:fast` surfaces the file-level parse error and the
  // test author has to fix the syntax before the gate check can
  // re-evaluate the gate expression.
  const fatal = hasFatalParseDiagnostics(sf);
  if (fatal.length > 0) {
    const first = fatal[0];
    const lc = sf.getLineAndCharacterOfPosition(first.start);
    const message = ts.flattenDiagnosticMessageText(first.messageText, '\n');
    throw new Error(
      `Failed to parse ${relPath}:${lc.line + 1}:${lc.character + 1} — ` +
        `${message} (and ${fatal.length - 1} other syntax error(s)). ` +
        `Fix the syntax error before re-running the integration-test ` +
        `provider-gate check.`,
    );
  }

  const helperSet = new Set(authShapeHelpers);
  const legacyFieldSet = new Set(legacyModelFields);
  const importAliases = buildImportAliasContext(sf, helperSet);
  const ctx = buildFileContext(sf, helperSet, importAliases);

  const violations: GateViolation[] = [];
  const suppressions: GateSuppression[] = [];
  violations.push(...findLiveHarnessViolations(source, relPath));

  /**
   * Text ranges of expressions evaluated by the gate-composition pass
   * (gate-binding initializers + gate-sink first arguments). The
   * file-wide legacy-model-read scan skips nodes inside these ranges
   * to avoid double-reporting the same `claude.<field>` access under
   * two violation labels — see `scanRawLegacyModelReads`.
   */
  const gateRanges: Array<readonly [number, number]> = [];

  /**
   * Names of file-level gate bindings (`canRun`, `shouldSkip`, etc.)
   * that have already been analysed at their declaration site. When
   * `describe.skipIf(!canRun)` later references one of these by
   * identifier alone, don't re-report — the binding-site report covers
   * it. This keeps violation counts honest (one logical bug = one
   * violation) and avoids polluting suppression-comment grammar with
   * "did the comment apply to the binding or the skipIf?" ambiguity.
   */
  const analysedGateBindings = new Set<string>();

  function reportGate(
    expr: ts.Expression,
    label: string,
    /** Position to report (the gate identifier / call expression head). */
    reportNode: ts.Node,
  ): void {
    // Record the full text range of the gate expression so the
    // file-wide legacy-model-read scan can skip nodes already
    // evaluated here. We track every gate expression — including
    // correctly-composed ones — because the body-wide scan's purpose
    // is "use canonical accessors in the test body", not to gloss
    // gate semantics. A claude-field read inside a gate is the gate
    // pass's concern.
    gateRanges.push([expr.getStart(sf), expr.getEnd()]);

    const stripped = stripCoercion(expr);
    const analysis = analyseExpression(stripped, ctx, helperSet, importAliases);

    const usesAuthOrField = analysis.hasAuthShape || analysis.hasRawField;
    if (!usesAuthOrField) return;
    if (analysis.hasProviderShape) return;

    const lc = sf.getLineAndCharacterOfPosition(reportNode.getStart(sf));
    const suppression = findSuppressionForGate(source, lc.line);
    if (suppression !== null && suppression.length > 0) {
      suppressions.push({
        file: relPath,
        line: lc.line + 1,
        gateLabel: label,
        justification: suppression,
      });
      return;
    }

    const reason =
      `Gate '${label}' references ${analysis.hasAuthShape ? 'an auth-shape helper' : 'a raw auth field'}` +
      ` without composing '${PROVIDER_SHAPE_PREDICATE}'. ` +
      (suppression === '' ?
        `(A '// SKIP-GATE-INTENT:' marker was found but the rationale was empty — provide a non-empty reason or fix the gate.)` :
        `Add ${PROVIDER_SHAPE_PREDICATE}(settings) to the gate, or annotate with '// SKIP-GATE-INTENT: <reason>' on the same/preceding line.`);
    violations.push({
      file: relPath,
      line: lc.line + 1,
      column: lc.character + 1,
      gateLabel: label,
      reason,
    });
  }

  /**
   * If a `describe.skipIf` / `it.skipIf` argument boils down to a single
   * identifier (e.g. `!canRun`, `canRun`) that names a file-level gate
   * binding we've already analysed, return that name. Used to skip
   * downstream-propagation reports.
   */
  function downstreamGateBindingName(arg: ts.Expression): string | null {
    const stripped = stripCoercion(arg);
    if (ts.isIdentifier(stripped) && analysedGateBindings.has(stripped.text)) {
      return stripped.text;
    }
    return null;
  }

  function visit(node: ts.Node): void {
    // `const canRun = ...` / `shouldSkip` / `hasRequiredSetup` bindings.
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      GATE_BINDING_NAMES.has(node.name.text) &&
      node.initializer &&
      // A gate binding stores the *result* of a check, not the check
      // function itself. Skip when the initializer is an arrow or
      // function expression: that's a helper definition, and the real
      // gate is the CallExpression that invokes it (which may itself
      // be assigned to another `canRun`-style binding and analysed).
      !ts.isArrowFunction(node.initializer) &&
      !ts.isFunctionExpression(node.initializer)
    ) {
      analysedGateBindings.add(node.name.text);
      reportGate(node.initializer, node.name.text, node.name);
    }

    // `describe.skipIf(...)` / `it.skipIf(...)` / `test.skipIf(...)`.
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      ts.isIdentifier(node.expression.name)
    ) {
      const obj = node.expression.expression.text;
      const prop = node.expression.name.text;
      const matches = GATE_CALLEE_PATTERNS.some((p) => p.object === obj && p.property === prop);
      if (matches && node.arguments.length >= 1) {
        const arg = node.arguments[0];
        if (downstreamGateBindingName(arg) !== null) {
          // The argument is just `!canRun` (or similar) — the binding-site
          // report already covers this; skip to avoid double-reporting.
        } else {
          reportGate(arg, `${obj}.${prop}`, node.expression);
        }
      }
    }

    ts.forEachChild(node, visit);
  }
  visit(sf);

  // Second pass — file-wide scan for raw legacy-namespace model reads
  // (260507 fullPath investigation). Gate-only scoping is insufficient:
  // the failure-mode read sat inside the test body, not in `canRun`.
  const legacyResults = scanRawLegacyModelReads(sf, source, relPath, legacyFieldSet, gateRanges);
  violations.push(...legacyResults.violations);
  suppressions.push(...legacyResults.suppressions);

  return { violations, suppressions };
}

/** Pure entry-point — exported for unit tests. */
export function runProviderGateCheck(rootDir: string): GateCheckResult {
  const helpers = loadAuthShapeHelpers(rootDir);
  const legacyFields = loadModelSettingsFieldKeys();
  const files = listIntegrationTestFiles(rootDir);
  const violations: GateViolation[] = [];
  const suppressions: GateSuppression[] = [];
  let vanishedDuringScan = 0;

  for (const abs of files) {
    // ENOENT-tolerant read (scripts/lib/safeScanRead.ts): a file deleted
    // between listing and read (concurrent deletion / TOCTOU) returns null and
    // is skipped + counted; a present-but-unreadable file rethrows (fail-closed).
    const source = readFileToleratingVanished(abs);
    if (source === null) {
      vanishedDuringScan += 1;
      continue;
    }
    const rel = path.relative(rootDir, abs);
    const fileResult = checkSourceText(source, rel, helpers, legacyFields);
    violations.push(...fileResult.violations);
    suppressions.push(...fileResult.suppressions);
  }

  return { violations, suppressions, filesScanned: files.length, vanishedDuringScan };
}

function main(): void {
  console.log('🪝 Integration-test provider-gate + legacy-model-read check (260419 A3b + 260507)');
  console.log('================================================================================\n');

  const result = runProviderGateCheck(ROOT);

  console.log(`Scanned ${result.filesScanned} *.integration.test.ts file(s).`);
  if (result.vanishedDuringScan > 0) {
    console.log(
      `ℹ️  ${result.vanishedDuringScan} file(s) vanished mid-scan (concurrent deletion); skipped.`,
    );
  }

  for (const s of result.suppressions) {
    // Suppressions are logged to stderr (per plan grammar R4) so reviewers
    // see the bypass even when the script exits 0.
    console.warn(`⚠️  [SKIP-GATE-INTENT] ${s.file}:${s.line} (${s.gateLabel}) — ${s.justification}`);
  }

  if (result.violations.length === 0) {
    console.log('PASS — no auth-shape-as-provider-gate misuse or raw legacy-model reads detected.');
    process.exit(0);
  }

  console.error('');
  console.error(`FAIL — ${result.violations.length} integration-test gate/read violation(s):`);
  for (const v of result.violations) {
    console.error(`  ${v.file}:${v.line}:${v.column} (${v.gateLabel})`);
    console.error(`    ${v.reason}`);
  }
  console.error('');
  console.error(
    `See: docs-private/postmortems/260419_prepush_live_api_integration_test_404_postmortem.md`,
  );
  console.error(
    `     docs-private/investigations/260507_fullpath_integration_proxy_dialect_routing_failure.md`,
  );
  process.exit(1);
}

const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main();
}
