#!/usr/bin/env npx tsx
/**
 * CI guard: sub-agent dispatch must stream the dispatch plan's route-table-safe body
 * model into runAgentLoop (and therefore client.stream), not the raw resolved model.
 *
 * Why: postmortem 260608_subagent_route_table_body_model_divergence — on proxy paths,
 * passing the resolved foreign slug (e.g. `openai/gpt-5.5`) as the Anthropic-dialect
 * body model trips `resolveAnthropicWireModel` with a confusing `invalid_request`.
 * The concrete backend belongs in `x-routed-model`; the body model must be the plan's
 * `wireModelId` (e.g. `working`), gated to route-table scope. Runtime tests pin this in
 * subAgentProxyRouting.test.ts; check-direct-anthropic-route-chokepoint does NOT cover
 * this agentTool seam.
 *
 * Conservative file-scoped heuristic on src/core/rebelCore/agentTool.ts, mirroring the
 * sibling check-*-chokepoint guards.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as ts from 'typescript';

const REPO_ROOT = process.cwd();
const AGENT_TOOL = path.join('src', 'core', 'rebelCore', 'agentTool.ts');

export type AgentToolBodyModelSourceViolation = {
  readonly kind:
    | 'missing_target_file'
    | 'unrecognized_seam'
    | 'missing_required_shape'
    | 'bypass_pattern';
  readonly message: string;
};

const REQUIRED_SHAPES: ReadonlyArray<{ name: string; re: RegExp; why: string }> = [
  {
    name: 'private-dispatch-descriptor-brand',
    re: /\bdeclare\s+const\s+subAgentDispatchDescriptorBrand\s*:\s*unique\s+symbol\s*;/,
    why: 'client/bodyModel must be paired by an unforgeable descriptor brand, not by convention',
  },
  {
    name: 'dispatch-descriptor-type',
    re: /\bexport\s+type\s+SubAgentDispatchDescriptor\b[\s\S]{0,800}?\bclient:\s*SubAgentDispatchClient<[\s\S]{0,400}?\bbodyModel:\s*SubAgentDispatchBodyModel<[\s\S]{0,400}?\btransport:\s*TPlan\['decision'\]\['transport'\]/,
    why: 'the sub-agent dispatch seam must carry client, bodyModel, and transport in one plan-branded descriptor',
  },
  {
    name: 'materialize-plan-before-descriptor',
    re: /\bconst\s+dispatchablePlan\s*=\s*plan\s*;/,
    why: 'descriptor construction must follow materializePlanRuntime so wireModelId comes from the dispatch plan',
  },
  {
    name: 'descriptor-from-dispatchable-plan',
    re: /\bsubAgentDispatch\s*=\s*createSubAgentDispatchDescriptor\s*\(\s*\{[\s\S]{0,800}?\bplan:\s*dispatchablePlan\b[\s\S]{0,800}?\bresolvedModel:\s*model\b/,
    why: 'the run-loop descriptor must be minted from dispatchablePlan with the resolved model as the non-route-table body-model source',
  },
];

const BYPASS_PATTERNS: ReadonlyArray<{ name: string; re: RegExp; why: string }> = [
  {
    name: 'run-agent-loop-raw-resolved-model',
    re: /await\s+runAgentLoop\s*\(\s*\{[\s\S]{0,1600}?\bmodel:\s*model\b/,
    why:
      'runAgentLoop must receive model from the subAgentDispatch descriptor, not the raw resolved model variable — that regresses REBEL-5N8 proxy dispatch',
  },
  {
    name: 'run-agent-loop-route-model',
    re: /await\s+runAgentLoop\s*\(\s*\{[\s\S]{0,1600}?\bmodel:\s*routeModel\b/,
    why: 'runAgentLoop must receive model from the subAgentDispatch descriptor, not routeModel',
  },
  {
    name: 'run-agent-loop-wire-model-direct',
    re:
      /await\s+runAgentLoop\s*\(\s*\{[\s\S]{0,1600}?\bmodel:\s*dispatchablePlan\.decision\.wireModelId\b/,
    why:
      'runAgentLoop model must flow through the subAgentDispatch descriptor (decoded), not inline wireModelId',
  },
  {
    name: 'run-agent-loop-loose-body-model',
    re: /await\s+runAgentLoop\s*\(\s*\{[\s\S]{0,1600}?\bmodel:\s*bodyModel\b/,
    why:
      'runAgentLoop must receive model: subAgentDispatch.bodyModel, not a loose bodyModel variable',
  },
  {
    name: 'run-agent-loop-loose-client',
    re: /await\s+runAgentLoop\s*\(\s*\{[\s\S]{0,1600}?\bclient:\s*subClient\b/,
    why:
      'runAgentLoop must receive client: subAgentDispatch.client, not a loose subClient variable',
  },
  {
    name: 'unsafe-forge-body-model',
    re:
      /\bbodyModel\s*=\s*(?:unsafeAssertRoutingModelId|brandRouteWireModel)\s*\(\s*[\s\S]{0,240}?(?:dispatchablePlan|plan)\.decision\.wireModelId/,
    why:
      'bodyModel must use decodeSubagentRoutingModelOrThrow on wireModelId, not an unsafe forge helper',
  },
];

/**
 * AST-based gate-scoping check (replaces two fragile regex windows — see
 * reviewer finding F4 in docs/plans/260610_weekly-recs-drain): every
 * `bodyModel = decodeSubagentRoutingModelOrThrow(plan.decision.wireModelId, ...)`
 * swap must sit INSIDE the then-branch of
 * `if (isRouteTableScope(plan.decision.routeScope))`, and at least one such
 * gated swap must exist. Brace scoping comes from the TypeScript parser, so
 * neither doc-comment growth inside the gate (false-fire) nor hoisting the swap
 * just past the gate's closing brace (false-pass) can fool it. Mirrors the
 * ts-API approach in check-conflict-matcher-consumer-guard.ts.
 */
const ROUTE_TABLE_GATE_SHAPE = {
  name: 'route-table-plan-body-model-assignment',
  why:
    'on route-table scope, bodyModel must be derived from plan.decision.wireModelId via decodeSubagentRoutingModelOrThrow inside the isRouteTableScope(plan.decision.routeScope) gate',
} as const;

const UNCONDITIONAL_SWAP_BYPASS = {
  name: 'unconditional-wire-model-swap',
  why:
    'wireModelId must not be swapped into bodyModel outside the isRouteTableScope(plan.decision.routeScope) gate — LEGACY_OR_MODEL_REMAP cross-model bumps would misbill on passthrough paths',
} as const;

function propertyAccessPath(node: ts.Node): string | null {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) {
    const base = propertyAccessPath(node.expression);
    return base ? `${base}.${node.name.text}` : null;
  }
  return null;
}

function isWireModelIdAccess(node: ts.Node): boolean {
  const pathText = propertyAccessPath(node);
  return pathText === 'plan.decision.wireModelId' || pathText === 'dispatchablePlan.decision.wireModelId';
}

function containsWireModelIdAccess(node: ts.Node): boolean {
  if (isWireModelIdAccess(node)) return true;
  return ts.forEachChild(node, (child) => containsWireModelIdAccess(child) || undefined) ?? false;
}

function isDecodeWireModelCall(node: ts.Node): boolean {
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'decodeSubagentRoutingModelOrThrow' &&
    node.arguments.some((arg) => containsWireModelIdAccess(arg))
  );
}

function isRouteTableGateCondition(expression: ts.Expression): boolean {
  let condition = expression;
  while (ts.isParenthesizedExpression(condition)) condition = condition.expression;
  const routeScopeArg = ts.isCallExpression(condition) ? condition.arguments[0] : undefined;
  return (
    ts.isCallExpression(condition) &&
    ts.isIdentifier(condition.expression) &&
    condition.expression.text === 'isRouteTableScope' &&
    condition.arguments.length === 1 &&
    routeScopeArg !== undefined &&
    (propertyAccessPath(routeScopeArg) === 'plan.decision.routeScope' || propertyAccessPath(routeScopeArg) === 'routeScope')
  );
}

/** True iff `node` sits inside the THEN branch of the route-table body-model gate. */
function isInsideRouteTableGate(node: ts.Node): boolean {
  let current: ts.Node = node;
  let parent: ts.Node | undefined = node.parent;
  while (parent) {
    if (
      ts.isIfStatement(parent) &&
      parent.thenStatement === current &&
      isRouteTableGateCondition(parent.expression)
    ) {
      return true;
    }
    current = parent;
    parent = parent.parent;
  }
  return false;
}

function checkWireModelSwapGateScoping(
  source: string,
  displayPath: string,
): AgentToolBodyModelSourceViolation[] {
  const sourceFile = ts.createSourceFile(
    'agentTool.ts',
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );

  let gatedSwapCount = 0;
  let ungatedSwapCount = 0;

  function visit(node: ts.Node): void {
    const isAssignmentSwap =
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left) &&
      node.left.text === 'bodyModel' &&
      isDecodeWireModelCall(node.right);
    // `let/const bodyModel = decode(...wireModelId...)` is an unconditional
    // swap by construction (declarations can't be re-run inside the gate).
    const isDeclarationSwap =
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'bodyModel' &&
      node.initializer !== undefined &&
      isDecodeWireModelCall(node.initializer);

    if (isAssignmentSwap && isInsideRouteTableGate(node)) {
      gatedSwapCount += 1;
    } else if (isAssignmentSwap || isDeclarationSwap) {
      ungatedSwapCount += 1;
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);

  const violations: AgentToolBodyModelSourceViolation[] = [];
  if (ungatedSwapCount > 0) {
    violations.push({
      kind: 'bypass_pattern',
      message:
        `${displayPath} reintroduces body-model bypass "${UNCONDITIONAL_SWAP_BYPASS.name}" ` +
        `(${ungatedSwapCount} bodyModel = decodeSubagentRoutingModelOrThrow(...plan.decision.wireModelId...) ` +
        `swap(s) outside the if (isRouteTableScope(plan.decision.routeScope)) then-branch): ${UNCONDITIONAL_SWAP_BYPASS.why}.`,
    });
  }
  if (gatedSwapCount === 0) {
    violations.push({
      kind: 'missing_required_shape',
      message: `${displayPath} missing required shape "${ROUTE_TABLE_GATE_SHAPE.name}": ${ROUTE_TABLE_GATE_SHAPE.why}.`,
    });
  }
  return violations;
}

const RUN_AGENT_LOOP_CALL_RE = /\bawait\s+runAgentLoop\s*\(/g;

/** The ONE sanctioned descriptor variable consumed at the dispatch seam. */
const DESCRIPTOR_VARIABLE = 'subAgentDispatch';
/** The ONE sanctioned descriptor mint helper. */
const MINT_FUNCTION = 'createSubAgentDispatchDescriptor';

function propertyNameText(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return null;
}

function findPropertyAssignment(
  objectLiteral: ts.ObjectLiteralExpression,
  propertyName: string,
): ts.PropertyAssignment | null {
  for (const property of objectLiteral.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    if (propertyNameText(property.name) === propertyName) return property;
  }
  return null;
}

function runAgentLoopDescriptorViolations(
  source: string,
  displayPath: string,
): AgentToolBodyModelSourceViolation[] {
  const sourceFile = ts.createSourceFile(
    'agentTool.ts',
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );
  const violations: AgentToolBodyModelSourceViolation[] = [];
  let inspectedCallCount = 0;

  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'runAgentLoop'
    ) {
      inspectedCallCount += 1;
      const config = node.arguments[0];
      if (!config || !ts.isObjectLiteralExpression(config)) {
        violations.push({
          kind: 'unrecognized_seam',
          message:
            `${displayPath} await runAgentLoop() first argument is no longer a recognizable object literal — update this guard for the new callsite shape.`,
        });
        return;
      }

      const clientProperty = findPropertyAssignment(config, 'client');
      const modelProperty = findPropertyAssignment(config, 'model');
      if (!clientProperty || !modelProperty) {
        violations.push({
          kind: 'unrecognized_seam',
          message:
            `${displayPath} await runAgentLoop() config must expose both client and model properties from the subAgentDispatch descriptor.`,
        });
        return;
      }

      const clientPath = propertyAccessPath(clientProperty.initializer);
      const modelPath = propertyAccessPath(modelProperty.initializer);
      const clientOwner = clientPath?.endsWith('.client') ? clientPath.slice(0, -'.client'.length) : null;
      const modelOwner = modelPath?.endsWith('.bodyModel') ? modelPath.slice(0, -'.bodyModel'.length) : null;

      // Reviewer F2 (260611 stage-4 review): same-owner EQUALITY is not enough —
      // a second descriptor minted with divergent sourcing and consumed under a
      // different name pairs internally and would pass an equality-only check.
      // The consumed owner must be exactly the sanctioned `subAgentDispatch`.
      if (clientOwner !== DESCRIPTOR_VARIABLE || modelOwner !== DESCRIPTOR_VARIABLE) {
        violations.push({
          kind: 'unrecognized_seam',
          message:
            `${displayPath} await runAgentLoop() must consume client/bodyModel from the same descriptor — exactly ${DESCRIPTOR_VARIABLE}.client / ${DESCRIPTOR_VARIABLE}.bodyModel (an owner-renamed or second descriptor is not equivalent); saw client: ${clientPath ?? '<unrecognized>'}, model: ${modelPath ?? '<unrecognized>'}.`,
        });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);

  if (inspectedCallCount === 0) {
    violations.push({
      kind: 'unrecognized_seam',
      message:
        `${displayPath} has no AST-recognizable runAgentLoop() call — update this guard if sub-agent dispatch moved.`,
    });
  }

  return violations;
}

/**
 * Reviewer F2 + F3 (260611 stage-4 review): the descriptor is only as strong as
 * its single mint. The type brand cannot stop a SECOND createSubAgentDispatchDescriptor
 * call minted with divergent sourcing (`resolvedModel` is an UNBRANDED parameter, so
 * `resolvedModel: routeModel` compiles), and an equality-only owner check at the
 * consumption seam accepts any internally-consistent descriptor name. Pin all three:
 *
 *   1. exactly one mint call site (a second mint is the verified F2 reintroduction
 *      vector: mint with wrong sourcing, consume under a new name);
 *   2. every mint sources `resolvedModel: model` — the resolved sub-agent model is
 *      the only sanctioned non-route-table body-model source;
 *   3. nested dispatch (childAgentCtx) hands down `subAgentDispatch.client`, so a
 *      child turn cannot inherit a client divergent from the plan that minted the
 *      body model (F3: previously convention-only, no guard or test pinned it).
 *
 * childAgentCtx is checked only when present (test snippets may omit it); deleting
 * its `client:` property entirely is a tsc error (AgentToolContext.client is
 * required), so absence of the property cannot silently reintroduce the class.
 */
function descriptorMintViolations(
  source: string,
  displayPath: string,
): AgentToolBodyModelSourceViolation[] {
  const sourceFile = ts.createSourceFile(
    'agentTool.ts',
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );
  const violations: AgentToolBodyModelSourceViolation[] = [];
  let mintCallCount = 0;

  function checkChildAgentCtxClient(root: ts.Node): void {
    // Walk every object literal under the childAgentCtx initializer (the real
    // declaration is a conditional `childCanSpawn ? {…} : null`, so the literal
    // is not the direct initializer). Any `client:` property found must be the
    // descriptor client. No nested literal in the current shape carries its own
    // `client` key; if one legitimately appears later, this fails loud and the
    // guard gets evolved deliberately.
    function visitObjectLiterals(node: ts.Node): void {
      if (ts.isObjectLiteralExpression(node)) {
        const clientProperty = findPropertyAssignment(node, 'client');
        if (clientProperty) {
          const clientPath = propertyAccessPath(clientProperty.initializer);
          if (clientPath !== `${DESCRIPTOR_VARIABLE}.client`) {
            violations.push({
              kind: 'bypass_pattern',
              message:
                `${displayPath} reintroduces body-model bypass "child-ctx-descriptor-client" ` +
                `(childAgentCtx client: ${clientPath ?? '<unrecognized>'}): nested dispatch must hand down ` +
                `${DESCRIPTOR_VARIABLE}.client so a child turn cannot inherit a client divergent from the plan ` +
                `that minted the body model.`,
            });
          }
        }
      }
      ts.forEachChild(node, visitObjectLiterals);
    }
    visitObjectLiterals(root);
  }

  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === MINT_FUNCTION
    ) {
      mintCallCount += 1;
      const config = node.arguments[0];
      if (!config || !ts.isObjectLiteralExpression(config)) {
        violations.push({
          kind: 'unrecognized_seam',
          message:
            `${displayPath} ${MINT_FUNCTION}() first argument is no longer a recognizable object literal — update this guard for the new mint shape.`,
        });
      } else {
        const resolvedModelProperty = findPropertyAssignment(config, 'resolvedModel');
        const resolvedModelPath = resolvedModelProperty
          ? propertyAccessPath(resolvedModelProperty.initializer)
          : null;
        if (resolvedModelPath !== 'model') {
          violations.push({
            kind: 'bypass_pattern',
            message:
              `${displayPath} reintroduces body-model bypass "mint-resolved-model-source" ` +
              `(${MINT_FUNCTION}() called with resolvedModel: ${resolvedModelPath ?? '<unrecognized>'}): every mint must ` +
              `source resolvedModel from the resolved sub-agent \`model\` — any other sourcing (e.g. routeModel) silently ` +
              `changes the streamed body model on non-route-table paths.`,
          });
        }
      }
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'childAgentCtx' &&
      node.initializer !== undefined
    ) {
      checkChildAgentCtxClient(node.initializer);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);

  if (mintCallCount > 1) {
    violations.push({
      kind: 'bypass_pattern',
      message:
        `${displayPath} reintroduces body-model bypass "single-descriptor-mint" ` +
        `(${mintCallCount} ${MINT_FUNCTION}() call sites; expected exactly 1): a second mint can re-pair client/bodyModel ` +
        `from divergent sourcing while satisfying the brand types and the same-owner consumption check.`,
    });
  }

  return violations;
}

function toPosix(relativePath: string): string {
  return relativePath.split(path.sep).join('/');
}

function fail(message: string): never {
  console.error(`\n✗ check-agent-tool-body-model-source: ${message}\n`);
  process.exit(1);
}

export function checkAgentToolBodyModelSource(source: string): AgentToolBodyModelSourceViolation[] {
  const violations: AgentToolBodyModelSourceViolation[] = [];
  const displayPath = toPosix(AGENT_TOOL);

  const runAgentLoopCalls = source.match(RUN_AGENT_LOOP_CALL_RE) ?? [];
  if (runAgentLoopCalls.length === 0) {
    violations.push({
      kind: 'unrecognized_seam',
      message:
        `${displayPath} has no await runAgentLoop() call — update this guard if sub-agent dispatch moved.`,
    });
    return violations;
  }

  if (runAgentLoopCalls.length !== 1) {
    violations.push({
      kind: 'unrecognized_seam',
      message:
        `${displayPath} has ${runAgentLoopCalls.length} await runAgentLoop() call-site(s); expected exactly 1. Update this guard if multiple sub-agent loops are intentional.`,
    });
  }

  violations.push(...runAgentLoopDescriptorViolations(source, displayPath));
  violations.push(...descriptorMintViolations(source, displayPath));

  for (const { name, re, why } of REQUIRED_SHAPES) {
    if (!re.test(source)) {
      violations.push({
        kind: 'missing_required_shape',
        message: `${displayPath} missing required shape "${name}": ${why}.`,
      });
    }
  }

  for (const { name, re, why } of BYPASS_PATTERNS) {
    if (re.test(source)) {
      violations.push({
        kind: 'bypass_pattern',
        message: `${displayPath} reintroduces body-model bypass "${name}" (/${re.source}/): ${why}.`,
      });
    }
  }

  violations.push(...checkWireModelSwapGateScoping(source, displayPath));

  return violations;
}

export function main(): void {
  const abs = path.join(REPO_ROOT, AGENT_TOOL);
  if (!fs.existsSync(abs)) {
    fail(`target file not found at ${toPosix(AGENT_TOOL)} — update this guard if agentTool.ts moved.`);
  }

  const source = fs.readFileSync(abs, 'utf8');
  const violations = checkAgentToolBodyModelSource(source);

  if (violations.length > 0) {
    fail(
      `${violations.length} agentTool body-model source violation(s):\n` +
      violations.map((violation) => `- ${violation.message}`).join('\n') +
      `\n\nSub-agent dispatch must stream the bodyModel paired with its route-plan client descriptor into runAgentLoop, not a separately sourced model.`,
    );
  }

  console.log(
    '✓ check-agent-tool-body-model-source: runAgentLoop consumes client/bodyModel from one descriptor; route-table path sources wireModelId from the dispatch plan.',
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
