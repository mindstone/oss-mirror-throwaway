import {
  EventName,
  SecType,
  type Contract,
  type Execution,
  type ExecutionFilter,
  type IBApi,
} from '@stoqey/ib';
import { connectionManager } from '../connection.js';
import { awaitSingle, collectUntilEnd } from '../helpers.js';

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

const DEFAULT_ACCOUNT_SUMMARY_TAGS = [
  'NetLiquidation',
  'TotalCashValue',
  'BuyingPower',
  'GrossPositionValue',
  'InitMarginReq',
  'MaintMarginReq',
  'AvailableFunds',
  'ExcessLiquidity',
  'Cushion',
  'EquityWithLoanValue',
  'SMA',
  'Leverage',
  'DayTradesRemaining',
  'LookAheadInitMarginReq',
  'LookAheadMaintMarginReq',
  'LookAheadAvailableFunds',
  'LookAheadExcessLiquidity',
  'HighestSeverity',
] as const;

const CONNECTION_RESOLUTION =
  'Ensure IB Gateway/TWS is running with API enabled, then reconnect using configure_ibkr_connection and retry.';
const INPUT_RESOLUTION = 'Fix the tool arguments and retry.';
const REQUEST_RESOLUTION =
  'Retry the request. If this persists, verify the account/contract values and confirm IB Gateway/TWS is healthy.';

const VALID_SEC_TYPES = new Set<string>(Object.values(SecType));

interface ToolErrorResponse {
  ok: false;
  error: string;
  resolution: string;
  [key: string]: unknown;
}

interface ReadyClientResult {
  ok: true;
  ib: IBApi;
}

type ReadyClient = ReadyClientResult | ToolErrorResponse;

export interface GetIbkrAccountSummaryArgs {
  tags?: unknown;
}

export interface GetIbkrPositionsArgs {
  account?: unknown;
}

export interface GetIbkrPnlArgs {
  account?: unknown;
}

export interface GetIbkrPositionPnlArgs {
  account?: unknown;
  conId?: unknown;
}

export interface GetIbkrExecutionsArgs {
  symbol?: unknown;
  secType?: unknown;
  time?: unknown;
  side?: unknown;
}

interface AccountSummaryRow {
  tag: string;
  value: string;
  currency: string;
  account: string;
}

interface PositionRow {
  account: string;
  symbol: string | null;
  secType: string | null;
  conId: number | null;
  position: number;
  avgCost: number | null;
}

interface PnlSnapshot {
  dailyPnL: number | null;
  unrealizedPnL: number | null;
  realizedPnL: number | null;
}

interface PositionPnlSnapshot extends PnlSnapshot {
  pos: number;
  value: number | null;
}

interface ExecutionRow {
  execId: string | null;
  time: string | null;
  account: string | null;
  exchange: string | null;
  side: string | null;
  shares: number | null;
  price: number | null;
  avgPrice: number | null;
  cumQty: number | null;
  orderId: number | null;
  symbol: string | null;
  secType: string | null;
}

type ToolSuccessResponse = {
  ok: true;
  [key: string]: unknown;
};

type ToolResponse = ToolSuccessResponse | ToolErrorResponse;

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

const parseConId = (value: unknown): number => {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error('conId must be a positive integer.');
  }
  return parsed;
};

const parseSummaryTags = (value: unknown): string[] => {
  if (value === undefined || value === null || value === '') {
    return [...DEFAULT_ACCOUNT_SUMMARY_TAGS];
  }

  if (Array.isArray(value)) {
    const tags = value
      .map((entry) => String(entry).trim())
      .filter((entry) => entry.length > 0);
    if (tags.length === 0) {
      throw new Error('tags array must include at least one tag.');
    }
    return tags;
  }

  if (typeof value === 'string') {
    const tags = value
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    if (tags.length === 0) {
      throw new Error('tags string must include at least one tag.');
    }
    return tags;
  }

  throw new Error('tags must be a comma-separated string or array of strings.');
};

const parseSecType = (value: unknown): SecType | undefined => {
  const normalized = toOptionalString(value);
  if (!normalized) {
    return undefined;
  }

  const upper = normalized.toUpperCase();
  if (!VALID_SEC_TYPES.has(upper)) {
    throw new Error(`secType must be one of: ${Array.from(VALID_SEC_TYPES).join(', ')}.`);
  }

  return upper as SecType;
};

const asContract = (value: unknown): Contract => {
  if (value && typeof value === 'object') {
    return value as Contract;
  }
  return {};
};

const asExecution = (value: unknown): Execution => {
  if (value && typeof value === 'object') {
    return value as Execution;
  }
  return {};
};

const asStringOrNull = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }
  return value;
};

const asNumberOrNull = (value: unknown): number | null => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  return value;
};

const asNumberOrZero = (value: unknown): number => {
  return asNumberOrNull(value) ?? 0;
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
    return { ok: true, ib: connectionManager.getClient() };
  } catch (error) {
    return errorResponse(error, CONNECTION_RESOLUTION);
  }
};

export async function getIbkrAccountSummary(args: GetIbkrAccountSummaryArgs = {}): Promise<ToolResponse> {
  let tags: string[];
  try {
    tags = parseSummaryTags(args.tags);
  } catch (error) {
    return errorResponse(error, INPUT_RESOLUTION);
  }

  const readyClient = await ensureReadyClient();
  if (!readyClient.ok) {
    return readyClient;
  }

  const { ib } = readyClient;
  const reqId = connectionManager.nextRequestId();

  const responsePromise = collectUntilEnd<AccountSummaryRow>(
    ib,
    reqId,
    EventName.accountSummary,
    EventName.accountSummaryEnd,
    (...eventArgs) => ({
      account: asStringOrNull(eventArgs[1]) ?? '',
      tag: asStringOrNull(eventArgs[2]) ?? '',
      value: asStringOrNull(eventArgs[3]) ?? '',
      currency: asStringOrNull(eventArgs[4]) ?? '',
    }),
    DEFAULT_REQUEST_TIMEOUT_MS,
  );
  void responsePromise.catch(() => {});

  try {
    await connectionManager.enqueueGeneral(() => {
      ib.reqAccountSummary(reqId, 'All', tags.join(','));
      return undefined;
    });

    const accountSummary = await responsePromise;

    return {
      ok: true,
      accountSummary,
      count: accountSummary.length,
      tags,
    };
  } catch (error) {
    return errorResponse(error, REQUEST_RESOLUTION);
  } finally {
    void connectionManager
      .enqueueGeneral(() => {
        ib.cancelAccountSummary(reqId);
        return undefined;
      })
      .catch(() => {
        // Best-effort cancellation.
      });
  }
}

export async function getIbkrPositions(args: GetIbkrPositionsArgs = {}): Promise<ToolResponse> {
  const accountFilter = toOptionalString(args.account);

  const readyClient = await ensureReadyClient();
  if (!readyClient.ok) {
    return readyClient;
  }

  const { ib } = readyClient;

  const responsePromise = collectUntilEnd<PositionRow>(
    ib,
    -1,
    EventName.position,
    EventName.positionEnd,
    (...eventArgs) => {
      const contract = asContract(eventArgs[1]);
      return {
        account: asStringOrNull(eventArgs[0]) ?? '',
        symbol: asStringOrNull(contract.symbol),
        secType: asStringOrNull(contract.secType),
        conId: asNumberOrNull(contract.conId),
        position: asNumberOrZero(eventArgs[2]),
        avgCost: asNumberOrNull(eventArgs[3]),
      };
    },
    DEFAULT_REQUEST_TIMEOUT_MS,
  );
  void responsePromise.catch(() => {});

  try {
    await connectionManager.enqueueGeneral(() => {
      ib.reqPositions();
      return undefined;
    });

    const positions = await responsePromise;
    const filteredPositions = accountFilter
      ? positions.filter((position) => position.account === accountFilter)
      : positions;

    return {
      ok: true,
      positions: filteredPositions,
      count: filteredPositions.length,
      account: accountFilter ?? null,
    };
  } catch (error) {
    return errorResponse(error, REQUEST_RESOLUTION);
  } finally {
    void connectionManager
      .enqueueGeneral(() => {
        ib.cancelPositions();
        return undefined;
      })
      .catch(() => {
        // Best-effort cancellation.
      });
  }
}

export async function getIbkrPnl(args: GetIbkrPnlArgs = {}): Promise<ToolResponse> {
  let account: string;
  try {
    account = requireString(args.account, 'account');
  } catch (error) {
    return errorResponse(error, INPUT_RESOLUTION);
  }

  const readyClient = await ensureReadyClient();
  if (!readyClient.ok) {
    return readyClient;
  }

  const { ib } = readyClient;
  const reqId = connectionManager.nextRequestId();

  const PNL_TIMEOUT_MS = 5_000;
  const responsePromise = awaitSingle<PnlSnapshot>(
    ib,
    reqId,
    EventName.pnl,
    (...eventArgs) => ({
      dailyPnL: asNumberOrNull(eventArgs[1]),
      unrealizedPnL: asNumberOrNull(eventArgs[2]),
      realizedPnL: asNumberOrNull(eventArgs[3]),
    }),
    PNL_TIMEOUT_MS,
  );
  void responsePromise.catch(() => {});

  try {
    await connectionManager.enqueueGeneral(() => {
      ib.reqPnL(reqId, account, null);
      return undefined;
    });

    let pnl: PnlSnapshot;
    try {
      pnl = await responsePromise;
    } catch {
      // PnL subscription may not emit if no positions exist; return zeros
      pnl = { dailyPnL: 0, unrealizedPnL: 0, realizedPnL: 0 };
    }

    return {
      ok: true,
      account,
      ...pnl,
    };
  } catch (error) {
    return errorResponse(error, REQUEST_RESOLUTION);
  } finally {
    void connectionManager
      .enqueueGeneral(() => {
        ib.cancelPnL(reqId);
        return undefined;
      })
      .catch(() => {
        // Best-effort cancellation.
      });
  }
}

export async function getIbkrPositionPnl(args: GetIbkrPositionPnlArgs = {}): Promise<ToolResponse> {
  let account: string;
  let conId: number;

  try {
    account = requireString(args.account, 'account');
    conId = parseConId(args.conId);
  } catch (error) {
    return errorResponse(error, INPUT_RESOLUTION);
  }

  const readyClient = await ensureReadyClient();
  if (!readyClient.ok) {
    return readyClient;
  }

  const { ib } = readyClient;
  const reqId = connectionManager.nextRequestId();

  const responsePromise = awaitSingle<PositionPnlSnapshot>(
    ib,
    reqId,
    EventName.pnlSingle,
    (...eventArgs) => ({
      pos: asNumberOrZero(eventArgs[1]),
      dailyPnL: asNumberOrNull(eventArgs[2]),
      unrealizedPnL: asNumberOrNull(eventArgs[3]),
      realizedPnL: asNumberOrNull(eventArgs[4]),
      value: asNumberOrNull(eventArgs[5]),
    }),
    DEFAULT_REQUEST_TIMEOUT_MS,
  );
  void responsePromise.catch(() => {});

  try {
    await connectionManager.enqueueGeneral(() => {
      ib.reqPnLSingle(reqId, account, null, conId);
      return undefined;
    });

    const positionPnl = await responsePromise;

    return {
      ok: true,
      account,
      conId,
      ...positionPnl,
    };
  } catch (error) {
    return errorResponse(error, REQUEST_RESOLUTION);
  } finally {
    void connectionManager
      .enqueueGeneral(() => {
        ib.cancelPnLSingle(reqId);
        return undefined;
      })
      .catch(() => {
        // Best-effort cancellation.
      });
  }
}

export async function getIbkrExecutions(args: GetIbkrExecutionsArgs = {}): Promise<ToolResponse> {
  let symbol: string | undefined;
  let secType: SecType | undefined;
  let time: string | undefined;
  let side: string | undefined;

  try {
    symbol = toOptionalString(args.symbol);
    secType = parseSecType(args.secType);
    time = toOptionalString(args.time);
    side = toOptionalString(args.side);
  } catch (error) {
    return errorResponse(error, INPUT_RESOLUTION);
  }

  const readyClient = await ensureReadyClient();
  if (!readyClient.ok) {
    return readyClient;
  }

  const { ib } = readyClient;
  const reqId = connectionManager.nextRequestId();

  const filter: ExecutionFilter = {};
  if (symbol) {
    filter.symbol = symbol;
  }
  if (secType) {
    filter.secType = secType;
  }
  if (time) {
    filter.time = time;
  }
  if (side) {
    filter.side = side;
  }

  const responsePromise = collectUntilEnd<ExecutionRow>(
    ib,
    reqId,
    EventName.execDetails,
    EventName.execDetailsEnd,
    (...eventArgs) => {
      const contract = asContract(eventArgs[1]);
      const execution = asExecution(eventArgs[2]);

      return {
        execId: asStringOrNull(execution.execId),
        time: asStringOrNull(execution.time),
        account: asStringOrNull(execution.acctNumber),
        exchange: asStringOrNull(execution.exchange) ?? asStringOrNull(contract.exchange),
        side: asStringOrNull(execution.side),
        shares: asNumberOrNull(execution.shares),
        price: asNumberOrNull(execution.price),
        avgPrice: asNumberOrNull(execution.avgPrice),
        cumQty: asNumberOrNull(execution.cumQty),
        orderId: asNumberOrNull(execution.orderId),
        symbol: asStringOrNull(contract.symbol),
        secType: asStringOrNull(contract.secType),
      };
    },
    DEFAULT_REQUEST_TIMEOUT_MS,
  );
  void responsePromise.catch(() => {});

  try {
    await connectionManager.enqueueGeneral(() => {
      ib.reqExecutions(reqId, filter);
      return undefined;
    });

    const executions = await responsePromise;

    return {
      ok: true,
      executions,
      count: executions.length,
      filters: {
        symbol: symbol ?? null,
        secType: secType ?? null,
        time: time ?? null,
        side: side ?? null,
      },
    };
  } catch (error) {
    return errorResponse(error, REQUEST_RESOLUTION);
  }
}
