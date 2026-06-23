import {
  officeSidecarChannels,
  OfficeSidecarRetryStartResponseSchema,
  OfficeSidecarStatusResponseSchema,
  type OfficeSidecarRetryStartResponse,
  type OfficeSidecarStatusResponse,
  type SanitizedOfficeSidecarError as IpcSanitizedOfficeSidecarError,
} from '@shared/ipc/channels/officeSidecar';
import {
  OFFICE_SIDECAR_ERROR_MESSAGES,
  sanitizeOfficeSidecarError,
} from '@shared/sidecar/errorMessages';
import {
  getOfficeSidecarManager as defaultGetManager,
  type OfficeSidecarErrorCode,
  type OfficeSidecarManager,
  type OfficeSidecarRuntimeState,
  type OfficeSidecarSkipReason,
  type SanitizedOfficeSidecarError,
} from '../services/officeSidecarManager';
import { registerHandler } from './utils/registerHandler';

const EMPTY_STATUS_RESPONSE: OfficeSidecarStatusResponse = {
  running: false,
  port: null,
  adopted: false,
  skipReason: null,
  lastError: null,
  startedAt: null,
};

const EMPTY_RETRY_RESPONSE: OfficeSidecarRetryStartResponse = {
  restarted: false,
  port: null,
  adopted: false,
  skipReason: null,
  error: null,
};

export interface OfficeSidecarHandlersDeps {
  getManager?: () => OfficeSidecarManager | null;
}

function sanitizeSkipReason(skipReason: OfficeSidecarSkipReason | null): OfficeSidecarSkipReason | null {
  return skipReason === 'kill-switch' || skipReason === 'surface-not-desktop'
    ? skipReason
    : null;
}

function sanitizeError(
  error: SanitizedOfficeSidecarError | null | undefined,
): IpcSanitizedOfficeSidecarError | null {
  if (!error) {
    return null;
  }

  const code = error.code in OFFICE_SIDECAR_ERROR_MESSAGES ? error.code : 'unknown';
  return {
    code,
    message: sanitizeOfficeSidecarError(code as OfficeSidecarErrorCode),
    at: Number.isInteger(error.at) && error.at > 0 ? error.at : Date.now(),
  };
}

function getStartedAt(state: OfficeSidecarRuntimeState | null): number | null {
  if (!state || !Number.isInteger(state.startedAt) || state.startedAt <= 0) {
    return null;
  }

  return state.startedAt;
}

function buildStatusResponse(manager: OfficeSidecarManager | null): OfficeSidecarStatusResponse {
  if (!manager) {
    return OfficeSidecarStatusResponseSchema.parse(EMPTY_STATUS_RESPONSE);
  }

  const state = manager.getState();
  return OfficeSidecarStatusResponseSchema.parse({
    running: state !== null,
    port: state?.port ?? null,
    adopted: state?.adopted ?? false,
    skipReason: sanitizeSkipReason(manager.getSkipReason()),
    lastError: sanitizeError(manager.getLastError()),
    startedAt: getStartedAt(state),
  });
}

function buildRetryResponse(
  manager: OfficeSidecarManager | null,
  state: OfficeSidecarRuntimeState | null,
  errorOverride?: SanitizedOfficeSidecarError | null,
): OfficeSidecarRetryStartResponse {
  if (!manager) {
    return OfficeSidecarRetryStartResponseSchema.parse(EMPTY_RETRY_RESPONSE);
  }

  return OfficeSidecarRetryStartResponseSchema.parse({
    restarted: state !== null,
    port: state?.port ?? null,
    adopted: state?.adopted ?? false,
    skipReason: sanitizeSkipReason(manager.getSkipReason()),
    error: sanitizeError(errorOverride ?? manager.getLastError()),
  });
}

export function registerOfficeSidecarHandlers(
  deps: OfficeSidecarHandlersDeps = {},
): void {
  const getManager = deps.getManager ?? defaultGetManager;

  const statusChannel = officeSidecarChannels['office-sidecar:status'];
  registerHandler(statusChannel.channel, async (_event, ...args) => {
    statusChannel.request.parse(args[0]);
    return buildStatusResponse(getManager());
  });

  const retryStartChannel = officeSidecarChannels['office-sidecar:retry-start'];
  registerHandler(retryStartChannel.channel, async (_event, ...args) => {
    retryStartChannel.request.parse(args[0]);
    const manager = getManager();
    if (!manager) {
      return OfficeSidecarRetryStartResponseSchema.parse(EMPTY_RETRY_RESPONSE);
    }

    try {
      const state = await manager.retryStart();
      return buildRetryResponse(manager, state);
    } catch {
      return buildRetryResponse(manager, null, manager.getLastError());
    }
  });
}
