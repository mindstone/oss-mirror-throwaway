// Fixture (l) — gate calls a local helper whose body composes
// auth-shape only (no provider-shape).
// Expected: FAIL — the helper-recursion pass surfaces the auth-only
// composition through the function call boundary, so the gate is
// reported as if the auth-shape was inlined into `canRun`.

import { describe } from 'vitest';
import { getApiKeyForDirectUse } from '@core/utils/authEnvUtils';
import type { AppSettings } from '@shared/types';

declare const settings: AppSettings;

function hasRequiredSetup(s: AppSettings): boolean {
  return !!getApiKeyForDirectUse(s);
}

const canRun = hasRequiredSetup(settings);

describe.skipIf(!canRun)('local-helper auth-only gate', () => {
  // ...
});
