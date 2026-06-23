// Fixture (g-fixed) — indirect aliases composed with provider-shape.
// Expected: PASS.

import { describe } from 'vitest';
import {
  getApiKeyForDirectUse,
  isDirectAnthropicConfig,
} from '@core/utils/authEnvUtils';
import type { AppSettings } from '@shared/types';

declare const settings: AppSettings;

const HAS_KEY = !!getApiKeyForDirectUse(settings);
const IS_DIRECT_ANTHROPIC = isDirectAnthropicConfig(settings);
const canRun = HAS_KEY && IS_DIRECT_ANTHROPIC;

describe.skipIf(!canRun)('live API', () => {
  // ...
});
