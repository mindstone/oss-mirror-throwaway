/**
 * Tests for the per-task routing metadata baseline-merge helper used by
 * rebelCoreQuery's `routing:tasks:` emit pipeline.
 *
 * The full pipeline (sync + dedup + multi-emit) is exercised end-to-end via
 * the renderer-side `parseModelByTaskId` test in
 * `src/renderer/features/agent-session/utils/__tests__/turnStepContext.test.ts`
 * (the "uses the last routing:tasks event when the backend re-emits with new
 * tasks" case). These unit tests pin the pure-helper invariant only:
 * preservation of existing entries (in particular sub-agent stamps written
 * via the agent tool's `onTaskRoutingMetadataUpdate` callback) plus
 * baseline-fill of any missing IDs.
 */
import { describe, it, expect } from 'vitest';
import { unsafeAssertRoutingModelId } from '@shared/utils/modelChoiceCodec';
import {
  createTaskRoutingMetadataWriter,
  mergeBaselineRoutingModel,
  type CompiledStepRoute,
  type TaskRoutingMetadata,
} from '../rebelCoreQuery';

const WORKING_MODEL = unsafeAssertRoutingModelId('claude-sonnet-4-20250514');
const ESCALATED_MODEL = unsafeAssertRoutingModelId('claude-opus-4-20250514');

function compiledRoute(
  taskId: string,
  model = WORKING_MODEL,
  effort: CompiledStepRoute['effort'] = undefined,
): CompiledStepRoute {
  return {
    stepId: `step-${taskId}`,
    taskId,
    model,
    effort,
    profile: undefined,
    source: 'default',
    ordinal: 1,
  };
}

describe('mergeBaselineRoutingModel', () => {
  it('fills missing entries with { model: baselineModel }', () => {
    const meta: Record<string, TaskRoutingMetadata> = {};
    mergeBaselineRoutingModel(meta, ['t1', 't2', 't3'], 'gpt-5.5');
    expect(meta).toEqual({
      t1: { model: 'gpt-5.5' },
      t2: { model: 'gpt-5.5' },
      t3: { model: 'gpt-5.5' },
    });
  });

  it('preserves existing sub-agent stamps and only fills gaps', () => {
    const meta: Record<string, TaskRoutingMetadata> = {
      't1': {
        model: 'claude-sonnet-4-6',
        isSubAgent: true,
        subAgentContext: 'contextual',
      },
    };
    mergeBaselineRoutingModel(meta, ['t1', 't2'], 'gpt-5.5');
    expect(meta.t1).toEqual({
      model: 'claude-sonnet-4-6',
      isSubAgent: true,
      subAgentContext: 'contextual',
    });
    expect(meta.t2).toEqual({ model: 'gpt-5.5' });
  });

  it('preserves existing plan-routing entries (effort, etc.)', () => {
    const meta: Record<string, TaskRoutingMetadata> = {
      't1': { model: 'gpt-5.5', effort: 'high' },
    };
    mergeBaselineRoutingModel(meta, ['t1', 't2'], 'claude-sonnet-4-6');
    expect(meta.t1).toEqual({ model: 'gpt-5.5', effort: 'high' });
    expect(meta.t2).toEqual({ model: 'claude-sonnet-4-6' });
  });

  it('is idempotent across repeated invocations with the same input', () => {
    const meta: Record<string, TaskRoutingMetadata> = {};
    mergeBaselineRoutingModel(meta, ['t1', 't2'], 'gpt-5.5');
    const snapshotJson = JSON.stringify(meta);
    mergeBaselineRoutingModel(meta, ['t1', 't2'], 'gpt-5.5');
    expect(JSON.stringify(meta)).toBe(snapshotJson);
  });

  it('no-ops on an empty taskIds list', () => {
    const meta: Record<string, TaskRoutingMetadata> = {
      't1': { model: 'gpt-5.5', isSubAgent: true, subAgentContext: 'scoped' },
    };
    const before = JSON.stringify(meta);
    mergeBaselineRoutingModel(meta, [], 'claude-sonnet-4-6');
    expect(JSON.stringify(meta)).toBe(before);
  });

  it('handles new task IDs appearing across multiple invocations (incremental sync)', () => {
    const meta: Record<string, TaskRoutingMetadata> = {};
    mergeBaselineRoutingModel(meta, ['t1'], 'gpt-5.5');
    mergeBaselineRoutingModel(meta, ['t1', 't2'], 'gpt-5.5');
    mergeBaselineRoutingModel(meta, ['t1', 't2', 't3'], 'gpt-5.5');
    expect(Object.keys(meta).sort()).toEqual(['t1', 't2', 't3']);
    expect(meta.t1).toEqual({ model: 'gpt-5.5' });
    expect(meta.t2).toEqual({ model: 'gpt-5.5' });
    expect(meta.t3).toEqual({ model: 'gpt-5.5' });
  });
});

describe('createTaskRoutingMetadataWriter', () => {
  it('writes parent-route badges from parent-route identity only', () => {
    const meta: Record<string, TaskRoutingMetadata> = {};
    const writer = createTaskRoutingMetadataWriter(meta);

    writer.setParentRouteBadge({
      taskId: 't1',
      parentRouteModel: WORKING_MODEL,
      effort: 'medium',
    });

    expect(meta).toEqual({
      t1: { model: WORKING_MODEL, effort: 'medium' },
    });
    expect(writer.current).toBe(meta);
  });

  it('fills missing parent-route badges while preserving existing sub-agent overlays', () => {
    const meta: Record<string, TaskRoutingMetadata> = {
      t1: {
        model: 'claude-haiku-4-5',
        isSubAgent: true,
        subAgentContext: 'scoped',
      },
    };
    const writer = createTaskRoutingMetadataWriter(meta);

    writer.fillMissingParentRouteBadge({
      taskId: 't1',
      parentRouteModel: WORKING_MODEL,
      effort: undefined,
    });
    writer.fillMissingParentRouteBadge({
      taskId: 't2',
      parentRouteModel: WORKING_MODEL,
      effort: undefined,
    });

    expect(meta).toEqual({
      t1: {
        model: 'claude-haiku-4-5',
        isSubAgent: true,
        subAgentContext: 'scoped',
      },
      t2: { model: WORKING_MODEL },
    });
  });

  it('applies plan projection using compiled parent routes and preserves sub-agent overlays', () => {
    const meta: Record<string, TaskRoutingMetadata> = {
      t1: { model: 'previous' },
    };
    const writer = createTaskRoutingMetadataWriter(meta);

    writer.applyPlanProjection(
      [
        compiledRoute('t1', ESCALATED_MODEL, 'high'),
        compiledRoute('t2', WORKING_MODEL, 'low'),
      ],
      {
        t1: { model: ESCALATED_MODEL, effort: 'high' },
        t2: {
          model: 'claude-haiku-4-5',
          effort: 'low',
          isSubAgent: true,
          subAgentContext: 'contextual',
        },
      },
    );

    expect(meta).toEqual({
      t1: { model: ESCALATED_MODEL, effort: 'high' },
      t2: {
        model: 'claude-haiku-4-5',
        effort: 'low',
        isSubAgent: true,
        subAgentContext: 'contextual',
      },
    });
  });

  it('corrects failed parent-route badges without touching sub-agent overlays', () => {
    const meta: Record<string, TaskRoutingMetadata> = {
      t1: { model: ESCALATED_MODEL, effort: 'high' },
      t2: { model: 'claude-haiku-4-5', isSubAgent: true },
    };
    const writer = createTaskRoutingMetadataWriter(meta);

    const corrected = writer.correctFailedParentRouteBadge({
      taskId: 't1',
      parentRouteModel: ESCALATED_MODEL,
      effort: 'high',
    }, WORKING_MODEL);

    expect(corrected).toBe(true);
    expect(meta.t1).toEqual({ model: WORKING_MODEL, effort: 'high' });
    expect(() => writer.correctFailedParentRouteBadge({
      taskId: 't2',
      parentRouteModel: WORKING_MODEL,
      effort: undefined,
    }, WORKING_MODEL)).toThrow(/refused sub-agent overlay/);
    expect(meta.t2).toEqual({ model: 'claude-haiku-4-5', isSubAgent: true });
  });

  it('restores canonical parent-route badges only when canonical matches the parent route', () => {
    const meta: Record<string, TaskRoutingMetadata> = {
      t1: { model: WORKING_MODEL },
    };
    const writer = createTaskRoutingMetadataWriter(meta);

    writer.restoreCanonicalParentRouteBadge({
      taskId: 't1',
      parentRouteModel: ESCALATED_MODEL,
      effort: 'high',
    }, { model: ESCALATED_MODEL, effort: 'high' });

    expect(meta.t1).toEqual({ model: ESCALATED_MODEL, effort: 'high' });
    expect(() => writer.restoreCanonicalParentRouteBadge({
      taskId: 't1',
      parentRouteModel: WORKING_MODEL,
      effort: undefined,
    }, { model: ESCALATED_MODEL })).toThrow(/does not match parent route/);
    expect(() => writer.restoreCanonicalParentRouteBadge({
      taskId: 't1',
      parentRouteModel: WORKING_MODEL,
      effort: undefined,
    }, { model: WORKING_MODEL, isSubAgent: true })).toThrow(/refused sub-agent overlay/);
  });

  it('BY CONSTRUCTION: parent-route badge writes require parentRouteModel', () => {
    const writer = createTaskRoutingMetadataWriter({});
    const assertPartialParentRouteIsTypeError = (): void => {
      // @ts-expect-error — parent-route identity is incomplete: model is required.
      writer.setParentRouteBadge({ taskId: 't1', effort: undefined });
    };
    expect(typeof assertPartialParentRouteIsTypeError).toBe('function');
  });

  it('BY CONSTRUCTION: sub-agent overlay writes require isSubAgent=true', () => {
    const writer = createTaskRoutingMetadataWriter({});
    const assertNonOverlayIsTypeError = (): void => {
      writer.setSubAgentOverlay(
        {
          taskId: 't1',
          parentRouteModel: WORKING_MODEL,
          effort: undefined,
        },
        // @ts-expect-error — overlay writer refuses ordinary parent-route metadata.
        { model: 'claude-haiku-4-5' },
      );
    };
    expect(typeof assertNonOverlayIsTypeError).toBe('function');
  });
});
