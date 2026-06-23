import path from 'node:path';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';

const inFlightByKey = new Map<string, Promise<unknown>>();

function makeKey(spacePath: string, operatorFileRelativePath: string): string {
  const normalizedSpace = path.resolve(spacePath);
  const normalizedFile = operatorFileRelativePath.replace(/\\/gu, '/').replace(/^\/+/u, '');
  return `${normalizedSpace}::${normalizedFile}`;
}

export async function withOperatorFileMutation<T>(
  spacePath: string,
  operatorFileRelativePath: string,
  mutator: () => Promise<T>,
): Promise<T> {
  const key = makeKey(spacePath, operatorFileRelativePath);
  const previous = inFlightByKey.get(key);
  const next = (async () => {
    if (previous) {
      try {
        await previous;
      } catch (predecessorError) {
        ignoreBestEffortCleanup(predecessorError, {
          operation: 'operator_file_mutation_predecessor_drain',
          reason: 'predecessor caller observes its own error; the next mutation must still proceed',
        });
      }
    }
    return mutator();
  })();

  inFlightByKey.set(key, next);
  try {
    return await next;
  } finally {
    if (inFlightByKey.get(key) === next) {
      inFlightByKey.delete(key);
    }
  }
}

export function _resetOperatorFileMutationLockForTests(): void {
  inFlightByKey.clear();
}
