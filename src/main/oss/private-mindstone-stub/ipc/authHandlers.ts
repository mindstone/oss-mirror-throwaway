/**
 * OSS auth IPC handlers.
 *
 * Keeps the public build's auth contract registered without carrying
 * Mindstone-server auth behavior.
 */

import type { IpcMainInvokeEvent } from 'electron';
import { OSS_NULL_AUTH_PROVIDER } from '@core/services/ossNullAuthProvider';
import { registerHandler } from '@main/ipc/utils/registerHandler';
import { authChannels } from '@shared/ipc/contracts';
import type { AuthUser } from '@shared/ipc/schemas/auth';

const OSS_USER: AuthUser = {
  id: 'oss-user',
  name: 'You',
  email: '',
  image: null,
};

function createOssNoLoginError(): Error & { code: 'OSS_NO_LOGIN' } {
  return Object.assign(
    new Error('OSS_NO_LOGIN: This build runs in guest mode and does not support Mindstone login.'),
    { code: 'OSS_NO_LOGIN' as const },
  );
}

/**
 * Register all auth IPC handlers for the OSS build.
 */
export function registerAuthHandlers(): void {
  registerHandler(authChannels['auth:get-state'].channel, async (_event: IpcMainInvokeEvent) => {
    return OSS_NULL_AUTH_PROVIDER.getAuthState();
  });

  registerHandler(authChannels['auth:login'].channel, async (_event: IpcMainInvokeEvent) => {
    throw createOssNoLoginError();
  });

  registerHandler(authChannels['auth:logout'].channel, async (_event: IpcMainInvokeEvent) => undefined);

  registerHandler(authChannels['auth:get-user'].channel, async (_event: IpcMainInvokeEvent) => {
    return OSS_USER;
  });

  registerHandler(authChannels['auth:get-access-token'].channel, async (_event: IpcMainInvokeEvent) => {
    return null;
  });

  registerHandler(authChannels['auth:cancel'].channel, async (_event: IpcMainInvokeEvent) => undefined);

  registerHandler(authChannels['auth:send-otp'].channel, async (_event: IpcMainInvokeEvent) => {
    throw createOssNoLoginError();
  });

  registerHandler(authChannels['auth:verify-otp'].channel, async (_event: IpcMainInvokeEvent) => {
    throw createOssNoLoginError();
  });

  registerHandler(authChannels['auth:test-loopback'].channel, async (_event: IpcMainInvokeEvent) => {
    return false;
  });

  registerHandler(authChannels['auth:test-api-reachability'].channel, async (_event: IpcMainInvokeEvent) => {
    return {
      reachable: false as const,
      reason: 'unknown' as const,
    };
  });

  registerHandler(authChannels['auth:get-config'].channel, async (_event: IpcMainInvokeEvent) => {
    return OSS_NULL_AUTH_PROVIDER.getCachedAuthConfig();
  });

  registerHandler(authChannels['auth:refresh-config'].channel, async (_event: IpcMainInvokeEvent) => {
    await OSS_NULL_AUTH_PROVIDER.requestAuthConfigRefresh();
  });

  registerHandler(authChannels['auth:get-shared-drive-config'].channel, async (_event: IpcMainInvokeEvent) => {
    return null;
  });
}
