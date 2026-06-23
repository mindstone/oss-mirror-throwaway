#!/usr/bin/env npx tsx
/**
 * Static read-only guard for the connector-smoke allowlist.
 *
 * SAFETY BY CONSTRUCTION. The connector-smoke harness
 * (`src/test-utils/connectorSmokeHarness.ts`) only ever calls tool names in each cell's
 * static `readOnlyOps` allowlist. This guard closes the remaining gap: it asserts that every
 * allowlisted op is, in the connector's own tool registration, annotated
 * `readOnlyHint: true` AND NOT `destructiveHint: true`. So the allowlist cannot silently
 * drift into a write/destructive op — if someone adds a write op to a cell, this guard FAILS
 * the build before any live run can call it.
 *
 * How it works (TS AST, no runtime import, no network):
 *  - For each cell (single source of truth: tests/connector-smoke/connectorSmokeCells.ts) and
 *    each `readOnlyOps[].name`, scan the connector's tool source dir for the registration of
 *    that tool name and read its `annotations` object — handling the two registration shapes
 *    in this repo:
 *      (a) `server.registerTool('name', { …, annotations: <objectLiteral | identifier> }, …)`
 *          (slack / microsoft / elevenlabs / vanta / replit), and
 *      (b) a tool-definition object literal `{ name: 'name', …, annotations: { … } }`
 *          (google-workspace).
 *    Identifier-referenced annotations (e.g. `annotations: readOnlyAnnotations`) are resolved
 *    to their `const` object literal in the same file.
 *  - FAIL if: the tool can't be found, has no annotations, readOnlyHint !== true, or
 *    destructiveHint === true.
 *
 * Wired into validate:fast (scripts/run-validate-fast.ts) so it's an always-on gate.
 * The accompanying test (scripts/__tests__/check-connector-smoke-readonly.test.ts) asserts
 * the guard FAILS on a synthetic write-op.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
// Import ONLY the pure, side-effect-free allowlist DATA — never connectorSmokeCells.ts, whose
// transitive imports (@private/mindstone → settingsStore → new ElectronStore()) crash outside
// Electron and would take this standalone CLI / validate:fast gate step down with it.
import { CONNECTOR_SMOKE_ALLOWLIST, REMOTE_READONLY_OPS } from '../tests/connector-smoke/connectorSmokeAllowlist';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
}

export interface OpCheckResult {
  connector: string;
  op: string;
  ok: boolean;
  reason?: string;
  annotations?: ToolAnnotations;
}

/** Recursively list every .ts file under a dir (excluding .d.ts and test files). */
function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (
      entry.endsWith('.ts') &&
      !entry.endsWith('.d.ts') &&
      !entry.endsWith('.test.ts') &&
      !entry.endsWith('.spec.ts')
    ) {
      out.push(full);
    }
  }
  return out;
}

function stringLiteralText(node: ts.Node): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return undefined;
}

/** Read a boolean property (`true`/`false` literal) from an object literal. */
function boolProp(obj: ts.ObjectLiteralExpression, name: string): boolean | undefined {
  for (const prop of obj.properties) {
    if (
      ts.isPropertyAssignment(prop) &&
      ((ts.isIdentifier(prop.name) && prop.name.text === name) ||
        (ts.isStringLiteral(prop.name) && prop.name.text === name))
    ) {
      if (prop.initializer.kind === ts.SyntaxKind.TrueKeyword) return true;
      if (prop.initializer.kind === ts.SyntaxKind.FalseKeyword) return false;
    }
  }
  return undefined;
}

/** Find a property assignment by name in an object literal. */
function getProp(obj: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  for (const prop of obj.properties) {
    if (
      ts.isPropertyAssignment(prop) &&
      ((ts.isIdentifier(prop.name) && prop.name.text === name) ||
        (ts.isStringLiteral(prop.name) && prop.name.text === name))
    ) {
      return prop.initializer;
    }
  }
  return undefined;
}

/** Map of top-level `const X = { … }` object-literal initializers in a source file. */
function collectConstObjectLiterals(sf: ts.SourceFile): Map<string, ts.ObjectLiteralExpression> {
  const map = new Map<string, ts.ObjectLiteralExpression>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (
          ts.isIdentifier(decl.name) &&
          decl.initializer &&
          ts.isObjectLiteralExpression(decl.initializer)
        ) {
          map.set(decl.name.text, decl.initializer);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return map;
}

/** Resolve an `annotations:` initializer to an object literal (inline or identifier const). */
function resolveAnnotationsObject(
  init: ts.Expression,
  consts: Map<string, ts.ObjectLiteralExpression>,
): ts.ObjectLiteralExpression | undefined {
  if (ts.isObjectLiteralExpression(init)) return init;
  if (ts.isIdentifier(init)) return consts.get(init.text);
  return undefined;
}

/**
 * Find the annotations for a tool name in a single source file. Handles:
 *  (a) server.registerTool('name', { …, annotations }, …)
 *  (b) object literal { name: 'name', …, annotations }
 */
function findToolAnnotationsInFile(
  sf: ts.SourceFile,
  toolName: string,
): ts.ObjectLiteralExpression | undefined {
  const consts = collectConstObjectLiterals(sf);
  let found: ts.ObjectLiteralExpression | undefined;

  const visit = (node: ts.Node): void => {
    if (found) return;

    // (a) server.registerTool('name', { …, annotations }, …)
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isRegisterTool =
        (ts.isPropertyAccessExpression(callee) && callee.name.text === 'registerTool') ||
        (ts.isPropertyAccessExpression(callee) &&
          (callee.name.text === 'tool' || callee.name.text === 'registerTool'));
      if (isRegisterTool && node.arguments.length >= 2) {
        const nameArg = stringLiteralText(node.arguments[0]);
        const configArg = node.arguments[1];
        if (nameArg === toolName && ts.isObjectLiteralExpression(configArg)) {
          const ann = getProp(configArg, 'annotations');
          if (ann) {
            const obj = resolveAnnotationsObject(ann, consts);
            if (obj) {
              found = obj;
              return;
            }
          }
        }
      }
    }

    // (b) object literal { name: 'name', …, annotations: { … } }
    if (ts.isObjectLiteralExpression(node)) {
      const nameProp = getProp(node, 'name');
      if (nameProp && stringLiteralText(nameProp) === toolName) {
        const ann = getProp(node, 'annotations');
        if (ann) {
          const obj = resolveAnnotationsObject(ann, consts);
          if (obj) {
            found = obj;
            return;
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sf);
  return found;
}

/** Search a connector's source dir for a tool name's annotations. */
export function findToolAnnotations(
  sourceDir: string,
  toolName: string,
): { annotations: ToolAnnotations; file: string } | undefined {
  for (const file of listTsFiles(sourceDir)) {
    const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const obj = findToolAnnotationsInFile(sf, toolName);
    if (obj) {
      return {
        file,
        annotations: {
          readOnlyHint: boolProp(obj, 'readOnlyHint'),
          destructiveHint: boolProp(obj, 'destructiveHint'),
        },
      };
    }
  }
  return undefined;
}

/** Pure per-op verdict: provably read-only and not destructive? */
export function checkOpReadOnly(
  connector: string,
  op: string,
  sourceDir: string,
): OpCheckResult {
  const absDir = resolve(REPO_ROOT, sourceDir);
  if (!existsSync(absDir)) {
    return { connector, op, ok: false, reason: `tool source dir not found: ${sourceDir}` };
  }
  const found = findToolAnnotations(absDir, op);
  if (!found) {
    return {
      connector,
      op,
      ok: false,
      reason: `could not find a tool registration with annotations for '${op}' under ${sourceDir}`,
    };
  }
  const { readOnlyHint, destructiveHint } = found.annotations;
  if (readOnlyHint !== true) {
    return {
      connector,
      op,
      ok: false,
      annotations: found.annotations,
      reason: `'${op}' is not annotated readOnlyHint:true (got ${String(readOnlyHint)}) in ${found.file}`,
    };
  }
  if (destructiveHint === true) {
    return {
      connector,
      op,
      ok: false,
      annotations: found.annotations,
      reason: `'${op}' is annotated destructiveHint:true in ${found.file}`,
    };
  }
  return { connector, op, ok: true, annotations: found.annotations };
}

/**
 * Read-only verdict for a REMOTE (http) connector op. There is no local source to AST-prove, so
 * the op MUST be in the curated `REMOTE_READONLY_OPS` set (documented read-only ops). FAILS
 * otherwise — so a non-curated / write op added to a remote allowlist is rejected at build time,
 * NOT silently skipped. (The runner additionally verifies the server-advertised readOnlyHint at
 * call time as defense-in-depth.)
 */
export function checkRemoteOpReadOnly(connector: string, op: string): OpCheckResult {
  if (!REMOTE_READONLY_OPS.includes(op)) {
    return {
      connector,
      op,
      ok: false,
      reason:
        `remote op '${op}' is not in the curated REMOTE_READONLY_OPS set (no local source to ` +
        `AST-prove). Add it to REMOTE_READONLY_OPS with a read-only citation only if it is a ` +
        `documented read (and the server advertises readOnlyHint:true).`,
    };
  }
  return { connector, op, ok: true };
}

function main(): void {
  const results: OpCheckResult[] = [];
  for (const entry of CONNECTOR_SMOKE_ALLOWLIST) {
    for (const opEntry of entry.readOnlyOps) {
      if (entry.remote) {
        results.push(checkRemoteOpReadOnly(entry.connector, opEntry.name));
      } else if (entry.toolSourceConnectorDir) {
        const sourceDir = `mcp-servers/connectors/${entry.toolSourceConnectorDir}/src`;
        results.push(checkOpReadOnly(entry.connector, opEntry.name, sourceDir));
      } else {
        results.push({
          connector: entry.connector,
          op: opEntry.name,
          ok: false,
          reason: `local connector '${entry.connector}' has no toolSourceConnectorDir`,
        });
      }
    }
  }

  const failures = results.filter((r) => !r.ok);
  for (const r of results) {
    const tag = r.ok ? 'OK  ' : 'FAIL';
    console.log(`[check-connector-smoke-readonly] ${tag} ${r.connector}.${r.op}${r.ok ? '' : ` — ${r.reason}`}`);
  }
  if (failures.length > 0) {
    console.error(
      `[check-connector-smoke-readonly] ${failures.length} allowlisted op(s) are not provably read-only. ` +
        `Every connector-smoke op MUST be annotated readOnlyHint:true and not destructiveHint:true.`,
    );
    process.exit(1);
  }
  console.log(`[check-connector-smoke-readonly] all ${results.length} allowlisted op(s) are provably read-only.`);
}

// Run only as a CLI, not when imported by the unit test.
if (process.argv[1] && process.argv[1].endsWith('check-connector-smoke-readonly.ts')) {
  main();
}
