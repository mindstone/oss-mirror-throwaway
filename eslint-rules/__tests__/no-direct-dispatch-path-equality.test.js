import { RuleTester } from 'eslint';
import tsparser from '@typescript-eslint/parser';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { DISPATCH_PATHS } from '../../src/core/rebelCore/providerRouteDecision.ts';

const require = createRequire(import.meta.url);
const rule = require('../no-direct-dispatch-path-equality.js');
const { DISPATCH_PATH_LITERALS, KIND_LITERALS } = rule;

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsparser,
    ecmaVersion: 'latest',
    sourceType: 'module',
  },
});

ruleTester.run('no-direct-dispatch-path-equality', rule, {
  valid: [
    {
      name: 'allows dispatchPath equality in test files',
      filename: 'src/core/rebelCore/__tests__/providerRouteDecision.test.ts',
      code: "const matches = decision.dispatchPath === 'local-proxy-route-table';",
    },
    {
      name: 'allows kind equality in test files',
      filename: 'src/core/rebelCore/__tests__/providerRouteDecision.test.ts',
      code: "const matches = decision.kind === 'terminal';",
    },
    {
      name: 'allows inline mock decisions in test files',
      filename: 'src/core/rebelCore/__tests__/providerRouting.invariants.test.ts',
      code: `
        const mockDecision = {
          dispatchPath: 'local-proxy-route-table',
        };
      `,
    },
    {
      name: 'allows wrapper functions that call dispatch helper predicates',
      filename: 'src/core/rebelCore/randomProductionFile.ts',
      code: `
        import { isRouteTableDispatch } from './providerRouteDecision';

        function usesHelper(decision) {
          return isRouteTableDispatch(decision.dispatchPath);
        }
      `,
    },
    {
      name: 'allows dispatchPath equality in providerRouteDecision helper definitions',
      filename: 'src/core/rebelCore/providerRouteDecision.ts',
      code: `
        function isRouteTableDispatch(decision) {
          return decision.dispatchPath === 'local-proxy-route-table';
        }
      `,
    },
    {
      name: 'allows kind helper comparisons in providerRouteDecision helper definitions',
      filename: 'src/core/rebelCore/providerRouteDecision.ts',
      code: `
        function isTerminalDecision(decision) {
          return decision.kind === 'terminal';
        }
      `,
    },
    {
      name: 'allows dispatchPath switches in providerRouteDecision helper definitions',
      filename: 'src/core/rebelCore/providerRouteDecision.ts',
      code: `
        function isRouteTableDispatch(decision) {
          switch (decision.dispatchPath) {
            case 'local-proxy-route-table':
              return true;
            case 'direct-provider':
            case 'local-proxy-passthrough':
            case 'none':
              return false;
            default:
              return assertNever(decision.dispatchPath, 'DispatchPath');
          }
        }
      `,
    },
    {
      name: 'allows exhaustive assertNever switch on nested plan decision dispatchPath',
      filename: 'src/core/rebelCore/agentTool.ts',
      code: `
        function proxyConfigFromPlan(plan) {
          const dp = plan.decision.dispatchPath;
          switch (plan.decision.dispatchPath) {
            case 'direct-provider':
              return undefined;
            case 'local-proxy-route-table':
              return routeTableProxyConfig;
            case 'local-proxy-passthrough':
              return passthroughProxyConfig;
            case 'none':
              return undefined;
            default:
              return assertNever(dp, 'DispatchPath');
          }
        }
      `,
    },
    {
      name: 'allows exhaustive assertNever switch on decision dispatchPath',
      filename: 'src/core/rebelCore/randomProductionFile.ts',
      code: `
        function dispatch(decision) {
          switch (decision.dispatchPath) {
            case 'direct-provider':
              return direct();
            case 'local-proxy-route-table':
              return routeTable();
            case 'local-proxy-passthrough':
              return passthrough();
            case 'none':
              return terminal();
            default: {
              return assertNever(decision.dispatchPath, 'DispatchPath');
            }
          }
        }
      `,
    },
    {
      name: 'allows terminal narrowing branch in production code',
      filename: 'src/core/rebelCore/randomProductionFile.ts',
      code: `
        function run(decision) {
          if (decision.kind === 'terminal') return;
          execute(decision);
        }
      `,
    },
    {
      name: 'allows exhaustive assertNever switch on decision kind',
      filename: 'src/core/rebelCore/randomProductionFile.ts',
      code: `
        function run(decision) {
          switch (decision.kind) {
            case 'dispatchable':
              return dispatch(decision);
            case 'terminal':
              return terminal(decision);
            default:
              return assertNever(decision.kind, 'ProviderRouteDecision.kind');
          }
        }
      `,
    },
    {
      name: 'allows exhaustive assertNever switch on destructured dispatchPath',
      filename: 'src/core/rebelCore/randomProductionFile.ts',
      code: `
        function dispatch(decision) {
          const { dispatchPath } = decision;
          switch (dispatchPath) {
            case 'direct-provider':
              return direct();
            case 'local-proxy-route-table':
              return routeTable();
            case 'local-proxy-passthrough':
              return passthrough();
            case 'none':
              return terminal();
            default:
              return assertNever(dispatchPath, 'DispatchPath');
          }
        }
      `,
    },
    {
      name: 'allows direct assignment in makeDecision return path',
      filename: 'src/core/rebelCore/providerRouting.ts',
      code: `
        function makeDecision() {
          return {
            dispatchPath: 'direct-provider',
          };
        }
      `,
    },
    {
      name: 'allows direct assignment in noCredentialsDecision return path',
      filename: 'src/core/rebelCore/providerRouting.ts',
      code: `
        function noCredentialsDecision() {
          return {
            dispatchPath: 'none',
          };
        }
      `,
    },
    {
      name: 'allows direct kind assignment in makeDecision return path',
      filename: 'src/core/rebelCore/providerRouting.ts',
      code: `
        function makeDecision() {
          return {
            kind: 'dispatchable',
          };
        }
      `,
    },
    {
      name: 'allows kind reference inside isTerminalRoutePlan helper',
      filename: 'src/core/rebelCore/providerRoutePlanTypes.ts',
      code: `
        function isTerminalRoutePlan(plan) {
          return plan.decision.kind === 'terminal';
        }
      `,
    },

    {
      name: 'allows transport and routeScope predicate inside deriveDispatchPath',
      filename: 'src/core/rebelCore/providerRouteDecision.ts',
      code: `
        function deriveDispatchPath(transport, routeScope) {
          return transport === 'anthropic-compatible-local-proxy' && routeScope === 'council'
            ? 'local-proxy-route-table'
            : 'direct-provider';
        }
      `,
    },
  ],
  invalid: [
    {
      name: 'flags decision.dispatchPath equality in production code',
      filename: 'src/core/rebelCore/randomProductionFile.ts',
      code: "const matches = decision.dispatchPath === 'local-proxy-route-table';",
      errors: [{ messageId: 'directDispatchPathComparison' }],
    },
    {
      name: 'flags plan.decision.dispatchPath equality in production code',
      filename: 'src/main/services/randomProductionFile.ts',
      code: "const matches = plan.decision.dispatchPath === 'local-proxy-route-table';",
      errors: [{ messageId: 'directDispatchPathComparison' }],
    },
    {
      name: 'flags reverse dispatchPath equality in production code',
      filename: 'src/core/rebelCore/randomProductionFile.ts',
      code: "const matches = 'local-proxy-route-table' === decision.dispatchPath;",
      errors: [{ messageId: 'directDispatchPathComparison' }],
    },
    {
      name: 'flags dispatchPath strict not-equal in production code',
      filename: 'src/core/rebelCore/randomProductionFile.ts',
      code: "const matches = decision.dispatchPath !== 'direct-provider';",
      errors: [{ messageId: 'directDispatchPathComparison' }],
    },
    {
      name: 'flags dispatchPath template literal equality in production code',
      filename: 'src/core/rebelCore/randomProductionFile.ts',
      code: 'const matches = decision.dispatchPath === `local-proxy-route-table`;',
      errors: [{ messageId: 'directDispatchPathComparison' }],
    },
    {
      name: 'flags switch on decision.dispatchPath in production code',
      filename: 'src/core/rebelCore/randomProductionFile.ts',
      code: `
        switch (decision.dispatchPath) {
          case 'local-proxy-route-table':
            break;
          case 'direct-provider':
            break;
          default:
            break;
        }
      `,
      errors: [
        { messageId: 'directDispatchPathComparison' },
        { messageId: 'directDispatchPathComparison' },
      ],
    },
    {
      name: 'flags switch on nested plan decision dispatchPath in production code',
      filename: 'src/core/rebelCore/randomProductionFile.ts',
      code: `
        switch (plan.decision.dispatchPath) {
          case 'direct-provider':
            break;
          default:
            break;
        }
      `,
      errors: [{ messageId: 'directDispatchPathComparison' }],
    },
    {
      name: 'flags non-assertNever switch even when all dispatchPath cases are present',
      filename: 'src/core/rebelCore/randomProductionFile.ts',
      code: `
        switch (decision.dispatchPath) {
          case 'direct-provider':
            break;
          case 'local-proxy-route-table':
            break;
          case 'local-proxy-passthrough':
            break;
          case 'none':
            break;
          default:
            break;
        }
      `,
      errors: [
        { messageId: 'directDispatchPathComparison' },
        { messageId: 'directDispatchPathComparison' },
        { messageId: 'directDispatchPathComparison' },
        { messageId: 'directDispatchPathComparison' },
      ],
    },
    {
      name: 'flags throw-only default switch without assertNever',
      filename: 'src/core/rebelCore/randomProductionFile.ts',
      code: `
        switch (decision.dispatchPath) {
          case 'direct-provider':
            return direct();
          case 'local-proxy-route-table':
            return routeTable();
          case 'local-proxy-passthrough':
            return passthrough();
          case 'none':
            return terminal();
          default:
            throw new Error('Unhandled dispatch path');
        }
      `,
      errors: [
        { messageId: 'directDispatchPathComparison' },
        { messageId: 'directDispatchPathComparison' },
        { messageId: 'directDispatchPathComparison' },
        { messageId: 'directDispatchPathComparison' },
      ],
    },
    {
      name: 'flags standalone dispatchPath if equality outside a switch',
      filename: 'src/core/rebelCore/randomProductionFile.ts',
      code: `
        if (decision.dispatchPath === 'local-proxy-route-table') {
          routeTable();
        }
      `,
      errors: [{ messageId: 'directDispatchPathComparison' }],
    },
    {
      name: 'flags destructured dispatchPath equality in production code',
      filename: 'src/core/rebelCore/randomProductionFile.ts',
      code: `
        const { dispatchPath } = decision;
        if (dispatchPath === 'local-proxy-route-table') {
          doSomething();
        }
      `,
      errors: [{ messageId: 'directDispatchPathComparison' }],
    },
    {
      name: 'flags aliased dispatchPath equality in production code',
      filename: 'src/core/rebelCore/randomProductionFile.ts',
      code: `
        const dp = decision.dispatchPath;
        if (dp === 'local-proxy-route-table') {
          doSomething();
        }
      `,
      errors: [{ messageId: 'directDispatchPathComparison' }],
    },
    {
      name: 'flags direct dispatchPath literal assignment in production code',
      filename: 'src/core/rebelCore/randomProductionFile.ts',
      code: `
        const decision = {
          dispatchPath: 'direct-provider',
        };
      `,
      errors: [{ messageId: 'directDispatchPathAssignment' }],
    },
    {
      name: 'flags direct kind equality in production code',
      filename: 'src/core/rebelCore/randomProductionFile.ts',
      code: "const isTerminal = decision.kind === 'terminal';",
      errors: [{ messageId: 'directKindComparison' }],
    },
    {
      name: 'flags dispatchable kind equality in production code',
      filename: 'src/core/rebelCore/randomProductionFile.ts',
      code: "const isDispatchable = decision.kind === 'dispatchable';",
      errors: [{ messageId: 'directKindComparison' }],
    },
    {
      name: 'flags kind literal assignment in non-allowlisted file',
      filename: 'src/core/rebelCore/randomProductionFile.ts',
      code: `
        const decision = {
          kind: 'dispatchable',
        };
      `,
      errors: [{ messageId: 'directKindAssignment' }],
    },
    {
      name: 'flags transport routeScope dispatch predicate in production code',
      filename: 'src/core/rebelCore/randomProductionFile.ts',
      code: `
        const needsRouteTable =
          decision.transport === 'anthropic-compatible-local-proxy'
          && (decision.routeScope === 'council' || decision.routeScope === 'ad-hoc');
      `,
      errors: [{ messageId: 'transportRouteScopePredicate' }],
    },
  ],
});

describe('no-direct-dispatch-path-equality drift guard', () => {
  it('keeps the rule literal set aligned with providerRouteDecision DISPATCH_PATHS', () => {
    expect(DISPATCH_PATH_LITERALS).toEqual([...DISPATCH_PATHS]);
  });

  it('keeps the rule kind set aligned with routing decision discriminators', () => {
    expect(KIND_LITERALS).toEqual(['dispatchable', 'terminal']);
  });
});
