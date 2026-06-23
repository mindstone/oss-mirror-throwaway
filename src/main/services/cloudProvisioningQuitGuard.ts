/**
 * Quit Guard for Cloud Provisioning
 *
 * Prevents the user from quitting the app while cloud provisioning or
 * provider-switching is in progress. Shows a native warning dialog with
 * "Quit Anyway" / "Wait" options. Follows the same pattern as
 * localRecordingService.registerQuitHandler() and
 * quickCaptureHandlers.registerQuickCaptureQuitHandler().
 */

import { app, dialog } from 'electron';
import { createScopedLogger } from '@core/logger';
import { fireAndForget } from '@shared/utils/fireAndForget';
import { isUpdateQuit } from './gracefulShutdown';
import { isCloudProvisioningActive } from '../ipc/cloudHandlers';

const log = createScopedLogger({ service: 'cloud-provisioning-quit-guard' });

/** Guard flag to prevent re-entry during quit dialog */
let quitDialogActive = false;

export function registerCloudProvisioningQuitHandler(): void {
  app.on('before-quit', (event) => {
    fireAndForget((async () => {
    // Skip dialog during update-driven quits — let the update proceed
    if (isUpdateQuit()) return;

    if (!isCloudProvisioningActive() || quitDialogActive) return;

    event.preventDefault();
    quitDialogActive = true;

    try {
      const result = await dialog.showMessageBox({
        type: 'warning',
        title: 'Cloud Setup in Progress',
        message: 'Your cloud instance is still being set up.',
        detail:
          'Quitting now may leave your cloud in an incomplete state. It\u2019s best to wait until setup finishes.',
        buttons: ['Quit Anyway', 'Wait'],
        defaultId: 1,
        cancelId: 1,
      });

      if (result.response === 0) {
        app.quit();
      }
    } finally {
      quitDialogActive = false;
    }
    })(), 'cloudProvisioning.beforeQuit');
  });

  log.info('Quit handler registered for cloud provisioning protection');
}
