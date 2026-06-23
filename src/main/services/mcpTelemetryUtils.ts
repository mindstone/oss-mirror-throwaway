export function stripUserValues(data: unknown): unknown {
  if (typeof data !== 'object' || data === null) return data;
  const record = data as Record<string, unknown>;
  const result: Record<string, unknown> = { ...record };

  for (const key of ['type_errors', 'enum_violations', 'format_errors']) {
    if (Array.isArray(result[key])) {
      result[key] = (result[key] as unknown[]).map((entry) => {
        if (typeof entry !== 'object' || entry === null) return entry;
        const { got: _got, value: _value, ...rest } = entry as Record<string, unknown>;
        return rest;
      });
    }
  }

  for (const key of Object.keys(result)) {
    if (typeof result[key] === 'object' && result[key] !== null && !Array.isArray(result[key])) {
      result[key] = stripUserValues(result[key]);
    }
  }

  return result;
}

export function safeStringifyForTelemetry(value: unknown, maxLen: number): string {
  try {
    const str = JSON.stringify(value);
    if (str.length <= maxLen) return str;
    return str.slice(0, maxLen) + '...[truncated]';
  } catch {
    return String(value).slice(0, maxLen);
  }
}
