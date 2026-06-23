// Fixture (m) — gate calls a local helper whose body composes both
// auth-shape and provider-shape.
// Expected: PASS — helper-recursion sees through the function call
// boundary into the body, observes both shapes, and accepts the gate.

import { describe } from 'vitest';
import {
  getApiKeyForDirectUse,
  isDirectAnthropicConfig,
} from '@core/utils/authEnvUtils';
import type { AppSettings } from '@shared/types';

declare const settings: AppSettings;

function hasRequiredSetup(s: AppSettings): boolean {
  return isDirectAnthropicConfig(s) && !!getApiKeyForDirectUse(s);
}

const canRun = hasRequiredSetup(settings);

describe.skipIf(!canRun)('local-helper auth + provider-shape gate', () => {
  // ...
});
