// SHIM-RETAINED: Main/core callers still import @main/settingsStore and this file preserves desktop test-isolation side effects.
import { assertTestIsolationIfRequired } from './startup/ensureTestUserData';

// Keep desktop test-isolation defense-in-depth at the historical @main import path.
assertTestIsolationIfRequired();

export * from '@core/services/settingsStore/index';
