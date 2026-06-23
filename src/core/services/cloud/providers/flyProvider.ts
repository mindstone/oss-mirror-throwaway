/**
 * Fly.io Cloud Provider
 *
 * Thin adapter wrapping the existing flyProvisioningService functions.
 * Import and delegate — don't move code.
 */

import type {
  CloudProvider,
  CloudProvisionOptions,
  CloudProvisionResult,
  CloudDeprovisionResult,
  CloudStatusResult,
} from './types';

export const flyProvider: CloudProvider = {
  config: {
    id: 'fly',
    name: 'Fly.io',
    authType: 'pat',
  },

  async provision(opts: CloudProvisionOptions): Promise<CloudProvisionResult> {
    const { provisionCloudInstance } = await import('../../flyProvisioningService');

    const result = await provisionCloudInstance({
      flyApiToken: opts.token,
      region: opts.region,
      volumeSizeGb: opts.volumeSizeGb,
      vmTierId: opts.vmTierId,
      sentryDsn: opts.sentryDsn,
      onProgress: opts.onProgress
        ? (step) => {
            opts.onProgress?.({
              phase: step.phase,
              message: step.message,
              progress: step.progress,
              failedStep: step.failedStep,
            });
          }
        : undefined,
    });

    return {
      success: result.success,
      cloudUrl: result.cloudUrl,
      cloudToken: result.cloudToken,
      instanceId: result.appName,
      volumeId: result.volumeId,
      region: result.region,
      vmTierId: result.vmTierId,
      providerMetadata: {
        ...(result.appName ? { appName: result.appName } : {}),
        ...(result.machineId ? { machineId: result.machineId } : {}),
      },
      error: result.error,
      warning: result.warning,
      failedStep: result.failedStep,
      cleanedUp: result.cleanedUp,
      cleanupMessage: result.cleanupMessage,
    };
  },

  async deprovision(token: string, instanceId: string): Promise<CloudDeprovisionResult> {
    const { destroyCloudInstance } = await import('../../flyProvisioningService');
    return destroyCloudInstance(token, instanceId);
  },

  async getStatus(
    token: string,
    instanceId: string,
    metadata?: Record<string, string>,
  ): Promise<CloudStatusResult> {
    const { getFlyMachineStatus } = await import('../../flyProvisioningService');
    const machineId = metadata?.machineId;
    if (!machineId) {
      return { state: 'unknown', error: 'Missing machineId in provider metadata' };
    }
    return getFlyMachineStatus(token, instanceId, machineId);
  },
};
