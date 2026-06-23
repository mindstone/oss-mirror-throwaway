// Fixture (f-fixed) — aliased import composed with provider-shape.
// Expected: PASS. Aliases are allowed when provider-shape is still present.

import { describe } from 'vitest';
import {
  getApiKeyForDirectUse as fetchKey,
  isDirectAnthropicConfig,
} from '@core/utils/authEnvUtils';
import type { AppSettings } from '@shared/types';

declare const settings: AppSettings;

const canRun = isDirectAnthropicConfig(settings) && !!fetchKey(settings);

describe.skipIf(!canRun)('live API', () => {
  // ...
});
