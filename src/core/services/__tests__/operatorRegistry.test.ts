import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createOperatorRegistry } from '../operatorRegistry';
import type { OperatorDefinition, OperatorScanResult } from '@shared/types/operators';
import { createOperatorId } from '@shared/types/operators';

function makeOperator(
  spacePath: string,
  operatorSlug: string,
  roles: OperatorDefinition['roles'] = ['operator'],
): OperatorDefinition {
  const operatorDirAbsolutePath = path.join(spacePath, 'operators', operatorSlug);
  const resolvedSpacePath = path.resolve(spacePath);
  return {
    id: createOperatorId(resolvedSpacePath, operatorSlug),
    operatorSlug,
    spacePath: resolvedSpacePath,
    sourceSpacePath: resolvedSpacePath,
    category: path.basename(resolvedSpacePath) === 'rebel-system' ? 'bundled' : 'space',
    operatorDirAbsolutePath,
    operatorFileAbsolutePath: path.join(operatorDirAbsolutePath, 'OPERATOR.md'),
    groundingPath: path.join(operatorDirAbsolutePath, 'grounding.md'),
    diaryPath: path.join(operatorDirAbsolutePath, 'diary.md'),
    frontmatter: {
      name: operatorSlug,
      description: 'Useful perspective',
      consult_when: 'When this perspective matters',
      kind: 'operator',
      roles,
    },
    name: operatorSlug,
    description: 'Useful perspective',
    consult_when: 'When this perspective matters',
    kind: 'operator',
    roles,
    body: 'Body',
  };
}

describe('operatorRegistry', () => {
  it('memoizes scans for the same space set and indexes by id', async () => {
    const spacePath = '/tmp/acme';
    const operator = makeOperator(spacePath, 'skeptical-engineer');
    const scanner = vi.fn(async (_spacePaths: string[]): Promise<OperatorScanResult> => ({
      operators: [operator],
      failures: [],
    }));
    const registry = createOperatorRegistry(scanner);

    await expect(registry.listAvailable([spacePath])).resolves.toEqual([operator]);
    await expect(registry.listAvailable([spacePath])).resolves.toEqual([operator]);

    expect(scanner).toHaveBeenCalledTimes(1);
    expect(registry.getById(operator.id)).toBe(operator);
  });

  it('invalidates cached operators on workspace changes', async () => {
    const first = makeOperator('/tmp/acme', 'brand-critic');
    const second = makeOperator('/tmp/acme', 'customer-voice');
    const scanner = vi.fn<(_spacePaths: string[]) => Promise<OperatorScanResult>>()
      .mockResolvedValueOnce({ operators: [first], failures: [] })
      .mockResolvedValueOnce({ operators: [second], failures: [] });
    const registry = createOperatorRegistry(scanner);

    await expect(registry.listAvailable(['/tmp/acme'])).resolves.toEqual([first]);
    registry.invalidate();
    expect(registry.getById(first.id)).toBeUndefined();
    await expect(registry.listAvailable(['/tmp/acme'])).resolves.toEqual([second]);

    expect(scanner).toHaveBeenCalledTimes(2);
    expect(registry.getById(second.id)).toBe(second);
  });

  it('does not let an in-flight scan repopulate the cache after invalidate', async () => {
    const stale = makeOperator('/tmp/acme', 'stale-operator');
    const fresh = makeOperator('/tmp/acme', 'fresh-operator');
    let resolveFirstScan: ((result: OperatorScanResult) => void) | undefined;
    const scanner = vi.fn<(_spacePaths: string[]) => Promise<OperatorScanResult>>()
      .mockImplementationOnce(() => new Promise<OperatorScanResult>((resolve) => {
        resolveFirstScan = resolve;
      }))
      .mockResolvedValueOnce({ operators: [fresh], failures: [] });
    const registry = createOperatorRegistry(scanner);

    const inFlight = registry.listAvailable(['/tmp/acme']);
    registry.invalidate();
    resolveFirstScan?.({ operators: [stale], failures: [] });

    await expect(inFlight).resolves.toEqual([stale]);
    expect(registry.getById(stale.id)).toBeUndefined();
    await expect(registry.listAvailable(['/tmp/acme'])).resolves.toEqual([fresh]);
    expect(registry.getById(fresh.id)).toBe(fresh);
  });

  it('filters operators by role when roleFilter is provided', async () => {
    const operatorRole = makeOperator('/tmp/acme', 'brand-critic', ['operator']);
    const liveMeetingRole = makeOperator('/tmp/acme', 'sales-coach', ['live_meeting']);
    const mixedRole = makeOperator('/tmp/acme', 'chief-of-staff-coach', ['operator', 'live_meeting']);
    const scanner = vi.fn(async (_spacePaths: string[]): Promise<OperatorScanResult> => ({
      operators: [operatorRole, liveMeetingRole, mixedRole],
      failures: [],
    }));
    const registry = createOperatorRegistry(scanner);

    await expect(registry.listAvailable(['/tmp/acme'])).resolves.toEqual([
      operatorRole,
      liveMeetingRole,
      mixedRole,
    ]);
    await expect(registry.listAvailable(['/tmp/acme'], { roleFilter: 'operator' })).resolves.toEqual([
      operatorRole,
      mixedRole,
    ]);
    await expect(registry.listAvailable(['/tmp/acme'], { roleFilter: 'live_meeting' })).resolves.toEqual([
      liveMeetingRole,
      mixedRole,
    ]);
  });
});
