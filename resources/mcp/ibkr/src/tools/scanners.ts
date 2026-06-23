import {
  EventName,
  type IBApi,
  ScanCode,
  type ScannerSubscription,
} from '@stoqey/ib';
import { connectionManager } from '../connection.js';
import { awaitSingle, collectUntilEnd } from '../helpers.js';

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_SCANNER_ROWS = 20;
const MAX_SCANNER_ROWS = 50;
const DEFAULT_INSTRUMENT = 'STK';
const DEFAULT_LOCATION_CODE = 'STK.US.MAJOR';

const CONNECTION_RESOLUTION =
  'Ensure IB Gateway/TWS is running with API enabled, then reconnect using configure_ibkr_connection and retry.';
const INPUT_RESOLUTION = 'Fix the tool arguments and retry.';
const REQUEST_RESOLUTION =
  'Retry the request. If this persists, verify scanner filters and confirm IB Gateway/TWS is healthy.';
const SCANNER_LIMIT_RESOLUTION =
  'Close active scanner requests and retry. IBKR allows a limited number of concurrent scanner subscriptions.';

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

export interface GetIbkrScannerParametersArgs {}

export interface RunIbkrScannerArgs {
  scanType?: unknown;
  instrument?: unknown;
  locationCode?: unknown;
  numberOfRows?: unknown;
  priceAbove?: unknown;
  priceBelow?: unknown;
  volumeAbove?: unknown;
  marketCapAbove?: unknown;
  marketCapBelow?: unknown;
}

interface ScannerResultRow {
  rank: number;
  conId: number | null;
  symbol: string | null;
  secType: string | null;
  exchange: string | null;
  currency: string | null;
  distance: string | null;
  benchmark: string | null;
  projection: string | null;
  legsStr: string | null;
}

interface ScannerParameterSummary {
  scanTypes: string[];
  instruments: string[];
  locations: string[];
  filters: string[];
}

let scannerParametersCache: ScannerParameterSummary | null = null;

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

const asNumberOrZero = (value: unknown): number => {
  return asNumberOrNull(value) ?? 0;
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

const parseRows = (value: unknown): number => {
  if (value === undefined || value === null || value === '') {
    return DEFAULT_SCANNER_ROWS;
  }

  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error('numberOfRows must be a positive integer.');
  }

  return Math.min(parsed, MAX_SCANNER_ROWS);
};

const parseOptionalNonNegativeNumber = (
  value: unknown,
  fieldName: string,
): number | undefined => {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number.parseFloat(value)
        : Number.NaN;

  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${fieldName} must be a number greater than or equal to 0.`);
  }

  return parsed;
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

const decodeXmlEntities = (value: string): string => {
  const withNamedEntities = value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");

  return withNamedEntities
    .replace(/&#(\d+);/g, (_match, decimalCode: string) => {
      const parsed = Number.parseInt(decimalCode, 10);
      return Number.isNaN(parsed) ? _match : String.fromCodePoint(parsed);
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, hexCode: string) => {
      const parsed = Number.parseInt(hexCode, 16);
      return Number.isNaN(parsed) ? _match : String.fromCodePoint(parsed);
    });
};

const normalizeToken = (value: string): string | null => {
  const normalized = decodeXmlEntities(value).replace(/\s+/g, ' ').trim();
  return normalized.length > 0 ? normalized : null;
};

const extractBlocks = (xml: string, tagName: string): string[] => {
  const regex = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'gi');
  const matches: string[] = [];

  for (const match of xml.matchAll(regex)) {
    const block = match[1];
    if (typeof block === 'string') {
      matches.push(block);
    }
  }

  return matches;
};

const extractTagValues = (xml: string, tagName: string): string[] => {
  return extractBlocks(xml, tagName)
    .map((value) => value.replace(/<[^>]+>/g, ' '))
    .map((value) => normalizeToken(value))
    .filter((value): value is string => Boolean(value));
};

const addTokens = (target: Set<string>, values: string[]): void => {
  for (const value of values) {
    const splitValues = value.split(/[;,]/g);
    for (const splitValue of splitValues) {
      const normalized = normalizeToken(splitValue);
      if (normalized) {
        target.add(normalized);
      }
    }
  }
};

const sorted = (values: Set<string>): string[] => {
  return [...values].sort((a, b) => a.localeCompare(b));
};

const parseScannerParametersXml = (xml: string): ScannerParameterSummary => {
  const scanTypes = new Set<string>();
  const instruments = new Set<string>();
  const locations = new Set<string>();
  const filters = new Set<string>();

  for (const block of extractBlocks(xml, 'ScanType')) {
    addTokens(scanTypes, [
      ...extractTagValues(block, 'scanCode'),
      ...extractTagValues(block, 'code'),
      ...extractTagValues(block, 'name'),
    ]);
  }

  if (scanTypes.size === 0) {
    addTokens(scanTypes, extractTagValues(xml, 'scanCode'));
  }

  for (const block of extractBlocks(xml, 'Instrument')) {
    addTokens(instruments, [
      ...extractTagValues(block, 'code'),
      ...extractTagValues(block, 'name'),
      ...extractTagValues(block, 'type'),
    ]);
  }

  if (instruments.size === 0) {
    addTokens(instruments, extractTagValues(xml, 'instrument'));
  }

  for (const block of extractBlocks(xml, 'LocationCode')) {
    addTokens(locations, [
      ...extractTagValues(block, 'locationCode'),
      ...extractTagValues(block, 'code'),
      ...extractTagValues(block, 'name'),
      ...extractTagValues(block, 'displayName'),
    ]);
  }

  for (const block of extractBlocks(xml, 'Location')) {
    addTokens(locations, [
      ...extractTagValues(block, 'locationCode'),
      ...extractTagValues(block, 'code'),
    ]);
  }

  if (locations.size === 0) {
    addTokens(locations, extractTagValues(xml, 'locationCode'));
  }

  for (const block of extractBlocks(xml, 'AbstractField')) {
    addTokens(filters, [
      ...extractTagValues(block, 'code'),
      ...extractTagValues(block, 'name'),
      ...extractTagValues(block, 'displayName'),
      ...extractTagValues(block, 'type'),
    ]);
  }

  if (filters.size === 0) {
    addTokens(filters, [
      ...extractTagValues(xml, 'Filter'),
      ...extractTagValues(xml, 'filter'),
    ]);
  }

  const parsed: ScannerParameterSummary = {
    scanTypes: sorted(scanTypes),
    instruments: sorted(instruments),
    locations: sorted(locations),
    filters: sorted(filters),
  };

  if (
    parsed.scanTypes.length === 0
    && parsed.instruments.length === 0
    && parsed.locations.length === 0
  ) {
    throw new Error('Failed to parse scanner parameters XML into a usable summary.');
  }

  return parsed;
};

const isScannerLimitError = (error: unknown): boolean => {
  const message = toErrorMessage(error).toLowerCase();
  return message.includes('scanner subscription limit reached');
};

export async function getIbkrScannerParameters(
  _args: GetIbkrScannerParametersArgs = {},
): Promise<ToolResponse> {
  if (scannerParametersCache) {
    return {
      ok: true,
      cached: true,
      ...scannerParametersCache,
    };
  }

  const readyClient = await ensureReadyClient();
  if (!readyClient.ok) {
    return readyClient;
  }

  const { ib } = readyClient;

  const responsePromise = awaitSingle<string>(
    ib,
    -1,
    EventName.scannerParameters,
    (...eventArgs) => {
      if (typeof eventArgs[0] !== 'string') {
        throw new Error('Unexpected scannerParameters payload from IBKR.');
      }
      return eventArgs[0];
    },
    DEFAULT_REQUEST_TIMEOUT_MS,
  );
  void responsePromise.catch(() => {});

  try {
    await connectionManager.enqueueGeneral(() => {
      ib.reqScannerParameters();
      return undefined;
    });

    const scannerXml = await responsePromise;
    const parsedSummary = parseScannerParametersXml(scannerXml);
    scannerParametersCache = parsedSummary;

    return {
      ok: true,
      cached: false,
      ...parsedSummary,
    };
  } catch (error) {
    return errorResponse(error, REQUEST_RESOLUTION);
  }
}

export async function runIbkrScanner(args: RunIbkrScannerArgs = {}): Promise<ToolResponse> {
  let scanType: string;
  let instrument: string;
  let locationCode: string;
  let numberOfRows: number;
  let priceAbove: number | undefined;
  let priceBelow: number | undefined;
  let volumeAbove: number | undefined;
  let marketCapAbove: number | undefined;
  let marketCapBelow: number | undefined;

  try {
    scanType = requireString(args.scanType, 'scanType').toUpperCase();
    instrument = toOptionalString(args.instrument)?.toUpperCase() ?? DEFAULT_INSTRUMENT;
    locationCode = toOptionalString(args.locationCode)?.toUpperCase() ?? DEFAULT_LOCATION_CODE;
    numberOfRows = parseRows(args.numberOfRows);
    priceAbove = parseOptionalNonNegativeNumber(args.priceAbove, 'priceAbove');
    priceBelow = parseOptionalNonNegativeNumber(args.priceBelow, 'priceBelow');
    volumeAbove = parseOptionalNonNegativeNumber(args.volumeAbove, 'volumeAbove');
    marketCapAbove = parseOptionalNonNegativeNumber(args.marketCapAbove, 'marketCapAbove');
    marketCapBelow = parseOptionalNonNegativeNumber(args.marketCapBelow, 'marketCapBelow');
  } catch (error) {
    return errorResponse(error, INPUT_RESOLUTION);
  }

  const readyClient = await ensureReadyClient();
  if (!readyClient.ok) {
    return readyClient;
  }

  const { ib } = readyClient;
  const reqId = connectionManager.nextRequestId();

  const scanCodeValue = ScanCode[scanType as keyof typeof ScanCode];
  if (scanCodeValue === undefined) {
    return errorResponse(
      new Error(`Unknown scanType '${scanType}'. Use get_ibkr_scanner_parameters to list valid scan types.`),
      INPUT_RESOLUTION,
    );
  }

  const subscription: ScannerSubscription = {
    scanCode: scanCodeValue,
    instrument: instrument as unknown as ScannerSubscription['instrument'],
    locationCode: locationCode as unknown as ScannerSubscription['locationCode'],
    numberOfRows,
    abovePrice: priceAbove,
    belowPrice: priceBelow,
    aboveVolume: volumeAbove,
    marketCapAbove,
    marketCapBelow,
  };

  let reservedScannerSlot = false;

  try {
    connectionManager.reserveScannerSubscription(reqId);
    reservedScannerSlot = true;

    const responsePromise = collectUntilEnd<ScannerResultRow>(
      ib,
      reqId,
      EventName.scannerData,
      EventName.scannerDataEnd,
      (...eventArgs) => {
        const contractDetails = asRecord(eventArgs[2]);
        const contract = asRecord(contractDetails.contract);

        return {
          rank: asNumberOrZero(eventArgs[1]),
          conId: asNumberOrNull(contract.conId),
          symbol: asStringOrNull(contract.symbol),
          secType: asStringOrNull(contract.secType),
          exchange: asStringOrNull(contract.exchange),
          currency: asStringOrNull(contract.currency),
          distance: asStringOrNull(eventArgs[3]),
          benchmark: asStringOrNull(eventArgs[4]),
          projection: asStringOrNull(eventArgs[5]),
          legsStr: asStringOrNull(eventArgs[6]),
        };
      },
      DEFAULT_REQUEST_TIMEOUT_MS,
    );
    void responsePromise.catch(() => {});

    await connectionManager.enqueueGeneral(() => {
      ib.reqScannerSubscription(reqId, subscription, [], []);
      return undefined;
    });

    const scannerResults = await responsePromise;

    return {
      ok: true,
      scanType,
      instrument,
      locationCode,
      numberOfRows,
      scannerResults,
      count: scannerResults.length,
    };
  } catch (error) {
    if (isScannerLimitError(error)) {
      return errorResponse(error, SCANNER_LIMIT_RESOLUTION);
    }

    return errorResponse(error, REQUEST_RESOLUTION);
  } finally {
    if (reservedScannerSlot) {
      void connectionManager
        .enqueueGeneral(() => {
          ib.cancelScannerSubscription(reqId);
          return undefined;
        })
        .catch(() => {
          // Best-effort cancellation.
        });

      connectionManager.releaseScannerSubscription(reqId);
    }
  }
}
