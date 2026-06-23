import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
type OutboxStatus = 'pending' | 'failed' | 'permanent_failure' | string;

export interface RolloutEntry {
  sessionId: string;
  status: OutboxStatus;
  attempts: number;
  cursor: number | null;
  lastDrainAttempt: number | null;
  lastResponseCode: number | null;
  cloudServerSeq: number | null;
}

export interface RolloutReport {
  ok: boolean;
  summary: {
    total: number;
    stuckCandidates: number;
    manualReenqueueCandidates: number;
  };
  sessions: RolloutEntry[];
  stuckCandidates: string[];
  manualReenqueueCandidates: string[];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function parseResponseCode(entry: Record<string, unknown>): number | null {
  const direct = asNumber(entry.lastResponseCode ?? entry.responseCode ?? entry.statusCode);
  if (direct !== null) return direct;
  const lastError = typeof entry.lastError === 'string' ? entry.lastError : '';
  const match = lastError.match(/\b(4\d\d|5\d\d)\b/);
  if (match) return Number(match[1]);
  if (/BODY_TOO_LARGE|payload too large/i.test(lastError)) return 413;
  return null;
}

function isManualReenqueueCandidate(entry: RolloutEntry, rawEntry: Record<string, unknown>): boolean {
  return entry.status === 'permanent_failure'
    && (entry.lastResponseCode === 413 || /413|BODY_TOO_LARGE|payload too large/i.test(String(rawEntry.lastError ?? '')));
}

export function parseOutbox(raw: unknown): Array<{ entry: RolloutEntry; rawEntry: Record<string, unknown> }> {
  const data = asRecord(raw);
  const seqTracker = asRecord(data._lastPushedSeqTracker);
  return Object.entries(data)
    .filter(([key, value]) => !key.startsWith('_') && asRecord(value).sessionId)
    .map(([, value]) => {
      const rawEntry = asRecord(value);
      const sessionId = String(rawEntry.sessionId);
      return {
        rawEntry,
        entry: {
          sessionId,
          status: typeof rawEntry.status === 'string' ? rawEntry.status : 'pending',
          attempts: asNumber(rawEntry.attempts) ?? 0,
          cursor: asNumber(seqTracker[sessionId]),
          lastDrainAttempt: asNumber(rawEntry.lastDrainAttemptAt ?? rawEntry.lastAttemptAt ?? rawEntry.enqueuedAt),
          lastResponseCode: parseResponseCode(rawEntry),
          cloudServerSeq: null,
        },
      };
    })
    .sort((a, b) => a.entry.sessionId.localeCompare(b.entry.sessionId));
}

export function buildRolloutReport(
  parsed: Array<{ entry: RolloutEntry; rawEntry: Record<string, unknown> }>,
): RolloutReport {
  const sessions = parsed.map(({ entry }) => entry);
  const stuckCandidates = sessions
    .filter((entry) => (entry.status === 'pending' || entry.status === 'failed') && entry.attempts > 3)
    .map((entry) => entry.sessionId);
  const manualReenqueueCandidates = parsed
    .filter(({ entry, rawEntry }) => isManualReenqueueCandidate(entry, rawEntry))
    .map(({ entry }) => entry.sessionId);

  return {
    ok: stuckCandidates.length === 0 && manualReenqueueCandidates.length === 0,
    summary: {
      total: sessions.length,
      stuckCandidates: stuckCandidates.length,
      manualReenqueueCandidates: manualReenqueueCandidates.length,
    },
    sessions,
    stuckCandidates,
    manualReenqueueCandidates,
  };
}

async function queryCloudServerSeq(
  fetchFn: FetchLike,
  cloudUrl: string,
  token: string | undefined,
  sessionId: string,
  cursor: number,
): Promise<number | null> {
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  const response = await fetchFn(
    new URL(`/api/sessions/${encodeURIComponent(sessionId)}/events?sinceSeq=${cursor}&limit=1`, cloudUrl),
    { headers },
  );
  if (!response.ok) return null;
  const body = asRecord(await response.json().catch(() => undefined));
  return asNumber(body.serverSeq);
}

export async function attachCloudState(
  parsed: Array<{ entry: RolloutEntry; rawEntry: Record<string, unknown> }>,
  config: { cloudUrl?: string; token?: string; fetchFn?: FetchLike },
): Promise<void> {
  if (!config.cloudUrl) return;
  for (const item of parsed) {
    item.entry.cloudServerSeq = await queryCloudServerSeq(
      config.fetchFn ?? fetch,
      config.cloudUrl,
      config.token,
      item.entry.sessionId,
      item.entry.cursor ?? 0,
    );
  }
}

export function renderRolloutTable(report: RolloutReport): string {
  const header = 'sessionId | status | attempts | cursor | lastDrainAttempt | lastResponseCode | cloudServerSeq | action';
  const rows = report.sessions.map((entry) => {
    const action = report.manualReenqueueCandidates.includes(entry.sessionId)
      ? 'manual-reenqueue'
      : report.stuckCandidates.includes(entry.sessionId)
        ? 'watch-auto-recovery'
        : 'ok';
    return [
      entry.sessionId,
      entry.status,
      entry.attempts,
      entry.cursor ?? '-',
      entry.lastDrainAttempt ?? '-',
      entry.lastResponseCode ?? '-',
      entry.cloudServerSeq ?? '-',
      action,
    ].join(' | ');
  });
  return [
    'Delta sync rollout verification',
    header,
    ...rows,
    `summary: total=${report.summary.total} stuck=${report.summary.stuckCandidates} manualReenqueue=${report.summary.manualReenqueueCandidates}`,
  ].join('\n');
}

function defaultOutboxPath(): string {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA ?? os.homedir(), 'mindstone-rebel', 'sessions', 'cloud-outbox.json');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'mindstone-rebel', 'sessions', 'cloud-outbox.json');
  }
  return path.join(os.homedir(), '.config', 'mindstone-rebel', 'sessions', 'cloud-outbox.json');
}

function argValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

export async function runCli(argv = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Promise<number> {
  try {
    const outboxPath = argValue(argv, '--outbox') ?? env.DELTA_SYNC_OUTBOX_PATH ?? defaultOutboxPath();
    const parsed = parseOutbox(JSON.parse(fs.readFileSync(outboxPath, 'utf8')) as unknown);
    await attachCloudState(parsed, {
      cloudUrl: argValue(argv, '--cloud-url') ?? env.CLOUD_URL ?? env.REBEL_API_URL,
      token: argValue(argv, '--token') ?? env.CLOUD_TOKEN ?? env.REBEL_CLOUD_TOKEN,
    });
    const report = buildRolloutReport(parsed);
    const json = JSON.stringify(report, null, 2);
    console.log(argv.includes('--json') ? json : `${renderRolloutTable(report)}\n\nJSON:\n${json}`);
    return report.ok ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void runCli().then((code) => { process.exitCode = code; });
}
