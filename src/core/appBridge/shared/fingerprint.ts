/**
 * Format a 32-char extension ID as 8-8-8-8 groups for human verification.
 * Used in user-facing UI + MCP tool return values. Do NOT log this value
 * in breadcrumbs — emit only the last 8 chars for PII redaction.
 */
export function formatExtensionIdFingerprint(raw: string): string {
  if (typeof raw !== 'string' || raw.length === 0) return '';
  const clean = raw.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (clean.length !== 32) return raw;
  return `${clean.slice(0, 8)}-${clean.slice(8, 16)}-${clean.slice(16, 24)}-${clean.slice(24, 32)}`;
}

export function redactExtensionIdForLog(raw: string): string {
  if (typeof raw !== 'string' || raw.length < 8) return '***';
  return `…${raw.slice(-8)}`;
}
