// CORE-MOVE-EXEMPT: Desktop adapter wiring the core pre-turn worker boundary to the Electron preTurnWorkerService.
import type {
  PreTurnRequest,
  PreTurnResult,
  PreTurnWorker,
  PreTurnWorkerStatsSnapshot,
  PreTurnWorkerStatus,
} from '@core/preTurnWorker';
import {
  assemblePreTurnContext,
  disposeWorker,
  getPreTurnWorkerStats,
  getWorkerStatus,
  isWorkerAvailable,
  waitForWorkerReady,
} from '../preTurnWorkerService';

export class ElectronPreTurnWorker implements PreTurnWorker {
  waitForWorkerReady(workspacePath: string): Promise<void> {
    return waitForWorkerReady(workspacePath);
  }

  isWorkerAvailable(): boolean {
    return isWorkerAvailable();
  }

  assemblePreTurnContext(
    workspacePath: string,
    request: PreTurnRequest,
    urlDomainHints?: string,
  ): Promise<PreTurnResult> {
    return assemblePreTurnContext(workspacePath, request, urlDomainHints);
  }

  disposeWorker(): Promise<void> {
    return disposeWorker();
  }

  getWorkerStatus(): PreTurnWorkerStatus {
    return getWorkerStatus();
  }

  getPreTurnWorkerStats(): PreTurnWorkerStatsSnapshot {
    return getPreTurnWorkerStats();
  }
}
