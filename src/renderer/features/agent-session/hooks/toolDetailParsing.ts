import { safeParseDetail } from '../utils/safeParseDetail';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const parseToolDetailJson = (detail: string): unknown | null => {
  if (typeof detail !== 'string' || detail.trim().length === 0) {
    return null;
  }
  const parsed = safeParseDetail(detail);
  return parsed.ok ? parsed.value : null;
};

export const extractPairSessionIdFromToolDetail = (detail: string): string | null => {
  if (typeof detail !== 'string' || detail.trim().length === 0) {
    return null;
  }

  const visit = (value: unknown): string | null => {
    if (!value || typeof value !== 'object') {
      return null;
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        const nested = visit(entry);
        if (nested) return nested;
      }
      return null;
    }
    const record = value as Record<string, unknown>;
    if (typeof record.installSessionAlias === 'string' && record.installSessionAlias.length > 0) {
      return record.installSessionAlias;
    }
    if (typeof record.pairSessionId === 'string' && record.pairSessionId.length > 0) {
      return record.pairSessionId;
    }
    for (const nested of Object.values(record)) {
      const found = visit(nested);
      if (found) return found;
    }
    return null;
  };

  const parsed = safeParseDetail(detail);
  if (parsed.ok) {
    const fromJson = visit(parsed.value);
    if (fromJson) {
      return fromJson;
    }
  }
  // too-large / malformed → fall through to regex

  const match =
    detail.match(/"installSessionAlias"\s*:\s*"([^"]+)"/) ??
    detail.match(/"pairSessionId"\s*:\s*"([^"]+)"/);
  return match?.[1] ?? null;
};

export const toolDetailHasPairedEvent = (detail: string): boolean => {
  const parsed = parseToolDetailJson(detail);
  if (!parsed) {
    return false;
  }

  const visit = (value: unknown): boolean => {
    if (Array.isArray(value)) {
      return value.some(visit);
    }
    if (!isRecord(value)) {
      return false;
    }
    if (value.event === 'paired' || value.type === 'paired') {
      return true;
    }
    return Object.values(value).some(visit);
  };

  return visit(parsed);
};

export const toolDetailHasPairedClients = (detail: string): boolean => {
  const parsed = parseToolDetailJson(detail);
  if (!parsed) {
    return false;
  }

  const visit = (value: unknown): boolean => {
    if (Array.isArray(value)) {
      return value.some(visit);
    }
    if (!isRecord(value)) {
      return false;
    }
    if (Array.isArray(value.paired) && value.paired.length > 0) {
      return true;
    }
    return Object.values(value).some(visit);
  };

  return visit(parsed);
};
