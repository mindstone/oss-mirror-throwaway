export type IbErrorSeverity = 'info' | 'warning' | 'error' | 'fatal';

interface IbErrorDefinition {
  summary: string;
  userHint?: string;
  severity?: IbErrorSeverity;
}

const IB_ERROR_DEFINITIONS: Record<number, IbErrorDefinition> = {
  103: {
    summary: 'Duplicate order ID',
    userHint: 'Request a fresh order ID and retry.',
  },
  110: {
    summary: 'Price does not conform to venue rules',
    userHint: 'Adjust the price increment and retry.',
  },
  200: {
    summary: 'No security definition found',
    userHint: 'Verify symbol, exchange, secType, and currency.',
  },
  201: {
    summary: 'Order rejected',
    userHint: 'Review order fields and account permissions.',
  },
  202: {
    summary: 'Order cancelled',
    userHint: 'Check if the order was cancelled manually or by risk checks.',
  },
  321: {
    summary: 'Server validation error',
    userHint: 'Check required fields and request format.',
  },
  10092: {
    summary: 'Deep market data not supported for this security/exchange',
    userHint: 'Try specifying exchange explicitly (e.g. ARCA, NYSE, ISLAND). SMART routing does not support Level II depth for most stocks.',
  },
  504: {
    summary: 'Gateway/TWS is not connected',
    userHint: 'Confirm IB Gateway or TWS is running and API is enabled.',
  },
  1100: {
    summary: 'Connectivity between IB and Gateway/TWS lost',
    userHint: 'Connection manager will auto-reconnect.',
    severity: 'fatal',
  },
  1300: {
    summary: 'Socket port has been reset',
    userHint: 'Verify host/port and reconnect.',
    severity: 'fatal',
  },
};

export const IB_INFO_CODES = new Set<number>([2104, 2106, 2119, 2158, 10167]);
export const IB_WARNING_CODES = new Set<number>([2103, 2105, 2157]);
export const IB_FATAL_CODES = new Set<number>([504, 1100, 1300]);

export interface ClassifiedIbError {
  reqId: number;
  code: number;
  message: string;
  severity: IbErrorSeverity;
  summary?: string;
  userHint?: string;
}

export const classifyIbErrorCode = (code: number): IbErrorSeverity => {
  if (IB_INFO_CODES.has(code)) {
    return 'info';
  }
  if (IB_WARNING_CODES.has(code)) {
    return 'warning';
  }
  if (IB_FATAL_CODES.has(code)) {
    return 'fatal';
  }
  return 'error';
};

export const classifyIbError = (
  code: number,
  message: string,
  reqId: number = -1,
): ClassifiedIbError => {
  const definition = IB_ERROR_DEFINITIONS[code];
  const severity = definition?.severity ?? classifyIbErrorCode(code);

  return {
    reqId,
    code,
    message,
    severity,
    summary: definition?.summary,
    userHint: definition?.userHint,
  };
};

export const formatIbErrorForUser = (error: ClassifiedIbError): string => {
  const reqIdSuffix = error.reqId >= 0 ? ` (reqId ${error.reqId})` : '';
  const summary = error.summary ? `${error.summary}: ` : '';
  const hint = error.userHint ? ` ${error.userHint}` : '';
  return `[${error.severity.toUpperCase()} ${error.code}] ${summary}${error.message}${reqIdSuffix}.${hint}`.trim();
};

export class IbRequestError extends Error {
  public readonly reqId: number;
  public readonly code: number;
  public readonly severity: IbErrorSeverity;

  constructor(public readonly details: ClassifiedIbError) {
    super(formatIbErrorForUser(details));
    this.name = 'IbRequestError';
    this.reqId = details.reqId;
    this.code = details.code;
    this.severity = details.severity;
  }
}

/**
 * Parse IB's overloaded error event payloads into a normalized shape.
 */
export const parseIbErrorEvent = (...args: unknown[]): ClassifiedIbError | null => {
  // TWS error payload: (id, errorCode, errorMsg, advancedOrderReject?)
  if (
    typeof args[0] === 'number'
    && typeof args[1] === 'number'
    && typeof args[2] === 'string'
  ) {
    return classifyIbError(args[1], args[2], args[0]);
  }

  // Alternate overload: (error: Error, code, reqId)
  if (
    args[0] instanceof Error
    && typeof args[1] === 'number'
    && typeof args[2] === 'number'
  ) {
    return classifyIbError(args[1], args[0].message || 'IBKR error', args[2]);
  }

  // Generic runtime/API errors
  if (args[0] instanceof Error) {
    return classifyIbError(-1, args[0].message || 'IBKR runtime error', -1);
  }

  return null;
};
