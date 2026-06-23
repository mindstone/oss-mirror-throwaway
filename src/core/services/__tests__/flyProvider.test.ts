import { describe, it, expect, vi, beforeEach } from 'vitest';
import { flyProvider } from '../cloud/providers/flyProvider';

const mockProvisionCloudInstance = vi.fn();
const mockDestroyCloudInstance = vi.fn();
const mockGetFlyMachineStatus = vi.fn();

vi.mock('../../services/flyProvisioningService', () => ({
  provisionCloudInstance: (...args: unknown[]) => mockProvisionCloudInstance(...args),
  destroyCloudInstance: (...args: unknown[]) => mockDestroyCloudInstance(...args),
  getFlyMachineStatus: (...args: unknown[]) => mockGetFlyMachineStatus(...args),
}));

describe('flyProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('config', () => {
    it('has correct provider metadata', () => {
      expect(flyProvider.config).toEqual({
        id: 'fly',
        name: 'Fly.io',
        authType: 'pat',
      });
    });
  });

  describe('provision', () => {
    it('delegates to provisionCloudInstance with mapped options', async () => {
      mockProvisionCloudInstance.mockResolvedValue({
        success: true,
        cloudUrl: 'https://rebel-cloud-abc.fly.dev',
        cloudToken: 'secret-token',
        appName: 'rebel-cloud-abc',
        machineId: 'mach-1',
        volumeId: 'vol-1',
        region: 'iad',
      });

      const result = await flyProvider.provision({
        token: 'fly-pat-token',
        region: 'iad',
      });

      expect(mockProvisionCloudInstance).toHaveBeenCalledWith({
        flyApiToken: 'fly-pat-token',
        region: 'iad',
        onProgress: undefined,
      });

      expect(result).toEqual({
        success: true,
        cloudUrl: 'https://rebel-cloud-abc.fly.dev',
        cloudToken: 'secret-token',
        instanceId: 'rebel-cloud-abc',
        volumeId: 'vol-1',
        region: 'iad',
        providerMetadata: {
          appName: 'rebel-cloud-abc',
          machineId: 'mach-1',
        },
        error: undefined,
        failedStep: undefined,
        cleanedUp: undefined,
      });
    });

    it('maps progress callbacks from Fly format to generic format', async () => {
      const progressSteps: unknown[] = [];

      mockProvisionCloudInstance.mockImplementation(async (opts: { onProgress?: (step: unknown) => void }) => {
        opts.onProgress?.({
          phase: 'creating-app',
          message: 'Creating app...',
          progress: 15,
          failedStep: undefined,
        });
        return { success: true, appName: 'test' };
      });

      await flyProvider.provision({
        token: 'token',
        onProgress: (step) => progressSteps.push(step),
      });

      expect(progressSteps).toEqual([
        {
          phase: 'creating-app',
          message: 'Creating app...',
          progress: 15,
          failedStep: undefined,
        },
      ]);
    });

    it('maps failure results correctly', async () => {
      mockProvisionCloudInstance.mockResolvedValue({
        success: false,
        error: 'Token invalid',
        failedStep: 1,
        cleanedUp: false,
      });

      const result = await flyProvider.provision({ token: 'bad-token' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Token invalid');
      expect(result.failedStep).toBe(1);
    });
  });

  describe('deprovision', () => {
    it('delegates to destroyCloudInstance', async () => {
      mockDestroyCloudInstance.mockResolvedValue({ success: true });

      const result = await flyProvider.deprovision('fly-token', 'rebel-cloud-abc');

      expect(mockDestroyCloudInstance).toHaveBeenCalledWith('fly-token', 'rebel-cloud-abc');
      expect(result).toEqual({ success: true });
    });

    it('passes through errors', async () => {
      mockDestroyCloudInstance.mockResolvedValue({
        success: false,
        error: 'App not found',
      });

      const result = await flyProvider.deprovision('fly-token', 'ghost-app');

      expect(result.success).toBe(false);
      expect(result.error).toBe('App not found');
    });
  });

  describe('getStatus', () => {
    it('delegates to getFlyMachineStatus with machineId from metadata', async () => {
      mockGetFlyMachineStatus.mockResolvedValue({ state: 'started' });

      const result = await flyProvider.getStatus(
        'fly-token',
        'rebel-cloud-abc',
        { machineId: 'mach-1' },
      );

      expect(mockGetFlyMachineStatus).toHaveBeenCalledWith('fly-token', 'rebel-cloud-abc', 'mach-1');
      expect(result).toEqual({ state: 'started' });
    });

    it('returns unknown state when machineId is missing from metadata', async () => {
      const result = await flyProvider.getStatus('fly-token', 'rebel-cloud-abc');

      expect(mockGetFlyMachineStatus).not.toHaveBeenCalled();
      expect(result).toEqual({
        state: 'unknown',
        error: 'Missing machineId in provider metadata',
      });
    });
  });
});
