/**
 * Ensure shared userData path resolution.
 *
 * Rebel intentionally uses a shared userData directory across dev/beta/stable
 * so settings and stores live in one place.
 *
 * This module must be imported FIRST in index.ts (before electron-store or any
 * other module that uses app.getPath('userData')).
 *
 * Note: ensureTestUserData.ts runs immediately after this and can override
 * userData for tests.
 */
import { PRIVATE_MINDSTONE_BOOTSTRAP_MODE } from '@private/mindstone/mode';
import { app } from 'electron';
import path from 'node:path';

const sharedUserDataDirName = PRIVATE_MINDSTONE_BOOTSTRAP_MODE === 'stub'
  ? 'mindstone-rebel-oss'
  : 'mindstone-rebel';
const sharedUserData = path.join(app.getPath('appData'), sharedUserDataDirName);
app.setPath('userData', sharedUserData);
