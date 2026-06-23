import type { IpcMainInvokeEvent } from 'electron';
import { getBroadcastService } from '@core/broadcastService';
import { getCodexAuthProvider } from '@core/codexAuth';
import { getHandlerRegistry } from '@core/handlerRegistry';
import { createScopedLogger } from '@core/logger';
import type { ActiveProvider, AppSettings, ModelSettings } from '@shared/types';
import type { IpcRequestOf, IpcResponseOf } from '@shared/ipc/contracts';
import { resolveModelSettings } from '@shared/utils/settingsUtils';
import { planProviderSwitch } from '@shared/utils/providerSwitch';
import { isProfileReference, profileReferenceId } from '@core/rebelCore/providerRouteDecision';
import { agentTurnRegistry } from '../services/agentTurnRegistry';
import { registerHandler } from './utils/registerHandler';

const log = createScopedLogger({ service: 'agentErrorHandlers' });

type ApplyResolutionRequest = IpcRequestOf<'error:apply-resolution'>;
type ApplyResolutionResponse = IpcResponseOf<'error:apply-resolution'>;
type ResolutionAction = ApplyResolutionRequest['action'];
type ResolutionProvider = NonNullable<NonNullable<ApplyResolutionRequest['payload']>['provider']>;
type ApplyResolutionFailureReason = NonNullable<ApplyResolutionResponse['reason']>;

const inFlightApplyRequests = new Set<string>();

export interface AgentErrorHandlerDeps {
  getSettings: () => AppSettings;
  /**
   * 260622 Stage 4: re-provision the Chief-of-Staff README from the starter
   * template (the `recreate-chief-of-staff` recovery action). Injected so the
   * handler stays free of the Electron-specific provisioning wiring
   * (`ensureChiefOfStaffSpace` + symlink setup) and is unit-testable. Resolves
   * when the README is back on disk; rejects on a genuine provisioning failure
   * (surfaced to the user as a "couldn't apply" toast).
   */
  recreateChiefOfStaff?: () => Promise<void>;
}

function response(
  appliedAction: ResolutionAction,
  ok: boolean,
  reason?: ApplyResolutionFailureReason,
): ApplyResolutionResponse {
  return { ok, appliedAction, ...(reason ? { reason } : {}) };
}

function isReferencedTurnAlive(turnId: string): boolean {
  const controller = agentTurnRegistry.getActiveTurnController(turnId);
  return !!controller && !controller.signal.aborted;
}

function shouldRefuseWhileTurnAlive(action: ResolutionAction): boolean {
  return (
    action === 'switch-model' ||
    action === 'switch-provider' ||
    action === 'retry' ||
    // The Chief-of-Staff recovery verbs also re-run THE failed turn, so they
    // must not apply while that specific (referenced) turn is still alive.
    action === 'recreate-chief-of-staff' ||
    action === 'proceed-without-chief-of-staff'
  );
}

/**
 * Whether to ALSO refuse when an UNRELATED turn is active (the `stale_turn`
 * guard). The model-switch / retry verbs refuse here because a global settings
 * write or an immediate resend would race another live turn. The Chief-of-Staff
 * recovery verbs are EXCLUDED: `recreate` only provisions a file and
 * `proceed-without` sets a per-turn bypass flag on a NEW resend — neither
 * conflicts with an unrelated background turn, and refusing would dead-end
 * recovery (the renderer clears the banner on `stale_turn`). Review F3.
 */
function shouldRefuseWhileAnotherTurnActive(action: ResolutionAction): boolean {
  return (
    action === 'switch-model' ||
    action === 'switch-provider' ||
    action === 'retry'
  );
}

function isAnotherTurnActive(turnId: string): boolean {
  return agentTurnRegistry
    .getActiveTurnIds()
    .some((activeTurnId) => activeTurnId !== turnId);
}

function toActiveProvider(provider: ResolutionProvider | undefined): ActiveProvider | null {
  switch (provider) {
    case 'anthropic':
    case 'codex':
    case 'openrouter':
      return provider;
    case 'openai':
    case undefined:
      return null;
  }
}

function codexConnected(): boolean {
  try {
    return getCodexAuthProvider().isConnected();
  } catch (err) {
    log.debug({ err }, 'Codex auth provider unavailable while applying error resolution');
    return false;
  }
}

async function updateSettingsViaChannel(nextSettings: AppSettings): Promise<AppSettings> {
  return await getHandlerRegistry().invokeWithRouting(
    'settings:update',
    undefined,
    nextSettings,
  ) as AppSettings;
}

function broadcastSettingsExternalUpdate(): void {
  try {
    getBroadcastService().sendToAllWindows('settings:external-update');
  } catch (err) {
    log.debug({ err }, 'Settings external update broadcast unavailable');
  }
}

type SwitchModelFailedRole = NonNullable<
  NonNullable<ApplyResolutionRequest['payload']>['failedRole']
>;

function buildSwitchedModelSettings(
  settings: AppSettings,
  model: string,
  failedRole?: SwitchModelFailedRole,
): ModelSettings | null {
  const base: ModelSettings = {
    apiKey: null,
    oauthToken: null,
    authMethod: 'api-key',
    permissionMode: 'bypassPermissions',
    executablePath: null,
    planMode: false,
    extendedContext: true,
    thinkingEffort: 'high',
    ...resolveModelSettings(settings),
    model,
    workingProfileId: undefined,
  };

  // Gateway-profile recovery: a `profile:<id>` target pins the working AND thinking
  // profile so the turn routes through that profile's provider (e.g. a custom
  // OpenAI-compatible gateway that proxies the model) — instead of routing the bare
  // model to the active provider, which is exactly what just failed. The bare model
  // setting is resolved from the profile so role resolution and UI stay consistent.
  if (isProfileReference(model)) {
    const profileId = profileReferenceId(model) ?? '';
    const profile = settings.localModel?.profiles?.find((p) => p.id === profileId);
    if (profile?.model) {
      return {
        ...base,
        model: profile.model,
        workingProfileId: profileId,
        thinkingModel: profile.model,
        thinkingProfileId: profileId,
        planMode: false,
      };
    }
    // Review F2: an unknown profile id (profile deleted between rendering the banner
    // and clicking it) must NOT fall through and persist a bare 'profile:<id>' model.
    // Fail closed — the caller turns this into an invalid_payload no-op.
    log.warn(
      { profileId },
      'switch-model recovery referenced an unknown profile id; refusing to persist a profile ref as the bare model',
    );
    return null;
  }

  // FOX-3494 (round-2 M1): `failedRole` is set ONLY by the claude-under-ChatGPT-Pro
  // recovery (classifyClaudeUnderCodex → switchModelAction). When present, the
  // conversation must collapse to a codex-servable GPT model across BOTH the
  // working AND thinking slots, regardless of which role failed first. Clearing
  // only the working slot (or only clearing thinking on a planning failure) is
  // not enough: resolveModelSettings deliberately PRESERVES a bare claude-*
  // thinking model under codex (settingsUtils L1210-1221), and the retry path
  // re-enables planning from that thinking slot — routing straight back into the
  // same Claude planning terminal (an infinite loop). So for either failed role
  // we clear thinkingModel/thinkingProfileId and disable plan mode AFTER the
  // resolveModelSettings spread. Legacy switch-model actions (no failedRole) keep
  // the previous working-model-only behaviour.
  if (failedRole === 'planning' || failedRole === 'execution') {
    return {
      ...base,
      thinkingModel: undefined,
      thinkingProfileId: undefined,
      planMode: false,
    };
  }
  return base;
}

async function applySwitchModel(
  deps: AgentErrorHandlerDeps,
  request: ApplyResolutionRequest,
): Promise<ApplyResolutionResponse> {
  const model = request.payload?.model;
  if (!model) {
    log.warn({ turnId: request.turnId }, 'switch-model resolution missing model payload');
    return response(request.action, false, 'invalid_payload');
  }

  const settings = deps.getSettings();
  const nextModelSettings = buildSwitchedModelSettings(
    settings,
    model,
    request.payload?.failedRole,
  );
  if (!nextModelSettings) {
    log.warn({ turnId: request.turnId, model }, 'switch-model resolution referenced an unusable profile');
    return response(request.action, false, 'invalid_payload');
  }
  // Intentionally omit the inert legacy claude mirror from the model-switch write (don't persist
  // stale claude); runtime + normalize are models-only post-cutover.
  // eslint-disable-next-line no-restricted-properties, no-restricted-syntax -- see above
  const { claude: _legacyClaude, ...settingsWithoutLegacyClaude } = settings;
  void _legacyClaude;
  await updateSettingsViaChannel({
    ...settingsWithoutLegacyClaude,
    models: nextModelSettings,
  });
  broadcastSettingsExternalUpdate();
  return response(request.action, true);
}

async function applySwitchProvider(
  deps: AgentErrorHandlerDeps,
  request: ApplyResolutionRequest,
): Promise<ApplyResolutionResponse> {
  const provider = toActiveProvider(request.payload?.provider);
  if (!provider) {
    log.warn(
      { turnId: request.turnId, provider: request.payload?.provider },
      'switch-provider resolution missing supported provider payload',
    );
    return response(request.action, false, 'invalid_payload');
  }

  const settings = deps.getSettings();
  const plan = planProviderSwitch({
    to: provider,
    settings,
    codexConnected: codexConnected(),
  });
  await updateSettingsViaChannel({
    ...settings,
    ...plan.updates,
  });
  broadcastSettingsExternalUpdate();
  return response(request.action, true);
}

async function applyRecreateChiefOfStaff(
  deps: AgentErrorHandlerDeps,
  request: ApplyResolutionRequest,
): Promise<ApplyResolutionResponse> {
  if (!deps.recreateChiefOfStaff) {
    // Fail loud rather than silently no-op: a recreate action with no provisioning
    // wiring is a misconfiguration, not a recoverable user condition.
    log.warn(
      { turnId: request.turnId },
      'recreate-chief-of-staff resolution received but no provisioning dep is wired',
    );
    return response(request.action, false, 'invalid_payload');
  }
  // Re-provision the README from the starter template. On success the renderer
  // retries the turn (the README is back, so admission will admit).
  await deps.recreateChiefOfStaff();
  log.info({ turnId: request.turnId }, 'Recreated Chief-of-Staff instructions from template via error recovery');
  return response(request.action, true);
}

export function registerAgentErrorHandlers(deps: AgentErrorHandlerDeps): void {
  log.info('Registering agent error handlers');

  registerHandler(
    'error:apply-resolution',
    async (
      _event: IpcMainInvokeEvent,
      request: ApplyResolutionRequest,
    ): Promise<ApplyResolutionResponse> => {
      const inFlightKey = `${request.turnId}:${request.action}`;
      if (inFlightApplyRequests.has(inFlightKey)) {
        log.info(
          { turnId: request.turnId, action: request.action },
          'Refusing duplicate error resolution while an identical request is in flight',
        );
        return response(request.action, false, 'in_flight');
      }

      inFlightApplyRequests.add(inFlightKey);
      try {
        if (shouldRefuseWhileTurnAlive(request.action) && isReferencedTurnAlive(request.turnId)) {
          log.info(
            { turnId: request.turnId, action: request.action },
            'Refusing error resolution while referenced turn is still alive',
          );
          return response(request.action, false, 'turn_alive');
        }

        if (shouldRefuseWhileAnotherTurnActive(request.action) && isAnotherTurnActive(request.turnId)) {
          log.info(
            {
              turnId: request.turnId,
              action: request.action,
              activeTurnIds: agentTurnRegistry.getActiveTurnIds(),
            },
            'Refusing stale error resolution while another turn is active',
          );
          return response(request.action, false, 'stale_turn');
        }

        switch (request.action) {
          case 'switch-model':
            return await applySwitchModel(deps, request);
          case 'switch-provider':
            return await applySwitchProvider(deps, request);
          case 'open-settings':
            return response(request.action, true);
          case 'retry':
            return response(request.action, true);
          case 'recreate-chief-of-staff':
            return await applyRecreateChiefOfStaff(deps, request);
          case 'proceed-without-chief-of-staff':
            // The bypass + retry happens renderer-side (it threads the
            // `proceedWithoutChiefOfStaff` turn flag onto the resent prompt).
            // The main handler only acknowledges + logs that the user chose to
            // proceed without their instructions — observable, never silent.
            log.warn(
              { turnId: request.turnId },
              'User chose to proceed without Chief-of-Staff instructions (template bypass)',
            );
            return response(request.action, true);
          default: {
            const _exhaustive: never = request.action;
            return response(_exhaustive, false, 'invalid_payload');
          }
        }
      } finally {
        inFlightApplyRequests.delete(inFlightKey);
      }
    },
  );

  log.info('Agent error handlers registered successfully');
}
