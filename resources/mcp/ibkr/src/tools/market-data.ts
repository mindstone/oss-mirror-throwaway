import {
  BarSizeSetting,
  EventName,
  SecType,
  WhatToShow,
  type Contract,
  type ContractDescription,
  type ContractDetails,
  type IBApi,
} from '@stoqey/ib';
import { connectionManager } from '../connection.js';
import {
  awaitSingle,
  collectUntilEnd,
  snapshotThenCancel,
  type SnapshotTickValue,
} from '../helpers.js';
import { IbRequestError, parseIbErrorEvent } from '../errors.js';

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_QUOTE_TIMEOUT_MS = 12_000;
const MARKET_DATA_SUBSCRIPTION_ERROR = 10089;
const DEFAULT_MARKET_DEPTH_WINDOW_MS = 2_000;
const CONTRACT_CACHE_LIMIT = 500;

const CONNECTION_RESOLUTION =
  'Ensure IB Gateway/TWS is running with API enabled, then reconnect using configure_ibkr_connection and retry.';
const INPUT_RESOLUTION = 'Fix the tool arguments and retry.';
const REQUEST_RESOLUTION =
  'Retry the request. If this persists, verify contract parameters and confirm IB Gateway/TWS is healthy.';
const DEPTH_SUBSCRIPTION_RESOLUTION =
  'Level II (depth) market data requires an active subscription in IB Account Management. SMART routing does not support depth for most stocks — try specifying a direct exchange (e.g. ARCA, NYSE, ISLAND).';
const DEPTH_SUBSCRIPTION_CODES = new Set<number>([10089, 10092, 354]);

const VALID_SEC_TYPES = new Set<string>(Object.values(SecType));

const BAR_SIZE_VALUES = Object.values(BarSizeSetting);
const BAR_SIZE_LOOKUP = new Map<string, BarSizeSetting>(
  BAR_SIZE_VALUES.map((value) => [value.toLowerCase(), value]),
);

type WhatToShowValue = (typeof WhatToShow)[keyof typeof WhatToShow];

const WHAT_TO_SHOW_VALUES = Object.values(WhatToShow).filter(
  (value): value is WhatToShowValue => value !== '',
);
const WHAT_TO_SHOW_LOOKUP = new Map<string, WhatToShowValue>(
  WHAT_TO_SHOW_VALUES.map((value) => [value.toUpperCase(), value]),
);

const HISTORICAL_TICK_WHAT_TO_SHOW = new Set<WhatToShowValue>([
  WhatToShow.TRADES,
  WhatToShow.MIDPOINT,
  WhatToShow.BID_ASK,
]);

const TICK_TYPE = {
  BID_SIZE: 0,
  BID: 1,
  ASK: 2,
  ASK_SIZE: 3,
  LAST: 4,
  LAST_SIZE: 5,
  HIGH: 6,
  LOW: 7,
  VOLUME: 8,
  CLOSE: 9,
  OPEN: 14,
  RT_VOLUME: 48,
  DELAYED_BID: 66,
  DELAYED_ASK: 67,
  DELAYED_LAST: 68,
  DELAYED_BID_SIZE: 69,
  DELAYED_ASK_SIZE: 70,
  DELAYED_LAST_SIZE: 71,
  DELAYED_HIGH: 72,
  DELAYED_LOW: 73,
  DELAYED_VOLUME: 74,
  DELAYED_CLOSE: 75,
  DELAYED_OPEN: 76,
} as const;

const CONTRACT_CACHE = new Map<string, NormalizedContractDetails[]>();

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

type UnknownListener = (...args: unknown[]) => void;

type IbEmitter = {
  on(event: EventName, listener: UnknownListener): void;
  removeListener(event: EventName, listener: UnknownListener): void;
};

interface BaseContractArgs {
  symbol?: unknown;
  secType?: unknown;
  exchange?: unknown;
  currency?: unknown;
  conId?: unknown;
}

export interface SearchIbkrContractsArgs {
  pattern?: unknown;
}

export interface GetIbkrContractDetailsArgs extends BaseContractArgs {}

export interface GetIbkrQuoteArgs extends BaseContractArgs {}

export interface GetIbkrHistoricalDataArgs extends BaseContractArgs {
  duration?: unknown;
  barSize?: unknown;
  whatToShow?: unknown;
  useRTH?: unknown;
  endDateTime?: unknown;
}

export interface GetIbkrHistoricalTicksArgs extends BaseContractArgs {
  startDateTime?: unknown;
  endDateTime?: unknown;
  numberOfTicks?: unknown;
  whatToShow?: unknown;
}

export interface GetIbkrMarketDepthArgs extends BaseContractArgs {
  numRows?: unknown;
}

interface ParsedContractArgs {
  symbol: string;
  secType: SecType;
  exchange?: string;
  currency?: string;
  conId?: number;
  contract: Contract;
}

interface SearchContractRow {
  conId: number | null;
  symbol: string | null;
  secType: string | null;
  primaryExchange: string | null;
  currency: string | null;
  description: string | null;
}

interface QuoteSnapshot {
  symbol: string;
  bid: number | null;
  bidSize: number | null;
  ask: number | null;
  askSize: number | null;
  last: number | null;
  lastSize: number | null;
  volume: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  vwap: number | null;
}

interface HistoricalBar {
  time: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
  wap: number | null;
  barCount: number | null;
}

interface MarketDepthLevel {
  price: number;
  size: number;
  position: number;
}

interface MarketDepthSnapshot {
  bids: MarketDepthLevel[];
  asks: MarketDepthLevel[];
}

interface NormalizedContractDetails {
  contract: {
    conId: number | null;
    symbol: string | null;
    secType: string | null;
    exchange: string | null;
    primaryExchange: string | null;
    currency: string | null;
    localSymbol: string | null;
    tradingClass: string | null;
    multiplier: number | null;
    lastTradeDateOrContractMonth: string | null;
  };
  marketName: string | null;
  longName: string | null;
  minTick: number | null;
  orderTypes: string | null;
  validExchanges: string | null;
  priceMagnifier: number | null;
  underConId: number | null;
  underSymbol: string | null;
  underSecType: string | null;
  contractMonth: string | null;
  industry: string | null;
  category: string | null;
  subcategory: string | null;
  timeZoneId: string | null;
  tradingHours: string | null;
  liquidHours: string | null;
  evRule: string | null;
  evMultiplier: number | null;
  marketRuleIds: string | null;
  realExpirationDate: string | null;
  lastTradeTime: string | null;
  stockType: string | null;
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

const toOptionalString = (value: unknown): string | undefined => {
  if (value === undefined || value === null) {
    return undefined;
  }
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : undefined;
};

const requireString = (value: unknown, fieldName: string): string => {
  const normalized = toOptionalString(value);
  if (!normalized) {
    throw new Error(`${fieldName} is required.`);
  }
  return normalized;
};

const asStringOrNull = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const asNumberOrNull = (value: unknown): number | null => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  return value;
};

const parseNumberLike = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const parseConId = (value: unknown): number | undefined => {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error('conId must be a positive integer.');
  }
  return parsed;
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

const parseBoolean = (value: unknown, defaultValue: boolean): boolean => {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    if (value === 0) {
      return false;
    }
    if (value === 1) {
      return true;
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

  throw new Error('useRTH must be a boolean value.');
};

const parseInteger = (
  value: unknown,
  fieldName: string,
  minimum: number,
  maximum: number,
  defaultValue: number,
): number => {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }

  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${fieldName} must be an integer between ${minimum} and ${maximum}.`);
  }

  return parsed;
};

const parseDuration = (value: unknown): string => {
  const normalized = toOptionalString(value);
  return normalized ?? '1 D';
};

const parseBarSize = (value: unknown): BarSizeSetting => {
  const normalized = toOptionalString(value);
  if (!normalized) {
    return BarSizeSetting.HOURS_ONE;
  }

  const barSize = BAR_SIZE_LOOKUP.get(normalized.toLowerCase());
  if (!barSize) {
    throw new Error(`barSize must be one of: ${BAR_SIZE_VALUES.join(', ')}.`);
  }

  return barSize;
};

const parseWhatToShow = (value: unknown, defaultValue: WhatToShowValue): WhatToShowValue => {
  const normalized = toOptionalString(value);
  if (!normalized) {
    return defaultValue;
  }

  const whatToShow = WHAT_TO_SHOW_LOOKUP.get(normalized.toUpperCase());
  if (!whatToShow) {
    throw new Error(`whatToShow must be one of: ${WHAT_TO_SHOW_VALUES.join(', ')}.`);
  }

  return whatToShow;
};

const parseHistoricalTickWhatToShow = (value: unknown): WhatToShowValue => {
  const whatToShow = parseWhatToShow(value, WhatToShow.TRADES);
  if (!HISTORICAL_TICK_WHAT_TO_SHOW.has(whatToShow)) {
    throw new Error('whatToShow for historical ticks must be one of: TRADES, MIDPOINT, BID_ASK.');
  }
  return whatToShow;
};

const parseContractArgs = (args: BaseContractArgs): ParsedContractArgs => {
  const symbol = requireString(args.symbol, 'symbol');
  const secType = parseSecType(args.secType);
  const exchange = toOptionalString(args.exchange) ?? 'SMART';
  const currency = toOptionalString(args.currency) ?? 'USD';
  const conId = parseConId(args.conId);

  const contract: Contract = {
    symbol,
    secType,
    exchange,
    currency,
  };

  if (conId) {
    contract.conId = conId;
  }

  return {
    symbol,
    secType,
    exchange,
    currency,
    conId,
    contract,
  };
};

const normalizeContractSearchRow = (description: ContractDescription): SearchContractRow => {
  const contract = description?.contract ?? {};
  return {
    conId: asNumberOrNull(contract.conId),
    symbol: asStringOrNull(contract.symbol),
    secType: asStringOrNull(contract.secType),
    primaryExchange: asStringOrNull(contract.primaryExch),
    currency: asStringOrNull(contract.currency),
    description: asStringOrNull(contract.description) ?? asStringOrNull(contract.localSymbol),
  };
};

const normalizeContractDetails = (details: ContractDetails): NormalizedContractDetails => {
  const contract = details?.contract ?? {};

  return {
    contract: {
      conId: asNumberOrNull(contract.conId),
      symbol: asStringOrNull(contract.symbol),
      secType: asStringOrNull(contract.secType),
      exchange: asStringOrNull(contract.exchange),
      primaryExchange: asStringOrNull(contract.primaryExch),
      currency: asStringOrNull(contract.currency),
      localSymbol: asStringOrNull(contract.localSymbol),
      tradingClass: asStringOrNull(contract.tradingClass),
      multiplier: asNumberOrNull(contract.multiplier),
      lastTradeDateOrContractMonth: asStringOrNull(contract.lastTradeDateOrContractMonth),
    },
    marketName: asStringOrNull(details.marketName),
    longName: asStringOrNull(details.longName),
    minTick: asNumberOrNull(details.minTick),
    orderTypes: asStringOrNull(details.orderTypes),
    validExchanges: asStringOrNull(details.validExchanges),
    priceMagnifier: asNumberOrNull(details.priceMagnifier),
    underConId: asNumberOrNull(details.underConId),
    underSymbol: asStringOrNull(details.underSymbol),
    underSecType: asStringOrNull(details.underSecType),
    contractMonth: asStringOrNull(details.contractMonth),
    industry: asStringOrNull(details.industry),
    category: asStringOrNull(details.category),
    subcategory: asStringOrNull(details.subcategory),
    timeZoneId: asStringOrNull(details.timeZoneId),
    tradingHours: asStringOrNull(details.tradingHours),
    liquidHours: asStringOrNull(details.liquidHours),
    evRule: asStringOrNull(details.evRule),
    evMultiplier: asNumberOrNull(details.evMultiplier),
    marketRuleIds: asStringOrNull(details.marketRuleIds),
    realExpirationDate: asStringOrNull(details.realExpirationDate),
    lastTradeTime: asStringOrNull(details.lastTradeTime),
    stockType: asStringOrNull(details.stockType),
  };
};

const cloneContractDetailsList = (
  detailsList: NormalizedContractDetails[],
): NormalizedContractDetails[] => detailsList.map((details) => ({ ...details, contract: { ...details.contract } }));

const touchContractCache = (key: string): NormalizedContractDetails[] | null => {
  const cached = CONTRACT_CACHE.get(key);
  if (!cached) {
    return null;
  }

  CONTRACT_CACHE.delete(key);
  CONTRACT_CACHE.set(key, cached);
  return cloneContractDetailsList(cached);
};

const setContractCache = (key: string, details: NormalizedContractDetails[]): void => {
  if (CONTRACT_CACHE.has(key)) {
    CONTRACT_CACHE.delete(key);
  }
  CONTRACT_CACHE.set(key, cloneContractDetailsList(details));

  while (CONTRACT_CACHE.size > CONTRACT_CACHE_LIMIT) {
    const oldest = CONTRACT_CACHE.keys().next().value;
    if (!oldest) {
      break;
    }
    CONTRACT_CACHE.delete(oldest);
  }
};

const buildContractCacheKeys = (args: ParsedContractArgs): string[] => {
  const keys: string[] = [];
  if (args.conId) {
    keys.push(`conid:${args.conId}`);
  }
  keys.push(
    `symbol:${args.symbol.toUpperCase()}|secType:${args.secType}|exchange:${args.exchange ?? ''}|currency:${args.currency ?? ''}`,
  );
  return keys;
};

const matchesReqId = (reqId: number, eventArgs: unknown[]): boolean => {
  return typeof eventArgs[0] === 'number' && eventArgs[0] === reqId;
};

const shouldRejectFromIbError = (reqId: number, eventArgs: unknown[]): Error | null => {
  const parsed = parseIbErrorEvent(...eventArgs);
  if (!parsed) {
    return null;
  }
  if (parsed.severity === 'info' || parsed.severity === 'warning') {
    return null;
  }

  if (parsed.reqId >= 0 && parsed.reqId !== reqId) {
    return null;
  }

  return new IbRequestError(parsed);
};

const collectHistoricalBars = (
  ib: IBApi,
  reqId: number,
  timeout: number = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<HistoricalBar[]> => {
  const emitter = asEmitter(ib);

  return new Promise<HistoricalBar[]>((resolve, reject) => {
    const bars: HistoricalBar[] = [];
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

    const onHistoricalData: UnknownListener = (...eventArgs) => {
      if (!matchesReqId(reqId, eventArgs)) {
        return;
      }

      const time = asStringOrNull(eventArgs[1]);
      if (!time) {
        return;
      }

      if (time.toLowerCase().startsWith('finished')) {
        settle(() => resolve(bars));
        return;
      }

      bars.push({
        time,
        open: asNumberOrNull(eventArgs[2]),
        high: asNumberOrNull(eventArgs[3]),
        low: asNumberOrNull(eventArgs[4]),
        close: asNumberOrNull(eventArgs[5]),
        volume: asNumberOrNull(eventArgs[6]),
        barCount: asNumberOrNull(eventArgs[7]),
        wap: asNumberOrNull(eventArgs[8]),
      });
    };

    const onError: UnknownListener = (...eventArgs) => {
      const error = shouldRejectFromIbError(reqId, eventArgs);
      if (!error) {
        return;
      }

      settle(() => reject(error));
    };

    const onDisconnected: UnknownListener = () => {
      settle(() => reject(new Error('IBKR disconnected while waiting for historical data.')));
    };

    listeners.push([EventName.historicalData, onHistoricalData]);
    listeners.push([EventName.error, onError]);
    listeners.push([EventName.disconnected, onDisconnected]);
    listeners.push([EventName.connectionClosed, onDisconnected]);

    for (const [eventName, listener] of listeners) {
      emitter.on(eventName, listener);
    }

    timer = setTimeout(() => {
      settle(() => reject(new Error(`IBKR historical data request timed out after ${timeout}ms.`)));
    }, timeout);
  });
};

const normalizeBook = (book: Array<{ price: number; size: number }>, numRows: number): MarketDepthLevel[] => {
  return book
    .map((level, position) => ({
      price: level.price,
      size: level.size,
      position,
    }))
    .slice(0, numRows);
};

const applyDepthUpdate = (
  book: Array<{ price: number; size: number }>,
  operation: number,
  position: number,
  price: number,
  size: number,
): void => {
  if (!Number.isInteger(position) || position < 0) {
    return;
  }

  if (operation === 2) {
    if (position < book.length) {
      book.splice(position, 1);
    }
    return;
  }

  if (!Number.isFinite(price) || !Number.isFinite(size)) {
    return;
  }

  const level = { price, size };

  if (operation === 0) {
    const clampedPosition = Math.min(position, book.length);
    book.splice(clampedPosition, 0, level);
    return;
  }

  if (operation === 1) {
    if (position < book.length) {
      book[position] = level;
    } else if (position === book.length) {
      book.push(level);
    }
  }
};

const collectMarketDepthSnapshot = (
  ib: IBApi,
  reqId: number,
  numRows: number,
  windowMs: number = DEFAULT_MARKET_DEPTH_WINDOW_MS,
): Promise<MarketDepthSnapshot> => {
  const emitter = asEmitter(ib);

  return new Promise<MarketDepthSnapshot>((resolve, reject) => {
    const bids: Array<{ price: number; size: number }> = [];
    const asks: Array<{ price: number; size: number }> = [];

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

    const onDepth = (...eventArgs: unknown[]) => {
      if (!matchesReqId(reqId, eventArgs)) {
        return;
      }

      const position = asNumberOrNull(eventArgs[1]);
      const operation = asNumberOrNull(eventArgs[2]);
      const side = asNumberOrNull(eventArgs[3]);
      const price = asNumberOrNull(eventArgs[4]);
      const size = asNumberOrNull(eventArgs[5]);

      if (position === null || operation === null || side === null) {
        return;
      }

      const book = side === 1 ? bids : asks;
      applyDepthUpdate(book, operation, position, price ?? Number.NaN, size ?? Number.NaN);
    };

    const onDepthL2 = (...eventArgs: unknown[]) => {
      if (!matchesReqId(reqId, eventArgs)) {
        return;
      }

      const position = asNumberOrNull(eventArgs[1]);
      const operation = asNumberOrNull(eventArgs[3]);
      const side = asNumberOrNull(eventArgs[4]);
      const price = asNumberOrNull(eventArgs[5]);
      const size = asNumberOrNull(eventArgs[6]);

      if (position === null || operation === null || side === null) {
        return;
      }

      const book = side === 1 ? bids : asks;
      applyDepthUpdate(book, operation, position, price ?? Number.NaN, size ?? Number.NaN);
    };

    const onError: UnknownListener = (...eventArgs) => {
      const error = shouldRejectFromIbError(reqId, eventArgs);
      if (!error) {
        return;
      }

      settle(() => reject(error));
    };

    const onDisconnected: UnknownListener = () => {
      settle(() => reject(new Error('IBKR disconnected while waiting for market depth updates.')));
    };

    listeners.push([EventName.updateMktDepth, onDepth]);
    listeners.push([EventName.updateMktDepthL2, onDepthL2]);
    listeners.push([EventName.error, onError]);
    listeners.push([EventName.disconnected, onDisconnected]);
    listeners.push([EventName.connectionClosed, onDisconnected]);

    for (const [eventName, listener] of listeners) {
      emitter.on(eventName, listener);
    }

    timer = setTimeout(() => {
      settle(() => {
        resolve({
          bids: normalizeBook(bids, numRows),
          asks: normalizeBook(asks, numRows),
        });
      });
    }, windowMs);
  });
};

const normalizeSnapshotNumber = (value: unknown): number | null => {
  const parsed = parseNumberLike(value);
  if (parsed === null || parsed === -1) {
    return null;
  }
  return parsed;
};

const buildQuoteFromTickMap = (
  symbol: string,
  tickMap: Map<number, SnapshotTickValue>,
): QuoteSnapshot => {
  const readPrice = (realtime: number, delayed: number): number | null => {
    return normalizeSnapshotNumber(tickMap.get(realtime)?.price)
      ?? normalizeSnapshotNumber(tickMap.get(delayed)?.price);
  };

  const readSize = (realtime: number, delayed: number): number | null => {
    return normalizeSnapshotNumber(tickMap.get(realtime)?.size)
      ?? normalizeSnapshotNumber(tickMap.get(delayed)?.size);
  };

  const rtVolumeString = tickMap.get(TICK_TYPE.RT_VOLUME)?.stringValue;
  const rtVolumeParts = typeof rtVolumeString === 'string' ? rtVolumeString.split(';') : [];

  const volumeFromRtVolume = normalizeSnapshotNumber(rtVolumeParts[3]);
  const vwapFromRtVolume = normalizeSnapshotNumber(rtVolumeParts[4]);

  return {
    symbol,
    bid: readPrice(TICK_TYPE.BID, TICK_TYPE.DELAYED_BID),
    bidSize: readSize(TICK_TYPE.BID_SIZE, TICK_TYPE.DELAYED_BID_SIZE),
    ask: readPrice(TICK_TYPE.ASK, TICK_TYPE.DELAYED_ASK),
    askSize: readSize(TICK_TYPE.ASK_SIZE, TICK_TYPE.DELAYED_ASK_SIZE),
    last: readPrice(TICK_TYPE.LAST, TICK_TYPE.DELAYED_LAST),
    lastSize: readSize(TICK_TYPE.LAST_SIZE, TICK_TYPE.DELAYED_LAST_SIZE),
    volume: readSize(TICK_TYPE.VOLUME, TICK_TYPE.DELAYED_VOLUME) ?? volumeFromRtVolume,
    open: readPrice(TICK_TYPE.OPEN, TICK_TYPE.DELAYED_OPEN),
    high: readPrice(TICK_TYPE.HIGH, TICK_TYPE.DELAYED_HIGH),
    low: readPrice(TICK_TYPE.LOW, TICK_TYPE.DELAYED_LOW),
    close: readPrice(TICK_TYPE.CLOSE, TICK_TYPE.DELAYED_CLOSE),
    vwap: vwapFromRtVolume,
  };
};

const normalizeTickPayload = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object') {
    return {};
  }
  return { ...(value as Record<string, unknown>) };
};

const getHistoricalTickEventName = (whatToShow: WhatToShowValue): EventName => {
  if (whatToShow === WhatToShow.MIDPOINT) {
    return EventName.historicalTicks;
  }

  if (whatToShow === WhatToShow.BID_ASK) {
    return EventName.historicalTicksBidAsk;
  }

  return EventName.historicalTicksLast;
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

export async function searchIbkrContracts(args: SearchIbkrContractsArgs = {}): Promise<ToolResponse> {
  let pattern: string;

  try {
    pattern = requireString(args.pattern, 'pattern');
  } catch (error) {
    return errorResponse(error, INPUT_RESOLUTION);
  }

  const readyClient = await ensureReadyClient();
  if (!readyClient.ok) {
    return readyClient;
  }

  const { ib } = readyClient;
  const reqId = connectionManager.nextRequestId();

  const responsePromise = awaitSingle<SearchContractRow[]>(
    ib,
    reqId,
    EventName.symbolSamples,
    (...eventArgs) => {
      const descriptions = Array.isArray(eventArgs[1])
        ? (eventArgs[1] as ContractDescription[])
        : [];
      return descriptions.map(normalizeContractSearchRow);
    },
    DEFAULT_REQUEST_TIMEOUT_MS,
  );
  void responsePromise.catch(() => {});

  try {
    await connectionManager.enqueueGeneral(() => {
      ib.reqMatchingSymbols(reqId, pattern);
      return undefined;
    });

    const contracts = await responsePromise;

    return {
      ok: true,
      pattern,
      contracts,
      count: contracts.length,
    };
  } catch (error) {
    return errorResponse(error, REQUEST_RESOLUTION);
  }
}

export async function getIbkrContractDetails(
  args: GetIbkrContractDetailsArgs = {},
): Promise<ToolResponse> {
  let contractArgs: ParsedContractArgs;

  try {
    contractArgs = parseContractArgs(args);
  } catch (error) {
    return errorResponse(error, INPUT_RESOLUTION);
  }

  const cacheKeys = buildContractCacheKeys(contractArgs);
  for (const cacheKey of cacheKeys) {
    const cached = touchContractCache(cacheKey);
    if (!cached) {
      continue;
    }

    return {
      ok: true,
      cached: true,
      count: cached.length,
      contractDetails: cached,
    };
  }

  const readyClient = await ensureReadyClient();
  if (!readyClient.ok) {
    return readyClient;
  }

  const { ib } = readyClient;
  const reqId = connectionManager.nextRequestId();

  const responsePromise = collectUntilEnd<NormalizedContractDetails>(
    ib,
    reqId,
    EventName.contractDetails,
    EventName.contractDetailsEnd,
    (...eventArgs) => normalizeContractDetails((eventArgs[1] ?? {}) as ContractDetails),
    DEFAULT_REQUEST_TIMEOUT_MS,
  );
  void responsePromise.catch(() => {});

  try {
    await connectionManager.enqueueGeneral(() => {
      ib.reqContractDetails(reqId, contractArgs.contract);
      return undefined;
    });

    const contractDetails = await responsePromise;

    for (const cacheKey of cacheKeys) {
      setContractCache(cacheKey, contractDetails);
    }

    for (const detail of contractDetails) {
      const conId = detail.contract.conId;
      if (conId !== null) {
        setContractCache(`conid:${conId}`, [detail]);
      }
    }

    return {
      ok: true,
      cached: false,
      count: contractDetails.length,
      contractDetails,
    };
  } catch (error) {
    return errorResponse(error, REQUEST_RESOLUTION);
  }
}

const DELAYED_QUOTE_WINDOW_MS = 4_000;

const requestQuoteSnapshot = (
  ib: IBApi,
  contractArgs: ParsedContractArgs,
): { promise: Promise<QuoteSnapshot>; release: () => void } => {
  const reqId = connectionManager.nextRequestId();
  connectionManager.reserveMarketDataSubscription(reqId);

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    connectionManager.releaseMarketDataSubscription(reqId);
  };

  const promise = snapshotThenCancel<QuoteSnapshot>(
    ib,
    reqId,
    () => { ib.reqMktData(reqId, contractArgs.contract, '', true, false); },
    () => { try { ib.cancelMktData(reqId); } finally { release(); } },
    (tickMap) => buildQuoteFromTickMap(contractArgs.symbol, tickMap),
    DEFAULT_QUOTE_TIMEOUT_MS,
  );
  void promise.catch(() => {});

  return { promise, release };
};

const requestDelayedQuote = (
  ib: IBApi,
  contractArgs: ParsedContractArgs,
): { promise: Promise<QuoteSnapshot>; release: () => void } => {
  const reqId = connectionManager.nextRequestId();
  connectionManager.reserveMarketDataSubscription(reqId);

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    connectionManager.releaseMarketDataSubscription(reqId);
  };

  // For delayed data, subscribe in streaming mode and collect ticks for a fixed window.
  // IB's delayed snapshot mode is unreliable (tickSnapshotEnd fires before ticks arrive),
  // so we collect for DELAYED_QUOTE_WINDOW_MS then cancel and return whatever we have.
  const emitter = ib as unknown as {
    on(event: EventName, listener: (...args: unknown[]) => void): void;
    removeListener(event: EventName, listener: (...args: unknown[]) => void): void;
  };
  const tickMap = new Map<number, SnapshotTickValue>();
  const upsert = (tickType: unknown, update: Partial<SnapshotTickValue>) => {
    if (typeof tickType !== 'number') return;
    tickMap.set(tickType, { ...(tickMap.get(tickType) ?? {}), ...update });
  };

  const listeners: Array<[EventName, (...args: unknown[]) => void]> = [];
  const onTickPrice = (...args: unknown[]) => { if (typeof args[0] === 'number' && args[0] === reqId) upsert(args[1], { price: typeof args[2] === 'number' ? args[2] : undefined }); };
  const onTickSize = (...args: unknown[]) => { if (typeof args[0] === 'number' && args[0] === reqId) upsert(args[1], { size: typeof args[2] === 'number' ? args[2] : undefined }); };
  listeners.push([EventName.tickPrice, onTickPrice]);
  listeners.push([EventName.tickSize, onTickSize]);
  for (const [evt, fn] of listeners) emitter.on(evt, fn);

  const promise = new Promise<QuoteSnapshot>((resolve) => {
    setTimeout(() => {
      for (const [evt, fn] of listeners) emitter.removeListener(evt, fn);
      try { ib.cancelMktData(reqId); } catch { /* best effort */ }
      release();
      resolve(buildQuoteFromTickMap(contractArgs.symbol, tickMap));
    }, DELAYED_QUOTE_WINDOW_MS);
  });

  ib.reqMktData(reqId, contractArgs.contract, '', false, false);

  return { promise, release };
};

export async function getIbkrQuote(args: GetIbkrQuoteArgs = {}): Promise<ToolResponse> {
  let contractArgs: ParsedContractArgs;

  try {
    contractArgs = parseContractArgs(args);
  } catch (error) {
    return errorResponse(error, INPUT_RESOLUTION);
  }

  const readyClient = await ensureReadyClient();
  if (!readyClient.ok) {
    return readyClient;
  }

  const { ib } = readyClient;

  const first = requestQuoteSnapshot(ib, contractArgs);
  try {
    const quote = await first.promise;
    return { ok: true, ...quote };
  } catch (error) {
    first.release();

    // If the error is a market data subscription issue, retry with delayed data
    if (error instanceof IbRequestError && error.code === MARKET_DATA_SUBSCRIPTION_ERROR) {
      try {
        ib.reqMarketDataType(3); // 3 = delayed
      } catch {
        return errorResponse(error, REQUEST_RESOLUTION);
      }

      const retry = requestDelayedQuote(ib, contractArgs);
      try {
        const quote = await retry.promise;
        return { ok: true, delayed: true, ...quote };
      } catch (retryError) {
        retry.release();
        return errorResponse(retryError, REQUEST_RESOLUTION);
      }
    }

    return errorResponse(error, REQUEST_RESOLUTION);
  }
}

export async function getIbkrHistoricalData(
  args: GetIbkrHistoricalDataArgs = {},
): Promise<ToolResponse> {
  let contractArgs: ParsedContractArgs;
  let duration: string;
  let barSize: BarSizeSetting;
  let whatToShow: WhatToShowValue;
  let useRTH: boolean;
  let endDateTime: string;

  try {
    contractArgs = parseContractArgs(args);
    duration = parseDuration(args.duration);
    barSize = parseBarSize(args.barSize);
    whatToShow = parseWhatToShow(args.whatToShow, WhatToShow.TRADES);
    useRTH = parseBoolean(args.useRTH, true);
    endDateTime = toOptionalString(args.endDateTime) ?? '';
  } catch (error) {
    return errorResponse(error, INPUT_RESOLUTION);
  }

  const readyClient = await ensureReadyClient();
  if (!readyClient.ok) {
    return readyClient;
  }

  const { ib } = readyClient;
  const reqId = connectionManager.nextRequestId();

  const responsePromise = collectHistoricalBars(ib, reqId, DEFAULT_REQUEST_TIMEOUT_MS);
  void responsePromise.catch(() => {});

  try {
    await connectionManager.enqueueHistorical(() => {
      ib.reqHistoricalData(
        reqId,
        contractArgs.contract,
        endDateTime,
        duration,
        barSize,
        whatToShow,
        useRTH ? 1 : 0,
        1,
        false,
      );
      return undefined;
    });

    const bars = await responsePromise;
    return {
      ok: true,
      symbol: contractArgs.symbol,
      duration,
      barSize,
      whatToShow,
      useRTH,
      endDateTime: endDateTime || null,
      bars,
      count: bars.length,
    };
  } catch (error) {
    return errorResponse(error, REQUEST_RESOLUTION);
  } finally {
    void connectionManager
      .enqueueGeneral(() => {
        ib.cancelHistoricalData(reqId);
        return undefined;
      })
      .catch(() => {
        // Best-effort cancellation.
      });
  }
}

export async function getIbkrHistoricalTicks(
  args: GetIbkrHistoricalTicksArgs = {},
): Promise<ToolResponse> {
  let contractArgs: ParsedContractArgs;
  let startDateTime: string;
  let endDateTime: string;
  let numberOfTicks: number;
  let whatToShow: WhatToShowValue;

  try {
    contractArgs = parseContractArgs(args);
    startDateTime = toOptionalString(args.startDateTime) ?? '';
    endDateTime = toOptionalString(args.endDateTime) ?? '';
    // IB requires at least one of startDateTime or endDateTime; default to now (UTC) if neither provided
    if (!startDateTime && !endDateTime) {
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, '0');
      endDateTime = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())} ${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())} UTC`;
    }
    numberOfTicks = parseInteger(args.numberOfTicks, 'numberOfTicks', 1, 1000, 100);
    whatToShow = parseHistoricalTickWhatToShow(args.whatToShow);
  } catch (error) {
    return errorResponse(error, INPUT_RESOLUTION);
  }

  const readyClient = await ensureReadyClient();
  if (!readyClient.ok) {
    return readyClient;
  }

  const { ib } = readyClient;
  const reqId = connectionManager.nextRequestId();
  const responseEvent = getHistoricalTickEventName(whatToShow);

  const responsePromise = awaitSingle<{ ticks: Record<string, unknown>[]; done: boolean }>(
    ib,
    reqId,
    responseEvent,
    (...eventArgs) => {
      const ticks = Array.isArray(eventArgs[1]) ? eventArgs[1].map(normalizeTickPayload) : [];
      return {
        ticks,
        done: eventArgs[2] === true,
      };
    },
    DEFAULT_REQUEST_TIMEOUT_MS,
  );
  void responsePromise.catch(() => {});

  try {
    await connectionManager.enqueueHistorical(() => {
      ib.reqHistoricalTicks(
        reqId,
        contractArgs.contract,
        startDateTime,
        endDateTime,
        numberOfTicks,
        whatToShow,
        1,
        whatToShow === WhatToShow.BID_ASK,
      );
      return undefined;
    });

    const { ticks, done } = await responsePromise;
    return {
      ok: true,
      symbol: contractArgs.symbol,
      whatToShow,
      numberOfTicks,
      startDateTime: startDateTime || null,
      endDateTime: endDateTime || null,
      done,
      ticks,
      count: ticks.length,
    };
  } catch (error) {
    return errorResponse(error, REQUEST_RESOLUTION);
  }
}

export async function getIbkrMarketDepth(args: GetIbkrMarketDepthArgs = {}): Promise<ToolResponse> {
  let contractArgs: ParsedContractArgs;
  let numRows: number;

  try {
    contractArgs = parseContractArgs(args);
    numRows = parseInteger(args.numRows, 'numRows', 1, 20, 5);
  } catch (error) {
    return errorResponse(error, INPUT_RESOLUTION);
  }

  const readyClient = await ensureReadyClient();
  if (!readyClient.ok) {
    return readyClient;
  }

  const { ib } = readyClient;
  const reqId = connectionManager.nextRequestId();
  const isSmartDepth = false;

  try {
    connectionManager.reserveMarketDataSubscription(reqId);
  } catch (error) {
    return errorResponse(error, REQUEST_RESOLUTION);
  }

  const responsePromise = collectMarketDepthSnapshot(
    ib,
    reqId,
    numRows,
    DEFAULT_MARKET_DEPTH_WINDOW_MS,
  );
  void responsePromise.catch(() => {});

  try {
    await connectionManager.enqueueGeneral(() => {
      ib.reqMktDepth(reqId, contractArgs.contract, numRows, isSmartDepth);
      return undefined;
    });

    const snapshot = await responsePromise;
    return {
      ok: true,
      symbol: contractArgs.symbol,
      numRows,
      bids: snapshot.bids,
      asks: snapshot.asks,
    };
  } catch (error) {
    if (error instanceof IbRequestError && DEPTH_SUBSCRIPTION_CODES.has(error.code)) {
      return errorResponse(error, DEPTH_SUBSCRIPTION_RESOLUTION);
    }
    return errorResponse(error, REQUEST_RESOLUTION);
  } finally {
    void connectionManager
      .enqueueGeneral(() => {
        ib.cancelMktDepth(reqId, isSmartDepth);
        return undefined;
      })
      .catch(() => {
        // Best-effort cancellation.
      });

    connectionManager.releaseMarketDataSubscription(reqId);
  }
}
