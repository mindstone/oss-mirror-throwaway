// Fixture (b) — auth-helper-only gate: the literal 260419 misuse.
// Expected: FAIL.

import { describe } from 'vitest';
import { getAuthForDirectUse } from '@core/utils/authEnvUtils';
import type { AppSettings } from '@shared/types';

declare const settings: AppSettings;

const canRun = !!getAuthForDirectUse(settings);

describe.skipIf(!canRun)('live API', () => {
  // ...
});
