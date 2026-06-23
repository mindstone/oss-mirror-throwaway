import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';

declare function inner(): void;
declare function outer(): void;

export function run(): unknown {
  try {
    outer();
  } catch (outerErr) {
    try {
      inner();
    } catch (innerErr) {
      ignoreBestEffortCleanup(innerErr, {
        operation: 'inner cleanup',
        reason: 'inner failure is best-effort cleanup we can ignore',
      });
    }
    return null;
  }
  return undefined;
}
