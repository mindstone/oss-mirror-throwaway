import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';

declare function maybeFail(): Promise<void>;

export async function run(): Promise<void> {
  await maybeFail().catch((err) => ignoreBestEffortCleanup(err, {
    operation: 'promise-catch best-effort cleanup',
    reason: 'cleanup is optional; eventual consistency tolerable',
  }));
}
