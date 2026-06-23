#!/usr/bin/env node
/**
 * Interactive Brokers MCP Server for Mindstone Rebel.
 *
 * Stage 1-6 tools:
 * - get_ibkr_connection_status
 * - configure_ibkr_connection
 * - list_ibkr_accounts
 * - get_ibkr_account_summary
 * - get_ibkr_positions
 * - get_ibkr_pnl
 * - get_ibkr_position_pnl
 * - get_ibkr_executions
 * - search_ibkr_contracts
 * - get_ibkr_contract_details
 * - get_ibkr_quote
 * - get_ibkr_historical_data
 * - get_ibkr_historical_ticks
 * - get_ibkr_market_depth
 * - get_ibkr_option_chain
 * - calculate_ibkr_implied_volatility
 * - calculate_ibkr_option_price
 * - exercise_ibkr_option
 * - place_ibkr_order
 * - place_ibkr_bracket_order
 * - modify_ibkr_order
 * - cancel_ibkr_order
 * - cancel_all_ibkr_orders
 * - get_ibkr_open_orders
 * - get_ibkr_completed_orders
 * - preview_ibkr_order
 * - get_ibkr_scanner_parameters
 * - run_ibkr_scanner
 * - get_ibkr_news_providers
 * - get_ibkr_news_headlines
 * - get_ibkr_news_article
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import {
  connectionManager,
  type IbkrMode,
  type RuntimeConnectionConfig,
} from './connection.js';
import {
  getIbkrAccountSummary,
  getIbkrExecutions,
  getIbkrPnl,
  getIbkrPositionPnl,
  getIbkrPositions,
  type GetIbkrAccountSummaryArgs,
  type GetIbkrExecutionsArgs,
  type GetIbkrPnlArgs,
  type GetIbkrPositionPnlArgs,
  type GetIbkrPositionsArgs,
} from './tools/account.js';
import {
  getIbkrContractDetails,
  getIbkrHistoricalData,
  getIbkrHistoricalTicks,
  getIbkrMarketDepth,
  getIbkrQuote,
  searchIbkrContracts,
  type GetIbkrContractDetailsArgs,
  type GetIbkrHistoricalDataArgs,
  type GetIbkrHistoricalTicksArgs,
  type GetIbkrMarketDepthArgs,
  type GetIbkrQuoteArgs,
  type SearchIbkrContractsArgs,
} from './tools/market-data.js';
import {
  calculateIbkrImpliedVolatility,
  calculateIbkrOptionPrice,
  exerciseIbkrOption,
  getIbkrOptionChain,
  type CalculateIbkrImpliedVolatilityArgs,
  type CalculateIbkrOptionPriceArgs,
  type ExerciseIbkrOptionArgs,
  type GetIbkrOptionChainArgs,
} from './tools/options.js';
import {
  cancelAllIbkrOrders,
  cancelIbkrOrder,
  getIbkrCompletedOrders,
  getIbkrOpenOrders,
  modifyIbkrOrder,
  placeIbkrBracketOrder,
  placeIbkrOrder,
  previewIbkrOrder,
  type CancelAllIbkrOrdersArgs,
  type CancelIbkrOrderArgs,
  type GetIbkrCompletedOrdersArgs,
  type GetIbkrOpenOrdersArgs,
  type ModifyIbkrOrderArgs,
  type PlaceIbkrBracketOrderArgs,
  type PlaceIbkrOrderArgs,
  type PreviewIbkrOrderArgs,
} from './tools/orders.js';
import {
  getIbkrScannerParameters,
  runIbkrScanner,
  type GetIbkrScannerParametersArgs,
  type RunIbkrScannerArgs,
} from './tools/scanners.js';
import {
  getIbkrNewsArticle,
  getIbkrNewsHeadlines,
  getIbkrNewsProviders,
  type GetIbkrNewsArticleArgs,
  type GetIbkrNewsHeadlinesArgs,
  type GetIbkrNewsProvidersArgs,
} from './tools/news.js';

interface ConfigureConnectionArgs {
  host?: unknown;
  port?: unknown;
  clientId?: unknown;
  mode?: unknown;
}

const parseOptionalInteger = (
  value: unknown,
  fieldName: string,
  minimum: number,
): number | undefined => {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw new Error(`${fieldName} must be an integer >= ${minimum}.`);
  }
  return parsed;
};

const parseOptionalHost = (value: unknown): string | undefined => {
  if (value === undefined || value === null) {
    return undefined;
  }
  const host = String(value).trim();
  if (host.length === 0) {
    throw new Error('host cannot be empty.');
  }
  return host;
};

const withMode = <T extends Record<string, unknown>>(payload: T): T & { mode: IbkrMode } => ({
  ...payload,
  mode: connectionManager.getMode(),
});

const asJson = (payload: Record<string, unknown>): string => JSON.stringify(withMode(payload));

const tools: Tool[] = [
  {
    name: 'get_ibkr_connection_status',
    description: `Check IBKR Gateway connection health. Call this FIRST before any other IBKR tool.

Returns: { state, mode (paper/live), host, port, clientId, serverVersion, accounts[], reconnectCount, activeMarketDataSubscriptions, activeScannerSubscriptions, pacingQueueLength }

States: disconnected, connecting, connected (socket open), ready (orders allowed).
If state is not "connected" or "ready", other tools will fail. Check mode to confirm paper vs live trading.`,
        annotations: { readOnlyHint: true },
inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'configure_ibkr_connection',
    description: `Update IBKR Gateway host, port, or client ID and reconnect. Mode (paper/live) cannot be changed at runtime — restart the connector with a different IBKR_MODE to switch.

Use this when:
- Gateway is on a non-default host or port
- Another application is using client ID 1 (set a different clientId to avoid conflicts)
- You need to reconnect after Gateway restart

IB standard ports: 4001 (live), 4002 (paper), 7496 (TWS live), 7497 (TWS paper).`,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
inputSchema: {
      type: 'object',
      properties: {
        host: {
          type: 'string',
          description: 'IB Gateway/TWS host (default: 127.0.0.1)',
        },
        port: {
          type: 'number',
          description: 'IB Gateway/TWS API port (default: 4002 for paper)',
        },
        clientId: {
          type: 'number',
          description: 'Unique IB API client ID (default: 1)',
        },
      },
    },
  },
  {
    name: 'list_ibkr_accounts',
    description: `List managed IBKR account IDs for the current Gateway session.

Returns: { accounts: ["U1234567", ...] }

Use this to discover which account ID to pass to get_ibkr_pnl, get_ibkr_position_pnl, place_ibkr_order, and exercise_ibkr_option.`,
        annotations: { readOnlyHint: true },
inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_ibkr_account_summary',
    description: `Get account summary with key financial metrics.

Returns array of: { tag, value, currency, account }

Common tags (default if omitted): NetLiquidation, TotalCashValue, BuyingPower, GrossPositionValue, InitMarginReq, MaintMarginReq, AvailableFunds, ExcessLiquidity, Cushion, SettledCash.

Additional tags available: UnrealizedPnL, RealizedPnL, StockMarketValue, OptionMarketValue, FuturesPNL, TotalCashBalance, AccruedDividend, RegTEquity, RegTMargin, SMA, Leverage-S.

RELATED TOOLS:
- get_ibkr_positions: See individual position details
- get_ibkr_pnl: Get daily P&L breakdown`,
        annotations: { readOnlyHint: true },
inputSchema: {
      type: 'object',
      properties: {
        tags: {
          anyOf: [
            {
              type: 'string',
            },
            {
              type: 'array',
              items: {
                type: 'string',
              },
            },
          ],
          description:
            'Summary tags as comma-separated string or array (e.g. "NetLiquidation,BuyingPower"). Omit for defaults.',
        },
      },
    },
  },
  {
    name: 'get_ibkr_positions',
    description: `List all open positions with quantity, average cost, and contract details.

Returns array of: { account, symbol, secType, conId, exchange, currency, position, avgCost }

Use the conId from results to call get_ibkr_position_pnl, get_ibkr_quote, or get_ibkr_news_headlines.

RELATED TOOLS:
- get_ibkr_position_pnl: Get P&L for a specific position (pass account + conId)
- get_ibkr_quote: Get current price for a position's symbol`,
        annotations: { readOnlyHint: true },
inputSchema: {
      type: 'object',
      properties: {
        account: {
          type: 'string',
          description: 'Optional account ID to filter positions (for example: U1234567).',
        },
      },
    },
  },
  {
    name: 'get_ibkr_pnl',
    description: `Get real-time account-level P&L snapshot.

Returns: { dailyPnL, unrealizedPnL, realizedPnL }

WORKFLOW: Call list_ibkr_accounts first to get the account ID.

RELATED TOOLS:
- get_ibkr_position_pnl: P&L for a single position
- get_ibkr_account_summary: Broader account metrics`,
        annotations: { readOnlyHint: true },
inputSchema: {
      type: 'object',
      properties: {
        account: {
          type: 'string',
          description: 'IBKR account ID (required).',
        },
      },
      required: ['account'],
    },
  },
  {
    name: 'get_ibkr_position_pnl',
    description: `Get real-time P&L for a single position by account + conId.

Returns: { pos, dailyPnL, unrealizedPnL, realizedPnL, value }

WORKFLOW:
1. get_ibkr_positions → find the position, note its account and conId
2. get_ibkr_position_pnl({ account, conId }) → get detailed P&L`,
        annotations: { readOnlyHint: true },
inputSchema: {
      type: 'object',
      properties: {
        account: {
          type: 'string',
          description: 'IBKR account ID (required).',
        },
        conId: {
          type: 'number',
          description: 'IBKR contract ID (required).',
        },
      },
      required: ['account', 'conId'],
    },
  },
  {
    name: 'get_ibkr_executions',
    description: `List today's execution fills (trades). Resets at midnight ET.

Returns array of: { execId, time, account, exchange, side, shares, price, avgPrice, cumQty, orderId, symbol, secType }

All filters are optional — omit all for the full execution log.`,
        annotations: { readOnlyHint: true },
inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'Optional symbol filter (for example: AAPL).',
        },
        secType: {
          type: 'string',
          description: 'Optional security type filter (for example: STK, OPT, FUT).',
        },
        time: {
          type: 'string',
          description: 'Optional start time filter in yyyymmdd hh:mm:ss format.',
        },
        side: {
          type: 'string',
          description: 'Optional side filter (for example: BUY, SELL, BOT, SLD).',
        },
      },
    },
  },
  {
    name: 'search_ibkr_contracts',
    description: `Search IBKR contracts by partial ticker or company name.

Returns array of: { conId, symbol, secType, primaryExchange, currency, description, derivativeSecTypes[] }

IMPORTANT: Use this tool to find the conId for any symbol before calling tools that need it (get_ibkr_news_headlines, get_ibkr_position_pnl, get_ibkr_option_chain with conId).

Example: search_ibkr_contracts({ pattern: "AAPL" }) → finds Apple Inc (STK), plus any options/futures.`,
        annotations: { readOnlyHint: true },
inputSchema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Search text (for example: AAPL, Tesla, ES).',
        },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'get_ibkr_contract_details',
    description: `Get full contract specification including trading hours, tick size, industry, and valid exchanges.

Returns: { conId, symbol, secType, exchange, currency, tradingHours, liquidHours, minTick, priceMagnifier, industry, category, subcategory, longName, validExchanges, contractMonth, multiplier }

Results are cached (500 items) — repeated calls for the same contract are instant.`,
        annotations: { readOnlyHint: true },
inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'Contract symbol (required).',
        },
        secType: {
          type: 'string',
          description: 'Security type (default: STK). Options: STK, OPT, FUT, FOP, CASH, CFD, IND, BOND.',
        },
        exchange: {
          type: 'string',
          description: 'Exchange (e.g. SMART, NYSE, NASDAQ, GLOBEX, IDEALPRO for forex).',
        },
        currency: {
          type: 'string',
          description: 'Currency (e.g. USD, EUR, GBP).',
        },
        conId: {
          type: 'number',
          description: 'IB contract ID. Pass this to skip symbol resolution when you already have it.',
        },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'get_ibkr_quote',
    description: `Get a real-time market data snapshot for a contract.

Returns: { symbol, bid, bidSize, ask, askSize, last, lastSize, volume, open, high, low, close, vwap }

This is a one-shot snapshot (subscribes briefly then cancels). For most stocks, just pass symbol. For options, futures, or forex, also pass secType/exchange/currency.

Note: Outside trading hours, bid/ask may be null. Volume and OHLC reflect the current/last session.`,
        annotations: { readOnlyHint: true },
inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'Contract symbol (required).',
        },
        secType: {
          type: 'string',
          description: 'Security type (default: STK).',
        },
        exchange: {
          type: 'string',
          description: 'Optional exchange.',
        },
        currency: {
          type: 'string',
          description: 'Optional currency.',
        },
        conId: {
          type: 'number',
          description: 'Optional IB contract ID for disambiguation.',
        },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'get_ibkr_historical_data',
    description: `Get historical OHLCV bars for a contract. Rate-limited (max 6 requests/minute).

Returns array of: { time, open, high, low, close, volume, wap, barCount }

Valid duration values: "1 D", "2 D", "1 W", "2 W", "1 M", "2 M", "3 M", "6 M", "1 Y".
Valid barSize values: "1 secs", "5 secs", "10 secs", "15 secs", "30 secs", "1 min", "2 mins", "3 mins", "5 mins", "10 mins", "15 mins", "20 mins", "30 mins", "1 hour", "2 hours", "3 hours", "4 hours", "8 hours", "1 day", "1 week", "1 month".
Valid whatToShow values: TRADES, MIDPOINT, BID, ASK, BID_ASK, ADJUSTED_LAST, HISTORICAL_VOLATILITY, OPTION_IMPLIED_VOLATILITY.

PACING: IB limits historical data to ~6 requests per 10 minutes. Requests are automatically queued.`,
        annotations: { readOnlyHint: true },
inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'Contract symbol (required).',
        },
        secType: {
          type: 'string',
          description: 'Security type (default: STK). Options: STK, OPT, FUT, FOP, CASH, CFD, IND.',
        },
        exchange: {
          type: 'string',
          description: 'Optional exchange (e.g. SMART, NYSE, GLOBEX, IDEALPRO for forex).',
        },
        currency: {
          type: 'string',
          description: 'Optional currency (e.g. USD, EUR, GBP).',
        },
        conId: {
          type: 'number',
          description: 'Optional IB contract ID for disambiguation.',
        },
        duration: {
          type: 'string',
          description: 'How far back: "1 D", "1 W", "1 M", "3 M", "1 Y" etc. (default: "1 D").',
        },
        barSize: {
          type: 'string',
          description: 'Bar size: "1 min", "5 mins", "1 hour", "1 day" etc. (default: "1 hour").',
        },
        whatToShow: {
          type: 'string',
          description: 'Data type: TRADES, MIDPOINT, BID, ASK (default: "TRADES").',
        },
        useRTH: {
          type: 'boolean',
          description: 'Regular trading hours only (default: true). Set false for pre/post-market.',
        },
        endDateTime: {
          type: 'string',
          description: 'End datetime in "YYYYMMDD HH:MM:SS" format. Omit for most recent data.',
        },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'get_ibkr_historical_ticks',
    description: `Get tick-by-tick historical data for a contract. Rate-limited like historical bars.

Returns array of: { time, price, size, exchange, specialConditions } (TRADES) or { time, bidPrice, bidSize, askPrice, askSize } (BID_ASK) or { time, midpoint } (MIDPOINT).

Provide either startDateTime OR endDateTime (not both). Start fetches forward; end fetches backward. If neither given, fetches the most recent ticks.

RELATED TOOLS:
- get_ibkr_historical_data: Use this for OHLCV bars instead of individual ticks
- get_ibkr_quote: Use this for a single real-time snapshot`,
        annotations: { readOnlyHint: true },
inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'Contract symbol (required).',
        },
        secType: {
          type: 'string',
          description: 'Security type (default: STK).',
        },
        exchange: {
          type: 'string',
          description: 'Optional exchange.',
        },
        currency: {
          type: 'string',
          description: 'Optional currency.',
        },
        conId: {
          type: 'number',
          description: 'Optional IB contract ID for disambiguation.',
        },
        startDateTime: {
          type: 'string',
          description: 'Fetch ticks forward from this time ("YYYYMMDD HH:MM:SS"). Use start OR end, not both.',
        },
        endDateTime: {
          type: 'string',
          description: 'Fetch ticks backward from this time ("YYYYMMDD HH:MM:SS"). Use start OR end, not both.',
        },
        numberOfTicks: {
          type: 'number',
          description: 'Number of ticks (default: 100, max: 1000).',
        },
        whatToShow: {
          type: 'string',
          description: 'Tick type: TRADES, MIDPOINT, or BID_ASK (default: TRADES).',
        },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'get_ibkr_market_depth',
    description: `Get Level II market depth (order book) snapshot showing the bid/ask ladder.

Returns: { bids: [{ price, size, marketMaker }], asks: [{ price, size, marketMaker }] }

Subscribes briefly then auto-cancels. Requires Level II market data permissions for the exchange. Not all contracts support depth data.

RELATED TOOLS:
- get_ibkr_quote: Simpler top-of-book bid/ask snapshot (no Level II needed)`,
        annotations: { readOnlyHint: true },
inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'Contract symbol (required).',
        },
        secType: {
          type: 'string',
          description: 'Security type (default: STK).',
        },
        exchange: {
          type: 'string',
          description: 'Optional exchange.',
        },
        currency: {
          type: 'string',
          description: 'Optional currency.',
        },
        conId: {
          type: 'number',
          description: 'Optional IB contract ID for disambiguation.',
        },
        numRows: {
          type: 'number',
          description: 'Depth rows per side (default: 5, max: 20).',
        },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'get_ibkr_option_chain',
    description: `Get available option chain parameters (expirations, strikes, multiplier) for an underlying.

Returns array of: { exchange, underlyingConId, tradingClass, multiplier, expirations: ["YYYYMMDD", ...], strikes: [number, ...] }

If conId is omitted, the server auto-resolves it via get_ibkr_contract_details.

WORKFLOW for option analysis:
1. get_ibkr_option_chain({ symbol: "AAPL" }) → see available expirations and strikes
2. calculate_ibkr_option_price or calculate_ibkr_implied_volatility → price/vol analysis
3. place_ibkr_order with secType "OPT" → trade the option`,
        annotations: { readOnlyHint: true },
inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'Underlying symbol (required). E.g. AAPL, SPY, QQQ.',
        },
        secType: {
          type: 'string',
          description: 'Underlying security type (default: STK).',
        },
        conId: {
          type: 'number',
          description: 'Underlying conId. If omitted, auto-resolved from symbol via contract details.',
        },
        exchange: {
          type: 'string',
          description: 'Filter chain to a specific exchange. Omit or empty string for all exchanges.',
        },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'calculate_ibkr_implied_volatility',
    description: `Calculate implied volatility for an option given its market price and the underlying price. Uses IB's Black-Scholes solver.

Returns: { impliedVolatility }

WORKFLOW:
1. get_ibkr_option_chain → pick expiry/strike
2. get_ibkr_quote({ symbol, secType: "OPT", ... }) → get option market price
3. get_ibkr_quote({ symbol: underlyingSymbol }) → get underlying price
4. calculate_ibkr_implied_volatility → solve for IV

RELATED TOOLS:
- calculate_ibkr_option_price: The inverse — given volatility, compute theoretical price`,
        annotations: { readOnlyHint: true },
inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'Option symbol (required).',
        },
        secType: {
          type: 'string',
          enum: ['OPT'],
          description: 'Security type (must be OPT).',
        },
        strike: {
          type: 'number',
          description: 'Option strike (required).',
        },
        right: {
          type: 'string',
          enum: ['C', 'P', 'CALL', 'PUT'],
          description: 'Option right (C/CALL or P/PUT).',
        },
        expiry: {
          type: 'string',
          description: 'Option expiry in IB format (YYYYMM or YYYYMMDD).',
        },
        exchange: {
          type: 'string',
          description: 'Optional exchange (default: SMART).',
        },
        currency: {
          type: 'string',
          description: 'Optional currency (default: USD).',
        },
        conId: {
          type: 'number',
          description: 'Optional option conId.',
        },
        optionPrice: {
          type: 'number',
          description: 'Observed option price (required).',
        },
        underlyingPrice: {
          type: 'number',
          description: 'Underlying price (required).',
        },
      },
      required: ['symbol', 'strike', 'right', 'expiry', 'optionPrice', 'underlyingPrice'],
    },
  },
  {
    name: 'calculate_ibkr_option_price',
    description: `Calculate theoretical option price given volatility and underlying price. Uses IB's Black-Scholes pricer.

Returns: { optionPrice, delta, gamma, vega, theta, pvDividend }

WORKFLOW:
1. get_ibkr_option_chain → pick expiry/strike
2. get_ibkr_quote({ symbol: underlyingSymbol }) → get underlying price
3. calculate_ibkr_option_price → get theoretical price + Greeks

RELATED TOOLS:
- calculate_ibkr_implied_volatility: The inverse — given price, compute IV`,
        annotations: { readOnlyHint: true },
inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'Option symbol (required).',
        },
        secType: {
          type: 'string',
          enum: ['OPT'],
          description: 'Security type (must be OPT).',
        },
        strike: {
          type: 'number',
          description: 'Option strike (required).',
        },
        right: {
          type: 'string',
          enum: ['C', 'P', 'CALL', 'PUT'],
          description: 'Option right (C/CALL or P/PUT).',
        },
        expiry: {
          type: 'string',
          description: 'Option expiry in IB format (YYYYMM or YYYYMMDD).',
        },
        exchange: {
          type: 'string',
          description: 'Optional exchange (default: SMART).',
        },
        currency: {
          type: 'string',
          description: 'Optional currency (default: USD).',
        },
        conId: {
          type: 'number',
          description: 'Optional option conId.',
        },
        volatility: {
          type: 'number',
          description: 'Volatility input (required).',
        },
        underlyingPrice: {
          type: 'number',
          description: 'Underlying price (required).',
        },
      },
      required: ['symbol', 'strike', 'right', 'expiry', 'volatility', 'underlyingPrice'],
    },
  },
  {
    name: 'exercise_ibkr_option',
    description: `Exercise or lapse an option contract. DESTRUCTIVE ACTION — requires confirm: true.

Returns: { ok: true, message } or error with details.

WARNING: Exercising calls assigns stock at the strike price. Exercising puts delivers stock at the strike. Ensure account has sufficient margin/buying power.

SAFETY:
- confirm must be true or the request is rejected
- In live mode, an extra warning is included in the response
- Use preview_ibkr_order with a sell order to estimate closing value as an alternative to exercise`,
        annotations: { readOnlyHint: false, destructiveHint: true },
inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'Option symbol (required).',
        },
        secType: {
          type: 'string',
          enum: ['OPT'],
          description: 'Security type (must be OPT).',
        },
        conId: {
          type: 'number',
          description: 'Optional option conId.',
        },
        strike: {
          type: 'number',
          description: 'Option strike (required).',
        },
        right: {
          type: 'string',
          enum: ['C', 'P', 'CALL', 'PUT'],
          description: 'Option right (C/CALL or P/PUT).',
        },
        expiry: {
          type: 'string',
          description: 'Option expiry in IB format (YYYYMM or YYYYMMDD).',
        },
        exchange: {
          type: 'string',
          description: 'Optional exchange (default: SMART).',
        },
        currency: {
          type: 'string',
          description: 'Optional currency (default: USD).',
        },
        action: {
          type: 'string',
          enum: ['exercise', 'lapse'],
          description: 'Action to submit.',
        },
        quantity: {
          type: 'number',
          description: 'Number of option contracts to exercise/lapse (required).',
        },
        account: {
          type: 'string',
          description: 'IBKR account ID to submit against (required).',
        },
        override: {
          type: 'boolean',
          description: 'Override natural action if needed (default: false).',
        },
        confirm: {
          type: 'boolean',
          description: 'Safety gate. Must be true to submit.',
        },
      },
      required: ['symbol', 'strike', 'right', 'expiry', 'action', 'quantity', 'account', 'confirm'],
    },
  },
  {
    name: 'place_ibkr_order',
    description: `Place an order. Returns the orderId and initial status.

Returns: { orderId, status, warning? }

SAFETY — Always call preview_ibkr_order first to check margin/commission impact before placing.
In live mode, response includes a warning reminder.

Order type guide:
- MKT: Market order, fills immediately at best available price
- LMT: Limit order, requires limitPrice
- STP: Stop order, triggers market order when stopPrice is hit
- STP_LMT: Stop-limit, triggers limit order at limitPrice when stopPrice is hit
- MOC/LOC: Market/limit on close, executes at session close
- TRAIL: Trailing stop, set trailStopPrice or trailPercent
- TRAIL_LIMIT: Trailing stop-limit, combines trailing with limit
- REL: Relative/pegged order

WORKFLOW for a typical trade:
1. get_ibkr_quote → check current price
2. preview_ibkr_order → verify margin impact
3. place_ibkr_order → submit the order
4. get_ibkr_open_orders → confirm status

RELATED TOOLS:
- place_ibkr_bracket_order: Entry + take-profit + stop-loss in one call
- modify_ibkr_order: Change price/quantity on an open order
- cancel_ibkr_order: Cancel by orderId`,
        annotations: { readOnlyHint: false, destructiveHint: false },
inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'Contract symbol (required).',
        },
        secType: {
          type: 'string',
          description: 'Security type (default: STK).',
        },
        exchange: {
          type: 'string',
          description: 'Destination exchange (default: SMART).',
        },
        currency: {
          type: 'string',
          description: 'Trading currency (default: USD).',
        },
        action: {
          type: 'string',
          enum: ['BUY', 'SELL'],
          description: 'Order side (required).',
        },
        quantity: {
          type: 'number',
          description: 'Order quantity (required).',
        },
        orderType: {
          type: 'string',
          enum: ['MKT', 'LMT', 'STP', 'STP_LMT', 'MOC', 'LOC', 'TRAIL', 'TRAIL_LIMIT', 'REL'],
          description: 'Order type (required).',
        },
        limitPrice: {
          type: 'number',
          description: 'Required for LMT and STP_LMT orders.',
        },
        stopPrice: {
          type: 'number',
          description: 'Required for STP and STP_LMT orders.',
        },
        trailStopPrice: {
          type: 'number',
          description: 'Optional trailing stop price.',
        },
        trailPercent: {
          type: 'number',
          description: 'Optional trailing percent.',
        },
        tif: {
          type: 'string',
          enum: ['DAY', 'GTC', 'IOC', 'FOK'],
          description: 'Time-in-force (default: DAY).',
        },
        outsideRth: {
          type: 'boolean',
          description: 'Allow fills outside regular trading hours (default: false).',
        },
        account: {
          type: 'string',
          description: 'Optional target IBKR account.',
        },
      },
      required: ['symbol', 'action', 'quantity', 'orderType'],
    },
  },
  {
    name: 'place_ibkr_bracket_order',
    description: `Place a bracket order: entry + take-profit + stop-loss as linked parent-child orders. If any child fails, the server attempts to cancel the others (rollback).

Returns: { parentOrderId, takeProfitOrderId, stopLossOrderId, status, warning? }

The entry (parent) transmits first. Take-profit (LMT) and stop-loss (STP) are OCA-linked children — when one fills, the other auto-cancels.

WORKFLOW:
1. get_ibkr_quote → determine entry, take-profit, and stop levels
2. preview_ibkr_order → check margin for the entry leg
3. place_ibkr_bracket_order → submit the bracket

RELATED TOOLS:
- place_ibkr_order: Single leg order without bracket protection
- get_ibkr_open_orders: Check status of all three bracket legs`,
        annotations: { readOnlyHint: false, destructiveHint: false },
inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'Contract symbol (required).',
        },
        secType: {
          type: 'string',
          description: 'Security type (default: STK).',
        },
        exchange: {
          type: 'string',
          description: 'Destination exchange (default: SMART).',
        },
        currency: {
          type: 'string',
          description: 'Trading currency (default: USD).',
        },
        action: {
          type: 'string',
          enum: ['BUY', 'SELL'],
          description: 'Entry side (required).',
        },
        quantity: {
          type: 'number',
          description: 'Order quantity (required).',
        },
        entryOrderType: {
          type: 'string',
          enum: ['MKT', 'LMT'],
          description: 'Entry order type (required).',
        },
        entryLimitPrice: {
          type: 'number',
          description: 'Required when entryOrderType is LMT.',
        },
        takeProfitPrice: {
          type: 'number',
          description: 'Take-profit limit price (required).',
        },
        stopLossPrice: {
          type: 'number',
          description: 'Stop-loss trigger price (required).',
        },
        tif: {
          type: 'string',
          enum: ['DAY', 'GTC', 'IOC', 'FOK'],
          description: 'Time-in-force (default: DAY).',
        },
        account: {
          type: 'string',
          description: 'Optional target IBKR account.',
        },
      },
      required: [
        'symbol',
        'action',
        'quantity',
        'entryOrderType',
        'takeProfitPrice',
        'stopLossPrice',
      ],
    },
  },
  {
    name: 'modify_ibkr_order',
    description: `Modify an open order's price, quantity, or other parameters. Re-submits the full order specification with the existing orderId — all fields must be provided, not just the changed ones.

Returns: { orderId, status }

WORKFLOW:
1. get_ibkr_open_orders → find the orderId and current order details
2. modify_ibkr_order → re-submit with updated fields (pass ALL original fields plus changes)

NOTE: You cannot modify a filled or cancelled order. Only open/submitted orders can be modified.`,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
inputSchema: {
      type: 'object',
      properties: {
        orderId: {
          type: 'number',
          description: 'Existing IBKR order ID to modify (required).',
        },
        symbol: {
          type: 'string',
          description: 'Contract symbol (required).',
        },
        secType: {
          type: 'string',
          description: 'Security type (default: STK).',
        },
        exchange: {
          type: 'string',
          description: 'Destination exchange (default: SMART).',
        },
        currency: {
          type: 'string',
          description: 'Trading currency (default: USD).',
        },
        action: {
          type: 'string',
          enum: ['BUY', 'SELL'],
          description: 'Order side (required).',
        },
        quantity: {
          type: 'number',
          description: 'Order quantity (required).',
        },
        orderType: {
          type: 'string',
          enum: ['MKT', 'LMT', 'STP', 'STP_LMT', 'MOC', 'LOC', 'TRAIL', 'TRAIL_LIMIT', 'REL'],
          description: 'Order type (required).',
        },
        limitPrice: {
          type: 'number',
          description: 'Required for LMT and STP_LMT orders.',
        },
        stopPrice: {
          type: 'number',
          description: 'Required for STP and STP_LMT orders.',
        },
        trailStopPrice: {
          type: 'number',
          description: 'Optional trailing stop price.',
        },
        trailPercent: {
          type: 'number',
          description: 'Optional trailing percent.',
        },
        tif: {
          type: 'string',
          enum: ['DAY', 'GTC', 'IOC', 'FOK'],
          description: 'Time-in-force (default: DAY).',
        },
        outsideRth: {
          type: 'boolean',
          description: 'Allow fills outside regular trading hours (default: false).',
        },
        account: {
          type: 'string',
          description: 'Optional target IBKR account.',
        },
      },
      required: ['orderId', 'symbol', 'action', 'quantity', 'orderType'],
    },
  },
  {
    name: 'cancel_ibkr_order',
    description: `Cancel a single open order. Waits for IB to acknowledge the cancellation.

Returns: { orderId, status: "Cancelled" } or error if already filled/cancelled.

WORKFLOW:
1. get_ibkr_open_orders → find the orderId
2. cancel_ibkr_order({ orderId })

RELATED TOOLS:
- cancel_all_ibkr_orders: Nuclear option — cancels everything (requires confirm: true)`,
        annotations: { readOnlyHint: false, destructiveHint: true },
inputSchema: {
      type: 'object',
      properties: {
        orderId: {
          type: 'number',
          description: 'IBKR order ID to cancel (required).',
        },
      },
      required: ['orderId'],
    },
  },
  {
    name: 'cancel_all_ibkr_orders',
    description: `Cancel ALL open orders globally. DESTRUCTIVE ACTION — requires confirm: true.

Returns: { ok: true, message } on success.

WARNING: This cancels every open order across all accounts on this Gateway session. Use cancel_ibkr_order to cancel a single order instead.`,
        annotations: { readOnlyHint: false, destructiveHint: true },
inputSchema: {
      type: 'object',
      properties: {
        confirm: {
          type: 'boolean',
          description: 'Safety gate. Must be true.',
        },
      },
      required: ['confirm'],
    },
  },
  {
    name: 'get_ibkr_open_orders',
    description: `List all open/submitted orders with their current status.

Returns array of: { orderId, symbol, secType, action, orderType, quantity, limitPrice, stopPrice, status, filled, remaining, avgFillPrice, parentId }

Use this to:
- Find orderIds for modify_ibkr_order or cancel_ibkr_order
- Monitor bracket order legs (parentId links children to parent)
- Check fill progress on partially filled orders`,
        annotations: { readOnlyHint: true },
inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_ibkr_completed_orders',
    description: `List recently completed (filled, cancelled) orders.

Returns array of: { orderId, symbol, secType, action, orderType, quantity, status, completedTime, avgFillPrice }

Shows orders that are no longer active. Resets daily.`,
        annotations: { readOnlyHint: true },
inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'preview_ibkr_order',
    description: `Dry-run an order to see estimated margin impact and commission WITHOUT actually placing it. Uses IB's what-if mode.

Returns: { initMarginBefore, initMarginAfter, initMarginChange, maintMarginBefore, maintMarginAfter, maintMarginChange, equityWithLoanBefore, equityWithLoanAfter, equityWithLoanChange, commission, minCommission, maxCommission }

IMPORTANT: Always call this before place_ibkr_order or place_ibkr_bracket_order to verify the account can support the trade. The parameters are identical to place_ibkr_order.`,
        annotations: { readOnlyHint: true },
inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'Contract symbol (required).',
        },
        secType: {
          type: 'string',
          description: 'Security type (default: STK).',
        },
        exchange: {
          type: 'string',
          description: 'Destination exchange (default: SMART).',
        },
        currency: {
          type: 'string',
          description: 'Trading currency (default: USD).',
        },
        action: {
          type: 'string',
          enum: ['BUY', 'SELL'],
          description: 'Order side (required).',
        },
        quantity: {
          type: 'number',
          description: 'Order quantity (required).',
        },
        orderType: {
          type: 'string',
          enum: ['MKT', 'LMT', 'STP', 'STP_LMT', 'MOC', 'LOC', 'TRAIL', 'TRAIL_LIMIT', 'REL'],
          description: 'Order type (required).',
        },
        limitPrice: {
          type: 'number',
          description: 'Required for LMT and STP_LMT orders.',
        },
        stopPrice: {
          type: 'number',
          description: 'Required for STP and STP_LMT orders.',
        },
        trailStopPrice: {
          type: 'number',
          description: 'Optional trailing stop price.',
        },
        trailPercent: {
          type: 'number',
          description: 'Optional trailing percent.',
        },
        tif: {
          type: 'string',
          enum: ['DAY', 'GTC', 'IOC', 'FOK'],
          description: 'Time-in-force (default: DAY).',
        },
        outsideRth: {
          type: 'boolean',
          description: 'Allow fills outside regular trading hours (default: false).',
        },
        account: {
          type: 'string',
          description: 'Optional target IBKR account.',
        },
      },
      required: ['symbol', 'action', 'quantity', 'orderType'],
    },
  },
  {
    name: 'get_ibkr_scanner_parameters',
    description: `Get all available scanner types, instruments, and location codes from IB. Cached after first call.

Returns: { scanTypes: [{ name, displayName }], instruments: [{ name, type }], locationCodes: [{ code, displayName }], filters: [...] }

Call this FIRST before run_ibkr_scanner to discover valid scanType, instrument, and locationCode values.`,
        annotations: { readOnlyHint: true },
inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'run_ibkr_scanner',
    description: `Run a market scanner and return ranked results. Auto-cancels subscription after collection.

Returns array of: { rank, conId, symbol, secType, exchange, currency, distance, benchmark, projection, legsStr }

Common scanType values: TOP_PERC_GAIN, TOP_PERC_LOSE, MOST_ACTIVE, HOT_BY_VOLUME, HOT_BY_PRICE, TOP_OPEN_PERC_GAIN, TOP_OPEN_PERC_LOSE, HIGH_DIVIDEND_YIELD_IB, TOP_TRADE_COUNT, TOP_TRADE_RATE, TOP_PRICE_RANGE, HOT_BY_OPT_VOLUME.

Common locationCode values: STK.US.MAJOR, STK.US, STK.US.MINOR, STK.EU, STK.AMEX, STK.NYSE, STK.NASDAQ.

WORKFLOW:
1. get_ibkr_scanner_parameters → discover valid scan types and location codes
2. run_ibkr_scanner → get results
3. get_ibkr_quote or get_ibkr_contract_details on results → drill into interesting symbols

NOTE: Max 8 concurrent scanner subscriptions. Each call auto-cancels when done.`,
        annotations: { readOnlyHint: true },
inputSchema: {
      type: 'object',
      properties: {
        scanType: {
          type: 'string',
          description:
            'Scanner code (required). E.g. TOP_PERC_GAIN, MOST_ACTIVE, HOT_BY_VOLUME. Call get_ibkr_scanner_parameters for the full list.',
        },
        instrument: {
          type: 'string',
          description: 'Instrument type (default: STK). Also: FUT, IND, FUND.',
        },
        locationCode: {
          type: 'string',
          description: 'Market location (default: STK.US.MAJOR). E.g. STK.US, STK.NYSE, STK.EU.',
        },
        numberOfRows: {
          type: 'number',
          description: 'Number of results (default: 20, max: 50).',
        },
        priceAbove: {
          type: 'number',
          description: 'Minimum last price filter.',
        },
        priceBelow: {
          type: 'number',
          description: 'Maximum last price filter.',
        },
        volumeAbove: {
          type: 'number',
          description: 'Minimum volume filter.',
        },
        marketCapAbove: {
          type: 'number',
          description: 'Minimum market cap filter (in millions).',
        },
        marketCapBelow: {
          type: 'number',
          description: 'Maximum market cap filter (in millions).',
        },
      },
      required: ['scanType'],
    },
  },
  {
    name: 'get_ibkr_news_providers',
    description: `List available news providers for the connected IB account.

Returns array of: { code, name }

Common providers: BZ (Benzinga), FLY (Fly on the Wall), DJ (Dow Jones), RFT (Refinitiv). Availability depends on your IB subscription.

Use the provider codes in get_ibkr_news_headlines to filter by source.`,
        annotations: { readOnlyHint: true },
inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_ibkr_news_headlines',
    description: `Get news headlines for a specific contract.

Returns array of: { articleId, providerCode, time, headline }

WORKFLOW:
1. search_ibkr_contracts({ pattern: "AAPL" }) → get the conId
2. get_ibkr_news_headlines({ conId: 265598 }) → get headlines
3. get_ibkr_news_article({ providerCode, articleId }) → read full article

RELATED TOOLS:
- get_ibkr_news_providers: Discover available provider codes for filtering`,
        annotations: { readOnlyHint: true },
inputSchema: {
      type: 'object',
      properties: {
        conId: {
          type: 'number',
          description: 'IB contract ID (required). Get this from search_ibkr_contracts or get_ibkr_positions.',
        },
        providerCodes: {
          type: 'string',
          description:
            'Filter by providers, separated by "+" (e.g. "BZ+FLY"). Omit for all providers.',
        },
        startDateTime: {
          type: 'string',
          description: 'Oldest headlines from this time (format: "yyyy-MM-dd HH:mm:ss.0").',
        },
        endDateTime: {
          type: 'string',
          description: 'Newest headlines up to this time (format: "yyyy-MM-dd HH:mm:ss.0").',
        },
        totalResults: {
          type: 'number',
          description: 'Max headlines to return (default: 10, max: 300).',
        },
      },
      required: ['conId'],
    },
  },
  {
    name: 'get_ibkr_news_article',
    description: `Get the full text of a news article.

Returns: { articleType, articleText }

WORKFLOW: Call get_ibkr_news_headlines first to get providerCode and articleId for the article you want to read.`,
        annotations: { readOnlyHint: true },
inputSchema: {
      type: 'object',
      properties: {
        providerCode: {
          type: 'string',
          description: 'News provider code (e.g. "BZ", "FLY", "DJ"). From get_ibkr_news_headlines results.',
        },
        articleId: {
          type: 'string',
          description: 'Article ID from get_ibkr_news_headlines results.',
        },
      },
      required: ['providerCode', 'articleId'],
    },
  },
];

const handleConfigureConnection = async (args: ConfigureConnectionArgs): Promise<string> => {
  const requestedMode = args.mode === undefined ? undefined : String(args.mode).toLowerCase();
  if (requestedMode && requestedMode !== 'paper' && requestedMode !== 'live') {
    return asJson({
      ok: false,
      error: 'mode must be either "paper" or "live" when provided.',
    });
  }

  if (requestedMode && requestedMode !== connectionManager.getMode()) {
    return asJson({
      ok: false,
      error:
        `Runtime mode switching is disabled. Current mode is "${connectionManager.getMode()}". Restart MCP with IBKR_MODE=${requestedMode} to change mode.`,
    });
  }

  let configUpdate: RuntimeConnectionConfig;
  try {
    configUpdate = {
      host: parseOptionalHost(args.host),
      port: parseOptionalInteger(args.port, 'port', 1),
      clientId: parseOptionalInteger(args.clientId, 'clientId', 0),
    };
  } catch (error) {
    return asJson({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    await connectionManager.reconfigure(configUpdate);
    const status = connectionManager.getStatusSnapshot();
    return asJson({
      ok: true,
      message: 'IBKR connection updated and reconnected.',
      status,
    });
  } catch (error) {
    return asJson({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

async function handleToolCall(name: string, args: Record<string, unknown>): Promise<string> {
  try {
    switch (name) {
      case 'get_ibkr_connection_status': {
        if (!connectionManager.isConnected()) {
          try {
            await connectionManager.ensureConnected(10_000);
          } catch {
            // Fall through -- return whatever state we have
          }
        }

        const status = connectionManager.getStatusSnapshot();
        let serverTime: number | null = null;

        if (status.connected) {
          try {
            serverTime = await connectionManager.getServerTime(4_000);
          } catch {
            serverTime = null;
          }
        }

        return asJson({ ok: true, status, serverTime });
      }

      case 'configure_ibkr_connection': {
        return await handleConfigureConnection(args as ConfigureConnectionArgs);
      }

      case 'list_ibkr_accounts': {
        const accounts = await connectionManager.listManagedAccounts();
        return asJson({
          ok: true,
          accounts,
          count: accounts.length,
        });
      }

      case 'get_ibkr_account_summary': {
        const response = await getIbkrAccountSummary(args as GetIbkrAccountSummaryArgs);
        return asJson(response);
      }

      case 'get_ibkr_positions': {
        const response = await getIbkrPositions(args as GetIbkrPositionsArgs);
        return asJson(response);
      }

      case 'get_ibkr_pnl': {
        const response = await getIbkrPnl(args as GetIbkrPnlArgs);
        return asJson(response);
      }

      case 'get_ibkr_position_pnl': {
        const response = await getIbkrPositionPnl(args as GetIbkrPositionPnlArgs);
        return asJson(response);
      }

      case 'get_ibkr_executions': {
        const response = await getIbkrExecutions(args as GetIbkrExecutionsArgs);
        return asJson(response);
      }

      case 'search_ibkr_contracts': {
        const response = await searchIbkrContracts(args as SearchIbkrContractsArgs);
        return asJson(response);
      }

      case 'get_ibkr_contract_details': {
        const response = await getIbkrContractDetails(args as GetIbkrContractDetailsArgs);
        return asJson(response);
      }

      case 'get_ibkr_quote': {
        const response = await getIbkrQuote(args as GetIbkrQuoteArgs);
        return asJson(response);
      }

      case 'get_ibkr_historical_data': {
        const response = await getIbkrHistoricalData(args as GetIbkrHistoricalDataArgs);
        return asJson(response);
      }

      case 'get_ibkr_historical_ticks': {
        const response = await getIbkrHistoricalTicks(args as GetIbkrHistoricalTicksArgs);
        return asJson(response);
      }

      case 'get_ibkr_market_depth': {
        const response = await getIbkrMarketDepth(args as GetIbkrMarketDepthArgs);
        return asJson(response);
      }

      case 'get_ibkr_option_chain': {
        const response = await getIbkrOptionChain(args as GetIbkrOptionChainArgs);
        return asJson(response);
      }

      case 'calculate_ibkr_implied_volatility': {
        const response = await calculateIbkrImpliedVolatility(
          args as CalculateIbkrImpliedVolatilityArgs,
        );
        return asJson(response);
      }

      case 'calculate_ibkr_option_price': {
        const response = await calculateIbkrOptionPrice(args as CalculateIbkrOptionPriceArgs);
        return asJson(response);
      }

      case 'exercise_ibkr_option': {
        const response = await exerciseIbkrOption(args as ExerciseIbkrOptionArgs);
        return asJson(response);
      }

      case 'place_ibkr_order': {
        const response = await placeIbkrOrder(args as PlaceIbkrOrderArgs);
        return asJson(response);
      }

      case 'place_ibkr_bracket_order': {
        const response = await placeIbkrBracketOrder(args as PlaceIbkrBracketOrderArgs);
        return asJson(response);
      }

      case 'modify_ibkr_order': {
        const response = await modifyIbkrOrder(args as ModifyIbkrOrderArgs);
        return asJson(response);
      }

      case 'cancel_ibkr_order': {
        const response = await cancelIbkrOrder(args as CancelIbkrOrderArgs);
        return asJson(response);
      }

      case 'cancel_all_ibkr_orders': {
        const response = await cancelAllIbkrOrders(args as CancelAllIbkrOrdersArgs);
        return asJson(response);
      }

      case 'get_ibkr_open_orders': {
        const response = await getIbkrOpenOrders(args as GetIbkrOpenOrdersArgs);
        return asJson(response);
      }

      case 'get_ibkr_completed_orders': {
        const response = await getIbkrCompletedOrders(args as GetIbkrCompletedOrdersArgs);
        return asJson(response);
      }

      case 'preview_ibkr_order': {
        const response = await previewIbkrOrder(args as PreviewIbkrOrderArgs);
        return asJson(response);
      }

      case 'get_ibkr_scanner_parameters': {
        const response = await getIbkrScannerParameters(args as GetIbkrScannerParametersArgs);
        return asJson(response);
      }

      case 'run_ibkr_scanner': {
        const response = await runIbkrScanner(args as RunIbkrScannerArgs);
        return asJson(response);
      }

      case 'get_ibkr_news_providers': {
        const response = await getIbkrNewsProviders(args as GetIbkrNewsProvidersArgs);
        return asJson(response);
      }

      case 'get_ibkr_news_headlines': {
        const response = await getIbkrNewsHeadlines(args as GetIbkrNewsHeadlinesArgs);
        return asJson(response);
      }

      case 'get_ibkr_news_article': {
        const response = await getIbkrNewsArticle(args as GetIbkrNewsArticleArgs);
        return asJson(response);
      }

      default:
        return asJson({
          ok: false,
          error: `Unknown tool: ${name}`,
          resolution: 'Use list tools to find supported IBKR tool names.',
        });
    }
  } catch (error) {
    return asJson({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      resolution: 'Retry the request. If the issue persists, check IB Gateway/TWS connectivity and tool inputs.',
    });
  }
}

const server = new Server(
  {
    name: 'ibkr-mcp-server',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const result = await handleToolCall(name, (args as Record<string, unknown>) || {});
  return {
    content: [{ type: 'text', text: result }],
  };
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('IBKR MCP server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
