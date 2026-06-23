/**
 * IBKR MCP server tests (Stage 7).
 *
 * Uses a Node-level mock of `@stoqey/ib` with EventEmitter behavior so no live IB Gateway is required.
 * Run: npx vitest run resources/mcp/ibkr/test-mcp.test.ts
 */

import { EventEmitter } from 'node:events';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

type JsonRecord = Record<string, unknown>;
type MethodHandler = (api: MockIBApi, ...args: unknown[]) => void;
type RequestHandler = (request: { params: { name: string; arguments?: JsonRecord } }) => Promise<{
  content: Array<{ type: string; text: string }>;
}>;

const requestHandlers = new Map<unknown, (...args: unknown[]) => unknown>();
const methodHandlers = new Map<string, MethodHandler>();
const ibInstances: MockIBApi[] = [];

let connectHandler: ((api: MockIBApi, clientId: number) => void) | null = null;

const EventName = {
  connected: 'connected',
  nextValidId: 'nextValidId',
  disconnected: 'disconnected',
  connectionClosed: 'connectionClosed',
  error: 'error',
  managedAccounts: 'managedAccounts',
  currentTime: 'currentTime',
  accountSummary: 'accountSummary',
  accountSummaryEnd: 'accountSummaryEnd',
  position: 'position',
  positionEnd: 'positionEnd',
  pnl: 'pnl',
  pnlSingle: 'pnlSingle',
  execDetails: 'execDetails',
  execDetailsEnd: 'execDetailsEnd',
  symbolSamples: 'symbolSamples',
  contractDetails: 'contractDetails',
  contractDetailsEnd: 'contractDetailsEnd',
  tickPrice: 'tickPrice',
  tickSize: 'tickSize',
  tickString: 'tickString',
  tickGeneric: 'tickGeneric',
  tickSnapshotEnd: 'tickSnapshotEnd',
  historicalData: 'historicalData',
  historicalTicks: 'historicalTicks',
  historicalTicksBidAsk: 'historicalTicksBidAsk',
  historicalTicksLast: 'historicalTicksLast',
  updateMktDepth: 'updateMktDepth',
  updateMktDepthL2: 'updateMktDepthL2',
  securityDefinitionOptionParameter: 'securityDefinitionOptionParameter',
  securityDefinitionOptionParameterEnd: 'securityDefinitionOptionParameterEnd',
  tickOptionComputation: 'tickOptionComputation',
  orderStatus: 'orderStatus',
  openOrder: 'openOrder',
  openOrderEnd: 'openOrderEnd',
  completedOrder: 'completedOrder',
  completedOrdersEnd: 'completedOrdersEnd',
  scannerParameters: 'scannerParameters',
  scannerData: 'scannerData',
  scannerDataEnd: 'scannerDataEnd',
  newsProviders: 'newsProviders',
  historicalNews: 'historicalNews',
  historicalNewsEnd: 'historicalNewsEnd',
  newsArticle: 'newsArticle',
} as const;

const SecType = {
  STK: 'STK',
  OPT: 'OPT',
  FUT: 'FUT',
  CASH: 'CASH',
} as const;

const OrderAction = {
  BUY: 'BUY',
  SELL: 'SELL',
} as const;

const OrderType = {
  MKT: 'MKT',
  LMT: 'LMT',
  STP: 'STP',
  STP_LMT: 'STP_LMT',
  MOC: 'MOC',
  LOC: 'LOC',
  TRAIL: 'TRAIL',
  TRAIL_LIMIT: 'TRAIL_LIMIT',
  REL: 'REL',
} as const;

const TimeInForce = {
  DAY: 'DAY',
  GTC: 'GTC',
  IOC: 'IOC',
  FOK: 'FOK',
} as const;

const OrderStatus = {
  Submitted: 'Submitted',
  PreSubmitted: 'PreSubmitted',
  Filled: 'Filled',
  Cancelled: 'Cancelled',
  ApiCancelled: 'ApiCancelled',
  Inactive: 'Inactive',
  Unknown: 'Unknown',
} as const;

const BarSizeSetting = {
  HOURS_ONE: '1 hour',
  DAY_ONE: '1 day',
} as const;

const WhatToShow = {
  TRADES: 'TRADES',
  MIDPOINT: 'MIDPOINT',
  BID_ASK: 'BID_ASK',
} as const;

const OptionType = {
  Call: 'CALL',
  Put: 'PUT',
} as const;

const OptionExerciseAction = {
  EXERCISE: 1,
  LAPSE: 2,
} as const;

// Reverse-mapped enum (like the real @stoqey/ib ScanCode)
const ScanCode: Record<string | number, string | number> = {
  TOP_PERC_GAIN: 0, TOP_PERC_LOSE: 1, MOST_ACTIVE: 2,
  0: 'TOP_PERC_GAIN', 1: 'TOP_PERC_LOSE', 2: 'MOST_ACTIVE',
};

const DEFAULT_WHAT_IF_STATE = {
  initMarginBefore: 10_000,
  initMarginChange: 500,
  initMarginAfter: 10_500,
  maintMarginBefore: 8_000,
  maintMarginChange: 400,
  maintMarginAfter: 8_400,
  commission: 1.25,
  minCommission: 1,
  maxCommission: 2,
};

const scheduleEmit = (
  api: EventEmitter,
  eventName: string,
  args: unknown[] = [],
  delayMs: number = 0,
): void => {
  setTimeout(() => {
    api.emit(eventName, ...args);
  }, delayMs);
};

class MockIBApi extends EventEmitter {
  public readonly options: Record<string, unknown>;

  constructor(options: Record<string, unknown>) {
    super();
    this.options = options;
    ibInstances.push(this);
  }

  get isConnected(): boolean {
    return true;
  }

  get serverVersion(): number {
    return 178;
  }

  private invoke(methodName: string, args: unknown[], fallback?: () => void): void {
    const custom = methodHandlers.get(methodName);
    if (custom) {
      custom(this, ...args);
      return;
    }
    fallback?.();
  }

  connect = vi.fn((clientId: number) => {
    if (connectHandler) {
      connectHandler(this, clientId);
      return;
    }

    scheduleEmit(this, EventName.connected);
    scheduleEmit(this, EventName.nextValidId, [7_001], 1);
  });

  disconnect = vi.fn(() => {
    this.invoke('disconnect', []);
  });

  reqManagedAccts = vi.fn(() => {
    this.invoke('reqManagedAccts', [], () => {
      scheduleEmit(this, EventName.managedAccounts, ['DU111111,DU222222']);
    });
  });

  reqCurrentTime = vi.fn(() => {
    this.invoke('reqCurrentTime', [], () => {
      scheduleEmit(this, EventName.currentTime, [1_710_000_000]);
    });
  });

  reqAccountSummary = vi.fn((reqId: number) => {
    this.invoke('reqAccountSummary', [reqId], () => {
      scheduleEmit(this, EventName.accountSummary, [reqId, 'DU111111', 'NetLiquidation', '150000', 'USD']);
      scheduleEmit(this, EventName.accountSummaryEnd, [reqId], 1);
    });
  });

  cancelAccountSummary = vi.fn((reqId: number) => {
    this.invoke('cancelAccountSummary', [reqId]);
  });

  reqPositions = vi.fn(() => {
    this.invoke('reqPositions', [], () => {
      scheduleEmit(this, EventName.position, ['DU111111', { symbol: 'AAPL', secType: 'STK', conId: 265598 }, 10, 190]);
      scheduleEmit(this, EventName.positionEnd, [], 1);
    });
  });

  cancelPositions = vi.fn(() => {
    this.invoke('cancelPositions', []);
  });

  reqPnL = vi.fn((reqId: number) => {
    this.invoke('reqPnL', [reqId], () => {
      scheduleEmit(this, EventName.pnl, [reqId, 100, 200, -50]);
    });
  });

  cancelPnL = vi.fn((reqId: number) => {
    this.invoke('cancelPnL', [reqId]);
  });

  reqPnLSingle = vi.fn((reqId: number) => {
    this.invoke('reqPnLSingle', [reqId], () => {
      scheduleEmit(this, EventName.pnlSingle, [reqId, 5, 100, 80, 20, 950]);
    });
  });

  cancelPnLSingle = vi.fn((reqId: number) => {
    this.invoke('cancelPnLSingle', [reqId]);
  });

  reqExecutions = vi.fn((reqId: number) => {
    this.invoke('reqExecutions', [reqId], () => {
      scheduleEmit(this, EventName.execDetails, [reqId, { symbol: 'AAPL', secType: 'STK' }, { execId: 'E1' }]);
      scheduleEmit(this, EventName.execDetailsEnd, [reqId], 1);
    });
  });

  reqMatchingSymbols = vi.fn((reqId: number, pattern: string) => {
    this.invoke('reqMatchingSymbols', [reqId, pattern], () => {
      scheduleEmit(this, EventName.symbolSamples, [
        reqId,
        [
          {
            contract: {
              conId: 265598,
              symbol: pattern.toUpperCase(),
              secType: 'STK',
              primaryExch: 'NASDAQ',
              currency: 'USD',
              description: `${pattern.toUpperCase()} Corp`,
            },
          },
        ],
      ]);
    });
  });

  reqContractDetails = vi.fn((reqId: number) => {
    this.invoke('reqContractDetails', [reqId], () => {
      scheduleEmit(this, EventName.contractDetails, [reqId, { contract: { conId: 265598, symbol: 'AAPL', secType: 'STK' } }]);
      scheduleEmit(this, EventName.contractDetailsEnd, [reqId], 1);
    });
  });

  reqMktData = vi.fn((reqId: number) => {
    this.invoke('reqMktData', [reqId], () => {
      scheduleEmit(this, EventName.tickPrice, [reqId, 1, 190.1]);
      scheduleEmit(this, EventName.tickPrice, [reqId, 2, 190.2], 1);
      scheduleEmit(this, EventName.tickPrice, [reqId, 4, 190.15], 2);
      scheduleEmit(this, EventName.tickSize, [reqId, 0, 100], 3);
      scheduleEmit(this, EventName.tickSize, [reqId, 3, 120], 4);
      scheduleEmit(this, EventName.tickSnapshotEnd, [reqId], 5);
    });
  });

  cancelMktData = vi.fn((reqId: number) => {
    this.invoke('cancelMktData', [reqId]);
  });

  reqHistoricalData = vi.fn((reqId: number) => {
    this.invoke('reqHistoricalData', [reqId], () => {
      scheduleEmit(this, EventName.historicalData, [reqId, '20260321 15:30:00', 100, 101, 99, 100.5, 1000, 10, 100.4]);
      scheduleEmit(this, EventName.historicalData, [reqId, 'finished-20260321 15:31:00'], 1);
    });
  });

  cancelHistoricalData = vi.fn((reqId: number) => {
    this.invoke('cancelHistoricalData', [reqId]);
  });

  reqHistoricalTicks = vi.fn((reqId: number) => {
    this.invoke('reqHistoricalTicks', [reqId], () => {
      scheduleEmit(this, EventName.historicalTicksLast, [reqId, [], true]);
    });
  });

  reqMktDepth = vi.fn((reqId: number) => {
    this.invoke('reqMktDepth', [reqId], () => {
      scheduleEmit(this, EventName.updateMktDepth, [reqId, 0, 0, 0, 190.1, 120]);
    });
  });

  cancelMktDepth = vi.fn((reqId: number) => {
    this.invoke('cancelMktDepth', [reqId]);
  });

  reqSecDefOptParams = vi.fn((reqId: number) => {
    this.invoke('reqSecDefOptParams', [reqId], () => {
      scheduleEmit(this, EventName.securityDefinitionOptionParameterEnd, [reqId]);
    });
  });

  calculateImpliedVolatility = vi.fn((reqId: number) => {
    this.invoke('calculateImpliedVolatility', [reqId], () => {
      scheduleEmit(this, EventName.tickOptionComputation, [reqId, 0, 0.25, 0.5, 1, 0, 0.1, 0.2, -0.01, 190]);
    });
  });

  cancelCalculateImpliedVolatility = vi.fn((reqId: number) => {
    this.invoke('cancelCalculateImpliedVolatility', [reqId]);
  });

  calculateOptionPrice = vi.fn((reqId: number) => {
    this.invoke('calculateOptionPrice', [reqId], () => {
      scheduleEmit(this, EventName.tickOptionComputation, [reqId, 0, 0.25, 0.5, 1, 0, 0.1, 0.2, -0.01, 190]);
    });
  });

  cancelCalculateOptionPrice = vi.fn((reqId: number) => {
    this.invoke('cancelCalculateOptionPrice', [reqId]);
  });

  exerciseOptions = vi.fn((reqId: number) => {
    this.invoke('exerciseOptions', [reqId]);
  });

  placeOrder = vi.fn((orderId: number, contract: Record<string, unknown>, order: Record<string, unknown>) => {
    this.invoke('placeOrder', [orderId, contract, order], () => {
      if (order?.whatIf === true) {
        scheduleEmit(this, EventName.openOrder, [orderId, contract, order, DEFAULT_WHAT_IF_STATE]);
        return;
      }

      const quantity = typeof order?.totalQuantity === 'number' ? order.totalQuantity : 0;
      scheduleEmit(this, EventName.orderStatus, [orderId, OrderStatus.Submitted, 0, quantity, 0]);
    });
  });

  cancelOrder = vi.fn((orderId: number) => {
    this.invoke('cancelOrder', [orderId], () => {
      scheduleEmit(this, EventName.orderStatus, [orderId, OrderStatus.Cancelled, 0, 0, 0]);
    });
  });

  reqGlobalCancel = vi.fn(() => {
    this.invoke('reqGlobalCancel', []);
  });

  reqAllOpenOrders = vi.fn(() => {
    this.invoke('reqAllOpenOrders', [], () => {
      scheduleEmit(this, EventName.openOrder, [
        7001,
        { symbol: 'AAPL', secType: 'STK' },
        { action: 'BUY', totalQuantity: 5, orderType: 'MKT', filledQuantity: 0 },
        { status: 'Submitted' },
      ]);
      scheduleEmit(this, EventName.openOrderEnd, [], 1);
    });
  });

  reqCompletedOrders = vi.fn(() => {
    this.invoke('reqCompletedOrders', [], () => {
      scheduleEmit(this, EventName.completedOrder, [
        { symbol: 'AAPL' },
        { orderId: 7000, action: 'BUY', totalQuantity: 1, orderType: 'MKT' },
        { completedStatus: 'Filled', completedTime: '20260321-15:30:00' },
      ]);
      scheduleEmit(this, EventName.completedOrdersEnd, [], 1);
    });
  });

  reqIds = vi.fn(() => {
    this.invoke('reqIds', []);
  });

  reqScannerParameters = vi.fn(() => {
    this.invoke('reqScannerParameters', []);
  });

  reqScannerSubscription = vi.fn((reqId: number) => {
    this.invoke('reqScannerSubscription', [reqId]);
  });

  cancelScannerSubscription = vi.fn((reqId: number) => {
    this.invoke('cancelScannerSubscription', [reqId]);
  });

  reqNewsProviders = vi.fn(() => {
    this.invoke('reqNewsProviders', []);
  });

  reqHistoricalNews = vi.fn((reqId: number) => {
    this.invoke('reqHistoricalNews', [reqId]);
  });

  reqNewsArticle = vi.fn((reqId: number) => {
    this.invoke('reqNewsArticle', [reqId]);
  });
}

const ListToolsRequestSchema = Symbol('ListToolsRequestSchema');
const CallToolRequestSchema = Symbol('CallToolRequestSchema');

vi.mock('@stoqey/ib', () => ({
  EventName,
  IBApi: MockIBApi,
  SecType,
  OrderAction,
  OrderType,
  OrderStatus,
  TimeInForce,
  BarSizeSetting,
  WhatToShow,
  OptionType,
  OptionExerciseAction,
  ScanCode,
}));

vi.mock('@modelcontextprotocol/sdk/types.js', () => ({
  ListToolsRequestSchema,
  CallToolRequestSchema,
}));

vi.mock('@modelcontextprotocol/sdk/server/index.js', () => {
  class MockServer {
    setRequestHandler = vi.fn((schema: unknown, handler: (...args: unknown[]) => unknown) => {
      requestHandlers.set(schema, handler);
    });

    connect = vi.fn(async () => undefined);
  }

  return { Server: MockServer };
});

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: class MockStdioServerTransport {},
}));

process.env.IBKR_MODE = 'paper';
process.env.IBKR_HOST = '127.0.0.1';
process.env.IBKR_PORT = '4002';
process.env.IBKR_CLIENT_ID = '1';

await import('./src/index.js');
const { connectionManager } = await import('./src/connection.js');

const onMethod = (name: string, handler: MethodHandler): void => {
  methodHandlers.set(name, handler);
};

const setConnectHandler = (handler: ((api: MockIBApi, clientId: number) => void) | null): void => {
  connectHandler = handler;
};

const getCallToolHandler = (): RequestHandler => {
  const handler = requestHandlers.get(CallToolRequestSchema);
  if (!handler) {
    throw new Error('CallTool handler was not registered by IBKR MCP server.');
  }

  return handler as RequestHandler;
};

const callTool = async (name: string, args: JsonRecord = {}): Promise<JsonRecord> => {
  const handler = getCallToolHandler();
  const response = await handler({ params: { name, arguments: args } });
  const text = response.content.find((item) => item.type === 'text')?.text;

  if (!text) {
    throw new Error(`Tool ${name} returned no text content.`);
  }

  return JSON.parse(text) as JsonRecord;
};

beforeEach(() => {
  vi.useRealTimers();
  methodHandlers.clear();
  setConnectHandler(null);
  ibInstances.length = 0;
  connectionManager.disconnect();
});

afterAll(() => {
  vi.useRealTimers();
  connectionManager.disconnect();
});

describe('IBKR MCP Stage 7 tests', () => {
  describe('Connection & status tools', () => {
    it('get_ibkr_connection_status returns connected state and paper mode after connecting', async () => {
      await callTool('list_ibkr_accounts');

      const result = await callTool('get_ibkr_connection_status');
      const status = result.status as JsonRecord;

      expect(result.ok).toBe(true);
      expect(result.mode).toBe('paper');
      expect(status.connected).toBe(true);
      expect(status.ready).toBe(true);
      expect(status.mode).toBe('paper');
      expect(typeof result.serverTime === 'number' || result.serverTime === null).toBe(true);
    });

    it('configure_ibkr_connection updates host/port/clientId but keeps mode immutable', async () => {
      const result = await callTool('configure_ibkr_connection', {
        host: '10.1.2.3',
        port: 5001,
        clientId: 77,
      });

      const status = result.status as JsonRecord;

      expect(result.ok).toBe(true);
      expect(result.mode).toBe('paper');
      expect(status.host).toBe('10.1.2.3');
      expect(status.port).toBe(5001);
      expect(status.clientId).toBe(77);
      expect(status.mode).toBe('paper');
    });

    it('configure_ibkr_connection rejects runtime mode switching', async () => {
      const result = await callTool('configure_ibkr_connection', { mode: 'live' });

      expect(result.ok).toBe(false);
      expect(String(result.error)).toContain('Runtime mode switching is disabled');
    });

    it('get_ibkr_connection_status reflects clientId after configure', async () => {
      // Reset to known state
      await callTool('configure_ibkr_connection', { host: '127.0.0.1', port: 4002, clientId: 1 });

      const result = await callTool('get_ibkr_connection_status');
      const status = result.status as JsonRecord;

      expect(status.clientId).toBe(1);
      expect(status.host).toBe('127.0.0.1');
      expect(status.port).toBe(4002);
    });

    it('configure_ibkr_connection updates only clientId when only clientId provided', async () => {
      // Reset to known state first
      await callTool('configure_ibkr_connection', { host: '127.0.0.1', port: 4002, clientId: 1 });

      // Now update only clientId
      const result = await callTool('configure_ibkr_connection', { clientId: 42 });
      const status = result.status as JsonRecord;

      expect(result.ok).toBe(true);
      expect(status.clientId).toBe(42);
      expect(status.host).toBe('127.0.0.1');
      expect(status.port).toBe(4002);
      expect(status.mode).toBe('paper');
    });

    it('configure_ibkr_connection rejects negative clientId', async () => {
      const result = await callTool('configure_ibkr_connection', { clientId: -1 });
      expect(result.ok).toBe(false);
      expect(String(result.error)).toContain('clientId');
    });

    it('configure_ibkr_connection accepts clientId 0', async () => {
      const result = await callTool('configure_ibkr_connection', { clientId: 0 });
      const status = result.status as JsonRecord;

      expect(result.ok).toBe(true);
      expect(status.clientId).toBe(0);
    });

    it('configure_ibkr_connection rejects non-integer port', async () => {
      const result = await callTool('configure_ibkr_connection', { port: 3.14 });
      expect(result.ok).toBe(false);
      expect(String(result.error)).toContain('port');
    });

    it('configure_ibkr_connection rejects empty host', async () => {
      const result = await callTool('configure_ibkr_connection', { host: '' });
      expect(result.ok).toBe(false);
      expect(String(result.error)).toContain('host');
    });

    it('configure_ibkr_connection passes clientId to IBApi.connect', async () => {
      let capturedClientId: number | null = null;
      setConnectHandler((api, clientId) => {
        capturedClientId = clientId;
        scheduleEmit(api, EventName.connected);
        scheduleEmit(api, EventName.nextValidId, [8_001], 1);
      });

      await callTool('configure_ibkr_connection', { clientId: 99 });
      expect(capturedClientId).toBe(99);
    });

    it('list_ibkr_accounts returns mock account IDs', async () => {
      onMethod('reqManagedAccts', (api) => {
        scheduleEmit(api, EventName.managedAccounts, ['DU900001,DU900002,DU900003']);
      });

      const result = await callTool('list_ibkr_accounts');

      expect(result.ok).toBe(true);
      expect(result.accounts).toEqual(['DU900001', 'DU900002', 'DU900003']);
      expect(result.count).toBe(3);
    });
  });

  describe('Account tools (collectUntilEnd)', () => {
    it('get_ibkr_account_summary collects multiple summary rows', async () => {
      onMethod('reqAccountSummary', (api, reqId) => {
        scheduleEmit(api, EventName.accountSummary, [reqId, 'DU111111', 'NetLiquidation', '150000', 'USD']);
        scheduleEmit(api, EventName.accountSummary, [reqId, 'DU111111', 'BuyingPower', '300000', 'USD'], 1);
        scheduleEmit(api, EventName.accountSummaryEnd, [reqId], 2);
      });

      const result = await callTool('get_ibkr_account_summary', {
        tags: ['NetLiquidation', 'BuyingPower'],
      });

      const rows = result.accountSummary as Array<JsonRecord>;

      expect(result.ok).toBe(true);
      expect(rows).toHaveLength(2);
      expect(rows[0]?.tag).toBe('NetLiquidation');
      expect(rows[1]?.tag).toBe('BuyingPower');
    });

    it('get_ibkr_positions collects positions until positionEnd', async () => {
      onMethod('reqPositions', (api) => {
        scheduleEmit(api, EventName.position, ['DU111111', { symbol: 'AAPL', secType: 'STK', conId: 265598 }, 5, 180]);
        scheduleEmit(api, EventName.position, ['DU222222', { symbol: 'MSFT', secType: 'STK', conId: 272093 }, 8, 320], 1);
        scheduleEmit(api, EventName.positionEnd, [], 2);
      });

      const result = await callTool('get_ibkr_positions');
      const positions = result.positions as Array<JsonRecord>;

      expect(result.ok).toBe(true);
      expect(positions).toHaveLength(2);
      expect(positions[0]?.symbol).toBe('AAPL');
      expect(positions[1]?.symbol).toBe('MSFT');
    });
  });

  describe('Market data tools', () => {
    it('get_ibkr_quote builds quote snapshot from tick events', async () => {
      onMethod('reqMktData', (api, reqId) => {
        scheduleEmit(api, EventName.tickPrice, [reqId, 1, 190.12]);
        scheduleEmit(api, EventName.tickPrice, [reqId, 2, 190.18], 1);
        scheduleEmit(api, EventName.tickPrice, [reqId, 4, 190.15], 2);
        scheduleEmit(api, EventName.tickPrice, [reqId, 6, 191.0], 3);
        scheduleEmit(api, EventName.tickPrice, [reqId, 7, 189.5], 4);
        scheduleEmit(api, EventName.tickPrice, [reqId, 9, 189.9], 5);
        scheduleEmit(api, EventName.tickPrice, [reqId, 14, 190.0], 6);
        scheduleEmit(api, EventName.tickSize, [reqId, 0, 120], 7);
        scheduleEmit(api, EventName.tickSize, [reqId, 3, 140], 8);
        scheduleEmit(api, EventName.tickSize, [reqId, 5, 20], 9);
        scheduleEmit(api, EventName.tickSize, [reqId, 8, 123456], 10);
        scheduleEmit(api, EventName.tickString, [reqId, 48, '190.15;1;1710930000000;123456;190.05;true'], 11);
        scheduleEmit(api, EventName.tickSnapshotEnd, [reqId], 12);
      });

      const result = await callTool('get_ibkr_quote', { symbol: 'AAPL' });

      expect(result.ok).toBe(true);
      expect(result.symbol).toBe('AAPL');
      expect(result.bid).toBe(190.12);
      expect(result.ask).toBe(190.18);
      expect(result.last).toBe(190.15);
      expect(result.volume).toBe(123456);
      expect(result.vwap).toBe(190.05);
    });

    it('search_ibkr_contracts returns symbol sample matches', async () => {
      onMethod('reqMatchingSymbols', (api, reqId) => {
        scheduleEmit(api, EventName.symbolSamples, [
          reqId,
          [
            {
              contract: {
                conId: 265598,
                symbol: 'AAPL',
                secType: 'STK',
                primaryExch: 'NASDAQ',
                currency: 'USD',
                description: 'Apple Inc.',
              },
            },
          ],
        ]);
      });

      const result = await callTool('search_ibkr_contracts', { pattern: 'AAPL' });
      const contracts = result.contracts as Array<JsonRecord>;

      expect(result.ok).toBe(true);
      expect(result.count).toBe(1);
      expect(contracts[0]?.symbol).toBe('AAPL');
      expect(contracts[0]?.conId).toBe(265598);
    });

    it('get_ibkr_historical_data returns OHLCV bars', async () => {
      onMethod('reqHistoricalData', (api, reqId) => {
        scheduleEmit(api, EventName.historicalData, [reqId, '20260321 15:30:00', 100, 101, 99, 100.5, 1000, 10, 100.4]);
        scheduleEmit(api, EventName.historicalData, [reqId, '20260321 15:31:00', 100.5, 101.2, 100.1, 101, 1200, 12, 100.8], 1);
        scheduleEmit(api, EventName.historicalData, [reqId, 'finished-20260321 15:31:00'], 2);
      });

      const result = await callTool('get_ibkr_historical_data', {
        symbol: 'AAPL',
        duration: '1 D',
        barSize: '1 hour',
      });

      const bars = result.bars as Array<JsonRecord>;

      expect(result.ok).toBe(true);
      expect(result.count).toBe(2);
      expect(bars[0]?.open).toBe(100);
      expect(bars[0]?.close).toBe(100.5);
      expect(bars[1]?.high).toBe(101.2);
    });
  });

  describe('Order tools', () => {
    it('place_ibkr_order returns submitted orderId from orderStatus', async () => {
      onMethod('placeOrder', (api, orderId, _contract, order) => {
        const qty = typeof (order as JsonRecord).totalQuantity === 'number'
          ? ((order as JsonRecord).totalQuantity as number)
          : 0;
        scheduleEmit(api, EventName.orderStatus, [orderId, OrderStatus.Submitted, 0, qty, 0]);
      });

      const result = await callTool('place_ibkr_order', {
        symbol: 'AAPL',
        action: 'BUY',
        quantity: 10,
        orderType: 'MKT',
      });

      expect(result.ok).toBe(true);
      expect(typeof result.orderId).toBe('number');
      expect(result.status).toBe('Submitted');
    });

    it('preview_ibkr_order returns what-if margin impact', async () => {
      onMethod('placeOrder', (api, orderId, contract, order) => {
        if ((order as JsonRecord).whatIf === true) {
          scheduleEmit(api, EventName.openOrder, [orderId, contract, order, {
            initMarginBefore: 20_000,
            initMarginChange: 1_000,
            initMarginAfter: 21_000,
            maintMarginBefore: 15_000,
            maintMarginChange: 600,
            maintMarginAfter: 15_600,
            commission: 2.1,
            minCommission: 1,
            maxCommission: 3,
          }]);
          return;
        }

        scheduleEmit(api, EventName.orderStatus, [orderId, OrderStatus.Submitted, 0, 0, 0]);
      });

      const result = await callTool('preview_ibkr_order', {
        symbol: 'AAPL',
        action: 'BUY',
        quantity: 5,
        orderType: 'LMT',
        limitPrice: 190,
      });

      expect(result.ok).toBe(true);
      expect(result.initMarginChange).toBe(1000);
      expect(result.maintMarginChange).toBe(600);
      expect(result.commission).toBe(2.1);
    });

    it('cancel_ibkr_order confirms cancellation', async () => {
      onMethod('cancelOrder', (api, orderId) => {
        scheduleEmit(api, EventName.orderStatus, [orderId, OrderStatus.Cancelled, 0, 0, 0]);
      });

      const result = await callTool('cancel_ibkr_order', { orderId: 7001 });

      expect(result.ok).toBe(true);
      expect(result.status).toBe('cancelled');
      expect(result.orderId).toBe(7001);
    });

    it('cancel_all_ibkr_orders rejects when confirm is not true', async () => {
      const result = await callTool('cancel_all_ibkr_orders', { confirm: false });

      expect(result.ok).toBe(false);
      expect(String(result.error)).toContain('confirm must be true');
    });

    it('cancel_all_ibkr_orders succeeds when confirm is true', async () => {
      const result = await callTool('cancel_all_ibkr_orders', { confirm: true });

      expect(result.ok).toBe(true);
      expect(result.message).toBe('All orders cancelled');
    });
  });

  describe('Error handling', () => {
    it('suppresses IB info code 2104 and still returns successful response', async () => {
      onMethod('reqAccountSummary', (api, reqId) => {
        scheduleEmit(api, EventName.error, [reqId, 2104, 'Market data farm connection is OK']);
        scheduleEmit(api, EventName.accountSummary, [reqId, 'DU111111', 'NetLiquidation', '150000', 'USD'], 1);
        scheduleEmit(api, EventName.accountSummaryEnd, [reqId], 2);
      });

      const result = await callTool('get_ibkr_account_summary');
      const statusResult = await callTool('get_ibkr_connection_status');
      const status = statusResult.status as JsonRecord;

      expect(result.ok).toBe(true);
      expect(status.lastError).toBeNull();
    });

    it('surfaces IB error code 200 as a real tool error', async () => {
      onMethod('reqAccountSummary', (api, reqId) => {
        scheduleEmit(api, EventName.error, [reqId, 200, 'No security definition found']);
      });

      const result = await callTool('get_ibkr_account_summary');
      const statusResult = await callTool('get_ibkr_connection_status');
      const status = statusResult.status as JsonRecord;

      expect(result.ok).toBe(false);
      expect(String(result.error)).toContain('No security definition found');
      expect(String(result.error)).toContain('200');
      expect(String(status.lastError)).toContain('ERROR 200');
    });

    it('returns connection-not-ready error when disconnected/unavailable', async () => {
      vi.useFakeTimers();
      setConnectHandler(() => {
        // Intentionally emit nothing: no connected/nextValidId => readiness timeout.
      });

      const pending = callTool('get_ibkr_positions');
      await vi.advanceTimersByTimeAsync(16_000);
      const result = await pending;

      expect(result.ok).toBe(false);
      expect(String(result.error).toLowerCase()).toContain('not ready');
    });
  });

  describe('Account tools (PnL & executions)', () => {
    it('get_ibkr_pnl returns daily/unrealized/realized PnL', async () => {
      onMethod('reqPnL', (api, reqId) => {
        scheduleEmit(api, EventName.pnl, [reqId, 100, 200, -50]);
      });

      const result = await callTool('get_ibkr_pnl', { account: 'DU111111' });

      expect(result.ok).toBe(true);
      expect(result.dailyPnL).toBe(100);
      expect(result.unrealizedPnL).toBe(200);
      expect(result.realizedPnL).toBe(-50);
    });

    it('get_ibkr_position_pnl returns position-level PnL', async () => {
      onMethod('reqPnLSingle', (api, reqId) => {
        scheduleEmit(api, EventName.pnlSingle, [reqId, 5, 100, 80, 20, 950]);
      });

      const result = await callTool('get_ibkr_position_pnl', { account: 'DU111111', conId: 265598 });

      expect(result.ok).toBe(true);
      expect(result.pos).toBe(5);
      expect(result.dailyPnL).toBe(100);
      expect(result.value).toBe(950);
    });

    it('get_ibkr_executions returns execution details', async () => {
      onMethod('reqExecutions', (api, reqId) => {
        scheduleEmit(api, EventName.execDetails, [reqId, { symbol: 'AAPL', secType: 'STK' }, { execId: 'E1' }]);
        scheduleEmit(api, EventName.execDetailsEnd, [reqId], 1);
      });

      const result = await callTool('get_ibkr_executions', {});

      expect(result.ok).toBe(true);
      expect(Array.isArray(result.executions)).toBe(true);
    });
  });

  describe('Market data tools (remaining)', () => {
    it('get_ibkr_contract_details returns contract details array', async () => {
      onMethod('reqContractDetails', (api, reqId) => {
        scheduleEmit(api, EventName.contractDetails, [reqId, { contract: { conId: 265598, symbol: 'AAPL', secType: 'STK' } }]);
        scheduleEmit(api, EventName.contractDetailsEnd, [reqId], 1);
      });

      const result = await callTool('get_ibkr_contract_details', { symbol: 'AAPL' });

      expect(result.ok).toBe(true);
      expect(Array.isArray(result.contractDetails)).toBe(true);
    });

    it('get_ibkr_historical_ticks returns ticks and done flag', async () => {
      onMethod('reqHistoricalTicks', (api, reqId) => {
        scheduleEmit(api, EventName.historicalTicksLast, [reqId, [{ time: 1710000, price: 190, size: 100 }], true]);
      });

      const result = await callTool('get_ibkr_historical_ticks', { symbol: 'AAPL' });

      expect(result.ok).toBe(true);
      expect(Array.isArray(result.ticks)).toBe(true);
      expect(result.done).toBe(true);
    });

    it('get_ibkr_market_depth returns bids and asks', async () => {
      onMethod('reqMktDepth', (api, reqId) => {
        scheduleEmit(api, EventName.updateMktDepth, [reqId, 0, 0, 0, 190.1, 120]);
      });

      const result = await callTool('get_ibkr_market_depth', { symbol: 'AAPL' });

      expect(result.ok).toBe(true);
      expect(Array.isArray(result.bids)).toBe(true);
      expect(Array.isArray(result.asks)).toBe(true);
    });
  });

  describe('Options tools', () => {
    it('get_ibkr_option_chain returns chains with strikes and expirations', async () => {
      onMethod('reqContractDetails', (api, reqId) => {
        scheduleEmit(api, EventName.contractDetails, [reqId, { contract: { conId: 265598, symbol: 'AAPL', secType: 'STK' } }]);
        scheduleEmit(api, EventName.contractDetailsEnd, [reqId], 1);
      });

      onMethod('reqSecDefOptParams', (api, reqId) => {
        scheduleEmit(api, EventName.securityDefinitionOptionParameter, [reqId, 'SMART', 265598, 'AAPL', '100', ['20260418', '20260516'], [180, 185, 190, 195, 200]]);
        scheduleEmit(api, EventName.securityDefinitionOptionParameterEnd, [reqId], 1);
      });

      const result = await callTool('get_ibkr_option_chain', { symbol: 'AAPL' });

      expect(result.ok).toBe(true);
      const chains = result.chains as Array<JsonRecord>;
      expect(chains.length).toBeGreaterThanOrEqual(1);
      expect(chains[0]?.exchange).toBe('SMART');
      expect(Array.isArray(chains[0]?.strikes)).toBe(true);
      expect(Array.isArray(chains[0]?.expirations)).toBe(true);
    });

    it('calculate_ibkr_implied_volatility returns IV', async () => {
      const result = await callTool('calculate_ibkr_implied_volatility', {
        symbol: 'AAPL',
        strike: 190,
        right: 'C',
        expiry: '20260418',
        optionPrice: 5.0,
        underlyingPrice: 190,
      });

      expect(result.ok).toBe(true);
      expect(typeof result.impliedVolatility).toBe('number');
    });

    it('calculate_ibkr_option_price returns price and greeks', async () => {
      const result = await callTool('calculate_ibkr_option_price', {
        symbol: 'AAPL',
        strike: 190,
        right: 'C',
        expiry: '20260418',
        volatility: 0.25,
        underlyingPrice: 190,
      });

      expect(result.ok).toBe(true);
      expect(typeof result.optPrice).toBe('number');
      expect(typeof result.delta).toBe('number');
      expect(typeof result.gamma).toBe('number');
      expect(typeof result.vega).toBe('number');
      expect(typeof result.theta).toBe('number');
    });

    it('exercise_ibkr_option succeeds with confirm: true', async () => {
      const result = await callTool('exercise_ibkr_option', {
        symbol: 'AAPL',
        strike: 190,
        right: 'C',
        expiry: '20260418',
        action: 'exercise',
        quantity: 1,
        account: 'DU111111',
        confirm: true,
      });

      expect(result.ok).toBe(true);
      expect(result.action).toBe('exercise');
    });

    it('exercise_ibkr_option rejects with confirm: false', async () => {
      const result = await callTool('exercise_ibkr_option', {
        symbol: 'AAPL',
        strike: 190,
        right: 'C',
        expiry: '20260418',
        action: 'exercise',
        quantity: 1,
        account: 'DU111111',
        confirm: false,
      });

      expect(result.ok).toBe(false);
    });
  });

  describe('Order tools (remaining)', () => {
    it('place_ibkr_bracket_order returns parent and child order IDs', async () => {
      onMethod('placeOrder', (api, orderId) => {
        scheduleEmit(api, EventName.orderStatus, [orderId, OrderStatus.Submitted, 0, 10, 0]);
      });

      const result = await callTool('place_ibkr_bracket_order', {
        symbol: 'AAPL',
        action: 'BUY',
        quantity: 10,
        entryOrderType: 'MKT',
        takeProfitPrice: 200,
        stopLossPrice: 180,
      });

      expect(result.ok).toBe(true);
      expect(typeof result.parentOrderId).toBe('number');
      expect(typeof result.takeProfitOrderId).toBe('number');
      expect(typeof result.stopLossOrderId).toBe('number');
    });

    it('modify_ibkr_order returns success with updated order', async () => {
      onMethod('placeOrder', (api, orderId) => {
        scheduleEmit(api, EventName.orderStatus, [orderId, OrderStatus.Submitted, 0, 5, 0]);
      });

      const result = await callTool('modify_ibkr_order', {
        orderId: 7001,
        symbol: 'AAPL',
        action: 'BUY',
        quantity: 5,
        orderType: 'LMT',
        limitPrice: 195,
      });

      expect(result.ok).toBe(true);
      expect(result.orderId).toBe(7001);
    });

    it('get_ibkr_open_orders returns open orders array', async () => {
      onMethod('reqAllOpenOrders', (api) => {
        scheduleEmit(api, EventName.openOrder, [
          7001,
          { symbol: 'AAPL', secType: 'STK' },
          { action: 'BUY', totalQuantity: 5, orderType: 'MKT', filledQuantity: 0 },
          { status: 'Submitted' },
        ]);
        scheduleEmit(api, EventName.openOrderEnd, [], 1);
      });

      const result = await callTool('get_ibkr_open_orders');
      const orders = result.openOrders as Array<JsonRecord>;

      expect(result.ok).toBe(true);
      expect(Array.isArray(orders)).toBe(true);
      expect(orders.length).toBeGreaterThanOrEqual(1);
      expect(orders[0]?.symbol).toBe('AAPL');
    });

    it('get_ibkr_completed_orders returns completed orders array', async () => {
      onMethod('reqCompletedOrders', (api) => {
        scheduleEmit(api, EventName.completedOrder, [
          { symbol: 'AAPL' },
          { orderId: 7000, action: 'BUY', totalQuantity: 1, orderType: 'MKT' },
          { completedStatus: 'Filled', completedTime: '20260321-15:30:00' },
        ]);
        scheduleEmit(api, EventName.completedOrdersEnd, [], 1);
      });

      const result = await callTool('get_ibkr_completed_orders');
      const orders = result.completedOrders as Array<JsonRecord>;

      expect(result.ok).toBe(true);
      expect(Array.isArray(orders)).toBe(true);
      expect(orders.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Scanner tools', () => {
    it('get_ibkr_scanner_parameters returns scan types, instruments, and locations', async () => {
      onMethod('reqScannerParameters', (api) => {
        const xml = '<ScanParameterResponse><ScanTypeList><ScanType><scanCode>TOP_PERC_GAIN</scanCode></ScanType></ScanTypeList><InstrumentList><Instrument><type>STK</type></Instrument></InstrumentList><LocationTree><Location><locationCode>STK.US.MAJOR</locationCode></Location></LocationTree></ScanParameterResponse>';
        scheduleEmit(api, EventName.scannerParameters, [xml]);
      });

      const result = await callTool('get_ibkr_scanner_parameters');

      expect(result.ok).toBe(true);
      expect(Array.isArray(result.scanTypes)).toBe(true);
      expect((result.scanTypes as Array<unknown>).length).toBeGreaterThan(0);
      expect(Array.isArray(result.instruments)).toBe(true);
      expect((result.instruments as Array<unknown>).length).toBeGreaterThan(0);
      expect(Array.isArray(result.locations)).toBe(true);
      expect((result.locations as Array<unknown>).length).toBeGreaterThan(0);
    });

    it('run_ibkr_scanner returns scanner results', async () => {
      onMethod('reqScannerSubscription', (api, reqId) => {
        scheduleEmit(api, EventName.scannerData, [reqId, 0, { contract: { conId: 265598, symbol: 'AAPL', secType: 'STK', exchange: 'NASDAQ', currency: 'USD' } }, '', '', '', '']);
        scheduleEmit(api, EventName.scannerDataEnd, [reqId], 1);
      });

      const result = await callTool('run_ibkr_scanner', { scanType: 'TOP_PERC_GAIN' });
      const results = result.scannerResults as Array<JsonRecord>;

      expect(result.ok).toBe(true);
      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBe(1);
      expect(results[0]?.symbol).toBe('AAPL');
    });
  });

  describe('News tools', () => {
    it('get_ibkr_news_providers returns provider list', async () => {
      onMethod('reqNewsProviders', (api) => {
        scheduleEmit(api, EventName.newsProviders, [[{ code: 'BZ', name: 'Benzinga' }, { code: 'FLY', name: 'Fly on the Wall' }]]);
      });

      const result = await callTool('get_ibkr_news_providers');
      const providers = result.providers as Array<JsonRecord>;

      expect(result.ok).toBe(true);
      expect(Array.isArray(providers)).toBe(true);
      expect(providers.length).toBe(2);
      expect(providers[0]?.code).toBe('BZ');
      expect(providers[1]?.code).toBe('FLY');
    });

    it('get_ibkr_news_headlines returns headlines for a contract', async () => {
      onMethod('reqNewsProviders', (api) => {
        scheduleEmit(api, EventName.newsProviders, [[{ code: 'BZ', name: 'Benzinga' }]]);
      });
      onMethod('reqHistoricalNews', (api, reqId) => {
        scheduleEmit(api, EventName.historicalNews, [reqId, '2026-03-21 15:30:00', 'BZ', 'BZ$123', 'Apple announces new product']);
        scheduleEmit(api, EventName.historicalNewsEnd, [reqId, true], 1);
      });

      const result = await callTool('get_ibkr_news_headlines', { conId: 265598 });
      const headlines = result.headlines as Array<JsonRecord>;

      expect(result.ok).toBe(true);
      expect(Array.isArray(headlines)).toBe(true);
      expect(headlines.length).toBe(1);
    });

    it('get_ibkr_news_article returns article text', async () => {
      onMethod('reqNewsArticle', (api, reqId) => {
        scheduleEmit(api, EventName.newsArticle, [reqId, 0, 'Full article text about Apple']);
      });

      const result = await callTool('get_ibkr_news_article', { providerCode: 'BZ', articleId: 'BZ$123' });

      expect(result.ok).toBe(true);
      expect(typeof result.articleText).toBe('string');
    });
  });

  describe('Tool dispatch', () => {
    it('returns error for unknown tool name', async () => {
      const result = await callTool('nonexistent_tool');
      expect(result.ok).toBe(false);
      expect(String(result.error)).toContain('Unknown tool');
    });

    it('ListTools handler returns all 31 tool definitions', async () => {
      const handler = requestHandlers.get(ListToolsRequestSchema);
      expect(handler).toBeDefined();
      const response = (await handler!({} as unknown)) as { tools: Array<{ name: string; inputSchema: JsonRecord }> };
      expect(response.tools.length).toBe(31);

      const toolNames = response.tools.map((t) => t.name);
      expect(toolNames).toContain('get_ibkr_connection_status');
      expect(toolNames).toContain('configure_ibkr_connection');
      expect(toolNames).toContain('place_ibkr_order');
      expect(toolNames).toContain('get_ibkr_quote');

      // configure_ibkr_connection must expose clientId in its input schema
      const configureTool = response.tools.find((t) => t.name === 'configure_ibkr_connection');
      const properties = configureTool?.inputSchema?.properties as JsonRecord | undefined;
      expect(properties?.clientId).toBeDefined();
      expect((properties?.clientId as JsonRecord)?.type).toBe('number');
    });
  });
});
