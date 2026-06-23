// Fixture (f) — aliased import of auth-shape helper used as gate.
// Expected: FAIL. Import aliasing must not let the 260419 misuse escape.

import { describe } from 'vitest';
import { getApiKeyForDirectUse as fetchKey } from '@core/utils/authEnvUtils';
import type { AppSettings } from '@shared/types';

declare const settings: AppSettings;

const canRun = !!fetchKey(settings);

describe.skipIf(!canRun)('live API', () => {
  // ...
});
