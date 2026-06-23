/**
 * Process-wide singleton accessor for the managed MCP install service.
 *
 * The service caches state (in-flight installs, resolved npm path) so we want
 * exactly one instance per process tied to the app's userData directory.
 *
 * Configuration happens in main-process bootstrap (src/main/index.ts) after
 * Electron's `app.getPath('userData')` is available.
 */

import {
  createManagedMcpInstallService,
  resolveManagedInstallsRoot,
  type ManagedMcpInstallService,
} from './managedMcpInstallService';
import { createScopedLogger } from '@core/logger';

interface SingletonState {
  userDataPath: string;
  service: ManagedMcpInstallService;
}

let state: SingletonState | null = null;

const log = createScopedLogger({ service: 'managed-mcp-install-singleton' });

/**
 * Configure the singleton with the app's userData path. Subsequent calls to
 * `getManagedMcpInstallService()` return the same instance. Calling this more
 * than once with a different userData path replaces the singleton and logs a
 * warning — this should never happen in production but is useful for tests.
 */
export function configureManagedMcpInstallService(userDataPath: string): ManagedMcpInstallService {
  if (state && state.userDataPath === userDataPath) {
    return state.service;
  }
  if (state && state.userDataPath !== userDataPath) {
    log.warn(
      { previous: state.userDataPath, next: userDataPath },
      'Reconfiguring managed MCP install singleton with a new userData path',
    );
  }
  const service = createManagedMcpInstallService({ userDataPath });
  state = { userDataPath, service };
  return service;
}

/**
 * Returns the configured singleton, or null if configuration has not happened
 * yet. Non-throwing so startup code can no-op gracefully during tests or very
 * early boot before bootstrap completes.
 */
export function getManagedMcpInstallService(): ManagedMcpInstallService | null {
  return state?.service ?? null;
}

/**
 * Returns the absolute managed-installs root for the configured singleton, or
 * null if not configured. Used by migration gates and cloud payload writers.
 */
export function getManagedInstallsRoot(): string | null {
  if (!state) return null;
  return resolveManagedInstallsRoot(state.userDataPath);
}

/** Test-only: clear the singleton. */
export function __resetManagedMcpInstallSingletonForTesting(): void {
  state = null;
}
