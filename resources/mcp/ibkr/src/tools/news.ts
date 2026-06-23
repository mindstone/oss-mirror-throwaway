import { EventName, type IBApi } from '@stoqey/ib';
import { connectionManager } from '../connection.js';
import { awaitSingle, collectUntilEnd } from '../helpers.js';
import { IbRequestError } from '../errors.js';

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_TOTAL_RESULTS = 10;
const MAX_TOTAL_RESULTS = 300;

const CONNECTION_RESOLUTION =
  'Ensure IB Gateway/TWS is running with API enabled, then reconnect using configure_ibkr_connection and retry.';
const INPUT_RESOLUTION = 'Fix the tool arguments and retry.';
const REQUEST_RESOLUTION =
  'Retry the request. If this persists, verify conId/provider/date inputs and confirm IB Gateway/TWS is healthy.';
const NEWS_SUBSCRIPTION_RESOLUTION =
  'This tool requires active IBKR news subscriptions (for example Benzinga, Briefing Trader, Fly on the Wall). Enable the subscriptions in IB Account Management, then retry.';

const NEWS_SUBSCRIPTION_ERROR_CODES = new Set<number>([354, 430, 10089, 10167, 10276]);

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

export interface GetIbkrNewsProvidersArgs {}

export interface GetIbkrNewsHeadlinesArgs {
  conId?: unknown;
  providerCodes?: unknown;
  startDateTime?: unknown;
  endDateTime?: unknown;
  totalResults?: unknown;
}

export interface GetIbkrNewsArticleArgs {
  providerCode?: unknown;
  articleId?: unknown;
}

interface NewsProviderRow {
  code: string;
  name: string;
}

interface NewsHeadlineRow {
  time: string | null;
  providerCode: string | null;
  articleId: string | null;
  headline: string | null;
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

const asRecord = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object') {
    return {};
  }
  return value as Record<string, unknown>;
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

const parsePositiveInteger = (value: unknown, fieldName: string): number => {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${fieldName} must be a positive integer.`);
  }
  return parsed;
};

const parseTotalResults = (value: unknown): number => {
  if (value === undefined || value === null || value === '') {
    return DEFAULT_TOTAL_RESULTS;
  }

  const parsed = parsePositiveInteger(value, 'totalResults');
  return Math.min(parsed, MAX_TOTAL_RESULTS);
};

const parseProviderCodes = (value: unknown): string => {
  const normalized = toOptionalString(value);
  if (!normalized) {
    return '';
  }

  const codes = normalized
    .split(/[,+\s]+/g)
    .map((entry) => entry.trim().toUpperCase())
    .filter((entry) => entry.length > 0);

  return codes.join('+');
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

const isLikelyNewsSubscriptionError = (error: unknown): boolean => {
  if (error instanceof IbRequestError && NEWS_SUBSCRIPTION_ERROR_CODES.has(error.code)) {
    return true;
  }

  const message = toErrorMessage(error).toLowerCase();
  if (message.length === 0) {
    return false;
  }

  return (
    (message.includes('subscription')
      || message.includes('permission')
      || message.includes('entitlement')
      || message.includes('not subscribed'))
    && (message.includes('news') || message.includes('provider'))
  );
};

const newsRequestError = (error: unknown): ToolErrorResponse => {
  if (isLikelyNewsSubscriptionError(error)) {
    return errorResponse(error, NEWS_SUBSCRIPTION_RESOLUTION);
  }
  return errorResponse(error, REQUEST_RESOLUTION);
};

export async function getIbkrNewsProviders(
  _args: GetIbkrNewsProvidersArgs = {},
): Promise<ToolResponse> {
  const readyClient = await ensureReadyClient();
  if (!readyClient.ok) {
    return readyClient;
  }

  const { ib } = readyClient;

  const responsePromise = awaitSingle<NewsProviderRow[]>(
    ib,
    -1,
    EventName.newsProviders,
    (...eventArgs) => {
      const rawProviders = Array.isArray(eventArgs[0]) ? eventArgs[0] : [];

      return rawProviders
        .map((provider) => {
          const record = asRecord(provider);
          return {
            code: asStringOrNull(record.code) ?? '',
            name: asStringOrNull(record.name) ?? '',
          };
        })
        .filter((provider) => provider.code.length > 0 || provider.name.length > 0);
    },
    DEFAULT_REQUEST_TIMEOUT_MS,
  );
  void responsePromise.catch(() => {});

  try {
    await connectionManager.enqueueGeneral(() => {
      ib.reqNewsProviders();
      return undefined;
    });

    const providers = await responsePromise;
    return {
      ok: true,
      providers,
      count: providers.length,
    };
  } catch (error) {
    return newsRequestError(error);
  }
}

export async function getIbkrNewsHeadlines(
  args: GetIbkrNewsHeadlinesArgs = {},
): Promise<ToolResponse> {
  let conId: number;
  let providerCodes: string;
  let startDateTime: string | undefined;
  let endDateTime: string | undefined;
  let totalResults: number;

  try {
    conId = parsePositiveInteger(args.conId, 'conId');
    providerCodes = parseProviderCodes(args.providerCodes);
    startDateTime = toOptionalString(args.startDateTime);
    endDateTime = toOptionalString(args.endDateTime);
    totalResults = parseTotalResults(args.totalResults);
  } catch (error) {
    return errorResponse(error, INPUT_RESOLUTION);
  }

  const readyClient = await ensureReadyClient();
  if (!readyClient.ok) {
    return readyClient;
  }

  const { ib } = readyClient;

  // When no provider codes specified, check if any providers are available.
  // IB will hang indefinitely on reqHistoricalNews if no providers are subscribed.
  if (!providerCodes) {
    try {
      const providerResult = await getIbkrNewsProviders();
      if (providerResult.ok) {
        const providers = providerResult.providers as Array<{ code: string; name: string }>;
        if (!providers || providers.length === 0) {
          return errorResponse(
            'No news providers available on this account.',
            NEWS_SUBSCRIPTION_RESOLUTION,
          );
        }
        providerCodes = providers.map((p) => p.code).join('+');
      }
    } catch {
      // If provider check fails, proceed anyway and let the request fail with a proper error
    }
  }

  const reqId = connectionManager.nextRequestId();

  const responsePromise = collectUntilEnd<NewsHeadlineRow>(
    ib,
    reqId,
    EventName.historicalNews,
    EventName.historicalNewsEnd,
    (...eventArgs) => ({
      time: asStringOrNull(eventArgs[1]),
      providerCode: asStringOrNull(eventArgs[2]),
      articleId: asStringOrNull(eventArgs[3]),
      headline: asStringOrNull(eventArgs[4]),
    }),
    DEFAULT_REQUEST_TIMEOUT_MS,
  );
  void responsePromise.catch(() => {});

  try {
    await connectionManager.enqueueGeneral(() => {
      ib.reqHistoricalNews(
        reqId,
        conId,
        providerCodes,
        startDateTime ?? '',
        endDateTime ?? '',
        totalResults,
        [],
      );
      return undefined;
    });

    const headlines = await responsePromise;

    return {
      ok: true,
      conId,
      providerCodes: providerCodes.length > 0 ? providerCodes : null,
      startDateTime: startDateTime ?? null,
      endDateTime: endDateTime ?? null,
      totalResults,
      headlines,
      count: headlines.length,
    };
  } catch (error) {
    return newsRequestError(error);
  }
}

export async function getIbkrNewsArticle(args: GetIbkrNewsArticleArgs = {}): Promise<ToolResponse> {
  let providerCode: string;
  let articleId: string;

  try {
    providerCode = requireString(args.providerCode, 'providerCode').toUpperCase();
    articleId = requireString(args.articleId, 'articleId');
  } catch (error) {
    return errorResponse(error, INPUT_RESOLUTION);
  }

  const readyClient = await ensureReadyClient();
  if (!readyClient.ok) {
    return readyClient;
  }

  const { ib } = readyClient;
  const reqId = connectionManager.nextRequestId();

  const responsePromise = awaitSingle<{ articleType: number | null; articleText: string }>(
    ib,
    reqId,
    EventName.newsArticle,
    (...eventArgs) => ({
      articleType: asNumberOrNull(eventArgs[1]),
      articleText: asStringOrNull(eventArgs[2]) ?? '',
    }),
    DEFAULT_REQUEST_TIMEOUT_MS,
  );
  void responsePromise.catch(() => {});

  try {
    await connectionManager.enqueueGeneral(() => {
      ib.reqNewsArticle(reqId, providerCode, articleId, []);
      return undefined;
    });

    const article = await responsePromise;
    return {
      ok: true,
      providerCode,
      articleId,
      ...article,
    };
  } catch (error) {
    return newsRequestError(error);
  }
}
