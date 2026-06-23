import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';

export function parseLogTimestamp(line: string): Date | null {
  try {
    const parsed = JSON.parse(line) as { time?: unknown };
    if (parsed.time) return new Date(parsed.time as string | number);
  } catch (error) {
    ignoreBestEffortCleanup(error, {
      operation: 'parseLogTimestamp.JSONParse',
      reason: 'Best-effort log-line timestamp parse; returning null on malformed input is the documented contract',
    });
  }
  return null;
}

const BREADCRUMBS_HEAD = 3;
const BREADCRUMBS_TAIL = 2;
const BREADCRUMBS_THRESHOLD = BREADCRUMBS_HEAD + BREADCRUMBS_TAIL + 1;

export function formatTimeShort(date: Date): string {
  return date.toTimeString().slice(0, 5);
}

export function truncateBreadcrumbs(breadcrumbs: unknown[]): unknown[] {
  if (breadcrumbs.length <= BREADCRUMBS_THRESHOLD) return breadcrumbs;
  const head = breadcrumbs.slice(0, BREADCRUMBS_HEAD);
  const tail = breadcrumbs.slice(-BREADCRUMBS_TAIL);
  const omitted = breadcrumbs.length - BREADCRUMBS_HEAD - BREADCRUMBS_TAIL;
  return [...head, `...(${omitted} more)...`, ...tail];
}

export function processLogEntry(line: string): string {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    if (Array.isArray(parsed.breadcrumbs) && parsed.breadcrumbs.length > BREADCRUMBS_THRESHOLD) {
      parsed.breadcrumbs = truncateBreadcrumbs(parsed.breadcrumbs);
      return JSON.stringify(parsed);
    }
    return line;
  } catch {
    return line;
  }
}

interface DedupeGroup {
  msg: string;
  firstLine: string;
  firstTime: Date;
  lastTime: Date;
  count: number;
}

export function deduplicateLogs(lines: string[]): string[] {
  if (lines.length === 0) return lines;
  const result: string[] = [];
  let currentGroup: DedupeGroup | null = null;
  const emitGroup = () => {
    if (!currentGroup) return;
    if (currentGroup.count === 1) {
      result.push(processLogEntry(currentGroup.firstLine));
    } else {
      try {
        const parsed = JSON.parse(currentGroup.firstLine) as Record<string, unknown>;
        const timeRange = `${formatTimeShort(currentGroup.firstTime)}-${formatTimeShort(currentGroup.lastTime)}`;
        parsed.msg = `${currentGroup.msg} (x${currentGroup.count}, ${timeRange})`;
        if (Array.isArray(parsed.breadcrumbs) && parsed.breadcrumbs.length > BREADCRUMBS_THRESHOLD) {
          parsed.breadcrumbs = truncateBreadcrumbs(parsed.breadcrumbs);
        }
        result.push(JSON.stringify(parsed));
      } catch {
        result.push(processLogEntry(currentGroup.firstLine));
      }
    }
    currentGroup = null;
  };

  for (const line of lines) {
    if (!line.trim()) continue;
    let msg: string | null = null;
    let time: Date | null = null;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      msg = typeof parsed.msg === 'string' ? parsed.msg : null;
      time = parsed.time ? new Date(parsed.time as string | number) : null;
    } catch {
      emitGroup();
      result.push(line);
      continue;
    }
    if (!msg) {
      emitGroup();
      result.push(processLogEntry(line));
      continue;
    }
    if (currentGroup && currentGroup.msg === msg) {
      currentGroup.count++;
      if (time) currentGroup.lastTime = time;
    } else {
      emitGroup();
      currentGroup = {
        msg,
        firstLine: line,
        firstTime: time || new Date(),
        lastTime: time || new Date(),
        count: 1,
      };
    }
  }
  emitGroup();
  return result;
}

export function getLogLevel(line: string): number | null {
  try {
    const parsed = JSON.parse(line) as { level?: unknown };
    return typeof parsed.level === 'number' ? parsed.level : null;
  } catch {
    return null;
  }
}
