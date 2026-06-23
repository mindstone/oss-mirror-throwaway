// Fixture (i) — canonical-accessor model read.
// Expected: PASS. The canonical accessor reads `models.*` first and only
// falls through to `claude.*` when the new namespace is absent for that
// field, so it does not exhibit the legacy-mirror drift hazard.

import { describe, it } from 'vitest';
import {
  getCurrentModel,
  getThinkingModel,
  getPermissionMode,
} from '@core/rebelCore/settingsAccessors';
import {
  getApiKeyForDirectUse,
  isDirectAnthropicConfig,
} from '@core/utils/authEnvUtils';
import type { AppSettings } from '@shared/types';

declare const settings: AppSettings;

const canRun = isDirectAnthropicConfig(settings) && !!getApiKeyForDirectUse(settings);

describe.skipIf(!canRun)('canonical-accessor reads', () => {
  it('reads via canonical accessors only', () => {
    const workingModel = getCurrentModel(settings);
    const thinkingModel = getThinkingModel(settings);
    const permissionMode = getPermissionMode(settings);
    void workingModel;
    void thinkingModel;
    void permissionMode;
  });
});
