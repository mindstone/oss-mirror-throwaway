import type {
  PreTurnRequest,
  PreTurnResult,
  PreTurnWorker,
  PreTurnWorkerStatsSnapshot,
  PreTurnWorkerStatus,
} from '@core/preTurnWorker';

export class CloudPreTurnWorker implements PreTurnWorker {
  private readonly startedAt = Date.now();

  async waitForWorkerReady(_workspacePath: string): Promise<void> {
    // In-process adapter: no worker startup required.
  }

  isWorkerAvailable(): boolean {
    return true;
  }

  async assemblePreTurnContext(
    _workspacePath: string,
    _request: PreTurnRequest,
    _urlDomainHints?: string,
  ): Promise<PreTurnResult> {
    // Cloud currently keeps the legacy fallback path (no utilityProcess).
    return {};
  }

  async disposeWorker(): Promise<void> {
    // No-op.
  }

  getWorkerStatus(): PreTurnWorkerStatus {
    return {
      isReady: true,
      permanentlyDisabled: false,
      consecutiveCrashes: 0,
      crashCooldownRemainingMs: 0,
      workspacePath: null,
    };
  }

  getPreTurnWorkerStats(): PreTurnWorkerStatsSnapshot {
    return {
      since: 'app_start',
      appStartedAt: this.startedAt,
      spawnCount: 0,
      restartCount: 0,
      currentlyRestarting: false,
    };
  }
}
