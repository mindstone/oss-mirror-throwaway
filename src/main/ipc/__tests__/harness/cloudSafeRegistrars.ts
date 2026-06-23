/**
 * Stage 5: typed cloud-safe registrar boot table.
 *
 * ## What this is
 * A typed table mirroring `registerCloudIpcHandlers` (cloud `bootstrap.ts:1365-1660`)
 * and the 23-registrar re-export barrel `src/main/ipc/cloudIpcHandlers.ts`. Each
 * entry pairs a `register*Handlers` function with a thunk that builds the small
 * `deps` it needs from a shared {@link HarnessRegistrarContext} — `getSettings`,
 * `getSettingsStore`, … — assembled from `bootRealAmbientServices()` + a
 * `buildSettings()` fixture.
 *
 * ## Scope & honesty
 * The barrel is **23 registrars** (verified against `cloudIpcHandlers.ts`). The
 * deps mirror what the cloud bootstrap passes, but with **light in-memory fakes**
 * for the heavier collaborators (session lock manager, automation scheduler,
 * community highlights service, …) — the harness drives *contract shape*, not
 * cloud session/automation semantics. Registration is side-effect-free beyond
 * `registerHandler` (no body runs at registration), so booting the full table is
 * cheap; the Stage-5 driver and Stage-6 enumerator read back the actually-
 * registered channels via `listRegisteredChannels()`.
 *
 * ## The EXECUTE_SAFE allowlist is NOT a registration concern
 * Side-effecting channels (library writes, sessions:save, …) still REGISTER here;
 * they are simply left OFF the `EXECUTE_SAFE` allowlist, so the Stage-5 driver
 * (`roundTrip.ts`) stubs them by default (safe by construction) behind
 * `REBEL_CONTRACT_HARNESS_PARSE_ONLY`, per the Stage-2 split.
 */

import { buildSettings } from '@core/__tests__/builders/settingsBuilder';
import type { AppSettings } from '@shared/types';
import type { KeyValueStore } from '@core/store';

// NOTE: the `register*Handlers` functions are imported DYNAMICALLY at boot time
// (see `bootCloudSafeRegistrars`), NOT statically. A static import would bind to
// the BASE module graph, but `bootRealAmbientServices()` installs the registry on
// the live (post-`vi.resetModules()`) graph via dynamic import — so a static
// `registerHandler` here would read a DIFFERENT `getHandlerRegistry` and throw
// "HandlerRegistry not initialized". This is the Stage-3 DEVIATION graph-fork
// hazard; dynamic import keeps the registrars on the same live graph.
type CloudBarrel = typeof import('../../cloudIpcHandlers');

/**
 * Shared context the registrar thunks read from. Built once per harness boot
 * from `bootRealAmbientServices()` + a `buildSettings()` fixture. Kept minimal:
 * the settings fixture + a settings store wrapper are all the cloud-safe
 * registrars genuinely need to *register* and to round-trip read channels.
 */
export interface HarnessRegistrarContext {
  /** Current settings fixture (workspace `coreDirectory`, spaces, …). */
  getSettings: () => AppSettings;
  /** Settings store wrapper. `{ store }` for library; full KV store for settings. */
  getSettingsStore: () => KeyValueStore<AppSettings>;
}

/**
 * Build the default harness registrar context. `coreDirectory` defaults to a
 * `/tmp`-scoped path so read channels resolve a (empty) workspace; callers that
 * need a real on-disk workspace (e.g. the `library:stat-file` round-trip) pass
 * their own `coreDirectory`.
 */
export function buildHarnessRegistrarContext(
  overrides: { coreDirectory?: string } = {},
): HarnessRegistrarContext {
  const settings = buildSettings({
    coreDirectory: overrides.coreDirectory ?? '/tmp/rebel-harness-workspace',
    spaces: [],
  });
  // A minimal settings-store shim: the cloud-safe registrars only read
  // `.store` (library) or treat it as a KeyValueStore for settings updates.
  const store = {
    store: settings,
    get: (key: keyof AppSettings) => settings[key],
    set: () => {},
    delete: () => {},
    has: () => true,
    clear: () => {},
  } as unknown as KeyValueStore<AppSettings>;
  return {
    getSettings: () => settings,
    getSettingsStore: () => store,
  };
}

/**
 * A single cloud-safe registrar entry: its barrel name + a thunk that calls the
 * real `register*Handlers` with the deps it needs from the shared context.
 */
export interface CloudSafeRegistrarEntry {
  /** The barrel export name (mirrors `cloudIpcHandlers.ts`). */
  readonly name: keyof CloudBarrel;
  /** Register this registrar's handlers into the live registry. */
  readonly register: (barrel: CloudBarrel, ctx: HarnessRegistrarContext) => void;
}

/**
 * The 23 cloud-safe registrars, each wired with the minimal deps that mirror
 * `registerCloudIpcHandlers`. Heavy collaborators are stubbed with throwing /
 * inert fakes — they are never invoked at registration time, and any channel
 * that would actually need them at invoke time is simply left OFF `EXECUTE_SAFE`
 * (driver stubs it by default) or surfaces loudly when driven.
 */
export const CLOUD_SAFE_REGISTRARS: readonly CloudSafeRegistrarEntry[] = [
  { name: 'registerLibraryHandlers', register: (b, ctx) => b.registerLibraryHandlers({
    getSettings: ctx.getSettings,
    getSettingsStore: () => ({ store: ctx.getSettings() }),
  }) },
  { name: 'registerSettingsHandlers', register: (b, ctx) => b.registerSettingsHandlers({
    getSettings: ctx.getSettings,
    getSettingsStore: ctx.getSettingsStore,
    ensureNormalizedSettings: () => {},
    applyVoiceActivationHotkey: () => ({ success: false, error: 'not available in the IPC harness' }),
    getPendingVoiceActivationHotkey: () => null,
    setPendingVoiceActivationHotkey: () => {},
    broadcastDiagnosticsUpdate: () => {},
    scheduleDiagnosticsExpiry: () => {},
    getWindowForEvent: () => null,
  }) },
  { name: 'registerSessionsHandlers', register: (b) => b.registerSessionsHandlers({
    loadAgentSessions: () => [],
    saveAgentSessions: () => {},
    upsertAgentSession: async (session) => ({
      outcome: 'persisted' as const,
      persistedSessionIds: [session.id],
      droppedTombstonedSessionIds: [],
    }),
    // Heavy collaborators are inert stubs — never exercised at registration time;
    // sessions write channels are OFF EXECUTE_SAFE (driver stubs them by default).
    sessionLockManager: harnessThrowingStub('sessionLockManager'),
    sessionLockOwnerKind: 'cloud',
  }) },
  { name: 'registerInboxHandlers', register: (b) => b.registerInboxHandlers() },
  { name: 'registerAutomationsHandlers', register: (b) => b.registerAutomationsHandlers({
    getScheduler: () => harnessThrowingStub('automationScheduler'),
  }) },
  { name: 'registerDashboardHandlers', register: (b, ctx) => b.registerDashboardHandlers({
    getSettings: ctx.getSettings,
  }) },
  { name: 'registerUserTasksHandlers', register: (b) => b.registerUserTasksHandlers() },
  { name: 'registerScratchpadHandlers', register: (b, ctx) => b.registerScratchpadHandlers({
    getSettings: ctx.getSettings,
  }) },
  { name: 'registerSkillsHandlers', register: (b) => b.registerSkillsHandlers() },
  { name: 'registerUseCaseLibraryHandlers', register: (b) => b.registerUseCaseLibraryHandlers() },
  { name: 'registerFileConversationHandlers', register: (b) => b.registerFileConversationHandlers() },
  { name: 'registerSafetyHandlers', register: (b) => b.registerSafetyHandlers() },
  { name: 'registerSafetyActivityLogHandlers', register: (b) => b.registerSafetyActivityLogHandlers() },
  { name: 'registerSafetyPromptHandlers', register: (b) => b.registerSafetyPromptHandlers() },
  { name: 'registerSearchHandlers', register: (b) => b.registerSearchHandlers() },
  { name: 'registerFeedbackHandlers', register: (b) => b.registerFeedbackHandlers() },
  { name: 'registerMemoryHandlers', register: (b, ctx) => b.registerMemoryHandlers({
    getWorkspacePath: () => ctx.getSettings().coreDirectory ?? undefined,
  }) },
  { name: 'registerCommunityHandlers', register: (b, ctx) => b.registerCommunityHandlers({
    getCommunityHighlightsService: () => harnessThrowingStub('communityHighlightsService'),
    getSettings: ctx.getSettings,
    getSession: async () => null,
  }) },
  { name: 'registerMiscHandlers', register: (b, ctx) => b.registerMiscHandlers({
    getSettings: ctx.getSettings,
    ensureNormalizedSettings: () => {},
    loadRuntimeConfig: () => ({
      appVersion: '0.0.0-test',
      platform: 'harness',
      isPackaged: false,
      userData: '/tmp/rebel-harness-user-data',
      logsPath: '/tmp/rebel-harness-user-data/logs',
    }),
  }) },
  { name: 'registerCalendarHandlers', register: (b, ctx) => b.registerCalendarHandlers({
    getSettings: ctx.getSettings,
  }) },
  { name: 'registerErrorRecoveryHandlers', register: (b) => b.registerErrorRecoveryHandlers() },
  { name: 'registerUsageHandlers', register: (b) => b.registerUsageHandlers({
    listSessionSummaries: () => [],
  }) },
  { name: 'registerDiagnosticsHandlers', register: (b) => b.registerDiagnosticsHandlers() },
];

/**
 * A `Proxy` that throws on any access — for heavy collaborators (session lock
 * manager, scheduler, …) that the harness never legitimately invokes. If a
 * driven channel reaches into one, it fails LOUDLY (so keep it OFF
 * `EXECUTE_SAFE`) rather than silently returning a fake value.
 */
function harnessThrowingStub<T>(label: string): T {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        throw new Error(
          `HarnessRegistrarStub(${label}): property '${String(prop)}' accessed — this collaborator is not modelled in the IPC contract harness; keep this channel OFF EXECUTE_SAFE so the driver stubs it.`,
        );
      },
    },
  ) as T;
}

/**
 * Boot all cloud-safe registrars into the live registry using the shared
 * context. Call AFTER `bootRealAmbientServices()` has installed the ambient
 * factories + a fresh `MapHandlerRegistry`.
 *
 * The barrel is imported DYNAMICALLY so the registrars (and their transitive
 * `registerHandler` → `getHandlerRegistry`) land on the same live module graph
 * the boot helper installed the registry on (Stage-3 DEVIATION graph-fork
 * hazard). Hence this is async — callers MUST `await` it.
 */
export async function bootCloudSafeRegistrars(ctx: HarnessRegistrarContext): Promise<void> {
  const barrel = (await import('../../cloudIpcHandlers')) as CloudBarrel;
  for (const entry of CLOUD_SAFE_REGISTRARS) {
    entry.register(barrel, ctx);
  }
}
