/**
 * AST-only guard for routing discriminators introduced by:
 * - docs/plans/260508_dispatch_path_discriminator_structural_refactor.md
 * - docs/plans/260508_dispatchable_terminal_type_split_and_subagent_constructor_input.md
 *
 * Scope: covers direct `dispatchPath` literals and direct `kind` discriminator
 * literals. Deliberately does NOT chase wrapper-function pass-throughs; that
 * remains a reviewer/code-walk responsibility.
 *
 * The rule intentionally uses a small heuristic for local aliases: variables
 * initialized from `.dispatchPath`, object-pattern bindings named
 * `dispatchPath`, and bare `dispatchPath` identifiers are treated as
 * dispatch-path references. That may false-positive on an unrelated local
 * named `dispatchPath`, but the tripwire is preferable to letting direct
 * routing predicates bypass the typed helper functions.
 *
 * Accepted limitations:
 * - Pass-through helper functions such as `function disp() { return plan.decision.dispatchPath; }`
 *   are false-negatives for this AST-only rule.
 * - `.includes()` array membership tests are accepted false-negatives.
 * - Those bypasses are code-smell signals, but not the routing-axis-omission
 *   failure class this rule targets.
 *
 * Structurally-safe escape hatch:
 * exhaustive switches over a dispatch-path reference are allowed when they
 * include a default branch that calls `assertNever`. This is the intended
 * protected pattern because adding another `DispatchPath` literal then breaks
 * compilation at the switch instead of silently falling into an `else`.
 *
 * Example:
 *   switch (plan.decision.dispatchPath) {
 *     case 'direct-provider':
 *       return undefined;
 *     case 'local-proxy-route-table':
 *     case 'local-proxy-passthrough':
 *       return proxyConfig;
 *     case 'none':
 *       return undefined;
 *     default:
 *       return assertNever(plan.decision.dispatchPath, 'DispatchPath');
 *   }
 */
const DISPATCH_PATH_LITERALS = [
  'direct-provider',
  'local-proxy-route-table',
  'local-proxy-passthrough',
  'none',
];

const DISPATCH_PATH_LITERAL_SET = new Set(DISPATCH_PATH_LITERALS);
const KIND_LITERALS = ['dispatchable', 'terminal'];
const KIND_LITERAL_SET = new Set(KIND_LITERALS);

const PROXY_ROUTE_TABLE_TRANSPORT = 'anthropic-compatible-local-proxy';

const PROVIDER_ROUTE_DECISION_HELPERS = new Set([
  'isProxyDispatch',
  'isRouteTableDispatch',
  'isDirectDispatch',
  'assertDispatchableRoutePlan',
  'assertRouteTableRuntimeContext',
  'deriveDispatchPath',
]);

const PROVIDER_ROUTE_DECISION_KIND_HELPERS = new Set([
  'isDispatchableDecision',
  'isTerminalDecision',
  'assertDispatchableRoutePlan',
  'validateRouteDecisionShape',
]);

const PROVIDER_ROUTING_DECISION_CONSTRUCTORS = new Set([
  'makeDecision',
  'noCredentialsDecision',
]);

const PROVIDER_ROUTING_KIND_HELPERS = new Set([
  ...PROVIDER_ROUTING_DECISION_CONSTRUCTORS,
  'coerceToRouteTable',
  'forSubagent',
]);

const DISPATCH_PATH_PLAN_PATH = 'docs/plans/260508_dispatch_path_discriminator_structural_refactor.md';
const KIND_PLAN_PATH = 'docs/plans/260508_dispatchable_terminal_type_split_and_subagent_constructor_input.md';

function normalizeFilename(filename) {
  return filename.replaceAll('\\', '/');
}

function isTestFile(filename) {
  const normalized = normalizeFilename(filename);
  return /(^|\/)__tests__(\/|$)/.test(normalized)
    || /\.(test|spec)\.[cm]?[jt]sx?$/.test(normalized);
}

function isProviderRouteDecisionFile(filename) {
  return normalizeFilename(filename).endsWith('src/core/rebelCore/providerRouteDecision.ts');
}

function isProviderRoutingFile(filename) {
  return normalizeFilename(filename).endsWith('src/core/rebelCore/providerRouting.ts');
}

function isProviderRoutePlanTypesFile(filename) {
  return normalizeFilename(filename).endsWith('src/core/rebelCore/providerRoutePlanTypes.ts');
}

function keyName(key) {
  if (!key) return null;
  if (key.type === 'Identifier') return key.name;
  if (key.type === 'Literal') return String(key.value);
  return null;
}

function propertyName(node) {
  if (!node) return null;
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'Literal') return String(node.value);
  return null;
}

function unwrapExpression(node) {
  let current = node;
  while (
    current
    && (
      current.type === 'ChainExpression'
      || current.type === 'TSNonNullExpression'
      || current.type === 'TSAsExpression'
      || current.type === 'TSTypeAssertion'
      || current.type === 'TSInstantiationExpression'
    )
  ) {
    current = current.expression;
  }
  return current;
}

function isNamedMemberExpression(node, name) {
  const expression = unwrapExpression(node);
  return Boolean(
    expression
    && expression.type === 'MemberExpression'
    && propertyName(expression.property) === name,
  );
}

function isNamedIdentifierOrMember(node, name) {
  const expression = unwrapExpression(node);
  return Boolean(
    (expression && expression.type === 'Identifier' && expression.name === name)
    || isNamedMemberExpression(expression, name),
  );
}

function isLiteralString(node, value) {
  const expression = unwrapExpression(node);
  return Boolean(expression && expression.type === 'Literal' && expression.value === value);
}

function isDispatchPathLiteral(node) {
  const expression = unwrapExpression(node);
  if (
    expression
    && expression.type === 'TemplateLiteral'
    && expression.expressions.length === 0
    && expression.quasis.length === 1
  ) {
    const cooked = expression.quasis[0]?.value?.cooked;
    return typeof cooked === 'string' && DISPATCH_PATH_LITERAL_SET.has(cooked);
  }

  return Boolean(
    expression
    && expression.type === 'Literal'
    && typeof expression.value === 'string'
    && DISPATCH_PATH_LITERAL_SET.has(expression.value),
  );
}

function literalStringValue(node) {
  const expression = unwrapExpression(node);
  if (!expression) return null;
  if (
    expression.type === 'TemplateLiteral'
    && expression.expressions.length === 0
    && expression.quasis.length === 1
  ) {
    return expression.quasis[0]?.value?.cooked ?? null;
  }
  if (expression.type === 'Literal' && typeof expression.value === 'string') {
    return expression.value;
  }
  return null;
}

function isKindLiteral(node) {
  const literal = literalStringValue(node);
  return typeof literal === 'string' && KIND_LITERAL_SET.has(literal);
}

function isDispatchPathSwitchDiscriminant(node) {
  const expression = unwrapExpression(node);
  return Boolean(
    isNamedMemberExpression(expression, 'dispatchPath')
    || (expression?.type === 'Identifier' && expression.name === 'dispatchPath'),
  );
}

function isKindSwitchDiscriminant(node) {
  const expression = unwrapExpression(node);
  return Boolean(
    isNamedMemberExpression(expression, 'kind')
    || (expression?.type === 'Identifier' && expression.name === 'kind'),
  );
}

function isAssertNeverCallee(node) {
  const expression = unwrapExpression(node);
  return Boolean(
    expression
    && expression.type === 'Identifier'
    && /^assertNever$/i.test(expression.name),
  );
}

function nodeContainsAssertNeverCall(node, visited = new Set()) {
  if (!node) return false;
  const expression = unwrapExpression(node);
  if (!expression) return false;
  if (visited.has(expression)) return false;
  visited.add(expression);

  if (expression.type === 'CallExpression' && isAssertNeverCallee(expression.callee)) {
    return true;
  }

  if (
    expression.type === 'FunctionDeclaration'
    || expression.type === 'FunctionExpression'
    || expression.type === 'ArrowFunctionExpression'
  ) {
    return false;
  }

  for (const [key, value] of Object.entries(expression)) {
    if (key === 'parent') continue;
    if (!value || typeof value !== 'object') continue;
    if (Array.isArray(value)) {
      if (value.some((child) => child && typeof child === 'object' && nodeContainsAssertNeverCall(child, visited))) {
        return true;
      }
      continue;
    }
    if (nodeContainsAssertNeverCall(value, visited)) return true;
  }

  return false;
}

function isExhaustiveLiteralSwitch(switchNode, {
  isReference,
  isLiteral,
}) {
  if (!isReference(switchNode.discriminant)) return false;

  let hasLiteralCase = false;
  let hasAssertNeverDefault = false;

  for (const switchCase of switchNode.cases) {
    if (switchCase.test == null) {
      hasAssertNeverDefault = switchCase.consequent.some((node) => nodeContainsAssertNeverCall(node));
      continue;
    }

    if (isLiteral(switchCase.test)) {
      hasLiteralCase = true;
    }
  }

  return hasLiteralCase && hasAssertNeverDefault;
}

function isExhaustiveDispatchPathSwitch(
  switchNode,
  isDispatchPathReference = isDispatchPathSwitchDiscriminant,
) {
  return isExhaustiveLiteralSwitch(switchNode, {
    isReference: isDispatchPathReference,
    isLiteral: isDispatchPathLiteral,
  });
}

function isExhaustiveKindSwitch(
  switchNode,
  isKindReference = isKindSwitchDiscriminant,
) {
  return isExhaustiveLiteralSwitch(switchNode, {
    isReference: isKindReference,
    isLiteral: isKindLiteral,
  });
}

function getFunctionName(node) {
  if (!node) return null;
  if (node.type === 'FunctionDeclaration') {
    return node.id?.name ?? null;
  }
  const parent = node.parent;
  if (!parent) return null;
  if (parent.type === 'VariableDeclarator' && parent.id.type === 'Identifier') {
    return parent.id.name;
  }
  if ((parent.type === 'Property' || parent.type === 'MethodDefinition') && parent.key) {
    return keyName(parent.key);
  }
  return null;
}

function enclosingFunction(node) {
  let current = node.parent;
  while (current) {
    if (
      current.type === 'FunctionDeclaration'
      || current.type === 'FunctionExpression'
      || current.type === 'ArrowFunctionExpression'
    ) {
      return current;
    }
    current = current.parent;
  }
  return null;
}

function enclosingFunctionName(node) {
  return getFunctionName(enclosingFunction(node));
}

function isWithinReturnPath(node) {
  let current = node.parent;
  while (current) {
    if (current.type === 'ReturnStatement') return true;
    if (
      current.type === 'FunctionDeclaration'
      || current.type === 'FunctionExpression'
      || current.type === 'ArrowFunctionExpression'
    ) {
      return false;
    }
    current = current.parent;
  }
  return false;
}

function isAllowedDispatchPathComparison(filename, node) {
  if (isTestFile(filename)) return true;
  if (!isProviderRouteDecisionFile(filename)) return false;
  return PROVIDER_ROUTE_DECISION_HELPERS.has(enclosingFunctionName(node));
}

function isAllowedDispatchPathAssignment(filename, node) {
  if (isTestFile(filename)) return true;

  const functionName = enclosingFunctionName(node);
  if (
    isProviderRoutingFile(filename)
    && PROVIDER_ROUTING_DECISION_CONSTRUCTORS.has(functionName)
    && isWithinReturnPath(node)
  ) {
    return true;
  }

  return false;
}

function isAllowedTransportRouteScopePredicate(filename, node) {
  if (isTestFile(filename)) return true;
  if (!isProviderRouteDecisionFile(filename)) return false;
  return PROVIDER_ROUTE_DECISION_HELPERS.has(enclosingFunctionName(node));
}

function isWithinIfTestExpression(node) {
  let current = node;
  while (current?.parent) {
    const parent = current.parent;
    if (parent.type === 'IfStatement') {
      return parent.test === current;
    }
    if (
      parent.type === 'LogicalExpression'
      || parent.type === 'UnaryExpression'
      || parent.type === 'ConditionalExpression'
      || parent.type === 'BinaryExpression'
    ) {
      current = parent;
      continue;
    }
    return false;
  }
  return false;
}

function isAllowedKindComparison(filename, node) {
  if (isTestFile(filename)) return true;

  const functionName = enclosingFunctionName(node);
  if (isProviderRouteDecisionFile(filename)) {
    return PROVIDER_ROUTE_DECISION_KIND_HELPERS.has(functionName);
  }
  if (isProviderRoutingFile(filename)) {
    return PROVIDER_ROUTING_KIND_HELPERS.has(functionName);
  }
  if (isProviderRoutePlanTypesFile(filename)) {
    return functionName === 'isTerminalRoutePlan';
  }
  return false;
}

function isAllowedKindAssignment(filename, node) {
  if (isTestFile(filename)) return true;
  if (isProviderRouteDecisionFile(filename)) return true;

  const functionName = enclosingFunctionName(node);
  if (
    isProviderRoutingFile(filename)
    && PROVIDER_ROUTING_DECISION_CONSTRUCTORS.has(functionName)
    && isWithinReturnPath(node)
  ) {
    return true;
  }

  return false;
}

function localNameFromPattern(pattern) {
  const expression = unwrapExpression(pattern);
  if (!expression) return null;
  if (expression.type === 'Identifier') return expression.name;
  if (expression.type === 'AssignmentPattern') return localNameFromPattern(expression.left);
  if (expression.type === 'RestElement') return localNameFromPattern(expression.argument);
  return null;
}

function dispatchPathBindingsFromObjectPattern(pattern) {
  const bindings = [];
  if (!pattern || pattern.type !== 'ObjectPattern') return bindings;

  for (const property of pattern.properties) {
    if (!property || property.type !== 'Property') continue;
    if (keyName(property.key) !== 'dispatchPath') continue;

    const localName = localNameFromPattern(property.value);
    if (localName) bindings.push(localName);
  }

  return bindings;
}

function kindBindingsFromObjectPattern(pattern) {
  const bindings = [];
  if (!pattern || pattern.type !== 'ObjectPattern') return bindings;

  for (const property of pattern.properties) {
    if (!property || property.type !== 'Property') continue;
    if (keyName(property.key) !== 'kind') continue;

    const localName = localNameFromPattern(property.value);
    if (localName) bindings.push(localName);
  }

  return bindings;
}

function hasProxyRouteTableTransportComparison(node, visited = new Set()) {
  if (!node) return false;
  const expression = unwrapExpression(node);
  if (!expression) return false;
  if (visited.has(expression)) return false;
  visited.add(expression);
  if (expression.type === 'BinaryExpression' && ['===', '!=='].includes(expression.operator)) {
    return (
      isNamedIdentifierOrMember(expression.left, 'transport')
      && isLiteralString(expression.right, PROXY_ROUTE_TABLE_TRANSPORT)
    ) || (
      isNamedIdentifierOrMember(expression.right, 'transport')
      && isLiteralString(expression.left, PROXY_ROUTE_TABLE_TRANSPORT)
    );
  }
  for (const [key, value] of Object.entries(expression)) {
    if (key === 'parent') continue;
    if (!value || typeof value !== 'object') continue;
    if (Array.isArray(value)) {
      if (value.some((child) => child && typeof child === 'object' && hasProxyRouteTableTransportComparison(child, visited))) {
        return true;
      }
      continue;
    }
    if (hasProxyRouteTableTransportComparison(value, visited)) return true;
  }
  return false;
}

function hasRouteScopeReference(node, visited = new Set()) {
  if (!node) return false;
  const expression = unwrapExpression(node);
  if (!expression) return false;
  if (visited.has(expression)) return false;
  visited.add(expression);
  if (isNamedIdentifierOrMember(expression, 'routeScope')) return true;
  for (const [key, value] of Object.entries(expression)) {
    if (key === 'parent') continue;
    if (!value || typeof value !== 'object') continue;
    if (Array.isArray(value)) {
      if (value.some((child) => child && typeof child === 'object' && hasRouteScopeReference(child, visited))) {
        return true;
      }
      continue;
    }
    if (hasRouteScopeReference(value, visited)) return true;
  }
  return false;
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Prevent direct dispatchPath/kind predicates and routeScope/transport dispatch predicates in production code.',
    },
    schema: [],
    messages: {
      directDispatchPathComparison: `Direct equality on \`dispatchPath\` is not allowed in production code; use \`isProxyDispatch()\` / \`isRouteTableDispatch()\` / \`isDirectDispatch()\` from \`providerRouteDecision.ts\` instead. See plan: \`${DISPATCH_PATH_PLAN_PATH}\`.`,
      directDispatchPathAssignment: `Direct \`dispatchPath\` literal assignment is only allowed at provider-route decision construction/override chokepoints; use \`deriveDispatchPath()\` or the internal \`coerceToRouteTable()\` instead. See plan: \`${DISPATCH_PATH_PLAN_PATH}\`.`,
      directKindComparison: `Direct equality on \`kind\` is restricted to narrowing/helper sites; use a terminal early-return narrow or helper predicates instead of ad-hoc production checks. See plan: \`${KIND_PLAN_PATH}\`.`,
      directKindAssignment: `Direct \`kind\` literal assignment is only allowed at provider-route decision constructor chokepoints. See plan: \`${KIND_PLAN_PATH}\`.`,
      transportRouteScopePredicate: `Do not combine \`transport === 'anthropic-compatible-local-proxy'\` with \`routeScope\` predicates for dispatch routing; use the \`dispatchPath\` helpers from \`providerRouteDecision.ts\` instead. See plan: \`${DISPATCH_PATH_PLAN_PATH}\`.`,
    },
  },
  create(context) {
    const filename = context.filename ?? context.getFilename?.() ?? '';
    const dispatchPathAliasScopes = [];
    const kindAliasScopes = [];

    function pushAliasScope() {
      dispatchPathAliasScopes.push(new Set());
      kindAliasScopes.push(new Set());
    }

    function popAliasScope() {
      dispatchPathAliasScopes.pop();
      kindAliasScopes.pop();
    }

    function addDispatchPathAlias(name) {
      const currentScope = dispatchPathAliasScopes.at(-1);
      if (currentScope) currentScope.add(name);
    }

    function addKindAlias(name) {
      const currentScope = kindAliasScopes.at(-1);
      if (currentScope) currentScope.add(name);
    }

    function isDispatchPathAlias(name) {
      return name === 'dispatchPath' || dispatchPathAliasScopes.some((scope) => scope.has(name));
    }

    function isKindAlias(name) {
      return name === 'kind' || kindAliasScopes.some((scope) => scope.has(name));
    }

    function isDispatchPathReference(node) {
      const expression = unwrapExpression(node);
      return Boolean(
        isNamedMemberExpression(expression, 'dispatchPath')
        || (expression?.type === 'Identifier' && isDispatchPathAlias(expression.name)),
      );
    }

    function isKindReference(node) {
      const expression = unwrapExpression(node);
      return Boolean(
        isNamedMemberExpression(expression, 'kind')
        || (expression?.type === 'Identifier' && isKindAlias(expression.name)),
      );
    }

    function comparedKindLiteral(node) {
      const leftLiteral = literalStringValue(node.left);
      const rightLiteral = literalStringValue(node.right);
      if (isKindReference(node.left) && typeof rightLiteral === 'string' && KIND_LITERAL_SET.has(rightLiteral)) {
        return rightLiteral;
      }
      if (isKindReference(node.right) && typeof leftLiteral === 'string' && KIND_LITERAL_SET.has(leftLiteral)) {
        return leftLiteral;
      }
      return null;
    }

    function isAllowedKindComparisonNode(node) {
      if (isAllowedKindComparison(filename, node)) return true;
      const literal = comparedKindLiteral(node);
      if (literal === 'terminal' && isWithinIfTestExpression(node)) return true;
      return false;
    }

    return {
      Program() {
        pushAliasScope();
      },
      'Program:exit'() {
        popAliasScope();
      },
      FunctionDeclaration() {
        pushAliasScope();
      },
      'FunctionDeclaration:exit'() {
        popAliasScope();
      },
      FunctionExpression() {
        pushAliasScope();
      },
      'FunctionExpression:exit'() {
        popAliasScope();
      },
      ArrowFunctionExpression() {
        pushAliasScope();
      },
      'ArrowFunctionExpression:exit'() {
        popAliasScope();
      },
      VariableDeclarator(node) {
        if (node.id.type === 'Identifier' && isNamedMemberExpression(node.init, 'dispatchPath')) {
          addDispatchPathAlias(node.id.name);
        }
        if (node.id.type === 'Identifier' && isNamedMemberExpression(node.init, 'kind')) {
          addKindAlias(node.id.name);
        }

        if (node.id.type !== 'ObjectPattern') return;
        for (const name of dispatchPathBindingsFromObjectPattern(node.id)) {
          addDispatchPathAlias(name);
        }
        for (const name of kindBindingsFromObjectPattern(node.id)) {
          addKindAlias(name);
        }
      },
      BinaryExpression(node) {
        if (!['===', '!=='].includes(node.operator)) return;
        const comparesDispatchPath = (
          isDispatchPathReference(node.left) && isDispatchPathLiteral(node.right)
        ) || (
          isDispatchPathReference(node.right) && isDispatchPathLiteral(node.left)
        );
        if (comparesDispatchPath) {
          if (isAllowedDispatchPathComparison(filename, node)) return;
          context.report({ node, messageId: 'directDispatchPathComparison' });
          return;
        }

        const comparesKind = (
          isKindReference(node.left) && isKindLiteral(node.right)
        ) || (
          isKindReference(node.right) && isKindLiteral(node.left)
        );
        if (!comparesKind) return;
        if (isAllowedKindComparisonNode(node)) return;

        context.report({ node, messageId: 'directKindComparison' });
      },
      SwitchStatement(node) {
        if (isDispatchPathReference(node.discriminant)) {
          if (isExhaustiveDispatchPathSwitch(node, isDispatchPathReference)) return;
          if (isAllowedDispatchPathComparison(filename, node)) return;

          for (const switchCase of node.cases) {
            if (!isDispatchPathLiteral(switchCase.test)) continue;
            context.report({ node: switchCase, messageId: 'directDispatchPathComparison' });
          }
          return;
        }

        if (!isKindReference(node.discriminant)) return;
        if (isExhaustiveKindSwitch(node, isKindReference)) return;
        if (isAllowedKindComparisonNode(node)) return;

        for (const switchCase of node.cases) {
          if (!isKindLiteral(switchCase.test)) continue;
          context.report({ node: switchCase, messageId: 'directKindComparison' });
        }
      },
      Property(node) {
        if (keyName(node.key) === 'dispatchPath') {
          if (!isDispatchPathLiteral(node.value)) return;
          if (isAllowedDispatchPathAssignment(filename, node)) return;
          context.report({ node, messageId: 'directDispatchPathAssignment' });
          return;
        }

        if (keyName(node.key) !== 'kind') return;
        if (!isKindLiteral(node.value)) return;
        if (isAllowedKindAssignment(filename, node)) return;

        context.report({ node, messageId: 'directKindAssignment' });
      },
      LogicalExpression(node) {
        if (!['&&', '||'].includes(node.operator)) return;
        if (node.parent?.type === 'LogicalExpression' && ['&&', '||'].includes(node.parent.operator)) {
          return;
        }
        if (!hasProxyRouteTableTransportComparison(node) || !hasRouteScopeReference(node)) {
          return;
        }
        if (isAllowedTransportRouteScopePredicate(filename, node)) return;

        context.report({ node, messageId: 'transportRouteScopePredicate' });
      },
    };
  },
  DISPATCH_PATH_LITERALS,
  KIND_LITERALS,
};
