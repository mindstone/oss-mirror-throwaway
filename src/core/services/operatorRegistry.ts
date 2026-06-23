import path from 'node:path';
import type {
  OperatorDefinition,
  OperatorListOptions,
  OperatorParseFailure,
  OperatorScanResult,
} from '@shared/types/operators';
import { createOperatorId } from '@shared/types/operators';
import { scanOperators } from './operatorScanner';

export type OperatorScannerFn = (
  spacePaths: string[],
  forceCloudRoots?: ReadonlySet<string>,
) => Promise<OperatorScanResult>;

export interface OperatorRegistryDiagnostics {
  operators: OperatorDefinition[];
  failures: OperatorParseFailure[];
}

export interface OperatorRegistry {
  listAvailable(spacePaths: string[], options?: OperatorListOptions): Promise<OperatorDefinition[]>;
  listAvailableWithDiagnostics(
    spacePaths: string[],
    options?: OperatorListOptions,
  ): Promise<OperatorRegistryDiagnostics>;
  getById(operatorId: string): OperatorDefinition | undefined;
  invalidate(): void;
}

export function createOperatorRegistry(scanner: OperatorScannerFn = scanOperators): OperatorRegistry {
  let cacheKey: string | null = null;
  let cachedOperators: OperatorDefinition[] = [];
  let cachedFailures: OperatorParseFailure[] = [];
  let operatorsById = new Map<string, OperatorDefinition>();
  let operatorsBySpaceAndSlug = new Map<string, OperatorDefinition>();
  let invalidationEpoch = 0;

  function normalizeSpacePaths(spacePaths: string[]): string[] {
    return [...new Set(spacePaths.filter((spacePath) => spacePath.trim()).map((spacePath) => path.resolve(spacePath)))]
      .sort((left, right) => left.localeCompare(right));
  }

  function rebuildIndexes(operators: OperatorDefinition[]): void {
    operatorsById = new Map();
    operatorsBySpaceAndSlug = new Map();
    for (const operator of operators) {
      operatorsById.set(operator.id, operator);
      operatorsBySpaceAndSlug.set(createOperatorId(operator.spacePath, operator.operatorSlug), operator);
    }
  }

  async function scanAndCache(
    spacePaths: string[],
    forceCloudRoots?: ReadonlySet<string>,
  ): Promise<OperatorScanResult> {
    const normalized = normalizeSpacePaths(spacePaths);
    // The cache key MUST fold in the forced-cloud roots, not just the space paths. Since
    // Stage-1/F1, a forced-cloud root changes the per-file read OUTCOME (a dead-mount
    // OPERATOR.md → a `reconnecting` scan FAILURE under force vs an `ok`/hang under the
    // bare-fs local lane without it). `cachedFailures` is part of the cached result and is
    // returned to `listAvailableWithDiagnostics` callers, so reusing a cached scan across
    // different force sets could serve a stale outcome (e.g. a `reconnecting` failure to a
    // no-force caller, or vice versa). Fold the sorted forced roots into the key so a
    // different force set re-scans. (Empty/undefined → no force component, unchanged key.)
    const forceComponent = forceCloudRoots && forceCloudRoots.size > 0
      ? `force:${[...forceCloudRoots].sort((a, b) => a.localeCompare(b)).join('\0')}`
      : '';
    const nextCacheKey = `${normalized.join('\0')}${forceComponent}`;
    if (cacheKey === nextCacheKey) {
      return { operators: cachedOperators, failures: cachedFailures };
    }

    const scanEpoch = invalidationEpoch;
    const result = await scanner(normalized, forceCloudRoots);
    if (scanEpoch === invalidationEpoch) {
      cachedOperators = result.operators;
      cachedFailures = result.failures;
      cacheKey = nextCacheKey;
      rebuildIndexes(cachedOperators);
    }
    return result;
  }

  function filterOperators(operators: OperatorDefinition[], options?: OperatorListOptions): OperatorDefinition[] {
    const roleFilter = options?.roleFilter;
    if (!roleFilter) {
      return operators;
    }
    return operators.filter((operator) => operator.roles.includes(roleFilter));
  }

  return {
    async listAvailable(spacePaths: string[], options?: OperatorListOptions): Promise<OperatorDefinition[]> {
      const result = await scanAndCache(spacePaths, options?.forceCloudRoots);
      return filterOperators(result.operators, options);
    },

    async listAvailableWithDiagnostics(
      spacePaths: string[],
      options?: OperatorListOptions,
    ): Promise<OperatorRegistryDiagnostics> {
      const result = await scanAndCache(spacePaths, options?.forceCloudRoots);
      return { operators: filterOperators(result.operators, options), failures: result.failures };
    },

    getById(operatorId: string): OperatorDefinition | undefined {
      return operatorsById.get(operatorId) ?? operatorsBySpaceAndSlug.get(operatorId);
    },

    invalidate(): void {
      invalidationEpoch += 1;
      cacheKey = null;
      cachedOperators = [];
      cachedFailures = [];
      rebuildIndexes([]);
    },
  };
}

const defaultRegistry = createOperatorRegistry();

export function listAvailable(
  spacePaths: string[],
  options?: OperatorListOptions,
): Promise<OperatorDefinition[]> {
  return defaultRegistry.listAvailable(spacePaths, options);
}

export function listAvailableWithDiagnostics(
  spacePaths: string[],
  options?: OperatorListOptions,
): Promise<OperatorRegistryDiagnostics> {
  return defaultRegistry.listAvailableWithDiagnostics(spacePaths, options);
}

export function getById(operatorId: string): OperatorDefinition | undefined {
  return defaultRegistry.getById(operatorId);
}

export function invalidateOperatorRegistry(): void {
  defaultRegistry.invalidate();
}
