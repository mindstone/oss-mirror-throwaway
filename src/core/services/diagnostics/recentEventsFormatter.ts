import type { RecentDiagnosticContext } from './recentDiagnosticContext';
import type { DiagnosticEventEntry, DiagnosticEventKind } from './manifest';

export function formatRecentDiagnosticEvents(
  ctx: RecentDiagnosticContext,
): { markdown: string; entryCount: number } {
  const lines: string[] = [`## Recent diagnostic events — last ${ctx.windowHours}h`, ''];
  const countKinds = sortedKinds(ctx.counts);

  if (ctx.totalEvents === 0 && countKinds.length === 0) {
    lines.push(`All quiet. Nothing notable in the last ${ctx.windowHours}h.`);
    return { markdown: lines.join('\n'), entryCount: ctx.totalEvents };
  }

  lines.push('### Per-kind counts');
  lines.push('| Kind | Count | Last seen |');
  lines.push('| ---- | ----- | --------- |');
  for (const kind of countKinds) {
    lines.push(
      `| ${kind} | ${ctx.counts?.[kind] ?? 0} | ${formatTimestamp(ctx.lastTimes?.[kind])} |`,
    );
  }

  lines.push('');
  lines.push(`### Last ${ctx.limit} entries per kind`);

  if (ctx.totalEvents === 0) {
    lines.push('Per-kind counts above span the ring buffer; no entries fell within the requested window.');
    return { markdown: lines.join('\n'), entryCount: ctx.totalEvents };
  }

  const entryKinds = sortedKinds(ctx.entriesByKind);
  for (const kind of entryKinds) {
    const entries = ctx.entriesByKind[kind] ?? [];
    lines.push('');
    lines.push(`#### ${kind} (${ctx.counts?.[kind] ?? entries.length} in window)`);
    for (const event of entries) {
      lines.push(formatEntry(event));
    }
  }

  return { markdown: lines.join('\n'), entryCount: ctx.totalEvents };
}

function sortedKinds(record: Partial<Record<DiagnosticEventKind, unknown>> | null): DiagnosticEventKind[] {
  return Object.keys(record ?? {}).sort() as DiagnosticEventKind[];
}

function formatTimestamp(ts: number | undefined): string {
  return typeof ts === 'number' ? new Date(ts).toISOString() : '—';
}

function formatEntry(event: DiagnosticEventEntry): string {
  return [
    `- ${formatTimestamp(event.ts)}`,
    `surface=${deriveSurface(event)}`,
    `tid=${event.tid ?? '—'}`,
    `sid=${event.sid ?? '—'}`,
    `data=${stringifyData(event.data ?? {})}`,
  ].join(' · ');
}

function deriveSurface(event: DiagnosticEventEntry): string {
  const contextSurface = (event as { context?: { surface?: unknown } }).context?.surface;
  if (typeof contextSurface === 'string' && contextSurface.length > 0) {
    return contextSurface;
  }
  return event.surface ?? 'unknown';
}

function stringifyData(data: unknown): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(data ?? {}) ?? '{}';
  } catch {
    serialized = JSON.stringify({ serialization: 'failed' });
  }

  return serialized.includes('```') ? serialized.replace(/`/g, '`\u200d') : serialized;
}
