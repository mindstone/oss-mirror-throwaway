/**
 * R1 Stage 3 negative lint fixture — direct cleanup-state mutation.
 *
 * Do not "fix" this file; `turnPipelineLintFixtures.test.ts` runs ESLint
 * with `--no-ignore` and asserts that every call below is rejected.
 */

import { adHocTurnIds, adHocTurnMeta, councilTurnIds, councilTurnMeta } from '../agentTurnCleanup';
import { proxyManager } from '../localModelProxyServer';

export function negativeCleanupBypassFixture(turnId: string): void {
  councilTurnIds.delete(turnId);
  adHocTurnIds.delete(turnId);
  councilTurnMeta.delete(turnId);
  adHocTurnMeta.delete(turnId);
  proxyManager.removeRoutes(turnId);
}
