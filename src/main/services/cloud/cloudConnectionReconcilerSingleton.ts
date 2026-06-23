import { getBroadcastService, type BroadcastService } from '@core/broadcastService';
import { getErrorReporter, type ErrorReporter } from '@core/errorReporter';
import { createScopedLogger } from '@core/logger';
import {
  createCloudConnectionReconciler,
  type CloudInstanceSettingsAdapter,
} from '@core/services/cloud/cloudConnectionReconciler';
import { getSettings, updateSettings } from '@core/services/settingsStore';
import { captureKnownCondition } from '@core/sentry/captureKnownCondition';
import {
  captureCloudConnectionDegraded,
  captureCloudConnectionDegradedEscalated,
  recordCloudConnectionRecovered,
} from './cloudConnectionTelemetry';
import { cloudFailureCooldown } from './cloudFailureCooldown';
import { desktopCloudHealthProbe } from './cloudHealthProbeImpl';

/** Track whether we've already emitted a missing-capability telemetry event this session. */
let pressureCapabilityMissingLogged = false;

const deferredBroadcastService: BroadcastService = {
  // dynamic-broadcast-reviewed: pure deferred forwarder — re-emits the caller's `channel` through the
  // real broadcast service at call time. It introduces no channel of its own; whatever channel flows
  // through is declared at its own (literal/resolved-constant) emit-site.
  sendToAllWindows: (channel, ...args) => getBroadcastService().sendToAllWindows(channel, ...args),
  sendToFocusedWindow: (channel, ...args) => getBroadcastService().sendToFocusedWindow(channel, ...args),
};

const deferredErrorReporter: ErrorReporter = {
  captureException: (error, context) => getErrorReporter().captureException(error, context),
  captureMessage: (message, context) => getErrorReporter().captureMessage(message, context),
  addBreadcrumb: (breadcrumb) => getErrorReporter().addBreadcrumb(breadcrumb),
  captureExceptionWithScope: (error, scopeMutator) =>
    getErrorReporter().captureExceptionWithScope?.(error, scopeMutator),
};

const cloudInstanceSettingsAdapter: CloudInstanceSettingsAdapter = {
  read: () => getSettings().cloudInstance,
  update: async (merge) => {
    const current = getSettings().cloudInstance;
    if (!current) return;
    updateSettings({ cloudInstance: { ...current, ...merge } });
  },
};

function getCloudInstanceObservabilityExtra(): { cloudUrl?: string; flyAppName?: string } {
  const cloudInstance = getSettings().cloudInstance;
  return {
    cloudUrl: cloudInstance?.cloudUrl,
    flyAppName: cloudInstance?.flyAppName,
  };
}

// Registry-owned connection telemetry (Stage 3 of
// docs/plans/260610_improve-sentry-noise/PLAN.md): degraded/escalated go
// through captureKnownCondition (registry-owned level + fingerprint, ledger
// mirror); recovered is success telemetry — ledger + breadcrumb only, never
// a Sentry issue. The helpers are fail-safe and notifyObservabilityHook
// try/catches as a second layer.
cloudFailureCooldown.setObservabilityHooks({
  onDegradedEnter: (context) => {
    captureCloudConnectionDegraded(context, getCloudInstanceObservabilityExtra());
  },
  onDegradedEscalated: (context) => {
    captureCloudConnectionDegradedEscalated(context, getCloudInstanceObservabilityExtra());
  },
  onDegradedExit: (context) => {
    recordCloudConnectionRecovered(context, getCloudInstanceObservabilityExtra());
  },
});

export const cloudConnectionReconciler = createCloudConnectionReconciler({
  settings: cloudInstanceSettingsAdapter,
  broadcastService: deferredBroadcastService,
  errorReporter: deferredErrorReporter,
  logger: createScopedLogger({ service: 'cloud-reconciler' }),
  probe: {
    probe: async (args) => {
      const result = await desktopCloudHealthProbe.probe(args);
      // Once-per-session telemetry when the cloud doesn't expose pressure capability.
      if (!pressureCapabilityMissingLogged && result.ok && !result.pressure) {
        const cloudVersion =
          typeof result.raw === 'object' && result.raw !== null
            ? (result.raw as Record<string, unknown>).buildCommit
            : undefined;
        // Ledger-only telemetry (registry sink policy) — was a raw info
        // captureMessage; see 260610 improve-sentry-noise Stage 5.
        captureKnownCondition(
          'cloud_pressure_capability_missing',
          { extra: { cloud_version: cloudVersion, ...getCloudInstanceObservabilityExtra() } },
          new Error('cloud_pressure_capability_missing'),
        );
        pressureCapabilityMissingLogged = true;
      }
      return result;
    },
  },
  cooldown: cloudFailureCooldown,
});
