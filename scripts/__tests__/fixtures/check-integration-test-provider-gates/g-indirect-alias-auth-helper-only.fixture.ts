// Fixture (g) — indirect auth-shape alias used as gate.
// Expected: FAIL. Binding the helper result before canRun must not hide it.

import { describe } from 'vitest';
import { getApiKeyForDirectUse } from '@core/utils/authEnvUtils';
import type { AppSettings } from '@shared/types';

declare const settings: AppSettings;

const HAS_KEY = !!getApiKeyForDirectUse(settings);
const canRun = HAS_KEY;

describe.skipIf(!canRun)('live API', () => {
  // ...
});
