/**
 * Stage 3 boot + isolation proof for `bootRealAmbientServices()`.
 *
 * Proves:
 *  1. Booting the minimal ambient layer + registering the real
 *     `registerFeedbackHandlers()` and `registerLibraryHandlers(deps)` makes
 *     their channels show up in `getHandlerRegistry().listRegisteredChannels()`
 *     — WITHOUT the ~30-`vi.mock` wall the existing partial harness needed.
 *  2. A two-test isolation case: `teardown()` leaves a fresh, empty registry so
 *     no channel registered in the first test leaks into the second.
 *
 * Honest scope: this test asserts REGISTRATION (the boot replaces the mock wall
 * for getting these registrars to register). It does NOT invoke the
 * library:read/list channels, whose `libraryHandlers` module-top imports
 * (`behindTheScenesClient`, `spaceService`, `skillsService`) are not behind the
 * 12 factory seams — those are simply left OFF the `EXECUTE_SAFE` allowlist so
 * the Stage-5 driver stubs them by default. We DO invoke
 * `feedback:conversation-get`, which runs entirely
 * on the in-memory store factory, to prove the ambient boot is real (not just a
 * registration shell).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildSettings } from '@core/__tests__/builders/settingsBuilder';

import { bootRealAmbientServices } from './bootRealAmbientServices';
import type { AmbientServicesHandle } from './bootRealAmbientServices';

const FEEDBACK_CHANNELS = [
  'feedback:conversation-get',
  'feedback:conversation-rate',
  'feedback:conversation-dismiss',
] as const;

/**
 * Read the live registry via DYNAMIC import. `vi.resetModules()` (beforeEach)
 * forks the module graph, and the helper boots + the handlers register on the
 * post-reset graph; reading through a static top-level `@core/handlerRegistry`
 * import would observe a STALE, separate instance. Dynamic import here resolves
 * the same live graph.
 */
async function getRegisteredChannels(): Promise<readonly string[]> {
  const { getHandlerRegistry } = await import('@core/handlerRegistry');
  return getHandlerRegistry().listRegisteredChannels();
}

async function getHandler(channel: string) {
  const { getHandlerRegistry } = await import('@core/handlerRegistry');
  return getHandlerRegistry().get(channel);
}

/**
 * Resolve the live cached-singleton seam instances via dynamic import. These
 * seams (`scheduler`, `secureTokenStore`, `workspaceFileSystem`) cache a lazy
 * `_instance` that their `set*Factory()` setter clears on every call — so an
 * identity change across `teardown()` PROVES the setter was actually re-applied.
 * If teardown omitted one of these setters, `getX()` would keep returning the
 * SAME cached instance and the identity assertion goes RED.
 */
async function getAmbientSingletons(): Promise<{
  scheduler: unknown;
  secureTokenStore: unknown;
  workspaceFileSystem: unknown;
}> {
  const [{ getScheduler }, { getSecureTokenStore }, { getWorkspaceFileSystem }] =
    await Promise.all([
      import('@core/scheduler'),
      import('@core/secureTokenStore'),
      import('@core/workspaceFileSystem'),
    ]);
  return {
    scheduler: getScheduler(),
    secureTokenStore: getSecureTokenStore(),
    workspaceFileSystem: getWorkspaceFileSystem(),
  };
}

async function registerFeedbackAndLibrary(): Promise<void> {
  const { registerFeedbackHandlers } = await import('../../feedbackHandlers');
  const { registerLibraryHandlers } = await import('../../libraryHandlers');

  registerFeedbackHandlers();

  const settings = buildSettings({ coreDirectory: '/tmp/rebel-harness-stage3', spaces: [] });
  registerLibraryHandlers({
    getSettings: () => settings,
    getSettingsStore: () => ({ store: settings }),
  });
}

describe('bootRealAmbientServices', () => {
  let handle: AmbientServicesHandle | null = null;

  beforeEach(async () => {
    vi.resetModules();
    handle = await bootRealAmbientServices();
  });

  afterEach(async () => {
    await handle?.teardown();
    handle = null;
    vi.resetModules();
  });

  it('boots the ambient layer + registers feedback and library channels (no vi.mock wall)', async () => {
    await registerFeedbackAndLibrary();

    const channels = new Set(await getRegisteredChannels());

    for (const channel of FEEDBACK_CHANNELS) {
      expect(channels.has(channel), `${channel} registered`).toBe(true);
    }
    // A representative sample of library channels (the registrar registers many).
    expect(channels.has('library:list-files'), 'library:list-files registered').toBe(true);
    expect(channels.has('library:stat-file'), 'library:stat-file registered').toBe(true);
    expect(channels.size).toBeGreaterThan(FEEDBACK_CHANNELS.length);
  });

  it('runs a real handler over the in-memory store factory (ambient boot is genuine, not a shell)', async () => {
    const { registerFeedbackHandlers } = await import('../../feedbackHandlers');
    registerFeedbackHandlers();

    // feedback:conversation-get reads through the store factory the helper
    // installed (TestMemoryStore). A fresh store has no votes.
    const handler = await getHandler('feedback:conversation-get');
    expect(handler, 'feedback:conversation-get handler present').toBeDefined();

    const result = await handler!(null, { sessionId: 'harness-stage3-session' });
    expect(result).toEqual({ votes: [], dismissedAt: null });
  });

  /**
   * NON-VACUOUS teardown proof. The cross-test isolation pair below would pass
   * even if `teardown()` were a no-op (because `beforeEach` does
   * `vi.resetModules()` + reboots a fresh registry before test B reads it). This
   * block proves teardown ITSELF resets installed singletons, on the SAME module
   * graph (NO `vi.resetModules()` between the steps), so each assertion FAILS if
   * teardown forgot a factory or left registry state.
   */
  describe('teardown genuinely resets installed singletons (same-graph proof)', () => {
    it('teardown clears the handler registry on the SAME graph (no reset/reboot)', async () => {
      await registerFeedbackAndLibrary();
      expect((await getRegisteredChannels()).length).toBeGreaterThan(0);

      // Direct teardown on the same graph — if teardown forgot to re-install a
      // fresh registry (or were a no-op), these channels would persist.
      await handle!.teardown();

      expect(await getRegisteredChannels()).toEqual([]);
    });

    it('teardown re-applies the cached-singleton factory setters (instance identity changes)', async () => {
      // Force each cached `_instance` to materialise BEFORE teardown.
      const before = await getAmbientSingletons();

      await handle!.teardown();

      // Teardown re-called each `set*Factory()`, which clears the cached
      // `_instance`; the next `getX()` builds a NEW instance. Identity therefore
      // MUST differ. If teardown omitted any of these setters, that seam would
      // return the SAME cached instance and this assertion goes RED.
      const after = await getAmbientSingletons();

      expect(after.scheduler).not.toBe(before.scheduler);
      expect(after.secureTokenStore).not.toBe(before.secureTokenStore);
      expect(after.workspaceFileSystem).not.toBe(before.workspaceFileSystem);
    });
  });

  describe('isolation across tests (teardown + resetModules leaves no leakage)', () => {
    it('test A: registers feedback + library channels', async () => {
      await registerFeedbackAndLibrary();
      const channels = await getRegisteredChannels();
      expect(channels.length).toBeGreaterThan(0);
      expect(channels).toContain('feedback:conversation-get');
      // afterEach teardown runs here.
    });

    it('test B: starts with a clean, empty registry (no channels from test A)', async () => {
      // beforeEach re-booted a fresh registry; nothing has registered into it
      // in THIS test yet. If teardown leaked, test A's channels would be here.
      const channels = await getRegisteredChannels();
      expect(channels).toEqual([]);
    });
  });

  /**
   * STATEFUL store isolation across the required `vi.resetModules()` path.
   * `StoreFactory` has no cached instance (`storeFactory.ts:33-37`) and the
   * feedback store module holds its own lazy `_store`
   * (`conversationFeedbackStore.ts:67`). A write in test A must NOT be visible
   * in test B: `vi.resetModules()` drops the module-scoped `_store`, and the
   * reboot re-installs a FRESH `TestMemoryStore` factory. If either half were
   * missing (state leaked, or factory not re-installed), test B would observe
   * test A's `dismissedAt`.
   */
  describe('stateful store isolation across resetModules (no feedback-state leakage)', () => {
    const LEAK_SESSION = 'harness-store-isolation-session';

    it('test A: dismisses a feedback session (writes dismissedAt into the in-memory store)', async () => {
      const { registerFeedbackHandlers } = await import('../../feedbackHandlers');
      registerFeedbackHandlers();

      const dismiss = await getHandler('feedback:conversation-dismiss');
      expect(dismiss, 'feedback:conversation-dismiss handler present').toBeDefined();
      await dismiss!(null, { sessionId: LEAK_SESSION });

      // Same-graph read-back confirms the write actually landed (so test B's
      // null read is a real isolation signal, not a write that silently no-op'd).
      const get = await getHandler('feedback:conversation-get');
      const result = (await get!(null, { sessionId: LEAK_SESSION })) as {
        dismissedAt: number | null;
      };
      expect(result.dismissedAt).toBeTypeOf('number');
      // afterEach teardown + vi.resetModules() run here.
    });

    it('test B: the same session reads clean (test A\'s dismissedAt did not leak)', async () => {
      const { registerFeedbackHandlers } = await import('../../feedbackHandlers');
      registerFeedbackHandlers();

      const get = await getHandler('feedback:conversation-get');
      const result = (await get!(null, { sessionId: LEAK_SESSION })) as {
        dismissedAt: number | null;
      };
      expect(result).toEqual({ votes: [], dismissedAt: null });
    });
  });
});
