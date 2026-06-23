import type { ErrorReporter } from '@core/errorReporter';
import { getErrorReporter } from '@core/errorReporter';
import type { HandlerRegistry } from '@core/handlerRegistry';
import { createScopedLogger } from '@core/logger';
import { getChannelMetadata, type ChannelMetadata } from '@shared/ipc/channelMetadata';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';
import { invariant } from '@shared/utils/invariant';

const log = createScopedLogger({ service: 'handlerPresenceInvariant' });

export type HandlerPresenceMode = 'fail-hard' | 'production-degrade';

export type IpcDisabledError = {
  ok: false;
  error: 'IPC_DISABLED';
  code: 'IPC_DISABLED';
  channel: string;
  message: string;
};

type HandlerPresenceRegistry = Pick<HandlerRegistry, 'register' | 'listRegisteredChannels'>;
type HandlerPresenceReporter = Pick<ErrorReporter, 'addBreadcrumb' | 'captureMessage'>;

type ChannelDefinitionLike = { type?: string };

export function getHandlerPresenceMode({
  isPackaged,
  ci,
}: {
  isPackaged: boolean;
  ci: boolean;
}): HandlerPresenceMode {
  if (!isPackaged || ci) {
    return 'fail-hard';
  }
  return 'production-degrade';
}

/**
 * Truthy values used by common CI providers in `process.env.CI`.
 *
 * - GitHub Actions / CircleCI / Buildkite / Vercel / Netlify / GitLab CI: `'true'`
 * - Jenkins (when configured) / TeamCity: often `'1'` or `'true'`
 * - Travis CI: `'true'`
 *
 * The narrow `=== '1'` predicate the initial Stage 4 implementation used
 * misclassified packaged CI runs on GitHub Actions as `production-degrade`
 * instead of `fail-hard` (codex BLOCK, behavioral-safety AT-RISK, operational
 * HIGH). This helper covers both common shapes plus GHA's secondary signal.
 */
export function isCiEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  const ciValue = env.CI ?? '';
  if (ciValue === '1' || ciValue.toLowerCase() === 'true') return true;
  if ((env.GITHUB_ACTIONS ?? '').toLowerCase() === 'true') return true;
  return false;
}

export function isInvariantDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.REBEL_HANDLER_PRESENCE_INVARIANT_DISABLED === '1';
}

/**
 * A channel is skipped from the handler-presence assertion (and, by reuse, from
 * the IPC-contract-harness coverage guard) when it is NOT expected to be
 * registered through the `registerHandler` chokepoint at boot: it is a
 * `RAW_IPC_BYPASS_CHANNELS`/e2e direct-`ipcMain.handle` bypass, lazily
 * registered, not required at boot, or feature-flagged. NOTE the precise
 * semantics (Stage-2 carry-forward): "skipped here" means "not registered
 * through the chokepoint," NOT "absent from `allChannels`" — many bypass
 * channels ARE contract-backed entries in `allChannels`.
 *
 * Exported so the Stage-7 harness coverage guard reuses the REAL predicate
 * rather than reaching into a private (or maintaining a drifting duplicate).
 */
export function shouldSkipFromPresenceAssertion(metadata: ChannelMetadata): boolean {
  return (
    metadata.bypass
    || metadata.lazyRegistered
    || !metadata.requiredAtBoot
    || Boolean(metadata.featureFlag)
  );
}

export function isInvokeChannel(definition: unknown): boolean {
  if (!definition || typeof definition !== 'object') return false;
  const def = definition as ChannelDefinitionLike;
  return def.type === 'invoke';
}

export function createIpcDisabledError(channel: string): IpcDisabledError {
  return {
    ok: false,
    error: 'IPC_DISABLED',
    code: 'IPC_DISABLED',
    channel,
    message: `IPC channel "${channel}" is temporarily unavailable in this build.`,
  };
}

type MissingChannelEntry = { channel: string; metadata: ChannelMetadata };

function reportMissingChannelsBatch({
  reporter,
  missing,
  mode,
}: {
  reporter: HandlerPresenceReporter;
  missing: ReadonlyArray<MissingChannelEntry>;
  mode: HandlerPresenceMode;
}): void {
  const channels = missing.map(({ channel }) => channel);
  const summary = {
    mode,
    invariant: 'ipc_handler_presence',
    missingChannelCount: missing.length,
    missingChannels: channels,
    perPolicyBreakdown: missing.reduce<Record<string, number>>((acc, { metadata }) => {
      acc[metadata.productionFailurePolicy] = (acc[metadata.productionFailurePolicy] ?? 0) + 1;
      return acc;
    }, {}),
  };

  try {
    reporter.addBreadcrumb({
      category: 'boot.ipc-handler-presence',
      message: `IPC handler-presence invariant: ${missing.length} required channel(s) missing`,
      level: 'warning',
      data: summary,
    });
  } catch (error) {
    ignoreBestEffortCleanup(error, {
      operation: 'handlerPresenceInvariant.addBreadcrumb',
      reason: 'errorReporter breadcrumb emission is best-effort in production-degrade mode',
      severity: 'debug',
    });
  }

  try {
    reporter.captureMessage('IPC handler-presence invariant fired in production', {
      level: 'warning',
      tags: {
        area: 'ipc-handler-presence',
        mode,
        invariant: 'ipc_handler_presence',
      },
      extra: summary,
      fingerprint: ['ipc-handler-presence', mode, String(missing.length)],
    });
  } catch (error) {
    ignoreBestEffortCleanup(error, {
      operation: 'handlerPresenceInvariant.captureMessage',
      reason: 'errorReporter captureMessage is best-effort in production-degrade mode',
      severity: 'debug',
    });
  }
}

export function assertHandlerPresence({
  allChannels,
  registry,
  mode,
  getMetadata = getChannelMetadata,
  errorReporter = getErrorReporter(),
  disabledByEnv = isInvariantDisabled(),
}: {
  allChannels: Readonly<Record<string, unknown>>;
  registry: HandlerPresenceRegistry;
  mode: HandlerPresenceMode;
  getMetadata?: (channel: string) => ChannelMetadata;
  errorReporter?: HandlerPresenceReporter;
  disabledByEnv?: boolean;
}): void {
  if (disabledByEnv) {
    log.warn(
      { mode, reason: 'REBEL_HANDLER_PRESENCE_INVARIANT_DISABLED=1' },
      'IPC handler-presence invariant skipped via emergency env override',
    );
    return;
  }

  const registeredChannels = new Set(registry.listRegisteredChannels());
  const missingRequiredChannels: MissingChannelEntry[] = [];

  for (const [channel, definition] of Object.entries(allChannels)) {
    // Stage 4 fix-up batch (4-reviewer convergent HIGH): the invariant is
    // HandlerRegistry-scoped. Sync channels register via `ipcMain.on` and
    // are intentionally outside the registry's surface; gating them through
    // listRegisteredChannels() would false-positive in dev/CI (gpt5.5-high
    // HIGH: `sessions:save-sync` / `folders:save-sync`).
    if (!isInvokeChannel(definition)) {
      continue;
    }
    const metadata = getMetadata(channel);
    if (shouldSkipFromPresenceAssertion(metadata)) {
      continue;
    }
    if (!registeredChannels.has(channel)) {
      missingRequiredChannels.push({ channel, metadata });
    }
  }

  if (missingRequiredChannels.length === 0) {
    return;
  }

  if (mode === 'fail-hard') {
    log.error(
      {
        mode,
        missingChannelCount: missingRequiredChannels.length,
        missingChannels: missingRequiredChannels.map(({ channel }) => channel),
        registeredChannelCount: registeredChannels.size,
      },
      'IPC handler-presence invariant failed (fail-hard)',
    );
    invariant(
      false,
      `IPC handler presence invariant failed: ${missingRequiredChannels.length} required channel(s) missing after resolveIpcHandlersReady(). To bypass locally during emergency debug, set REBEL_HANDLER_PRESENCE_INVARIANT_DISABLED=1. To resolve permanently: (a) register the handler, (b) mark bypass via channelMetadataOverrides with an audit doc entry, or (c) mark lazyRegistered/featureFlag with rationale.`,
      {
        mode,
        missingChannels: missingRequiredChannels.map(({ channel, metadata }) => ({
          channel,
          productionFailurePolicy: metadata.productionFailurePolicy,
        })),
        registeredChannelCount: registeredChannels.size,
      },
    );
    return;
  }

  // production-degrade: batch the observability emit (per operational HIGH +
  // codex LOW + behavioral-safety MEDIUM Sentry-storm concerns).
  log.warn(
    {
      mode,
      missingChannelCount: missingRequiredChannels.length,
      missingChannels: missingRequiredChannels.map(({ channel }) => channel),
      registeredChannelCount: registeredChannels.size,
    },
    'IPC handler-presence invariant fired (production-degrade)',
  );
  reportMissingChannelsBatch({
    reporter: errorReporter,
    missing: missingRequiredChannels,
    mode,
  });

  const failHardEntries = missingRequiredChannels.filter(
    ({ metadata }) => metadata.productionFailurePolicy === 'fail-hard',
  );
  if (failHardEntries.length > 0) {
    invariant(
      false,
      `IPC handler presence invariant failed: ${failHardEntries.length} channel(s) with productionFailurePolicy='fail-hard' are missing`,
      {
        mode,
        channels: failHardEntries.map(({ channel }) => channel),
      },
    );
    return;
  }

  for (const { channel, metadata } of missingRequiredChannels) {
    if (metadata.productionFailurePolicy === 'degrade-channel') {
      // The synthetic IpcDisabledError shape only matches channels whose
      // response contract is a discriminated-union with `ok: false` branch.
      // No channel in the current overrides uses `degrade-channel` (verified
      // by Stage 4 fix-up batch). When the first channel adopts this policy,
      // verify its response schema accepts the IpcDisabledError shape (or
      // adapt the synthetic per-channel). See known-limitations doc.
      registry.register(channel, async () => createIpcDisabledError(channel));
    }
    // sentry-only: already captured via reportMissingChannelsBatch above. No
    // synthetic handler — Electron's default "No handler registered"
    // rejection at renderer is the intended semantics (the invariant's job
    // is to OBSERVE missing channels, not to silently substitute behavior
    // that could itself break consumers).
  }
}
