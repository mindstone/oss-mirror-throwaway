import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createOperatorRegistry } from '../operatorRegistry';
import type { OperatorDefinition, OperatorScanResult } from '@shared/types/operators';
import { createOperatorId } from '@shared/types/operators';

function makeOperator(args: {
  spacePath: string;
  operatorSlug: string;
  description?: string;
}): OperatorDefinition {
  const operatorDirAbsolutePath = path.join(args.spacePath, 'operators', args.operatorSlug);
  return {
    id: createOperatorId(path.resolve(args.spacePath), args.operatorSlug),
    operatorSlug: args.operatorSlug,
    spacePath: path.resolve(args.spacePath),
    sourceSpacePath: path.resolve(args.spacePath),
    category: 'space',
    operatorDirAbsolutePath,
    operatorFileAbsolutePath: path.join(operatorDirAbsolutePath, 'OPERATOR.md'),
    groundingPath: path.join(operatorDirAbsolutePath, 'grounding.md'),
    diaryPath: path.join(operatorDirAbsolutePath, 'diary.md'),
    frontmatter: {
      name: args.operatorSlug,
      description: args.description ?? 'Initial copy',
      consult_when: 'When relevant',
      kind: 'operator',
      roles: ['operator'],
    },
    name: args.operatorSlug,
    description: args.description ?? 'Initial copy',
    consult_when: 'When relevant',
    kind: 'operator',
    roles: ['operator'],
    body: 'Body',
  };
}

describe('operator registry invalidation after agent write', () => {
  it('reflects the rewritten persona on the next list() once the registry is invalidated', async () => {
    const spacePath = '/tmp/acme';
    const before = makeOperator({ spacePath, operatorSlug: 'brand-critic', description: 'Initial copy' });
    const after = makeOperator({ spacePath, operatorSlug: 'brand-critic', description: 'Personalised copy' });
    const scanner = vi.fn<(spacePaths: string[]) => Promise<OperatorScanResult>>()
      .mockResolvedValueOnce({ operators: [before], failures: [] })
      .mockResolvedValueOnce({ operators: [after], failures: [] });
    const registry = createOperatorRegistry(scanner);

    const initial = await registry.listAvailable([spacePath]);
    expect(initial[0]?.description).toBe('Initial copy');

    // Simulate the agent finishing a Personalise turn — agentTurnExecute's
    // `onFileChanged` hook fires `invalidateOperatorRegistry()` whenever
    // `path.basename(filePath) === 'OPERATOR.md'`.
    registry.invalidate();

    const refreshed = await registry.listAvailable([spacePath]);
    expect(refreshed[0]?.description).toBe('Personalised copy');
    expect(scanner).toHaveBeenCalledTimes(2);
  });

  it('only invalidates for OPERATOR.md basenames, not other files in the operators tree', () => {
    const operator = makeOperator({ spacePath: '/tmp/acme', operatorSlug: 'brand-critic' });
    const scanner = vi.fn(async (_spacePaths: string[]): Promise<OperatorScanResult> => ({
      operators: [operator],
      failures: [],
    }));
    const registry = createOperatorRegistry(scanner);

    const matchesOperatorMd = (filePath: string) => path.basename(filePath) === 'OPERATOR.md';
    expect(matchesOperatorMd('/space/operators/brand-critic/OPERATOR.md')).toBe(true);
    expect(matchesOperatorMd('/space/operators/brand-critic/diary.md')).toBe(false);
    expect(matchesOperatorMd('/space/operators/brand-critic/notes/OPERATOR.md.bak')).toBe(false);
    expect(matchesOperatorMd('/space/Chief-of-Staff/README.md')).toBe(false);

    void registry.listAvailable(['/tmp/acme']);
  });
});
