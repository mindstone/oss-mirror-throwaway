// Fixture (c) — raw-field-only gate: the rebelCore.integration.test.ts shape.
// Expected: FAIL.

import { describe } from 'vitest';
import type { AppSettings } from '@shared/types';

declare const settings: AppSettings | null;

const canRun = !!settings?.claude?.apiKey;

describe.skipIf(!canRun)('live API', () => {
  // ...
});
