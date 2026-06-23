// Fixture (n) — legacy-namespace model read inside a correctly-composed
// gate expression.
// Expected: FAIL — the gate-composition pass sees both auth-shape and
// provider-shape, so it does not report. The body-scan pass must still
// flag the legacy `claude.model` read inside the gate, otherwise the
// stale-mirror hazard sneaks past both passes silently. This is the
// Round-3 reviewer-flagged hole in the position-only dedup.

import { describe, it } from 'vitest';
import {
  getApiKeyForDirectUse,
  isDirectAnthropicConfig,
} from '@core/utils/authEnvUtils';
import type { AppSettings } from '@shared/types';

declare const settings: AppSettings;

const canRun =
  isDirectAnthropicConfig(settings) &&
  !!getApiKeyForDirectUse(settings) &&
  !!settings.claude.model;

describe.skipIf(!canRun)('legacy-model-read inside gate', () => {
  it('runs', () => {});
});
