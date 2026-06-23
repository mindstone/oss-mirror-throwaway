// Fixture (d) — suppressed-with-justification: explicit opt-out.
// Expected: PASS (logged as suppression, not a violation).

import { describe } from 'vitest';
import type { AppSettings } from '@shared/types';

declare const settings: AppSettings | null;

// SKIP-GATE-INTENT: legacy migration path — this test only covers the v1 schema and never reaches the direct-Anthropic surface
const canRun = !!settings?.claude?.apiKey;

describe.skipIf(!canRun)('legacy migration', () => {
  // ...
});
