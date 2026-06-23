import {
  EventName,
  OptionExerciseAction,
  OptionType,
  SecType,
  type Contract,
  type IBApi,
} from '@stoqey/ib';
import { connectionManager } from '../connection.js';
import { awaitSingle, collectUntilEnd } from '../helpers.js';
import { getIbkrContractDetails } from './market-data.js';

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const UNDERLYING_CONID_CACHE_LIMIT = 500;

const CONNECTION_RESOLUTION =
  'Ensure IB Gateway/TWS is running with API enabled, then reconnect using configure_ibkr_connection and retry.';
const INPUT_RESOLUTION = 'Fix the tool arguments and retry.';
const REQUEST_RESOLUTION =
  'Retry the request. If this persists, verify option contract parameters and confirm IB Gateway/TWS is healthy.';

const VALID_SEC_TYPES = new Set<string>(Object.values(SecType));

const UNDERLYING_CONID_CACHE = new Map<string, number>();

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

interface BaseOptionContractArgs {
  symbol?: unknown;
  secType?: unknown;
  strike?: unknown;
  right?: unknown;
  expiry?: unknown;
  exchange?: unknown;
  currency?: unknown;
  conId?: unknown;
}

export interface GetIbkrOptionChainArgs {
  symbol?: unknown;
  secType?: unknown;
  conId?: unknown;
  exchange?: unknown;
}

export interface CalculateIbkrImpliedVolatilityArgs extends BaseOptionContractArgs {
  optionPrice?: unknown;
  underlyingPrice?: unknown;
}

export interface CalculateIbkrOptionPriceArgs extends BaseOptionContractArgs {
  volatility?: unknown;
  underlyingPrice?: unknown;
}

export interface ExerciseIbkrOptionArgs extends BaseOptionContractArgs {
  action?: unknown;
  quantity?: unknown;
  account?: unknown;
  override?: unknown;
  confirm?: unknown;
}

interface ParsedUnderlyingArgs {
  symbol: string;
  secType: SecType;
  conId?: number;
  exchangeFilter: string;
}

interface ParsedOptionContractArgs {
  symbol: string;
  secType: SecType.OPT;
  strike: number;
  right: OptionType;
  expiry: string;
  exchange: string;
  currency: string;
  conId?: number;
  contract: Contract;
}

interface OptionChainRow {
  exchange: string;
  underlyingConId: number;
  tradingClass: string;
  multiplier: string;
  expirations: string[];
  strikes: number[];
}

interface OptionComputationResult {
  impliedVolatility: number | null;
  delta: number | null;
  optPrice: number | null;
  pvDividend: number | null;
  gamma: number | null;
  vega: number | null;
  theta: number | null;
  undPrice: number | null;
}

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

const parseUnderlyingSecType = (value: unknown): SecType => {
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

const parseOptionSecType = (value: unknown): SecType.OPT => {
  const normalized = toOptionalString(value);
  if (!normalized) {
    return SecType.OPT;
  }

  if (normalized.toUpperCase() !== SecType.OPT) {
    throw new Error('secType must be OPT for this tool.');
  }

  return SecType.OPT;
};

const parseRequiredNumber = (
  value: unknown,
  fieldName: string,
  minimumExclusive: number,
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

const parseBoolean = (value: unknown, defaultValue: boolean): boolean => {
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

  throw new Error('override must be a boolean value.');
};

const parseOptionRight = (value: unknown): OptionType => {
  const normalized = requireString(value, 'right').toUpperCase();

  if (normalized === 'C' || normalized === 'CALL') {
    return OptionType.Call;
  }

  if (normalized === 'P' || normalized === 'PUT') {
    return OptionType.Put;
  }

  throw new Error('right must be either C (call) or P (put).');
};

const parseRequiredInteger = (value: unknown, fieldName: string, minimum: number): number => {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw new Error(`${fieldName} must be an integer greater than or equal to ${minimum}.`);
  }

  return parsed;
};

const parseExchangeFilter = (value: unknown): string => {
  if (value === undefined || value === null) {
    return '';
  }

  return String(value).trim();
};

const parseUnderlyingArgs = (args: GetIbkrOptionChainArgs): ParsedUnderlyingArgs => {
  const symbol = requireString(args.symbol, 'symbol');
  const secType = parseUnderlyingSecType(args.secType);
  const conId = parseConId(args.conId);
  const exchangeFilter = parseExchangeFilter(args.exchange);

  return {
    symbol,
    secType,
    conId,
    exchangeFilter,
  };
};

const parseOptionContractArgs = (args: BaseOptionContractArgs): ParsedOptionContractArgs => {
  const symbol = requireString(args.symbol, 'symbol');
  const secType = parseOptionSecType(args.secType);
  const strike = parseRequiredNumber(args.strike, 'strike', 0);
  const right = parseOptionRight(args.right);
  const expiry = requireString(args.expiry, 'expiry');
  const exchange = toOptionalString(args.exchange) ?? 'SMART';
  const currency = toOptionalString(args.currency) ?? 'USD';
  const conId = parseConId(args.conId);

  const contract: Contract = {
    symbol,
    secType,
    strike,
    right,
    lastTradeDateOrContractMonth: expiry,
    exchange,
    currency,
  };

  if (conId) {
    contract.conId = conId;
  }

  return {
    symbol,
    secType,
    strike,
    right,
    expiry,
    exchange,
    currency,
    conId,
    contract,
  };
};

const asNumberOrNull = (value: unknown): number | null => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  return value;
};

const asStringOrEmpty = (value: unknown): string => {
  if (typeof value !== 'string') {
    return '';
  }
  return value;
};

const normalizeStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => (typeof item === 'string' ? item.trim() : String(item).trim()))
    .filter((item) => item.length > 0)
    .sort((a, b) => a.localeCompare(b));
};

const normalizeNumberArray = (value: unknown): number[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => {
      if (typeof item === 'number') {
        return item;
      }
      const parsed = Number.parseFloat(String(item));
      return Number.isFinite(parsed) ? parsed : Number.NaN;
    })
    .filter((item) => Number.isFinite(item))
    .sort((a, b) => a - b);
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

const buildUnderlyingConIdCacheKey = (
  symbol: string,
  secType: SecType,
  exchangeFilter: string,
): string => {
  return `symbol:${symbol.toUpperCase()}|secType:${secType}|exchange:${exchangeFilter}`;
};

const setUnderlyingConIdCache = (key: string, conId: number): void => {
  if (UNDERLYING_CONID_CACHE.has(key)) {
    UNDERLYING_CONID_CACHE.delete(key);
  }
  UNDERLYING_CONID_CACHE.set(key, conId);

  while (UNDERLYING_CONID_CACHE.size > UNDERLYING_CONID_CACHE_LIMIT) {
    const oldest = UNDERLYING_CONID_CACHE.keys().next().value;
    if (!oldest) {
      break;
    }
    UNDERLYING_CONID_CACHE.delete(oldest);
  }
};

const touchUnderlyingConIdCache = (key: string): number | null => {
  const cached = UNDERLYING_CONID_CACHE.get(key);
  if (cached === undefined) {
    return null;
  }

  UNDERLYING_CONID_CACHE.delete(key);
  UNDERLYING_CONID_CACHE.set(key, cached);
  return cached;
};

const readConIdFromContractDetail = (detail: unknown): number | null => {
  if (!detail || typeof detail !== 'object') {
    return null;
  }

  const detailRecord = detail as { contract?: unknown };
  if (!detailRecord.contract || typeof detailRecord.contract !== 'object') {
    return null;
  }

  const contract = detailRecord.contract as { conId?: unknown };
  if (typeof contract.conId !== 'number' || !Number.isInteger(contract.conId) || contract.conId <= 0) {
    return null;
  }

  return contract.conId;
};

const resolveUnderlyingConId = async (
  symbol: string,
  secType: SecType,
  exchangeFilter: string,
): Promise<number> => {
  const cacheKey = buildUnderlyingConIdCacheKey(symbol, secType, exchangeFilter);
  const cached = touchUnderlyingConIdCache(cacheKey);
  if (cached !== null) {
    return cached;
  }

  const detailsResponse = await getIbkrContractDetails({
    symbol,
    secType,
    exchange: exchangeFilter || undefined,
  });

  const detailsAsRecord = detailsResponse as Record<string, unknown>;
  if (detailsAsRecord.ok !== true) {
    const errorText =
      typeof detailsAsRecord.error === 'string'
        ? detailsAsRecord.error
        : `Unable to resolve conId for ${symbol}.`;
    throw new Error(errorText);
  }

  const contractDetails = Array.isArray(detailsAsRecord.contractDetails)
    ? detailsAsRecord.contractDetails
    : [];

  if (contractDetails.length === 0) {
    throw new Error(`Unable to resolve conId for ${symbol}: no matching contract details returned.`);
  }

  for (const detail of contractDetails) {
    const conId = readConIdFromContractDetail(detail);
    if (conId === null) {
      continue;
    }

    setUnderlyingConIdCache(cacheKey, conId);
    return conId;
  }

  throw new Error(`Unable to resolve conId for ${symbol}: no valid conId found in contract details.`);
};

const parseOptionComputation = (...eventArgs: unknown[]): OptionComputationResult => ({
  impliedVolatility: asNumberOrNull(eventArgs[2]),
  delta: asNumberOrNull(eventArgs[3]),
  optPrice: asNumberOrNull(eventArgs[4]),
  pvDividend: asNumberOrNull(eventArgs[5]),
  gamma: asNumberOrNull(eventArgs[6]),
  vega: asNumberOrNull(eventArgs[7]),
  theta: asNumberOrNull(eventArgs[8]),
  undPrice: asNumberOrNull(eventArgs[9]),
});

const parseExerciseAction = (value: unknown): OptionExerciseAction => {
  const normalized = requireString(value, 'action').toLowerCase();

  if (normalized === 'exercise') {
    return OptionExerciseAction.EXERCISE;
  }

  if (normalized === 'lapse') {
    return OptionExerciseAction.LAPSE;
  }

  throw new Error('action must be either "exercise" or "lapse".');
};

const assertConfirmed = (value: unknown): void => {
  if (value !== true) {
    throw new Error('confirm must be true to submit an option exercise/lapse request.');
  }
};

export async function getIbkrOptionChain(args: GetIbkrOptionChainArgs = {}): Promise<ToolResponse> {
  let parsed: ParsedUnderlyingArgs;

  try {
    parsed = parseUnderlyingArgs(args);
  } catch (error) {
    return errorResponse(error, INPUT_RESOLUTION);
  }

  const readyClient = await ensureReadyClient();
  if (!readyClient.ok) {
    return readyClient;
  }

  const { ib } = readyClient;

  let underlyingConId = parsed.conId;

  try {
    if (!underlyingConId) {
      underlyingConId = await resolveUnderlyingConId(
        parsed.symbol,
        parsed.secType,
        parsed.exchangeFilter,
      );
    }
  } catch (error) {
    return errorResponse(error, REQUEST_RESOLUTION);
  }

  if (!underlyingConId) {
    return errorResponse('Unable to resolve underlying conId for option chain request.', REQUEST_RESOLUTION);
  }

  const resolvedUnderlyingConId = underlyingConId;

  const reqId = connectionManager.nextRequestId();

  const responsePromise = collectUntilEnd<OptionChainRow>(
    ib,
    reqId,
    EventName.securityDefinitionOptionParameter,
    EventName.securityDefinitionOptionParameterEnd,
    (...eventArgs) => {
      const rowUnderlyingConId = asNumberOrNull(eventArgs[2]);

      return {
        exchange: asStringOrEmpty(eventArgs[1]),
        underlyingConId: rowUnderlyingConId ?? resolvedUnderlyingConId,
        tradingClass: asStringOrEmpty(eventArgs[3]),
        multiplier: asStringOrEmpty(eventArgs[4]),
        expirations: normalizeStringArray(eventArgs[5]),
        strikes: normalizeNumberArray(eventArgs[6]),
      };
    },
    DEFAULT_REQUEST_TIMEOUT_MS,
  );
  void responsePromise.catch(() => {});

  try {
    await connectionManager.enqueueGeneral(() => {
      ib.reqSecDefOptParams(
        reqId,
        parsed.symbol,
        parsed.exchangeFilter,
        parsed.secType,
        resolvedUnderlyingConId,
      );
      return undefined;
    });

    const chains = await responsePromise;

    return {
      ok: true,
      symbol: parsed.symbol,
      secType: parsed.secType,
      underlyingConId: resolvedUnderlyingConId,
      exchange: parsed.exchangeFilter,
      chains,
      count: chains.length,
    };
  } catch (error) {
    return errorResponse(error, REQUEST_RESOLUTION);
  }
}

export async function calculateIbkrImpliedVolatility(
  args: CalculateIbkrImpliedVolatilityArgs = {},
): Promise<ToolResponse> {
  let contractArgs: ParsedOptionContractArgs;
  let optionPrice: number;
  let underlyingPrice: number;

  try {
    contractArgs = parseOptionContractArgs(args);
    optionPrice = parseRequiredNumber(args.optionPrice, 'optionPrice', 0);
    underlyingPrice = parseRequiredNumber(args.underlyingPrice, 'underlyingPrice', 0);
  } catch (error) {
    return errorResponse(error, INPUT_RESOLUTION);
  }

  const readyClient = await ensureReadyClient();
  if (!readyClient.ok) {
    return readyClient;
  }

  const { ib } = readyClient;
  const reqId = connectionManager.nextRequestId();

  const responsePromise = awaitSingle<OptionComputationResult>(
    ib,
    reqId,
    EventName.tickOptionComputation,
    (...eventArgs) => parseOptionComputation(...eventArgs),
    DEFAULT_REQUEST_TIMEOUT_MS,
  );
  void responsePromise.catch(() => {});

  try {
    await connectionManager.enqueueGeneral(() => {
      ib.calculateImpliedVolatility(reqId, contractArgs.contract, optionPrice, underlyingPrice);
      return undefined;
    });

    const result = await responsePromise;

    return {
      ok: true,
      ...result,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : '';
    if (msg.includes('timed out')) {
      return errorResponse(
        'Implied volatility calculation timed out. This typically happens when the market is closed or the option contract is illiquid.',
        'Retry during market hours with a liquid option contract.',
      );
    }
    return errorResponse(error, REQUEST_RESOLUTION);
  } finally {
    void connectionManager
      .enqueueGeneral(() => {
        ib.cancelCalculateImpliedVolatility(reqId);
        return undefined;
      })
      .catch(() => {
        // Best-effort cancellation.
      });
  }
}

export async function calculateIbkrOptionPrice(
  args: CalculateIbkrOptionPriceArgs = {},
): Promise<ToolResponse> {
  let contractArgs: ParsedOptionContractArgs;
  let volatility: number;
  let underlyingPrice: number;

  try {
    contractArgs = parseOptionContractArgs(args);
    volatility = parseRequiredNumber(args.volatility, 'volatility', 0);
    underlyingPrice = parseRequiredNumber(args.underlyingPrice, 'underlyingPrice', 0);
  } catch (error) {
    return errorResponse(error, INPUT_RESOLUTION);
  }

  const readyClient = await ensureReadyClient();
  if (!readyClient.ok) {
    return readyClient;
  }

  const { ib } = readyClient;
  const reqId = connectionManager.nextRequestId();

  const responsePromise = awaitSingle<OptionComputationResult>(
    ib,
    reqId,
    EventName.tickOptionComputation,
    (...eventArgs) => parseOptionComputation(...eventArgs),
    DEFAULT_REQUEST_TIMEOUT_MS,
  );
  void responsePromise.catch(() => {});

  try {
    await connectionManager.enqueueGeneral(() => {
      ib.calculateOptionPrice(reqId, contractArgs.contract, volatility, underlyingPrice);
      return undefined;
    });

    const result = await responsePromise;

    return {
      ok: true,
      optPrice: result.optPrice,
      delta: result.delta,
      impliedVolatility: result.impliedVolatility,
      pvDividend: result.pvDividend,
      gamma: result.gamma,
      vega: result.vega,
      theta: result.theta,
      undPrice: result.undPrice,
    };
  } catch (error) {
    return errorResponse(error, REQUEST_RESOLUTION);
  } finally {
    void connectionManager
      .enqueueGeneral(() => {
        ib.cancelCalculateOptionPrice(reqId);
        return undefined;
      })
      .catch(() => {
        // Best-effort cancellation.
      });
  }
}

export async function exerciseIbkrOption(args: ExerciseIbkrOptionArgs = {}): Promise<ToolResponse> {
  let contractArgs: ParsedOptionContractArgs;
  let exerciseAction: OptionExerciseAction;
  let quantity: number;
  let account: string;
  let override: boolean;

  try {
    contractArgs = parseOptionContractArgs(args);
    exerciseAction = parseExerciseAction(args.action);
    quantity = parseRequiredInteger(args.quantity, 'quantity', 1);
    account = requireString(args.account, 'account');
    override = parseBoolean(args.override, false);
    assertConfirmed(args.confirm);
  } catch (error) {
    return errorResponse(error, INPUT_RESOLUTION);
  }

  const readyClient = await ensureReadyClient();
  if (!readyClient.ok) {
    return readyClient;
  }

  const { ib } = readyClient;
  const reqId = connectionManager.nextRequestId();

  try {
    await connectionManager.enqueueGeneral(() => {
      ib.exerciseOptions(
        reqId,
        contractArgs.contract,
        exerciseAction,
        quantity,
        account,
        override ? 1 : 0,
      );
      return undefined;
    });

    return {
      ok: true,
      message: 'Option exercise/lapse submitted',
      action: exerciseAction === OptionExerciseAction.EXERCISE ? 'exercise' : 'lapse',
      quantity,
      account,
      warning:
        connectionManager.getMode() === 'live'
          ? 'Live mode is enabled: this exercise/lapse request was sent to your live account.'
          : undefined,
    };
  } catch (error) {
    return errorResponse(error, REQUEST_RESOLUTION);
  }
}
