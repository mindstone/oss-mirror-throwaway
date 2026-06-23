/**
 * Migration import boot adoption.
 *
 * This side-effect module must run after ensureAppIdentity sets the canonical
 * userData path and before any stores construct. It adopts a fully staged
 * migration import only when the current target profile is fresh.
 */

import { getElectronModule } from '@core/lazyElectron';
import { adoptPreparedMigrationImportSync } from '@core/services/migration/migrationImportService';
/* eslint-disable no-console -- startup: runs before structured logger */

const electron = getElectronModule();

if (electron) {
  const userDataPath = electron.app.getPath('userData');
  const result = adoptPreparedMigrationImportSync({
    targetUserDataPath: userDataPath,
    now: new Date(),
  });

  if (result.status === 'adopted') {
    console.log('[Migration Import] Adopted staged userData import:', {
      importId: result.importId,
      backupKept: Boolean(result.backupDir),
    });
  } else if (result.status === 'refused') {
    console.log('[Migration Import] Refused staged userData import:', {
      code: result.code,
      errorStateRecorded: Boolean(result.errorStatePath),
    });
  } else if (result.status === 'ignored-invalid-flag') {
    console.log('[Migration Import] Ignored invalid import flag:', result.code);
  }
}
