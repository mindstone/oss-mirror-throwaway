/**
 * Cloud startup wrapper for the canonical core graceful-fs installer.
 * Cloud keeps retry disabled to preserve the lighter bootstrap behavior.
 */

import * as gracefulFsInstaller from '@core/startup/installGracefulFs';

gracefulFsInstaller.installGracefulFsAtBoot({ retryOnFailure: false });
