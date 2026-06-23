/**
 * mountApp — shared full-App render harness (Tier A).
 *
 * Productionizes the proven render-harness spike (see
 * docs/plans/260529_apptsx-hardening/subagent_reports/260529_230200_researcher-harness-feasibility-spike.md).
 *
 * Two responsibilities:
 *
 *  1. `installPreloadBridges(overrides?)` — seed ALL `window.*Api` preload
 *     bridges (the mounted App + ~50 hooks + children touch ~69 distinct
 *     `window.*Api` names) plus the bare `window.api` / `window.electronEnv` /
 *     `window.emergencyApi` globals with SAFE DEFAULTS. Defaults:
 *       - method calls resolve `Promise.resolve(undefined)`
 *       - `on*` / `subscribe*` handlers return an unsubscribe fn `() => {}`
 *       - returned functions support `.bind` (they are real functions)
 *     Tests inject faithful per-bridge `overrides` for the handful of bridges
 *     their flow actually dereferences.
 *
 *     ITER-6 LESSON (load-bearing): do NOT use a catch-all *value* Proxy as the
 *     resolved value of a bridge method. Some hooks string-coerce the resolved
 *     value (e.g. useFeatureGate.ts) and a Proxy throws "Cannot convert object
 *     to primitive value". `undefined`-resolve is the correct default for a
 *     bare smoke. The per-bridge object itself IS a Proxy (so any method name
 *     is callable), but every method it exposes resolves a primitive-safe
 *     `undefined`, never another Proxy.
 *
 *  2. `mountApp()` — mount the real `<App/>` inside the production provider
 *     stack from `main.tsx` (HotkeysProvider > ToastProvider >
 *     MeetingStatusProvider > FlowPanelsProvider) via
 *     `ReactDOMClient.createRoot` + `act()`, returning
 *     `{ container, unmount, mountError }`.
 *
 * NOTE on AtlasCanvas: the WebGL/WebGPU leaf `AtlasCanvas` statically imports
 * `three` / `react-force-graph-*`, which crash at module-eval under happy-dom.
 * It is the ONLY such leaf in App's static graph. It MUST be neutralised with a
 * `vi.mock` IN THE TEST FILE (vi.mock hoists per-file; a vi.mock placed in this
 * imported harness module does NOT hoist into the test). See App.smoke.test.tsx.
 */

import React, { act as reactAct } from 'react';
import * as ReactDOMClient from 'react-dom/client';
import { HotkeysProvider } from 'react-hotkeys-hook';
import App from '@renderer/App';
import { ToastProvider } from '@renderer/components/ui';
import { MeetingStatusProvider } from '@renderer/contexts/MeetingStatusContext';
import { FlowPanelsProvider } from '@renderer/features/flow-panels/FlowPanelsProvider';

// React act() environment flag.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ---------------------------------------------------------------------------
// Preload-bridge surface.
//
// Enumerated via `grep -rhoE 'window\.[a-zA-Z]+Api' src/renderer | sort -u`
// (the mounted tree's bridge census from the spike). Keep additive: a new
// `window.*Api` bridge can be added here without breaking existing tests.
// ---------------------------------------------------------------------------
export const PRELOAD_BRIDGE_NAMES = [
  'api', // bare window.api (logEvent et al.)
  'agentApi',
  'appApi',
  'appBridgeApi',
  'authApi',
  'automationsApi',
  'bugReportApi',
  'calendarApi',
  'cloudApi',
  'cloudContinuityApi',
  'codexApi',
  'communityEventsApi',
  'communityVideoRecsApi',
  'contributionApi',
  'dailySparkApi',
  'dashboardApi',
  'demoApi',
  'diagnosticsApi',
  'discourseApi',
  'emergencyApi',
  'errorApi',
  'errorRecoveryApi',
  'exportApi',
  'feedbackApi',
  'fileApi',
  'fileConversationApi',
  'focusApi',
  'foldersApi',
  'githubApi',
  'googleWorkspaceApi',
  'heroChoiceApi',
  'htmlPreviewTrustApi',
  'hubspotApi',
  'inboundTriggersApi',
  'inboxApi',
  'libraryApi',
  'localInferenceApi',
  'localSttApi',
  'mcpAppsApi',
  'meetingBotApi',
  'memoryApi',
  'microsoftApi',
  'miscApi',
  'openRouterApi',
  'operatorsApi',
  'permissionsApi',
  'physicalRecordingApi',
  'plaudApi',
  'pluginsApi',
  'safetyActivityLogApi',
  'safetyApi',
  'safetyPromptApi',
  'scratchpadApi',
  'searchApi',
  'sessionsApi',
  'settingsApi',
  'skillHistoryApi',
  'slackApi',
  'subscriptionApi',
  'systemHealthApi',
  'tasksApi',
  'todoistApi',
  'usageApi',
  'useCaseLibraryApi',
  'userEngagementApi',
  'userTasksApi',
  'versionApi',
  'voiceApi',
] as const;

/** Names that, when a method is invoked, should return an unsubscribe fn
 *  synchronously rather than a Promise (event-subscription handlers). */
function isSubscriptionMethod(name: string | symbol): boolean {
  if (typeof name !== 'string') return false;
  return (
    name.startsWith('on') ||
    name.startsWith('subscribe') ||
    name.startsWith('addListener') ||
    name.startsWith('listen')
  );
}

const UNSUBSCRIBE = (): void => {
  /* no-op unsubscribe */
};

/**
 * Faithful minimal return shapes for the small set of bridge methods whose
 * resolved value is dereferenced in a mount-effect WITHOUT a `.catch`, so an
 * `undefined` resolve would surface as an *unhandled* promise rejection (a hard
 * CI error, not just the benign caught "Failed to load…" log the plan tolerates).
 *
 * Keyed `"<bridge>.<method>"`. Values MUST be primitive-safe (plain objects /
 * primitives, NEVER a Proxy — iter-6: some consumers string-coerce). Keep this
 * list MINIMAL: it is the per-bridge fidelity knob, only for genuinely-uncaught
 * dereferences observed at mount, not a place to model full bridge contracts.
 */
const FAITHFUL_DEFAULTS: Record<string, () => unknown> = {
  // useDemoMode.ts:15 — `window.demoApi.status().then(s => s.active)` (no .catch).
  'demoApi.status': () => ({ active: false }),
};

/**
 * Build a per-bridge Proxy for a given bridge name. Property access yields a
 * real function:
 *  - subscription-style names → returns the unsubscribe fn
 *  - a name with a FAITHFUL_DEFAULTS entry → resolves that primitive-safe shape
 *  - everything else → resolves `undefined`
 * The returned value is always a real function (supports `.bind`, `.call`), and
 * method results are primitive-safe — NEVER a Proxy (iter-6).
 */
function makeBridge(bridgeName: string): Record<string, unknown> {
  const cache = new Map<string | symbol, unknown>();
  return new Proxy(
    {},
    {
      get(_target, prop) {
        // Let common object/Promise introspection behave normally so hooks
        // that probe `typeof bridge.x === 'function'` see a function, and
        // `'x' in bridge` style checks resolve.
        if (prop === Symbol.toPrimitive) return undefined;
        if (prop === 'then') return undefined; // not a thenable
        if (cache.has(prop)) return cache.get(prop);
        const subscription = isSubscriptionMethod(prop);
        const faithful =
          typeof prop === 'string' ? FAITHFUL_DEFAULTS[`${bridgeName}.${prop}`] : undefined;
        const fn = (..._args: unknown[]): unknown => {
          if (subscription) return UNSUBSCRIBE;
          if (faithful) return Promise.resolve(faithful());
          return Promise.resolve(undefined);
        };
        cache.set(prop, fn);
        return fn;
      },
      has() {
        return true;
      },
    },
  ) as Record<string, unknown>;
}

export interface InstallPreloadBridgesResult {
  /** Restore window to its prior bridge state. */
  restore: () => void;
}

/**
 * Seed all preload bridges on `window` with safe defaults, optionally merging
 * per-bridge faithful overrides for the bridges a flow exercises.
 *
 * `overrides` maps a bridge name (e.g. `'safetyApi'`) to a partial object whose
 * own properties take precedence over the safe-default proxy. The merged bridge
 * is itself a Proxy: an override's explicit keys win; any other accessed key
 * falls through to the safe default.
 */
export function installPreloadBridges(
  overrides: Partial<Record<string, Record<string, unknown>>> = {},
): InstallPreloadBridgesResult {
  const win = window as unknown as Record<string, unknown>;
  const saved = new Map<string, { had: boolean; value: unknown }>();

  for (const name of PRELOAD_BRIDGE_NAMES) {
    saved.set(name, { had: name in win, value: win[name] });
    const base = makeBridge(name);
    const override = overrides[name];
    if (override) {
      win[name] = new Proxy(base, {
        get(target, prop) {
          if (typeof prop === 'string' && Object.prototype.hasOwnProperty.call(override, prop)) {
            return override[prop];
          }
          return (target as Record<string | symbol, unknown>)[prop];
        },
        has(target, prop) {
          if (typeof prop === 'string' && Object.prototype.hasOwnProperty.call(override, prop)) {
            return true;
          }
          return prop in (target as object);
        },
      });
    } else {
      win[name] = base;
    }
  }

  // `electronEnv` is read as plain data (buildChannel, runtimeConfig), not as a
  // method bridge — seed a safe-default object. Tests may override.
  saved.set('electronEnv', { had: 'electronEnv' in win, value: win['electronEnv'] });
  win['electronEnv'] = {
    buildChannel: 'dev',
    runtimeConfig: {},
    ...(overrides['electronEnv'] ?? {}),
  };

  return {
    restore: () => {
      for (const [name, prev] of saved) {
        if (prev.had) win[name] = prev.value;
        else delete win[name];
      }
    },
  };
}

export interface MountAppResult {
  container: HTMLElement;
  unmount: () => void;
  /** `null` when the App mounted cleanly; the thrown error otherwise. */
  mountError: unknown;
}

/**
 * Mount the real `<App/>` inside the production provider stack from main.tsx.
 *
 * Providers are imported here (not statically re-exported) so the harness owns
 * the exact wrapping order. AtlasCanvas MUST be vi.mock'd in the calling test
 * file before this runs (see module header).
 */
export function mountApp(): MountAppResult {
  const container = document.createElement('div');
  container.id = 'root';
  document.body.appendChild(container);

  const root = ReactDOMClient.createRoot(container);
  let mountError: unknown = null;

  const tree = (
    <HotkeysProvider initiallyActiveScopes={['*']}>
      <ToastProvider>
        <MeetingStatusProvider>
          <FlowPanelsProvider>
            <App />
          </FlowPanelsProvider>
        </MeetingStatusProvider>
      </ToastProvider>
    </HotkeysProvider>
  );

  try {
    reactAct(() => {
      root.render(tree);
    });
  } catch (err) {
    mountError = err;
  }

  const unmount = (): void => {
    try {
      reactAct(() => {
        root.unmount();
      });
    } finally {
      if (container.parentNode) container.parentNode.removeChild(container);
    }
  };

  return { container, unmount, mountError };
}
