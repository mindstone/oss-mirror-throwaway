import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { checkAgentToolBodyModelSource } from '../check-agent-tool-body-model-source';
import { STEPS } from '../run-validate-fast';
import { GUARD_NAMES as SOURCE_POLICY_GUARDS } from '../groups/source-policy-chokepoints';

const AGENT_TOOL = path.join('src', 'core', 'rebelCore', 'agentTool.ts');

function canonicalSeamSnippet(): string {
  return `
    declare const subAgentDispatchDescriptorBrand: unique symbol;
    type SubAgentDispatchPlanBinding<TPlan extends DispatchableRoutePlan> = {
      readonly [subAgentDispatchDescriptorBrand]: TPlan;
    };
    export type SubAgentDispatchClient<TPlan extends DispatchableRoutePlan = DispatchableRoutePlan> =
      ModelClient & SubAgentDispatchPlanBinding<TPlan>;
    export type SubAgentDispatchBodyModel<TPlan extends DispatchableRoutePlan = DispatchableRoutePlan> =
      RoutingModelId & SubAgentDispatchPlanBinding<TPlan>;
    export type SubAgentDispatchDescriptor<TPlan extends DispatchableRoutePlan = DispatchableRoutePlan> = {
      readonly client: SubAgentDispatchClient<TPlan>;
      readonly bodyModel: SubAgentDispatchBodyModel<TPlan>;
      readonly transport: TPlan['decision']['transport'];
    };
    function resolveSubAgentDispatchBodyModel<TPlan extends DispatchableRoutePlan>(
      plan: TPlan,
      resolvedModel: RoutingModelId,
    ): SubAgentDispatchBodyModel<TPlan> {
      let bodyModel: RoutingModelId = resolvedModel;
      if (isRouteTableScope(plan.decision.routeScope)) {
        bodyModel = decodeSubagentRoutingModelOrThrow(
          plan.decision.wireModelId,
          'route-table sub-agent body model',
        );
      }
      return bodyModel as SubAgentDispatchBodyModel<TPlan>;
    }
    function createSubAgentDispatchDescriptor<TPlan extends DispatchableRoutePlan>(params: {
      readonly plan: TPlan;
      readonly settings: AppSettings;
      readonly resolvedModel: RoutingModelId;
    }): SubAgentDispatchDescriptor<TPlan> {
      const bodyModel = resolveSubAgentDispatchBodyModel(params.plan, params.resolvedModel);
      const client = createClientFromRoutePlan(params.plan, params.settings, {});
      return {
        client: client as SubAgentDispatchClient<TPlan>,
        bodyModel,
        transport: params.plan.decision.transport,
      };
    }
    const plan = await materializePlanRuntime(baseDecision, runtimeContext);
    const dispatchablePlan = plan;
    subAgentDispatch = createSubAgentDispatchDescriptor({
      plan: dispatchablePlan,
      settings: ctx.settings,
      resolvedModel: model,
    });
    await runAgentLoop(
      {
        client: subAgentDispatch.client,
        model: subAgentDispatch.bodyModel,
        systemPrompt,
      },
      toolExecutor,
    );
    const childAgentCtx = { agents: ctx.agents, client: subAgentDispatch.client };
  `;
  // NOTE: childAgentCtx sits AFTER the runAgentLoop call in this synthetic
  // snippet (the AST checks are order-independent) so that the existing
  // first-occurrence .replace() mutations keep targeting the runAgentLoop
  // config, not the child context.
}

describe('check-agent-tool-body-model-source', () => {
  it('passes the canonical plan-sourced bodyModel seam', () => {
    const violations = checkAgentToolBodyModelSource(canonicalSeamSnippet());
    expect(violations).toEqual([]);
  });

  it('fails when runAgentLoop streams the raw resolved model (REBEL-5N8 regression)', () => {
    const source = canonicalSeamSnippet().replace('model: subAgentDispatch.bodyModel', 'model: model');
    const violations = checkAgentToolBodyModelSource(source);

    expect(violations.map((violation) => violation.kind)).toContain('bypass_pattern');
    expect(violations.map((violation) => violation.message).join('\n')).toContain(
      'run-agent-loop-raw-resolved-model',
    );
  });

  it('fails when runAgentLoop receives client/bodyModel from different descriptor owners', () => {
    const source = canonicalSeamSnippet().replace(
      'model: subAgentDispatch.bodyModel',
      'model: otherDispatch.bodyModel',
    );
    const violations = checkAgentToolBodyModelSource(source);

    expect(violations.map((violation) => violation.kind)).toContain('unrecognized_seam');
    expect(violations.map((violation) => violation.message).join('\n')).toContain(
      'same descriptor',
    );
  });

  it('fails when runAgentLoop uses a loose client variable instead of the descriptor client', () => {
    const source = canonicalSeamSnippet().replace('client: subAgentDispatch.client', 'client: subClient');
    const violations = checkAgentToolBodyModelSource(source);

    expect(violations.map((violation) => violation.kind)).toContain('bypass_pattern');
    expect(violations.map((violation) => violation.message).join('\n')).toContain(
      'run-agent-loop-loose-client',
    );
  });

  it('fails when a second descriptor is minted with divergent resolvedModel sourcing and consumed (reviewer F2 probe)', () => {
    // The exact altDispatch probe shape from the 260611 stage-4 review: a second
    // mint sourced from routeModel, consumed under its own (internally
    // consistent) owner. Compiles (resolvedModel is unbranded) and passed the
    // pre-refinement guard.
    const source = canonicalSeamSnippet()
      .replace(
        'await runAgentLoop(',
        `altDispatch = createSubAgentDispatchDescriptor({
      plan: dispatchablePlan,
      settings: ctx.settings,
      resolvedModel: routeModel,
    });
    await runAgentLoop(`,
      )
      .replace(
        'client: subAgentDispatch.client,\n        model: subAgentDispatch.bodyModel,',
        'client: altDispatch.client,\n        model: altDispatch.bodyModel,',
      );
    const violations = checkAgentToolBodyModelSource(source);
    const messages = violations.map((violation) => violation.message).join('\n');

    expect(violations.map((violation) => violation.kind)).toContain('bypass_pattern');
    expect(messages).toContain('single-descriptor-mint');
    expect(messages).toContain('mint-resolved-model-source');
    expect(messages).toContain('same descriptor');
  });

  it('fails when runAgentLoop consumes a renamed descriptor owner even with internally consistent pairing (reviewer F2)', () => {
    // Owner-rename alone (single mint, pairing internally consistent at the
    // call): same-owner equality passed this pre-refinement; the owner pin
    // must reject any owner that is not exactly subAgentDispatch.
    const source = canonicalSeamSnippet().replace(
      'client: subAgentDispatch.client,\n        model: subAgentDispatch.bodyModel,',
      'client: altDispatch.client,\n        model: altDispatch.bodyModel,',
    );
    const violations = checkAgentToolBodyModelSource(source);

    expect(violations.map((violation) => violation.kind)).toContain('unrecognized_seam');
    expect(violations.map((violation) => violation.message).join('\n')).toContain(
      'exactly subAgentDispatch.client / subAgentDispatch.bodyModel',
    );
  });

  it('fails when childAgentCtx hands a non-descriptor client to nested dispatch (reviewer F3)', () => {
    const source = canonicalSeamSnippet().replace(
      'const childAgentCtx = { agents: ctx.agents, client: subAgentDispatch.client };',
      'const childAgentCtx = { agents: ctx.agents, client: ctx.client };',
    );
    const violations = checkAgentToolBodyModelSource(source);

    expect(violations.map((violation) => violation.kind)).toContain('bypass_pattern');
    expect(violations.map((violation) => violation.message).join('\n')).toContain(
      'child-ctx-descriptor-client',
    );
  });

  it('fails when the runAgentLoop callsite shape is unrecognized', () => {
    const source = canonicalSeamSnippet().replace('await runAgentLoop', 'await runNestedLoop');
    const violations = checkAgentToolBodyModelSource(source);

    expect(violations.map((violation) => violation.kind)).toContain('unrecognized_seam');
    expect(violations.map((violation) => violation.message).join('\n')).toContain('no await runAgentLoop()');
  });

  it('fails when route-table bodyModel is not sourced from dispatchablePlan.decision.wireModelId', () => {
    const source = canonicalSeamSnippet().replace(
      'plan.decision.wireModelId',
      'routeModel',
    );
    const violations = checkAgentToolBodyModelSource(source);

    expect(violations.map((violation) => violation.kind)).toContain('missing_required_shape');
    expect(violations.map((violation) => violation.message).join('\n')).toContain(
      'route-table-plan-body-model-assignment',
    );
  });

  it('fails when wireModelId is swapped into bodyModel outside the route-table gate', () => {
    const source = `
      declare const subAgentDispatchDescriptorBrand: unique symbol;
      export type SubAgentDispatchDescriptor<TPlan extends DispatchableRoutePlan = DispatchableRoutePlan> = {
        readonly client: SubAgentDispatchClient<TPlan>;
        readonly bodyModel: SubAgentDispatchBodyModel<TPlan>;
        readonly transport: TPlan['decision']['transport'];
      };
      const dispatchablePlan = plan;
      bodyModel = decodeSubagentRoutingModelOrThrow(
        plan.decision.wireModelId,
        'route-table sub-agent body model',
      );
      subAgentDispatch = createSubAgentDispatchDescriptor({
        plan: dispatchablePlan,
        settings: ctx.settings,
        resolvedModel: model,
      });
      await runAgentLoop({ client: subAgentDispatch.client, model: subAgentDispatch.bodyModel }, toolExecutor);
    `;
    const violations = checkAgentToolBodyModelSource(source);

    expect(violations.map((violation) => violation.message).join('\n')).toContain(
      'unconditional-wire-model-swap',
    );
  });

  it('fails when the swap is hoisted just outside a still-present route-table gate (reviewer F4 probe A)', () => {
    // The realistic refactor accident: the gate survives but the wireModelId
    // swap moves past its closing brace. The old lookbehind-window regex
    // false-passed this because the gate opening sat within 2400 chars.
    const source = `
      declare const subAgentDispatchDescriptorBrand: unique symbol;
      export type SubAgentDispatchDescriptor<TPlan extends DispatchableRoutePlan = DispatchableRoutePlan> = {
        readonly client: SubAgentDispatchClient<TPlan>;
        readonly bodyModel: SubAgentDispatchBodyModel<TPlan>;
        readonly transport: TPlan['decision']['transport'];
      };
      const plan = await materializePlanRuntime(baseDecision, runtimeContext);
      const dispatchablePlan = plan;
      if (isRouteTableScope(plan.decision.routeScope)) {
        transportForBackstop = dispatchablePlan.decision.transport;
      }
      bodyModel = decodeSubagentRoutingModelOrThrow(
        plan.decision.wireModelId,
        'route-table sub-agent body model',
      );
      subAgentDispatch = createSubAgentDispatchDescriptor({
        plan: dispatchablePlan,
        settings: ctx.settings,
        resolvedModel: model,
      });
      await runAgentLoop({ client: subAgentDispatch.client, model: subAgentDispatch.bodyModel }, toolExecutor);
    `;
    const violations = checkAgentToolBodyModelSource(source);

    expect(violations.map((violation) => violation.message).join('\n')).toContain(
      'unconditional-wire-model-swap',
    );
    expect(violations.map((violation) => violation.message).join('\n')).toContain(
      'route-table-plan-body-model-assignment',
    );
  });

  it('passes a correctly gated swap even when the gate body exceeds the old 2400-char window (reviewer F4 probe B)', () => {
    // The old regex false-fired once >2400 chars separated the gate opening
    // from the assignment (the real gate carries a large doc-comment that
    // tends to grow). AST scoping must not care about gate-body length.
    const longComment = '// x\n'.repeat(600); // ~3000 chars inside the gate
    const source = canonicalSeamSnippet().replace(
      'if (isRouteTableScope(plan.decision.routeScope)) {',
      `if (isRouteTableScope(plan.decision.routeScope)) {\n${longComment}`,
    );
    expect(checkAgentToolBodyModelSource(source)).toEqual([]);
  });

  it('fails when the swap sits in the ELSE branch of the route-table gate', () => {
    const source = canonicalSeamSnippet().replace(
      /if \(isRouteTableScope\(plan\.decision\.routeScope\)\) \{\n(?<swap>[\s\S]*?)\n {6}\}/,
      'if (isRouteTableScope(routeScope)) {\n      transportForBackstop = dispatchablePlan.decision.transport;\n    } else {\n$<swap>\n    }',
    );
    const violations = checkAgentToolBodyModelSource(source);

    expect(violations.map((violation) => violation.message).join('\n')).toContain(
      'unconditional-wire-model-swap',
    );
  });

  it('is wired into validate:fast via the source-policy-chokepoints group', () => {
    expect(STEPS.map((step) => step.name)).toContain('validate:source-policy-chokepoints');
    expect(SOURCE_POLICY_GUARDS).toContain('check-agent-tool-body-model-source');
  });

  it('passes on the real agentTool.ts source in the repo', async () => {
    const fs = await import('node:fs');
    const source = fs.readFileSync(AGENT_TOOL, 'utf8');
    expect(checkAgentToolBodyModelSource(source)).toEqual([]);
  });
});
