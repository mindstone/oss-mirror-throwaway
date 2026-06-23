/**
 * Standalone CLI startup wrapper for the canonical core graceful-fs installer.
 */

import { installGracefulFsAtBoot } from '@core/startup/installGracefulFs';

installGracefulFsAtBoot({ retryOnFailure: true });
