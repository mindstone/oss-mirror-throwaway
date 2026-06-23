import { EventName, type IBApi } from '@stoqey/ib';
import { IbRequestError, parseIbErrorEvent } from './errors.js';

const DEFAULT_TIMEOUT_MS = 15_000;

type IbEmitter = {
  on(event: EventName, listener: (...args: unknown[]) => void): void;
  removeListener(event: EventName, listener: (...args: unknown[]) => void): void;
};

type UnknownListener = (...args: unknown[]) => void;

export interface SnapshotTickValue {
  price?: number;
  size?: number;
  stringValue?: string;
  genericValue?: number;
}

const asEmitter = (ib: IBApi): IbEmitter => ib as unknown as IbEmitter;

const toError = (value: unknown): Error => {
  if (value instanceof Error) {
    return value;
  }
  return new Error(String(value));
};

const matchesReqId = (reqId: number, args: unknown[]): boolean => {
  if (reqId < 0) {
    return true;
  }
  return typeof args[0] === 'number' && args[0] === reqId;
};

const shouldRejectFromIbError = (reqId: number, args: unknown[]): Error | null => {
  const parsed = parseIbErrorEvent(...args);
  if (!parsed) {
    return null;
  }
  if (parsed.severity === 'info' || parsed.severity === 'warning') {
    return null;
  }

  // For reqId-less flows (reqId < 0), only reject on fatal errors
  // to avoid spurious failures from unrelated concurrent requests.
  if (reqId < 0) {
    if (parsed.severity !== 'fatal') {
      return null;
    }
    return new IbRequestError(parsed);
  }

  const reqIdMatches = parsed.reqId === reqId || parsed.reqId === -1;
  if (!reqIdMatches) {
    return null;
  }

  return new IbRequestError(parsed);
};

/**
 * Collect multi-part IB responses and resolve once the matching *End event arrives.
 */
export function collectUntilEnd<T>(
  ib: IBApi,
  reqId: number,
  dataEvent: EventName,
  endEvent: EventName,
  transform: (...args: unknown[]) => T,
  timeout: number = DEFAULT_TIMEOUT_MS,
): Promise<T[]> {
  const emitter = asEmitter(ib);

  return new Promise<T[]>((resolve, reject) => {
    const items: T[] = [];
    let settled = false;
    let timer: NodeJS.Timeout | null = null;

    const listeners: Array<[EventName, UnknownListener]> = [];

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      for (const [eventName, listener] of listeners) {
        emitter.removeListener(eventName, listener);
      }
    };

    const settle = (fn: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      fn();
    };

    const onData: UnknownListener = (...args) => {
      if (!matchesReqId(reqId, args)) {
        return;
      }

      try {
        items.push(transform(...args));
      } catch (error) {
        settle(() => reject(toError(error)));
      }
    };

    const onEnd: UnknownListener = (...args) => {
      if (!matchesReqId(reqId, args)) {
        return;
      }

      settle(() => resolve(items));
    };

    const onError: UnknownListener = (...args) => {
      const error = shouldRejectFromIbError(reqId, args);
      if (!error) {
        return;
      }
      settle(() => reject(error));
    };

    const onDisconnected: UnknownListener = () => {
      settle(() => reject(new Error('IBKR disconnected while waiting for response.')));
    };

    listeners.push([dataEvent, onData]);
    listeners.push([endEvent, onEnd]);
    listeners.push([EventName.error, onError]);
    listeners.push([EventName.disconnected, onDisconnected]);
    listeners.push([EventName.connectionClosed, onDisconnected]);

    for (const [eventName, listener] of listeners) {
      emitter.on(eventName, listener);
    }

    timer = setTimeout(() => {
      settle(() => reject(new Error(`IBKR request timed out after ${timeout}ms.`)));
    }, timeout);
  });
}

/**
 * Execute a market-data snapshot request, collect tick updates, then cancel subscription.
 */
export function snapshotThenCancel<T>(
  ib: IBApi,
  reqId: number,
  subscribe: () => void,
  cancel: () => void,
  collectTicks: (tickMap: Map<number, SnapshotTickValue>) => T,
  timeout: number = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const emitter = asEmitter(ib);

  return new Promise<T>((resolve, reject) => {
    const tickMap = new Map<number, SnapshotTickValue>();
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    let didCancel = false;

    const listeners: Array<[EventName, UnknownListener]> = [];

    const safeCancel = () => {
      if (didCancel) {
        return;
      }
      didCancel = true;
      try {
        cancel();
      } catch {
        // Best-effort cancellation.
      }
    };

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      for (const [eventName, listener] of listeners) {
        emitter.removeListener(eventName, listener);
      }
      safeCancel();
    };

    const settle = (fn: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      fn();
    };

    const upsert = (tickType: unknown, update: Partial<SnapshotTickValue>) => {
      if (typeof tickType !== 'number') {
        return;
      }

      const current = tickMap.get(tickType) ?? {};
      tickMap.set(tickType, { ...current, ...update });
    };

    const onTickPrice: UnknownListener = (...args) => {
      if (!matchesReqId(reqId, args)) {
        return;
      }
      upsert(args[1], { price: typeof args[2] === 'number' ? args[2] : undefined });
    };

    const onTickSize: UnknownListener = (...args) => {
      if (!matchesReqId(reqId, args)) {
        return;
      }
      upsert(args[1], { size: typeof args[2] === 'number' ? args[2] : undefined });
    };

    const onTickString: UnknownListener = (...args) => {
      if (!matchesReqId(reqId, args)) {
        return;
      }
      upsert(args[1], { stringValue: typeof args[2] === 'string' ? args[2] : undefined });
    };

    const onTickGeneric: UnknownListener = (...args) => {
      if (!matchesReqId(reqId, args)) {
        return;
      }
      upsert(args[1], { genericValue: typeof args[2] === 'number' ? args[2] : undefined });
    };

    const onSnapshotEnd: UnknownListener = (...args) => {
      if (!matchesReqId(reqId, args)) {
        return;
      }

      settle(() => {
        try {
          resolve(collectTicks(tickMap));
        } catch (error) {
          reject(toError(error));
        }
      });
    };

    const onError: UnknownListener = (...args) => {
      const error = shouldRejectFromIbError(reqId, args);
      if (!error) {
        return;
      }
      settle(() => reject(error));
    };

    const onDisconnected: UnknownListener = () => {
      settle(() => reject(new Error('IBKR disconnected while waiting for market data snapshot.')));
    };

    listeners.push([EventName.tickPrice, onTickPrice]);
    listeners.push([EventName.tickSize, onTickSize]);
    listeners.push([EventName.tickString, onTickString]);
    listeners.push([EventName.tickGeneric, onTickGeneric]);
    listeners.push([EventName.tickSnapshotEnd, onSnapshotEnd]);
    listeners.push([EventName.error, onError]);
    listeners.push([EventName.disconnected, onDisconnected]);
    listeners.push([EventName.connectionClosed, onDisconnected]);

    for (const [eventName, listener] of listeners) {
      emitter.on(eventName, listener);
    }

    timer = setTimeout(() => {
      settle(() => reject(new Error(`IBKR snapshot timed out after ${timeout}ms.`)));
    }, timeout);

    try {
      subscribe();
    } catch (error) {
      settle(() => reject(toError(error)));
    }
  });
}

/**
 * Await a single matching event response.
 */
export function awaitSingle<T>(
  ib: IBApi,
  reqId: number,
  event: EventName,
  transform: (...args: unknown[]) => T,
  timeout: number = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const emitter = asEmitter(ib);

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;

    const listeners: Array<[EventName, UnknownListener]> = [];

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      for (const [eventName, listener] of listeners) {
        emitter.removeListener(eventName, listener);
      }
    };

    const settle = (fn: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      fn();
    };

    const onData: UnknownListener = (...args) => {
      if (!matchesReqId(reqId, args)) {
        return;
      }

      settle(() => {
        try {
          resolve(transform(...args));
        } catch (error) {
          reject(toError(error));
        }
      });
    };

    const onError: UnknownListener = (...args) => {
      const error = shouldRejectFromIbError(reqId, args);
      if (!error) {
        return;
      }
      settle(() => reject(error));
    };

    const onDisconnected: UnknownListener = () => {
      settle(() => reject(new Error('IBKR disconnected while waiting for response.')));
    };

    listeners.push([event, onData]);
    listeners.push([EventName.error, onError]);
    listeners.push([EventName.disconnected, onDisconnected]);
    listeners.push([EventName.connectionClosed, onDisconnected]);

    for (const [eventName, listener] of listeners) {
      emitter.on(eventName, listener);
    }

    timer = setTimeout(() => {
      settle(() => reject(new Error(`IBKR request timed out after ${timeout}ms.`)));
    }, timeout);
  });
}
