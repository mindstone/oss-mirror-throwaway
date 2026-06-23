// Fixture (e) — suppression marker present but rationale empty.
// Expected: FAIL (a non-empty reason is required).

import { describe } from 'vitest';
import type { AppSettings } from '@shared/types';

declare const settings: AppSettings | null;

// SKIP-GATE-INTENT:
const canRun = !!settings?.claude?.apiKey;

describe.skipIf(!canRun)('live API', () => {
  // ...
});
