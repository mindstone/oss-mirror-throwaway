// Fixture (k) — raw legacy-namespace model read with explicit
// SKIP-GATE-INTENT justification on the preceding line.
// Expected: PASS (logged as suppression, not a violation).

import { describe, it } from 'vitest';
import {
  getApiKeyForDirectUse,
  isDirectAnthropicConfig,
} from '@core/utils/authEnvUtils';
import type { AppSettings } from '@shared/types';

declare const settings: AppSettings;

const canRun = isDirectAnthropicConfig(settings) && !!getApiKeyForDirectUse(settings);

describe.skipIf(!canRun)('legacy-namespace model read with rationale', () => {
  it('reads from settings.claude.thinkingModel for migration-coverage assertion', () => {
    // SKIP-GATE-INTENT: this assertion specifically covers the legacy mirror persistence behaviour during the 260604 migration window
    const legacyThinking = settings.claude.thinkingModel;
    void legacyThinking;
  });
});
