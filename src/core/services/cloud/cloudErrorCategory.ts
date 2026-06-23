export type CloudErrorCategory =
  | { kind: 'network'; subkind: 'fetch_failed' | 'dns' | 'tcp' | 'abort' | 'timeout' }
  | { kind: 'auth'; subkind: 'unauthorized' | 'forbidden' | 'token_expired' }
  | { kind: 'cloud_down'; subkind: 'http_5xx' | 'reported_unhealthy' | 'deprovisioning' }
  | { kind: 'unknown'; rawMessage: string };

type ErrorRecord = Record<string, unknown>;

function isRecord(value: unknown): value is ErrorRecord {
  return typeof value === 'object' && value !== null;
}

function stringProp(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const prop = value[key];
  return typeof prop === 'string' ? prop : undefined;
}

function numberProp(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) return undefined;
  const prop = value[key];
  if (typeof prop === 'number' && Number.isInteger(prop)) return prop;
  if (typeof prop === 'string' && /^\d{3}$/.test(prop)) return Number(prop);
  return undefined;
}

function recordProp(value: unknown, key: string): ErrorRecord | undefined {
  if (!isRecord(value)) return undefined;
  const prop = value[key];
  return isRecord(prop) ? prop : undefined;
}

function getMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  const message = stringProp(err, 'message');
  if (message !== undefined) return message;
  if (isRecord(err) && err.message !== undefined) return String(err.message);
  return String(err);
}

function getName(err: unknown): string | undefined {
  if (err instanceof Error) return err.name;
  return stringProp(err, 'name');
}

function getCode(err: unknown): string | undefined {
  return stringProp(err, 'code') ?? stringProp(recordProp(err, 'cause'), 'code');
}

function getStatus(err: unknown, message: string): number | undefined {
  const direct = numberProp(err, 'status') ?? numberProp(err, 'statusCode');
  if (direct !== undefined) return direct;

  const response = recordProp(err, 'response');
  const responseStatus = numberProp(response, 'status') ?? numberProp(response, 'statusCode');
  if (responseStatus !== undefined) return responseStatus;

  const httpMatch = message.match(/\bHTTP\s+(\d{3})\b/i);
  return httpMatch ? Number(httpMatch[1]) : undefined;
}

export function categorize(err: unknown): CloudErrorCategory {
  const message = getMessage(err);
  const lowerMessage = message.toLowerCase();
  const name = getName(err);
  const code = getCode(err);
  const status = getStatus(err, message);

  // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check -- `switch (true)` dispatch idiom: case arms are arbitrary boolean predicates, not members of a finite union, so exhaustiveness does not apply. The `default` arm below is the catch-all and is required for return completeness.
  switch (true) {
    case name === 'AbortError':
      return { kind: 'network', subkind: 'abort' };
    case status === 401:
      return { kind: 'auth', subkind: 'unauthorized' };
    case status === 403:
      return { kind: 'auth', subkind: 'forbidden' };
    case status !== undefined && status >= 500 && status <= 599:
      return { kind: 'cloud_down', subkind: 'http_5xx' };
    case code === 'ENOTFOUND':
      return { kind: 'network', subkind: 'dns' };
    case code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EHOSTUNREACH':
      return { kind: 'network', subkind: 'tcp' };
    case code === 'ETIMEDOUT':
      return { kind: 'network', subkind: 'timeout' };
    case lowerMessage.includes('token') && (lowerMessage.includes('expired') || lowerMessage.includes('invalid')):
      return { kind: 'auth', subkind: 'token_expired' };
    case /\bfetch failed\b/i.test(message) || /\bfailed to fetch\b/i.test(message):
      return { kind: 'network', subkind: 'fetch_failed' };
    case lowerMessage.includes('getaddrinfo') || lowerMessage.includes('enotfound'):
      return { kind: 'network', subkind: 'dns' };
    case lowerMessage.includes('econnrefused') ||
      lowerMessage.includes('econnreset') ||
      lowerMessage.includes('ehostunreach') ||
      lowerMessage.includes('network unreachable') ||
      lowerMessage.includes('could not reach') ||
      lowerMessage.includes('check your internet'):
      return { kind: 'network', subkind: 'tcp' };
    case lowerMessage.includes('timed out') || lowerMessage.includes('timeout'):
      return { kind: 'network', subkind: 'timeout' };
    case lowerMessage.includes('unhealthy'):
      return { kind: 'cloud_down', subkind: 'reported_unhealthy' };
    case /(deprovision|remov(ed|ing)?)/i.test(lowerMessage):
      return { kind: 'cloud_down', subkind: 'deprovisioning' };
    default:
      return { kind: 'unknown', rawMessage: message };
  }
}
