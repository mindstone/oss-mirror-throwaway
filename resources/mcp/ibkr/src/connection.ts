import { EventName, IBApi } from '@stoqey/ib';
import { awaitSingle } from './helpers.js';
import {
  formatIbErrorForUser,
  IbRequestError,
  parseIbErrorEvent,
  type ClassifiedIbError,
} from './errors.js';

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'ready';
export type IbkrMode = 'paper' | 'live';

export interface ConnectionConfig {
  host: string;
  port: number;
  clientId: number;
  mode: IbkrMode;
}

export interface RuntimeConnectionConfig {
  host?: string;
  port?: number;
  clientId?: number;
}

export interface ConnectionStatusSnapshot {
  state: ConnectionState;
  connected: boolean;
  ready: boolean;
  host: string;
  port: number;
  clientId: number;
  mode: IbkrMode;
  nextOrderId: number | null;
  reconnectAttempts: number;
  pendingRequests: number;
  pacing: {
    queueDepth: number;
    sentLastSecond: number;
    historicalLastMinute: number;
  };
  subscriptions: {
    marketData: number;
    scanner: number;
  };
  lastError: string | null;
}

type PacingCategory = 'general' | 'historical';

interface PendingRequest<T = unknown> {
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
  timeout: NodeJS.Timeout;
}

interface ReadyWaiter {
  resolve: () => void;
  reject: (reason?: unknown) => void;
  timeout: NodeJS.Timeout;
}

interface PacingTask<T> {
  category: PacingCategory;
  task: () => T | Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

const DEFAULT_READY_TIMEOUT_MS = 15_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

const parseIntegerEnv = (
  value: string | undefined,
  fallback: number,
  min: number = 0,
): number => {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed) || parsed < min) {
    return fallback;
  }
  return parsed;
};

const parseMode = (value: string | undefined): IbkrMode => {
  return value?.toLowerCase() === 'live' ? 'live' : 'paper';
};

const loadConfigFromEnv = (): ConnectionConfig => ({
  host: process.env.IBKR_HOST || '127.0.0.1',
  port: parseIntegerEnv(process.env.IBKR_PORT, 4002, 1),
  clientId: parseIntegerEnv(process.env.IBKR_CLIENT_ID, 1, 0),
  mode: parseMode(process.env.IBKR_MODE),
});

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

class PacingQueue {
  private readonly queue: Array<PacingTask<unknown>> = [];
  private readonly sentTimestamps: number[] = [];
  private readonly historicalTimestamps: number[] = [];
  private running = false;

  constructor(
    private readonly generalLimitPerSecond: number,
    private readonly historicalLimitPerMinute: number,
  ) {}

  public enqueue<T>(task: () => T | Promise<T>, category: PacingCategory = 'general'): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        category,
        task: task as () => unknown | Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      void this.drain();
    });
  }

  public snapshot(): { queueDepth: number; sentLastSecond: number; historicalLastMinute: number } {
    this.prune(Date.now());
    return {
      queueDepth: this.queue.length,
      sentLastSecond: this.sentTimestamps.length,
      historicalLastMinute: this.historicalTimestamps.length,
    };
  }

  private prune(now: number): void {
    while (this.sentTimestamps.length > 0 && now - this.sentTimestamps[0] >= 1_000) {
      this.sentTimestamps.shift();
    }
    while (this.historicalTimestamps.length > 0 && now - this.historicalTimestamps[0] >= 60_000) {
      this.historicalTimestamps.shift();
    }
  }

  private nextDelay(category: PacingCategory, now: number): number {
    this.prune(now);

    let delay = 0;

    if (this.sentTimestamps.length >= this.generalLimitPerSecond) {
      const oldest = this.sentTimestamps[0];
      delay = Math.max(delay, 1_000 - (now - oldest));
    }

    if (category === 'historical' && this.historicalTimestamps.length >= this.historicalLimitPerMinute) {
      const oldestHistorical = this.historicalTimestamps[0];
      delay = Math.max(delay, 60_000 - (now - oldestHistorical));
    }

    return delay;
  }

  private async drain(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;

    try {
      while (this.queue.length > 0) {
        const next = this.queue[0];
        const now = Date.now();
        const delay = this.nextDelay(next.category, now);

        if (delay > 0) {
          await sleep(delay);
          continue;
        }

        this.queue.shift();

        const sentAt = Date.now();
        this.prune(sentAt);
        this.sentTimestamps.push(sentAt);
        if (next.category === 'historical') {
          this.historicalTimestamps.push(sentAt);
        }

        try {
          const value = await next.task();
          next.resolve(value);
        } catch (error) {
          next.reject(error);
        }
      }
    } finally {
      this.running = false;
      if (this.queue.length > 0) {
        void this.drain();
      }
    }
  }
}

export class ConnectionManager {
  private static instance: ConnectionManager | null = null;

  private ib: IBApi | null = null;
  private connectionToken = 0;
  private state: ConnectionState = 'disconnected';
  private readonly config: ConnectionConfig = loadConfigFromEnv();
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private shouldAutoReconnect = true;
  private reqIdCounter = 1;
  private nextOrderId: number | null = null;
  private readonly pendingRequests = new Map<number, PendingRequest<unknown>>();
  private readonly readyWaiters: ReadyWaiter[] = [];
  private readonly pacingQueue = new PacingQueue(45, 6);
  private readonly marketDataSubscriptions = new Set<number>();
  private readonly scannerSubscriptions = new Set<number>();
  private lastError: ClassifiedIbError | null = null;

  private constructor() {}

  public static getInstance(): ConnectionManager {
    if (!ConnectionManager.instance) {
      ConnectionManager.instance = new ConnectionManager();
    }
    return ConnectionManager.instance;
  }

  public getMode(): IbkrMode {
    return this.config.mode;
  }

  public getState(): ConnectionState {
    return this.state;
  }

  public isConnected(): boolean {
    return this.state === 'connected' || this.state === 'ready';
  }

  public isReady(): boolean {
    return this.state === 'ready';
  }

  public getConfig(): ConnectionConfig {
    return { ...this.config };
  }

  public nextRequestId(): number {
    const id = this.reqIdCounter;
    this.reqIdCounter += 1;
    return id;
  }

  public reserveOrderId(): number {
    if (this.nextOrderId === null) {
      throw new Error('IBKR connection is not ready (nextValidId not received yet).');
    }
    const id = this.nextOrderId;
    this.nextOrderId += 1;
    return id;
  }

  public createTrackedRequest<T>(reqId: number, timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS): Promise<T> {
    if (this.pendingRequests.has(reqId)) {
      throw new Error(`Request ${reqId} is already pending.`);
    }

    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(reqId);
        reject(new Error(`IBKR request ${reqId} timed out after ${timeoutMs}ms.`));
      }, timeoutMs);

      this.pendingRequests.set(reqId, {
        resolve: resolve as unknown as (value: unknown) => void,
        reject,
        timeout,
      });
    });
  }

  public resolveTrackedRequest<T>(reqId: number, value: T): void {
    const pending = this.pendingRequests.get(reqId);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timeout);
    this.pendingRequests.delete(reqId);
    pending.resolve(value);
  }

  public rejectTrackedRequest(reqId: number, reason: unknown): void {
    const pending = this.pendingRequests.get(reqId);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timeout);
    this.pendingRequests.delete(reqId);
    pending.reject(reason);
  }

  public reserveMarketDataSubscription(reqId: number): void {
    const MAX_MARKET_DATA_SUBSCRIPTIONS = 95;
    if (!this.marketDataSubscriptions.has(reqId) && this.marketDataSubscriptions.size >= MAX_MARKET_DATA_SUBSCRIPTIONS) {
      throw new Error(`IBKR market data subscription limit reached (${MAX_MARKET_DATA_SUBSCRIPTIONS}).`);
    }
    this.marketDataSubscriptions.add(reqId);
  }

  public releaseMarketDataSubscription(reqId: number): void {
    this.marketDataSubscriptions.delete(reqId);
  }

  public reserveScannerSubscription(reqId: number): void {
    const MAX_SCANNER_SUBSCRIPTIONS = 8;
    if (!this.scannerSubscriptions.has(reqId) && this.scannerSubscriptions.size >= MAX_SCANNER_SUBSCRIPTIONS) {
      throw new Error(`IBKR scanner subscription limit reached (${MAX_SCANNER_SUBSCRIPTIONS}).`);
    }
    this.scannerSubscriptions.add(reqId);
  }

  public releaseScannerSubscription(reqId: number): void {
    this.scannerSubscriptions.delete(reqId);
  }

  public enqueueGeneral<T>(task: () => T | Promise<T>): Promise<T> {
    return this.pacingQueue.enqueue(task, 'general');
  }

  public enqueueHistorical<T>(task: () => T | Promise<T>): Promise<T> {
    return this.pacingQueue.enqueue(task, 'historical');
  }

  public async ensureConnected(timeoutMs: number = DEFAULT_READY_TIMEOUT_MS): Promise<void> {
    if (this.state === 'ready') {
      return;
    }

    if (this.state === 'disconnected') {
      this.connectInternal();
    }

    await this.waitForReady(timeoutMs);
  }

  public async reconfigure(config: RuntimeConnectionConfig, timeoutMs: number = 20_000): Promise<void> {
    if (typeof config.host === 'string' && config.host.trim().length > 0) {
      this.config.host = config.host.trim();
    }

    if (typeof config.port === 'number') {
      if (!Number.isInteger(config.port) || config.port <= 0) {
        throw new Error('Port must be a positive integer.');
      }
      this.config.port = config.port;
    }

    if (typeof config.clientId === 'number') {
      if (!Number.isInteger(config.clientId) || config.clientId < 0) {
        throw new Error('Client ID must be an integer greater than or equal to 0.');
      }
      this.config.clientId = config.clientId;
    }

    this.reconnectAttempts = 0;
    this.clearReconnectTimer();
    this.rejectAllPendingRequests(new Error('IBKR request cancelled due to reconnect.'));
    this.disconnectInternal(false);
    this.connectInternal();
    await this.waitForReady(timeoutMs);
  }

  public disconnect(): void {
    this.disconnectInternal(true);
  }

  public getClient(): IBApi {
    if (!this.ib) {
      throw new Error('IBKR client is not initialized.');
    }
    return this.ib;
  }

  public async listManagedAccounts(timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS): Promise<string[]> {
    await this.ensureConnected(timeoutMs);
    const ib = this.getClient();

    const responsePromise = awaitSingle<string[]>(
      ib,
      -1,
      EventName.managedAccounts,
      (...args) => {
        const accountsList = typeof args[0] === 'string' ? args[0] : '';
        return accountsList
          .split(',')
          .map((value) => value.trim())
          .filter((value) => value.length > 0);
      },
      timeoutMs,
    );

    await this.enqueueGeneral(() => {
      ib.reqManagedAccts();
      return undefined;
    });

    return responsePromise;
  }

  public async getServerTime(timeoutMs: number = 5_000): Promise<number | null> {
    if (!this.isConnected()) {
      return null;
    }

    await this.ensureConnected(timeoutMs);
    const ib = this.getClient();

    const responsePromise = awaitSingle<number>(
      ib,
      -1,
      EventName.currentTime,
      (...args) => {
        if (typeof args[0] !== 'number') {
          throw new Error('Unexpected currentTime payload from IBKR.');
        }
        return args[0];
      },
      timeoutMs,
    );

    await this.enqueueGeneral(() => {
      ib.reqCurrentTime();
      return undefined;
    });

    return responsePromise;
  }

  public getStatusSnapshot(): ConnectionStatusSnapshot {
    const pacing = this.pacingQueue.snapshot();

    return {
      state: this.state,
      connected: this.isConnected(),
      ready: this.isReady(),
      host: this.config.host,
      port: this.config.port,
      clientId: this.config.clientId,
      mode: this.config.mode,
      nextOrderId: this.nextOrderId,
      reconnectAttempts: this.reconnectAttempts,
      pendingRequests: this.pendingRequests.size,
      pacing,
      subscriptions: {
        marketData: this.marketDataSubscriptions.size,
        scanner: this.scannerSubscriptions.size,
      },
      lastError: this.lastError ? formatIbErrorForUser(this.lastError) : null,
    };
  }

  private waitForReady(timeoutMs: number): Promise<void> {
    if (this.state === 'ready') {
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const index = this.readyWaiters.findIndex((waiter) => waiter.timeout === timeout);
        if (index >= 0) {
          this.readyWaiters.splice(index, 1);
        }
        reject(new Error(`IBKR connection did not become ready within ${timeoutMs}ms.`));
      }, timeoutMs);

      this.readyWaiters.push({ resolve, reject, timeout });
    });
  }

  private resolveReadyWaiters(): void {
    while (this.readyWaiters.length > 0) {
      const waiter = this.readyWaiters.shift();
      if (!waiter) {
        continue;
      }
      clearTimeout(waiter.timeout);
      waiter.resolve();
    }
  }

  private rejectReadyWaiters(reason: Error): void {
    while (this.readyWaiters.length > 0) {
      const waiter = this.readyWaiters.shift();
      if (!waiter) {
        continue;
      }
      clearTimeout(waiter.timeout);
      waiter.reject(reason);
    }
  }

  private rejectAllPendingRequests(reason: Error): void {
    for (const [reqId] of this.pendingRequests) {
      this.rejectTrackedRequest(reqId, reason);
    }
  }

  private connectInternal(): void {
    if (this.state === 'connecting' || this.state === 'ready') {
      return;
    }

    this.shouldAutoReconnect = true;
    this.clearReconnectTimer();
    this.connectionToken += 1;
    const token = this.connectionToken;

    this.disposeClient();
    this.state = 'connecting';
    this.nextOrderId = null;

    const ib = new IBApi({
      host: this.config.host,
      port: this.config.port,
      maxReqPerSec: 45,
    });

    const emitter = ib as unknown as {
      on(event: EventName, listener: (...args: unknown[]) => void): void;
    };

    emitter.on(EventName.connected, () => {
      if (token !== this.connectionToken) {
        return;
      }
      if (this.state !== 'ready') {
        this.state = 'connected';
      }
    });

    emitter.on(EventName.nextValidId, (...args) => {
      if (token !== this.connectionToken) {
        return;
      }

      const nextId = args[0];
      if (typeof nextId === 'number' && Number.isFinite(nextId)) {
        this.nextOrderId = nextId;
        this.state = 'ready';
        this.reconnectAttempts = 0;
        this.resolveReadyWaiters();
      }
    });

    const onDisconnect = () => {
      if (token !== this.connectionToken) {
        return;
      }
      this.handleDisconnected('IBKR socket disconnected.');
    };

    emitter.on(EventName.disconnected, onDisconnect);
    emitter.on(EventName.connectionClosed, onDisconnect);

    emitter.on(EventName.error, (...args) => {
      if (token !== this.connectionToken) {
        return;
      }
      this.handleIbErrorEvent(...args);
    });

    this.ib = ib;

    try {
      ib.connect(this.config.clientId);
    } catch (error) {
      this.handleDisconnected(`Failed to connect to IBKR: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private handleIbErrorEvent(...args: unknown[]): void {
    const parsed = parseIbErrorEvent(...args);
    if (!parsed) {
      return;
    }

    if (parsed.severity === 'info' || parsed.severity === 'warning') {
      return;
    }

    this.lastError = parsed;

    if (parsed.reqId >= 0) {
      this.rejectTrackedRequest(parsed.reqId, new IbRequestError(parsed));
    }

    if (parsed.severity === 'fatal') {
      this.handleDisconnected(formatIbErrorForUser(parsed));
      this.disposeClient();
    }
  }

  private handleDisconnected(reason: string): void {
    if (this.state === 'disconnected') {
      return;
    }

    this.state = 'disconnected';
    this.nextOrderId = null;
    this.marketDataSubscriptions.clear();
    this.scannerSubscriptions.clear();

    const error = new Error(reason);
    this.rejectReadyWaiters(error);
    this.rejectAllPendingRequests(error);

    if (this.shouldAutoReconnect) {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      return;
    }

    const delayMs = Math.min(1_000 * (2 ** this.reconnectAttempts), 30_000);
    this.reconnectAttempts += 1;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.shouldAutoReconnect) {
        return;
      }
      this.connectInternal();
    }, delayMs);
  }

  private disconnectInternal(stopAutoReconnect: boolean): void {
    this.shouldAutoReconnect = !stopAutoReconnect;
    this.clearReconnectTimer();
    this.disposeClient();

    if (this.state !== 'disconnected') {
      this.handleDisconnected('IBKR connection closed.');
    }

    if (stopAutoReconnect) {
      this.rejectReadyWaiters(new Error('IBKR connection closed.'));
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private disposeClient(): void {
    if (!this.ib) {
      return;
    }

    try {
      this.ib.disconnect();
    } catch {
      // Best effort cleanup.
    }

    const ibWithRemoveAll = this.ib as unknown as { removeAllListeners?: () => void };
    try {
      ibWithRemoveAll.removeAllListeners?.();
    } catch {
      // Best effort cleanup.
    }

    this.ib = null;
  }
}

export const connectionManager = ConnectionManager.getInstance();
