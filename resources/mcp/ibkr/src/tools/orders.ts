import {
  EventName,
  OrderAction,
  OrderStatus,
  OrderType,
  SecType,
  TimeInForce,
  type Contract,
  type IBApi,
  type Order,
  type OrderState,
} from '@stoqey/ib';
import { connectionManager } from '../connection.js';
import { collectUntilEnd } from '../helpers.js';
import { IbRequestError, parseIbErrorEvent } from '../errors.js';

const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;

const CONNECTION_RESOLUTION =
  'Ensure IB Gateway/TWS is running with API enabled, then reconnect using configure_ibkr_connection and retry.';
const INPUT_RESOLUTION = 'Fix the tool arguments and retry.';
const REQUEST_RESOLUTION =
  'Retry the request. If this persists, verify order parameters, account permissions, and IB Gateway/TWS health.';

const VALID_SEC_TYPES = new Set<string>(Object.values(SecType));

const ORDER_TYPE_LOOKUP = new Map<string, OrderType>([
  ['MKT', OrderType.MKT],
  ['LMT', OrderType.LMT],
  ['STP', OrderType.STP],
  ['STP_LMT', OrderType.STP_LMT],
  ['MOC', OrderType.MOC],
  ['LOC', OrderType.LOC],
  ['TRAIL', OrderType.TRAIL],
  ['TRAIL_LIMIT', OrderType.TRAIL_LIMIT],
  ['REL', OrderType.REL],
]);

const ENTRY_ORDER_TYPE_LOOKUP = new Map<string, OrderType>([
  ['MKT', OrderType.MKT],
  ['LMT', OrderType.LMT],
]);

type SupportedTimeInForce = 'DAY' | 'GTC' | 'IOC' | 'FOK';

const TIF_LOOKUP = new Map<string, SupportedTimeInForce>([
  ['DAY', TimeInForce.DAY],
  ['GTC', TimeInForce.GTC],
  ['IOC', TimeInForce.IOC],
  ['FOK', TimeInForce.FOK],
]);

const SUBMISSION_SUCCESS_STATUSES = new Set<string>([
  OrderStatus.Submitted,
  OrderStatus.PreSubmitted,
  OrderStatus.Filled,
]);

const SUBMISSION_FAILURE_STATUSES = new Set<string>([
  OrderStatus.Cancelled,
  OrderStatus.ApiCancelled,
  OrderStatus.Inactive,
]);

const CANCELLATION_SUCCESS_STATUSES = new Set<string>([
  OrderStatus.Cancelled,
  OrderStatus.ApiCancelled,
]);

type UnknownListener = (...args: unknown[]) => void;

type IbEmitter = {
  on(event: EventName, listener: UnknownListener): void;
  removeListener(event: EventName, listener: UnknownListener): void;
};

interface ToolErrorResponse {
  ok: false;
  error: string;
  resolution: string;
  [key: string]: unknown;
}

interface ToolSuccessResponse {
  ok: true;
  [key: string]: unknown;
}

type ToolResponse = ToolSuccessResponse | ToolErrorResponse;

interface ReadyClientResult {
  ok: true;
  ib: IBApi;
}

type ReadyClient = ReadyClientResult | ToolErrorResponse;

interface BaseContractArgs {
  symbol?: unknown;
  secType?: unknown;
  exchange?: unknown;
  currency?: unknown;
}

interface StandardOrderArgs extends BaseContractArgs {
  action?: unknown;
  quantity?: unknown;
  orderType?: unknown;
  limitPrice?: unknown;
  stopPrice?: unknown;
  trailStopPrice?: unknown;
  trailPercent?: unknown;
  tif?: unknown;
  outsideRth?: unknown;
  account?: unknown;
}

export interface PlaceIbkrOrderArgs extends StandardOrderArgs {}

export interface PlaceIbkrBracketOrderArgs extends BaseContractArgs {
  action?: unknown;
  quantity?: unknown;
  entryOrderType?: unknown;
  entryLimitPrice?: unknown;
  takeProfitPrice?: unknown;
  stopLossPrice?: unknown;
  tif?: unknown;
  account?: unknown;
}

export interface ModifyIbkrOrderArgs extends StandardOrderArgs {
  orderId?: unknown;
}

export interface CancelIbkrOrderArgs {
  orderId?: unknown;
}

export interface CancelAllIbkrOrdersArgs {
  confirm?: unknown;
}

export interface GetIbkrOpenOrdersArgs {}

export interface GetIbkrCompletedOrdersArgs {}

export interface PreviewIbkrOrderArgs extends StandardOrderArgs {}

interface ParsedContractArgs {
  symbol: string;
  secType: SecType;
  exchange: string;
  currency: string;
  contract: Contract;
}

interface ParsedStandardOrderArgs {
  action: OrderAction;
  quantity: number;
  orderType: OrderType;
  limitPrice?: number;
  stopPrice?: number;
  trailStopPrice?: number;
  trailPercent?: number;
  tif: SupportedTimeInForce;
  outsideRth: boolean;
  account?: string;
}

interface ParsedStandardOrderRequest {
  contractArgs: ParsedContractArgs;
  orderArgs: ParsedStandardOrderArgs;
}

interface ParsedBracketOrderArgs {
  contractArgs: ParsedContractArgs;
  action: OrderAction;
  quantity: number;
  entryOrderType: OrderType;
  entryLimitPrice?: number;
  takeProfitPrice: number;
  stopLossPrice: number;
  tif: SupportedTimeInForce;
  account?: string;
}

interface NormalizedOrderStatusSnapshot {
  status: string;
  filledQuantity: number | null;
  remainingQuantity: number | null;
  avgFillPrice: number | null;
}

interface OpenOrderRow {
  orderId: number;
  symbol: string | null;
  secType: string | null;
  action: string | null;
  quantity: number | null;
  orderType: string | null;
  limitPrice: number | null;
  stopPrice: number | null;
  status: string | null;
  filled: number | null;
  remaining: number | null;
  avgFillPrice: number | null;
  account: string | null;
}

interface CompletedOrderRow {
  orderId: number | null;
  symbol: string | null;
  action: string | null;
  quantity: number | null;
  orderType: string | null;
  status: string | null;
  filledQuantity: number | null;
  avgFillPrice: number | null;
  completedTime: string | null;
}

const asEmitter = (ib: IBApi): IbEmitter => ib as unknown as IbEmitter;

const toErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
};

const errorResponse = (error: unknown, resolution: string): ToolErrorResponse => ({
  ok: false,
  error: toErrorMessage(error),
  resolution,
});

const asNumberOrNull = (value: unknown): number | null => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  return value;
};

const asStringOrNull = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const toOptionalString = (value: unknown): string | undefined => {
  const normalized = asStringOrNull(value);
  return normalized ?? undefined;
};

const requireString = (value: unknown, fieldName: string): string => {
  const normalized = toOptionalString(value);
  if (!normalized) {
    throw new Error(`${fieldName} is required.`);
  }
  return normalized;
};

const parsePositiveNumber = (
  value: unknown,
  fieldName: string,
  minimumExclusive: number = 0,
): number => {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number.parseFloat(value)
        : Number.NaN;

  if (!Number.isFinite(parsed) || parsed <= minimumExclusive) {
    throw new Error(`${fieldName} must be a number greater than ${minimumExclusive}.`);
  }

  return parsed;
};

const parseOptionalPositiveNumber = (
  value: unknown,
  fieldName: string,
): number | undefined => {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  return parsePositiveNumber(value, fieldName, 0);
};

const parsePositiveInteger = (value: unknown, fieldName: string): number => {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${fieldName} must be a positive integer.`);
  }
  return parsed;
};

const parseBoolean = (
  value: unknown,
  fieldName: string,
  defaultValue: boolean,
): boolean => {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    if (value === 1) {
      return true;
    }
    if (value === 0) {
      return false;
    }
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'yes') {
      return true;
    }
    if (normalized === 'false' || normalized === '0' || normalized === 'no') {
      return false;
    }
  }

  throw new Error(`${fieldName} must be a boolean value.`);
};

const parseSecType = (value: unknown): SecType => {
  const normalized = toOptionalString(value);
  if (!normalized) {
    return SecType.STK;
  }

  const upper = normalized.toUpperCase();
  if (!VALID_SEC_TYPES.has(upper)) {
    throw new Error(`secType must be one of: ${Array.from(VALID_SEC_TYPES).join(', ')}.`);
  }

  return upper as SecType;
};

const parseOrderAction = (value: unknown): OrderAction => {
  const normalized = requireString(value, 'action').toUpperCase();

  if (normalized === OrderAction.BUY) {
    return OrderAction.BUY;
  }
  if (normalized === OrderAction.SELL) {
    return OrderAction.SELL;
  }

  throw new Error('action must be either BUY or SELL.');
};

const parseOrderType = (value: unknown, fieldName: string): OrderType => {
  const normalized = requireString(value, fieldName)
    .toUpperCase()
    .replace(/\s+/g, '_');

  const orderType = ORDER_TYPE_LOOKUP.get(normalized);
  if (!orderType) {
    throw new Error(
      `${fieldName} must be one of: ${Array.from(ORDER_TYPE_LOOKUP.keys()).join(', ')}.`,
    );
  }

  return orderType;
};

const parseBracketEntryOrderType = (value: unknown): OrderType => {
  const normalized = requireString(value, 'entryOrderType').toUpperCase();
  const entryOrderType = ENTRY_ORDER_TYPE_LOOKUP.get(normalized);
  if (!entryOrderType) {
    throw new Error('entryOrderType must be either MKT or LMT.');
  }
  return entryOrderType;
};

const parseTif = (value: unknown): SupportedTimeInForce => {
  const normalized = toOptionalString(value);
  if (!normalized) {
    return TimeInForce.DAY;
  }

  const tif = TIF_LOOKUP.get(normalized.toUpperCase());
  if (!tif) {
    throw new Error('tif must be one of: DAY, GTC, IOC, FOK.');
  }

  return tif;
};

const parseContractArgs = (args: BaseContractArgs): ParsedContractArgs => {
  const symbol = requireString(args.symbol, 'symbol');
  const secType = parseSecType(args.secType);
  const exchange = toOptionalString(args.exchange) ?? 'SMART';
  const currency = toOptionalString(args.currency) ?? 'USD';

  return {
    symbol,
    secType,
    exchange,
    currency,
    contract: {
      symbol,
      secType,
      exchange,
      currency,
    },
  };
};

const validateStandardOrderPricing = (
  orderType: OrderType,
  limitPrice?: number,
  stopPrice?: number,
): void => {
  if ((orderType === OrderType.LMT || orderType === OrderType.STP_LMT) && limitPrice === undefined) {
    throw new Error('limitPrice is required for LMT and STP_LMT orders.');
  }

  if ((orderType === OrderType.STP || orderType === OrderType.STP_LMT) && stopPrice === undefined) {
    throw new Error('stopPrice is required for STP and STP_LMT orders.');
  }
};

const parseStandardOrderRequest = (args: StandardOrderArgs): ParsedStandardOrderRequest => {
  const contractArgs = parseContractArgs(args);
  const action = parseOrderAction(args.action);
  const quantity = parsePositiveNumber(args.quantity, 'quantity', 0);
  const orderType = parseOrderType(args.orderType, 'orderType');
  const limitPrice = parseOptionalPositiveNumber(args.limitPrice, 'limitPrice');
  const stopPrice = parseOptionalPositiveNumber(args.stopPrice, 'stopPrice');
  const trailStopPrice = parseOptionalPositiveNumber(args.trailStopPrice, 'trailStopPrice');
  const trailPercent = parseOptionalPositiveNumber(args.trailPercent, 'trailPercent');
  const tif = parseTif(args.tif);
  const outsideRth = parseBoolean(args.outsideRth, 'outsideRth', false);
  const account = toOptionalString(args.account);

  validateStandardOrderPricing(orderType, limitPrice, stopPrice);

  return {
    contractArgs,
    orderArgs: {
      action,
      quantity,
      orderType,
      limitPrice,
      stopPrice,
      trailStopPrice,
      trailPercent,
      tif,
      outsideRth,
      account,
    },
  };
};

const parseBracketOrderArgs = (args: PlaceIbkrBracketOrderArgs): ParsedBracketOrderArgs => {
  const contractArgs = parseContractArgs(args);
  const action = parseOrderAction(args.action);
  const quantity = parsePositiveNumber(args.quantity, 'quantity', 0);
  const entryOrderType = parseBracketEntryOrderType(args.entryOrderType);
  const entryLimitPrice = parseOptionalPositiveNumber(args.entryLimitPrice, 'entryLimitPrice');
  const takeProfitPrice = parsePositiveNumber(args.takeProfitPrice, 'takeProfitPrice', 0);
  const stopLossPrice = parsePositiveNumber(args.stopLossPrice, 'stopLossPrice', 0);
  const tif = parseTif(args.tif);
  const account = toOptionalString(args.account);

  if (entryOrderType === OrderType.LMT && entryLimitPrice === undefined) {
    throw new Error('entryLimitPrice is required when entryOrderType is LMT.');
  }

  return {
    contractArgs,
    action,
    quantity,
    entryOrderType,
    entryLimitPrice,
    takeProfitPrice,
    stopLossPrice,
    tif,
    account,
  };
};

const buildStandardOrder = (args: ParsedStandardOrderArgs, whatIf: boolean): Order => {
  const order: Order = {
    action: args.action,
    totalQuantity: args.quantity,
    orderType: args.orderType,
    tif: args.tif,
    outsideRth: args.outsideRth,
    transmit: true,
    whatIf,
  };

  if (args.limitPrice !== undefined) {
    order.lmtPrice = args.limitPrice;
  }

  if (args.stopPrice !== undefined) {
    order.auxPrice = args.stopPrice;
  }

  if (args.trailStopPrice !== undefined) {
    order.trailStopPrice = args.trailStopPrice;
  }

  if (args.trailPercent !== undefined) {
    order.trailingPercent = args.trailPercent;
  }

  if (args.account) {
    order.account = args.account;
  }

  return order;
};

const asContract = (value: unknown): Contract => {
  if (!value || typeof value !== 'object') {
    return {};
  }
  return value as Contract;
};

const asOrder = (value: unknown): Order => {
  if (!value || typeof value !== 'object') {
    return {};
  }
  return value as Order;
};

const asOrderState = (value: unknown): OrderState => {
  if (!value || typeof value !== 'object') {
    return {};
  }
  return value as OrderState;
};

const parseStatusSnapshotFromOrderStatusEvent = (
  ...eventArgs: unknown[]
): NormalizedOrderStatusSnapshot => ({
  status: asStringOrNull(eventArgs[1]) ?? OrderStatus.Unknown,
  filledQuantity: asNumberOrNull(eventArgs[2]),
  remainingQuantity: asNumberOrNull(eventArgs[3]),
  avgFillPrice: asNumberOrNull(eventArgs[4]),
});

const shouldHandleOrderError = (parsedReqId: number, orderId: number, severity: string): boolean => {
  if (severity === 'fatal') {
    return true;
  }
  return parsedReqId === orderId || parsedReqId === -1;
};

const awaitOrderSubmissionStatus = (
  ib: IBApi,
  orderId: number,
  timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<NormalizedOrderStatusSnapshot> => {
  const emitter = asEmitter(ib);

  return new Promise<NormalizedOrderStatusSnapshot>((resolve, reject) => {
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

    const onOrderStatus: UnknownListener = (...eventArgs) => {
      if (asNumberOrNull(eventArgs[0]) !== orderId) {
        return;
      }

      const snapshot = parseStatusSnapshotFromOrderStatusEvent(...eventArgs);

      if (SUBMISSION_SUCCESS_STATUSES.has(snapshot.status)) {
        settle(() => resolve(snapshot));
        return;
      }

      if (SUBMISSION_FAILURE_STATUSES.has(snapshot.status)) {
        settle(() =>
          reject(
            new Error(
              `Order ${orderId} entered status "${snapshot.status}" before submission confirmation.`,
            ),
          ),
        );
      }
    };

    const onError: UnknownListener = (...eventArgs) => {
      const parsed = parseIbErrorEvent(...eventArgs);
      if (!parsed || parsed.severity === 'info' || parsed.severity === 'warning') {
        return;
      }

      if (!shouldHandleOrderError(parsed.reqId, orderId, parsed.severity)) {
        return;
      }

      settle(() => reject(new IbRequestError(parsed)));
    };

    const onDisconnected: UnknownListener = () => {
      settle(() => reject(new Error('IBKR disconnected while waiting for order submission status.')));
    };

    listeners.push([EventName.orderStatus, onOrderStatus]);
    listeners.push([EventName.error, onError]);
    listeners.push([EventName.disconnected, onDisconnected]);
    listeners.push([EventName.connectionClosed, onDisconnected]);

    for (const [eventName, listener] of listeners) {
      emitter.on(eventName, listener);
    }

    timer = setTimeout(() => {
      settle(() => reject(new Error(`Order ${orderId} status timed out after ${timeoutMs}ms.`)));
    }, timeoutMs);
  });
};

const awaitOrderCancellation = (
  ib: IBApi,
  orderId: number,
  timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<void> => {
  const emitter = asEmitter(ib);

  return new Promise<void>((resolve, reject) => {
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

    const onOrderStatus: UnknownListener = (...eventArgs) => {
      if (asNumberOrNull(eventArgs[0]) !== orderId) {
        return;
      }

      const status = asStringOrNull(eventArgs[1]) ?? OrderStatus.Unknown;
      if (CANCELLATION_SUCCESS_STATUSES.has(status)) {
        settle(() => resolve());
        return;
      }

      if (status === OrderStatus.Filled) {
        settle(() => reject(new Error(`Order ${orderId} is already filled and cannot be cancelled.`)));
      }
    };

    const onError: UnknownListener = (...eventArgs) => {
      const parsed = parseIbErrorEvent(...eventArgs);
      if (!parsed || parsed.severity === 'info' || parsed.severity === 'warning') {
        return;
      }

      const matchesOrder = parsed.reqId === orderId || parsed.reqId === -1;
      if (parsed.code === 202 && matchesOrder) {
        settle(() => resolve());
        return;
      }

      if (!shouldHandleOrderError(parsed.reqId, orderId, parsed.severity)) {
        return;
      }

      settle(() => reject(new IbRequestError(parsed)));
    };

    const onDisconnected: UnknownListener = () => {
      settle(() => reject(new Error('IBKR disconnected while waiting for order cancellation.')));
    };

    listeners.push([EventName.orderStatus, onOrderStatus]);
    listeners.push([EventName.error, onError]);
    listeners.push([EventName.disconnected, onDisconnected]);
    listeners.push([EventName.connectionClosed, onDisconnected]);

    for (const [eventName, listener] of listeners) {
      emitter.on(eventName, listener);
    }

    timer = setTimeout(() => {
      settle(() => reject(new Error(`Order ${orderId} cancellation timed out after ${timeoutMs}ms.`)));
    }, timeoutMs);
  });
};

const awaitWhatIfOrderState = (
  ib: IBApi,
  orderId: number,
  timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<OrderState> => {
  const emitter = asEmitter(ib);

  return new Promise<OrderState>((resolve, reject) => {
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

    const onOpenOrder: UnknownListener = (...eventArgs) => {
      if (asNumberOrNull(eventArgs[0]) !== orderId) {
        return;
      }

      settle(() => resolve(asOrderState(eventArgs[3])));
    };

    const onError: UnknownListener = (...eventArgs) => {
      const parsed = parseIbErrorEvent(...eventArgs);
      if (!parsed || parsed.severity === 'info' || parsed.severity === 'warning') {
        return;
      }

      if (!shouldHandleOrderError(parsed.reqId, orderId, parsed.severity)) {
        return;
      }

      settle(() => reject(new IbRequestError(parsed)));
    };

    const onDisconnected: UnknownListener = () => {
      settle(() => reject(new Error('IBKR disconnected while waiting for order preview result.')));
    };

    listeners.push([EventName.openOrder, onOpenOrder]);
    listeners.push([EventName.error, onError]);
    listeners.push([EventName.disconnected, onDisconnected]);
    listeners.push([EventName.connectionClosed, onDisconnected]);

    for (const [eventName, listener] of listeners) {
      emitter.on(eventName, listener);
    }

    timer = setTimeout(() => {
      settle(() => reject(new Error(`Order preview ${orderId} timed out after ${timeoutMs}ms.`)));
    }, timeoutMs);
  });
};

const ensureReadyClient = async (): Promise<ReadyClient> => {
  if (!connectionManager.isReady()) {
    try {
      await connectionManager.ensureConnected(DEFAULT_REQUEST_TIMEOUT_MS);
    } catch (error) {
      return errorResponse(
        `IBKR connection is not ready: ${toErrorMessage(error)}`,
        CONNECTION_RESOLUTION,
      );
    }
  }

  if (!connectionManager.isReady()) {
    return errorResponse('IBKR connection is not ready.', CONNECTION_RESOLUTION);
  }

  try {
    return {
      ok: true,
      ib: connectionManager.getClient(),
    };
  } catch (error) {
    return errorResponse(error, CONNECTION_RESOLUTION);
  }
};

const reserveOrderIdSafely = (): number => {
  try {
    return connectionManager.reserveOrderId();
  } catch (error) {
    throw new Error(`Unable to reserve order ID: ${toErrorMessage(error)}`);
  }
};

const getLiveMutationWarning = (action: string): string | undefined => {
  if (connectionManager.getMode() !== 'live') {
    return undefined;
  }

  return `Live mode is enabled: ${action}.`;
};

const getOppositeAction = (action: OrderAction): OrderAction => {
  return action === OrderAction.BUY ? OrderAction.SELL : OrderAction.BUY;
};

const cancelOrderBestEffort = async (ib: IBApi, orderId: number): Promise<void> => {
  await connectionManager.enqueueGeneral(() => {
    ib.cancelOrder(orderId, '');
    return undefined;
  });
};

const parseConfirmTrue = (value: unknown): void => {
  if (value !== true) {
    throw new Error('confirm must be true to cancel all IBKR orders.');
  }
};

export async function placeIbkrOrder(args: PlaceIbkrOrderArgs = {}): Promise<ToolResponse> {
  let parsed: ParsedStandardOrderRequest;

  try {
    parsed = parseStandardOrderRequest(args);
  } catch (error) {
    return errorResponse(error, INPUT_RESOLUTION);
  }

  const readyClient = await ensureReadyClient();
  if (!readyClient.ok) {
    return readyClient;
  }

  const { ib } = readyClient;

  let orderId: number;
  try {
    orderId = reserveOrderIdSafely();
  } catch (error) {
    return errorResponse(error, CONNECTION_RESOLUTION);
  }

  const order = buildStandardOrder(parsed.orderArgs, false);
  const responsePromise = awaitOrderSubmissionStatus(ib, orderId, DEFAULT_REQUEST_TIMEOUT_MS);
  void responsePromise.catch(() => {});

  try {
    await connectionManager.enqueueGeneral(() => {
      ib.placeOrder(orderId, parsed.contractArgs.contract, order);
      return undefined;
    });

    const status = await responsePromise;

    return {
      ok: true,
      orderId,
      status: status.status,
      filledQuantity: status.filledQuantity,
      avgFillPrice: status.avgFillPrice,
      warning: getLiveMutationWarning('this order was submitted to your live account'),
    };
  } catch (error) {
    return errorResponse(error, REQUEST_RESOLUTION);
  }
}

export async function placeIbkrBracketOrder(
  args: PlaceIbkrBracketOrderArgs = {},
): Promise<ToolResponse> {
  let parsed: ParsedBracketOrderArgs;

  try {
    parsed = parseBracketOrderArgs(args);
  } catch (error) {
    return errorResponse(error, INPUT_RESOLUTION);
  }

  const readyClient = await ensureReadyClient();
  if (!readyClient.ok) {
    return readyClient;
  }

  const { ib } = readyClient;

  let parentOrderId: number;
  let takeProfitOrderId: number;
  let stopLossOrderId: number;

  try {
    parentOrderId = reserveOrderIdSafely();
    takeProfitOrderId = reserveOrderIdSafely();
    stopLossOrderId = reserveOrderIdSafely();
  } catch (error) {
    return errorResponse(error, CONNECTION_RESOLUTION);
  }

  const oppositeAction = getOppositeAction(parsed.action);

  const parentOrder: Order = {
    action: parsed.action,
    totalQuantity: parsed.quantity,
    orderType: parsed.entryOrderType,
    tif: parsed.tif,
    transmit: false,
    whatIf: false,
  };

  if (parsed.entryOrderType === OrderType.LMT && parsed.entryLimitPrice !== undefined) {
    parentOrder.lmtPrice = parsed.entryLimitPrice;
  }

  if (parsed.account) {
    parentOrder.account = parsed.account;
  }

  const takeProfitOrder: Order = {
    action: oppositeAction,
    totalQuantity: parsed.quantity,
    orderType: OrderType.LMT,
    lmtPrice: parsed.takeProfitPrice,
    tif: parsed.tif,
    parentId: parentOrderId,
    transmit: false,
    whatIf: false,
  };

  if (parsed.account) {
    takeProfitOrder.account = parsed.account;
  }

  const stopLossOrder: Order = {
    action: oppositeAction,
    totalQuantity: parsed.quantity,
    orderType: OrderType.STP,
    auxPrice: parsed.stopLossPrice,
    tif: parsed.tif,
    parentId: parentOrderId,
    transmit: true,
    whatIf: false,
  };

  if (parsed.account) {
    stopLossOrder.account = parsed.account;
  }

  const parentStatusPromise = awaitOrderSubmissionStatus(
    ib,
    parentOrderId,
    DEFAULT_REQUEST_TIMEOUT_MS,
  );
  const takeProfitStatusPromise = awaitOrderSubmissionStatus(
    ib,
    takeProfitOrderId,
    DEFAULT_REQUEST_TIMEOUT_MS,
  );
  const stopLossStatusPromise = awaitOrderSubmissionStatus(
    ib,
    stopLossOrderId,
    DEFAULT_REQUEST_TIMEOUT_MS,
  );

  void parentStatusPromise.catch(() => {});
  void takeProfitStatusPromise.catch(() => {});
  void stopLossStatusPromise.catch(() => {});

  let entrySubmitted = false;

  try {
    await connectionManager.enqueueGeneral(() => {
      ib.placeOrder(parentOrderId, parsed.contractArgs.contract, parentOrder);
      return undefined;
    });
    entrySubmitted = true;

    await connectionManager.enqueueGeneral(() => {
      ib.placeOrder(takeProfitOrderId, parsed.contractArgs.contract, takeProfitOrder);
      return undefined;
    });

    await connectionManager.enqueueGeneral(() => {
      ib.placeOrder(stopLossOrderId, parsed.contractArgs.contract, stopLossOrder);
      return undefined;
    });

    const [parentStatus, takeProfitStatus, stopLossStatus] = await Promise.all([
      parentStatusPromise,
      takeProfitStatusPromise,
      stopLossStatusPromise,
    ]);

    return {
      ok: true,
      parentOrderId,
      takeProfitOrderId,
      stopLossOrderId,
      status: {
        parent: parentStatus.status,
        takeProfit: takeProfitStatus.status,
        stopLoss: stopLossStatus.status,
      },
      warning: getLiveMutationWarning('this bracket order was submitted to your live account'),
    };
  } catch (error) {
    if (entrySubmitted) {
      try {
        await cancelOrderBestEffort(ib, parentOrderId);
      } catch (cancelError) {
        console.error(
          `[ibkr] Failed to cancel bracket parent order ${parentOrderId} after partial failure: ${toErrorMessage(
            cancelError,
          )}`,
        );
      }
    }

    return errorResponse(error, REQUEST_RESOLUTION);
  }
}

export async function modifyIbkrOrder(args: ModifyIbkrOrderArgs = {}): Promise<ToolResponse> {
  let orderId: number;
  let parsed: ParsedStandardOrderRequest;

  try {
    orderId = parsePositiveInteger(args.orderId, 'orderId');
    parsed = parseStandardOrderRequest(args);
  } catch (error) {
    return errorResponse(error, INPUT_RESOLUTION);
  }

  const readyClient = await ensureReadyClient();
  if (!readyClient.ok) {
    return readyClient;
  }

  const { ib } = readyClient;
  const order = buildStandardOrder(parsed.orderArgs, false);

  const responsePromise = awaitOrderSubmissionStatus(ib, orderId, DEFAULT_REQUEST_TIMEOUT_MS);
  void responsePromise.catch(() => {});

  try {
    await connectionManager.enqueueGeneral(() => {
      ib.placeOrder(orderId, parsed.contractArgs.contract, order);
      return undefined;
    });

    const status = await responsePromise;

    return {
      ok: true,
      orderId,
      status: status.status,
      warning: getLiveMutationWarning('this order modification was sent to your live account'),
    };
  } catch (error) {
    return errorResponse(error, REQUEST_RESOLUTION);
  }
}

export async function cancelIbkrOrder(args: CancelIbkrOrderArgs = {}): Promise<ToolResponse> {
  let orderId: number;

  try {
    orderId = parsePositiveInteger(args.orderId, 'orderId');
  } catch (error) {
    return errorResponse(error, INPUT_RESOLUTION);
  }

  const readyClient = await ensureReadyClient();
  if (!readyClient.ok) {
    return readyClient;
  }

  const { ib } = readyClient;

  const cancellationPromise = awaitOrderCancellation(ib, orderId, DEFAULT_REQUEST_TIMEOUT_MS);
  void cancellationPromise.catch(() => {});

  try {
    await connectionManager.enqueueGeneral(() => {
      ib.cancelOrder(orderId, '');
      return undefined;
    });

    await cancellationPromise;

    return {
      ok: true,
      orderId,
      status: 'cancelled',
      warning: getLiveMutationWarning('this cancellation request was sent to your live account'),
    };
  } catch (error) {
    return errorResponse(error, REQUEST_RESOLUTION);
  }
}

export async function cancelAllIbkrOrders(
  args: CancelAllIbkrOrdersArgs = {},
): Promise<ToolResponse> {
  try {
    parseConfirmTrue(args.confirm);
  } catch (error) {
    return errorResponse(error, INPUT_RESOLUTION);
  }

  const readyClient = await ensureReadyClient();
  if (!readyClient.ok) {
    return readyClient;
  }

  const { ib } = readyClient;

  try {
    await connectionManager.enqueueGeneral(() => {
      ib.reqGlobalCancel();
      return undefined;
    });

    return {
      ok: true,
      message: 'All orders cancelled',
      warning: getLiveMutationWarning('a global cancel was sent to your live account'),
    };
  } catch (error) {
    return errorResponse(error, REQUEST_RESOLUTION);
  }
}

export async function getIbkrOpenOrders(
  _args: GetIbkrOpenOrdersArgs = {},
): Promise<ToolResponse> {
  const readyClient = await ensureReadyClient();
  if (!readyClient.ok) {
    return readyClient;
  }

  const { ib } = readyClient;
  const emitter = asEmitter(ib);
  const orderStatusByOrderId = new Map<number, NormalizedOrderStatusSnapshot>();

  const onOrderStatus: UnknownListener = (...eventArgs) => {
    const orderId = asNumberOrNull(eventArgs[0]);
    if (orderId === null) {
      return;
    }

    orderStatusByOrderId.set(orderId, parseStatusSnapshotFromOrderStatusEvent(...eventArgs));
  };

  emitter.on(EventName.orderStatus, onOrderStatus);

  const responsePromise = collectUntilEnd<OpenOrderRow>(
    ib,
    -1,
    EventName.openOrder,
    EventName.openOrderEnd,
    (...eventArgs) => {
      const orderId = asNumberOrNull(eventArgs[0]) ?? -1;
      const contract = asContract(eventArgs[1]);
      const order = asOrder(eventArgs[2]);
      const orderState = asOrderState(eventArgs[3]);
      const orderRecord = order as unknown as Record<string, unknown>;

      const quantity = asNumberOrNull(order.totalQuantity);
      const filled = asNumberOrNull(order.filledQuantity);

      const remaining =
        quantity !== null
          ? Math.max(0, quantity - (filled ?? 0))
          : null;

      return {
        orderId,
        symbol: asStringOrNull(contract.symbol),
        secType: asStringOrNull(contract.secType),
        action: asStringOrNull(order.action),
        quantity,
        orderType: asStringOrNull(order.orderType),
        limitPrice: asNumberOrNull(order.lmtPrice),
        stopPrice: asNumberOrNull(order.auxPrice),
        status: asStringOrNull(orderState.status),
        filled,
        remaining,
        avgFillPrice: asNumberOrNull(orderRecord.avgFillPrice),
        account: asStringOrNull(order.account),
      };
    },
    DEFAULT_REQUEST_TIMEOUT_MS,
  );
  void responsePromise.catch(() => {});

  try {
    await connectionManager.enqueueGeneral(() => {
      ib.reqAllOpenOrders();
      return undefined;
    });

    const openOrders = await responsePromise;

    const enrichedOpenOrders = openOrders
      .map((openOrder) => {
        const latestStatus = orderStatusByOrderId.get(openOrder.orderId);
        if (!latestStatus) {
          return openOrder;
        }

        return {
          ...openOrder,
          status: latestStatus.status,
          filled: latestStatus.filledQuantity,
          remaining: latestStatus.remainingQuantity,
          avgFillPrice: latestStatus.avgFillPrice,
        };
      })
      .sort((a, b) => a.orderId - b.orderId);

    return {
      ok: true,
      openOrders: enrichedOpenOrders,
      count: enrichedOpenOrders.length,
    };
  } catch (error) {
    return errorResponse(error, REQUEST_RESOLUTION);
  } finally {
    emitter.removeListener(EventName.orderStatus, onOrderStatus);
  }
}

export async function getIbkrCompletedOrders(
  _args: GetIbkrCompletedOrdersArgs = {},
): Promise<ToolResponse> {
  const readyClient = await ensureReadyClient();
  if (!readyClient.ok) {
    return readyClient;
  }

  const { ib } = readyClient;

  const responsePromise = collectUntilEnd<CompletedOrderRow>(
    ib,
    -1,
    EventName.completedOrder,
    EventName.completedOrdersEnd,
    (...eventArgs) => {
      const contract = asContract(eventArgs[0]);
      const order = asOrder(eventArgs[1]);
      const orderState = asOrderState(eventArgs[2]);
      const orderRecord = order as unknown as Record<string, unknown>;

      return {
        orderId: asNumberOrNull(order.orderId),
        symbol: asStringOrNull(contract.symbol),
        action: asStringOrNull(order.action),
        quantity: asNumberOrNull(order.totalQuantity),
        orderType: asStringOrNull(order.orderType),
        status: asStringOrNull(orderState.completedStatus) ?? asStringOrNull(orderState.status),
        filledQuantity: asNumberOrNull(order.filledQuantity),
        avgFillPrice: asNumberOrNull(orderRecord.avgFillPrice),
        completedTime: asStringOrNull(orderState.completedTime),
      };
    },
    DEFAULT_REQUEST_TIMEOUT_MS,
  );
  void responsePromise.catch(() => {});

  try {
    await connectionManager.enqueueGeneral(() => {
      ib.reqCompletedOrders(false);
      return undefined;
    });

    const completedOrders = await responsePromise;

    return {
      ok: true,
      completedOrders,
      count: completedOrders.length,
    };
  } catch (error) {
    return errorResponse(error, REQUEST_RESOLUTION);
  }
}

export async function previewIbkrOrder(args: PreviewIbkrOrderArgs = {}): Promise<ToolResponse> {
  let parsed: ParsedStandardOrderRequest;

  try {
    parsed = parseStandardOrderRequest(args);
  } catch (error) {
    return errorResponse(error, INPUT_RESOLUTION);
  }

  const readyClient = await ensureReadyClient();
  if (!readyClient.ok) {
    return readyClient;
  }

  const { ib } = readyClient;

  let orderId: number;
  try {
    orderId = reserveOrderIdSafely();
  } catch (error) {
    return errorResponse(error, CONNECTION_RESOLUTION);
  }

  const previewOrder = buildStandardOrder(parsed.orderArgs, true);

  const responsePromise = awaitWhatIfOrderState(ib, orderId, DEFAULT_REQUEST_TIMEOUT_MS);
  void responsePromise.catch(() => {});

  try {
    await connectionManager.enqueueGeneral(() => {
      ib.placeOrder(orderId, parsed.contractArgs.contract, previewOrder);
      return undefined;
    });

    const orderState = await responsePromise;

    return {
      ok: true,
      orderId,
      initMarginBefore: asNumberOrNull(orderState.initMarginBefore),
      initMarginChange: asNumberOrNull(orderState.initMarginChange),
      initMarginAfter: asNumberOrNull(orderState.initMarginAfter),
      maintMarginBefore: asNumberOrNull(orderState.maintMarginBefore),
      maintMarginChange: asNumberOrNull(orderState.maintMarginChange),
      maintMarginAfter: asNumberOrNull(orderState.maintMarginAfter),
      commission: asNumberOrNull(orderState.commission),
      minCommission: asNumberOrNull(orderState.minCommission),
      maxCommission: asNumberOrNull(orderState.maxCommission),
    };
  } catch (error) {
    return errorResponse(error, REQUEST_RESOLUTION);
  }
}
