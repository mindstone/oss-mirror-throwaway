/**
 * Stage 3: minimal test-local `bootRealAmbientServices()` + teardown.
 *
 * ## What this is
 * A **minimal test-local** ambient boot helper for the in-process IPC contract
 * round-trip harness. It installs a fresh `MapHandlerRegistry` plus the **12
 * `set*Factory` shims** that cloud `bootstrap.ts:469-480` installs — but with
 * lean in-memory fakes instead of the cloud implementations — so that the
 * cloud-safe IPC registrars can boot in a single Node test process WITHOUT a
 * running Electron app and WITHOUT the ~30-`vi.mock` wall the existing partial
 * harness needed for just two registrars.
 *
 * ## Deliberately NOT a verbatim cloud extraction (round-2 architecture-F2/F3)
 * This is NOT `bootstrap.ts:469-526` copied. It models ONLY the 12 ambient
 * factory seams (469-480) and explicitly does NOT pull the cloud-coupled tail
 * (481-529): `setCodexAuthProvider`, `setRebelAuthProvider`, the full
 * `TokenSyncCoordinator`/`CloudTokenSyncTransport`/`CloudFileLockLease`,
 * `CloudOAuthToolResolver`, `setTracker`, `setBroadcastService(cloudEventBroadcaster)`,
 * the diagnostics-events ledger reader/writer, and `setDiagnosticEventsSurface('cloud')`.
 * Those are cloud assumptions that have no place in a desktop IPC contract harness.
 * A `bootRealAmbientServices.divergence.test.ts` guards the 469-480 list so the
 * harness fails loud (not "X not initialized") when cloud adds a 13th factory.
 *
 * ## Platform / logger + the resetModules interaction
 * `vitest.setup.ts:104` calls `setPlatformConfig()` once on the BASE module
 * graph. The PLAN (testability-F4) wants `vi.resetModules()` per case to kill
 * order-dependent false greens — but a reset drops that base-graph platform
 * config (setup runs once, not per reset) AND forks the module registry, so a
 * statically-imported `setStoreFactory` would target a DIFFERENT module instance
 * than the dynamically-imported handler's `createStore`. To stay correct under
 * `vi.resetModules()`, this helper is **async + dynamic-import-only**: it imports
 * the setters (and re-applies `setPlatformConfig`) AT BOOT TIME, so every shim
 * lands on the same live post-reset graph the handlers import on.
 *
 * ## Honest scope re: library module-top imports
 * `libraryHandlers` has module-top-level service imports (`behindTheScenesClient`,
 * `spaceService`, `skillsService`) that are NOT behind any of the 12 factory
 * seams. This helper does NOT neutralise those — they have no import-time side
 * effects (only `new Set()`/`new Map()` constants) so the module imports and the
 * registrar boots fine; they crash only when those specific channels are
 * INVOKED. Those channels are therefore simply LEFT OFF the `EXECUTE_SAFE`
 * allowlist (`registerContractHandler.ts`), so the Stage-5 driver stubs them by
 * default (safe by construction), rather than this helper pretending the
 * mock-wall is fully gone for library.
 *
 * ## Teardown / no public "reset to uninitialized"
 * None of the 12 `set*Factory` setters exposes a "reset to uninitialized"
 * primitive (they cache a lazy instance and clear it on the next `set*`). So
 * teardown does NOT null them out — it RE-INSTALLS the same fresh in-memory
 * fakes (which also clears the cached instance, by each setter's
 * `_instance = undefined`) and re-installs a fresh `MapHandlerRegistry`. That
 * leaves a clean, deterministic ambient state for the next test, mirroring the
 * existing `afterEach` in `ipcContractRoundTrip.integration.test.ts`. Pair with
 * `vi.resetModules()` per case to drop module-scoped handler state.
 */

// Types only — type imports are erased at runtime, so they are safe to import
// statically even under `vi.resetModules()`. The *setter function* calls live
// in the dynamic-import boot below so they land on the live post-reset graph.
import type { StoreFactoryOptions } from '@core/storeFactory';
import type { KeyValueStore } from '@core/store';
import type { Scheduler, SchedulerTimerHandle } from '@core/scheduler';
import type { SecureTokenStore } from '@core/secureTokenStore';
import type { WorkspaceFileSystem } from '@core/workspaceFileSystem';
import type { ProcessSpawner } from '@core/processSpawner';
import type { PushNotificationSink } from '@core/pushNotificationSink';
import type { PowerSaveBlocker, PowerSaveBlockerStatus } from '@core/powerSaveBlocker';
import type {
  PreTurnWorker,
  PreTurnWorkerStatus,
  PreTurnWorkerStatsSnapshot,
} from '@core/preTurnWorker';
import type { CurrentUserProvider } from '@core/currentUserProvider';
import type { EmbeddingGenerator } from '@core/embeddingGenerator';
import type { DockBadge } from '@core/dockBadge';
import type { DesktopNotificationSink } from '@core/desktopNotificationSink';

import { TestMemoryStore } from '@core/__tests__/TestMemoryStore';

/**
 * Canonical embedding dimension (BGE-small-en-v1.5 → 384). Inlined rather than
 * imported as a runtime value so the helper stays dynamic-import-only for the
 * graph-sensitive setters. Kept in sync with `@core/embeddingGenerator`'s
 * `HARNESS_EMBEDDING_DIMENSION` (a stable per-model constant).
 */
const HARNESS_EMBEDDING_DIMENSION = 384;

/**
 * Platform-config fixture re-applied at boot time. Mirrors the desktop values
 * `vitest.setup.ts` installs on the base graph, so handler modules that read
 * `getPlatformConfig()` at import resolve correctly on the post-reset graph too.
 */
const HARNESS_PLATFORM_CONFIG = {
  userDataPath: '/tmp/test-user-data',
  appPath: '/tmp/test-app',
  tempPath: '/tmp/test-temp',
  logsPath: '/tmp/test-logs',
  homePath: '/tmp/test-home',
  documentsPath: '/tmp/test-documents',
  desktopPath: '/tmp/test-desktop',
  appDataPath: '/tmp/test-appData',
  version: '0.0.0-test',
  isPackaged: false,
  platform: process.platform,
  totalMemoryBytes: 36 * 1024 * 1024 * 1024,
  arch: process.arch,
  surface: 'desktop' as const,
  isOss: false,
};

/**
 * The canonical list of `set*Factory` identifiers this helper installs — the
 * SUPERSET asserted against `cloud-service/src/bootstrap.ts:469-480` by the
 * divergence guard. Kept as a literal array (not just the call sites below) so
 * the guard can compare names without parsing this file. When you add a factory
 * to `installAmbientFactories()`, add its name here too.
 *
 * NOTE: the divergence guard parses the names out of `bootstrap.ts` at test
 * time (NOT a hardcoded bootstrap list) and asserts this set is a superset.
 */
export const INSTALLED_AMBIENT_FACTORIES: readonly string[] = [
  'setStoreFactory',
  'setSchedulerFactory',
  'setSecureTokenStoreFactory',
  'setWorkspaceFileSystemFactory',
  'setProcessSpawnerFactory',
  'setPushNotificationSinkFactory',
  'setPowerSaveBlockerFactory',
  'setPreTurnWorkerFactory',
  'setCurrentUserProviderFactory',
  'setEmbeddingGeneratorFactory',
  'setDockBadgeFactory',
  'setDesktopNotificationSinkFactory',
];

// --- Lean in-memory fakes for the 12 ambient seams -------------------------

function makeMemoryStore<T extends Record<string, unknown>>(
  options: StoreFactoryOptions<T>,
): KeyValueStore<T> {
  return new TestMemoryStore<T>(options) as unknown as KeyValueStore<T>;
}

/**
 * Synchronous, non-firing scheduler. Timers return inert handles and never run
 * (the harness drives handlers directly; background timers would leak across
 * tests). `now()` is real wall-clock; `sleep` resolves immediately;
 * `deferUntilVisible` resolves 'visible' so visibility-gated paths proceed.
 */
class HarnessScheduler implements Scheduler {
  registerTimeout(_callback: () => void, _delayMs: number): SchedulerTimerHandle {
    return 0 as unknown as SchedulerTimerHandle;
  }
  registerInterval(_callback: () => void, _intervalMs: number): SchedulerTimerHandle {
    return 0 as unknown as SchedulerTimerHandle;
  }
  clear(_timer: SchedulerTimerHandle): void {}
  now(): number {
    return Date.now();
  }
  async sleep(_ms: number): Promise<void> {}
  isVisible(): boolean {
    return true;
  }
  async deferUntilVisible(): Promise<'visible' | 'timeout' | 'aborted'> {
    return 'visible';
  }
}

/** In-memory secure-token store — no OS keychain. */
class HarnessSecureTokenStore implements SecureTokenStore {
  read(): string | null {
    return null;
  }
  write(): void {}
  delete(): void {}
  has(): boolean {
    return false;
  }
  isEncryptionAvailable(): boolean {
    return false;
  }
}

/**
 * Workspace filesystem that rejects every call. The real desktop/cloud impls
 * touch the disk; channels that genuinely need workspace fs (library read/write)
 * are simply left OFF the `EXECUTE_SAFE` allowlist and stubbed by the Stage-5
 * driver (safe by default), so this fake's job is only to be installed (satisfy
 * `getWorkspaceFileSystem()` for any lazy resolution at registration time), not
 * to serve reads.
 */
class HarnessWorkspaceFileSystem implements WorkspaceFileSystem {
  private unsupported(): never {
    throw new Error(
      'HarnessWorkspaceFileSystem: filesystem access is not modelled in the IPC contract harness; ' +
        'leave this channel OFF the EXECUTE_SAFE allowlist so the Stage-5 driver stubs it.',
    );
  }
  async listDirectory(): Promise<never> {
    return this.unsupported();
  }
  async realPath(): Promise<never> {
    return this.unsupported();
  }
  async stat(): Promise<never> {
    return this.unsupported();
  }
  async readFile(): Promise<never> {
    return this.unsupported();
  }
  async writeFile(): Promise<never> {
    return this.unsupported();
  }
  async deleteFile(): Promise<never> {
    return this.unsupported();
  }
  async exists(): Promise<never> {
    return this.unsupported();
  }
}

/**
 * Fail-closed process spawner — no subprocesses in the harness.
 *
 * Both `spawn()` and `exec()` THROW: a channel that crosses into a subprocess
 * path is unmodelled here, and a silent successful `exec()` fake would make such
 * a "safe"-looking channel appear executable while it actually escaped into an
 * unmodelled side-effect path. Failing loud surfaces that during Stage-5 driving
 * (keep the channel OFF `EXECUTE_SAFE` so it is stubbed instead). `kill`/
 * `waitForExit` stay
 * inert because they are queried on handles `spawn()` never returns.
 */
class HarnessProcessSpawner implements ProcessSpawner {
  private unsupported(): never {
    throw new Error('HarnessProcessSpawner: subprocess spawning is not modelled in the IPC contract harness.');
  }
  spawn(): never {
    return this.unsupported();
  }
  async exec(): Promise<{ stdout: string; stderr: string; error: Error | null }> {
    return this.unsupported();
  }
  kill(): boolean {
    return false;
  }
  async waitForExit(): Promise<{ code: number | null; signal: NodeJS.Signals | null; timedOut: boolean }> {
    return { code: 0, signal: null, timedOut: false };
  }
}

/** No-op push-notification sink. */
class HarnessPushNotificationSink implements PushNotificationSink {
  canSendPushNotifications(): boolean {
    return false;
  }
  async sendPushNotification(): Promise<void> {}
}

/** No-op power-save blocker. */
class HarnessPowerSaveBlocker implements PowerSaveBlocker {
  acquireBlock(): void {}
  releaseBlock(): void {}
  getBlockerStatus(): PowerSaveBlockerStatus {
    return { active: false, refCount: 0, reasons: {}, startedAt: null, durationMs: null };
  }
  dispose(): void {}
  resetForTesting(): void {}
}

/** Inert pre-turn worker — never ready, no semantic context assembly. */
class HarnessPreTurnWorker implements PreTurnWorker {
  async waitForWorkerReady(): Promise<void> {}
  isWorkerAvailable(): boolean {
    return false;
  }
  async assemblePreTurnContext(): Promise<Record<string, never>> {
    return {};
  }
  async disposeWorker(): Promise<void> {}
  getWorkerStatus(): PreTurnWorkerStatus {
    return {
      isReady: false,
      permanentlyDisabled: false,
      consecutiveCrashes: 0,
      crashCooldownRemainingMs: 0,
      workspacePath: null,
    };
  }
  getPreTurnWorkerStats(): PreTurnWorkerStatsSnapshot {
    return {
      since: 'app_start',
      appStartedAt: Date.now(),
      spawnCount: 0,
      restartCount: 0,
      currentlyRestarting: false,
    };
  }
}

/** No current user. */
class HarnessCurrentUserProvider implements CurrentUserProvider {
  getCurrentUser(): null {
    return null;
  }
}

/** Embedding generator returning zero-vectors of the canonical dimension. */
class HarnessEmbeddingGenerator implements EmbeddingGenerator {
  readonly embeddingDimension = HARNESS_EMBEDDING_DIMENSION;
  async generateEmbedding(): Promise<Float32Array> {
    return new Float32Array(HARNESS_EMBEDDING_DIMENSION);
  }
  async generateQueryEmbedding(): Promise<Float32Array> {
    return new Float32Array(HARNESS_EMBEDDING_DIMENSION);
  }
  async generateEmbeddings(texts: string[]): Promise<Float32Array[]> {
    return texts.map(() => new Float32Array(HARNESS_EMBEDDING_DIMENSION));
  }
}

/** No-op dock badge. */
class HarnessDockBadge implements DockBadge {
  initDockBadge(): void {}
  showUnreadDot(): void {}
  clearUnreadDot(): void {}
}

/** No-op desktop notification sink. */
class HarnessDesktopNotificationSink implements DesktopNotificationSink {
  showDesktopNotification(): void {}
}

/**
 * Install (or RE-install) the 12 in-memory ambient factory fakes + a fresh
 * `MapHandlerRegistry` + the platform config, all via DYNAMIC import so the
 * shims land on the live (possibly post-`vi.resetModules()`) module graph.
 * Idempotent — each `set*Factory` clears its cached lazy instance, so calling
 * this in teardown yields a clean, deterministic state for the next test.
 */
async function installAmbient(): Promise<void> {
  const [
    { setHandlerRegistry },
    { MapHandlerRegistry },
    { setPlatformConfig },
    { setStoreFactory },
    { setSchedulerFactory },
    { setSecureTokenStoreFactory },
    { setWorkspaceFileSystemFactory },
    { setProcessSpawnerFactory },
    { setPushNotificationSinkFactory },
    { setPowerSaveBlockerFactory },
    { setPreTurnWorkerFactory },
    { setCurrentUserProviderFactory },
    { setEmbeddingGeneratorFactory },
    { setDockBadgeFactory },
    { setDesktopNotificationSinkFactory },
  ] = await Promise.all([
    import('@core/handlerRegistry'),
    import('@core/handlerRegistry/mapHandlerRegistry'),
    import('@core/platform'),
    import('@core/storeFactory'),
    import('@core/scheduler'),
    import('@core/secureTokenStore'),
    import('@core/workspaceFileSystem'),
    import('@core/processSpawner'),
    import('@core/pushNotificationSink'),
    import('@core/powerSaveBlocker'),
    import('@core/preTurnWorker'),
    import('@core/currentUserProvider'),
    import('@core/embeddingGenerator'),
    import('@core/dockBadge'),
    import('@core/desktopNotificationSink'),
  ]);

  // Re-apply platform config on the live graph (dropped by vi.resetModules()).
  setPlatformConfig(HARNESS_PLATFORM_CONFIG);

  // The 12 ambient factory shims (mirrors bootstrap.ts:469-480).
  setStoreFactory(makeMemoryStore);
  setSchedulerFactory(() => new HarnessScheduler());
  setSecureTokenStoreFactory(() => new HarnessSecureTokenStore());
  setWorkspaceFileSystemFactory(() => new HarnessWorkspaceFileSystem());
  setProcessSpawnerFactory(() => new HarnessProcessSpawner());
  setPushNotificationSinkFactory(() => new HarnessPushNotificationSink());
  setPowerSaveBlockerFactory(() => new HarnessPowerSaveBlocker());
  setPreTurnWorkerFactory(() => new HarnessPreTurnWorker());
  setCurrentUserProviderFactory(() => new HarnessCurrentUserProvider());
  setEmbeddingGeneratorFactory(() => new HarnessEmbeddingGenerator());
  setDockBadgeFactory(() => new HarnessDockBadge());
  setDesktopNotificationSinkFactory(() => new HarnessDesktopNotificationSink());

  // Fresh registry last, so registrars register into a clean Map.
  setHandlerRegistry(new MapHandlerRegistry());
}

/** Teardown handle returned by {@link bootRealAmbientServices}. */
export interface AmbientServicesHandle {
  /**
   * Reset EVERY factory/provider this helper installed and re-install a fresh
   * `MapHandlerRegistry`. Since the `set*Factory` seams expose no "reset to
   * uninitialized", teardown re-installs the same fresh fakes (clearing each
   * cached instance) — leaving a clean ambient state with no cross-test leakage.
   */
  teardown(): Promise<void>;
}

/**
 * Boot the minimal ambient layer the cloud-safe IPC registrars need.
 *
 * Installs a fresh `MapHandlerRegistry` + the 12 in-memory ambient factory
 * fakes + the platform config, all via dynamic import (resetModules-safe).
 * Imports NO Electron.
 *
 * @returns a handle whose `teardown()` restores a clean ambient state.
 */
export async function bootRealAmbientServices(): Promise<AmbientServicesHandle> {
  await installAmbient();

  return {
    async teardown(): Promise<void> {
      // Re-install fakes (clears each cached lazy instance) + a fresh registry.
      await installAmbient();
    },
  };
}
