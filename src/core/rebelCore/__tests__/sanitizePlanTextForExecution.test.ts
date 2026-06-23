import { describe, expect, it } from 'vitest';
import { derivePlanParallelGroups, sanitizePlanTextForExecution, type PlanningStep } from '../planningMode';

describe('sanitizePlanTextForExecution', () => {
  it('keeps plan JSON unchanged when all parallel_group values are valid', () => {
    const steps = [
      { id: 's1', description: 'Collect source A', parallel_group: 'g1', depends_on: [] },
      { id: 's2', description: 'Collect source B', parallel_group: 'g1', depends_on: [] },
      { id: 's3', description: 'Synthesize findings', parallel_group: null, depends_on: ['g1'] },
    ];
    const planText = JSON.stringify({ goal: 'Research topic', steps }, null, 2);
    const validParallelGroupIds = new Set(derivePlanParallelGroups(steps as unknown as PlanningStep[]).keys());

    expect(sanitizePlanTextForExecution(planText, validParallelGroupIds)).toBe(planText);
  });

  it('sets singleton parallel_group values to null', () => {
    const steps = [
      { id: 's1', description: 'Solo step', parallel_group: 'g_solo', depends_on: [] },
      { id: 's2', description: 'Follow-up', parallel_group: null, depends_on: ['s1'] },
    ];
    const planText = JSON.stringify({ goal: 'Test singleton filtering', steps }, null, 2);
    const validParallelGroupIds = new Set(derivePlanParallelGroups(steps as unknown as PlanningStep[]).keys());

    const sanitized = sanitizePlanTextForExecution(planText, validParallelGroupIds);
    const parsed = JSON.parse(sanitized) as { steps: Array<{ parallel_group: string | null }> };

    expect(parsed.steps[0]?.parallel_group).toBeNull();
    expect(parsed.steps[1]?.parallel_group).toBeNull();
  });

  it('sets malformed sibling-dependency parallel_group values to null', () => {
    const steps = [
      { id: 's1', description: 'Malformed member A', parallel_group: 'g_bad', depends_on: ['s2'] },
      { id: 's2', description: 'Malformed member B', parallel_group: 'g_bad', depends_on: [] },
      { id: 's3', description: 'Sequential follow-up', parallel_group: null, depends_on: ['g_bad'] },
    ];
    const planText = JSON.stringify({ goal: 'Test malformed group filtering', steps }, null, 2);
    const validParallelGroupIds = new Set(derivePlanParallelGroups(steps as unknown as PlanningStep[]).keys());

    const sanitized = sanitizePlanTextForExecution(planText, validParallelGroupIds);
    const parsed = JSON.parse(sanitized) as { steps: Array<{ parallel_group: string | null }> };

    expect(parsed.steps[0]?.parallel_group).toBeNull();
    expect(parsed.steps[1]?.parallel_group).toBeNull();
    expect(parsed.steps[2]?.parallel_group).toBeNull();
  });

  it('returns malformed JSON input unchanged', () => {
    const malformedPlanText = '{"goal":"broken", "steps": [';
    const validParallelGroupIds = new Set<string>(['g1']);

    expect(sanitizePlanTextForExecution(malformedPlanText, validParallelGroupIds)).toBe(malformedPlanText);
  });
});
