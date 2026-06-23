// Fixture (j) — raw legacy-namespace model read inside the test body.
// Expected: FAIL — this is the 260507 fullPath.integration shape: gate
// uses provider-shape correctly, but the test body still pipes the
// stale legacy `claude.model` field into the resolution path.

import { describe, it } from 'vitest';
import {
  getApiKeyForDirectUse,
  isDirectAnthropicConfig,
} from '@core/utils/authEnvUtils';
import type { AppSettings } from '@shared/types';

declare const settings: AppSettings;

const canRun = isDirectAnthropicConfig(settings) && !!getApiKeyForDirectUse(settings);

describe.skipIf(!canRun)('legacy-namespace model leak', () => {
  it('reads from settings.claude.model directly', () => {
    const workingModel = settings.claude.model;
    void workingModel;
  });
});
