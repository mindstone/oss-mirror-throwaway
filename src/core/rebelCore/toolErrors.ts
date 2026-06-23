export class ToolKilledByWatchdogError extends Error {
  readonly cancelledAtMs: number;
  readonly judgeReason: string;
  readonly priorExtensionCount: number;

  constructor(opts: { cancelledAtMs: number; judgeReason: string; priorExtensionCount: number }) {
    super(`Tool cancelled by watchdog judge: ${opts.judgeReason}`);
    this.name = 'ToolKilledByWatchdogError';
    this.cancelledAtMs = opts.cancelledAtMs;
    this.judgeReason = opts.judgeReason;
    this.priorExtensionCount = opts.priorExtensionCount;
  }
}
