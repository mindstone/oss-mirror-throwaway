/**
 * Plugin Module Registry
 *
 * Populates `window.__REBEL_MODULES__` so compiled plugins can resolve
 * `require("react")`, `require("@rebel/plugin-api")`, etc. at runtime.
 *
 * Call `initPluginModuleRegistry()` once at app startup.
 *
 * @see docs/plans/260322_plugin_extension_system.md
 */

import React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import * as pluginUi from '../ui';

declare global {
  // eslint-disable-next-line @typescript-eslint/naming-convention -- global window property name required by plugin runtime
  var __REBEL_MODULES__: Record<string, unknown> | undefined;
  interface Window {
    __REBEL_MODULES__?: Record<string, unknown>;
  }
}

function createPlaceholderPluginApi() {
  return {
    useRebel: () => {
      const navigate = Object.assign(
        (target: string) => console.warn('[plugin-api placeholder] navigate:', target),
        {
          toSettings: (_tab?: string) => { /* no-op placeholder */ },
          toAutomations: () => { /* no-op placeholder */ },
          toTasks: () => { /* no-op placeholder */ },
          toLibrary: (_filePath?: string) => { /* no-op placeholder */ },
          toPlugin: (_pluginId: string) => { /* no-op placeholder */ },
        }
      );
      return {
        conversations: {
          open: (id: string) => console.warn('[plugin-api placeholder] open conversation:', id),
          list: () => [],
          toggleDone: (_id: string) => { /* no-op placeholder */ },
          star: (_id: string) => { /* no-op placeholder */ },
          rename: (_id: string, _title: string) => { /* no-op placeholder */ },
          sendMessage: async (_sessionId: string, _message: string) => ({ ok: true as const }),
          startConversation: async (_message: string) => ({ ok: true as const, sessionId: 'placeholder' }),
          create: (_options?: { draftText?: string; navigate?: boolean }) => 'placeholder-id',
          getTranscript: async (_sessionId: string, _options?: { limit?: number }) => ({ ok: true as const, messages: [] }),
        },
        skills: {
          write: async () => ({ ok: false, error: 'Plugin API not ready yet.' }),
        },
        inbox: {
          addItem: async () => ({ ok: true as const, itemId: 'placeholder-item-id' }),
          getItems: async () => [],
        },
        automations: {
          create: async () => ({ automationId: '', ok: false, error: 'Plugin API not ready yet.' }),
          list: async () => [],
        },
        navigate,
        ui: {
          showToast: (_message: string) => { /* no-op placeholder */ },
        },
        lifecycle: {
          registerInterval: (cb: () => void, ms: number) => setInterval(cb, ms),
          registerSubscription: (_unsub: () => void) => { /* no-op placeholder */ },
        },
      };
    },
    usePluginRoute: () => ({ pluginId: 'placeholder', params: {} }),
    useActiveSession: () => null,
    useConversation: (_id: string) => null,
    useConversations: () => ({ data: [], isLoading: false }),
    usePluginStorage: <T,>(key: string, defaultValue: T): [T, (value: T) => void] => {
      console.warn('[plugin-api placeholder] usePluginStorage:', key);
      return [defaultValue, () => { /* no-op placeholder */ }];
    },
    usePluginStorageWithVersion: <T,>(key: string, defaultValue: T, _options: { schemaVersion: number; migrate: (oldVersion: number, oldData: unknown) => T }): [T, (value: T) => void] => {
      console.warn('[plugin-api placeholder] usePluginStorageWithVersion:', key);
      return [defaultValue, () => { /* no-op placeholder */ }];
    },
    useMemorySearch: () => ({ results: [], isLoading: false, error: null, status: 'ok' as const }),
    useTopics: () => ({ topics: [], isLoading: false, error: null }),
    useEntities: () => ({ entities: [], isLoading: false, error: null }),
    useTopicContent: () => ({ content: null, isLoading: false, error: null }),
    useSkillFile: () => ({ content: null, frontmatter: null, isLoading: false, error: null }),
    useMeetings: () => ({ meetings: [], isStale: false, isLoading: false, error: null, refresh: () => { /* no-op placeholder */ } }),
    useClipboard: () => ({ copyText: async () => false }),
    useRebelEvent: (_eventType: string, _callback: (payload: unknown) => void) => { /* no-op placeholder */ },
    usePreTurnHook: (_options: { getContext: () => string | null; priority?: number }) => { /* no-op placeholder */ },
    usePostTurnHook: (_callback: (turnResult: { sessionId: string; turnId: string; assistantText: string; toolsUsed: string[] }) => void) => { /* no-op placeholder */ },
    useExternalFetch: () => ({ data: null, isLoading: false, error: null, refetch: () => { /* no-op placeholder */ } }),
  };
}

function createPluginUiModule() {
  return {
    ...pluginUi,
    // Explicit rich visualization aliases for Stage C2.
    BarChart: pluginUi.BarChart,
    LineChart: pluginUi.LineChart,
    PieChart: pluginUi.PieChart,
    DataTable: pluginUi.DataTable,
    IframeView: pluginUi.IframeView,
  };
}

export function initPluginModuleRegistry(): void {
  globalThis.__REBEL_MODULES__ = {
    'react': React,
    'react/jsx-runtime': jsxRuntime,
    'react/jsx-dev-runtime': jsxRuntime,
    '@rebel/plugin-api': createPlaceholderPluginApi(),
    '@rebel/plugin-ui': createPluginUiModule(),
  };
}

export function updatePluginModule(name: string, moduleExports: unknown): void {
  if (!globalThis.__REBEL_MODULES__) initPluginModuleRegistry();
  const modules = globalThis.__REBEL_MODULES__;
  if (!modules || Object.isFrozen(modules)) {
    // Already frozen (e.g. HMR re-run in dev mode) — skip silently.
    // The real plugin API was injected before the freeze; re-injection is unnecessary.
    return;
  }
  modules[name] = moduleExports;
}

/**
 * Expose plugin registration functions globally so Rebel AI can call them
 * at runtime via tool use (electron_evaluate / bash).
 *
 * Accepts the functions directly to avoid CJS `require()` in Vite renderer code.
 */
export function exposePluginRegistrationApi(
  registerFn: (manifest: unknown, source: string) => unknown,
  unregisterFn: (pluginId: string) => boolean,
): void {
  (globalThis as Record<string, unknown>).__REBEL_PLUGINS__ = {
    register: registerFn,
    unregister: unregisterFn,
  };
}

/**
 * Freeze both global plugin registries to prevent mutation by plugin code.
 *
 * Must be called AFTER all initialization is complete — specifically after
 * `updatePluginModule('@rebel/plugin-api', ...)` injects the real plugin API
 * and after `exposePluginRegistrationApi()` sets up __REBEL_PLUGINS__.
 *
 * This is Layer 1 of the security hardening (defense-in-depth).
 */
export function freezeModuleRegistries(): void {
  if (globalThis.__REBEL_MODULES__) {
    Object.freeze(globalThis.__REBEL_MODULES__);
  }
  const plugins = (globalThis as Record<string, unknown>).__REBEL_PLUGINS__;
  if (plugins) {
    Object.freeze(plugins);
  }
}
