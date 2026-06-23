const APP_MESSAGE_PREFIX = '\uE001APPMSG:\uE002';
const APP_MESSAGE_SEPARATOR = '\uE003';
const APP_MESSAGE_PATTERN = /^\uE001APPMSG:\uE002([A-Za-z0-9+/=]+)\uE003([\s\S]*)$/u;

export interface McpAppSendMessageAttribution {
  sourcePackageId?: string;
  sourcePackageFamily: string;
  toolUseId?: string;
  timestamp: string;
  content: string;
}

type EncodedAttributionPayload = {
  sourcePackageId?: string;
  sourcePackageFamily: string;
  toolUseId?: string;
  timestamp: string;
};

function normalizeAttributionString(value: string | undefined, fallback: string): string {
  const normalized = value
    ?.replace(/[\uE001-\uE003\r\n]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return normalized || fallback;
}

function encodeBase64Utf8(value: string): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(value, 'utf8').toString('base64');
  }
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function decodeBase64Utf8(value: string): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(value, 'base64').toString('utf8');
  }
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function warnSuspiciousAttributionMarker(text: string): void {
  if (!text.startsWith('\uE001APPMSG:')) {
    return;
  }
  // This should only be produced by the host trust path. If it appears but
  // fails closed, treat it as copy-pasted or malformed user content.
  console.warn('Suspicious MCP App attribution marker ignored');
}

export function formatMcpAppSendMessageText(params: McpAppSendMessageAttribution): string {
  const payload: EncodedAttributionPayload = {
    ...(params.sourcePackageId
      ? { sourcePackageId: normalizeAttributionString(params.sourcePackageId, 'unknown') }
      : {}),
    sourcePackageFamily: normalizeAttributionString(params.sourcePackageFamily, 'connected tool'),
    ...(params.toolUseId ? { toolUseId: normalizeAttributionString(params.toolUseId, 'unknown') } : {}),
    timestamp: normalizeAttributionString(params.timestamp, new Date(0).toISOString()),
  };
  return `${APP_MESSAGE_PREFIX}${encodeBase64Utf8(JSON.stringify(payload))}${APP_MESSAGE_SEPARATOR}${params.content}`;
}

export function parseMcpAppSendMessageText(text: string | undefined | null): McpAppSendMessageAttribution | null {
  if (!text?.startsWith('\uE001APPMSG:')) {
    return null;
  }

  const match = APP_MESSAGE_PATTERN.exec(text);
  if (!match) {
    warnSuspiciousAttributionMarker(text);
    return null;
  }

  const [, encodedPayload, content] = match;
  try {
    const decoded = JSON.parse(decodeBase64Utf8(encodedPayload)) as Partial<EncodedAttributionPayload>;
    if (
      typeof decoded.sourcePackageFamily !== 'string'
      || typeof decoded.timestamp !== 'string'
    ) {
      warnSuspiciousAttributionMarker(text);
      return null;
    }
    return {
      ...(typeof decoded.sourcePackageId === 'string' ? { sourcePackageId: decoded.sourcePackageId } : {}),
      sourcePackageFamily: decoded.sourcePackageFamily,
      ...(typeof decoded.toolUseId === 'string' ? { toolUseId: decoded.toolUseId } : {}),
      timestamp: decoded.timestamp,
      content,
    };
  } catch {
    warnSuspiciousAttributionMarker(text);
    return null;
  }
}
