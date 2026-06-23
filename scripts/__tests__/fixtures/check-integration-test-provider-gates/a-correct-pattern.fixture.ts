// Fixture (a) — CORRECT pattern: auth-shape composed with provider-shape.
// Expected: PASS (no violations).
//
// Mirrors the post-260419 fix shape used in
// `src/core/rebelCore/__tests__/fullPath.integration.test.ts`.

import { describe } from 'vitest';
import {
  getApiKeyForDirectUse,
  isDirectAnthropicConfig,
} from '@core/utils/authEnvUtils';
import type { AppSettings } from '@shared/types';

declare const settings: AppSettings;

const apiKey = getApiKeyForDirectUse(settings);
const isDirectAnthropic = isDirectAnthropicConfig(settings);
const canRun = !!apiKey && isDirectAnthropic;

describe.skipIf(!canRun)('live API', () => {
  // ...
});
