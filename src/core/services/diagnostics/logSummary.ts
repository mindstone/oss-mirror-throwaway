import type { LogErrorPattern, LogFileSummary, LogSummary, TurnLogFile } from './manifest';
import { redactSensitiveData } from './redaction';

export interface ExportedLogFileLike {
  filename: string;
  content: string;
  lineCount: number;
}

const TOPIC_TAG_PATTERNS: Array<{ patterns: RegExp[]; tag: string }> = [
  { patterns: [/mcp/i, /super-mcp/i, /mcpservice/i], tag: 'mcp' },
  { patterns: [/session/i, /agent-session/i, /sessionstore/i], tag: 'session' },
  { patterns: [/voice/i, /audio/i, /tts/i, /stt/i, /microphone/i], tag: 'voice' },
  { patterns: [/startup/i, /ready/i, /init/i, /boot/i], tag: 'startup' },
  { patterns: [/ipc/i, /handler/i, /invoke/i], tag: 'ipc' },
  { patterns: [/auth/i, /oauth/i, /token/i, /login/i], tag: 'auth' },
  { patterns: [/workspace/i, /file/i, /fs/i, /directory/i], tag: 'workspace' },
  { patterns: [/health/i, /diagnostic/i, /check/i], tag: 'health' },
  { patterns: [/tool/i, /safety/i, /approval/i], tag: 'tool-safety' },
  { patterns: [/automation/i, /scheduler/i, /cron/i], tag: 'automation' },
  { patterns: [/renderer/i, /react/i, /ui/i, /component/i], tag: 'renderer' },
  { patterns: [/network/i, /http/i, /fetch/i, /api/i], tag: 'network' },
  { patterns: [/error/i, /fail/i, /exception/i, /crash/i], tag: 'errors' },
  { patterns: [/model/i, /claude/i, /anthropic/i, /llm/i], tag: 'model' },
  { patterns: [/sentry/i, /breadcrumb/i, /telemetry/i], tag: 'telemetry' },
];

export interface ParsedLogEntry {
  msg: string;
  level: number;
  time: string;
  raw: Record<string, unknown>;
}

export function parseLogLine(line: string): ParsedLogEntry | null {
  if (!line.trim()) return null;
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    return {
      msg: typeof parsed.msg === 'string' ? parsed.msg : '',
      level: typeof parsed.level === 'number' ? parsed.level : 30,
      time: typeof parsed.time === 'string' || typeof parsed.time === 'number'
        ? new Date(parsed.time).toISOString()
        : new Date().toISOString(),
      raw: parsed,
    };
  } catch {
    return null;
  }
}

export function generateTopicTags(entries: ParsedLogEntry[]): string[] {
  const matchedTags = new Set<string>();
  for (const entry of entries) {
    const searchText = [entry.msg, entry.raw.service, entry.raw.component, entry.raw.source, entry.raw.name]
      .filter(Boolean)
      .join(' ');
    for (const { patterns, tag } of TOPIC_TAG_PATTERNS) {
      if (patterns.some((pattern) => pattern.test(searchText))) matchedTags.add(tag);
    }
  }
  return Array.from(matchedTags).sort();
}

export function generateLogSummary(mainLogs: ExportedLogFileLike[], turnLogs: TurnLogFile[]): LogSummary {
  const allEntries: ParsedLogEntry[] = [];
  const files: LogFileSummary[] = [];
  let earliestTime: Date | null = null;
  let latestTime: Date | null = null;

  const observeEntry = (entry: ParsedLogEntry) => {
    allEntries.push(entry);
    const entryTime = new Date(entry.time);
    if (!earliestTime || entryTime < earliestTime) earliestTime = entryTime;
    if (!latestTime || entryTime > latestTime) latestTime = entryTime;
    return entryTime;
  };

  for (const logFile of mainLogs) {
    const lines = logFile.content.split('\n');
    let errorCount = 0;
    let warnCount = 0;
    let firstSeen: Date | null = null;
    let lastSeen: Date | null = null;
    for (const line of lines) {
      const entry = parseLogLine(line);
      if (!entry) continue;
      if (entry.level >= 50) errorCount++;
      else if (entry.level >= 40) warnCount++;
      const entryTime = observeEntry(entry);
      if (!firstSeen || entryTime < firstSeen) firstSeen = entryTime;
      if (!lastSeen || entryTime > lastSeen) lastSeen = entryTime;
    }
    files.push({
      name: logFile.filename,
      lineCount: logFile.lineCount,
      sizeBytes: new TextEncoder().encode(logFile.content).byteLength,
      errorCount,
      warnCount,
      firstSeen: firstSeen?.toISOString(),
      lastSeen: lastSeen?.toISOString(),
    });
  }

  for (const turnLog of turnLogs) {
    const lines = turnLog.content.split('\n');
    let errorCount = 0;
    let warnCount = 0;
    let firstSeen: Date | null = null;
    let lastSeen: Date | null = null;
    for (const line of lines) {
      const entry = parseLogLine(line);
      if (!entry) continue;
      if (entry.level >= 50) errorCount++;
      else if (entry.level >= 40) warnCount++;
      const entryTime = observeEntry(entry);
      if (!firstSeen || entryTime < firstSeen) firstSeen = entryTime;
      if (!lastSeen || entryTime > lastSeen) lastSeen = entryTime;
    }
    files.push({
      name: `sessions/${turnLog.filename}`,
      lineCount: lines.filter((l) => l.trim()).length,
      sizeBytes: turnLog.sizeBytes,
      errorCount,
      warnCount,
      firstSeen: firstSeen?.toISOString(),
      lastSeen: lastSeen?.toISOString(),
    });
  }

  const patternMap = new Map<string, { entry: ParsedLogEntry; count: number; firstSeen: Date; lastSeen: Date }>();
  for (const entry of allEntries) {
    if (entry.level < 40) continue;
    const key = entry.msg;
    const entryTime = new Date(entry.time);
    const existing = patternMap.get(key);
    if (existing) {
      existing.count++;
      if (entryTime < existing.firstSeen) existing.firstSeen = entryTime;
      if (entryTime > existing.lastSeen) existing.lastSeen = entryTime;
    } else {
      patternMap.set(key, { entry, count: 1, firstSeen: entryTime, lastSeen: entryTime });
    }
  }

  const errorPatterns: LogErrorPattern[] = Array.from(patternMap.entries())
    .map(([msg, data]) => ({
      msg,
      level: data.entry.level,
      count: data.count,
      firstSeen: data.firstSeen.toISOString(),
      lastSeen: data.lastSeen.toISOString(),
      sampleEntry: JSON.parse(redactSensitiveData(JSON.stringify(data.entry.raw))) as Record<string, unknown>,
    }))
    .sort((a, b) => b.count - a.count);

  return {
    timeWindow: {
      start: (earliestTime as Date | null)?.toISOString() || new Date().toISOString(),
      end: (latestTime as Date | null)?.toISOString() || new Date().toISOString(),
    },
    files,
    errorPatterns,
    topicTags: generateTopicTags(allEntries),
  };
}
